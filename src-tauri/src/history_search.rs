//! v1.25.0 (Cycle G4): cross-artifact history search.
//!
//! Parallel to `search.rs` (which `rg`-greps the user's project source)
//! but rooted at the Atelier config dir, scoped by workspace or global,
//! and tags each hit with the artifact kind so the FE can render
//! kind-grouped results with kind-specific deep-link behavior.
//!
//! Why a parallel module instead of parameterizing `SearchRegistry`:
//! the existing module is workspace-cwd-scoped, single in-flight per
//! workspace, and emits `search://*` events with a workspace_id field.
//! History search is single-in-flight GLOBALLY, rooted at the config
//! dir, and the per-hit kind classification is the headline value.
//! Sharing the rg-parsing code would require contorting the API; a
//! parallel module is cleaner.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter};

use crate::shell_env;

const MAX_RESULTS: usize = 500;

/// Scope decides which subpaths of the config dir get fed to rg.
///
/// `Workspace`: cards, intake transcripts, and brainstorm mailboxes
/// for one workspace. Agent run records / transcripts and snapshot
/// manifests are NOT workspace-scoped on disk (they're keyed by
/// runId), so this mode deliberately excludes them — toggle to
/// `Global` to include them.
///
/// `Global`: everything under the config dir.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "kind", content = "workspaceId")]
pub enum HistoryScope {
    Workspace(String),
    Global,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum HistoryKind {
    Card,
    RunRecord,
    RunTranscript,
    Snapshot,
    IntakeTranscript,
    SwarmMailbox,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryHit {
    pub kind: HistoryKind,
    /// Workspace id parsed from the path when the kind's path layout
    /// includes it (Card, IntakeTranscript, SwarmMailbox). `None` for
    /// kinds whose on-disk path is run-keyed (RunRecord, RunTranscript,
    /// Snapshot) — the FE can resolve to a workspace via the agent run
    /// record cross-reference if needed.
    pub workspace_id: Option<String>,
    /// Kind-dependent artifact id parsed from the path:
    ///   Card → workspace_id (the cards file is one-per-workspace; the
    ///     specific card matched is line-of-hit and not parsed here)
    ///   RunRecord / RunTranscript → run_id
    ///   Snapshot → run_id
    ///   IntakeTranscript → intake_id
    ///   SwarmMailbox → swarm_id
    pub artifact_id: String,
    /// QoL 11.3: for a Card hit, the card the matching line belongs to
    /// (`BoardIndex::card_at`), so the hit opens that card rather than the
    /// Board. `None` for every other kind, and when it can't be told.
    pub card_id: Option<String>,
    /// The card's title, for the row (walk: never the raw board line).
    pub card_title: Option<String>,
    /// Absolute filesystem path of the hit.
    pub path: String,
    pub line_number: u32,
    pub line_text: String,
    pub match_text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum HistoryDoneStatus {
    Completed,
    Cancelled,
    Capped,
    NoRipgrep,
    Error,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDoneEvent {
    pub status: HistoryDoneStatus,
    pub message: Option<String>,
    pub total: usize,
}

struct HistoryHandle {
    child: Mutex<Option<Child>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct HistorySearchRegistry {
    /// Single in-flight session globally — only one history search
    /// runs at a time. A new `start` call cancels the prior one.
    current: Mutex<Option<Arc<HistoryHandle>>>,
    /// Atelier's config dir, captured at registry construction so the
    /// command layer doesn't have to thread it through every call.
    config_dir: PathBuf,
}

impl HistorySearchRegistry {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            current: Mutex::new(None),
            config_dir,
        }
    }

    fn cancel_existing(&self) {
        if let Some(handle) = self.current.lock().take() {
            handle.cancelled.store(true, Ordering::SeqCst);
            // 1.176.2 (REV-R4 F1): killed in place; the reader thread waits.
            if let Some(child) = handle.child.lock().as_mut() {
                let _ = child.kill();
            }
        }
    }

    pub fn cancel(&self) {
        self.cancel_existing();
    }

    pub fn start(
        &self,
        app: AppHandle,
        query: String,
        scope: HistoryScope,
    ) -> Result<(), String> {
        if query.len() < 2 {
            return Err("query must be at least 2 characters".into());
        }
        self.cancel_existing();

        let rg = match find_rg() {
            Some(p) => p,
            None => {
                let _ = app.emit(
                    "history://done",
                    HistoryDoneEvent {
                        status: HistoryDoneStatus::NoRipgrep,
                        message: Some(
                            format!(
                                "ripgrep not found on PATH. Install: {}",
                                crate::doctor::install_cmd("rg").unwrap_or_default()
                            ),
                        ),
                        total: 0,
                    },
                );
                return Ok(());
            }
        };

        let roots = scoped_roots(&self.config_dir, &scope);
        if roots.is_empty() {
            // Workspace has no on-disk artifacts yet — emit empty done.
            let _ = app.emit(
                "history://done",
                HistoryDoneEvent {
                    status: HistoryDoneStatus::Completed,
                    message: None,
                    total: 0,
                },
            );
            return Ok(());
        }

        let mut command = crate::platform::new_command(&rg);
        command.arg("--json");
        command.arg("--ignore-case");
        command.arg("--fixed-strings");
        command.arg("--hidden"); // Atelier config dir is under ~/Library/
        // Exclude stale snapshot residual content (compute_changes cleanup
        // is best-effort; orphan before/ dirs would create duplicate hits).
        command.arg("--glob").arg("!snapshots/*/before/**");
        command.arg("--").arg(&query);
        for r in &roots {
            command.arg(r);
        }
        command.env("PATH", &shell_env::get().path);
        command.stdout(Stdio::piped());
        // Nothing reads rg's stderr here: a piped one that fills (one line per
        // unreadable entry) would stall rg until Cancel.
        command.stderr(Stdio::null());

        let mut child = command.spawn().map_err(|e| format!("spawn rg: {e}"))?;
        let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;

        let cancelled = Arc::new(AtomicBool::new(false));
        let handle = Arc::new(HistoryHandle {
            child: Mutex::new(Some(child)),
            cancelled: cancelled.clone(),
        });
        *self.current.lock() = Some(handle.clone());

        let app_clone = app.clone();
        let config_dir = self.config_dir.clone();
        thread::spawn(move || {
            // Each board file read once per search, for its hits' cards.
            let mut boards: std::collections::HashMap<String, Option<BoardIndex>> =
                std::collections::HashMap::new();
            let reader = BufReader::new(stdout);
            let mut total = 0usize;
            let mut capped = false;
            let mut error: Option<String> = None;
            for line in reader.lines() {
                if cancelled.load(Ordering::SeqCst) {
                    break;
                }
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        error = Some(format!("read: {e}"));
                        break;
                    }
                };
                if line.is_empty() {
                    continue;
                }
                let value: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if value.get("type").and_then(|v| v.as_str()) != Some("match") {
                    continue;
                }
                let data = match value.get("data") {
                    Some(d) => d,
                    None => continue,
                };
                let path = data
                    .get("path")
                    .and_then(|p| p.get("text"))
                    .and_then(|p| p.as_str())
                    .unwrap_or("")
                    .to_string();
                let rel = relative_path(&config_dir, Path::new(&path));
                let (kind, workspace_id, artifact_id) = match classify(&rel) {
                    Some(v) => v,
                    None => continue,
                };
                let line_number = data
                    .get("line_number")
                    .and_then(|n| n.as_u64())
                    .unwrap_or(0) as u32;
                let line_text = data
                    .get("lines")
                    .and_then(|l| l.get("text"))
                    .and_then(|l| l.as_str())
                    .unwrap_or("")
                    .trim_end_matches('\n')
                    .to_string();
                let raw_line = line_text.clone();
                let line_text = cut_line(line_text);
                let submatches = data
                    .get("submatches")
                    .and_then(|s| s.as_array())
                    .cloned()
                    .unwrap_or_default();
                if submatches.is_empty() {
                    continue;
                }
                // For history search we only care about the first
                // submatch per line — kind grouping wants one hit per
                // line of source, not one per match. Saves a 10×
                // result inflation on lines with many matches.
                let sm = &submatches[0];
                let mtxt = sm
                    .get("match")
                    .and_then(|m| m.get("text"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string();
                let (card_id, card_title) = if kind == HistoryKind::Card {
                    boards
                        .entry(path.clone())
                        .or_insert_with(|| std::fs::read_to_string(&path).ok().map(|t| BoardIndex::new(&t)))
                        .as_ref()
                        .and_then(|board| board.card_with_title_at(line_number, &raw_line))
                        .map_or((None, None), |(id, title)| (Some(id), title))
                } else {
                    (None, None)
                };
                let _ = app_clone.emit(
                    "history://result",
                    HistoryHit {
                        kind,
                        workspace_id,
                        artifact_id,
                        card_id,
                        card_title,
                        path: path.clone(),
                        line_number,
                        line_text: line_text.clone(),
                        match_text: mtxt,
                    },
                );
                total += 1;
                if total >= MAX_RESULTS {
                    capped = true;
                    break;
                }
            }
            if let Some(mut c) = handle.child.lock().take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            let status = if cancelled.load(Ordering::SeqCst) {
                HistoryDoneStatus::Cancelled
            } else if capped {
                HistoryDoneStatus::Capped
            } else if error.is_some() {
                HistoryDoneStatus::Error
            } else {
                HistoryDoneStatus::Completed
            };
            let _ = app_clone.emit(
                "history://done",
                HistoryDoneEvent {
                    status,
                    message: error,
                    total,
                },
            );
        });

        Ok(())
    }
}

/// The most characters of a hit's line sent to the frontend.
const MAX_LINE_CHARS: usize = 500;

/// A hit's line, cut at `MAX_LINE_CHARS` characters with an ellipsis. 1.168.1
/// (A3): decided by characters, as it cuts — a line of 500 characters or
/// fewer that is longer in bytes (accents, emoji) is sent whole, never
/// with an ellipsis that stands for nothing.
fn cut_line(line: String) -> String {
    if line.chars().count() <= MAX_LINE_CHARS {
        return line;
    }
    let mut cut: String = line.chars().take(MAX_LINE_CHARS).collect();
    cut.push('…');
    cut
}

fn find_rg() -> Option<std::path::PathBuf> {
    shell_env::find_in_path(&shell_env::get().path, "rg").map(std::path::PathBuf::from)
}

/// Return the rg search roots for the given scope. Only existing paths
/// are returned — rg errors on a missing root path.
fn scoped_roots(config_dir: &Path, scope: &HistoryScope) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    match scope {
        HistoryScope::Workspace(ws_id) => {
            let kanban = crate::kanban::boards_dir(config_dir).join(format!("{ws_id}.json"));
            if kanban.exists() {
                roots.push(kanban);
            }
            let intake = config_dir.join("intake/transcripts").join(ws_id);
            if intake.is_dir() {
                roots.push(intake);
            }
            let swarms = config_dir.join("swarms").join(ws_id);
            if swarms.is_dir() {
                roots.push(swarms);
            }
        }
        HistoryScope::Global => {
            for sub in [
                "kanban",
                "agents/runs",
                "snapshots",
                "intake/transcripts",
                "swarms",
            ] {
                let p = config_dir.join(sub);
                if p.exists() {
                    roots.push(p);
                }
            }
        }
    }
    roots
}

fn relative_path(config_dir: &Path, path: &Path) -> String {
    path.strip_prefix(config_dir)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

/// Classify a relative path (rooted at config_dir) into its history
/// kind + artifact id + optional workspace id. Returns None for paths
/// that don't match any known artifact layout (e.g. tmp files,
/// orphans). Mirrors the on-disk layout documented in
/// `docs/STATUS.md` (Cycle G2 inventory table).
pub fn classify(rel: &str) -> Option<(HistoryKind, Option<String>, String)> {
    // Use forward slashes for matching — Atelier is macOS-only.
    let rel = rel.replace('\\', "/");
    if let Some(rest) = rel.strip_prefix("kanban/workspaces/") {
        if let Some(ws_id) = rest.strip_suffix(".json") {
            return Some((HistoryKind::Card, Some(ws_id.into()), ws_id.into()));
        }
    }
    if let Some(rest) = rel.strip_prefix("agents/runs/") {
        if let Some(run_id) = rest.strip_suffix(".log") {
            return Some((HistoryKind::RunTranscript, None, run_id.into()));
        }
        if let Some(run_id) = rest.strip_suffix(".json") {
            return Some((HistoryKind::RunRecord, None, run_id.into()));
        }
    }
    if let Some(rest) = rel.strip_prefix("snapshots/") {
        if let Some(run_id) = rest.strip_suffix("/changes.json") {
            return Some((HistoryKind::Snapshot, None, run_id.into()));
        }
    }
    if let Some(rest) = rel.strip_prefix("intake/transcripts/") {
        // Layout: <ws_id>/<card_id>/<intake_id>.log
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() == 3 {
            let ws_id = parts[0];
            if let Some(intake_id) = parts[2].strip_suffix(".log") {
                return Some((
                    HistoryKind::IntakeTranscript,
                    Some(ws_id.into()),
                    intake_id.into(),
                ));
            }
        }
    }
    if let Some(rest) = rel.strip_prefix("swarms/") {
        // Layout: <ws_id>/<swarm_id>/mailbox.jsonl
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() == 3 && parts[2] == "mailbox.jsonl" {
            return Some((
                HistoryKind::SwarmMailbox,
                Some(parts[0].into()),
                parts[1].into(),
            ));
        }
    }
    None
}

/// QoL 11.3: which card each line of a board file belongs to. The file is
/// Plyloft's own `serde_json::to_vec_pretty` of `KanbanFile` (two-space
/// indent): each card is an object in `cards` whose own keys sit six spaces
/// in, `"id"` first, so a card's line is under the last such `"id"` at or
/// above it (nested objects' ids are deeper and never match). Built once per
/// board per search; each hit is a binary search.
pub struct BoardIndex {
    lines: Vec<String>,
    /// (1-based line of a card's `"id"`, that id, its title), in line order.
    ids: Vec<(u32, String, Option<String>)>,
}

impl BoardIndex {
    pub fn new(text: &str) -> Self {
        const CARD_ID_KEY: &str = "      \"id\": ";
        const CARD_TITLE_KEY: &str = "      \"title\": ";
        let value = |line: &str, key: &str| -> Option<String> {
            let v = line.strip_prefix(key)?.trim_end().trim_end_matches(',');
            serde_json::from_str::<String>(v).ok()
        };
        let lines: Vec<String> = text.lines().map(str::to_string).collect();
        let mut ids: Vec<(u32, String, Option<String>)> = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if let Some(id) = value(line, CARD_ID_KEY) {
                ids.push((i as u32 + 1, id, None));
            } else if let Some(title) = value(line, CARD_TITLE_KEY) {
                if let Some(last) = ids.last_mut() {
                    last.2.get_or_insert(title);
                }
            }
        }
        Self { lines, ids }
    }

    /// The card of a hit at `line_number` (1-based, as rg numbers them) —
    /// only while that line still reads `line_text` (the board may have been
    /// written since rg read it); `None` above the first card, past the end
    /// or when the line has changed, and the hit lands on the Board.
    pub fn card_at(&self, line_number: u32, line_text: &str) -> Option<String> {
        self.card_with_title_at(line_number, line_text).map(|(id, _)| id)
    }

    /// `card_at`, with the card's title when the board names one.
    pub fn card_with_title_at(&self, line_number: u32, line_text: &str) -> Option<(String, Option<String>)> {
        let line = self.lines.get((line_number as usize).checked_sub(1)?)?;
        if line.trim_end() != line_text.trim_end() {
            return None;
        }
        let at = self.ids.partition_point(|(l, _, _)| *l <= line_number);
        at.checked_sub(1).map(|i| (self.ids[i].1.clone(), self.ids[i].2.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_is_cut_by_characters_not_bytes() {
        let accents = "é".repeat(MAX_LINE_CHARS);
        assert_eq!(cut_line(accents.clone()), accents, "500 characters (1000 bytes) are sent whole");
        let long = "é".repeat(MAX_LINE_CHARS + 1);
        let cut = cut_line(long);
        assert_eq!(cut.chars().count(), MAX_LINE_CHARS + 1);
        assert!(cut.ends_with("é…"));
        assert_eq!(cut_line("short".into()), "short");
    }

    #[test]
    fn classify_card() {
        let (k, ws, id) =
            classify("kanban/workspaces/abc-123.json").expect("classified");
        assert_eq!(k, HistoryKind::Card);
        assert_eq!(ws.as_deref(), Some("abc-123"));
        assert_eq!(id, "abc-123");
    }

    #[test]
    fn classify_run_transcript() {
        let (k, ws, id) =
            classify("agents/runs/run-42.log").expect("classified");
        assert_eq!(k, HistoryKind::RunTranscript);
        assert!(ws.is_none());
        assert_eq!(id, "run-42");
    }

    #[test]
    fn classify_run_record() {
        let (k, ws, id) =
            classify("agents/runs/run-42.json").expect("classified");
        assert_eq!(k, HistoryKind::RunRecord);
        assert!(ws.is_none());
        assert_eq!(id, "run-42");
    }

    #[test]
    fn classify_snapshot() {
        let (k, ws, id) = classify("snapshots/run-42/changes.json")
            .expect("classified");
        assert_eq!(k, HistoryKind::Snapshot);
        assert!(ws.is_none());
        assert_eq!(id, "run-42");
    }

    #[test]
    fn classify_intake_transcript() {
        let (k, ws, id) = classify(
            "intake/transcripts/ws-1/card-1/intake-abc.log",
        )
        .expect("classified");
        assert_eq!(k, HistoryKind::IntakeTranscript);
        assert_eq!(ws.as_deref(), Some("ws-1"));
        assert_eq!(id, "intake-abc");
    }

    #[test]
    fn classify_swarm_mailbox() {
        let (k, ws, id) =
            classify("swarms/ws-1/swarm-42/mailbox.jsonl").expect("classified");
        assert_eq!(k, HistoryKind::SwarmMailbox);
        assert_eq!(ws.as_deref(), Some("ws-1"));
        assert_eq!(id, "swarm-42");
    }

    #[test]
    fn board_index_finds_the_card_a_line_is_in_while_the_line_is_unchanged() {
        let mut a = crate::kanban::KanbanCard::new(
            "card-a".into(),
            "ws".into(),
            "First card".into(),
            None,
            crate::kanban::KanbanColumnId::Todo,
        );
        a.notes = Some("needle in a".into());
        let mut b = a.clone();
        b.id = "card-\"b\"".into();
        b.title = "Second card".into();
        b.notes = Some("needle in b".into());
        b.builder = Some(
            serde_json::from_value(serde_json::json!({
                "vendor": "claude", "startedAt": 0, "snapshots": [{ "n": 1, "sha": "s", "at": 0 }]
            }))
            .unwrap(),
        );
        let file = crate::kanban::KanbanFile { version: 8, cards: vec![a, b] };
        let text = String::from_utf8(serde_json::to_vec_pretty(&file).unwrap()).unwrap();
        let board = BoardIndex::new(&text);
        let at = |needle: &str| {
            let (i, line) = text.lines().enumerate().find(|(_, l)| l.contains(needle)).unwrap();
            board.card_at(i as u32 + 1, line)
        };
        assert_eq!(at("needle in a").as_deref(), Some("card-a"));
        assert_eq!(at("Second card").as_deref(), Some("card-\"b\""));
        assert_eq!(at("needle in b").as_deref(), Some("card-\"b\""));
        let (i, line) = text.lines().enumerate().find(|(_, l)| l.contains("needle in b")).unwrap();
        assert_eq!(
            board.card_with_title_at(i as u32 + 1, line),
            Some(("card-\"b\"".to_string(), Some("Second card".to_string()))),
            "the card's own title, not a nested one"
        );
        assert_eq!(at("\"version\""), None, "above the first card");
        assert_eq!(board.card_at(100_000, ""), None);
        assert_eq!(board.card_at(0, ""), None);
        // The board was written since rg read the line: no card, the Board.
        let i = text.lines().position(|l| l.contains("needle in b")).unwrap() as u32 + 1;
        assert_eq!(board.card_at(i, "      \"notes\": \"needle in a\","), None);
    }

    #[test]
    fn classify_rejects_unknown() {
        assert!(classify("workspaces.json").is_none());
        assert!(classify("snapshots/run-1/before/file.txt").is_none());
        assert!(classify("agents/runs/run-1/extra/file.txt").is_none());
    }

    #[test]
    fn classify_rejects_orphan_snapshot_files() {
        // before/ residual content (failed compute_changes cleanup) — should
        // not classify as Snapshot. Our rg --glob '!snapshots/*/before/**'
        // excludes these at the search level, but the classify guard is a
        // belt-and-braces defense in case the glob slips.
        assert!(classify("snapshots/run-1/before/src/main.rs").is_none());
    }

    #[test]
    fn scoped_roots_workspace_only_includes_existing_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path();
        // Create only the kanban file; intake + swarms dirs missing.
        std::fs::create_dir_all(cfg.join("kanban/workspaces")).unwrap();
        std::fs::write(cfg.join("kanban/workspaces/ws-1.json"), "{}").unwrap();
        let roots = scoped_roots(
            cfg,
            &HistoryScope::Workspace("ws-1".into()),
        );
        assert_eq!(roots.len(), 1);
        assert!(roots[0].ends_with("kanban/workspaces/ws-1.json"));
    }

    #[test]
    fn scoped_roots_global_only_includes_existing_subdirs() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path();
        std::fs::create_dir_all(cfg.join("kanban")).unwrap();
        std::fs::create_dir_all(cfg.join("snapshots")).unwrap();
        // agents/runs + intake + swarms absent.
        let roots = scoped_roots(cfg, &HistoryScope::Global);
        assert_eq!(roots.len(), 2);
        assert!(roots.iter().any(|r| r.ends_with("kanban")));
        assert!(roots.iter().any(|r| r.ends_with("snapshots")));
    }
}
