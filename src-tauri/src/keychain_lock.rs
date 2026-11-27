//! GH #189 — whether the login keychain is locked, asked without a prompt.
//!
//! `gh` keeps its token in the keychain (`gh auth status` names the source
//! `(keyring)`). While the login keychain is locked, `gh` cannot read that
//! token, and `gh auth status` answers `The token in default is invalid` — the
//! same words it uses for a token GitHub refused. Diagnostics read that as
//! "not signed in" and offered `Sign in` to a Mac that was signed in all along.
//!
//! So when `gh auth status` fails, the doctor also asks the keychain whether it
//! is locked, and a locked keychain is *Ply cannot tell*, never *signed out*
//! (`doctor::gh_auth_status`).
//!
//! **How, and why it cannot prompt.** Two Security.framework calls and nothing
//! else: `SecKeychainCopyDefault` (a reference to the user's default keychain —
//! the login keychain, where `gh`'s `security add-generic-password` puts its
//! token) and `SecKeychainGetStatus` on it, which returns the keychain's status
//! bits (`kSecUnlockStateStatus` among them). Neither reads, searches or
//! decrypts an item, and neither is one of the calls that raise the unlock
//! dialog: macOS asks for the keychain password only when something needs an
//! item's secret (or calls `SecKeychainUnlock` with no password), and nothing
//! here does either — `tests::the_lock_probe_reads_status_only` holds the file
//! to that. The `security` command line was not used: it is a process to
//! spawn, and the API is the status itself.

/// What the login keychain said about its lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeychainLock {
    Locked,
    Unlocked,
    /// No keychain, an error, or neither macOS nor Windows: Ply does not know.
    Unknown,
}

/// `kSecUnlockStateStatus` in `SecKeychainStatus` (SecKeychain.h).
const UNLOCK_STATE_STATUS: u32 = 1;

/// The status bits (or an `OSStatus` error) in the three words the doctor
/// uses. Pure, so each answer is tested without a keychain.
pub fn lock_from_status(status: Result<u32, i32>) -> KeychainLock {
    match status {
        Ok(bits) if bits & UNLOCK_STATE_STATUS != 0 => KeychainLock::Unlocked,
        Ok(_) => KeychainLock::Locked,
        Err(_) => KeychainLock::Unknown,
    }
}

/// The default (login) keychain's lock state. Status only: see the module
/// comment.
#[cfg(target_os = "macos")]
pub fn default_keychain() -> KeychainLock {
    use core_foundation::base::TCFType;
    use security_framework::os::macos::keychain::SecKeychain;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        // Not bound by security-framework-sys; the signature is SecKeychain.h's
        // `OSStatus SecKeychainGetStatus(SecKeychainRef, SecKeychainStatus *)`.
        fn SecKeychainGetStatus(keychain: *const std::ffi::c_void, status: *mut u32) -> i32;
    }

    let keychain = match SecKeychain::default() {
        Ok(keychain) => keychain,
        Err(error) => return lock_from_status(Err(error.code())),
    };
    let mut bits: u32 = 0;
    // SAFETY: a keychain reference we hold for the call, and a status word we
    // own; the call only writes that word.
    let code = unsafe { SecKeychainGetStatus(keychain.as_concrete_TypeRef() as *const _, &mut bits) };
    lock_from_status(if code == 0 { Ok(bits) } else { Err(code) })
}

/// Windows: `gh` keeps its token in Credential Manager, which has no lock of
/// its own — it is open whenever the user is signed in to Windows — so a
/// `default` failure there is a missing token, as on an unlocked Mac.
#[cfg(windows)]
pub fn default_keychain() -> KeychainLock {
    KeychainLock::Unlocked
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn default_keychain() -> KeychainLock {
    KeychainLock::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_status_bits_say_locked_unlocked_or_nothing() {
        // kSecUnlockStateStatus | kSecReadPermStatus | kSecWritePermStatus
        assert_eq!(lock_from_status(Ok(0b111)), KeychainLock::Unlocked);
        assert_eq!(lock_from_status(Ok(0b001)), KeychainLock::Unlocked);
        // Readable and writable, but not unlocked: locked.
        assert_eq!(lock_from_status(Ok(0b110)), KeychainLock::Locked);
        assert_eq!(lock_from_status(Ok(0)), KeychainLock::Locked);
        // errSecNoDefaultKeychain, errSecInvalidKeychain: not "unlocked", and
        // not "locked" either.
        assert_eq!(lock_from_status(Err(-25307)), KeychainLock::Unknown);
        assert_eq!(lock_from_status(Err(-25295)), KeychainLock::Unknown);
    }

    /// GH #189: the probe asks for the keychain's status and nothing else — no
    /// item search, no secret, no unlock, no process. A future edit that reaches
    /// for any of those fails here rather than in review (or in a dialog).
    #[test]
    fn the_lock_probe_reads_status_only() {
        let source = include_str!("keychain_lock.rs");
        let code: String = source
            .lines()
            .take_while(|line| !line.starts_with("#[cfg(test)]"))
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in [
            "load_data",
            "SecKeychainUnlock",
            "unlock(",
            "ItemSearchOptions",
            "SecItemCopyMatching",
            "find_generic_password",
            "find_internet_password",
            "SecKeychainFind",
            "SecKeychainItemCopyContent",
            "set_user_interaction_allowed",
            "SecKeychainSetUserInteractionAllowed",
            "kSecReturnData",
            "Command",
            "process::",
            "spawn",
        ] {
            assert!(!code.contains(forbidden), "keychain_lock.rs must not use `{forbidden}`");
        }
        assert!(code.contains("SecKeychainGetStatus"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_credential_manager_reads_as_unlocked() {
        assert_eq!(default_keychain(), KeychainLock::Unlocked);
    }

    /// Run by hand: `cargo test --lib keychain_lock::tests::this_mac --
    /// --ignored --nocapture`. Prints the lock state; never prompts.
    #[test]
    #[ignore]
    fn this_mac() {
        println!("login keychain: {:?}", default_keychain());
    }
}
