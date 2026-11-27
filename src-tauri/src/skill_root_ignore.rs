//! GH #215 — un-ignore a gitignored skill root, from Diagnostics, with the
//! member's confirmation.
//!
//! The doctor reports a skill root git ignores (`project_skills::mark_ignored`,
//! GH #33's rung 4 walk): a skill written there reaches this checkout's
//! sessions and nothing else, because no commit can carry it. This module
//! works out the lines that make git carry it again, shows them, and appends
//! them only when the member confirms.
//!
//! ## Which file
//!
//! The file whose rule ignores the root, as `git check-ignore -v` names it —
//! not always the repository's root `.gitignore`. Two reasons, both git's:
//!
//! - A deeper `.gitignore` outranks a shallower one. `.claude` in
//!   `app/.gitignore` beats any negation for `app/.claude` in the root
//!   `.gitignore`, so a line there would do nothing.
//! - Within one file the last matching line wins. The exception goes into the
//!   same file, after the rule it answers, and nothing else is needed.
//!
//! `.git/info/exclude` is fixed there too (this clone only, every worktree of
//! it — it is never committed), unless it is a link: Ply writes only regular
//! files, and says so at plan time. A rule in the member's own excludes file
//! (`core.excludesFile` — global or set in this clone's `.git/config` — or
//! git's default `~/.config/git/ignore`) is **not** fixed: that file is
//! outside the repository, and answering it from the repository's
//! `.gitignore` would change what everyone who opens the repo ignores to undo
//! one person's setting. The plan says so and names the line.
//!
//! ## Which shapes are fixed
//!
//! Only those answered by **directory lines on the way to the root**, never a
//! line inside it. Git cannot re-include a path whose parent directory is
//! excluded, so each excluded level is re-opened top down, anchored (`/`) to
//! the directory of the file the lines go into, every path component written
//! literally (`*`, `?`, `[` and `\` escaped — a workspace in `web[1]` must
//! not name `web1`):
//!
//! | ignored level | lines |
//! | --- | --- |
//! | a directory above the root, `d` | `!/d/` then `/d/*` — `d` is open again, and everything else in it stays ignored |
//! | the root itself, `r` | `!/r/` |
//!
//! So `.claude/` or `.claude` → `!/.claude/`, `/.claude/*`,
//! `!/.claude/skills/`; `.claude/*` → `!/.claude/skills/`; `skills/` →
//! `!/.claude/skills/` (and `!/.agents/skills/`).
//!
//! **Everything else is explained, not fixed** (review 2, the orchestrator's
//! call): a rule that also ignores what is *inside* the root — `.claude/**`,
//! `*` in `.claude/.gitignore`, `*.md`, a whitelist `*`, a rule naming a
//! skill. Answering it takes a negation inside the skills, and a negation
//! there outranks every other rule of lower precedence: `.env`, keys, and —
//! once committed — each teammate's own excludes file and `info/exclude`,
//! which no plan made on this Mac can see. Restating rules after it leaks in
//! other ways and would copy personal rules into a shared file. So the sheet
//! names the rule (Details) and, for `X/**` above the root, the edit to make
//! by hand: `X/*` plus the directory lines above.
//!
//! **Worked out against git, not by reasoning.** In a scratch repository
//! holding copies of the ignore files on the path (and `core.excludesFile`
//! and `core.ignorecase` as this clone has them), the rules that ignore the
//! root are found by emptying each one `git check-ignore -v` names and asking
//! again; any of them that reaches inside the root refuses it. Then the
//! lines are added level by level until git reports the root open.
//!
//! **Then the check.** Opening a directory above the root makes git read
//! `.gitignore` files it skips today — a dormant `!settings.local.json` in
//! `.claude/.gitignore` would wake up. So every opened directory is walked in
//! the member's tree (names only, never read; a directory still ignored after
//! the fix is not descended into), its `.gitignore` files copied, and with
//! `.env`, `key.pem`, `node_modules/x`, `.DS_Store` and `.envrc` in each
//! opened directory and each skill: outside the root, anything ignored today
//! must stay ignored; inside it, anything the other rules ignore (today's
//! files, the answered and the dormant ones left out) must stay ignored.
//! Otherwise the root is refused, naming the path and the rule that would
//! win for it after the fix. A directory left open that Ply can't list
//! refuses the root, and so do more than `walk_max()` entries, rather than
//! passing on what was not checked; `.git` entries (a skill cloned in place)
//! are never walked.
//!
//! ## What is written
//!
//! Nothing without the confirmation, which carries back the exact edits the
//! member saw: the plan is worked out again and anything that differs is
//! refused with nothing written. The lines are appended — existing lines are
//! never rewritten or reordered — through a tempfile in the same directory and
//! `rename(2)`, keeping the file's line endings and whether it ended with a
//! newline. Afterwards the doctor's own check runs again and its answer is
//! returned as it is, including "still ignored".

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};

use crate::project_skills::{self, SKILL_ROOTS};

/// The key the scratch repository gives `.git/info/exclude`; every other key
/// is a `.gitignore` path relative to the top of the work tree.
const INFO_KEY: &str = ".git/info/exclude";

/// Whom an edit reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditReach {
    /// A tracked `.gitignore`: everyone, once the change is committed.
    Repository,
    /// A `.gitignore` git does not track yet: everyone, once it is added and
    /// committed.
    Untracked,
    /// A `.gitignore` git ignores itself (`*` in `.claude/.gitignore` ignores
    /// that file too): it is never committed, so the lines work in this
    /// checkout only.
    Checkout,
    /// `.git/info/exclude`: this clone and its worktrees, never committed.
    Clone,
}

/// Lines to append to one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreEdit {
    /// The file, relative to the top of the work tree (absolute when it lies
    /// outside it — a linked worktree's `info/exclude`).
    pub file: String,
    pub reach: EditReach,
    /// The skill roots these lines un-ignore, as the doctor names them.
    pub roots: Vec<String>,
    /// Exactly what is appended, one entry per line, the comment first.
    pub lines: Vec<String>,
    /// The rules they answer, `file:line: pattern`, for Details.
    pub rules: Vec<String>,
}

/// A root Ply offers no lines for, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreRefusal {
    pub root: String,
    /// In words: what ignores it and why Ply adds nothing.
    pub reason: String,
    /// The edit to make by hand, when there is one to suggest.
    pub suggestion: Option<String>,
    /// The rule that ignores it, `file:line: pattern`, for Details.
    pub rule: String,
}

/// What the confirmation shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IgnorePlan {
    /// Every root git ignores here, in the doctor's order.
    pub roots: Vec<String>,
    pub edits: Vec<IgnoreEdit>,
    pub refused: Vec<IgnoreRefusal>,
}

/// What happened after the confirmation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreFixOutcome {
    pub written: Vec<IgnoreEdit>,
    /// The roots the doctor's check still reports ignored after the write.
    pub still_ignored: Vec<String>,
    pub sentence: String,
}

// ── Git ─────────────────────────────────────────────────────────────

fn git(dir: &Path, args: &[&str]) -> Result<Output, String> {
    crate::platform::git_command()
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("git {}: {e}", args.first().copied().unwrap_or("")))
}

fn stdout_line(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim_end_matches(['\n', '\r']).to_string()
}

/// The facts about the repository a plan needs.
struct Repo {
    top: PathBuf,
    /// `cwd` relative to `top`, with a trailing `/`, or empty.
    prefix: String,
    info_exclude: PathBuf,
    /// `core.excludesFile` when configured; unset, git's default applies to
    /// the scratch repository exactly as it does here.
    excludes_file: Option<String>,
    /// `core.excludesFile` is set in this clone's own `.git/config`, not the
    /// member's global config.
    excludes_local: bool,
    /// `core.ignorecase` as this clone has it: the scratch repository matches
    /// names the same way (`SECRETS.MD` against `secrets.md`).
    ignorecase: Option<String>,
}

fn repo_at(cwd: &Path) -> Result<Repo, String> {
    let out = git(cwd, &["rev-parse", "--show-toplevel", "--show-prefix"])?;
    if !out.status.success() {
        return Err(format!(
            "not a git repository: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut lines = text.lines();
    let top = PathBuf::from(lines.next().unwrap_or_default());
    let prefix = lines.next().unwrap_or_default().to_string();
    let info = git(
        cwd,
        // The directory, not the file: git resolves a link in the last
        // component, and a linked `exclude` must be seen as one.
        &["rev-parse", "--path-format=absolute", "--git-path", "info"],
    )?;
    if !info.status.success() {
        return Err("git could not name .git/info/exclude".into());
    }
    let excludes = git(cwd, &["config", "--path", "--get", "core.excludesFile"])?;
    let excludes_file = excludes
        .status
        .success()
        .then(|| stdout_line(&excludes))
        .filter(|path| !path.is_empty());
    let scope = git(cwd, &["config", "--show-scope", "--get", "core.excludesFile"])?;
    let excludes_local = scope.status.success() && {
        let text = stdout_line(&scope);
        text.starts_with("local") || text.starts_with("worktree")
    };
    let case = git(cwd, &["config", "--bool", "--get", "core.ignorecase"])?;
    let ignorecase = case
        .status
        .success()
        .then(|| stdout_line(&case))
        .filter(|value| !value.is_empty());
    Ok(Repo {
        top,
        prefix,
        info_exclude: PathBuf::from(stdout_line(&info)).join("exclude"),
        excludes_file,
        excludes_local,
        ignorecase,
    })
}

/// One answer of `git check-ignore -v -n`.
#[derive(Debug, Clone)]
struct Hit {
    path: String,
    source: String,
    line: String,
    pattern: String,
}

impl Hit {
    fn ignored(&self) -> bool {
        !self.source.is_empty() && !self.pattern.starts_with('!')
    }

    fn rule(&self, display: &str) -> String {
        format!("{display}:{}: {}", self.line, self.pattern)
    }
}

/// `git check-ignore -v -n` about `paths` in `dir`, with `config` as `-c`
/// settings (`key=value`).
fn check_ignore(dir: &Path, config: &[String], paths: &[String]) -> Result<Vec<Hit>, String> {
    use std::io::Write;
    let mut cmd = crate::platform::git_command();
    for setting in config {
        cmd.arg("-c").arg(setting);
    }
    let mut child = cmd
        .args(["check-ignore", "-v", "-n", "-z", "--stdin"])
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn git check-ignore: {e}"))?;
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    let mut stdin = child.stdin.take().expect("piped stdin");
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let output = child
        .wait_with_output()
        .map_err(|e| format!("git check-ignore: {e}"))?;
    let _ = writer.join();
    if !matches!(output.status.code(), Some(0) | Some(1)) {
        return Err(format!(
            "git check-ignore failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let fields: Vec<String> = output
        .stdout
        .split(|byte| *byte == 0)
        .map(|field| String::from_utf8_lossy(field).to_string())
        .collect();
    Ok(fields
        .chunks(4)
        .filter(|chunk| chunk.len() == 4)
        .map(|chunk| Hit {
            source: chunk[0].clone(),
            line: chunk[1].clone(),
            pattern: chunk[2].clone(),
            path: chunk[3].clone(),
        })
        .collect())
}

// ── The file a rule lives in ─────────────────────────────────────────

enum Source {
    /// A file in the scratch repository Ply may append to, by key.
    File(String),
    /// The member's own excludes file, or anything else outside the repo.
    Outside,
}

fn classify(source: &str) -> Source {
    if source == INFO_KEY {
        return Source::File(INFO_KEY.into());
    }
    let in_tree = !Path::new(source).is_absolute()
        && !source.starts_with(".git/")
        && !source.split('/').any(|part| part == "..")
        && (source == ".gitignore" || source.ends_with("/.gitignore"));
    if in_tree {
        Source::File(source.into())
    } else {
        Source::Outside
    }
}

/// The directory a file's patterns are relative to: the top for the root
/// `.gitignore` and `info/exclude`.
fn base_dir(key: &str) -> &str {
    if key == INFO_KEY || key == ".gitignore" {
        ""
    } else {
        key.strip_suffix("/.gitignore").unwrap_or("")
    }
}

fn gitignore_key(dir: &str) -> String {
    if dir.is_empty() {
        ".gitignore".into()
    } else {
        format!("{dir}/.gitignore")
    }
}

/// `path` relative to `dir`, when it lies strictly below it.
fn under<'a>(dir: &str, path: &'a str) -> Option<&'a str> {
    if dir.is_empty() {
        return Some(path);
    }
    path.strip_prefix(dir)?.strip_prefix('/').filter(|rest| !rest.is_empty())
}

/// Every directory above `path`, the top (`""`) first.
fn ancestors(path: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let parts: Vec<&str> = path.split('/').collect();
    for end in 1..parts.len() {
        out.push(parts[..end].join("/"));
    }
    out
}

// ── Appending ────────────────────────────────────────────────────────

/// `base` with `lines` appended: the bytes of `base` untouched, a newline
/// first when it did not end with one, the file's own line ending (`\r\n` if
/// it uses it), and a final newline only when `base` had one (or was empty).
pub fn append_block(base: &[u8], lines: &[String]) -> Vec<u8> {
    if lines.is_empty() {
        return base.to_vec();
    }
    let newline: &[u8] = if base.windows(2).any(|pair| pair == b"\r\n") {
        b"\r\n"
    } else {
        b"\n"
    };
    let ended = base.is_empty() || base.ends_with(b"\n");
    let mut out = base.to_vec();
    if !ended {
        out.extend_from_slice(newline);
    }
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            out.extend_from_slice(newline);
        }
        out.extend_from_slice(line.as_bytes());
    }
    if ended {
        out.extend_from_slice(newline);
    }
    out
}

/// Tempfile in the same directory, then `rename(2)`; the file's permissions
/// carried over. The temp ends in `atomic::TEMP_SUFFIX`, like every other
/// temp Ply writes (GH #208).
fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("no parent directory")?;
    let permissions = std::fs::metadata(path).ok().map(|m| m.permissions());
    let mut tmp = tempfile::Builder::new()
        .prefix(".ply-ignore-")
        .suffix(crate::atomic::TEMP_SUFFIX)
        .tempfile_in(parent)
        .map_err(|e| format!("create temp beside {}: {e}", path.display()))?;
    tmp.write_all(bytes)
        .and_then(|()| tmp.as_file().sync_all())
        .map_err(|e| format!("write temp: {e}"))?;
    if let Some(permissions) = permissions {
        std::fs::set_permissions(tmp.path(), permissions).map_err(|e| format!("permissions: {e}"))?;
    }
    tmp.persist(path).map_err(|e| format!("rename into {}: {}", path.display(), e.error))?;
    Ok(())
}

// ── Patterns ─────────────────────────────────────────────────────────

/// A path component written literally into a pattern: git's glob characters
/// and the escape itself are escaped (a workspace in `web[1]` must not also
/// match `web1`). Our lines start with `/` or `!/` and end in `/` or `/*`, so
/// a leading `#`/`!` or a trailing space in a component cannot take effect.
fn esc_component(part: &str) -> String {
    let mut out = String::new();
    for ch in part.chars() {
        if matches!(ch, '*' | '?' | '[' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn esc_path(path: &str) -> String {
    path.split('/').map(esc_component).collect::<Vec<_>>().join("/")
}

fn has_glob(text: &str) -> bool {
    text.chars().any(|c| matches!(c, '*' | '?' | '[' | '\\'))
}

// ── The scratch repository ───────────────────────────────────────────

fn line_count(bytes: &[u8]) -> usize {
    let newlines = bytes.iter().filter(|b| **b == b'\n').count();
    if bytes.is_empty() || bytes.ends_with(b"\n") {
        newlines
    } else {
        newlines + 1
    }
}

/// `bytes` with the given 1-based lines emptied, the numbering kept.
fn blank_lines(bytes: &[u8], lines: &BTreeSet<usize>) -> Vec<u8> {
    if lines.is_empty() {
        return bytes.to_vec();
    }
    let mut out = Vec::with_capacity(bytes.len());
    for (index, segment) in bytes.split(|b| *b == b'\n').enumerate() {
        if index > 0 {
            out.push(b'\n');
        }
        if !lines.contains(&(index + 1)) {
            out.extend_from_slice(segment);
        }
    }
    out
}

/// The rules a fix answers, `(file key, line)`.
type Answered = BTreeSet<(String, usize)>;

/// Which state of the ignore files the scratch repository is asked about.
#[derive(Clone, Copy)]
enum State<'a> {
    /// As they are now.
    Today,
    /// With the proposed lines appended.
    Fixed,
    /// Today's rules with the answered ones emptied and the files git does
    /// not read today (`dormant`) emptied too: what a name is ignored by,
    /// apart from what hid the directory.
    Baseline {
        answered: &'a Answered,
        dormant: &'a BTreeSet<String>,
    },
}

struct Sim {
    dir: tempfile::TempDir,
    /// `-c` settings every question carries: the member's excludes file and
    /// `core.ignorecase`, as this clone has them.
    config: Vec<String>,
    /// Each ignore file's bytes as they are in the repository.
    base: BTreeMap<String, Vec<u8>>,
    /// The lines proposed for each, in order.
    added: BTreeMap<String, Vec<String>>,
    /// Keys whose real file is a link — only `.git/info/exclude` can be one
    /// git reads. Ply never writes through a link.
    links: BTreeSet<String>,
}

impl Sim {
    fn new(repo: &Repo, paths: &[String]) -> Result<Self, String> {
        let dir = tempfile::tempdir().map_err(|e| format!("scratch repository: {e}"))?;
        let init = git(dir.path(), &["init", "-q", "."])?;
        if !init.status.success() {
            return Err(format!(
                "scratch repository: {}",
                String::from_utf8_lossy(&init.stderr).trim()
            ));
        }
        let mut config = Vec::new();
        if let Some(file) = &repo.excludes_file {
            config.push(format!("core.excludesFile={file}"));
        }
        if let Some(case) = &repo.ignorecase {
            config.push(format!("core.ignorecase={case}"));
        }
        let mut sim = Self {
            dir,
            config,
            base: BTreeMap::new(),
            added: BTreeMap::new(),
            links: BTreeSet::new(),
        };
        let mut seen = BTreeSet::new();
        for path in paths {
            for ancestor in ancestors(path) {
                if seen.insert(ancestor.clone()) {
                    sim.mkdir(&ancestor)?;
                    sim.copy_gitignore(repo, &ancestor)?;
                }
            }
        }
        sim.base.insert(
            INFO_KEY.into(),
            std::fs::read(&repo.info_exclude).unwrap_or_default(),
        );
        if std::fs::symlink_metadata(&repo.info_exclude)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            sim.links.insert(INFO_KEY.to_string());
        }
        Ok(sim)
    }

    fn mkdir(&self, rel: &str) -> Result<(), String> {
        if rel.is_empty() {
            return Ok(());
        }
        std::fs::create_dir_all(self.dir.path().join(rel))
            .map_err(|e| format!("scratch repository: {e}"))
    }

    /// Copy the `.gitignore` of `dir` (top-relative) when it is a regular
    /// file: git does not read one that is a link, and neither does the copy.
    fn copy_gitignore(&mut self, repo: &Repo, dir: &str) -> Result<(), String> {
        let key = gitignore_key(dir);
        if self.base.contains_key(&key) {
            return Ok(());
        }
        let real = repo.top.join(&key);
        let regular = std::fs::symlink_metadata(&real)
            .map(|m| m.file_type().is_file())
            .unwrap_or(false);
        if regular {
            let bytes = std::fs::read(&real).map_err(|e| format!("read {key}: {e}"))?;
            self.base.insert(key, bytes);
        }
        Ok(())
    }

    fn run(&self, state: State<'_>, paths: &[String]) -> Result<Vec<Hit>, String> {
        let none = BTreeSet::new();
        for (key, bytes) in &self.base {
            let body = match state {
                State::Baseline { dormant, .. } if dormant.contains(key) => Vec::new(),
                State::Baseline { answered, .. } => {
                    let lines: BTreeSet<usize> = answered
                        .iter()
                        .filter(|(k, _)| k == key)
                        .map(|(_, line)| *line)
                        .collect();
                    blank_lines(bytes, &lines)
                }
                _ => blank_lines(bytes, &none),
            };
            let extra = match state {
                State::Fixed => self.added.get(key).cloned().unwrap_or_default(),
                _ => Vec::new(),
            };
            std::fs::write(self.dir.path().join(key), append_block(&body, &extra))
                .map_err(|e| format!("scratch repository: {e}"))?;
        }
        check_ignore(self.dir.path(), &self.config, paths)
    }

    fn check(&self, paths: &[String]) -> Result<Vec<Hit>, String> {
        self.run(State::Fixed, paths)
    }

    fn all_open(&self, paths: &[String]) -> Result<bool, String> {
        Ok(!self.check(paths)?.iter().any(Hit::ignored))
    }

    /// Whether a hit on `key` is on one of the proposed lines.
    fn is_ours(&self, key: &str, hit: &Hit) -> bool {
        let base = self.base.get(key).map(|b| line_count(b)).unwrap_or(0);
        hit.line.parse::<usize>().map(|n| n > base).unwrap_or(false)
    }
}

// ── The plan ─────────────────────────────────────────────────────────

/// Why a root gets no lines. Internal: the sentence is built by the caller,
/// which knows the root's name as the doctor gives it.
enum Refuse {
    /// The member's excludes file; `true` when a rule in the repository
    /// ignores the root too.
    Outside(Hit, bool),
    InsideRoot(Hit),
    /// Only a negation inside the root would answer this rule. `String` is
    /// the file key the rule is in.
    NeedsInside(String, Hit),
    Stuck(Hit),
    Link(Hit),
    /// Opening the way would un-ignore `path`, which `was` ignores today;
    /// `now` is the rule that wins after the fix, `woken` when it is in a
    /// `.gitignore` git skips today.
    Leak {
        path: String,
        was: String,
        now: Option<String>,
        woken: bool,
    },
    /// More than [`walk_max`] entries to check under `dir`.
    TooMany(String),
    /// A directory the fix leaves open that Ply could not list.
    Unreadable(String),
    Unseen,
    Failed(String),
}

impl From<String> for Refuse {
    fn from(error: String) -> Self {
        Refuse::Failed(error)
    }
}

/// The lines that re-open `level` — a directory above the root, or the root
/// itself — for the file `key`. `None` when the level lies outside that
/// file's directory, or inside the root: nothing is ever written that
/// reaches inside the skills.
fn step_lines(key: &str, root: &str, level: &str) -> Option<Vec<String>> {
    let dir = base_dir(key);
    under(dir, root)?;
    if root.starts_with(&format!("{level}/")) {
        let rel = esc_path(under(dir, level)?);
        return Some(vec![format!("!/{rel}/"), format!("/{rel}/*")]);
    }
    if level == root {
        return Some(vec![format!("!/{}/", esc_path(under(dir, root)?))]);
    }
    None
}

fn levels_of(probe: &str) -> Vec<String> {
    let mut levels: Vec<String> = ancestors(probe).into_iter().skip(1).collect();
    levels.push(probe.to_string());
    levels
}

/// The first level (top down) of any probe that `hits` report ignored.
fn first_ignored(probes: &[String], hits: &[Hit]) -> Option<Hit> {
    probes.iter().find_map(|probe| {
        levels_of(probe).iter().find_map(|level| {
            hits.iter()
                .find(|h| &h.path == level && h.ignored())
                .cloned()
        })
    })
}

fn inside(root: &str, path: &str) -> bool {
    path.starts_with(&format!("{root}/"))
}

/// Names checked in every opened directory and every skill, whether or not
/// the member has them yet.
const CANARIES: [&str; 5] = [".env", "key.pem", "node_modules/x", ".DS_Store", ".envrc"];

/// The most entries the check walks before it refuses rather than guess.
#[cfg(not(test))]
fn walk_max() -> usize {
    20_000
}

#[cfg(test)]
thread_local! {
    /// Small in tests so the limit is reachable; a timing test raises it.
    static WALK_MAX: std::cell::Cell<usize> = const { std::cell::Cell::new(400) };
}

#[cfg(test)]
fn walk_max() -> usize {
    WALK_MAX.with(|max| max.get())
}

struct RootFix {
    keys: BTreeSet<String>,
    rules: Vec<(String, Hit)>,
}

/// Work out one root's lines into `sim.added`, or why there are none.
///
/// 1. **What ignores it.** The rules that ignore the root's probes are found
///    one by one in the scratch repository, each emptied before asking
///    again. If any of them ignores something *inside* the root (a skill
///    directory, a file in a skill), the root is refused: only a negation
///    inside the skills would answer it, and such a negation also overrides
///    every other rule there — `.env`, keys, each teammate's own excludes.
/// 2. **The lines.** Each excluded level above the root, then the root, is
///    re-opened, top down; again, nothing inside the root.
/// 3. **The check.** See [`check_opened`].
fn fix_root(
    sim: &mut Sim,
    repo: &Repo,
    root: &str,
    probes: &[String],
    guard: &[String],
    skill_dirs: &[String],
) -> Result<RootFix, Refuse> {
    let all_levels: Vec<String> = probes.iter().flat_map(|p| levels_of(p)).collect();

    // 1.
    let mut answered: Answered = BTreeSet::new();
    let none = BTreeSet::new();
    for _ in 0..32 {
        let hits = sim.run(
            State::Baseline {
                answered: &answered,
                dormant: &none,
            },
            &all_levels,
        )?;
        let Some(hit) = first_ignored(probes, &hits) else {
            break;
        };
        let Source::File(key) = classify(&hit.source) else {
            return Err(Refuse::Outside(hit, !answered.is_empty()));
        };
        if sim.links.contains(&key) {
            return Err(Refuse::Link(hit));
        }
        if under(base_dir(&key), root).is_none() {
            return Err(Refuse::InsideRoot(hit));
        }
        if inside(root, &hit.path) {
            return Err(Refuse::NeedsInside(key, hit));
        }
        let line = hit.line.parse::<usize>().unwrap_or(0);
        if !answered.insert((key, line)) {
            return Err(Refuse::Stuck(hit));
        }
    }
    if answered.is_empty() {
        return Err(Refuse::Unseen);
    }

    // 2.
    let start: BTreeMap<String, usize> =
        sim.added.iter().map(|(k, v)| (k.clone(), v.len())).collect();
    let mut keys = BTreeSet::new();
    let mut rules = Vec::new();
    for probe in probes {
        let levels = levels_of(probe);
        let mut done = false;
        for _ in 0..16 {
            let hits = sim.check(&levels)?;
            let Some(hit) = first_ignored(std::slice::from_ref(probe), &hits) else {
                done = true;
                break;
            };
            let Source::File(key) = classify(&hit.source) else {
                return Err(Refuse::Outside(hit, !answered.is_empty()));
            };
            let ours = sim.is_ours(&key, &hit);
            let line = hit.line.parse::<usize>().unwrap_or(0);
            if !ours && !answered.contains(&(key.clone(), line)) {
                return Err(Refuse::Stuck(hit));
            }
            if inside(root, &hit.path) {
                return Err(Refuse::NeedsInside(key, hit));
            }
            let Some(lines) = step_lines(&key, root, &hit.path) else {
                return Err(Refuse::InsideRoot(hit));
            };
            let have = sim.added.entry(key.clone()).or_default();
            let new: Vec<String> = lines.into_iter().filter(|l| !have.contains(l)).collect();
            if new.is_empty() {
                return Err(Refuse::Stuck(hit));
            }
            have.extend(new);
            keys.insert(key.clone());
            if !ours {
                rules.push((key, hit));
            }
        }
        if !done {
            return Err(Refuse::Unseen);
        }
    }
    let mut open: Vec<String> = guard.to_vec();
    open.extend(probes.iter().cloned());
    if !sim.all_open(&open)? {
        if let Some(hit) = sim.check(probes)?.into_iter().find(Hit::ignored) {
            return Err(Refuse::Stuck(hit));
        }
    }

    // 3.
    let mut opened = vec![root.to_string()];
    for key in &keys {
        let dir = base_dir(key);
        let from = start.get(key).copied().unwrap_or(0);
        for line in &sim.added[key][from..] {
            if let Some(rel) = line.strip_prefix("!/").and_then(|l| l.strip_suffix('/')) {
                // The lines name directories on the way to the root; map the
                // escaped name back to the level it opens.
                let level = ancestors(&format!("{root}/x"))
                    .into_iter()
                    .skip(1)
                    .find(|level| under(dir, level).map(esc_path).as_deref() == Some(rel));
                if let Some(level) = level {
                    if !opened.contains(&level) {
                        opened.push(level);
                    }
                }
            }
        }
    }
    check_opened(sim, repo, root, &answered, &opened, skill_dirs)?;
    Ok(RootFix { keys, rules })
}

/// The check that the lines un-ignore nothing but the skills.
///
/// Every directory the lines open is walked in the member's tree (names only,
/// never read), with each `.gitignore` found copied into the scratch
/// repository — a file git does not read today because its directory is
/// excluded wakes up once the directory is opened. A directory still ignored
/// after the fix is not descended into: nothing under it can change. Then,
/// for every entry found and [`CANARIES`] in every opened directory and
/// every skill:
///
/// - **outside the root**, anything ignored today must stay ignored (a
///   dormant `!settings.local.json` in `.claude/.gitignore` would not);
/// - **inside the root**, anything the rules other than the answered ones
///   ignore (today's files, dormant ones left out) must stay ignored.
///
/// Refused, naming the path, when either fails; refused when there are more
/// than [`walk_max`] entries, rather than passing on what was not checked.
fn check_opened(
    sim: &mut Sim,
    repo: &Repo,
    root: &str,
    answered: &Answered,
    opened: &[String],
    skill_dirs: &[String],
) -> Result<(), Refuse> {
    let mut starts: Vec<String> = opened.to_vec();
    starts.sort_by_key(|dir| dir.len());
    let top = starts[0].clone();

    let mut entries: Vec<String> = Vec::new();
    let mut gitignores: Vec<String> = Vec::new();
    // Level by level, so the question "still ignored after the fix?" is one
    // `git check-ignore` per depth rather than one per directory.
    let mut level = vec![top.clone()];
    while !level.is_empty() {
        let mut dirs = Vec::new();
        for dir in &level {
            let read = match std::fs::read_dir(repo.top.join(dir)) {
                Ok(read) => read,
                // A root that isn't there yet has nothing to check.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(Refuse::Unreadable(dir.clone())),
            };
            for entry in read {
                let Ok(entry) = entry else {
                    return Err(Refuse::Unreadable(dir.clone()));
                };
                let name = entry.file_name().to_string_lossy().to_string();
                // A `.git` anywhere (a skill cloned in place) is git's own,
                // never content, and never counts toward the limit.
                if name == ".git" {
                    continue;
                }
                let rel = if dir.is_empty() { name.clone() } else { format!("{dir}/{name}") };
                let Ok(kind) = entry.file_type() else {
                    return Err(Refuse::Unreadable(rel));
                };
                if kind.is_dir() {
                    sim.mkdir(&rel)?;
                    dirs.push(rel.clone());
                } else if name == ".gitignore" && kind.is_file() {
                    sim.copy_gitignore(repo, dir)?;
                    gitignores.push(dir.clone());
                }
                entries.push(rel);
                if entries.len() > walk_max() {
                    return Err(Refuse::TooMany(top));
                }
            }
        }
        // Descend only where the fix leaves the directory open.
        level = Vec::new();
        if !dirs.is_empty() {
            let after = sim.check(&dirs)?;
            let closed: BTreeSet<&str> = after
                .iter()
                .filter(|h| h.ignored())
                .map(|h| h.path.as_str())
                .collect();
            level = dirs.into_iter().filter(|d| !closed.contains(d.as_str())).collect();
        }
    }
    let mut canary_dirs: Vec<String> = opened.to_vec();
    canary_dirs.extend(skill_dirs.iter().cloned());
    for dir in &canary_dirs {
        sim.mkdir(dir)?;
        for name in CANARIES {
            let path = format!("{dir}/{name}");
            if let Some((parent, _)) = path.rsplit_once('/') {
                sim.mkdir(parent)?;
            }
            entries.push(path);
        }
    }
    entries.sort();
    entries.dedup();

    let today = sim.run(State::Today, &entries)?;
    let fixed = sim.check(&entries)?;
    // A `.gitignore` git does not read today: its directory is ignored.
    let today_dirs = sim.run(State::Today, &gitignores)?;
    let dormant: BTreeSet<String> = gitignores
        .iter()
        .filter(|dir| today_dirs.iter().any(|h| &&h.path == dir && h.ignored()))
        .map(|dir| gitignore_key(dir))
        .collect();
    let baseline = sim.run(
        State::Baseline {
            answered,
            dormant: &dormant,
        },
        &entries,
    )?;
    // Indexed by path: one answer per path, and ~20,000 of them.
    let index = |hits: &[Hit]| -> std::collections::HashMap<String, Hit> {
        hits.iter().map(|h| (h.path.clone(), h.clone())).collect()
    };
    let (today, fixed, baseline) = (index(&today), index(&fixed), index(&baseline));
    let find = |hits: &std::collections::HashMap<String, Hit>, path: &str| {
        hits.get(path).filter(|h| h.ignored()).cloned()
    };
    for path in &entries {
        // The directories the lines open, the root among them, are meant to
        // change.
        if find(&fixed, path).is_some() || opened.contains(path) {
            continue;
        }
        let was = if inside(root, path) {
            find(&baseline, path)
        } else {
            find(&today, path)
        };
        if let Some(was) = was {
            // What wins for it after the fix, if a rule does: most often a
            // negation in a `.gitignore` git skips today.
            let now = fixed.get(path.as_str()).filter(|h| !h.source.is_empty()).cloned();
            let woken = now
                .as_ref()
                .map(|h| dormant.contains(&h.source))
                .unwrap_or(false);
            return Err(Refuse::Leak {
                path: path.clone(),
                was: was.rule(&was.source),
                now: now.map(|h| h.rule(&h.source)),
                woken,
            });
        }
    }
    Ok(())
}

/// The edit to make by hand for a rule that ignores inside the root, when
/// there is a safe one to name: `X/**` above the root becomes `X/*` plus the
/// directory lines Ply would have written.
fn suggestion(key: &str, pattern: &str, root: &str) -> Option<String> {
    let dir = base_dir(key);
    let prefix = pattern.strip_suffix("/**")?;
    let anchored = prefix.starts_with('/');
    let bare = prefix.trim_start_matches('/');
    if bare.is_empty() || has_glob(bare) {
        return None;
    }
    let at = if dir.is_empty() {
        bare.to_string()
    } else {
        format!("{dir}/{bare}")
    };
    if at == root {
        return Some(format!("Remove the line {pattern}."));
    }
    if !inside(&at, root) {
        return None;
    }
    let mut lines = vec![format!("{}{bare}/*", if anchored { "/" } else { "" })];
    for level in ancestors(&format!("{root}/x")).into_iter().skip(1) {
        if !inside(&at, &level) {
            continue;
        }
        let rel = esc_path(under(dir, &level)?);
        if level == root {
            lines.push(format!("!/{rel}/"));
        } else {
            lines.push(format!("!/{rel}/"));
            lines.push(format!("/{rel}/*"));
        }
    }
    Some(format!("Replace the line {pattern} with:\n{}", lines.join("\n")))
}

/// The probes behind the doctor's "gitignored" roots: the repo-wide probe for
/// a root ignored as a whole, and each skill whose copy there is ignored.
/// `(root, probe)`, both relative to `cwd`.
fn ignored_probes(cwd: &Path) -> Vec<(String, String)> {
    probes_of(&project_skills::read_project_skills(cwd))
}

fn probes_of(skills: &project_skills::ProjectSkills) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for root in SKILL_ROOTS {
        let rel = root.rel.to_string();
        if skills.ignored_roots.contains(&rel) {
            out.push((
                rel.clone(),
                project_skills::skill_probe(&rel, project_skills::PROBE_SKILL),
            ));
        }
        for skill in &skills.skills {
            if skill.ignored_roots.contains(&rel) {
                out.push((rel.clone(), project_skills::skill_probe(&rel, &skill.name)));
            }
        }
    }
    out
}

/// GH #227: why there is no plan when nothing is ignored as far as git
/// answered, but git did not answer for everything — a root, a skill's copy
/// or a link. In plain words; git's own are in the doctor's Details. `None`
/// when "no root is ignored" is true.
fn unanswered_reason(skills: &project_skills::ProjectSkills) -> Option<String> {
    let mut paths: Vec<&str> = skills
        .boundaries
        .iter()
        .filter(|b| b.ignored.is_none())
        .map(|b| b.path.as_str())
        .collect();
    paths.extend(skills.unanswered.iter().map(|u| u.path.as_str()));
    if paths.is_empty() {
        return None;
    }
    let mut reasons: Vec<&str> = skills.unanswered.iter().map(|u| u.reason.as_str()).collect();
    reasons.sort_unstable();
    reasons.dedup();
    Some(format!(
        "Plyloft couldn't ask git whether {} {} ignored{}, so it can't tell what to add.",
        paths.join(" and "),
        if paths.len() == 1 { "is" } else { "are" },
        if reasons.is_empty() {
            String::new()
        } else {
            format!(" ({})", reasons.join("; "))
        },
    ))
}

/// GH #227: a skill root that is itself a link (or a repository of its own)
/// git ignores. Un-ignore's lines open directories, and git stores a link as
/// a file and a repository as a commit, so they would not carry it: the plan
/// explains it, with the line that carries a link, and writes nothing for it.
fn boundary_refusal(repo: &Repo, b: &project_skills::SkillBoundary) -> IgnoreRefusal {
    use project_skills::BoundaryKind;
    let at = format!("{}{}", repo.prefix, b.path);
    let rule = check_ignore(&repo.top, &[], &[at.clone()])
        .ok()
        .and_then(|hits| hits.into_iter().find(|hit| hit.ignored()))
        .map(|hit| format!("{}:{}: {}", hit.source, hit.line, hit.pattern))
        .unwrap_or_default();
    match b.kind {
        BoundaryKind::Link => IgnoreRefusal {
            root: b.root.clone(),
            reason: format!(
                "{} is a link, not a directory. Git stores a link as a file, not the skills it \
                 points to, and the lines Plyloft adds open directories, so they wouldn't carry it. \
                 Add the line by hand after the rule that ignores it, then look again.",
                b.path
            ),
            suggestion: Some(match at.rsplit_once('/') {
                Some((parent, _)) => format!(
                    "Add after the rule that ignores it:\n!/{at}\n(If {parent}/ itself is \
                     ignored, put !/{parent}/ and /{parent}/* before it.)"
                ),
                None => format!("Add after the rule that ignores it:\n!/{at}"),
            }),
            rule,
        },
        BoundaryKind::Submodule | BoundaryKind::NestedRepository => IgnoreRefusal {
            root: b.root.clone(),
            reason: format!(
                "{} is a repository of its own. Git stores which commit it is at, not its \
                 files, so the lines Plyloft adds wouldn't carry the skills in it.{}",
                b.path,
                if b.kind == BoundaryKind::Submodule {
                    ""
                } else {
                    " It isn't a registered submodule either, so committing it would give \
                     card worktrees and teammates nothing they can check out: add it with \
                     git submodule add, or keep the skills in a plain directory."
                }
            ),
            suggestion: None,
            rule,
        },
    }
}

/// A plan and what writing it needs: each file's path and the bytes the plan
/// was made against.
struct Worked {
    plan: IgnorePlan,
    writes: Vec<(PathBuf, Vec<u8>, Vec<String>)>,
}

fn display_of(repo: &Repo, key: &str) -> String {
    if key != INFO_KEY {
        return key.to_string();
    }
    match repo.info_exclude.strip_prefix(&repo.top) {
        Ok(rel) => crate::platform::slash_path(rel),
        Err(_) => repo.info_exclude.to_string_lossy().to_string(),
    }
}

fn path_of(repo: &Repo, key: &str) -> PathBuf {
    if key == INFO_KEY {
        repo.info_exclude.clone()
    } else {
        repo.top.join(key)
    }
}

/// Whom a file's lines reach: tracked, not yet tracked, or ignored itself.
fn reach_of(repo: &Repo, key: &str) -> EditReach {
    if key == INFO_KEY {
        return EditReach::Clone;
    }
    let spec = format!(":(literal){key}");
    let tracked = git(&repo.top, &["ls-files", "--error-unmatch", "--", &spec])
        .map(|o| o.status.success())
        .unwrap_or(false);
    if tracked {
        return EditReach::Repository;
    }
    let ignored = check_ignore(&repo.top, &[], &[key.to_string()])
        .map(|hits| hits.iter().any(|h| h.path == key && h.ignored()))
        .unwrap_or(false);
    if ignored {
        EditReach::Checkout
    } else {
        EditReach::Untracked
    }
}

fn refusal(repo: &Repo, root: &str, why: Refuse, real: Option<&Hit>) -> IgnoreRefusal {
    let shown = |hit: &Hit| match classify(&hit.source) {
        Source::File(key) => display_of(repo, &key),
        Source::Outside => hit.source.clone(),
    };
    let then = "then look again.";
    let (reason, suggestion, rule) = match why {
        Refuse::Outside(hit, also_repo) => {
            let whose = if repo.excludes_local && repo.excludes_file.as_deref() == Some(&hit.source) {
                "the excludes file this clone's own git config names"
            } else {
                "your own git settings"
            };
            let lead = if also_repo {
                format!("Besides a rule in this repository, {root} is also ignored by {whose}.")
            } else {
                format!("{root} is ignored by {whose}, not by this repository.")
            };
            (
                format!(
                    "{lead} That file is outside the repository, so Plyloft leaves it alone, and \
                     answering it from the repository's .gitignore would change what everyone \
                     who opens the repo ignores. Remove or narrow the rule Details names, {then}"
                ),
                None,
                hit.rule(&hit.source),
            )
        }
        Refuse::InsideRoot(hit) => {
            let file = shown(&hit);
            (
                format!(
                    "{root} is ignored by {file}, a file inside the skills directory itself. \
                     Remove the rule Details names there by hand, {then}"
                ),
                None,
                hit.rule(&file),
            )
        }
        Refuse::NeedsInside(key, hit) => {
            let file = display_of(repo, &key);
            let hint = suggestion(&key, &hit.pattern, root);
            let tail = if hint.is_some() {
                format!("Edit {file} by hand instead, {then}")
            } else {
                format!(
                    "Change the rule Details names so it no longer matches inside {root}, {then}"
                )
            };
            (
                format!(
                    "A rule in {file} also ignores the files inside {root}. Un-ignoring them \
                     from here would also un-ignore .env files, keys and whatever each \
                     teammate's own git settings ignore there, so Plyloft leaves this one to you. \
                     {tail}"
                ),
                hint,
                hit.rule(&file),
            )
        }
        Refuse::Stuck(hit) => {
            let file = shown(&hit);
            (
                format!(
                    "Git would still ignore {root} after the lines Plyloft would add: a rule in \
                     {file} wins over them. Edit it by hand, {then}"
                ),
                None,
                hit.rule(&file),
            )
        }
        Refuse::Link(hit) => {
            let file = shown(&hit);
            (
                format!(
                    "{root} is ignored by a rule in {file}, and {file} is a link. Plyloft writes \
                     only regular files; edit the file it points to by hand, {then}"
                ),
                None,
                hit.rule(&file),
            )
        }
        Refuse::Leak {
            path,
            was,
            now,
            woken,
        } => {
            let reason = match (&now, woken) {
                (Some(_), true) => format!(
                    "Un-ignoring {root} would make git read a .gitignore it skips today, and \
                     its rule would un-ignore {path}, which is ignored now. Plyloft won't add lines \
                     that expose it: change or remove that rule (Details names it), {then}"
                ),
                (Some(_), false) => format!(
                    "Un-ignoring {root} would also un-ignore {path}, which is ignored now: a rule \
                     that has no effect today would win for it. Plyloft won't add lines that expose \
                     it: change that rule (Details names it), {then}"
                ),
                (None, _) => format!(
                    "Un-ignoring {root} would also un-ignore {path}, which is ignored now only \
                     because its directory is. Plyloft won't add lines that expose it; add a rule \
                     for it, or edit the rule that ignores {root} by hand, {then}"
                ),
            };
            let mut rule = format!("{path} is ignored today by {was}");
            if let Some(now) = now {
                rule.push_str(&format!("\nafter the fix, {now} would win"));
            }
            (reason, None, rule)
        }
        Refuse::TooMany(dir) => (
            format!(
                "There are more than {} files under {dir} to check before Plyloft could say the \
                 lines un-ignore nothing else, so it adds nothing. Edit the rule that ignores \
                 {root} by hand, {then}",
                walk_max()
            ),
            None,
            real.map(|hit| hit.rule(&shown(hit))).unwrap_or_default(),
        ),
        Refuse::Unreadable(dir) => (
            format!(
                "Plyloft couldn't list {dir}, which un-ignoring {root} would leave open, so it can't \
                 say the lines un-ignore nothing else there and adds nothing. Make it readable, \
                 or edit the rule that ignores {root} by hand, {then}"
            ),
            None,
            real.map(|hit| hit.rule(&shown(hit))).unwrap_or_default(),
        ),
        Refuse::Unseen => (
            format!(
                "Git ignores {root} here, but Plyloft could not reproduce the rule that does it, \
                 so it adds nothing. Details names the rule git reports."
            ),
            None,
            real.map(|hit| hit.rule(&shown(hit))).unwrap_or_default(),
        ),
        Refuse::Failed(error) => (
            format!("Plyloft couldn't ask git about {root}, so it adds nothing."),
            None,
            error,
        ),
    };
    IgnoreRefusal {
        root: root.into(),
        reason,
        suggestion,
        rule,
    }
}

fn work(cwd: &Path) -> Result<Worked, String> {
    let skills = project_skills::read_project_skills(cwd);
    let probes = probes_of(&skills);
    let boundaries = ignored_boundary_roots(&skills);
    if probes.is_empty() && boundaries.is_empty() {
        // Never "no root is ignored" when the check could not say so.
        if let Some(reason) = unanswered_reason(&skills) {
            return Err(reason);
        }
    }
    let mut worked = work_probes(cwd, &probes)?;
    if !boundaries.is_empty() {
        let repo = repo_at(cwd)?;
        for b in boundaries {
            if !worked.plan.roots.contains(&b.root) {
                worked.plan.roots.push(b.root.clone());
            }
            worked.plan.refused.push(boundary_refusal(&repo, b));
        }
        let order = |root: &String| SKILL_ROOTS.iter().position(|r| r.rel == root);
        worked.plan.roots.sort_by_key(order);
    }
    Ok(worked)
}

/// The roots that are themselves a link or a repository git ignores.
fn ignored_boundary_roots(
    skills: &project_skills::ProjectSkills,
) -> Vec<&project_skills::SkillBoundary> {
    skills
        .boundaries
        .iter()
        .filter(|b| b.skill.is_none() && b.ignored == Some(true))
        .collect()
}

fn work_probes(cwd: &Path, probes: &[(String, String)]) -> Result<Worked, String> {
    let mut roots: Vec<String> = Vec::new();
    for (root, _) in probes {
        if !roots.contains(root) {
            roots.push(root.clone());
        }
    }
    if probes.is_empty() {
        return Ok(Worked {
            plan: IgnorePlan::default(),
            writes: Vec::new(),
        });
    }
    let repo = repo_at(cwd)?;
    let top_rel = |path: &str| format!("{}{path}", repo.prefix);
    let all: Vec<String> = probes.iter().map(|(_, probe)| top_rel(probe)).collect();
    let real = check_ignore(&repo.top, &[], &all)?;
    let mut sim = Sim::new(&repo, &all)?;

    let mut refused = Vec::new();
    let mut fixed_probes: Vec<String> = Vec::new();
    let mut roots_by_key: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut rules_by_key: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for root in &roots {
        let before = sim.added.clone();
        let mine: Vec<String> = probes
            .iter()
            .filter(|(r, _)| r == root)
            .map(|(_, probe)| top_rel(probe))
            .collect();
        // The skills in the root, and the one a probe names.
        let root_top = top_rel(root);
        let mut skill_dirs: Vec<String> = mine
            .iter()
            .filter_map(|probe| probe.rsplit_once('/').map(|(dir, _)| dir.to_string()))
            .collect();
        if let Ok(read) = std::fs::read_dir(repo.top.join(&root_top)) {
            for entry in read.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    skill_dirs.push(format!("{root_top}/{}", entry.file_name().to_string_lossy()));
                }
            }
        }
        skill_dirs.sort();
        skill_dirs.dedup();
        let outcome = fix_root(&mut sim, &repo, &root_top, &mine, &fixed_probes, &skill_dirs);
        match outcome {
            Ok(fix) => {
                fixed_probes.extend(mine);
                for key in fix.keys {
                    roots_by_key.entry(key).or_default().push(root.clone());
                }
                for (key, hit) in fix.rules {
                    let rule = hit.rule(&display_of(&repo, &key));
                    let list = rules_by_key.entry(key).or_default();
                    if !list.contains(&rule) {
                        list.push(rule);
                    }
                }
            }
            Err(Refuse::Failed(error)) => return Err(error),
            Err(why) => {
                sim.added = before;
                let seen = real
                    .iter()
                    .find(|hit| hit.ignored() && mine.contains(&hit.path));
                refused.push(refusal(&repo, root, why, seen));
            }
        }
    }
    if !sim.all_open(&fixed_probes)? {
        return Err("Plyloft's own check of the lines it would add failed; nothing was written.".into());
    }

    let mut edits = Vec::new();
    let mut writes = Vec::new();
    for (key, lines) in &sim.added {
        if lines.is_empty() {
            continue;
        }
        let owners = roots_by_key.get(key).cloned().unwrap_or_default();
        let mut block = vec![format!(
            "# Plyloft: un-ignore {} so commits carry the skills",
            owners.join(" and ")
        )];
        block.extend(lines.iter().cloned());
        edits.push(IgnoreEdit {
            file: display_of(&repo, key),
            reach: reach_of(&repo, key),
            roots: owners,
            lines: block.clone(),
            rules: rules_by_key.get(key).cloned().unwrap_or_default(),
        });
        writes.push((
            path_of(&repo, key),
            sim.base.get(key).cloned().unwrap_or_default(),
            block,
        ));
    }
    Ok(Worked {
        plan: IgnorePlan {
            roots,
            edits,
            refused,
        },
        writes,
    })
}

/// What un-ignoring the skill roots of `cwd` would add, and what it cannot.
pub fn plan(cwd: &Path) -> Result<IgnorePlan, String> {
    Ok(work(cwd)?.plan)
}

/// The doctor's roots git ignores in `cwd`, in its order.
fn ignored_roots(cwd: &Path) -> Vec<String> {
    let mut roots = Vec::new();
    for (root, _) in ignored_probes(cwd) {
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Append exactly `confirmed`, the edits the member saw, then check again.
///
/// Refused with nothing written when the plan worked out now differs from
/// `confirmed` (a file changed since the confirmation opened), or when a file
/// changed between that and the write.
pub fn apply(cwd: &Path, confirmed: &[IgnoreEdit]) -> Result<IgnoreFixOutcome, String> {
    if confirmed.is_empty() {
        return Err("Nothing was confirmed, so nothing was written.".into());
    }
    let worked = work(cwd)?;
    if worked.plan.edits != confirmed {
        return Err(
            "The ignore rules changed since the confirmation opened, so nothing was written. \
             Look again and confirm the lines it shows now."
                .into(),
        );
    }
    for (path, base, _) in &worked.writes {
        let now = std::fs::read(path).unwrap_or_default();
        let regular = std::fs::symlink_metadata(path)
            .map(|m| m.file_type().is_file())
            .unwrap_or(false);
        if &now != base || !regular {
            return Err(format!(
                "{} changed while Plyloft was writing, so nothing was written. Look again.",
                path.display()
            ));
        }
    }
    let mut written = Vec::new();
    for ((path, base, block), edit) in worked.writes.iter().zip(&worked.plan.edits) {
        if let Err(error) = write_atomic_bytes(path, &append_block(base, block)) {
            let done: Vec<String> = written.iter().map(|e: &IgnoreEdit| e.file.clone()).collect();
            return Err(if done.is_empty() {
                format!("{} could not be written ({error}); nothing was changed.", edit.file)
            } else {
                format!(
                    "{} could not be written ({error}). {} already {} {} lines.",
                    edit.file,
                    done.join(" and "),
                    if done.len() == 1 { "has" } else { "have" },
                    if done.len() == 1 { "its" } else { "their" },
                )
            });
        }
        written.push(edit.clone());
    }
    let still_ignored = ignored_roots(cwd);
    // A refused root had no lines: it is not "no longer ignored" (GH #227 —
    // a linked root never is in `still_ignored`, which asks directories).
    let refused: Vec<&String> = worked.plan.refused.iter().map(|r| &r.root).collect();
    let fixed: Vec<String> = worked
        .plan
        .roots
        .iter()
        .filter(|root| !still_ignored.contains(root) && !refused.contains(root))
        .cloned()
        .collect();
    let after = project_skills::read_project_skills(cwd);
    // A whole root that is an ignored link, and (review 2) one skill's link
    // git ignores by a rule of its own — the root's lines don't carry it.
    let links_left: Vec<String> = after
        .boundaries
        .iter()
        .filter(|b| {
            b.ignored == Some(true)
                && (b.skill.is_none() || !after.ignored_roots.contains(&b.root))
        })
        .map(|b| match b.kind {
            project_skills::BoundaryKind::Link => format!("{} (a link)", b.path),
            project_skills::BoundaryKind::Submodule
            | project_skills::BoundaryKind::NestedRepository => {
                format!("{} (a repository of its own)", b.path)
            }
        })
        .collect();
    let files: Vec<String> = written.iter().map(|e| e.file.clone()).collect();
    let count: usize = written.iter().map(|e| e.lines.len()).sum();
    let mut sentence = format!(
        "Added {} to {}.",
        plural(count, "line", "lines"),
        files.join(" and ")
    );
    if !fixed.is_empty() {
        sentence.push_str(&format!(" Git no longer ignores {}.", fixed.join(" and ")));
    }
    if !still_ignored.is_empty() {
        sentence.push_str(&format!(
            " Git still ignores {}, so Plyloft added nothing more — Un-ignore shows why.",
            still_ignored.join(" and ")
        ));
    }
    if !links_left.is_empty() {
        sentence.push_str(&format!(
            " Git still ignores {}: these lines open directories, which {} not — \
             the Project skills row says what to add by hand.",
            links_left.join(" and "),
            if links_left.len() == 1 { "it is" } else { "they are" },
        ));
    }
    let committed: Vec<String> = written
        .iter()
        .filter(|e| matches!(e.reach, EditReach::Repository | EditReach::Untracked))
        .map(|e| e.file.clone())
        .collect();
    if !committed.is_empty() {
        sentence.push_str(&format!(
            " Commit {} with the skills so card worktrees and teammates get them.",
            committed.join(" and ")
        ));
    }
    Ok(IgnoreFixOutcome {
        written,
        still_ignored,
        sentence,
    })
}

// ── Commands ─────────────────────────────────────────────────────────

fn workspace_cwd(app: &tauri::AppHandle, workspace_id: &str) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.state::<crate::workspace::WorkspaceStore>()
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| PathBuf::from(w.cwd))
        .ok_or_else(|| format!("workspace '{workspace_id}' not found"))
}

/// The confirmation's content. Reads only; writes nothing.
#[tauri::command]
pub async fn skill_root_ignore_plan(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<IgnorePlan, String> {
    let cwd = workspace_cwd(&app, &workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || plan(&cwd))
        .await
        .map_err(|e| format!("un-ignore plan worker failed: {e}"))?
}

/// The confirmed write: exactly `edits`, or nothing.
#[tauri::command]
pub async fn skill_root_ignore_fix(
    app: tauri::AppHandle,
    workspace_id: String,
    edits: Vec<IgnoreEdit>,
) -> Result<IgnoreFixOutcome, String> {
    let cwd = workspace_cwd(&app, &workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || apply(&cwd, &edits))
        .await
        .map_err(|e| format!("un-ignore worker failed: {e}"))?
}

#[cfg(test)]
#[path = "skill_root_ignore_tests.rs"]
mod tests;
