//! OB-3 Tier 3: the watcher's decisions as pure functions, the readers, and
//! the runner on real PTYs with fake scripts (never a real installer or
//! login): one run at a time, Stop kills the tree, quitting kills it.

use super::*;
use crate::doctor::{CodexStore, CredentialSeen};
use std::sync::atomic::AtomicUsize;

// R2: the true outcomes of updates, the cause, the time limit and the record.
#[path = "setup_run_evidence_tests.rs"]
mod evidence_tests;

fn t() -> Timing {
    Timing::REAL
}

fn at(secs: u64) -> WatchState {
    WatchState {
        elapsed: Duration::from_secs(secs),
        exit: None,
        cancelled: false,
        observed: None,
        already_there: false,
        warned_long: false,
        installer_gone: false,
        version: VersionChange::NotCompared,
        idle: Duration::ZERO,
        update_claimed: false,
        newer_known: false,
    }
}

const ALL_WATCHES: [Watch; 9] = [
    Watch::ToolWorks(Tool::Claude),
    Watch::ClaudeSignIn,
    Watch::CodexSignIn,
    Watch::GhNewAccount,
    Watch::GhSignedIn,
    Watch::GhGitHelper,
    Watch::GhScopes,
    Watch::CommandLineTools,
    Watch::ToolWorks(Tool::Git),
];

#[test]
fn success_is_what_ply_sees_not_the_exit_code() {
    for watch in ALL_WATCHES {
        // Seen while running (a poll), or after the exit whatever its code.
        let seen = WatchState {
            observed: Some(Observed::Yes),
            ..at(3)
        };
        assert_eq!(
            decide(watch, &seen, &t()),
            Decision::Done(Outcome::Succeeded),
            "{watch:?}"
        );
        let exited_badly = WatchState {
            exit: Some(Some(3)),
            ..seen
        };
        assert_eq!(
            decide(watch, &exited_badly, &t()),
            Decision::Done(Outcome::Succeeded),
            "{watch:?}"
        );
    }
    // An exit 0 with nothing to see is not a success.
    let s = WatchState {
        exit: Some(Some(0)),
        observed: Some(Observed::No),
        ..at(30)
    };
    assert_eq!(
        decide(Watch::ToolWorks(Tool::Claude), &s, &t()),
        Decision::Done(Outcome::NotObserved)
    );
    assert_eq!(
        decide(Watch::ClaudeSignIn, &s, &t()),
        Decision::Done(Outcome::NotObserved)
    );
}

#[test]
fn the_review_folder_trust_is_claudes_own_answer_polled_and_stopped_on_sight() {
    let w = Watch::ClaudeFolderTrust;
    assert_eq!(poll_every(w, &t()), Some(Duration::from_millis(500)));
    assert_eq!(t().trust_settle, Duration::from_millis(500));
    // Only this watch polls that often.
    for other in ALL_WATCHES {
        assert_ne!(poll_every(other, &t()), Some(t().trust_poll), "{other:?}");
    }
    assert!(stops_on_sight(w));
    for other in ALL_WATCHES {
        assert!(!stops_on_sight(other), "{other:?}");
    }
    assert_eq!(folder_trust_seen(Some(true)), Observed::Yes);
    assert_eq!(folder_trust_seen(Some(false)), Observed::No);
    assert_eq!(folder_trust_seen(None), Observed::Unknown);
    // Trusted while Claude runs: done.
    let seen = WatchState { observed: Some(Observed::Yes), ..at(4) };
    assert_eq!(decide(w, &seen, &t()), Decision::Done(Outcome::Succeeded));
    // Not yet, or unreadable, while Claude runs: wait — and no sign-in
    // notice at ten minutes, Stop is the member's.
    for observed in [Observed::No, Observed::Unknown] {
        let s = WatchState { observed: Some(observed), ..at(11 * 60) };
        assert_eq!(decide(w, &s, &t()), Decision::Wait, "{observed:?}");
    }
    // Claude closed ("No, exit") with the folder untrusted: not yet, never
    // a failure, whatever the exit code.
    let closed = WatchState { exit: Some(Some(1)), observed: Some(Observed::No), ..at(9) };
    assert_eq!(decide(w, &closed, &t()), Decision::Done(Outcome::NotObserved));
    let unreadable = WatchState { observed: Some(Observed::Unknown), ..closed };
    assert_eq!(decide(w, &unreadable, &t()), Decision::Done(Outcome::CouldNotTell));
}

#[test]
fn an_install_that_exits_with_an_error_fails_and_a_sign_in_just_is_not_there_yet() {
    let s = WatchState {
        exit: Some(Some(1)),
        observed: Some(Observed::No),
        ..at(30)
    };
    for watch in [
        Watch::ToolWorks(Tool::Codex),
        Watch::GhGitHelper,
        Watch::GhScopes,
    ] {
        assert_eq!(
            decide(watch, &s, &t()),
            Decision::Done(Outcome::Failed),
            "{watch:?}"
        );
    }
    // Killed by a signal counts as an error for an install too.
    let killed = WatchState {
        exit: Some(None),
        ..s
    };
    assert_eq!(
        decide(Watch::ToolWorks(Tool::Gh), &killed, &t()),
        Decision::Done(Outcome::Failed)
    );
    // Closing the browser: "Not signed in yet", no error colour.
    for watch in [
        Watch::ClaudeSignIn,
        Watch::CodexSignIn,
        Watch::GhSignedIn,
        Watch::GhNewAccount,
    ] {
        assert_eq!(
            decide(watch, &s, &t()),
            Decision::Done(Outcome::NotObserved),
            "{watch:?}"
        );
    }
}

#[test]
fn could_not_tell_is_never_a_failure() {
    for watch in ALL_WATCHES
        .into_iter()
        .filter(|w| *w != Watch::CommandLineTools)
    {
        let s = WatchState {
            exit: Some(Some(1)),
            observed: Some(Observed::Unknown),
            ..at(30)
        };
        assert_eq!(
            decide(watch, &s, &t()),
            Decision::Done(Outcome::CouldNotTell),
            "{watch:?}"
        );
    }
}

#[test]
fn the_exit_waits_for_the_look_after_it() {
    let s = WatchState {
        exit: Some(Some(0)),
        ..at(1)
    };
    assert_eq!(
        decide(Watch::ToolWorks(Tool::Claude), &s, &t()),
        Decision::Wait
    );
}

#[test]
fn cancel_ends_every_watch_whatever_else_holds() {
    for watch in ALL_WATCHES {
        let s = WatchState {
            cancelled: true,
            observed: Some(Observed::Yes),
            exit: Some(Some(0)),
            ..at(1)
        };
        assert_eq!(
            decide(watch, &s, &t()),
            Decision::Done(Outcome::Cancelled),
            "{watch:?}"
        );
    }
}

#[test]
fn a_sign_in_again_is_judged_when_its_command_ends() {
    let s = WatchState {
        observed: Some(Observed::Yes),
        already_there: true,
        ..at(4)
    };
    assert_eq!(
        decide(Watch::CodexSignIn, &s, &t()),
        Decision::Wait,
        "already there before: proves nothing yet"
    );
    let ended = WatchState {
        exit: Some(Some(0)),
        ..s
    };
    assert_eq!(
        decide(Watch::CodexSignIn, &ended, &t()),
        Decision::Done(Outcome::Succeeded)
    );
    // Challenger P2-1: a login cancelled (an error exit, a kill) leaves the
    // old credential behind — not signed in again, "Not signed in yet".
    for exit in [Some(Some(1)), Some(Some(130)), Some(None)] {
        let cancelled = WatchState { exit, ..s };
        for watch in [Watch::ClaudeSignIn, Watch::CodexSignIn] {
            assert_eq!(
                decide(watch, &cancelled, &t()),
                Decision::Done(Outcome::NotObserved),
                "{watch:?} {exit:?}"
            );
        }
    }
    // A first sign-in seen is a success whatever the exit said.
    let first = WatchState {
        exit: Some(Some(1)),
        already_there: false,
        ..s
    };
    assert_eq!(
        decide(Watch::ClaudeSignIn, &first, &t()),
        Decision::Done(Outcome::Succeeded)
    );
}

#[test]
fn the_output_kept_for_the_tail_is_capped() {
    let mut buf: Vec<u8> = (0..(CAPTURE_CAP * 2 + 10))
        .map(|i| (i % 251) as u8)
        .collect();
    let last = *buf.last().unwrap();
    trim_capture(&mut buf, CAPTURE_CAP);
    assert_eq!(buf.len(), CAPTURE_CAP);
    assert_eq!(*buf.last().unwrap(), last, "the newest bytes are kept");
    let mut small = vec![1u8; CAPTURE_CAP * 2];
    trim_capture(&mut small, CAPTURE_CAP);
    assert_eq!(
        small.len(),
        CAPTURE_CAP * 2,
        "trimmed only past twice the cap"
    );
}

#[test]
fn a_sign_in_warns_once_at_ten_minutes_and_keeps_waiting() {
    let before = at(599);
    assert_eq!(decide(Watch::ClaudeSignIn, &before, &t()), Decision::Wait);
    let ten = at(600);
    for watch in [
        Watch::ClaudeSignIn,
        Watch::CodexSignIn,
        Watch::GhSignedIn,
        Watch::GhNewAccount,
    ] {
        assert_eq!(decide(watch, &ten, &t()), Decision::WaitLong, "{watch:?}");
        let warned = WatchState {
            warned_long: true,
            ..at(3600)
        };
        assert_eq!(
            decide(watch, &warned, &t()),
            Decision::Wait,
            "{watch:?}: nothing is stopped"
        );
    }
    // An install has no sign-in notice; it runs until it ends, is stopped,
    // or (R2) reaches its time limit — an hour, or 15 minutes of silence.
    assert_eq!(
        decide(Watch::ToolWorks(Tool::Claude), &at(3599), &t()),
        Decision::Wait
    );
}

#[test]
fn the_command_line_tools_are_polled_past_the_dialogs_exit_for_thirty_minutes() {
    let w = Watch::CommandLineTools;
    // `xcode-select --install` exited at once; the installer still runs.
    let s = WatchState {
        exit: Some(Some(0)),
        observed: Some(Observed::No),
        ..at(10)
    };
    assert_eq!(decide(w, &s, &t()), Decision::Wait);
    let s = WatchState {
        exit: Some(Some(1)),
        observed: Some(Observed::Unknown),
        ..at(1799)
    };
    assert_eq!(decide(w, &s, &t()), Decision::Wait);
    let s = WatchState {
        exit: Some(Some(0)),
        observed: Some(Observed::No),
        ..at(1800)
    };
    assert_eq!(decide(w, &s, &t()), Decision::Done(Outcome::TimedOut));
    let s = WatchState {
        exit: Some(Some(0)),
        observed: Some(Observed::Yes),
        ..at(900)
    };
    assert_eq!(decide(w, &s, &t()), Decision::Done(Outcome::Succeeded));
    assert_eq!(poll_every(w, &t()), Some(Duration::from_secs(5)));
    assert_eq!(
        poll_every(Watch::ClaudeSignIn, &t()),
        Some(Duration::from_secs(2))
    );
    assert_eq!(poll_every(Watch::ToolWorks(Tool::Gh), &t()), None);
}

#[test]
fn a_closed_macos_installer_ends_the_wait_only_once_it_was_seen() {
    // OB-6 (spec §5 step 4, "CLT dialog dismissed").
    let (mut seen, mut absent) = (false, 0);
    // Never seen: absent looks change nothing (the name may not match).
    for _ in 0..5 {
        assert!(!track_installer(&mut seen, &mut absent, Some(false)));
    }
    assert!(!track_installer(&mut seen, &mut absent, None));
    // Seen, then gone for two looks in a row.
    assert!(!track_installer(&mut seen, &mut absent, Some(true)));
    assert!(!track_installer(&mut seen, &mut absent, Some(false)));
    assert!(!track_installer(&mut seen, &mut absent, None), "could not tell changes nothing");
    assert!(track_installer(&mut seen, &mut absent, Some(false)));
    // Up again: counting starts over.
    assert!(!track_installer(&mut seen, &mut absent, Some(true)));
    assert!(!track_installer(&mut seen, &mut absent, Some(false)));

    let w = Watch::CommandLineTools;
    let gone = WatchState {
        exit: Some(Some(0)),
        observed: Some(Observed::No),
        installer_gone: true,
        ..at(40)
    };
    assert_eq!(decide(w, &gone, &t()), Decision::Done(Outcome::InstallerClosed));
    // The tools arriving wins over the window closing.
    let arrived = WatchState {
        observed: Some(Observed::Yes),
        ..gone
    };
    assert_eq!(decide(w, &arrived, &t()), Decision::Done(Outcome::Succeeded));
    // Other watches ignore it.
    let other = WatchState {
        exit: None,
        ..gone
    };
    assert_eq!(decide(Watch::ToolWorks(Tool::Git), &other, &t()), Decision::Wait);
}

// ── readers ────────────────────────────────────────────────────────────

#[test]
fn credentials_are_seen_by_presence_and_never_read_as_signed_out_when_unreadable() {
    use CredentialSeen::*;
    assert_eq!(claude_seen(Present, Absent), Observed::Yes);
    assert_eq!(claude_seen(Unreadable, Present), Observed::Yes);
    assert_eq!(claude_seen(Absent, Absent), Observed::No);
    assert_eq!(claude_seen(Unreadable, Absent), Observed::Unknown);
    assert_eq!(codex_seen(CodexStore::File, Present), Observed::Yes);
    assert_eq!(codex_seen(CodexStore::File, Absent), Observed::No);
    assert_eq!(codex_seen(CodexStore::Keyring, Absent), Observed::Unknown);
    assert_eq!(
        codex_seen(CodexStore::Unreadable, Absent),
        Observed::Unknown
    );
}

const GH_TWO: &str = r#"{"hosts":{"github.com":[
  {"state":"success","active":true,"host":"github.com","login":"test-owner","tokenSource":"keyring","scopes":"gist, read:org, repo, workflow","gitProtocol":"https"},
  {"state":"success","active":false,"host":"github.com","login":"mb-work","tokenSource":"keyring","scopes":"repo","gitProtocol":"https"}]}}"#;

#[test]
fn gh_accounts_come_from_its_json_and_a_new_one_is_a_new_login() {
    let two = gh_accounts(GH_TWO).unwrap();
    assert_eq!(two.len(), 2);
    assert_eq!(
        (two[0].login.as_str(), two[0].active, two[0].signed_in),
        ("test-owner", true, true)
    );
    let none = gh_accounts(r#"{"hosts":{}}"#).unwrap();
    assert!(none.is_empty());
    assert_eq!(
        gh_accounts("You are not logged into any GitHub hosts."),
        None
    );

    let one = vec![two[0].clone()];
    assert_eq!(gh_new_account(Some(&one), Some(&two)), Observed::Yes);
    assert_eq!(gh_new_account(Some(&two), Some(&two)), Observed::No);
    assert_eq!(gh_new_account(Some(&one), None), Observed::Unknown);
    assert_eq!(
        gh_new_account(None, Some(&two)),
        Observed::Unknown,
        "no list from before"
    );
    // Case differences are the same login.
    let upper = vec![
        GhAccount {
            login: "MB-WORK".into(),
            ..two[1].clone()
        },
        two[0].clone(),
    ];
    assert_eq!(gh_new_account(Some(&upper), Some(&two)), Observed::No);

    // login.gh: first account, or a signed-in one where none was.
    assert_eq!(gh_signed_in(Some(&none), Some(&one)), Observed::Yes);
    let bad = vec![GhAccount {
        signed_in: false,
        ..two[0].clone()
    }];
    assert_eq!(
        gh_signed_in(Some(&bad), Some(&one)),
        Observed::Yes,
        "the same account, signed in again"
    );
    assert_eq!(
        gh_signed_in(Some(&one), Some(&one)),
        Observed::No,
        "nothing changed"
    );
    assert_eq!(gh_signed_in(Some(&none), Some(&none)), Observed::No);
    // Challenger P3-1: no list from before — an account now can't be told
    // apart from one that was already there.
    assert_eq!(gh_signed_in(None, Some(&one)), Observed::Unknown);
    assert_eq!(gh_signed_in(None, Some(&none)), Observed::No);
    assert_eq!(gh_signed_in(Some(&none), None), Observed::Unknown);
}

#[test]
fn scopes_and_the_git_helper_are_read_from_ghs_and_gits_answers() {
    let two = gh_accounts(GH_TWO).unwrap();
    assert_eq!(gh_scopes_ok(Some(&two)), Observed::Yes);
    let narrow = vec![GhAccount {
        scopes: Some("gist, repo".into()),
        ..two[0].clone()
    }];
    assert_eq!(gh_scopes_ok(Some(&narrow)), Observed::No);
    let unsaid = vec![GhAccount {
        scopes: None,
        ..two[0].clone()
    }];
    assert_eq!(gh_scopes_ok(Some(&unsaid)), Observed::Unknown);
    assert_eq!(gh_scopes_ok(None), Observed::Unknown);

    assert_eq!(
        gh_helper_set("\n!/opt/homebrew/bin/gh auth git-credential\n"),
        Observed::Yes
    );
    assert_eq!(gh_helper_set("osxkeychain\n"), Observed::No);
    assert_eq!(gh_helper_set(""), Observed::No);
}

#[test]
fn a_tool_works_when_it_resolves_and_answers_and_git_on_windows_needs_git_bash() {
    let env = ShellEnv {
        claude_path: Some("/c".into()),
        claude_version: Some("2.1.283".into()),
        git_path: Some("/g".into()),
        git_version: Some("2.50.1".into()),
        gh_path: Some("/gh".into()),
        ..ShellEnv::default()
    };
    assert!(tool_works(Tool::Claude, &env, false));
    assert!(!tool_works(Tool::Gh, &env, false), "found but no --version");
    assert!(!tool_works(Tool::Codex, &env, false));
    assert!(tool_works(Tool::Git, &env, false));
    assert!(!tool_works(Tool::Git, &env, true), "no Git Bash");
    let with_bash = ShellEnv {
        git_bash_path: Some(r"C:\Program Files\Git\bin\bash.exe".into()),
        ..env
    };
    assert!(tool_works(Tool::Git, &with_bash, true));
}

#[test]
fn the_tail_is_the_last_lines_without_escapes() {
    let mut out = Vec::new();
    for i in 0..300 {
        out.extend_from_slice(format!("\x1b[32mline {i}\x1b[0m\r\n").as_bytes());
    }
    out.extend_from_slice(b"progress 10%\rprogress 100%\r\n\r\n");
    let tail = tail_lines(&out, TAIL_LINES);
    assert_eq!(tail.len(), TAIL_LINES);
    assert_eq!(tail.last().unwrap(), "progress 100%");
    assert_eq!(tail[0], "line 101");
}

#[test]
fn a_setup_run_is_typed_and_never_recorded() {
    let intent = setup_intent(ActionId::InstallClaude);
    assert!(intent.validate().is_ok());
    assert_eq!(
        intent.execution_kind,
        crate::coordination::ExecutionKind::Setup
    );
    assert!(!intent.recorded());
    assert!(matches!(
        intent.project,
        crate::coordination::SpawnProject::NonProject { .. }
    ));
    // The kind itself has a stable name, for whatever reads it.
    assert_eq!(
        serde_json::to_string(&crate::coordination::ExecutionKind::Setup).unwrap(),
        "\"setup\""
    );
}

// ── the runner, on real PTYs with fake scripts (unix) ──────────────────

#[cfg(any(unix, windows))]
mod live {
    use super::*;
    #[cfg(unix)]
    use std::path::Path;
    use std::path::PathBuf;
    use tauri::Manager;

    /// Answers every look with the next scripted value (the last repeats).
    pub(super) struct Scripted {
        answers: Vec<Observed>,
        looks: AtomicUsize,
        reprobes: AtomicUsize,
        baseline: Baseline,
    }

    impl Scripted {
        pub(super) fn new(answers: &[Observed]) -> Arc<Self> {
            Arc::new(Self {
                answers: answers.to_vec(),
                looks: AtomicUsize::new(0),
                reprobes: AtomicUsize::new(0),
                baseline: Baseline::default(),
            })
        }
    }

    impl Observer for Scripted {
        fn baseline(&self, _watch: Watch) -> Baseline {
            self.baseline.clone()
        }
        fn observe(&self, _watch: Watch, _baseline: &Baseline) -> Observed {
            let n = self.looks.fetch_add(1, Ordering::SeqCst);
            self.answers[n.min(self.answers.len() - 1)]
        }
        fn re_probe(&self) {
            self.reprobes.fetch_add(1, Ordering::SeqCst);
        }
    }

    pub(super) fn fast() -> Timing {
        Timing {
            tick: Duration::from_millis(20),
            credential_poll: Duration::from_millis(50),
            clt_poll: Duration::from_millis(50),
            login_soft_limit: Duration::from_secs(600),
            clt_limit: Duration::from_millis(600),
            success_grace: Duration::from_millis(300),
            kill_grace: Duration::from_millis(300),
            trust_poll: Duration::from_millis(50),
            trust_settle: Duration::from_millis(100),
            run_idle_limit: Duration::from_secs(600),
            run_limit: Duration::from_secs(600),
        }
    }

    pub(super) struct Harness {
        _app: tauri::App<tauri::test::MockRuntime>,
        pub(super) handle: AppHandle<tauri::test::MockRuntime>,
        pub(super) runner: SetupRunner,
        pub(super) events: Arc<Mutex<Vec<SetupEvent>>>,
        pub(super) dir: PathBuf,
        _env: std::sync::MutexGuard<'static, ()>,
    }

    impl Harness {
        pub(super) fn new() -> Self {
            // GH #213: a parallel test may swap the cached PATH for one
            // without /bin; the scripts use absolute paths and hold the lock.
            let guard = crate::shell_env::lock_for_test();
            if crate::shell_env::try_get().is_none() {
                crate::shell_env::init();
            }
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .expect("build test app");
            app.manage(PtyRegistry::default());
            let handle = app.handle().clone();
            let dir = std::env::temp_dir().join(format!("ply-ob3-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self {
                _app: app,
                handle,
                runner: SetupRunner::default(),
                events: Arc::default(),
                dir,
                _env: guard,
            }
        }

        pub(super) fn emit(&self) -> Emit {
            let events = self.events.clone();
            Arc::new(move |e: &SetupEvent| events.lock().push(e.clone()))
        }

        fn start_argv(
            &self,
            action: ActionId,
            watch: Watch,
            argv: Vec<String>,
            observer: Arc<dyn Observer>,
        ) -> Result<SetupStarted, String> {
            let plan = RunPlan {
                action,
                display: argv.join(" "),
                argv,
                direct: false,
                watch,
                env: Vec::new(),
                token: None,
                clone: None,
                cwd: None,
            };
            self.runner
                .start(&self.handle, plan, observer, fast(), self.emit(), 80, 24)
        }

        #[cfg(unix)]
        fn start(
            &self,
            action: ActionId,
            watch: Watch,
            script: &str,
            observer: Arc<dyn Observer>,
        ) -> Result<SetupStarted, String> {
            self.start_argv(
                action,
                watch,
                vec!["/bin/sh".into(), "-c".into(), script.into()],
                observer,
            )
        }

        #[cfg(unix)]
        /// A script that starts a grandchild in the same group, writes both
        /// pids, then waits for it — an installer with a helper running.
        pub(super) fn tree_script(&self) -> (String, PathBuf) {
            let pids = self.dir.join("pids");
            // The helper ignores the hang-up a closing PTY sends, as a
            // `nohup`ed installer helper would: only the group kill ends it.
            (
                format!(
                    "trap '' HUP; /bin/sleep 300 & echo \"$$ $!\" > {}; wait",
                    pids.display()
                ),
                pids,
            )
        }

        pub(super) fn done(&self, run_id: &str, within: Duration) -> SetupEvent {
            let deadline = Instant::now() + within;
            loop {
                if let Some(e) = self
                    .events
                    .lock()
                    .iter()
                    .find(|e| e.run_id == run_id && e.phase == Phase::Done)
                {
                    return e.clone();
                }
                assert!(
                    Instant::now() < deadline,
                    "no Done event for {run_id}: {:?}",
                    self.events.lock()
                );
                thread::sleep(Duration::from_millis(20));
            }
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            if let Some(pty) = self.handle.try_state::<PtyRegistry>() {
                self.runner.shutdown(&pty);
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[cfg(unix)]
    pub(super) fn read_pids(path: &Path) -> Vec<i32> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(text) = std::fs::read_to_string(path) {
                let pids: Vec<i32> = text
                    .split_whitespace()
                    .filter_map(|p| p.parse().ok())
                    .collect();
                if pids.len() == 2 {
                    return pids;
                }
            }
            assert!(Instant::now() < deadline, "the script never wrote its pids");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    pub(super) fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only asks whether the pid exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[cfg(unix)]
    pub(super) fn assert_all_end(pids: &[i32], what: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while pids.iter().any(|p| alive(*p)) {
            assert!(Instant::now() < deadline, "{what}: {pids:?} still running");
            thread::sleep(Duration::from_millis(25));
        }
    }

    #[cfg(unix)]
    #[test]
    fn one_run_at_a_time_and_stop_kills_the_whole_tree() {
        let h = Harness::new();
        let (script, pids_file) = h.tree_script();
        let first = h
            .start(
                ActionId::InstallClaude,
                Watch::ToolWorks(Tool::Claude),
                &script,
                Scripted::new(&[Observed::No]),
            )
            .expect("first run starts");
        assert!(!first.pty_id.is_empty());
        assert_eq!(
            h.runner.active().map(|a| a.run_id),
            Some(first.run_id.clone())
        );
        let pids = read_pids(&pids_file);
        assert!(pids.iter().all(|p| alive(*p)));

        // A second request is refused, in words naming the running step.
        let second = h.start(
            ActionId::LoginGh,
            Watch::GhSignedIn,
            "/bin/sleep 1",
            Scripted::new(&[Observed::No]),
        );
        assert_eq!(second.unwrap_err(), busy(ActionId::InstallClaude));

        assert!(h.runner.stop(&h.handle, Some("not-this-run"), &fast()) == false);
        assert!(h.runner.stop(&h.handle, Some(&first.run_id), &fast()));
        assert_all_end(&pids, "Stop");
        let done = h.done(&first.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::Cancelled));
        assert!(done.reprobed, "an install stopped midway re-probes too");
        assert!(
            h.runner.active().is_none(),
            "the slot is free once Done is said"
        );

        // Free again: the next run starts.
        let next = h
            .start(
                ActionId::LoginCodex,
                Watch::CodexSignIn,
                "/bin/sleep 300",
                Scripted::new(&[Observed::No]),
            )
            .expect("the next run starts");
        assert!(h.runner.stop(&h.handle, None, &fast()));
        assert_eq!(
            h.done(&next.run_id, Duration::from_secs(10)).outcome,
            Some(Outcome::Cancelled)
        );
    }

    /// Hard Rule 4 at registry level: what `ExitRequested` runs —
    /// `SetupRunner::shutdown`, then `PtyRegistry::kill_all` — ends a running
    /// setup PTY and everything in its group, and nothing starts after.
    #[cfg(unix)]
    #[test]
    fn quitting_kills_a_running_setup_pty_and_refuses_new_ones() {
        let h = Harness::new();
        let (script, pids_file) = h.tree_script();
        let run = h
            .start(
                ActionId::InstallGh,
                Watch::ToolWorks(Tool::Gh),
                &script,
                Scripted::new(&[Observed::No]),
            )
            .unwrap();
        let pids = read_pids(&pids_file);
        let pty = h.handle.state::<PtyRegistry>();
        assert!(pty.contains(&run.pty_id));

        assert!(exit_cleanup(&h.runner, &pty));
        pty.kill_all();
        assert_all_end(&pids, "quit");
        assert!(!pty.contains(&run.pty_id));
        assert_eq!(
            h.done(&run.run_id, Duration::from_secs(10)).outcome,
            Some(Outcome::Cancelled)
        );
        let later = h.start(
            ActionId::InstallClaude,
            Watch::ToolWorks(Tool::Claude),
            "/bin/sleep 1",
            Scripted::new(&[Observed::No]),
        );
        assert_eq!(later.unwrap_err(), QUITTING);
    }

    #[cfg(unix)]
    #[test]
    fn an_install_is_judged_by_the_look_after_it_and_carries_its_output() {
        let h = Harness::new();
        // Exit 3, yet the tool works (winget's "already installed" codes).
        let observer = Scripted::new(&[Observed::Yes]);
        let run = h
            .start(
                ActionId::InstallCodex,
                Watch::ToolWorks(Tool::Codex),
                "echo installing codex; exit 3",
                observer.clone(),
            )
            .unwrap();
        let done = h.done(&run.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::Succeeded));
        assert_eq!(done.exit_code, Some(3));
        assert!(done.reprobed);
        // The run ended: its terminal is let go, nothing is left registered.
        assert!(!h.handle.state::<PtyRegistry>().contains(&run.pty_id));
        assert!(
            done.tail.iter().any(|l| l.contains("installing codex")),
            "{:?}",
            done.tail
        );
        // The look after the exit re-probed (the scripted one counts none);
        // no second re-probe on top of it.
        assert_eq!(observer.reprobes.load(Ordering::SeqCst), 0);
        let phases: Vec<Phase> = h
            .events
            .lock()
            .iter()
            .filter(|e| e.run_id == run.run_id)
            .map(|e| e.phase)
            .collect();
        // R2: an install first reads the tool's version (Preparing).
        assert_eq!(phases, vec![Phase::Preparing, Phase::Running, Phase::Checking, Phase::Done]);

        // Nothing to see after an error exit: Failed.
        let run = h
            .start(
                ActionId::InstallCodex,
                Watch::ToolWorks(Tool::Codex),
                "echo boom >&2; exit 1",
                Scripted::new(&[Observed::No]),
            )
            .unwrap();
        let done = h.done(&run.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::Failed));
        assert!(done.tail.iter().any(|l| l.contains("boom")));
    }

    #[cfg(unix)]
    #[test]
    fn a_sign_in_seen_while_its_command_runs_ends_it_after_a_grace() {
        let h = Harness::new();
        let (script, pids_file) = h.tree_script();
        // Two looks say no, the third sees the credential.
        let observer = Scripted::new(&[Observed::No, Observed::No, Observed::Yes]);
        let run = h
            .start(
                ActionId::LoginClaude,
                Watch::ClaudeSignIn,
                &script,
                observer.clone(),
            )
            .unwrap();
        let pids = read_pids(&pids_file);
        let done = h.done(&run.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::Succeeded));
        assert!(!done.reprobed, "a sign-in re-probes nothing");
        assert!(observer.looks.load(Ordering::SeqCst) >= 3);
        assert_all_end(&pids, "after the success grace");
    }

    #[cfg(unix)]
    #[test]
    fn the_command_line_tools_wait_times_out_after_the_dialog_is_gone() {
        let h = Harness::new();
        let run = h
            .start(
                ActionId::InstallGit,
                Watch::CommandLineTools,
                "exit 0",
                Scripted::new(&[Observed::No]),
            )
            .unwrap();
        let done = h.done(&run.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::TimedOut));
        assert_eq!(done.exit_code, Some(0));
    }

    /// OB-6: the installer's window up for a look, then gone.
    #[cfg(unix)]
    struct WindowCloses {
        looks: AtomicUsize,
    }

    #[cfg(unix)]
    impl Observer for WindowCloses {
        fn baseline(&self, _watch: Watch) -> Baseline {
            Baseline::default()
        }
        fn observe(&self, _watch: Watch, _baseline: &Baseline) -> Observed {
            Observed::No
        }
        fn re_probe(&self) {}
        fn installer_running(&self) -> Option<bool> {
            Some(self.looks.fetch_add(1, Ordering::SeqCst) == 0)
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_command_line_tools_wait_ends_when_the_installer_window_closes() {
        let h = Harness::new();
        let run = h
            .start(
                ActionId::InstallGit,
                Watch::CommandLineTools,
                "exit 0",
                Arc::new(WindowCloses { looks: AtomicUsize::new(0) }),
            )
            .unwrap();
        let done = h.done(&run.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::InstallerClosed));
    }

    /// Panics where the test says: in the look before the run, or in a look
    /// during it.
    #[cfg(unix)]
    struct Panics {
        in_baseline: bool,
    }

    #[cfg(unix)]
    impl Observer for Panics {
        fn baseline(&self, _watch: Watch) -> Baseline {
            if self.in_baseline {
                panic!("test: the baseline look panics");
            }
            Baseline::default()
        }
        fn observe(&self, _watch: Watch, _baseline: &Baseline) -> Observed {
            panic!("test: a look panics");
        }
        fn re_probe(&self) {}
    }

    /// Challenger P3-2: a panic, before the spawn or in the watcher, never
    /// leaves the slot held; the watcher's run still ends, tree and all.
    #[cfg(unix)]
    #[test]
    fn a_panic_frees_the_slot_and_ends_the_run() {
        let h = Harness::new();
        let before = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.start(
                ActionId::LoginClaude,
                Watch::ClaudeSignIn,
                "/bin/sleep 300",
                Arc::new(Panics { in_baseline: true }),
            )
        }));
        assert!(before.is_err());
        assert!(
            h.runner.active().is_none(),
            "the slot is free after a panic before the spawn"
        );

        let (script, pids_file) = h.tree_script();
        let run = h
            .start(
                ActionId::LoginCodex,
                Watch::CodexSignIn,
                &script,
                Arc::new(Panics { in_baseline: false }),
            )
            .unwrap();
        let pids = read_pids(&pids_file);
        let done = h.done(&run.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::CouldNotTell));
        assert!(h.runner.active().is_none());
        assert_all_end(&pids, "after the watcher panicked");
        // And the next run starts.
        let next = h
            .start(
                ActionId::InstallClaude,
                Watch::ToolWorks(Tool::Claude),
                "exit 0",
                Scripted::new(&[Observed::Yes]),
            )
            .unwrap();
        assert_eq!(
            h.done(&next.run_id, Duration::from_secs(10)).outcome,
            Some(Outcome::Succeeded)
        );
    }

    /// Challenger P3-3: the leader exits, its helper (ignoring the hang-up)
    /// stays in the group — the run's end kills what is left of the group.
    #[cfg(unix)]
    #[test]
    fn a_helper_that_outlives_its_leader_is_killed_when_the_run_ends() {
        let h = Harness::new();
        let pids_file = h.dir.join("pids");
        let script = format!(
            "trap '' HUP; /bin/sleep 300 & echo \"$$ $!\" > {}; exit 0",
            pids_file.display()
        );
        let run = h
            .start(
                ActionId::InstallGh,
                Watch::ToolWorks(Tool::Gh),
                &script,
                Scripted::new(&[Observed::No]),
            )
            .unwrap();
        let pids = read_pids(&pids_file);
        let done = h.done(&run.run_id, Duration::from_secs(10));
        assert_eq!(done.outcome, Some(Outcome::NotObserved));
        assert_all_end(&pids[1..], "the helper after its leader exited");
    }

    /// …and Stop reaches the group after the leader is reaped: the Command
    /// Line Tools wait outlives `xcode-select --install`'s exit.
    #[cfg(unix)]
    #[test]
    fn stop_after_the_leader_exited_still_kills_its_group() {
        let h = Harness::new();
        let pids_file = h.dir.join("pids");
        let script = format!(
            "trap '' HUP; /bin/sleep 300 & echo \"$$ $!\" > {}; exit 0",
            pids_file.display()
        );
        let mut timing = fast();
        timing.clt_limit = Duration::from_secs(600);
        let plan = RunPlan {
            action: ActionId::InstallGit,
            argv: vec!["/bin/sh".into(), "-c".into(), script.clone()],
            direct: false,
            display: script,
            watch: Watch::CommandLineTools,
            env: Vec::new(),
            token: None,
            clone: None,
            cwd: None,
        };
        let run = h
            .runner
            .start(
                &h.handle,
                plan,
                Scripted::new(&[Observed::No]),
                timing,
                h.emit(),
                80,
                24,
            )
            .unwrap();
        let pids = read_pids(&pids_file);
        // The leader is gone; the helper is not, and the run still waits.
        let deadline = Instant::now() + Duration::from_secs(10);
        while alive(pids[0]) {
            assert!(Instant::now() < deadline, "the leader never exited");
            thread::sleep(Duration::from_millis(20));
        }
        thread::sleep(Duration::from_millis(200));
        assert!(alive(pids[1]), "the helper outlives its leader");
        assert!(h.runner.active().is_some());
        assert!(h.runner.stop(&h.handle, Some(&run.run_id), &fast()));
        assert_all_end(&pids[1..], "Stop after the leader was reaped");
        assert_eq!(
            h.done(&run.run_id, Duration::from_secs(10)).outcome,
            Some(Outcome::Cancelled)
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_trust_run_needs_the_review_folder() {
        let h = Harness::new();
        let error = h
            .start(
                ActionId::TrustClaude,
                Watch::ClaudeFolderTrust,
                "exit 0",
                Scripted::new(&[Observed::No]),
            )
            .unwrap_err();
        assert_eq!(error, NO_REVIEW_FOLDER);
        assert!(h.runner.active().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_review_folder_that_is_not_a_folder_starts_nothing() {
        let h = Harness::new();
        let missing = h.dir.join("claude-sessions-missing");
        let marker = h.dir.join("ran");
        let plan = RunPlan {
            action: ActionId::TrustClaude,
            argv: vec!["/bin/sh".into(), "-c".into(), format!("touch {}", marker.display())],
            direct: false,
            display: "claude".into(),
            watch: Watch::ClaudeFolderTrust,
            env: Vec::new(),
            token: None,
            clone: None,
            cwd: Some(missing.clone()),
        };
        let error = h
            .runner
            .start(&h.handle, plan, Scripted::new(&[Observed::No]), fast(), h.emit(), 80, 24)
            .unwrap_err();
        assert!(error.contains("isn't a folder"), "{error}");
        assert!(h.runner.active().is_none());
        thread::sleep(Duration::from_millis(300));
        assert!(!marker.exists(), "nothing ran (portable-pty would have used the home folder)");
        assert!(!missing.exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_trust_run_starts_in_the_review_folder_and_ends_once_trusted() {
        let h = Harness::new();
        let folder = h.dir.join("claude-sessions");
        std::fs::create_dir_all(&folder).unwrap();
        let (tree, pids_file) = h.tree_script();
        let script = format!("pwd -P > {}; {tree}", h.dir.join("where").display());
        // A grace far longer than the wait below: the trust run must not
        // be let run on after the folder is trusted.
        let timing = Timing { success_grace: Duration::from_secs(60), ..fast() };
        let observer = Scripted::new(&[Observed::No, Observed::Yes]);
        let plan = RunPlan {
            action: ActionId::TrustClaude,
            argv: vec!["/bin/sh".into(), "-c".into(), script.clone()],
            direct: false,
            display: "claude".into(),
            watch: Watch::ClaudeFolderTrust,
            env: Vec::new(),
            token: None,
            clone: None,
            cwd: Some(folder.clone()),
        };
        let started = Instant::now();
        let run = h
            .runner
            .start(&h.handle, plan, observer.clone(), timing, h.emit(), 80, 24)
            .unwrap();
        let pids = read_pids(&pids_file);
        let done = h.done(&run.run_id, Duration::from_secs(20));
        assert_eq!(done.outcome, Some(Outcome::Succeeded));
        assert!(started.elapsed() < Duration::from_secs(20), "stopped on sight, not after the grace");
        assert!(!done.reprobed);
        assert_all_end(&pids, "once the folder is trusted");
        let wd = std::fs::read_to_string(h.dir.join("where")).unwrap();
        assert_eq!(
            Path::new(wd.trim()),
            std::fs::canonicalize(&folder).unwrap(),
            "Claude starts in the review folder, never the home one"
        );
        assert!(h.runner.active().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_status_read_is_not_a_terminal_run() {
        let h = Harness::new();
        let error = h
            .start(
                ActionId::StatusClaude,
                Watch::Answer,
                "exit 0",
                Scripted::new(&[Observed::No]),
            )
            .unwrap_err();
        assert!(error.contains("is a check"));
        assert!(h.runner.active().is_none());
    }

    /// Windows: Stop ends the run's console processes through its Job
    /// Object (W2), and the run ends Cancelled.
    #[cfg(windows)]
    #[test]
    fn stop_ends_the_runs_job_on_windows() {
        let h = Harness::new();
        let powershell = std::env::var("SystemRoot")
            .map(|root| format!(r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe"))
            .unwrap();
        let run = h
            .start_argv(
                ActionId::InstallGh,
                Watch::ToolWorks(Tool::Gh),
                vec![
                    powershell,
                    "-NoProfile".into(),
                    "-Command".into(),
                    "ping -n 300 127.0.0.1".into(),
                ],
                Scripted::new(&[Observed::No]),
            )
            .unwrap();
        let pid = h.runner.active_pid().expect("the run's pid");
        let deadline = Instant::now() + Duration::from_secs(10);
        while crate::platform::group_pids(pid as crate::platform::Pgid).map_or(0, |p| p.len()) < 2 {
            assert!(
                Instant::now() < deadline,
                "powershell and ping never both ran"
            );
            thread::sleep(Duration::from_millis(50));
        }
        assert!(h.runner.stop(&h.handle, Some(&run.run_id), &fast()));
        assert_eq!(
            h.done(&run.run_id, Duration::from_secs(10)).outcome,
            Some(Outcome::Cancelled)
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while crate::platform::group_pids(pid as crate::platform::Pgid)
            .is_some_and(|p| !p.is_empty())
        {
            assert!(Instant::now() < deadline, "the job still has processes");
            thread::sleep(Duration::from_millis(50));
        }
        assert!(!h.handle.state::<PtyRegistry>().contains(&run.pty_id));
    }
}
