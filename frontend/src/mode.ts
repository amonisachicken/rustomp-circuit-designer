// 模态状态机（D-009）。所有编辑都在"模式"里发生，esc 永远回到查看模式。
//
//   查看 / 放置(r,c,库,symbol) / 画线(w) / 删除(q) / 移动(m) / 复制(d)
//
// 一次落点 = 一步撤销（连续放 10 个电阻 = 10 步）。

import {
  GRID,
  nextId,
  nextRef,
  snap,
  toWorld,
  trimWireBetweenPins,
  type Doc,
  type Mirror,
  type Part,
  type Rot,
  type Vec,
} from "./model";
import type { SymbolTable } from "./symbols";

export type Mode =
  | { kind: "view" }
  | { kind: "place"; symbol: string; at: Vec; rot: Rot; mirror: Mirror; attrs?: PartAttrs }
  | { kind: "wire"; from: Vec | null }
  | { kind: "delete" }
  | { kind: "move"; partId: string; origin: Part; at: Vec }
  | { kind: "copy" }; // 等待"点一个元件"进入 place

/**
 * 会随「d 复制」一起搬过去的元件属性（位号/位置/符号/旋转由其它字段管）。
 * 数值与型号是主要目标；别名（电位器）与 IN 的波形发生器参数也一并带上 ——
 * 否则复制一个 0.5 V / 1 kHz 的 IN 会悄悄变回默认值。
 */
export type PartAttrs = Pick<Part, "value" | "model" | "alias" | "amp" | "freq">;

export interface EditorHooks {
  doc: Doc;
  table: SymbolTable;
  commit(): void; // 压一步撤销（在改动**之前**调）
  changed(): void;
  setMode(m: Mode): void;
  status(text: string): void;
}

const rotStep = (r: Rot): Rot => (((r + 90) % 360) as Rot);

/** 默认值（新落元件时用；可在属性面板改） */
const DEFAULTS: Record<string, Partial<Part>> = {
  resistor: { value: "10k" },
  capacitor: { value: "100n" },
  potentiometer: { value: "500k" },
  diode: { model: "1N4148" },
  led: { model: "LedRed" },
  npn: { model: "BC549C" },
  pnp: { model: "BC559C" },
  "jfet-n": { model: "J201" },
  "mosfet-n": { model: "2N7000" },
  opamp: { model: "OP07A" },
};

export function enterPlace(
  symbol: string,
  table: SymbolTable,
  hooks: EditorHooks,
  at: Vec = { x: 0, y: 0 },
  attrs?: PartAttrs,
): void {
  const sym = table.symbols[symbol];
  if (!sym) return;
  hooks.setMode({ kind: "place", symbol, at, rot: 0, mirror: "none", ...(attrs ? { attrs } : {}) });
  hooks.status(`放置 ${sym.name.zh}：左键落点，ctrl+r 旋转，ctrl+e 镜像，esc 退出`);
}

/** 从已有元件抽出可复制的属性（只带真正存在的值） */
export function copyAttrs(src: Part): PartAttrs {
  const attrs: PartAttrs = {};
  if (src.value !== undefined) attrs.value = src.value;
  if (src.model !== undefined) attrs.model = src.model;
  if (src.alias !== undefined) attrs.alias = src.alias;
  if (src.amp !== undefined) attrs.amp = src.amp;
  if (src.freq !== undefined) attrs.freq = src.freq;
  return attrs;
}

/** 落一个元件（place 模式的落点动作） */
export function commitPlace(m: Extract<Mode, { kind: "place" }>, hooks: EditorHooks): void {
  const sym = hooks.table.symbols[m.symbol]!;
  const prefix = sym.spice.prefix || "X";
  const part: Part = {
    id: nextId(hooks.doc, "p"),
    ref: nextRef(hooks.doc, prefix),
    symbol: m.symbol,
    at: { x: snap(m.at.x), y: snap(m.at.y) },
    rot: m.rot,
    mirror: m.mirror,
    ...DEFAULTS[m.symbol],
    // 复制带来的属性覆盖默认值（D-022）；未复制的字段仍保留默认值
    ...m.attrs,
  };
  hooks.commit();
  hooks.doc.parts.push(part);
  trimWiresUnderParts(hooks.doc, hooks.table);
  hooks.changed();
  hooks.status(`${part.ref} 已放置`);
}

/**
 * 语法糖（D-021）：所有「两引脚落在同一直导线上」的元件，剪掉两脚之间的导线。
 * 只处理恰好 2 个引脚的符号（电位器/三极管/运放不在此列，它们的引脚不共线）。
 */
export function trimWiresUnderParts(doc: Doc, table: SymbolTable): boolean {
  let changed = false;
  for (const part of doc.parts) {
    const sym = table.symbols[part.symbol];
    if (!sym || sym.pins.length !== 2) continue;
    const [a, b] = sym.pins.map((p) => toWorld(p.at, part));
    if (a && b && trimWireBetweenPins(doc, a, b)) changed = true;
  }
  return changed;
}

export function toggleRotate(m: Mode, hooks: EditorHooks): void {
  if (m.kind === "place") {
    hooks.setMode({ ...m, rot: rotStep(m.rot) });
  } else if (m.kind === "move") {
    const part = hooks.doc.parts.find((p) => p.id === m.partId);
    if (!part) return;
    part.rot = rotStep(part.rot);
    hooks.changed();
  }
}

export function toggleMirror(m: Mode, hooks: EditorHooks): void {
  const flip = (cur: Mirror): Mirror => (cur === "x" ? "none" : "x");
  if (m.kind === "place") {
    hooks.setMode({ ...m, mirror: flip(m.mirror) });
  } else if (m.kind === "move") {
    const part = hooks.doc.parts.find((p) => p.id === m.partId);
    if (!part) return;
    part.mirror = flip(part.mirror);
    hooks.changed();
  }
}

/** 预览用的正交落点（与提交时的规则一致） */
export function orthoPoint(from: Vec, to: Vec): Vec {
  const [a, b] = ortho(from, to);
  return a.x === b.x ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
}

/** 画线：两点必须正交（只走上下左右 —— D-009） */
export function ortho(from: Vec, to: Vec): [Vec, Vec] {
  // 取位移较大的那个轴，另一个轴对齐到起点
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const end = dx >= dy ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
  return [{ x: snap(from.x), y: snap(from.y) }, { x: snap(end.x), y: snap(end.y) }];
}

export function commitWire(from: Vec, to: Vec, hooks: EditorHooks): Vec {
  const [a, b] = ortho(from, to);
  if (a.x === b.x && a.y === b.y) return a; // 零长度忽略
  hooks.commit();
  hooks.doc.wires.push({ id: nextId(hooks.doc, "w"), points: [a, b] });
  hooks.changed();
  return b; // 连续画：下一段的起点 = 这一段终点
}

/** 删除：点元件删元件；点导线只删那一段 */
export function deleteAt(doc: Doc, partId: string | null, wireId: string | null, hooks: EditorHooks): void {
  if (partId) {
    const i = doc.parts.findIndex((p) => p.id === partId);
    if (i < 0) return;
    hooks.commit();
    const [gone] = doc.parts.splice(i, 1);
    hooks.changed();
    hooks.status(`已删除 ${gone?.ref ?? partId}`);
  } else if (wireId) {
    const i = doc.wires.findIndex((w) => w.id === wireId);
    if (i < 0) return;
    hooks.commit();
    doc.wires.splice(i, 1);
    hooks.changed();
    hooks.status("已删除一段导线");
  }
}

/** 拿起（记录原位，供 esc 回退） */
export function pickUp(partId: string, doc: Doc): Mode | null {
  const part = doc.parts.find((p) => p.id === partId);
  if (!part) return null;
  return { kind: "move", partId, origin: structuredClone(part), at: { ...part.at } };
}

export function dropAt(m: Extract<Mode, { kind: "move" }>, at: Vec, hooks: EditorHooks): void {
  const part = hooks.doc.parts.find((p) => p.id === m.partId);
  if (!part) return;
  hooks.commit();
  part.at = { x: snap(at.x), y: snap(at.y) };
  trimWiresUnderParts(hooks.doc, hooks.table);
  hooks.changed();
  hooks.status(`${part.ref} 已移动`);
}

/** esc：手持元件时先恢复原位 */
export function cancel(m: Mode, hooks: EditorHooks): void {
  if (m.kind === "move") {
    const part = hooks.doc.parts.find((p) => p.id === m.partId);
    if (part) {
      part.at = m.origin.at;
      part.rot = m.origin.rot;
      part.mirror = m.origin.mirror;
    }
    hooks.changed();
    hooks.status("已放回原位");
  }
  hooks.setMode({ kind: "view" });
}

/** 模式 → 光标形状 */
export function cursorFor(m: Mode): string {
  switch (m.kind) {
    case "place":
      return "crosshair";
    case "wire":
      return "crosshair";
    case "delete":
      return "not-allowed";
    case "move":
      return "grab";
    case "copy":
      return "copy";
    default:
      return "default";
  }
}

/** 供状态栏显示 */
export function modeLabel(m: Mode): string {
  switch (m.kind) {
    case "place":
      return `放置 ${m.symbol}`;
    case "wire":
      return m.from ? "画线（点击定点，esc 退出）" : "画线（点击起点）";
    case "delete":
      return "删除";
    case "move":
      return "移动（点击放下，esc 放回）";
    case "copy":
      return "复制（点击要复制的元件）";
    default:
      return "查看";
  }
}

export const GRID_MM = GRID;
