//! Skills hub H3a (`docs/plans/SKILLS_HUB.md` R2, §5.1): **linked copies**.
//!
//! A repository skill installed from a library records where it came from in
//! a link record committed beside it: `.atelier/skill-links/<name>.json`, one
//! file per skill directory (§14 Q24, owner 2026-10-16: two cards for two
//! skills never meet over one shared file, and a local rename is a file
//! rename). The record names the origin (`kind`, `source`, `plugin`, `name`,
//! the library `path` the copy was read from, and the `version` — the origin's
//! commit and the skill directory's content id there) and the **base**: each
//! twin's content id at the last in-step state.
//!
//! A *content id* is the git tree id of a skill directory: equal ids are the
//! same skill, byte for byte, executable bits included. The checkout's ids are
//! hashed by git from the working tree with its clean filters
//! ([`crate::shared_library_sync::checkout_root_tree`]), so a Windows checkout
//! with `core.autocrlf=true` reads the same ids as a Mac (§8).
//!
//! What a link says about a copy ([`link_state`]):
//! - **Modified here** — here ≠ base for a twin the link records. H3 marks it
//!   and offers only a 2-way Compare; it never offers Update, which would
//!   overwrite the edit (§12 "H3 must not ship an Update that overwrites local
//!   edits"). H4 adds *Take upstream* and *Propose mine upstream*.
//! - **Both changed** (H4, R3) — modified here and the origin moved on: the
//!   3-way Compare with *Keep mine* / *Take upstream* / *Propose mine
//!   upstream*.
//! - **Update available** — here = base and the origin's copy moved on.
//! - **Not available on this Mac** — the origin cannot be read here (another
//!   team, no clone): no Update, no Compare against upstream. Absence of the
//!   origin is never read as "removed upstream".
//! - **Removed** (H4, R8) — the origin was read after a pull that went past
//!   the link, and lacks the skill: *Keep* (detach) or *Remove*, by card.
//! - **Renamed** (H4, R8 edge) — the origin moved it to a new name: *Rename
//!   here* or *Keep the old name*.
//!
//! Nothing the origin does ever writes a repository (H4, "team
//! never-override"): every state above only marks the row and asks; the
//! member's answer is a card, or — for a proposal — a pull request in the
//! library.
//!
//! Shared, committed state: no email, no machine path, no run id (PATTERNS
//! `.atelier/`). Unknown keys are kept on rewrite, at every level.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Where the link records live, from the workspace's folder.
pub const LINKS_DIR: &str = ".atelier/skill-links";
pub const SCHEMA_VERSION: u32 = 1;
/// The two roots a linked copy is written to (`project_skills::INSTALL_ROOTS`).
pub const CLAUDE_ROOT: &str = ".claude/skills";
pub const CODEX_ROOT: &str = ".agents/skills";
/// `origin.kind` of a copy installed from the team library.
pub const KIND_TEAM: &str = "team";
/// Skills hub H9 (R9): `origin.kind` of a fork of a skill that comes with
/// Plyloft (Personalize). Its `source` is `plyloft`, its `version.commit` the
/// Plyloft version of the skill it started from.
pub const KIND_PLYLOFT: &str = "plyloft";
/// Skills hub H10 (R6): a copy linked to the member's My library.
pub const KIND_LIBRARY: &str = "library";

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

/// One content id per twin. Absent: that CLI's copy was not written.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwinIds {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl TwinIds {
    pub fn both(id: &str) -> Self {
        Self {
            claude: Some(id.to_string()),
            codex: Some(id.to_string()),
            extra: Default::default(),
        }
    }

    /// The same twins hold the same ids (unknown keys aside).
    pub fn same_ids(&self, other: &TwinIds) -> bool {
        self.claude == other.claude && self.codex == other.codex
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkVersion {
    /// The origin's commit the copy was taken from.
    #[serde(default)]
    pub commit: String,
    /// The skill directory's content id at that commit.
    #[serde(default)]
    pub content_id: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkOrigin {
    /// `team` (H3); `library`, `plyloft`, `workspace` arrive with later phases.
    #[serde(default)]
    pub kind: String,
    /// The library's GitHub `owner/name`.
    #[serde(default)]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    #[serde(default)]
    pub name: String,
    /// The directory inside the library the copy was read from
    /// (`library/claude/<plugin>/skills/<name>`), so "upstream" is always the
    /// same directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub version: LinkVersion,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// `.atelier/skill-links/<name>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLink {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub origin: LinkOrigin,
    #[serde(default)]
    pub base: TwinIds,
    /// H4's Keep mine. Written false by H3.
    #[serde(default)]
    pub kept_mine: bool,
    /// `YYYY-MM-DD`, the day the link was made or last advanced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_at: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// The link record's path for `skill`, relative to the workspace folder.
pub fn link_path(skill: &str) -> String {
    format!("{LINKS_DIR}/{skill}.json")
}

/// A link record, or why it can't be read.
pub fn parse(bytes: &[u8]) -> Result<SkillLink, String> {
    let link: SkillLink =
        serde_json::from_slice(bytes).map_err(|error| format!("not a link record ({error})"))?;
    if link.schema_version > SCHEMA_VERSION {
        return Err(format!(
            "written by a newer Plyloft (schema {}); update Plyloft to read it",
            link.schema_version
        ));
    }
    Ok(link)
}

/// The record's bytes as committed: pretty JSON and a final newline.
pub fn to_bytes(link: &SkillLink) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(link).unwrap_or_default();
    bytes.push(b'\n');
    bytes
}

/// Today as the record writes it.
pub fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// The link records in a checkout, by skill directory name. A file that can't
/// be read is listed with why, so the Library can say so instead of dropping
/// the link in silence.
pub fn read_checkout(cwd: &Path) -> (BTreeMap<String, SkillLink>, Vec<(String, String)>) {
    let mut links = BTreeMap::new();
    let mut unreadable = Vec::new();
    let Ok(entries) = std::fs::read_dir(cwd.join(LINKS_DIR)) else {
        return (links, unreadable);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".json"))
        else {
            continue;
        };
        if crate::project_skills::safe_name(name).ok().as_deref() != Some(name) {
            continue;
        }
        match std::fs::read(&path).map_err(|error| error.to_string()).and_then(|bytes| parse(&bytes)) {
            Ok(link) => {
                links.insert(name.to_string(), link);
            }
            Err(why) => unreadable.push((name.to_string(), why)),
        }
    }
    (links, unreadable)
}

// ── What a link says ─────────────────────────────────────────────────

/// What the origin answered for the linked skill.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Upstream {
    /// The origin can't be read on this Mac (another team, no clone, a
    /// library switched off, a clone mid-rebase or behind the link).
    Unavailable,
    /// The origin was read **after a pull that went past the link** and has
    /// no such skill now (H4, R8). Never declared from a failed read.
    Missing,
    /// H4 (R8 edge): the origin moved the skill to another directory name in
    /// the same plugin — the same content under a new name, or git's rename
    /// detection at 90 % or more, on every half the link's version held.
    Renamed {
        /// The new directory name.
        name: String,
        /// The new directory in the library (the half the link reads).
        path: String,
        /// Its content id now.
        id: String,
    },
    /// Its content id now.
    At(String),
}

impl Upstream {
    /// The content id the origin holds now, under the old name or a new one.
    pub fn id(&self) -> Option<&str> {
        match self {
            Upstream::At(id) | Upstream::Renamed { id, .. } => Some(id),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkState {
    UpToDate,
    UpdateAvailable,
    ModifiedHere,
    /// H4 (R3): modified here **and** the origin moved on to something else.
    BothChanged,
    NotAvailable,
    /// H4 (R8): the origin was read and no longer has the skill.
    Removed,
    /// H4 (R8 edge): the origin renamed it.
    Renamed,
}

/// Here ≠ base for a twin the link records: a twin it records that is gone
/// here counts too. A twin added here that the link never recorded is not an
/// edit of the linked copy (aligning twins is H5's).
pub fn modified_here(link: &SkillLink, here: &TwinIds) -> bool {
    let differs = |base: &Option<String>, now: &Option<String>| base.is_some() && base != now;
    differs(&link.base.claude, &here.claude) || differs(&link.base.codex, &here.codex)
}

/// The origin's copy moved on from the version the link records.
pub fn upstream_moved(link: &SkillLink, upstream: &Upstream) -> bool {
    matches!(upstream, Upstream::At(id) if *id != link.origin.version.content_id)
}

/// Every twin the link records holds exactly what the origin holds now —
/// the state a proposal that merged leaves (R3: "here = upstream and the row
/// returns to up to date with no further action").
pub fn here_is_upstream(link: &SkillLink, here: &TwinIds, upstream: &Upstream) -> bool {
    let Upstream::At(id) = upstream else {
        return false;
    };
    let recorded = [(&link.base.claude, &here.claude), (&link.base.codex, &here.codex)];
    recorded.iter().any(|(base, _)| base.is_some())
        && recorded
            .iter()
            .filter(|(base, _)| base.is_some())
            .all(|(_, now)| now.as_deref() == Some(id.as_str()))
}

/// The row's state (H4's state machine, R3/R8):
///
/// - here = upstream now → *up to date*, whatever the base says;
/// - the origin can't be read → *modified here* when it is, else *not
///   available* (absence is never "removed");
/// - read, and gone → *removed*; moved to a new name → *renamed* (both are
///   asked about whether or not the copy was edited here);
/// - modified here and moved upstream → *both changed*; one of them →
///   *modified here* / *update available*. *Modified here* is still the one
///   fact that stops a plain Update.
pub fn link_state(link: &SkillLink, here: &TwinIds, upstream: &Upstream) -> LinkState {
    if here_is_upstream(link, here, upstream) {
        return LinkState::UpToDate;
    }
    let modified = modified_here(link, here);
    match upstream {
        Upstream::Unavailable if modified => LinkState::ModifiedHere,
        Upstream::Unavailable => LinkState::NotAvailable,
        Upstream::Missing => LinkState::Removed,
        Upstream::Renamed { .. } => LinkState::Renamed,
        Upstream::At(_) => match (modified, upstream_moved(link, upstream)) {
            (true, true) => LinkState::BothChanged,
            (true, false) => LinkState::ModifiedHere,
            (false, true) => LinkState::UpdateAvailable,
            (false, false) => LinkState::UpToDate,
        },
    }
}

/// H4 (R3 *Keep mine*): the record after the member kept their copy over
/// the origin's version (`commit`, content id `id`): still linked, the
/// version and the base move to the origin's current one — so the copy reads
/// *Modified here* and only a later change upstream asks again. Unknown keys
/// are kept.
pub fn kept_mine(link: &SkillLink, commit: &str, id: &str) -> SkillLink {
    let mut next = link.clone();
    next.origin.version.commit = commit.to_string();
    next.origin.version.content_id = id.to_string();
    if next.base.claude.is_none() && next.base.codex.is_none() {
        next.base.claude = Some(id.to_string());
    }
    if next.base.claude.is_some() {
        next.base.claude = Some(id.to_string());
    }
    if next.base.codex.is_some() {
        next.base.codex = Some(id.to_string());
    }
    next.kept_mine = true;
    next.linked_at = Some(today());
    next
}

/// H4 Mac walk: the link as the comparison reads it once the copy here is
/// the library's version `commit` (content id `id`) — that version is the
/// starting point: version and every recorded twin's base move to it, and
/// *kept mine* no longer holds (the copy is the library's now). The record
/// on disk is unchanged; a card written later records this.
pub fn caught_up_link(link: &SkillLink, commit: &str, id: &str) -> SkillLink {
    let mut next = link.clone();
    next.origin.version.commit = commit.to_string();
    next.origin.version.content_id = id.to_string();
    if next.base.claude.is_some() {
        next.base.claude = Some(id.to_string());
    }
    if next.base.codex.is_some() {
        next.base.codex = Some(id.to_string());
    }
    next.kept_mine = false;
    next
}

/// H4 Windows walk (*Rename here* when the library's rename came with other
/// changes): the version stays the library's old one (its commit and content
/// id, which the clone's history still has under the old name), and every
/// recorded twin's base becomes `id` — that version with only the rename
/// brought in, what the copies here are when nobody edited them.
pub fn renamed_base(link: &SkillLink, id: &str) -> SkillLink {
    let mut next = link.clone();
    if next.base.claude.is_some() {
        next.base.claude = Some(id.to_string());
    }
    if next.base.codex.is_some() {
        next.base.codex = Some(id.to_string());
    }
    next.kept_mine = false;
    next
}

/// The two records start from the same version and base.
pub fn same_start(a: &SkillLink, b: &SkillLink) -> bool {
    a.origin.version.commit == b.origin.version.commit
        && a.origin.version.content_id == b.origin.version.content_id
        && a.base.same_ids(&b.base)
}

/// H4 Mac walk: `at_target` (the record a decision card rewrites, read on
/// the target branch) with the starting point the comparison used, when it
/// is the same record the checkout has (same version and base) and that
/// starting point moved on (`effective`). A target record that differs is
/// left as it is: the card's preflight judges it.
pub fn with_start(at_target: &SkillLink, checkout: &SkillLink, effective: &SkillLink) -> SkillLink {
    if !same_start(at_target, checkout) || effective.origin.version.commit == checkout.origin.version.commit {
        return at_target.clone();
    }
    let mut next = at_target.clone();
    next.origin.version.commit = effective.origin.version.commit.clone();
    next.origin.version.content_id = effective.origin.version.content_id.clone();
    next.base.claude = effective.base.claude.clone();
    next.base.codex = effective.base.codex.clone();
    next.kept_mine = effective.kept_mine;
    next
}

/// H4 (R8 *Keep the old name*): the record after the origin renamed the
/// skill and the member kept the directory's name here — linked to the new
/// directory; the version and the base are unchanged (a rename moves no
/// content), so a content change that came with it reads *Update available*.
pub fn relinked(link: &SkillLink, name: &str, path: &str) -> SkillLink {
    let mut next = link.clone();
    next.origin.name = name.to_string();
    next.origin.path = Some(path.to_string());
    next.linked_at = Some(today());
    next
}

/// How a row names the origin.
/// [`origin_words`] for a row whose origin this Mac can't read: a copy
/// linked to *someone's* My library names whose (R6 Challenger: "Linked to
/// matteo's My library — not available on this Mac"), since on a teammate's
/// computer "My library" would read as their own.
pub fn origin_words_unavailable(origin: &LinkOrigin) -> String {
    if origin.kind == KIND_LIBRARY {
        if let Some(owner) = origin.source.split('/').next().filter(|o| !o.is_empty()) {
            return format!("{owner}'s My library");
        }
    }
    origin_words(origin)
}

pub fn origin_words(origin: &LinkOrigin) -> String {
    match origin.kind.as_str() {
        KIND_TEAM => "the team library".to_string(),
        KIND_LIBRARY => "My library".to_string(),
        KIND_PLYLOFT => "Plyloft".to_string(),
        _ => origin.source.clone(),
    }
}

#[cfg(test)]
#[path = "skill_links_tests.rs"]
mod tests;
