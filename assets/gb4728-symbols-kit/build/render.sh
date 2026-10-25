#!/usr/bin/env bash
# 渲染整页预览 + 三行条带 + 引脚对格放大图（用于目视校核）
set -e
cd "$(dirname "$0")/.."          # 项目根目录
INK="/c/Program Files/Inkscape/bin/inkscape.exe"
SVG="gb4728-schematic-symbols.svg"
mkdir -p out

# Inkscape --export-area 以 px 计（1 mm = 3.7795275591 px）
area() { awk -v a="$1" -v b="$2" -v c="$3" -v d="$4" \
  'BEGIN{printf "%.2f:%.2f:%.2f:%.2f", a*3.7795275591, b*3.7795275591, c*3.7795275591, d*3.7795275591}'; }

"$INK" "$SVG" --export-type=png --export-filename=out/preview.png --export-dpi=170

# 三行条带（600 dpi）
"$INK" "$SVG" --export-type=png --export-filename=out/row1.png --export-area=$(area 14 42 284 90)   --export-dpi=600
"$INK" "$SVG" --export-type=png --export-filename=out/row2.png --export-area=$(area 14 86 284 134)  --export-dpi=600
"$INK" "$SVG" --export-type=png --export-filename=out/row3.png --export-area=$(area 14 128 284 176) --export-dpi=600

# 栅格对齐自检：放大到单个引脚，确认端点压在格线交点上
"$INK" "$SVG" --export-type=png --export-filename=out/grid-pin-h.png --export-area=$(area 19 56 27 64)    --export-dpi=1200
"$INK" "$SVG" --export-type=png --export-filename=out/grid-pin-v.png --export-area=$(area 248 86 257 96)  --export-dpi=1200
echo "render ok -> out/"
