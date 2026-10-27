# 文档索引

代码之外的一切都在这里。**先看 `../README.md`**（产品、架构、功能范围、部署运行、与 rustomp 对接），
再按需要往下读。

| 文档 | 内容 | 何时读 |
|---|---|---|
| `00-decisions.md` | **决策账本（ADR）D-001…D-019**：符号来源、架构复用、坐标/栅格、JSON 格式、**不做开关（D-007）**、预览=截图、导线归一化、命中区、文字锚点、保存语义、仿真复用、仪表挂元件、**首选设计器对接（D-019）** | **先读这个**，再读下面的细节 |
| `01-assets-gb4728.md` | **符号资产**：清单、技术质量、覆盖度、缺口、许可 | 动符号之前必读 |
| `02-architecture.md` | 前后端架构、复用 breadspice 的部分、目录规划、协议 | 写第一行代码之前 |
| `03-editor-model.md` | 文档模型、坐标/吸附、交互与快捷键、顶栏、命中区、并查集、撤销重做、导线归一化、文件格式 | 写画布/交互之前 |
| `04-symbol-pipeline.md` | `symbols.json` schema、生成与校验、渲染、补符号的规范 | 增删符号时 |
| `05-netlist-contract.md` | **网表契约**：文件形态、指令集、节点命名、各符号映射、电位器展开、**单份 `.cir`**（D-007）、lint、生成→验证闭环 | **接口变更时两边同时改** |
| `06-roadmap.md` | D0–D4 分阶段计划、里程碑、明确不做的事 | 排期时 |
| `07-sim-comparison.md` | **仿真能力对照**：breadspice 的实现细节 vs 本设计器，差异与取舍 | 改仿真时 |
| `08-testing.md` | **自测与验证**：调试开关、测试清单、实测数字、回归流程 | 改完代码自查时 |
| `09-devlog.md` | **开发日志**（过程）：每一步做了什么、为什么、踩了什么坑 | 想了解"为什么长这样"时 |
| `../assets/gb4728-symbols-kit/README.md` | 符号绘制手册（原作，18 KB） | 补/改符号时 |
| `prompt.md` | **原始需求书**（模态编辑、快捷键、元件要求） | 与 `03-editor-model.md` 冲突时**以它为准** |

## 与 rustomp 规范的对应

| 本仓库 | rustomp 侧 |
|---|---|
| `05-netlist-contract.md` §1–§2 | `rustomp/docs/circuit-import.md` §1/§2（导入器与格式优先级）、§6.5（指令语义） |
| `05-netlist-contract.md` §7 | `rustomp/docs/circuit-import.md` §10（首选设计器接口） |
| `05-netlist-contract.md` §8 | rustomp 的 `mna_codegen`（lint 与闭集型号在导入阶段再查一次） |
| `01-assets` §4 | `rustomp/docs/component-library.md` §10.1b（型号闭集表） |
| `00-decisions.md` D-019 | `rustomp` 的 `DEVLOG.md` E80、`crates/rustomp-import/tests/designer.rs`（逐行对拍） |
