/**
 * v1.154.1 (walk G1): a Builder stopped at its CLI's own folder-trust
 * question ("Quick safety check: Is this a project you created or one you
 * trust? … Yes, I trust this folder / No, exit" — Claude Code asks it in
 * every new card worktree; Codex asks "Do you trust the contents of this
 * directory?", and 0.158 "Trust this folder? … 1. Trust and continue /
 * 2. Quit"). The session is silent-ish and reads "Working", so the card
 * stayed in Working while nothing could happen until the person answered.
 *
 * The backend reads each live session's captured output for it
 * (`builder::trust_question_pending`, card open or not); this is how the
 * card, the Board and the Inbox say it. Plyloft never answers it: the
 * person does, in the Builder session. Pure — no React, no store.
 */
import { parseLaneKey } from "./buildBoth.ts";

export type Vendor = "claude" | "codex";

/** Session key → who asks, in which workspace. `intake` (N14 walk F10):
 *  the card's intake conversation asks, keyed by the card. */
export type TrustAsking = Record<string, { workspaceId: string; vendor: Vendor; intake?: boolean }>;

export function trustAskingFrom(
  list: readonly { key: string; workspaceId: string; vendor: string; intake?: boolean; kind?: string }[],
): TrustAsking {
  const out: TrustAsking = {};
  for (const q of list) {
    // UX P-F: the backend's list carries every session block; the other
    // kinds are `sessionBlock.ts`'s.
    if (q.kind != null && q.kind !== "trust") continue;
    out[q.key] = {
      workspaceId: q.workspaceId,
      vendor: q.vendor === "codex" ? "codex" : "claude",
      ...(q.intake ? { intake: true } : {}),
    };
  }
  return out;
}

export function sameTrustAsking(a: TrustAsking, b: TrustAsking): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(
    (k) =>
      b[k] != null &&
      b[k].vendor === a[k].vendor &&
      b[k].workspaceId === a[k].workspaceId &&
      Boolean(b[k].intake) === Boolean(a[k].intake),
  );
}

const NAME: Record<Vendor, string> = { claude: "Claude", codex: "Codex" };

/** Who is asking on a card: its own Builder, else either of SL-6's two
 *  builds (Claude's first). Null when nobody is. */
export function cardTrustQuestion(cardId: string, asking: TrustAsking): Vendor | null {
  const own = asking[cardId];
  if (own) return own.vendor;
  let found: Vendor | null = null;
  for (const [key, q] of Object.entries(asking)) {
    const lane = parseLaneKey(key);
    if (lane?.cardId !== cardId) continue;
    if (lane.lane === "a") return q.vendor;
    found = q.vendor;
  }
  return found;
}

/** The card's words while it waits on the question. 1.171.0 D2 (PLAN §10,
 *  measured on Claude 2.1.311): a Yes inside a card's copy is recorded on
 *  the project's own folder, so Claude asks once per project, not once per
 *  card. Codex wasn't measured, so its words claim no "once" and name no
 *  button (Challenger). Plyloft still never answers it nor writes the CLI's
 *  config: the person chooses, in the session. */
export function trustHelper(vendor: Vendor): string {
  return vendor === "claude"
    ? "Claude asks this once for this project: the folder is your project's copy for this card. Choose “Yes, I trust this folder” in the session."
    : `${NAME[vendor]} asks whether to trust this folder. Answer it in the session.`;
}

/** N14 walk F10: the card's intake conversation waits on the question —
 *  it starts only once the person answers it in the conversation's
 *  terminal. Null when that intake is not asking. */
export function intakeTrustQuestion(cardId: string, asking: TrustAsking): Vendor | null {
  const q = asking[cardId];
  return q?.intake ? q.vendor : null;
}

/** The card's words while its intake waits on the question and the
 *  conversation is not on screen. */
export function intakeTrustHelper(vendor: Vendor): string {
  return vendor === "claude"
    ? "Claude asks this once for this project: the folder is your project. Choose “Yes, I trust this folder” in the terminal."
    : `${NAME[vendor]} asks whether to trust this folder. Answer it in the terminal.`;
}

/** The Board's and the lane's short word for it. */
export const TRUST_LABEL = "Asks to trust the folder";

/** The Inbox row's words. P-A (UX P1 point 2): the Board's and the card's
 *  word, with who asks ("Claude asks to trust the folder"). */
export function trustWords(
  vendor: Vendor,
  where: string,
  place: "builder" | "intake" | "tile" = "builder",
): { title: string; detail: string } {
  return {
    title: `${NAME[vendor]} ${TRUST_LABEL.charAt(0).toLowerCase()}${TRUST_LABEL.slice(1)}`,
    detail: `In “${where}” — answer it in ${ANSWER_IN[place]}`,
  };
}

/** Where the member answers: a Terminals tile is no card's Builder (P3 walk). */
const ANSWER_IN = {
  builder: "the Builder session",
  intake: "the conversation's terminal",
  tile: "the session",
} as const;

/** Whether any card has a live Builder session, or (N14 walk F10) an
 *  intake under way, to ask about — the poll asks the backend only then. */
export function anyLiveBuilder(
  cards: readonly {
    builder?: { ptyId?: string | null } | null;
    buildBoth?: { lanes: readonly { ptyId?: string | null }[] } | null;
    intakeStatus?: string | null;
  }[],
): boolean {
  return cards.some(
    (c) =>
      Boolean(c.builder?.ptyId) ||
      (c.buildBoth?.lanes ?? []).some((l) => Boolean(l.ptyId)) ||
      c.intakeStatus === "active",
  );
}
