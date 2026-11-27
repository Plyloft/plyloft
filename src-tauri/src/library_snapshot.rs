//! Skills hub H1 (`docs/plans/SKILLS_HUB.md` §7.2, R13): what a session is
//! given from a skills **library** — the team library today, My library from
//! H10 on the same path — is a fixed, content-named snapshot built from the
//! git objects of **one commit**, never the clone's working tree.
//!
//! Before H1, Claude's `--plugin-dir` pointed into the team clone itself, so a
//! pull changed the files a running Claude session read when it invoked a
//! skill; and Codex's overlay copied each plugin out of the working tree while
//! nothing held the clone's lock, so a pull racing a launch could hand Codex a
//! torn copy (half old, half new files). Both are gone:
//!
//! - **From a commit.** A launch reads `HEAD` once (`git rev-parse`; a ref
//!   moves atomically and its objects exist before it does) and builds from
//!   that commit's objects (`git ls-tree`, `git cat-file --batch`). **No
//!   `git_lock` is taken**: a launch never waits behind a pull that may run to
//!   its timeout, and a pull landing mid-build changes nothing already chosen.
//! - **Named by tree id.** One snapshot per Claude plugin, named by the first
//!   16 hex digits of the plugin directory's git tree id
//!   (`sessions/<key>/claude/<tree16>/`); one per Codex marketplace, named by
//!   `library/codex`'s tree id (`sessions/<key>/codex/<tree16>/`) — the overlay
//!   registers the marketplace's *root* as its source, so the root must be a
//!   fixed directory too, not only the plugins inside it. The name costs no
//!   hashing on the launch path (git already has it), and an unchanged plugin
//!   is reused across every pull: only what changed is copied.
//! - **Never modified once complete.** Built under `.build-<uuid>` and renamed
//!   in; a losing race is fine because the winner is identical.
//! - **Shared, so never removed at session end.** A snapshot belongs to its
//!   content, not to a session. Each launch stamps the ones it uses
//!   (`<tree16>.last-used`, atomically) **before** looking for them, and
//!   [`crate::shared_library_sync::prune_session_plugins`] removes those no
//!   launch has stamped for 30 days, and half-builds after an hour. Past
//!   [`CAP_BYTES`] per library, [`prune_to_cap`] removes the least recently
//!   stamped first, never one stamped in the last 24 hours.
//! - **Plain files on every platform** — no symbolic link, junction or hard
//!   link, so nothing here needs Developer Mode on Windows; a library entry
//!   that *is* a symbolic link refuses its plugin. On Windows a skill whose
//!   longest path in the snapshot would pass [`WINDOWS_PATH_LIMIT`] characters
//!   is left out of that snapshot with the reason ("Path too long for
//!   Windows"), rather than handing a CLI a file it cannot open.
//!
//! The same module keeps, **in memory only**, what each live session was
//! given ([`register`], keyed by PTY id, dropped when the child exits): the
//! library's commit and the skills it delivered. [`drift`] answers "which of
//! them changed upstream since" — the "Skill updated after this session
//! started" line (R13). Sessions never survive a relaunch, so nothing is
//! persisted.
//!
//! Team **Knowledge** stays live (§14 Q21): the `ply` sidecar still reads
//! `library/knowledge/` from the clone on every call.

use std::collections::{BTreeSet, HashMap};
use std::io::{Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::team_skills::TeamSkillsLibrary;

/// `<config_dir>/skills_hub/sessions/` (spec §5.8).
pub(crate) fn sessions_root(config_dir: &Path) -> PathBuf {
    config_dir.join("skills_hub").join("sessions")
}

/// How long a snapshot no launch has stamped is kept — the rule the other
/// three deliveries follow (`shared_library_sync::SESSION_PLUGIN_KEEP`).
const KEEP: Duration = Duration::from_secs(30 * 24 * 3600);

/// The default per-library cap on snapshots (§14 Q25).
pub(crate) const CAP_BYTES: u64 = 512 * 1024 * 1024;

/// A snapshot stamped this recently is never removed by the cap: a session
/// could be reading it.
const CAP_GRACE: Duration = Duration::from_secs(24 * 3600);

/// A stamp younger than this is not rewritten at launch.
const STAMP_FRESH: Duration = Duration::from_secs(3600);

/// Every git this module runs is local (no network), so this only bounds a
/// wedged process; it is killed with its group, and on app exit.
// H8 (Windows walk): a VM under load ran a `ls-tree` past 30 s.
const GIT_TIMEOUT: Duration = Duration::from_secs(if cfg!(windows) { 60 } else { 30 });

/// One plugin past this many bytes of files is refused rather than copied.
/// Far above the 5 MB per skill the spec caps a shared skill at (§14 Q18).
const PLUGIN_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// §8 MAX_PATH: the longest path a snapshot may hold on Windows.
pub(crate) const WINDOWS_PATH_LIMIT: usize = 240;

/// The words a skill left out on Windows is named with (§8).
pub(crate) const PATH_TOO_LONG: &str = "Path too long for Windows";

/// Which CLI's half of a library a launch needs. A Claude launch never builds
/// the Codex half, nor the reverse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Half {
    Claude,
    Codex,
}

impl Half {
    fn dir(self) -> &'static str {
        match self {
            Half::Claude => "claude",
            Half::Codex => "codex",
        }
    }
}

/// The few things that differ between this Mac and a test.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Options {
    /// `Some(n)` where paths are limited (Windows): a skill whose snapshot path
    /// would pass `n` characters is left out.
    pub path_limit: Option<usize>,
    pub cap_bytes: u64,
}

impl Options {
    pub(crate) fn native() -> Self {
        Self {
            path_limit: cfg!(windows).then_some(WINDOWS_PATH_LIMIT),
            cap_bytes: CAP_BYTES,
        }
    }
}

/// One library directory name per clone, short enough for Windows paths
/// (§8): the clone's own directory name (`team::slug_dir_name`) cut to 40
/// characters, plus 8 hex digits of a digest of the whole name, so two long
/// names that share a prefix stay apart.
pub(crate) fn library_key(clone_dir: &Path) -> String {
    use sha2::{Digest, Sha256};
    let name = clone_dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "library".to_string());
    let digest = format!("{:x}", Sha256::digest(name.as_bytes()));
    let short: String = name.chars().take(40).collect();
    format!("{short}-{}", &digest[..8])
}

/// What a launch was given from one library, and the record [`drift`] reads.
#[derive(Debug, Default)]
pub(crate) struct Delivered {
    pub library: TeamSkillsLibrary,
    pub record: Option<LibraryRecord>,
    /// Snapshots this launch had to build (0 with an unchanged library).
    pub built: usize,
}

/// What a session was given from one library: the commit, and per delivered
/// plugin the skills it carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LibraryRecord {
    pub clone: PathBuf,
    pub commit: String,
    pub plugins: Vec<DeliveredPlugin>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeliveredPlugin {
    /// The plugin's directory in the library at that commit:
    /// `library/claude/<dir>` or `library/codex/plugins/<name>`.
    pub prefix: String,
    /// The skill directory names the session loaded from it.
    pub skills: Vec<String>,
}

/// The `half` of the library in `clone` a launch delivers, from `HEAD`.
pub(crate) fn deliver(
    config_dir: &Path,
    clone: &Path,
    half: Half,
    options: Options,
) -> Result<Delivered, String> {
    let commit = head_commit(clone)?;
    deliver_at(config_dir, clone, &commit, half, options)
}

/// [`deliver`] from a given commit.
///
/// Skills hub H6a (R15): a skill whose scripts have no OK on this Mac is
/// **held** ([`crate::skill_scripts::holds`]): its plugin's snapshot carries
/// the skill's previously approved version instead — that version's tree,
/// from its own commit — or leaves the skill out when there is none. Such a
/// snapshot is named by a digest of the plugin tree and every swap, so it is
/// as content-named as a plain one, and a later OK simply names another.
pub(crate) fn deliver_at(
    config_dir: &Path,
    clone: &Path,
    commit: &str,
    half: Half,
    options: Options,
) -> Result<Delivered, String> {
    let key_dir = sessions_root(config_dir).join(library_key(clone));
    let root = key_dir.join(half.dir());
    std::fs::create_dir_all(&root).map_err(|error| format!("create {}: {error}", root.display()))?;
    // Unknown scripts are never handed out: a library this cannot read the
    // files of costs the session its skills, as an unreadable one always did.
    let state = crate::skills_hub_state::load(config_dir);
    let holds = crate::skill_scripts::holds(clone, commit, half, &state)?;
    for hold in &holds {
        log::info!(
            "skills hub: {} waits for an OK on {}; new sessions get {}",
            hold.prefix,
            crate::platform::THIS_MACHINE,
            match &hold.previous {
                Some(previous) => format!("its version of {}", &previous.commit[..previous.commit.len().min(12)]),
                None => "nothing of it".to_string(),
            }
        );
    }
    // The swaps one plugin's snapshot carries: `skills/<name>/` (relative to
    // the snapshot root) → the tree to put there, or nothing.
    let swaps_in = |plugin: &str, base: &str| -> Vec<(String, Option<String>)> {
        holds
            .iter()
            .filter(|hold| hold.plugin == plugin)
            .map(|hold| {
                (
                    format!("{base}skills/{}/", hold.skill),
                    hold.previous.as_ref().map(|previous| previous.tree.clone()),
                )
            })
            .collect()
    };

    let mut built = 0usize;
    let mut problems: Vec<String> = Vec::new();
    // Snapshot directory → the library directories it was built from, for the
    // record (a snapshot is named by its tree id, not by its directory; two
    // directories with identical content share one snapshot).
    let mut labels: HashMap<PathBuf, Vec<String>> = HashMap::new();
    let mut library = match half {
        Half::Claude => {
            let mut plugins: Vec<(String, PathBuf)> = Vec::new();
            for (name, tree) in child_trees(clone, commit, "library/claude/")? {
                if name.starts_with('.') {
                    continue;
                }
                let unit = Unit::new(tree, swaps_in(&name, ""));
                match snapshot(clone, &unit, &root, options, &mut built) {
                    Ok(snap) => {
                        problems.extend(snap.skipped.iter().map(|skill| {
                            format!("`{skill}` in library/claude/{name}: {PATH_TOO_LONG}")
                        }));
                        let sources = labels.entry(snap.dir.clone()).or_default();
                        sources.push(name.clone());
                        // One `--plugin-dir` per snapshot: a second identical
                        // directory adds nothing a session could load.
                        if sources.len() == 1 {
                            plugins.push((name, snap.dir));
                        }
                    }
                    Err(error) => problems.push(format!("library/claude/{name}: {error}")),
                }
            }
            crate::team_skills::read_snapshot_library(plugins, None)
        }
        Half::Codex => match entry_tree(clone, commit, "library/codex")? {
            None => TeamSkillsLibrary::default(),
            Some(tree) => {
                let swaps: Vec<(String, Option<String>)> = holds
                    .iter()
                    .flat_map(|hold| swaps_in(&hold.plugin, &format!("plugins/{}/", hold.plugin)))
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                let unit = Unit::new(tree, swaps);
                match snapshot(clone, &unit, &root, options, &mut built) {
                    Ok(snap) => {
                        problems.extend(
                            snap.skipped
                                .iter()
                                .map(|skill| format!("{}: {PATH_TOO_LONG}", codex_skill_label(skill))),
                        );
                        crate::team_skills::read_snapshot_library(Vec::new(), Some(&snap.dir))
                    }
                    Err(error) => {
                        problems.push(format!("library/codex: {error}"));
                        TeamSkillsLibrary::default()
                    }
                }
            }
        },
    };
    for problem in &problems {
        log::warn!("skills hub: {problem}");
    }
    library.errors.extend(problems);

    // Age first, every launch (cheap: one directory listing). The cap walks
    // file sizes, so it runs only when this launch added bytes, and off the
    // launch path.
    crate::shared_library_sync::prune_session_plugins(&root, KEEP);
    // A library no launch delivers from any more (a team left, a clone moved)
    // is never visited by the line above: age its snapshots out once per run.
    static OTHERS_SWEPT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !OTHERS_SWEPT.swap(true, std::sync::atomic::Ordering::SeqCst) {
        let sessions = sessions_root(config_dir);
        let key = library_key(clone);
        std::thread::spawn(move || prune_other_libraries(&sessions, &key, KEEP));
    }
    if built > 0 {
        let cap = options.cap_bytes;
        let key_dir = key_dir.clone();
        std::thread::spawn(move || prune_to_cap(&key_dir, cap, CAP_GRACE));
    }

    let record = record_of(clone, commit, half, &library, &labels);
    Ok(Delivered {
        library,
        record: Some(record),
        built,
    })
}

/// The record [`drift`] compares against: per delivered plugin, its path in
/// the library and the skills the session got from it.
fn record_of(
    clone: &Path,
    commit: &str,
    half: Half,
    library: &TeamSkillsLibrary,
    labels: &HashMap<PathBuf, Vec<String>>,
) -> LibraryRecord {
    let mut plugins = Vec::new();
    match half {
        Half::Claude => {
            for (name, dir) in &library.claude_plugins {
                let skills: Vec<String> = library
                    .skills
                    .iter()
                    .filter(|skill| skill.claude && &skill.plugin == name)
                    .map(|skill| skill.name.clone())
                    .collect();
                for label in labels.get(dir).into_iter().flatten() {
                    plugins.push(DeliveredPlugin {
                        prefix: format!("library/claude/{label}"),
                        skills: skills.clone(),
                    });
                }
            }
        }
        Half::Codex => {
            if let Some(marketplace) = &library.codex {
                for plugin in &marketplace.plugins {
                    let skills = library
                        .skills
                        .iter()
                        .filter(|skill| skill.codex && skill.plugin == plugin.name)
                        .map(|skill| skill.name.clone())
                        .collect();
                    plugins.push(DeliveredPlugin {
                        prefix: format!("library/codex/plugins/{}", plugin.name),
                        skills,
                    });
                }
            }
        }
    }
    LibraryRecord {
        clone: clone.to_path_buf(),
        commit: commit.to_string(),
        plugins,
    }
}

/// A dotfile inside every snapshot: the full tree id it was built from (so a
/// 16-digit name shared by two trees is caught, not reused), and the skills
/// left out of it (Windows path length). Both CLIs ignore a dotfile at a
/// plugin's root, and Codex's copy of it into the overlay is harmless.
const SNAPSHOT_META: &str = ".plyloft-snapshot.json";

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct SnapshotMeta {
    /// Absent in a snapshot built before the field existed: trusted by name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tree: Option<String>,
    #[serde(default)]
    skipped: Vec<String>,
}

fn read_meta(dir: &Path) -> Option<SnapshotMeta> {
    std::fs::read(dir.join(SNAPSHOT_META))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SnapshotMeta>(&bytes).ok())
}

struct Snapshot {
    dir: PathBuf,
    skipped: Vec<String>,
}

/// What one snapshot holds: a tree, with some of its skill directories
/// swapped for another tree or taken out (H6a). `id` names it — the tree id
/// itself when nothing is swapped, so every snapshot H1 built is reused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Unit {
    pub id: String,
    pub base: String,
    /// `<path>/` inside the snapshot → the tree put there, or none.
    pub swaps: Vec<(String, Option<String>)>,
}

impl Unit {
    pub(crate) fn new(base: String, mut swaps: Vec<(String, Option<String>)>) -> Self {
        if swaps.is_empty() {
            return Self {
                id: base.clone(),
                base,
                swaps,
            };
        }
        use sha2::{Digest, Sha256};
        swaps.sort();
        let mut hash = Sha256::new();
        hash.update(format!("plyloft-held\0{base}\0").as_bytes());
        for (path, tree) in &swaps {
            hash.update(format!("{path}\0{}\0", tree.as_deref().unwrap_or("-")).as_bytes());
        }
        Self {
            id: format!("{:x}", hash.finalize()),
            base,
            swaps,
        }
    }
}

/// The snapshot of `unit` under `root`: stamped, reused when it is there,
/// built from git objects when it is not.
fn snapshot(
    clone: &Path,
    unit: &Unit,
    root: &Path,
    options: Options,
    built: &mut usize,
) -> Result<Snapshot, String> {
    let tree = unit.id.as_str();
    let short = tree.get(..16).ok_or_else(|| format!("unusable tree id `{tree}`"))?;
    // Named by 16 hex digits to keep Windows paths short. Two trees sharing
    // them (2^-64 per pair, but silent if it ever happened) is caught by the
    // full id the snapshot records: the newcomer takes its full id as name.
    let found = read_meta(&root.join(short));
    let collides = found
        .as_ref()
        .and_then(|meta| meta.tree.as_deref())
        .is_some_and(|built_from| built_from != tree);
    let name = if collides { tree } else { short };
    let dest = root.join(name);
    // Stamped before the snapshot is looked for (the `session_plugin_dir`
    // rule): one found whole a moment ago with a thirty-day-old stamp is
    // exactly what another launch's prune would remove.
    // A stamp written within the last hour is left as it is: both prunes
    // count in days (30 days unstamped; the cap spares the last 24 hours), and
    // rewriting 200 stamps would be most of an unchanged launch's cost.
    let stamp = root.join(format!("{name}.last-used"));
    let fresh = std::fs::metadata(&stamp)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|at| at.elapsed().ok())
        .is_some_and(|age| age < STAMP_FRESH);
    if !fresh {
        crate::atomic::write_atomic_text(&stamp, &crate::shared_config::now_millis().to_string())
            .map_err(|error| format!("stamp {}: {error}", stamp.display()))?;
    }
    let meta = if dest.is_dir() && !collides {
        found
    } else if dest.is_dir() {
        read_meta(&dest)
    } else {
        build(clone, unit, root, &dest, options)?;
        *built += 1;
        read_meta(&dest)
    };
    let skipped = meta.unwrap_or_default().skipped;
    Ok(Snapshot { dir: dest, skipped })
}

/// One file of a tree, as `git ls-tree -r -l` lists it.
pub(crate) struct TreeFile {
    pub path: String,
    pub id: String,
    pub size: u64,
    pub executable: bool,
}

/// Lay `unit`'s files down under `dest`, aside and renamed in.
fn build(clone: &Path, unit: &Unit, root: &Path, dest: &Path, options: Options) -> Result<(), String> {
    let tree = unit.id.as_str();
    // The base tree without the swapped directories, then each swap's tree
    // under its path.
    let mut listings: Vec<(String, Vec<u8>)> =
        vec![(String::new(), git(clone, &["ls-tree", "-r", "-z", "-l", &unit.base])?)];
    for (path, swap) in &unit.swaps {
        if let Some(swap) = swap {
            listings.push((path.clone(), git(clone, &["ls-tree", "-r", "-z", "-l", swap])?));
        }
    }
    let mut files: Vec<TreeFile> = Vec::new();
    let mut total = 0u64;
    for (prefix, listing) in &listings {
        for record in listing.split(|byte| *byte == 0).filter(|record| !record.is_empty()) {
            let record = String::from_utf8_lossy(record);
            let (meta, path) = record
                .split_once('\t')
                .ok_or_else(|| format!("unexpected ls-tree line `{record}`"))?;
            let mut fields = meta.split_whitespace();
            let (mode, kind, id, size) = (fields.next(), fields.next(), fields.next(), fields.next());
            let (Some(mode), Some(kind), Some(id)) = (mode, kind, id) else {
                return Err(format!("unexpected ls-tree line `{record}`"));
            };
            let path = format!("{prefix}{path}");
            let path = path.as_str();
            if prefix.is_empty() && unit.swaps.iter().any(|(swapped, _)| path.starts_with(swapped.as_str())) {
                continue;
            }
            match (mode, kind) {
                ("100644" | "100755", "blob") => {}
                // The rule every other copy in this app follows
                // (`project_skills::read_tree`): a link could point anywhere on
                // the member's Mac, so the plugin is not delivered.
                ("120000", _) => return Err(format!("it carries a symbolic link at `{path}`")),
                // A submodule's commit has no files here; nothing a CLI reads.
                (_, "commit") => continue,
                _ => return Err(format!("unexpected entry `{mode} {kind}` at `{path}`")),
            }
            // A tree is whatever a teammate pushed, and `scratch.join(path)` with a
            // `..` (or, on Windows, a `\` or a drive `:`) would write outside the
            // snapshot. `git checkout` refuses such a tree; so does this.
            if !is_safe_tree_path(path) {
                return Err(format!("it carries an unusable path `{path}`"));
            }
            let size: u64 = size.and_then(|size| size.parse().ok()).unwrap_or(0);
            total += size;
            if total > PLUGIN_MAX_BYTES {
                return Err(format!(
                    "its files pass {} MB, so it is not delivered",
                    PLUGIN_MAX_BYTES / (1024 * 1024)
                ));
            }
            files.push(TreeFile {
                path: path.to_string(),
                id: id.to_string(),
                size,
                executable: mode == "100755",
            });
        }
    }

    // §8: a skill any of whose files would pass the limit is left out, and
    // named; anything else too long (a manifest) costs the snapshot.
    let mut skipped: BTreeSet<String> = BTreeSet::new();
    if let Some(limit) = options.path_limit {
        for file in &files {
            if path_units(&dest.join(&file.path)) <= limit {
                continue;
            }
            match skill_of(&file.path) {
                Some(skill) => {
                    skipped.insert(skill.to_string());
                }
                None => return Err(format!("`{}`: {PATH_TOO_LONG}", file.path)),
            }
        }
        files.retain(|file| skill_of(&file.path).is_none_or(|skill| !skipped.contains(skill)));
    }

    let blobs = cat_blobs(clone, &files)?;
    let scratch = root.join(format!(".build-{}", uuid::Uuid::new_v4().simple()));
    let written = (|| -> Result<(), String> {
        for (file, bytes) in files.iter().zip(blobs.iter()) {
            write_file(&scratch.join(&file.path), bytes, file.executable)?;
        }
        std::fs::create_dir_all(&scratch).map_err(|error| format!("create {}: {error}", scratch.display()))?;
        let meta = SnapshotMeta {
            tree: Some(tree.to_string()),
            skipped: skipped.iter().cloned().collect(),
        };
        let bytes = serde_json::to_vec_pretty(&meta).unwrap_or_default();
        write_file(&scratch.join(SNAPSHOT_META), &bytes, false)?;
        Ok(())
    })();
    if written.is_err() || crate::platform::rename(&scratch, dest).is_err() {
        let _ = std::fs::remove_dir_all(&scratch);
        written?;
        // Another launch put the same snapshot in place first: identical.
        if !dest.is_dir() {
            return Err(format!("could not put the snapshot in place at {}", dest.display()));
        }
    }
    Ok(())
}

/// Whether a path `git ls-tree` printed stays inside the directory it is
/// joined onto, on every platform: plain components only.
pub(crate) fn is_safe_tree_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && path.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.contains('\\')
                && !part.contains(':')
                && !part.contains('\0')
        })
}

/// The skill a tree path belongs to: `skills/<name>/…` (a Claude plugin) →
/// `<name>`; `plugins/<plugin>/skills/<name>/…` (a Codex marketplace) →
/// `<plugin>/skills/<name>`, so the Codex half skips one skill, not the whole
/// marketplace ([`codex_skill_label`] names it).
fn skill_of(path: &str) -> Option<&str> {
    if let Some(rest) = path.strip_prefix("skills/") {
        let (name, _) = rest.split_once('/')?;
        return Some(name);
    }
    let rest = path.strip_prefix("plugins/")?;
    let (plugin, inner) = rest.split_once('/')?;
    let (name, _) = inner.strip_prefix("skills/")?.split_once('/')?;
    if plugin.is_empty() || name.is_empty() {
        return None;
    }
    Some(&rest[..plugin.len() + "/skills/".len() + name.len()])
}

/// A Codex half's skipped skill (`<plugin>/skills/<name>`) as its reason
/// names it: "`<name>` in library/codex/plugins/<plugin>".
fn codex_skill_label(skill: &str) -> String {
    match skill.split_once("/skills/") {
        Some((plugin, name)) => format!("`{name}` in library/codex/plugins/{plugin}"),
        None => format!("`{skill}` in library/codex"),
    }
}

/// A path's length as Windows counts it (UTF-16 units).
fn path_units(path: &Path) -> usize {
    path.to_string_lossy().encode_utf16().count()
}

/// §8, before a write (H10 Windows walk): the path a library file at
/// `library_path` (`library/claude/<plugin>/…` or `library/codex/…`) gets
/// in a session snapshot under `config_dir`, and its length in UTF-16
/// units — what [`snapshot`] measures against [`WINDOWS_PATH_LIMIT`]. The
/// snapshot's directory is named by 16 hex digits.
pub(crate) fn delivered_path(config_dir: &Path, clone: &Path, library_path: &str) -> Option<(PathBuf, usize)> {
    let (half, rel) = if let Some(rest) = library_path.strip_prefix("library/claude/") {
        (Half::Claude, rest.split_once('/')?.1)
    } else {
        (Half::Codex, library_path.strip_prefix("library/codex/")?)
    };
    let path = sessions_root(config_dir)
        .join(library_key(clone))
        .join(half.dir())
        .join("0123456789abcdef")
        .join(rel);
    let units = path_units(&path);
    Some((path, units))
}

/// The skills of the clone's `HEAD` that a snapshot on this computer leaves
/// out as [`PATH_TOO_LONG`] (empty where paths aren't limited), by skill
/// directory name: the row says so (H10 Windows walk).
pub(crate) fn skills_too_long_here(config_dir: &Path, clone: &Path, options: Options) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let Some(limit) = options.path_limit else { return out };
    let Ok(listed) = git(clone, &["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", "library"]) else {
        return out;
    };
    for path in listed.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        let path = String::from_utf8_lossy(path);
        let Some((_, units)) = delivered_path(config_dir, clone, &path) else { continue };
        if units <= limit {
            continue;
        }
        let rel = path
            .strip_prefix("library/claude/")
            .and_then(|r| r.split_once('/').map(|(_, r)| r))
            .or_else(|| path.strip_prefix("library/codex/"));
        if let Some(skill) = rel.and_then(skill_of) {
            out.insert(skill.rsplit('/').next().unwrap_or(skill).to_string());
        }
    }
    out
}

/// Every file's bytes, in order, from one `git cat-file --batch`.
pub(crate) fn cat_blobs(clone: &Path, files: &[TreeFile]) -> Result<Vec<Vec<u8>>, String> {
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let mut ids = tempfile::tempfile().map_err(|error| format!("object list: {error}"))?;
    for file in files {
        writeln!(ids, "{}", file.id).map_err(|error| format!("object list: {error}"))?;
    }
    ids.rewind().map_err(|error| format!("object list: {error}"))?;
    let mut cmd = git_cmd(clone);
    cmd.args(["cat-file", "--batch"]);
    let out = crate::worktrees::run_bounded_output_with_stdin(&mut cmd, GIT_TIMEOUT, ids)
        .map_err(|failure| format!("git cat-file: {failure:?}"))?;
    if !out.status.success() {
        return Err(format!(
            "git cat-file failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let mut rest: &[u8] = &out.stdout;
    let mut blobs = Vec::with_capacity(files.len());
    for file in files {
        let newline = rest
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or("git cat-file: truncated answer")?;
        let header = String::from_utf8_lossy(&rest[..newline]).into_owned();
        let mut parts = header.split(' ');
        let (id, kind, size) = (parts.next(), parts.next(), parts.next());
        if id != Some(file.id.as_str()) || kind != Some("blob") {
            return Err(format!("git cat-file: unexpected `{header}` for {}", file.path));
        }
        let size: usize = size
            .and_then(|size| size.parse().ok())
            .ok_or_else(|| format!("git cat-file: unexpected `{header}`"))?;
        if size as u64 != file.size {
            return Err(format!("git cat-file: {} changed size", file.path));
        }
        let start = newline + 1;
        let end = start + size;
        if rest.len() < end + 1 {
            return Err("git cat-file: truncated answer".to_string());
        }
        blobs.push(rest[start..end].to_vec());
        rest = &rest[end + 1..];
    }
    Ok(blobs)
}

fn write_file(path: &Path, bytes: &[u8], executable: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    std::fs::write(path, bytes).map_err(|error| format!("write {}: {error}", path.display()))?;
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(())
}

// ── git ──────────────────────────────────────────────────────────────

fn git_cmd(clone: &Path) -> std::process::Command {
    let mut cmd = crate::platform::git_command();
    cmd.current_dir(clone)
        .env("GIT_TERMINAL_PROMPT", "0")
        // A clone's own config could name a pager or an fsmonitor hook;
        // nothing here needs either.
        .env("GIT_PAGER", "cat")
        .args(["-c", "core.fsmonitor=false"])
        .args(crate::team::library_git_config(clone));
    cmd
}

pub(crate) fn git(clone: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = git_cmd(clone);
    cmd.args(args);
    let out = crate::worktrees::run_bounded_output(&mut cmd, GIT_TIMEOUT)
        .map_err(|failure| format!("git {}: {failure:?}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out.stdout)
}

/// [`git`] with `env` set for the child (Skills hub H8: a staged commit
/// with fixed dates, so the same files stage as the same commit).
pub(crate) fn git_with_env(clone: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<Vec<u8>, String> {
    let mut cmd = git_cmd(clone);
    cmd.args(args);
    for (key, value) in env {
        cmd.env(key, value);
    }
    let out = crate::worktrees::run_bounded_output(&mut cmd, GIT_TIMEOUT)
        .map_err(|failure| format!("git {}: {failure:?}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out.stdout)
}

/// `git <args>` in `clone` with `input` on its standard input (a
/// `--batch-check` list, say), bounded like [`git`].
pub(crate) fn git_with_stdin(clone: &Path, args: &[&str], input: &[u8]) -> Result<Vec<u8>, String> {
    let mut file = tempfile::tempfile().map_err(|error| format!("git input: {error}"))?;
    file.write_all(input).map_err(|error| format!("git input: {error}"))?;
    file.rewind().map_err(|error| format!("git input: {error}"))?;
    let mut cmd = git_cmd(clone);
    cmd.args(args);
    let out = crate::worktrees::run_bounded_output_with_stdin(&mut cmd, GIT_TIMEOUT, file)
        .map_err(|failure| format!("git {}: {failure:?}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out.stdout)
}

/// The commit `HEAD` names now.
pub(crate) fn head_commit(clone: &Path) -> Result<String, String> {
    let out = git(clone, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?;
    let commit = String::from_utf8_lossy(&out).trim().to_string();
    if commit.len() < 40 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("unexpected HEAD `{commit}`"));
    }
    Ok(commit)
}

/// The sub-trees directly under `dir/` (which ends with `/`) at `commit`.
fn child_trees(clone: &Path, commit: &str, dir: &str) -> Result<Vec<(String, String)>, String> {
    let out = git(clone, &["ls-tree", "-z", commit, "--", dir])?;
    let mut trees = Vec::new();
    for record in out.split(|byte| *byte == 0).filter(|record| !record.is_empty()) {
        let record = String::from_utf8_lossy(record);
        let Some((meta, path)) = record.split_once('\t') else {
            continue;
        };
        let mut fields = meta.split_whitespace();
        let (_mode, kind, id) = (fields.next(), fields.next(), fields.next());
        if kind != Some("tree") {
            continue;
        }
        let (Some(id), Some(name)) = (id, path.strip_prefix(dir)) else {
            continue;
        };
        trees.push((name.to_string(), id.to_string()));
    }
    trees.sort();
    Ok(trees)
}

/// The tree `path` names at `commit`, if it is one.
pub(crate) fn entry_tree(clone: &Path, commit: &str, path: &str) -> Result<Option<String>, String> {
    let out = git(clone, &["ls-tree", "-z", commit, "--", path])?;
    for record in out.split(|byte| *byte == 0).filter(|record| !record.is_empty()) {
        let record = String::from_utf8_lossy(record);
        let Some((meta, name)) = record.split_once('\t') else {
            continue;
        };
        let mut fields = meta.split_whitespace();
        let (_mode, kind, id) = (fields.next(), fields.next(), fields.next());
        if name == path && kind == Some("tree") {
            return Ok(id.map(str::to_string));
        }
    }
    Ok(None)
}

// ── Size cap ─────────────────────────────────────────────────────────

/// Keep a library's snapshots (both halves under `key_dir`) within `cap`
/// bytes: past it, remove the least recently stamped first, never one stamped
/// within `grace`. Removal renames the directory aside first, so a snapshot
/// Windows will not let go of (a file a process holds open) is skipped whole
/// and retried at the next build, rather than left half removed under a name
/// a launch would reuse.
pub(crate) fn prune_to_cap(key_dir: &Path, cap: u64, grace: Duration) {
    struct Build {
        dir: PathBuf,
        stamp: PathBuf,
        stamped: Option<std::time::SystemTime>,
        bytes: u64,
    }
    let mut builds: Vec<Build> = Vec::new();
    for half in [Half::Claude, Half::Codex] {
        let root = key_dir.join(half.dir());
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let stamp = root.join(format!("{name}.last-used"));
            let stamped = std::fs::metadata(&stamp).and_then(|meta| meta.modified()).ok();
            builds.push(Build {
                bytes: dir_bytes(&entry.path()),
                dir: entry.path(),
                stamp,
                stamped,
            });
        }
    }
    let mut total: u64 = builds.iter().map(|build| build.bytes).sum();
    if total <= cap {
        return;
    }
    // Oldest stamp first; an unstamped build (its launch died) before any.
    builds.sort_by_key(|build| build.stamped);
    let now = std::time::SystemTime::now();
    for build in builds {
        if total <= cap {
            break;
        }
        // Re-read: a launch may have stamped it since the listing.
        let stamped = std::fs::metadata(&build.stamp)
            .and_then(|meta| meta.modified())
            .ok()
            .or(build.stamped);
        let recent = stamped
            .and_then(|stamped| now.duration_since(stamped).ok())
            .is_none_or(|age| age < grace);
        if recent && stamped.is_some() {
            continue;
        }
        if remove_aside(&build.dir) {
            let _ = std::fs::remove_file(&build.stamp);
            total = total.saturating_sub(build.bytes);
        }
    }
}

/// The age prune for every library under `sessions` but `current`: each
/// half's snapshots unstamped for `keep` (and old half-builds) are removed.
/// Directories themselves stay — removing one could race a launch that just
/// created it.
pub(crate) fn prune_other_libraries(sessions: &Path, current: &str, keep: Duration) {
    let Ok(entries) = std::fs::read_dir(sessions) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() == current
            || !entry.file_type().is_ok_and(|kind| kind.is_dir())
        {
            continue;
        }
        for half in [Half::Claude, Half::Codex] {
            crate::shared_library_sync::prune_session_plugins(&entry.path().join(half.dir()), keep);
        }
    }
}

/// Rename aside, then remove. `false` when Windows refused the rename (a file
/// held open): nothing was touched.
pub(crate) fn remove_aside(dir: &Path) -> bool {
    let Some(parent) = dir.parent() else {
        return false;
    };
    let aside = parent.join(format!(".trash-{}", uuid::Uuid::new_v4().simple()));
    if std::fs::rename(dir, &aside).is_err() {
        return false;
    }
    let _ = std::fs::remove_dir_all(&aside);
    true
}

fn dir_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => dir_bytes(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

// ── What each live session was given (R13) ───────────────────────────

/// PTY id → the libraries that session was given. In memory only.
fn sessions() -> &'static parking_lot::Mutex<HashMap<String, Vec<LibraryRecord>>> {
    static SESSIONS: OnceLock<parking_lot::Mutex<HashMap<String, Vec<LibraryRecord>>>> =
        OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}

/// Remember what the session `id` was given. Nothing for a session given no
/// library skill.
pub(crate) fn register(id: &str, records: Vec<LibraryRecord>) {
    if records.iter().all(|record| record.plugins.iter().all(|plugin| plugin.skills.is_empty())) {
        return;
    }
    sessions().lock().insert(id.to_string(), records);
}

/// The session `id` ended.
pub(crate) fn forget(id: &str) {
    sessions().lock().remove(id);
}

/// The skills the session `id` was given that changed in their library since
/// it started — sorted, each named once. Empty for a session that is not
/// known, was given none, or whose library has not moved.
pub(crate) fn drift(id: &str) -> Vec<String> {
    let Some(records) = sessions().lock().get(id).cloned() else {
        return Vec::new();
    };
    let mut changed = BTreeSet::new();
    for record in &records {
        let head = match cached_head(&record.clone) {
            Ok(head) => head,
            Err(error) => {
                log::debug!("skills hub: drift unknown ({error})");
                continue;
            }
        };
        if head == record.commit {
            continue;
        }
        match changed_paths(&record.clone, &record.commit, &head) {
            Ok(paths) => changed.extend(changed_skills(record, &paths)),
            Err(error) => log::debug!("skills hub: drift unknown ({error})"),
        }
    }
    changed.into_iter().collect()
}

/// Of `paths` (changed in the library), the skills `record` delivered.
pub(crate) fn changed_skills(record: &LibraryRecord, paths: &[String]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for path in paths {
        for plugin in &record.plugins {
            let Some(rest) = path
                .strip_prefix(plugin.prefix.as_str())
                .and_then(|rest| rest.strip_prefix("/skills/"))
            else {
                continue;
            };
            let skill = rest.split('/').next().unwrap_or_default();
            if plugin.skills.iter().any(|name| name == skill) {
                out.insert(skill.to_string());
            }
        }
    }
    out
}

/// How long one answer of `HEAD` is reused: every tile asks every few
/// seconds, and one `git rev-parse` per clone per window is enough.
const HEAD_TTL: Duration = Duration::from_secs(3);

fn cached_head(clone: &Path) -> Result<String, String> {
    static HEADS: OnceLock<parking_lot::Mutex<HashMap<PathBuf, (Instant, String)>>> = OnceLock::new();
    let heads = HEADS.get_or_init(Default::default);
    if let Some((at, head)) = heads.lock().get(clone) {
        if at.elapsed() < HEAD_TTL {
            return Ok(head.clone());
        }
    }
    let head = head_commit(clone)?;
    heads.lock().insert(clone.to_path_buf(), (Instant::now(), head.clone()));
    Ok(head)
}

/// The library paths that differ between two commits, cached per pair (a
/// pair's answer never changes).
fn changed_paths(clone: &Path, from: &str, to: &str) -> Result<Vec<String>, String> {
    type Key = (PathBuf, String, String);
    static DIFFS: OnceLock<parking_lot::Mutex<HashMap<Key, Vec<String>>>> = OnceLock::new();
    let diffs = DIFFS.get_or_init(Default::default);
    let key = (clone.to_path_buf(), from.to_string(), to.to_string());
    if let Some(paths) = diffs.lock().get(&key) {
        return Ok(paths.clone());
    }
    let out = git(
        clone,
        &["diff", "--no-renames", "--name-only", "-z", from, to, "--", "library/"],
    )?;
    let paths: Vec<String> = out
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect();
    let mut diffs = diffs.lock();
    if diffs.len() > 64 {
        diffs.clear();
    }
    diffs.insert(key, paths.clone());
    Ok(paths)
}

#[cfg(test)]
#[path = "library_snapshot_tests.rs"]
mod tests;
