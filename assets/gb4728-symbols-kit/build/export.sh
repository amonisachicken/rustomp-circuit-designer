#!/usr/bin/env bash
# 交付导出：SVG（Inkscape 可编辑）→ 300 dpi PNG + A4 PDF
set -e
cd "$(dirname "$0")/.."
INK="/c/Program Files/Inkscape/bin/inkscape.exe"
OUT="gb4728-schematic-symbols"

"$INK" "$OUT.svg" --export-type=png --export-filename="$OUT.png" --export-dpi=300
"$INK" "$OUT.svg" --export-type=pdf --export-filename="$OUT.pdf"
ls -l "$OUT".*
