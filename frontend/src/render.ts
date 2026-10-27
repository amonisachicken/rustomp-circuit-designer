// SVG 渲染：栅格、元件、导线、光标预览、选中态。
//
// 全部用原生 SVG DOM（不引框架）。坐标系：1 单位 = 1 mm，视图变换只改 <g> 的 transform。

import { GRID, toWorld, type Doc, type Part, type Vec } from "./model";
import type { SymbolTable } from "./symbols";

const NS = "http://www.w3.org/2000/svg";
export const el = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  document.createElementNS(NS, tag);

export interface View {
  /** 每毫米多少像素 */
  scale: number;
  /** 画布原点在屏幕上的偏移（px） */
  pan: { x: number; y: number };
}

export interface RenderOpts {
  doc: Doc;
  table: SymbolTable;
  art: (file: string) => { viewBox: string; inner: string } | undefined;
  view: View;
  selectedId?: string | null;
  /** 手持中的元件（放置/移动模式） */
  ghost?: { part: Part; at: Vec; valid: boolean } | null;
  /** 正在画的导线（第一锚点已定） */
  wirePreview?: { from: Vec; to: Vec } | null;
}

export function mmToScreen(p: Vec, view: View): Vec {
  return { x: p.x * view.scale + view.pan.x, y: p.y * view.scale + view.pan.y };
}

export function screenToMm(p: Vec, view: View): Vec {
  return { x: (p.x - view.pan.x) / view.scale, y: (p.y - view.pan.y) / view.scale };
}

export function render(root: SVGSVGElement, o: RenderOpts): void {
  const { doc, table, art, view } = o;
  root.replaceChildren();

  // ---- 栅格（2.5 mm）----
  const gridG = el("g");
  gridG.setAttribute("class", "grid");
  const wPx = root.clientWidth || 1200;
  const hPx = root.clientHeight || 800;
  const tl = screenToMm({ x: 0, y: 0 }, view);
  const br = screenToMm({ x: wPx, y: hPx }, view);
  const x0 = Math.floor(tl.x / GRID) * GRID;
  const y0 = Math.floor(tl.y / GRID) * GRID;
  // 每 4 格（10 mm）加粗一根，方便数格
  for (let x = x0; x <= br.x; x += GRID) {
    const major = Math.abs(x / GRID) % 4 === 0;
    const a = mmToScreen({ x, y: tl.y }, view);
    const b = mmToScreen({ x, y: br.y }, view);
    const line = el("line");
    line.setAttribute("x1", `${a.x}`);
    line.setAttribute("y1", `${a.y}`);
    line.setAttribute("x2", `${b.x}`);
    line.setAttribute("y2", `${b.y}`);
    if (major) line.setAttribute("class", "major");
    gridG.append(line);
  }
  for (let y = y0; y <= br.y; y += GRID) {
    const major = Math.abs(y / GRID) % 4 === 0;
    const a = mmToScreen({ x: tl.x, y }, view);
    const b = mmToScreen({ x: br.x, y }, view);
    const line = el("line");
    line.setAttribute("x1", `${a.x}`);
    line.setAttribute("y1", `${a.y}`);
    line.setAttribute("x2", `${b.x}`);
    line.setAttribute("y2", `${b.y}`);
    if (major) line.setAttribute("class", "major");
    gridG.append(line);
  }
  root.append(gridG);

  // ---- 导线 ----
  const wireG = el("g");
  wireG.setAttribute("class", "wires");
  for (const w of doc.wires) {
    const [p, q] = w.points;
    const a = mmToScreen(p, view);
    const b = mmToScreen(q, view);
    const line = el("line");
    line.setAttribute("x1", `${a.x}`);
    line.setAttribute("y1", `${a.y}`);
    line.setAttribute("x2", `${b.x}`);
    line.setAttribute("y2", `${b.y}`);
    line.dataset["wireId"] = w.id;
    if (w.id === o.selectedId) line.classList.add("selected");
    wireG.append(line);
  }
  if (o.wirePreview) {
    const a = mmToScreen(o.wirePreview.from, view);
    const b = mmToScreen(o.wirePreview.to, view);
    const line = el("line");
    line.setAttribute("x1", `${a.x}`);
    line.setAttribute("y1", `${a.y}`);
    line.setAttribute("x2", `${b.x}`);
    line.setAttribute("y2", `${b.y}`);
    line.setAttribute("class", "preview");
    wireG.append(line);
  }
  root.append(wireG);

  // ---- 元件 ----
  const partG = el("g");
  partG.setAttribute("class", "parts");
  for (const part of doc.parts) {
    partG.append(renderPart(part, table, art, view, part.id === o.selectedId));
  }
  root.append(partG);

  // ---- 手持的元件（半透明预览）----
  if (o.ghost) {
    const g = renderPart({ ...o.ghost.part, at: o.ghost.at }, table, art, view, false);
    g.setAttribute("class", `ghost ${o.ghost.valid ? "ok" : "bad"}`);
    root.append(g);
  }
}

function renderPart(
  part: Part,
  table: SymbolTable,
  art: (file: string) => { viewBox: string; inner: string } | undefined,
  view: View,
  selected: boolean,
): SVGGElement {
  const sym = table.symbols[part.symbol];
  const g = el("g");
  g.dataset["partId"] = part.id;
  if (selected) g.classList.add("selected");
  if (!sym) return g;

  const a = art(sym.file);
  const p = mmToScreen(part.at, view);
  g.setAttribute("transform", `translate(${p.x} ${p.y}) scale(${view.scale}) rotate(${part.rot}) ${
    part.mirror === "x" ? "scale(-1,1)" : part.mirror === "y" ? "scale(1,-1)" : ""
  }`);

  if (a) {
    // 素材的 viewBox 是画布坐标；把它平移成"以符号原点为中心"
    const nested = el("svg");
    nested.setAttribute("x", `${-sym.origin.x}`);
    nested.setAttribute("y", `${-sym.origin.y}`);
    nested.setAttribute("width", `${sym.canvas.w}`);
    nested.setAttribute("height", `${sym.canvas.h}`);
    nested.setAttribute("viewBox", a.viewBox);
    nested.setAttribute("overflow", "visible");
    nested.innerHTML = a.inner;
    g.append(nested);
  }

  // 引脚热点（hover 用；也是"导线吸附点"的视觉提示）
  const pinsG = el("g");
  pinsG.setAttribute("class", "pins");
  for (const pin of sym.pins) {
    const c = el("circle");
    c.setAttribute("cx", `${pin.at.x}`);
    c.setAttribute("cy", `${pin.at.y}`);
    c.setAttribute("r", `${0.7}`);
    c.dataset["pin"] = pin.id;
    pinsG.append(c);
  }
  g.append(pinsG);

  // 参考编号（浮在位号；别名默认不显示 —— prompt.md）
  const label = el("text");
  label.setAttribute("x", `${sym.canvas.w / 2 - sym.origin.x}`);
  label.setAttribute("y", `${sym.canvas.h - sym.origin.y + 2.5}`);
  label.setAttribute("class", "ref");
  label.setAttribute("text-anchor", "middle");
  label.textContent = part.ref;
  g.append(label);

  // 数值（可选显示）
  if (part.value || part.model) {
    const v = el("text");
    v.setAttribute("x", `${sym.canvas.w / 2 - sym.origin.x}`);
    v.setAttribute("y", `${sym.canvas.h - sym.origin.y + 5.5}`);
    v.setAttribute("class", "value");
    v.setAttribute("text-anchor", "middle");
    v.textContent = part.value ?? part.model ?? "";
    g.append(v);
  }

  return g;
}

/** 元件所有引脚的世界坐标（网表/连线判定唯一来源） */
export function pinWorld(part: Part, table: SymbolTable): { id: string; at: Vec }[] {
  const sym = table.symbols[part.symbol];
  if (!sym) return [];
  return sym.pins.map((p) => ({ id: p.id, at: toWorld(p.at, part) }));
}
