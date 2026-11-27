//! GH #105: reach detection, and the plan `Make available to both` and `Align`
//! make before anything is queued.

use super::*;
use std::collections::BTreeSet;
use tempfile::TempDir;

const SKILL: &str = "---\nname: deploy\ndescription: Ships a release.\n---\nBody\n";

/// Nothing the mirror build left out — the usual case.
fn nothing_hidden() -> BTreeSet<String> {
    BTreeSet::new()
}

/// A mirror build with the skills it is given: `(side, name, SKILL.md)`.
fn build(skills: &[(Side, &str, &str)]) -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (side, name, text) in skills {
        let at = skill_dir(dir.path(), *side, name);
        std::fs::create_dir_all(&at).unwrap();
        std::fs::write(at.join("SKILL.md"), text).unwrap();
    }
    dir
}

#[test]
fn reach_is_read_from_the_two_roots_and_the_copies_are_compared() {
    let one_sided = build(&[(Side::Claude, "deploy", SKILL)]);
    assert_eq!(
        branch_reach(one_sided.path()),
        vec![BranchReach {
            name: "deploy".to_string(),
            claude: true,
            codex: false,
            differs: false,
        }]
    );

    // Both roots, the same bytes: one item, reaching both, no disagreement.
    let both = build(&[(Side::Claude, "deploy", SKILL), (Side::Codex, "deploy", SKILL)]);
    assert_eq!(
        branch_reach(both.path()),
        vec![BranchReach {
            name: "deploy".to_string(),
            claude: true,
            codex: true,
            differs: false,
        }]
    );

    // Somebody edited one of them by hand.
    let drifted = build(&[
        (Side::Claude, "deploy", SKILL),
        (Side::Codex, "deploy", &SKILL.replace("Body", "Other body")),
    ]);
    assert!(branch_reach(drifted.path())[0].differs);

    // A file that differs only in its executable bit is a different file, as it
    // is for every other copy in this app (`project_skills::copy_state`).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let modes = build(&[(Side::Claude, "deploy", SKILL), (Side::Codex, "deploy", SKILL)]);
        for side in SIDES {
            std::fs::write(skill_dir(modes.path(), side, "deploy").join("run.sh"), "#!/bin/sh\n")
                .unwrap();
        }
        assert!(!branch_reach(modes.path())[0].differs);
        std::fs::set_permissions(
            skill_dir(modes.path(), Side::Codex, "deploy").join("run.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        assert!(branch_reach(modes.path())[0].differs, "the mode is part of the file");
    }

    // A directory neither CLI would load is not a skill: its `SKILL.md` has no
    // description, so `read_skill_dir` refuses it and reach says nothing.
    let unloadable = build(&[(Side::Claude, "nameless", "---\nname: nameless\n---\n")]);
    assert_eq!(branch_reach(unloadable.path())[0].claude, false);
}

#[test]
fn a_one_sided_skill_is_carried_over_and_one_already_on_both_is_not() {
    let dir = build(&[
        (Side::Claude, "deploy", SKILL),
        (Side::Codex, "review", SKILL),
        (Side::Claude, "done", SKILL),
        (Side::Codex, "done", SKILL),
    ]);
    let names = ["deploy", "review", "done"].map(String::from).to_vec();
    let plan = plan_both(dir.path(), &names, "staging", &nothing_hidden());
    assert_eq!(
        plan.copies,
        vec![
            PlannedCopy { name: "deploy".to_string(), from: Side::Claude, replace: false },
            PlannedCopy { name: "review".to_string(), from: Side::Codex, replace: false },
        ],
        "each is carried from the side that has it",
    );
    assert_eq!(plan.already, vec!["done".to_string()]);
    assert!(plan.skipped.is_empty(), "{:?}", plan.skipped);
}

#[test]
fn a_skill_that_cannot_be_carried_over_is_skipped_with_its_reason_and_the_rest_travel() {
    let dir = build(&[
        (Side::Claude, "deploy", SKILL),
        // Two copies that disagree: Ply does not choose between somebody's two
        // versions — that is what Align asks.
        (Side::Claude, "drifted", SKILL),
        (Side::Codex, "drifted", &SKILL.replace("Body", "Other")),
        // A directory neither CLI loads: copying it would put a file no session
        // reads into the other root.
        (Side::Claude, "nameless", "---\nname: nameless\n---\n"),
    ]);
    let names = ["deploy", "drifted", "nameless", "absent", "../escape"]
        .map(String::from)
        .to_vec();
    let plan = plan_both(dir.path(), &names, "staging", &nothing_hidden());
    assert_eq!(
        plan.copies,
        vec![PlannedCopy { name: "deploy".to_string(), from: Side::Claude, replace: false }],
        "one bad skill never stops the good ones",
    );
    let skipped: Vec<(&str, &str)> = plan
        .skipped
        .iter()
        .map(|s| (s.name.as_str(), s.reason.as_str()))
        .collect();
    assert_eq!(skipped.len(), 4, "{skipped:?}");
    assert!(skipped[0].1.contains("not the same file"), "{:?}", skipped[0]);
    assert!(skipped[0].1.contains("staging"), "the branch is named: {:?}", skipped[0]);
    // Review 1, MINOR: a copy that is **there** and that no CLI loads is not "not
    // on the branch yet" — it is a fault in that copy, and the skip says which
    // one, in the loader's own words.
    assert_eq!(skipped[1].0, "nameless");
    assert!(
        skipped[1].1.contains("Claude's copy of `nameless` is on staging and neither CLI loads it")
            && skipped[1].1.contains("has no description in its frontmatter"),
        "{:?}",
        skipped[1],
    );
    assert!(!skipped[1].1.contains("is not on staging yet"), "{:?}", skipped[1]);
    // …and a name the branch really does not carry says exactly that.
    assert_eq!(skipped[2].0, "absent");
    assert!(skipped[2].1.contains("is not on staging yet"), "{:?}", skipped[2]);
    assert!(skipped[3].1.contains("plain directory name"), "{:?}", skipped[3]);
}

/// Review 1, MAJOR: a Codex copy that **exists** on the branch is never written
/// over, whether the mirror can show it or not.
#[test]
fn a_destination_that_exists_is_never_written_over() {
    // The mirror hides a root whose copy holds a symlink (`build_mirror` leaves
    // the whole skill out and records it), so the plan is told by the manifest.
    let hidden_dir = build(&[(Side::Claude, "deploy", SKILL)]);
    let hidden: BTreeSet<String> = [".agents/skills/deploy".to_string()].into_iter().collect();
    let plan = plan_both(hidden_dir.path(), &["deploy".to_string()], "staging", &hidden);
    assert!(plan.copies.is_empty(), "{:?}", plan.copies);
    assert!(
        plan.skipped[0].reason.contains("holds a symlink")
            && plan.skipped[0].reason.contains("Nothing was written over it"),
        "{:?}",
        plan.skipped,
    );

    // A Codex copy that is there and that no CLI loads: present, not missing.
    let unloadable = build(&[
        (Side::Claude, "deploy", SKILL),
        (Side::Codex, "deploy", "---\nname: deploy\n---\n"),
    ]);
    assert_eq!(
        side_state(unloadable.path(), Side::Codex, "deploy"),
        SideState::Unloadable(
            "skill `deploy` has no description in its frontmatter, so neither CLI loads it"
                .to_string()
        ),
    );
    let plan = plan_both(unloadable.path(), &["deploy".to_string()], "staging", &nothing_hidden());
    assert!(plan.copies.is_empty(), "{:?}", plan.copies);
    assert!(
        plan.skipped[0].reason.contains("Codex's copy of `deploy` is already on staging")
            && plan.skipped[0].reason.contains("Nothing was written over it"),
        "{:?}",
        plan.skipped,
    );
}

/// Review 1, BLOCKER: a copy is an **instruction**, and it claims only the root
/// it creates. The bytes are read on the tip when the commit is built, so nothing
/// a teammate pushed to the source root can be carried away with it.
#[test]
fn a_copy_claims_the_destination_root_and_never_the_source() {
    for (from, to) in [
        (Side::Claude, ".agents/skills/deploy"),
        (Side::Codex, ".claude/skills/deploy"),
    ] {
        let copy = PlannedCopy { name: "deploy".to_string(), from, replace: false };
        let instruction = copy.instruction();
        assert_eq!(instruction.from, format!("{}/deploy", from.root()));
        assert_eq!(instruction.to, to);
        assert!(!instruction.replace);

        let change = one_change(&copy, "t".to_string(), "m".to_string());
        assert_eq!(change.claimed(), vec![to.to_string()], "the destination only");
        assert!(
            change.files.is_none(),
            "no bytes travel: the source is read on the tip the commit is built on",
        );
        assert_eq!(change.copies, vec![instruction]);
    }

    // An Align is the one copy that may replace what is there, because the member
    // chose which of the two wins.
    let align = PlannedCopy { name: "deploy".to_string(), from: Side::Claude, replace: true };
    assert!(align.instruction().replace);
    assert_eq!(align.instruction().to, ".agents/skills/deploy");
}

#[cfg(unix)]
#[test]
fn a_symlink_in_the_source_is_refused_rather_than_copied() {
    let dir = build(&[(Side::Claude, "deploy", SKILL)]);
    std::os::unix::fs::symlink(
        "/etc/hosts",
        skill_dir(dir.path(), Side::Claude, "deploy").join("hosts"),
    )
    .unwrap();
    let plan = plan_both(dir.path(), &["deploy".to_string()], "staging", &nothing_hidden());
    assert!(plan.copies.is_empty(), "{:?}", plan.copies);
    assert!(plan.skipped[0].reason.contains("symlink"), "{:?}", plan.skipped);
}

#[test]
fn align_carries_the_side_that_wins_and_refuses_one_that_is_not_there() {
    let dir = build(&[
        (Side::Claude, "deploy", SKILL),
        (Side::Codex, "deploy", &SKILL.replace("Body", "Other")),
    ]);
    for winner in SIDES {
        let copy = plan_align(dir.path(), "deploy", winner, "staging").unwrap();
        assert_eq!(copy.from, winner);
        assert!(copy.replace, "the member chose this copy over the one that is there");
        // Only the loser's root is written, and it is the loser's that is claimed.
        let instruction = copy.instruction();
        assert_eq!(instruction.from, format!("{}/deploy", winner.root()));
        assert_ne!(instruction.to, instruction.from);
        let (title, message) = align_words(&copy);
        assert_eq!(title, "deploy aligned for Claude and Codex");
        assert_eq!(
            message,
            format!("skill: deploy aligned for Claude and Codex ({}'s copy wins)", winner.cli()),
        );
    }

    let one_sided = build(&[(Side::Claude, "deploy", SKILL)]);
    let refused = plan_align(one_sided.path(), "deploy", Side::Codex, "staging").unwrap_err();
    assert!(refused.contains("Codex's copy"), "{refused}");
    assert!(
        plan_align(one_sided.path(), "../escape", Side::Claude, "staging").is_err(),
        "the name is still one plain component",
    );
}

#[test]
fn the_words_say_how_many_and_keep_the_channels_style() {
    let one = [PlannedCopy { name: "deploy".to_string(), from: Side::Claude, replace: false }];
    assert_eq!(
        both_words(&one),
        (
            "deploy for Claude and Codex".to_string(),
            "skill: deploy for Claude and Codex".to_string()
        )
    );
    let many: Vec<PlannedCopy> = ["a", "b", "c"]
        .iter()
        .map(|name| PlannedCopy { name: name.to_string(), from: Side::Claude, replace: false })
        .collect();
    assert_eq!(
        both_words(&many),
        (
            "3 skills for Claude and Codex".to_string(),
            "skills: 3 for Claude and Codex".to_string()
        )
    );
}

#[test]
fn a_group_change_is_keyed_apart_from_every_skills_own_change() {
    let _dir = build(&[(Side::Claude, "a", SKILL), (Side::Claude, "b", SKILL)]);
    let copies: Vec<PlannedCopy> = ["a", "b"]
        .iter()
        .map(|name| PlannedCopy { name: name.to_string(), from: Side::Claude, replace: false })
        .collect();
    let (title, message) = both_words(&copies);
    let group = group_change(&copies, title, message).unwrap();
    assert!(group.key().starts_with("skills/"), "{}", group.key());
    assert_ne!(group.key(), ItemKind::Skill.key("a"));
    assert_eq!(group.names(), vec!["a".to_string(), "b".to_string()]);
    assert_eq!(
        group.claimed(),
        vec![".agents/skills/a".to_string(), ".agents/skills/b".to_string()],
        "only the roots this commit creates — never a source root (review 1)",
    );
    assert!(group.files.is_none());
    assert_eq!(group.copies.len(), 2);

    // One copy travels as that skill's own item, so it replaces whatever else
    // was queued for it.
    let single = one_change(
        &copies[0],
        "a for Claude and Codex".to_string(),
        "skill: a for Claude and Codex".to_string(),
    );
    assert_eq!(single.key(), ItemKind::Skill.key("a"));
    assert_eq!(single.claimed(), vec![".agents/skills/a".to_string()]);
}
