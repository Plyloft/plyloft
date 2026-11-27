/**
 * G4 (launch D8): where the changes a person asks for on a card's result go —
 * "Not right" on the result, "Request changes" on rejected hunks. No new
 * swarm starts, so only a card that already ran a swarm gets a follow-up
 * swarm (`card_review_request_changes`). A Builder card's changes are pasted
 * into its Builder session — resumed first when it is closed — the way Fix
 * with the Builder and line comments go (`prFix.ts`, `lineCommentSend.ts`).
 *
 * Pure, no React and no store, so the rules and the words are tested once
 * (`reviewChanges.test.ts`).
 */
import type { KanbanCard } from "../ipc.ts";
import { sanitizeForPaste } from "./lineComments.ts";

export type ChangesRoute = "swarm" | "builder" | "none";

/** A card that ran a swarm keeps its follow-up swarm; a card with a Builder
 *  gets the changes in its session; anything else has nowhere to send them. */
export function changesRoute(card: Pick<KanbanCard, "linkedSwarmId" | "builder">): ChangesRoute {
  if (card.linkedSwarmId) return "swarm";
  if (card.builder) return "builder";
  return "none";
}

/** The words of "Not right" on the result: a Builder card's speak of its
 *  Builder; a swarm card's (and any other) of the agents, as before. */
export function notRightWords(route: ChangesRoute): { button: string; placeholder: string; title: string } {
  if (route === "builder") {
    return {
      button: "Not right — tell the Builder what's wrong",
      placeholder: "What's wrong, or what should be different? Plain words — the Builder picks it up in its session.",
      title: "Tell the Builder what's wrong; it picks it up in its session.",
    };
  }
  return {
    button: "Not right — tell them what's wrong",
    placeholder: "What's wrong, or what should be different? Plain words — the agents will pick it up.",
    title: "Tell the agents what's wrong and send it back.",
  };
}

/** The Now callout's label while the Builder has the changes. */
export const CHANGES_SENT_LABEL = "Changes sent to the Builder";
export const CHANGES_SENT_HELPER =
  "The Builder has them in its session. When it has addressed them, press Finish and check there; Ship waits until then.";

/** The number of the card's latest build snapshot, 0 without one. */
export function latestSnapshotN(card: Pick<KanbanCard, "builder">): number {
  return (card.builder?.snapshots ?? []).reduce((n, s) => Math.max(n, s.n), 0);
}

/** Like walk I4's fix round: changes went to the Builder at snapshot
 *  `sentAt` (`builderStore.changesSent`), and no newer snapshot exists yet —
 *  so Ship and Not right wait, and Now shows the Builder's session. */
export function changesSentStands(
  card: Pick<KanbanCard, "builder" | "archived">,
  sentAt: number | undefined,
): boolean {
  return sentAt !== undefined && Boolean(card.builder) && !card.archived && latestSnapshotN(card) <= sentAt;
}

/** Said when the card has neither a swarm nor a Builder. */
export const NOWHERE_FOR_CHANGES =
  "This card has no Builder to send them to. Start a build, then say what's wrong.";

/** What the Builder is told to do once it has addressed them. */
export const CHANGES_NEXT =
  "When they're addressed, say so in one line and stop; the person presses Finish and check so they are checked and reviewed again.";

export type ChangesOutcome = "sent" | "failed";

export interface ChangesDeps {
  /** `card_review_followup_message`: the changes, in the follow-up's words. */
  gather: () => Promise<string>;
  /** The card's own session is attached to its terminal now. */
  sessionOpen: () => boolean;
  /** The card records a session (its terminal may not be attached yet). */
  sessionRecorded: () => boolean;
  /** Resume the closed session in the card's worktree. */
  resume: () => Promise<void>;
  /** Open the card on its session, so its terminal is there to take it. */
  reveal: () => void;
  /** Wait for the card's session to attach; false when it didn't in time. */
  waitForSession: () => Promise<boolean>;
  /** `deliverWhenIdle`: written now at the prompt or held until then. */
  deliver: (text: string, onQueued: () => void) => Promise<void> | null;
  notify: (kind: "info" | "warn" | "error", title: string, body: string, details?: string) => void;
  /** QoL 1.168 (C2, C4): what the Builder does once it is done — the
   *  changes' `CHANGES_NEXT` unless the message says it itself (""). */
  next?: string;
  /** The toast once it is in the session; the changes' words by default. */
  sentBody?: string;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
}

/** One press: gather, find (or resume) the session, paste. Every way it
 *  stops is said. Resolves "sent" once the message is in the session. */
export async function sendChangesToBuilder(deps: ChangesDeps): Promise<ChangesOutcome> {
  let body: string;
  try {
    body = await deps.gather();
  } catch (e) {
    deps.notify("error", "Nothing was sent to the Builder", "Plyloft couldn't put the changes into words.", reason(e));
    return "failed";
  }
  const next = deps.next ?? CHANGES_NEXT;
  const message = sanitizeForPaste(next ? `${body.trim()}\n\n${next}` : body.trim());
  if (!deps.sessionOpen()) {
    if (!deps.sessionRecorded()) {
      try {
        await deps.resume();
      } catch (e) {
        deps.notify("error", "Nothing was sent to the Builder", "Its session couldn't be resumed.", reason(e));
        return "failed";
      }
    }
    deps.reveal();
    if (!(await deps.waitForSession())) {
      deps.notify(
        "warn",
        "The Builder session didn't open",
        "Nothing was sent. Resume the session on the card, then send the changes again.",
      );
      return "failed";
    }
  } else {
    deps.reveal();
  }
  const written = deps.deliver(message, () =>
    deps.notify("info", "Queued for the Builder", "The changes go in when the Builder is back at its prompt."),
  );
  if (written === null) {
    deps.notify("warn", "The Builder session is not open", "Nothing was sent. Resume the session, then send the changes again.");
    return "failed";
  }
  try {
    await written;
  } catch (e) {
    deps.notify("error", "The changes didn't reach the Builder", "Send them again.", reason(e));
    return "failed";
  }
  deps.notify("info", "Sent to the Builder", deps.sentBody ?? `The changes are in its session. ${CHANGES_NEXT}`);
  return "sent";
}

/** 1.172.0 (A1): a request to keep on the card (`laterRequests`). */
export interface LaterRequestDraft {
  text: string;
  source: "notRight" | "changes" | "chat";
}

/** 1.172.0 (A1): what the person asked, from the changes sent to the
 *  Builder: the result's Not right (no file) as its words; Request changes
 *  on a file's lines with the file named first. Empty words are dropped. */
export function laterRequestsOf(
  rejections: ReadonlyArray<{ path: string; feedback: string }>,
): LaterRequestDraft[] {
  return rejections
    .filter((r) => r.feedback.trim() !== "")
    .map((r) =>
      r.path.trim() === ""
        ? { text: r.feedback.trim(), source: "notRight" as const }
        : { text: `${r.path}: ${r.feedback.trim()}`, source: "changes" as const },
    );
}
