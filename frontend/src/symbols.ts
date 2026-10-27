// 符号清单（symbols/symbols.json 的前端视图）与 SVG 片段加载。
//
// 关键：引脚坐标是**局部坐标**（符号原点为原点，mm）。旋转/镜像在渲染与网表两处
// 必须用同一份变换（model.ts 的 toWorld），否则"画面连上了、网表没连上"。

import type { Vec } from "./model";

export interface PinSpec {
  id: string;
  at: Vec;
  dir: "left" | "right" | "up" | "down";
}

export interface SymbolSpec {
  /** 已改写为 public/symbols 下的文件名 */
  file: string;
  name: { zh: string; en: string };
  standard: string;
  canvas: { w: number; h: number };
  origin: Vec;
  pins: PinSpec[];
  spice: { prefix: string; pinOrder: string[] };
  models: string[];
  category: string;
  netName?: string;
  port?: "in" | "out";
}

export interface SymbolTable {
  version: number;
  grid: number;
  unit: string;
  symbols: Record<string, SymbolSpec>;
}

/** 符号 → 原始 SVG 文本（去掉最外层 <svg>，只留内部内容 + viewBox） */
export interface SymbolArt {
  viewBox: string;
  inner: string;
}

const artCache = new Map<string, SymbolArt>();

export async function loadSymbols(base = ""): Promise<SymbolTable> {
  const res = await fetch(`${base}symbols/symbols.json`);
  if (!res.ok) throw new Error(`读不到 symbols.json（${res.status}）`);
  return (await res.json()) as SymbolTable;
}

/** 取符号的 SVG 片段；保留 viewBox，外层由调用方给尺寸与变换 */
export async function loadArt(sym: SymbolSpec, base = ""): Promise<SymbolArt> {
  const hit = artCache.get(sym.file);
  if (hit) return hit;
  const text = await (await fetch(`${base}symbols/${sym.file}`)).text();
  const vb = /viewBox="([^"]+)"/.exec(text);
  const inner = text.slice(text.indexOf(">", text.search(/<svg\b/)) + 1, text.lastIndexOf("</svg>"));
  const art: SymbolArt = { viewBox: vb ? vb[1]!.trim() : `0 0 ${sym.canvas.w} ${sym.canvas.h}`, inner };
  artCache.set(sym.file, art);
  return art;
}

/** 预载全部（D0 只有 16 个，直接全下） */
export async function loadAllArt(table: SymbolTable, base = ""): Promise<void> {
  await Promise.all(Object.values(table.symbols).map((s) => loadArt(s, base)));
}
