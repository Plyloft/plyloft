//! 1.176.0 R7: a tile names its PTY's id before the spawn, so it can listen
//! for `pty://data` and `pty://exit` first and nothing the process prints —
//! not even an exit in the first milliseconds — goes out before anyone hears
//! it. A Tauri event reaches only the listeners registered when it is
//! emitted; the tile used to subscribe once `pty_spawn` had returned the id,
//! and a CLI that died at once left a blank tile (PLAN blind spot 19).
//!
//! The chosen design keeps no output in the backend: no replay buffer to
//! bound, hand over or free when a tile never attaches. The id is a v4 UUID
//! (the frontend's `crypto.randomUUID()`), in its one canonical spelling, so
//! the ids every other piece keys by (coordination records, the tile store,
//! terminal session rows) look as they always did.
//!
//! Every tile id is claimed here, atomically, before its child exists, and
//! never handed out again in this run: two spawns that race for one id can't
//! both start (the loser starts nothing, so none of its output can reach the
//! other tile under that id), and an id that already has a coordination
//! record or a session row is never reused. Bounded: the oldest claims are
//! forgotten past [`REMEMBERED`] (a v4 UUID is never drawn twice anyway; the
//! registry still refuses a live one).

use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;

/// How many claimed ids are remembered.
pub(crate) const REMEMBERED: usize = 4096;

/// Why a requested id is refused when it was used already in this run (or
/// a live PTY has it): the process is never started.
pub(crate) const PTY_ID_IN_USE: &str = "a terminal with this id is already running";

/// The ids claimed in this run, oldest first.
#[derive(Default)]
pub(crate) struct Claims {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl Claims {
    /// Claim `id`; false when it was claimed before (and is still remembered).
    pub(crate) fn claim(&mut self, id: &str, cap: usize) -> bool {
        if !self.seen.insert(id.to_string()) {
            return false;
        }
        self.order.push_back(id.to_string());
        while self.order.len() > cap {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
        true
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.order.len()
    }
}

static CLAIMS: Mutex<Option<Claims>> = Mutex::new(None);

/// Pure: the requested id when it is a canonical (lowercase, hyphenated)
/// version-4 UUID — never the nil one.
pub(crate) fn valid_tile_id(requested: &str) -> Result<(), String> {
    match uuid::Uuid::parse_str(requested) {
        Ok(parsed)
            if !parsed.is_nil()
                && parsed.get_version_num() == 4
                && parsed.hyphenated().to_string() == requested =>
        {
            Ok(())
        }
        _ => Err(format!("a terminal's id must be a lowercase version-4 UUID, not {requested:?}")),
    }
}

/// The id a tile's PTY runs under, claimed for this run: the requested one
/// when it is valid and new, a fresh one when none was asked for.
pub(crate) fn tile_pty_id(requested: Option<&str>) -> Result<String, String> {
    let id = match requested {
        Some(requested) => {
            valid_tile_id(requested)?;
            requested.to_string()
        }
        None => uuid::Uuid::new_v4().to_string(),
    };
    let mut claims = CLAIMS.lock().unwrap_or_else(|p| p.into_inner());
    if !claims.get_or_insert_with(Claims::default).claim(&id, REMEMBERED) {
        return Err(PTY_ID_IN_USE.into());
    }
    Ok(id)
}

#[cfg(test)]
#[path = "pty_tile_id_tests.rs"]
mod tests;
