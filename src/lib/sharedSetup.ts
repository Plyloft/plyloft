/**
 * 1.175.0 (C1, review SC-2): *Stop sharing* and "The shared setup was
 * removed" — the words of Settings › Project › General's "Shared setup" row,
 * its two sheets, the Board's notice and the toasts. `stop_sharing.rs` does
 * the work and `workspace_adoption.rs` decides the state; this module is
 * pure, so `sharedSetup.test.ts` runs it under node. The calls are in
 * `sharedSetupIpc.ts`.
 *
 * Written for the Mac; `machineWords` renames the machine where the words
 * are drawn (the Row, the notice, the confirm sheet and the toast store).
 */
import { ago, fieldLabel, listLabels, quotedLabel } from "./definitionRefresh.ts";

/** WALKFIX-3 (re-run, item 3): Share waits in its pull request — the row's
 *  and the status line's first sentence (modelled on C1's "Still shared:
 *  stopping waits in pull request #N"). */
export function sharingWaitsLine(number: number): string {
  return `Not shared yet: sharing waits in pull request #${number}.`;
}

/** Mirrors `workspace_definition::Unreadable`. */
export interface SetupUnreadable {
  path: string;
  line: number | null;
  message: string;
}

/**
 * WALKFIX-1 (walk): what the "Shared setup" row and the shared pages' status
 * line say while the file on the branch can't be used — C6's approved words
 * for a file a newer Plyloft wrote (`Unreadable::newer_sentence`), and, for a
 * broken file, the Diagnostics row's own (`doctor.rs`). `hasCopy`: this Mac
 * runs on the last good copy.
 */
export function unreadableSetupLine(u: SetupUnreadable, branch: string, hasCopy: boolean): string {
  const line = u.line != null ? ` (line ${u.line})` : "";
  const newer = u.message.includes("unknown variant") || u.message.includes("was written by a newer Plyloft");
  const until = hasCopy
    ? "Until then it keeps using the last good copy and publishes nothing."
    : "Until then it keeps its own settings and publishes nothing.";
  if (newer) {
    return `${u.path} on ${branch} was written by a newer Plyloft, so this Mac can't read all of it${line}. Update Plyloft on this Mac. ${until}`;
  }
  const kept = hasCopy ? "Plyloft keeps using the last good copy" : "Plyloft has no earlier copy, so this Mac keeps its own settings";
  return `${u.path} on ${branch} can't be read${line}. ${kept}, and never writes over the file; fix it in the repository.`;
}

/** Mirrors `workspace_adoption::SharedSetup`. */
export type SharedSetup =
  | {
      state: "shared";
      branch: string;
      readOnly: boolean;
      /** Who last changed the file: whom a read-only member asks. */
      author: string | null;
      /** This computer's changes not published yet (field keys). */
      pending: string[];
      /** The removal waiting in a pull request, when the push was refused. */
      pullRequest: { number: number; url: string } | null;
      /** WALKFIX-1: the file on the branch can't be used now. Absent: it reads. */
      unreadable?: SetupUnreadable | null;
    }
  | {
      state: "removed";
      branch: string;
      who: string | null;
      at: number | null;
      readOnly: boolean;
      /** Round 2: this computer's settings pull requests still open on
       *  GitHub, which Plyloft no longer follows. Absent: none. */
      leftOpen?: number[];
    }
  | { state: "notShared"; who: string | null; at: number; here: boolean; readOnly: boolean; leftOpen?: number[] }
  /** 1.175.0 (C2, SC-1): the setup is in the older file, and the pull
   *  request that proposed moving it was closed without merging. */
  | { state: "declined"; pullRequest: number; who: string | null; readOnly: boolean }
  /** Round 5: the setup is read from the older file and this folder's
   *  history can't be read whole (a shallow clone): nothing is moved by
   *  itself, and this row keeps the press. */
  | { state: "olderFile"; readOnly: boolean }
  /** WALKFIX-3: Share waits in a pull request (the branch refused the push). */
  | { state: "waiting"; branch: string; pullRequest: { number: number; url: string }; readOnly: boolean };

/** Mirrors `stop_sharing::StopOutcome`. */
export type StopOutcome =
  | { kind: "stopped"; branch: string; closed?: number[]; leftOpen?: number[] }
  | { kind: "pullRequest"; branch: string; number: number; url: string };

/** Mirrors `stop_sharing::SharingNote` (a refresh report's `sharing`). */
export type SharingNote =
  | { kind: "stopped"; branch: string; closed?: number[]; leftOpen?: number[] }
  | { kind: "stoppedBy"; who: string | null }
  | { kind: "removalClosed"; number: number }
  /** Owner, 2026-11-10: a teammate shared it again; `board` when it differs
   *  from this Mac's. */
  | { kind: "sharedAgain"; who: string | null; board?: "local" | "githubIssues" | null };

export const STOP_SHARING = "Stop sharing…";
export const SHARE_AGAIN = "Share it again…";
export const KEEP_ON_THIS_MAC = "Keep it on this Mac";
export const OPEN_PULL_REQUEST = "Open pull request";
export const REMOVED_SUMMARY = "the shared setup was removed";
export const PROPOSE_AGAIN = "Propose it again";
export const PROPOSE_MOVING = "Propose moving it";
export const DECLINED_SUMMARY = "the shared setup stays in its older file";

const FILE = ".atelier/workspace.json";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "9 Nov", in this computer's own time. */
export function dayOf(secs: number): string {
  const d = new Date(secs * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function changesWord(n: number): string {
  return n === 1 ? "change" : "changes";
}

function numbered(numbers: readonly number[]): string {
  const named = numbers.map((n) => `#${n}`);
  return named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/** Round 2: the settings pull requests this computer opened and no longer
 *  follows now that the setup isn't shared — named, so the person can close
 *  them on GitHub. `read` (round 4): Plyloft has just asked GitHub and the
 *  close didn't go through, so "is still open" is a fact (the toast right
 *  after the press); elsewhere nothing was read and the sentence says "may
 *  still be open" (the row, later). Empty when there are none. */
export function leftOpenLine(numbers: readonly number[] | undefined, read = false): string {
  if (!numbers || numbers.length === 0) return "";
  const one = numbers.length === 1;
  const subject = one
    ? `Pull request ${numbered(numbers)}, opened from this Mac for a shared setting,`
    : `Pull requests ${numbered(numbers)}, opened from this Mac for shared settings,`;
  const open = read ? (one ? "is still open" : "are still open") : "may still be open";
  const close = one
    ? `Close it there if it is no longer wanted.`
    : `Close them there if they are no longer wanted.`;
  return `${subject} ${open} on GitHub. ${close}`;
}

/** Round 3 (owner, 2026-11-09): the settings pull requests of this computer
 *  that *Stop sharing* closed, once the file was really off the branch.
 *  Empty when it closed none. */
export function closedLine(numbers: readonly number[] | undefined): string {
  if (!numbers || numbers.length === 0) return "";
  return numbers.length === 1
    ? `Pull request ${numbered(numbers)}, opened from this Mac for a shared setting, was closed.`
    : `Pull requests ${numbered(numbers)}, opened from this Mac for shared settings, were closed.`;
}

// ── The row ───────────────────────────────────────────────────────────

export interface SharedSetupRowView {
  hint: string;
  /** What the row offers: one button, the notice's two, or none. */
  action: "stop" | "openPullRequest" | "shareAgain" | "choose" | "propose" | null;
  /** The button is drawn and can't be pressed (offline). */
  disabled?: boolean;
  /** `openPullRequest`: which. */
  pullRequest?: number;
  /** `propose`: the button's words when they aren't "Propose it again". */
  label?: string;
}

/** The "Shared setup" row, or null for a project that never shared. */
export function sharedSetupRow(
  setup: SharedSetup | null | undefined,
  repository: string | null,
  opts: { offline: boolean; nowSecs: number },
): SharedSetupRowView | null {
  if (!setup) return null;
  const repo = repository ?? "this repository";
  switch (setup.state) {
    case "shared": {
      // WALKFIX-1: a file that can't be used is said first, not "shared".
      if (setup.unreadable) {
        return {
          hint: unreadableSetupLine(setup.unreadable, setup.branch, true),
          action: setup.readOnly ? null : "stop",
          disabled: opts.offline,
        };
      }
      const where = `This project's setup is shared: ${FILE} on ${setup.branch}, in ${repo}.`;
      if (setup.readOnly) {
        const who = setup.author ? ` Ask ${setup.author}.` : "";
        return { hint: `${where} Stopping needs write access to ${repo}.${who}`, action: null };
      }
      if (setup.pullRequest) {
        return {
          hint:
            `Still shared: stopping waits in pull request #${setup.pullRequest.number}. ` +
            `${setup.branch} refused a direct push; the setup stays shared until that pull request merges.`,
          action: "openPullRequest",
          pullRequest: setup.pullRequest.number,
        };
      }
      if (opts.offline) {
        return {
          hint: `${where} Can't be stopped while offline — Plyloft needs the repository.`,
          action: "stop",
          disabled: true,
        };
      }
      return {
        hint: `${where} Everyone who opens this repository gets it, and a change published from one computer reaches the others.`,
        action: "stop",
      };
    }
    case "removed": {
      const lead = setup.who
        ? `The shared setup was removed from ${setup.branch} by ${setup.who}${setup.at != null ? ` ${ago(opts.nowSecs, setup.at)}` : ""}.`
        : `The shared setup is no longer on ${setup.branch}.`;
      const open = leftOpenLine(setup.leftOpen);
      return {
        hint: `${lead} This Mac still has the values it read last.${open ? ` ${open}` : ""}`,
        action: setup.readOnly ? null : "choose",
      };
    }
    case "waiting":
      return {
        hint: `${sharingWaitsLine(setup.pullRequest.number)} ${setup.branch} refused a direct push; the setup is shared once that pull request merges.`,
        action: "openPullRequest",
        pullRequest: setup.pullRequest.number,
      };
    case "olderFile":
      return {
        hint: `This project's setup is in its older file. Plyloft can't read this folder's whole history, so it doesn't move it to ${FILE} by itself.`,
        action: setup.readOnly ? null : "propose",
        label: PROPOSE_MOVING,
      };
    case "declined":
      return {
        hint: declinedNotice(setup.pullRequest, setup.who).body,
        action: setup.readOnly ? null : "propose",
      };
    case "notShared": {
      const kept = "Not shared: this project's setup is kept on this Mac.";
      const who = setup.here ? "You" : setup.who;
      const open = leftOpenLine(setup.leftOpen);
      return {
        hint: `${who ? `${kept} ${who} stopped sharing it on ${dayOf(setup.at)}.` : kept}${open ? ` ${open}` : ""}`,
        action: setup.readOnly ? null : "shareAgain",
      };
    }
  }
}

// ── The sheets ────────────────────────────────────────────────────────

/** What `confirmSheet` takes (`store/confirmStore.ts::ConfirmRequest`). */
export interface SheetWords {
  title: string;
  body: string;
  items?: string[];
  /** A sentence under the list; with it the body leads (the sheet's order:
   *  what happens, the points, then this). */
  note?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** The one filled button is the red one; focus on the other. */
  destructive?: boolean;
  /** Focus on the declining button. */
  focusCancel?: boolean;
}

/** "Stop sharing this project's setup?" — focus on "Keep sharing". */
export function stopSharingSheet(branch: string, pending: readonly string[]): SheetWords {
  const items = [
    "Each computer keeps the values it has now, as its own. From then on, a change made on one doesn't reach the others.",
    "Your teammates see that the shared setup was removed, and choose to keep theirs or share it again.",
    "The Board and its cards stay where they are.",
  ];
  if (pending.length > 0) {
    items.push(
      `${pending.length} ${changesWord(pending.length)} not published yet ${pending.length === 1 ? "stays" : "stay"} on this Mac: ${pending.map(fieldLabel).join(", ")}.`,
    );
  }
  return {
    title: "Stop sharing this project's setup?",
    body: `Plyloft removes ${FILE} from ${branch} on GitHub, in one small commit. It stays in that branch's history.`,
    items,
    note: `If ${branch} doesn't take a direct push, the removal goes as a pull request, and the setup stays shared until it merges.`,
    confirmLabel: "Stop sharing",
    cancelLabel: "Keep sharing",
    destructive: true,
  };
}

/** "Share this project's setup again?" — focus on "Not now". */
export function shareAgainSheet(
  setup: SharedSetup | null | undefined,
  repository: string | null,
  nowSecs: number,
): SheetWords {
  let stopped = "";
  if (setup?.state === "notShared" && setup.here) {
    stopped = `You stopped sharing it on ${dayOf(setup.at)}. `;
  } else if ((setup?.state === "notShared" || setup?.state === "removed") && setup.who) {
    stopped = `${setup.who} stopped sharing it${setup.at != null ? ` ${ago(nowSecs, setup.at)}` : ""}. `;
  }
  return {
    title: "Share this project's setup again?",
    body:
      `${stopped}Sharing again commits ${FILE} to ${repository ?? "the repository"} ` +
      "with this Mac's name, color and project settings, for everyone who opens the repository.",
    confirmLabel: "Share it again",
    cancelLabel: "Not now",
    focusCancel: true,
  };
}

// ── The Board's notice ────────────────────────────────────────────────

/** "The shared setup was removed from {branch}": title and body. */
export function removedNotice(
  action: { branch: string; who: string | null; at: number | null; pending: number },
  nowSecs: number,
): { title: string; body: string } {
  const still = "This Mac still has the values it read last. Plyloft changes nothing until you choose.";
  const waiting =
    action.pending > 0
      ? ` Your ${action.pending === 1 ? "change" : `${action.pending} changes`} not published yet ${action.pending === 1 ? "stays" : "stay"} on this Mac.`
      : "";
  if (!action.who) {
    return {
      title: `The shared setup is no longer on ${action.branch}`,
      body: `${FILE} was there when this Mac last read it. ${still}${waiting}`,
    };
  }
  const when = action.at != null ? ` ${ago(nowSecs, action.at)}` : "";
  return {
    title: `The shared setup was removed from ${action.branch}`,
    body: `${action.who} removed ${FILE}${when}. ${still}${waiting}`,
  };
}

/** 1.175.0 (C2, SC-1): "The shared setup stays in its older file" — the
 *  conversion's pull request was closed without merging, and Plyloft won't
 *  open another by itself. The notice (shown once) and the row's sentence. */
export function declinedNotice(pullRequest: number, who: string | null): { title: string; body: string } {
  const closed = who ? `and ${who} closed it without merging` : "and it was closed without merging";
  return {
    title: "The shared setup stays in its older file",
    body:
      `Plyloft proposed moving it to ${FILE} in pull request #${pullRequest}, ${closed}. ` +
      "Plyloft won't propose it again by itself. Everything works as before on this Mac.",
  };
}

/** The shared pages' status line until the person chooses. */
export function removedStatusLine(branch: string): string {
  return `The shared setup was removed from ${branch}, so these rows are this Mac's own for now. Choose what to do in Project › General.`;
}

// ── The toasts ────────────────────────────────────────────────────────

export interface SetupToast {
  kind: "info" | "warn";
  title: string;
  body: string;
  /** The pull request its "Open pull request" opens. */
  pullRequest?: number;
  /** C4 round 2: a recorded address "Open pull request" opens as it is. */
  url?: string;
  /** Behind the toast's Details. */
  details?: string;
}

export function stoppedToast(
  branch: string,
  leftOpen?: readonly number[],
  closed?: readonly number[],
): SetupToast {
  // Named right after the close GitHub refused: read just now.
  const open = leftOpenLine(leftOpen, true);
  const shut = closedLine(closed);
  return {
    kind: "info",
    title: "Stopped sharing this project's setup",
    body: `Removed ${FILE} from ${branch} in one commit. This Mac keeps its values.${shut ? ` ${shut}` : ""}`,
    ...(open ? { details: open } : {}),
  };
}

export const STOP_FAILED = {
  title: "Couldn't stop sharing",
  body: "Nothing changed on GitHub, and the setup is still shared. Details has the reason.",
} as const;

/** "Keep it on this Mac" didn't land (the cache couldn't be written). */
export const KEEP_FAILED = {
  title: "Couldn't remember that",
  body: "Nothing was written to GitHub, and the choice is still open. Try again.",
} as const;

export const KEPT_LOCAL_TOAST = {
  kind: "info",
  title: "This project's setup is this Mac's own now",
  body: "Nothing was written to GitHub.",
} as const;

/** What *Stop sharing* did, as a toast. */
export function stopOutcomeToast(outcome: StopOutcome): SetupToast {
  if (outcome.kind === "stopped") return stoppedToast(outcome.branch, outcome.leftOpen, outcome.closed);
  return {
    kind: "warn",
    title: `Waiting for pull request #${outcome.number} to merge`,
    body: `${outcome.branch} refused a direct push, so Plyloft opened a pull request that removes the shared setup. It stays shared until that merges.`,
    pullRequest: outcome.number,
  };
}

/** What a refresh says once about sharing (`RefreshReport.sharing`). */
export function sharingToasts(report: {
  sharing?: SharingNote | null;
  /** For `sharedAgain`: what the read changed here, and where from. */
  changes?: readonly { label: string }[];
  branch?: string | null;
}): SetupToast[] {
  const note = report.sharing;
  if (!note) return [];
  switch (note.kind) {
    case "sharedAgain":
      return [sharedAgainToast(note, report.changes ?? [], report.branch ?? null)];
    case "stopped":
      return [stoppedToast(note.branch, note.leftOpen, note.closed)];
    case "stoppedBy":
      return [
        {
          kind: "info",
          title: note.who ? `${note.who} stopped sharing this project's setup` : "The shared setup was removed",
          body: "This Mac keeps the values it read last, as its own.",
        },
      ];
    case "removalClosed":
      return [
        {
          kind: "warn",
          title: `Pull request #${note.number} was closed without merging`,
          body: "The setup stays shared.",
        },
      ];
  }
}

/**
 * Owner, 2026-11-10: on a computer that had the setup removed, stopped or
 * kept here, a teammate's *Share it again* landing — said once, with what it
 * changed here and the board when it differs from this Mac's. Modelled on
 * "{who} changed “Name”, … From .atelier/workspace.json on {branch}." and the
 * C1 rows. It replaces the read's own change toasts (`App.tsx`).
 */
export function sharedAgainToast(
  note: Extract<SharingNote, { kind: "sharedAgain" }>,
  changes: readonly { label: string }[],
  branch: string | null,
): SetupToast {
  const parts: string[] = [];
  if (changes.length > 0) parts.push(`It changed ${listLabels(changes.map((c) => quotedLabel(c.label)))}.`);
  if (note.board === "githubIssues") parts.push("Its board is on GitHub Issues.");
  if (note.board === "local") parts.push("Its board is kept on each computer.");
  parts.push(`From ${FILE} on ${branch ?? "the integration branch"}.`);
  return {
    kind: "info",
    title: `${note.who ?? "Someone"} shared this project's setup again`,
    body: parts.join(" "),
  };
}

// ── 1.175.0 (C4, SC-4): the setup arrived from another computer first ──

/** Mirrors `workspace_definition::SharedFirst` (a publish report's
 *  `sharedFirst`). */
export interface SharedFirst {
  number: number;
  url: string;
  who: string | null;
  /** C4 round 2: closed; GitHub refused the close; or not this computer's
   *  in this repository now. */
  outcome: "closed" | "refused" | "notOurs";
}

/** The toast when this computer's creation pull request turned out not to
 *  be needed — said once: closed by Plyloft; refused by GitHub (close it
 *  there); or not this computer's in this repository now (no longer
 *  followed — its own recorded address opens, never `#N` here). */
export function sharedFirstToasts(report: { publish?: { sharedFirst?: SharedFirst | null } | null }): SetupToast[] {
  const first = report.publish?.sharedFirst;
  if (!first) return [];
  const who = first.who ?? "Someone";
  const title = `${who} shared this project's setup first`;
  switch (first.outcome) {
    case "closed":
      return [
        {
          kind: "info",
          title,
          body: `This Mac follows it now. Plyloft closed pull request #${first.number}, which it had opened from this Mac: it isn't needed any more.`,
          pullRequest: first.number,
        },
      ];
    case "refused":
      return [
        {
          kind: "warn",
          title,
          body: `This Mac follows it now. Plyloft couldn't close pull request #${first.number}, which it had opened from this Mac; close it on GitHub.`,
          pullRequest: first.number,
        },
      ];
    case "notOurs":
      return [
        {
          kind: "info",
          title,
          body: `This Mac follows it now. Pull request #${first.number}, which Plyloft had opened from this Mac, is no longer followed: it isn't in this repository as Plyloft left it.`,
          url: first.url,
        },
      ];
  }
}
