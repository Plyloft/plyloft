use super::*;
use std::cell::Cell;

fn env_with(claude: Option<&str>, claude_v: Option<&str>, codex: Option<&str>, codex_v: Option<&str>) -> ShellEnv {
    ShellEnv {
        path: "/usr/bin:/bin".into(),
        claude_path: claude.map(String::from),
        claude_version: claude_v.map(String::from),
        codex_path: codex.map(String::from),
        codex_version: codex_v.map(String::from),
        ..ShellEnv::default()
    }
}

/// The disk as these tests have it: only the paths listed exist.
fn disk(present: &'static [&'static str]) -> impl Fn(&str) -> bool {
    move |path| present.contains(&path)
}

/// A snapshot to judge, with or without a look behind it.
fn judged(env: ShellEnv, looked: bool) -> Fresh {
    Fresh { env: Arc::new(env), looked }
}

/// No cheap look finds anything.
fn none_nearby(_: &str) -> Option<String> {
    None
}

#[test]
fn a_cached_path_that_is_there_starts_without_a_look() {
    let env = env_with(Some("/a/claude"), Some("2.1.330"), Some("/a/codex"), Some("0.171.0"));
    for ask in [TILE_CHECK, TILE_SPAWN, REQUIRE] {
        assert!(!wants_look(Cli::Claude, &env, disk(&["/a/claude"]), ask));
        assert!(!wants_look(Cli::Codex, &env, disk(&["/a/codex"]), ask));
    }
    let fresh = judged(env, false);
    assert_eq!(
        program_in(Cli::Claude, &fresh, Some("/a/claude"), disk(&["/a/claude"]), |_: &str| -> Option<String> { panic!("not needed") })
            .as_deref(),
        Ok("/a/claude")
    );
}

/// Blind spot 6/16: the snapshot is days old and the launcher it names is
/// gone (a failed update). Every start looks again, once; the tool is found
/// where it is now and that is what starts.
#[test]
fn a_stale_path_looks_again_and_starts_where_the_tool_is_now() {
    let seen = Arc::new(env_with(Some("/old/claude"), Some("2.1.300"), None, None));
    let on_disk = disk(&["/new/claude"]);
    for ask in [TILE_CHECK, TILE_SPAWN, REQUIRE] {
        assert!(wants_look(Cli::Claude, &seen, &on_disk, ask), "{ask:?}");
    }
    let probes = Cell::new(0);
    let mut last = None;
    let (env, probed) = coalesced(&seen, seen.clone(), &mut last, Instant::now(), || {
        probes.set(probes.get() + 1);
        Arc::new(env_with(Some("/new/claude"), Some("2.1.330"), None, None))
    });
    assert!(probed);
    assert_eq!(probes.get(), 1);
    assert!(last.is_some(), "the look is stamped");
    let fresh = Fresh { env: env.clone(), looked: probed };
    assert_eq!(program_in(Cli::Claude, &fresh, Some("/old/claude"), &on_disk, none_nearby).as_deref(), Ok("/new/claude"));
    assert!(tools_differ(&seen, &env), "the window is sent the fresh snapshot");
}

/// Still missing after the look: an error the window recognises by its
/// shape, naming the tool and where it was — with words that keep the
/// tile's current sentence ("The program didn't start.").
#[test]
fn a_tool_still_missing_fails_with_the_typed_error() {
    let after = env_with(Some("/old/claude"), None, None, None);
    let err = program_in(Cli::Claude, &judged(after, true), Some("/old/claude"), disk(&[]), none_nearby)
        .expect_err("nothing to start");
    let rest = err.strip_prefix(UNAVAILABLE_PREFIX).expect("the prefix");
    let (json, words) = rest.split_once('\n').expect("json, then words");
    let payload: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(payload["tool"], "claude");
    assert_eq!(payload["was"], "/old/claude");
    assert!(words.contains("not found in PATH"), "{words}");
    assert!(words.contains("looked for it again"), "a look happened: {words}");

    let gone = env_with(None, None, None, None);
    let err = program_in(Cli::Codex, &judged(gone, false), None, disk(&[]), none_nearby).expect_err("never found");
    assert!(!err.contains("looked for it again"), "no look, none claimed: {err}");
    let payload: serde_json::Value =
        serde_json::from_str(err.strip_prefix(UNAVAILABLE_PREFIX).unwrap().split_once('\n').unwrap().0).unwrap();
    assert_eq!(payload["tool"], "codex");
    assert!(payload["was"].is_null());
}

/// Two tiles opened together after the snapshot went stale share one look:
/// the second finds the snapshot already replaced and takes it.
#[test]
fn concurrent_starts_share_one_look() {
    let seen = Arc::new(env_with(Some("/old/codex"), None, None, None));
    let replaced = Arc::new(env_with(Some("/new/claude"), Some("2.1.330"), None, None));
    let mut last = None;
    let (env, probed) = coalesced(&seen, replaced.clone(), &mut last, Instant::now(), || {
        panic!("another look already replaced the snapshot")
    });
    assert!(probed, "that look counts as this one's");
    assert!(Arc::ptr_eq(&env, &replaced));
    assert!(last.is_none());
}

/// A file that exists but can't run is still there after a look: within the
/// cooldown a start judges the snapshot as it is instead of re-probing at
/// every call; after it, it looks again.
#[test]
fn a_look_is_not_repeated_within_its_cooldown() {
    let seen = Arc::new(env_with(Some("/x/claude"), None, None, None));
    let start = Instant::now();
    let mut last = Some(start);
    let (_, probed) = coalesced(&seen, seen.clone(), &mut last, start + Duration::from_secs(5), || {
        panic!("not again so soon")
    });
    assert!(!probed);
    let (_, probed) =
        coalesced(&seen, seen.clone(), &mut last, start + LOOK_COOLDOWN + Duration::from_secs(1), || seen.clone());
    assert!(probed);
}

/// Only a person's press looks for a tool the snapshot never found; an
/// agent's `require` looks only when the path it would hand out fails on
/// disk. A tool there that doesn't start gets no login-shell look: a press
/// asks its `--version` again (the narrow refresh), nothing else does.
#[test]
fn what_makes_each_start_look_again() {
    let missing = env_with(None, None, None, None);
    assert!(wants_look(Cli::Claude, &missing, disk(&[]), TILE_CHECK));
    assert!(wants_look(Cli::Claude, &missing, disk(&[]), TILE_SPAWN));
    assert!(!wants_look(Cli::Claude, &missing, disk(&[]), REQUIRE));

    let broken = env_with(Some("/a/claude"), None, Some("/a/codex"), None);
    let there = disk(&["/a/claude", "/a/codex"]);
    for cli in [Cli::Claude, Cli::Codex] {
        for ask in [TILE_CHECK, TILE_SPAWN, REQUIRE] {
            assert!(!wants_look(cli, &broken, &there, ask), "{cli:?} {ask:?}: no login shell for it");
        }
        assert!(wants_recheck(cli, &broken, &there, TILE_CHECK), "{cli:?}: maybe fixed since");
        assert!(!wants_recheck(cli, &broken, &there, TILE_SPAWN), "{cli:?}: the check just asked");
        assert!(!wants_recheck(cli, &broken, &there, REQUIRE), "{cli:?}: require refuses it in words");
    }
    // A slow `--version` is starting: nothing to recheck.
    let mut slow = broken.clone();
    slow.claude_version_unknown = true;
    assert!(!wants_recheck(Cli::Claude, &slow, &there, TILE_CHECK));
}

/// R3 review 5: within a look's cooldown, a reinstall made a moment ago in
/// the installers' folder still starts (the cheap look), and the error never
/// says Plyloft looked when it didn't.
#[test]
fn a_start_in_the_cooldown_finds_a_fresh_install_nearby() {
    let stale = judged(env_with(Some("/old/claude"), Some("2.1.300"), None, None), false);
    let on_disk = disk(&["/home/me/.local/bin/claude"]);
    let program = program_in(Cli::Claude, &stale, Some("/old/claude"), &on_disk, |path| {
        assert_eq!(path, "/usr/bin:/bin", "the cached PATH, widened inside");
        Some("/home/me/.local/bin/claude".to_string())
    });
    assert_eq!(program.as_deref(), Ok("/home/me/.local/bin/claude"));
    // Something found nearby that isn't usable doesn't count.
    let err = program_in(Cli::Claude, &stale, Some("/old/claude"), disk(&[]), |_| Some("/x/claude".into())).unwrap_err();
    assert!(err.contains("claude: not found in PATH; it was at /old/claude."), "{err}");
}

/// R3 review 7: only a thread that opted in waits for a login shell.
#[test]
fn only_a_thread_that_opted_in_may_wait() {
    assert!(!may_wait());
    assert!(waiting(may_wait));
    assert!(!may_wait(), "restored after");
    let nested = waiting(|| waiting(|| 1) + i32::from(may_wait()));
    assert_eq!(nested, 2);
}

/// Blind spot 20: recognition is the tile's declared kind. A window holding
/// an older path than the backend (or a newer one) still starts Claude with
/// its wiring, from the backend's path; a shell tile running the very same
/// binary stays a shell; anything else declared is refused.
#[test]
fn a_tile_is_known_by_its_kind_not_by_its_path_string() {
    assert_eq!(tile_cli(None), Ok(None));
    assert_eq!(tile_cli(Some("claude")), Ok(Some(Cli::Claude)));
    assert_eq!(tile_cli(Some("codex")), Ok(Some(Cli::Codex)));
    assert!(tile_cli(Some("codex-chat")).is_err(), "the App Server is not a PTY tile");
    assert!(tile_cli(Some("/bin/zsh")).is_err());

    // The backend looked again since the window's copy was made.
    let backend = env_with(Some("/new/claude"), Some("2.1.330"), Some("/new/codex"), Some("0.171.0"));
    let on_disk = disk(&["/new/claude", "/new/codex"]);
    let window_sent = "/old/claude";
    let cli = tile_cli(Some("claude")).unwrap().unwrap();
    assert_eq!(cli.provider(), crate::mcp_launch::Provider::Claude);
    let backend = judged(backend, false);
    let program = program_in(cli, &backend, Some(window_sent), &on_disk, none_nearby).unwrap();
    assert_eq!(program, "/new/claude", "the backend's path, not the window's");
    // …and a window newer than the backend: still the backend's checked path.
    let program = program_in(Cli::Codex, &backend, Some("/newest/codex"), &on_disk, none_nearby).unwrap();
    assert_eq!(program, "/new/codex");
}

#[test]
fn a_shell_tile_running_claudes_binary_is_still_a_shell() {
    let (program, provider) = tile_program(None, "/new/claude".into()).unwrap();
    assert_eq!(program, "/new/claude");
    assert_eq!(provider, None, "no Knowledge server, no session id: a shell");
}

#[cfg(unix)]
#[test]
fn usable_follows_the_link_and_wants_an_executable_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let payload = dir.path().join("2.1.330");
    std::fs::write(&payload, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&payload, std::fs::Permissions::from_mode(0o755)).unwrap();
    let launcher = dir.path().join("claude");
    std::os::unix::fs::symlink(&payload, &launcher).unwrap();
    assert!(usable(&launcher.to_string_lossy()));

    // R0 C3: the payload moved away; the launcher dangles.
    std::fs::remove_file(&payload).unwrap();
    assert!(!usable(&launcher.to_string_lossy()));

    let plain = dir.path().join("codex");
    std::fs::write(&plain, "").unwrap();
    std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(!usable(&plain.to_string_lossy()), "not executable");
    assert!(!usable(&dir.path().to_string_lossy()), "a directory");
}

#[test]
fn only_the_tools_the_window_shows_count_as_a_change() {
    let a = env_with(Some("/a/claude"), Some("2.1.330"), None, None);
    let mut b = a.clone();
    b.gh_version = Some("2.80.0".into());
    assert!(!tools_differ(&a, &b));
    b.claude_version = None;
    assert!(tools_differ(&a, &b));
}

/// `pty_spawn` recognises a provider tile only through [`tile_program`]: the
/// string match on the cached path (`from_cached_command`) is gone.
#[test]
fn pty_spawn_knows_a_tile_by_its_declared_kind() {
    let commands = include_str!("commands.rs");
    let body = &commands[commands.find("pub fn pty_spawn(").unwrap()..];
    let body = &body[..body.find("\n}\n").unwrap()];
    assert!(body.contains("crate::cli_fresh::tile_program(cli.as_deref(), cmd)?"), "{body}");
    assert!(!commands.contains("from_cached_command"));
    let tile = include_str!("../../src/components/Tile.tsx");
    assert!(tile.contains("cli={kind === \"claude\" || kind === \"codex\" ? kind : undefined}"));
    // Review 8: the window's screen rules follow the kind too — a shell tile
    // whose program is named `claude` gets no Claude prompt matching.
    let terminal = include_str!("../../src/components/Terminal.tsx");
    assert!(terminal.contains("const vendorCmd = cli ?? \"\";"));
    for call in ["cliVendorOf(cmd)", "promptBoxMatcherFor(cmd)", "promptInputEmpty(cmd"] {
        assert!(!terminal.contains(call), "{call}");
    }
}

/// 1.176.0 R7: the "installed but doesn't start" refusal is typed, the same
/// shape on both Rust sites, and the window reads it by this very prefix
/// (`src/lib/cliNotStarting.ts`): a wording change can't turn Repair off.
#[test]
fn a_tool_that_doesnt_start_is_refused_with_the_typed_error_the_window_reads() {
    let marked = not_starting(Cli::Codex, "Codex is installed but doesn't start.");
    assert_eq!(marked, "PLY_CLI_NOT_STARTING_V1:{\"tool\":\"codex\"}\nCodex is installed but doesn't start.");
    // doctor::require, for each tool found that doesn't answer `--version`.
    for (tool, env) in [
        ("claude", env_with(Some("/c/claude"), None, None, None)),
        ("codex", env_with(None, None, Some("/c/codex"), None)),
    ] {
        let err = crate::doctor::require_with(&env, tool, |_| true).expect_err(tool);
        let head = format!("{NOT_STARTING_PREFIX}{{\"tool\":\"{tool}\"}}\n");
        assert!(err.starts_with(&head), "{err}");
        assert!(err[head.len()..].contains("but doesn't start"), "{err}");
    }
    // builder::vendor_missing_refusal, the same kind.
    let codex = env_with(Some("/c/claude"), Some("2.1.0"), Some("/c/codex"), None);
    let why = crate::builder::vendor_missing_refusal(&codex, "codex", false).unwrap();
    assert!(why.starts_with("PLY_CLI_NOT_STARTING_V1:{\"tool\":\"codex\"}\n"), "{why}");
    // A tool that isn't there is not this kind.
    let gone = env_with(None, None, None, None);
    assert!(!crate::builder::vendor_missing_refusal(&gone, "claude", false).unwrap().contains(NOT_STARTING_PREFIX));
    // The window's decoder names the same prefixes (1.176.0 seams: all
    // three marks live in `backendMarks.ts`).
    let ts = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/backendMarks.ts")).unwrap();
    for prefix in [UNAVAILABLE_PREFIX, NOT_STARTING_PREFIX, UPDATE_REFUSED_PREFIX] {
        assert!(ts.contains(&format!("\"{prefix}\"")), "backendMarks.ts names {prefix}");
    }
    assert_eq!(
        update_refused(Cli::Claude, "x"),
        "PLY_CLI_UPDATE_REFUSED_V1:{\"tool\":\"claude\"}\nx"
    );
}

/// 1.176.0 R7: the backend's answer to "did this tool really fail to start?"
/// — only a certain failure says so; slow, missing or mid-update never.
#[test]
fn a_tiles_quick_exit_is_a_failure_only_on_a_certain_answer() {
    let on_disk = disk(&["/c/claude", "/c/codex"]);
    let starts = env_with(Some("/c/claude"), Some("2.1.0"), Some("/c/codex"), Some("0.50.0"));
    assert_eq!(start_verdict(Cli::Claude, &starts, &on_disk, false), StartVerdict::Starts);
    assert_eq!(start_verdict(Cli::Codex, &starts, &on_disk, false), StartVerdict::Starts);
    let fails = env_with(Some("/c/claude"), None, Some("/c/codex"), None);
    assert_eq!(start_verdict(Cli::Claude, &fails, &on_disk, false), StartVerdict::Fails);
    assert_eq!(start_verdict(Cli::Codex, &fails, &on_disk, false), StartVerdict::Fails);
    // Slow is not broken.
    let mut slow = fails.clone();
    slow.claude_version_unknown = true;
    slow.codex_version_unknown = true;
    assert_eq!(start_verdict(Cli::Claude, &slow, &on_disk, false), StartVerdict::Unknown);
    assert_eq!(start_verdict(Cli::Codex, &slow, &on_disk, false), StartVerdict::Unknown);
    // Codex under its automatic update: nothing certain.
    assert_eq!(start_verdict(Cli::Codex, &fails, &on_disk, true), StartVerdict::Unknown);
    assert_eq!(start_verdict(Cli::Claude, &fails, &on_disk, true), StartVerdict::Fails);
    // Not found at all: R3's own check speaks for that, not this.
    let none = env_with(None, None, None, None);
    assert_eq!(start_verdict(Cli::Claude, &none, &on_disk, false), StartVerdict::Unknown);
    // A cached file that is gone from disk certainly doesn't start.
    assert_eq!(start_verdict(Cli::Claude, &starts, disk(&[]), false), StartVerdict::Fails);
}
