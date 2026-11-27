//! macOS App Nap control.
//!
//! v1.63.0: suppression is *conditional*. Pre-1.63 the NSActivity token was
//! acquired once at startup and held for the app's whole lifetime — App Nap
//! permanently disabled, even hidden + idle (and window-close *hides*, Hard
//! Rule #5, so that's most of the app's life). Now an [`ActivityGate`] holds
//! the token only while PTY streams are live: acquired on the 0→1 stream
//! transition, released by the 30s runtime tick (`agents::runtime_tick`) after a sustained idle
//! window with no Running swarms (swarms have inter-leg gaps with zero live
//! PTYs — the swarm check plus hysteresis keeps the token held mid-swarm).
//!
//! NSActivity footgun (see docs/PATTERNS.md): the assertion persists until
//! `endActivity:` is called on NSProcessInfo — releasing the `Retained`
//! pointer alone leaks the assertion. `AppNapToken::drop` calls it
//! explicitly, which is also why the release profile must keep
//! `panic = "unwind"` (both FFI paths are wrapped in `catch_unwind`).

use parking_lot::Mutex;
use std::time::{Duration, Instant};

/// Idle hysteresis: the token is released only after this many seconds of
/// continuous zero-activity. Covers brief gaps (oneshot chains, card-queue
/// pumps) without thrashing the assertion.
pub const IDLE_RELEASE_SECS: u64 = 60;

#[cfg(target_os = "macos")]
mod ffi {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSProcessInfo, NSString};

    const NS_ACTIVITY_USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP: u64 =
        0x00FF_FFFF & !(1u64 << 20);

    pub struct AppNapToken {
        activity: Retained<AnyObject>,
    }

    unsafe impl Send for AppNapToken {}
    unsafe impl Sync for AppNapToken {}

    impl Drop for AppNapToken {
        fn drop(&mut self) {
            // NSActivity assertions persist until `endActivity:` — dropping
            // the Retained pointer alone would leak the assertion forever.
            let activity = &self.activity;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
                let process_info = NSProcessInfo::processInfo();
                let _: () = msg_send![&*process_info, endActivity: &**activity];
            }));
            match result {
                Ok(()) => log::info!("app_nap: activity token released (App Nap re-enabled)"),
                Err(_) => log::error!("app_nap: panic during endActivity FFI"),
            }
        }
    }

    pub fn begin() -> Option<AppNapToken> {
        let result = std::panic::catch_unwind(|| unsafe {
            let process_info = NSProcessInfo::processInfo();
            let reason =
                NSString::from_str("Plyloft keeps PTY children alive while window is hidden");
            let activity_ptr: *mut AnyObject = msg_send![
                &*process_info,
                beginActivityWithOptions: NS_ACTIVITY_USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP,
                reason: &*reason
            ];
            Retained::retain(activity_ptr).map(|activity| AppNapToken { activity })
        });

        match result {
            Ok(Some(token)) => {
                log::info!("app_nap: activity token acquired");
                Some(token)
            }
            Ok(None) => {
                log::warn!("app_nap: beginActivityWithOptions returned nil");
                None
            }
            Err(_) => {
                log::error!("app_nap: panic during FFI; App Nap not disabled");
                None
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod ffi {
    /// Non-mac no-op so [`super::ActivityGate`] compiles everywhere.
    pub struct AppNapToken;

    pub fn begin() -> Option<AppNapToken> {
        None
    }
}

pub use ffi::AppNapToken;

/// Pure counting state machine behind the gate — no FFI, fully unit-testable.
struct GateState {
    active: usize,
    /// Stamped on the 1→0 transition; cleared on 0→1. `None` while active
    /// or before the first stream ever started (no release at startup —
    /// no token is held then either).
    last_zero_at: Option<Instant>,
}

impl GateState {
    fn new() -> Self {
        Self {
            active: 0,
            last_zero_at: None,
        }
    }

    /// Returns true when this start is the 0→1 transition (token needed).
    fn on_start(&mut self) -> bool {
        self.active += 1;
        if self.active == 1 {
            self.last_zero_at = None;
            true
        } else {
            false
        }
    }

    /// Saturating: an unbalanced end is ignored rather than underflowing or
    /// re-stamping the idle clock.
    fn on_end(&mut self) {
        if self.active == 0 {
            return;
        }
        self.active -= 1;
        if self.active == 0 {
            self.last_zero_at = Some(Instant::now());
        }
    }

    fn should_release(&self, swarms_running: bool, now: Instant) -> bool {
        self.active == 0
            && !swarms_running
            && self
                .last_zero_at
                .is_some_and(|t| now.duration_since(t) >= Duration::from_secs(IDLE_RELEASE_SECS))
    }
}

/// Holds the App Nap suppression token while there is real activity.
///
/// Ground truth is *live PTY reader threads* (every agent run, swarm leg and
/// interactive tile streams through one), bracketed in
/// `pty::spawn_stream_threads` / `spawn_collect` — deliberately NOT the
/// sessions map, whose entries can outlive dead children. Release is
/// evaluated on the existing 30s runtime tick (`agents::runtime_tick`).
pub struct ActivityGate {
    state: Mutex<GateState>,
    token: Mutex<Option<AppNapToken>>,
}

impl Default for ActivityGate {
    fn default() -> Self {
        Self::new()
    }
}

impl ActivityGate {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(GateState::new()),
            token: Mutex::new(None),
        }
    }

    /// A PTY stream came alive. On the 0→1 transition, (re)acquire the
    /// token immediately — a cron-fired run while napped re-suppresses
    /// without waiting for any tick.
    pub fn on_stream_start(&self) {
        // NB: the state guard is a temporary — dropped before the token
        // lock is taken, so this can't deadlock against `maybe_release`
        // (which locks token → state).
        let acquire = self.state.lock().on_start();
        if acquire {
            let mut tok = self.token.lock();
            if tok.is_none() {
                *tok = ffi::begin();
            }
        }
    }

    /// A PTY stream ended (EOF, kill, Cmd-Q). Stamps the idle clock on the
    /// 1→0 transition.
    pub fn on_stream_end(&self) {
        self.state.lock().on_end();
    }

    /// Called from the 30s runtime tick (`agents::runtime_tick`). Releases the token (Drop →
    /// `endActivity:`) only after `IDLE_RELEASE_SECS` of continuous zero
    /// activity AND no Running swarms (inter-leg gaps must not nap the app).
    pub fn maybe_release(&self, swarms_running: bool) {
        let mut tok = self.token.lock();
        if tok.is_none() {
            return;
        }
        let release = self
            .state
            .lock()
            .should_release(swarms_running, Instant::now());
        if release {
            *tok = None;
            log::info!(
                "app_nap: idle ≥{IDLE_RELEASE_SECS}s with no running swarms — releasing token"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle_since(secs_ago: u64) -> (GateState, Instant) {
        // Fabricate "went idle `secs_ago` seconds before `now`" without
        // sleeping: pin `last_zero_at` and compute `now` forward from it.
        let t0 = Instant::now();
        let mut st = GateState::new();
        st.active = 0;
        st.last_zero_at = Some(t0);
        (st, t0 + Duration::from_secs(secs_ago))
    }

    #[test]
    fn releases_only_after_hysteresis_window() {
        let (st, just_before) = idle_since(IDLE_RELEASE_SECS - 1);
        assert!(!st.should_release(false, just_before));
        let (st, at_window) = idle_since(IDLE_RELEASE_SECS);
        assert!(st.should_release(false, at_window));
    }

    #[test]
    fn swarm_running_blocks_release() {
        let (st, now) = idle_since(IDLE_RELEASE_SECS * 10);
        assert!(!st.should_release(true, now));
        assert!(st.should_release(false, now));
    }

    #[test]
    fn nonzero_active_blocks_release() {
        let (mut st, now) = idle_since(IDLE_RELEASE_SECS * 10);
        st.active = 1;
        assert!(!st.should_release(false, now));
    }

    #[test]
    fn never_releases_before_first_stream() {
        // Startup state: nothing ever ran, last_zero_at is None.
        let st = GateState::new();
        assert!(!st.should_release(false, Instant::now() + Duration::from_secs(3600)));
    }

    #[test]
    fn counter_transitions_track_zero_crossing() {
        let mut st = GateState::new();
        assert!(st.on_start(), "0→1 must request token acquisition");
        assert!(!st.on_start(), "1→2 must not");
        assert!(st.last_zero_at.is_none(), "active gate has no idle mark");
        st.on_end();
        assert!(st.last_zero_at.is_none(), "2→1 is not idle yet");
        st.on_end();
        assert!(st.last_zero_at.is_some(), "1→0 stamps the idle clock");
        assert!(st.on_start(), "restart after idle is a fresh 0→1");
        assert!(st.last_zero_at.is_none(), "restart clears the idle mark");
    }

    #[test]
    fn active_count_saturates_at_zero() {
        let mut st = GateState::new();
        st.on_end(); // unbalanced — must not underflow or stamp idle
        assert_eq!(st.active, 0);
        assert!(st.last_zero_at.is_none());
    }
}
