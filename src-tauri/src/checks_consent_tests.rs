//! 1.175.0 B2 (SEC-4): the rule in `checks_consent`, on the values alone and
//! on the store. The refresh's part is proved where a refresh can be run
//! (`workspace_definition_tests.rs`); the migration cases are there too.

use super::*;
use crate::worktree_setup::WorktreeSettings;

fn script(path: &str) -> VerifyKind {
    VerifyKind::Script { path: path.to_string() }
}

fn slash(name: &str, args: &[&str]) -> VerifyKind {
    VerifyKind::SlashCommand { name: name.to_string(), args: args.iter().map(|a| a.to_string()).collect() }
}

fn config(pipeline: Option<Vec<VerifyKind>>, install: Option<&str>) -> ProjectConfig {
    ProjectConfig {
        schema_version: crate::project_config::PROJECT_CONFIG_SCHEMA_VERSION,
        target_branch: "main".into(),
        version_files: Vec::new(),
        install_script: install.map(str::to_string),
        try_command: None,
        verify_pipeline: pipeline,
        verify_script: None,
        cache_paths: Vec::new(),
        shared_build_cache: true,
        self_check: true,
        review_checklist: Vec::new(),
        blocking_findings: Default::default(),
        created_at: 0,
        updated_at: 0,
    }
}

fn store() -> (tempfile::TempDir, ProjectConfigStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = ProjectConfigStore::new(dir.path().join("config")).unwrap();
    (dir, store)
}

/// The hash is of what would run: a Claude step's arguments are in it, and
/// only spelling that changes nothing is left out.
#[test]
fn the_hash_follows_what_runs_and_a_claude_steps_arguments_are_in_it() {
    let base = vec![script("./scripts/check.sh"), slash("/ppvp", &[])];
    assert_eq!(pipeline_hash(&base), pipeline_hash(&[script(" ./scripts/check.sh "), slash("ppvp", &[""])]));
    for other in [
        vec![script("./scripts/check.sh")],
        vec![script("./scripts/other.sh"), slash("/ppvp", &[])],
        vec![slash("/ppvp", &[]), script("./scripts/check.sh")],
        vec![script("./scripts/check.sh"), slash("/ppvp", &["then tidy the release folder"])],
        vec![script("./scripts/check.sh"), slash("/ppvp", &["then", "tidy"])],
        vec![script("./scripts/check.sh"), slash("/other", &[])],
    ] {
        assert_ne!(pipeline_hash(&base), pipeline_hash(&other), "{other:?}");
    }
    // Two arguments aren't one argument with a space in it.
    assert_ne!(pipeline_hash(&[slash("p", &["a", "b"])]), pipeline_hash(&[slash("p", &["a b"])]));
    // A script named like a command isn't that command.
    assert_ne!(pipeline_hash(&[script("/ppvp")]), pipeline_hash(&[slash("/ppvp", &[])]));
}

#[test]
fn the_steps_say_a_script_by_its_path_and_a_claude_step_by_its_command() {
    let steps = steps_of(&[script("./scripts/check.sh"), slash("ppvp", &["then tidy", "", "the release folder"])]);
    assert_eq!(
        steps,
        vec![
            CheckStep { claude: false, text: "./scripts/check.sh".into(), args: None },
            CheckStep { claude: true, text: "/ppvp".into(), args: Some("then tidy the release folder".into()) },
        ]
    );
    assert_eq!(steps_of(&[slash("//ppvp", &[])])[0], CheckStep { claude: true, text: "/ppvp".into(), args: None });
}

/// Round 2 (G4): a record is enforced whether or not the setup is shared
/// now; a project that never had one never asks.
#[test]
fn a_record_is_enforced_shared_or_not_and_a_project_without_one_never_asks() {
    let theirs = approved_of(&[script("a.sh")]);
    let other = [script("b.sh")];
    for shared in [true, false] {
        assert!(!checks_allowed_with(shared, Some(&theirs), &other), "shared: {shared}");
        assert!(checks_allowed_with(shared, Some(&theirs), &[script("a.sh")]));
        assert!(!install_allowed_with(shared, Some(&ApprovedInstall { path: Some("a.sh".into()) }), Some("b.sh")));
    }
    assert!(checks_allowed_with(false, None, &other), "never shared, nothing recorded");
    assert!(install_allowed_with(false, None, Some("b.sh")));
}

/// A record must match. Nothing recorded on a project that was never shared
/// runs; on a shared one it asks (round 2, G5: the refresh writes the record
/// down, so none there means it was lost, or no refresh ran yet).
#[test]
fn a_recorded_value_must_match_and_no_record_asks_only_on_a_shared_project() {
    let pipeline = [script("a.sh"), slash("/ppvp", &["x"])];
    assert!(checks_allowed_with(false, None, &pipeline));
    assert!(!checks_allowed_with(true, None, &pipeline));
    assert!(checks_allowed_with(true, Some(&approved_of(&pipeline)), &pipeline));
    assert!(!checks_allowed_with(true, Some(&approved_of(&[script("a.sh"), slash("/ppvp", &["y"])])), &pipeline));
    // Nothing allowed yet (a new clone): the first value asks.
    assert!(!checks_allowed_with(true, Some(&approved_of(&[])), &pipeline));
    // No checks at all never ask.
    assert!(checks_allowed_with(true, Some(&approved_of(&pipeline)), &[]));
    assert!(checks_allowed_with(true, None, &[]));

    assert!(install_allowed_with(false, None, Some("scripts/install.sh")));
    assert!(!install_allowed_with(true, None, Some("scripts/install.sh")));
    assert!(install_allowed_with(true, Some(&ApprovedInstall { path: Some("scripts/install.sh".into()) }), Some(" scripts/install.sh ")));
    assert!(!install_allowed_with(true, Some(&ApprovedInstall { path: None }), Some("scripts/install.sh")));
    assert!(install_allowed_with(true, Some(&ApprovedInstall { path: Some("x".into()) }), None));
    assert!(install_allowed_with(true, Some(&ApprovedInstall { path: Some("x".into()) }), Some("  ")));
}

/// Round 2 (G5): the encoding under the hash is injective — a separator
/// inside a path or an argument can't make two pipelines one.
#[test]
fn no_two_pipelines_share_a_hash_by_where_their_fields_end() {
    let pairs: [(Vec<VerifyKind>, Vec<VerifyKind>); 4] = [
        (vec![script("a\nb")], vec![script("a"), script("b")]),
        (vec![slash("p", &["a\0b"])], vec![slash("p", &["a", "b"])]),
        (vec![script("a.sh\nslash\0/p")], vec![script("a.sh"), slash("/p", &[])]),
        (vec![slash("p", &["x"]), script("y")], vec![slash("p", &["x", "y"])]),
    ];
    for (one, other) in pairs {
        assert_ne!(pipeline_hash(&one), pipeline_hash(&other), "{one:?} / {other:?}");
    }
}

/// The record begins at the first refresh of a shared setup. A computer
/// that followed it already (the update to 1.175.0) records what it runs; a
/// first read records what it ran before the read when that differs, and
/// nothing when the repository's value merely equals what it had.
#[test]
fn the_record_begins_with_what_was_in_use_and_a_refresh_never_allows() {
    let (_dir, store) = store();
    let before = config(Some(vec![script("a.sh")]), Some("scripts/install.sh"));
    // A setup that shares no project part starts nothing.
    before_repository_apply(&store, "ws", Some(&before), &["name"], Some("giulia"), None, false, false).unwrap();
    assert_eq!(load_settings(&store, "ws"), WorktreeSettings::default());
    // The update: nothing changed, the values in use are the allowed ones.
    before_repository_apply(&store, "ws", Some(&before), &[], Some("giulia"), None, false, true).unwrap();
    let settings = load_settings(&store, "ws");
    assert_eq!(settings.approved_verify, Some(approved_of(&[script("a.sh")])));
    assert_eq!(settings.approved_install, Some(ApprovedInstall { path: Some("scripts/install.sh".into()) }));
    assert_eq!((settings.verify_changed, settings.install_changed), (None, None), "nobody changed anything");

    // A change from the branch: the allowed one stays; who changed it is kept.
    let second = config(Some(vec![script("b.sh")]), Some("scripts/install.sh"));
    before_repository_apply(&store, "ws", Some(&second), &["verifyPipeline"], Some("bob"), Some(1_700_000_000), false, true).unwrap();
    let settings = load_settings(&store, "ws");
    assert_eq!(settings.approved_verify, Some(approved_of(&[script("a.sh")])), "a refresh never allows");
    assert_eq!(settings.verify_changed, Some(ChangeNote { who: Some("bob".into()), at: 1_700_000_000_000 }));

    // A new clone: nothing was in use, so nothing is allowed; nobody is named.
    before_repository_apply(&store, "new", None, &["verifyPipeline", "installScript"], Some("giulia"), None, true, true).unwrap();
    let fresh = load_settings(&store, "new");
    assert_eq!(fresh.approved_verify, Some(approved_of(&[])));
    assert_eq!(fresh.approved_install, Some(ApprovedInstall { path: None }));
    assert_eq!(fresh.verify_changed.as_ref().and_then(|n| n.who.clone()), None);

    // Round 2 (G5): a first read whose values equal what this computer
    // detected by itself. Nobody here was shown them as the repository's:
    // nothing is recorded as allowed, so the first run asks.
    before_repository_apply(&store, "same", Some(&before), &[], Some("giulia"), None, true, true).unwrap();
    let same = load_settings(&store, "same");
    assert_eq!(same.approved_verify, Some(approved_of(&[])));
    assert_eq!(same.approved_install, Some(ApprovedInstall { path: None }));
    // A first read that brings other values keeps what ran before it as allowed.
    before_repository_apply(&store, "other", Some(&before), &["verifyPipeline"], None, None, true, true).unwrap();
    assert_eq!(load_settings(&store, "other").approved_verify, Some(approved_of(&[script("a.sh")])));
}

/// Allow and run allows the value that was shown, and refuses a newer one
/// with the sentence of `STRINGS-sharing.md`.
#[test]
fn an_ok_lands_only_on_the_value_that_was_shown() {
    let (_dir, store) = store();
    store.set("ws", config(Some(vec![script("a.sh")]), Some("scripts/install.sh"))).unwrap();
    let shown = pipeline_hash(&[script("a.sh")]);
    // It changes between the read and the press.
    store.set("ws", config(Some(vec![script("a.sh"), slash("/ppvp", &["tidy"])]), Some("scripts/deploy-all.sh"))).unwrap();
    assert_eq!(
        approve_checks(&store, "ws", &shown).unwrap_err(),
        "The checks changed since you looked. Look at them again before allowing them."
    );
    assert_eq!(load_settings(&store, "ws").approved_verify, None, "nothing was allowed");
    assert_eq!(approve_install(&store, "ws", "scripts/install.sh").unwrap_err(), INSTALL_CHANGED_SINCE);
    assert_eq!(load_settings(&store, "ws").approved_install, None);

    let now = pipeline_hash(&[script("a.sh"), slash("/ppvp", &["tidy"])]);
    approve_checks(&store, "ws", &now).unwrap();
    let settings = load_settings(&store, "ws");
    assert_eq!(settings.approved_verify.as_ref().map(|a| a.hash.as_str()), Some(now.as_str()));
    assert_eq!(settings.approved_verify.unwrap().steps.len(), 2);
    assert_eq!(approve_install(&store, "ws", " scripts/deploy-all.sh ").unwrap(), None);
    assert_eq!(
        load_settings(&store, "ws").approved_install,
        Some(ApprovedInstall { path: Some("scripts/deploy-all.sh".into()) })
    );
    assert_eq!(approve_install(&store, "ws", "").unwrap_err(), INSTALL_CHANGED_SINCE);
}

/// A change made on this computer allows itself, and only the value that changed.
#[test]
fn a_change_made_here_allows_itself() {
    let (_dir, store) = store();
    store.set("ws", config(Some(vec![script("a.sh")]), Some("scripts/install.sh"))).unwrap();
    let before = in_use(&store, "ws");
    approve_own_edit(&store, "ws", &before);
    assert_eq!(load_settings(&store, "ws"), WorktreeSettings::default(), "nothing changed, nothing written");

    store.set("ws", config(Some(vec![script("mine.sh")]), Some("scripts/install.sh"))).unwrap();
    approve_own_edit(&store, "ws", &before);
    let settings = load_settings(&store, "ws");
    assert_eq!(settings.approved_verify, Some(approved_of(&[script("mine.sh")])));
    assert_eq!(settings.approved_install, None);

    // A page's Publish names its fields.
    let base = serde_json::json!({ "verifyPipeline": [{ "kind": "script", "path": "a.sh" }], "installScript": "x" });
    let draft = serde_json::json!({ "verifyPipeline": [{ "kind": "script", "path": "a.sh" }], "installScript": "y" });
    assert_eq!(edited_fields(base.as_object().unwrap(), draft.as_object().unwrap()), (false, true));
    approve_own(&store, "ws", false, true);
    assert_eq!(
        load_settings(&store, "ws").approved_install,
        Some(ApprovedInstall { path: Some("scripts/install.sh".into()) })
    );
}

/// A file from 1.174.5 has none of the fields: it reads, and reads back the
/// same once written. A field of the wrong type reads as unset and the rest stays.
#[test]
fn a_settings_file_from_before_1_175_reads_and_keeps_its_fields() {
    let (_dir, store) = store();
    let path = crate::worktree_setup::settings_path(&store, "ws");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let old = r#"{"worktreeCopy":[".env"],"worktreeSetup":"npm ci","envProposal":"copy","approvedSetup":"npm ci","approvedTry":"npm run dev"}"#;
    std::fs::write(&path, old).unwrap();
    let settings = load_settings(&store, "ws");
    assert_eq!(settings.approved_setup.as_deref(), Some("npm ci"));
    assert_eq!(
        (&settings.approved_verify, &settings.approved_install, &settings.verify_changed, &settings.install_changed, &settings.install_waiting),
        (&None, &None, &None, &None, &None)
    );
    save_settings(&store, "ws", &settings).unwrap();
    let written: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(written, serde_json::from_str::<serde_json::Value>(old).unwrap(), "no new key is written while unset");

    // Round 2 (G5): a record that is there and can't be read is not "no
    // record" — it matches nothing, so it asks; the rest of the file stays.
    std::fs::write(&path, r#"{"approvedSetup":"npm ci","approvedVerify":"yes","approvedInstall":7,"installWaiting":[]}"#).unwrap();
    let odd = load_settings(&store, "ws");
    assert_eq!(odd.approved_setup.as_deref(), Some("npm ci"));
    assert_eq!(odd.install_waiting, None);
    assert_eq!(odd.approved_verify, Some(ApprovedVerify::default()));
    assert_eq!(odd.approved_install, Some(ApprovedInstall::default()));
    for shared in [true, false] {
        assert!(!checks_allowed_with(shared, odd.approved_verify.as_ref(), &[script("a.sh")]), "a damaged record asks");
        assert!(!install_allowed_with(shared, odd.approved_install.as_ref(), Some("scripts/install.sh")));
    }
    std::fs::write(&path, r#"{"approvedVerify":{"steps":[]},"approvedInstall":null}"#).unwrap();
    let half = load_settings(&store, "ws");
    assert_eq!(half.approved_verify, Some(ApprovedVerify::default()), "a record without its hash matches nothing");
    assert_eq!(half.approved_install, None, "null is no record");

    // The new fields round-trip.
    let mut with = WorktreeSettings::default();
    with.approved_verify = Some(approved_of(&[script("a.sh"), slash("/ppvp", &["x"])]));
    with.approved_install = Some(ApprovedInstall { path: Some("scripts/install.sh".into()) });
    with.verify_changed = Some(ChangeNote { who: Some("giulia".into()), at: 5 });
    with.install_waiting = Some(InstallWaiting { tag: Some("v1.4.0".into()), at: 6 });
    save_settings(&store, "ws", &with).unwrap();
    assert_eq!(load_settings(&store, "ws"), with);
}

/// The card's mark: a board from 1.174.5 has none and loads as before; a
/// held card goes back to its last result, never to "passed" by itself.
#[test]
fn a_card_without_the_hold_loads_and_a_held_card_keeps_its_last_result() {
    let mut card = crate::kanban::KanbanCard::new("card-1".into(), "ws".into(), "A card".into(), None, crate::kanban::KanbanColumnId::InProgress);
    let json = serde_json::to_value(&card).unwrap();
    assert!(json.get("checksHold").is_none(), "not written while unset");
    let back: crate::kanban::KanbanCard = serde_json::from_value(json).unwrap();
    assert_eq!(back.checks_hold, None);
    assert_eq!(serde_json::to_value(&back).unwrap(), serde_json::to_value(&card).unwrap(), "a card from before the field loads unchanged");

    card.verify_status = crate::kanban::VerifyStatus::Queued;
    crate::verify::held_card(&mut card, 42, None);
    assert_eq!(card.verify_status, crate::kanban::VerifyStatus::None);
    // Round 2 (G5): what it said before the queue comes back — a Skipped
    // card stays Skipped, whatever its last recorded run was.
    for before in [crate::kanban::VerifyStatus::Skipped, crate::kanban::VerifyStatus::Passed, crate::kanban::VerifyStatus::Failed] {
        card.verify_status = crate::kanban::VerifyStatus::Queued;
        crate::verify::held_card(&mut card, 42, Some(before));
        assert_eq!(card.verify_status, before);
    }
    crate::verify::held_card(&mut card, 42, Some(crate::kanban::VerifyStatus::Running));
    assert_eq!(card.verify_status, crate::kanban::VerifyStatus::None, "a run under way is no state to go back to");
    assert_eq!(card.checks_hold, Some(ChecksHold { at: 42 }));
    let json = serde_json::to_value(&card).unwrap();
    assert_eq!(json["checksHold"]["at"], 42);
}

/// The gate is in the worker, before the first step of a config pipeline:
/// no caller can start unallowed checks. Read from the source, as the
/// neighbouring pins are.
#[test]
fn the_verify_worker_asks_before_the_first_step() {
    let source = include_str!("verify.rs");
    let gate = source.find("if !crate::checks_consent::checks_allowed_for(&project_config_state, &job.workspace_id, pipeline) {").expect("the gate");
    let run = source.find("run_config_pipeline(\n                    &app,").expect("the run");
    assert!(gate < run, "the gate comes before the pipeline runs");
    let between = &source[gate..run];
    assert!(between.contains("hold_for_consent(&app, &inner, &kanban_state, &job);") && between.contains("return;"));
    // A held run writes no result: the card's history is what it was.
    let hold = &source[source.find("fn hold_for_consent(").unwrap()..source.find("fn clear_checks_hold(").unwrap()];
    assert!(!hold.contains("persist_outcome") && !hold.contains("verify_history.push"));
}

/// The install step is held at every place a release starts it, and a press
/// on "Run the install step" isn't the OK.
#[test]
fn every_install_launch_asks_first() {
    let ship = include_str!("ship.rs");
    assert_eq!(ship.matches("if let Some(held) = install_held(").count(), 3, "ship_card, ship_batch, run_release_install");
    assert!(ship.contains("and_then(|store| install_held(&store, workspace_id, &tag, config.install_script.as_deref()))"), "publish_pending");
    // Round 2 (G5): each asks about the script it is about to start.
    assert_eq!(ship.matches("config.install_script.as_deref())").count() >= 4, true);
    let release = include_str!("release_pr.rs");
    assert!(release.contains("Some(_) if held.is_some() => held.unwrap_or_default(),"));
    assert_eq!(release.matches("if let Some(refusal) = checks_refusal(place) {").count(), 2, "both runs of the release's checks");
    let commands = include_str!("commands.rs");
    // Round 2 (G5): after the merge succeeded, never before it — a merge
    // that stopped on a conflict leaves no install step waiting.
    let hold = commands.find("match install_script.filter(|script| !crate::checks_consent::hold_install_of(&project_config, &workspace_id, None, Some(script))) {").expect("the hold");
    let merged = commands.find("on_landed(&format!(\"merged locally as {}\", short_sha(&publish)));").expect("the merge landed");
    assert!(merged < hold, "the install step is held only once the merge is in");
    assert!(!commands.contains("c.install_script).filter(|_| !crate::checks_consent::hold_install("));
}

/// A hold whose checks no longer need an OK is taken off, and nothing else
/// of the card moves.
#[test]
fn a_stale_hold_is_released_without_running_anything() {
    let dir = tempfile::tempdir().unwrap();
    let kanban = crate::kanban::KanbanStore::new(dir.path().to_path_buf()).unwrap();
    for id in ["held", "free"] {
        let card = crate::kanban::KanbanCard::new(id.into(), "ws".into(), "A card".into(), None, crate::kanban::KanbanColumnId::InProgress);
        kanban.create_card("ws", card).unwrap();
    }
    kanban.with_card("ws", "held", |card| {
        crate::verify::held_card(card, 7, None);
        Ok(())
    }).unwrap();
    assert_eq!(release_stale_holds(&kanban, "ws"), 1);
    let card = kanban.get_card("ws", "held").unwrap();
    assert_eq!(card.checks_hold, None);
    assert_eq!(card.verify_status, crate::kanban::VerifyStatus::None);
    assert!(card.verify_history.is_empty());
    assert_eq!(release_stale_holds(&kanban, "ws"), 0);
}

/// The held run's reason is the card's label, and the window knows it by
/// that: it is never shown as a failure nor sent to the Builder to fix.
#[test]
fn a_held_run_is_known_to_the_window_by_its_reason() {
    assert_eq!(crate::verify::CHECKS_NEED_OK, "The checks need your OK");
    let words = include_str!("../../src/lib/checksConsent.ts");
    assert!(words.contains("export const CHECKS_OK_LABEL = \"The checks need your OK\";"));
    assert!(words.contains("state?.kind === \"failed\" && state.reason === CHECKS_OK_LABEL"));
    assert!(include_str!("../../src/components/BuilderRunStep.tsx").contains("if (isChecksHold(verify?.state)) return;"));
}

/// Round 2 (G5): one of two builds whose checks wait for the OK is waiting,
/// not failed, and the comparison doesn't start while it waits.
#[test]
fn a_build_whose_checks_wait_is_not_a_failed_build() {
    use crate::build_both::{lane_verify_from_status, LANE_WAITS};
    use crate::verify::VerifyStateOut;
    let held = VerifyStateOut::Failed { reason: crate::verify::CHECKS_NEED_OK.to_string() };
    let lane = lane_verify_from_status(&held, &[], "abc", 5).unwrap();
    assert_eq!((lane.status.as_str(), lane.summary.as_deref()), (LANE_WAITS, Some("The checks need your OK")));
    let failed = lane_verify_from_status(&VerifyStateOut::Failed { reason: "exit code 1".into() }, &[], "abc", 5).unwrap();
    assert_eq!(failed.status, "failed");
    let source = include_str!("build_both.rs");
    let (_, step) = source.split_once("pub fn compare_step(").unwrap();
    let step = step.split_once("\n}\n").unwrap().0;
    let waits = step.find("v.status == LANE_WAITS").expect("a waiting build holds the comparison");
    assert!(waits < step.find("CompareStep::Run").unwrap());
    // Allow and run starts the waiting builds' checks again.
    let allow = include_str!("checks_consent.rs");
    assert!(allow.contains("crate::build_both::restart_waiting_lanes(&app, &workspace_id, &id) > 0"));
}
