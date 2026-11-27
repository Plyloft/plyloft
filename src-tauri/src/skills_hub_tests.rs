//! Skills hub H2: the scheduler's clock, one pull at a time, the record of
//! each attempt (R16's three refusals over 30 minutes, R17's leaving), and
//! what a pull changed (the toast).

use super::*;
use crate::skills_hub_state::LibraryState;

const MIN: i64 = 60 * 1000;

// ── The clock ───────────────────────────────────────────────────────

#[test]
fn the_first_pull_waits_for_its_time_then_is_the_startup_one() {
    let start = 1_000_000;
    let due_at = start + 10_000;
    assert_eq!(due(start + 5_000, start, due_at, INTERVAL, None, true), None);
    assert_eq!(due(due_at, start + 5_000, due_at, INTERVAL, None, true), Some(Trigger::Startup));
    assert_eq!(due(due_at, start + 5_000, due_at, INTERVAL, None, false), Some(Trigger::Timer));
}

#[test]
fn the_cadence_pulls_when_due_and_not_before() {
    let last = 50 * MIN;
    let next = last + 10 * MIN;
    assert_eq!(due(last + MIN, last, next, INTERVAL, Some(last), false), None);
    assert_eq!(due(next, next - MIN, next, INTERVAL, Some(last), false), Some(Trigger::Timer));
}

/// R1 edge (Mac and Windows alike): a look at the clock that finds it jumped
/// by more than twice the interval is a wake; it pulls when the last pull is
/// older than the interval, whatever the cadence says.
#[test]
fn a_clock_jump_past_twice_the_interval_is_a_wake() {
    let before_sleep = 100 * MIN;
    let after_wake = before_sleep + 3 * 60 * MIN;
    let next = before_sleep + 5 * MIN; // also overdue, but the wake names it
    assert_eq!(
        due(after_wake, before_sleep, next, INTERVAL, Some(before_sleep - MIN), false),
        Some(Trigger::Wake)
    );
    // Never pulled at all: a wake pulls too.
    assert_eq!(due(after_wake, before_sleep, i64::MAX, INTERVAL, None, false), Some(Trigger::Wake));
    // A jump of less than twice the interval is not a wake.
    assert_eq!(
        due(before_sleep + 15 * MIN, before_sleep, i64::MAX, INTERVAL, Some(before_sleep), false),
        None
    );
    // A wake right after a pull (a Refresh pressed on waking) owes nothing.
    assert_eq!(
        due(after_wake, before_sleep, i64::MAX, INTERVAL, Some(after_wake - MIN), false),
        None
    );
}

#[test]
fn the_tick_and_the_jitter_stay_in_bounds() {
    assert_eq!(tick(INTERVAL), MAX_TICK);
    assert_eq!(tick(Duration::from_secs(30)), Duration::from_secs(15));
    assert_eq!(tick(Duration::from_secs(1)), Duration::from_secs(1));
    for _ in 0..50 {
        let j = jitter_ms(INTERVAL);
        assert!((-60_000..=60_000).contains(&j), "{j}");
        let short = jitter_ms(Duration::from_secs(30));
        assert!((-3_000..=3_000).contains(&short), "{short}");
    }
}

/// Walk of H2: the first pull is ~10 s after launch, not a whole tick (60 s).
#[test]
fn the_loop_never_sleeps_past_the_next_due_pull() {
    let start = 1_000_000;
    let due_at = start + STARTUP_DELAY.as_millis() as i64;
    assert_eq!(sleep_for(start, due_at, INTERVAL), STARTUP_DELAY);
    assert_eq!(sleep_for(start, start + 600_000, INTERVAL), MAX_TICK);
    assert_eq!(sleep_for(due_at + 5, due_at, INTERVAL), Duration::ZERO);
}

/// Only a dev build with the test bridge can change the cadence.
#[test]
fn the_interval_is_ten_minutes_unless_a_walk_sets_it() {
    assert_eq!(INTERVAL, Duration::from_secs(600));
    let source = include_str!("skills_hub.rs");
    let (_, setter) = source.split_once("pub(crate) fn set_interval_override(").expect("the setter");
    let before = &source[..source.find("pub(crate) fn set_interval_override(").unwrap()];
    assert!(before.trim_end().ends_with("#[cfg(all(feature = \"test-bridge\", debug_assertions))]"));
    assert!(setter.contains("INTERVAL_OVERRIDE_SECS.store"));
    let bridge = include_str!("test_bridge.rs");
    assert!(bridge.contains("\"app.skillsHubInterval\" => skills_hub_interval("));
}

// ── One pull at a time ──────────────────────────────────────────────

/// R1 edge: two triggers at once are one pull; the second takes the first's
/// answer.
#[test]
fn a_second_pull_waits_for_the_first_and_takes_its_answer() {
    let flight: &'static Flight<u32> = Box::leak(Box::new(Flight::new()));
    let runs = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let started = std::sync::Arc::new(std::sync::Barrier::new(2));
    let first = {
        let (runs, started) = (runs.clone(), started.clone());
        std::thread::spawn(move || {
            flight.run(false, || {
                started.wait();
                std::thread::sleep(Duration::from_millis(200));
                Some(runs.fetch_add(1, Ordering::SeqCst) + 7)
            })
        })
    };
    started.wait();
    let second = {
        let runs = runs.clone();
        std::thread::spawn(move || flight.run(true, || Some(runs.fetch_add(1, Ordering::SeqCst) + 100)))
    };
    assert_eq!(first.join().unwrap(), Some(7));
    assert_eq!(second.join().unwrap(), Some(7));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    // Once it has landed, the next caller runs its own.
    assert_eq!(flight.run(false, || Some(9)), Some(9));
}

/// A Refresh that met a background pull which held back (`None`) runs its
/// own; a background caller takes the `None`.
#[test]
fn a_refresh_after_a_held_back_pull_runs_its_own() {
    let flight: &'static Flight<u32> = Box::leak(Box::new(Flight::new()));
    let started = std::sync::Arc::new(std::sync::Barrier::new(2));
    let first = {
        let started = started.clone();
        std::thread::spawn(move || {
            flight.run(false, || {
                started.wait();
                std::thread::sleep(Duration::from_millis(150));
                None
            })
        })
    };
    started.wait();
    let refresh = std::thread::spawn(move || flight.run(true, || Some(5)));
    assert_eq!(first.join().unwrap(), None);
    assert_eq!(refresh.join().unwrap(), Some(5));
}

#[test]
fn a_pull_that_panics_still_lands() {
    let flight: &'static Flight<u32> = Box::leak(Box::new(Flight::new()));
    let crashed = std::thread::spawn(move || flight.run(false, || -> Option<u32> { panic!("boom") }));
    assert!(crashed.join().is_err());
    assert_eq!(flight.run(false, || Some(1)), Some(1));
}

// ── The record of an attempt ────────────────────────────────────────

fn verdict(attempt: Attempt, membership: Membership, login: Option<&str>) -> Verdict {
    Verdict {
        attempt,
        membership,
        login: login.map(str::to_string),
    }
}

fn member(login: &str) -> LibraryState {
    LibraryState {
        member_login: Some(login.into()),
        ..Default::default()
    }
}

#[test]
fn a_pull_that_goes_through_records_when_and_clears_the_failures() {
    let mut lib = member("ana");
    lib.failures = 2;
    lib.first_failure_at = Some(1);
    lib.last_error = Some("noAccess".into());
    lib.access_lost = Some(5);
    lib.kept_last_copy = true;
    let effects = record_attempt(
        &mut lib,
        &verdict(Attempt::Pulled, Membership::Member, Some("ana")),
        Some("abc"),
        Some("Acme"),
        1_000,
    );
    assert_eq!(effects, Effects { member_login: Some("ana".into()), ..Default::default() });
    assert_eq!(lib.last_pull_at, Some(1_000));
    assert_eq!(lib.last_attempt_at, Some(1_000));
    assert_eq!(lib.last_pull_commit.as_deref(), Some("abc"));
    assert_eq!(lib.team_name.as_deref(), Some("Acme"));
    assert_eq!((lib.failures, lib.first_failure_at, lib.access_lost), (0, None, None));
    assert!(!lib.kept_last_copy);
    assert_eq!(lib.last_error, None);
}

/// R16: offline is not a refusal — it neither counts nor clears the count.
#[test]
fn offline_keeps_the_last_pull_and_counts_nothing() {
    let mut lib = member("ana");
    lib.last_pull_at = Some(10);
    lib.failures = 1;
    record_attempt(&mut lib, &verdict(Attempt::NotPulled, Membership::Unknown, None), None, None, 99);
    assert_eq!(lib.last_pull_at, Some(10));
    assert_eq!(lib.last_attempt_at, Some(99));
    assert_eq!(lib.last_error.as_deref(), Some("offline"));
    assert_eq!(lib.failures, 1);
    assert_eq!(lib.access_lost, None);
}

/// R16 edge: access is declared lost only after three refusals over at
/// least 30 minutes, and once.
#[test]
fn access_is_lost_after_three_refusals_over_thirty_minutes() {
    let mut lib = member("ana");
    let refused = verdict(Attempt::NotPulled, Membership::NoRepoAccess, Some("ana"));
    let t0 = 1_000 * MIN;
    assert!(!record_attempt(&mut lib, &refused, None, None, t0).access_lost);
    assert!(!record_attempt(&mut lib, &refused, None, None, t0 + 10 * MIN).access_lost);
    // Three, but only 20 minutes: not yet.
    assert!(!record_attempt(&mut lib, &refused, None, None, t0 + 20 * MIN).access_lost);
    assert_eq!(lib.access_lost, None);
    assert_eq!(lib.last_error.as_deref(), Some("noAccess"));
    let effects = record_attempt(&mut lib, &refused, None, None, t0 + 30 * MIN);
    assert!(effects.access_lost);
    assert_eq!(lib.access_lost, Some(t0 + 30 * MIN));
    // Said once.
    assert!(!record_attempt(&mut lib, &refused, None, None, t0 + 40 * MIN).access_lost);
    assert_eq!(lib.access_lost, Some(t0 + 30 * MIN));
    // Access restored: the next pull that goes through clears it all.
    record_attempt(&mut lib, &verdict(Attempt::Pulled, Membership::Member, Some("ana")), None, None, t0 + 50 * MIN);
    assert_eq!((lib.access_lost, lib.failures), (None, 0));
}

/// A refusal of another account (gh switched), or of an account that was
/// never a member here (still joining), is not a revocation.
#[test]
fn a_refusal_about_another_account_counts_nothing() {
    let refused_bo = verdict(Attempt::NotPulled, Membership::NoRepoAccess, Some("bo"));
    let mut lib = member("ana");
    for i in 0..5 {
        record_attempt(&mut lib, &refused_bo, None, None, i * 20 * MIN);
    }
    assert_eq!((lib.failures, lib.access_lost), (0, None));
    let mut joining = LibraryState::default();
    for i in 0..5 {
        record_attempt(&mut joining, &refused_bo, None, None, i * 20 * MIN);
    }
    assert_eq!((joining.failures, joining.access_lost), (0, None));
}

/// R17: the manifest no longer lists the account this Mac was a member as.
#[test]
fn not_listed_after_being_a_member_is_leaving_and_stays_left() {
    let mut lib = member("ana");
    let gone = verdict(Attempt::Pulled, Membership::NotListed, Some("ANA"));
    let effects = record_attempt(&mut lib, &gone, Some("def"), Some("Acme"), 500);
    assert!(effects.left);
    assert_eq!(lib.left_at, Some(500));
    // A read after leaving clones the library to ask: it goes again, and the
    // time it left stays the first one.
    assert!(record_attempt(&mut lib, &gone, None, None, 600).left);
    assert_eq!(lib.left_at, Some(500));
    // Rejoined: listed again clears it.
    record_attempt(&mut lib, &verdict(Attempt::Pulled, Membership::Member, Some("ana")), None, None, 700);
    assert_eq!(lib.left_at, None);
}

/// Onboarding: a member the owner hasn't added yet is `NotListed` from the
/// start — never told they left.
#[test]
fn not_listed_before_ever_being_a_member_is_not_leaving() {
    let mut lib = LibraryState::default();
    let effects = record_attempt(
        &mut lib,
        &verdict(Attempt::Pulled, Membership::NotListed, Some("ana")),
        None,
        None,
        1,
    );
    assert!(!effects.left);
    assert_eq!(lib.left_at, None);
    // A member answer makes them one.
    record_attempt(&mut lib, &verdict(Attempt::Pulled, Membership::Member, Some("ana")), None, None, 2);
    assert_eq!(lib.member_login.as_deref(), Some("ana"));
}

#[test]
fn a_stale_answer_is_no_answer() {
    let mut status: TeamStatus =
        crate::team::status(None, None, None, &[], &dummy_workspaces(), &dummy_team(), false);
    status.membership = Membership::NoRepoAccess;
    status.login = Some("ana".into());
    status.membership_stale = true;
    let v = Verdict::of(&status, Attempt::NotPulled);
    assert_eq!((v.membership, v.login), (Membership::Unknown, None));
    status.membership_stale = false;
    let v = Verdict::of(&status, Attempt::NotPulled);
    assert_eq!((v.membership, v.login.as_deref()), (Membership::NoRepoAccess, Some("ana")));
}

fn dummy_workspaces() -> crate::workspace::WorkspaceStore {
    let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
    crate::workspace::WorkspaceStore::new(dir.path().to_path_buf()).unwrap()
}

fn dummy_team() -> crate::team::TeamStore {
    let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
    crate::team::TeamStore::new(dir.path().to_path_buf())
}

#[test]
fn a_sync_counts_as_pulled_only_without_a_pull_error() {
    let ok = SyncOutcome { path: "/x".into(), cloned: false, pull_error: None };
    let cloned = SyncOutcome { path: "/x".into(), cloned: true, pull_error: None };
    let failed = SyncOutcome { path: "/x".into(), cloned: false, pull_error: Some("no".into()) };
    assert_eq!(classify_sync(&Ok(ok)), Attempt::Pulled);
    assert_eq!(classify_sync(&Ok(cloned)), Attempt::Pulled);
    assert_eq!(classify_sync(&Ok(failed)), Attempt::NotPulled);
    assert_eq!(classify_sync(&Err("offline".into())), Attempt::NotPulled);
}

// ── What a pull changed ─────────────────────────────────────────────

#[test]
fn library_paths_name_their_skill_and_twins_are_one() {
    assert_eq!(skill_of("library/claude/acme/skills/review-rules/SKILL.md"), Some("review-rules"));
    assert_eq!(skill_of("library/codex/plugins/acme/skills/review-rules/SKILL.md"), Some("review-rules"));
    assert_eq!(skill_of("library/claude/acme/skills/review-rules/scripts/x.sh"), Some("review-rules"));
    assert_eq!(skill_of("library/claude/acme/.claude-plugin/plugin.json"), None);
    assert_eq!(skill_of("library/knowledge/auth.md"), None);
    assert_eq!(skill_of("team.json"), None);
    // A file directly under skills/ is no skill directory.
    assert_eq!(skill_of("library/claude/acme/skills/README.md"), None);
}

fn log_record(name: &str, email: &str, files: &[&str]) -> String {
    format!("{RECORD}{name}{FIELD}{email}\n\n{}\n", files.join("\n"))
}

/// R1 AC / R14: one change per skill, its authors newest first; the member's
/// own commits (their login, or GitHub's noreply address for it) are no news.
#[test]
fn changes_group_by_skill_and_leave_out_the_members_own() {
    let log = [
        log_record("Ana", "ana@acme.dev", &["library/claude/acme/skills/review-rules/SKILL.md"]),
        log_record("matteo", "1+matteo@users.noreply.github.com", &["library/claude/acme/skills/deploy/SKILL.md"]),
        log_record("Bo", "bo@acme.dev", &[
            "library/codex/plugins/acme/skills/review-rules/SKILL.md",
            "library/claude/acme/skills/check/SKILL.md",
            "team.json",
        ]),
        log_record("Matteo B", "12+Matteo@users.noreply.github.com", &["library/claude/acme/skills/own/SKILL.md"]),
        log_record("Ana", "ana@acme.dev", &["library/claude/acme/skills/review-rules/SKILL.md"]),
    ]
    .concat();
    let changes = parse_changes(&log, Some("matteo"));
    assert_eq!(
        changes,
        vec![
            SkillChange { skill: "review-rules".into(), authors: vec!["Ana".into(), "Bo".into()] },
            SkillChange { skill: "check".into(), authors: vec!["Bo".into()] },
        ]
    );
    // No login known: nothing is left out.
    assert_eq!(parse_changes(&log, None).len(), 4);
    assert!(parse_changes("", Some("matteo")).is_empty());
}

fn git(dir: &Path, args: &[&str]) {
    let out = crate::platform::git_command().args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn rev(dir: &Path) -> String {
    let out = crate::platform::git_command().args(["rev-parse", "HEAD"]).current_dir(dir).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit_as(dir: &Path, name: &str, email: &str, path: &str, body: &str) {
    let file = dir.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, body).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["-c", &format!("user.name={name}"), "-c", &format!("user.email={email}"), "commit", "-q", "-m", path]);
}

/// The real git log of a pulled range, read the way the pull reads it.
#[test]
fn changed_skills_reads_the_pulled_range() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q"]);
    commit_as(dir, "Owner", "o@x", "team.json", "{}");
    let before = rev(dir);
    commit_as(dir, "Ana", "ana@x", "library/claude/acme/skills/review-rules/SKILL.md", "v2");
    commit_as(dir, "matteo", "9+matteo@users.noreply.github.com", "library/claude/acme/skills/mine/SKILL.md", "x");
    commit_as(dir, "Bo", "bo@x", "library/knowledge/notes.md", "k");
    let after = rev(dir);
    assert_eq!(head_of(dir).as_deref(), Some(after.as_str()));
    let changes = changed_skills(dir, &before, &after, Some("matteo"), None).unwrap();
    assert_eq!(changes, vec![SkillChange { skill: "review-rules".into(), authors: vec!["Ana".into()] }]);
    assert!(changed_skills(dir, &after, &after, None, None).unwrap().is_empty());
}

/// (Challenger) A commit Plyloft made with the member's git identity (it
/// couldn't read the login) is the member's own: no toast about yourself.
#[test]
fn a_commit_with_the_members_git_identity_is_their_own() {
    let log = [
        log_record("Matteo", "Matteo@Example.dev", &["library/claude/acme/skills/mine/SKILL.md"]),
        log_record("Ana", "ana@acme.dev", &["library/claude/acme/skills/review-rules/SKILL.md"]),
    ]
    .concat();
    let changes = parse_changes_by_others(&log, Some("matteo-dev"), Some(" matteo@example.dev "));
    assert_eq!(changes, vec![SkillChange { skill: "review-rules".into(), authors: vec!["Ana".into()] }]);
    assert_eq!(parse_changes_by_others(&log, Some("matteo-dev"), Some("")).len(), 2);
}

/// (Challenger, R17 vs GH #226) Only a clone this read cloned, still at that
/// commit with nothing changed or added, may be deleted outright; a commit
/// or an edit of the member's sends it to the Trash instead.
#[test]
fn only_a_fresh_untouched_clone_holds_nothing_local() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("clone");
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    commit_as(&dir, "Owner", "o@x", "team.json", "{}");
    let fresh = rev(&dir);
    assert!(holds_nothing_local(&dir, Some(&fresh)));
    // Not cloned by this read: never.
    assert!(!holds_nothing_local(&dir, None));
    // An edit, or a new file.
    std::fs::write(dir.join("team.json"), "{\"x\":1}").unwrap();
    assert!(!holds_nothing_local(&dir, Some(&fresh)));
    git(&dir, &["checkout", "-q", "--", "team.json"]);
    std::fs::write(dir.join("draft.md"), "mine").unwrap();
    assert!(!holds_nothing_local(&dir, Some(&fresh)));
    std::fs::remove_file(dir.join("draft.md")).unwrap();
    // A commit since.
    commit_as(&dir, "Matteo", "m@x", "library/claude/acme/skills/mine/SKILL.md", "x");
    assert!(!holds_nothing_local(&dir, Some(&fresh)));
    // Not a checkout at all.
    assert!(!holds_nothing_local(&tmp.path().join("absent"), Some(&fresh)));
}

/// (Challenger) GitHub answered, but a clone that waits on the member was
/// not brought level: access is fine (the refusal run clears), "Updated …"
/// keeps its time and says why.
#[test]
fn a_pull_held_by_the_clone_clears_refusals_but_is_not_an_update() {
    let mut status = crate::team::status(None, None, None, &[], &dummy_workspaces(), &dummy_team(), false);
    assert_eq!(held_by_the_clone(Attempt::Pulled, &status), Attempt::Pulled);
    status.library_interruption =
        Some(crate::team::LibraryInterruption { own: false, clone_dir: "/x".into() });
    assert_eq!(held_by_the_clone(Attempt::Pulled, &status), Attempt::Held);
    assert_eq!(held_by_the_clone(Attempt::NotPulled, &status), Attempt::NotPulled);

    let mut lib = member("ana");
    lib.last_pull_at = Some(10);
    lib.failures = 2;
    lib.first_failure_at = Some(1);
    let effects = record_attempt(&mut lib, &verdict(Attempt::Held, Membership::Member, Some("ana")), Some("abc"), None, 99);
    assert!(!effects.left && !effects.access_lost);
    assert_eq!(lib.last_pull_at, Some(10));
    assert_eq!(lib.last_pull_commit, None);
    assert_eq!(lib.last_error.as_deref(), Some("held"));
    assert_eq!((lib.failures, lib.first_failure_at), (0, None));
}

/// (Challenger) A pull that waited on the clone's lock while the member
/// switched the library off does not clone it back: the switch is read
/// again under the lock.
#[test]
fn a_pull_waiting_on_the_lock_reads_the_switch_again() {
    let team = dummy_team();
    let mut asked = false;
    assert!(team.sync_unless("acme/team", || { asked = true; true }).is_none());
    assert!(asked);
    assert!(!team.clone_dir("acme/team").exists(), "nothing cloned");
    let tmp = tempfile::tempdir().unwrap();
    assert!(!switched_off_now(tmp.path(), &team_key("acme/team")));
    crate::skills_hub_state::update(tmp.path(), 1, |state| {
        state.libraries.entry(team_key("acme/team")).or_default().switched_off = true;
    })
    .unwrap();
    assert!(switched_off_now(tmp.path(), &team_key("Acme/Team")));
}

// ── What the pages read ─────────────────────────────────────────────

#[test]
fn the_view_reads_the_record_and_the_gate() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(view(tmp.path(), "acme/team", false, None).last_pull_at, None);
    crate::skills_hub_state::update(tmp.path(), 1, |state| {
        let lib = state.libraries.entry(team_key("Acme/Team")).or_default();
        lib.last_pull_at = Some(42);
        lib.last_error = Some("offline".into());
        lib.team_name = Some("Acme".into());
    })
    .unwrap();
    let v = view(tmp.path(), "acme/team", true, Some("Team plan needed"));
    assert_eq!(v.library, "team:acme/team");
    assert_eq!((v.last_pull_at, v.last_error.as_deref()), (Some(42), Some("offline")));
    assert_eq!(v.held_back.as_deref(), Some("plan"));
    assert_eq!(v.team_name.as_deref(), Some("Acme"));
    assert!(v.has_clone);
    assert!(delivers(tmp.path(), "acme/team"));
}

/// R16 / R17: a library switched off, or left, delivers nothing — even if its
/// clone stayed on this Mac.
#[test]
fn switched_off_or_left_delivers_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(delivers(tmp.path(), "acme/team"), "no record: delivers");
    crate::skills_hub_state::update(tmp.path(), 1, |state| {
        state.libraries.entry(team_key("acme/team")).or_default().switched_off = true;
    })
    .unwrap();
    assert!(!delivers(tmp.path(), "acme/team"));
    crate::skills_hub_state::update(tmp.path(), 1, |state| {
        let lib = state.libraries.entry(team_key("acme/team")).or_default();
        lib.switched_off = false;
        lib.left_at = Some(3);
    })
    .unwrap();
    assert!(!delivers(tmp.path(), "ACME/team"));
    assert!(delivers(tmp.path(), "other/team"));
}

#[test]
fn the_access_question_belongs_to_its_clone_until_answered() {
    let tmp = tempfile::tempdir().unwrap();
    let clone = tmp.path().join("team").join(crate::team::slug_dir_name("Acme/Team"));
    assert!(access_lost_question(tmp.path(), &clone).is_none());
    crate::skills_hub_state::update(tmp.path(), 1, |state| {
        state.libraries.entry(team_key("Acme/Team")).or_default().access_lost = Some(7);
    })
    .unwrap();
    let (key, lib) = access_lost_question(tmp.path(), &clone).expect("asked");
    assert_eq!((key.as_str(), lib.access_lost), ("team:acme/team", Some(7)));
    let other = tmp.path().join("team").join(crate::team::slug_dir_name("bo/team"));
    assert!(access_lost_question(tmp.path(), &other).is_none());
    crate::skills_hub_state::update(tmp.path(), 1, |state| {
        state.libraries.entry(team_key("acme/team")).or_default().kept_last_copy = true;
    })
    .unwrap();
    assert!(access_lost_question(tmp.path(), &clone).is_none(), "Keep the last copy answers it");
}

#[test]
fn a_clone_the_same_read_cloned_is_deleted_any_other_is_trashed() {
    let tmp = tempfile::tempdir().unwrap();
    let fresh = tmp.path().join("fresh");
    std::fs::create_dir_all(&fresh).unwrap();
    git(&fresh, &["init", "-q"]);
    commit_as(&fresh, "Owner", "o@x", "team.json", "{}");
    let head = rev(&fresh);
    assert_eq!(remove_clone(&fresh, Some(&head)), None);
    assert!(!fresh.exists());
    assert_eq!(remove_clone(&tmp.path().join("absent"), None), None);
}

/// Windows walk of H2: an ex-member whose clone already left is asked about
/// with `team.json` alone; only one listed again clones. A Mac still in the
/// team, or one whose clone stayed, goes the usual way.
#[test]
fn an_ex_member_without_a_clone_is_asked_before_anything_is_cloned() {
    let mut record = member("ana");
    assert!(!asks_before_cloning(&record, false), "a member clones as ever");
    record.left_at = Some(5);
    assert!(asks_before_cloning(&record, false));
    assert!(!asks_before_cloning(&record, true), "a clone that stayed is pulled (and moved again)");

    let probe_with = || {
        |manifest: Option<&crate::team::TeamManifest>| crate::team::MembershipProbe {
            membership: crate::team::evaluate_membership(manifest.map(|m| m.lists("ana")), true),
            login: Some("ana".into()),
            can_write: None,
            errors: Vec::new(),
        }
    };
    let still_out = left_member_probe(
        || Ok(Some(r#"{"name":"Acme","members":[{"login":"bo"}]}"#.into())),
        probe_with(),
    );
    assert_eq!(still_out.membership, Membership::NotListed);
    let back = left_member_probe(
        || Ok(Some(r#"{"name":"Acme","members":[{"login":"Ana"}]}"#.into())),
        probe_with(),
    );
    assert_eq!(back.membership, Membership::Member);
    // GitHub unreachable for the file: no answer, and nothing else asked.
    let mut asked = false;
    let offline = left_member_probe(
        || Err("Could not resolve host: api.github.com".into()),
        |_| {
            asked = true;
            unreachable!()
        },
    );
    assert!(!asked);
    assert_eq!(offline.membership, Membership::Unknown);
    assert!(offline.errors[0].contains("Could not resolve host"));
    // A manifest that doesn't parse: access decides, the reason is kept.
    let broken = left_member_probe(|| Ok(Some("{".into())), probe_with());
    assert_eq!(broken.membership, Membership::Unknown);
    assert!(broken.errors[0].contains("team manifest"), "{:?}", broken.errors);
}

/// Windows walk of H2 (Challenger's `holds_nothing_local` rule): a later
/// read that moves a clone that stayed after leaving never deletes it — only
/// a clone that same read cloned may be; the others always go to the Trash.
#[test]
fn a_clone_that_stayed_is_never_deleted_by_a_later_read() {
    let source = include_str!("skills_hub.rs");
    let (_, pull) = source.split_once("pub(crate) fn pull_team_with(").expect("the pull");
    let (pull, _) = pull.split_once("\n}\n").expect("body");
    assert!(pull.contains("remove_clone(&clone, if cloned_now { after.as_deref() } else { None })"));
    assert!(pull.contains("let cloned_now = matches!(&synced, Ok(outcome) if outcome.cloned);"));
    let (_, switch) = source.split_once("pub async fn skills_hub_library_switch(").expect("switch");
    let (switch, _) = switch.split_once("\n}\n").expect("body");
    assert!(switch.contains("remove_clone(&team.clone_dir(&slug), None)"));
    // And `None` is never "may delete".
    let tmp = tempfile::tempdir().unwrap();
    let kept = tmp.path().join("kept");
    std::fs::create_dir_all(&kept).unwrap();
    git(&kept, &["init", "-q"]);
    commit_as(&kept, "Owner", "o@x", "team.json", "{}");
    assert!(!holds_nothing_local(&kept, None));
}

// ── Pinned to the source (the work runs on the blocking pool) ───────

/// Hard rule 4 and R1: exit stops the scheduler before the bounded git
/// children are killed; it starts in `setup`; the pull is `TeamStore::sync`
/// (bounded, in the exit registry, healing a torn fast-forward) run as the
/// team's account; and nothing here holds an App Nap assertion.
#[test]
fn the_pull_is_bounded_scoped_stopped_at_exit_and_holds_no_app_nap() {
    let lib = include_str!("lib.rs");
    let (_, cleanup) = lib.split_once("fn run_exit_cleanup(").expect("exit cleanup");
    let stop = cleanup.find("skills_hub::stop();").expect("stops the scheduler");
    let kill = cleanup.find("worktrees::kill_active_fetches()").expect("kills the fetches");
    assert!(stop < kill);
    assert!(lib.contains("skills_hub::start(app.handle().clone());"));

    let source = include_str!("skills_hub.rs");
    let (_, pull) = source.split_once("pub(crate) fn pull_team_with(").expect("the pull");
    let (pull, _) = pull.split_once("\n}\n").expect("body");
    let scope = pull.find("team_account_scope(").expect("the team's account");
    let sync = pull.find("team.sync_unless(&slug").expect("TeamStore::sync");
    assert!(scope < sync);
    let production = source.split("#[cfg(test)]").next().unwrap();
    assert!(!production.contains("app_nap"), "no App Nap assertion");
    assert!(!production.contains("git::capture(") && !production.contains("git::run("));

    let team = include_str!("team.rs");
    let (_, real_pull) = team.split_once("    fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {\n        library_pull_in(").expect("RealLibraryGit::pull");
    assert!(real_pull[..120].contains("crate::worktrees::exit_registry()"));

    let commands = include_str!("commands.rs");
    let (_, refresh) = commands.split_once("pub async fn team_refresh(").expect("team_refresh");
    let (refresh, _) = refresh.split_once("\n}\n").expect("body");
    assert!(refresh.contains("crate::skills_hub::team_pull(&app, crate::skills_hub::Trigger::Refresh)"));
}
