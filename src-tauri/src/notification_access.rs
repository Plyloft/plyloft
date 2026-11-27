//! QoL 1.168 (F4, owner D6): whether Plyloft may show notifications, as the
//! system records it, and asking for it.
//!
//! macOS: `UNUserNotificationCenter`'s authorization for Plyloft's bundle —
//! read, and requested so macOS shows its "Allow notifications" prompt (once:
//! later requests answer at once). The notifications themselves still go
//! through `tauri-plugin-notification`; the system's per-app switch governs
//! both. `UNUserNotificationCenter` raises an Objective-C exception in a
//! process that is not an app bundle (a `tauri dev` binary), which no
//! `catch_unwind` stops, so it is only touched inside a `.app` with a bundle
//! identifier; elsewhere the answer is `Unknown` and Setup falls back to the
//! test notification, which makes macOS ask the same question.
//!
//! Windows never asks a desktop app: notifications are on unless the person
//! turned them off under Notifications, in Settings › System — for every app
//! (the `ToastEnabled` switch) or for Plyloft (its own `Enabled` switch,
//! under the AppUserModelID the plugin sends with: the app's identifier,
//! `com.mbadv.ply`, or the test profile's).

use serde::Serialize;

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationAccess {
    /// macOS has not asked yet: the first request shows its prompt.
    #[cfg_attr(windows, allow(dead_code))]
    NotAsked,
    Allowed,
    /// Refused in the prompt or turned off in the system's settings; no
    /// request prompts again, only the system's settings can undo it.
    Denied,
    /// Plyloft could not tell (not an app bundle, or the system did not
    /// answer).
    Unknown,
}

impl NotificationAccess {
    /// Map `UNAuthorizationStatus`: 0 not determined, 1 denied, 2 authorized,
    /// 3 provisional and 4 ephemeral (both deliver). An unknown future value
    /// reads as unknown, never as allowed.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn from_un_status(raw: isize) -> Self {
        match raw {
            0 => Self::NotAsked,
            1 => Self::Denied,
            2..=4 => Self::Allowed,
            _ => Self::Unknown,
        }
    }

    /// Windows' switches: `ToastEnabled` (every app) and the app's own
    /// `Enabled`, DWORDs where 0 is off; a value not there is Windows'
    /// default, on. Either off is off.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn from_windows_switches(all_apps: Option<u32>, this_app: Option<u32>) -> Self {
        if all_apps == Some(0) || this_app == Some(0) {
            Self::Denied
        } else {
            Self::Allowed
        }
    }
}

/// Where the system's notification switches are.
#[cfg(not(windows))]
pub const SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.preference.notifications";
#[cfg(windows)]
pub const SETTINGS_URL: &str = "ms-settings:notifications";
#[cfg(not(windows))]
pub const SETTINGS_SCHEME: &str = "x-apple.systempreferences";
#[cfg(windows)]
pub const SETTINGS_SCHEME: &str = "ms-settings";

#[cfg(target_os = "macos")]
mod ffi {
    use super::NotificationAccess;
    use objc2_user_notifications::{UNAuthorizationOptions, UNNotificationSettings, UNUserNotificationCenter};
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;

    /// macOS answers in a moment; a system that doesn't is not waited on.
    const ANSWER_WAIT: Duration = Duration::from_secs(5);

    /// Only an app bundle with an identifier has a notification center.
    fn bundled() -> bool {
        use objc2_foundation::NSBundle;
        let bundle = NSBundle::mainBundle();
        let path = unsafe { bundle.bundlePath() }.to_string();
        let id = unsafe { bundle.bundleIdentifier() };
        path.ends_with(".app") && id.is_some_and(|i| !i.to_string().is_empty())
    }

    pub fn status() -> NotificationAccess {
        if !bundled() {
            return NotificationAccess::Unknown;
        }
        let (tx, rx) = mpsc::channel::<isize>();
        let asked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let center = UNUserNotificationCenter::currentNotificationCenter();
            // Called on an arbitrary queue; it only hands the answer over.
            let handler = block2::RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                let raw = unsafe { settings.as_ref() }.authorizationStatus().0;
                let _ = tx.send(raw);
            });
            center.getNotificationSettingsWithCompletionHandler(&handler);
        }));
        if asked.is_err() {
            log::error!("notifications: panic reading the notification settings");
            return NotificationAccess::Unknown;
        }
        match rx.recv_timeout(ANSWER_WAIT) {
            Ok(raw) => NotificationAccess::from_un_status(raw),
            Err(_) => NotificationAccess::Unknown,
        }
    }

    /// Ask macOS (its prompt appears once), then read what it settled on.
    pub fn request() -> NotificationAccess {
        if !bundled() {
            return NotificationAccess::Unknown;
        }
        let (tx, rx) = mpsc::channel::<()>();
        let asked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let handler = block2::RcBlock::new(move |_granted: objc2_v6::runtime::Bool, _error: *mut objc2_foundation_v3::NSError| {
                let _ = tx.send(());
            });
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
                &handler,
            );
        }));
        if asked.is_err() {
            log::error!("notifications: panic requesting authorization");
            return NotificationAccess::Unknown;
        }
        // The person may take a while to answer the prompt.
        let _ = rx.recv_timeout(Duration::from_secs(120));
        status()
    }
}

#[cfg(windows)]
mod toast {
    use super::NotificationAccess;
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};

    /// One DWORD under HKCU, read only.
    fn dword(subkey: PCWSTR, name: PCWSTR) -> Option<u32> {
        let mut value: u32 = 0;
        let mut len = std::mem::size_of::<u32>() as u32;
        // SAFETY: the buffer and its byte length are ours for the call.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey,
                name,
                RRF_RT_REG_DWORD,
                None,
                Some((&mut value as *mut u32).cast()),
                Some(&mut len),
            )
        };
        (status == ERROR_SUCCESS).then_some(value)
    }

    pub fn status(app_id: &str) -> NotificationAccess {
        let all = dword(
            w!(r"Software\Microsoft\Windows\CurrentVersion\PushNotifications"),
            w!("ToastEnabled"),
        );
        let key = HSTRING::from(format!(
            r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\{app_id}"
        ));
        let this = dword(PCWSTR(key.as_ptr()), w!("Enabled"));
        NotificationAccess::from_windows_switches(all, this)
    }
}

/// `app_id`: the app's identifier (`tauri.conf.json`), the AppUserModelID
/// the notification plugin sends with on Windows.
#[cfg_attr(not(windows), allow(unused_variables))]
pub fn status(app_id: &str) -> NotificationAccess {
    #[cfg(target_os = "macos")]
    {
        ffi::status()
    }
    #[cfg(windows)]
    {
        toast::status(app_id)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        NotificationAccess::Unknown
    }
}

#[cfg_attr(target_os = "macos", allow(unused_variables))]
pub fn request(app_id: &str) -> NotificationAccess {
    #[cfg(target_os = "macos")]
    {
        ffi::request()
    }
    #[cfg(not(target_os = "macos"))]
    {
        status(app_id)
    }
}

#[cfg(test)]
mod tests {
    use super::NotificationAccess as A;

    #[test]
    fn the_systems_answers_map_to_four_words() {
        assert_eq!(A::from_un_status(0), A::NotAsked);
        assert_eq!(A::from_un_status(1), A::Denied);
        for raw in 2..=4 {
            assert_eq!(A::from_un_status(raw), A::Allowed);
        }
        assert_eq!(A::from_un_status(9), A::Unknown, "never allowed by a guess");
        assert_eq!(A::from_windows_switches(None, None), A::Allowed);
        assert_eq!(A::from_windows_switches(Some(1), Some(1)), A::Allowed);
        assert_eq!(A::from_windows_switches(Some(0), None), A::Denied, "every app off");
        assert_eq!(A::from_windows_switches(None, Some(0)), A::Denied, "Plyloft off");
        assert_eq!(serde_json::to_string(&A::NotAsked).unwrap(), "\"not-asked\"");
    }
}
