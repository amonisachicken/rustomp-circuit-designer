#!/usr/bin/env python3
"""符号素材 → symbols/symbols.json（D0 的关键物，见 docs/04-symbol-pipeline.md）

为什么要生成而不是手写：引脚坐标有两个来源（SVG 顶部注释 / kit 里 build/make-symbols.py 的
PINS 表），两份不一致时"引脚看起来在线上，只是差 0.5 mm"，画图完全正常，网表却多出孤立节点。

用法：
  ./tools/gen-symbols.py            # 生成 symbols/symbols.json
  ./tools/gen-symbols.py --check    # 只比对（CI 用；不一致返回 1）

本地坐标 = 画布坐标 − 符号原点（素材里的 <g transform="translate(cx,cy)">）。
引脚名 / SPICE 顺序 / 可用型号来自手写的 symbols/overrides.json（坐标作为 key）。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIT = ROOT / "assets/gb4728-symbols-kit"
SYMBOLS_DIR = KIT / "symbols"
EXT_DIR = ROOT / "assets/gb4728-ext/symbols"   # 补的符号（docs/04 §5：不改原 kit）
MAKE_SYMBOLS = KIT / "build/make-symbols.py"
OVERRIDES = ROOT / "symbols/overrides.json"
OUT = ROOT / "symbols/symbols.json"
GRID = 2.5
VERSION = 1

COMMENT_RE = re.compile(r"<!--\s*(.*?)\s*-->", re.S)
ORIGIN_RE = re.compile(r'<g[^>]*transform="translate\(\s*(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)\s*\)"')
PINS_IN_COMMENT_RE = re.compile(r"引脚[:：]\s*(.+)$")
PAIR_RE = re.compile(r"\(\s*(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)\s*\)")
NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")


def fmt(v: float) -> str:
    """坐标 → 规范字符串（用于 overrides 的 key，必须与手写文件一致）"""
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def key(x: float, y: float) -> str:
    return f"{fmt(x)},{fmt(y)}"


def parse_comment(text: str) -> dict:
    m = COMMENT_RE.search(text)
    if not m:
        raise SystemExit(f"✗ 缺少顶部注释：{text[:60]}")
    body = m.group(1)
    parts = [p.strip() for p in body.split("|")]
    if len(parts) < 3:
        raise SystemExit(f"✗ 顶部注释格式不对：{body[:80]}")

    names = [p.strip() for p in parts[0].split("/")]
    zh, en = names[0], (names[1] if len(names) > 1 else names[0])
    standard = parts[1].strip()

    canvas = re.search(r"画布\s*([\d.]+)\s*[x×]\s*([\d.]+)", body)
    if not canvas:
        raise SystemExit(f"✗ 注释里没有画布尺寸：{body[:80]}")

    pins_m = PINS_IN_COMMENT_RE.search(body)
    if not pins_m:
        raise SystemExit(f"✗ 注释里没有引脚坐标：{body[:80]}")
    pins_canvas = [(float(a), float(b)) for a, b in PAIR_RE.findall(pins_m.group(1))]
    if not pins_canvas:
        raise SystemExit(f"✗ 引脚坐标解析失败：{pins_m.group(1)[:60]}")

    return {
        "name": {"zh": zh, "en": en},
        "standard": standard,
        "canvas": {"w": float(canvas.group(1)), "h": float(canvas.group(2))},
        "pins_canvas": pins_canvas,
    }


def parse_origin(text: str) -> tuple[float, float]:
    m = ORIGIN_RE.search(text)
    if not m:
        raise SystemExit("✗ 找不到 <g transform=\"translate(x,y)\">")
    return float(m.group(1)), float(m.group(2))


def parse_pins_table(text: str) -> dict[str, list[tuple[float, float]]]:
    """kit 的 build/make-symbols.py 里的 PINS（局部坐标）"""
    m = re.search(r"^PINS\s*=\s*\{(.*?)^\}", text, re.S | re.M)
    if not m:
        raise SystemExit("✗ 在 make-symbols.py 里找不到 PINS 表")
    table: dict[str, list[tuple[float, float]]] = {}
    for num, body in re.findall(r'"(\d+)"\s*:\s*\[(.*?)\]', m.group(1), re.S):
        nums = [float(n) for n in NUM_RE.findall(body)]
        table[num] = list(zip(nums[0::2], nums[1::2]))
    return table


def main() -> int:
    check = "--check" in sys.argv
    overrides = json.loads(OVERRIDES.read_text(encoding="utf-8"))
    pins_table = parse_pins_table(MAKE_SYMBOLS.read_text(encoding="utf-8"))

    symbols: dict[str, dict] = {}
    problems: list[str] = []

    svg_files = sorted(SYMBOLS_DIR.glob("*.svg")) + sorted(EXT_DIR.glob("*.svg"))
    for svg in svg_files:
        is_ext = svg.parent == EXT_DIR
        num, slug = svg.stem.split("-", 1)
        if slug not in overrides:
            problems.append(f"{svg.name}: symbols/overrides.json 里没有 `{slug}` 这一项")
            continue
        text = svg.read_text(encoding="utf-8")
        meta = parse_comment(text)
        ox, oy = parse_origin(text)
        ov = overrides[slug]

        # 画布坐标 → 局部坐标
        local = [(round(cx - ox, 4), round(cy - oy, 4)) for cx, cy in meta["pins_canvas"]]

        # ① 与 kit 的 PINS 表交叉校验（同一顺序）；扩展符号不在 kit 里，跳过
        kit = None if is_ext else pins_table.get(num)
        if kit is None and not is_ext:
            problems.append(f"{slug}: make-symbols.py 的 PINS 表里没有 {num}")
        elif kit is not None:
            want = [(round(x, 4), round(y, 4)) for x, y in kit]
            # 允许符号相对 kit 原稿做镜像（在 overrides 里显式声明 `kit_mirror`）
            flip = ov.get("kit_mirror")
            if flip == "x":
                want = [(-x, y) for x, y in want]
            elif flip == "y":
                want = [(x, -y) for x, y in want]
            if want != local:
                problems.append(
                    f"{slug}: 注释坐标 {local} ≠ PINS 表 {want}（差 {[(round(a[0]-b[0],3), round(a[1]-b[1],3)) for a,b in zip(local,want)]}）"
                )

        # ② 用 overrides 的坐标 key 取引脚名
        pins = []
        for (x, y) in local:
            k = key(x, y)
            pid = ov["pins"].get(k)
            if pid is None:
                problems.append(f"{slug}: overrides 里没有局部坐标 {k} 的引脚名（改了图形？同步改 overrides）")
                continue
            if x % GRID or y % GRID:
                problems.append(f"{slug}: 引脚 {k} 不在 {GRID} mm 栅格上")
            # 方向：按局部坐标的主导轴（只用于 hover 热点与吸附提示）
            if abs(x) >= abs(y):
                d = "left" if x < 0 else "right"
            else:
                d = "up" if y < 0 else "down"
            pins.append({"id": pid, "at": {"x": x, "y": y}, "dir": d})

        # ③ pinOrder 必须恰好覆盖 pins
        order = ov["spice"]["pinOrder"]
        ids = [p["id"] for p in pins]
        if sorted(order) != sorted(ids):
            problems.append(f"{slug}: pinOrder {order} 与引脚 {ids} 不匹配（必须一一对应）")
        if len(set(ids)) != len(ids):
            problems.append(f"{slug}: 引脚名重复 {ids}")
        if len(ov["pins"]) != len(local):
            problems.append(f"{slug}: overrides 里有 {len(ov['pins'])} 个引脚，素材里有 {len(local)} 个")

        entry = {
            "file": (
                f"assets/gb4728-ext/symbols/{svg.name}"
                if is_ext
                else f"assets/gb4728-symbols-kit/symbols/{svg.name}"
            ),
            "name": meta["name"],
            "standard": meta["standard"],
            "canvas": meta["canvas"],
            "origin": {"x": ox, "y": oy},
            "pins": pins,
            "spice": ov["spice"],
            "models": ov.get("models", []),
            "category": ov["category"],
        }
        if "netName" in ov:
            entry["netName"] = ov["netName"]
        if "port" in ov:
            entry["port"] = ov["port"]
        symbols[slug] = entry

    out = {"version": VERSION, "grid": GRID, "unit": "mm", "symbols": symbols}
    text = json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True) + "\n"

    if problems:
        print("✗ 符号清单校验失败：", file=sys.stderr)
        for p in problems:
            print("  - " + p, file=sys.stderr)
        return 1

    if check:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != text:
            print("✗ symbols/symbols.json 已过期：请跑 ./tools/gen-symbols.py", file=sys.stderr)
            return 1
        print(f"✓ symbols.json 无漂移（{len(symbols)} 个符号）")
        return 0

    OUT.write_text(text, encoding="utf-8")
    print(f"✓ 写入 {OUT.relative_to(ROOT)}（{len(symbols)} 个符号）")
    for slug, e in symbols.items():
        pins = " ".join(p["id"] for p in e["pins"])
        print(f"  {slug:15s} {len(e['pins'])} 脚 [{pins}]  models={len(e['models'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
