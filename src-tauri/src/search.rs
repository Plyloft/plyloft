use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter};

use crate::shell_env;

const MAX_RESULTS: usize = 1000;
/// How much of rg's stderr is kept. The rest is read and dropped, so a long
/// run of "Permission denied" lines can't fill the pipe and stall rg.
const STDERR_KEEP: usize = 4096;
/// The longest piece of rg's own words (or of the files filter) a failure
/// message carries, in characters.
const DETAIL_MAX_CHARS: usize = 300;
/// The search panel's label for its regular-expression toggle
/// (`SearchPanel.tsx`), named in the message that says how to get out.
const REGEX_TOGGLE_LABEL: &str = "Regular expression";

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default)]
    pub glob: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub workspace_id: String,
    pub path: String,
    pub line_number: u32,
    pub line_text: String,
    pub match_text: String,
    pub column_start: u32,
    pub column_end: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DoneStatus {
    Completed,
    Cancelled,
    Capped,
    NoRipgrep,
    Error,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchDoneEvent {
    pub workspace_id: String,
    pub status: DoneStatus,
    pub message: Option<String>,
    pub total: usize,
}

struct SearchHandle {
    child: Mutex<Option<Child>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct SearchRegistry {
    by_workspace: Mutex<HashMap<String, Arc<SearchHandle>>>,
}

impl SearchRegistry {
    fn cancel_existing(&self, workspace_id: &str) {
        let prev = self.by_workspace.lock().remove(workspace_id);
        if let Some(handle) = prev {
            handle.cancelled.store(true, Ordering::SeqCst);
            // 1.176.2 (REV-R4 F1, Hard rule 4): killed but left in place, so
            // the reader thread (stdout now at EOF) takes it and waits for
            // it — a dropped `Child` is never reaped and stays a zombie.
            if let Some(child) = handle.child.lock().as_mut() {
                let _ = child.kill();
            }
        }
    }

    pub fn cancel(&self, workspace_id: &str) {
        self.cancel_existing(workspace_id);
    }

    pub fn cancel_all(&self) {
        let ids: Vec<String> = self.by_workspace.lock().keys().cloned().collect();
        for id in ids {
            self.cancel_existing(&id);
        }
    }

    pub fn start(
        &self,
        app: AppHandle,
        workspace_id: String,
        cwd: String,
        query: String,
        opts: SearchOptions,
    ) -> Result<(), String> {
        if query.len() < 2 {
            return Err("query must be at least 2 characters".into());
        }
        if !Path::new(&cwd).is_dir() {
            return Err("workspace cwd not found".into());
        }
        self.cancel_existing(&workspace_id);

        let rg = match find_rg() {
            Some(p) => p,
            None => {
                let _ = app.emit(
                    "search://done",
                    SearchDoneEvent {
                        workspace_id: workspace_id.clone(),
                        status: DoneStatus::NoRipgrep,
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

        let mut command = crate::platform::new_command(&rg);
        command.arg("--json");
        if !opts.case_sensitive {
            command.arg("--ignore-case");
        }
        if opts.whole_word {
            command.arg("--word-regexp");
        }
        if !opts.regex {
            command.arg("--fixed-strings");
        }
        if opts.include_hidden {
            command.arg("--hidden");
        }
        if let Some(glob) = opts.glob.as_ref() {
            if !glob.is_empty() {
                command.arg("--glob").arg(glob);
            }
        }
        command.arg("--glob").arg("!.git");
        command.arg("--").arg(&query).arg(&cwd);
        command.env("PATH", &shell_env::get().path);
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|e| format!("spawn rg: {e}"))?;
        let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
        let stderr_reader = child.stderr.take().map(|err| thread::spawn(move || drain_head(err)));

        let cancelled = Arc::new(AtomicBool::new(false));
        let handle = Arc::new(SearchHandle {
            child: Mutex::new(Some(child)),
            cancelled: cancelled.clone(),
        });
        self.by_workspace
            .lock()
            .insert(workspace_id.clone(), handle.clone());

        let app_clone = app.clone();
        let ws_id = workspace_id.clone();
        let glob = opts.glob.clone().filter(|g| !g.is_empty());
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut total = 0usize;
            let mut capped = false;
            let mut error: Option<String> = None;
            let mut saw_summary = false;
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
                match value.get("type").and_then(|v| v.as_str()) {
                    Some("match") => {}
                    Some("summary") => {
                        saw_summary = true;
                        continue;
                    }
                    _ => continue,
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
                let line_text = if line_text.len() > 500 {
                    let mut truncated: String = line_text.chars().take(500).collect();
                    truncated.push('…');
                    truncated
                } else {
                    line_text
                };
                let submatches = data
                    .get("submatches")
                    .and_then(|s| s.as_array())
                    .cloned()
                    .unwrap_or_default();
                if submatches.is_empty() {
                    continue;
                }
                for sm in &submatches {
                    let mtxt = sm
                        .get("match")
                        .and_then(|m| m.get("text"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .to_string();
                    let start = sm.get("start").and_then(|n| n.as_u64()).unwrap_or(0) as u32;
                    let end = sm.get("end").and_then(|n| n.as_u64()).unwrap_or(0) as u32;
                    let _ = app_clone.emit(
                        "search://result",
                        SearchMatch {
                            workspace_id: ws_id.clone(),
                            path: path.clone(),
                            line_number,
                            line_text: line_text.clone(),
                            match_text: mtxt,
                            column_start: start,
                            column_end: end,
                        },
                    );
                    total += 1;
                    if total >= MAX_RESULTS {
                        capped = true;
                        break;
                    }
                }
                if capped {
                    break;
                }
            }
            // Close: stop rg only when we stopped reading early; otherwise it
            // has finished and its exit code says whether it searched at all.
            let stopped_early = capped || error.is_some() || cancelled.load(Ordering::SeqCst);
            let mut exit_code: Option<i32> = None;
            if let Some(mut c) = handle.child.lock().take() {
                if stopped_early {
                    let _ = c.kill();
                }
                exit_code = c.wait().ok().and_then(|s| s.code());
            }
            let stderr_head = stderr_reader
                .and_then(|h| h.join().ok())
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default();
            let (status, message) = end_status(&EndOf {
                cancelled: cancelled.load(Ordering::SeqCst),
                capped,
                read_error: error,
                exit_code,
                saw_summary,
                stderr_head: &stderr_head,
                glob: glob.as_deref(),
            });
            let _ = app_clone.emit(
                "search://done",
                SearchDoneEvent {
                    workspace_id: ws_id,
                    status,
                    message,
                    total,
                },
            );
        });

        Ok(())
    }
}

/// Reads `from` to its end, keeping only the first `STDERR_KEEP` bytes.
fn drain_head(mut from: impl Read) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = STDERR_KEEP.saturating_sub(kept.len());
                kept.extend_from_slice(&buf[..n.min(room)]);
            }
        }
    }
    kept
}

/// What a finished rg run left behind, for `end_status`.
struct EndOf<'a> {
    cancelled: bool,
    capped: bool,
    read_error: Option<String>,
    exit_code: Option<i32>,
    /// rg's `--json` ends a search it actually ran with a "summary" message.
    saw_summary: bool,
    stderr_head: &'a str,
    /// The files filter the person typed, if any.
    glob: Option<&'a str>,
}

/// `text` cut to `DETAIL_MAX_CHARS` characters, with an ellipsis when cut.
fn capped_detail(text: &str) -> String {
    match text.char_indices().nth(DETAIL_MAX_CHARS) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

/// The status and message a finished search reports. rg exits 2 both when
/// it couldn't search at all (a pattern or glob it can't parse) and when it
/// searched but some entries were unreadable; only the first is a failure.
/// A search that ran keeps reading as it always has ("No matches" or its
/// results), whatever it printed about entries it couldn't read.
fn end_status(end: &EndOf) -> (DoneStatus, Option<String>) {
    if end.cancelled {
        return (DoneStatus::Cancelled, None);
    }
    if end.capped {
        return (DoneStatus::Capped, None);
    }
    if let Some(e) = &end.read_error {
        return (DoneStatus::Error, Some(e.clone()));
    }
    if end.exit_code == Some(2) && !end.saw_summary {
        if end.stderr_head.contains("regex parse error") {
            let detail = end
                .stderr_head
                .lines()
                .find_map(|l| l.trim().strip_prefix("error:").map(|d| d.trim().to_string()))
                .filter(|d| !d.is_empty());
            let way_out = format!("Turn off {REGEX_TOGGLE_LABEL} to search for the text exactly as typed.");
            let message = match detail {
                Some(d) => format!("That isn't a valid regular expression ({}). {way_out}", capped_detail(&d)),
                None => format!("That isn't a valid regular expression. {way_out}"),
            };
            return (DoneStatus::Error, Some(message));
        }
        if let Some(glob) = end.glob.filter(|_| end.stderr_head.contains("error parsing glob")) {
            return (
                DoneStatus::Error,
                Some(format!(
                    "The files filter \u{201c}{}\u{201d} isn't a pattern the search can read. Check its brackets and braces.",
                    capped_detail(glob)
                )),
            );
        }
        let first = end
            .stderr_head
            .lines()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
            .map(|l| l.strip_prefix("rg: ").unwrap_or(l).to_string());
        let message = match first {
            Some(f) => format!("The search failed: {}", capped_detail(&f)),
            None => "The search failed".to_string(),
        };
        return (DoneStatus::Error, Some(message));
    }
    (DoneStatus::Completed, None)
}

fn find_rg() -> Option<std::path::PathBuf> {
    shell_env::find_in_path(&shell_env::get().path, "rg").map(std::path::PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end(exit_code: Option<i32>, saw_summary: bool, stderr_head: &str) -> (DoneStatus, Option<String>) {
        end_with(exit_code, saw_summary, stderr_head, None)
    }

    fn end_with(exit_code: Option<i32>, saw_summary: bool, stderr_head: &str, glob: Option<&str>) -> (DoneStatus, Option<String>) {
        end_status(&EndOf {
            cancelled: false,
            capped: false,
            read_error: None,
            exit_code,
            saw_summary,
            stderr_head,
            glob,
        })
    }

    #[test]
    fn an_invalid_pattern_is_an_error_not_no_results() {
        // rg 15's own words for `foo(` with --json: no JSON at all, exit 2.
        let stderr = "rg: regex parse error:\n    (?:foo()\n    ^\nerror: unclosed group\n";
        let (status, message) = end(Some(2), false, stderr);
        assert_eq!(status, DoneStatus::Error);
        assert_eq!(
            message.as_deref(),
            Some("That isn't a valid regular expression (unclosed group). Turn off Regular expression to search for the text exactly as typed.")
        );
        // The toggle is named by its label in the search panel.
        assert!(include_str!("../../src/components/SearchPanel.tsx").contains(&format!("[\"regex\", \"{REGEX_TOGGLE_LABEL}\"]")));
        let (_, without_reason) = end(Some(2), false, "rg: regex parse error:\n");
        assert_eq!(
            without_reason.as_deref(),
            Some("That isn't a valid regular expression. Turn off Regular expression to search for the text exactly as typed.")
        );
    }

    #[test]
    fn a_files_filter_rg_cannot_read_is_named_as_the_filter() {
        let stderr = "rg: error parsing glob '[': unclosed character class; missing ']'\n";
        let (status, message) = end_with(Some(2), false, stderr, Some("["));
        assert_eq!(status, DoneStatus::Error);
        assert_eq!(
            message.as_deref(),
            Some("The files filter \u{201c}[\u{201d} isn't a pattern the search can read. Check its brackets and braces.")
        );
        // Anything else rg refuses keeps its own words.
        let (status, message) = end(Some(2), false, "rg: some other refusal\n");
        assert_eq!(status, DoneStatus::Error);
        assert_eq!(message.as_deref(), Some("The search failed: some other refusal"));
    }

    /// REV-R4 F2: rg's words (and a long filter) are cut at 300 characters,
    /// on a character boundary, with an ellipsis.
    #[test]
    fn a_failure_message_carries_at_most_300_characters_of_detail() {
        let long = "é".repeat(400);
        let (_, message) = end(Some(2), false, &format!("rg: {long}\n"));
        assert_eq!(message.unwrap(), format!("The search failed: {}…", "é".repeat(300)));
        let (_, message) = end_with(Some(2), false, "rg: error parsing glob 'x'\n", Some(&long));
        assert!(message.unwrap().contains(&format!("\u{201c}{}…\u{201d}", "é".repeat(300))));
        assert_eq!(capped_detail("short"), "short");
    }

    /// REV-R4 F1 (Hard rule 4): a cancelled search kills rg in place, so the
    /// reader thread takes it and waits for it; taking it here would drop an
    /// unreaped child (a zombie per cancelled search).
    #[test]
    fn a_cancelled_search_leaves_rg_to_be_reaped() {
        for (source, name) in [(include_str!("search.rs"), "search.rs"), (include_str!("history_search.rs"), "history_search.rs")] {
            let body = &source[source.find("fn cancel_existing(").unwrap()..];
            let body = &body[..body.find("\n    }\n").unwrap()];
            assert!(body.contains("handle.child.lock().as_mut()"), "{name}");
            assert!(!body.contains("child.lock().take()"), "{name}: the child is taken and dropped unreaped");
        }
    }

    #[test]
    fn a_search_that_ran_past_unreadable_folders_still_reads_as_done() {
        let stderr = "rg: ./locked: Permission denied (os error 13)\n";
        assert_eq!(end(Some(2), true, stderr), (DoneStatus::Completed, None));
        assert_eq!(end(Some(1), true, ""), (DoneStatus::Completed, None));
        assert_eq!(end(Some(0), true, ""), (DoneStatus::Completed, None));
    }

    #[test]
    fn cancel_and_cap_win_over_the_exit_code() {
        let base = EndOf {
            cancelled: true,
            capped: true,
            read_error: None,
            exit_code: Some(2),
            saw_summary: false,
            stderr_head: "rg: regex parse error:",
            glob: None,
        };
        assert_eq!(end_status(&base).0, DoneStatus::Cancelled);
        assert_eq!(end_status(&EndOf { cancelled: false, ..base }).0, DoneStatus::Capped);
    }

    #[test]
    fn stderr_is_read_to_its_end_and_only_its_head_kept() {
        // 200 KB of "Permission denied" lines: all of it is read (so rg never
        // blocks on a full pipe), and only the first STDERR_KEEP bytes stay.
        let line = b"rg: ./x: Permission denied (os error 13)\n";
        let mut big = Vec::new();
        while big.len() < 200 * 1024 {
            big.extend_from_slice(line);
        }
        let mut cursor = std::io::Cursor::new(big.clone());
        let kept = drain_head(&mut cursor);
        assert_eq!(cursor.position() as usize, big.len());
        assert_eq!(kept.len(), STDERR_KEEP);
        assert_eq!(&kept[..], &big[..STDERR_KEEP]);
    }
}
