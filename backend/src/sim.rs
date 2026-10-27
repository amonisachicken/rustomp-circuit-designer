// SPDX-License-Identifier: GPL-3.0-or-later
//! 仿真：把当前图纸交给 ngspice，取回波形（**复用 breadspice 的仿真核心**）。
//!
//! 与 breadspice 的关系（详见 `docs/07-sim-comparison.md`）：
//!
//! | 表面 | breadspice | 这里 |
//! |---|---|---|
//! | 分析类型 | op / dc / ac / tran | **ac / tran**（op、dc 的驱动代码保留，UI 不开放） |
//! | 结果通道 | `ngspice -r result.raw` + **ASCII rawfile** | 同（直接搬过来） |
//! | 成功判据 | rawfile 可解析 | 同 |
//! | 取消 | pid + kill，返回部分结果 | 同 |
//! | 模型库 | `include_str!("assets/models.lib")` | 同 |
//! | 激励 | 面包板元件自带的源 | **IN 元件兼作波形发生器**（自动注入 `VSIM`） |
//! | 探针 | 点元件取任意网络 | 端口 + **测试点**（电压表）全部自动探针 |
//!
//! 去掉的（用户明确不要）：op 工作点、音频导入、预设音符、播放音频、电流表。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::netlist::{self, Document, SymbolTable};

/// 器件模型库（编进二进制：仿真不再依赖"从哪个目录启动"）
const MODELS_LIB: &str = include_str!("../../assets/models.lib");

/// 正在跑的 ngspice 进程（供 `designer.stop` 取消）
static RUNNING_PID: AtomicI32 = AtomicI32::new(0);
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------- 请求 / 结果

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AnalysisKind {
    Op,
    Dc,
    Ac,
    Tran,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SimParams {
    // ---- tran（IN 兼作波形发生器：正弦幅值/频率 + 步长/起始/持续）----
    #[serde(default)]
    pub amp: Option<f64>,
    #[serde(default)]
    pub freq: Option<f64>,
    #[serde(default)]
    pub step: Option<f64>,
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub duration: Option<f64>,
    // ---- ac ----
    #[serde(default)]
    pub sweep: Option<String>,
    #[serde(default)]
    pub points: Option<u32>,
    #[serde(default)]
    pub f_start: Option<f64>,
    #[serde(default)]
    pub f_stop: Option<f64>,
    // ---- dc（UI 暂不开放）----
    #[serde(default)]
    pub dc_source: Option<String>,
    #[serde(default)]
    pub dc_start: Option<f64>,
    #[serde(default)]
    pub dc_stop: Option<f64>,
    #[serde(default)]
    pub dc_step: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SimRequest {
    pub doc: Document,
    pub analysis: AnalysisKind,
    #[serde(default)]
    pub params: SimParams,
    /// 额外探针（网表里的网络名，如 `TP1`）；端口与测试点由后端自动加
    #[serde(default)]
    pub probes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Trace {
    /// `v(OUT)` / `v(TP1)` 这样的小写名字，前端直接显示
    pub name: String,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SimResult {
    pub analysis: AnalysisKind,
    /// 瞬态：秒；AC：Hz；DC：扫描值
    pub traces: Vec<Trace>,
    /// 工作点（op 分析；当前 UI 不开放，保留通道）
    pub op: Option<HashMap<String, f64>>,
    /// 被取消时仍可能有部分结果
    pub cancelled: bool,
    /// 瞬态输出的 THD（前 9 次谐波，相对基波）；非 tran 或算不出来为 None
    pub thd: Option<f64>,
    /// 本次拼给 ngspice 的完整网表（调试用；与交付的 .cir 不同）
    pub cir: String,
    pub log: String,
}

// ---------------------------------------------------------------- 分析行

pub fn analysis_line(analysis: AnalysisKind, p: &SimParams) -> Result<String, String> {
    match analysis {
        AnalysisKind::Op => Ok(".op".into()),
        AnalysisKind::Dc => {
            let src = p.dc_source.clone().unwrap_or_else(|| "VSIM".into());
            Ok(format!(
                ".dc {} {} {} {}",
                src,
                p.dc_start.unwrap_or(0.0),
                p.dc_stop.unwrap_or(9.0),
                p.dc_step.unwrap_or(0.1)
            ))
        }
        AnalysisKind::Ac => {
            let sweep = match p.sweep.as_deref().unwrap_or("dec") {
                "oct" => "oct",
                "lin" => "lin",
                _ => "dec",
            };
            Ok(format!(
                ".ac {sweep} {} {} {}",
                p.points.unwrap_or(100),
                p.f_start.unwrap_or(10.0),
                p.f_stop.unwrap_or(100_000.0)
            ))
        }
        AnalysisKind::Tran => {
            let step = p.step.unwrap_or(1e-5);
            let start = p.start.unwrap_or(0.0);
            let duration = p.duration.unwrap_or(0.01);
            // .tran step stop start：从 start 开始保存，持续 duration
            Ok(format!(".tran {step} {} {start}", start + duration))
        }
    }
}

// ---------------------------------------------------------------- 拼网表

/// 交付网表 → 可仿真网表：补激励（IN 兼作波形发生器）、电源轨、器件模型、分析行。
pub fn build_batch(
    base_cir: &str,
    ports: &netlist::Ports,
    kind: AnalysisKind,
    p: &SimParams,
    extra_probes: &[String],
) -> Result<String, String> {
    let mut body: Vec<&str> = base_cir
        .lines()
        .filter(|l| !l.trim().eq_ignore_ascii_case(".end"))
        .collect();
    while body.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        body.pop();
    }

    let mut out = String::from("* ==== 以下为仿真附加（不写进交付的 .cir）====\n");

    // 电源轨：VCC / VEE 在图纸里是网络标签，仿真必须给真实源
    for (net, volt) in [("VCC", 9.0), ("VEE", -9.0)] {
        let used = body.iter().any(|l| {
            let t: Vec<&str> = l.split_whitespace().collect();
            t.len() > 2 && t.iter().skip(1).any(|n| *n == net)
        });
        let driven = body.iter().any(|l| {
            let t: Vec<&str> = l.split_whitespace().collect();
            t.len() > 2 && (t[0].starts_with('V') || t[0].starts_with('v')) && t[1] == net
        });
        if used && !driven {
            out.push_str(&format!("VSUP_{net} {net} 0 DC {volt}\n"));
        }
    }

    // 激励：图纸没画 voltage-source 时，在 in 网挂源。
    // **IN 元件兼作波形发生器**：tran 用 SIN(amp,freq)、ac 需要 AC 1。
    let has_source = !out.to_lowercase().contains("\nvsim ") && body.iter().any(|l| {
        let t: Vec<&str> = l.split_whitespace().collect();
        t.len() > 1 && (t[0].starts_with('V') || t[0].starts_with('v')) && ports.r#in.as_deref() == Some(t[1])
    });
    if !has_source {
        if let Some(nin) = &ports.r#in {
            let amp = p.amp.unwrap_or(0.2);
            let freq = p.freq.unwrap_or(1000.0);
            let src = match kind {
                AnalysisKind::Ac => format!("VSIM {nin} 0 DC 0 AC 1\n"),
                _ => format!("VSIM {nin} 0 DC 0 SIN(0 {amp} {freq} 0 0 0)\n"),
            };
            out.push_str(&src);
        }
    }

    out.push_str(&body.join("\n"));
    out.push('\n');
    if !MODELS_LIB.trim().is_empty() {
        out.push_str("* ---- 器件模型（仅仿真）----\n");
        out.push_str(MODELS_LIB.trim());
        out.push('\n');
    }

    // 探针：瞬态/AC/DC 一律要 .print，否则按 rawfile 收
    let probes = probes_of(ports, extra_probes);
    if !probes.is_empty() && kind != AnalysisKind::Op {
        let kind_cmd = match kind {
            AnalysisKind::Tran => "tran",
            AnalysisKind::Ac => "ac",
            AnalysisKind::Dc => "dc",
            AnalysisKind::Op => "op",
        };
        out.push_str(&format!(".print {kind_cmd} {}\n", probes.join(" ")));
    }
    out.push_str(&analysis_line(kind, p)?);
    out.push('\n');
    out.push_str(".end\n");
    Ok(out)
}

/// 探针列表：端口 in/out + 调用方追加的（测试点）
fn probes_of(ports: &netlist::Ports, extra: &[String]) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for n in [ports.r#in.clone(), ports.out.clone()].into_iter().flatten() {
        v.push(format!("v({})", n.to_lowercase()));
    }
    for n in extra {
        let l = n.to_lowercase();
        if !v.contains(&format!("v({l})")) {
            v.push(format!("v({l})"));
        }
    }
    v
}

// ---------------------------------------------------------------- rawfile 解析（取自 breadspice）

struct ParsedRaw {
    variables: Vec<String>,
    points: Vec<Vec<f64>>,
}

#[derive(PartialEq)]
enum Section {
    Header,
    Variables,
    Values,
}

/// 解析单个数值；`complex` 时接受 `re,im`。独立变量取实部，其余取模长（AC 幅值）。
fn parse_value(token: &str, flags: &str, index_in_point: usize) -> Result<f64, String> {
    if flags == "complex" {
        let (re, im) = token.split_once(',').ok_or_else(|| format!("非法复数 {token}"))?;
        let re: f64 = re.trim().parse().map_err(|_| format!("非法实部 {re}"))?;
        let im: f64 = im.trim().parse().map_err(|_| format!("非法虚部 {im}"))?;
        if index_in_point == 0 {
            Ok(re)
        } else {
            Ok((re * re + im * im).sqrt())
        }
    } else {
        token.parse::<f64>().map_err(|_| format!("非法数值 {token}"))
    }
}

fn parse_rawfile(text: &str) -> Result<ParsedRaw, String> {
    let mut flags = String::new();
    let mut n_vars = 0usize;
    let mut variables: Vec<String> = Vec::new();
    let mut values: Vec<f64> = Vec::new();

    let mut section = Section::Header;
    let mut value_count = 0usize;
    for line in text.lines() {
        match section {
            Section::Header => {
                if let Some(v) = line.strip_prefix("Flags: ") {
                    flags = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("No. Variables: ") {
                    n_vars = v.trim().parse().map_err(|_| "No. Variables 解析失败".to_string())?;
                } else if line.trim() == "Variables:" {
                    section = Section::Variables;
                }
            }
            Section::Variables => {
                if line.trim() == "Values:" {
                    section = Section::Values;
                } else if !line.trim().is_empty() {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 2 {
                        variables.push(parts[1].to_string());
                    }
                }
            }
            Section::Values => {
                if line.trim().is_empty() {
                    continue;
                }
                let token = line.split_whitespace().last().ok_or_else(|| "rawfile Values 行为空".to_string())?;
                let idx = value_count % n_vars.max(1);
                values.push(parse_value(token, &flags, idx)?);
                value_count += 1;
            }
        }
    }

    if n_vars == 0 {
        return Err("rawfile 缺少 No. Variables".into());
    }
    if values.len() < n_vars {
        return Err(format!("rawfile 数值不足一个点：读取 {} 个值", values.len()));
    }
    let n_points = values.len() / n_vars;
    let points: Vec<Vec<f64>> = (0..n_points).map(|p| values[p * n_vars..(p + 1) * n_vars].to_vec()).collect();
    Ok(ParsedRaw { variables, points })
}

impl ParsedRaw {
    fn into_traces(self) -> Vec<Trace> {
        let mut traces = Vec::new();
        if self.variables.is_empty() || self.points.is_empty() {
            return traces;
        }
        let x: Vec<f64> = self.points.iter().map(|r| r[0]).collect();
        for i in 1..self.variables.len() {
            let y: Vec<f64> = self.points.iter().map(|r| r[i]).collect();
            traces.push(Trace { name: self.variables[i].clone(), x: x.clone(), y });
        }
        traces
    }
}

// ---------------------------------------------------------------- 运行

fn ngspice_bin() -> String {
    std::env::var("NGSPICE").unwrap_or_else(|_| "ngspice".to_string())
}

/// 取消正在跑的仿真（`designer.stop`）
pub fn stop_running() -> bool {
    let pid = RUNNING_PID.swap(0, Ordering::SeqCst);
    if pid <= 0 {
        return false;
    }
    Command::new("kill").arg(pid.to_string()).status().is_ok()
}

pub fn models() -> &'static str {
    MODELS_LIB
}

pub fn run(req: &SimRequest, table: &SymbolTable) -> Result<SimResult, String> {
    let g = netlist::generate(&req.doc, table);
    let errors: Vec<&netlist::Lint> = g.lints.iter().filter(|l| l.level == netlist::Level::Error).collect();
    if !errors.is_empty() {
        return Err(format!("图纸有 {} 个 error，先修好：{}", errors.len(), errors[0].msg));
    }
    if g.ports.out.is_none() && req.probes.is_empty() {
        return Err("没有 OUT 端口，也没有指定探针，取不到波形".into());
    }

    let p = req.params.clone();
    let batch = build_batch(&g.cir, &g.ports, req.analysis, &p, &req.probes)?;

    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let workdir = std::env::temp_dir().join(format!("cdsim-{}-{}", std::process::id(), seq));
    std::fs::create_dir_all(&workdir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    std::fs::write(workdir.join("circuit.cir"), &batch).map_err(|e| format!("写网表失败：{e}"))?;
    // 强制 ASCII rawfile（与 breadspice 一致）
    std::fs::write(workdir.join(".spiceinit"), "set filetype=ascii\n").map_err(|e| format!("写 .spiceinit 失败：{e}"))?;

    let child = Command::new(ngspice_bin())
        .arg("-b")
        .arg("-r")
        .arg("result.raw")
        .arg("circuit.cir")
        .current_dir(&workdir)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 ngspice（{}）：{e}；装它或用 NGSPICE=/path/to/ngspice", ngspice_bin()))?;
    RUNNING_PID.store(child.id() as i32, Ordering::SeqCst);
    let output = child.wait_with_output();
    RUNNING_PID.store(0, Ordering::SeqCst);
    let output = output.map_err(|e| format!("等待 ngspice 结束失败：{e}"))?;

    let log = tail(&format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)), 12);
    let parsed = std::fs::read_to_string(workdir.join("result.raw"))
        .map_err(|e| format!("读取 rawfile 失败：{e}\n{log}"))
        .and_then(|t| parse_rawfile(&t));
    let _ = std::fs::remove_dir_all(&workdir);

    let cancelled = output.status.code().is_none();
    match parsed {
        Ok(data) => {
            let mut op = None;
            let traces = if req.analysis == AnalysisKind::Op {
                let mut map = HashMap::new();
                if let Some(row) = data.points.first() {
                    for (i, name) in data.variables.iter().enumerate() {
                        if let Some(v) = row.get(i) {
                            map.insert(name.clone(), *v);
                        }
                    }
                }
                op = Some(map);
                Vec::new()
            } else {
                data.into_traces()
            };
            // THD：只在瞬态分析、且拿到 out 探针时算
            let thd = if req.analysis == AnalysisKind::Tran {
                let f0 = p.freq.unwrap_or(1000.0);
                traces
                    .iter()
                    .find(|t| g.ports.out.as_ref().map(|o| t.name == format!("v({})", o.to_lowercase())).unwrap_or(false))
                    .and_then(|t| thd(&t.x, &t.y, f0))
            } else {
                None
            };
            Ok(SimResult { analysis: req.analysis, traces, op, cancelled, thd, cir: batch, log })
        }
        Err(parse_err) => {
            if cancelled {
                return Ok(SimResult {
                    analysis: req.analysis,
                    traces: Vec::new(),
                    op: None,
                    cancelled: true,
                    thd: None,
                    cir: batch,
                    log,
                });
            }
            Err(format!("ngspice 仿真失败：{parse_err}\n退出码 {:?}\n{log}", output.status.code()))
        }
    }
}

fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

// ---------------------------------------------------------------- THD（保留原实现）

/// 用"最小二乘投影 + Hann 窗"算前 9 次谐波，返回 THD（相对基波）。
pub fn thd(t: &[f64], v: &[f64], f0: f64) -> Option<f64> {
    if t.len() < 32 || t.len() != v.len() || f0 <= 0.0 {
        return None;
    }
    let period = 1.0 / f0;
    let t_end = *t.last()?;
    let t_start = (t_end - 8.0 * period).max(t[0]);
    let idx: Vec<usize> = (0..t.len()).filter(|i| t[*i] >= t_start && t[*i] <= t_end).collect();
    if idx.len() < 32 {
        return None;
    }
    let n = idx.len() as f64;
    let amp = |k: f64| -> f64 {
        let (mut re, mut im) = (0.0, 0.0);
        for (j, i) in idx.iter().enumerate() {
            let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * j as f64 / (n - 1.0)).cos();
            let ph = 2.0 * std::f64::consts::PI * k * f0 * t[*i];
            re += w * v[*i] * ph.cos();
            im += w * v[*i] * ph.sin();
        }
        (re * re + im * im).sqrt() * 2.0 / n
    };
    let a1 = amp(1.0);
    if a1 <= 1e-9 {
        return None;
    }
    let mut acc = 0.0;
    for k in 2..=9 {
        let a = amp(k as f64);
        acc += a * a;
    }
    Some(acc.sqrt() / a1)
}

#[allow(dead_code)]
fn unused(_: PathBuf) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn table() -> SymbolTable {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../symbols/symbols.json")).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    fn divider() -> Document {
        let json = r#"{
          "name":"低通",
          "parts":[
            {"id":"p1","ref":"R1","symbol":"resistor","value":"10k","at":{"x":0,"y":0},"rot":0,"mirror":"none"},
            {"id":"p2","ref":"C1","symbol":"capacitor","value":"100n","at":{"x":25,"y":12.5},"rot":90,"mirror":"none"},
            {"id":"p3","ref":"GND1","symbol":"earth","at":{"x":25,"y":37.5},"rot":0,"mirror":"none"},
            {"id":"p4","ref":"IN1","symbol":"node-in","at":{"x":-45,"y":0},"rot":0,"mirror":"none"},
            {"id":"p5","ref":"OUT1","symbol":"node-out","at":{"x":50,"y":0},"rot":0,"mirror":"none"}
          ],
          "wires":[
            {"id":"w1","points":[{"x":-32.5,"y":0},{"x":-12.5,"y":0}]},
            {"id":"w2","points":[{"x":12.5,"y":0},{"x":37.5,"y":0}]}
          ]}"#;
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn 分析行按类型生成() {
        let p = SimParams { step: Some(1e-5), start: Some(0.0), duration: Some(0.02), ..Default::default() };
        assert_eq!(analysis_line(AnalysisKind::Tran, &p).unwrap(), ".tran 0.00001 0.02 0");
        let a = SimParams { sweep: Some("dec".into()), points: Some(50), f_start: Some(10.0), f_stop: Some(1e5), ..Default::default() };
        assert_eq!(analysis_line(AnalysisKind::Ac, &a).unwrap(), ".ac dec 50 10 100000");
        assert_eq!(analysis_line(AnalysisKind::Op, &SimParams::default()).unwrap(), ".op");
    }

    #[test]
    fn ac_用_ac_源_tran_用_sin() {
        let t = table();
        let g = netlist::generate(&divider(), &t);
        let ac = build_batch(&g.cir, &g.ports, AnalysisKind::Ac, &SimParams::default(), &[]).unwrap();
        assert!(ac.contains("VSIM IN 0 DC 0 AC 1"), "{ac}");
        let tr = build_batch(&g.cir, &g.ports, AnalysisKind::Tran, &SimParams::default(), &[]).unwrap();
        assert!(tr.contains("SIN(0"), "{tr}");
        assert!(tr.contains(".tran"));
        assert!(tr.contains(".end"));
        // 注意：`.ends OP07A`（模型库里的子电路结尾）也含 ".end" 子串 → 按整行数
        assert_eq!(tr.lines().filter(|l| l.trim().eq_ignore_ascii_case(".end")).count(), 1);
    }

    #[test]
    fn ngspice_可用时_tran_与_ac_都能跑() {
        if Command::new(ngspice_bin()).arg("-v").output().is_err() {
            eprintln!("跳过：没装 ngspice");
            return;
        }
        let t = table();
        // tran
        let req = SimRequest {
            doc: divider(),
            analysis: AnalysisKind::Tran,
            params: SimParams { amp: Some(0.2), freq: Some(1000.0), step: Some(1e-5), start: Some(0.0), duration: Some(0.02), ..Default::default() },
            probes: vec![],
        };
        let r = run(&req, &t).expect("tran 应该成功");
        assert!(r.traces.len() >= 2, "应至少有 in/out 两条：{:?}", r.traces.iter().map(|t| &t.name).collect::<Vec<_>>());
        let out = r.traces.iter().find(|t| t.name == "v(out)").expect("没有 v(out)");
        let tailmax = out.y[out.y.len() * 3 / 4..].iter().cloned().fold(f64::MIN, f64::max);
        assert!(tailmax > 0.01 && tailmax < 0.1, "1 kHz 应被低通衰减：{tailmax}");
        assert!(r.thd.is_some());

        // ac：看 -3dB 附近（fc≈159 Hz）
        let req = SimRequest {
            doc: divider(),
            analysis: AnalysisKind::Ac,
            params: SimParams { points: Some(50), f_start: Some(10.0), f_stop: Some(100_000.0), ..Default::default() },
            probes: vec![],
        };
        let r = run(&req, &t).expect("ac 应该成功");
        let out = r.traces.iter().find(|t| t.name == "v(out)").expect("没有 v(out)");
        let idx = out.x.iter().position(|f| *f >= 159.0).expect("没扫到 159 Hz");
        let mag = out.y[idx];
        assert!((0.60..0.80).contains(&mag), "fc 处应≈0.707（-3dB）：{mag}");
    }

    #[test]
    fn rawfile_解析复数取模长() {
        let text = "Title: x\nFlags: complex\nNo. Variables: 2\nNo. Points: 2\nVariables:\n\t0\tfrequency\tfrequency\n\t1\tv(out)\tvoltage\nValues:\n0\t1.000000e+03,0\n\t3.000000e+00,4.000000e+00\n1\t2.000000e+03,0\n\t0.000000e+00,2.000000e+00\n";
        let p = parse_rawfile(text).unwrap();
        assert_eq!(p.variables, vec!["frequency", "v(out)"]);
        assert_eq!(p.points.len(), 2);
        assert!((p.points[0][0] - 1000.0).abs() < 1e-9);
        assert!((p.points[0][1] - 5.0).abs() < 1e-9, "3+4j → 5");
        let _ = Path::new("/tmp");
    }
}
