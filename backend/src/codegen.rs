// SPDX-License-Identifier: GPL-3.0-or-later
//! 网表 → rustomp 电路代码（调 `rustomp-import --mna`）。
//!
//! 这是 M-B 里程碑的按钮：画完图 → 生成 `.cir` → 让框架生成可编译的 `Ckt`。
//! 找 rustomp 的顺序：`$RUSTOMP_ROOT` → `<repo>/../rustomp`。找到后优先用已编译好的
//! `target/{release,debug}/rustomp-import`，否则退回 `cargo run`（慢，但不用先编译）。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CodegenResult {
    /// 生成的 Rust 源码
    pub code: String,
    /// 未知量个数（从生成物里读出来的，用于"规模 sanity check"）
    pub unknowns: Option<usize>,
    /// 端口节点名
    pub ports: Vec<String>,
}

fn framework_root(repo: &Path) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("RUSTOMP_ROOT") {
        let p = PathBuf::from(p);
        if p.join("crates/rustomp-import").is_dir() {
            return Some(p);
        }
    }
    for cand in [repo.join("../rustomp"), repo.join("../rustomp-framework")] {
        if cand.join("crates/rustomp-import").is_dir() {
            return cand.canonicalize().ok();
        }
    }
    None
}

/// rustomp-import 的源码是否比给定二进制新（新了就说明这个二进制不能信）。
fn import_sources_newer_than(fw: &Path, bin: &Path) -> bool {
    let Ok(bin_time) = bin.metadata().and_then(|m| m.modified()) else {
        return true;
    };
    let mut newest = None;
    let mut stack = vec![fw.join("crates/rustomp-import")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let interesting = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s == "rs" || s == "toml")
                .unwrap_or(false);
            if !interesting {
                continue;
            }
            if let Ok(t) = e.metadata().and_then(|m| m.modified()) {
                if newest.map(|n| t > n).unwrap_or(true) {
                    newest = Some(t);
                }
            }
        }
    }
    newest.map(|t| t > bin_time).unwrap_or(true)
}

/// 调 rustomp-import 生成代码。`cir` 是交付网表（单份）。
pub fn generate(repo: &Path, cir: &str) -> Result<CodegenResult, String> {
    let fw = framework_root(repo).ok_or_else(|| {
        "找不到 rustomp 框架（设 RUSTOMP_ROOT=/path/to/rustomp，或把它放在本项目同级目录）".to_string()
    })?;

    let dir = std::env::temp_dir().join(format!("cdgen-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cir_path = dir.join("circuit.cir");
    let rs_path = dir.join("circuit.rs");
    std::fs::write(&cir_path, cir).map_err(|e| e.to_string())?;

    let bins = ["release", "debug"]
        .iter()
        .map(|p| fw.join(format!("target/{p}/rustomp-import")))
        .filter(|p| p.is_file())
        .collect::<Vec<_>>();

    // **预编译的二进制可能比源码老**：rustomp-import 改了（例如 `in=` 语义、`param`
    // 元素名）而没重新 build，点【生成代码】就会静静拿到旧版产的代码。
    // 所以先比 mtime：源码/清单晚于二进制 → 直接走 `cargo run`（编译一次，之后又快了）。
    let bin = bins
        .iter()
        .find(|b| !import_sources_newer_than(&fw, b))
        .cloned();

    let output = match bin {
        Some(bin) => Command::new(bin)
            .arg(&cir_path)
            .arg("--mna")
            .arg(&rs_path)
            .output()
            .map_err(|e| format!("启动 rustomp-import 失败：{e}"))?,
        None => Command::new("cargo")
            .args(["run", "-q", "-p", "rustomp-import", "--"])
            .arg(&cir_path)
            .arg("--mna")
            .arg(&rs_path)
            .current_dir(&fw)
            .output()
            .map_err(|e| format!("启动 cargo 失败：{e}"))?,
    };

    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("rustomp-import 退出码 {:?}\n{}", output.status.code(), log.trim()));
    }

    let code = std::fs::read_to_string(&rs_path).map_err(|e| format!("读不到生成物：{e}"))?;
    let _ = std::fs::remove_dir_all(&dir);

    let unknowns = code
        .lines()
        .find_map(|l| l.strip_prefix("pub const UNKNOWNS: usize = "))
        .and_then(|s| s.trim_end_matches(';').parse().ok());
    // 只取 `pub mod node { … }` 里的常量名（那才是网络名）
    let mut ports: Vec<String> = Vec::new();
    let mut in_node = false;
    for line in code.lines() {
        let t = line.trim();
        if t.starts_with("pub mod node") {
            in_node = true;
            continue;
        }
        if in_node {
            if t == "}" {
                break;
            }
            if let Some(rest) = t.strip_prefix("pub const ") {
                if let Some(name) = rest.split(':').next() {
                    ports.push(name.trim().to_string());
                }
            }
        }
    }

    Ok(CodegenResult { code, unknowns, ports })
}
