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

    let bin = ["release", "debug"]
        .iter()
        .map(|p| fw.join(format!("target/{p}/rustomp-import")))
        .find(|p| p.is_file());

    let output = match bin {
        Some(bin) => Command::new(bin)
            .arg(&cir_path)
            .arg("--mna")
            .arg(&rs_path)
            .output()
            .map_err(|e| format!("启动 rustomp-import 失败：{e}"))?,
        None => Command::new("cargo")
            .args(["run", "-q", "--release", "-p", "rustomp-import", "--"])
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
