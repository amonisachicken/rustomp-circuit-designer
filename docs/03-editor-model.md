# 编辑模型与交互

> 目标：**画一张图，就能直接得到可仿真的网表**。
> 所有几何约定都跟符号资产对齐（1 单位 = 1 mm，2.5 mm 栅格）。

---

## 1. 文档模型（前后端共用）

```ts
// frontend/src/types/domain.ts  ↔  backend/src/domain.rs

interface Document {
  version: 1;
  sheet: Sheet;               // 目前只做单页；多页留字段
  parts: PlacedPart[];
  wires: Wire[];
  texts: TextItem[];          // 注释、标题栏补充
  meta: { name: string; author?: string; notes?: string };
}

/** （D-007）本项目不做开关，所以没有 Switch / present 字段 */
interface Switch {
  id: string;
  ref: string;                // SW1
  labels: { zh: string; en?: string };   // "削波模式"
  states: { id: string; label: string }[];  // [{id:"A",label:"非对称"},{id:"B",label:"对称"}]
  /** 每掷的触点对（用于画图与 lint，不参与网表） */
  throws: string[][];         // [[ "1","2" ], [ "2","3" ]]
}

interface Sheet {
  paper: "A4" | "A3" | "A2";
  unit: "mm";                 // 固定；所有坐标都是 mm
  grid: 2.5;                  // 固定；可关吸附但坐标仍是 mm
}

interface PlacedPart {
  id: string;                 // 内部唯一 id（uuid）
  ref: string;                // 参考编号 R1 / C3 / Q2 / U1 / P1 / SW1
  symbol: string;             // symbols.json 的 key（"resistor"…）
  model?: string;             // 器件型号（"1N4148"…），电阻/电容为空
  value?: string;             // "4.7k" / "47n" / "9"
  at: { x: number; y: number };  // 符号原点在画布上的位置（mm）
  rot: 0 | 90 | 180 | 270;
  mirror: "none" | "x" | "y";
  pins: Record<string, Net>;  // ← 可选：仅"命名网络"用；默认空，靠导线推
  fields?: { showValue: boolean; showRef: boolean; showModel: boolean };
}

interface Wire {
  id: string;
  points: { x: number; y: number }[];  // 折点，≥2；坐标吸附到栅格
  net?: string;                        // 显式网络名（可选）
}

type Net = string;            // 网络名（"n$1" 自动 / "IN" 手动）
```

**为什么导线只存折点**：原理图的连通性 = 引脚端点与导线端点的**重合**，
加上导线的折点落在另一根导线上（T 型连接）。这与 LTspice/GB 制图习惯一致，
也让"并查集求网络"变成一次几何遍历（见 §4）。

---

## 2. 坐标与吸附

| 规则 | 值 |
|---|---|
| 文档单位 | **mm**（与符号 SVG 的 `viewBox` 一致，1 单位 = 1 mm） |
| 栅格 | **2.5 mm**（与符号的引脚跨距一致：两端元件 25 mm = 10 格） |
| 吸附 | 元件原点、导线折点、引脚落点都吸附到 2.5 的整数倍 |
| 缩放 | 视图缩放不改文档坐标（只改变换矩阵），导出永不缩放 |
| 旋转 | 围绕**符号原点**旋转 90°；`mirror` 沿 x/y 轴翻转 |
| 引脚坐标 | `pin_world = rotate_mirror(pin_local) + at` |

> 符号素材"只 translate 不 scale"是硬约束（见资产手册 §4.3）：
> 一旦缩放，引脚就不再落在栅格上。

---

## 3. 交互（模态编辑 —— 以 `prompt.md` 为准，见 D-009）

**主界面不提供拖放式元件库。** 所有编辑都在"模式"里完成，`esc` 永远回到查看模式。

| 键 | 模式 | 行为 |
## 3.5 开关：本项目不提供（D-007）

图纸上**没有开关符号**，网表导出**永远是单份** `.cir`。

理由：真实插件的开关是**子电路切换**（插件层持有多个完整 `Circuit` + 交叉淡化），
不是电路拓扑切换。把它画进原理图只会让人以为"这里会被导出成一个元件"。

需要标注"这台机器有踩钉/拨杆"时，用**文字注释**表达，不画电气符号。

---

## 4. 连通性：并查集

```text
1) 建图：每个"引脚端点"、"导线折点"、"导线端点"是一个点
2) union：
   - 同一根导线上的所有点
   - 引脚端点与其所在位置重合的导线点（距离 ≤ 0.01 mm）
   - 导线端点与另一根导线的任意点重合（T 型连接）
3) 每个连通分量 = 一个网络
4) 命名：
   - 有显式网络名（端口符号 / 导线 net 字段）→ 用它（重名即同一网络，短路检查）
   - 否则自动命名 n1 / n2 …（按最小坐标排序，保证确定性）
5) 接地符号（earth）→ 网络名固定为 "0"
```


**为什么不"编辑时实时合并节点"**：
面包板那样边拖边并会引入大量中间状态，撤销重做会变得很脏。
原理图更适合"**几何即真相**，网表在导出时算"——这也方便"画到一半先看看网表"。

---

## 5. 参考编号与自动命名

| 类型 | 前缀 | 允许的型号（闭集，来自 rustomp 器件库） |
|---|---|---|
| 电阻 | `R` | —（值必填） |
| 电容 | `C` | —（值必填） |
| 电位器 | `P` | —（总阻值必填） |
| 二极管 | `D` | `1N4148` `1N34A` `1N4007` `1N5817` |
| LED | `D` | `LedRed` `LedGreen` `LedBLUE` |
| BJT | `Q` | `BC549C` `BC559C` `AC127` `AC128` |
| JFET | `J` | `J201` |
| MOSFET | `M` | `2N7000` |
| 运放 | `U` | `OP07A` |
| 电源 | `V` | — |
| 开关 | `SW` | —（`docs/06` D1 补符号后启用） |

**型号下拉框来自 `symbols.json` 的 `models` 字段**（见 `docs/04`），不是自由文本 ——
这从源头保证了"生成器不会因为型号拼错而在导入时报错"。

---

## 6. 撤销/重做

命令式（与 breadspice 一致）：

```ts
type Command =
  | { kind: "addPart"; part: PlacedPart }
  | { kind: "movePart"; id: string; from: XY; to: XY }
  | { kind: "setField"; id: string; field: keyof PlacedPart; from: unknown; to: unknown }
  | { kind: "addWire"; wire: Wire }
  | { kind: "moveWirePoint"; id: string; index: number; from: XY; to: XY }
  | { kind: "delete"; parts: string[]; wires: string[] }
  | { kind: "batch"; commands: Command[] };   // 例如"拖动 3 个元件"
```

- 每个命令实现 `apply()` / `revert()`
- 连续拖拽**合并成一条**（用拖拽开始时的快照）
- 属性面板的输入做 300 ms 合并
- 文档变更后标脏 → 自动持久化（localStorage）+ 提示保存 `.design.json`

---

## 7. 文件格式

| 文件 | 内容 | 用途 |
|---|---|---|
| `*.design.json` | `Document`（§1） | **编辑器的原生格式**，可版本化、可 diff |
| `<name>.cir` | SPICE 网表 + `* @rustomp` 指令（**单份**，D-007） | 交给 `rustomp-import`；也可被 ngspice 直接仿真 |
| `<name>.png` | 预览截图（D-008） | 存档 / 发给别人 |
| `*.svg` | 图纸导出（栅格 + 符号 + 标注） | 打印/分享 |
| `*.netlist.json` | 网表的结构化形式（元件/网络/端口） | 调试、其它工具消费 |

> 四种产物都由**同一份 `Document`** 导出，避免"图、网表、代码"三份真相。
