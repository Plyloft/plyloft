//! SL-6 — **Build with both**: one card built by Claude and by Codex in
//! parallel, each in its own worktree; one Challenger pass compares the two
//! results against the card and recommends one; the owner picks. The pick
//! becomes the card's worktree, branch and Builder session and the normal
//! loop goes on (Build done → Verify + the full Challenger review → Ship).
//! The other build is archived: its worktree goes to the 7-day trash like
//! every prune, its branch is kept, and the card's history names it.
//!
//! Keying (`docs/plans/SHIP_LOOP_PLAN.md` §SL-6):
//!   - lane `a` is Claude in the card's own worktree
//!     (`.plyloft-worktrees/<card_id>/`, made by the normal advance, set up
//!     by SL-4 as the card's);
//!   - lane `b` is Codex in `.plyloft-worktrees/<card_id>-b/` on the card's
//!     branch name plus `-b`, started from the same base commit and set up
//!     by SL-4's same setup, its record on the lane.
//!   - Both sessions live in the one `BuilderRegistry` under a lane key,
//!     `<card_id>#both-a` / `#both-b`, spawned through the Builder's own
//!     spawn path (`builder::spawn_session_at`). App exit kills them with the
//!     `PtyRegistry` like every Builder (Hard Rule #4); a pick re-keys the
//!     winner's live session to the card id, so it *is* the card's Builder.
//!   - Each lane's Verify is the card's normal pipeline run as a verify job
//!     keyed by the lane key in the lane's worktree (`verify.rs`).
//!
//! A card without `build_both` behaves exactly as before: nothing here runs
//! for it, and the field is not written.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::kanban::{BuilderState, KanbanCard, KanbanStore, LastRunStatus};

/// Claude's lane: the card's own worktree.
pub const LANE_A: &str = "a";
/// Codex's lane: the variant worktree `<card_id>-b`.
pub const LANE_B: &str = "b";
/// Between the card id and the lane in a lane's session / verify key.
pub const LANE_SEP: &str = "#both-";
/// The variant worktree's directory and branch suffix.
pub const VARIANT_SUFFIX: &str = "-b";

/// Most bytes of one build's diff written for the comparison to read.
pub const DIFF_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Where the builds' diffs are written, inside the comparison's own
/// read-only checkout, relative to its root (the reviewer's cwd).
pub const COMPARE_FILES_DIR: &str = ".plyloft-compare";
/// Most reasons kept from the comparison's answer.
const REASONS_MAX: usize = 8;
/// Most characters of one reason.
const REASON_MAX_CHARS: usize = 400;
/// Most characters of the comparison's answer kept on the card.
const EXCERPT_MAX_CHARS: usize = 6000;
/// The comparison is one read-only pass.
pub const COMPARE_TIMEOUT_SECS: u64 = 10 * 60;

// ── Keys ──────────────────────────────────────────────────────────────

/// `<card_id>#both-<lane>`: a lane's key in the Builder registry, the verify
/// registry and the frontend's per-session stores.
pub fn lane_key(card_id: &str, lane: &str) -> String {
    format!("{card_id}{LANE_SEP}{lane}")
}

/// The card id and lane of a lane key; `None` for a plain card id.
pub fn parse_lane_key(key: &str) -> Option<(&str, &str)> {
    let (card_id, lane) = key.rsplit_once(LANE_SEP)?;
    (!card_id.is_empty() && (lane == LANE_A || lane == LANE_B)).then_some((card_id, lane))
}

/// v1.154.1 (walk J5, G2): a card built by both, not decided, whose builds
/// have no live session although one of them was working — after a
/// relaunch, or both sessions exited. The Board says "Session ended" and
/// the Inbox puts it under Needs you, not Running (`buildBoth.ts`'s
/// `bothSessionsEnded` is the same rule).
pub fn sessions_ended(bb: &BuildBoth) -> bool {
    bb.outcome.is_none()
        && bb.lanes.iter().all(|l| l.pty_id.is_none())
        && bb
            .lanes
            .iter()
            .any(|l| l.started_at.is_some() && l.done.is_none() && l.failed.is_none())
}

/// v1.154.1 round 3 (walk RW-B step 10): the words of a card built by
/// both whose comparison settled and whose pick waits on the person —
/// `None` otherwise. The Inbox puts it under Needs you in the Board's words
/// (`cardLifecycle.ts::bothPickLabel`), not under Running.
pub fn pick_words(bb: &BuildBoth) -> Option<String> {
    if bb.outcome.is_some() {
        return None;
    }
    let compare = bb.compare.as_ref().filter(|c| c.status != "running")?;
    if compare.status == "decided" {
        let kept = compare
            .recommended
            .as_deref()
            .and_then(|lane| bb.lanes.iter().find(|l| l.lane == lane));
        return Some(match kept {
            // Challenger L2: its checks failed — it is what is left.
            Some(l) if l.verify.as_ref().is_some_and(|v| v.status == "failed") => {
                format!("Only {}'s build is left", vendor_name(&l.vendor))
            }
            Some(l) => format!("{}'s build is ready to continue", vendor_name(&l.vendor)),
            None => "Neither build has a result".to_string(),
        });
    }
    Some("Pick one of the two builds".to_string())
}

fn vendor_name(vendor: &str) -> &'static str {
    if vendor == "codex" {
        "Codex"
    } else {
        "Claude"
    }
}

/// The variant worktree's directory name under its worktree root.
pub fn variant_dir(card_id: &str) -> String {
    format!("{card_id}{VARIANT_SUFFIX}")
}

/// The variant worktree's branch: the card's branch name plus `-b`. Not
/// `make_branch_name(<card_id>-b)`: the short id is the id's first eight
/// alphanumerics, so that would be the card's own branch name (or, for a
/// GitHub Issues card, `ghissue<d>`, which other issues share).
///
/// SP-7: from the branch the card **records** (`card_branch`), so a card on a
/// legacy `atelier/card-…` branch gets `atelier/card-…-b`, not a new prefix.
pub fn variant_branch(card_branch: &str) -> String {
    format!("{card_branch}{VARIANT_SUFFIX}")
}

/// Who builds in a lane.
pub fn lane_vendor(lane: &str) -> &'static str {
    if lane == LANE_B {
        "codex"
    } else {
        "claude"
    }
}

pub fn other_lane(lane: &str) -> &'static str {
    if lane == LANE_B {
        LANE_A
    } else {
        LANE_B
    }
}

// ── What the card keeps (persisted, additive) ─────────────────────────

/// `KanbanCard::build_both`. Present from Build with both on; stays after
/// the pick (or a stop) as the card's history of it (`outcome`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BuildBoth {
    pub started_at: i64,
    /// Lane `a` (Claude) and lane `b` (Codex).
    pub lanes: Vec<BuildLane>,
    /// The Challenger's comparison, once both builds are settled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compare: Option<BuildCompare>,
    /// Set once: the owner picked one, or stopped building with both.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<BuildBothOutcome>,
}

/// One of the two builds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BuildLane {
    /// `a` or `b`.
    pub lane: String,
    /// `claude` or `codex`.
    pub vendor: String,
    pub worktree_path: String,
    pub branch_name: String,
    pub bypass: bool,
    /// 1.171.0 (D1, Challenger 1): the card's permissions choice this build
    /// started in (`set_permissions`), on its spawn, every Resume and Start
    /// fresh, and the card's Builder after the pick. `None` on builds
    /// started before D1: those run by `bypass` alone, as before. Serde
    /// default, left out of the file while `None`; an unknown value reads
    /// as `None`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::settings::lenient_opt"
    )]
    pub permissions: Option<crate::settings::BuilderPermissions>,
    /// How the model it runs on reads (`opus`, `gpt-5.5 high`), set at spawn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// CL-8: the model chosen for this build when Build with both started —
    /// used by its spawn and every Resume / Start fresh. `None` on builds
    /// started before CL-8 (and on a start that sent no choice): those read
    /// the workspace's Builder row at each spawn, as before. Serde default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chosen_model: Option<LaneModel>,
    /// Live PTY id; cleared on load (no process survives a restart).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pty_id: Option<String>,
    /// The session ended without the human closing it: Resume.
    pub session_lost: bool,
    /// v1.154.1 round 2 (walk J1): Resume found no Codex conversation of
    /// this build's own (its folder), so it offers Start fresh instead of
    /// reopening another card's session. Cleared by the next start. Serde
    /// default: builds written before it load as false.
    pub resume_failed: bool,
    /// When its Builder started; `None` while its setup holds it back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    /// Its Build done: the snapshot the comparison and the pick use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<LaneSnapshot>,
    /// Its Verify of that snapshot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify: Option<LaneVerify>,
    /// This build ended without a result (the owner stopped it, or its
    /// Builder could not start), in words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed: Option<String>,
    /// SL-4's setup record of lane `b`'s worktree. Lane `a`'s is the card's
    /// own `worktree_setup`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_setup: Option<crate::worktree_setup::WorktreeSetupRecord>,
    /// The port block of lane `b`'s worktree (`worktree_ports`); lane
    /// `a`'s is the card's own `port_base`. Serde default: builds written
    /// before it load as `None` and get one the first time it is needed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port_base: Option<u16>,
    /// UX P-F: a Claude build's `--session-id`, as the card's own
    /// (`BuilderState::claude_session_id`); it becomes the card's when this
    /// build is picked. Serde default: builds written before it load as
    /// `None` (resume with `--continue`, no mid-turn limit read).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
}

/// CL-8: one build's model, chosen at start for this card only. Blank
/// fields are the CLI's own default (no flag). `reasoning` is the effort —
/// Codex's, and since 1.169.0 (A1) Claude's too.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LaneModel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

impl LaneModel {
    /// Trimmed, blanks dropped. 1.169.0 (A1): the effort for both vendors
    /// (Claude's `--effort`); `vendor` is kept for the callers' symmetry.
    pub fn normalized(&self, _vendor: &str) -> LaneModel {
        LaneModel {
            model: crate::settings::cleaned(&self.model),
            reasoning: crate::settings::cleaned(&self.reasoning),
        }
    }

    /// What a spawn of `vendor` passes.
    pub fn choice(&self, vendor: &str) -> crate::settings::ModelChoice {
        let n = self.normalized(vendor);
        crate::settings::ModelChoice { model: n.model, reasoning: n.reasoning }
    }
}

/// CL-8: `build_both_start`'s `models` — the two fields the person saw at
/// start, prefilled from each vendor's Builder row.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BuildBothModels {
    pub claude: LaneModel,
    pub codex: LaneModel,
}

impl BuildBothModels {
    pub fn for_vendor(&self, vendor: &str) -> &LaneModel {
        if vendor == "codex" {
            &self.codex
        } else {
            &self.claude
        }
    }
}

/// CL-8: record the start's model choice on each build.
pub fn choose_models(bb: &mut BuildBoth, models: &BuildBothModels) {
    for l in bb.lanes.iter_mut() {
        l.chosen_model = Some(models.for_vendor(&l.vendor).normalized(&l.vendor));
    }
}

/// CL-8: the model a build's spawn uses — new, Resume or Start fresh: the
/// one chosen at start, else (a build from before CL-8) `fallback`, the
/// workspace's Builder row for its vendor.
pub fn lane_model(lane: &BuildLane, fallback: impl FnOnce() -> crate::settings::ModelChoice) -> crate::settings::ModelChoice {
    crate::builder::builder_model(lane.chosen_model.as_ref(), &lane.vendor, fallback)
}

/// CL-8: the Challenger's verdict on one build, from its answer's
/// `SUMMARY A:` / `FINDINGS A:` sections. Comparisons from before CL-8
/// have none (the card shows the reasons only).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LaneVerdict {
    /// `a` or `b`.
    pub lane: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// `None`: the answer had no findings section for this build; empty:
    /// it said there are none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub findings: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LaneSnapshot {
    pub sha: String,
    pub at: i64,
}

/// `status`: `running` (queued or running), `passed`, `failed`, `stalled`
/// (a capacity stall), `interrupted` (Plyloft quit during it).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LaneVerify {
    pub status: String,
    /// The snapshot it verified.
    pub sha: String,
    /// One line: "all 3 step(s) passed", the failing step and why.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub at: i64,
}

/// `status`: `running`, `done` (a recommendation from the Challenger),
/// `decided` (no pass was needed: only one build has a result), `failed`.
/// `recommended`: `a`, `b`, or none (neither, or no pass).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BuildCompare {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended: Option<String>,
    pub reasons: Vec<String>,
    /// CL-8: each build's summary and findings, when the answer gave them.
    /// Serde default: comparisons from before CL-8 load with none.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lanes: Vec<LaneVerdict>,
    /// The Challenger's answer, bounded (Details).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The snapshots compared: a new Build done in a lane compares again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha_a: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha_b: Option<String>,
    pub started_at: i64,
    pub at: i64,
}

/// `kind`: `picked` or `stopped`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BuildBothOutcome {
    pub kind: String,
    /// The lane picked (`picked` only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    /// Whether the pick followed the Challenger's recommendation; `None`
    /// when there was none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub followed_recommendation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    pub at: i64,
    /// The build(s) set aside: worktree in the trash, branch kept.
    pub archived: Vec<ArchivedLane>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ArchivedLane {
    pub lane: String,
    pub vendor: String,
    /// Kept locally.
    pub branch_name: String,
    /// Where its worktree went (the trash), when it was moved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trash_path: Option<String>,
    /// Why its worktree was not moved, in words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

impl BuildBoth {
    pub fn lane(&self, lane: &str) -> Option<&BuildLane> {
        self.lanes.iter().find(|l| l.lane == lane)
    }
    pub fn lane_mut(&mut self, lane: &str) -> Option<&mut BuildLane> {
        self.lanes.iter_mut().find(|l| l.lane == lane)
    }
    pub fn undecided(&self) -> bool {
        self.outcome.is_none()
    }
    pub(crate) fn comparing(&self) -> bool {
        self.compare.as_ref().is_some_and(|c| c.status == "running")
    }
}

impl BuildLane {
    /// Done (a snapshot) or ended without a result.
    pub fn settled(&self) -> bool {
        self.done.is_some() || self.failed.is_some()
    }
}

/// The card is being built by both and the owner has not picked yet.
pub fn is_undecided(card: &KanbanCard) -> bool {
    card.build_both.as_ref().is_some_and(BuildBoth::undecided)
}

/// Why a start, resume or Ship of the card's single Builder is refused
/// while both build it.
pub const UNDECIDED_REFUSAL: &str =
    "Claude and Codex are both building this card. Pick one of the two builds first (or stop building with both).";

/// Why the Worktrees page may not delete `<root>/<dir_name>`:
/// it is one of the two builds of a card still built by both, or a Builder
/// session (`live`, by registry key) works in it.
pub fn worktree_delete_refusal(cards: &[KanbanCard], dir_name: &str, live: impl Fn(&str) -> bool) -> Option<String> {
    let base = |p: &str| Path::new(p).file_name().and_then(|n| n.to_str()).map(str::to_string);
    for c in cards {
        if let Some(bb) = c.build_both.as_ref().filter(|bb| bb.undecided()) {
            for l in &bb.lanes {
                if base(&l.worktree_path).as_deref() == Some(dir_name) {
                    return Some(format!(
                        "This checkout is {}'s build of “{}”, which Claude and Codex are both still building. Pick one of the two builds (or stop building with both) on the card first.",
                        crate::builder::vendor_display(&l.vendor),
                        c.title
                    ));
                }
            }
        }
        let owns = c.id == dir_name || c.worktree_path.as_deref().and_then(base).as_deref() == Some(dir_name);
        if owns && live(&c.id) {
            return Some(format!("The Builder of “{}” is working in this checkout. Close its session first.", c.title));
        }
    }
    None
}

// ── Starting ──────────────────────────────────────────────────────────

/// Why Build with both can't start on this card, before anything moves.
/// `vendor_refusal` is `builder::vendor_missing_refusal` for one vendor.
pub fn start_refusal(card: &KanbanCard, vendor_refusal: impl Fn(&str) -> Option<String>) -> Option<String> {
    for vendor in ["claude", "codex"] {
        if let Some(why) = vendor_refusal(vendor) {
            return Some(format!("Build with both needs Claude and Codex. {why}"));
        }
    }
    if card.archived {
        return Some("This card is archived.".into());
    }
    // Challenger on a pull request: its fixes are one Builder's, on its own
    // pull request (and none on anyone else's).
    if card.pr_review.is_some() {
        return Some(
            crate::pr_review::builder_refusal(card)
                .unwrap_or_else(|| "A card that reviews a pull request is fixed with one Builder, not built by both.".into()),
        );
    }
    if card.intake_status == crate::kanban::IntakeStatus::Active {
        return Some("Finish planning first.".into());
    }
    // G4: a template on a Todo card that never ran a swarm can't start one,
    // so it doesn't stand in the way.
    if crate::kanban::swarm_template_in_use(card) || card.agent_config_id.is_some() {
        return Some("This card runs a swarm or an agent; Build with both is for a card built by a Builder.".into());
    }
    if card.column_id != crate::kanban::KanbanColumnId::Todo
        || card.worktree_path.is_some()
        || card.builder.is_some()
        || card.build_both.is_some()
    {
        return Some("Build with both starts only on a card that hasn't been built yet.".into());
    }
    None
}

/// The record Build with both starts with: lane `a` in the card's worktree,
/// lane `b` in the variant, neither started.
pub fn new_record(
    a_worktree: &str,
    a_branch: &str,
    b_worktree: &str,
    b_branch: &str,
    bypass: bool,
    at: i64,
) -> BuildBoth {
    let lane = |lane: &str, worktree: &str, branch: &str| BuildLane {
        lane: lane.to_string(),
        vendor: lane_vendor(lane).to_string(),
        worktree_path: worktree.to_string(),
        branch_name: branch.to_string(),
        bypass,
        ..Default::default()
    };
    BuildBoth {
        started_at: at,
        lanes: vec![lane(LANE_A, a_worktree, a_branch), lane(LANE_B, b_worktree, b_branch)],
        compare: None,
        outcome: None,
    }
}

/// D1 (Challenger 1): both builds run in the card's permissions choice —
/// "Never asks" is their bypass.
pub fn set_permissions(record: &mut BuildBoth, permissions: crate::settings::BuilderPermissions) {
    for lane in record.lanes.iter_mut() {
        lane.permissions = Some(permissions);
        lane.bypass = permissions == crate::settings::BuilderPermissions::NeverAsks;
    }
}

/// The SL-4 setup record that holds a lane's Builder: the card's own for
/// lane `a`, the lane's for `b`.
pub fn lane_setup<'a>(card: &'a KanbanCard, lane: &str) -> Option<&'a crate::worktree_setup::WorktreeSetupRecord> {
    if lane == LANE_A {
        card.worktree_setup.as_ref()
    } else {
        card.build_both.as_ref()?.lane(lane)?.worktree_setup.as_ref()
    }
}

/// Lanes whose Builder can start now: not started, not ended, and not held
/// by their setup.
pub fn startable_lanes(card: &KanbanCard) -> Vec<String> {
    let Some(bb) = card.build_both.as_ref().filter(|bb| bb.undecided()) else {
        return Vec::new();
    };
    bb.lanes
        .iter()
        .filter(|l| l.started_at.is_none() && l.failed.is_none())
        .filter(|l| !lane_setup(card, &l.lane).is_some_and(|r| r.blocks_start()))
        .map(|l| l.lane.clone())
        .collect()
}

/// The Builder's rules for a lane: the normal preamble, and that another
/// Builder works on the same card elsewhere.
pub fn lane_preamble(card_title: &str) -> String {
    let base = crate::builder::builder_preamble(card_title);
    let note = "- This card is being built twice, in parallel: another Builder works on the same \
task in its own worktree. Work only in this worktree; a Reviewer compares the two results and \
the human picks one.\n";
    match base.rfind("\n\nTask:\n") {
        Some(at) => format!("{}\n{}{}", &base[..at], note.trim_end_matches('\n'), &base[at..]),
        None => format!("{base}{note}"),
    }
}

// ── Comparing ─────────────────────────────────────────────────────────

/// What `maybe_compare` does next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompareStep {
    /// Nothing to do: decided, comparing, or these snapshots were compared.
    Nothing,
    /// A build is still going, or a Verify of one still runs.
    Wait,
    /// Both builds have a result: the Challenger compares them.
    Run,
    /// Only one build (or none) has a result: no pass is needed.
    Decide { recommended: Option<String>, reason: String },
}

fn lane_sha(bb: &BuildBoth, lane: &str) -> Option<String> {
    bb.lane(lane).and_then(|l| l.done.as_ref()).map(|d| d.sha.clone())
}

/// When the two builds are settled (and their Verify has finished), the
/// comparison runs — once per pair of snapshots.
pub fn compare_step(bb: &BuildBoth, verify_inflight: impl Fn(&str) -> bool) -> CompareStep {
    if !bb.undecided() || bb.comparing() {
        return CompareStep::Nothing;
    }
    if bb.lanes.len() != 2 || bb.lanes.iter().any(|l| !l.settled()) {
        return CompareStep::Wait;
    }
    if bb.lanes.iter().any(|l| l.done.is_some() && verify_inflight(&l.lane)) {
        return CompareStep::Wait;
    }
    // Round 2 (G5): a build whose checks wait for the OK has no result yet.
    if bb.lanes.iter().any(|l| l.verify.as_ref().is_some_and(|v| v.status == LANE_WAITS)) {
        return CompareStep::Wait;
    }
    let (sha_a, sha_b) = (lane_sha(bb, LANE_A), lane_sha(bb, LANE_B));
    if let Some(c) = bb.compare.as_ref() {
        if c.sha_a == sha_a && c.sha_b == sha_b {
            return CompareStep::Nothing;
        }
    }
    let done: Vec<&BuildLane> = bb.lanes.iter().filter(|l| l.done.is_some()).collect();
    match done.as_slice() {
        [_, _] => CompareStep::Run,
        [one] => {
            let other = bb.lane(other_lane(&one.lane));
            let why = other.and_then(|l| l.failed.clone()).unwrap_or_else(|| "it has no result".into());
            CompareStep::Decide {
                recommended: Some(one.lane.clone()),
                reason: format!(
                    "Only {}'s build has a result; {}'s ended without one: {}",
                    crate::builder::vendor_display(&one.vendor),
                    crate::builder::vendor_display(lane_vendor(other_lane(&one.lane))),
                    why.trim_end_matches('.')
                ) + ".",
            }
        }
        _ => CompareStep::Decide {
            recommended: None,
            reason: "Neither build has a result. Stop building with both, then start the card again.".into(),
        },
    }
}

/// One build, as the comparison reads it: its commit, its diff and stat as
/// files in the comparison's checkout (never in the prompt — the prompt is
/// a command-line argument, and Windows caps a command line at 32,767
/// characters), and its checks in words.
#[derive(Debug, Clone, Default)]
pub struct LaneInput {
    pub sha: String,
    /// Relative to the comparison's checkout.
    pub stat_file: String,
    pub diff_file: String,
    /// The diff was longer than `DIFF_MAX_BYTES` and was cut.
    pub diff_cut: bool,
    /// Its Verify, in words.
    pub verify: String,
}

/// Write one build's stat and diff under `root/COMPARE_FILES_DIR/` and say
/// where, relative to `root`.
pub fn write_lane_files(root: &Path, label: &str, sha: &str, stat: &str, diff: &str, diff_cut: bool, verify: String) -> Result<LaneInput, String> {
    let dir = root.join(COMPARE_FILES_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let stat_file = format!("{COMPARE_FILES_DIR}/build-{label}.stat");
    let diff_file = format!("{COMPARE_FILES_DIR}/build-{label}.diff");
    std::fs::write(root.join(&stat_file), stat).map_err(|e| format!("write {stat_file}: {e}"))?;
    std::fs::write(root.join(&diff_file), diff).map_err(|e| format!("write {diff_file}: {e}"))?;
    Ok(LaneInput { sha: sha.to_string(), stat_file, diff_file, diff_cut, verify })
}

/// The one Challenger pass: the card, where each build's diff from the
/// common base is, both Verify results; recommend one, with reasons, in a
/// fixed shape. The builds are "A" (lane `a`) and "B" (lane `b`); the vendor
/// is never named, so the Challenger compares the work, not who did it.
/// Small by construction: the brief is capped (16 KiB) and the diffs are
/// files.
pub fn compare_prompt(brief: &str, base: &str, a: &LaneInput, b: &LaneInput) -> String {
    let build = |label: &str, lane: &LaneInput| {
        format!(
            "## Build {label}\n\nCommit: {sha}\nChecks (the project's own verify pipeline): {verify}\nFiles changed: `{stat}`\nDiff from the common base: `{diff}`{cut}\n",
            sha = lane.sha,
            verify = lane.verify.trim(),
            stat = lane.stat_file,
            diff = lane.diff_file,
            cut = if lane.diff_cut {
                " (cut at 4 MiB; `git diff` shows all of it)"
            } else {
                ""
            },
        )
    };
    format!(
        "You are the Reviewer for a Plyloft card that was built twice, independently, from the same \
base commit: Build A and Build B. Compare the two builds against the card and recommend the one the \
human should keep and continue from. This is read-only: do not edit, create or delete files, and do \
not run commands that change anything. The current directory is the common base ({base}); each \
build's diff from it is in a file named below. Read both diffs completely. You may read other files \
here for context, and run read-only git commands such as `git diff {base} <commit>` or \
`git show <commit>:<path>`.\n\n\
Judge, in this order: does it do what the card asks, completely; is it correct (bugs, edge cases, \
data loss, security); did its checks pass; is it tested; is it the smaller, clearer change that fits \
the codebase. A build whose checks failed can still be the better one to continue from; say why.\n\n\
# The card\n\n{brief}\n\n{a}\n{b}\n\
# Your answer\n\n\
End your answer with exactly this shape, in plain text:\n\n\
RECOMMENDATION: A\n\
REASONS:\n\
- one reason per line, concrete: name files, behaviour, failing checks\n\n\
SUMMARY A: one or two sentences on what Build A does, and how well\n\
FINDINGS A:\n\
- one problem in Build A per line: a bug, a gap against the card, a failing check, a missing test\n\
SUMMARY B: one or two sentences on what Build B does, and how well\n\
FINDINGS B:\n\
- one problem in Build B per line\n\n\
Use `RECOMMENDATION: A`, `RECOMMENDATION: B`, or `RECOMMENDATION: NEITHER` when neither should be \
kept. Give two to six reasons; they compare the two builds. Each build's summary and findings are \
about that build alone; write `- none` under its FINDINGS when you found no problem in it. Quote file \
names, identifiers and code in backticks.\n",
        brief = brief.trim(),
        a = build("A", a),
        b = build("B", b),
    )
}

/// What the comparison answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompareAnswer {
    /// `a`, `b`, or `None` for NEITHER.
    pub recommended: Option<String>,
    pub reasons: Vec<String>,
    /// CL-8: each build's summary and findings, for the builds the answer
    /// gave them for (none when it left the sections out).
    pub lanes: Vec<LaneVerdict>,
}

/// Most findings kept for one build.
const FINDINGS_MAX: usize = 8;
/// Most characters of one build's summary.
const SUMMARY_MAX_CHARS: usize = 600;

fn strip_decoration(line: &str) -> &str {
    line.trim().trim_matches(|c: char| c == '*' || c == '_' || c == '#' || c == '`' || c == '>').trim()
}

/// A head of the answer's fixed shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Head {
    Recommendation,
    Reasons,
    Summary(&'static str),
    Findings(&'static str),
}

/// The head a line starts (`REASONS:`, `**Summary A:** …`, `FINDINGS for
/// Build B:`) and what follows its colon on the same line.
fn section_head(raw: &str) -> Option<(Head, &str)> {
    let line = strip_decoration(raw);
    let (head, rest) = line.split_once(':')?;
    let words: Vec<String> = strip_decoration(head)
        .split_whitespace()
        .map(str::to_ascii_lowercase)
        .filter(|w| !matches!(w.as_str(), "build" | "for" | "of"))
        .collect();
    let lane = |w: &str| match w {
        "a" => Some(LANE_A),
        "b" => Some(LANE_B),
        _ => None,
    };
    let head = match words.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["recommendation"] => Head::Recommendation,
        ["reasons"] => Head::Reasons,
        ["summary", l] => Head::Summary(lane(l)?),
        ["findings", l] => Head::Findings(lane(l)?),
        _ => return None,
    };
    Some((head, strip_decoration(rest)))
}

/// A list item's text: `- x`, `* x`, `• x`, `1. x`, `1) x`.
fn bullet_body(item: &str) -> Option<&str> {
    item.strip_prefix("- ")
        .or_else(|| item.strip_prefix("* "))
        .or_else(|| item.strip_prefix("• "))
        .or_else(|| {
            let digits = item.chars().take_while(char::is_ascii_digit).count();
            let rest = &item[digits..];
            (digits > 0 && (rest.starts_with(". ") || rest.starts_with(") "))).then(|| &rest[2..])
        })
}

/// The items of a list under a head: bullets; a plain line counts only
/// before the first one, and a plain line after them, or another head,
/// ends the list.
fn list_items(lines: &[&str], inline: &str, max: usize) -> Vec<String> {
    let mut items = Vec::new();
    if !inline.is_empty() {
        items.push(cap_chars(inline, REASON_MAX_CHARS));
    }
    for raw in lines {
        if section_head(raw).is_some() {
            break;
        }
        let item = raw.trim();
        if item.is_empty() {
            continue;
        }
        let body = match bullet_body(item) {
            Some(body) => body.trim(),
            None if items.is_empty() => item,
            None => break,
        };
        if !body.is_empty() && items.len() < max {
            items.push(cap_chars(body, REASON_MAX_CHARS));
        }
    }
    items
}

/// A summary: the text after its head, else the lines under it up to a
/// blank line or the next head.
fn summary_text(lines: &[&str], inline: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    if !inline.is_empty() {
        parts.push(inline);
    } else {
        for raw in lines {
            if section_head(raw).is_some() {
                break;
            }
            let line = raw.trim();
            if line.is_empty() {
                if parts.is_empty() {
                    continue;
                }
                break;
            }
            parts.push(bullet_body(line).unwrap_or(line).trim());
        }
    }
    let text = parts.join(" ");
    let text = text.trim();
    (!text.is_empty()).then(|| cap_chars(text, SUMMARY_MAX_CHARS))
}

/// "none", "- None.", "No findings": the build has no problem.
fn says_none(items: &[String]) -> bool {
    match items {
        [only] => {
            let word = only.trim().trim_end_matches('.').to_ascii_lowercase();
            matches!(word.as_str(), "none" | "no findings" | "nothing" | "n/a" | "no problems")
        }
        _ => false,
    }
}

/// CL-8: each build's `SUMMARY` and `FINDINGS`, read anywhere in the
/// answer (the last of each wins). A build with neither is left out, and a
/// missing or garbled section only loses that section.
fn parse_lane_verdicts(lines: &[&str]) -> Vec<LaneVerdict> {
    // Round 2: the sections of the final answer (after its last
    // RECOMMENDATION line) win over drafts earlier in the text; with none
    // there, they are read anywhere.
    let last_rec = lines.iter().rposition(|l| matches!(section_head(l), Some((Head::Recommendation, _))));
    if let Some(at) = last_rec {
        let after = verdicts_in(&lines[at..]);
        if !after.is_empty() {
            return after;
        }
    }
    verdicts_in(lines)
}

fn verdicts_in(lines: &[&str]) -> Vec<LaneVerdict> {
    let mut out: Vec<LaneVerdict> = [LANE_A, LANE_B]
        .iter()
        .map(|l| LaneVerdict { lane: l.to_string(), ..Default::default() })
        .collect();
    for (i, raw) in lines.iter().enumerate() {
        let Some((head, inline)) = section_head(raw) else { continue };
        let rest = &lines[i + 1..];
        match head {
            Head::Summary(lane) => {
                if let Some(text) = summary_text(rest, inline) {
                    out.iter_mut().find(|v| v.lane == lane).unwrap().summary = Some(text);
                }
            }
            Head::Findings(lane) => {
                let items = list_items(rest, inline, FINDINGS_MAX);
                let items = if says_none(&items) { Vec::new() } else { items };
                out.iter_mut().find(|v| v.lane == lane).unwrap().findings = Some(items);
            }
            Head::Recommendation | Head::Reasons => {}
        }
    }
    out.retain(|v| v.summary.is_some() || v.findings.is_some());
    out
}

/// The recommendation (the last `RECOMMENDATION:` line wins), the reasons
/// after `REASONS:`, and (CL-8) each build's summary and findings. `None`
/// when no recommendation can be read.
pub fn parse_compare(answer: &str) -> Option<CompareAnswer> {
    let lines: Vec<&str> = answer.lines().collect();
    let mut recommended: Option<Option<String>> = None;
    let mut at = 0usize;
    for (i, raw) in lines.iter().enumerate() {
        let line = strip_decoration(raw);
        let Some((head, rest)) = line.split_once(':') else { continue };
        if !strip_decoration(head).eq_ignore_ascii_case("recommendation") {
            continue;
        }
        let rest = strip_decoration(rest).trim_start_matches(|c: char| !c.is_ascii_alphabetic());
        // "Build A" reads as "A".
        let rest = match rest.get(..6) {
            Some(head) if head.eq_ignore_ascii_case("build ") => rest[6..].trim_start(),
            _ => rest,
        };
        let word: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphabetic())
            .collect::<String>()
            .to_ascii_uppercase();
        let pick = match word.as_str() {
            "A" => Some(Some(LANE_A.to_string())),
            "B" => Some(Some(LANE_B.to_string())),
            "NEITHER" | "NONE" => Some(None),
            _ => None,
        };
        if let Some(pick) = pick {
            recommended = Some(pick);
            at = i;
        }
    }
    let recommended = recommended?;
    let mut reasons = Vec::new();
    for (i, raw) in lines.iter().enumerate().skip(at + 1) {
        let line = strip_decoration(raw);
        let head = line.split_once(':').map_or(line, |(h, _)| h);
        if strip_decoration(head).eq_ignore_ascii_case("reasons") {
            reasons = list_items(&lines[i + 1..], "", REASONS_MAX);
            break;
        }
    }
    Some(CompareAnswer { recommended, reasons, lanes: parse_lane_verdicts(&lines) })
}

fn cap_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The summary of a lane verified with no checks set up (`buildBoth.ts`
/// reads the same words).
pub const NO_CHECKS_SUMMARY: &str = "no checks are set up";

/// A lane's Verify in the comparison's words.
pub fn verify_words(verify: Option<&LaneVerify>) -> String {
    match verify {
        None => "not run.".into(),
        Some(v) => match v.status.as_str() {
            // Round 3 (walk RW-B): with no checks set up nothing passed —
            // the Challenger said "Both pipelines report passed".
            "passed" if v.summary.as_deref() == Some(NO_CHECKS_SUMMARY) => {
                "none — no checks are set up for this project, so nothing was run or passed.".into()
            }
            "passed" => format!("passed ({}).", v.summary.as_deref().unwrap_or("all steps")),
            "failed" => format!("FAILED — {}.", v.summary.as_deref().unwrap_or("a step failed").trim_end_matches('.')),
            "stalled" => "did not finish (the provider's capacity limit stopped it).".into(),
            LANE_WAITS => "not run yet (they wait for this computer's OK).".into(),
            "interrupted" => "did not finish (Plyloft quit during it).".into(),
            _ => "still running when the comparison started.".into(),
        },
    }
}

/// The comparison's record from the pass's answer.
pub fn compare_from_answer(
    answer: &str,
    provider: &str,
    sha_a: Option<String>,
    sha_b: Option<String>,
    started_at: i64,
    at: i64,
) -> BuildCompare {
    let excerpt = Some(cap_chars(answer.trim(), EXCERPT_MAX_CHARS));
    match parse_compare(answer) {
        Some(parsed) => BuildCompare {
            status: "done".into(),
            provider: Some(provider.to_string()),
            recommended: parsed.recommended,
            reasons: parsed.reasons,
            lanes: parsed.lanes,
            excerpt,
            error: None,
            sha_a,
            sha_b,
            started_at,
            at,
        },
        None => BuildCompare {
            status: "failed".into(),
            provider: Some(provider.to_string()),
            excerpt,
            error: Some("The Reviewer's answer had no recommendation Plyloft could read.".into()),
            sha_a,
            sha_b,
            started_at,
            at,
            ..Default::default()
        },
    }
}

// ── Picking ───────────────────────────────────────────────────────────

/// Why `lane` can't be picked now.
pub fn pick_refusal(card: &KanbanCard, lane: &str) -> Option<String> {
    let Some(bb) = card.build_both.as_ref() else {
        return Some("This card isn't being built by both.".into());
    };
    if !bb.undecided() {
        return Some("One of the two builds was already picked.".into());
    }
    if lane != LANE_A && lane != LANE_B {
        return Some(format!("There is no build {lane:?}."));
    }
    if bb.comparing() {
        return Some("The Reviewer is still comparing the two builds; pick when it's done.".into());
    }
    if bb.lanes.iter().any(|l| !l.settled()) {
        return Some("Both builds must be done (or stopped) before you pick one.".into());
    }
    let picked = bb.lane(lane)?;
    if picked.done.is_none() {
        return Some(format!(
            "{}'s build has no result to pick.",
            crate::builder::vendor_display(&picked.vendor)
        ));
    }
    if !Path::new(&picked.worktree_path).is_dir() {
        return Some(format!("{}'s copy of the repository is gone ({}).", crate::builder::vendor_display(&picked.vendor), picked.worktree_path));
    }
    None
}

/// The pick, on the card: the picked build's worktree, branch, setup record
/// and session become the card's; the card's Builder is that vendor's, with
/// no snapshot yet (its Build done is the normal loop's first); the other
/// build is recorded as archived.
pub fn apply_pick(card: &mut KanbanCard, lane: &str, by: Option<&str>, at: i64, archived: ArchivedLane) -> Result<(), String> {
    let bb = card.build_both.as_mut().ok_or("This card isn't being built by both.")?;
    if !bb.undecided() {
        return Err("One of the two builds was already picked.".into());
    }
    // A Compare again that started after the pick was checked.
    if bb.comparing() {
        return Err("The Reviewer is still comparing the two builds; pick when it's done.".into());
    }
    let recommended = bb
        .compare
        .as_ref()
        .filter(|c| c.status == "done" || c.status == "decided")
        .map(|c| c.recommended.clone());
    let winner = bb.lane(lane).cloned().ok_or_else(|| format!("There is no build {lane:?}."))?;
    // Neither lane records a session any more: the loser's ended, the
    // winner's is the card's Builder now (one record, never two).
    for l in bb.lanes.iter_mut() {
        l.pty_id = None;
        l.session_lost = false;
    }
    bb.outcome = Some(BuildBothOutcome {
        kind: "picked".into(),
        lane: Some(lane.to_string()),
        vendor: Some(winner.vendor.clone()),
        followed_recommendation: recommended.flatten().map(|r| r == lane),
        by: by.map(str::to_string),
        at,
        archived: vec![archived],
    });
    if lane == LANE_B {
        card.worktree_setup = winner.worktree_setup.clone();
        // Its ports go with its worktree: the Builder, its server and every
        // later spawn there keep the block they started on.
        card.port_base = winner.port_base.or(card.port_base);
    }
    card.worktree_path = Some(winner.worktree_path.clone());
    card.branch_name = Some(winner.branch_name.clone());
    card.builder = Some(BuilderState {
        vendor: winner.vendor.clone(),
        bypass: winner.bypass,
        model: winner.model.clone(),
        pty_id: winner.pty_id.clone(),
        session_lost: winner.pty_id.is_none(),
        resume_failed: false,
        started_at: winner.started_at.unwrap_or(at),
        snapshots: Vec::new(),
        review: None,
        last_reviewed_revision: None,
        shipped_unreviewed: None,
        first_review_done: false,
        changes_requested_count: 0,
        user_corrections: 0,
        correction_texts: Vec::new(),
        review_decisions: Vec::new(),
        follow_up: None,
        self_check: None,
        waiting_review: None,
        handed_over: None,
        undelivered_verdict: None,
        // CL-5: rounds the card already kept are its own, not the lane's.
        // (A card building with both has no Builder, so none today.)
        review_rounds: card.builder.as_ref().map(|b| b.review_rounds.clone()).unwrap_or_default(),
        // CL-8 round 2: the picked build's chosen model stays the card's.
        chosen_model: winner.chosen_model.clone(),
        // UX P-F: its transcript and its Resume go with it.
        claude_session_id: winner.claude_session_id.clone(),
        // UX P-C: a card built by both never runs the guided mode.
        permission_mode: None,
        // D1: the build's choice is the Builder's; Resume keeps it.
        permissions: winner.permissions,
        lost_on_restart: false,
        self_check_started_at: None,
        pr_draft: None,
    });
    card.last_run_status = Some(LastRunStatus::Running);
    Ok(())
}

/// The owner's pick, with CARD_START_LOCK held by the caller. Checked
/// first (nothing running in either worktree, nothing comparing), then the
/// card is written — so a refusal leaves both builds as they were — and only
/// then is the other build set aside: its session ended, anything
/// uncommitted committed on its branch, its worktree to the 7-day trash
/// (branch kept), what happened recorded on the outcome. The picked build's
/// live session is re-keyed to the card; if that can't be done it is ended
/// and the card offers Resume in the picked worktree.
#[allow(clippy::too_many_arguments)]
pub fn pick_locked(
    kanban: &KanbanStore,
    registry: &crate::builder::BuilderRegistry,
    pty: &crate::pty::PtyRegistry,
    verify_inflight: &dyn Fn(&str) -> bool,
    ws_cwd: &Path,
    cache_paths: &[String],
    workspace_id: &str,
    card_id: &str,
    lane: &str,
    by: Option<&str>,
) -> Result<KanbanCard, String> {
    let card = kanban.get_card(workspace_id, card_id)?;
    if let Some(why) = pick_refusal(&card, lane) {
        return Err(why);
    }
    for l in [LANE_A, LANE_B] {
        if verify_inflight(&lane_key(card_id, l)) {
            return Err(format!(
                "{}'s checks are still running; wait for them to finish.",
                crate::builder::vendor_display(lane_vendor(l))
            ));
        }
    }
    if crate::worktree_setup::is_in_flight(workspace_id, card_id)
        || crate::worktree_setup::is_in_flight(workspace_id, &lane_key(card_id, LANE_B))
    {
        return Err("A setup is still running for this card; wait for it to finish.".into());
    }
    let loser = other_lane(lane);
    let set_aside = card
        .build_both
        .as_ref()
        .and_then(|bb| bb.lane(loser))
        .cloned()
        .ok_or("The other build is missing.")?;
    let at = now_millis();
    let pending = ArchivedLane {
        lane: set_aside.lane.clone(),
        vendor: set_aside.vendor.clone(),
        branch_name: set_aside.branch_name.clone(),
        trash_path: None,
        problem: None,
    };
    kanban.with_card(workspace_id, card_id, |c| apply_pick(c, lane, by, at, pending.clone()))?;

    registry.end_session(pty, &lane_key(card_id, loser));
    let dir = if loser == LANE_A { card_id.to_string() } else { variant_dir(card_id) };
    // N16: the set-aside lane's own record of its folder.
    let path = crate::worktrees::recorded_worktree_path(ws_cwd, &dir, Some(&set_aside.worktree_path));
    if path.is_dir() {
        if let Err(e) = crate::worktrees::commit_pending_in_worktree(
            &path,
            &crate::commit_message::set_aside_subject(crate::builder::vendor_display(&set_aside.vendor), &card.title),
        ) {
            log::warn!("build with both {card_id}: set-aside build not committed: {e}");
        }
    }
    // Try it (TI-2): the set-aside build's preview stops with it.
    crate::try_session::stop_card_try_sessions(workspace_id, card_id, Some(loser), crate::try_session::TryStopReason::Discard);
    let archived = archived_lane(&set_aside, crate::worktrees::prune_worktree_at(ws_cwd, &path, cache_paths));
    let winner_key = lane_key(card_id, lane);
    let lost = registry.get_pty(&winner_key).is_some() && !registry.rekey(&winner_key, card_id);
    if lost {
        registry.end_session(pty, &winner_key);
    }
    let mut updated = None;
    kanban.with_card(workspace_id, card_id, |c| {
        if let Some(o) = c.build_both.as_mut().and_then(|bb| bb.outcome.as_mut()) {
            o.archived = vec![archived.clone()];
        }
        if lost {
            if let Some(b) = c.builder.as_mut() {
                b.pty_id = None;
                b.session_lost = true;
            }
        }
        updated = Some(c.clone());
        Ok(())
    })?;
    for l in [LANE_A, LANE_B] {
        crate::verify_logs::card_worktree_removed(workspace_id, &lane_key(card_id, l));
    }
    updated.ok_or_else(|| "the pick did not capture the card".to_string())
}

/// Stop building with both: both sessions end; the card keeps lane `a`'s
/// worktree (its own) with no Builder, so Start build works as for any
/// card; lane `b` is archived.
pub fn apply_stop(card: &mut KanbanCard, by: Option<&str>, at: i64, archived: ArchivedLane) -> Result<(), String> {
    let bb = card.build_both.as_mut().ok_or("This card isn't being built by both.")?;
    if !bb.undecided() {
        return Err("One of the two builds was already picked.".into());
    }
    for l in bb.lanes.iter_mut() {
        l.pty_id = None;
        l.session_lost = false;
    }
    if bb.comparing() {
        if let Some(c) = bb.compare.as_mut() {
            c.status = "failed".into();
            c.error = Some("Stopped before the comparison finished.".into());
            c.at = at;
        }
    }
    bb.outcome = Some(BuildBothOutcome {
        kind: "stopped".into(),
        by: by.map(str::to_string),
        at,
        archived: vec![archived],
        ..Default::default()
    });
    // CL-5: no review rounds are lost here — Build with both starts only on
    // a card with no Builder (`start_refusal`), and none is made until the
    // pick, so there is none to keep. A rounds-only Builder would read as a
    // built card everywhere `builder.is_some()` is asked.
    card.builder = None;
    card.last_run_status = None;
    Ok(())
}

/// A lane archived: its branch kept, its worktree where the prune put it.
pub fn archived_lane(lane: &BuildLane, pruned: Result<Option<PathBuf>, String>) -> ArchivedLane {
    let (trash_path, problem) = match pruned {
        Ok(Some(p)) => (Some(p.to_string_lossy().into_owned()), None),
        Ok(None) => (None, None),
        Err(e) => (None, Some(format!("Its worktree couldn't be moved to the trash: {e}"))),
    };
    ArchivedLane {
        lane: lane.lane.clone(),
        vendor: lane.vendor.clone(),
        branch_name: lane.branch_name.clone(),
        trash_path,
        problem,
    }
}

// ── After a restart ───────────────────────────────────────────────────

/// On load: no session or pass survives a restart. Live lanes read as lost
/// (Resume), a Verify under way as interrupted, a comparison under way as
/// failed (Compare again), and lane `b`'s setup under way as failed (SL-4).
/// Returns whether anything changed.
pub fn settle_on_load(bb: &mut BuildBoth, workspace_id: &str, card_id: &str) -> bool {
    let mut changed = false;
    for l in bb.lanes.iter_mut() {
        if l.pty_id.take().is_some() {
            l.session_lost = true;
            changed = true;
        }
        if let Some(v) = l.verify.as_mut().filter(|v| v.status == "running") {
            v.status = "interrupted".into();
            changed = true;
        }
        if crate::worktree_setup::settle_interrupted(&mut l.worktree_setup, workspace_id, &lane_key(card_id, &l.lane)) {
            changed = true;
        }
    }
    if let Some(c) = bb.compare.as_mut().filter(|c| c.status == "running") {
        c.status = "failed".into();
        c.error = Some("Plyloft quit during the comparison.".into());
        changed = true;
    }
    changed
}

/// A finished lane Verify from the verify registry's last status.
/// Round 2 (G5): a build whose checks wait for this computer's OK
/// (`checks_consent`). Not a result: the comparison waits for it.
pub const LANE_WAITS: &str = "waiting";

pub fn lane_verify_from_status(status: &crate::verify::VerifyStateOut, steps: &[crate::kanban::VerifyStepResult], sha: &str, at: i64) -> Option<LaneVerify> {
    use crate::verify::VerifyStateOut as S;
    let failing = || {
        steps.iter().find(|s| !s.passed).map(|s| {
            let reason = s.reason.as_deref().unwrap_or("no reason recorded");
            let tail: String = reason.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or(reason).chars().take(300).collect();
            format!("{} failed: {}", s.kind, tail.trim())
        })
    };
    let (status, summary) = match status {
        S::Queued { .. } | S::Running { .. } => return None,
        S::Passed => (
            "passed",
            Some(if steps.is_empty() {
                NO_CHECKS_SUMMARY.to_string()
            } else {
                format!("all {} step(s) passed", steps.len())
            }),
        ),
        // Round 2 (G5): held for this computer's OK — nothing ran, so it
        // didn't fail: the build waits, and the comparison with it.
        S::Failed { reason } if reason == crate::verify::CHECKS_NEED_OK => (LANE_WAITS, Some(reason.clone())),
        S::Failed { reason } => ("failed", failing().or_else(|| Some(cap_chars(reason.trim(), 300)))),
        S::TimedOut { step } => ("failed", Some(format!("{step} timed out"))),
        S::CapacityStall { detail } => ("stalled", Some(detail.clone())),
    };
    Some(LaneVerify { status: status.into(), sha: sha.to_string(), summary, at })
}

// ── The live half (AppHandle) ─────────────────────────────────────────

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn workspace_cwd(app: &AppHandle, workspace_id: &str) -> Result<String, String> {
    app.state::<crate::workspace::WorkspaceStore>()
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| w.cwd)
        .ok_or_else(|| format!("workspace '{workspace_id}' not found"))
}

/// End both lanes' live sessions (a delete, an archive). `true` when one ran.
pub fn end_lane_sessions(registry: &crate::builder::BuilderRegistry, pty: &crate::pty::PtyRegistry, card_id: &str) -> bool {
    let a = registry.end_session(pty, &lane_key(card_id, LANE_A));
    let b = registry.end_session(pty, &lane_key(card_id, LANE_B));
    a || b
}

/// A live lane session of this card.
pub fn has_live_lane(registry: &crate::builder::BuilderRegistry, card_id: &str) -> bool {
    [LANE_A, LANE_B].iter().any(|l| registry.get_pty(&lane_key(card_id, l)).is_some())
}

/// The variant worktree of a card that no longer uses it (an archive, a
/// delete, a pick whose prune failed): to the trash, branch kept. Never the
/// card's own worktree.
pub fn prune_leftover_variant(ws_cwd: &Path, card: &KanbanCard, cache_paths: &[String]) -> Option<PathBuf> {
    let dir = variant_dir(&card.id);
    let recorded = card.build_both.as_ref().and_then(|bb| bb.lane(LANE_B)).map(|l| l.worktree_path.as_str());
    let path = crate::worktrees::recorded_worktree_path(ws_cwd, &dir, recorded);
    // Never the card's own: by its directory (not a path spelling), and
    // never after Codex's build was picked — then `<id>-b` is the card's.
    let own = crate::worktrees::card_worktree_dir(&card.id, card.worktree_path.as_deref()) == dir;
    let codex_picked = card
        .build_both
        .as_ref()
        .and_then(|bb| bb.outcome.as_ref())
        .is_some_and(|o| o.kind == "picked" && o.lane.as_deref() == Some(LANE_B));
    if own || codex_picked || !path.is_dir() {
        return None;
    }
    let _ = crate::worktrees::commit_pending_in_worktree(&path, &crate::commit_message::kept_subject(&card.title));
    match crate::worktrees::prune_worktree_at(ws_cwd, &path, cache_paths) {
        Ok(moved) => moved,
        Err(e) => {
            log::warn!("build_both: {}: the variant worktree stayed: {e}", card.id);
            None
        }
    }
}

/// Spawn one lane's Builder (new, or `resume` in the same worktree) through
/// the Builder's spawn path, and record it on the lane. A session no lane
/// records is stopped again (Hard Rule #4).
pub fn spawn_lane(
    app: &AppHandle,
    workspace_id: &str,
    card: &KanbanCard,
    lane: &str,
    prompt: Option<&str>,
) -> Result<String, String> {
    let registry = app.state::<crate::builder::BuilderRegistry>();
    let pty = app.state::<crate::pty::PtyRegistry>();
    let kanban = app.state::<KanbanStore>();
    let bb = card.build_both.as_ref().filter(|bb| bb.undecided()).ok_or(
        "This card isn't being built by both.",
    )?;
    let l = bb.lane(lane).ok_or_else(|| format!("There is no build {lane:?}."))?.clone();
    let key = lane_key(&card.id, lane);
    if registry.get_pty(&key).is_some() {
        return Err(format!("{}'s session is already running.", crate::builder::vendor_display(&l.vendor)));
    }
    let resume = prompt.is_none();
    if let Some(why) = crate::shell_env::try_get()
        .and_then(|env| crate::builder::vendor_missing_refusal(&env, &l.vendor, resume))
    {
        return Err(why);
    }
    let ws_cwd = workspace_cwd(app, workspace_id)?;
    let theme = if l.vendor == "claude" { crate::claude_theme::theme_for_spawn(app) } else { None };
    // CL-8: the model chosen for this build at start, on its spawn and on
    // every Resume / Start fresh; a build from before CL-8 reads the
    // workspace's Builder row (CL-4) as it did.
    // 1.168.1 (E2): with no model chosen for the build, the card's own
    // choice, else the rows.
    let model = lane_model(&l, || {
        crate::settings::model_for_card(app, workspace_id, card.models.as_ref(), &l.vendor, crate::settings::AgentRole::Builder)
    });
    // v1.154.1 round 2 (walk J1): a Codex build resumes its own session,
    // found by its folder, never the newest one on the Mac (another card's).
    let codex_session = if resume {
        crate::builder::codex_session_for(&l.vendor, Some(&l.worktree_path), l.started_at)
    } else {
        None
    };
    if resume && l.vendor == "codex" && codex_session.is_none() {
        let _ = kanban.with_card(workspace_id, &card.id, |c| {
            if let Some(lane) = c.build_both.as_mut().and_then(|bb| bb.lane_mut(lane)) {
                lane.resume_failed = true;
            }
            Ok(())
        });
        crate::kanban::emit_kanban_changed(app, workspace_id);
        return Err(crate::codex_sessions::NOT_FOUND.to_string());
    }
    let full_prompt = prompt.map(|p| format!("{}{}", crate::builder::with_codex_rules(lane_preamble(&crate::issue_text::name_for_ai(&card)), &l.vendor), p));
    // UX P-F: a new Claude build is named (its transcript tells a usage
    // limit); a resume continues its own id, or the folder's newest before P-F.
    let claude_session_id = if resume { l.claude_session_id.clone() } else { crate::builder::new_claude_session_id(&l.vendor) };
    let args = crate::builder::with_claude_session(
        // D1: the build's own permissions choice (none before D1: `bypass`).
        crate::builder::builder_args_in_mode(
            &l.vendor,
            l.bypass,
            l.permissions.map(crate::settings::BuilderPermissions::mode_str),
            resume,
            codex_session.as_deref(),
            full_prompt.as_deref(),
            theme.as_deref(),
            &model,
        )?,
        &l.vendor,
        resume,
        claude_session_id.as_deref(),
    );
    let pty_id = crate::builder::spawn_session_at(
        app.clone(),
        &registry,
        &pty,
        workspace_id,
        &ws_cwd,
        &key,
        &card.id,
        &l.worktree_path,
        &l.vendor,
        args,
        claude_session_id.clone(),
    )?;
    if resume {
        // Round 3: a Resume that ends at once points at Start fresh (as F17
        // does for a single Builder).
        registry.mark_resumed(&key, &pty_id, now_millis());
    }
    let written = kanban.with_card(workspace_id, &card.id, |c| {
        let lane = c
            .build_both
            .as_mut()
            .filter(|bb| bb.undecided())
            .and_then(|bb| bb.lane_mut(lane))
            .ok_or("the card is no longer being built by both")?;
        lane.pty_id = Some(pty_id.clone());
        lane.session_lost = false;
        lane.resume_failed = false;
        lane.model = model.label_for(&l.vendor);
        lane.claude_session_id = claude_session_id.clone();
        if lane.started_at.is_none() {
            lane.started_at = Some(now_millis());
        }
        c.last_run_status = Some(LastRunStatus::Running);
        Ok(())
    });
    if let Err(why) = written {
        registry.end_session(&pty, &key);
        return Err(format!("the Builder session was started and stopped again: {why}"));
    }
    crate::kanban::emit_kanban_changed(app, workspace_id);
    Ok(pty_id)
}

/// A lane's session exited on its own: lost, Resume. A stale exit (a
/// session already replaced) changes nothing.
pub fn lane_session_ended(app: &AppHandle, workspace_id: &str, key: &str, pty_id: &str) -> Result<(), String> {
    let (card_id, lane) = parse_lane_key(key).ok_or("not a lane key")?;
    let registry = app.state::<crate::builder::BuilderRegistry>();
    let mut output: Option<Vec<u8>> = None;
    match registry.get_pty(key) {
        Some(current) if current == pty_id => {
            output = registry.forget(key).map(|s| crate::builder::capture_tail(&s.capture));
        }
        Some(_) => return Ok(()),
        None => {}
    }
    // Round 3 (walk J1): a build's Resume that ended at once, or that Codex
    // said it could not resume, is said as such, with Start fresh beside
    // Resume, as F17 does for a single Builder.
    let quick = crate::builder::resume_failed(registry.take_resumed(key, pty_id), now_millis(), output.as_deref());
    let kanban = app.state::<KanbanStore>();
    let result = kanban.with_card(workspace_id, card_id, |c| {
        if let Some(l) = c.build_both.as_mut().and_then(|bb| bb.lane_mut(lane)) {
            if l.pty_id.as_deref() == Some(pty_id) {
                l.pty_id = None;
                l.session_lost = true;
                l.resume_failed = quick;
            }
        }
        Ok(())
    });
    match result {
        Ok(()) => {}
        // The card went (a delete) before its session's exit was reported.
        Err(e) if e.contains("not found") => return Ok(()),
        Err(e) => return Err(e),
    }
    crate::kanban::emit_kanban_changed(app, workspace_id);
    Ok(())
}

fn git_head(worktree: &Path) -> Result<String, String> {
    crate::git::capture(worktree, &["rev-parse", "HEAD"]).map(|s| s.trim().to_string())
}

/// A lane's Build done: its worktree committed as a snapshot on its branch,
/// recorded, and its Verify started — the card's normal pipeline, in the
/// lane's worktree. The session stays open. Pressing it again on an
/// unchanged tree records nothing.
pub fn lane_done(app: &AppHandle, workspace_id: &str, card_id: &str, lane: &str) -> Result<KanbanCard, String> {
    let kanban = app.state::<KanbanStore>();
    let card = kanban.get_card(workspace_id, card_id)?;
    let bb = card.build_both.as_ref().filter(|bb| bb.undecided()).ok_or(
        "This card isn't being built by both.",
    )?;
    let l = bb.lane(lane).ok_or_else(|| format!("There is no build {lane:?}."))?.clone();
    if l.started_at.is_none() {
        return Err(format!("{}'s build hasn't started.", crate::builder::vendor_display(&l.vendor)));
    }
    if l.failed.is_some() {
        return Err(format!("{}'s build was stopped.", crate::builder::vendor_display(&l.vendor)));
    }
    if bb.comparing() {
        return Err("The Reviewer is comparing the two builds; wait for it to finish.".into());
    }
    let wt = PathBuf::from(&l.worktree_path);
    if !wt.is_dir() {
        return Err(format!("{}'s copy of the repository is gone ({}).", crate::builder::vendor_display(&l.vendor), l.worktree_path));
    }
    crate::worktrees::commit_pending_in_worktree(
        &wt,
        &crate::commit_message::vendor_build_subject(crate::builder::vendor_display(&l.vendor), &card.title),
    )?;
    let sha = git_head(&wt)?;
    if l.done.as_ref().is_some_and(|d| d.sha == sha) {
        // The same snapshot: nothing is recorded again. Its checks run again
        // only when they never finished (Plyloft quit during them, a
        // capacity stop, they couldn't start) and none runs now; the
        // comparison then goes on as it would have.
        let key = lane_key(card_id, lane);
        let inflight = app.state::<crate::verify::VerifyRegistry>().is_inflight(workspace_id, &key);
        if checks_need_rerun(l.verify.as_ref(), &sha, inflight) {
            if let Err(e) = start_lane_verify(app, workspace_id, card_id, lane, &sha) {
                log::warn!("build_both: {card_id}/{lane}: Verify didn't start again: {e}");
            }
            crate::kanban::emit_kanban_changed(app, workspace_id);
        }
        maybe_compare(app, workspace_id, card_id);
        return kanban.get_card(workspace_id, card_id);
    }
    let at = now_millis();
    kanban.with_card(workspace_id, card_id, |c| {
        let l = c
            .build_both
            .as_mut()
            .filter(|bb| bb.undecided())
            .and_then(|bb| bb.lane_mut(lane))
            .ok_or("the card is no longer being built by both")?;
        l.done = Some(LaneSnapshot { sha: sha.clone(), at });
        l.verify = None;
        Ok(())
    })?;
    if let Err(e) = start_lane_verify(app, workspace_id, card_id, lane, &sha) {
        log::warn!("build_both: {card_id}/{lane}: Verify didn't start: {e}");
        let _ = kanban.with_card(workspace_id, card_id, |c| {
            if let Some(l) = c.build_both.as_mut().and_then(|bb| bb.lane_mut(lane)) {
                l.verify = Some(LaneVerify {
                    status: "failed".into(),
                    sha: sha.clone(),
                    summary: Some(format!("the checks couldn't start: {e}")),
                    at: now_millis(),
                });
            }
            Ok(())
        });
    }
    crate::kanban::emit_kanban_changed(app, workspace_id);
    maybe_compare(app, workspace_id, card_id);
    kanban.get_card(workspace_id, card_id)
}

/// A lane's checks of `sha` never came to a verdict (not run, interrupted,
/// stalled, a start that failed, a `running` no job answers) and none runs
/// now: a Build done on the same snapshot runs them again.
pub fn checks_need_rerun(verify: Option<&LaneVerify>, sha: &str, inflight: bool) -> bool {
    if inflight {
        return false;
    }
    match verify {
        Some(v) if v.sha == sha => !(v.status == "passed" || (v.status == "failed" && !v.summary.as_deref().is_some_and(|s| s.starts_with("the checks couldn't start")))),
        _ => true,
    }
}

/// At launch: a card still built by both whose comparison was due when
/// Plyloft quit (both builds settled, nothing running now) is compared.
pub fn compare_due_at_launch(app: &AppHandle) {
    let kanban = app.state::<KanbanStore>();
    for workspace in app.state::<crate::workspace::WorkspaceStore>().snapshot().workspaces {
        let Ok(cards) = kanban.load(&workspace.id) else { continue };
        for card in cards.iter().filter(|c| is_undecided(c)) {
            maybe_compare(app, &workspace.id, &card.id);
        }
    }
}

/// The card's verify pipeline on a lane's snapshot: a verify job keyed by
/// the lane, in the lane's worktree, through the card's execution gate.
fn start_lane_verify(app: &AppHandle, workspace_id: &str, card_id: &str, lane: &str, sha: &str) -> Result<(), String> {
    let verify = app.state::<crate::verify::VerifyRegistry>();
    let kanban = app.state::<KanbanStore>();
    let workspaces = app.state::<crate::workspace::WorkspaceStore>();
    let gate = app.state::<crate::card_execution::CardExecutionGate>();
    crate::drain::guard_dispatch(&app.state::<crate::drain::DrainCoordinator>(), "verify")?;
    let key = lane_key(card_id, lane);
    let deferred = gate.authorize_verify(
        &kanban,
        &app.state::<crate::agents::AgentRegistry>(),
        &app.state::<crate::swarms::SwarmRegistry>(),
        workspace_id,
        card_id,
        || {
            verify.enqueue_deferred(
                &kanban,
                &workspaces,
                crate::verify::VerifyRequest {
                    workspace_id: workspace_id.to_string(),
                    card_id: key.clone(),
                    post_outcome_issue: false,
                },
            )
        },
    )?;
    kanban.with_card(workspace_id, card_id, |c| {
        if let Some(l) = c.build_both.as_mut().and_then(|bb| bb.lane_mut(lane)) {
            l.verify = Some(LaneVerify { status: "running".into(), sha: sha.to_string(), summary: None, at: now_millis() });
        }
        Ok(())
    })?;
    verify.start_deferred(app.clone(), &kanban, deferred)
}

/// Round 3: the cards of a board with a build whose checks wait for the
/// checks' OK (undecided, not archived). When those checks need no OK any
/// more — a teammate put the allowed ones back — nothing on the card offers
/// *Allow and run*, so `checks_consent_view` starts them again for these.
pub fn cards_with_waiting_lanes(cards: &[KanbanCard]) -> Vec<String> {
    cards
        .iter()
        .filter(|card| !card.archived && is_undecided(card))
        .filter(|card| {
            card.build_both
                .as_ref()
                .is_some_and(|bb| bb.lanes.iter().any(|l| l.verify.as_ref().is_some_and(|v| v.status == LANE_WAITS)))
        })
        .map(|card| card.id.clone())
        .collect()
}

/// Round 2 (G5): *Allow and run* — the checks of every build of this card
/// that waited for the OK start again, on the snapshot they waited on. How
/// many started.
pub fn restart_waiting_lanes(app: &AppHandle, workspace_id: &str, card_id: &str) -> usize {
    let waiting: Vec<(String, String)> = app
        .state::<KanbanStore>()
        .get_card(workspace_id, card_id)
        .ok()
        .and_then(|card| card.build_both)
        .map(|bb| {
            bb.lanes
                .iter()
                .filter_map(|l| l.verify.as_ref().filter(|v| v.status == LANE_WAITS).map(|v| (l.lane.clone(), v.sha.clone())))
                .collect()
        })
        .unwrap_or_default();
    waiting
        .iter()
        .filter(|(lane, sha)| match start_lane_verify(app, workspace_id, card_id, lane, sha) {
            Ok(()) => true,
            Err(e) => {
                log::warn!("build_both: {card_id}/{lane}: allowed, but its checks didn't start: {e}");
                false
            }
        })
        .count()
}

/// `verify.rs`: a verify job keyed by a lane ended (every path). Its
/// outcome goes on the lane, and the comparison starts when it can.
pub fn after_lane_verify(app: &AppHandle, workspace_id: &str, key: &str) {
    let Some((card_id, lane)) = parse_lane_key(key) else { return };
    let Some(status) = app.state::<crate::verify::VerifyRegistry>().status(workspace_id, key) else {
        return;
    };
    let kanban = app.state::<KanbanStore>();
    let result = kanban.with_card(workspace_id, card_id, |c| {
        if let Some(l) = c.build_both.as_mut().filter(|bb| bb.undecided()).and_then(|bb| bb.lane_mut(lane)) {
            let sha = l.verify.as_ref().map(|v| v.sha.clone()).unwrap_or_default();
            if let Some(v) = lane_verify_from_status(&status.state, &status.steps, &sha, now_millis()) {
                l.verify = Some(v);
            }
        }
        Ok(())
    });
    if let Err(e) = result {
        if !e.contains("not found") {
            log::warn!("build_both: {card_id}/{lane}: Verify result not kept: {e}");
        }
        return;
    }
    crate::kanban::emit_kanban_changed(app, workspace_id);
    maybe_compare(app, workspace_id, card_id);
}

/// Stop one build (its Builder can't do it, or the owner doesn't want it):
/// its session ends and it counts as ended without a result.
pub fn stop_lane(app: &AppHandle, workspace_id: &str, card_id: &str, lane: &str) -> Result<KanbanCard, String> {
    let registry = app.state::<crate::builder::BuilderRegistry>();
    let pty = app.state::<crate::pty::PtyRegistry>();
    let kanban = app.state::<KanbanStore>();
    let card = kanban.get_card(workspace_id, card_id)?;
    let bb = card.build_both.as_ref().filter(|bb| bb.undecided()).ok_or(
        "This card isn't being built by both.",
    )?;
    if bb.comparing() {
        return Err("The Reviewer is comparing the two builds; wait for it to finish.".into());
    }
    bb.lane(lane).ok_or_else(|| format!("There is no build {lane:?}."))?;
    registry.end_session(&pty, &lane_key(card_id, lane));
    kanban.with_card(workspace_id, card_id, |c| {
        if let Some(l) = c.build_both.as_mut().and_then(|bb| bb.lane_mut(lane)) {
            l.pty_id = None;
            l.session_lost = false;
            if l.done.is_none() {
                l.failed = Some("You stopped it before it finished".into());
            }
        }
        Ok(())
    })?;
    crate::kanban::emit_kanban_changed(app, workspace_id);
    maybe_compare(app, workspace_id, card_id);
    kanban.get_card(workspace_id, card_id)
}

/// Start the comparison when it is due (`compare_step`), or settle it
/// without a pass when only one build has a result.
pub fn maybe_compare(app: &AppHandle, workspace_id: &str, card_id: &str) {
    let verify = app.state::<crate::verify::VerifyRegistry>();
    let inflight: Vec<String> = [LANE_A, LANE_B]
        .iter()
        .filter(|l| verify.is_inflight(workspace_id, &lane_key(card_id, l)))
        .map(|l| l.to_string())
        .collect();
    let kanban = app.state::<KanbanStore>();
    let mut run = false;
    let mut changed = false;
    let result = kanban.with_card(workspace_id, card_id, |c| {
        let Some(bb) = c.build_both.as_mut() else { return Ok(()) };
        let step = compare_step(bb, |lane| inflight.iter().any(|l| l == lane));
        let (sha_a, sha_b) = (lane_sha(bb, LANE_A), lane_sha(bb, LANE_B));
        let at = now_millis();
        match step {
            CompareStep::Run => {
                bb.compare = Some(BuildCompare { status: "running".into(), sha_a, sha_b, started_at: at, at, ..Default::default() });
                run = true;
                changed = true;
            }
            CompareStep::Decide { recommended, reason } => {
                bb.compare = Some(BuildCompare {
                    status: "decided".into(),
                    recommended,
                    reasons: vec![reason],
                    sha_a,
                    sha_b,
                    started_at: at,
                    at,
                    ..Default::default()
                });
                changed = true;
            }
            CompareStep::Nothing | CompareStep::Wait => {}
        }
        Ok(())
    });
    if let Err(e) = result {
        if !e.contains("not found") {
            log::warn!("build_both: {card_id}: comparison not started: {e}");
        }
        return;
    }
    if changed {
        crate::kanban::emit_kanban_changed(app, workspace_id);
    }
    if run {
        spawn_compare(app.clone(), workspace_id.to_string(), card_id.to_string());
    }
}

/// Compare again: the owner asks for a new pass over the same snapshots (a
/// failed or unreadable one, or a second opinion).
pub fn compare_again(app: &AppHandle, workspace_id: &str, card_id: &str) -> Result<KanbanCard, String> {
    let kanban = app.state::<KanbanStore>();
    let mut run = false;
    kanban.with_card(workspace_id, card_id, |c| {
        let bb = c.build_both.as_mut().filter(|bb| bb.undecided()).ok_or(
            "This card isn't being built by both.",
        )?;
        if bb.comparing() {
            return Err("The Reviewer is already comparing the two builds.".into());
        }
        if bb.lanes.iter().any(|l| l.done.is_none()) {
            return Err("Both builds need a result before they can be compared.".into());
        }
        let at = now_millis();
        bb.compare = Some(BuildCompare {
            status: "running".into(),
            sha_a: lane_sha(bb, LANE_A),
            sha_b: lane_sha(bb, LANE_B),
            started_at: at,
            at,
            ..Default::default()
        });
        run = true;
        Ok(())
    })?;
    crate::kanban::emit_kanban_changed(app, workspace_id);
    if run {
        spawn_compare(app.clone(), workspace_id.to_string(), card_id.to_string());
    }
    kanban.get_card(workspace_id, card_id)
}

fn spawn_compare(app: AppHandle, workspace_id: String, card_id: String) {
    let thread_app = app.clone();
    let (ws, cid) = (workspace_id.clone(), card_id.clone());
    let spawned = std::thread::Builder::new()
        .name(format!("compare-{card_id}"))
        .spawn(move || {
            let started = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_compare(&thread_app, &ws, &cid)))
                .unwrap_or_else(|_| Err((None, "The comparison stopped unexpectedly.".into())));
            settle_compare(&thread_app, &ws, &cid, started);
        });
    if let Err(e) = spawned {
        settle_compare(&app, &workspace_id, &card_id, Err((None, format!("could not start the comparison: {e}"))));
    }
}

type CompareRun = Result<(String, String), (Option<String>, String)>;

/// The comparison's result on the card — only on the pass it answers (the
/// same snapshots, still running).
fn settle_compare(app: &AppHandle, workspace_id: &str, card_id: &str, run: CompareRun) {
    let kanban = app.state::<KanbanStore>();
    let result = kanban.with_card(workspace_id, card_id, |c| {
        let Some(bb) = c.build_both.as_mut() else { return Ok(()) };
        let Some(current) = bb.compare.as_ref().filter(|c| c.status == "running") else { return Ok(()) };
        let (sha_a, sha_b, started_at) = (current.sha_a.clone(), current.sha_b.clone(), current.started_at);
        let at = now_millis();
        bb.compare = Some(match &run {
            Ok((provider, answer)) => compare_from_answer(answer, provider, sha_a, sha_b, started_at, at),
            Err((provider, error)) => BuildCompare {
                status: "failed".into(),
                provider: provider.clone(),
                error: Some(error.clone()),
                sha_a,
                sha_b,
                started_at,
                at,
                ..Default::default()
            },
        });
        Ok(())
    });
    if let Err(e) = result {
        if !e.contains("not found") {
            log::warn!("build_both: {card_id}: comparison result not kept: {e}");
        }
    }
    crate::kanban::emit_kanban_changed(app, workspace_id);
}

/// `git diff --stat` and the diff from `base` to `sha`, the diff cut at
/// `DIFF_MAX_BYTES` on a character boundary.
pub fn lane_diff(repo: &Path, base: &str, sha: &str) -> Result<(String, String, bool), String> {
    let stat = crate::git::capture(repo, &["diff", "--stat", base, sha])?;
    let diff = crate::git::capture(repo, &["diff", base, sha])?;
    if diff.len() <= DIFF_MAX_BYTES {
        return Ok((stat, diff, false));
    }
    let mut end = DIFF_MAX_BYTES;
    while !diff.is_char_boundary(end) {
        end -= 1;
    }
    Ok((stat, diff[..end].to_string(), true))
}

/// CL-8: one file of a build's diff, with its added and removed lines.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaneDiffFile {
    #[serde(flatten)]
    pub file: crate::git::FileDiff,
    pub added: u32,
    pub removed: u32,
    /// Round 3: its lines were left out — they alone would pass the cap.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cut: bool,
}

/// CL-8: `build_both_lane_diff` — a build's changes from the card's base to
/// its Build done, on demand and never persisted. `sha` is the snapshot it
/// was read at: a later Build done is a different diff.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaneDiff {
    pub lane: String,
    pub sha: String,
    pub base: String,
    pub files: Vec<LaneDiffFile>,
    pub added: u32,
    pub removed: u32,
    /// Round 2: the hunks were longer than `DIFF_MAX_BYTES`; the files
    /// past the cut keep their counts but carry no lines.
    pub cut: bool,
}

/// The lines a hunk adds and removes.
fn hunk_counts(files: &[crate::git::FileDiff]) -> Vec<(u32, u32)> {
    files
        .iter()
        .map(|f| {
            f.hunks.iter().flat_map(|h| h.body.lines()).fold((0, 0), |(a, r), line| {
                if line.starts_with('+') {
                    (a + 1, r)
                } else if line.starts_with('-') {
                    (a, r + 1)
                } else {
                    (a, r)
                }
            })
        })
        .collect()
}

/// The commit both builds started from: the card's recorded base, else
/// (an older card) where the two builds' snapshots meet.
fn builds_base(card: &KanbanCard, repo: &Path) -> Result<String, String> {
    if let Some(b) = card.worktree_base.as_ref() {
        return Ok(b.commit.clone());
    }
    let bb = card.build_both.as_ref().ok_or("This card isn't being built by both.")?;
    match (lane_sha(bb, LANE_A), lane_sha(bb, LANE_B)) {
        (Some(a), Some(b)) => crate::git::capture(repo, &["merge-base", &a, &b]).map(|s| s.trim().to_string()),
        _ => Err("This card has no recorded base commit, so a build's changes can't be read on their own yet.".into()),
    }
}

/// CL-8: one build's diff from the card's base to its Build done, read in
/// the workspace's repository (the builds' commits are on its branches,
/// whether or not the build's worktree is still there).
pub fn lane_diff_of(card: &KanbanCard, repo: &Path, lane: &str) -> Result<LaneDiff, String> {
    let bb = card.build_both.as_ref().ok_or("This card isn't being built by both.")?;
    let l = bb.lane(lane).ok_or_else(|| format!("There is no build {lane:?}."))?;
    let sha = l
        .done
        .as_ref()
        .map(|d| d.sha.clone())
        .ok_or_else(|| format!("{}'s build has no Finish and check yet.", crate::builder::vendor_display(&l.vendor)))?;
    let base = builds_base(card, repo)?;
    let files = crate::git::diff_hunks(repo, &base, &sha)?;
    let counts = hunk_counts(&files);
    let (added, removed) = counts.iter().fold((0, 0), |(a, r), (fa, fr)| (a + fa, r + fr));
    let (files, cuts) = cap_hunks(files, DIFF_MAX_BYTES);
    let cut = cuts.iter().any(|c| *c);
    let files = files
        .into_iter()
        .zip(counts)
        .zip(cuts)
        .map(|((file, (added, removed)), cut)| LaneDiffFile { file, added, removed, cut })
        .collect();
    Ok(LaneDiff { lane: lane.to_string(), sha, base, files, added, removed, cut })
}

/// At most `max` bytes of hunk lines go to the page, as the comparison's
/// diff is cut. Round 3: a file whose lines would pass the budget keeps its
/// place and counts without lines (and says so); later files that still
/// fit keep theirs.
fn cap_hunks(mut files: Vec<crate::git::FileDiff>, max: usize) -> (Vec<crate::git::FileDiff>, Vec<bool>) {
    let mut used = 0usize;
    let mut cuts = Vec::with_capacity(files.len());
    for f in files.iter_mut() {
        let size: usize = f.hunks.iter().map(|h| h.body.len() + h.header.len()).sum();
        if used + size > max {
            f.hunks.clear();
            cuts.push(true);
        } else {
            used += size;
            cuts.push(false);
        }
    }
    (files, cuts)
}

/// The one read-only Challenger pass. Blocking; runs on its own thread. The
/// Challenger is the other vendor of the one this card would build with
/// (the card's choice, else the Settings default), falling back to the
/// other when it can't review — as a review picks it.
fn run_compare(app: &AppHandle, workspace_id: &str, card_id: &str) -> CompareRun {
    let kanban = app.state::<KanbanStore>();
    let card = kanban.get_card(workspace_id, card_id).map_err(|e| (None, e))?;
    let bb = card.build_both.clone().ok_or((None, "This card isn't being built by both.".to_string()))?;
    let ws_cwd = PathBuf::from(workspace_cwd(app, workspace_id).map_err(|e| (None, e))?);
    let sha = |lane: &str| lane_sha(&bb, lane).ok_or((None, "Both builds need a result.".to_string()));
    let (sha_a, sha_b) = (sha(LANE_A)?, sha(LANE_B)?);
    let base = builds_base(&card, &ws_cwd).map_err(|e| (None, e))?;
    let diffs = [(LANE_A, &sha_a), (LANE_B, &sha_b)]
        .map(|(lane, sha)| lane_diff(&ws_cwd, &base, sha).map(|d| (lane, sha.clone(), d)));

    let settings_vendor = app.state::<crate::settings::SettingsStore>().snapshot().behavior.builder_vendor;
    let builder_vendor = card.builder_vendor_pref.unwrap_or(settings_vendor).as_str();
    let env = crate::shell_env::get();
    let caps = app.state::<crate::review_capabilities::ReviewerCapabilityRegistry>();
    let pty = app.state::<crate::pty::PtyRegistry>();
    let mut last = String::new();
    let mut chosen = None;
    for vendor in [crate::builder::challenger_for(builder_vendor), builder_vendor] {
        if !crate::builder::vendor_installed(&env, vendor) {
            last = format!("{} isn't installed", crate::builder::vendor_display(vendor));
            continue;
        }
        let provider = if vendor == "codex" { ply_collab::Provider::Codex } else { ply_collab::Provider::Claude };
        match crate::review_capabilities::ensure_current(&caps, &pty, provider, &env, crate::review_capabilities::REVIEW_PROBE_WAIT) {
            Ok(view) => {
                chosen = Some((vendor, provider, view));
                break;
            }
            Err(e) => last = e,
        }
    }
    let (vendor, provider, view) = chosen.ok_or((None, format!("No eligible Reviewer: {last}")))?;
    let who = Some(vendor.to_string());
    let level = view.level.ok_or((who.clone(), "the Reviewer's capability has no level".to_string()))?;
    let executable = view
        .executable_path
        .clone()
        .ok_or((who.clone(), "the Reviewer's capability has no executable".to_string()))?;
    let model = crate::settings::model_for_card(app, workspace_id, card.models.as_ref(), vendor, crate::settings::AgentRole::Challenger);
    // Under the Claude session root, as a review's tree is, and a plain tree
    // for Claude: it then inherits the trust the member gave that root.
    let config = app
        .path()
        .app_config_dir()
        .map_err(|e| (who.clone(), format!("resolve Plyloft config directory: {e}")))?;
    let root = crate::claude_session::session_worktrees(&config, "build-both");
    let isolated = root.join(uuid::Uuid::new_v4().to_string());
    let create = if provider == ply_collab::Provider::Claude {
        crate::pinned_read::DetachedReadWorktree::create_plain
    } else {
        crate::pinned_read::DetachedReadWorktree::create
    };
    let worktree = create(&ws_cwd, isolated, root, &base).map_err(|e| (who.clone(), e))?;
    // Windows' command line is capped: the diffs go in as files the pass
    // reads in its own checkout, never in the prompt.
    let mut inputs = Vec::new();
    for diff in diffs {
        let (lane, sha, (stat, diff, cut)) = diff.map_err(|e| (who.clone(), e))?;
        let verify = verify_words(bb.lane(lane).and_then(|l| l.verify.as_ref()));
        let label = if lane == LANE_A { "a" } else { "b" };
        inputs.push(write_lane_files(worktree.path(), label, &sha, &stat, &diff, cut, verify).map_err(|e| (who.clone(), e))?);
    }
    let prompt = compare_prompt(&crate::review_context::brief_of(&card), &base, &inputs[0], &inputs[1]);
    let run = crate::reviewer::run_read_only_pass(
        app,
        &pty,
        provider,
        level,
        &executable,
        workspace_id,
        card_id,
        worktree.path(),
        &prompt,
        &model,
        COMPARE_TIMEOUT_SECS,
        &format!("Compare two builds: {}", card.title),
    );
    if let Some(failure) = run.failure() {
        return Err((who, format!("The comparison failed: {failure}")));
    }
    let answer = run.artifact.ok_or((who.clone(), "The comparison produced no answer.".to_string()))?;
    Ok((vendor.to_string(), answer))
}

#[cfg(test)]
#[path = "build_both_tests.rs"]
mod tests;
