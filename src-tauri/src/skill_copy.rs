//! Skills hub H8 (`docs/plans/SKILLS_HUB.md` R5, §12 H8): **Copy to…** — a
//! skill copied into other workspaces on this Mac, each copy a skill card
//! that writes a *linked* copy (origin = where it was copied from).
//!
//! **Where a copy can come from.**
//! - *A workspace's repository skill.* Upstream is the skill as **committed**
//!   in that workspace (its checkout's `HEAD` tree, read from git objects —
//!   never the working tree: an uncommitted edit there never makes a copy say
//!   *Update available*, R5 Challenger edge). When the origin workspace has a
//!   GitHub repository, the link is committed with the copy
//!   (`{kind: "workspace", source: "owner/repo", path, version}`), so every
//!   Mac with both repositories sees it. When it has none (no remote, or one
//!   that isn't GitHub), nothing in a committed file could name it (no machine
//!   paths in `.atelier/`, PATTERNS), so the link is kept **on this Mac only**
//!   ([`LocalLink`], `skills_hub/state.json` `localLinks`) and the row says
//!   *Linked on this Mac*.
//! - *This Mac's own skills* (`~/.claude/skills`, `~/.agents/skills`,
//!   `~/.codex/skills`, read only): allowed; the origin is per Mac
//!   (`{kind: "this-mac"}`), so the link is local too. Plyloft still never
//!   writes those folders: the files are **staged** in a bare repository of
//!   Plyloft's own (`skills_hub/stage.git`, [`stage_dir`]) so the card, the
//!   scripts sheet and the content ids read them as git objects like any
//!   other source.
//! - *The team library*: a copy is the team's Install, into each workspace
//!   picked (H3a's card, H6b's sheet).
//!
//! **A local link and its card.** A local link is written when its card is
//! made, marked *pending*, and is shown only once the copy is really there:
//! the card landed, or the checkout's copy is exactly what the card wrote
//! ([`settle`]). A card deleted before it shipped takes its pending link with
//! it, so a later skill of the same name is never mistaken for the copy.
//!
//! **One card per workspace** (§4.2 "Many cards at once"): Copy to… across
//! N workspaces makes at most one card in each, and none where the copy is
//! refused (the same repository as the origin, already linked, on its way,
//! not a git repository).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::platform::THIS_MACHINE;
use crate::skill_links::{LinkOrigin, SkillLink, TwinIds};

/// `origin.kind` of a copy from another workspace's repository.
pub const KIND_WORKSPACE: &str = "workspace";
/// `origin.kind` of a copy from this Mac's own skills folders (per Mac only).
pub const KIND_THIS_MAC: &str = "this-mac";
/// The origin workspace of a link kept on this Mac only, in `origin`'s
/// unknown keys — never in a committed file.
pub const ORIGIN_WORKSPACE_ID: &str = "workspaceId";

/// The origin workspace's name when the local link was made, so a row can
/// still name it once that workspace is removed from Plyloft.
pub const ORIGIN_WORKSPACE_NAME: &str = "workspaceName";

/// The origin workspace a local link names, if it names one.
pub fn origin_workspace_id(origin: &LinkOrigin) -> Option<&str> {
    origin.extra.get(ORIGIN_WORKSPACE_ID).and_then(|v| v.as_str()).filter(|id| !id.is_empty())
}

/// A link of kind `workspace` or `this-mac` (H8): read from a checkout or
/// this Mac's folders, not from a library clone.
pub fn is_copy_origin(origin: &LinkOrigin) -> bool {
    origin.kind == KIND_WORKSPACE || origin.kind == KIND_THIS_MAC
}

// ── Links kept on this Mac only ──────────────────────────────────────

/// One link that can't be committed (§5.2 `localLinks`): an origin with no
/// GitHub repository to name, or this Mac's own skills. Keyed in the store
/// by destination workspace id and skill directory.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLink {
    #[serde(default)]
    pub origin: LinkOrigin,
    /// Each copy's content id when it was in step with the origin.
    #[serde(default)]
    pub base: TwinIds,
    #[serde(default)]
    pub kept_mine: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_at: Option<String>,
    /// The skill card that carries this link's copy, while it is on its way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
    /// Written when the card was made; not shown until the copy is there.
    #[serde(default)]
    pub pending: bool,
    /// An Update's link, waiting for its card the same way; the link above
    /// stays the one shown until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<Box<LocalLink>>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl LocalLink {
    /// A pending link for the card `card_id`, from the record a card would
    /// have committed.
    pub fn pending_from(link: &SkillLink, card_id: &str) -> Self {
        LocalLink {
            origin: link.origin.clone(),
            base: link.base.clone(),
            kept_mine: link.kept_mine,
            linked_at: link.linked_at.clone(),
            card_id: Some(card_id.to_string()),
            pending: true,
            next: None,
            extra: Default::default(),
        }
    }

    /// As the rest of the hub reads a link.
    pub fn link(&self) -> SkillLink {
        SkillLink {
            schema_version: crate::skill_links::SCHEMA_VERSION,
            origin: self.origin.clone(),
            base: self.base.clone(),
            kept_mine: self.kept_mine,
            linked_at: self.linked_at.clone(),
            extra: Default::default(),
        }
    }
}

/// Where a local link's card is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardAt {
    /// Not shipped yet (or a pull request still open).
    OnItsWay,
    /// Landed.
    Landed,
    /// Not on the board any more (deleted), or archived without landing.
    Gone,
}

/// Every twin the base records is what the checkout holds now.
fn is_what_the_card_wrote(base: &TwinIds, here: &TwinIds) -> bool {
    let recorded = [(&base.claude, &here.claude), (&base.codex, &here.codex)];
    recorded.iter().any(|(b, _)| b.is_some()) && recorded.iter().all(|(b, h)| b.is_none() || b == h)
}

fn has_a_copy(here: &TwinIds) -> bool {
    here.claude.is_some() || here.codex.is_some()
}

/// What a local link is now, from the checkout's copies (`here`) and where
/// its cards are: the entry to keep (`None`: forget it) and the link the
/// rows read (`None`: not shown yet).
///
/// - An Update waiting (`next`) takes over once its card landed or the copy
///   is what it wrote; its card gone, it is dropped and the link stays.
/// - No copy here: kept (hidden) while its card is on its way, else dropped.
/// - Pending: shown (and no longer pending) once its card landed or the copy
///   is what the card wrote; hidden while the card is on its way; dropped
///   once the card is gone and the copy is something else.
pub fn settle(entry: &LocalLink, here: &TwinIds, card: &dyn Fn(Option<&str>) -> CardAt) -> (Option<LocalLink>, Option<SkillLink>) {
    let mut entry = entry.clone();
    if let Some(next) = entry.next.clone() {
        let at = card(next.card_id.as_deref());
        if (at == CardAt::Landed && has_a_copy(here)) || is_what_the_card_wrote(&next.base, here) {
            entry = LocalLink { pending: false, next: None, card_id: None, ..*next };
        } else if at == CardAt::Gone {
            entry.next = None;
        }
    }
    if !has_a_copy(here) {
        let waiting = entry.pending && card(entry.card_id.as_deref()) == CardAt::OnItsWay;
        return (waiting.then_some(entry), None);
    }
    if entry.pending {
        let at = card(entry.card_id.as_deref());
        if at == CardAt::Landed || is_what_the_card_wrote(&entry.base, here) {
            entry.pending = false;
            entry.card_id = None;
        } else if at == CardAt::OnItsWay {
            return (Some(entry), None);
        } else {
            return (None, None);
        }
    }
    let shown = entry.link();
    (Some(entry), Some(shown))
}

/// The same two entries, read the same way: nothing to write.
pub fn same_entry(a: Option<&LocalLink>, b: Option<&LocalLink>) -> bool {
    a == b
}

// ── Words ────────────────────────────────────────────────────────────

/// `Skill: copy deploy-notes from astra`.
pub fn copy_title(skill: &str, from_words: &str) -> String {
    format!("Skill: copy {skill} from {from_words}")
}

/// `Skill: update deploy-notes from astra`.
pub fn update_title(skill: &str, from_words: &str) -> String {
    format!("Skill: update {skill} from {from_words}")
}

/// The commit message (§4.2): `skill: copy <name> (<origin words>)`.
pub fn commit_message(verb: &str, skill: &str, from_words: &str, origin: &LinkOrigin) -> String {
    let at = &origin.version.commit;
    let at = if at.is_empty() { String::new() } else { format!(" at {}", &at[..at.len().min(8)]) };
    format!("skill: {verb} {skill} ({from_words})\n\nWritten by Plyloft from {from_words}{at}.")
}

/// Why a link is kept on this Mac only, in words.
pub fn local_reason(origin_kind: &str, from_words: &str) -> String {
    if origin_kind == KIND_THIS_MAC {
        format!("The link is kept on {THIS_MACHINE} only: your own skills folder isn't a repository anyone else can read.")
    } else {
        format!("The link is kept on {THIS_MACHINE} only: {from_words} has no GitHub repository a committed link could name.")
    }
}

/// A card's brief, ending with who gets what and when (R18.4).
pub fn card_notes(verb: &str, skill: &str, from_words: &str, local: bool, repo_words: &str, cli_words: &str, roots: &[&str]) -> String {
    let what = if verb == "update" { "updates" } else { "copies" };
    let into = roots.iter().map(|root| format!("{root}/{skill}")).collect::<Vec<_>>().join(" and ");
    let record = if local {
        format!("Its link is kept on {THIS_MACHINE} only, so the commit holds the copy alone.")
    } else {
        format!("Its link record is .atelier/skill-links/{skill}.json.")
    };
    format!(
        "Plyloft made this card: it {what} {skill} from {from_words}'s committed version into {into}. {record} \
         Once it ships, everyone who opens {repo_words} gets it, in {cli_words}, from their next session."
    )
}

// ── This Mac's own skills ────────────────────────────────────────────

/// The personal roots a copy may come from, Claude's first.
pub const THIS_MAC_ROOTS: [&str; 3] = [".claude/skills", ".agents/skills", ".codex/skills"];

/// `skill` in this Mac's own folders under `home`: the directory a copy
/// reads (Claude's when it has one), its path from `home` with `/`, and
/// which CLIs load it there. `None` when no folder has a `SKILL.md`.
pub fn this_mac_skill(home: &Path, skill: &str) -> Option<(PathBuf, String, crate::skill_card::Reach)> {
    let has = |root: &str| home.join(root).join(skill).join("SKILL.md").is_file();
    let reach = crate::skill_card::Reach { claude: has(THIS_MAC_ROOTS[0]), codex: has(THIS_MAC_ROOTS[1]) || has(THIS_MAC_ROOTS[2]) };
    let root = THIS_MAC_ROOTS.iter().find(|root| has(root))?;
    let dir = root.split('/').fold(home.to_path_buf(), |at, part| at.join(part)).join(skill);
    Some((dir, format!("{root}/{skill}"), reach))
}

/// The content id of a folder on disk, as git would store its files with no
/// conversion — what [`stage_dir`] stages, so a link's version and this id
/// agree. `None`: not readable, too many files, or a symbolic link. A `.git`
/// isn't part of it, as in All skills' index; [`stage_dir`] refuses a folder
/// holding one.
pub fn dir_id(dir: &Path) -> Option<String> {
    let files = crate::skills_index::hash::walk_skill(dir, crate::skills_index::MAX_FILES).ok()?;
    if files.is_empty() {
        return None;
    }
    crate::skills_index::hash::tree_id(dir, &files, crate::skills_index::hash::Normalise::None, |_| false)
}

/// `<config_dir>/skills_hub/stage.git`: Plyloft's own bare repository where
/// a folder outside any repository is staged as git objects.
pub fn stage_repo(config_dir: &Path) -> PathBuf {
    config_dir.join("skills_hub").join("stage.git")
}

fn ensure_stage(stage: &Path) -> Result<(), String> {
    if stage.join("HEAD").is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(stage).map_err(|error| format!("create {}: {error}", stage.display()))?;
    crate::library_snapshot::git(stage, &["init", "--bare", "-q", "."]).map(|_| ())
}

/// A tree object of `files` (`(path inside, mode, blob)`), written into
/// `repo` bottom-up with `git mktree`.
fn write_tree(repo: &Path, files: &[(String, &'static str, String)]) -> Result<String, String> {
    let mut lines = String::new();
    let mut dirs: BTreeMap<&str, Vec<(String, &'static str, String)>> = BTreeMap::new();
    for (path, mode, blob) in files {
        match path.split_once('/') {
            Some((dir, rest)) => dirs.entry(dir).or_default().push((rest.to_string(), mode, blob.clone())),
            None => lines.push_str(&format!("{mode} blob {blob}\t{path}\n")),
        }
    }
    for (dir, inner) in dirs {
        let tree = write_tree(repo, &inner)?;
        lines.push_str(&format!("040000 tree {tree}\t{dir}\n"));
    }
    let out = crate::library_snapshot::git_with_stdin(repo, &["mktree"], lines.as_bytes())?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Stage the folder `dir` as the skill `name` in the bare repository
/// `stage`: one commit whose tree holds `<name>/…` with the files' bytes as
/// they are (no conversion) and their executable bits. `(commit, path)`, the
/// path being `name` — a source [`crate::skill_card::read_source`] reads like
/// a library's. Nothing is written outside `stage`.
pub fn stage_dir(stage: &Path, name: &str, dir: &Path) -> Result<(String, String), String> {
    ensure_stage(stage)?;
    crate::project_skills::refuse_git_folder(name, dir)?;
    let files = crate::skills_index::hash::walk(dir, crate::skills_index::MAX_FILES).map_err(|refusal| match refusal {
        crate::skills_index::hash::Refusal::TooMany => format!("{name} has too many files to copy."),
        _ => format!("{name} holds a symbolic link or a file Plyloft can't read, so it isn't copied."),
    })?;
    if files.is_empty() {
        return Err(format!("{name} has no files to copy."));
    }
    // One `hash-object` for every file (a spawn per file took seconds for a
    // skill of a few hundred files on Windows); a path git's list can't
    // carry (a line break in it) is hashed on its own.
    let paths: Vec<PathBuf> = files.iter().map(|file| file.rel.split('/').fold(dir.to_path_buf(), |at, part| at.join(part))).collect();
    let listable = paths.iter().all(|path| !path.to_string_lossy().contains(['\n', '\r']));
    let blobs: Vec<String> = if listable {
        let list: String = paths.iter().map(|path| format!("{}\n", path.to_string_lossy())).collect();
        let out = crate::library_snapshot::git_with_stdin(stage, &["hash-object", "-w", "--no-filters", "--stdin-paths"], list.as_bytes())?;
        String::from_utf8_lossy(&out).lines().map(|line| line.trim().to_string()).collect()
    } else {
        let mut blobs = Vec::new();
        for path in &paths {
            let bytes = std::fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
            let blob = crate::library_snapshot::git_with_stdin(stage, &["hash-object", "-w", "--no-filters", "--stdin"], &bytes)?;
            blobs.push(String::from_utf8_lossy(&blob).trim().to_string());
        }
        blobs
    };
    if blobs.len() != files.len() {
        return Err(format!("{name}'s files couldn't all be read, so it isn't copied."));
    }
    let staged: Vec<(String, &'static str, String)> = files
        .iter()
        .zip(blobs)
        .map(|(file, blob)| (format!("{name}/{}", file.rel), if file.executable { "100755" } else { "100644" }, blob))
        .collect();
    let tree = write_tree(stage, &staged)?;
    // Fixed dates: the same files are the same commit, so reading the
    // picker, the sheet and the copy again adds no object to `stage.git`.
    const EPOCH: &str = "2000-01-01T00:00:00Z";
    let out = crate::library_snapshot::git_with_env(
        stage,
        &[
            "-c",
            "user.name=Plyloft",
            "-c",
            "user.email=plyloft@localhost",
            "commit-tree",
            "--no-gpg-sign",
            &tree,
            "-m",
            &format!("staged {name} from a skills folder outside any repository"),
        ],
        &[("GIT_AUTHOR_DATE", EPOCH), ("GIT_COMMITTER_DATE", EPOCH)],
    )?;
    Ok((String::from_utf8_lossy(&out).trim().to_string(), name.to_string()))
}

// ── Destinations ─────────────────────────────────────────────────────

/// What a destination is, for the picker and for the copy itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Target {
    /// It doesn't have the skill: its card writes the copy and the link.
    Ready,
    /// It has the same content, not linked: its card only links it.
    SameContent,
    /// It has a different copy of the same name, not linked: its card would
    /// replace it and link it (asked first).
    Replace,
    /// H8 Challenger: it has exactly the copies a card would write, and the
    /// link is kept on this Mac only — there is nothing to commit, so it is
    /// linked here at once, with no card.
    LinkHere,
    /// No card can be made there; why, in words.
    Refused { why: String },
}

/// The facts one destination is judged from.
pub struct TargetFacts<'a> {
    pub name: &'a str,
    pub folder_missing: bool,
    pub is_git: bool,
    /// Its repository, `owner/name`, lower case.
    pub repo: Option<&'a str>,
    /// Its git common directory (two checkouts of one repository share it).
    pub common_dir: Option<&'a Path>,
    /// The link it already has for this skill (committed or kept on this Mac).
    pub link: Option<&'a SkillLink>,
    /// A link record there that can't be read.
    pub unreadable: bool,
    /// The card that already carries the skill there.
    pub on_its_way: Option<String>,
    /// Its checkout's copies of the skill.
    pub here: &'a TwinIds,
}

/// The origin's facts a destination is compared with.
pub struct OriginFacts<'a> {
    pub words: &'a str,
    pub repo: Option<&'a str>,
    pub common_dir: Option<&'a Path>,
    pub origin: &'a LinkOrigin,
    /// The content id the copy would write.
    pub content_id: &'a str,
}

/// The link `link` is to this very origin (the same skill of it).
pub fn same_origin(link: &LinkOrigin, origin: &LinkOrigin) -> bool {
    if link.kind != origin.kind || link.name != origin.name {
        return false;
    }
    match link.kind.as_str() {
        KIND_WORKSPACE => match (origin_workspace_id(link), origin_workspace_id(origin)) {
            (Some(a), Some(b)) => a == b,
            (None, None) => !link.source.is_empty() && link.source.eq_ignore_ascii_case(&origin.source),
            _ => false,
        },
        KIND_THIS_MAC => true,
        _ => link.source.eq_ignore_ascii_case(&origin.source) && link.plugin == origin.plugin,
    }
}

/// Pure: whether (and how) a copy may go to one destination (R5 AC and
/// edges).
pub fn judge_target(to: &TargetFacts, from: &OriginFacts, link_words: &dyn Fn(&LinkOrigin) -> String) -> Target {
    let refused = |why: String| Target::Refused { why };
    if to.folder_missing {
        return refused(format!("{}'s folder isn't on {THIS_MACHINE} now.", to.name));
    }
    if !to.is_git {
        return refused(format!("{} isn't a git repository, so there is no card to carry the copy.", to.name));
    }
    let same_repo = matches!((to.repo, from.repo), (Some(a), Some(b)) if a.eq_ignore_ascii_case(b))
        || matches!((to.common_dir, from.common_dir), (Some(a), Some(b)) if a == b);
    if same_repo {
        return refused(format!("{} is the same repository as {}.", to.name, from.words));
    }
    if to.unreadable {
        return refused(format!("{}'s link record for this skill can't be read, so Plyloft won't write over it.", to.name));
    }
    if let Some(link) = to.link {
        return if same_origin(&link.origin, from.origin) {
            refused(format!("{} already has it, linked to {}.", to.name, from.words))
        } else {
            refused(format!("{} has its own {}, linked to {}.", to.name, from.origin.name, link_words(&link.origin)))
        };
    }
    if let Some(title) = &to.on_its_way {
        return refused(format!("{} is already on its way there in the card \"{title}\".", from.origin.name));
    }
    let ids: Vec<&String> = [&to.here.claude, &to.here.codex].into_iter().flatten().collect();
    if ids.is_empty() {
        Target::Ready
    } else if ids.iter().all(|id| id.as_str() == from.content_id) {
        Target::SameContent
    } else {
        Target::Replace
    }
}

#[cfg(test)]
#[path = "skill_copy_tests.rs"]
mod tests;
