//! Skills hub H5 (R12): the twins on the Library's rows, and Align by card,
//! through the registered IPC commands — the mock app and the fixture of
//! `skill_card_ipc_tests.rs`, whose child module this is.

use super::*;

fn twins_rows(fixture: &Fixture) -> Vec<serde_json::Value> {
    let view = invoke(fixture, "skills_hub_links", serde_json::json!({ "workspaceId": fixture.workspace_id })).unwrap();
    view["twins"].as_array().unwrap().clone()
}

fn both_copies(fixture: &Fixture, claude: &str, codex: &str) {
    write(&fixture.project, &format!(".claude/skills/{SKILL}/SKILL.md"), claude);
    write(&fixture.project, &format!(".agents/skills/{SKILL}/SKILL.md"), codex);
}

fn align(fixture: &Fixture, winner: Option<&str>) -> Result<serde_json::Value, serde_json::Value> {
    ask(fixture, "skills_hub_align", serde_json::json!({ "winner": winner }))
}

/// Tier 4 H5 steps 1–2, as far as code walks them: the Claude copy edited
/// alone reads *Codex copy will follow the Claude copy at the next ship*
/// and Align (no question) makes a card writing only Codex's copy; both
/// edited apart reads *Claude and Codex copies differ* and Align asks.
#[test]
fn align_follows_the_copy_that_changed_alone_and_asks_when_both_did() {
    let f = fixture(PlanCase::Free);
    both_copies(&f, &skill_text("v1"), &skill_text("v1"));
    commit_all(&f.project, "twins");
    assert!(twins_rows(&f).is_empty(), "aligned twins need no word");
    let config = f.app.state::<crate::workspace::WorkspaceStore>().config_dir.clone();
    assert!(crate::skills_hub_state::load(&config).ledger(&f.workspace_id, SKILL).is_some(), "the aligned reading is recorded");

    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("claude edit"));
    commit_all(&f.project, "claude edit");
    let rows = twins_rows(&f);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["twins"], serde_json::json!({ "state": "follows", "winner": "claude" }));
    assert_eq!(rows[0]["line"], "The Codex copy gets the Claude copy's changes when the next card ships");
    assert_eq!(rows[0]["committed"], true);
    assert_eq!(rows[0]["legacy"], false);

    let made = align(&f, None).unwrap();
    assert_eq!(made["winner"], "claude");
    let card = &made["card"];
    assert_eq!(card["title"], format!("Skill: align {SKILL} (Codex's copy follows Claude's)"));
    assert_eq!(card["kind"]["verb"], "align");
    assert_eq!(changed_paths(card), [format!("M\t.agents/skills/{SKILL}/SKILL.md")]);
    assert!(gate_passes(&f, card), "an Align card needs no Verify");
    assert_eq!(
        std::fs::read_to_string(f.project.join(format!(".agents/skills/{SKILL}/SKILL.md"))).unwrap(),
        skill_text("v1"),
        "the checkout is never written"
    );
    let again = align(&f, None).unwrap_err();
    assert!(again.as_str().unwrap().contains("already on its way"), "{again}");
    land(&f, card);
    assert!(twins_rows(&f).is_empty(), "aligned once it lands");

    both_copies(&f, &skill_text("mine"), &skill_text("theirs"));
    commit_all(&f.project, "both apart");
    let rows = twins_rows(&f);
    assert_eq!(rows[0]["twins"], serde_json::json!({ "state": "differ" }));
    assert_eq!(rows[0]["line"], "Claude and Codex copies differ");
    let why = align(&f, None).unwrap_err();
    assert!(why.as_str().unwrap().contains("Choose the copy that wins"), "{why}");
    let made = align(&f, Some("codex")).unwrap();
    assert_eq!(made["card"]["title"], format!("Skill: align {SKILL} (Claude's copy follows Codex's)"));
    assert_eq!(changed_paths(&made["card"]), [format!("M\t.claude/skills/{SKILL}/SKILL.md")]);
}

/// Tier 4 H5 step 3: one copy is one chip, never an Align.
#[test]
fn a_skill_with_one_copy_is_never_aligned() {
    let f = fixture(PlanCase::Free);
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("v1"));
    commit_all(&f.project, "claude only");
    assert!(twins_rows(&f).is_empty());
    let why = align(&f, None).unwrap_err();
    assert!(why.as_str().unwrap().contains("only one copy"), "{why}");
}

/// Tier 4 H5 step 4: a legacy `.codex/skills` copy that disagrees is said
/// on the row and never written; a difference only in the checkout is no
/// card.
#[test]
fn the_legacy_codex_root_is_said_and_never_written() {
    let f = fixture(PlanCase::Free);
    both_copies(&f, &skill_text("v1"), &skill_text("v1"));
    write(&f.project, &format!(".codex/skills/{SKILL}/SKILL.md"), &skill_text("legacy"));
    commit_all(&f.project, "with a legacy copy");
    let rows = twins_rows(&f);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["legacy"], true);
    assert_eq!(rows[0]["twins"]["state"], "aligned");
    let why = align(&f, Some("claude")).unwrap_err();
    assert!(why.as_str().unwrap().contains("are the same on"), "{why}");
    assert_eq!(std::fs::read_to_string(f.project.join(format!(".codex/skills/{SKILL}/SKILL.md"))).unwrap(), skill_text("legacy"));
    // Apart only in the checkout: said as not committed, and no card.
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("uncommitted"));
    let rows = twins_rows(&f);
    assert_eq!(rows[0]["committed"], false, "{rows:?}");
    let why = align(&f, None).unwrap_err();
    assert!(why.as_str().unwrap().contains("only in this"), "{why}");
}

/// R3 edge (H5): Keep mine waits until the twins are one skill again.
#[test]
fn keep_mine_waits_for_the_copies_to_be_aligned() {
    let f = fixture(PlanCase::Free);
    let made = install(&f, false).unwrap();
    land(&f, &made["card"]);
    write(&f.project, &format!(".agents/skills/{SKILL}/SKILL.md"), &skill_text("v1"));
    commit_all(&f.project, "codex copy too");
    assert!(twins_rows(&f).is_empty());
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("mine"));
    commit_all(&f.project, "my edit");
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v2"));
    commit_all(&f.clone, "v2");
    assert_eq!(link_state(&f), "bothChanged");
    assert_eq!(twins_rows(&f)[0]["twins"], serde_json::json!({ "state": "follows", "winner": "claude" }));
    let why = ask(&f, "skills_hub_keep_mine", serde_json::json!({})).unwrap_err();
    assert!(why.as_str().unwrap().contains("Align them first"), "{why}");
}
