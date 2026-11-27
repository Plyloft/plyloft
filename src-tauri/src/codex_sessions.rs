//! v1.154.1 round 2 (walk J1) — which Codex conversation belongs to a card.
//!
//! `codex resume --last` is not a card's own conversation: after a relaunch,
//! Resume on one card's Codex Builder (whose folder had no transcript Codex
//! would take) reopened another card's conversation and offered to work in
//! that card's folder. So a Codex Builder (a single
//! Builder or a Build-with-both lane) is resumed by **its own session id**,
//! found here, and never with `--last`.
//!
//! Codex (0.154–0.158) writes one transcript per session under
//! `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<start time>-<id>.jsonl`. Its
//! first line is the `session_meta` record, which names the session `id`,
//! the `cwd` it ran in and its `source` (`cli` for the interactive TUI a
//! Builder runs; `exec` for headless runs such as a Challenger; the
//! app-server's own value for Codex chat tiles). Ply's per-launch
//! `CODEX_HOME` overlay links `sessions` back to the real home
//! ([`crate::codex_home`]), so every Builder transcript lands there.
//!
//! The id is looked up when Resume is pressed rather than recorded when the
//! session starts: Codex picks the id itself and writes the transcript on
//! its own schedule, so recording it would be this same lookup run at a
//! moment the file may not exist yet. A card's folder is its own (one
//! worktree per card, one more per Build-with-both lane), so the newest
//! interactive session started in that folder since the Builder started is
//! the card's conversation — the rule `claude --continue` applies per
//! directory, less any Codex the owner ran there earlier. "Newest" is the
//! session's own UTC start (its UUIDv7 id, or the record's timestamp), not
//! the file name's local time.
//!
//! Codex writes no transcript before a session's first turn: a Codex
//! Builder quit at its folder-trust question has nothing to resume, and the
//! card says so ([`NOT_FOUND`]) — intended.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// Where Codex keeps its transcripts on this Mac.
pub fn sessions_root() -> PathBuf {
    crate::codex_home::real_codex_home().join("sessions")
}

/// What a card says when no conversation of its own can be found. The
/// Builder never falls back to `--last`, which could reopen another card's.
pub const NOT_FOUND: &str = "Couldn't find this card's Codex conversation, so Resume can't continue it. \
Start fresh opens a new session in this card's folder with the brief sent again; the work so far stays.";

/// A session must have started no earlier than this before the Builder's
/// recorded start: the Builder's `started_at` is written just after its CLI
/// is spawned, and Codex names its session a moment later.
pub const STARTED_TOLERANCE_MS: i64 = 60_000;
const DAY_MS: i64 = 86_400_000;

/// The id of the newest interactive Codex session started in `folder` — at
/// or after `since` (the Builder's or build's start, ms) less
/// [`STARTED_TOLERANCE_MS`], so a Codex the owner ran in that folder before
/// the Builder is never taken — if any transcript under `root` names one.
///
/// Runs under the card start lock, so it stays cheap: a transcript whose
/// name says it started before `since` is skipped unread, and a first line
/// that doesn't contain the folder's name is not parsed.
pub fn latest_for_folder(root: &Path, folder: &Path, since: Option<i64>) -> Option<String> {
    let want = normalized(folder);
    let needles = folder_needles(folder, &want);
    let floor = since.filter(|s| *s > 0).map(|s| s - STARTED_TOLERANCE_MS);
    let mut files = Vec::new();
    collect_rollouts(root, &mut files, 0);
    let mut best: Option<(i64, String)> = None;
    for file in &files {
        let Some(name) = file.file_name().and_then(|n| n.to_str()) else { continue };
        if let Some(floor) = floor {
            if started_before(name, floor) {
                continue;
            }
        }
        let Some((id, started)) = session_in(file, &want, &needles) else { continue };
        if floor.is_some_and(|f| started < f) {
            continue;
        }
        // Newest by the session's own start (UTC), never the file name's
        // local time.
        if best.as_ref().is_none_or(|(at, _)| started > *at) {
            best = Some((started, id));
        }
    }
    best.map(|(_, id)| id)
}

/// Terminals block P2/P4: every interactive session started in `folder`
/// since `since` (less the tolerance), as (start ms, id, transcript), newest
/// first — so two tiles in one folder can each claim their own, in start
/// order, and Resume… lists them with when they were last written.
pub(crate) fn rollouts_for_folder(root: &Path, folder: &Path, since: Option<i64>) -> Vec<(i64, String, PathBuf)> {
    let want = normalized(folder);
    let needles = folder_needles(folder, &want);
    let floor = since.filter(|s| *s > 0).map(|s| s - STARTED_TOLERANCE_MS);
    let mut files = Vec::new();
    collect_rollouts(root, &mut files, 0);
    let mut out: Vec<(i64, String, PathBuf)> = files
        .into_iter()
        .filter(|file| {
            let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
            floor.is_none_or(|f| !started_before(name, f))
        })
        .filter_map(|file| session_in(&file, &want, &needles).map(|(id, started)| (started, id, file)))
        .filter(|(started, _, _)| floor.is_none_or(|f| *started >= f))
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out
}

/// 1.174.0 (G3b review, 1b): [`rollouts_for_folder`] for several folders in
/// one walk of `root` — each rollout's head read once and matched against
/// them all. (start ms, id, transcript, index into `folders`), newest first.
pub(crate) fn rollouts_for_folders(
    root: &Path,
    folders: &[PathBuf],
    since: Option<i64>,
) -> Vec<(i64, String, PathBuf, usize)> {
    if folders.is_empty() {
        return Vec::new();
    }
    let wants: Vec<PathBuf> = folders.iter().map(|f| normalized(f)).collect();
    // One folder whose name can't be a needle turns the prefilter off.
    let mut needles: Vec<String> = Vec::new();
    for (folder, want) in folders.iter().zip(&wants) {
        let mine = folder_needles(folder, want);
        if mine.is_empty() {
            needles.clear();
            break;
        }
        for n in mine {
            if !needles.contains(&n) {
                needles.push(n);
            }
        }
    }
    let floor = since.filter(|s| *s > 0).map(|s| s - STARTED_TOLERANCE_MS);
    let mut files = Vec::new();
    collect_rollouts(root, &mut files, 0);
    let mut out: Vec<(i64, String, PathBuf, usize)> = files
        .into_iter()
        .filter(|file| {
            let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
            floor.is_none_or(|f| !started_before(name, f))
        })
        .filter_map(|file| session_in_any(&file, &wants, &needles).map(|(id, started, at)| (started, id, file, at)))
        .filter(|(started, _, _, _)| floor.is_none_or(|f| *started >= f))
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out
}

/// Terminals block P5: every transcript, read once, for many "is this
/// session's file still there" questions — 1.174.0 E9 round 1: whole paths,
/// so History stats the one a row names for its last write.
pub(crate) fn rollout_paths(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_rollouts(root, &mut files, 0);
    files
}


/// Terminals block P2: the transcript of session `id` (its file name ends
/// with the id).
pub(crate) fn rollout_for(root: &Path, id: &str) -> Option<PathBuf> {
    let mut files = Vec::new();
    collect_rollouts(root, &mut files, 0);
    let suffix = format!("{id}.jsonl");
    files.into_iter().find(|f| f.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(&suffix)))
}

/// The start (unix ms) a time-ordered UUIDv7 carries in its first 48 bits.
fn uuid_v7_ms(id: &str) -> Option<i64> {
    let uuid = uuid::Uuid::parse_str(id.trim()).ok()?;
    if uuid.get_version_num() != 7 {
        return None;
    }
    let b = uuid.as_bytes();
    Some(b[..6].iter().fold(0i64, |acc, byte| (acc << 8) | i64::from(*byte)))
}

/// `rollout-<local start>-<uuid>.jsonl` says it started before `floor`: by
/// the UUIDv7 when it is one, else by its date a day early (the name's time
/// is local).
fn started_before(name: &str, floor: i64) -> bool {
    let stem = name.trim_end_matches(".jsonl");
    if stem.len() >= 36 {
        if let Some(ms) = stem.get(stem.len() - 36..).and_then(uuid_v7_ms) {
            return ms < floor;
        }
    }
    let (Some(day), Some(floor_day)) = (
        name.strip_prefix("rollout-").and_then(|r| r.get(..10)),
        chrono::DateTime::from_timestamp_millis(floor - DAY_MS).map(|d| d.format("%Y-%m-%d").to_string()),
    ) else {
        return false;
    };
    day.len() == 10 && day < floor_day.as_str()
}

/// What a transcript's first line must contain to be worth parsing: the
/// folder's own name, as the card records it and canonical (a symlinked
/// parent or `/var` → `/private/var` changes the path, never the name). A
/// card's folder name is unique (`card-<id>`, `card-<id>-b`). Empty — no
/// pre-check — when JSON would escape it.
fn folder_needles(folder: &Path, want: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for path in [folder, want] {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            return Vec::new();
        };
        if name.is_empty() || name.contains('"') || name.contains('\\') || name.chars().any(char::is_control) {
            return Vec::new();
        }
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// `root/YYYY/MM/DD/rollout-*.jsonl`; the depth bound keeps a stray link
/// from walking the disk.
fn collect_rollouts(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            collect_rollouts(&path, out, depth + 1);
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
        {
            out.push(path);
        }
    }
}

/// Compare (1.177.0): [`session_in`] for one rollout against `folder` —
/// its session id and start, when it is an interactive session that ran
/// there.
pub(crate) fn session_of(file: &Path, folder: &Path) -> Option<(String, i64)> {
    let want = normalized(folder);
    let needles = folder_needles(folder, &want);
    session_in(file, &want, &needles)
}

/// The session id and its start (unix ms) in `file` when its first record
/// is an interactive session that ran in `want`.
fn session_in(file: &Path, want: &Path, needles: &[String]) -> Option<(String, i64)> {
    session_in_any(file, std::slice::from_ref(&want.to_path_buf()), needles).map(|(id, started, _)| (id, started))
}

/// [`session_in`] against several folders at once: the session's id, its
/// start and which of `wants` (normalized) it ran in.
fn session_in_any(file: &Path, wants: &[PathBuf], needles: &[String]) -> Option<(String, i64, usize)> {
    let mut first = String::new();
    BufReader::new(std::fs::File::open(file).ok()?)
        .read_line(&mut first)
        .ok()?;
    if !needles.is_empty() && !needles.iter().any(|n| first.contains(n.as_str())) {
        return None;
    }
    let record: serde_json::Value = serde_json::from_str(first.trim()).ok()?;
    if record.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let meta = record.get("payload")?;
    // Only the interactive TUI a Builder runs. A headless `exec` (a
    // Challenger reviewing in the same folder) or a sub-agent is not the
    // card's conversation. Older transcripts without `source` count.
    match meta.get("source") {
        None => {}
        Some(serde_json::Value::String(s)) if s == "cli" => {}
        Some(_) => return None,
    }
    let cwd = meta.get("cwd").and_then(|c| c.as_str())?;
    let cwd = normalized(Path::new(cwd));
    let at = wants.iter().position(|w| *w == cwd)?;
    let id = meta
        .get("id")
        .or_else(|| meta.get("session_id"))
        .and_then(|id| id.as_str())
        .map(str::trim)
        .filter(|id| !id.is_empty())?
        .to_string();
    let started = uuid_v7_ms(&id)
        .or_else(|| {
            meta.get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.timestamp_millis())
        })
        .unwrap_or(i64::MIN);
    Some((id, started, at))
}

/// The same folder however it was written (a trailing slash, `/tmp` for
/// `/private/tmp`): canonical when it exists, as written otherwise.
pub(crate) fn normalized(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| {
        let s = path.to_string_lossy();
        PathBuf::from(s.trim_end_matches('/'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_790_688_527_971; // 2026-09-29T13:28:47.971Z
    const MIN: i64 = 60_000;

    /// A time-ordered UUIDv7 started at `ms`, as Codex names its sessions.
    fn v7(ms: i64, n: u16) -> String {
        let h = format!("{ms:012x}");
        format!("{}-{}-7{:03x}-8000-{:012x}", &h[..8], &h[8..], n, n)
    }

    fn meta_with(id: &str, cwd: &Path, source: Option<&str>, timestamp: &str) -> String {
        let mut payload = serde_json::json!({
            "session_id": id,
            "id": id,
            "timestamp": timestamp,
            "cwd": cwd,
            "originator": "codex-tui",
            "cli_version": "0.158.0",
            "base_instructions": { "text": "You are Codex…".repeat(2000) },
        });
        if let Some(s) = source {
            payload["source"] = serde_json::json!(s);
        }
        let line = serde_json::json!({ "timestamp": "t", "type": "session_meta", "payload": payload });
        format!("{line}\n{{\"type\":\"response_item\",\"payload\":{{}}}}\n")
    }

    fn meta(id: &str, cwd: &Path, source: Option<&str>) -> String {
        meta_with(id, cwd, source, "2026-09-29T13:28:48.034Z")
    }

    /// `rollout-<local stamp>-<id>.jsonl` in its day directory.
    fn write(root: &Path, stamp: &str, id: &str, body: &str) {
        let dir = root.join(stamp[..10].replace('-', "/"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("rollout-{stamp}-{id}.jsonl")), body).unwrap();
    }

    fn folders(names: &[&str]) -> (tempfile::TempDir, PathBuf, Vec<PathBuf>) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("sessions");
        let dirs = names
            .iter()
            .map(|n| {
                let d = tmp.path().join("wt").join(n);
                std::fs::create_dir_all(&d).unwrap();
                d
            })
            .collect();
        (tmp, root, dirs)
    }

    /// The walk's J1: two cards' Codex sessions. Card T3's Resume must find
    /// T3's session although T1's is newer on the Mac.
    #[test]
    fn each_folder_gets_its_own_session_not_the_newest_on_the_mac() {
        let (_tmp, root, d) = folders(&["card-mumpmzk1-0-b", "card-mumpvb4t-2-b"]);
        let (t1, t3) = (&d[0], &d[1]);
        let (id3, id1) = (v7(T0, 3), v7(T0 + 8 * MIN, 1));
        write(&root, "2026-09-29T15-20-00", &id3, &meta(&id3, t3, Some("cli")));
        write(&root, "2026-09-29T15-28-48", &id1, &meta(&id1, t1, Some("cli")));
        assert_eq!(latest_for_folder(&root, t3, Some(T0)), Some(id3.clone()));
        assert_eq!(latest_for_folder(&root, t1, Some(T0)), Some(id1));
        assert_eq!(latest_for_folder(&root, t3, None), Some(id3));
    }

    /// Start fresh in the same folder: the newest session there wins, by the
    /// session's own UTC start — not the file name's local time, which here
    /// sorts the other way (a time-zone change between the two).
    #[test]
    fn the_newest_session_wins_by_its_own_start_not_the_local_file_name() {
        let (_tmp, root, d) = folders(&["card"]);
        let card = &d[0];
        let (first, fresh) = (v7(T0, 1), v7(T0 + 30 * MIN, 2));
        write(&root, "2026-09-29T23-59-00", &first, &meta(&first, card, Some("cli")));
        write(&root, "2026-09-29T09-00-00", &fresh, &meta(&fresh, card, Some("cli")));
        assert_eq!(latest_for_folder(&root, card, Some(T0)), Some(fresh));
        // Ids that aren't UUIDv7 order by the record's UTC timestamp.
        let (_tmp, root, d) = folders(&["card"]);
        let card = &d[0];
        write(&root, "2026-09-30T09-00-00", "old-a", &meta_with("old-a", card, Some("cli"), "2026-09-29T10:00:00Z"));
        write(&root, "2026-09-29T08-00-00", "old-b", &meta_with("old-b", card, Some("cli"), "2026-09-29T12:00:00+02:00"));
        write(&root, "2026-09-29T07-00-00", "old-c", &meta_with("old-c", card, Some("cli"), "2026-09-29T11:00:00Z"));
        assert_eq!(latest_for_folder(&root, card, None).as_deref(), Some("old-c"));
    }

    /// A Codex the owner ran in the card's folder before the Builder started
    /// is not the Builder's conversation, even when it is the only one.
    #[test]
    fn a_session_from_before_the_builder_started_is_not_taken() {
        let (_tmp, root, d) = folders(&["card"]);
        let card = &d[0];
        let earlier = v7(T0 - 10 * MIN, 1);
        write(&root, "2026-09-29T15-18-00", &earlier, &meta(&earlier, card, Some("cli")));
        assert_eq!(latest_for_folder(&root, card, Some(T0)), None);
        // Within the tolerance (the Builder's start is written just after
        // its spawn) it counts.
        let builder = v7(T0 - STARTED_TOLERANCE_MS / 2, 2);
        write(&root, "2026-09-29T15-28-17", &builder, &meta(&builder, card, Some("cli")));
        assert_eq!(latest_for_folder(&root, card, Some(T0)), Some(builder));
        // A non-v7 id is judged by its record's timestamp.
        let (_tmp, root, d) = folders(&["card"]);
        let card = &d[0];
        write(&root, "2026-09-29T15-28-50", "plain", &meta_with("plain", card, Some("cli"), "2026-09-29T13:00:00Z"));
        assert_eq!(latest_for_folder(&root, card, Some(T0)), None);
        assert_eq!(latest_for_folder(&root, card, None).as_deref(), Some("plain"));
    }

    /// The cheap pre-filters: a name older than the start is never opened (a
    /// transcript it would have matched is skipped), a day-old date without a
    /// v7 id likewise, and a first line without the folder isn't parsed.
    #[test]
    fn older_names_are_skipped_unread() {
        assert!(started_before(&format!("rollout-2026-09-29T15-00-00-{}.jsonl", v7(T0 - 5 * MIN, 1)), T0 - MIN));
        assert!(!started_before(&format!("rollout-2026-09-29T15-00-00-{}.jsonl", v7(T0, 1)), T0 - MIN));
        // Not v7: by the local date, a day early.
        assert!(started_before("rollout-2026-09-27T23-00-00-plain.jsonl", T0));
        assert!(!started_before("rollout-2026-09-28T23-00-00-plain.jsonl", T0));
        assert!(!started_before("rollout-2026-09-29T01-00-00-plain.jsonl", T0));
        assert!(!started_before("rollout-garbage.jsonl", T0));

        let (tmp, root, d) = folders(&["card"]);
        let card = &d[0];
        let needles = folder_needles(card, &normalized(card));
        let other = tmp.path().join("wt/other");
        std::fs::create_dir_all(&other).unwrap();
        let id = v7(T0, 1);
        write(&root, "2026-09-29T15-28-48", &id, &meta(&id, &other, Some("cli")));
        let file = root.join(format!("2026/09/29/rollout-2026-09-29T15-28-48-{id}.jsonl"));
        assert_eq!(session_in(&file, &normalized(card), &needles), None);
        // A folder JSON would escape gets no raw pre-check (and still works).
        assert!(folder_needles(Path::new("/w/a\"b"), Path::new("/w/a\"b")).is_empty());
    }

    /// A Challenger's headless `exec` in the card's folder, a Codex chat
    /// tile, a sub-agent: none is the Builder's conversation.
    #[test]
    fn only_interactive_sessions_count() {
        let (_tmp, root, d) = folders(&["card"]);
        let card = &d[0];
        let ids: Vec<String> = (0..6).map(|n| v7(T0 + i64::from(n) * MIN, n)).collect();
        write(&root, "2026-09-29T15-28-00", &ids[0], &meta(&ids[0], card, Some("cli")));
        write(&root, "2026-09-29T15-29-00", &ids[1], &meta(&ids[1], card, Some("exec")));
        write(&root, "2026-09-29T15-30-00", &ids[2], &meta(&ids[2], card, Some("vscode")));
        let mut sub: serde_json::Value =
            serde_json::from_str(meta(&ids[3], card, None).lines().next().unwrap()).unwrap();
        sub["payload"]["source"] = serde_json::json!({ "subagent": "review" });
        write(&root, "2026-09-29T15-31-00", &ids[3], &format!("{sub}\n"));
        assert_eq!(latest_for_folder(&root, card, Some(T0)), Some(ids[0].clone()));
        // A transcript from before `source` existed still counts.
        write(&root, "2026-09-29T15-32-00", &ids[4], &meta(&ids[4], card, None));
        assert_eq!(latest_for_folder(&root, card, Some(T0)), Some(ids[4].clone()));
    }

    /// No session in the folder, no sessions directory, junk files: `None`,
    /// never another folder's session.
    #[test]
    fn nothing_found_is_none() {
        let (_tmp, root, d) = folders(&["card", "other"]);
        let (card, other) = (&d[0], &d[1]);
        assert_eq!(latest_for_folder(&root, card, Some(T0)), None);
        let id = v7(T0, 1);
        write(&root, "2026-09-29T15-28-48", &id, &meta(&id, other, Some("cli")));
        write(&root, "2026-09-29T15-29-00", &v7(T0, 2), "not json\n");
        write(&root, "2026-09-29T15-30-00", &v7(T0, 3), "");
        std::fs::write(root.join("2026/09/29/notes.txt"), meta(&v7(T0, 4), card, Some("cli"))).unwrap();
        assert_eq!(latest_for_folder(&root, card, Some(T0)), None);
        assert_eq!(latest_for_folder(&root, card, None), None);
    }

    /// The folder as the card records it and as Codex wrote it may differ by
    /// a trailing slash or a symlinked parent.
    #[cfg(unix)]
    #[test]
    fn the_same_folder_matches_however_it_is_written() {
        let (tmp, root, d) = folders(&["card"]);
        let real = &d[0];
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(tmp.path().join("wt"), &link).unwrap();
        let id = v7(T0, 1);
        write(&root, "2026-09-29T15-28-48", &id, &meta(&id, real, Some("cli")));
        assert_eq!(latest_for_folder(&root, &link.join("card"), Some(T0)), Some(id.clone()));
        let slashed = PathBuf::from(format!("{}/", real.display()));
        assert_eq!(latest_for_folder(&root, &slashed, Some(T0)), Some(id));
    }

    #[test]
    fn a_v7_id_carries_its_start() {
        assert_eq!(uuid_v7_ms("01a0ed5a-8663-78e0-98d7-fc97bde7bc28"), Some(1_790_688_527_971));
        assert_eq!(uuid_v7_ms(&v7(T0, 9)), Some(T0));
        assert_eq!(uuid_v7_ms("0b8f1e2c-4a3d-4f6e-9a1b-2c3d4e5f6a7b"), None);
        assert_eq!(uuid_v7_ms("t3-id"), None);
    }
}
