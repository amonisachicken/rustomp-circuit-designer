// 文档模型（`.design.json`）与几何工具。
//
// 与后端的契约见 docs/03-editor-model.md §1；单位 **mm**，栅格 2.5 mm（D-003）。

export const GRID = 2.5;

export type Rot = 0 | 90 | 180 | 270;
export type Mirror = "none" | "x" | "y";

export interface Vec {
  x: number;
  y: number;
}

export interface Part {
  id: string;
  /** 参考编号 R1 / C3 / Q2 / U1 / P1 */
  ref: string;
  /** symbols.json 的 key */
  symbol: string;
  /** 器件型号（闭集）；电阻/电容为空 */
  model?: string;
  /** "4.7k" / "47n" / "9" */
  value?: string;
  /** 符号原点在画布上的位置（mm，吸附栅格） */
  at: Vec;
  rot: Rot;
  mirror: Mirror;
  /** 别名（默认不显示，D 见 prompt.md） */
  alias?: string;
}

export interface Wire {
  id: string;
  /** 一段 = 两个锚点（只走上下左右，D-009） */
  points: [Vec, Vec];
  /** 显式网络名（可选） */
  net?: string;
}

export interface Doc {
  version: 1;
  name: string;
  parts: Part[];
  wires: Wire[];
  nextId: number;
}

export const emptyDoc = (name = "未命名电路"): Doc => ({
  version: 1,
  name,
  parts: [],
  wires: [],
  nextId: 1,
});

/** 吸附到 2.5 mm 栅格（关掉吸附时坐标仍是 mm，只是不取整 —— D-003） */
export const snap = (v: number): number => Math.round(v / GRID) * GRID;

/** 局部坐标 → 世界坐标：world = R(rot)·M(mirror)·local + at */
export function toWorld(local: Vec, part: Pick<Part, "at" | "rot" | "mirror">): Vec {
  let x = local.x;
  let y = local.y;
  if (part.mirror === "x") x = -x; // 左右镜像（沿 y 轴翻转）
  if (part.mirror === "y") y = -y;
  const a = (part.rot * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // 屏幕坐标 y 向下；顺时针旋转 90° ⇒ (x,y) → (−y, x)
  return { x: c * x - s * y + part.at.x, y: s * x + c * y + part.at.y };
}

/** 参考编号前缀 → 下一个可用编号（R1、R2…；按现有最大号 +1，不填补空洞） */
export function nextRef(doc: Doc, prefix: string): string {
  let max = 0;
  for (const p of doc.parts) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(p.ref);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

export const nextId = (doc: Doc, kind: string): string => `${kind}${doc.nextId++}`;
