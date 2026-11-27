//! 1.175.0 (D3; review TM-4): a card edited here while its issue changed on
//! GitHub.
//!
//! An edit of a card of a GitHub issue used to rewrite the issue's title and
//! whole text with what this computer had: correcting a title wiped the
//! brief a teammate had improved meanwhile, with nothing said — also for an
//! edit made offline and sent hours later.
//!
//! The rule (owner): **Plyloft writes only the part the member touched.** If
//! that part hasn't changed on GitHub since this computer last read it, it
//! is written. If it has, nothing is written and the card asks which
//! version to keep ([`EditConflict`], answered through
//! `card_edit_conflict_resolve`). The part not touched follows GitHub
//! without a question.
//!
//! - **Parts**: the title (`gh issue edit --title`, alone) and the brief
//!   (the card's notes; the body alone, rebuilt). The body is rebuilt from
//!   this computer's notes and what GitHub has **now** of everything else —
//!   the knowledge, the text outside Plyloft's blocks, the claim marker — so
//!   a brief edit never loses a teammate's other change. The card's
//!   knowledge has no question: an edit of it is written merged with
//!   GitHub's current brief, and when both sides changed the knowledge
//!   itself the last writer wins (a decision listed for the owner).
//! - **"Since this computer last read it"** ([`GhLastRead`]): what the card
//!   had of a part before the member's first edit of it — which is what the
//!   last read left there — kept only while that edit isn't on GitHub yet (a
//!   write that failed, an edit made offline). It is dropped as soon as the
//!   card is back in step. A card from before 1.175.0 has none, and needs
//!   none: its first edit compares GitHub with the value from before the
//!   edit ([`gh_sync_card_edit`]'s `before`).
//! - **While a question is open** the pull leaves that part as the member
//!   wrote it and keeps the question's "GitHub's value" current
//!   (`github_sync::reconcile_plan_with`); every other part follows GitHub.
//!   The answer applies to the value that was shown: if GitHub's changed
//!   again, nothing is written and the question shows the new one.
//! - B3's rule holds in every rewrite: an outsider's marks in the text
//!   don't count (`issue_text::parse_body`, `claim_in`), and Plyloft's own
//!   blocks and the claim marker survive.
//!
//! A card with an open question is Needs you on the Board, in the Inbox and
//! in the sidebar's count, from the card's record alone
//! (`inbox::derive_card_events`, `cardPresentation.ts`).

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::github::GhIssue;
use crate::kanban::{KanbanCard, KanbanStore};

/// A part of a card's issue that has a question of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditPart {
    Title,
    Brief,
}

/// What GitHub had of a part when this computer's edit of it began, for the
/// parts whose edit isn't on GitHub yet. See the module's words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GhLastRead {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// A hash of the brief ([`brief_hash`]); the text itself isn't kept twice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    /// Set (to the same kind of hash) when the knowledge was edited: it has
    /// no question, only "touched here".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knowledge: Option<String>,
    /// The issue's `updatedAt` when it was last read for a write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

impl GhLastRead {
    fn is_empty(&self) -> bool {
        self.title.is_none() && self.brief.is_none() && self.knowledge.is_none()
    }
}

/// A part both sides changed: the card keeps the member's version here and
/// asks which one to keep.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditConflict {
    pub part: EditPart,
    /// GitHub's value of the part, as the question shows it.
    pub theirs: String,
    /// Who changed it on GitHub, when GitHub says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
    /// When (ms), when GitHub says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
}

/// A text as it is compared: without the white space around it.
fn norm(text: Option<&str>) -> String {
    text.unwrap_or("").trim().to_string()
}

/// The hash a brief (or a knowledge) is remembered by.
pub fn brief_hash(text: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(norm(text).as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// An issue as a card reads it now.
struct Remote {
    title: String,
    notes: Option<String>,
    knowledge: Option<String>,
    remainder: Option<String>,
    claim: Option<crate::device_claim::DeviceClaim>,
    updated_at: String,
}

/// `issue` as `card` reads it: B3's rule on whose marks count, and a text
/// with no block of Plyloft's is the brief (as a pull adopts it).
fn remote_of(issue: &GhIssue, card: &KanbanCard) -> Remote {
    let from_outside = crate::issue_text::card_written_outside(card);
    let parsed = crate::issue_text::parse_body(&issue.body, from_outside);
    let parsed = crate::github::adopt_unmarked_body(&parsed, None).unwrap_or(parsed);
    Remote {
        title: issue.title.clone(),
        notes: parsed.notes,
        knowledge: parsed.knowledge,
        remainder: parsed.raw_remainder,
        claim: crate::issue_text::claim_in(&issue.body, from_outside),
        updated_at: issue.updated_at.clone(),
    }
}

impl Remote {
    fn value(&self, part: EditPart) -> String {
        match part {
            EditPart::Title => self.title.trim().to_string(),
            EditPart::Brief => norm(self.notes.as_deref()),
        }
    }
}

fn local_value(card: &KanbanCard, part: EditPart) -> String {
    match part {
        EditPart::Title => card.title.trim().to_string(),
        EditPart::Brief => norm(card.notes.as_deref()),
    }
}

/// Whether GitHub's `remote` value of `part` is still what `baseline` says
/// this computer last read.
fn unchanged(part: EditPart, remote: &Remote, baseline: &str) -> bool {
    match part {
        EditPart::Title => remote.title.trim() == baseline.trim(),
        EditPart::Brief => brief_hash(remote.notes.as_deref()) == baseline,
    }
}

/// What a write of a card's touched parts did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Written {
    /// `gh issue edit --title` went.
    pub title: bool,
    /// The body went.
    pub body: bool,
    /// The parts that now ask which version to keep.
    pub conflicts: Vec<EditPart>,
}

/// The baselines an edit is judged by: `Some` for a part the member touched.
#[derive(Debug, Clone, Default)]
struct Touched {
    title: Option<String>,
    brief: Option<String>,
    knowledge: bool,
    /// A card pending from before 1.175.0: nothing was kept to judge it
    /// by. Every part counts as touched, and GitHub as unchanged.
    unjudged: bool,
    /// *Use as brief* (D3 round 2): the text outside Plyloft's blocks that
    /// this edit moved into the brief, as the card had it. While GitHub's
    /// outside text is still that, the rebuilt body leaves it out (it is in
    /// the brief now); outside text GitHub has that differs stays as it is.
    adopted: Option<String>,
}

/// Who changed a part on GitHub and when, asked only once a question is
/// about to be raised (one bounded read). `None` where GitHub doesn't say.
fn who_changed(repo: &str, number: u64, part: EditPart) -> (Option<String>, Option<i64>) {
    match crate::github::issue_last_change(repo, number) {
        Ok(change) => match part {
            EditPart::Title => (change.title_by, change.title_at),
            EditPart::Brief => (change.body_by, change.body_at),
        },
        Err(e) => {
            log::warn!("issue edit: reading who changed {repo}#{number} failed: {e}");
            (None, None)
        }
    }
}

/// Write the parts of `card` in `touched` to issue `number`, each only if
/// GitHub still has what this computer last read of it; raise a question
/// for a part both changed. Reads the issue once (`Err`: nothing was
/// written, the caller leaves the card to Sync), writes the title alone
/// and/or the body alone, and records on the card the questions, the claim
/// marker the body carries, and the baselines still owed.
fn write_touched(
    store: &KanbanStore,
    repo: &str,
    workspace_id: &str,
    card: &KanbanCard,
    number: u64,
    touched: &Touched,
) -> Result<Written, String> {
    let issue = crate::github::issue_view(repo, number)?;
    let remote = remote_of(&issue, card);
    let open = |part: EditPart| card.edit_conflicts.iter().any(|c| c.part == part);
    let mut written = Written::default();
    let mut conflicts: Vec<EditConflict> = Vec::new();
    // What each part needs: nothing, a write of this computer's value, or a question.
    let mut decide = |part: EditPart, baseline: Option<&String>| -> bool {
        if baseline.is_none() && !touched.unjudged {
            return false;
        }
        // A question already open for it: the member is still choosing.
        if open(part) {
            return false;
        }
        let (mine, theirs) = (local_value(card, part), remote.value(part));
        if mine == theirs {
            return false; // Both wrote the same: nothing to send, nothing to ask.
        }
        if baseline.is_none_or(|baseline| unchanged(part, &remote, baseline)) {
            return true;
        }
        let (who, at) = who_changed(repo, number, part);
        conflicts.push(EditConflict { part, theirs, who, at });
        false
    };
    let write_title = decide(EditPart::Title, touched.title.as_ref());
    let write_brief = decide(EditPart::Brief, touched.brief.as_ref());
    let write_knowledge = touched.knowledge && norm(card.knowledge.as_deref()) != norm(remote.knowledge.as_deref());

    let mut failed: Option<String> = None;
    if write_title {
        match crate::github::issue_edit_title(repo, number, card.title.trim()) {
            Ok(()) => written.title = true,
            Err(e) => failed = Some(e),
        }
    }
    let mut claim_written = None;
    if failed.is_none() && (write_brief || write_knowledge) {
        // This computer's value for what it touched; GitHub's, as it is
        // now, for everything else.
        let notes = if write_brief { card.notes.clone() } else { remote.notes.clone() };
        let knowledge = if touched.knowledge { card.knowledge.clone() } else { remote.knowledge.clone() };
        let claim = crate::device_claim::kept_on_rebuild(card, remote.claim.clone(), repo);
        let adopted = write_brief && touched.adopted.as_deref().is_some_and(|a| norm(Some(a)) == norm(remote.remainder.as_deref()));
        let remainder = if adopted { None } else { remote.remainder.as_deref() };
        let body = crate::github::build_issue_body(notes.as_deref(), knowledge.as_deref(), remainder);
        let body = crate::device_claim::with_claim(&body, claim.as_ref());
        match crate::github::issue_edit_body(repo, number, &body) {
            Ok(()) => {
                written.body = true;
                claim_written = Some(claim);
            }
            Err(e) => failed = Some(e),
        }
    }
    written.conflicts = conflicts.iter().map(|c| c.part).collect();

    // The card's record: questions raised, and which baselines are still owed
    // (a part whose write failed keeps its own; every other is in step or asks).
    let title_owed = write_title && !written.title;
    let brief_owed = (write_brief || write_knowledge) && !written.body;
    let updated_at = remote.updated_at.clone();
    let touched = touched.clone();
    let mine = crate::device_claim::this_id_for(repo);
    let recorded = store.with_card_unstamped(workspace_id, &card.id, |c| {
        for conflict in conflicts {
            c.edit_conflicts.retain(|x| x.part != conflict.part);
            c.edit_conflicts.push(conflict);
        }
        let last = GhLastRead {
            title: touched.title.filter(|_| title_owed),
            brief: touched.brief.filter(|_| brief_owed && write_brief),
            knowledge: Some(String::new()).filter(|_| brief_owed && touched.knowledge),
            updated_at: Some(updated_at).filter(|u| !u.is_empty()),
        };
        c.gh_last_read = Some(last).filter(|l| !l.is_empty());
        if let Some(claim) = claim_written {
            c.take_gh_claim(claim, mine.as_deref());
        }
        Ok(())
    });
    if let Err(e) = recorded {
        log::warn!("issue edit: recording what was written of card '{}' failed: {e}", card.id);
    }
    match failed {
        Some(e) => Err(e),
        None => Ok(written),
    }
}

/// The baselines of the member's edit that turned `before` into `card`: for
/// each part that changed, what the card recorded as last read, else what it
/// had before the edit (which is what the last read left).
fn touched_by(before: &KanbanCard, card: &KanbanCard) -> Touched {
    let last = card.gh_last_read.clone().unwrap_or_default();
    let title = (before.title.trim() != card.title.trim()).then(|| before.title.trim().to_string());
    let brief = (norm(before.notes.as_deref()) != norm(card.notes.as_deref())).then(|| brief_hash(before.notes.as_deref()));
    Touched {
        title: last.title.or(title),
        brief: last.brief.or(brief),
        knowledge: last.knowledge.is_some() || norm(before.knowledge.as_deref()) != norm(card.knowledge.as_deref()),
        unjudged: false,
        adopted: before.gh_raw_remainder.clone().filter(|r| !r.trim().is_empty() && card.gh_raw_remainder.is_none()),
    }
}

/// v1.57.0 (Cycle 3 — increment 3b): mirror an edited card to its backing
/// issue; `labels` swaps the status label for the card's column. A card with
/// no issue number yet is flagged `sync_pending` so reconcile creates it.
/// Best-effort; a failed write flags `sync_pending`, failed labels alone
/// `gh_labels_pending`.
///
/// 1.175.0 (D3): `body` — the card's text changed. With `before` (the card
/// as it was before the member's edit: `kanban_card_patch`, *Use as brief*
/// from D3 round 2)
/// only the parts that edit touched are written, each only if GitHub still
/// has what this computer last read of it; a part both changed raises a
/// question instead ([`EditConflict`]). Without `before` the text is
/// Plyloft's own (a follow-up card's issue it just made, Sync's wrap of an
/// adopted text): the body is rewritten whole, the title left as it is.
pub(crate) fn gh_sync_card_edit(
    store: &KanbanStore,
    repo: &str,
    workspace_id: &str,
    before: Option<&KanbanCard>,
    card: &KanbanCard,
    body: bool,
    labels: bool,
) {
    // Challenger on a pull request: the card stays local — no issue, no
    // label, nothing on GitHub.
    if card.pr_review.is_some() {
        return;
    }
    let Some(number) = card.gh_issue_number else {
        let _ = store.set_github_sync(workspace_id, &card.id, None, Some(true), None);
        return;
    };
    if body {
        let wrote = match before {
            Some(before) => {
                let touched = touched_by(before, card);
                // The baselines are kept first: if the write doesn't land,
                // the Sync that sends it judges it by the same ones.
                remember(store, workspace_id, card, &touched);
                write_touched(store, repo, workspace_id, card, number, &touched).map(|_| ())
            }
            // Plyloft's own text: no baseline to hold it to.
            None => rewrite_body(store, repo, workspace_id, card, number),
        };
        if let Err(e) = wrote {
            log::warn!("github_sync: the edit of card '{}' didn't reach #{number} ({e}); Sync retries", card.id);
            let _ = store.set_github_sync(workspace_id, &card.id, None, Some(true), None);
        }
    }
    if labels {
        // Serialized, for the column the card has *now* (a Resume push can
        // race a later move), with `gh_labels_pending` set unless delivered.
        crate::github_sync::push_status_labels(store, repo, workspace_id, &card.id, number);
        // 1.173.0 (C2), 1.175.0 (D2): Done releases this computer's claim
        // marker, and Ready to start once the card's copy isn't here;
        // another computer's stays.
        crate::device_claim::release_on_move(store, repo, workspace_id, &card.id);
    }
}

/// Keep the baselines of `touched` on the card until its write lands.
fn remember(store: &KanbanStore, workspace_id: &str, card: &KanbanCard, touched: &Touched) {
    let last = GhLastRead {
        title: touched.title.clone(),
        brief: touched.brief.clone(),
        knowledge: Some(String::new()).filter(|_| touched.knowledge),
        updated_at: card.gh_last_read.as_ref().and_then(|l| l.updated_at.clone()),
    };
    let last = Some(last).filter(|l| !l.is_empty());
    if card.gh_last_read == last {
        return;
    }
    if let Err(e) = store.with_card_unstamped(workspace_id, &card.id, |c| {
        c.gh_last_read = last;
        Ok(())
    }) {
        log::warn!("issue edit: remembering what card '{}' last read failed: {e}", card.id);
    }
}

/// Plyloft's own text for the issue it just made (a follow-up card): the
/// body whole, with the claim marker GitHub has now. The title isn't sent.
fn rewrite_body(store: &KanbanStore, repo: &str, workspace_id: &str, card: &KanbanCard, number: u64) -> Result<(), String> {
    let (body, claim) = crate::device_claim::rebuilt_body(repo, number, card)?;
    crate::github::issue_edit_body(repo, number, &body)?;
    let mine = crate::device_claim::this_id_for(repo);
    let _ = store.set_gh_claim(workspace_id, &card.id, claim, mine.as_deref());
    Ok(())
}

/// A Sync's push of a card whose edit didn't reach its issue `number`
/// (`sync_pending`): the same rule as at the edit, by the baselines the card
/// kept. A card pending from before 1.175.0 kept none: there is nothing to
/// judge it by, so what differs from GitHub is written as it always was —
/// the title alone, the body alone — and no question is raised.
pub(crate) fn push_pending(store: &KanbanStore, repo: &str, workspace_id: &str, card: &KanbanCard, number: u64) -> Result<Written, String> {
    let touched = match card.gh_last_read.as_ref().filter(|l| !l.is_empty()) {
        Some(last) => Touched { title: last.title.clone(), brief: last.brief.clone(), knowledge: last.knowledge.is_some(), unjudged: false, adopted: None },
        // Its own value everywhere it differs.
        None => Touched { title: None, brief: None, knowledge: true, unjudged: true, adopted: None },
    };
    write_touched(store, repo, workspace_id, card, number, &touched)
}

// ── The pull, while a question is open ──────────────────────────────────

/// What a pull does with the parts of `card` that ask a question, given the
/// issue as it is now: the title and notes the card keeps, and the questions
/// as they stand afterwards (`None`: unchanged). A question whose GitHub
/// value became the member's own is answered by itself.
pub(crate) struct Kept {
    pub title: Option<String>,
    pub notes: Option<Option<String>>,
    pub conflicts: Option<Vec<EditConflict>>,
}

pub(crate) fn kept_on_pull(card: &KanbanCard, issue_title: &str, issue_notes: Option<&str>, who: Option<&str>, at: Option<i64>) -> Kept {
    let mut kept = Kept { title: None, notes: None, conflicts: None };
    if card.edit_conflicts.is_empty() {
        return kept;
    }
    let mut after: Vec<EditConflict> = Vec::new();
    for conflict in &card.edit_conflicts {
        let (mine, theirs) = match conflict.part {
            EditPart::Title => (card.title.trim().to_string(), issue_title.trim().to_string()),
            EditPart::Brief => (norm(card.notes.as_deref()), norm(issue_notes)),
        };
        if mine == theirs {
            continue; // GitHub has the member's version now: no question left.
        }
        match conflict.part {
            EditPart::Title => kept.title = Some(card.title.clone()),
            EditPart::Brief => kept.notes = Some(card.notes.clone()),
        }
        after.push(if theirs == conflict.theirs {
            conflict.clone()
        } else {
            EditConflict { part: conflict.part, theirs, who: who.map(str::to_string), at }
        });
    }
    if after != card.edit_conflicts {
        kept.conflicts = Some(after);
    }
    kept
}

// ── The answer ──────────────────────────────────────────────────────────

/// What the member chose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Keep {
    Github,
    Mine,
}

/// What became of the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Resolved {
    /// The card shows GitHub's version; nothing was written.
    KeptGithub,
    /// The member's version is on the issue.
    KeptMine,
    /// GitHub's version changed since the question was shown: nothing was
    /// written, and the question shows the new one.
    ChangedAgain,
    /// There was no such question any more (answered elsewhere, or GitHub
    /// now has the member's version).
    Gone,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub outcome: Resolved,
    pub card: KanbanCard,
}

/// Said when the answer couldn't be carried out; Details holds the reason.
pub const CHOICE_NOT_RECORDED: &str = "Plyloft couldn’t record your choice. Try again in a moment.";

/// Answer the question on `part` of the card: `shown` is GitHub's value as
/// the question showed it. The issue is read again first; the answer is
/// carried out only if GitHub still has that value.
pub fn resolve(
    store: &KanbanStore,
    repo: &str,
    workspace_id: &str,
    card_id: &str,
    part: EditPart,
    keep: Keep,
    shown: &str,
) -> Result<Resolution, String> {
    let card = store.get_card(workspace_id, card_id)?;
    let done = |outcome: Resolved| -> Result<Resolution, String> { Ok(Resolution { outcome, card: store.get_card(workspace_id, card_id)? }) };
    if !card.edit_conflicts.iter().any(|c| c.part == part) {
        return done(Resolved::Gone);
    }
    let number = card.gh_issue_number.ok_or_else(|| "This card has no GitHub issue.".to_string())?;
    let issue = crate::github::issue_view(repo, number).map_err(|e| format!("{CHOICE_NOT_RECORDED}\n{e}"))?;
    let remote = remote_of(&issue, &card);
    let (mine, theirs) = (local_value(&card, part), remote.value(part));
    let drop_question = |c: &mut KanbanCard| c.edit_conflicts.retain(|x| x.part != part);
    if mine == theirs {
        store.with_card_unstamped(workspace_id, card_id, |c| {
            drop_question(c);
            Ok(())
        })?;
        return done(Resolved::Gone);
    }
    if theirs != shown.trim() {
        let (who, at) = who_changed(repo, number, part);
        store.with_card_unstamped(workspace_id, card_id, |c| {
            drop_question(c);
            c.edit_conflicts.push(EditConflict { part, theirs, who, at });
            Ok(())
        })?;
        return done(Resolved::ChangedAgain);
    }
    match keep {
        Keep::Github => {
            let (title, notes) = (remote.title.clone(), remote.notes.clone());
            store.with_card(workspace_id, card_id, |c| {
                match part {
                    EditPart::Title => c.title = title,
                    EditPart::Brief => c.notes = notes,
                }
                drop_question(c);
                Ok(())
            })?;
            done(Resolved::KeptGithub)
        }
        Keep::Mine => {
            let wrote = match part {
                EditPart::Title => crate::github::issue_edit_title(repo, number, card.title.trim()),
                EditPart::Brief => {
                    let claim = crate::device_claim::kept_on_rebuild(&card, remote.claim.clone(), repo);
                    let body = crate::github::build_issue_body(card.notes.as_deref(), remote.knowledge.as_deref(), remote.remainder.as_deref());
                    crate::github::issue_edit_body(repo, number, &crate::device_claim::with_claim(&body, claim.as_ref())).map(|()| {
                        let mine = crate::device_claim::this_id_for(repo);
                        let _ = store.set_gh_claim(workspace_id, card_id, claim, mine.as_deref());
                    })
                }
            };
            wrote.map_err(|e| format!("{CHOICE_NOT_RECORDED}\n{e}"))?;
            store.with_card_unstamped(workspace_id, card_id, |c| {
                drop_question(c);
                Ok(())
            })?;
            done(Resolved::KeptMine)
        }
    }
}

/// The card's notice was answered: **Use GitHub's** or **Keep mine** for
/// its title or its brief. On a worker: it reads the issue, and writes it
/// for Keep mine.
#[tauri::command]
pub async fn card_edit_conflict_resolve(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    part: EditPart,
    keep: Keep,
    shown: String,
) -> Result<Resolution, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspaces = app.state::<crate::workspace::WorkspaceStore>();
        crate::commands::team_gate_github_card_write(&workspaces, &app.state::<crate::license::LicenseStore>(), &workspace_id, true)?;
        let repo = crate::commands::workspace_github_target(&workspaces, &workspace_id)
            .ok_or_else(|| "This project's cards aren't GitHub issues.".to_string())?;
        let _github = crate::github_account::enter_for_workspace(&workspaces, &workspace_id);
        let out = resolve(&app.state::<KanbanStore>(), &repo, &workspace_id, &card_id, part, keep, &shown);
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
        out
    })
    .await
    .map_err(|e| format!("edit conflict worker failed: {e}"))?
}

/// The Inbox's words for a card with an open question (its first: the brief
/// before the title). The window's `editConflict.ts` says the same.
pub fn inbox_detail(card: &KanbanCard) -> Option<&'static str> {
    let has = |part: EditPart| card.edit_conflicts.iter().any(|c| c.part == part);
    if has(EditPart::Brief) {
        Some("The brief changed on GitHub · choose which version the card keeps")
    } else if has(EditPart::Title) {
        Some("The title changed on GitHub · choose which version the card keeps")
    } else {
        None
    }
}

#[cfg(test)]
#[path = "issue_edit_tests.rs"]
mod tests;
