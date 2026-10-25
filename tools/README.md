# tools

计划中的脚本（**目前都还没写**，见 `docs/06-roadmap.md` D0）：

| 脚本 | 作用 |
|---|---|
| `gen-symbols.py` | 读 `assets/gb4728-symbols-kit/symbols/*.svg` + `symbols/overrides.yml` → 生成 `symbols/symbols.json` |
| `check-symbols.py` | 校验：栅格、画布包含、引脚名唯一、`pinOrder` 完整、型号在 rustomp 闭集内 |
| `check-drift.py` | `symbols.json` 是否等于"现在重新生成"的结果（等价 rustomp 的漂移守卫） |
| `render-sheet.py` | 把 `Document` 渲染成单页 SVG（打印用） |

约定：

- 路径全部**相对仓库根**，不依赖当前工作目录；
- 不写死 Inkscape 路径（若需要，读环境变量 `INKSCAPE_BIN`，缺省 `inkscape`）；
- 每个脚本都要能被 CI 直接调用，退出码非 0 即失败。
