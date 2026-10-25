#!/usr/bin/env python3
"""把 symbols/ 下的 SVG 与 PNG 打包为 symbols.zip（保留目录结构）。"""
import os
import zipfile

OUT = "symbols.zip"
SRC = "symbols"

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for fn in sorted(os.listdir(SRC)):
        if fn.lower().endswith((".svg", ".png")):
            z.write(os.path.join(SRC, fn), arcname=os.path.join("symbols", fn))

size = os.path.getsize(OUT)
print(f"{OUT}: {size/1024:.1f} KB, {len(zipfile.ZipFile(OUT).namelist())} files")
