/**
 * UX P-F (UX P1 point 8, and point 5's bypass edge case): a live Builder
 * session stopped where only the person can move it on, beside the
 * folder-trust question (`trustQuestion.ts`):
 *
 *   - `usageLimit` — Claude's usage limit, read by the backend from the
 *     Builder's own transcript (Claude's API error entry, the turn it ended)
 *     or from its limit menu on screen (`builder::session_blocks`);
 *   - `bypass` — Claude's Bypass Permissions warning, before the first
 *     session that runs without asking.
 *
 * This is how the card, the Board and the Inbox say it: one word on every
 * surface. Plyloft never answers either screen and never types "continue"
 * by itself: the person does, in the Builder session. Pure — no React, no
 * store.
 */
import { parseLaneKey } from "./buildBoth.ts";
import type { Vendor } from "./trustQuestion.ts";
import { pausedLabel } from "./deliveryWords.ts";

export type SessionBlockKind = "bypass" | "usageLimit";

/** Session key → what stops it, in which workspace (trust is
 *  `TrustAsking`'s). */
export type SessionBlocks = Record<
  string,
  { workspaceId: string; vendor: Vendor; kind: SessionBlockKind; resetsAt: string | null }
>;

/** The backend's list (`builder_session_blocks`), its non-trust kinds. */
export function sessionBlocksFrom(
  list: readonly { key: string; workspaceId: string; vendor: string; kind?: string; resetsAt?: string | null; intake?: boolean }[],
): SessionBlocks {
  const out: SessionBlocks = {};
  for (const b of list) {
    if (b.intake || (b.kind !== "bypass" && b.kind !== "usageLimit")) continue;
    out[b.key] = {
      workspaceId: b.workspaceId,
      vendor: b.vendor === "codex" ? "codex" : "claude",
      kind: b.kind,
      resetsAt: b.resetsAt?.trim() ? b.resetsAt.trim() : null,
    };
  }
  return out;
}

export function sameSessionBlocks(a: SessionBlocks, b: SessionBlocks): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(
    (k) =>
      b[k] != null &&
      b[k].vendor === a[k].vendor &&
      b[k].workspaceId === a[k].workspaceId &&
      b[k].kind === a[k].kind &&
      b[k].resetsAt === a[k].resetsAt,
  );
}

/** What stops a card's Builder: its own session's block, else either of
 *  SL-6's two builds' (build a first). Null when none is stopped. */
export function cardSessionBlock(
  cardId: string,
  blocks: SessionBlocks,
): { vendor: Vendor; kind: SessionBlockKind; resetsAt: string | null } | null {
  const own = blocks[cardId];
  if (own) return { vendor: own.vendor, kind: own.kind, resetsAt: own.resetsAt };
  let found: SessionBlocks[string] | null = null;
  for (const [key, b] of Object.entries(blocks)) {
    const lane = parseLaneKey(key);
    if (lane?.cardId !== cardId) continue;
    if (lane.lane === "a") return { vendor: b.vendor, kind: b.kind, resetsAt: b.resetsAt };
    found = b;
  }
  return found ? { vendor: found.vendor, kind: found.kind, resetsAt: found.resetsAt } : null;
}

const NAME: Record<Vendor, string> = { claude: "Claude", codex: "Codex" };

/** Rule 8's headlines (the Board's, the card's, the session's word).
 *  1.171.0 C2 (CF8): the usage limit is the fifth session word, Paused,
 *  with the time it resets when Claude said it (`pausedLabel`); this is
 *  its form when the time is not known. */
export const USAGE_LIMIT_HEADLINE = pausedLabel(null);
export const BYPASS_HEADLINE = "Asks to work without asking";

/** Whether a headline is the usage limit's, with or without its time. */
export function isPausedHeadline(headline: string): boolean {
  return headline.startsWith("Paused · your plan's limit resets");
}

/** The card's sentence while the usage limit holds it. */
export function usageLimitSentence(vendor: Vendor, resetsAt: string | null): string {
  const after = resetsAt ? `After it resets at ${resetsAt}` : "After it resets";
  return `${NAME[vendor]}'s usage limit is reached. ${after}, tell the Builder to continue.`;
}

/** The card's sentence while Claude's Bypass Permissions warning waits. */
export function bypassSentence(vendor: Vendor): string {
  return `${NAME[vendor]} asks you to accept that it works without asking. In the session, choose “Yes, I accept”. “No, exit” ends the session.`;
}

export function sessionBlockHeadline(kind: SessionBlockKind, resetsAt: string | null = null): string {
  return kind === "usageLimit" ? pausedLabel(resetsAt) : BYPASS_HEADLINE;
}

export function sessionBlockSentence(kind: SessionBlockKind, vendor: Vendor, resetsAt: string | null): string {
  return kind === "usageLimit" ? usageLimitSentence(vendor, resetsAt) : bypassSentence(vendor);
}

/** The Inbox row's words: "Claude · Paused · your plan's limit resets at
 *  3pm" · "In “<card>”"; "Claude asks to work without asking". */
export function sessionBlockWords(
  vendor: Vendor,
  kind: SessionBlockKind,
  where: string,
  resetsAt: string | null,
  /** P3: a Terminals tile is no card's Builder. */
  place: "builder" | "tile" = "builder",
): { title: string; detail: string } {
  if (kind === "usageLimit") {
    return {
      title: `${NAME[vendor]} · ${pausedLabel(resetsAt)}`,
      detail: `In “${where}”`,
    };
  }
  return {
    title: `${NAME[vendor]} asks to work without asking`,
    detail: `In “${where}” — answer it in ${place === "tile" ? "the session" : "the Builder session"}`,
  };
}
