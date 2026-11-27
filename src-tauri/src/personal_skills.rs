//! GH #96 (ADR 0005, `docs/ux-language/boards/BOARDS.md` §3) — the personal
//! skills of this Mac, for the Library's `On this Mac` section.
//!
//! **Read only, by construction.** The card's rule is the ADR's: a skill in
//! the member's own CLI folders is theirs, Ply lists it and opens it and never
//! changes it. Nothing in this module opens a path for writing, creates a
//! directory or removes one — `personal_skills_read_nothing_but_reads`
//! asserts it against a snapshot of the whole root.
//!
//! ## The roots, and why three
//!
//! The same measurement rung 4 recorded for a repository
//! ([`crate::project_skills`]) holds for a home directory: no single directory
//! serves both CLIs. Claude Code reads `~/.claude/skills`, Codex reads
//! `~/.agents/skills` and `~/.codex/skills`, and neither reads the other's. So
//! a personal skill can legitimately reach one CLI, and the row's chips say
//! which — the same rule the repository's rows follow.
//!
//! A skill is judged loadable by [`crate::team_skills::read_skill_dir`], the
//! one reader every scope shares: what Ply lists is what a CLI would load, and
//! a `SKILL.md` without a description is listed nowhere.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::platform::THIS_MACHINE;
use crate::team_skills::{self, Vendor};

/// One home-relative directory a CLI reads personal skills from.
pub struct PersonalRoot {
    pub rel: &'static str,
    pub vendor: Vendor,
}

/// Every personal root either CLI reads, in the order the page lists them.
pub const PERSONAL_ROOTS: &[PersonalRoot] = &[
    PersonalRoot {
        rel: ".claude/skills",
        vendor: Vendor::Claude,
    },
    PersonalRoot {
        rel: ".agents/skills",
        vendor: Vendor::Codex,
    },
    PersonalRoot {
        rel: ".codex/skills",
        vendor: Vendor::Codex,
    },
];

/// One skill of this Mac, with the CLIs that load it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalSkill {
    /// Its directory name: the identity, and the name Claude uses.
    pub name: String,
    /// What Codex calls it, when the frontmatter `name` disagrees.
    pub codex_name: Option<String>,
    pub description: String,
    pub claude: bool,
    pub codex: bool,
    /// The roots it was found in, home-relative.
    pub roots: Vec<String>,
    /// The directory the first of those roots holds it in, absolute: what
    /// `Open in Code` reads and what a Promote would copy.
    pub dir: String,
}

/// Everything the member's own skill directories hold.
///
/// Never fails: a root that cannot be read is named in `errors` and the rest
/// still list, for the reason [`crate::project_skills::read_project_skills`]
/// gives — a listing that vanished on one bad file would tell a member this
/// Mac has no skills.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalSkills {
    pub skills: Vec<PersonalSkill>,
    /// The roots that exist on this Mac. Empty is ordinary: a member who has
    /// never written a personal skill has none of these directories.
    pub roots_present: Vec<String>,
    pub errors: Vec<String>,
}

fn directory_name(dir: &Path) -> String {
    dir.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill")
        .to_string()
}

/// The member's home, the way the rest of the app asks for it
/// (`codex_home::home_dir`, `team::home_dir`).
pub fn home_dir() -> PathBuf {
    crate::platform::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Read every personal skill root under `home`.
///
/// Keyed by directory name, so one skill written for both CLIs is one row with
/// two chips — the same identity rule the repository and the team library use.
pub fn read_personal_skills(home: &Path) -> PersonalSkills {
    let mut out = PersonalSkills::default();
    let mut rows: BTreeMap<String, PersonalSkill> = BTreeMap::new();

    for root in PERSONAL_ROOTS {
        let dir = crate::project_skills::under(home, root.rel);
        if !dir.is_dir() {
            continue;
        }
        out.roots_present.push(root.rel.to_string());
        let (children, links) = match child_dirs(&dir) {
            Ok(children) => children,
            Err(error) => {
                out.errors.push(format!("{} unreadable: {error}", root.rel));
                continue;
            }
        };
        for link in links {
            out.errors.push(format!(
                "{}/{} is a symlink, so Plyloft does not read it — the same refusal the \
                 integration branch's mirror makes.",
                root.rel,
                directory_name(&link),
            ));
        }
        for child in children {
            if is_claude_synced_container(root, &child) {
                continue;
            }
            let mut reasons = Vec::new();
            let Some(loaded) = team_skills::read_skill_dir(&child, &mut reasons) else {
                out.errors.extend(reasons);
                continue;
            };
            let entry = rows.entry(loaded.dir.clone()).or_insert_with(|| PersonalSkill {
                name: loaded.dir.clone(),
                codex_name: loaded.codex_name.clone(),
                description: loaded.description.clone(),
                claude: false,
                codex: false,
                roots: Vec::new(),
                dir: child.to_string_lossy().to_string(),
            });
            match root.vendor {
                Vendor::Claude => entry.claude = true,
                Vendor::Codex => entry.codex = true,
            }
            entry.roots.push(root.rel.to_string());
        }
    }

    out.skills = rows.into_values().collect();
    out
}

/// Claude Code's own container of the skills it syncs from claude.ai:
/// `~/.claude/skills/synced/<id>/<skill>/SKILL.md`, with a `manifest.json`.
/// Claude Code manages it, not the member, so the Library skips it silently —
/// neither a row nor an error line, and none of the skills nested inside it.
///
/// Recognised by its shape, not its name alone: no `SKILL.md` directly inside,
/// **and** a `manifest.json` or id-named child directories. A member's own skill
/// called `synced` (a `SKILL.md` inside) is still listed, and a broken one (no
/// `SKILL.md`, none of the container's marks) still gets its error line.
const CLAUDE_SYNCED_CONTAINER: &str = "synced";

fn is_claude_synced_container(root: &PersonalRoot, child: &Path) -> bool {
    matches!(root.vendor, Vendor::Claude)
        && child.file_name().and_then(|name| name.to_str()) == Some(CLAUDE_SYNCED_CONTAINER)
        && !child.join("SKILL.md").exists()
        && (child.join("manifest.json").is_file() || has_id_named_children(child))
}

/// Children named like Claude Code's sync ids: hex digits, `-` and `_` only,
/// long enough not to be a word (`00000000-0000-…_11111111-…`).
fn has_id_named_children(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let mut any = false;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let id_like = name.len() >= 8
            && name.chars().all(|c| c.is_ascii_hexdigit() || c == '-' || c == '_');
        if !id_like || !entry.path().is_dir() {
            return false;
        }
        any = true;
    }
    any
}

/// The skill directory `path` names, when it is one Ply lists — otherwise the
/// refusal, in words.
///
/// GH #100 (BOARDS.md §4, state D): `Details` on a personal skill's page holds
/// the path and `Reveal in Finder`, and Finder is reached by handing a path to
/// `open -R`. A window may only ever name a directory Ply itself listed, so the
/// set this accepts is exactly the set [`read_personal_skills`] walks: a
/// **direct, visible, real** child of one of [`PERSONAL_ROOTS`] under this
/// Mac's home.
///
/// Every other shape is refused rather than sanitised:
///
/// - a root itself, or anything deeper than its children — `open -R` on
///   `~/.claude` would show a directory the Library never listed;
/// - a relative path, or one holding `.` or `..` — the components are compared
///   literally, so a traversal cannot arrive at a root by walking back into it;
/// - a dot child, which both CLIs' own readers skip, so Ply lists none;
/// - a symlink, which [`child_dirs`] refuses for the reason the mirror refuses
///   one: it can point anywhere, so revealing it would show a directory outside
///   the roots entirely;
/// - anything that is not a directory, or is not there any more.
///
/// Read-only, like the rest of this module: nothing here creates, opens for
/// writing or resolves through the filesystem (no `canonicalize`, which would
/// follow the very links the last rule refuses).
pub fn listed_skill_dir(home: &Path, path: &str) -> Result<PathBuf, String> {
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err("Plyloft only reveals a skill directory it listed, by its full path.".into());
    }
    // The raw segments, not `Path::components()`: that normalises a `.` away
    // (`/a/./b` has no `CurDir` in it), and a guard that compares a normalised
    // path while `open` is handed the original is a guard about a different
    // string. `..` and `.` are refused outright, so `<root>/a/../../x` cannot
    // pass as `<root>/x` and `<root>/./a` cannot slip past the parent check.
    if path.split('/').any(|piece| piece == "." || piece == "..") {
        return Err("Plyloft only reveals a skill directory it listed, by its full path.".into());
    }
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.starts_with('.'))
        .ok_or_else(|| format!("That is not a skill directory on {THIS_MACHINE}."))?;
    let parent = target.parent().ok_or_else(|| {
        format!("That is not a skill directory on {THIS_MACHINE}.")
    })?;
    let listed = PERSONAL_ROOTS.iter().any(|root| {
        parent == crate::project_skills::under(home, root.rel) && !is_claude_synced_container(root, target)
    });
    if !listed {
        return Err(format!(
            "{name} is not in one of {THIS_MACHINE}'s skill folders, so Plyloft will not reveal it."
        ));
    }
    let metadata = std::fs::symlink_metadata(target)
        .map_err(|_| format!("{name} is not on {THIS_MACHINE} any more — refresh the Library."))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "{name} is a symlink, so Plyloft does not read it — the same refusal the \
             integration branch's mirror makes."
        ));
    }
    if !metadata.is_dir() {
        return Err(format!("{name} is not a skill directory."));
    }
    Ok(target.to_path_buf())
}

/// The visible child directories of `dir`, sorted, and the symlinks among them.
///
/// Dot directories are skipped, as both CLIs' own readers skip them. A symlink
/// is **not** followed and is named instead: the mirror refuses a symlinked skill
/// for the reason `project_skills` refuses one (a link can point anywhere, and
/// what Ply reports would not be what the author wrote), and a reader that
/// followed links here would disagree with every other reader about what a skill
/// is (GH #96 review 1). `symlink_metadata`, so a link to a directory is seen as
/// a link and a dangling one is seen at all.
fn child_dirs(dir: &Path) -> Result<(Vec<PathBuf>, Vec<PathBuf>), String> {
    let entries = std::fs::read_dir(dir).map_err(|error| error.to_string())?;
    let mut dirs = Vec::new();
    let mut links = Vec::new();
    for path in entries.flatten().map(|entry| entry.path()) {
        let hidden = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| name.starts_with('.'));
        if hidden {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            links.push(path);
        } else if metadata.is_dir() {
            dirs.push(path);
        }
    }
    dirs.sort();
    links.sort();
    Ok((dirs, links))
}

#[cfg(test)]
#[path = "personal_skills_tests.rs"]
mod tests;
