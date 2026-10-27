# 文档索引

| 文档 | 内容 | 何时读 |
|---|---|---|
| `00-decisions.md` | **决策账本（ADR）D-001…D-018**：符号来源、架构复用、坐标/栅格、JSON 格式、**不做开关（D-007）**、预览=截图、导线归一化、命中区、仿真复用、仪表挂元件… | **先读这个**，再读下面的细节 |
| `01-assets-gb4728.md` | **核心资产评估**：清单、技术质量、覆盖度、缺口、许可风险 | 动符号之前必读 |
| `02-architecture.md` | 前后端架构（复用 breadspice）、目录规划、协议草案 | 写第一行代码之前 |
| `03-editor-model.md` | 文档模型、栅格/吸附、连通性并查集、撤销重做、文件格式 | 写画布/交互之前 |
| `04-symbol-pipeline.md` | `symbols.json` schema、生成与校验、渲染方式、补符号的规范 | 做符号清单时 |
| `05-netlist-contract.md` | 网表输出契约、指令集、节点命名、各符号映射、**单份 `.cir`**（D-007）、lint | **接口变更时两边同时改** |
| `06-roadmap.md` | D0–D4 分阶段计划、里程碑、明确不做的事 | 排期时 |
| `07-sim-comparison.md` | **仿真能力对照**：breadspice 的实现细节 vs 本设计器，差异清单与取舍 | 想扩仿真功能时 |
| `../DEVLOG.md` | **开发日志**（过程）：每一步做了什么、为什么、踩了什么坑 | 想了解"为什么长这样"时 |
| `../assets/gb4728-symbols-kit/README.md` | 符号绘制手册（原作，18 KB） | 补符号时 |
| `../prompt.md` | **原始需求书**（用户写的交互与元件要求：模态编辑、快捷键、INPUT/OUTPUT 封装） | 与 `03-editor-model.md` 冲突时**以它为准** |

## 与 rustomp 规范的对应

| 本仓库 | rustomp 侧 |
|---|---|
| `05-netlist-contract.md` | `rustomp/docs/circuit-import.md` §6.5、§10 |
| `05-netlist-contract.md` §2 | `rustomp/docs/declarative-build.md` §3.4 |
| `01-assets` §4 | `rustomp/docs/component-library.md` §10.1b（型号闭集表） |
