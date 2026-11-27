//! Ply's microphone authorization, as macOS records it.
//!
//! `claude` runs as a PTY child, so macOS attributes its microphone request
//! (Claude Code's `/voice` dictation) to Ply, the responsible process. This
//! module only *reads* that authorization and asks macOS to prompt for it; it
//! never opens an audio device. Ply's own dictation in Codex and shell tiles
//! (#47, `dictation.rs`) captures in the webview under the same authorization.

use serde::Serialize;

/// The three answers the doctor row shows.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MicrophoneAccess {
    /// macOS has not asked yet; the first request shows the prompt. Windows
    /// never asks a desktop app, so it has no such state.
    #[cfg_attr(windows, allow(dead_code))]
    NotAsked,
    Granted,
    /// Refused in the prompt or in System Settings, or restricted by a
    /// profile. Either way no request from Ply prompts again.
    Denied,
}

impl MicrophoneAccess {
    /// Map `AVAuthorizationStatus`. `Restricted` (1) is a profile's refusal:
    /// to the user it is a denial, and no prompt can clear it. An unknown
    /// future value is treated as a denial rather than as permission.
    pub fn from_av_status(raw: isize) -> Self {
        match raw {
            0 => Self::NotAsked,
            3 => Self::Granted,
            _ => Self::Denied,
        }
    }
}

/// System Settings → Privacy & Security → Microphone.
#[cfg(not(windows))]
pub const SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
/// Settings → Privacy & security → Microphone.
#[cfg(windows)]
pub const SETTINGS_URL: &str = "ms-settings:privacy-microphone";

/// The one scheme `microphone_open_settings` may hand to the desktop.
#[cfg(not(windows))]
pub const SETTINGS_SCHEME: &str = "x-apple.systempreferences";
#[cfg(windows)]
pub const SETTINGS_SCHEME: &str = "ms-settings";

impl MicrophoneAccess {
    /// Windows' consent store, most general first: the device switch
    /// (HKLM), `Microphone access` and `Let desktop apps access your
    /// microphone` (HKCU). Any `Deny` denies. A value that is not there is
    /// Windows' default, allowed; Windows never prompts a desktop app, so
    /// there is no `NotAsked`. The `LetAppsAccessMicrophone` group policy
    /// (`HKLM\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy`) is not
    /// read: it governs packaged apps, and a managed machine that forbids the
    /// microphone shows that in the switches above.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn from_consent_values(values: &[Option<String>]) -> Self {
        if values.iter().flatten().any(|v| v.eq_ignore_ascii_case("Deny")) {
            Self::Denied
        } else {
            Self::Granted
        }
    }
}

#[cfg(windows)]
mod consent {
    use super::MicrophoneAccess;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };

    /// A `Value` string under the microphone's consent key, read only.
    fn value(root: HKEY, subkey: PCWSTR) -> Option<String> {
        let mut buf = [0u16; 64];
        let mut len = std::mem::size_of_val(&buf) as u32;
        // SAFETY: the buffer and its byte length are ours for the call.
        let status = unsafe {
            RegGetValueW(
                root,
                subkey,
                w!("Value"),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut len),
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let chars = (len as usize / 2).min(buf.len());
        let text = String::from_utf16_lossy(&buf[..chars]);
        Some(text.trim_end_matches('\0').to_string())
    }

    pub fn status() -> Option<MicrophoneAccess> {
        let store = w!(
            r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
        );
        let desktop = w!(
            r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged"
        );
        Some(MicrophoneAccess::from_consent_values(&[
            value(HKEY_LOCAL_MACHINE, store),
            value(HKEY_CURRENT_USER, store),
            value(HKEY_CURRENT_USER, desktop),
        ]))
    }
}

#[cfg(target_os = "macos")]
mod ffi {
    use super::MicrophoneAccess;
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};

    pub fn status() -> Option<MicrophoneAccess> {
        std::panic::catch_unwind(|| unsafe {
            let audio = AVMediaTypeAudio?;
            let raw = AVCaptureDevice::authorizationStatusForMediaType(audio);
            Some(MicrophoneAccess::from_av_status(raw.0))
        })
        .unwrap_or_else(|_| {
            log::error!("microphone: panic reading AVCaptureDevice authorization");
            None
        })
    }

    /// Blocks until macOS answers. When access is already decided the
    /// completion handler fires at once with no prompt.
    pub fn request_access() -> Option<MicrophoneAccess> {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let requested = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            let Some(audio) = AVMediaTypeAudio else {
                return false;
            };
            // Called on an arbitrary dispatch queue; it only wakes this thread.
            let handler = block2::RcBlock::new(move |_granted: objc2_v6::runtime::Bool| {
                let _ = tx.send(());
            });
            AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler);
            true
        }));
        match requested {
            Ok(true) => {}
            Ok(false) => return None,
            Err(_) => {
                log::error!("microphone: panic requesting AVCaptureDevice access");
                return None;
            }
        }
        // A dropped sender (handler released without running) ends the wait
        // too; either way the status read afterwards is the answer.
        let _ = rx.recv();
        status()
    }
}

/// The current authorization. `None` when AVFoundation could not answer, or
/// on a platform with neither it nor Windows' consent store, and the doctor
/// then shows no row rather than a guess.
pub fn status() -> Option<MicrophoneAccess> {
    #[cfg(target_os = "macos")]
    {
        ffi::status()
    }
    #[cfg(windows)]
    {
        consent::status()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}

/// Ask macOS for access, so its prompt appears from Ply, and return the
/// authorization it settles on. Windows has no prompt for a desktop app, so
/// there it reads the settings again.
pub fn request_access() -> Option<MicrophoneAccess> {
    #[cfg(target_os = "macos")]
    {
        ffi::request_access()
    }
    #[cfg(windows)]
    {
        consent::status()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn av_status_maps_to_the_three_row_states() {
        assert_eq!(MicrophoneAccess::from_av_status(0), MicrophoneAccess::NotAsked);
        assert_eq!(MicrophoneAccess::from_av_status(1), MicrophoneAccess::Denied);
        assert_eq!(MicrophoneAccess::from_av_status(2), MicrophoneAccess::Denied);
        assert_eq!(MicrophoneAccess::from_av_status(3), MicrophoneAccess::Granted);
        assert_eq!(MicrophoneAccess::from_av_status(42), MicrophoneAccess::Denied);
    }

    #[test]
    fn access_serializes_as_the_row_labels_the_frontend_matches() {
        let json = serde_json::to_string(&[
            MicrophoneAccess::NotAsked,
            MicrophoneAccess::Granted,
            MicrophoneAccess::Denied,
        ])
        .unwrap();
        assert_eq!(json, r#"["not-asked","granted","denied"]"#);
    }

    #[test]
    fn any_deny_in_the_consent_store_denies() {
        let v = |s: &str| Some(s.to_string());
        assert_eq!(
            MicrophoneAccess::from_consent_values(&[v("Allow"), v("Allow"), v("Allow")]),
            MicrophoneAccess::Granted
        );
        assert_eq!(
            MicrophoneAccess::from_consent_values(&[v("Allow"), None, v("Deny")]),
            MicrophoneAccess::Denied
        );
        assert_eq!(
            MicrophoneAccess::from_consent_values(&[v("deny"), v("Allow"), None]),
            MicrophoneAccess::Denied
        );
        // Absent is Windows' default: allowed.
        assert_eq!(
            MicrophoneAccess::from_consent_values(&[None, None, None]),
            MicrophoneAccess::Granted
        );
    }

    /// The settings link is the only non-web scheme, and only for this call.
    #[test]
    fn the_settings_link_passes_only_its_own_allow_list() {
        assert!(crate::platform::url_scheme_allowed(SETTINGS_URL, &[SETTINGS_SCHEME]));
        assert!(!crate::platform::url_scheme_allowed(SETTINGS_URL, crate::platform::WEB_SCHEMES));
    }

    #[cfg(windows)]
    #[test]
    fn windows_opens_the_microphone_privacy_page() {
        assert_eq!(SETTINGS_URL, "ms-settings:privacy-microphone");
        assert!(!crate::platform::url_scheme_allowed(
            "ms-settings:privacy-webcam\n",
            &[SETTINGS_SCHEME]
        ));
        // The consent store always answers: an absent value is allowed.
        assert!(status().is_some());
    }

    /// Reads the real authorization without opening a device or prompting.
    #[cfg(target_os = "macos")]
    #[test]
    fn status_reads_without_prompting() {
        assert!(status().is_some());
    }
}
