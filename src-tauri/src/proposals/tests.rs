//! GH #104: the improvement proposal's pure halves, walked one path at a time.
//!
//! Every path the card names has a test here: friction yes and no, `NONE`, a
//! valid proposal, a diff outside the allowed paths, a diff that does not
//! apply, both staleness rules, the prompt's inputs, the schema's forward
//! compatibility (Tier 2) and the change the channel is handed.

use super::*;
use std::path::PathBuf;

// ── The friction rule ────────────────────────────────────────────────

#[test]
fn the_friction_rule_is_the_cards_three_conditions_and_nothing_else() {
    // Nothing runs on a card that went smoothly.
    assert_eq!(met_friction(&FrictionInput::default()), None);
    // One request for changes is a normal round, not friction.
    assert_eq!(
        met_friction(&FrictionInput { changes_requested_rounds: 1, ..Default::default() }),
        None,
        "one round is the loop working"
    );
    assert_eq!(
        met_friction(&FrictionInput { changes_requested_rounds: 2, ..Default::default() }),
        Some(FrictionReason::ChangesRequested(2))
    );
    assert_eq!(
        met_friction(&FrictionInput { changes_requested_rounds: 7, ..Default::default() }),
        Some(FrictionReason::ChangesRequested(7))
    );
    assert_eq!(
        met_friction(&FrictionInput { verify_failed: true, ..Default::default() }),
        Some(FrictionReason::VerifyFailed)
    );
    assert_eq!(
        met_friction(&FrictionInput { user_corrections: 1, ..Default::default() }),
        Some(FrictionReason::UserCorrections(1)),
        "one correction after the first answer is friction"
    );
    // At most one proposal per card: nothing runs again, however much friction.
    assert_eq!(
        met_friction(&FrictionInput {
            changes_requested_rounds: 5,
            verify_failed: true,
            user_corrections: 3,
            findings_dismissed: 2,
            already_proposed: true,
        }),
        None,
        "a card that had its pass never gets a second one"
    );
}

#[test]
fn the_friction_reason_says_which_condition_in_words() {
    assert_eq!(
        FrictionReason::ChangesRequested(3).line(),
        "The Reviewer asked for changes 3 times on this card."
    );
    assert_eq!(FrictionReason::VerifyFailed.line(), "Verify failed on this card.");
    assert!(FrictionReason::UserCorrections(1).line().contains("one correction"));
    assert!(FrictionReason::UserCorrections(4).line().contains("4 corrections"));
}

/// Findings filter: a finding the member dismissed as not a real issue is a
/// human correction of the Challenger — it counts as friction (after the
/// card's own three), and the prompt reads it as the human's decision.
#[test]
fn a_dismissed_finding_is_friction_and_a_decision() {
    assert_eq!(
        met_friction(&FrictionInput { findings_dismissed: 1, ..Default::default() }),
        Some(FrictionReason::FindingsDismissed(1))
    );
    assert_eq!(
        met_friction(&FrictionInput { findings_dismissed: 2, user_corrections: 1, ..Default::default() }),
        Some(FrictionReason::UserCorrections(1)),
        "the card's own conditions are weighed first"
    );
    assert!(FrictionReason::FindingsDismissed(2).line().contains("dismissed 2 of your findings"));
    let mut ledger = crate::review_ledger::CardLedger::new("w", "c");
    ledger.findings = vec![
        crate::review_ledger::LedgerFinding { id: "F1".into(), severity: Some("P2".into()), title: "Races".into(), ..Default::default() },
        crate::review_ledger::LedgerFinding { id: "F2".into(), severity: Some("P3".into()), title: "Naming".into(), ..Default::default() },
        crate::review_ledger::LedgerFinding { id: "F3".into(), severity: Some("P1".into()), title: "Kept".into(), ..Default::default() },
    ];
    crate::review_ledger::dismiss(&mut ledger, "F1", Some("the lock guards it"), None, 1).unwrap();
    crate::review_ledger::dismiss(&mut ledger, "F2", None, None, 2).unwrap();
    let lines = dismissal_lines(&ledger);
    assert_eq!(lines.len(), 2);
    assert!(lines[0].contains("F1 (P2 — Races)") && lines[0].contains("because: \"the lock guards it\""), "{}", lines[0]);
    assert!(lines[1].contains("F2") && lines[1].contains("no reason given"));
    let section = human_section(&[], 0, &lines);
    assert!(section.contains("dismissed it as not a real issue"));
}

// ── What a proposal may name ─────────────────────────────────────────

#[test]
fn only_the_repositorys_skills_and_its_two_instruction_files_are_allowed() {
    assert!(allowed_path(".claude/skills/deploy/SKILL.md"));
    assert!(allowed_path(".claude/skills/deploy/reference/rollback.md"));
    assert!(allowed_path(".agents/skills/deploy/SKILL.md"), "the Codex equivalent");
    assert!(allowed_path("AGENTS.md"));
    assert!(allowed_path("CLAUDE.md"));

    // Everything else.
    assert!(!allowed_path("src/main.rs"));
    assert!(!allowed_path("docs/PATTERNS.md"));
    assert!(!allowed_path("scripts/ppvp.sh"));
    assert!(!allowed_path("README.md"));
    assert!(!allowed_path(".claude/settings.json"));
    assert!(!allowed_path(".claude/skills/deploy"), "a directory names no file");
    assert!(!allowed_path(".claude/skills/"), "the root names no file");
    assert!(!allowed_path(""));
    // Nothing that climbs out, and nothing absolute.
    assert!(!allowed_path(".claude/skills/../../etc/hosts"));
    assert!(!allowed_path(".claude/skills/deploy/../../../AGENTS.md"));
    assert!(!allowed_path("/etc/hosts"));
    assert!(!allowed_path("/Users/someone/.claude/skills/deploy/SKILL.md"));
    assert!(!allowed_path(".claude\\skills\\deploy\\SKILL.md"));
    assert!(!allowed_path("docs/../AGENTS.md"), "AGENTS.md only at the root");
}

#[test]
fn a_skill_path_names_its_skill_under_either_root() {
    assert_eq!(skill_of(".claude/skills/deploy/SKILL.md").as_deref(), Some("deploy"));
    assert_eq!(skill_of(".agents/skills/deploy/SKILL.md").as_deref(), Some("deploy"));
    assert_eq!(skill_of("AGENTS.md"), None);
    // GH #104 review 2 (N1): the root is kept as itself, end to end. #105 made
    // the channel carry both, so there is nothing to fold onto any more — and the
    // fold used to quote a Codex-only skill under a Claude path that is not there.
    assert_eq!(skill_root_of(".claude/skills/deploy/SKILL.md"), Some(".claude/skills/"));
    assert_eq!(skill_root_of(".agents/skills/deploy/SKILL.md"), Some(".agents/skills/"));
    assert_eq!(skill_root_of("AGENTS.md"), None);
}

#[test]
fn every_section_of_a_diff_is_read_on_both_sides() {
    let diff = "diff --git a/.claude/skills/deploy/SKILL.md b/.claude/skills/deploy/SKILL.md\n\
                index 1111111..2222222 100644\n\
                --- a/.claude/skills/deploy/SKILL.md\n\
                +++ b/.claude/skills/deploy/SKILL.md\n\
                @@ -1 +1,2 @@\n Deploy.\n+More.\n";
    assert_eq!(
        diff_sections(diff),
        vec![DiffSection {
            old: Some(".claude/skills/deploy/SKILL.md".into()),
            new: Some(".claude/skills/deploy/SKILL.md".into()),
        }]
    );

    // A bare patch, with a timestamp on each header.
    let bare = "--- AGENTS.md\t2026-09-01\n+++ AGENTS.md\t2026-09-22\n@@ -1 +1,2 @@\n A.\n+B.\n";
    assert_eq!(
        diff_sections(bare),
        vec![DiffSection { old: Some("AGENTS.md".into()), new: Some("AGENTS.md".into()) }]
    );

    // A deletion names its file only on the `---` side. Review 1 (MAJOR): the
    // first version read the written side only, so this looked like no file.
    let deletion = "--- a/src-tauri/src/lib.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-fn main() {}\n";
    assert_eq!(
        diff_sections(deletion),
        vec![DiffSection { old: Some("src-tauri/src/lib.rs".into()), new: None }]
    );
    assert_eq!(
        diff_sections(deletion)[0].names(),
        vec!["src-tauri/src/lib.rs"],
        "the deletion's one name is still checked"
    );

    // A creation.
    let creation = "--- /dev/null\n+++ b/.claude/skills/new/SKILL.md\n@@ -0,0 +1 @@\n+Hi\n";
    assert_eq!(
        diff_sections(creation),
        vec![DiffSection { old: None, new: Some(".claude/skills/new/SKILL.md".into()) }]
    );

    // A rename names two files with no hunk at all.
    let rename = "diff --git a/.claude/skills/a/SKILL.md b/.claude/skills/b/SKILL.md\n\
                  similarity index 100%\n\
                  rename from .claude/skills/a/SKILL.md\n\
                  rename to .claude/skills/b/SKILL.md\n";
    assert_eq!(
        diff_sections(rename),
        vec![DiffSection {
            old: Some(".claude/skills/a/SKILL.md".into()),
            new: Some(".claude/skills/b/SKILL.md".into()),
        }]
    );

    // Two bare sections, no `diff --git` between them.
    let two = "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1,2 @@\n A\n+B\n\
               --- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1 +1,2 @@\n C\n+D\n";
    assert_eq!(diff_sections(two).len(), 2);

    // A quoted name.
    let quoted = "--- \"a/.claude/skills/my skill/SKILL.md\"\n+++ \"b/.claude/skills/my skill/SKILL.md\"\n";
    assert_eq!(
        diff_sections(quoted)[0].new.as_deref(),
        Some(".claude/skills/my skill/SKILL.md")
    );

    assert!(diff_sections("nothing here").is_empty());
}

// ── The answer parser ────────────────────────────────────────────────

fn valid_answer() -> String {
    "SCOPE: repository\n\
     TARGET: .claude/skills/deploy/SKILL.md\n\
     REASON: After card #88: three rounds with the Reviewer over missing rollback tests.\n\
     CHANGE: The change asks the deploy skill to check that a rollback test exists before it pushes, and to stop and say so when one is missing. Four lines are added; nothing is removed.\n\
     DIFF:\n\
     ```diff\n\
     --- a/.claude/skills/deploy/SKILL.md\n\
     +++ b/.claude/skills/deploy/SKILL.md\n\
     @@ -1,2 +1,3 @@\n\
      # Deploy\n\
     +Check that a rollback test exists before pushing.\n\
     ```\n"
        .to_string()
}

#[test]
fn none_is_the_answer_a_card_usually_gets() {
    assert_eq!(parse_answer("NONE"), Answer::None);
    assert_eq!(parse_answer("  none  \n"), Answer::None);
    assert_eq!(
        parse_answer("The friction was this card's own.\n\nNONE\n"),
        Answer::None,
        "an explanation before NONE is still NONE"
    );
    // An empty answer is not NONE: the pass said nothing at all.
    assert!(matches!(parse_answer(""), Answer::Discarded(_)));
    assert!(matches!(parse_answer("   \n "), Answer::Discarded(_)));
}

#[test]
fn a_valid_proposal_is_read_whole() {
    let Answer::Proposal(proposal) = parse_answer(&valid_answer()) else {
        panic!("a valid answer must parse: {:?}", parse_answer(&valid_answer()));
    };
    assert_eq!(
        proposal.target,
        ProposalTarget::Skill {
            name: "deploy".into(),
            path: ".claude/skills/deploy/SKILL.md".into(),
        }
    );
    assert_eq!(
        proposal.reason,
        "After card #88: three rounds with the Reviewer over missing rollback tests."
    );
    assert!(proposal.words.starts_with("The change asks the deploy skill"));
    assert!(proposal.words.ends_with("nothing is removed."));
    let diff = proposal.diff.expect("a repository proposal carries a diff");
    assert!(diff.contains("+Check that a rollback test exists before pushing."));
    assert!(diff.starts_with("--- a/.claude/skills/deploy/SKILL.md"));
}

#[test]
fn an_instruction_file_is_a_target_of_its_own() {
    let answer = "SCOPE: repository\n\
        TARGET: AGENTS.md\n\
        REASON: After card #88: the rule about rollback tests is nowhere.\n\
        CHANGE: One rule is added under the hard rules.\n\
        DIFF:\n```diff\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1,2 @@\n # Atelier\n+A rule.\n```\n";
    let Answer::Proposal(proposal) = parse_answer(answer) else {
        panic!("{:?}", parse_answer(answer));
    };
    assert_eq!(proposal.target, ProposalTarget::Instructions { file: "AGENTS.md".into() });
}

/// GH #104 review 2 (N1): a diff against the Codex root keeps that root.
#[test]
fn a_diff_against_the_codex_root_keeps_that_root() {
    let answer = "SCOPE: repository\n\
        TARGET: .agents/skills/deploy/SKILL.md\n\
        REASON: After card #88.\n\
        CHANGE: One line.\n\
        DIFF:\n```diff\n--- a/.agents/skills/deploy/SKILL.md\n+++ b/.agents/skills/deploy/SKILL.md\n@@ -1 +1,2 @@\n A\n+B\n```\n";
    let Answer::Proposal(proposal) = parse_answer(answer) else {
        panic!("{:?}", parse_answer(answer));
    };
    assert_eq!(
        proposal.target,
        ProposalTarget::Skill {
            name: "deploy".into(),
            path: ".agents/skills/deploy/SKILL.md".into(),
        },
        "the root it really lives under"
    );
}

/// N1, end to end: quote → apply-check → publish, for a skill the repository
/// carries only for Codex.
#[test]
fn a_codex_only_skill_is_quoted_checked_and_published_as_itself() {
    let repo = git_repo();
    let cwd = repo.path();
    std::fs::create_dir_all(cwd.join(".agents/skills/codex-only")).unwrap();
    std::fs::write(
        cwd.join(".agents/skills/codex-only/SKILL.md"),
        "# Codex only\nRun it.\n",
    )
    .unwrap();

    // 1 · The prompt quotes it at its real path, whole.
    let quote = library_files(cwd);
    let quoted = quote
        .quoted
        .iter()
        .find(|file| file.path == ".agents/skills/codex-only/SKILL.md")
        .expect("a Codex-only skill is offered at its own path");
    assert_eq!(quoted.text, "# Codex only\nRun it.\n", "exactly as on disk");

    // 2 · A diff against it applies — which the folded path could never do.
    let diff = concat!(
        "--- a/.agents/skills/codex-only/SKILL.md\n",
        "+++ b/.agents/skills/codex-only/SKILL.md\n",
        "@@ -1,2 +1,3 @@\n",
        " # Codex only\n",
        "+Check the rollback test first.\n",
        " Run it.\n",
    );
    applies_cleanly_with("git", cwd, diff).expect("it applies to the file that is there");

    // 3 · It publishes under the Codex root, claiming only that root — so a
    // Claude copy somebody else put on the branch is left alone (GH #105).
    let mirror = mirror_of(cwd);
    std::fs::create_dir_all(mirror.join(".agents/skills/codex-only")).unwrap();
    std::fs::write(
        mirror.join(".agents/skills/codex-only/SKILL.md"),
        "# Codex only\nRun it.\n",
    )
    .unwrap();
    let proposal = StoredProposal {
        target: ProposalTarget::Skill {
            name: "codex-only".into(),
            path: ".agents/skills/codex-only/SKILL.md".into(),
        },
        diff: Some(diff.into()),
        target_content_id: target_content_id(cwd, ".agents/skills/codex-only/SKILL.md"),
        target_blob: Some(blob_of(cwd, ".agents/skills/codex-only/SKILL.md")),
        ..stored(1, None)
    };
    let change = approve_change_with("git", &proposal, cwd, &mirror).unwrap();
    assert_eq!(change.name, "codex-only");
    assert_eq!(
        change.claimed(),
        vec![".agents/skills/codex-only".to_string()],
        "only the root it is about"
    );
    let files = change.files.expect("its files");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, ".agents/skills/codex-only/SKILL.md");
    assert_eq!(
        String::from_utf8(files[0].decoded().unwrap()).unwrap(),
        "# Codex only\nCheck the rollback test first.\nRun it.\n"
    );
}

#[test]
fn a_diff_outside_the_allowed_paths_is_discarded() {
    for (target, path) in [
        ("src/main.rs", "src/main.rs"),
        ("docs/PATTERNS.md", "docs/PATTERNS.md"),
        (".claude/settings.json", ".claude/settings.json"),
        ("../AGENTS.md", "../AGENTS.md"),
    ] {
        let answer = format!(
            "SCOPE: repository\nTARGET: {target}\nREASON: After card #88.\nCHANGE: A line.\n\
             DIFF:\n```diff\n--- a/{path}\n+++ b/{path}\n@@ -1 +1,2 @@\n A\n+B\n```\n"
        );
        let Answer::Discarded(why) = parse_answer(&answer) else {
            panic!("{target} must be discarded: {:?}", parse_answer(&answer));
        };
        assert!(why.contains("outside the repository"), "{target}: {why}");
    }
}

/// Review 1 (MAJOR): a second **section** whose only name is on the `---` side,
/// because it deletes the file. The allow-list read the written side only, so
/// this passed, the block drew one file, and Approve deleted a source file.
#[test]
fn a_second_section_that_deletes_a_file_outside_the_paths_is_discarded() {
    let answer = "SCOPE: repository\n\
        TARGET: .claude/skills/deploy/SKILL.md\n\
        REASON: After card #88.\n\
        CHANGE: A line.\n\
        DIFF:\n```diff\n\
        --- a/.claude/skills/deploy/SKILL.md\n+++ b/.claude/skills/deploy/SKILL.md\n@@ -1 +1,2 @@\n A\n+B\n\
        --- a/src-tauri/src/lib.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-fn main() {}\n```\n";
    let Answer::Discarded(why) = parse_answer(answer) else {
        panic!("{:?}", parse_answer(answer));
    };
    assert!(why.contains("outside the repository"), "{why}");
    assert!(why.contains("lib.rs"), "and it names what it refused: {why}");
}

/// GH #104 review 2 (N2): a patch that changes no content — a mode-only or a
/// binary one — would have been stored with a diff, and the block would have put
/// an enabled `Approve and publish` under the words-only sentence.
#[test]
fn a_patch_with_no_hunk_is_discarded() {
    let head = "SCOPE: repository\nTARGET: .claude/skills/deploy/SKILL.md\n\
        REASON: After card #88.\nCHANGE: A line.\nDIFF:\n```diff\n";
    for body in [
        // Mode only.
        "diff --git a/.claude/skills/deploy/SKILL.md b/.claude/skills/deploy/SKILL.md\n\
         old mode 100644\nnew mode 100755\n",
        // Binary.
        "diff --git a/.claude/skills/deploy/SKILL.md b/.claude/skills/deploy/SKILL.md\n\
         Binary files differ\n",
        // Headers and nothing else.
        "--- a/.claude/skills/deploy/SKILL.md\n+++ b/.claude/skills/deploy/SKILL.md\n",
    ] {
        let answer = format!("{head}{body}```\n");
        let Answer::Discarded(why) = parse_answer(&answer) else {
            panic!("a patch with no hunk must be discarded: {:?}", parse_answer(&answer));
        };
        assert!(why.contains("no hunk"), "{why}");
    }
}

#[test]
fn a_proposal_never_creates_deletes_or_renames_a_file() {
    let head = "SCOPE: repository\nTARGET: .claude/skills/deploy/SKILL.md\n\
        REASON: After card #88.\nCHANGE: A line.\nDIFF:\n```diff\n";
    // A creation.
    let creating = format!(
        "{head}--- /dev/null\n+++ b/.claude/skills/deploy/SKILL.md\n@@ -0,0 +1 @@\n+Hi\n```\n"
    );
    let Answer::Discarded(why) = parse_answer(&creating) else {
        panic!("{:?}", parse_answer(&creating));
    };
    assert!(why.contains("already there"), "{why}");
    // A deletion of the target itself.
    let deleting = format!(
        "{head}--- a/.claude/skills/deploy/SKILL.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-Hi\n```\n"
    );
    assert!(matches!(parse_answer(&deleting), Answer::Discarded(_)));
    // A rename inside the allowed paths is still not a change to one file.
    let renaming = format!(
        "{head}diff --git a/.claude/skills/deploy/SKILL.md b/.claude/skills/other/SKILL.md\n\
         rename from .claude/skills/deploy/SKILL.md\n\
         rename to .claude/skills/other/SKILL.md\n```\n"
    );
    let Answer::Discarded(why) = parse_answer(&renaming) else {
        panic!("{:?}", parse_answer(&renaming));
    };
    assert!(
        why.contains("renames") || why.contains("no hunk"),
        "a rename carries no hunk either, and both refusals are true: {why}"
    );
}

#[test]
fn a_diff_that_smuggles_a_second_file_past_an_allowed_header_is_discarded() {
    // The TARGET is allowed; the patch writes a source file too.
    let answer = "SCOPE: repository\n\
        TARGET: .claude/skills/deploy/SKILL.md\n\
        REASON: After card #88.\n\
        CHANGE: A line.\n\
        DIFF:\n```diff\n\
        --- a/.claude/skills/deploy/SKILL.md\n+++ b/.claude/skills/deploy/SKILL.md\n@@ -1 +1,2 @@\n A\n+B\n\
        --- a/src/main.rs\n+++ b/src/main.rs\n@@ -1 +1,2 @@\n C\n+D\n```\n";
    let Answer::Discarded(why) = parse_answer(answer) else {
        panic!("{:?}", parse_answer(answer));
    };
    assert!(why.contains("outside the repository"), "{why}");
}

/// Review 1 (NIT): a ```markdown block before the diff had its **closing** fence
/// read as the diff's opening one, and the whole proposal was discarded.
#[test]
fn a_fence_before_the_diff_does_not_swallow_it() {
    let answer = "SCOPE: repository\n\
        TARGET: .claude/skills/deploy/SKILL.md\n\
        REASON: After card #88.\n\
        CHANGE: A line.\n\
        Here is the sentence I would add:\n\
        ```markdown\n\
        Check that a rollback test exists.\n\
        ```\n\
        DIFF:\n\
        ```diff\n\
        --- a/.claude/skills/deploy/SKILL.md\n\
        +++ b/.claude/skills/deploy/SKILL.md\n\
        @@ -1 +1,2 @@\n A\n+B\n\
        ```\n";
    let Answer::Proposal(proposal) = parse_answer(answer) else {
        panic!("{:?}", parse_answer(answer));
    };
    let diff = proposal.diff.expect("the diff after the prose fence");
    assert!(diff.contains("+B"), "{diff}");
    assert!(!diff.contains("Check that a rollback test exists."), "{diff}");
}

#[test]
fn a_repository_proposal_needs_a_target_a_reason_words_and_a_diff() {
    let full = valid_answer();
    for (missing, marker) in [
        ("TARGET:", "named no target"),
        ("REASON:", "no reason"),
        ("CHANGE:", "in words"),
    ] {
        let answer: String = full
            .lines()
            .filter(|line| !line.trim_start().starts_with(missing))
            .map(|line| format!("{line}\n"))
            .collect();
        let Answer::Discarded(why) = parse_answer(&answer) else {
            panic!("a proposal without {missing} must be discarded");
        };
        assert!(why.contains(marker), "{missing}: {why}");
    }
    // No fenced diff at all.
    let no_diff = "SCOPE: repository\nTARGET: .claude/skills/deploy/SKILL.md\n\
        REASON: After card #88.\nCHANGE: A line.\n";
    let Answer::Discarded(why) = parse_answer(no_diff) else {
        panic!("{:?}", parse_answer(no_diff));
    };
    assert!(why.contains("carried no diff"), "{why}");
}

#[test]
fn a_diff_that_does_not_write_the_named_target_is_discarded() {
    let answer = "SCOPE: repository\n\
        TARGET: .claude/skills/deploy/SKILL.md\n\
        REASON: After card #88.\nCHANGE: A line.\n\
        DIFF:\n```diff\n--- a/.claude/skills/other/SKILL.md\n+++ b/.claude/skills/other/SKILL.md\n@@ -1 +1,2 @@\n A\n+B\n```\n";
    let Answer::Discarded(why) = parse_answer(answer) else {
        panic!("{:?}", parse_answer(answer));
    };
    assert!(why.contains("not the target"), "{why}");
}

#[test]
fn a_personal_team_or_ply_target_is_words_only() {
    for scope in ["personal", "Team", "PLY"] {
        let answer = format!(
            "SCOPE: {scope}\nTARGET: deploy\n\
             REASON: After card #88: the {scope} deploy skill is what went wrong.\n\
             CHANGE: Bring a copy of it into this repository, then add the rollback check.\n\
             DIFF:\n```diff\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n A\n+B\n```\n"
        );
        let Answer::Proposal(proposal) = parse_answer(&answer) else {
            panic!("{scope}: {:?}", parse_answer(&answer));
        };
        assert_eq!(proposal.target.label(), "deploy");
        assert_eq!(
            proposal.target.scope(),
            match scope {
                "personal" => "this-mac",
                "Team" => "team",
                _ => "ply",
            },
            "the block lands on the copy the Reviewer meant, not another of the same name"
        );
        assert_eq!(
            proposal.diff, None,
            "Plyloft never writes a {scope} skill, so the proposal carries no diff"
        );
        assert!(proposal.words.contains("Bring a copy"));
    }
}

#[test]
fn a_reason_and_the_words_are_capped_rather_than_carried_whole() {
    let long = "x".repeat(4000);
    let answer = format!(
        "SCOPE: personal\nTARGET: deploy\nREASON: {long}\nCHANGE: {long}\n"
    );
    let Answer::Proposal(proposal) = parse_answer(&answer) else {
        panic!("{:?}", parse_answer(&answer));
    };
    assert!(proposal.reason.chars().count() <= 601, "{}", proposal.reason.len());
    assert!(proposal.reason.ends_with('…'));
    assert!(proposal.words.ends_with('…'));
}

#[test]
fn an_oversized_diff_is_discarded_rather_than_stored() {
    let body: String = (0..4000).map(|i| format!("+line {i}\n")).collect();
    let answer = format!(
        "SCOPE: repository\nTARGET: .claude/skills/deploy/SKILL.md\n\
         REASON: After card #88.\nCHANGE: A lot.\nDIFF:\n```diff\n\
         --- a/.claude/skills/deploy/SKILL.md\n+++ b/.claude/skills/deploy/SKILL.md\n@@ -1 +1,4000 @@\n{body}```\n"
    );
    let Answer::Discarded(why) = parse_answer(&answer) else {
        panic!("an oversized diff must be discarded");
    };
    assert!(why.contains("more than a proposal carries"), "{why}");
}

// ── Does it apply? ───────────────────────────────────────────────────

fn git_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for args in [
        vec!["init", "--initial-branch=main"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "T"],
    ] {
        let ok = crate::platform::git_command().args(args).current_dir(root).status().unwrap();
        assert!(ok.success());
    }
    std::fs::create_dir_all(root.join(".claude/skills/deploy")).unwrap();
    std::fs::write(root.join(".claude/skills/deploy/SKILL.md"), "# Deploy\nPush it.\n").unwrap();
    std::fs::write(root.join("AGENTS.md"), "# Atelier\nRules.\n").unwrap();
    dir
}

// Written with `concat!` and not a `\`-continued literal: a continuation eats
// the leading whitespace of the next line, and a unified diff's context lines
// begin with exactly one space — the very byte git needs.
/// A mirror of the integration branch, in the shape `build_mirror` leaves:
/// `<mirror>/AGENTS.md` and `<mirror>/.claude/skills/<name>/…`.
fn mirror_of(root: &Path) -> PathBuf {
    let mirror = root.join("mirror");
    std::fs::create_dir_all(mirror.join(".claude/skills/deploy")).unwrap();
    std::fs::write(mirror.join(".claude/skills/deploy/SKILL.md"), "# Deploy\nPush it.\n").unwrap();
    std::fs::write(mirror.join(".claude/skills/deploy/notes.md"), "Branch-only notes.\n").unwrap();
    std::fs::write(mirror.join("AGENTS.md"), "# Atelier\nRules.\n").unwrap();
    mirror
}

/// The blob id git gives some bytes, the way `target_blob_with` reads it.
fn blob_of(repo: &Path, rel: &str) -> String {
    target_blob_with("git", repo, rel).expect("a blob id for a real file")
}

const SKILL_DIFF: &str = concat!(
    "--- a/.claude/skills/deploy/SKILL.md\n",
    "+++ b/.claude/skills/deploy/SKILL.md\n",
    "@@ -1,2 +1,3 @@\n",
    " # Deploy\n",
    "+Check that a rollback test exists before pushing.\n",
    " Push it.\n",
);

#[test]
fn a_diff_that_applies_to_the_repository_is_kept_and_one_that_does_not_is_refused() {
    let repo = git_repo();
    applies_cleanly_with("git", repo.path(), SKILL_DIFF).expect("this diff applies");

    // The file moved on: the same diff no longer applies.
    std::fs::write(
        repo.path().join(".claude/skills/deploy/SKILL.md"),
        "# Deploy\nSomething else entirely.\n",
    )
    .unwrap();
    let why = applies_cleanly_with("git", repo.path(), SKILL_DIFF).expect_err("it must not apply now");
    assert!(why.contains("does not apply"), "{why}");
}

#[test]
fn the_check_writes_nothing_at_all() {
    let repo = git_repo();
    let path = repo.path().join(".claude/skills/deploy/SKILL.md");
    let before = std::fs::read(&path).unwrap();
    applies_cleanly_with("git", repo.path(), SKILL_DIFF).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before, "--check never applies");
    // And nothing new appeared: the patch went to a temporary directory.
    let status = crate::platform::git_command()
        .args(["status", "--porcelain"])
        .current_dir(repo.path())
        .output()
        .unwrap();
    let out = String::from_utf8_lossy(&status.stdout).to_string();
    let lines: Vec<&str> =
        out.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    assert!(
        lines.iter().all(|line| line.contains(".claude/") || line.contains("AGENTS.md")),
        "only the fixture's own untracked files: {lines:?}"
    );
}

#[test]
fn the_patched_bytes_come_from_a_copy_and_the_checkout_is_untouched() {
    let repo = git_repo();
    let path = repo.path().join(".claude/skills/deploy/SKILL.md");
    let before = std::fs::read(&path).unwrap();
    let patched =
        patched_bytes_with("git", repo.path(), ".claude/skills/deploy/SKILL.md", SKILL_DIFF).unwrap();
    let text = String::from_utf8(patched).unwrap();
    assert_eq!(text, "# Deploy\nCheck that a rollback test exists before pushing.\nPush it.\n");
    assert_eq!(std::fs::read(&path).unwrap(), before, "the checkout is never written");
}

// ── Staleness ────────────────────────────────────────────────────────

fn stored(created_at: i64, content: Option<&str>) -> StoredProposal {
    StoredProposal {
        target: ProposalTarget::Skill {
            name: "deploy".into(),
            path: ".claude/skills/deploy/SKILL.md".into(),
        },
        card_id: "card-1".into(),
        card_ref: "#88".into(),
        reason: "After card #88.".into(),
        words: "A line is added.".into(),
        diff: Some(SKILL_DIFF.into()),
        target_content_id: content.map(str::to_string),
        target_blob: content.map(|_| "0".repeat(40)),
        created_at,
        source: None,
    }
}

/// Review 1 (MINOR): a read that drops a stale proposal says so, so the Inbox
/// row and the Ship line can be told they are now wrong.
#[test]
fn the_read_that_drops_a_stale_proposal_reports_it_once() {
    let repo = git_repo();
    let cwd = repo.path();
    let ws = cwd.join("projects/ws-1");
    let mut file = ProposalFile::default();
    file.proposal = Some(StoredProposal {
        target_content_id: Some("a content id from another file".into()),
        ..stored(1_800_000_000_000, None)
    });
    save(&ws, &file).unwrap();

    let found = current(&ws, cwd, true, 1_800_000_000_001);
    assert!(found.view.is_none());
    assert!(found.dropped, "the drop is reported");
    // And only once: the file has been forgotten, so the next read has nothing.
    let again = current(&ws, cwd, true, 1_800_000_000_002);
    assert!(again.view.is_none());
    assert!(!again.dropped);

    // A live one is returned, with no drop.
    let mut file = ProposalFile::default();
    file.proposal = Some(StoredProposal {
        target_content_id: target_content_id(cwd, ".claude/skills/deploy/SKILL.md"),
        ..stored(1_800_000_000_000, None)
    });
    save(&ws, &file).unwrap();
    let live = current(&ws, cwd, true, 1_800_000_000_001);
    assert!(!live.dropped);
    let view = live.view.expect("a live proposal");
    assert_eq!(view.label, "deploy");
    assert!(view.can_approve);
    // A read-only collaborator, and a words-only proposal, get no Approve.
    assert!(!current(&ws, cwd, false, 1_800_000_000_001).view.unwrap().can_approve);
}

#[test]
fn a_proposal_older_than_thirty_days_is_dropped() {
    let now = 1_800_000_000_000_i64;
    let fresh = stored(now - 29 * 24 * 3600 * 1000, Some("abc"));
    assert_eq!(stale_reason(&fresh, now, Some("abc")), None);
    let old = stored(now - 31 * 24 * 3600 * 1000, Some("abc"));
    assert_eq!(stale_reason(&old, now, Some("abc")), Some(StaleReason::TooOld));
    // Exactly thirty days still stands; a moment more does not.
    let edge = stored(now - MAX_AGE_MS, Some("abc"));
    assert_eq!(stale_reason(&edge, now, Some("abc")), None);
    let past = stored(now - MAX_AGE_MS - 1, Some("abc"));
    assert_eq!(stale_reason(&past, now, Some("abc")), Some(StaleReason::TooOld));
}

#[test]
fn a_proposal_whose_target_changed_since_is_dropped() {
    let now = 1_800_000_000_000_i64;
    let proposal = stored(now - 1000, Some("abc"));
    assert_eq!(stale_reason(&proposal, now, Some("abc")), None);
    assert_eq!(
        stale_reason(&proposal, now, Some("def")),
        Some(StaleReason::TargetChanged),
        "the file moved on under it"
    );
    assert_eq!(
        stale_reason(&proposal, now, None),
        Some(StaleReason::TargetChanged),
        "the target is gone"
    );
    // A words-only proposal has no content to compare, so only age drops it.
    let words_only = StoredProposal {
        target: ProposalTarget::Elsewhere {
            name: "deploy".into(),
            scope: ElsewhereScope::ThisMac,
        },
        diff: None,
        target_content_id: None,
        ..stored(now - 1000, None)
    };
    assert_eq!(stale_reason(&words_only, now, None), None);
    assert_eq!(stale_reason(&words_only, now, Some("anything")), None);
}

#[test]
fn a_content_id_follows_the_bytes() {
    assert_eq!(content_id(b"a"), content_id(b"a"));
    assert_ne!(content_id(b"a"), content_id(b"b"));
    let repo = git_repo();
    let id = target_content_id(repo.path(), ".claude/skills/deploy/SKILL.md")
        .expect("the fixture's skill is a file");
    assert_eq!(id, content_id(b"# Deploy\nPush it.\n"));
    assert_eq!(target_content_id(repo.path(), ".claude/skills/absent/SKILL.md"), None);
}

// ── Persistence (Tier 2) ─────────────────────────────────────────────

#[test]
fn the_file_round_trips_and_is_written_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("projects/ws-1");
    assert!(load(&ws).proposal.is_none(), "no file is no proposal");

    let mut file = ProposalFile::default();
    file.proposal = Some(stored(42, Some("abc")));
    remember_card(&mut file, "card-1");
    save(&ws, &file).unwrap();

    let read = load(&ws);
    assert_eq!(read.schema_version, 1);
    assert_eq!(read.proposed_cards, vec!["card-1".to_string()]);
    let proposal = read.proposal.expect("the proposal round-trips");
    assert_eq!(proposal.card_ref, "#88");
    assert_eq!(proposal.diff.as_deref(), Some(SKILL_DIFF));
    // No stray temporary file survives the write (tempfile plus rename).
    let strays: Vec<_> = std::fs::read_dir(&ws)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name != PROPOSAL_FILENAME)
        .collect();
    assert!(strays.is_empty(), "{strays:?}");
}

/// Tier 2 (PPVP): `trustStoppedCard` is additive. A file written before it
/// loads with none; with none it is not written, so the file an older
/// Plyloft reads is the one it wrote; a stop round-trips and the next Claude
/// pass that gets past the question clears it.
#[test]
fn the_trust_stopped_card_is_additive_and_cleared_by_the_next_pass_past_the_question() {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("projects/ws-1");
    std::fs::create_dir_all(&ws).unwrap();
    // Written by 1.164.0: no such field.
    let old = r##"{"schemaVersion":1,"proposal":null,"proposedCards":["card-1"]}"##;
    std::fs::write(proposal_path(&ws), old).unwrap();
    let read = load(&ws);
    assert_eq!(read.trust_stopped_card, None);
    assert_eq!(read.proposed_cards, vec!["card-1".to_string()]);
    assert_eq!(trust_stopped_card(&ws), None);

    // A pass that got past the question changes nothing on disk.
    note_trust_stop(&ws, "card-1", true, false);
    assert_eq!(std::fs::read_to_string(proposal_path(&ws)).unwrap(), old);

    // Saved with none: the key is absent.
    save(&ws, &read).unwrap();
    let text = std::fs::read_to_string(proposal_path(&ws)).unwrap();
    assert!(!text.contains("trustStoppedCard"), "{text}");

    // Stopped at the question: recorded, the rest kept.
    note_trust_stop(&ws, "card-2", true, true);
    let read = load(&ws);
    assert_eq!(read.trust_stopped_card.as_deref(), Some("card-2"));
    assert_eq!(read.proposed_cards, vec!["card-1".to_string()]);
    let text = std::fs::read_to_string(proposal_path(&ws)).unwrap();
    assert!(text.contains("trustStoppedCard") && text.contains("card-2"), "{text}");

    // Codex passing another card: still card-2's.
    note_trust_stop(&ws, "card-3", false, false);
    assert_eq!(trust_stopped_card(&ws).as_deref(), Some("card-2"));
    // Another card's Claude pass got past it: the folder is trusted, cleared.
    note_trust_stop(&ws, "card-3", true, false);
    assert_eq!(trust_stopped_card(&ws), None);
    // Any later pass of the recorded card clears it, whoever ran it.
    note_trust_stop(&ws, "card-4", true, true);
    note_trust_stop(&ws, "card-4", false, false);
    assert_eq!(trust_stopped_card(&ws), None);
}

#[test]
fn the_trust_stop_follows_the_last_pass() {
    assert_eq!(trust_stop_after(None, "a", true, true).as_deref(), Some("a"));
    assert_eq!(trust_stop_after(Some("a"), "b", true, true).as_deref(), Some("b"), "one slot: the last stop");
    assert_eq!(trust_stop_after(Some("a"), "b", true, false), None);
    assert_eq!(trust_stop_after(Some("a"), "a", false, false), None);
    assert_eq!(trust_stop_after(Some("a"), "b", false, false).as_deref(), Some("a"));
    assert_eq!(trust_stop_after(None, "b", false, false), None);
}

#[test]
fn only_claudes_trust_refusal_counts_as_stopped_at_the_trust_question() {
    let refusal = crate::claude_session::FOLDER_TRUST_REFUSAL;
    assert!(stopped_at_trust_question(refusal));
    assert!(stopped_at_trust_question(&format!("exited with status 1: {refusal}")));
    for other in [
        "timed out after 10 minutes",
        "returned no final message",
        "exited with status 1: not logged in",
        "Claude asks whether to trust",
    ] {
        assert!(!stopped_at_trust_question(other), "{other}");
    }
}

/// Tier 2 (PPVP): a file written by a Ply that knew fewer fields still loads,
/// and one written by a newer Ply is left alone rather than half-read.
#[test]
fn an_older_file_loads_and_a_newer_one_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("projects/ws-1");
    std::fs::create_dir_all(&ws).unwrap();

    // The smallest thing a v1 writer could have written: no `diff`, no
    // `targetContentId`, no `proposedCards`.
    std::fs::write(
        proposal_path(&ws),
        r##"{"schemaVersion":1,"proposal":{
             "target":{"kind":"elsewhere","name":"deploy"},
             "cardId":"card-9","cardRef":"#9",
             "reason":"After card #9.","words":"Bring a copy in.",
             "createdAt":7}}"##,
    )
    .unwrap();
    let read = load(&ws);
    let proposal = read.proposal.expect("a file with only the required fields loads");
    assert_eq!(
        proposal.target,
        ProposalTarget::Elsewhere {
            name: "deploy".into(),
            // Not in the file at all: the default is the one scope Ply may not
            // write either way.
            scope: ElsewhereScope::ThisMac,
        }
    );
    assert_eq!(proposal.diff, None);
    assert_eq!(proposal.target_blob, None);
    assert_eq!(proposal.target_content_id, None);
    // GH #104 walk (C2): a proposal written before `source` says none.
    assert_eq!(proposal.source, None);
    assert!(read.proposed_cards.is_empty());

    // A newer schema: nothing is read and nothing is written over.
    let newer = r##"{"schemaVersion":99,"proposal":null,"somethingNew":true}"##;
    std::fs::write(proposal_path(&ws), newer).unwrap();
    assert!(load(&ws).proposal.is_none());
    assert_eq!(std::fs::read_to_string(proposal_path(&ws)).unwrap(), newer);

    // Unreadable is "no proposal", never a panic and never a lost Library.
    std::fs::write(proposal_path(&ws), "{ not json").unwrap();
    assert!(load(&ws).proposal.is_none());
}

/// Review 1 (MINOR): the card is claimed before the pass starts, so `Review
/// again` during those minutes cannot start a second one; and the claim is given
/// back only when nothing started.
#[test]
fn the_card_is_claimed_before_the_pass_and_given_back_only_if_it_never_started() {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("projects/ws-1");
    assert!(claim_card(&ws, "card-1").unwrap());
    assert_eq!(load(&ws).proposed_cards, vec!["card-1".to_string()]);
    assert_eq!(
        met_friction(&FrictionInput {
            changes_requested_rounds: 5,
            already_proposed: load(&ws).proposed_cards.iter().any(|id| id == "card-1"),
            ..Default::default()
        }),
        None,
        "a second pass for the same card cannot start while the first runs"
    );
    // Claiming twice loses, and stays one entry.
    assert!(!claim_card(&ws, "card-1").unwrap());
    assert_eq!(load(&ws).proposed_cards.len(), 1);
    release_card(&ws, "card-1");
    assert!(load(&ws).proposed_cards.is_empty());
    // Releasing what was never claimed changes nothing.
    release_card(&ws, "card-1");
    assert!(load(&ws).proposed_cards.is_empty());
}

/// GH #104 review 2 (R7): two Challenger threads finishing their last review at
/// the same moment must not both start a pass. Exactly one claim wins, and a
/// claim for another card is never lost to a read that went stale.
#[test]
fn two_threads_claiming_the_same_card_produce_one_pass() {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("projects/ws-1");
    std::fs::create_dir_all(&ws).unwrap();

    let won = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = std::sync::Arc::new(std::sync::Barrier::new(8));
    let mut threads = Vec::new();
    for _ in 0..8 {
        let ws = ws.clone();
        let won = won.clone();
        let gate = gate.clone();
        threads.push(std::thread::spawn(move || {
            gate.wait();
            if claim_card(&ws, "card-1").unwrap() {
                won.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }));
    }
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(won.load(std::sync::atomic::Ordering::SeqCst), 1, "one winner");
    assert_eq!(
        load(&ws).proposed_cards,
        vec!["card-1".to_string()],
        "and one entry, not eight"
    );

    // Eight different cards racing: every claim lands.
    let gate = std::sync::Arc::new(std::sync::Barrier::new(8));
    let mut threads = Vec::new();
    for i in 0..8 {
        let ws = ws.clone();
        let gate = gate.clone();
        threads.push(std::thread::spawn(move || {
            gate.wait();
            let _ = claim_card(&ws, &format!("card-{i}")).unwrap();
        }));
    }
    for thread in threads {
        thread.join().unwrap();
    }
    let claimed = load(&ws).proposed_cards;
    for i in 0..8 {
        assert!(claimed.contains(&format!("card-{i}")), "card-{i} in {claimed:?}");
    }
}

/// Review 1 (MAJOR), walked: the member presses `Dismiss` while the pass is
/// still running. The pass must not resurrect the proposal it read at the start,
/// and must not lose the claim recorded since.
#[test]
fn a_dismiss_while_the_pass_runs_is_not_undone_by_it() {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("projects/ws-1");

    // What the pass would have read when it began.
    let mut before = ProposalFile::default();
    before.proposal = Some(stored(1, Some("abc")));
    remember_card(&mut before, "card-old");
    save(&ws, &before).unwrap();

    // The pass claims its card, then the member dismisses.
    assert!(claim_card(&ws, "card-new").unwrap());
    dismiss(&ws).unwrap();
    assert!(load(&ws).proposal.is_none());

    // The pass now answers. It re-reads and writes only the field it owns.
    let mut file = load(&ws);
    file.proposal = Some(stored(2, Some("def")));
    remember_card(&mut file, "card-new");
    save(&ws, &file).unwrap();

    let after = load(&ws);
    assert_eq!(
        after.proposal.as_ref().unwrap().created_at,
        2,
        "the pass's own proposal, not the one it read five minutes ago"
    );
    assert!(
        after.proposed_cards.contains(&"card-old".to_string())
            && after.proposed_cards.contains(&"card-new".to_string()),
        "no claim recorded meanwhile is lost: {:?}",
        after.proposed_cards
    );
}

#[test]
fn the_remembered_cards_are_capped_newest_kept() {
    let mut file = ProposalFile::default();
    for i in 0..(PROPOSED_CARDS_CAP + 10) {
        remember_card(&mut file, &format!("card-{i}"));
    }
    assert_eq!(file.proposed_cards.len(), PROPOSED_CARDS_CAP);
    assert_eq!(file.proposed_cards.last().unwrap(), &format!("card-{}", PROPOSED_CARDS_CAP + 9));
    assert!(!file.proposed_cards.contains(&"card-0".to_string()));
    // Remembering the same card twice keeps one entry.
    let before = file.proposed_cards.len();
    remember_card(&mut file, "card-42");
    remember_card(&mut file, "card-42");
    assert_eq!(file.proposed_cards.iter().filter(|id| *id == "card-42").count(), 1);
    assert!(file.proposed_cards.len() <= before + 1);
}

// ── The prompt ───────────────────────────────────────────────────────

#[test]
fn the_prompt_carries_exactly_the_cards_list_of_inputs() {
    let prompt = proposal_prompt(&PromptInput {
        card_ref: "#88",
        brief: "Add rollback tests to the deploy path.",
        verdicts: vec![
            "### changes_requested (a follow-up)\n- [P1] No rollback test (deploy.sh:12)\n  It pushes without one.\n".into(),
            "### changes_requested (the first sweep)\n- [P1] No rollback test\n".into(),
        ],
        verify_failures: vec!["verify failed: ppvp.sh failed at check #2".into()],
        library: LibraryQuote {
            quoted: vec![
                LibraryFileText { path: "AGENTS.md".into(), text: "# Atelier\nRules.".into() },
                LibraryFileText {
                    path: ".claude/skills/deploy/SKILL.md".into(),
                    text: "# Deploy\nPush it.".into(),
                },
            ],
            left_out: vec![".claude/skills/enormous/SKILL.md".into()],
        },
        friction: Some(FrictionReason::ChangesRequested(3)),
        corrections: Vec::new(),
        corrections_typed: 0,
        decisions: Vec::new(),
    });

    // The card's four inputs, each present and named.
    assert!(prompt.contains("Add rollback tests to the deploy path."), "the brief");
    assert!(prompt.contains("changes_requested (a follow-up)"), "the verdicts");
    assert!(prompt.contains("No rollback test (deploy.sh:12)"), "with their findings");
    assert!(prompt.contains("ppvp.sh failed at check #2"), "the Verify failures");
    assert!(prompt.contains("===== AGENTS.md ====="), "the instruction files");
    assert!(
        prompt.contains("===== .claude/skills/deploy/SKILL.md ====="),
        "the repository's skills"
    );
    assert!(prompt.contains("The Reviewer asked for changes 3 times"), "the friction");
    // Review 1 (NIT): a file is quoted whole, and one too long to quote is named
    // as off limits rather than quoted with a `…` no diff could match.
    assert!(prompt.contains("quoted **whole**"), "the promise the diff rests on");
    assert!(prompt.contains("may **not** propose a change to"), "and what is off limits");
    assert!(prompt.contains("- .claude/skills/enormous/SKILL.md"), "named");

    // The allow-list is stated, and the shape of the answer is fixed.
    assert!(prompt.contains(".claude/skills/"));
    assert!(prompt.contains(".agents/skills/"));
    assert!(prompt.contains("AGENTS.md` and `CLAUDE.md"));
    assert!(prompt.contains("\nNONE\n"), "NONE is offered first");
    assert!(prompt.contains("SCOPE: repository"));
    assert!(prompt.contains("TARGET: <one repository-relative path"));
    assert!(prompt.contains("REASON:"));
    assert!(prompt.contains("CHANGE:"));
    assert!(prompt.contains("```diff"));
    assert!(prompt.contains("SCOPE: personal"), "the words-only shape too");

    // The pass reads; it never writes. There is no instruction to edit a file.
    let lower = prompt.to_lowercase();
    assert!(!lower.contains("edit the file"), "the pass is read-only");
    assert!(!lower.contains("apply the change yourself"));

    // What the prompt says when there is nothing recorded.
    let bare = proposal_prompt(&PromptInput {
        card_ref: "#1",
        brief: "A card.",
        library: LibraryQuote {
            quoted: vec![LibraryFileText { path: "AGENTS.md".into(), text: "R".into() }],
            ..Default::default()
        },
        ..Default::default()
    });
    assert!(!bare.contains("may **not** propose"), "nothing left out, nothing said");
    assert!(bare.contains("No verdict was recorded."));
    assert!(bare.contains("No Verify failure was recorded on this card."));
}

#[test]
fn a_repository_with_nothing_to_change_is_told_to_answer_none() {
    let prompt = proposal_prompt(&PromptInput {
        card_ref: "#1",
        brief: "A card.",
        ..Default::default()
    });
    assert!(prompt.contains("nothing you may change"));
    assert!(prompt.contains("Answer NONE."));
}

#[test]
fn the_files_the_prompt_may_change_are_the_skills_of_both_roots_and_the_two_instruction_files() {
    let repo = git_repo();
    std::fs::create_dir_all(repo.path().join(".claude/skills/other")).unwrap();
    std::fs::write(repo.path().join(".claude/skills/other/SKILL.md"), "# Other\n").unwrap();
    // Review 1 (NIT) and review 2 (N1): a skill the repository carries only for
    // Codex is offered too — at its own path, because there is nothing to fold
    // onto and the checkout has no Claude copy to apply a diff to.
    std::fs::create_dir_all(repo.path().join(".agents/skills/codex-only")).unwrap();
    std::fs::write(repo.path().join(".agents/skills/codex-only/SKILL.md"), "# Codex\n").unwrap();
    // A name under both roots is offered once, at the Claude one, so a proposal
    // never leaves the two copies drifting.
    std::fs::create_dir_all(repo.path().join(".agents/skills/deploy")).unwrap();
    std::fs::write(repo.path().join(".agents/skills/deploy/SKILL.md"), "# Deploy\n").unwrap();
    // Never offered: not a skill, not an instruction file.
    std::fs::write(repo.path().join("README.md"), "no").unwrap();
    std::fs::create_dir_all(repo.path().join("src")).unwrap();
    std::fs::write(repo.path().join("src/main.rs"), "fn main() {}").unwrap();

    let files = library_files(repo.path());
    let paths: Vec<&str> = files.quoted.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            ".agents/skills/codex-only/SKILL.md",
            ".claude/skills/deploy/SKILL.md",
            ".claude/skills/other/SKILL.md",
            "AGENTS.md",
        ],
        "one entry per skill name, each at the path it really has: the Claude root \
         when the repository carries it there, the Codex root when that is the only copy"
    );
    assert!(files.left_out.is_empty());

    // A file longer than a single file's ceiling is left out and named, never cut.
    std::fs::create_dir_all(repo.path().join(".claude/skills/enormous")).unwrap();
    std::fs::write(
        repo.path().join(".claude/skills/enormous/SKILL.md"),
        "x".repeat(40 * 1024),
    )
    .unwrap();
    let files = library_files(repo.path());
    assert_eq!(files.left_out, vec![".claude/skills/enormous/SKILL.md".to_string()]);
    assert!(
        files.quoted.iter().all(|file| !file.text.contains('\u{2026}')),
        "nothing quoted is cut"
    );
    assert!(files.quoted.iter().all(|file| allowed_path(&file.path)));
}

// ── Approve and publish ──────────────────────────────────────────────

#[test]
fn approving_a_skill_publishes_the_branchs_copy_with_only_the_target_patched() {
    let repo = git_repo();
    let cwd = repo.path();
    let mirror = mirror_of(cwd);
    // The checkout carries an unrelated uncommitted edit and a file the branch
    // does not have. Review 1 (MAJOR): the first version published the whole
    // checkout directory, so this edit travelled and `prepare` deleted
    // `notes.md` — a branch file the checkout happens to lack.
    std::fs::write(cwd.join(".claude/skills/deploy/secret.md"), "not reviewed\n").unwrap();

    let content = target_content_id(cwd, ".claude/skills/deploy/SKILL.md").unwrap();
    let proposal = StoredProposal {
        target_content_id: Some(content),
        target_blob: Some(blob_of(cwd, ".claude/skills/deploy/SKILL.md")),
        ..stored(1, None)
    };
    let change = approve_change_with("git", &proposal, cwd, &mirror).unwrap();
    assert_eq!(change.kind, crate::shared_library_sync::ItemKind::Skill);
    assert_eq!(change.name, "deploy");
    assert_eq!(change.key(), "skill/deploy", "the queue's identity, unchanged");

    let files = change.files.expect("a skill update carries its files");
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            ".claude/skills/deploy/SKILL.md",
            ".claude/skills/deploy/notes.md",
        ],
        "the branch's own files, so `prepare` deletes none of them — and never \
the checkout's unreviewed extras"
    );
    let skill = files
        .iter()
        .find(|file| file.path == ".claude/skills/deploy/SKILL.md")
        .unwrap();
    assert_eq!(
        String::from_utf8(skill.decoded().unwrap()).unwrap(),
        "# Deploy\nCheck that a rollback test exists before pushing.\nPush it.\n",
    );
    // The checkout is untouched: the change travels on the channel.
    assert_eq!(
        std::fs::read_to_string(cwd.join(".claude/skills/deploy/SKILL.md")).unwrap(),
        "# Deploy\nPush it.\n"
    );
}

/// Review 1 (BLOCKER), walked: a teammate published a rule, this checkout is
/// behind, and the member presses `Approve and publish`. The base recorded is the
/// blob the Challenger read, not the tip's, so GH #101's `prepare` can only send
/// this into a pull request — and the bytes published are the **branch's**, so the
/// teammate's rule is carried, not deleted.
#[test]
fn a_stale_checkout_can_never_commit_over_a_teammates_rule() {
    let repo = git_repo();
    let cwd = repo.path();
    let mirror = mirror_of(cwd);
    let diff = concat!(
        "--- a/AGENTS.md\n",
        "+++ b/AGENTS.md\n",
        "@@ -1,2 +1,3 @@\n",
        " # Atelier\n",
        "+A rule the Reviewer asks for.\n",
        " Rules.\n",
    );
    let read_blob = blob_of(cwd, "AGENTS.md");
    let proposal = StoredProposal {
        target: ProposalTarget::Instructions { file: "AGENTS.md".into() },
        diff: Some(diff.into()),
        target_content_id: target_content_id(cwd, "AGENTS.md"),
        target_blob: Some(read_blob.clone()),
        ..stored(1, None)
    };

    // The teammate's rule lands on the branch — further down the file, so the
    // Challenger's hunk still fits — the mirror is rebuilt, and the checkout is
    // NOT pulled.
    std::fs::write(
        mirror.join("AGENTS.md"),
        "# Atelier\nRules.\nA teammate's rule.\n",
    )
    .unwrap();
    let branch_blob = blob_of(&mirror, "AGENTS.md");
    assert_ne!(branch_blob, read_blob, "the branch has moved under the proposal");

    let change = approve_change_with("git", &proposal, cwd, &mirror).unwrap();
    assert_eq!(change.kind, crate::shared_library_sync::ItemKind::Instructions);
    // The published bytes are the BRANCH's plus the change: the teammate's rule
    // survives.
    let files = change.files.clone().expect("the file it writes");
    assert_eq!(files.len(), 1, "a change that writes one never removes the other");
    let text = String::from_utf8(files[0].decoded().unwrap()).unwrap();
    assert!(text.contains("A teammate's rule."), "the teammate's rule is kept: {text}");
    assert!(text.contains("A rule the Reviewer asks for."), "{text}");

    // And the base is what the Challenger read, so `moved_instruction_files`
    // sees the difference and the commit becomes a pull request.
    assert_eq!(change.bases.get("AGENTS.md"), Some(&Some(read_blob)));
    assert_ne!(
        change.bases.get("AGENTS.md"),
        Some(&Some(branch_blob)),
        "never the tip's blob — that is exactly the lie that overrode somebody"
    );
    assert_eq!(std::fs::read_to_string(cwd.join("AGENTS.md")).unwrap(), "# Atelier\nRules.\n");
}

#[test]
fn approving_an_instruction_file_the_branch_still_agrees_with_records_its_own_blob() {
    let repo = git_repo();
    let cwd = repo.path();
    let mirror = mirror_of(cwd);
    let diff = concat!(
        "--- a/AGENTS.md\n",
        "+++ b/AGENTS.md\n",
        "@@ -1,2 +1,3 @@\n",
        " # Atelier\n",
        "+A rule.\n",
        " Rules.\n",
    );
    let proposal = StoredProposal {
        target: ProposalTarget::Instructions { file: "AGENTS.md".into() },
        diff: Some(diff.into()),
        target_content_id: target_content_id(cwd, "AGENTS.md"),
        target_blob: Some(blob_of(cwd, "AGENTS.md")),
        ..stored(1, None)
    };
    let change = approve_change_with("git", &proposal, cwd, &mirror).unwrap();
    assert_eq!(change.name, "AGENTS.md");
    assert_eq!(change.key(), "instructions", "GH #101's one key for the pair");
    let files = change.files.expect("the file it writes");
    assert_eq!(files[0].path, "AGENTS.md");
    assert_eq!(
        String::from_utf8(files[0].decoded().unwrap()).unwrap(),
        "# Atelier\nA rule.\nRules.\n"
    );
    // Checkout and branch agree, so the recorded base IS the tip's blob and
    // `prepare` commits directly.
    assert_eq!(
        change.bases.get("AGENTS.md"),
        Some(&Some(blob_of(&mirror, "AGENTS.md")))
    );
    // Only the file it writes is compared; the other is not in `bases` at all.
    assert_eq!(change.bases.len(), 1);
    assert_eq!(std::fs::read_to_string(cwd.join("AGENTS.md")).unwrap(), "# Atelier\nRules.\n");
}

#[test]
fn a_change_the_branchs_copy_no_longer_fits_publishes_nothing() {
    let repo = git_repo();
    let cwd = repo.path();
    let mirror = mirror_of(cwd);
    // The branch rewrote the very lines the diff quotes.
    std::fs::write(mirror.join(".claude/skills/deploy/SKILL.md"), "Something else.\n").unwrap();
    let proposal = StoredProposal {
        target_content_id: target_content_id(cwd, ".claude/skills/deploy/SKILL.md"),
        target_blob: Some(blob_of(cwd, ".claude/skills/deploy/SKILL.md")),
        ..stored(1, None)
    };
    let why = approve_change_with("git", &proposal, cwd, &mirror)
        .expect_err("it must not be published");
    assert!(why.contains("no longer fits"), "{why}");
    assert!(why.contains("Nothing was published"), "{why}");
}

/// A skill the branch has never carried: its first publish, out of the checkout —
/// and only out of a clean one (review 1, MAJOR).
#[test]
fn a_first_publish_out_of_a_dirty_skill_directory_is_refused() {
    let repo = git_repo();
    let cwd = repo.path();
    // A mirror with no copy of this skill at all.
    let mirror = cwd.join("empty-mirror");
    std::fs::create_dir_all(&mirror).unwrap();
    let proposal = StoredProposal {
        target_content_id: target_content_id(cwd, ".claude/skills/deploy/SKILL.md"),
        target_blob: Some(blob_of(cwd, ".claude/skills/deploy/SKILL.md")),
        ..stored(1, None)
    };
    // The fixture's skill is untracked, which `git status --porcelain` reports.
    let why = approve_change_with("git", &proposal, cwd, &mirror)
        .expect_err("a dirty first publish must be refused");
    assert!(why.contains("uncommitted changes"), "{why}");
    assert!(why.contains("Nothing was\npublished") || why.contains("Nothing was published"), "{why}");

    // Committed: the first publish goes, out of the checkout, because there is no
    // branch copy to take it from.
    for args in [vec!["add", "-A"], vec!["commit", "-m", "skills"]] {
        assert!(crate::platform::git_command().args(args).current_dir(cwd).status().unwrap().success());
    }
    let change = approve_change_with("git", &proposal, cwd, &mirror).unwrap();
    let files = change.files.expect("its files");
    assert!(files.iter().any(|f| f.path == ".claude/skills/deploy/SKILL.md"));

    // Round 3 (S3): the checkout's folder is "clean" to git with ignored
    // files in it. Those are left out of the first publish; a private name
    // stops it.
    std::fs::write(cwd.join(".git/info/exclude"), "config.json\n__pycache__/\n.venv/\n.env\n").unwrap();
    // Round 5 (V1): ignored private names are left out too, and stop nothing.
    std::fs::create_dir_all(cwd.join(".claude/skills/deploy/.venv/lib/certifi")).unwrap();
    std::fs::write(cwd.join(".claude/skills/deploy/.venv/lib/certifi/cacert.pem"), "cert\n").unwrap();
    std::fs::write(cwd.join(".claude/skills/deploy/.env"), "TOKEN=1\n").unwrap();
    std::fs::write(cwd.join(".claude/skills/deploy/config.json"), "{}\n").unwrap();
    std::fs::create_dir_all(cwd.join(".claude/skills/deploy/__pycache__")).unwrap();
    std::fs::write(cwd.join(".claude/skills/deploy/__pycache__/x.pyc"), "x").unwrap();
    let files = approve_change_with("git", &proposal, cwd, &mirror).unwrap().files.expect("its files");
    assert!(files.iter().any(|f| f.path == ".claude/skills/deploy/SKILL.md"));
    assert!(
        !files.iter().any(|f| {
            f.path.ends_with("config.json") || f.path.contains("__pycache__") || f.path.contains(".venv") || f.path.ends_with(".env")
        }),
        "left out"
    );
    // A private name that would travel — here committed, or the folder
    // wouldn't be clean — stops it.
    std::fs::write(cwd.join(".claude/skills/deploy/deploy.key"), "key\n").unwrap();
    for args in [vec!["add", "-f", ".claude/skills/deploy/deploy.key"], vec!["commit", "-m", "a key"]] {
        assert!(crate::platform::git_command().args(args).current_dir(cwd).status().unwrap().success());
    }
    let why = approve_change_with("git", &proposal, cwd, &mirror).expect_err("a private name stops it");
    assert!(why.starts_with("deploy holds deploy.key, which looks private, so nothing was shared."), "{why}");
}

/// The same gate fails closed: a git that cannot say whether the skill is
/// clean (here, a config it cannot parse) proves nothing, so nothing goes.
#[test]
fn a_first_publish_git_cannot_vouch_for_is_refused() {
    let repo = git_repo();
    let cwd = repo.path();
    for args in [vec!["add", "-A"], vec!["commit", "-m", "skills"]] {
        assert!(crate::platform::git_command().args(args).current_dir(cwd).status().unwrap().success());
    }
    let mirror = cwd.join("empty-mirror");
    std::fs::create_dir_all(&mirror).unwrap();
    let proposal = StoredProposal {
        target_content_id: target_content_id(cwd, ".claude/skills/deploy/SKILL.md"),
        target_blob: Some(blob_of(cwd, ".claude/skills/deploy/SKILL.md")),
        ..stored(1, None)
    };
    let config = cwd.join(".git").join("config");
    let mut broken = std::fs::read_to_string(&config).unwrap();
    broken.push_str("[core\nbroken");
    std::fs::write(&config, broken).unwrap();

    let why = approve_change_with("git", &proposal, cwd, &mirror)
        .expect_err("an unanswered git status must not publish");
    assert!(why.contains("couldn't ask git"), "{why}");
    assert!(why.contains("Nothing was published"), "{why}");
    assert!(why.contains("bad config"), "git's own words, for Details: {why}");
}

#[test]
fn approving_a_words_only_proposal_publishes_nothing() {
    let repo = git_repo();
    let proposal = StoredProposal {
        target: ProposalTarget::Elsewhere {
            name: "deploy".into(),
            scope: ElsewhereScope::ThisMac,
        },
        diff: None,
        target_content_id: None,
        ..stored(1, None)
    };
    let why = approve_change_with("git", &proposal, repo.path(), &mirror_of(repo.path()))
        .expect_err("there is nothing to publish");
    assert!(why.contains("words only"), "{why}");
}

#[test]
fn approving_a_proposal_whose_target_changed_publishes_nothing() {
    let repo = git_repo();
    let cwd = repo.path();
    let proposal = StoredProposal {
        target_content_id: Some("a content id from another file".into()),
        ..stored(1, None)
    };
    let why = approve_change_with("git", &proposal, cwd, &mirror_of(cwd))
        .expect_err("the race must be refused");
    assert!(why.contains("changed since the Reviewer read it"), "{why}");
    assert!(why.contains("Nothing was published"), "{why}");
}

// ── GH #104 walk: the human's side, the settled card, the source ─────

fn walk_card(review: Option<crate::kanban::BuilderReview>) -> crate::kanban::KanbanCard {
    let mut card = crate::kanban::KanbanCard::new(
        "c1".into(),
        "ws".into(),
        "Add a triple function".into(),
        None,
        crate::kanban::KanbanColumnId::InProgress,
    );
    let mut builder: crate::kanban::BuilderState = serde_json::from_value(serde_json::json!({
        "vendor": "claude", "startedAt": 0,
        "snapshots": [{ "n": 1, "sha": "a1", "at": 1 }, { "n": 2, "sha": "b2", "at": 2 }]
    }))
    .unwrap();
    builder.review = review;
    card.builder = Some(builder);
    card
}

fn review(status: &str, verdict: Option<&str>, note: Option<&str>) -> crate::kanban::BuilderReview {
    crate::kanban::BuilderReview {
        snapshot_n: 2,
        provider: "codex".into(),
        status: status.into(),
        verdict: verdict.map(str::to_string),
        note: note.map(str::to_string),
        at: 3,
        ..Default::default()
    }
}

/// A2: the pass runs only on a settled card — an approval, or a request for
/// changes the human overruled — and never while a decision is pending.
#[test]
fn the_pass_waits_for_a_settled_card() {
    use crate::kanban::{HandedOverRequest, ReviewStatus, WaitingReview};
    assert_eq!(card_settled(&walk_card(Some(review("done", Some("approve"), None)))), Ok(()));
    let overruled = review("skipped", None, Some("changes requested on snapshot 2, overridden by the human"));
    assert_eq!(card_settled(&walk_card(Some(overruled))), Ok(()), "the pushback accepted");

    // The walk's moment: the Challenger asked for changes, the Builder pushed
    // back, and the human had not decided yet.
    let pending = walk_card(Some(review("done", Some("changes_requested"), None)));
    assert!(card_settled(&pending).unwrap_err().contains("human's decision"));

    for (why, card) in [
        ("no review", walk_card(None)),
        ("running", walk_card(Some(review("running", None, None)))),
        ("failed", walk_card(Some(review("failed", None, None)))),
        ("a plain skip", walk_card(Some(review("skipped", None, None)))),
        ("incomplete", walk_card(Some(review("done", Some("incomplete"), None)))),
    ] {
        assert!(card_settled(&card).is_err(), "{why} is not settled");
    }

    // An approval with something else still waiting is not settled either.
    let mut waiting = walk_card(Some(review("done", Some("approve"), None)));
    waiting.builder.as_mut().unwrap().waiting_review =
        Some(WaitingReview { snapshot_n: 3, requested_at: 4 });
    assert!(card_settled(&waiting).is_err());
    let mut owed = walk_card(Some(review("done", Some("approve"), None)));
    owed.builder.as_mut().unwrap().handed_over = Some(HandedOverRequest::default());
    assert!(card_settled(&owed).is_err());
    let mut pr = walk_card(Some(review("done", Some("approve"), None)));
    pr.review_status = Some(ReviewStatus::ChangesRequested);
    assert!(card_settled(&pr).is_err(), "a request for changes still on the card");
}

/// B3: how each request ended, in words, with the last approval.
#[test]
fn the_decisions_say_how_each_request_for_changes_ended() {
    use crate::kanban::{RequestDecision, RequestOutcome};
    let mut card = walk_card(Some(review("done", Some("approve"), None)));
    let builder = card.builder.as_mut().unwrap();
    builder.remember_decision(RequestDecision {
        snapshot_n: 1,
        outcome: RequestOutcome::BuilderChanged,
        next_snapshot_n: Some(2),
        by: None,
        at: 1,
    });
    builder.remember_decision(RequestDecision {
        snapshot_n: 2,
        outcome: RequestOutcome::PushbackAccepted,
        next_snapshot_n: None,
        by: None,
        at: 2,
    });
    let lines = decision_lines(builder);
    assert_eq!(lines.len(), 3);
    assert!(lines[0].contains("snapshot 1") && lines[0].contains("changed the code (snapshot 2)"));
    assert!(lines[1].contains("accepted the Builder's pushback") && lines[1].contains("overruled"));
    assert!(lines[2].contains("approved"));
}

/// B3: the human's words go into the prompt as authoritative, with the rule
/// that a proposal never goes against them; C2: the answer names its source.
#[test]
fn the_prompt_gives_the_humans_side_and_the_none_rule() {
    let prompt = proposal_prompt(&PromptInput {
        card_ref: "“Add a triple function”",
        brief: "Add a function `triple` to math.js.",
        library: LibraryQuote {
            quoted: vec![LibraryFileText { path: "AGENTS.md".into(), text: "R".into() }],
            ..Default::default()
        },
        friction: Some(FrictionReason::UserCorrections(1)),
        corrections: vec![
            "Our convention: every new function in math.js is named with a calc prefix. Please rename it to calcTriple".into(),
        ],
        decisions: vec![
            "The Reviewer asked for changes on snapshot 2; the Builder pushed back, and the human accepted the Builder's pushback.".into(),
        ],
        ..Default::default()
    });
    let section = prompt
        .find("## What the human decided (authoritative)")
        .expect("the section is there");
    assert!(section < prompt.find("## The reviews").unwrap(), "before the reviews");
    assert!(prompt.contains("> Our convention: every new function in math.js is named with a calc prefix."));
    assert!(prompt.contains("- The Reviewer asked for changes on snapshot 2"));
    assert!(prompt.contains("must go in the direction of the human's corrections and decisions"));
    assert!(prompt.contains("would contradict a correction or a decision above, answer NONE"));
    assert!(prompt.contains("the lesson may target the instruction that would have kept you from asking"));
    assert!(prompt.contains("SOURCE: <where the lesson comes from"));

    // Nothing recorded is said, and the rule still stands.
    let bare = proposal_prompt(&PromptInput { card_ref: "#1", brief: "A card.", ..Default::default() });
    assert!(bare.contains("No correction or decision by the human was recorded"));
    assert!(bare.contains("answer NONE"));
}

#[test]
fn the_source_is_read_and_a_missing_one_is_tolerated() {
    let with = valid_answer().replace(
        "CHANGE:",
        "SOURCE: the human's correction: \"every new function in math.js is named with a calc prefix\"\nCHANGE:",
    );
    let Answer::Proposal(proposal) = parse_answer(&with) else {
        panic!("a sourced answer parses: {:?}", parse_answer(&with));
    };
    assert_eq!(
        proposal.source.as_deref(),
        Some("the human's correction: \"every new function in math.js is named with a calc prefix\"")
    );
    assert!(proposal.words.starts_with("The change asks"), "the next field is untouched");

    let Answer::Proposal(sourceless) = parse_answer(&valid_answer()) else {
        panic!("an answer without SOURCE is still a proposal");
    };
    assert_eq!(sourceless.source, None);

    // Stored and shown: it round-trips through the file.
    let dir = tempfile::tempdir().unwrap();
    let mut file = ProposalFile::default();
    let mut kept = stored(1, None);
    kept.source = Some("review round 2".into());
    file.proposal = Some(kept);
    save(dir.path(), &file).unwrap();
    assert_eq!(load(dir.path()).proposal.unwrap().source.as_deref(), Some("review round 2"));
    let view = current(dir.path(), dir.path(), true, 2).view.expect("a proposal with no content id stays current");
    assert_eq!(view.source.as_deref(), Some("review round 2"));
}

/// Challenger minor 1: corrections typed before their words were kept are
/// said as such, never as "none recorded".
#[test]
fn corrections_whose_words_were_not_kept_are_still_said() {
    let old_card = human_section(&[], 2, &[]);
    assert!(!old_card.contains("No correction or decision"), "{old_card}");
    assert!(old_card.contains("typed 2 corrections into the Builder session whose words were not kept"));
    assert!(old_card.contains("still authoritative"));
    let one = human_section(&[], 1, &[]);
    assert!(one.contains("typed one correction"));
    // All kept: nothing extra is said.
    let kept = human_section(&["use calc".into()], 1, &[]);
    assert!(!kept.contains("were not kept"));
    assert!(human_section(&[], 0, &[]).contains("No correction or decision"));
}

/// Challenger minor 2: a pushback accepted before `review_decisions` existed
/// still reads as accepted, and one recorded is not said twice.
#[test]
fn a_pushback_accepted_before_the_decisions_were_kept_is_still_said() {
    use crate::kanban::{RequestDecision, RequestOutcome};
    let overruled = review("skipped", None, Some("changes requested on snapshot 2, overridden by the human"));
    let mut card = walk_card(Some(overruled));
    let lines = decision_lines(card.builder.as_ref().unwrap());
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("snapshot 2") && lines[0].contains("accepted the Builder's pushback"));

    card.builder.as_mut().unwrap().remember_decision(RequestDecision {
        snapshot_n: 2,
        outcome: RequestOutcome::PushbackAccepted,
        next_snapshot_n: None,
        by: None,
        at: 3,
    });
    assert_eq!(decision_lines(card.builder.as_ref().unwrap()).len(), 1, "once, not twice");
    // A plain skip is no decision.
    let plain = walk_card(Some(review("skipped", None, None)));
    assert!(decision_lines(plain.builder.as_ref().unwrap()).is_empty());
}

// ── SP-5 walk: a skill in both CLIs' roots, on the shared channel ────

fn mirror_with_codex_copy(root: &Path, same: bool) -> PathBuf {
    let mirror = mirror_of(root);
    let codex = mirror.join(".agents/skills/deploy");
    std::fs::create_dir_all(&codex).unwrap();
    std::fs::write(codex.join("SKILL.md"), "# Deploy\nPush it.\n").unwrap();
    std::fs::write(codex.join("notes.md"), if same { "Branch-only notes.\n" } else { "Other.\n" })
        .unwrap();
    mirror
}

fn deploy_proposal(cwd: &Path) -> StoredProposal {
    let path = ".claude/skills/deploy/SKILL.md";
    StoredProposal {
        target_content_id: target_content_id(cwd, path),
        target_blob: Some(blob_of(cwd, path)),
        ..stored(0, Some("x"))
    }
}

#[test]
fn the_shared_change_carries_both_copies_when_they_were_the_same() {
    let repo = git_repo();
    let cwd = repo.path();
    let mirror = mirror_with_codex_copy(cwd, true);
    let proposal = deploy_proposal(cwd);

    let change = approve_change_with("git", &proposal, cwd, &mirror).unwrap();
    assert_eq!(change.paths, vec![".claude/skills/deploy".to_string(), ".agents/skills/deploy".to_string()]);
    let file = |p: &str| {
        change.files.iter().flatten().find(|f| f.path == p).unwrap_or_else(|| panic!("{p}")).decoded().unwrap()
    };
    assert_eq!(file(".claude/skills/deploy/SKILL.md"), file(".agents/skills/deploy/SKILL.md"));
    assert!(String::from_utf8(file(".agents/skills/deploy/SKILL.md")).unwrap().contains("rollback test"));
    assert_eq!(file(".agents/skills/deploy/notes.md"), b"Branch-only notes.\n");
    let approval = approve_change_full("git", &proposal, cwd, &mirror).unwrap();
    assert_eq!(
        approval.copies,
        Copies::Same { root: CLAUDE_SKILLS_ROOT, other: CODEX_SKILLS_ROOT }
    );
    assert_eq!(
        copies_note(&proposal, approval.copies, Tense::Queued).as_deref(),
        Some("Codex's copy (.agents/skills/deploy) is the same file, so it will change too.")
    );
    assert_eq!(
        copies_hint("git", &proposal, cwd, &mirror).as_deref(),
        Some("Codex's copy (.agents/skills/deploy) is the same file, so it changes too.")
    );
}

#[test]
fn the_shared_change_leaves_a_copy_that_already_differed_and_says_so() {
    let repo = git_repo();
    let cwd = repo.path();
    let mirror = mirror_with_codex_copy(cwd, false);
    let proposal = deploy_proposal(cwd);

    let change = approve_change_with("git", &proposal, cwd, &mirror).unwrap();
    assert_eq!(change.paths, vec![".claude/skills/deploy".to_string()]);
    assert!(change.files.iter().flatten().all(|f| f.path.starts_with(".claude/")));
    let approval = approve_change_full("git", &proposal, cwd, &mirror).unwrap();
    let note = copies_note(&proposal, approval.copies, Tense::Queued).expect("said");
    assert!(note.starts_with("Only Claude's copy of deploy (.claude/skills/deploy) will change."), "{note}");
    assert!(note.contains("Codex's copy (.agents/skills/deploy) is already different"), "{note}");
    let before = copies_hint("git", &proposal, cwd, &mirror).expect("said before the press");
    assert!(before.starts_with("Only Claude's copy of deploy (.claude/skills/deploy) changes."), "{before}");
}

/// Review: a first publish (the branch has no Claude copy) never takes the
/// other root from the checkout, whose Codex copy may be stale against the
/// branch's — the branch's Codex copy is left alone, and said.
#[test]
fn a_first_publish_never_claims_the_branchs_codex_copy_from_a_stale_checkout() {
    let repo = git_repo();
    let cwd = repo.path();
    // The checkout: Claude's copy (committed, clean) and an old Codex copy.
    std::fs::create_dir_all(cwd.join(".agents/skills/deploy")).unwrap();
    std::fs::write(cwd.join(".agents/skills/deploy/SKILL.md"), "# Deploy\nPush it.\n").unwrap();
    for args in [vec!["add", "."], vec!["commit", "-q", "-m", "init"]] {
        assert!(crate::platform::git_command().args(args).current_dir(cwd).status().unwrap().success());
    }
    // The branch (mirror): only a newer Codex copy, no Claude copy.
    let mirror = cwd.join("mirror");
    std::fs::create_dir_all(mirror.join(".agents/skills/deploy")).unwrap();
    std::fs::write(mirror.join(".agents/skills/deploy/SKILL.md"), "# Deploy\nPush it.\nTeammate.\n").unwrap();
    let proposal = deploy_proposal(cwd);

    let approval = approve_change_full("git", &proposal, cwd, &mirror).unwrap();
    assert_eq!(approval.change.paths, vec![".claude/skills/deploy".to_string()]);
    assert!(approval.change.files.iter().flatten().all(|f| f.path.starts_with(".claude/")));
    assert_eq!(
        approval.copies,
        Copies::Differs { root: CLAUDE_SKILLS_ROOT, other: CODEX_SKILLS_ROOT }
    );
}

/// Review: a root reached through a symlink is never compared or written.
#[cfg(unix)]
#[test]
fn a_symlinked_other_root_counts_as_absent() {
    let repo = git_repo();
    let cwd = repo.path();
    let mirror = mirror_of(cwd);
    std::fs::create_dir_all(mirror.join(".agents/skills")).unwrap();
    std::os::unix::fs::symlink(
        mirror.join(".claude/skills/deploy"),
        mirror.join(".agents/skills/deploy"),
    )
    .unwrap();
    let proposal = deploy_proposal(cwd);

    let approval = approve_change_full("git", &proposal, cwd, &mirror).unwrap();
    assert_eq!(approval.copies, Copies::One);
    assert_eq!(approval.change.paths, vec![".claude/skills/deploy".to_string()]);

    // A symlinked `.agents` itself, too.
    std::fs::remove_file(mirror.join(".agents/skills/deploy")).unwrap();
    std::fs::remove_dir_all(mirror.join(".agents")).unwrap();
    let elsewhere = cwd.join("elsewhere");
    std::fs::create_dir_all(elsewhere.join("skills/deploy")).unwrap();
    std::fs::write(elsewhere.join("skills/deploy/SKILL.md"), "# Deploy\nPush it.\n").unwrap();
    std::fs::write(elsewhere.join("skills/deploy/notes.md"), "Branch-only notes.\n").unwrap();
    std::os::unix::fs::symlink(&elsewhere, mirror.join(".agents")).unwrap();
    let approval = approve_change_full("git", &proposal, cwd, &mirror).unwrap();
    assert_eq!(approval.copies, Copies::One);
}
