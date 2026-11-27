//! GH #169 — whether Claude Code has a credential on this Mac.
//!
//! BOARDS.md §5 draws Diagnostics' `claude` row as `Found and signed in.
//! Nothing to do.`, and #103 shipped it with the doctor's own sentence because
//! Ply had no way to know. The owner's decision (2026-09-22) bounds how Ply may
//! find out: **credential presence only** — no network, no spawn, and never a
//! false "signed out" on the CLI the whole app depends on.
//!
//! So this module looks, and only looks, at the two places Claude Code keeps a
//! subscription login on macOS:
//!
//!  - the login keychain's generic-password item whose service is
//!    [`KEYCHAIN_SERVICE`] — and, when Ply's process knows a config directory
//!    (`$CLAUDE_SECURESTORAGE_CONFIG_DIR` / `$CLAUDE_CONFIG_DIR`), the
//!    suffixed service the CLI keeps that directory's login under
//!    ([`keychain_services`]) — asked for its **attributes** only. The secret is
//!    never requested (`kSecReturnData` is not set), so macOS has nothing to
//!    ask the person about, and an item that would need authentication is
//!    skipped rather than prompted for;
//!  - the plaintext fallback `.credentials.json` in Claude Code's config
//!    directory (`~/.claude`, and `$CLAUDE_CONFIG_DIR` when Ply's own process
//!    has one) — `stat`ed, never opened.
//!
//! Either one present means signed in. Neither present does **not** mean
//! signed out: an API key in the environment, an `apiKeyHelper`, a keychain Ply
//! could not read or a config directory Ply does not know about all sign
//! Claude Code in without leaving either trace. There is no local signal that
//! says "logged out" for certain, so this module never produces one —
//! `doctor::claude_auth_status` maps "not seen" to *Ply could not tell*.
//!
//! Nothing here runs a process: `tests::the_probe_runs_nothing` holds the file
//! to that.

use std::path::{Path, PathBuf};

use crate::doctor::CredentialSeen;

/// The keychain item Claude Code stores its subscription login under, read on
/// this Mac with `security find-generic-password -s` (no `-w`): class `genp`,
/// account the macOS user name.
pub const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

/// Claude Code's plaintext fallback when the keychain is not used.
pub const CREDENTIALS_FILE: &str = ".credentials.json";

/// `errSecItemNotFound`: the keychain answered, and there is no such item.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// Look in both places. Cheap and local, but still only called where a
/// report read asks about sign-in (`doctor::auth_probe`), like `gh`'s.
pub fn read() -> (CredentialSeen, CredentialSeen) {
    let home = crate::platform::home_dir();
    let config = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
    let secure = std::env::var_os("CLAUDE_SECURESTORAGE_CONFIG_DIR")
        .map(|v| v.to_string_lossy().into_owned());
    let config_text = config.as_ref().map(|p| p.to_string_lossy().into_owned());
    let services = keychain_services(secure.as_deref(), config_text.as_deref());
    (
        keychain(&services),
        credentials_file(&config_dirs(home.as_deref(), config.as_deref())),
    )
}

/// 1.179.0 (C1): one Claude account folder's login, for a folder Plyloft
/// gave the CLI as `CLAUDE_CONFIG_DIR` (`ai_accounts`). Only the item keyed to
/// that folder and the folder's own `.credentials.json`: never the plain item
/// or `~/.claude`, which are the Main account's, so Main's login never makes
/// another account read as signed in. `dir` must be spelled exactly as the
/// CLI was given it: the suffix is the hash of that text.
pub fn read_for_dir(dir: &Path) -> (CredentialSeen, CredentialSeen) {
    let service = suffixed_service(&nfc(&dir.to_string_lossy()));
    (keychain(&[service]), credentials_file(&[dir.to_path_buf()]))
}

/// The keychain services to look under (GH #169 review 1), after the CLI's
/// own naming (`RD()` in Claude Code 2.1.280):
///
/// - `$CLAUDE_SECURESTORAGE_CONFIG_DIR` set: empty means the plain service,
///   otherwise the service suffixed with the hash of that value;
/// - else `$CLAUDE_CONFIG_DIR` set and not empty: suffixed with the hash of it;
/// - else the plain service.
///
/// The plain service is always looked under too: Ply's own process rarely
/// carries the variables a terminal does, and a login found anywhere is a
/// login.
pub fn keychain_services(secure_dir: Option<&str>, config_dir: Option<&str>) -> Vec<String> {
    let dir = match secure_dir {
        Some(secure) => (!secure.is_empty()).then_some(secure),
        None => config_dir.filter(|c| !c.is_empty()),
    };
    let mut services = vec![KEYCHAIN_SERVICE.to_string()];
    if let Some(dir) = dir {
        services.push(suffixed_service(&nfc(dir)));
    }
    services
}

/// `Claude Code-credentials-<first 8 hex of sha256(dir)>`, `dir` already in
/// Unicode NFC as the CLI normalises it.
pub fn suffixed_service(dir_nfc: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(dir_nfc.as_bytes());
    let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("{KEYCHAIN_SERVICE}-{hex}")
}

/// Unicode NFC, through CoreFoundation (already linked; no new crate).
#[cfg(target_os = "macos")]
pub fn nfc(text: &str) -> String {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use core_foundation_sys::string::{
        kCFStringNormalizationFormC, CFStringCreateMutableCopy, CFStringNormalize,
    };
    let source = CFString::new(text);
    // SAFETY: a mutable copy we own (create rule), normalised in place and
    // released by the wrapper.
    unsafe {
        let copy = CFStringCreateMutableCopy(std::ptr::null(), 0, source.as_concrete_TypeRef());
        if copy.is_null() {
            return text.to_string();
        }
        CFStringNormalize(copy, kCFStringNormalizationFormC);
        CFString::wrap_under_create_rule(copy as _).to_string()
    }
}

#[cfg(not(target_os = "macos"))]
pub fn nfc(text: &str) -> String {
    text.to_string()
}

/// Where Claude Code may keep `.credentials.json`: `~/.claude`, and the
/// directory `$CLAUDE_CONFIG_DIR` names when it is set and not blank.
pub fn config_dirs(home: Option<&Path>, config_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::with_capacity(2);
    if let Some(dir) = config_dir {
        if !dir.as_os_str().is_empty() && !dir.to_string_lossy().trim().is_empty() {
            dirs.push(dir.to_path_buf());
        }
    }
    if let Some(home) = home {
        let default = home.join(".claude");
        if !dirs.contains(&default) {
            dirs.push(default);
        }
    }
    dirs
}

/// Whether any of `dirs` holds a credentials file. Present anywhere wins; a
/// place Ply could not look in is `Unreadable`, never `Absent`.
pub fn credentials_file(dirs: &[PathBuf]) -> CredentialSeen {
    let mut seen = CredentialSeen::Absent;
    for dir in dirs {
        match file_at(&dir.join(CREDENTIALS_FILE)) {
            CredentialSeen::Present => return CredentialSeen::Present,
            CredentialSeen::Unreadable => seen = CredentialSeen::Unreadable,
            CredentialSeen::Absent => {}
        }
    }
    seen
}

/// `stat`, not `open`: the file's contents are a secret and its presence is
/// the whole answer.
fn file_at(path: &Path) -> CredentialSeen {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => CredentialSeen::Present,
        Ok(_) => CredentialSeen::Unreadable,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => CredentialSeen::Absent,
        Err(_) => CredentialSeen::Unreadable,
    }
}

/// What a keychain search answered, in the three words the doctor uses. Pure,
/// so each answer is tested without a keychain.
pub fn keychain_answer(result: Result<usize, i32>) -> CredentialSeen {
    match result {
        Ok(found) if found > 0 => CredentialSeen::Present,
        Err(ERR_SEC_ITEM_NOT_FOUND) => CredentialSeen::Absent,
        // An empty success, a locked keychain, a denied read: the keychain did
        // not say there is nothing, so Ply cannot either.
        _ => CredentialSeen::Unreadable,
    }
}

/// Present under any service wins; one Ply could not read is `Unreadable`,
/// never `Absent`.
fn keychain(services: &[String]) -> CredentialSeen {
    let mut seen = CredentialSeen::Absent;
    for service in services {
        match keychain_item(service) {
            CredentialSeen::Present => return CredentialSeen::Present,
            CredentialSeen::Unreadable => seen = CredentialSeen::Unreadable,
            CredentialSeen::Absent => {}
        }
    }
    seen
}

#[cfg(target_os = "macos")]
fn keychain_item(service: &str) -> CredentialSeen {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
    let result = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(service)
        // Attributes, never data: the secret is not asked for, so there is no
        // access prompt to raise.
        .load_attributes(true)
        .limit(Limit::Max(1))
        // And if macOS would still want to ask, it skips the item instead —
        // which reads as `Unreadable`/`Absent`, never as a prompt.
        .skip_authenticated_items(true)
        .search();
    keychain_answer(result.map(|items| items.len()).map_err(|error| error.code()))
}

/// Off macOS Claude Code keeps its login only in `.credentials.json`; there
/// is no keychain item to find, so the file alone answers.
#[cfg(not(target_os = "macos"))]
fn keychain_item(_service: &str) -> CredentialSeen {
    CredentialSeen::Absent
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_keychain_says_present_absent_or_nothing_ply_can_use() {
        assert_eq!(keychain_answer(Ok(1)), CredentialSeen::Present);
        assert_eq!(keychain_answer(Err(ERR_SEC_ITEM_NOT_FOUND)), CredentialSeen::Absent);
        // errSecInteractionNotAllowed (locked, would prompt) and an empty
        // success are not "there is none".
        assert_eq!(keychain_answer(Err(-25308)), CredentialSeen::Unreadable);
        assert_eq!(keychain_answer(Ok(0)), CredentialSeen::Unreadable);
    }

    #[test]
    fn a_credentials_file_is_found_by_its_presence_alone() {
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path().join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        let dirs = config_dirs(Some(dir.path()), None);
        assert_eq!(credentials_file(&dirs), CredentialSeen::Absent);
        // Contents are never read: an empty file counts.
        std::fs::write(claude.join(CREDENTIALS_FILE), b"").unwrap();
        assert_eq!(credentials_file(&dirs), CredentialSeen::Present);
    }

    #[test]
    fn claude_config_dir_is_looked_in_before_home() {
        let home = tempfile::tempdir().unwrap();
        let custom = tempfile::tempdir().unwrap();
        let dirs = config_dirs(Some(home.path()), Some(custom.path()));
        assert_eq!(dirs, vec![custom.path().to_path_buf(), home.path().join(".claude")]);
        std::fs::write(custom.path().join(CREDENTIALS_FILE), b"{}").unwrap();
        assert_eq!(credentials_file(&dirs), CredentialSeen::Present);
        // A blank CLAUDE_CONFIG_DIR is not a directory.
        assert_eq!(
            config_dirs(Some(home.path()), Some(Path::new("  "))),
            vec![home.path().join(".claude")]
        );
    }

    #[test]
    fn a_directory_where_the_file_should_be_is_not_absent() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".claude").join(CREDENTIALS_FILE)).unwrap();
        assert_eq!(
            credentials_file(&config_dirs(Some(home.path()), None)),
            CredentialSeen::Unreadable
        );
    }

    #[test]
    fn the_keychain_service_follows_the_clis_naming() {
        // Pinned: sha256("/Users/me/.claude-work") starts 1e91dd84.
        assert_eq!(
            suffixed_service("/Users/me/.claude-work"),
            "Claude Code-credentials-1e91dd84"
        );
        let plain = vec![KEYCHAIN_SERVICE.to_string()];
        assert_eq!(keychain_services(None, None), plain);
        assert_eq!(keychain_services(None, Some("")), plain);
        assert_eq!(
            keychain_services(None, Some("/Users/me/.claude-work")),
            vec![KEYCHAIN_SERVICE.to_string(), "Claude Code-credentials-1e91dd84".to_string()]
        );
        // CLAUDE_SECURESTORAGE_CONFIG_DIR wins; set but empty means plain.
        assert_eq!(keychain_services(Some(""), Some("/Users/me/.claude-work")), plain);
        assert_eq!(
            keychain_services(Some("/Users/me/.claude-work"), Some("/elsewhere")),
            vec![KEYCHAIN_SERVICE.to_string(), "Claude Code-credentials-1e91dd84".to_string()]
        );
    }

    /// Windows and Linux: the credentials file under the home Ply was given
    /// is the whole answer, and no keychain stands in the way of `Absent`.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn off_macos_the_file_alone_says_signed_in() {
        let home = tempfile::tempdir().unwrap();
        let dirs = config_dirs(Some(home.path()), None);
        assert_eq!(keychain(&keychain_services(None, None)), CredentialSeen::Absent);
        assert_eq!(credentials_file(&dirs), CredentialSeen::Absent);
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        std::fs::write(home.path().join(".claude").join(CREDENTIALS_FILE), b"{}").unwrap();
        assert_eq!(credentials_file(&dirs), CredentialSeen::Present);
        let auth = crate::doctor::claude_auth_status(
            keychain(&keychain_services(None, None)),
            credentials_file(&dirs),
        );
        assert_eq!(auth.signed_in, Some(true));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_decomposed_directory_hashes_as_its_nfc_form() {
        // "Cafe" + U+0301 is "Café" decomposed; the CLI hashes it composed.
        assert_eq!(nfc("/Users/me/Cafe\u{301}"), "/Users/me/Caf\u{e9}");
        assert_eq!(
            keychain_services(None, Some("/Users/me/Cafe\u{301}"))[1],
            "Claude Code-credentials-63a76eb4"
        );
    }

    /// The owner's decision: no spawn. A future edit that shells out to
    /// `security` or `claude` fails here rather than in review.
    #[test]
    fn the_probe_runs_nothing() {
        let source = include_str!("claude_auth.rs");
        let code: String = source
            .lines()
            .take_while(|line| !line.starts_with("#[cfg(test)]"))
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in ["Command", "process::", "spawn", "reqwest", "read_to_string", "fs::read("] {
            assert!(!code.contains(forbidden), "claude_auth.rs must not use `{forbidden}`");
        }
    }

    /// Run by hand on a signed-in Mac: `cargo test --lib this_mac -- --ignored
    /// --nocapture`. Prints the two answers, never a secret.
    #[test]
    #[ignore]
    fn this_mac() {
        let (keychain, file) = read();
        println!("keychain item {KEYCHAIN_SERVICE:?}: {keychain:?}; {CREDENTIALS_FILE}: {file:?}");
    }
}
