//! Shared Knowledge and project skills on the shared-config channel (GH #82,
//! ADR 0003, card 4 of 4).
//!
//! **What travels.** A Knowledge note with scope Shared · Project
//! (`.atelier/library/knowledge/<slug>.md`) and a project skill
//! (`.claude/skills/<name>/`). Saving, editing or deleting a note, and
//! publishing or removing a skill, commits the item straight onto the
//! integration branch through the card-2 channel (`shared_config`): git
//! plumbing onto the fetched tip, never the user's checkout, a retry on a
//! non-fast-forward and a pull request when the push is refused. Messages:
//! `knowledge: <title>` and `skill: <name>`. Personal Knowledge never comes
//! here.
//!
//! **Instruction files (GH #101, BOARDS.md §5).** `AGENTS.md` and `CLAUDE.md`
//! at the repository root travel on this same channel, as
//! [`ItemKind::Instructions`], with one rule of their own: they are **never
//! overridden**. A direct commit only when every file the change writes still
//! carries on the branch the blob it carried when the edit began
//! ([`LibraryChange::bases`]); otherwise the same commit goes into a pull
//! request `Instructions: <file>` instead, and nothing is written over.
//! Message `instructions: <what changed>`.
//!
//! **The mirror.** Readers don't use the checkout for a shared workspace
//! (it may be on another branch, or behind): Ply keeps
//! `projects/<ws>/shared_library/`, the tip's `.atelier/library/knowledge/`
//! and `.claude/skills/` with this Mac's queued changes laid over them, and
//! rebuilds it on every definition refresh. The Knowledge panel, the dispatch
//! paths and the `knowledge_search` sidecar read the Project layer from it
//! (`ply_memory::project_layer_root`). Claude loads a skill the checkout
//! doesn't have yet through `projects/<ws>/shared_skills_plugin/`, handed to
//! every session as a `--plugin-dir` (named `project`).
//!
//! **Offline** a change is applied to the mirror at once and waits in
//! `projects/<ws>/shared_library_queue.json` (atomic), drained on the next
//! refresh. **Conflicts** on one note: last writer wins, and the commit names
//! the author it overrode; the other Mac's refresh toasts the change with its
//! author ([`LibraryUpdate`]).
//!
//! **Skills never override either** (skills group B §2, ADR 0005 amendment).
//! A skill change records, per root, the tree the branch held when the change
//! began ([`LibraryChange::bases`]); if a root the change writes is not that
//! tree on the tip any more — an edited, added or removed file, in either CLI's
//! copy — the commit goes into a pull request `Skill: <name>` instead, exactly
//! as an instruction file's does. A skill the branch never had and still does
//! not have is simply committed.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::platform::THIS_MACHINE;
use crate::shared_config::{
    ago, fallback_branches, integration_lock, pr_number, push_fallback, FallbackError,
    FallbackPush, Gh, Plumbing, PrState, PullRequest, FetchFailure, PushResult, TreeChange,
    TreeEntry, NEVER_OVERRIDE_MARKER, REFUSED_MARKER, SKILL_NEVER_OVERRIDE_MARKER,
};

/// GH #101 review 1: the queue key every instructions change shares, so one
/// procedure is one queued item however many of the two files it writes.
pub const INSTRUCTIONS_KEY: &str = "instructions";

pub const KNOWLEDGE_PATH: &str = ".atelier/library/knowledge";
pub const SKILLS_PATH: &str = ".claude/skills";
/// GH #105: the Codex half of a skill on the branch. Claude reads
/// `.claude/skills/<name>/` and Codex `.agents/skills/<name>/`
/// ([`crate::project_skills`] measured both), so a skill that reaches both CLIs
/// is **one item in two directories** — and the channel carries it as one.
pub const CODEX_SKILLS_PATH: &str = crate::project_skills::CODEX_ROOT;
pub const QUEUE_FILENAME: &str = "shared_library_queue.json";
/// `projects/<ws>/shared_library_published.json`: the tree each skill root had
/// on the branch after this Mac last published it **from its checkout**
/// ([`PublishedHere`]).
pub const PUBLISHED_FILENAME: &str = "shared_library_published.json";
pub const PLUGIN_NAME: &str = "project";
/// The builds behind the `shared_library` symlink.
pub const MIRROR_VERSIONS_DIR: &str = "shared_library_versions";
/// The `project` plugins handed to Claude sessions, one directory per
/// content (`<digest>/`), each with a `<digest>.last-used` stamp.
pub const SESSION_PLUGINS_DIR: &str = "shared_skills_session_plugins";
/// A plugin not handed to any session for this long is removed: a session
/// that old is not still running.
const SESSION_PLUGIN_KEEP: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 3600);
const SCHEMA_VERSION: u32 = 1;
/// The mirror manifest's own version, which the queue's is not.
///
/// GH #162: `2` is the first version that **says** it records the instruction
/// files. `1` covers two different builds — one from before GH #101, whose
/// `items` record notes and skills only, and 1.144.0's, which records the
/// instruction files under the same number — so the version alone is not the
/// question to ask; [`recorded_instructions`] is.
const MANIFEST_SCHEMA_VERSION: u32 = 2;

// ── Items ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Knowledge,
    Skill,
    /// GH #101 (BOARDS.md §5): a root instruction file — `AGENTS.md` or
    /// `CLAUDE.md`. `name` is the file name, and one change may carry **both**
    /// files, which is how the `Set up` flow publishes them in one commit.
    Instructions,
}

impl ItemKind {
    /// The item's path from the repository root: a note's file, a skill's
    /// directory, an instruction file's own name.
    pub fn repo_path(self, name: &str) -> String {
        match self {
            Self::Knowledge => format!("{KNOWLEDGE_PATH}/{name}.md"),
            Self::Skill => format!("{SKILLS_PATH}/{name}"),
            Self::Instructions => name.to_string(),
        }
    }

    /// GH #105: **every** path the item occupies. A note is one file; a skill is
    /// its two roots, whether or not both are there yet — which is what makes
    /// `Update on <branch>` publish both copies together and a removal take both.
    ///
    /// [`Self::repo_path`] stays the item's primary path (the Claude root for a
    /// skill): it is what the manifest's history lookups and every pre-#105
    /// queued change are spelled with.
    pub fn repo_paths(self, name: &str) -> Vec<String> {
        match self {
            // An instruction file is one path, and one item per file (GH #101):
            // the pair is a *change*, not an item, because "never override" is a
            // question about one file.
            Self::Knowledge | Self::Instructions => vec![self.repo_path(name)],
            Self::Skill => vec![
                format!("{SKILLS_PATH}/{name}"),
                format!("{CODEX_SKILLS_PATH}/{name}"),
            ],
        }
    }

    pub fn key(self, name: &str) -> String {
        format!("{}/{name}", self.prefix())
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::Knowledge => "knowledge",
            Self::Skill => "skill",
            Self::Instructions => "instructions",
        }
    }

    /// The kind a manifest or queue key names, for the refresh's diff.
    fn from_prefix(prefix: &str) -> Self {
        match prefix {
            "skill" => Self::Skill,
            "instructions" => Self::Instructions,
            _ => Self::Knowledge,
        }
    }
}

/// A slug or skill directory: one plain path component.
pub fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(format!("{name:?} is not a usable name"));
    }
    Ok(())
}

/// [`check_name`], plus the one extra rule instruction files carry: the name
/// must be one of the two the CLIs read.
///
/// GH #101: `check_name` alone would accept `README.md` as an "instructions"
/// item, and `check_path` would then refuse the commit — a refusal deep inside
/// a publish rather than at the door. Every entry point to the channel asks
/// this instead.
pub fn check_item_name(kind: ItemKind, name: &str) -> Result<(), String> {
    check_name(name)?;
    if kind == ItemKind::Instructions && !crate::shared_config::INSTRUCTION_FILES.contains(&name) {
        return Err(format!(
            "{name:?} is not an instruction file Plyloft publishes — only {} and {}",
            crate::shared_config::INSTRUCTION_FILES[0],
            crate::shared_config::INSTRUCTION_FILES[1],
        ));
    }
    Ok(())
}

/// One file of an item, from the repository root.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFile {
    pub path: String,
    /// Base64.
    pub bytes: String,
    #[serde(default)]
    pub executable: bool,
}

impl LibraryFile {
    pub fn new(path: String, bytes: &[u8], executable: bool) -> Self {
        Self {
            path,
            bytes: base64::engine::general_purpose::STANDARD.encode(bytes),
            executable,
        }
    }

    pub fn decoded(&self) -> Result<Vec<u8>, String> {
        base64::engine::general_purpose::STANDARD
            .decode(&self.bytes)
            .map_err(|e| format!("queued file {}: {e}", self.path))
    }
}

/// GH #105 (review 1): one copy the channel makes **on the tip it commits to**.
///
/// Not a snapshot of the bytes: `from` is read out of the fetched tip when the
/// commit is built, so a teammate's push to the source root since the plan was
/// made is what gets copied rather than being deleted or reverted by a stale
/// payload. Only `to` is written.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillCopy {
    /// The skill, for the sentence a skip has to say.
    pub name: String,
    /// The root read: `.claude/skills/<name>` or `.agents/skills/<name>`.
    pub from: String,
    /// The root written. Never `from`.
    pub to: String,
    /// The member chose this copy over one that is already there (an `Align`).
    /// Without it a destination that exists is skipped, never overwritten.
    #[serde(default)]
    pub replace: bool,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

/// One item waiting for the integration branch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryChange {
    pub kind: ItemKind,
    /// Slug or skill directory.
    pub name: String,
    /// The note's title, or the skill's name, for messages and toasts.
    pub title: String,
    /// The item's new files; `None` removes it.
    pub files: Option<Vec<LibraryFile>>,
    /// The item's object id on the branch when the edit was made (`None`:
    /// absent). A different id at publish time means someone else changed it.
    #[serde(default)]
    pub base: Option<String>,
    /// GH #101 — **never override an instruction file.**
    ///
    /// For [`ItemKind::Instructions`], the blob id each published file had on
    /// the integration branch when the edit began, by repository-relative path
    /// (`None`: the branch had no such file). Recorded by the flow that reads
    /// the before/after, not by the queue, because "the one the edit started
    /// from" is the one the member was shown.
    ///
    /// [`prepare`] compares it against the freshly fetched tip: any difference
    /// and the change goes into a pull request instead of a commit. A path with
    /// no entry here counts as "was absent", which is the safe direction — a
    /// file the branch already carries then looks moved and opens a pull
    /// request rather than being written over.
    ///
    /// Skills group B §2 — **a skill is never overridden either.** For
    /// [`ItemKind::Skill`] the keys are the skill's two roots
    /// (`.claude/skills/<name>`, `.agents/skills/<name>`, per skill a change
    /// carries) and the values their **tree** ids, so the comparison covers every
    /// file of both copies, not one `SKILL.md`. Recorded by the flow when it knows
    /// better ([`checkout_skill_bases`] for `Update on <branch>`), otherwise by
    /// [`enqueue`] from the mirror's manifest — what the Library showed. Empty in
    /// a skill change queued by an older build, which is then judged by
    /// [`Self::base`], the same whole-skill id.
    #[serde(default)]
    pub bases: BTreeMap<String, Option<String>>,
    #[serde(default)]
    pub queued_at: i64,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub last_error: Option<String>,
    /// F3/F9 (team walk): whether the last attempt could not reach origin at
    /// all. `last_error` alone can't say it: a branch origin lacks is an error
    /// too, and that one is something to fix, not to wait out. `None`: an
    /// entry from before this field, which the row reads as it always did.
    #[serde(default)]
    pub last_offline: Option<bool>,
    #[serde(default)]
    pub pull_request: Option<PullRequest>,
    /// Chosen once before the first attempt, like the definition's.
    #[serde(default)]
    pub pull_request_branch: Option<String>,
    /// The integration branch `pull_request` targets. A queue drained for
    /// another branch (the definition moved) withdraws it and publishes there.
    #[serde(default)]
    pub pull_request_base: Option<String>,
    /// A promoted personal note: removed from the personal layer only once
    /// the change is on the branch, so a rejected pull request loses nothing.
    #[serde(default)]
    pub personal_source: Option<PersonalSource>,
    /// A publish of this change was started: a pull request may exist from
    /// `pull_request_branch` even though no answer was recorded.
    #[serde(default)]
    pub attempt_started: bool,
    /// 1.169.0 (C4, Challenger): not published before this time (Unix ms;
    /// 0 none) — a skill's removal waits its Undo window. Every drain leaves
    /// a younger change queued; a timer publishes it when due, and a launch
    /// after a quit inside the window publishes it then.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub not_before: i64,
    /// C4 (Challenger): the queued, never-attempted change this removal
    /// replaced (an edit of the same skill not yet published). Undo puts it
    /// back instead of losing it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced: Option<Box<LibraryChange>>,
    /// Round 5 (V2): the pull requests of earlier versions of this item that
    /// this change supersedes (the item was changed again while one waited).
    /// A pull request opened for it says which (`Replaces #N`). Absent in
    /// queues written before.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replaces: Vec<PullRequest>,
    /// GH #105: the repository paths this change claims, when they are not the
    /// item's one default path ([`Self::claimed`]).
    ///
    /// Only these paths are touched: a file the tip carries under one of them
    /// and the change does not is deleted, and everything else on the branch is
    /// left exactly as it is. So an `Update on <branch>` that carries only the
    /// Claude copy cannot delete a Codex copy it was never asked about.
    ///
    /// Empty in every change written before this card, which is why it means
    /// "the item's default path" rather than "no paths".
    #[serde(default)]
    pub paths: Vec<String>,
    /// GH #105: the other skills this one change carries — a bulk
    /// `Make all available to both` is one commit, and one pending row each
    /// ([`pending_items`]).
    #[serde(default)]
    pub covers: Vec<String>,
    /// GH #105: a grouped change's own id. It keys the queue slot, so a group
    /// can neither replace nor be replaced by a single item's change.
    #[serde(default)]
    pub group: Option<String>,
    /// GH #105: the commit subject, when the action has words of its own. The
    /// derived `<kind>: <title>` otherwise.
    #[serde(default)]
    pub message: Option<String>,
    /// GH #105 (review 1): copies to make on the tip, in place of `files`.
    ///
    /// A change with these carries **no bytes**: each copy's source is read out
    /// of the branch as it is when the commit is built, and each destination is
    /// judged there too — one that holds something else is skipped with its
    /// reason unless the member chose to replace it. So a copy can neither carry
    /// stale content nor write over work it never saw.
    #[serde(default)]
    pub copies: Vec<SkillCopy>,
    /// Skills group B §2: the files are the **checkout's** copy (`Update on
    /// <branch>`). Once they are on the branch this Mac records the trees they
    /// left there ([`PublishedHere`]), because the checkout now holds them: the
    /// next publish from it is built on this Mac's own version, not a teammate's.
    /// `false` for every other source — a proposal's bytes come from the mirror,
    /// and the checkout never saw them.
    #[serde(default)]
    pub checkout_copy: bool,
    /// Review 1 of group B §2: the checkout's `HEAD` when the checkout copy was
    /// read. A later publish trusts this Mac's own record only from a checkout
    /// whose history still contains it — one switched to an older branch does not.
    #[serde(default)]
    pub checkout_head: Option<String>,
    /// The commit a pull request for this change carries, so that once it merges
    /// this Mac can tell whether the branch took exactly those trees.
    #[serde(default)]
    pub pull_request_commit: Option<String>,
    /// Group B §2: the checkout copy this change lets follow the other one —
    /// its root and its tree — recorded in [`PublishedHere::followed`] only once
    /// the change is committed.
    #[serde(default)]
    pub follow_left: Option<(String, String)>,
}

/// The personal note a "Share with project" came from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalSource {
    /// `Some`: the Workspace scope of that workspace; `None`: Global.
    pub workspace_id: Option<String>,
    pub id: String,
    /// Removed only if still as it was when shared (not edited since).
    pub updated_at: String,
}

impl LibraryChange {
    pub fn new(kind: ItemKind, name: &str, title: &str, files: Option<Vec<LibraryFile>>) -> Self {
        Self {
            kind,
            name: name.to_string(),
            title: title.to_string(),
            files,
            base: None,
            bases: BTreeMap::new(),
            queued_at: 0,
            attempts: 0,
            last_error: None,
            last_offline: None,
            pull_request: None,
            pull_request_branch: None,
            pull_request_base: None,
            personal_source: None,
            attempt_started: false,
            paths: Vec::new(),
            covers: Vec::new(),
            group: None,
            message: None,
            copies: Vec::new(),
            checkout_copy: false,
            checkout_head: None,
            pull_request_commit: None,
            follow_left: None,
            not_before: 0,
            replaced: None,
            replaces: Vec::new(),
        }
    }

    /// GH #206 review 1: this note's change under another slug — the name and
    /// the note's own file move together; nothing else about it changes.
    pub fn renamed_note(&self, name: &str) -> Self {
        let from = self.kind.repo_path(&self.name);
        let to = self.kind.repo_path(name);
        let mut moved = self.clone();
        moved.name = name.to_string();
        for file in moved.files.iter_mut().flatten() {
            if file.path == from {
                file.path = to.clone();
            }
        }
        moved
    }

    /// The queue slot this change occupies.
    ///
    /// A later change to the same item **replaces** it (`enqueue`), so what
    /// counts as "the same item" is decided here:
    ///
    /// - a grouped change (GH #105) has a slot of its own, because enqueueing it
    ///   must not evict a skill's own pending change and a later
    ///   `Update on <branch>` for one of its skills must not evict the other
    ///   thirty-three;
    /// - for instructions (GH #101 review 1) it is the constant `instructions`,
    ///   not `instructions/<file>`: the item is the repository's pair of files,
    ///   and keying by the first file written let a both-files step and a
    ///   `CLAUDE.md`-only change sit in the queue together — two commits over each
    ///   other, and two rows' worth of transient for one procedure.
    ///
    /// `ItemKind::key` keeps naming one file, because the manifest records each
    /// file's blob id separately and "never override" is a question about one.
    pub fn key(&self) -> String {
        match (&self.group, self.kind) {
            (Some(id), _) => format!("skills/{id}"),
            (None, ItemKind::Instructions) => INSTRUCTIONS_KEY.to_string(),
            (None, kind) => kind.key(&self.name),
        }
    }

    /// The repository paths this change owns: its own, or the item's default one.
    pub fn claimed(&self) -> Vec<String> {
        if self.paths.is_empty() {
            vec![self.kind.repo_path(&self.name)]
        } else {
            self.paths.clone()
        }
    }

    /// Every item this change carries, for the panels' per-row states.
    pub fn names(&self) -> Vec<String> {
        let mut names = vec![self.name.clone()];
        names.extend(self.covers.iter().cloned());
        names
    }

    /// GH #101: one change carrying the instruction files a step writes.
    ///
    /// The `Set up` flow writes `AGENTS.md` and `CLAUDE.md` together, and the
    /// board asks for **one** commit, so they travel as one item: `name` is the
    /// first of [`crate::shared_config::INSTRUCTION_FILES`] the change writes
    /// (which is also the key a later edit of the same step replaces), and
    /// `bases` carries what the branch held when the flow was planned.
    pub fn instructions(
        title: &str,
        files: Vec<LibraryFile>,
        bases: BTreeMap<String, Option<String>>,
    ) -> Result<Self, String> {
        for file in &files {
            check_item_name(ItemKind::Instructions, &file.path)?;
        }
        let name = crate::shared_config::INSTRUCTION_FILES
            .iter()
            .find(|name| files.iter().any(|file| file.path == **name))
            .ok_or_else(|| "an instructions change must write at least one of them".to_string())?;
        let mut change = Self::new(ItemKind::Instructions, name, title, Some(files));
        change.bases = bases;
        Ok(change)
    }

    /// The files `<cwd>/.claude/skills/<skill>` holds now. Nothing outside the
    /// checkout is ever read: the skill directory, `.claude/skills` and
    /// `.claude` must be real directories (no symlink anywhere on the way —
    /// `read_tree` refuses them below the root), and the path must resolve
    /// inside the checkout.
    pub fn skill_files(skill: &str, cwd: &Path) -> Result<Vec<LibraryFile>, String> {
        Self::skill_files_in(SKILLS_PATH, skill, cwd)
    }

    /// GH #105: **both** copies the checkout carries, and the roots they claim.
    ///
    /// `Update on <branch>` publishes them together, and claims only the roots
    /// the checkout actually has: a repository whose checkout carries the Claude
    /// copy alone must not delete the Codex copy somebody else put on the branch
    /// — the publish was never asked about it.
    pub fn skill_files_both(
        skill: &str,
        cwd: &Path,
    ) -> Result<(Vec<LibraryFile>, Vec<String>), String> {
        check_name(skill)?;
        let mut files = Vec::new();
        let mut paths = Vec::new();
        for root in [SKILLS_PATH, CODEX_SKILLS_PATH] {
            if std::fs::symlink_metadata(cwd.join(root).join(skill)).is_err() {
                continue;
            }
            files.extend(Self::skill_files_in(root, skill, cwd)?);
            paths.push(format!("{root}/{skill}"));
        }
        if files.is_empty() {
            return Err(format!(
                "This checkout has no copy of `{skill}` to publish: neither {SKILLS_PATH}/{skill} \
                 nor {CODEX_SKILLS_PATH}/{skill} is there."
            ));
        }
        Ok((files, paths))
    }

    /// One root's copy of `skill` in `cwd`, as the channel's files.
    pub(crate) fn skill_files_in(root: &str, skill: &str, cwd: &Path) -> Result<Vec<LibraryFile>, String> {
        check_name(skill)?;
        let dir = cwd.join(root).join(skill);
        let mut step = cwd.to_path_buf();
        let mut chain: Vec<&str> = root.split('/').collect();
        chain.push(skill);
        for part in chain {
            step.push(part);
            let meta = std::fs::symlink_metadata(&step)
                .map_err(|e| format!("{}: {e}", step.display()))?;
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "{} is a symlink; Plyloft only publishes a skill that lives in this repository",
                    step.display()
                ));
            }
            if !meta.is_dir() {
                return Err(format!("{} is not a directory", step.display()));
            }
        }
        let checkout = crate::platform::canonicalize(cwd).map_err(|e| format!("{}: {e}", cwd.display()))?;
        let resolved = crate::platform::canonicalize(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        if !crate::platform::is_within(&resolved, &checkout) {
            return Err(format!("{} resolves outside the repository", dir.display()));
        }
        let tree = crate::project_skills::read_tree(&resolved)?;
        if tree.is_empty() {
            return Err(format!("{} has no files", resolved.display()));
        }
        // Round 3 (S3): nor is a file git ignores in that folder — left out
        // of a publish and of every comparison alike (`skill_ignored`).
        let left = {
            let rels: Vec<&str> = tree.iter().map(|file| file.path.as_str()).collect();
            crate::skill_ignored::left_out(&dir, &rels)
        };
        Ok(tree
            .into_iter()
            // Files an OS drops into folders by itself are never part of a skill:
            // never published, never compared (review).
            .filter(|file| !is_os_junk(&file.path) && !left.contains(&file.path))
            .map(|file| {
                LibraryFile::new(
                    format!("{root}/{skill}/{}", file.path),
                    &file.bytes,
                    file.executable,
                )
            })
            .collect())
    }
}

/// `projects/<ws>/shared_library_queue.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryQueue {
    pub schema_version: u32,
    #[serde(default)]
    pub changes: Vec<LibraryChange>,
    /// Pull requests whose item was changed again: closed on the next drain.
    #[serde(default)]
    pub superseded_pull_requests: Vec<PullRequest>,
    /// Fallback branches of attempts whose answer was never recorded, for a
    /// change that was edited again: any open pull request from them is
    /// withdrawn on the next drain.
    #[serde(default)]
    pub superseded_branches: Vec<String>,
}

impl Default for LibraryQueue {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            changes: Vec::new(),
            superseded_pull_requests: Vec::new(),
            superseded_branches: Vec::new(),
        }
    }
}

impl LibraryQueue {
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
            && self.superseded_pull_requests.is_empty()
            && self.superseded_branches.is_empty()
    }
}

/// Where one workspace's library state lives on this Mac.
#[derive(Debug, Clone)]
pub struct Paths {
    /// `projects/<ws>/`.
    pub workspace_dir: PathBuf,
    /// The checkout, only to leave out of the plugin a skill it already has.
    pub cwd: PathBuf,
}

impl Paths {
    pub fn mirror(&self) -> PathBuf {
        self.workspace_dir.join(ply_memory::SHARED_LIBRARY_MIRROR_DIR)
    }

    fn queue(&self) -> PathBuf {
        self.workspace_dir.join(QUEUE_FILENAME)
    }
}

pub fn load_queue(paths: &Paths) -> LibraryQueue {
    let path = paths.queue();
    let Ok(bytes) = std::fs::read(&path) else {
        return LibraryQueue::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        log::warn!("shared_library: unreadable queue {path:?}: {e}");
        let aside = path.with_extension(format!("json.broken-{}", crate::shared_config::now_millis()));
        let _ = std::fs::rename(&path, aside);
        LibraryQueue::default()
    })
}

pub fn save_queue(paths: &Paths, queue: &LibraryQueue) -> Result<(), String> {
    let path = paths.queue();
    if queue.is_empty() {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove {path:?}: {e}")),
        };
    }
    crate::atomic::write_atomic_json(&path, queue)
}

// ── Skill bases (skills group B §2) ──────────────────────────────────

/// `projects/<ws>/shared_library_published.json`: per skill root, the tree the
/// branch held right after this Mac last published that root **from its
/// checkout** (`None`: it removed it).
///
/// The one fact the checkout's own history cannot give: a Library publish is a
/// commit made by plumbing, which the checkout never pulls, so after `Update on
/// <branch>` the checkout's lineage still points at the older version. Without
/// this, the member's second edit of their own skill would read as built on a
/// stale copy and open a pull request against their own change.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PublishedHere {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub roots: BTreeMap<String, PublishedRoot>,
    /// Group B §2 walk: per skill root, the branch version this Mac last **saw**
    /// the checkout's copy equal to (a refresh compared the two trees) — the
    /// base in its plainest sense, "the member had exactly this locally". Covers
    /// a skill published by an older build and a checkout that never pulled.
    #[serde(default)]
    pub observed: BTreeMap<String, PublishedRoot>,
    /// Group B §2 Windows walk: per skill root, the checkout's tree of a copy
    /// this Mac let **follow** the other one (`follow_the_edited_copy`). The
    /// checkout keeps that older copy until it pulls; while it still has exactly
    /// this tree it was not edited, so it never reads as "both copies edited".
    #[serde(default)]
    pub followed: BTreeMap<String, String>,
}

/// One root this Mac published from its checkout (review 1 of group B §2).
///
/// Trusted as a base only while all three still hold: the branch carries
/// `tree`, the newest commit touching the root there is `commit` (so nobody
/// changed it and changed it back), and the checkout's `HEAD` still descends
/// from `head` (so it was not switched to a history without the version).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PublishedRoot {
    #[serde(default)]
    pub tree: Option<String>,
    #[serde(default)]
    pub head: Option<String>,
    #[serde(default)]
    pub commit: Option<String>,
}

pub fn load_published(paths: &Paths) -> PublishedHere {
    std::fs::read(paths.workspace_dir.join(PUBLISHED_FILENAME))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_published(paths: &Paths, published: &PublishedHere) -> Result<(), String> {
    crate::atomic::write_atomic_json(&paths.workspace_dir.join(PUBLISHED_FILENAME), published)
}

/// The tree each root of skill `name` has at `rev`, keyed by the root's path
/// (`None`: that root has no copy).
pub fn skill_trees_at(git: &Plumbing, rev: &str, name: &str) -> BTreeMap<String, Option<String>> {
    ItemKind::Skill
        .repo_paths(name)
        .into_iter()
        .map(|path| {
            let tree = git
                .ls_tree(rev, &path, false)
                .into_iter()
                .find(|entry| entry.path == path && entry.kind == "tree")
                .map(|entry| entry.sha);
            (path, tree)
        })
        .collect()
}

/// One root's tree at `rev` (`None`: absent).
fn tree_at(git: &Plumbing, rev: &str, root: &str) -> Option<String> {
    git.ls_tree(rev, root, false)
        .into_iter()
        .find(|entry| entry.path == root && entry.kind == "tree")
        .map(|entry| entry.sha)
}

/// The newest commit reachable from `rev` touching `root`.
fn last_commit(git: &Plumbing, rev: &str, root: &str) -> Option<String> {
    git.history(rev, root).into_iter().next().map(|(sha, _, _)| sha)
}

/// Record the roots a checkout-copy change put on the branch (`tip` holds them).
///
/// `carried`: the commit that carried the change (a merged pull request's). A
/// root is recorded only when `tip` holds exactly the tree that commit had — a
/// pull request merged with edits is not this Mac's version any more.
fn record_checkout_publish(
    git: &Plumbing,
    paths: &Paths,
    change: &LibraryChange,
    tip: &str,
    carried: Option<&str>,
) {
    if change.kind != ItemKind::Skill || !change.checkout_copy || !change.copies.is_empty() {
        return;
    }
    let mut here = load_published(paths);
    here.schema_version = 1;
    for root in change.claimed() {
        let tree = tree_at(git, tip, &root);
        let newest = last_commit(git, tip, &root);
        if let Some(carried) = carried {
            if tree_at(git, carried, &root) != tree {
                continue;
            }
            // Review 2: the newest commit touching the root must be this pull
            // request's own — its commit (a merge keeps it, git's history follows
            // the unchanged side) or its squash (`… (#N)`). Anything else touched
            // the root after it, even if the bytes ended up the same.
            let own = newest.as_deref() == Some(carried)
                || change.pull_request.as_ref().is_some_and(|pr| {
                    newest.as_deref().and_then(|sha| git.subject(sha)).is_some_and(|subject| {
                        subject.trim_end().ends_with(&format!("(#{})", pr.number))
                    })
                });
            if !own {
                continue;
            }
        }
        here.roots.insert(
            root.clone(),
            PublishedRoot {
                tree,
                head: change.checkout_head.clone(),
                commit: newest,
            },
        );
        // A newer publish of the root moves on from any copy an earlier one
        // left behind; this one's own is recorded below.
        here.followed.remove(&root);
    }
    // Only when the followed root itself was recorded as this Mac's version.
    if let Some((root, tree)) = &change.follow_left {
        if here.roots.get(root).is_some_and(|record| record.head == change.checkout_head) {
            here.followed.insert(root.clone(), tree.clone());
        }
    }
    if let Err(e) = save_published(paths, &here) {
        log::warn!("shared_library: could not record {}'s published trees: {e}", change.name);
    }
}

/// A checkout-copy change whose pull request merged: recorded like a direct
/// commit, root by root, where the tip took exactly the pull request's trees.
fn merged_checkout_publish(git: &Plumbing, paths: &Paths, branch: &str, change: &LibraryChange) {
    let (Some(carried), Some(tip)) = (change.pull_request_commit.as_deref(), git.tip(branch)) else {
        return;
    };
    record_checkout_publish(git, paths, change, &tip, Some(carried));
}

/// Drop the records whose root the branch no longer holds as this Mac left it:
/// they can never be trusted again (a new publish writes a fresh one).
fn prune_published(git: &Plumbing, paths: &Paths, tip: &str) {
    let mut here = load_published(paths);
    let before = (here.roots.len(), here.observed.len());
    here.roots.retain(|root, record| tree_at(git, tip, root) == record.tree);
    here.observed.retain(|root, record| tree_at(git, tip, root) == record.tree);
    if (here.roots.len(), here.observed.len()) != before {
        let _ = save_published(paths, &here);
    }
}

/// Files an OS drops into folders by itself: never part of a skill's comparison.
const OS_JUNK: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];

pub(crate) fn is_os_junk(path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path);
    OS_JUNK.iter().any(|junk| base.eq_ignore_ascii_case(junk))
}

/// Every file under `dir` with its size and modification time, OS junk left
/// out — the cheap fingerprint that tells whether a root needs hashing again.
fn fingerprint(dir: &Path) -> Option<Vec<(String, u64, u128)>> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, u64, u128)>) -> Option<()> {
        for entry in std::fs::read_dir(dir).ok()? {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let meta = entry.path().symlink_metadata().ok()?;
            if meta.is_dir() {
                walk(&entry.path(), &path, out)?;
            } else if !is_os_junk(&name) {
                let at = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_nanos());
                out.push((path, meta.len(), at));
            }
        }
        Some(())
    }
    let mut out = Vec::new();
    walk(dir, "", &mut out)?;
    out.sort();
    Some(out)
}

type TreeCacheKey = (PathBuf, Option<String>);
type TreeCacheValue = (Vec<(String, u64, u128)>, Option<String>);

/// In memory, per checkout root: the last fingerprint and the tree it hashed to,
/// so a refresh re-hashes only the roots whose files changed (review).
fn tree_cache() -> &'static std::sync::Mutex<std::collections::HashMap<TreeCacheKey, TreeCacheValue>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<TreeCacheKey, TreeCacheValue>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The tree the checkout's copy of `name` under `root` would have if git added
/// it, or `None` when the checkout has no readable copy there. Hashed by git
/// from the working tree (line endings and filters as git applies them), with
/// modes from `modes_from` where the file system's executable bit means nothing
/// ([`Plumbing::tree_of_worktree_files`]); OS junk files are not part of it.
pub fn checkout_root_tree(
    git: &Plumbing,
    cwd: &Path,
    root: &str,
    name: &str,
    modes_from: Option<&str>,
) -> Option<String> {
    let dir = cwd.join(root).join(name);
    let mut print = fingerprint(&dir)?;
    // Round 3 (S3): what git ignores there is no part of the copy, so it
    // doesn't move the fingerprint either (and a rule that changes does).
    let left = {
        let rels: Vec<&str> = print.iter().map(|(path, _, _)| path.as_str()).collect();
        crate::skill_ignored::left_out(&dir, &rels)
    };
    print.retain(|(path, _, _)| !left.contains(path));
    let key = (dir.clone(), modes_from.map(str::to_string));
    if let Some((seen, tree)) = tree_cache().lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        if *seen == print {
            return tree.clone();
        }
    }
    let tree = (|| {
        // The same refusals a publish makes (a symlink, a path outside the
        // checkout), so a copy Plyloft would not publish is never "in sync".
        let files = LibraryChange::skill_files_in(root, name, cwd).ok()?;
        let prefix = format!("{root}/{name}/");
        let entries: Vec<(String, String, bool)> = files
            .iter()
            .filter_map(|file| {
                let inside = file.path.strip_prefix(&prefix)?;
                // Nor a `.git`: the id All skills' index gives this copy, or a
                // linked nested clone reads "modified here" in the Library and
                // "up to date" there.
                (!is_os_junk(inside) && !crate::skills_index::hash::is_in_git(inside))
                    .then(|| (inside.to_string(), file.path.clone(), file.executable))
            })
            .collect();
        git.tree_of_worktree_files(&format!("{root}/{name}"), &entries, modes_from).ok()
    })();
    tree_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(key, (print, tree.clone()));
    tree
}

/// The checkout's files as git itself would record them (the Windows parity
/// of group B §2): each blob is what `git add` would store — autocrlf,
/// `.gitattributes` and clean filters applied — and, where the executable bit
/// means nothing (`core.fileMode` false, always on Windows), each mode is the
/// one `modes_from` (the branch) records for that path, else the one the
/// checkout's `HEAD` records, else `100644` for a file neither has. On a Unix
/// file system that keeps it, the bit as read stays.
pub fn as_git_records(
    git: &Plumbing,
    files: Vec<LibraryFile>,
    modes_from: Option<&str>,
) -> Result<Vec<LibraryFile>, String> {
    if files.is_empty() {
        return Ok(files);
    }
    let paths: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
    let blobs = git.hash_worktree_paths(&paths, true)?;
    let file_mode = git.file_mode_meaningful();
    let mode_at = |rev: &str, path: &str| {
        git.ls_tree(rev, path, false)
            .into_iter()
            .find(|entry| entry.path == path && entry.kind == "blob")
            .map(|entry| entry.mode == "100755")
    };
    let twin_mode = |rev: &str, path: &str, blob: &str| {
        let twin = crate::skill_scripts::publish::other_copy(path)?;
        git.ls_tree(rev, &twin, false)
            .into_iter()
            .find(|entry| entry.path == twin && entry.kind == "blob" && entry.sha == blob)
            .map(|entry| entry.mode == "100755")
    };
    files
        .into_iter()
        .zip(blobs)
        .map(|(file, blob)| {
            let bytes = git
                .read_blob(&blob)
                .ok_or_else(|| format!("read the blob git made of {}", file.path))?;
            let executable = if file_mode {
                file.executable
            } else {
                modes_from
                    .and_then(|rev| mode_at(rev, &file.path))
                    .or_else(|| mode_at("HEAD", &file.path))
                    // Owner, 2026-10-20 (Windows parity): a file new to its
                    // copy whose exact bytes the branch holds in the other
                    // CLI's copy of the skill takes that copy's mode — a
                    // Mac's `check.sh` (100755) copied into the Codex copy
                    // is the same script, and asks nothing on Publish there
                    // either (`skill_scripts::publish`).
                    .or_else(|| modes_from.and_then(|rev| twin_mode(rev, &file.path, &blob)))
                    .unwrap_or(false)
            };
            Ok(LibraryFile::new(file.path, &bytes, executable))
        })
        .collect()
}

/// The branch's tip as this checkout's remote ref has it, else the mirror's.
pub fn branch_tip(git: &Plumbing, paths: &Paths) -> Option<String> {
    let manifest = load_manifest(paths)?;
    git.tip(&manifest.branch).or(manifest.commit)
}

/// What `Publish to <branch>` / `Update on <branch>` writes from the
/// checkout, before it is queued (`commands::project_skill_publish`); the
/// scripts sheet reads the same files (owner, 2026-10-19).
#[derive(Debug, Clone, PartialEq)]
pub struct CheckoutPublish {
    pub files: Vec<LibraryFile>,
    /// The roots the change claims: those this checkout has.
    pub paths: Vec<String>,
    pub bases: BTreeMap<String, Option<String>>,
    pub follows: Option<String>,
    pub left: Option<(String, String)>,
    /// The branch tip the files are set against.
    pub tip: Option<String>,
}

/// The checkout's copies of `name` as the publish writes them.
pub fn checkout_publish(git: &Plumbing, paths: &Paths, cwd: &Path, name: &str) -> Result<CheckoutPublish, String> {
    // GH #105: both copies together. The change claims only the roots
    // this checkout has, so a Codex copy on the branch that this
    // checkout does not carry is left exactly as it is.
    // 1.175.0 (A7, SEC-6; round 3, S3): the folders are read as they are on
    // disk, so what a share refuses stops this too (`.env`, a key, a `.git`),
    // and git is asked now which other files it ignores there: those are left
    // out by the read below. Before the scripts sheet and before anything is
    // queued: both commands come through here.
    check_name(name)?;
    let mut told: BTreeMap<&str, BTreeSet<String>> = BTreeMap::new();
    for root in [SKILLS_PATH, CODEX_SKILLS_PATH] {
        let dir = cwd.join(root).join(name);
        if dir.is_dir() {
            told.insert(root, crate::project_skills::refuse_unpublishable(name, &dir, true, "nothing was published")?);
        }
    }
    let (mut files, claimed) = LibraryChange::skill_files_both(name, cwd)?;
    // Round 7: the name check and the send look at the same list. The gate
    // passed over a private-named file git ignores because it is left out —
    // so what it was told is left out here, whatever the read above was told
    // meanwhile (a kept "no answer", a rule that changed), and the names are
    // checked again on the very list that goes. Never wider than the gate's.
    for (root, left_out) in &told {
        let lead = format!("{root}/{name}/");
        files.retain(|file| file.path.strip_prefix(&lead).is_none_or(|rel| !left_out.contains(rel)));
        let sent: Vec<&str> = files.iter().filter_map(|file| file.path.strip_prefix(&lead)).collect();
        crate::project_skills::refuse_private_in(name, &sent, true)?;
    }
    // 1.175.0 G6 (the sharing lane), on that same list: a name a Windows
    // computer can't hold would stop the whole project checking out there,
    // so it never reaches the branch. After the private names, as on a share.
    crate::project_skills::refuse_windows_names_of_files(
        name,
        files.iter().map(|file| file.path.as_str()),
        "nothing was published",
    )?;
    // Skills group B §2: never override. The base is the branch's version
    // this checkout's copy was last in sync with, not whatever the mirror
    // fetched a minute ago — so an edit made on an older copy waits in a
    // pull request instead of writing over a teammate's newer one.
    let bases = checkout_skill_bases(git, paths, name);
    // Group B §2 walk: an edit to one copy of a skill whose two copies were
    // the same on the branch travels to both.
    let tip = branch_tip(git, paths);
    // Windows parity: the bytes and modes git itself would record.
    let files = as_git_records(git, files, tip.as_deref())?;
    let Followed { files, follows, left } =
        follow_the_edited_copy(git, paths, cwd, name, files, &claimed, &bases, tip.as_deref())?;
    Ok(CheckoutPublish { files, paths: claimed, bases, follows, left, tip })
}

/// The integration branch's name, for the words.
pub fn branch_name(paths: &Paths) -> String {
    load_manifest(paths)
        .map(|manifest| manifest.branch)
        .unwrap_or_else(|| "the integration branch".to_string())
}

/// What [`follow_the_edited_copy`] made of the checkout's files.
#[derive(Debug, Clone, PartialEq)]
pub struct Followed {
    pub files: Vec<LibraryFile>,
    /// `"codex"` / `"claude"`: the copy that followed.
    pub follows: Option<String>,
    /// The checkout copy left behind (root, tree), for
    /// [`LibraryChange::follow_left`].
    pub left: Option<(String, String)>,
}

/// What `Update on <branch>` did beyond publishing the checkout's copies.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillPublish {
    /// Group B §2 walk: `"codex"` when the Codex copy followed the edited
    /// Claude copy (it was unchanged since the branch's version, where the two
    /// were the same), `"claude"` the other way round; `None` otherwise.
    pub follows: Option<String>,
    /// Owner, 2026-10-19: what the publish did, so the toast says "published"
    /// when the push went through and "queued" only when it truly waits.
    #[serde(default)]
    pub outcome: SkillPublishOutcome,
}

/// What `Publish to <branch>` / `Update on <branch>` came to.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SkillPublishOutcome {
    /// The push went through: the skill is on the branch.
    Published,
    /// It waits on this Mac — offline, or retried on the next Sync.
    #[default]
    Queued,
    /// Something else happened that the drain's own toast already says (a
    /// pull request, a refusal, an error retried later): no second toast.
    Said,
    /// Owner-fixes Windows walk: the drain found the branch already holding
    /// it as it is — nothing was committed, and nothing waits.
    Current,
}

/// The outcome of publishing `skill`, read from the drain's report (`None`:
/// no report — the change is still queued).
pub fn skill_publish_outcome(report: Option<&LibraryReport>, skill: &str) -> SkillPublishOutcome {
    let Some(lib) = report else {
        return SkillPublishOutcome::Queued;
    };
    let is_it = |kind: ItemKind, title: &str| kind == ItemKind::Skill && title == skill;
    if let Some(p) = lib.published.iter().find(|p| !p.removed && is_it(p.kind, &p.name)) {
        // Challenger, 2026-10-19: the drain's own toast is emitted before
        // this call returns, so the page's would replace it. Where that one
        // says more than "published" — it replaced a teammate's version, or
        // a copy was left as it is — it is the one to keep.
        return if p.over.is_some() || !lib.not_copied.is_empty() {
            SkillPublishOutcome::Said
        } else {
            SkillPublishOutcome::Published
        };
    }
    if lib.pull_requests.iter().any(|w| is_it(w.kind, &w.title))
        || lib.refused.is_some()
        || lib.blocked.is_some()
        || (lib.error.is_some() && !lib.offline)
    {
        return SkillPublishOutcome::Said;
    }
    // Owner-fixes Windows walk: "queued" only when it truly waits — still in
    // the queue, or the drain couldn't reach GitHub. A drain that took the
    // change off the queue without a commit found the branch already
    // holding it (`ChangeOutcome::Published { commit: None }`).
    if lib.offline || lib.pending.iter().any(|title| title == skill) {
        return SkillPublishOutcome::Queued;
    }
    SkillPublishOutcome::Current
}

/// Group B §2 walk: an edit made to **one** copy of a skill whose two copies
/// were the same on the branch travels to both.
///
/// "Edit in Code" opens the Claude copy, so editing a skill both CLIs read
/// leaves the Codex copy as it was — and publishing the two as they are would
/// put two different copies on the branch. When exactly one copy changed since
/// its base and the two bases were the same tree, the unchanged copy follows
/// the edited one. When both changed and they differ, Plyloft cannot tell which
/// is meant, and says so instead of publishing either.
#[allow(clippy::too_many_arguments)]
pub fn follow_the_edited_copy(
    git: &Plumbing,
    paths: &Paths,
    cwd: &Path,
    name: &str,
    files: Vec<LibraryFile>,
    claimed: &[String],
    bases: &BTreeMap<String, Option<String>>,
    modes_from: Option<&str>,
) -> Result<Followed, String> {
    let claude = format!("{SKILLS_PATH}/{name}");
    let codex = format!("{CODEX_SKILLS_PATH}/{name}");
    let unchanged = |files| Ok(Followed { files, follows: None, left: None });
    if !(claimed.contains(&claude) && claimed.contains(&codex)) {
        return unchanged(files);
    }
    let local_claude = checkout_root_tree(git, cwd, SKILLS_PATH, name, modes_from);
    let local_codex = checkout_root_tree(git, cwd, CODEX_SKILLS_PATH, name, modes_from);
    if local_claude == local_codex {
        return unchanged(files);
    }
    let base_claude = bases.get(&claude).cloned().flatten();
    let base_codex = bases.get(&codex).cloned().flatten();
    // A copy this Mac let follow the other one, still exactly as it was then:
    // not edited — the checkout simply has not pulled the followed version.
    let here = load_published(paths);
    let left_behind = |root: &str, local: &Option<String>| {
        local.is_some() && here.followed.get(root) == local.as_ref()
    };
    let claude_behind = left_behind(&claude, &local_claude);
    let codex_behind = left_behind(&codex, &local_codex);
    let aligned_at_base = base_claude.is_some() && base_claude == base_codex;
    if !aligned_at_base && !claude_behind && !codex_behind {
        // The two were not one version on the branch: each travels as it is.
        return unchanged(files);
    }
    let claude_edited = local_claude != base_claude && !claude_behind;
    let codex_edited = local_codex != base_codex && !codex_behind;
    let (from, to, follows) = match (claude_edited, codex_edited) {
        (true, false) => (&claude, &codex, "codex"),
        (false, true) => (&codex, &claude, "claude"),
        _ => {
            return Err(format!(
                "Both of this checkout's copies of {name} were edited, and they are not the same \
                 any more, so Plyloft can't tell which one to publish. Make the two match — \
                 or Align them once one is on the branch — then Update again."
            ))
        }
    };
    let mut out: Vec<LibraryFile> = files
        .iter()
        .filter(|file| !file.path.starts_with(&format!("{to}/")))
        .cloned()
        .collect();
    for file in files.iter().filter(|file| file.path.starts_with(&format!("{from}/"))) {
        let mut copy = file.clone();
        copy.path = format!("{to}{}", &file.path[from.len()..]);
        out.push(copy);
    }
    // The checkout's copy at `to` will be behind the branch by this Mac's own
    // choice once this is committed (review: recorded then, not on the press).
    let left = if to == &codex { local_codex } else { local_claude };
    Ok(Followed {
        files: out,
        follows: Some(follows.to_string()),
        left: left.map(|tree| (to.clone(), tree)),
    })
}

/// Group B §2 walk: record every skill root whose checkout copy is exactly the
/// branch's right now — the version the member has locally, whatever its git
/// history says (untracked files, a checkout that never pulled).
fn observe_in_sync(git: &Plumbing, paths: &Paths, tip: &str) {
    let Some(manifest) = load_manifest(paths) else { return };
    let names: Vec<String> = manifest
        .items
        .keys()
        .filter_map(|key| key.strip_prefix("skill/").map(str::to_string))
        .collect();
    if names.is_empty() {
        return;
    }
    let mut here = load_published(paths);
    let mut changed = false;
    let head = git.head();
    for name in names {
        for root in ItemKind::Skill.repo_paths(&name) {
            let Some(on_branch) = tree_at(git, tip, &root) else { continue };
            let Some((parent, _)) = root.rsplit_once('/') else { continue };
            let Some(local) = checkout_root_tree(git, &paths.cwd, parent, &name, Some(tip)) else {
                continue;
            };
            if local != on_branch {
                continue;
            }
            // The checkout caught up (a pull): the copy it left behind is gone,
            // and a copy that later returns to that tree is the member's own.
            if here.followed.remove(&root).is_some() {
                changed = true;
            }
            let record = PublishedRoot {
                tree: Some(on_branch),
                head: head.clone(),
                commit: last_commit(git, tip, &root),
            };
            if here.observed.get(&root) != Some(&record) {
                here.observed.insert(root.clone(), record);
                changed = true;
            }
        }
    }
    if changed {
        here.schema_version = 1;
        let _ = save_published(paths, &here);
    }
}

/// Skill `name`'s per-root trees as a manifest recorded them — what the
/// Library showed for the branch.
pub fn skill_bases_from(manifest: &Manifest, name: &str) -> BTreeMap<String, Option<String>> {
    skill_bases_from_id(name, manifest.items.get(&ItemKind::Skill.key(name)).map(String::as_str))
}

/// Skill `name`'s per-root trees from its whole-skill id (`None`: absent) — the
/// id a row showed (review 1: the bases of `Remove` and `Align` are the version
/// on screen, not whatever a refresh fetched while the dialog was open).
pub fn skill_bases_from_id(name: &str, id: Option<&str>) -> BTreeMap<String, Option<String>> {
    let (claude, codex) = id.map(skill_id_parts).unwrap_or((None, None));
    [
        (format!("{SKILLS_PATH}/{name}"), claude),
        (format!("{CODEX_SKILLS_PATH}/{name}"), codex),
    ]
    .into_iter()
    .collect()
}

/// The base of an `Update on <branch>`: per root, **the branch's version the
/// checkout's copy was last in sync with.**
///
/// Not the mirror's tree alone: the mirror follows the branch on every refresh,
/// so a teammate's edit fetched a minute before the press would already be
/// "the base", and the publish would write over it — the very case the rule is
/// for. Per root, in order:
///
/// 1. this Mac's own last publish of the root from this checkout
///    ([`PublishedRoot`]), only while the branch still carries its tree, the
///    newest commit touching the root there is that publish (nobody changed it,
///    not even and back), and `HEAD` still descends from the checkout it was
///    published from (review 1: a checkout switched to an older branch is not
///    built on it);
/// 2. otherwise the root's tree at `merge-base(HEAD, origin/<branch>)` — the
///    newest version of the branch the checkout's history contains, so a
///    checkout that pulled a teammate's change is built on it and one that did
///    not is not;
/// 3. no common history (a shallow clone, an unborn `HEAD`) → the mirror's tree,
///    what the Library showed.
pub fn checkout_skill_bases(
    git: &Plumbing,
    paths: &Paths,
    name: &str,
) -> BTreeMap<String, Option<String>> {
    let Some(manifest) = load_manifest(paths) else {
        // No build to have shown anything: every root reads as absent, the safe
        // direction (a branch that has the skill then opens a pull request).
        return ItemKind::Skill.repo_paths(name).into_iter().map(|p| (p, None)).collect();
    };
    let shown = skill_bases_from(&manifest, name);
    let mine = load_published(paths);
    // The branch as this checkout's remote ref has it now (review 1, MINOR 4),
    // the mirror's commit only when there is no such ref.
    let tip = git.tip(&manifest.branch).or(manifest.commit.clone());
    let head = git.head();
    let lineage = tip
        .as_deref()
        .and_then(|tip| git.merge_base("HEAD", tip))
        .map(|at| skill_trees_at(git, &at, name));
    // Group B §2 walk: the version this Mac saw the checkout's copy equal to, as
    // long as the branch still holds it and the checkout was not switched to a
    // history without it.
    let observed = |root: &str| -> Option<Option<String>> {
        let record = mine.observed.get(root)?;
        let tip = tip.as_deref()?;
        let descends = match (record.head.as_deref(), head.as_deref()) {
            (Some(then), Some(now)) => git.is_ancestor(then, now),
            (None, None) => true,
            _ => false,
        };
        // Strict: the newest commit on the root is still the one seen, so a
        // change made and undone since is not taken for the version seen.
        let untouched = record.commit.is_some() && last_commit(git, tip, root) == record.commit;
        (tree_at(git, tip, root) == record.tree && untouched && descends).then(|| record.tree.clone())
    };
    let own = |root: &str| -> Option<Option<String>> {
        let record = mine.roots.get(root)?;
        let tip = tip.as_deref()?;
        let recorded_head = record.head.as_deref()?;
        let head = head.as_deref()?;
        let still_there = tree_at(git, tip, root) == record.tree;
        let untouched = record.commit.is_some() && last_commit(git, tip, root) == record.commit;
        let descends = git.is_ancestor(recorded_head, head);
        (still_there && untouched && descends).then(|| record.tree.clone())
    };
    shown
        .into_iter()
        .map(|(root, on_branch)| {
            let base = if let Some(own) = own(&root) {
                own
            } else if let Some(seen) = observed(&root) {
                seen
            } else if let Some(lineage) = &lineage {
                lineage.get(&root).cloned().flatten()
            } else {
                on_branch
            };
            (root, base)
        })
        .collect()
}

/// The roots `change` writes whose tree on `tip` is no longer the one the change
/// began from — empty when nobody else has touched them.
///
/// Only the roots the change **claims** ([`LibraryChange::claimed`]): they are
/// the only ones it can write or delete, so they are the only ones it could
/// override. A root it leaves alone (the Codex copy an `Update` from a
/// Claude-only checkout never touches, the winner an `Align` only reads) is
/// left exactly as the branch has it whatever happened there.
///
/// A change queued before this rule has no `bases`, only its whole-skill `base`
/// (the same two trees, spelled as one id): it is judged by that, root by root.
fn moved_skill_roots(git: &Plumbing, tip: &str, change: &LibraryChange) -> Vec<String> {
    if change.kind != ItemKind::Skill {
        return Vec::new();
    }
    let claimed = change.claimed();
    if change.bases.is_empty() {
        let (then_claude, then_codex) = change
            .base
            .as_deref()
            .map(skill_id_parts)
            .unwrap_or((None, None));
        let now = skill_trees_at(git, tip, &change.name);
        return [
            (format!("{SKILLS_PATH}/{}", change.name), then_claude),
            (format!("{CODEX_SKILLS_PATH}/{}", change.name), then_codex),
        ]
        .into_iter()
        .filter(|(root, _)| claimed.contains(root))
        .filter(|(root, then)| now.get(root).cloned().flatten() != *then)
        .map(|(root, _)| root)
        .collect();
    }
    // A claimed root with no recorded base counts as "was absent", the safe way
    // round — as for an instruction file.
    claimed
        .into_iter()
        .filter(|root| {
            let now = git
                .ls_tree(tip, root, false)
                .into_iter()
                .find(|entry| entry.path == *root && entry.kind == "tree")
                .map(|entry| entry.sha);
            now != change.bases.get(root).cloned().flatten()
        })
        .collect()
}

/// The sentence a skill that moved on the branch waits behind: which skill,
/// which copy, and who changed it — the instructions' own shape.
fn moved_skill_sentence(
    git: &Plumbing,
    tip: &str,
    branch: &str,
    moved: &[String],
    now_secs: i64,
) -> String {
    let who = newest_change(git, tip, moved)
        .map(|(author, at)| format!("{author} changed it {}", ago(now_secs, at)))
        .unwrap_or_else(|| "it changed there".to_string());
    let names: BTreeSet<&str> = moved
        .iter()
        .filter_map(|root| root.rsplit('/').next())
        .collect();
    let names = names.into_iter().collect::<Vec<_>>().join(" and ");
    // Plain words (review 1, NIT 6): this sentence is also a toast's and a row's.
    let copies = moved.join(" and ");
    format!("{names} changed on {branch} since this change began ({copies}; {who}).")
}

// ── The mirror ────────────────────────────────────────────────────────

/// `shared_library/manifest.json`: what the mirror was built from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    /// The checkout it stands in for (`ply_memory::project_layer_root_for_cwd`).
    pub cwd: String,
    pub branch: String,
    #[serde(default)]
    pub commit: Option<String>,
    /// Item key → object id on the branch.
    #[serde(default)]
    pub items: BTreeMap<String, String>,
    /// Item key → title, for a removal's toast.
    #[serde(default)]
    pub titles: BTreeMap<String, String>,
    /// [`queue_digest`] of the queued changes laid over this build. A queue
    /// that no longer matches (a change saved but never applied — a crash or
    /// a failed build after `enqueue` saved it) makes the next refresh
    /// rebuild even when the branch hasn't moved.
    #[serde(default)]
    pub applied_queue: String,
    /// What the branch carries that the mirror leaves out, and why (a symlink).
    #[serde(default)]
    pub skipped: Vec<String>,
}

/// What a build must reflect of the queue: each change's item and contents,
/// not its attempts, errors or pull request.
pub fn queue_digest(queue: &LibraryQueue) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for change in &queue.changes {
        hasher.update(change.key().as_bytes());
        hasher.update([0]);
        // GH #105 review 1: a copy carries no bytes, so its instruction is what a
        // build has to reflect. Without this a queued copy would look like a
        // removal to `applied_queue`, and the mirror would never show it.
        for copy in &change.copies {
            hasher.update(copy.from.as_bytes());
            hasher.update([0]);
            hasher.update(copy.to.as_bytes());
            hasher.update([0, u8::from(copy.replace)]);
        }
        match &change.files {
            None => hasher.update(b"removed"),
            Some(files) => {
                for file in files {
                    hasher.update(file.path.as_bytes());
                    hasher.update([0, u8::from(file.executable)]);
                    hasher.update(file.bytes.as_bytes());
                    hasher.update([0]);
                }
            }
        }
        hasher.update([1]);
    }
    format!("{:x}", hasher.finalize())
}

/// Whether this build recorded the two instruction files at all (GH #162).
///
/// The question the refresh's diff has to ask before it calls one of them
/// `added`: a key missing from a build that never looked is not evidence the
/// branch lacked the file. Asked of the **manifest**, not of its version number —
/// 1.144.0 wrote version 1 and does record them (`items_at`), so a version test
/// alone would swallow a teammate's change made between that build and this one
/// (review 1, MAJOR).
///
/// The residual, which no manifest can answer: a 1.144.0 build of a branch that
/// carried **neither** file recorded no instruction item, and is therefore
/// indistinguishable from a pre-#101 build. An `AGENTS.md` that appeared on the
/// branch in exactly that window goes unannounced once, on this version's first
/// rebuild; it is on the page, and the next change to it is announced normally.
fn recorded_instructions(manifest: &Manifest) -> bool {
    manifest.schema_version >= MANIFEST_SCHEMA_VERSION
        || manifest
            .items
            .keys()
            .any(|key| key.starts_with(&format!("{INSTRUCTIONS_KEY}/")))
}

pub fn load_manifest(paths: &Paths) -> Option<Manifest> {
    let bytes = std::fs::read(paths.mirror().join(ply_memory::SHARED_LIBRARY_MANIFEST)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The items at `rev`: notes (`<slug>.md` blobs) and skills (directories).
pub fn items_at(git: &Plumbing, rev: &str) -> BTreeMap<String, String> {
    let mut items = BTreeMap::new();
    for entry in git.ls_tree(rev, &format!("{KNOWLEDGE_PATH}/"), false) {
        let Some(name) = entry.path.rsplit('/').next() else { continue };
        if let (Some(slug), "blob") = (name.strip_suffix(".md"), entry.kind.as_str()) {
            items.insert(ItemKind::Knowledge.key(slug), entry.sha);
        }
    }
    // GH #105: a skill is one item in two roots, so its id covers both — an edit
    // to either copy on the branch is a change to the skill, and a refresh says
    // so once rather than twice or not at all.
    let mut sides: BTreeMap<String, (Option<String>, Option<String>)> = BTreeMap::new();
    for (root, claude) in [(SKILLS_PATH, true), (CODEX_SKILLS_PATH, false)] {
        for entry in git.ls_tree(rev, &format!("{root}/"), false) {
            let Some(name) = entry.path.rsplit('/').next() else { continue };
            if entry.kind != "tree" {
                continue;
            }
            let slot = sides.entry(name.to_string()).or_default();
            if claude {
                slot.0 = Some(entry.sha);
            } else {
                slot.1 = Some(entry.sha);
            }
        }
    }
    for (name, (claude, codex)) in sides {
        if let Some(id) = skill_id(claude, codex) {
            items.insert(ItemKind::Skill.key(&name), id);
        }
    }
    // GH #101: each instruction file is its own item here, because "never
    // override" is a question about one file's blob (a change may write both,
    // and each is judged on its own).
    for name in crate::shared_config::INSTRUCTION_FILES {
        for entry in git.ls_tree(rev, name, false) {
            if entry.kind == "blob" && entry.path == name {
                items.insert(ItemKind::Instructions.key(name), entry.sha);
            }
        }
    }
    items
}

/// The two sides of a skill's id, as [`skill_id`] spelled them.
///
/// Its exact inverse, and only ever applied to ids Ply itself wrote into a
/// manifest: `<claude>`, `<claude>+<codex>`, or `-+<codex>` for a skill the branch
/// carries for Codex alone.
fn skill_id_parts(id: &str) -> (Option<String>, Option<String>) {
    match id.split_once('+') {
        None => (Some(id.to_string()), None),
        Some(("-", codex)) => (None, Some(codex.to_string())),
        Some((claude, codex)) => (Some(claude.to_string()), Some(codex.to_string())),
    }
}

/// The id to record for a skill this drain **copied**: the destination root as the
/// commit left it, and the source root as the **last build** recorded it
/// (review 2).
///
/// So this Mac's own copy is never announced back to it — the destination is
/// accounted for — while an edit somebody else made to the source root, which the
/// copy sat on top of and did not make, is still a change this Mac has not seen
/// and is still announced.
///
/// `last_build` is the manifest as it was before this drain: the state this Mac
/// last showed the member. `None` for a skill it had no record of, which makes the
/// source side absent and the item read as changed — the safe way round.
fn copied_item_id(
    git: &Plumbing,
    commit: &str,
    last_build: Option<&Manifest>,
    copy: &SkillCopy,
) -> Option<String> {
    let name = &copy.name;
    let at = |path: &str| {
        git.ls_tree(commit, path, false)
            .into_iter()
            .next()
            .map(|entry| entry.sha)
    };
    let seen = last_build
        .and_then(|manifest| manifest.items.get(&ItemKind::Skill.key(name)))
        .map(|id| skill_id_parts(id));
    let codex = format!("{CODEX_SKILLS_PATH}/{name}");
    if copy.to == codex {
        skill_id(seen.and_then(|(claude, _)| claude), at(&codex))
    } else {
        skill_id(at(&format!("{SKILLS_PATH}/{name}")), seen.and_then(|(_, codex)| codex))
    }
}

/// One skill's object id across its two roots.
///
/// A skill with no Codex copy keeps **exactly** the id it had before GH #105 —
/// its Claude tree's sha — so a manifest written by an older build still matches
/// and the first refresh after the upgrade announces nothing that did not happen.
fn skill_id(claude: Option<String>, codex: Option<String>) -> Option<String> {
    match (claude, codex) {
        (None, None) => None,
        (Some(claude), None) => Some(claude),
        (claude, Some(codex)) => Some(format!(
            "{}+{codex}",
            claude.unwrap_or_else(|| "-".to_string())
        )),
    }
}

fn item_sha(git: &Plumbing, rev: &str, kind: ItemKind, name: &str) -> Option<String> {
    let at = |path: &str| {
        git.ls_tree(rev, path, false)
            .into_iter()
            .next()
            .map(|entry| entry.sha)
    };
    match kind {
        ItemKind::Knowledge | ItemKind::Instructions => at(&kind.repo_path(name)),
        ItemKind::Skill => skill_id(
            at(&format!("{SKILLS_PATH}/{name}")),
            at(&format!("{CODEX_SKILLS_PATH}/{name}")),
        ),
    }
}

/// N14 review (P2-1): a path from a git tree or a payload, checked before it
/// is joined to a directory: forward-slash components only, none of them
/// empty, `.` or `..`, no `\` or NUL anywhere, and no drive (`C:`) in any
/// component. `:` is refused anywhere on Windows (drives, alternate data
/// streams); on macOS it is an ordinary file-name character a teammate's
/// skill may use, so only the drive form is refused there.
pub(crate) fn safe_relative(relative: &str) -> Result<(), String> {
    let refused = || format!("Plyloft won't write {relative:?}: it isn't a plain path inside the folder.");
    let drive = |part: &str| {
        let bytes = part.as_bytes();
        bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
    };
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.contains(['\\', '\0'])
        || (cfg!(windows) && relative.contains(':'))
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".." || drive(part))
        || (cfg!(windows) && relative.split('/').any(windows_unsafe_name))
    {
        return Err(refused());
    }
    Ok(())
}

/// N14 review 2 (P3-a): a name Windows doesn't keep as written — one ending
/// in `.` or ` ` (trimmed away, so two names land on one file), or a device
/// name, with or without an extension: `CON`, `NUL`, `AUX`, `PRN`, `CONIN$`,
/// `CONOUT$`, and `COM` or `LPT` followed by one of `0`–`9` or the superscript
/// digits `¹` `²` `³` (1.175.0 G6: Microsoft's "Naming Files, Paths, and
/// Namespaces" lists `COM0`, `LPT0` and the superscript forms with the rest,
/// and Git for Windows refuses `CONIN$` and `CONOUT$` as it does `CON`).
pub(crate) fn windows_unsafe_name(part: &str) -> bool {
    if part.ends_with('.') || part.ends_with(' ') {
        return true;
    }
    let stem = part.split('.').next().unwrap_or(part).trim_end().to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "NUL" | "AUX" | "PRN" | "CONIN$" | "CONOUT$") {
        return true;
    }
    let Some(port) = stem.strip_prefix("COM").or_else(|| stem.strip_prefix("LPT")) else {
        return false;
    };
    let mut rest = port.chars();
    matches!((rest.next(), rest.next()), (Some('0'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}'), None))
}

pub(crate) fn write_file(root: &Path, relative: &str, bytes: &[u8], executable: bool) -> Result<(), String> {
    safe_relative(relative)?;
    let path = root.join(relative);
    // Belt and braces: the joined path is still under `root`, component by
    // component (no prefix or root component could have slipped in).
    if !path.starts_with(root)
        || path
            .strip_prefix(root)
            .map_or(true, |rest| rest.components().any(|c| !matches!(c, std::path::Component::Normal(_))))
    {
        return Err(format!("Plyloft won't write {relative:?} outside its folder."));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {parent:?}: {e}"))?;
    }
    // Written aside and renamed in: a reader never sees half a note.
    let tmp = path.with_file_name(format!(
        ".{}.tmp-{}",
        path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {tmp:?}: {e}"))?;
    if executable {
        let _ = crate::platform::set_mode(&tmp, 0o755);
    }
    crate::platform::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("write {path:?}: {e}")
    })
}

fn remove_path(path: &Path) {
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

/// Lay one queued change over a mirror directory.
fn apply_change(root: &Path, change: &LibraryChange) -> Result<(), String> {
    // Every item this change carries, held to its kind's own name rule (GH #101:
    // an instructions change may only name one of the two files).
    for name in change.names() {
        check_item_name(change.kind, &name)?;
    }
    for path in change.claimed() {
        // Each is a repository-relative path, and a `..` in one would step out of
        // the mirror — the queue is Ply's own file, and it is still not taken on
        // trust.
        inside_repository(&path)?;
    }
    // GH #105 review 1: a copy is laid over **this** build, so a rebuild from a
    // newer tip copies the newer source and the mirror never shows content the
    // branch has moved past. The destination is judged here as the publish will
    // judge it on the tip: one that is already there is left alone unless the
    // member chose to replace it, so the mirror cannot promise a write the commit
    // is going to skip.
    if !change.copies.is_empty() {
        for copy in &change.copies {
            inside_repository(&copy.from)?;
            // Checked before anything is removed at it (N14 review 2, P3-c).
            inside_repository(&copy.to)?;
            let source = root.join(&copy.from);
            let destination = root.join(&copy.to);
            if !source.is_dir() {
                continue;
            }
            if occupied(&destination) && !copy.replace {
                continue;
            }
            remove_path(&destination);
            for file in crate::project_skills::read_tree(&source)? {
                write_file(
                    root,
                    &format!("{}/{}", copy.to, file.path),
                    &file.bytes,
                    file.executable,
                )?;
            }
        }
        return Ok(());
    }
    // Every path the change claims, so the mirror shows what the branch will:
    // a removal takes both copies of a skill rather than leaving one behind
    // (GH #105).
    for path in change.claimed() {
        inside_repository(&path)?;
        remove_path(&root.join(path));
    }
    for file in change.files.iter().flatten() {
        write_file(root, &file.path, &file.decoded()?, file.executable)?;
    }
    Ok(())
}

/// A repository-relative path the channel may build a local path from.
/// N14 review 2 (P3-c): the same check [`write_file`] makes.
fn inside_repository(path: &str) -> Result<(), String> {
    safe_relative(path).map_err(|_| format!("{path} is not a path inside the repository"))
}

/// Is anything at all at `path` — a dangling symlink included?
fn occupied(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// The roots the mirror is built from: notes, and a skill's two directories.
const MIRROR_ROOTS: [&str; 3] = [KNOWLEDGE_PATH, SKILLS_PATH, CODEX_SKILLS_PATH];

/// `<root>/<skill>` for a path inside one skill's directory, or `None` for a
/// path that is not (a note, or a file directly under a skills root).
fn skill_prefix(path: &str) -> Option<String> {
    for root in [SKILLS_PATH, CODEX_SKILLS_PATH] {
        if let Some(rest) = path.strip_prefix(&format!("{root}/")) {
            let name = rest.split('/').next().filter(|name| !name.is_empty())?;
            // A file directly under the root is not part of a skill.
            if rest.len() == name.len() {
                return None;
            }
            return Some(format!("{root}/{name}"));
        }
    }
    None
}

fn note_title(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let front = text.strip_prefix("---")?;
    let end = front.find("\n---")?;
    front[..end].lines().find_map(|line| {
        let value = line.strip_prefix("title:")?.trim();
        let value = value.trim_matches(|c| c == '"' || c == '\'');
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// Build the mirror from `branch`'s fetched tip with `queue` laid over it,
/// replacing the old one whole. The manifest records the tip's items only.
pub fn build_mirror(
    git: &Plumbing,
    paths: &Paths,
    branch: &str,
    queue: &LibraryQueue,
) -> Result<Manifest, String> {
    let tip = git.tip(branch);
    let items = tip.as_deref().map(|t| items_at(git, t)).unwrap_or_default();
    std::fs::create_dir_all(&paths.workspace_dir)
        .map_err(|e| format!("create {:?}: {e}", paths.workspace_dir))?;
    let scratch = new_version(&paths.mirror());
    let built = (|| -> Result<Manifest, String> {
        std::fs::create_dir_all(&scratch).map_err(|e| format!("create {scratch:?}: {e}"))?;
        let mut titles = BTreeMap::new();
        let mut skipped = Vec::new();
        if let Some(tip) = tip.as_deref() {
            // A symlink in the tree is refused, as a copy out of a checkout
            // refuses one (`project_skills::read_tree`): written as a file it
            // would be its target's path, and followed it could reach outside
            // the repository. A skill containing one is left out whole; a
            // note that is one is left out.
            let entries: Vec<_> = MIRROR_ROOTS
                .iter()
                .flat_map(|root| git.ls_tree(tip, &format!("{root}/"), true))
                .collect();
            // GH #105: per root, so a symlink in the Codex copy of a skill does
            // not take the Claude copy out of the mirror with it — each root is
            // what one CLI reads, and only that one loses the skill.
            let mut refused_skills = BTreeSet::new();
            for entry in entries.iter().filter(|e| e.mode == "120000") {
                match skill_prefix(&entry.path) {
                    Some(prefix) => {
                        refused_skills.insert(prefix);
                    }
                    None => skipped.push(format!("{} is a symlink", entry.path)),
                }
            }
            for prefix in &refused_skills {
                skipped.push(format!("{prefix} contains a symlink"));
            }
            for root in MIRROR_ROOTS {
                for entry in entries.iter().filter(|e| e.path.starts_with(&format!("{root}/"))) {
                    if entry.kind != "blob" || entry.mode == "120000" {
                        continue;
                    }
                    let in_refused_skill = skill_prefix(&entry.path)
                        .is_some_and(|prefix| refused_skills.contains(&prefix));
                    if in_refused_skill {
                        continue;
                    }
                    let Some(bytes) = git.read_at(tip, &entry.path) else {
                        return Err(format!("read {} at {tip}", entry.path));
                    };
                    if root == KNOWLEDGE_PATH {
                        if let Some(slug) = entry
                            .path
                            .strip_prefix(&format!("{KNOWLEDGE_PATH}/"))
                            .and_then(|n| n.strip_suffix(".md"))
                        {
                            if let Some(title) = note_title(&bytes) {
                                titles.insert(ItemKind::Knowledge.key(slug), title);
                            }
                        }
                    }
                    write_file(&scratch, &entry.path, &bytes, entry.mode == "100755")?;
                }
            }
            // GH #101: the two root instruction files, so the Instructions page
            // reads the branch's state through the same mirror every other
            // shared reader uses — and so `inspect_root` can judge the branch
            // exactly as it judges a checkout. A symlink is refused here for the
            // reason it is refused above: written as a file it would be its
            // target's path, and followed it could leave the repository.
            for name in crate::shared_config::INSTRUCTION_FILES {
                let Some(entry) = git
                    .ls_tree(tip, name, false)
                    .into_iter()
                    .find(|entry| entry.path == name)
                else {
                    continue;
                };
                if entry.kind != "blob" {
                    continue;
                }
                if entry.mode == "120000" {
                    skipped.push(format!("{name} is a symlink"));
                    continue;
                }
                let Some(bytes) = git.read_at(tip, name) else {
                    return Err(format!("read {name} at {tip}"));
                };
                write_file(&scratch, name, &bytes, false)?;
            }
        }
        for change in &queue.changes {
            apply_change(&scratch, change)?;
        }
        let manifest = Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            cwd: paths.cwd.to_string_lossy().into_owned(),
            branch: branch.to_string(),
            commit: tip.clone(),
            items,
            titles,
            applied_queue: queue_digest(queue),
            skipped: skipped.clone(),
        };
        for reason in &skipped {
            log::warn!("shared_library: not loaded from {branch}: {reason}");
        }
        crate::atomic::write_atomic_json(&scratch.join(ply_memory::SHARED_LIBRARY_MANIFEST), &manifest)?;
        Ok(manifest)
    })();
    let manifest = match built {
        Ok(manifest) => manifest,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&scratch);
            return Err(e);
        }
    };
    swap_into(&scratch, &paths.mirror())?;
    Ok(manifest)
}

/// Where the builds of `dest` live: `<dest>_versions/<id>/`. `dest` itself is
/// a symlink to the current one.
pub fn versions_dir(dest: &Path) -> PathBuf {
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    dest.with_file_name(format!("{name}_versions"))
}

fn new_version(dest: &Path) -> PathBuf {
    versions_dir(dest).join(uuid::Uuid::new_v4().simple().to_string())
}

/// Make the finished build `scratch` current: a new symlink renamed over
/// `dest`, which replaces it atomically — a reader (the Knowledge panel, the
/// sidecar, a session loading the plugin) always finds a whole build, and a
/// crash leaves the previous one. The previous build is kept for readers
/// still inside it; older ones are removed.
fn swap_into(scratch: &Path, dest: &Path) -> Result<(), String> {
    let previous = crate::platform::read_link(dest).ok();
    let link = dest.with_file_name(format!(
        ".{}-link-{}",
        dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        uuid::Uuid::new_v4().simple()
    ));
    // Without Developer Mode on Windows this is a junction (platform::link).
    crate::platform::link(scratch, &link).map_err(|e| format!("link {link:?}: {e}"))?;
    // A plain directory from an earlier build can't be renamed over.
    if std::fs::symlink_metadata(dest).is_ok_and(|m| m.is_dir()) {
        let _ = std::fs::remove_dir_all(dest);
    }
    // Atomic on unix; Windows may have to remove the old link first
    // (platform::replace_link).
    if let Err(e) = crate::platform::replace_link(&link, dest) {
        let _ = crate::platform::remove_link(&link);
        return Err(format!("put {dest:?} in place: {e}"));
    }
    // The grace period runs from now, when the build stopped being current —
    // not from when it was built, which may be long ago.
    if let Some(previous) = previous.filter(|p| p.as_path() != scratch) {
        let _ = std::fs::write(retired_stamp(&previous), crate::shared_config::now_millis().to_string());
    }
    prune_versions(dest, scratch, OLD_BUILD_GRACE);
    Ok(())
}

/// How long a replaced build stays for a reader that resolved the link before
/// the swap (a listing, a search).
const OLD_BUILD_GRACE: std::time::Duration = std::time::Duration::from_secs(120);
/// A build never made current (a crash mid-build) goes after this long.
const ABANDONED_BUILD_AGE: std::time::Duration = std::time::Duration::from_secs(3600);

/// `<versions>/<id>.retired`: when build `<id>` was replaced.
fn retired_stamp(build: &Path) -> PathBuf {
    let name = build.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    build.with_file_name(format!("{name}.retired"))
}

/// Remove the builds of `dest` other than `current` that were retired more
/// than `grace` ago, and abandoned half-builds.
pub(crate) fn prune_versions(dest: &Path, current: &Path, grace: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(versions_dir(dest)) else {
        return;
    };
    let age = |path: &Path| {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == current || !path.is_dir() {
            continue;
        }
        let stamp = retired_stamp(&path);
        let remove = match age(&stamp) {
            Some(retired_for) => retired_for >= grace,
            None if stamp.exists() => false,
            None => age(&path).is_some_and(|built| built >= ABANDONED_BUILD_AGE.max(grace)),
        };
        if remove {
            let _ = std::fs::remove_dir_all(&path);
            let _ = std::fs::remove_file(&stamp);
        }
    }
}

/// The branch's version of skill `name` isn't what `cwd` carries: no copy,
/// or an older (or otherwise different) one. Claude then also gets the
/// branch's as `project:<name>` — an updated skill never waits for a pull.
fn checkout_lacks(cwd: &Path, skills: &Path, name: &str) -> bool {
    let local = cwd.join(SKILLS_PATH).join(name);
    if !local.exists() {
        return true;
    }
    match (
        crate::project_skills::read_tree(&local),
        crate::project_skills::read_tree(&skills.join(name)),
    ) {
        (Ok(local), Ok(branch)) => local != branch,
        _ => true,
    }
}

/// The `project` plugin for a Claude session Ply starts in `session_cwd` —
/// the checkout or a card's worktree: the mirror's skills that directory
/// doesn't carry as the branch has them, computed now, at launch, so a
/// branch switch or a worktree behind the checkout never leaves a session
/// without a shared skill.
///
/// The directory handed to Claude is named by its contents and never
/// changed or removed while a session could be using it: a later launch
/// with other contents gets another directory, and one no launch has used
/// for [`SESSION_PLUGIN_KEEP`] is pruned. `None` when there is nothing to add.
pub fn session_plugin_dir(workspace_dir: &Path, session_cwd: &Path) -> Option<PathBuf> {
    session_plugin_dir_for(workspace_dir, Some(session_cwd))
}

/// GH #216 review 1: the `project` plugin for a **read-only** Claude run — the
/// Reviewer, the Challenger, the proposal pass. It carries **every** skill the
/// integration branch has (the mirror's `.claude/skills`), not only those the
/// session's directory lacks.
///
/// Two reasons. `--restricted` makes Claude ignore the directory's own
/// `.claude/skills` (probed, Claude Code 2.1.285), so without this a review
/// would never meet a repository skill at all. And the directory under review
/// is a card's worktree: a Builder could add or change a skill there telling
/// the reviewer to approve. The reviewer follows the rules **already on the
/// branch**, never the ones under review — so nothing is read from the
/// session's directory, by design.
pub fn review_plugin_dir(workspace_dir: &Path) -> Option<PathBuf> {
    session_plugin_dir_for(workspace_dir, None)
}

/// [`session_plugin_dir`] when `session_cwd` is set (the skills it lacks), and
/// [`review_plugin_dir`] when it is not (all of the branch's).
fn session_plugin_dir_for(workspace_dir: &Path, session_cwd: Option<&Path>) -> Option<PathBuf> {
    let mirror = workspace_dir.join(ply_memory::SHARED_LIBRARY_MIRROR_DIR);
    let build = ply_memory::resolve_mirror(&mirror)?;
    let root = workspace_dir.join(SESSION_PLUGINS_DIR);
    let made = (|| -> Result<Option<PathBuf>, String> {
        let skills = build.join(SKILLS_PATH);
        let names = match session_cwd {
            Some(cwd) => claude_skills_for(&build, cwd),
            None => claude_skills_on_branch(&build),
        };
        if names.is_empty() {
            return Ok(None);
        }
        let manifest = serde_json::json!({
            "name": PLUGIN_NAME,
            "description": "This workspace's project skills from the integration branch, delivered by Plyloft",
            "version": "1.0.0",
        });
        let mut files: Vec<(String, Vec<u8>, bool)> = vec![(
            ".claude-plugin/plugin.json".to_string(),
            serde_json::to_string_pretty(&manifest).unwrap_or_default().into_bytes(),
            false,
        )];
        for name in &names {
            for file in crate::project_skills::read_tree(&skills.join(name))? {
                files.push((format!("skills/{name}/{}", file.path), file.bytes, file.executable));
            }
        }
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        for (path, bytes, executable) in &files {
            hasher.update(path.as_bytes());
            hasher.update([0, u8::from(*executable)]);
            hasher.update((bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
        }
        let digest = format!("{:x}", hasher.finalize());
        let digest = &digest[..24];
        let dest = root.join(digest);
        std::fs::create_dir_all(&root).map_err(|e| format!("create {root:?}: {e}"))?;
        // Stamped **before** the build is looked for, and atomically (Hard
        // rule 3), as the Codex twin does (`branch_codex_skills`): a build
        // found whole a moment ago with a thirty-day-old stamp is exactly what
        // another launch's prune removes, and a torn stamp is a build the
        // prune cannot date.
        let stamp = root.join(format!("{digest}.last-used"));
        crate::atomic::write_atomic_text(&stamp, &crate::shared_config::now_millis().to_string())
            .map_err(|e| format!("stamp {stamp:?}: {e}"))?;
        if plugin_at(&dest).is_none() {
            let scratch = root.join(format!(".build-{}", uuid::Uuid::new_v4().simple()));
            let written = files
                .iter()
                .try_for_each(|(path, bytes, executable)| write_file(&scratch, path, bytes, *executable));
            // Another launch may have made the same build meanwhile: theirs
            // is identical, so either one in place will do.
            if written.is_err() || std::fs::rename(&scratch, &dest).is_err() {
                let _ = std::fs::remove_dir_all(&scratch);
                if let Err(error) = written {
                    // A stamp with no build beside it is nothing the prune visits.
                    if !dest.exists() {
                        let _ = std::fs::remove_file(&stamp);
                    }
                    return Err(error);
                }
            }
        }
        let plugin = plugin_at(&dest);
        if plugin.is_none() && !dest.exists() {
            let _ = std::fs::remove_file(&stamp);
        }
        Ok(plugin)
    })();
    prune_session_plugins(&root, SESSION_PLUGIN_KEEP);
    made.unwrap_or_else(|e| {
        log::warn!("shared_library: no project skills plugin for {session_cwd:?}: {e}");
        None
    })
}

fn plugin_at(dir: &Path) -> Option<PathBuf> {
    dir.join(".claude-plugin")
        .join("plugin.json")
        .is_file()
        .then(|| dir.to_path_buf())
}

/// Remove the session plugins (and leftover half-builds) no launch has
/// stamped within `keep`.
pub(crate) fn prune_session_plugins(root: &Path, keep: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let age = |path: &Path| {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".last-used") || !path.is_dir() {
            continue;
        }
        let stamp = root.join(format!("{name}.last-used"));
        let unused = match age(&stamp) {
            Some(age) => age >= keep,
            // A build without a stamp: a half-build, or one whose launch
            // died before stamping — gone once it is that old itself.
            None => age(&path).is_none_or(|age| age >= keep.min(std::time::Duration::from_secs(3600))),
        };
        // Skills hub H1 (§8, file locks): renamed aside before it is removed,
        // so a build Windows will not let go of (a file a session holds open)
        // is left whole and retried at the next launch — never half removed
        // under the name a later launch would reuse as complete.
        if unused && crate::library_snapshot::remove_aside(&path) {
            let _ = std::fs::remove_file(&stamp);
        }
    }
}

// ── Publishing one change ─────────────────────────────────────────────

/// Someone else's version of the item this publish replaced.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItemOverride {
    pub author: Option<String>,
    /// Seconds.
    pub changed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChangeOutcome {
    /// On the branch: pushed as `commit`, or already there (`None`).
    Published {
        commit: Option<String>,
        /// The item's object id on the branch now (`None`: removed).
        sha: Option<String>,
        over: Option<ItemOverride>,
        /// GH #105 review 1: the skills this commit copied, and the ones it left
        /// alone with the reason why. Both decided on the tip.
        carried: Vec<String>,
        skipped: Vec<String>,
        /// GH #206 review 1: the new name a **new** note was published under,
        /// because a different note had reached its slug on the branch first.
        /// The queue entry takes it, so every later step names the file that
        /// is really there.
        renamed: Option<String>,
    },
    /// The change waits in a pull request, with the reason it does in the words
    /// the pull request itself was given (GH #160): the push `branch` refused,
    /// or — for the instructions — the file that moved there, which Ply does not
    /// commit over. The toast that announces the outcome says it rather than
    /// inventing one, the way the row's `blocked` sentence already does.
    PullRequest {
        pull_request: PullRequest,
        reason: String,
        /// Whether the branch was **never asked**: the commit writes an
        /// instruction file whose blob moved there, and Ply does not commit over
        /// one. It decides whether `reason` is a sentence about the branch's own
        /// state (it is, here) or git's stderr from a push it refused (review 1,
        /// MAJOR) — and only the first may be shown to a member.
        never_override: bool,
        /// GH #206 review 1: as for `Published` — the pull request carries the
        /// note under this new name.
        renamed: Option<String>,
        /// The commit the pull request carries.
        commit: Option<String>,
    },
    /// Nothing reached the branch, and no pull request can exist from this
    /// attempt (it failed before its pull request branch was pushed).
    Unreachable(String),
    Failed(String),
    /// The pull request branch was pushed and creating the pull request
    /// failed or gave no answer: one may exist. The next drain asks GitHub.
    PullRequestUncertain(String),
}

struct Prepared {
    commit: Option<String>,
    over: Option<ItemOverride>,
    message: String,
    /// GH #105 review 1: the skills this commit actually copied, and the ones it
    /// would not touch, each with its reason. Decided on the tip, so what the
    /// member is told is what the branch did.
    carried: Vec<String>,
    skipped: Vec<String>,
    /// GH #101: this commit must **not** be pushed onto the branch — a file it
    /// writes moved there since the edit began, and an instruction file is
    /// never overridden. The sentence says which file, for the pull request.
    never_override: Option<String>,
}

impl Prepared {
    fn nothing() -> Self {
        Self {
            commit: None,
            over: None,
            message: String::new(),
            carried: Vec::new(),
            skipped: Vec::new(),
            never_override: None,
        }
    }
}

/// The blobs of one repository path at `rev`, by path, with their mode.
fn blobs_at(git: &Plumbing, rev: &str, path: &str) -> Vec<crate::shared_config::TreeEntry> {
    git.ls_tree(rev, path, true)
        .into_iter()
        .filter(|entry| entry.kind == "blob")
        .collect()
}

/// Build the tree changes of one [`SkillCopy`] **on `tip`**, or the reason it is
/// skipped (GH #105 review 1).
///
/// The source is read here, from the branch as it is: a teammate's new file or
/// edit on it is carried over rather than deleted or reverted. The destination is
/// judged here too — one that holds anything else is left alone unless the member
/// chose to replace it, which is what `Align` is and nothing else is.
fn copy_changes(
    git: &Plumbing,
    tip: &str,
    copy: &SkillCopy,
    branch: &str,
) -> Result<Vec<TreeChange>, String> {
    let source = blobs_at(git, tip, &copy.from);
    if source.is_empty() {
        return Err(format!(
            "`{}` is not on {branch} at {} any more, so there was nothing to copy.",
            copy.name, copy.from
        ));
    }
    if let Some(link) = source.iter().find(|entry| entry.mode == "120000") {
        return Err(format!(
            "{} is a symlink, and Plyloft does not copy one — `{}` was left as it is.",
            link.path, copy.name
        ));
    }
    let mut wanted: BTreeMap<String, (Vec<u8>, bool)> = BTreeMap::new();
    for entry in &source {
        let relative = entry
            .path
            .strip_prefix(&format!("{}/", copy.from))
            .ok_or_else(|| format!("{} is outside {}", entry.path, copy.from))?;
        let bytes = git
            .read_at(tip, &entry.path)
            .ok_or_else(|| format!("read {} at {tip}", entry.path))?;
        wanted.insert(
            format!("{}/{relative}", copy.to),
            (bytes, entry.mode == "100755"),
        );
    }
    let existing = blobs_at(git, tip, &copy.to);
    let same = existing.len() == wanted.len()
        && existing.iter().all(|entry| {
            wanted.get(&entry.path).is_some_and(|(bytes, executable)| {
                (entry.mode == "100755") == *executable
                    && git.read_at(tip, &entry.path).as_deref() == Some(bytes.as_slice())
            })
        });
    if same {
        // Already the same file on both sides: nothing to do, and not a fault.
        return Ok(Vec::new());
    }
    if !existing.is_empty() && !copy.replace {
        return Err(format!(
            "{} is already on {branch} and it is not the same file as {}. Nothing was \
             written over it — compare the two and align them to choose which one wins.",
            copy.to, copy.from
        ));
    }
    let mut changes = Vec::new();
    for entry in &existing {
        if !wanted.contains_key(&entry.path) {
            changes.push(TreeChange {
                path: entry.path.clone(),
                content: None,
            });
        }
    }
    for (path, (bytes, executable)) in wanted {
        let unchanged = existing.iter().any(|entry| {
            entry.path == path
                && (entry.mode == "100755") == executable
                && git.read_at(tip, &entry.path).as_deref() == Some(bytes.as_slice())
        });
        if !unchanged {
            changes.push(TreeChange {
                path,
                content: Some((bytes, executable)),
            });
        }
    }
    Ok(changes)
}

/// The copy half of [`prepare`]: every instruction judged on the tip, the ones
/// that can be made in one commit, and the ones that cannot with their reasons.
fn prepare_copies(
    git: &Plumbing,
    tip: &str,
    change: &LibraryChange,
    branch: &str,
    now_secs: i64,
) -> Result<Prepared, String> {
    let mut changes = Vec::new();
    let mut carried = Vec::new();
    let mut skipped = Vec::new();
    for copy in &change.copies {
        inside_repository(&copy.from)?;
        inside_repository(&copy.to)?;
        if copy.from == copy.to {
            return Err(format!("{} would be copied onto itself", copy.from));
        }
        match copy_changes(git, tip, copy, branch) {
            Ok(mine) if mine.is_empty() => {}
            Ok(mine) => {
                changes.extend(mine);
                carried.push(copy.name.clone());
            }
            Err(reason) => skipped.push(reason),
        }
    }
    if changes.is_empty() {
        return Ok(Prepared {
            skipped,
            ..Prepared::nothing()
        });
    }
    // The subject counts what this commit really carries, not what was planned:
    // a skill dropped on the tip must not be counted in the branch's history.
    let mut message = match (&change.message, carried.len()) {
        (Some(subject), 1) if change.copies.len() == 1 => subject.replace('\n', " "),
        _ => crate::skill_reach::commit_subject(&carried),
    };
    message.push('\n');
    let commit = git.commit_tree_changes(tip, &changes, &message)?;
    // A plain copy never overrides: its source is read on this tip, and a
    // destination that holds something else is skipped above. `Align` is the one
    // copy that writes over a copy — the member chose it over the version they
    // compared — so it takes the skill rule (group B §2): if the copy it writes
    // over moved since the choice, the commit waits in a pull request.
    let never_override = if change.group.is_none() && change.copies.iter().any(|copy| copy.replace) {
        let moved = moved_skill_roots(git, tip, change);
        (!moved.is_empty()).then(|| moved_skill_sentence(git, tip, branch, &moved, now_secs))
    } else {
        None
    };
    Ok(Prepared {
        commit: Some(commit),
        over: None,
        message,
        carried,
        skipped,
        never_override,
    })
}

/// The most recent change to any of `paths`, as `git log` reports it.
///
/// GH #105: a skill lives in two directories, and the copy somebody edited is
/// the one that says who edited it. Taking the Claude root alone named the wrong
/// author for an edit made to the Codex copy.
fn newest_change(git: &Plumbing, rev: &str, paths: &[String]) -> Option<(String, i64)> {
    paths
        .iter()
        .filter_map(|path| git.last_change(rev, path))
        .max_by_key(|(_, at)| *at)
}

/// GH #101: the instruction files this change writes whose blob on `tip` is no
/// longer the one the edit started from, in the board's order.
fn moved_instruction_files(change: &LibraryChange, existing: &[TreeEntry]) -> Vec<String> {
    crate::shared_config::INSTRUCTION_FILES
        .iter()
        .filter(|name| change.files.iter().flatten().any(|file| file.path == **name))
        .filter(|name| {
            let now = existing
                .iter()
                .find(|entry| entry.path == **name)
                .map(|entry| entry.sha.clone());
            // A path with no recorded base counts as "was absent": a file the
            // branch already carries then reads as moved, which is the safe way
            // round.
            let base = change.bases.get(**name).cloned().flatten();
            now != base
        })
        .map(|name| name.to_string())
        .collect()
}

fn prepare(
    git: &Plumbing,
    branch: &str,
    tip: &str,
    change: &LibraryChange,
    now_secs: i64,
) -> Result<Prepared, String> {
    // GH #105 review 1: a copy carries an instruction, not bytes, and everything
    // about it is decided on this tip.
    if !change.copies.is_empty() {
        return prepare_copies(git, tip, change, branch, now_secs);
    }
    let instructions = change.kind == ItemKind::Instructions;
    let paths = change.claimed();
    let current_sha = item_sha(git, tip, change.kind, &change.name);
    // Only the paths the change claims are read, so only they can be written or
    // deleted (GH #105): a publish that carries one root of a skill leaves the
    // other root's copy on the branch exactly as it is. An instructions change
    // (GH #101) may write both root files, so what is "already there" is both of
    // them, not just the one the item is named after.
    let existing: Vec<TreeEntry> = if instructions {
        crate::shared_config::INSTRUCTION_FILES
            .iter()
            .flat_map(|name| git.ls_tree(tip, name, false))
            .collect()
    } else {
        paths
            .iter()
            .flat_map(|path| git.ls_tree(tip, path, true))
            .collect()
    };
    let mut changes = Vec::new();
    let wanted: BTreeMap<&str, &LibraryFile> = change
        .files
        .iter()
        .flatten()
        .map(|f| (f.path.as_str(), f))
        .collect();
    for file in wanted.values() {
        let inside = match change.kind {
            // GH #101: either root instruction file, and the `Set up` flow writes
            // both. `check_path` refuses anything else at the gate too.
            ItemKind::Instructions => {
                crate::shared_config::INSTRUCTION_FILES.contains(&file.path.as_str())
            }
            ItemKind::Knowledge => paths.iter().any(|path| file.path == *path),
            ItemKind::Skill => paths
                .iter()
                .any(|path| file.path.starts_with(&format!("{path}/"))),
        };
        if !inside {
            return Err(format!("{} is outside {}", file.path, paths.join(", ")));
        }
    }
    // A note's file and a skill's directory belong to the item, so what the
    // branch has and the change does not is a removal. The two instruction
    // files belong to the **repository**: a change that writes one must never
    // delete the other (BOARDS.md §5: "Nothing is deleted").
    if !instructions {
        for entry in &existing {
            if entry.kind == "blob" && !wanted.contains_key(entry.path.as_str()) {
                changes.push(TreeChange {
                    path: entry.path.clone(),
                    content: None,
                });
            }
        }
    }
    for file in wanted.values() {
        let bytes = file.decoded()?;
        let same = existing.iter().any(|entry| {
            entry.path == file.path
                && (entry.mode == "100755") == file.executable
                && git.read_at(tip, &entry.path).as_deref() == Some(bytes.as_slice())
        });
        if !same {
            changes.push(TreeChange {
                path: file.path.clone(),
                content: Some((bytes, file.executable)),
            });
        }
    }
    if changes.is_empty() {
        return Ok(Prepared::nothing());
    }
    // GH #101 — the whole point of the card: an instruction file whose blob
    // moved on the branch is **never** committed over. The commit is still
    // built, because a pull request needs it; what changes is where it goes.
    let never_override = if instructions {
        let moved = moved_instruction_files(change, &existing);
        (!moved.is_empty()).then(|| {
            let who = git
                .last_change(tip, &moved[0])
                .map(|(author, at)| format!("{author} changed it {}", ago(now_secs, at)))
                .unwrap_or_else(|| "it changed there".to_string());
            // The branch by name, not "the integration branch": this sentence is
            // the whole of what the row says, and the member knows the branch.
            format!(
                "{} changed on {branch} since this edit began ({who}).",
                moved.join(" and "),
            )
        })
    } else if change.kind == ItemKind::Skill && change.group.is_none() {
        // Skills group B §2: the same rule for a skill, over the whole tree of
        // every root it writes — an edited, added or removed file in either
        // CLI's copy since this change began sends it into a pull request. A removal too:
        // deleting a version nobody here has seen is overriding it.
        let moved = moved_skill_roots(git, tip, change);
        (!moved.is_empty()).then(|| moved_skill_sentence(git, tip, branch, &moved, now_secs))
    } else {
        None
    };
    // Last writer wins is the rule for a note, and only for a note: an
    // instruction file and a skill took the branch above instead. And a grouped
    // change (GH #105) is not one item, so there is no one version it could be
    // overriding and no author to name: `base` is not kept for it, and a guess
    // here would put somebody's name in a commit message for nothing.
    let over = (change.kind == ItemKind::Knowledge
        && change.group.is_none()
        && current_sha != change.base)
        .then(|| {
        // Across every path the item occupies (GH #105): a skill lives in two
        // directories, and the copy somebody edited is the one that says who
        // edited it.
        let found = newest_change(git, tip, &paths);
        ItemOverride {
            author: found.as_ref().map(|(a, _)| a.clone()),
            changed_at: found.map(|(_, t)| t),
        }
    });
    // The action's own subject when it has one (GH #105: `skills: 34 for Claude
    // and Codex`), else the channel's derived `<kind>: <title>`. Either way the
    // override note is appended, so a commit that replaced somebody's version
    // still says whose.
    let mut message = match &change.message {
        Some(subject) => subject.replace('\n', " "),
        None => {
            let mut derived =
                format!("{}: {}", change.kind.prefix(), change.title.replace('\n', " "));
            if change.files.is_none() {
                derived.push_str(" (removed)");
            }
            derived
        }
    };
    if let Some(over) = &over {
        let who = over
            .author
            .as_deref()
            .map(|a| format!("{a}'s"))
            .unwrap_or_else(|| "another".to_string());
        match over.changed_at {
            Some(at) => message.push_str(&format!(" (overrides {who} version from {})", ago(now_secs, at))),
            None => message.push_str(&format!(" (overrides {who} version)")),
        }
    }
    message.push('\n');
    let commit = git.commit_tree_changes(tip, &changes, &message)?;
    Ok(Prepared {
        commit: Some(commit),
        over,
        message,
        carried: Vec::new(),
        skipped: Vec::new(),
        never_override,
    })
}

/// Publish one queued change onto `branch`: the card-2 channel's steps for a
/// library item.
pub fn publish_change(
    git: &Plumbing,
    gh: Option<&Gh>,
    branch: &str,
    change: &LibraryChange,
    pull_request_branch: &str,
    now_secs: i64,
) -> ChangeOutcome {
    if let Err(e) = check_item_name(change.kind, &change.name) {
        return ChangeOutcome::Failed(e);
    }
    let lock = integration_lock(&git.cwd, branch);
    let _serial = lock.lock().unwrap_or_else(|p| p.into_inner());
    for attempt in 1..=2 {
        match git.fetch(branch) {
            Ok(()) => {}
            Err(failed @ (FetchFailure::BranchMissing { .. } | FetchFailure::SignIn(_))) => {
                return ChangeOutcome::Failed(failed.to_string())
            }
            Err(FetchFailure::Unreachable(e)) => return ChangeOutcome::Unreachable(e),
        }
        let Some(tip) = git.tip(branch) else {
            return ChangeOutcome::Failed(format!("origin has no branch {branch} to publish to"));
        };
        // GH #206 review 1: a new note never replaces a different note that
        // reached its slug on the branch first — it moves aside to a free name.
        let moved_aside = match new_note_moved_aside(git, &tip, change) {
            Ok(moved) => moved,
            Err(e) => return ChangeOutcome::Failed(e),
        };
        let renamed = moved_aside.as_ref().map(|moved| moved.name.clone());
        let change = moved_aside.as_ref().unwrap_or(change);
        let prepared = match prepare(git, branch, &tip, change, now_secs) {
            Ok(prepared) => prepared,
            Err(e) => return ChangeOutcome::Failed(e),
        };
        let Some(sha) = prepared.commit.clone() else {
            return ChangeOutcome::Published {
                commit: None,
                sha: item_sha(git, &tip, change.kind, &change.name),
                over: None,
                carried: prepared.carried,
                skipped: prepared.skipped,
                renamed,
            };
        };
        // GH #101: the one path that must never reach `git.push(…, branch)`.
        // Checked here, above the push, on the tip this attempt fetched — so a
        // retry after a non-fast-forward asks again against the newer tip.
        if let Some(moved) = prepared.never_override.clone() {
            log::info!("shared_library: {} waits in a pull request: {moved}", change.key());
            return with_rename(
                open_pull_request(
                    git,
                    gh,
                    branch,
                    change,
                    &sha,
                    &prepared.message,
                    pull_request_branch,
                    &moved,
                    true,
                ),
                renamed,
            );
        }
        match git.push(&sha, branch) {
            PushResult::Pushed => {
                log::info!("shared_library: published {} to {branch} as {sha}", change.key());
                return ChangeOutcome::Published {
                    sha: item_sha(git, &sha, change.kind, &change.name),
                    commit: Some(sha),
                    over: prepared.over,
                    carried: prepared.carried,
                    skipped: prepared.skipped,
                    renamed,
                };
            }
            PushResult::NonFastForward(e) if attempt == 1 => {
                log::info!("shared_library: {branch} moved on, retrying once: {e}");
            }
            PushResult::NonFastForward(e) | PushResult::Refused(e) => {
                return with_rename(
                    open_pull_request(
                        git,
                        gh,
                        branch,
                        change,
                        &sha,
                        &prepared.message,
                        pull_request_branch,
                        &e,
                        false,
                    ),
                    renamed,
                );
            }
            PushResult::Unreachable(e) => return ChangeOutcome::Unreachable(e),
        }
    }
    unreachable!("the second attempt always returns")
}

/// SP-5 review: the never-override sentence `change` would meet on `tip` —
/// which file moved there, and who moved it — or `None` when it would be
/// committed. [`prepare`]'s own answer, asked again so a caller can say it in
/// its own words after [`publish_change`] could only fail.
pub fn never_override_on(
    git: &Plumbing,
    branch: &str,
    tip: &str,
    change: &LibraryChange,
    now_secs: i64,
) -> Option<String> {
    prepare(git, branch, tip, change, now_secs).ok()?.never_override
}

/// SP-5: one change committed onto the **local** `branch` of a repository with
/// no origin — the solo user's `Approve and commit to <branch>` (ADR 0003,
/// 2026-10-01 amendment). [`publish_change`]'s commit, built the same way
/// ([`prepare`], plumbing and a scratch index, on `refs/heads/<branch>`), and
/// moved onto the branch by [`crate::worktrees::advance_local_branch`] instead
/// of a push.
///
/// Refused rather than written over: a change that would override a file
/// that moved on the branch since it began (`prepare`'s never-override rule —
/// there is no pull request to fall back to here), a branch that moves while
/// the commit is built, claimed paths with uncommitted changes in the
/// checkout, an unfinished git operation there, and a branch checked out in
/// another worktree. `Ok(None)`: the branch already carries exactly this.
///
/// Locks: [`integration_lock`] then the repository's fast-forward lock, never
/// `CARD_START_LOCK`. The caller holds the workspace lock around it.
/// `before_ref` runs right before the ref write (the race tests' seam; a
/// no-op otherwise).
pub fn commit_change_locally(
    git: &Plumbing,
    branch: &str,
    change: &LibraryChange,
    now_secs: i64,
    before_ref: &mut dyn FnMut(),
) -> Result<Option<String>, String> {
    check_item_name(change.kind, &change.name)?;
    let lock = integration_lock(&git.cwd, branch);
    let _serial = lock.lock().unwrap_or_else(|p| p.into_inner());
    let held = crate::worktrees::hold_fast_forward(&git.cwd);
    let tip = git
        .rev_parse_commit(&format!("refs/heads/{branch}"))
        .ok_or_else(|| format!("This repository has no branch {branch} to commit to."))?;
    let prepared = prepare(git, branch, &tip, change, now_secs)?;
    if let Some(moved) = prepared.never_override {
        return Err(format!("{moved} Nothing was committed."));
    }
    let Some(commit) = prepared.commit else {
        return Ok(None);
    };
    crate::worktrees::advance_local_branch(
        &held,
        &git.cwd,
        branch,
        &tip,
        &commit,
        &change.claimed(),
        before_ref,
    )?;
    log::info!("shared_library: committed {} to local {branch} as {commit}", change.key());
    Ok(Some(commit))
}

/// How many free names a new note tries on the branch before giving up.
const NEW_NOTE_NAME_ATTEMPTS: usize = 8;

/// A note's frontmatter `id`, read the way [`note_title`] reads its title.
fn note_id(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let front = text.trim_start_matches('\u{feff}').strip_prefix("---")?;
    let end = front.find("\n---")?;
    front[..end].lines().find_map(|line| {
        let value = line.trim_end_matches('\r').strip_prefix("id:")?.trim();
        let value = value.trim_matches(|c| c == '"' || c == '\'');
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// A change that would add a **new** note: no base on the branch, one file at
/// the note's own path, nothing grouped or copied.
fn is_new_note(change: &LibraryChange) -> bool {
    change.kind == ItemKind::Knowledge
        && change.base.is_none()
        && change.group.is_none()
        && change.copies.is_empty()
        && change.paths.is_empty()
        && change.files.is_some()
}

/// GH #206 review 1: a **new** note (`base: None`) whose slug a different note
/// took on the branch since it was queued, moved to a free name on `tip`.
///
/// Last writer wins is the rule for an edit of one note; it is never the rule
/// for two different notes that happened to share a title. `None`: nothing to
/// move — not a new note, nothing at the path, the very bytes already there,
/// or the same note (same frontmatter `id`).
///
/// Review 2: the name is **derived from the note's id**
/// (`<slug>-<first 8 hex of sha256(id)>`), not random, so every attempt at one
/// note picks the same name — a retry after a push whose answer was lost finds
/// its own note there (same id) and publishes nothing twice.
fn new_note_moved_aside(
    git: &Plumbing,
    tip: &str,
    change: &LibraryChange,
) -> Result<Option<LibraryChange>, String> {
    if !is_new_note(change) {
        return Ok(None);
    }
    let Some(files) = change.files.as_ref() else {
        return Ok(None);
    };
    let path = change.kind.repo_path(&change.name);
    let Some(ours) = files.iter().find(|file| file.path == path) else {
        return Ok(None);
    };
    let ours = ours.decoded()?;
    if item_sha(git, tip, change.kind, &change.name).is_none() {
        return Ok(None);
    }
    let theirs = git.read_at(tip, &path);
    let our_id = note_id(&ours);
    if theirs.as_deref() == Some(ours.as_slice())
        || (our_id.is_some() && theirs.as_deref().and_then(note_id) == our_id)
    {
        return Ok(None);
    }
    // The same note, wherever it may already be: its id, or its bytes.
    let seed = our_id.clone().unwrap_or_else(|| String::from_utf8_lossy(&ours).into_owned());
    let digest = {
        use sha2::{Digest, Sha256};
        Sha256::digest(seed.as_bytes())
    };
    let derived: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    let mut candidates = vec![format!("{}-{derived}", change.name)];
    for _ in 1..NEW_NOTE_NAME_ATTEMPTS {
        let id = uuid::Uuid::new_v4().simple().to_string();
        candidates.push(format!("{}-{}", change.name, &id[..8]));
    }
    for name in candidates {
        let usable = match item_sha(git, tip, change.kind, &name) {
            None => true,
            // Already ours: this note (by id or bytes) landed there before.
            Some(_) => {
                let there = git.read_at(tip, &change.kind.repo_path(&name));
                there.as_deref() == Some(ours.as_slice())
                    || (our_id.is_some() && there.as_deref().and_then(note_id) == our_id)
            }
        };
        if usable {
            log::info!(
                "shared_library: {} is another note on the branch; publishing the new note as {name}",
                change.key()
            );
            return Ok(Some(change.renamed_note(&name)));
        }
    }
    Err(format!(
        "“{}” could not be given a free name on the branch; nothing was published.",
        change.title
    ))
}

/// Attach a new note's new name to the pull request that carries it.
fn with_rename(outcome: ChangeOutcome, renamed: Option<String>) -> ChangeOutcome {
    match outcome {
        ChangeOutcome::PullRequest {
            pull_request,
            reason,
            never_override,
            commit,
            ..
        } => ChangeOutcome::PullRequest {
            pull_request,
            reason,
            never_override,
            renamed,
            commit,
        },
        other => other,
    }
}

/// The never-override marker for `kind`: an instruction file's, or a skill's
/// (group B §2). Both are sorted into `blocked`, never into `refused`.
fn never_override_marker(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Skill => SKILL_NEVER_OVERRIDE_MARKER,
        _ => NEVER_OVERRIDE_MARKER,
    }
}

/// What a pull request about `change` is called, and what it says it does.
///
/// GH #105 review 1: both are the change's own. A grouped copy is not one skill,
/// and a skill is not one directory — a pull request headed `Skill: deploy` and
/// saying "Only `.claude/skills/deploy` changes" over 34 directories under
/// `.agents/skills/` was asking to be merged on a false description of itself.
fn pull_request_text(
    change: &LibraryChange,
    message: &str,
    branch: &str,
    reason: &str,
    // GH #101: the branch was never asked — the commit writes an instruction file
    // whose blob moved there, and Ply does not commit over one.
    never_override: bool,
) -> (String, String) {
    // Every path this change writes: for instructions, the root files the step
    // carries (GH #101); otherwise the paths the change claims, which for a skill
    // is a root per copy and for a grouped copy is one per skill (GH #105).
    let touched: Vec<String> = match change.kind {
        ItemKind::Instructions => crate::shared_config::INSTRUCTION_FILES
            .iter()
            .filter(|name| change.files.iter().flatten().any(|f| f.path == **name))
            .map(|name| name.to_string())
            .collect(),
        _ => change.claimed(),
    };
    let title = match (change.kind, change.covers.is_empty()) {
        (ItemKind::Knowledge, _) => format!("Knowledge: {}", change.title),
        (ItemKind::Skill, true) => format!("Skill: {}", change.title),
        // A grouped copy is not one skill, and its title is already a count.
        (ItemKind::Skill, false) => format!("Skills: {}", change.title),
        // The card's `Instructions: <file>`; both names when the step writes
        // both, because a title that named one would hide the other.
        (ItemKind::Instructions, _) => format!("Instructions: {}", touched.join(" and ")),
    };
    let changes_phrase = changed_paths_phrase(&touched);
    let body = if never_override {
        // GH #101 review 1 (MINOR): this commit was built from the bytes the flow
        // was read with, **not** from the branch's newer ones, so merging it as
        // it stands reverts whatever changed there. The reviewer is the one who
        // can reconcile the two, so the body says which file moved, that these
        // bytes are the older reading, and what that means for the merge.
        let only = touched
            .iter()
            .map(|path| format!("`{path}`"))
            .collect::<Vec<_>>()
            .join(" and ");
        let marker = never_override_marker(change.kind);
        // What merging it as it stands would do, in the terms of what it carries
        // (skills group B §2): bytes read before the change upstream, a removal of
        // a version nobody here saw, or `Align`'s copy written over a moved copy.
        let consequence = if change.kind == ItemKind::Instructions {
            format!(
                "**Read from the older bytes.** This branch was built on the version of \
                 {only} that Plyloft showed when the step was taken, and not on what \
                 `{branch}` carries now. Merging it as it stands would put that newer \
                 change back the way it was — reconcile the two before merging, or close \
                 this and take the step again from an up-to-date {branch}."
            )
        } else if !change.copies.is_empty() {
            format!(
                "**Written over a changed copy.** The copy that wins was chosen before \
                 that change on `{branch}`. Merging this writes it over {only} as they \
                 are now, the newer change included — compare the two copies again \
                 before merging, or close this and align them again."
            )
        } else if change.files.is_none() {
            format!(
                "**Removes a changed skill.** The removal was asked for before that \
                 change on `{branch}`. Merging this deletes {only} with the newer \
                 change in it — look at it before merging, or close this to keep it."
            )
        } else {
            format!(
                "**Read from the older bytes.** This branch was built on a copy of \
                 {only} made before that change on `{branch}`, and not on what \
                 `{branch}` carries now. Merging it as it stands would put that newer \
                 change back the way it was — reconcile the two before merging, or close \
                 this and publish again from a copy that has the change."
            )
        };
        // Every line at column 0: four or more leading spaces after a blank line
        // is a **code block** in GitHub's Markdown, and this paragraph was being
        // rendered as one (review 2). Built by concatenation rather than one long
        // literal, so the indentation of the source cannot leak into the body.
        [
            format!("{message}"),
            format!(
                "{reason} {marker} somebody else changed, so the change \
                 waits here for review instead. {changes_phrase}"
            ),
            String::new(),
            consequence,
        ]
        .join("\n")
    } else {
        format!(
            "{message}\nPly couldn't push this to `{branch}` directly ({reason}), so it waits here. {changes_phrase}"
        )
    };
    (title, body)
}

/// What a pull request says about the paths it touches.
///
/// Listed while a reader can take them in, counted by their roots when there are
/// too many for that — never reduced to one path that is only part of the truth.
fn changed_paths_phrase(paths: &[String]) -> String {
    match paths {
        [] => "Nothing changes.".to_string(),
        [one] => format!("Only `{one}` changes."),
        many if many.len() <= 6 => format!(
            "Only these change: {}.",
            many.iter().map(|p| format!("`{p}`")).collect::<Vec<_>>().join(", ")
        ),
        many => {
            let mut roots: Vec<&str> = many
                .iter()
                .map(|path| match path.rsplit_once('/') {
                    Some((root, _)) => root,
                    None => path.as_str(),
                })
                .collect();
            roots.sort_unstable();
            roots.dedup();
            format!(
                "Only {} directories change, all of them under {}.",
                many.len(),
                roots.iter().map(|r| format!("`{r}/`")).collect::<Vec<_>>().join(" and ")
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn open_pull_request(
    git: &Plumbing,
    gh: Option<&Gh>,
    branch: &str,
    change: &LibraryChange,
    sha: &str,
    message: &str,
    pull_request_branch: &str,
    refused: &str,
    // GH #101: `never_override` means the branch was never asked. The commit
    // writes an instruction file whose blob moved there, and Ply does not commit
    // over one — so the words must not claim a push was refused.
    never_override: bool,
) -> ChangeOutcome {
    let reason = refused.lines().last().unwrap_or(refused).trim();
    // GH #101 review 1 (MAJOR): the two dead ends below used to say `{branch}
    // refused the push` for the never-override case as well — about a push that
    // never happened — and their `REFUSED_MARKER` set `LibraryReport.refused`,
    // which raises the read-only `PublishRefusedBlock`. The never-override case
    // gets its own words and its own marker.
    let marker = never_override_marker(change.kind);
    // What is true afterwards (review 1, NIT 5): a skill's change is already laid
    // over this Mac's Library, so "nothing was changed here" would be wrong.
    let untouched = if change.kind == ItemKind::Skill {
        format!("{branch} was left as it is, and the change waits on {THIS_MACHINE}")
    } else {
        format!("nothing was changed, on {branch} or here")
    };
    let dead_end = |instead: &str| {
        if never_override {
            format!("{reason} {marker}, and {instead} — {untouched}.")
        } else {
            format!("{branch} {REFUSED_MARKER} ({reason}) and {instead}")
        }
    };
    let Some(gh) = gh else {
        return ChangeOutcome::Failed(dead_end(
            "the GitHub CLI isn't available to open a pull request instead",
        ));
    };
    let Some(repo) = git.github_repo() else {
        return ChangeOutcome::Failed(dead_end(
            "origin isn't a GitHub repository Plyloft can open a pull request on",
        ));
    };
    let (title, body) = pull_request_text(change, message, branch, reason, never_override);
    // 1.175.0 (A5): never forced — the one walk of the fallback names the
    // shared-config channel uses ([`push_fallback`]).
    let FallbackPush { branch: chosen, reuse, replaced, head } =
        match push_fallback(git, gh, &repo, branch, pull_request_branch, sha) {
            Ok(pushed) => pushed,
            Err(FallbackError::Unreachable(e)) => return ChangeOutcome::Unreachable(e),
            Err(FallbackError::Refused(e)) => {
                // Same rule as the two dead ends above: for never-override the
                // branch was never asked, so only the pull request branch refused.
                return ChangeOutcome::Failed(if never_override {
                    format!(
                        "{reason} {marker}, and the pull request branch was refused too: {e} — {untouched}."
                    )
                } else {
                    format!("{branch} {REFUSED_MARKER} and the pull request branch too: {e}")
                })
            }
            Err(FallbackError::Exhausted) => {
                return ChangeOutcome::Failed(crate::shared_config::names_used_up(pull_request_branch))
            }
        };
    // Round 3 (S4), round 5 (V2): it says which pull requests it replaces —
    // those of the item's earlier versions, and those the walk closed.
    let mut replaces: Vec<crate::shared_config::Replaced> =
        change.replaces.iter().map(crate::shared_config::Replaced::of).collect();
    replaces.extend(replaced);
    let body = crate::shared_config::with_replaces(git, body, &replaces, reuse.as_deref().and_then(pr_number));
    let url = match reuse {
        Some(url) => {
            if let Some(number) = pr_number(&url) {
                let _ = gh.pr_edit(&git.cwd, &repo, number, &title, &body);
            }
            url
        }
        None => match gh.pr_create(&git.cwd, &repo, branch, &chosen, &title, &body) {
            Ok(url) => url,
            Err(e) => {
                return ChangeOutcome::PullRequestUncertain(format!(
                    "opening the pull request failed: {e}"
                ))
            }
        },
    };
    match pr_number(&url) {
        Some(number) => ChangeOutcome::PullRequest {
            pull_request: PullRequest {
                number,
                url,
                branch: chosen,
                head: Some(head),
            },
            // The same sentence the pull request's body opens with: for the
            // never-override case it names the file that moved and who moved it
            // — and for a refused push it is git's stderr, which is why what it
            // is has to travel with it (GH #160, review 1).
            reason: reason.to_string(),
            never_override,
            renamed: None,
            commit: Some(sha.to_string()),
        },
        None => ChangeOutcome::PullRequestUncertain(format!("gh printed no pull request URL: {url}")),
    }
}

// ── Queue and refresh ─────────────────────────────────────────────────

/// 1.169.0 (C4): what `Undo` on a skill's removal found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemovalWithdrawal {
    /// The queued removal was taken back: the branch keeps the item.
    Withdrawn,
    /// Taken back, and the unpublished edit it had replaced is queued again.
    Restored,
    /// No removal of it is queued: it went to the branch already.
    NotQueued,
    /// Something newer than the removal is queued for it (a publish).
    Replaced,
}

/// 1.169.0 (C4): take back a queued **removal** of `name` (`Undo` on the
/// toast of `Remove from <branch>…`), while it is still only queued: no
/// attempt started, no pull request. The unpublished edit it replaced, if
/// any, takes its place again (Challenger). An error when its publish is
/// under way.
pub fn withdraw_queued_removal(
    queue: &mut LibraryQueue,
    kind: ItemKind,
    name: &str,
) -> Result<RemovalWithdrawal, String> {
    let key = kind.key(name);
    let Some(index) = queue.changes.iter().position(|c| c.group.is_none() && c.key() == key) else {
        return Ok(RemovalWithdrawal::NotQueued);
    };
    let change = &queue.changes[index];
    if change.files.is_some() || !change.copies.is_empty() {
        return Ok(RemovalWithdrawal::Replaced);
    }
    if change.attempt_started || change.pull_request.is_some() {
        return Err(format!("The removal of {name} is already on its way to the branch."));
    }
    let removal = queue.changes.remove(index);
    match removal.replaced {
        Some(edit) => {
            queue.changes.insert(index, *edit);
            Ok(RemovalWithdrawal::Restored)
        }
        None => Ok(RemovalWithdrawal::Withdrawn),
    }
}

/// Put a change in the queue (replacing a queued change to the same item) and
/// lay it over the mirror at once. Nothing is published here.
pub fn enqueue(
    git: &Plumbing,
    paths: &Paths,
    branch: &str,
    mut change: LibraryChange,
) -> Result<(), String> {
    check_item_name(change.kind, &change.name)?;
    let mut queue = load_queue(paths);
    // What a build that is up to date already reflects.
    let before = queue_digest(&queue);
    let manifest = match load_manifest(paths) {
        Some(manifest) => manifest,
        None => build_mirror(git, paths, branch, &queue)?,
    };
    let key = change.key();
    // GH #101: an instructions change carries its own per-file bases, recorded
    // when the flow read the before/after the member was shown. The queue does
    // not know them and must not invent a fresher one here: "the blob the edit
    // started from" is the one on screen, not the one at press time.
    if change.kind != ItemKind::Instructions {
        change.base = manifest.items.get(&key).cloned();
    }
    // Skills group B §2: a skill's per-root bases, when the flow did not record
    // its own — the trees the mirror showed, which is what the Library showed.
    // `Update on <branch>` records the checkout's instead (`checkout_skill_bases`).
    if change.kind == ItemKind::Skill && change.bases.is_empty() {
        for name in change.names() {
            change.bases.extend(skill_bases_from(&manifest, &name));
        }
    }
    change.queued_at = crate::shared_config::now_millis();
    if let Some(index) = queue.changes.iter().position(|c| c.key() == key) {
        let old = queue.changes.remove(index);
        // GH #206 review 2: removing a new note that never left this Mac. The
        // branch never had it, so a queued removal would only delete whatever
        // is at its path there now — a teammate's different note. Both go.
        if change.files.is_none()
            && is_new_note(&old)
            && old.attempts == 0
            && !old.attempt_started
            && old.pull_request.is_none()
        {
            save_queue(paths, &queue)?;
            // From the fetched tip: whatever the branch has at that path is shown
            // again, and nothing of the dropped note remains.
            build_mirror(git, paths, branch, &queue)?;
            return Ok(());
        }
        // 1.169.0 (C4, Challenger): a removal over an edit that never left
        // this Mac keeps it, so the removal's Undo can queue it again (and
        // a second removal keeps what the first kept).
        if change.files.is_none()
            && change.copies.is_empty()
            && old.attempts == 0
            && !old.attempt_started
            && old.pull_request.is_none()
        {
            change.replaced = if old.files.is_some() || !old.copies.is_empty() {
                Some(Box::new(old.clone()))
            } else {
                old.replaced.clone()
            };
        }
        // The user never saw anything between the two edits.
        if old.pull_request.is_none() {
            change.base = old.base;
            // GH #101 review 2 (NIT), spelled out: a replacing instructions change
            // inherits the **earlier** change's bases, not its own fresher
            // snapshot. The rule is the one `base` follows — the member saw
            // nothing between the two edits, so the blob their first reading
            // started from is the one to judge against.
            //
            // It errs towards a pull request. If the branch moved between the two
            // steps and the second was planned against that newer blob, the older
            // base no longer matches and the publish opens a pull request where a
            // direct commit was in fact possible. That is the safe direction — a
            // pull request never loses anybody's bytes, and a commit can — and the
            // cost is one review the member could have skipped.
            //
            // Skills group B §2: a skill's per-root bases follow the same rule, for
            // the same reason.
            if matches!(change.kind, ItemKind::Instructions | ItemKind::Skill)
                && !old.bases.is_empty()
            {
                change.bases = old.bases.clone();
            }
        }
        // The new contents get a branch of their own: a pull request an
        // earlier attempt opened (recorded or not) carries the old ones.
        change.pull_request_branch = None;
        // Round 5 (V2): what this change supersedes travels with it, so its
        // own pull request can say so.
        change.replaces = old.replaces;
        match (old.pull_request, old.pull_request_branch) {
            (Some(pr), _) => {
                change.replaces.push(pr.clone());
                queue.superseded_pull_requests.push(pr)
            }
            (None, Some(branch)) if old.attempt_started => queue.superseded_branches.push(branch),
            _ => {}
        }
        // An edit of a promoted note still settles its personal source; a
        // removal doesn't take the personal original with it.
        if change.personal_source.is_none() && change.files.is_some() {
            change.personal_source = old.personal_source;
        }
    }
    // The intent first: a failed build below leaves the change queued, and
    // the next refresh's build lays it over the mirror.
    let applied = change.clone();
    queue.changes.push(change);
    save_queue(paths, &queue)?;
    rebuild_with(paths, &applied, &before, &queue)
}

/// A new build of the mirror — the current one copied, with `change` laid
/// over it — made current by the same atomic link swap as a refresh: a
/// reader never sees the item missing or half-written.
fn rebuild_with(
    paths: &Paths,
    change: &LibraryChange,
    before: &str,
    queue: &LibraryQueue,
) -> Result<(), String> {
    let mirror = paths.mirror();
    let current = ply_memory::resolve_mirror(&mirror)
        .ok_or_else(|| format!("{mirror:?} has no build to change"))?;
    let mut manifest = load_manifest(paths).ok_or_else(|| format!("{mirror:?} has no manifest"))?;
    let scratch = new_version(&mirror);
    let built = (|| -> Result<(), String> {
        for file in crate::project_skills::read_tree(&current)? {
            if file.path == ply_memory::SHARED_LIBRARY_MANIFEST {
                continue;
            }
            write_file(&scratch, &file.path, &file.bytes, file.executable)?;
        }
        apply_change(&scratch, change)?;
        // Laying the change (whole item) over a build that reflected the
        // queue before it gives one that reflects the queue now. A build that
        // was already behind stays marked behind, for the next refresh.
        if manifest.applied_queue == before {
            manifest.applied_queue = queue_digest(queue);
        }
        crate::atomic::write_atomic_json(&scratch.join(ply_memory::SHARED_LIBRARY_MANIFEST), &manifest)
    })();
    if let Err(e) = built {
        let _ = std::fs::remove_dir_all(&scratch);
        return Err(e);
    }
    swap_into(&scratch, &mirror)
}

/// The removal of note `slug`, only if the mirror still holds exactly the
/// bytes `original` read before the promote (a Project → Team promote removes
/// what it published, never a newer edit); `(None, false)` otherwise. Absent
/// already: nothing to remove. Raw bytes, not re-encoded Markdown: a note
/// written by hand (other YAML layout, CRLF) is still "unchanged".
pub fn removal_if_unchanged(
    mirror: &Path,
    slug: &str,
    title: &str,
    original: &[u8],
) -> Result<(Option<LibraryChange>, bool), String> {
    check_name(slug)?;
    let path = mirror.join(ItemKind::Knowledge.repo_path(slug));
    match std::fs::read(&path) {
        Ok(bytes) if bytes == original => Ok((
            Some(LibraryChange::new(ItemKind::Knowledge, slug, title, None)),
            true,
        )),
        Ok(_) => Ok((None, false)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((None, true)),
        Err(e) => Err(format!("read {path:?}: {e}")),
    }
}

/// One queued item, for the panels.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingItem {
    pub kind: ItemKind,
    pub name: String,
    pub title: String,
    pub removed: bool,
    pub last_error: Option<String>,
    /// The last attempt could not reach origin (F3/F9): `last_error` is then
    /// a wait, not something to fix. `None`: not known (no error, or an entry
    /// queued before this was recorded).
    #[serde(default)]
    pub offline: Option<bool>,
    pub pull_request: Option<PullRequest>,
}

/// Every item waiting, **one row each** — a grouped change (GH #105) carries
/// several skills, and each of their rows says what is happening to it: the
/// board's `Publishing to staging…`, or the pull request it waits in. A bulk
/// action that showed a state on one row out of thirty-four would leave the rest
/// looking untouched while they were being published.
pub fn pending_items(paths: &Paths) -> Vec<PendingItem> {
    load_queue(paths)
        .changes
        .into_iter()
        .flat_map(|change| {
            change
                .names()
                .into_iter()
                .map(|name| PendingItem {
                    kind: change.kind,
                    // A copy carries no `files` and removes nothing (review 2):
                    // without the guard every row of a queued copy said
                    // `Removing from staging…`, and its pull request said a
                    // removal was waiting in it. The sibling in `sync` had it.
                    removed: change.files.is_none() && change.copies.is_empty(),
                    name,
                    title: change.title.clone(),
                    last_error: change.last_error.clone(),
                    offline: change.last_error.as_ref().and(change.last_offline),
                    pull_request: change.pull_request.clone(),
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// GH #161: the instruction files a queued change has laid over this build.
///
/// [`enqueue`] applies a change to the mirror at once, so a file only a pending
/// change writes is in the mirror and **not** on the branch. The page's rows have
/// to tell the two apart: `On staging only — pull it to get it here.` about a file
/// `staging` has not got sends the member to pull nothing, and the change is in
/// fact waiting here (or in a pull request).
/// A queued **removal** contributes nothing here (`files: None` flattens away),
/// which is right and is also unreachable: `LibraryChange::instructions` refuses a
/// change that writes neither file, so nothing produces one today (review 1, NIT).
pub fn queued_instruction_files(queue: &LibraryQueue) -> Vec<String> {
    queue
        .changes
        .iter()
        .filter(|change| change.kind == ItemKind::Instructions)
        .flat_map(|change| change.files.iter().flatten())
        .map(|file| file.path.clone())
        .filter(|path| crate::shared_config::INSTRUCTION_FILES.contains(&path.as_str()))
        .collect()
}

/// The mirror's skills Claude sessions in `cwd` get through the `project`
/// plugin: those `cwd` has no `.claude/skills` copy of, or a different one —
/// the same choice `session_plugin_dir` makes at launch.
pub fn skills_supplied_to(paths: &Paths, cwd: &Path) -> Vec<String> {
    let Some(build) = ply_memory::resolve_mirror(&paths.mirror()) else {
        return Vec::new();
    };
    claude_skills_for(&build, cwd)
}

/// Walk F4: the mirror's skills whose checkout copies are already what the
/// branch carries — every root [`LibraryWriter::skill_files_both`] would send
/// from `cwd` (`.claude/skills`, `.agents/skills`) holds the same files on the
/// branch at the same root. For these an `Update on <branch>` would commit
/// nothing, so the Library does not offer one. A copy that cannot be read on
/// either side is not listed: the press is offered and says why it failed.
/// Sorted by name.
/// A skill whose checkout copy for one CLI is behind the branch **by this Mac's
/// own choice**: an Update let that copy follow the edited one, the branch
/// carries the two aligned, and the checkout has not pulled yet.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutBehind {
    pub name: String,
    /// `"claude"` or `"codex"`: the checkout's copy that is behind.
    pub copy: String,
}

/// Group B §2 walks: the skills whose only difference between the checkout's
/// two copies is one of them lagging behind what the branch has aligned —
/// the copy a follow left behind ([`PublishedHere::followed`]) is still exactly
/// as it was, the other copy is exactly the branch's, and the branch's two
/// copies are one tree. Not a divergence, and the row says so.
pub fn checkout_copies_behind(paths: &Paths, cwd: &Path) -> Vec<CheckoutBehind> {
    let here = load_published(paths);
    if here.followed.is_empty() {
        return Vec::new();
    }
    let Some(commit) = load_manifest(paths).and_then(|m| m.commit) else {
        return Vec::new();
    };
    let git = Plumbing { cwd: cwd.to_path_buf() };
    let mut out = Vec::new();
    for (root, left) in &here.followed {
        let Some((parent, name)) = root.rsplit_once('/') else { continue };
        let (other_parent, copy) = if parent == CODEX_SKILLS_PATH {
            (SKILLS_PATH, "codex")
        } else {
            (CODEX_SKILLS_PATH, "claude")
        };
        let other = format!("{other_parent}/{name}");
        let (Some(branch_this), Some(branch_other)) =
            (tree_at(&git, &commit, root), tree_at(&git, &commit, &other))
        else {
            continue;
        };
        let aligned = branch_this == branch_other;
        let still_left = checkout_root_tree(&git, cwd, parent, name, Some(&commit)).as_ref() == Some(left);
        let other_current =
            checkout_root_tree(&git, cwd, other_parent, name, Some(&commit)).as_ref() == Some(&branch_other);
        if aligned && still_left && other_current {
            out.push(CheckoutBehind { name: name.to_string(), copy: copy.to_string() });
        }
    }
    out
}

pub fn skills_current_in(paths: &Paths, cwd: &Path) -> Vec<String> {
    let Some(build) = ply_memory::resolve_mirror(&paths.mirror()) else {
        return Vec::new();
    };
    let mut names: Vec<String> = crate::skill_reach::names_in(&build)
        .into_iter()
        .filter(|name| !name.starts_with('.'))
        .filter(|name| checkout_matches_branch(&build, cwd, name))
        .collect();
    names.sort();
    names.dedup();
    names
}

fn checkout_matches_branch(build: &Path, cwd: &Path, name: &str) -> bool {
    let mut carried = 0;
    for root in [SKILLS_PATH, CODEX_SKILLS_PATH] {
        let local = cwd.join(root).join(name);
        if std::fs::symlink_metadata(&local).is_err() {
            continue;
        }
        carried += 1;
        let branch_dir = build.join(root).join(name);
        match (
            crate::project_skills::read_tree(&local),
            crate::project_skills::read_tree(&branch_dir),
        ) {
            (Ok(local), Ok(branch)) if local == branch => {}
            (Ok(here), Ok(branch)) if same_as_git_records(cwd, &format!("{root}/{name}"), &here, &branch_dir, &branch) => {}
            _ => return false,
        }
    }
    carried > 0
}

/// Owner-fixes Windows walk: the checkout's copy and the branch's differ in
/// bytes but not in what git records — a Windows checkout with `core.autocrlf`
/// has CRLF where the branch's blobs (and the mirror written from them) have
/// LF, and no executable bit. Judged as `git add` would: each checkout file
/// hashed through git's filters, each mirror file as it is, and the bit only
/// where the file system keeps it. Without this every unchanged skill with
/// text read "not current" on Windows: `Update on <branch>` was offered and
/// pressed into a publish that committed nothing.
fn same_as_git_records(
    cwd: &Path,
    dir: &str,
    here: &[crate::project_skills::TreeFile],
    branch_dir: &Path,
    branch: &[crate::project_skills::TreeFile],
) -> bool {
    if here.len() != branch.len() || here.iter().zip(branch).any(|(a, b)| a.path != b.path) {
        return false;
    }
    let git = Plumbing { cwd: cwd.to_path_buf() };
    if git.file_mode_meaningful() && here.iter().zip(branch).any(|(a, b)| a.executable != b.executable) {
        return false;
    }
    let local: Vec<String> = here.iter().map(|f| format!("{dir}/{}", f.path)).collect();
    let mirror: Vec<String> = branch
        .iter()
        .map(|f| branch_dir.join(&f.path).to_string_lossy().into_owned())
        .collect();
    match (git.hash_worktree_paths(&local, false), git.hash_files_raw(&mirror)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// The mirror's Claude skills a session starting in `session_cwd` gets:
/// loadable on the branch, and not already in that directory as the branch has
/// it. Sorted by name. The Claude twin of
/// [`crate::branch_codex_skills::skills_for`], and the one choice both
/// [`session_plugin_dir`] and [`skills_supplied_to`] make.
fn claude_skills_for(build: &Path, session_cwd: &Path) -> Vec<String> {
    claude_skills_on_branch(build)
        .into_iter()
        .filter(|name| checkout_lacks(session_cwd, &build.join(SKILLS_PATH), name))
        .collect()
}

/// Every Claude skill on the branch that Claude would load, sorted by name.
fn claude_skills_on_branch(build: &Path) -> Vec<String> {
    use crate::skill_reach::Side;
    let skills = build.join(SKILLS_PATH);
    let Ok(entries) = std::fs::read_dir(&skills) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        // A dot directory is hidden from the plugin reader, so it is never a
        // skill a session gets — and one a copy left mid-way (`claim`'s
        // `.<name>.ply-new-…`) must not be packed as one.
        .filter(|name| !name.starts_with('.'))
        // A directory Claude would not load (no `SKILL.md`, no description)
        // is not packed: the plugin would carry it to no effect, and the
        // Library would say it was supplied.
        .filter(|name| crate::skill_reach::side_state(build, Side::Claude, name).loads())
        .collect();
    names.sort();
    names
}

/// The one directory every reader of the mirror's skills looks in.
///
/// `resolve_mirror` pins the build a link points at — and refuses a build with
/// no `manifest.json`, which is a build still being written. The fallback to the
/// link itself is what keeps two readers from disagreeing: GH #96 review 1 found
/// `mirror_skills` reading the raw path while `mirror_skill_rows` resolved it,
/// so a mirror without a manifest gave the Library a branch skill's name with no
/// row to put it in. With a manifest the two paths name the same directory, so
/// this changes nothing for the callers `mirror_skills` already had.
fn mirror_skills_dir(paths: &Paths) -> PathBuf {
    mirror_build(paths).join(SKILLS_PATH)
}

/// The mirror build every reader of it looks in: the pinned one, or the link
/// itself while there is no manifest yet (see [`mirror_skills_dir`]).
pub fn mirror_build(paths: &Paths) -> PathBuf {
    let mirror = paths.mirror();
    ply_memory::resolve_mirror(&mirror).unwrap_or(mirror)
}

/// The skill directories the mirror holds, under **either** root (GH #105).
///
/// This is the list every caller asks "is this name on the branch?" of, and since
/// a skill is one item in two directories the answer cannot be the Claude root
/// alone: a skill the branch carries for Codex only would otherwise read as not
/// being there, and `Remove from <branch>` would not be offered for it.
pub fn mirror_skills(paths: &Paths) -> Vec<String> {
    crate::skill_reach::names_in(&mirror_build(paths))
}

/// One skill the mirror holds, as the Library's rows need it.
///
/// GH #96: [`mirror_skills`] answers "which names are on the branch", which
/// was all the Project panel needed. A Library row shows the first sentence of
/// the description, so a skill that lives only on the branch has to be read
/// the way every other scope is read — through
/// [`crate::team_skills::read_skill_dir`], the one reader that decides whether
/// a CLI would load it at all.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MirrorSkill {
    pub name: String,
    pub codex_name: Option<String>,
    pub description: String,
    /// Its directory inside the pinned build, absolute: what the Library reads
    /// to show a branch-only skill's `SKILL.md`. The Claude copy's, when the
    /// branch has one; the Codex copy's otherwise.
    pub dir: String,
    /// GH #105: which CLIs the branch's copies reach, and whether the two
    /// copies say the same thing. `#[serde(default)]` so a `LibraryState`
    /// written by an older build still reads.
    #[serde(default)]
    pub claude: bool,
    #[serde(default)]
    pub codex: bool,
    /// Both copies are on the branch and they are not the same files.
    #[serde(default)]
    pub differs: bool,
    /// The Codex copy's directory inside the build, when the branch has one —
    /// what `Compare` reads the other side's `SKILL.md` out of.
    #[serde(default)]
    pub codex_dir: Option<String>,
    /// Group B §2 review 1: the skill's id on the branch as this build recorded
    /// it — the version the row shows. `Remove` and `Align` send it back, so their
    /// base is what was on screen, not what a refresh fetched meanwhile.
    #[serde(default)]
    pub id: Option<String>,
}

/// The mirror's skills with their descriptions, out of the same directory
/// [`mirror_skills`] lists — so a name and its row always come together.
///
/// A directory the loader refuses is not a skill and is left out, as it is left
/// out of the plugin a session gets.
/// GH #105: both roots, because reach is a property of the skill. A name either
/// root holds gets a row; the row says which CLIs the branch's copies reach and
/// whether the two disagree, and the description is read from the copy the row's
/// `dir` names.
pub fn mirror_skill_rows(paths: &Paths) -> Vec<MirrorSkill> {
    let build = mirror_build(paths);
    // The same build's manifest, so a row and its id are one reading.
    let manifest: Option<Manifest> = std::fs::read(build.join(ply_memory::SHARED_LIBRARY_MANIFEST))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    crate::skill_reach::branch_reach(&build)
        .into_iter()
        .filter_map(|reach| {
            let name = reach.name.clone();
            // Neither copy is a skill a CLI would load: a name without a row, as
            // it is a name without a place in the plugin.
            let side = if reach.claude {
                crate::skill_reach::Side::Claude
            } else if reach.codex {
                crate::skill_reach::Side::Codex
            } else {
                return None;
            };
            let dir = crate::skill_reach::skill_dir(&build, side, &name);
            let loaded = crate::team_skills::read_skill_dir(&dir, &mut Vec::new())?;
            Some(MirrorSkill {
                name: loaded.dir,
                codex_name: loaded.codex_name,
                description: loaded.description,
                dir: dir.to_string_lossy().to_string(),
                claude: reach.claude,
                codex: reach.codex,
                differs: reach.differs,
                codex_dir: reach.codex.then(|| {
                    crate::skill_reach::skill_dir(&build, crate::skill_reach::Side::Codex, &name)
                        .to_string_lossy()
                        .to_string()
                }),
                id: manifest
                    .as_ref()
                    .and_then(|m| m.items.get(&ItemKind::Skill.key(&name)).cloned()),
            })
        })
        .collect()
}

/// One item that changed on the branch since the last refresh.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryUpdate {
    pub kind: ItemKind,
    pub name: String,
    pub title: String,
    /// "added", "changed" or "removed".
    pub action: String,
    pub author: Option<String>,
    /// GH #144: when the change landed on the integration branch — the commit
    /// time, in seconds, of the same commit [`Self::author`] is read from, so
    /// the row can say `Removed on staging by MatteoB-adv 2 hours ago` instead
    /// of dropping the age the board asks for.
    ///
    /// `None` where the author is `None`: git has no commit touching the item's
    /// paths on the branch, and a time Ply has not read is absent rather than
    /// guessed at. `#[serde(default)]` so a report written by an older build
    /// still decodes — nothing persists this struct (it is the refresh event's
    /// payload), but the report crosses the IPC boundary and its tests decode
    /// recorded JSON.
    #[serde(default)]
    pub changed_at: Option<i64>,
}

/// One item this drain put on the branch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublishedItem {
    pub kind: ItemKind,
    pub name: String,
    pub title: String,
    pub removed: bool,
    #[serde(default)]
    pub over: Option<ItemOverride>,
    /// GH #105: how many items this one commit carried. 0 and 1 both mean one,
    /// so an older report deserialises unchanged; more than one makes the toast
    /// count skills instead of naming a title that is already a count.
    #[serde(default)]
    pub count: u32,
}

/// One change this drain left waiting in a pull request (GH #160).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WaitingPullRequest {
    /// Which kind waits: the instructions are not "a shared note or skill", and
    /// their toast names them.
    pub kind: ItemKind,
    /// The change's title — a note's or skill's name, or the instructions
    /// change's subject (`both CLIs read AGENTS.md`).
    pub title: String,
    pub pull_request: PullRequest,
    /// Why it waits, in the backend's own words — **only** a sentence when
    /// [`Self::never_override`] is true. Otherwise it is git's stderr from the
    /// push the branch refused (`classify_push_error` keeps it whole), which a
    /// protected branch answers with `remote: error: GH006 …`: fit for the pull
    /// request's body and the log, not for a toast (review 1, MAJOR).
    pub reason: String,
    /// The branch was never asked: an instruction file this change writes moved
    /// there, and Ply does not commit over one. Then, and only then, `reason` is
    /// the sentence the member is shown.
    #[serde(default)]
    pub never_override: bool,
}

/// What one library sync did, for the refresh report.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryReport {
    pub branch: String,
    pub updates: Vec<LibraryUpdate>,
    pub published: Vec<PublishedItem>,
    /// Items that wait in a pull request opened by this drain.
    ///
    /// GH #160: with the kind and the reason, because a waiting change is
    /// announced per kind — the instructions get the toast the direct commit's
    /// `Published the instructions to staging` is the other half of, and the
    /// backend's sentence is its body.
    pub pull_requests: Vec<WaitingPullRequest>,
    /// Titles whose pull request was closed without merging (dropped).
    pub closed: Vec<String>,
    /// Items still queued.
    pub pending: Vec<String>,
    /// GH #101 review 1: the **kinds** still queued, beside their titles, so a
    /// refusal is announced on the page the member met it on — an instructions
    /// refusal belongs on Instructions, not on Skills.
    #[serde(default)]
    pub pending_kinds: Vec<ItemKind>,
    pub error: Option<String>,
    pub offline: bool,
    /// The push was refused and no pull request could carry it.
    pub refused: Option<String>,
    /// GH #101 review 1: an instruction file moved on the branch, so Ply would
    /// not commit over it and no pull request could carry the change either.
    ///
    /// **Not** [`Self::refused`]: this Mac's write access is not in question, and
    /// the read-only `PublishRefusedBlock` must not fire for a branch nobody
    /// asked.
    #[serde(default)]
    pub blocked: Option<String>,
    /// Promoted personal notes now on the branch: the caller removes them
    /// from the personal layer.
    #[serde(default)]
    pub promoted: Vec<PersonalSource>,
    /// GH #105 review 1: copies this drain would not make, each with its reason
    /// — a destination somebody had filled meanwhile, a source that moved. The
    /// commit carried the rest, and the member is told which and why.
    #[serde(default)]
    pub not_copied: Vec<String>,
}

/// The pull-request side the drain needs, behind a trait for tests.
pub trait LibraryPublisher {
    fn publish(&self, branch: &str, change: &LibraryChange, pull_request_branch: &str) -> ChangeOutcome;
    fn pull_request_state(&self, pull_request: &PullRequest) -> Option<PrState>;
    fn close_pull_request(&self, pull_request: &PullRequest) -> Result<(), String>;
    /// The pull request an earlier attempt opened from `branch` (or its
    /// `-2`, `-3`… fallbacks), with its state and base: an open one first,
    /// else a merged one, else a closed one. `Err` when that can't be known.
    fn find_pull_request(&self, branch: &str) -> Result<Option<FoundRequest>, String>;
    /// Close every open pull request from `branch` and its fallbacks.
    fn withdraw_branch(&self, branch: &str) -> Result<(), String>;
    /// Fetch `branch` from origin, so the mirror's next build has what just
    /// merged into it.
    fn fetch_branch(&self, branch: &str) -> Result<(), String>;
}

fn merged_not_fetched(number: u64, branch: &str, title: &str, error: &str) -> String {
    format!(
        "Pull request #{number} merged, but {branch} couldn't be fetched ({error}); “{title}” stays as it is on {THIS_MACHINE} until it can."
    )
}

/// A pull request found from a fallback branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundRequest {
    pub pull_request: PullRequest,
    pub state: PrState,
    pub base: Option<String>,
}

pub struct GitLibraryPublisher<'a> {
    pub git: &'a Plumbing,
    pub gh: Option<&'a Gh>,
}

impl LibraryPublisher for GitLibraryPublisher<'_> {
    fn publish(&self, branch: &str, change: &LibraryChange, pull_request_branch: &str) -> ChangeOutcome {
        publish_change(
            self.git,
            self.gh,
            branch,
            change,
            pull_request_branch,
            crate::shared_config::now_millis() / 1000,
        )
    }

    fn pull_request_state(&self, pull_request: &PullRequest) -> Option<PrState> {
        let repo = self.git.github_repo()?;
        self.gh?.pr_state(&self.git.cwd, &repo, pull_request.number).ok()
    }

    fn close_pull_request(&self, pull_request: &PullRequest) -> Result<(), String> {
        let gh = self.gh.ok_or_else(|| "the GitHub CLI isn't available".to_string())?;
        let repo = self
            .git
            .github_repo()
            .ok_or_else(|| "origin isn't a GitHub repository".to_string())?;
        match gh.pr_state(&self.git.cwd, &repo, pull_request.number)? {
            PrState::Open => gh.pr_close(&self.git.cwd, &repo, pull_request.number),
            _ => Ok(()),
        }
    }

    fn find_pull_request(&self, branch: &str) -> Result<Option<FoundRequest>, String> {
        let Some(repo) = self.git.github_repo() else {
            return Ok(None);
        };
        // GitHub lists a pull request by its head branch's name even after the
        // branch was deleted (merged or closed and cleaned up), so every
        // candidate is asked — whether or not the branch is still on origin.
        // Only an attempt that pushed its pull request branch and got no
        // answer creating the PR is looked up. Without `gh` its history can't
        // be read — and a branch gone from origin proves nothing (merged or
        // closed PRs have theirs deleted) — so it waits rather than risk
        // republishing a rejected change or overwriting a merge.
        let gh = self.gh.ok_or_else(|| {
            format!(
                "a pull request may exist from {branch}, and the GitHub CLI isn't available to check"
            )
        })?;
        let mut found: Vec<FoundRequest> = Vec::new();
        for candidate in fallback_branches(branch) {
            if let Some(pr) = gh.pr_for_branch(&self.git.cwd, &repo, &candidate)? {
                let number = pr_number(&pr.url)
                    .ok_or_else(|| format!("gh printed no pull request URL: {}", pr.url))?;
                found.push(FoundRequest {
                    pull_request: PullRequest {
                        number,
                        url: pr.url,
                        branch: candidate,
                        // Found by its branch's name: no record.
                        head: None,
                    },
                    state: pr.state,
                    base: pr.base,
                });
            }
        }
        Ok([PrState::Open, PrState::Merged, PrState::Closed]
            .into_iter()
            .find_map(|state| found.iter().find(|f| f.state == state).cloned()))
    }

    fn fetch_branch(&self, branch: &str) -> Result<(), String> {
        self.git.fetch(branch).map_err(|e| e.to_string())
    }

    fn withdraw_branch(&self, branch: &str) -> Result<(), String> {
        while let Some(found) = self.find_pull_request(branch)? {
            if found.state != PrState::Open {
                return Ok(());
            }
            self.close_pull_request(&found.pull_request)?;
        }
        Ok(())
    }
}

/// Drain the queue onto `branch`, then rebuild the mirror from the tip and
/// report what changed there since the last build. Call under the workspace's
/// definition lock, after the definition refresh fetched the branch.
pub fn sync(
    git: &Plumbing,
    publisher: &dyn LibraryPublisher,
    paths: &Paths,
    branch: &str,
) -> Result<LibraryReport, String> {
    let mut report = LibraryReport {
        branch: branch.to_string(),
        ..Default::default()
    };
    let mut queue = load_queue(paths);
    let mut published_items: BTreeMap<String, Option<String>> = BTreeMap::new();
    // What this Mac last showed the member, read before anything is published: a
    // copy records the source root as **this** had it, so a teammate's edit to it
    // is still a change this Mac has not seen (review 2).
    let last_build = load_manifest(paths);
    // Item key → the source paths a copy of this drain read. The author of an
    // announced change is looked up over those rather than over the destination
    // this drain wrote itself.
    let mut copied_sources: BTreeMap<String, Vec<String>> = BTreeMap::new();

    // A superseded pull request that can't be withdrawn could still merge an
    // older version over whatever this drain publishes: publish nothing
    // until it is closed.
    let mut hold: Option<String> = None;
    queue.superseded_pull_requests.retain(|pr| match publisher.close_pull_request(pr) {
        Ok(()) => false,
        Err(e) => {
            log::info!("shared_library: closing superseded PR #{} later: {e}", pr.number);
            hold.get_or_insert(format!(
                "Couldn't withdraw pull request #{} ({e}); nothing is published until it is closed, or it could merge an older version over the newer change.",
                pr.number
            ));
            true
        }
    });
    queue.superseded_branches.retain(|branch| match publisher.withdraw_branch(branch) {
        Ok(()) => false,
        Err(e) => {
            log::info!("shared_library: withdrawing PRs from {branch} later: {e}");
            hold.get_or_insert(format!(
                "Couldn't check {branch} for a pull request an interrupted attempt may have opened ({e}); nothing is published until it can be withdrawn."
            ));
            true
        }
    });
    if let Some(held) = &hold {
        report.error = Some(held.clone());
    }
    let mut kept = Vec::new();
    let mut offline = false;
    let mut todo: std::collections::VecDeque<LibraryChange> =
        std::mem::take(&mut queue.changes).into();
    while let Some(mut change) = todo.pop_front() {
        // A pull request onto an integration branch that is no longer this
        // one: withdrawn, and the change published here instead.
        if let Some(pr) = change.pull_request.clone() {
            if change.pull_request_base.as_deref().is_some_and(|base| base != branch) {
                match publisher.close_pull_request(&pr) {
                    Ok(()) => {
                        change.pull_request = None;
                        change.pull_request_base = None;
                        change.pull_request_branch = None;
                    }
                    Err(e) => {
                        report.error = Some(format!(
                            "Couldn't withdraw pull request #{} onto {} ({e}); “{}” is published to {branch} once it is closed.",
                            pr.number,
                            change.pull_request_base.as_deref().unwrap_or_default(),
                            change.title
                        ));
                        kept.push(change);
                        continue;
                    }
                }
            }
        }
        if let Some(pr) = change.pull_request.clone() {
            match publisher.pull_request_state(&pr) {
                Some(PrState::Merged) => {
                    // Let go only once this Mac has fetched the merge: the
                    // mirror is rebuilt from the fetched tip, and a stale one
                    // would drop the note (or revert its edit) with it.
                    match publisher.fetch_branch(branch) {
                        Ok(()) => {
                            // Review 1 (MINOR 3): the member's merged work is their
                            // own version from here on, as a direct commit's is.
                            merged_checkout_publish(git, paths, branch, &change);
                            report.promoted.extend(change.personal_source);
                        }
                        Err(e) => {
                            report.error = Some(merged_not_fetched(pr.number, branch, &change.title, &e));
                            kept.push(change);
                        }
                    }
                    continue;
                }
                // Dropped; a promoted note is still in the personal layer.
                Some(PrState::Closed) => {
                    report.closed.push(change.title.clone());
                    continue;
                }
                _ => {
                    kept.push(change);
                    continue;
                }
            }
        }
        if offline || hold.is_some() {
            kept.push(change);
            continue;
        }
        // 1.169.0 (C4, Challenger): a removal inside its Undo window waits,
        // whatever drain comes first; its own timer drains when it is due.
        if change.not_before > crate::shared_config::now_millis() {
            kept.push(change);
            continue;
        }
        // An earlier attempt may have opened a pull request whose answer was
        // lost (a timeout, Ply quitting): settle by its state before trying
        // again, never open a second one beside it.
        if let (true, Some(saved)) = (change.attempt_started, change.pull_request_branch.clone()) {
            match publisher.find_pull_request(&saved) {
                Ok(Some(found)) => {
                    let onto_here = found.base.as_deref().is_none_or(|b| b == branch);
                    match (found.state, onto_here) {
                        (PrState::Merged, true) => {
                            match publisher.fetch_branch(branch) {
                                Ok(()) => {
                                    merged_checkout_publish(git, paths, branch, &change);
                                    report.promoted.extend(change.personal_source)
                                }
                                Err(e) => {
                                    report.error = Some(merged_not_fetched(
                                        found.pull_request.number,
                                        branch,
                                        &change.title,
                                        &e,
                                    ));
                                    change.pull_request = Some(found.pull_request);
                                    change.pull_request_base = Some(branch.to_string());
                                    kept.push(change);
                                }
                            }
                            continue;
                        }
                        (PrState::Closed, true) => {
                            report.closed.push(change.title.clone());
                            continue;
                        }
                        // Closed onto a former integration branch — by Ply
                        // withdrawing it when the branch changed, possibly
                        // before quitting — is no verdict on this branch:
                        // published here from a fresh branch.
                        (PrState::Closed, false) => change.pull_request_branch = None,
                        (PrState::Open, true) => {
                            change.pull_request = Some(found.pull_request);
                            change.pull_request_base = Some(branch.to_string());
                            kept.push(change);
                            continue;
                        }
                        // Onto a former integration branch: withdrawn if
                        // open, and published here from a fresh branch.
                        (PrState::Open, false) => {
                            if let Err(e) = publisher.close_pull_request(&found.pull_request) {
                                report.error = Some(format!(
                                    "Couldn't withdraw pull request #{} ({e}); “{}” is published to {branch} once it is closed.",
                                    found.pull_request.number, change.title
                                ));
                                kept.push(change);
                                continue;
                            }
                            change.pull_request_branch = None;
                        }
                        (PrState::Merged, false) => change.pull_request_branch = None,
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    report.error = Some(format!(
                        "Couldn't tell whether an interrupted attempt opened a pull request for “{}” ({e}); retrying later.",
                        change.title
                    ));
                    kept.push(change);
                    continue;
                }
            }
        }
        // GH #206 review 2: a new note that must move aside takes its new name
        // **before** the attempt is saved, so an attempt whose answer is lost
        // (a pull request whose creation gave no answer, a push that landed but
        // reported unreachable) is recovered under the name that is really on
        // the branch — never laid back over the teammate's note it avoided.
        if change.pull_request.is_none() && is_new_note(&change) && publisher.fetch_branch(branch).is_ok() {
            if let Some(tip) = git.tip(branch) {
                if let Ok(Some(moved)) = new_note_moved_aside(git, &tip, &change) {
                    change = moved;
                }
            }
        }
        let pull_request_branch = change
            .pull_request_branch
            .get_or_insert_with(|| {
                let id = uuid::Uuid::new_v4().simple().to_string();
                format!(
                    "atelier/{}-{}-{}-{}",
                    change.kind.prefix(),
                    crate::shared_config::kebab(&change.name),
                    crate::shared_config::now_millis() / 1000,
                    &id[..8]
                )
            })
            .clone();
        // Saved (with every other change) before the attempt, so a retry
        // finds a PR it may have opened.
        change.attempt_started = true;
        let mut saving = queue.clone();
        saving.changes = kept
            .iter()
            .cloned()
            .chain(std::iter::once(change.clone()))
            .chain(todo.iter().cloned())
            .collect();
        save_queue(paths, &saving)?;
        match publisher.publish(branch, &change, &pull_request_branch) {
            ChangeOutcome::Published { sha, over, commit, carried, skipped, renamed } => {
                if let Some(name) = renamed {
                    change = change.renamed_note(&name);
                }
                report.not_copied.extend(skipped);
                // Skills group B §2: the checkout now holds what the branch holds
                // for the roots this publish wrote, so the next publish from it is
                // built on this version (`checkout_skill_bases`), not on the older
                // one its history still points at.
                if let Some(at) = commit.as_deref() {
                    record_checkout_publish(git, paths, &change, at, None);
                }
                // One change may have written several manifest items, and each of
                // them has to be marked as published **by this Mac** — otherwise
                // the diff below reads them off the branch and announces the
                // member's own publish back to them as a teammate's change.
                //
                // GH #101: an instructions step writes both root files. GH #105: a
                // grouped copy carries a root per skill.
                match (change.kind, change.copies.is_empty(), commit.as_deref()) {
                    (ItemKind::Instructions, _, Some(at)) => {
                        for file in change.files.iter().flatten() {
                            published_items.insert(
                                ItemKind::Instructions.key(&file.path),
                                item_sha(git, at, ItemKind::Instructions, &file.path),
                            );
                        }
                    }
                    // **Any** copy, grouped or a single skill's own (review 2: the
                    // single one fell through to the arm below and recorded the
                    // whole item). A copy wrote a destination root per skill and
                    // read the source roots without touching them, so what it may
                    // mark as "seen by this Mac" is the destination as it left it
                    // and the source as the **last build** had it. Recording the
                    // whole item's new id silenced a teammate's edit to the source
                    // root, which this commit sits on top of and did not make.
                    //
                    // A skill the tip refused (`skipped`) is not recorded at all:
                    // nothing about it was published.
                    (_, false, Some(at)) => {
                        for copy in change
                            .copies
                            .iter()
                            .filter(|copy| carried.contains(&copy.name))
                        {
                            let key = ItemKind::Skill.key(&copy.name);
                            copied_sources.insert(key.clone(), vec![copy.from.clone()]);
                            published_items
                                .insert(key, copied_item_id(git, at, last_build.as_ref(), copy));
                        }
                    }
                    _ => {
                        published_items.insert(change.key(), sha);
                    }
                }
                report.promoted.extend(change.personal_source.clone());
                // Already on the branch as it is: nothing to announce.
                if commit.is_none() {
                    continue;
                }
                // What the commit carried, not what was planned: a copy the tip
                // refused is in `not_copied`, and counting it here would tell the
                // member it had happened.
                let count = if change.copies.is_empty() {
                    change.names().len()
                } else {
                    carried.len()
                };
                report.published.push(PublishedItem {
                    kind: change.kind,
                    name: change.name.clone(),
                    // …and the title has to match that count (review 2): a group
                    // of 34 that carried one kept the title `34 skills for Claude
                    // and Codex` while the count said one, so the toast read
                    // "Published the skill 34 skills for Claude and Codex". The
                    // one skill it did carry names itself.
                    title: match (change.copies.is_empty(), carried.as_slice()) {
                        (false, [one]) => one.clone(),
                        _ => change.title.clone(),
                    },
                    removed: change.files.is_none() && change.copies.is_empty(),
                    over,
                    count: count as u32,
                });
            }
            ChangeOutcome::PullRequest {
                pull_request,
                reason,
                never_override,
                renamed,
                commit,
            } => {
                if let Some(name) = renamed {
                    change = change.renamed_note(&name);
                }
                change.pull_request_commit = commit;
                change.pull_request = Some(pull_request.clone());
                change.pull_request_base = Some(branch.to_string());
                change.attempts += 1;
                change.last_error = None;
                change.last_offline = Some(false);
                report.pull_requests.push(WaitingPullRequest {
                    kind: change.kind,
                    title: change.title.clone(),
                    pull_request,
                    reason,
                    never_override,
                });
                kept.push(change);
            }
            ChangeOutcome::PullRequestUncertain(e) => {
                // `attempt_started` stays: the next drain looks for the PR.
                change.attempts += 1;
                change.last_error = Some(e.clone());
                change.last_offline = Some(false);
                report.error = Some(e);
                kept.push(change);
            }
            ChangeOutcome::Unreachable(e) => {
                // No pull request can exist from this attempt: the next one
                // needn't ask GitHub first (a `gh` that can't authenticate
                // must never stall a publish that git alone can make).
                change.attempt_started = false;
                change.attempts += 1;
                change.last_error = Some(e.clone());
                change.last_offline = Some(true);
                report.error = Some(e);
                report.offline = true;
                offline = true;
                kept.push(change);
            }
            ChangeOutcome::Failed(e) => {
                change.attempt_started = false;
                // Round 3 (S4): every name of the sequence is taken — the
                // next Sync starts a new one, as the words say.
                if e.contains(crate::shared_config::NAMES_USED_UP_MARKER) {
                    change.pull_request_branch = None;
                }
                change.attempts += 1;
                change.last_error = Some(e.clone());
                change.last_offline = Some(false);
                // GH #101 review 1: the two are sorted apart. `refused` means
                // this Mac can't write the branch, and raises the read-only
                // block; `blocked` means an instruction file moved there and no
                // pull request could carry the change instead — nobody's write
                // access is in question.
                if e.contains(NEVER_OVERRIDE_MARKER) || e.contains(SKILL_NEVER_OVERRIDE_MARKER) {
                    report.blocked = Some(e.clone());
                } else if e.contains(REFUSED_MARKER) {
                    report.refused = Some(e.clone());
                }
                report.error = Some(e);
                kept.push(change);
            }
        }
    }
    queue.changes = kept;
    report.pending = queue.changes.iter().map(|c| c.title.clone()).collect();
    report.pending_kinds = queue.changes.iter().map(|c| c.kind).collect();
    save_queue(paths, &queue)?;

    // What the branch holds now, against the last build — with this Mac's
    // own publishes counted as already seen, so they aren't announced back.
    let previous = load_manifest(paths).map(|mut manifest| {
        for (key, sha) in &published_items {
            match sha {
                Some(sha) => manifest.items.insert(key.clone(), sha.clone()),
                None => manifest.items.remove(key),
            };
        }
        manifest
    });
    // Nothing moved: the mirror already holds the tip and every queued change.
    let tip = git.tip(branch);
    if let Some(tip) = tip.as_deref() {
        observe_in_sync(git, paths, tip);
    }
    if let Some(previous) = previous.as_ref() {
        if previous.branch == branch
            && previous.commit == tip
            && previous.applied_queue == queue_digest(&queue)
            // GH #162: …and this build recorded the instruction files. One that
            // predates them carries no copy of them either, so the Instructions
            // page would read the branch as having none — and the step it then
            // offers would be planned from bases that are not the branch's. One
            // rebuild puts both right, and the diff below stays quiet about them.
            // A 1.144.0 build is **not** one of those (review 1, MAJOR): it has
            // the files and its version is still 1, so it is left alone.
            && recorded_instructions(previous)
            && published_items.is_empty()
            && report.closed.is_empty()
        {
            return Ok(report);
        }
    }
    let manifest = build_mirror(git, paths, branch, &queue)?;
    if let Some(tip) = manifest.commit.as_deref() {
        prune_published(git, paths, tip);
    }
    if let Some(previous) = previous.filter(|p| p.branch == branch) {
        // GH #162: whether the last build recorded the instruction files at all.
        // Without this every member's first refresh after the 1.144.0 upgrade
        // announced `MatteoB-adv added CLAUDE.md` about a file that had been on
        // the branch for months: `(None, Some(_))` reads as "added" and a
        // pre-#101 manifest simply had no `instructions/*` items. The same rule
        // GH #105 kept for skill ids — a build learning to look is not a change.
        // It is the manifest that answers this and not its version, or a change a
        // teammate made since a 1.144.0 build would be swallowed with it.
        let knew_instructions = recorded_instructions(&previous);
        let tip = manifest.commit.clone().unwrap_or_default();
        let keys: BTreeSet<&String> = previous.items.keys().chain(manifest.items.keys()).collect();
        for key in keys {
            let (before, after) = (previous.items.get(key), manifest.items.get(key));
            if before == after {
                continue;
            }
            let Some((prefix, name)) = key.split_once('/') else { continue };
            let kind = ItemKind::from_prefix(prefix);
            // Only for a manifest that predates them: once a build has recorded
            // the two files, one appearing on the branch really is new and is
            // announced (an `AGENTS.md` a teammate adds must not go quiet).
            if kind == ItemKind::Instructions && !knew_instructions {
                continue;
            }
            let action = match (before, after) {
                (None, Some(_)) => "added",
                (Some(_), None) => "removed",
                _ => "changed",
            };
            let title = manifest
                .titles
                .get(key)
                .or_else(|| previous.titles.get(key))
                .cloned()
                .unwrap_or_else(|| name.to_string());
            // Over the paths this drain did **not** write, for an item it copied:
            // the change being announced is the one somebody else made to the
            // source root, and the newest commit on the destination is this Mac's
            // own (review 2).
            let looked_up = copied_sources
                .get(key)
                .cloned()
                .unwrap_or_else(|| kind.repo_paths(name));
            // GH #144: both halves of the same commit. Splitting them would let
            // the row name an author with somebody else's time.
            let change = newest_change(git, &tip, &looked_up);
            report.updates.push(LibraryUpdate {
                kind,
                name: name.to_string(),
                title,
                action: action.to_string(),
                author: change.as_ref().map(|(author, _)| author.clone()),
                changed_at: change.map(|(_, at)| at),
            });
        }
    }
    Ok(report)
}

#[cfg(test)]
#[path = "shared_library_sync_tests.rs"]
mod tests;
