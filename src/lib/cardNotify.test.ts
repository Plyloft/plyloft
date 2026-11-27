// QoL 1.168 (F3, F5): which card moments notify, in which words, and where a
// click lands. Tier 3 pure-function test:
//   node --experimental-strip-types src/lib/cardNotify.test.ts
import assert from "node:assert/strict";
import type { InboxEvent, InboxFeed } from "../ipc";
import { cardsToNotify, collapseNotices, EMPTY_CARD_TRACKER, FRESH_MS, type CardNotice, type CardTracker } from "./cardNotify.ts";
import {
  armTarget, AUTO_OPEN_MS, decideOnFocus, dropTarget, personAway, sessionTarget, takeOnFocus, TARGET_MS,
} from "./notifyTarget.ts";
import { admit, BURST_MAX, BURST_MS, CARD_COOLDOWN_MS, EMPTY_GATE, flushGate, heldWords, type Gate } from "./notifyGate.ts";

const now = 10_000_000;
const ev = (id: string, over: Partial<InboxEvent> = {}): InboxEvent =>
  ({
    id, kind: "review_needed", group: "needs_you", workspaceId: "ws", workspaceName: "api", cardId: "c1",
    runId: null, title: "Login fix", detail: null, url: null, at: now - 1_000, seenAt: null, seenEligible: true, ...over,
  }) as InboxEvent;
const feed = (events: InboxEvent[]) => ({ events }) as unknown as InboxFeed;
const name = () => "api";
const loaded = new Set(["ws"]);

// The first look records; a row that appears later notifies once.
{
  let t: CardTracker = EMPTY_CARD_TRACKER;
  let r = cardsToNotify(t, null, null, now, name);
  assert.equal(r.next.ids, null, "no feed: no first look yet");
  r = cardsToNotify(t, feed([ev("review:c1:b1-1")]), null, now, name);
  assert.deepEqual(r.notify, [], "already there is not news");
  t = r.next;
  r = cardsToNotify(t, feed([ev("review:c1:b1-1"), ev("changes:c2:b1-2", { cardId: "c2", title: "Search", detail: "changes requested — needs you" })]), null, now, name);
  assert.deepEqual(r.notify.map((n) => [n.cardId, n.title, n.body]), [["c2", "Changes requested", "api · Search"]]);
  t = r.next;
  r = cardsToNotify(t, feed([ev("review:c1:b1-1"), ev("changes:c2:b1-2", { cardId: "c2" })]), null, now + 1_000, name);
  assert.deepEqual(r.notify, [], "once");
}

// The card's own words when the reconcile gave them; failed and shipped.
{
  const t = cardsToNotify(EMPTY_CARD_TRACKER, feed([]), null, now, name, loaded).next;
  const ready = { ...ev("card:ready:c3:2", { cardId: "c3" }), presented: { detail: "Ready to ship · checks passed", action: "Ship it" } };
  const failed = ev("failed:c4:b2-5", { cardId: "c4", kind: "card_failed", group: "needs_you", detail: "failed" });
  const shipped = ev("ship:c5:abc", { cardId: "c5", kind: "shipped", group: "shipped", detail: "1.2.0", seenEligible: false });
  const r = cardsToNotify(t, feed([ready as InboxEvent, failed, shipped]), null, now, name, loaded);
  assert.deepEqual(r.notify.map((n) => n.title), ["Ready to ship · checks passed", inboxTitle(failed), "Shipped"]);
  assert.equal(r.notify[2].body, "api · Login fix · 1.2.0");
}
function inboxTitle(e: InboxEvent) {
  return cardsToNotify(cardsToNotify(EMPTY_CARD_TRACKER, feed([]), null, now, name).next, feed([e]), null, now, name).notify[0].title;
}

// Not: a seen row, a pull request's row (Rust tells it), an old row, the
// workspace's Board on screen, a second row of the same card in a minute.
{
  const t = cardsToNotify(EMPTY_CARD_TRACKER, feed([]), null, now, name).next;
  const quiet = [
    ev("a", { seenAt: now - 5 }),
    ev("pr-checks:c1:7:h", { kind: "pr_checks_failed", group: "needs_you" }),
    ev("b", { at: now - FRESH_MS - 1 }),
    ev("c", { at: null }),
    ev("d", { cardId: null }),
  ];
  assert.deepEqual(cardsToNotify(t, feed(quiet), null, now, name).notify, []);
  const board = { workspaceId: "ws", mode: "board", cardId: null, expandedTileId: null };
  assert.deepEqual(cardsToNotify(t, feed([ev("e")]), board, now, name).notify, []);
  assert.equal(cardsToNotify(t, feed([ev("e")]), { ...board, mode: "code" }, now, name).notify.length, 1, "another mode: told");
  const two = cardsToNotify(t, feed([ev("f"), ev("g")]), null, now, name);
  assert.equal(two.notify.length, 1, "one notice per card per look");
}

// Challenger 4: the shared gate — one card once a minute whichever notifier
// tells it; at most three banners in 30 s, the rest held and told as one.
{
  let g: Gate = EMPTY_GATE;
  const step = (key: string | null, at: number) => {
    const r = admit(g, key, at);
    g = r.next;
    return r.ok;
  };
  assert.equal(step("ws::c1", now), true, "the card notifier tells c1");
  assert.equal(step("ws::c1", now + 5_000), false, "its Builder's waiting a moment later: not again");
  assert.equal(step("ws::c1", now + CARD_COOLDOWN_MS + 1), true, "a minute later it may");
  g = EMPTY_GATE;
  const oks = [0, 1, 2, 3, 4].map((i) => step(null, now + i * 1_000));
  assert.deepEqual(oks, [true, true, true, false, false]);
  assert.equal(g.held, 2);
  assert.equal(BURST_MAX, 3);
  assert.equal(flushGate(g, now + 5_000).summary, null, "no room yet");
  const flushed = flushGate(g, now + BURST_MS + 1);
  assert.equal(flushed.summary, 2);
  assert.equal(flushed.next.held, 0);
  assert.deepEqual(heldWords(2), { title: "2 more updates", body: "Open the Inbox to see them." });
}

// A board loading at this look brings the frontend's rows for its cards:
// what already was, not news. Rust's rows of that workspace still are.
{
  const t = cardsToNotify(EMPTY_CARD_TRACKER, feed([]), null, now, name, new Set()).next;
  const late = cardsToNotify(t, feed([ev("card:ready:c3:2", { cardId: "c3" }), ev("review:c4:b1-1", { cardId: "c4" })]), null, now, name, loaded);
  assert.deepEqual(late.notify.map((n) => n.cardId), ["c4"]);
  const after = cardsToNotify(late.next, feed([ev("card:ready:c3:2", { cardId: "c3" }), ev("card:ready:c5:1", { cardId: "c5" })]), null, now, name, loaded);
  assert.deepEqual(after.notify.map((n) => n.cardId), ["c5"], "once loaded, a new one is news");
}

// A Ship batch is one notification, not five.
{
  const n = (cardId: string, title: string): CardNotice => ({ id: cardId, workspaceId: "ws", cardId, cardTitle: `Card ${cardId}`, title, body: `api · Card ${cardId}` });
  assert.equal(collapseNotices([n("a", "Shipped"), n("b", "Shipped")]).length, 2);
  const one = collapseNotices([n("a", "Shipped"), n("b", "Shipped"), n("c", "Shipped")]);
  assert.deepEqual(one, [{ title: "3 cards: 3 shipped", body: "Card a, Card b, Card c", card: null }]);
  assert.equal(collapseNotices([n("a", "Shipped"), n("b", "Changes requested"), n("c", "Shipped")])[0].title, "3 cards: 2 shipped, 1 needs you");
}

// F5 (Challenger 3): back within 20 s is the click — open; up to two
// minutes, offer it; later, nothing. The newest wins, taken once; the person
// moving on drops it. Away means hidden or not in front, not a native dialog.
{
  assert.deepEqual(sessionTarget("tile:t9", "ws", "api"), { kind: "tile", workspaceId: "ws", tileId: "t9", name: "api" });
  assert.deepEqual(sessionTarget("builder:c1", "ws"), { kind: "session", workspaceId: "ws", cardId: "c1" });
  assert.equal(sessionTarget("plan:x", "ws"), null);
  const c = (cardId: string) => ({ kind: "card" as const, workspaceId: "ws", cardId });
  armTarget(c("c1"), now);
  armTarget(c("c2"), now + 10);
  assert.deepEqual(takeOnFocus(now + 20), { kind: "open", target: c("c2") });
  assert.equal(takeOnFocus(now + 30), null, "taken once");
  assert.deepEqual(decideOnFocus({ target: c("c"), at: now }, now + AUTO_OPEN_MS), { kind: "open", target: c("c") });
  assert.deepEqual(decideOnFocus({ target: c("c"), at: now }, now + AUTO_OPEN_MS + 1), { kind: "offer", target: c("c") });
  assert.equal(decideOnFocus({ target: c("c"), at: now }, now + TARGET_MS + 1), null);
  armTarget(c("c3"), now);
  dropTarget();
  assert.equal(takeOnFocus(now + 1), null, "the person moved on");
  const doc = (hidden: boolean, focus: boolean) => ({ hidden, hasFocus: () => focus });
  assert.equal(personAway(doc(true, false), false), true, "hidden");
  assert.equal(personAway(doc(false, false), false), true, "another app in front");
  assert.equal(personAway(doc(false, true), false), false, "looking at Plyloft");
  assert.equal(personAway(doc(false, false), true), false, "in Plyloft's own file dialog");
}

console.log("cardNotify.test.ts: card notifications and their targets");
