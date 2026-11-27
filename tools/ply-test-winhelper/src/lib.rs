//! ply-test-winhelper — the app tester's Windows side (docs/app-tester/
//! DESIGN.md, "Windows"). The macOS PlyTestHelper's counterpart, and also the
//! Mac's only way into the VM:
//!
//! - `serve` runs in the VM's interactive session, started from the Mac by
//!   `prlctl exec "<vm>" --current-user … serve`; it speaks line JSON on its
//!   own stdin/stdout, so nothing listens on a network interface;
//! - it relays `bridge` calls to Plyloft Test's bridge on `127.0.0.1`, adding
//!   the per-launch token it reads from the test profile (the token never
//!   leaves the VM);
//! - trusted input (SendInput) and window screenshots (PrintWindow) only on a
//!   Plyloft Test window, stoppable with an emergency chord;
//! - fixed read-only queries (processes, the app log, test-profile files,
//!   Plyloft's uninstall/Run registry entries) — no shell, no free paths;
//! - `profile seed|reset|status` for the Mac's scripts, only ever on the
//!   `com.mbadv.ply.test` profile.
//!
//! Dev tooling; never bundled, never in a release.

pub mod chord;
pub mod paths;
pub mod profile;
pub mod reads;
pub mod relay;
pub mod serve;
#[cfg(windows)]
pub mod win;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const TEST_IDENTIFIER: &str = "com.mbadv.ply.test";
/// The emergency chord, as the owner presses it on the Mac keyboard into the
/// VM window (ctrl+option+shift+.).
pub const EMERGENCY_CHORD: &str = "ctrl+alt+shift+.";

/// A Plyloft Test executable: a debug build (`…\debug\atelier.exe`). The
/// installed Plyloft is a release build elsewhere, so this never matches it.
pub fn is_test_app_path(path: &str) -> bool {
    let lower = path.replace('/', "\\").to_ascii_lowercase();
    lower.ends_with("\\debug\\atelier.exe")
        && !lower.contains("\\appdata\\local\\plyloft\\")
        && !lower.contains("\\program files")
}

/// Windows keeps a process's parent pid for life, and reuses pids: a listed
/// parent that started after its child is a stranger with the old number (the
/// installed Plyloft read as a child of Plyloft Test's WebView2, walk of
/// 2026-11-03). Creation times, in any one unit; unknown keeps the link, so a
/// real child is never lost to a failed read.
pub fn parent_is_real(child_created: Option<u64>, parent_created: Option<u64>) -> bool {
    !matches!((child_created, parent_created), (Some(child), Some(parent)) if child < parent)
}

/// Launch A2: the only variables `app.launch` passes on to Plyloft Test
/// (`params.env`), the Plyloft account's — the Sign-in screen's debug-only
/// skip and the staging sign-in. Anything else is dropped.
pub const LAUNCH_ENV_ALLOWED: [&str; 4] = [
    "PLYLOFT_DEV_SKIP_SIGNIN",
    "PLYLOFT_API_URL",
    "PLYLOFT_GITHUB_CLIENT_ID",
    "PLYLOFT_ENTITLEMENT_PUBKEY",
];

/// The allowed `(name, value)` pairs of an `app.launch` `env` object.
pub fn launch_env(env: &serde_json::Value) -> Vec<(String, String)> {
    let Some(map) = env.as_object() else { return Vec::new() };
    LAUNCH_ENV_ALLOWED
        .iter()
        .filter_map(|name| map.get(*name).and_then(|v| v.as_str()).map(|v| (name.to_string(), v.to_string())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_passes_only_the_account_variables() {
        let env = serde_json::json!({
            "PLYLOFT_DEV_SKIP_SIGNIN": "1",
            "PLYLOFT_API_URL": "https://staging.example/v1",
            "PATH": "C:\\evil",
            "GH_CONFIG_DIR": "C:\\x",
            "PLYLOFT_GITHUB_CLIENT_ID": 7,
        });
        assert_eq!(
            launch_env(&env),
            vec![
                ("PLYLOFT_DEV_SKIP_SIGNIN".to_string(), "1".to_string()),
                ("PLYLOFT_API_URL".to_string(), "https://staging.example/v1".to_string()),
            ]
        );
        assert!(launch_env(&serde_json::Value::Null).is_empty());
        // The public half of the dev key reaches the test app; nothing else of it could.
        let key = serde_json::json!({"PLYLOFT_ENTITLEMENT_PUBKEY": "ab12", "PLYLOFT_ENTITLEMENT_KEY": "secret"});
        assert_eq!(launch_env(&key), vec![("PLYLOFT_ENTITLEMENT_PUBKEY".to_string(), "ab12".to_string())]);
    }

    #[test]
    fn a_parent_younger_than_its_child_is_not_its_parent() {
        assert!(parent_is_real(Some(200), Some(100)));
        assert!(parent_is_real(Some(100), Some(100)), "the same tick isn't proof");
        assert!(!parent_is_real(Some(100), Some(200)));
        assert!(parent_is_real(None, Some(200)), "unknown keeps the link");
        assert!(parent_is_real(Some(100), None));
    }

    #[test]
    fn only_a_debug_build_is_a_test_app() {
        assert!(is_test_app_path(r"C:\build\ply-test\src-tauri\target\aarch64-pc-windows-msvc\debug\atelier.exe"));
        assert!(is_test_app_path(r"C:\build\x\target\DEBUG\Atelier.EXE"));
        assert!(!is_test_app_path(r"C:\Users\me\AppData\Local\Plyloft\atelier.exe"));
        assert!(!is_test_app_path(r"C:\build\x\target\release\atelier.exe"));
        assert!(!is_test_app_path(r"C:\Users\me\AppData\Local\Plyloft\debug\atelier.exe"));
        assert!(!is_test_app_path(r"C:\build\x\debug\atelier.exe.bak"));
    }
}
