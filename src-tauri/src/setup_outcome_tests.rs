//! R2: the cause of a run that didn't work, read from realistic tails.

use super::*;

fn lines(text: &str) -> Vec<String> {
    text.lines().map(String::from).collect()
}

fn cause(text: &str) -> Diagnosis {
    classify(&lines(text), Some(1), false)
}

#[test]
fn npms_eacces_block_is_permissions_with_its_path() {
    let tail = "\
added 3 packages in 2s
npm error code EACCES
npm error syscall mkdir
npm error path /usr/local/lib/node_modules/@anthropic-ai
npm error errno -13
npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@anthropic-ai'
npm error     at async mkdir (node:internal/fs/promises:858:10)
npm error
npm error The operation was rejected by your operating system.
npm error It is likely you do not have the permissions to access this file as the current user
npm error A complete log of this run can be found in: /Users/me/.npm/_logs/2026-11-21T10_00_00_000Z-debug-0.log";
    let d = cause(tail);
    assert_eq!(d.cause, Cause::Permissions);
    assert_eq!(d.path.as_deref(), Some("/usr/local/lib/node_modules/@anthropic-ai"));
    // npm before 10 says `npm ERR!`.
    let old = "npm ERR! code EACCES\nnpm ERR! path /usr/local/lib/node_modules\nnpm ERR! Error: EACCES: permission denied, access '/usr/local/lib/node_modules'";
    assert_eq!(cause(old).path.as_deref(), Some("/usr/local/lib/node_modules"));
}

#[test]
fn claude_updates_own_permission_words_are_permissions() {
    let d = cause("Checking for updates...\nFailed to update: EACCES: permission denied, open '/Users/me/.local/share/claude/versions/2.0.14'");
    assert_eq!(d.cause, Cause::Permissions);
    assert_eq!(d.path.as_deref(), Some("/Users/me/.local/share/claude/versions/2.0.14"));
    let d = cause("Current version: 2.0.1\nChecking for updates...\nError: Insufficient permissions to install update");
    assert_eq!(d.cause, Cause::Permissions);
    assert_eq!(d.path, None);
    let d = cause("Error: Permission denied @ apply2files - /usr/local/lib/node_modules/.bin/claude");
    assert_eq!(d.path.as_deref(), Some("/usr/local/lib/node_modules/.bin/claude"));
    let d = cause("cp: /Users/me/.local/bin/claude: Operation not permitted");
    assert_eq!((d.cause, d.path.as_deref()), (Cause::Permissions, Some("/Users/me/.local/bin/claude")));
    let d = cause("Error: Permission denied (os error 13)");
    assert_eq!(d.cause, Cause::Permissions);
}

#[test]
fn windows_refusals_are_permissions_with_the_quoted_path() {
    // A program file refused is a file in use (Windows locks a running one).
    let d = cause("Move-Item : Access to the path 'C:\\Program Files\\nodejs\\claude.cmd' is denied.\nAt line:1 char:1");
    assert_eq!(d.cause, Cause::FileInUse);
    assert_eq!(d.path.as_deref(), Some("C:\\Program Files\\nodejs\\claude.cmd"));
    assert_eq!(cause("Error: Access is denied. (os error 5)").cause, Cause::Permissions);
}

#[test]
fn the_powershell_file_in_use_sentence_is_file_in_use() {
    let d = cause("Copy-Item : The process cannot access the file 'C:\\Users\\me\\.local\\bin\\claude.exe' because it is being used by another process.\nAt line:3 char:5");
    assert_eq!(d.cause, Cause::FileInUse);
    assert_eq!(d.path.as_deref(), Some("C:\\Users\\me\\.local\\bin\\claude.exe"));
    assert_eq!(cause("npm error code EBUSY\nnpm error syscall rename").cause, Cause::FileInUse);
    assert_eq!(cause("cp: /Users/me/.local/bin/codex: Text file busy").cause, Cause::FileInUse);
}

#[test]
fn a_full_disk_wins_over_the_refusals_it_brings() {
    let tail = "npm error code ENOSPC\nnpm error syscall write\nnpm error errno -28\nnpm error nospc ENOSPC: no space left on device, write\nnpm error EACCES: permission denied, unlink '/tmp/x'";
    assert_eq!(cause(tail).cause, Cause::DiskFull);
    assert_eq!(cause("There is not enough space on the disk. (os error 112)").cause, Cause::DiskFull);
}

#[test]
fn curls_errors_and_proxy_words_are_the_network() {
    for tail in [
        "curl: (6) Could not resolve host: claude.ai",
        "curl: (7) Failed to connect to claude.ai port 443 after 12 ms: Couldn't connect to server",
        "curl: (28) Operation timed out after 300000 milliseconds with 0 bytes received",
        "curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to claude.ai:443",
        "curl: (56) CONNECT tunnel failed, response 407",
        "npm error code ECONNRESET\nnpm error network aborted",
        "npm error code ENOTFOUND\nnpm error request to https://registry.npmjs.org/@openai%2fcodex failed",
        "Invoke-RestMethod : The remote name could not be resolved: 'claude.ai'",
        "error: failed to download: proxy authentication required",
    ] {
        let d = cause(tail);
        assert_eq!(d.cause, Cause::Network, "{tail}");
        assert_eq!(d.path, None, "{tail}");
    }
    // curl's exit code alone, when curl ran.
    let d = classify(&lines("+ curl -fsSL https://claude.ai/install.sh"), Some(6), false);
    assert_eq!(d.cause, Cause::Network);
    assert_eq!(classify(&lines("installing"), Some(6), false).cause, Cause::Unknown);
}

#[test]
fn an_installers_chatter_is_not_a_cause() {
    assert_eq!(cause("added 407 packages in 3s\nnpm error something odd").cause, Cause::Unknown);
    assert_eq!(cause("exited with os error 130").cause, Cause::Unknown);
    assert_eq!(classify(&[], None, false).cause, Cause::Unknown);
}

#[test]
fn a_run_stopped_at_its_limit_is_timed_out_whatever_it_printed() {
    let d = classify(&lines("npm error EACCES: permission denied"), None, true);
    assert_eq!(d, Diagnosis { cause: Cause::TimedOut, path: None });
}

#[test]
fn paths_are_found_quoted_or_bare_and_urls_are_not_paths() {
    assert_eq!(path_in("rm: cannot remove '/a/b': Permission denied").as_deref(), Some("/a/b"));
    assert_eq!(path_in("open \"/x y/z\" failed").as_deref(), Some("/x y/z"));
    assert_eq!(path_in("mkdir ~/bin: denied").as_deref(), Some("~/bin"));
    assert_eq!(path_in("see https://example.com/a for help"), None);
    assert_eq!(path_in("an 'unclosed /quote"), Some("/quote".into()));
    assert_eq!(path_in("permission denied"), None);
}

#[test]
fn a_version_is_read_from_stdout_and_from_stderr_only_on_success() {
    assert_eq!(version_from_output("2.0.14 (Claude Code)\n", "", true).as_deref(), Some("2.0.14"));
    assert_eq!(version_from_output("", "codex-cli 0.80.0", true).as_deref(), Some("0.80.0"));
    assert_eq!(version_from_output("", "Node.js v22.1.0", false), None);
}

#[test]
fn only_installs_and_updates_have_a_tool_and_only_updates_compare() {
    use crate::setup_actions::ALL_ACTIONS;
    for action in ALL_ACTIONS {
        assert_eq!(program_tool(action).is_some(), action.changes_programs(), "{action:?}");
        if is_update(action) {
            assert!(action.id().starts_with("update."));
        }
    }
    assert!(limited(Watch::ToolWorks(Tool::Claude)));
    assert!(!limited(Watch::ClaudeSignIn) && !limited(Watch::CommandLineTools));
}

#[test]
fn an_updater_claiming_a_new_version_is_read_from_its_own_words() {
    for said in [
        "Successfully updated from 2.1.300 to version 2.1.330",
        "Updating Codex CLI from 0.170.0 to 0.171.0",
        "==> Upgrading gh 2.60.0 -> 2.61.0",
        "Successfully installed",
    ] {
        assert!(claims_update(&lines(said)), "{said}");
    }
    for quiet in [
        "Checking for updates to latest version...\nClaude Code is up to date (2.1.330)",
        "Updating Codex CLI",
        "Warning: gh 2.61.0 already installed",
        "",
    ] {
        assert!(!claims_update(&lines(quiet)), "{quiet}");
    }
}

#[test]
fn r0s_measured_refusals_are_permissions_with_their_paths() {
    // Claude's updater over a read-only versions folder (R0, C4).
    let d = cause("Error: Failed to install native update\nError: EACCES: permission denied, open '/Users/me/.local/share/claude/versions/2.1.330'\nTry running \"claude doctor\" for diagnostics");
    assert_eq!(d.cause, Cause::Permissions);
    assert_eq!(d.path.as_deref(), Some("/Users/me/.local/share/claude/versions/2.1.330"));
    // Codex's installer over a read-only ~/.local/bin (R0, X4).
    // The refused name is a temporary file: the folder is what to fix.
    let d = cause("ln: /Users/me/.local/bin/.codex.59509: Permission denied");
    assert_eq!(d.path.as_deref(), Some("/Users/me/.local/bin"));
}

/// npm's real Windows block when `codex.exe` runs in a tile while npm
/// replaces it: EPERM on the `.exe`, warnings around it.
const NPM_WINDOWS_EPERM: &str = r"npm warn cleanup Failed to remove some directories [
npm warn cleanup   [
npm warn cleanup     'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\.codex-Xk2bQ1',
npm warn cleanup     [Error: EPERM: operation not permitted, rmdir 'C:\Users\me\AppData\Roaming\npm\node_modules\@openai\.codex-Xk2bQ1\vendor'] {
npm warn cleanup       errno: -4048,
npm warn cleanup       code: 'EPERM',
npm warn cleanup       syscall: 'rmdir',
npm warn cleanup     }
npm warn cleanup   ]
npm warn cleanup ]
npm error code EPERM
npm error syscall unlink
npm error path C:\Users\me\AppData\Roaming\npm\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\codex\codex.exe
npm error errno -4048
npm error [Error: EPERM: operation not permitted, unlink 'C:\Users\me\AppData\Roaming\npm\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\codex\codex.exe'] {
npm error   errno: -4048,
npm error   code: 'EPERM',
npm error   syscall: 'unlink',
npm error   path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe'
npm error }
npm error
npm error The operation was rejected by your operating system.
npm error It's possible that the file was already in use (by a text editor or antivirus),
npm error or that you lack permissions to access it.";

#[test]
fn windows_refusing_a_running_program_is_a_file_in_use() {
    let d = cause(NPM_WINDOWS_EPERM);
    assert_eq!(d.cause, Cause::FileInUse);
    assert!(d.path.as_deref().unwrap().ends_with(r"\codex\codex.exe"), "{:?}", d.path);
    let d = cause(r"Copy-Item : Access to the path 'C:\Users\me\.local\bin\claude.exe' is denied.");
    assert_eq!(d.cause, Cause::FileInUse);
    // A folder refused is still permissions.
    let d = cause(r"Access to the path 'C:\Program Files\nodejs\node_modules' is denied.");
    assert_eq!(d.cause, Cause::Permissions);
}

#[test]
fn npm_warnings_never_outrank_the_real_error() {
    let tail = "npm warn cleanup [Error: EPERM: operation not permitted, rmdir '/x/.codex-a']\nnpm error code ECONNRESET\nnpm error network aborted";
    assert_eq!(cause(tail).cause, Cause::Network);
    assert_eq!(cause("npm WARN deprecated EACCES-ish words").cause, Cause::Unknown);
}

#[test]
fn a_407_is_a_status_never_a_version_or_a_count() {
    assert_eq!(cause("error: downloading 2.1.407 failed").cause, Cause::Unknown);
    assert_eq!(cause("error: HTTP 407 from the server").cause, Cause::Network);
    assert_eq!(cause("error: response 407 Proxy Authentication Required").cause, Cause::Network);
    assert!(!crate::setup_actions::proxy_words("version 2.1.407 http"));
}

#[test]
fn the_folder_to_fix_is_the_folder_a_refused_file_is_in() {
    assert_eq!(folder_to_fix("/Users/me/.local/share/claude/versions/2.1.330", false), "/Users/me/.local/share/claude/versions");
    assert_eq!(folder_to_fix("/usr/local/lib/node_modules", true), "/usr/local/lib/node_modules");
    assert_eq!(folder_to_fix(r"C:\Users\me\x\claude.cmd", false), r"C:\Users\me\x");
    assert_eq!(folder_to_fix("/claude", false), "/");
}

#[test]
fn versions_compare_as_numbers_and_winget_says_when_nothing_is_newer() {
    assert_eq!(version_change(Some("2.1.300"), Some("2.1.330")), VersionChange::Higher);
    assert_eq!(version_change(Some("2.1.330"), Some("2.1.300")), VersionChange::Lower);
    assert_eq!(version_change(Some("2.1.99"), Some("2.1.100")), VersionChange::Higher, "not a string order");
    assert_eq!(version_change(Some("2.1.330"), Some("2.1.330")), VersionChange::Same);
    assert_eq!(version_change(Some("nightly-a"), Some("nightly-b")), VersionChange::Differs);
    assert_eq!(version_change(None, Some("2.1.330")), VersionChange::Higher, "broken before, answers now");
    assert_eq!(version_change(Some("2.1.330"), None), VersionChange::Unreadable);
    assert!(newer_known(Some("2.1.283"), Some("2.1.290")));
    assert!(!newer_known(Some("2.1.290"), Some("2.1.290")));
    assert!(!newer_known(None, Some("2.1.290")) && !newer_known(Some("2.1.283"), None));
    // The doc's codes, signed as the PTY reports them and unsigned.
    for code in [-1978335189, -1978335153, -1978335152, -1978335135, -1978334962] {
        assert!(winget_nothing_newer(Some(code)), "{code}");
    }
    assert!(winget_nothing_newer(Some(0x8A15_002Bu32 as i32)));
    assert!(!winget_nothing_newer(Some(-1978334963)), "INSTALL_ALREADY_INSTALLED names no order");
    assert!(!winget_nothing_newer(Some(1)) && !winget_nothing_newer(None));
}

/// 1.176.1: the owner's MacBook — the installer step ran with a Program
/// folders setting that held no folder, so `curl`/`bash` weren't found and it
/// ended `exit 127, cause unknown`. It has its own cause now, with the name.
#[test]
fn a_command_that_is_not_found_has_its_own_cause_and_name() {
    let tail = |lines: &[&str]| lines.iter().map(|l| l.to_string()).collect::<Vec<_>>();
    let real = tail(&["Installing Claude Code…", "bash: line 1: curl: command not found"]);
    assert_eq!(classify(&real, Some(127), false), Diagnosis { cause: Cause::CommandNotFound, path: Some("curl".into()) });
    let zsh = tail(&["zsh: command not found: bash"]);
    assert_eq!(classify(&zsh, Some(127), false).path.as_deref(), Some("bash"));
    let env = tail(&["env: node: No such file or directory"]);
    assert_eq!(classify(&env, Some(127), false), Diagnosis { cause: Cause::CommandNotFound, path: Some("node".into()) });
    let cmd = tail(&["'curl' is not recognized as an internal or external command,", "operable program or batch file."]);
    assert_eq!(classify(&cmd, Some(9009), false), Diagnosis { cause: Cause::CommandNotFound, path: Some("curl".into()) });
    let ps = tail(&["The term 'npm' is not recognized as the name of a cmdlet, function, script file, or operable program."]);
    assert_eq!(classify(&ps, Some(1), false).path.as_deref(), Some("npm"), "PowerShell exits 1: only its words say it");
    // The exit alone, with nothing readable: the cause without a name.
    assert_eq!(classify(&[], Some(127), false), Diagnosis { cause: Cause::CommandNotFound, path: None });
    // Review 1: 126 is "found but can't be run": not this cause.
    assert_eq!(classify(&[], Some(126), false).cause, Cause::Unknown);
    let no_x = tail(&["bash: ./install.sh: Permission denied"]);
    assert_eq!(classify(&no_x, Some(126), false).cause, Cause::Permissions);
    // A handled not-found line beside the real failure: the real one.
    let eacces = tail(&["shasum: command not found", "EACCES: permission denied, mkdir '/Users/ada/.local/share/claude'"]);
    assert_eq!(classify(&eacces, Some(1), false).cause, Cause::Permissions);
    // A failed run whose only account is the line.
    assert_eq!(classify(&tail(&["sh: curl: not found"]), Some(1), false).path.as_deref(), Some("curl"));
    // A file that isn't there is not a command that isn't.
    let rm = tail(&["rm: /tmp/x: No such file or directory"]);
    assert_eq!(classify(&rm, Some(1), false).cause, Cause::Unknown);
    assert_eq!(command_not_found_in("all fine"), None);
    // Its wire name.
    assert_eq!(serde_json::to_string(&Cause::CommandNotFound).unwrap(), "\"command-not-found\"");
}

/// 1.176.2 R1: a character whose lowercase has another byte length (İ: 2 → 3
/// bytes; the Kelvin sign: 3 → 1; Ⱥ: 2 → 3) before the marker never shifts
/// the name read, nor panics on a non-char boundary.
#[test]
fn a_line_whose_lowercase_changes_length_reads_the_right_name() {
    assert_eq!(
        command_not_found_in("bash: /Users/İlker/x.sh: line 1: curl: command not found"),
        Some(Some("curl".into()))
    );
    assert_eq!(
        command_not_found_in("bash: /Users/\u{212A}im/x.sh: line 1: curl: command not found"),
        Some(Some("curl".into()))
    );
    assert_eq!(command_not_found_in("Ⱥ: command not found: x"), Some(Some("x".into())));
    assert_eq!(command_not_found_in("zsh İİİİ: command not found: node"), Some(Some("node".into())));
    assert_eq!(
        command_not_found_in("/bin/sh: \u{212A}\u{212A}: not found"),
        Some(Some("\u{212A}\u{212A}".into()))
    );
}
