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
  /** 仅 `node-in` 用：兼作波形发生器的幅值（V）与频率（Hz） */
  amp?: number;
  freq?: number;
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
 * **但连接点不能合并掉**（D-023）：如果交点是一个 T 型接点（某根线的端点落在
 * 另一根线中间），而合并会让这个端点变成某条长线的内部，就跳过这次合并。
 * 否则“从 T 型交点继续画一笔”会把黑点变没 —— 不只是看不见，网表里也会从
 * “接上”变成“交叉不接”。
 *
 * 副作用：用户在 `w` 模式里连点画出的折线，直的几段会自动变成一条；
 * 「删除」于是就是"删掉这两个锚点之间的整段"。
 */
const EPS = 1e-6;

export function normalizeWires(wires: Wire[]): Wire[] {
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
  const barriers = mergeBarriers(wires);
  for (const list of groups.values()) {
    list.sort((p, q) => p.lo - q.lo || p.hi - q.hi);
    let cur = { ...list[0]! };
    for (const s of list.slice(1)) {
      if (s.lo <= cur.hi + EPS && !mergeErasesBarrier(cur, s, barriers)) {
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

/**
 * 合并的「禁越点」（D-023）：某根导线的端点落在另一根**不同方向**导线的中间。
 *
 * 这是真实的 T 型连接。归一化如果把它两侧的同向线段合并成一根跨过它的长线，
 * 端点就被吃掉：黑点消失，且后端并查集不再把两根线并成一个网络。
 * 同向重叠不算（那是同一根线的重复，合并不丢连接）。
 */
function mergeBarriers(wires: Wire[]): Vec[] {
  const pts: Vec[] = [];
  const add = (p: Vec): void => {
    if (!pts.some((q) => samePoint(q, p))) pts.push(p);
  };
  for (const x of wires) {
    const xHoriz = Math.abs(x.points[0].y - x.points[1].y) < EPS;
    for (const p of x.points) {
      for (const y of wires) {
        if (y.id === x.id) continue;
        if (!onSegmentInterior(p, y.points[0], y.points[1])) continue;
        const yHoriz = Math.abs(y.points[0].y - y.points[1].y) < EPS;
        if (xHoriz !== yHoriz) add(p);
      }
    }
  }
  return pts;
}

/** 这次合并会不会把某个「禁越点」从端点变成内部点 */
function mergeErasesBarrier(
  cur: { horiz: boolean; coord: number; lo: number; hi: number },
  s: { lo: number; hi: number },
  barriers: Vec[],
): boolean {
  if (!barriers.length) return false;
  const lo = Math.min(cur.lo, s.lo);
  const hi = Math.max(cur.hi, s.hi);
  const erased = [cur.lo, cur.hi, s.lo, s.hi].filter((v) => v > lo + EPS && v < hi - EPS);
  if (!erased.length) return false;
  for (const p of barriers) {
    const onLine = cur.horiz ? Math.abs(p.y - cur.coord) < EPS : Math.abs(p.x - cur.coord) < EPS;
    if (!onLine) continue;
    const v = cur.horiz ? p.x : p.y;
    if (erased.some((e) => Math.abs(e - v) < EPS)) return true;
  }
  return false;
}

const samePoint = (a: Vec, b: Vec): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

/** p 落在导线 a–b 的**内部**（不含两端；两端相接属于拐角或归一化已合并的情形） */
function onSegmentInterior(p: Vec, a: Vec, b: Vec): boolean {
  if (Math.abs(a.y - b.y) < EPS) {
    return Math.abs(p.y - a.y) < EPS && p.x > Math.min(a.x, b.x) + EPS && p.x < Math.max(a.x, b.x) - EPS;
  }
  if (Math.abs(a.x - b.x) < EPS) {
    return Math.abs(p.x - a.x) < EPS && p.y > Math.min(a.y, b.y) + EPS && p.y < Math.max(a.y, b.y) - EPS;
  }
  return false;
}

/**
 * 导线与导线的**真实连接点**（画黑色圆点，D-021）。
 *
 * 判据只有两条：
 *   ① T 型 —— 某根导线的端点落在另一根导线的中间；
 *   ② 分支 —— 三根及以上导线的端点重合于同一点。
 * 十字交叉（两根线各自在中间相交）**不是连接**，不画点 —— 与后端并查集的语义一致：
 * 连通只靠「端点落在导线上」，交叉不产生网络合并。
 * 两根线端点相接的拐角也不画点，这是原理图制图惯例。
 */
export function wireJunctions(wires: Wire[]): Vec[] {
  const pts: Vec[] = [];
  const add = (p: Vec): void => {
    if (!pts.some((q) => samePoint(q, p))) pts.push(p);
  };

  for (const w of wires) {
    for (const p of w.points) {
      for (const o of wires) {
        if (o.id === w.id) continue;
        if (onSegmentInterior(p, o.points[0], o.points[1])) add(p);
      }
    }
  }

  const ends = wires.flatMap((w) => w.points);
  for (const p of ends) {
    if (ends.filter((q) => samePoint(q, p)).length >= 3) add(p);
  }
  return pts;
}

/**
 * 语法糖（D-021）：两个引脚落在同一条直导线上时，剪掉**两引脚之间**那段导线。
 *
 * 只剪「完整覆盖两脚之间整段」的导线（两端都够得着），所以：
 *   - 导线正好从一脚跨到另一脚 → 整根删掉；
 *   - 导线两头都伸出元件 → 只剪中间，留下两端；
 *   - 导线只盖住一脚（元件一半在线上）→ 不动，那是真的没接上。
 * 保留原导线 id（选中/撤销稳定），剪下来的另一端用新 id。
 */
export function trimWireBetweenPins(doc: Doc, pa: Vec, pb: Vec): boolean {
  const horiz = Math.abs(pa.y - pb.y) < EPS;
  const vert = Math.abs(pa.x - pb.x) < EPS;
  if (!horiz && !vert) return false;

  const coord = horiz ? pa.y : pa.x;
  const lo = horiz ? Math.min(pa.x, pb.x) : Math.min(pa.y, pb.y);
  const hi = horiz ? Math.max(pa.x, pb.x) : Math.max(pa.y, pb.y);
  if (hi - lo < EPS) return false;

  let changed = false;
  const out: Wire[] = [];
  for (const w of doc.wires) {
    const [a, b] = w.points;
    const sameLine = horiz
      ? Math.abs(a.y - b.y) < EPS && Math.abs(a.y - coord) < EPS
      : Math.abs(a.x - b.x) < EPS && Math.abs(a.x - coord) < EPS;
    if (!sameLine) {
      out.push(w);
      continue;
    }
    const wlo = horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const whi = horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    // 必须完整盖住两脚之间 → 才剪；否则原样保留
    if (wlo > lo + EPS || whi < hi - EPS) {
      out.push(w);
      continue;
    }
    changed = true;
    const mk = (l: number, h: number, id: string): Wire | null => {
      if (h - l < EPS) return null;
      const points: [Vec, Vec] = horiz
        ? [{ x: l, y: coord }, { x: h, y: coord }]
        : [{ x: coord, y: l }, { x: coord, y: h }];
      const wire: Wire = { id, points };
      if (w.net) wire.net = w.net;
      return wire;
    };
    const head = mk(wlo, lo, w.id);
    const tail = mk(hi, whi, head ? nextId(doc, "w") : w.id);
    if (head) out.push(head);
    if (tail) out.push(tail);
  }

  if (changed) doc.wires = out;
  return changed;
}

/** 各类元件允许的数值单位（第一个是默认；`""` = 基本单位 Ω/V） */
export const VALUE_UNITS: Record<string, string[]> = {
  resistor: ["k", "Ω"],
  capacitor: ["n", "p", "u"],
  potentiometer: ["k", "Ω"],
  "voltage-source": ["V"],
};

/** 数值单位的显示名（"Ω" 在 SPICE 里不写后缀） */
export const UNIT_LABEL: Record<string, string> = { "": "Ω", k: "kΩ", p: "pF", n: "nF", u: "µF", V: "V" };

/** "10k" → { num: 10, unit: "k" }；"9" → { num: 9, unit: "" } */
export function splitValue(value: string | undefined, units: string[]): { num: string; unit: string } {
  const def = units[0] ?? "";
  if (!value) return { num: "", unit: def };
  const m = /^\s*([-+]?[\d.]+)\s*(p|n|u|µ|m|k|M|V)?\s*$/.exec(value);
  if (!m) return { num: value, unit: def };
  const raw = m[2] ?? "";
  const unit = raw === "µ" ? "u" : raw === "V" ? "V" : raw;
  // 单位不在允许列表里（比如老文件写了 "47m"）→ 保持数字，单位退回默认，避免静默改值
  return { num: m[1] ?? "", unit: units.includes(unit) ? unit : def };
}

/** 组装 SPICE 数值：单位 "Ω"/"V" 都不写后缀 */
export function joinValue(num: string, unit: string): string {
  const n = num.trim();
  if (!n) return "";
  return unit === "Ω" || unit === "V" || unit === "" ? n : `${n}${unit}`;
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
