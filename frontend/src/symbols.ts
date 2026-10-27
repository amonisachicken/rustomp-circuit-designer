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

/** 符号里的一段文字（引脚名 / "In" / "Out" / 电极端子字母） */
export interface SymText {
  x: number;
  y: number;
  size: number;
  anchor: string;
  fill: string;
  family: string;
  content: string;
}

/**
 * 符号 → 原始 SVG 文本（去掉最外层 `<svg>`，只留内部内容 + viewBox）
 *
 * `texts` 是**从图里抠出来的文字**：旋转整个符号时文字会跟着转（"In" 倒过来之类），
 * 所以文字不在图里画，而是由渲染层单独摆——保持正向（prompt.md 的要求）。
 */
export interface SymbolArt {
  viewBox: string;
  inner: string;
  texts: SymText[];
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
  let inner = text.slice(text.indexOf(">", text.search(/<svg\b/)) + 1, text.lastIndexOf("</svg>"));
  const { inner: stripped, texts } = extractTexts(inner);
  inner = stripped;
  const art: SymbolArt = {
    viewBox: vb ? vb[1]!.trim() : `0 0 ${sym.canvas.w} ${sym.canvas.h}`,
    inner,
    texts,
  };
  artCache.set(sym.file, art);
  return art;
}

const TEXT_RE = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
const ATTR_RE = /([\w:-]+)="([^"]*)"/g;

/**
 * 把 SVG 里的 `<text>` 抠出来（文字随符号旋转会倒过来 —— 必须在渲染层单独摆）。
 *
 * 属性继承：素材把 font-size / fill / text-anchor 写在祖先 `<g>` 上，
 * 所以这里维护一个 `<g>` 属性栈，`<text>` 所在位置向上合并。
 * 本项目的素材没有文字级 `transform`，遇到就忽略（记在 docs/04）。
 */
export function extractTexts(inner: string): { inner: string; texts: SymText[] } {
  const texts: SymText[] = [];
  const stack: Record<string, string>[] = [];
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g;

  // 边扫边记：遇到 <g> 入栈、</g> 出栈；遇到 <text> 就把栈里的属性合并成它的样式
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(inner)) !== null) {
    const closing = m[1] === "/";
    const tag = m[2]!;
    const rawAttrs = m[3] ?? "";

    if (tag === "g") {
      if (closing) stack.pop();
      else stack.push(Object.fromEntries([...rawAttrs.matchAll(ATTR_RE)].map((a) => [a[1]!, a[2]!])));
      continue;
    }
    if (tag !== "text" || closing) continue;

    const own = Object.fromEntries([...rawAttrs.matchAll(ATTR_RE)].map((a) => [a[1]!, a[2]!]));
    const merged: Record<string, string> = {};
    for (const layer of stack) Object.assign(merged, layer);
    Object.assign(merged, own);

    const content = /<text\b[^>]*>([\s\S]*?)<\/text>/.exec(inner.slice(m.index))?.[1]?.trim() ?? "";
    texts.push({
      x: Number(merged["x"] ?? 0),
      y: Number(merged["y"] ?? 0),
      size: Number(merged["font-size"] ?? 2.4),
      anchor: merged["text-anchor"] ?? "start",
      fill: merged["fill"] ?? "#0f172a",
      family: merged["font-family"] ?? "Consolas, monospace",
      content,
    });
  }

  return { inner: inner.replace(TEXT_RE, ""), texts };
}

/** 预载全部（D0 只有 16 个，直接全下） */
export async function loadAllArt(table: SymbolTable, base = ""): Promise<void> {
  await Promise.all(Object.values(table.symbols).map((s) => loadArt(s, base)));
}
