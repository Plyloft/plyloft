//! The shared-config write channel (GH #80, ADR 0003): how a change to the
//! shared workspace definition reaches everyone.
//!
//! **One way in.** [`publish`] commits `.atelier/` files straight onto the
//! integration branch on origin and pushes, using git plumbing only — a
//! scratch index, `hash-object`, `write-tree`, `commit-tree` with the fetched
//! tip as parent, then `git push origin <sha>:<branch>`. The user's checkout,
//! its index and its branch are never touched: on a Mac sitting on `staging`
//! with uncommitted files, nothing there changes. The channel refuses any path
//! outside `.atelier/`, `.claude/skills/` and the two root instruction files
//! ([`check_path`]), so it can never carry code; the rule "Ply never pushes
//! main" still protects the Builder's work.
//!
//! **Asked, never overwritten silently (1.173.0, C3).** Each queued field
//! remembers the value it replaced (`base`). Before committing, the branch is
//! fetched and the change is re-applied field by field onto the tip, so other
//! fields changed upstream are kept. When the same field changed upstream
//! since — another member, or the same person on another computer — that
//! field is held with a [`FieldConflict`] and every other field still goes;
//! the person answers in the app (`setting_conflict.rs`). *Use this Mac's*
//! ([`UseMine`]) publishes over exactly the value shown, and the commit
//! message names the other author as before ("overrides test-owner's
//! value from 2 min ago"); a value that moved on again asks again. Every
//! commit names its computer in a [`DEVICE_TRAILER`], so the other computer
//! can say which one. A non-fast-forward push is retried once from a fresh fetch; a second
//! refusal, or any refusal by the remote (branch protection, no write
//! permission), opens a pull request `Settings: <field>` from a branch
//! `atelier/config-<field>-<ts>` instead.
//!
//! **Queue.** Nothing is lost offline: `projects/<ws>/shared_config_queue.json`
//! (atomic, Hard Rule #3) holds every change not on the branch yet, and is
//! drained on the next Sync, refresh or edit (`workspace_definition`).
//!
//! **Serialized.** Publishes for one workspace run under the definition's
//! workspace lock; every publish and Ship's local merge on the same branch
//! also take [`integration_lock`].

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::project_config::ProjectConfigStore;
use crate::workspace_definition::{
    field_label, field_value, file_text, is_project_field, parse_definition, to_map,
    WorkspaceDefinition, DEFINITION_PATH, PROJECT_FIELDS,
};

/// The only directory the channel writes.
pub const SHARED_DIR: &str = ".atelier/";
/// GH #82: project skills, the one other directory the channel writes.
pub const SKILLS_DIR: &str = ".claude/skills/";
/// GH #105: a skill's Codex half. Claude reads `.claude/skills/` and Codex
/// `.agents/skills/`, so a skill that reaches both CLIs is one item in two
/// directories, and the channel has to be allowed to write the second.
pub const CODEX_SKILLS_DIR: &str = ".agents/skills/";
/// GH #101 (BOARDS.md §5, ADR 0005): the two instruction files every agent
/// reads, at the repository root — the only files outside [`SHARED_DIR`],
/// [`SKILLS_DIR`] and [`CODEX_SKILLS_DIR`] the channel may write, and
/// **exactly** these two names.
///
/// Matched literally against the whole repository-relative path, so
/// `./AGENTS.md`, `docs/AGENTS.md`, `agents.md` and `AGENTS.md/x` are all
/// refused: the channel writes the file the CLIs read and nothing that merely
/// looks like it ([`check_path`]).
pub const INSTRUCTION_FILES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];
/// In a [`PublishOutcome::Failed`] message: the remote refused the push and
/// no pull request could carry the change instead — this Mac can't write.
pub const REFUSED_MARKER: &str = "refused the push";
/// teamfix round 2 (C3): the trailer the move commit carries — the commit of
/// the copy it moved, so the moved copy is recognised as the current one.
pub const MOVED_FROM_TRAILER: &str = "Plyloft-Moved-From";
/// teamfix round 2 (C3): a move refused because the branch holds a copy
/// that isn't older than the one moved.
pub const NEWER_COPY_MARKER: &str = "holds a copy that isn't older than this one";

/// teamfix round 2 (C3): whether the copy last committed as `there` is older
/// than the one committed as `source` — `Some(false)` for a copy moved from
/// `source` (or from something after it, by its [`MOVED_FROM_TRAILER`]);
/// else by ancestry; only where ancestry can't say (diverged, or git can't
/// answer), by committer time. `None`: nothing can say.
pub fn copy_is_older(
    there: &str,
    source: &str,
    ancestry: &dyn Fn(&str, &str) -> Option<bool>,
    moved_from: &dyn Fn(&str) -> Option<String>,
    committed_at: &dyn Fn(&str) -> Option<i64>,
) -> Option<bool> {
    if there == source {
        return Some(false);
    }
    if let Some(from) = moved_from(there) {
        if from == source || ancestry(source, &from) == Some(true) {
            return Some(false);
        }
    }
    if ancestry(there, source) == Some(true) {
        return Some(true);
    }
    if ancestry(source, there) == Some(true) {
        return Some(false);
    }
    match (committed_at(there), committed_at(source)) {
        (Some(a), Some(b)) => Some(a < b),
        _ => None,
    }
}
/// GH #101 review 1: in a failed instructions publish — the file moved on the
/// branch, so Ply would not commit over it, and no pull request could carry the
/// change instead either.
///
/// Deliberately **not** [`REFUSED_MARKER`]: the branch was never asked. Sharing
/// that marker made the row and the toast say "staging refused the push" about a
/// push that never happened, and set `LibraryReport.refused` — the input to the
/// read-only `PublishRefusedBlock`, a block about write access this Mac has.
pub const NEVER_OVERRIDE_MARKER: &str = "Plyloft doesn't commit over an instruction file";
/// The same rule for a repository skill (skills group B §2): a skill somebody
/// else changed on the branch since this change began is never committed over.
/// Its own words, and the same treatment — `blocked`, never `refused`.
pub const SKILL_NEVER_OVERRIDE_MARKER: &str = "Plyloft doesn't commit over a skill";
/// F3/F9 (team walk, v1.157.0): in a [`PublishOutcome::Failed`] /
/// `ChangeOutcome::Failed` message — origin answered, and the branch isn't
/// there (deleted, renamed, never pushed). Not "offline": waiting for the
/// connection would wait forever, so it is said as something to fix.
pub const BRANCH_MISSING_MARKER: &str = "isn't on GitHub any more";
pub const QUEUE_FILENAME: &str = "shared_config_queue.json";
const QUEUE_SCHEMA_VERSION: u32 = 1;
/// Fallback branch names tried for one change: `<branch>`, `<branch>-2`, …
const PR_BRANCH_ATTEMPTS: u32 = 5;
/// How far back the channel looks for who last changed an overridden field.
const HISTORY_LIMIT: usize = 50;

// ── Only `.atelier/` ──────────────────────────────────────────────────

/// A repository-relative path the channel may write: strictly inside
/// `.atelier/`, no `.`/`..`/empty components, no backslashes.
pub fn check_path(path: &str) -> Result<(), String> {
    // GH #81: the root `.gitignore`, which only the definition's creation
    // commit touches (to stop it hiding `.atelier/workspace.json`).
    if path == crate::workspace_adoption::GITIGNORE_PATH {
        return Ok(());
    }
    // GH #101: the two instruction files, at the root and under those exact
    // names. A whole-string comparison, so no prefix rule can widen it.
    if INSTRUCTION_FILES.contains(&path) {
        return Ok(());
    }
    let refused = || {
        Err(format!(
            "Plyloft's shared-config channel only writes files under {SHARED_DIR}, {SKILLS_DIR} \
             and {CODEX_SKILLS_DIR}, and the root {} and {}; refused {path:?}",
            INSTRUCTION_FILES[0], INSTRUCTION_FILES[1]
        ))
    };
    // GH #82: project skills travel on the same channel.
    let Some(rest) = path
        .strip_prefix(SHARED_DIR)
        .or_else(|| path.strip_prefix(SKILLS_DIR))
        .or_else(|| path.strip_prefix(CODEX_SKILLS_DIR))
    else {
        return refused();
    };
    if rest.is_empty() || path.contains('\\') || path.contains('\0') {
        return refused();
    }
    if rest
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return refused();
    }
    Ok(())
}

/// One file the channel writes, with its full new contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// GH #82: one path of a library commit — written (contents, executable) or
/// removed (`None`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeChange {
    pub path: String,
    pub content: Option<(Vec<u8>, bool)>,
}

/// One entry of `git ls-tree`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    pub mode: String,
    pub kind: String,
    pub sha: String,
    /// From the repository root.
    pub path: String,
}

// ── Git plumbing ──────────────────────────────────────────────────────

/// What a push to origin came back with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushResult {
    Pushed,
    /// The branch moved on since the fetch.
    NonFastForward(String),
    /// The remote said no: branch protection, no write permission, a hook.
    Refused(String),
    /// Offline, DNS, timeout, authentication: try again later.
    Unreachable(String),
}

/// Sort git's push stderr into a [`PushResult`].
pub fn classify_push_error(stderr: &str) -> PushResult {
    let lower = stderr.to_lowercase();
    let message = stderr.trim().to_string();
    if lower.contains("[remote rejected]")
        || lower.contains("protected branch")
        || lower.contains("gh006")
        || lower.contains("permission to")
        || lower.contains("error: 403")
        || lower.contains("returned error: 403")
    {
        PushResult::Refused(message)
    } else if lower.contains("[rejected]")
        || lower.contains("non-fast-forward")
        || lower.contains("fetch first")
    {
        PushResult::NonFastForward(message)
    } else {
        PushResult::Unreachable(message)
    }
}

/// 1.175.0 (C4, SC-7): why the last publish didn't land, as the page says
/// it. Only `Network` is "you're offline"; the three sign-in kinds each
/// have their own sentence and the press that fixes them. Kept in the
/// queue (`lastErrorKind`); a queue written before has none, read as
/// `Other`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PublishTrouble {
    /// The remote couldn't be reached at all.
    Network,
    /// Git needed a sign-in it couldn't get (HTTPS without the GitHub
    /// sign-in helper, a refused token, an SSH key).
    GitSignIn,
    /// The GitHub command isn't signed in (or its token was refused), so no
    /// pull request could be opened or followed.
    GhSignedOut,
    /// An organization's single sign-on isn't authorized for the GitHub
    /// command. `org` when GitHub's answer names it.
    #[serde(rename_all = "camelCase")]
    Sso { org: Option<String> },
    /// Anything else, said in the words that came with it.
    Other,
}

/// Sort a publish failure's words. `unreachable`: the channel couldn't reach
/// the remote (`PublishOutcome::Unreachable`). Sign-in trouble is told apart
/// first — it reached the channel as "unreachable" before 1.175.0 (a push
/// whose sign-in was refused, a `gh` that isn't signed in) and was said as
/// "you're offline". Matched on the English texts git and `gh` print;
/// a git in another language prints its own words, and those fall to
/// `Other` when the push was refused, or to `Network` when the channel
/// couldn't reach the remote — never a sign-in it can't recognise.
pub fn classify_trouble(error: &str, unreachable: bool) -> PublishTrouble {
    let lower = error.to_lowercase();
    if let Some(need) = crate::setup_github::sso_need(error) {
        return PublishTrouble::Sso { org: need.org };
    }
    // The GitHub command's own words for "no usable sign-in", and the
    // channel's sentence for git's helper asking a gh that has none.
    if lower.contains("gh auth login")
        || lower.contains("not logged in to any")
        || lower.contains("you are not logged in")
        || error.contains("Requires authentication (HTTP 401)")
        || error.contains("HTTP 401: Requires authentication")
        || error.contains("Bad credentials (HTTP 401)")
        || error.contains("HTTP 401: Bad credentials")
        || error.contains(crate::platform::GIT_AUTH_GH_SIGNED_OUT_WORDS)
    {
        return PublishTrouble::GhSignedOut;
    }
    if crate::platform::is_git_auth_prompt_refused(error)
        || error.contains(crate::platform::GIT_AUTH_WORDS)
        || error.contains(crate::platform::GIT_SSH_AUTH_WORDS)
    {
        return PublishTrouble::GitSignIn;
    }
    // C4 round 2: "offline" only for words that say the network is missing;
    // anything else the remote couldn't be asked with is said as it came.
    let network = [
        "could not resolve host",
        "could not resolve hostname",
        "timed out",
        "connection refused",
        "connection reset",
        "network is unreachable",
        "no route to host",
        "unable to access",
        "could not connect",
        "failed to connect",
        "temporary failure in name resolution",
        "error connecting to",
        "dial tcp",
    ]
    .iter()
    .any(|w| lower.contains(w));
    let refused = lower.contains("401") || lower.contains("403");
    if unreachable && network && !refused {
        PublishTrouble::Network
    } else {
        PublishTrouble::Other
    }
}

/// Why `git fetch origin <branch>` did not land.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchFailure {
    /// Origin answered and has no such branch. Retrying will not help.
    BranchMissing { branch: String, detail: String },
    /// Offline, DNS, timeout, no origin: try again later.
    Unreachable(String),
    /// T5: git needed a sign-in it may not ask for (`GCM_INTERACTIVE=never`,
    /// `GIT_TERMINAL_PROMPT=0`). Waiting won't help; Setup › GitHub will.
    SignIn(String),
}

impl FetchFailure {
    /// The plain sentence for a missing branch; git's words go to the log.
    pub fn branch_missing_words(branch: &str) -> String {
        format!(
            "{branch} {BRANCH_MISSING_MARKER}. Choose where cards go in Settings › Cards › Shipping."
        )
    }
}

impl std::fmt::Display for FetchFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchFailure::BranchMissing { branch, .. } => {
                f.write_str(&FetchFailure::branch_missing_words(branch))
            }
            FetchFailure::Unreachable(e) => f.write_str(e),
            FetchFailure::SignIn(detail) => f.write_str(
                crate::platform::git_auth_refusal(detail).unwrap_or(crate::platform::GIT_AUTH_WORDS),
            ),
        }
    }
}

/// Sort a failed fetch's error into a [`FetchFailure`]. Git says a branch
/// origin lacks the same way on macOS, Linux and Git for Windows
/// (`fatal: couldn't find remote ref refs/heads/<branch>`; older gits
/// capitalise it, some spell it "could not").
pub fn classify_fetch_error(branch: &str, error: &str) -> FetchFailure {
    let lower = error.to_lowercase();
    if lower.contains("couldn't find remote ref") || lower.contains("could not find remote ref") {
        FetchFailure::BranchMissing {
            branch: branch.to_string(),
            detail: error.trim().to_string(),
        }
    } else if crate::platform::is_git_auth_prompt_refused(error) {
        FetchFailure::SignIn(error.trim().to_string())
    } else {
        FetchFailure::Unreachable(error.to_string())
    }
}

/// teamfix round 2: the bound on `merge-base --is-ancestor` and on finding
/// the repository's common directory.
const ANCESTRY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// teamfix: the bound on the channel's local git (logs, blobs, trees, the
/// scratch index's `hash-object`/`update-index`) — no network, generous for
/// a large history.
const LOCAL_GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// teamfix (hard rule 4): every git this module starts goes through the
/// bounded runner — its own process group, killed at its bound and at exit.
/// `stdin`, when given, is handed over as a temp file.
fn bounded_git(cmd: &mut Command, stdin: Option<&[u8]>, timeout: std::time::Duration) -> Result<std::process::Output, String> {
    let ran = match stdin {
        Some(bytes) => {
            use std::io::{Seek, SeekFrom};
            let mut file = tempfile::tempfile().map_err(|e| format!("a temp file for git's input: {e}"))?;
            file.write_all(bytes).map_err(|e| format!("writing git's input: {e}"))?;
            file.seek(SeekFrom::Start(0)).map_err(|e| format!("writing git's input: {e}"))?;
            crate::worktrees::run_bounded_output_with_stdin(cmd, timeout, file)
        }
        None => crate::worktrees::run_bounded_output(cmd, timeout),
    };
    ran.map_err(|e| format!("{e:?}"))
}

/// R8 Challenger M2: the bound on the shared-config commit.
const COMMIT_TREE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Git in one repository, without its working tree.
pub struct Plumbing {
    pub cwd: PathBuf,
}

impl Plumbing {
    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = crate::platform::git_command();
        cmd.args(args)
            .current_dir(&self.cwd)
            .env("GIT_TERMINAL_PROMPT", "0");
        cmd
    }

    /// Local git (no network: fetch and push have their own bounded paths,
    /// `worktrees::fetch_origin_branch` and `push_origin`), bounded at
    /// [`LOCAL_GIT_TIMEOUT`] and killed at exit (hard rule 4).
    fn run(
        &self,
        args: &[&str],
        stdin: Option<&[u8]>,
        index: Option<&Path>,
    ) -> Result<String, String> {
        let mut cmd = self.command(args);
        if let Some(index) = index {
            cmd.env("GIT_INDEX_FILE", index);
        }
        let out = bounded_git(&mut cmd, stdin, LOCAL_GIT_TIMEOUT).map_err(|e| format!("git {}: {e}", args.join(" ")))?;
        if !out.status.success() {
            return Err(format!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    pub fn has_origin(&self) -> bool {
        self.run(&["remote", "get-url", "origin"], None, None).is_ok()
    }

    /// `git fetch origin <branch>`, bounded and cleaned up on exit. A branch
    /// origin doesn't have is [`FetchFailure::BranchMissing`], never offline.
    pub fn fetch(&self, branch: &str) -> Result<(), FetchFailure> {
        if !self.has_origin() {
            return Err(FetchFailure::Unreachable(
                "this repository has no origin remote to publish to".to_string(),
            ));
        }
        crate::worktrees::fetch_origin_branch(&self.cwd, branch).map_err(|e| {
            let failure = classify_fetch_error(branch, &e);
            match &failure {
                FetchFailure::BranchMissing { detail, .. } => {
                    log::warn!("shared_config: origin has no branch {branch}: {detail}")
                }
                FetchFailure::SignIn(detail) => {
                    log::warn!("shared_config: git couldn't sign in to fetch {branch}: {detail}")
                }
                FetchFailure::Unreachable(_) => {}
            }
            failure
        })
    }

    /// The fetched tip of `origin/<branch>`.
    pub fn tip(&self, branch: &str) -> Option<String> {
        self.run(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/remotes/origin/{branch}^{{commit}}"),
            ],
            None,
            None,
        )
        .ok()
        .filter(|s| !s.is_empty())
    }

    /// `git merge-base <a> <b>`: the newest commit both histories share, or
    /// `None` (no common history, a shallow clone, an unborn `HEAD`).
    pub fn merge_base(&self, a: &str, b: &str) -> Option<String> {
        self.run(&["merge-base", a, b], None, None)
            .ok()
            .filter(|s| !s.is_empty())
    }

    /// The git tree id a set of **working-tree** files would have if git added
    /// them — written nowhere.
    ///
    /// `files`: (path inside the tree, path relative to the repository root,
    /// executable bit as read). Each file is hashed by git itself from its path
    /// (`hash-object --stdin-paths`, one call), so `core.autocrlf`, `.gitattributes`
    /// and clean filters apply exactly as `git add` would apply them — Git for
    /// Windows' default `autocrlf=true` included (group B §2 review). Where the
    /// executable bit means nothing (`core.fileMode` false, and always on
    /// Windows), each file's mode is the one `modes_from:<root>` records, as git
    /// keeps the index's mode there; `100644` for a file it does not carry.
    pub fn tree_of_worktree_files(
        &self,
        root: &str,
        files: &[(String, String, bool)],
        modes_from: Option<&str>,
    ) -> Result<String, String> {
        if files.is_empty() {
            return Err("no files".to_string());
        }
        let top = self.root()?;
        let at_root = Plumbing { cwd: top };
        let paths: Vec<String> = files.iter().map(|(_, path, _)| path.clone()).collect();
        let blobs = self.hash_worktree_paths(&paths, false)?;
        let file_mode = self.file_mode_meaningful();
        let recorded: std::collections::BTreeMap<String, String> = match (file_mode, modes_from) {
            (false, Some(rev)) => self
                .ls_tree(rev, root, true)
                .into_iter()
                .map(|entry| (entry.path, entry.mode))
                .collect(),
            _ => Default::default(),
        };
        let scratch = tempfile::tempdir().map_err(|e| format!("scratch index: {e}"))?;
        let index = scratch.path().join("index");
        for ((inside, path, executable), blob) in files.iter().zip(blobs.iter()) {
            let mode = if file_mode {
                if *executable { "100755" } else { "100644" }
            } else {
                match recorded.get(path).map(String::as_str) {
                    Some("100755") => "100755",
                    _ => "100644",
                }
            };
            at_root.run(
                &["update-index", "--add", "--cacheinfo", &format!("{mode},{blob},{inside}")],
                None,
                Some(&index),
            )?;
        }
        at_root.run(&["write-tree", "--missing-ok"], None, Some(&index))
    }

    /// Whether the file system's executable bit is one git trusts here: not on
    /// Windows, and not where `core.fileMode` is false.
    pub fn file_mode_meaningful(&self) -> bool {
        !cfg!(windows)
            && self
                .run(&["config", "--bool", "core.fileMode"], None, None)
                .map_or(true, |v| v.trim() != "false")
    }

    /// Git's blob id for each working-tree file at `paths` (relative to `cwd`),
    /// hashed by git from its path so autocrlf, `.gitattributes` and clean
    /// filters apply as `git add` applies them. `write`: store the blobs too.
    ///
    /// `hash-object --stdin-paths` resolves each path from the repository's top
    /// level, whatever directory it runs in, so the paths get `cwd`'s prefix
    /// first: a workspace that is a subfolder of its repository works (review).
    pub fn hash_worktree_paths(&self, paths: &[String], write: bool) -> Result<Vec<String>, String> {
        let prefix = self.run(&["rev-parse", "--show-prefix"], None, None)?;
        let at_root = Plumbing { cwd: self.root()? };
        let list: String = paths.iter().map(|path| format!("{prefix}{path}\n")).collect();
        let mut args = vec!["hash-object"];
        if write {
            args.push("-w");
        }
        args.push("--stdin-paths");
        let out = at_root.run(&args, Some(list.as_bytes()), None)?;
        let blobs: Vec<String> = out.lines().map(str::to_string).collect();
        if blobs.len() != paths.len() {
            return Err(format!("hash-object answered {} ids for {} files", blobs.len(), paths.len()));
        }
        Ok(blobs)
    }

    /// Git's blob id for each file at `files` (absolute, or relative to `cwd`)
    /// exactly as its bytes are — no autocrlf, attributes or filters: the id a
    /// file Ply wrote from a blob has. Nothing is stored.
    pub fn hash_files_raw(&self, files: &[String]) -> Result<Vec<String>, String> {
        let list: String = files.iter().map(|file| format!("{file}\n")).collect();
        let out = self.run(&["hash-object", "--no-filters", "--stdin-paths"], Some(list.as_bytes()), None)?;
        let blobs: Vec<String> = out.lines().map(str::to_string).collect();
        if blobs.len() != files.len() {
            return Err(format!("hash-object answered {} ids for {} files", blobs.len(), files.len()));
        }
        Ok(blobs)
    }

    /// A blob's bytes by id.
    pub fn read_blob(&self, id: &str) -> Option<Vec<u8>> {
        let out = bounded_git(&mut self.command(&["cat-file", "blob", id]), None, LOCAL_GIT_TIMEOUT).ok()?;
        out.status.success().then_some(out.stdout)
    }

    /// `rev`'s subject line.
    pub fn subject(&self, rev: &str) -> Option<String> {
        self.run(&["log", "-1", "--format=%s", rev], None, None).ok()
    }

    /// The checkout's `HEAD` commit, `None` when unborn.
    pub fn head(&self) -> Option<String> {
        self.rev_parse_commit("HEAD")
    }

    /// SP-5 review: every blob `path` has had in the newest 50 commits
    /// reachable from `tip` that changed it — one `git log --raw`, not one
    /// `ls-tree` per commit.
    pub fn blobs_in_history(&self, tip: &str, path: &str) -> Vec<String> {
        let limit = HISTORY_LIMIT.to_string();
        let Ok(log) = self.run(
            &[
                "log",
                "-n",
                &limit,
                "--format=",
                "--raw",
                "--no-abbrev",
                "--no-renames",
                tip,
                "--",
                &format!(":(top){path}"),
            ],
            None,
            None,
        ) else {
            return Vec::new();
        };
        log.lines()
            .filter_map(|line| line.strip_prefix(':'))
            .filter_map(|line| line.split_whitespace().nth(3))
            .map(str::to_string)
            .collect()
    }

    /// `rev` as a full commit id, `None` when it names none.
    pub fn rev_parse_commit(&self, rev: &str) -> Option<String> {
        self.run(&["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")], None, None)
            .ok()
            .filter(|s| !s.is_empty())
    }

    /// SP-5: git can name the author and committer of a commit made here — a
    /// `user.name` and `user.email` it accepts, from any config level or the
    /// environment. `git var` fails exactly where `commit-tree` would.
    ///
    /// N14 item 8: a repository that publishes to GitHub commits as the
    /// publishing account when it can be read, which needs no git identity.
    pub fn has_identity(&self) -> bool {
        if !crate::commit_identity::args_for(&self.cwd).is_empty() {
            return true;
        }
        ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]
            .iter()
            .all(|var| self.run(&["var", var], None, None).is_ok())
    }

    /// `ancestor` is `descendant` or in its history.
    pub fn is_ancestor(&self, ancestor: &str, descendant: &str) -> bool {
        self.ancestry(ancestor, descendant) == Some(true)
    }

    /// teamfix round 2: `Some(true)` when `ancestor` is in `descendant`'s
    /// history, `Some(false)` when it isn't, `None` when git can't say.
    pub fn ancestry(&self, ancestor: &str, descendant: &str) -> Option<bool> {
        // Bounded, in its own process group and killed at exit (hard rule 4).
        let mut cmd = self.command(&["merge-base", "--is-ancestor", ancestor, descendant]);
        let out = bounded_git(&mut cmd, None, ANCESTRY_TIMEOUT).ok()?;
        match out.status.code() {
            Some(0) => Some(true),
            Some(1) => Some(false),
            _ => None,
        }
    }

    /// The last commit that touched `path` at `rev`.
    pub fn last_commit_of(&self, rev: &str, path: &str) -> Option<String> {
        self.run(&["log", "-1", "--format=%H", rev, "--", path], None, None)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    /// teamfix round 2: the commit a moved copy was moved from — the
    /// [`MOVED_FROM_TRAILER`] of `commit`.
    pub fn moved_from(&self, commit: &str) -> Option<String> {
        let format = format!("--format=%(trailers:key={MOVED_FROM_TRAILER},valueonly,separator=%x20)");
        self.run(&["log", "-1", &format, commit], None, None)
            .ok()
            .and_then(|s| s.split_whitespace().next().map(str::to_string))
    }

    /// The committer time of `commit` (seconds).
    pub fn committed_at(&self, commit: &str) -> Option<i64> {
        self.run(&["log", "-1", "--format=%ct", commit], None, None)
            .ok()
            .and_then(|s| s.trim().parse().ok())
    }

    /// `path` at `rev`, `None` when absent.
    pub fn read_at(&self, rev: &str, path: &str) -> Option<Vec<u8>> {
        let out = bounded_git(&mut self.command(&["cat-file", "blob", &format!("{rev}:{path}")]), None, LOCAL_GIT_TIMEOUT).ok()?;
        out.status.success().then_some(out.stdout)
    }

    /// The name commits made here are authored with — the identity Ply's card
    /// commits already use.
    pub fn user_name(&self) -> Option<String> {
        self.run(&["config", "user.name"], None, None)
            .ok()
            .filter(|s| !s.is_empty())
    }

    /// A commit on top of `parent` whose tree is `parent`'s with `changes`
    /// written. A scratch index in a private temp dir; the repository's own
    /// index and working tree are never read or written.
    pub fn commit_files(
        &self,
        parent: &str,
        changes: &[FileChange],
        message: &str,
    ) -> Result<String, String> {
        let changes: Vec<TreeChange> = changes
            .iter()
            .map(|change| TreeChange {
                path: change.path.clone(),
                content: Some((change.bytes.clone(), false)),
            })
            .collect();
        self.commit_tree_changes(parent, &changes, message)
    }

    /// [`Self::commit_files`] with removals and executable files (GH #82).
    ///
    /// N14 item 8: authored and committed as the GitHub account that
    /// publishes it ([`crate::commit_identity::args_for`]) when the repository
    /// publishes to GitHub; the global identity otherwise.
    pub fn commit_tree_changes(
        &self,
        parent: &str,
        changes: &[TreeChange],
        message: &str,
    ) -> Result<String, String> {
        let identity = crate::commit_identity::args_for(&self.cwd);
        self.commit_tree_changes_as(parent, changes, message, &identity)
    }

    /// [`Self::commit_tree_changes`] with the identity's `-c` arguments given
    /// (empty: the global identity).
    pub(crate) fn commit_tree_changes_as(
        &self,
        parent: &str,
        changes: &[TreeChange],
        message: &str,
        identity: &[String],
    ) -> Result<String, String> {
        for change in changes {
            check_path(&change.path)?;
        }
        if changes.is_empty() {
            return Err("nothing to commit".to_string());
        }
        // From the repository root: `update-index` takes paths relative to
        // where git runs, and a workspace may be a subdirectory of its repo.
        let root = self.root()?;
        let at_root = Plumbing { cwd: root };
        let scratch = tempfile::tempdir().map_err(|e| format!("scratch index: {e}"))?;
        let index = scratch.path().join("index");
        at_root.run(&["read-tree", parent], None, Some(&index))?;
        for change in changes {
            let Some((bytes, executable)) = &change.content else {
                at_root.run(
                    &["update-index", "--force-remove", "--", &change.path],
                    None,
                    Some(&index),
                )?;
                continue;
            };
            let blob = at_root.run(
                &["hash-object", "-w", "--stdin"],
                Some(bytes),
                Some(&index),
            )?;
            let mode = if *executable { "100755" } else { "100644" };
            at_root.run(
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("{mode},{blob},{}", change.path),
                ],
                None,
                Some(&index),
            )?;
        }
        let tree = at_root.run(&["write-tree"], None, Some(&index))?;
        // R8 Challenger M2: never signed (a signing prompt nobody sees would
        // hold the integration lock Land waits on), and bounded; the message
        // from a file, so no stdin is held open.
        let message_file = scratch.path().join("message");
        std::fs::write(&message_file, message).map_err(|e| format!("commit message: {e}"))?;
        let message_path = message_file.to_string_lossy().into_owned();
        let mut commit: Vec<&str> = identity.iter().map(String::as_str).collect();
        commit.extend(["commit-tree", "--no-gpg-sign", &tree, "-p", parent, "-F", &message_path]);
        let mut cmd = at_root.command(&commit);
        cmd.env("GIT_INDEX_FILE", &index);
        crate::worktrees::run_bounded(&mut cmd, "git commit-tree", COMMIT_TREE_TIMEOUT)
    }

    /// `git ls-tree [-r] --full-tree <rev> -- <path>`: entries from the
    /// repository root. Empty when the path is absent.
    pub fn ls_tree(&self, rev: &str, path: &str, recursive: bool) -> Vec<TreeEntry> {
        let mut args = vec!["ls-tree", "--full-tree", "-z"];
        if recursive {
            args.push("-r");
        }
        args.extend([rev, "--", path]);
        let Ok(out) = bounded_git(&mut self.command(&args), None, LOCAL_GIT_TIMEOUT) else {
            return Vec::new();
        };
        if !out.status.success() {
            return Vec::new();
        }
        String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .filter_map(|line| {
                let (meta, path) = line.split_once('\t')?;
                let mut parts = meta.split(' ');
                Some(TreeEntry {
                    mode: parts.next()?.to_string(),
                    kind: parts.next()?.to_string(),
                    sha: parts.next()?.to_string(),
                    path: path.to_string(),
                })
            })
            .collect()
    }

    /// The newest commit reachable from `tip` touching `path`: author and
    /// commit time (seconds).
    pub fn last_change(&self, tip: &str, path: &str) -> Option<(String, i64)> {
        self.history(tip, path)
            .into_iter()
            .next()
            .map(|(_, author, time)| (author, time))
    }

    /// `branch` exists on origin (`git ls-remote`, bounded and exit-registered).
    pub fn remote_branch_exists(&self, branch: &str) -> Result<bool, String> {
        self.remote_tip(branch).map(|tip| tip.is_some())
    }

    /// The commit `branch` ends in on origin right now, `None` when origin has
    /// no such branch (`git ls-remote`, bounded and exit-registered).
    pub(crate) fn remote_tip(&self, branch: &str) -> Result<Option<String>, String> {
        let mut cmd = crate::platform::git_command();
        // OB-7b: the workspace's chosen GitHub account (scope), helper first.
        crate::github_account::apply_to_network_git(&mut cmd, &self.cwd)?;
        cmd.args(["ls-remote", "--heads", "origin", &format!("refs/heads/{branch}")])
            .current_dir(&self.cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            // C4 round 2: its errors are sorted by their words, like a
            // fetch's and a push's: git says them in the one language read.
            .envs(crate::worktrees::FETCH_LOCALE.iter().copied());
        let out = crate::worktrees::run_bounded(&mut cmd, "git ls-remote origin", GH_TIMEOUT)?;
        Ok(out
            .lines()
            .filter_map(|line| line.split_whitespace().next())
            .find(|sha| !sha.is_empty())
            .map(str::to_string))
    }

    /// 1.175.0 (A5): origin's `branch` already ends in a commit with `sha`'s
    /// tree on `sha`'s parents — the same change, committed at another
    /// moment: that commit, `None` for any other tip (a tip this repository
    /// doesn't have is somebody else's commit). `Err` when origin didn't
    /// answer (round 3, S4): not "other commits" — a pull request that
    /// proposes this very change must not be closed and opened again because
    /// a read failed.
    pub(crate) fn remote_carries(&self, branch: &str, sha: &str) -> Result<Option<String>, String> {
        let Some(tip) = self.remote_tip(branch)? else {
            return Ok(None);
        };
        let shape = |rev: &str| {
            let tree = self
                .run(&["rev-parse", "--verify", "--quiet", &format!("{rev}^{{tree}}")], None, None)
                .ok()
                .filter(|s| !s.is_empty())?;
            // `<commit> <parent>…`: everything after the commit itself.
            let line = self.run(&["rev-list", "--parents", "-n", "1", rev], None, None).ok()?;
            let parents = line.split_whitespace().skip(1).collect::<Vec<_>>().join(" ");
            Some((tree, parents))
        };
        Ok(match (shape(&tip), shape(sha)) {
            (Some(theirs), Some(ours)) if theirs == ours => Some(tip),
            _ => None,
        })
    }

    /// The repository's top-level directory.
    fn root(&self) -> Result<PathBuf, String> {
        self.run(&["rev-parse", "--show-toplevel"], None, None)
            .map(PathBuf::from)
    }

    /// origin's GitHub repository, from its configured URL.
    pub fn github_repo(&self) -> Option<String> {
        let url = self
            .run(&["config", "--get", "remote.origin.url"], None, None)
            .ok()?;
        github_repo_of(&url)
    }

    /// `git push origin <sha>:refs/heads/<branch>` — the only push this
    /// channel and the library's make, and never a forced one (1.175.0, A5:
    /// no caller can hand it a refspec of its own).
    pub fn push(&self, sha: &str, branch: &str) -> PushResult {
        match crate::worktrees::push_origin(&self.cwd, &format!("{sha}:refs/heads/{branch}")) {
            Ok(()) => PushResult::Pushed,
            Err(e) => classify_push_error(&e),
        }
    }

    /// Commits touching `path` reachable from `tip`, newest first:
    /// (sha, author name, commit time in seconds).
    pub(crate) fn history(&self, tip: &str, path: &str) -> Vec<(String, String, i64)> {
        let limit = HISTORY_LIMIT.to_string();
        let Ok(log) = self.run(
            &[
                "log",
                "-n",
                &limit,
                "--format=%H%x00%an%x00%ct",
                tip,
                "--",
                &format!(":(top){path}"),
            ],
            None,
            None,
        ) else {
            return Vec::new();
        };
        log.lines()
            .filter_map(|line| {
                let mut parts = line.split('\0');
                let sha = parts.next()?.to_string();
                let author = parts.next()?.to_string();
                let time = parts.next()?.parse().ok()?;
                Some((sha, author, time))
            })
            .collect()
    }
}

// ── The GitHub CLI ────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrState {
    Open,
    Merged,
    Closed,
}

/// `gh`, resolved by the dependency doctor in the app; a fake script in tests.
pub struct Gh {
    pub path: String,
    pub timeout: std::time::Duration,
}

/// How long one `gh` call may take before it is killed.
pub const GH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

impl Gh {
    pub fn new(path: String) -> Self {
        Self {
            path,
            timeout: GH_TIMEOUT,
        }
    }
}

impl Gh {
    /// Bounded by [`GH_TIMEOUT`] and killed on app exit, like a fetch: a
    /// stalled `gh` must not hold the definition or integration lock.
    fn run(&self, cwd: &Path, args: &[&str]) -> Result<String, String> {
        let mut cmd = crate::platform::new_command(&self.path);
        // OB-7b: the workspace's chosen GitHub account (scope).
        crate::github_account::apply_to_gh(&mut cmd)?;
        cmd.args(args)
            .current_dir(cwd)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GIT_TERMINAL_PROMPT", "0");
        let label = format!("gh {}", args.iter().take(2).copied().collect::<Vec<_>>().join(" "));
        crate::worktrees::run_bounded(&mut cmd, &label, self.timeout)
    }

    /// Round 3 (S4): [`Self::run`] with `body` on gh's stdin (`--body-file
    /// -`), as Ship's pull requests go (R12) — never an argument.
    fn run_with_body(&self, cwd: &Path, args: &[&str], body: &str) -> Result<String, String> {
        use crate::worktrees::BoundedFailure;
        use std::io::{Seek, Write};
        let label = format!("gh {}", args.iter().take(2).copied().collect::<Vec<_>>().join(" "));
        let mut file = tempfile::tempfile().map_err(|e| format!("{label}: {e}"))?;
        file.write_all(body.as_bytes()).and_then(|()| file.rewind()).map_err(|e| format!("{label}: {e}"))?;
        let mut cmd = crate::platform::new_command(&self.path);
        crate::github_account::apply_to_gh(&mut cmd)?;
        cmd.args(args)
            .current_dir(cwd)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GIT_TERMINAL_PROMPT", "0");
        let out = crate::worktrees::run_bounded_output_with_stdin(&mut cmd, self.timeout, file).map_err(|failure| {
            match failure {
                BoundedFailure::Spawn(e) => format!("{label}: {e}"),
                BoundedFailure::Quitting => format!("{label}: Plyloft is quitting"),
                BoundedFailure::TimedOut => format!("{label} timed out after {:.1}s", self.timeout.as_secs_f32()),
                BoundedFailure::Truncated => {
                    format!("{label}: its output was still open after it exited, so its answer may be incomplete")
                }
            }
        })?;
        if !out.status.success() {
            return Err(format!("{label} failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// Open a PR on `repo` (origin's GitHub repository, never gh's default);
    /// its URL. Like Ship's PR path, an existing PR for the branch is linked
    /// instead.
    pub fn pr_create(
        &self,
        cwd: &Path,
        repo: &str,
        base: &str,
        head: &str,
        title: &str,
        body: &str,
    ) -> Result<String, String> {
        match self.run_with_body(
            cwd,
            &["pr", "create", "--repo", repo, "--base", base, "--head", head, "--title", title, "--body-file", "-"],
            body,
        ) {
            Ok(out) => Ok(out
                .lines()
                .rev()
                .find(|l| l.contains("/pull/"))
                .unwrap_or(out.as_str())
                .trim()
                .to_string()),
            Err(e) if e.to_lowercase().contains("already exists") => self
                .pr_for_branch(cwd, repo, head)?
                .map(|found| found.url)
                .ok_or(e),
            Err(e) => Err(e),
        }
    }

    /// The newest PR from `head` on `repo`, in any state, with its state;
    /// `None` when there is none. How a retry finds the PR an interrupted
    /// attempt opened.
    pub fn pr_for_branch(
        &self,
        cwd: &Path,
        repo: &str,
        head: &str,
    ) -> Result<Option<FoundPr>, String> {
        let out = self.run(
            cwd,
            &[
                "pr", "list", "--repo", repo, "--head", head, "--state", "all", "--json",
                "url,state,baseRefName,isCrossRepository", "--jq",
                // Round 3 (S4): `--head` matches a fork's branch of the same
                // name too, and what is found here may be closed — only a
                // pull request from this repository's own branch counts.
                "[.[] | select(.isCrossRepository | not)] | .[0] | select(. != null) | .url + \" \" + .state + \" \" + .baseRefName",
            ],
        )?;
        let Some(line) = out.lines().map(str::trim).find(|l| l.contains("/pull/")) else {
            return Ok(None);
        };
        let mut parts = line.split_whitespace();
        let url = parts.next().unwrap_or_default().to_string();
        let state = match parts.next().unwrap_or_default() {
            "MERGED" => PrState::Merged,
            "CLOSED" => PrState::Closed,
            _ => PrState::Open,
        };
        let base = parts.next().map(str::to_string);
        Ok(Some(FoundPr { url, state, base }))
    }

    /// Close a PR Ply withdraws. Its branch stays: a replacement may reuse it.
    pub fn pr_close(&self, cwd: &Path, repo: &str, number: u64) -> Result<(), String> {
        self.pr_close_saying(
            cwd,
            repo,
            number,
            "Withdrawn by Plyloft: the shared setting this proposed was changed again or reverted.",
        )
    }

    /// [`Self::pr_close`] with the comment given — the sentence GitHub shows
    /// must be true of why it is closed (1.175.0, C1 round 5).
    pub fn pr_close_saying(&self, cwd: &Path, repo: &str, number: u64, comment: &str) -> Result<(), String> {
        self.run(cwd, &["pr", "close", &number.to_string(), "--repo", repo, "--comment", comment]).map(|_| ())
    }

    /// 1.175.0 (C1 round 5): a pull request's state, its head branch and
    /// whether that branch is in another repository — one bounded read.
    pub fn pr_head(&self, cwd: &Path, repo: &str, number: u64) -> Result<(PrState, String, bool), String> {
        let json = self.run(
            cwd,
            &["pr", "view", &number.to_string(), "--repo", repo, "--json", "headRefName,isCrossRepository,state"],
        )?;
        let value: Value =
            serde_json::from_str(json.trim()).map_err(|e| format!("gh pr view printed no JSON: {e}"))?;
        let state = match value.get("state").and_then(Value::as_str) {
            Some("MERGED") => PrState::Merged,
            Some("CLOSED") => PrState::Closed,
            Some("OPEN") => PrState::Open,
            other => return Err(format!("unexpected pull request state {other:?}")),
        };
        let head = value.get("headRefName").and_then(Value::as_str).unwrap_or_default().to_string();
        let cross = value.get("isCrossRepository").and_then(Value::as_bool).unwrap_or(true);
        Ok((state, head, cross))
    }

    /// Bring an open PR's title and body up to what it now carries.
    pub fn pr_edit(
        &self,
        cwd: &Path,
        repo: &str,
        number: u64,
        title: &str,
        body: &str,
    ) -> Result<(), String> {
        self.run_with_body(
            cwd,
            &["pr", "edit", &number.to_string(), "--repo", repo, "--title", title, "--body-file", "-"],
            body,
        )
        .map(|_| ())
    }

    /// 1.175.0 (C5): the name GitHub gives `branch` now — it answers a
    /// renamed branch's old name with the new one. A read.
    pub fn branch_name(&self, cwd: &Path, repo: &str, branch: &str) -> Result<String, String> {
        let name = self.run(cwd, &["api", &format!("repos/{repo}/branches/{branch}"), "--jq", ".name"])?;
        Ok(name.trim().to_string())
    }

    /// GH #82: `permissions.push` of `repo` for the signed-in account
    /// (`gh api repos/<owner>/<repo>`).
    pub fn can_push(&self, cwd: &Path, repo: &str) -> Result<bool, String> {
        let parts: Vec<&str> = repo.split('/').collect();
        let (host, path) = match parts.as_slice() {
            [owner, name] => (None, format!("repos/{owner}/{name}")),
            [host, owner, name] => (Some(*host), format!("repos/{owner}/{name}")),
            _ => return Err(format!("not a GitHub repository: {repo}")),
        };
        let mut args = vec!["api"];
        if let Some(host) = host {
            args.extend(["--hostname", host]);
        }
        args.extend([path.as_str(), "--jq", ".permissions.push"]);
        match self.run(cwd, &args)?.trim() {
            "true" => Ok(true),
            "false" => Ok(false),
            other => Err(format!("gh api {path}: no push permission in the answer ({other:?})")),
        }
    }

    pub fn pr_state(&self, cwd: &Path, repo: &str, number: u64) -> Result<PrState, String> {
        let state = self.run(
            cwd,
            &[
                "pr", "view", &number.to_string(), "--repo", repo, "--json", "state", "--jq",
                ".state",
            ],
        )?;
        match state.trim() {
            "MERGED" => Ok(PrState::Merged),
            "CLOSED" => Ok(PrState::Closed),
            "OPEN" => Ok(PrState::Open),
            other => Err(format!("unexpected pull request state {other:?}")),
        }
    }
}

/// `origin`'s URL as the `[HOST/]OWNER/REPO` gh's `--repo` takes: scp-like
/// (`git@github.com:o/r.git`), `ssh://` and `https://` forms. `None` for
/// anything else (a local path).
pub fn github_repo_of(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    let (host, path) = if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .or_else(|| url.strip_prefix("ssh://"))
    {
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        (host.split(':').next()?, path)
    } else if let Some((user_host, path)) = url.split_once(':') {
        let host = user_host.rsplit_once('@').map_or(user_host, |(_, h)| h);
        if host.is_empty() || host.contains('/') {
            return None;
        }
        (host, path)
    } else {
        return None;
    };
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    let [owner, name] = parts.as_slice() else {
        return None;
    };
    if host.is_empty() {
        return None;
    }
    Some(if host.eq_ignore_ascii_case("github.com") {
        format!("{owner}/{name}")
    } else {
        format!("{host}/{owner}/{name}")
    })
}

/// A PR `gh pr list --head` found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundPr {
    pub url: String,
    pub state: PrState,
    /// The branch it merges into.
    pub base: Option<String>,
}

/// `https://github.com/o/r/pull/12` → 12.
pub fn pr_number(url: &str) -> Option<u64> {
    url.trim_end_matches('/').rsplit('/').next()?.parse().ok()
}

// ── The queue ─────────────────────────────────────────────────────────

/// The pull request a refused publish opened.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub branch: String,
    /// Round 5 (V2): the commit Plyloft left at the end of `branch` when it
    /// opened (or last linked) this pull request. A branch that ends
    /// elsewhere later holds a commit Plyloft didn't put there. Absent in
    /// queues written before, and then nothing is known of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
}

/// One shared field waiting to reach the integration branch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueuedField {
    /// The value to publish, as the definition file writes it (`null` =
    /// removed).
    pub value: Value,
    /// The repository's value when the edit was made: upstream differing from
    /// it at publish time means someone else changed the field since.
    #[serde(default)]
    pub base: Value,
    #[serde(default)]
    pub base_commit: Option<String>,
    #[serde(default)]
    pub queued_at: i64,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub last_error: Option<String>,
    /// Set while the change waits in a pull request.
    #[serde(default)]
    pub pull_request: Option<PullRequest>,
    /// 1.173.0 (C3): the branch's value changed since this edit was made, and
    /// the person hasn't said which to keep. The field isn't published while
    /// this is set; every other field is. Absent in queues written before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<FieldConflict>,
    /// 1.173.0 (C3): *Use this Mac's* — the branch's value the person chose to
    /// replace. Published over that value only; a value that moved on again
    /// asks again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_mine: Option<UseMine>,
    /// 1.173.0 (C3 Challenger 2): the values this Mac proposed for the field
    /// in its own pull requests. The branch holding one of them is this
    /// Mac's change landing, never someone else's. Absent in queues written
    /// before.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proposed: Vec<Proposed>,
}

/// 1.173.0 (C3): a value this Mac proposed in one of its pull requests. A
/// pull request closed without merging forgets it: its value on the branch
/// is then someone else's.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Proposed {
    #[serde(default)]
    pub value: Value,
    pub pull_request: u64,
}

impl QueuedField {
    /// The value this edit is measured against: the branch's when it holds a
    /// value this Mac proposed in a pull request that merged, else `base`.
    pub fn base_against(&self, upstream: &Value) -> Value {
        if self.proposed.iter().any(|p| p.value == *upstream) {
            upstream.clone()
        } else {
            self.base.clone()
        }
    }
}

/// 1.173.0 (C3): someone else's value of a field this Mac also changed — met
/// on the branch at publish time, waiting for the person's choice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldConflict {
    /// The branch's value, as the definition file writes it.
    pub theirs: Value,
    /// Who last changed it there (the commit's author).
    #[serde(default)]
    pub author: Option<String>,
    /// The computer that published it, from the commit's
    /// [`DEVICE_TRAILER`] (Plyloft's own config commits since 1.173.0).
    #[serde(default)]
    pub device: Option<String>,
    /// The author is the person publishing from here (the same name): "your
    /// MacBook Pro", not a teammate.
    #[serde(default)]
    pub same_person: bool,
    /// Commit time, seconds.
    #[serde(default)]
    pub changed_at: Option<i64>,
    /// The tip it was read at.
    #[serde(default)]
    pub tip: Option<String>,
    /// 1.173.0 (C3 Challenger 2): the commit came from this very computer
    /// (another folder of the same repository): it is said so, never "your
    /// <this Mac>".
    #[serde(default)]
    pub this_computer: bool,
    /// 1.173.0 (C3 Challenger 4): for a field merged key by key (`models`),
    /// what *Use this Mac's* would publish — this Mac's keys over theirs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged: Option<UseMine>,
}

/// 1.173.0 (C3): the person chose this Mac's value over `over`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UseMine {
    pub over: Value,
}

/// 1.173.0 (C3): the trailer naming the computer a shared-config commit came
/// from, so the other computer can say "Your MacBook Pro changed …".
pub const DEVICE_TRAILER: &str = "Plyloft-Device";

/// `projects/<workspace_id>/shared_config_queue.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublishQueue {
    pub schema_version: u32,
    /// "Publish .atelier/workspace.json": the definition goes onto the branch
    /// even with no field edited (a converted legacy file).
    #[serde(default)]
    pub create_definition: bool,
    #[serde(default)]
    pub fields: BTreeMap<String, QueuedField>,
    /// Why the last publish attempt didn't reach the branch.
    #[serde(default)]
    pub last_error: Option<String>,
    /// Card #94: that attempt failed because the remote could not be
    /// reached. A page opened later has no refresh report to read, and
    /// "you're offline" is a different thing to say from "it didn't land".
    /// Absent in queues written before this field.
    #[serde(default)]
    pub last_offline: bool,
    /// 1.175.0 (C4 round 2): this computer's creation pull request that
    /// another computer's share made unneeded and Plyloft couldn't close
    /// (GitHub refused) or no longer follows (not ours in this repository
    /// now) — named on the page until a later publish lands. Absent in
    /// queues written before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_first_left: Option<crate::workspace_definition::SharedFirst>,
    /// 1.175.0 (C4, SC-7): what kind of trouble `last_error` is. Absent in
    /// queues written before (read as "other", or "offline" with
    /// `last_offline`), and while nothing failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_kind: Option<PublishTrouble>,
    /// The pull request that carries the file's creation, while it waits.
    /// Tracked here because a creation with no field edited has no field
    /// entry to carry it.
    #[serde(default)]
    pub create_pull_request: Option<PullRequest>,
    /// Two-instance walk (C4): GitHub said, at the last read that asked,
    /// that `create_pull_request` (this number) is open. The page says
    /// "shared first … isn't needed" only then — never for this computer's
    /// own pull request that merged. Absent in queues written before, and
    /// until a read asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_open: Option<u64>,
    /// The fallback branch for the change being published, fixed before the
    /// first attempt and kept until a publish or a pull request settles it.
    #[serde(default)]
    pub pull_request_branch: Option<String>,
    /// Pull requests that no longer propose what is queued (a field in them
    /// was edited again or reverted), to close once their replacement is on
    /// the branch — or at once when nothing is left to propose.
    #[serde(default)]
    pub superseded_pull_requests: Vec<PullRequest>,
    /// 1.175.0 (C1): *Stop sharing*'s fallback branch, fixed before the
    /// first attempt (`stop_sharing::stop`). Absent in queues written before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removal_branch: Option<String>,
    /// 1.175.0 (C1): the pull request that removes the shared setup, while
    /// it waits — the setup stays shared until it merges. Absent in queues
    /// written before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removal_pull_request: Option<PullRequest>,
}

impl Default for PublishQueue {
    fn default() -> Self {
        Self {
            schema_version: QUEUE_SCHEMA_VERSION,
            create_definition: false,
            fields: BTreeMap::new(),
            last_error: None,
            last_offline: false,
            last_error_kind: None,
            shared_first_left: None,
            create_pull_request: None,
            creation_open: None,
            pull_request_branch: None,
            superseded_pull_requests: Vec::new(),
            removal_branch: None,
            removal_pull_request: None,
        }
    }
}

impl PublishQueue {
    pub fn is_empty(&self) -> bool {
        !self.create_definition
            && self.create_pull_request.is_none()
            && self.fields.is_empty()
            && self.superseded_pull_requests.is_empty()
            && self.pull_request_branch.is_none()
    }
}

pub fn queue_path(project_configs: &ProjectConfigStore, workspace_id: &str) -> PathBuf {
    project_configs
        .workspace_dir(workspace_id)
        .join(QUEUE_FILENAME)
}

/// A missing queue is empty. An unparsable one is kept aside (never silently
/// dropped) and read as empty; the pending fields in the definition cache
/// re-enqueue themselves on the next drain.
pub fn load_queue(project_configs: &ProjectConfigStore, workspace_id: &str) -> PublishQueue {
    let path = queue_path(project_configs, workspace_id);
    let Ok(bytes) = std::fs::read(&path) else {
        return PublishQueue::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(queue) => queue,
        Err(e) => {
            log::warn!("shared_config: unreadable queue for {workspace_id}: {e}");
            let aside = path.with_extension(format!("json.broken-{}", now_millis()));
            let _ = std::fs::rename(&path, aside);
            PublishQueue::default()
        }
    }
}

/// Atomic; an empty queue removes the file.
pub fn save_queue(
    project_configs: &ProjectConfigStore,
    workspace_id: &str,
    queue: &PublishQueue,
) -> Result<(), String> {
    let path = queue_path(project_configs, workspace_id);
    // 1.175.0 (C1): a removal that waits is no publish to drain
    // (`is_empty` stays what the drain asks), but it is something to keep.
    if queue.is_empty()
        && queue.removal_branch.is_none()
        && queue.removal_pull_request.is_none()
        && queue.shared_first_left.is_none()
    {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove {path:?}: {e}")),
        };
    }
    crate::atomic::write_atomic_json(&path, queue)
}

pub(crate) fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Publishing the definition ─────────────────────────────────────────

/// Someone else's value this publish replaced.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Override {
    pub field: String,
    pub author: Option<String>,
    /// Commit time, seconds.
    pub changed_at: Option<i64>,
}

/// What a publish is asked to put on the branch.
pub struct PublishRequest<'a> {
    pub branch: &'a str,
    pub default_branch: &'a str,
    /// Fields to publish (none waiting in a pull request).
    pub fields: &'a BTreeMap<String, QueuedField>,
    /// Written whole when the branch has no `.atelier/workspace.json` yet:
    /// a converted legacy definition, or the last good copy.
    pub create_from: Option<&'a WorkspaceDefinition>,
    /// Seconds, for "2 min ago".
    pub now_secs: i64,
    /// The fallback branch, chosen once per queued change and saved before
    /// the first attempt, so a retry after an interrupted PR creation finds
    /// the PR it may have opened instead of opening another.
    pub pull_request_branch: &'a str,
    /// The project config this Mac runs with, for a project edit onto a tip
    /// without a project part.
    pub project_fill: Option<&'a WorkspaceDefinition>,
    /// 1.173.0 (C3): this computer's name, written as the commit's
    /// [`DEVICE_TRAILER`]; `None` writes none.
    pub device: Option<&'a str>,
    /// Round 3 (S4): the pull requests this publish supersedes (a setting in
    /// them was edited again). A pull request opened for it says which.
    pub replaces: &'a [PullRequest],
    /// Two-instance walk (C3, owner 2026-11-10): "Cards go to" changed and the
    /// setup follows to that branch carrying the current values —
    /// `create_from` is written whole even where the branch has an older
    /// copy, which it replaces in one commit (no field is asked about: the
    /// person moved it).
    pub replace_whole: bool,
    /// teamfix round 2: with `replace_whole`, the commit of the copy moved —
    /// written as the [`MOVED_FROM_TRAILER`], and what an existing copy
    /// there is judged older than.
    pub moved_from: Option<&'a str>,
    /// teamfix round 2: a refused push fails; no pull request is opened.
    pub no_pull_request: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PublishOutcome {
    /// The branch now carries the fields: pushed as `commit`, or already
    /// there (`commit` is then the tip).
    Published {
        commit: String,
        definition: WorkspaceDefinition,
        author: Option<String>,
        fields: Vec<String>,
        overrides: Vec<Override>,
        pushed: bool,
        /// 1.173.0 (C3): fields left out because the branch's value changed
        /// since the edit, keyed like the file. Not in `fields`.
        conflicts: BTreeMap<String, FieldConflict>,
    },
    /// The push was refused; the change waits in this pull request.
    PullRequest {
        pull_request: PullRequest,
        fields: Vec<String>,
        /// 1.173.0 (C3): as for `Published`; not in the pull request.
        conflicts: BTreeMap<String, FieldConflict>,
    },
    /// Offline or the remote didn't answer: keep it queued.
    Unreachable(String),
    /// Something to fix first (unreadable file on the branch, no git
    /// identity, no GitHub CLI for the fallback). Kept queued.
    Failed(String),
}

/// A commit prepared on top of the fetched tip.
struct Prepared {
    tip: String,
    /// `None`: the tip already carries every field.
    commit: Option<String>,
    definition: WorkspaceDefinition,
    fields: Vec<String>,
    overrides: Vec<Override>,
    message: String,
    /// The paths the commit changes.
    paths: Vec<String>,
    /// 1.173.0 (C3): fields held for the person's choice.
    conflicts: BTreeMap<String, FieldConflict>,
}

/// One item of a list field in words: an area by its name, a version file
/// or verify step by its path, a skill by `/name`.
pub(crate) fn describe_item(item: &Value) -> String {
    match item {
        // 1.173.0 (B1): an area by its name (its path may be "").
        Value::Object(map) if map.get("id").is_some_and(Value::is_string) && map.get("name").is_some_and(Value::is_string) => {
            let name = map["name"].as_str().unwrap_or_default().trim();
            if name.is_empty() { map["id"].as_str().unwrap_or_default().to_string() } else { name.to_string() }
        }
        // C3 Challenger 6: a review checklist class by its name, as the
        // toasts say it (definitionRefresh.ts), never as a slash command.
        Value::Object(map) if map.contains_key("sentence") && map.get("name").is_some_and(Value::is_string) => {
            map["name"].as_str().unwrap_or_default().to_string()
        }
        Value::Object(map) => match (map.get("path"), map.get("name")) {
            (Some(Value::String(path)), _) => path.clone(),
            (_, Some(Value::String(name))) => format!("/{}", name.trim_start_matches('/')),
            _ => item.to_string(),
        },
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

pub(crate) fn describe(value: &Value) -> String {
    let text = match value {
        Value::Null => "none".to_string(),
        Value::String(s) => s.clone(),
        Value::Array(items) if items.is_empty() => "none".to_string(),
        Value::Array(items) => items.iter().map(describe_item).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    };
    let text = text.replace('\n', " ");
    if text.chars().count() > 80 {
        format!("{}…", text.chars().take(79).collect::<String>())
    } else {
        text
    }
}

/// "just now", "2 min ago", "3 h ago", "1 day ago".
pub fn ago(now_secs: i64, then_secs: i64) -> String {
    let secs = (now_secs - then_secs).max(0);
    match secs {
        0..=59 => "just now".to_string(),
        60..=3599 => format!("{} min ago", secs / 60),
        3600..=86_399 => format!("{} h ago", secs / 3600),
        _ => {
            let days = secs / 86_400;
            format!("{days} day{} ago", if days == 1 { "" } else { "s" })
        }
    }
}

/// The commit message: one `config: <field> — <old> → <new>` line per field.
/// A2 (Challenger 2): a three-way merge of `models` — `base` (the value this
/// edit was made on), `upstream` (the branch now) and `mine` — per vendor and
/// key: a key this edit didn't change takes the branch's, a key only this edit
/// changed takes this edit's, and a key both changed differently takes this
/// edit's and reports a clash (named as an override). Unknown keys merge the
/// same way; a vendor value that isn't an object is one opaque value
/// (Challenger 14a). With no `base` at all (an item queued without one,
/// Challenger 14b) nothing it holds is known to be an edit: the branch's
/// keys stay as they are and only keys the branch lacks are added. Nothing
/// left is `null` (the key removed).
pub(crate) fn merge_models(base: &Value, upstream: &Value, mine: &Value) -> (Value, bool) {
    merge_models_with(base, upstream, mine, false)
}

/// 1.173.0 (C3 Challenger 4): [`merge_models`] where a key both sides
/// changed differently takes the branch's — *Keep theirs*, which keeps this
/// Mac's other suggestions.
pub(crate) fn merge_models_keeping_theirs(base: &Value, upstream: &Value, mine: &Value) -> Value {
    merge_models_with(base, upstream, mine, true).0
}

fn merge_models_with(base: &Value, upstream: &Value, mine: &Value, theirs_on_clash: bool) -> (Value, bool) {
    fn object(v: &Value) -> serde_json::Map<String, Value> {
        v.as_object().cloned().unwrap_or_default()
    }
    fn three(b: Option<&Value>, u: Option<&Value>, m: Option<&Value>, legacy: bool, clash: &mut (bool, bool)) -> Option<Value> {
        if legacy {
            return u.or(m).cloned();
        }
        if m == b {
            return u.cloned();
        }
        if u != b && u != m {
            clash.0 = true;
            if clash.1 {
                return u.cloned();
            }
        }
        m.cloned()
    }
    fn merge(b: &Value, u: &Value, m: &Value, nested: bool, legacy: bool, clash: &mut (bool, bool)) -> Value {
        let (b, u, m) = (object(b), object(u), object(m));
        let mut keys: Vec<&String> = b.keys().chain(u.keys()).chain(m.keys()).collect();
        keys.sort();
        keys.dedup();
        let mut out = serde_json::Map::new();
        for key in keys {
            let is_object_or_absent = |v: Option<&Value>| v.is_none_or(|v| v.is_object());
            let vendor = nested
                && (key == "claude" || key == "codex")
                && is_object_or_absent(b.get(key))
                && is_object_or_absent(u.get(key))
                && is_object_or_absent(m.get(key));
            let value = if vendor {
                let null = Value::Null;
                let merged = merge(
                    b.get(key).unwrap_or(&null),
                    u.get(key).unwrap_or(&null),
                    m.get(key).unwrap_or(&null),
                    false,
                    legacy,
                    clash,
                );
                merged.as_object().filter(|o| !o.is_empty()).map(|_| merged.clone())
            } else {
                three(b.get(key), u.get(key), m.get(key), legacy, clash)
            };
            if let Some(value) = value.filter(|v| !v.is_null()) {
                out.insert(key.clone(), value);
            }
        }
        Value::Object(out)
    }
    let legacy = base.is_null() && !upstream.is_null();
    let mut clash = (false, theirs_on_clash);
    let merged = merge(base, upstream, mine, true, legacy, &mut clash);
    let merged = if merged.as_object().is_some_and(|o| o.is_empty()) { Value::Null } else { merged };
    (merged, clash.0)
}

fn message_line(key: &str, old: &Value, new: &Value, over: Option<&Override>, now: i64) -> String {
    // 1.173.0 (B1): the same areas on both sides — say which changed.
    let what = match (key, crate::areas::change_words(old, new)) {
        ("areas", Some(changed)) => changed,
        _ => format!("{} → {}", describe(old), describe(new)),
    };
    // 1.174.0 (DS2 round 1): the row's name in quotes ("“Cards go to” —
    // main → staging"); `lower_first` leaves a quoted name as it is, and so
    // does its TS twin (`repositoryPage.ts::commitMessage`).
    let mut line = crate::commit_message::config_line(&format!("“{}” — {what}", field_label(key)));
    if let Some(over) = over {
        let who = over
            .author
            .as_deref()
            .map(|a| format!("{a}'s"))
            .unwrap_or_else(|| "another".to_string());
        match over.changed_at {
            Some(at) => line.push_str(&format!(" (overrides {who} value from {})", ago(now, at))),
            None => line.push_str(&format!(" (overrides {who} value)")),
        }
    }
    line
}

/// Who last changed `key` on the branch, looking back from `tip`.
fn last_change_of(
    git: &Plumbing,
    tip: &str,
    key: &str,
    default_branch: &str,
) -> Option<(String, i64)> {
    last_commit_of(git, tip, key, default_branch).map(|(_, author, time)| (author, time))
}

/// [`last_change_of`] with the commit: (sha, author, time).
fn last_commit_of(
    git: &Plumbing,
    tip: &str,
    key: &str,
    default_branch: &str,
) -> Option<(String, String, i64)> {
    let value_at = |rev: &str| -> Value {
        git.read_at(rev, DEFINITION_PATH)
            .and_then(|bytes| parse_definition(&bytes).ok())
            .map(|def| field_value(&to_map(&def.normalized(default_branch)), key))
            .unwrap_or(Value::Null)
    };
    git.history(tip, DEFINITION_PATH)
        .into_iter()
        .find(|(sha, _, _)| value_at(sha) != value_at(&format!("{sha}^")))
}

/// 1.173.0 (C3): the computer a commit's [`DEVICE_TRAILER`] names, if any.
pub(crate) fn device_in_message(message: &str) -> Option<String> {
    let prefix = format!("{DEVICE_TRAILER}:");
    message
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix(prefix.as_str()).map(str::trim))
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// 1.173.0 (C3): the names this computer commits under here — the
/// publishing GitHub account's, and git's own `user.name`.
pub(crate) fn my_names(git: &Plumbing) -> Vec<String> {
    let mut names: Vec<String> = crate::commit_identity::args_for(&git.cwd)
        .iter()
        .filter_map(|arg| arg.strip_prefix("user.name=").map(str::to_string))
        .collect();
    names.extend(git.user_name());
    names
}

/// 1.173.0 (C3): what this Mac knows of the value `upstream` it would
/// replace — who, from which computer, when.
fn conflict_of(
    git: &Plumbing,
    tip: &str,
    key: &str,
    upstream: &Value,
    default_branch: &str,
    this_device: Option<&str>,
) -> FieldConflict {
    let found = last_commit_of(git, tip, key, default_branch);
    let device = found
        .as_ref()
        .and_then(|(sha, _, _)| git.run(&["log", "-1", "--format=%B", sha], None, None).ok())
        .and_then(|message| device_in_message(&message));
    let author = found.as_ref().map(|(_, a, _)| a.clone());
    let same_person = author
        .as_deref()
        .is_some_and(|a| my_names(git).iter().any(|n| n.eq_ignore_ascii_case(a)));
    let this_computer = same_person
        && device.as_deref().zip(this_device).is_some_and(|(theirs, mine)| theirs.trim() == mine.trim());
    FieldConflict {
        theirs: upstream.clone(),
        author,
        device,
        same_person,
        changed_at: found.map(|(_, _, t)| t),
        tip: Some(tip.to_string()),
        this_computer,
        merged: None,
    }
}

fn prepare(git: &Plumbing, req: &PublishRequest<'_>) -> Result<Prepared, PublishOutcome> {
    let tip = git.tip(req.branch).ok_or_else(|| {
        PublishOutcome::Failed(format!("origin has no branch {} to publish to", req.branch))
    })?;
    // 1.175.0 (C6, SC-9): the branch's own bytes, so what they hold that
    // this build's types don't know is written back (`file_text`).
    let written = git.read_at(&tip, DEFINITION_PATH);
    let replacing = req.replace_whole && written.is_some() && req.create_from.is_some();
    // teamfix round 2: only a copy older than the one moved is replaced.
    if replacing {
        let there = git.last_commit_of(&tip, DEFINITION_PATH);
        let older = match (there.as_deref(), req.moved_from) {
            (Some(there), Some(source)) => copy_is_older(
                there,
                source,
                &|a, b| git.ancestry(a, b),
                &|c| git.moved_from(c),
                &|c| git.committed_at(c),
            ),
            _ => None,
        };
        if older != Some(true) {
            return Err(PublishOutcome::Failed(format!("{} {NEWER_COPY_MARKER}", req.branch)));
        }
    }
    let (raw, created) = if replacing {
        (req.create_from.cloned().ok_or_else(|| PublishOutcome::Failed("nothing to move".into()))?, true)
    } else {
        match &written {
        Some(bytes) => (
            parse_definition(bytes).map_err(|bad| {
                // A value a later Plyloft added is not something to fix
                // there: this computer needs the update. Round 2: the value
                // serde named goes to the log.
                log::warn!("shared_config: not publishing over {DEFINITION_PATH} on {}: {}", req.branch, bad.message);
                PublishOutcome::Failed(bad.newer_sentence(req.branch, true).unwrap_or_else(|| {
                    format!(
                        "{DEFINITION_PATH} on {} is {} ({}); fix it there first",
                        req.branch,
                        bad.summary(),
                        bad.message
                    )
                }))
            })?,
            false,
        ),
        None => (
            req.create_from.cloned().ok_or_else(|| {
                PublishOutcome::Failed(format!(
                    "{} has no {DEFINITION_PATH} to change",
                    req.branch
                ))
            })?,
            true,
        ),
        }
    };
    let tip_map = to_map(&raw.normalized(req.default_branch));
    let mut applied = BTreeMap::new();
    let mut lines = Vec::new();
    let mut overrides = Vec::new();
    let mut conflicts = BTreeMap::new();
    if replacing {
        lines.push(crate::commit_message::config_line(&format!(
            "Workspace definition — moved here, with the current values ({DEFINITION_PATH})"
        )));
    } else if created {
        lines.push(crate::commit_message::config_line(&format!(
            "Workspace definition — none → {DEFINITION_PATH}"
        )));
    }
    for (key, field) in req.fields {
        let upstream = field_value(&tip_map, key);
        // 1.169.0 (A2): `models` is merged per vendor and key, so two people
        // changing different suggestions both land; only the same key changed
        // on both sides is an override (the rule below).
        // 1.173.0 (C3 Challenger 2): a value this Mac proposed in a pull
        // request that merged is this Mac's own change, not theirs.
        let base = field.base_against(&upstream);
        let (value, changed_since) = if key == "models" && !created {
            merge_models(&base, &upstream, &field.value)
        } else {
            (field.value.clone(), upstream != base)
        };
        if upstream == value && !created {
            continue;
        }
        // 1.173.0 (C3): someone changed this field since the value was read.
        // It waits for the person's choice — every other field still goes —
        // unless they already chose this Mac's over exactly this value.
        let chosen = field.use_mine.as_ref().is_some_and(|c| c.over == upstream);
        // 1.173.0 (B1 × C3): areas on the branch that break the rules are
        // held on every Mac and never applied: not a value to ask about. A
        // valid list from here replaces them, the override named.
        let held_areas = key == "areas" && raw.areas.as_ref().and_then(|a| a.problem()).is_some();
        if !created && changed_since && !chosen && !held_areas {
            let mut conflict = conflict_of(git, &tip, key, &upstream, req.default_branch, req.device);
            if key == "models" {
                conflict.merged = Some(UseMine { over: value.clone() });
            }
            conflicts.insert(key.clone(), conflict);
            continue;
        }
        // Chosen: this value goes in, and the one it replaced is named.
        let over = (!created && changed_since).then(|| {
            let found = last_change_of(git, &tip, key, req.default_branch);
            Override {
                field: key.clone(),
                author: found.as_ref().map(|(a, _)| a.clone()),
                changed_at: found.map(|(_, t)| t),
            }
        });
        if upstream != value {
            lines.push(message_line(key, &upstream, &value, over.as_ref(), req.now_secs));
        }
        overrides.extend(over);
        applied.insert(key.clone(), value);
    }
    // A project edit onto a tip that shares no project part would bring the
    // part back with every other project field at its default (no version
    // files, no install script…). It comes back whole instead: the rest as
    // this Mac runs it.
    if !raw.has_project() && applied.keys().any(|key| is_project_field(key)) {
        if let Some(fill) = req.project_fill {
            let fill = to_map(fill);
            for key in PROJECT_FIELDS {
                if !applied.contains_key(*key) {
                    let value = field_value(&fill, key);
                    if !value.is_null() {
                        applied.insert(key.to_string(), value);
                    }
                }
            }
        }
    }
    let fields: Vec<String> = req
        .fields
        .keys()
        .filter(|key| !conflicts.contains_key(*key))
        .cloned()
        .collect();
    if lines.is_empty() {
        return Ok(Prepared {
            tip,
            commit: None,
            definition: raw,
            fields,
            overrides,
            message: String::new(),
            paths: Vec::new(),
            conflicts,
        });
    }
    // Replacing an older copy: this build's own text, nothing kept from it.
    let text = file_text(&raw, if replacing { None } else { written.as_deref() }, &applied, req.default_branch);
    let definition = parse_definition(text.as_bytes()).map_err(|bad| {
        PublishOutcome::Failed(format!("the new definition doesn't parse: {}", bad.message))
    })?;
    let mut changes = vec![FileChange {
        path: DEFINITION_PATH.to_string(),
        bytes: text.into_bytes(),
    }];
    // GH #81: the commit that creates the definition also stops a
    // `.gitignore` that hides `.atelier/` from hiding it.
    if created && !replacing {
        let current = git
            .read_at(&tip, crate::workspace_adoption::GITIGNORE_PATH)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
        if let Some(fixed) = crate::workspace_adoption::fix_gitignore(current.as_deref()) {
            lines.push(crate::commit_message::config_line(&format!(
                ".gitignore — track {DEFINITION_PATH} (.atelier/* with exceptions)"
            )));
            changes.push(FileChange {
                path: crate::workspace_adoption::GITIGNORE_PATH.to_string(),
                bytes: fixed.into_bytes(),
            });
        }
    }
    let mut message = crate::commit_message::config_message(&lines);
    if let Some(device) = req.device.map(str::trim).filter(|d| !d.is_empty()) {
        message.push_str(&format!("\n{DEVICE_TRAILER}: {}\n", device.replace('\n', " ")));
    }
    if let Some(source) = req.moved_from.filter(|_| req.replace_whole) {
        if !message.ends_with('\n') {
            message.push('\n');
        }
        if req.device.map(str::trim).filter(|d| !d.is_empty()).is_none() {
            message.push('\n');
        }
        message.push_str(&format!("{MOVED_FROM_TRAILER}: {source}\n"));
    }
    let paths = changes.iter().map(|c| c.path.clone()).collect();
    let commit = git
        .commit_files(&tip, &changes, &message)
        .map_err(PublishOutcome::Failed)?;
    Ok(Prepared {
        tip,
        commit: Some(commit),
        definition,
        fields,
        overrides,
        message,
        paths,
        conflicts,
    })
}

pub(crate) fn kebab(key: &str) -> String {
    let mut out = String::new();
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            out.push('-');
        }
    }
    out
}

/// The fallback: the same commit on its own branch, and a PR onto the
/// integration branch.
fn open_pull_request(
    git: &Plumbing,
    gh: Option<&Gh>,
    req: &PublishRequest<'_>,
    prepared: &Prepared,
    refused: &str,
) -> PublishOutcome {
    let Some(gh) = gh else {
        return PublishOutcome::Failed(format!(
            "{} refused the push ({refused}) and the GitHub CLI isn't available to open a pull request instead",
            req.branch
        ));
    };
    let Some(sha) = &prepared.commit else {
        return PublishOutcome::Failed("nothing to put in a pull request".to_string());
    };
    let Some(repo) = git.github_repo() else {
        return PublishOutcome::Failed(format!(
            "{} refused the push ({refused}) and origin isn't a GitHub repository Plyloft can open a pull request on",
            req.branch
        ));
    };
    let changed: Vec<&str> = prepared
        .fields
        .iter()
        .map(String::as_str)
        .collect();
    let title = if changed.is_empty() {
        "Settings: Workspace definition".to_string()
    } else {
        format!(
            "Settings: {}",
            changed
                .iter()
                .map(|k| format!("“{}”", field_label(k)))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let only = prepared
        .paths
        .iter()
        .map(|p| format!("`{p}`"))
        .collect::<Vec<_>>()
        .join(" and ");
    let body = format!(
        "{}\nPly couldn't push this shared setting to `{}` directly ({}), so it waits here. Only {only} {}.",
        prepared.message,
        req.branch,
        refused.lines().last().unwrap_or(refused).trim(),
        if prepared.paths.len() > 1 { "change" } else { "changes" }
    );
    // An earlier attempt may have opened a PR from the saved branch and lost
    // the answer (a timeout) — and the queued values may have changed since.
    // [`push_fallback`] walks the fixed sequence of names (a retry walks the
    // same one) and never forces a push.
    let FallbackPush { branch: pr_branch, reuse, replaced, head } =
        match push_fallback(git, gh, &repo, req.branch, req.pull_request_branch, sha) {
            Ok(pushed) => pushed,
            Err(FallbackError::Unreachable(e)) => return PublishOutcome::Unreachable(e),
            Err(FallbackError::Refused(e)) => {
                return PublishOutcome::Failed(format!(
                    "{} refused the push and the pull request branch too: {e}",
                    req.branch
                ))
            }
            Err(FallbackError::Exhausted) => return PublishOutcome::Failed(names_used_up(req.pull_request_branch)),
        };
    // Round 3 (S4; owner): the pull request says which ones it replaces.
    let mut replaces: Vec<Replaced> = req.replaces.iter().map(Replaced::of).collect();
    replaces.extend(replaced);
    let body = with_replaces(git, body, &replaces, reuse.as_deref().and_then(pr_number));
    let url = match reuse {
        Some(url) => {
            if let Some(number) = pr_number(&url) {
                if let Err(e) = gh.pr_edit(&git.cwd, &repo, number, &title, &body) {
                    log::info!("shared_config: PR #{number} carries the new commit; its description stays: {e}");
                }
            }
            url
        }
        None => match gh.pr_create(&git.cwd, &repo, req.branch, &pr_branch, &title, &body) {
            Ok(url) => url,
            Err(e) => {
                return PublishOutcome::Failed(format!("opening the pull request failed: {e}"))
            }
        },
    };
    match pr_number(&url) {
        Some(number) => PublishOutcome::PullRequest {
            pull_request: PullRequest {
                number,
                url,
                branch: pr_branch,
                head: Some(head),
            },
            fields: prepared.fields.clone(),
            conflicts: prepared.conflicts.clone(),
        },
        None => PublishOutcome::Failed(format!("gh printed no pull request URL: {url}")),
    }
}

/// `<branch>`, `<branch>-2`, … — the fixed sequence a change's PR may use.
pub(crate) fn fallback_branches(branch: &str) -> Vec<String> {
    (1..=PR_BRANCH_ATTEMPTS)
        .map(|n| {
            if n == 1 {
                branch.to_string()
            } else {
                format!("{branch}-{n}")
            }
        })
        .collect()
}

/// Where a change's fallback commit went.
#[derive(Debug)]
pub(crate) struct FallbackPush {
    pub branch: String,
    /// The open pull request already on that branch, proposing this very
    /// change (an earlier attempt's, whose answer was lost).
    pub reuse: Option<String>,
    /// Round 3 (S4): the pull requests the walk closed on its way — their
    /// branch held other commits, or they were open onto a former base.
    pub replaced: Vec<Replaced>,
    /// Round 5 (V2): the commit `branch` ends in now — the one pushed, or
    /// the one already there that holds this very change.
    pub head: String,
}

/// A pull request another one replaces, and the branch it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Replaced {
    pub number: u64,
    pub branch: String,
    /// The commit Plyloft left at the end of that branch
    /// ([`PullRequest::head`]); `None`: no record of it.
    pub head: Option<String>,
}

impl Replaced {
    pub(crate) fn of(pr: &PullRequest) -> Self {
        Self { number: pr.number, branch: pr.branch.clone(), head: pr.head.clone() }
    }
}

/// Why a publish stopped when every name of the fallback sequence was taken
/// (round 3, S4). The caller forgets the saved name on these words, so the
/// next Sync starts a new sequence — which is what they say.
pub(crate) const NAMES_USED_UP_MARKER: &str = "are used up";

pub(crate) fn names_used_up(saved: &str) -> String {
    format!(
        "the pull request branch names for this change {NAMES_USED_UP_MARKER} ({saved}…): each holds other \
         commits or a pull request that is closed or merged. Plyloft takes a new name on the next Sync."
    )
}

/// What a pull request's body says of each one it replaces — text on GitHub
/// (round 3, S4; owner, 2026-11-09; `STRINGS.md`). `this` is the pull request
/// the body is for, when it already exists: it never replaces itself.
pub(crate) fn with_replaces(git: &Plumbing, body: String, replaced: &[Replaced], this: Option<u64>) -> String {
    let mut body = body;
    let mut said: Vec<u64> = Vec::new();
    for old in replaced {
        if Some(old.number) == this || said.contains(&old.number) {
            continue;
        }
        said.push(old.number);
        // Round 5 (V2): its branch no longer ends in the commit Plyloft
        // recorded for it — and with no record the warning is said, since
        // nothing shows the branch is as Plyloft left it. (Who committed says
        // nothing: the member's other computer and a teammate with the same
        // name commit under the same identity.) A branch that can't be read,
        // or is gone, claims nothing.
        let foreign = match git.remote_tip(&old.branch) {
            Ok(Some(tip)) => old.head.as_deref() != Some(tip.as_str()),
            _ => false,
        };
        body.push_str(&if foreign {
            format!(
                "\n\nReplaces #{}. Its branch `{}` ends in a commit this pull request doesn't have: look at it there before merging this one.",
                old.number, old.branch
            )
        } else {
            format!("\n\nReplaces #{}.", old.number)
        });
    }
    body
}

/// Why no fallback branch took the commit.
#[derive(Debug)]
pub(crate) enum FallbackError {
    /// GitHub or origin didn't answer: try again later.
    Unreachable(String),
    /// origin refused the pull request branch itself.
    Refused(String),
    /// Every name of the sequence is taken.
    Exhausted,
}

/// 1.175.0 (A5; SC-6, OP-1): put `sha` on the first of `saved`'s fallback
/// names that can take it — **never forced**. The shared-config and the
/// library channel both come through here.
///
/// A name whose pull request is settled is passed over; one open onto another
/// base is withdrawn and passed over. On a free name, or one whose open pull
/// request targets `base`, the commit is pushed plainly. A branch that
/// already ends in a different commit (an earlier attempt's values, or a
/// commit somebody added on GitHub) refuses that push as a non-fast-forward:
/// it is left exactly as it is, its pull request — which no longer proposes
/// what is queued — is closed, and the change goes to the next name, so one
/// open pull request, of one commit on `base`'s tip, carries the values
/// queued now. Only a branch that already holds this very change (the same
/// tree on the same parents: a retry after a lost answer) is reused.
pub(crate) fn push_fallback(
    git: &Plumbing,
    gh: &Gh,
    repo: &str,
    base: &str,
    saved: &str,
    sha: &str,
) -> Result<FallbackPush, FallbackError> {
    let mut replaced = Vec::new();
    for candidate in fallback_branches(saved) {
        let reuse = match gh.pr_for_branch(&git.cwd, repo, &candidate) {
            // Open onto this integration branch: its branch may take the commit.
            Ok(Some(found))
                if found.state == PrState::Open
                    && found.base.as_deref().is_none_or(|b| b == base) =>
            {
                Some(found.url)
            }
            // Open onto another branch (the integration branch changed since):
            // this commit can't go there. Withdraw it and use the next name.
            Ok(Some(found)) if found.state == PrState::Open => {
                if let Some(number) = pr_number(&found.url) {
                    gh.pr_close(&git.cwd, repo, number).map_err(FallbackError::Unreachable)?;
                    // Found by its branch's name: no record of what Plyloft
                    // left there.
                    replaced.push(Replaced { number, branch: candidate.clone(), head: None });
                }
                continue;
            }
            // Settled: it can't carry this change.
            Ok(Some(_)) => continue,
            Ok(None) => None,
            // If GitHub can't say, try again later rather than risk a second PR.
            Err(e) => return Err(FallbackError::Unreachable(e)),
        };
        match git.push(sha, &candidate) {
            PushResult::Pushed => return Ok(FallbackPush { branch: candidate, reuse, replaced, head: sha.to_string() }),
            PushResult::Unreachable(e) => return Err(FallbackError::Unreachable(e)),
            PushResult::Refused(e) => return Err(FallbackError::Refused(e)),
            PushResult::NonFastForward(e) => {
                // Origin didn't say what the branch holds: nothing is closed
                // on a guess (round 3, S4). Try again later.
                if let Some(head) = git.remote_carries(&candidate, sha).map_err(FallbackError::Unreachable)? {
                    return Ok(FallbackPush { branch: candidate, reuse, replaced, head });
                }
                log::info!(
                    "shared_config: {candidate} holds other commits and is left as it is; the change goes to the next name: {e}"
                );
                if let Some(number) = reuse.as_deref().and_then(pr_number) {
                    gh.pr_close(&git.cwd, repo, number).map_err(FallbackError::Unreachable)?;
                    replaced.push(Replaced { number, branch: candidate.clone(), head: None });
                }
            }
        }
    }
    Err(FallbackError::Exhausted)
}

/// The one write channel. Fetch, re-apply the queued fields onto the tip,
/// commit with plumbing, push; retry once on a non-fast-forward; a refusal
/// opens a pull request. `before_push` runs before each push attempt (tests
/// race it).
pub fn publish(
    git: &Plumbing,
    gh: Option<&Gh>,
    req: &PublishRequest<'_>,
    before_push: &mut dyn FnMut(u32),
) -> PublishOutcome {
    let lock = integration_lock(&git.cwd, req.branch);
    let _serial = lock.lock().unwrap_or_else(|p| p.into_inner());
    for attempt in 1..=2 {
        match git.fetch(req.branch) {
            Ok(()) => {}
            Err(failed @ (FetchFailure::BranchMissing { .. } | FetchFailure::SignIn(_))) => {
                return PublishOutcome::Failed(failed.to_string())
            }
            Err(FetchFailure::Unreachable(e)) => return PublishOutcome::Unreachable(e),
        }
        let prepared = match prepare(git, req) {
            Ok(prepared) => prepared,
            Err(outcome) => return outcome,
        };
        let Some(sha) = prepared.commit.clone() else {
            let author = git
                .history(&prepared.tip, DEFINITION_PATH)
                .first()
                .map(|(_, a, _)| a.clone());
            return PublishOutcome::Published {
                commit: prepared.tip,
                definition: prepared.definition,
                author,
                fields: prepared.fields,
                overrides: Vec::new(),
                pushed: false,
                conflicts: prepared.conflicts,
            };
        };
        before_push(attempt);
        match git.push(&sha, req.branch) {
            PushResult::Pushed => {
                log::info!(
                    "shared_config: published {} to {} as {sha}",
                    published_what(&prepared.fields),
                    req.branch
                );
                return PublishOutcome::Published {
                    commit: sha,
                    definition: prepared.definition,
                    author: git.user_name(),
                    fields: prepared.fields,
                    overrides: prepared.overrides,
                    pushed: true,
                    conflicts: prepared.conflicts,
                };
            }
            PushResult::NonFastForward(e) if attempt == 1 => {
                log::info!("shared_config: {} moved on, retrying once: {e}", req.branch);
            }
            PushResult::NonFastForward(e) | PushResult::Refused(e) if req.no_pull_request => {
                // teamfix round 2: a move opens no pull request.
                log::warn!("shared_config: push to {} refused, no pull request for it: {e}", req.branch);
                return PublishOutcome::Failed(format!("{} refused the move ({e})", req.branch));
            }
            PushResult::NonFastForward(e) | PushResult::Refused(e) => {
                log::warn!(
                    "shared_config: push to {} refused, opening a pull request: {e}",
                    req.branch
                );
                return open_pull_request(git, gh, req, &prepared, &e);
            }
            PushResult::Unreachable(e) => return PublishOutcome::Unreachable(e),
        }
    }
    unreachable!("the second attempt always returns")
}

/// The write channel as `workspace_definition`'s drain sees it, so the queue
/// logic is tested without a remote.
pub trait Publisher {
    fn publish(&self, request: &PublishRequest<'_>) -> PublishOutcome;
    /// `None` when GitHub can't say (offline, no `gh`): keep waiting.
    fn pull_request_state(&self, pull_request: &PullRequest) -> Option<PrState>;
    /// Close a PR that no longer proposes what is queued. Already merged or
    /// closed is success.
    fn close_pull_request(&self, pull_request: &PullRequest) -> Result<(), String>;
    /// Close every open PR from `branch` (and its `-2`, `-3`… fallbacks); the
    /// numbers closed. For an attempt whose answer was lost, once nothing is
    /// left to propose.
    fn withdraw_branch(&self, branch: &str) -> Result<Vec<u64>, String>;
    /// 1.175.0 (C1 round 5): *Stop sharing* closes a shared-setting pull
    /// request this computer opened — only while it is still that pull
    /// request: recorded in the repository origin is now, its head branch
    /// the recorded one in that same repository, and open. The record may
    /// be days old; a number alone could be somebody else's pull request.
    fn close_after_stop(&self, pull_request: &PullRequest) -> Result<OwnClose, String> {
        self.close_own_saying(pull_request, STOP_SHARING_COMMENT)
    }
    /// 1.175.0 (C4): [`Self::close_after_stop`]'s checks, with the comment
    /// GitHub shows given — it must be true of why it is closed.
    fn close_own_saying(&self, pull_request: &PullRequest, _comment: &str) -> Result<OwnClose, String> {
        match self.pull_request_state(pull_request) {
            Some(PrState::Merged) | Some(PrState::Closed) => Ok(OwnClose::Settled),
            _ => self.close_pull_request(pull_request).map(|()| OwnClose::Closed),
        }
    }
}

/// What [`Publisher::close_after_stop`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnClose {
    Closed,
    /// Merged or closed meanwhile: left as it is.
    Settled,
    /// Not (or no longer) this computer's pull request in this repository:
    /// left as it is, and named.
    NotOurs,
}

/// The comment GitHub shows on a pull request *Stop sharing* closes.
pub const STOP_SHARING_COMMENT: &str = "Withdrawn by Plyloft: this project's shared setup stopped being shared.";
/// 1.175.0 (C4, SC-4): the comment on this computer's creation pull request
/// Plyloft closes because the setup was shared from another computer first.
pub const SHARED_FIRST_COMMENT: &str =
    "Withdrawn by Plyloft: this project's setup was shared from another computer first, so this pull request isn't needed.";

/// `url` is pull request `number` of `repo` (`owner/name`) on github.com.
pub(crate) fn pull_request_in(url: &str, repo: &str, number: u64) -> bool {
    let url = url.trim().trim_end_matches('/').to_ascii_lowercase();
    let repo = repo.trim().trim_start_matches("github.com/").to_ascii_lowercase();
    url.ends_with(&format!("github.com/{repo}/pull/{number}"))
}

/// The real channel: git plumbing in the workspace's repository and `gh`.
pub struct GitPublisher {
    pub git: Plumbing,
    pub gh: Option<Gh>,
    /// 1.173.0 (C3): this computer's name for the commit's
    /// [`DEVICE_TRAILER`]; `None` (tests) writes none.
    pub device: Option<String>,
}

impl Publisher for GitPublisher {
    fn publish(&self, request: &PublishRequest<'_>) -> PublishOutcome {
        let request = PublishRequest {
            device: request.device.or(self.device.as_deref()),
            ..*request
        };
        publish(&self.git, self.gh.as_ref(), &request, &mut |_| {})
    }

    fn close_pull_request(&self, pull_request: &PullRequest) -> Result<(), String> {
        let gh = self
            .gh
            .as_ref()
            .ok_or_else(|| "the GitHub CLI isn't available".to_string())?;
        let repo = self
            .git
            .github_repo()
            .ok_or_else(|| "origin isn't a GitHub repository".to_string())?;
        match gh.pr_state(&self.git.cwd, &repo, pull_request.number)? {
            PrState::Open => gh.pr_close(&self.git.cwd, &repo, pull_request.number),
            PrState::Merged | PrState::Closed => Ok(()),
        }
    }

    fn close_after_stop(&self, pull_request: &PullRequest) -> Result<OwnClose, String> {
        self.close_own_saying(pull_request, STOP_SHARING_COMMENT)
    }

    fn close_own_saying(&self, pull_request: &PullRequest, comment: &str) -> Result<OwnClose, String> {
        let gh = self.gh.as_ref().ok_or_else(|| "the GitHub CLI isn't available".to_string())?;
        let repo = self.git.github_repo().ok_or_else(|| "origin isn't a GitHub repository".to_string())?;
        if !pull_request_in(&pull_request.url, &repo, pull_request.number) {
            return Ok(OwnClose::NotOurs);
        }
        let (state, head, cross) = gh.pr_head(&self.git.cwd, &repo, pull_request.number)?;
        match state {
            PrState::Merged | PrState::Closed => Ok(OwnClose::Settled),
            PrState::Open if cross || head != pull_request.branch => Ok(OwnClose::NotOurs),
            PrState::Open => {
                gh.pr_close_saying(&self.git.cwd, &repo, pull_request.number, comment).map(|()| OwnClose::Closed)
            }
        }
    }

    fn withdraw_branch(&self, branch: &str) -> Result<Vec<u64>, String> {
        let Some(repo) = self.git.github_repo() else {
            // No PR can have been opened without a GitHub origin.
            return Ok(Vec::new());
        };
        // A PR is only ever opened after its branch reached origin: with none
        // of the names there, there is nothing to withdraw — whether or not
        // `gh` is here now. Can't tell (offline): retry later.
        let pushed: Vec<String> = fallback_branches(branch)
            .into_iter()
            .map(|candidate| self.git.remote_branch_exists(&candidate).map(|e| (candidate, e)))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|(_, exists)| *exists)
            .map(|(candidate, _)| candidate)
            .collect();
        if pushed.is_empty() {
            return Ok(Vec::new());
        }
        let gh = self.gh.as_ref().ok_or_else(|| {
            format!("{} may have an open pull request, and the GitHub CLI isn't available to close it", pushed[0])
        })?;
        let mut closed = Vec::new();
        for candidate in pushed {
            if let Some(FoundPr { url, state: PrState::Open, .. }) =
                gh.pr_for_branch(&self.git.cwd, &repo, &candidate)?
            {
                let number = pr_number(&url)
                    .ok_or_else(|| format!("gh printed no pull request URL: {url}"))?;
                gh.pr_close(&self.git.cwd, &repo, number)?;
                closed.push(number);
            }
        }
        Ok(closed)
    }

    fn pull_request_state(&self, pull_request: &PullRequest) -> Option<PrState> {
        let gh = self.gh.as_ref()?;
        let repo = self.git.github_repo()?;
        match gh.pr_state(&self.git.cwd, &repo, pull_request.number) {
            Ok(state) => Some(state),
            Err(e) => {
                log::info!(
                    "shared_config: state of PR #{} unknown: {e}",
                    pull_request.number
                );
                None
            }
        }
    }
}

// ── Serialization with Ship ───────────────────────────────────────────

type LockMap =
    std::collections::HashMap<(PathBuf, String), std::sync::Arc<std::sync::Mutex<()>>>;

static INTEGRATION_LOCKS: std::sync::LazyLock<std::sync::Mutex<LockMap>> =
    std::sync::LazyLock::new(Default::default);

/// The repository a path belongs to: git's common directory, canonical — the
/// same for the root, any subdirectory and every linked worktree. A path
/// outside git falls back to itself, canonical.
pub(crate) fn repository_identity(path: &Path) -> PathBuf {
    let mut cmd = crate::platform::git_command();
    cmd.args(["rev-parse", "--path-format=absolute", "--git-common-dir"]).current_dir(path);
    let common = bounded_git(&mut cmd, None, ANCESTRY_TIMEOUT)
        .ok()
        .filter(|out| out.status.success())
        .map(|out| PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()));
    let chosen = common.unwrap_or_else(|| path.to_path_buf());
    crate::platform::canonicalize(&chosen).unwrap_or(chosen)
}

/// One lock per (repository, branch): every shared-config publish and Ship's
/// merges onto that branch take it, like `STATUS_LABEL_LOCK` serializes
/// label writes. Keyed by the repository (git's common directory), so
/// workspaces at its root, in a subdirectory or in a linked worktree share it.
pub fn integration_lock(repo: &Path, branch: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
    let key = (repository_identity(repo), branch.to_string());
    INTEGRATION_LOCKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(key)
        .or_default()
        .clone()
}

/// Before Ship commits, tags and pushes a release onto `branch`: bring the
/// local branch up to origin's tip, which a shared-config publish may have
/// moved on (the channel never touches the local branch). Call holding
/// [`integration_lock`] and then the fast-forward lock (`held`, GH #203),
/// which Ship keeps through its release commit. A branch that can't be fast-forwarded is refused
/// before anything is merged, committed or tagged; offline or without an
/// origin the release goes ahead as before.
///
/// GH #151: GH #88's untracked-files refusal comes back as a value
/// ([`crate::worktrees::ShipError::LocalBranchRefused`]) carrying Sync's own
/// report, so the card's Ship step draws the block with its two ways out.
/// Every other refusal is still a sentence.
///
/// GH #183: `Ok(true)` when the branch is now at origin's tip
/// ([`crate::worktrees::LocalBranchSync::fast_forwarded`]) — the release's
/// `fastForwarded`, on which the window takes GH #88's block down. Offline,
/// without an origin or ahead, the release goes ahead with `Ok(false)`.
pub fn sync_before_release(
    held: &crate::worktrees::FastForwardHeld,
    workspace_cwd: &Path,
    branch: &str,
) -> Result<bool, crate::worktrees::ShipError> {
    sync_before_release_with(held, workspace_cwd, branch, false)
}

/// 1.174.0 (DR2 round 1, owner): "On this Mac only" from Release… on a
/// GitHub project — [`sync_before_release`], except that GitHub out of
/// reach refuses it: the release is made from GitHub's target brought here.
pub fn sync_before_local_release(
    held: &crate::worktrees::FastForwardHeld,
    workspace_cwd: &Path,
    branch: &str,
) -> Result<bool, crate::worktrees::ShipError> {
    sync_before_release_with(held, workspace_cwd, branch, true)
}

/// The words of [`sync_before_local_release`]'s refusal while offline.
pub fn offline_local_release_words(branch: &str) -> String {
    format!(
        "Plyloft couldn't reach GitHub to bring {branch} up to date on {}, so nothing was released. Try again when you're online.",
        crate::this_machine!()
    )
}

fn sync_before_release_with(
    held: &crate::worktrees::FastForwardHeld,
    workspace_cwd: &Path,
    branch: &str,
    offline_refused: bool,
) -> Result<bool, crate::worktrees::ShipError> {
    use crate::worktrees::{LocalBranchSync as Sync, RefusedOperation, ShipError};
    let outcome = crate::worktrees::fast_forward_local_locked(held, workspace_cwd, branch);
    let message = match &outcome {
        Sync::UpToDate
        | Sync::FastForwarded { .. }
        | Sync::Ahead { .. }
        | Sync::NoRemote
        | Sync::NoLocalBranch => return Ok(outcome.fast_forwarded()),
        Sync::Offline { reason } if offline_refused => {
            log::info!("shared_config: a local release of {branch} refused offline: {reason}");
            offline_local_release_words(branch)
        }
        Sync::Offline { reason } => {
            log::info!("shared_config: releasing on {branch} without syncing it: {reason}");
            return Ok(false);
        }
        Sync::Dirty { behind } => format!(
            "Ship stopped: the online copy of {branch} has {behind} commit(s) your project folder doesn't (a shared settings change, say), and your project folder has changes that aren't in a commit. Commit them or undo them, then ship again. Nothing was merged."
        ),
        Sync::Diverged { ahead, behind } => format!(
            "Ship stopped: {branch} in your project folder and on the online copy have both moved ({ahead} commit(s) here aren't online, {behind} online aren't here). Bring the online {branch} into your project folder, then ship again. Nothing was merged."
        ),
        Sync::CheckedOutElsewhere { path, behind } => format!(
            "Ship stopped: the online copy of {branch} has {behind} commit(s) your project folder doesn't, and {branch} is open in another folder ({path}). Bring them in there, then ship again. Nothing was merged."
        ),
        // GH #151: a value, never a sentence — the window draws the block
        // from it.
        Sync::UntrackedDiffers { .. } => {
            return Err(ShipError::local_branch_refused(
                RefusedOperation::Ship,
                branch,
                outcome.clone(),
            ));
        }
        Sync::Failed { reason } => format!(
            "Ship stopped: Plyloft couldn't bring {branch} up to date with the online copy: {reason}. Nothing was merged."
        ),
    };
    Err(ShipError::Message(message))
}

/// WALKFIX-3 (re-run, item 5): what a log line says was published — the
/// fields, or the file itself for a creation that names none (it read
/// "published  to w1175-int").
pub(crate) fn published_what(fields: &[String]) -> String {
    if fields.is_empty() {
        format!("{DEFINITION_PATH} (created)")
    } else {
        fields.join(", ")
    }
}

#[cfg(test)]
#[path = "shared_config_tests.rs"]
mod tests;
