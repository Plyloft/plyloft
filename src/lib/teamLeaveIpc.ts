// 1.175.0 D5 (SRV-2): the calls behind `teamLeave.ts` (`team_leave_seat.rs`).
// Here, not in `ipc.ts`, which is at its size ceiling.
import { invoke } from "@tauri-apps/api/core";
import type { LeftSeat } from "./teamLeave";

/** Leave this team, for a member with a seat: the seat on the server first,
 *  then this computer. Rejects with a `LeaveRefused`; nothing changed then. */
export function teamLeaveSeat() {
  return invoke<LeftSeat>("team_leave_seat");
}

/** Give up a seat on a team this computer isn't in. Resolves to whether a
 *  seat was held. Rejects with a `LeaveRefused`. */
export function seatGiveUp() {
  return invoke<boolean>("seat_give_up");
}
