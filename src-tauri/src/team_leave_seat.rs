//! 1.175.0 D5 (review SRV-2; owner D5-a, D5-b): **Leave this team** for a
//! member who holds a seat, and **Give up the seat…** for someone given a
//! seat on a team this computer never joined.
//!
//! One action, in this order: the server frees the member's own seat
//! (`DELETE /team/seat`, `billing_client::seat_leave`), **then** this
//! computer stops following the team (`commands::leave_team`). If the server
//! doesn't answer, or refuses, nothing changes here: no half state where the
//! computer left and the seat is still held. If the seat is free and this
//! computer can't save that it left, the outcome says so and a second press
//! is safe (the server's answer is then `left: false`, a success).
//!
//! Nothing is written to GitHub: the member's access to the repositories and
//! their name in the team's list stay the owner's to remove (D5-b).
//!
//! The owner, a member without a seat, and a team on a comp or a trial with
//! no seats on the server keep `commands::team_leave`, which only makes this
//! computer stop following the team.

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::account::{AccountError, AccountStore, ErrorCode};

/// What leaving did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftSeat {
    /// A seat was held and is free now; `false`: it was already free.
    pub left: bool,
    /// This computer no longer follows the team. `false`: the seat is free
    /// and the record couldn't be saved here — press Leave again, it is safe.
    pub local: bool,
}

/// Why the seat wasn't given up. Nothing changed, on the server or here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaveRefused {
    /// `offline`: the account server couldn't be reached. `signIn`: the
    /// Plyloft session ran out or moved to another computer. `unsupported`:
    /// the server is older than 1.175 and has no such route. `other`: its
    /// own sentence (`message`), as for the owner's seat.
    pub kind: &'static str,
    pub message: String,
}

fn refused(error: AccountError) -> LeaveRefused {
    let kind = match error.code {
        ErrorCode::Network | ErrorCode::RateLimited | ErrorCode::Server => "offline",
        ErrorCode::Unauthorized | ErrorCode::Replaced => "signIn",
        // A server that doesn't know `DELETE /team/seat`: never "already free".
        ErrorCode::NotFound => "unsupported",
        _ => "other",
    };
    LeaveRefused { kind, message: error.message }
}

/// The seat first; `stop_following` runs only once the server said the seat
/// is free (now, or already). Its failure keeps the server's answer.
pub(crate) fn leave_with(
    give_up: impl FnOnce() -> Result<bool, AccountError>,
    stop_following: impl FnOnce() -> Result<(), String>,
) -> Result<LeftSeat, LeaveRefused> {
    let left = give_up().map_err(refused)?;
    let local = match stop_following() {
        Ok(()) => true,
        Err(error) => {
            log::warn!("team: the seat is free, but this computer still follows the team: {error}");
            false
        }
    };
    Ok(LeftSeat { left, local })
}

/// **Leave this team**, for a member with a seat.
#[tauri::command]
pub async fn team_leave_seat(app: tauri::AppHandle) -> Result<LeftSeat, LeaveRefused> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = app.state::<crate::settings::SettingsStore>();
        if crate::commands::team_repo_of(&settings).is_none() {
            return Err(LeaveRefused { kind: "other", message: format!("{} is not in a team.", crate::this_machine!(cap)) });
        }
        let outcome = leave_with(
            || crate::billing_client::seat_leave(&app.state::<AccountStore>()),
            || {
                let saved = crate::commands::leave_team(&settings)?;
                app.state::<crate::team::TeamStore>().forget_membership();
                let _ = app.emit("settings://changed", saved);
                Ok(())
            },
        )?;
        // The plan is the member's own from now on; a refresh that fails
        // here is tried again by the refresher.
        let _ = crate::account::refresh_and_emit(&app);
        Ok(outcome)
    })
    .await
    .map_err(|error| LeaveRefused { kind: "other", message: format!("join team leave: {error}") })?
}

/// **Give up the seat…** (Settings › Plan): a seat on a team this computer
/// isn't in. Only the server changes; `true` when a seat was held.
#[tauri::command]
pub async fn seat_give_up(app: tauri::AppHandle) -> Result<bool, LeaveRefused> {
    tauri::async_runtime::spawn_blocking(move || {
        let left = crate::billing_client::seat_leave(&app.state::<AccountStore>()).map_err(refused)?;
        let _ = crate::account::refresh_and_emit(&app);
        Ok(left)
    })
    .await
    .map_err(|error| LeaveRefused { kind: "other", message: format!("join seat give up: {error}") })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn error(code: ErrorCode, message: &str) -> AccountError {
        AccountError { code, message: message.into(), device_name: None, reclaimable: None, url: None }
    }

    /// The server refuses or doesn't answer: nothing changes on this computer.
    #[test]
    fn a_server_that_refuses_or_does_not_answer_changes_nothing_here() {
        for (code, kind) in [
            (ErrorCode::Network, "offline"),
            (ErrorCode::Server, "offline"),
            (ErrorCode::RateLimited, "offline"),
            (ErrorCode::Unauthorized, "signIn"),
            (ErrorCode::Replaced, "signIn"),
            (ErrorCode::NotFound, "unsupported"),
            (ErrorCode::Forbidden, "other"),
        ] {
            let stopped = Cell::new(false);
            let out = leave_with(
                || Err(error(code, "said")),
                || {
                    stopped.set(true);
                    Ok(())
                },
            );
            assert_eq!(out, Err(LeaveRefused { kind, message: "said".into() }), "{code:?}");
            assert!(!stopped.get(), "{code:?}: this computer still follows the team");
        }
    }

    /// The server freed the seat, or found it free already: both are a
    /// success, and only then does this computer stop following the team.
    #[test]
    fn a_freed_seat_and_an_already_free_one_both_leave_here() {
        for left in [true, false] {
            let stopped = Cell::new(false);
            let out = leave_with(
                || Ok(left),
                || {
                    stopped.set(true);
                    Ok(())
                },
            );
            assert_eq!(out, Ok(LeftSeat { left, local: true }));
            assert!(stopped.get());
        }
    }

    /// The seat is free and the record can't be saved here: said as it is,
    /// never as a failure to leave (a second press finds the seat free).
    #[test]
    fn a_seat_freed_while_this_computer_cannot_save_is_said_as_such() {
        let out = leave_with(|| Ok(true), || Err("disk full".into()));
        assert_eq!(out, Ok(LeftSeat { left: true, local: false }));
        let again = leave_with(|| Ok(false), || Ok(()));
        assert_eq!(again, Ok(LeftSeat { left: false, local: true }), "the second press is safe");
    }

    /// The owner, a member without a seat and a team without seats keep
    /// today's Leave: `team_leave` never calls the server.
    #[test]
    fn todays_leave_is_untouched_and_calls_no_server() {
        let source = include_str!("commands.rs");
        let (_, body) = source.split_once("pub async fn team_leave(app: AppHandle)").expect("the command");
        let body = body.split_once("\n}\n").expect("its body").0;
        assert!(body.contains("leave_team(&settings)?"));
        assert!(!body.contains("seat_leave") && !body.contains("billing_client"), "{body}");
        // And the seat is asked of the server before anything is saved here.
        let own = include_str!("team_leave_seat.rs");
        let (_, command) = own.split_once("pub async fn team_leave_seat(").unwrap();
        assert!(command.find("seat_leave(").unwrap() < command.find("leave_team(&settings)").unwrap());
    }
}
