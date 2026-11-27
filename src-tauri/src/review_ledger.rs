//! ADR 0006, second card — the findings ledger of a card.
//!
//! Before it, every round was a first review of the whole change with no
//! memory of what was already asked: the Challenger re-read everything and
//! the Builder could not tell a finding still open from a new one. Now each
//! finding of a completed review gets an id within its card (`F1`, `F2`…),
//! never reused, and a state — open, closed, or still open after a fix.
//! Every review after the sweep is a follow-up: it is given the open
//! findings by id and answers each; the Builder receives only what is still
//! open and what is new.
//!
//! The ledger lives with the card's review records (`reviewer.rs`,
//! `reviews/state.json`, written atomically with the record that changed
//! it). Pure; `reviewer.rs` owns the store.

use serde::{Deserialize, Serialize};

use crate::review_answer::EarlierAnswer;
use crate::review_passes::ReviewFinding;

/// A finding's complete text as the ledger keeps it: what a follow-up
/// quotes and the Builder receives.
const LEDGER_BODY_MAX_CHARS: usize = 8 * 1024;
/// Findings a card's ledger keeps. Past it, the oldest closed ones go
/// first; ids are never reused either way.
const LEDGER_FINDINGS_MAX: usize = 200;
/// The open findings a follow-up prompt quotes, in bytes.
const OPEN_BLOCK_MAX_BYTES: usize = 96 * 1024;
/// ADR 0006: `Ship with follow-up` is offered from this changes-requested
/// verdict on one card.
pub const SHIP_WITH_FOLLOW_UP_FROM: u32 = 4;
/// A dismissal's reason, in characters: one line.
pub const DISMISS_REASON_MAX_CHARS: usize = 300;
/// The dismissed findings a review prompt quotes, in bytes.
const DISMISSED_BLOCK_MAX_BYTES: usize = 16 * 1024;

/// Findings filter: which of the Challenger's findings block approval in a
/// workspace (`Findings that block approval`, Settings › Build & release).
/// A finding below the threshold stays on the card, marked not blocking: it
/// never by itself keeps a review in changes requested or starts a round.
/// Pre-existing findings (code this change did not write) never block,
/// whatever the threshold.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub enum BlockingThreshold {
    /// P1 only (and an unrated finding, which Ply cannot rate lower).
    #[serde(rename = "p1")]
    P1,
    /// P1 and P2 in code this change wrote, unrated ones too: the rule
    /// before the setting existed, and the default.
    #[default]
    #[serde(rename = "p1-p2")]
    P1P2,
    /// Every finding in code this change wrote: P3 and notes too.
    #[serde(rename = "all")]
    All,
}

impl<'de> Deserialize<'de> for BlockingThreshold {
    /// A value this build does not know (a newer app's) reads as the
    /// default instead of refusing the whole file it sits in.
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(match raw.as_str() {
            "p1" => Self::P1,
            "all" => Self::All,
            _ => Self::P1P2,
        })
    }
}

impl BlockingThreshold {
    /// The setting's option as Settings names it.
    pub fn label(self) -> &'static str {
        match self {
            Self::P1 => "P1 only",
            Self::P1P2 => "P1 and P2",
            Self::All => "All findings",
        }
    }

    /// Whether a finding with these facts blocks approval at this threshold.
    pub fn blocks(self, severity: Option<&str>, pre_existing: bool, note: bool) -> bool {
        if pre_existing {
            return false;
        }
        match self {
            Self::P1 => !note && matches!(severity, Some("P1") | None),
            Self::P1P2 => !note && severity != Some("P3"),
            Self::All => true,
        }
    }
}

/// "Not a real issue": the member dismissed an open finding. It stays on
/// the card as dismissed, never blocks again, and the next review is told
/// so (with the reason) so it is not raised again unless something new.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Dismissal {
    /// One line, in the member's words; None when they gave none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Who dismissed it (the identity's email), when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    /// When (ms).
    pub at: i64,
    /// The ledger round it was dismissed after.
    pub round: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FindingState {
    /// Raised and not answered since.
    #[default]
    Open,
    /// A later review said it is fixed.
    Closed,
    /// A later review said the fix did not close it.
    StillOpen,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LedgerFinding {
    /// "F3": unique within the card, never reused.
    pub id: String,
    /// "P1" | "P2" | "P3"; None when the reviewer rated none.
    pub severity: Option<String>,
    pub pre_existing: bool,
    /// Reported as a note, not a request: an approving pass's finding, or
    /// one under `Non-blocking`, whatever its severity (an unrated note is
    /// still a note). False on ledgers before it.
    pub note: bool,
    /// `path:line`, when the answer gave one.
    pub location: Option<String>,
    pub title: String,
    /// The finding's complete text, bounded.
    pub body: String,
    /// The review record that raised it.
    pub review_id: String,
    /// The round that raised it: 1 is the card's first completed review.
    pub round: u32,
    pub state: FindingState,
    /// The reviewer's reason for the current state, when it gave one.
    pub reason: Option<String>,
    /// The round that last changed the state.
    pub updated_round: u32,
    /// ADR 0006 (third card): raised by a follow-up review, which marked its
    /// defect as already in the code the sweep read — a class the checklist
    /// may be missing. False for sweep findings and on ledgers before it.
    pub sweep_saw: bool,
    /// CL-6: where the finding points, as separate fields — the file, its
    /// line in `reviewed_revision`, and that revision (the commit the review
    /// that last reported it read). The review diff places the finding on
    /// that line, mapped to the branch as it is now. None on ledgers before
    /// CL-6 (`location` is read for display then, as possibly moved) and on
    /// findings the reviewer gave no path or line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewed_revision: Option<String>,
    /// Findings filter: whether it blocks under the workspace's threshold at
    /// the last fold, kept only where that differs from the rule before the
    /// setting (`legacy_blocks`). None on ledgers before it and wherever the
    /// default threshold applies, so those files stay as they were.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking: Option<bool>,
    /// "Not a real issue": the member's dismissal. None while not dismissed,
    /// and on ledgers before it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dismissal: Option<Dismissal>,
}

impl LedgerFinding {
    /// What a request for changes is about: by default P1 and P2 in code
    /// this change wrote (P3 and pre-existing findings never block); the
    /// workspace's threshold as the last fold read it; never once dismissed.
    pub fn blocks(&self) -> bool {
        self.dismissal.is_none() && self.blocking.unwrap_or_else(|| self.legacy_blocks())
    }

    /// The rule before the findings filter, which `P1 and P2` keeps.
    pub fn legacy_blocks(&self) -> bool {
        BlockingThreshold::P1P2.blocks(self.severity.as_deref(), self.pre_existing, self.note)
    }

    /// Open: not closed by a review, and not dismissed by the member.
    pub fn is_open(&self) -> bool {
        self.state != FindingState::Closed && self.dismissal.is_none()
    }

    /// Findings filter: read whether it blocks at `threshold`, kept only
    /// where that differs from the default rule.
    fn apply_threshold(&mut self, threshold: BlockingThreshold) {
        let blocks = threshold.blocks(self.severity.as_deref(), self.pre_existing, self.note);
        self.blocking = (blocks != self.legacy_blocks()).then_some(blocks);
    }

    /// CL-6: the file and line the finding points at, and the revision the
    /// line belongs to. Ledgers before CL-6 have `location` only: its path
    /// and line are read, with no revision (the line may have moved since).
    pub fn anchor(&self) -> Option<(String, Option<u32>, Option<&str>)> {
        if let Some(path) = self.path.as_deref().filter(|path| !path.is_empty()) {
            return Some((path.to_string(), self.line, self.reviewed_revision.as_deref()));
        }
        let (path, line) = split_location(self.location.as_deref()?)?;
        Some((path, line, None))
    }
}

/// CL-6: `path:line` → (path, Some(line)); a path alone → (path, None).
/// The inverse of `review_answer::location`, which wrote it.
pub fn split_location(location: &str) -> Option<(String, Option<u32>)> {
    let location = location.trim();
    if location.is_empty() {
        return None;
    }
    if let Some((path, line)) = location.rsplit_once(':') {
        if let Ok(line) = line.trim().parse::<u32>() {
            if line > 0 && !path.trim().is_empty() {
                return Some((path.trim().to_string(), Some(line)));
            }
        }
    }
    Some((location.to_string(), None))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CardLedger {
    pub workspace_id: String,
    pub card_id: String,
    /// The number the next finding gets: ids are never reused.
    pub next_id: u32,
    /// Completed reviews folded in.
    pub rounds: u32,
    /// The revision and the base the last folded review read: a follow-up
    /// reviews `reviewed_revision..head`, and falls back to a sweep when
    /// the base moved.
    pub reviewed_revision: Option<String>,
    pub base_revision: Option<String>,
    pub findings: Vec<LedgerFinding>,
}

impl CardLedger {
    pub fn new(workspace_id: &str, card_id: &str) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            card_id: card_id.into(),
            next_id: 1,
            ..Self::default()
        }
    }

    /// The blocking findings still open: what a follow-up re-checks.
    pub fn open_blocking(&self) -> Vec<&LedgerFinding> {
        self.findings
            .iter()
            .filter(|finding| finding.is_open() && finding.blocks())
            .collect()
    }
}

/// What folding one completed review into a ledger changed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Fold {
    /// The id of each finding the review reported, in the order they were
    /// passed: a new id, or an open finding's own when it was reported again.
    pub new_ids: Vec<String>,
    /// Earlier findings this review closed.
    pub closed: Vec<String>,
    /// Blocking findings raised by earlier rounds and open after this one:
    /// reported still open (or again), or not answered.
    pub still_open: Vec<String>,
    /// CL-5: the ledger round this review was (1 is the card's first).
    pub round: u32,
    /// CL-5: findings this review raised for the first time (a repeat of an
    /// open one is not new), split into blocking ones and notes.
    pub fresh_blocking: u32,
    pub fresh_notes: u32,
    /// CL-5 (round 2): the ids of those findings, blocking and notes.
    pub fresh_ids: Vec<String>,
}

impl Fold {
    /// CL-5: the round as the card keeps it, in counts.
    pub fn counts(&self) -> RoundCounts {
        RoundCounts {
            round: self.round,
            new: self.fresh_blocking,
            notes: self.fresh_notes,
            closed: self.closed.len() as u32,
            still_open: self.still_open.len() as u32,
            new_ids: self.fresh_ids.clone(),
            closed_ids: self.closed.clone(),
            still_open_ids: self.still_open.clone(),
        }
    }
}

/// CL-5: what one folded review round did to the card's ledger, in counts.
/// Kept on the reviewer record and copied onto the card, which keeps its
/// rounds after the ledger prunes old closed findings and the records are
/// evicted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RoundCounts {
    /// The ledger round: the `round` of the findings it raised.
    pub round: u32,
    /// Blocking findings raised for the first time.
    pub new: u32,
    /// Non-blocking findings (P3, pre-existing, notes) raised for the first time.
    pub notes: u32,
    /// Earlier findings this round closed.
    pub closed: u32,
    /// Blocking findings of earlier rounds still open after it.
    pub still_open: u32,
    /// CL-5 (round 2): the ids behind the counts, as the fold saw them —
    /// what the round's findings are, whatever later rounds do to the
    /// findings' own `round` / `updated_round`. `new_ids` holds the notes
    /// too. Left out of the file while empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub new_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub closed_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub still_open_ids: Vec<String>,
}

/// Fold a completed review into the card's ledger: apply its answers about
/// earlier findings, then give its findings their ids. `raised` is every
/// finding it reported (blocking and not), each with its complete text.
/// A finding the review did not answer keeps its state: an answer Ply did
/// not get never closes one. A new finding with the title and location of
/// an open one is that finding still open, not a new id. At the default
/// threshold; `fold_at` takes the workspace's.
#[cfg(test)]
pub fn fold(
    ledger: &mut CardLedger,
    review_id: &str,
    reviewed_revision: &str,
    base_revision: &str,
    raised: &[(ReviewFinding, String, bool)],
    earlier: &[EarlierAnswer],
) -> Fold {
    fold_at(ledger, review_id, reviewed_revision, base_revision, raised, earlier, BlockingThreshold::default())
}

/// `fold` under the workspace's findings filter: every finding's blocking
/// is read at `threshold` before the round's counts and what stays open.
pub fn fold_at(
    ledger: &mut CardLedger,
    review_id: &str,
    reviewed_revision: &str,
    base_revision: &str,
    raised: &[(ReviewFinding, String, bool)],
    earlier: &[EarlierAnswer],
    threshold: BlockingThreshold,
) -> Fold {
    if ledger.next_id == 0 {
        ledger.next_id = 1;
    }
    ledger.rounds += 1;
    let round = ledger.rounds;
    let mut out = Fold {
        round,
        ..Fold::default()
    };
    for answer in earlier {
        let Some(finding) = ledger.findings.iter_mut().find(|finding| finding.id == answer.id) else {
            continue;
        };
        let reason = (!answer.reason.is_empty()).then(|| answer.reason.clone());
        if answer.closed {
            if finding.state != FindingState::Closed {
                out.closed.push(finding.id.clone());
            }
            finding.state = FindingState::Closed;
        } else {
            finding.state = FindingState::StillOpen;
        }
        finding.reason = reason;
        finding.updated_round = round;
    }
    for (finding, text, blocking) in raised {
        let repeat = ledger.findings.iter_mut().find(|known| {
            known.is_open()
                && known.round < round
                && known.title.trim().eq_ignore_ascii_case(finding.title.trim())
                && known.location == finding.location
        });
        if let Some(known) = repeat {
            // Same id and round raised; the latest text, and the graver
            // reading of severity and of whether it blocks.
            if severity_rank(finding.severity.as_deref()) < severity_rank(known.severity.as_deref()) {
                known.severity = finding.severity.clone();
            }
            known.pre_existing &= finding.pre_existing;
            known.note &= !*blocking;
            known.body = capped(text);
            known.state = FindingState::StillOpen;
            known.updated_round = round;
            known.reason = Some("Reported again by this review.".into());
            // CL-6: the line it names now is the line in this revision.
            set_anchor(known, reviewed_revision);
            out.new_ids.push(known.id.clone());
            continue;
        }
        let id = format!("F{}", ledger.next_id);
        ledger.next_id += 1;
        let note = !*blocking;
        let blocks_now = threshold.blocks(finding.severity.as_deref(), finding.pre_existing, note);
        if blocks_now {
            out.fresh_blocking += 1;
        } else {
            out.fresh_notes += 1;
        }
        out.fresh_ids.push(id.clone());
        ledger.findings.push(LedgerFinding {
            id: id.clone(),
            severity: finding.severity.clone(),
            pre_existing: finding.pre_existing,
            note,
            location: finding.location.clone(),
            title: finding.title.clone(),
            body: capped(text),
            review_id: review_id.into(),
            round,
            state: FindingState::Open,
            reason: None,
            updated_round: round,
            sweep_saw: finding.sweep_saw && round > 1,
            ..LedgerFinding::default()
        });
        if let Some(added) = ledger.findings.last_mut() {
            set_anchor(added, reviewed_revision);
        }
        out.new_ids.push(id);
    }
    for finding in &mut ledger.findings {
        finding.apply_threshold(threshold);
    }
    out.still_open = ledger
        .findings
        .iter()
        .filter(|finding| finding.is_open() && finding.blocks() && finding.round < round)
        .map(|finding| finding.id.clone())
        .collect();
    ledger.reviewed_revision = Some(reviewed_revision.into());
    ledger.base_revision = Some(base_revision.into());
    prune(ledger);
    out
}

/// CL-6: the anchor fields from the finding's `location`, at the revision
/// the review that reported it read.
fn set_anchor(finding: &mut LedgerFinding, reviewed_revision: &str) {
    let Some((path, line)) = finding.location.as_deref().and_then(split_location) else {
        return;
    };
    finding.path = Some(path);
    finding.line = line;
    finding.reviewed_revision = (!reviewed_revision.trim().is_empty()).then(|| reviewed_revision.to_string());
}

/// P1 is the gravest; an unrated finding sits between P2 and P3.
fn severity_rank(severity: Option<&str>) -> u8 {
    match severity {
        Some("P1") => 0,
        Some("P2") => 1,
        None => 2,
        _ => 3,
    }
}

fn capped(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= LEDGER_BODY_MAX_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(LEDGER_BODY_MAX_CHARS - 1).collect();
    out.push('…');
    out
}

/// Keep at most `LEDGER_FINDINGS_MAX` findings, dropping the oldest closed
/// ones first, then the oldest non-blocking ones. Open blocking findings
/// are never dropped.
fn prune(ledger: &mut CardLedger) {
    for drop_closed in [true, false] {
        while ledger.findings.len() > LEDGER_FINDINGS_MAX {
            let Some(index) = ledger.findings.iter().position(|finding| {
                if drop_closed {
                    !finding.is_open()
                } else {
                    !finding.blocks()
                }
            }) else {
                break;
            };
            ledger.findings.remove(index);
        }
    }
}

/// "Not a real issue": the member dismisses open finding `id`, with an
/// optional one-line reason. Refused for a finding the ledger does not hold,
/// or one already closed or dismissed.
pub fn dismiss(
    ledger: &mut CardLedger,
    id: &str,
    reason: Option<&str>,
    by: Option<&str>,
    at: i64,
) -> Result<(), String> {
    let id = id.trim();
    let rounds = ledger.rounds;
    let finding = ledger
        .findings
        .iter_mut()
        .find(|finding| finding.id.eq_ignore_ascii_case(id))
        .ok_or_else(|| format!("Finding {id} is not in this card's findings any more."))?;
    if finding.dismissal.is_some() {
        return Err(format!("{} is already dismissed.", finding.id));
    }
    if finding.state == FindingState::Closed {
        return Err(format!("{} is already closed.", finding.id));
    }
    let reason = reason
        .map(|reason| reason.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|reason| !reason.is_empty())
        .map(|reason| clip(&reason, DISMISS_REASON_MAX_CHARS));
    finding.dismissal = Some(Dismissal {
        reason,
        by: by.map(str::trim).filter(|by| !by.is_empty()).map(str::to_string),
        at,
        round: rounds,
    });
    Ok(())
}

/// The findings the member dismissed, as a review prompt quotes them so the
/// Challenger does not raise them again: one line each, with the reason.
/// Empty when none is dismissed.
pub fn dismissed_block(ledger: &CardLedger) -> String {
    let mut out = String::new();
    for finding in ledger.findings.iter().filter(|finding| finding.dismissal.is_some()) {
        let mut line = format!(
            "- {} — {} — {}",
            finding.id,
            finding.severity.as_deref().unwrap_or("Unrated"),
            clip(finding.title.trim(), OPEN_LINE_PART_MAX_CHARS)
        );
        if let Some(at) = &finding.location {
            line.push_str(&format!(" `{}`", clip(at.trim(), OPEN_LINE_PART_MAX_CHARS)));
        }
        match finding.dismissal.as_ref().and_then(|dismissal| dismissal.reason.as_deref()) {
            Some(reason) => line.push_str(&format!(" — the member's reason: \"{}\"", reason.replace('"', "'"))),
            None => line.push_str(" — no reason given"),
        }
        line.push('\n');
        if out.len() + line.len() > DISMISSED_BLOCK_MAX_BYTES {
            out.push_str("- [Plyloft: more dismissed findings are not listed here.]\n");
            break;
        }
        out.push_str(&line);
    }
    out.trim_end().to_string()
}

/// The open blocking findings as a follow-up quotes them, one block per id:
/// `- F3 — P2 — Title. \`path:line\` (raised in round 1; still open: why)`
/// then the complete text, indented. Empty when none is open. Every open id
/// is always listed: when the whole texts do not fit, each finding keeps its
/// line and a share of its text (the reviewer can open the code at its
/// path), so no finding goes unanswered for want of room.
pub fn open_block(ledger: &CardLedger) -> String {
    let open = ledger.open_blocking();
    let full = render_open(&open, None);
    if full.len() <= OPEN_BLOCK_MAX_BYTES {
        return full;
    }
    // Heads first, then an equal share of what is left for each text.
    let heads = render_open(&open, Some(0)).len();
    let share = OPEN_BLOCK_MAX_BYTES
        .saturating_sub(heads + OPEN_BLOCK_CUT_NOTICE.len() + 2)
        / open.len().max(1);
    let fitted = render_open(&open, Some(share.max(OPEN_BODY_MIN_CHARS)));
    let out = format!("{fitted}\n\n{OPEN_BLOCK_CUT_NOTICE}");
    if out.len() <= OPEN_BLOCK_MAX_BYTES {
        return out;
    }
    // Still too long (hundreds of open findings): the lines alone.
    format!("{}\n\n{OPEN_BLOCK_CUT_NOTICE}", render_open(&open, Some(0)))
}

const OPEN_BLOCK_CUT_NOTICE: &str = "[Plyloft: the texts of these findings were shortened to fit; every open finding is listed by id. Open the code at each path for the rest.]";
/// Characters of text each finding keeps at the least when texts are cut.
const OPEN_BODY_MIN_CHARS: usize = 200;
/// A title or reason in the shortened form.
const OPEN_LINE_PART_MAX_CHARS: usize = 160;

/// `body_chars`: None keeps every text whole; Some(n) keeps n characters
/// of each (0: the lines alone) and shortens titles and reasons.
fn render_open(open: &[&LedgerFinding], body_chars: Option<usize>) -> String {
    let part = |text: &str| match body_chars {
        None => text.trim().to_string(),
        Some(_) => clip(text.trim(), OPEN_LINE_PART_MAX_CHARS),
    };
    let mut out = String::new();
    for finding in open {
        let mut head = format!(
            "- {} — {} — {}",
            finding.id,
            finding.severity.as_deref().unwrap_or("Unrated"),
            part(&finding.title)
        );
        if let Some(at) = &finding.location {
            head.push_str(&format!(" `{}`", part(at)));
        }
        head.push_str(&format!(" (raised in round {}", finding.round));
        if finding.state == FindingState::StillOpen {
            match &finding.reason {
                Some(reason) => head.push_str(&format!("; still open: {}", part(reason))),
                None => head.push_str("; still open"),
            }
        }
        head.push(')');
        out.push_str(&head);
        let body = match body_chars {
            None => finding.body.trim().to_string(),
            Some(0) => String::new(),
            Some(n) => clip(finding.body.trim(), n),
        };
        if !body.is_empty() {
            out.push_str("\n  ");
            out.push_str(&body.replace('\n', "\n  "));
        }
        out.push_str(if body_chars == Some(0) { "\n" } else { "\n\n" });
    }
    out.trim_end().to_string()
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The request for changes the Builder receives after a review folded into
/// the ledger: the findings still open from earlier rounds, then the new
/// ones, each by its id — never one the review closed. `unread` is the
/// reviewer's own words when Ply could not read every finding; `notes` the
/// new non-blocking findings.
pub fn handoff(ledger: &CardLedger, fold: &Fold, unread: &[String], rest: &str) -> String {
    let find = |id: &str| ledger.findings.iter().find(|finding| finding.id == id);
    let line = |finding: &LedgerFinding, lead: String| {
        format!("- {lead}\n  {}", finding.body.trim().replace('\n', "\n  "))
    };
    let mut sections: Vec<String> = Vec::new();
    let still: Vec<String> = fold
        .still_open
        .iter()
        .filter_map(|id| find(id))
        .map(|finding| {
            let why = match (&finding.state, &finding.reason) {
                (FindingState::StillOpen, Some(reason)) => format!("still open: {reason}"),
                (FindingState::StillOpen, None) => "still open".to_string(),
                _ => "not answered by this review, so still open".to_string(),
            };
            line(finding, format!("{} (raised in round {}; {why})", finding.id, finding.round))
        })
        .collect();
    if !still.is_empty() {
        sections.push(format!("Still open from earlier rounds:\n\n{}", still.join("\n\n")));
    }
    let mut seen = std::collections::HashSet::new();
    let (new_blocking, new_notes): (Vec<&LedgerFinding>, Vec<&LedgerFinding>) = fold
        .new_ids
        .iter()
        .filter(|id| seen.insert(id.as_str()) && !fold.still_open.contains(id))
        .filter_map(|id| find(id))
        .filter(|finding| finding.is_open())
        .partition(|finding| finding.blocks());
    if !new_blocking.is_empty() {
        sections.push(format!(
            "New findings:\n\n{}",
            new_blocking
                .iter()
                .map(|finding| line(finding, finding.id.clone()))
                .collect::<Vec<_>>()
                .join("\n\n")
        ));
    }
    if !unread.is_empty() {
        sections.push(format!(
            "Plyloft could not read or keep every finding. The requesting passes in the Reviewer's own words:\n\n{}",
            unread.join("\n\n")
        ));
    }
    if !new_notes.is_empty() {
        sections.push(format!(
            "Non-blocking (optional, do not start a round for these; pre-existing ones are in code this change did not write):\n\n{}",
            new_notes
                .iter()
                .map(|finding| line(finding, finding.id.clone()))
                .collect::<Vec<_>>()
                .join("\n\n")
        ));
    }
    crate::review_passes::cap_with_notice(
        &sections.join("\n\n"),
        64 * 1024,
        &format!("[Plyloft: the review is longer than Plyloft sends into the session; {rest}. Read it before you start.]"),
    )
}

/// ADR 0006: whether the Ship step offers `Ship with follow-up`: from the
/// fourth changes-requested verdict on the card, with findings open, and
/// never while a P1 of this change is open.
pub fn ship_with_follow_up_offered(changes_requested: u32, ledger: &[LedgerFinding]) -> bool {
    changes_requested >= SHIP_WITH_FOLLOW_UP_FROM
        && ledger.iter().any(|finding| finding.is_open() && finding.blocks())
        && !ledger.iter().any(|finding| {
            finding.is_open() && !finding.pre_existing && finding.severity.as_deref() == Some("P1")
        })
}

/// The findings `Ship with follow-up` carries into the new card: every open
/// one this change wrote, blocking first. Pre-existing findings are not the
/// card's; each can become a card of its own.
pub fn follow_up_findings(ledger: &[LedgerFinding]) -> Vec<&LedgerFinding> {
    let mut open: Vec<&LedgerFinding> = ledger
        .iter()
        .filter(|finding| finding.is_open() && !finding.pre_existing)
        .collect();
    open.sort_by_key(|finding| !finding.blocks());
    open
}

/// The new card's brief: the open findings with their ids, and the shipped
/// card and its PR (`shipped_as`, when known).
pub fn follow_up_brief(card_title: &str, findings: &[&LedgerFinding], shipped_as: Option<&str>) -> String {
    // Until the card lands the brief says so: a ship refused or failed after
    // this card was made must not leave it claiming a ship that never was.
    let mut out = format!(
        "\"{card_title}\" {} with {} open finding{} from the Reviewer. Each is below with its id on that card; fix them here.\n",
        if shipped_as.is_some() { "shipped" } else { "is being shipped (not landed yet)" },
        findings.len(),
        if findings.len() == 1 { "" } else { "s" }
    );
    if let Some(shipped) = shipped_as {
        out.push_str(&format!("\nShipped as: {shipped}\n"));
    }
    for finding in findings {
        out.push_str(&format!(
            "\n**{} — {}{} — {}**{}\n{}\n",
            finding.id,
            finding.severity.as_deref().unwrap_or("Unrated"),
            if finding.blocks() { "" } else { " (non-blocking)" },
            finding.title.trim(),
            finding.location.as_ref().map(|at| format!(" `{at}`")).unwrap_or_default(),
            finding.body.trim()
        ));
    }
    out
}

/// An existing PR's body with the follow-up line, replacing an earlier one
/// (a retried ship may carry other findings).
pub fn pr_body_with_follow_up(body: &str, line: &str) -> String {
    let kept: Vec<&str> = body
        .lines()
        // Only an earlier follow-up line: #129's handed-over line starts the
        // same way and ends with ", not re-checked"; it is not ours to drop.
        .filter(|l| {
            let l = l.trim_start();
            !(l.starts_with("**Shipped with ") && !l.contains(", not re-checked"))
        })
        .collect();
    let mut out = kept.join("\n").trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&format!("**{line}**"));
    out
}

/// The PR body line of a card shipped with follow-up.
pub fn follow_up_pr_line(count: usize, card_ref: &str) -> String {
    format!(
        "Shipped with {count} open finding{}: {card_ref}",
        if count == 1 { "" } else { "s" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raised(severity: &str, title: &str) -> (ReviewFinding, String, bool) {
        (
            ReviewFinding {
                severity: Some(severity.into()),
                title: title.into(),
                body: format!("**{severity} — {title}.**"),
                location: Some("src/a.rs:10".into()),
                ..ReviewFinding::default()
            },
            format!("**{severity} — {title}.** `src/a.rs:10`\nWhat goes wrong, in full."),
            severity != "P3",
        )
    }

    fn answer(id: &str, closed: bool) -> EarlierAnswer {
        EarlierAnswer { id: id.into(), closed, reason: format!("{id} reason") }
    }

    #[test]
    fn ids_are_stable_across_reviews_and_never_reused() {
        let mut ledger = CardLedger::new("w", "c");
        let first = fold(&mut ledger, "r1", "rev1", "base", &[raised("P1", "A"), raised("P2", "B")], &[]);
        assert_eq!(first.new_ids, vec!["F1", "F2"]);
        // Round 2 closes F1 and raises one new finding: F3, never F1 again.
        let second = fold(&mut ledger, "r2", "rev2", "base", &[raised("P2", "C")], &[answer("F1", true), answer("F2", false)]);
        assert_eq!(second.new_ids, vec!["F3"]);
        assert_eq!(second.closed, vec!["F1"]);
        assert_eq!(second.still_open, vec!["F2"]);
        let f2 = ledger.findings.iter().find(|f| f.id == "F2").unwrap();
        assert_eq!((f2.state, f2.round, f2.updated_round), (FindingState::StillOpen, 1, 2));
        assert_eq!(f2.reason.as_deref(), Some("F2 reason"));
        // Pruning closed findings never frees their numbers.
        ledger.findings.retain(|f| f.id != "F1");
        let third = fold(&mut ledger, "r3", "rev3", "base", &[raised("P3", "D")], &[]);
        assert_eq!(third.new_ids, vec!["F4"]);
        assert_eq!(ledger.rounds, 3);
        assert_eq!(ledger.reviewed_revision.as_deref(), Some("rev3"));
    }

    /// CL-5: the counts a card keeps for each round, from a multi-round
    /// ledger: new (blocking, first raised), notes, closed, still open.
    #[test]
    fn each_round_is_counted_new_closed_and_still_open() {
        let ids = |list: &[&str]| list.iter().map(|id| id.to_string()).collect::<Vec<_>>();
        let mut ledger = CardLedger::new("w", "c");
        let one = fold(&mut ledger, "r1", "rev1", "base", &[raised("P1", "A"), raised("P2", "B"), raised("P3", "N")], &[]);
        assert_eq!(one.counts(), RoundCounts { round: 1, new: 2, notes: 1, closed: 0, still_open: 0, new_ids: ids(&["F1", "F2", "F3"]), ..RoundCounts::default() });
        // Round 2 closes A, leaves B open, repeats B (not new) and raises C.
        let two = fold(
            &mut ledger,
            "r2",
            "rev2",
            "base",
            &[raised("P2", "B"), raised("P2", "C")],
            &[answer("F1", true), answer("F2", false)],
        );
        assert_eq!(two.counts(), RoundCounts { round: 2, new: 1, notes: 0, closed: 1, still_open: 1, new_ids: ids(&["F4"]), closed_ids: ids(&["F1"]), still_open_ids: ids(&["F2"]) });
        // Round 3 closes both: nothing new, nothing open.
        let three = fold(&mut ledger, "r3", "rev3", "base", &[], &[answer("F2", true), answer("F4", true)]);
        assert_eq!(three.counts(), RoundCounts { round: 3, closed: 2, closed_ids: ids(&["F2", "F4"]), ..RoundCounts::default() });
        // An answer that closes an already closed finding is not counted again.
        let four = fold(&mut ledger, "r4", "rev4", "base", &[], &[answer("F1", true)]);
        assert_eq!(four.counts(), RoundCounts { round: 4, ..RoundCounts::default() });
        // Round 6 leaves round 5's finding unanswered: it is still open in
        // round 6 by id, although its own `updated_round` stays 5.
        fold(&mut ledger, "r5", "rev5", "base", &[raised("P2", "D")], &[]);
        let six = fold(&mut ledger, "r6", "rev6", "base", &[], &[]);
        assert_eq!(six.counts().still_open_ids, ids(&["F5"]));
        let f5 = ledger.findings.iter().find(|f| f.id == "F5").unwrap();
        assert_eq!(f5.updated_round, 5);
    }

    #[test]
    fn an_unanswered_finding_stays_open_and_an_unknown_id_is_ignored() {
        let mut ledger = CardLedger::new("w", "c");
        fold(&mut ledger, "r1", "rev1", "base", &[raised("P2", "A")], &[]);
        let second = fold(&mut ledger, "r2", "rev2", "base", &[], &[answer("F9", true)]);
        assert_eq!(second.still_open, vec!["F1"]);
        assert_eq!(ledger.findings[0].state, FindingState::Open);
    }

    #[test]
    fn a_repeated_finding_keeps_its_id() {
        let mut ledger = CardLedger::new("w", "c");
        fold(&mut ledger, "r1", "rev1", "base", &[raised("P2", "Loses edits")], &[]);
        let second = fold(&mut ledger, "r2", "rev2", "base", &[raised("P2", "loses edits")], &[]);
        assert_eq!(second.new_ids, vec!["F1"]);
        assert_eq!(ledger.next_id, 2);
        assert_eq!(ledger.findings[0].state, FindingState::StillOpen);
    }

    /// Challenger P2 on snapshot 1: a repeat reported as P1 escalates the
    /// finding, and an open P1 withdraws the offer.
    #[test]
    fn a_repeat_escalated_to_p1_keeps_its_id_and_blocks_the_offer() {
        let mut ledger = CardLedger::new("w", "c");
        fold(&mut ledger, "r1", "rev1", "base", &[raised("P2", "Races")], &[]);
        let mut again = raised("P1", "Races");
        again.1 = "**P1 — Races.** now loses data".into();
        let second = fold(&mut ledger, "r2", "rev2", "base", &[again], &[]);
        assert_eq!(second.new_ids, vec!["F1"]);
        let f1 = &ledger.findings[0];
        assert_eq!((f1.severity.as_deref(), f1.round), (Some("P1"), 1));
        assert!(f1.body.contains("now loses data"));
        assert!(!ship_with_follow_up_offered(4, &ledger.findings));
        // A lower severity reported again never lowers it.
        fold(&mut ledger, "r3", "rev3", "base", &[raised("P3", "Races")], &[]);
        assert_eq!(ledger.findings[0].severity.as_deref(), Some("P1"));
    }

    #[test]
    fn a_finding_reported_closed_leaves_the_injected_text() {
        let mut ledger = CardLedger::new("w", "c");
        fold(&mut ledger, "r1", "rev1", "base", &[raised("P1", "Closed one"), raised("P2", "Open one")], &[]);
        let second = fold(&mut ledger, "r2", "rev2", "base", &[raised("P2", "Fresh"), raised("P3", "Nit")], &[answer("F1", true), answer("F2", false)]);
        let text = handoff(&ledger, &second, &[], "rest");
        assert!(!text.contains("F1"), "{text}");
        assert!(!text.contains("Closed one"));
        assert!(text.contains("Still open from earlier rounds:\n\n- F2 (raised in round 1; still open: F2 reason)"));
        assert!(text.contains("New findings:\n\n- F3\n  **P2 — Fresh.**"));
        assert!(text.contains("Non-blocking (optional"));
        assert!(text.contains("- F4\n  **P3 — Nit.**"));
    }

    #[test]
    fn the_open_block_lists_open_blocking_findings_by_id() {
        let mut ledger = CardLedger::new("w", "c");
        fold(&mut ledger, "r1", "rev1", "base", &[raised("P1", "A"), raised("P2", "B"), raised("P3", "C")], &[]);
        fold(&mut ledger, "r2", "rev2", "base", &[], &[answer("F1", true), answer("F2", false)]);
        let block = open_block(&ledger);
        assert!(block.starts_with("- F2 — P2 — B `src/a.rs:10` (raised in round 1; still open: F2 reason)\n  **P2 — B.**"), "{block}");
        assert!(!block.contains("F1") && !block.contains("F3"), "closed and P3 are not re-checked");
    }

    /// Challenger P2 on snapshot 7: a ledger too large for the prompt still
    /// lists every open id, so a follow-up can close each one.
    #[test]
    fn every_open_finding_is_listed_however_large_the_ledger() {
        let mut ledger = CardLedger::new("w", "c");
        let many: Vec<(ReviewFinding, String, bool)> = (0..180)
            .map(|i| {
                let mut r = raised("P2", &format!("Finding number {i}"));
                r.1 = format!("{}\n{}", r.1, "a long scenario ".repeat(400));
                r
            })
            .collect();
        fold(&mut ledger, "r1", "rev1", "base", &many, &[]);
        let block = open_block(&ledger);
        assert!(block.len() <= OPEN_BLOCK_MAX_BYTES, "{}", block.len());
        for i in 1..=180 {
            assert!(block.contains(&format!("- F{i} — P2 — ")), "F{i} missing");
        }
        assert!(block.ends_with(OPEN_BLOCK_CUT_NOTICE));
        // A small ledger is quoted whole.
        let mut small = CardLedger::new("w", "c");
        fold(&mut small, "r1", "rev1", "base", &[raised("P2", "A")], &[]);
        assert!(!open_block(&small).contains("shortened"));
        assert!(open_block(&small).contains("What goes wrong, in full."));
    }

    #[test]
    fn the_offer_appears_at_the_fourth_refusal_and_never_with_an_open_p1() {
        let mut ledger = CardLedger::new("w", "c");
        fold(&mut ledger, "r1", "rev1", "base", &[raised("P2", "A")], &[]);
        assert!(!ship_with_follow_up_offered(3, &ledger.findings));
        assert!(ship_with_follow_up_offered(4, &ledger.findings));
        fold(&mut ledger, "r2", "rev2", "base", &[raised("P1", "B")], &[]);
        assert!(!ship_with_follow_up_offered(5, &ledger.findings), "a P1 is open");
        fold(&mut ledger, "r3", "rev3", "base", &[], &[answer("F2", true)]);
        assert!(ship_with_follow_up_offered(5, &ledger.findings));
        fold(&mut ledger, "r4", "rev4", "base", &[], &[answer("F1", true)]);
        assert!(!ship_with_follow_up_offered(6, &ledger.findings), "nothing open to carry");
    }

    #[test]
    fn the_new_card_brief_lists_the_findings_and_the_pr_line_counts_them() {
        let mut ledger = CardLedger::new("w", "c");
        let mut pre = raised("P2", "Old bug");
        pre.0.pre_existing = true;
        fold(&mut ledger, "r1", "rev1", "base", &[raised("P3", "Nit"), raised("P2", "Races"), pre], &[]);
        let open = follow_up_findings(&ledger.findings);
        assert_eq!(open.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), vec!["F2", "F1"]);
        let brief = follow_up_brief("Adoption", &open, Some("https://github.com/o/r/pull/9"));
        assert!(brief.starts_with("\"Adoption\" shipped with 2 open findings"));
        assert!(brief.contains("Shipped as: https://github.com/o/r/pull/9"));
        // Before the card lands the brief does not claim it shipped.
        let pending = follow_up_brief("Adoption", &open, None);
        assert!(pending.starts_with("\"Adoption\" is being shipped (not landed yet) with 2 open findings"));
        assert!(!pending.contains("Shipped as:"));
        assert!(brief.contains("**F2 — P2 — Races** `src/a.rs:10`\n**P2 — Races.** `src/a.rs:10`\nWhat goes wrong, in full."));
        assert!(brief.contains("**F1 — P3 (non-blocking) — Nit**"));
        assert!(!brief.contains("Old bug"));
        assert_eq!(follow_up_pr_line(2, "#140"), "Shipped with 2 open findings: #140");
        assert_eq!(follow_up_pr_line(1, "#140"), "Shipped with 1 open finding: #140");
        // An existing PR gets the line, replacing an earlier one.
        let body = "Closes #9\n\n**Shipped with 3 open findings: #140**";
        assert_eq!(
            pr_body_with_follow_up(body, "Shipped with 2 open findings: #140"),
            "Closes #9\n\n**Shipped with 2 open findings: #140**"
        );
        assert_eq!(pr_body_with_follow_up("", "Shipped with 1 open finding: #7"), "**Shipped with 1 open finding: #7**");
        // Owner-side review of #132: #129's handed-over line starts the same
        // way; the follow-up line never drops it.
        let body = "Closes #9\n\n**Shipped with F3, F4 from snapshot 5's review, not re-checked**";
        assert_eq!(
            pr_body_with_follow_up(body, "Shipped with 2 open findings: #140"),
            "Closes #9\n\n**Shipped with F3, F4 from snapshot 5's review, not re-checked**\n\n**Shipped with 2 open findings: #140**"
        );
    }

    /// Challenger P2 on snapshot 1: a follow-up that closes F1, keeps F2
    /// open and raises nothing is read, not unread — so the Builder gets F2
    /// and never the closed F1 through the reviewer's own words.
    #[test]
    fn a_follow_up_closing_one_finding_injects_only_the_open_one() {
        let mut ledger = CardLedger::new("w", "c");
        fold(&mut ledger, "r1", "rev1", "base", &[raised("P2", "Closed one"), raised("P2", "Open one")], &[]);
        let answer = serde_json::json!({
            "verdict": "CHANGES_REQUESTED", "findings": [], "nonBlocking": [], "checklist": [],
            "earlierFindings": [
                {"id": "F1", "state": "closed", "reason": "Guarded now."},
                {"id": "F2", "state": "open", "reason": "Still races."}
            ],
            "verificationGaps": []
        })
        .to_string();
        let plan = crate::review_passes::plan_passes("diff --git a/a b/a\n+++ b/a\n@@ -0,0 +1 @@\n+x\n", 96 * 1024);
        let run = crate::review_passes::PassRun {
            artifact: Some(answer),
            exit_code: Some(0),
            produced_output: true,
            ..Default::default()
        };
        let merged = crate::review_passes::merge_with_synthesis(&plan, &[run], None, 64 * 1024, None, None);
        assert_eq!(merged.verdict, Some(crate::review_passes::Verdict::ChangesRequested));
        assert!(merged.unread_words.is_empty(), "the answer was read");
        assert!(!merged.findings_unread);
        let folded = fold(&mut ledger, "r2", "rev2", "base", &merged.raised, &merged.earlier);
        let text = handoff(&ledger, &folded, &merged.unread_words, &merged.rest);
        assert!(text.contains("F2 (raised in round 1; still open: Still races.)"), "{text}");
        assert!(!text.contains("F1") && !text.contains("Closed one"), "{text}");
    }

    /// Challenger P2 on snapshot 6: an approving pass's unrated note stays
    /// a note in the ledger, beside another pass's P2 — never a required fix.
    #[test]
    fn an_unrated_note_from_an_approving_pass_never_blocks() {
        let plan = crate::review_passes::plan_passes(
            "diff --git a/a b/a\n+++ b/a\n@@ -0,0 +1 @@\n+x\ndiff --git a/b b/b\n+++ b/b\n@@ -0,0 +1 @@\n+y\n",
            60,
        );
        let run = |text: &str| crate::review_passes::PassRun {
            artifact: Some(text.into()),
            exit_code: Some(0),
            produced_output: true,
            ..Default::default()
        };
        let merged = crate::review_passes::merge_with_synthesis(
            &plan,
            &[
                run("## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- **P2 — Bug.** `a:1`\n"),
                run("## Verdict\nAPPROVE\n\n## Findings\n- The naming could be clearer.\n"),
            ],
            None,
            64 * 1024,
            None,
            None,
        );
        let mut ledger = CardLedger::new("w", "c");
        let folded = fold(&mut ledger, "r1", "rev1", "base", &merged.raised, &merged.earlier);
        let note = ledger.findings.iter().find(|f| f.title.contains("naming")).unwrap();
        assert!(note.note && !note.blocks(), "{note:?}");
        assert_eq!(ledger.open_blocking().len(), 1);
        let text = handoff(&ledger, &folded, &merged.unread_words, &merged.rest);
        let (required, optional) = text.split_once("Non-blocking").unwrap();
        assert!(required.contains("Bug") && !required.contains("naming"), "{text}");
        assert!(optional.contains("naming"));
    }

    #[test]
    fn a_legacy_ledger_loads_empty() {
        let ledger: CardLedger = serde_json::from_str(r#"{"workspaceId":"w","cardId":"c"}"#).unwrap();
        assert!(ledger.findings.is_empty());
        assert_eq!(ledger.rounds, 0);
        let finding: LedgerFinding = serde_json::from_str(r#"{"id":"F1","state":"still-open"}"#).unwrap();
        assert_eq!(finding.state, FindingState::StillOpen);
    }

    /// ADR 0006 (third card): the ledger keeps a follow-up's "was in the
    /// code the sweep read" mark; a first round never has one, and ledgers
    /// written before it load without it.
    #[test]
    fn the_ledger_keeps_sweep_saw_from_follow_ups_only() {
        let mut ledger = CardLedger::new("ws", "c1");
        let mut marked = raised("P2", "Sweep missed it");
        marked.0.sweep_saw = true;
        fold(&mut ledger, "r1", "rev1", "base", &[marked.clone()], &[]);
        assert!(!ledger.findings[0].sweep_saw, "round 1 is the sweep");
        let mut later = raised("P2", "Found late");
        later.0.sweep_saw = true;
        fold(&mut ledger, "r2", "rev2", "base", &[later], &[]);
        assert!(ledger.findings[1].sweep_saw);
        let json = serde_json::to_value(&ledger.findings[1]).unwrap();
        assert_eq!(json["sweepSaw"], true);
        let old: LedgerFinding = serde_json::from_str(r#"{"id":"F1","title":"T","round":2}"#).unwrap();
        assert!(!old.sweep_saw);
    }

    /// CL-6: a ledger written before the anchor fields loads, reads its
    /// old `location` for display (no revision: possibly moved), and saves
    /// back without them.
    #[test]
    fn a_ledger_before_anchors_loads_and_resaves_clean() {
        let old = r#"{"workspaceId":"w","cardId":"c","nextId":3,"rounds":1,"reviewedRevision":"abc","baseRevision":"base",
            "findings":[
              {"id":"F1","severity":"P2","preExisting":false,"note":false,"location":"src/a.rs:12","title":"T","body":"B",
               "reviewId":"r1","round":1,"state":"open","reason":null,"updatedRound":1,"sweepSaw":false},
              {"id":"F2","severity":"P3","preExisting":false,"note":true,"location":null,"title":"U","body":"C",
               "reviewId":"r1","round":1,"state":"closed","reason":null,"updatedRound":1,"sweepSaw":false}
            ]}"#;
        let ledger: CardLedger = serde_json::from_str(old).unwrap();
        let f1 = &ledger.findings[0];
        assert_eq!((f1.path.as_deref(), f1.line, f1.reviewed_revision.as_deref()), (None, None, None));
        assert_eq!(f1.anchor(), Some(("src/a.rs".to_string(), Some(12), None)));
        assert_eq!(ledger.findings[1].anchor(), None);
        let again = serde_json::to_value(&ledger).unwrap();
        for finding in again["findings"].as_array().unwrap() {
            for key in ["path", "line", "reviewedRevision"] {
                assert!(finding.get(key).is_none(), "{key} written on an old finding: {finding}");
            }
        }
        let reread: CardLedger = serde_json::from_value(again).unwrap();
        assert_eq!(reread, ledger);
    }

    /// CL-6: a fold keeps the path, the line and the revision the line
    /// belongs to; a repeat moves the revision to the review that reported
    /// it again; a path alone has no line; none at all, nothing.
    #[test]
    fn a_fold_stores_the_anchor_at_the_reviewed_revision() {
        let mut ledger = CardLedger::new("w", "c");
        let mut path_only = raised("P2", "Whole file");
        path_only.0.location = Some("src/b.rs".into());
        let mut nowhere = raised("P2", "Nowhere");
        nowhere.0.location = None;
        fold(&mut ledger, "r1", "rev1", "base", &[raised("P1", "A"), path_only, nowhere], &[]);
        let f1 = &ledger.findings[0];
        assert_eq!((f1.path.as_deref(), f1.line, f1.reviewed_revision.as_deref()), (Some("src/a.rs"), Some(10), Some("rev1")));
        let f2 = &ledger.findings[1];
        assert_eq!((f2.path.as_deref(), f2.line), (Some("src/b.rs"), None));
        assert_eq!(ledger.findings[2].anchor(), None);
        let json = serde_json::to_value(f1).unwrap();
        assert_eq!((json["path"].as_str(), json["line"].as_u64(), json["reviewedRevision"].as_str()), (Some("src/a.rs"), Some(10), Some("rev1")));
        // Reported again in round 2: the line is round 2's.
        fold(&mut ledger, "r2", "rev2", "base", &[raised("P1", "A")], &[]);
        assert_eq!(ledger.findings[0].reviewed_revision.as_deref(), Some("rev2"));
        // Answered (still open) without a new location: the anchor stays.
        fold(&mut ledger, "r3", "rev3", "base", &[], &[answer("F1", false)]);
        assert_eq!(ledger.findings[0].reviewed_revision.as_deref(), Some("rev2"));
    }

    /// Findings filter: what blocks at each threshold. Pre-existing never
    /// blocks; an unrated finding blocks under `P1 only` (Ply cannot rate it
    /// lower); `All findings` takes P3s and notes too.
    #[test]
    fn each_threshold_blocks_what_it_names() {
        use BlockingThreshold::*;
        let cases = [
            // severity, pre_existing, note, [P1, P1P2, All]
            (Some("P1"), false, false, [true, true, true]),
            (Some("P2"), false, false, [false, true, true]),
            (Some("P3"), false, false, [false, false, true]),
            (None, false, false, [true, true, true]),
            (Some("P1"), false, true, [false, false, true]),
            (Some("P1"), true, false, [false, false, false]),
        ];
        for (severity, pre, note, want) in cases {
            let got = [P1.blocks(severity, pre, note), P1P2.blocks(severity, pre, note), All.blocks(severity, pre, note)];
            assert_eq!(got, want, "{severity:?} pre={pre} note={note}");
        }
        // The default is today's rule, finding by finding.
        assert_eq!(BlockingThreshold::default(), P1P2);
        let finding = LedgerFinding { severity: Some("P3".into()), ..LedgerFinding::default() };
        assert_eq!(finding.blocks(), finding.legacy_blocks());
    }

    /// Findings filter: a fold at `P1 only` keeps the P2 open and not
    /// blocking (counted as a note, never "still open"); at the default no
    /// finding carries `blocking`, so the file is what it was before.
    #[test]
    fn a_fold_reads_blocking_at_the_threshold() {
        let mut ledger = CardLedger::new("w", "c");
        let one = fold_at(&mut ledger, "r1", "rev1", "base", &[raised("P1", "A"), raised("P2", "B")], &[], BlockingThreshold::P1);
        assert_eq!((one.fresh_blocking, one.fresh_notes), (1, 1));
        let f2 = &ledger.findings[1];
        assert_eq!((f2.blocking, f2.blocks(), f2.is_open()), (Some(false), false, true));
        assert_eq!(ledger.open_blocking().iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), vec!["F1"]);
        let two = fold_at(&mut ledger, "r2", "rev2", "base", &[], &[], BlockingThreshold::P1);
        assert_eq!(two.still_open, vec!["F1"], "B never keeps a round open");
        // Back to the default: B blocks again from the next fold.
        let three = fold_at(&mut ledger, "r3", "rev3", "base", &[], &[], BlockingThreshold::P1P2);
        assert_eq!(three.still_open, vec!["F1", "F2"]);
        assert!(ledger.findings.iter().all(|f| f.blocking.is_none()));
        let json = serde_json::to_string(&ledger).unwrap();
        assert!(!json.contains("\"blocking\"") && !json.contains("\"dismissal\""), "{json}");
    }

    /// "Not a real issue": a dismissed finding is not open, never blocks,
    /// keeps a one-line reason, and is refused a second time; a closed or
    /// unknown one cannot be dismissed. A repeat of it is a new finding.
    #[test]
    fn a_dismissed_finding_leaves_the_open_ones() {
        let mut ledger = CardLedger::new("w", "c");
        fold(&mut ledger, "r1", "rev1", "base", &[raised("P1", "A"), raised("P2", "B")], &[]);
        let long = format!("not\nreal   {}", "x".repeat(400));
        dismiss(&mut ledger, "f2", Some(&long), Some(" me@x "), 7).unwrap();
        let f2 = &ledger.findings[1];
        let dismissal = f2.dismissal.clone().unwrap();
        assert!(!f2.is_open() && !f2.blocks());
        assert_eq!((dismissal.by.as_deref(), dismissal.at, dismissal.round), (Some("me@x"), 7, 1));
        let reason = dismissal.reason.unwrap();
        assert!(reason.starts_with("not real x") && reason.chars().count() == DISMISS_REASON_MAX_CHARS && !reason.contains('\n'));
        assert_eq!(ledger.open_blocking().len(), 1);
        assert!(!open_block(&ledger).contains("F2"));
        assert!(dismiss(&mut ledger, "F2", None, None, 8).unwrap_err().contains("already dismissed"));
        assert!(dismiss(&mut ledger, "F9", None, None, 8).is_err());
        let second = fold(&mut ledger, "r2", "rev2", "base", &[raised("P2", "B")], &[answer("F1", true)]);
        assert_eq!(second.new_ids, vec!["F3"], "a repeat of a dismissed finding is new");
        assert!(dismiss(&mut ledger, "F1", None, None, 9).unwrap_err().contains("already closed"));
        assert!(second.still_open.is_empty());
        // No reason given: said so; the follow-up's offer ignores it.
        dismiss(&mut ledger, "F3", Some("  "), None, 10).unwrap();
        let block = dismissed_block(&ledger);
        assert!(block.contains("- F2 — P2 — B `src/a.rs:10` — the member's reason: \"not real"), "{block}");
        assert!(block.contains("- F3 — P2 — B `src/a.rs:10` — no reason given"), "{block}");
        assert!(!ship_with_follow_up_offered(9, &ledger.findings), "nothing open blocks");
        assert!(follow_up_findings(&ledger.findings).is_empty());
    }

    /// Schema migration: a ledger written before the findings filter loads
    /// with no threshold reading and no dismissal, blocking as it did; an
    /// unknown threshold name reads as the default.
    #[test]
    fn a_ledger_before_the_findings_filter_loads_as_it_was() {
        let old = serde_json::json!({
            "workspaceId": "w", "cardId": "c", "nextId": 3, "rounds": 1,
            "findings": [
              {"id":"F1","severity":"P2","preExisting":false,"note":false,"location":"src/a.rs:12","title":"T","body":"B",
               "reviewId":"r1","round":1,"state":"open","reason":null,"updatedRound":1},
              {"id":"F2","severity":"P3","preExisting":false,"note":true,"location":null,"title":"U","body":"C",
               "reviewId":"r1","round":1,"state":"still-open","reason":null,"updatedRound":1}
            ]
        });
        let ledger: CardLedger = serde_json::from_value(old).unwrap();
        assert!(ledger.findings.iter().all(|f| f.blocking.is_none() && f.dismissal.is_none()));
        assert!(ledger.findings[0].blocks() && !ledger.findings[1].blocks());
        assert_eq!(ledger.open_blocking().len(), 1);
        let read: BlockingThreshold = serde_json::from_value(serde_json::json!("p0-someday")).unwrap();
        assert_eq!(read, BlockingThreshold::P1P2);
        for t in [BlockingThreshold::P1, BlockingThreshold::P1P2, BlockingThreshold::All] {
            let back: BlockingThreshold = serde_json::from_value(serde_json::to_value(t).unwrap()).unwrap();
            assert_eq!(back, t);
        }
    }

    #[test]
    fn a_location_splits_into_path_and_line() {
        assert_eq!(split_location("src/a.rs:12"), Some(("src/a.rs".into(), Some(12))));
        assert_eq!(split_location("src/a.rs"), Some(("src/a.rs".into(), None)));
        assert_eq!(split_location("C:/x/a.rs:3"), Some(("C:/x/a.rs".into(), Some(3))));
        assert_eq!(split_location("a.rs:0"), Some(("a.rs:0".into(), None)));
        assert_eq!(split_location("a.rs:x"), Some(("a.rs:x".into(), None)));
        assert_eq!(split_location("  "), None);
    }
}
