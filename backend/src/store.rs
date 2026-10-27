// SPDX-License-Identifier: GPL-3.0-or-later
//! 服务端缓存：把设计稿存到后端（`designer.save`）。
//!
//! 参照 breadspice 的"保存布局"语义：**存一份、并清空前端撤销/重做**（前端做）。
//! 存放位置：`$CD_DATA`（默认 `<repo>/.cache/designs`）/<名字>.design.json。
//! 名字只用来当文件名，做最小白名单清洗（去路径分隔符与危险字符）。

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SaveResult {
    /// 落盘路径
    pub path: String,
    /// 实际使用的文件名
    pub file: String,
    pub bytes: usize,
}

pub fn data_dir(repo: &Path) -> PathBuf {
    std::env::var("CD_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo.join(".cache/designs"))
}

fn safe_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if "/\\:*?\"<>|{}[]$#%&@!`'~^+=,;".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    s = s.trim().trim_matches('.').to_string();
    if s.is_empty() {
        s = "未命名电路".into();
    }
    // 文件名太长有的文件系统会炸
    if s.chars().count() > 80 {
        s = s.chars().take(80).collect();
    }
    s
}

pub fn save(repo: &Path, name: &str, doc: &serde_json::Value) -> Result<SaveResult, String> {
    let dir = data_dir(repo);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建缓存目录失败（{}）：{e}", dir.display()))?;
    let file = format!("{}.design.json", safe_name(name));
    let path = dir.join(&file);
    let mut text = serde_json::to_string_pretty(doc).map_err(|e| format!("序列化失败：{e}"))?;
    text.push('\n');
    std::fs::write(&path, &text).map_err(|e| format!("写文件失败（{}）：{e}", path.display()))?;
    Ok(SaveResult { path: path.display().to_string(), file, bytes: text.len() })
}
