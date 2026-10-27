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

**D0 完成、D1 大部分完成**（2026-10-27）：能模态编辑画原理图、能跑 `tran`/`ac` 仿真、
能把网表交给 `rustomp-import` 生成可编译的 `Ckt`，并且已经在真实电路上验证过。
（需求以 `prompt.md` 为准；与旧文档冲突处已在 `docs/00` 记录取舍，D-001…D-018。）

规模：前端 2429 行 TS+CSS、后端 1870 行 Rust、工具 453 行 Python；符号 18 个；
文档 `docs/` 1490 行（另 README 183、DEVLOG 205）。
开发过程（做了什么、为什么、踩了什么坑）逐条记在 **`DEVLOG.md`**；结论进 `docs/00-decisions.md`。

已经能跑：

```bash
./tools/gen-symbols.py                        # 符号 → symbols/symbols.json（与 kit 的 PINS 表交叉校验）
cd backend && cargo run                       # 后端：designer.ping / symbols / netlist / simulate / save（127.0.0.1:3600）
cd frontend && npm install && npm run dev      # 画布 + 模态编辑（r/c/w/q/m/空格/d + esc）
cd backend && cargo test                       # 16 个测试（含网表黄金文件 + 真跑 ngspice 的 tran/ac）
```

实测链路（M-B 雏形）：设计器画 `R1/R2 + GND + IN/OUT` → 导出 `.cir` →
`cargo run -p rustomp-import -- designer_out.cir --mna out.rs` → **成功生成 `Ckt`（3 个未知量，节点 IN/OUT）**。

仿真（M-A）：示例 `?load=lowpass`（10k + 100n，fc≈159 Hz）在 1 kHz 下
**稳态衰减实测 0.157**，与理论 `1/√(1+(f/fc)²)` 一致；10 ms 窗口 1505 点。

> 调试开关：`?load=lowpass|noninverting|common-emitter|diode-clip` 载入示例/模板、
> `?sim=1` 直接开仿真、`?selftest=1` 冒烟（**22 项**：命中区 / 双击属性 / 导线归一化 /
> 文字锚点 / 快捷键 / 保存清历史 / 仿真探针 / 查看模式拖动平移）。

四个电路的实测（0.2 V / 1 kHz / 20 ms）：

| 电路 | 输出稳态 | THD |
|---|---|---|
| `lowpass`（10k+100n） | 0.031 V（= 理论 0.157 衰减） | 0.00% |
| `noninverting`（100k/10k，增益 11） | 2.20 V | 0.00% |
| `common-emitter`（Rc/Re=10） | 3.28 V（撞到 9 V 轨） | **27.16%** |
| `diode-clip`（1N4148 ∥ 1N34A） | 0.173 V | **20.07%** |

**生成代码**（M-B）：非反相放大 → `rustomp-import --mna` → `N = 7`、`XU1 IN n1 VCC VEE OUT OP07A`，
生成物里 `use rustomp_dsp::{GND, Netlist, OP07};` ✓。

| 项 | 状态 |
|---|---|
| **关键决策**（架构/坐标/格式/模态交互/**不做开关**/预览=截图/导线归一化/命中区/文字锚点/数值单位/保存语义/仿真复用/仪表挂元件/文案规矩） | ✅ `docs/00-decisions.md`（D-001…D-018） |
| 核心符号资产（GB/T 4728，16 个符号，全部按标准手绘） | ✅ 已导入 `assets/gb4728-symbols-kit/`；另自补 `test-point` / `nc`，删掉 `jack` / `dc-jack` → **清单 18 个** |
| 资产评估（覆盖度/技术质量/集成风险） | ✅ `docs/01-assets-gb4728.md` |
| 前后端架构（**完全复用 breadspice**） | ✅ `docs/02-architecture.md` |
| 编辑模型与交互 | ✅ `docs/03-editor-model.md` |
| 符号 → 运行时清单（`symbols.json`） | ✅ `tools/gen-symbols.py` + `--check` 防漂移 `docs/04-symbol-pipeline.md` |
| 网表输出契约（对接 `rustomp-import`） | ✅ `docs/05-netlist-contract.md` |
| 分阶段计划 | ✅ `docs/06-roadmap.md` |
| 仿真能力对照（breadspice vs 本设计器） | ✅ `docs/07-sim-comparison.md` |
| **D0 骨架** | ✅ 完成：符号清单 / 画布 + 模态编辑 / 后端 RPC / **网表导出 + lint** / 预览截图 |
| **D1** | ✅ 大部分：**仿真**（`tran`+`ac`、rawfile、取消、FFT）、**生成代码**（调 `rustomp-import`）、悬空引脚红圈、**2×2 格命中区 + hover 高亮**、双击开属性、**导线自动合并/接续**（删除即删整段）、3 个模板、位号不随旋转、数值=数字框+单位下拉、**顶栏保存/导出/导入 + 启动自动恢复**、**IN=波形发生器 / OUT 与测试点=示波器** |
| `dc` 扫描 UI 入口、`op` 工作点 | ⏸ 后端已备，UI 未开放（用户要求） |
| 框选/多选、层次图（`.subckt`）、Tauri 桌面版、1:1 打印 | ⬜ 未做 |

---

## 顶栏与快捷键

```text
撤销 · 重做 · [命名框] · 新建 · 保存 · 导出布局 · 导入布局 · 仿真 · 预览 · 生成网表 · 生成代码 · ?
```

| 顶栏 | 行为 |
|---|---|
| **命名框** | 布局名字（保存与导出的文件名都用它） |
| **保存** | 写服务端缓存（`.cache/designs/<名字>.design.json`）+ **清空撤销/重做** |
| **导出布局** | 下载 `<名字>.design.json` |
| **导入布局** | 读本地 `.design.json`（名字取文件里的 name，没有就用文件名） |
| **预览** | 画布位图截图，可保存 PNG |
| **仿真** | `tran` / `ac`；**IN 兼作波形发生器**（幅值/频率在它的属性里设）、**OUT 与测试点都是示波器**（双击看波形 + FFT） |
| **生成网表 / 生成代码** | 见下 |

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

**开关不进网表**（D-007 铁律）：设计器**不提供开关符号**，也**不做分支导出** —— 始终只导出
**单份** `.cir`。插件里"切换不同声音"由插件层持有多个 `Circuit` 并交叉淡化，与本项目解耦。
（早期 D-005 曾设想"同一张图导出 2ⁿ 份网表"，已被 D-007 取代。）

---

## 文档

| 文档 | 内容 |
|---|---|
| **`DEVLOG.md`** | **开发日志**：今天每一步做了什么、为什么、踩了什么坑（过程） |
| `docs/00-decisions.md` | **决策账本（ADR）** D-001…D-018（结论，**先读这个**） |
| `docs/01-assets-gb4728.md` | **核心资产评估**：清单、技术质量、覆盖度、缺口、风险 |
| `docs/02-architecture.md` | 前后端架构（复用 breadspice）、复用清单、技术选型理由 |
| `docs/03-editor-model.md` | 文档模型、栅格吸附、导线/节点、撤销重做、快捷键 |
| `docs/04-symbol-pipeline.md` | 符号 → `symbols.json` 的 schema、生成与校验 |
| `docs/05-netlist-contract.md` | 网表输出契约、命名规则、与 `rustomp-import` 的对接 |
| `docs/06-roadmap.md` | D0–D4 分阶段计划与验收标准 |
| `docs/07-sim-comparison.md` | 仿真能力对照：breadspice 实现细节 vs 本设计器、差异与取舍 |
| `assets/gb4728-symbols-kit/README.md` | 符号绘制手册（原作者手笔，18 KB，务必读） |

---

## 许可证

GPL-3.0-or-later（`LICENSE`）。符号资产来自 GB/T 4728（等同采用 IEC 60617）的手绘复刻，
使用范围见 `docs/01-assets-gb4728.md` §6。
