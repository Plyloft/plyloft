//! Shared git shell-out helpers + unified-diff parsing.
//!
//! Consolidates three pre-existing private helpers — `ship.rs::git_run`,
//! `ship.rs::git_capture`, and `worktrees.rs::run_git` — into one place so the
//! review surface (v1.31.0) and the ship pipeline share a single git
//! implementation. Those modules now `use crate::git::{run, capture}` under
//! their old local names, so the extraction is call-site-transparent.
//!
//! `diff_hunks` / `parse_unified_diff` are new — they back the Cycle 1
//! `card_review_diff` IPC. v1.31.0 (Cycle 1).

use serde::Serialize;
use std::path::Path;

/// Run a git command, discarding stdout. Errors on non-zero exit.
pub fn run(repo: &Path, args: &[&str]) -> Result<(), String> {
    capture(repo, args).map(|_| ())
}

/// Run a git command and return its stdout. Errors on non-zero exit.
pub fn capture(repo: &Path, args: &[&str]) -> Result<String, String> {
    capture_configured(repo, &[], args)
}

/// [`capture`] with `config` (`-c key=value` pairs) before the subcommand.
/// An error names `args` only, exactly as [`capture`] would.
pub fn capture_configured(repo: &Path, config: &[&str], args: &[&str]) -> Result<String, String> {
    let output = crate::platform::git_command()
        .args(config)
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("spawn git {}: {e}", args.join(" ")))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// F2 (Challenger 1): [`capture_configured`] bounded by `timeout`, with no
/// stdin, in its own process group, killed on app exit — for local git that
/// re-creates commits (a library clone's rebase).
pub fn capture_configured_bounded(
    repo: &Path,
    config: &[&str],
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<String, String> {
    use crate::worktrees::BoundedFailure;
    let mut cmd = crate::platform::git_command();
    cmd.args(config).args(args).current_dir(repo);
    let output = crate::worktrees::run_bounded_output_unparsed(&mut cmd, timeout).map_err(|failure| {
        let why = match failure {
            BoundedFailure::TimedOut => format!("stopped after {}s", timeout.as_secs()),
            BoundedFailure::Spawn(e) => format!("couldn't start: {e}"),
            BoundedFailure::Quitting => "Plyloft is quitting".to_string(),
            BoundedFailure::Truncated => "its output was cut short".to_string(),
        };
        format!("git {} failed: {why}", args.join(" "))
    })?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Which of `paths` (relative to `repo`) git would refuse to add, in the
/// order they were given.
///
/// Probe with a **file** path, not a bare directory: git only applies a
/// directory-only pattern such as `!.claude/skills/` to a path it knows is a
/// directory, so asking about `.claude/skills` itself under `.claude/*` +
/// `!.claude/skills/` wrongly answers "ignored", while asking about
/// `.claude/skills/x/SKILL.md` answers correctly — the leading components are
/// judged as the directories they are. A tracked path is never reported:
/// git carries what it already tracks.
///
/// `Err` when git could not answer — most often because `repo` is not a
/// repository at all.
pub fn check_ignored(repo: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    check_ignored_bounded(repo, paths).map_err(|failure| failure.text())
}

/// How long one `git check-ignore` may take. It reads the index and the
/// ignore files, nothing more; one that runs this long is stuck (a hung
/// filesystem), and every caller has a sensible answer without it.
const CHECK_IGNORE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Why one `git check-ignore` gave no answer.
#[derive(Debug, Clone)]
enum CheckFailure {
    /// Git refused the question — most often one path it will not judge.
    Refused(String),
    /// It ran past [`CHECK_IGNORE_TIMEOUT`] and was killed. Asking again in
    /// smaller pieces would only wait longer.
    TimedOut,
}

impl CheckFailure {
    fn text(&self) -> String {
        match self {
            CheckFailure::Refused(error) => error.clone(),
            CheckFailure::TimedOut => format!(
                "git check-ignore did not answer within {}s",
                CHECK_IGNORE_TIMEOUT.as_secs()
            ),
        }
    }
}

fn check_ignored_bounded(repo: &Path, paths: &[String]) -> Result<Vec<String>, CheckFailure> {
    use std::io::{Read, Write};
    use std::process::Stdio;
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    #[cfg(test)]
    CHECK_IGNORE_RUNS.with(|runs| runs.set(runs.get() + 1));
    let mut child = crate::platform::git_command()
        .args(["check-ignore", "--stdin", "-z"])
        .current_dir(repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CheckFailure::Refused(format!("spawn git check-ignore: {e}")))?;
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    // Written from a thread so a large answer cannot fill stdout while the
    // question is still being written; both pipes drained the same way.
    let mut stdin = child.stdin.take().expect("piped stdin");
    std::thread::spawn(move || stdin.write_all(&input));
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        if let Some(mut pipe) = pipe {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = pipe.read_to_end(&mut buf);
                let _ = tx.send(buf);
            });
        }
        rx
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => return Err(CheckFailure::Refused(format!("git check-ignore: {e}"))),
        }
        if started.elapsed() >= CHECK_IGNORE_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CheckFailure::TimedOut);
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    let wait = std::time::Duration::from_secs(2);
    let stdout = stdout.recv_timeout(wait).map_err(|_| CheckFailure::TimedOut)?;
    let stderr = stderr.recv_timeout(wait).unwrap_or_default();
    // Exit 1 is "none of them is ignored", not a failure.
    match status.code() {
        Some(0) => {}
        Some(1) => return Ok(Vec::new()),
        _ => {
            return Err(CheckFailure::Refused(format!(
                "git check-ignore failed: {}",
                String::from_utf8_lossy(&stderr).trim()
            )))
        }
    }
    let ignored: std::collections::HashSet<&[u8]> = stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .collect();
    Ok(paths
        .iter()
        .filter(|path| ignored.contains(path.as_bytes()))
        .cloned()
        .collect())
}

#[cfg(test)]
thread_local! {
    /// How many `git check-ignore` runs this thread made: the bound the
    /// bisecting fallback is tested against.
    static CHECK_IGNORE_RUNS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// This thread's `git check-ignore` runs since the last call, then zero.
#[cfg(test)]
pub(crate) fn take_check_ignore_runs() -> usize {
    CHECK_IGNORE_RUNS.with(|runs| runs.replace(0))
}

/// Git's answer about one path, from [`check_ignored_each`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IgnoreAnswer {
    Ignored,
    NotIgnored,
    /// Git gave no answer for this path — it refused it ("beyond a symbolic
    /// link", "is in submodule"), timed out, or Ply stopped asking. Git's
    /// words, for Details; never read as either answer.
    Unknown(String),
}

/// The most `git check-ignore` runs [`check_ignored_each`] makes after the
/// first one fails. Bisecting finds each refused path in about
/// `2·log2(n)` runs, so this covers several refused paths among hundreds;
/// past it the rest are `Unknown` rather than one process per path.
const CHECK_IGNORE_BUDGET: usize = 32;

/// [`check_ignored`], answered path by path: one path git refuses does not
/// take the answer for the others with it.
///
/// GH #227: `git check-ignore` fails the **whole** batch (exit 128) when any
/// one path lies beyond a symbolic link or inside a submodule, so a single
/// such skill used to read as "nothing here is ignored". Callers route those
/// paths around first ([`crate::project_skills`]); this is the safety net.
/// One process while every path is answerable; after a refusal the batch is
/// **bisected** — halves asked again, down to the path git refuses — within
/// [`CHECK_IGNORE_BUDGET`] runs, each bounded by [`CHECK_IGNORE_TIMEOUT`]. A
/// timeout is not bisected: smaller questions would only wait longer.
///
/// `Err` only when `repo` is not a work tree at all — there is nothing for a
/// commit to carry, so callers treat it as before. A repository git cannot
/// answer for at all (a config it can't parse, a checkout it won't trust) is
/// not that: every path is [`IgnoreAnswer::Unknown`] with git's words, so a
/// caller says "couldn't check" instead of "nothing here is ignored".
pub fn check_ignored_each(repo: &Path, paths: &[String]) -> Result<Vec<IgnoreAnswer>, String> {
    let failure = match check_ignored_bounded(repo, paths) {
        Ok(ignored) => return Ok(answers(paths, &ignored)),
        Err(failure) => failure,
    };
    match capture(repo, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(out) if out.trim() == "true" => {}
        // Inside a `.git` directory, or a bare repository.
        Ok(_) => return Err(failure.text()),
        // Told apart by what is on disk, not by git's (translatable) words.
        Err(_) if !has_git_marker(repo) => return Err(failure.text()),
        Err(error) => {
            return Ok(paths.iter().map(|_| IgnoreAnswer::Unknown(error.clone())).collect());
        }
    }
    let mut out = Vec::with_capacity(paths.len());
    let mut budget = CHECK_IGNORE_BUDGET;
    bisect(repo, paths, failure, &mut budget, &mut out);
    Ok(out)
}

/// A `.git` (directory or file) at `repo` or above it — where git's own
/// discovery would look.
fn has_git_marker(repo: &Path) -> bool {
    repo.ancestors().any(|dir| dir.join(".git").exists())
}

fn answers(paths: &[String], ignored: &[String]) -> Vec<IgnoreAnswer> {
    paths
        .iter()
        .map(|path| {
            if ignored.contains(path) {
                IgnoreAnswer::Ignored
            } else {
                IgnoreAnswer::NotIgnored
            }
        })
        .collect()
}

/// `paths` failed as one question with `failure`: answer each half.
fn bisect(
    repo: &Path,
    paths: &[String],
    failure: CheckFailure,
    budget: &mut usize,
    out: &mut Vec<IgnoreAnswer>,
) {
    if paths.len() <= 1 || matches!(failure, CheckFailure::TimedOut) {
        out.extend(paths.iter().map(|_| IgnoreAnswer::Unknown(failure.text())));
        return;
    }
    let (left, right) = paths.split_at(paths.len() / 2);
    for half in [left, right] {
        if *budget == 0 {
            out.extend(half.iter().map(|_| {
                IgnoreAnswer::Unknown(format!(
                    "not asked: Plyloft stopped after {CHECK_IGNORE_BUDGET} git check-ignore runs"
                ))
            }));
            continue;
        }
        *budget -= 1;
        match check_ignored_bounded(repo, half) {
            Ok(ignored) => out.extend(answers(half, &ignored)),
            Err(failure) => bisect(repo, half, failure, budget, out),
        }
    }
}

/// What git knows of the repositories inside this one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Submodules {
    /// Paths the index holds as gitlinks (mode 160000), relative to `repo`.
    pub gitlinks: Vec<String>,
    /// Paths `.gitmodules` names, relative to `repo`: a gitlink that is also
    /// here is a registered submodule a card worktree can check out; one that
    /// isn't is an embedded repository with no URL, which nothing can.
    pub registered: Vec<String>,
}

/// [`gitlinks`] under `pathspecs`, and the paths `.gitmodules` registers.
pub fn submodules(repo: &Path, pathspecs: &[&str]) -> Submodules {
    Submodules {
        gitlinks: gitlinks(repo, pathspecs),
        registered: registered_submodules(repo),
    }
}

/// The `path = …` entries of the work tree's `.gitmodules`, made relative to
/// `repo` (which may be a directory inside the work tree). Empty when there
/// is none or git can't say where the top is.
fn registered_submodules(repo: &Path) -> Vec<String> {
    let Ok(out) = capture(repo, &["rev-parse", "--show-cdup", "--show-prefix"]) else {
        return Vec::new();
    };
    let mut lines = out.lines();
    let cdup = lines.next().unwrap_or("").trim().to_string();
    let prefix = lines.next().unwrap_or("").trim().to_string();
    let Ok(text) = std::fs::read_to_string(repo.join(&cdup).join(".gitmodules")) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let (key, value) = line.trim().split_once('=')?;
            (key.trim() == "path").then(|| value.trim().to_string())
        })
        .filter_map(|path| path.strip_prefix(&prefix).map(str::to_string))
        .collect()
}

/// Paths git tracks as submodules (gitlinks, mode 160000) under `pathspecs`,
/// relative to `repo`. A submodule that is not checked out has no `.git` on
/// disk, and git still refuses any path inside it. Empty when git can't say.
pub fn gitlinks(repo: &Path, pathspecs: &[&str]) -> Vec<String> {
    let mut cmd = crate::platform::git_command();
    cmd.args(["ls-files", "--stage", "-z", "--"]).args(pathspecs).current_dir(repo);
    let Ok(out) = crate::worktrees::run_bounded_output(&mut cmd, CHECK_IGNORE_TIMEOUT) else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    out.stdout
        .split(|byte| *byte == 0)
        .filter_map(|entry| {
            let entry = String::from_utf8_lossy(entry);
            let (meta, path) = entry.split_once('\t')?;
            meta.starts_with("160000 ").then(|| path.to_string())
        })
        .collect()
}

/// What happened to a file between two revisions.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiffChangeKind {
    Added,
    Modified,
    Removed,
    Renamed,
}

/// One file's worth of unified diff.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// New path (post-change). For a removed file this is the path it had.
    pub path: String,
    /// Set only for renames — the pre-rename path.
    pub old_path: Option<String>,
    pub kind: DiffChangeKind,
    pub hunks: Vec<DiffHunk>,
}

/// One `@@ … @@` hunk. `header` is the raw line (a stable-ish id for a
/// review decision); `body` is the hunk's `+`/`-`/context lines verbatim.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub body: String,
}

/// `git diff --no-color <base>...<head>` in `repo`, parsed into per-file
/// hunks. Three-dot: the changes `head` introduced since its merge-base
/// with `base` — i.e. exactly a card branch's own work.
pub fn diff_hunks(repo: &Path, base: &str, head: &str) -> Result<Vec<FileDiff>, String> {
    let range = format!("{base}...{head}");
    // `-M` so a rename is one file whatever the user's `diff.renames` says,
    // as in the Outcome count (GH #191).
    // CL-6 round 2: paths as they are (not C-quoted octal), so a non-ASCII
    // name reads the same here as in the findings' anchors.
    let out = capture(repo, &["-c", "core.quotePath=false", "diff", "--no-color", "-M", &range])?;
    Ok(parse_unified_diff(&out))
}

/// Parse `git diff` unified output into `FileDiff`s. Pure — the unit-tested
/// seam. Tolerates binary-file stanzas and pure renames (both yield zero
/// hunks).
pub fn parse_unified_diff(diff: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut cur: Option<FileDiff> = None;
    let mut hunk: Option<DiffHunk> = None;
    let mut body = String::new();

    // Close the in-progress hunk into the current file.
    fn flush_hunk(cur: &mut Option<FileDiff>, hunk: &mut Option<DiffHunk>, body: &mut String) {
        if let (Some(file), Some(mut h)) = (cur.as_mut(), hunk.take()) {
            h.body = std::mem::take(body);
            file.hunks.push(h);
        } else {
            body.clear();
        }
    }

    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            flush_hunk(&mut cur, &mut hunk, &mut body);
            if let Some(prev) = cur.take() {
                files.push(prev);
            }
            let (a, b) = split_diff_git_paths(rest);
            cur = Some(FileDiff {
                path: b.clone(),
                old_path: if a != b { Some(a) } else { None },
                kind: DiffChangeKind::Modified,
                hunks: Vec::new(),
            });
            continue;
        }
        let Some(file) = cur.as_mut() else { continue };

        if hunk.is_none() {
            // Pre-hunk metadata lines.
            if line.starts_with("new file mode") {
                file.kind = DiffChangeKind::Added;
                continue;
            }
            if line.starts_with("deleted file mode") {
                file.kind = DiffChangeKind::Removed;
                continue;
            }
            if let Some(from) = line.strip_prefix("rename from ") {
                file.kind = DiffChangeKind::Renamed;
                file.old_path = Some(from.to_string());
                continue;
            }
            if let Some(to) = line.strip_prefix("rename to ") {
                file.kind = DiffChangeKind::Renamed;
                file.path = to.to_string();
                continue;
            }
        }

        if line.starts_with("@@") {
            flush_hunk(&mut cur, &mut hunk, &mut body);
            if let Some(h) = parse_hunk_header(line) {
                hunk = Some(h);
            }
            continue;
        }

        if hunk.is_some() {
            // Hunk body: context / +/- / "\ No newline" lines.
            if line.starts_with(' ')
                || line.starts_with('+')
                || line.starts_with('-')
                || line.starts_with('\\')
            {
                body.push_str(line);
                body.push('\n');
            }
        }
    }
    flush_hunk(&mut cur, &mut hunk, &mut body);
    if let Some(prev) = cur.take() {
        files.push(prev);
    }
    files
}

/// `a/foo b/bar` → (`foo`, `bar`). Tolerates spaces in paths by splitting on
/// the ` b/` separator.
fn split_diff_git_paths(rest: &str) -> (String, String) {
    let trimmed = rest.trim();
    if let Some(idx) = trimmed.find(" b/") {
        let a = trimmed[..idx].trim_start_matches("a/").to_string();
        let b = trimmed[idx + 3..].to_string();
        return (a, b);
    }
    // Fallback: best-effort whitespace split.
    let mut parts = trimmed.splitn(2, ' ');
    let a = parts.next().unwrap_or("").trim_start_matches("a/").to_string();
    let b = parts
        .next()
        .unwrap_or("")
        .trim_start_matches("b/")
        .to_string();
    (a, b)
}

/// Parse `@@ -A,B +C,D @@ optional-heading`. A count omitted means 1.
fn parse_hunk_header(line: &str) -> Option<DiffHunk> {
    let inner = line.strip_prefix("@@ ")?;
    let close = inner.find(" @@")?;
    let ranges = &inner[..close];
    let mut it = ranges.split_whitespace();
    let (old_start, old_lines) = parse_range(it.next()?.strip_prefix('-')?)?;
    let (new_start, new_lines) = parse_range(it.next()?.strip_prefix('+')?)?;
    Some(DiffHunk {
        header: line.to_string(),
        old_start,
        old_lines,
        new_start,
        new_lines,
        body: String::new(),
    })
}

/// `12,3` → (12, 3); `12` → (12, 1).
fn parse_range(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.split(',');
    let start: u32 = parts.next()?.parse().ok()?;
    let count: u32 = match parts.next() {
        Some(c) => c.parse().ok()?,
        None => 1,
    };
    Some((start, count))
}

/// R8 (owner, 2026-10-26): how long one of Plyloft's own `git commit`s may
/// take — Land, Release, a build snapshot, a recovery commit. A project's
/// hooks and commit signing run inside it, and a hung hook or a signing
/// prompt nobody sees would otherwise hold Ship's locks (and card starts)
/// for ever.
pub const COMMIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// R8: what a commit stopped at [`COMMIT_TIMEOUT`] says.
pub const COMMIT_TIMED_OUT_WORDS: &str =
    "Committing took too long — a hook or a signing prompt in this project may be waiting. Nothing was committed.";

/// R8: the start of what a commit a project's hook refused says; the hook's
/// first lines follow, then a blank line and [`NOTHING_COMMITTED_WORDS`].
pub const HOOK_REFUSED_WORDS: &str = "A hook in this project refused the commit:";

pub const NOTHING_COMMITTED_WORDS: &str = "Nothing was committed.";

/// Of a refusing hook's output, at most this many lines are said…
const HOOK_LINES: usize = 8;
/// …each cut at this many characters.
const HOOK_LINE_CHARS: usize = 200;

/// The hooks `git commit` runs before it writes anything, any of which can
/// refuse it.
const COMMIT_HOOKS: [&str; 3] = ["pre-commit", "prepare-commit-msg", "commit-msg"];

#[cfg(test)]
thread_local! {
    /// A test's own [`COMMIT_TIMEOUT`] for commits made on its thread.
    static COMMIT_TIMEOUT_FOR_TEST: std::cell::Cell<Option<std::time::Duration>> =
        const { std::cell::Cell::new(None) };
}

/// While the guard lives, commits made on this thread stop after `timeout`.
#[cfg(test)]
pub(crate) fn commit_timeout_for_test(timeout: std::time::Duration) -> impl Drop {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            COMMIT_TIMEOUT_FOR_TEST.with(|t| t.set(None));
        }
    }
    COMMIT_TIMEOUT_FOR_TEST.with(|t| t.set(Some(timeout)));
    Reset
}

fn commit_timeout() -> std::time::Duration {
    #[cfg(test)]
    if let Some(timeout) = COMMIT_TIMEOUT_FOR_TEST.with(|t| t.get()) {
        return timeout;
    }
    COMMIT_TIMEOUT
}

/// Why one of Plyloft's commits made nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitFailure {
    /// It ran past [`COMMIT_TIMEOUT`]; it and everything it started (the
    /// hook, a signing helper) were killed.
    TimedOut,
    /// A `pre-commit`, `prepare-commit-msg` or `commit-msg` hook refused it:
    /// the hook's first lines, plain.
    HookRefused(String),
    /// Git found nothing to commit.
    NothingToCommit,
    /// Any other refusal: git's own words.
    Failed(String),
    /// [`CommitFailure::TimedOut`], and git's `index.lock` was still
    /// changing afterwards (something else writes the index), so it was
    /// left: the path.
    TimedOutLockKept(String),
}

impl CommitFailure {
    /// The sentence a caller passes on.
    pub fn text(&self) -> String {
        match self {
            CommitFailure::TimedOut => COMMIT_TIMED_OUT_WORDS.to_string(),
            CommitFailure::HookRefused(said) => {
                format!("{HOOK_REFUSED_WORDS}\n{said}\n\n{NOTHING_COMMITTED_WORDS}")
            }
            CommitFailure::NothingToCommit => "git commit failed: nothing to commit".to_string(),
            CommitFailure::Failed(said) => format!("git commit failed: {said}"),
            CommitFailure::TimedOutLockKept(lock) => format!(
                "{COMMIT_TIMED_OUT_WORDS}\nSomething else is still writing git's lock file ({lock}), so Plyloft left it; if no git is running, delete it."
            ),
        }
    }
}

/// R8: `git commit <args>` in `repo`, the way every commit Plyloft makes
/// itself runs: bounded by [`COMMIT_TIMEOUT`], in its own process group (a
/// Job Object on Windows) so a timeout ends the hook and any helper it
/// started, with no stdin (a hook that asks gets an end of input), and
/// registered for app exit (Hard rule 4). A refusal by the project's own
/// hook is told apart from git's ([`CommitFailure::HookRefused`]). The
/// caller puts its index back: this only clears the `index.lock` a killed
/// commit leaves behind.
pub fn commit(repo: &Path, args: &[&str]) -> Result<(), CommitFailure> {
    commit_configured(repo, &[], args)
}

/// F2: what a commit in a repository Plyloft owns itself (My library, the
/// team library, a team proposal) adds to its `git commit`: no hook of the
/// person's (`pre-commit`, `commit-msg`; a global `core.hooksPath` would
/// otherwise run in them) and no signing (a global `commit.gpgSign` would
/// otherwise ask for a key or a passphrase nobody sees).
pub const OWN_REPO_COMMIT_FLAGS: [&str; 2] = ["--no-verify", "--no-gpg-sign"];

/// [`commit`] with `config` (`-c key=value` pairs, an identity) before the
/// subcommand.
pub fn commit_configured(repo: &Path, config: &[&str], args: &[&str]) -> Result<(), CommitFailure> {
    let timeout = commit_timeout();
    let started = std::time::SystemTime::now();
    // Challenger MINOR 2: a commit whose `post-commit` hook hangs is made
    // already; the timeout then ends only the hook.
    let head_before = capture(repo, &["rev-parse", "-q", "--verify", "HEAD"]).ok();
    let mut cmd = crate::platform::git_command();
    cmd.args(config).arg("commit").args(args).current_dir(repo);
    let out = match crate::worktrees::run_bounded_output_unparsed(&mut cmd, timeout) {
        Ok(out) => out,
        Err(crate::worktrees::BoundedFailure::TimedOut) => {
            let head_now = capture(repo, &["rev-parse", "-q", "--verify", "HEAD"]).ok();
            if head_now.is_some() && head_now != head_before {
                log::warn!(
                    "git commit in {}: committed, but a hook after it (post-commit) ran past {}s and was stopped",
                    repo.display(),
                    timeout.as_secs()
                );
                return Ok(());
            }
            return Err(match clear_stale_index_lock(repo, started) {
                Some(kept) => CommitFailure::TimedOutLockKept(kept.display().to_string()),
                None => CommitFailure::TimedOut,
            });
        }
        Err(crate::worktrees::BoundedFailure::Spawn(e)) => {
            return Err(CommitFailure::Failed(format!("couldn't start git: {e}")))
        }
        Err(crate::worktrees::BoundedFailure::Quitting) => {
            return Err(CommitFailure::Failed("Plyloft is quitting".into()))
        }
        // Stdout is not read as an answer here.
        Err(crate::worktrees::BoundedFailure::Truncated) => {
            return Err(CommitFailure::Failed("its output could not be read".into()))
        }
    };
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    Err(classify_commit_failure(&stdout, &stderr, commit_hook_present(repo)))
}

/// Git's own failures end on a `fatal:` line (a signing failure, no
/// identity, a broken repository); a hook that exits non-zero makes git
/// stop without a word of its own, so its output is the last thing said.
///
/// Heuristic gaps (Challenger MINOR 4): a hook whose own last line starts
/// with `fatal:` reads as git's failure (its words are still said, as
/// git's); a hook configured another way than a file in the hooks folder
/// (git 2.46's `hook.<name>.command` config) isn't seen by
/// [`commit_hook_present`], so its refusal reads as git's (`Failed`, with
/// the hook's words).
fn classify_commit_failure(stdout: &str, stderr: &str, hook_present: bool) -> CommitFailure {
    // Challenger MINOR 3: git's own "nothing to commit" is its status
    // listing, on stdout (a hook's stdout goes to git's stderr). On stderr
    // it is believed only when no hook could have said it.
    let says_nothing = |text: &str| {
        text.lines().map(|l| l.trim_start().to_lowercase()).any(|l| {
            l.starts_with("nothing to commit")
                || l.starts_with("nothing added to commit")
                || l.starts_with("no changes added to commit")
        })
    };
    if says_nothing(stdout) || (!hook_present && says_nothing(stderr)) {
        return CommitFailure::NothingToCommit;
    }
    let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
    if hook_present && !last.trim_start().starts_with("fatal:") {
        // Hooks' stdout goes to git's stderr; a hook run some other way may
        // still print on stdout.
        let said = hook_lines(if stderr.trim().is_empty() { stdout } else { stderr });
        let said = if said.is_empty() { "(the hook printed nothing)".to_string() } else { said };
        return CommitFailure::HookRefused(said);
    }
    CommitFailure::Failed(stderr.trim().to_string())
}

/// A hook's first [`HOOK_LINES`] non-empty lines, without colours or
/// control codes, each at most [`HOOK_LINE_CHARS`] long.
fn hook_lines(text: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines() {
        let plain = strip_ansi(line);
        let plain = plain.trim_end();
        if plain.trim().is_empty() || plain.starts_with("hint:") {
            continue;
        }
        if lines.len() == HOOK_LINES {
            lines.push("…".to_string());
            break;
        }
        let cut: String = plain.chars().take(HOOK_LINE_CHARS).collect();
        lines.push(if cut.len() < plain.len() { format!("{cut}…") } else { cut });
    }
    lines.join("\n")
}

fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI: ESC [ … final byte in @..~; any other escape: one char.
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            } else {
                chars.next();
            }
        } else if c == '\t' || !c.is_control() {
            out.push(c);
        }
    }
    out
}

/// Whether `repo` has a hook `git commit` would run before writing:
/// `core.hooksPath` or `.git/hooks` (git answers which), a file there by
/// one of [`COMMIT_HOOKS`]' names — executable on unix, where git skips
/// one that isn't; any file on Windows, where Git for Windows runs it.
fn commit_hook_present(repo: &Path) -> bool {
    let Ok(dir) = capture(repo, &["rev-parse", "--git-path", "hooks"]) else {
        return false;
    };
    let dir = repo.join(dir.trim());
    COMMIT_HOOKS.iter().any(|name| {
        let path = dir.join(name);
        std::fs::metadata(&path).is_ok_and(|meta| {
            #[cfg(unix)]
            {
                crate::platform::is_executable(&path, &meta)
            }
            #[cfg(not(unix))]
            {
                meta.is_file()
            }
        })
    })
}

/// How long a lock left by a stopped commit must stay unchanged before it
/// is removed.
#[cfg(not(test))]
const LOCK_SETTLE: std::time::Duration = std::time::Duration::from_secs(2);
#[cfg(test)]
const LOCK_SETTLE: std::time::Duration = std::time::Duration::from_millis(300);

/// A commit killed mid-hook leaves git's `index.lock` behind (git holds it
/// while the hooks run), and every later git that writes the index then
/// refuses. Only a lock made since `since` — this commit's — is removed, and
/// (Challenger MINOR 1) only when it is unchanged (time and size) after
/// [`LOCK_SETTLE`]: one still changing is another git's, and is left —
/// returned, for the words.
fn clear_stale_index_lock(repo: &Path, since: std::time::SystemTime) -> Option<std::path::PathBuf> {
    let index = capture(repo, &["rev-parse", "--git-path", "index"]).ok()?;
    let lock = repo.join(format!("{}.lock", index.trim()));
    let stamp = |path: &Path| std::fs::metadata(path).ok().and_then(|m| Some((m.modified().ok()?, m.len())));
    let first = stamp(&lock)?;
    if first.0 + std::time::Duration::from_secs(1) < since {
        return None;
    }
    std::thread::sleep(LOCK_SETTLE);
    match stamp(&lock) {
        None => None,
        Some(now) if now != first => {
            log::warn!("git commit: {} is still changing after the timeout; left it", lock.display());
            Some(lock)
        }
        Some(_) => {
            if let Err(e) = std::fs::remove_file(&lock) {
                log::warn!("git commit: couldn't remove {} after the timeout: {e}", lock.display());
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Challenger MINOR 3: "nothing to commit" is git's status words on
    /// stdout; a refusing hook that says it is still the hook's refusal.
    #[test]
    fn nothing_to_commit_is_gits_own_words_only() {
        let nothing = "On branch main\nnothing to commit, working tree clean\n";
        assert_eq!(classify_commit_failure(nothing, "", true), CommitFailure::NothingToCommit);
        assert_eq!(
            classify_commit_failure("", "no changes added to commit\n", false),
            CommitFailure::NothingToCommit
        );
        let hook = "lint: nothing to commit until the tests pass\n";
        assert!(matches!(classify_commit_failure("", hook, true), CommitFailure::HookRefused(said) if said.contains("until the tests pass")));
        assert!(matches!(classify_commit_failure("", "fatal: no identity\n", true), CommitFailure::Failed(_)));
    }

    /// Challenger MINOR 2: a `post-commit` hook that hangs is stopped, and
    /// the commit it followed counts as made.
    #[cfg(unix)]
    #[test]
    fn a_hung_post_commit_hook_leaves_the_commit_made() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@t"],
            &["config", "user.name", "t"],
            &["config", "commit.gpgsign", "false"],
        ] {
            run(repo, args).unwrap();
        }
        let hook = repo.join(".git/hooks/post-commit");
        std::fs::write(&hook, "#!/bin/sh\nsleep 20\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = crate::platform::new_command(&hook).arg("--warm").spawn().map(|mut c| c.kill());
        let _bound = commit_timeout_for_test(std::time::Duration::from_secs(3));
        let started = std::time::Instant::now();
        assert_eq!(commit(repo, &["--allow-empty", "-q", "-m", "chore: x"]), Ok(()));
        assert!(started.elapsed() < std::time::Duration::from_secs(15));
        assert_eq!(capture(repo, &["log", "-1", "--format=%s"]).unwrap().trim(), "chore: x");
    }

    /// Challenger MINOR 1: a lock left by the stopped commit is removed once
    /// it holds still; one another git keeps writing is left, and said.
    #[test]
    fn a_stopped_commits_lock_is_removed_only_when_it_holds_still() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        run(repo, &["init", "-q"]).unwrap();
        let lock = repo.join(".git").join("index.lock");
        let since = std::time::SystemTime::now() - std::time::Duration::from_millis(10);
        std::fs::write(&lock, "x").unwrap();
        assert_eq!(clear_stale_index_lock(repo, since), None);
        assert!(!lock.exists(), "held still: removed");

        std::fs::write(&lock, "x").unwrap();
        let writer = {
            let lock = lock.clone();
            std::thread::spawn(move || {
                for i in 0..10 {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    let _ = std::fs::write(&lock, "y".repeat(i + 2));
                }
            })
        };
        let kept = clear_stale_index_lock(repo, since);
        writer.join().unwrap();
        assert_eq!(kept.as_deref(), Some(lock.as_path()), "still changing: left");
        assert!(lock.exists());
        let words = CommitFailure::TimedOutLockKept(lock.display().to_string()).text();
        assert!(words.starts_with(COMMIT_TIMED_OUT_WORDS) && words.contains("index.lock"), "{words}");
    }

    #[test]
    fn parses_modified_added_and_removed_files() {
        let diff = "diff --git a/src/keep.rs b/src/keep.rs\n\
index 111..222 100644\n\
--- a/src/keep.rs\n\
+++ b/src/keep.rs\n\
@@ -1,3 +1,3 @@ fn keep()\n\
 context\n\
-old line\n\
+new line\n\
@@ -10,2 +10,3 @@\n\
 more\n\
+added tail\n\
diff --git a/src/new.rs b/src/new.rs\n\
new file mode 100644\n\
index 000..333\n\
--- /dev/null\n\
+++ b/src/new.rs\n\
@@ -0,0 +1,2 @@\n\
+brand\n\
+new\n\
diff --git a/src/gone.rs b/src/gone.rs\n\
deleted file mode 100644\n\
index 444..000\n\
--- a/src/gone.rs\n\
+++ /dev/null\n\
@@ -1,1 +0,0 @@\n\
-removed\n";
        let files = parse_unified_diff(diff);
        assert_eq!(files.len(), 3);

        assert_eq!(files[0].path, "src/keep.rs");
        assert_eq!(files[0].kind, DiffChangeKind::Modified);
        assert_eq!(files[0].hunks.len(), 2);
        assert_eq!(files[0].hunks[0].old_start, 1);
        assert_eq!(files[0].hunks[0].new_lines, 3);
        assert!(files[0].hunks[0].body.contains("+new line"));
        assert!(files[0].hunks[1].body.contains("+added tail"));

        assert_eq!(files[1].path, "src/new.rs");
        assert_eq!(files[1].kind, DiffChangeKind::Added);
        assert_eq!(files[1].hunks.len(), 1);

        assert_eq!(files[2].path, "src/gone.rs");
        assert_eq!(files[2].kind, DiffChangeKind::Removed);
        assert_eq!(files[2].hunks.len(), 1);
    }

    #[test]
    fn parses_rename_with_no_hunks() {
        let diff = "diff --git a/old/name.rs b/new/name.rs\n\
similarity index 100%\n\
rename from old/name.rs\n\
rename to new/name.rs\n";
        let files = parse_unified_diff(diff);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].kind, DiffChangeKind::Renamed);
        assert_eq!(files[0].path, "new/name.rs");
        assert_eq!(files[0].old_path.as_deref(), Some("old/name.rs"));
        assert!(files[0].hunks.is_empty());
    }

    #[test]
    fn empty_diff_yields_no_files() {
        assert!(parse_unified_diff("").is_empty());
    }

    #[test]
    fn hunk_header_without_counts_defaults_to_one() {
        let h = parse_hunk_header("@@ -5 +7 @@").unwrap();
        assert_eq!((h.old_start, h.old_lines), (5, 1));
        assert_eq!((h.new_start, h.new_lines), (7, 1));
    }

    /// GH #227: git fails the whole batch on one path behind a symbolic
    /// link; the per-path answer keeps the others.
    #[cfg(unix)] // a symlink fixture
    #[test]
    fn one_path_behind_a_link_does_not_hide_the_others() {
        let dir = tempfile::TempDir::new().unwrap();
        let repo = dir.path();
        run(repo, &["init", "-q"]).unwrap();
        std::fs::write(repo.join(".gitignore"), ".claude/\n").unwrap();
        std::fs::create_dir_all(repo.join(".claude/skills/real")).unwrap();
        std::fs::create_dir_all(repo.join("shared/linked")).unwrap();
        std::os::unix::fs::symlink("../../shared/linked", repo.join(".claude/skills/linked"))
            .unwrap();
        let paths = vec![
            ".claude/skills/real/SKILL.md".to_string(),
            ".claude/skills/linked/SKILL.md".to_string(),
            "shared/linked/SKILL.md".to_string(),
            ".claude/skills/linked".to_string(),
        ];
        // The batch alone fails, which is the bug's root.
        let batch = check_ignored(repo, &paths).unwrap_err();
        assert!(batch.contains("beyond a symbolic link"), "{batch}");

        let answers = check_ignored_each(repo, &paths).unwrap();
        assert_eq!(answers[0], IgnoreAnswer::Ignored);
        match &answers[1] {
            IgnoreAnswer::Unknown(error) => {
                assert!(error.contains("beyond a symbolic link"), "{error}")
            }
            other => panic!("git could not answer, never {other:?}"),
        }
        assert_eq!(answers[2], IgnoreAnswer::NotIgnored);
        // The link itself is a path git answers for.
        assert_eq!(answers[3], IgnoreAnswer::Ignored);
    }

    /// Review round 1 (M1): the fallback is bounded — one refused path among
    /// hundreds is found by bisecting, not one process per path; a batch of
    /// nothing but refusals stops at the budget; a submodule is refused the
    /// same way a link is.
    #[cfg(unix)] // a symlink fixture
    #[test]
    fn the_fallback_bisects_within_a_budget() {
        let dir = tempfile::TempDir::new().unwrap();
        let repo = dir.path();
        run(repo, &["init", "-q"]).unwrap();
        std::fs::write(repo.join(".gitignore"), ".claude/\n").unwrap();
        std::fs::create_dir_all(repo.join("shared/linked")).unwrap();
        std::fs::create_dir_all(repo.join(".claude/skills")).unwrap();
        std::os::unix::fs::symlink("../../shared/linked", repo.join(".claude/skills/linked"))
            .unwrap();
        let mut paths: Vec<String> =
            (0..300).map(|n| format!(".claude/skills/s{n}/SKILL.md")).collect();
        paths.insert(137, ".claude/skills/linked/SKILL.md".to_string());

        CHECK_IGNORE_RUNS.with(|runs| runs.set(0));
        let answers = check_ignored_each(repo, &paths).unwrap();
        let runs = CHECK_IGNORE_RUNS.with(|runs| runs.get());
        assert!(runs <= 1 + 2 * 9, "{runs} runs for one refused path among 301");
        assert!(matches!(answers[137], IgnoreAnswer::Unknown(_)));
        assert_eq!(
            answers.iter().filter(|a| **a == IgnoreAnswer::Ignored).count(),
            300,
            "every other path answered"
        );

        // Nothing but refusals: stops at the budget, the rest unasked.
        let refused: Vec<String> =
            (0..300).map(|n| format!(".claude/skills/linked/s{n}/SKILL.md")).collect();
        CHECK_IGNORE_RUNS.with(|runs| runs.set(0));
        let answers = check_ignored_each(repo, &refused).unwrap();
        let runs = CHECK_IGNORE_RUNS.with(|runs| runs.get());
        assert!(runs <= 1 + CHECK_IGNORE_BUDGET, "{runs} runs");
        assert!(answers.iter().all(|a| matches!(a, IgnoreAnswer::Unknown(_))));
        assert!(answers
            .iter()
            .any(|a| matches!(a, IgnoreAnswer::Unknown(e) if e.starts_with("not asked"))));
    }

    #[test]
    fn a_path_inside_a_submodule_does_not_hide_the_others() {
        let dir = tempfile::TempDir::new().unwrap();
        let source = dir.path().join("source");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&repo).unwrap();
        run(&source, &["init", "-q"]).unwrap();
        std::fs::write(source.join("SKILL.md"), "x").unwrap();
        run(&source, &["add", "."]).unwrap();
        run(&source, &["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "s"]).unwrap();
        run(&repo, &["init", "-q"]).unwrap();
        run(
            &repo,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                source.to_str().unwrap(),
                ".claude/skills/sub",
            ],
        )
        .unwrap();
        std::fs::write(repo.join(".gitignore"), ".claude/\n").unwrap();
        let paths = vec![
            ".claude/skills/real/SKILL.md".to_string(),
            ".claude/skills/sub/SKILL.md".to_string(),
        ];
        let answers = check_ignored_each(&repo, &paths).unwrap();
        assert_eq!(answers[0], IgnoreAnswer::Ignored);
        assert!(
            matches!(&answers[1], IgnoreAnswer::Unknown(e) if e.contains("is in submodule")),
            "{answers:?}"
        );
        assert_eq!(gitlinks(&repo, &[".claude"]), vec![".claude/skills/sub".to_string()]);
    }

    #[test]
    fn a_folder_that_is_not_a_repository_is_still_an_error() {
        let dir = tempfile::TempDir::new().unwrap();
        assert!(check_ignored_each(dir.path(), &["a/SKILL.md".to_string()]).is_err());
    }

    /// A linked worktree's `.git` is a file, not a directory: still a
    /// repository, so git failing there is unknown, never "not a repository".
    #[test]
    fn a_worktree_whose_git_is_a_file_is_still_a_repository() {
        let dir = tempfile::TempDir::new().unwrap();
        let main = dir.path().join("main");
        let worktree = dir.path().join("wt");
        std::fs::create_dir_all(&main).unwrap();
        run(&main, &["init", "-q"]).unwrap();
        run(&main, &["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "c"]).unwrap();
        run(&main, &["worktree", "add", "-q", worktree.to_str().unwrap()]).unwrap();
        assert!(worktree.join(".git").is_file(), "a linked worktree's .git is a file");

        // Answered normally while git can read it.
        let paths = vec!["a/SKILL.md".to_string()];
        assert_eq!(check_ignored_each(&worktree, &paths).unwrap(), vec![IgnoreAnswer::NotIgnored]);

        // Git refusing it (the shared config broken) is unknown, not an error.
        let config = main.join(".git").join("config");
        let mut broken = std::fs::read_to_string(&config).unwrap();
        broken.push_str("[core\nbroken");
        std::fs::write(&config, broken).unwrap();
        let answers = check_ignored_each(&worktree, &paths).expect("still a repository");
        assert!(matches!(&answers[0], IgnoreAnswer::Unknown(e) if e.contains("bad config")), "{answers:?}");
    }

    /// A repository git won't answer for is not "not a repository": every
    /// path is unknown, with git's words, never quietly "not ignored".
    #[test]
    fn a_repository_git_cannot_read_answers_unknown_not_an_error() {
        let dir = tempfile::TempDir::new().unwrap();
        let repo = dir.path();
        run(repo, &["init", "-q"]).unwrap();
        let config = repo.join(".git").join("config");
        let mut broken = std::fs::read_to_string(&config).unwrap();
        broken.push_str("[core\nbroken");
        std::fs::write(&config, broken).unwrap();

        let paths = vec![".claude/skills/x/SKILL.md".to_string(), "b".to_string()];
        let answers = check_ignored_each(repo, &paths).expect("a repository, unanswered");
        assert_eq!(answers.len(), 2);
        for answer in &answers {
            assert!(
                matches!(answer, IgnoreAnswer::Unknown(e) if e.contains("bad config")),
                "{answers:?}"
            );
        }
    }
}
