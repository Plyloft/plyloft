//! GH #106 (ADR 0005, `docs/ux-language/boards/BOARDS.md` §3 `Comes with Ply`,
//! §6 "A Ply skill") — the skills that ship inside the app.
//!
//! Four plain files live in the bundle at `resources/ply-skills/<name>/SKILL.md`
//! and are reviewed like code. The ones switched on reach **every session Ply
//! launches**, and they travel exactly the way team skills do, because that
//! mechanism is already measured against both CLIs
//! ([`crate::team_skills`], `docs/team-sharing/PLAN.md` Rung 3):
//!
//! - Claude takes a plugin directory as `--plugin-dir`;
//! - Codex has no session-scoped flag at all, so it takes a whole `CODEX_HOME`
//!   with a local marketplace registered in it ([`crate::codex_home`]).
//!
//! So rather than a second delivery path with its own guards, a launch builds a
//! directory in **the team library's own layout** (`library/claude/ply/` and
//! `library/codex/`) and hands it to [`crate::team_skills::read_library`]. One
//! reader answers "what does a session of this vendor load", for the team
//! library and for Ply's own skills, and the two can never drift on the plugin
//! format, the frontmatter rules or the hook refusal.
//!
//! **Content-named, like the `project` plugin.** The build directory is named
//! by a digest of every file that goes into it, so two launches with the same
//! switched-on set reuse one directory and an app update that changes a skill's
//! text simply produces a different name — nothing has to be invalidated. Old
//! builds are bounded: each launch stamps the one it used and
//! [`crate::shared_library_sync::prune_session_plugins`] removes the ones no
//! launch has stamped for thirty days, the rule the project plugin already
//! follows.
//!
//! **Nothing is written into the user's own CLI folders or into the
//! repository.** The bundle is read-only, the build lives under Ply's app
//! config directory, and the Codex overlay links the member's `~/.codex`
//! instead of editing it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::platform::THIS_MACHINE;
use crate::team_skills::TeamSkillsLibrary;

/// The plugin both CLIs namespace these skills under, so a session lists them
/// as `ply:card-brief`.
pub const PLUGIN_NAME: &str = "ply";

/// The marketplace Codex registers to find that plugin.
///
/// **Not** the plugin's name (review 1). A marketplace name is a key in the
/// member's own `config.toml` and a directory in their plugin cache, so a common
/// word collides: a member — or a team — with a `ply` marketplace of their own
/// would cost Ply's skills their delivery. `ply-app` is a name nothing else
/// plausibly takes, and it changes nothing a session sees, because the
/// `ply:<name>` namespace comes from the plugin.
pub const MARKETPLACE_NAME: &str = "ply-app";

/// What Codex shows the marketplace as (`interface.displayName`), the way
/// `team_skills` names the team's.
const MARKETPLACE_DISPLAY_NAME: &str = "Plyloft's own skills";

/// How a refusal names this marketplace, so a member reads which of the two
/// layers in one overlay it is about (review 2). `read_library` is written for
/// the team library and labels what it reads as the team's, so the one built here
/// is relabelled after it comes back.
const MARKETPLACE_LABEL: &str = "Plyloft's own marketplace";

/// The bundled directory, inside the app's resources
/// (`tauri.conf.json` → `bundle.resources`).
pub const BUNDLE_DIR: &str = "ply-skills";

/// Skills hub H9 (§5.5): each skill's versions, newest first, beside the
/// skills in the bundle. A file, so `read_bundle` (directories only) never
/// takes it for a skill.
pub const CHANGES_FILE: &str = "CHANGES.json";

/// …and every listed version's text, `ply-skills-history/<name>/<version>/`
/// (`tauri.conf.json` → `bundle.resources`).
pub const HISTORY_DIR: &str = "ply-skills-history";

/// Where built libraries live under the app config directory.
pub const BUILDS_DIR: &str = "ply_skills_builds";

/// A plugin version is a path component in Codex's plugin cache, so it needs
/// one; the skills are versioned by the app, and the digest in the directory
/// name is what actually distinguishes two builds.
const PLUGIN_VERSION: &str = "1.0.0";

/// How long a build nothing has launched from is kept — the project plugin's
/// own window (`shared_library_sync::SESSION_PLUGIN_KEEP`).
const KEEP: Duration = Duration::from_secs(30 * 24 * 3600);

/// One skill the app ships.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlySkill {
    /// Its directory name, which is its identity in both CLIs (`card-brief`).
    pub name: String,
    /// The `SKILL.md`'s own first level-one heading — the row's plain name and
    /// the page's title (BOARDS.md §3, §6). The file is the one source: a title
    /// kept in a table beside it would be a second place to forget.
    pub title: String,
    /// Never absent: a `SKILL.md` with no `description` is not a skill either
    /// CLI loads, so it is never listed.
    pub description: String,
    /// Skills hub H9 (R9): its versions, newest first, out of
    /// [`CHANGES_FILE`]. Empty on a build from before it.
    pub changes: Vec<SkillChange>,
}

impl PlySkill {
    /// The Plyloft version that last changed it (`v1.155.0` on its row).
    pub fn version(&self) -> Option<&str> {
        self.changes.first().map(|change| change.version.as_str())
    }
}

/// One entry of [`CHANGES_FILE`]: the Plyloft version that changed a skill,
/// the content id (git tree id) it has from then on, and one line on what
/// changed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillChange {
    pub version: String,
    #[serde(default)]
    pub content_id: String,
    #[serde(default)]
    pub summary: String,
}

/// Every skill's versions, newest first. An absent file (an app build from
/// before H9) or one this build can't read lists none: the rows then show no
/// version, which is the truth of what this build knows.
pub fn read_changes(bundle: &Path) -> std::collections::BTreeMap<String, Vec<SkillChange>> {
    let Ok(bytes) = std::fs::read(bundle.join(CHANGES_FILE)) else {
        return Default::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        log::warn!("ply skills: {CHANGES_FILE} is not readable ({error})");
        Default::default()
    })
}

/// A listed version's text, from the bundle's history (`None` when this
/// build has no copy of it).
pub fn history_files(history: &Path, name: &str, version: &str) -> Option<Vec<crate::project_skills::TreeFile>> {
    if crate::project_skills::safe_name(name).ok().as_deref() != Some(name)
        || version.is_empty()
        || !version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return None;
    }
    crate::project_skills::read_tree(&history.join(name).join(version)).ok()
}

/// The history directory beside the bundle (`resource_dir()/ply-skills-history`,
/// or the source tree's in a debug build), as [`bundle_dir`] finds the bundle.
pub fn history_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    use tauri::Manager;
    if let Some(dir) = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join(HISTORY_DIR))
        .filter(|dir| dir.is_dir())
    {
        return Some(dir);
    }
    #[cfg(debug_assertions)]
    {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(HISTORY_DIR);
        if source.is_dir() {
            return Some(source);
        }
    }
    None
}

/// The bundled directory on this Mac, or `None` when the app has no copy of it.
///
/// `resource_dir()` answers both shapes Ply runs in: inside the `.app` it is
/// `Contents/Resources`, and in `tauri dev` it is the Cargo output directory,
/// into which `tauri-build`'s build script copies `bundle.resources` at compile
/// time. The fallback below is for the third shape — a plain `cargo run` or a
/// test binary, where no build script copy is beside the executable — so a
/// developer never silently loses the skills and has to wonder why.
pub fn bundle_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    use tauri::Manager;
    if let Some(dir) = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join(BUNDLE_DIR))
        .filter(|dir| dir.is_dir())
    {
        return Some(dir);
    }
    #[cfg(debug_assertions)]
    {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(BUNDLE_DIR);
        if source.is_dir() {
            return Some(source);
        }
    }
    log::debug!("ply skills: no bundled ply-skills directory on {}", crate::platform::THIS_MACHINE);
    None
}

/// Every skill the bundle offers, sorted by name.
///
/// A directory neither CLI would load is not a skill and is simply absent, the
/// rule [`crate::team_skills::read_skill_dir`] applies at every other scope. A
/// bundle is reviewed like code, so a failure here is a bug in Ply rather than
/// something a member can fix — it is logged, and the rest still load.
pub fn read_bundle(dir: &Path) -> Vec<PlySkill> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        log::debug!("ply skills: {} could not be read", dir.display());
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| !name.starts_with('.'))
        })
        .collect();
    dirs.sort();

    let mut errors = Vec::new();
    let mut out = Vec::new();
    let changes = read_changes(dir);
    for skill_dir in dirs {
        let Some(loaded) = crate::team_skills::read_skill_dir(&skill_dir, &mut errors) else {
            continue;
        };
        let text = std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap_or_default();
        out.push(PlySkill {
            title: first_heading(&text).unwrap_or_else(|| loaded.dir.clone()),
            changes: changes.get(&loaded.dir).cloned().unwrap_or_default(),
            name: loaded.dir,
            description: loaded.description,
        });
    }
    for error in &errors {
        log::warn!("ply skills: {error}");
    }
    out
}

/// A `SKILL.md`'s first level-one heading, with its `#` and spacing removed.
///
/// Deliberately not a Markdown parser: the bundle's own files are the only
/// input, and a heading that is not there falls back to the directory name
/// rather than failing anything.
fn first_heading(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("# "))
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
}

/// G2 (1.173.0, owner decision 6): a skill that answers to a second name,
/// as `(alias, skill)`. The alias ships beside the skill, word for word, so a
/// session finds either name; it has no row of its own (`Delivery::bundle`,
/// `skills_index::read_plyloft`) and is switched on and off with its skill.
pub const ALIASES: &[(&str, &str)] = &[("answer-the-reviewer", "answer-the-challenger")];

/// Whether `name` is another name of a bundled skill (no row of its own).
pub fn is_alias(name: &str) -> bool {
    ALIASES.iter().any(|(alias, _)| *alias == name)
}

/// The other name of `name` — its alias, or the skill an alias names.
pub fn other_name(name: &str) -> Option<&'static str> {
    ALIASES.iter().find_map(|(alias, skill)| {
        if *alias == name {
            Some(*skill)
        } else if *skill == name {
            Some(*alias)
        } else {
            None
        }
    })
}

/// Whether `name` is switched off by `off`: it, or its other name, is listed.
pub fn is_off(name: &str, off: &[String]) -> bool {
    off.iter().any(|n| n == name || other_name(name).is_some_and(|other| n == other))
}

/// The skills a session gets, given the names switched **off** on this Mac.
///
/// Off rather than on is what `settings.json` stores, so a settings file
/// written before a skill shipped — and a fresh one — has it on
/// (`settings::LibrarySettings::ply_skills_off`). A skill and its alias are
/// off together ([`ALIASES`]).
pub fn switched_on<'a>(skills: &'a [PlySkill], off: &[String]) -> Vec<&'a PlySkill> {
    skills
        .iter()
        .filter(|skill| !is_off(&skill.name, off))
        .collect()
}

/// The bundle's rows: every skill but the aliases, which follow their skill.
pub fn rows(skills: Vec<PlySkill>) -> Vec<PlySkill> {
    skills.into_iter().filter(|skill| !is_alias(&skill.name)).collect()
}

/// What a session of either vendor loads from Ply's own skills, and — when it
/// loads nothing it was meant to — why.
#[derive(Debug, Default)]
pub struct Delivery {
    /// Every skill the bundle offers, switched on or off — the rows of the
    /// `Comes with Ply` section.
    ///
    /// Carried here because preparing the delivery had to read the bundle anyway
    /// (review 2). Deliberately **not** `library.skills`: that is what a session
    /// gets, so it holds no switched-off skill and no `title`, and a section built
    /// from it would lose the row a member needs in order to switch one back on.
    pub bundle: Vec<PlySkill>,
    pub library: TeamSkillsLibrary,
    /// Set only when there **were** skills to deliver and they could not be
    /// prepared. Surfaced once on the `Comes with Ply` section, the way the team
    /// layer surfaces a [`crate::team_skills::RefusedPlugin`] (review 1): a
    /// section that silently reaches nothing is worse than one that says so.
    ///
    /// `None` for the two ordinary silences — no bundle on this build, and every
    /// skill switched off — because neither is a fault.
    pub problem: Option<String>,
}

/// What a session of either vendor loads from Ply's own skills.
///
/// Empty — and so contributing no launch argument and no Codex overlay — when
/// the bundle is missing or every skill is switched off. That is the whole of
/// "off → not delivered": there is no plugin to hand over.
///
/// `root` is where builds live (`<app-config>/ply_skills_builds`).
///
/// `stamp` marks the build as one a launch is using, which is what keeps the prune
/// from removing it. Only a launch passes `true` (review 2): the Library reads
/// this on every open, and a read stamping a directory would keep alive a build no
/// session ever gets — an all-on build on a Mac with a skill switched off, for as
/// long as somebody keeps looking at the page.
pub fn deliver(root: &Path, bundle: &Path, off: &[String], stamp: bool) -> Delivery {
    let skills = read_bundle(bundle);
    let on = switched_on(&skills, off);
    if on.is_empty() {
        return Delivery {
            bundle: rows(skills),
            ..Delivery::default()
        };
    }
    let built = match build(root, bundle, &on, stamp) {
        Ok(dir) => dir,
        Err(error) => {
            log::warn!("ply skills: no build ({error})");
            crate::shared_library_sync::prune_session_plugins(root, KEEP);
            return Delivery {
                bundle: rows(skills),
                library: TeamSkillsLibrary::default(),
                problem: Some(error),
            };
        }
    };
    crate::shared_library_sync::prune_session_plugins(root, KEEP);
    let mut library = crate::team_skills::read_own_library(&built, MARKETPLACE_NAME);
    // Relabelled here, where it is known whose marketplace this is: `read_library`
    // is the team library's reader and calls everything it reads the team's.
    if let Some(marketplace) = library.codex.as_mut() {
        marketplace.label = MARKETPLACE_LABEL.to_string();
    }
    for error in &library.errors {
        log::warn!("ply skills: {error}");
    }
    for refused in &library.refused {
        log::warn!(
            "ply skills: {} refused for {}: {}",
            refused.plugin,
            refused.vendor.label(),
            refused.reason
        );
    }
    // A build that is there but that a CLI would not load is the other way this
    // can go wrong, and the reader has already said why.
    let problem = if library.is_empty() {
        Some(
            library
                .refused
                .first()
                .map(|refused| refused.reason.clone())
                .or_else(|| library.errors.first().cloned())
                .unwrap_or_else(|| {
                    format!("the skills that come with Plyloft could not be prepared on {THIS_MACHINE}")
                }),
        )
    } else {
        None
    };
    Delivery {
        bundle: rows(skills),
        library,
        problem,
    }
}

/// Lay the switched-on skills out as a team library, in a directory named by
/// their content, and return it.
///
/// The same digest for the same files, so two launches share one directory and
/// an app update that changes a skill's text lands in a new one. Built aside
/// and renamed in, so a launch reading it never sees half a build; a losing
/// race is fine because the other build is identical.
fn build(root: &Path, bundle: &Path, on: &[&PlySkill], stamp: bool) -> Result<PathBuf, String> {
    let files = layout(bundle, on)?;
    let digest = digest_of(&files);
    let dest = root.join(&digest);
    std::fs::create_dir_all(root).map_err(|error| format!("create {root:?}: {error}"))?;
    if !claude_plugin_of(&dest).is_file() {
        let scratch = root.join(format!(".build-{}", uuid::Uuid::new_v4().simple()));
        let written = files.iter().try_for_each(|file| write_file(&scratch, file));
        if written.is_err() || std::fs::rename(&scratch, &dest).is_err() {
            let _ = std::fs::remove_dir_all(&scratch);
            written?;
            // The rename lost a race with an identical build; if that is not
            // what happened, the directory is genuinely not there.
            if !claude_plugin_of(&dest).is_file() {
                return Err(format!("could not put the build in place at {dest:?}"));
            }
        }
    }
    // Tempfile plus rename (Hard rule 3), through the shared helper: a stamp torn
    // by a crash is a build the next prune cannot date, and `prune_session_plugins`
    // then treats it as a half-build and may remove a directory a live session is
    // reading. `session_plugin_dir` and `branch_codex_skills` stamp the same way.
    //
    // Only a launch stamps. An unstamped build is dated by its own directory and
    // goes within the hour, which is what an all-on build made only to draw the
    // section should do.
    if stamp {
        let path = root.join(format!("{digest}.last-used"));
        crate::atomic::write_atomic_text(&path, &crate::shared_config::now_millis().to_string())
            .map_err(|error| format!("stamp {path:?}: {error}"))?;
    }
    Ok(dest)
}

/// The manifest whose presence says a build is whole.
fn claude_plugin_of(dest: &Path) -> PathBuf {
    dest.join("library")
        .join("claude")
        .join(PLUGIN_NAME)
        .join(".claude-plugin")
        .join("plugin.json")
}

/// One file of a build: where it goes, what is in it, and whether it runs.
struct BuiltFile {
    path: String,
    bytes: Vec<u8>,
    /// Carried through from the bundle and applied on write (review 1). A skill
    /// may ship a helper script beside its `SKILL.md`, and a helper that arrives
    /// without its mode bit is a skill that fails the first time it is used —
    /// the same reason `shared_library_sync::session_plugin_dir` carries it.
    executable: bool,
}

/// Every file of the build, in the team library's layout, sorted by path.
///
/// Both vendors read the *same* `SKILL.md`; only the manifest around it
/// differs, so each skill's file is laid down twice and nothing about its text
/// is vendor-specific.
fn layout(bundle: &Path, on: &[&PlySkill]) -> Result<Vec<BuiltFile>, String> {
    let description = concat!("The skills that come with Plyloft, switched on on ", crate::this_machine!());
    let plugin_manifest = serde_json::json!({
        "name": PLUGIN_NAME,
        "description": description,
        "version": PLUGIN_VERSION,
    });
    // The shape `team_skills::write_marketplace_entry` writes, field for field
    // (review 1): Codex reads `interface.displayName` for the name it shows, and
    // resolves the plugin through `source` and `policy.installation`.
    let marketplace = serde_json::json!({
        "name": MARKETPLACE_NAME,
        "interface": { "displayName": MARKETPLACE_DISPLAY_NAME },
        "plugins": [{
            "name": PLUGIN_NAME,
            "source": { "source": "local", "path": format!("./plugins/{PLUGIN_NAME}") },
            "policy": { "installation": "AVAILABLE" },
        }],
    });
    let json = |path: String, value: &serde_json::Value| BuiltFile {
        path,
        bytes: serde_json::to_string_pretty(value)
            .unwrap_or_default()
            .into_bytes(),
        executable: false,
    };

    let claude_root = format!("library/claude/{PLUGIN_NAME}");
    let codex_root = format!("library/codex/plugins/{PLUGIN_NAME}");
    let mut files = vec![
        json(
            format!("{claude_root}/.claude-plugin/plugin.json"),
            &plugin_manifest,
        ),
        json(
            format!("{codex_root}/.codex-plugin/plugin.json"),
            &plugin_manifest,
        ),
        json(
            "library/codex/.agents/plugins/marketplace.json".to_string(),
            &marketplace,
        ),
    ];
    for skill in on {
        // `read_tree` refuses a symlink anywhere under the directory, which is
        // the rule every other copy in this app follows.
        for file in crate::project_skills::read_tree(&bundle.join(&skill.name))? {
            for root in [&claude_root, &codex_root] {
                files.push(BuiltFile {
                    path: format!("{root}/skills/{}/{}", skill.name, file.path),
                    bytes: file.bytes.clone(),
                    executable: file.executable,
                });
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// A name for exactly these bytes, at exactly these paths, with exactly these
/// modes.
///
/// The mode is hashed (review 1): a bundle whose only change is a helper becoming
/// executable is a different delivery, and a digest that ignored it would hand a
/// session the old directory for ever.
fn digest_of(files: &[BuiltFile]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for file in files {
        hasher.update(file.path.as_bytes());
        hasher.update([0, u8::from(file.executable)]);
        hasher.update((file.bytes.len() as u64).to_le_bytes());
        hasher.update(&file.bytes);
    }
    let digest = format!("{:x}", hasher.finalize());
    digest[..24].to_string()
}

/// Written aside and renamed in, so a reader never sees half a file
/// (Hard rule 3).
fn write_file(root: &Path, file: &BuiltFile) -> Result<(), String> {
    let path = root.join(&file.path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("create {parent:?}: {error}"))?;
    }
    let tmp = path.with_file_name(format!(
        ".{}.tmp-{}",
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&tmp, &file.bytes).map_err(|error| format!("write {tmp:?}: {error}"))?;
    // Set on the temporary file, so the name never exists without its mode.
    #[cfg(unix)]
    if file.executable {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    crate::platform::rename(&tmp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        format!("write {path:?}: {error}")
    })
}

#[cfg(test)]
#[path = "ply_skills_tests.rs"]
mod tests;
