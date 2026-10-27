// SVG 渲染：栅格、元件、导线、光标预览、选中态。
//
// 全部用原生 SVG DOM（不引框架）。坐标系：1 单位 = 1 mm，视图变换只改 <g> 的 transform。

import { GRID, toWorld, type Doc, type Part, type Vec } from "./model";
import type { SymbolSpec, SymbolTable } from "./symbols";

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
  /** 悬空引脚的世界坐标（画红圈，来自后端 lint） */
  dangling?: { at: Vec; label: string }[];
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

  // ---- 悬空引脚：红圈 ----
  if (o.dangling?.length) {
    const g = el("g");
    g.setAttribute("class", "dangling");
    for (const d of o.dangling) {
      const c = el("circle");
      const p = mmToScreen(d.at, view);
      c.setAttribute("cx", `${p.x}`);
      c.setAttribute("cy", `${p.y}`);
      c.setAttribute("r", `${Math.max(4, view.scale * 1.4)}`);
      c.append(el("title"));
      (c.firstChild as SVGElement).textContent = d.label;
      g.append(c);
    }
    root.append(g);
  }

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
  // 外层 wrapper 不带变换；里面两个子组：
  //   artG  —— 平移+缩放+旋转+镜像（只作用在图形上）
  //   labels —— 只缩放不旋转（位号/数值必须保持正向，prompt.md）
  const wrapper = el("g");
  wrapper.dataset["partId"] = part.id;
  if (selected) wrapper.classList.add("selected");
  if (!sym) return wrapper;

  const p = mmToScreen(part.at, view);
  const artG = el("g");
  const mirror = part.mirror === "x" ? "scale(-1,1)" : part.mirror === "y" ? "scale(1,-1)" : "";
  artG.setAttribute("transform", `translate(${p.x} ${p.y}) scale(${view.scale}) rotate(${part.rot}) ${mirror}`);

  const a = art(sym.file);
  if (a) {
    const nested = el("svg");
    nested.setAttribute("x", `${-sym.origin.x}`);
    nested.setAttribute("y", `${-sym.origin.y}`);
    nested.setAttribute("width", `${sym.canvas.w}`);
    nested.setAttribute("height", `${sym.canvas.h}`);
    nested.setAttribute("viewBox", a.viewBox);
    nested.setAttribute("overflow", "visible");
    nested.innerHTML = a.inner;
    artG.append(nested);
  }

  // 引脚热点（hover / 选中时可见；也是"导线吸附点"的提示）
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
  artG.append(pinsG);
  wrapper.append(artG);

  const labelG = el("g");
  labelG.setAttribute("class", "labels");
  // 位号用世界坐标 → 要带上同样的平移与缩放（只是不旋转）
  labelG.setAttribute("transform", `translate(${view.pan.x} ${view.pan.y}) scale(${view.scale})`);
  const anchor = labelAnchor(part, sym);
  const vertical = sym.canvas.h > sym.canvas.w;
  const ref = el("text");
  ref.setAttribute("x", `${anchor.x}`);
  if (vertical) ref.setAttribute("text-anchor", "start");
  ref.setAttribute("y", `${anchor.y}`);
  ref.setAttribute("class", "ref");
  if (!vertical) ref.setAttribute("text-anchor", "middle");
  ref.textContent = part.alias ? `${part.ref} (${part.alias})` : part.ref;
  labelG.append(ref);

  if (part.value || part.model) {
    const v = el("text");
    v.setAttribute("x", `${anchor.x}`);
    v.setAttribute("y", `${anchor.y + 3.4}`);
    v.setAttribute("class", "value");
    if (vertical) v.setAttribute("text-anchor", "start");
    else v.setAttribute("text-anchor", "middle");
    v.textContent = part.value ?? part.model ?? "";
    labelG.append(v);
  }
  wrapper.append(labelG);
  return wrapper;
}

/** 位号锚点：元件"旋转后的画布包围盒"底部中心 + 2.5 mm */
export function labelAnchor(part: Part, sym: SymbolSpec): Vec {
  const corners: Vec[] = [
    { x: -sym.origin.x, y: -sym.origin.y },
    { x: sym.canvas.w - sym.origin.x, y: -sym.origin.y },
    { x: -sym.origin.x, y: sym.canvas.h - sym.origin.y },
    { x: sym.canvas.w - sym.origin.x, y: sym.canvas.h - sym.origin.y },
  ].map((c) => toWorld(c, part));
  const minX = Math.min(...corners.map((c) => c.x));
  const maxX = Math.max(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const maxY = Math.max(...corners.map((c) => c.y));
  // 竖放的元件（如旋转 90° 的电容）把位号放右边，避免压到连线上
  if (maxY - minY > maxX - minX) {
    return { x: maxX + 2.5, y: (minY + maxY) / 2 };
  }
  return { x: (minX + maxX) / 2, y: maxY + 2.5 };
}

/** 把内容装进视口（载入示例/新建后调用） */
export function fitView(
  doc: Doc,
  table: SymbolTable,
  viewport: { w: number; h: number },
): View {
  const pts: Vec[] = [];
  for (const p of doc.parts) {
    const sym = table.symbols[p.symbol];
    if (!sym) continue;
    for (const pin of sym.pins) pts.push(toWorld(pin.at, p));
    pts.push(p.at);
  }
  for (const w of doc.wires) pts.push(...w.points);
  if (!pts.length) return { scale: 8, pan: { x: 120, y: 100 } };

  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const pad = 15; // mm
  const w = Math.max(maxX - minX + pad * 2, 40);
  const h = Math.max(maxY - minY + pad * 2, 30);
  const scale = Math.min(viewport.w / w, viewport.h / h, 24);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { scale, pan: { x: viewport.w / 2 - cx * scale, y: viewport.h / 2 - cy * scale } };
}

/** 元件所有引脚的世界坐标（网表/连线判定唯一来源） */
export function pinWorld(part: Part, table: SymbolTable): { id: string; at: Vec }[] {
  const sym = table.symbols[part.symbol];
  if (!sym) return [];
  return sym.pins.map((p) => ({ id: p.id, at: toWorld(p.at, part) }));
}
