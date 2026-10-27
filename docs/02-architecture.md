# 前后端架构（完全复用 breadspice）

> 决策：**不发明新架构**。breadspice 已经把"浏览器里拖元件连线 + Rust 后端算东西"
> 这条路走通了一遍（5.6k 行 TS + 2.7k 行 Rust），设计器照搬它的分层即可。
>
> 差异只有一处：**后端的主要职责从"跑 ngspice 仿真"变成"生成网表 + 调用 rustomp-import 生成电路代码"**
> （仿真能力保留，用于画图时的即时验证）。

---

## 1. 技术栈（与 breadspice 逐项对齐）

| 层 | breadspice | 本设计器 | 复用方式 |
|---|---|---|---|
| 前端框架 | Vite 5 + **Vanilla TypeScript**（无 React/Vue） | 同 | 直接照搬工程配置 |
| 渲染 | 原生 **SVG**（`render/*.ts`） | 同（原理图画布） | 结构照搬，实现重写 |
| 交互 | 拖拽 / 旋转 / 引脚伸缩（`interaction/*.ts`） | **模态编辑**（`r/c/w/q/m/空格/d` + `esc`，见 D-009） | 只照抄骨架，交互重写 |
| 状态 | `circuitStore` / `projectStore` + 撤销重做 | 同 | 模式照搬 |
| 后端框架 | Rust **axum 0.7 + tokio + serde** | 同 | 直接照搬 |
| 通信 | **HTTP JSON-RPC + WebSocket 事件流** | 同 | 协议照搬（换方法名） |
| 类型对齐 | `frontend/src/types/protocol.ts` ↔ `backend/src/protocol.rs` | 同 | 机制照搬 |

**不选 Rust GUI（egui）的理由**：

1. 原理图编辑器本质是 2D 矢量绘制 + 大量 DOM 事件，web 的 SVG/DOM 生态成熟得多；
2. breadspice 已验证过"浏览器 + Rust 后端"，风险最低；
3. 符号资产是 SVG，浏览器**原生**能渲染 —— egui 需要额外接入 `resvg` 光栅化；
4. 未来可做成 Tauri 桌面版（前端不变）。

---

## 2. 分层

```text
┌──────────────────────────── 前端（浏览器） ────────────────────────────┐
│  main.ts / 组件      画布、工具栏、属性面板、库面板                      │
│  ├─ render/          SymbolRenderer（SVG 片段 + 变换）、WireRenderer、GridRenderer
│  ├─ interaction/     模式状态机（查看/放置/画线/删除/移动/复制）+ 光标 + 吸附
│  ├─ store/           DocumentStore（元件+导线+页）、HistoryStore（撤销重做）、Selection
│  ├─ types/           domain.ts（文档模型）、protocol.ts（与后端对齐）
│  └─ backend/         HttpBackend（JSON-RPC 客户端）+ 事件流订阅
└───────────────────────────────┬────────────────────────────────────────┘
                                │ JSON-RPC + WebSocket
┌───────────────────────────────▼────────────────────────────────────────┐
│ 后端（Rust / axum）                                                     │
│  ├─ server.rs        路由：/rpc（JSON-RPC）、/events（WS）              │
│  ├─ protocol.rs      请求/响应/事件类型（与前端 protocol.ts 一一对应）   │
│  ├─ domain.rs        文档模型（与前端 domain.ts 一一对应）               │
│  ├─ netlist.rs       **文档 → SPICE 网表 + @rustomp 指令**（核心，单份；D-007 不做分支）
│  ├─ codegen.rs       调用 rustomp_import::mna_codegen → Rust 源码        │
│  ├─ symbols.rs       读取 symbols.json（引脚元数据）                    │
│  └─ lint.rs          电路检查（悬空引脚、多驱动、无地、重复编号…）        │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ 库依赖（同一 workspace 或 path 依赖）
                    ┌───────────▼───────────┐
                    │ rustomp-import (crate) │  网表 → 电路代码
                    │ rustomp-oracle (crate) │  ngspice 对拍/仿真（可选）
                    └───────────────────────┘
```

**关键点：后端直接**链接** `rustomp-import` 这个 crate，而不是 `命令行调用`。**
理由：同一份代码、同一套测试，不存在"命令行参数对不上"的漂移；
打包成一个二进制也更容易。

---

## 3. 目录规划

```text
rustomp-circuit-designer/
├── assets/gb4728-symbols-kit/     符号资产（只读）
├── symbols/                       symbols.json + 派生数据（脚本生成，见 docs/04）
├── frontend/                      Vite + TS
│   ├── index.html
│   ├── src/{main.ts,render/,interaction/,store/,types/,backend/,i18n.ts,style.css}
│   └── package.json / vite.config.ts / tsconfig.json
├── backend/                       Rust（axum）
│   ├── Cargo.toml
│   └── src/{main.rs,server.rs,protocol.rs,domain.rs,netlist.rs,codegen.rs,symbols.rs,lint.rs}
├── tools/                         资产脚本（符号清单生成、校验）
└── docs/
```

> 前端与后端各自独立构建；开发期用 Vite devserver + 后端 `cargo run`，
> 生产期后端托管前端静态文件（一个二进制，和 breadspice 一致）。

---

## 4. 从 breadspice 直接照搬的部分

| breadspice 模块 | 复用方式 | 改动 |
|---|---|---|
| `backend/src/server.rs`（axum 路由 + WS 广播） | 照抄骨架 | 方法名换成 `designer.*` |
| `backend/src/protocol.rs`（serde 标签枚举） | 照抄风格 | 换成设计器的消息 |
| `frontend/src/backend/HttpBackend.ts`（JSON-RPC 客户端） | 照抄 | 只换类型 |
| `frontend/src/store/*`（撤销重做、持久化） | 照抄模式 | 文档模型不同 |
| `frontend/src/render/svgAsset.ts`（SVG 片段注入） | 照抄 | 增加"引脚热点"注入 |
| 交互框架 | **不照抄**（本工具是模态编辑，D-009） | 坐标从"孔位"换成"2.5 mm 栅格" |

## 5. 必须新写的部分

| 模块 | 为什么不能照搬 |
|---|---|
| **原理图画布** | 面包板是固定孔位 + 元件占位；原理图是自由放置 + 任意角度 + 导线折点 |
| **导线/节点模型** | 面包板靠插孔自然并网；原理图必须显式做"导线重合 → 节点合并"（并查集） |
| **网表生成器** | 面包板输出网表给 ngspice；这里还要输出 `* @rustomp` 指令与端口声明 |
| **单份网表** | 开关不进网表（D-007）：分支由插件层维护，设计器只导出当前这一份 |
| **符号清单 `symbols.json`** | breadspice 的元件是 JS 写死的；这里必须数据驱动（`docs/04`） |
| **lint** | 悬空引脚、同网多驱动、无地、重复参考编号、电位器未接线等 |

---

## 6. 通信协议草案

与 breadspice 相同的"请求-响应 + 事件流"两类：

**请求（HTTP POST `/rpc`）**

| 方法 | 入参 | 出参 |
|---|---|---|
| `designer.symbols` | — | `SymbolManifest`（`symbols.json` 的运行时视图） |
| `designer.branches` | `Document` | `{ branches: [{ index, combo, netlist }], index_json: String, warnings }` |
| `designer.netlist` | `Document`（可选 combo） | `{ netlist: String, notes: String[], warnings: LintWarning[] }` |
| `designer.codegen` | `Document` + `CodegenOptions` | `{ code: String, unknowns: usize, notes: String[] }` |
| `designer.lint` | `Document` | `LintWarning[]` |
| `designer.simulate`（可选） | `Document` + `SimOptions` | 同 breadspice 的仿真结果 |
| `designer.export` | `Document` + 格式 | 文件内容（`.cir` / `.json` / `.svg` / `.md`） |

**事件（WebSocket `/events`）**：`progress`、`lint`、`sim.done`、`error`。

> 协议类型在 `frontend/src/types/protocol.ts` 与 `backend/src/protocol.rs` 一一对应，
> 与 breadspice 的约定一致（改一处必须同时改另一处，CI 可加文本比对）。

---

## 7. 与 rustomp 的版本关系

| 依赖 | 形式 | 说明 |
|---|---|---|
| `rustomp-import` | path 依赖（同机多仓库时用 `path = "../rustomp/crates/rustomp-import"`） | 只用它的 `Importer` + `mna_codegen` |
| `rustomp-oracle` | path 依赖（可选） | 用于"画完就能仿真" |
| `rustomp-dsp` | **不依赖** | 设计器不跑 DSP；生成的代码由插件项目编译 |

> 版本策略：设计器随 rustomp 的 S1 契约走。**契约变更必须在 rustomp 的 DEVLOG 记档**
> （`docs/circuit-import.md` §10 与 `docs/declarative-build.md` §3.6 是双方共同的规范）。
