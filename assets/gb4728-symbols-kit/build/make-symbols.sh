#!/usr/bin/env bash
# 拆分独立符号素材：SVG（无背景）+ PNG（透明底，1200 dpi），并校验
set -e
cd "$(dirname "$0")/.."
INK="/c/Program Files/Inkscape/bin/inkscape.exe"

python build/make-symbols.py build

for f in symbols/*.svg; do
  "$INK" "$f" --export-type=png --export-filename="${f%.svg}.png" \
         --export-dpi=1200 --export-background-opacity=0
done

python build/make-symbols.py check
ls -l symbols/ | head -5
