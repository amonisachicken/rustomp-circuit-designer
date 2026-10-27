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

export const backend = {
  ping: () => rpc<{ pong: boolean; version: string }>("designer.ping", {}),
  netlist: (doc: unknown) => rpc<NetlistResult>("designer.netlist", doc),
};
