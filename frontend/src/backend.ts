// 后端 RPC 客户端（JSON-RPC over HTTP）。后端职责见 docs/02-architecture.md：
// 网表生成、ngspice 仿真、代码生成都在 Rust 侧，前端只画图。
//
// 后端没起来时**不阻塞画图**：调用方用 try/catch 降级（状态栏提示"后端未连接"）。

/// <reference types="vite/client" />
const RPC: string = import.meta.env["VITE_RPC_URL"] ?? "http://127.0.0.1:3600/rpc";

export interface Lint {
  level: "error" | "warn";
  code: string;
  msg: string;
}

export interface NetlistResult {
  cir: string;
  lints: Lint[];
  ports: { in: string | null; out: string | null };
  nets: { name: string; pins: string[] }[];
  /** 悬空引脚（画布上标红圈） */
  dangling: { ref: string; pin: string; at: { x: number; y: number } }[];
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const body = (await res.json()) as { ok: boolean; result?: T; error?: string };
  if (!body.ok) throw new Error(body.error ?? "RPC 失败");
  return body.result as T;
}

export interface CodegenResult {
  code: string;
  unknowns: number | null;
  ports: string[];
}

export type AnalysisKind = "op" | "dc" | "ac" | "tran";

export interface SimParams {
  amp?: number;
  freq?: number;
  step?: number;
  start?: number;
  duration?: number;
  sweep?: "dec" | "oct" | "lin";
  points?: number;
  f_start?: number;
  f_stop?: number;
}

export interface SimTrace {
  name: string;
  x: number[];
  y: number[];
}

export interface SimResult {
  analysis: AnalysisKind;
  traces: SimTrace[];
  op: Record<string, number> | null;
  cancelled: boolean;
  /** 瞬态输出的 THD（前 9 次谐波）；非 tran 为 null */
  thd: number | null;
  cir: string;
  log: string;
}

export interface SaveResult {
  path: string;
  file: string;
  bytes: number;
}

export const backend = {
  ping: () => rpc<{ pong: boolean; version: string }>("designer.ping", {}),
  netlist: (doc: unknown) => rpc<NetlistResult>("designer.netlist", doc),
  /** 仿真：后端拼上源与 .tran 跑 ngspice，返回波形（不影响交付的 .cir） */
  simulate: (doc: unknown, analysis: AnalysisKind, params: SimParams, probes: string[]) =>
    rpc<SimResult>("designer.simulate", { doc, analysis, params, probes }),
  /** 取消正在跑的仿真 */
  stop: () => rpc<boolean>("designer.stop", {}),
  /** 频谱（示波器的 FFT 按钮） */
  fft: (x: number[], y: number[], maxFreq: number) =>
    rpc<{ f: number[]; db: number[] }>("designer.fft", { x, y, max_freq: maxFreq }),
  /** 调 rustomp-import 把网表生成 Rust 电路（需要 RUSTOMP_ROOT 或同级 rustomp） */
  codegen: (doc: unknown) => rpc<CodegenResult>("designer.codegen", doc),
  /** 保存到服务端缓存（前端随后清空撤销/重做，与 breadspice 的"保存布局"一致） */
  save: (name: string, doc: unknown) => rpc<SaveResult>("designer.save", { name, doc }),
  /** 上次保存的设计（启动时自动恢复）；没有就返回 null */
  last: () => rpc<{ name: string; file: string; doc: unknown } | null>("designer.last", {}),
};
