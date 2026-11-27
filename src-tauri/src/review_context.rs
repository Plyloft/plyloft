//! ADR 0006 — what the sweep reads besides the diff.
//!
//! The first review of a card used to carry its title and nothing else, so
//! requirements could not be checked and project rules were invisible. A
//! sweep carries the card's brief, the repository's agent instructions and
//! the Verify result on the revision it reviews. This module finds them;
//! `review_passes.rs` quotes them.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::kanban::{KanbanCard, VerifyEntry, VerifyStatus, VerifyStepResult};
use crate::review_passes::ReviewKind;
use crate::reviewer::{ReviewRunStatus, ReviewerRecord};

/// The agent instructions as a sweep quotes them, notice included.
pub const RULES_MAX_BYTES: usize = 16 * 1024;
pub const RULES_CUT_NOTICE: &str =
    "[Plyloft: the agent instructions were cut at 16 KiB; read the rest in the worktree.]";
/// `@path` includes followed below the top file.
const INCLUDE_DEPTH_MAX: usize = 4;
/// Output lines of a failed Verify step the sweep quotes.
pub const VERIFY_TAIL_LINES: usize = 40;
const VERIFY_LINE_MAX_CHARS: usize = 400;

/// ADR 0006: the first review of a card is a sweep. A card has had its
/// first review once a review of it completed with a verdict that judged the
/// change — approve or changes requested. A review that failed, or that
/// could not see enough (incomplete), did not, so running it again is still
/// the sweep. A record written before verdicts were recorded (GH #58) that
/// completed counts as a review.
pub fn kind_for(records: &[ReviewerRecord]) -> ReviewKind {
    let reviewed = records.iter().any(|record| {
        record.status == ReviewRunStatus::Completed
            && !record.write_escaped
            && match record.verdict.as_deref() {
                Some("approve" | "changes_requested") => true,
                None => record.pass_count == 0,
                _ => false,
            }
    });
    if reviewed {
        ReviewKind::FollowUp
    } else {
        ReviewKind::Sweep
    }
}

/// `kind_for`, with the card's own memory: the reviewer records are capped
/// and evicted, so a card whose first review completed (`first_review_done`,
/// or a standing approve / changes-requested review) is never swept again.
pub fn kind_for_card(records: &[ReviewerRecord], card: Option<&KanbanCard>) -> ReviewKind {
    let builder = card.and_then(|card| card.builder.as_ref());
    let reviewed_on_card = builder.is_some_and(|b| {
        b.first_review_done
            || b.review.as_ref().is_some_and(|review| {
                review.status == "done"
                    && matches!(review.verdict.as_deref(), Some("approve" | "changes_requested"))
            })
    });
    if reviewed_on_card {
        ReviewKind::FollowUp
    } else {
        kind_for(records)
    }
}

/// ADR 0006: why a follow-up review cannot stand and runs as a sweep
/// instead, in words for the card; None when the follow-up stands. It needs
/// the card's ledger with the revision the last review read, the same base,
/// a history that still contains that revision, and a fix diff no larger
/// than one pass (`fix_diff_bytes`, None when git could not produce it) of
/// `pass_budget` — the smaller one for "Review again in passes", so a
/// follow-up that could not see its fixes is retried as a sweep in small
/// passes rather than as the same single pass.
pub fn follow_up_fallback(
    ledger: Option<&crate::review_ledger::CardLedger>,
    base_revision: &str,
    since_is_ancestor: bool,
    fix_diff_bytes: Option<usize>,
    pass_budget: usize,
) -> Option<String> {
    let Some(ledger) = ledger else {
        return Some("Plyloft has no record of the earlier findings for this card.".into());
    };
    let Some(since) = ledger.reviewed_revision.as_deref() else {
        return Some("Plyloft has no record of the revision the last review read.".into());
    };
    if ledger.base_revision.as_deref() != Some(base_revision) {
        return Some(format!(
            "The base moved since the last review ({} → {}).",
            short(ledger.base_revision.as_deref().unwrap_or("?")),
            short(base_revision)
        ));
    }
    if !since_is_ancestor {
        return Some(format!(
            "The branch no longer contains the revision the last review read ({}).",
            short(since)
        ));
    }
    match fix_diff_bytes {
        None => Some("Plyloft could not read the changes since the last review.".into()),
        Some(bytes) if bytes > pass_budget => Some(format!(
            "The changes since the last review are {} KiB, more than one pass ({} KiB).",
            bytes.div_ceil(1024),
            pass_budget / 1024
        )),
        Some(_) => None,
    }
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

/// The card's brief as the Builder received it (the same composition as
/// `builder_start`, without the memory block Ply adds for the Builder).
pub fn brief_of(card: &KanbanCard) -> String {
    let brief = crate::kanban::card_dispatch_prompt(card);
    // Skills hub H5 (Challenger, Builder walk card #75): a Challenger that
    // read Plyloft's align commit as the Builder going against the brief
    // asked for it to be undone, and the card never settled.
    let brief = if card.twins_aligned.is_empty() && card.twins_apart.is_empty() {
        brief
    } else {
        format!("{brief}\n\n{TWINS_NOTE}")
    };
    let brief = crate::review_passes::capped_brief(&brief);
    // 1.172.0 (A1): what the person asked the Builder after the first
    // result (later requests, and line comments sent to it), after the cap (it is bounded on its own), so a change made for
    // one is in scope rather than "not what the card asked for".
    let later = crate::later_requests::brief_block(&card.later_requests, &card.line_comments);
    if later.is_empty() {
        brief
    } else {
        format!("{brief}\n\n{later}")
    }
}

/// What the Challenger reads after the brief on a card where Plyloft
/// aligned (or left apart) a skill's two copies.
pub const TWINS_NOTE: &str = "Plyloft's note: a skill can live in two copies, `.claude/skills/<name>` \
for Claude and `.agents/skills/<name>` for Codex. At Finish and check Plyloft itself commits \
`skill: align <name>`, which makes the copy the Builder did not edit match the one it did. That \
commit is Plyloft's, not the Builder going against the brief: do not report it, and do not ask \
the Builder to undo it.";

/// The repository's agent instructions at `root`: `AGENTS.md`, else
/// `CLAUDE.md`, with the files they include (`@path` on a line of its own),
/// capped at `RULES_MAX_BYTES` with a line saying it was cut. Includes are
/// followed only inside `root`, each file once.
pub fn agent_instructions(root: &Path) -> String {
    let Ok(root) = crate::platform::canonicalize(root) else {
        return "(Plyloft could not open the worktree to read AGENTS.md or CLAUDE.md.)".into();
    };
    let top = ["AGENTS.md", "CLAUDE.md"]
        .iter()
        .map(|name| root.join(name))
        .find(|path| path.is_file());
    let Some(top) = top else {
        return "(This repository has no AGENTS.md or CLAUDE.md.)".into();
    };
    let mut seen = HashSet::new();
    let mut out = String::new();
    append_file(&root, &top, 0, &mut seen, &mut out);
    crate::review_passes::cap_with_notice(out.trim_end(), RULES_MAX_BYTES, RULES_CUT_NOTICE)
}

fn inside(root: &Path, path: &Path) -> Option<PathBuf> {
    let canonical = crate::platform::canonicalize(path).ok()?;
    crate::platform::is_within(&canonical, root).then_some(canonical)
}

fn append_file(root: &Path, path: &Path, depth: usize, seen: &mut HashSet<PathBuf>, out: &mut String) {
    let Some(canonical) = inside(root, path) else {
        return;
    };
    if !seen.insert(canonical.clone()) {
        return;
    }
    let Ok(text) = fs::read_to_string(&canonical) else {
        return;
    };
    let shown = crate::platform::strip_within(&canonical, root)
        .map(|relative| crate::platform::slash_path(&relative))
        .unwrap_or_else(|| canonical.display().to_string());
    out.push_str(&format!("===== {shown} =====\n"));
    let dir = canonical.parent().unwrap_or(root).to_path_buf();
    let mut includes = Vec::new();
    for line in text.lines() {
        out.push_str(line);
        out.push('\n');
        if let Some(target) = include_target(line) {
            includes.push(dir.join(target));
        }
    }
    out.push('\n');
    if depth < INCLUDE_DEPTH_MAX {
        for include in includes {
            append_file(root, &include, depth + 1, seen, out);
        }
    }
}

/// `@AGENTS.md`, `@docs/rules.md` — an include on a line of its own. A home
/// or absolute path is outside the repository and never followed.
fn include_target(line: &str) -> Option<&str> {
    let target = line.trim().strip_prefix('@')?;
    if target.is_empty()
        || target.contains(char::is_whitespace)
        || target.starts_with('~')
        || target.starts_with('/')
    {
        return None;
    }
    Some(target)
}

/// The Verify result a sweep quotes: the latest Verify run recorded on the
/// content of `tree_sha` (the reviewed revision's tree), when there is one
/// that finished. `read_log` returns a step's full output, when kept.
pub fn verify_result(
    history: &[VerifyEntry],
    tree_sha: &str,
    read_log: impl Fn(&VerifyEntry, &VerifyStepResult) -> Option<String>,
) -> Option<String> {
    let entry = history.iter().rev().find(|entry| {
        entry.tree_sha.as_deref() == Some(tree_sha)
            && matches!(entry.status, VerifyStatus::Passed | VerifyStatus::Failed)
    })?;
    let passed = entry.status == VerifyStatus::Passed;
    // GH #333: a pass with no steps is a project with no checks set up —
    // nothing ran, so the Challenger is never told Verify passed.
    if passed && entry.steps.is_empty() {
        return Some("No checks are set up for this project, so Verify ran none on this revision.".into());
    }
    let mut out = format!(
        "Verify {} on this revision{}",
        if passed { "passed" } else { "FAILED" },
        match entry.summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(summary) => format!(": {summary}."),
            None => ".".into(),
        }
    );
    for step in &entry.steps {
        out.push_str(&format!(
            "\n- `{}`: {}",
            step.kind,
            if step.passed { "passed" } else { "failed" }
        ));
        if step.passed {
            continue;
        }
        let output = read_log(entry, step)
            .filter(|log| !log.trim().is_empty())
            .or_else(|| step.reason.clone())
            .unwrap_or_default();
        let lines: Vec<&str> = output.lines().collect();
        let tail = &lines[lines.len().saturating_sub(VERIFY_TAIL_LINES)..];
        if tail.is_empty() {
            out.push_str(" (no output recorded)");
            continue;
        }
        out.push_str(&format!(
            ". The last {} line{} of its output:\n```\n",
            tail.len(),
            if tail.len() == 1 { "" } else { "s" }
        ));
        for line in tail {
            let line: String = line.chars().take(VERIFY_LINE_MAX_CHARS).collect();
            out.push_str(&line.replace("```", "'''"));
            out.push('\n');
        }
        out.push_str("```");
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(status: ReviewRunStatus, verdict: Option<&str>, pass_count: u32) -> ReviewerRecord {
        ReviewerRecord {
            status,
            verdict: verdict.map(str::to_string),
            pass_count,
            ..ReviewerRecord::default()
        }
    }

    /// Skills hub H5 (Challenger, Builder walk card #75): the Challenger
    /// reads that Plyloft's align commit is Plyloft's, on a card where it
    /// aligned or left apart a skill's copies — and only there.
    #[test]
    fn the_brief_says_plyloft_s_align_commit_is_plyloft_s() {
        let mut card = KanbanCard::new("c".into(), "ws".into(), "Edit team-mac2".into(), Some("Append a line.".into()), crate::kanban::KanbanColumnId::Todo);
        assert!(!brief_of(&card).contains("skill: align"));
        card.twins_aligned = vec![crate::skill_twins::Aligned { skill: "team-mac2".into(), winner: crate::skill_reach::Side::Claude }];
        let brief = brief_of(&card);
        assert!(brief.starts_with("Edit team-mac2"));
        assert!(brief.contains("`skill: align <name>`") && brief.contains("do not ask the Builder to undo it"));
        card.twins_aligned.clear();
        card.twins_apart = vec!["team-mac2".into()];
        assert!(brief_of(&card).contains(TWINS_NOTE));
    }

    /// 1.172.0 (A1): the Challenger reads what the person asked after the
    /// first result, after the brief, oldest first — even when the brief
    /// itself was cut — and nothing on a card without any.
    #[test]
    fn the_brief_carries_the_requests_made_after_the_first_result() {
        use crate::later_requests::{LaterRequest, LaterRequestSource, BRIEF_LEAD, BRIEF_SCOPE};
        let mut card = KanbanCard::new("c".into(), "ws".into(), "Add a line".into(), Some("Add one line to README.md.".into()), crate::kanban::KanbanColumnId::Todo);
        assert!(!brief_of(&card).contains(BRIEF_LEAD));
        card.later_requests = vec![
            LaterRequest { id: "a".into(), text: "also add a comment at the top of the changed file".into(), at: 1, source: LaterRequestSource::Chat },
            LaterRequest { id: "b".into(), text: "and say it in the changelog".into(), at: 2, source: LaterRequestSource::NotRight },
        ];
        let brief = brief_of(&card);
        assert!(brief.starts_with("Add a line\n\nAdd one line to README.md."), "{brief}");
        let at = brief.find(BRIEF_LEAD).expect("the later requests follow the brief");
        let first = brief.find("- also add a comment at the top of the changed file").expect("first");
        let second = brief.find("- and say it in the changelog").expect("second");
        assert!(at < first && first < second, "{brief}");
        assert!(brief.ends_with(BRIEF_SCOPE));

        card.notes = Some("x".repeat(crate::review_passes::BRIEF_MAX_BYTES * 2));
        let long = brief_of(&card);
        assert!(long.contains("the card holds the rest.]") && long.contains("- and say it in the changelog"));

        // Line comments sent to the Builder are in the same block, in time
        // order; unsent ones are not.
        card.notes = Some("Add one line to README.md.".into());
        let comment = |body: &str, sent_at: Option<i64>| crate::line_comments::LineComment {
            id: body.into(),
            path: "README.md".into(),
            new_start: Some(3),
            new_end: Some(4),
            old_start: None,
            old_end: None,
            quoted: String::new(),
            body: body.into(),
            created_at: 0,
            updated_at: 0,
            sent_at,
        };
        card.line_comments = vec![comment("shorter sentence", Some(3)), comment("draft only", None)];
        let brief = brief_of(&card);
        assert!(brief.contains("- and say it in the changelog\n- README.md:3-4: shorter sentence\n"), "{brief}");
        assert!(!brief.contains("draft only"));
        card.later_requests.clear();
        assert!(brief_of(&card).contains(&format!("{BRIEF_LEAD}\n- README.md:3-4: shorter sentence")));
    }

    #[test]
    fn a_verify_pass_with_no_steps_is_quoted_as_no_checks_set_up() {
        let entry = |steps: Vec<VerifyStepResult>| VerifyEntry {
            verify_run_id: "v".into(),
            status: VerifyStatus::Passed,
            ended_at: 1,
            summary: Some("all 0 step(s) passed".into()),
            steps,
            tree_sha: Some("t".into()),
        };
        assert_eq!(
            verify_result(&[entry(Vec::new())], "t", |_, _| None).as_deref(),
            Some("No checks are set up for this project, so Verify ran none on this revision.")
        );
        let ran = entry(vec![VerifyStepResult {
            kind: "script".into(),
            passed: true,
            elapsed_ms: 1,
            reason: None,
        }]);
        assert!(verify_result(&[ran], "t", |_, _| None)
            .unwrap()
            .starts_with("Verify passed on this revision"));
    }

    #[test]
    fn the_first_review_is_a_sweep_until_one_judged_the_change() {
        assert_eq!(kind_for(&[]), ReviewKind::Sweep);
        assert_eq!(
            kind_for(&[
                record(ReviewRunStatus::Failed, None, 0),
                record(ReviewRunStatus::Completed, Some("incomplete"), 2),
                record(ReviewRunStatus::Interrupted, None, 0),
            ]),
            ReviewKind::Sweep,
            "a failed or incomplete sweep runs again as a sweep"
        );
        assert_eq!(
            kind_for(&[record(ReviewRunStatus::Completed, Some("changes_requested"), 1)]),
            ReviewKind::FollowUp
        );
        assert_eq!(
            kind_for(&[record(ReviewRunStatus::Completed, Some("approve"), 1)]),
            ReviewKind::FollowUp
        );
        // A record from before GH #58 carries no verdict and no passes.
        assert_eq!(
            kind_for(&[record(ReviewRunStatus::Completed, None, 0)]),
            ReviewKind::FollowUp
        );
        let escaped = ReviewerRecord {
            write_escaped: true,
            ..record(ReviewRunStatus::Completed, Some("approve"), 1)
        };
        assert_eq!(kind_for(&[escaped]), ReviewKind::Sweep);
    }

    /// Challenger P3 on snapshot 11: evicted records do not bring the sweep
    /// back; the card remembers.
    #[test]
    fn the_card_remembers_its_first_review_past_evicted_records() {
        let mut card: KanbanCard = serde_json::from_str(
            r#"{"id":"c","workspaceId":"w","title":"T","columnId":"in_progress","createdAt":1,"updatedAt":1,
                "builder":{"vendor":"claude","snapshots":[]}}"#,
        )
        .unwrap();
        assert!(!card.builder.as_ref().unwrap().first_review_done, "legacy cards load false");
        assert_eq!(kind_for_card(&[], Some(&card)), ReviewKind::Sweep);
        card.builder.as_mut().unwrap().first_review_done = true;
        assert_eq!(kind_for_card(&[], Some(&card)), ReviewKind::FollowUp);
        card.builder.as_mut().unwrap().first_review_done = false;
        card.builder.as_mut().unwrap().review = Some(crate::kanban::BuilderReview {
            status: "done".into(),
            verdict: Some("approve".into()),
            ..Default::default()
        });
        assert_eq!(kind_for_card(&[], Some(&card)), ReviewKind::FollowUp);
        card.builder.as_mut().unwrap().review.as_mut().unwrap().verdict = Some("incomplete".into());
        assert_eq!(kind_for_card(&[], Some(&card)), ReviewKind::Sweep);
        assert_eq!(kind_for_card(&[], None), ReviewKind::Sweep);
    }

    fn ledger(base: &str, since: Option<&str>) -> crate::review_ledger::CardLedger {
        crate::review_ledger::CardLedger {
            reviewed_revision: since.map(str::to_string),
            base_revision: Some(base.into()),
            ..crate::review_ledger::CardLedger::new("w", "c")
        }
    }

    /// ADR 0006: a follow-up stands on the ledger, the same base, an intact
    /// history and a fix diff that fits one pass; otherwise it is a sweep
    /// that says why.
    #[test]
    fn a_follow_up_falls_back_to_a_sweep_and_says_why() {
        let ok = ledger("base1111", Some("rev2222"));
        assert_eq!(follow_up_fallback(Some(&ok), "base1111", true, Some(10), crate::review_passes::PASS_DIFF_BUDGET), None);
        assert_eq!(
            follow_up_fallback(Some(&ok), "base1111", true, Some(crate::review_passes::PASS_DIFF_BUDGET), crate::review_passes::PASS_DIFF_BUDGET),
            None,
            "exactly one pass still fits"
        );
        let large = follow_up_fallback(Some(&ok), "base1111", true, Some(crate::review_passes::PASS_DIFF_BUDGET + 1), crate::review_passes::PASS_DIFF_BUDGET).unwrap();
        assert!(large.contains("more than one pass (96 KiB)"), "{large}");
        let moved = follow_up_fallback(Some(&ok), "base9999", true, Some(10), crate::review_passes::PASS_DIFF_BUDGET).unwrap();
        assert_eq!(moved, "The base moved since the last review (base111 → base999).");
        assert!(follow_up_fallback(Some(&ok), "base1111", false, Some(10), crate::review_passes::PASS_DIFF_BUDGET).unwrap().contains("no longer contains"));
        assert!(follow_up_fallback(Some(&ok), "base1111", true, None, crate::review_passes::PASS_DIFF_BUDGET).is_some());
        assert!(follow_up_fallback(None, "base1111", true, Some(10), crate::review_passes::PASS_DIFF_BUDGET).unwrap().contains("no record of the earlier findings"));
        assert!(follow_up_fallback(Some(&ledger("base1111", None)), "base1111", true, Some(10), crate::review_passes::PASS_DIFF_BUDGET).is_some());
        // Challenger P2 on snapshot 6: "Review again in passes" passes the
        // small budget, so a fix diff larger than it runs as a sweep.
        let small = crate::review_passes::SMALL_PASS_DIFF_BUDGET;
        assert!(follow_up_fallback(Some(&ok), "base1111", true, Some(small + 1), small).unwrap().contains("more than one pass (32 KiB)"));
        assert_eq!(follow_up_fallback(Some(&ok), "base1111", true, Some(small), small), None);
    }

    #[test]
    fn agent_instructions_follow_includes_inside_the_repository_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("CLAUDE.md"), "@AGENTS.md\n").unwrap();
        fs::write(
            root.join("AGENTS.md"),
            "# Rules\n\n1. Persist JSON atomically.\n@docs/extra.md\n@AGENTS.md\n@/etc/hosts\n@~/secret.md\n",
        )
        .unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/extra.md"), "Extra rule.\n@../AGENTS.md\n").unwrap();
        let rules = agent_instructions(root);
        assert!(rules.starts_with("===== AGENTS.md ====="), "{rules}");
        assert!(rules.contains("Persist JSON atomically."));
        assert!(rules.contains("===== docs/extra.md =====\nExtra rule."));
        assert_eq!(rules.matches("===== ").count(), 2, "each file once: {rules}");
        assert!(!rules.contains("localhost"), "never outside the repository");

        // No AGENTS.md: CLAUDE.md, with what it includes.
        fs::remove_file(root.join("AGENTS.md")).unwrap();
        fs::write(root.join("CLAUDE.md"), "Claude rules.\n@docs/extra.md\n").unwrap();
        let rules = agent_instructions(root);
        assert!(rules.starts_with("===== CLAUDE.md =====\nClaude rules."));
        assert!(rules.contains("Extra rule."));

        let empty = tempfile::tempdir().unwrap();
        assert!(agent_instructions(empty.path()).contains("no AGENTS.md or CLAUDE.md"));
    }

    #[test]
    fn rules_over_the_cap_are_cut_with_the_notice() {
        let dir = tempfile::tempdir().unwrap();
        let line = "- A project rule that must hold, written out at some length.\n";
        fs::write(dir.path().join("AGENTS.md"), line.repeat(1000)).unwrap();
        let rules = agent_instructions(dir.path());
        assert!(rules.len() <= RULES_MAX_BYTES, "{}", rules.len());
        assert!(rules.ends_with(RULES_CUT_NOTICE));
        let body = rules.trim_end_matches(RULES_CUT_NOTICE).trim_end();
        assert!(body.ends_with("length."), "cut at a line end");

        fs::write(dir.path().join("AGENTS.md"), line.repeat(10)).unwrap();
        assert!(!agent_instructions(dir.path()).contains("[Plyloft:"));
    }

    fn entry(status: VerifyStatus, tree: &str, steps: Vec<VerifyStepResult>) -> VerifyEntry {
        VerifyEntry {
            verify_run_id: format!("run-{tree}"),
            status,
            ended_at: 1,
            summary: Some("ppvp.sh failed at check #2 (cargo test)".into()),
            steps,
            tree_sha: Some(tree.into()),
        }
    }

    fn step(kind: &str, passed: bool, reason: Option<&str>) -> VerifyStepResult {
        VerifyStepResult {
            kind: kind.into(),
            passed,
            elapsed_ms: 10,
            reason: reason.map(str::to_string),
        }
    }

    #[test]
    fn the_verify_result_is_the_run_on_the_reviewed_content() {
        let log: String = (1..=100).map(|i| format!("log line {i}\n")).collect();
        let history = vec![
            entry(VerifyStatus::Failed, "tree-a", vec![step("script:scripts/ppvp.sh", false, Some("short reason"))]),
            entry(VerifyStatus::Passed, "tree-b", vec![step("cargo-test", true, None)]),
            entry(VerifyStatus::Running, "tree-a", vec![]),
        ];
        let failed = verify_result(&history, "tree-a", |_, _| Some(log.clone())).unwrap();
        assert!(failed.starts_with("Verify FAILED on this revision: ppvp.sh failed"), "{failed}");
        assert!(failed.contains("`script:scripts/ppvp.sh`: failed. The last 40 lines"));
        assert!(failed.contains("log line 61\n") && failed.contains("log line 100\n"));
        assert!(!failed.contains("log line 60\n"));

        // No log kept: the persisted reason stands in.
        let reason = verify_result(&history, "tree-a", |_, _| None).unwrap();
        assert!(reason.contains("short reason"));

        let passed = verify_result(&history, "tree-b", |_, _| None).unwrap();
        assert!(passed.starts_with("Verify passed on this revision"));
        assert!(passed.contains("`cargo-test`: passed"));

        assert!(verify_result(&history, "tree-c", |_, _| None).is_none());
    }
}
