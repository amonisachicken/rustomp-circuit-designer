// SPDX-License-Identifier: GPL-3.0-or-later
//! 仿真：把当前图纸交给 ngspice 跑一次瞬态，取回波形（D3 的雏形，docs/05 §7 第 2 步）。
//!
//! 设计取舍：
//! - **交付的 `.cir` 里不含任何仿真附加物**：源、`.tran`、`.control` 只在仿真时临时拼上去，
//!   否则生成的电路会多出一个"仅用于仿真"的电压源（rustomp 的 Ckt 不需要它）；
//! - **没有源就自动加一个**：图纸上没画 `voltage-source` 时，在 `in` 网络挂一个
//!   `SIN(0 <amp> <freq> 0 0 0)`（对应 prompt.md 里 "INPUT 内部封装正弦源，仅用于 ngspice"）；
//! - 波形用 `wrdata` 落盘再读回来（比解析 `print` 的表格稳）。

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::netlist::{self, Document, SymbolTable};

#[derive(Debug, Clone, Deserialize)]
pub struct SimRequest {
    pub doc: Document,
    /// 正弦幅值（V），默认 0.2
    #[serde(default)]
    pub amp: Option<f64>,
    /// 正弦频率（Hz），默认 1000
    #[serde(default)]
    pub freq: Option<f64>,
    /// 仿真时长（ms），默认 10（短窗口只看得到瞬态）
    #[serde(default)]
    pub stop_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SimResult {
    /// 拼给 ngspice 的完整网表（调试用；与交付的 .cir 不同）
    pub cir: String,
    pub t: Vec<f64>,
    pub vin: Vec<f64>,
    pub vout: Vec<f64>,
    /// 端口名（波形标签）
    pub ports: netlist::Ports,
    /// 输出波形的 THD（前 9 次谐波，相对基波；算不出来就是 None）
    pub thd: Option<f64>,
    /// 输入波形的 THD（用来判断"源本身不干净"的情况）
    pub thd_in: Option<f64>,
    /// ngspice 的报错/警告尾巴（成功时也可能有）
    pub log: String,
}

const MAX_POINTS: usize = 2000;

/// 仿真用的器件模型库（`assets/models.lib`）。找不到就返回空串 ——
/// 纯无源电路（电阻/电容/电源）不需要模型，仍然能仿真。
fn model_lib(root: &Path) -> String {
    let env = std::env::var("CD_MODELS").ok().map(std::path::PathBuf::from);
    let path = env.unwrap_or_else(|| root.join("assets/models.lib"));
    match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => {
            eprintln!("（提示）没有找到器件模型库 {}：二极管/三极管/运放会仿真失败", path.display());
            String::new()
        }
    }
}

fn ngspice_bin() -> String {
    std::env::var("NGSPICE").unwrap_or_else(|_| "ngspice".to_string())
}

/// 把交付网表改造成"可仿真的网表"：去掉 `.end`，自动补源，加 `.control`。
#[allow(clippy::too_many_arguments)]
pub fn with_analysis(
    base_cir: &str,
    ports: &netlist::Ports,
    has_source: bool,
    amp: f64,
    freq: f64,
    stop_s: f64,
    wr: &Path,
    models: &str,
) -> String {
    let mut body: Vec<&str> = base_cir
        .lines()
        .filter(|l| !l.trim_start().eq_ignore_ascii_case(".end"))
        .collect();
    // 去掉尾部空行
    while body.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        body.pop();
    }

    let mut out = String::new();
    out.push_str("* ==== 以下为仿真附加（不写进交付的 .cir）====\n");
    // VCC / VEE 在图纸里是**网络标签**（电源端符号），仿真必须给它一个真实源，
    // 否则这两条轨道悬空、放大级没有供电（典型症状：输出幅度与输入一样大）。
    for (net, volt) in [("VCC", 9.0), ("VEE", -9.0)] {
        let used = base_cir.lines().any(|l| {
            let t: Vec<&str> = l.split_whitespace().collect();
            t.len() > 2 && t.iter().skip(1).any(|n| *n == net)
        });
        let driven = base_cir.lines().any(|l| {
            let t: Vec<&str> = l.split_whitespace().collect();
            t.len() > 2 && (t[0].starts_with('V') || t[0].starts_with('v')) && t[1] == net
        });
        if used && !driven {
            out.push_str(&format!("VSUP_{net} {net} 0 DC {volt}\n"));
        }
    }
    if !has_source {
        if let Some(nin) = &ports.r#in {
            out.push_str(&format!("VSIM {nin} 0 DC 0 SIN(0 {amp} {freq} 0 0 0)\n"));
        }
    }
    out.push_str(&body.join("\n"));
    out.push('\n');

    // 器件模型（.model / .subckt）：ngspice 需要，交付网表不需要
    if !models.trim().is_empty() {
        out.push_str("* ---- 器件模型（仅仿真）----\n");
        out.push_str(models.trim());
        out.push('\n');
    }

    let step = (stop_s / 3000.0).max(1e-9);
    let probes: Vec<String> = [ports.r#in.as_ref(), ports.out.as_ref()]
        .into_iter()
        .flatten()
        .map(|n| format!("v({n})"))
        .collect();
    out.push_str(".control\n");
    out.push_str(&format!("tran {step:.9} {stop_s:.9}\n"));
    if !probes.is_empty() {
        out.push_str(&format!("wrdata {} {}\n", wr.display(), probes.join(" ")));
    }
    out.push_str("quit\n.endc\n.end\n");
    out
}

/// 读 wrdata 的输出（每列一对 (x, y)）
fn parse_wrdata(text: &str, want: usize) -> Vec<Vec<(f64, f64)>> {
    let mut cols: Vec<Vec<(f64, f64)>> = vec![Vec::new(); want];
    for line in text.lines() {
        let nums: Vec<f64> = line
            .split_whitespace()
            .filter_map(|t| t.parse::<f64>().ok())
            .collect();
        for (i, chunk) in nums.chunks(2).enumerate() {
            if i >= want || chunk.len() < 2 {
                continue;
            }
            cols[i].push((chunk[0], chunk[1]));
        }
    }
    cols
}

/// 降采样到 `MAX_POINTS`（保形：等间隔抽样，端点保留）
fn thin(v: &[(f64, f64)]) -> Vec<(f64, f64)> {
    if v.len() <= MAX_POINTS {
        return v.to_vec();
    }
    let step = (v.len() as f64 / MAX_POINTS as f64).ceil() as usize;
    let mut out: Vec<(f64, f64)> = v.iter().step_by(step.max(1)).copied().collect();
    if let Some(last) = v.last() {
        if out.last().map(|p| p.0) != Some(last.0) {
            out.push(*last);
        }
    }
    out
}

pub fn run(req: &SimRequest, table: &SymbolTable) -> Result<SimResult, String> {
    let g = netlist::generate(&req.doc, table);
    let errors: Vec<&netlist::Lint> = g.lints.iter().filter(|l| l.level == netlist::Level::Error).collect();
    if !errors.is_empty() {
        return Err(format!("图纸有 {} 个 error，先修好：{}", errors.len(), errors[0].msg));
    }
    let Some(_out) = g.ports.out.clone() else {
        return Err("没有 OUT 端口，无法取波形".into());
    };

    let amp = req.amp.unwrap_or(0.2);
    let freq = req.freq.unwrap_or(1000.0);
    let stop_s = req.stop_ms.unwrap_or(10.0) / 1000.0;
    let has_source = req.doc.parts.iter().any(|p| p.symbol == "voltage-source");

    let dir = std::env::temp_dir().join(format!("cdsim-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("建临时目录失败：{e}"))?;
    let cir_path = dir.join("sim.cir");
    let dat_path = dir.join("sim.dat");
    let _ = std::fs::remove_file(&dat_path);

    let root = std::env::var("CD_ROOT").map(std::path::PathBuf::from).unwrap_or_else(|_| {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
    });
    let models = model_lib(&root);
    let cir = with_analysis(&g.cir, &g.ports, has_source, amp, freq, stop_s, &dat_path, &models);
    std::fs::write(&cir_path, &cir).map_err(|e| format!("写临时网表失败：{e}"))?;

    let output = Command::new(ngspice_bin())
        .arg("-b")
        .arg(&cir_path)
        .output()
        .map_err(|e| format!("启动 ngspice 失败（{e}）；装它或用 NGSPICE=/path/to/ngspice 指定"))?;
    let mut log = String::from_utf8_lossy(&output.stdout).into_owned();
    log.push_str(&String::from_utf8_lossy(&output.stderr));

    if !output.status.success() {
        let tail: String = log.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("ngspice 退出码 {:?}\n{tail}", output.status.code()));
    }

    let dat = std::fs::read_to_string(&dat_path).map_err(|e| {
        format!("ngspice 没产出波形（{e}）\n{}", log.lines().rev().take(10).collect::<Vec<_>>().join("\n"))
    })?;
    let want = [g.ports.r#in.is_some(), g.ports.out.is_some()].iter().filter(|b| **b).count();
    let cols = parse_wrdata(&dat, want.max(1));
    if cols.is_empty() || cols[0].is_empty() {
        return Err("波形为空".into());
    }

    // 列顺序与 probes 一致：[in?, out?]
    let (vin, vout) = match (g.ports.r#in.is_some(), g.ports.out.is_some()) {
        (true, true) => (cols[0].clone(), cols[1].clone()),
        (true, false) => (cols[0].clone(), Vec::new()),
        (false, true) => (Vec::new(), cols[0].clone()),
        _ => (Vec::new(), Vec::new()),
    };
    let t_src = if !vin.is_empty() { &vin } else { &vout };
    let t: Vec<f64> = thin(t_src).iter().map(|p| p.0 * 1000.0).collect(); // ms
    let vin_t = thin(&vin).iter().map(|p| p.1).collect();
    let vout_t = thin(&vout).iter().map(|p| p.1).collect();

    // THD 用**未降采样**的原始数据算（降采样会削掉高次谐波）
    let thd_out = thd(&vout.iter().map(|p| p.0).collect::<Vec<_>>(), &vout.iter().map(|p| p.1).collect::<Vec<_>>(), freq);
    let thd_in = thd(&vin.iter().map(|p| p.0).collect::<Vec<_>>(), &vin.iter().map(|p| p.1).collect::<Vec<_>>(), freq);

    let _ = std::fs::remove_dir_all(&dir);
    Ok(SimResult {
        cir,
        t,
        vin: vin_t,
        vout: vout_t,
        ports: g.ports,
        thd: thd_out,
        thd_in,
        log: tail_of(&log, 8),
    })
}

fn tail_of(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_table() -> SymbolTable {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../symbols/symbols.json")).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    /// 一阶低通：IN —R1(10k)— OUT —C1(100n)— 地
    ///
    /// 坐标（mm）：R1 在 (0,0)，引脚 (-12.5,0)/(12.5,0)；C1 竖放 at (25,12.5)，引脚 (25,0)/(25,25)；
    /// 导线把 IN 接到 R1 左端、R1 右端接到 OUT 符号，C1 上端落在该导线上（T 型接点）。
    fn divider_doc() -> Document {
        let json = r#"{
          "name": "低通",
          "parts": [
            {"id":"p1","ref":"R1","symbol":"resistor","value":"10k","at":{"x":0,"y":0},"rot":0,"mirror":"none"},
            {"id":"p2","ref":"C1","symbol":"capacitor","value":"100n","at":{"x":25,"y":12.5},"rot":90,"mirror":"none"},
            {"id":"p3","ref":"GND1","symbol":"earth","at":{"x":25,"y":37.5},"rot":0,"mirror":"none"},
            {"id":"p4","ref":"IN1","symbol":"node-in","at":{"x":-25,"y":0},"rot":0,"mirror":"none"},
            {"id":"p5","ref":"OUT1","symbol":"node-out","at":{"x":50,"y":0},"rot":0,"mirror":"none"}
          ],
          "wires": [
            {"id":"w1","points":[{"x":-37.5,"y":0},{"x":-12.5,"y":0}]},
            {"id":"w2","points":[{"x":12.5,"y":0},{"x":37.5,"y":0}]}
          ]
        }"#;
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn 附加块只在仿真时拼_交付网表不含源与tran() {
        let t = load_table();
        let g = netlist::generate(&divider_doc(), &t);
        assert!(!g.cir.contains("SIN("), "交付网表不该有源：\n{}", g.cir);
        assert!(!g.cir.contains(".tran"), "交付网表不该有 .tran：\n{}", g.cir);

        let sim = with_analysis(&g.cir, &g.ports, false, 0.2, 1000.0, 0.003, Path::new("/tmp/x.dat"), "");
        assert!(sim.contains("VSIM IN 0 DC 0 SIN(0 0.2 1000 0 0 0)"), "{sim}");
        assert!(sim.contains(".control"), "{sim}");
        assert!(sim.contains("wrdata /tmp/x.dat v(IN) v(OUT)"), "{sim}");
        assert!(sim.trim_end().ends_with(".end"), "{sim}");
        let end_lines = sim.lines().filter(|l| l.trim().eq_ignore_ascii_case(".end")).count();
        assert_eq!(end_lines, 1, "只能有一个 .end：{sim}");
    }

    #[test]
    fn ngspice_可用时能跑出波形() {
        if Command::new(ngspice_bin()).arg("-v").output().is_err() {
            eprintln!("跳过：没装 ngspice");
            return;
        }
        let t = load_table();
        let req = SimRequest { doc: divider_doc(), amp: Some(0.2), freq: Some(1000.0), stop_ms: Some(20.0) };
        let r = run(&req, &t).expect("仿真应该成功");
        assert!(r.t.len() > 100, "点数太少：{}", r.t.len());
        assert_eq!(r.t.len(), r.vout.len());
        // 一阶低通（10k + 100n，fc≈159 Hz）：1 kHz 处输出应明显衰减。
        // 只看窗口最后 25%：开头有指数衰减的瞬态（起始相位会带来过冲到 ~0.05），
        // 用全程最大值去比会得到 0.25 这个假数字。
        let tail = |v: &[f64]| -> f64 {
            let from = (v.len() as f64 * 0.75) as usize;
            v[from..].iter().cloned().fold(f64::MIN, f64::max)
        };
        let (tail_in, tail_out) = (tail(&r.vin), tail(&r.vout));
        let ratio = tail_out / tail_in;
        assert!(tail_in > 0.15, "输入幅值不对：{tail_in}");
        // fc ≈ 159 Hz，1 kHz 时 |H| = 1/√(1+(f/fc)²) ≈ 0.157
        assert!(
            (0.13..0.19).contains(&ratio),
            "稳态衰减应≈0.157：实测 {ratio:.3}（len={} tN={:.3}ms tail_in={tail_in:.4} tail_out={tail_out:.4}）",
            r.t.len(),
            r.t.last().copied().unwrap_or(-1.0)
        );
        let last_t = r.t.last().copied().unwrap_or(0.0);
        assert!((last_t - 20.0).abs() < 0.5, "时长应≈20 ms：{last_t}");
    }
}

// ---------------------------------------------------------------- THD（不引 FFT 依赖）

/// 用"最小二乘投影 + Hann 窗"算前 9 次谐波，返回 THD（相对基波）。
///
/// 为什么不用 FFT：波形点数是任意的（wrdata 变步长、我们又降采样过），
/// 投影法对非整数周期更稳，而且不需要引依赖。
pub fn thd(t: &[f64], v: &[f64], f0: f64) -> Option<f64> {
    if t.len() < 32 || t.len() != v.len() || f0 <= 0.0 {
        return None;
    }
    // 取最后 8 个周期（稳态段）
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
            let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * j as f64 / (n - 1.0)).cos(); // Hann
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

#[cfg(test)]
mod thd_tests {
    use super::thd;

    #[test]
    fn 纯正弦的_thd_接近零() {
        let f = 1000.0;
        let dt = 1.0 / 200_000.0;
        let t: Vec<f64> = (0..4000).map(|i| i as f64 * dt).collect();
        let v: Vec<f64> = t.iter().map(|x| 0.2 * (2.0 * std::f64::consts::PI * f * x).sin()).collect();
        let thd = thd(&t, &v, f).expect("应该算得出来");
        assert!(thd < 0.01, "纯正弦 THD 应≈0：{thd}");
    }

    #[test]
    fn 削顶方波的_thd_明显升高() {
        let f = 1000.0;
        let dt = 1.0 / 200_000.0;
        let t: Vec<f64> = (0..4000).map(|i| i as f64 * dt).collect();
        let v: Vec<f64> = t
            .iter()
            .map(|x| 0.2 * (2.0 * std::f64::consts::PI * f * x).sin())
            .map(|s| s.clamp(-0.1, 0.1)) // 硬削波
            .collect();
        let thd = thd(&t, &v, f).expect("应该算得出来");
        // 只算到 9 次谐波，所以硬削波也就 0.23 左右（真正的方波还有更高次）
        assert!(thd > 0.2, "硬削波的 THD 应明显：{thd}");
    }
}
