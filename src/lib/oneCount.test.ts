// 1.173.0 (F1, BI-15, owner decision 2): one count everywhere. The sidebar's
// Inbox number (`attentionCounts(...).total`), the Inbox page's Needs you
// number (`.needs`, its section count) and, for one project, the Board's
// Needs you column are built here from one fixture — every card the
// presentation table knows — and are the same number. Run with
// `node --experimental-strip-types src/lib/oneCount.test.ts`.
import assert from "node:assert/strict";
import type { InboxEvent, InboxFeed, KanbanCard } from "../ipc.ts";
import { PRESENTATION_FIXTURES, NOW } from "./cardPresentation.fixtures.ts";
import { presentAttentionGroups, presentCard, recordInboxGroup, type CardPresentation } from "./cardPresentation.ts";
import { reconcileFeed } from "./inboxReconcile.ts";
import { attentionCounts, type WaitingSession } from "./needsYou.ts";
import { inboxSectionCount } from "./inboxView.ts";
import { filterByArea, needsYouElsewhere } from "./areaPicker.ts";

const WS = "ws";

// One card per fixture, each with its own live facts (ids are the fixtures').
const entries: { card: KanbanCard; presentation: CardPresentation }[] = [];
const ids = new Set<string>();
for (const f of PRESENTATION_FIXTURES) {
  if (ids.has(f.card.id)) continue;
  ids.add(f.card.id);
  entries.push({ card: f.card, presentation: presentCard(f.card, f.live) });
}
const byId = new Map(entries.map((e) => [e.card.id, e.presentation]));
const cards = entries.map((e) => e.card);

// Rust's feed: each card's record row (`derive_card_events`; the shared
// fixtures hold Rust and `recordInboxGroup` to the same group), seen or not.
const rows: InboxEvent[] = [];
for (const [i, card] of cards.entries()) {
  const group = recordInboxGroup(card);
  if (!group) continue;
  rows.push({
    id: `review:${card.id}:manual`,
    kind: "review_needed",
    group,
    workspaceId: WS,
    workspaceName: "WS",
    cardId: card.id,
    runId: null,
    title: card.title,
    detail: null,
    url: null,
    at: NOW,
    // Every other row was seen: seen is not resolved (BI-14).
    seenAt: i % 2 === 0 ? NOW - 1 : null,
    seenEligible: true,
  });
}
const feed: InboxFeed = { generatedAt: NOW, windowDays: 14, events: rows, costRollup: [], eligibilityProof: {} as never, cardSeen: {} };

// A card whose row is its live session's has that session's row instead.
const waiting: WaitingSession[] = entries
  .filter((e) => e.presentation.inbox.sessionRow === true)
  .map((e) => ({
    id: `builder:${e.card.id}`,
    workspaceId: WS,
    agent: "Claude",
    where: e.card.title,
    since: NOW,
    target: { kind: "card", cardId: e.card.id },
  }));
const waitingKeys = new Set(waiting.map((s) => `${WS}::${(s.target as { cardId: string }).cardId}`));
const reconciled = reconcileFeed({ feed, loaded: new Map([[WS, entries]]), waitingCards: waitingKeys });

const board = presentAttentionGroups(cards, (c) => byId.get(c.id)!)["needs-you"].length;
const counts = attentionCounts(reconciled, waiting);
const inboxNeedsRows = (reconciled?.events ?? []).filter((e) => e.group === "needs_you").length + waiting.length;

assert.ok(board > 10, `the fixture has many Needs you cards (${board})`);
assert.equal(counts.total, board, "the sidebar's Inbox number is the Board's Needs you count");
assert.equal(counts.byWorkspace[WS], board, "the switcher's number for the project too");
assert.equal(inboxNeedsRows, board, "the Inbox's Needs you rows are the Board's Needs you cards, one row each");
assert.equal(inboxSectionCount("needs_you", inboxNeedsRows, counts.needs), String(board), "the Inbox's Needs you number");

// And the same cards: every Board Needs you card has exactly one Inbox row.
const rowCards = new Map<string, number>();
for (const e of reconciled?.events ?? []) if (e.group === "needs_you" && e.cardId) rowCards.set(e.cardId, (rowCards.get(e.cardId) ?? 0) + 1);
for (const s of waiting) if (s.target.kind === "card") rowCards.set(s.target.cardId, (rowCards.get(s.target.cardId) ?? 0) + 1);
for (const card of cards) {
  const onBoard = byId.get(card.id)!.column === "needs-you";
  assert.equal(rowCards.get(card.id) ?? 0, onBoard ? 1 : 0, `${card.id}: one Inbox row exactly when the Board shows it in Needs you`);
}
// Challenger 4: with an area picked, the Board's Needs you is that area's
// cards, and its "· N in other areas" is the rest — together the Inbox's.
{
  const column = (c: KanbanCard) => byId.get(c.id)!.column;
  const withAreas = cards.map((c, i) => ({ ...c, area: i % 3 === 0 ? "site" : i % 3 === 1 ? "app" : null }));
  for (const area of ["site", "app"]) {
    const here = presentAttentionGroups(filterByArea(withAreas, area), (c) => byId.get(c.id)!)["needs-you"].length;
    assert.equal(here + needsYouElsewhere(withAreas, area, column), counts.total, `${area}: the area's Needs you and the other areas add up`);
  }
}

// The exception the guide and the tour name: the Board counts its cards; the
// Inbox also counts what has no card (a review someone asked for, a refused
// team plugin) — while unseen (Challenger 1).
{
  const other = (seenAt: number | null, kind: InboxEvent["kind"]): InboxEvent => ({
    ...rows[0],
    id: `${kind}:x`,
    kind,
    cardId: null,
    seenAt,
  });
  for (const kind of ["pr_review", "team_plugin_refused", "run_failed", "skill_needs_ok"] as const) {
    const plus = reconcileFeed({ feed: { ...feed, events: [...rows, other(null, kind)] }, loaded: new Map([[WS, entries]]), waitingCards: waitingKeys });
    assert.equal(attentionCounts(plus, waiting).total, board + 1, `${kind}, unseen: counted in the Inbox, not on the Board`);
    const seen = reconcileFeed({ feed: { ...feed, events: [...rows, other(NOW, kind)] }, loaded: new Map([[WS, entries]]), waitingCards: waitingKeys });
    assert.equal(attentionCounts(seen, waiting).total, board, `${kind}, seen: no longer counted (nothing here resolves it)`);
  }
}

// 1.174.0 (A5, P10, D4 b): a Next improvement row is News — never counted,
// seen or not, so the sidebar, the Inbox's Needs you and the Board's Needs
// you column say one number. A feed that still files it under Needs you
// (an older backend) doesn't count it either.
{
  const ni = (seenAt: number | null, group: InboxEvent["group"]): InboxEvent => ({
    ...rows[0],
    id: `next-improvement:${WS}:site:r1`,
    kind: "next_improvement_ideas",
    group,
    cardId: null,
    seenAt,
  });
  for (const group of ["news", "needs_you"] as const) {
    for (const seenAt of [null, NOW]) {
      const plus = reconcileFeed({ feed: { ...feed, events: [...rows, ni(seenAt, group)] }, loaded: new Map([[WS, entries]]), waitingCards: waitingKeys });
      assert.equal(attentionCounts(plus, waiting).total, board, `next_improvement_ideas in ${group}, ${seenAt ? "seen" : "unseen"}: not counted`);
    }
  }
}

// Challenger 2: a cold workspace (its Board not loaded) counts each card
// once, whatever Rust rowed for it.
{
  const cold: InboxEvent[] = ["pr_checks_failed", "pr_auto_fix_stopped", "pr_changes_requested", "pr_conflict", "card_failed", "verify_failed"].map(
    (kind, i) => ({ ...rows[0], id: `cold:${i}`, kind: kind as InboxEvent["kind"], workspaceId: "cold", cardId: "c-cold", seenAt: i % 2 ? NOW : null }),
  );
  const coldFeed = reconcileFeed({ feed: { ...feed, events: cold }, loaded: new Map(), waitingCards: new Set() });
  assert.equal(attentionCounts(coldFeed, []).byWorkspace.cold, 1, "one card, one row, one count");
  assert.equal(coldFeed!.events[0].kind, "pr_checks_failed", "the failure is the row kept");
}

console.log(`oneCount: ${board} Needs you cards, one number on the Board, the sidebar and the Inbox`);
