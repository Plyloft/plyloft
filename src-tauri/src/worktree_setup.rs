//! SL-4 (ship loop): what a new card worktree gets before its Builder starts —
//! git-ignored files copied from the main checkout (`worktreeCopy`, a `.env`
//! the checkout needs to run) and a setup command run in it (`worktreeSetup`,
//! e.g. `npm ci`).
//!
//! **Where the settings live.** They are two more fields of the shared
//! workspace definition (`.atelier/workspace.json`, ADR 0003): everyone who
//! opens the repository gets the same worktrees, and an edit goes through the
//! same pending/publish channel as every other shared field. This Mac keeps
//! the values it runs with in `projects/<workspace_id>/worktree_setup.json`
//! (atomic, Hard Rule #3) — the store a refresh writes the repository's
//! values into, and the only store for a workspace that shares no definition.
//! The same file remembers this Mac's answer to the one-time `.env` question,
//! which is personal and never published: whether *these* files exist is a
//! fact about one checkout, not about the repository.
//!
//! **When it runs.** Right after `worktrees::ensure_for_card` created a
//! worktree (`created: true`) and before any Builder is spawned into it
//! ([`prepare_worktree`], called from `advance_card_to_in_progress`). The copy
//! never overwrites anything in the worktree — a tracked file included — and
//! copies only files git ignores in the main checkout; symbolic links and
//! anything that would land outside the worktree are skipped and reported.
//! The setup command runs like a verify step
//! (`verify::run_bounded_command_in`, in the verify steps' registry): its
//! own process group, killed on app exit (Hard Rule #4), the cached PATH
//! (Hard Rule #2), Git Bash on Windows, stopped after
//! [`SETUP_TIMEOUT_SECS`]. A failure is kept on the card
//! ([`WorktreeSetupRecord`]) and the Builder does not start until the person
//! presses Retry or Start anyway.
//!
//! **Secrets.** Only file *names* are ever reported or logged; the copy reads
//! no contents, and nothing here goes into an agent's prompt.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::project_config::ProjectConfigStore;

/// This Mac's copy, next to the workspace's `config.json`.
pub const SETTINGS_FILENAME: &str = "worktree_setup.json";
/// How long a setup command may run before it is stopped (and the card's
/// setup fails). Generous: a cold `npm ci` or `cargo fetch` can take minutes.
pub const SETUP_TIMEOUT_SECS: u64 = 15 * 60;
/// The end of the setup command's output kept on the card.
pub const LOG_TAIL_BYTES: usize = 16 * 1024;
/// Entries a pattern's search looks at before it gives up (a `**` over a
/// dependency folder would otherwise walk it all).
const WALK_LIMIT: usize = 20_000;
/// Limits on what the settings may hold, so a hand-edited file cannot make a
/// card start do unbounded work.
pub const MAX_COPY_ENTRIES: usize = 50;
pub const MAX_ENTRY_CHARS: usize = 300;
pub const MAX_SETUP_CHARS: usize = 2_000;

/// This Mac's answer to "Copy these files into card worktrees?".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnvProposalAnswer {
    Copy,
    DontCopy,
}

/// `projects/<workspace_id>/worktree_setup.json`. Every field is additive:
/// a missing file, or one without a field, reads as nothing configured and
/// nothing asked yet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSettings {
    /// Paths or globs, relative to the repository root, of git-ignored files
    /// copied from the main checkout into every new card worktree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_copy: Option<Vec<String>>,
    /// A command run in every new card worktree, from its root, before the
    /// Builder starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_setup: Option<String>,
    /// The one-time `.env` question, answered on this Mac. Never published.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_proposal: Option<EnvProposalAnswer>,
    /// The setup command this Mac agreed to run: typed here, or allowed on a
    /// card ("Allow and run"). A shared command that differs — a teammate's
    /// change, or one this Mac never saw — does not run until allowed.
    /// Personal, never published.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_setup: Option<String>,
    /// Try it (TRY_IT_SPEC §5.2): the start command (`ProjectConfig::
    /// try_command`) this Mac agreed to run — typed and saved here, or
    /// allowed when Try it asked. Same exact-match rule as `approved_setup`:
    /// a changed shared command asks again. Personal, never published. A
    /// value of the wrong type reads as unset, so the rest of the file stays.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::project_config::lenient_opt"
    )]
    pub approved_try: Option<String>,
    /// 1.175.0 B2 (SEC-4): the checks ("Checks before shipping") this Mac
    /// agreed to run — a hash of the pipeline and a readable copy. Absent
    /// (every file before 1.175.0): nothing came from the branch since the
    /// record began, so what this Mac runs is allowed (`checks_consent`).
    /// Personal, never published. A value of the wrong type reads as unset.
    /// Round 2 (G5): a record that is there and can't be read is not "no
    /// record": it reads as one that matches nothing, so it asks.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "crate::checks_consent::record_or_asks")]
    pub approved_verify: Option<crate::checks_consent::ApprovedVerify>,
    /// 1.175.0 B2: the install step ("After a release, run") this Mac agreed
    /// to run, by its path. Absent reads as `approved_verify` does.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "crate::checks_consent::record_or_asks")]
    pub approved_install: Option<crate::checks_consent::ApprovedInstall>,
    /// 1.175.0 B2: who changed the checks that now wait for this Mac's OK,
    /// and when this Mac read the change — the card's sentence.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::project_config::lenient_opt"
    )]
    pub verify_changed: Option<crate::checks_consent::ChangeNote>,
    /// 1.175.0 B2: the same for the install step.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::project_config::lenient_opt"
    )]
    pub install_changed: Option<crate::checks_consent::ChangeNote>,
    /// 1.175.0 B2: a release that finished while its install step wasn't
    /// allowed here — the Inbox row and the sheet's "runs it for {v}".
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::project_config::lenient_opt"
    )]
    pub install_waiting: Option<crate::checks_consent::InstallWaiting>,
}

impl WorktreeSettings {
    /// The setup command runs on this Mac without asking.
    pub fn setup_allowed(&self) -> bool {
        match self.setup_command() {
            None => true,
            Some(command) => self.approved_setup.as_deref().map(str::trim) == Some(command),
        }
    }

    /// Try it: the start command runs on this Mac without asking.
    pub fn try_allowed(&self, command: Option<&str>) -> bool {
        try_allowed(command, self.approved_try.as_deref())
    }

    pub fn copy_entries(&self) -> &[String] {
        self.worktree_copy.as_deref().unwrap_or(&[])
    }

    pub fn setup_command(&self) -> Option<&str> {
        self.worktree_setup
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
    }

    /// The one-time `.env` question needs no asking: the repository already
    /// lists what worktrees get copied, or this Mac answered. A setup command
    /// alone settles nothing — it copies no file.
    pub fn env_question_settled(&self) -> bool {
        !self.copy_entries().is_empty() || self.env_proposal.is_some()
    }

    /// Anything to do for a new worktree.
    pub fn configured(&self) -> bool {
        !self.copy_entries().is_empty() || self.setup_command().is_some()
    }
}

/// Try it (TRY_IT_SPEC §5.2): whether `command` may start on this Mac without
/// asking — nothing to run, or exactly the command this Mac approved (both
/// trimmed), as [`WorktreeSettings::setup_allowed`] does for the setup.
pub fn try_allowed(command: Option<&str>, approved: Option<&str>) -> bool {
    match command.map(str::trim).filter(|c| !c.is_empty()) {
        None => true,
        Some(command) => approved.map(str::trim) == Some(command),
    }
}

pub fn settings_path(store: &ProjectConfigStore, workspace_id: &str) -> PathBuf {
    store.workspace_dir(workspace_id).join(SETTINGS_FILENAME)
}

/// A missing or unreadable file reads as nothing configured: the next
/// refresh of a shared definition writes the repository's values back.
pub fn load_settings(store: &ProjectConfigStore, workspace_id: &str) -> WorktreeSettings {
    let Ok(bytes) = std::fs::read(settings_path(store, workspace_id)) else {
        return WorktreeSettings::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        log::warn!("worktree_setup: ignoring unreadable settings for {workspace_id}: {e}");
        WorktreeSettings::default()
    })
}

/// Atomic (Hard Rule #3). Empty values are stored as absent.
pub fn save_settings(
    store: &ProjectConfigStore,
    workspace_id: &str,
    settings: &WorktreeSettings,
) -> Result<(), String> {
    let mut clean = settings.clone();
    clean.worktree_copy = clean.worktree_copy.filter(|l| !l.is_empty());
    clean.worktree_setup = clean
        .worktree_setup
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    clean.approved_setup = clean
        .approved_setup
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    clean.approved_try = clean
        .approved_try
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    crate::atomic::write_atomic_json(&settings_path(store, workspace_id), &clean)
}

/// Why an entry can't be a `worktreeCopy` entry, in words; `None` when it can.
/// Entries are shared with every platform: relative to the repository root,
/// `/` between folders, no `.` or `..`.
pub fn copy_entry_problem(entry: &str) -> Option<String> {
    let e = entry.trim();
    if e.is_empty() {
        return Some("A path is needed.".into());
    }
    if e.chars().count() > MAX_ENTRY_CHARS {
        return Some(format!("A path is at most {MAX_ENTRY_CHARS} characters."));
    }
    if e.starts_with('/') || e.starts_with('\\') || e.as_bytes().get(1) == Some(&b':') {
        return Some("A path is relative to the repository, so it can't start with /, \\ or a drive.".into());
    }
    if e.contains('\\') {
        return Some("A path is shared with every platform, so its folders are separated by /, not \\.".into());
    }
    let body = e.trim_end_matches('/');
    if body.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Some("A path names something inside the repository: no . or .. in it.".into());
    }
    if body == ".git" || body.starts_with(".git/") {
        return Some("Git's own folder is never copied.".into());
    }
    None
}

/// The list as it is stored: trimmed, trailing `/` dropped, duplicates
/// collapsed in order; `None` for an empty list. Refused when an entry is
/// not a usable path or the list is over its limit.
pub fn normalize_copy(entries: Vec<String>) -> Result<Option<Vec<String>>, String> {
    let mut out: Vec<String> = Vec::new();
    for entry in entries {
        if let Some(problem) = copy_entry_problem(&entry) {
            return Err(format!("{}: {problem}", entry.trim()));
        }
        let clean = entry.trim().trim_end_matches('/').to_string();
        if !out.contains(&clean) {
            out.push(clean);
        }
    }
    if out.len() > MAX_COPY_ENTRIES {
        return Err(format!("At most {MAX_COPY_ENTRIES} paths are copied into card worktrees."));
    }
    Ok((!out.is_empty()).then_some(out))
}

/// The command as it is stored: trimmed, `None` when empty.
pub fn normalize_setup(command: Option<String>) -> Result<Option<String>, String> {
    let Some(command) = command.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) else {
        return Ok(None);
    };
    if command.chars().count() > MAX_SETUP_CHARS {
        return Err(format!("A setup command is at most {MAX_SETUP_CHARS} characters."));
    }
    Ok(Some(command))
}

// ── The one-time question ─────────────────────────────────────────────

/// What to propose on the first card that creates a worktree: the
/// git-ignored `.env*` files of the main checkout (`candidates`), unless the
/// question is settled ([`WorktreeSettings::env_question_settled`]).
pub fn env_proposal(settings: &WorktreeSettings, candidates: Vec<String>) -> Vec<String> {
    if settings.env_question_settled() {
        return Vec::new();
    }
    candidates
}

/// Record the answer. `Copy` adds `files` to `worktreeCopy` (keeping what is
/// there); `DontCopy` only remembers that the question was answered.
pub fn answer_env_proposal(
    settings: &mut WorktreeSettings,
    answer: EnvProposalAnswer,
    files: &[String],
) -> Result<(), String> {
    if answer == EnvProposalAnswer::Copy {
        let mut list = settings.copy_entries().to_vec();
        list.extend(files.iter().cloned());
        settings.worktree_copy = normalize_copy(list)?;
    }
    settings.env_proposal = Some(answer);
    Ok(())
}

/// A file name the question is about: `.env` or `.env.<something>`, not a
/// template (`project_setup::is_likely_secret`'s rule).
pub fn is_env_file(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    (name == ".env" || name.starts_with(".env.")) && crate::project_setup::is_likely_secret(rel)
}

/// The main checkout's git-ignored `.env*` files, relative to its root and
/// sorted. Ignored folders are not looked into (`--directory`), so a
/// dependency folder costs one line.
pub fn env_candidates(main_root: &Path) -> Vec<String> {
    let Some(out) = git_bytes(
        main_root,
        &["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
        None,
    ) else {
        return Vec::new();
    };
    let mut found: Vec<String> = out
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .filter(|p| !p.ends_with('/') && is_env_file(p))
        .collect();
    found.sort();
    found
}

/// The repository root of a workspace's checkout: `worktreeCopy` is relative
/// to it, as a card worktree's root is. The checkout itself when git can't say.
pub fn repo_root(cwd: &Path) -> PathBuf {
    git_bytes(cwd, &["rev-parse", "--show-toplevel"], None)
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn git_bytes(cwd: &Path, args: &[&str], input: Option<&[u8]>) -> Option<Vec<u8>> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = crate::platform::git_command()
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let writer = match (input, child.stdin.take()) {
        (Some(bytes), Some(mut stdin)) => {
            let bytes = bytes.to_vec();
            // Its own thread: a long answer can fill stdout while the
            // question is still going in.
            Some(std::thread::spawn(move || stdin.write_all(&bytes)))
        }
        _ => None,
    };
    let out = child.wait_with_output().ok()?;
    if let Some(w) = writer {
        let _ = w.join();
    }
    // `check-ignore` exits 1 when nothing is ignored: still an answer.
    match out.status.code() {
        Some(0) => Some(out.stdout),
        Some(1) if args.first() == Some(&"check-ignore") => Some(out.stdout),
        _ => None,
    }
}

// ── The copy ──────────────────────────────────────────────────────────

/// A path the copy left alone, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopySkip {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyReport {
    pub copied: Vec<String>,
    pub skipped: Vec<CopySkip>,
    /// Entries that matched nothing in the main checkout.
    pub unmatched: Vec<String>,
}

const SKIP_SYMLINK: &str = "a symbolic link — only files are copied";
const SKIP_NOT_IGNORED: &str = "not git-ignored in the main checkout — tracked and untracked files come with the branch or stay out";
const SKIP_NOT_IGNORED_HERE: &str = "not git-ignored in the card's branch — copied in, it could be committed";
const SKIP_EXISTS: &str = "already in the worktree — never overwritten";
const SKIP_OUTSIDE: &str = "would land outside the worktree";

fn has_glob(entry: &str) -> bool {
    entry.contains(['*', '?', '[', '{'])
}

fn join_rel(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, part| p.join(part))
}

/// Walk `dir` (relative `rel`), depth-first, collecting file paths relative
/// to the root with `/`. Git's folder and the card worktrees are never
/// entered, nor a linked folder. Returns false when [`WALK_LIMIT`] ran out.
fn walk(
    root: &Path,
    rel: &str,
    depth_left: Option<usize>,
    seen: &mut usize,
    visit: &mut dyn FnMut(&str, &std::fs::Metadata),
) -> bool {
    let Ok(read) = std::fs::read_dir(join_rel(root, rel)) else {
        return true;
    };
    let mut entries: Vec<_> = read.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        *seen += 1;
        if *seen > WALK_LIMIT {
            return false;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" || crate::worktrees::is_worktrees_dir_name(&name) {
            continue;
        }
        let child = if rel.is_empty() { name } else { format!("{rel}/{name}") };
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if meta.is_dir() {
            if depth_left != Some(1) && !walk(root, &child, depth_left.map(|d| d - 1), seen, visit) {
                return false;
            }
        } else {
            visit(&child, &meta);
        }
    }
    true
}

/// The files one entry names in the main checkout. Symbolic links it names
/// are reported rather than returned.
fn expand_entry(main_root: &Path, entry: &str, report: &mut CopyReport) -> Vec<String> {
    let mut found = Vec::new();
    let mut seen = 0usize;
    if !has_glob(entry) {
        let Ok(meta) = std::fs::symlink_metadata(join_rel(main_root, entry)) else {
            return found;
        };
        if meta.file_type().is_symlink() {
            report.skipped.push(CopySkip { path: entry.to_string(), reason: SKIP_SYMLINK.into() });
        } else if meta.is_dir() {
            let complete = walk(main_root, entry, None, &mut seen, &mut |rel, meta| {
                if meta.file_type().is_symlink() {
                    report.skipped.push(CopySkip { path: rel.to_string(), reason: SKIP_SYMLINK.into() });
                } else {
                    found.push(rel.to_string());
                }
            });
            if !complete {
                // Half a folder is worse than none: nothing of it is copied.
                found.clear();
                report.skipped.push(CopySkip {
                    path: entry.to_string(),
                    reason: format!("more than {WALK_LIMIT} entries under it, so nothing of it was copied — name the files instead"),
                });
            }
        } else {
            found.push(entry.to_string());
        }
        return found;
    }
    let matcher = match globset::GlobBuilder::new(entry).literal_separator(true).build() {
        Ok(glob) => glob.compile_matcher(),
        Err(e) => {
            report.skipped.push(CopySkip { path: entry.to_string(), reason: format!("not a pattern Plyloft can read: {e}") });
            return found;
        }
    };
    // Start below the part of the pattern with no wildcard in it, and go no
    // deeper than the pattern can reach unless it has `**`.
    let parts: Vec<&str> = entry.split('/').collect();
    let fixed = parts.iter().take_while(|p| !has_glob(p)).count().min(parts.len() - 1);
    let start = parts[..fixed].join("/");
    let depth = (!entry.contains("**")).then_some(parts.len() - fixed);
    let complete = walk(main_root, &start, depth, &mut seen, &mut |rel, meta| {
        if matcher.is_match(rel) {
            if meta.file_type().is_symlink() {
                report.skipped.push(CopySkip { path: rel.to_string(), reason: SKIP_SYMLINK.into() });
            } else {
                found.push(rel.to_string());
            }
        }
    });
    if !complete {
        // A partial match set would copy an arbitrary part: nothing is.
        found.clear();
        report.skipped.push(CopySkip {
            path: entry.to_string(),
            reason: format!("stopped looking after {WALK_LIMIT} entries, so nothing was copied for it — name the files more precisely"),
        });
    }
    found
}

/// Of `paths` (relative to `main_root`), the ones git ignores there. A tracked
/// file is never reported ignored (`check-ignore` without `--no-index`).
fn ignored_paths(main_root: &Path, paths: &[String]) -> Option<HashSet<String>> {
    if paths.is_empty() {
        return Some(HashSet::new());
    }
    let mut input = Vec::new();
    for p in paths {
        input.extend_from_slice(p.as_bytes());
        input.push(0);
    }
    let out = git_bytes(main_root, &["check-ignore", "-z", "--stdin"], Some(&input))?;
    Some(
        out.split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect(),
    )
}

/// Copy the files `entries` name from the main checkout into a new card
/// worktree. Only git-ignored files; never over anything already there;
/// never a symbolic link, nor anything that would land outside the worktree.
pub fn copy_into_worktree(main_root: &Path, worktree_root: &Path, entries: &[String]) -> CopyReport {
    let mut report = CopyReport::default();
    let mut candidates: Vec<String> = Vec::new();
    for entry in entries {
        if let Some(problem) = copy_entry_problem(entry) {
            report.skipped.push(CopySkip { path: entry.clone(), reason: problem });
            continue;
        }
        let entry = entry.trim().trim_end_matches('/');
        let reported = report.skipped.len();
        let found = expand_entry(main_root, entry, &mut report);
        if found.is_empty() && report.skipped.len() == reported {
            report.unmatched.push(entry.to_string());
        }
        for f in found {
            if !candidates.contains(&f) {
                candidates.push(f);
            }
        }
    }
    // Ignored in the main checkout, and in the card's branch too: a file the
    // branch doesn't ignore would show as new, and the Builder could commit it.
    let (Some(ignored), Some(ignored_here)) = (
        ignored_paths(main_root, &candidates),
        ignored_paths(worktree_root, &candidates),
    ) else {
        for path in candidates {
            report.skipped.push(CopySkip { path, reason: "git couldn't say whether it is ignored".into() });
        }
        return report;
    };
    let (Ok(main_real), Ok(worktree_real)) = (
        crate::platform::canonicalize(main_root),
        crate::platform::canonicalize(worktree_root),
    ) else {
        for path in candidates {
            report.skipped.push(CopySkip { path, reason: "the checkout or the worktree can't be read".into() });
        }
        return report;
    };
    for rel in candidates {
        if !ignored.contains(&rel) {
            report.skipped.push(CopySkip { path: rel, reason: SKIP_NOT_IGNORED.into() });
            continue;
        }
        if !ignored_here.contains(&rel) {
            report.skipped.push(CopySkip { path: rel, reason: SKIP_NOT_IGNORED_HERE.into() });
            continue;
        }
        match copy_one(&main_real, &worktree_real, &rel) {
            Ok(()) => report.copied.push(rel),
            Err(reason) => report.skipped.push(CopySkip { path: rel, reason }),
        }
    }
    report
}

/// Two files hold the same bytes. Read only to compare, never kept.
fn same_contents(a: &Path, b: &Path) -> bool {
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(ma), Ok(mb)) if ma.len() == mb.len() => {}
        _ => return false,
    }
    matches!((std::fs::read(a), std::fs::read(b)), (Ok(x), Ok(y)) if x == y)
}

fn copy_one(main_real: &Path, worktree_real: &Path, rel: &str) -> Result<(), String> {
    let src = join_rel(main_real, rel);
    let meta = std::fs::symlink_metadata(&src).map_err(|_| "gone from the main checkout".to_string())?;
    if meta.file_type().is_symlink() {
        return Err(SKIP_SYMLINK.into());
    }
    if !meta.is_file() {
        return Err("not a file".into());
    }
    // A linked folder on the way could take the source from elsewhere.
    let src_real = crate::platform::canonicalize(&src).map_err(|_| "can't be read".to_string())?;
    if !src_real.starts_with(main_real) {
        return Err("outside the main checkout".into());
    }
    let dst = join_rel(worktree_real, rel);
    if let Ok(existing) = std::fs::symlink_metadata(&dst) {
        // A Retry finds what the first copy put there: the same bytes are
        // already copied, not a problem. Anything else is never overwritten.
        if existing.is_file() && same_contents(&src_real, &dst) {
            return Ok(());
        }
        return Err(SKIP_EXISTS.into());
    }
    let parent = dst.parent().ok_or_else(|| SKIP_OUTSIDE.to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("its folder couldn't be made: {e}"))?;
    // A tracked link to a folder elsewhere would carry the file out.
    let parent_real = crate::platform::canonicalize(parent).map_err(|_| SKIP_OUTSIDE.to_string())?;
    if !parent_real.starts_with(worktree_real) {
        return Err(SKIP_OUTSIDE.into());
    }
    // `create_new`: nothing that appeared since the check is overwritten.
    let mut from = std::fs::File::open(&src_real).map_err(|e| format!("couldn't be read: {e}"))?;
    let mut to = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&dst)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                SKIP_EXISTS.to_string()
            } else {
                format!("couldn't be written: {e}")
            }
        })?;
    std::io::copy(&mut from, &mut to).map_err(|e| format!("couldn't be copied: {e}"))?;
    let _ = to.set_permissions(meta.permissions());
    Ok(())
}

// ── The record on the card ────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeSetupState {
    /// The worktree exists and its setup is under way, outside the card-start
    /// lock. Holds the Builder back like `Failed`; one left by a Plyloft that
    /// quit is settled to `Failed` ([`settle_interrupted`]).
    Running,
    /// Copied and (when there is one) the command passed.
    Done,
    /// The command failed or was stopped: the Builder waits for Retry or
    /// Start anyway.
    Failed,
    /// Failed, and the person pressed Start anyway.
    Skipped,
}

/// `KanbanCard::worktree_setup`: what the last setup of the card's worktree
/// did. File names only — never contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetupRecord {
    pub state: WorktreeSetupState,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub copied: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped: Vec<CopySkip>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unmatched: Vec<String>,
    /// The setup command that ran, when there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub timed_out: bool,
    /// Why it failed, in words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The command was not run: this Mac has not allowed it
    /// ([`WorktreeSettings::approved_setup`]). The card offers "Allow and run".
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub approval_needed: bool,
    /// The end of the command's output (ANSI stripped, at most
    /// [`LOG_TAIL_BYTES`]).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub log: String,
    #[serde(default)]
    pub elapsed_ms: u64,
    /// Unix ms.
    pub at: i64,
}

impl WorktreeSetupRecord {
    /// The Builder may not start into this worktree yet.
    pub fn blocks_start(&self) -> bool {
        matches!(self.state, WorktreeSetupState::Failed | WorktreeSetupState::Running)
    }

    /// A record that says the setup is under way, from `at` on.
    pub fn running(command: Option<&str>, at: i64) -> Self {
        Self {
            state: WorktreeSetupState::Running,
            copied: Vec::new(),
            skipped: Vec::new(),
            unmatched: Vec::new(),
            command: command.map(str::to_string),
            exit_code: None,
            timed_out: false,
            reason: None,
            approval_needed: false,
            log: String::new(),
            elapsed_ms: 0,
            at,
        }
    }
}

/// The words a refused start says (item 10 of the SL-4 review: no
/// "worktree" on the card's surface).
pub const SETUP_FAILED_REFUSAL: &str =
    "The card's setup failed, so the Builder was not started. Retry the setup, or start anyway, from the card.";
/// A start held by a setup command this Mac hasn't allowed (`approval_needed`).
/// Its own lead, so the card's words don't depend on reading the reason
/// (which holds the command's text).
pub const SETUP_APPROVAL_REFUSAL: &str =
    "The card's setup command needs your OK, so the Builder was not started. Allow and run it, or start anyway, from the card.";
/// A start while the card's setup is still under way.
pub const SETUP_RUNNING_REFUSAL: &str =
    "The card is still being set up; the Builder starts when the setup is done.";
/// Why a setup a start staged but could not run is `Failed`.
pub const SETUP_NOT_RUN_REASON: &str = "The setup hasn't run yet. Retry runs it.";
/// Why a `Running` record left by a Plyloft that quit is now `Failed`.
pub const INTERRUPTED_REASON: &str = "Plyloft quit during the setup, so it didn't finish.";

// ── Setups under way in this process ──────────────────────────────────

static IN_FLIGHT: std::sync::LazyLock<std::sync::Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(Default::default);

fn in_flight_key(workspace_id: &str, card_id: &str) -> String {
    format!("{workspace_id}::{card_id}")
}

/// Held while a card's setup runs in this process; dropping it ends it.
#[derive(Debug)]
pub struct InFlight(String);

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.0);
    }
}

/// Claim the card's setup for this process; `None` while one runs already.
pub fn begin(workspace_id: &str, card_id: &str) -> Option<InFlight> {
    let key = in_flight_key(workspace_id, card_id);
    // The lock is released before an `InFlight` exists: its drop takes it.
    let claimed = IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner()).insert(key.clone());
    claimed.then(|| InFlight(key))
}

/// A setup of this card is running in this process now.
pub fn is_in_flight(workspace_id: &str, card_id: &str) -> bool {
    IN_FLIGHT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(&in_flight_key(workspace_id, card_id))
}

/// A `Running` record with no setup running in this process (Plyloft quit,
/// or crashed, during it) becomes `Failed`, so Retry and Start anyway show.
/// Returns whether it changed.
pub fn settle_interrupted(
    record: &mut Option<WorktreeSetupRecord>,
    workspace_id: &str,
    card_id: &str,
) -> bool {
    match record {
        Some(r) if r.state == WorktreeSetupState::Running && !is_in_flight(workspace_id, card_id) => {
            r.state = WorktreeSetupState::Failed;
            r.reason = Some(INTERRUPTED_REASON.to_string());
            true
        }
        _ => false,
    }
}

pub(crate) fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// "1 second", "40 seconds", "15 minutes".
fn duration_words(secs: u64) -> String {
    let (n, unit) = if secs < 60 { (secs, "second") } else { (secs.div_ceil(60), "minute") };
    format!("{n} {unit}{}", if n == 1 { "" } else { "s" })
}

/// The end of `s`, at most `max` bytes, cut on a character boundary.
fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut from = s.len() - max;
    while !s.is_char_boundary(from) {
        from += 1;
    }
    s[from..].to_string()
}

/// Copy, then run the setup command, in a worktree `ensure_for_card` just
/// created. `None` when the workspace configures neither. `path` is the
/// cached PATH (Hard Rule #2); `extra_env` is added to the command's
/// environment (the worktree's `PLYLOFT_PORT_BASE` / `PLYLOFT_PORT_COUNT`,
/// `worktree_ports`).
pub fn prepare_worktree(
    main_root: &Path,
    worktree: &Path,
    settings: &WorktreeSettings,
    path: &str,
    extra_env: &[(String, String)],
    timeout: Duration,
) -> Option<WorktreeSetupRecord> {
    prepare_worktree_in(crate::verify::step_groups(), main_root, worktree, settings, path, extra_env, timeout, None)
}

/// 1.174.0 (DR2 round 1): [`prepare_worktree`] that *Stop the release*
/// reaches: `stop` set kills the setup command's process group at once.
#[allow(clippy::too_many_arguments)]
pub fn prepare_worktree_until(
    main_root: &Path,
    worktree: &Path,
    settings: &WorktreeSettings,
    path: &str,
    extra_env: &[(String, String)],
    timeout: Duration,
    stop: Option<&std::sync::atomic::AtomicBool>,
) -> Option<WorktreeSetupRecord> {
    prepare_worktree_in(crate::verify::step_groups(), main_root, worktree, settings, path, extra_env, timeout, stop)
}

/// [`prepare_worktree`] with the command's process group registered in
/// `groups` (the app's is the verify steps' one, killed on quit).
#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_worktree_in(
    groups: &crate::worktrees::FetchRegistry,
    main_root: &Path,
    worktree: &Path,
    settings: &WorktreeSettings,
    path: &str,
    extra_env: &[(String, String)],
    timeout: Duration,
    stop: Option<&std::sync::atomic::AtomicBool>,
) -> Option<WorktreeSetupRecord> {
    if !settings.configured() {
        return None;
    }
    let copy = copy_into_worktree(main_root, worktree, settings.copy_entries());
    let mut record = WorktreeSetupRecord {
        state: WorktreeSetupState::Done,
        copied: copy.copied,
        skipped: copy.skipped,
        unmatched: copy.unmatched,
        command: None,
        exit_code: None,
        timed_out: false,
        reason: None,
        approval_needed: false,
        log: String::new(),
        elapsed_ms: 0,
        at: now_millis(),
    };
    if let Some(command) = settings.setup_command().filter(|_| !settings.setup_allowed()) {
        // Consent per Mac: a command this Mac never agreed to is not run.
        record.command = Some(command.to_string());
        record.state = WorktreeSetupState::Failed;
        record.approval_needed = true;
        record.reason = Some(match settings.approved_setup.as_deref() {
            Some(_) => format!(
                "The repository's setup command changed: {command}. Allow it on {}?",
                crate::platform::THIS_MACHINE
            ),
            None => format!(
                "The repository's setup command hasn't run on {} before: {command}. Allow it here?",
                crate::platform::THIS_MACHINE
            ),
        });
        record.at = now_millis();
        return Some(record);
    }
    if let Some(command) = settings.setup_command() {
        let run = crate::verify::run_bounded_command_in(groups, worktree, command, timeout, path, extra_env, stop);
        record.command = Some(command.to_string());
        record.exit_code = run.code;
        record.timed_out = run.timed_out;
        record.elapsed_ms = run.elapsed_ms;
        record.log = tail(&run.output, LOG_TAIL_BYTES);
        // v1.154.1 (K2): Plyloft is quitting and the setup didn't finish —
        // killed by the exit cleanup (no code, or a negative one: "exit code
        // -1"), or refused because the cleanup had begun. A command that
        // exited non-zero on its own still says so.
        let quit = ended_by_quit(groups.is_shutting_down(), run.timed_out, run.error.is_some(), run.code);
        record.reason = if quit {
            record.exit_code = None;
            Some(INTERRUPTED_REASON.to_string())
        } else if run.timed_out {
            Some(format!("The setup command was stopped after {}.", duration_words(timeout.as_secs())))
        } else if let Some(e) = run.error {
            Some(format!("The setup command couldn't run: {e}"))
        } else if run.code != Some(0) {
            Some(match run.code {
                Some(code) => format!("The setup command failed (exit code {code})."),
                None => "The setup command was stopped by a signal.".to_string(),
            })
        } else {
            None
        };
        if record.reason.is_some() {
            record.state = WorktreeSetupState::Failed;
        }
    }
    record.at = now_millis();
    Some(record)
}

/// v1.154.1 (K2): a setup that ended because Plyloft is quitting — killed
/// by the exit cleanup (no exit code, or a negative one) or refused because
/// the cleanup had begun — not one that timed out or exited non-zero itself.
pub(crate) fn ended_by_quit(shutting_down: bool, timed_out: bool, refused: bool, code: Option<i32>) -> bool {
    shutting_down && !timed_out && (refused || code.is_none_or(|code| code < 0))
}

#[cfg(test)]
#[path = "worktree_setup_tests.rs"]
mod tests;

/// U32: the refusal when a project's folder can't hold a build, said before a
/// start claims the issue: a claim would stand for a build that can't run.
/// `lib/projectSetup.ts` reads it by its start. What's known is said: a folder
/// that isn't there may have been moved or deleted. Only a GitHub Issues board
/// has a claim to avoid, so only there does it say none was made.
pub fn project_folder_refusal(
    workspaces: &crate::workspace::WorkspaceStore,
    workspace_id: &str,
) -> Option<String> {
    let snapshot = workspaces.snapshot();
    let workspace = snapshot.workspaces.iter().find(|w| w.id == workspace_id)?;
    let has_claims = workspace.kanban_sync_mode == crate::workspace::KanbanSyncMode::GitHubIssues;
    project_folder_problem(Path::new(&workspace.cwd), has_claims)
}

/// The same, asked by a move on a GitHub Issues board before its claim, and by
/// a refused move of a card not started on any board (U32). Off the main
/// thread: the check can run git.
#[tauri::command]
pub async fn project_folder_check(app: tauri::AppHandle, workspace_id: String) -> Result<Option<String>, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        project_folder_refusal(&app.state::<crate::workspace::WorkspaceStore>(), &workspace_id)
    })
    .await
    .map_err(|e| format!("project folder check failed: {e}"))
}

fn project_folder_problem(cwd: &Path, has_claims: bool) -> Option<String> {
    let claim = if has_claims { ", so nothing was claimed" } else { "" };
    if !cwd.is_dir() {
        return Some(format!(
            "This project's folder isn't where Plyloft left it{claim}. Put the folder back; a team's project can be cloned again from Settings › Team › Members and library."
        ));
    }
    let repository = cwd.join(".git").exists()
        || crate::git::capture(cwd, &["rev-parse", "--is-inside-work-tree"]).is_ok_and(|out| out.trim() == "true");
    (!repository).then(|| {
        format!("This project's folder isn't a git repository{claim}. Put its repository back, or move the folder aside.")
    })
}

#[cfg(test)]
mod project_folder_gone_tests {
    use crate::workspace::{KanbanSyncMode, WorkspaceStore};

    #[test]
    fn a_missing_folder_is_refused_and_a_folder_there_is_not() {
        let dir = tempfile::tempdir().unwrap();
        // There, and not a repository.
        assert!(super::project_folder_problem(dir.path(), false).unwrap().contains("isn't a git repository"));
        // A repository.
        crate::git::run(dir.path(), &["init", "-q"]).unwrap();
        assert_eq!(super::project_folder_problem(dir.path(), false), None);
        // Inside one.
        let inner = dir.path().join("sub");
        std::fs::create_dir_all(&inner).unwrap();
        assert_eq!(super::project_folder_problem(&inner, false), None);
        // Not there.
        let gone = dir.path().join("gone");
        assert!(super::project_folder_problem(&gone, false).unwrap().contains("isn't where Plyloft left it"));
    }

    /// Only a GitHub Issues board has a claim to avoid, so only it says so.
    #[test]
    fn the_refusal_names_a_claim_only_on_a_github_issues_board() {
        let config = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(config.path().to_path_buf()).unwrap();
        let folders = tempfile::tempdir().unwrap();
        let plain = folders.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let gone = folders.path().join("gone");
        std::fs::create_dir_all(&gone).unwrap();
        let plain_ws = store.create("plain".into(), plain.display().to_string()).unwrap();
        let gone_ws = store.create("gone".into(), gone.display().to_string()).unwrap();
        std::fs::remove_dir_all(&gone).unwrap();

        const MOVED_LOCAL: &str = "This project's folder isn't where Plyloft left it. Put the folder back; a team's project can be cloned again from Settings › Team › Members and library.";
        const MOVED_GITHUB: &str = "This project's folder isn't where Plyloft left it, so nothing was claimed. Put the folder back; a team's project can be cloned again from Settings › Team › Members and library.";
        const PLAIN_LOCAL: &str = "This project's folder isn't a git repository. Put its repository back, or move the folder aside.";
        const PLAIN_GITHUB: &str = "This project's folder isn't a git repository, so nothing was claimed. Put its repository back, or move the folder aside.";

        assert_eq!(super::project_folder_refusal(&store, &gone_ws.id).as_deref(), Some(MOVED_LOCAL));
        assert_eq!(super::project_folder_refusal(&store, &plain_ws.id).as_deref(), Some(PLAIN_LOCAL));

        for ws in [&gone_ws, &plain_ws] {
            store.set_kanban_sync(&ws.id, KanbanSyncMode::GitHubIssues, Some("o/lyra".into())).unwrap();
        }
        assert_eq!(super::project_folder_refusal(&store, &gone_ws.id).as_deref(), Some(MOVED_GITHUB));
        assert_eq!(super::project_folder_refusal(&store, &plain_ws.id).as_deref(), Some(PLAIN_GITHUB));
    }
}
