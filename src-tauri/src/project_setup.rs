//! OB-11 — the first project's backend (onboarding spec §5 step 8).
//!
//! Setup's step 8 gets a project three ways, and every one of them is here:
//!
//! - **8a, a folder on this computer**: [`inspect`] reads the folder
//!   (read-only) and says which row of the spec's table it is; [`init`] makes
//!   it a Git project with a first commit when it is not one yet (or has no
//!   commit), from the plan `inspect` made and the files the person left
//!   ticked — never from text the frontend wrote.
//! - **8b, from GitHub**: [`repo_list`] lists the repositories an account can
//!   get (its own, each organisation's, those shared with it, and the team's
//!   workspaces); [`start_clone`] runs `gh repo clone` in Setup's guided
//!   terminal (the OB-3 runner: progress, Stop, killed on quit) into a folder
//!   it creates itself, and removes that folder — and only that one — unless
//!   the clone succeeds; [`first_commit_push`] gives an empty repository its
//!   first commit and sends it to GitHub, after the person's consent.
//! - **8c, a new project**: [`new_preview`] and [`create_new`] make the
//!   folder from the name's slug, a README and an OS-files `.gitignore`, the
//!   first commit, and — only when asked (D10) — a private copy on GitHub.
//!
//! Registering the workspace stays with `workspace_create` (plus
//! `workspace_set_github_account` when an account was chosen).
//!
//! Rules this module keeps:
//!
//! - Every git spawn goes through [`Tools::git`] (production:
//!   `platform::git_command`), never a bare `git`.
//! - Every value in an argv is a constant, a validated login or `owner/name`,
//!   or a path Ply built or the folder picker gave (spec §6).
//! - A GitHub token (`gh auth token --user <login>`) is fetched only for an
//!   account that isn't gh's active one, is handed to the one command that
//!   needs it as `GH_TOKEN`, and is never persisted, logged, put in an error
//!   or given to an agent terminal (D7). [`GhToken`]'s `Debug` is redacted
//!   and every error text that could echo it goes through [`redact`].
//! - The walk and the file listing are bounded (50 000 files or 5 s).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

// ── Limits and words ───────────────────────────────────────────────────

/// Stop counting files at this many (spec §5 step 8a).
pub const SCAN_MAX_FILES: u64 = 50_000;
/// …or after this long.
pub const SCAN_MAX_TIME: Duration = Duration::from_secs(5);
/// Files over this are left out of the first commit (GitHub refuses files
/// over 100 MB).
pub const LARGE_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// "That's a lot to save in one go": over this many files…
pub const HUGE_FILES: u64 = 20_000;
/// …or this many bytes.
pub const HUGE_BYTES: u64 = 1024 * 1024 * 1024;
/// How many found files (large, secret) a list carries.
pub const FOUND_CAP: usize = 200;
/// How many top-level entries "Show what will be saved" lists.
pub const TOP_LEVEL_CAP: usize = 100;
/// How many repositories the GitHub list carries in all.
pub const REPO_LIST_CAP: usize = 1000;
/// `gh repo list --limit`.
pub const REPO_LIST_LIMIT: usize = 200;
/// How many organisations are listed.
pub const ORG_CAP: usize = 30;
/// Pages of `user/repos?affiliation=collaborator,organization_member`.
pub const SHARED_PAGES: usize = 3;
/// A slug and a GitHub repository name stay under this.
pub const SLUG_MAX: usize = 100;

const GIT_READ: Duration = Duration::from_secs(10);
const GIT_ADD: Duration = Duration::from_secs(300);
const GIT_COMMIT: Duration = Duration::from_secs(120);
const GIT_NETWORK: Duration = Duration::from_secs(60);
const GH_CALL: Duration = Duration::from_secs(20);
const GH_CREATE: Duration = Duration::from_secs(120);

pub const IDENTITY_NEEDED: &str = "Git needs your name and email before Plyloft can make the first commit.";
pub const REFUSED_HOME: &str = "Choose a project folder, not your whole home folder.";
pub const REFUSED_ROOT: &str = "Choose a project folder, not the whole disk.";
pub const REFUSED_SYSTEM: &str = "That's a system folder. Choose a project folder.";
pub const REFUSED_PROJECTS: &str =
    "That's the folder your projects go in. Choose one project inside it.";
pub const NAME_NEEDS_LETTERS: &str = "Choose a name with letters or numbers.";
pub const GIT_UNAVAILABLE: &str = "Git isn't working on this computer yet. Set it up in Setup's Git step first.";
pub const GH_UNAVAILABLE: &str = "The GitHub CLI isn't installed. Set it up in Setup's GitHub step first.";

/// Folders the walk skips and the `.gitignore` Ply adds leaves out (the
/// monorepo scan's `NOISY_SUBDIR_NAMES`, less Ply's own worktrees).
pub const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".cache",
];

/// What [`init`] adds to `.gitignore` (the lines not already there): the
/// folders above, `.env` files, and the operating systems' own files.
pub const INIT_IGNORE: &[&str] = &[
    "node_modules/",
    "dist/",
    "build/",
    "out/",
    "target/",
    "__pycache__/",
    ".venv/",
    "venv/",
    ".next/",
    ".cache/",
    ".env",
    ".env.*",
    "!.env.example",
    "!.env.sample",
    "!.env.template",
    "!.env.dist",
    ".DS_Store",
    "Thumbs.db",
];

/// A new project's `.gitignore` (spec §5 step 8c: OS files only).
pub const NEW_IGNORE: &[&str] = &[".DS_Store", "Thumbs.db", "Desktop.ini"];

/// The comment above the lines Ply adds.
pub const IGNORE_HEADER: &str = "# Added by Plyloft";

/// `.env` files that hold examples, not secrets (never flagged).
const ENV_TEMPLATES: &[&str] = &[".env.example", ".env.sample", ".env.template", ".env.dist"];

// ── The GitHub token (D7) ──────────────────────────────────────────────

/// A GitHub token from `gh auth token --user`. Lives only as long as the one
/// command it is for. Its `Debug` never shows it; there is no `Display` and
/// no `Serialize`.
#[derive(Clone, PartialEq, Eq)]
pub struct GhToken(String);

impl GhToken {
    pub fn new(token: String) -> Option<Self> {
        let token = token.trim().to_string();
        (!token.is_empty() && !token.contains(char::is_whitespace)).then_some(Self(token))
    }

    /// The value, for the `GH_TOKEN` of one command.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for GhToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GhToken(<redacted>)")
    }
}

/// `text` with the token (if any) replaced — for any words built from a
/// command's output while a token was in its environment.
pub fn redact(text: &str, token: Option<&GhToken>) -> String {
    match token {
        Some(t) if !t.0.is_empty() => text.replace(&t.0, "•••"),
        _ => text.to_string(),
    }
}

// ── The programs ───────────────────────────────────────────────────────

/// How this module runs git and gh. Production: [`Tools::production`];
/// tests: a git with a temporary global config and a stub gh.
#[derive(Clone)]
pub struct Tools {
    /// A git `Command` (production: `platform::git_command`).
    pub git: Arc<dyn Fn() -> Command + Send + Sync>,
    /// gh's program, when it resolved.
    pub gh: Option<String>,
    /// The PATH gh runs with (the cached shell PATH; on a Mac whose probe
    /// found no Command Line Tools, see [`Tools::gh`]).
    pub path: String,
}

impl Tools {
    pub fn production() -> Self {
        let env = crate::shell_env::get();
        Self {
            git: Arc::new(crate::platform::git_command),
            gh: env.gh_path.clone(),
            path: env.path.clone(),
        }
    }

    /// `git -C <dir>`.
    pub fn git_in(&self, dir: &Path) -> Command {
        let mut command = (self.git)();
        command.arg("-C").arg(dir);
        command
    }

    /// gh, never prompting, with `GH_TOKEN` only when a token is given.
    pub fn gh(&self, token: Option<&GhToken>) -> Result<Command, String> {
        let gh = self.gh.as_deref().ok_or_else(|| GH_UNAVAILABLE.to_string())?;
        let mut command = crate::platform::command(gh, &self.path);
        command
            .env("PATH", &self.path)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("NO_COLOR", "1");
        // gh's active account unless a token for another one is given; an
        // inherited GH_TOKEN would silently pick an account nobody chose.
        command.env_remove("GH_TOKEN").env_remove("GITHUB_TOKEN");
        if let Some(token) = token {
            command.env("GH_TOKEN", token.expose());
        }
        // 1.176.4: on a Mac whose probe found no Command Line Tools, the
        // probed git's folder in front of `/usr/bin` (Apple's placeholder git).
        crate::github_account::apply_mac_rule_to_gh(&mut command);
        Ok(command)
    }
}

/// A finished command.
#[derive(Debug, Clone)]
pub struct Ran {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Ran {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// Trimmed stdout.
    pub fn out(&self) -> String {
        self.stdout.trim().to_string()
    }

    /// The first non-empty lines of stderr (then stdout), for Details.
    pub fn words(&self) -> String {
        let text = if self.stderr.trim().is_empty() {
            &self.stdout
        } else {
            &self.stderr
        };
        text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .take(6)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Run `command` bounded by `timeout` (its own process group, killed on
/// timeout and on quit).
pub fn run(command: &mut Command, timeout: Duration) -> Result<Ran, String> {
    use crate::worktrees::BoundedFailure;
    match crate::worktrees::run_bounded_output(command, timeout) {
        Ok(out) => Ok(Ran {
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }),
        Err(BoundedFailure::TimedOut) => Err(format!(
            "It didn't finish within {} seconds.",
            timeout.as_secs()
        )),
        Err(BoundedFailure::Quitting) => Err("Plyloft is quitting.".into()),
        Err(BoundedFailure::Spawn(_)) => Err(GIT_UNAVAILABLE.into()),
        Err(BoundedFailure::Truncated) => Err("The answer was too long to read.".into()),
    }
}

fn git_ran(tools: &Tools, dir: &Path, args: &[&str], timeout: Duration) -> Result<Ran, String> {
    let mut command = tools.git_in(dir);
    command.args(args);
    run(&mut command, timeout)
}

/// Trimmed stdout when git answered 0, else `None` (a read that found nothing).
pub(crate) fn git_read(tools: &Tools, dir: &Path, args: &[&str]) -> Result<Option<String>, String> {
    let ran = git_ran(tools, dir, args, GIT_READ)?;
    Ok(ran.ok().then(|| ran.out()))
}

/// A git step that must work; its failure says which step, with git's words.
fn git_step(tools: &Tools, dir: &Path, args: &[&str], timeout: Duration) -> Result<Ran, String> {
    let ran = git_ran(tools, dir, args, timeout)?;
    if ran.ok() {
        Ok(ran)
    } else {
        Err(format!(
            "`git {}` didn't work:\n{}",
            args.first().copied().unwrap_or(""),
            ran.words()
        ))
    }
}

// ── Paths ──────────────────────────────────────────────────────────────

fn canonical(path: &Path) -> PathBuf {
    crate::platform::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn same_path(a: &Path, b: &Path) -> bool {
    let (a, b) = (canonical(a), canonical(b));
    if cfg!(windows) || cfg!(target_os = "macos") {
        // Case-insensitive file systems by default.
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// A path as the frontend shows it: `~/…` under the home folder.
pub fn display_path(path: &Path, home: Option<&Path>) -> String {
    if let Some(home) = home {
        if let Ok(rest) = path.strip_prefix(home) {
            let rest = crate::platform::slash_path(rest);
            return if rest.is_empty() {
                "~".into()
            } else {
                format!("~/{rest}")
            };
        }
    }
    path.to_string_lossy().into_owned()
}

/// A folder Ply won't make a project of (spec §5 step 8a, last rows).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefusedFolder {
    Home,
    Root,
    System,
    ProjectsFolder,
    /// A whole disk or network share: `/Volumes/<disk>`, `\\server\share`.
    Volume,
}

impl RefusedFolder {
    pub fn words(self) -> &'static str {
        match self {
            Self::Home => REFUSED_HOME,
            Self::Root | Self::Volume => REFUSED_ROOT,
            Self::System => REFUSED_SYSTEM,
            Self::ProjectsFolder => REFUSED_PROJECTS,
        }
    }
}

/// `path` as `/`-separated segments below its root: `C:\Windows` →
/// `["windows"]`, `/usr/bin` → `["usr", "bin"]`. A Windows network path
/// (`\\server\share\x`, `\\?\UNC\server\share\x`) keeps `server` and
/// `share` as its first two segments, and says so (`true`).
fn segments(path: &str, windows: bool) -> (Vec<String>, bool) {
    let mut p = path.replace('\\', "/");
    let mut unc = false;
    if windows {
        p = p.to_lowercase();
        if let Some(rest) = p.strip_prefix("//?/unc/") {
            p = rest.to_string();
            unc = true;
        } else if let Some(rest) = p.strip_prefix("//?/") {
            p = rest.to_string();
        } else if let Some(rest) = p.strip_prefix("//") {
            p = rest.to_string();
            unc = true;
        }
        if !unc && p.len() >= 2 && p.as_bytes()[1] == b':' {
            p = p[2..].to_string();
        }
    }
    let segs = p
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .map(String::from)
        .collect();
    (segs, unc)
}

/// Pure: whether `path` (canonical) is one Ply refuses — the home folder,
/// the disk's root, a system folder, or the projects folder itself.
pub fn refused_folder(
    path: &str,
    home: Option<&str>,
    projects: Option<&str>,
    windows: bool,
) -> Option<RefusedFolder> {
    let (segs, unc) = segments(path, windows);
    if segs.is_empty() {
        return Some(RefusedFolder::Root);
    }
    // A network share's root (`\\server\share`), or less.
    if unc && segs.len() <= 2 {
        return Some(RefusedFolder::Volume);
    }
    let eq = |other: Option<&str>| other.is_some_and(|o| segments(o, windows).0 == segs);
    if eq(home) {
        return Some(RefusedFolder::Home);
    }
    if eq(projects) {
        return Some(RefusedFolder::ProjectsFolder);
    }
    // The folder that holds the home folders (`/Users`, `C:\Users`).
    if let Some(home) = home {
        let home = segments(home, windows).0;
        if home.len() > 1 && home[..home.len() - 1] == segs[..] {
            return Some(RefusedFolder::System);
        }
    }
    // Both systems' disks are case-insensitive by default.
    let lower: Vec<String> = segs.iter().map(|x| x.to_lowercase()).collect();
    let s: Vec<&str> = lower.iter().map(String::as_str).collect();
    if unc {
        return None;
    }
    // A whole mounted disk (`/Volumes/<disk>`).
    if !windows && s.len() == 2 && s[0] == "volumes" {
        return Some(RefusedFolder::Volume);
    }
    let system = if windows {
        matches!(
            s[0],
            "windows" | "program files" | "program files (x86)" | "programdata"
        ) || s == ["users"]
    } else {
        // Inside these: never a project.
        let inside = matches!(
            s[0],
            "system" | "usr" | "bin" | "sbin" | "etc" | "dev" | "library" | "applications" | "cores"
        ) || s.starts_with(&["private", "etc"]);
        // These exactly (a temporary folder under /private/var is fine).
        let exact = matches!(
            s.as_slice(),
            ["users"] | ["volumes"] | ["var"] | ["tmp"] | ["opt"] | ["private"] | ["private", "var"] | ["private", "tmp"] | ["home"] | ["network"]
        );
        inside || exact
    };
    system.then_some(RefusedFolder::System)
}

// ── Scanning what a first commit would save ────────────────────────────

/// The bounds of one scan (tests shrink them).
#[derive(Debug, Clone, Copy)]
pub struct ScanLimits {
    pub max_files: u64,
    pub max_time: Duration,
    pub large_file_bytes: u64,
    pub huge_files: u64,
    pub huge_bytes: u64,
}

impl ScanLimits {
    pub const REAL: ScanLimits = ScanLimits {
        max_files: SCAN_MAX_FILES,
        max_time: SCAN_MAX_TIME,
        large_file_bytes: LARGE_FILE_BYTES,
        huge_files: HUGE_FILES,
        huge_bytes: HUGE_BYTES,
    };
}

/// 1.171.0 D3: a new folder of build output or packages the save would hold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundFolder {
    /// Relative to the project, `/`-separated, ending with `/`.
    pub path: String,
    pub files: u64,
}

/// A file the scan found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundFile {
    /// Relative to the project, `/`-separated.
    pub path: String,
    pub bytes: u64,
}

/// One top-level entry of "Show what will be saved".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopEntry {
    pub name: String,
    pub is_dir: bool,
    pub files: u64,
    pub bytes: u64,
}

/// What the first commit would save.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SaveSummary {
    /// Files counted (the large files and secrets left out are not).
    pub files: u64,
    pub bytes: u64,
    /// False when the count stopped at its bound (50 000 files or 5 s).
    pub complete: bool,
    /// Over 20 000 files or 1 GB (or the count stopped): the sheet warns.
    pub huge: bool,
    /// Largest first.
    pub top_level: Vec<TopEntry>,
}

/// Pure: a file that looks like a password or key (spec: `.env*`, `*.pem`,
/// `*.key`, `id_rsa*`; plus the other SSH private key names). Example
/// `.env` files and public keys are not.
pub fn is_likely_secret(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    if ENV_TEMPLATES.contains(&name.as_str()) {
        return false;
    }
    if name == ".env" || name.starts_with(".env.") {
        return true;
    }
    if name.ends_with(".pem") || name.ends_with(".key") {
        return true;
    }
    let ssh = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
    ssh.iter().any(|k| name.starts_with(k)) && !name.ends_with(".pub")
}

/// Pure: a path the `.gitignore` Ply adds leaves out anyway (one of its
/// folders anywhere on the path).
pub fn under_ignored_dir(rel: &str) -> bool {
    let mut parts: Vec<&str> = rel.split('/').collect();
    parts.pop();
    parts.iter().any(|p| IGNORED_DIRS.contains(p))
}

/// The running count.
#[derive(Debug, Clone, Default)]
pub struct Scan {
    pub files: u64,
    pub bytes: u64,
    pub complete: bool,
    pub top: BTreeMap<String, TopEntry>,
    pub large: Vec<FoundFile>,
    pub secrets: Vec<FoundFile>,
    /// A found list reached [`FOUND_CAP`]: more files like these weren't named.
    pub found_truncated: bool,
    /// Large files or secrets whose names a `.gitignore` line can't hold (a
    /// line break, or not UTF-8): Ply can't leave them out, so it won't go on.
    pub unnameable: Vec<String>,
    /// 1.171.0 D3: count files under the build folders too (a save of the
    /// work adds no default ignore lines, so a tracked `build/` file is saved).
    pub count_all: bool,
    seen: u64,
}

impl Scan {
    pub fn new() -> Self {
        Self {
            complete: true,
            ..Self::default()
        }
    }

    /// Count one file; false once the file bound is reached. `name_ok`:
    /// the path is UTF-8 without a line break (a `.gitignore` can name it).
    pub fn add(&mut self, rel: &str, bytes: u64, limits: &ScanLimits, name_ok: bool) -> bool {
        self.seen += 1;
        let secret = is_likely_secret(rel);
        let large = bytes > limits.large_file_bytes;
        if (secret || large) && !name_ok {
            if self.unnameable.len() < FOUND_CAP {
                self.unnameable.push(rel.replace(['\n', '\r'], "␤"));
            }
        } else if secret {
            if self.secrets.len() < FOUND_CAP {
                self.secrets.push(FoundFile { path: rel.into(), bytes });
            } else {
                self.found_truncated = true;
            }
        } else if large {
            if self.large.len() < FOUND_CAP {
                self.large.push(FoundFile { path: rel.into(), bytes });
            } else {
                self.found_truncated = true;
            }
        } else if self.count_all || !under_ignored_dir(rel) {
            self.files += 1;
            self.bytes += bytes;
            let (first, is_dir) = match rel.split_once('/') {
                Some((first, _)) => (first, true),
                None => (rel, false),
            };
            let entry = self.top.entry(first.to_string()).or_insert_with(|| TopEntry {
                name: first.to_string(),
                is_dir,
                files: 0,
                bytes: 0,
            });
            entry.files += 1;
            entry.bytes += bytes;
        }
        if self.seen >= limits.max_files {
            self.complete = false;
            return false;
        }
        true
    }

    pub fn summary(&self, limits: &ScanLimits) -> SaveSummary {
        let mut top: Vec<TopEntry> = self.top.values().cloned().collect();
        top.sort_by(|a, b| b.bytes.cmp(&a.bytes).then(a.name.cmp(&b.name)));
        top.truncate(TOP_LEVEL_CAP);
        SaveSummary {
            files: self.files,
            bytes: self.bytes,
            complete: self.complete,
            huge: !self.complete
                || self.files > limits.huge_files
                || self.bytes > limits.huge_bytes,
            top_level: top,
        }
    }
}

/// Walk a folder that isn't a repository: files only, links not followed,
/// the ignored folders and `.git` skipped, bounded.
pub fn walk(root: &Path, limits: &ScanLimits) -> Scan {
    let deadline = Instant::now() + limits.max_time;
    let mut scan = Scan::new();
    let mut stack: Vec<(PathBuf, String, bool)> = vec![(root.to_path_buf(), String::new(), true)];
    while let Some((dir, prefix, prefix_ok)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if Instant::now() >= deadline {
                scan.complete = false;
                return scan;
            }
            let raw = entry.file_name();
            let name = raw.to_string_lossy().into_owned();
            let name_ok = prefix_ok && raw.to_str().is_some_and(name_fits);
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.is_dir() {
                if name == ".git" || IGNORED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push((entry.path(), rel, name_ok));
            } else if !scan.add(&rel, meta.len(), limits, name_ok) {
                return scan;
            }
        }
    }
    scan
}

/// A name a `.gitignore` line can hold.
fn name_fits(name: &str) -> bool {
    !name.contains(['\n', '\r'])
}

/// git's bytes for a path, as a path (unix: exactly those bytes).
#[cfg(unix)]
fn path_from_bytes(raw: &[u8]) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    PathBuf::from(std::ffi::OsStr::from_bytes(raw))
}

#[cfg(not(unix))]
fn path_from_bytes(raw: &[u8]) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(raw).into_owned())
}

/// `git ls-files -z …` read as it comes, stopping at the bounds. Each path
/// goes to `each` (false stops). Returns whether the listing was complete.
fn stream_paths(
    mut command: Command,
    deadline: Instant,
    mut each: impl FnMut(&[u8]) -> bool,
) -> Result<bool, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|_| GIT_UNAVAILABLE.to_string())?;
    let mut stdout = child.stdout.take().ok_or_else(|| GIT_UNAVAILABLE.to_string())?;
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut pending: Vec<u8> = Vec::new();
    let mut complete = true;
    'read: loop {
        let now = Instant::now();
        if now >= deadline {
            complete = false;
            break;
        }
        match rx.recv_timeout(deadline - now) {
            Ok(chunk) => {
                pending.extend_from_slice(&chunk);
                let mut start = 0;
                while let Some(offset) = pending[start..].iter().position(|b| *b == 0) {
                    let end = start + offset;
                    let path = pending[start..end].to_vec();
                    start = end + 1;
                    if !each(&path) {
                        complete = false;
                        break 'read;
                    }
                }
                pending.drain(..start);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                complete = false;
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    if !complete {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|_| GIT_UNAVAILABLE.to_string())?;
    if complete && !status.success() {
        return Err("Git couldn't list the files in this folder.".into());
    }
    Ok(complete)
}

/// Count what `git add -A` would stage in a repository with no commit yet
/// (the index and the files not ignored), bounded.
pub fn scan_repo(tools: &Tools, dir: &Path, limits: &ScanLimits) -> Result<Scan, String> {
    let deadline = Instant::now() + limits.max_time;
    let mut command = tools.git_in(dir);
    command.args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    let mut scan = Scan::new();
    let complete = stream_paths(command, deadline, |raw| {
        let rel = String::from_utf8_lossy(raw);
        let name_ok = std::str::from_utf8(raw).is_ok_and(name_fits);
        let bytes = std::fs::symlink_metadata(dir.join(path_from_bytes(raw)))
            .map(|m| m.len())
            .unwrap_or(0);
        scan.add(&rel, bytes, limits, name_ok)
    })?;
    if !complete {
        scan.complete = false;
    }
    Ok(scan)
}

// ── 8a: inspecting a folder ────────────────────────────────────────────

/// A workspace Ply already has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRef {
    pub id: String,
    pub name: String,
    pub cwd: String,
}

/// Where the folder stands with Git.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum GitState {
    NotRepo,
    /// Inside another repository (never the top level of one).
    #[serde(rename_all = "camelCase")]
    InsideAnother {
        top_level: String,
        name: String,
        /// That repository is already a workspace.
        in_ply: Option<WorkspaceRef>,
    },
    /// A repository whose HEAD has no commit yet.
    Unborn { branch: Option<String> },
    Branch { branch: String, commit: String },
    Detached { commit: String },
}

/// The spec table's row (spec §5 step 8a) — the screen the step shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InspectOutcome {
    Refused,
    AlreadyInPly,
    InsideAnotherRepo,
    NotARepo,
    NoCommits,
    /// Detached HEAD, or an unborn HEAD beside branches that have commits:
    /// which branch do cards start from?
    ChooseBranch,
    Ready,
}

/// Everything step 8a shows about a folder.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInspection {
    /// Canonical.
    pub path: String,
    pub name: String,
    pub outcome: InspectOutcome,
    pub refused: Option<RefusedFolder>,
    pub refused_words: Option<String>,
    pub git: GitState,
    /// Local branches, most recent first.
    pub branches: Vec<String>,
    /// `main`, else `master`, else the most recent.
    pub suggested_branch: Option<String>,
    /// A repository with commits has changes not committed.
    pub uncommitted_changes: bool,
    /// 1.171.0 D3 (FR-5): how many files or folders those changes touch
    /// (`git status` lines: a new folder is one), for "This folder has
    /// changes that aren't saved in Git yet (12 files or folders)". 0 when
    /// there are none or Git couldn't say.
    pub uncommitted_files: u32,
    /// 1.171.0 D3: Git is in the middle of combining changes (a merge, a
    /// cherry-pick, a revert, a rebase, or files with unresolved conflicts):
    /// the words why the work can't be saved now. None otherwise.
    pub work_blocked: Option<String>,
    /// 1.171.0 D3, the save-work look only: of the large files and secrets,
    /// those Git already has. Left out, they keep their saved version, and
    /// no `.gitignore` line is written for them.
    pub work_tracked: Vec<String>,
    /// 1.171.0 D3, the save-work look only: new folders of build output or
    /// installed packages (`node_modules/`, `dist/`, …) with their file
    /// count, left out unless unticked (a `/node_modules/` line).
    pub build_folders: Vec<FoundFolder>,
    /// 1.171.0 D3, the save-work look only: folders that are Git projects of
    /// their own (submodules, or a project inside this one). Their state is
    /// never saved here.
    pub nested_projects: Vec<String>,
    /// 1.171.0 walk fix, the save-work look only: the first files the
    /// commit saves, by name (at most [`WORK_FILES_LISTED`]; `to_save.files`
    /// counts them all). Large files, secrets and build folders are not here.
    pub work_files: Vec<String>,
    /// For a folder with no commit yet: what the first commit would save.
    pub to_save: Option<SaveSummary>,
    /// Over 50 MB, left out unless unticked.
    pub large_files: Vec<FoundFile>,
    /// Likely passwords or keys, left out unless unticked.
    pub secrets: Vec<FoundFile>,
    /// The `.gitignore` lines [`init`] adds by default (not yet there).
    pub ignore_lines: Vec<String>,
    pub existing_workspace: Option<WorkspaceRef>,
    /// `.atelier/workspace.json` is there (step 9 read-only).
    pub shared_definition: bool,
    /// `user.name` and `user.email` are set.
    pub identity_ready: bool,
    /// A first commit is needed and the identity isn't set.
    pub needs_identity: bool,
    /// `owner/name` when `origin` is on github.com.
    pub github_origin: Option<String>,
    /// 1.175.0 F3: the repository has an `origin` at all (Add a project's
    /// "Also keep a private copy on GitHub" is offered only without one).
    pub has_origin: bool,
    /// The name *Put it on GitHub* would give it (`slugify` of the folder's
    /// name), for the tick's line; None with an `origin`.
    pub github_name: Option<String>,
    /// `.gitignore` can't be changed safely (a link, not UTF-8 text,
    /// unreadable): the words say why, and [`init`] refuses.
    pub ignore_problem: Option<String>,
    /// More large files or secrets than the lists hold ([`FOUND_CAP`]):
    /// [`init`] refuses rather than commit the ones not named.
    pub found_truncated: bool,
    /// Large files or secrets whose names a `.gitignore` can't hold: [`init`]
    /// refuses until they are renamed.
    pub unnameable: Vec<String>,
    /// Words for the sheet when the scan stopped at its bound, a list was
    /// cut short, or a name can't be left out.
    pub scan_warning: Option<String>,
    /// A partial download from an earlier clone Plyloft couldn't remove.
    pub partial_download: bool,
}

/// What [`inspect`] needs besides the folder.
#[derive(Clone)]
pub struct InspectCtx {
    pub tools: Tools,
    pub home: Option<PathBuf>,
    pub projects_folder: Option<PathBuf>,
    pub workspaces: Vec<WorkspaceRef>,
    pub limits: ScanLimits,
}

/// Pure: `main`, else `master`, else the first (most recent).
pub fn suggest_branch(branches: &[String]) -> Option<String> {
    ["main", "master"]
        .iter()
        .find(|b| branches.iter().any(|x| x == *b))
        .map(|b| b.to_string())
        .or_else(|| branches.first().cloned())
}

/// Pure: the row, in the order the spec's rows take precedence.
pub fn outcome_of(
    refused: bool,
    in_ply: bool,
    git: &GitState,
    branches: &[String],
) -> InspectOutcome {
    if refused {
        return InspectOutcome::Refused;
    }
    if in_ply {
        return InspectOutcome::AlreadyInPly;
    }
    match git {
        GitState::NotRepo => InspectOutcome::NotARepo,
        GitState::InsideAnother { .. } => InspectOutcome::InsideAnotherRepo,
        GitState::Unborn { .. } if branches.is_empty() => InspectOutcome::NoCommits,
        GitState::Unborn { .. } | GitState::Detached { .. } => InspectOutcome::ChooseBranch,
        GitState::Branch { .. } => InspectOutcome::Ready,
    }
}

fn find_workspace(workspaces: &[WorkspaceRef], path: &Path) -> Option<WorkspaceRef> {
    workspaces
        .iter()
        .find(|w| same_path(Path::new(&w.cwd), path))
        .cloned()
}

/// Whether git has a name and email to commit with (any scope).
pub fn identity_ready(tools: &Tools, dir: &Path) -> bool {
    let set = |key: &str| {
        git_read(tools, dir, &["config", "--includes", "--get", key])
            .ok()
            .flatten()
            .is_some_and(|v| !v.trim().is_empty())
    };
    set("user.name") && set("user.email")
}

/// The repository `dir` is in: `Ok(None)` when it isn't in one. An enclosing
/// repository at a refused folder (a home folder kept in Git) doesn't count.
fn enclosing_top_level(
    tools: &Tools,
    dir: &Path,
    home: Option<&Path>,
    projects: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    let ran = git_ran(tools, dir, &["rev-parse", "--show-toplevel"], GIT_READ)?;
    if !ran.ok() {
        let words = ran.stderr.to_ascii_lowercase();
        if words.contains("not a git repository") {
            return Ok(None);
        }
        // Inside a `.git` folder, or a repository git refuses to read
        // (safe.directory): treat as not a project Ply can use.
        return Err(format!("Git couldn't read this folder:\n{}", ran.words()));
    }
    let top = canonical(Path::new(ran.out().trim()));
    let s = |p: Option<&Path>| p.map(|p| canonical(p).to_string_lossy().into_owned());
    if refused_folder(
        &top.to_string_lossy(),
        s(home).as_deref(),
        s(projects).as_deref(),
        cfg!(windows),
    )
    .is_some()
    {
        return Ok(None);
    }
    Ok(Some(top))
}

/// Local branches, most recent commit first.
pub(crate) fn local_branches(tools: &Tools, dir: &Path) -> Vec<String> {
    git_read(
        tools,
        dir,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)",
            "refs/heads/",
        ],
    )
    .ok()
    .flatten()
    .map(|out| {
        out.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect()
    })
    .unwrap_or_default()
}

pub(crate) fn head_commit(tools: &Tools, dir: &Path) -> Option<String> {
    git_read(tools, dir, &["rev-parse", "--verify", "-q", "HEAD^{commit}"])
        .ok()
        .flatten()
        .filter(|c| !c.is_empty())
}

pub(crate) fn head_branch(tools: &Tools, dir: &Path) -> Option<String> {
    git_read(tools, dir, &["symbolic-ref", "-q", "--short", "HEAD"])
        .ok()
        .flatten()
        .filter(|b| !b.is_empty())
}

fn github_origin(tools: &Tools, dir: &Path) -> Option<String> {
    let url = git_read(tools, dir, &["remote", "get-url", "origin"]).ok().flatten()?;
    crate::team::origin_slug(&url)
}

/// Pure: the default `.gitignore` lines not already in `existing`.
pub fn missing_ignore_lines(existing: &str, wanted: &[&str]) -> Vec<String> {
    let have: std::collections::HashSet<&str> = existing.lines().map(str::trim).collect();
    wanted
        .iter()
        .filter(|l| !have.contains(**l))
        .map(|l| l.to_string())
        .collect()
}

/// Read a folder for step 8a (read-only).
pub fn inspect(path: &Path, ctx: &InspectCtx) -> Result<ProjectInspection, String> {
    if !path.is_dir() {
        return Err("That folder isn't there any more.".into());
    }
    let dir = canonical(path);
    let name = folder_name(&dir);
    let s = |p: &Option<PathBuf>| p.as_ref().map(|p| canonical(p).to_string_lossy().into_owned());
    let refused = refused_folder(
        &dir.to_string_lossy(),
        s(&ctx.home).as_deref(),
        s(&ctx.projects_folder).as_deref(),
        cfg!(windows),
    );
    let existing = find_workspace(&ctx.workspaces, &dir);
    let shared_definition = dir.join(crate::workspace_definition::DEFINITION_PATH).is_file();
    let mut report = ProjectInspection {
        path: dir.to_string_lossy().into_owned(),
        name: name.clone(),
        outcome: InspectOutcome::Refused,
        refused,
        refused_words: refused.map(|r| r.words().to_string()),
        git: GitState::NotRepo,
        branches: Vec::new(),
        suggested_branch: None,
        uncommitted_changes: false,
        uncommitted_files: 0,
        work_blocked: None,
        work_tracked: Vec::new(),
        build_folders: Vec::new(),
        nested_projects: Vec::new(),
        work_files: Vec::new(),
        to_save: None,
        large_files: Vec::new(),
        secrets: Vec::new(),
        ignore_lines: Vec::new(),
        existing_workspace: existing.clone(),
        shared_definition,
        identity_ready: false,
        needs_identity: false,
        github_origin: None,
        has_origin: false,
        github_name: None,
        ignore_problem: None,
        found_truncated: false,
        unnameable: Vec::new(),
        scan_warning: None,
        partial_download: dir.join(PARTIAL_MARKER).exists(),
    };
    if refused.is_some() {
        return Ok(report);
    }

    let top = enclosing_top_level(
        &ctx.tools,
        &dir,
        ctx.home.as_deref(),
        ctx.projects_folder.as_deref(),
    )?;
    let git = match &top {
        None => GitState::NotRepo,
        Some(top) if !same_path(top, &dir) => GitState::InsideAnother {
            top_level: top.to_string_lossy().into_owned(),
            name: folder_name(top),
            in_ply: find_workspace(&ctx.workspaces, top),
        },
        Some(_) => {
            let branch = head_branch(&ctx.tools, &dir);
            match (head_commit(&ctx.tools, &dir), branch) {
                (Some(commit), Some(branch)) => GitState::Branch { branch, commit },
                (Some(commit), None) => GitState::Detached { commit },
                (None, branch) => GitState::Unborn { branch },
            }
        }
    };
    let is_repo_here = matches!(
        git,
        GitState::Unborn { .. } | GitState::Branch { .. } | GitState::Detached { .. }
    );
    if is_repo_here {
        report.branches = local_branches(&ctx.tools, &dir);
        report.suggested_branch = suggest_branch(&report.branches);
        report.github_origin = github_origin(&ctx.tools, &dir);
        report.has_origin = git_read(&ctx.tools, &dir, &["remote", "get-url", "origin"]).ok().flatten().is_some();
        if !report.has_origin {
            report.github_name = Some(slugify(&report.name).unwrap_or_else(|_| report.name.clone()));
        }
    }
    report.outcome = outcome_of(false, existing.is_some(), &git, &report.branches);
    report.git = git;
    if report.outcome == InspectOutcome::AlreadyInPly {
        return Ok(report);
    }

    let first_commit = matches!(
        report.outcome,
        InspectOutcome::NotARepo | InspectOutcome::NoCommits
    );
    if first_commit {
        let scan = if report.outcome == InspectOutcome::NotARepo {
            walk(&dir, &ctx.limits)
        } else {
            scan_repo(&ctx.tools, &dir, &ctx.limits)?
        };
        fill_scan(&mut report, scan, &dir, &ctx.limits);
    }
    if matches!(report.git, GitState::Branch { .. } | GitState::Detached { .. }) {
        report.uncommitted_files = unsaved_files(&ctx.tools, &dir).unwrap_or(0);
        report.uncommitted_changes = report.uncommitted_files > 0;
        if report.uncommitted_changes && work_in_progress(&ctx.tools, &dir) {
            report.work_blocked = Some(WORK_IN_PROGRESS.into());
        }
    }
    report.identity_ready = identity_ready(&ctx.tools, &dir);
    report.needs_identity = first_commit && !report.identity_ready;
    Ok(report)
}

/// The consent sheet's facts from a scan: what would be saved, the large
/// files and secrets found, and the `.gitignore` lines the save would add.
fn fill_scan(report: &mut ProjectInspection, scan: Scan, dir: &Path, limits: &ScanLimits) {
    let summary = scan.summary(limits);
    report.scan_warning = scan_warning(&summary, scan.found_truncated, &scan.unnameable);
    report.to_save = Some(summary);
    report.large_files = scan.large;
    report.secrets = scan.secrets;
    report.found_truncated = scan.found_truncated;
    report.unnameable = scan.unnameable;
    match read_ignore(&dir.join(".gitignore")) {
        Ok(existing) => {
            report.ignore_lines = missing_ignore_lines(existing.as_deref().unwrap_or(""), INIT_IGNORE)
        }
        Err(words) => report.ignore_problem = Some(words),
    }
}

/// 1.171.0 D3: how many files or folders have changes Git hasn't saved
/// (`git status` lines, a new folder counted once, ignored ones not). Read
/// without Git's optional lock, so a look never gets in the way of the
/// person's own Git. `None` when Git couldn't say.
pub fn unsaved_files(tools: &Tools, dir: &Path) -> Option<u32> {
    git_read(
        tools,
        dir,
        &["--no-optional-locks", "status", "--porcelain", "--untracked-files=normal"],
    )
    .ok()
    .flatten()
    .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
}

pub const WORK_IN_PROGRESS: &str = "Git is in the middle of combining changes in this folder, so Plyloft won't save them now. Finish that first, or start from the last saved version.";

/// 1.171.0 D3: Git is in the middle of a merge, cherry-pick, revert or
/// rebase, or has files with unresolved conflicts — a save would commit
/// half of it.
pub fn work_in_progress(tools: &Tools, dir: &Path) -> bool {
    let marked = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]
        .iter()
        .any(|name| {
            git_read(tools, dir, &["rev-parse", "--git-path", name])
                .ok()
                .flatten()
                .is_some_and(|p| dir.join(p).exists())
        });
    marked
        || git_read(tools, dir, &["--no-optional-locks", "ls-files", "-u"])
            .ok()
            .flatten()
            .is_some_and(|s| !s.trim().is_empty())
}

// ── 8a: making it a Git project ────────────────────────────────────────

/// The person's choices on the "Make it a Git project?" sheet: the files
/// (from the inspection's large files and secrets) left ticked to be left
/// out. Every path must be one the scan found again.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InitChoices {
    pub leave_out: Vec<String>,
    /// The person saw that the count stopped at its bound (files past it
    /// weren't checked for secrets or size) and chose to go on.
    #[serde(default)]
    pub accept_incomplete: bool,
}

/// What [`init`] did.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitDone {
    pub path: String,
    pub branch: String,
    pub commit: String,
    /// `git init` ran (the folder wasn't a repository).
    pub initialised: bool,
    /// The lines added to `.gitignore`.
    pub ignore_added: Vec<String>,
}

/// Pure: one path as a `.gitignore` line matching exactly that file from the
/// top (`/a/b.txt`), its special characters escaped. `None` for a name a
/// `.gitignore` can't hold (a line break).
pub fn ignore_line_for(rel: &str) -> Option<String> {
    if rel.is_empty() || rel.contains('\n') || rel.contains('\r') {
        return None;
    }
    let mut out = String::from("/");
    for c in rel.chars() {
        if matches!(c, '*' | '?' | '[' | '\\' | '!' | '#') {
            out.push('\\');
        }
        out.push(c);
    }
    if out.ends_with(' ') {
        let trimmed = out.trim_end_matches(' ').len();
        let spaces = out.len() - trimmed;
        out.truncate(trimmed);
        for _ in 0..spaces {
            out.push_str("\\ ");
        }
    }
    Some(out)
}

/// Pure: the new `.gitignore` text and the lines added: the defaults not
/// already there, then each file left out, then — for a `.env` secret the
/// person unticked, which the defaults would still leave out — a `!` line
/// that keeps it in.
pub fn plan_ignore(
    existing: &str,
    defaults: &[&str],
    leave_out: &[String],
    kept_env_secrets: &[String],
) -> (String, Vec<String>) {
    let mut added = missing_ignore_lines(existing, defaults);
    let have: std::collections::HashSet<String> =
        existing.lines().map(|l| l.trim().to_string()).collect();
    for rel in leave_out {
        if let Some(line) = ignore_line_for(rel) {
            if !have.contains(&line) && !added.contains(&line) {
                added.push(line);
            }
        }
    }
    for rel in kept_env_secrets {
        if let Some(line) = ignore_line_for(rel) {
            let keep = format!("!{line}");
            if !have.contains(&keep) && !added.contains(&keep) {
                added.push(keep);
            }
        }
    }
    if added.is_empty() {
        return (existing.to_string(), added);
    }
    let mut text = existing.to_string();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    if !text.is_empty() {
        text.push('\n');
    }
    text.push_str(IGNORE_HEADER);
    text.push('\n');
    for line in &added {
        text.push_str(line);
        text.push('\n');
    }
    (text, added)
}

/// Whether the defaults ([`INIT_IGNORE`]) leave this `.env` file out — case
/// folded, as git matches on a Mac (`core.ignorecase`).
fn default_ignores_env(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    !ENV_TEMPLATES.contains(&name.as_str()) && (name == ".env" || name.starts_with(".env."))
}

/// Pure: the `.env` secrets left ticked off whose default ignore line would
/// still drop them — each gets a `!/<path>` keep line.
pub fn kept_env_secrets(secrets: &[String], leave_out: &[String]) -> Vec<String> {
    secrets
        .iter()
        .filter(|s| !leave_out.contains(s) && default_ignores_env(s))
        .cloned()
        .collect()
}

/// OB-12: the lines [`init`] would add to `dir/.gitignore` for these
/// choices — exactly [`plan_ignore`]'s, for the consent sheet's Details.
/// `secrets` are the inspection's (only used to find `.env` keep lines).
pub fn ignore_plan(dir: &Path, secrets: &[String], leave_out: &[String]) -> Result<Vec<String>, String> {
    let original = read_ignore(&dir.join(".gitignore"))?;
    let kept = kept_env_secrets(secrets, leave_out);
    Ok(plan_ignore(original.as_deref().unwrap_or(""), INIT_IGNORE, leave_out, &kept).1)
}

/// Pure: the sheet's words when Plyloft can't vouch for the whole list.
pub fn scan_warning(summary: &SaveSummary, truncated: bool, unnameable: &[String]) -> Option<String> {
    if !unnameable.is_empty() {
        return Some(format!(
            "Some files that look like keys or are very large have names Git's ignore list can't hold ({}). Rename them, then look again.",
            unnameable.iter().take(3).cloned().collect::<Vec<_>>().join(", ")
        ));
    }
    if truncated {
        return Some(format!(
            "There are more than {FOUND_CAP} large files or likely keys here. Plyloft won't save this folder in one go: add a .gitignore for them, then look again."
        ));
    }
    if !summary.complete {
        return Some(
            "Plyloft stopped counting at 50 000 files or 5 seconds, so files past that weren't checked for keys or size. Check the list of what's left out before continuing.".into(),
        );
    }
    None
}

/// `.gitignore`'s text: `Ok(None)` when there is none. A link, a folder, a
/// file Plyloft can't read, or one that isn't UTF-8 text is refused in words
/// — Plyloft never rewrites what it can't read back exactly.
pub fn read_ignore(path: &Path) -> Result<Option<String>, String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Plyloft couldn't read this folder's .gitignore ({e}).")),
    };
    if meta.file_type().is_symlink() {
        return Err("This folder's .gitignore is a link to another file, so Plyloft won't change it. Add the lines yourself, then look again.".into());
    }
    if !meta.is_file() {
        return Err("This folder's .gitignore isn't a file, so Plyloft won't change it.".into());
    }
    let bytes = std::fs::read(path)
        .map_err(|e| format!("Plyloft couldn't read this folder's .gitignore ({e})."))?;
    String::from_utf8(bytes).map(Some).map_err(|_| {
        "This folder's .gitignore isn't plain UTF-8 text, so Plyloft won't change it. Save it as UTF-8, then look again.".to_string()
    })
}

/// What Plyloft wrote to `.gitignore`, so a failure takes back exactly that.
enum IgnoreWrite {
    Nothing,
    /// Plyloft created the file with this text.
    Created(String),
    /// Plyloft appended to a file that held `before` and now holds `after`.
    Appended { before: usize, after: String },
}

/// Write the planned `.gitignore`: a new file created only if none exists, an
/// existing one appended to (never replaced). `wrote` is set to what Plyloft
/// is writing *before* the bytes go out, so a write that fails halfway is
/// still taken back by [`undo_ignore`].
fn write_ignore(
    path: &Path,
    original: Option<&str>,
    text: &str,
    wrote: &mut IgnoreWrite,
) -> Result<(), String> {
    use std::io::Write;
    let words = |e: std::io::Error| format!("Plyloft couldn't write .gitignore ({e}).");
    match original {
        None => {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(words)?;
            // The file is Plyloft's from here on.
            *wrote = IgnoreWrite::Created(text.to_string());
            file.write_all(text.as_bytes()).map_err(words)?;
            file.sync_all().map_err(words)?;
        }
        Some(before) if text.len() > before.len() && text.starts_with(before) => {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(path)
                .map_err(words)?;
            *wrote = IgnoreWrite::Appended {
                before: before.len(),
                after: text.to_string(),
            };
            file.write_all(&text.as_bytes()[before.len()..]).map_err(words)?;
            file.sync_all().map_err(words)?;
        }
        Some(_) => {}
    }
    Ok(())
}

/// Take back what [`write_ignore`] wrote (all of it, or the part a failed
/// write got out) — only while the file holds nothing but that: Plyloft's
/// bytes, or the original followed by a start of Plyloft's tail. An edit
/// made meanwhile is the person's, and stays.
fn undo_ignore(path: &Path, wrote: &IgnoreWrite) {
    let Ok(now) = std::fs::read(path) else {
        return;
    };
    match wrote {
        IgnoreWrite::Nothing => {}
        IgnoreWrite::Created(text) => {
            if text.as_bytes().starts_with(&now) {
                let _ = std::fs::remove_file(path);
            }
        }
        IgnoreWrite::Appended { before, after } => {
            if now.len() >= *before && after.as_bytes().starts_with(&now) {
                if let Ok(file) = std::fs::OpenOptions::new().write(true).open(path) {
                    let _ = file.set_len(*before as u64);
                }
            }
        }
    }
}

/// `git init -b main`, or on a git too old for `-b`, `git init` and HEAD
/// pointed at `main`.
fn git_init_main(tools: &Tools, dir: &Path) -> Result<(), String> {
    let ran = git_ran(tools, dir, &["init", "-b", "main"], GIT_READ)?;
    if ran.ok() {
        return Ok(());
    }
    git_step(tools, dir, &["init"], GIT_READ)?;
    git_step(tools, dir, &["symbolic-ref", "HEAD", "refs/heads/main"], GIT_READ)?;
    Ok(())
}

/// Step 8a's `[Start Git and add]` / `[Save the first version]`: `git init
/// -b main` (when not a repository), the `.gitignore` lines, `git add -A`,
/// `git commit -m "chore: first commit"`. Re-inspects first and acts only on what
/// it finds; a failure puts `.gitignore` back and removes the `.git` it made.
pub fn init(path: &Path, choices: &InitChoices, ctx: &InspectCtx) -> Result<InitDone, String> {
    let report = inspect(path, ctx)?;
    match report.outcome {
        InspectOutcome::NotARepo | InspectOutcome::NoCommits => {}
        InspectOutcome::Refused => {
            return Err(report.refused_words.unwrap_or_else(|| REFUSED_HOME.into()))
        }
        InspectOutcome::AlreadyInPly => return Err(format!("“{}” is already in Plyloft.", report.name)),
        InspectOutcome::InsideAnotherRepo => {
            return Err(format!(
                "“{}” is inside another Git project. Plyloft never makes a Git project inside another one.",
                report.name
            ))
        }
        InspectOutcome::ChooseBranch | InspectOutcome::Ready => {
            return Err(format!("“{}” already has a saved version.", report.name))
        }
    }
    if !report.identity_ready {
        return Err(IDENTITY_NEEDED.into());
    }
    if let Some(words) = &report.ignore_problem {
        return Err(words.clone());
    }
    if !report.unnameable.is_empty() || report.found_truncated {
        return Err(report.scan_warning.clone().unwrap_or_default());
    }
    if report.to_save.as_ref().is_some_and(|s| !s.complete) && !choices.accept_incomplete {
        return Err(report.scan_warning.clone().unwrap_or_default());
    }
    let found: Vec<&FoundFile> = report.large_files.iter().chain(&report.secrets).collect();
    for rel in &choices.leave_out {
        if !found.iter().any(|f| &f.path == rel) {
            return Err(
                "One of the files to leave out isn't in this folder any more. Look again.".into(),
            );
        }
    }
    let secrets: Vec<String> = report.secrets.iter().map(|s| s.path.clone()).collect();
    let kept_env = kept_env_secrets(&secrets, &choices.leave_out);

    let dir = PathBuf::from(&report.path);
    let ignore_path = dir.join(".gitignore");
    let original = read_ignore(&ignore_path)?;
    let initialise = report.outcome == InspectOutcome::NotARepo;
    if initialise && std::fs::symlink_metadata(dir.join(".git")).is_ok() {
        return Err("This folder already has a .git folder. Look again.".into());
    }
    let (text, added) = plan_ignore(
        original.as_deref().unwrap_or(""),
        INIT_IGNORE,
        &choices.leave_out,
        &kept_env,
    );

    // The index as it was (a repository with no commit may have staged
    // files): put back exactly on failure.
    let index = if initialise {
        None
    } else {
        git_read(&ctx.tools, &dir, &["rev-parse", "--git-path", "index"])?
            .map(|p| dir.join(p))
            .map(|p| (std::fs::read(&p).ok(), p))
    };
    let mut wrote = IgnoreWrite::Nothing;
    let result = (|| -> Result<InitDone, String> {
        if initialise {
            git_init_main(&ctx.tools, &dir)?;
        }
        if !added.is_empty() {
            write_ignore(&ignore_path, original.as_deref(), &text, &mut wrote)?;
        }
        git_step(&ctx.tools, &dir, &["add", "-A"], GIT_ADD)?;
        // A file left out that was already staged stays staged whatever
        // .gitignore says: take it out of the index (the file stays).
        if !choices.leave_out.is_empty() {
            let mut args: Vec<&str> =
                vec!["--literal-pathspecs", "rm", "--cached", "-q", "--ignore-unmatch", "--"];
            args.extend(choices.leave_out.iter().map(String::as_str));
            git_step(&ctx.tools, &dir, &args, GIT_ADD)?;
        }
        git_step(&ctx.tools, &dir, &["commit", "-q", "-m", crate::commit_message::FIRST_COMMIT], GIT_COMMIT)?;
        // Observed, not assumed (spec §4 principle 4).
        let commit = head_commit(&ctx.tools, &dir)
            .ok_or_else(|| "Git didn't record the first commit.".to_string())?;
        let branch = head_branch(&ctx.tools, &dir).unwrap_or_else(|| "main".into());
        Ok(InitDone {
            path: report.path.clone(),
            branch,
            commit,
            initialised: initialise,
            ignore_added: added.clone(),
        })
    })();
    if result.is_err() {
        // Put the folder back as it was.
        undo_ignore(&ignore_path, &wrote);
        if initialise {
            let _ = std::fs::remove_dir_all(dir.join(".git"));
        } else if let Some((before, path)) = &index {
            // Unstage what `git add -A` staged; the files stay.
            match before {
                Some(bytes) => {
                    let _ = std::fs::write(path, bytes);
                }
                None => {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }
    result
}

// ── 8a: saving the work in a folder that has commits (1.171.0 D3) ──────

pub const NOTHING_TO_SAVE: &str = "This folder has no changes to save now. Look again.";
pub const IDENTITY_FOR_SAVE: &str = "Git needs your name and email before Plyloft can save your work.";
pub const ALL_LEFT_OUT: &str =
    "Everything that changed is left out, so there's nothing to save. Add the project without saving, or tick fewer files.";
pub const WORK_TOO_BIG: &str = "This folder has too many changed files for Plyloft to check them all. Leave your changes in the folder, or save them in Git yourself first.";
pub const SAVE_HOOK_REFUSED: &str = "Your project's check before saving refused it, so nothing was saved. A check that tidies files may have changed some of them.";
pub const SAVE_REFUSED: &str = "Git couldn't save your work, so nothing was saved.";

/// What [`scan_work`] found besides the count.
#[derive(Debug, Default)]
pub struct WorkScan {
    pub scan: Scan,
    /// Changed files Git already has (the `git diff HEAD` side).
    pub tracked: std::collections::HashSet<String>,
    /// New build/package folders (`node_modules/`), with their file count.
    pub folders: BTreeMap<String, u64>,
    /// Folders that are Git projects of their own.
    pub nested: Vec<String>,
    /// The files counted, by name, for the sheet's list (bounded by the
    /// scan's own limits).
    pub names: Vec<String>,
}

/// The save-work sheet names at most this many files ("and N more").
pub const WORK_FILES_LISTED: usize = 20;

/// Pure: the build/package folder (`app/node_modules/`) a path is under,
/// when one of its folders is one of [`IGNORED_DIRS`].
pub fn build_folder_of(rel: &str) -> Option<String> {
    let parts: Vec<&str> = rel.split('/').collect();
    let dirs = &parts[..parts.len().saturating_sub(1)];
    let at = dirs.iter().position(|p| IGNORED_DIRS.contains(p))?;
    Some(format!("{}/", dirs[..=at].join("/")))
}

/// Count what saving the folder's current work would put in Git: the files
/// changed since the last commit (staged or not; submodule pointers aside)
/// and the new files Git doesn't ignore. New files under a build or package
/// folder are gathered as that folder (no default ignore line is added, so
/// `git add -A` would save them); a new folder that is a Git project of its
/// own is named, never scanned. Bounded; deleted files not counted.
pub fn scan_work(tools: &Tools, dir: &Path, limits: &ScanLimits) -> Result<WorkScan, String> {
    let deadline = Instant::now() + limits.max_time;
    let mut out = WorkScan { scan: Scan::new(), ..Default::default() };
    out.scan.count_all = true;
    let mut seen: std::collections::HashSet<Vec<u8>> = std::collections::HashSet::new();
    for (tracked, args) in [
        (true, &["--no-optional-locks", "diff", "-z", "--name-only", "--no-renames", "--ignore-submodules=all", "HEAD"][..]),
        (false, &["--no-optional-locks", "ls-files", "-z", "--others", "--exclude-standard"][..]),
    ] {
        let mut command = tools.git_in(dir);
        command.args(args);
        let mut full = true;
        let complete = stream_paths(command, deadline, |raw| {
            if !seen.insert(raw.to_vec()) {
                return true;
            }
            let rel = String::from_utf8_lossy(raw).into_owned();
            if !tracked {
                // `ls-files --others` names a nested repository as `dir/`.
                if rel.ends_with('/') {
                    out.nested.push(rel.trim_end_matches('/').to_string());
                    return true;
                }
                if let Some(folder) = build_folder_of(&rel) {
                    *out.folders.entry(folder).or_insert(0) += 1;
                    return true;
                }
            }
            let Ok(meta) = std::fs::symlink_metadata(dir.join(path_from_bytes(raw))) else {
                return true;
            };
            let name_ok = std::str::from_utf8(raw).is_ok_and(name_fits);
            if tracked {
                out.tracked.insert(rel.clone());
            }
            out.names.push(rel.clone());
            full = out.scan.add(&rel, meta.len(), limits, name_ok);
            full
        })?;
        if !complete || !full {
            out.scan.complete = false;
            break;
        }
    }
    Ok(out)
}

/// Step 8a's "Save my current work first" sheet: the inspection of a folder
/// on a branch with changes not committed, with what saving them would put
/// in Git (read-only).
pub fn inspect_work(path: &Path, ctx: &InspectCtx) -> Result<ProjectInspection, String> {
    Ok(look_work(path, ctx)?.0)
}

fn look_work(path: &Path, ctx: &InspectCtx) -> Result<(ProjectInspection, WorkScan), String> {
    let mut report = inspect(path, ctx)?;
    if report.outcome != InspectOutcome::Ready || !report.uncommitted_changes {
        return Err(NOTHING_TO_SAVE.into());
    }
    if let Some(words) = &report.work_blocked {
        return Err(words.clone());
    }
    let dir = PathBuf::from(&report.path);
    let mut work = scan_work(&ctx.tools, &dir, &ctx.limits)?;
    let scan = std::mem::take(&mut work.scan);
    fill_scan(&mut report, scan, &dir, &ctx.limits);
    // No default lines are added to a project that already has commits.
    report.ignore_lines = Vec::new();
    report.work_tracked = report
        .large_files
        .iter()
        .chain(&report.secrets)
        .filter(|f| work.tracked.contains(&f.path))
        .map(|f| f.path.clone())
        .collect();
    report.build_folders = work
        .folders
        .iter()
        .map(|(path, files)| FoundFolder { path: path.clone(), files: *files })
        .collect();
    report.nested_projects = work.nested.clone();
    report.work_files = work_files_listed(&work.names, &report.large_files, &report.secrets);
    Ok((report, work))
}

/// Pure: the files the save-work sheet names — the scanned ones, without
/// the large files and secrets it lists apart, sorted, at most
/// [`WORK_FILES_LISTED`] (a large file or secret the person chooses to save
/// is named by the sheet itself).
pub fn work_files_listed(names: &[String], large: &[FoundFile], secrets: &[FoundFile]) -> Vec<String> {
    let mut kept: Vec<&String> = names
        .iter()
        .filter(|n| !large.iter().chain(secrets).any(|f| &f.path == *n))
        .collect();
    kept.sort();
    kept.into_iter().take(WORK_FILES_LISTED).cloned().collect()
}

/// The `.gitignore` lines [`save_work`] adds: one `/path` for each new file
/// or folder left out, none for a file Git already has (its saved version is
/// kept) and no default lines. Read-only.
pub fn work_ignore_plan(dir: &Path, untracked_leave_out: &[String]) -> Result<Vec<String>, String> {
    let original = read_ignore(&dir.join(".gitignore"))?;
    Ok(plan_ignore(original.as_deref().unwrap_or(""), &[], untracked_leave_out, &[]).1)
}

/// Pure: the paths of `git diff --cached --raw -z` whose old or new mode is
/// a submodule's (160000).
pub fn gitlink_paths(raw: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut fields = raw.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let Some(head) = fields.next() {
        let head = String::from_utf8_lossy(head);
        let Some(path) = fields.next() else { break };
        let modes: Vec<&str> = head.trim_start_matches(':').split(' ').take(2).collect();
        if modes.contains(&"160000") {
            out.push(String::from_utf8_lossy(path).into_owned());
        }
    }
    out
}

/// What [`save_work`] did.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkDone {
    pub path: String,
    /// The branch the commit went on: the folder's own, never switched.
    pub branch: String,
    pub commit: String,
    /// The lines added to `.gitignore`.
    pub ignore_added: Vec<String>,
}

/// Step 8a's "Save my current work first", on the person's press only: one
/// commit of the folder's current changes on the branch it is on. Local only
/// — nothing is pushed. Re-inspects first and acts only on what it finds.
///
/// Unlike a first commit, it adds no default `.gitignore` lines (the project
/// already has its own rules): only a `/path` line for each new file or
/// folder the person left out. A changed file Git already has, left out,
/// keeps its saved version (`git reset`, never `git rm --cached`).
/// Submodule pointers and projects inside this one are never saved here.
///
/// The person's own signing and hook settings apply as they are (no
/// `commit.gpgSign=false`, unlike Plyloft's own card commits): this is
/// their commit on their own branch. A refusal (a hook, a signing key)
/// puts `.gitignore` and the index back and says so in plain words, Git's
/// output after a blank line.
pub fn save_work(path: &Path, choices: &InitChoices, ctx: &InspectCtx) -> Result<SaveWorkDone, String> {
    let (report, work) = look_work(path, ctx)?;
    let GitState::Branch { branch, commit: before } = &report.git else {
        return Err(NOTHING_TO_SAVE.into());
    };
    if !report.identity_ready {
        return Err(IDENTITY_FOR_SAVE.into());
    }
    if let Some(words) = &report.ignore_problem {
        return Err(words.clone());
    }
    if !report.unnameable.is_empty() || report.found_truncated {
        return Err(report.scan_warning.clone().unwrap_or_default());
    }
    // Never on a count that stopped: what wasn't seen would be saved unseen.
    if report.to_save.as_ref().is_some_and(|s| !s.complete) {
        return Err(WORK_TOO_BIG.into());
    }
    let found: Vec<&str> = report
        .large_files
        .iter()
        .chain(&report.secrets)
        .map(|f| f.path.as_str())
        .chain(report.build_folders.iter().map(|f| f.path.as_str()))
        .collect();
    for rel in &choices.leave_out {
        if !found.contains(&rel.as_str()) {
            return Err(
                "One of the files to leave out isn't in this folder any more. Look again.".into(),
            );
        }
    }
    let untracked: Vec<String> = choices
        .leave_out
        .iter()
        .filter(|p| !work.tracked.contains(*p))
        .cloned()
        .collect();

    let dir = PathBuf::from(&report.path);
    let ignore_path = dir.join(".gitignore");
    let original = read_ignore(&ignore_path)?;
    let (text, added) = plan_ignore(original.as_deref().unwrap_or(""), &[], &untracked, &[]);
    // The index as it was (the person may have staged part of the work):
    // put back exactly on failure.
    let index = git_read(&ctx.tools, &dir, &["rev-parse", "--git-path", "index"])?
        .map(|p| dir.join(p.trim()))
        .map(|p| (std::fs::read(&p).ok(), p));
    let mut wrote = IgnoreWrite::Nothing;
    let result = (|| -> Result<SaveWorkDone, String> {
        if !added.is_empty() {
            write_ignore(&ignore_path, original.as_deref(), &text, &mut wrote)?;
        }
        git_step(&ctx.tools, &dir, &["add", "-A"], GIT_ADD)?;
        // Left out: back to the saved version in the index (a new one leaves
        // it); submodule pointers and nested projects too. The files in the
        // folder stay as they are.
        let raw = git_ran(&ctx.tools, &dir, &["diff", "--cached", "--raw", "-z", "--no-renames"], GIT_READ)?;
        let mut reset: Vec<String> = choices
            .leave_out
            .iter()
            .map(|p| p.trim_end_matches('/').to_string())
            .collect();
        reset.extend(gitlink_paths(raw.stdout.as_bytes()));
        if !reset.is_empty() {
            let mut args: Vec<&str> = vec!["--literal-pathspecs", "reset", "-q", "--"];
            args.extend(reset.iter().map(String::as_str));
            git_step(&ctx.tools, &dir, &args, GIT_ADD)?;
        }
        if git_ran(&ctx.tools, &dir, &["diff", "--cached", "--quiet"], GIT_READ)?.ok() {
            return Err(ALL_LEFT_OUT.into());
        }
        let ran = git_ran(
            &ctx.tools,
            &dir,
            &["commit", "-q", "-m", crate::commit_message::SAVE_WORK],
            GIT_COMMIT,
        )?;
        if !ran.ok() {
            let words = if has_commit_hook(&ctx.tools, &dir) { SAVE_HOOK_REFUSED } else { SAVE_REFUSED };
            return Err(format!("{words}\n\n{}", ran.words()));
        }
        // Observed, not assumed: a new commit, on the same branch.
        let commit = head_commit(&ctx.tools, &dir)
            .filter(|c| c != before)
            .ok_or_else(|| "Git didn't record the save.".to_string())?;
        let now_on = head_branch(&ctx.tools, &dir).unwrap_or_default();
        if &now_on != branch {
            return Err("The folder changed branch while Plyloft was saving. Look again.".into());
        }
        Ok(SaveWorkDone {
            path: report.path.clone(),
            branch: branch.clone(),
            commit,
            ignore_added: added.clone(),
        })
    })();
    if result.is_err() {
        undo_ignore(&ignore_path, &wrote);
        if let Some((before, path)) = &index {
            match before {
                Some(bytes) => {
                    let _ = std::fs::write(path, bytes);
                }
                None => {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }
    result
}

/// Whether the project has a hook that runs on a commit (`pre-commit`,
/// `commit-msg`), wherever `core.hooksPath` puts it.
fn has_commit_hook(tools: &Tools, dir: &Path) -> bool {
    ["hooks/pre-commit", "hooks/commit-msg", "hooks/prepare-commit-msg"].iter().any(|h| {
        git_read(tools, dir, &["rev-parse", "--git-path", h])
            .ok()
            .flatten()
            .is_some_and(|p| dir.join(p).is_file())
    })
}

// ── 8c: a new project ──────────────────────────────────────────────────

/// Windows' reserved device names: never a folder name (refused on every
/// platform, so a project can move between computers).
const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com0", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
    "com8", "com9", "lpt0", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

fn fold_accent(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => "a",
        'æ' => "ae",
        'ç' | 'ć' | 'č' => "c",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ę' | 'ě' => "e",
        'ì' | 'í' | 'î' | 'ï' | 'ī' => "i",
        'ñ' | 'ń' | 'ň' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' => "o",
        'œ' => "oe",
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' => "u",
        'ý' | 'ÿ' => "y",
        'ß' => "ss",
        'ś' | 'š' => "s",
        'ź' | 'ż' | 'ž' => "z",
        'ł' => "l",
        'ř' => "r",
        'ť' => "t",
        'ď' => "d",
        _ => return None,
    })
}

/// Pure: a project name's folder name — lowercase ASCII letters and digits,
/// every other run one hyphen, accents folded (`Café Menu` → `cafe-menu`),
/// at most [`SLUG_MAX`]. Refused (with the spec's words) when nothing is left
/// or it is a reserved name.
pub fn slugify(name: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut hyphen = false;
    for c in name.chars().flat_map(|c| c.to_lowercase()) {
        let piece: Option<String> = if c.is_ascii_alphanumeric() {
            Some(c.to_string())
        } else {
            fold_accent(c).map(String::from)
        };
        match piece {
            Some(p) => {
                if hyphen && !out.is_empty() {
                    out.push('-');
                }
                hyphen = false;
                out.push_str(&p);
            }
            None => hyphen = true,
        }
    }
    if out.len() > SLUG_MAX {
        out.truncate(SLUG_MAX);
        while out.ends_with('-') {
            out.pop();
        }
    }
    if out.is_empty() || RESERVED.contains(&out.as_str()) {
        return Err(NAME_NEEDS_LETTERS.into());
    }
    Ok(out)
}

/// Pure: the display name, trimmed, one line, at most 100 characters.
pub fn clean_project_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.chars().any(char::is_control) {
        return Err("A project name is one line.".into());
    }
    if name.chars().count() > 100 {
        return Err("Choose a name under 100 characters.".into());
    }
    if name.is_empty() {
        return Err(NAME_NEEDS_LETTERS.into());
    }
    Ok(name.to_string())
}

/// What is at the new project's folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FolderState {
    Missing,
    /// Used without asking.
    Empty,
    /// *There's already a folder called “my-app” with files in it.*
    HasFiles,
    /// A file (not a folder) has that name.
    NotAFolder,
}

pub fn folder_state(path: &Path) -> FolderState {
    match std::fs::symlink_metadata(path) {
        Err(_) => FolderState::Missing,
        Ok(meta) if !meta.is_dir() => FolderState::NotAFolder,
        Ok(_) => match std::fs::read_dir(path).map(|mut e| e.next().is_none()) {
            Ok(true) => FolderState::Empty,
            _ => FolderState::HasFiles,
        },
    }
}

/// What the name field shows live, and whether `[Create project]` can go.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPreview {
    pub name: String,
    pub slug: Option<String>,
    /// Where it goes (absolute) and as shown (`~/Projects/my-app`).
    pub path: Option<String>,
    pub display_path: Option<String>,
    pub folder: Option<FolderState>,
    /// The parent is inside another Git project (`name` of it).
    pub inside_repo: Option<String>,
    /// Words when it can't be created as it is.
    pub problem: Option<String>,
    /// The place is refused (a system folder, a disk's root, home itself).
    pub place_refused: bool,
}

/// Pure-ish: the preview for `name` under `parent` (no writes).
pub fn new_preview(name: &str, parent: &Path, tools: &Tools, home: Option<&Path>) -> NewPreview {
    let mut preview = NewPreview {
        name: name.trim().to_string(),
        slug: None,
        path: None,
        display_path: None,
        folder: None,
        inside_repo: None,
        problem: None,
        place_refused: false,
    };
    let slug = match clean_project_name(name).and_then(|n| slugify(&n)) {
        Ok(slug) => slug,
        Err(words) => {
            preview.problem = Some(words);
            return preview;
        }
    };
    let dest = parent.join(&slug);
    let state = folder_state(&dest);
    preview.slug = Some(slug.clone());
    preview.display_path = Some(display_path(&dest, home));
    preview.path = Some(dest.to_string_lossy().into_owned());
    preview.folder = Some(state);
    preview.problem = match state {
        FolderState::HasFiles => Some(format!(
            "There's already a folder called “{slug}” with files in it."
        )),
        FolderState::NotAFolder => Some(format!("There's already a file called “{slug}” there.")),
        _ => None,
    };
    if let Some(words) = place_refusal(parent, &dest, home) {
        preview.problem = Some(words.into());
        preview.place_refused = true;
    }
    if parent.is_dir() {
        if let Ok(Some(top)) = enclosing_top_level(tools, parent, home, None) {
            let name = folder_name(&top);
            preview.problem.get_or_insert_with(|| {
                format!("That folder is inside another Git project, “{name}”. Choose another place.")
            });
            preview.inside_repo = Some(name);
        }
    }
    preview
}

/// A new project's request (spec §5 step 8c).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NewProjectRequest {
    pub name: String,
    /// Absolute; `None` = the projects folder.
    #[serde(default)]
    pub parent: Option<String>,
    /// `Also keep a private copy on GitHub` (off by default, D10): the login
    /// that owns it.
    #[serde(default)]
    pub github_copy: Option<GithubCopyRequest>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GithubCopyRequest {
    pub login: String,
}

/// What happened to the GitHub copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GithubCopyState {
    Created,
    /// *You already have a repository called my-app on GitHub.*
    NameTaken,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCopyResult {
    pub state: GithubCopyState,
    /// `login/slug`.
    pub repo: String,
    pub words: Option<String>,
}

/// [`create_new`]'s answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum NewProjectOutcome {
    #[serde(rename_all = "camelCase")]
    Created {
        path: String,
        name: String,
        slug: String,
        branch: String,
        commit: String,
        github: Option<GithubCopyResult>,
    },
    /// `Add that folder instead` (goes to 8a with it) · `Choose another name`.
    #[serde(rename_all = "camelCase")]
    FolderHasFiles { path: String, slug: String, words: String },
    /// The name can't be a folder name, or the place is refused.
    Refused { words: String },
    IdentityNeeded { words: String },
}

/// Pure: gh's "that name is taken" answer.
pub fn is_name_taken(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("name already exists") || lower.contains("already exists on this account")
}

/// Step 8c: make the folder, `git init -b main`, README.md (`# Name`), an
/// OS-files `.gitignore`, `git commit -m "Start Name"`; then, when asked, the
/// private GitHub copy. A failure before the commit removes what Ply made
/// (the whole folder when Ply created it).
pub fn create_new(
    request: &NewProjectRequest,
    parent: &Path,
    tools: &Tools,
    home: Option<&Path>,
    token: Option<&GhToken>,
) -> Result<NewProjectOutcome, String> {
    let name = match clean_project_name(&request.name) {
        Ok(n) => n,
        Err(words) => return Ok(NewProjectOutcome::Refused { words }),
    };
    let preview = new_preview(&name, parent, tools, home);
    let (Some(slug), Some(folder)) = (preview.slug.clone(), preview.folder) else {
        return Ok(NewProjectOutcome::Refused {
            words: preview.problem.unwrap_or_else(|| NAME_NEEDS_LETTERS.into()),
        });
    };
    let dest = parent.join(&slug);
    if preview.place_refused {
        return Ok(NewProjectOutcome::Refused {
            words: preview.problem.unwrap_or_default(),
        });
    }
    match folder {
        FolderState::HasFiles => {
            return Ok(NewProjectOutcome::FolderHasFiles {
                path: dest.to_string_lossy().into_owned(),
                slug,
                words: preview.problem.unwrap_or_default(),
            })
        }
        FolderState::NotAFolder => {
            return Ok(NewProjectOutcome::Refused {
                words: preview.problem.unwrap_or_default(),
            })
        }
        _ => {}
    }
    if preview.inside_repo.is_some() {
        return Ok(NewProjectOutcome::Refused {
            words: preview.problem.unwrap_or_default(),
        });
    }
    if let Some(copy) = &request.github_copy {
        if !crate::team_admin::is_valid_login(&copy.login) {
            return Ok(NewProjectOutcome::Refused {
                words: "That isn't a GitHub account name.".into(),
            });
        }
    }
    if !parent.is_dir() {
        return Err("That place isn't there any more.".into());
    }
    if !identity_ready(tools, parent) {
        return Ok(NewProjectOutcome::IdentityNeeded {
            words: IDENTITY_NEEDED.into(),
        });
    }

    let created = match std::fs::create_dir(&dest) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if folder_state(&dest) != FolderState::Empty {
                return Ok(NewProjectOutcome::FolderHasFiles {
                    path: dest.to_string_lossy().into_owned(),
                    words: format!("There's already a folder called “{slug}” with files in it."),
                    slug,
                });
            }
            false
        }
        Err(e) => return Err(format!("Plyloft couldn't make the folder ({e}).")),
    };
    let dest = canonical(&dest);
    let message = format!("Start {name}");
    let local = (|| -> Result<(String, String), String> {
        git_init_main(tools, &dest)?;
        crate::atomic::write_atomic_text(&dest.join("README.md"), &format!("# {name}\n"))
            .map_err(|e| format!("Plyloft couldn't write README.md ({e})."))?;
        let mut ignore = NEW_IGNORE.join("\n");
        ignore.push('\n');
        crate::atomic::write_atomic_text(&dest.join(".gitignore"), &ignore)
            .map_err(|e| format!("Plyloft couldn't write .gitignore ({e})."))?;
        git_step(tools, &dest, &["add", "README.md", ".gitignore"], GIT_COMMIT)?;
        git_step(tools, &dest, &["commit", "-q", "-m", &message], GIT_COMMIT)?;
        let commit = head_commit(tools, &dest)
            .ok_or_else(|| "Git didn't record the first commit.".to_string())?;
        let branch = head_branch(tools, &dest).unwrap_or_else(|| "main".into());
        Ok((commit, branch))
    })();
    let (commit, branch) = match local {
        Ok(done) => done,
        Err(e) => {
            if created {
                let _ = std::fs::remove_dir_all(&dest);
            } else {
                // The folder was there, empty: take out only what Ply put in.
                let _ = std::fs::remove_dir_all(dest.join(".git"));
                let _ = std::fs::remove_file(dest.join("README.md"));
                let _ = std::fs::remove_file(dest.join(".gitignore"));
            }
            return Err(e);
        }
    };
    let github = request
        .github_copy
        .as_ref()
        .map(|copy| github_copy(tools, &dest, &copy.login, &slug, token));
    Ok(NewProjectOutcome::Created {
        path: dest.to_string_lossy().into_owned(),
        name,
        slug,
        branch,
        commit,
        github,
    })
}

/// `gh repo create <login>/<slug> --private --source . --push`, in the new
/// project. The local project stands whatever GitHub answers.
pub fn github_copy(
    tools: &Tools,
    dest: &Path,
    login: &str,
    slug: &str,
    token: Option<&GhToken>,
) -> GithubCopyResult {
    let repo = format!("{login}/{slug}");
    let failed = |words: String| GithubCopyResult {
        state: GithubCopyState::Failed,
        repo: repo.clone(),
        words: Some(redact(&words, token)),
    };
    let mut command = match tools.gh(token) {
        Ok(c) => c,
        Err(words) => return failed(words),
    };
    command
        .current_dir(dest)
        .args(["repo", "create", &repo, "--private", "--source", ".", "--push"]);
    match run(&mut command, GH_CREATE) {
        Ok(ran) if ran.ok() => GithubCopyResult {
            state: GithubCopyState::Created,
            repo: repo.clone(),
            words: None,
        },
        Ok(ran) if is_name_taken(&ran.stderr) => GithubCopyResult {
            state: GithubCopyState::NameTaken,
            words: Some(format!(
                "You already have a repository called {slug} on GitHub. The project was made on this computer only."
            )),
            repo: repo.clone(),
        },
        Ok(ran) => failed(format!(
            "GitHub didn't make the copy. The project was made on this computer only.\n{}",
            ran.words()
        )),
        Err(words) => failed(format!(
            "GitHub didn't make the copy. The project was made on this computer only. {words}"
        )),
    }
}

// ── GitHub accounts ────────────────────────────────────────────────────

/// The token for `account` when it isn't gh's active one; `None` for the
/// active account (and when no account was chosen): gh then uses its own.
pub fn token_for(tools: &Tools, account: Option<&str>) -> Result<Option<GhToken>, String> {
    let Some(login) = account.map(str::trim).filter(|a| !a.is_empty()) else {
        return Ok(None);
    };
    if !crate::team_admin::is_valid_login(login) {
        return Err("That isn't a GitHub account name.".into());
    }
    let mut status = tools.gh(None)?;
    status.args(["auth", "status", "--json", "hosts"]);
    let ran = run(&mut status, GH_CALL)?;
    let accounts = crate::setup_run::gh_accounts(&ran.stdout)
        .ok_or_else(|| "Plyloft couldn't read which GitHub accounts are signed in.".to_string())?;
    let Some(found) = accounts
        .iter()
        .find(|a| a.login.eq_ignore_ascii_case(login) && a.signed_in)
    else {
        return Err(format!(
            "{login} isn't signed in to GitHub on this computer. Sign it in in Setup's GitHub step."
        ));
    };
    if found.active {
        return Ok(None);
    }
    let mut command = tools.gh(None)?;
    command.args(["auth", "token", "--user", &found.login]);
    let ran = run(&mut command, GH_CALL)?;
    // Never the output in an error: on success it *is* the token.
    if !ran.ok() {
        return Err(format!(
            "The GitHub CLI couldn't give Plyloft {login}'s sign-in. Sign it in again in Setup's GitHub step."
        ));
    }
    GhToken::new(ran.stdout).map(Some).ok_or_else(|| {
        format!("The GitHub CLI gave no sign-in for {login}. Sign it in again in Setup's GitHub step.")
    })
}

/// The active account's login.
pub fn active_login(tools: &Tools) -> Result<String, String> {
    let mut status = tools.gh(None)?;
    status.args(["auth", "status", "--json", "hosts"]);
    let ran = run(&mut status, GH_CALL)?;
    crate::setup_run::gh_accounts(&ran.stdout)
        .and_then(|list| list.into_iter().find(|a| a.active && a.signed_in))
        .map(|a| a.login)
        .ok_or_else(|| "No GitHub account is signed in. Sign in in Setup's GitHub step.".into())
}

// ── 8b: the repositories an account can get ────────────────────────────

/// How a repository is grouped in the picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum RepoGroupKind {
    /// The team's workspaces (team mode).
    Team,
    /// The account's own.
    Yours,
    /// An organisation's.
    Org,
    /// Another person's, shared with this account.
    Shared,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    pub name_with_owner: String,
    pub owner: String,
    pub name: String,
    pub description: Option<String>,
    pub is_private: bool,
    /// `isEmpty` from `gh repo list`; `None` where GitHub's REST list doesn't
    /// say (shared repositories). Never read from `diskUsage` (OB-0).
    pub is_empty: Option<bool>,
    pub updated_at: Option<String>,
    /// KB, approximate.
    pub disk_usage_kb: Option<u64>,
    pub default_branch: Option<String>,
    pub group: RepoGroupKind,
    /// The organisation's or the other person's login.
    pub group_owner: String,
    /// Already a workspace (its checkout's origin is this repository).
    pub in_ply: Option<WorkspaceRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSourceError {
    /// `yours`, `org:<login>`, `organisations`, `shared`.
    pub source: String,
    pub words: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoList {
    pub login: String,
    pub repos: Vec<RepoEntry>,
    /// Some source had more than Plyloft lists, or the list hit its cap.
    pub truncated: bool,
    pub errors: Vec<RepoSourceError>,
}

fn split_slug(slug: &str) -> (String, String) {
    match slug.split_once('/') {
        Some((o, n)) => (o.to_string(), n.to_string()),
        None => (String::new(), slug.to_string()),
    }
}

/// Pure: `gh repo list … --json nameWithOwner,description,isPrivate,isEmpty,
/// updatedAt,diskUsage,defaultBranchRef` (MEASUREMENTS §11).
pub fn parse_repo_list(json: &str, group: RepoGroupKind, group_owner: &str) -> Result<Vec<RepoEntry>, String> {
    let value: serde_json::Value =
        serde_json::from_str(json.trim()).map_err(|_| "GitHub's list couldn't be read.".to_string())?;
    let items = value.as_array().ok_or_else(|| "GitHub's list couldn't be read.".to_string())?;
    Ok(items
        .iter()
        .filter_map(|r| {
            let slug = r.get("nameWithOwner")?.as_str()?.to_string();
            if !crate::team::is_valid_repo_slug(&slug) {
                return None;
            }
            let (owner, name) = split_slug(&slug);
            Some(RepoEntry {
                name_with_owner: slug,
                owner,
                name,
                description: r
                    .get("description")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                is_private: r.get("isPrivate").and_then(|v| v.as_bool()).unwrap_or(false),
                is_empty: r.get("isEmpty").and_then(|v| v.as_bool()),
                updated_at: r.get("updatedAt").and_then(|v| v.as_str()).map(String::from),
                disk_usage_kb: r.get("diskUsage").and_then(|v| v.as_u64()),
                default_branch: r
                    .get("defaultBranchRef")
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                group,
                group_owner: group_owner.to_string(),
                in_ply: None,
            })
        })
        .collect())
}

/// Pure: GitHub's REST `user/repos` items (`full_name`, `private`, `size`,
/// `updated_at`, `default_branch`), grouped under each owner's login.
pub fn parse_user_repos(json: &str, login: &str) -> Result<Vec<RepoEntry>, String> {
    let value: serde_json::Value =
        serde_json::from_str(json.trim()).map_err(|_| "GitHub's list couldn't be read.".to_string())?;
    let items = value.as_array().ok_or_else(|| "GitHub's list couldn't be read.".to_string())?;
    Ok(items
        .iter()
        .filter_map(|r| {
            let slug = r.get("full_name")?.as_str()?.to_string();
            if !crate::team::is_valid_repo_slug(&slug) {
                return None;
            }
            let (owner, name) = split_slug(&slug);
            let org = r
                .get("owner")
                .and_then(|o| o.get("type"))
                .and_then(|t| t.as_str())
                == Some("Organization");
            let group = if owner.eq_ignore_ascii_case(login) {
                RepoGroupKind::Yours
            } else if org {
                RepoGroupKind::Org
            } else {
                RepoGroupKind::Shared
            };
            Some(RepoEntry {
                name_with_owner: slug,
                group_owner: owner.clone(),
                owner,
                name,
                description: r
                    .get("description")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                is_private: r.get("private").and_then(|v| v.as_bool()).unwrap_or(false),
                is_empty: None,
                updated_at: r.get("updated_at").and_then(|v| v.as_str()).map(String::from),
                disk_usage_kb: r.get("size").and_then(|v| v.as_u64()),
                default_branch: r
                    .get("default_branch")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                group,
                in_ply: None,
            })
        })
        .collect())
}

/// Pure: one list from the sources, each repository once. The first source
/// that names a repository keeps its facts; a team workspace is in the team
/// group whoever owns it. Sorted by group, then most recently updated.
pub fn merge_repos(
    sources: Vec<Vec<RepoEntry>>,
    team: &[String],
    origins: &[(WorkspaceRef, String)],
    cap: usize,
) -> (Vec<RepoEntry>, bool) {
    let mut seen: BTreeMap<String, RepoEntry> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for entry in sources.into_iter().flatten() {
        let key = entry.name_with_owner.to_ascii_lowercase();
        if let Some(existing) = seen.get_mut(&key) {
            // Fill what an earlier source didn't know.
            if existing.is_empty.is_none() {
                existing.is_empty = entry.is_empty;
            }
            continue;
        }
        order.push(key.clone());
        seen.insert(key, entry);
    }
    for slug in team {
        let key = slug.to_ascii_lowercase();
        match seen.get_mut(&key) {
            Some(entry) => entry.group = RepoGroupKind::Team,
            None if crate::team::is_valid_repo_slug(slug) => {
                let (owner, name) = split_slug(slug);
                order.push(key.clone());
                seen.insert(
                    key,
                    RepoEntry {
                        name_with_owner: slug.clone(),
                        group_owner: owner.clone(),
                        owner,
                        name,
                        description: None,
                        is_private: true,
                        is_empty: None,
                        updated_at: None,
                        disk_usage_kb: None,
                        default_branch: None,
                        group: RepoGroupKind::Team,
                        in_ply: None,
                    },
                );
            }
            None => {}
        }
    }
    let mut list: Vec<RepoEntry> = order.into_iter().filter_map(|k| seen.remove(&k)).collect();
    for entry in &mut list {
        entry.in_ply = origins
            .iter()
            .find(|(_, slug)| slug.eq_ignore_ascii_case(&entry.name_with_owner))
            .map(|(w, _)| w.clone());
    }
    list.sort_by(|a, b| {
        a.group
            .cmp(&b.group)
            .then_with(|| a.group_owner.to_ascii_lowercase().cmp(&b.group_owner.to_ascii_lowercase()))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
    let truncated = list.len() > cap;
    list.truncate(cap);
    (list, truncated)
}

/// Each workspace whose checkout's origin is on github.com, with its slug.
pub fn workspace_origins(tools: &Tools, workspaces: &[WorkspaceRef]) -> Vec<(WorkspaceRef, String)> {
    workspaces
        .iter()
        .take(300)
        .filter(|w| Path::new(&w.cwd).is_dir())
        .filter_map(|w| github_origin(tools, Path::new(&w.cwd)).map(|slug| (w.clone(), slug)))
        .collect()
}

const REPO_FIELDS: &str = "nameWithOwner,description,isPrivate,isEmpty,updatedAt,diskUsage,defaultBranchRef";

fn gh_json(tools: &Tools, token: Option<&GhToken>, args: &[&str]) -> Result<String, String> {
    let mut command = tools.gh(token)?;
    command.args(args);
    let ran = run(&mut command, GH_CALL)?;
    if ran.ok() {
        Ok(ran.stdout)
    } else {
        Err(redact(&ran.words(), token))
    }
}

/// Step 8b's list for `login` (the active account when `token` is `None`).
pub fn repo_list(
    tools: &Tools,
    login: &str,
    token: Option<&GhToken>,
    team: &[String],
    origins: &[(WorkspaceRef, String)],
) -> RepoList {
    let mut errors = Vec::new();
    let mut truncated = false;
    let mut sources: Vec<Vec<RepoEntry>> = Vec::new();
    let limit = REPO_LIST_LIMIT.to_string();
    let mut listed = |owner: &str, group: RepoGroupKind, source: String, errors: &mut Vec<RepoSourceError>| {
        match gh_json(tools, token, &["repo", "list", owner, "--json", REPO_FIELDS, "--limit", &limit])
            .and_then(|json| parse_repo_list(&json, group, owner))
        {
            Ok(list) => {
                if list.len() >= REPO_LIST_LIMIT {
                    truncated = true;
                }
                sources.push(list);
            }
            Err(words) => errors.push(RepoSourceError { source, words }),
        }
    };
    listed(login, RepoGroupKind::Yours, "yours".into(), &mut errors);
    match gh_json(tools, token, &["org", "list", "--limit", &ORG_CAP.to_string()]) {
        Ok(out) => {
            let orgs: Vec<String> = out
                .lines()
                .map(str::trim)
                .filter(|l| crate::team_admin::is_valid_login(l))
                .map(String::from)
                .take(ORG_CAP)
                .collect();
            let orgs_capped = orgs.len() >= ORG_CAP;
            for org in orgs {
                listed(&org, RepoGroupKind::Org, format!("org:{org}"), &mut errors);
            }
            if orgs_capped {
                truncated = true;
            }
        }
        Err(words) => errors.push(RepoSourceError {
            source: "organisations".into(),
            words,
        }),
    }
    let mut shared = Vec::new();
    for page in 1..=SHARED_PAGES {
        let endpoint = format!(
            "user/repos?affiliation=collaborator,organization_member&per_page=100&page={page}"
        );
        match gh_json(tools, token, &["api", &endpoint]).and_then(|json| parse_user_repos(&json, login)) {
            Ok(list) => {
                let full = list.len() >= 100;
                shared.extend(list);
                if !full {
                    break;
                }
                if page == SHARED_PAGES {
                    truncated = true;
                }
            }
            Err(words) => {
                errors.push(RepoSourceError {
                    source: "shared".into(),
                    words,
                });
                break;
            }
        }
    }
    sources.push(shared);
    let (repos, capped) = merge_repos(sources, team, origins, REPO_LIST_CAP);
    RepoList {
        login: login.to_string(),
        repos,
        truncated: truncated || capped,
        errors,
    }
}

// ── 8b: getting one ────────────────────────────────────────────────────

/// Why a clone ended without a project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloneFailureKind {
    /// 401/403, "Repository not found": this account may not download it.
    Auth,
    /// The organisation's SAML single sign-on.
    Sso,
    /// Offline or interrupted.
    Offline,
    Cancelled,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneFailure {
    pub kind: CloneFailureKind,
    pub words: String,
    /// SSO: the organisation (`https://github.com/orgs/<org>/sso`).
    pub sso_org: Option<String>,
}

/// Pure: what a clone's last lines say went wrong.
pub fn classify_clone_failure(tail: &[String]) -> CloneFailureKind {
    let text = tail.join("\n").to_ascii_lowercase();
    if text.contains("saml") || text.contains("single sign-on") || text.contains(" sso") {
        return CloneFailureKind::Sso;
    }
    let auth = [
        "repository not found",
        "http 401",
        "http 403",
        "error: 403",
        "error: 401",
        "the requested url returned error: 403",
        "the requested url returned error: 401",
        "authentication failed",
        "could not read username",
        "permission denied",
        "terminal prompts disabled",
        "bad credentials",
    ];
    if auth.iter().any(|p| text.contains(p)) {
        return CloneFailureKind::Auth;
    }
    let offline = [
        "could not resolve host",
        "failed to connect",
        "couldn't connect",
        "connection timed out",
        "operation timed out",
        "connection reset",
        "network is unreachable",
        "early eof",
        "rpc failed",
        "the remote end hung up",
        "unable to access",
        "error connecting to",
        "dial tcp",
        "no such host",
        "transfer closed",
    ];
    if offline.iter().any(|p| text.contains(p)) {
        return CloneFailureKind::Offline;
    }
    CloneFailureKind::Other
}

/// Pure: the words for a failure (spec §5 step 8b table).
pub fn clone_failure(kind: CloneFailureKind, slug: &str) -> CloneFailure {
    let (owner, name) = split_slug(slug);
    let words = match kind {
        CloneFailureKind::Auth => format!("GitHub didn't let this account download {name}."),
        CloneFailureKind::Sso => format!(
            "Your organization “{owner}” needs you to authorize the GitHub CLI for single sign-on."
        ),
        CloneFailureKind::Offline => "The download stopped. Nothing was added to Plyloft.".into(),
        CloneFailureKind::Cancelled => "Stopped. Nothing was added to Plyloft.".into(),
        CloneFailureKind::Other => {
            "The download didn't finish. Nothing was added to Plyloft.".into()
        }
    };
    CloneFailure {
        kind,
        words,
        sso_org: (kind == CloneFailureKind::Sso).then_some(owner),
    }
}

/// The clone's end, on the final `setup://progress` event.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    pub path: String,
    pub repo: String,
    pub cloned: bool,
    /// No commit on the checked-out branch: the first-commit offer (or,
    /// with `remote_branches`, the branch question).
    pub empty: bool,
    pub branch: Option<String>,
    /// Branches GitHub has, when the default one has no commit.
    pub remote_branches: Vec<String>,
    pub failure: Option<CloneFailure>,
    /// The folder Ply created for the clone was removed.
    pub removed_partial: bool,
}

/// What a clone run carries so its end can be judged and cleaned up.
#[derive(Debug, Clone, PartialEq)]
pub struct CloneRun {
    /// The folder `start_clone` created (and only that one is ever removed).
    pub dest: PathBuf,
    pub repo: String,
}

/// The runner's end of a clone: on anything but success the folder Ply
/// created is removed; on success, is it empty, and what branches are there?
pub fn finish_clone(
    run: &CloneRun,
    succeeded: bool,
    cancelled: bool,
    tail: &[String],
    tools: &Tools,
) -> CloneResult {
    let mut result = CloneResult {
        path: run.dest.to_string_lossy().into_owned(),
        repo: run.repo.clone(),
        cloned: false,
        empty: false,
        branch: None,
        remote_branches: Vec::new(),
        failure: None,
        removed_partial: false,
    };
    if !succeeded {
        result.removed_partial = remove_created(&run.dest);
        let kind = if cancelled {
            CloneFailureKind::Cancelled
        } else {
            classify_clone_failure(tail)
        };
        result.failure = Some(clone_failure(kind, &run.repo));
        return result;
    }
    result.cloned = true;
    result.branch = head_branch(tools, &run.dest);
    if head_commit(tools, &run.dest).is_none() {
        result.empty = true;
        result.remote_branches = git_read(
            tools,
            &run.dest,
            &["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"],
        )
        .ok()
        .flatten()
        .map(|out| {
            out.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && *l != "origin/HEAD" && *l != "origin")
                .map(|l| l.strip_prefix("origin/").unwrap_or(l).to_string())
                .collect()
        })
        .unwrap_or_default();
    }
    result
}

/// Left in a clone's folder that Plyloft couldn't remove, so a later look
/// (`project_inspect`, the clone's preflight) can say what it is.
pub const PARTIAL_MARKER: &str = ".plyloft-partial-download";

/// Remove the folder a clone created. True when it was there and is gone.
/// Retried for a moment (a killed download's files may still be closing);
/// if it still can't go, it is logged and marked with [`PARTIAL_MARKER`].
pub fn remove_created(dest: &Path) -> bool {
    remove_created_within(dest, 20, Duration::from_millis(100))
}

pub fn remove_created_within(dest: &Path, tries: u32, pause: Duration) -> bool {
    if std::fs::symlink_metadata(dest).is_err() {
        return false;
    }
    for attempt in 0..tries.max(1) {
        if std::fs::remove_dir_all(dest).is_ok() || std::fs::symlink_metadata(dest).is_err() {
            return true;
        }
        if attempt + 1 < tries {
            std::thread::sleep(pause);
        }
    }
    log::warn!(
        "project clone: couldn't remove the partial download at {}",
        dest.display()
    );
    let _ = std::fs::write(
        dest.join(PARTIAL_MARKER),
        "A download Plyloft started didn't finish, and Plyloft couldn't remove it. You can delete this folder.\n",
    );
    false
}

/// Whether a new project called `name` under `parent` would be the projects
/// folder itself (a project named "Projects" in the home folder).
pub fn targets_projects_folder(name: &str, parent: &Path, projects: &Path) -> bool {
    slugify(name.trim()).is_ok_and(|slug| same_path(&parent.join(slug), projects))
}

/// Pure-ish: a place a project can't go — the target itself is refused, or
/// its parent is a system folder or the disk's root.
pub fn place_refusal(parent: &Path, target: &Path, home: Option<&Path>) -> Option<&'static str> {
    let text = |p: &Path| canonical(p).to_string_lossy().into_owned();
    let home = home.map(text);
    if let Some(r) = refused_folder(&text(target), home.as_deref(), None, cfg!(windows)) {
        return Some(r.words());
    }
    match refused_folder(&text(parent), home.as_deref(), None, cfg!(windows)) {
        Some(RefusedFolder::Root) | Some(RefusedFolder::System) => {
            Some("That place is a system folder or a whole disk. Choose a folder for your projects.")
        }
        _ => None,
    }
}

/// `project_clone`'s answer before anything runs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ClonePreflight {
    /// Go ahead: clone into `path` (Ply creates it).
    #[serde(rename_all = "camelCase")]
    Clear { path: String, display_path: String },
    /// `Add that folder instead` · `Choose another name`.
    #[serde(rename_all = "camelCase")]
    DestinationExists { path: String, name: String, words: String },
    /// *lyra is already in Plyloft, at ~/work/lyra.* `[Open it]`
    #[serde(rename_all = "camelCase")]
    AlreadyInPly { workspace: WorkspaceRef, words: String },
}

/// Pure-ish: may `repo` be cloned under `parent`?
pub fn clone_preflight(
    repo: &str,
    parent: &Path,
    origins: &[(WorkspaceRef, String)],
    home: Option<&Path>,
) -> Result<ClonePreflight, String> {
    if !crate::team::is_valid_repo_slug(repo) {
        return Err("That isn't a GitHub repository name (owner/name).".into());
    }
    let (_, name) = split_slug(repo);
    if let Some((workspace, _)) = origins.iter().find(|(_, s)| s.eq_ignore_ascii_case(repo)) {
        let at = display_path(Path::new(&workspace.cwd), home);
        return Ok(ClonePreflight::AlreadyInPly {
            words: format!("{name} is already in Plyloft, at {at}."),
            workspace: workspace.clone(),
        });
    }
    let dest = parent.join(&name);
    if let Some(words) = place_refusal(parent, &dest, home) {
        return Err(words.into());
    }
    if std::fs::symlink_metadata(&dest).is_ok() {
        let place = parent
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| display_path(parent, home));
        let words = if dest.join(PARTIAL_MARKER).exists() {
            format!("“{name}” in {place} is a partial download from last time. Delete that folder, then get it again.")
        } else {
            format!("There's already a folder called “{name}” in {place}.")
        };
        return Ok(ClonePreflight::DestinationExists {
            path: dest.to_string_lossy().into_owned(),
            words,
            name,
        });
    }
    Ok(ClonePreflight::Clear {
        display_path: display_path(&dest, home),
        path: dest.to_string_lossy().into_owned(),
    })
}

/// The runner's plan for a clone into `dest` (which Ply has just created).
pub fn clone_plan(
    gh: &str,
    repo: &str,
    dest: &Path,
    token: Option<GhToken>,
    home: Option<&Path>,
) -> crate::setup_actions::RunPlan {
    crate::setup_actions::RunPlan {
        action: crate::setup_actions::ActionId::ProjectClone,
        argv: vec![
            gh.to_string(),
            "repo".into(),
            "clone".into(),
            repo.to_string(),
            dest.to_string_lossy().into_owned(),
            "--".into(),
            "--progress".into(),
        ],
        direct: false,
        display: format!(
            "gh repo clone {repo} {} -- --progress",
            display_path(dest, home)
        ),
        watch: crate::setup_actions::Watch::Cloned,
        env: vec![
            ("GH_PROMPT_DISABLED".into(), "1".into()),
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ],
        token,
        clone: Some(CloneRun {
            dest: dest.to_path_buf(),
            repo: repo.to_string(),
        }),
        cwd: None,
    }
}

/// The clone's watcher: done when the folder holds a repository.
pub struct CloneObserver {
    pub dest: PathBuf,
}

impl crate::setup_run::Observer for CloneObserver {
    fn baseline(&self, _watch: crate::setup_actions::Watch) -> crate::setup_run::Baseline {
        crate::setup_run::Baseline::default()
    }

    fn observe(
        &self,
        _watch: crate::setup_actions::Watch,
        _baseline: &crate::setup_run::Baseline,
    ) -> crate::setup_run::Observed {
        std::fs::symlink_metadata(self.dest.join(".git")).is_ok().into()
    }

    fn re_probe(&self) {}
}

// ── 8b: an empty repository's first commit ─────────────────────────────

/// What [`first_commit_push`] did.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstPushDone {
    pub path: String,
    pub branch: String,
    pub commit: String,
    pub pushed: bool,
    /// When the push failed: the commit is saved here, GitHub doesn't have it.
    pub words: Option<String>,
}

/// Pure: git's `-c` arguments that make gh answer github.com's password
/// (MEASUREMENTS §9: the user's own helper would answer with whichever
/// account it stored, ignoring `GH_TOKEN`).
pub fn gh_helper_args(gh: &str) -> Vec<String> {
    let gh = gh.replace('\\', "/");
    vec![
        "-c".into(),
        "credential.https://github.com.helper=".into(),
        "-c".into(),
        format!("credential.https://github.com.helper=!\"{gh}\" auth git-credential"),
    ]
}

/// `git` for a network call to origin, never prompting: when gh resolved
/// and origin is on github.com, gh answers github.com's password — for
/// `account` (a login that isn't gh's active one) through
/// [`crate::github_account::login_helper_args`], which asks `gh auth token
/// --user <login>` itself when git needs it, else gh's active account. No
/// GitHub token is ever in git's environment (OB-7b P3-1), so a hook git
/// runs (pre-push, post-commit…) never sees one.
pub(crate) fn network_git(tools: &Tools, dir: &Path, github: bool, account: Option<&str>) -> Command {
    let mut command = (tools.git)();
    if github {
        if let Some(gh) = &tools.gh {
            match account {
                Some(login) => command.args(crate::github_account::login_helper_args(gh, login)),
                None => command.args(gh_helper_args(gh)),
            };
        }
    }
    command.arg("-C").arg(dir);
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN");
    command
}

/// Step 8b's `[Make the first commit]` (after the consent sheet): a README
/// (`# name`) when there is none, `git commit -m "chore: first commit"` on `main`,
/// `git push -u origin main`. Only for a clone with no commit whose origin
/// has no branch yet. `account`: a login that isn't gh's active one (its
/// sign-in answers git's password request), else gh's active account.
pub fn first_commit_push(
    path: &Path,
    tools: &Tools,
    account: Option<&str>,
) -> Result<FirstPushDone, String> {
    let dir = canonical(path);
    let top = git_read(tools, &dir, &["rev-parse", "--show-toplevel"])?
        .ok_or_else(|| "This folder isn't a Git project.".to_string())?;
    if !same_path(Path::new(&top), &dir) {
        return Err("This folder isn't the top of its Git project.".into());
    }
    if head_commit(tools, &dir).is_some() {
        return Err("This project already has a first commit.".into());
    }
    let url = git_read(tools, &dir, &["remote", "get-url", "origin"])?
        .ok_or_else(|| "This project has no GitHub copy to send it to.".to_string())?;
    let github = crate::team::origin_slug(&url).is_some();
    if !identity_ready(tools, &dir) {
        return Err(IDENTITY_NEEDED.into());
    }
    // Only the README Plyloft writes goes in the first commit: a folder
    // holding anything else (or an index with anything else staged) isn't
    // the fresh clone the consent sheet described.
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("Plyloft couldn't read this folder ({e})."))?;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // The operating system's own files may be there; they aren't committed.
        let os_file = name == ".DS_Store"
            || name.eq_ignore_ascii_case("Thumbs.db")
            || name.eq_ignore_ascii_case("desktop.ini");
        if name != ".git" && name != "README.md" && !os_file {
            return Err(
                "This folder has files besides the download. Plyloft only makes the first commit in a fresh, empty copy.".into(),
            );
        }
    }
    let staged = git_read(tools, &dir, &["ls-files", "--cached"])?.unwrap_or_default();
    if staged.lines().any(|l| !l.trim().is_empty() && l.trim() != "README.md") {
        return Err(
            "This folder has files staged for a commit. Plyloft only makes the first commit in a fresh, empty copy.".into(),
        );
    }
    // The remote must still be empty: never a push over someone's work.
    let mut ls = network_git(tools, &dir, github, account);
    ls.args(["ls-remote", "--heads", "origin"]);
    let ran = run(&mut ls, GIT_NETWORK)?;
    if !ran.ok() {
        return Err(format!("Plyloft couldn't reach GitHub:\n{}", ran.words()));
    }
    if !ran.out().is_empty() {
        return Err(
            "GitHub already has commits in this repository. Choose the branch cards start from instead."
                .into(),
        );
    }
    git_step(tools, &dir, &["symbolic-ref", "HEAD", "refs/heads/main"], GIT_READ)?;
    let readme = dir.join("README.md");
    match std::fs::symlink_metadata(&readme) {
        Ok(meta) if !meta.is_file() => {
            return Err("This folder's README.md isn't a plain file. Plyloft only makes the first commit in a fresh, empty copy.".into())
        }
        _ => {}
    }
    if std::fs::symlink_metadata(&readme).is_err() {
        crate::atomic::write_atomic_text(&readme, &format!("# {}\n", folder_name(&dir)))
            .map_err(|e| format!("Plyloft couldn't write README.md ({e})."))?;
    }
    git_step(tools, &dir, &["add", "--", "README.md"], GIT_ADD)?;
    // Exactly the README, right before the commit.
    let staged = git_read(tools, &dir, &["ls-files", "--cached"])?.unwrap_or_default();
    if staged.trim() != "README.md" {
        return Err("Something other than README.md would be in the first commit, so Plyloft stopped. Nothing was committed.".into());
    }
    git_step(tools, &dir, &["commit", "-q", "-m", crate::commit_message::FIRST_COMMIT], GIT_COMMIT)?;
    let commit =
        head_commit(tools, &dir).ok_or_else(|| "Git didn't record the first commit.".to_string())?;
    let mut push = network_git(tools, &dir, github, account);
    push.args(["push", "-u", "origin", "main"]);
    let (pushed, words) = match run(&mut push, GIT_NETWORK) {
        Ok(ran) if ran.ok() => (true, None),
        Ok(ran) => (
            false,
            Some(format!(
                "The first commit is saved on this computer, but GitHub didn't take it:\n{}",
                ran.words()
            )),
        ),
        Err(e) => (
            false,
            Some(format!(
                "The first commit is saved on this computer, but GitHub didn't take it. {e}"
            )),
        ),
    };
    Ok(FirstPushDone {
        path: dir.to_string_lossy().into_owned(),
        branch: "main".into(),
        commit,
        pushed,
        words,
    })
}

// ── Commands ───────────────────────────────────────────────────────────

use tauri::{AppHandle, Manager};

fn workspace_refs(app: &AppHandle) -> Vec<WorkspaceRef> {
    app.state::<crate::workspace::WorkspaceStore>()
        .snapshot()
        .workspaces
        .into_iter()
        .map(|w| WorkspaceRef {
            id: w.id,
            name: w.name,
            cwd: w.cwd,
        })
        .collect()
}

/// The projects folder, expanded (`settings.projects.folder`, else D9's
/// `~/Projects`).
fn projects_folder(app: &AppHandle) -> PathBuf {
    let settings = app.state::<crate::settings::SettingsStore>().snapshot();
    crate::team::clone_root(Some(settings.projects.folder_or_default()))
}

fn home() -> Option<PathBuf> {
    crate::platform::home_dir().map(|h| canonical(&h))
}

fn inspect_ctx(app: &AppHandle) -> InspectCtx {
    InspectCtx {
        tools: Tools::production(),
        home: home(),
        projects_folder: Some(projects_folder(app)),
        workspaces: workspace_refs(app),
        limits: ScanLimits::REAL,
    }
}

pub(crate) fn require_git() -> Result<(), String> {
    if crate::shell_env::get().git_works() {
        Ok(())
    } else {
        Err(GIT_UNAVAILABLE.into())
    }
}

/// A parent folder from the frontend (a folder picker's answer), or the
/// projects folder — created when it is missing (spec §5 step 7).
fn parent_folder(app: &AppHandle, parent: Option<String>) -> Result<PathBuf, String> {
    match parent.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        Some(p) => {
            let p = PathBuf::from(p);
            if !p.is_absolute() || !p.is_dir() {
                return Err("That place isn't a folder on this computer.".into());
            }
            Ok(canonical(&p))
        }
        None => {
            let folder = projects_folder(app);
            std::fs::create_dir_all(&folder)
                .map_err(|e| format!("Plyloft couldn't make the projects folder ({e})."))?;
            Ok(canonical(&folder))
        }
    }
}

pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("project worker failed: {e}"))?
}

// ── Step 7: the projects folder ─────────────────────────────────────────

/// OB-12 (spec §5 step 7): what is at a projects folder the step shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsFolderLook {
    /// Expanded.
    pub path: String,
    pub exists: bool,
    /// Something is there, but it isn't a folder.
    pub not_a_folder: bool,
    /// Folders directly inside that are Git projects ("Plyloft found 6
    /// projects here."), counted over at most [`PROJECTS_LOOK_CAP`] entries.
    pub projects: u32,
}

/// How many entries of the projects folder the step's hint reads.
pub const PROJECTS_LOOK_CAP: usize = 2000;

/// Pure-ish: read `path` for the step's hint (nothing is written).
pub fn look_projects_folder(path: &Path) -> ProjectsFolderLook {
    let mut look = ProjectsFolderLook {
        path: path.to_string_lossy().into_owned(),
        exists: false,
        not_a_folder: false,
        projects: 0,
    };
    match std::fs::metadata(path) {
        Err(_) => return look,
        Ok(meta) if !meta.is_dir() => {
            look.exists = true;
            look.not_a_folder = true;
            return look;
        }
        Ok(_) => look.exists = true,
    }
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten().take(PROJECTS_LOOK_CAP) {
            let child = entry.path();
            if child.is_dir() && std::fs::symlink_metadata(child.join(".git")).is_ok() {
                look.projects += 1;
            }
        }
    }
    look
}

/// Make the projects folder (step 7's press). An existing folder is left as
/// it is; a file with that name is refused in words.
pub fn create_projects_folder(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Choose a folder on this computer.".into());
    }
    if std::fs::metadata(path).is_ok_and(|m| !m.is_dir()) {
        return Err("There's a file with that name, not a folder. Choose another folder.".into());
    }
    std::fs::create_dir_all(path)
        .map_err(|e| format!("Plyloft couldn't make the projects folder ({e})."))?;
    Ok(path.to_path_buf())
}

/// Step 7: `folder` in tilde form (`~/Projects`), expanded as the clone root
/// and the projects folder are (`team::clone_root`).
fn expand_projects_folder(folder: &str) -> Result<PathBuf, String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return Err("Choose a folder on this computer.".into());
    }
    Ok(crate::team::clone_root(Some(folder)))
}

/// Step 7: what is at the folder the step suggests or the person picked.
#[tauri::command]
pub async fn projects_folder_look(folder: String) -> Result<ProjectsFolderLook, String> {
    blocking(move || Ok(look_projects_folder(&expand_projects_folder(&folder)?))).await
}

/// Step 7's `[Use this folder]`: create it when it is missing (no sheet — an
/// empty folder in the person's home). Returns the expanded path.
#[tauri::command]
pub async fn projects_folder_create(folder: String) -> Result<String, String> {
    blocking(move || {
        let path = create_projects_folder(&expand_projects_folder(&folder)?)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}

/// Step 8a: read a folder the picker gave (nothing is written).
#[tauri::command]
pub async fn project_inspect(app: AppHandle, path: String) -> Result<ProjectInspection, String> {
    blocking(move || {
        require_git()?;
        inspect(Path::new(&path), &inspect_ctx(&app))
    })
    .await
}

/// Step 8a: make the folder a Git project with its first commit.
#[tauri::command]
pub async fn project_init(
    app: AppHandle,
    path: String,
    choices: InitChoices,
) -> Result<InitDone, String> {
    blocking(move || {
        require_git()?;
        init(Path::new(&path), &choices, &inspect_ctx(&app))
    })
    .await
}

/// 1.171.0 D3: the "Save my current work first" sheet's look (read-only).
#[tauri::command]
pub async fn project_inspect_work(app: AppHandle, path: String) -> Result<ProjectInspection, String> {
    blocking(move || {
        require_git()?;
        inspect_work(Path::new(&path), &inspect_ctx(&app))
    })
    .await
}

/// 1.171.0 D3: "Save my current work first" — one local commit of the
/// folder's changes on its current branch, on the person's press. Never
/// pushed.
#[tauri::command]
pub async fn project_save_work(
    app: AppHandle,
    path: String,
    choices: InitChoices,
) -> Result<SaveWorkDone, String> {
    blocking(move || {
        require_git()?;
        save_work(Path::new(&path), &choices, &inspect_ctx(&app))
    })
    .await
}

/// 1.171.0 D3: the `.gitignore` lines `project_save_work` would add for the
/// new files and folders left out (read-only).
#[tauri::command]
pub async fn project_work_ignore_plan(path: String, leave_out: Vec<String>) -> Result<Vec<String>, String> {
    blocking(move || work_ignore_plan(Path::new(&path), &leave_out)).await
}

/// 1.171.0 D3: a project folder's changes Git hasn't saved, and the branch
/// it is on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsavedInFolder {
    pub files: u32,
    pub branch: Option<String>,
}

/// 1.171.0 D3: the card says its copy started without the folder's unsaved
/// changes (read-only, no optional lock; 0 when Git couldn't say).
#[tauri::command]
pub async fn project_unsaved_files(path: String) -> Result<UnsavedInFolder, String> {
    blocking(move || {
        require_git()?;
        let tools = Tools::production();
        let dir = Path::new(&path);
        Ok(UnsavedInFolder {
            files: unsaved_files(&tools, dir).unwrap_or(0),
            branch: head_branch(&tools, dir),
        })
    })
    .await
}

/// Step 8a's sheet: the `.gitignore` lines `project_init` would add for
/// these choices (read-only).
#[tauri::command]
pub async fn project_ignore_plan(
    path: String,
    secrets: Vec<String>,
    leave_out: Vec<String>,
) -> Result<Vec<String>, String> {
    blocking(move || ignore_plan(Path::new(&path), &secrets, &leave_out)).await
}

/// Step 8c: the slug and folder shown live under the name field.
#[tauri::command]
pub async fn project_new_preview(
    app: AppHandle,
    name: String,
    parent: Option<String>,
) -> Result<NewPreview, String> {
    blocking(move || {
        let parent = match parent.filter(|p| !p.trim().is_empty()) {
            Some(p) => PathBuf::from(p),
            None => projects_folder(&app),
        };
        let mut preview = new_preview(&name, &parent, &Tools::production(), home().as_deref());
        if targets_projects_folder(&name, &parent, &projects_folder(&app)) {
            preview.place_refused = true;
            preview.problem = Some(REFUSED_PROJECTS.into());
        }
        Ok(preview)
    })
    .await
}

/// Step 8c: create the project (and, when asked, its private GitHub copy).
#[tauri::command]
pub async fn project_new(
    app: AppHandle,
    request: NewProjectRequest,
) -> Result<NewProjectOutcome, String> {
    blocking(move || {
        require_git()?;
        let parent = parent_folder(&app, request.parent.clone())?;
        let tools = Tools::production();
        let token = match &request.github_copy {
            Some(copy) => token_for(&tools, Some(&copy.login))?,
            None => None,
        };
        if targets_projects_folder(&request.name, &parent, &projects_folder(&app)) {
            return Ok(NewProjectOutcome::Refused {
                words: REFUSED_PROJECTS.into(),
            });
        }
        create_new(&request, &parent, &tools, home().as_deref(), token.as_ref())
    })
    .await
}

/// Step 8b: the repositories `account` (else gh's active one) can get.
#[tauri::command]
pub async fn project_repo_list(
    app: AppHandle,
    account: Option<String>,
) -> Result<RepoList, String> {
    blocking(move || {
        let tools = Tools::production();
        let token = token_for(&tools, account.as_deref())?;
        let login = match account.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
            Some(login) => login.to_string(),
            None => active_login(&tools)?,
        };
        let team: Vec<String> = crate::commands::team_status_with(
            &app.state::<crate::license::LicenseStore>(),
            &app.state::<crate::settings::SettingsStore>(),
            &app.state::<crate::workspace::WorkspaceStore>(),
            &app.state::<crate::team::TeamStore>(),
            false,
        )
        .workspaces
        .into_iter()
        .map(|w| w.repo)
        .collect();
        let origins = workspace_origins(&tools, &workspace_refs(&app));
        Ok(repo_list(&tools, &login, token.as_ref(), &team, &origins))
    })
    .await
}

/// `project_clone`'s answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CloneStart {
    /// The clone runs in the guided terminal; its end is the final
    /// `setup://progress` event, which carries a `clone` result.
    #[serde(rename_all = "camelCase")]
    Started {
        run: crate::setup_run::SetupStarted,
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    DestinationExists { path: String, name: String, words: String },
    #[serde(rename_all = "camelCase")]
    AlreadyInPly { workspace: WorkspaceRef, words: String },
}

/// Everything [`start_clone`] needs besides the runner.
pub struct CloneRequest<'a> {
    pub gh: &'a str,
    pub repo: &'a str,
    pub parent: &'a Path,
    pub origins: &'a [(WorkspaceRef, String)],
    pub home: Option<&'a Path>,
    pub token: Option<GhToken>,
    pub cols: u16,
    pub rows: u16,
}

/// Step 8b's `[Get it]`: the preflight, then Ply creates the folder itself
/// — `create_dir` succeeding is the proof that it is Ply's, and it is the
/// only folder a failed or stopped clone removes — and the clone runs in
/// the guided terminal.
pub fn start_clone<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    runner: &crate::setup_run::SetupRunner,
    request: CloneRequest<'_>,
    timing: crate::setup_run::Timing,
    emit: crate::setup_run::Emit,
) -> Result<CloneStart, String> {
    let path = match clone_preflight(request.repo, request.parent, request.origins, request.home)? {
        ClonePreflight::Clear { path, .. } => PathBuf::from(path),
        ClonePreflight::DestinationExists { path, name, words } => {
            return Ok(CloneStart::DestinationExists { path, name, words })
        }
        ClonePreflight::AlreadyInPly { workspace, words } => {
            return Ok(CloneStart::AlreadyInPly { workspace, words })
        }
    };
    if let Err(e) = std::fs::create_dir(&path) {
        return if e.kind() == std::io::ErrorKind::AlreadyExists {
            let name = folder_name(&path);
            Ok(CloneStart::DestinationExists {
                words: format!("There's already a folder called “{name}” here."),
                path: path.to_string_lossy().into_owned(),
                name,
            })
        } else {
            Err(format!("Plyloft couldn't make the folder ({e})."))
        };
    }
    let plan = clone_plan(request.gh, request.repo, &path, request.token, request.home);
    match runner.start(
        app,
        plan,
        Arc::new(CloneObserver { dest: path.clone() }),
        timing,
        emit,
        request.cols,
        request.rows,
    ) {
        Ok(run) => Ok(CloneStart::Started {
            run,
            path: path.to_string_lossy().into_owned(),
        }),
        Err(e) => {
            // Nothing ran (another setup step is running): the empty folder
            // Ply just made goes.
            let _ = std::fs::remove_dir(&path);
            Err(e)
        }
    }
}

/// Step 8b: get `repo` (`owner/name`) into `dest_parent` (else the projects
/// folder) with `account` (else gh's active one), in the guided terminal.
#[tauri::command]
pub async fn project_clone(
    app: AppHandle,
    repo: String,
    dest_parent: Option<String>,
    account: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<CloneStart, String> {
    blocking(move || {
        require_git()?;
        let tools = Tools::production();
        let gh = tools.gh.clone().ok_or_else(|| GH_UNAVAILABLE.to_string())?;
        let repo = repo.trim().to_string();
        if !crate::team::is_valid_repo_slug(&repo) {
            return Err("That isn't a GitHub repository name (owner/name).".into());
        }
        let parent = parent_folder(&app, dest_parent)?;
        let home = home();
        let origins = workspace_origins(&tools, &workspace_refs(&app));
        let token = token_for(&tools, account.as_deref())?;
        let runner = app.state::<crate::setup_run::SetupRunner>();
        start_clone(
            &app,
            &runner,
            CloneRequest {
                gh: &gh,
                repo: &repo,
                parent: &parent,
                origins: &origins,
                home: home.as_deref(),
                token,
                cols: cols.unwrap_or(crate::setup_run::DEFAULT_COLS),
                rows: rows.unwrap_or(crate::setup_run::DEFAULT_ROWS),
            },
            crate::setup_run::Timing::REAL,
            crate::setup_run::app_emit(&app),
        )
    })
    .await
}

/// Step 8b, an empty repository: the first commit and its push (the
/// person pressed `[Make the first commit]` on the consent sheet).
#[tauri::command]
pub async fn project_first_commit_push(
    path: String,
    account: Option<String>,
) -> Result<FirstPushDone, String> {
    blocking(move || {
        require_git()?;
        let tools = Tools::production();
        // Only a login that isn't gh's active one, and only its name: the
        // token is asked by git's helper when git needs it (OB-7b).
        let chosen = crate::github_account::resolve(&tools, account.as_deref())?;
        first_commit_push(Path::new(&path), &tools, chosen.as_ref().map(|env| env.login()))
    })
    .await
}

#[cfg(test)]
#[path = "project_setup_tests.rs"]
mod tests;
