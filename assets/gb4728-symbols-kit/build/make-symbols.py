#!/usr/bin/env python3
"""从总图 gb4728-schematic-symbols.svg 拆出 10 个独立符号（无背景素材）。

用法:
    python build/make-symbols.py build   # 生成 symbols/*.svg
    python build/make-symbols.py check   # 校验 PNG 透明通道与引脚栅格

画布规则:
    取符号（含管脚标注文字）外接矩形，向外取整到 2.5 mm 栅格，再留 2.5 mm 边距。
    因平移量也是 2.5 的整数倍，符号引脚端点在新画布中依然落在 2.5 mm 格点上。
"""
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
from copy import deepcopy

MASTER = "gb4728-schematic-symbols.svg"
OUTDIR = "symbols"
MOD = 2.5

NS = "{http://www.w3.org/2000/svg}"
NS_I = "{http://www.inkscape.org/namespaces/inkscape}"

# 目录号 -> (文件名, 中文名, 英文名, 标准分部)
META = {
    "01": ("resistor",       "电阻器",             "Resistor",              "GB/T 4728.4"),
    "02": ("capacitor",      "电容器（无极）",     "Capacitor",             "GB/T 4728.4"),
    "03": ("potentiometer",  "电位器",             "Potentiometer",         "GB/T 4728.4"),
    "04": ("diode",          "二极管",             "Diode",                 "GB/T 4728.5"),
    "05": ("led",            "发光二极管",         "Light Emitting Diode",  "GB/T 4728.5"),
    "06": ("voltage-source", "电压源",             "Voltage Source",        "GB/T 4728.6"),
    "07": ("npn",            "NPN 型晶体管",       "NPN Transistor",        "GB/T 4728.5"),
    "08": ("pnp",            "PNP 型晶体管",       "PNP Transistor",        "GB/T 4728.5"),
    "09": ("jfet-n",         "N 沟道结型场效应管", "N-channel JFET",        "GB/T 4728.5"),
    "10": ("mosfet-n",       "N 沟道增强型 MOSFET", "N-channel E-MOSFET",   "GB/T 4728.5"),
    "11": ("opamp",          "运算放大器",         "Operational Amplifier", "GB/T 4728.13"),
    "12": ("earth",          "接地",               "Ground",                "GB/T 4728.2"),
    "13": ("vcc",            "Vcc 电源端",         "Supply Vcc",            "GB/T 4728.3"),
    "14": ("vee",            "Vee 电源端",         "Supply Vee",            "GB/T 4728.3"),
    "15": ("node-in",        "In 节点",            "Input Node",            "GB/T 4728.3"),
    "16": ("node-out",       "Out 节点",           "Output Node",           "GB/T 4728.3"),
}

# 各符号引脚端点（相对符号中心的局部坐标）
PINS = {
    "01": [(-12.5, 0), (12.5, 0)],
    "02": [(-12.5, 0), (12.5, 0)],
    "03": [(-12.5, 0), (5, -12.5), (12.5, 0)],
    "04": [(-12.5, 0), (12.5, 0)],
    "05": [(-12.5, 0), (12.5, 0)],
    "06": [(0, -12.5), (0, 12.5)],
    "07": [(-12.5, 0), (2.5, -12.5), (2.5, 12.5)],
    "08": [(-12.5, 0), (2.5, -12.5), (2.5, 12.5)],
    "09": [(-12.5, 0), (2.5, -12.5), (2.5, 12.5)],
    "10": [(-12.5, 0), (5, -12.5), (5, 12.5)],
    "11": [(-15, -5), (-15, 5), (15, 0), (0, -12.5), (0, 12.5)],
    "12": [(0, -12.5)],
    "13": [(0, 12.5)],
    "14": [(0, -12.5)],
    "15": [(-12.5, 0)],
    "16": [(-12.5, 0)],
}


def parse_path(d):
    nums = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", d)]
    return [(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]


def collect(el, anchor, out):
    anchor = el.get("text-anchor") or anchor
    for ch in el:
        tag = ch.tag.split("}")[-1]
        if tag == "g":
            collect(ch, anchor, out)
            continue
        if tag == "line":
            out += [(float(ch.get("x1")), float(ch.get("y1"))),
                    (float(ch.get("x2")), float(ch.get("y2")))]
        elif tag == "rect":
            x, y = float(ch.get("x")), float(ch.get("y"))
            w, h = float(ch.get("width")), float(ch.get("height"))
            out += [(x, y), (x + w, y + h)]
        elif tag == "circle":
            cx, cy, r = float(ch.get("cx")), float(ch.get("cy")), float(ch.get("r"))
            out += [(cx - r, cy), (cx + r, cy), (cx, cy - r), (cx, cy + r)]
        elif tag == "path":
            out += parse_path(ch.get("d"))
        elif tag == "text":
            x, y = float(ch.get("x", 0)), float(ch.get("y", 0))
            fs = float(ch.get("font-size", 3))
            s = "".join(ch.itertext())
            w = 0.62 * fs * len(s)      # 保守估计，宁大勿小
            a = ch.get("text-anchor") or anchor
            x0 = x - w / 2 if a == "middle" else (x - w if a == "end" else x)
            out += [(x0, y - 0.78 * fs), (x0 + w, y + 0.22 * fs)]


def snap_lo(v):
    return math.floor((v - MOD) / MOD) * MOD


def snap_hi(v):
    return math.ceil((v + MOD) / MOD) * MOD


def build():
    root = ET.parse(MASTER).getroot()
    layer = None
    for el in root.iter(NS + "g"):
        if el.get("id") == "layer-symbols":
            layer = el
    if layer is None:
        sys.exit("未找到 layer-symbols 图层")
    global INHERITED
    INHERITED = {k: layer.get(k) for k in
                 ("fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin")
                 if layer.get(k)}
    groups = {}
    for g in root.iter(NS + "g"):
        label = g.get(NS_I + "label") or ""
        m = re.match(r"(\d\d)\s", label)
        if m and m.group(1) in META and g.get("transform"):
            groups[m.group(1)] = g
    if len(groups) != len(META):
        sys.exit(f"找到 {len(groups)} 个符号组，预期 {len(META)} 个")

    os.makedirs(OUTDIR, exist_ok=True)
    report = []
    for num in sorted(META):
        name, cn, en, std = META[num]
        g = groups[num]
        m = re.match(r"translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)", g.get("transform"))
        cx, cy = float(m.group(1)), float(m.group(2))

        pts = []
        collect(g, None, pts)
        xmin = min(p[0] for p in pts) + cx
        xmax = max(p[0] for p in pts) + cx
        ymin = min(p[1] for p in pts) + cy
        ymax = max(p[1] for p in pts) + cy

        xs, xe = snap_lo(xmin), snap_hi(xmax)
        ys, ye = snap_lo(ymin), snap_hi(ymax)
        W, H = xe - xs, ye - ys
        dx, dy = cx - xs, cy - ys

        pins = [(round(px + dx, 3), round(py + dy, 3)) for px, py in PINS[num]]
        for px, py in pins:
            assert abs(px / MOD - round(px / MOD)) < 1e-6, (num, px)
            assert abs(py / MOD - round(py / MOD)) < 1e-6, (num, py)

        clone = deepcopy(g)
        clone.attrib.pop(NS_I + "label", None)
        clone.set("transform", f"translate({round(dx, 3)},{round(dy, 3)})")
        # 补齐原本从父图层继承的呈现属性，否则 fill 默认黑、stroke 默认无
        for k, v in INHERITED.items():
            if clone.get(k) is None:
                clone.set(k, v)

        pin_txt = " ".join(f"({p[0]:g},{p[1]:g})" for p in pins)
        comment = (f"<!-- {cn} / {en} | {std} | 画布 {W:g} x {H:g} mm "
                   f"(2.5 mm 栅格) | 引脚: {pin_txt} -->")

        ET.register_namespace("", "http://www.w3.org/2000/svg")
        new_root = ET.Element(NS + "svg", {
            "width": f"{W:g}mm",
            "height": f"{H:g}mm",
            "viewBox": f"0 0 {W:g} {H:g}",
        })
        new_root.append(clone)
        body = ET.tostring(new_root, encoding="unicode")

        doc = ('<?xml version="1.0" encoding="UTF-8"?>\n'
               f"{comment}\n{body}\n")
        fn = os.path.join(OUTDIR, f"{num}-{name}.svg")
        with open(fn, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(doc)
        report.append((f"{num}-{name}", W, H, len(pins)))

    print(f"{'asset':<18}{'W/mm':>7}{'H/mm':>7}{'pins':>6}")
    for r in report:
        print(f"{r[0]:<18}{r[1]:>7g}{r[2]:>7g}{r[3]:>6}")


def check():
    ok = True
    print(f"{'asset':<18}{'WxH px':>14}  {'RGBA':<5}{'透明角':<7}")
    for fn in sorted(os.listdir(OUTDIR)):
        if not fn.endswith(".png"):
            continue
        p = os.path.join(OUTDIR, fn)
        data = open(p, "rb").read()
        w = int.from_bytes(data[16:20], "big")
        h = int.from_bytes(data[20:24], "big")
        ctype = data[25]
        rgba = ctype in (4, 6)
        ok &= rgba
        print(f"{fn[:-4]:<18}{f'{w}x{h}':>14}  {'yes' if rgba else 'NO':<5}")
    if not ok:
        sys.exit("存在无 alpha 通道的 PNG")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "build"
    build() if mode == "build" else check()
