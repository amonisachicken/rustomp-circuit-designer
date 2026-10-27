# 符号 → 运行时清单（`symbols.json`）

> 问题：符号素材里有几何、有引脚坐标（注释 + `PINS` 表），但**没有结构化的引脚名**。
> 而网表生成必须"**按引脚名绑定**"（`C/B/E`、`a/k`、`IN+/IN-/V+/V-/OUT`），不能按位置猜。
>
> 方案：由脚本从素材**生成** `symbols.json`，并做**漂移检查**（生成物入库）。

---

## 1. Schema

```jsonc
{
  "version": 1,
  "grid": 2.5,
  "unit": "mm",
  "symbols": {
    "npn": {
      "file": "assets/gb4728-symbols-kit/symbols/07-npn.svg",
      "name": { "zh": "NPN 型晶体管", "en": "NPN Transistor" },
      "standard": "GB/T 4728.5",
      "canvas": { "w": 27.5, "h": 35 },
      "origin": { "x": 15.0, "y": 17.5 },        // 素材里的 translate
      "pins": [
        { "id": "C", "name": "集电极", "at": { "x": 2.5, "y": -12.5 }, "dir": "up" },
        { "id": "B", "name": "基极",   "at": { "x": -12.5, "y": 0 },   "dir": "left" },
        { "id": "E", "name": "发射极", "at": { "x": 2.5, "y": 12.5 },  "dir": "down" }
      ],
      "spice": { "prefix": "Q", "pinOrder": ["C", "B", "E"] },
      "models": ["BC549C", "AC127"],
      "category": "bjt"
    },

    "opamp": {
      "file": "assets/gb4728-symbols-kit/symbols/11-opamp.svg",
      "name": { "zh": "运算放大器", "en": "Operational Amplifier" },
      "standard": "GB/T 4728.13",
      "canvas": { "w": 35, "h": 35 },
      "origin": { "x": 17.5, "y": 17.5 },
      "pins": [
        { "id": "IN+", "at": { "x": -15, "y": -5 }, "dir": "left" },
        { "id": "IN-", "at": { "x": -15, "y": 5 },  "dir": "left" },
        { "id": "OUT", "at": { "x": 15, "y": 0 },   "dir": "right" },
        { "id": "V+",  "at": { "x": 0, "y": -12.5 },"dir": "up" },
        { "id": "V-",  "at": { "x": 0, "y": 12.5 }, "dir": "down" }
      ],
      "spice": { "prefix": "X", "pinOrder": ["IN+", "IN-", "V+", "V-", "OUT"] },
      "models": ["OP07A"],
      "category": "opamp"
    }
  }
}
```

### 1.1 两条关键字段

| 字段 | 作用 |
|---|---|
| `pins[].at` | **局部坐标**（符号中心为原点，mm）。渲染时 `world = rotate(at) + part.at` |
| `spice.pinOrder` | 生成网表时的**引脚顺序**（SPICE 只认位置）。顺序与引脚名解耦，所以符号怎么画都不影响网表 |

> 注意 opamp：引脚在素材注释里的顺序是 `(IN+) (IN-) (OUT) (V+) (V-)`，
> 而 rustomp 的运放约定是 `<in+> <in-> <v+> <v-> <out>`。
> **两者顺序不同** —— 这正是必须有 `pinOrder` 的原因（`docs/05` §4）。

### 1.2 引脚方向 `dir`

只用于两件事：画引脚热点（hover 高亮）与"拖拽时朝外吸附"。不参与网表。

---

## 2. 生成脚本（待实现）

`tools/gen-symbols.py`（或 Rust 小工具，二选一）：

```text
读 assets/gb4728-symbols-kit/symbols/*.svg
  ├─ 解析顶部注释：名称 / 标准号 / 画布 / 引脚画布坐标
  └─ 解析 <g transform="translate(cx,cy)"> 得到 origin
        ↓  局部坐标 = 画布坐标 − origin
与 assets/gb4728-symbols-kit/build/make-symbols.py 的 PINS 表交叉校验
        ↓
合并手写元数据（eyml：引脚名、SPICE 引脚序、可用型号、类别）
        ↓
输出 symbols/symbols.json（入库）+ 打印差异
```

**为什么要"交叉校验"**：引脚坐标现在有两份来源（SVG 注释 / `PINS` 表）。
两份不一致时，生成的引脚位置就是错的，而这类错误在画图时**看起来完全正常**
（引脚就在线上，只是差了 0.5 mm → 网表多出一个孤立节点）。

### 2.1 手写元数据放哪

引脚名与型号无法从几何推导，必须人工维护。建议一个小文件：

```yaml
# symbols/overrides.yml
npn:
  pins: { "2.5,-12.5": C, "-12.5,0": B, "2.5,12.5": E }
  spice: { prefix: Q, pinOrder: [C, B, E] }
  models: [BC549C, AC127]
opamp:
  pins: { "-15,-5": "IN+", "-15,5": "IN-", "15,0": OUT, "0,-12.5": "V+", "0,12.5": "V-" }
  spice: { prefix: X, pinOrder: ["IN+", "IN-", "V+", "V-", "OUT"] }
  models: [OP07A]
```

用**坐标作为 key** 的好处：几何一变，key 就对不上 → 脚本报错，而不是静默错位。

---

## 3. 校验（CI 里跑）

| 校验 | 规则 |
|---|---|
| 栅格 | 所有 `pins[].at` 与 `part.at` 必须是 2.5 的整数倍 |
| 画布包含 | 引脚必须落在 `canvas` 内 |
| 名称唯一 | 同一符号内引脚 `id` 不重复 |
| `pinOrder` 完整 | `pinOrder` 必须恰好覆盖 `pins` 的全部 id（缺一个 → 网表少一个端子） |
| 型号闭集 | `models` 里的每个型号必须在 rustomp 的 `model_const()` 表里（由 rustomp 提供清单） |
| 交叉校验 | SVG 注释坐标 == `PINS` 表 == `symbols.json` |
| 漂移 | `symbols.json` 必须等于"现在重新生成"的结果（同 rustomp 的生成物守卫） |

> 这张表就是 D1 的验收清单。**"画布包含"和"pinOrder 完整"这两条**是最容易被漏的。

---

## 4. 渲染方式

| 场景 | 做法 |
|---|---|
| 画布上的符号 | 直接用 `<use href="symbols/07-npn.svg#root">`（或在构建期把 SVG 内联成字符串） |
| 需要 hover/选中态 | 复制一份 SVG DOM，加 `class` 后由 CSS 改描边色（不修改素材本身） |
| 打印/导出 SVG | 把 `Document` 展开成一份完整 SVG（符号实例化 + 变换） |
| PNG 导出（可选） | 后端用 `resvg`（rustomp 已用过）或前端 canvas 光栅化 |

| 符号内的文字（`V+`/`V−`/`C`/`B`/`E`/`In`/`Out`） | 加载时从 `<text>` 抠出（含祖先 `<g>` 继承的样式），在**不旋转的标签层**重绘 | 旋转后文字保持正向（docs/03 §3.0b） |

> 素材里的 `<text>` **不支持文字级 `transform`**（当前 18 个符号都没有）；遇到需要先补解析。

> **不要给素材 SVG 打补丁**（改颜色/改线宽）：一律在**实例层**（`<g>` 包裹 + CSS）处理，
> 这样素材可以原样升级。

---

## 5. 缺口符号的接入方式

补的符号（电解电容、开关、插孔…）必须满足同一套规范，否则栅格/线宽会不一致：

1. 1 单位 = 1 mm，画布尺寸为 2.5 的整数倍；
2. 引脚端点落在 2.5 网格；符号组只 `translate` 不 `scale`；
3. 顶部注释写名称/标准号/画布/引脚坐标（与现有 16 个一致）；
4. 出现在 `overrides.yml` 里，`symbols.json` 重新生成。

建议补的符号**沿用同一份绘制手册**（`assets/gb4728-symbols-kit/README.md`），
并在 `assets/` 下新建目录（例如 `assets/gb4728-ext/`），**不修改原 kit**。
