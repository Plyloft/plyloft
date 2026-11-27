//! QoL block 13.1: **Ship it with a card** through the registered IPC
//! commands — the mock app and the fixture of `skill_card_ipc_tests.rs`,
//! whose child module this is.

use super::*;

fn uncommitted(fixture: &Fixture) -> Vec<String> {
    let view = invoke(fixture, "skills_hub_links", serde_json::json!({ "workspaceId": fixture.workspace_id })).unwrap();
    view["uncommitted"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()
}

fn carry(fixture: &Fixture) -> Result<serde_json::Value, serde_json::Value> {
    ask(fixture, "skills_hub_carry", serde_json::json!({}))
}

/// A skill written into the project folder (as New skill does) is listed as
/// not committed, and Ship it with a card makes a skill card carrying
/// exactly its two copies — needing no Verify, the checkout untouched. Once it lands, nothing is left to carry.
#[test]
fn a_skill_in_the_project_folder_ships_in_a_card_of_its_own() {
    let f = fixture(PlanCase::Free);
    assert!(uncommitted(&f).is_empty());
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("new"));
    write(&f.project, &format!(".agents/skills/{SKILL}/SKILL.md"), &skill_text("new"));
    write(&f.project, "notes.txt", "not part of the skill\n");
    assert_eq!(uncommitted(&f), [SKILL]);

    let card = carry(&f).unwrap();
    assert_eq!(card["title"], format!("Skill: ship {SKILL} from your project folder"));
    assert_eq!(card["kind"]["verb"], "carry");
    assert_eq!(card["columnId"], "complete");
    assert_eq!(
        changed_paths(&card),
        [format!("A\t.agents/skills/{SKILL}/SKILL.md"), format!("A\t.claude/skills/{SKILL}/SKILL.md")]
    );
    assert!(gate_passes(&f, &card), "only skill files: no Verify");
    assert!(f.project.join("notes.txt").exists(), "the checkout is never written");
    assert!(git(&f.project, &["status", "--porcelain"]).contains(".claude/"), "the folder keeps its own files");
    let again = carry(&f).unwrap_err();
    assert!(again.as_str().unwrap().contains("already on its way"), "{again}");

    // The preflight: Go before it lands, Already up to date after.
    let board = f.app.state::<crate::kanban::KanbanStore>().get_card(&f.workspace_id, card["id"].as_str().unwrap()).unwrap();
    let kind = board.skill_card().unwrap().clone();
    let tip = git(&f.project, &["rev-parse", "main"]).trim().to_string();
    let up = crate::skill_links::Upstream::Unavailable;
    assert_eq!(crate::skill_card::preflight(&f.project, &tip, "", &kind, &up, "main"), crate::skill_card::Preflight::Go);
    git(&f.project, &["clean", "-fdq", ".claude", ".agents"]);
    land(&f, &card);
    let tip = git(&f.project, &["rev-parse", "main"]).trim().to_string();
    assert_eq!(crate::skill_card::preflight(&f.project, &tip, "", &kind, &up, "main"), crate::skill_card::Preflight::UpToDate);
    assert!(uncommitted(&f).is_empty(), "{:?}", uncommitted(&f));
}

/// An edit to a committed skill is carried as the folder has it, a file
/// removed there is removed by the card, and a copy the folder doesn't
/// hold is left as the branch has it.
#[test]
fn an_edit_and_a_removal_are_carried_and_the_other_copy_left_alone() {
    let f = fixture(PlanCase::Free);
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("v1"));
    write(&f.project, &format!(".claude/skills/{SKILL}/old.md"), "old\n");
    write(&f.project, &format!(".agents/skills/{SKILL}/SKILL.md"), &skill_text("v1"));
    commit_all(&f.project, "skill");
    assert!(uncommitted(&f).is_empty());
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("edited"));
    std::fs::remove_file(f.project.join(format!(".claude/skills/{SKILL}/old.md"))).unwrap();
    std::fs::remove_dir_all(f.project.join(format!(".agents/skills/{SKILL}"))).unwrap();
    assert_eq!(uncommitted(&f), [SKILL]);
    let card = carry(&f).unwrap();
    assert_eq!(
        changed_paths(&card),
        [format!("D\t.claude/skills/{SKILL}/old.md"), format!("M\t.claude/skills/{SKILL}/SKILL.md")]
    );
    assert!(gate_passes(&f, &card));
}

/// Nothing to carry: a skill the branch already holds as it is, and a
/// skill that isn't in the folder at all.
#[test]
fn nothing_to_carry_is_refused_and_leaves_no_card() {
    let f = fixture(PlanCase::Free);
    let why = carry(&f).unwrap_err();
    assert!(why.as_str().unwrap().contains("isn't in your project folder"), "{why}");
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("v1"));
    commit_all(&f.project, "skill");
    let why = carry(&f).unwrap_err();
    assert!(why.as_str().unwrap().contains("nothing to ship"), "{why}");
    assert!(cards(&f).is_empty(), "a refused carry files no card");
}

/// Challenger (block 13): a file git ignores inside the skill is never
/// carried — an ignored `.env` and a virtualenv's `cacert.pem` among them,
/// and they don't stop the card (round 5, V1: as block 13 pinned). Round 3
/// (S3): a private name git does **not** ignore would go into the card's
/// commit, so that one stops the card.
#[test]
fn an_ignored_file_inside_the_skill_is_not_carried_and_a_private_name_that_would_be_stops_the_card() {
    let f = fixture(PlanCase::Free);
    write(&f.project, ".gitignore", ".env\n__pycache__/\n.venv/\n");
    commit_all(&f.project, "ignore");
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("new"));
    write(&f.project, &format!(".claude/skills/{SKILL}/.env"), "SECRET=1\n");
    write(&f.project, &format!(".claude/skills/{SKILL}/__pycache__/x.pyc"), "x");
    write(&f.project, &format!(".claude/skills/{SKILL}/.venv/lib/certifi/cacert.pem"), "cert\n");
    // Untracked, and no rule ignores it.
    write(&f.project, &format!(".claude/skills/{SKILL}/prod.env.key"), "SECRET=1\n");
    let why = carry(&f).unwrap_err();
    assert_eq!(
        why.as_str().unwrap(),
        format!(
            "{SKILL} holds prod.env.key, which looks private, so nothing was shared. Move it out of the skill's \
             folder, then try again. If it's committed, take it out with a commit; it stays in the history of \
             any branch that has it."
        )
    );
    assert!(cards(&f).is_empty(), "a stopped carry files no card");

    std::fs::remove_file(f.project.join(format!(".claude/skills/{SKILL}/prod.env.key"))).unwrap();
    // Round 7: the card carries nothing the gate was told is left out,
    // whatever the kept answer says when the folder is read — "no answer",
    // or a stale one that knows of nothing ignored.
    let dir = f.project.join(format!(".claude/skills/{SKILL}"));
    crate::skill_ignored::force_read_for_test(&dir, Some(None));
    let files = crate::commands::skills_hub_carry::checkout_files(&f.project, SKILL).unwrap();
    let carried: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(carried, [format!(".claude/skills/{SKILL}/SKILL.md")], "no answer kept");
    crate::skill_ignored::force_read_for_test(&dir, Some(Some(Default::default())));
    let files = crate::commands::skills_hub_carry::checkout_files(&f.project, SKILL).unwrap();
    assert_eq!(files.len(), 1, "a stale answer kept");
    crate::skill_ignored::force_read_for_test(&dir, None);

    let card = carry(&f).unwrap();
    assert_eq!(changed_paths(&card), [format!("A\t.claude/skills/{SKILL}/SKILL.md")]);
}

/// 1.175.0 G6: a name a Windows computer can't hold stops the card before
/// any copy is made; a file git ignores is not carried, so its name is not
/// checked. (Such a file can't be made on Windows to begin with.)
#[cfg(not(windows))]
#[test]
fn g6_a_skill_holding_a_name_windows_cannot_have_is_not_carried() {
    let f = fixture(PlanCase::Free);
    write(&f.project, ".gitignore", "*.tmp\n");
    commit_all(&f.project, "ignore");
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("new"));
    write(&f.project, &format!(".claude/skills/{SKILL}/what?.md"), "x");
    let why = carry(&f).unwrap_err();
    assert_eq!(
        why.as_str().unwrap(),
        format!(
            "{SKILL} holds \u{201c}what?.md\u{201d}, a name Windows can't have, so no card was made. Rename the \
             file, then try again. If it's committed, rename it with a commit."
        )
    );
    assert!(cards(&f).is_empty(), "a refused carry files no card");
    std::fs::rename(
        f.project.join(format!(".claude/skills/{SKILL}/what?.md")),
        f.project.join(format!(".claude/skills/{SKILL}/what?.tmp")),
    )
    .unwrap();
    let card = carry(&f).unwrap();
    assert_eq!(changed_paths(&card), [format!("A\t.claude/skills/{SKILL}/SKILL.md")]);
}

/// Challenger (block 13): the target holds a newer copy than the folder's
/// own last commit — the card would revert it, so it is refused with the way
/// out (Ask the Builder), and no card is filed.
#[test]
fn a_newer_copy_on_the_target_is_never_reverted() {
    let f = fixture(PlanCase::Free);
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("v1"));
    commit_all(&f.project, "v1");
    git(&f.project, &["checkout", "-q", "-b", "work"]);
    git(&f.project, &["checkout", "-q", "main"]);
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("v2 by a teammate"));
    commit_all(&f.project, "v2");
    git(&f.project, &["checkout", "-q", "work"]);
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("my edit of v1"));
    let why = carry(&f).unwrap_err();
    assert!(why.as_str().unwrap().contains("main has a newer review-rules. Ask the Builder to bring it here first"), "{why}");
    assert!(cards(&f).is_empty());
}
