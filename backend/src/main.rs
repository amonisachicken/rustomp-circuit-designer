// SPDX-License-Identifier: GPL-3.0-or-later
//! 设计器后端（D0：只提供 ping / symbols 两个 RPC）。
//!
//! 为什么要有后端（D-002）：网表生成、ngspice 仿真、`rustomp-import` 调用都要在 Rust 侧做；
//! 前端只画图。协议照抄 breadspice（JSON-RPC over HTTP），骨架可整体替换。

use axum::{extract::State, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

mod netlist;
mod sim;
use tower_http::cors::CorsLayer;

#[derive(Clone)]
struct App {
    root: PathBuf,
}

#[derive(Deserialize)]
struct RpcRequest {
    method: String,
    /// 各方法自己解析（netlist 要收 Document）
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct RpcResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn ok(v: Value) -> Json<RpcResponse> {
    Json(RpcResponse { ok: true, result: Some(v), error: None })
}
fn err(msg: impl Into<String>) -> Json<RpcResponse> {
    Json(RpcResponse { ok: false, result: None, error: Some(msg.into()) })
}

async fn rpc(State(app): State<Arc<App>>, Json(req): Json<RpcRequest>) -> Json<RpcResponse> {
    match req.method.as_str() {
        "designer.ping" => ok(json!({ "pong": true, "version": env!("CARGO_PKG_VERSION") })),
        "designer.symbols" => {
            let path = app.root.join("symbols/symbols.json");
            match std::fs::read_to_string(&path) {
                Ok(text) => match serde_json::from_str::<Value>(&text) {
                    Ok(v) => ok(v),
                    Err(e) => err(format!("symbols.json 解析失败：{e}")),
                },
                Err(e) => err(format!("读不到 {}：{e}（先跑 tools/gen-symbols.py）", path.display())),
            }
        }
        "designer.netlist" => {
            let path = app.root.join("symbols/symbols.json");
            let table: netlist::SymbolTable = match std::fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
            {
                Some(t) => t,
                None => return err(format!("读不到 {}", path.display())),
            };
            let doc: netlist::Document = match serde_json::from_value(req.params) {
                Ok(d) => d,
                Err(e) => return err(format!("Document 解析失败：{e}")),
            };
            let g = netlist::generate(&doc, &table);
            ok(serde_json::to_value(g).unwrap_or(Value::Null))
        }
        "designer.simulate" => {
            let path = app.root.join("symbols/symbols.json");
            let table: netlist::SymbolTable = match std::fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
            {
                Some(t) => t,
                None => return err(format!("读不到 {}", path.display())),
            };
            let req: sim::SimRequest = match serde_json::from_value(req.params) {
                Ok(r) => r,
                Err(e) => return err(format!("仿真参数解析失败：{e}")),
            };
            match sim::run(&req, &table) {
                Ok(r) => ok(serde_json::to_value(r).unwrap_or(Value::Null)),
                Err(e) => err(e),
            }
        }
        other => err(format!("未知方法：{other}")),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 仓库根（backend/ 的上一级）
    let root = std::env::var("CD_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf());
    let port = std::env::var("CD_PORT").unwrap_or_else(|_| "3600".into());

    let app = Arc::new(App { root });
    let router = Router::new()
        .route("/rpc", post(rpc))
        .layer(CorsLayer::permissive())
        .with_state(app);

    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("circuit-designer backend → http://{addr}/rpc");
    axum::serve(listener, router).await?;
    Ok(())
}
