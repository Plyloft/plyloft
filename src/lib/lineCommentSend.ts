/**
 * SL-5: Send to Builder — the card's unsent line comments, in one message,
 * into the card's Builder session. A closed session is resumed first, in
 * the same worktree (`builder_resume`, the vendor's native resume); the
 * message is then held until the Builder is at its prompt, as every
 * Plyloft message to it is. The comments are marked sent only once the
 * paste reached the terminal: a failed write, or a session that ends
 * first, leaves them unsent, to send again. The rules are here, the
 * wiring in `CardReviewPanel`, so they are tested without Tauri.
 */
import {
  composeLineCommentsMessage,
  MESSAGE_MAX_CHARS,
  unsentComments,
  type SendableComment,
} from "./lineComments.ts";

export interface LineCommentSendDeps {
  /** Take the card's one Send to Builder slot (store state, so it outlives
   *  the panel); false when a send is already under way. */
  claim(): boolean;
  /** The message is held for the prompt. */
  queued(): void;
  /** Give the slot back, however the send ended. */
  release(): void;
  /** The card's comments, read fresh. */
  comments(): SendableComment[];
  /** The card has a Builder (a session now, or one to resume). */
  hasBuilder(): boolean;
  /** The card's own session is attached to its terminal now. */
  sessionOpen(): boolean;
  /** The card records a session (its terminal may not be attached yet). */
  sessionRecorded(): boolean;
  /** Resume the closed session in the card's worktree. Rejects when it
   *  could not (the resume reports its own failure on the card). */
  resume(): Promise<void>;
  /** Wait for the card's session to attach; false when it did not in time. */
  waitForSession(): Promise<boolean>;
  /** Write the message now (at the prompt) or hold it until then; resolves
   *  once it is written, rejects when the write failed or the session
   *  ended first, null when no session is open. `onQueued` is called when
   *  it is held. */
  deliver(text: string, onQueued: () => void): Promise<void> | null;
  /** The card is being shipped: nothing is sent into it meanwhile. */
  shipping(): boolean;
  markSent(ids: string[]): Promise<void>;
  notify(kind: "info" | "warn" | "error", title: string, body: string, details?: string): void;
}

export type LineCommentSendOutcome = "sent" | "nothing" | "no-builder" | "busy" | "too-long" | "failed";

function count(n: number): string {
  return `${n} comment${n === 1 ? "" : "s"}`;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function sendLineComments(deps: LineCommentSendDeps): Promise<LineCommentSendOutcome> {
  // One send per card at a time: a second press, or a press on a card page
  // opened again while the first message is still held, sends nothing.
  if (!deps.claim()) return "busy";
  try {
    return await sendClaimed(deps);
  } finally {
    deps.release();
  }
}

async function sendClaimed(deps: LineCommentSendDeps): Promise<LineCommentSendOutcome> {
  const unsent = unsentComments(deps.comments());
  if (unsent.length === 0) return "nothing";
  if (!deps.hasBuilder()) {
    deps.notify(
      "warn",
      "This card has no Builder",
      "Line comments go to the card's Builder session. Start a build first; your comments are kept.",
    );
    return "no-builder";
  }
  if (deps.shipping()) {
    deps.notify("warn", "The card is being shipped", "Send your comments once the ship is over; they are kept.");
    return "busy";
  }
  const message = composeLineCommentsMessage(unsent);
  if (message.length > MESSAGE_MAX_CHARS) {
    deps.notify(
      "warn",
      "Too much to send in one message",
      `The comments come to ${message.length} characters; the Builder takes at most ${MESSAGE_MAX_CHARS} at once. Remove some, or comment on shorter selections, then send again.`,
    );
    return "too-long";
  }
  if (!deps.sessionOpen()) {
    if (!deps.sessionRecorded()) {
      try {
        await deps.resume();
      } catch {
        // Resume said why on the card; the comments stay unsent.
        return "failed";
      }
    }
    if (!(await deps.waitForSession())) {
      deps.notify(
        "warn",
        "The Builder session didn't open",
        "Your comments are kept, not sent. Open the session on the card, then press Send to Builder again.",
      );
      return "failed";
    }
  }
  const ids = unsent.map((c) => c.id);
  const what = count(unsent.length);
  const written = deps.deliver(message, () => {
    deps.queued();
    deps.notify("info", "Queued for the Builder", `${what} go in when the Builder is back at its prompt.`);
  });
  if (written === null) {
    deps.notify(
      "warn",
      "The Builder session is not open",
      "Your comments are kept, not sent. Resume the session, then press Send to Builder again.",
    );
    return "failed";
  }
  try {
    await written;
  } catch (e) {
    deps.notify(
      "error",
      "The comments did not reach the Builder",
      "They are kept, not sent. Press Send to Builder to send them again.",
      reason(e),
    );
    return "failed";
  }
  try {
    await deps.markSent(ids);
  } catch (e) {
    deps.notify(
      "warn",
      "Sent to the Builder, but not marked sent",
      "The Builder has them. They still show as not sent; remove them rather than send them twice.",
      reason(e),
    );
    return "sent";
  }
  deps.notify("info", "Sent to the Builder", `${what}.`);
  return "sent";
}

/** Poll until `ready()` or `timeoutMs` passes. */
export async function waitUntil(
  ready: () => boolean,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  stepMs = 100,
): Promise<boolean> {
  for (let waited = 0; ; waited += stepMs) {
    if (ready()) return true;
    if (waited >= timeoutMs) return false;
    await sleep(stepMs);
  }
}
