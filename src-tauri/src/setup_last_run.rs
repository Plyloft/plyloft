//! R2 (1.176.0, plan blind spot 23): the last install or update of each tool,
//! kept on disk so a later Repair step — and Plyloft after a restart — can
//! read what happened without the guided terminal's memory.
//!
//! One file, `<config>/setup_last_runs.json`, an object keyed by tool id
//! (`"claude"`, `"codex"`, `"gh"`, `"git"`, `"node"`). Written atomically
//! (Hard Rule 3, `atomic::write_atomic_json`). Every field has a default, so
//! an older or newer shape reads; an entry that doesn't read is dropped, a
//! file that isn't JSON is set aside (`atomic::load_or_set_aside_with`) and
//! reads as empty — never an error a run or a page has to handle.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::setup_actions::Tool;

pub const FILE: &str = "setup_last_runs.json";

/// The tail kept on disk: at most this many lines…
pub const MAX_TAIL_LINES: usize = 200;
/// …and at most this many bytes, the newest kept.
pub const MAX_TAIL_BYTES: usize = 64 * 1024;

/// One run, as the record keeps it. Outcome and cause are their wire names
/// (`"still-on-old-version"`, `"permissions"`), kept as text so a name a
/// newer Plyloft wrote still reads.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LastRun {
    pub action_id: String,
    /// RFC 3339.
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub exit_code: Option<i32>,
    pub outcome: Option<String>,
    pub cause: Option<String>,
    pub cause_path: Option<String>,
    pub version_before: Option<String>,
    pub version_after: Option<String>,
    pub tail: Vec<String>,
}

/// The file's whole content.
pub type LastRuns = BTreeMap<String, LastRun>;

pub fn tool_key(tool: Tool) -> &'static str {
    match tool {
        Tool::Claude => "claude",
        Tool::Codex => "codex",
        Tool::Gh => "gh",
        Tool::Git => "git",
        Tool::Node => "node",
    }
}

/// Pure: the tail capped to [`MAX_TAIL_LINES`] and [`MAX_TAIL_BYTES`], the
/// newest lines kept; a single line longer than the byte cap keeps its end.
pub fn cap_tail(tail: &[String]) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    let mut bytes = 0usize;
    for line in tail.iter().rev().take(MAX_TAIL_LINES) {
        let room = MAX_TAIL_BYTES - bytes;
        if line.len() + 1 > room {
            if kept.is_empty() {
                let mut cut = line.len().saturating_sub(room.saturating_sub(1));
                while !line.is_char_boundary(cut) {
                    cut += 1;
                }
                kept.push(line[cut..].to_string());
            }
            break;
        }
        bytes += line.len() + 1;
        kept.push(line.clone());
    }
    kept.reverse();
    kept
}

/// Pure: the file's bytes as records. An entry that doesn't read as a run
/// (a number, a list) is dropped; the others stay.
pub fn parse(bytes: &[u8]) -> Result<LastRuns, String> {
    let map: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    Ok(map
        .into_iter()
        .filter_map(|(tool, value)| Some((tool, serde_json::from_value(value).ok()?)))
        .collect())
}

/// What is on disk in `dir`; empty when there's nothing, or nothing readable.
pub fn load(dir: &Path) -> LastRuns {
    match crate::atomic::load_or_set_aside_with(&dir.join(FILE), parse) {
        Ok(loaded) => loaded.found().unwrap_or_default(),
        Err(e) => {
            log::warn!("setup_last_run: couldn't read {FILE}: {e}");
            LastRuns::new()
        }
    }
}

static WRITE: Mutex<()> = Mutex::new(());

/// Keep `run` as `tool`'s last, beside the other tools' (and any key this
/// build doesn't know).
pub fn record(dir: &Path, tool: Tool, run: LastRun) -> Result<(), String> {
    record_key(dir, tool_key(tool), run)
}

/// 1.176.0 R5: [`record`] under a key of its own — the automatic Codex
/// update's attempts (`codex_auto_update::RECORD_KEY`), kept beside the
/// tools' entries, which an older build reads past.
pub fn record_key(dir: &Path, key: &str, mut run: LastRun) -> Result<(), String> {
    let _held = WRITE.lock();
    run.tail = cap_tail(&run.tail);
    let mut runs = load(dir);
    runs.insert(key.to_string(), run);
    crate::atomic::write_atomic_json(&dir.join(FILE), &runs)
}

/// Where the record lives: Plyloft's own data folder.
pub fn dir_of<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}

/// The last install or update of `tool` (`"claude"`, `"codex"`, …), or
/// `None` when none was recorded.
#[tauri::command(async)]
pub fn setup_last_run(app: AppHandle, tool: String) -> Option<LastRun> {
    let dir = dir_of(&app)?;
    load(&dir).remove(&tool)
}

#[cfg(test)]
#[path = "setup_last_run_tests.rs"]
mod tests;
