#!/usr/bin/env python3
"""校验：每个符号组内所有图形端点换算到绝对坐标后，是否落在 2.5 mm 栅格上。

用法: python build/check-grid.py

对每个带 inkscape:label 的符号组，统计绝对坐标中出现过的所有 x / y 值，
标出"不是 2.5 整数倍"的坐标，用于人工确认它们只是符号本体轮廓（允许），
而非引脚端点（不允许）。
"""
import re
import sys
import xml.etree.ElementTree as ET

SVG = "gb4728-schematic-symbols.svg"
NS = "{http://www.inkscape.org/namespaces/inkscape}"
MOD = 2.5
EPS = 1e-6


def on_grid(v):
    return abs(v / MOD - round(v / MOD)) < EPS


def local_points(el):
    pts = []
    tag = el.tag.split("}")[-1]
    if tag == "line":
        for k in ("x1", "y1"):
            pass
        pts += [(float(el.get("x1")), float(el.get("y1"))),
                (float(el.get("x2")), float(el.get("y2")))]
    elif tag == "rect":
        x, y = float(el.get("x")), float(el.get("y"))
        w, h = float(el.get("width")), float(el.get("height"))
        pts += [(x, y), (x + w, y + h)]
    elif tag == "circle":
        cx, cy, r = float(el.get("cx")), float(el.get("cy")), float(el.get("r"))
        pts += [(cx - r, cy), (cx + r, cy), (cx, cy - r), (cx, cy + r)]
    elif tag == "path":
        nums = [float(n) for n in re.findall(r"-?\d+\.?\d*", el.get("d"))]
        pts += [(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
    return pts


def walk(el, pts):
    for child in el:
        tag = child.tag.split("}")[-1]
        if tag in ("g", "text"):
            if tag == "g":
                walk(child, pts)
            continue
        if tag in ("line", "rect", "circle", "path"):
            pts += local_points(child)


root = ET.parse(SVG).getroot()
rows = []
for g in root.iter():
    label = g.get(NS + "label")
    tr = g.get("transform") or ""
    m = re.match(r"translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)", tr)
    if not label or not m or not re.match(r"\d\d", label):
        continue
    tx, ty = float(m.group(1)), float(m.group(2))
    if not (on_grid(tx) and on_grid(ty)):
        print("GROUP ORIGIN OFF GRID:", label, tx, ty)
    pts = []
    walk(g, pts)
    absx = sorted({round(tx + p[0], 3) for p in pts})
    absy = sorted({round(ty + p[1], 3) for p in pts})
    xmin, xmax, ymin, ymax = absx[0], absx[-1], absy[0], absy[-1]
    rows.append((label, xmin, xmax, ymin, ymax,
                 on_grid(xmin), on_grid(xmax), on_grid(ymin), on_grid(ymax)))

print(f"{'symbol':<22}{'xmin':>8}{'xmax':>8}{'ymin':>8}{'ymax':>8}   bbox edges on grid (x-,x+,y-,y+)")
bad = 0
for r in rows:
    flags = "".join("Y" if v else "n" for v in r[5:])
    print(f"{r[0]:<22}{r[1]:>8}{r[2]:>8}{r[3]:>8}{r[4]:>8}   {flags}")
print()
print("note: 'n' 只允许出现在符号本体轮廓方向（如电阻/二极管的上下边），引脚端点必须为 Y")
sys.exit(0)
