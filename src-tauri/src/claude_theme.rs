//! GH #69: interactive `claude` sessions draw for Ply's canvas, not for
//! Claude Code's own global theme.
//!
//! Claude Code does not detect the terminal background; it draws with the
//! colours of its configured theme (`"theme"` in `~/.claude/settings.json`),
//! a setting shared with every other terminal. A dark theme on Ply's light
//! canvas leaves diff context lines and dim text near-white on white.
//!
//! Every interactive `claude` Ply spawns in a PTY (Claude tiles, Builder
//! start/resume, intake, agent REPL runs) gets `--settings '{"theme":…}'`
//! chosen from Ply's effective theme at spawn. The flag overrides that one
//! session only; Ply never writes to `~/.claude/settings.json`. Headless
//! runs (`-p` / `--print`) and collected sessions (`--session-id`: Verify
//! slash checks, oneshot Agent runs, reviews), whose screen nobody sees,
//! are left untouched.
//!
//! 1.168.1 (#6): a CLI that has Claude Code's `auto` theme (2.1.306 and
//! later, measured) gets `{"theme":"auto"}` instead, unless the user's own
//! theme is a daltonized or ANSI variant (`auto` only picks plain light or
//! dark). `auto` asks the terminal for its background (OSC 11, which xterm
//! answers with Ply's canvas) at start, and asks again on each colour-scheme
//! report (`CSI ?997;1n` / `;2n`, lib/themeReports.ts), so an open session
//! follows Ply's light/dark switch. A fixed `light`/`dark` ignores those
//! reports: that was the walk's Claude tile keeping its light bands in Dark.
//! Older CLIs, and the variants, keep the fixed name chosen at spawn.
//!
//! `auto` depends on the attach order: xterm answers OSC 11 only once its
//! view is open, and a Builder / Build-both lane started before its view
//! mounts (or resumed), an intake attached after `intake_start`, or a ConPTY
//! that swallows the query, leaves Claude's first question unanswered. Its
//! fallback is `COLORFGBG`, else dark — so a session given `auto` also gets
//! `COLORFGBG` from Ply's lightness at spawn (`0;15` light, `15;0` dark;
//! measured on 2.1.308: unanswered, `0;15` draws light and `15;0` dark; an
//! OSC 11 answer still wins). Both visible spawns add it
//! (`pty::PtyRegistry::spawn_tile`, `spawn_with_capture` → [`spawn_env`]),
//! which covers tiles, agent REPL runs, the Builder, Build with both and
//! intake, on Windows too. Lightness unknown (no window to ask): no override
//! and no `COLORFGBG`, as before 1.168.1.
//!
//! The CLI version is the one `shell_env` probed at startup: a `claude
//! update` while Plyloft runs takes effect after a relaunch.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::settings::{SettingsStore, ThemePref};

/// Which background a session draws on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lightness {
    Light,
    Dark,
}

/// Ply's effective theme family. `system` follows the OS appearance at this
/// moment; `None` when that is unknown (no window to ask), in which case no
/// override is passed and Claude keeps its own theme.
pub fn ply_lightness(pref: &ThemePref, system_dark: Option<bool>) -> Option<Lightness> {
    match pref {
        ThemePref::Light => Some(Lightness::Light),
        ThemePref::Dark | ThemePref::Void | ThemePref::NeonTokyo | ThemePref::Synthwave => {
            Some(Lightness::Dark)
        }
        ThemePref::System => system_dark.map(|dark| if dark { Lightness::Dark } else { Lightness::Light }),
    }
}

/// Claude Code's theme name for `lightness`, keeping the variant the user
/// chose globally (`dark-daltonized` in a light Ply → `light-daltonized`).
pub fn claude_theme_name(lightness: Lightness, global: Option<&str>) -> &'static str {
    let variant = match global.map(str::trim) {
        Some(g) if g.ends_with("-daltonized") => "daltonized",
        Some(g) if g.ends_with("-ansi") => "ansi",
        _ => "",
    };
    match (lightness, variant) {
        (Lightness::Light, "daltonized") => "light-daltonized",
        (Lightness::Dark, "daltonized") => "dark-daltonized",
        (Lightness::Light, "ansi") => "light-ansi",
        (Lightness::Dark, "ansi") => "dark-ansi",
        (Lightness::Light, _) => "light",
        (Lightness::Dark, _) => "dark",
    }
}

/// The oldest Claude Code measured with the `auto` theme and its answer to
/// colour-scheme reports (2.1.306; 2.1.307 and 2.1.308 too).
pub const MIN_CLAUDE_VERSION_AUTO_THEME: (u32, u32, u32) = (2, 1, 306);

/// Whether the CLI at `version` (`claude --version`'s number) has `auto`.
/// Unknown versions don't: the fixed name is the safe one.
pub fn supports_auto_theme(version: Option<&str>) -> bool {
    version
        .and_then(crate::shell_env::parse_semver)
        .is_some_and(|v| v >= MIN_CLAUDE_VERSION_AUTO_THEME)
}

/// The theme a session spawned now draws with: `auto` when the CLI has it
/// and the user's theme is a plain one (or unset), else the fixed name for
/// Ply's lightness (`None` when that is unknown).
pub fn spawn_theme(
    lightness: Option<Lightness>,
    global: Option<&str>,
    claude_version: Option<&str>,
) -> Option<String> {
    // Lightness unknown: no override at all, as before (auto would fall
    // back to dark with nothing to tell it otherwise).
    let lightness = lightness?;
    let variant = global
        .map(str::trim)
        .is_some_and(|g| g.ends_with("-daltonized") || g.ends_with("-ansi"));
    if !variant && supports_auto_theme(claude_version) {
        return Some("auto".to_string());
    }
    Some(claude_theme_name(lightness, global).to_string())
}

/// `COLORFGBG` for a lightness: what Claude's `auto` falls back to when its
/// OSC 11 question goes unanswered (foreground;background, 15 white, 0 black).
pub fn colorfgbg(lightness: Lightness) -> &'static str {
    match lightness {
        Lightness::Light => "0;15",
        Lightness::Dark => "15;0",
    }
}

/// Whether an argv carries the `--settings {"theme":"auto"}` [`apply`] puts
/// in front.
pub fn carries_auto_theme(args: &[String]) -> bool {
    args.windows(2).any(|w| {
        w[0] == "--settings"
            && serde_json::from_str::<serde_json::Value>(&w[1])
                .ok()
                .and_then(|v| v.get("theme").and_then(|t| t.as_str()).map(|t| t == "auto"))
                .unwrap_or(false)
    })
}

/// The environment an `auto` session needs beside its argv: `COLORFGBG`
/// from Ply's lightness. Nothing for any other argv, or when the lightness
/// is unknown.
pub fn auto_theme_env(args: &[String], lightness: Option<Lightness>) -> Vec<(String, String)> {
    match lightness {
        Some(l) if carries_auto_theme(args) => vec![("COLORFGBG".to_string(), colorfgbg(l).to_string())],
        _ => Vec::new(),
    }
}

/// The theme name an argv's `--settings {"theme":…}` (from [`apply`]) names.
fn theme_in_args(args: &[String]) -> Option<String> {
    args.windows(2).find_map(|w| {
        if w[0] != "--settings" {
            return None;
        }
        let v: serde_json::Value = serde_json::from_str(&w[1]).ok()?;
        v.get("theme")?.as_str().map(str::to_string)
    })
}

/// The light/dark a Claude session spawned with this argv starts in: Ply's
/// lightness now for `auto` (`lightness_now`), the fixed name's otherwise;
/// `None` for an argv Plyloft gave no theme (no override: nothing known).
pub fn session_lightness(args: &[String], lightness_now: impl FnOnce() -> Option<Lightness>) -> Option<Lightness> {
    let theme = theme_in_args(args)?;
    if theme == "auto" {
        return lightness_now();
    }
    if theme.starts_with("light") {
        Some(Lightness::Light)
    } else if theme.starts_with("dark") {
        Some(Lightness::Dark)
    } else {
        None
    }
}

/// What a visible PTY spawn adds for a Claude session: `env` with
/// [`auto_theme_env`], and the light/dark it starts in (recorded with
/// [`register`] once the session has its id). Both read Ply's lightness
/// once, so they agree.
pub fn spawn_env<R: Runtime>(
    app: &AppHandle<R>,
    args: &[String],
    mut env: Vec<(String, String)>,
) -> (Vec<(String, String)>, Option<Lightness>) {
    let lightness = session_lightness(args, || ply_lightness_now(app));
    if carries_auto_theme(args) {
        env.extend(auto_theme_env(args, lightness));
    }
    (env, lightness)
}

fn sessions() -> &'static parking_lot::Mutex<std::collections::HashMap<String, Lightness>> {
    static SESSIONS: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashMap<String, Lightness>>> =
        std::sync::OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}

/// 1.168.1 (#6, Windows): remember the light/dark a session started in,
/// until it ends ([`forget`]) — what the tile's "Restart it to use the new
/// theme" line compares with (`pty_session_lightness`).
pub fn register(pty_id: &str, lightness: Option<Lightness>) {
    if let Some(l) = lightness {
        sessions().lock().insert(pty_id.to_string(), l);
    }
}

pub fn forget(pty_id: &str) {
    sessions().lock().remove(pty_id);
}

/// "light" / "dark" for a live session Plyloft themed, else `None`.
pub fn lightness_of(pty_id: &str) -> Option<&'static str> {
    sessions().lock().get(pty_id).map(|l| match l {
        Lightness::Light => "light",
        Lightness::Dark => "dark",
    })
}

/// Ply's lightness at this moment (`None` when the OS appearance can't be
/// read for a System preference).
fn ply_lightness_now<R: Runtime>(app: &AppHandle<R>) -> Option<Lightness> {
    let pref = app.try_state::<SettingsStore>()?.snapshot().appearance.theme;
    let system_dark = if matches!(pref, ThemePref::System) { system_is_dark(app) } else { None };
    ply_lightness(&pref, system_dark)
}

/// `-p` / `--print` runs, and interactive sessions Plyloft collects through
/// their transcript (`claude_session::collected_session_id`), are headless:
/// nothing is drawn on a Ply canvas.
pub fn is_headless(args: &[String]) -> bool {
    args.iter().any(|a| a == "-p" || a == "--print")
        || crate::claude_session::collected_session_id(args).is_some()
}

/// Prepend `--settings {"theme":…}` to an interactive `claude` argv, ahead
/// of any positional prompt. Headless argv, an argv that already carries
/// its own `--settings`, or an unknown theme come back unchanged.
pub fn apply(args: Vec<String>, theme: Option<&str>) -> Vec<String> {
    let Some(theme) = theme else { return args };
    if is_headless(&args) || args.iter().any(|a| a == "--settings" || a.starts_with("--settings=")) {
        return args;
    }
    let mut out = Vec::with_capacity(args.len() + 2);
    out.push("--settings".to_string());
    out.push(serde_json::json!({ "theme": theme }).to_string());
    out.extend(args);
    out
}

/// Claude Code's config directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
fn claude_config_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    crate::platform::home_dir().map(|h| h.join(".claude"))
}

fn theme_in(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("theme")?.as_str().map(str::to_string)
}

/// The user's global Claude theme, read only. `settings.json` first, then
/// the legacy global config (`~/.claude.json`) older CLIs kept it in.
pub fn global_claude_theme_at(config_dir: &Path, legacy_config: Option<&Path>) -> Option<String> {
    theme_in(&config_dir.join("settings.json")).or_else(|| legacy_config.and_then(theme_in))
}

fn global_claude_theme() -> Option<String> {
    let dir = claude_config_dir()?;
    let legacy = crate::platform::home_dir().map(|h| h.join(".claude.json"));
    global_claude_theme_at(&dir, legacy.as_deref())
}

/// The OS appearance as the app's own windows see it — the same effective
/// appearance the webview's `prefers-color-scheme` follows.
fn system_is_dark<R: Runtime>(app: &AppHandle<R>) -> Option<bool> {
    let window = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())?;
    match window.theme().ok()? {
        tauri::Theme::Dark => Some(true),
        tauri::Theme::Light => Some(false),
        _ => None,
    }
}

/// The Claude theme a session spawned now should draw with.
pub fn theme_for_spawn<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let lightness = ply_lightness_now(app);
    let env = crate::shell_env::get();
    spawn_theme(lightness, global_claude_theme().as_deref(), env.claude_version.as_deref())
}

/// `apply` with the theme resolved for a spawn happening now.
pub fn session_args<R: Runtime>(app: &AppHandle<R>, args: Vec<String>) -> Vec<String> {
    if is_headless(&args) {
        return args;
    }
    apply(args, theme_for_spawn(app).as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn light_and_dark_prefs_resolve_without_the_os() {
        assert_eq!(ply_lightness(&ThemePref::Light, Some(true)), Some(Lightness::Light));
        assert_eq!(ply_lightness(&ThemePref::Dark, Some(false)), Some(Lightness::Dark));
        assert_eq!(ply_lightness(&ThemePref::Void, None), Some(Lightness::Dark));
    }

    #[test]
    fn system_resolves_to_the_os_appearance_at_spawn() {
        assert_eq!(ply_lightness(&ThemePref::System, Some(false)), Some(Lightness::Light));
        assert_eq!(ply_lightness(&ThemePref::System, Some(true)), Some(Lightness::Dark));
        assert_eq!(ply_lightness(&ThemePref::System, None), None);
    }

    /// 1.168.1 (#6), the walk's failure: Claude Code 2.1.308 started with
    /// `--settings {"theme":"light"}` never re-asks the background on a
    /// colour-scheme report, so its bands stayed light in Dark; with
    /// `{"theme":"auto"}` it asks OSC 11 again (measured in a PTY, fake HOME).
    #[test]
    fn a_cli_with_auto_follows_ply_live_older_ones_keep_the_fixed_name() {
        let light = Some(Lightness::Light);
        assert_eq!(spawn_theme(light, None, Some("2.1.308")).as_deref(), Some("auto"));
        assert_eq!(spawn_theme(Some(Lightness::Dark), Some("dark"), Some("2.1.306")).as_deref(), Some("auto"));
        assert_eq!(spawn_theme(light, Some("auto"), Some("3.0.0")).as_deref(), Some("auto"));
        // Unknown lightness (no window yet): no override, as before — auto
        // would fall back to dark.
        assert_eq!(spawn_theme(None, None, Some("2.1.308")), None);
        // Older or unknown CLIs: the fixed name, as before.
        assert_eq!(spawn_theme(light, None, Some("2.1.305")).as_deref(), Some("light"));
        assert_eq!(spawn_theme(light, None, Some("1.9.9")).as_deref(), Some("light"));
        assert_eq!(spawn_theme(Some(Lightness::Dark), None, None).as_deref(), Some("dark"));
        assert_eq!(spawn_theme(None, None, None), None);
        // A daltonized or ANSI variant keeps its fixed name (auto has none).
        assert_eq!(
            spawn_theme(Some(Lightness::Dark), Some("light-daltonized"), Some("2.1.308")).as_deref(),
            Some("dark-daltonized")
        );
        assert_eq!(spawn_theme(light, Some("dark-ansi"), Some("2.1.308")).as_deref(), Some("light-ansi"));
        // What reaches the argv.
        assert_eq!(
            apply(s(&["--continue"]), spawn_theme(light, None, Some("2.1.308")).as_deref()),
            s(&["--settings", r#"{"theme":"auto"}"#, "--continue"])
        );
    }

    /// Challenger on the walk fix: `auto` with its OSC 11 unanswered (a
    /// Builder replay, an intake attached late, ConPTY) falls back to
    /// `COLORFGBG`, else dark. An auto spawn carries it; nothing else does.
    #[test]
    fn an_auto_spawn_carries_colorfgbg_from_plys_lightness() {
        let auto = apply(s(&["--continue"]), Some("auto"));
        assert!(carries_auto_theme(&auto));
        assert_eq!(auto_theme_env(&auto, Some(Lightness::Light)), vec![("COLORFGBG".to_string(), "0;15".to_string())]);
        assert_eq!(auto_theme_env(&auto, Some(Lightness::Dark)), vec![("COLORFGBG".to_string(), "15;0".to_string())]);
        assert!(auto_theme_env(&auto, None).is_empty(), "lightness unknown: nothing");
        // A fixed theme, a Codex argv, a shell: nothing.
        let fixed = apply(s(&["--continue"]), Some("light"));
        assert!(!carries_auto_theme(&fixed));
        assert!(auto_theme_env(&fixed, Some(Lightness::Light)).is_empty());
        assert!(auto_theme_env(&s(&["exec", "--json"]), Some(Lightness::Dark)).is_empty());
        assert!(auto_theme_env(&[], Some(Lightness::Dark)).is_empty());
        // A user's own --settings file is not ours.
        assert!(!carries_auto_theme(&s(&["--settings", "/tmp/s.json"])));
    }

    /// The Windows restart line compares with the light/dark a session
    /// started in, known only when Plyloft themed it.
    #[test]
    fn a_session_starts_in_the_lightness_its_theme_names() {
        let auto = apply(s(&["--continue"]), Some("auto"));
        assert_eq!(session_lightness(&auto, || Some(Lightness::Dark)), Some(Lightness::Dark));
        assert_eq!(session_lightness(&auto, || None), None);
        let fixed = apply(Vec::new(), Some("light-daltonized"));
        assert_eq!(session_lightness(&fixed, || Some(Lightness::Dark)), Some(Lightness::Light));
        assert_eq!(session_lightness(&apply(Vec::new(), Some("dark-ansi")), || None), Some(Lightness::Dark));
        assert_eq!(session_lightness(&s(&["--continue"]), || Some(Lightness::Dark)), None, "not themed");
        register("pty-x", Some(Lightness::Light));
        register("pty-y", None);
        assert_eq!(lightness_of("pty-x"), Some("light"));
        assert_eq!(lightness_of("pty-y"), None);
        forget("pty-x");
        assert_eq!(lightness_of("pty-x"), None);
    }

    /// Both visible spawns run their argv through [`spawn_env`].
    #[test]
    fn both_visible_spawns_add_the_auto_theme_env() {
        let pty = include_str!("pty.rs");
        assert_eq!(
            pty.matches("crate::claude_theme::spawn_env(&app, &injection.args, ports)").count(),
            2,
            "spawn_tile and spawn_with_capture"
        );
        // …and remember the light/dark the session starts in, until it ends.
        assert_eq!(pty.matches("crate::claude_theme::register(&id, theme_lightness)").count(), 2);
        assert_eq!(pty.matches("crate::claude_theme::forget(&id)").count(), 2);
        assert!(pty.contains("crate::claude_theme::forget(id)"), "a kill forgets it too");
    }

    #[test]
    fn plain_or_missing_global_theme_maps_to_plain_names() {
        assert_eq!(claude_theme_name(Lightness::Light, None), "light");
        assert_eq!(claude_theme_name(Lightness::Dark, None), "dark");
        assert_eq!(claude_theme_name(Lightness::Light, Some("dark")), "light");
        assert_eq!(claude_theme_name(Lightness::Dark, Some("light")), "dark");
        assert_eq!(claude_theme_name(Lightness::Light, Some("something-new")), "light");
    }

    #[test]
    fn global_variant_is_kept_in_the_target_lightness() {
        for (global, light, dark) in [
            ("dark-daltonized", "light-daltonized", "dark-daltonized"),
            ("light-daltonized", "light-daltonized", "dark-daltonized"),
            ("dark-ansi", "light-ansi", "dark-ansi"),
            ("light-ansi", "light-ansi", "dark-ansi"),
        ] {
            assert_eq!(claude_theme_name(Lightness::Light, Some(global)), light, "{global}");
            assert_eq!(claude_theme_name(Lightness::Dark, Some(global)), dark, "{global}");
        }
    }

    #[test]
    fn interactive_argv_gets_settings_first() {
        let out = apply(s(&["--continue"]), Some("light"));
        assert_eq!(out, s(&["--settings", r#"{"theme":"light"}"#, "--continue"]));
        assert_eq!(apply(Vec::new(), Some("dark-ansi")), s(&["--settings", r#"{"theme":"dark-ansi"}"#]));
    }

    #[test]
    fn headless_argv_is_unchanged() {
        let p = s(&["-p", "hi", "--output-format", "stream-json", "--verbose"]);
        assert_eq!(apply(p.clone(), Some("light")), p);
        let print = s(&["--print", "hi"]);
        assert_eq!(apply(print.clone(), Some("dark")), print);
        let collected = crate::claude_session::unattended_writer_args("/ppvp", crate::claude_session::WriterMode::Refuse, &[]);
        assert_eq!(apply(collected.clone(), Some("dark")), collected);
    }

    #[test]
    fn unknown_theme_or_own_settings_flag_is_unchanged() {
        let a = s(&["--continue"]);
        assert_eq!(apply(a.clone(), None), a);
        let own = s(&["--settings", "/tmp/x.json"]);
        assert_eq!(apply(own.clone(), Some("light")), own);
        let own_eq = s(&["--settings=/tmp/x.json"]);
        assert_eq!(apply(own_eq.clone(), Some("light")), own_eq);
    }

    #[test]
    fn global_theme_is_read_from_settings_then_legacy_config() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".claude");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = tmp.path().join(".claude.json");
        assert_eq!(global_claude_theme_at(&dir, Some(&legacy)), None);
        std::fs::write(&legacy, r#"{"theme":"light-ansi"}"#).unwrap();
        assert_eq!(global_claude_theme_at(&dir, Some(&legacy)).as_deref(), Some("light-ansi"));
        let settings = dir.join("settings.json");
        std::fs::write(&settings, r#"{"theme":"dark-daltonized","model":"x"}"#).unwrap();
        let before = std::fs::read(&settings).unwrap();
        assert_eq!(global_claude_theme_at(&dir, Some(&legacy)).as_deref(), Some("dark-daltonized"));
        assert_eq!(std::fs::read(&settings).unwrap(), before, "never written");
    }
}
