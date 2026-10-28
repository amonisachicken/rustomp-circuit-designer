# 自测与验证记录

> 这份文件收集**"怎么证明它是对的"**：自测开关、测试清单、实测数字。
> 为什么改、怎么改，看 `09-devlog.md`；为什么这样设计，看 `00-decisions.md`。

---

## 1. 三层验证

| 层 | 命令 | 覆盖什么 | 规模 |
|---|---|---|---|
| 后端单元/集成测试 | `cd backend && cargo test` | 网表黄金文件、确定性与 lint、电位器展开、MOS 衬底、真跑 ngspice 的 `tran`/`ac`、复数 rawfile 解析 | **16 项** |
| 浏览器自测 | 打开 `?selftest=1` | 命中区、双击、导线归一化、**连接点黑点与导线自动剪裁**、文字锚点、快捷键、保存语义、仿真探针、查看模式拖动 | **33 项** |
| 手动验收 | 见 §4 | 四个示例电路的稳态幅度与 THD、生成代码链路 | — |

> 机器注意：`cargo test` 里有真跑 ngspice 的用例，机器空闲时全套 < 10 s；
> Spotlight 全量索引或 `mediaanalysisd` 之类高占用时，仿真用例会明显变慢（不是失败）。

---

## 2. 调试开关（URL 查询参数）

| 参数 | 作用 |
|---|---|
| `?load=lowpass` | 载入示例/模板：`lowpass` / `noninverting` / `common-emitter` / `diode-clip` |
| `?sim=1` | 打开页面即弹仿真窗口 |
| `?selftest=1` | 跑浏览器自测，结果显示在状态栏与 console |

示例与模板由 `tools/make-templates.py` 与前端内置数据生成；
`?load=` 载入的是**可编辑的真实文档**（不是只读画面），可以随手改。

---

## 3. 浏览器自测的 33 项

> `?selftest=1` 会自动恢复“上次保存”的文档。若上次存的图没有 OUT/测试点，
> `sim-scope` 会因“没探针”而失败 —— 用 `?selftest=1&load=lowpass` 跑（示例含 OUT + 测试点）才是全绿基线。

| 项 | 守什么 |
|---|---|
| `hit4mm` / `miss12mm` / `wire4mm` | 命中区按几何距离（元件 2×2 格、导线 5 mm、远处不误命中） |
| `dblclick-props` | 双击开属性面板（**自己检测**，不依赖 DOM `dblclick`） |
| `join` / `merge` / `cross` / `delete-span` | 导线归一化：首尾相接合并、重叠合并、十字交叉不合并、删除删整段 |
| `junction-t` / `junction-cross` / `junction-corner` | 连接点黑点：T 型要画；十字交叉与两线拐角不画（交叉 ≠ 连接） |
| `trim-keep-ends` / `trim-exact` | 语法糖：两脚落在同一直导线上时剪掉中间（两头伸出留两端；正好跨两脚则整根删） |
| `copy-value` / `copy-model` | `d` 复制保留数值（4.7k）与型号（1N34A），位号重新分配 |
| `junction-cross-continued` | 从 T 型接点继续画成十字后，交点仍是连接（归一化不吃掉端点），黑点不消失 |
| `trim-multi-pot` / `trim-multi-bjt` / `trim-multi-opamp` | 多脚器件的共线引脚（电位器 1–3、BJT C–E、运放 IN+–IN−）同样剪断；没有导线的引脚对不会凭空生成线段 |
| `texts-extracted` | 符号里的 `<text>` 被转成锚点（含祖先 `translate` 累计） |
| `key-g` / `key-h` | `g` 放接地、`h` 快捷键手册 |
| `value-split` / `value-join` / `value-legacy` | 数值 = 数字框 + 单位下拉；老后缀（`47m`）不被静默改值 |
| `redo-ctrl-y` | 重做是 `⌘/Ctrl+Y` |
| `btn-help` / `toolbar-buttons` | 顶栏按钮齐全、帮助可开 |
| `in-mirrored` | IN 符号水平镜像（引脚朝右） |
| `docname-sync` | 命名框与文档名同步 |
| `save-clears-history` | 保存后清空撤销/重做（保存 = 提交点） |
| `sim-scope` | 仿真只画 **IN + OUT + 所有测试点**（未放测试点的节点不画） |
| `view-drag-pan` | 查看模式左键拖动平移（>2 px 才算拖），单击仍能选中 |

---

## 4. 实测数字（0.2 V / 1 kHz / 20 ms 窗口）

| 电路 | 输出稳态 | THD | 说明 |
|---|---|---|---|
| `lowpass`（10k + 100n） | 0.031 V | 0.00% | = 理论衰减 `0.157`（`1/√(1+(f/fc)²)`，fc≈159 Hz） |
| `noninverting`（100k/10k，增益 11） | 2.20 V | 0.00% | 理想运放宏模型，无失真 |
| `common-emitter`（Rc/Re=10） | 3.28 V | **27.16%** | 输出撞到 9 V 轨（该电路本来就削波） |
| `diode-clip`（1N4148 ∥ 1N34A） | 0.173 V | **20.07%** | 两只不同管型的对称性差异 |

判据一律取**稳态段**（窗口最后 25%）。踩过的坑：全程最大值会被起始瞬态骗，
低通实测 0.255（假）vs 稳态 0.157（= 理论）。

---

## 5. 与 rustomp 的链路验证

| 里程碑 | 验证方式 | 结果 |
|---|---|---|
| **M-A**：图 → `.cir` → ngspice 能跑 | 示例低通 1 kHz 稳态 0.157 | ✅ 与理论一致 |
| **M-B**：图 → `.cir` → `rustomp-import --mna` 生成 `Ckt` | 非反相放大（100k/10k）→ `N = 7`、`XU1 IN n1 VCC VEE OUT OP07A`、`use rustomp_dsp::{GND, Netlist, OP07}` | ✅ 生成物可编译 |
| **M-B'**：**.design.json 直接进生成器**（2026-10-27） | 低通工程 → `--mna` → 通带 0.998、1 kHz 衰减与理论差 < 0.02；`Params.p1/p2` 与 `pub const IN` 都在 | ✅ 在 rustomp 侧有对拍与漂移守卫 |
| **M-C**：生成代码的 THD 与设计器仿真对拍 | — | ⬜ 阻塞在 rustomp 实时求解器（见 `09-devlog.md` E12 已知问题） |

> `.design.json` 直读的**逐行对拍**（读工程文件 vs 设计器导出的 `.cir`）在 rustomp 仓库：
> `crates/rustomp-import/tests/designer.rs`。

---

## 6. 回归时先跑什么

```bash
cd backend && cargo test          # 16 项，含真跑 ngspice
cd frontend && npm run typecheck  # tsc --noEmit（零运行时依赖，无单测框架）
# 浏览器：?selftest=1 —— 22 项，改交互/几何后必跑
```

改了**符号几何**（`symbols/symbols.json`）或**网表规则**时，额外做一次：

```bash
./tools/gen-symbols.py --check    # 与 kit 的 PINS 表交叉校验，防漂移
```

改完请到 rustomp 仓库跑 `cargo test -p rustomp-import`：
它的 `tests/designer.rs` 会用本项目导出的 `.cir` 逐行对拍本项目的工程文件导入结果。
