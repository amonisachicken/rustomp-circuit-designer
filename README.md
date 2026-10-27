# rustomp-circuit-designer

**电路原理图设计器**（画图 → 网表），是 [rustomp](https://github.com/amonisachicken/rustomp)
生态里"上游"的一环。

```text
 本设计器                     rustomp 框架                     插件
 ─────────                   ───────────────                  ──────
 画原理图
   │ 输出：SPICE 网表 + `* @rustomp` 指令
   ▼
 rustomp-import --mna ──► 生成的 Rust 电路（Netlist + Params + impl Circuit）
                              │
                              ▼
                          rustomp-dsp（MNA / 器件库 / 实时路径）
                              │
                              ▼
                          Engine + rustomp-gui + nih-plug → AU/VST3/CLAP
```

---

## 现状（2026-10-25）

**D0 进行中**：先有资产与契约，再写编辑器 —— 这两件事定错了，后面所有东西都要返工。
（需求以 `prompt.md` 为准；与旧文档冲突处已在 `docs/00` 的 D-007…D-010 记录取舍。）

已经能跑：

```bash
./tools/gen-symbols.py            # 符号 → symbols/symbols.json（含与 kit PINS 表的交叉校验）
cd frontend && npm install && npm run dev    # 画布 + 模态编辑（r/c/w/q/m/空格/d + esc）
cd backend && cargo run           # 后端（designer.ping / designer.symbols）
```

| 项 | 状态 |
|---|---|
| **关键决策**（架构/坐标/格式/模态交互/**不做开关**/预览=截图） | ✅ `docs/00-decisions.md`（D-001…D-010） |
| 核心符号资产（GB/T 4728，16 个符号，全部按标准手绘） | ✅ 已导入 `assets/gb4728-symbols-kit/` |
| 资产评估（覆盖度/技术质量/集成风险） | ✅ `docs/01-assets-gb4728.md` |
| 前后端架构（**完全复用 breadspice**） | ✅ `docs/02-architecture.md` |
| 编辑模型与交互 | ✅ `docs/03-editor-model.md` |
| 符号 → 运行时清单（`symbols.json`） | ✅ 设计已定，脚本待写 `docs/04-symbol-pipeline.md` |
| 网表输出契约（对接 `rustomp-import`） | ✅ `docs/05-netlist-contract.md` |
| 分阶段计划 | ✅ `docs/06-roadmap.md` |
| **D0 骨架** | 🚧 进行中：符号清单 ✅ / 前端画布 + 模态编辑 ✅ / 后端 ping+symbols ✅ / 网表导出 ⬜ |

---

## 为什么复用 breadspice 的架构

[breadspice](https://github.com/amonisachicken/breadspice) 已经解决了同一类问题的 80%：
SVG 渲染、拖拽/旋转/引脚伸缩、撤销重做、布局持久化、以及 **Rust 后端 + JSON-RPC/WebSocket**
的前后端分层。设计器把"面包板"换成"原理图"，交互与数据流几乎可以照搬。

| 层 | breadspice | 本设计器 |
|---|---|---|
| 前端 | Vite 5 + Vanilla TS，**SVG** 渲染 | 同（换成原理图画布 + 2.5 mm 栅格） |
| 交互 | 拖拽 / 旋转 / 引脚伸缩 / 框选 | **模态编辑**（`r c w q m 空格 d` + `esc`）—— 见 D-009 |
| 状态 | `circuitStore` / `projectStore` + 撤销重做 | 同（文档模型见 `docs/03`） |
| 后端 | Rust axum + JSON-RPC + WS | 同 |
| 后端职责 | ngspice 仿真 | **网表生成 + `rustomp-import` 代码生成**（可保留仿真） |

详见 `docs/02-architecture.md`。

---

## 核心资产

`assets/gb4728-symbols-kit/`（原样导入，未改动）：

- **16 个符号** × (SVG + 1200 dpi 透明 PNG)：电阻、电容、电位器、二极管、LED、电压源、
  NPN、PNP、N-JFET、N-MOSFET、运放、接地、Vcc、Vee、In、Out
- 图集源文件（A4 五图层 SVG + PDF + PNG）+ 构建脚本 + 一份 18 KB 的绘制手册

评估结论（细节见 `docs/01-assets-gb4728.md`）：

- ✅ **几何质量高**：1 单位 = 1 mm、2.5 mm 栅格、引脚全在格点、线宽 0.45/0.9 有规范、
  每个 SVG 顶部有**机器可读的引脚坐标注释**
- ⚠️ **引脚名缺失**：注释里只有坐标，没有 `C/B/E`、`a/k`、`IN+/IN-/V+/V-/OUT` 这类结构化引脚名
  → 需要生成 `symbols.json` 补上（`docs/04`）
- ⚠️ **不够画完整踏板**：缺开关符号（仅图纸表达）、插孔、DC 座、电感等（缺口清单见 `docs/01` §5）；
  电解电容按 D-006 暂不考虑
- ⚠️ **脚本是 Windows 路径**（Inkscape `C:\...`），macOS 需要改路径或改用 `resvg`

---

## 输出契约（最重要的一条）

设计器**只输出网表**，不直接生成 Rust：

```text
* @rustomp in=IN1 out=OUT1
* @rustomp param P1A gain pot max=500k
* @rustomp switch SW1 symmetric ...（按需）
V1 IN1 0 DC 0 AC 0.2 SIN(0 0.2 1k)
R1 ...
Q1 c b 0 BC549C
```

理由：**网表是可被 ngspice 验证的中间格式**，rustomp 的所有对拍（器件级 / 装配器级 / 整机级）
都锚在它上面。设计器一旦直接产出代码，对拍链就断了。

三条硬要求（`docs/05-netlist-contract.md`）：

1. 端口必须显式标注（`in=` / `out=`）；
2. 可调元件必须显式声明（`param`，不从 `250k + 250k` 反推电位器）；
3. 器件型号必须落在 rustomp 的**闭集表**里。

**开关是例外**：它不生成任何电路元件，而是把同一张图导出成 **2ⁿ 份完整电路**
（n = 开关数），由插件交互层按参数选择分支 + 交叉淡化。
开关不进 DSP，理由是"拓扑切换"在电路层实现既不稳也难验证（决策 D-005）。

---

## 文档

| 文档 | 内容 |
|---|---|
| `docs/01-assets-gb4728.md` | **核心资产评估**：清单、技术质量、覆盖度、缺口、风险 |
| `docs/02-architecture.md` | 前后端架构（复用 breadspice）、复用清单、技术选型理由 |
| `docs/03-editor-model.md` | 文档模型、栅格吸附、导线/节点、撤销重做、快捷键 |
| `docs/04-symbol-pipeline.md` | 符号 → `symbols.json` 的 schema、生成与校验 |
| `docs/05-netlist-contract.md` | 网表输出契约、命名规则、与 `rustomp-import` 的对接 |
| `docs/06-roadmap.md` | D0–D4 分阶段计划与验收标准 |
| `assets/gb4728-symbols-kit/README.md` | 符号绘制手册（原作者手笔，18 KB，务必读） |

---

## 许可证

GPL-3.0-or-later（`LICENSE`）。符号资产来自 GB/T 4728（等同采用 IEC 60617）的手绘复刻，
使用范围见 `docs/01-assets-gb4728.md` §6。
