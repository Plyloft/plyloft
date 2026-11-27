// 1.179.0 (C1): the words and the small decisions of Settings › AI and
// models › Claude accounts (`ClaudeAccountsSection.tsx`). The rows, their
// state and every rule about names are Rust's (`ai_accounts.rs`); this only
// says them. Pure, so node tests every sentence:
//
//     node --experimental-strip-types src/lib/claudeAccounts.test.ts

import type { ClaudeAccountRow, ClaudeAccountSignedIn, SetupOutcome, SetupPhase } from "../ipc.ts";
import { machineWords, type Platform } from "./platform.ts";

export const SECTION_TITLE = "Claude accounts";

/** Written for the Mac; `machineWords` says "this PC" on Windows. */
const INTRO_MAC =
  "Use more than one Claude subscription on this Mac. Each account signs in with Claude's own login and keeps its own folder. New sessions start on the account you choose; a running session keeps its account.";

export function introLine(p: Platform): string {
  return machineWords(INTRO_MAC, p);
}

export const MAIN_DETAIL = "The account Claude uses on its own.";
export const CURRENT_MARK = "New sessions";

export const MENU = {
  use: "Use for new sessions",
  rename: "Rename…",
  signIn: "Sign in again",
  show: "Show folder",
  remove: "Remove…",
} as const;

export const ADD_BUTTON = "Add a Claude account…";
export const ADD_TITLE = "Add a Claude account";
export const NAME_LABEL = "Name";
export const NAME_PLACEHOLDER = "Work";
export const ADD_BODY =
  "Plyloft makes a folder for this account and opens Claude's own sign-in. Sign in with the subscription you want this account to use. Plyloft never sees your password or your login.";
export const ADD_NOTE =
  "This account has its own settings, skills and folder trust. Your Main skills and settings aren't used here.";
export const ADD_CONFIRM = "Make the folder and sign in";

export const REMOVE_BODY =
  "Plyloft deletes this account's folder. Conversations kept only there go with it. Signing out first lets Claude remove its own login for this account.";
export const REMOVE_SIGN_OUT = "Sign out and remove";
export const REMOVE_ONLY = "Remove without signing out";

/** The row's state. "unknown" is its own sentence, never "Not signed in". */
export function stateWords(signedIn: ClaudeAccountSignedIn): string {
  switch (signedIn) {
    case "yes":
      return "Signed in";
    case "no":
      return "Not signed in";
    case "unknown":
      return "Plyloft can't tell whether this account is signed in.";
  }
}

/** The dot beside the state: filled only for a sign-in that was seen. */
export function stateDot(signedIn: ClaudeAccountSignedIn): "done" | "empty" {
  return signedIn === "yes" ? "done" : "empty";
}

export function signInTitle(name: string): string {
  return `Sign in to Claude account ${name}`;
}

export function removeTitle(name: string): string {
  return `Remove ${name}?`;
}

/** Said after a removal only when Claude's login for it is still saved. */
export function removedLine(name: string, p: Platform): string {
  // The machine word is turned on the fixed words only, never on the name.
  return `${name} ${machineWords("is removed. Claude's own login for it is still saved on this Mac.", p)}`;
}

/** New strings (not in the approved table; listed in the C1 report). */
export function renameTitle(name: string): string {
  return `Rename ${name}`;
}
export const RENAME_CONFIRM = "Rename";

/**
 * The guided terminal's line for an account's sign-in once it has ended, in
 * the section's own words, or null to keep the terminal's (`setupLine`):
 * while it runs, and for the endings the table has no words for.
 */
export function signInEnd(
  name: string,
  phase: SetupPhase | null,
  outcome: SetupOutcome | null,
): { state: "done" | "empty"; text: string } | null {
  if (phase !== "done") return null;
  if (outcome === "succeeded") return { state: "done", text: `${name} is signed in.` };
  if (outcome === "not-observed") {
    return {
      state: "empty",
      text: `Plyloft didn't see a sign-in for ${name}. Try again, or close the window if you signed in elsewhere.`,
    };
  }
  return null;
}

export type AccountAction = keyof typeof MENU;

/**
 * What a row's ⋯ offers. Main has no id: Rust can neither remove it nor run
 * an account step on it, so it has no Remove and no Sign in again. The
 * current row is not offered to itself again.
 */
export function rowActions(row: ClaudeAccountRow): AccountAction[] {
  const out: AccountAction[] = [];
  if (!row.isCurrent) out.push("use");
  out.push("rename");
  if (row.id !== null) out.push("signIn");
  out.push("show");
  if (row.id !== null) out.push("remove");
  return out;
}

/** `rows` with `next` in the place of the row of the same id. */
export function replaceRow(rows: readonly ClaudeAccountRow[], next: ClaudeAccountRow): ClaudeAccountRow[] {
  return rows.map((r) => (r.id === next.id ? next : r));
}

/** The text of a refused call, as Rust returned it. */
export function refusal(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
