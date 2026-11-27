import { invoke } from "@tauri-apps/api/core";

// 1.176.2 (A5F-01): the live Builder sessions no terminal of this window
// shows — when each last printed, whether its process ended and (1.176.3
// phase 2) its screen (`builder_screens.rs`) — kept out of `ipc.ts` for its
// line cap.

/** One live Builder session no terminal here shows (`SessionScreen`). */
export type BuilderSessionScreen = {
  /** `<card>` or SL-6's `<card>#both-a|b`. */
  key: string;
  vendor: string;
  /** When its PTY last printed (ms); null if it never did. */
  lastOutputAt: number | null;
  /** Its child has ended. */
  exited: boolean;
  /** 1.176.3: its screen's settled last rows, top to bottom (none once it
   *  ended). The person's screen: judged in memory, never logged or kept.
   *  Missing from an older backend's answer. */
  rows?: string[];
  /** 1.176.3: when the rows above its composer last changed (ms), as the
   *  backend's reads saw it. */
  contentChangedAt?: number | null;
};

/** Every live Builder session but those in `observed` (their keys). */
export function builderSessionScreens(observed: string[]) {
  return invoke<BuilderSessionScreen[]>("builder_session_screens", { observed });
}
