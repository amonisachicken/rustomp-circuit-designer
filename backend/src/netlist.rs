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
            cir.push_str(&format!("* @rustomp param {}A {field} pot max={max}\n", p.r#ref));
            cir.push_str(&format!("* @rustomp param {}B {field} pot max={max} invert\n", p.r#ref));
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
            // 展开成两段电阻：A = 1–2，B = 2–3（docs/05 §5）
            let max = p.value.clone().unwrap_or_else(|| "500k".into());
            cir.push_str(&format!("R{}A {} {} {max}\n", p.r#ref, nodes[0], nodes[1]));
            cir.push_str(&format!("R{}B {} {} {max}\n", p.r#ref, nodes[1], nodes[2]));
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
                part("p4", "IN1", "node-in", 25.0, 0.0, 0), // 引脚世界坐标 (12.5,0) = R1.2
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
            parts: vec![pot, part("p2", "GND1", "earth", -12.5, 12.5, 0), part("p3", "IN1", "node-in", 25.0, 0.0, 0)],
            wires: vec![],
        };
        let g = generate(&d, &table());
        assert!(g.cir.contains("* @rustomp param P1A gain pot max=500k"));
        assert!(g.cir.contains("* @rustomp param P1B gain pot max=500k invert"));
        // 引脚 1（左）= 地、2（抽头）= 自动命名 n1、3（右）= IN
        assert!(g.cir.contains("RP1A 0 n1 500k"), "实际：\n{}", g.cir);
        assert!(g.cir.contains("RP1B n1 IN 500k"), "实际：\n{}", g.cir);
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
