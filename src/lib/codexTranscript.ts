/**
 * The transcript of a `codex-chat` tile.
 *
 * v1.102.0 pushed one entry per protocol notification: every chunk of command
 * output became its own React node and re-triggered a smooth scroll, so a
 * `cargo build` produced thousands of nodes and thousands of scroll
 * animations, and nothing ever bounded the list.
 *
 * Entries here accumulate against the protocol's *item* id instead. Deltas
 * for the same item extend one entry; the item's completion freezes it.
 * Pure functions, no React and no clock — the caller supplies ids.
 */

export type TranscriptRole = "user" | "assistant" | "activity" | "error";

export type TranscriptEntry = {
  id: string;
  role: TranscriptRole;
  text: string;
  /** The protocol item this entry accumulates, when it has one. */
  itemId?: string;
  /** False while the item is still streaming; true once it completed. */
  done?: boolean;
};

/** Roughly a long session's worth of output; beyond it, the head is dropped. */
export const TRANSCRIPT_CAP = 2000;

export const TRIM_MARKER_ID = "codex-transcript-trimmed";
export const TRIM_MARKER_TEXT = "…older output trimmed";

const TRIM_MARKER: TranscriptEntry = {
  id: TRIM_MARKER_ID,
  role: "activity",
  text: TRIM_MARKER_TEXT,
  done: true,
};

/**
 * Keeps the newest `cap` entries. Trimming is visible: a single marker sits
 * at the head so the reader knows the transcript is not the whole story.
 */
export function capEntries(
  entries: TranscriptEntry[],
  cap: number = TRANSCRIPT_CAP,
): TranscriptEntry[] {
  if (cap < 1) return [TRIM_MARKER];
  if (entries.length <= cap) return entries;
  const kept = entries.slice(entries.length - (cap - 1));
  return [TRIM_MARKER, ...kept.filter((entry) => entry.id !== TRIM_MARKER_ID)];
}

export function pushEntry(
  entries: TranscriptEntry[],
  entry: TranscriptEntry,
  cap: number = TRANSCRIPT_CAP,
): TranscriptEntry[] {
  if (!entry.text) return entries;
  return capEntries([...entries, entry], cap);
}

/** The newest still-streaming entry for an item, or -1. */
function openIndexFor(entries: TranscriptEntry[], itemId: string): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.itemId === itemId) return entry.done ? -1 : i;
  }
  return -1;
}

/**
 * Extends the open entry for `itemId`, or opens one. This is what keeps a
 * long command's output in a single node instead of one node per chunk.
 */
export function appendDelta(
  entries: TranscriptEntry[],
  itemId: string,
  role: TranscriptRole,
  delta: string,
  newId: string,
  cap: number = TRANSCRIPT_CAP,
): TranscriptEntry[] {
  if (!delta) return entries;
  const index = openIndexFor(entries, itemId);
  if (index < 0) {
    return pushEntry(entries, { id: newId, role, text: delta, itemId }, cap);
  }
  const next = [...entries];
  next[index] = { ...next[index], text: next[index].text + delta };
  return next;
}

/**
 * Replaces the open entry's text without closing it — for items that are
 * re-sent whole on every update (a file-change patch) rather than streamed
 * as deltas.
 */
export function replaceEntry(
  entries: TranscriptEntry[],
  itemId: string,
  role: TranscriptRole,
  text: string,
  newId: string,
  cap: number = TRANSCRIPT_CAP,
): TranscriptEntry[] {
  if (!text) return entries;
  const index = openIndexFor(entries, itemId);
  if (index < 0) {
    return pushEntry(entries, { id: newId, role, text, itemId }, cap);
  }
  const next = [...entries];
  next[index] = { ...next[index], text };
  return next;
}

/**
 * Freezes an item with the server's authoritative text.
 *
 * When no delta ever arrived — a turn that did not stream, which v1.102.0
 * rendered as an empty transcript — the entry is created here instead.
 */
export function completeEntry(
  entries: TranscriptEntry[],
  itemId: string,
  role: TranscriptRole,
  text: string,
  newId: string,
  cap: number = TRANSCRIPT_CAP,
): TranscriptEntry[] {
  const index = openIndexFor(entries, itemId);
  if (index < 0) {
    return pushEntry(
      entries,
      { id: newId, role, text, itemId, done: true },
      cap,
    );
  }
  const next = [...entries];
  next[index] = { ...next[index], text: text || next[index].text, done: true };
  return next;
}

/**
 * Freezes an item without replacing its text — command output is already
 * complete in the entry. `suffix` carries a closing note (a non-zero exit).
 */
export function finishEntry(
  entries: TranscriptEntry[],
  itemId: string,
  suffix?: string,
): TranscriptEntry[] {
  const index = openIndexFor(entries, itemId);
  if (index < 0) return entries;
  const next = [...entries];
  const entry = next[index];
  next[index] = {
    ...entry,
    text: suffix ? `${entry.text}\n${suffix}` : entry.text,
    done: true,
  };
  return next;
}

/** GH #210: the line a Stop press adds while the turn is still running. */
export const INTERRUPTING_TEXT = "Interrupting…";

/**
 * GH #210: what the "Interrupting…" line becomes once the turn is over. The
 * line says work is under way; a turn that has ended must not keep saying so
 * (ux-language: a status line says what is true now), so it is closed with
 * what happened. Only a turn Codex reports as `completed` gets other words —
 * the interrupt arrived too late, and "Interrupted." would be untrue; the
 * words match the Stop button and name no mechanism (review 1, n3).
 * Anything else — `interrupted`, `failed`, a status this client does not
 * know, or the process gone (`null`) — did stop.
 */
export function interruptOutcome(status: string | null): string {
  return status === "completed"
    ? "Finished before it could be stopped."
    : "Interrupted.";
}

/** GH #210: the same entry, in the same place, with new words. */
export function retextEntry(
  entries: TranscriptEntry[],
  id: string,
  text: string,
): TranscriptEntry[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, text } : entry));
}

/**
 * GH #211 review 1 (m3): whether a `commandExecution` item may have changed
 * files, from Codex's own reading of the command (`commandActions`: `read`,
 * `listFiles`, `search` or `unknown`). A command made only of reads, listings
 * and searches (`rg`, `sed -n`, `ls`, `cat`) changed nothing; one with an
 * `unknown` part, a kind this client does not know, or no reading at all
 * (an empty or missing list) may have.
 */
const READ_ONLY_ACTIONS = new Set(["read", "listFiles", "search"]);

export function commandMayWrite(item: Record<string, unknown>): boolean {
  const actions = item.commandActions;
  if (!Array.isArray(actions) || actions.length === 0) return true;
  return actions.some((action) => {
    const type =
      action !== null && typeof action === "object"
        ? (action as { type?: unknown }).type
        : undefined;
    return typeof type !== "string" || !READ_ONLY_ACTIONS.has(type);
  });
}
