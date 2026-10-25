#!/usr/bin/env python3
"""检查 symbols/*.png 是否真的透明：四角像素 alpha 必须为 0，且存在不透明笔画。"""
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow 不可用，跳过像素级校验")

d = "symbols"
rows = []
for fn in sorted(os.listdir(d)):
    if not fn.endswith(".png"):
        continue
    im = Image.open(os.path.join(d, fn)).convert("RGBA")
    w, h = im.size
    corners = [im.getpixel(p)[3] for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
    alpha = im.getchannel("A")
    lo, hi = alpha.getextrema()
    rows.append((fn[:-4], w, h, max(corners), lo, hi))

print(f"{'asset':<18}{'WxH':>12}{'角alpha':>9}{'min':>5}{'max':>5}  verdict")
bad = 0
for name, w, h, corner, lo, hi in rows:
    ok = corner == 0 and hi == 255
    bad += 0 if ok else 1
    print(f"{name:<18}{f'{w}x{h}':>12}{corner:>9}{lo:>5}{hi:>5}  {'透明背景 OK' if ok else 'FAIL'}")
sys.exit(1 if bad else 0)
