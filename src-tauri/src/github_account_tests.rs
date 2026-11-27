//! OB-7b tests: the account's environment (a stub gh, never the real one),
//! the scope, the chokepoints, redaction, git's credential override, and
//! that no agent spawn's environment ever carries the token (D7).

use super::*;
use std::fs;
use std::path::Path;
use std::sync::Arc;

const TOKEN: &str = "gho_ob7bFAKEtoken0123456789abcdefABCDEF";

fn plain_git() -> Command {
    let mut git = crate::platform::git_command();
    git.env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null");
    git
}

fn tools(gh: Option<String>) -> Tools {
    Tools {
        git: Arc::new(plain_git),
        gh,
        path: std::env::var("PATH").unwrap_or_default(),
    }
}

/// A stub gh: the active account is `main-acct`; `work-acct` has a token;
/// every call is logged (with whether GH_TOKEN was set, never its value).
#[cfg(unix)]
fn stub_gh(dir: &Path) -> String {
    let log = dir.join("gh.log");
    let script = format!(
        r#"#!/bin/sh
if [ -n "${{GH_TOKEN:-}}" ]; then had=yes; else had=no; fi
printf '%s|GH_TOKEN=%s\n' "$*" "$had" >> "{log}"
case "$1 $2" in
"config get")
  echo "main-acct"
  ;;
"auth token")
  if [ "$4" = "work-acct" ]; then echo "{TOKEN}"; else echo "no oauth token found for github.com account $4" >&2; exit 1; fi
  ;;
"auth git-credential")
  cat > /dev/null
  printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=%s\n' "$GH_TOKEN"
  ;;
"pr create")
  echo "https://github.com/o/r/pull/7 made with $GH_TOKEN"
  echo "stderr also says $GH_TOKEN" >&2
  ;;
*)
  echo "unexpected: $*" >&2; exit 2
  ;;
esac
"#,
        log = log.display(),
    );
    let gh = dir.join("gh");
    fs::write(&gh, script).unwrap();
    crate::platform::set_mode(&gh, 0o755).unwrap();
    gh.to_string_lossy().into_owned()
}

#[cfg(unix)]
fn gh_log(dir: &Path) -> Vec<String> {
    fs::read_to_string(dir.join("gh.log"))
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}

fn env_of(cmd: &Command, key: &str) -> Option<Option<String>> {
    cmd.get_envs()
        .find(|(k, _)| *k == std::ffi::OsStr::new(key))
        .map(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
}

fn args_of(cmd: &Command) -> Vec<String> {
    cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect()
}

fn test_env() -> GhEnv {
    GhEnv::for_test("work-acct", TOKEN, "/opt/homebrew/bin/gh")
}

// ── Resolving the account ─────────────────────────────────────────────

#[test]
fn no_account_chosen_reads_nothing_and_injects_nothing() {
    // No gh at all: a workspace without an account must not even need it.
    let t = tools(None);
    assert_eq!(resolve(&t, None).unwrap(), None);
    assert_eq!(resolve(&t, Some("  ")).unwrap(), None);
}

#[cfg(unix)]
#[test]
fn the_active_account_gets_no_token_and_no_token_read() {
    let dir = tempfile::tempdir().unwrap();
    let t = tools(Some(stub_gh(dir.path())));
    assert_eq!(resolve(&t, Some("main-acct")).unwrap(), None);
    // Case-insensitive, as GitHub logins are.
    assert_eq!(resolve(&t, Some("Main-Acct")).unwrap(), None);
    let log = gh_log(dir.path());
    assert!(log.iter().all(|l| l.starts_with("config get -h github.com user|")), "{log:?}");
    assert!(log.iter().all(|l| !l.contains("auth token")));
}

#[cfg(unix)]
#[test]
fn a_non_active_account_gets_its_own_token_from_gh_auth_token_user() {
    let dir = tempfile::tempdir().unwrap();
    let t = tools(Some(stub_gh(dir.path())));
    let env = resolve(&t, Some("work-acct")).unwrap().expect("a token");
    assert_eq!(env.login(), "work-acct");
    assert_eq!(env.token.expose(), TOKEN);
    let log = gh_log(dir.path());
    assert_eq!(
        log,
        vec![
            "config get -h github.com user|GH_TOKEN=no".to_string(),
            "auth token --user work-acct|GH_TOKEN=no".to_string(),
        ],
        "the reads themselves never run with a token (an inherited one is dropped)"
    );
}

#[cfg(unix)]
#[test]
fn an_account_not_signed_in_is_refused_in_words_without_gh_output() {
    let dir = tempfile::tempdir().unwrap();
    let t = tools(Some(stub_gh(dir.path())));
    let err = resolve(&t, Some("gone-acct")).unwrap_err();
    assert!(err.contains("gone-acct"), "{err}");
    assert!(err.contains("isn't signed in"), "{err}");
    assert!(!err.contains("no oauth token"), "gh's own output never reaches the words: {err}");
}

#[test]
fn a_bad_login_and_a_missing_gh_are_refused() {
    let t = tools(None);
    assert!(resolve(&t, Some("bad login")).unwrap_err().contains("isn't a GitHub account"));
    let err = resolve(&t, Some("work-acct")).unwrap_err();
    assert!(err.contains("GitHub CLI isn't installed"), "{err}");
}

#[test]
fn debug_never_shows_the_token() {
    let env = test_env();
    let shown = format!("{env:?}");
    assert!(shown.contains("work-acct"));
    assert!(!shown.contains(TOKEN), "{shown}");
    let _scope = enter(Some("ws"), Ok(Some(env)));
    let scope_shown = SCOPE.with(|s| format!("{:?}", s.borrow()));
    assert!(!scope_shown.contains(TOKEN), "{scope_shown}");
}

// ── The scope and the chokepoints ─────────────────────────────────────

#[test]
fn outside_a_scope_gh_and_git_are_untouched() {
    let mut gh = crate::platform::new_command("gh");
    apply_to_gh(&mut gh).unwrap();
    assert_eq!(env_of(&gh, "GH_TOKEN"), None);
    let mut git = crate::platform::git_command();
    apply_to_network_git(&mut git, Path::new(".")).unwrap();
    assert!(args_of(&git).is_empty());
    assert_eq!(env_of(&git, "GH_TOKEN"), None);
    assert_eq!(scoped_login(), None);
    assert_eq!(redact(&format!("x {TOKEN}")), format!("x {TOKEN}"));
}

#[test]
fn a_scope_with_the_active_account_injects_nothing() {
    let _scope = enter(Some("ws"), Ok(None));
    let mut gh = crate::platform::new_command("gh");
    apply_to_gh(&mut gh).unwrap();
    assert_eq!(env_of(&gh, "GH_TOKEN"), None);
    assert_eq!(scoped_login(), None);
}

#[test]
fn inside_a_scope_gh_gets_the_token_and_git_the_credential_override() {
    let scope = enter(Some("ws"), Ok(Some(test_env())));
    let mut gh = crate::platform::new_command("gh");
    apply_to_gh(&mut gh).unwrap();
    assert_eq!(env_of(&gh, "GH_TOKEN"), Some(Some(TOKEN.to_string())));
    assert_eq!(env_of(&gh, "GITHUB_TOKEN"), Some(None), "an inherited GITHUB_TOKEN is dropped");

    let mut git = crate::platform::git_command();
    apply_to_network_git(&mut git, Path::new(".")).unwrap();
    git.args(["push", "origin", "x"]);
    assert_eq!(
        args_of(&git),
        vec![
            "-c",
            "credential.https://github.com.helper=",
            "-c",
            "credential.https://github.com.helper=!f() { test \"$1\" = get || exit 0; \
             t=$('/opt/homebrew/bin/gh' auth token --user 'work-acct') || exit 0; \
             echo username=x-access-token; echo \"password=$t\"; }; f",
            "push",
            "origin",
            "x",
        ],
        "the override comes before the subcommand; only the login is in it"
    );
    assert_eq!(env_of(&git, "GH_TOKEN"), Some(None), "git's environment never holds the token (hooks)");
    assert_eq!(env_of(&git, "GITHUB_TOKEN"), Some(None));
    assert!(args_of(&git).iter().all(|a| !a.contains(TOKEN)));
    assert_eq!(scoped_login(), Some(Ok("work-acct".to_string())));
    drop(scope);
    let mut after = crate::platform::new_command("gh");
    apply_to_gh(&mut after).unwrap();
    assert_eq!(env_of(&after, "GH_TOKEN"), None, "dropping the scope ends it");
}

/// 1.176.3 (REV-R1 F1): on Windows gh's PATH is the one it would get anyway,
/// with the probed git's folder appended only when absent; with no probed
/// git, or a git already on it, nothing is set. Windows shapes, run on every
/// platform (`windows` is a parameter).
#[test]
fn gh_gets_the_probed_gits_folder_after_its_own_path() {
    let base = r"C:\Windows\system32;C:\Windows";
    let git = r"C:\Program Files\Git\cmd\git.exe";
    let want = Some(format!(r"{base};C:\Program Files\Git\cmd"));
    let fresh = crate::platform::new_command("gh");
    // Inherited (process) PATH: the folder goes after it.
    assert_eq!(gh_path_for(&fresh, Some(git), Some(base), true, false), want);
    // No probed git, or no PATH to start from: nothing set.
    assert_eq!(gh_path_for(&fresh, None, Some(base), true, false), None);
    assert_eq!(gh_path_for(&fresh, Some(git), None, true, false), None);
    // Already on it: nothing set.
    let on = format!(r"{base};C:\Program Files\Git\cmd");
    assert_eq!(gh_path_for(&fresh, Some(git), Some(&on), true, false), None);
    // A PATH already set on the command is the base, not the process's.
    let mut set = crate::platform::new_command("gh");
    set.env("PATH", base);
    assert_eq!(gh_path_for(&set, Some(git), Some(r"C:\elsewhere"), true, false), want);
    let mut removed = crate::platform::new_command("gh");
    removed.env_remove("PATH");
    assert_eq!(gh_path_for(&removed, Some(git), Some(base), true, false), None);
}

/// REV gh-path S3: Windows' variable names ignore case — a `Path` set on the
/// command is the base, as `PATH` is.
#[test]
fn gh_path_reads_a_path_set_under_any_case() {
    let git = r"C:\Program Files\Git\cmd\git.exe";
    let mut set = crate::platform::new_command("gh");
    set.env("Path", r"C:\Windows");
    assert_eq!(
        gh_path_for(&set, Some(git), Some(r"C:\elsewhere"), true, false).as_deref(),
        Some(r"C:\Windows;C:\Program Files\Git\cmd")
    );
    let mut removed = crate::platform::new_command("gh");
    removed.env_remove("Path");
    assert_eq!(gh_path_for(&removed, Some(git), Some(r"C:\Windows"), true, false), None);
}

/// REV gh-path M2: on a Mac with the tools (`mac_shim` false) gh's PATH is
/// never touched, whatever the probed git.
#[test]
fn gh_path_is_left_alone_off_windows() {
    let fresh = crate::platform::new_command("gh");
    assert_eq!(gh_path_for(&fresh, Some("/opt/homebrew/bin/git"), Some("/usr/bin:/bin"), false, false), None);
    let mut set = crate::platform::new_command("gh");
    set.env("PATH", "/usr/bin:/bin");
    assert_eq!(gh_path_for(&set, Some("/opt/homebrew/bin/git"), Some("/usr/bin:/bin"), false, false), None);
}

/// 1.176.4 (owner, 2026-11-23): on a Mac whose `/usr/bin/git` is Apple's
/// placeholder (`mac_shim`), gh's PATH gets the probed git's folder in front
/// when `/usr/bin` comes before it or it is absent; in every other case it is
/// left alone. On Windows `mac_shim` changes nothing: the append stays.
#[test]
fn gh_path_puts_the_real_git_first_only_over_apples_placeholder() {
    let brew = "/opt/homebrew/bin/git";
    let finder = "/usr/bin:/bin:/usr/sbin:/sbin";
    let fresh = crate::platform::new_command("gh");
    // The placeholder, a real git elsewhere, `/usr/bin` first: in front.
    let first = Some(format!("/opt/homebrew/bin:{finder}"));
    assert_eq!(gh_path_for(&fresh, Some(brew), Some(finder), false, true), first);
    // …also when the folder is there but after `/usr/bin`.
    let after = "/usr/bin:/bin:/opt/homebrew/bin";
    assert_eq!(
        gh_path_for(&fresh, Some(brew), Some(after), false, true),
        Some(format!("/opt/homebrew/bin:{after}"))
    );
    // A PATH set on the command is the base; a `Path` isn't PATH on a Mac.
    let mut set = crate::platform::new_command("gh");
    set.env("PATH", finder);
    assert_eq!(gh_path_for(&set, Some(brew), Some("/elsewhere"), false, true), first);
    let mut other_case = crate::platform::new_command("gh");
    other_case.env("Path", "/elsewhere");
    assert_eq!(gh_path_for(&other_case, Some(brew), Some(finder), false, true), first);
    // Not the placeholder (the tools are there): untouched.
    assert_eq!(gh_path_for(&fresh, Some(brew), Some(finder), false, false), None);
    // The folder already before `/usr/bin`: untouched.
    assert_eq!(gh_path_for(&fresh, Some(brew), Some("/opt/homebrew/bin:/usr/bin"), false, true), None);
    // No real git found, or it is `/usr/bin`'s own: untouched.
    assert_eq!(gh_path_for(&fresh, None, Some(finder), false, true), None);
    assert_eq!(gh_path_for(&fresh, Some("/usr/bin/git"), Some(finder), false, true), None);
    // PATH removed on purpose, or none to start from: untouched.
    let mut removed = crate::platform::new_command("gh");
    removed.env_remove("PATH");
    assert_eq!(gh_path_for(&removed, Some(brew), Some(finder), false, true), None);
    assert_eq!(gh_path_for(&fresh, Some(brew), None, false, true), None);
    // Windows: today's append, whatever `mac_shim` says.
    let win = r"C:\Windows";
    let git = r"C:\Program Files\Git\cmd\git.exe";
    assert_eq!(
        gh_path_for(&fresh, Some(git), Some(win), true, true),
        gh_path_for(&fresh, Some(git), Some(win), true, false)
    );
    assert_eq!(
        gh_path_for(&fresh, Some(git), Some(win), true, true).as_deref(),
        Some(r"C:\Windows;C:\Program Files\Git\cmd")
    );
}

/// REV gh-path S2: the chokepoint itself, with an injected probe (never the
/// global one: other tests' git spawns read it). On Windows gh gets the
/// probed working git's folder after the process PATH; on macOS only with
/// `clt_installed == Some(false)` (the probe found no Command Line Tools),
/// in front; for a git that doesn't work, gh's PATH is left exactly as it
/// was.
#[test]
fn apply_to_gh_gives_gh_the_probed_gits_folder() {
    let dir = tempfile::tempdir().unwrap();
    let git_name = if cfg!(windows) { "git.exe" } else { "git" };
    let git = dir.path().join(git_name).to_string_lossy().into_owned();
    let process = std::env::var("PATH").unwrap();
    let working = crate::shell_env::ShellEnv {
        git_path: Some(git.clone()),
        git_version: Some("2.47.0".into()),
        ..Default::default()
    };
    let mut gh = crate::platform::new_command("gh");
    apply_to_gh_with(&mut gh, Some(&working)).unwrap();
    let expected = if cfg!(windows) {
        crate::registry_path::with_folder_of(&process, &git, true)
    } else {
        None
    };
    assert!(!cfg!(windows) || expected.is_some(), "a temp folder is never on the PATH");
    assert_eq!(env_of(&gh, "PATH"), expected.map(Some));

    let broken = crate::shell_env::ShellEnv { git_version: None, ..working.clone() };
    let mut gh = crate::platform::new_command("gh");
    apply_to_gh_with(&mut gh, Some(&broken)).unwrap();
    assert_eq!(env_of(&gh, "PATH"), None, "a git that doesn't work adds nothing");
    let mut gh = crate::platform::new_command("gh");
    apply_to_gh_with(&mut gh, None).unwrap();
    assert_eq!(env_of(&gh, "PATH"), None, "no probe adds nothing");

    // 1.176.4: a Mac whose `/usr/bin/git` is Apple's placeholder (the probe's
    // `xcode-select -p` failed) gets the working git's folder in front, when
    // `/usr/bin` comes first on the process PATH; Windows keeps its append.
    let shim = crate::shell_env::ShellEnv { clt_installed: Some(false), ..working.clone() };
    let mut gh = crate::platform::new_command("gh");
    apply_to_gh_with(&mut gh, Some(&shim)).unwrap();
    let expected = if cfg!(windows) {
        crate::registry_path::with_folder_of(&process, &git, true)
    } else if cfg!(target_os = "macos") {
        crate::registry_path::with_folder_first(&process, &git)
    } else {
        None
    };
    if cfg!(target_os = "macos") && process.split(':').any(|e| e.trim_end_matches('/') == "/usr/bin") {
        assert!(expected.as_deref().is_some_and(|p| p.starts_with(&format!("{}:", dir.path().display()))));
    }
    assert_eq!(env_of(&gh, "PATH"), expected.map(Some));
    let unknown = crate::shell_env::ShellEnv { clt_installed: None, ..working.clone() };
    let mut gh = crate::platform::new_command("gh");
    apply_to_gh_with(&mut gh, Some(&unknown)).unwrap();
    assert_eq!(env_of(&gh, "PATH").is_some(), cfg!(windows), "an unknown answer is not the placeholder");
    // REV gh-shim S3: a Mac with the tools (the usual answer) keeps its PATH.
    let tools = crate::shell_env::ShellEnv { clt_installed: Some(true), ..working.clone() };
    let mut gh = crate::platform::new_command("gh");
    apply_to_gh_with(&mut gh, Some(&tools)).unwrap();
    assert_eq!(env_of(&gh, "PATH").is_some(), cfg!(windows), "a Mac with the tools keeps gh's PATH");

    // Production reads the cached probe.
    assert!(body_of("github_account.rs", "apply_to_gh")
        .contains("apply_to_gh_with(cmd, crate::shell_env::try_get().as_deref())"));
}

/// 1.176.4 (REV gh-shim M1): the gh children `project_setup::Tools::gh`
/// builds (cached PATH set on the command) get the same Mac rule — the
/// probed working git's folder in front, only when the probe found no
/// Command Line Tools and `/usr/bin` comes first — and never Windows' append.
#[test]
fn tools_gh_children_get_the_mac_rule_only() {
    let dir = tempfile::tempdir().unwrap();
    let git = dir.path().join("git").to_string_lossy().into_owned();
    let folder = dir.path().to_string_lossy().into_owned();
    let cached = "/usr/bin:/bin:/usr/sbin:/sbin";
    let probe = |clt| crate::shell_env::ShellEnv {
        git_path: Some(git.clone()),
        git_version: Some("2.47.0".into()),
        clt_installed: clt,
        ..Default::default()
    };
    let with_path = |path: &str| {
        let mut cmd = crate::platform::new_command("gh");
        cmd.env("PATH", path);
        cmd
    };
    // No Command Line Tools: in front on a Mac; nowhere else.
    let mut gh = with_path(cached);
    apply_mac_rule_to_gh_with(&mut gh, Some(&probe(Some(false))));
    let want = if cfg!(target_os = "macos") { format!("{folder}:{cached}") } else { cached.to_string() };
    assert_eq!(env_of(&gh, "PATH"), Some(Some(want)));
    // The tools there, or an unknown answer, or no probe: untouched.
    for env in [Some(probe(Some(true))), Some(probe(None)), None] {
        let mut gh = with_path(cached);
        apply_mac_rule_to_gh_with(&mut gh, env.as_ref());
        assert_eq!(env_of(&gh, "PATH"), Some(Some(cached.to_string())));
    }
    // Already first: untouched.
    let first = format!("{folder}:{cached}");
    let mut gh = with_path(&first);
    apply_mac_rule_to_gh_with(&mut gh, Some(&probe(Some(false))));
    assert_eq!(env_of(&gh, "PATH"), Some(Some(first)));
    // Never Windows' append, even with a Windows-shaped git off its PATH.
    let mut gh = with_path(r"C:\Windows");
    let win = crate::shell_env::ShellEnv {
        git_path: Some(r"C:\Program Files\Git\cmd\git.exe".into()),
        ..probe(None)
    };
    apply_mac_rule_to_gh_with(&mut gh, Some(&win));
    assert_eq!(env_of(&gh, "PATH"), Some(Some(r"C:\Windows".to_string())));
    // Production: `Tools::gh` sets the cached PATH, then this rule, once.
    let tools_gh = body_of("project_setup.rs", "gh");
    let set = tools_gh.find(r#".env("PATH", &self.path)"#).expect("Tools::gh sets the cached PATH");
    let rule = tools_gh.find("crate::github_account::apply_mac_rule_to_gh(&mut command)").expect("Tools::gh applies the Mac rule");
    assert!(set < rule && tools_gh.matches("apply_mac_rule_to_gh").count() == 1);
    assert!(body_of("github_account.rs", "apply_mac_rule_to_gh")
        .contains("apply_mac_rule_to_gh_with(cmd, crate::shell_env::try_get().as_deref())"));
}

/// 1.176.4: deciding gh's PATH spawns nothing and re-probes nothing — it
/// reads the probe's cached `clt_installed`, whose only question is
/// `/usr/bin/xcode-select -p` (it fails without a dialog). A source-text
/// guard: a spawn through a helper not listed here would pass it.
#[test]
fn deciding_ghs_path_spawns_and_re_probes_nothing() {
    for name in ["apply_to_gh_with", "gh_path_for", "gh_git_facts", "apply_mac_rule_to_gh_with"] {
        let body = body_of("github_account.rs", name);
        // REV gh-shim S4: also no re-probe, whose git probe would run a git.
        for spawn in [
            "new_command", "Command::new", ".spawn(", ".output(", ".status(", "run_bounded", "re_probe", "run_probe",
            "probe_git", "doctor::",
        ] {
            assert!(!body.contains(spawn), "{name} must not run anything ({spawn})");
        }
    }
    assert!(body_of("github_account.rs", "gh_git_facts").contains("clt_installed == Some(false)"));
    for name in ["apply_to_gh_with", "apply_mac_rule_to_gh_with"] {
        assert!(body_of("github_account.rs", name).contains("gh_git_facts(probed)"), "{name}");
    }
    let first = body_of("registry_path.rs", "with_folder_first");
    for spawn in ["new_command", "Command::new", ".spawn(", ".output(", ".status(", "re_probe", "run_probe"] {
        assert!(!first.contains(spawn), "with_folder_first must not run anything ({spawn})");
    }
    // The probe's only CLT question is `xcode-select -p`, never git or `--install`.
    let clt = body_of("shell_env.rs", "clt_installed");
    assert!(clt.contains(r#"new_command("/usr/bin/xcode-select")"#));
    assert!(clt.contains(r#"arg("-p")"#));
    assert!(!clt.contains("--install") && !clt.contains("/usr/bin/git"));
    assert_eq!(clt.matches("new_command").count(), 1);
}

/// REV gh-path: in a real Windows spawn the child sees one PATH variable
/// (Rust's `Command` folds `PATH` onto the inherited `Path`), ending with the
/// probed git's folder. The probe is injected; no git file is written.
#[cfg(windows)]
#[test]
fn gh_child_sees_one_path_variable_on_windows() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().to_string_lossy().into_owned();
    let probed = crate::shell_env::ShellEnv {
        git_path: Some(dir.path().join("git.exe").to_string_lossy().into_owned()),
        git_version: Some("2.47.0".into()),
        ..Default::default()
    };
    let mut cmd = crate::platform::new_command("cmd");
    cmd.args(["/d", "/c", "set"]);
    apply_to_gh_with(&mut cmd, Some(&probed)).unwrap();
    let out = cmd.output().unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    let paths: Vec<&str> = text
        .lines()
        .filter(|l| l.len() >= 5 && l[..5].eq_ignore_ascii_case("path="))
        .collect();
    assert_eq!(paths.len(), 1, "{paths:?}");
    let value = paths[0].trim_end();
    assert!(
        value.to_ascii_lowercase().ends_with(&format!(";{}", folder.to_ascii_lowercase())),
        "{value}"
    );
}

#[test]
fn a_failed_account_fails_every_github_call_instead_of_using_another() {
    let _scope = enter(Some("ws"), Err("This workspace uses the GitHub account b, which isn't signed in".into()));
    let mut gh = crate::platform::new_command("gh");
    assert!(apply_to_gh(&mut gh).unwrap_err().contains("isn't signed in"));
    assert!(matches!(scoped_login(), Some(Err(_))));
}

/// P3-4: a signed-out account refuses git only for an HTTPS github.com
/// origin; an SSH origin (its keys) and a repository with no origin go on.
#[test]
fn a_failed_account_refuses_network_git_only_for_https_github_origins() {
    let dir = tempfile::tempdir().unwrap();
    let repo = |name: &str, url: Option<&str>| {
        let path = dir.path().join(name);
        fs::create_dir_all(&path).unwrap();
        let mut init = plain_git();
        init.current_dir(&path).args(["init", "-q"]);
        assert!(init.status().unwrap().success());
        if let Some(url) = url {
            let mut add = plain_git();
            add.current_dir(&path).args(["remote", "add", "origin", url]);
            assert!(add.status().unwrap().success());
        }
        path
    };
    let https = repo("https", Some("https://github.com/o/r.git"));
    let ssh = repo("ssh", Some("git@github.com:o/r.git"));
    let ssh_url = repo("ssh-url", Some("ssh://git@github.com/o/r.git"));
    let _scope = enter(Some("ws"), Err("b isn't signed in".into()));
    let mut git = crate::platform::git_command();
    assert_eq!(apply_to_network_git(&mut git, &https).unwrap_err(), "b isn't signed in");
    for dir in [&ssh, &ssh_url] {
        let mut git = crate::platform::git_command();
        apply_to_network_git(&mut git, dir).unwrap();
        assert!(args_of(&git).is_empty(), "no override for an SSH origin");
    }
    assert!(origin_needs_account("https://github.com/o/r"));
    assert!(!origin_needs_account("https://gitlab.com/o/r"));
    assert!(!origin_needs_account("git@github.com:o/r.git"));
}

#[test]
fn the_helpers_gh_path_is_quoted_for_sh_on_every_platform() {
    let args = login_helper_args(r"C:\Program Files\GitHub CLI\gh.exe", "work-acct");
    assert!(
        args[3].contains("t=$('C:/Program Files/GitHub CLI/gh.exe' auth token --user 'work-acct')"),
        "{}",
        args[3]
    );
    let odd = login_helper_args("/opt/it's/gh", "a");
    assert!(odd[3].contains(r"'/opt/it'\''s/gh'"), "{}", odd[3]);
}

#[test]
fn scopes_nest_and_restore() {
    let outer = enter(Some("a"), Ok(Some(test_env())));
    {
        let _inner = enter(Some("b"), Ok(None));
        assert_eq!(scoped_login(), None, "an inner active-account scope clears the outer token");
    }
    assert_eq!(scoped_login(), Some(Ok("work-acct".to_string())));
    drop(outer);
    assert_eq!(scoped_login(), None);
}

#[test]
fn a_thread_spawned_inside_a_scope_starts_without_it() {
    let _scope = enter(Some("a"), Ok(Some(test_env())));
    let seen = std::thread::spawn(scoped_login).join().unwrap();
    assert_eq!(seen, None);
}

#[test]
fn the_workspace_scope_reads_the_token_once_and_only_for_a_chosen_account() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::workspace::WorkspaceStore::new(dir.path().to_path_buf()).unwrap();
    let plain = store.create("plain".into(), "/tmp/plain".into()).unwrap();
    let chosen = store.create("work".into(), "/tmp/work".into()).unwrap();
    store.set_github_account(&chosen.id, Some("work-acct".into())).unwrap();
    let reads = Rc::new(std::cell::Cell::new(0));
    let resolver = || {
        let reads = reads.clone();
        move |ws: crate::workspace::Workspace| {
            reads.set(reads.get() + 1);
            assert_eq!(ws.github_account.as_deref(), Some("work-acct"));
            Ok(Some(test_env()))
        }
    };
    {
        let _p = enter_for_workspace_with(&store, &plain.id, resolver());
        assert_eq!(scoped_login(), None);
    }
    assert_eq!(reads.get(), 0, "no account chosen: no gh read");
    {
        let _gone = enter_for_workspace_with(&store, "missing", resolver());
        assert_eq!(scoped_login(), None);
    }
    {
        let _outer = enter_for_workspace_with(&store, &chosen.id, resolver());
        // P3-3: nothing is read until a GitHub call needs it.
        assert_eq!(reads.get(), 0, "opening the scope reads nothing");
        let mut out = std::process::Output {
            status: std::process::ExitStatus::default(),
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        redact_output(&mut out);
        assert_eq!(reads.get(), 0, "reading a command's output reads nothing");
        assert_eq!(scoped_login(), Some(Ok("work-acct".to_string())));
        assert_eq!(reads.get(), 1);
        {
            let _inner = enter_for_workspace_with(&store, &chosen.id, resolver());
            assert_eq!(scoped_login(), Some(Ok("work-acct".to_string())));
        }
        assert_eq!(scoped_login(), Some(Ok("work-acct".to_string())));
    }
    assert_eq!(reads.get(), 1, "a nested scope for the same workspace reuses the token");
    assert_eq!(scoped_login(), None);
}

// ── Redaction ─────────────────────────────────────────────────────────

#[test]
fn outputs_and_errors_read_inside_a_scope_never_carry_the_token() {
    let _scope = enter(Some("ws"), Ok(Some(test_env())));
    assert_eq!(redact(&format!("fatal: {TOKEN} refused")), "fatal: ••• refused");
    let mut out = std::process::Output {
        status: std::process::ExitStatus::default(),
        stdout: format!("ok {TOKEN}\n").into_bytes(),
        stderr: format!("warn {TOKEN}").into_bytes(),
    };
    redact_output(&mut out);
    assert_eq!(String::from_utf8_lossy(&out.stdout), "ok •••\n");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "warn •••");
}

/// Through the real `gh` chokepoint (`github::gh_output`, Ship's PR flow):
/// the stub gets the token, what comes back doesn't show it.
#[cfg(unix)]
#[test]
fn ships_gh_runs_with_the_token_and_its_answer_comes_back_redacted() {
    let dir = tempfile::tempdir().unwrap();
    let gh = stub_gh(dir.path());
    let _scope = enter(Some("ws"), Ok(Some(GhEnv::for_test("work-acct", TOKEN, &gh))));
    let out = crate::github::gh_output(
        &gh,
        Some(dir.path()),
        &["pr", "create", "--title", "t"],
        Duration::from_secs(20),
    )
    .unwrap();
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stdout.contains("pull/7 made with •••"), "{stdout}");
    assert!(!stdout.contains(TOKEN) && !stderr.contains(TOKEN), "{stdout} {stderr}");
    assert_eq!(gh_log(dir.path()), vec!["pr create --title t|GH_TOKEN=yes".to_string()]);
}

/// `shared_config::Gh` (adoption, the definition's PRs) goes through
/// `worktrees::run_bounded`: token in, redacted out.
#[cfg(unix)]
#[test]
fn the_shared_definitions_gh_runs_with_the_token_too() {
    let dir = tempfile::tempdir().unwrap();
    let gh = stub_gh(dir.path());
    let _scope = enter(Some("ws"), Ok(Some(GhEnv::for_test("work-acct", TOKEN, &gh))));
    let shared = crate::shared_config::Gh::new(gh.clone());
    let url = shared
        .pr_create(dir.path(), "o/r", "main", "ply/def", "t", "b")
        .unwrap();
    assert!(!url.contains(TOKEN), "{url}");
    assert!(gh_log(dir.path())[0].ends_with("|GH_TOKEN=yes"));
}

// ── git's credential helper (MEASUREMENTS §9) ──────────────────────────

/// A real `git credential fill` with the user's own helper configured
/// (which ignores GH_TOKEN, like osxkeychain/store): inside the scope git
/// asks gh, and gh answers with the workspace's token.
#[cfg(unix)]
#[test]
fn git_asks_gh_for_the_workspaces_token_instead_of_the_users_own_helper() {
    let dir = tempfile::tempdir().unwrap();
    let gh = stub_gh(dir.path());
    let global = dir.path().join("gitconfig");
    fs::write(
        &global,
        "[credential]\n\thelper = \"!f() { cat >/dev/null; echo username=stored; echo password=stored-account; }; f\"\n",
    )
    .unwrap();
    let fill = |scoped: bool| -> String {
        let _scope = scoped.then(|| enter(Some("ws"), Ok(Some(GhEnv::for_test("work-acct", TOKEN, &gh)))));
        let mut git = crate::platform::git_command();
        git.env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", &global)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env_remove("GH_TOKEN")
            .current_dir(dir.path());
        apply_to_network_git(&mut git, dir.path()).unwrap();
        git.args(["credential", "fill"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = git.spawn().unwrap();
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"protocol=https\nhost=github.com\n\n")
            .unwrap();
        let out = child.wait_with_output().unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    let without = fill(false);
    assert!(without.contains("password=stored-account"), "{without}");
    let with = fill(true);
    assert!(with.contains(&format!("password={TOKEN}")), "{with}");
    assert!(with.contains("username=x-access-token"), "{with}");
    // The helper asked gh for that login's token itself, with no GH_TOKEN.
    assert!(
        gh_log(dir.path()).contains(&"auth token --user work-acct|GH_TOKEN=no".to_string()),
        "{:?}",
        gh_log(dir.path())
    );
}

/// P3-1: a hook git runs during a Plyloft push (pre-push) never sees a
/// GitHub token — git's environment doesn't hold one.
#[cfg(unix)]
#[test]
fn a_pre_push_hook_sees_no_github_token() {
    let dir = tempfile::tempdir().unwrap();
    let gh = stub_gh(dir.path());
    let origin = dir.path().join("origin.git");
    let work = dir.path().join("work");
    let run = |cwd: &Path, args: &[&str]| {
        let mut git = plain_git();
        git.current_dir(cwd).args(args);
        assert!(git.status().unwrap().success(), "git {args:?}");
    };
    run(dir.path(), &["init", "-q", "--bare", origin.to_str().unwrap()]);
    run(dir.path(), &["init", "-q", "-b", "main", work.to_str().unwrap()]);
    run(&work, &["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "one"]);
    run(&work, &["remote", "add", "origin", origin.to_str().unwrap()]);
    let hooks = dir.path().join("hooks");
    fs::create_dir_all(&hooks).unwrap();
    let seen = dir.path().join("hook-env");
    let hook = hooks.join("pre-push");
    fs::write(&hook, format!("#!/bin/sh
env > \"{}\"\n", seen.display())).unwrap();
    crate::platform::set_mode(&hook, 0o755).unwrap();
    // Repository-local, so it wins over any global hooksPath.
    run(&work, &["config", "core.hooksPath", hooks.to_str().unwrap()]);

    let _scope = enter(Some("ws"), Ok(Some(GhEnv::for_test("work-acct", TOKEN, &gh))));
    let out = crate::worktrees::run_bounded_network_git_in(
        &work,
        &["push", "origin", "main"],
        Duration::from_secs(60),
        crate::worktrees::exit_registry(),
    )
    .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let env = fs::read_to_string(&seen).expect("the hook ran");
    assert!(!env.contains(TOKEN), "the hook saw the token");
    assert!(
        env.lines().all(|l| !l.starts_with("GH_TOKEN=") && !l.starts_with("GITHUB_TOKEN=")),
        "the hook saw a GitHub token variable"
    );
}

// ── D7: agent terminals never get it ──────────────────────────────────

/// Every agent spawn kind builds its environment with `pty::session_env`:
/// tiles / Builder / reviewers / discussions (`spawn`), intake
/// (`spawn_with_capture`), verify steps (`spawn_collect`, with the caller's
/// variables). Built on a thread whose GitHub calls use a token, none of
/// them carries it.
#[test]
fn no_agent_spawn_environment_carries_the_workspace_token() {
    let _scope = enter(Some("ws"), Ok(Some(test_env())));
    // Sanity: this thread's GitHub calls do use it.
    let mut gh = crate::platform::new_command("gh");
    apply_to_gh(&mut gh).unwrap();
    assert_eq!(env_of(&gh, "GH_TOKEN"), Some(Some(TOKEN.to_string())));

    let verify_env = vec![("CARGO_TARGET_DIR".to_string(), "/tmp/t".to_string())];
    let managed = vec![("CODEX_HOME".to_string(), "/tmp/codex".to_string())];
    let kinds: [(&str, bool, &[(String, String)], &[(String, String)]); 4] = [
        ("tile / Builder / reviewer / discussion (spawn)", true, &[], &managed),
        ("intake (spawn_with_capture)", true, &[], &[]),
        ("verify step (spawn_collect)", false, &verify_env, &[]),
        ("plain tile", true, &[], &[]),
    ];
    for (kind, shell_integration, extra, managed) in kinds {
        let mut command = portable_pty::CommandBuilder::new("claude");
        crate::pty::session_env(&mut command, "/usr/bin:/bin", shell_integration, extra, managed);
        for (key, value) in command.iter_full_env_as_str() {
            assert!(!value.contains(TOKEN), "{kind}: {key} carries the token");
        }
        for key in ["GH_TOKEN", "GITHUB_TOKEN"] {
            let value = command.get_env(key).map(|v| v.to_string_lossy().into_owned());
            assert_ne!(value.as_deref(), Some(TOKEN), "{kind}: {key}");
        }
    }
}

fn source(file: &str) -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(file)).unwrap()
}

/// The body of `fn <name>` (up to the next top-level item).
fn body_of(file: &str, name: &str) -> String {
    let text = source(file);
    let start = [format!("fn {name}("), format!("fn {name}<")]
        .iter()
        .filter_map(|needle| text.find(needle.as_str()))
        .min()
        .unwrap_or_else(|| panic!("fn {name} in {file}"));
    let rest = &text[start..];
    let end = rest.find("\n}\n").map(|i| i + 3).unwrap_or(rest.len());
    rest[..end].to_string()
}

#[test]
fn every_pty_spawn_builds_its_environment_through_session_env_only() {
    let pty = source("pty.rs");
    assert_eq!(pty.matches("session_env(&mut command").count(), 4, "spawn, spawn_with_capture, spawn_collect, spawn_chat");
    // The only GitHub token names in pty.rs are the Setup scrub list.
    let mentions = pty.matches("GH_TOKEN").count();
    assert_eq!(mentions, 1, "pty.rs mentions GH_TOKEN only in SETUP_SCRUBBED_ENV");
    // The agent-spawning modules never reach into the account's scope.
    for file in [
        "pty.rs", "agents.rs", "builder.rs", "reviewer.rs", "discussion.rs", "intake.rs",
        "verify.rs", "swarms.rs", "codex_app.rs", "mcp_launch.rs",
    ] {
        let text = source(file);
        for needle in ["github_account::apply_to", "GhEnv", "expose()"] {
            assert!(!text.contains(needle), "{file} contains {needle}");
        }
    }
}

#[test]
fn plyloft_never_puts_a_github_token_in_its_own_process_environment() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for entry in fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap();
        for needle in ["set_var(\"GH_TOKEN\"", "set_var(\"GITHUB_TOKEN\""] {
            assert!(!text.contains(needle), "{} sets {needle}", path.display());
        }
    }
}

/// The chokepoints apply the scope; the call sites that act for a
/// workspace open it (the audit in the OB-7b report).
#[test]
fn the_chokepoints_and_the_workspace_call_sites_use_the_scope() {
    // R12: gh_output and gh_output_with_stdin both run through gh_output_fed,
    // which applies the scope; gh_output_tail applies it itself.
    assert!(body_of("github.rs", "gh_output_fed").contains("github_account::apply_to_gh(&mut cmd)?"));
    for wrapper in ["gh_output", "gh_output_with_stdin"] {
        let body = body_of("github.rs", wrapper);
        assert!(body.contains("gh_output_fed(gh, cwd, args, timeout,"), "{wrapper} goes through gh_output_fed");
        assert!(!body.contains("new_command("), "{wrapper} builds no gh command of its own");
    }
    assert!(body_of("github.rs", "gh_output_tail").contains("github_account::apply_to_gh(&mut cmd)?"));
    assert!(source("shared_config.rs").contains(
        "crate::github_account::apply_to_gh(&mut cmd)?;\n        cmd.args(args)\n            .current_dir(cwd)"
    ));
    assert!(body_of("shared_config.rs", "remote_branch_exists").contains("apply_to_network_git"));
    assert!(body_of("worktrees.rs", "run_bounded_git_in").contains("apply_to_network_git"));
    assert!(body_of("worktrees.rs", "run_bounded_network_git_in").contains("apply_to_network_git"));
    // OB-10 moved the read-back into `run_bounded_output_capped_in`, which
    // every bounded read (capped or not) goes through.
    assert!(body_of("worktrees.rs", "run_bounded_output_in").contains("run_bounded_output_capped_in("));
    assert!(body_of("worktrees.rs", "run_bounded_output_capped_in").contains("redact_output"));
    assert!(body_of("github.rs", "current_login_at").contains("github_account::scoped_login()"));
    let sites: &[(&str, &str)] = &[
        ("commands.rs", "kanban_card_create"),
        ("commands.rs", "kanban_card_delete_github"),
        ("commands.rs", "kanban_card_patch"),
        // 1.175.0: the claim's functions moved to `card_claim.rs`.
        ("card_claim.rs", "claim_card"),
        ("card_claim.rs", "device_claim_card"),
        ("commands.rs", "kanban_card_use_issue_remainder"),
        ("commands.rs", "card_overlap_check"),
        // SL-4: the claim gate and the worktree's fetch moved into the staged
        // half; the wrapper only runs the setup it hands back.
        ("commands.rs", "advance_card_to_in_progress_staged"),
        ("commands.rs", "card_ship_blocking_with"),
        ("commands.rs", "card_ship_with_follow_up_blocking"),
        ("commands.rs", "kanban_github_reconcile"),
        ("commands.rs", "kanban_github_refresh"),
        ("commands.rs", "set_kanban_sync_mode_blocking"),
        ("commands.rs", "kanban_github_push_local"),
        ("commands.rs", "push_in_progress_label_in_background"),
        ("commands.rs", "land_card_local"),
        ("commands.rs", "close_landed_skill_card_issues"),
        ("commands.rs", "worktree_trash_untracked"),
        ("github_sync.rs", "post_card_outcome_comment"),
        ("ship.rs", "ship_card"),
        // 1.174.0 (DR2/DR3): Ship batch and Release Site… share the release's
        // body, `release_cards`; Release Site…'s scope fetches GitHub first.
        ("ship.rs", "release_cards"),
        ("release_scope.rs", "scope_for_app"),
        ("release_scope.rs", "scopes_for_app"),
        ("ship.rs", "finish_release"),
        ("kanban.rs", "pump_card_queue"),
        ("inbox.rs", "assemble_feed"),
        ("workspace_adoption.rs", "app_status"),
        ("workspace_adoption.rs", "app_share"),
        ("workspace_definition.rs", "with_app_stores"),
        // G5: the merged card's branch delete, its ls-remote and the fetch.
        ("after_merge.rs", "after_merge_for_card"),
        ("after_merge.rs", "bring_up_to_date_press"),
    ];
    for (file, name) in sites {
        assert!(
            body_of(file, name).contains("github_account::enter_for_"),
            "{file}::{name} opens no GitHub account scope"
        );
    }
}

#[test]
fn ssh_origins_are_told_apart() {
    assert!(is_ssh_url("git@github.com:o/r.git"));
    assert!(is_ssh_url("ssh://git@github.com/o/r.git"));
    assert!(!is_ssh_url("https://github.com/o/r.git"));
    assert!(!is_ssh_url("https://user@github.com/o/r.git"));
}

#[test]
fn only_several_accounts_ask_which_one() {
    let account = |login: &str, active: bool| crate::setup_run::GhAccount {
        login: login.into(),
        signed_in: true,
        active,
        scopes: None,
    };
    assert!(!account_choice_needed(&[]));
    assert!(!account_choice_needed(&[account("a", true)]));
    assert!(account_choice_needed(&[account("a", true), account("b", false)]));
}

#[test]
fn settings_rows_list_github_origins_with_their_account() {
    let dir = tempfile::tempdir().unwrap();
    let repo = |name: &str, url: Option<&str>| {
        let path = dir.path().join(name);
        fs::create_dir_all(&path).unwrap();
        let mut init = plain_git();
        init.current_dir(&path).args(["init", "-q"]);
        assert!(init.status().unwrap().success());
        if let Some(url) = url {
            let mut add = plain_git();
            add.current_dir(&path).args(["remote", "add", "origin", url]);
            assert!(add.status().unwrap().success());
        }
        path.to_string_lossy().into_owned()
    };
    let ws = |id: &str, cwd: String, account: Option<&str>| {
        let mut w: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "cwd": cwd, "createdAt": 0, "lastOpenedAt": 0
        }))
        .unwrap();
        w.github_account = account.map(String::from);
        w
    };
    let list = vec![
        ws("https", repo("a", Some("https://github.com/acme/app.git")), Some("work-acct")),
        ws("ssh", repo("b", Some("git@github.com:me/tool.git")), None),
        ws("gitlab", repo("c", Some("https://gitlab.com/x/y.git")), None),
        ws("none", repo("d", None), None),
        ws("gone", dir.path().join("missing").to_string_lossy().into_owned(), None),
    ];
    let rows = workspace_rows(&tools(None), &list);
    assert_eq!(
        rows,
        vec![
            WorkspaceGithub {
                id: "https".into(),
                name: "https".into(),
                repo: "acme/app".into(),
                ssh: false,
                account: Some("work-acct".into()),
            },
            WorkspaceGithub {
                id: "ssh".into(),
                name: "ssh".into(),
                repo: "me/tool".into(),
                ssh: true,
                account: None,
            },
        ]
    );
}

// ── N14: the team's account (OB-7b chokepoints, LAUNCH_PLAN T4) ───────

/// Two accounts signed in: gh's active one is `main-acct`, the team was
/// joined as `work-acct`. Inside the team's scope gh runs with `work-acct`'s
/// token; with the active account chosen (or none) it runs untouched.
#[cfg(unix)]
#[test]
fn the_teams_gh_runs_as_the_teams_account_not_the_active_one() {
    let dir = tempfile::tempdir().unwrap();
    let gh = stub_gh(dir.path());
    let run = |gh: &str| {
        crate::github::gh_output(gh, Some(dir.path()), &["pr", "create", "--title", "t"], Duration::from_secs(20))
            .unwrap()
    };
    {
        let stub = gh.clone();
        let _team = enter_for_team_with(Some("work-acct"), move |login| resolve(&tools(Some(stub)), Some(login)));
        assert_eq!(scoped_login(), Some(Ok("work-acct".to_string())));
        assert!(run(&gh).status.success());
    }
    {
        let stub = gh.clone();
        let _team = enter_for_team_with(Some("main-acct"), move |login| resolve(&tools(Some(stub)), Some(login)));
        assert_eq!(scoped_login(), None, "the active account needs no token");
        assert!(run(&gh).status.success());
    }
    assert_eq!(
        gh_log(dir.path()),
        vec![
            "config get -h github.com user|GH_TOKEN=no".to_string(),
            "auth token --user work-acct|GH_TOKEN=no".to_string(),
            "pr create --title t|GH_TOKEN=yes".to_string(),
            "config get -h github.com user|GH_TOKEN=no".to_string(),
            "pr create --title t|GH_TOKEN=no".to_string(),
        ]
    );
}

/// No team account set: nothing is read and nothing injected — and an
/// enclosing workspace's account is not what the team's calls use.
#[test]
fn no_team_account_is_gh_active_account_even_inside_a_workspace_scope() {
    let _workspace = enter(Some("ws"), Ok(Some(test_env())));
    {
        let _team = enter_for_team_with(None, |_| panic!("no account: nothing to read"));
        assert_eq!(scoped_login(), None);
        let _blank = enter_for_team_with(Some("  "), |_| panic!("blank: nothing to read"));
        assert_eq!(scoped_login(), None);
    }
    assert_eq!(scoped_login(), Some(Ok("work-acct".to_string())), "the workspace's scope comes back");
}

/// The team's account is read once, on first use, and a team account that
/// can't be used fails the team's calls in words instead of using another.
#[test]
fn the_team_account_is_read_lazily_once_and_never_falls_back() {
    let reads = Rc::new(std::cell::Cell::new(0));
    {
        let counted = reads.clone();
        let _team = enter_for_team_with(Some("work-acct"), move |login| {
            counted.set(counted.get() + 1);
            assert_eq!(login, "work-acct");
            Ok(Some(test_env()))
        });
        assert_eq!(reads.get(), 0, "opening the scope reads nothing");
        assert_eq!(scoped_login(), Some(Ok("work-acct".to_string())));
        assert_eq!(scoped_login(), Some(Ok("work-acct".to_string())));
    }
    assert_eq!(reads.get(), 1);
    let _signed_out = enter_for_team_with(Some("gone-acct"), |_| Err("gone-acct isn't signed in".into()));
    let mut gh = crate::platform::new_command("gh");
    assert!(apply_to_gh(&mut gh).unwrap_err().contains("isn't signed in"));
    assert!(crate::github::current_login().unwrap_err().contains("isn't signed in"));
}

/// The owner gate's login is the team's account inside its scope, whatever
/// login gh's active account cached.
#[test]
fn inside_the_team_scope_the_login_is_the_teams_account() {
    let _team = enter_for_team_with(Some("work-acct"), |_| Ok(Some(test_env())));
    assert_eq!(crate::github::current_login().unwrap(), "work-acct");
    assert!(crate::team_admin::authorize_owner_action(
        true,
        Some("work-acct"),
        crate::github::current_login().ok().as_deref()
    )
    .is_ok());
}

/// Discovery's probe lanes are threads: each opens the caller's account.
#[test]
fn a_handoff_carries_the_account_into_a_spawned_thread() {
    let _team = enter_for_team_with(Some("work-acct"), |_| Ok(Some(test_env())));
    let account = handoff();
    let seen = std::thread::spawn(move || {
        let _scope = account.enter();
        scoped_login()
    })
    .join()
    .unwrap();
    assert_eq!(seen, Some(Ok("work-acct".to_string())));
    let failed = {
        let _bad = enter(None, Err("signed out".into()));
        handoff()
    };
    let seen = std::thread::spawn(move || {
        let _scope = failed.enter();
        scoped_login()
    })
    .join()
    .unwrap();
    assert_eq!(seen, Some(Err("signed out".to_string())));
}

/// `github::repos_carrying` (discovery's lanes) hands its account over.
#[test]
fn discoverys_probe_lanes_open_the_callers_account() {
    let body = body_of("github.rs", "repos_carrying");
    let handoff = body.find("github_account::handoff()").expect("a handoff");
    let spawn = body.find("scope.spawn(").expect("the lanes");
    assert!(handoff < spawn);
    assert!(body.contains("account.enter()"));
}

/// N14 (P3-3): the team's refusals speak of the team, not a workspace.
#[cfg(unix)]
#[test]
fn a_signed_out_team_account_is_said_in_team_words() {
    let dir = tempfile::tempdir().unwrap();
    let gh = stub_gh(dir.path());
    let words = resolve(&tools(Some(gh)), Some("gone-acct")).unwrap_err();
    let said = team_words("gone-acct", &words);
    assert!(said.starts_with("Your team uses the GitHub account gone-acct, which isn't signed in"), "{said}");
    assert!(!said.contains("workspace"), "{said}");
    let missing = resolve(&tools(None), Some("gone-acct")).unwrap_err();
    assert!(team_words("gone-acct", &missing).contains("GitHub CLI isn't installed"));
}

/// N14 walk F16b: `src/lib/ghTrouble.ts` turns the team's refusals into one
/// line naming the account; its patterns and these words move together.
#[test]
fn the_team_account_words_are_the_ones_the_page_reads() {
    let said = team_words("test-owner", "isn't signed in");
    assert!(
        said.starts_with(&format!(
            "Your team uses the GitHub account test-owner, which isn't signed in on {}. ",
            crate::platform::THIS_MACHINE
        )),
        "{said}"
    );
    let missing = team_words("test-owner", "the GitHub CLI isn't installed");
    assert!(
        missing.starts_with("Your team uses the GitHub account test-owner, and the GitHub CLI isn't installed. "),
        "{missing}"
    );
    let page = include_str!("../../src/lib/ghTrouble.ts");
    for pattern in [
        "(?:Your team|This workspace) uses the GitHub account ([A-Za-z0-9-]+), which isn't signed in on (?:this|your) (?:Mac|PC|computer|machine)",
        "(?:Your team|This workspace) uses the GitHub account ([A-Za-z0-9-]+), and the GitHub CLI isn't installed",
    ] {
        assert!(page.contains(pattern), "ghTrouble.ts no longer reads: {pattern}");
    }
}
