//! Skills hub H3a: Install, Update, the links view and Compare through their
//! registered IPC commands, on a mock app with a real team clone and a real
//! workspace repository (no network: the clone has no remote, so its pull
//! fails and is advisory, as offline).

use std::path::{Path, PathBuf};

use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::webview::InvokeRequest;
use tauri::Manager;

use crate::license::PlanCase;

// Skills hub H5: the twins and Align, on this fixture.
#[path = "skill_card_ipc_twins_tests.rs"]
mod twins;
// QoL 13.1: Ship it with a card, on this fixture.
#[path = "skill_card_ipc_carry_tests.rs"]
mod carry;

const SKILL: &str = "review-rules";

struct Fixture {
    _temp: tempfile::TempDir,
    app: tauri::App<MockRuntime>,
    webview: tauri::WebviewWindow<MockRuntime>,
    project: PathBuf,
    clone: PathBuf,
    workspace_id: String,
}

fn git(dir: &Path, args: &[&str]) -> String {
    crate::git::capture(dir, args).unwrap_or_else(|e| panic!("git {args:?} in {}: {e}", dir.display()))
}

fn init(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.email", "t@t"],
        &["config", "user.name", "t"],
        &["config", "core.autocrlf", "false"],
    ] {
        git(dir, args);
    }
}

fn write(dir: &Path, path: &str, text: &str) {
    let file = dir.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

fn commit_all(dir: &Path, message: &str) {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
}

fn skill_text(version: &str) -> String {
    format!("---\nname: {SKILL}\ndescription: Review rules, {version}.\n---\n\nRead the diff.\n")
}

fn fixture(policy: PlanCase) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    init(&project);
    write(&project, "README.md", "app\n");
    commit_all(&project, "init");

    let clone = config.join("team").join(crate::team::slug_dir_name("acme/team"));
    init(&clone);
    write(&clone, "library/claude/acme/.claude-plugin/plugin.json", "{\"name\":\"acme\"}\n");
    write(&clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v1"));
    commit_all(&clone, "v1");

    let workspaces = crate::workspace::WorkspaceStore::new(config.clone()).unwrap();
    let workspace = workspaces
        .create("Skill cards".into(), project.to_string_lossy().into_owned())
        .unwrap();
    let settings = crate::settings::SettingsStore::new(config.clone()).unwrap();
    settings.set_team_repo(Some("acme/team".into())).unwrap();
    let app = mock_builder()
        .manage(workspaces)
        .manage(crate::kanban::KanbanStore::new(config.clone()).unwrap())
        .manage(settings)
        .manage(crate::license::LicenseStore::for_plan_test(config.clone(), policy))
        .manage(crate::team::TeamStore::new(config.clone()))
        .manage(crate::project_config::ProjectConfigStore::new(config.clone()).unwrap())
        .invoke_handler(tauri::generate_handler![
            crate::commands::skills_hub_install,
            crate::commands::skills_hub_update,
            crate::commands::skills_hub_links,
            crate::commands::skills_hub_compare,
            crate::commands::skills_hub_link,
            crate::commands::skills_hub_card_refresh,
            crate::commands::skills_hub_card_behind,
            crate::commands::skills_hub_decisions::skills_hub_compare3,
            crate::commands::skills_hub_decisions::skills_hub_keep_mine,
            crate::commands::skills_hub_decisions::skills_hub_propose_upstream,
            crate::commands::skills_hub_decisions::skills_hub_removed_choice,
            crate::commands::skills_hub_decisions::skills_hub_renamed_choice,
            crate::commands::skills_hub_twins::skills_hub_align,
            crate::commands::skills_hub_carry::skills_hub_carry,
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    Fixture { _temp: temp, app, webview, project, clone, workspace_id: workspace.id }
}

fn invoke(fixture: &Fixture, command: &str, body: serde_json::Value) -> Result<serde_json::Value, serde_json::Value> {
    get_ipc_response(
        &fixture.webview,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::test_env::local_invoke_url(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .map(|response| match response {
        InvokeResponseBody::Json(json) => serde_json::from_str(&json).unwrap(),
        InvokeResponseBody::Raw(_) => panic!("{command}: raw response"),
    })
}

fn install(fixture: &Fixture, replace: bool) -> Result<serde_json::Value, serde_json::Value> {
    invoke(
        fixture,
        "skills_hub_install",
        serde_json::json!({ "workspaceId": fixture.workspace_id, "plugin": "acme", "skill": SKILL, "replace": replace }),
    )
}

fn link_state(fixture: &Fixture) -> String {
    let view = invoke(fixture, "skills_hub_links", serde_json::json!({ "workspaceId": fixture.workspace_id })).unwrap();
    let rows = view["links"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{view}");
    rows[0]["state"].as_str().unwrap().to_string()
}

/// Ship's local merge, as far as these tests need it: the card's branch
/// lands on main in the checkout.
fn land(fixture: &Fixture, card: &serde_json::Value) {
    let branch = card["branchName"].as_str().unwrap();
    git(&fixture.project, &["merge", "--ff-only", "-q", branch]);
    fixture
        .app
        .state::<crate::kanban::KanbanStore>()
        .with_card(&fixture.workspace_id, card["id"].as_str().unwrap(), |c| {
            c.ship_status = crate::kanban::ShipStatus::Shipped;
            Ok(())
        })
        .unwrap();
}

fn cards(fixture: &Fixture) -> Vec<crate::kanban::KanbanCard> {
    fixture.app.state::<crate::kanban::KanbanStore>().load(&fixture.workspace_id).unwrap()
}

/// Tier 4 steps 1–2 and 7, as far as code can walk them: Install on Free
/// makes a skill card at Ship with exactly the copies and the link record
/// and leaves the checkout alone; once it lands, the row is linked and up
/// to date.
#[test]
fn install_on_free_makes_a_skill_card_at_ship() {
    let f = fixture(PlanCase::Free);
    let made = install(&f, false).unwrap();
    assert_eq!(made["kind"], "card", "{made}");
    let card = &made["card"];
    assert_eq!(card["title"], format!("Skill: install {SKILL} from the team library"));
    assert_eq!(card["columnId"], "complete");
    assert_eq!(card["kind"]["type"], "skill");
    assert_eq!(card["verifyStatus"], "passed");
    assert!(!f.project.join(".claude/skills").exists(), "the checkout is never written");
    let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
    let changed = git(&wt, &["diff", "--name-only", "HEAD~1", "HEAD"]);
    let mut changed: Vec<&str> = changed.lines().collect();
    changed.sort();
    // Challenger (R2 edge): the fixture's library has only a Claude half, so
    // only the Claude copy is written.
    assert_eq!(
        changed,
        [
            ".atelier/skill-links/review-rules.json",
            ".claude/skills/review-rules/SKILL.md",
        ]
    );
    // One card per skill per workspace.
    let again = install(&f, false).unwrap_err();
    assert!(again.as_str().unwrap().contains("already on its way"), "{again}");
    land(&f, card);
    assert_eq!(link_state(&f), "upToDate");
    // Linked already: Install is not offered twice.
    let twice = install(&f, false).unwrap_err();
    assert!(twice.as_str().unwrap().contains("already linked"), "{twice}");
}

/// Tier 4 steps 3, 4 and 7: an upstream change reads as Update available;
/// Update, on every plan, is a card whose diff is upstream − here, and its
/// base advances once it lands.
#[test]
fn an_upstream_change_offers_update_on_every_plan() {
    for policy in [PlanCase::Free, PlanCase::Pro] {
        let f = fixture(policy);
        let made = install(&f, false).unwrap();
        land(&f, &made["card"]);
        write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v2"));
        commit_all(&f.clone, "v2");
        assert_eq!(link_state(&f), "updateAvailable");
        let compare = invoke(&f, "skills_hub_compare", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap();
        assert!(compare["left"]["text"].as_str().unwrap().contains("v1"), "{compare}");
        assert!(compare["right"]["text"].as_str().unwrap().contains("v2"), "{compare}");
        let updated = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL }));
        let card = updated.unwrap_or_else(|why| panic!("{policy:?}: {why}"));
        assert_eq!(card["title"], format!("Skill: update {SKILL} from the team library"));
        let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
        let diff = git(&wt, &["diff", "HEAD~1", "HEAD", "--", ".claude/skills"]);
        assert!(diff.contains("-description: Review rules, v1.") && diff.contains("+description: Review rules, v2."), "{diff}");
        land(&f, &card);
        assert_eq!(link_state(&f), "upToDate", "the base advanced");
    }
}

/// Tier 4 6b: a linked copy edited here is Modified here — Update is
/// refused even with the origin moved on, and Compare is 2-way (linked
/// version → here).
#[test]
fn a_copy_modified_here_is_never_updated_over() {
    let f = fixture(PlanCase::Free);
    let made = install(&f, false).unwrap();
    land(&f, &made["card"]);
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("mine"));
    commit_all(&f.project, "my edit");
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v2"));
    commit_all(&f.clone, "v2");
    // H4: an edit here and a change upstream is *Both changed*.
    assert_eq!(link_state(&f), "bothChanged");
    let why = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap_err();
    assert!(why.as_str().unwrap().contains("overwrite"), "{why}");
    let compare = invoke(&f, "skills_hub_compare", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap();
    assert!(compare["left"]["text"].as_str().unwrap().contains("v1"), "base on the left: {compare}");
    assert!(compare["right"]["text"].as_str().unwrap().contains("mine"), "here on the right: {compare}");
}

fn has_commit_code(text: &str) -> bool {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|word| word.len() >= 7 && word.chars().all(|c| c.is_ascii_hexdigit()) && word.chars().any(|c| c.is_ascii_digit()))
}

/// H4 Mac walk: the 2-way Compare lists every file that differs with whose
/// change it is ("only you" here), and its headings carry no commit code.
#[test]
fn the_two_way_compare_lists_whose_change_each_file_is() {
    let f = fixture(PlanCase::Free);
    let made = install(&f, false).unwrap();
    land(&f, &made["card"]);
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("mine"));
    write(&f.project, &format!(".claude/skills/{SKILL}/notes.md"), "mine\n");
    commit_all(&f.project, "my edit");
    let compare = invoke(&f, "skills_hub_compare", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap();
    let files: Vec<(String, String)> = compare["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["path"].as_str().unwrap().to_string(), f["status"].as_str().unwrap().to_string()))
        .collect();
    assert_eq!(files, [("SKILL.md".to_string(), "here".to_string()), ("notes.md".to_string(), "here".to_string())]);
    assert_eq!(compare["files"][1]["right"], "mine\n");
    for side in ["left", "right"] {
        let head = format!("{} {}", compare[side]["label"], compare[side]["meaning"]);
        assert!(!has_commit_code(&head), "{head}");
    }
    assert_eq!(compare["left"]["label"], "The team library when linked");
}

/// H4 Mac walk phases 7–8: after this repository's proposal merged, the
/// copy is up to date by itself — and the team's next change is an Update,
/// never *Both changed* over the proposed lines.
#[test]
fn a_merged_proposal_is_the_starting_point_for_the_next_change() {
    let f = fixture(PlanCase::Free);
    let made = install(&f, false).unwrap();
    land(&f, &made["card"]);
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("mine"));
    commit_all(&f.project, "my edit");
    assert_eq!(link_state(&f), "modifiedHere");
    // The team merges it.
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("mine"));
    commit_all(&f.clone, "merge the proposal");
    assert_eq!(link_state(&f), "upToDate");
    assert_eq!(links_row(&f)["modifiedHere"], false);
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v3"));
    commit_all(&f.clone, "v3");
    assert_eq!(link_state(&f), "updateAvailable", "not both changed");
    let card = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap();
    assert_eq!(card["title"], format!("Skill: update {SKILL} from the team library"));
    land(&f, &card);
    assert_eq!(link_state(&f), "upToDate");
}

/// H4 Windows walk: on a checkout with `core.autocrlf=true` (CRLF in the
/// files), a proposal merged and then **edited here again** before the
/// team's next change: the 3-way's Before must be the merged version (it
/// was still the one from before, so the proposed line counted on both
/// sides). The start comes from what this repository's history held.
#[test]
fn a_merged_proposal_edited_again_keeps_its_start_on_a_crlf_checkout() {
    let f = fixture(PlanCase::Free);
    git(&f.project, &["config", "core.autocrlf", "true"]);
    let made = install(&f, false).unwrap();
    land(&f, &made["card"]);
    let crlf = |text: String| text.replace('\n', "\r\n");
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &crlf(skill_text("mine")));
    commit_all(&f.project, "my edit, proposed");
    // The team merges it (LF, as a pull request writes it).
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("mine"));
    commit_all(&f.clone, "merge the proposal");
    assert_eq!(link_state(&f), "upToDate");
    // The team changes another line; this repository edits again.
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("mine").replace("Read the diff.", "Read the whole diff."));
    commit_all(&f.clone, "v3");
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &crlf(skill_text("mine, again")));
    assert_eq!(link_state(&f), "bothChanged");
    let compare = ask(&f, "skills_hub_compare3", serde_json::json!({})).unwrap();
    let skill_md = compare["files"].as_array().unwrap().iter().find(|f| f["path"] == "SKILL.md").unwrap().clone();
    assert!(skill_md["base"].as_str().unwrap().contains("Review rules, mine."), "Before is the merged version: {skill_md}");
    assert_eq!(compare["baseLabel"], "The team library when this copy last matched it");
}

/// Challenger (R2 edge): a team skill both CLIs load gets both copies; one
/// only Claude loads gets only Claude's, and its link records only that twin.
#[test]
fn install_writes_the_copies_of_the_clis_the_skill_reaches() {
    let f = fixture(PlanCase::Free);
    crate::team_skills::ensure_ply_plugin(&f.clone, "acme").unwrap();
    write(&f.clone, &format!("library/codex/plugins/acme/skills/{SKILL}/SKILL.md"), &skill_text("v1"));
    commit_all(&f.clone, "codex half");
    let made = install(&f, false).unwrap();
    let wt = PathBuf::from(made["card"]["worktreePath"].as_str().unwrap());
    let changed = git(&wt, &["diff", "--name-only", "HEAD~1", "HEAD"]);
    assert!(changed.contains(".agents/skills/review-rules/SKILL.md"), "{changed}");
    assert!(changed.contains(".claude/skills/review-rules/SKILL.md"), "{changed}");
    let notes = made["card"]["notes"].as_str().unwrap();
    assert!(notes.contains("in Claude and Codex"), "{notes}");

    let only = fixture(PlanCase::Free);
    let made = install(&only, false).unwrap();
    let wt = PathBuf::from(made["card"]["worktreePath"].as_str().unwrap());
    let link = crate::skill_links::parse(&std::fs::read(wt.join(".atelier/skill-links/review-rules.json")).unwrap()).unwrap();
    assert!(link.base.claude.is_some() && link.base.codex.is_none(), "{link:?}");
    let notes = made["card"]["notes"].as_str().unwrap();
    assert!(notes.contains("in Claude, from") && !notes.contains(".agents/"), "{notes}");
    assert_eq!(made["card"]["kind"]["content"].get("codex"), None, "{}", made["card"]["kind"]);
    land(&only, &made["card"]);
    assert_eq!(link_state(&only), "upToDate");
}

/// Challenger: Update writes a copy here the link never recorded only when
/// it is the linked version (twins kept in step); a different one is never
/// written over.
#[test]
fn update_never_writes_over_an_unrecorded_copy_that_differs() {
    let f = fixture(PlanCase::Free);
    let made = install(&f, false).unwrap();
    land(&f, &made["card"]);
    write(&f.project, &format!(".agents/skills/{SKILL}/SKILL.md"), "a Codex copy of my own\n");
    commit_all(&f.project, "own codex copy");
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v2"));
    commit_all(&f.clone, "v2");
    assert_eq!(link_state(&f), "updateAvailable");
    let why = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap_err();
    assert!(why.as_str().unwrap().contains(".agents/skills/review-rules") && why.as_str().unwrap().contains("overwrite"), "{why}");
    // The same copy as the linked version: the update carries both.
    write(&f.project, &format!(".agents/skills/{SKILL}/SKILL.md"), &skill_text("v1"));
    commit_all(&f.project, "made available to both");
    let card = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap();
    let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
    let diff = git(&wt, &["diff", "--name-only", "HEAD~1", "HEAD"]);
    assert!(diff.contains(".agents/skills/review-rules/SKILL.md") && diff.contains(".claude/skills/review-rules/SKILL.md"), "{diff}");
    land(&f, &card);
    assert_eq!(link_state(&f), "upToDate");
}

/// Challenger (§5.1): a link record a newer Plyloft wrote (or a damaged
/// one) is never written over by Install or Update; the member hears why
/// and no card is made.
#[test]
fn a_link_record_this_build_cannot_read_is_never_written_over() {
    let f = fixture(PlanCase::Free);
    write(
        &f.project,
        ".atelier/skill-links/review-rules.json",
        "{\"schemaVersion\": 2, \"origin\": {\"kind\": \"team\"}, \"future\": true}\n",
    );
    commit_all(&f.project, "a newer link");
    let why = install(&f, true).unwrap_err();
    assert!(why.to_string().contains("can't be read") && why.to_string().contains("newer Plyloft"), "{why}");
    let why = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap_err();
    assert!(why.as_str().unwrap().contains("can't be read"), "{why}");
    assert!(cards(&f).is_empty(), "no card was made");
}

/// R2 edge: a different, unlinked copy of the same name is not replaced
/// unless the member chose *Link and update*.
#[test]
fn a_different_unlinked_copy_asks_before_it_is_replaced() {
    let f = fixture(PlanCase::Free);
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), "someone else's\n");
    commit_all(&f.project, "own copy");
    let refused = install(&f, false).unwrap_err();
    assert!(refused.get("notTheSameSkill").is_some() || refused.to_string().contains("not the same skill"), "{refused}");
    let made = install(&f, true).unwrap();
    assert_eq!(made["kind"], "card");
    land(&f, &made["card"]);
    assert_eq!(link_state(&f), "upToDate");
}

// ── Skills hub H3b: migration of unlinked copies (R-M) ────────────────

fn view(fixture: &Fixture) -> serde_json::Value {
    invoke(fixture, "skills_hub_links", serde_json::json!({ "workspaceId": fixture.workspace_id })).unwrap()
}

fn link(fixture: &Fixture, skills: &[&str]) -> Result<serde_json::Value, serde_json::Value> {
    invoke(fixture, "skills_hub_link", serde_json::json!({ "workspaceId": fixture.workspace_id, "skills": skills }))
}

/// What 1.165.0's untracked Install left once the member committed it:
/// `name`'s two copies with `text`, no link record.
fn old_install(fixture: &Fixture, name: &str, text: &str) {
    for root in [".claude/skills", ".agents/skills"] {
        write(&fixture.project, &format!("{root}/{name}/SKILL.md"), text);
    }
}

const OTHER: &str = "---\nname: other\ndescription: Other.\n---\n\nOther.\n";

/// Tier 4 step 6, as far as code can walk it: a 1.165.0 copy equal to the
/// team's version now, and one equal to an older version, are offered Link;
/// Link all makes one card on Free whose commit writes the two link records
/// and nothing else; once it lands, one is up to date and the other has an
/// update, and Compare works from the right base.
#[test]
fn link_all_links_old_installs_at_the_version_they_are_in_one_card() {
    let f = fixture(PlanCase::Free);
    // A second team skill, then a newer review-rules: `other` stays as it
    // is, review-rules moves on to v2.
    write(&f.clone, "library/claude/acme/skills/other/SKILL.md", OTHER);
    commit_all(&f.clone, "other");
    old_install(&f, SKILL, &skill_text("v1"));
    old_install(&f, "other", OTHER);
    commit_all(&f.project, "1.165.0 installs");
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v2"));
    commit_all(&f.clone, "v2");

    let shown = view(&f);
    let offers = shown["offers"].as_array().unwrap();
    assert_eq!(offers.len(), 2, "{shown}");
    let offer = |name: &str| offers.iter().find(|o| o["skill"] == name).unwrap().clone();
    assert_eq!(offer(SKILL)["current"], false, "{shown}");
    assert_eq!(offer("other")["current"], true, "{shown}");
    assert!(offers.iter().all(|o| o["committed"] == true && o["plugin"] == "acme"), "{shown}");

    let made = link(&f, &[SKILL, "other"]).unwrap();
    assert!(made["skipped"].as_array().unwrap().is_empty(), "{made}");
    let card = &made["card"];
    assert_eq!(card["title"], "Skill: link 2 skills to the team library");
    assert_eq!(card["kind"]["verb"], "link");
    // review-rules is linked at v1 while the team has v2: a Link card is
    // still never "behind", so it never offers Refresh.
    assert_eq!(card_call(&f, "skills_hub_card_behind", card).unwrap()["behind"], false);
    assert!(card_call(&f, "skills_hub_card_refresh", card).unwrap_err().as_str().unwrap().contains("nothing to refresh"));
    assert_eq!(card["kind"]["links"].as_array().unwrap().len(), 2);
    assert_eq!(card["verifyStatus"], "passed");
    assert_eq!(card["columnId"], "complete");
    let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
    let changed = git(&wt, &["diff", "--name-only", "HEAD~1", "HEAD"]);
    let mut changed: Vec<&str> = changed.lines().collect();
    changed.sort();
    assert_eq!(changed, [".atelier/skill-links/other.json", ".atelier/skill-links/review-rules.json"], "link records only");
    // One card per skill: a second Link names the card on its way, and so
    // does an Install or Update of a skill it carries.
    let again = link(&f, &[SKILL]).unwrap_err();
    assert!(again.as_str().unwrap().contains("already on its way"), "{again}");

    land(&f, card);
    let after = view(&f);
    assert!(after["offers"].as_array().unwrap().is_empty(), "{after}");
    let rows = after["links"].as_array().unwrap();
    let state = |name: &str| rows.iter().find(|r| r["skill"] == name).unwrap()["state"].clone();
    assert_eq!(state(SKILL), "updateAvailable");
    assert_eq!(state("other"), "upToDate");
    // H3a's Compare now works from the right base: here (v1) → the team (v2).
    let compare = invoke(&f, "skills_hub_compare", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap();
    assert!(compare["left"]["text"].as_str().unwrap().contains("v1"), "{compare}");
    assert!(compare["right"]["text"].as_str().unwrap().contains("v2"), "{compare}");
}

/// §14 Q10: a copy that equals no version gets no offer and is never
/// linked; a copy that isn't committed has nothing on the branch to link.
#[test]
fn a_modified_or_uncommitted_copy_is_not_linked() {
    let f = fixture(PlanCase::Free);
    old_install(&f, SKILL, "---\nname: review-rules\ndescription: Mine.\n---\n\nMine.\n");
    commit_all(&f.project, "own copy");
    assert!(view(&f)["offers"].as_array().unwrap().is_empty());
    let why = link(&f, &[SKILL]).unwrap_err();
    assert!(why.as_str().unwrap().contains("isn't the same as any version"), "{why}");
    assert!(cards(&f).is_empty());

    let g = fixture(PlanCase::Free);
    old_install(&g, SKILL, &skill_text("v1"));
    let shown = view(&g);
    assert_eq!(shown["offers"][0]["committed"], false, "{shown}");
    let why = link(&g, &[SKILL]).unwrap_err();
    assert!(why.as_str().unwrap().contains("not on main yet"), "{why}");
    assert!(cards(&g).is_empty(), "no card");
}

/// Link all with one copy that can't be linked: the card carries the rest
/// and says which it skipped and why.
#[test]
fn link_all_skips_what_it_cannot_link_and_says_why() {
    let f = fixture(PlanCase::Free);
    old_install(&f, SKILL, &skill_text("v1"));
    old_install(&f, "mine", "---\nname: mine\ndescription: Mine.\n---\n\nMine.\n");
    // A link record that can't be read is never written over (as Install).
    write(&f.project, ".atelier/skill-links/broken.json", "not json\n");
    commit_all(&f.project, "installs");
    let made = link(&f, &[SKILL, "mine", "broken"]).unwrap();
    assert_eq!(made["card"]["title"], format!("Skill: link {SKILL} to the team library"));
    let skipped = made["skipped"].as_array().unwrap();
    assert_eq!(skipped.len(), 2, "{made}");
    assert_eq!(skipped[0][0], "broken");
    assert!(skipped[0][1].as_str().unwrap().contains("can't be read"), "{made}");
    assert_eq!(skipped[1][0], "mine");
}

fn card_call(fixture: &Fixture, command: &str, card: &serde_json::Value) -> Result<serde_json::Value, serde_json::Value> {
    invoke(fixture, command, serde_json::json!({ "workspaceId": fixture.workspace_id, "cardId": card["id"] }))
}

/// Mac walk 2 (H3a): the card says it is behind the library before any
/// Ship, and **Refresh card** leaves it exactly as a fresh Update card would
/// be — one commit on the card's base, whose diff, link record and *Not
/// needed* entry are the new version's — not a second commit stacked on the
/// first.
#[test]
fn refresh_rebuilds_the_one_commit_at_the_new_version() {
    let f = fixture(PlanCase::Free);
    let made = install(&f, false).unwrap();
    land(&f, &made["card"]);
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v2"));
    commit_all(&f.clone, "v2");
    let card = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap();
    assert_eq!(card_call(&f, "skills_hub_card_behind", &card).unwrap()["behind"], false);
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v3"));
    commit_all(&f.clone, "v3");
    let behind = card_call(&f, "skills_hub_card_behind", &card).unwrap();
    assert_eq!(behind, serde_json::json!({ "behind": true, "showsFirst": null }), "behind before any Ship");

    let refreshed = card_call(&f, "skills_hub_card_refresh", &card).unwrap();
    let wt = PathBuf::from(refreshed["worktreePath"].as_str().unwrap());
    let base = refreshed["worktreeBase"]["commit"].as_str().unwrap();
    assert_eq!(base, card["worktreeBase"]["commit"].as_str().unwrap(), "same base");
    assert_eq!(git(&wt, &["rev-list", "--count", &format!("{base}..HEAD")]).trim(), "1", "one commit");
    let diff = git(&wt, &["diff", base, "HEAD", "--", ".claude/skills"]);
    assert!(diff.contains("-description: Review rules, v1.") && diff.contains("+description: Review rules, v3."), "{diff}");
    assert!(!diff.contains("v2"), "{diff}");
    let v3 = git(&f.clone, &["rev-parse", &format!("HEAD:library/claude/acme/skills/{SKILL}")]).trim().to_string();
    let link = crate::skill_links::parse(&std::fs::read(wt.join(".atelier/skill-links/review-rules.json")).unwrap()).unwrap();
    assert_eq!(link.origin.version.content_id, v3);
    assert_eq!(link.base.claude.as_deref(), Some(v3.as_str()));
    assert_eq!(refreshed["kind"]["origin"]["version"]["contentId"], v3.as_str());
    let history = refreshed["verifyHistory"].as_array().unwrap();
    assert_eq!(history.len(), 1, "{history:?}");
    let tree = git(&wt, &["rev-parse", "HEAD^{tree}"]).trim().to_string();
    assert_eq!(history[0]["treeSha"], tree.as_str());
    assert_eq!(card_call(&f, "skills_hub_card_behind", &refreshed).unwrap()["behind"], false);
    // Refreshing again at the same version changes nothing.
    let head = git(&wt, &["rev-parse", "HEAD"]);
    card_call(&f, "skills_hub_card_refresh", &refreshed).unwrap();
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), head);
    land(&f, &refreshed);
    assert_eq!(link_state(&f), "upToDate");
}

/// Windows walk (H6b step 9): an open Update card, then the team changes a
/// script (or adds an image) upstream. The card says before any press that
/// the newer version is shown first (`showsFirst`), and Refresh card's
/// refusal names what is new or changed: a script, or a file that is not text.
#[test]
fn a_newer_version_with_a_changed_script_is_shown_first_not_refreshed() {
    let f = fixture(PlanCase::Free);
    git(&f.clone, &["config", "core.fileMode", "false"]);
    let dir = format!("library/claude/acme/skills/{SKILL}");
    write(&f.clone, &format!("{dir}/scripts/hello.ps1"), "Write-Output 'v1'\r\n");
    commit_all(&f.clone, "a script");
    let ok = |f: &Fixture| {
        let head = crate::library_snapshot::head_commit(&f.clone).unwrap();
        match crate::skill_scripts::repo::repo_ask(&f.clone, &head, &dir, &[]).unwrap() {
            crate::skill_scripts::repo::RepoAsk::Ask { scripts_id, .. } => scripts_id,
            other => panic!("the scripts ask: {other:?}"),
        }
    };
    let made = invoke(
        &f,
        "skills_hub_install",
        serde_json::json!({ "workspaceId": f.workspace_id, "plugin": "acme", "skill": SKILL, "replace": false, "scriptsOk": [ok(&f)] }),
    )
    .unwrap();
    land(&f, &made["card"]);
    write(&f.clone, &format!("{dir}/SKILL.md"), &skill_text("v2"));
    commit_all(&f.clone, "v2 words");
    let card = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap();
    assert_eq!(card_call(&f, "skills_hub_card_behind", &card).unwrap()["behind"], false);

    // An image only: a file that is not text, the script unchanged.
    std::fs::write(f.clone.join(format!("{dir}/diagram.png")), [0x89u8, b'P', b'N', b'G', 0, 1, 0xff]).unwrap();
    commit_all(&f.clone, "an image");
    let behind = card_call(&f, "skills_hub_card_behind", &card).unwrap();
    assert_eq!(behind, serde_json::json!({ "behind": true, "showsFirst": "file" }));
    let why = card_call(&f, "skills_hub_card_refresh", &card).unwrap_err();
    assert!(why.as_str().unwrap().contains("brings a new or changed file that is not text,"), "{why}");

    // Then the script changes too.
    write(&f.clone, &format!("{dir}/scripts/hello.ps1"), "Write-Output 'v2'\r\n");
    commit_all(&f.clone, "script v2");
    let behind = card_call(&f, "skills_hub_card_behind", &card).unwrap();
    assert_eq!(behind, serde_json::json!({ "behind": true, "showsFirst": "script" }));
    let why = card_call(&f, "skills_hub_card_refresh", &card).unwrap_err();
    assert_eq!(
        why.as_str().unwrap(),
        "The team library's newer review-rules brings a new or changed script, so Plyloft won't \
         put it in this card without showing it to you. Delete this card and press Update in the \
         Library: it shows every file first."
    );
}

/// Windows walk: on a board backed by GitHub Issues the issue owns the notes,
/// so a Refresh that rewrote them leaves the card `sync_pending` — the next
/// Sync pushes the new notes instead of pulling the older body back.
#[test]
fn refresh_leaves_an_issue_backed_card_to_push_its_new_notes() {
    let f = fixture(PlanCase::Free);
    let made = install(&f, false).unwrap();
    land(&f, &made["card"]);
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v2"));
    commit_all(&f.clone, "v2");
    let card = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap();
    let store = f.app.state::<crate::kanban::KanbanStore>();
    store
        .with_card(&f.workspace_id, card["id"].as_str().unwrap(), |c| {
            c.gh_issue_number = Some(34);
            c.sync_pending = false;
            Ok(())
        })
        .unwrap();
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v3"));
    commit_all(&f.clone, "v3");
    let refreshed = card_call(&f, "skills_hub_card_refresh", &card).unwrap();
    assert_eq!(refreshed["syncPending"], true, "{refreshed}");
}

/// Mac walk 2: a branch holding anything but Plyloft's skill change is never
/// rebuilt (the rebuild would drop it).
#[test]
fn refresh_never_drops_a_commit_plyloft_did_not_make() {
    let f = fixture(PlanCase::Free);
    let made = install(&f, false).unwrap();
    let card = &made["card"];
    let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
    write(&wt, "notes.txt", "mine\n");
    commit_all(&wt, "my own commit");
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v2"));
    commit_all(&f.clone, "v2");
    let head = git(&wt, &["rev-parse", "HEAD"]);
    let why = card_call(&f, "skills_hub_card_refresh", card).unwrap_err();
    assert!(why.as_str().unwrap().contains("changes Plyloft didn't make"), "{why}");
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), head, "nothing moved");
}

// ── Skills hub H4: the decisions (R3, R8) ───────────────────────────────

fn links_row(fixture: &Fixture) -> serde_json::Value {
    let view = invoke(fixture, "skills_hub_links", serde_json::json!({ "workspaceId": fixture.workspace_id })).unwrap();
    view["links"].as_array().unwrap().first().cloned().unwrap_or(serde_json::Value::Null)
}

fn ask(fixture: &Fixture, command: &str, extra: serde_json::Value) -> Result<serde_json::Value, serde_json::Value> {
    let mut body = serde_json::json!({ "workspaceId": fixture.workspace_id, "skill": SKILL });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    invoke(fixture, command, body)
}

/// Installed, shipped, edited here and changed upstream: *Both changed*.
fn both_changed(policy: PlanCase) -> Fixture {
    let f = fixture(policy);
    let made = install(&f, false).unwrap();
    land(&f, &made["card"]);
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("mine"));
    commit_all(&f.project, "my edit");
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v2"));
    commit_all(&f.clone, "v2");
    assert_eq!(link_state(&f), "bothChanged");
    f
}

fn changed_paths(card: &serde_json::Value) -> Vec<String> {
    let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
    let mut out: Vec<String> = git(&wt, &["diff", "--name-status", "HEAD~1", "HEAD"]).lines().map(str::to_string).collect();
    out.sort();
    out
}

/// The card's own commit passes Ship's tree gate without Verify (§4.2).
fn gate_passes(fixture: &Fixture, card: &serde_json::Value) -> bool {
    let card = fixture
        .app
        .state::<crate::kanban::KanbanStore>()
        .get_card(&fixture.workspace_id, card["id"].as_str().unwrap())
        .unwrap();
    let wt = PathBuf::from(card.worktree_path.clone().unwrap());
    let head = git(&wt, &["rev-parse", "HEAD"]).trim().to_string();
    crate::skill_card::card_only(&wt, &card.worktree_base.as_ref().unwrap().commit, &head, card.skill_card().unwrap())
}

/// Tier 4 H4 steps 1–3: *Keep mine* is a one-file card (the link record);
/// once it ships the copy is still *Modified here*, its base is the team's
/// version now, and the next upstream change asks again. On every plan:
/// Free is walked here.
#[test]
fn keep_mine_moves_the_base_and_keeps_the_copy() {
    let f = both_changed(PlanCase::Free);
    let card = ask(&f, "skills_hub_keep_mine", serde_json::json!({})).unwrap();
    assert_eq!(card["title"], format!("Skill: keep this repository's {SKILL} (linked to the team library)"));
    assert_eq!(card["kind"]["verb"], "keepMine");
    assert_eq!(changed_paths(&card), ["M\t.atelier/skill-links/review-rules.json"]);
    assert!(gate_passes(&f, &card), "a link-only card needs no Verify");
    // On its way: no second decision for the skill.
    assert!(ask(&f, "skills_hub_keep_mine", serde_json::json!({})).unwrap_err().as_str().unwrap().contains("already on its way"));
    land(&f, &card);
    let row = links_row(&f);
    assert_eq!(row["state"], "modifiedHere", "{row}");
    assert_eq!(row["keptMine"], true);
    let v2 = git(&f.clone, &["rev-parse", &format!("HEAD:library/claude/acme/skills/{SKILL}")]).trim().to_string();
    let link = crate::skill_links::parse(&std::fs::read(f.project.join(".atelier/skill-links/review-rules.json")).unwrap()).unwrap();
    assert_eq!(link.origin.version.content_id, v2);
    assert_eq!(link.base.claude.as_deref(), Some(v2.as_str()));
    assert!(std::fs::read_to_string(f.project.join(format!(".claude/skills/{SKILL}/SKILL.md"))).unwrap().contains("mine"));
    // Nothing new upstream: nothing to keep it over.
    assert!(ask(&f, "skills_hub_keep_mine", serde_json::json!({})).unwrap_err().as_str().unwrap().contains("nothing to keep"));
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v3"));
    commit_all(&f.clone, "v3");
    assert_eq!(link_state(&f), "bothChanged");
}

/// Tier 4 H4 step 4: *Take upstream* is a card whose change is upstream −
/// here; after it ships the copy is up to date.
#[test]
fn take_upstream_replaces_mine_with_the_team_s() {
    let f = both_changed(PlanCase::Free);
    let card = ask(&f, "skills_hub_update", serde_json::json!({ "takeUpstream": true })).unwrap();
    // H4 Mac walk: its own title, not an Update's; no commit code in its words.
    assert_eq!(card["title"], format!("Skill: take the team library's {SKILL}"));
    let notes = card["notes"].as_str().unwrap();
    let commit_code = notes
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|word| word.len() >= 7 && word.chars().all(|c| c.is_ascii_hexdigit()) && word.chars().any(|c| c.is_ascii_digit()));
    assert!(notes.contains("over this repository's changes") && !commit_code, "{notes}");
    let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
    let diff = git(&wt, &["diff", "HEAD~1", "HEAD", "--", ".claude/skills"]);
    assert!(diff.contains("-description: Review rules, mine.") && diff.contains("+description: Review rules, v2."), "{diff}");
    land(&f, &card);
    assert_eq!(link_state(&f), "upToDate");
    // A plain Update still never writes over an edit.
    write(&f.project, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("mine again"));
    commit_all(&f.project, "again");
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v3"));
    commit_all(&f.clone, "v3");
    assert!(ask(&f, "skills_hub_update", serde_json::json!({})).unwrap_err().as_str().unwrap().contains("overwrite"));
}

/// R3: the 3-way Compare reads the base from this Mac's base store (kept
/// at Install) and says whose change each file is, on every plan (Free
/// here).
#[test]
fn compare3_shows_base_upstream_and_here_per_file() {
    let f = both_changed(PlanCase::Free);
    let v1 = crate::skill_links::parse(&std::fs::read(f.project.join(".atelier/skill-links/review-rules.json")).unwrap())
        .unwrap()
        .origin
        .version
        .content_id;
    assert!(crate::skill_bases::read(&f.app.state::<crate::workspace::WorkspaceStore>().config_dir, &v1).is_some(), "kept at Install");
    let compare = ask(&f, "skills_hub_compare3", serde_json::json!({})).unwrap();
    assert_eq!(compare["state"], "bothChanged");
    assert!(compare["note"].is_null(), "{compare}");
    let file = &compare["files"][0];
    assert_eq!(file["path"], "SKILL.md");
    assert_eq!(file["status"], "both");
    assert!(file["base"].as_str().unwrap().contains("v1"));
    assert!(file["upstream"].as_str().unwrap().contains("v2"));
    assert!(file["here"].as_str().unwrap().contains("mine"));
}

/// R3 (Propose mine upstream) refusal that needs no GitHub: only the team
/// gate (it writes the team library), the same on Free and an old Pro.
#[test]
fn propose_needs_the_team_plan() {
    for policy in [PlanCase::Free, PlanCase::Pro] {
        let f = both_changed(policy);
        let why = ask(&f, "skills_hub_propose_upstream", serde_json::json!({})).unwrap_err();
        assert!(why.as_str().unwrap().starts_with(crate::license::TEAM_PLAN_LEAD), "{policy:?}: {why}");
    }
}

/// Tier 4 H4 step 6: a skill deleted upstream reads *Removed*; *Keep*
/// detaches (a card removing only the link record), *Remove* is a card
/// deleting the copy and the record. Free on every plan.
#[test]
fn removed_upstream_asks_keep_or_remove() {
    for choice in ["keep", "remove"] {
        let f = fixture(PlanCase::Free);
        let made = install(&f, false).unwrap();
        land(&f, &made["card"]);
        git(&f.clone, &["rm", "-rq", &format!("library/claude/acme/skills/{SKILL}")]);
        commit_all(&f.clone, "retire");
        assert_eq!(link_state(&f), "removed");
        let card = ask(&f, "skills_hub_removed_choice", serde_json::json!({ "choice": choice })).unwrap();
        assert!(gate_passes(&f, &card), "{choice}: no Verify");
        if choice == "keep" {
            assert_eq!(card["title"], format!("Skill: unlink {SKILL} (removed from the team library)"));
            assert_eq!(changed_paths(&card), ["D\t.atelier/skill-links/review-rules.json"]);
            land(&f, &card);
            assert!(links_row(&f).is_null(), "detached: an ordinary repository skill");
            assert!(f.project.join(format!(".claude/skills/{SKILL}/SKILL.md")).is_file());
        } else {
            assert_eq!(card["title"], format!("Skill: remove {SKILL} (removed from the team library)"));
            assert_eq!(
                changed_paths(&card),
                ["D\t.atelier/skill-links/review-rules.json".to_string(), format!("D\t.claude/skills/{SKILL}/SKILL.md")]
            );
            land(&f, &card);
            assert!(!f.project.join(format!(".claude/skills/{SKILL}")).exists());
        }
    }
    // Not removed: nothing to decide.
    let f = fixture(PlanCase::Free);
    let made = install(&f, false).unwrap();
    land(&f, &made["card"]);
    let why = ask(&f, "skills_hub_removed_choice", serde_json::json!({ "choice": "keep" })).unwrap_err();
    assert!(why.as_str().unwrap().contains("nothing to decide"), "{why}");
}

/// Tier 4 H4 step 7: a rename upstream reads *Renamed* with the new name;
/// *Rename here* moves the copy and its record (the team's rename brought in); *Keep the old
/// name* points the record at the new directory.
#[test]
fn renamed_upstream_offers_rename_here_or_keep_the_name() {
    for choice in ["rename", "keepName"] {
        let f = fixture(PlanCase::Free);
        let made = install(&f, false).unwrap();
        land(&f, &made["card"]);
        git(&f.clone, &["mv", &format!("library/claude/acme/skills/{SKILL}"), "library/claude/acme/skills/lint-rules"]);
        commit_all(&f.clone, "rename");
        let row = links_row(&f);
        assert_eq!(row["state"], "renamed", "{row}");
        assert_eq!(row["renamedTo"], "lint-rules");
        let card = ask(&f, "skills_hub_renamed_choice", serde_json::json!({ "choice": choice })).unwrap();
        assert!(gate_passes(&f, &card), "{choice}: no Verify");
        land(&f, &card);
        let row = links_row(&f);
        assert_eq!(row["state"], "upToDate", "{choice}: {row}");
        if choice == "rename" {
            assert_eq!(card["title"], format!("Skill: rename {SKILL} to lint-rules (renamed in the team library)"));
            assert_eq!(row["skill"], "lint-rules");
            assert!(f.project.join(".claude/skills/lint-rules/SKILL.md").is_file());
            assert!(!f.project.join(format!(".claude/skills/{SKILL}")).exists());
        } else {
            assert_eq!(card["title"], format!("Skill: link {SKILL} to lint-rules in the team library"));
            assert_eq!(row["skill"], SKILL);
            assert_eq!(changed_paths(&card), ["M\t.atelier/skill-links/review-rules.json"]);
        }
    }
}

/// R14 / Tier 4 H4 step 2: *Both changed* files one Inbox decision; it is
/// gone while a card carries the answer.
#[test]
fn a_decision_files_one_inbox_row_until_a_card_answers_it() {
    let f = both_changed(PlanCase::Free);
    let state = crate::skills_hub_state::HubState::default();
    let decisions = crate::commands::skills_hub_decisions::workspace_decisions(&f.project, &f.clone, true, &cards(&f), &state);
    assert_eq!(decisions.len(), 1, "{decisions:?}");
    assert_eq!(decisions[0].state, crate::skill_links::LinkState::BothChanged);
    ask(&f, "skills_hub_keep_mine", serde_json::json!({})).unwrap();
    let decisions = crate::commands::skills_hub_decisions::workspace_decisions(&f.project, &f.clone, true, &cards(&f), &state);
    assert!(decisions.is_empty(), "{decisions:?}");
}

/// H4 Windows re-walk 2 (X1): the legacy record an earlier Rename here wrote
/// (new name and folder, the old version and its unrenamed base) reads
/// *Update available* — and Update must then make the card (it did nothing
/// on Windows).
#[test]
fn update_on_a_legacy_renamed_record_makes_the_card() {
    let f = fixture(PlanCase::Free);
    let made = install(&f, false).unwrap();
    land(&f, &made["card"]);
    let linked = std::fs::read(f.project.join(format!(".atelier/skill-links/{SKILL}.json"))).unwrap();
    let linked = crate::skill_links::parse(&linked).unwrap();
    // The team: a text change, then the rename with its `name:`.
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v2"));
    commit_all(&f.clone, "v2");
    git(&f.clone, &["mv", &format!("library/claude/acme/skills/{SKILL}"), "library/claude/acme/skills/lint-rules"]);
    write(&f.clone, "library/claude/acme/skills/lint-rules/SKILL.md", &skill_text("v2").replace(&format!("name: {SKILL}"), "name: lint-rules"));
    commit_all(&f.clone, "rename");
    assert_eq!(link_state(&f), "renamed");
    // What the earlier Rename here wrote, by hand: the copy moved with the
    // rename brought in, the record renamed with the old version and base.
    git(&f.project, &["mv", &format!(".claude/skills/{SKILL}"), ".claude/skills/lint-rules"]);
    write(&f.project, ".claude/skills/lint-rules/SKILL.md", &skill_text("v1").replace(&format!("name: {SKILL}"), "name: lint-rules"));
    git(&f.project, &["rm", "-q", &format!(".atelier/skill-links/{SKILL}.json")]);
    let legacy = crate::skill_links::relinked(&linked, "lint-rules", "library/claude/acme/skills/lint-rules");
    write(&f.project, ".atelier/skill-links/lint-rules.json", &String::from_utf8(crate::skill_links::to_bytes(&legacy)).unwrap());
    commit_all(&f.project, "the earlier Rename here");
    let view = invoke(&f, "skills_hub_links", serde_json::json!({ "workspaceId": f.workspace_id })).unwrap();
    assert_eq!(view["links"][0]["state"], "updateAvailable", "{view}");
    let card = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": "lint-rules" }));
    let card = card.unwrap_or_else(|why| panic!("Update must make the card or say why: {why}"));
    assert_eq!(card["title"], "Skill: update lint-rules from the team library");
    let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
    let diff = git(&wt, &["diff", "HEAD~1", "HEAD", "--", ".claude/skills"]);
    assert!(diff.contains("-description: Review rules, v1.") && diff.contains("+description: Review rules, v2."), "{diff}");
    land(&f, &card);
    let view = invoke(&f, "skills_hub_links", serde_json::json!({ "workspaceId": f.workspace_id })).unwrap();
    assert_eq!(view["links"][0]["state"], "upToDate", "{view}");
}

/// Challenger (H6b): Update compares with the target branch the card is cut
/// from, never the checkout's `HEAD`. The checkout sits on a branch that
/// holds the library's script (as it is); `main` doesn't. Take upstream would
/// carry the script onto `main`, so it asks first, and the sheet's OK makes
/// the card with the script, executable.
#[test]
fn an_update_asks_for_a_script_the_target_branch_lacks_even_when_head_has_it() {
    let f = fixture(PlanCase::Free);
    let made = install(&f, false).unwrap();
    land(&f, &made["card"]);
    // The bit lives in git only here (as on Windows): later `add -A`s keep it.
    git(&f.clone, &["config", "core.fileMode", "false"]);
    git(&f.project, &["config", "core.fileMode", "false"]);
    let script = format!("library/claude/acme/skills/{SKILL}/scripts/check.sh");
    write(&f.clone, &script, "#!/bin/sh\necho ok\n");
    git(&f.clone, &["add", "-A"]);
    git(&f.clone, &["update-index", "--chmod=+x", &script]);
    git(&f.clone, &["commit", "-q", "-m", "a script"]);
    // The same script, same mode, on a branch of the checkout.
    git(&f.project, &["checkout", "-q", "-b", "feat"]);
    let here = format!(".claude/skills/{SKILL}/scripts/check.sh");
    write(&f.project, &here, "#!/bin/sh\necho ok\n");
    git(&f.project, &["add", "-A"]);
    git(&f.project, &["update-index", "--chmod=+x", &here]);
    git(&f.project, &["commit", "-q", "-m", "the script, on a branch"]);
    // The library moves on in text too.
    write(&f.clone, &format!("library/claude/acme/skills/{SKILL}/SKILL.md"), &skill_text("v3"));
    commit_all(&f.clone, "v3 words");

    let ask = |ok: serde_json::Value| {
        invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL, "takeUpstream": true, "scriptsOk": ok }))
    };
    let why = ask(serde_json::Value::Null).unwrap_err();
    assert!(why.as_str().unwrap().contains(crate::skill_card::SCRIPTS_WAIT_MARKER), "{why}");
    assert!(cards(&f).iter().all(|c| !c.title.contains("update")), "no card without the OK");

    let asked = crate::skill_scripts::repo::repo_ask(
        &f.clone,
        &crate::library_snapshot::head_commit(&f.clone).unwrap(),
        &format!("library/claude/acme/skills/{SKILL}"),
        &[],
    )
    .unwrap();
    let crate::skill_scripts::repo::RepoAsk::Ask { scripts_id, .. } = asked else { panic!("the script asks") };
    let card = ask(serde_json::json!([scripts_id])).unwrap();
    let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
    let mode = git(&wt, &["ls-tree", "HEAD", "--", &here]);
    assert!(mode.starts_with("100755"), "{mode}");
}

/// H6b Mac walk (phase 2): the local target is **ahead** of origin, and the
/// skill landed only locally. A card is cut from the local target then, so
/// the Update sheet compares with it — the changed script reads *changed*,
/// the rest *unchanged* (it read every file *new*, against origin) — and the
/// card changes only the script.
#[test]
fn the_update_sheet_compares_with_a_local_target_ahead_of_origin() {
    let f = fixture(PlanCase::Free);
    let remote = f.project.parent().unwrap().join("remote.git");
    git(f.project.parent().unwrap(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    git(&f.project, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&f.project, &["push", "-q", "origin", "main"]);
    git(&f.project, &["fetch", "-q", "origin"]);
    git(&f.clone, &["config", "core.fileMode", "false"]);
    let dir = format!("library/claude/acme/skills/{SKILL}");
    let script = |text: &str| {
        write(&f.clone, &format!("{dir}/scripts/run.sh"), text);
        git(&f.clone, &["add", "-A"]);
        git(&f.clone, &["update-index", "--chmod=+x", &format!("{dir}/scripts/run.sh")]);
    };
    write(&f.clone, &format!("{dir}/scripts/run.ps1"), "Write-Output 'v1'\r\n");
    script("#!/bin/sh\necho v1\n");
    git(&f.clone, &["commit", "-q", "-m", "scripts v1"]);
    let ok = |f: &Fixture| {
        let head = crate::library_snapshot::head_commit(&f.clone).unwrap();
        match crate::skill_scripts::repo::repo_ask(&f.clone, &head, &dir, &[]).unwrap() {
            crate::skill_scripts::repo::RepoAsk::Ask { scripts_id, .. } => scripts_id,
            other => panic!("the scripts ask: {other:?}"),
        }
    };
    let made = invoke(
        &f,
        "skills_hub_install",
        serde_json::json!({ "workspaceId": f.workspace_id, "plugin": "acme", "skill": SKILL, "replace": false, "scriptsOk": [ok(&f)] }),
    )
    .unwrap();
    // It lands on the local target only: origin/main never gets it.
    land(&f, &made["card"]);
    let local = git(&f.project, &["rev-parse", "main"]).trim().to_string();
    assert_eq!(crate::worktrees::skill_base_as_known(&f.project, "main"), Some(local));
    script("#!/bin/sh\necho v2\n");
    git(&f.clone, &["commit", "-q", "-m", "run.sh v2"]);

    let copies = crate::commands::checkout_copies(&f.project, "main", SKILL);
    let state = crate::skills_hub_state::HubState::default();
    let review = crate::skill_scripts::repo::repo_review(&f.clone, "acme", SKILL, &dir, &copies, &state)
        .unwrap()
        .expect("the changed script asks");
    let change = |path: &str| review.files.iter().find(|file| file.path == path).unwrap().change;
    assert_eq!(change("scripts/run.sh"), "changed");
    assert_eq!(change("scripts/run.ps1"), "unchanged");
    assert_eq!(change("SKILL.md"), "unchanged");

    let card = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL, "scriptsOk": [ok(&f)] }))
        .unwrap();
    let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
    let changed = git(&wt, &["diff", "--name-status", "HEAD~1", "HEAD"]);
    let mut changed: Vec<&str> = changed.lines().collect();
    changed.sort();
    assert_eq!(
        changed,
        [
            "M\t.atelier/skill-links/review-rules.json",
            "M\t.claude/skills/review-rules/scripts/run.sh",
        ],
        "cut from the local target"
    );
}

/// H6b Windows walk: the local target is **ahead and behind** origin (a
/// shared workspace: its ships land on the local branch, Publish pushes, and
/// a teammate pushed meanwhile), and the installed skill is only on the local
/// branch. The Update sheet, the card and its Ship all read the local target,
/// where the ship lands: the changed script reads *changed* and the others
/// *unchanged* (every file read *new*, against origin), the card changes the
/// script and the link record only, and Ship goes ahead as a local merge (it
/// turned into a pull request: "changed on main since this card was made").
#[test]
fn an_update_on_a_local_target_that_diverged_from_origin_compares_and_ships_there() {
    let f = fixture(PlanCase::Free);
    let parent = f.project.parent().unwrap().to_path_buf();
    let remote = parent.join("remote.git");
    git(&parent, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    git(&f.project, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&f.project, &["push", "-q", "origin", "main"]);
    git(&f.project, &["fetch", "-q", "origin"]);
    git(&f.clone, &["config", "core.fileMode", "false"]);
    let dir = format!("library/claude/acme/skills/{SKILL}");
    write(&f.clone, &format!("{dir}/scripts/run.ps1"), "Write-Output 'v1'\r\n");
    write(&f.clone, &format!("{dir}/scripts/run.sh"), "#!/bin/sh\necho v1\n");
    commit_all(&f.clone, "scripts v1");
    let ok = |f: &Fixture| {
        let head = crate::library_snapshot::head_commit(&f.clone).unwrap();
        match crate::skill_scripts::repo::repo_ask(&f.clone, &head, &dir, &[]).unwrap() {
            crate::skill_scripts::repo::RepoAsk::Ask { scripts_id, .. } => scripts_id,
            other => panic!("the scripts ask: {other:?}"),
        }
    };
    let made = invoke(
        &f,
        "skills_hub_install",
        serde_json::json!({ "workspaceId": f.workspace_id, "plugin": "acme", "skill": SKILL, "replace": false, "scriptsOk": [ok(&f)] }),
    )
    .unwrap();
    land(&f, &made["card"]);
    // A teammate pushes other work to origin/main: local main is now ahead 1,
    // behind 1, and only it holds the skill.
    let teammate = parent.join("teammate");
    git(&parent, &["clone", "-q", remote.to_str().unwrap(), teammate.to_str().unwrap()]);
    git(&teammate, &["config", "user.email", "o@o"]);
    git(&teammate, &["config", "user.name", "o"]);
    write(&teammate, "teammate.txt", "theirs\n");
    commit_all(&teammate, "teammate's work");
    git(&teammate, &["push", "-q", "origin", "main"]);
    git(&f.project, &["fetch", "-q", "origin"]);
    let counts = git(&f.project, &["rev-list", "--left-right", "--count", "main...origin/main"]);
    assert_eq!(counts.split_whitespace().collect::<Vec<_>>(), ["1", "1"], "diverged");
    let local = git(&f.project, &["rev-parse", "main"]).trim().to_string();
    assert_eq!(crate::worktrees::skill_base_as_known(&f.project, "main"), Some(local.clone()));

    // The teammate changes run.ps1 in the library.
    write(&f.clone, &format!("{dir}/scripts/run.ps1"), "Write-Output 'v2'\r\n");
    commit_all(&f.clone, "run.ps1 v2");
    let copies = crate::commands::checkout_copies(&f.project, "main", SKILL);
    let state = crate::skills_hub_state::HubState::default();
    let review = crate::skill_scripts::repo::repo_review(&f.clone, "acme", SKILL, &dir, &copies, &state)
        .unwrap()
        .expect("the changed script asks");
    let change = |path: &str| review.files.iter().find(|file| file.path == path).unwrap().change;
    assert_eq!(change("scripts/run.ps1"), "changed");
    assert_eq!(change("scripts/run.sh"), "unchanged");
    assert_eq!(change("SKILL.md"), "unchanged");

    let card = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL, "scriptsOk": [ok(&f)] }))
        .unwrap();
    assert_eq!(card["worktreeBase"]["commit"].as_str(), Some(local.as_str()), "{}", card["worktreeBase"]);
    assert_eq!(card["worktreeBase"]["source"].as_str(), Some("localAhead"));
    let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
    let changed = git(&wt, &["diff", "--name-status", "HEAD~1", "HEAD"]);
    let mut changed: Vec<&str> = changed.lines().collect();
    changed.sort();
    assert_eq!(
        changed,
        [
            "M\t.atelier/skill-links/review-rules.json",
            "M\t.claude/skills/review-rules/scripts/run.ps1",
        ],
        "cut from the local target"
    );

    let carried = cards(&f).into_iter().find(|c| c.id == card["id"].as_str().unwrap()).unwrap();
    let handle = f.app.handle();
    let workspaces = handle.state::<crate::workspace::WorkspaceStore>();
    assert_eq!(
        crate::commands::skill_card_preflight(handle, &workspaces, "main", &f.workspace_id, carried.skill_card().unwrap()),
        crate::skill_card::Preflight::Go,
        "ships as a local merge, not a pull request"
    );
    // Challenger: as a pull request it would carry local main's own commit
    // (the install's land), which GitHub's main lacks — refused, in words.
    let why = crate::commands::skill_pr_carries_local_commits(&f.project, &carried, "main").expect("refused");
    assert!(why.contains("has 1 commit GitHub's main doesn't") && why.contains("Publish main, then ship again"), "{why}");
    land(&f, &card);
    assert_eq!(link_state(&f), "upToDate");
    // Published (origin merged in, then pushed): GitHub holds the base.
    git(&f.project, &["merge", "-q", "--no-edit", "origin/main"]);
    git(&f.project, &["push", "-q", "origin", "main"]);
    assert_eq!(crate::commands::skill_pr_carries_local_commits(&f.project, &carried, "main"), None);
}

/// H6b Windows walk: a skill card shipped as a pull request still open is on
/// its way — a second Install (or Update) is refused, naming it, so no
/// duplicate card is made. Once its pull request is closed, it is not.
#[test]
fn a_skill_card_shipped_as_an_open_pull_request_is_still_on_its_way() {
    let f = fixture(PlanCase::Free);
    let made = install(&f, false).unwrap();
    let id = made["card"]["id"].as_str().unwrap().to_string();
    let kanban = f.app.state::<crate::kanban::KanbanStore>();
    kanban.mark_card_pr_shipped(&f.workspace_id, &id, "https://github.com/acme/web/pull/95", None).unwrap();
    assert!(crate::kanban::card_shipped_or_pr_open(&kanban.get_card(&f.workspace_id, &id).unwrap()), "sent, as Ship records a pull request");
    let why = install(&f, false).unwrap_err();
    assert!(why.to_string().contains("already on its way"), "{why}");
    assert!(why.to_string().contains("Merge or close its pull request #95 first."), "{why}");
    assert_eq!(cards(&f).len(), 1, "no second card");
    kanban
        .with_card(&f.workspace_id, &id, |c| {
            c.pr.as_mut().unwrap().state = crate::pr_status::PrState::Closed;
            Ok(())
        })
        .unwrap();
    let again = install(&f, false).unwrap();
    assert_ne!(again["card"]["id"].as_str().unwrap(), id);
}

/// Skills hub H10 (R6 AC): a My library skill installed into a repository is
/// a linked copy whose origin is `{ kind: library, source: <owner/name> }`;
/// it reads Update available when My library moves on, and *not available*
/// on a Mac that doesn't use that My library.
#[test]
fn a_skill_from_my_library_is_a_linked_copy_of_it() {
    let f = fixture(PlanCase::Free);
    let config = f.clone.parent().unwrap().parent().unwrap().to_path_buf();
    let mine = crate::my_library::clone_dir(&config, "matteo/plyloft-skills");
    init(&mine);
    crate::my_library::ensure_layout(&mine).unwrap();
    write(&mine, &format!("library/claude/mine/skills/{SKILL}/SKILL.md"), &skill_text("mine-1"));
    write(&mine, &format!("library/codex/plugins/mine/skills/{SKILL}/SKILL.md"), &skill_text("mine-1"));
    commit_all(&mine, "mine 1");
    f.app
        .state::<crate::settings::SettingsStore>()
        .set_my_library(Some(crate::settings::MyLibrarySettings { repo: "matteo/plyloft-skills".into(), account: None }))
        .unwrap();
    let made = invoke(
        &f,
        "skills_hub_install",
        serde_json::json!({ "workspaceId": f.workspace_id, "plugin": "mine", "skill": SKILL, "replace": false, "library": "mine" }),
    )
    .unwrap();
    let card = &made["card"];
    assert_eq!(card["title"], format!("Skill: install {SKILL} from My library"));
    let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
    let record: serde_json::Value =
        serde_json::from_str(&git(&wt, &["show", &format!("HEAD:.atelier/skill-links/{SKILL}.json")])).unwrap();
    assert_eq!(record["origin"]["kind"], "library");
    assert_eq!(record["origin"]["source"], "matteo/plyloft-skills");
    assert_eq!(record["origin"]["plugin"], "mine");
    // Both CLIs: My library carries both halves.
    let changed = git(&wt, &["diff", "--name-only", "HEAD~1", "HEAD"]);
    assert!(changed.contains(".claude/skills/review-rules/SKILL.md") && changed.contains(".agents/skills/review-rules/SKILL.md"), "{changed}");
    land(&f, card);
    assert_eq!(link_state(&f), "upToDate");
    write(&mine, &format!("library/claude/mine/skills/{SKILL}/SKILL.md"), &skill_text("mine-2"));
    write(&mine, &format!("library/codex/plugins/mine/skills/{SKILL}/SKILL.md"), &skill_text("mine-2"));
    commit_all(&mine, "mine 2");
    assert_eq!(link_state(&f), "updateAvailable");
    let update = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap();
    assert_eq!(update["title"], format!("Skill: update {SKILL} from My library"));
    // A Mac that doesn't use this My library: not available, never removed.
    f.app.state::<crate::settings::SettingsStore>().set_my_library(None).unwrap();
    assert_eq!(link_state(&f), "notAvailable");
    // Whose My library it is, on a computer that isn't its owner's (R6).
    let view = invoke(&f, "skills_hub_links", serde_json::json!({ "workspaceId": f.workspace_id })).unwrap();
    assert_eq!(view["links"][0]["originWords"], "matteo's My library");
}
