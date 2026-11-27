//! Skills hub H9 (`docs/plans/SKILLS_HUB.md` R9, §5.6, §14 Q9, Q27): the
//! switch of a skill that comes with Plyloft, at three levels.
//!
//! - **Workspace** — an explicit `on` or `off`, in the shared definition
//!   (`.atelier/workspace.json` → `library.plySkills`) for a shared
//!   workspace, kept in step on this Mac in `projects/<ws>/ply_skills.json`
//!   (the store a definition refresh writes, like SL-4's
//!   `worktree_setup.json`); for a workspace with no shared definition that
//!   file is the only home. A name in neither list follows the team.
//! - **Team default** — `library.plySkillsOff` in the team manifest
//!   (`team.json`), written by the team owner only. The team can only switch
//!   a skill **off** (Q27): there is no "on" list, so "no team choice" follows
//!   this Mac. It applies wherever the team library itself reaches (every
//!   session on a Mac whose team library is delivered, `mcp_launch::team_clone_dir`).
//! - **This Mac** — `settings.library.plySkillsOff`, as before H9.
//!
//! Precedence (Q9): workspace → team → this Mac → on.
//!
//! **A fork in the repository.** A repository that holds a copy linked to
//! Plyloft (`.atelier/skill-links/<name>.json` with `origin.kind = plyloft`,
//! written by Personalize) switches Plyloft's own copy off there too, unless
//! the workspace explicitly says `on`. This is the only way Personalize
//! switches Plyloft's copy off (owner, 2026-10-20: no definition write): it
//! takes effect exactly when the fork reaches the checkout — never before, so
//! a session is never left with neither copy.
//!
//! Read at every launch (`mcp_launch::KnowledgeMcpContext::new`): a switch
//! changes the next session, never one already running.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::project_config::ProjectConfigStore;

/// This Mac's copy of a workspace's choices.
pub const FILE: &str = "ply_skills.json";
const SCHEMA_VERSION: u32 = 1;

/// The manifest key that holds the team default (`team.json` → `library`).
pub const TEAM_LIBRARY_KEY: &str = "library";
/// …and the list inside it.
pub const TEAM_OFF_KEY: &str = "plySkillsOff";

/// A workspace's explicit choices. A name in `off` wins over the same name in
/// `on` (a hand-edited file that says both is read as off, the safe side).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choices {
    #[serde(default)]
    pub off: Vec<String>,
    #[serde(default)]
    pub on: Vec<String>,
}

impl Choices {
    /// `Some(false)` off, `Some(true)` on, `None` no choice here.
    pub fn choice(&self, name: &str) -> Option<bool> {
        if self.off.iter().any(|n| n == name) {
            Some(false)
        } else if self.on.iter().any(|n| n == name) {
            Some(true)
        } else {
            None
        }
    }

    /// These choices with `name` set to `choice` (`None`: follow the team).
    pub fn with(&self, name: &str, choice: Option<bool>) -> Choices {
        let mut next = self.clone();
        next.off.retain(|n| n != name);
        next.on.retain(|n| n != name);
        match choice {
            Some(false) => next.off.push(name.to_string()),
            Some(true) => next.on.push(name.to_string()),
            None => {}
        }
        next.normalized()
    }

    /// Sorted, without repeats, a name in both lists only in `off`, and no
    /// blank names — so two equal sets of choices compare equal.
    pub fn normalized(&self) -> Choices {
        let clean = |list: &[String]| {
            let mut out: Vec<String> = list
                .iter()
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
                .collect();
            out.sort();
            out.dedup();
            out
        };
        let off = clean(&self.off);
        let on = clean(&self.on).into_iter().filter(|n| !off.contains(n)).collect();
        Choices { off, on }
    }

    pub fn is_empty(&self) -> bool {
        self.off.is_empty() && self.on.is_empty()
    }
}

/// `projects/<ws>/ply_skills.json`. Unknown keys survive a rewrite.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    ply_skills: Choices,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

fn path(store: &ProjectConfigStore, workspace_id: &str) -> std::path::PathBuf {
    store.workspace_dir(workspace_id).join(FILE)
}

fn load_stored(store: &ProjectConfigStore, workspace_id: &str) -> Stored {
    let Ok(bytes) = std::fs::read(path(store, workspace_id)) else {
        return Stored::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        // A file this build can't read decides nothing: the next refresh of
        // a shared definition writes the repository's choices back.
        log::warn!("ply skills: ignoring unreadable {FILE} for {workspace_id}: {error}");
        Stored::default()
    })
}

/// This workspace's choices on this Mac. A missing or unreadable file is no
/// choice at all (every skill follows the team and this Mac).
pub fn load(store: &ProjectConfigStore, workspace_id: &str) -> Choices {
    load_stored(store, workspace_id).ply_skills.normalized()
}

/// Atomic (Hard rule 3). Keeps the file's unknown keys.
pub fn save(store: &ProjectConfigStore, workspace_id: &str, choices: &Choices) -> Result<(), String> {
    let mut stored = load_stored(store, workspace_id);
    stored.schema_version = SCHEMA_VERSION;
    stored.ply_skills = choices.normalized();
    crate::atomic::write_atomic_json(&path(store, workspace_id), &stored)
}

// ── The team default ─────────────────────────────────────────────────

/// The names the team switched off (`team.json` → `library.plySkillsOff`).
/// Read from the manifest's kept unknown keys (`TeamManifest::extra`, H2), so
/// a manifest without `library` — every one written before H9 — switches
/// nothing off.
pub fn team_off(manifest: &crate::team::TeamManifest) -> Vec<String> {
    let mut out: Vec<String> = manifest
        .extra
        .get(TEAM_LIBRARY_KEY)
        .and_then(|library| library.get(TEAM_OFF_KEY))
        .and_then(|list| list.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|name| name.as_str())
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out.dedup();
    out
}

/// The manifest with `name` switched off (or back to no team choice) for the
/// team, every other key of `library` and of the manifest kept. `None` when
/// it already says so — nothing to write.
pub fn manifest_with_team_off(
    manifest: &crate::team::TeamManifest,
    name: &str,
    off: bool,
) -> Option<crate::team::TeamManifest> {
    let current = team_off(manifest);
    if current.iter().any(|n| n == name) == off {
        return None;
    }
    let mut next_list: Vec<String> = current.into_iter().filter(|n| n != name).collect();
    if off {
        next_list.push(name.to_string());
    }
    next_list.sort();
    let mut next = manifest.clone();
    let library = next
        .extra
        .entry(TEAM_LIBRARY_KEY.to_string())
        .or_insert_with(|| serde_json::Value::Object(Default::default()));
    if !library.is_object() {
        *library = serde_json::Value::Object(Default::default());
    }
    if let Some(object) = library.as_object_mut() {
        object.insert(
            TEAM_OFF_KEY.to_string(),
            serde_json::Value::Array(next_list.into_iter().map(serde_json::Value::String).collect()),
        );
    }
    Some(next)
}

// ── A fork in the repository ─────────────────────────────────────────

/// The Plyloft skills this folder holds a fork of: a link record whose origin
/// is Plyloft, beside a copy that is really there.
pub fn forks_here(cwd: &Path) -> Vec<String> {
    let (links, _) = crate::skill_links::read_checkout(cwd);
    let mut out: Vec<String> = links
        .iter()
        .filter(|(_, link)| link.origin.kind == crate::skill_links::KIND_PLYLOFT)
        .filter(|(dir, _)| {
            [crate::skill_links::CLAUDE_ROOT, crate::skill_links::CODEX_ROOT]
                .iter()
                .any(|root| crate::project_skills::under(cwd, root).join(dir).join("SKILL.md").is_file())
        })
        .map(|(dir, link)| if link.origin.name.is_empty() { dir.clone() } else { link.origin.name.clone() })
        .collect();
    out.sort();
    out.dedup();
    out
}

// ── The decision ─────────────────────────────────────────────────────

/// Which level decided a skill's switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    /// The workspace's explicit choice.
    Workspace,
    /// The repository holds a fork linked to Plyloft (and no explicit choice).
    Fork,
    /// The team switched it off.
    Team,
    /// This Mac switched it off.
    Mac,
    /// Nothing switched it off.
    Default,
}

/// A skill's effective switch and who set it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub on: bool,
    pub level: Level,
}

/// Everything a decision reads, for one session or one Library view.
#[derive(Debug, Clone, Default)]
pub struct Inputs {
    pub workspace: Choices,
    pub forks: Vec<String>,
    /// `None` when no team library reaches this Mac's sessions.
    pub team_off: Option<Vec<String>>,
    pub mac_off: Vec<String>,
}

impl Inputs {
    /// Workspace → fork → team → this Mac → on (Q9).
    pub fn decide(&self, name: &str) -> Decision {
        if let Some(on) = self.workspace.choice(name) {
            return Decision { on, level: Level::Workspace };
        }
        if self.forks.iter().any(|n| n == name) {
            return Decision { on: false, level: Level::Fork };
        }
        if self.team_off.as_ref().is_some_and(|off| off.iter().any(|n| n == name)) {
            return Decision { on: false, level: Level::Team };
        }
        if self.mac_off.iter().any(|n| n == name) {
            return Decision { on: false, level: Level::Mac };
        }
        Decision { on: true, level: Level::Default }
    }

    /// The names a session is not given, out of `names` (the bundle's). G2:
    /// a skill and its alias (`ply_skills::ALIASES`) are off together — either
    /// name decided off switches both off.
    pub fn off<'a>(&self, names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
        names
            .into_iter()
            .filter(|name| {
                !self.decide(name).on
                    || crate::ply_skills::other_name(name).is_some_and(|other| !self.decide(other).on)
            })
            .map(str::to_string)
            .collect()
    }
}

/// What a launch or a view reads: the workspace's choices, the forks in
/// `cwd`, the team default from `team_clone` (when the team library reaches
/// sessions) and this Mac's switch.
pub fn inputs(
    store: Option<&ProjectConfigStore>,
    workspace_id: &str,
    cwd: Option<&Path>,
    team_clone: Option<&Path>,
    mac_off: Vec<String>,
) -> Inputs {
    Inputs {
        workspace: store.map(|store| load(store, workspace_id)).unwrap_or_default(),
        forks: cwd.map(forks_here).unwrap_or_default(),
        team_off: team_clone.map(|clone| match crate::team::read_manifest(clone) {
            Ok(Some(manifest)) => team_off(&manifest),
            _ => Vec::new(),
        }),
        mac_off,
    }
}

#[cfg(test)]
#[path = "ply_skill_switch_tests.rs"]
mod tests;
