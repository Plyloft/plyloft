//! Skills hub H4 (`docs/plans/SKILLS_HUB.md` R3, R7, R8, §12 H4): the
//! decisions about a linked copy, as IPC commands. A child module of
//! `commands`, so it shares that module's helpers (workspace lookup, the
//! team clone, the gates, the skill card's worktree).
//!
//! - **3-way Compare** (`skills_hub_compare3`): *upstream before* (the
//!   base: this Mac's base store, else the library's history), *upstream
//!   now*, *here*, per file, with whose change each file carries.
//! - **Keep mine** (`skills_hub_keep_mine`): a one-file skill card — the
//!   link record's version and base move to upstream now; the copy stays.
//! - **Take upstream**: `skills_hub_update` with `takeUpstream` (in
//!   `commands`), a skill card replacing here with upstream.
//! - **Propose mine upstream** (`skills_hub_propose_upstream`, the team
//!   gate): a pull request in the team repository with here's content,
//!   through [`crate::team_proposal`] — never a push to its default branch.
//! - **Removed upstream** (`skills_hub_removed_choice`, free): *Keep*
//!   (detach: the link record goes) or *Remove* (both copies and the record
//!   go), each a skill card.
//! - **Renamed upstream** (`skills_hub_renamed_choice`, free): *Rename here*
//!   (a card moves the copies and the record) or *Keep the old name* (a card
//!   points the record at the new directory).
//!
//! **Team never-override.** Nothing here runs by itself: the library moving
//! on only marks a row and asks (and files one Inbox row per decision); the
//! member's answer is always a card in their workspace — reviewed and
//! shipped like any card — or a pull request in the library. A workspace's
//! choice (Keep mine, Keep after a removal, Keep the old name) is a commit
//! in that workspace and nothing the team does later undoes it.
//!
//! *Shared workspaces (§13 C3):* Keep mine and Keep go by skill card here
//! too, not through the shared channel's `.atelier/` path: the link record
//! is one file per skill, so a card never meets another skill's change, and
//! the card's pull request (when the integration branch takes them) is the
//! review the channel would otherwise skip.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tauri::Manager;

use super::*;
use crate::skill_card as sc;
use crate::skill_links::{self, LinkState, SkillLink, Upstream};

// ── Reading the library for a link ──────────────────────────────────

/// Whether *Removed* / *Renamed* may be read from this clone now (R8
/// Challenger edge): no rebase or merge under way, not ahead *and* behind
/// GitHub. (A library switched off or left has no clone to read at all:
/// [`team_origin_clone`].)
pub(crate) fn removal_trusted(clone: &Path) -> bool {
    crate::team::library_interruption(clone).is_none() && crate::team::library_divergence(clone).is_none()
}

/// What the team library says now about `link`, on this Mac, for the copy
/// whose ids here are `here`: the clone, the link **as the comparison reads
/// it** ([`effective_link`]) and the library's answer for it.
pub(crate) fn link_upstream<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    link: &SkillLink,
    here: &skill_links::TwinIds,
    checkout: (&Path, &str),
) -> (Option<PathBuf>, SkillLink, Upstream) {
    // Skills hub H9 (R9): a fork of a Plyloft skill is read from the bundle.
    if link.origin.kind == skill_links::KIND_PLYLOFT {
        let (upstream, _) = super::ply_skill_ipc::plyloft_upstream(app, checkout.0, &link.origin.name);
        return (None, link.clone(), upstream);
    }
    // H8: a copy's origin is another workspace's checkout, read the same
    // way; a copy of this Mac's own skill is read from that folder.
    if link.origin.kind == crate::skill_copy::KIND_THIS_MAC {
        return (None, link.clone(), super::skills_hub_copy::this_mac_upstream(&link.origin));
    }
    let clone = super::skills_hub_copy::origin_clone(app, &link.origin);
    let effective = effective_link(clone.as_deref(), link, here, Some(checkout));
    let upstream = match clone.as_deref() {
        Some(clone) => crate::skill_upstream::read(
            clone,
            &effective.origin,
            removal_trusted(clone) && super::skills_hub_copy::origin_on_its_branch(app, &link.origin, clone),
        ),
        None => Upstream::Unavailable,
    };
    (clone, effective, upstream)
}

/// H4 Mac walk: `link` with its starting point at the newest library
/// version after the link's own that the copy here equals — a proposal that
/// merged, so the next team change is judged from there and never counts
/// the proposed lines as changed on both sides. The record on disk changes
/// only through a card (it is a repository file); every state, Compare and
/// decision card reads this instead, so a card written later records it.
///
/// *(Windows walk)* The copy needn't still **be** that version: an edit made
/// here after the proposal merged keeps the merged version as its start.
/// The candidates are the copy's ids now and every id this repository's
/// history gave the copy's folder (`checkout`: the workspace folder and the
/// skill) — committed trees, normalised by git as the row's ids are, so a
/// Windows checkout with CRLF in its files reads the same ids as a Mac.
pub(crate) fn effective_link(
    clone: Option<&Path>,
    link: &SkillLink,
    here: &skill_links::TwinIds,
    checkout: Option<(&Path, &str)>,
) -> SkillLink {
    let Some(clone) = clone else {
        return link.clone();
    };
    let mut ids: std::collections::BTreeSet<String> = [&here.claude, &here.codex].into_iter().flatten().cloned().collect();
    if let Some((cwd, skill)) = checkout {
        let root = if link.base.claude.is_some() || link.base.codex.is_none() {
            skill_links::CLAUDE_ROOT
        } else {
            skill_links::CODEX_ROOT
        };
        ids.extend(checkout_history_ids(cwd, &format!("{root}/{skill}")));
    }
    ids.remove(&link.origin.version.content_id);
    if !ids.is_empty() {
        if let Some((commit, id)) = caught_up_cached(clone, link, &ids) {
            return skill_links::caught_up_link(link, &commit, &id);
        }
    }
    // H4 Windows re-walk: a record whose folder the version's commit doesn't
    // have (the library renamed the skill since, and the record names the
    // new folder) starts from that version **with the rename brought in** —
    // what Rename here makes of it, and what both Compares read
    // ([`start_files`]). An earlier Rename here wrote the unrenamed id as
    // the base; read like this the record is *Update available*, not *Both
    // changed*.
    // Only a base that is still the unrenamed version itself: a Rename here
    // that recorded the renamed start already is left as it wrote it.
    let unrenamed = [&link.base.claude, &link.base.codex]
        .into_iter()
        .flatten()
        .any(|base| *base == link.origin.version.content_id);
    if !unrenamed {
        return link.clone();
    }
    match renamed_start_cached(clone, link) {
        Some(id) => skill_links::renamed_base(link, &id),
        None => link.clone(),
    }
}

/// The version's files from the folder that held its content id at its
/// commit, the rename brought into `SKILL.md` as the library writes it now —
/// `None` when the record's own folder is there at that commit (no rename
/// since) or nothing holds that id.
pub(crate) fn renamed_start_files(clone: &Path, link: &SkillLink) -> Option<Vec<sc::SourceFile>> {
    let version = &link.origin.version;
    let path = link.origin.path.as_deref()?;
    if version.commit.is_empty() || crate::library_snapshot::entry_tree(clone, &version.commit, path).ok().flatten().is_some() {
        return None;
    }
    let old = crate::skill_upstream::folder_with_id(clone, &version.commit, path, &version.content_id)?;
    let source = sc::read_source(clone, &version.commit, &old).ok()?;
    let old_name = old.rsplit('/').next().unwrap_or_default();
    let head = crate::library_snapshot::head_commit(clone).ok();
    let now_md = head
        .and_then(|head| sc::read_source(clone, &head, path).ok())
        .and_then(|now| now.files.into_iter().find(|f| f.path == "SKILL.md").map(|f| f.bytes));
    let text = sc::RenameText::from_library(old_name, &link.origin.name, now_md.as_deref());
    Some(
        source
            .files
            .into_iter()
            .map(|f| sc::SourceFile {
                bytes: if f.path == "SKILL.md" { text.apply(&f.bytes) } else { f.bytes },
                path: f.path,
                executable: f.executable,
            })
            .collect(),
    )
}

/// The content id of [`renamed_start_files`], once per clone `HEAD` and
/// record version (the Inbox asks on every board change).
fn renamed_start_cached(clone: &Path, link: &SkillLink) -> Option<String> {
    type Key = (String, String, String, String, String);
    static CACHE: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashMap<Key, Option<String>>>> =
        std::sync::OnceLock::new();
    let head = crate::library_snapshot::head_commit(clone).ok()?;
    let key: Key = (
        format!("{}@{head}", clone.display()),
        link.origin.path.clone().unwrap_or_default(),
        link.origin.name.clone(),
        link.origin.version.commit.clone(),
        link.origin.version.content_id.clone(),
    );
    let cache = CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().get(&key) {
        return hit.clone();
    }
    let found = renamed_start_files(clone, link).and_then(|files| sc::tree_id_of(clone, &files).ok());
    let mut cache = cache.lock();
    if cache.len() > 512 {
        cache.clear();
    }
    cache.insert(key, found.clone());
    found
}

/// How far back a repository's history of one skill folder is read.
const HISTORY_DEPTH: &str = "200";

/// Every tree id the repository at `cwd` gave the folder `rel` (relative to
/// `cwd`) in its history, newest 200 commits that touched it: one `git log`
/// and one batched `cat-file` (H4 Windows walk: never a spawn per commit).
/// Cached per repository `HEAD`. Empty outside a repository.
pub(crate) fn checkout_history_ids(cwd: &Path, rel: &str) -> Vec<String> {
    type Key = (String, String, String);
    static CACHE: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashMap<Key, Vec<String>>>> =
        std::sync::OnceLock::new();
    let Ok(head) = crate::library_snapshot::git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"]) else {
        return Vec::new();
    };
    let key: Key = (cwd.display().to_string(), String::from_utf8_lossy(&head).trim().to_string(), rel.to_string());
    let cache = CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().get(&key) {
        return hit.clone();
    }
    // Bounded to the history since the link record arrived (its newest
    // addition): `log -- <folder>` alone walks a big repository's whole
    // history when the folder has few commits (H4 Windows re-walk).
    let skill = rel.rsplit('/').next().unwrap_or_default();
    let since = crate::library_snapshot::git(
        cwd,
        &["log", "--diff-filter=A", "--format=%H", "-1", "--", &skill_links::link_path(skill)],
    )
    .map(|out| String::from_utf8_lossy(&out).trim().to_string())
    .unwrap_or_default();
    let range = if since.is_empty() { "HEAD".to_string() } else { format!("{since}^..HEAD") };
    let commits = crate::library_snapshot::git(cwd, &["log", "--format=%H", "--max-count", HISTORY_DEPTH, &range, "--", rel])
        .or_else(|_| crate::library_snapshot::git(cwd, &["log", "--format=%H", "--max-count", HISTORY_DEPTH, "HEAD", "--", rel]))
        .map(|out| String::from_utf8_lossy(&out).lines().map(str::trim).filter(|c| !c.is_empty()).map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_default();
    let revs: Vec<String> = commits.iter().map(|c| format!("{c}:./{rel}")).collect();
    let found: Vec<String> = crate::skill_upstream::batch_trees(cwd, &revs).into_iter().flatten().collect();
    let mut cache = cache.lock();
    if cache.len() > 512 {
        cache.clear();
    }
    cache.insert(key, found.clone());
    found
}

/// [`crate::skill_upstream::caught_up`], once per clone `HEAD`, link
/// version and candidate ids (the Inbox asks on every board change). Bounded.
fn caught_up_cached(clone: &Path, link: &SkillLink, ids: &std::collections::BTreeSet<String>) -> Option<(String, String)> {
    type Key = (String, String, String, Vec<String>);
    static CACHE: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashMap<Key, Option<(String, String)>>>> =
        std::sync::OnceLock::new();
    let head = crate::library_snapshot::head_commit(clone).ok()?;
    let key: Key = (
        format!("{}@{head}", clone.display()),
        link.origin.path.clone().unwrap_or_default(),
        link.origin.version.commit.clone(),
        ids.iter().cloned().collect(),
    );
    let cache = CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().get(&key) {
        return hit.clone();
    }
    let found = crate::skill_upstream::caught_up(clone, &link.origin, ids);
    let mut cache = cache.lock();
    if cache.len() > 512 {
        cache.clear();
    }
    cache.insert(key, found.clone());
    found
}

/// The copy here, from the checkout: Claude's when it has one, Codex's
/// otherwise.
fn here_dir(cwd: &Path, skill: &str) -> Option<PathBuf> {
    [skill_links::CLAUDE_ROOT, skill_links::CODEX_ROOT]
        .into_iter()
        .map(|root| crate::project_skills::under(cwd, root).join(skill))
        .find(|dir| dir.is_dir())
}

/// One linked copy as the Library reads it: its link, its copies' ids here,
/// what the library says, and the state.
struct Read {
    /// The record in the checkout.
    link: SkillLink,
    /// The record as the comparison reads it ([`effective_link`]).
    effective: SkillLink,
    here: skill_links::TwinIds,
    clone: Option<PathBuf>,
    upstream: Upstream,
    state: LinkState,
}

fn read_link<R: tauri::Runtime>(app: &tauri::AppHandle<R>, cwd: &Path, skill: &str) -> Result<Read, String> {
    let (links, unreadable) = skill_links::read_checkout(cwd);
    refuse_unreadable_link(&unreadable, skill)?;
    let link = links.get(skill).cloned().ok_or_else(|| {
        // H8: a link kept on this Mac only takes no decision card — the
        // card would commit a record its origin can't be named in.
        let local = app
            .state::<WorkspaceStore>()
            .snapshot()
            .workspaces
            .iter()
            .find(|w| Path::new(&w.cwd) == cwd)
            .map(|w| super::skills_hub_copy::app_links_here(app, &w.id, cwd).local.contains(skill))
            .unwrap_or(false);
        if local {
            format!(
                "{skill}'s link is kept on {THIS_MACHINE} only, so this choice isn't offered for it. \
                 Update it, or edit it here — its row says what changed."
            )
        } else {
            format!("{skill} isn't linked to a library here.")
        }
    })?;
    let here = sc::checkout_twin_ids(cwd, skill);
    let (clone, effective, upstream) = link_upstream(app, &link, &here, (cwd, skill));
    let state = skill_links::link_state(&effective, &here, &upstream);
    Ok(Read { link, effective, here, clone, upstream, state })
}

/// A header that starts with the origin's words: "The team library", "Your
/// own skills" — but a workspace or a repository named as it is ("astra",
/// H8 Mac re-walk).
fn lead_words(words: &str) -> String {
    if words.starts_with("the ") || words.starts_with("your ") {
        capitalize(words)
    } else {
        words.to_string()
    }
}

/// H8: a copy's change goes back to where it came from by hand — Plyloft
/// opens no pull request there (R3's "a skill card in the origin workspace"
/// is not built yet).
pub(crate) fn copy_propose_words(words: &str) -> String {
    format!(
        "This copy came from {words}. To share your change, make it in {words} and ship it there; \
         this copy then offers the update."
    )
}

// ── The proposal a row shows ─────────────────────────────────────────

/// A pull request this Mac opened for a linked copy, as its row names it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalRef {
    pub number: Option<u64>,
    pub url: String,
}

/// The proposal standing for `link`'s skill whose content is still what
/// `here` holds (the row says *Proposed upstream* then).
pub(crate) fn standing_proposal(state: &crate::skills_hub_state::HubState, link: &SkillLink, here: &skill_links::TwinIds) -> Option<ProposalRef> {
    let key = crate::skills_hub_state::proposal_key(
        &crate::skills_hub_state::team_key(&link.origin.source),
        link.origin.plugin.as_deref().unwrap_or_default(),
        &link.origin.name,
    );
    let Some(proposal) = state.proposals.get(&key) else {
        log::debug!("skills hub: no proposal under {key}");
        return None;
    };
    let ids = [here.claude.as_deref(), here.codex.as_deref()];
    let standing = ids.iter().flatten().any(|id| *id == proposal.content_id);
    if !standing {
        // H4 Windows re-walk: the row didn't say "Proposed upstream" once;
        // the log says whether the copy moved on from what was proposed.
        log::info!("skills hub: proposal {key} was of {}, the copy here is {here:?}", proposal.content_id);
    }
    standing.then(|| ProposalRef { number: proposal.number, url: proposal.url.clone() })
}

/// H4 (Challenger): the proposals of `library_key` whose pull request GitHub
/// no longer has open — merged or closed without merging — are forgotten, so
/// a row doesn't say *Proposed upstream* about a pull request that is gone,
/// the Inbox asks again, and the next proposal opens a new one. `answers`
/// holds what GitHub said per proposal key, with the branch it was asked
/// about (a proposal GitHub didn't answer for, or one replaced meanwhile by
/// a new branch, is kept). Returns the keys forgotten.
pub(crate) fn settle_proposals(
    state: &mut crate::skills_hub_state::HubState,
    library_key: &str,
    answers: &BTreeMap<String, (String, crate::shared_config::PrState)>,
) -> Vec<String> {
    let prefix = format!("{library_key}/");
    let gone: Vec<String> = state
        .proposals
        .iter()
        .filter(|(key, proposal)| {
            key.starts_with(&prefix)
                && answers.get(*key).is_some_and(|(branch, pr)| {
                    *branch == proposal.branch && *pr != crate::shared_config::PrState::Open
                })
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in &gone {
        state.proposals.remove(key);
    }
    gone
}

/// What GitHub says now about each of `library_key`'s proposals: `(branch,
/// state)` by key, for [`settle_proposals`]. Called after a pull, in the
/// team's account scope; a proposal GitHub doesn't answer for is left out.
pub(crate) fn proposal_answers(
    state: &crate::skills_hub_state::HubState,
    library_key: &str,
    clone: &Path,
    slug: &str,
    gh: &crate::shared_config::Gh,
) -> BTreeMap<String, (String, crate::shared_config::PrState)> {
    let prefix = format!("{library_key}/");
    state
        .proposals
        .iter()
        .filter(|(key, proposal)| key.starts_with(&prefix) && !proposal.branch.is_empty())
        .filter_map(|(key, proposal)| {
            let found = gh.pr_for_branch(clone, slug, &proposal.branch).ok().flatten()?;
            Some((key.clone(), (proposal.branch.clone(), found.state)))
        })
        .collect()
}

// ── The decision cards ──────────────────────────────────────────────

/// Refusals every decision card makes before anything is written.
pub(crate) fn decision_refusals<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, cwd: &Path, skill: &str) -> Result<(), String> {
    if sc::workspace_prefix(cwd).is_err() {
        return Err(format!(
            "This folder isn't a git repository, so there is no card to carry the change to {skill}."
        ));
    }
    let workspaces = app.state::<WorkspaceStore>();
    team_gate_github_card_write(&workspaces, &app.state::<crate::license::LicenseStore>(), workspace_id, true)?;
    if let Some(open) = open_skill_card(&app.state::<KanbanStore>(), workspace_id, skill)? {
        return Err(on_its_way_refusal(skill, &open));
    }
    Ok(())
}

/// Make a decision card (§4.2, H4): a worktree from the target branch and
/// one commit Plyloft writes with plumbing — the link record only, or the
/// copies' removal or move — then the card in Complete, at its Ship step.
///
/// `build` makes the record the card writes from the one **on the target
/// branch** (never the checkout's: the card lands there), or `None` for a
/// card that removes it. A branch that doesn't have the link yet refuses.
#[allow(clippy::too_many_arguments)]
pub(crate) fn make_decision_card<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    cwd: &Path,
    verb: sc::SkillVerb,
    skill: &str,
    hint: &skill_links::LinkOrigin,
    to: Option<&str>,
    rename: Option<&sc::RenameText>,
    build: impl FnOnce(&SkillLink) -> Result<Option<SkillLink>, String>,
) -> Result<KanbanCard, String> {
    let workspaces = app.state::<WorkspaceStore>();
    let project_config = app.state::<ProjectConfigStore>();
    let title = sc::card_title(verb, skill, hint);
    let card_id = uuid::Uuid::new_v4().to_string();
    let target = resolve_base_branch(&project_config, workspace_id);
    let prefix = sc::workspace_prefix(cwd)?;
    let ensured = {
        let _github = crate::github_account::enter_for_workspace(&workspaces, workspace_id);
        crate::worktrees::ensure_for_skill_card(cwd, &card_id, &title, &target)?
    };
    let wt = ensured.worktree_path.clone();
    let branch = ensured.branch_name.clone();
    let Some(base) = ensured.base.clone() else {
        return Err("a worktree for this card already exists".into());
    };
    type Made = (skill_links::TwinIds, skill_links::TwinIds, Option<String>, Option<String>, String, skill_links::LinkOrigin);
    let written = (|| -> Result<Made, String> {
        let at_base = sc::link_read_at(&wt, &base.commit, &prefix, skill)?.ok_or_else(|| {
            format!(
                "{skill}'s link isn't on {target} yet (only this checkout has it), so a card can't change it. \
                 Ship or pull the change that linked it first."
            )
        })?;
        let next = build(&at_base)?;
        let changes = sc::decision_changes(&wt, &base.commit, &prefix, skill, verb, next.as_ref(), to, rename)?;
        let origin = next.as_ref().map(|link| link.origin.clone()).unwrap_or_else(|| at_base.origin.clone());
        let sha = sc::commit_into_worktree(&wt, &base.commit, &changes, &sc::commit_message(verb, skill, &origin))?;
        let here = sc::twin_ids_at(&wt, &base.commit, &prefix, skill);
        let content = match to {
            Some(to) => sc::twin_ids_at(&wt, &sha, &prefix, to),
            None if verb == sc::SkillVerb::Remove => skill_links::TwinIds::default(),
            None => here.clone(),
        };
        let before = sc::blob_at(&wt, &base.commit, &sc::link_repo_path(&prefix, skill));
        let after = sc::blob_at(&wt, &sha, &sc::link_repo_path(&prefix, to.unwrap_or(skill)));
        let after = next.as_ref().and(after);
        Ok((here, content, before, after, crate::worktrees::commit_tree_sha(&wt, &sha)?, origin))
    })();
    let (here, content, link_before, link_after, tree, origin) = match written {
        Ok(done) => done,
        Err(why) => {
            sc::discard_worktree(cwd, &wt, &branch);
            return Err(why);
        }
    };
    let repo_words = repo_words_of(cwd);
    let title = sc::card_title(verb, skill, &origin);
    let notes = if verb == sc::SkillVerb::Remove {
        sc::remove_notes(skill, &origin, &repo_words, &here)
    } else {
        sc::decision_notes(verb, skill, &origin, &repo_words)
    };
    let kind = sc::SkillCard {
        verb,
        skill: skill.to_string(),
        prefix,
        origin,
        here,
        content,
        links: Vec::new(),
        renamed_to: to.map(str::to_string),
        link_before,
        link_after,
        align_winner: None, local_link: false, from_words: None,
        extra: Default::default(),
    };
    file_skill_card(app, workspace_id, cwd, card_id, &ensured, base, &tree, title, notes, kind)
}

/// `owner/name` of the checkout's GitHub repository, or "this repository".
pub(crate) fn repo_words_of(cwd: &Path) -> String {
    crate::shared_config::Plumbing { cwd: cwd.to_path_buf() }
        .github_repo()
        .unwrap_or_else(|| "this repository".to_string())
}

/// File a skill card whose worktree (`ensured`, cut at `base`) already holds
/// Plyloft's one commit with tree `tree`: in Complete, at its Ship step, its
/// verify entry *Not needed* for that tree. A card that can't be filed takes
/// its worktree with it.
#[allow(clippy::too_many_arguments)]
pub(crate) fn file_skill_card<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    cwd: &Path,
    card_id: String,
    ensured: &crate::worktrees::EnsureResult,
    base: crate::worktrees::WorktreeBase,
    tree: &str,
    title: String,
    notes: String,
    kind: sc::SkillCard,
) -> Result<KanbanCard, String> {
    let workspaces = app.state::<WorkspaceStore>();
    let kanban = app.state::<KanbanStore>();
    let wt = ensured.worktree_path.clone();
    let branch = ensured.branch_name.clone();
    let mut card = KanbanCard::new(card_id, workspace_id.to_string(), title, Some(notes), KanbanColumnId::Complete);
    let email = app.state::<SettingsStore>().snapshot().identity.user_email;
    card.author = email.clone();
    card.last_edited_by = email;
    card.worktree_path = Some(wt.to_string_lossy().into_owned());
    card.branch_name = Some(branch.clone());
    card.worktree_base = Some(base);
    card.last_run_status = Some(crate::kanban::LastRunStatus::Success);
    card.verify_status = crate::kanban::VerifyStatus::Passed;
    card.verify_history = vec![sc::not_needed_entry(tree)];
    card.kind = Some(crate::kanban::CardKind::Skill(kind));
    let created = match kanban.create_card(workspace_id, card) {
        Ok(created) => created,
        Err(why) => {
            sc::discard_worktree(cwd, &wt, &branch);
            return Err(why);
        }
    };
    if let Some(repo) = workspace_github_target(&workspaces, workspace_id) {
        let _github = crate::github_account::enter_for_workspace(&workspaces, workspace_id);
        gh_sync_card_create(&kanban, &repo, workspace_id, &created);
        if let Some(number) = kanban.get_card(workspace_id, &created.id).ok().and_then(|c| c.gh_issue_number) {
            crate::github_sync::push_status_labels(&kanban, &repo, workspace_id, &created.id, number);
        }
    }
    crate::kanban::emit_kanban_changed(app, workspace_id);
    kanban.get_card(workspace_id, &created.id)
}

fn config_dir_of<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.state::<WorkspaceStore>().config_dir.clone())
}

/// H5: the words of every refusal that waits for an Align (`skillCards.ts`
/// `ALIGN_FIRST_MARKER` offers **Align** on its toast).
pub const ALIGN_FIRST_MARKER: &str = "Align them first";

fn align_first(skill: &str, then: &str) -> String {
    format!("The Claude and Codex copies of {skill} here differ, so Plyloft can't tell which one is yours. {ALIGN_FIRST_MARKER}, then {then}.")
}

/// How the twins of a linked copy stand in the checkout (R12).
fn twins_judgement<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, cwd: &Path, skill: &str, read: &Read) -> crate::skill_twins::Judgement {
    let ledger = config_dir_of(app)
        .ok()
        .map(|dir| crate::skills_hub_state::load(&dir))
        .and_then(|state| state.ledger(workspace_id, skill).cloned());
    crate::skill_twins::checkout_judgement(cwd, skill, &read.here, Some(&read.link), ledger.as_ref())
}

/// The twins of a linked copy are not one skill yet.
fn twins_apart<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, cwd: &Path, skill: &str, read: &Read) -> bool {
    matches!(
        twins_judgement(app, workspace_id, cwd, skill, read),
        crate::skill_twins::Judgement::Follows(_) | crate::skill_twins::Judgement::Differ
    )
}

/// The directory a proposal reads and the content id it records: the copy
/// here, or — with twins apart (R12) — the one that changed alone. Both
/// changed: refused until they are aligned.
fn proposal_source<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    cwd: &Path,
    skill: &str,
    read: &Read,
) -> Result<(PathBuf, String), String> {
    use crate::skill_twins::Judgement;
    match twins_judgement(app, workspace_id, cwd, skill, read) {
        Judgement::Follows(winner) => {
            let id = match winner {
                crate::skill_reach::Side::Claude => read.here.claude.clone(),
                crate::skill_reach::Side::Codex => read.here.codex.clone(),
            };
            Ok((crate::project_skills::under(cwd, winner.root()).join(skill), id.unwrap_or_default()))
        }
        Judgement::Differ => Err(align_first(skill, "propose it")),
        Judgement::One | Judgement::Aligned => {
            let dir = here_dir(cwd, skill).ok_or_else(|| format!("{skill} has no copy in this checkout to propose."))?;
            Ok((dir, read.here.claude.clone().or(read.here.codex.clone()).unwrap_or_default()))
        }
    }
}

/// **Keep mine** (R3): this repository keeps its copy and stays
/// linked; the link's version and base move to the team library's version
/// now. A one-file skill card (the link record). Only when the library moved
/// on — with nothing new upstream there is nothing to keep it over.
#[tauri::command]
pub async fn skills_hub_keep_mine<R: tauri::Runtime>(app: tauri::AppHandle<R>, workspace_id: String, skill: String) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<KanbanCard, String> {
        let skill = crate::project_skills::safe_name(&skill)?;
        let (_, cwd) = workspace_checkout(&app, &workspace_id)?;
        decision_refusals(&app, &workspace_id, &cwd, &skill)?;
        let read = read_link(&app, &cwd, &skill)?;
        let words = skill_links::origin_words(&read.link.origin);
        let (Some(clone), Upstream::At(now)) = (read.clone.as_deref(), &read.upstream) else {
            return Err(format!("{words} isn't available on {THIS_MACHINE}, so there is no version to keep yours over."));
        };
        if read.state != LinkState::BothChanged {
            return Err(format!(
                "{words} hasn't changed {skill} since it was linked here, so there is nothing to keep yours over."
            ));
        }
        // H5 (R12): the copy kept is one skill — twins apart are aligned first.
        if twins_apart(&app, &workspace_id, &cwd, &skill, &read) {
            return Err(align_first(&skill, "keep yours"));
        }
        let head = crate::library_snapshot::head_commit(clone)?;
        let path = read.link.origin.path.clone().unwrap_or_default();
        // §5.4: the version the link now starts from, kept on this Mac for a
        // later 3-way Compare.
        if let Ok(source) = sc::read_source(clone, &head, &path) {
            if let Err(error) = crate::skill_bases::store(&config_dir_of(&app)?, &source.tree, &source.files) {
                log::warn!("skills hub: couldn't keep the base of {skill} ({error})");
            }
        }
        let now = now.clone();
        make_decision_card(&app, &workspace_id, &cwd, sc::SkillVerb::KeepMine, &skill, &read.link.origin, None, None, move |at_base| {
            Ok(Some(skill_links::kept_mine(at_base, &head, &now)))
        })
    })
    .await
    .map_err(|error| format!("join keep mine: {error}"))?
}

/// **Removed upstream** (R8, free on every plan): `"keep"` detaches the copy
/// (a card removes the link record, the files stay); `"remove"` makes a
/// card that deletes both copies and the record.
#[tauri::command]
pub async fn skills_hub_removed_choice<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_id: String,
    skill: String,
    choice: String,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<KanbanCard, String> {
        let skill = crate::project_skills::safe_name(&skill)?;
        let verb = match choice.as_str() {
            "keep" => sc::SkillVerb::Detach,
            "remove" => sc::SkillVerb::Remove,
            other => return Err(format!("unknown choice `{other}`")),
        };
        let (_, cwd) = workspace_checkout(&app, &workspace_id)?;
        decision_refusals(&app, &workspace_id, &cwd, &skill)?;
        let read = read_link(&app, &cwd, &skill)?;
        if read.state != LinkState::Removed {
            return Err(format!(
                "{} still has {skill} as far as {THIS_MACHINE} can tell, so there is nothing to decide.",
                skill_links::origin_words(&read.link.origin)
            ));
        }
        make_decision_card(&app, &workspace_id, &cwd, verb, &skill, &read.link.origin, None, None, |_| Ok(None))
    })
    .await
    .map_err(|error| format!("join removed choice: {error}"))?
}

/// **Renamed upstream** (R8 edge, free): `"rename"` — a card moves both
/// copies and the record to the new name; `"keepName"` — a card points the
/// record at the new directory and keeps the name here.
#[tauri::command]
pub async fn skills_hub_renamed_choice<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_id: String,
    skill: String,
    choice: String,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<KanbanCard, String> {
        let skill = crate::project_skills::safe_name(&skill)?;
        let (_, cwd) = workspace_checkout(&app, &workspace_id)?;
        decision_refusals(&app, &workspace_id, &cwd, &skill)?;
        let read = read_link(&app, &cwd, &skill)?;
        let Upstream::Renamed { name, path, .. } = read.upstream.clone() else {
            return Err(format!(
                "{} hasn't renamed {skill} as far as {THIS_MACHINE} can tell, so there is nothing to decide.",
                skill_links::origin_words(&read.link.origin)
            ));
        };
        let name = crate::project_skills::safe_name(&name)?;
        let mut hint = read.link.origin.clone();
        hint.name = name.clone();
        let (checkout, effective) = (read.link.clone(), read.effective.clone());
        match choice.as_str() {
            "rename" => {
                if open_skill_card(&app.state::<KanbanStore>(), &workspace_id, &name)?.is_some() {
                    return Err(format!("{name} is already on its way in another card here."));
                }
                let clone = read.clone.clone().ok_or_else(|| {
                    format!("{} isn't available on {THIS_MACHINE}.", skill_links::origin_words(&read.link.origin))
                })?;
                let rename = rename_here(&clone, &effective, &skill, &name, &path);
                if let Some((_, _, source)) = rename.start.as_ref() {
                    // §5.4: the version the renamed copy starts from.
                    if let Err(error) = crate::skill_bases::store(&config_dir_of(&app)?, &source.tree, &source.files) {
                        log::warn!("skills hub: couldn't keep the base of {name} ({error})");
                    }
                }
                if let Some((id, files)) = rename.moved_start.as_ref() {
                    // §5.4: the renamed old start, for a later 3-way Compare.
                    if let Err(error) = crate::skill_bases::store(&config_dir_of(&app)?, id, files) {
                        log::warn!("skills hub: couldn't keep the base of {name} ({error})");
                    }
                }
                let (name2, path2) = (name.clone(), path.clone());
                let start = rename.start.as_ref().map(|(commit, id, _)| (commit.clone(), id.clone()));
                let moved_id = rename.moved_start.as_ref().map(|(id, _)| id.clone());
                make_decision_card(&app, &workspace_id, &cwd, sc::SkillVerb::Rename, &skill, &hint, Some(&name), Some(&rename.text), move |at_base| {
                    let same = skill_links::same_start(at_base, &checkout);
                    let mut next = skill_links::relinked(&skill_links::with_start(at_base, &checkout, &effective), &name2, &path2);
                    match (same, start, moved_id) {
                        (true, Some((commit, id)), _) => next = skill_links::caught_up_link(&next, &commit, &id),
                        (true, None, Some(id)) => next = skill_links::renamed_base(&next, &id),
                        _ => {}
                    }
                    Ok(Some(next))
                })
            }
            "keepName" => make_decision_card(&app, &workspace_id, &cwd, sc::SkillVerb::Relink, &skill, &hint, None, None, move |at_base| {
                Ok(Some(skill_links::relinked(&skill_links::with_start(at_base, &checkout, &effective), &name, &path)))
            }),
            other => Err(format!("unknown choice `{other}`")),
        }
    })
    .await
    .map_err(|error| format!("join renamed choice: {error}"))?
}

/// What *Rename here* brings in of the library's rename (H4 Mac walk).
pub(crate) struct RenameHere {
    /// The library's own `name:` and heading lines at the new name.
    pub text: sc::RenameText,
    /// The starting point after the rename — the library at the commit that
    /// renamed it, `(commit, content id, its files)` — when that version is
    /// the old starting point with only the rename brought in. Otherwise the
    /// card keeps the old one (the library changed more in that commit, and
    /// the row then asks about the rest).
    pub start: Option<(String, String, sc::Source)>,
    /// H4 Windows walk: without such a commit, the old starting point with
    /// only the rename brought in — `(content id, its files)` — which the
    /// card records as the copies' base (the version stays the old one), so
    /// a copy otherwise unedited reads *Update available* for the team's
    /// other changes, never *Both changed*.
    pub moved_start: Option<(String, Vec<sc::SourceFile>)>,
}

/// Read the library's rename of `skill` to `name` (at `path`) from the
/// clone, from the link's starting point `effective`.
pub(crate) fn rename_here(clone: &Path, effective: &SkillLink, skill: &str, name: &str, path: &str) -> RenameHere {
    let skill_md = |source: &sc::Source| source.files.iter().find(|f| f.path == "SKILL.md").map(|f| f.bytes.clone());
    let from = effective.origin.version.commit.clone();
    let old_path = effective.origin.path.clone().unwrap_or_default();
    let head = crate::library_snapshot::head_commit(clone).ok();
    let renamed_at = head
        .as_deref()
        .and_then(|head| crate::skill_upstream::first_commit_with(clone, &from, head, path));
    let after = renamed_at.as_deref().and_then(|at| sc::read_source(clone, at, path).ok());
    let text = sc::RenameText::from_library(skill, name, after.as_ref().and_then(skill_md).as_deref());
    // The old starting point, renamed: its files with the rename brought in.
    let moved: Option<Vec<sc::SourceFile>> = sc::read_source(clone, &from, &old_path).ok().map(|before| {
        before
            .files
            .iter()
            .map(|f| sc::SourceFile {
                path: f.path.clone(),
                bytes: if f.path == "SKILL.md" { text.apply(&f.bytes) } else { f.bytes.clone() },
                executable: f.executable,
            })
            .collect()
    });
    let flat = |files: &[sc::SourceFile]| -> Vec<(String, Vec<u8>, bool)> {
        files.iter().map(|f| (f.path.clone(), f.bytes.clone(), f.executable)).collect()
    };
    let start = match (&after, &moved) {
        (Some(after), Some(moved)) if flat(moved) == flat(&after.files) => {
            Some((after.commit.clone(), after.tree.clone(), after.clone()))
        }
        _ => None,
    };
    let moved_start = match (&start, moved) {
        (None, Some(files)) => sc::tree_id_of(clone, &files).ok().map(|id| (id, files)),
        _ => None,
    };
    RenameHere { text, start, moved_start }
}

// ── Propose mine upstream ───────────────────────────────────────────

/// What *Propose mine upstream* opened.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedUpstream {
    pub skill: String,
    pub url: String,
    pub number: Option<u64>,
    /// A commit was added to this Mac's pull request already open for it.
    pub added_to_open: bool,
}

/// The team manifest's owner, for R7's read-only sentence.
fn team_owner(clone: &Path) -> Option<String> {
    crate::team::read_manifest(clone).ok().flatten().and_then(|manifest| manifest.owner_login().map(str::to_string))
}

/// Write `source`'s files over each half of the library skill at
/// `halves` (repo-relative directories) inside `root`. Files an OS drops
/// into folders by itself (`.DS_Store`, `Thumbs.db`) are never proposed:
/// they aren't part of the copy's content id here, so a merged proposal
/// carrying one would never read *up to date* (H4 Challenger).
///
/// Round 3 (S3): nor are the files git ignores in the source's checkout
/// (`left_out`, from `project_skills::refuse_unpublishable`).
pub(crate) fn write_halves(
    root: &Path,
    halves: &[String],
    source: &Path,
    left_out: &std::collections::BTreeSet<String>,
) -> Result<(), String> {
    let mut files = crate::project_skills::read_tree(source)?;
    files.retain(|file| !crate::shared_library_sync::is_os_junk(&file.path) && !left_out.contains(&file.path));
    for half in halves {
        crate::project_skills::write_tree(&root.join(half), &files)?;
    }
    Ok(())
}

/// **Propose mine upstream** (R3, R7; the team gate — it writes the
/// team library): a pull request `Skill: <name>` in the team repository
/// with this repository's copy, from `plyloft/skill-<name>-<yyyymmdd-hhmm>`
/// — never a push to the library's default branch. The copy stays
/// *Modified here*; once the pull request merges and the clone pulls it, the
/// row reads *up to date* by itself. A second proposal while this Mac's pull
/// request is open adds a commit to it (one pull request per skill).
///
/// Only the halves the library already has for the skill are written, so a
/// proposal never adds a CLI the team didn't choose.
#[tauri::command]
pub async fn skills_hub_propose_upstream<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_id: String,
    skill: String,
) -> Result<ProposedUpstream, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<ProposedUpstream, String> {
        let license = app.state::<crate::license::LicenseStore>();
        let skill = crate::project_skills::safe_name(&skill)?;
        let (_, cwd) = workspace_checkout(&app, &workspace_id)?;
        // H8: a copy of another workspace's skill goes back there by hand,
        // whatever the plan — said before the Team gate.
        if let Some(link) = super::skills_hub_copy::app_links_here(&app, &workspace_id, &cwd).links.get(&skill) {
            if crate::skill_copy::is_copy_origin(&link.origin) {
                return Err(copy_propose_words(&super::skills_hub_copy::origin_words_here(&app, &link.origin)));
            }
        }
        team_gate(&license)?;
        let read = read_link(&app, &cwd, &skill)?;
        let origin = &read.link.origin;
        if origin.kind == "plyloft" {
            return Err("Plyloft's own skills take no proposals: Plyloft runs no server to send one to.".into());
        }
        if crate::skill_copy::is_copy_origin(origin) {
            return Err(copy_propose_words(&super::skills_hub_copy::origin_words_here(&app, origin)));
        }
        let words = skill_links::origin_words(origin);
        let Some(clone) = read.clone.clone() else {
            return Err(format!("{words} isn't available on {THIS_MACHINE}, so there is nowhere to propose {skill}."));
        };
        if !skill_links::modified_here(&read.effective, &read.here) || read.state == LinkState::UpToDate {
            return Err(format!("{skill} here is the version {words} has, so there is nothing of yours to propose."));
        }
        // H5 (R12): twins that differ are one skill once aligned — the one
        // that changed alone is the one proposed; both changed asks first.
        let (source, content_id) = proposal_source(&app, &workspace_id, &cwd, &skill, &read)?;
        // The folder that would go, before anything is written (owner, 2026-11-03).
        // Round 3 (S3): and what git ignores there is left out of it.
        let left_out = crate::project_skills::refuse_unpublishable(&skill, &source, true, "nothing was shared")
            .map_err(|error| error.to_string())?;
        let slug = current_team_repo(&app).ok_or_else(no_team_message)?;
        let (allowed, reason) = promote_authorization(&app, &slug);
        if !allowed {
            return Err(reason.unwrap_or_else(|| crate::team_proposal::read_only_words(team_owner(&clone).as_deref())));
        }
        let plugin = origin.plugin.clone().unwrap_or_default();
        let gh = crate::doctor::require("gh")
            .map(crate::shared_config::Gh::new)
            .map_err(|_| "Opening a pull request needs the GitHub CLI (gh). Settings › Setup and account › Setup installs it.".to_string())?;
        let config_dir = config_dir_of(&app)?;
        let key = crate::skills_hub_state::proposal_key(&crate::skills_hub_state::team_key(&slug), &plugin, &origin.name);
        let _account = team_account_scope(&app);
        let team = app.state::<crate::team::TeamStore>();
        let t_propose = std::time::Instant::now();
        if let Err(error) = team.sync(&slug) {
            log::warn!("skills hub: couldn't refresh the team clone before a proposal ({error})");
        }
        let base_branch = crate::team_proposal::default_branch(&clone)?;
        let tip = crate::team_proposal::upstream_commit(&clone)?;
        let path = origin.path.clone().unwrap_or_default();
        let halves: Vec<String> = std::iter::once(path.clone())
            .chain(crate::skill_upstream::other_half(&path))
            .filter(|half| crate::library_snapshot::entry_tree(&clone, &tip, half).ok().flatten().is_some())
            .collect();
        if halves.is_empty() {
            return Err(format!("{words} doesn't have {} any more, so there is nothing to propose a change to.", origin.name));
        }
        // R7 edge: this Mac's pull request still open for the skill takes the
        // new commit on the same branch.
        let previous = crate::skills_hub_state::load(&config_dir).proposals.get(&key).cloned();
        let open = previous.filter(|p| {
            !p.branch.is_empty()
                && !p.commit.is_empty()
                && gh
                    .pr_for_branch(&clone, &slug, &p.branch)
                    .ok()
                    .flatten()
                    .is_some_and(|found| found.state == crate::shared_config::PrState::Open)
        });
        let branch = open
            .as_ref()
            .map(|p| p.branch.clone())
            .unwrap_or_else(|| crate::team_proposal::branch_name(&origin.name, chrono::Local::now()));
        let parent = open.as_ref().map(|p| p.commit.clone()).unwrap_or(tip);
        let repo_words = crate::shared_config::Plumbing { cwd: cwd.clone() }
            .github_repo()
            .unwrap_or_else(|| "a repository".to_string());
        let body = format!(
            "Proposed from Plyloft: {skill} as {repo_words} has it now, for {words}'s {}. Nothing changes \
             for anyone until this pull request merges; then every member's sessions get it, and copies \
             linked to it see an update.",
            origin.name
        );
        let message = format!("skills: propose \"{}\" from {repo_words}", origin.name);
        let title = crate::team_proposal::title(&origin.name);
        let request = crate::team_proposal::Request {
            clone: &clone,
            slug: &slug,
            base_branch: &base_branch,
            branch: &branch,
            parent: &parent,
            paths: &halves,
            message: &message,
            title: &title,
            body: &body,
            reuse: open.is_some(),
        };
        log::info!("skills hub: propose {skill}: pulled and checked in {} ms", t_propose.elapsed().as_millis());
        let t_open = std::time::Instant::now();
        let opened = {
            let _git = team.git_guard();
            crate::team_proposal::open(&request, &gh, |root| write_halves(root, &halves, &source, &left_out))
        }
        .map_err(|error| error.words(team_owner(&clone).as_deref()))?;
        log::info!("skills hub: propose {skill}: committed, pushed and opened in {} ms", t_open.elapsed().as_millis());
        log::info!("skills hub: proposal {key} recorded for {content_id} (pull request {:?})", opened.number);
        let now = chrono::Utc::now().timestamp_millis();
        crate::skills_hub_state::update(&config_dir, now, |state| {
            state.proposals.insert(
                key.clone(),
                crate::skills_hub_state::Proposal {
                    branch: opened.branch.clone(),
                    url: opened.url.clone(),
                    number: opened.number,
                    content_id,
                    commit: opened.commit.clone(),
                    at: now,
                    extra: Default::default(),
                },
            );
        })?;
        crate::skills_hub::nudge(crate::skills_hub::Trigger::AfterWrite);
        Ok(ProposedUpstream { skill, url: opened.url, number: opened.number, added_to_open: open.is_some() })
    })
    .await
    .map_err(|error| format!("join propose upstream: {error}"))?
}

// ── 3-way Compare ───────────────────────────────────────────────────

/// One file of a 3-way Compare.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compare3File {
    pub path: String,
    /// `"both"` — both sides changed it (differently); `"here"` — only this
    /// repository changed it; `"upstream"` — only the library changed it;
    /// `"same"` — both made the same change. Without a base: `"differs"`.
    pub status: String,
    pub base: Option<String>,
    pub upstream: Option<String>,
    pub here: Option<String>,
    /// A side that isn't text (or is over 1 MB) is not shown.
    pub not_shown: bool,
}

/// The 3-way Compare of a linked copy (R3).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compare3 {
    pub skill: String,
    pub origin_words: String,
    /// "the team library at 12 Oct · a3f9c21".
    pub base_label: Option<String>,
    pub upstream_label: String,
    pub here_label: String,
    pub files: Vec<Compare3File>,
    /// Why the compare is 2-way (the version it started from isn't on this
    /// Mac).
    pub note: Option<String>,
    /// After Keep mine: why this repository's lines that the team changed
    /// before are marked too (they differ from the version kept over).
    pub kept_note: Option<String>,
    pub state: LinkState,
    /// Why *Propose mine upstream* can't be pressed, once known.
    pub propose_blocked: Option<String>,
}

/// §14 Q18: a file over 1 MB is not shown.
const SHOWN_CAP: usize = 1024 * 1024;

fn shown(bytes: Option<&Vec<u8>>) -> (Option<String>, bool) {
    match bytes {
        None => (None, false),
        Some(bytes) if bytes.len() > SHOWN_CAP => (None, true),
        Some(bytes) => match String::from_utf8(bytes.clone()) {
            Ok(text) => (Some(text.replace("\r\n", "\n")), false),
            Err(_) => (None, true),
        },
    }
}

/// Per file: who changed it, from the three versions (line endings aside).
pub(crate) fn compare3_files(
    base: Option<&BTreeMap<String, Vec<u8>>>,
    upstream: &BTreeMap<String, Vec<u8>>,
    here: &BTreeMap<String, Vec<u8>>,
) -> Vec<Compare3File> {
    let normal = |bytes: Option<&Vec<u8>>| bytes.map(|b| String::from_utf8_lossy(b).replace("\r\n", "\n").into_bytes());
    let mut paths: Vec<&String> = upstream.keys().chain(here.keys()).chain(base.into_iter().flat_map(|b| b.keys())).collect();
    paths.sort();
    paths.dedup();
    let mut out = Vec::new();
    for path in paths {
        let (b, u, h) = (base.and_then(|b| b.get(path)), upstream.get(path), here.get(path));
        let (nb, nu, nh) = (normal(b), normal(u), normal(h));
        let status = match base {
            None if nu == nh => continue,
            None => "differs",
            Some(_) if nb == nu && nu == nh => continue,
            Some(_) if nu == nh => "same",
            Some(_) if nb == nu => "here",
            Some(_) if nb == nh => "upstream",
            Some(_) => "both",
        };
        let (base_text, b_hidden) = shown(b);
        let (upstream_text, u_hidden) = shown(u);
        let (here_text, h_hidden) = shown(h);
        out.push(Compare3File {
            path: path.clone(),
            status: status.to_string(),
            base: base_text,
            upstream: upstream_text,
            here: here_text,
            not_shown: b_hidden || u_hidden || h_hidden,
        });
    }
    // `SKILL.md` first: it is the skill.
    out.sort_by_key(|file| (file.path != "SKILL.md", file.path.clone()));
    out
}

fn files_map(files: &[sc::SourceFile]) -> BTreeMap<String, Vec<u8>> {
    files.iter().map(|file| (file.path.clone(), file.bytes.clone())).collect()
}

/// **3-way Compare** (R3, §9): *upstream before* (the base: this Mac's
/// base store first, else the library's history at the link's commit),
/// *upstream now* and *here*, per file. With no base on this Mac it is 2-way
/// and says so; Keep mine and Take upstream still work.
#[tauri::command]
pub async fn skills_hub_compare3<R: tauri::Runtime>(app: tauri::AppHandle<R>, workspace_id: String, skill: String) -> Result<Compare3, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Compare3, String> {
        let skill = crate::project_skills::safe_name(&skill)?;
        let (_, cwd) = workspace_checkout(&app, &workspace_id)?;
        // H4 Windows re-walk: each step's time in the log, so a slow Compare
        // says where it went.
        let t0 = std::time::Instant::now();
        let read = read_link(&app, &cwd, &skill)?;
        let t_read = t0.elapsed().as_millis();
        let origin = &read.effective.origin;
        let words = super::skills_hub_copy::origin_words_here(&app, origin);
        let clone = read
            .clone
            .clone()
            .ok_or_else(|| format!("{words} isn't available on {THIS_MACHINE}, so there is nothing to compare with."))?;
        let path = origin.path.clone().ok_or("the link names no directory in the library")?;
        let head = crate::library_snapshot::head_commit(&clone)?;
        let upstream = sc::read_source(&clone, &head, &path).map(|s| files_map(&s.files)).unwrap_or_default();
        // H5 (R12 edge): with the twins apart, the copy compared is the one
        // that changed alone — the compare is about one skill, not two.
        let here_at = match twins_judgement(&app, &workspace_id, &cwd, &skill, &read) {
            crate::skill_twins::Judgement::Follows(winner) => Some(crate::project_skills::under(&cwd, winner.root()).join(&skill)),
            _ => here_dir(&cwd, &skill),
        };
        let here = here_at.map(|dir| files_of_dir(&dir)).unwrap_or_default();
        let t_files = t0.elapsed().as_millis();
        let config_dir = config_dir_of(&app)?;
        // H4 Windows walk: also after a rename, and for a link made before
        // H4 (nothing in the store).
        let base = start_files(&config_dir, &clone, &read.effective);
        log::info!(
            "skills hub: compare3 {skill}: link read {t_read} ms, files {} ms, start {} ms",
            t_files - t_read,
            t0.elapsed().as_millis() - t_files
        );
        let caught_up = read.effective.origin.version.commit != read.link.origin.version.commit;
        let kept_mine = read.effective.kept_mine;
        let note = base.is_none().then(|| {
            format!("The version this copy started from isn't on {THIS_MACHINE}, so this compares {words} now with this repository's copy.")
        });
        let started = std::time::Instant::now();
        // H4 Windows re-walk: never a GitHub round trip to open a Compare
        // (it took 36 s while the 2-way opened in 0.3 s). Only what this
        // machine already knows; Propose asks GitHub itself when pressed.
        let propose_blocked = match current_team_repo(&app) {
            // H8: a copy of another workspace's skill is proposed there.
            _ if crate::skill_copy::is_copy_origin(origin) => Some(copy_propose_words(&words)),
            Some(slug) => {
                let team = app.state::<crate::team::TeamStore>();
                let has_clone = team.clone_dir(&slug).join(".git").exists();
                let can_write = team.cached_membership(&slug).and_then(|cached| cached.can_write);
                let refusal = app.state::<crate::license::LicenseStore>().team_access().refusal();
                let (allowed, reason) = promote_permission(refusal, has_clone, can_write, can_write.is_none(), team_owner(&clone).as_deref());
                (!allowed).then(|| reason.unwrap_or_else(|| crate::team_proposal::read_only_words(team_owner(&clone).as_deref())))
            }
            None => Some(no_team_message()),
        };
        log::info!("skills hub: compare3 {skill}: propose gate {} ms", started.elapsed().as_millis());
        Ok(Compare3 {
            files: compare3_files(base.as_ref(), &upstream, &here),
            // H4 Mac walk: no commit codes in the headings (P-D2), and the
            // starting point named for what it is.
            base_label: base.as_ref().map(|_| base_words(&words, kept_mine, caught_up)),
            kept_note: (base.is_some() && kept_mine).then(|| kept_note(&words)),
            upstream_label: format!("{} now", lead_words(&words)),
            here_label: "This repository".to_string(),
            origin_words: words,
            skill,
            note,
            state: read.state,
            propose_blocked,
        })
    })
    .await
    .map_err(|error| format!("join compare3: {error}"))?
}

/// The files a linked copy starts from, for both Compares (H4 Windows walk):
/// this machine's base store — the copies' own base first (after a Rename
/// here that came with other library changes it is the old version renamed),
/// then the version's — else the clone's history at the version's commit,
/// under the record's path or, when the library renamed the skill since
/// (that commit has no such folder), the folder that held the version's
/// content id, with the rename brought into its `SKILL.md` as the library
/// writes it now. A link made before H4 (nothing in the store) still gets
/// its base from the clone; read from there it is kept in the store.
pub(crate) fn start_files(config_dir: &Path, clone: &Path, link: &SkillLink) -> Option<BTreeMap<String, Vec<u8>>> {
    let version = &link.origin.version;
    let base_id = link.base.claude.as_ref().or(link.base.codex.as_ref()).filter(|id| **id != version.content_id);
    for id in base_id.into_iter().chain(std::iter::once(&version.content_id)) {
        if let Some(files) = crate::skill_bases::read(config_dir, id) {
            return Some(files_map(&files));
        }
    }
    let path = link.origin.path.as_deref()?;
    if let Ok(source) = sc::read_source(clone, &version.commit, path) {
        let _ = crate::skill_bases::store(config_dir, &source.tree, &source.files);
        return Some(files_map(&source.files));
    }
    // The same renamed start the state reads ([`effective_link`]).
    renamed_start_files(clone, link).map(|files| files_map(&files))
}

/// How a Compare names the version a copy starts from (H4 Mac walk): never
/// a commit code (P-D2), and after Keep mine never "when it was linked".
pub(crate) fn base_words(words: &str, kept_mine: bool, caught_up: bool) -> String {
    if kept_mine {
        format!("{}'s version you kept yours over", lead_words(words))
    } else if caught_up {
        format!("{} when this copy last matched it", lead_words(words))
    } else {
        format!("{} when linked", lead_words(words))
    }
}

/// After Keep mine, the lines this repository never edited but kept over
/// the team's change differ from the starting point too: say so, so they
/// don't read as this repository's edits.
pub(crate) fn kept_note(words: &str) -> String {
    format!(
        "You kept this repository's copy over this version, so the lines where you kept yours over \
         {words}'s change are marked too, even where nobody edited them in this repository."
    )
}

// ── Inbox decision rows (R3, R8, R14) ───────────────────────────────

/// One decision a linked copy asks for, for the Inbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Decision {
    pub skill: String,
    pub state: LinkState,
    /// Stable while the question stands: the library's content id (or the
    /// new name) it is about.
    pub about: String,
    pub renamed_to: Option<String>,
}

/// What the library said for one link at one clone `HEAD`: the Inbox reads
/// it again on every board change, and the answer only changes with a pull.
/// Keyed by `(HEAD, path, link commit, link content id, trusted)`; bounded.
fn upstream_cached(clone: &Path, head: &str, link: &SkillLink, trusted: bool) -> Upstream {
    type Key = (String, String, String, String, bool);
    static CACHE: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashMap<Key, Upstream>>> =
        std::sync::OnceLock::new();
    let key: Key = (
        format!("{}@{head}", clone.display()),
        link.origin.path.clone().unwrap_or_default(),
        link.origin.version.commit.clone(),
        link.origin.version.content_id.clone(),
        trusted,
    );
    let cache = CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().get(&key) {
        return hit.clone();
    }
    let read = crate::skill_upstream::read(clone, &link.origin, trusted);
    let mut cache = cache.lock();
    if cache.len() > 512 {
        cache.clear();
    }
    cache.insert(key, read.clone());
    read
}

/// The decisions one workspace's linked copies ask for: *Both changed*,
/// *Removed*, *Renamed* — once per skill, and not while a skill card carries
/// it or this Mac's proposal of its current content stands. `clone` is the
/// team library's clone (only its links are read); `trusted` is
/// [`removal_trusted`] of it, asked once per feed.
pub(crate) fn workspace_decisions(
    cwd: &Path,
    clone: &Path,
    trusted: bool,
    cards: &[KanbanCard],
    state: &crate::skills_hub_state::HubState,
) -> Vec<Decision> {
    if !cwd.is_dir() {
        return Vec::new();
    }
    let Some(clone_name) = clone.file_name().and_then(|n| n.to_str()) else {
        return Vec::new();
    };
    let (links, _) = skill_links::read_checkout(cwd);
    if links.is_empty() {
        return Vec::new();
    }
    let Ok(head) = crate::library_snapshot::head_commit(clone) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (skill, link) in links {
        if link.origin.kind != skill_links::KIND_TEAM || crate::team::slug_dir_name(&link.origin.source) != clone_name {
            continue;
        }
        // H6b (Windows walk): an open pull request carrying it counts too.
        let on_its_way = cards.iter().any(|card| skill_card_on_its_way(card, &skill));
        if on_its_way {
            continue;
        }
        let mut upstream = upstream_cached(clone, &head, &link, trusted);
        if upstream == Upstream::Unavailable {
            continue;
        }
        // H4 Mac walk: judged from the version the copy here caught up with
        // (a proposal that merged), as the row is.
        let here = sc::checkout_twin_ids(cwd, &skill);
        let recorded_commit = link.origin.version.commit.clone();
        let link = effective_link(Some(clone), &link, &here, Some((cwd, skill.as_str())));
        if link.origin.version.commit != recorded_commit {
            upstream = upstream_cached(clone, &head, &link, trusted);
        }
        let (state, about, renamed_to) = match &upstream {
            Upstream::Missing => (LinkState::Removed, "removed".to_string(), None),
            Upstream::Renamed { name, .. } => (LinkState::Renamed, name.clone(), Some(name.clone())),
            Upstream::At(id) if skill_links::upstream_moved(&link, &upstream) => {
                if skill_links::link_state(&link, &here, &upstream) != LinkState::BothChanged
                    || standing_proposal(state, &link, &here).is_some()
                {
                    continue;
                }
                (LinkState::BothChanged, id.clone(), None)
            }
            _ => continue,
        };
        out.push(Decision { skill, state, about, renamed_to });
    }
    out
}

/// The Inbox row's id: `skill-decision:<workspace>:<skill>:<state>:<about>`.
pub(crate) fn decision_id(workspace_id: &str, decision: &Decision) -> String {
    let state = match decision.state {
        LinkState::BothChanged => "both",
        LinkState::Removed => "removed",
        LinkState::Renamed => "renamed",
        _ => "other",
    };
    format!("skill-decision:{workspace_id}:{}:{state}:{}", decision.skill, decision.about)
}

/// The Inbox row's title and detail.
pub(crate) fn decision_words(workspace_name: &str, decision: &Decision) -> (String, String) {
    let skill = &decision.skill;
    match decision.state {
        LinkState::Removed => (
            format!("{skill} was removed from the team library — keep it in {workspace_name}?"),
            "Keep makes it an ordinary skill of the repository; Remove takes it out with a card.".to_string(),
        ),
        LinkState::Renamed => (
            format!(
                "{skill} was renamed to {} in the team library",
                decision.renamed_to.as_deref().unwrap_or("a new name")
            ),
            format!("Rename it in {workspace_name} too, or keep the old name and stay linked."),
        ),
        _ => (
            format!("{skill} changed in the team library and here"),
            format!("Compare and choose what {workspace_name} keeps: yours, the team's, or yours proposed to the team."),
        ),
    }
}

#[cfg(test)]
#[path = "skills_hub_decisions_tests.rs"]
mod tests;
