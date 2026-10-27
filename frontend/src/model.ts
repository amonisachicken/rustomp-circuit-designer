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

/**
 * 导线归一化（自动合并重合部分 + 自动接续直导线）。
 *
 * 规则：**同一条直线上的线段**（水平 y 相同 / 垂直 x 相同）如果重叠或首尾相接，
 * 合并成一条最长的线段（保留最早那条的 id，撤销/选中都稳定）。
 * 交叉（十字）不合并 —— 那仍然是两根线，连通性由后端算。
 *
 * 副作用：用户在 `w` 模式里连点画出的折线，直的几段会自动变成一条；
 * 「删除」于是就是"删掉这两个锚点之间的整段"。
 */
export function normalizeWires(wires: Wire[]): Wire[] {
  const EPS = 1e-6;
  type Seg = { horiz: boolean; coord: number; lo: number; hi: number; id: string };
  const segs: Seg[] = [];

  for (const w of wires) {
    const [a, b] = w.points;
    if (Math.abs(a.y - b.y) < EPS) {
      segs.push({ horiz: true, coord: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x), id: w.id });
    } else if (Math.abs(a.x - b.x) < EPS) {
      segs.push({ horiz: false, coord: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y), id: w.id });
    } else {
      // 斜线不该存在（D-009），原样保留，让 lint 去报
      segs.push({ horiz: true, coord: Number.NaN, lo: 0, hi: 0, id: w.id });
    }
  }

  const groups = new Map<string, Seg[]>();
  for (const s of segs) {
    if (Number.isNaN(s.coord)) continue;
    const key = `${s.horiz ? "h" : "v"}:${s.coord.toFixed(4)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }

  const merged: Wire[] = [];
  for (const list of groups.values()) {
    list.sort((p, q) => p.lo - q.lo || p.hi - q.hi);
    let cur = { ...list[0]! };
    for (const s of list.slice(1)) {
      if (s.lo <= cur.hi + EPS) {
        cur.hi = Math.max(cur.hi, s.hi); // 重叠或首尾相接 → 接续
      } else {
        merged.push(toWire(cur));
        cur = { ...s };
      }
    }
    merged.push(toWire(cur));
  }

  // 斜线和非共线的一律原样保留（保持顺序稳定：按 id 字典序排序便于 diff）
  for (const w of wires) {
    const [a, b] = w.points;
    const axis = Math.abs(a.y - b.y) < EPS || Math.abs(a.x - b.x) < EPS;
    if (!axis) merged.push(w);
  }

  return merged
    .filter((w) => Math.abs(w.points[0].x - w.points[1].x) > EPS || Math.abs(w.points[0].y - w.points[1].y) > EPS)
    .sort((p, q) => p.id.localeCompare(q.id, "en", { numeric: true }));
}

function toWire(s: { horiz: boolean; coord: number; lo: number; hi: number; id: string }): Wire {
  return s.horiz
    ? { id: s.id, points: [{ x: s.lo, y: s.coord }, { x: s.hi, y: s.coord }] }
    : { id: s.id, points: [{ x: s.coord, y: s.lo }, { x: s.coord, y: s.hi }] };
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
