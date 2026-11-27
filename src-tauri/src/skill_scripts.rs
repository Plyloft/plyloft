//! Skills hub H6a (`docs/plans/SKILLS_HUB.md` R15, §12 H6 — the library
//! half): a library skill that brings anything other than text to this Mac
//! waits for the member's **OK** before a session is given it.
//!
//! - **Which files ask.** [`classify`] sorts every file of a skill into
//!   *text*, *script* or *extra file* by R15's rules. 1.175.0 B1 (SEC-1): a
//!   `SKILL.md` whose text asks to run things — `allowed-tools` with a command
//!   or writing tool, `hooks`, a command run when the skill loads
//!   ([`crate::skill_asks`]) — is a fourth kind, *text that asks*. A skill
//!   whose files are all plain text never asks.
//! - **The approval key.** `(origin, skill, scripts id)`: the *scripts id* is a
//!   digest over the path, mode and git blob id (the blob id already is a hash
//!   of the bytes) of every file that asks, so a changed script makes a new
//!   one ([`scripts_id`]) — and so does any change to a `SKILL.md` that asks:
//!   its OK is for that exact text. Editing a `SKILL.md` that asks for
//!   nothing keeps the key, as before.
//! - **Held back, not taken away.** A skill whose current scripts id has no OK
//!   on this Mac is *held*: new sessions keep its **previously approved
//!   version** — the newest earlier version that was approved, or that was all
//!   text — built from that commit's objects by
//!   [`crate::library_snapshot`]. A skill with no such version (it brought a
//!   script from its first commit) is left out until OK. Other skills update
//!   normally.
//! - **Hooks and MCP servers** stay refused per plugin by
//!   [`crate::team_skills`]; nothing here can lift that.
//!
//! Everything is read from git objects of one commit — never the clone's
//! working tree — and cached by commit (a commit's answer never changes) and
//! by blob id, so an unchanged library costs a launch nothing here.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, OnceLock};

use serde::Serialize;

use crate::library_snapshot::{self, Half, TreeFile};
use crate::skills_hub_state::HubState;

/// R15's text files: shown, never asked about.
const TEXT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "json", "yaml", "yml", "toml", "csv", "xml", "html",
];

/// R15's scripts by extension, whatever their content.
const SCRIPT_EXTENSIONS: &[&str] = &[
    "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "py", "js", "mjs", "cjs", "ts", "rb",
    "pl", "php", "lua", "swift", "go", "applescript", "scpt", "jar", "exe", "dll", "so", "dylib",
    "app",
];

/// A binary file with one of these is an *extra file*, not a script.
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "heic", "avif", "svg",
];

/// A file past this is not read to be classified: it counts as binary.
pub(crate) const CONTENT_READ_MAX: u64 = 8 * 1024 * 1024;

/// R15's size rule for the sheet: a file over 1 MB, or any file of a skill
/// over 5 MB, is shown without its content (§14 Q18).
pub(crate) const SHOW_FILE_MAX: u64 = 1024 * 1024;
pub(crate) const SHOW_SKILL_MAX: u64 = 5 * 1024 * 1024;

/// How far back the previously approved version is looked for.
const HISTORY_DEPTH: &str = "50";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FileKind {
    Script,
    Extra,
    /// 1.175.0 B1: a skill's own text (`SKILL.md`) that asks to run commands,
    /// change files or run a command when it loads. Asked about like a
    /// script, by its exact bytes.
    Asks,
    Text,
}

/// What a file's bytes say, as far as R15 cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ContentFacts {
    pub shebang: bool,
    pub utf8: bool,
    /// 1.175.0 B1: read as a skill's text, it asks for something
    /// ([`crate::skill_asks::analyse`]). Only [`is_skill_text`] files count.
    pub asks: bool,
}

impl ContentFacts {
    pub(crate) fn of(bytes: &[u8]) -> Self {
        Self {
            shebang: bytes.starts_with(b"#!"),
            utf8: std::str::from_utf8(bytes).is_ok(),
            asks: crate::skill_asks::analyse(bytes).any(),
        }
    }
}

/// The file of a skill both CLIs read as the skill itself: `SKILL.md` at the
/// skill directory's root (`path` is relative to it), in any case — a
/// case-insensitive disk opens `skill.md` as the same file.
///
/// Round 2 (G1.3): a `SKILL.md` deeper inside the skill's folder counts
/// too. Whether a CLI loads a nested one can't be told from here, so it is
/// asked about with its skill.
pub(crate) fn is_skill_text(path: &str) -> bool {
    path.rsplit('/').next().unwrap_or(path).eq_ignore_ascii_case("SKILL.md")
}

fn extension(path: &str) -> Option<String> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let (stem, ext) = name.rsplit_once('.')?;
    (!stem.is_empty()).then(|| ext.to_ascii_lowercase())
}

/// R15's definitions, in order. `content` is `None` when the bytes were not
/// read (too large); the file is then binary.
pub(crate) fn classify(path: &str, executable: bool, content: Option<ContentFacts>) -> FileKind {
    if executable {
        return FileKind::Script;
    }
    let ext = extension(path);
    let has = |list: &[&str]| ext.as_deref().is_some_and(|ext| list.contains(&ext));
    // A file inside an `.app` bundle is part of a program.
    let in_app = path
        .split('/')
        .rev()
        .skip(1)
        .any(|part| part.to_ascii_lowercase().ends_with(".app"));
    if has(SCRIPT_EXTENSIONS) || in_app {
        return FileKind::Script;
    }
    let facts = content.unwrap_or(ContentFacts {
        shebang: false,
        utf8: false,
        asks: false,
    });
    if facts.shebang {
        return FileKind::Script;
    }
    if facts.utf8 {
        // 1.175.0 B1: before the extension — a `SKILL.md` that asks is asked
        // about, whatever else it is.
        if facts.asks && is_skill_text(path) {
            return FileKind::Asks;
        }
        return if has(TEXT_EXTENSIONS) { FileKind::Text } else { FileKind::Extra };
    }
    if has(IMAGE_EXTENSIONS) {
        FileKind::Extra
    } else {
        FileKind::Script
    }
}

/// Whether [`classify`] needs the file's bytes to decide.
fn needs_content(path: &str, executable: bool) -> bool {
    !executable
        && classify(path, executable, Some(ContentFacts { shebang: false, utf8: true, asks: false })) != FileKind::Script
}

/// One file of a skill at a commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SkillFile {
    /// Relative to the skill's directory.
    pub path: String,
    pub blob: String,
    pub size: u64,
    pub executable: bool,
    pub kind: FileKind,
}

/// The approval key's third part: a digest over the path, mode and blob id
/// of every file that asks — scripts, extra files, and a `SKILL.md` whose
/// text asks (1.175.0 B1) — or `None` for a skill of plain text.
pub(crate) fn scripts_id(files: &[SkillFile]) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut asked: Vec<&SkillFile> = files.iter().filter(|f| f.kind != FileKind::Text).collect();
    if asked.is_empty() {
        return None;
    }
    asked.sort_by(|a, b| a.path.cmp(&b.path));
    let mut hash = Sha256::new();
    for file in asked {
        let mode = if file.executable { "100755" } else { "100644" };
        hash.update(format!("{}\0{mode}\0{}\n", file.path, file.blob).as_bytes());
    }
    Some(format!("{:x}", hash.finalize()))
}

/// One skill of a library half at a commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LibrarySkill {
    /// The plugin's directory *name*: the `<plugin>` of
    /// `library/claude/<plugin>` or `library/codex/plugins/<plugin>`.
    pub plugin: String,
    pub skill: String,
    /// The skill directory's path in the repository.
    pub prefix: String,
    pub files: Vec<SkillFile>,
    pub scripts_id: Option<String>,
    /// It carries a symbolic link: its whole plugin is refused when a
    /// snapshot is built, so it is never held (holding it would take the link
    /// out of the snapshot and with it the refusal).
    pub has_link: bool,
}

/// Where a half's plugins are in the repository.
pub(crate) fn half_root(half: Half) -> &'static str {
    match half {
        Half::Claude => "library/claude/",
        Half::Codex => "library/codex/plugins/",
    }
}

/// `team:<owner>/<repo>` — the library a clone holds, from its directory name
/// (`team::slug_dir_name` spells `owner/repo` as `owner__repo`). Skills hub
/// H10: a clone under `<config>/my-library/` is **My library**,
/// `library:<owner>/<repo>` — its own approvals and Inbox rows, never the
/// team's.
pub(crate) fn library_id(clone: &Path) -> String {
    let name = clone
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let kind = if crate::my_library::is_clone(clone) { "library" } else { "team" };
    format!("{kind}:{}", name.replacen("__", "/", 1))
}

/// H10: how the sheet and the Inbox name the library a clone holds.
pub(crate) fn place_words(clone: &Path) -> &'static str {
    if crate::my_library::is_clone(clone) {
        "My library"
    } else {
        "the team library"
    }
}

/// The approval key's first part.
pub(crate) fn origin(clone: &Path, plugin: &str) -> String {
    format!("{}/{plugin}", library_id(clone))
}

// ── Outside the skills ───────────────────────────────────────────────

/// How many entries of a plugin outside its skills are looked at before the
/// plugin counts as carrying something unknown.
const OUTSIDE_SKILLS_MAX_ENTRIES: usize = 2_000;

/// (Challenger) The first script a plugin carries **outside its skills'
/// own directories** (`skills/<name>/…`), relative to `plugin_dir`, if any.
///
/// The OK is asked per skill, so only a skill's own files can be held back.
/// A script anywhere else in the plugin — `scripts/check.sh` beside
/// `skills/`, which a text-only `SKILL.md` can tell an agent to run through
/// `${CLAUDE_PLUGIN_ROOT}` — would reach every session with nothing asked,
/// and change with nothing asked. Such a plugin is refused, as hooks are
/// ([`crate::team_skills`]), and its row in Settings › Team says why.
///
/// Read from the directory a reader is given: a clone (what Settings and
/// the Library show) or a snapshot (what a session gets, laid down from git
/// with each file's executable bit). On Windows the bit is not on disk, so a
/// file is a script there by its extension, its `#!` or being binary.
pub(crate) fn script_outside_skills(plugin_dir: &Path) -> Option<String> {
    let mut stack: Vec<(std::path::PathBuf, String)> = vec![(plugin_dir.to_path_buf(), String::new())];
    let mut seen = 0usize;
    while let Some((dir, rel)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > OUTSIDE_SKILLS_MAX_ENTRIES {
                return Some(format!("{rel}…"));
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.is_dir() {
                // A skill's own directory is held or delivered by its OK.
                if rel == "skills" {
                    continue;
                }
                stack.push((entry.path(), path));
                continue;
            }
            if !meta.is_file() {
                // A link: refused where the plugin's tree is read
                // (`library_snapshot::build`, `project_skills::read_tree`).
                continue;
            }
            #[cfg(unix)]
            let executable = {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o111 != 0
            };
            #[cfg(not(unix))]
            let executable = false;
            // Finder's and Explorer's own files, in a clone someone opened.
            if !executable && matches!(name.as_str(), ".DS_Store" | "Thumbs.db" | "desktop.ini") {
                continue;
            }
            let content = if needs_content(&path, executable) && meta.len() <= CONTENT_READ_MAX {
                std::fs::read(entry.path()).ok().map(|bytes| ContentFacts::of(&bytes))
            } else {
                None
            };
            if classify(&path, executable, content) == FileKind::Script {
                return Some(path);
            }
        }
    }
    None
}

/// 1.175.0 B1 (SEC-1), round 2 (G1.3): the first text a plugin carries
/// **outside its skills' own folders** (`skills/<name>/…`, spelled exactly
/// so) that asks to run things — `allowed-tools`, `hooks`, a command run
/// when it loads, a front-matter key not known to be harmless
/// ([`crate::skill_asks`]) — relative to `plugin_dir`, if any.
///
/// The OK is asked per skill, by its text's exact bytes. A text anywhere
/// else — a command, an agent, a `SKILL.md` directly under `skills/` (the
/// CLI loads it), a file at the plugin's root — reaches every session with
/// the plugin and nothing asked, as a script there would
/// ([`script_outside_skills`]): such a plugin is refused the same way. A
/// file that can't be read counts as asking.
pub(crate) fn asking_text_outside_skills(plugin_dir: &Path) -> Option<String> {
    let mut stack: Vec<(std::path::PathBuf, String)> = vec![(plugin_dir.to_path_buf(), String::new())];
    let mut seen = 0usize;
    while let Some((dir, rel)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            seen += 1;
            if seen > OUTSIDE_SKILLS_MAX_ENTRIES {
                return Some(format!("{rel}/…"));
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.is_dir() {
                // A skill's own folder is held or delivered by its OK.
                if rel == "skills" {
                    continue;
                }
                stack.push((entry.path(), path));
                continue;
            }
            let markdown = matches!(extension(&name).as_deref(), Some("md" | "markdown"));
            if !meta.is_file() || !markdown {
                continue;
            }
            let asks = if meta.len() > CONTENT_READ_MAX {
                true
            } else {
                std::fs::read(entry.path()).map_or(true, |bytes| crate::skill_asks::analyse(&bytes).any())
            };
            if asks {
                return Some(path);
            }
        }
    }
    None
}

/// Round 2 (G1.3): a folder at the plugin's root named like one the CLIs
/// read (`skills`, `commands`, `agents`, `hooks`) in another case. A disk
/// that doesn't tell case apart opens `Skills/` as `skills/`, and its texts
/// load; Plyloft's own reading (exact `skills/<name>/`) would never ask
/// about them. Its name, if there is one.
pub(crate) fn miscased_component(plugin_dir: &Path) -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir(plugin_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names.into_iter().find(|name| {
        ["skills", "commands", "agents", "hooks"].iter().any(|known| name.eq_ignore_ascii_case(known) && name != known)
    })
}

// ── Reading a commit ─────────────────────────────────────────────────

/// Blob id → its facts. A blob id names its bytes, so an answer is forever.
fn facts_cache() -> &'static parking_lot::Mutex<HashMap<String, ContentFacts>> {
    static CACHE: OnceLock<parking_lot::Mutex<HashMap<String, ContentFacts>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

struct Listed {
    path: String,
    blob: String,
    size: u64,
    executable: bool,
    link: bool,
}

/// `git ls-tree -r -l` of `path` at `commit`: blobs and links.
fn list(clone: &Path, commit: &str, path: &str) -> Result<Vec<Listed>, String> {
    let out = library_snapshot::git(clone, &["ls-tree", "-r", "-z", "-l", commit, "--", path])?;
    let mut entries = Vec::new();
    for record in out.split(|byte| *byte == 0).filter(|record| !record.is_empty()) {
        let record = String::from_utf8_lossy(record);
        let Some((meta, path)) = record.split_once('\t') else {
            continue;
        };
        let mut fields = meta.split_whitespace();
        let (mode, kind, id, size) = (fields.next(), fields.next(), fields.next(), fields.next());
        let (Some(mode), Some("blob"), Some(id)) = (mode, kind, id) else {
            // A submodule's commit carries no file.
            continue;
        };
        entries.push(Listed {
            path: path.to_string(),
            blob: id.to_string(),
            size: size.and_then(|size| size.parse().ok()).unwrap_or(0),
            executable: mode == "100755",
            link: mode == "120000",
        });
    }
    Ok(entries)
}

/// Classify `entries` (paths relative to whatever `relative` strips), reading
/// the bytes of the files whose kind depends on them, once per blob.
fn classify_listed(clone: &Path, entries: &[(String, &Listed)]) -> Result<Vec<SkillFile>, String> {
    let wanted: Vec<TreeFile> = {
        let cache = facts_cache().lock();
        let mut seen = std::collections::HashSet::new();
        entries
            .iter()
            .filter(|(path, entry)| {
                !entry.link
                    && needs_content(path, entry.executable)
                    && entry.size <= CONTENT_READ_MAX
                    && !cache.contains_key(&entry.blob)
                    && seen.insert(entry.blob.clone())
            })
            .map(|(path, entry)| TreeFile {
                path: path.clone(),
                id: entry.blob.clone(),
                size: entry.size,
                executable: entry.executable,
            })
            .collect()
    };
    if !wanted.is_empty() {
        let blobs = library_snapshot::cat_blobs(clone, &wanted)?;
        let mut cache = facts_cache().lock();
        if cache.len() > 50_000 {
            cache.clear();
        }
        for (file, bytes) in wanted.iter().zip(blobs.iter()) {
            cache.insert(file.id.clone(), ContentFacts::of(bytes));
        }
    }
    let cache = facts_cache().lock();
    Ok(entries
        .iter()
        .map(|(path, entry)| SkillFile {
            path: path.clone(),
            blob: entry.blob.clone(),
            size: entry.size,
            executable: entry.executable,
            // A link refuses its whole plugin (`library_snapshot::build`); if
            // it ever reached here it would be asked about, not trusted.
            kind: if entry.link {
                FileKind::Script
            } else {
                classify(path, entry.executable, cache.get(&entry.blob).copied())
            },
        })
        .collect())
}

/// Every skill of `half` at `commit`, classified. Cached per commit.
pub(crate) fn analyse(clone: &Path, commit: &str, half: Half) -> Result<Arc<Vec<LibrarySkill>>, String> {
    type Key = (std::path::PathBuf, String, &'static str);
    static CACHE: OnceLock<parking_lot::Mutex<HashMap<Key, Arc<Vec<LibrarySkill>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key = (clone.to_path_buf(), commit.to_string(), half_root(half));
    if let Some(found) = cache.lock().get(&key) {
        return Ok(Arc::clone(found));
    }
    let root = half_root(half);
    let listed = list(clone, commit, root)?;
    // (plugin, skill) → its files, relative to the skill directory.
    let mut grouped: BTreeMap<(String, String), Vec<(String, &Listed)>> = BTreeMap::new();
    for entry in &listed {
        let Some(rest) = entry.path.strip_prefix(root) else {
            continue;
        };
        let mut parts = rest.splitn(4, '/');
        let (Some(plugin), Some("skills"), Some(skill), Some(file)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if file.is_empty() {
            continue;
        }
        grouped
            .entry((plugin.to_string(), skill.to_string()))
            .or_default()
            .push((file.to_string(), entry));
    }
    // (Challenger) One `git cat-file` for every skill's unknown blobs, not
    // one per skill: 200 skills cost 2.4 s cold the other way, on the first
    // launch after a start.
    {
        let all: Vec<(String, &Listed)> = grouped.values().flatten().cloned().collect();
        classify_listed(clone, &all)?;
    }
    let mut skills = Vec::new();
    for ((plugin, skill), entries) in grouped {
        let files = classify_listed(clone, &entries)?;
        let has_link = entries.iter().any(|(_, entry)| entry.link);
        skills.push(LibrarySkill {
            has_link,
            prefix: format!("{root}{plugin}/skills/{skill}"),
            scripts_id: scripts_id(&files),
            plugin,
            skill,
            files,
        });
    }
    let skills = Arc::new(skills);
    let mut cache = cache.lock();
    if cache.len() > 32 {
        cache.clear();
    }
    cache.insert(key, Arc::clone(&skills));
    Ok(skills)
}

/// One skill directory at `commit`: its tree id and files, or `None` when the
/// commit has no such directory.
fn skill_at(clone: &Path, commit: &str, prefix: &str) -> Result<Option<(String, Vec<SkillFile>)>, String> {
    let Some(tree) = library_snapshot::entry_tree(clone, commit, prefix)? else {
        return Ok(None);
    };
    let listed = list(clone, commit, &format!("{prefix}/"))?;
    let base = format!("{prefix}/");
    let entries: Vec<(String, &Listed)> = listed
        .iter()
        .filter_map(|entry| entry.path.strip_prefix(&base).map(|rest| (rest.to_string(), entry)))
        .collect();
    Ok(Some((tree, classify_listed(clone, &entries)?)))
}

// ── Holds ────────────────────────────────────────────────────────────

/// The version a held skill's sessions keep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Previous {
    pub commit: String,
    /// The skill directory's tree at that commit.
    pub tree: String,
    pub files: Vec<SkillFile>,
    /// When it was approved; `None` for a version that was all text.
    pub approved_at: Option<i64>,
}

/// A skill waiting for an OK on this Mac.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hold {
    pub plugin: String,
    pub skill: String,
    pub prefix: String,
    pub scripts_id: String,
    pub files: Vec<SkillFile>,
    /// What new sessions keep meanwhile; `None`: they do not get the skill.
    pub previous: Option<Previous>,
}

/// The skills of `half` at `commit` whose scripts have no OK on this Mac.
///
/// (Challenger) Cached by commit, half and the approvals on this Mac: the
/// answer is a function of those alone, and finding a held skill's previous
/// version walks up to 50 commits of its history (a `git log` and three git
/// reads per candidate). Without the cache every launch, Library read and
/// Inbox read paid that again for as long as the skill waited for an OK.
pub(crate) fn holds(clone: &Path, commit: &str, half: Half, state: &HubState) -> Result<Vec<Hold>, String> {
    type Key = (std::path::PathBuf, String, Half, String);
    static CACHE: OnceLock<parking_lot::Mutex<HashMap<Key, Arc<Vec<Hold>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key = (clone.to_path_buf(), commit.to_string(), half, approvals_fingerprint(state));
    if let Some(found) = cache.lock().get(&key) {
        return Ok(found.as_ref().clone());
    }
    let (out, complete) = holds_uncached(clone, commit, half, state)?;
    if complete {
        let mut cache = cache.lock();
        if cache.len() > 64 {
            cache.clear();
        }
        cache.insert(key, Arc::new(out.clone()));
    }
    Ok(out)
}

/// A digest of every approval on this Mac: a new OK is a new cache key.
fn approvals_fingerprint(state: &HubState) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for approval in &state.approvals {
        hash.update(
            format!(
                "{}\0{}\0{}\0{}\n",
                approval.origin, approval.skill, approval.scripts_id, approval.approved_at
            )
            .as_bytes(),
        );
    }
    format!("{:x}", hash.finalize())
}

/// [`holds`], and whether every previous version was read (an answer built
/// over a failed history read is not kept).
fn holds_uncached(clone: &Path, commit: &str, half: Half, state: &HubState) -> Result<(Vec<Hold>, bool), String> {
    let skills = analyse(clone, commit, half)?;
    let mut complete = true;
    let mut out = Vec::new();
    for skill in skills.iter().filter(|skill| !skill.has_link) {
        let Some(id) = skill.scripts_id.as_deref() else {
            continue;
        };
        let origin = origin(clone, &skill.plugin);
        if state.approved(&origin, &skill.skill, id).is_some()
            || approved_before_a_rename(clone, commit, half, state, &origin, &skill.plugin, &skill.skill, id).is_some()
        {
            continue;
        }
        let previous = match previous_version(clone, commit, skill, &origin, state) {
            Ok(previous) => previous,
            Err(error) => {
                // Unknown history: the skill waits whole, which is the safe way.
                log::warn!("skills hub: earlier versions of {} unknown ({error})", skill.prefix);
                complete = false;
                None
            }
        };
        out.push(Hold {
            plugin: skill.plugin.clone(),
            skill: skill.skill.clone(),
            prefix: skill.prefix.clone(),
            scripts_id: id.to_string(),
            files: skill.files.clone(),
            previous,
        });
    }
    Ok((out, complete))
}

/// Owner, 2026-10-19: the OK follows a rename. An approval of these very
/// scripts (`scripts_id`: every non-text file's path, mode and bytes) given
/// to the skill under its **old** name counts for the new one, when the
/// library renamed it since the commit that approval was given at — read by
/// [`crate::skill_upstream::renamed_to`], the rules a linked skill's rename
/// is read with (H4). Nothing is written: the approval is the record, and a
/// script changed in or after the rename has another scripts id, so it asks.
/// An approval from before approvals kept their commit can't show a rename,
/// and asks too. The approval it follows, if any.
/// H6b (Challenger): `plugin` and `skill` are the directory names, so the
/// Install-time sheet's "You said OK to this version…" reads the same lookup.
pub(crate) fn approved_before_a_rename<'a>(
    clone: &Path,
    commit: &str,
    half: Half,
    state: &'a HubState,
    origin: &str,
    plugin: &str,
    skill: &str,
    scripts_id: &str,
) -> Option<&'a crate::skills_hub_state::Approval> {
    let parent = format!("{}{}/skills", half_root(half), plugin);
    state
        .approvals
        .iter()
        .filter(|a| a.origin == origin && a.scripts_id == scripts_id && a.skill != skill)
        .filter(|a| !a.skill.is_empty() && !a.skill.contains('/'))
        .find(|a| {
            let Some(from) = a.commit.as_deref() else {
                return false;
            };
            let old = format!("{parent}/{}", a.skill);
            crate::skill_upstream::renamed_to(clone, from, commit, &old).as_deref() == Some(skill)
        })
}

/// The newest earlier version of `skill` that was approved on this Mac, or
/// that was all text — walking the commits that changed its directory.
fn previous_version(
    clone: &Path,
    commit: &str,
    skill: &LibrarySkill,
    origin: &str,
    state: &HubState,
) -> Result<Option<Previous>, String> {
    let out = library_snapshot::git(
        clone,
        &["log", "--format=%H", "-n", HISTORY_DEPTH, commit, "--", &skill.prefix],
    )?;
    for candidate in String::from_utf8_lossy(&out).lines().map(str::trim).filter(|l| !l.is_empty()) {
        let Some((tree, files)) = skill_at(clone, candidate, &skill.prefix)? else {
            // It did not exist before this: nothing earlier to keep.
            return Ok(None);
        };
        let approved_at = match scripts_id(&files) {
            None => None,
            Some(id) => match state.approved(origin, &skill.skill, &id) {
                Some(approval) => Some(approval.approved_at),
                None => continue,
            },
        };
        return Ok(Some(Previous {
            commit: candidate.to_string(),
            tree,
            files,
            approved_at,
        }));
    }
    Ok(None)
}

// ── What the sheet shows ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewFile {
    pub path: String,
    pub kind: FileKind,
    pub executable: bool,
    pub size: u64,
    /// `"new"`, `"changed"` or `"unchanged"`, against the version sessions
    /// keep meanwhile (all `"new"` when they keep none).
    pub change: &'static str,
    /// The file's text, when it is UTF-8 and small enough to show.
    pub text: Option<String>,
    /// Too large to show (R15's size rule). `text` absent and this false: the
    /// file is not text, so there is nothing to read.
    pub too_large: bool,
    /// The CLIs whose copy holds this file, when the two copies differ.
    pub copies: Vec<&'static str>,
    /// 1.175.0 B1: what this text asks to be allowed to do, when it is a
    /// skill's text that asks (`kind` is `asks`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asks: Option<crate::skill_asks::Asks>,
    /// 1.175.0 B1: the same for the version sessions keep meanwhile, when
    /// this file changed since — what the sheet's "changed" chips compare.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asks_before: Option<crate::skill_asks::Asks>,
    /// 1.175.0 B1: that version's text, for "Show both".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_before: Option<String>,
}

impl ReviewFile {
    /// Fill `asks` from the text, for a skill's text that asks. Text too
    /// large to show is said as unreadable: the member opens the file.
    pub(crate) fn with_asks(mut self) -> Self {
        if self.kind == FileKind::Asks {
            self.asks = Some(match &self.text {
                Some(text) => crate::skill_asks::analyse(text.as_bytes()),
                None => crate::skill_asks::Asks { unreadable: Some(1), ..Default::default() },
            });
        }
        self
    }
}

/// Everything the *Needs your OK* sheet draws for one skill.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScriptsReview {
    pub skill: String,
    pub plugin: String,
    /// The library commit shown: an OK approves exactly what it holds.
    pub commit: String,
    pub scripts_ids: Vec<String>,
    /// No earlier version reaches sessions meanwhile.
    pub first_time: bool,
    /// When the version sessions keep was approved, if it was.
    pub approved_at: Option<i64>,
    /// Who last changed the skill, and when (unix seconds).
    pub author: Option<String>,
    pub files: Vec<ReviewFile>,
    /// Round 2 (G3): the `SKILL.md` of the version sessions keep meanwhile —
    /// the one approved here, or the plain text from before it asked. The
    /// skill's page shows it, so the person reads what their sessions use.
    /// `None`: no session gets the skill until the OK.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept_text: Option<String>,
    /// Y1 round 2: the widest thing its texts ask ([`widest_ask`]) — the
    /// sheet's title and lede, in step with the row. Absent: no text asks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asks: Option<crate::skill_asks::Strongest>,
}

/// The sheet for `skill` in `plugin` at the clone's `HEAD`, or `None` when it
/// needs no OK (text-only, or approved already).
pub(crate) fn review(clone: &Path, plugin: &str, skill: &str, state: &HubState) -> Result<Option<ScriptsReview>, String> {
    let commit = library_snapshot::head_commit(clone)?;
    let mut held: Vec<(Half, Hold)> = Vec::new();
    for half in [Half::Claude, Half::Codex] {
        for hold in holds(clone, &commit, half, state)? {
            if hold.skill == skill && hold.plugin == plugin {
                held.push((half, hold));
            }
        }
    }
    if held.is_empty() {
        return Ok(None);
    }
    let blobs_to_show = held.iter().flat_map(|(_, hold)| hold.files.iter()).collect::<Vec<_>>();
    let skill_bytes: u64 = held
        .iter()
        .map(|(_, hold)| hold.files.iter().map(|f| f.size).sum::<u64>())
        .max()
        .unwrap_or(0);
    // Text of each showable file, read once per blob.
    let showable: Vec<TreeFile> = {
        let mut seen = std::collections::HashSet::new();
        blobs_to_show
            .iter()
            .filter(|f| skill_bytes <= SHOW_SKILL_MAX && f.size <= SHOW_FILE_MAX && seen.insert(f.blob.clone()))
            .map(|f| TreeFile {
                path: f.path.clone(),
                id: f.blob.clone(),
                size: f.size,
                executable: f.executable,
            })
            .collect()
    };
    let texts: HashMap<String, Option<String>> = library_snapshot::cat_blobs(clone, &showable)?
        .into_iter()
        .zip(showable.iter())
        .map(|(bytes, file)| (file.id.clone(), String::from_utf8(bytes).ok()))
        .collect();

    // One row per (path, blob); copies named only when the two halves differ.
    let mut rows: BTreeMap<(String, String), ReviewFile> = BTreeMap::new();
    let both = held.len() > 1;
    for (half, hold) in &held {
        // (Challenger) The mode counts: a file that only gained or lost its
        // executable bit changed the scripts id, so it is what is asked about.
        let before: HashMap<&str, (&str, bool)> = hold
            .previous
            .iter()
            .flat_map(|p| p.files.iter())
            .map(|f| (f.path.as_str(), (f.blob.as_str(), f.executable)))
            .collect();
        for file in &hold.files {
            let row = rows
                .entry((file.path.clone(), file.blob.clone()))
                .or_insert_with(|| {
                    let text = texts.get(&file.blob).cloned().flatten();
                    ReviewFile {
                        path: file.path.clone(),
                        kind: file.kind,
                        executable: file.executable,
                        size: file.size,
                        change: match before.get(file.path.as_str()) {
                            None => "new",
                            Some((blob, executable)) if *blob == file.blob && *executable == file.executable => {
                                "unchanged"
                            }
                            Some(_) => "changed",
                        },
                        too_large: text.is_none()
                            && (file.size > SHOW_FILE_MAX || skill_bytes > SHOW_SKILL_MAX),
                        text,
                        copies: Vec::new(),
                        asks: None,
                        asks_before: None,
                        text_before: None,
                    }
                    .with_asks()
                });
            if both {
                row.copies.push(match half {
                    Half::Claude => "claude",
                    Half::Codex => "codex",
                });
            }
        }
    }
    let mut files: Vec<ReviewFile> = rows.into_values().collect();
    // A file both copies hold the same needs no copy named.
    for file in &mut files {
        if file.copies.len() == held.len() {
            file.copies.clear();
        }
    }
    // 1.175.0 B1: a changed text that asks is set beside the version
    // sessions keep — what it asked for then, and its text for "Show both".
    for file in files.iter_mut().filter(|f| f.kind == FileKind::Asks && f.change == "changed") {
        let before = held
            .iter()
            .filter_map(|(_, hold)| hold.previous.as_ref())
            .flat_map(|previous| previous.files.iter())
            .find(|was| was.path == file.path && was.size <= SHOW_FILE_MAX);
        if let Some(was) = before {
            let wanted = [TreeFile { path: was.path.clone(), id: was.blob.clone(), size: was.size, executable: was.executable }];
            if let Some(text) = library_snapshot::cat_blobs(clone, &wanted)?.into_iter().next().and_then(|bytes| String::from_utf8(bytes).ok()) {
                file.asks_before = Some(crate::skill_asks::analyse(text.as_bytes()));
                file.text_before = Some(text);
            }
        }
    }
    // Scripts first, then extra files, then text; by path within each.
    files.sort_by(|a, b| a.kind.order().cmp(&b.kind.order()).then_with(|| a.path.cmp(&b.path)));

    let mut scripts_ids: Vec<String> = held.iter().map(|(_, hold)| hold.scripts_id.clone()).collect();
    scripts_ids.sort();
    scripts_ids.dedup();
    let previous: Vec<&Previous> = held.iter().filter_map(|(_, hold)| hold.previous.as_ref()).collect();
    let prefix = &held[0].1.prefix;
    let author = library_snapshot::git(clone, &["log", "-1", "--format=%an", &commit, "--", prefix])
        .ok()
        .map(|out| String::from_utf8_lossy(&out).trim().to_string())
        .filter(|name| !name.is_empty());
    // Round 2 (G3): the text of the version sessions keep, for the skill's page.
    let kept_text = previous
        .iter()
        .flat_map(|p| p.files.iter())
        .find(|file| file.path.eq_ignore_ascii_case("SKILL.md") && file.size <= SHOW_FILE_MAX)
        .and_then(|file| {
            let wanted = [TreeFile { path: file.path.clone(), id: file.blob.clone(), size: file.size, executable: file.executable }];
            library_snapshot::cat_blobs(clone, &wanted).ok()?.into_iter().next().and_then(|bytes| String::from_utf8(bytes).ok())
        });
    Ok(Some(ScriptsReview {
        skill: skill.to_string(),
        plugin: plugin.to_string(),
        commit,
        scripts_ids,
        first_time: previous.len() < held.len(),
        approved_at: previous.iter().filter_map(|p| p.approved_at).max(),
        author,
        asks: widest_ask(&files),
        files,
        kept_text,
    }))
}

impl FileKind {
    fn order(self) -> u8 {
        match self {
            FileKind::Script => 0,
            FileKind::Extra => 1,
            FileKind::Asks => 2,
            FileKind::Text => 3,
        }
    }
}

/// Approve what the sheet showed: refused unless `scripts_ids` are exactly
/// the held scripts ids of `skill` at `commit`, so an OK can never cover a
/// version the member was not shown (a pull may have landed meanwhile).
pub(crate) fn approve(
    config_dir: &Path,
    clone: &Path,
    plugin: &str,
    skill: &str,
    commit: &str,
    scripts_ids: &[String],
    now_ms: i64,
) -> Result<(), String> {
    if commit.len() < 40 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("unexpected commit `{commit}`"));
    }
    let state = crate::skills_hub_state::load(config_dir);
    // (Challenger) What sessions get next is read from `HEAD`, so that is
    // what the OK is checked against — not only the commit the sheet showed.
    // A pull that brought other scripts while the sheet was open makes the
    // OK refused (the sheet reads the new version), instead of recording the
    // older scripts and saying "approved" while the row still waits. The
    // shown commit must still be a commit of this clone.
    library_snapshot::git(clone, &["cat-file", "-e", &format!("{commit}^{{commit}}")])
        .map_err(|_| format!("unexpected commit `{commit}`"))?;
    let head = library_snapshot::head_commit(clone)?;
    let mut held: Vec<String> = Vec::new();
    for half in [Half::Claude, Half::Codex] {
        for hold in holds(clone, &head, half, &state)? {
            if hold.skill == skill && hold.plugin == plugin {
                held.push(hold.scripts_id);
            }
        }
    }
    held.sort();
    held.dedup();
    let mut asked = scripts_ids.to_vec();
    asked.sort();
    asked.dedup();
    if held.is_empty() {
        return Ok(());
    }
    if held != asked {
        return Err(format!(
            "{skill} changed while you were reading it. Open it again to see the new version."
        ));
    }
    crate::skills_hub_state::approve(config_dir, &origin(clone, plugin), skill, &held, Some(commit), now_ms)
}

/// [`scripts_id`] of a folder on disk: the id its files get once committed
/// as they are. Through the reader a share copies with, classified as
/// [`classify_listed`] classifies them (past [`CONTENT_READ_MAX`] the bytes
/// aren't looked at). `None`: all text.
pub(crate) fn scripts_id_of_folder(dir: &Path) -> Result<Option<String>, String> {
    Ok(scripts_id_of_tree(crate::project_skills::read_tree(dir)?))
}

/// [`scripts_id_of_folder`] of files already read.
pub(crate) fn scripts_id_of_tree(tree: Vec<crate::project_skills::TreeFile>) -> Option<String> {
    use crate::skills_index::hash;
    let files: Vec<SkillFile> = tree
        .into_iter()
        .map(|file| {
            let size = file.bytes.len() as u64;
            let content = (size <= CONTENT_READ_MAX).then(|| ContentFacts::of(&file.bytes));
            SkillFile {
                kind: classify(&file.path, file.executable, content),
                blob: hash::hex(&hash::blob_id_of(&file.bytes, hash::Normalise::None)),
                path: file.path,
                size,
                executable: file.executable,
            }
        })
        .collect();
    scripts_id(&files)
}

/// Owner, 2026-11-03: the computer that just shared a personal skill doesn't
/// ask its OK for those bytes. They were already in a folder that reaches every
/// session here, so holding the team's copy back protected nothing. Recorded
/// only when the clone's `HEAD` really holds what `source` holds: the key is
/// these bytes, so a teammate's different script has another id and still
/// asks, here and on every other computer. Whether it was recorded.
pub(crate) fn approve_own_share(
    config_dir: &Path,
    clone: &Path,
    plugin: &str,
    skill: &str,
    source: &Path,
    now_ms: i64,
) -> Result<bool, String> {
    let Some(id) = scripts_id_of_folder(source)? else {
        return Ok(false);
    };
    let commit = library_snapshot::head_commit(clone)?;
    let mut held_there = false;
    for half in [Half::Claude, Half::Codex] {
        let skills = analyse(clone, &commit, half)?;
        if skills.iter().any(|found| found.plugin == plugin && found.skill == skill && found.scripts_id.as_deref() == Some(id.as_str())) {
            held_there = true;
        }
    }
    if !held_there {
        return Ok(false);
    }
    crate::skills_hub_state::approve(config_dir, &origin(clone, plugin), skill, &[id], Some(&commit), now_ms)?;
    Ok(true)
}

/// [`approve_own_share`] after the push; a failure only means it asks.
pub(crate) fn own_share_needs_no_ok<R: tauri::Runtime>(app: &tauri::AppHandle<R>, clone: &Path, plugin: &str, skill: &str, source: &Path) {
    use tauri::Emitter;
    let recorded = crate::skills_hub::config_dir(app)
        .and_then(|config_dir| approve_own_share(&config_dir, clone, plugin, skill, source, chrono::Utc::now().timestamp_millis()));
    match recorded {
        Ok(true) => {
            let _ = app.emit(crate::skills_hub::DECISION_EVENT, ());
        }
        Ok(false) => {}
        Err(error) => log::warn!("skills hub: couldn't record the OK for your own {skill} ({error})"),
    }
}

/// 1.175.0 B1 (scene 1.7): Promote to Team of a repository skill whose text
/// asks went through the Share page, which says "on this Mac, sharing it is
/// your OK". Recorded as [`own_share_needs_no_ok`] records a personal share,
/// and only for the very bytes the page showed.
///
/// Round 2 (G3): the page sends the id of what it showed (`shown`,
/// [`ProjectSkill::asks_id`]) with the press, and the OK is recorded only
/// when the copy that was shared has that id. Nothing is read again from
/// the checkout after the push: a file edited meanwhile can't become what
/// was "shown". No id, another id, or a text that asks for nothing: it asks
/// here as on every other computer.
///
/// [`ProjectSkill::asks_id`]: crate::project_skills::ProjectSkill::asks_id
pub(crate) fn own_promote_needs_no_ok<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    clone: &Path,
    plugin: &str,
    skill: &str,
    shared: &Path,
    shown: Option<&str>,
) {
    if promote_was_shown(shared, shown) {
        own_share_needs_no_ok(app, clone, plugin, skill, shared);
    }
}

/// Whether the copy that was shared is the one the Share page showed.
pub(crate) fn promote_was_shown(shared: &Path, shown: Option<&str>) -> bool {
    let Some(shown) = shown.filter(|id| !id.is_empty()) else {
        return false;
    };
    let Ok(tree) = crate::project_skills::read_tree(shared) else {
        return false;
    };
    crate::project_skills::asks_of_tree(&tree).is_some() && scripts_id_of_tree(tree).as_deref() == Some(shown)
}

/// One per held skill (both copies of a skill are one row), at the clone's
/// `HEAD`: what the Library row and the Inbox say.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeedsOk {
    pub plugin: String,
    pub skill: String,
    pub first_time: bool,
    pub approved_at: Option<i64>,
    /// (Challenger) Something it asks about is a script; `false` when only
    /// extra files (an image, a file that is not text) ask — the row and the
    /// Inbox then do not say "script". Windows walk (H6b): a script that is
    /// new or changed against the version sessions keep, not any script the
    /// skill holds — an image added beside unchanged scripts is not one.
    pub brings_script: bool,
    /// 1.175.0 B1: the strongest thing its text asks for, when a `SKILL.md`
    /// that asks is new or changed against the version sessions keep —
    /// `inline`, `commands`, `files` or `unreadable`. The row says it when no
    /// script is among what is new.
    pub asks: Option<crate::skill_asks::Strongest>,
    /// Every held scripts id, for a stable Inbox row id.
    pub scripts_ids: Vec<String>,
}

pub(crate) fn needs_ok(clone: &Path, state: &HubState) -> Result<Vec<NeedsOk>, String> {
    let commit = library_snapshot::head_commit(clone)?;
    let mut by_skill: BTreeMap<(String, String), Vec<Hold>> = BTreeMap::new();
    for half in [Half::Claude, Half::Codex] {
        for hold in holds(clone, &commit, half, state)? {
            by_skill
                .entry((hold.plugin.clone(), hold.skill.clone()))
                .or_default()
                .push(hold);
        }
    }
    Ok(by_skill
        .into_iter()
        .map(|((plugin, skill), holds)| {
            let mut scripts_ids: Vec<String> = holds.iter().map(|h| h.scripts_id.clone()).collect();
            scripts_ids.sort();
            scripts_ids.dedup();
            NeedsOk {
                // Round 3: the two copies' texts are put together and the
                // one rule applied — never an ordering of two answers.
                asks: {
                    let texts: Vec<crate::skill_asks::Asks> =
                        holds.iter().flat_map(|hold| texts_new_or_changed(clone, hold)).collect();
                    crate::skill_asks::Asks::widest(&texts)
                },
                first_time: holds.iter().any(|h| h.previous.is_none()),
                approved_at: holds
                    .iter()
                    .filter_map(|h| h.previous.as_ref().and_then(|p| p.approved_at))
                    .max(),
                brings_script: holds.iter().any(brings_new_or_changed_script),
                plugin,
                skill,
                scripts_ids,
            }
        })
        .collect())
}

/// Whether `hold` brings a script that is new, or changed in bytes or mode,
/// against the version sessions keep (every script, when they keep none).
fn brings_new_or_changed_script(hold: &Hold) -> bool {
    let before: HashMap<&str, (&str, bool)> = hold
        .previous
        .iter()
        .flat_map(|p| p.files.iter())
        .map(|f| (f.path.as_str(), (f.blob.as_str(), f.executable)))
        .collect();
    hold.files.iter().any(|f| {
        f.kind == FileKind::Script
            && before.get(f.path.as_str()) != Some(&(f.blob.as_str(), f.executable))
    })
}

/// 1.175.0 B1: what `hold`'s texts ask for — each `SKILL.md` that asks and
/// is new or changed against the version sessions keep. A text that can't be
/// read back from git is said as unreadable: it asks. [`needs_ok`] puts the
/// texts of a skill's two copies together before the one rule is applied.
fn texts_new_or_changed(clone: &Path, hold: &Hold) -> Vec<crate::skill_asks::Asks> {
    let before: HashMap<&str, &str> = hold
        .previous
        .iter()
        .flat_map(|p| p.files.iter())
        .map(|f| (f.path.as_str(), f.blob.as_str()))
        .collect();
    hold.files
        .iter()
        .filter(|f| f.kind == FileKind::Asks && before.get(f.path.as_str()) != Some(&f.blob.as_str()))
        .map(|f| asks_of_blob(clone, f))
        .collect()
}

/// Y1 round 2: the one thing the sheet's title and lede say — the same rule
/// ([`crate::skill_asks::Asks::widest`]) over the review's texts that are
/// new or changed, which is what the row and the Inbox say
/// ([`texts_new_or_changed`]); over all of them when none is.
pub(crate) fn widest_ask(files: &[ReviewFile]) -> Option<crate::skill_asks::Strongest> {
    let texts = |moved: bool| {
        files
            .iter()
            .filter(move |f| f.kind == FileKind::Asks && !(moved && f.change == "unchanged"))
            .filter_map(|f| f.asks.as_ref())
    };
    crate::skill_asks::Asks::widest(texts(true)).or_else(|| crate::skill_asks::Asks::widest(texts(false)))
}

/// What a skill's text asks for, read from git once per blob.
fn asks_of_blob(clone: &Path, file: &SkillFile) -> crate::skill_asks::Asks {
    static CACHE: OnceLock<parking_lot::Mutex<HashMap<String, crate::skill_asks::Asks>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(found) = cache.lock().get(&file.blob) {
        return found.clone();
    }
    let wanted = [TreeFile { path: file.path.clone(), id: file.blob.clone(), size: file.size, executable: file.executable }];
    let asks = match library_snapshot::cat_blobs(clone, &wanted) {
        Ok(blobs) if file.size <= CONTENT_READ_MAX => blobs.first().map(|bytes| crate::skill_asks::analyse(bytes)).unwrap_or_default(),
        _ => crate::skill_asks::Asks { unreadable: Some(1), ..Default::default() },
    };
    let mut cache = cache.lock();
    if cache.len() > 5_000 {
        cache.clear();
    }
    cache.insert(file.blob.clone(), asks.clone());
    asks
}

/// What a skill's text asks for, in the Inbox's words.
fn asks_words(asks: crate::skill_asks::Strongest) -> &'static str {
    use crate::skill_asks::Strongest;
    match asks {
        Strongest::Inline => "runs a command when it loads",
        Strongest::Commands => "lets agents run commands without asking you",
        Strongest::Files => "lets agents change files without asking you",
        Strongest::Unreadable => "asks for something Plyloft couldn't read",
    }
}

/// The Inbox row's line for one held skill — true in each state: it brings
/// a script from its first version, it now brings one where the version kept
/// was all text, or a script changed since the version approved here. "A file
/// that is not text" when no script is among what asks (an image).
pub(crate) fn needs_ok_detail(item: &NeedsOk) -> String {
    needs_ok_detail_in(item, "the team library")
}

/// [`needs_ok_detail`] for the library `place` names (H10: "My library").
pub(crate) fn needs_ok_detail_in(item: &NeedsOk, place: &str) -> String {
    // 1.175.0 B1: no script among what is new, and its text asks — the row
    // says what the text asks for; changed after an OK, that its text changed.
    if let Some(asks) = item.asks.filter(|_| !item.brings_script) {
        let words = asks_words(asks);
        return if item.first_time {
            format!("It {words}, from {place}")
        } else if item.approved_at.is_none() {
            format!("It now {words}, from {place}")
        } else {
            format!("Its text changed in {place}")
        };
    }
    let noun = if item.brings_script { "a script" } else { "a file that is not text" };
    if item.first_time {
        format!("It brings {noun} from {place}")
    } else if item.approved_at.is_none() {
        format!("It now brings {noun} from {place}")
    } else {
        let mut noun = noun.to_string();
        noun[..1].make_ascii_uppercase();
        format!("{noun} changed in {place}")
    }
}

/// The Inbox row id of one held skill (R14: stable, resolves when the state
/// changes): `skill:<origin>/<skill>:needs-ok:<scripts id>`.
pub(crate) fn inbox_id(clone: &Path, item: &NeedsOk) -> String {
    let ids: String = item
        .scripts_ids
        .iter()
        .map(|id| id.get(..16).unwrap_or(id))
        .collect::<Vec<_>>()
        .join("+");
    format!("skill:{}/{}:needs-ok:{ids}", origin(clone, &item.plugin), item.skill)
}

// Skills hub H6b: the Install-time sheet — before a library skill's files
// are written into a repository.
#[path = "skill_scripts_repo.rs"]
pub(crate) mod repo;

// Owner, 2026-10-19: the same sheet before Publish to <branch> commits a
// member's own repository copy straight onto a shared workspace's branch.
#[path = "skill_scripts_publish.rs"]
pub(crate) mod publish;

#[cfg(test)]
#[path = "skill_scripts_tests.rs"]
mod tests;
