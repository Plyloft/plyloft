//! Reconcile a GitHub-Issues-backed kanban board against the live issues
//! (Cycle 3, increment 3a). Split in two:
//!
//!   - a **pure planner** [`reconcile_plan`] that diffs a slice of [`GhIssue`]s
//!     against the local cards and returns the [`ReconcileAction`]s to apply,
//!     plus the issue numbers that have vanished from GitHub. Pure ⇒ the whole
//!     conflict policy is unit-testable without `gh` or a real board.
//!   - an impure **applier** [`reconcile`] that does push-then-pull: first
//!     retries any `sync_pending` cards (so an unpushed local edit is mirrored
//!     before we pull), then runs the planner and applies it through the
//!     granular [`KanbanStore`] methods (never a whole-board write — the
//!     v1.33.0 data-loss rule).
//!
//! Conflict policy (decisions 4/8/10/12):
//!   - GitHub owns `title`, `notes`, `knowledge`, `gh_raw_remainder`,
//!     `gh_assignees`, `gh_author`, `gh_claim`, and the column (via labels/state). Local owns everything else (run state,
//!     worktree, ship, review, `archived`, `linked_*`).
//!   - A `sync_pending` card is **skipped** on pull — its unpushed local edit
//!     is never clobbered. Its assignees still refresh: Ply never pushes them.
//!   - A `gh_labels_pending` card (a status-label push failed) gets only its
//!     labels re-pushed, then pulls normally: its cached title and body are
//!     never written over newer issue edits.
//!   - A card with no matching issue is **kept**, never deleted (its number is
//!     reported in `missing`). 1.175.0 (TM-5): only when the read was whole,
//!     or GitHub answered that it has no such issue ([`read_issues`]).
//!   - The column of an **active** card (live swarm / running / has worktree)
//!     is **not** pulled — we don't yank the rug from under a run.
//!   - 1.173.0 (C1): a card's area travels as its area's label
//!     ([`AreaLabels`]). It goes up only while the card's area differs from
//!     the label this Mac last saw on the issue (`gh_area_label`); otherwise
//!     the issue's label decides on the pull — a label a person removed
//!     leaves the card with no area, so it asks (B3).

use crate::github::{self, GhIssue};
use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore, LastRunStatus};

/// One change the applier must make to the local board to match GitHub.
#[derive(Debug, Clone)]
pub enum ReconcileAction {
    /// An issue with no local card → create one. Boxed: `KanbanCard` is large.
    Create(Box<KanbanCard>),
    /// An issue whose local card differs on a GitHub-owned field → patch it.
    /// `column_id: None` means leave the column alone (active-card protection).
    Patch {
        card_id: String,
        title: String,
        notes: Option<String>,
        knowledge: Option<String>,
        gh_raw_remainder: Option<String>,
        column_id: Option<KanbanColumnId>,
        gh_assignees: Vec<String>,
        /// N14 (item 6): the issue's author; `None` leaves the card's as it is.
        gh_author: Option<String>,
        /// 1.173.0 (C2): the claim marker the issue body carries now.
        gh_claim: Option<crate::device_claim::DeviceClaim>,
        /// 1.173.0 (C1): the area the issue's label says; `None` leaves the
        /// card's area as it is.
        area: Option<AreaPull>,
        /// 1.175.0 (B3): where the issue's text comes from, when this read
        /// said it; `None` leaves what the card recorded.
        origin: Option<crate::issue_text::Origin>,
        /// 1.175.0 (D3): the card's open questions as they stand after this
        /// read (one answered by itself, one whose GitHub value changed);
        /// `None` leaves them. The part a question is about isn't pulled:
        /// `title` / `notes` then carry the card's own.
        edit_conflicts: Option<Vec<crate::issue_edit::EditConflict>>,
    },
    /// GH #66: only the assignees (N14: or the author) changed on a card
    /// whose other fields the pull must leave alone (`sync_pending`).
    SetAssignees {
        card_id: String,
        gh_assignees: Vec<String>,
        /// N14 (item 6): `None` leaves the card's author as it is.
        gh_author: Option<String>,
        /// 1.173.0 (C2): the claim marker, never pushed by Sync either.
        gh_claim: Option<crate::device_claim::DeviceClaim>,
        /// 1.175.0 (B3): as in `Patch`.
        origin: Option<crate::issue_text::Origin>,
    },
}

/// The output of [`reconcile_plan`]: the actions to apply plus the issue
/// numbers of local cards that no longer exist on GitHub (kept, not deleted).
#[derive(Debug, Clone, Default)]
pub struct ReconcilePlan {
    pub actions: Vec<ReconcileAction>,
    pub missing: Vec<u64>,
    /// Ids of cards that adopted an unmarked issue body as notes: after the
    /// actions apply, their issue body is rewritten with the marker block
    /// (once — the next parse finds the markers and adopts nothing).
    pub write_back: Vec<String>,
    /// 1.173.0 (C1): other listed areas' labels to take off an issue whose
    /// card's area is the one read: (card id, issue number, labels). Only
    /// Sync sends them.
    pub extra_area_labels: Vec<ExtraAreaLabels>,
}

/// 1.173.0 (C1): other listed areas' labels on the issue of a card whose
/// area is `area` (see [`ReconcilePlan::extra_area_labels`]).
#[derive(Debug, Clone, PartialEq)]
pub struct ExtraAreaLabels {
    pub card_id: String,
    pub number: u64,
    pub area: String,
    pub labels: Vec<String>,
}

/// What the applier did, returned to the IPC layer for the FE.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileSummary {
    pub created: usize,
    pub patched: usize,
    pub missing: Vec<u64>,
    /// What the pass did to the local target branch (fast-forward to the
    /// fetched origin, or why not). Set by the IPC layer, which knows the
    /// workspace checkout; `None` when it couldn't be resolved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_branch: Option<crate::worktrees::LocalBranchReport>,
    /// Card worktrees whose branch is merged into the fetched origin and
    /// that the pass moved to `.trash/` (branch deleted). Set by the IPC
    /// layer, like `local_branch`.
    pub pruned_worktrees: usize,
    /// Merged card worktrees the pass kept (dirty, busy, …), with why.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub kept_merged_worktrees: Vec<crate::worktrees::KeptWorktree>,
    /// Bytes the pass's trash sweep freed: build caches stripped from
    /// `.plyloft-worktrees/.trash/` (and legacy `.atelier-worktrees/.trash/`) entries plus expired entries. Set by the
    /// IPC layer, like `local_branch`.
    pub trash_freed_bytes: u64,
    /// 1.173.0 (C1): cards whose area label didn't reach their issue this
    /// pass (each card's page says so; the next Sync tries again).
    pub area_labels_failed: usize,
}

/// What [`push_local`] did — for the "push N existing cards?" flip flow.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushSummary {
    pub pushed: usize,
    pub failed: usize,
    /// 1.173.0 (C1): issues made whose area label didn't go on.
    pub area_labels_failed: usize,
}

/// A card with a live or in-flight run whose column must not be pulled back by
/// a remote label edit (decision 12). A worktree counts only while its
/// directory exists: a handle left on a deleted worktree protects nothing.
fn card_is_active(card: &KanbanCard) -> bool {
    card.linked_swarm_id.is_some()
        || card.last_run_status == Some(LastRunStatus::Running)
        || card
            .worktree_path
            .as_deref()
            .is_some_and(|p| std::path::Path::new(p).exists())
}

/// Clear the worktree handle of every card in `workspace_id` whose
/// `worktree_path` is gone from disk and from `git worktree list` in
/// `workspace_cwd` (see [`crate::worktrees::worktree_handle_is_dangling`]).
/// Only the three handle fields change; column and `archived` stay. Git
/// unreadable ⇒ nothing is cleared. Returns the healed card ids.
pub fn heal_dangling_worktree_handles(
    store: &KanbanStore,
    workspace_id: &str,
    workspace_cwd: &std::path::Path,
) -> Vec<String> {
    let cards = match store.load(workspace_id) {
        Ok(cards) => cards,
        Err(e) => {
            log::warn!("github_sync: dangling worktree heal skipped: {e}");
            return Vec::new();
        }
    };
    let missing: Vec<(String, String)> = cards
        .into_iter()
        .filter_map(|c| {
            let path = c.worktree_path?;
            (!std::path::Path::new(&path).exists()).then_some((c.id, path))
        })
        .collect();
    if missing.is_empty() {
        return Vec::new();
    }
    let registered = match crate::worktrees::registered_worktree_paths(workspace_cwd) {
        Ok(paths) => paths,
        Err(e) => {
            log::warn!("github_sync: dangling worktree heal skipped, git worktree list failed: {e}");
            return Vec::new();
        }
    };
    let mut healed = Vec::new();
    for (card_id, path) in missing {
        if !crate::worktrees::worktree_handle_is_dangling(std::path::Path::new(&path), &registered) {
            continue;
        }
        match store.clear_dangling_worktree_handle(workspace_id, &card_id, Some(&path)) {
            Ok(true) => {
                log::info!("github_sync: cleared {card_id}'s handle on missing worktree {path}");
                healed.push(card_id);
            }
            Ok(false) => {}
            Err(e) => log::warn!("github_sync: couldn't clear {card_id}'s dangling worktree: {e}"),
        }
    }
    healed
}

/// Deterministic id for a card that originates from a GitHub issue. Keyed on
/// the issue number so re-reconcile is idempotent even before the number is
/// persisted (belt-and-suspenders against a duplicate Create in a race).
pub fn gh_card_id(number: u64) -> String {
    format!("gh-issue-{number}")
}

/// 1.173.0 (C1): the colour of an area label: a calm neutral grey, so the
/// status labels keep the colour on the issue list.
pub const AREA_LABEL_COLOR: &str = "d0d7de";

/// 1.173.0 (C1): the repository's areas as a GitHub Issues board labels
/// them (`ResolvedArea.label`, default `area:<id>`). Empty without areas
/// (and while they are held with no good copy): then no card's area is
/// written or read.
#[derive(Debug, Clone, Default)]
pub struct AreaLabels {
    areas: Vec<crate::areas::ResolvedArea>,
}

impl AreaLabels {
    pub fn new(areas: Vec<crate::areas::ResolvedArea>) -> Self {
        Self { areas }
    }

    /// The workspace's areas, from this Mac's copy — none with fewer than
    /// two: one area is the repository as it always was, with no labels
    /// (UX: areas show with two or more).
    pub fn for_workspace(store: &crate::project_config::ProjectConfigStore, workspace_id: &str) -> Self {
        let branch = store.get(workspace_id).map(|c| c.target_branch).unwrap_or_default();
        let areas = crate::areas::for_workspace(store, workspace_id);
        if areas.len() < 2 {
            return Self::default();
        }
        Self::new(crate::areas::resolve(&areas, &branch))
    }

    pub fn is_empty(&self) -> bool {
        self.areas.is_empty()
    }

    fn area(&self, id: &str) -> Option<&crate::areas::ResolvedArea> {
        self.areas.iter().find(|a| a.id == id)
    }

    /// The label of the listed area `id`.
    pub fn label_of(&self, id: &str) -> Option<&str> {
        self.area(id).map(|a| a.label.as_str())
    }
}

/// 1.173.0 (C1): what an issue's labels say about its card's area.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IssueArea {
    /// The listed area whose label the issue has.
    pub area: Option<String>,
    /// The area label as GitHub spells it — also an `area:…` label no
    /// listed area has (then `area` is `None` and the card names it).
    pub label: Option<String>,
    /// The other listed areas' labels on the issue (two Macs chose at
    /// once): Sync takes them off once the card's area is the one read.
    pub extra: Vec<String>,
}

/// 1.173.0 (C1): what a pull does to a card's area, with what the plan saw
/// on the card, so a choice made meanwhile is never overwritten.
#[derive(Debug, Clone, PartialEq)]
pub struct AreaPull {
    pub seen_area: Option<String>,
    pub seen_label: Option<String>,
    pub area: Option<String>,
    pub label: Option<String>,
}

/// Whether `name` looks like an area label nobody listed: `area:…`.
fn looks_like_area_label(name: &str) -> bool {
    name.trim().get(..5).is_some_and(|p| p.eq_ignore_ascii_case("area:"))
}

/// The labels a card's `gh_area_label` holds: one, or — when its issue
/// had several listed areas' labels and Plyloft couldn't tell which is
/// meant — each of them, joined by commas (a listed label has none).
pub fn seen_area_labels(card: &KanbanCard) -> Vec<String> {
    card.gh_area_label
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

/// 1.173.0 (C1): the issue's area, read for a card that last saw `seen`
/// there:
/// - one listed area's label: that area;
/// - two, one of them `seen`: the other — the newer change, a person's or
///   the other Mac's — with `seen` to take off (`extra`);
/// - otherwise (a new issue, `seen` not among them, three or more): no
///   area and nothing taken off; `label` holds them all, so the card asks
///   naming them and the choice takes the others off;
/// - none: an unrecognised `area:…` label, with no area.
pub fn area_from_issue(issue: &GhIssue, labels: &AreaLabels, seen: &[String]) -> IssueArea {
    let on_issue = |area: &crate::areas::ResolvedArea| {
        issue.labels.iter().find(|l| l.name.trim().eq_ignore_ascii_case(&area.label)).map(|l| l.name.trim().to_string())
    };
    let listed: Vec<(String, String)> = labels.areas.iter().filter_map(|a| on_issue(a).map(|l| (a.id.clone(), l))).collect();
    let was_seen = |l: &str| seen.len() == 1 && seen[0].eq_ignore_ascii_case(l);
    match listed.as_slice() {
        [] => {
            let unknown = issue.labels.iter().find(|l| looks_like_area_label(&l.name));
            IssueArea { area: None, label: unknown.map(|l| l.name.trim().to_string()), extra: Vec::new() }
        }
        [(id, label)] => IssueArea { area: Some(id.clone()), label: Some(label.clone()), extra: Vec::new() },
        [a, b] if was_seen(&a.1) != was_seen(&b.1) => {
            let (old, new) = if was_seen(&a.1) { (a, b) } else { (b, a) };
            IssueArea { area: Some(new.0.clone()), label: Some(new.1.clone()), extra: vec![old.1.clone()] }
        }
        many => IssueArea {
            area: None,
            label: Some(many.iter().map(|(_, l)| l.as_str()).collect::<Vec<_>>().join(",")),
            extra: Vec::new(),
        },
    }
}

/// 1.173.0 (C1): the area label `card`'s issue still needs, and the ones
/// it replaces: `None` when there is nothing to send — no areas, a card that
/// never chooses one (`card_area::exempt`: a skill card, a pull request
/// review, `"default"`), a card with no area or an unlisted one, or one
/// whose issue already has its label as far as this Mac knows.
pub fn area_label_to_push(card: &KanbanCard, labels: &AreaLabels) -> Option<(String, Vec<String>)> {
    if labels.is_empty() || crate::card_area::exempt(card) {
        return None;
    }
    let wanted = labels.label_of(&crate::card_area::inherited_area(card)?)?;
    let seen = seen_area_labels(card);
    if matches!(seen.as_slice(), [only] if only.eq_ignore_ascii_case(wanted)) {
        return None;
    }
    // Every other label it saw there comes off (one, or all of those it
    // asked about).
    let replaced = seen.into_iter().filter(|l| !l.eq_ignore_ascii_case(wanted)).collect();
    Some((wanted.to_string(), replaced))
}

/// What the pull reads for an existing card's area, before comparing:
/// `None` leaves it — no areas, an exempt card, a card that is over (Done
/// or archived), or one whose own area hasn't reached its issue yet
/// ([`area_label_to_push`]).
fn area_read(card: &KanbanCard, issue: &GhIssue, labels: &AreaLabels) -> Option<IssueArea> {
    if labels.is_empty()
        || crate::card_area::exempt(card)
        || card.column_id == KanbanColumnId::Complete
        || card.archived
        || area_label_to_push(card, labels).is_some()
    {
        return None;
    }
    let mut pulled = area_from_issue(issue, labels, &seen_area_labels(card));
    if let Some(id) = pulled.area.clone() {
        // A card whose area can no longer change here (B3 `can_set`: it
        // started, or left Not started) never takes another one from its
        // issue: it loses its area and asks, offered the areas that fit.
        let has_listed = card.area.as_deref().is_some_and(|a| labels.area(a).is_some());
        let locked = crate::card_area::started(card) || card.column_id != KanbanColumnId::Todo;
        let other = card.area.as_deref() != Some(id.as_str());
        // A started card's copy was cut from one branch: an area whose cards
        // go elsewhere would ship it there.
        let misfit = labels.area(&id).is_some_and(|area| !crate::card_area::area_fits(card, area));
        if (has_listed && locked && other) || misfit {
            // It asks, naming what its issue has; its choice takes the
            // others off.
            let mut all = pulled.extra.clone();
            all.extend(pulled.label.clone());
            pulled.area = None;
            pulled.label = Some(all.join(","));
            pulled.extra.clear();
        }
    }
    Some(pulled)
}

/// What the pull does to an existing card's area ([`area_read`]), when it
/// changes anything.
fn area_pull(card: &KanbanCard, read: &IssueArea) -> Option<AreaPull> {
    (read.area != card.area || read.label != card.gh_area_label).then(|| AreaPull {
        seen_area: card.area.clone(),
        seen_label: card.gh_area_label.clone(),
        area: read.area.clone(),
        label: read.label.clone(),
    })
}

/// The column the issue's labels say. G4 (launch D8): a card the reconcile
/// moves into In Progress leaves a swarm template that never ran behind, so
/// the queue pump starts no new swarm for it.
fn set_reconciled_column(card: &mut KanbanCard, col: KanbanColumnId) {
    if col == KanbanColumnId::InProgress && card.column_id != KanbanColumnId::InProgress {
        crate::kanban::drop_unstarted_swarm_template(card);
    }
    card.column_id = col;
}

/// Pure: diff `issues` against `local` and return the actions to apply.
/// Cards are matched on `gh_issue_number`. See the module docs for the policy.
#[cfg(test)]
pub fn reconcile_plan(issues: &[GhIssue], local: &[KanbanCard]) -> ReconcilePlan {
    reconcile_plan_with(issues, local, &AreaLabels::default())
}

/// [`reconcile_plan`] in a repository with areas: a new card takes the
/// area its issue's label says, and an existing one follows its issue's
/// label unless its own area is still on its way up (C1).
pub fn reconcile_plan_with(issues: &[GhIssue], local: &[KanbanCard], labels: &AreaLabels) -> ReconcilePlan {
    let mut actions = Vec::new();

    let mut write_back = Vec::new();
    let mut extra_area_labels = Vec::new();

    for issue in issues {
        let column = github::column_from_issue(issue);
        let assignees = github::assignee_logins(issue);
        let author = github::author_login(issue);
        let existing = local.iter().find(|c| c.gh_issue_number == Some(issue.number));
        // 1.175.0 (B3): while the last hand on the text was outside the
        // repository, Plyloft's marks in it — the claim marker, the notes
        // and knowledge blocks — are text like any other. From what this
        // read said of the issue, else what the card recorded; unknown, the
        // marks count as before.
        let from_outside = written_outside(issue, existing);
        let parsed = crate::issue_text::parse_body(&issue.body, from_outside);
        let claim = crate::issue_text::claim_in(&issue.body, from_outside);

        // An unmarked body (issue filed on GitHub, not through Ply) becomes
        // the brief of a card with no notes yet. The applier then writes the
        // marker block around it, so the next pull parses it as notes. A
        // closed issue is history: its body is never rewritten, so adopting
        // without the write-back would flip back on the next pull.
        //
        // QoL 14.1: the Board's read-only refresh applies this plan without
        // the write-back. The card it adopted for is then recognised here
        // (`already_adopted`: its notes are the unmarked body), so no pull
        // flips the brief back, and the next Sync still writes the markers.
        let closed = issue.state.eq_ignore_ascii_case("closed");
        let adopted = match existing {
            Some(card) if card.sync_pending => None,
            // B3: an outsider's text is the brief, all of it, whatever the
            // card held; the write-back then wraps it as any adopted text.
            _ if from_outside => parsed
                .raw_remainder
                .clone()
                .map(|text| (github::ParsedIssueBody { notes: Some(text), knowledge: None, raw_remainder: None }, !closed)),
            Some(card) if closed => already_adopted(&parsed, card).map(|p| (p, false)),
            Some(card) => github::adopt_unmarked_body(&parsed, card.notes.as_deref())
                .or_else(|| already_adopted(&parsed, card))
                .map(|p| (p, true)),
            None if closed => None,
            None => github::adopt_unmarked_body(&parsed, None).map(|p| (p, true)),
        };
        if let Some((_, true)) = adopted {
            write_back.push(
                existing.map(|c| c.id.clone()).unwrap_or_else(|| gh_card_id(issue.number)),
            );
        }
        let parsed = adopted.map(|(p, _)| p).unwrap_or(parsed);

        match existing {
            None => {
                // v1.77.0: a CLOSED issue with no local card is history, not
                // work — don't resurrect it. This is what makes the card-delete
                // flow ("close the issue, then delete locally") stick across
                // reconciles, and it keeps a fresh clone's board from being
                // flooded with every closed issue ever. Reopening the issue on
                // GitHub recreates the card (the recovery path for a wrong
                // delete). Closed issues that DO have a local card still pull
                // to Complete via the Patch branch below (decision v1.57).
                if issue.state.eq_ignore_ascii_case("closed") {
                    continue;
                }
                // Skills hub H3a (Windows walk): a skill card's issue is the
                // card of the Mac that made it — its one commit lives in that
                // Mac's worktree. Another board makes no card for it, so
                // nobody can start a build on it ("on its way" shows only on
                // the Mac that holds the card, R2).
                if github::is_skill_card_issue(issue) {
                    continue;
                }
                // No local card for this issue → create one.
                let id = gh_card_id(issue.number);
                let mut card = KanbanCard::new(
                    id,
                    // workspace_id is filled in by the applier, which knows it;
                    // the planner is workspace-agnostic. Use a placeholder the
                    // applier overwrites.
                    String::new(),
                    issue.title.clone(),
                    parsed.notes.clone(),
                    column,
                );
                card.knowledge = parsed.knowledge.clone();
                card.gh_issue_number = Some(issue.number);
                card.gh_raw_remainder = parsed.raw_remainder.clone();
                // U10: the card is as old as its issue, not as this read.
                if let Some(at) = github::rfc3339_ms(issue.created_at.as_deref()) {
                    card.created_at = at;
                }
                card.gh_assignees = assignees;
                card.gh_author = author;
                card.gh_claim = claim;
                if let Some(origin) = issue.origin.clone() {
                    card.gh_author_association = origin.association;
                    card.gh_last_editor = origin.editor;
                }
                if !labels.is_empty() {
                    let pulled = area_from_issue(issue, labels, &[]);
                    if let (Some(area), false) = (&pulled.area, pulled.extra.is_empty()) {
                        extra_area_labels.push(ExtraAreaLabels {
                            card_id: card.id.clone(),
                            number: issue.number,
                            area: area.clone(),
                            labels: pulled.extra.clone(),
                        });
                    }
                    card.area = pulled.area;
                    card.gh_area_label = pulled.label;
                }
                actions.push(ReconcileAction::Create(Box::new(card)));
            }
            Some(card) => {
                let assignees_changed = card.gh_assignees != assignees;
                // N14 (item 6): an answer without an author never clears the
                // one recorded.
                let author = author.filter(|a| card.gh_author.as_deref() != Some(a.as_str()));
                let author_changed = author.is_some();
                let claim_changed = card.gh_claim != claim;
                // B3: only what this read said; silence changes nothing.
                let origin = issue
                    .origin
                    .clone()
                    .filter(|o| card.gh_author_association != o.association || card.gh_last_editor != o.editor);
                // A card mid-push keeps its unsynced local edit — skip it so
                // the pull can't clobber an unpushed change (decision 8).
                // Assignees are never pushed, so they still follow GitHub.
                if card.sync_pending {
                    if assignees_changed || author_changed || claim_changed || origin.is_some() {
                        actions.push(ReconcileAction::SetAssignees {
                            card_id: card.id.clone(),
                            gh_assignees: assignees,
                            gh_author: author,
                            gh_claim: claim,
                            origin,
                        });
                    }
                    continue;
                }
                // 1.175.0 (D3): a part the card asks a question about stays
                // as the member wrote it; the question follows GitHub.
                let asked = crate::issue_edit::kept_on_pull(
                    card,
                    &issue.title,
                    github::adopt_unmarked_body(&parsed, None).as_ref().unwrap_or(&parsed).notes.as_deref(),
                    issue.origin.as_ref().and_then(|o| o.editor.as_deref()),
                    github::rfc3339_ms(Some(issue.updated_at.as_str())),
                );
                let pulled_title = asked.title.clone().unwrap_or_else(|| issue.title.clone());
                let pulled_notes = asked.notes.clone().unwrap_or_else(|| parsed.notes.clone());
                let title_changed = card.title != pulled_title;
                let notes_changed = card.notes != pulled_notes;
                let knowledge_changed = card.knowledge != parsed.knowledge;
                let remainder_changed = card.gh_raw_remainder != parsed.raw_remainder;
                // The column of an active card is never pulled (decision 12),
                // nor one whose own status label has not reached GitHub yet.
                // Skills hub H3a (Windows walk): nor a skill card's — it
                // lives in Complete from the moment it is made, and its issue
                // made before the kind label existed reads as Todo.
                let column_changed = card.column_id != column
                    && !card_is_active(card)
                    && !card.gh_labels_pending
                    && card.skill_card().is_none();
                let read = area_read(card, issue, labels);
                if let Some((read, area)) = read.as_ref().and_then(|r| r.area.clone().filter(|_| !r.extra.is_empty()).map(|a| (r, a))) {
                    extra_area_labels.push(ExtraAreaLabels {
                        card_id: card.id.clone(),
                        number: issue.number,
                        area,
                        labels: read.extra.clone(),
                    });
                }
                let area = read.as_ref().and_then(|r| area_pull(card, r));

                if title_changed
                    || notes_changed
                    || knowledge_changed
                    || remainder_changed
                    || column_changed
                    || assignees_changed
                    || author_changed
                    || claim_changed
                    || area.is_some()
                    || origin.is_some()
                    || asked.conflicts.is_some()
                {
                    actions.push(ReconcileAction::Patch {
                        card_id: card.id.clone(),
                        title: pulled_title,
                        notes: pulled_notes,
                        knowledge: parsed.knowledge.clone(),
                        gh_raw_remainder: parsed.raw_remainder.clone(),
                        column_id: column_changed.then_some(column),
                        gh_assignees: assignees,
                        gh_author: author,
                        gh_claim: claim,
                        area,
                        origin,
                        edit_conflicts: asked.conflicts,
                    });
                }
            }
        }
    }

    // Local cards whose backing issue has vanished from GitHub → keep them,
    // just report the number so the FE can flag "issue missing" (decision 4).
    let live: std::collections::HashSet<u64> = issues.iter().map(|i| i.number).collect();
    let missing = local
        .iter()
        .filter_map(|c| c.gh_issue_number)
        .filter(|n| !live.contains(n))
        .collect();

    ReconcilePlan {
        actions,
        missing,
        write_back,
        extra_area_labels,
    }
}

/// 1.175.0 (B3): whether the last hand on `issue`'s text was outside the
/// repository — from what this read said of it (`issue.origin`), else from
/// what its card recorded at an earlier read. Unknown: no.
fn written_outside(issue: &GhIssue, card: Option<&KanbanCard>) -> bool {
    let author = github::author_login(issue).or_else(|| card.and_then(|c| c.gh_author.clone()));
    let recorded = card.filter(|c| c.gh_author_association.is_some()).map(|c| crate::issue_text::Origin {
        association: c.gh_author_association.clone(),
        editor: c.gh_last_editor.clone(),
    });
    match issue.origin.as_ref().or(recorded.as_ref()) {
        Some(origin) => crate::issue_text::written_outside(author.as_deref(), origin.association.as_deref(), origin.editor.as_deref()),
        None => false,
    }
}

/// QoL 14.1: an unmarked issue body that the card already holds as its notes
/// (adopted by a refresh, whose marker write-back waits for the next Sync).
fn already_adopted(parsed: &github::ParsedIssueBody, card: &KanbanCard) -> Option<github::ParsedIssueBody> {
    if parsed.notes.is_some() || parsed.knowledge.is_some() {
        return None;
    }
    let remainder = parsed.raw_remainder.as_deref()?.trim();
    let notes = card.notes.as_deref()?.trim();
    (!notes.is_empty() && notes == remainder).then(|| github::ParsedIssueBody {
        notes: card.notes.clone(),
        knowledge: None,
        raw_remainder: None,
    })
}

/// Skills hub H3a (Windows walk): what a Sync owes the issue a skill card of
/// this board created (§4.2; R2 edge "Board backed by GitHub Issues").
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillIssueTidy {
    /// The card shipped and its issue is still open: close it, so no board
    /// keeps it as open work.
    Close { card_id: String, number: u64 },
    /// The open issue lacks [`github::SKILL_CARD_LABEL`] (made before the
    /// label existed, or its label push failed): push the card's labels.
    Label { card_id: String, number: u64 },
}

/// Pure: the [`SkillIssueTidy`] steps for `local`'s skill cards against the
/// live `issues`. Only a card that is still a skill card here and carries the
/// issue's number counts — the issue is the one that card created, never an
/// issue someone else filed. A closed or vanished issue needs nothing.
pub fn skill_issue_tidy(issues: &[GhIssue], local: &[KanbanCard]) -> Vec<SkillIssueTidy> {
    local
        .iter()
        .filter(|card| card.skill_card().is_some())
        .filter_map(|card| {
            let number = card.gh_issue_number?;
            let issue = issues.iter().find(|i| i.number == number)?;
            if issue.state.eq_ignore_ascii_case("closed") {
                return None;
            }
            let card_id = card.id.clone();
            // 1.174.0 A2 round 1: once it landed — not while its pull
            // request is open.
            if crate::kanban::card_landed(card) {
                Some(SkillIssueTidy::Close { card_id, number })
            } else if !github::is_skill_card_issue(issue) {
                Some(SkillIssueTidy::Label { card_id, number })
            } else {
                None
            }
        })
        .collect()
}

/// U33: how many closed issues' status labels one Sync brings in line. A mature
/// board's first open would otherwise do hundreds of `gh issue edit`, one by one,
/// on every member's computer; the rest go on later Syncs.
pub const CLOSED_LABEL_TIDY_PER_SYNC: usize = 25;

/// U33: the cards in Done whose issue is closed but still says another Plyloft
/// status (`status:in-progress` after a merge whose "Closes #N" closed it): the
/// same status-label mirror as any move to Done, newest issues first, at most
/// [`CLOSED_LABEL_TIDY_PER_SYNC`]. An issue with no Plyloft status label is left
/// alone (the mirror only ever touches those), and so is one closed as not
/// planned: "done" isn't what happened. A card still active here keeps its
/// column, so it isn't listed; a skill card has its own tidy above. The assignee
/// stays as GitHub has it.
pub fn closed_status_labels_to_tidy(issues: &[GhIssue], local: &[KanbanCard]) -> Vec<(String, u64)> {
    let done = github::label_for_column(&KanbanColumnId::Complete);
    issues
        .iter()
        .filter(|i| {
            i.state.eq_ignore_ascii_case("closed")
                && !i.state_reason.as_deref().is_some_and(|r| r.eq_ignore_ascii_case("NOT_PLANNED"))
                && i.labels.iter().any(|l| l.name != done && github::STATUS_LABELS.iter().any(|(name, _)| *name == l.name))
        })
        .filter_map(|i| {
            local
                .iter()
                .find(|c| c.gh_issue_number == Some(i.number))
                .filter(|c| c.column_id == KanbanColumnId::Complete && !c.gh_labels_pending && !c.sync_pending)
                .filter(|c| c.skill_card().is_none())
                .map(|c| (c.id.clone(), i.number))
        })
        .take(CLOSED_LABEL_TIDY_PER_SYNC)
        .collect()
}

/// U33 (owner, 2026-11-03): the status-label writes a Sync's retry and tidy make
/// together. 1.175.0 (D2-a): the retries that take the member's own name off
/// the issues of cards they left (`leave_issue::retry_pending`) come out of
/// the same 25, first. A refused write stays pending, so without this a board GitHub keeps
/// refusing would add 25 more to the retries on every Sync.
pub const LABEL_WRITES_PER_SYNC: usize = 25;

/// U33: what the tidy may still write after a Sync's label retries. Only when
/// every retry failed is GitHub refusing, with no new tidy on top of it; one card
/// that's stuck for good mustn't stop the tidy on every Sync.
fn label_writes_after_retries(budget: usize, retried: usize, failed: usize) -> usize {
    if retried > 0 && failed == retried {
        0
    } else {
        budget
    }
}

/// The cards whose status label is still owed to GitHub, newest issues first, at
/// most [`LABEL_WRITES_PER_SYNC`]; the rest go on later Syncs.
pub fn pending_label_retries(local: &[KanbanCard]) -> Vec<(String, u64)> {
    let mut due: Vec<(String, u64)> = local
        .iter()
        .filter(|c| c.gh_labels_pending && !c.sync_pending)
        .filter_map(|c| c.gh_issue_number.map(|number| (c.id.clone(), number)))
        .collect();
    due.sort_by_key(|(_, number)| std::cmp::Reverse(*number));
    due.truncate(LABEL_WRITES_PER_SYNC);
    due
}

/// Skills hub H3a (Windows walk): right after a Ship lands a skill card,
/// close the issue that card created. Best-effort: a failure is left to the
/// next Sync's [`skill_issue_tidy`]. Anything that is not a landed skill card
/// with an issue is left alone.
pub fn close_landed_skill_card_issue(
    store: &KanbanStore,
    repo: &str,
    workspace_id: &str,
    card_id: &str,
) {
    let Ok(card) = store.get_card(workspace_id, card_id) else {
        return;
    };
    let Some(number) = card.gh_issue_number else {
        return;
    };
    if card.skill_card().is_none() || !crate::kanban::card_landed(&card) {
        return;
    }
    if let Err(e) = github::issue_close(repo, number) {
        log::warn!("github_sync: closing shipped skill card's {repo}#{number} failed (Sync retries): {e}");
    }
}

/// Serializes every status-label write (Start build, Resume, a column move,
/// Sync's retry). Each write reads the card's column **under the lock**, so the
/// last write to finish is always for the newest column. A slow Resume can't
/// land `status:in-progress` after a move to Todo that came later.
static STATUS_LABEL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// GH #81: one issue-creating or pulling pass per workspace at a time. A
/// reconcile that lists issues while [`push_local`] is between creating an
/// issue and stamping its number on the card would create a second card for
/// it; the board's reconcile-on-open runs exactly then, when a Share or a
/// board switch flips the workspace to GitHub Issues. A new card's own issue
/// creation takes it too, so a migration never sees it between its save and
/// its number.
static BOARD_PASS_LOCKS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<()>>>>,
> = std::sync::LazyLock::new(Default::default);

pub(crate) fn board_pass_lock(workspace_id: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
    BOARD_PASS_LOCKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(workspace_id.to_string())
        .or_default()
        .clone()
}

/// GH #66: push the status label for the card's *current* column and record
/// whether GitHub has it (`gh_labels_pending`). The push is acknowledged only
/// if the column is still the one pushed. A move that lands mid-push keeps the
/// flag set, and that move's own push (queued behind this lock) or the next
/// Sync delivers it. Returns whether the pushed label is current on GitHub.
pub(crate) fn push_status_labels(
    store: &KanbanStore,
    repo: &str,
    workspace_id: &str,
    card_id: &str,
    number: u64,
) -> bool {
    push_status_labels_with(store, workspace_id, card_id, |add, remove| {
        match github::issue_set_labels(repo, number, add, remove) {
            // GH #81: the repo lacks a status label (its setup failed when the
            // board became GitHub Issues): create them and push once more, so
            // a Sync recovers instead of failing on the label forever.
            Err(e) if status_label_missing(&e) => {
                github::ensure_labels(repo, &github::STATUS_LABELS)?;
                if add.contains(&github::SKILL_CARD_LABEL.0) {
                    github::ensure_labels(repo, &[github::SKILL_CARD_LABEL])?;
                }
                github::issue_set_labels(repo, number, add, remove)
            }
            other => other,
        }
    })
}

/// `gh issue edit --add-label` refused because the label doesn't exist:
/// "'status:done' not found" (or the skill card's kind label).
pub(crate) fn status_label_missing(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("not found")
        && github::STATUS_LABELS
            .iter()
            .chain(std::iter::once(&github::SKILL_CARD_LABEL))
            .any(|(name, _)| lower.contains(name))
}

fn push_status_labels_with(
    store: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    set_labels: impl FnOnce(&[&str], &[&str]) -> Result<(), String>,
) -> bool {
    let _serial = STATUS_LABEL_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (column, skill_card) = match store.get_card(workspace_id, card_id) {
        Ok(card) => (card.column_id.clone(), card.skill_card().is_some()),
        Err(e) => {
            log::warn!("github_sync: status labels for '{card_id}' skipped: {e}");
            return false;
        }
    };
    let (mut add, remove) = github::labels_for_move(&column);
    // Skills hub H3a (Windows walk): a skill card's issue says what it is on
    // every label push, so other boards never read it as work to start.
    if skill_card {
        add.push(github::SKILL_CARD_LABEL.0);
    }
    let pushed = match set_labels(&add, &remove) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("github_sync: status labels for card '{card_id}' failed: {e}");
            false
        }
    };
    let current = store
        .get_card(workspace_id, card_id)
        .is_ok_and(|c| c.column_id == column);
    let delivered = pushed && current;
    let _ = store.set_gh_labels_pending(workspace_id, card_id, !delivered);
    delivered
}

/// 1.173.0 (C1): put the card's area label on its issue `number`, taking
/// off the one this Mac last saw there ([`area_label_to_push`]). Nothing is
/// sent when the issue already has it, so pushing again (Sync, the other
/// Mac with the same login) changes nothing. A repository without the label
/// gets it (`gh label create --force`, [`AREA_LABEL_COLOR`]) and the push
/// goes once more. A failure changes nothing on the card: the label is
/// still due, and the next Sync sends it.
pub(crate) fn push_area_label(
    store: &KanbanStore,
    repo: &str,
    workspace_id: &str,
    card_id: &str,
    number: u64,
    labels: &AreaLabels,
) -> AreaPush {
    push_area_label_with(
        store,
        workspace_id,
        card_id,
        labels,
        |add, remove| github::issue_set_labels(repo, number, add, remove),
        |name| github::ensure_labels(repo, &[(name, AREA_LABEL_COLOR)]),
    )
}

/// `gh issue edit` refused a label that doesn't exist in the repository:
/// "'area:site' not found" — the name quoted, as gh prints it.
fn label_not_found(err: &str, name: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("not found") && lower.contains(&format!("'{}'", name.to_lowercase()))
}

/// 1.173.0 (C1): cards of this session whose area label didn't reach
/// GitHub (workspace, card): the card page says so until a push lands.
static AREA_LABEL_FAILED: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<(String, String)>>> =
    std::sync::LazyLock::new(Default::default);

pub(crate) fn note_area_label(workspace_id: &str, card_id: &str, failed: bool) {
    let mut set = AREA_LABEL_FAILED.lock().unwrap_or_else(|p| p.into_inner());
    let key = (workspace_id.to_string(), card_id.to_string());
    if failed {
        set.insert(key);
    } else {
        set.remove(&key);
    }
}

/// Whether the card's area label failed to reach GitHub in this session
/// (and nothing has delivered it since).
pub fn area_label_failed(workspace_id: &str, card_id: &str) -> bool {
    AREA_LABEL_FAILED
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(&(workspace_id.to_string(), card_id.to_string()))
}

/// What [`push_area_label`] did.
#[derive(Debug, Clone, PartialEq)]
pub enum AreaPush {
    /// Nothing was due.
    NothingDue,
    /// `added` went on the issue and `removed` came off.
    Sent { added: String, removed: Vec<String> },
    /// GitHub didn't take it: still due.
    Failed,
}

fn push_area_label_with(
    store: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    labels: &AreaLabels,
    mut set_labels: impl FnMut(&[&str], &[&str]) -> Result<(), String>,
    mut create_label: impl FnMut(&str) -> Result<(), String>,
) -> AreaPush {
    // Every label write of a card is serialized (see STATUS_LABEL_LOCK).
    let _serial = STATUS_LABEL_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let card = match store.get_card(workspace_id, card_id) {
        Ok(card) => card,
        Err(e) => {
            log::warn!("github_sync: area label for '{card_id}' skipped: {e}");
            return AreaPush::NothingDue;
        }
    };
    let Some((add, replaced)) = area_label_to_push(&card, labels) else {
        return AreaPush::NothingDue;
    };
    let mut remove: Vec<&str> = replaced.iter().map(String::as_str).collect();
    let mut pushed = set_labels(&[&add], &remove);
    let mut created = false;
    // Each refusal names one missing label: the new one is created (once),
    // and one it replaced that was deleted from the repository meanwhile
    // isn't asked to come off (the issue can't have it). Neither: stop.
    while let Err(e) = &pushed {
        if !created && label_not_found(e, &add) {
            created = true;
            if let Err(e) = create_label(&add) {
                pushed = Err(e);
                break;
            }
        } else if let Some(gone) = remove.iter().position(|old| label_not_found(e, old)) {
            remove.remove(gone);
        } else {
            break;
        }
        pushed = set_labels(&[&add], &remove);
    }
    if let Err(e) = pushed {
        log::warn!("github_sync: area label for card '{card_id}' failed (Sync retries): {e}");
        note_area_label(workspace_id, card_id, true);
        return AreaPush::Failed;
    }
    note_area_label(workspace_id, card_id, false);
    // The issue has `add` now, whatever the card says meanwhile: an area
    // changed mid-push is still due, and its push takes `add` off.
    let _ = store.with_card(workspace_id, card_id, |c| {
        c.gh_area_label = Some(add.clone());
        Ok(())
    });
    let removed = remove.iter().map(|r| r.to_string()).collect();
    AreaPush::Sent { added: add, removed }
}

/// The issue as GitHub has it after `push` (the pass's listing is older).
fn after_area_push(issue: &mut GhIssue, push: &AreaPush) {
    if let AreaPush::Sent { added, removed } = push {
        issue.labels.retain(|l| !removed.iter().any(|r| r.eq_ignore_ascii_case(l.name.trim())));
        if !issue.labels.iter().any(|l| l.name.trim().eq_ignore_ascii_case(added)) {
            issue.labels.push(github::GhLabel { name: added.clone() });
        }
    }
}

/// Push one `sync_pending` card to GitHub: create the issue if it has no
/// number yet, else edit the body + status label. On success the caller clears
/// `sync_pending`. Returns the (possibly new) issue number on success.
///
/// GH #66: the label half goes through [`push_status_labels`]: serialized
/// with every other status write, for the column the card has *then*, not
/// this pass's snapshot, and recorded in `gh_labels_pending`. A body that
/// landed is not re-pushed because only its labels failed.
fn push_pending_card(
    store: &KanbanStore,
    repo: &str,
    workspace_id: &str,
    card: &KanbanCard,
) -> Result<u64, String> {
    match card.gh_issue_number {
        // GH #81: a new issue takes the card's column as its status label at
        // once, so the pull that follows never reads it back as Todo (a
        // failed label push stays `gh_labels_pending`).
        None => {
            let body = crate::device_claim::card_issue_body(card, None);
            let mut n = github::issue_create(repo, &card.id, &card.title, &body)?;
            // R2: `issue_create` may answer with an issue it found for an
            // earlier create of this card (one that timed out, or one whose
            // stamp was in a save that was lost). One another card already
            // holds isn't this card's: the look-up is spent, so this creates.
            if store.load(workspace_id)?.iter().any(|c| c.id != card.id && c.gh_issue_number == Some(n)) {
                n = github::issue_create(repo, &card.id, &card.title, &body)?;
            }
            push_status_labels(store, repo, workspace_id, &card.id, n);
            Ok(n)
        }
        Some(n) => {
            // 1.175.0 (D3): only the parts this computer changed, each only
            // if GitHub still has what was last read of it; a part both
            // changed asks on the card instead (`issue_edit::push_pending`).
            // The body carries the claim marker GitHub has now (C2);
            // unreadable → nothing is written.
            crate::issue_edit::push_pending(store, repo, workspace_id, card, n)?;
            push_status_labels(store, repo, workspace_id, &card.id, n);
            Ok(n)
        }
    }
}

/// Apply the planner's actions through the granular store methods (never a
/// whole-board write). Returns (created, patched).
///
/// 1.175.0 (R5): the cards a pass creates go in together, in one write
/// (`KanbanStore::create_cards`), after its patches. Each used to rewrite
/// the whole board and roll its backup: a first read of a repository with
/// 300 open issues was 300 writes of a growing file. A patch never names a
/// card this pass creates, so the order between the two doesn't matter.
fn apply_actions(
    store: &KanbanStore,
    workspace_id: &str,
    actions: Vec<ReconcileAction>,
    mine: Option<&str>,
) -> (usize, usize) {
    let mut new_cards = Vec::new();
    let mut patched = 0;
    for action in actions {
        match action {
            ReconcileAction::Create(mut card) => {
                card.workspace_id = workspace_id.to_string();
                let claim = card.gh_claim.take();
                card.take_gh_claim(claim, mine);
                new_cards.push(*card);
            }
            ReconcileAction::Patch {
                card_id,
                title,
                notes,
                knowledge,
                gh_raw_remainder,
                column_id,
                gh_assignees,
                gh_author,
                gh_claim,
                area,
                origin,
                edit_conflicts,
            } => {
                let res = store.with_card(workspace_id, &card_id, |card| {
                    card.take_gh_claim(gh_claim, mine);
                    if let Some(conflicts) = edit_conflicts {
                        card.edit_conflicts = conflicts;
                    }
                    if let Some(origin) = origin {
                        card.gh_author_association = origin.association;
                        card.gh_last_editor = origin.editor;
                    }
                    // Only over what the plan saw: an area chosen while the
                    // issues were read stays, and goes up on the next push.
                    if let Some(pulled) = area {
                        if card.area == pulled.seen_area && card.gh_area_label == pulled.seen_label {
                            card.area = pulled.area;
                            card.gh_area_label = pulled.label;
                        }
                    }
                    if let Some(author) = gh_author {
                        card.gh_author = Some(author);
                    }
                    card.title = title;
                    card.notes = notes;
                    card.knowledge = knowledge;
                    card.gh_raw_remainder = gh_raw_remainder;
                    card.gh_assignees = gh_assignees;
                    if let Some(col) = column_id {
                        set_reconciled_column(card, col);
                    }
                    Ok(())
                });
                match res {
                    Ok(_) => patched += 1,
                    Err(e) => log::warn!("github_sync: patch during reconcile skipped: {e}"),
                }
            }
            ReconcileAction::SetAssignees {
                card_id,
                gh_assignees,
                gh_author,
                gh_claim,
                origin,
            } => {
                let res = store
                    .set_gh_assignees(workspace_id, &card_id, gh_assignees)
                    .and_then(|_| store.set_gh_claim(workspace_id, &card_id, gh_claim, mine))
                    .and_then(|_| match gh_author {
                        Some(author) => store.set_gh_author(workspace_id, &card_id, Some(author)),
                        None => Ok(false),
                    })
                    .and_then(|_| match origin {
                        Some(origin) => store.set_gh_origin(workspace_id, &card_id, origin),
                        None => Ok(false),
                    });
                match res {
                    Ok(_) => patched += 1,
                    Err(e) => log::warn!("github_sync: assignees during reconcile skipped: {e}"),
                }
            }
        }
    }
    // A racing create (same deterministic id) is benign: skipped inside.
    let created = store.create_cards(workspace_id, new_cards).unwrap_or_else(|e| {
        log::warn!("github_sync: creates during reconcile skipped: {e}");
        0
    });
    (created, patched)
}

/// TM-5: how many issues one board read looks up by number when its lists
/// were cut ([`read_issues`]). A constant, not one per card: the rest wait
/// for the next read, which asks them first ([`LOOKUPS`]).
pub const ISSUE_LOOKUPS_PER_READ: usize = 10;

/// TM-5 (fix round 1): how long an issue GitHub said it doesn't have is
/// taken as gone before it is asked about again. An issue that was deleted
/// or moved away doesn't come back; asking on every read (each few minutes)
/// would hold a lookup slot for good.
pub const GONE_ISSUE_RECHECK_MS: i64 = 6 * 60 * 60 * 1000;

/// 1.175.0 (B3): what this run last learnt of where an issue's text comes
/// from, and the issue's `updatedAt` it was asked at. In memory only.
static ORIGINS: std::sync::Mutex<Option<std::collections::HashMap<(String, u64), (String, crate::issue_text::Origin)>>> =
    std::sync::Mutex::new(None);

/// 1.175.0 (B3): give each open issue of a board read its origin (the
/// author's association, the last editor), which `gh issue list` doesn't
/// carry. Only an issue this run hasn't asked about, or that changed since
/// (`updatedAt`), is asked for, [`github::ORIGINS_PER_READ`] to a read: a
/// board of 500 open issues costs five reads the first time in a run, and
/// afterwards none unless an issue is new or changed (then one, for up to
/// a hundred of them). A read that fails leaves the rest unknown for this
/// pass: the cards keep what they recorded, and the next read asks again.
fn fill_origins(repo: &str, issues: &mut [GhIssue]) {
    let key = |number: u64| (repo.to_ascii_lowercase(), number);
    let mut ask: Vec<u64> = Vec::new();
    {
        let mut memo = ORIGINS.lock().unwrap_or_else(|p| p.into_inner());
        let memo = memo.get_or_insert_with(Default::default);
        for issue in issues.iter_mut() {
            match memo.get(&key(issue.number)) {
                Some((at, origin)) if *at == issue.updated_at => issue.origin = Some(origin.clone()),
                _ => ask.push(issue.number),
            }
        }
    }
    for chunk in ask.chunks(github::ORIGINS_PER_READ) {
        let read = match github::issue_origins(repo, chunk) {
            Ok(read) => read,
            Err(e) => {
                log::warn!("github_sync: reading who wrote {repo}'s issues failed ({e}); their cards keep what they recorded");
                return;
            }
        };
        let mut memo = ORIGINS.lock().unwrap_or_else(|p| p.into_inner());
        let memo = memo.get_or_insert_with(Default::default);
        for (number, origin) in read {
            if let Some(issue) = issues.iter_mut().find(|i| i.number == number) {
                memo.insert(key(number), (issue.updated_at.clone(), origin.clone()));
                issue.origin = Some(origin);
            }
        }
    }
}

/// One lookup of an issue by its number: when, and whether GitHub said the
/// repository has no such issue.
#[derive(Debug, Clone, Copy)]
struct Lookup {
    asked_at: i64,
    gone: bool,
}

/// TM-5 (fix round 1): the lookups by number of this run, by repository and
/// issue. In memory only: after a restart every issue is asked afresh. It
/// lets the reads take turns — the least recently asked first — so more
/// unknown cards than one read looks up are all reached, and an issue that
/// is gone doesn't use a slot on every read.
static LOOKUPS: std::sync::Mutex<Option<std::collections::HashMap<(String, u64), Lookup>>> = std::sync::Mutex::new(None);

fn lookups() -> std::sync::MutexGuard<'static, Option<std::collections::HashMap<(String, u64), Lookup>>> {
    LOOKUPS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// TM-5 (1.175.0): what one read of a repository's issues gave a board.
#[derive(Debug, Clone)]
pub struct IssueRead {
    pub issues: Vec<GhIssue>,
    /// Neither list reached its limit: an issue that isn't in `issues`
    /// isn't on GitHub.
    pub complete: bool,
    /// When a list was cut: the numbers GitHub answered it has no issue for.
    pub gone: Vec<u64>,
}

impl IssueRead {
    /// The "issue missing" numbers among `absent`, the cards' issues a plan
    /// didn't find in `issues`. From a cut list, absence proves nothing, so
    /// only the numbers GitHub said it doesn't have count.
    pub fn missing(&self, absent: Vec<u64>) -> Vec<u64> {
        if self.complete {
            return absent;
        }
        absent.into_iter().filter(|number| self.gone.contains(number)).collect()
    }
}

/// TM-5 (1.175.0): the issues a board pull works from. It was one `gh issue
/// list --state all --limit 500`: past 500 issues, closed ones included, the
/// older open issues never became cards, and the cards they already had read
/// "issue missing".
///
/// - Every open issue, up to [`github::OPEN_ISSUES_LIMIT`].
/// - The closed ones only when a card of `local` has an issue that isn't
///   open (a closed issue with no card is history, `reconcile_plan_with`):
///   the newest [`github::CLOSED_ISSUES_LIMIT`].
/// - When a list came back at its limit it may have been cut, which is
///   logged, and the read is not `complete`. A card that isn't done and
///   whose issue is in neither list is then looked up by its number, at most
///   [`ISSUE_LOOKUPS_PER_READ`] a read: closed further back than the list
///   reaches (it joins `issues`, so the card follows it), or really gone
///   (`gone`). The reads take turns, the least recently asked first, so with
///   more such cards than one read looks up each is reached within a few
///   reads; an issue GitHub said is gone stays `gone` without being asked
///   again for [`GONE_ISSUE_RECHECK_MS`]. The first lookup that fails for
///   another reason (no network, a timeout) ends the lookups of this read:
///   the board's pass lock is held, and ten timeouts in a row would hold it
///   for minutes. A card not reached keeps what it has.
///
/// Reads only: it writes nothing to GitHub.
pub fn read_issues(repo: &str, local: &[KanbanCard]) -> Result<IssueRead, String> {
    read_issues_at(repo, local, crate::kanban::now_ms())
}

/// [`read_issues`] at `now` (ms), which a test moves.
fn read_issues_at(repo: &str, local: &[KanbanCard], now: i64) -> Result<IssueRead, String> {
    let mut issues = github::issue_list(repo, "open", github::OPEN_ISSUES_LIMIT)?;
    let open_cut = issues.len() >= github::OPEN_ISSUES_LIMIT;
    // 1.175.0 (B3): the open issues' origins, before any closed one joins.
    fill_origins(repo, &mut issues);
    let absent = |issues: &[GhIssue]| -> Vec<&KanbanCard> {
        let found: std::collections::HashSet<u64> = issues.iter().map(|i| i.number).collect();
        local.iter().filter(|c| c.gh_issue_number.is_some_and(|n| !found.contains(&n))).collect()
    };
    let mut closed_cut = false;
    if !absent(&issues).is_empty() {
        let closed = github::issue_list(repo, "closed", github::CLOSED_ISSUES_LIMIT)?;
        closed_cut = closed.len() >= github::CLOSED_ISSUES_LIMIT;
        for issue in closed {
            // Closed between the two reads: the later answer stands.
            match issues.iter_mut().find(|i| i.number == issue.number) {
                Some(seen) => *seen = issue,
                None => issues.push(issue),
            }
        }
    }
    if !open_cut && !closed_cut {
        return Ok(IssueRead { issues, complete: true, gone: Vec::new() });
    }
    log::warn!(
        "github_sync: {repo} has more issues than one read takes (open: {}{}, closed: {}{}); a card whose issue isn't in the lists is not called missing",
        github::OPEN_ISSUES_LIMIT,
        if open_cut { ", reached" } else { "" },
        github::CLOSED_ISSUES_LIMIT,
        if closed_cut { ", reached" } else { "" },
    );
    let mut unknown: Vec<u64> = absent(&issues)
        .into_iter()
        .filter(|card| card.column_id != KanbanColumnId::Complete)
        .filter_map(|card| card.gh_issue_number)
        .collect();
    unknown.sort_unstable_by(|a, b| b.cmp(a));
    unknown.dedup();
    // What this run already knows: gone a short while ago is still gone,
    // unasked; the rest are asked the least recently asked first (never
    // asked before anything, then the highest numbers).
    let key = |number: u64| (repo.to_string(), number);
    let known: std::collections::HashMap<u64, Lookup> = {
        let mut memo = lookups();
        let memo = memo.get_or_insert_with(Default::default);
        // Forget what is too old to matter, so the memo stays the size of the board.
        memo.retain(|_, lookup| now.saturating_sub(lookup.asked_at) < 4 * GONE_ISSUE_RECHECK_MS);
        unknown.iter().filter_map(|n| memo.get(&key(*n)).map(|lookup| (*n, *lookup))).collect()
    };
    let still_gone = |number: &u64| {
        known.get(number).is_some_and(|l| l.gone && now.saturating_sub(l.asked_at) < GONE_ISSUE_RECHECK_MS)
    };
    let mut gone: Vec<u64> = unknown.iter().copied().filter(still_gone).collect();
    let mut to_ask: Vec<u64> = unknown.into_iter().filter(|n| !still_gone(n)).collect();
    to_ask.sort_by_key(|n| (known.get(n).map_or(i64::MIN, |l| l.asked_at), std::cmp::Reverse(*n)));
    if to_ask.len() > ISSUE_LOOKUPS_PER_READ {
        log::warn!(
            "github_sync: {repo}: {} cards' issues aren't in the lists; {ISSUE_LOOKUPS_PER_READ} are looked up now, the others on the next reads",
            to_ask.len()
        );
    }
    for number in to_ask.into_iter().take(ISSUE_LOOKUPS_PER_READ) {
        let answer = github::issue_view(repo, number);
        let not_found = answer.as_ref().is_err_and(|e| github::is_issue_not_found(e));
        // Also one that failed: the next read then starts with the others.
        lookups().get_or_insert_with(Default::default).insert(key(number), Lookup { asked_at: now, gone: not_found });
        match answer {
            Ok(issue) => issues.push(issue),
            Err(_) if not_found => gone.push(number),
            Err(e) => {
                log::warn!(
                    "github_sync: {repo}#{number} couldn't be read ({e}); no more issues are looked up on this read, and their cards keep what they have"
                );
                break;
            }
        }
    }
    Ok(IssueRead { issues, complete: false, gone })
}

/// QoL 14.1 (C19): the Board's periodic refresh. Pull only: one read of the
/// issues ([`read_issues`]), applied to the local board under the same pass lock and
/// conflict policy as [`reconcile`]. It writes nothing to GitHub (no pending
/// push, no labels, no skill-issue tidy, no marker write-back) and touches no
/// branch, worktree or trash; those stay with Sync.
///
/// 1.175.0: the command that runs it is no longer read-only in one case. On
/// a board opened from its last saved copy, [`refresh_then_send_held`] sends,
/// after this read, the two one-shot writes that were refused while the
/// board was held. This function itself still writes nothing.
pub fn refresh(
    store: &KanbanStore,
    workspace_id: &str,
    repo: &str,
    labels: &AreaLabels,
) -> Result<ReconcileSummary, String> {
    let lock = board_pass_lock(workspace_id);
    let _pass = lock.lock().unwrap_or_else(|p| p.into_inner());
    pull(store, workspace_id, repo, labels)
}

/// 1.175.0 (round 4, T1): [`refresh`], then the one-shot writes that were
/// kept while this board was held ([`send_held_writes`]). The read itself
/// still writes nothing; what goes out after it is what the person already
/// asked for (a card's outcome comment, this computer's claim taken off an
/// issue) and Plyloft refused only until GitHub was read.
pub fn refresh_then_send_held(
    store: &KanbanStore,
    workspace_id: &str,
    repo: &str,
    labels: &AreaLabels,
) -> Result<ReconcileSummary, String> {
    let summary = refresh(store, workspace_id, repo, labels)?;
    send_held_writes(store, workspace_id, repo);
    Ok(summary)
}

/// T1: send what [`github::queue_held_write`] kept for `repo`, now that its
/// board was read. Nothing is taken out while the board still waits for its
/// read. A write the hold refuses again goes back in the queue; any other
/// failure is logged, as it was when the write was first asked.
pub fn send_held_writes(store: &KanbanStore, workspace_id: &str, repo: &str) {
    if store.restored_from_backup(workspace_id).is_some_and(|(_, pulled)| !pulled) {
        return;
    }
    for write in github::take_held_writes(repo) {
        let sent = match &write {
            github::HeldWrite::Comment { number, body } => github::issue_comment(repo, *number, body),
            github::HeldWrite::ReleaseClaim { number } => {
                crate::device_claim::release_on_issue(repo, *number).map(|after| {
                    let card = store.load(workspace_id).ok().and_then(|cards| {
                        cards.into_iter().find(|c| c.gh_issue_number == Some(*number))
                    });
                    if let Some(card) = card {
                        let mine = crate::device_claim::this_id_for(repo);
                        if let Err(e) = store.set_gh_claim(workspace_id, &card.id, after, mine.as_deref()) {
                            log::warn!("github_sync: recording #{number}'s release failed: {e}");
                        }
                    }
                })
            }
        };
        match sent {
            Ok(()) => log::info!("github_sync: sent what waited for {repo}'s first read: {write:?}"),
            Err(e) if github::is_held_refusal(&e) => github::queue_held_write(repo, write),
            Err(e) => log::warn!("github_sync: {write:?} for {repo}, kept while its board was held, failed: {e}"),
        }
    }
}

/// 1.175.0 (R2): whether `repo` is the repository of a GitHub Issues board
/// among `awaiting` — the boards opened from their last saved copy this
/// session whose issues haven't been read since
/// (`KanbanStore::restored_awaiting_pull`). Nothing is sent to its issues
/// until they were (`github::hold_issue_writes_while`).
pub fn restored_board_holds(awaiting: &[String], workspaces: &[crate::workspace::Workspace], repo: &str) -> bool {
    workspaces.iter().any(|ws| {
        ws.kanban_sync_mode == crate::workspace::KanbanSyncMode::GitHubIssues
            && awaiting.contains(&ws.id)
            && ws.github_owner_repo.as_deref().is_some_and(|own| own.trim().eq_ignore_ascii_case(repo.trim()))
    })
}

/// R2: the pull a board opened from its last saved copy owes before any of
/// its cards is sent to GitHub ([`reconcile`], [`push_local`]). The read
/// that fails is the pass's error, and nothing was sent.
fn pull_first_if_restored(
    store: &KanbanStore,
    workspace_id: &str,
    repo: &str,
    labels: &AreaLabels,
) -> Result<(), String> {
    if store.restored_from_backup(workspace_id).is_some_and(|(_, pulled)| !pulled) {
        pull(store, workspace_id, repo, labels)?;
    }
    // Round 4 (T1): what was asked once while the board was held goes now.
    send_held_writes(store, workspace_id, repo);
    Ok(())
}

/// R2: the first pull of a board opened from its last saved copy, written
/// at `since_ms`. The copy is one save behind. When the lost save was the
/// one that stamped an issue's number on its card, the card is there
/// without a number and the issue is on GitHub: the plan would make a second
/// card for the issue, and a later push a second issue for the card.
///
/// So, from the issues just read (no other read): an open issue no card
/// holds, opened since that copy was written, whose title and brief are
/// exactly those of one card without a number — and of no other such card,
/// and no other such issue — is that card's, and its number is stamped.
/// Every other card without a number is remembered for the look-up a later
/// create makes first ([`github::expect_lost_create`]: its issue may be
/// closed, or past what the read lists). Returns whether a card was stamped.
fn relink_restored(
    store: &KanbanStore,
    workspace_id: &str,
    repo: &str,
    issues: &[GhIssue],
    local: &[KanbanCard],
    since_ms: i64,
) -> bool {
    // Two minutes for GitHub's clock against this computer's, as
    // `github::CreateWindow` allows.
    let from = since_ms - 2 * 60 * 1000;
    let is_card_of = |card: &KanbanCard, issue: &GhIssue| {
        let parsed = github::parse_issue_body(&issue.body);
        card.title == issue.title && card.notes == parsed.notes && card.knowledge == parsed.knowledge
    };
    let unnumbered: Vec<&KanbanCard> =
        local.iter().filter(|c| c.gh_issue_number.is_none() && c.pr_review.is_none()).collect();
    let unheld: Vec<&GhIssue> = issues
        .iter()
        .filter(|i| i.state.eq_ignore_ascii_case("open"))
        .filter(|i| !local.iter().any(|c| c.gh_issue_number == Some(i.number)))
        .filter(|i| github::rfc3339_ms(i.created_at.as_deref()).is_some_and(|at| at >= from))
        .collect();
    let mut stamped = false;
    for card in &unnumbered {
        let mut theirs = unheld.iter().filter(|issue| is_card_of(card, issue));
        let (Some(issue), None) = (theirs.next(), theirs.next()) else {
            github::expect_lost_create(repo, &card.id, since_ms);
            continue;
        };
        if unnumbered.iter().filter(|other| is_card_of(other, issue)).count() != 1 {
            github::expect_lost_create(repo, &card.id, since_ms);
            continue;
        }
        let number = issue.number;
        match store.with_card(workspace_id, &card.id, |c| {
            c.gh_issue_number = Some(number);
            Ok(())
        }) {
            Ok(_) => {
                log::warn!(
                    "github_sync: card '{}' of the restored board {workspace_id} is {repo}#{number} again (its number was in the save that was lost)",
                    card.id
                );
                stamped = true;
            }
            Err(e) => log::warn!("github_sync: card '{}' couldn't take {repo}#{number} back: {e}", card.id),
        }
    }
    stamped
}

/// 1.175.0 (round 4, T3; owner's prudent option): on the first read of a
/// board opened from its last saved copy, GitHub wins where its issue was
/// touched since that copy was written (`since_ms`, with the two minutes
/// [`relink_restored`] allows for the two clocks).
///
/// The copy is one save behind, so a card can be back as pending although
/// the lost save was the very one that pushed its edit; a teammate may have
/// edited the issue afterwards, and the pending card would push its older
/// text over theirs. An issue not touched since was never pushed to, so the
/// card pushes as on any board.
///
/// Round 6 (W1): "touched" proves little by itself. GitHub moves `updatedAt`
/// on any change — Plyloft's own status label, claim marker and assignment,
/// a teammate's comment — so the texts are compared first:
///
/// - the issue's title and text are the card's: the push already landed (or
///   nothing differs). The pending mark is cleared, and nothing is lost.
/// - they differ: GitHub still wins, the prudent default, but the card's
///   text is kept first, in a file beside the kept copy of that restore
///   ([`keep_replaced_text`]). GitHub keeps the history of an issue's body;
///   a local edit has none. If that file can't be written the card stays
///   pending instead, and pushes as on any board: of the two texts, only
///   GitHub's has a history to come back from.
///
/// Returns whether a mark was cleared.
fn github_wins_where_touched(
    store: &KanbanStore,
    workspace_id: &str,
    repo: &str,
    issues: &[GhIssue],
    local: &[KanbanCard],
    since_ms: i64,
) -> bool {
    let from = since_ms - 2 * 60 * 1000;
    let mut cleared = false;
    for card in local.iter().filter(|c| c.sync_pending) {
        let Some(issue) = card.gh_issue_number.and_then(|n| issues.iter().find(|i| i.number == n)) else { continue };
        if !github::rfc3339_ms(Some(issue.updated_at.as_str())).is_some_and(|at| at >= from) {
            continue;
        }
        let parsed = github::parse_issue_body(&issue.body);
        let same_text = card.title == issue.title && card.notes == parsed.notes && card.knowledge == parsed.knowledge;
        if !same_text {
            match keep_replaced_text(store, workspace_id, repo, card, issue.number) {
                Ok(kept) => log::warn!(
                    "github_sync: {repo}#{} changed on GitHub after the copy the restored board {workspace_id} was opened from; card '{}' takes GitHub's text, and the text it had here is kept as {}",
                    issue.number,
                    card.id,
                    kept.display()
                ),
                Err(e) => {
                    log::warn!(
                        "github_sync: {repo}#{} changed on GitHub after the copy the restored board {workspace_id} was opened from, but the text card '{}' has here couldn't be kept ({e}); the card stays pending",
                        issue.number,
                        card.id
                    );
                    continue;
                }
            }
        }
        match store.set_github_sync(workspace_id, &card.id, None, Some(false), None) {
            Ok(_) => {
                if same_text {
                    log::info!(
                        "github_sync: {repo}#{} already has the text of card '{}' of the restored board {workspace_id}; nothing to push",
                        issue.number,
                        card.id
                    );
                }
                cleared = true;
            }
            Err(e) => log::warn!("github_sync: card '{}' keeps its pending mark: {e}", card.id),
        }
    }
    cleared
}

/// W1: keep the title and text `card` has on this computer before GitHub's
/// replace them, as `<board>.<card>.text-replaced-by-github-<ms>.txt` beside
/// the kept copy of the board's restore — a new file, written atomically.
/// Its name ends in `.txt`, so nothing that lists the boards folder takes
/// it for a board or for a file that was set aside.
fn keep_replaced_text(
    store: &KanbanStore,
    workspace_id: &str,
    repo: &str,
    card: &KanbanCard,
    number: u64,
) -> Result<std::path::PathBuf, String> {
    let beside = store.restore_kept_as(workspace_id).ok_or("the restore's kept copy isn't known")?;
    let folder = beside.parent().ok_or("the restore's kept copy has no folder")?;
    let plain = |id: &str| -> String {
        id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
    };
    let mut at = crate::kanban::now_ms();
    let path = loop {
        let name = format!("{}.{}.text-replaced-by-github-{at}.txt", plain(workspace_id), plain(&card.id));
        let path = folder.join(name);
        if !path.exists() {
            break path;
        }
        at += 1;
    };
    let section = |text: &Option<String>| text.as_deref().filter(|t| !t.trim().is_empty()).unwrap_or("(none)").to_string();
    let text = format!(
        "The text this card had on this computer before Plyloft took GitHub's.\n\
         Its board was opened from its last saved copy, and issue #{number} of {repo} had changed on GitHub since that copy was saved.\n\n\
         Title\n-----\n{}\n\nBrief\n-----\n{}\n\nKnowledge\n---------\n{}\n",
        card.title,
        section(&card.notes),
        section(&card.knowledge),
    );
    crate::atomic::write_atomic_text(&path, &text)?;
    Ok(path)
}

/// [`refresh`] under the pass lock its caller holds.
fn pull(store: &KanbanStore, workspace_id: &str, repo: &str, labels: &AreaLabels) -> Result<ReconcileSummary, String> {
    let mut local = store.load(workspace_id)?;
    let read = read_issues(repo, &local)?;
    let issues = &read.issues;
    if let Some((since_ms, false)) = store.restored_from_backup(workspace_id) {
        let relinked = relink_restored(store, workspace_id, repo, issues, &local, since_ms);
        if relinked {
            local = store.load(workspace_id)?;
        }
        if github_wins_where_touched(store, workspace_id, repo, issues, &local, since_ms) {
            local = store.load(workspace_id)?;
        }
    }
    // An unmarked body becomes the card's brief here too; its marker
    // write-back (`plan.write_back`) is left for the next Sync, which finds
    // the card already holding it (`already_adopted`). An area label still
    // due stays due: only Sync sends it.
    let plan = reconcile_plan_with(issues, &local, labels);
    let mine = crate::device_claim::this_id_for(repo);
    let (created, patched) = apply_actions(store, workspace_id, plan.actions, mine.as_deref());
    // R2: GitHub's issues were read and applied; a board opened from its
    // last saved copy may send again.
    store.note_pulled(workspace_id);
    // TM-5: never "issue missing" off a list that was cut.
    let missing = read.missing(plan.missing);
    Ok(ReconcileSummary {
        created,
        patched,
        missing,
        ..ReconcileSummary::default()
    })
}

/// Impure: reconcile the local board for `workspace_id` against `repo`'s
/// issues. Push-then-pull (R2: pull first, once, for a board opened from its
/// last saved copy this session). Applies through the granular store methods only.
/// With the workspace checkout known, the pass first heals dangling worktree
/// handles, so a card whose worktree was deleted follows its issue again.
pub fn reconcile(
    store: &KanbanStore,
    workspace_id: &str,
    repo: &str,
    workspace_cwd: Option<&std::path::Path>,
    labels: &AreaLabels,
) -> Result<ReconcileSummary, String> {
    let lock = board_pass_lock(workspace_id);
    let _pass = lock.lock().unwrap_or_else(|p| p.into_inner());
    let healed = workspace_cwd.map(|cwd| heal_dangling_worktree_handles(store, workspace_id, cwd)).unwrap_or_default();
    // R2: a board opened from its last saved copy reads before it writes.
    pull_first_if_restored(store, workspace_id, repo, labels)?;
    // 1.175.0 (D2, TM-6): a card whose copy was found gone no longer says
    // it is on this computer.
    for card in healed.iter().filter_map(|id| store.get_card(workspace_id, id).ok()).filter(|c| c.gh_claim_here) {
        crate::device_claim::release_unless_copy_here(store, repo, workspace_id, &card);
    }

    // ── push: retry every card with an unsynced local edit ──────────────
    let local = store.load(workspace_id)?;
    // A card reviewing a pull request stays local: never an issue.
    for card in local.iter().filter(|c| c.sync_pending && c.pr_review.is_none()) {
        match push_pending_card(store, repo, workspace_id, card) {
            Ok(number) => {
                // Stamp the (possibly new) number; the pending flag clears
                // only if nobody edited the card while it was pushed.
                settle_pushed(store, repo, workspace_id, card, number);
            }
            Err(e) => {
                // Still unreachable — leave it pending for the next Sync.
                log::warn!(
                    "github_sync: push of pending card '{}' to {repo} failed: {e}",
                    card.id
                );
            }
        }
    }

    // ── push: the member's own name, off the issues of cards they left ──
    // 1.175.0 (D2-a): what GitHub refused when they left, once more before
    // the reads. These writes come first out of the Sync's cap (U33): a name
    // left on an issue keeps a teammate from the card.
    let names_retried = crate::leave_issue::retry_pending(store, repo, workspace_id, &local, LABEL_WRITES_PER_SYNC);

    // ── push: status labels only (GH #66) ───────────────────────────────
    let mut label_retries = pending_label_retries(&local);
    label_retries.truncate(LABEL_WRITES_PER_SYNC.saturating_sub(names_retried));
    let label_budget = LABEL_WRITES_PER_SYNC.saturating_sub(names_retried + label_retries.len());
    let label_retried = label_retries.len();
    let mut label_retries_failed = 0;
    for (card_id, number) in label_retries {
        if !push_status_labels(store, repo, workspace_id, &card_id, number) {
            label_retries_failed += 1;
        }
    }
    let label_writes_left = label_writes_after_retries(label_budget, label_retried, label_retries_failed);

    // ── pull: reconcile against the live issue list ─────────────────────
    // Re-read: the pushes above may have stamped numbers.
    let mut read = read_issues(repo, &store.load(workspace_id)?)?;
    let mut issues = std::mem::take(&mut read.issues);

    // ── push: area labels still due (C1) ───────────────────────────────
    // Only to issues GitHub still has (a missing one is reported, not
    // written to), and before the plan, which reads each pushed issue as
    // GitHub has it now. Re-read: the pushes above may have stamped numbers.
    let mut area_labels_failed = 0;
    if !labels.is_empty() {
        for card in store.load(workspace_id)?.iter().filter(|c| !c.sync_pending) {
            let Some(number) = card.gh_issue_number else { continue };
            let Some(issue) = issues.iter_mut().find(|i| i.number == number) else { continue };
            if area_label_to_push(card, labels).is_none() {
                continue;
            }
            let push = push_area_label(store, repo, workspace_id, &card.id, number, labels);
            if push == AreaPush::Failed {
                area_labels_failed += 1;
            }
            after_area_push(issue, &push);
        }
    }

    let local = store.load(workspace_id)?; // re-read: pushes may have stamped numbers
    let plan = reconcile_plan_with(&issues, &local, labels);

    let mine = crate::device_claim::this_id_for(repo);
    let (created, patched) = apply_actions(store, workspace_id, plan.actions, mine.as_deref());

    // ── area labels of other areas on one issue (two Macs chose at once):
    // off, once the card's area is the one read and nothing is due.
    for extra in &plan.extra_area_labels {
        let still = store.get_card(workspace_id, &extra.card_id).is_ok_and(|c| {
            c.area.as_deref() == Some(extra.area.as_str()) && area_label_to_push(&c, labels).is_none()
        });
        if !still {
            continue;
        }
        let remove: Vec<&str> = extra.labels.iter().map(String::as_str).collect();
        if let Err(e) = github::issue_set_labels(repo, extra.number, &[], &remove) {
            log::warn!("github_sync: other areas' labels on {repo}#{} stay (Sync retries): {e}", extra.number);
        }
    }

    // ── skill cards: their own issue is labelled, and closed once shipped ─
    for step in skill_issue_tidy(&issues, &local) {
        match step {
            SkillIssueTidy::Close { card_id, number } => {
                if let Err(e) = github::issue_close(repo, number) {
                    log::warn!("github_sync: closing {repo}#{number} of shipped skill card '{card_id}' failed: {e}");
                }
            }
            SkillIssueTidy::Label { card_id, number } => {
                push_status_labels(store, repo, workspace_id, &card_id, number);
            }
        }
    }

    // ── U33: a closed issue's status label follows its card to Done ─────
    // Sync only, like the other label pushes; the read-only refresh writes nothing.
    for (card_id, number) in closed_status_labels_to_tidy(&issues, &store.load(workspace_id)?)
        .into_iter()
        .take(label_writes_left)
    {
        if !push_status_labels(store, repo, workspace_id, &card_id, number) {
            break; // It stays pending, and the retry above is what brings it back.
        }
    }

    // ── write-back: wrap adopted bodies in the marker block ─────────────
    // Only the adopted text is rewritten (it becomes the notes block);
    // title and labels stay as GitHub has them. A failure flags the card
    // `sync_pending`, so the next Sync pushes it before pulling and the
    // adoption can't be undone by a re-parse of the still-unmarked body.
    for card_id in plan.write_back {
        let Ok(card) = store.get_card(workspace_id, &card_id) else {
            continue;
        };
        let Some(number) = card.gh_issue_number else {
            continue;
        };
        // 1.173.0 (C2): the marker of the issue just pulled.
        // 1.175.0 (B3): never a marker an outsider wrote into the text.
        let live = issues
            .iter()
            .find(|i| i.number == number)
            .and_then(|i| crate::issue_text::claim_in(&i.body, crate::issue_text::card_written_outside(&card)));
        // 1.175.0 (D3): while the card asks which brief to keep, its text
        // isn't written; and the wrap is the body's alone, never the title.
        if card.edit_conflicts.iter().any(|c| c.part == crate::issue_edit::EditPart::Brief) {
            continue;
        }
        let claim = crate::device_claim::kept_on_rebuild(&card, live, repo);
        let body = crate::device_claim::card_issue_body(&card, claim.as_ref());
        match github::issue_edit_body(repo, number, &body) {
            Ok(()) => {
                let _ = store.set_gh_claim(workspace_id, &card_id, claim, mine.as_deref());
            }
            Err(e) => {
                log::warn!("github_sync: marker write-back for {repo}#{number} failed: {e}");
                let _ = store.set_github_sync(workspace_id, &card_id, None, Some(true), None);
            }
        }
    }

    Ok(ReconcileSummary {
        created,
        patched,
        // TM-5: never "issue missing" off a list that was cut.
        missing: read.missing(plan.missing),
        area_labels_failed,
        ..ReconcileSummary::default()
    })
}

/// Stamp the issue `number` on the card `uploaded` was read from, in one
/// store mutation: `sync_pending` clears only when the card still has the
/// title and body that went up. An edit made while the `gh` call ran (it set
/// `sync_pending` on a card with no issue yet) stays pending, so the next
/// Sync pushes it instead of pulling the older issue over it; a move leaves
/// the status label pending.
pub(crate) fn stamp_pushed(
    store: &KanbanStore,
    workspace_id: &str,
    uploaded: &KanbanCard,
    number: u64,
) -> Result<(), String> {
    store.with_card(workspace_id, &uploaded.id, |card| {
        card.gh_issue_number = Some(number);
        card.sync_pending = card.title != uploaded.title
            || card.notes != uploaded.notes
            || card.knowledge != uploaded.knowledge
            || card.gh_raw_remainder != uploaded.gh_raw_remainder;
        // A move while the issue was created may have come after its status
        // label went on (the move's own push saw no issue number): keep the
        // label push pending so Sync delivers the column instead of pulling
        // the old one back.
        if card.column_id != uploaded.column_id {
            card.gh_labels_pending = true;
        }
        Ok(())
    })
}

/// After a push created (or edited) issue `number` for `uploaded`: stamp it
/// ([`stamp_pushed`]). A card deleted while `gh` ran (a card with no issue
/// yet can be deleted mid-batch) would come back from the open issue on the
/// next Sync, so a new issue is closed instead. If the close fails, the card
/// is put back carrying the issue — the delete didn't take, visibly, and a
/// second delete goes through the GitHub card's own close-then-delete path —
/// rather than returning later as an unexplained new card. Never aborts the
/// batch: returns whether the card carries the issue now.
pub(crate) fn settle_pushed(
    store: &KanbanStore,
    repo: &str,
    workspace_id: &str,
    uploaded: &KanbanCard,
    number: u64,
) -> bool {
    // The stamp is the one atomic step: it lands on the card, or the card is
    // gone. Checking first and stamping after would leave a window for a
    // delete in between. Once stamped, the card is a GitHub card, which the
    // local delete refuses.
    let stamp_error = match stamp_pushed(store, workspace_id, uploaded, number) {
        Ok(()) => return true,
        Err(e) => e,
    };
    if store.get_card(workspace_id, &uploaded.id).is_ok() {
        log::warn!(
            "github_sync: stamping {repo}#{number} on card '{}' failed: {stamp_error}",
            uploaded.id
        );
        return false;
    }
    if uploaded.gh_issue_number.is_some() {
        return false;
    }
    log::warn!(
        "github_sync: card '{}' was deleted while {repo}#{number} was created; closing it",
        uploaded.id
    );
    match github::issue_close(repo, number) {
        Ok(()) => false,
        Err(e) => {
            log::warn!(
                "github_sync: closing orphan {repo}#{number} failed ({e}); card '{}' is restored with it",
                uploaded.id
            );
            let mut restored = uploaded.clone();
            restored.gh_issue_number = Some(number);
            restored.sync_pending = false;
            store.create_card(workspace_id, restored).is_ok()
        }
    }
}

/// Bulk-create issues for every local-only card (no `gh_issue_number`, not
/// archived) — the "push N existing cards" flow when a workspace flips to
/// GitHubIssues mode. Each created issue's number is stamped onto its card; a
/// failure flags `sync_pending` so the next reconcile retries.
///
/// GH #81: the issue body is the card's brief inside the `atelier:notes`
/// markers, and the card's column goes on as its status label right after
/// the create (in [`push_pending_card`], so a reconcile's retry does too) — a failed label push is left `gh_labels_pending`, so the next
/// Sync pushes it before pulling and the card never falls back to Todo.
/// Archived cards stay local.
pub fn push_local(
    store: &KanbanStore,
    workspace_id: &str,
    repo: &str,
    labels: &AreaLabels,
) -> Result<PushSummary, String> {
    let lock = board_pass_lock(workspace_id);
    let _pass = lock.lock().unwrap_or_else(|p| p.into_inner());
    // R2: a board opened from its last saved copy reads before it writes.
    pull_first_if_restored(store, workspace_id, repo, labels)?;
    let local = store.load(workspace_id)?;
    let mut summary = PushSummary::default();
    for listed in local
        .iter()
        .filter(|c| c.gh_issue_number.is_none() && !c.archived && c.pr_review.is_none())
    {
        // GH #81: a batch takes a while and the board stays editable: upload
        // each card as it is now, not as the list had it.
        let Ok(card) = store.get_card(workspace_id, &listed.id) else {
            continue;
        };
        if card.gh_issue_number.is_some() || card.archived {
            continue;
        }
        let card = &card;
        match push_pending_card(store, repo, workspace_id, card) {
            Ok(number) => {
                if settle_pushed(store, repo, workspace_id, card, number) {
                    summary.pushed += 1;
                    // C1: the card's area goes up as its issue's label.
                    if push_area_label(store, repo, workspace_id, &card.id, number, labels) == AreaPush::Failed {
                        summary.area_labels_failed += 1;
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "github_sync: push_local of card '{}' to {repo} failed: {e}",
                    card.id
                );
                let _ = store.set_github_sync(workspace_id, &card.id, None, Some(true), None);
                summary.failed += 1;
            }
        }
    }
    Ok(summary)
}

// ── Phase 4: outcome posting to the backing issue ────────────────────────────

/// Pure: build the markdown body of a card-outcome issue comment. `verify_line`
/// is the test result (e.g. "**Verify:** passed (3 steps)") when a verify
/// pipeline ran, else `None`. `changed` is capped at 10 entries with a "+ N
/// more" tail. Empty sections are omitted so a sparse outcome stays terse.
pub fn build_outcome_comment(
    title: &str,
    status_label: &str,
    verify_line: Option<&str>,
    changed: &[String],
    author: Option<&str>,
) -> String {
    let mut out = format!("## Plyloft outcome — {status_label}\n\n**Card:** {title}\n");
    if let Some(v) = verify_line {
        out.push_str(v);
        out.push('\n');
    }
    if !changed.is_empty() {
        out.push_str(&format!("\n**Files changed ({}):**\n", changed.len()));
        for p in changed.iter().take(10) {
            out.push_str(&format!("- `{p}`\n"));
        }
        if changed.len() > 10 {
            out.push_str(&format!("- … + {} more\n", changed.len() - 10));
        }
    }
    if let Some(a) = author {
        out.push_str(&format!("\n— by {a}\n"));
    }
    out
}

/// Impure: post a card-outcome comment to the card's backing GitHub issue.
/// Best-effort — every missing precondition (not GitHub-backed, no issue
/// number, stores absent) short-circuits with a log, never propagates. Reads
/// the changed-file list from the card's linked run snapshot when available.
pub fn post_card_outcome_comment(
    app: &tauri::AppHandle,
    workspace_id: &str,
    card_id: &str,
    status_label: &str,
    verify_line: Option<String>,
) {
    use tauri::Manager;
    let (Some(kanban), Some(workspaces)) = (
        app.try_state::<KanbanStore>(),
        app.try_state::<crate::workspace::WorkspaceStore>(),
    ) else {
        return;
    };
    let Some(repo) = crate::commands::workspace_github_target(&workspaces, workspace_id) else {
        return; // local-only board — nothing to post.
    };
    let Ok(card) = kanban.get_card(workspace_id, card_id) else {
        return;
    };
    let Some(number) = card.gh_issue_number else {
        return; // card never pushed to GitHub.
    };

    // Best-effort changed-file list from the card's linked run snapshot.
    let changed: Vec<String> = card
        .linked_run_id
        .as_deref()
        .and_then(|run_id| app.try_state::<crate::snapshots::SnapshotsStore>().map(|s| (s, run_id.to_string())))
        .and_then(|(snaps, run_id)| snaps.read_changes(&run_id).ok().flatten())
        .map(|m| m.changes.into_iter().map(|c| c.path).collect())
        .unwrap_or_default();

    let body = build_outcome_comment(
        &card.title,
        status_label,
        verify_line.as_deref(),
        &changed,
        card.last_edited_by.as_deref(),
    );
    // OB-7b: the comment is posted as the workspace's GitHub account.
    let _github = crate::github_account::enter_for_workspace(&workspaces, workspace_id);
    match crate::github::issue_comment(&repo, number, &body) {
        Ok(()) => {}
        // Round 4 (T1): the board was opened from its last saved copy and
        // GitHub hasn't been read since. The comment is asked once, so it is
        // kept and posted after that read (`send_held_writes`).
        Err(e) if github::is_held_refusal(&e) => {
            log::info!("github_sync: outcome comment on {repo}#{number} waits for the first read of its restored board");
            github::queue_held_write(&repo, github::HeldWrite::Comment { number, body });
        }
        Err(e) => log::warn!("github_sync: outcome comment on {repo}#{number} failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_a_sync_whose_every_label_retry_failed_stops_the_tidy() {
        use super::label_writes_after_retries as left;
        assert_eq!(left(25, 0, 0), 25, "nothing retried");
        assert_eq!(left(24, 1, 0), 24, "the retry went through");
        assert_eq!(left(23, 2, 1), 23, "one stuck card, the other went through");
        assert_eq!(left(24, 1, 1), 0, "the only retry failed");
        assert_eq!(left(22, 3, 3), 0, "all failed");
    }

    use super::*;
    use crate::github::{GhIssue, GhLabel, GhUser};
    use crate::kanban::{KanbanCard, KanbanColumnId, LastRunStatus};

    fn issue(number: u64, title: &str, body: &str, labels: &[&str], state: &str) -> GhIssue {
        GhIssue {
            number,
            title: title.into(),
            body: body.into(),
            assignees: Vec::<GhUser>::new(),
            labels: labels
                .iter()
                .map(|n| GhLabel { name: n.to_string() })
                .collect(),
            state: state.into(),
            updated_at: String::new(),
            author: None,
            created_at: None,
            state_reason: None,
            origin: None,
        }
    }

    #[test]
    fn a_reconcile_into_in_progress_drops_a_template_that_never_ran() {
        let mut fresh = local_card(Some(70), "T", KanbanColumnId::Todo);
        fresh.swarm_template_id = Some("feature".into());
        super::set_reconciled_column(&mut fresh, KanbanColumnId::InProgress);
        assert_eq!(fresh.column_id, KanbanColumnId::InProgress);
        assert_eq!(fresh.swarm_template_id, None);
        assert!(!crate::kanban::card_is_queue_eligible(&fresh), "the pump starts no new swarm");

        let mut ran = local_card(Some(71), "T", KanbanColumnId::Todo);
        ran.swarm_template_id = Some("feature".into());
        ran.linked_swarm_id = Some("swarm-1".into());
        super::set_reconciled_column(&mut ran, KanbanColumnId::InProgress);
        assert_eq!(ran.swarm_template_id.as_deref(), Some("feature"), "a card that ran one keeps it");

        let mut queued = local_card(Some(72), "T", KanbanColumnId::InProgress);
        queued.swarm_template_id = Some("feature".into());
        super::set_reconciled_column(&mut queued, KanbanColumnId::InProgress);
        assert!(crate::kanban::card_is_queue_eligible(&queued), "already queued, still waits");
    }

    /// R5: the cards one pass creates go in with one write of the board —
    /// its backup afterwards is the board as it was before the pass — and a
    /// card that is already there is not created again.
    #[test]
    fn a_pass_creates_its_cards_in_one_write() {
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = tmp.path().join(crate::kanban::KANBAN_SUBDIR);
        store.create_card("ws", local_card(Some(1), "Already here", KanbanColumnId::Todo)).unwrap();
        let before = std::fs::read(dir.join("ws.json")).unwrap();
        let issues: Vec<GhIssue> = (1..=5).map(|n| issue(n, &format!("Issue {n}"), "", &["status:todo"], "OPEN")).collect();
        let plan = reconcile_plan(&issues, &store.load("ws").unwrap());
        let (created, patched) = apply_actions(&store, "ws", plan.actions, None);
        assert_eq!((created, patched), (4, 1), "#1 is patched, #2–#5 are created");
        // The patch is one write and the four creates one more: the backup
        // holds the patched board, with none of the new cards yet.
        let backup: crate::kanban::KanbanFile = serde_json::from_slice(&std::fs::read(dir.join("ws.json.bak")).unwrap()).unwrap();
        assert_eq!(backup.cards.len(), 1, "no create was written by itself");
        assert_eq!(backup.cards[0].title, "Issue 1");
        assert_ne!(std::fs::read(dir.join("ws.json.bak")).unwrap(), before);
        let ids: Vec<String> = store.load("ws").unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, (1..=5).map(gh_card_id).collect::<Vec<_>>(), "in the order the issues came");
        // The same plan again creates nothing (the ids are there).
        let again = reconcile_plan(&issues, &[]);
        assert_eq!(apply_actions(&store, "ws", again.actions, None), (0, 0));
    }

    /// R2: a store whose board `ws` was opened from its last saved copy,
    /// which holds `cards` (the save that was lost added one more).
    fn restored_store(cards: Vec<KanbanCard>) -> (tempfile::TempDir, KanbanStore) {
        let tmp = tempfile::tempdir().unwrap();
        {
            let before = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
            for card in cards {
                before.create_card("ws", card).unwrap();
            }
            let mut later = KanbanCard::new("lost-save".into(), "ws".into(), "Made in the lost save".into(), None, KanbanColumnId::Todo);
            later.pr_review = None;
            before.create_card("ws", later).unwrap();
        }
        std::fs::write(tmp.path().join(crate::kanban::KANBAN_SUBDIR).join("ws.json"), b"").unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(!store.load("ws").unwrap().iter().any(|c| c.id == "lost-save"));
        assert!(store.take_notice("ws").unwrap().restored);
        store.note_said("ws");
        assert_eq!(store.restored_awaiting_pull(), ["ws"]);
        (tmp, store)
    }

    fn is_issue_write(call: &str) -> bool {
        ["issue create", "issue edit", "issue close", "issue comment"].iter().any(|write| call.starts_with(write))
    }

    /// Open issues as `gh issue list` answers: `new` opened just now, `old`
    /// opened and last touched long before any backup a test restores from.
    fn open_list_of(new: &[(u64, &str, &str)], old: &[(u64, &str, &str)]) -> Result<String, String> {
        let row = |(number, title, body): &(u64, &str, &str), at: &str| {
            serde_json::json!({
                "number": number, "title": title, "body": body, "assignees": [], "labels": [{"name": "status:todo"}],
                "state": "OPEN", "updatedAt": at, "createdAt": at,
            })
        };
        let now = chrono::Utc::now().to_rfc3339();
        let rows: Vec<serde_json::Value> =
            old.iter().map(|issue| row(issue, "2026-01-01T00:00:00Z")).chain(new.iter().map(|issue| row(issue, &now))).collect();
        Ok(serde_json::Value::Array(rows).to_string())
    }

    fn open_list(issues: &[(u64, &str, &str)]) -> Result<String, String> {
        open_list_of(issues, &[])
    }

    /// R2: a board opened from its last saved copy sends nothing to GitHub
    /// before its issues were read once. A Sync starts with that read; when
    /// it fails the Sync fails and nothing was sent; once it went through,
    /// the pending card is pushed as on any board.
    #[test]
    fn a_restored_board_reads_before_it_writes() {
        let _guard = github::test_serial_lock();
        let mut pending = local_card(Some(5), "Edited here", KanbanColumnId::Todo);
        pending.notes = Some("an edit that waits".into());
        pending.sync_pending = true;
        let (_tmp, store) = restored_store(vec![pending]);

        // The read fails: the Sync fails, and no write was tried.
        github::take_test_gh_invocations();
        github::set_test_gh_responses(vec![Err("error connecting to api.github.com".into())]);
        let failed = reconcile(&store, "ws", "o/restored-reads", None, &Default::default());
        let calls = gh_calls();
        assert!(failed.is_err());
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert!(calls[0].starts_with("issue list --repo o/restored-reads --state open"), "{calls:?}");
        assert_eq!(store.restored_awaiting_pull(), ["ws"], "still held");
        // So does the migration of local cards.
        github::set_test_gh_responses(vec![Err("error connecting to api.github.com".into())]);
        assert!(push_local(&store, "ws", "o/restored-reads", &Default::default()).is_err());
        assert!(!gh_calls().iter().any(|call| is_issue_write(call)));

        // The read goes through: first the list, then the push of the pending card.
        let body = github::build_issue_body(Some("what GitHub has"), None, None);
        // (#5 wasn't touched on GitHub since the copy was written: T3.)
        github::set_test_gh_responses(vec![open_list_of(&[], &[(5, "On GitHub", &body)])]);
        let _ = reconcile(&store, "ws", "o/restored-reads", None, &Default::default());
        let calls = gh_calls();
        github::clear_test_gh_responses();
        assert!(calls[0].starts_with("issue list --repo o/restored-reads --state open"), "{calls:?}");
        let first_write = calls.iter().position(|call| call.starts_with("issue view 5") || is_issue_write(call));
        assert!(first_write.is_some_and(|at| at >= 1), "the pending card's push comes after the read: {calls:?}");
        assert!(store.restored_awaiting_pull().is_empty(), "read once: no longer held");
        // A card with an edit that waits keeps it, as on any board.
        assert_eq!(store.get_card("ws", &gh_card_id(5)).unwrap().title, "Edited here");
    }

    /// T1: this computer's claim is taken off an issue once (Done, Stop,
    /// Archive…), and a card's outcome is commented once. Refused while the
    /// board waits for its first read, both are kept and go out right after
    /// that read — the read first, then the writes — instead of being lost.
    #[test]
    fn a_claim_release_and_an_outcome_comment_refused_while_held_are_sent_after_the_read() {
        use crate::device_claim::{self, DeviceClaim, ThisDevice};
        let _guard = github::test_serial_lock();
        const REPO: &str = "o/restored-held";
        device_claim::set_test_device(Some(ThisDevice { id: "uuid-mini".into(), name: "Mac mini".into() }));
        let here = DeviceClaim {
            device: device_claim::repo_device_id("uuid-mini", REPO),
            name: "Mac mini".into(),
            login: Some("matteo".into()),
            at: "2026-11-09T08:00:00Z".into(),
        };
        let mut claimed = local_card(Some(5), "Claimed here", KanbanColumnId::Todo);
        claimed.gh_claim = Some(here.clone());
        let (_tmp, store) = restored_store(vec![claimed.clone()]);
        let body = device_claim::with_claim("brief
", Some(&here));
        let view = serde_json::json!({ "number": 5, "title": "Claimed here", "body": body, "state": "OPEN", "assignees": [], "labels": [] }).to_string();
        github::take_held_writes(REPO);

        // While held: the release reads the issue and its write is refused.
        github::set_test_issue_write_hold(Some(REPO));
        github::take_test_gh_invocations();
        github::set_test_gh_responses(vec![Ok(view.clone())]);
        device_claim::release_card(&store, REPO, "ws", &claimed);
        assert!(!gh_calls().iter().any(|call| is_issue_write(call)), "nothing was written");
        assert_eq!(store.get_card("ws", &gh_card_id(5)).unwrap().gh_claim, Some(here.clone()), "still this computer's");
        // So is the outcome comment (`post_card_outcome_comment` keeps it the same way).
        assert!(github::is_held_refusal(&github::issue_comment(REPO, 5, "Outcome").unwrap_err()));
        github::queue_held_write(REPO, github::HeldWrite::Comment { number: 5, body: "Outcome".into() });
        // A read that fails sends nothing.
        github::set_test_gh_responses(vec![Err("error connecting to api.github.com".into())]);
        assert!(refresh_then_send_held(&store, "ws", REPO, &Default::default()).is_err());
        send_held_writes(&store, "ws", REPO);
        assert!(!gh_calls().iter().any(|call| is_issue_write(call) || call.starts_with("issue view")), "still waiting");

        // The read goes through (the app's hold lifts with it): the read
        // first, then the release and the comment, in the order they were asked.
        github::set_test_issue_write_hold(None);
        github::take_test_gh_stdin();
        github::set_test_gh_responses(vec![open_list(&[(5, "Claimed here", &body)]), Ok(view), Ok(String::new()), Ok(String::new())]);
        refresh_then_send_held(&store, "ws", REPO, &Default::default()).unwrap();
        let calls = gh_calls();
        github::clear_test_gh_responses();
        device_claim::set_test_device(None);
        assert!(calls[0].starts_with("issue list --repo o/restored-held --state open"), "{calls:?}");
        assert!(calls[1].starts_with("issue view 5"), "{calls:?}");
        assert!(calls[2].starts_with("issue edit 5 --repo o/restored-held --body-file -"), "{calls:?}");
        // Merged with the sharing lane (D4, TM-9): a comment's text goes to
        // gh on stdin too, like an issue's.
        assert!(calls[3].starts_with("issue comment 5 --repo o/restored-held --body-file -"), "{calls:?}");
        assert_eq!(calls.len(), 4, "each once: {calls:?}");
        assert_eq!(
            github::take_test_gh_stdin(),
            vec!["brief\n".to_string(), "Outcome".to_string()],
            "the body without this computer's marker, then the comment"
        );
        assert_eq!(store.get_card("ws", &gh_card_id(5)).unwrap().gh_claim, None, "released on the card too");
        assert!(github::take_held_writes(REPO).is_empty(), "nothing left to send");
    }

    /// T1: a release kept while held is dropped when the card is claimed
    /// here again before it went out, and is kept once per issue.
    #[test]
    fn a_held_release_is_forgotten_when_the_card_is_claimed_again() {
        const REPO: &str = "O/Restored-Again";
        github::take_held_writes(REPO);
        github::queue_held_write(REPO, github::HeldWrite::ReleaseClaim { number: 7 });
        github::queue_held_write("o/restored-again", github::HeldWrite::ReleaseClaim { number: 7 });
        github::queue_held_write(REPO, github::HeldWrite::ReleaseClaim { number: 8 });
        github::queue_held_write(REPO, github::HeldWrite::Comment { number: 7, body: "c".into() });
        github::forget_held_release("o/restored-again", 7);
        assert_eq!(
            github::take_held_writes(REPO),
            vec![github::HeldWrite::ReleaseClaim { number: 8 }, github::HeldWrite::Comment { number: 7, body: "c".into() }]
        );
        assert!(github::take_held_writes(REPO).is_empty());
        // `claim_on_issue` is what forgets it, before anything else.
        let claim = include_str!("device_claim.rs");
        let body = &claim[claim.find("pub fn claim_on_issue(").unwrap()..];
        assert!(body[..600].contains("crate::github::forget_held_release(repo, known.number);"));
    }

    /// R2: the lost save stamped an issue's number on its card. The copy
    /// has the card without a number, and the issue is on GitHub. The first
    /// read gives the card its issue back: no second card for the issue, and
    /// no second issue for the card.
    #[test]
    fn a_restored_board_makes_no_second_card_or_issue_for_a_lost_stamp() {
        let _guard = github::test_serial_lock();
        let mut lost = KanbanCard::new("c-lost".into(), "ws".into(), "Lost stamp".into(), Some("brief".into()), KanbanColumnId::Todo);
        lost.sync_pending = false;
        let kept = local_card(Some(3), "Kept", KanbanColumnId::Todo);
        // A local card nobody made an issue for stays local.
        let local_only = KanbanCard::new("c-local".into(), "ws".into(), "Only here".into(), None, KanbanColumnId::Todo);
        let (_tmp, store) = restored_store(vec![lost, kept, local_only]);

        let body = github::build_issue_body(Some("brief"), None, None);
        github::take_test_gh_invocations();
        github::set_test_gh_responses(vec![open_list(&[(3, "Kept", ""), (11, "Lost stamp", &body)])]);
        let summary = refresh(&store, "ws", "o/restored-stamp", &Default::default()).unwrap();
        let calls = gh_calls();
        assert_eq!(calls.len(), 1, "the one read, nothing else: {calls:?}");
        assert_eq!(summary.created, 0, "no second card for #11");
        let cards = store.load("ws").unwrap();
        assert_eq!(cards.iter().find(|c| c.id == "c-lost").unwrap().gh_issue_number, Some(11));
        assert!(!cards.iter().any(|c| c.id == gh_card_id(11)));
        assert_eq!(cards.iter().filter(|c| c.gh_issue_number == Some(11)).count(), 1);
        assert_eq!(cards.iter().find(|c| c.id == "c-local").unwrap().gh_issue_number, None);

        // The migration of local cards: the stamped card is not created
        // again; the one that never had an issue is looked for first (the
        // read a timed-out create makes), then created.
        github::set_test_gh_responses(vec![Ok("[]".into()), Ok("https://github.com/o/restored-stamp/issues/12".into())]);
        let pushed = push_local(&store, "ws", "o/restored-stamp", &Default::default()).unwrap();
        let calls = gh_calls();
        github::clear_test_gh_responses();
        assert_eq!(pushed.pushed, 1);
        let creates: Vec<&String> = calls.iter().filter(|call| call.starts_with("issue create")).collect();
        assert_eq!(creates.len(), 1, "{calls:?}");
        assert!(creates[0].contains("--title Only here"), "{calls:?}");
        assert!(calls[0].starts_with("issue list --repo o/restored-stamp --state all --author @me"), "{calls:?}");
    }

    /// R2: the lost stamp's issue isn't in what the first read lists (closed
    /// since, or past the list's end). Before a create the issue is looked
    /// for, found, and taken: no `issue create`. One another card already
    /// holds is not taken.
    #[test]
    fn a_lost_stamp_the_read_does_not_list_is_looked_for_before_a_create() {
        let _guard = github::test_serial_lock();
        let lost = || KanbanCard::new("c-lost".into(), "ws".into(), "Lost stamp".into(), Some("brief".into()), KanbanColumnId::Todo);
        let body = crate::device_claim::card_issue_body(&lost(), None);
        let found = |number: u64| {
            Ok(serde_json::json!([{ "number": number, "title": "Lost stamp", "body": body, "createdAt": chrono::Utc::now().to_rfc3339() }]).to_string())
        };

        let (_tmp, store) = restored_store(vec![lost()]);
        github::take_test_gh_invocations();
        github::set_test_gh_responses(vec![Ok("[]".into())]);
        refresh(&store, "ws", "o/restored-closed", &Default::default()).unwrap();
        assert_eq!(store.get_card("ws", "c-lost").unwrap().gh_issue_number, None);
        github::set_test_gh_responses(vec![found(11), Ok(String::new()), Ok(String::new())]);
        push_local(&store, "ws", "o/restored-closed", &Default::default()).unwrap();
        let calls = gh_calls();
        assert!(calls[1].starts_with("issue list --repo o/restored-closed --state all --author @me"), "{calls:?}");
        assert!(!calls.iter().any(|call| call.starts_with("issue create")), "{calls:?}");
        assert_eq!(store.get_card("ws", "c-lost").unwrap().gh_issue_number, Some(11));

        // The issue found is another card's (two cards alike): this card gets its own.
        let mut twin = lost();
        twin.id = gh_card_id(21);
        twin.gh_issue_number = Some(21);
        let (_tmp, store) = restored_store(vec![twin, lost()]);
        github::set_test_gh_responses(vec![open_list(&[(21, "Lost stamp", &github::build_issue_body(Some("brief"), None, None))])]);
        refresh(&store, "ws", "o/restored-twin", &Default::default()).unwrap();
        github::take_test_gh_invocations();
        github::set_test_gh_responses(vec![found(21), Ok("https://github.com/o/restored-twin/issues/22".into()), Ok(String::new()), Ok(String::new())]);
        push_local(&store, "ws", "o/restored-twin", &Default::default()).unwrap();
        let calls = gh_calls();
        github::clear_test_gh_responses();
        assert_eq!(calls.iter().filter(|call| call.starts_with("issue create")).count(), 1, "{calls:?}");
        assert_eq!(store.get_card("ws", "c-lost").unwrap().gh_issue_number, Some(22));
        assert_eq!(store.get_card("ws", &gh_card_id(21)).unwrap().gh_issue_number, Some(21));
    }

    /// T3: on the first read of a restored board GitHub wins where the
    /// issue was touched since the backup was written — the card takes the
    /// issue's text and its older text is not pushed — and a card whose
    /// issue wasn't touched since pushes as on any board. Later reads of
    /// that board, and a board read as it is, leave a pending card alone.
    #[test]
    fn the_first_read_of_a_restored_board_takes_what_github_changed_since() {
        let _guard = github::test_serial_lock();
        const REPO: &str = "o/restored-wins";
        let pending = |n: u64, notes: &str| {
            let mut card = local_card(Some(n), "Mine", KanbanColumnId::Todo);
            card.notes = Some(notes.into());
            card.sync_pending = true;
            card
        };
        let listed = |n: u64, title: &str, notes: &str, updated_ms: i64| {
            let at = chrono::DateTime::from_timestamp_millis(updated_ms).unwrap().to_rfc3339();
            serde_json::json!({
                "number": n, "title": title, "body": github::build_issue_body(Some(notes), None, None),
                "assignees": [], "labels": [{"name": "status:todo"}], "state": "OPEN",
                "updatedAt": at, "createdAt": "2026-01-01T00:00:00Z",
            })
        };
        let (_tmp, store) = restored_store(vec![pending(5, "my older text"), pending(6, "an edit that never went up")]);
        let (since, _) = store.restored_from_backup("ws").unwrap();
        let hour = 60 * 60 * 1000;
        // #5 was edited on GitHub after the copy was written; #6 last changed long before.
        let list = serde_json::Value::Array(vec![
            listed(5, "A teammate's title", "a teammate's text", since + 60_000),
            listed(6, "Old", "old text", since - hour),
        ])
        .to_string();
        github::take_test_gh_invocations();
        github::set_test_gh_responses(vec![Ok(list.clone())]);
        let summary = refresh(&store, "ws", REPO, &Default::default()).unwrap();
        assert_eq!(gh_calls().len(), 1, "the read writes nothing");
        assert_eq!(summary.patched, 1);
        let five = store.get_card("ws", &gh_card_id(5)).unwrap();
        assert!(!five.sync_pending, "GitHub won");
        assert_eq!((five.title.as_str(), five.notes.as_deref()), ("A teammate's title", Some("a teammate's text")));
        // W1: and the text the card had here is kept beside the restore's copy.
        let kept = replaced_texts(&store);
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert!(kept[0].0.starts_with("ws.gh-issue-5.text-replaced-by-github-") && kept[0].0.ends_with(".txt"), "{}", kept[0].0);
        assert!(kept[0].1.contains("Title\n-----\nMine\n") && kept[0].1.contains("Brief\n-----\nmy older text\n"), "{}", kept[0].1);
        assert!(kept[0].1.contains("issue #5 of o/restored-wins"), "{}", kept[0].1);
        let six = store.get_card("ws", &gh_card_id(6)).unwrap();
        assert!(six.sync_pending, "never pushed: it still goes up");
        assert_eq!(six.notes.as_deref(), Some("an edit that never went up"));

        // The Sync that follows pushes #6 and nothing of #5.
        github::set_test_gh_responses(vec![]);
        let _ = reconcile(&store, "ws", REPO, None, &Default::default());
        let calls = gh_calls();
        assert!(calls.iter().any(|call| call.starts_with("issue view 6") || call.starts_with("issue edit 6")), "{calls:?}");
        assert!(!calls.iter().any(|call| call.starts_with("issue view 5") || call.starts_with("issue edit 5")), "{calls:?}");

        // Read once already: a card edited here afterwards is pending as on
        // any board, whatever the issue's time.
        store.with_card("ws", &gh_card_id(5), |c| {
            c.notes = Some("edited after the read".into());
            c.sync_pending = true;
            Ok(())
        })
        .unwrap();
        github::set_test_gh_responses(vec![Ok(list.clone())]);
        refresh(&store, "ws", REPO, &Default::default()).unwrap();
        github::clear_test_gh_responses();
        gh_calls();
        let five = store.get_card("ws", &gh_card_id(5)).unwrap();
        assert!(five.sync_pending);
        assert_eq!(five.notes.as_deref(), Some("edited after the read"));

        // Within the two minutes allowed for the two clocks it counts as
        // touched; an issue with no time read says nothing, and stays pending.
        let local = [pending(7, "x"), pending(8, "y"), pending(9, "z")];
        let (_tmp, other) = restored_store(local.to_vec());
        let (since, _) = other.restored_from_backup("ws").unwrap();
        let mut near = issue(7, "T", "", &[], "OPEN");
        near.updated_at = chrono::DateTime::from_timestamp_millis(since - 60_000).unwrap().to_rfc3339();
        let mut far = issue(8, "T", "", &[], "OPEN");
        far.updated_at = chrono::DateTime::from_timestamp_millis(since - 5 * 60_000).unwrap().to_rfc3339();
        let unknown = issue(9, "T", "", &[], "OPEN");
        let cards = other.load("ws").unwrap();
        assert!(github_wins_where_touched(&other, "ws", REPO, &[near, far, unknown], &cards, since));
        let pendings: Vec<bool> = other.load("ws").unwrap().iter().map(|c| c.sync_pending).collect();
        assert_eq!(pendings, [false, true, true]);
    }

    /// The `…text-replaced-by-github-<ms>.txt` files beside the restore's
    /// kept copy: (name, contents), by name.
    fn replaced_texts(store: &KanbanStore) -> Vec<(String, String)> {
        let kept = store.restore_kept_as("ws").expect("a restored board");
        let mut found: Vec<(String, String)> = std::fs::read_dir(kept.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".text-replaced-by-github-"))
            .map(|e| (e.file_name().to_string_lossy().into_owned(), std::fs::read_to_string(e.path()).unwrap()))
            .collect();
        found.sort();
        found
    }

    /// W1: GitHub moves `updatedAt` for a label, a claim marker, an
    /// assignment or a comment too. A pending card whose issue was only
    /// touched that way — the title and text on GitHub are the card's — just
    /// loses its pending mark: nothing differs, nothing is written. One
    /// whose text differs takes GitHub's, and the text it had here is on
    /// disk first; if that can't be written, the card stays pending.
    #[test]
    fn a_local_edit_that_never_went_up_is_not_dropped_without_a_trace() {
        let _guard = github::test_serial_lock();
        const REPO: &str = "o/restored-kept";
        let pending = |n: u64, title: &str, notes: &str, knowledge: Option<&str>| {
            let mut card = local_card(Some(n), title, KanbanColumnId::Todo);
            card.notes = Some(notes.into());
            card.knowledge = knowledge.map(str::to_string);
            card.sync_pending = true;
            card
        };
        let (tmp, store) = restored_store(vec![
            pending(5, "Same", "the same text", Some("what we learned")),
            pending(6, "Mine", "an edit that never went up", Some("local notes")),
        ]);
        let (since, _) = store.restored_from_backup("ws").unwrap();
        let touched = chrono::DateTime::from_timestamp_millis(since + 60_000).unwrap().to_rfc3339();
        let row = |n: u64, title: &str, body: String, labels: &[&str]| {
            serde_json::json!({
                "number": n, "title": title, "body": body, "assignees": [{"login": "matteo"}],
                "labels": labels.iter().map(|l| serde_json::json!({"name": l})).collect::<Vec<_>>(),
                "state": "OPEN", "updatedAt": touched, "createdAt": "2026-01-01T00:00:00Z",
            })
        };
        // #5: only labelled, assigned and claimed since (Plyloft's own writes);
        // its title and text are the card's. #6: a teammate rewrote it.
        let claim = crate::device_claim::DeviceClaim { device: "dev-pro".into(), name: "MacBook Pro".into(), login: None, at: "t".into() };
        let same = crate::device_claim::with_claim(&github::build_issue_body(Some("the same text"), Some("what we learned"), None), Some(&claim));
        let list = serde_json::Value::Array(vec![
            row(5, "Same", same, &["status:in-progress"]),
            row(6, "A teammate's title", github::build_issue_body(Some("a teammate's text"), None, None), &["status:todo"]),
        ])
        .to_string();
        let boards = tmp.path().join(crate::kanban::KANBAN_SUBDIR);
        let names = |dir: &std::path::Path| {
            let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            names
        };
        let before = names(&boards);

        // #5 by itself: equal text, so the mark goes and nothing is written.
        let local = store.load("ws").unwrap();
        let issues: Vec<GhIssue> = serde_json::from_str(&list).unwrap();
        assert!(github_wins_where_touched(&store, "ws", REPO, &issues[..1], &local, since), "#5: the mark is cleared");
        assert!(!store.get_card("ws", &gh_card_id(5)).unwrap().sync_pending);
        assert_eq!(names(&boards), before, "equal text: nothing is written");
        assert!(replaced_texts(&store).is_empty());

        // The read: #6 takes GitHub's text, and what it had here is on disk.
        github::take_test_gh_invocations();
        github::set_test_gh_responses(vec![Ok(list)]);
        refresh(&store, "ws", REPO, &Default::default()).unwrap();
        github::clear_test_gh_responses();
        assert_eq!(gh_calls().len(), 1);
        let six = store.get_card("ws", &gh_card_id(6)).unwrap();
        assert!(!six.sync_pending);
        assert_eq!((six.title.as_str(), six.notes.as_deref(), six.knowledge.as_deref()), ("A teammate's title", Some("a teammate's text"), None));
        let kept = replaced_texts(&store);
        assert_eq!(kept.len(), 1, "one file, for #6 only: {kept:?}");
        let (name, text) = &kept[0];
        assert!(name.starts_with("ws.gh-issue-6.text-replaced-by-github-") && name.ends_with(".txt"), "{name}");
        for part in ["Title
-----
Mine
", "Brief
-----
an edit that never went up
", "Knowledge
---------
local notes
", "issue #6 of o/restored-kept"] {
            assert!(text.contains(part), "{part:?} in {text}");
        }
        // #5 keeps what it had (equal to GitHub's), and stays settled.
        let five = store.get_card("ws", &gh_card_id(5)).unwrap();
        assert_eq!((five.title.as_str(), five.notes.as_deref(), five.sync_pending), ("Same", Some("the same text"), false));

        // The kept text is no board, no set-aside file and no marker to any reader.
        assert!(!name.ends_with(".json") && !name.contains(crate::atomic::UNREADABLE_SUFFIX) && !name.ends_with(".restored"));
        assert_eq!(crate::history_search::classify(&format!("kanban/workspaces/{name}")), None);
    }

    /// W1: when the text can't be kept, the card stays pending and pushes as
    /// on any board — GitHub's text has a history to come back from, the
    /// local one has none.
    #[test]
    fn a_text_that_cannot_be_kept_stays_pending() {
        let mut card = local_card(Some(6), "Mine", KanbanColumnId::Todo);
        card.notes = Some("an edit that never went up".into());
        card.sync_pending = true;
        // A board that was read as it is has no restore to keep the text beside.
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", card.clone()).unwrap();
        assert!(keep_replaced_text(&store, "ws", "o/r", &card, 6).is_err());
        let mut changed = issue(6, "A teammate's title", "", &[], "OPEN");
        changed.updated_at = chrono::Utc::now().to_rfc3339();
        assert!(!github_wins_where_touched(&store, "ws", "o/r", &[changed], &[card], 0));
        let kept = store.get_card("ws", &gh_card_id(6)).unwrap();
        assert!(kept.sync_pending, "still pending");
        assert_eq!(kept.notes.as_deref(), Some("an edit that never went up"));
    }

    /// T2: the board is restored and nothing can be read from GitHub in
    /// that session (offline); Plyloft quits. The next launch finds an
    /// ordinary board file — and its marker. Issue writes are held again,
    /// the first pass reads before it writes, the card whose number was in
    /// the lost save gets its issue back (no second issue, no second card),
    /// and the marker is gone after the read.
    #[test]
    fn a_restored_board_still_reads_first_after_a_relaunch() {
        let _guard = github::test_serial_lock();
        const REPO: &str = "o/restored-relaunch";
        let lost = KanbanCard::new("c-lost".into(), "ws".into(), "Lost stamp".into(), Some("brief".into()), KanbanColumnId::Todo);
        let mut pending = local_card(Some(5), "Edited here", KanbanColumnId::Todo);
        pending.sync_pending = true;
        let (tmp, store) = restored_store(vec![lost, pending]);
        let marker = tmp.path().join(crate::kanban::KANBAN_SUBDIR).join("ws.json.restored");
        assert!(marker.exists());
        // Offline all session: the read fails, nothing is sent.
        github::take_test_gh_invocations();
        github::set_test_gh_responses(vec![Err("error connecting to api.github.com".into())]);
        assert!(reconcile(&store, "ws", REPO, None, &Default::default()).is_err());
        assert_eq!(gh_calls().len(), 1);
        drop(store);

        // The relaunch.
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(store.load("ws").unwrap().len(), 2);
        assert_eq!(store.not_whole("ws"), None, "an ordinary board file by now");
        assert_eq!(store.restored_awaiting_pull(), ["ws"], "writes are held again");
        let workspace: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "id": "ws", "name": "Lyra", "cwd": "/x", "createdAt": 1, "lastOpenedAt": 2,
            "kanbanSyncMode": "githubIssues", "githubOwnerRepo": REPO,
        }))
        .unwrap();
        assert!(restored_board_holds(&store.restored_awaiting_pull(), std::slice::from_ref(&workspace), REPO));

        // Still offline: the Sync fails at its first read; no write was tried.
        github::set_test_gh_responses(vec![Err("error connecting to api.github.com".into())]);
        assert!(reconcile(&store, "ws", REPO, None, &Default::default()).is_err());
        let calls = gh_calls();
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert!(calls[0].starts_with("issue list --repo o/restored-relaunch --state open"), "{calls:?}");
        assert!(marker.exists());

        // Online: the read comes first and gives the lost stamp its issue back.
        let body = github::build_issue_body(Some("brief"), None, None);
        github::set_test_gh_responses(vec![open_list_of(&[(11, "Lost stamp", &body)], &[(5, "Edited here", "")])]);
        let _ = reconcile(&store, "ws", REPO, None, &Default::default());
        let calls = gh_calls();
        github::clear_test_gh_responses();
        assert!(calls[0].starts_with("issue list --repo o/restored-relaunch --state open"), "{calls:?}");
        assert!(calls.iter().skip(1).any(|call| call.starts_with("issue view 5") || is_issue_write(call)), "then the pending card: {calls:?}");
        assert!(!calls.iter().any(|call| call.starts_with("issue create")), "no second issue: {calls:?}");
        let cards = store.load("ws").unwrap();
        assert_eq!(cards.iter().find(|c| c.id == "c-lost").unwrap().gh_issue_number, Some(11));
        assert!(!cards.iter().any(|c| c.id == gh_card_id(11)), "no second card");
        assert!(store.restored_awaiting_pull().is_empty());
        assert!(!marker.exists(), "said (by the fixture) and read: the marker is gone");

        // And the launch after that is an ordinary one.
        let after = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        after.load("ws").unwrap();
        assert_eq!(after.restored_from_backup("ws"), None);
    }

    /// R2: only an issue opened since the copy was written, that no card
    /// holds, with exactly this card's title and brief, is the card's; a
    /// board read as it is relinks nothing.
    #[test]
    fn relinking_takes_only_an_issue_that_can_only_be_the_cards() {
        let _guard = github::test_serial_lock();
        let card = |id: &str, title: &str| KanbanCard::new(id.into(), "ws".into(), title.into(), Some("brief".into()), KanbanColumnId::Todo);
        let body = github::build_issue_body(Some("brief"), None, None);
        let at = |ms: i64| Some(chrono::DateTime::from_timestamp_millis(ms).unwrap().to_rfc3339());
        let now = crate::kanban::now_ms();
        let mut old = issue(30, "Old", &body, &[], "OPEN");
        old.created_at = at(now - 60 * 60 * 1000);
        let mut other_brief = issue(31, "Other brief", "<!-- atelier:notes -->\nelse\n<!-- /atelier:notes -->\n", &[], "OPEN");
        other_brief.created_at = at(now);
        let mut closed = issue(32, "Closed", &body, &[], "CLOSED");
        closed.created_at = at(now);
        let mut twice_a = issue(33, "Twice", &body, &[], "OPEN");
        twice_a.created_at = at(now);
        let mut twice_b = twice_a.clone();
        twice_b.number = 34;
        let mut mine = issue(35, "Mine", &body, &[], "OPEN");
        mine.created_at = at(now);
        let issues = [old, other_brief, closed, twice_a, twice_b, mine];
        let (_tmp, store) = restored_store(vec![
            card("old", "Old"),
            card("other", "Other brief"),
            card("closed", "Closed"),
            card("twice", "Twice"),
            card("mine", "Mine"),
        ]);
        let local = store.load("ws").unwrap();
        let (since, _) = store.restored_from_backup("ws").unwrap();
        assert!(relink_restored(&store, "ws", "o/restored-rules", &issues, &local, since));
        let numbers: Vec<(String, Option<u64>)> = store.load("ws").unwrap().into_iter().map(|c| (c.id, c.gh_issue_number)).collect();
        assert_eq!(
            numbers,
            [("old", None), ("other", None), ("closed", None), ("twice", None), ("mine", Some(35))]
                .map(|(id, n)| (id.to_string(), n))
        );
    }

    #[test]
    fn a_restored_issue_board_holds_its_repository_until_it_was_read() {
        let ws = |id: &str, mode: &str, repo: Option<&str>| -> crate::workspace::Workspace {
            serde_json::from_value(serde_json::json!({
                "id": id, "name": id, "cwd": "/x", "createdAt": 1, "lastOpenedAt": 2,
                "kanbanSyncMode": mode, "githubOwnerRepo": repo,
            }))
            .unwrap()
        };
        let workspaces = [
            ws("issues", "githubIssues", Some("Owner/Lyra")),
            ws("local", "local", Some("owner/site")),
            ws("other", "githubIssues", Some("owner/other")),
        ];
        let awaiting = ["issues".to_string(), "local".to_string()];
        assert!(restored_board_holds(&awaiting, &workspaces, "owner/lyra"), "whatever the case");
        assert!(!restored_board_holds(&awaiting, &workspaces, "owner/site"), "a board that isn't on GitHub Issues");
        assert!(!restored_board_holds(&awaiting, &workspaces, "owner/other"), "a board read as it is");
        assert!(!restored_board_holds(&[], &workspaces, "owner/lyra"), "read once: released");
        // `setup` gives the hold this answer over the live stores.
        let setup = include_str!("lib.rs");
        assert!(setup.contains("github::hold_issue_writes_while(Box::new(move |repo| {"));
        assert!(setup.contains("github_sync::restored_board_holds(&awaiting, &workspaces.snapshot().workspaces, repo)"));
    }

    fn local_card(number: Option<u64>, title: &str, column: KanbanColumnId) -> KanbanCard {
        let mut c = KanbanCard::new(
            number.map(gh_card_id).unwrap_or_else(|| "local-1".into()),
            "ws".into(),
            title.into(),
            None,
            column,
        );
        c.gh_issue_number = number;
        c
    }

    fn assigned(mut i: GhIssue, logins: &[&str]) -> GhIssue {
        i.assignees = logins.iter().map(|l| GhUser { login: l.to_string() }).collect();
        i
    }

    fn logins(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn assignees_ride_on_create_and_patch() {
        let open = |a: &[&str]| assigned(issue(62, "T", "", &["status:todo"], "OPEN"), a);
        let plan = reconcile_plan(&[open(&["test-owner"])], &[]);
        match &plan.actions[0] {
            ReconcileAction::Create(card) => {
                assert_eq!(card.gh_assignees, logins(&["test-owner"]))
            }
            other => panic!("expected Create, got {other:?}"),
        }

        // Only the assignees changed: a patch that leaves the column alone.
        let local = local_card(Some(62), "T", KanbanColumnId::Todo);
        let plan = reconcile_plan(&[open(&["test-owner"])], std::slice::from_ref(&local));
        match &plan.actions[..] {
            [ReconcileAction::Patch { gh_assignees, column_id, title, .. }] => {
                assert_eq!(*gh_assignees, logins(&["test-owner"]));
                assert_eq!(*column_id, None);
                assert_eq!(title, "T");
            }
            other => panic!("expected one Patch, got {other:?}"),
        }

        // Same assignees → nothing to do; unassigned on GitHub → cleared.
        let mut claimed = local.clone();
        claimed.gh_assignees = logins(&["test-owner"]);
        assert!(reconcile_plan(&[open(&["test-owner"])], std::slice::from_ref(&claimed))
            .actions
            .is_empty());
        match &reconcile_plan(&[open(&[])], &[claimed]).actions[..] {
            [ReconcileAction::Patch { gh_assignees, .. }] => assert!(gh_assignees.is_empty()),
            other => panic!("expected one Patch, got {other:?}"),
        }
    }

    #[test]
    fn a_pending_card_still_takes_its_assignees_and_nothing_else() {
        let mut pending = local_card(Some(62), "local title", KanbanColumnId::InProgress);
        pending.sync_pending = true;
        let plan = reconcile_plan(
            &[assigned(issue(62, "remote title", "", &["status:todo"], "OPEN"), &["hubot"])],
            &[pending],
        );
        match &plan.actions[..] {
            [ReconcileAction::SetAssignees { card_id, gh_assignees, .. }] => {
                assert_eq!(card_id, "gh-issue-62");
                assert_eq!(*gh_assignees, logins(&["hubot"]));
            }
            other => panic!("expected only SetAssignees, got {other:?}"),
        }
    }

    #[test]
    fn a_label_push_sends_the_current_column_and_keeps_a_mid_push_move_pending() {
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .create_card("ws", local_card(Some(62), "T", KanbanColumnId::InProgress))
            .unwrap();

        // Resume pushes In Progress; the user moves the card to Todo meanwhile.
        let mut sent = Vec::new();
        let delivered = push_status_labels_with(&store, "ws", "gh-issue-62", |add, _| {
            sent.push(add.join(","));
            store
                .with_card("ws", "gh-issue-62", |c| {
                    c.column_id = KanbanColumnId::Todo;
                    Ok(())
                })
                .unwrap();
            Ok(())
        });
        assert!(!delivered);
        assert_eq!(sent, vec!["status:in-progress"]);
        assert!(
            store.get_card("ws", "gh-issue-62").unwrap().gh_labels_pending,
            "a stale push must not acknowledge the newer move"
        );

        // The move's own push (or Sync) reads the card now: Todo, delivered.
        let mut sent = Vec::new();
        let delivered = push_status_labels_with(&store, "ws", "gh-issue-62", |add, _| {
            sent.push(add.join(","));
            Ok(())
        });
        assert!(delivered);
        assert_eq!(sent, vec!["status:todo"]);
        assert!(!store.get_card("ws", "gh-issue-62").unwrap().gh_labels_pending);
    }

    /// 1.168.1 (E2): a card's own models are a preference of this Mac:
    /// the push of a card that has them writes the same issue as without.
    #[test]
    fn a_cards_own_models_never_reach_its_issue() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut plain = local_card(Some(63), "T", KanbanColumnId::Todo);
        plain.sync_pending = true;
        plain.notes = Some("the brief".into());
        let mut chosen = plain.clone();
        let mut models = crate::settings::WorkspaceModels::default();
        models.rows.claude.builder = Some("opus-secret-model".into());
        models.rows.codex.challenger_reasoning = Some("high".into());
        chosen.models = Some(models);
        store.create_card("ws", chosen.clone()).unwrap();

        let mut push = |card: &KanbanCard| {
            crate::github::take_test_gh_invocations();
            // 1.173.0 (C2): the live read for the claim marker, the edit, the labels.
            crate::github::set_test_gh_responses(vec![
                Ok(r#"{"number":63,"title":"T","body":""}"#.to_string()),
                Ok(String::new()),
                Ok(String::new()),
            ]);
            assert_eq!(push_pending_card(&store, "o/r", "ws", card), Ok(63));
            let calls = crate::github::take_test_gh_invocations();
            crate::github::clear_test_gh_responses();
            calls
        };
        let with = push(&chosen);
        let without = push(&plain);
        assert_eq!(with, without, "the same gh calls");
        let all = with.concat().join(" ");
        assert!(!all.contains("opus-secret-model") && !all.contains("models"), "{all}");
    }

    #[test]
    fn a_full_retry_pushes_labels_for_the_current_column_not_its_snapshot() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut stale = local_card(Some(62), "T", KanbanColumnId::Todo);
        stale.sync_pending = true;
        store.create_card("ws", stale.clone()).unwrap();
        // Start build moved the card after Sync took its snapshot.
        store
            .with_card("ws", "gh-issue-62", |c| {
                c.column_id = KanbanColumnId::InProgress;
                Ok(())
            })
            .unwrap();

        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![
            Ok(r#"{"number":62,"title":"T","body":""}"#.to_string()), // C2: the live marker read
            // 1.175.0 (D3): the text is as GitHub has it, so no part is written.
            Err("error connecting to api.github.com".into()), // labels
        ]);
        assert_eq!(push_pending_card(&store, "o/r", "ws", &stale), Ok(62));
        let calls = crate::github::take_test_gh_invocations();
        crate::github::clear_test_gh_responses();

        assert_eq!(calls.len(), 2, "{calls:?}");
        let labels = calls[1].join(" ");
        assert!(labels.contains("--add-label status:in-progress"), "{labels}");
        assert!(labels.contains("--remove-label status:todo"), "{labels}");
        assert!(
            store.get_card("ws", "gh-issue-62").unwrap().gh_labels_pending,
            "a failed label half stays queued for the next Sync"
        );
    }

    // ── 1.173.0 (C1): the area labels ─────────────────────────────────

    fn resolved(id: &str, branch: &str, label: Option<&str>) -> crate::areas::ResolvedArea {
        crate::areas::ResolvedArea {
            id: id.into(),
            name: id.into(),
            path: if id == "app" { String::new() } else { format!("{id}/") },
            root: id == "app",
            first: id == "app",
            target_branch: Some(branch.into()),
            branch: branch.into(),
            version_files: None,
            tag_prefix: String::new(),
            label: label.map(String::from).unwrap_or_else(|| crate::areas::default_label(id)),
            look_at: None,
            release_kind: None,
        }
    }

    fn ia(area: Option<&str>, label: Option<&str>) -> IssueArea {
        IssueArea { area: area.map(String::from), label: label.map(String::from), extra: Vec::new() }
    }

    fn lyra() -> AreaLabels {
        AreaLabels::new(vec![resolved("app", "staging", None), resolved("site", "main", None)])
    }

    fn in_area(mut card: KanbanCard, area: Option<&str>, seen: Option<&str>) -> KanbanCard {
        card.area = area.map(String::from);
        card.gh_area_label = seen.map(String::from);
        card
    }

    #[test]
    fn an_issues_area_label_maps_in_without_case_and_names_an_unknown_one() {
        let labels = AreaLabels::new(vec![resolved("app", "staging", None), resolved("site", "main", Some("Website"))]);
        let read = |names: &[&str]| area_from_issue(&issue(1, "T", "", names, "OPEN"), &labels, &[]);
        assert_eq!(read(&["status:todo", "area:app"]), ia(Some("app"), Some("area:app")));
        assert_eq!(read(&["AREA:APP"]), ia(Some("app"), Some("AREA:APP")));
        assert_eq!(read(&["website"]).area.as_deref(), Some("site"), "an area's own label");
        assert_eq!(read(&["area:site"]), ia(None, Some("area:site")), "site's label is Website");
        assert_eq!(read(&["area:docs", "bug"]), ia(None, Some("area:docs")));
        assert_eq!(read(&["status:todo", "bug"]), ia(None, None));
        // Two area labels and nothing seen before (a new issue): no area,
        // nothing taken off, both named.
        assert_eq!(read(&["website", "area:app"]), ia(None, Some("area:app,website")));
        // Seen one, the other added later: the other, and the seen one off.
        let seen = |names: &[&str], was: &str| area_from_issue(&issue(1, "T", "", names, "OPEN"), &labels, &[was.to_string()]);
        let moved = seen(&["website", "area:app"], "area:app");
        assert_eq!((moved.area.as_deref(), moved.label.as_deref(), moved.extra), (Some("site"), Some("website"), vec!["area:app".to_string()]));
        // Seen neither: can't tell.
        assert_eq!(seen(&["website", "area:app"], "area:docs"), ia(None, Some("area:app,website")));
    }

    #[test]
    fn a_new_issue_comes_in_with_its_area_with_none_or_with_the_label_it_didnt_know() {
        let issues = [
            issue(1, "Pricing", "", &["status:todo", "Area:Site"], "OPEN"),
            issue(2, "Untagged", "", &["status:todo"], "OPEN"),
            issue(3, "Docs", "", &["area:docs"], "OPEN"),
        ];
        let plan = reconcile_plan_with(&issues, &[], &lyra());
        let made: Vec<(Option<String>, Option<String>)> = plan
            .actions
            .iter()
            .map(|a| match a {
                ReconcileAction::Create(c) => (c.area.clone(), c.gh_area_label.clone()),
                other => panic!("expected Create, got {other:?}"),
            })
            .collect();
        assert_eq!(
            made,
            vec![
                (Some("site".into()), Some("Area:Site".into())),
                (None, None),
                (None, Some("area:docs".into())),
            ]
        );
        // Without areas nothing about areas is read.
        match &reconcile_plan(&issues[..1], &[]).actions[..] {
            [ReconcileAction::Create(c)] => assert_eq!((c.area.as_deref(), c.gh_area_label.as_deref()), (None, None)),
            other => panic!("{other:?}"),
        }
    }

    fn area_of(plan: &ReconcilePlan) -> Option<IssueArea> {
        match &plan.actions[..] {
            [] => None,
            [ReconcileAction::Patch { area, .. }] => area.as_ref().map(|p| IssueArea {
                area: p.area.clone(),
                label: p.label.clone(),
                extra: Vec::new(),
            }),
            other => panic!("expected one Patch, got {other:?}"),
        }
    }

    #[test]
    fn a_label_removed_on_github_wins_the_next_pull_and_a_change_follows_the_issue() {
        let synced = in_area(local_card(Some(5), "T", KanbanColumnId::Todo), Some("site"), Some("area:site"));
        let labels = lyra();
        // A person took the label off: the card has no area, so it asks.
        let removed = reconcile_plan_with(&[issue(5, "T", "", &["status:todo"], "OPEN")], std::slice::from_ref(&synced), &labels);
        assert_eq!(area_of(&removed), Some(ia(None, None)));
        // The other Mac moved it to App.
        let moved = reconcile_plan_with(&[issue(5, "T", "", &["status:todo", "area:app"], "OPEN")], std::slice::from_ref(&synced), &labels);
        assert_eq!(area_of(&moved), Some(ia(Some("app"), Some("area:app"))));
        // Nothing changed: no patch at all.
        let same = reconcile_plan_with(&[issue(5, "T", "", &["status:todo", "area:site"], "OPEN")], std::slice::from_ref(&synced), &labels);
        assert!(same.actions.is_empty(), "{:?}", same.actions);
    }

    #[test]
    fn a_card_whose_own_area_is_still_on_its_way_up_keeps_it_on_the_pull() {
        // Changed here from App to Site; the label push hasn't landed yet.
        let changed = in_area(local_card(Some(5), "T", KanbanColumnId::Todo), Some("site"), Some("area:app"));
        let plan = reconcile_plan_with(&[issue(5, "T", "", &["status:todo", "area:app"], "OPEN")], &[changed], &lyra());
        assert_eq!(area_of(&plan), None);
        // Made here with an area, its issue not labelled yet.
        let made = in_area(local_card(Some(6), "T", KanbanColumnId::Todo), Some("site"), None);
        let plan = reconcile_plan_with(&[issue(6, "T", "", &["status:todo"], "OPEN")], &[made], &lyra());
        assert_eq!(area_of(&plan), None);
    }

    #[test]
    fn exempt_cards_and_boards_without_areas_never_read_an_area_label() {
        let mut skill_started = in_area(local_card(Some(7), "T", KanbanColumnId::Todo), Some("default"), None);
        skill_started.title = "T".into();
        let plan = reconcile_plan_with(&[issue(7, "T", "", &["status:todo", "area:app"], "OPEN")], &[skill_started], &lyra());
        assert_eq!(area_of(&plan), None, "\"default\" is the workspace's, never an area");
        let plain = local_card(Some(8), "T", KanbanColumnId::Todo);
        let plan = reconcile_plan(&[issue(8, "T", "", &["status:todo", "area:app"], "OPEN")], &[plain]);
        assert_eq!(area_of(&plan), None);
    }

    #[test]
    fn a_started_card_never_takes_an_area_whose_cards_go_to_another_branch() {
        let mut started = in_area(local_card(Some(9), "T", KanbanColumnId::InProgress), Some("site"), Some("area:site"));
        started.branch_name = Some("plyloft/card-9".into());
        started.worktree_base = Some(
            serde_json::from_value(serde_json::json!({"commit": "abc", "refName": "origin/main", "source": "origin"})).unwrap(),
        );
        // App's cards go to staging; its copy was cut from main.
        let plan = reconcile_plan_with(&[issue(9, "T", "", &["status:in-progress", "area:app"], "OPEN")], &[started], &lyra());
        assert_eq!(area_of(&plan), Some(ia(None, Some("area:app"))), "it asks instead");
    }

    #[test]
    fn the_label_to_push_swaps_on_a_change_and_is_nothing_once_the_issue_has_it() {
        let labels = lyra();
        let card = |area: Option<&str>, seen: Option<&str>| in_area(local_card(Some(5), "T", KanbanColumnId::Todo), area, seen);
        assert_eq!(area_label_to_push(&card(Some("site"), None), &labels), Some(("area:site".into(), vec![])));
        assert_eq!(
            area_label_to_push(&card(Some("site"), Some("area:app")), &labels),
            Some(("area:site".into(), vec!["area:app".to_string()])),
            "an area change swaps the label"
        );
        assert_eq!(area_label_to_push(&card(Some("site"), Some("AREA:SITE")), &labels), None, "already there");
        assert_eq!(area_label_to_push(&card(None, Some("area:docs")), &labels), None, "no area: nothing goes up");
        assert_eq!(area_label_to_push(&card(Some("default"), None), &labels), None, "\"default\" has no label");
        assert_eq!(area_label_to_push(&card(Some("docs"), None), &labels), None, "an unlisted area has none");
        assert_eq!(area_label_to_push(&card(Some("site"), None), &AreaLabels::default()), None, "no areas");
        let mut skill = skill_card(Some(34));
        skill.area = Some("site".into());
        assert_eq!(area_label_to_push(&skill, &labels), None, "a skill card never has one");
    }

    #[test]
    fn an_area_label_push_creates_the_label_once_swaps_and_is_idempotent() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", in_area(local_card(Some(5), "T", KanbanColumnId::Todo), Some("site"), None)).unwrap();
        let labels = lyra();

        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![
            Err("could not add label: 'area:site' not found".into()), // issue edit
            Ok(String::new()),                                          // label create
            Ok(String::new()),                                          // issue edit again
        ]);
        assert_eq!(
            push_area_label(&store, "o/r", "ws", "gh-issue-5", 5, &labels),
            AreaPush::Sent { added: "area:site".into(), removed: vec![] }
        );
        let calls: Vec<String> = crate::github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
        assert_eq!(
            calls,
            vec![
                "issue edit 5 --repo o/r --add-label area:site",
                "label create area:site --repo o/r --color d0d7de --force",
                "issue edit 5 --repo o/r --add-label area:site",
            ]
        );
        assert_eq!(store.get_card("ws", "gh-issue-5").unwrap().gh_area_label.as_deref(), Some("area:site"));

        // Pushed again (Sync, the other Mac): nothing to send.
        assert_eq!(push_area_label(&store, "o/r", "ws", "gh-issue-5", 5, &labels), AreaPush::NothingDue);
        assert!(crate::github::take_test_gh_invocations().is_empty());

        // Its area changes to App: one edit, the new label on and the old off.
        store.with_card("ws", "gh-issue-5", |c| { c.area = Some("app".into()); Ok(()) }).unwrap();
        crate::github::set_test_gh_responses(vec![Ok(String::new())]);
        assert!(matches!(push_area_label(&store, "o/r", "ws", "gh-issue-5", 5, &labels), AreaPush::Sent { .. }));
        let calls: Vec<String> = crate::github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
        assert_eq!(calls, vec!["issue edit 5 --repo o/r --add-label area:app --remove-label area:site"]);
        assert_eq!(store.get_card("ws", "gh-issue-5").unwrap().gh_area_label.as_deref(), Some("area:app"));

        // Offline: the card keeps its due label for the next Sync.
        store.with_card("ws", "gh-issue-5", |c| { c.area = Some("site".into()); Ok(()) }).unwrap();
        crate::github::set_test_gh_responses(vec![Err("error connecting to api.github.com".into())]);
        assert_eq!(push_area_label(&store, "o/r", "ws", "gh-issue-5", 5, &labels), AreaPush::Failed);
        assert!(area_label_failed("ws", "gh-issue-5"), "the card page says so");
        crate::github::take_test_gh_invocations();
        crate::github::clear_test_gh_responses();
        let card = store.get_card("ws", "gh-issue-5").unwrap();
        assert_eq!(card.gh_area_label.as_deref(), Some("area:app"));
        assert!(area_label_to_push(&card, &labels).is_some());
    }

    #[test]
    fn a_swap_whose_old_label_was_deleted_from_the_repository_still_puts_the_new_one_on() {
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", in_area(local_card(Some(5), "T", KanbanColumnId::Todo), Some("site"), Some("area:app"))).unwrap();
        let mut sent = Vec::new();
        let ok = push_area_label_with(
            &store,
            "ws",
            "gh-issue-5",
            &lyra(),
            |add, remove| {
                sent.push(format!("+{} -{}", add.join(","), remove.join(",")));
                if remove.is_empty() { Ok(()) } else { Err("'area:app' not found".into()) }
            },
            |_| panic!("the new label exists"),
        );
        assert_eq!(ok, AreaPush::Sent { added: "area:site".into(), removed: vec![] });
        assert_eq!(sent, vec!["+area:site -area:app", "+area:site -"]);
    }

    #[test]
    fn a_missing_new_label_and_a_deleted_old_one_in_the_same_push() {
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", in_area(local_card(Some(5), "T", KanbanColumnId::Todo), Some("site"), Some("area:app"))).unwrap();
        let mut sent = Vec::new();
        let mut made = Vec::new();
        let exists = std::cell::Cell::new(false);
        let push = push_area_label_with(
            &store,
            "ws",
            "gh-issue-5",
            &lyra(),
            |add, remove| {
                sent.push(format!("+{} -{}", add.join(","), remove.join(",")));
                // gh names the deleted old label first.
                if !remove.is_empty() {
                    Err("'area:app' not found".into())
                } else if !exists.get() {
                    Err("'area:site' not found".into())
                } else {
                    Ok(())
                }
            },
            |name| {
                made.push(name.to_string());
                exists.set(true);
                Ok(())
            },
        );
        assert_eq!(push, AreaPush::Sent { added: "area:site".into(), removed: vec![] });
        assert_eq!(sent, vec!["+area:site -area:app", "+area:site -", "+area:site -"]);
        assert_eq!(made, vec!["area:site"], "created once");
        assert_eq!(store.get_card("ws", "gh-issue-5").unwrap().gh_area_label.as_deref(), Some("area:site"));
    }

    #[test]
    fn a_sync_sends_a_due_area_label_before_it_plans_the_pull() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", in_area(local_card(Some(5), "T", KanbanColumnId::Todo), Some("site"), None)).unwrap();
        let list = serde_json::json!([
            {"number": 5, "title": "T", "body": "", "state": "OPEN", "assignees": [],
             "labels": [{"name": "status:todo"}, {"name": "area:site"}]}
        ]);
        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![Ok(list.to_string()), Ok(String::new())]);
        reconcile(&store, "ws", "o/r", None, &lyra()).unwrap();
        let calls: Vec<String> = crate::github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
        crate::github::clear_test_gh_responses();
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert!(calls[0].starts_with("issue list"), "{}", calls[0]);
        assert_eq!(calls[1], "issue edit 5 --repo o/r --add-label area:site");
        let card = store.get_card("ws", "gh-issue-5").unwrap();
        assert_eq!((card.area.as_deref(), card.gh_area_label.as_deref()), (Some("site"), Some("area:site")));

        // The next Sync, after a person took the label off: the card asks.
        let bare = serde_json::json!([
            {"number": 5, "title": "T", "body": "", "state": "OPEN", "assignees": [], "labels": [{"name": "status:todo"}]}
        ]);
        crate::github::set_test_gh_responses(vec![Ok(bare.to_string())]);
        reconcile(&store, "ws", "o/r", None, &lyra()).unwrap();
        let calls = crate::github::take_test_gh_invocations();
        crate::github::clear_test_gh_responses();
        assert_eq!(calls.len(), 1, "nothing is put back: {calls:?}");
        let card = store.get_card("ws", "gh-issue-5").unwrap();
        assert_eq!((card.area.as_deref(), card.gh_area_label.as_deref()), (None, None));
    }

    // ── C1 Challenger round 1 ───────────────────────────────────────

    #[test]
    fn an_area_changed_mid_push_records_what_the_issue_has_so_its_push_takes_it_off() {
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", in_area(local_card(Some(5), "T", KanbanColumnId::Todo), Some("site"), None)).unwrap();
        let labels = lyra();
        let first = push_area_label_with(
            &store,
            "ws",
            "gh-issue-5",
            &labels,
            |_, _| {
                store.with_card("ws", "gh-issue-5", |c| { c.area = Some("app".into()); Ok(()) }).unwrap();
                Ok(())
            },
            |_| Ok(()),
        );
        assert!(matches!(first, AreaPush::Sent { .. }));
        let card = store.get_card("ws", "gh-issue-5").unwrap();
        assert_eq!(card.gh_area_label.as_deref(), Some("area:site"), "the issue has area:site now");
        let mut sent = Vec::new();
        push_area_label_with(&store, "ws", "gh-issue-5", &labels, |add, remove| {
            sent.push(format!("+{} -{}", add.join(","), remove.join(",")));
            Ok(())
        }, |_| Ok(()));
        assert_eq!(sent, vec!["+area:app -area:site"]);
    }

    #[test]
    fn a_label_is_missing_only_when_gh_names_it_quoted() {
        assert!(label_not_found("could not add label: 'area:site' not found", "area:site"));
        assert!(label_not_found("'AREA:SITE' not found", "area:site"));
        assert!(!label_not_found("could not add label: 'area:site-old' not found", "area:site"));
        assert!(!label_not_found("issue not found", "area:site"));
    }

    #[test]
    fn two_area_labels_on_one_issue_lose_the_other_on_sync_and_a_change_to_it_never_switches_back() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", in_area(local_card(Some(5), "T", KanbanColumnId::Todo), Some("site"), Some("area:site"))).unwrap();
        let two = serde_json::json!([
            {"number": 5, "title": "T", "body": "", "state": "OPEN", "assignees": [],
             "labels": [{"name": "status:todo"}, {"name": "area:site"}, {"name": "area:app"}]}
        ]);
        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![Ok(two.to_string()), Ok(String::new())]);
        reconcile(&store, "ws", "o/r", None, &lyra()).unwrap();
        let calls: Vec<String> = crate::github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
        // Both Macs read the first listed (App); the other comes off.
        assert_eq!(calls[1..], ["issue edit 5 --repo o/r --remove-label area:site".to_string()]);
        let card = store.get_card("ws", "gh-issue-5").unwrap();
        assert_eq!(card.area.as_deref(), Some("app"));

        // The person changes it to Site, the later-listed one: one label.
        store.with_card("ws", "gh-issue-5", |c| { c.area = Some("site".into()); Ok(()) }).unwrap();
        let one = serde_json::json!([
            {"number": 5, "title": "T", "body": "", "state": "OPEN", "assignees": [],
             "labels": [{"name": "status:todo"}, {"name": "area:app"}]}
        ]);
        crate::github::set_test_gh_responses(vec![Ok(one.to_string()), Ok(String::new())]);
        reconcile(&store, "ws", "o/r", None, &lyra()).unwrap();
        let calls: Vec<String> = crate::github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
        crate::github::clear_test_gh_responses();
        assert_eq!(calls[1..], ["issue edit 5 --repo o/r --add-label area:site --remove-label area:app".to_string()]);
        let card = store.get_card("ws", "gh-issue-5").unwrap();
        assert_eq!((card.area.as_deref(), card.gh_area_label.as_deref()), (Some("site"), Some("area:site")), "no switch back");
    }

    #[test]
    fn a_label_a_person_added_beside_the_seen_one_moves_the_card_and_the_seen_one_comes_off() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        // Seen as App; a person added area:site (later-listed) without
        // taking area:app off.
        store.create_card("ws", in_area(local_card(Some(5), "T", KanbanColumnId::Todo), Some("app"), Some("area:app"))).unwrap();
        let both = serde_json::json!([
            {"number": 5, "title": "T", "body": "", "state": "OPEN", "assignees": [],
             "labels": [{"name": "status:todo"}, {"name": "area:app"}, {"name": "area:site"}]}
        ]);
        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![Ok(both.to_string()), Ok(String::new())]);
        reconcile(&store, "ws", "o/r", None, &lyra()).unwrap();
        let calls: Vec<String> = crate::github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
        crate::github::clear_test_gh_responses();
        assert_eq!(calls[1..], ["issue edit 5 --repo o/r --remove-label area:app".to_string()]);
        let card = store.get_card("ws", "gh-issue-5").unwrap();
        assert_eq!((card.area.as_deref(), card.gh_area_label.as_deref()), (Some("site"), Some("area:site")));
    }

    #[test]
    fn a_new_issue_with_two_area_labels_asks_naming_both_and_its_choice_takes_the_other_off() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let both = serde_json::json!([
            {"number": 5, "title": "T", "body": "", "state": "OPEN", "assignees": [],
             "labels": [{"name": "status:todo"}, {"name": "area:app"}, {"name": "area:site"}]}
        ]);
        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![Ok(both.to_string())]);
        reconcile(&store, "ws", "o/r", None, &lyra()).unwrap();
        let calls: Vec<String> = crate::github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
        assert_eq!(calls.len(), 1, "no --remove-label: {calls:?}");
        let card = store.get_card("ws", "gh-issue-5").unwrap();
        assert_eq!((card.area.as_deref(), card.gh_area_label.as_deref()), (None, Some("area:app,area:site")));
        // Synced again unchanged: it still asks, nothing written.
        crate::github::set_test_gh_responses(vec![Ok(both.to_string())]);
        reconcile(&store, "ws", "o/r", None, &lyra()).unwrap();
        assert_eq!(crate::github::take_test_gh_invocations().len(), 1);
        // The person chooses Site: area:site stays, area:app comes off.
        store.with_card("ws", "gh-issue-5", |c| { c.area = Some("site".into()); Ok(()) }).unwrap();
        crate::github::set_test_gh_responses(vec![Ok(String::new())]);
        push_area_label(&store, "o/r", "ws", "gh-issue-5", 5, &lyra());
        let calls: Vec<String> = crate::github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
        crate::github::clear_test_gh_responses();
        assert_eq!(calls, vec!["issue edit 5 --repo o/r --add-label area:site --remove-label area:app"]);
    }

    #[test]
    fn a_card_that_left_not_started_asks_instead_of_taking_another_area_and_one_that_is_over_is_left() {
        let labels = lyra();
        let to_app = issue(5, "T", "", &["status:in-progress", "area:app"], "OPEN");
        // In progress, no copy yet: it can't change area here, so it asks.
        let working = in_area(local_card(Some(5), "T", KanbanColumnId::InProgress), Some("site"), Some("area:site"));
        let plan = reconcile_plan_with(std::slice::from_ref(&to_app), &[working], &labels);
        assert_eq!(area_of(&plan), Some(ia(None, Some("area:app"))));
        // Not started: it follows its issue.
        let waiting = in_area(local_card(Some(5), "T", KanbanColumnId::Todo), Some("site"), Some("area:site"));
        let plan = reconcile_plan_with(&[issue(5, "T", "", &["status:todo", "area:app"], "OPEN")], &[waiting], &labels);
        assert_eq!(area_of(&plan), Some(ia(Some("app"), Some("area:app"))));
        // In progress without an area: it takes the issue's (choosing is allowed).
        let undecided = in_area(local_card(Some(5), "T", KanbanColumnId::InProgress), None, None);
        let plan = reconcile_plan_with(std::slice::from_ref(&to_app), &[undecided], &labels);
        assert_eq!(area_of(&plan), Some(ia(Some("app"), Some("area:app"))));
        // Done, or archived: untouched.
        let done = in_area(local_card(Some(5), "T", KanbanColumnId::Complete), Some("site"), Some("area:site"));
        let closed = issue(5, "T", "", &["area:app"], "CLOSED");
        assert_eq!(area_of(&reconcile_plan_with(&[closed], &[done], &labels)), None);
        let mut archived = in_area(local_card(Some(5), "T", KanbanColumnId::Todo), Some("site"), Some("area:site"));
        archived.archived = true;
        assert_eq!(area_of(&reconcile_plan_with(&[issue(5, "T", "", &["status:todo"], "OPEN")], &[archived], &labels)), None);
    }

    #[test]
    fn an_area_chosen_while_the_issues_were_read_is_never_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = in_area(local_card(Some(5), "T", KanbanColumnId::Todo), Some("site"), Some("area:site"));
        store.create_card("ws", card.clone()).unwrap();
        let plan = reconcile_plan_with(&[issue(5, "T", "", &["status:todo"], "OPEN")], &[card], &lyra());
        // Chosen meanwhile.
        store.with_card("ws", "gh-issue-5", |c| { c.area = Some("app".into()); Ok(()) }).unwrap();
        apply_actions(&store, "ws", plan.actions, None);
        let card = store.get_card("ws", "gh-issue-5").unwrap();
        assert_eq!((card.area.as_deref(), card.gh_area_label.as_deref()), (Some("app"), Some("area:site")));
    }

    #[test]
    fn a_sync_writes_no_area_label_to_a_missing_issue_and_counts_a_failed_one() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", in_area(local_card(Some(5), "T", KanbanColumnId::Todo), Some("site"), None)).unwrap();
        store.create_card("ws", in_area(local_card(Some(6), "U", KanbanColumnId::Todo), Some("app"), None)).unwrap();
        // Issue 6 is gone from GitHub; issue 5's label push fails.
        let list = serde_json::json!([
            {"number": 5, "title": "T", "body": "", "state": "OPEN", "assignees": [], "labels": [{"name": "status:todo"}]}
        ]);
        crate::github::take_test_gh_invocations();
        // TM-5: a card whose issue isn't open has the closed ones read too.
        crate::github::set_test_gh_responses(vec![
            Ok(list.to_string()),
            Ok("[]".into()),
            Err("error connecting to api.github.com".into()),
        ]);
        let summary = reconcile(&store, "ws", "o/r", None, &lyra()).unwrap();
        let calls: Vec<String> = crate::github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
        crate::github::clear_test_gh_responses();
        assert_eq!(calls.len(), 3, "{calls:?}");
        assert!(calls[0].starts_with("issue list --repo o/r --state open --limit 2000 "), "{}", calls[0]);
        assert!(calls[1].starts_with("issue list --repo o/r --state closed --limit 500 "), "{}", calls[1]);
        assert!(!calls.iter().any(|c| c.contains("issue edit 6")), "{calls:?}");
        assert_eq!(summary.area_labels_failed, 1);
        assert_eq!(summary.missing, vec![6]);
        // Still due, and its area kept: the pull didn't read the old label back.
        let card = store.get_card("ws", "gh-issue-5").unwrap();
        assert_eq!((card.area.as_deref(), card.gh_area_label.as_deref()), (Some("site"), None));
    }

    // ── TM-5 (1.175.0): a repository with more issues than one read takes ──

    /// One issue as `gh issue list --json …` prints it.
    fn listed(number: u64, state: &str) -> serde_json::Value {
        serde_json::json!({
            "number": number, "title": format!("Issue {number}"), "body": "", "state": state,
            "assignees": [], "labels": [{"name": "status:todo"}]
        })
    }

    fn gh_calls() -> Vec<String> {
        crate::github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect()
    }

    /// TM-5: 600 issues, 520 of them closed and newer than the open ones. One
    /// read of the 500 newest, open and closed together, was 500 closed
    /// issues and no card at all. The open ones are asked for by themselves,
    /// so each becomes a card; a board with no card yet asks for no closed
    /// issue.
    #[test]
    fn every_open_issue_becomes_a_card_in_a_repository_with_more_than_500_issues() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let open: Vec<serde_json::Value> = (1..=80u64).map(|n| listed(n, "OPEN")).collect();
        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![Ok(serde_json::Value::Array(open).to_string())]);
        let summary = refresh(&store, "ws", "o/r", &Default::default()).unwrap();
        let calls = gh_calls();
        crate::github::clear_test_gh_responses();
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert!(calls[0].starts_with("issue list --repo o/r --state open --limit 2000 "), "{}", calls[0]);
        assert_eq!(summary.created, 80);
        assert!(summary.missing.is_empty());
        let cards = store.load("ws").unwrap();
        assert_eq!(cards.len(), 80);
        assert!((1..=80u64).all(|n| cards.iter().any(|c| c.gh_issue_number == Some(n))), "the oldest too");
    }

    /// The 500 newest closed issues, #100–#599: a closed list at its limit.
    fn cut_closed_list() -> String {
        let closed: Vec<serde_json::Value> = (100..600u64).rev().map(|n| listed(n, "CLOSED")).collect();
        assert_eq!(closed.len(), crate::github::CLOSED_ISSUES_LIMIT);
        serde_json::Value::Array(closed).to_string()
    }

    const NO_SUCH_ISSUE: &str = "GraphQL: Could not resolve to an issue or pull request with the number of 4. (repository.issue)";

    /// TM-5: the closed list came back at its limit, so it may have been cut.
    /// A card whose issue is in neither list is never called missing for
    /// that. One that isn't done is looked up by its number: closed further
    /// back than the list reaches, it moves to Done; an issue GitHub says it
    /// doesn't have is the only one reported missing. The first lookup that
    /// fails for another reason ends them: no timeout after timeout under
    /// the board's lock.
    #[test]
    fn a_cut_list_never_reads_as_issue_missing() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        for (number, column) in [
            (700u64, KanbanColumnId::Todo), // open
            (6, KanbanColumnId::Todo),      // deleted on GitHub
            (5, KanbanColumnId::Complete),  // done, closed long ago
            (4, KanbanColumnId::Todo),      // closed long ago, noticed only now
            (3, KanbanColumnId::Todo),      // GitHub can't be reached for it
            (2, KanbanColumnId::Todo),      // not asked after that
        ] {
            store.create_card("ws", local_card(Some(number), &format!("Issue {number}"), column)).unwrap();
        }
        let open = serde_json::json!([listed(700, "OPEN")]);
        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![
            Ok(open.to_string()),
            Ok(cut_closed_list()), // #2–#6 are older than it reaches
            Err(NO_SUCH_ISSUE.into()),
            Ok(listed(4, "CLOSED").to_string()),
            Err("error connecting to api.github.com".into()),
        ]);
        let summary = refresh(&store, "ws", "o/cut-list", &Default::default()).unwrap();
        let calls = gh_calls();
        crate::github::clear_test_gh_responses();
        assert_eq!(calls.len(), 5, "{calls:?}");
        assert!(calls[1].starts_with("issue list --repo o/cut-list --state closed --limit 500 "), "{}", calls[1]);
        let views: Vec<&str> = calls[2..].iter().map(|c| c.split(" --repo").next().unwrap()).collect();
        assert_eq!(views, ["issue view 6", "issue view 4", "issue view 3"], "never the done card's (#5), nor #2 after the failure");

        assert_eq!(summary.missing, vec![6], "only the issue GitHub says it doesn't have");
        assert_eq!(summary.created, 0, "a closed issue with no card is history");
        let column = |n: u64| store.get_card("ws", &gh_card_id(n)).unwrap().column_id;
        assert_eq!(column(4), KanbanColumnId::Complete, "its issue was closed: the card follows");
        assert_eq!(column(6), KanbanColumnId::Todo, "kept, never deleted");
        for n in [3, 2, 700] {
            assert_eq!(column(n), KanbanColumnId::Todo, "#{n}");
        }
        assert_eq!(column(5), KanbanColumnId::Complete);
    }

    /// TM-5 (fix round 1): a Sync on a cut read writes nothing to an issue
    /// that isn't in its lists — no label, no edit, no close — whatever its
    /// card would be owed if the issue were there.
    #[test]
    fn a_sync_on_a_cut_read_writes_nothing_to_an_issue_it_did_not_read() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", local_card(Some(700), "Issue 700", KanbanColumnId::Todo)).unwrap();
        // Each would have a label sent if its issue had been read: an area
        // still due, and a done card whose closed issue says another status.
        store.create_card("ws", in_area(local_card(Some(3), "T", KanbanColumnId::Todo), Some("site"), None)).unwrap();
        store.create_card("ws", in_area(local_card(Some(5), "U", KanbanColumnId::Complete), Some("app"), None)).unwrap();
        let mut skill = skill_card(Some(7));
        skill.column_id = KanbanColumnId::Complete;
        store.create_card("ws", skill).unwrap();
        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![
            Ok(serde_json::json!([listed(700, "OPEN")]).to_string()),
            Ok(cut_closed_list()),
            Err("error connecting to api.github.com".into()), // the one lookup, of #3
        ]);
        let summary = reconcile(&store, "ws", "o/cut-sync", None, &lyra()).unwrap();
        let calls = gh_calls();
        crate::github::clear_test_gh_responses();
        assert_eq!(calls.len(), 3, "two lists and one lookup, nothing written: {calls:?}");
        assert!(calls[2].starts_with("issue view 3 "), "{}", calls[2]);
        assert!(!calls.iter().any(|c| c.starts_with("issue edit") || c.starts_with("issue close")), "{calls:?}");
        assert!(summary.missing.is_empty(), "and none is called missing");
        assert_eq!(summary.area_labels_failed, 0);
    }

    /// TM-5: a cut read looks up a fixed number of issues, not one per card.
    /// Fix round 1: the reads take turns, so every card is reached, and an
    /// issue GitHub said is gone is not asked about again for hours.
    #[test]
    fn a_cut_read_looks_up_ten_issues_and_the_next_read_the_next_ten() {
        let _guard = crate::github::test_serial_lock();
        let repo = "o/cut-turns";
        let local: Vec<KanbanCard> = (1..=25u64).map(|n| local_card(Some(n), "T", KanbanColumnId::Todo)).collect();
        let open: Vec<serde_json::Value> = (1000..1000 + crate::github::OPEN_ISSUES_LIMIT as u64).map(|n| listed(n, "OPEN")).collect();
        let open = serde_json::Value::Array(open).to_string();
        // One read at `now`, with `answers` for its lookups; returns the read
        // and the numbers it asked about, in order.
        let read_at = |now: i64, answers: Vec<Result<String, String>>| {
            let mut responses = vec![Ok(open.clone()), Ok("[]".into())];
            responses.extend(answers);
            crate::github::take_test_gh_invocations();
            crate::github::set_test_gh_responses(responses);
            let read = read_issues_at(repo, &local, now).unwrap();
            let asked: Vec<u64> = gh_calls()[2..].iter().map(|c| c.split(' ').nth(2).unwrap().parse().unwrap()).collect();
            crate::github::clear_test_gh_responses();
            (read, asked)
        };
        let gone = |n: usize| (0..n).map(|_| Err(NO_SUCH_ISSUE.to_string())).collect::<Vec<_>>();
        let t0 = 1_700_000_000_000;

        let (read, asked) = read_at(t0, gone(ISSUE_LOOKUPS_PER_READ));
        assert!(!read.complete, "the open list came back at its limit");
        assert_eq!(asked, (16..=25u64).rev().collect::<Vec<_>>(), "ten, the highest numbers first");
        assert_eq!(read.missing((1..=25).collect()), (16..=25u64).collect::<Vec<_>>(), "the fifteen not asked are not missing");

        // The next read: the next ten. #15–#11 are closed long ago, #10–#6 gone.
        let mut answers: Vec<Result<String, String>> = (11..=15u64).rev().map(|n| Ok(listed(n, "CLOSED").to_string())).collect();
        answers.extend(gone(5));
        let (read, asked) = read_at(t0 + 60_000, answers);
        assert_eq!(asked, (6..=15u64).rev().collect::<Vec<_>>(), "none of the ten already gone");
        assert_eq!(read.missing((1..=25).collect()), [(6..=10u64).collect::<Vec<_>>(), (16..=25).collect()].concat(), "gone stays gone, unasked");
        assert!((11..=15u64).all(|n| read.issues.iter().any(|i| i.number == n && i.state == "CLOSED")));

        // The third: the five never asked first, then the least recently
        // asked of those that weren't gone. The lookup of #12 fails: it ends there.
        let mut answers: Vec<Result<String, String>> = gone(5);
        answers.extend([15u64, 14, 13].map(|n| Ok(listed(n, "CLOSED").to_string())));
        answers.push(Err("error connecting to api.github.com".into()));
        let (read, asked) = read_at(t0 + 120_000, answers);
        assert_eq!(asked, [5, 4, 3, 2, 1, 15, 14, 13, 12], "#11 isn't tried after the failure");
        assert_eq!(read.gone.len(), 20);

        // Next, #11 goes first: #12, which failed, was asked more recently.
        let (_, asked) = read_at(t0 + 180_000, vec![Ok(listed(11, "CLOSED").to_string()), Err("error connecting to api.github.com".into())]);
        assert_eq!(asked, [11, 15], "the least recently asked first; a failure ends the lookups");

        // Hours later the gone ones are asked about again, the oldest answers first.
        let (_, asked) = read_at(t0 + GONE_ISSUE_RECHECK_MS, gone(ISSUE_LOOKUPS_PER_READ));
        assert_eq!(asked, (16..=25u64).rev().collect::<Vec<_>>());
    }

    /// TM-5: lists under their limits are the whole repository, so an issue
    /// in neither is missing, as before; and an issue closed between the two
    /// reads is taken as closed.
    #[test]
    fn a_whole_read_still_says_which_issues_are_missing() {
        let _guard = crate::github::test_serial_lock();
        let local = vec![
            local_card(Some(1), "T", KanbanColumnId::Todo),
            local_card(Some(2), "T", KanbanColumnId::Todo),
            local_card(Some(3), "T", KanbanColumnId::Todo),
        ];
        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![
            Ok(serde_json::json!([listed(1, "OPEN"), listed(2, "OPEN")]).to_string()),
            Ok(serde_json::json!([listed(2, "CLOSED")]).to_string()),
        ]);
        let read = read_issues("o/r", &local).unwrap();
        let calls = gh_calls();
        crate::github::clear_test_gh_responses();
        assert_eq!(calls.len(), 2, "no lookup by number: {calls:?}");
        assert!(read.complete && read.gone.is_empty());
        assert_eq!(read.issues.len(), 2);
        assert_eq!(read.issues.iter().find(|i| i.number == 2).unwrap().state, "CLOSED");
        assert_eq!(reconcile_plan(&read.issues, &local).missing, vec![3]);
        assert_eq!(read.missing(vec![3]), vec![3]);

        assert!(crate::github::is_issue_not_found("GraphQL: Could not resolve to an Issue with the number of 9."));
        assert!(!crate::github::is_issue_not_found("GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)"));
        assert!(!crate::github::is_issue_not_found("error connecting to api.github.com"));
    }

    // ── Skills hub H3a (Windows walk): a skill card's issue ────────────

    fn skill_card(number: Option<u64>) -> KanbanCard {
        let mut c = KanbanCard::new(
            "skill-card-1".into(),
            "ws".into(),
            "Skill: install team-style from the team library".into(),
            None,
            KanbanColumnId::Complete,
        );
        c.gh_issue_number = number;
        c.kind = Some(crate::kanban::CardKind::Skill(crate::skill_card::SkillCard {
            verb: crate::skill_card::SkillVerb::Install,
            skill: "team-style".into(),
            prefix: String::new(),
            origin: Default::default(),
            here: Default::default(),
            content: Default::default(),
            links: Vec::new(), renamed_to: None, link_before: None, link_after: None, align_winner: None, local_link: false, from_words: None,
            extra: Default::default(),
        }));
        c
    }

    const SKILL: &str = "plyloft:skill";

    #[test]
    fn another_board_makes_no_card_for_a_skill_cards_issue() {
        let title = "Skill: install team-style from the team library";
        let plan = reconcile_plan(&[issue(34, title, "", &["status:done", SKILL], "OPEN")], &[]);
        assert!(plan.actions.is_empty(), "{:?}", plan.actions);
        // An ordinary issue with the same words is still a card.
        let plan = reconcile_plan(&[issue(35, title, "", &[], "OPEN")], &[]);
        assert!(matches!(&plan.actions[..], [ReconcileAction::Create(_)]));
    }

    #[test]
    fn a_card_another_board_made_before_the_label_follows_its_issue_to_complete() {
        let older = local_card(Some(34), "Skill: install team-style", KanbanColumnId::Todo);
        let labelled = issue(34, "Skill: install team-style", "", &["status:done", SKILL], "OPEN");
        match &reconcile_plan(std::slice::from_ref(&labelled), std::slice::from_ref(&older)).actions[..] {
            [ReconcileAction::Patch { column_id, .. }] => {
                assert_eq!(*column_id, Some(KanbanColumnId::Complete))
            }
            other => panic!("expected one Patch, got {other:?}"),
        }
        let closed = issue(34, "Skill: install team-style", "", &[], "CLOSED");
        match &reconcile_plan(&[closed], &[older]).actions[..] {
            [ReconcileAction::Patch { column_id, .. }] => {
                assert_eq!(*column_id, Some(KanbanColumnId::Complete))
            }
            other => panic!("expected one Patch, got {other:?}"),
        }
    }

    #[test]
    fn a_skill_cards_column_is_never_pulled_from_an_unlabelled_issue() {
        let card = skill_card(Some(34));
        let unlabelled = issue(34, &card.title, "", &[], "OPEN");
        assert!(reconcile_plan(&[unlabelled], &[card]).actions.is_empty());
    }

    #[test]
    fn a_skill_cards_label_push_names_its_kind_and_an_ordinary_cards_does_not() {
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", skill_card(Some(34))).unwrap();
        store.create_card("ws", local_card(Some(35), "T", KanbanColumnId::Complete)).unwrap();
        let mut sent = Vec::new();
        assert!(push_status_labels_with(&store, "ws", "skill-card-1", |add, _| {
            sent.push(add.join(","));
            Ok(())
        }));
        assert!(push_status_labels_with(&store, "ws", "gh-issue-35", |add, _| {
            sent.push(add.join(","));
            Ok(())
        }));
        assert_eq!(sent, vec!["status:done,plyloft:skill", "status:done"]);
        // A repository without the label yet: the push creates it and retries.
        assert!(status_label_missing("could not add label: 'plyloft:skill' not found"));
    }

    #[test]
    fn sync_labels_a_skill_cards_open_issue_and_closes_it_once_shipped() {
        let open_bare = issue(34, "S", "", &[], "OPEN");
        let open_labelled = issue(34, "S", "", &["status:done", SKILL], "OPEN");
        let closed = issue(34, "S", "", &["status:done", SKILL], "CLOSED");
        let waiting = skill_card(Some(34));
        let mut shipped = skill_card(Some(34));
        shipped.ship_status = crate::kanban::ShipStatus::Shipped;
        let label = SkillIssueTidy::Label { card_id: "skill-card-1".into(), number: 34 };
        let close = SkillIssueTidy::Close { card_id: "skill-card-1".into(), number: 34 };

        assert_eq!(skill_issue_tidy(std::slice::from_ref(&open_bare), std::slice::from_ref(&waiting)), vec![label]);
        assert!(skill_issue_tidy(std::slice::from_ref(&open_labelled), std::slice::from_ref(&waiting)).is_empty());
        assert_eq!(skill_issue_tidy(std::slice::from_ref(&open_bare), std::slice::from_ref(&shipped)), vec![close.clone()]);
        assert_eq!(skill_issue_tidy(std::slice::from_ref(&open_labelled), std::slice::from_ref(&shipped)), vec![close]);
        assert!(skill_issue_tidy(&[closed], std::slice::from_ref(&shipped)).is_empty());
        assert!(skill_issue_tidy(&[], std::slice::from_ref(&shipped)).is_empty());
        // 1.174.0 A2 round 1: its pull request still open — sent, not
        // landed — the issue stays open (labelled), closed after the merge.
        let mut in_pr = skill_card(Some(34));
        in_pr.review_status = Some(crate::kanban::ReviewStatus::Merged);
        in_pr.pr_url = Some("https://github.com/o/r/pull/9".into());
        in_pr.pr = Some(crate::pr_status::PrStatus::opened(9, 1));
        assert_eq!(
            skill_issue_tidy(std::slice::from_ref(&open_bare), std::slice::from_ref(&in_pr)),
            vec![SkillIssueTidy::Label { card_id: "skill-card-1".into(), number: 34 }]
        );
        assert!(skill_issue_tidy(std::slice::from_ref(&open_labelled), std::slice::from_ref(&in_pr)).is_empty());

        // Never an issue this board's skill card did not make: an ordinary
        // shipped card, or the same card once a Builder worked on it.
        let mut ordinary = local_card(Some(34), "S", KanbanColumnId::Complete);
        ordinary.ship_status = crate::kanban::ShipStatus::Shipped;
        assert!(skill_issue_tidy(std::slice::from_ref(&open_bare), &[ordinary]).is_empty());
        let mut built = shipped.clone();
        built.linked_run_id = Some("run-1".into());
        assert!(skill_issue_tidy(&[open_bare], &[built]).is_empty());
    }

    #[test]
    fn a_sync_closes_the_issue_of_a_skill_card_shipped_by_a_local_land() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut shipped = skill_card(Some(34));
        shipped.ship_status = crate::kanban::ShipStatus::Shipped;
        store.create_card("ws", shipped).unwrap();
        let list = serde_json::json!([
            {"number": 34, "title": "Skill: install team-style from the team library",
             "body": "", "state": "OPEN", "assignees": [], "labels": []}
        ]);
        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![
            Ok(list.to_string()), // gh issue list
            Ok(String::new()),    // gh issue close 34
        ]);
        reconcile(&store, "ws", "o/r", None, &Default::default()).unwrap();
        let calls = crate::github::take_test_gh_invocations();
        crate::github::clear_test_gh_responses();
        assert_eq!(calls.len(), 2, "{calls:?}");
        let close = calls[1].join(" ");
        assert!(close.contains("issue close 34"), "{close}");
        let card = store.get_card("ws", "skill-card-1").unwrap();
        assert_eq!(card.column_id, KanbanColumnId::Complete, "never pulled back to Todo");
    }

    /// U33: a Sync brings a closed issue's status label in line, once, and
    /// asks nothing of an issue already saying done or a card still active.
    #[test]
    fn a_sync_moves_a_closed_issues_status_label_to_done() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", local_card(Some(161), "T", KanbanColumnId::Complete)).unwrap();
        let list = serde_json::json!([
            {"number": 161, "title": "T", "body": "", "state": "CLOSED", "assignees": [{"login": "ana"}],
             "labels": [{"name": "status:in-progress"}, {"name": "area:site"}]}
        ]);
        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![
            Ok(list.to_string()), // gh issue list
            Ok(String::new()),    // gh issue edit 161
        ]);
        reconcile(&store, "ws", "o/r", None, &Default::default()).unwrap();
        let calls = crate::github::take_test_gh_invocations();
        crate::github::clear_test_gh_responses();
        assert_eq!(calls.len(), 2, "{calls:?}");
        let edit = calls[1].join(" ");
        assert!(edit.contains("issue edit 161"), "{edit}");
        assert!(edit.contains("--add-label status:done"), "{edit}");
        assert!(edit.contains("--remove-label status:todo,status:in-progress") || edit.contains("--remove-label status:in-progress"), "{edit}");
        assert!(!edit.contains("assignee"), "{edit}");
        // A label of the person's own stays: the mirror names only status labels.
        assert!(!edit.contains("area:site"), "{edit}");
    }

    #[test]
    fn only_a_closed_issue_saying_another_status_on_a_done_card_is_tidied() {
        let done = local_card(Some(1), "T", KanbanColumnId::Complete);
        let closed = |labels: &[&str]| issue(1, "T", "", labels, "CLOSED");
        assert_eq!(
            closed_status_labels_to_tidy(&[closed(&["status:in-progress"])], std::slice::from_ref(&done)),
            vec![(done.id.clone(), 1)]
        );
        assert!(closed_status_labels_to_tidy(&[closed(&["status:done"])], std::slice::from_ref(&done)).is_empty());
        assert!(closed_status_labels_to_tidy(&[closed(&["area:site"])], std::slice::from_ref(&done)).is_empty());
        let open = issue(1, "T", "", &["status:in-progress"], "OPEN");
        assert!(closed_status_labels_to_tidy(&[open], std::slice::from_ref(&done)).is_empty());
        let active = local_card(Some(1), "T", KanbanColumnId::InProgress);
        assert!(closed_status_labels_to_tidy(&[closed(&["status:in-progress"])], &[active]).is_empty());
        // Closed as not planned: left alone.
        let mut dropped = closed(&["status:in-progress"]);
        dropped.state_reason = Some("NOT_PLANNED".into());
        assert!(closed_status_labels_to_tidy(&[dropped], std::slice::from_ref(&done)).is_empty());
    }

    /// U33: 500 old cards: 25 writes a Sync, newest issues first, the rest later.
    #[test]
    fn a_mature_board_tidies_a_capped_number_per_sync_newest_first() {
        let issues: Vec<GhIssue> = (1..=500u64).rev().map(|n| issue(n, "T", "", &["status:in-progress"], "CLOSED")).collect();
        let cards: Vec<KanbanCard> = (1..=500u64).map(|n| local_card(Some(n), "T", KanbanColumnId::Complete)).collect();
        let tidy = closed_status_labels_to_tidy(&issues, &cards);
        assert_eq!(tidy.len(), CLOSED_LABEL_TIDY_PER_SYNC);
        assert_eq!(tidy[0].1, 500);
        assert_eq!(tidy[24].1, 476);
    }

    /// U33: a board GitHub keeps refusing retries 25 a Sync, newest first, and an
    /// issue-less or still-unsynced card isn't one of them.
    #[test]
    fn label_retries_are_capped_per_sync_newest_first() {
        let mut cards: Vec<KanbanCard> = (1..=60u64)
            .map(|n| {
                let mut c = local_card(Some(n), "T", KanbanColumnId::Complete);
                c.gh_labels_pending = true;
                c
            })
            .collect();
        let retries = pending_label_retries(&cards);
        assert_eq!(retries.len(), LABEL_WRITES_PER_SYNC);
        assert_eq!(retries[0].1, 60);
        assert_eq!(retries[24].1, 36);

        cards.truncate(2);
        cards[0].gh_issue_number = None;
        cards[1].sync_pending = true;
        assert!(pending_label_retries(&cards).is_empty());
    }

    #[test]
    fn a_card_whose_label_is_pending_keeps_its_column_but_pulls_the_rest() {
        let mut moved = local_card(Some(62), "old", KanbanColumnId::Complete);
        moved.gh_labels_pending = true;
        let plan = reconcile_plan(&[issue(62, "new", "", &["status:todo"], "OPEN")], &[moved]);
        match &plan.actions[..] {
            [ReconcileAction::Patch { title, column_id, .. }] => {
                assert_eq!(title, "new");
                assert_eq!(*column_id, None);
            }
            other => panic!("expected one Patch, got {other:?}"),
        }
    }

    #[test]
    fn a_pending_label_retry_pushes_only_labels_and_keeps_newer_issue_edits() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = local_card(Some(62), "old title", KanbanColumnId::InProgress);
        card.notes = Some("old brief".into());
        card.gh_labels_pending = true;
        store.create_card("ws", card).unwrap();

        // A teammate edited the issue after the label push failed offline.
        let body = github::build_issue_body(Some("teammate's brief"), None, None);
        let list = serde_json::json!([
            {"number": 62, "title": "new title", "body": body, "state": "OPEN",
             "assignees": [], "labels": [{"name": "status:in-progress"}]}
        ]);
        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![
            Ok(String::new()),    // gh issue edit --add-label …
            Ok(list.to_string()), // gh issue list
        ]);
        reconcile(&store, "ws", "o/r", None, &Default::default()).unwrap();
        let calls = crate::github::take_test_gh_invocations();
        crate::github::clear_test_gh_responses();

        assert_eq!(calls.len(), 2, "{calls:?}");
        let push = calls[0].join(" ");
        assert!(push.contains("--add-label status:in-progress"), "{push}");
        assert!(!push.contains("--title") && !push.contains("--body"), "{push}");
        let card = store.get_card("ws", "gh-issue-62").unwrap();
        assert!(!card.gh_labels_pending);
        assert_eq!(card.title, "new title");
        assert_eq!(card.notes.as_deref(), Some("teammate's brief"));
    }

    #[test]
    fn assignees_survive_a_pull_through_the_board_file() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut claimed = local_card(Some(62), "T", KanbanColumnId::Todo);
        claimed.gh_assignees = logins(&["test-owner"]);
        store.create_card("ws", claimed).unwrap();
        let mut pending = local_card(Some(63), "local", KanbanColumnId::InProgress);
        pending.sync_pending = true;
        store.create_card("ws", pending).unwrap();

        let list = serde_json::json!([
            {"number": 62, "title": "T", "body": "", "state": "OPEN",
             "assignees": [{"login": "test-owner"}], "labels": [{"name": "status:todo"}]},
            {"number": 63, "title": "remote", "body": "", "state": "OPEN",
             "assignees": [{"login": "hubot"}], "labels": [{"name": "status:todo"}]},
            {"number": 64, "title": "new", "body": "", "state": "OPEN",
             "assignees": [{"login": "hubot"}, {"login": "test-owner"}], "labels": []}
        ]);
        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![
            Err("offline".into()), // the pending card's push fails again
            Ok(list.to_string()),  // gh issue list
        ]);
        let summary = reconcile(&store, "ws", "o/r", None, &Default::default()).unwrap();
        crate::github::clear_test_gh_responses();
        assert_eq!((summary.created, summary.patched), (1, 1));

        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = |id: &str| reopened.get_card("ws", id).unwrap();
        assert_eq!(card("gh-issue-62").gh_assignees, logins(&["test-owner"]));
        let pending = card("gh-issue-63");
        assert_eq!(pending.gh_assignees, logins(&["hubot"]));
        assert_eq!(pending.title, "local", "the pending edit is not clobbered");
        assert!(pending.sync_pending);
        assert_eq!(card("gh-issue-64").gh_assignees, logins(&["hubot", "test-owner"]));
    }

    fn authored(mut i: GhIssue, login: &str) -> GhIssue {
        i.author = Some(GhUser { login: login.to_string() });
        i
    }

    /// U10: a card first read here is as old as its issue, and an answer
    /// without the time leaves the card's own.
    #[test]
    fn a_new_card_takes_the_time_its_issue_was_opened() {
        let mut opened = issue(21, "T", "", &["status:todo"], "OPEN");
        opened.created_at = Some("2026-11-02T15:35:51Z".into());
        match &reconcile_plan(&[opened], &[]).actions[..] {
            [ReconcileAction::Create(card)] => assert_eq!(card.created_at, 1_793_633_751_000),
            other => panic!("expected Create, got {other:?}"),
        }
        let before = chrono::Utc::now().timestamp_millis();
        match &reconcile_plan(&[issue(22, "T", "", &["status:todo"], "OPEN")], &[]).actions[..] {
            [ReconcileAction::Create(card)] => assert!(card.created_at >= before),
            other => panic!("expected Create, got {other:?}"),
        }
    }

    #[test]
    fn the_issue_author_rides_on_create_patch_and_a_pending_card() {
        // N14 (item 6): who opened the issue is recorded on every pull.
        let open = || authored(issue(21, "T", "", &["status:todo"], "OPEN"), "test-user");
        match &reconcile_plan(&[open()], &[]).actions[..] {
            [ReconcileAction::Create(card)] => {
                assert_eq!(card.gh_author.as_deref(), Some("test-user"))
            }
            other => panic!("expected Create, got {other:?}"),
        }

        // A card read before the field existed takes it with a patch that
        // leaves the column alone.
        let local = local_card(Some(21), "T", KanbanColumnId::Todo);
        match &reconcile_plan(&[open()], std::slice::from_ref(&local)).actions[..] {
            [ReconcileAction::Patch { gh_author, column_id, .. }] => {
                assert_eq!(gh_author.as_deref(), Some("test-user"));
                assert_eq!(*column_id, None);
            }
            other => panic!("expected one Patch, got {other:?}"),
        }

        // Recorded already → nothing to do; an answer with no author (a
        // deleted account) never clears it.
        let mut known = local.clone();
        known.gh_author = Some("test-user".into());
        assert!(reconcile_plan(&[open()], std::slice::from_ref(&known)).actions.is_empty());
        assert!(reconcile_plan(&[issue(21, "T", "", &["status:todo"], "OPEN")], &[known])
            .actions
            .is_empty());

        // A pending card takes the author and nothing else.
        let mut pending = local_card(Some(21), "local title", KanbanColumnId::InProgress);
        pending.sync_pending = true;
        match &reconcile_plan(&[open()], &[pending]).actions[..] {
            [ReconcileAction::SetAssignees { gh_author, gh_assignees, .. }] => {
                assert_eq!(gh_author.as_deref(), Some("test-user"));
                assert!(gh_assignees.is_empty());
            }
            other => panic!("expected only SetAssignees, got {other:?}"),
        }
    }

    #[test]
    fn the_issue_author_survives_a_pull_through_the_board_file() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", local_card(Some(21), "T", KanbanColumnId::Todo)).unwrap();
        let mut pending = local_card(Some(22), "local", KanbanColumnId::Todo);
        pending.sync_pending = true;
        store.create_card("ws", pending).unwrap();
        let list = serde_json::json!([
            {"number": 21, "title": "T", "body": "", "state": "OPEN", "assignees": [],
             "labels": [{"name": "status:todo"}], "author": {"login": "test-user"}},
            {"number": 22, "title": "remote", "body": "", "state": "OPEN", "assignees": [],
             "labels": [{"name": "status:todo"}], "author": {"login": "test-owner"}},
            {"number": 23, "title": "new", "body": "", "state": "OPEN", "assignees": [],
             "labels": [], "author": null}
        ]);
        crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![
            Err("offline".into()), // the pending card's push fails again
            Ok(list.to_string()),  // gh issue list
        ]);
        let summary = reconcile(&store, "ws", "o/r", None, &Default::default()).unwrap();
        let calls = crate::github::take_test_gh_invocations();
        crate::github::clear_test_gh_responses();
        assert_eq!((summary.created, summary.patched), (1, 2));
        let list_call = calls.last().unwrap().join(" ");
        assert!(list_call.contains("author"), "the list asks for the author: {list_call}");

        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = |id: &str| reopened.get_card("ws", id).unwrap();
        assert_eq!(card("gh-issue-21").gh_author.as_deref(), Some("test-user"));
        assert_eq!(card("gh-issue-22").gh_author.as_deref(), Some("test-owner"));
        assert_eq!(card("gh-issue-22").title, "local", "the pending edit is not clobbered");
        assert_eq!(card("gh-issue-23").gh_author, None);
    }

    #[test]
    fn new_issue_becomes_create_with_parsed_fields() {
        let body = github::build_issue_body(Some("n"), Some("k"), Some("freeform"));
        let plan = reconcile_plan(&[issue(7, "T", &body, &["status:todo"], "OPEN")], &[]);
        assert_eq!(plan.actions.len(), 1);
        match &plan.actions[0] {
            ReconcileAction::Create(card) => {
                assert_eq!(card.id, "gh-issue-7");
                assert_eq!(card.gh_issue_number, Some(7));
                assert_eq!(card.title, "T");
                assert_eq!(card.notes.as_deref(), Some("n"));
                assert_eq!(card.knowledge.as_deref(), Some("k"));
                assert_eq!(card.gh_raw_remainder.as_deref(), Some("freeform"));
                assert_eq!(card.column_id, KanbanColumnId::Todo);
            }
            other => panic!("expected Create, got {other:?}"),
        }
    }

    #[test]
    fn changed_title_becomes_patch() {
        let local = local_card(Some(7), "old", KanbanColumnId::Todo);
        let plan = reconcile_plan(&[issue(7, "new", "", &["status:todo"], "OPEN")], &[local]);
        assert_eq!(plan.actions.len(), 1);
        match &plan.actions[0] {
            ReconcileAction::Patch { title, column_id, .. } => {
                assert_eq!(title, "new");
                // same column → not touched
                assert_eq!(*column_id, None);
            }
            other => panic!("expected Patch, got {other:?}"),
        }
    }

    #[test]
    fn closed_issue_pulls_card_to_complete() {
        let local = local_card(Some(7), "T", KanbanColumnId::Todo);
        let plan = reconcile_plan(&[issue(7, "T", "", &[], "CLOSED")], &[local]);
        match &plan.actions[0] {
            ReconcileAction::Patch { column_id, .. } => {
                assert_eq!(*column_id, Some(KanbanColumnId::Complete));
            }
            other => panic!("expected Patch to Complete, got {other:?}"),
        }
    }

    #[test]
    fn closed_issue_without_local_card_is_not_created() {
        // v1.77.0: history stays on GitHub. This is also the invariant the
        // GH-backed delete flow relies on — close the issue, delete the card,
        // and the next reconcile must NOT resurrect it.
        let plan = reconcile_plan(&[issue(7, "T", "", &[], "CLOSED")], &[]);
        assert!(plan.actions.is_empty(), "closed issue must not become a card");

        // Reopening the issue is the recovery path: it creates again.
        let plan2 = reconcile_plan(&[issue(7, "T", "", &[], "OPEN")], &[]);
        assert_eq!(plan2.actions.len(), 1);
        assert!(matches!(&plan2.actions[0], ReconcileAction::Create(_)));
    }

    #[test]
    fn unchanged_issue_is_noop() {
        let local = local_card(Some(7), "T", KanbanColumnId::Todo);
        let plan = reconcile_plan(&[issue(7, "T", "", &["status:todo"], "OPEN")], &[local]);
        assert!(plan.actions.is_empty());
    }

    #[test]
    fn sync_pending_card_is_skipped() {
        let mut local = local_card(Some(7), "old", KanbanColumnId::Todo);
        local.sync_pending = true;
        let plan = reconcile_plan(&[issue(7, "new", "", &["status:done"], "OPEN")], &[local]);
        assert!(plan.actions.is_empty(), "pending card must not be pulled");
    }

    #[test]
    fn active_card_column_is_protected() {
        // An InProgress card with a live swarm must not be dragged to Todo by a
        // remote label edit — but its other fields still sync.
        let mut local = local_card(Some(7), "old", KanbanColumnId::InProgress);
        local.linked_swarm_id = Some("sw-1".into());
        let plan = reconcile_plan(
            &[issue(7, "new", "", &["status:todo"], "OPEN")],
            std::slice::from_ref(&local),
        );
        match &plan.actions[0] {
            ReconcileAction::Patch { title, column_id, .. } => {
                assert_eq!(title, "new", "non-column fields still sync");
                assert_eq!(*column_id, None, "active card column is protected");
            }
            other => panic!("expected Patch, got {other:?}"),
        }

        // Same, via a running status rather than a linked swarm.
        let mut running = local_card(Some(8), "T", KanbanColumnId::InProgress);
        running.last_run_status = Some(LastRunStatus::Running);
        let plan2 = reconcile_plan(&[issue(8, "T", "", &["status:todo"], "OPEN")], &[running]);
        assert!(plan2.actions.is_empty(), "no other change → no patch at all");
    }

    #[test]
    fn a_worktree_counts_as_active_only_while_its_directory_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let closed = [issue(7, "T", "", &[], "CLOSED")];

        let mut live = local_card(Some(7), "T", KanbanColumnId::InProgress);
        live.worktree_path = Some(tmp.path().to_string_lossy().to_string());
        let plan = reconcile_plan(&closed, &[live]);
        assert!(plan.actions.is_empty(), "an existing worktree still protects the column");

        let mut dangling = local_card(Some(7), "T", KanbanColumnId::InProgress);
        dangling.worktree_path = Some(tmp.path().join("gone").to_string_lossy().to_string());
        let plan = reconcile_plan(&closed, &[dangling]);
        match &plan.actions[0] {
            ReconcileAction::Patch { column_id, .. } => {
                assert_eq!(*column_id, Some(KanbanColumnId::Complete));
            }
            other => panic!("expected Patch to Complete, got {other:?}"),
        }
    }

    fn git_repo(dir: &std::path::Path) {
        for args in [
            &["init", "-b", "main"][..],
            &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ] {
            let ok = crate::platform::git_command()
                .args(args)
                .current_dir(dir)
                .status()
                .is_ok_and(|s| s.success());
            assert!(ok, "git {args:?} failed");
        }
    }

    #[test]
    fn reconcile_heals_a_dangling_handle_so_a_closed_issue_pulls_the_card_to_complete() {
        // #20 on the mini: worktree deleted, card left in In progress with a
        // handle on the missing directory, issue closed on GitHub.
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        git_repo(&ws);
        let store = KanbanStore::new(tmp.path().join("state")).unwrap();
        let gone = crate::worktrees::worktree_path_for_card(&ws, "gh-issue-20");
        let present = crate::worktrees::worktree_path_for_card(&ws, "gh-issue-21");
        std::fs::create_dir_all(&present).unwrap();
        for (number, path) in [(20, &gone), (21, &present)] {
            let mut card = local_card(Some(number), "T", KanbanColumnId::InProgress);
            card.worktree_path = Some(path.to_string_lossy().to_string());
            card.branch_name = Some(format!("atelier/{number}"));
            store.create_card("ws", card).unwrap();
        }

        assert_eq!(heal_dangling_worktree_handles(&store, "ws", &ws), vec!["gh-issue-20"]);
        let healed = store.get_card("ws", "gh-issue-20").unwrap();
        assert_eq!((healed.worktree_path.clone(), healed.branch_name.clone()), (None, None));
        assert_eq!(healed.column_id, KanbanColumnId::InProgress, "only the handle changes");
        assert!(!healed.archived);
        assert!(store.get_card("ws", "gh-issue-21").unwrap().worktree_path.is_some());

        let issues = [issue(20, "T", "", &[], "CLOSED"), issue(21, "T", "", &[], "CLOSED")];
        let plan = reconcile_plan(&issues, &store.load("ws").unwrap());
        assert_eq!(plan.actions.len(), 1, "{:?}", plan.actions);
        match &plan.actions[0] {
            ReconcileAction::Patch { card_id, column_id, .. } => {
                assert_eq!(card_id, "gh-issue-20");
                assert_eq!(*column_id, Some(KanbanColumnId::Complete));
            }
            other => panic!("expected Patch to Complete, got {other:?}"),
        }
    }

    #[test]
    fn heal_keeps_a_handle_git_still_registers_or_when_git_is_unreadable() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        git_repo(&ws);
        let store = KanbanStore::new(tmp.path().join("state")).unwrap();
        let wt = crate::worktrees::worktree_path_for_card(&ws, "gh-issue-20");
        let ok = crate::platform::git_command()
            .args(["worktree", "add", "-b", "atelier/20"])
            .arg(&wt)
            .current_dir(&ws)
            .status()
            .is_ok_and(|s| s.success());
        assert!(ok, "git worktree add failed");
        let mut card = local_card(Some(20), "T", KanbanColumnId::InProgress);
        card.worktree_path = Some(wt.to_string_lossy().to_string());
        card.branch_name = Some("atelier/20".into());
        store.create_card("ws", card).unwrap();

        // Moved away (a prune mid-move) but still registered with git.
        std::fs::rename(&wt, tmp.path().join("away")).unwrap();
        assert!(heal_dangling_worktree_handles(&store, "ws", &ws).is_empty());
        // Git can't be read at all.
        assert!(heal_dangling_worktree_handles(&store, "ws", &tmp.path().join("nowhere")).is_empty());
        let kept = store.get_card("ws", "gh-issue-20").unwrap();
        assert_eq!(kept.worktree_path.as_deref(), Some(wt.to_string_lossy().as_ref()));
        assert_eq!(kept.branch_name.as_deref(), Some("atelier/20"));
    }

    #[test]
    fn missing_issue_is_reported_not_deleted() {
        let local = local_card(Some(99), "orphan", KanbanColumnId::Todo);
        let plan = reconcile_plan(&[], &[local]);
        assert!(plan.actions.is_empty(), "missing issue must not delete the card");
        assert_eq!(plan.missing, vec![99]);
    }

    #[test]
    fn local_only_card_is_ignored() {
        // A card with no gh_issue_number is local-only — never touched, never
        // reported missing.
        let local = local_card(None, "local", KanbanColumnId::Todo);
        let plan = reconcile_plan(&[], &[local]);
        assert!(plan.actions.is_empty());
        assert!(plan.missing.is_empty());
    }

    #[test]
    fn outcome_comment_includes_status_verify_files_and_author() {
        let changed: Vec<String> = (1..=12).map(|i| format!("src/f{i}.rs")).collect();
        let body = build_outcome_comment(
            "Fix the thing",
            "✓ completed",
            Some("**Verify:** passed (3 steps)"),
            &changed,
            Some("dev@example.com"),
        );
        assert!(body.contains("## Plyloft outcome — ✓ completed"));
        assert!(body.contains("**Card:** Fix the thing"));
        assert!(body.contains("**Verify:** passed (3 steps)"));
        assert!(body.contains("**Files changed (12):**"));
        assert!(body.contains("`src/f1.rs`"));
        assert!(body.contains("… + 2 more"), "caps the file list at 10");
        assert!(!body.contains("`src/f11.rs`"));
        assert!(body.contains("— by dev@example.com"));
    }

    #[test]
    fn outcome_comment_omits_empty_sections() {
        let body = build_outcome_comment("T", "✗ failed", None, &[], None);
        assert!(body.contains("## Plyloft outcome — ✗ failed"));
        assert!(!body.contains("Verify"));
        assert!(!body.contains("Files changed"));
        assert!(!body.contains("— by"));
    }

    /// The body the applier's write-back sends for `card`.
    fn written_back(card: &KanbanCard) -> String {
        github::build_issue_body(
            card.notes.as_deref(),
            card.knowledge.as_deref(),
            card.gh_raw_remainder.as_deref(),
        )
    }

    #[test]
    fn unmarked_issue_body_becomes_notes_on_create() {
        let body = "## What happened\n\nThe brief is empty.";
        let plan = reconcile_plan(&[issue(33, "T", body, &["status:todo"], "OPEN")], &[]);
        match &plan.actions[0] {
            ReconcileAction::Create(card) => {
                assert_eq!(card.notes.as_deref(), Some(body));
                assert_eq!(card.gh_raw_remainder, None);
                // Written back once, with markers; the next plan is a no-op.
                let rewritten = written_back(card);
                assert!(rewritten.contains("<!-- atelier:notes -->"));
                let again = reconcile_plan(
                    &[issue(33, "T", &rewritten, &["status:todo"], "OPEN")],
                    &[(**card).clone()],
                );
                assert!(again.actions.is_empty(), "{:?}", again.actions);
                assert!(again.write_back.is_empty());
            }
            other => panic!("expected Create, got {other:?}"),
        }
        assert_eq!(plan.write_back, vec!["gh-issue-33".to_string()]);
    }

    #[test]
    fn unmarked_issue_body_heals_existing_card_with_empty_notes() {
        // #33/#34 before the fix: the card exists, notes empty, body cached
        // as a remainder. The next Sync adopts it.
        let mut local = local_card(Some(34), "T", KanbanColumnId::Todo);
        local.gh_raw_remainder = Some("Plain body".into());
        let plan = reconcile_plan(
            &[issue(34, "T", "Plain body", &["status:todo"], "OPEN")],
            std::slice::from_ref(&local),
        );
        match &plan.actions[0] {
            ReconcileAction::Patch { notes, gh_raw_remainder, column_id, .. } => {
                assert_eq!(notes.as_deref(), Some("Plain body"));
                assert_eq!(*gh_raw_remainder, None);
                assert_eq!(*column_id, None);
            }
            other => panic!("expected Patch, got {other:?}"),
        }
        assert_eq!(plan.write_back, vec![local.id.clone()]);
    }

    #[test]
    fn unmarked_issue_body_is_not_adopted_over_existing_notes() {
        let mut local = local_card(Some(7), "T", KanbanColumnId::Todo);
        local.notes = Some("mine".into());
        let plan = reconcile_plan(
            &[issue(7, "T", "Plain body", &["status:todo"], "OPEN")],
            std::slice::from_ref(&local),
        );
        assert!(plan.write_back.is_empty());
        match &plan.actions[0] {
            // Unchanged policy: GitHub owns notes, the body stays a remainder.
            ReconcileAction::Patch { gh_raw_remainder, .. } => {
                assert_eq!(gh_raw_remainder.as_deref(), Some("Plain body"));
            }
            other => panic!("expected Patch, got {other:?}"),
        }
    }

    #[test]
    fn closed_or_pending_cards_never_adopt() {
        let local = local_card(Some(7), "T", KanbanColumnId::Complete);
        let closed = reconcile_plan(&[issue(7, "T", "Plain body", &[], "CLOSED")], &[local]);
        assert!(closed.write_back.is_empty());
        match &closed.actions[0] {
            ReconcileAction::Patch { notes, .. } => assert_eq!(*notes, None),
            other => panic!("expected Patch, got {other:?}"),
        }

        let mut pending = local_card(Some(8), "T", KanbanColumnId::Todo);
        pending.sync_pending = true;
        let plan = reconcile_plan(&[issue(8, "T", "Plain body", &["status:todo"], "OPEN")], &[pending]);
        assert!(plan.actions.is_empty() && plan.write_back.is_empty());
    }

    #[test]
    fn raw_remainder_round_trips_through_plan() {
        let body = github::build_issue_body(Some("n"), None, Some("human text"));
        // local card lacks the remainder → a patch carries it in.
        let local = local_card(Some(7), "T", KanbanColumnId::Todo);
        let plan = reconcile_plan(&[issue(7, "T", &body, &["status:todo"], "OPEN")], &[local]);
        match &plan.actions[0] {
            ReconcileAction::Patch { gh_raw_remainder, notes, .. } => {
                assert_eq!(gh_raw_remainder.as_deref(), Some("human text"));
                assert_eq!(notes.as_deref(), Some("n"));
            }
            other => panic!("expected Patch, got {other:?}"),
        }
    }

    #[test]
    fn a_refresh_adopts_the_brief_locally_and_the_next_sync_writes_the_markers() {
        // QoL 14.1 (Challenger): a card a refresh made has the body as its
        // brief; later plans keep it (no flip back) and still ask a Sync for
        // the marker write-back; once written back, nothing is left to do.
        let issues = [issue(41, "T", "Plain body", &["status:todo"], "OPEN")];
        let first = reconcile_plan(&issues, &[]);
        let card = match &first.actions[0] {
            ReconcileAction::Create(card) => (**card).clone(),
            other => panic!("expected Create, got {other:?}"),
        };
        assert_eq!(card.notes.as_deref(), Some("Plain body"));
        assert_eq!(card.gh_raw_remainder, None);
        let again = reconcile_plan(&issues, std::slice::from_ref(&card));
        assert!(again.actions.is_empty(), "{:?}", again.actions);
        assert_eq!(again.write_back, vec![card.id.clone()]);
        let rewritten = written_back(&card);
        let after = reconcile_plan(&[issue(41, "T", &rewritten, &["status:todo"], "OPEN")], std::slice::from_ref(&card));
        assert!(after.actions.is_empty() && after.write_back.is_empty());
        // Closed: kept as it is, never rewritten.
        let closed = reconcile_plan(&[issue(41, "T", "Plain body", &[], "CLOSED")], std::slice::from_ref(&card));
        assert!(closed.write_back.is_empty());
        match &closed.actions[0] {
            ReconcileAction::Patch { notes, .. } => assert_eq!(notes.as_deref(), Some("Plain body")),
            other => panic!("expected Patch, got {other:?}"),
        }
    }
}
