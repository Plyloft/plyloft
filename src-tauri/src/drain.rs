//! v1.9.x (Phase A.5): drain coordinator.
//!
//! When the user clicks "Drain & ship" on the audit modal, the drain
//! flag is set. While draining:
//!   * `swarm_start`, `intake_start`, `agent_run_start` (and `verify_start`
//!     once Phase B lands) refuse new dispatches with a clear error.
//!   * The frontend polls `ship_audit` every 2s; when in-flight counts
//!     hit zero, it transitions through a 10s grace window before
//!     invoking `ship_card`.
//!   * `drain_cancel` clears the flag and unblocks dispatches.
//!
//! The coordinator does not enforce the 30min hard timeout itself —
//! the frontend orchestrates timeout because it owns the audit polling
//! loop and surfaces the countdown UI.
//!
//! Lifecycle: registered as managed state alongside ShipRegistry.

use parking_lot::Mutex;
use serde::Serialize;
use std::time::SystemTime;

#[derive(Default)]
pub struct DrainCoordinator {
    inner: Mutex<DrainInner>,
}

#[derive(Default, Clone)]
struct DrainInner {
    draining: bool,
    started_at: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DrainStatus {
    pub draining: bool,
    pub started_at: Option<i64>,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl DrainCoordinator {
    pub fn start(&self) -> Result<(), String> {
        let mut s = self.inner.lock();
        if s.draining {
            return Err("drain already in progress".to_string());
        }
        s.draining = true;
        s.started_at = Some(now_millis());
        Ok(())
    }

    pub fn cancel(&self) {
        let mut s = self.inner.lock();
        s.draining = false;
        s.started_at = None;
    }

    pub fn is_draining(&self) -> bool {
        self.inner.lock().draining
    }

    pub fn status(&self) -> DrainStatus {
        let s = self.inner.lock();
        DrainStatus {
            draining: s.draining,
            started_at: s.started_at,
        }
    }
}

/// Guard helper for dispatch sites. Returns a structured error so the
/// command-layer can surface it as-is to the frontend, which renders a
/// toast.
pub fn guard_dispatch(coord: &DrainCoordinator, dispatch_kind: &str) -> Result<(), String> {
    if coord.is_draining() {
        return Err(format!(
            "drain in progress — new {dispatch_kind} dispatches are blocked. Cancel drain or wait for ship."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_start_then_cancel_resets_state() {
        let c = DrainCoordinator::default();
        assert!(!c.is_draining());
        c.start().unwrap();
        assert!(c.is_draining());
        assert!(c.status().started_at.is_some());
        c.cancel();
        assert!(!c.is_draining());
        assert!(c.status().started_at.is_none());
    }

    #[test]
    fn drain_start_twice_errors() {
        let c = DrainCoordinator::default();
        c.start().unwrap();
        assert!(c.start().is_err());
    }

    #[test]
    fn guard_dispatch_passes_when_idle() {
        let c = DrainCoordinator::default();
        assert!(guard_dispatch(&c, "swarm").is_ok());
    }

    #[test]
    fn guard_dispatch_blocks_when_draining() {
        let c = DrainCoordinator::default();
        c.start().unwrap();
        let err = guard_dispatch(&c, "intake").unwrap_err();
        assert!(err.contains("intake"));
        assert!(err.contains("drain"));
    }
}
