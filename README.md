# rustomp-circuit-designer

**电路原理图设计器** —— 在浏览器里画原理图，得到一份可被 [rustomp](https://github.com/amonisachicken/rustomp)
直接生成插件电路的 SPICE 网表。

它是 rustomp 生态的**首选**原理图设计器（取代 breadspice 的"画面包板"路径）：

```text
 本设计器                     rustomp 框架                     插件
 ─────────                   ───────────────                  ──────
 画原理图
   │ 交付物① 工程文件 .design.json  ──┐
   │ 交付物② 网表 .cir + @rustomp 指令 ─┤
   ▼                                  ▼
                             rustomp-import --mna ──► 生成的 Rust 电路（Netlist + Params + impl Circuit）
                                                           │
                                                           ▼
                                                   rustomp-dsp（MNA / 器件库 / 实时路径）
                                                           │
                                                           ▼
                                                Engine + rustomp-gui + nih-plug → AU/VST3/CLAP
```

---

## 1. 产品介绍

画完一张图，你得到两样东西：

| 交付物 | 用来做什么 |
|---|---|
| **工程文件 `.design.json`** | rustomp 可以直接读（推荐路径）：不用先导出，也不会"改了图忘了重导出" |
| **SPICE 网表 `.cir`** | 通用格式：能被 ngspice 直接验证，也能交给任何 SPICE 工具或用 `rustomp-import` 生成代码 |

它解决的是**"画完就知道声音对不对"**：图纸、仿真、生成代码三件事在同一个界面里，
不必在 LTspice / 面包板 / 手写网表之间来回搬。

**面向谁**：rustomp 插件的电路作者。交互是**模态编辑**（键盘驱动、无拖放，
以 [`docs/prompt.md`](docs/prompt.md) 的需求书为准 —— D-009）。

---

## 2. 架构

```text
frontend/（Vite + TS，零运行时依赖）                backend/（Rust + axum，JSON-RPC over HTTP）
  画布：原生 SVG                                    designer.symbols    符号清单（含引脚几何）
  模态编辑状态机（r/c/w/q/m/空格/d）                 designer.netlist    文档 → 网表 + lint
  渲染 / 命中区 / 锚点文字                           designer.save/last  存到缓存 / 启动恢复
  属性面板 / 示波器 / 预览                           designer.simulate   ngspice tran·ac（含取消）
        │   HTTP :3600                             designer.fft        频谱（Hann + 对数 dB）
        └────────────────────────────────────────► designer.codegen   调 rustomp-import --mna
```

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | Vite 5 + Vanilla TS，原生 SVG | 符号资产是 SVG，浏览器原生能渲染；原理图本质是 2D 矢量 + 大量指针事件 |
| 后端 | Rust + axum，JSON-RPC over HTTP | 网表生成、lint、ngspice、调 `rustomp-import` 都在 Rust 侧；骨架与 breadspice 同构（D-002） |
| 坐标 | **毫米**（1 单位 = 1 mm）+ 2.5 mm 栅格 | 与符号 SVG 的 `viewBox`/引脚跨距一致，导出永不缩放（D-003） |
| 文档 | 纯文本 JSON（`.design.json`） | 可 diff、可版本化、可手改（D-004） |

骨架从 [breadspice](https://github.com/amonisachicken/breadspice) 照搬（同为 GPL-3、同作者），
**交互与画布重写**：面包板的"拖放 + 插孔归并"换成原理图的"模态编辑 + 导线/引脚重合"。
细节见 [`docs/02-architecture.md`](docs/02-architecture.md)。

### 目录

```text
backend/     Rust 后端：netlist.rs（文档→网表+lint）/ sim.rs / codegen.rs / store.rs / fft.rs
frontend/    画布：model.ts / symbols.ts / render.ts / mode.ts / plot.ts / main.ts
symbols/     symbols.json（运行时清单）+ overrides.json（手写引脚名）
assets/      GB/T 4728 符号素材（原样导入，未改动）
tools/       gen-symbols.py（素材 → symbols.json）/ make-templates.py
docs/        决策账本 / 架构 / 编辑模型 / 符号管线 / 网表契约 / 路线 / 仿真对照 / 自测 / 开发日志
```

---

## 3. 功能范围

### 能做

| 类别 | 内容 |
|---|---|
| **画图** | 放置 / 移动 / 复制 / 旋转 / 镜像 / 删除元件；正交导线（T 型连接、junction 圆点）；导线**自动合并重合与首尾相接**（删除即删整段） |
| **连通性** | 引脚落点与导线端点/中间重合即为连接；并查集求网络；自动命名 `n1…`（按坐标排序，保证网表确定性） |
| **元件** | 电阻、电容、电位器、二极管、LED、电压源、NPN/PNP、N-JFET、N-MOSFET、运放、接地、Vcc、Vee、In、Out、测试点、NC（**18 个**） |
| **网表** | 导出单份 `.cir`（含 `* @rustomp` 指令）+ lint：无地 / 重复编号 / 未知或缺失型号 / 悬空引脚 / 缺端口 / 非法导线… |
| **仿真** | ngspice `tran` + `ac`、波形、FFT、THD、取消；**IN = 波形发生器**（幅值/频率），**OUT 与测试点 = 示波器**（双击看该节点） |
| **验证** | 悬空引脚红圈、hover 高亮命中区、属性面板（数值 = 数字框 + 单位下拉） |
| **工程** | 命名、保存（服务端缓存）、导出/导入 `.design.json`、启动自动恢复上次保存、预览截图 PNG、一键生成 rustomp 电路代码 |

### 暂不（后端已备或已规划）

| 项 | 状态 |
|---|---|
| `dc` 扫描 / `op` 工作点入口 | 后端解析与驱动已就绪，UI 不开放 |
| 框选 / 多选 | 不做（模态编辑用 `q` 逐个点） |
| 层次图（`.subckt`）、多页 | 未做 |
| SVG / 1:1 打印 | 未做（目前只有 PNG 预览） |
| Tauri 桌面版 | 未做（前端不变即可加） |

### 明确不做

| 不做 | 原因 |
|---|---|
| **开关元件 / 分支导出** | D-007 铁律：开关是**插件层**的子电路切换，不是电路拓扑；图纸里连符号都不提供，导出永远是**单份**网表 |
| PCB 布局 / 布线、3D、面板外壳 | 这是原理图设计器，不是 EDA 全家桶；面板另有 GUI 设计器 |
| SPICE 引擎 | 用 ngspice（`designer.simulate`），不自研 |
| 器件模型编辑 | 型号是**闭集**；要加型号去 rustomp 的 `devices/` 标定 |
| 电解电容（极性） | D-006：器件库没有极性模型 |

---

## 4. 部署与运行

### 依赖

| 依赖 | 用途 | 检查 |
|---|---|---|
| **Node.js 18+** | 前端构建/dev server | `node -v` |
| **Rust（stable）** | 后端 | `cargo -V` |
| **Python 3** | `tools/gen-symbols.py`（生成符号清单） | `python3 -V` |
| **ngspice** | 【仿真】按钮 | `ngspice -v`（没装则仿真报错，其余功能正常） |
| **rustomp 仓库**（可选） | 【生成代码】按钮 | 同级目录 `../rustomp` 或 `RUSTOMP_ROOT` |

### 启动

```bash
# 1) 符号清单（只在素材变更后需要重跑；已入库，克隆即可用）
./tools/gen-symbols.py            # --check 只校验不写

# 2) 后端（127.0.0.1:3600）
cd backend && cargo run

# 3) 前端（另开一个终端）
cd frontend && npm install && npm run dev
```

打开终端里打印的地址即可。前端默认连 `http://127.0.0.1:3600/rpc`。

### 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `CD_PORT` | `3600` | 后端端口 |
| `CD_ROOT` | 仓库根（`backend/` 的上一级） | 找 `symbols/symbols.json` 与 `assets/` |
| `CD_DATA` | `<仓库根>/.cache/designs` | 【保存】写到哪里 |
| `NGSPICE` | `ngspice` | ngspice 可执行文件路径 |
| `RUSTOMP_ROOT` | `../rustomp` | 【生成代码】调的 rustomp 仓库位置 |
| `VITE_RPC_URL` | `http://127.0.0.1:3600/rpc` | 前端连哪个后端 |

### 测试

```bash
cd backend && cargo test        # 16 项（含真跑 ngspice 的 tran/ac、网表黄金文件）
cd frontend && npm run typecheck
# 浏览器：<地址>?selftest=1 —— 22 项交互冒烟
```

清单与实测数字见 [`docs/08-testing.md`](docs/08-testing.md)。

---

## 5. 与 rustomp 对接

**只出网表，不出 Rust**（因为网表是可被 ngspice 验证的中间格式，对拍链全靠它）。

### 两种交付方式

```bash
# A) 首选：工程文件直接交给 rustomp-import（不用先导出）
RUSTOM_DESIGNER_SYMBOLS=<本仓>/symbols/symbols.json \
  cargo run -q -p rustomp-import -- 设计.design.json --mna <项目>/src/generated/circuit.rs

# B) 传统：先导出 .cir 再喂（两条路产物逐行相同，rustomp 侧有对拍测试守着）
cargo run -q -p rustomp-import -- 设计.cir --mna <项目>/src/generated/circuit.rs --check
```

### 契约（两侧必须一致）

| 项 | 约定 |
|---|---|
| 端口 | `* @rustomp in=<节点> out=<节点>` —— **节点名**（`IN`/`OUT`），不是元件名 |
| 电位器 | `* @rustomp param RP1A <字段> pot max=<值> [invert]` —— 元素名是**网表元件名**（展成的电阻），不是位号 `P1A` |
| 网表形态 | 一张图**一份** `.cir`；它是**纯拓扑**（激励由 DSP 或仿真弹窗注入，见 D-017） |
| 型号 | 必须落在 rustomp 的**闭集表**里，否则导入即报错（不静默替换） |
| 几何 | 引脚坐标以本仓 `symbols/symbols.json` 为唯一事实来源（rustomp 侧运行时读它，不复制） |
| 确定性 | 同一张图永远产出同样字节（元件按参考编号自然序、自动网名按坐标排序） |

完整网表契约见 [`docs/05-netlist-contract.md`](docs/05-netlist-contract.md)；
rustomp 侧的导入器与逐行对拍见其 `docs/circuit-import.md` §1/§2/§10 与
`crates/rustomp-import/tests/designer.rs`。

---

## 6. 文档

细节全在 [`docs/`](docs/README.md)（含索引与"何时读哪篇"）：

- **决策账本** [`docs/00-decisions.md`](docs/00-decisions.md) —— 先读这个；
- **网表契约** [`docs/05-netlist-contract.md`](docs/05-netlist-contract.md) —— 与 rustomp 接口变更时**两边同时改**；
- **自测与实测** [`docs/08-testing.md`](docs/08-testing.md)；
- **开发过程**（做了什么 / 为什么 / 踩了什么坑）在 [`docs/09-devlog.md`](docs/09-devlog.md)。

---

## 7. 许可证

GPL-3.0-or-later（[`LICENSE`](LICENSE)）。符号资产是 GB/T 4728（等同采用 IEC 60617）的
手绘复刻，版权归本项目所有，使用范围见 [`docs/01-assets-gb4728.md`](docs/01-assets-gb4728.md) §7。
前端骨架与仿真核心复用自 breadspice（同为 GPL-3，同作者）。
