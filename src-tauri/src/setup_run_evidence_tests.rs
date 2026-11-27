//! R2 (1.176.0): an update judged on its versions, the time limit of an
//! install or update, and what the final event and the record carry — the
//! pure decisions for every combination, then the runner on real PTYs with
//! scripted observers (never a real installer).

use super::*;

/// One update, as the runner would see it after its look.
struct Case {
    what: &'static str,
    exit: Option<i32>,
    works: Observed,
    before: Option<&'static str>,
    after: Option<&'static str>,
    tail: &'static [&'static str],
    latest: Option<&'static str>,
    want: Outcome,
}

fn judged(c: &Case) -> Decision {
    let tail: Vec<String> = c.tail.iter().map(|l| l.to_string()).collect();
    let s = WatchState {
        exit: Some(c.exit),
        observed: Some(c.works),
        version: crate::setup_outcome::version_change(c.before, c.after),
        update_claimed: crate::setup_outcome::claims_update(&tail),
        newer_known: crate::setup_outcome::newer_known(c.before, c.latest),
        ..at(30)
    };
    decide(Watch::ToolWorks(Tool::Claude), &s, &t())
}

/// Pinned cases, most measured in R0-FINDINGS (C2, C4, the npm copy) or
/// taken from winget's return codes.
#[test]
fn updates_are_judged_on_evidence_in_the_cases_r0_measured() {
    let cases = [
        Case { what: "R0 C2: real update 2.1.300 -> 2.1.330, exit 0", exit: Some(0), works: Observed::Yes,
            before: Some("2.1.300"), after: Some("2.1.330"),
            tail: &["Updating to 2.1.330...", "Successfully updated from 2.1.300 to version 2.1.330"],
            latest: Some("2.1.330"), want: Outcome::Succeeded },
        Case { what: "R0 C2: already current, exit 0, nothing newer known", exit: Some(0), works: Observed::Yes,
            before: Some("2.1.330"), after: Some("2.1.330"),
            tail: &["Checking for updates to latest version...", "Claude Code is up to date (2.1.330)"],
            latest: None, want: Outcome::Succeeded },
        Case { what: "R0 C4: read-only versions folder, EACCES, exit 1", exit: Some(1), works: Observed::Yes,
            before: Some("2.1.300"), after: Some("2.1.300"),
            tail: &["Error: Failed to install native update", "Error: EACCES: permission denied, open '/u/.local/share/claude/versions/2.1.330'"],
            latest: Some("2.1.330"), want: Outcome::StillOnOldVersion },
        Case { what: "R0 C4: read-only ~/.local/bin, says it updated, exit 0", exit: Some(0), works: Observed::Yes,
            before: Some("2.1.300"), after: Some("2.1.300"),
            tail: &["Successfully updated from 2.1.300 to version 2.1.330"],
            latest: Some("2.1.330"), want: Outcome::StillOnOldVersion },
        Case { what: "R0 npm copy: the update removed the native launcher, an older copy answers", exit: Some(1), works: Observed::Yes,
            before: Some("2.1.330"), after: Some("2.1.300"), tail: &["Error: Failed to install native update"],
            latest: Some("2.1.340"), want: Outcome::OlderVersionNow },
        Case { what: "a lower version after a clean exit is never a success", exit: Some(0), works: Observed::Yes,
            before: Some("2.1.330"), after: Some("2.1.300"), tail: &[], latest: None, want: Outcome::OlderVersionNow },
        Case { what: "a higher version after an error exit (a warning at the end)", exit: Some(1), works: Observed::Yes,
            before: Some("2.1.300"), after: Some("2.1.330"), tail: &[], latest: None, want: Outcome::Succeeded },
        Case { what: "winget: no applicable upgrade (0x8A15002B)", exit: Some(0x8A15_002Bu32 as i32), works: Observed::Yes,
            before: Some("2.60.0"), after: Some("2.60.0"), tail: &["No available upgrade found."],
            latest: Some("2.61.0"), want: Outcome::NothingNewer },
        Case { what: "Homebrew lagging: same version, exit 0, a newer release known", exit: Some(0), works: Observed::Yes,
            before: Some("2.60.0"), after: Some("2.60.0"), tail: &["Warning: gh 2.60.0 already installed"],
            latest: Some("2.61.0"), want: Outcome::NothingNewer },
        Case { what: "an updater in another language claims nothing: still not 'updated'", exit: Some(0), works: Observed::Yes,
            before: Some("0.80.0"), after: Some("0.80.0"), tail: &["Mise à jour terminée"],
            latest: Some("0.81.0"), want: Outcome::NothingNewer },
        Case { what: "versions that aren't X.Y.Z, error exit", exit: Some(1), works: Observed::Yes,
            before: Some("nightly-a"), after: Some("nightly-b"), tail: &[], latest: None, want: Outcome::CouldNotTell },
        Case { what: "versions that aren't X.Y.Z, clean exit", exit: Some(0), works: Observed::Yes,
            before: Some("nightly-a"), after: Some("nightly-b"), tail: &[], latest: None, want: Outcome::Succeeded },
        Case { what: "no version after an error exit", exit: Some(1), works: Observed::Yes,
            before: Some("2.1.300"), after: None, tail: &[], latest: None, want: Outcome::CouldNotTell },
        Case { what: "killed, same version", exit: None, works: Observed::Yes,
            before: Some("2.1.300"), after: Some("2.1.300"), tail: &[], latest: None, want: Outcome::StillOnOldVersion },
        Case { what: "broken before, answers after", exit: Some(1), works: Observed::Yes,
            before: None, after: Some("2.1.330"), tail: &[], latest: None, want: Outcome::Succeeded },
        Case { what: "doesn't work after an error exit", exit: Some(1), works: Observed::No,
            before: Some("2.1.300"), after: None, tail: &[], latest: None, want: Outcome::Failed },
        Case { what: "doesn't work after a clean exit", exit: Some(0), works: Observed::No,
            before: Some("2.1.300"), after: None, tail: &[], latest: None, want: Outcome::NotObserved },
        Case { what: "couldn't tell whether it works", exit: Some(1), works: Observed::Unknown,
            before: Some("2.1.300"), after: Some("2.1.300"), tail: &[], latest: None, want: Outcome::CouldNotTell },
    ];
    for c in &cases {
        assert_eq!(judged(c), Decision::Done(c.want), "{}", c.what);
    }
}

#[test]
fn an_install_keeps_the_tolerance_of_a_tool_that_works_whatever_the_exit() {
    // winget's "already installed" codes: the tool working is the success.
    for exit in [Some(Some(0)), Some(Some(3)), Some(None)] {
        let s = WatchState { exit, observed: Some(Observed::Yes), ..at(30) };
        assert_eq!(
            decide(Watch::ToolWorks(Tool::Codex), &s, &t()),
            Decision::Done(Outcome::Succeeded),
            "{exit:?}"
        );
    }
    assert_eq!(update_outcome(VersionChange::NotCompared, Some(1), true, true), None);
}

#[test]
fn an_install_or_update_that_hangs_times_out_and_a_busy_one_does_not() {
    let w = Watch::ToolWorks(Tool::Claude);
    let timing = t();
    assert_eq!(timing.run_idle_limit, Duration::from_secs(15 * 60));
    assert_eq!(timing.run_limit, Duration::from_secs(60 * 60));
    // Quiet just under the idle limit, running just under the cap: waits.
    let s = WatchState { idle: timing.run_idle_limit - Duration::from_secs(1), ..at(3599) };
    assert_eq!(decide(w, &s, &timing), Decision::Wait);
    // Quiet for the idle limit: stopped, however young the run.
    let s = WatchState { idle: timing.run_idle_limit, ..at(900) };
    assert_eq!(decide(w, &s, &timing), Decision::Done(Outcome::TimedOut));
    // Printing all along, but an hour: stopped.
    assert_eq!(decide(w, &at(3600), &timing), Decision::Done(Outcome::TimedOut));
    // Stop wins over the limit.
    let s = WatchState { cancelled: true, ..at(4000) };
    assert_eq!(decide(w, &s, &timing), Decision::Done(Outcome::Cancelled));
    // Once the command ended, the look decides, not the clock.
    let s = WatchState { exit: Some(Some(0)), idle: Duration::from_secs(5000), ..at(5000) };
    assert_eq!(decide(w, &s, &timing), Decision::Wait);
    // Sign-ins are never stopped; the Command Line Tools keep their 30 min.
    for watch in [Watch::ClaudeSignIn, Watch::GhSignedIn, Watch::ClaudeFolderTrust] {
        let s = WatchState { idle: Duration::from_secs(7200), warned_long: true, ..at(7200) };
        assert_eq!(decide(watch, &s, &timing), Decision::Wait, "{watch:?}");
    }
    let clt = WatchState { idle: Duration::from_secs(1000), ..at(1000) };
    assert_eq!(decide(Watch::CommandLineTools, &clt, &timing), Decision::Wait);
}

#[test]
fn the_final_event_carries_the_evidence_under_its_wire_names() {
    let event = SetupEvent {
        run_id: "r".into(),
        action_id: "update.claude".into(),
        pty_id: None,
        phase: Phase::Done,
        outcome: Some(Outcome::StillOnOldVersion),
        exit_code: Some(1),
        reprobed: true,
        tail: vec![],
        clone: None,
        evidence: Evidence {
            cause: Some(crate::setup_outcome::Cause::FileInUse),
            cause_path: Some("/Users/me/.local/bin/claude".into()),
            version_before: Some("2.0.1".into()),
            version_after: Some("2.0.1".into()),
        },
    };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["outcome"], "still-on-old-version");
    assert_eq!(json["cause"], "file-in-use");
    assert_eq!(json["causePath"], "/Users/me/.local/bin/claude");
    assert_eq!(json["versionBefore"], "2.0.1");
    assert_eq!(json["versionAfter"], "2.0.1");
    assert!(json.get("evidence").is_none(), "flattened into the event");
    let quiet = SetupEvent { evidence: Evidence::default(), ..event };
    let json = serde_json::to_value(&quiet).unwrap();
    assert!(json["cause"].is_null() && json["versionBefore"].is_null());
}

#[test]
fn the_log_names_the_program_never_its_arguments_or_folder() {
    let argv = vec![
        "/Users/someone/.local/bin/claude".to_string(),
        "update".into(),
        "--token=secret".into(),
    ];
    assert_eq!(program_name(&argv), "claude");
    assert_eq!(program_name(&[]), "");
}

// ── the runner, on real PTYs ───────────────────────────────────────────

#[cfg(unix)]
mod live_r2 {
    use super::super::live::*;
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tauri::Manager;

    /// The tool works (or not) after the run, and answers the scripted
    /// versions in turn: before the run, then after it.
    struct Versioned {
        works: Observed,
        versions: Vec<Option<&'static str>>,
        reads: AtomicUsize,
    }

    impl Versioned {
        fn new(works: Observed, versions: &[Option<&'static str>]) -> Arc<Self> {
            Arc::new(Self { works, versions: versions.to_vec(), reads: AtomicUsize::new(0) })
        }
    }

    impl Observer for Versioned {
        fn baseline(&self, _watch: Watch) -> Baseline {
            Baseline::default()
        }
        fn observe(&self, _watch: Watch, _baseline: &Baseline) -> Observed {
            self.works
        }
        fn re_probe(&self) {}
        fn version(&self, _tool: Tool) -> Option<String> {
            let n = self.reads.fetch_add(1, Ordering::SeqCst);
            self.versions[n.min(self.versions.len() - 1)].map(String::from)
        }
    }

    fn plan(action: ActionId, tool: Tool, script: &str) -> RunPlan {
        RunPlan {
            action,
            argv: vec!["/bin/sh".into(), "-c".into(), script.into()],
            direct: false,
            display: "claude update".into(),
            watch: Watch::ToolWorks(tool),
            env: Vec::new(),
            token: None,
            clone: None,
            cwd: None,
        }
    }

    const NPM_EACCES: &str = "echo 'npm error code EACCES'; \
        echo 'npm error syscall mkdir'; \
        echo 'npm error path /usr/local/lib/node_modules/@anthropic-ai'; \
        echo \"npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@anthropic-ai'\"; \
        exit 243";

    #[test]
    fn a_refused_update_with_the_old_version_answering_is_not_a_success_and_is_kept() {
        let h = Harness::new();
        let records = h.dir.join("records");
        h.runner.keep_records_in(records.clone());
        let observer = Versioned::new(Observed::Yes, &[Some("2.0.1"), Some("2.0.1")]);
        let run = h
            .runner
            .start(
                &h.handle,
                plan(ActionId::UpdateClaude, Tool::Claude, NPM_EACCES),
                observer.clone(),
                fast(),
                h.emit(),
                80,
                24,
            )
            .unwrap();
        let done = h.done(&run.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::StillOnOldVersion));
        assert_eq!(done.exit_code, Some(243));
        assert_eq!(done.evidence.cause, Some(crate::setup_outcome::Cause::Permissions));
        // The folder it couldn't create isn't there: the one to fix is the
        // folder it was to be made in.
        assert_eq!(done.evidence.cause_path.as_deref(), Some("/usr/local/lib/node_modules"));
        assert_eq!(done.evidence.version_before.as_deref(), Some("2.0.1"));
        assert_eq!(done.evidence.version_after.as_deref(), Some("2.0.1"));
        assert_eq!(observer.reads.load(Ordering::SeqCst), 2, "before the run and after its look");

        let kept = crate::setup_last_run::load(&records);
        let last = kept.get("claude").expect("claude's last run is on disk");
        assert_eq!(last.action_id, "update.claude");
        assert_eq!(last.outcome.as_deref(), Some("still-on-old-version"));
        assert_eq!(last.cause.as_deref(), Some("permissions"));
        assert_eq!(last.exit_code, Some(243));
        assert_eq!(last.version_before.as_deref(), Some("2.0.1"));
        assert!(last.started_at.is_some() && last.finished_at.is_some());
        assert!(last.tail.iter().any(|l| l.contains("EACCES")), "{:?}", last.tail);
    }

    /// R0's silent case: `Successfully updated`, exit 0, the old version
    /// still the one that runs.
    #[test]
    fn an_update_that_claims_success_but_left_the_old_version_is_not_a_success() {
        let h = Harness::new();
        let script = "echo 'Current version: 2.1.300'; echo 'Updating to 2.1.330...'; \
            echo 'Successfully updated from 2.1.300 to version 2.1.330'; exit 0";
        let run = h
            .runner
            .start(
                &h.handle,
                plan(ActionId::UpdateClaude, Tool::Claude, script),
                Versioned::new(Observed::Yes, &[Some("2.1.300"), Some("2.1.300")]),
                fast(),
                h.emit(),
                80,
                24,
            )
            .unwrap();
        let done = h.done(&run.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::StillOnOldVersion));
        assert_eq!(done.exit_code, Some(0));
        assert_eq!(done.evidence.cause, Some(crate::setup_outcome::Cause::Unknown));
        // Already current: the same version and nothing claimed — a success.
        let run = h
            .runner
            .start(
                &h.handle,
                plan(
                    ActionId::UpdateClaude,
                    Tool::Claude,
                    "echo 'Checking for updates to latest version...'; echo 'Claude Code is up to date (2.1.330)'",
                ),
                Versioned::new(Observed::Yes, &[Some("2.1.330")]),
                fast(),
                h.emit(),
                80,
                24,
            )
            .unwrap();
        assert_eq!(h.done(&run.run_id, Duration::from_secs(10)).outcome, Some(Outcome::Succeeded));
    }

    #[test]
    fn an_update_that_moved_the_version_succeeds_and_replaces_the_record() {
        let h = Harness::new();
        let records = h.dir.join("records");
        h.runner.keep_records_in(records.clone());
        for (versions, want) in [
            (vec![Some("2.0.1"), Some("2.0.1")], Outcome::StillOnOldVersion),
            (vec![Some("2.0.1"), Some("2.0.5")], Outcome::Succeeded),
        ] {
            let run = h
                .runner
                .start(
                    &h.handle,
                    plan(ActionId::UpdateCodex, Tool::Codex, "echo updating; exit 1"),
                    Versioned::new(Observed::Yes, &versions),
                    fast(),
                    h.emit(),
                    80,
                    24,
                )
                .unwrap();
            let done = h.done(&run.run_id, Duration::from_secs(10));
            assert_eq!(done.outcome, Some(want));
            if want == Outcome::Succeeded {
                assert_eq!(done.evidence.cause, None, "a success has no cause");
            }
        }
        let last = crate::setup_last_run::load(&records).remove("codex").unwrap();
        assert_eq!(last.outcome.as_deref(), Some("succeeded"));
        assert_eq!(last.version_after.as_deref(), Some("2.0.5"));
    }

    /// Hard Rule 4: a run stopped at its idle limit leaves nothing behind —
    /// its helper, which ignores the hang-up, ends with it.
    #[test]
    fn a_silent_install_is_stopped_at_its_idle_limit_tree_and_all() {
        let h = Harness::new();
        let records = h.dir.join("records");
        h.runner.keep_records_in(records.clone());
        let (script, pids_file) = h.tree_script();
        let timing = Timing { run_idle_limit: Duration::from_millis(500), ..fast() };
        let started = Instant::now();
        let run = h
            .runner
            .start(
                &h.handle,
                plan(ActionId::InstallClaude, Tool::Claude, &script),
                Versioned::new(Observed::No, &[None]),
                timing,
                h.emit(),
                80,
                24,
            )
            .unwrap();
        let pids = read_pids(&pids_file);
        let done = h.done(&run.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::TimedOut));
        assert_eq!(done.evidence.cause, Some(crate::setup_outcome::Cause::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(8));
        assert_all_end(&pids, "after the idle limit");
        assert!(h.runner.active().is_none(), "the slot is free");
        assert!(!h.handle.state::<PtyRegistry>().contains(&run.pty_id));
        let last = crate::setup_last_run::load(&records).remove("claude").unwrap();
        assert_eq!(last.outcome.as_deref(), Some("timed-out"));
        assert_eq!(last.cause.as_deref(), Some("timed-out"));
    }

    /// …and one that keeps printing is stopped at the cap, tree and all.
    #[test]
    fn a_run_that_prints_forever_is_stopped_at_its_cap_tree_and_all() {
        let h = Harness::new();
        let pids_file = h.dir.join("pids");
        let script = format!(
            "trap '' HUP; /bin/sleep 300 & echo \"$$ $!\" > {}; while :; do echo tick; /bin/sleep 0.05; done",
            pids_file.display()
        );
        let timing = Timing { run_limit: Duration::from_millis(800), ..fast() };
        let run = h
            .runner
            .start(
                &h.handle,
                plan(ActionId::UpdateGh, Tool::Gh, &script),
                Versioned::new(Observed::Yes, &[Some("2.60.0")]),
                timing,
                h.emit(),
                80,
                24,
            )
            .unwrap();
        let pids = read_pids(&pids_file);
        let done = h.done(&run.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::TimedOut));
        assert!(done.tail.iter().any(|l| l == "tick"));
        assert_all_end(&pids, "after the cap");
        assert!(h.runner.active().is_none());
    }

    /// A slow run that keeps printing is never stopped by the idle limit.
    #[test]
    fn a_slow_install_that_shows_progress_is_not_stopped() {
        let h = Harness::new();
        let timing = Timing { run_idle_limit: Duration::from_millis(400), ..fast() };
        let script = "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo \"$i%\"; /bin/sleep 0.15; done; exit 0";
        let run = h
            .runner
            .start(
                &h.handle,
                plan(ActionId::InstallCodex, Tool::Codex, script),
                Versioned::new(Observed::Yes, &[None, Some("0.80.0")]),
                timing,
                h.emit(),
                80,
                24,
            )
            .unwrap();
        let done = h.done(&run.run_id, Duration::from_secs(15));
        assert_eq!(done.outcome, Some(Outcome::Succeeded), "{:?}", done.tail);
        assert_eq!(done.exit_code, Some(0));
        assert_eq!(done.evidence.version_before, None, "not installed before");
        assert_eq!(done.evidence.version_after.as_deref(), Some("0.80.0"));
    }

    /// The version read comes first, said by a Preparing event; a Stop
    /// during it starts nothing.
    struct SlowRead {
        started: std::sync::Mutex<bool>,
    }

    impl Observer for SlowRead {
        fn baseline(&self, _watch: Watch) -> Baseline {
            Baseline::default()
        }
        fn observe(&self, _watch: Watch, _baseline: &Baseline) -> Observed {
            Observed::Yes
        }
        fn re_probe(&self) {}
        fn version(&self, _tool: Tool) -> Option<String> {
            *self.started.lock().unwrap() = true;
            thread::sleep(Duration::from_millis(600));
            Some("2.0.1".into())
        }
    }

    #[test]
    fn the_version_read_is_said_first_and_a_stop_during_it_starts_nothing() {
        let h = Harness::new();
        let marker = h.dir.join("ran");
        let observer = Arc::new(SlowRead { started: std::sync::Mutex::new(false) });
        let (runner, handle) = (h.runner.clone(), h.handle.clone());
        let watching = observer.clone();
        let stopper = thread::spawn(move || {
            while !*watching.started.lock().unwrap() {
                thread::sleep(Duration::from_millis(10));
            }
            runner.stop(&handle, None, &fast())
        });
        let result = h.runner.start(
            &h.handle,
            plan(ActionId::UpdateClaude, Tool::Claude, &format!("touch {}", marker.display())),
            observer,
            fast(),
            h.emit(),
            80,
            24,
        );
        assert!(stopper.join().unwrap(), "the slot was held during the read");
        assert_eq!(result.unwrap_err(), STOPPED_BEFORE);
        assert!(h.runner.active().is_none(), "the slot is free");
        thread::sleep(Duration::from_millis(200));
        assert!(!marker.exists(), "nothing ran");
        let phases: Vec<Phase> = h.events.lock().iter().map(|e| e.phase).collect();
        assert_eq!(phases, vec![Phase::Preparing]);
    }

    /// Stop pressed before the time limit: Cancelled, never TimedOut, and
    /// the tool's last informative record stays.
    #[test]
    fn a_stop_wins_over_the_time_limit_and_keeps_the_last_informative_record() {
        let h = Harness::new();
        let records = h.dir.join("records");
        h.runner.keep_records_in(records.clone());
        let failed = h
            .runner
            .start(
                &h.handle,
                plan(ActionId::UpdateClaude, Tool::Claude, NPM_EACCES),
                Versioned::new(Observed::Yes, &[Some("2.0.1")]),
                fast(),
                h.emit(),
                80,
                24,
            )
            .unwrap();
        h.done(&failed.run_id, Duration::from_secs(10));
        let (script, pids_file) = h.tree_script();
        let timing = Timing { run_idle_limit: Duration::from_millis(700), ..fast() };
        let run = h
            .runner
            .start(
                &h.handle,
                plan(ActionId::UpdateClaude, Tool::Claude, &script),
                Versioned::new(Observed::Yes, &[Some("2.0.1")]),
                timing,
                h.emit(),
                80,
                24,
            )
            .unwrap();
        let pids = read_pids(&pids_file);
        assert!(h.runner.stop(&h.handle, Some(&run.run_id), &fast()));
        let done = h.done(&run.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::Cancelled));
        assert_eq!(done.evidence.cause, None);
        assert_all_end(&pids, "after Stop");
        let last = crate::setup_last_run::load(&records).remove("claude").unwrap();
        assert_eq!(last.outcome.as_deref(), Some("still-on-old-version"), "the stopped run isn't kept");
        // An update's first event is Preparing, then Running.
        let phases: Vec<Phase> = h.events.lock().iter().filter(|e| e.run_id == run.run_id).map(|e| e.phase).collect();
        assert_eq!(&phases[..2], &[Phase::Preparing, Phase::Running]);
    }

    /// A sign-in is no program: nothing is read or kept for it.
    #[test]
    fn a_sign_in_keeps_no_record_and_reads_no_version() {
        let h = Harness::new();
        let records = h.dir.join("records");
        h.runner.keep_records_in(records.clone());
        let observer = Versioned::new(Observed::No, &[Some("1.0.0")]);
        let mut p = plan(ActionId::LoginClaude, Tool::Claude, "exit 1");
        p.watch = Watch::ClaudeSignIn;
        let run = h
            .runner
            .start(&h.handle, p, observer.clone(), fast(), h.emit(), 80, 24)
            .unwrap();
        let done = h.done(&run.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::NotObserved));
        assert_eq!(observer.reads.load(Ordering::SeqCst), 0);
        assert_eq!(done.evidence.version_before, None);
        assert!(!records.join(crate::setup_last_run::FILE).exists());
    }
}
