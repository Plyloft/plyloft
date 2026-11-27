// QoL 1.168 (owner D7, F6): what a tile's "needs you" means, and what the
// person looking at a card or a tile has seen. Tier 3 pure-function test:
//   node --experimental-strip-types src/lib/needsYouTiles.test.ts
import assert from "node:assert/strict";
import type { InboxEvent, InboxFeed } from "../ipc";
import { attentionCounts, tileTurnEpisode, waitingSessions, waitingWords, type WaitingTileInput } from "./needsYou.ts";
import { waitingNotification } from "./waitingNotify.ts";
import { cardRowsSeenOnScreen, tilesSeenOnScreen } from "./seenOnScreen.ts";

const now = 1_000_000;
const started = now - 120_000;
/** A Claude tile at its prompt for a minute. `turnAt`: when it last left
 *  Ready (a turn); its start when it never did. */
function tile(id: string, opts: { turnAt?: number; question?: WaitingTileInput["question"]; kind?: string } = {}): WaitingTileInput {
  const kind = opts.kind ?? "claude";
  return {
    id,
    kind: kind as never,
    label: `Tile ${id}`,
    status: "running",
    startedAt: started,
    lastOutputAt: now - 60_000,
    promptBoxIdle: true,
    question: opts.question ?? null,
    readiness: { lastOutputAt: now - 60_000, matcherIdle: true, leftReadyAt: opts.turnAt ?? started },
    // QoL 1.168 (Windows walk): a turn is the member's line, answered.
    ...(opts.turnAt != null ? { submittedAt: opts.turnAt } : {}),
  } as WaitingTileInput;
}
const rows = (tiles: WaitingTileInput[], tileSeen: Record<string, string> = {}) =>
  waitingSessions({ tilesByWorkspace: { ws: { tiles } }, builders: {}, cardTitle: () => null, now, tileSeen });
const count = (r: ReturnType<typeof rows>) => attentionCounts(null, r).total;

// A fresh tile nobody typed into is not a row and not a count.
assert.equal(tileTurnEpisode(tile("fresh"), now), null);
assert.equal(rows([tile("fresh")]).length, 0);

// A finished turn counts, until it is seen; the next turn counts again.
{
  const t = tile("t1", { turnAt: now - 90_000 });
  const episode = tileTurnEpisode(t, now)!;
  assert.ok(episode);
  const r = rows([t]);
  assert.equal(r.length, 1);
  assert.equal(r[0].episode, episode);
  assert.equal(count(r), 1);
  const seen = rows([t], { t1: episode });
  assert.equal(seen.length, 0, "a seen turn leaves the list");
  assert.equal(count(seen), 0);
  const next = tile("t1", { turnAt: now - 70_000 });
  assert.equal(count(rows([next], { t1: episode })), 1, "a new turn is news again");
}

// Mac walk: a finished turn says it finished; only a question waits for an
// answer — in the Inbox row, the stack and the notification alike.
{
  const [done] = rows([tile("t1", { turnAt: now - 90_000 })]);
  assert.deepEqual(waitingWords(done), { title: "Claude finished · see what it did", detail: "In “Tile t1”" });
  const [codex] = rows([tile("t2", { turnAt: now - 90_000, kind: "codex" })]);
  assert.equal(waitingWords(codex).title, "Codex finished · see what it did");
  const [asks] = rows([tile("q", { question: "decision" })]);
  assert.equal(waitingWords(asks).title, "Claude · Asks you something");
  assert.equal(waitingNotification({ id: "tile:t1", episode: "tile:t1@5", agent: "Claude", where: "api" }, "alpha").title, "Claude finished · see what it did");
  assert.equal(waitingNotification({ id: "tile:c", episode: "tile:c@approval:3", agent: "Codex", where: "api" }, "alpha").title, "Codex · Asks you something");
  assert.equal(waitingNotification({ id: "builder:k1", episode: "builder:k1", agent: "Claude", where: "Login" }, "alpha").title, "Claude · Asks you something");
}

// A question counts at once and stays counted, seen or not; a usage limit
// is listed grey and never counted.
{
  for (const q of ["decision", "trust", "bypass"] as const) {
    const r = rows([tile("q", { question: q })], { q: "anything" });
    assert.equal(r.length, 1, q);
    assert.equal(r[0].muted, undefined, q);
    assert.equal(count(r), 1, q);
  }
  const limit = rows([tile("l", { question: "usageLimit" })]);
  assert.equal(limit.length, 1);
  assert.equal(limit[0].muted, "usage-limit");
  assert.equal(count(limit), 0);
}

// A Codex chat: its turn's end is the episode; an approval counts.
{
  const chat = { ...tile("c", { kind: "codex-chat" }), sessionIdleSince: now - 5_000 } as WaitingTileInput;
  assert.equal(tileTurnEpisode(chat, now), `idle@${now - 5_000}`);
  assert.equal(count(rows([chat], { c: `idle@${now - 5_000}` })), 0);
  const asking = { ...chat, sessionApprovalPending: true } as WaitingTileInput;
  assert.equal(count(rows([asking], { c: `idle@${now - 5_000}` })), 1);
}

// A Builder at its usage limit is listed grey, not counted.
{
  const r = waitingSessions({
    tilesByWorkspace: {},
    builders: {},
    cardTitle: () => "Login fix",
    now,
    sessionBlocks: { c1: { workspaceId: "ws", vendor: "claude", kind: "usageLimit", resetsAt: "6pm" } as never },
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].muted, "usage-limit");
  assert.equal(attentionCounts(null, r).total, 0);
}

// On screen: the Terminals in front see their tiles' turns (only the
// expanded one when one is); Mark all seen takes every counted turn.
{
  const r = rows([tile("a", { turnAt: now - 90_000 }), tile("b", { turnAt: now - 80_000 }), tile("q", { question: "decision" })]);
  const onTerminals = { workspaceId: "ws", mode: "terminals", cardId: null, expandedTileId: null };
  assert.deepEqual(tilesSeenOnScreen(r, onTerminals).map((x) => x.tileId), ["a", "b"]);
  assert.deepEqual(tilesSeenOnScreen(r, { ...onTerminals, expandedTileId: "b" }).map((x) => x.tileId), ["b"]);
  assert.deepEqual(tilesSeenOnScreen(r, { ...onTerminals, mode: "board" }), []);
  assert.deepEqual(tilesSeenOnScreen(r, { ...onTerminals, workspaceId: "other" }), []);
  assert.deepEqual(tilesSeenOnScreen(r, null), [], "nothing is seen while Plyloft is not in front");
}

// F6: the open card page sees its card's unseen Needs you rows.
{
  const ev = (id: string, over: Partial<InboxEvent>): InboxEvent =>
    ({
      id, kind: "review_needed", group: "needs_you", workspaceId: "ws", workspaceName: "WS", cardId: "c1",
      runId: null, title: "Login fix", detail: null, url: null, at: now, seenAt: null, seenEligible: true, ...over,
    }) as InboxEvent;
  const feed = {
    events: [
      ev("changes:c1:b2-1", {}),
      ev("failed:c1:b2-1", { kind: "card_failed" }),
      ev("review:c1:b1-1", { seenAt: now - 1 }),
      ev("running:c1", { group: "running" }),
      ev("review:c2:manual", { cardId: "c2" }),
      ev("review:c1:other-ws", { workspaceId: "ws2" }),
    ],
  } as unknown as InboxFeed;
  const open = { workspaceId: "ws", mode: "board", cardId: "c1", expandedTileId: null };
  assert.deepEqual(cardRowsSeenOnScreen(feed, open), ["changes:c1:b2-1", "failed:c1:b2-1"]);
  assert.deepEqual(cardRowsSeenOnScreen(feed, { ...open, cardId: null }), []);
  assert.deepEqual(cardRowsSeenOnScreen(feed, { ...open, mode: "inbox" }), []);
  assert.deepEqual(cardRowsSeenOnScreen(feed, null), []);
}

console.log("needsYouTiles.test.ts: D7 tile attention and seen-on-screen");
