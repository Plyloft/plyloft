//! 1.176.1: Codex's own "Update available" question, kept out of every
//! Codex Plyloft starts in a terminal.
//!
//! With a newer release out, the Codex TUI opens on its own screen
//! "Update available · 0.166.0 → 0.171.0" with "1. Update now (runs `npm
//! install -g @openai/codex`)" preselected, so one Enter in the tile starts
//! an update from inside it — seen in two Windows walks (codex-cli 0.166.0,
//! npm), where the running `codex.exe` locks its own file. Since 1.176.0
//! Plyloft owns Codex updates: the automatic update runs only while Codex is
//! idle, by its install channel (`codex_auto_update.rs`), and the person
//! learns of a newer Codex from Diagnostics' Update row ("Version X is
//! available.", `doctor::update_line`) and from that update's own notices.
//!
//! `-c check_for_update_on_startup=false` is Codex's own config key (the
//! value is typed: `=fals` fails Codex's config load, `=false` loads with no
//! warning; codex-cli 0.171.0). It is a root option, so it reaches the TUI,
//! `resume`, `fork` and `exec` alike when it comes before the subcommand.
//!
//! One place adds it: [`for_program`], called by `pty::pty_command`, the last
//! step before every PTY child — so a tile, `resume`, a Builder, intake, a
//! reviewer or probe `codex exec`, an agent or swarm run and a card chat all
//! carry it, whoever built the argv. It is not passed per launch in a Codex
//! home overlay (`codex_home.rs`): only a session with skills to deliver has
//! one, and a plain tile would be left out.
//!
//! Not given it, by decision: `codex app-server` (`codex_app.rs`: codex-chat
//! and card chats) and `codex debug models` (`model_catalog.rs`). Neither has
//! a screen to show the question on — the App Server speaks JSON-RPC, the
//! catalog read prints JSON — and Codex checks for updates only in its TUI.
//! The person's own `codex` typed in a shell tile is the shell's child, not
//! Plyloft's, and keeps Codex's question.

/// Codex's config override that keeps its update question off the screen.
pub(crate) const NO_UPDATE_PROMPT: [&str; 2] = ["-c", "check_for_update_on_startup=false"];

/// Whether `cmd` names the Codex CLI: `codex`, or a path whose file is
/// `codex`, `codex.exe`, `codex.cmd` or `codex.ps1` (any case).
pub(crate) fn is_codex(cmd: &str) -> bool {
    let name = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd).to_ascii_lowercase();
    matches!(name.as_str(), "codex" | "codex.exe" | "codex.cmd" | "codex.ps1")
}

/// Whether `args` already carry the override (intake builds it itself).
fn carries(args: &[String]) -> bool {
    args.windows(2).any(|pair| pair[0] == NO_UPDATE_PROMPT[0] && pair[1] == NO_UPDATE_PROMPT[1])
}

/// `args` for a start of `cmd`: a Codex start gets [`NO_UPDATE_PROMPT`]
/// first (a root option, before any subcommand), once; anything else is
/// returned as it is.
pub(crate) fn for_program(cmd: &str, args: &[String]) -> Vec<String> {
    if !is_codex(cmd) || carries(args) {
        return args.to_vec();
    }
    let mut out: Vec<String> = NO_UPDATE_PROMPT.iter().map(|s| s.to_string()).collect();
    out.extend(args.iter().cloned());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn every_codex_program_name_is_known_and_nothing_else_is() {
        for cmd in [
            "codex",
            "/Users/me/.local/bin/codex",
            "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
            "C:\\Program Files\\Codex\\CODEX.EXE",
            "codex.ps1",
        ] {
            assert!(is_codex(cmd), "{cmd}");
        }
        for cmd in ["claude", "/bin/zsh", "codex-helper", "my-codex", "/opt/codex/bin/node", ""] {
            assert!(!is_codex(cmd), "{cmd}");
        }
    }

    #[test]
    fn a_codex_start_gets_the_override_first_and_once() {
        let tile = for_program("codex", &s(&["--no-daemon", "resume", "019-id"]));
        assert_eq!(tile, s(&["-c", "check_for_update_on_startup=false", "--no-daemon", "resume", "019-id"]));
        let plain = for_program("/usr/local/bin/codex", &[]);
        assert_eq!(plain, s(&["-c", "check_for_update_on_startup=false"]));
        // Intake carries it already: not twice.
        let intake = s(&["-C", "/w", "-c", "check_for_update_on_startup=false", "go"]);
        assert_eq!(for_program("codex", &intake), intake);
        // `exec`: before the subcommand, where Codex reads root options.
        let exec = for_program("codex.exe", &s(&["exec", "--json", "x"]));
        assert_eq!(&exec[..3], ["-c", "check_for_update_on_startup=false", "exec"]);
    }

    #[test]
    fn other_programs_are_left_as_they_are() {
        let args = s(&["-l"]);
        assert_eq!(for_program("/bin/zsh", &args), args);
        let claude = s(&["--session-id", "x"]);
        assert_eq!(for_program("claude", &claude), claude);
    }
}
