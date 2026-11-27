//! Skills hub H8 (R5): Copy to…, its Update and the links it leaves, through
//! the registered IPC commands, on a mock app with real repositories — no
//! network (the origin's GitHub remote is only named in its config; nothing
//! here fetches it, and the destinations have no remote).

use std::path::{Path, PathBuf};

use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::webview::InvokeRequest;
use tauri::Manager;

use crate::license::PlanCase;

const SKILL: &str = "deploy-notes";

struct Fixture {
    _temp: tempfile::TempDir,
    app: tauri::App<MockRuntime>,
    webview: tauri::WebviewWindow<MockRuntime>,
    config: PathBuf,
    astra: PathBuf,
    notes: PathBuf,
    lyra: PathBuf,
    vega: PathBuf,
    ids: std::collections::BTreeMap<&'static str, String>,
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
    format!("---\nname: {SKILL}\ndescription: Deploy notes, {version}.\n---\n\nWrite the note.\n")
}

fn repo(root: &Path, name: &str) -> PathBuf {
    let dir = root.join(name);
    init(&dir);
    write(&dir, "README.md", &format!("{name}\n"));
    commit_all(&dir, "init");
    dir
}

fn fixture(policy: PlanCase) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    // Astra: the origin, with a GitHub repository (named, never fetched).
    let astra = repo(temp.path(), "astra");
    git(&astra, &["remote", "add", "origin", "https://github.com/acme/astra.git"]);
    write(&astra, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("v1"));
    write(&astra, &format!(".agents/skills/{SKILL}/SKILL.md"), &skill_text("v1"));
    commit_all(&astra, "v1");
    // A second checkout of Astra's repository.
    let astra2 = temp.path().join("astra-2");
    git(&astra, &["worktree", "add", "-q", astra2.to_str().unwrap(), "-b", "other"]);
    // Notes: an origin with no remote at all (local only).
    let notes = repo(temp.path(), "notes");
    write(&notes, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("n1"));
    commit_all(&notes, "n1");
    let lyra = repo(temp.path(), "lyra");
    let vega = repo(temp.path(), "vega");
    let plain = temp.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();

    let workspaces = crate::workspace::WorkspaceStore::new(config.clone()).unwrap();
    let mut ids = std::collections::BTreeMap::new();
    for (key, name, dir) in [
        ("astra", "Astra", &astra),
        ("astra2", "astra-2", &astra2),
        ("notes", "Notes", &notes),
        ("lyra", "Lyra", &lyra),
        ("vega", "Vega", &vega),
        ("plain", "Plain", &plain),
    ] {
        let ws = workspaces.create(name.into(), dir.to_string_lossy().into_owned()).unwrap();
        ids.insert(key, ws.id);
    }
    let settings = crate::settings::SettingsStore::new(config.clone()).unwrap();
    let app = mock_builder()
        .manage(workspaces)
        .manage(crate::kanban::KanbanStore::new(config.clone()).unwrap())
        .manage(settings)
        .manage(crate::license::LicenseStore::for_plan_test(config.clone(), policy))
        .manage(crate::team::TeamStore::new(config.clone()))
        .manage(crate::project_config::ProjectConfigStore::new(config.clone()).unwrap())
        .invoke_handler(tauri::generate_handler![
            crate::commands::skills_hub_update,
            crate::commands::skills_hub_links,
            crate::commands::skills_hub_compare,
            crate::commands::skills_hub_card_refresh,
            crate::commands::skills_hub_decisions::skills_hub_keep_mine,
            crate::commands::skills_hub_decisions::skills_hub_propose_upstream,
            crate::commands::skills_hub_copy::skills_hub_copy_targets,
            crate::commands::skills_hub_copy::skills_hub_copy_review,
            crate::commands::skills_hub_copy::skills_hub_copy_to,
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    Fixture { _temp: temp, app, webview, config, astra, notes, lyra, vega, ids }
}

fn invoke(f: &Fixture, command: &str, body: serde_json::Value) -> Result<serde_json::Value, serde_json::Value> {
    get_ipc_response(
        &f.webview,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
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

fn from(f: &Fixture, key: &str) -> serde_json::Value {
    serde_json::json!({ "kind": "workspace", "workspaceId": f.ids[key], "skill": SKILL })
}

fn copy_to(f: &Fixture, origin: &str, to: &[&str], scripts_ok: Option<Vec<String>>) -> Result<serde_json::Value, serde_json::Value> {
    let ids: Vec<&String> = to.iter().map(|key| &f.ids[key]).collect();
    let mut body = serde_json::json!({ "from": from(f, origin), "workspaceIds": ids });
    if let Some(ok) = scripts_ok {
        body["scriptsOk"] = serde_json::json!(ok);
    }
    invoke(f, "skills_hub_copy_to", body)
}

fn links(f: &Fixture, key: &str) -> Vec<serde_json::Value> {
    let view = invoke(f, "skills_hub_links", serde_json::json!({ "workspaceId": f.ids[key] })).unwrap();
    view["links"].as_array().unwrap().clone()
}

fn kanban(f: &Fixture) -> tauri::State<'_, crate::kanban::KanbanStore> {
    f.app.state::<crate::kanban::KanbanStore>()
}

/// Ship's local merge, as far as these tests need it.
fn land(f: &Fixture, key: &str, card: &serde_json::Value) {
    let dir = match key {
        "lyra" => &f.lyra,
        "vega" => &f.vega,
        other => panic!("no checkout {other}"),
    };
    git(dir, &["merge", "--ff-only", "-q", card["branchName"].as_str().unwrap()]);
    kanban(f)
        .with_card(&f.ids[key], card["id"].as_str().unwrap(), |c| {
            c.ship_status = crate::kanban::ShipStatus::Shipped;
            Ok(())
        })
        .unwrap();
}

fn changed(card: &serde_json::Value) -> Vec<String> {
    let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
    let mut out: Vec<String> = git(&wt, &["diff", "--name-only", "HEAD~1", "HEAD"]).lines().map(str::to_string).collect();
    out.sort();
    out
}

/// Tier 4 (H8) steps 1–2 and 5, as far as code can walk them: Copy from
/// Astra to Lyra and Vega on Free makes two skill cards — the copies and a
/// committed link record naming Astra's repository — with the checkouts
/// untouched; the picker refuses Astra's second checkout;
/// once landed both read up to date; a copy to a workspace already linked is
/// refused with the reason.
#[test]
fn copy_to_two_workspaces_makes_two_cards_with_a_committed_link() {
    let f = fixture(PlanCase::Free);
    let picker = invoke(&f, "skills_hub_copy_targets", serde_json::json!({ "from": from(&f, "astra") })).unwrap();
    assert_eq!(picker["cardTitle"], format!("Skill: copy {SKILL} from Astra"));
    assert_eq!((picker["claude"].as_bool(), picker["codex"].as_bool()), (Some(true), Some(true)));
    assert!(picker["localReason"].is_null(), "{picker}");
    let target = |name: &str| picker["targets"].as_array().unwrap().iter().find(|t| t["name"] == name).cloned().unwrap();
    assert!(picker["targets"].as_array().unwrap().iter().all(|t| t["name"] != "Astra"), "never itself");
    assert_eq!(target("Lyra")["target"]["kind"], "ready");
    assert_eq!(target("astra-2")["target"]["why"], "astra-2 is the same repository as Astra.");
    assert!(target("Plain")["target"]["why"].as_str().unwrap().contains("isn't a git repository"));

    let made = copy_to(&f, "astra", &["lyra", "vega"], None).unwrap();
    let cards = made["cards"].as_array().unwrap();
    assert_eq!(cards.len(), 2, "{made}");
    for copied in cards {
        let card = &copied["card"];
        assert_eq!(card["title"], format!("Skill: copy {SKILL} from Astra"));
        assert_eq!(card["kind"]["verb"], "copy");
        assert_eq!(card["kind"]["origin"]["kind"], "workspace");
        assert_eq!(card["kind"]["origin"]["source"], "acme/astra");
        assert_eq!(card["verifyStatus"], "passed");
        assert_eq!(
            changed(card),
            [
                format!(".agents/skills/{SKILL}/SKILL.md"),
                format!(".atelier/skill-links/{SKILL}.json"),
                format!(".claude/skills/{SKILL}/SKILL.md"),
            ]
        );
        let notes = card["notes"].as_str().unwrap();
        assert!(notes.contains("from their next session"), "{notes}");
    }
    assert!(!f.lyra.join(".claude/skills").exists(), "the checkout is never written");
    // The link record names the repository and commit, no machine path.
    let wt = PathBuf::from(cards[0]["card"]["worktreePath"].as_str().unwrap());
    let record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(wt.join(format!(".atelier/skill-links/{SKILL}.json"))).unwrap()).unwrap();
    assert_eq!(record["origin"]["path"], format!(".claude/skills/{SKILL}"));
    assert_eq!(record["origin"]["version"]["commit"], git(&f.astra, &["rev-parse", "HEAD"]).trim());
    assert!(record["origin"].get("workspaceId").is_none(), "{record}");

    // On its way: a second copy there is refused with why.
    let again = copy_to(&f, "astra", &["lyra"], None).unwrap_err();
    assert!(again.as_str().unwrap().contains("already on its way"), "{again}");

    land(&f, "lyra", &cards[0]["card"]);
    land(&f, "vega", &cards[1]["card"]);
    for key in ["lyra", "vega"] {
        let rows = links(&f, key);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["state"], "upToDate", "{rows:?}");
        assert_eq!(rows[0]["originWords"], "Astra");
        assert_eq!(rows[0]["local"], false);
    }
    // R5 AC 4: already linked to the same origin.
    let twice = copy_to(&f, "astra", &["lyra"], None).unwrap_err();
    assert_eq!(twice, "Lyra already has it, linked to Astra.");
}

/// R5 AC 2 and the Challenger edge: an uncommitted edit in Astra changes
/// nothing; once committed, Lyra and Vega say Update available; Update
/// is a card from Astra whose diff is v1 → v2, and up to date once it lands;
/// no card refresh, no proposal to Astra.
#[test]
fn an_edit_committed_in_the_origin_makes_the_copies_update_available() {
    let f = fixture(PlanCase::Free);
    let made = copy_to(&f, "astra", &["lyra", "vega"], None).unwrap();
    let cards = made["cards"].as_array().unwrap().clone();
    // Refresh card: a copy ships the version it copied.
    let refresh = invoke(
        &f,
        "skills_hub_card_refresh",
        serde_json::json!({ "workspaceId": f.ids["lyra"], "cardId": cards[0]["card"]["id"] }),
    )
    .unwrap_err();
    assert!(refresh.as_str().unwrap().contains("ships the version it copied"), "{refresh}");
    land(&f, "lyra", &cards[0]["card"]);
    land(&f, "vega", &cards[1]["card"]);

    write(&f.astra, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("v2"));
    assert_eq!(links(&f, "lyra")[0]["state"], "upToDate", "an uncommitted edit is not upstream");
    write(&f.astra, &format!(".agents/skills/{SKILL}/SKILL.md"), &skill_text("v2"));
    commit_all(&f.astra, "v2");
    for key in ["lyra", "vega"] {
        assert_eq!(links(&f, key)[0]["state"], "updateAvailable", "{key}");
    }
    let compare = invoke(&f, "skills_hub_compare", serde_json::json!({ "workspaceId": f.ids["lyra"], "skill": SKILL })).unwrap();
    assert!(compare["right"]["text"].as_str().unwrap().contains("v2"), "{compare}");
    assert_eq!(compare["right"]["label"], "Astra");

    let card = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.ids["lyra"], "skill": SKILL })).unwrap();
    assert_eq!(card["title"], format!("Skill: update {SKILL} from Astra"));
    assert_eq!(card["kind"]["verb"], "update");
    let wt = PathBuf::from(card["worktreePath"].as_str().unwrap());
    let diff = git(&wt, &["diff", "HEAD~1", "HEAD", "--", &format!(".claude/skills/{SKILL}/SKILL.md")]);
    assert!(diff.contains("-description: Deploy notes, v1.") && diff.contains("+description: Deploy notes, v2."), "{diff}");
    land(&f, "lyra", &card);
    assert_eq!(links(&f, "lyra")[0]["state"], "upToDate");
    assert_eq!(links(&f, "vega")[0]["state"], "updateAvailable");

    // Propose mine upstream is not a pull request into Astra.
    write(&f.vega, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("mine"));
    commit_all(&f.vega, "mine");
    let propose = invoke(&f, "skills_hub_propose_upstream", serde_json::json!({ "workspaceId": f.ids["vega"], "skill": SKILL }));
    let refusal = propose.unwrap_err();
    assert!(refusal.as_str().unwrap().contains("make it in Astra and ship it there"), "{refusal}");
}

/// R5 edge (local-only origin): Notes has no GitHub repository, so the card
/// commits the copy alone and the link is kept on this Mac — not shown
/// until the card lands, then "Linked on this Mac" (local) and up to date;
/// a commit in Notes makes it Update available, and the Update's link takes
/// over once its card lands. A card deleted before it shipped takes its
/// link with it.
#[test]
fn a_copy_of_a_local_only_workspace_is_linked_on_this_mac() {
    let f = fixture(PlanCase::Free);
    let picker = invoke(&f, "skills_hub_copy_targets", serde_json::json!({ "from": from(&f, "notes") })).unwrap();
    assert!(picker["localReason"].as_str().unwrap().contains("Notes has no GitHub repository"), "{picker}");
    assert_eq!((picker["claude"].as_bool(), picker["codex"].as_bool()), (Some(true), Some(false)), "Claude only at Notes");

    let made = copy_to(&f, "notes", &["lyra", "vega"], None).unwrap();
    let cards = made["cards"].as_array().unwrap().clone();
    let card = &cards[0]["card"];
    assert_eq!(card["kind"]["localLink"], true);
    assert_eq!(changed(card), [format!(".claude/skills/{SKILL}/SKILL.md")], "the copy alone, no record");
    let state = crate::skills_hub_state::load(&f.config);
    assert!(state.local_links[&f.ids["lyra"]][SKILL].pending);
    assert!(links(&f, "lyra").is_empty(), "not shown before its card lands");
    land(&f, "lyra", card);
    let rows = links(&f, "lyra");
    assert_eq!((rows[0]["state"].as_str(), rows[0]["local"].as_bool()), (Some("upToDate"), Some(true)));
    assert_eq!(rows[0]["originWords"], "Notes");
    assert!(!crate::skills_hub_state::load(&f.config).local_links[&f.ids["lyra"]][SKILL].pending);

    write(&f.notes, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("n2"));
    commit_all(&f.notes, "n2");
    assert_eq!(links(&f, "lyra")[0]["state"], "updateAvailable");
    let update = invoke(&f, "skills_hub_update", serde_json::json!({ "workspaceId": f.ids["lyra"], "skill": SKILL })).unwrap();
    assert_eq!(update["kind"]["localLink"], true);
    assert!(crate::skills_hub_state::load(&f.config).local_links[&f.ids["lyra"]][SKILL].next.is_some());
    assert_eq!(links(&f, "lyra")[0]["state"], "updateAvailable", "until the update lands");
    land(&f, "lyra", &update);
    assert_eq!(links(&f, "lyra")[0]["state"], "upToDate");
    assert!(crate::skills_hub_state::load(&f.config).local_links[&f.ids["lyra"]][SKILL].next.is_none());
    // A decision card would commit a record its origin can't be named in.
    let keep = invoke(&f, "skills_hub_keep_mine", serde_json::json!({ "workspaceId": f.ids["lyra"], "skill": SKILL })).unwrap_err();
    assert!(keep.as_str().unwrap().contains("link is kept on"), "{keep}");

    // Vega's card deleted before it shipped: its link is forgotten.
    kanban(&f).delete_card(&f.ids["vega"], cards[1]["card"]["id"].as_str().unwrap()).unwrap();
    assert!(links(&f, "vega").is_empty());
    assert!(crate::skills_hub_state::load(&f.config).local_links.get(&f.ids["vega"]).is_none());
}

/// R15 (H6b) for a copy: a skill that brings a script shows the sheet first
/// — refused with the marker without the OK — and the OK makes the card,
/// the script at 100755 in it.
#[cfg(unix)]
#[test]
fn a_copy_that_brings_a_script_asks_first() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(PlanCase::Free);
    let script = f.astra.join(format!(".claude/skills/{SKILL}/scripts/check.sh"));
    write(&f.astra, &format!(".claude/skills/{SKILL}/scripts/check.sh"), "#!/bin/sh\necho ok\n");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    commit_all(&f.astra, "script");
    let refused = copy_to(&f, "astra", &["lyra"], None).unwrap_err();
    assert!(refused.as_str().unwrap().contains(crate::skill_card::SCRIPTS_WAIT_MARKER), "{refused}");
    assert!(kanban(&f).load(&f.ids["lyra"]).unwrap().is_empty(), "no card without the OK");
    let review = invoke(&f, "skills_hub_copy_review", serde_json::json!({ "from": from(&f, "astra") })).unwrap();
    assert_eq!(review["files"][0]["path"], "scripts/check.sh");
    assert_eq!(review["files"][0]["kind"], "script");
    let ok: Vec<String> = serde_json::from_value(review["scriptsIds"].clone()).unwrap();
    let wrong = copy_to(&f, "astra", &["lyra"], Some(vec!["other".into()])).unwrap_err();
    assert!(wrong.as_str().unwrap().contains("changed in Astra while you were reading it"), "{wrong}");
    let made = copy_to(&f, "astra", &["lyra"], Some(ok)).unwrap();
    let wt = PathBuf::from(made["cards"][0]["card"]["worktreePath"].as_str().unwrap());
    let mode = git(&wt, &["ls-tree", "HEAD", &format!(".claude/skills/{SKILL}/scripts/check.sh")]);
    assert!(mode.starts_with("100755"), "{mode}");
}

/// A destination with a different copy of the same name: the picker says
/// so, the copy is refused until the member chooses to replace it, then the
/// card replaces it and links it.
#[test]
fn a_different_copy_of_the_name_is_replaced_only_when_chosen() {
    let f = fixture(PlanCase::Free);
    write(&f.lyra, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("lyra's own"));
    commit_all(&f.lyra, "own");
    let picker = invoke(&f, "skills_hub_copy_targets", serde_json::json!({ "from": from(&f, "astra") })).unwrap();
    let lyra = picker["targets"].as_array().unwrap().iter().find(|t| t["name"] == "Lyra").cloned().unwrap();
    assert_eq!(lyra["target"]["kind"], "replace");
    let refused = copy_to(&f, "astra", &["lyra"], None).unwrap_err();
    assert!(refused.as_str().unwrap().contains("Choose to replace it first"), "{refused}");
    let body = serde_json::json!({ "from": from(&f, "astra"), "workspaceIds": [f.ids["lyra"]], "replace": [f.ids["lyra"]] });
    let made = invoke(&f, "skills_hub_copy_to", body).unwrap();
    let card = &made["cards"][0]["card"];
    land(&f, "lyra", card);
    assert_eq!(links(&f, "lyra")[0]["state"], "upToDate");
}

/// Copy to… stays free on every plan: none of its commands calls the team
/// gate (the work runs on the blocking pool, so the source is pinned).
#[test]
fn copy_to_is_free_for_every_member() {
    let source = include_str!("skills_hub_copy.rs");
    assert!(!source.contains("team_gate(&"), "Copy to… never asks for the Team plan");
}

/// Challenger (H8): a destination that already holds exactly Notes's copy
/// has nothing for a card to commit when the link is kept on this Mac only —
/// the picker says it is linked at once, and Create links it with no card.
#[test]
fn a_local_copy_already_there_is_linked_at_once_with_no_card() {
    let f = fixture(PlanCase::Free);
    write(&f.lyra, &format!(".claude/skills/{SKILL}/SKILL.md"), &skill_text("n1"));
    commit_all(&f.lyra, "the same copy, by hand");
    let picker = invoke(&f, "skills_hub_copy_targets", serde_json::json!({ "from": from(&f, "notes") })).unwrap();
    let lyra = picker["targets"].as_array().unwrap().iter().find(|t| t["name"] == "Lyra").cloned().unwrap();
    assert_eq!(lyra["target"]["kind"], "linkHere", "{picker}");
    let made = copy_to(&f, "notes", &["lyra"], None).unwrap();
    assert!(made["cards"].as_array().unwrap().is_empty(), "{made}");
    assert_eq!(made["linked"][0]["name"], "Lyra");
    assert!(kanban(&f).load(&f.ids["lyra"]).unwrap().is_empty(), "no card");
    let rows = links(&f, "lyra");
    assert_eq!((rows[0]["state"].as_str(), rows[0]["local"].as_bool()), (Some("upToDate"), Some(true)), "{rows:?}");
    let again = copy_to(&f, "notes", &["lyra"], None).unwrap_err();
    assert_eq!(again, "Lyra already has it, linked to Notes.");
}

/// Challenger (H8): a workspace removed from Plyloft takes its links kept on
/// this Mac with it; a copy whose local origin was removed still names it,
/// and reads not available — never Removed.
#[test]
fn removing_a_workspace_forgets_its_local_links_and_keeps_the_origin_name() {
    let f = fixture(PlanCase::Free);
    let made = copy_to(&f, "notes", &["lyra", "vega"], None).unwrap();
    let cards = made["cards"].as_array().unwrap().clone();
    land(&f, "lyra", &cards[0]["card"]);
    // The origin goes: Lyra's row still says Notes, not available.
    f.app.state::<crate::workspace::WorkspaceStore>().delete(&f.ids["notes"]).unwrap();
    let rows = links(&f, "lyra");
    assert_eq!(rows[0]["originWords"], "Notes", "{rows:?}");
    assert_eq!(rows[0]["state"], "notAvailable", "{rows:?}");
    // The destination goes: what this Mac kept for it goes too.
    assert!(crate::skills_hub_state::load(&f.config).local_links.contains_key(&f.ids["vega"]));
    crate::skills_hub_state::forget_workspace(&f.config, &f.ids["vega"], 1).unwrap();
    let state = crate::skills_hub_state::load(&f.config);
    assert!(!state.local_links.contains_key(&f.ids["vega"]));
    assert!(state.local_links.contains_key(&f.ids["lyra"]), "another workspace's are kept");
    // workspace_delete calls it (source-pinned: its States are many).
    let delete = include_str!("commands.rs").split_once("pub fn workspace_delete(").unwrap().1;
    assert!(delete.split_once("\n}\n").unwrap().0.contains("skills_hub_state::forget_workspace("));
}

/// Challenger (H8): upstream is Astra's checkout `HEAD`, but a removal is a
/// claim about Astra's own line of work — a checkout switched to a branch
/// that drops the skill reads not available, never Removed; back on its
/// target branch it is up to date again.
#[test]
fn an_origin_on_another_branch_never_reads_as_removed() {
    let f = fixture(PlanCase::Free);
    let made = copy_to(&f, "astra", &["lyra"], None).unwrap();
    land(&f, "lyra", &made["cards"][0]["card"]);
    assert_eq!(links(&f, "lyra")[0]["state"], "upToDate");
    git(&f.astra, &["checkout", "-q", "-b", "spike"]);
    git(&f.astra, &["rm", "-r", "-q", ".claude/skills", ".agents/skills"]);
    git(&f.astra, &["commit", "-q", "-m", "drop it on a spike"]);
    assert_eq!(links(&f, "lyra")[0]["state"], "notAvailable", "a branch is not a removal");
    git(&f.astra, &["checkout", "-q", "--detach", "HEAD"]);
    assert_eq!(links(&f, "lyra")[0]["state"], "notAvailable", "nor is a detached HEAD");
    git(&f.astra, &["checkout", "-q", "main"]);
    assert_eq!(links(&f, "lyra")[0]["state"], "upToDate");
    // On its target branch, a committed removal is one (R8, kind workspace).
    git(&f.astra, &["rm", "-r", "-q", ".claude/skills", ".agents/skills"]);
    git(&f.astra, &["commit", "-q", "-m", "drop it"]);
    assert_eq!(links(&f, "lyra")[0]["state"], "removed");
}

/// Mac walk (H8): with Astra's repository in two checkouts here — astra-2 a
/// worktree on another branch, listed first — a copy made from Astra names
/// Astra: the workspace this Mac copied from first, then the checkout on
/// its target branch that is the repository's own, never list order.
#[test]
fn two_checkouts_of_the_origin_name_the_one_copied_from() {
    let f = fixture(PlanCase::Free);
    let store = f.app.state::<crate::workspace::WorkspaceStore>();
    store.delete(&f.ids["astra"]).unwrap();
    let astra = store.create("Astra".into(), f.astra.to_string_lossy().into_owned()).unwrap();
    assert_eq!(store.snapshot().workspaces.iter().position(|w| w.name == "astra-2") < store.snapshot().workspaces.iter().position(|w| w.name == "Astra"), true);
    let body = serde_json::json!({
        "from": { "kind": "workspace", "workspaceId": astra.id, "skill": SKILL },
        "workspaceIds": [f.ids["lyra"]],
    });
    let made = invoke(&f, "skills_hub_copy_to", body).unwrap();
    land(&f, "lyra", &made["cards"][0]["card"]);
    assert_eq!(crate::skills_hub_state::load(&f.config).copy_origins["acme/astra"], astra.id);
    assert_eq!(links(&f, "lyra")[0]["originWords"], "Astra", "the workspace it was copied from");
    // Without that record (another Mac's copy): the repository's own
    // checkout on its target branch, not the worktree listed first.
    crate::skills_hub_state::update(&f.config, 1, |state| state.copy_origins.clear()).unwrap();
    assert_eq!(links(&f, "lyra")[0]["originWords"], "Astra");
    // Removing Astra forgets the record.
    crate::skills_hub_state::update(&f.config, 2, |state| {
        state.copy_origins.insert("acme/astra".into(), astra.id.clone());
    })
    .unwrap();
    crate::skills_hub_state::forget_workspace(&f.config, &astra.id, 3).unwrap();
    assert!(crate::skills_hub_state::load(&f.config).copy_origins.is_empty());
}

/// Mac re-walk (H8 step 8): a copy of this Mac's own skill keeps the
/// folder's path in its link (not the path it was staged at in
/// `stage.git`), so once shipped it reads up to date — and an edit to the
/// folder reads update available. A link written before the fix (path
/// `spec-verify`) is found by its name. Its `linkedAt` is a date, as every
/// link's.
#[test]
fn a_copy_of_this_macs_own_skill_reads_up_to_date_once_shipped() {
    use crate::skill_links::{link_state, LinkState};
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let dir = home.join(".claude/skills/spec-verify");
    write(&dir, "SKILL.md", "---\nname: spec-verify\ndescription: Checks a spec.\n---\n");
    let (found, path, reach) = crate::skill_copy::this_mac_skill(&home, "spec-verify").unwrap();
    let stage = crate::skill_copy::stage_repo(&temp.path().join("config"));
    let (commit, staged) = crate::skill_copy::stage_dir(&stage, "spec-verify", &found).unwrap();
    let source = crate::skill_card::read_source(&stage, &commit, &staged).unwrap();
    let origin = crate::skill_links::LinkOrigin {
        kind: crate::skill_copy::KIND_THIS_MAC.into(),
        name: "spec-verify".into(),
        path: Some(path.clone()),
        version: crate::skill_links::LinkVersion { commit: String::new(), content_id: source.tree.clone(), extra: Default::default() },
        ..Default::default()
    };
    let roots = crate::skill_card::roots_to_write(reach, &Default::default());
    let link = crate::skill_card::link_for(None, &origin, &source, roots);
    assert_eq!(link.origin.path.as_deref(), Some(".claude/skills/spec-verify"), "the folder, not the staged path");
    assert_eq!(link.origin.version.commit, "", "no stage.git commit in the link");
    assert_eq!(link.linked_at.as_deref().map(str::len), Some(10), "a date: {:?}", link.linked_at);
    let here = roots.ids(&source.tree);
    let upstream = crate::commands::skills_hub_copy::this_mac_upstream_in(&home, &link.origin);
    assert_eq!(link_state(&link, &here, &upstream), LinkState::UpToDate);
    // A link from before the fix names the staged path.
    let mut old = link.clone();
    old.origin.path = Some("spec-verify".into());
    let upstream = crate::commands::skills_hub_copy::this_mac_upstream_in(&home, &old.origin);
    assert_eq!(link_state(&old, &here, &upstream), LinkState::UpToDate);
    // An edit to the folder is an update.
    write(&dir, "SKILL.md", "---\nname: spec-verify\ndescription: Checks a spec, v2.\n---\n");
    let upstream = crate::commands::skills_hub_copy::this_mac_upstream_in(&home, &link.origin);
    assert_eq!(link_state(&link, &here, &upstream), LinkState::UpdateAvailable);
}

/// Windows walk (H8): a git read that ran out of time is said plainly — never
/// "isn't a git repository", and never git's own text; a folder with no
/// `.git` at all is the one "isn't a git repository".
#[test]
fn a_read_that_ran_out_of_time_is_not_a_missing_repository() {
    use crate::commands::skills_hub_copy::{plain, read_failure};
    let raw = "git ls-tree -r -z -l f3fb2205 -- .claude/skills/deploy-check/: TimedOut".to_string();
    let words = plain("astra", raw);
    assert_eq!(words, "Plyloft couldn't read astra's committed copy in time. Try again.");
    assert!(!words.contains("git ") && !words.contains("git repository"));
    assert_eq!(read_failure("astra", "git rev-parse failed: fatal"), "Plyloft couldn't read astra's committed copy. Try again.");
    // Plyloft's own sentences go through as they are.
    assert_eq!(plain("astra", "astra has no commit yet.".into()), "astra has no commit yet.");
    // A plain folder is still the one "isn't a git repository".
    let f = fixture(PlanCase::Free);
    let body = serde_json::json!({ "from": { "kind": "workspace", "workspaceId": f.ids["plain"], "skill": SKILL } });
    let refused = invoke(&f, "skills_hub_copy_targets", body).unwrap_err();
    assert!(refused.as_str().unwrap().contains("isn't a git repository"), "{refused}");
}
