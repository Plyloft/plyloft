//! Skills hub H3a (`docs/plans/SKILLS_HUB.md` §4.2, R2): **the skill card**.
//!
//! Install and Update no longer write the checkout. Each makes a card whose
//! worktree, cut from the target branch, already holds **one commit** Plyloft
//! wrote with plumbing (the checkout untouched): the skill's two copies
//! (`.claude/skills/<name>`, `.agents/skills/<name>`) and its link record
//! (`.atelier/skill-links/<name>.json`, [`crate::skill_links`]). The card is
//! created in Complete, opens at its Ship step, and ships through the
//! workspace's normal Ship now / pull request path (`commands::card_ship`) —
//! the card-scoped push exception, nothing else.
//!
//! - **Verify (§13 C1, §14 Q2).** Ship itself decides, on the commit it is
//!   about to publish, whether the card's diff against its base touches
//!   nothing but that skill's two directories and its link record
//!   ([`skill_only`]). Then it records a verify entry *Not needed — only
//!   skill files changed* for that exact tree ([`not_needed_entry`]) and
//!   publishes; no `skip_verify`, no `-unverified` tag. A skill card someone
//!   edited beyond its skill goes through Verify like any card. The same
//!   entry is recorded when Plyloft writes the commit, so Ship batch (which
//!   reads `verify_status`) takes skill cards like any verified card.
//! - **Worked on (§14 Q29).** Once a Builder or a swarm works on a skill
//!   card it is an ordinary card (`KanbanCard::skill_card`).
//! - **Go-live (§14 Q23).** A skill-only merge does not run the project's
//!   `install_script`: skills reach new sessions without a rebuild.
//! - **Preflight at Ship ([`preflight`]).** The target already holds exactly
//!   this change → *Already up to date*; the team changed the skill again →
//!   *refresh this card* ([`refresh`]); the repository's copy changed on the
//!   target since the card was made → never override: it ships as a pull
//!   request, with the reason.
//! - **Scripts (R15, H6a).** A team skill whose scripts wait for this Mac's
//!   OK is never installed or updated: the source must be a version this Mac
//!   may deliver. H3a refuses with the way to the *Needs your OK* sheet
//!   rather than install an older approved version (H6b adds the
//!   install-time sheet).
//!
//! The copies are written from one source half — the Claude half when the
//! library's Claude half loads it, the Codex half otherwise — as the
//! untracked Install read it (`project_skills::install_source`), so the
//! content id of each copy is the source directory's tree id.
//!
//! **Which copies (R2 edge, Challenger).** Only the CLIs the team skill
//! reaches get a copy ([`Reach`]): a Claude-only team skill writes only
//! `.claude/skills/<name>`, and its link records only that twin (`base.codex`
//! absent, §5.1); the row then offers *Make available to both*. A twin the
//! repository already holds is written too ([`roots_to_write`]), so a card
//! never leaves one copy at the old version beside the other at the new
//! (R12: Plyloft keeps the twins aligned at every write it owns).

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::kanban::{VerifyEntry, VerifyStatus};
use crate::shared_config::{Plumbing, TreeChange};
use crate::skill_links::{self, LinkOrigin, LinkVersion, SkillLink, TwinIds, Upstream};

/// What a skill card does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillVerb {
    Install,
    Update,
    /// Skills hub H3b (R-M): link repository copies that already equal a
    /// version of the library. The commit writes link records only.
    Link,
    /// Skills hub H4 (R3 *Keep mine*): the link record only — its version and
    /// base move to the library's current version; the copy stays as it is.
    KeepMine,
    /// H4 (R8 *Keep*, after a removal upstream): the link record is removed;
    /// the copies stay, an ordinary repository skill.
    Detach,
    /// H4 (R8 *Remove*): both copies and the link record are removed.
    Remove,
    /// H4 (R8 edge *Rename here*): both copies and the link record move to the
    /// library's new name; the content stays as it is here.
    Rename,
    /// H4 (R8 edge *Keep the old name*): the link record only — linked to the
    /// library's new directory, the name here unchanged.
    Relink,
    /// H5 (R12 *Align*): one twin replaced by the other, file for file
    /// (`SkillCard::align_winner` names the one that wins). Nothing else.
    Align,
    /// H8 (R5 *Copy to…*): a linked copy of another workspace's skill (or
    /// this Mac's own) — the copies and, when the origin can be named in a
    /// committed file, the link record. Its gate and preflight are Install's.
    Copy,
    /// Skills hub H9 (R9 *Personalize*): a skill that comes with Plyloft,
    /// copied into the repository as a linked fork (origin `plyloft`): both
    /// copies and the link record, nothing else. The fork itself switches
    /// Plyloft's own copy off wherever it is checked out (owner, 2026-10-20).
    Personalize,
    /// QoL block 13.1 (*Ship it with a card*): a skill written into the
    /// project folder (New skill, Promote → This repository, a written
    /// Install, an edit by hand), carried as it is there — its copies and,
    /// when the checkout holds one, its link record. No origin: it is the
    /// repository's own, so there is nothing to refresh and no link to read.
    Carry,
}

impl SkillVerb {
    pub fn word(self) -> &'static str {
        match self {
            SkillVerb::Install => "install",
            SkillVerb::Update => "update",
            SkillVerb::Link => "link",
            SkillVerb::KeepMine => "keep",
            SkillVerb::Detach => "unlink",
            SkillVerb::Remove => "remove",
            SkillVerb::Rename => "rename",
            SkillVerb::Relink => "relink",
            SkillVerb::Align => "align",
            SkillVerb::Copy => "copy",
            SkillVerb::Personalize => "personalize",
            SkillVerb::Carry => "ship",
        }
    }

    /// H4: a card that answers a decision about a linked copy (Keep mine, a
    /// removal, a rename). Its gate and preflight are [`decision_only`] and
    /// [`decision_preflight`]; the library moving on never asks to refresh it.
    pub fn is_decision(self) -> bool {
        matches!(
            self,
            SkillVerb::KeepMine | SkillVerb::Detach | SkillVerb::Remove | SkillVerb::Rename | SkillVerb::Relink
        )
    }
}

/// Skills hub H3b: one copy a Link card links. A *Link all* card carries
/// several (§4.2 "a card can carry several skills").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkItem {
    pub skill: String,
    /// The library's version this copy equals.
    pub origin: LinkOrigin,
    /// The target branch's two copies when the card was made: the base the
    /// link records, and what Ship expects to find again before it ships.
    #[serde(default)]
    pub here: TwinIds,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// `KanbanCard::kind = Skill`: the change a skill card carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCard {
    pub verb: SkillVerb,
    /// The skill directory's name in the repository.
    pub skill: String,
    /// The workspace folder's path inside its repository (`""` at the top,
    /// `sub/dir/` otherwise): every path the card writes starts with it.
    #[serde(default)]
    pub prefix: String,
    /// Where it comes from, at the version this card writes.
    pub origin: LinkOrigin,
    /// The target branch's two copies when the card was made — what "here"
    /// was. A target that moved from it since is a change somebody made, and
    /// Ship never overrides it.
    #[serde(default)]
    pub here: TwinIds,
    /// What the card's commit writes.
    #[serde(default)]
    pub content: TwinIds,
    /// Skills hub H3b: a Link card's copies, every one of them (the fields
    /// above repeat the first). Empty on Install and Update cards, and then
    /// not written, so an H3a card reads and writes unchanged.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<LinkItem>,
    /// Skills hub H4: the new directory name a Rename card moves the skill to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renamed_to: Option<String>,
    /// H4: the link record's blob id on the base the card was cut from —
    /// what a decision card expects to find again before it ships. Absent:
    /// no record there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_before: Option<String>,
    /// H4: the link record's blob id the card's commit writes (a Rename's at
    /// the new name). Absent: the card removes the record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_after: Option<String>,
    /// H5: the twin an Align card copies over the other. Absent on every
    /// other card, and then not written: an H4 card reads and writes
    /// unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align_winner: Option<crate::skill_reach::Side>,
    /// H8: the link of this card's copy is kept on this Mac only
    /// (`skills_hub/state.json` `localLinks`): its commit holds the copies
    /// and no link record. Absent (false) on every other card, and then not
    /// written: an H7 card reads and writes unchanged.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub local_link: bool,
    /// H8: how the card names where its copy came from ("astra"), when that
    /// is a workspace or this Mac's own skills — the origin's `source` can't
    /// say it. Absent on every other card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_words: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl SkillCard {
    /// The skill directories this card changes (a Rename's old and new).
    pub fn skills(&self) -> Vec<&str> {
        if self.links.is_empty() {
            let mut skills = vec![self.skill.as_str()];
            if let Some(to) = self.renamed_to.as_deref() {
                skills.push(to);
            }
            skills
        } else {
            self.links.iter().map(|item| item.skill.as_str()).collect()
        }
    }

    /// The card carries a change to `skill`.
    pub fn carries(&self, skill: &str) -> bool {
        self.skills().contains(&skill)
    }
}

/// The card's title (§4.2): `Skill: <verb> <name> from <origin>`; a Link
/// card's reads `Skill: link <name> to <origin>`.
pub fn card_title(verb: SkillVerb, skill: &str, origin: &LinkOrigin) -> String {
    let words = skill_links::origin_words(origin);
    match verb {
        SkillVerb::Link => format!("Skill: link {skill} to {words}"),
        // H4: the decisions say what happens, and to which copy.
        SkillVerb::KeepMine => format!("Skill: keep this repository's {skill} (linked to {words})"),
        SkillVerb::Detach => format!("Skill: unlink {skill} (removed from {words})"),
        SkillVerb::Remove => format!("Skill: remove {skill} (removed from {words})"),
        SkillVerb::Rename => format!("Skill: rename {skill} to {} (renamed in {words})", origin.name),
        SkillVerb::Relink => format!("Skill: link {skill} to {} in {words}", origin.name),
        _ => format!("Skill: {} {skill} from {words}", verb.word()),
    }
}

/// The commit message (§4.2): `skill: <verb> <name> (<origin words>)`.
pub fn commit_message(verb: SkillVerb, skill: &str, origin: &LinkOrigin) -> String {
    // H9: a Plyloft fork names the Plyloft version it was taken at.
    if origin.kind == skill_links::KIND_PLYLOFT {
        return format!(
            "skill: {} {skill} (Plyloft)\n\nWritten by Plyloft from the {skill} that comes with Plyloft {}.",
            verb.word(),
            origin.version.commit,
        );
    }
    format!(
        "skill: {} {skill} ({})\n\nWritten by Plyloft from {}{} at {}.",
        verb.word(),
        skill_links::origin_words(origin),
        origin.source,
        origin.plugin.as_deref().map(|p| format!(" ({p})")).unwrap_or_default(),
        short(&origin.version.commit),
    )
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(8)]
}

// ── Which copies a card writes ───────────────────────────────────────

/// The CLIs a copy is written for: the CLIs the team skill reaches (the
/// library's badges, `team_skills::TeamSkill::{claude, codex}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reach {
    pub claude: bool,
    pub codex: bool,
}

impl Reach {
    pub const BOTH: Reach = Reach { claude: true, codex: true };

    /// The roots this reach writes.
    pub fn roots(self) -> Vec<&'static str> {
        let mut roots = Vec::new();
        if self.claude {
            roots.push(skill_links::CLAUDE_ROOT);
        }
        if self.codex {
            roots.push(skill_links::CODEX_ROOT);
        }
        roots
    }

    /// The content ids the written copies get: `id` for each written twin,
    /// absent for the other (§5.1 "Absent twin = that CLI was not written").
    pub fn ids(self, id: &str) -> TwinIds {
        TwinIds {
            claude: self.claude.then(|| id.to_string()),
            codex: self.codex.then(|| id.to_string()),
            extra: Default::default(),
        }
    }

    /// "Claude", "Codex" or "Claude and Codex".
    pub fn words(self) -> &'static str {
        match (self.claude, self.codex) {
            (true, false) => "Claude",
            (false, true) => "Codex",
            _ => "Claude and Codex",
        }
    }
}

/// The copies a card writes: those the skill reaches, plus any twin the
/// repository already holds (`here`), so the two never end up at different
/// versions. A reach of neither (a library entry with no badge) writes both,
/// as before.
pub fn roots_to_write(reach: Reach, here: &TwinIds) -> Reach {
    let written = Reach {
        claude: reach.claude || here.claude.is_some(),
        codex: reach.codex || here.codex.is_some(),
    };
    if written.claude || written.codex {
        written
    } else {
        Reach::BOTH
    }
}

// ── The source: one skill directory of a library, from git objects ──

/// One file of a source skill, with its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFile {
    /// Relative to the skill directory, with `/`.
    pub path: String,
    pub bytes: Vec<u8>,
    pub executable: bool,
}

/// One skill directory of a library at one commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub commit: String,
    /// The directory in the library (`library/claude/<plugin>/skills/<name>`).
    pub path: String,
    /// Its tree id: the content id both copies get.
    pub tree: String,
    pub files: Vec<SourceFile>,
}

/// A skill directory's files at `commit` of `repo`: every blob, refusing a
/// symbolic link or a submodule anywhere in it (`project_skills::read_tree`
/// refuses them in a checkout too), and any path that would leave the
/// directory it is written to.
pub fn read_source(repo: &Path, commit: &str, path: &str) -> Result<Source, String> {
    let tree = crate::library_snapshot::entry_tree(repo, commit, path)?
        .ok_or_else(|| format!("The library has no files at {path}."))?;
    let out = crate::library_snapshot::git(repo, &["ls-tree", "-r", "-z", "-l", commit, "--", &format!("{path}/")])?;
    let prefix = format!("{path}/");
    let mut listed = Vec::new();
    for record in out.split(|byte| *byte == 0).filter(|record| !record.is_empty()) {
        let record = String::from_utf8_lossy(record);
        let Some((meta, full)) = record.split_once('\t') else {
            continue;
        };
        let mut fields = meta.split_whitespace();
        let (mode, kind, id, size) = (fields.next(), fields.next(), fields.next(), fields.next());
        let inside = full.strip_prefix(&prefix).unwrap_or(full).to_string();
        match (mode, kind) {
            (Some("120000"), _) => {
                return Err(format!("{full} is a symbolic link; Plyloft doesn't copy a skill that carries one."))
            }
            (_, Some("commit")) => {
                return Err(format!("{full} is a submodule; Plyloft doesn't copy a skill that carries one."))
            }
            (Some(mode), Some("blob")) => {
                if !crate::library_snapshot::is_safe_tree_path(&inside) {
                    return Err(format!("{full} isn't a path Plyloft can write safely."));
                }
                listed.push(crate::library_snapshot::TreeFile {
                    path: inside,
                    id: id.unwrap_or_default().to_string(),
                    size: size.and_then(|size| size.parse().ok()).unwrap_or(0),
                    executable: mode == "100755",
                });
            }
            _ => {}
        }
    }
    if listed.is_empty() {
        return Err(format!("The library has no files at {path}."));
    }
    let blobs = crate::library_snapshot::cat_blobs(repo, &listed)?;
    Ok(Source {
        commit: commit.to_string(),
        path: path.to_string(),
        tree,
        files: listed
            .into_iter()
            .zip(blobs)
            .map(|(file, bytes)| SourceFile {
                path: file.path,
                bytes,
                executable: file.executable,
            })
            .collect(),
    })
}

/// `dir` (inside `clone`) as the repository path git knows it by.
pub fn repo_path_of(clone: &Path, dir: &Path) -> Option<String> {
    let rel = dir.strip_prefix(clone).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// The words every scripts refusal carries (`skillCards.ts`
/// `SCRIPTS_WAIT_MARKER` reads them to show the Install-time sheet).
/// Skills hub H6b: the refusals are `skill_scripts::repo::repo_answer`'s.
pub const SCRIPTS_WAIT_MARKER: &str = "you haven't said OK to";

// ── Reading a repository ─────────────────────────────────────────────

/// The workspace folder's path inside its repository, `""` at the top or
/// `sub/dir/`: every path a card commits carries it.
pub fn workspace_prefix(cwd: &Path) -> Result<String, String> {
    let out = crate::library_snapshot::git(cwd, &["rev-parse", "--show-prefix"])?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// The tree `path` names at `rev`, if it is one.
fn tree_at(repo: &Path, rev: &str, path: &str) -> Option<String> {
    crate::library_snapshot::entry_tree(repo, rev, path).ok().flatten()
}

/// Both copies' content ids at `rev`.
pub fn twin_ids_at(repo: &Path, rev: &str, prefix: &str, skill: &str) -> TwinIds {
    TwinIds {
        claude: tree_at(repo, rev, &format!("{prefix}{}/{skill}", skill_links::CLAUDE_ROOT)),
        codex: tree_at(repo, rev, &format!("{prefix}{}/{skill}", skill_links::CODEX_ROOT)),
        extra: Default::default(),
    }
}

/// The link record at `rev`, when it is there and readable.
pub fn link_at(repo: &Path, rev: &str, prefix: &str, skill: &str) -> Option<SkillLink> {
    link_read_at(repo, rev, prefix, skill).ok().flatten()
}

/// The link record at `rev`: absent, read, or there and unreadable (a newer
/// schema, a damaged file) — which a card must never write over.
pub fn link_read_at(repo: &Path, rev: &str, prefix: &str, skill: &str) -> Result<Option<SkillLink>, String> {
    let path = format!("{prefix}{}", skill_links::link_path(skill));
    let Ok(out) = crate::library_snapshot::git(repo, &["cat-file", "blob", &format!("{rev}:{path}")]) else {
        return Ok(None);
    };
    skill_links::parse(&out)
        .map(Some)
        .map_err(|why| format!("{path} can't be read: {why}. Plyloft won't write over it."))
}

/// Both copies' content ids in the checkout's working tree, as git would add
/// them (autocrlf and clean filters applied, §8).
pub fn checkout_twin_ids(cwd: &Path, skill: &str) -> TwinIds {
    let git = Plumbing { cwd: cwd.to_path_buf() };
    let id = |root: &str| crate::shared_library_sync::checkout_root_tree(&git, cwd, root, skill, Some("HEAD"));
    TwinIds {
        claude: id(skill_links::CLAUDE_ROOT),
        codex: id(skill_links::CODEX_ROOT),
        extra: Default::default(),
    }
}

/// What the origin says now for a copy of `origin` whose library is the
/// clone at `clone` (`None`: not readable on this Mac).
///
/// Never *Removed* or *Renamed*: those are claims a caller makes only from a
/// read it trusts ([`upstream_trusted`], H4).
pub fn upstream_of(clone: Option<&Path>, origin: &LinkOrigin) -> Upstream {
    upstream_trusted(clone, origin, false)
}

/// [`upstream_of`], and — when `removal_trusted` — *Removed* or *Renamed*
/// from a read past the link ([`crate::skill_upstream::read`]).
pub fn upstream_trusted(clone: Option<&Path>, origin: &LinkOrigin, removal_trusted: bool) -> Upstream {
    match clone {
        Some(clone) => crate::skill_upstream::read(clone, origin, removal_trusted),
        None => Upstream::Unavailable,
    }
}

// ── The commit ───────────────────────────────────────────────────────

/// The link record a card commits: `previous`'s unknown keys kept, the
/// origin at `source`'s version, the base at what the copies `written` now
/// hold (a twin not written is absent from it).
pub fn link_for(previous: Option<&SkillLink>, origin: &LinkOrigin, source: &Source, written: Reach) -> SkillLink {
    let mut link = previous.cloned().unwrap_or(SkillLink {
        schema_version: skill_links::SCHEMA_VERSION,
        origin: LinkOrigin::default(),
        base: TwinIds::default(),
        kept_mine: false,
        linked_at: None,
        extra: Default::default(),
    });
    // The record's unknown keys stay; what the origin itself carries there
    // (H8: a local link's workspace) is written over them.
    let mut extra = std::mem::take(&mut link.origin.extra);
    extra.extend(origin.extra.clone());
    let version_extra = std::mem::take(&mut link.origin.version.extra);
    link.schema_version = skill_links::SCHEMA_VERSION;
    // H8 (Mac re-walk): a copy of this Mac's own skill is read from its
    // folder (`.claude/skills/<n>` under home), not from where it was staged
    // in `stage.git` (`<n>`, a commit nobody else has) — its path and commit
    // stay the origin's.
    let this_mac = origin.kind == crate::skill_copy::KIND_THIS_MAC;
    link.origin = LinkOrigin {
        version: LinkVersion {
            commit: if this_mac { origin.version.commit.clone() } else { source.commit.clone() },
            content_id: source.tree.clone(),
            extra: version_extra,
        },
        path: if this_mac { origin.path.clone() } else { Some(source.path.clone()) },
        extra,
        ..origin.clone()
    };
    let base_extra = std::mem::take(&mut link.base.extra);
    link.base = TwinIds { extra: base_extra, ..written.ids(&source.tree) };
    link.kept_mine = false;
    link.linked_at = Some(skill_links::today());
    link
}

/// The changes one card commit makes on top of `parent`: the copies
/// `written` become exactly `source` (files the parent has there and the
/// source doesn't are removed), the other root is left as it is, and the
/// link record is written.
pub fn changes_for(
    repo: &Path,
    parent: &str,
    prefix: &str,
    skill: &str,
    source: &Source,
    link: &SkillLink,
    written: Reach,
) -> Vec<TreeChange> {
    let git = Plumbing { cwd: repo.to_path_buf() };
    let mut changes = Vec::new();
    for root in written.roots() {
        let dir = format!("{prefix}{root}/{skill}");
        let wanted: std::collections::BTreeSet<String> =
            source.files.iter().map(|file| format!("{dir}/{}", file.path)).collect();
        for entry in git.ls_tree(parent, &dir, true) {
            if !wanted.contains(&entry.path) {
                changes.push(TreeChange { path: entry.path, content: None });
            }
        }
        for file in &source.files {
            changes.push(TreeChange {
                path: format!("{dir}/{}", file.path),
                content: Some((file.bytes.clone(), file.executable)),
            });
        }
    }
    changes.push(TreeChange {
        path: format!("{prefix}{}", skill_links::link_path(skill)),
        content: Some((skill_links::to_bytes(link), false)),
    });
    changes
}

/// Commit `changes` on top of `parent` in the worktree `wt` and move the
/// worktree's branch and files to it (a fast-forward: nothing in the
/// worktree is lost, and a worktree that moved meanwhile refuses).
pub fn commit_into_worktree(wt: &Path, parent: &str, changes: &[TreeChange], message: &str) -> Result<String, String> {
    let git = Plumbing { cwd: wt.to_path_buf() };
    let sha = git.commit_tree_changes(parent, changes, message)?;
    crate::library_snapshot::git(wt, &["merge", "--ff-only", "--quiet", &sha])
        .map_err(|error| format!("couldn't move the card's worktree to its commit ({error})"))?;
    Ok(sha)
}

/// Mac walk 2 (H3a): **Refresh card** leaves the card as a fresh Update
/// card would be — one commit on the card's base — instead of stacking a
/// second commit on the first. Commit `changes` on top of `base` and move the
/// worktree's branch and files there from `head` (`reset --keep`: a clean
/// worktree loses nothing, and one that moved since `head` was read
/// refuses).
pub fn recommit_worktree(wt: &Path, base: &str, head: &str, changes: &[TreeChange], message: &str) -> Result<String, String> {
    let git = Plumbing { cwd: wt.to_path_buf() };
    let sha = git.commit_tree_changes(base, changes, message)?;
    if crate::worktrees::head_sha(wt)? != head {
        return Err("The card's worktree moved while Plyloft was refreshing it. Try again.".into());
    }
    crate::library_snapshot::git(wt, &["reset", "--keep", "--quiet", &sha])
        .map_err(|error| format!("couldn't move the card's worktree to its commit ({error})"))?;
    Ok(sha)
}

/// Whether the origin has a newer version of the card's skill than the card
/// carries (`upstream`: what the origin says now) — the card then offers
/// **Refresh card**, before any Ship is refused.
pub fn card_behind(card: &SkillCard, upstream: &Upstream) -> bool {
    // H3b: a Link card records the version each copy already is — the
    // origin moving on makes the linked row offer Update after it ships,
    // never a stale card to refresh.
    // H8: a copy from another workspace (or this Mac) ships the version it
    // copied; once it lands, the row offers Update. Never a card to refresh.
    card.verb != SkillVerb::Link
        && card.verb != SkillVerb::Align
        // 13.1: the project folder's own copy has no origin to move on.
        && card.verb != SkillVerb::Carry
        && !card.verb.is_decision()
        && !crate::skill_copy::is_copy_origin(&card.origin)
        && matches!(upstream, Upstream::At(id) if *id != card.origin.version.content_id)
}

// ── Ship ─────────────────────────────────────────────────────────────

/// The verify entry a skill-only commit gets (§4.2 "Ship's tree gate").
pub const NOT_NEEDED_SUMMARY: &str = "Not needed — only skill files changed";
/// Its run id's lead, so the card page can say *Not needed* rather than
/// *Passed*.
pub const NOT_NEEDED_RUN_PREFIX: &str = "not-needed-";

pub fn not_needed_entry(tree: &str) -> VerifyEntry {
    VerifyEntry {
        verify_run_id: format!("{NOT_NEEDED_RUN_PREFIX}{}", uuid::Uuid::new_v4().simple()),
        status: VerifyStatus::Passed,
        ended_at: chrono::Utc::now().timestamp_millis(),
        summary: Some(NOT_NEEDED_SUMMARY.to_string()),
        steps: Vec::new(),
        tree_sha: Some(tree.to_string()),
    }
}

/// A path a skill card for `skill` may change.
pub fn allowed_path(path: &str, prefix: &str, skill: &str) -> bool {
    let Some(rest) = path.strip_prefix(prefix) else {
        return false;
    };
    [skill_links::CLAUDE_ROOT, skill_links::CODEX_ROOT]
        .iter()
        .any(|root| rest.strip_prefix(root).and_then(|r| r.strip_prefix('/')).and_then(|r| r.strip_prefix(skill)).is_some_and(|r| r.starts_with('/')))
        || rest == skill_links::link_path(skill)
}

/// Whether `head`'s changes since `base` touch nothing but `skill`'s two
/// copies and its link record. `base` must be in `head`'s history: a card
/// branch someone merged the target into is not "only the skill".
///
/// Challenger (H3a): what `head` writes there must be plain files too — a
/// symbolic link (which could point a skill at any file of the repository,
/// or outside it) or a submodule added under a skill directory is not a
/// skill change Plyloft would ever write ([`read_source`] refuses both), so
/// it goes through Verify. The card's own `skill` and `prefix` (read from
/// the board) must be a plain directory name and a plain folder path.
pub fn skill_only(repo: &Path, base: &str, head: &str, prefix: &str, skill: &str) -> bool {
    if crate::project_skills::safe_name(skill).ok().as_deref() != Some(skill) {
        return false;
    }
    let plain_prefix = prefix.is_empty()
        || (prefix.ends_with('/')
            && prefix
                .trim_end_matches('/')
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."));
    if !plain_prefix {
        return false;
    }
    let ancestor = crate::library_snapshot::git(repo, &["merge-base", "--is-ancestor", base, head]).is_ok();
    if !ancestor {
        return false;
    }
    let Ok(out) = crate::library_snapshot::git(repo, &["diff", "--raw", "-z", "--no-renames", "--no-abbrev", base, head, "--"])
    else {
        return false;
    };
    // `:<old mode> <new mode> <old id> <new id> <status>\0<path>\0`, per path.
    let fields: Vec<String> = out
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8_lossy(field).into_owned())
        .collect();
    if fields.is_empty() || fields.len() % 2 != 0 {
        return false;
    }
    fields.chunks(2).all(|entry| {
        let new_mode = entry[0].trim_start_matches(':').split(' ').nth(1).unwrap_or("");
        let plain = matches!(new_mode, "100644" | "100755" | "000000");
        plain && allowed_path(&entry[1], prefix, skill)
    })
}

/// `(new mode, path)` of every path `head` changed since `base`, when
/// `base` is in its history.
fn changed_since(repo: &Path, base: &str, head: &str) -> Option<Vec<(String, String)>> {
    crate::library_snapshot::git(repo, &["merge-base", "--is-ancestor", base, head]).ok()?;
    let out = crate::library_snapshot::git(repo, &["diff", "--raw", "-z", "--no-renames", "--no-abbrev", base, head, "--"]).ok()?;
    // `:<old mode> <new mode> <old id> <new id> <status>\0<path>\0`, per path.
    let fields: Vec<String> = out
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8_lossy(field).into_owned())
        .collect();
    if fields.len() % 2 != 0 {
        return None;
    }
    Some(
        fields
            .chunks(2)
            .map(|entry| (entry[0].trim_start_matches(':').split(' ').nth(1).unwrap_or("").to_string(), entry[1].clone()))
            .collect(),
    )
}

/// The card's own prefix is a plain folder path (`""` or `a/b/`).
fn plain_prefix(prefix: &str) -> bool {
    prefix.is_empty()
        || (prefix.ends_with('/')
            && prefix
                .trim_end_matches('/')
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."))
}

/// Ship's tree gate for any skill card (§4.2): an Install or Update card
/// may change its skill's two copies and its link record ([`skill_only`]);
/// a Link card (H3b) only the link records of the skills it carries, as
/// plain files (never a symbolic link or a submodule, as H3a's gate) — a
/// copy changed on a Link card is not a migration any more, so it goes
/// through Verify like any card. The skills and the prefix read from the
/// board must be plain names and a plain folder path.
pub fn card_only(repo: &Path, base: &str, head: &str, card: &SkillCard) -> bool {
    if card.verb.is_decision() {
        return decision_only(repo, base, head, card);
    }
    if card.verb == SkillVerb::Align {
        return align_only(repo, base, head, card);
    }
    if card.verb != SkillVerb::Link {
        return skill_only(repo, base, head, &card.prefix, &card.skill);
    }
    let skills = card.skills();
    let plain_names = skills
        .iter()
        .all(|skill| crate::project_skills::safe_name(skill).ok().as_deref() == Some(*skill));
    if !plain_names || !plain_prefix(&card.prefix) {
        return false;
    }
    let Some(changes) = changed_since(repo, base, head) else {
        return false;
    };
    let allowed: Vec<String> = skills
        .iter()
        .map(|skill| format!("{}{}", card.prefix, skill_links::link_path(skill)))
        .collect();
    !changes.is_empty()
        && changes
            .iter()
            // A Link card writes link records; it never removes one.
            .all(|(mode, path)| mode == "100644" && allowed.contains(path))
}

/// What Ship's preflight found (§4.2 "Preflight at Ship").
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Preflight {
    Go,
    /// The target already holds exactly this change.
    UpToDate,
    /// The origin changed the skill again since the card was made.
    RefreshNeeded,
    /// The target's copy changed since the card was made; why, in words.
    HereMoved(String),
}

pub const UP_TO_DATE_WORDS: &str = "Already up to date — someone shipped this change. Delete this card.";
/// Mac walk 2: said once, plainly — the toast's title is only "Not shipped".
pub const REFRESH_WORDS: &str =
    "The team library has a newer version of this skill than the card carries. Refresh the card, then ship it.";

/// The preflight, from the target's tip, the card's record and what the
/// origin says now.
pub fn preflight(
    repo: &Path,
    tip: &str,
    prefix: &str,
    card: &SkillCard,
    upstream: &Upstream,
    branch: &str,
) -> Preflight {
    preflight_at(repo, &[tip], prefix, card, upstream, branch)
}

/// [`preflight`] against every tip the ship can land on (Challenger, H3a):
/// the target as fetched, and the local target branch a local merge lands
/// on when it has commits origin lacks. Any of them already holding the
/// change is *Already up to date*; any of them whose copy moved since the
/// card was made is never overridden.
pub fn preflight_at(
    repo: &Path,
    tips: &[&str],
    prefix: &str,
    card: &SkillCard,
    upstream: &Upstream,
    branch: &str,
) -> Preflight {
    if card.verb == SkillVerb::Link {
        return link_preflight(repo, tips, prefix, card, branch);
    }
    if card.verb.is_decision() {
        return decision_preflight(repo, tips, prefix, card, branch);
    }
    if card.verb == SkillVerb::Align {
        return align_preflight(repo, tips, prefix, card, branch);
    }
    // H8: a card whose link is kept on this Mac commits no record: its
    // copies alone say it shipped. 13.1: neither does a carry card's
    // (the record it carries, if any, is the checkout's own).
    let shipped_at = |tip: &str| {
        twin_ids_at(repo, tip, prefix, &card.skill).same_ids(&card.content)
            && (card.local_link
                || card.verb == SkillVerb::Carry
                || link_at(repo, tip, prefix, &card.skill).is_some_and(|link| {
                    link.base.same_ids(&card.content) && link.origin.version.content_id == card.origin.version.content_id
                }))
    };
    if tips.iter().any(|tip| shipped_at(tip)) {
        return Preflight::UpToDate;
    }
    if card_behind(card, upstream) {
        return Preflight::RefreshNeeded;
    }
    if tips.iter().any(|tip| !twin_ids_at(repo, tip, prefix, &card.skill).same_ids(&card.here)) {
        return Preflight::HereMoved(format!(
            "{} changed on {branch} since this card was made, so it ships as a pull request for \
             you to review instead of replacing that change.",
            card.skill
        ));
    }
    Preflight::Go
}

/// `path` is in `rev`'s tree (readable or not).
fn exists_at(repo: &Path, rev: &str, path: &str) -> bool {
    crate::library_snapshot::git(repo, &["cat-file", "-e", &format!("{rev}:{path}")]).is_ok()
}

/// H3b: a Link card's preflight. Every copy it links already linked at the
/// same version on the target → *Already up to date*. A copy that changed
/// on the target since the card was made, or that somebody linked there
/// meanwhile (to anything else), is a change Ship never overrides: it ships
/// as a pull request with the reason. The origin moving on is no reason to
/// refresh: the link records the version the copy *is*, and the row then
/// offers Update.
///
/// Against every tip the ship can land on (the fetched target and the local
/// target branch, as H3a's [`preflight_at`]): any tip already holding every
/// link is *Already up to date*; any tip that moved is never overridden.
fn link_preflight(repo: &Path, tips: &[&str], prefix: &str, card: &SkillCard, branch: &str) -> Preflight {
    if card.links.is_empty() {
        return Preflight::Go;
    }
    let shipped = |tip: &str, item: &LinkItem| {
        twin_ids_at(repo, tip, prefix, &item.skill).same_ids(&item.here)
            && link_at(repo, tip, prefix, &item.skill).is_some_and(|link| {
                link.base.same_ids(&item.here) && link.origin.version.content_id == item.origin.version.content_id
            })
    };
    if tips.iter().any(|tip| card.links.iter().all(|item| shipped(tip, item))) {
        return Preflight::UpToDate;
    }
    for tip in tips {
        if let Some(why) = link_moved_at(repo, tip, prefix, card, branch, &shipped) {
            return Preflight::HereMoved(why);
        }
    }
    Preflight::Go
}

/// Why a Link card can't land on `tip` as it is, if it can't.
fn link_moved_at(
    repo: &Path,
    tip: &str,
    prefix: &str,
    card: &SkillCard,
    branch: &str,
    shipped: &dyn Fn(&str, &LinkItem) -> bool,
) -> Option<String> {
    for item in &card.links {
        if shipped(tip, item) {
            continue;
        }
        let target = twin_ids_at(repo, tip, prefix, &item.skill);
        if !target.same_ids(&item.here) {
            return Some(format!(
                "{} changed on {branch} since this card was made, so it ships as a pull request for \
                 you to review instead of linking a copy that isn't there any more.",
                item.skill
            ));
        }
        if exists_at(repo, tip, &format!("{prefix}{}", skill_links::link_path(&item.skill))) {
            return Some(format!(
                "{} was linked on {branch} since this card was made, so it ships as a pull request \
                 for you to review instead of replacing that link.",
                item.skill
            ));
        }
    }
    None
}

/// The words a card says about itself (its brief).
pub fn card_notes(verb: SkillVerb, skill: &str, origin: &LinkOrigin, repo_words: &str, written: Reach) -> String {
    let what = match verb {
        SkillVerb::Install => "installs",
        SkillVerb::Update => "updates",
        // A Link card's own words are `skill_migration::link_card_notes`,
        // and H4's decisions have theirs in [`decision_notes`].
        SkillVerb::Link => "links",
        SkillVerb::Personalize => return personalize_notes(skill, origin, repo_words, written),
        _ => return decision_notes(verb, skill, origin, repo_words),
    };
    let into = written
        .roots()
        .iter()
        .map(|root| format!("{root}/{skill}"))
        .collect::<Vec<_>>()
        .join(" and ");
    // H4 Mac walk (P-D2): no commit code in the card's words; the commit
    // message and the link record carry the version.
    format!(
        "Plyloft made this card: it {what} {skill} from {}'s current version, into {into}, with its \
         link record in .atelier/skill-links/{skill}.json. Once it ships, everyone who opens \
         {repo_words} gets it, in {}, from their next session.",
        skill_links::origin_words(origin),
        written.words(),
    )
}

/// H9: a Personalize card's brief — what it writes, what it switches off,
/// and who gets which copy when.
pub fn personalize_notes(skill: &str, origin: &LinkOrigin, repo_words: &str, written: Reach) -> String {
    let into = written
        .roots()
        .iter()
        .map(|root| format!("{root}/{skill}"))
        .collect::<Vec<_>>()
        .join(" and ");
    format!(
        "Plyloft made this card: it copies the {skill} that comes with Plyloft ({}) into {into}, \
         with its link record in .atelier/skill-links/{skill}.json. Once it ships, everyone who \
         opens {repo_words} gets this repository's {skill} in {} from their next session after \
         they pull it, and no longer ply:{skill} there; until they pull, they keep ply:{skill}. \
         Other workspaces keep Plyloft's.",
        origin.version.commit,
        written.words(),
    )
}

/// H4 Mac walk: *Take upstream*'s own title — an Update by what it does,
/// but it replaces an edit made here, so it doesn't read as one.
pub fn take_upstream_title(skill: &str, origin: &LinkOrigin) -> String {
    format!("Skill: take {}'s {skill}", skill_links::origin_words(origin))
}

/// *Take upstream*'s brief: what it replaces, and who gets what when.
pub fn take_upstream_notes(skill: &str, origin: &LinkOrigin, repo_words: &str, written: Reach) -> String {
    let into = written
        .roots()
        .iter()
        .map(|root| format!("{root}/{skill}"))
        .collect::<Vec<_>>()
        .join(" and ");
    format!(
        "Plyloft made this card: you chose to take {}'s {skill} over this repository's changes. It \
         replaces {into} with {}'s current version, with its link record in \
         .atelier/skill-links/{skill}.json. Once it ships, everyone who opens {repo_words} gets \
         it, in {}, from their next session.",
        skill_links::origin_words(origin),
        skill_links::origin_words(origin),
        written.words(),
    )
}

// ── Skills hub H4: the decision cards ───────────────────────────────

/// The blob id of `path` at `rev`, when it is a file there.
pub fn blob_at(repo: &Path, rev: &str, path: &str) -> Option<String> {
    let out = crate::library_snapshot::git(repo, &["rev-parse", "--verify", "--quiet", &format!("{rev}:{path}")]).ok()?;
    let id = String::from_utf8_lossy(&out).trim().to_string();
    (!id.is_empty()).then_some(id)
}

/// The link record's path of `skill` in the repository.
pub fn link_repo_path(prefix: &str, skill: &str) -> String {
    format!("{prefix}{}", skill_links::link_path(skill))
}

/// H4 Windows walk: the content id (git tree id) `files` would have as a
/// skill directory, hashed by `repo`'s git **without writing anything**
/// (`hash-object` without `-w`; stdin is hashed as is, no filters) — so it
/// is the id a checkout holding exactly these bytes reads.
pub fn tree_id_of(repo: &Path, files: &[SourceFile]) -> Result<String, String> {
    fn hex_bytes(hex: &str) -> Result<Vec<u8>, String> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("zz"), 16).map_err(|_| format!("not an object id: {hex}")))
            .collect()
    }
    fn hash(repo: &Path, kind: &str, bytes: &[u8]) -> Result<String, String> {
        let out = crate::library_snapshot::git_with_stdin(repo, &["hash-object", "-t", kind, "--stdin"], bytes)?;
        Ok(String::from_utf8_lossy(&out).trim().to_string())
    }
    fn tree(repo: &Path, files: &[(&str, &SourceFile)]) -> Result<String, String> {
        // (sort key, mode, name, id): git orders a directory as `name/`.
        let mut entries: Vec<(String, &str, String, String)> = Vec::new();
        let mut dirs: std::collections::BTreeMap<&str, Vec<(&str, &SourceFile)>> = Default::default();
        for (rel, file) in files {
            match rel.split_once('/') {
                Some((dir, rest)) => dirs.entry(dir).or_default().push((rest, *file)),
                None => {
                    let mode = if file.executable { "100755" } else { "100644" };
                    entries.push((rel.to_string(), mode, rel.to_string(), hash(repo, "blob", &file.bytes)?));
                }
            }
        }
        for (dir, inner) in dirs {
            entries.push((format!("{dir}/"), "40000", dir.to_string(), tree(repo, &inner)?));
        }
        entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let mut bytes = Vec::new();
        for (_, mode, name, id) in entries {
            bytes.extend_from_slice(format!("{mode} {name}\0").as_bytes());
            bytes.extend(hex_bytes(&id)?);
        }
        hash(repo, "tree", &bytes)
    }
    let all: Vec<(&str, &SourceFile)> = files.iter().map(|f| (f.path.as_str(), f)).collect();
    tree(repo, &all)
}

/// H4 Mac walk: what *Rename here* brings in of the library's rename
/// inside `SKILL.md` — the library's own `name:` line and `# heading` line
/// at the new name (its exact spelling, quotes included), when it has them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RenameText {
    pub old: String,
    pub new: String,
    pub name_line: Option<String>,
    pub heading_line: Option<String>,
}

fn unquoted(value: &str) -> &str {
    let value = value.trim();
    for quote in ['"', '\''] {
        if let Some(inner) = value.strip_prefix(quote).and_then(|v| v.strip_suffix(quote)) {
            return inner;
        }
    }
    value
}

/// `(frontmatter name line index, heading line index)` in `lines` whose
/// name / heading text is `name`.
fn name_and_heading(lines: &[&str], name: &str) -> (Option<usize>, Option<usize>) {
    let bare = |line: &str| line.trim_end_matches(['\r', '\n']).to_string();
    let mut name_at = None;
    let mut heading_at = None;
    let mut body_from = 0;
    if lines.first().map(|l| bare(l).trim() == "---").unwrap_or(false) {
        for (i, line) in lines.iter().enumerate().skip(1) {
            let line = bare(line);
            if line.trim() == "---" {
                body_from = i + 1;
                break;
            }
            if let Some(value) = line.trim_start().strip_prefix("name:") {
                if name_at.is_none() && unquoted(value) == name {
                    name_at = Some(i);
                }
            }
        }
    }
    for (i, line) in lines.iter().enumerate().skip(body_from) {
        let line = bare(line);
        if let Some(text) = line.strip_prefix("# ") {
            if text.trim() == name {
                heading_at = Some(i);
            }
            break;
        }
    }
    (name_at, heading_at)
}

impl RenameText {
    /// The library's own lines for the new name, read from its `SKILL.md`
    /// after the rename.
    pub fn from_library(old: &str, new: &str, library_skill_md: Option<&[u8]>) -> Self {
        let mut text = RenameText { old: old.to_string(), new: new.to_string(), ..Default::default() };
        if let Some(bytes) = library_skill_md {
            let s = String::from_utf8_lossy(bytes);
            let lines: Vec<&str> = s.split_inclusive('\n').collect();
            let (name_at, heading_at) = name_and_heading(&lines, new);
            let bare = |i: usize| lines[i].trim_end_matches(['\r', '\n']).to_string();
            text.name_line = name_at.map(bare);
            text.heading_line = heading_at.map(bare);
        }
        text
    }

    /// `SKILL.md` with the rename brought in: the frontmatter's `name:` and
    /// the first `# heading` when they say the old name **and** the library
    /// changed them to the new one (its own line, as it wrote it), and
    /// nothing else (this repository's other edits stay; a library that
    /// moved the folder only changes nothing inside). Line endings kept.
    pub fn apply(&self, bytes: &[u8]) -> Vec<u8> {
        let Ok(s) = std::str::from_utf8(bytes) else {
            return bytes.to_vec();
        };
        let lines: Vec<&str> = s.split_inclusive('\n').collect();
        let (name_at, heading_at) = name_and_heading(&lines, &self.old);
        let mut out = String::with_capacity(s.len() + 16);
        for (i, line) in lines.iter().enumerate() {
            let ending = &line[line.trim_end_matches(['\r', '\n']).len()..];
            let theirs = if Some(i) == name_at {
                self.name_line.as_ref()
            } else if Some(i) == heading_at {
                self.heading_line.as_ref()
            } else {
                None
            };
            if let Some(own) = theirs {
                out.push_str(own);
                out.push_str(ending);
            } else {
                out.push_str(line);
            }
        }
        out.into_bytes()
    }
}

/// The changes a decision card's one commit makes on top of `parent`.
///
/// - Keep mine / Keep the old name: `link` written, nothing else;
/// - Keep (detach): the record removed;
/// - Remove: both copies and the record removed;
/// - Rename here: every file of both copies moved to `to`, each `SKILL.md`
///   with the library's rename brought in (`rename`: its `name:` and its
///   heading, nothing else), the old record removed and `link` written under
///   the new name.
#[allow(clippy::too_many_arguments)]
pub fn decision_changes(
    repo: &Path,
    parent: &str,
    prefix: &str,
    skill: &str,
    verb: SkillVerb,
    link: Option<&SkillLink>,
    to: Option<&str>,
    rename: Option<&RenameText>,
) -> Result<Vec<TreeChange>, String> {
    let git = Plumbing { cwd: repo.to_path_buf() };
    let record = link_repo_path(prefix, skill);
    let mut changes = Vec::new();
    match verb {
        SkillVerb::KeepMine | SkillVerb::Relink => {
            let link = link.ok_or("no link record to write")?;
            changes.push(TreeChange { path: record, content: Some((skill_links::to_bytes(link), false)) });
        }
        SkillVerb::Detach => changes.push(TreeChange { path: record, content: None }),
        SkillVerb::Remove => {
            for root in [skill_links::CLAUDE_ROOT, skill_links::CODEX_ROOT] {
                for entry in git.ls_tree(parent, &format!("{prefix}{root}/{skill}"), true) {
                    changes.push(TreeChange { path: entry.path, content: None });
                }
            }
            changes.push(TreeChange { path: record, content: None });
        }
        SkillVerb::Rename => {
            let to = to.ok_or("no new name to rename to")?;
            let link = link.ok_or("no link record to write")?;
            if blob_at(repo, parent, &link_repo_path(prefix, to)).is_some() {
                return Err(format!("{to} already has a link record here, so Plyloft can't rename {skill} to it."));
            }
            for root in [skill_links::CLAUDE_ROOT, skill_links::CODEX_ROOT] {
                let from_dir = format!("{prefix}{root}/{skill}/");
                let to_dir = format!("{prefix}{root}/{to}/");
                if !git.ls_tree(parent, &format!("{prefix}{root}/{to}"), true).is_empty() {
                    return Err(format!("{root}/{to} already exists here, so Plyloft can't rename {skill} to it."));
                }
                for entry in git.ls_tree(parent, &format!("{prefix}{root}/{skill}"), true) {
                    if entry.mode == "120000" || entry.kind != "blob" {
                        return Err(format!("{} isn't a plain file, so Plyloft won't move it.", entry.path));
                    }
                    let bytes = crate::library_snapshot::git(repo, &["cat-file", "blob", &entry.sha])?;
                    let rest = entry.path.strip_prefix(&from_dir).unwrap_or(&entry.path).to_string();
                    let bytes = match rename {
                        Some(rename) if rest == "SKILL.md" => rename.apply(&bytes),
                        _ => bytes,
                    };
                    changes.push(TreeChange { path: entry.path.clone(), content: None });
                    changes.push(TreeChange { path: format!("{to_dir}{rest}"), content: Some((bytes, entry.mode == "100755")) });
                }
            }
            changes.push(TreeChange { path: record, content: None });
            changes.push(TreeChange {
                path: link_repo_path(prefix, to),
                content: Some((skill_links::to_bytes(link), false)),
            });
        }
        _ => return Err("not a decision card".into()),
    }
    Ok(changes)
}

/// Ship's tree gate for a decision card (§4.2, H4): every path changed since
/// the base is one the decision writes, as plain files —
/// - Keep mine / Keep the old name: the skill's link record, written;
/// - Keep (detach): the link record, removed;
/// - Remove: the skill's two copies and its record, removed;
/// - Rename here: the old and new copies and records.
///
/// Anything else (a hand edit on the card) goes through Verify.
pub fn decision_only(repo: &Path, base: &str, head: &str, card: &SkillCard) -> bool {
    let names_plain = card
        .skills()
        .iter()
        .all(|skill| crate::project_skills::safe_name(skill).ok().as_deref() == Some(*skill));
    if !names_plain || !plain_prefix(&card.prefix) {
        return false;
    }
    let Some(changes) = changed_since(repo, base, head) else {
        return false;
    };
    let prefix = &card.prefix;
    let record = link_repo_path(prefix, &card.skill);
    !changes.is_empty()
        && changes.iter().all(|(mode, path)| match card.verb {
            SkillVerb::KeepMine | SkillVerb::Relink => mode == "100644" && *path == record,
            SkillVerb::Detach => mode == "000000" && *path == record,
            SkillVerb::Remove => mode == "000000" && allowed_path(path, prefix, &card.skill),
            SkillVerb::Rename => {
                let Some(to) = card.renamed_to.as_deref() else {
                    return false;
                };
                matches!(mode.as_str(), "100644" | "100755" | "000000")
                    && (allowed_path(path, prefix, &card.skill) || allowed_path(path, prefix, to))
            }
            _ => false,
        })
}

/// What a decision card's target holds once it has shipped.
fn decision_shipped(repo: &Path, tip: &str, prefix: &str, card: &SkillCard) -> bool {
    let record = blob_at(repo, tip, &link_repo_path(prefix, &card.skill));
    match card.verb {
        SkillVerb::KeepMine | SkillVerb::Relink => record.is_some() && record == card.link_after,
        SkillVerb::Detach => record.is_none() && twin_ids_at(repo, tip, prefix, &card.skill).same_ids(&card.here),
        SkillVerb::Remove => record.is_none() && twin_ids_at(repo, tip, prefix, &card.skill).same_ids(&TwinIds::default()),
        SkillVerb::Rename => {
            let Some(to) = card.renamed_to.as_deref() else {
                return false;
            };
            record.is_none()
                && twin_ids_at(repo, tip, prefix, &card.skill).same_ids(&TwinIds::default())
                && twin_ids_at(repo, tip, prefix, to).same_ids(&card.content)
                && blob_at(repo, tip, &link_repo_path(prefix, to)) == card.link_after
        }
        _ => false,
    }
}

/// H4: a decision card's preflight. The target already holds the result →
/// *Already up to date*. The copies or the link record changed on the target
/// since the card was made (a teammate's edit, an update that shipped
/// meanwhile) → never overridden: it ships as a pull request with the
/// reason. The library moving on is never a refresh: the row asks again
/// after it ships.
fn decision_preflight(repo: &Path, tips: &[&str], prefix: &str, card: &SkillCard, branch: &str) -> Preflight {
    if tips.iter().any(|tip| decision_shipped(repo, tip, prefix, card)) {
        return Preflight::UpToDate;
    }
    for tip in tips {
        let twins_moved = !twin_ids_at(repo, tip, prefix, &card.skill).same_ids(&card.here);
        let record_moved = blob_at(repo, tip, &link_repo_path(prefix, &card.skill)) != card.link_before;
        let taken = card
            .renamed_to
            .as_deref()
            .is_some_and(|to| !twin_ids_at(repo, tip, prefix, to).same_ids(&TwinIds::default()));
        if twins_moved || record_moved || taken {
            return Preflight::HereMoved(format!(
                "{} changed on {branch} since this card was made, so it ships as a pull request for \
                 you to review instead of replacing that change.",
                card.skill
            ));
        }
    }
    Preflight::Go
}

/// *Remove*'s brief, naming the copies the skill has here (`here`: which
/// twins exist) — H4 Windows walk: a Claude-only skill read as two copies.
pub fn remove_notes(skill: &str, origin: &LinkOrigin, repo_words: &str, here: &TwinIds) -> String {
    let words = skill_links::origin_words(origin);
    let record = skill_links::link_path(skill);
    let mut gone: Vec<String> = Vec::new();
    if here.claude.is_some() {
        gone.push(format!("{}/{skill}", skill_links::CLAUDE_ROOT));
    }
    if here.codex.is_some() {
        gone.push(format!("{}/{skill}", skill_links::CODEX_ROOT));
    }
    gone.push(record);
    let list = match gone.len() {
        1 => gone[0].clone(),
        n => format!("{} and {}", gone[..n - 1].join(", "), gone[n - 1]),
    };
    format!(
        "Plyloft made this card: {words} no longer has {skill}, and you chose to remove it here \
         too. It deletes {list}. Once it ships, nobody who opens {repo_words} gets {skill}, from \
         their next session."
    )
}

/// The words a decision card says about itself (its brief), ending with who
/// gets what and when (R18.4).
pub fn decision_notes(verb: SkillVerb, skill: &str, origin: &LinkOrigin, repo_words: &str) -> String {
    let words = skill_links::origin_words(origin);
    let record = skill_links::link_path(skill);
    match verb {
        SkillVerb::KeepMine => format!(
            "Plyloft made this card: it keeps this repository's {skill} as it is and records that \
             you kept it over {words}'s current version — only the link record ({record}) changes. \
             Once it ships, {skill} stays linked and reads Modified here; only a later change in \
             {words} asks again."
        ),
        SkillVerb::Detach => format!(
            "Plyloft made this card: {words} no longer has {skill}, and you chose to keep it here. \
             It removes only the link record ({record}); the skill's files stay. Once it ships, \
             {skill} is an ordinary skill of {repo_words}."
        ),
        SkillVerb::Remove => remove_notes(skill, origin, repo_words, &TwinIds::both("")),
        SkillVerb::Rename => format!(
            "Plyloft made this card: {words} renamed {skill} to {}. It moves this repository's \
             copies to the new name with their link record, and takes the new name into their \
             SKILL.md as {words} wrote it; every other change this repository made stays. Once it \
             ships, everyone who opens {repo_words} gets it as {} from their next session.",
            origin.name, origin.name,
        ),
        SkillVerb::Relink => format!(
            "Plyloft made this card: {words} renamed {skill} to {}. It keeps the name {skill} here \
             and points its link record ({record}) at {}; nothing in the skill changes.",
            origin.name, origin.name,
        ),
        _ => String::new(),
    }
}

// ── H5: the Align card ───────────────────────────────────────────────

/// H5 (R12): an Align card's title, by what it does.
pub fn align_title(skill: &str, winner: crate::skill_reach::Side) -> String {
    format!("Skill: align {skill} ({}'s copy follows {}'s)", winner.other().cli(), winner.cli())
}

/// H5: an Align card's brief, ending with who gets what and when (R18.4).
pub fn align_notes(skill: &str, winner: crate::skill_reach::Side, repo_words: &str) -> String {
    let loser = winner.other();
    format!(
        "Plyloft made this card: it replaces {}'s copy of {skill} ({}/{skill}) with {}'s ({}/{skill}), \
         file for file. Nothing else changes. Once it ships, everyone who opens {repo_words} gets the \
         same {skill} in Claude and in Codex, from their next session.",
        loser.cli(),
        loser.root(),
        winner.cli(),
        winner.root(),
    )
}

/// H5: Ship's tree gate for an Align card — every path changed since the
/// base is a plain file in the losing twin's directory (written or
/// removed). Anything else (a hand edit) goes through Verify.
pub fn align_only(repo: &Path, base: &str, head: &str, card: &SkillCard) -> bool {
    let Some(winner) = card.align_winner else {
        return false;
    };
    if crate::project_skills::safe_name(&card.skill).ok().as_deref() != Some(card.skill.as_str()) || !plain_prefix(&card.prefix) {
        return false;
    }
    let Some(changes) = changed_since(repo, base, head) else {
        return false;
    };
    let lead = format!("{}{}/{}/", card.prefix, winner.other().root(), card.skill);
    !changes.is_empty()
        && changes
            .iter()
            .all(|(mode, path)| matches!(mode.as_str(), "100644" | "100755" | "000000") && path.starts_with(&lead))
}

/// H5: an Align card's preflight. The target's two copies are already what
/// the card writes → *Already up to date*. Either copy changed on the target
/// since the card was made → never overridden: a pull request with the
/// reason.
fn align_preflight(repo: &Path, tips: &[&str], prefix: &str, card: &SkillCard, branch: &str) -> Preflight {
    if tips.iter().any(|tip| twin_ids_at(repo, tip, prefix, &card.skill).same_ids(&card.content)) {
        return Preflight::UpToDate;
    }
    if tips.iter().any(|tip| !twin_ids_at(repo, tip, prefix, &card.skill).same_ids(&card.here)) {
        return Preflight::HereMoved(format!(
            "{} changed on {branch} since this card was made, so it ships as a pull request for \
             you to review instead of replacing that change.",
            card.skill
        ));
    }
    Preflight::Go
}

/// Remove a card worktree Plyloft just made, when the card could not be.
pub fn discard_worktree(ws_cwd: &Path, wt: &Path, branch: &str) {
    if let Err(error) = crate::worktrees::remove_card_worktree_at(
        ws_cwd,
        wt,
        Some(branch),
        None,
        crate::worktrees::Disposal::Forced,
        &[],
    ) {
        log::warn!("skills hub: couldn't remove the skill card's worktree {} ({error})", wt.display());
    }
}

#[cfg(test)]
#[path = "skill_card_tests.rs"]
mod tests;
