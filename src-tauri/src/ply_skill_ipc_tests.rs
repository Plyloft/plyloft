//! Skills hub H9: Personalize, a fork's link and its update from Plyloft, and
//! the workspace switch, on a mock app with a real workspace repository and
//! the repository's own bundle (`resources/ply-skills`, a debug build's
//! fallback).

use std::path::{Path, PathBuf};

use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::webview::InvokeRequest;
use tauri::Manager;

use crate::license::PlanCase;

const SKILL: &str = "card-brief";
const DEFINITION_FILE: &str = ".atelier/workspace.json";

struct Fixture {
    _temp: tempfile::TempDir,
    app: tauri::App<MockRuntime>,
    webview: tauri::WebviewWindow<MockRuntime>,
    project: PathBuf,
    workspace_id: String,
}

fn git(dir: &Path, args: &[&str]) -> String {
    crate::git::capture(dir, args).unwrap_or_else(|e| panic!("git {args:?} in {}: {e}", dir.display()))
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

const DEFINITION: &str = r#"{
  "schemaVersion": 1,
  "name": "Web",
  "board": "local",
  "library": { "plySkills": { "off": [], "on": ["release-notes"] }, "later": 1 },
  "someday": true
}
"#;

fn fixture(policy: PlanCase, definition: bool) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.email", "t@t"],
        &["config", "user.name", "t"],
        &["config", "core.autocrlf", "false"],
    ] {
        git(&project, args);
    }
    write(&project, "README.md", "app\n");
    if definition {
        write(&project, DEFINITION_FILE, DEFINITION);
    }
    commit_all(&project, "init");
    let workspaces = crate::workspace::WorkspaceStore::new(config.clone()).unwrap();
    let workspace = workspaces
        .create("Web".into(), project.to_string_lossy().into_owned())
        .unwrap();
    let app = mock_builder()
        .manage(workspaces)
        .manage(crate::kanban::KanbanStore::new(config.clone()).unwrap())
        .manage(crate::settings::SettingsStore::new(config.clone()).unwrap())
        .manage(crate::license::LicenseStore::for_plan_test(config.clone(), policy))
        .manage(crate::team::TeamStore::new(config.clone()))
        .manage(crate::project_config::ProjectConfigStore::new(config.clone()).unwrap())
        .invoke_handler(tauri::generate_handler![
            crate::commands::skills_hub_links,
            crate::commands::skills_hub_compare,
            crate::commands::skills_hub_update,
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    Fixture { _temp: temp, app, webview, project, workspace_id: workspace.id }
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

fn personalize(fixture: &Fixture) -> Result<crate::kanban::KanbanCard, String> {
    let handle = fixture.app.handle();
    let (bundle, skill) = super::bundled(handle, SKILL)?;
    super::personalize_into_repository(handle, &fixture.workspace_id, &bundle, &skill)
}

fn land(fixture: &Fixture, card: &crate::kanban::KanbanCard) {
    git(&fixture.project, &["merge", "--ff-only", "-q", card.branch_name.as_deref().unwrap()]);
    fixture
        .app
        .state::<crate::kanban::KanbanStore>()
        .with_card(&fixture.workspace_id, &card.id, |c| {
            c.ship_status = crate::kanban::ShipStatus::Shipped;
            Ok(())
        })
        .unwrap();
}

fn links_row(fixture: &Fixture) -> serde_json::Value {
    let view = invoke(fixture, "skills_hub_links", serde_json::json!({ "workspaceId": fixture.workspace_id })).unwrap();
    let rows = view["links"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{view}");
    rows[0].clone()
}

fn inputs(fixture: &Fixture) -> crate::ply_skill_switch::Inputs {
    super::place_and_inputs(fixture.app.handle(), Some(&fixture.workspace_id), Vec::new()).1
}

/// Tier 4 step 2, as far as code walks it: Personalize into a repository with
/// a shared definition makes the card "Skill: personalize card-brief from
/// Plyloft" whose one commit adds both copies and the link record (origin
/// Plyloft, its version) — never the definition (owner, 2026-10-20: the fork
/// rule switches Plyloft's copy off, not a definition write) — and nothing in
/// the checkout. Ship's gate takes it as skill-only.
#[test]
fn personalize_makes_a_card_with_both_copies_the_link_and_the_switch() {
    let f = fixture(PlanCase::Free, true);
    let card = personalize(&f).unwrap();
    assert_eq!(card.title, format!("Skill: personalize {SKILL} from Plyloft"));
    assert_eq!(card.column_id, crate::kanban::KanbanColumnId::Complete);
    assert!(!f.project.join(".claude/skills").exists(), "the checkout is never written");
    let wt = PathBuf::from(card.worktree_path.clone().unwrap());
    let changed = git(&wt, &["diff", "--name-only", "HEAD~1", "HEAD"]);
    let mut changed: Vec<&str> = changed.lines().collect();
    changed.sort();
    assert_eq!(
        changed,
        [
            ".agents/skills/card-brief/SKILL.md",
            ".atelier/skill-links/card-brief.json",
            ".claude/skills/card-brief/SKILL.md",
        ]
    );
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/ply-skills/card-brief/SKILL.md");
    assert_eq!(std::fs::read(wt.join(".claude/skills/card-brief/SKILL.md")).unwrap(), std::fs::read(&bundle).unwrap());
    let (links, _) = crate::skill_links::read_checkout(&wt);
    let link = &links[SKILL];
    assert_eq!(link.origin.kind, crate::skill_links::KIND_PLYLOFT);
    assert_eq!(link.origin.version.commit, "1.155.0");
    assert_eq!(link.base.claude.as_deref(), Some(link.origin.version.content_id.as_str()));
    assert_eq!(link.base.codex.as_deref(), Some(link.origin.version.content_id.as_str()));
    // The shared definition is the one the repository had, byte for byte.
    assert_eq!(std::fs::read_to_string(wt.join(".atelier/workspace.json")).unwrap(), DEFINITION);
    let kind = card.skill_card().unwrap();
    assert_eq!(kind.verb, crate::skill_card::SkillVerb::Personalize);
    let base = card.worktree_base.as_ref().unwrap().commit.clone();
    assert!(crate::skill_card::card_only(&wt, &base, "HEAD", kind), "Ship's gate: only the skill");
    // One card per skill per workspace.
    assert!(personalize(&f).unwrap_err().contains("already on its way"));

    // Before it ships — and in a teammate's checkout that hasn't pulled it —
    // sessions still get Plyloft's: never neither copy.
    assert!(inputs(&f).decide(SKILL).on);
    land(&f, &card);
    // After: the fork in the checkout switches Plyloft's own off here.
    let decided = inputs(&f).decide(SKILL);
    assert_eq!(decided, crate::ply_skill_switch::Decision { on: false, level: crate::ply_skill_switch::Level::Fork });
    assert_eq!(inputs(&f).workspace.choice(SKILL), None, "no workspace choice was written");
    let row = links_row(&f);
    assert_eq!(row["originKind"], "plyloft");
    assert_eq!(row["originWords"], "Plyloft");
    assert_eq!(row["state"], "upToDate", "{row}");
    assert_eq!(row["upstreamVersion"], "1.155.0");
    // Personalized already: a second one is refused with the reason.
    assert!(personalize(&f).unwrap_err().contains("already linked to Plyloft"));
}

/// A repository with no shared definition: the card carries no definition
/// file, and the fork alone switches Plyloft's own copy off there. A copy of
/// the same name already here is refused. Editing a gated card beyond its
/// skill takes it through Verify.
#[test]
fn without_a_definition_the_fork_alone_switches_it_off() {
    let f = fixture(PlanCase::Free, false);
    write(&f.project, ".claude/skills/card-brief/SKILL.md", "---\nname: card-brief\ndescription: Mine.\n---\n");
    commit_all(&f.project, "mine");
    assert!(personalize(&f).unwrap_err().contains("already has a skill called card-brief"));
    git(&f.project, &["rm", "-q", "-r", ".claude/skills"]);
    git(&f.project, &["commit", "-q", "-m", "drop"]);
    let card = personalize(&f).unwrap();
    let wt = PathBuf::from(card.worktree_path.clone().unwrap());
    let changed = git(&wt, &["diff", "--name-only", "HEAD~1", "HEAD"]);
    assert!(!changed.contains("workspace.json"), "{changed}");
    let base = card.worktree_base.as_ref().unwrap().commit.clone();
    write(&wt, "app.txt", "x\n");
    commit_all(&wt, "more");
    assert!(!crate::skill_card::card_only(&wt, &base, "HEAD", card.skill_card().unwrap()));
    git(&wt, &["reset", "-q", "--hard", "HEAD~1"]);
    land(&f, &card);
    assert_eq!(inputs(&f).decide(SKILL).level, crate::ply_skill_switch::Level::Fork);
    // The workspace's explicit `on` wins over the fork (Q9).
    super::set_workspace_choice(f.app.handle(), &f.workspace_id, SKILL, Some(true)).unwrap();
    assert_eq!(
        inputs(&f).decide(SKILL),
        crate::ply_skill_switch::Decision { on: true, level: crate::ply_skill_switch::Level::Workspace }
    );
    super::set_workspace_choice(f.app.handle(), &f.workspace_id, SKILL, None).unwrap();
    assert_eq!(inputs(&f).decide(SKILL).level, crate::ply_skill_switch::Level::Fork);
}

/// A fork taken at an older Plyloft version reads *Update available ·
/// Plyloft 1.155.0*; Compare shows here → Plyloft now; Update, on every
/// plan, makes an Update card from the bundle. A fork edited here compares
/// from the version it started at (the bundle's history).
#[test]
fn a_fork_behind_plyloft_offers_an_update_from_the_bundle() {
    for policy in [PlanCase::Free, PlanCase::Pro] {
        let f = fixture(policy, false);
        let card = personalize(&f).unwrap();
        land(&f, &card);
        // Rewind the fork to 1.152.0's text, as if personalized then.
        let history = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/ply-skills-history/card-brief/1.152.0/SKILL.md");
        let old = std::fs::read_to_string(history).unwrap();
        for root in [".claude/skills", ".agents/skills"] {
            write(&f.project, &format!("{root}/card-brief/SKILL.md"), &old);
        }
        let link_file = f.project.join(".atelier/skill-links/card-brief.json");
        let text = std::fs::read_to_string(&link_file).unwrap();
        let (links, _) = crate::skill_links::read_checkout(&f.project);
        let now_id = links[SKILL].origin.version.content_id.clone();
        let old_id = "eade2f744682008a2ced157fd966ce1791c6b0b4";
        std::fs::write(&link_file, text.replace(&now_id, old_id).replace("1.155.0", "1.152.0")).unwrap();
        commit_all(&f.project, "older fork");
        let row = links_row(&f);
        assert_eq!(row["state"], "updateAvailable", "{row}");
        assert_eq!(row["upstreamVersion"], "1.155.0");
        let compare = invoke(&f, "skills_hub_compare", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap();
        assert_eq!(compare["right"]["label"], "Plyloft");
        assert!(compare["right"]["text"].as_str().unwrap().contains("Manual checks"), "{compare}");
        let updated = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL }));
        let card = updated.unwrap_or_else(|why| panic!("{policy:?}: {why}"));
        assert_eq!(card["title"], format!("Skill: update {SKILL} from Plyloft"));
        let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
        let diff = git(&wt, &["diff", "HEAD~1", "HEAD", "--", ".claude/skills"]);
        assert!(diff.contains("+from a missing one. If the project has none, call it `Manual checks`."), "{diff}");

        // Edited here: Compare starts from the version it started at.
        let edited = old.replace("# ", "# Our ");
        write(&f.project, ".claude/skills/card-brief/SKILL.md", &edited);
        write(&f.project, ".agents/skills/card-brief/SKILL.md", &edited);
        commit_all(&f.project, "ours");
        assert_eq!(links_row(&f)["state"], "bothChanged");
        let compare = invoke(&f, "skills_hub_compare", serde_json::json!({ "workspaceId": f.workspace_id, "skill": SKILL })).unwrap();
        assert_eq!(compare["left"]["label"], "Plyloft 1.152.0", "{compare}");
        assert!(compare["right"]["text"].as_str().unwrap().contains("# Our "), "{compare}");
    }
}

#[test]
fn the_team_default_refusal_names_the_owner() {
    assert_eq!(
        super::owner_only_words("card-brief", Some("matteo"), Some("ana")),
        "Only matteo can switch Plyloft's card-brief off for the team. You are signed in to GitHub as ana."
    );
    assert!(super::owner_only_words("x", None, None).contains("names no owner"));
}

/// The team writes here follow the team call-site rules (N14, v1.115.0):
/// the team's account scope opens before the owner gate, the paid gate comes
/// before the team library is written, and the manifest's owner is
/// re-decided inside the post-pull mutation. Pinned to the source: the work
/// runs on the blocking pool, where an IPC test cannot reach it.
#[test]
fn the_team_writes_run_as_the_team_and_behind_its_gates() {
    let source = include_str!("ply_skill_ipc.rs");
    let body = |head: &str| {
        let (_, rest) = source.split_once(head).unwrap_or_else(|| panic!("{head} must remain discoverable"));
        rest.split_once("\n}\n").expect("body").0.to_string()
    };
    let team = body("fn set_team_default(");
    let scope = team.find("team_account_scope(").expect("the team's account");
    let gate = team.find("team_owner_gate(").expect("the owner gate");
    let publish = team.find("publish_library_paths(").expect("the team write path");
    assert!(scope < gate && gate < publish);
    let mutation = &team[publish..];
    assert!(mutation.contains("authorize_owner_action("), "re-decided after the pull");
    let personalize = body("pub async fn ply_skill_personalize(");
    let paid = personalize.find("team_gate(&app.state::<crate::license::LicenseStore>())?").expect("the Team gate");
    let write = personalize.find("promote_into_library(").expect("the library write");
    assert!(paid < write, "the gate comes before the team library is written");
    assert!(personalize.find("promote_authorization(").unwrap() < write);
    // Challenger (H9): a team skill of the name already there is refused in
    // words that name it, never shared over; an owner whose team default
    // didn't follow hears why.
    assert!(personalize.contains("team_name_taken_words("));
    assert!(personalize.contains("team_switch_problem = Some(why)"));
}

#[test]
fn a_team_skill_of_the_name_is_named_in_the_refusal() {
    let words = super::team_name_taken_words("card-brief", "ply-team");
    assert!(words.contains("already has a card-brief (ply-team:card-brief)"), "{words}");
    assert!(words.contains("nothing was shared over it"), "{words}");
}
