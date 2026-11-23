// SPDX-License-Identifier: GPL-3.0-or-later
//! 文档 → SPICE 网表（`docs/05-netlist-contract.md`）。
//!
//! 三条硬性要求：
//! 1. **确定性字节**：同一张图永远产出同一段文本（元件按参考编号自然序、导线按坐标、
//!    自动网络名按网络最小坐标排序），否则漂移守卫与 git diff 全部失效；
//! 2. **按引脚名取节点**：引脚局部坐标经 rotate/mirror 变换到世界坐标，再用 `pinOrder`
//!    排列 —— 绝不按素材注释的顺序抄（运放的顺序和注释就不一样）；
//! 3. **不做开关**（D-007）：导出永远是单份网表。

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

pub const GRID: f64 = 2.5;
/// 坐标量化精度（mm）。浮点相加会带来 1e-15 的误差，量化后才能当 key 用。
const Q: f64 = 1000.0;

fn key(p: Pt) -> (i64, i64) {
    ((p.x * Q).round() as i64, (p.y * Q).round() as i64)
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Part {
    pub id: String,
    #[serde(rename = "ref")]
    pub r#ref: String,
    pub symbol: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub alias: Option<String>,
    pub at: Pt,
    #[serde(default)]
    pub rot: i32,
    #[serde(default = "no_mirror")]
    pub mirror: String,
    // ---- 变压器专用（其它符号忽略；全部有默认值，老文件不受影响）----
    /// 匝比 `n_p / n_s`（默认 2 → 次级电感 = 初级 / 4）
    #[serde(default)]
    pub ratio: Option<f64>,
    /// 耦合系数（默认 0.999；必须是 0 < k < 1）
    #[serde(default)]
    pub k: Option<f64>,
    /// 初级抽头位置（0..1，默认 0.5；从**打点端**量起）
    #[serde(default)]
    pub tap_p: Option<f64>,
    /// 次级抽头位置（0..1，默认 0.5）
    #[serde(default)]
    pub tap_s: Option<f64>,
}

fn no_mirror() -> String {
    "none".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct Wire {
    pub id: String,
    pub points: Vec<Pt>,
    #[serde(default)]
    pub net: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Document {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub parts: Vec<Part>,
    #[serde(default)]
    pub wires: Vec<Wire>,
}

// ---------------------------------------------------------------- 符号表

#[derive(Debug, Clone, Deserialize)]
pub struct PinSpec {
    pub id: String,
    pub at: Pt,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SpiceSpec {
    #[serde(default)]
    pub prefix: String,
    #[serde(rename = "pinOrder", default)]
    pub pin_order: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SymSpec {
    pub pins: Vec<PinSpec>,
    pub spice: SpiceSpec,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub category: String,
    #[serde(default, rename = "netName")]
    pub net_name: Option<String>,
    #[serde(default)]
    pub port: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SymbolTable {
    pub symbols: BTreeMap<String, SymSpec>,
}

// ---------------------------------------------------------------- lint

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error,
    Warn,
}

#[derive(Debug, Clone, Serialize)]
pub struct Lint {
    pub level: Level,
    pub code: &'static str,
    pub msg: String,
}

fn err(code: &'static str, msg: impl Into<String>) -> Lint {
    Lint { level: Level::Error, code, msg: msg.into() }
}
fn warn(code: &'static str, msg: impl Into<String>) -> Lint {
    Lint { level: Level::Warn, code, msg: msg.into() }
}

// ---------------------------------------------------------------- 结果

#[derive(Debug, Clone, Serialize)]
pub struct Generated {
    /// 网表全文（确定性）
    pub cir: String,
    pub lints: Vec<Lint>,
    /// 端口（找不到就是 None）
    pub ports: Ports,
    /// 每个网络的名字与成员引脚（调试/状态栏用）
    pub nets: Vec<NetInfo>,
    /// 悬空引脚（画布上标红圈；`nc` 符号上的引脚不算）
    pub dangling: Vec<Dangling>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Ports {
    pub r#in: Option<String>,
    pub out: Option<String>,
}

/// 悬空引脚（只连了自己的网络）—— 前端在画布上标红圈
#[derive(Debug, Clone, Serialize)]
pub struct Dangling {
    #[serde(rename = "ref")]
    pub r#ref: String,
    pub pin: String,
    pub at: Pt,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetInfo {
    pub name: String,
    pub pins: Vec<String>,
}

// ---------------------------------------------------------------- 几何

/// 局部 → 世界（**必须与前端 model.ts 的 toWorld 完全一致**）
pub fn to_world(local: Pt, part: &Part) -> Pt {
    let mut x = local.x;
    let mut y = local.y;
    match part.mirror.as_str() {
        "x" => x = -x,
        "y" => y = -y,
        _ => {}
    }
    let a = (part.rot as f64) * std::f64::consts::PI / 180.0;
    let (s, c) = a.sin_cos();
    // 屏幕坐标 y 向下；顺时针 ⇒ (x,y) → (x·cos − y·sin, x·sin + y·cos)
    Pt { x: c * x - s * y + part.at.x, y: s * x + c * y + part.at.y }
}

/// 点是否落在线段上（含端点），容差 1e-6 mm
fn on_segment(p: Pt, a: Pt, b: Pt) -> bool {
    let cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if cross.abs() > 1e-6 {
        return false;
    }
    let dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
    let len2 = (b.x - a.x).powi(2) + (b.y - a.y).powi(2);
    dot >= -1e-6 && dot <= len2 + 1e-6
}

// ---------------------------------------------------------------- 并查集

struct Dsu {
    parent: HashMap<(i64, i64), (i64, i64)>,
}

impl Dsu {
    fn new() -> Self {
        Self { parent: HashMap::new() }
    }
    fn find(&mut self, k: (i64, i64)) -> (i64, i64) {
        let p = *self.parent.get(&k).unwrap_or(&k);
        if p == k {
            self.parent.entry(k).or_insert(k);
            return k;
        }
        let root = self.find(p);
        self.parent.insert(k, root);
        root
    }
    fn union(&mut self, a: (i64, i64), b: (i64, i64)) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            // 用字典序小的当根，保证并查集形状与调用顺序无关
            let (lo, hi) = if ra <= rb { (ra, rb) } else { (rb, ra) };
            self.parent.insert(hi, lo);
        }
    }
}

// ---------------------------------------------------------------- 参考编号自然序

fn ref_key(r: &str) -> (String, i64, String) {
    let split = r.find(|c: char| c.is_ascii_digit()).unwrap_or(r.len());
    let (head, tail) = r.split_at(split);
    let num: i64 = tail.parse().unwrap_or(0);
    (head.to_string(), num, tail.to_string())
}

// ---------------------------------------------------------------- 主流程

pub fn generate(doc: &Document, table: &SymbolTable) -> Generated {
    let mut lints: Vec<Lint> = Vec::new();
    let mut dsu = Dsu::new();

    // 参考编号重复 / 型号闭集
    let mut seen_ref: HashMap<&str, usize> = HashMap::new();
    for p in &doc.parts {
        *seen_ref.entry(p.r#ref.as_str()).or_default() += 1;
    }
    for (r, n) in &seen_ref {
        if *n > 1 {
            lints.push(err("dup-ref", format!("参考编号 {r} 出现 {n} 次")));
        }
    }

    // 1) 导线：两端 union；端点落在别的线段上也算连上（T 型连接）
    let segs: Vec<(Pt, Pt)> = doc
        .wires
        .iter()
        .filter(|w| w.points.len() >= 2)
        .map(|w| (w.points[0], w.points[1]))
        .collect();
    for w in &doc.wires {
        if w.points.len() < 2 {
            lints.push(warn("bad-wire", format!("导线 {} 少于两个锚点，已忽略", w.id)));
            continue;
        }
        dsu.union(key(w.points[0]), key(w.points[1]));
    }
    // 端点落在其它导线中间 → union（把 T 型接点接上）
    for (i, (a, b)) in segs.iter().enumerate() {
        for (j, (c, d)) in segs.iter().enumerate() {
            if i == j {
                continue;
            }
            for p in [a, b] {
                if on_segment(*p, *c, *d) {
                    dsu.union(key(*p), key(*c));
                }
            }
        }
    }

    // 2) 引脚 → 世界坐标；落在导线上也 union
    struct PinWorld<'a> {
        part: &'a Part,
        pin_id: &'a str,
        at: Pt,
    }
    let mut pins: Vec<PinWorld> = Vec::new();
    let mut nc_pins: Vec<(String, String)> = Vec::new(); // (part.id, pin.id) —— 故意不接
    let mut explicit: HashMap<(i64, i64), String> = HashMap::new();
    let mut ports = Ports::default();

    for part in &doc.parts {
        let Some(sym) = table.symbols.get(&part.symbol) else {
            lints.push(err("unknown-symbol", format!("{}：未知符号 {}", part.r#ref, part.symbol)));
            continue;
        };
        // 型号闭集
        if let Some(model) = &part.model {
            if !sym.models.iter().any(|m| m == model) {
                lints.push(err(
                    "model-not-allowed",
                    format!("{}：型号 {model} 不在该符号的闭集里（{}）", part.r#ref, sym.models.join("/")),
                ));
            }
        } else if !sym.models.is_empty() {
            lints.push(err("model-missing", format!("{}：没选型号（{} 之一）", part.r#ref, sym.models.join("/"))));
        }

        // 电位器的阻值范围：`1M`（本意 1 MΩ）在 SPICE 里是 1 mΩ，
        // 会让整个偏置网络被钉死，而且**导出不报错**（下游 Freedist 报告 P2）。
        if part.symbol == "potentiometer" {
            if let Some(raw) = &part.value {
                match panel_value_ohms(raw) {
                    Some(r) if r >= 1.0 && r <= 1e9 => {}
                    // 只看"以 m 结尾"的写法（`meg`/`mil` 不是），避免把 `0` / `0.5` 也当成笔误
                    Some(r) if looks_like_mega_typo(raw) && r > 0.0 => lints.push(warn(
                        "pot-value-milli",
                        format!(
                            "{}：电位器阻值 `{raw}` 在 SPICE 里是 {r} Ω（`M` = milli）；\
                             导出时已按 **meg** 处理。建议直接写 `{}meg`。",
                            part.r#ref,
                            raw.trim().trim_end_matches(&['M', 'm'][..])
                        ),
                    )),
                    Some(r) => lints.push(err(
                        "pot-value-range",
                        format!(
                            "{}：电位器阻值 `{raw}` = {r} Ω，超出合理范围（1 Ω … 1 GΩ）。",
                            part.r#ref
                        ),
                    )),
                    None => lints.push(err(
                        "pot-value-bad",
                        format!("{}：电位器阻值 `{raw}` 读不出数值", part.r#ref),
                    )),
                }
            }
        }

        for pin in &sym.pins {
            let at = to_world(pin.at, part);
            dsu.find(key(at)); // 落点入表
            pins.push(PinWorld { part, pin_id: &pin.id, at });
            if sym.category == "nc" {
                nc_pins.push((part.id.clone(), pin.id.clone()));
            }
            for (a, b) in &segs {
                if on_segment(at, *a, *b) {
                    dsu.union(key(at), key(*a));
                }
            }
        }

        if let Some(net_name) = &sym.net_name {
            let k = to_world(sym.pins[0].at, part);
            if let Some(prev) = explicit.insert(key(k), net_name.clone()) {
                if prev != *net_name {
                    lints.push(warn("net-name-conflict", format!("{}：网络名 {prev} 与 {net_name} 冲突", part.r#ref)));
                }
            }
        }
        if let Some(port) = &sym.port {
            let k = to_world(sym.pins[0].at, part);
            let name = sym.pins[0].id.clone();
            match port.as_str() {
                "in" => ports.r#in = Some(name.clone()),
                "out" => ports.out = Some(name.clone()),
                _ => {}
            }
            explicit.insert(key(k), name);
        }
    }

    // 3) 汇聚成网络
    let mut nets: BTreeMap<(i64, i64), Vec<&PinWorld>> = BTreeMap::new();
    for pw in &pins {
        nets.entry(dsu.find(key(pw.at))).or_default().push(pw);
    }

    // 显式名字按根索引
    let mut named: HashMap<(i64, i64), String> = HashMap::new();
    for (k, name) in explicit {
        let root = dsu.find(k);
        named.insert(root, name);
    }

    // 自动命名：按网络最小坐标排序
    let mut order: Vec<(i64, i64)> = nets.keys().copied().collect();
    order.sort();
    let mut counter = 0;
    let mut net_name: HashMap<(i64, i64), String> = HashMap::new();
    for root in order.iter().copied() {
        if let Some(n) = named.get(&root) {
            net_name.insert(root, n.clone());
        } else {
            counter += 1;
            net_name.insert(root, format!("n{counter}"));
        }
    }

    // 4) lint：悬空/单点/无地/无端口
    let mut dangling: Vec<Dangling> = Vec::new();
    for (root, members) in &nets {
        let name = net_name.get(root).cloned().unwrap_or_default();
        if members.len() == 1 {
            let pw = members[0];
            // `nc` 符号的引脚是"故意不接"，不算悬空
            let intentional = nc_pins.iter().any(|(pid, pin)| *pid == pw.part.id && pin == pw.pin_id);
            if intentional {
                continue;
            }
            dangling.push(Dangling {
                r#ref: pw.part.r#ref.clone(),
                pin: pw.pin_id.to_string(),
                at: pw.at,
            });
            lints.push(warn(
                "dangling-pin",
                format!("{} 的引脚 {} 悬空（网络 {name} 只连了自己）", pw.part.r#ref, pw.pin_id),
            ));
        }
    }
    if !net_name.values().any(|n| n == "0") {
        lints.push(err("no-ground", "没有接地符号（网表里没有 0 节点）"));
    }
    if ports.r#in.is_none() || ports.out.is_none() {
        lints.push(warn("no-port", "缺少 IN 或 OUT 端口符号 → 无法生成 Circuit"));
    }

    // 5) 输出
    let mut cir = String::new();
    cir.push_str(&format!("* {} —— 由 rustomp-circuit-designer 生成\n", if doc.name.is_empty() { "未命名电路" } else { &doc.name }));
    if let (Some(i), Some(o)) = (&ports.r#in, &ports.out) {
        cir.push_str(&format!("* @rustomp in={i} out={o}\n"));
    }

    // 电位器 directive（值里的单位直接写进 max=）
    let mut parts_sorted: Vec<&Part> = doc.parts.iter().collect();
    parts_sorted.sort_by_key(|p| ref_key(&p.r#ref));
    for p in &parts_sorted {
        let Some(sym) = table.symbols.get(&p.symbol) else { continue };
        if p.symbol == "potentiometer" {
            let field = p.alias.clone().unwrap_or_else(|| p.r#ref.to_lowercase());
            let max = p.value.clone().unwrap_or_else(|| "500k".into());
            cir.push_str(&format!("* @rustomp param R{}A {field} pot max={max}\n", p.r#ref));
            cir.push_str(&format!("* @rustomp param R{}B {field} pot max={max} invert\n", p.r#ref));
        }
        let _ = sym;
    }
    cir.push('\n');

    for p in &parts_sorted {
        let Some(sym) = table.symbols.get(&p.symbol) else { continue };
        let net_of = |pin_id: &str| -> String {
            pins.iter()
                .find(|pw| pw.part.id == p.id && pw.pin_id == pin_id)
                .map(|pw| net_name.get(&dsu_root(&dsu, key(pw.at))).cloned().unwrap_or_else(|| "?".into()))
                .unwrap_or_else(|| "?".into())
        };
        let mut nodes: Vec<String> = sym.spice.pin_order.iter().map(|id| net_of(id)).collect();
        // MOS：SPICE 需要 4 个节点 d g s b；rustomp 的 Nmos 衬底接源极（docs/05 §4）
        if p.symbol == "mosfet-n" && nodes.len() == 3 {
            nodes.push(nodes[2].clone());
        }

        if p.symbol == "potentiometer" && nodes.len() == 3 {
            // 展开成两段电阻：A = 1–2，B = 2–3；**按 50% 抽头**写标称值（docs/05 §5）
            let max = p.value.clone().unwrap_or_else(|| "500k".into());
            let half = half_value(&max);
            cir.push_str(&format!("R{}A {} {} {half}\n", p.r#ref, nodes[0], nodes[1]));
            cir.push_str(&format!("R{}B {} {} {half}\n", p.r#ref, nodes[1], nodes[2]));
            continue;
        }
        // 电感：`L<ref> a b <value>`（绕线电阻请另外画一个电阻 —— ngspice 的 L 没有 DCR 参数）
        if p.symbol == "inductor" && nodes.len() == 2 {
            let v = p.value.clone().unwrap_or_else(|| "10m".into());
            cir.push_str(&format!("{} {} {} {v}\n", p.r#ref, nodes[0], nodes[1]));
            continue;
        }

        // ---- 变压器：展开成 4 个绕组 + 6 条耦合（docs/05 §5.1）----
        //
        // 6 脚 = 初级(上/抽头/下) + 次级(上/抽头/下)，抽头像电位器一样按比例分：
        //   L_上段 = a²·L_total，L_下段 = (1−a)²·L_total（a 从**打点端**量起）
        // 同一绕组的两个半段用 k=0.9999 耦合（k=1 会让电感矩阵奇异），
        // 初/次级之间用用户给的 k。
        if p.symbol == "transformer" && nodes.len() == 6 {
            let raw_l = p.value.clone().unwrap_or_else(|| "1".into());
            let Some(lp) = panel_value_ohms(&raw_l) else {
                lints.push(err(
                    "inductor-value",
                    format!("{}：读不出初级电感 `{raw_l}`（单位 H，可写 `1`/`500m`）", p.r#ref),
                ));
                continue;
            };
            let ratio = p.ratio.unwrap_or(2.0);
            let k = p.k.unwrap_or(0.999);
            let tap_p = p.tap_p.unwrap_or(0.5);
            let tap_s = p.tap_s.unwrap_or(0.5);
            let mut bad = false;
            if !(lp > 0.0 && lp.is_finite()) {
                lints.push(err(
                    "transformer-l",
                    format!("{}：初级电感必须 > 0（收到 `{raw_l}`）", p.r#ref),
                ));
                bad = true;
            }
            if !(ratio > 0.0 && ratio.is_finite()) {
                lints.push(err(
                    "transformer-ratio",
                    format!("{}：匝比必须 > 0（收到 {ratio}）", p.r#ref),
                ));
                bad = true;
            }
            if !(k > 0.0 && k < 1.0) {
                lints.push(err(
                    "transformer-k",
                    format!("{}：耦合系数必须 0 < k < 1（收到 {k}）；紧耦合请拆励磁电感 + 漏感", p.r#ref),
                ));
                bad = true;
            }
            for (what, a) in [("初级", tap_p), ("次级", tap_s)] {
                if !(a > 0.0 && a < 1.0) {
                    lints.push(err(
                        "transformer-tap",
                        format!(
                            "{}：{what}抽头位置必须 0 < a < 1（收到 {a}）—— 贴到端点会得到 0 H 的绕组",
                            p.r#ref
                        ),
                    ));
                    bad = true;
                }
            }
            if bad {
                continue;
            }
            let ls = lp / (ratio * ratio);
            let (lpa, lpb) = (lp * tap_p * tap_p, lp * (1.0 - tap_p) * (1.0 - tap_p));
            let (lsa, lsb) = (ls * tap_s * tap_s, ls * (1.0 - tap_s) * (1.0 - tap_s));
            let (a, at, b, c, ct, d) = (&nodes[0], &nodes[1], &nodes[2], &nodes[3], &nodes[4], &nodes[5]);
            let n = &p.r#ref; // 例如 T1 → 元件名 LT1A / KT1A
            cir.push_str(&format!(
                "* 变压器 {n}：初级 {}·{:.0}%，次级 {}·{:.0}%，匝比 {ratio}:1，k={k}\n",
                p.value.clone().unwrap_or_else(|| "1".into()),
                tap_p * 100.0,
                fmt_num(ls),
                tap_s * 100.0
            ));
            cir.push_str(&format!("L{n}A {a} {at} {}\n", fmt_num(lpa)));
            cir.push_str(&format!("L{n}B {at} {b} {}\n", fmt_num(lpb)));
            cir.push_str(&format!("L{n}C {c} {ct} {}\n", fmt_num(lsa)));
            cir.push_str(&format!("L{n}D {ct} {d} {}\n", fmt_num(lsb)));
            // 6 条耦合：同绕组半段用 0.9999，跨绕组用用户 k
            let pairs = [
                ("A", "B", 0.9999_f64),
                ("C", "D", 0.9999),
                ("A", "C", k),
                ("A", "D", k),
                ("B", "C", k),
                ("B", "D", k),
            ];
            for (i, (x, y, kk)) in pairs.iter().enumerate() {
                cir.push_str(&format!(
                    "K{n}{} L{n}{x} L{n}{y} {kk}\n",
                    (b'A' + i as u8) as char
                ));
            }
            continue;
        }

        // 电源符号（voltage-source）：DC 值
        if p.symbol == "voltage-source" {
            let v = p.value.clone().unwrap_or_else(|| "9".into());
            cir.push_str(&format!("{} {} {} DC {v}\n", p.r#ref, nodes[0], nodes[1]));
            continue;
        }
        // 网络标签类符号不产生元件
        if sym.spice.prefix.is_empty() {
            continue;
        }
        let tail = if let Some(m) = &p.model {
            format!(" {m}")
        } else if let Some(v) = &p.value {
            format!(" {v}")
        } else {
            String::new()
        };
        // SPICE 里子电路实例的名字必须以 X 开头（ngspice 靠首字母区分器件类型）。
        // 参考编号是 U1，所以发 `XU1 …`；电阻/电容/管子仍用 ref 本身。
        let elem = if sym.spice.prefix == "X" && !p.r#ref.starts_with('X') {
            format!("X{}", p.r#ref)
        } else {
            p.r#ref.clone()
        };
        cir.push_str(&format!("{} {}{}\n", elem, nodes.join(" "), tail));
    }
    cir.push_str(".end\n");

    let net_infos = order
        .iter()
        .map(|root| NetInfo {
            name: net_name.get(root).cloned().unwrap_or_default(),
            pins: nets
                .get(root)
                .map(|v| v.iter().map(|pw| format!("{}.{}", pw.part.r#ref, pw.pin_id)).collect())
                .unwrap_or_default(),
        })
        .collect();

    Generated { cir, lints, ports, nets: net_infos, dangling }
}

/// 电位器标称值：按 **50% 抽头** 展开成两段（`RPxA = max·t`、`RPxB = max·(1−t)`）。
/// 抽头位置由 `* @rustomp param` 指令在 DSP 侧参数化，网表里写**标称值**即可（docs/05 §5）。
fn half_value(value: &str) -> String {
    let t = value.trim();
    let split = t.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E'));
    let (num, unit) = match split {
        Some(i) => t.split_at(i),
        None => (t, ""),
    };
    // `M` 在 SPICE 里是 **milli**，但电位器面板上写 `1M` 显然是 1 MΩ。
    // 电位器不存在 mΩ 量级的合法值，所以这里**只对电位器**把 M 规范成 meg。
    let unit = if unit.eq_ignore_ascii_case("m") { "meg" } else { unit };
    match num.parse::<f64>() {
        Ok(v) => {
            let h = v / 2.0;
            // 去掉多余小数 0（250k 而不是 250.000k）
            let txt = format!("{h:.6}");
            let txt = txt.trim_end_matches('0').trim_end_matches('.').to_string();
            format!("{txt}{unit}")
        }
        Err(_) => value.to_string(),
    }
}

/// 面板上的阻值文本 → 欧姆（与 SPICE 后缀一致；`M` 按 milli 解释，与 SPICE 相同）。
///
/// 刻意**不在这里**把 M 当 mega：那会让"1M 到底是 milli 还是 mega"变成两套规则。
/// 规范化的地方只有一处 —— `half_value()`（导出网表时对电位器生效），
/// 另外 `pot_value_lint()` 会在导出前提示用户改成 `meg`。
/// 数值 → SPICE 文本：最多 9 位小数、去尾零；太大/太小用科学计数法。
///
/// 用于变压器展开出来的电感值（`0.0625` / `2.5e-1` 都能被 ngspice 读），
/// 保持**确定性**（同一份设计永远生成同样的字节）。
fn fmt_num(v: f64) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    if v != 0.0 && (v.abs() < 1e-6 || v.abs() >= 1e7) {
        return format!("{v:e}");
    }
    let s = format!("{v:.9}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-0" {
        "0".into()
    } else {
        s.to_string()
    }
}

fn panel_value_ohms(value: &str) -> Option<f64> {
    let t = value.trim().to_ascii_lowercase();
    let split = t.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e'));
    let (num, unit) = match split {
        Some(i) => t.split_at(i),
        None => (t.as_str(), ""),
    };
    let v: f64 = num.parse().ok()?;
    let mult = if unit.starts_with("meg") {
        1e6
    } else if unit.starts_with("mil") {
        25.4e-6
    } else {
        match unit.chars().next() {
            Some('t') => 1e12,
            Some('g') => 1e9,
            Some('k') => 1e3,
            Some('m') => 1e-3,
            Some('u') => 1e-6,
            Some('n') => 1e-9,
            Some('p') => 1e-12,
            _ => 1.0,
        }
    };
    Some(v * mult)
}

/// `1M` / `0.5m` 这种"以 m 结尾"的写法（`meg` / `mil` 不是）。
fn looks_like_mega_typo(raw: &str) -> bool {
    raw.trim().to_ascii_lowercase().ends_with('m')
}

fn dsu_root(dsu: &Dsu, k: (i64, i64)) -> (i64, i64) {
    let mut cur = k;
    while let Some(&p) = dsu.parent.get(&cur) {
        if p == cur {
            break;
        }
        cur = p;
    }
    cur
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> SymbolTable {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../symbols/symbols.json"))
            .expect("读不到 symbols/symbols.json（先跑 tools/gen-symbols.py）");
        serde_json::from_str(&text).expect("symbols.json 解析失败")
    }

    fn part(id: &str, r: &str, symbol: &str, x: f64, y: f64, rot: i32) -> Part {
        Part {
            id: id.into(),
            r#ref: r.into(),
            symbol: symbol.into(),
            model: None,
            value: None,
            alias: None,
            at: Pt { x, y },
            rot,
            mirror: "none".into(),
            ratio: None,
            k: None,
            tap_p: None,
            tap_s: None,
        }
    }

    /// 一张最小可用图：IN — R1 — R2 — OUT，R1 左端接地
    fn divider() -> Document {
        let mut r1 = part("p1", "R1", "resistor", 0.0, 0.0, 0);
        r1.value = Some("10k".into());
        let mut r2 = part("p2", "R2", "resistor", 40.0, 0.0, 0);
        r2.value = Some("10k".into());
        Document {
            name: "分压".into(),
            parts: vec![
                part("p3", "GND1", "earth", -12.5, 12.5, 0),
                // node-in 是 OUT 的水平镜像：引脚在符号右侧（local +12.5），所以 at=(0,0) 时落在 (12.5,0)
                part("p4", "IN1", "node-in", 0.0, 0.0, 0),
                part("p5", "OUT1", "node-out", 65.0, 0.0, 0), // (52.5,0) = R2.2
                r1,
                r2,
            ],
            wires: vec![Wire {
                id: "w1".into(),
                points: vec![Pt { x: 12.5, y: 0.0 }, Pt { x: 27.5, y: 0.0 }],
                net: None,
            }],
        }
    }

    #[test]
    fn golden_divider() {
        let g = generate(&divider(), &table());
        let want = "\
* 分压 —— 由 rustomp-circuit-designer 生成
* @rustomp in=IN out=OUT

R1 0 IN 10k
R2 IN OUT 10k
.end
";
        assert_eq!(g.cir, want, "\n实际：\n{}", g.cir);
        assert!(g.lints.is_empty(), "不该有 lint：{:?}", g.lints);
        assert_eq!(g.ports.r#in.as_deref(), Some("IN"));
        assert_eq!(g.ports.out.as_deref(), Some("OUT"));
    }

    #[test]
    fn 确定性_同一张图两次生成逐字节相同() {
        let d = divider();
        let t = table();
        assert_eq!(generate(&d, &t).cir, generate(&d, &t).cir);
    }

    #[test]
    fn lint_无接地() {
        let mut d = divider();
        d.parts.retain(|p| p.symbol != "earth");
        let g = generate(&d, &table());
        assert!(g.lints.iter().any(|l| l.code == "no-ground" && l.level == Level::Error));
    }

    #[test]
    fn lint_型号不在闭集() {
        let mut d = divider();
        let mut diode = part("p9", "D1", "diode", 0.0, 20.0, 0);
        diode.model = Some("1N9999".into());
        d.parts.push(diode);
        let g = generate(&d, &table());
        assert!(g.lints.iter().any(|l| l.code == "model-not-allowed"));
    }

    #[test]
    fn lint_悬空引脚() {
        let mut d = divider();
        d.parts.push(part("p9", "R9", "resistor", 100.0, 100.0, 0));
        let g = generate(&d, &table());
        assert!(g.lints.iter().any(|l| l.code == "dangling-pin"));
    }

    #[test]
    fn lint_重复参考编号() {
        let mut d = divider();
        let mut dup = part("p9", "R1", "resistor", 0.0, 50.0, 0);
        dup.value = Some("1k".into());
        d.parts.push(dup);
        let g = generate(&d, &table());
        assert!(g.lints.iter().any(|l| l.code == "dup-ref" && l.level == Level::Error));
    }

    #[test]
    fn 电位器展开成两段电阻并生成_param_指令() {
        let mut pot = part("p1", "P1", "potentiometer", 0.0, 0.0, 0);
        pot.value = Some("500k".into());
        pot.alias = Some("gain".into());
        let d = Document {
            name: "pot".into(),
            parts: vec![pot, part("p2", "GND1", "earth", -12.5, 12.5, 0), part("p3", "IN1", "node-in", 0.0, 0.0, 0)],
            wires: vec![],
        };
        let g = generate(&d, &table());
        assert!(g.cir.contains("* @rustomp param RP1A gain pot max=500k"));
        assert!(g.cir.contains("* @rustomp param RP1B gain pot max=500k invert"));
        // 引脚 1（左）= 地、2（抽头）= 自动命名 n1、3（右）= IN
        // 50% 抽头：两段标称值都是 max/2（param 指令里保留 max=500k）
        assert!(g.cir.contains("RP1A 0 n1 250k"), "实际：\n{}", g.cir);
        assert!(g.cir.contains("RP1B n1 IN 250k"), "实际：\n{}", g.cir);
    }

    #[test]
    fn mosfet_衬底接源极共四个节点() {
        let mut m = part("p1", "M1", "mosfet-n", 0.0, 0.0, 0);
        m.model = Some("2N7000".into());
        let d = Document {
            name: "mos".into(),
            parts: vec![m, part("p2", "GND1", "earth", -12.5, 12.5, 0), part("p3", "IN1", "node-in", 25.0, 0.0, 0)],
            wires: vec![],
        };
        let g = generate(&d, &table());
        let line = g.cir.lines().find(|l| l.starts_with("M1 ")).expect("没有 M1 行");
        let nodes: Vec<&str> = line.split_whitespace().collect();
        assert_eq!(nodes.len(), 6, "M1 <d> <g> <s> <b> <model>：{line}");
        assert_eq!(nodes[3], nodes[4], "衬底应等于源极：{line}");
    }

    /// P2：`1M` 在 SPICE 里是 1 mΩ。电位器值写 `1M` 时：
    /// ① 导出网表把单位规范成 `meg`（面板上写 1M 显然是 1 MΩ）；
    /// ② 同时给一条 `pot-value-range` 的 error，让用户知道该写 `1meg`。
    #[test]
    fn 电位器的一兆欧写法被规范化并报错() {
        let mut pot = part("p1", "P1", "potentiometer", 0.0, 0.0, 0);
        pot.value = Some("1M".into());
        let d = Document {
            name: "pot".into(),
            parts: vec![pot, part("p2", "GND1", "earth", -12.5, 12.5, 0), part("p3", "IN1", "node-in", 25.0, 0.0, 0)],
            wires: vec![],
        };
        let g = generate(&d, &table());
        // 规范化：写成 0.5meg 而不是 0.5M
        assert!(g.cir.contains("0.5meg"), "实际：\n{}", g.cir);
        assert!(!g.cir.contains("0.5M"), "不该再把 M 当 mega 之外的单位：\n{}", g.cir);
        // 报错：提示用户改成 meg
        let lint = g
            .lints
            .iter()
            .find(|l| l.code == "pot-value-milli")
            .expect("应有 pot-value-milli 提示");
        assert!(lint.msg.contains("1meg"), "提示应给出正确写法：{}", lint.msg);
    }

    #[test]
    fn 电位器的正常阻值不报错() {
        let mut pot = part("p1", "P1", "potentiometer", 0.0, 0.0, 0);
        pot.value = Some("500k".into());
        let d = Document {
            name: "pot".into(),
            parts: vec![pot, part("p2", "GND1", "earth", -12.5, 12.5, 0), part("p3", "IN1", "node-in", 25.0, 0.0, 0)],
            wires: vec![],
        };
        let g = generate(&d, &table());
        assert!(
            !g.lints.iter().any(|l| l.code == "pot-value-range"),
            "500k 是合法电位器值，不该报错：{:?}",
            g.lints
        );
        assert!(g.cir.contains("250k"), "实际：\n{}", g.cir);
    }

    /// 变压器：6 脚（初/次级各带中心抽头）→ 4 个绕组 + 6 条耦合。
    #[test]
    fn 变压器展开成四个绕组和六条耦合() {
        let mut t = part("p1", "T1", "transformer", 0.0, 0.0, 0);
        t.value = Some("1".into()); // 初级 1 H
        t.ratio = Some(2.0); // 匝比 2:1 → 次级 0.25 H
        let d = Document {
            name: "tr".into(),
            parts: vec![
                t,
                part("p2", "GND1", "earth", -12.5, 12.5, 0),
                part("p3", "IN1", "node-in", 0.0, 0.0, 0),
                part("p4", "OUT1", "node-out", 20.0, 0.0, 0),
            ],
            wires: vec![],
        };
        let g = generate(&d, &table());
        assert!(
            g.cir.contains("* @rustomp in=IN out=OUT"),
            "端口指令要照常生成：\n{}",
            g.cir
        );
        // 抽头默认 50%：初级两段各 0.25 H，次级两段各 0.0625 H
        let l_lines: Vec<&str> = g.cir.lines().filter(|l| l.starts_with("LT1")).collect();
        assert_eq!(l_lines.len(), 4, "应有 4 个绕组：\n{}", g.cir);
        assert!(g.cir.contains("0.25"), "初级半段应是 0.25 H：\n{}", g.cir);
        assert!(g.cir.contains("0.0625"), "次级半段应是 0.0625 H：\n{}", g.cir);
        println!("\n----- 生成的网表 -----\n{}-----", g.cir);
        // 6 条 K：同绕组 0.9999 ×2 + 跨绕组 k=0.999 ×4
        let k_lines: Vec<&str> = g.cir.lines().filter(|l| l.starts_with("KT1")).collect();
        assert_eq!(k_lines.len(), 6, "应有 6 条耦合：\n{}", g.cir);
        assert_eq!(k_lines.iter().filter(|l| l.ends_with("0.9999")).count(), 2);
        assert_eq!(k_lines.iter().filter(|l| l.ends_with("0.999")).count(), 4);
        // 不应有未支持的元件提示
        assert!(
            !g.lints.iter().any(|l| matches!(l.level, Level::Error)),
            "不该有 error：{:?}",
            g.lints
        );
    }

    /// 抽头位置可滑：a=0.3 时上段 0.09·L、下段 0.49·L。
    #[test]
    fn 变压器抽头位置影响分段电感() {
        let mut t = part("p1", "T1", "transformer", 0.0, 0.0, 0);
        t.value = Some("1".into());
        t.ratio = Some(1.0); // 1:1 → 次级也是 1 H
        t.tap_p = Some(0.3);
        t.tap_s = Some(0.7);
        let d = Document {
            name: "tr".into(),
            parts: vec![t, part("p2", "GND1", "earth", -12.5, 12.5, 0)],
            wires: vec![],
        };
        let g = generate(&d, &table());
        assert!(g.cir.contains("LT1A"), "{}", g.cir);
        // 初级：0.09 / 0.49；次级：0.49 / 0.09（1:1，抽头位置反过来）
        let lines: Vec<&str> = g.cir.lines().filter(|l| l.starts_with("LT1")).collect();
        assert!(lines[0].ends_with("0.09"), "初级上段：{}", lines[0]);
        assert!(lines[1].ends_with("0.49"), "初级下段：{}", lines[1]);
        assert!(lines[2].ends_with("0.49"), "次级上段：{}", lines[2]);
        assert!(lines[3].ends_with("0.09"), "次级下段：{}", lines[3]);
    }

    /// 参数越界必须报错（k=1 / 抽头贴端点 / 匝比 0）。
    #[test]
    fn 变压器参数越界报错() {
        for (ratio, k, tap) in [(2.0, 1.0, 0.5), (2.0, 0.999, 1.0), (0.0, 0.999, 0.5)] {
            let mut t = part("p1", "T1", "transformer", 0.0, 0.0, 0);
            t.value = Some("1".into());
            t.ratio = Some(ratio);
            t.k = Some(k);
            t.tap_p = Some(tap);
            let d = Document {
                name: "tr".into(),
                parts: vec![t, part("p2", "GND1", "earth", -12.5, 12.5, 0)],
                wires: vec![],
            };
            let g = generate(&d, &table());
            assert!(
                g.lints.iter().any(|l| matches!(l.level, Level::Error)),
                "ratio={ratio} k={k} tap={tap} 应该报错"
            );
        }
    }

    /// 三极管：`X<ref> A G K <型号>`（SPICE 子电路实例，型号来自 `symbols.json` 的 models 列表）。
    #[test]
    fn 三极管生成子电路实例() {
        let mut v1 = part("p1", "X1", "triode", 0.0, 0.0, 0);
        v1.model = Some("12AX7".into());
        let d = Document {
            name: "tube".into(),
            parts: vec![
                v1,
                part("p2", "GND1", "earth", -12.5, 12.5, 0),
                part("p3", "IN1", "node-in", 0.0, 0.0, 0),
            ],
            wires: vec![],
        };
        let g = generate(&d, &table());
        let line = g
            .cir
            .lines()
            .find(|l| l.starts_with("X1 "))
            .unwrap_or_else(|| panic!("没有 X1 行：\n{}", g.cir));
        let cols: Vec<&str> = line.split_whitespace().collect();
        assert_eq!(cols.len(), 5, "应为 `X1 A G K 12AX7`：{line}");
        assert_eq!(cols[4], "12AX7");
        assert!(
            !g.lints.iter().any(|l| matches!(l.level, Level::Error)),
            "不该有 error：{:?}",
            g.lints
        );
    }

    /// 三极管没选型号 → 必须报错（不能生成一个没有型号的 X 实例）。
    #[test]
    fn 三极管缺型号报错() {
        let d = Document {
            name: "tube".into(),
            parts: vec![
                part("p1", "X1", "triode", 0.0, 0.0, 0),
                part("p2", "GND1", "earth", -12.5, 12.5, 0),
                part("p3", "IN1", "node-in", 0.0, 0.0, 0),
            ],
            wires: vec![],
        };
        let g = generate(&d, &table());
        assert!(
            g.lints
                .iter()
                .any(|l| matches!(l.level, Level::Error) && l.code == "model-missing"),
            "缺型号应报 model-missing：{:?}",
            g.lints
        );
    }

    #[test]
    fn 电感生成一行网表() {
        let mut l = part("p1", "L1", "inductor", 0.0, 0.0, 0);
        l.value = Some("10m".into());
        let d = Document {
            name: "l".into(),
            parts: vec![
                l,
                part("p2", "GND1", "earth", -12.5, 12.5, 0),
                part("p3", "IN1", "node-in", 12.5, 0.0, 0),
            ],
            wires: vec![],
        };
        let g = generate(&d, &table());
        assert!(
            g.cir.lines().any(|line| line.starts_with("L1 ") && line.ends_with("10m")),
            "应有 `L1 <a> <b> 10m`：\n{}",
            g.cir
        );
    }

    #[test]
    fn 旋转与镜像后的引脚位置() {
        let t = table();
        let sym = &t.symbols["resistor"];
        let mut p = part("p1", "R1", "resistor", 100.0, 0.0, 90);
        // 旋转 90°：(x,y) → (−y, x) ⇒ (−12.5,0) 变成 (0,−12.5)
        let a = to_world(sym.pins[0].at, &p);
        assert!((a.x - 100.0).abs() < 1e-9 && (a.y + 12.5).abs() < 1e-9, "{a:?}");
        // 左右镜像：x 取反 ⇒ (0,12.5)
        p.mirror = "x".into();
        let b = to_world(sym.pins[0].at, &p);
        assert!((b.x - 100.0).abs() < 1e-9 && (b.y - 12.5).abs() < 1e-9, "{b:?}");
    }
}
