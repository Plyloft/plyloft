//! v1.31.0 (Cycle 1 — Review surface): wire types + pure helpers for the
//! post-swarm interactive review of a card's per-worktree git diff.
//!
//! The IPC glue (`card_review_diff`, `card_review_request_changes`,
//! `card_review_merge`) lives in
//! `commands.rs`; this module owns the serializable types and the
//! follow-up-prompt builder.

use serde::{Deserialize, Serialize};

use crate::git::FileDiff;

/// Payload of `card_review_diff`: the git diff a card's worktree branch
/// introduced since it forked from `base_branch`. An empty `files` vec is
/// the legitimate "swarm changed nothing" state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiff {
    pub card_id: String,
    pub base_branch: String,
    pub card_branch: String,
    pub files: Vec<FileDiff>,
    pub generated_at: i64,
    /// CL-6: the card's Challenger findings that name a line, placed on the
    /// branch as it is now. Empty without a ledger.
    pub anchors: Vec<crate::review_anchors::FindingAnchor>,
}

/// One reviewer rejection — an input element of `card_review_request_changes`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRejection {
    pub path: String,
    pub hunk_header: String,
    pub feedback: String,
    /// The hunk's diff body, so the follow-up prompt can quote it verbatim.
    /// The FE already has it from `card_review_diff`; passing it back avoids
    /// a backend re-diff.
    #[serde(default)]
    pub hunk_body: String,
}

/// Bounded, display-oriented dirty state for the target workspace checkout.
/// A stable encoded form is also returned by the mutation-time ship guard so
/// advisory and authoritative failures render identical copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDirtyState {
    pub total_count: usize,
    pub paths: Vec<String>,
    pub truncated: bool,
}

const TARGET_DIRTY_ERROR_PREFIX: &str = "PLY_TARGET_DIRTY_V1:";

pub fn encode_target_dirty_error(state: &TargetDirtyState) -> String {
    format!(
        "{TARGET_DIRTY_ERROR_PREFIX}{}",
        serde_json::to_string(state).expect("TargetDirtyState must serialize")
    )
}

#[cfg(test)]
pub fn decode_target_dirty_error(error: &str) -> Option<TargetDirtyState> {
    serde_json::from_str(error.strip_prefix(TARGET_DIRTY_ERROR_PREFIX)?).ok()
}

/// Result of `card_review_merge`. On a real git conflict `merged` is false
/// and `conflicting_paths` is non-empty — the caller surfaces a resolve hint.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMergeResult {
    pub merged: bool,
    pub conflicting_paths: Vec<String>,
    /// GH #183: Land's fast-forward (`land_sync_gate`) left the target branch
    /// at origin's tip — `FastForwarded` or `UpToDate`, never `Offline`,
    /// `NoRemote` or `Ahead`. The one proof the window takes GH #88's
    /// local-branch block down on.
    #[serde(default)]
    pub fast_forwarded: bool,
    /// PR #375 review: the review panel's Merge of a Builder card — the
    /// human's decision on the review (an accepted pushback, dismissed
    /// findings), as `ShipOutcome::review_override` says it. Not persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_override: Option<String>,
}

/// Result of `card_ship` (Phase 3). `kind` is `pr` (a pull request was
/// opened) or `local_merge` (squash-merged into the target branch).
/// `fell_back` is true when a PR was requested but the workspace had no
/// remote, so it landed locally instead.
///
/// `verify_pending`: Ship found uncommitted edits on a card with no Builder
/// (crash recovery), committed them as `recovery_sha` and started Verify on
/// that commit. Nothing was published; Ship again once Verify passes.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipOutcome {
    pub kind: String,
    pub pr_url: Option<String>,
    pub merged: bool,
    pub conflicting_paths: Vec<String>,
    pub fell_back: bool,
    /// GH #183: the land's fast-forward left the target branch at origin's
    /// tip (see `ReviewMergeResult::fast_forwarded`). False for a PR and a
    /// `verify_pending`, which never ran it.
    #[serde(default)]
    pub fast_forwarded: bool,
    /// The commit a recovery flush created (kind `verify_pending`).
    pub recovery_sha: Option<String>,
    /// A Builder card's last build snapshot — exactly what was published,
    /// since Ship refuses a worktree that moved past it.
    pub shipped_snapshot: Option<crate::kanban::BuildSnapshot>,
    /// The shipped snapshot's last Challenger review was overridden by the
    /// human (`builder::review_override_summary`): who, when, snapshot N.
    pub review_override: Option<String>,
    /// GH #99: the shipped commit was not reviewed by the Challenger
    /// (`builder::unreviewed_ship_summary`), with the reason; GH #129: and
    /// a request for changes nobody re-checked — one line each
    /// (`builder::ship_review_lines`).
    pub unreviewed: Option<String>,
    /// ADR 0006: `Ship with follow-up` — the card that carries this card's
    /// open findings.
    pub follow_up: Option<crate::kanban::FollowUpCard>,
    /// Skills hub H3a: a skill card's commit that changed only skill files —
    /// Verify was not needed and no install script ran.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub skill_only: bool,
    /// Skills hub H3a: what a skill card's Ship preflight said — already up
    /// to date (`skill_up_to_date`), refresh the card (`skill_refresh`), or
    /// why it came as a pull request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_note: Option<String>,
    /// 1.169.1 (R2): kind `carries_local_commits` — Ship as a PR stopped
    /// before any push: the pull request would also carry these commits,
    /// which aren't the card's own and aren't on GitHub yet. Ship as a PR
    /// again with `carryLocalCommits` to push them with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_commits: Option<LocalCommits>,
    /// 1.169.1 (R13): the branch the card shipped to (its real name, as
    /// Ship resolved it) — the toast names it. None before Ship knew it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// R13 (Challenger): the project's `origin` is a GitHub repository, by
    /// the same reading Ship history's receipt makes (`project_local_origin`):
    /// a land here says it isn't on GitHub yet.
    #[serde(default, rename = "onGitHub", skip_serializing_if = "std::ops::Not::not")]
    pub on_github: bool,
    /// 1.171.0 A3 (DL-30): kind `merged_live` — the go-live step it started
    /// is Plyloft's own install, which quits and relaunches Plyloft
    /// (`ship::is_self_install`). Only then does the toast say it relaunches.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub relaunches: bool,
}

/// R2: the commits a card's pull request would carry that aren't the card's
/// own and aren't on GitHub's `target` (`commands::pr_carries_local_commits`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCommits {
    /// The target branch (its real name), as on this computer.
    pub target: String,
    /// How many there are.
    pub count: u32,
    /// Their subjects, newest first — at most 20 (`count` says the rest).
    pub subjects: Vec<String>,
}

/// v1.31.0 (Outcome screen): the two things the outcome screen can't derive
/// FE-side — the reviewer leg's verdict and the changed-file count.
/// Everything else (card goal, swarm status, verify status) the FE already
/// holds in its stores.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardOutcome {
    /// `approve` / `reject` — the swarm's reviewer leg verdict. None when the
    /// template had no reviewer leg (single-role templates, `review-followup`)
    /// or no swarm ran.
    pub reviewer_verdict: Option<String>,
    /// The reviewer's prose critique, if the artifact carried one.
    pub reviewer_critique: Option<String>,
    /// v1.108.0: "swarm" (role-chain reviewer) or "challenger" (independent
    /// read-only review of a build snapshot by the other vendor).
    #[serde(default)]
    pub reviewer_source: Option<String>,
    #[serde(default)]
    pub reviewer_provider: Option<String>,
    #[serde(default)]
    pub reviewer_degraded: bool,
    /// Count of files the swarm changed on the worktree branch.
    pub files_changed: u32,
    /// Whether the workspace has a verify pipeline configured — lets the
    /// outcome screen distinguish "no checks set up" from "checks not run
    /// yet for this card".
    pub verify_configured: bool,
    /// v1.38.0 (recon-aware Outcome): true when the card's swarm template
    /// has `output_kind: Recon` — drives the Outcome screen to render the
    /// `recon_summary_md` markdown report as primary content instead of
    /// the diff/ship/verify surface.
    pub is_recon: bool,
    /// v1.38.0: the agent-authored markdown report from the latest recon
    /// run's artifact `summary_md` field. None when the template is
    /// `Code`, or when the recon run pre-dates v1.38.0 (the prompt
    /// changes for `ux-reviewer` and `architect` ship in v1.38.0 — older
    /// completed audits lack this field). For older audits, a synthesized
    /// fallback is built from the structured artifact fields (verdict,
    /// critique, ux_issues / open_questions) so the Outcome screen is
    /// still useful before reseed.
    pub recon_summary_md: Option<String>,
    /// v1.38.0: true when the latest recon run's `verdict` is reject (or
    /// otherwise negative). Used in v1.39.0 by the fork affordance to
    /// render a warning band — the user can still fork, but they're
    /// flagged that the audit recommended against proceeding.
    pub recon_verdict_negative: bool,
    /// Why Ship would refuse this card right now — a Builder worktree that
    /// moved past its last build snapshot. None when Ship can proceed.
    pub ship_blocked_reason: Option<String>,
    /// HEAD of a card with no Builder when it is a Ship recovery commit:
    /// Ship publishes it only after Verify passes on exactly that commit.
    pub recovery_sha: Option<String>,
    /// GH #191: `origin/<target>` when the card changed nothing because its
    /// commits are already in the fetched target (merged here or on another
    /// Mac). Only computed when `files_changed == 0`; local refs, no fetch.
    pub already_in: Option<String>,
    /// CL-11 (walks): whether the card's worktree has a remote — Ship as a
    /// PR needs one (`card_ship` merges here instead when there is none).
    /// None when there is no worktree to read.
    #[serde(default)]
    pub has_remote: Option<bool>,
    /// R10: the host of an `origin` that isn't on GitHub ("this computer"
    /// for a local path) — the card says Ship as a PR needs a GitHub origin.
    /// None for a GitHub origin, no origin, or no worktree.
    #[serde(default)]
    pub origin_host: Option<String>,
    /// R10 (Challenger): an `origin` on GitHub whose address isn't a
    /// repository's — the URL without credentials. None otherwise.
    #[serde(default)]
    pub origin_unreadable: Option<String>,
}

/// Build the follow-up swarm's goal text from a set of rejections. Pure —
/// unit-tested. The follow-up swarm runs in the card's existing worktree,
/// so the prompt only needs the rejected hunks + feedback.
/// G4 (launch D8): no new swarm starts. A card that never ran a swarm (a
/// Builder card) gets no follow-up swarm for its rejected changes; the
/// frontend sends them to its Builder session instead
/// (`card_review_followup_message` + `builderStore.sendChanges`).
pub const FOLLOWUP_SWARM_REFUSAL: &str =
    "This card never ran a swarm, so no swarm starts for its changes: they go to its Builder session instead.";

/// Why `card_review_request_changes` refuses: only a card that ran a swarm
/// gets a follow-up swarm.
pub fn followup_swarm_refusal(card: &crate::kanban::KanbanCard) -> Option<&'static str> {
    if card.linked_swarm_id.is_none() {
        Some(FOLLOWUP_SWARM_REFUSAL)
    } else {
        None
    }
}

pub fn build_followup_prompt(rejections: &[ReviewRejection]) -> String {
    let mut s = String::from(
        "# Review feedback\n\n\
         A reviewer reviewed your changes in this worktree and rejected the \
         items below. Address each one, then stop. Do not revert or re-touch \
         changes that were not rejected.\n",
    );
    for (i, r) in rejections.iter().enumerate() {
        // v1.31.0 (Outcome screen): a whole-card rejection (empty path +
        // header) carries the vibe-mode "Not right — here's what's wrong"
        // prose. Render it as plain feedback, not a hunk reference.
        if r.path.trim().is_empty() && r.hunk_header.trim().is_empty() {
            s.push_str(&format!("\n## Change requested\n\n{}\n", r.feedback.trim()));
            continue;
        }
        s.push_str(&format!("\n## Rejected change {} — {}\n", i + 1, r.path));
        if r.hunk_body.trim().is_empty() {
            s.push_str(&format!("Hunk: {}\n", r.hunk_header));
        } else {
            s.push_str("```diff\n");
            s.push_str(r.hunk_body.trim_end_matches('\n'));
            s.push_str("\n```\n");
        }
        s.push_str(&format!("\nReviewer feedback: {}\n", r.feedback.trim()));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_follow_up_swarm_is_only_for_a_card_that_ran_one() {
        let mut card: crate::kanban::KanbanCard = serde_json::from_str(
            r#"{"id":"c","workspaceId":"ws","title":"t","columnId":"in_progress","createdAt":0,"updatedAt":0}"#,
        )
        .unwrap();
        // A Builder card: its changes go to the Builder, never to a new swarm.
        assert_eq!(followup_swarm_refusal(&card), Some(FOLLOWUP_SWARM_REFUSAL));
        card.linked_swarm_id = Some("swarm-1".into());
        assert_eq!(followup_swarm_refusal(&card), None, "a swarm card keeps its follow-up");
    }

    #[test]
    fn followup_prompt_lists_every_rejection() {
        let rejections = vec![
            ReviewRejection {
                path: "src/a.rs".into(),
                hunk_header: "@@ -1,2 +1,2 @@".into(),
                feedback: "use the existing helper".into(),
                hunk_body: "-old\n+new\n".into(),
            },
            ReviewRejection {
                path: "src/b.rs".into(),
                hunk_header: "@@ -9 +9 @@".into(),
                feedback: "wrong variable".into(),
                hunk_body: String::new(),
            },
        ];
        let prompt = build_followup_prompt(&rejections);
        assert!(prompt.contains("Rejected change 1 — src/a.rs"));
        assert!(prompt.contains("```diff\n-old\n+new\n```"));
        assert!(prompt.contains("use the existing helper"));
        assert!(prompt.contains("Rejected change 2 — src/b.rs"));
        // No hunk body → falls back to the header line.
        assert!(prompt.contains("Hunk: @@ -9 +9 @@"));
        assert!(prompt.contains("wrong variable"));
    }

    #[test]
    fn target_dirty_error_codec_is_stable_and_typed() {
        let state = TargetDirtyState {
            total_count: 103,
            paths: vec!["one.txt".into(), "renamed.txt".into()],
            truncated: true,
        };
        let encoded = encode_target_dirty_error(&state);
        assert!(encoded.starts_with("PLY_TARGET_DIRTY_V1:"));
        assert_eq!(decode_target_dirty_error(&encoded), Some(state));
        assert_eq!(decode_target_dirty_error("workspace dirty"), None);
    }
}
