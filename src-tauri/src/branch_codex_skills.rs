//! GH #156 — Codex sessions receive the integration branch's `.agents/skills`,
//! the way Claude receives the `project` plugin.
//!
//! Claude gets the branch's `.claude/skills` through
//! [`crate::shared_library_sync::session_plugin_dir`]: a `--plugin-dir` built at
//! launch out of the mirror. Codex has no session-scoped flag at all, so its
//! half travels the way team skills and Ply's own skills already do — as one
//! more **marketplace in the same `CODEX_HOME` overlay** ([`crate::codex_home`],
//! `docs/team-sharing/PLAN.md` Rung 3). This module builds that marketplace.
//!
//! **The names.** The plugin is `project`, the name Claude's plugin has, so a
//! Codex session lists a branch skill as `project:<name>` exactly as a Claude
//! session does. The marketplace is `ply-project`: a marketplace name is a key
//! in the member's own `config.toml` and a directory in their plugin cache, so
//! it must be one nothing else plausibly takes (the #106 review 1 rule that made
//! Ply's own `ply-app` rather than `ply`). A member who does have a
//! `ply-project` of their own costs only this layer — [`crate::codex_home::build_all`]
//! folds each marketplace on its own — and the Library's Codex chip is asked the
//! same question through [`preflight`].
//!
//! **What goes in.** Exactly the mirror's Codex copies
//! (`<build>/.agents/skills/<name>/`) that
//! [`crate::team_skills::read_skill_dir`] accepts — the one reader every other
//! scope uses to answer "would a CLI load this" — and that the session's own
//! directory does not already carry as the branch has it. The second rule is
//! Claude's (`checkout_lacks`): Codex reads the checkout's `.agents/skills`
//! natively from its cwd, so a copy that is already there identically would
//! only be listed twice. **Nothing is read from the checkout into the build**;
//! the checkout is only compared against. A skill removed on the branch is not
//! in the mirror, so it is not in the build.
//!
//! **Content-named, stamped only at launch.** The build directory is named by a
//! digest of every file in it, like `session_plugin_dir` and `ply_skills`, so
//! a directory is never changed while a session could be reading it; only a
//! launch builds one, and each launch stamps the one it used
//! (`<digest>.last-used`, atomically). Builds no launch has stamped for thirty
//! days go through [`crate::shared_library_sync::prune_session_plugins`]. The
//! Library never builds: its chip asks [`preflight`], which needs no files.
//!
//! **Nothing is written into the member's CLI folders or the repository.** The
//! build lives under `projects/<ws>/`, and the overlay links `~/.codex` rather
//! than editing it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::team_skills::{CodexMarketplace, CodexPlugin};

/// The plugin the branch's skills are namespaced under — Claude's own
/// (`shared_library_sync::PLUGIN_NAME`), so both CLIs say `project:<name>`.
pub const PLUGIN_NAME: &str = crate::shared_library_sync::PLUGIN_NAME;

/// The marketplace Codex registers to find that plugin. Not `project`: that is a
/// common word, and a member's marketplace of that name would cost the layer.
pub const MARKETPLACE_NAME: &str = "ply-project";

/// What Codex shows the marketplace as (`interface.displayName`).
const MARKETPLACE_DISPLAY_NAME: &str = "This project's skills on the integration branch";

/// How a refusal names this marketplace, so a member reads which of the layers
/// in one overlay it is about (#106 review 2's rule).
pub const MARKETPLACE_LABEL: &str = "the branch's project skills marketplace";

/// Where builds live, under `projects/<ws>/` — beside Claude's
/// `shared_skills_session_plugins`, and removed with it.
pub const BUILDS_DIR: &str = "shared_codex_skills_session_plugins";

/// A plugin version is a path component in Codex's plugin cache; the digest in
/// the directory name is what really distinguishes two builds.
const PLUGIN_VERSION: &str = "1.0.0";

/// `session_plugin_dir`'s window.
const KEEP: Duration = Duration::from_secs(30 * 24 * 3600);

/// The marketplace a launch would register, without building anything.
///
/// [`crate::codex_home::preflight`] reads only its name, its label and its
/// plugins' names, so the Library can ask "would a Codex session here get the
/// branch's skills" without writing a byte.
pub fn descriptor() -> CodexMarketplace {
    CodexMarketplace {
        root: PathBuf::new(),
        name: MARKETPLACE_NAME.to_string(),
        plugins: vec![CodexPlugin {
            name: PLUGIN_NAME.to_string(),
            version: PLUGIN_VERSION.to_string(),
            dir: PathBuf::new(),
        }],
        label: MARKETPLACE_LABEL.to_string(),
    }
}

/// Could a Codex session on this Mac get the branch's skills?
///
/// `Ok` when it could; the refusal a launch would log otherwise — including a
/// missing Codex home, which the caller decides whether to say.
pub fn preflight(real_home: &Path) -> Result<(), String> {
    crate::codex_home::preflight(real_home, &descriptor())
}

/// Whether the branch's Codex copies reach Codex sessions on this Mac, for the
/// Library's Codex chip (`LibraryState.branchCodex`).
///
/// `#[serde(default)]` on the field that carries it, so a state written by an
/// older build reads as "not delivered" — which is what it meant then.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    /// A Codex session Ply launches here gets the `ply-project` marketplace.
    pub reaches: bool,
    /// Why it would not, when that is a fault worth saying: a colliding
    /// marketplace or plugin, a config Ply cannot parse. `None` when it reaches,
    /// and also on a Mac with **no** Codex home — a member who does not use Codex
    /// has nothing wrong with their Mac (the rule `ply_skills_view` follows).
    pub refused: Option<String>,
}

/// [`Delivery`] for the member's Codex home at `real_home`. Writes nothing.
pub fn delivery(real_home: &Path) -> Delivery {
    delivery_of(real_home, &descriptor())
}

/// [`Delivery`] of any one marketplace — the branch's, or the team library's
/// for the Library's team rows (`ProjectSkillsView::team_codex`).
pub fn delivery_of(real_home: &Path, marketplace: &CodexMarketplace) -> Delivery {
    if !real_home.is_dir() {
        return Delivery::default();
    }
    match crate::codex_home::preflight(real_home, marketplace) {
        Ok(()) => Delivery {
            reaches: true,
            refused: None,
        },
        Err(reason) => Delivery {
            reaches: false,
            refused: Some(reason),
        },
    }
}

/// The mirror's Codex skills a session starting in `session_cwd` gets: loadable
/// on the branch, and not already in that directory as the branch has it.
/// Sorted by name.
pub fn skills_for(build: &Path, session_cwd: &Path) -> Vec<String> {
    use crate::skill_reach::Side;
    let Ok(entries) = std::fs::read_dir(build.join(Side::Codex.root())) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        // A dot directory is hidden from the plugin reader (`read_child_dirs`),
        // so it is never a skill a session gets.
        .filter(|name| !name.starts_with('.'))
        .filter(|name| crate::skill_reach::side_state(build, Side::Codex, name).loads())
        .filter(|name| checkout_lacks(session_cwd, build, name))
        .collect();
    names.sort();
    names
}

/// The session's directory has no Codex copy of `name`, or not the branch's.
fn checkout_lacks(cwd: &Path, build: &Path, name: &str) -> bool {
    use crate::skill_reach::{skill_dir, Side};
    let local = skill_dir(cwd, Side::Codex, name);
    if !local.exists() {
        return true;
    }
    match (
        crate::project_skills::read_tree(&local),
        crate::project_skills::read_tree(&skill_dir(build, Side::Codex, name)),
    ) {
        (Ok(local), Ok(branch)) => local != branch,
        _ => true,
    }
}

/// The marketplace a Codex session Ply starts in `session_cwd` gets, built now
/// and stamped as in use. `None` — no marketplace, so nothing for the overlay —
/// when there is no mirror, when it carries no Codex skill this session lacks,
/// or when the build could not be made (logged).
///
/// Only a launch calls this; see the module doc.
pub fn session_marketplace(workspace_dir: &Path, session_cwd: &Path) -> Option<CodexMarketplace> {
    let mirror = workspace_dir.join(ply_memory::SHARED_LIBRARY_MIRROR_DIR);
    let build = ply_memory::resolve_mirror(&mirror)?;
    let root = workspace_dir.join(BUILDS_DIR);
    let names = skills_for(&build, session_cwd);
    if names.is_empty() {
        crate::shared_library_sync::prune_session_plugins(&root, KEEP);
        return None;
    }
    let made = build_marketplace(&root, &build, &names);
    crate::shared_library_sync::prune_session_plugins(&root, KEEP);
    match made {
        Ok(marketplace) => marketplace,
        Err(error) => {
            log::warn!("shared_library: no Codex project skills for {session_cwd:?}: {error}");
            None
        }
    }
}

/// Lay `names` out as a team-library Codex half in a content-named directory,
/// stamp it, and read it back through the team library's reader.
fn build_marketplace(
    root: &Path,
    build: &Path,
    names: &[String],
) -> Result<Option<CodexMarketplace>, String> {
    let files = layout(build, names)?;
    let digest = digest_of(&files);
    let dest = root.join(&digest);
    std::fs::create_dir_all(root).map_err(|error| format!("create {root:?}: {error}"))?;
    // Stamped **before** the build is looked for (review 1). Another launch's
    // prune runs between any two lines here, and a build whose stamp is thirty
    // days old — found whole a moment ago — is exactly what it removes. Stamped
    // first, the build this launch is about to use is never "unused" to a prune
    // that runs after this line. Atomic (Hard rule 3): a torn stamp is a build
    // the prune cannot date.
    let stamp = root.join(format!("{digest}.last-used"));
    crate::atomic::write_atomic_text(&stamp, &crate::shared_config::now_millis().to_string())
        .map_err(|error| format!("stamp {stamp:?}: {error}"))?;
    if !whole(&dest) {
        let scratch = root.join(format!(".build-{}", uuid::Uuid::new_v4().simple()));
        let written = files.iter().try_for_each(|(path, bytes, executable)| {
            crate::shared_library_sync::write_file(&scratch, path, bytes, *executable)
        });
        // Another launch may have made the same build meanwhile: theirs is
        // identical, so either one in place will do.
        if written.is_err() || std::fs::rename(&scratch, &dest).is_err() {
            let _ = std::fs::remove_dir_all(&scratch);
            let unbuilt = |error: String| {
                // A stamp with no build beside it is nothing the prune visits.
                if !dest.exists() {
                    let _ = std::fs::remove_file(&stamp);
                }
                error
            };
            written.map_err(unbuilt)?;
            if !whole(&dest) {
                return Err(unbuilt(format!("could not put the build in place at {dest:?}")));
            }
        }
    }

    let library = crate::team_skills::read_own_library(&dest, MARKETPLACE_NAME);
    for error in &library.errors {
        log::warn!("shared_library: Codex project skills: {error}");
    }
    for refused in &library.refused {
        log::warn!(
            "shared_library: Codex project skills: {} refused: {}",
            refused.plugin,
            refused.reason
        );
    }
    if library.codex.is_none() {
        // `names` were each accepted by the same reader before the build, so a
        // build that reads back empty is a fault — never a quiet "nothing to add".
        log::warn!(
            "shared_library: the Codex project skills build {dest:?} holds no marketplace \
             Codex would load ({} skill(s) expected)",
            names.len()
        );
    }
    Ok(library.codex.map(|mut marketplace| {
        // `read_library` is the team library's reader and calls what it reads the
        // team's; this one is the branch's.
        marketplace.label = MARKETPLACE_LABEL.to_string();
        marketplace
    }))
}

/// Is a finished build in place at `dest`? A build is renamed in whole or not at
/// all, so the marketplace manifest — the file the reader opens first — says so.
fn whole(dest: &Path) -> bool {
    crate::team_skills::codex_marketplace_manifest(&crate::team_skills::codex_library_dir(dest))
        .is_file()
}

/// Every file of the build, in the team library's Codex layout, sorted by path:
/// `(path, bytes, executable)`.
fn layout(build: &Path, names: &[String]) -> Result<Vec<(String, Vec<u8>, bool)>, String> {
    let plugin_manifest = serde_json::json!({
        "name": PLUGIN_NAME,
        "description": "This workspace's project skills from the integration branch, delivered by Plyloft",
        "version": PLUGIN_VERSION,
    });
    // `team_skills::write_marketplace_entry`'s shape, field for field.
    let marketplace = serde_json::json!({
        "name": MARKETPLACE_NAME,
        "interface": { "displayName": MARKETPLACE_DISPLAY_NAME },
        "plugins": [{
            "name": PLUGIN_NAME,
            "source": { "source": "local", "path": format!("./plugins/{PLUGIN_NAME}") },
            "policy": { "installation": "AVAILABLE" },
        }],
    });
    let json = |value: &serde_json::Value| {
        serde_json::to_string_pretty(value)
            .unwrap_or_default()
            .into_bytes()
    };
    let plugin_root = format!("library/codex/plugins/{PLUGIN_NAME}");
    let mut files = vec![
        (
            format!("{plugin_root}/.codex-plugin/plugin.json"),
            json(&plugin_manifest),
            false,
        ),
        (
            "library/codex/.agents/plugins/marketplace.json".to_string(),
            json(&marketplace),
            false,
        ),
    ];
    for name in names {
        let dir = crate::skill_reach::skill_dir(build, crate::skill_reach::Side::Codex, name);
        // `read_tree` refuses a symlink anywhere under the directory; the mirror
        // already leaves such a skill out, so this is the second lock.
        for file in crate::project_skills::read_tree(&dir)? {
            files.push((
                format!("{plugin_root}/skills/{name}/{}", file.path),
                file.bytes,
                file.executable,
            ));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

/// A name for exactly these bytes, at exactly these paths, with these modes.
fn digest_of(files: &[(String, Vec<u8>, bool)]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for (path, bytes, executable) in files {
        hasher.update(path.as_bytes());
        hasher.update([0, u8::from(*executable)]);
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    let digest = format!("{:x}", hasher.finalize());
    digest[..24].to_string()
}

#[cfg(test)]
#[path = "branch_codex_skills_tests.rs"]
mod tests;
