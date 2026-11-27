//! Skills hub H7 (`docs/plans/SKILLS_HUB.md` R4, §5.7, §7.3): **the index
//! behind All skills** — every skill this Mac can see, in one list.
//!
//! **Facts, not judgements.** The index reads where each skill is and what it
//! is: every workspace's repository skills (warm or cold), the team library,
//! this Mac's own folders and Plyloft's bundle — each row with its CLIs, its
//! content ids and, for a linked copy, its link state. *Used in*, the filters
//! and the sidebar's count are joins over these rows, made in the page
//! (`src/lib/allSkills.ts`), so a row that streams in changes them at once.
//!
//! **Never in the way (§7.3, the 2026-10-13 startup lesson).** Nothing here
//! runs at launch: the cache is read when the page (or the sidebar's count)
//! first asks, and a refresh runs on its own thread with at most
//! [`THREADS`] workers, a workspace at a time, yielding between them. It reads
//! three skill roots per workspace, depth 2 — never a whole checkout, never
//! `target/`, `node_modules/`, `.git/` or a worktree directory — and starts no
//! watcher, no PTY and no definition refresh: a cold workspace is read, never
//! warmed. GitHub is never asked: a library is read from its clone as it is.
//!
//! **Content ids in process** ([`hash`]): git's tree hashing, cached per
//! skill directory by a fingerprint of its files' paths, sizes, times and
//! modes, so a warm refresh is a walk of `stat`s. One `git ls-tree` per
//! library gives the library's own ids. A linked copy whose in-process ids
//! say *up to date* is up to date; any other linked copy is judged the way
//! the workspace's Library judges it (git's clean filters, the library's
//! history), so the two pages never disagree about a link.
//!
//! **Streaming.** `skills-hub://index` carries each source as it is read
//! (`started`, `source`, `workspace`, `done`); the cache
//! `<config_dir>/skills_hub/index.json` (§5.7) is written atomically when a
//! refresh ends. It is disposable: a file that doesn't parse, or of another
//! `schemaVersion`, is dropped and the next refresh writes a new one.
//!
//! **Exit (Hard rule 4).** [`stop`] is called from `run_exit_cleanup`: a
//! refresh stops between workspaces. Its children are short local `git`
//! reads of a clone or a checkout, the same the Library runs.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::skill_links::{LinkOrigin, LinkState, SkillLink, TwinIds};

#[path = "skills_index_hash.rs"]
pub(crate) mod hash;

use hash::{Eol, Normalise};

pub(crate) const SCHEMA_VERSION: u32 = 1;
pub(crate) const INDEX_EVENT: &str = "skills-hub://index";
/// A skill directory with more files than this has no content id (§7.3).
pub(crate) const MAX_FILES: usize = 500;
/// A source with more skills than this lists the rest without content ids.
pub(crate) const MAX_SKILLS: usize = 2000;
/// The bounded pool (the "≤ 2 heavy lines" rule).
pub(crate) const THREADS: usize = 2;

pub(crate) fn index_path(config_dir: &Path) -> PathBuf {
    config_dir.join("skills_hub").join("index.json")
}

// ── What the index holds ─────────────────────────────────────────────

/// One skill at one place.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexRow {
    /// The directory name: its identity.
    pub name: String,
    pub description: String,
    /// What Codex calls it, when the frontmatter `name` disagrees.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_name: Option<String>,
    /// The team plugin it lives in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    pub claude: bool,
    pub codex: bool,
    /// Each twin's content id (the git tree id of its directory).
    pub claude_id: Option<String>,
    pub codex_id: Option<String>,
    /// Both twins are there and they are not the same files (the files only
    /// Codex needs left out).
    pub twins_differ: bool,
    /// The Codex copy is the legacy `.codex/skills` one.
    pub legacy_codex: bool,
    /// Its directory, absolute (the Claude copy's when there is one).
    pub dir: String,
    /// The newest modification time of its files, ms.
    pub changed_at: Option<i64>,
    /// Too many files (or a noisy directory inside it) to index: no id.
    pub too_many_files: bool,
    /// A linked copy: where it came from and how it stands.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<IndexLink>,
    /// A team skill whose scripts wait for this Mac's OK (R15).
    pub needs_ok: bool,
    /// A Plyloft skill switched off on this Mac.
    pub off_here: bool,
    /// H10 Windows walk (§8): a library skill (team or My library) whose
    /// session snapshot paths would pass Windows' limit on this computer, so
    /// sessions here don't get it (`library_snapshot::PATH_TOO_LONG`).
    /// Absent from a cache written before it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub too_long_here: bool,
    /// A shared workspace's skill only its mirror of the integration branch
    /// has: not in this checkout (its Library lists it the same way).
    pub branch_only: bool,
}

/// A linked copy's origin and state, as the row shows it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexLink {
    pub origin_kind: String,
    pub origin_words: String,
    pub source: String,
    pub plugin: Option<String>,
    /// The skill's name at its origin.
    pub name: String,
    pub state: Option<LinkState>,
    /// H8: the link is kept on this Mac only.
    pub local: bool,
    /// H8: the origin workspace on this Mac (a local link's, or the checkout
    /// a committed `workspace` link is read from), so Used in joins a copy
    /// to that one row only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_workspace: Option<String>,
}

/// One workspace, as the index read it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexWorkspace {
    pub id: String,
    pub name: String,
    pub path: String,
    /// `"ok"`, or `"missing"` — the folder isn't there (moved, a drive that
    /// isn't mounted). Its last rows are kept, never deleted.
    pub state: String,
    /// `"checkout"`; `"branch"` — a shared workspace's last mirror of its
    /// integration branch; `"checkoutShared"` — a shared workspace with no
    /// mirror on this Mac yet, read from the checkout.
    pub source: String,
    /// `owner/name` of its `origin` remote: two checkouts of one repository
    /// are counted once.
    pub repo: Option<String>,
    /// A shared workspace's integration branch, from its mirror's manifest.
    pub branch: Option<String>,
    pub read_at: Option<i64>,
    pub rows: Vec<IndexRow>,
}

/// A library or folder that isn't a workspace: the team library, this
/// Mac's own skills, Plyloft's.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexSource {
    /// The team library's `owner/name`.
    pub repo: Option<String>,
    pub read_at: Option<i64>,
    pub rows: Vec<IndexRow>,
    /// Why it lists nothing it could otherwise (no clone yet, switched off).
    pub problem: Option<String>,
}

/// Everything All skills draws.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HubIndex {
    pub schema_version: u32,
    /// When the last whole refresh ended, ms.
    pub built_at: Option<i64>,
    pub workspaces: Vec<IndexWorkspace>,
    pub team: Option<IndexSource>,
    /// Skills hub H10: My library, when this Mac uses one.
    pub my_library: Option<IndexSource>,
    pub this_mac: Option<IndexSource>,
    pub plyloft: Option<IndexSource>,
}

/// What a skill directory was, at a fingerprint: reused while it holds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DirFacts {
    pub print: String,
    pub id: Option<String>,
    /// The id without the files only Codex needs (a Codex twin's compare id).
    pub compare_id: Option<String>,
    pub changed_at: Option<i64>,
    pub too_many: bool,
    /// The `SKILL.md` as a CLI reads it; `None`: no CLI loads it.
    pub description: Option<String>,
    pub codex_name: Option<String>,
}

/// `index.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexFile {
    pub schema_version: u32,
    pub index: HubIndex,
    /// Per skill directory (and how it was normalised), what it was.
    pub dirs: BTreeMap<String, DirFacts>,
}

/// The cache on disk, or nothing: a file that doesn't parse, or of another
/// schema, is dropped (§5.7).
pub fn load_file(config_dir: &Path) -> IndexFile {
    let path = index_path(config_dir);
    let Ok(bytes) = std::fs::read(&path) else {
        return IndexFile::default();
    };
    match serde_json::from_slice::<IndexFile>(&bytes) {
        Ok(file) if file.schema_version == SCHEMA_VERSION => file,
        Ok(file) => {
            log::info!("skills index: dropped a cache of schema {}", file.schema_version);
            IndexFile::default()
        }
        Err(error) => {
            log::info!("skills index: dropped an unreadable cache ({error})");
            IndexFile::default()
        }
    }
}

pub fn save_file(config_dir: &Path, file: &IndexFile) -> Result<(), String> {
    let mut file = file.clone();
    file.schema_version = SCHEMA_VERSION;
    file.index.schema_version = SCHEMA_VERSION;
    crate::atomic::write_atomic_json(&index_path(config_dir), &file)
}

// ── The directory cache ──────────────────────────────────────────────

/// The per-directory facts of one refresh: what the last one knew, and the
/// keys this one touched (the rest under a re-read root are pruned).
pub struct DirCache {
    known: Mutex<BTreeMap<String, DirFacts>>,
    touched: Mutex<BTreeSet<String>>,
}

impl DirCache {
    pub fn new(known: BTreeMap<String, DirFacts>) -> Self {
        Self { known: Mutex::new(known), touched: Mutex::new(BTreeSet::new()) }
    }

    /// The facts of the skill directory `dir`, computed again only when its
    /// fingerprint moved. `side` names the twin (a Codex copy's compare id
    /// leaves out the files only Codex needs); `hash_it` false lists it
    /// without an id (a source over [`MAX_SKILLS`]).
    pub fn facts(&self, dir: &Path, eol: impl Into<Eol>, side: Option<crate::skill_reach::Side>, hash_it: bool) -> DirFacts {
        let eol = eol.into();
        // No `\\?\` in the file: the key is the path as it is shown.
        let key = format!("{}|{}", crate::platform::display_path(dir), eol_tag(&eol));
        self.touched.lock().unwrap_or_else(|p| p.into_inner()).insert(key.clone());
        let loaded = || crate::team_skills::read_skill_dir(dir, &mut Vec::new());
        let files = match hash::walk_skill(dir, MAX_FILES) {
            Ok(files) => files,
            Err(refusal) => {
                let skill = loaded();
                return DirFacts {
                    print: String::new(),
                    too_many: refusal == hash::Refusal::TooMany,
                    description: skill.as_ref().map(|s| s.description.clone()),
                    codex_name: skill.and_then(|s| s.codex_name),
                    ..Default::default()
                };
            }
        };
        let print = format!("{}{}", hash::fingerprint(&files), if hash_it { "" } else { ":unhashed" });
        if let Some(known) = self.known.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
            if known.print == print {
                return known.clone();
            }
        }
        let skill = loaded();
        let changed_at = files.iter().map(|f| f.mtime_ms).max();
        let (id, compare_id) = if hash_it {
            let id = hash::tree_id(dir, &files, &eol, |_| false);
            let compare_id = match side {
                Some(side) if files.iter().any(|f| crate::skill_twins::vendor_only(side, &f.rel)) => {
                    hash::tree_id(dir, &files, &eol, |rel| crate::skill_twins::vendor_only(side, rel))
                }
                _ => id.clone(),
            };
            (id, compare_id)
        } else {
            (None, None)
        };
        let facts = DirFacts {
            print,
            id,
            compare_id,
            changed_at,
            too_many: !hash_it,
            description: skill.as_ref().map(|s| s.description.clone()),
            codex_name: skill.and_then(|s| s.codex_name),
        };
        self.known.lock().unwrap_or_else(|p| p.into_inner()).insert(key, facts.clone());
        facts
    }

    /// What to keep: every key touched now, and every key under none of
    /// `reread` (a source this refresh didn't read keeps its facts).
    pub fn into_kept(self, reread: &[PathBuf]) -> BTreeMap<String, DirFacts> {
        let touched = self.touched.into_inner().unwrap_or_else(|p| p.into_inner());
        self.known
            .into_inner()
            .unwrap_or_else(|p| p.into_inner())
            .into_iter()
            .filter(|(key, _)| touched.contains(key) || !reread.iter().any(|root| under(key, root)))
            .collect()
    }

    /// A whole refresh's keep: every key touched now, and the keys under
    /// `kept` (a workspace whose folder isn't there keeps its facts for when
    /// it is back). Everything else — a workspace removed from the list, a
    /// team left — goes, so the file never grows past what is listed.
    pub fn into_kept_whole(self, kept: &[PathBuf]) -> BTreeMap<String, DirFacts> {
        let touched = self.touched.into_inner().unwrap_or_else(|p| p.into_inner());
        self.known
            .into_inner()
            .unwrap_or_else(|p| p.into_inner())
            .into_iter()
            .filter(|(key, _)| touched.contains(key) || kept.iter().any(|root| under(key, root)))
            .collect()
    }
}

/// Whether the cache key `key` (`<dir>|<how>`) is `root` or inside it — by
/// whole path parts: `/a/web` is not under `/a/we`.
fn under(key: &str, root: &Path) -> bool {
    let dir = key.rsplit_once('|').map_or(key, |(dir, _)| dir);
    Path::new(dir).starts_with(crate::platform::display_path(root))
}

/// How a directory's cache key names the way it was hashed.
fn eol_tag(eol: &Eol) -> String {
    let mut tag = if eol.default == Normalise::Crlf { "lf" } else { "raw" }.to_string();
    if eol.modes.is_some() {
        tag.push_str("+head");
    }
    if let Some(attrs) = eol.attrs.as_deref().filter(|attrs| !attrs.tag.is_empty()) {
        tag.push(':');
        tag.push_str(&attrs.tag);
    }
    tag
}

// ── How a linked copy stands ─────────────────────────────────────────

/// What judging a link needs from the app: the library's ids now, and the
/// Library's own judgement for any copy the quick check can't settle.
pub trait LinkJudge: Sync {
    /// The library of `origin`'s ids at its `HEAD`, by repository path —
    /// `None` when that library isn't readable on this Mac.
    fn upstream_ids(&self, origin: &LinkOrigin) -> Option<&HashMap<String, String>>;
    /// The state the workspace's Library gives the copy (`cwd`'s `skill`).
    fn full_state(&self, cwd: &Path, skill: &str, link: &SkillLink) -> LinkState;
    /// H8: the workspace's links — its committed records, and (the app's
    /// judge) the links kept on this Mac for it, named in the second set.
    fn links(&self, input: &WorkspaceInput) -> (BTreeMap<String, SkillLink>, BTreeSet<String>) {
        (crate::skill_links::read_checkout(&input.cwd).0, BTreeSet::new())
    }
    /// H8: how a row names a link's origin (a workspace by its name here).
    fn origin_words(&self, origin: &LinkOrigin) -> String {
        crate::skill_links::origin_words(origin)
    }
    /// H8: the one workspace on this Mac a `workspace` link's copy came
    /// from (a local link names it; the app's judge finds a committed one).
    fn origin_workspace(&self, origin: &LinkOrigin) -> Option<String> {
        crate::skill_copy::origin_workspace_id(origin).map(str::to_string)
    }
}

/// The quick check: every twin the link records is, in process, exactly the
/// base, and the library still holds the link's version — or every recorded
/// twin is the library's version now. Then the copy is up to date; anything
/// else is for [`LinkJudge::full_state`].
pub fn quick_up_to_date(link: &SkillLink, here: &TwinIds, upstream: Option<&HashMap<String, String>>) -> bool {
    let Some(path) = link.origin.path.as_deref() else {
        return false;
    };
    let Some(now) = upstream.and_then(|ids| ids.get(path)) else {
        return false;
    };
    let recorded = [(&link.base.claude, &here.claude), (&link.base.codex, &here.codex)];
    if !recorded.iter().any(|(base, _)| base.is_some()) {
        return false;
    }
    let at = |want: &str| {
        recorded
            .iter()
            .filter(|(base, _)| base.is_some())
            .all(|(_, here)| here.as_deref() == Some(want))
    };
    let in_step = recorded
        .iter()
        .filter_map(|(base, here)| base.as_ref().map(|base| here.as_deref() == Some(base.as_str())))
        .all(|same| same);
    (in_step && *now == link.origin.version.content_id) || at(now)
}

// ── Reading a workspace ──────────────────────────────────────────────

pub struct WorkspaceInput {
    pub id: String,
    pub name: String,
    pub cwd: PathBuf,
    /// `projects/<ws>/` on this Mac (its mirror lives there).
    pub workspace_dir: PathBuf,
}

/// The three roots a repository holds skills in: Claude's, Codex's, and the
/// legacy Codex one (read only).
const ROOTS: [&str; 3] = [
    crate::project_skills::CLAUDE_ROOT,
    crate::project_skills::CODEX_ROOT,
    crate::project_skills::LEGACY_CODEX_ROOT,
];

/// `root`'s skill directories by name (one level: `<root>/<name>/`).
fn skill_dirs(base: &Path, root: &str) -> Vec<(String, PathBuf)> {
    let dir = root.split('/').fold(base.to_path_buf(), |at, part| at.join(part));
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            if name.starts_with('.') {
                return None;
            }
            let meta = std::fs::symlink_metadata(entry.path()).ok()?;
            (meta.is_dir() && !meta.file_type().is_symlink()).then(|| (name, entry.path()))
        })
        .collect();
    out.sort();
    out
}

/// Whether git would store `cwd`'s text files with LF (`core.autocrlf`
/// true or input), from the repository's own config, else the member's,
/// else the platform's usual default (Git for Windows installs `true`).
pub fn autocrlf(cwd: &Path) -> Normalise {
    let from = |text: &str| -> Option<bool> {
        let mut in_core = false;
        let mut found = None;
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('[') {
                in_core = line.trim_start_matches('[').trim_end_matches(']').trim().eq_ignore_ascii_case("core");
                continue;
            }
            if !in_core {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                if key.trim().eq_ignore_ascii_case("autocrlf") {
                    let value = value.trim().trim_matches('"').to_ascii_lowercase();
                    found = Some(matches!(value.as_str(), "true" | "yes" | "on" | "1" | "input"));
                }
            } else if line.eq_ignore_ascii_case("autocrlf") {
                // A bare boolean key is true.
                found = Some(true);
            }
        }
        found
    };
    let repo = git_dir(cwd).and_then(|dir| std::fs::read_to_string(dir.join("config")).ok()).and_then(|t| from(&t));
    // git reads the XDG file, then `~/.gitconfig` (the later wins).
    let user = || {
        let home = crate::personal_skills::home_dir();
        let home_file = std::fs::read_to_string(home.join(".gitconfig")).ok().and_then(|t| from(&t));
        home_file.or_else(|| std::fs::read_to_string(xdg_git(&home).join("config")).ok().and_then(|t| from(&t)))
    };
    match repo.or_else(user).unwrap_or(cfg!(windows)) {
        true => Normalise::Crlf,
        false => Normalise::None,
    }
}

/// `$XDG_CONFIG_HOME/git`, else `~/.config/git` (git's own rule; on
/// Windows too).
fn xdg_git(home: &Path) -> PathBuf {
    match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir).join("git"),
        None => home.join(".config").join("git"),
    }
}

/// The repository's top level: `cwd` or the nearest folder above it with a
/// `.git` (a workspace may be a subfolder of its repository). Stats only.
pub fn repo_top(cwd: &Path) -> Option<PathBuf> {
    cwd.ancestors().take(32).find(|at| at.join(".git").exists()).map(Path::to_path_buf)
}

/// Whether git keeps the executable bit here: never on Windows, nor where
/// the repository says `core.fileMode = false`.
pub fn file_mode_meaningful(cwd: &Path) -> bool {
    if cfg!(windows) {
        return false;
    }
    let Some(text) = git_dir(cwd).and_then(|dir| std::fs::read_to_string(dir.join("config")).ok()) else {
        return true;
    };
    let mut in_core = false;
    let mut meaningful = true;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_core = line.trim_start_matches('[').trim_end_matches(']').trim().eq_ignore_ascii_case("core");
            continue;
        }
        if let (true, Some((key, value))) = (in_core, line.split_once('=')) {
            if key.trim().eq_ignore_ascii_case("filemode") {
                meaningful = !matches!(value.trim().to_ascii_lowercase().as_str(), "false" | "no" | "off" | "0");
            }
        }
    }
    meaningful
}

/// How `cwd`'s checkout is stored by git: [`autocrlf`], the attribute files
/// outside its skill directories — the global one, `.gitattributes` at the
/// top and along each skill root, and `info/attributes` (those inside a
/// skill are part of its walk, `Eol::plan`) — and, where the executable bit
/// means nothing, `HEAD`'s modes (one `git ls-tree`, on the first directory
/// whose id must be computed).
pub fn eol_for(cwd: &Path) -> Eol {
    let default = autocrlf(cwd);
    let top = repo_top(cwd).unwrap_or_else(|| cwd.to_path_buf());
    let home = crate::personal_skills::home_dir();
    let mut text = String::new();
    let mut read = |path: PathBuf, base: &str, into: &mut Vec<hash::AttrRule>| {
        if let Ok(body) = std::fs::read_to_string(&path) {
            text.push_str(base);
            text.push('\0');
            text.push_str(&body);
            text.push('\0');
            into.extend(hash::parse_attributes(&body, base));
        }
    };
    let mut low = Vec::new();
    read(xdg_git(&home).join("attributes"), "", &mut low);
    read(top.join(".gitattributes"), "", &mut low);
    // The workspace's own path inside its repository, then each skill root.
    let below: Vec<String> = cwd
        .strip_prefix(&top)
        .ok()
        .map(|rel| rel.components().filter_map(|c| c.as_os_str().to_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let mut chain: BTreeSet<String> = BTreeSet::new();
    for root in ROOTS {
        let mut at = String::new();
        for part in below.iter().map(String::as_str).chain(root.split('/')) {
            at = if at.is_empty() { part.to_string() } else { format!("{at}/{part}") };
            chain.insert(at.clone());
        }
    }
    // Shallower first: a deeper file's rules win.
    let mut chain: Vec<String> = chain.into_iter().collect();
    chain.sort_by_key(|dir| dir.matches('/').count());
    for dir in &chain {
        let path = dir.split('/').fold(top.clone(), |at, part| at.join(part)).join(".gitattributes");
        read(path, dir, &mut low);
    }
    let mut high = Vec::new();
    if let Some(git) = git_dir(cwd) {
        read(git.join("info").join("attributes"), "", &mut high);
    }
    let tag = if text.is_empty() {
        String::new()
    } else {
        let mut sha = hash::Sha1::new();
        sha.update(text.as_bytes());
        hash::hex(&sha.finish())[..12].to_string()
    };
    let modes = (!file_mode_meaningful(cwd)).then(|| {
        let at = cwd.to_path_buf();
        std::sync::Arc::new(hash::HeadModes::new(move || head_modes(&at)))
    });
    Eol {
        default,
        attrs: Some(std::sync::Arc::new(hash::Attrs { root: top, low, high, tag })),
        modes,
    }
}

/// `HEAD`'s files under the skill roots: executable or not, by repository
/// path. Nothing when `HEAD` can't be read (a new repository).
fn head_modes(cwd: &Path) -> HashMap<String, bool> {
    let mut args = vec!["ls-tree", "-r", "-z", "--full-name", "HEAD", "--"];
    args.extend(ROOTS);
    crate::library_snapshot::git(cwd, &args)
        .map(|out| parse_ls_tree_modes(&String::from_utf8_lossy(&out)))
        .unwrap_or_default()
}

/// `git ls-tree -r -z` entries → path → `100755`.
pub(crate) fn parse_ls_tree_modes(output: &str) -> HashMap<String, bool> {
    output
        .split('\0')
        .filter_map(|line| {
            let (meta, path) = line.split_once('\t')?;
            let mode = meta.split_whitespace().next()?;
            Some((path.to_string(), mode == "100755"))
        })
        .collect()
}

/// Plain folders (this Mac's, Plyloft's): the platform's usual checkout.
pub fn platform_normalise() -> Normalise {
    if cfg!(windows) {
        Normalise::Crlf
    } else {
        Normalise::None
    }
}

/// The repository's common git directory (a worktree's `.git` file points
/// at its own, whose `commondir` names the shared one).
pub(crate) fn git_dir(cwd: &Path) -> Option<PathBuf> {
    let cwd = &repo_top(cwd)?;
    let dot = cwd.join(".git");
    let meta = std::fs::metadata(&dot).ok()?;
    if meta.is_dir() {
        return Some(dot);
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    let gitdir = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let own = if Path::new(gitdir).is_absolute() { PathBuf::from(gitdir) } else { cwd.join(gitdir) };
    match std::fs::read_to_string(own.join("commondir")) {
        Ok(common) => {
            let common = common.trim();
            Some(if Path::new(common).is_absolute() { PathBuf::from(common) } else { own.join(common) })
        }
        Err(_) => Some(own),
    }
}

/// `owner/name` of `cwd`'s `origin` remote, lower case, from its config.
pub fn origin_repo(cwd: &Path) -> Option<String> {
    let text = std::fs::read_to_string(git_dir(cwd)?.join("config")).ok()?;
    let mut in_origin = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_origin = line.replace(' ', "").eq_ignore_ascii_case("[remote\"origin\"]");
            continue;
        }
        if in_origin {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "url" {
                    return repo_of_url(value.trim());
                }
            }
        }
    }
    None
}

/// `git@github.com:Acme/Web.git`, `https://github.com/acme/web` → `acme/web`.
pub fn repo_of_url(url: &str) -> Option<String> {
    let path = url
        .split_once("://")
        .map(|(_, rest)| rest.split_once('/').map(|(_, path)| path).unwrap_or(""))
        .or_else(|| url.split_once(':').map(|(_, path)| path))?;
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = path.rsplit('/');
    let name = parts.next().filter(|s| !s.is_empty())?;
    let owner = parts.next().filter(|s| !s.is_empty())?;
    Some(format!("{owner}/{name}").to_ascii_lowercase())
}

/// A twin a CLI loads (its `SKILL.md` has a description).
fn loads(half: &Option<(PathBuf, DirFacts)>) -> Option<&(PathBuf, DirFacts)> {
    half.as_ref().filter(|(_, f)| f.description.is_some())
}

/// One workspace's rows. A folder that isn't there keeps its last rows,
/// marked `missing`.
pub fn read_workspace(
    input: &WorkspaceInput,
    previous: Option<&IndexWorkspace>,
    cache: &DirCache,
    judge: &dyn LinkJudge,
    now: i64,
) -> IndexWorkspace {
    let mut out = IndexWorkspace {
        id: input.id.clone(),
        name: input.name.clone(),
        path: crate::platform::display_path(&input.cwd),
        state: "ok".into(),
        source: "checkout".into(),
        repo: None,
        branch: None,
        read_at: Some(now),
        rows: Vec::new(),
    };
    if !input.cwd.is_dir() {
        // R4 edge: "Folder not found", its last rows kept, nothing deleted.
        out.state = "missing".into();
        if let Some(previous) = previous {
            out.rows = previous.rows.clone();
            out.repo = previous.repo.clone();
            out.source = previous.source.clone();
            out.branch = previous.branch.clone();
            out.read_at = previous.read_at;
        }
        return out;
    }
    out.repo = origin_repo(&input.cwd);
    // A shared workspace is read as its Library reads it: the checkout's
    // skills and links (a linked copy lives in the checkout, whatever the
    // branch holds), and the skills only its last mirror of the branch has
    // (never fetched here). With no mirror on this Mac yet, the checkout
    // alone, and the rows say so.
    let paths = crate::shared_library_sync::Paths { workspace_dir: input.workspace_dir.clone(), cwd: input.cwd.clone() };
    let build = crate::shared_library_sync::mirror_build(&paths);
    let mirror = build.join(ply_memory::SHARED_LIBRARY_MANIFEST).is_file().then_some(build);
    if let Some(mirror) = &mirror {
        out.source = "branch".into();
        out.branch = std::fs::read(mirror.join(ply_memory::SHARED_LIBRARY_MANIFEST))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|manifest| manifest.get("branch").and_then(|b| b.as_str()).map(str::to_string))
            .filter(|branch| !branch.is_empty());
    } else if input.cwd.join(".atelier").join("workspace.json").is_file() {
        out.source = "checkoutShared".into();
    }
    // A checkout is stored the way its autocrlf and attributes say; the
    // mirror holds git's stored blobs as they are.
    let checkout_eol = eol_for(&input.cwd);
    let mirror_eol: Eol = Normalise::None.into();

    // name → (claude dir, codex dir, legacy codex dir), and whether the
    // checkout has it (else only the branch's mirror does).
    let mut by_name: BTreeMap<String, ([Option<PathBuf>; 3], bool)> = BTreeMap::new();
    for (slot, root) in ROOTS.iter().enumerate() {
        for (name, dir) in skill_dirs(&input.cwd, root) {
            let entry = by_name.entry(name).or_default();
            entry.0[slot] = Some(dir);
            entry.1 = true;
        }
    }
    if let Some(mirror) = &mirror {
        // The branch's two roots, as the Library reads a mirror
        // (`skill_reach::branch_reach`): the legacy Codex root is a checkout's.
        for (slot, root) in ROOTS.iter().enumerate().take(2) {
            for (name, dir) in skill_dirs(mirror, root) {
                let entry = by_name.entry(name).or_default();
                if !entry.1 {
                    entry.0[slot] = Some(dir);
                }
            }
        }
    }
    let (links, local) = judge.links(input);
    for (count, (name, ([claude_dir, codex_dir, legacy_dir], in_checkout))) in by_name.into_iter().enumerate() {
        let hash_it = count < MAX_SKILLS;
        let eol = if in_checkout { &checkout_eol } else { &mirror_eol };
        let side = |dir: &Option<PathBuf>, side| dir.as_ref().map(|d| (d.clone(), cache.facts(d, eol, Some(side), hash_it)));
        let claude = side(&claude_dir, crate::skill_reach::Side::Claude);
        let legacy = codex_dir.is_none() && legacy_dir.is_some();
        let codex = side(if legacy { &legacy_dir } else { &codex_dir }, crate::skill_reach::Side::Codex);
        let (claude, codex) = (loads(&claude), loads(&codex));
        let Some((dir, first)) = claude.or(codex) else { continue };
        let mut row = IndexRow {
            name: name.clone(),
            description: first.description.clone().unwrap_or_default(),
            codex_name: codex.and_then(|(_, f)| f.codex_name.clone()),
            claude: claude.is_some(),
            codex: codex.is_some(),
            claude_id: claude.and_then(|(_, f)| f.id.clone()),
            codex_id: codex.and_then(|(_, f)| f.id.clone()),
            legacy_codex: codex.is_some() && legacy,
            dir: crate::platform::display_path(dir),
            branch_only: !in_checkout,
            changed_at: [claude, codex].iter().flatten().filter_map(|(_, f)| f.changed_at).max(),
            too_many_files: [claude, codex].iter().flatten().any(|(_, f)| f.too_many),
            ..Default::default()
        };
        if let (Some((_, c)), Some((_, x))) = (claude, codex) {
            row.twins_differ = match (&c.compare_id, &x.compare_id) {
                (Some(a), Some(b)) => a != b,
                _ => false,
            };
        }
        // A link is the checkout's record of the checkout's copy.
        if let Some(link) = links.get(&name).filter(|_| in_checkout) {
            let here = TwinIds { claude: row.claude_id.clone(), codex: row.codex_id.clone(), extra: Default::default() };
            let quick = quick_up_to_date(link, &here, judge.upstream_ids(&link.origin));
            let state = if quick { LinkState::UpToDate } else { judge.full_state(&input.cwd, &name, link) };
            row.link = Some(IndexLink {
                origin_kind: link.origin.kind.clone(),
                origin_words: judge.origin_words(&link.origin),
                source: link.origin.source.clone(),
                plugin: link.origin.plugin.clone(),
                name: link.origin.name.clone(),
                state: Some(state),
                local: local.contains(&name),
                origin_workspace: judge.origin_workspace(&link.origin),
            });
        }
        out.rows.push(row);
    }
    out
}

// ── The other sources ────────────────────────────────────────────────

/// The team library's ids at `HEAD`, by repository path, from one
/// `git ls-tree` of `library/` (every tree under it).
pub fn parse_ls_tree(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|line| {
            let (meta, path) = line.split_once('\t')?;
            let mut parts = meta.split_whitespace();
            let (_mode, kind, id) = (parts.next()?, parts.next()?, parts.next()?);
            (kind == "tree").then(|| (path.to_string(), id.to_string()))
        })
        .collect()
}

/// The team library's rows, from its clone. `ids`: the library's tree ids
/// at `HEAD` (in-process ids of the clone's files when git couldn't say).
pub fn read_team(
    slug: &str,
    clone: &Path,
    ids: Option<&HashMap<String, String>>,
    needs_ok: &BTreeSet<(String, String)>,
    cache: &DirCache,
    now: i64,
) -> IndexSource {
    let mut out = IndexSource { repo: Some(slug.to_string()), read_at: Some(now), ..Default::default() };
    let library = crate::team_skills::read_library(clone);
    let claude_of = |plugin: &str| library.claude_plugins.iter().find(|(name, _)| name == plugin).map(|(_, dir)| dir.clone());
    let codex_of = |plugin: &str| {
        library.codex.as_ref().and_then(|m| m.plugins.iter().find(|p| p.name == plugin)).map(|p| p.dir.clone())
    };
    for skill in &library.skills {
        let claude_dir = skill.claude.then(|| claude_of(&skill.plugin)).flatten().map(|d| d.join("skills").join(&skill.name));
        let codex_dir = skill.codex.then(|| codex_of(&skill.plugin)).flatten().map(|d| d.join("skills").join(&skill.name));
        let half = |dir: &Option<PathBuf>, side| {
            dir.as_ref().map(|d| {
                let mut facts = cache.facts(d, platform_normalise(), Some(side), true);
                if let Some(id) = crate::skill_card::repo_path_of(clone, d).and_then(|p| ids.and_then(|ids| ids.get(&p))) {
                    facts.id = Some(id.clone());
                }
                facts
            })
        };
        let claude = half(&claude_dir, crate::skill_reach::Side::Claude);
        let codex = half(&codex_dir, crate::skill_reach::Side::Codex);
        let Some(dir) = claude_dir.as_ref().or(codex_dir.as_ref()) else { continue };
        out.rows.push(IndexRow {
            name: skill.name.clone(),
            description: skill.description.clone(),
            codex_name: skill.codex_name.clone(),
            plugin: Some(skill.plugin.clone()),
            claude: skill.claude,
            codex: skill.codex,
            claude_id: claude.as_ref().and_then(|f| f.id.clone()),
            codex_id: codex.as_ref().and_then(|f| f.id.clone()),
            dir: crate::platform::display_path(dir),
            changed_at: [&claude, &codex].iter().filter_map(|f| f.as_ref().and_then(|f| f.changed_at)).max(),
            too_many_files: [&claude, &codex].iter().any(|f| f.as_ref().is_some_and(|f| f.too_many)),
            needs_ok: needs_ok.contains(&(skill.plugin.clone(), skill.name.clone())),
            ..Default::default()
        });
    }
    out
}

/// H10 Windows walk (§8): mark the library rows sessions on this computer
/// don't get because a path would be too long for Windows.
fn mark_too_long(source: &mut IndexSource, config_dir: &Path, clone: &Path) {
    let long = crate::library_snapshot::skills_too_long_here(config_dir, clone, crate::library_snapshot::Options::native());
    for row in &mut source.rows {
        row.too_long_here = long.contains(&row.name);
    }
}

/// This Mac's own skills (read only, ADR 0005).
pub fn read_this_mac(home: &Path, cache: &DirCache, now: i64) -> IndexSource {
    let mut out = IndexSource { read_at: Some(now), ..Default::default() };
    let personal = crate::personal_skills::read_personal_skills(home);
    let normalise = platform_normalise();
    for skill in personal.skills {
        let first = |roots: &[&str], side| {
            roots.iter().map(|root| root.split('/').fold(home.to_path_buf(), |at, p| at.join(p)).join(&skill.name)).find(|d| d.is_dir()).map(|d| cache.facts(&d, normalise, Some(side), true))
        };
        let claude = skill.claude.then(|| first(&[".claude/skills"], crate::skill_reach::Side::Claude)).flatten();
        let codex = skill.codex.then(|| first(&[".agents/skills", ".codex/skills"], crate::skill_reach::Side::Codex)).flatten();
        out.rows.push(IndexRow {
            name: skill.name.clone(),
            description: skill.description.clone(),
            codex_name: skill.codex_name.clone(),
            claude: skill.claude,
            codex: skill.codex,
            claude_id: claude.as_ref().and_then(|f| f.id.clone()),
            codex_id: codex.as_ref().and_then(|f| f.id.clone()),
            dir: crate::platform::without_verbatim(&skill.dir).into_owned(),
            changed_at: [&claude, &codex].iter().filter_map(|f| f.as_ref().and_then(|f| f.changed_at)).max(),
            too_many_files: [&claude, &codex].iter().any(|f| f.as_ref().is_some_and(|f| f.too_many)),
            ..Default::default()
        });
    }
    out
}

/// The skills that come with Plyloft.
pub fn read_plyloft(bundle: Option<&Path>, off: &[String], cache: &DirCache, now: i64) -> IndexSource {
    let mut out = IndexSource { read_at: Some(now), ..Default::default() };
    let Some(bundle) = bundle else {
        out.problem = Some("This build has no copy of Plyloft's skills.".into());
        return out;
    };
    // G2: an alias has no row; its skill's row switches both names.
    for skill in crate::ply_skills::rows(crate::ply_skills::read_bundle(bundle)) {
        let dir = bundle.join(&skill.name);
        let facts = cache.facts(&dir, platform_normalise(), None, true);
        out.rows.push(IndexRow {
            name: skill.name.clone(),
            description: skill.description.clone(),
            claude: true,
            codex: true,
            claude_id: facts.id.clone(),
            codex_id: facts.id.clone(),
            dir: crate::platform::display_path(&dir),
            changed_at: facts.changed_at,
            off_here: crate::ply_skills::is_off(&skill.name, off),
            ..Default::default()
        });
    }
    out
}

/// `index` with `fresh` in place of the workspace it re-read, in the order
/// of `order` (the workspace list); workspaces no longer listed are dropped.
pub fn merge_workspaces(index: &mut HubIndex, fresh: Vec<IndexWorkspace>, order: &[String]) {
    let mut by_id: HashMap<String, IndexWorkspace> = index.workspaces.drain(..).map(|w| (w.id.clone(), w)).collect();
    for workspace in fresh {
        by_id.insert(workspace.id.clone(), workspace);
    }
    index.workspaces = order.iter().filter_map(|id| by_id.remove(id)).collect();
}

/// Read `inputs` on at most [`THREADS`] workers, a workspace at a time;
/// `each` gets every workspace as it is done (the stream). Stops between
/// workspaces when `stop` is set.
pub fn read_workspaces(
    inputs: &[WorkspaceInput],
    previous: &HubIndex,
    cache: &DirCache,
    judge: &dyn LinkJudge,
    now: i64,
    stop: &AtomicBool,
    each: &(dyn Fn(&IndexWorkspace) + Sync),
) -> Vec<IndexWorkspace> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let done = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..THREADS.min(inputs.len().max(1)) {
            scope.spawn(|| loop {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let i = next.fetch_add(1, Ordering::SeqCst);
                let Some(input) = inputs.get(i) else { break };
                let before = previous.workspaces.iter().find(|w| w.id == input.id);
                let read = read_workspace(input, before, cache, judge, now);
                each(&read);
                done.lock().unwrap_or_else(|p| p.into_inner()).push(read);
                std::thread::yield_now();
            });
        }
    });
    done.into_inner().unwrap_or_else(|p| p.into_inner())
}

// ── In the app ───────────────────────────────────────────────────────

static STOP: AtomicBool = AtomicBool::new(false);
/// The index in memory (read from disk on the first ask).
static LOADED: Mutex<Option<IndexFile>> = Mutex::new(None);
/// Whether a refresh runs, and the one asked for meanwhile (merged).
static RUN: Mutex<RunState> = Mutex::new(RunState { running: false, again: None });
/// Workspaces being read now, for the rows' quiet *Reading…*.
static READING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

struct RunState {
    running: bool,
    again: Option<Ask>,
}

/// What a refresh reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Ask {
    /// `None`: every workspace (a whole refresh, the libraries too).
    pub workspaces: Option<BTreeSet<String>>,
    /// The team library, this Mac's folders and Plyloft's (an OK given to a
    /// team skill's scripts changes only the team rows).
    pub libraries: bool,
}

impl Ask {
    pub(crate) fn whole() -> Self {
        Ask { workspaces: None, libraries: true }
    }

    fn is_whole(&self) -> bool {
        self.workspaces.is_none()
    }
}

/// Two asks as one: a whole refresh takes in any other.
pub(crate) fn merge_asks(a: Option<Ask>, b: Ask) -> Ask {
    let Some(a) = a else { return b };
    let workspaces = match (a.workspaces, b.workspaces) {
        (None, _) | (_, None) => None,
        (Some(mut a), Some(b)) => {
            a.extend(b);
            Some(a)
        }
    };
    let libraries = workspaces.is_none() || a.libraries || b.libraries;
    Ask { workspaces, libraries }
}

fn running() -> bool {
    RUN.lock().unwrap_or_else(|p| p.into_inner()).running
}

/// Hard rule 4: no new refresh, and the one running stops between
/// workspaces.
pub(crate) fn stop() {
    STOP.store(true, Ordering::SeqCst);
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// What the page gets at once.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexView {
    pub index: HubIndex,
    pub refreshing: bool,
    /// Workspaces being read now.
    pub reading: Vec<String>,
}

/// One message of the stream.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum IndexEvent {
    Started { workspace_ids: Vec<String>, whole: bool },
    Workspace { workspace: IndexWorkspace },
    Team { source: Option<IndexSource> },
    MyLibrary { source: Option<IndexSource> },
    ThisMac { source: IndexSource },
    Plyloft { source: IndexSource },
    Done { built_at: Option<i64>, workspace_ids: Vec<String> },
}

fn with_loaded<T>(config_dir: &Path, f: impl FnOnce(&mut IndexFile) -> T) -> T {
    let mut loaded = LOADED.lock().unwrap_or_else(|p| p.into_inner());
    if loaded.is_none() {
        *loaded = Some(load_file(config_dir));
    }
    f(loaded.as_mut().expect("loaded"))
}

fn view(config_dir: &Path) -> IndexView {
    IndexView {
        index: with_loaded(config_dir, |file| file.index.clone()),
        refreshing: running(),
        reading: READING.lock().unwrap_or_else(|p| p.into_inner()).iter().cloned().collect(),
    }
}

/// The app's [`LinkJudge`]: the current team library's ids, and the
/// Library's own judgement.
struct AppJudge<'a, R: tauri::Runtime> {
    app: &'a tauri::AppHandle<R>,
    team: Option<String>,
    ids: Option<HashMap<String, String>>,
}

impl<R: tauri::Runtime> LinkJudge for AppJudge<'_, R> {
    fn upstream_ids(&self, origin: &LinkOrigin) -> Option<&HashMap<String, String>> {
        let team = self.team.as_deref()?;
        (origin.kind == crate::skill_links::KIND_TEAM && origin.source.eq_ignore_ascii_case(team)).then_some(())?;
        self.ids.as_ref()
    }

    fn full_state(&self, cwd: &Path, skill: &str, link: &SkillLink) -> LinkState {
        let here = crate::skill_card::checkout_twin_ids(cwd, skill);
        let (_, effective, upstream) = crate::commands::skills_hub_decisions::link_upstream(self.app, link, &here, (cwd, skill));
        crate::skill_links::link_state(&effective, &here, &upstream)
    }

    fn links(&self, input: &WorkspaceInput) -> (BTreeMap<String, SkillLink>, BTreeSet<String>) {
        let read = crate::commands::skills_hub_copy::app_links_here(self.app, &input.id, &input.cwd);
        (read.links, read.local)
    }

    fn origin_words(&self, origin: &LinkOrigin) -> String {
        crate::commands::skills_hub_copy::origin_words_here(self.app, origin)
    }

    fn origin_workspace(&self, origin: &LinkOrigin) -> Option<String> {
        if origin.kind != crate::skill_copy::KIND_WORKSPACE {
            return None;
        }
        crate::commands::skills_hub_copy::workspace_origin(self.app, origin).map(|(id, _, _)| id)
    }
}

/// Start a refresh of what `ask` names. One runs at a time; one asked for
/// meanwhile runs after it (merged).
pub(crate) fn refresh<R: tauri::Runtime>(app: &tauri::AppHandle<R>, only: Ask) {
    if STOP.load(Ordering::SeqCst) {
        return;
    }
    {
        let mut run = RUN.lock().unwrap_or_else(|p| p.into_inner());
        if run.running {
            let again = run.again.take();
            run.again = Some(merge_asks(again, only));
            return;
        }
        run.running = true;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("skills-index".into()).spawn(move || {
        let mut only = only;
        loop {
            if let Err(error) = run_refresh(&app, only) {
                log::warn!("skills index: refresh failed ({error})");
            }
            let mut run = RUN.lock().unwrap_or_else(|p| p.into_inner());
            match run.again.take() {
                Some(next) if !STOP.load(Ordering::SeqCst) => only = next,
                _ => {
                    run.running = false;
                    break;
                }
            }
        }
    });
    if let Err(error) = spawned {
        RUN.lock().unwrap_or_else(|p| p.into_inner()).running = false;
        log::warn!("skills index: couldn't start a refresh ({error})");
    }
}

fn emit<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: &IndexEvent) {
    use tauri::Emitter;
    let _ = app.emit(INDEX_EVENT, event);
}

fn run_refresh<R: tauri::Runtime>(app: &tauri::AppHandle<R>, ask: Ask) -> Result<(), String> {
    use tauri::Manager;
    let started = std::time::Instant::now();
    let config_dir = crate::skills_hub::config_dir(app)?;
    let whole = ask.is_whole();
    let libraries = whole || ask.libraries;
    let only = ask.workspaces;
    let listed = app.state::<crate::workspace::WorkspaceStore>().snapshot().workspaces;
    let order: Vec<String> = listed.iter().map(|w| w.id.clone()).collect();
    let projects = app.state::<crate::project_config::ProjectConfigStore>();
    let inputs: Vec<WorkspaceInput> = listed
        .iter()
        .filter(|w| only.as_ref().map_or(true, |only| only.contains(&w.id)))
        .map(|w| WorkspaceInput {
            id: w.id.clone(),
            name: w.name.clone(),
            cwd: PathBuf::from(&w.cwd),
            workspace_dir: projects.workspace_dir(&w.id),
        })
        .collect();
    let ids: Vec<String> = inputs.iter().map(|i| i.id.clone()).collect();
    READING.lock().unwrap_or_else(|p| p.into_inner()).extend(ids.iter().cloned());
    emit(app, &IndexEvent::Started { workspace_ids: ids.clone(), whole });

    let (previous, known) = with_loaded(&config_dir, |file| (file.index.clone(), file.dirs.clone()));
    let cache = DirCache::new(known);
    let now = now_ms();
    let mut reread: Vec<PathBuf> = inputs.iter().filter(|i| i.cwd.is_dir()).map(|i| i.cwd.clone()).collect();
    reread.extend(inputs.iter().map(|i| crate::shared_library_sync::mirror_build(&crate::shared_library_sync::Paths { workspace_dir: i.workspace_dir.clone(), cwd: i.cwd.clone() })));

    // The team library: its ids at HEAD (one git), its rows on a whole refresh.
    let team = crate::commands::current_team_repo(app);
    let clone = team.as_deref().map(|slug| app.state::<crate::team::TeamStore>().clone_dir(slug));
    let delivers = team.as_deref().is_some_and(|slug| crate::skills_hub::delivers(&config_dir, slug));
    let readable = clone.as_deref().filter(|c| delivers && c.join(".git").exists());
    let team_ids = readable.and_then(|clone| {
        crate::library_snapshot::git(clone, &["ls-tree", "-r", "-d", "HEAD", "--", "library"])
            .ok()
            .map(|out| parse_ls_tree(&String::from_utf8_lossy(&out)))
    });
    if libraries {
        let team_source = match (team.as_deref(), readable) {
            (Some(slug), Some(clone)) => {
                let state = crate::skills_hub_state::load(&config_dir);
                let held: BTreeSet<(String, String)> = crate::skill_scripts::needs_ok(clone, &state)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|item| (item.plugin, item.skill))
                    .collect();
                reread.push(clone.to_path_buf());
                let mut source = read_team(slug, clone, team_ids.as_ref(), &held, &cache, now);
                mark_too_long(&mut source, &config_dir, clone);
                Some(source)
            }
            (Some(slug), None) => Some(IndexSource {
                repo: Some(slug.to_string()),
                read_at: Some(now),
                problem: Some(if delivers {
                    format!("The team library isn't on {} yet.", crate::platform::THIS_MACHINE)
                } else {
                    format!("The team library is switched off on {}.", crate::platform::THIS_MACHINE)
                }),
                ..Default::default()
            }),
            (None, _) => None,
        };
        emit(app, &IndexEvent::Team { source: team_source.clone() });
        // Skills hub H10: My library's rows, from its clone, read as the
        // team library is (its layout), with its own script holds.
        let mine_source = crate::my_library::setting(app).map(|mine| {
            let clone = crate::my_library::clone_dir(&config_dir, &mine.repo);
            if !clone.join(".git").exists() {
                return IndexSource {
                    repo: Some(mine.repo.clone()),
                    read_at: Some(now),
                    problem: Some(format!("My library isn't on {} yet.", crate::platform::THIS_MACHINE)),
                    ..Default::default()
                };
            }
            let ids = crate::library_snapshot::git(&clone, &["ls-tree", "-r", "-d", "HEAD", "--", "library"])
                .ok()
                .map(|out| parse_ls_tree(&String::from_utf8_lossy(&out)));
            let state = crate::skills_hub_state::load(&config_dir);
            let held: BTreeSet<(String, String)> = crate::skill_scripts::needs_ok(&clone, &state)
                .unwrap_or_default()
                .into_iter()
                .map(|item| (item.plugin, item.skill))
                .collect();
            reread.push(clone.clone());
            let mut source = read_team(&mine.repo, &clone, ids.as_ref(), &held, &cache, now);
            mark_too_long(&mut source, &config_dir, &clone);
            source
        });
        emit(app, &IndexEvent::MyLibrary { source: mine_source.clone() });
        let home = crate::personal_skills::home_dir();
        let mac = read_this_mac(&home, &cache, now);
        emit(app, &IndexEvent::ThisMac { source: mac.clone() });
        let off = app.state::<crate::settings::SettingsStore>().snapshot().library.ply_skills_off;
        let bundle = crate::ply_skills::bundle_dir(app);
        let ply = read_plyloft(bundle.as_deref(), &off, &cache, now);
        emit(app, &IndexEvent::Plyloft { source: ply.clone() });
        with_loaded(&config_dir, |file| {
            file.index.team = team_source.clone();
            file.index.my_library = mine_source.clone();
            file.index.this_mac = Some(mac);
            file.index.plyloft = Some(ply);
        });
    }

    let judge = AppJudge { app, team: team.clone(), ids: team_ids };
    let each = |workspace: &IndexWorkspace| {
        READING.lock().unwrap_or_else(|p| p.into_inner()).remove(&workspace.id);
        // The copy a page opening now is given follows the stream, so it is
        // never older than what was already painted.
        with_loaded(&config_dir, |file| merge_workspaces(&mut file.index, vec![workspace.clone()], &order));
        emit(app, &IndexEvent::Workspace { workspace: workspace.clone() });
    };
    let fresh = read_workspaces(&inputs, &previous, &cache, &judge, now, &STOP, &each);
    READING.lock().unwrap_or_else(|p| p.into_inner()).retain(|id| !ids.contains(id));
    let built_at = whole.then_some(now);
    let saved = with_loaded(&config_dir, |file| {
        merge_workspaces(&mut file.index, fresh, &order);
        if whole {
            file.index.built_at = built_at;
        }
        file.dirs = if whole {
            // A workspace whose folder isn't there keeps its facts.
            let away: Vec<PathBuf> = inputs.iter().filter(|i| !i.cwd.is_dir()).map(|i| i.cwd.clone()).collect();
            cache.into_kept_whole(&away)
        } else {
            cache.into_kept(&reread)
        };
        file.schema_version = SCHEMA_VERSION;
        file.clone()
    });
    if let Err(error) = save_file(&config_dir, &saved) {
        log::warn!("skills index: couldn't save the cache ({error})");
    }
    log::info!(
        "skills index: read {} workspace(s){} in {} ms",
        ids.len(),
        if libraries { " and the libraries" } else { "" },
        started.elapsed().as_millis()
    );
    emit(app, &IndexEvent::Done { built_at: saved.index.built_at, workspace_ids: ids });
    Ok(())
}

/// The cached index at once; with `refresh`, a refresh starts behind it
/// (`skills-hub://index`).
#[tauri::command]
pub async fn skills_hub_index<R: tauri::Runtime>(app: tauri::AppHandle<R>, refresh: Option<bool>) -> Result<IndexView, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<IndexView, String> {
        use tauri::Manager;
        let config_dir = crate::skills_hub::config_dir(&app)?;
        let mut out = view(&config_dir);
        // The cache may be older than the workspace list: a workspace removed
        // since is not offered (its Open would land nowhere), and a renamed
        // one shows its name now.
        let listed = app.state::<crate::workspace::WorkspaceStore>().snapshot().workspaces;
        list_as_now(&mut out.index, &listed.iter().map(|w| (w.id.clone(), w.name.clone())).collect::<Vec<_>>());
        if refresh.unwrap_or(false) {
            self::refresh(&app, Ask::whole());
        }
        Ok(IndexView { refreshing: out.refreshing || refresh.unwrap_or(false), ..out })
    })
    .await
    .map_err(|error| format!("join skills index: {error}"))?
}

/// Read the workspaces named again (a skill root changed under one), or
/// everything (`None`); with `libraries`, the team library, this Mac's and
/// Plyloft's too (an OK given to a team skill's scripts).
#[tauri::command]
pub async fn skills_hub_index_refresh<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_ids: Option<Vec<String>>,
    libraries: Option<bool>,
) -> Result<(), String> {
    let ask = match workspace_ids {
        None => Ask::whole(),
        Some(ids) => Ask { workspaces: Some(ids.into_iter().collect()), libraries: libraries.unwrap_or(false) },
    };
    refresh(&app, ask);
    Ok(())
}

/// `index`'s workspaces as the list has them now: one no longer listed
/// left out, each one's name as it is now.
pub(crate) fn list_as_now(index: &mut HubIndex, listed: &[(String, String)]) {
    index.workspaces.retain_mut(|workspace| match listed.iter().find(|(id, _)| *id == workspace.id) {
        Some((_, name)) => {
            workspace.name = name.clone();
            true
        }
        None => false,
    });
}

#[cfg(test)]
#[path = "skills_index_tests.rs"]
mod tests;
