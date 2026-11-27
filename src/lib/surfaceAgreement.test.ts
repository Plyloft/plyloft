// UX P1 point 2 (P-A), test 2: for every fixture, the Board chip, the List
// row, the card's Now box and the Inbox row are built from the SAME
// `CardPresentation`, and say one headline in one column; the Inbox's
// group and the Board's column agree (Needs you → needs you or failed;
// Working → running; Waiting → running when queued, else none; Done →
// none). The Inbox half reconciles Rust's rows — those of the shared
// fixtures (`attention.fixtures.json`) — not only the words.
// Run with Node 22+:
//   node --experimental-strip-types src/lib/surfaceAgreement.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { InboxEvent, InboxFeed, KanbanCard } from "../ipc.ts";
import {
  SHIP_CONFLICT_HEADLINE,
  SHIP_CONFLICT_INBOX_DETAIL,
  SHIP_FAILED_HEADLINE,
  boardChipOf,
  boardNextPress,
  cardLive,
  cardSessionWords,
  presentCard,
  recordInboxGroup,
  type CardPresentation,
} from "./cardPresentation.ts";
import { boardListRow } from "./boardList.ts";
import { inboxRowWords } from "./inboxView.ts";
import { cardRowId, foldWaitingIntoCardRows, onePerCard, reconcileFeed, type ReconciledEvent } from "./inboxReconcile.ts";
import { NOW, PRESENTATION_FIXTURES, fixtureCard } from "./cardPresentation.fixtures.ts";
import { attentionCounts, waitingSessions, waitingWords } from "./needsYou.ts";
import {
  BUILDER_WAITING_HOLD_MS,
  builderWaitingKey,
  holdBuilderWaiting,
  waitingBuildersByCard,
} from "./builderWaiting.ts";
import { releasingKey, releasingMap, releasingOf, shipFailureOf, shipRefusedFor, shipRefusedKey, shipRefusedSet, type ShipRefusalBlocks } from "./shipRefusal.ts";

const WS = "ws";

function feedOf(events: InboxEvent[], cardSeen: Record<string, number> = {}): InboxFeed {
  return { generatedAt: NOW, windowDays: 14, events, costRollup: [], eligibilityProof: {} as never, cardSeen };
}

/** A Rust row for a card, in its record's group (`derive_card_events`). */
function rustRow(card: KanbanCard, group: InboxEvent["group"], patch: Partial<InboxEvent> = {}): InboxEvent {
  return {
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
    seenAt: null,
    seenEligible: true,
    ...patch,
  };
}

/** The Inbox's rows for one card, after the reconciliation. */
function inboxRowsOf(card: KanbanCard, p: CardPresentation, waiting = false): ReconciledEvent[] {
  const record = recordInboxGroup(card);
  const rows = record ? [rustRow(card, record)] : [];
  const loaded = new Map([[WS, p.inbox.live ? [{ card, presentation: p }] : []]]);
  const feed = reconcileFeed({ feed: feedOf(rows), loaded, waitingCards: new Set(waiting ? [`${WS}::${card.id}`] : []) });
  return (feed?.events ?? []) as ReconciledEvent[];
}

const GROUP_OF_COLUMN = {
  // 1.173.0 (F1, one count): a Needs you card always has its Needs you row.
  "needs-you": ["needs_you"],
  "not-started": [null],
  working: ["running", null],
  // F1 (BI-7, Challenger 6): a card Plyloft's quit paused, or one in line
  // for a slot, is On hold in both.
  waiting: ["on_hold", null],
  done: [null],
} as const;

for (const f of PRESENTATION_FIXTURES) {
  const p = presentCard(f.card, f.live);
  // One presentation, four surfaces.
  const chip = boardChipOf(p);
  const row = boardListRow(f.card, p);
  const nowBox = p.presentation;
  assert.equal(chip.label, p.headline, `${f.name}: Board chip`);
  assert.equal(row.status, p.blocked ?? p.headline, `${f.name}: List row`);
  assert.equal(nowBox.label, p.headline, `${f.name}: Now box`);
  assert.equal(row.rule, p.rule, `${f.name}: List row's rule`);
  assert.deepEqual(row.run, p.dot, `${f.name}: List dot is the Board's`);
  // 1.171.0 E3 (BI-3): a Needs you card's "→ press" is the Now box's own
  // primary, word for word; no other column says one.
  const next = boardNextPress(p);
  if (p.column === "needs-you" && !p.held && !p.blocked && p.action.id === "delete-skill-card") {
    // A press that destroys something is never suggested from a tile.
    assert.equal(next, null, `${f.name}: no destroying press on the Board`);
  } else if (p.column === "needs-you" && !p.held && !p.blocked) {
    assert.equal(next, nowBox.actionLabel, `${f.name}: Board's press is Now's primary`);
  } else {
    assert.equal(next, null, `${f.name}: no press line outside Needs you`);
  }

  // The column ↔ group map.
  if (p.column) {
    assert.ok(
      (GROUP_OF_COLUMN[p.column] as readonly (string | null)[]).includes(p.inbox.group),
      `${f.name}: column ${p.column} with Inbox group ${p.inbox.group}`,
    );
    if (p.column === "waiting" && p.inbox.group === "on_hold") assert.ok(p.state === "queued" || p.state === "session-closed", f.name);
  } else {
    assert.equal(p.inbox.group, null, `${f.name}: the archive asks nothing`);
  }

  // The Inbox rows, reconciled: the card's rows are in the card's group, or
  // there are none (a live session's row stands for the card's own).
  const waiting =
    p.rule === "session-block" ||
    p.rule === "intake-trust" ||
    p.rule === "intake-stopped" ||
    // P-B: a Builder (or a build) waiting on the person has its session's row
    // — but a fix round's finished turn (1.171.0 C1), whose row is the card's.
    (f.live.session?.block == null &&
      f.live.session?.state != null &&
      p.column === "needs-you" &&
      !(p.rule === "builder-waiting" && p.inbox.sessionRow !== true));
  const rows = inboxRowsOf(f.card, p, waiting).filter((e) => e.cardId === f.card.id);
  if (p.inbox.group === null || waiting) {
    assert.deepEqual(rows, [], `${f.name}: no row of its own (none asked, or the session's row stands)`);
  } else {
    assert.ok(rows.length >= 1, `${f.name}: a row in ${p.inbox.group}`);
    for (const e of rows) assert.equal(e.group, p.inbox.group, `${f.name}: row group`);
  }
}

// ── The named disagreements, through the Inbox ─────────────────────────

const fixture = (name: string) => PRESENTATION_FIXTURES.find((f) => f.name === name)!;

{
  // A ship press that failed: Rust says "review it" (it never saw the
  // press); the row says what the Board and the card say.
  const f = fixture("a ship press failed");
  const p = presentCard(f.card, f.live);
  const rows = inboxRowsOf(f.card, p);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].group, "needs_you");
  // 1.173.0 (F1): the Board's press, not a generic Open card.
  assert.deepEqual(rows[0].presented, { detail: SHIP_FAILED_HEADLINE, action: boardNextPress(p) });
  assert.equal(rows[0].presented?.action, p.action.label);
}
{
  // UX P-A Windows walk 1: a Ship refused before anything ran — GH #88's
  // "local branch can't be updated" on the card's Ship step, or a release
  // committed here and not published — is a failed press on every surface,
  // whoever pressed it (the card page, the Ship batch, the release dialog).
  const f = fixture("a ship press failed");
  const ready = presentCard(f.card, { ...f.live, shipFailure: null });
  assert.equal(ready.headline, "Ready to ship");
  const refusal = { branch: "staging", paths: [".claude/skills/walk-rule/SKILL.md"] };
  const cases: Array<[string, ShipRefusalBlocks, boolean]> = [
    ["the local branch refused a Ship", { [WS]: { localBranch: refusal, shipStep: { cardIds: [f.card.id] }, unpublished: null } }, true],
    ["a batch's every card", { [WS]: { localBranch: refusal, shipStep: { cardIds: ["other", f.card.id] }, unpublished: null } }, true],
    ["a release not published", { [WS]: { localBranch: null, shipStep: null, unpublished: { cardIds: [f.card.id] } } }, true],
    // 1.170 walk: a release through a pull request on its way is a state of
    // the card ("Tagged" beside it), never a Ship that didn't go through…
    ...(["building", "built", "pushed", "open", "merging", "merged", "tagged"] as const).map(
      (step): [string, ShipRefusalBlocks, boolean] => [
        `a release pull request on its way (${step})`,
        { [WS]: { localBranch: null, shipStep: null, unpublished: { cardIds: [f.card.id], problem: null, pr: { step, waiting: null } } } },
        false,
      ],
    ),
    // …stopped while it was being made too (its block offers Continue)…
    ["a release pull request stopped while it was made", { [WS]: { localBranch: null, shipStep: null, unpublished: { cardIds: [f.card.id], problem: null, pr: { step: "building", waiting: "Plyloft quit" } } } }, false],
    // …but one whose record has a problem is.
    ["a release pull request with a problem", { [WS]: { localBranch: null, shipStep: null, unpublished: { cardIds: [f.card.id], problem: "tag moved", pr: { step: "tagged", waiting: null } } } }, true],
    // A Sync's own refusal: no Ship was pressed.
    ["a Sync's refusal", { [WS]: { localBranch: refusal, shipStep: null, unpublished: null } }, false],
    // The way cleared (Trash, Sync, a Ship past the check): the block is gone.
    ["the block came down", { [WS]: { localBranch: null, shipStep: { cardIds: [f.card.id] }, unpublished: null } }, false],
    ["another card's refusal", { [WS]: { localBranch: refusal, shipStep: { cardIds: ["other"] }, unpublished: null } }, false],
  ];
  for (const [name, blocks, failed] of cases) {
    const refused = shipRefusedFor(blocks, WS, f.card.id);
    assert.equal(refused, failed, name);
    assert.equal(shipRefusedSet(shipRefusedKey(blocks)).has(`${WS}::${f.card.id}`), failed, `${name}: the sources' set`);
    const p = presentCard(f.card, { ...f.live, shipFailure: shipFailureOf(null, refused) });
    if (!failed) {
      assert.equal(p.rule, ready.rule, name);
      continue;
    }
    assert.equal(p.rule, "ship-failed", name);
    assert.equal(p.headline, SHIP_FAILED_HEADLINE, name);
    assert.equal(boardChipOf(p).label, SHIP_FAILED_HEADLINE, `${name}: Board`);
    assert.equal(boardListRow(f.card, p).rule, "ship-failed", `${name}: List`);
    assert.equal(p.presentation.label, SHIP_FAILED_HEADLINE, `${name}: Now`);
    const rows = inboxRowsOf(f.card, p);
    assert.equal(rows.length, 1, name);
    assert.equal(rows[0].group, "needs_you", name);
    assert.deepEqual(rows[0].presented, { detail: SHIP_FAILED_HEADLINE, action: boardNextPress(p) }, `${name}: Inbox`);
  }
  // The page's own failed press stands as it was (its pull request repeats).
  assert.equal(shipFailureOf("pr", true), "pr");
}
{
  // 1.170 walk (Mac and Windows): from the press until the board says
  // Shipped, a card in a release through a pull request says the release —
  // at every step, on every surface — never "Ship didn't go through" (it
  // did for the whole release) nor "Ready to ship".
  const f = fixture("a ship press failed");
  const live = { ...f.live, shipFailure: null };
  const steps = ["building", "built", "pushed", "open", "merging", "merged", "tagged"] as const;
  for (const step of steps) {
    const number = step === "open" || step === "merging" || step === "merged" || step === "tagged" ? 119 : null;
    const url = number ? "https://github.com/owner/app/pull/119" : null;
    const record = { cardIds: [f.card.id], tag: "v1.0.1", problem: null, pr: { step, number, url, waiting: null } };
    const blocks: ShipRefusalBlocks = { [WS]: { localBranch: null, shipStep: null, unpublished: record } };
    assert.equal(shipRefusedFor(blocks, WS, f.card.id), false, `${step}: not a refusal`);
    // The card page's facts and the other surfaces' (the sources' map) agree.
    const releasing = releasingOf(record, f.card.id);
    assert.deepEqual(releasingMap(releasingKey(blocks)).get(`${WS}::${f.card.id}`), releasing, `${step}: the sources' map`);
    const p = presentCard(f.card, { ...live, shipFailure: shipFailureOf(null, false), releasing });
    assert.equal(p.rule, "releasing", step);
    assert.equal(p.headline, "Releasing through a pull request", step);
    assert.match(p.sentence, /^v1\.0\.1: /, step);
    assert.equal(p.action.id, url ? "release-open-github" : "inspect-ship", step);
    assert.equal(p.action.shipMode, undefined, `${step}: no Ship offered`);
    assert.equal(p.readyToShip, false, step);
    assert.equal(p.column, "working", step);
    assert.equal(p.dot.state, "running", step);
    assert.equal(boardChipOf(p).label, "Releasing through a pull request", `${step}: Board`);
    assert.equal(boardListRow(f.card, p).status, "Releasing through a pull request", `${step}: List`);
    assert.equal(p.inbox.group, "running", `${step}: Inbox`);
    // Even beside a failed press of the page's own (the press that started
    // it said so before the record came), the release is what is said.
    assert.equal(presentCard(f.card, { ...live, shipFailure: "ship-it", releasing }).rule, "releasing", `${step}: over a press`);
  }
  // A problem with its record stops the card's Ship.
  const broken = { cardIds: [f.card.id], tag: "v1.0.1", problem: "The tag moved.", pr: { step: "tagged" as const, number: 119, url: null, waiting: null } };
  const brokenBlocks: ShipRefusalBlocks = { [WS]: { localBranch: null, shipStep: null, unpublished: broken } };
  assert.equal(releasingOf(broken, f.card.id), null);
  assert.equal(releasingKey(brokenBlocks), "");
  assert.equal(shipRefusedFor(brokenBlocks, WS, f.card.id), true);
  assert.equal(presentCard(f.card, { ...live, shipFailure: shipFailureOf(null, true), releasing: null }).rule, "ship-failed");
  // Another card's release says nothing of this one.
  assert.equal(releasingOf({ cardIds: ["other"], tag: "v1.0.1", problem: null, pr: { step: "merging", number: 1, url: null, waiting: null } }, f.card.id), null);
  // The end: the record goes and the board says Shipped (the backend sends
  // the board first, `release_pr_tests::the_record_never_goes_before_the_board_says_shipped`).
  const shipped = presentCard({ ...f.card, shipStatus: "shipped", shippedVersion: "1.0.1", commitSha: "abc" } as KanbanCard, { ...live, releasing: null });
  assert.notEqual(shipped.rule, "ship-failed");
  assert.notEqual(shipped.rule, "releasing");
}
{
  // A card with no Rust row whose ship press failed gets its own row, with
  // a stable id kept in the seen file; Mark all seen marks it.
  const f = fixture("a ship press failed");
  const p = presentCard(f.card, f.live);
  const loaded = new Map([[WS, [{ card: f.card, presentation: p }]]]);
  const feed = reconcileFeed({ feed: feedOf([]), loaded, waitingCards: new Set() })!;
  assert.equal(feed.events.length, 1);
  assert.equal(feed.events[0].id, cardRowId(f.card, "ship-failed"));
  assert.equal(feed.events[0].id, "card:ship-failed:ship-failed:0");
  assert.equal(feed.events[0].seenAt, null);
  // Its seen marker is kept (the same seen file); a card's row counts on.
  const seen = reconcileFeed({ feed: feedOf([], { "card:ship-failed:ship-failed:0": 5 }), loaded, waitingCards: new Set() })!;
  assert.equal(seen.events[0].seenAt, 5);
  assert.equal(attentionCounts(seen, []).needs, 1, "seen is not resolved");
}
{
  // Changes sent to the Builder: Rust's "review it" row is hidden and not
  // counted; the Board says Working.
  const f = fixture("changes sent to the Builder");
  const p = presentCard(f.card, f.live);
  assert.equal(recordInboxGroup(f.card), "needs_you");
  assert.deepEqual(inboxRowsOf(f.card, p), []);
}
{
  // A Builder at the trust question: one row, the session's — Rust's
  // Running row for it is not a second one.
  const f = fixture("its Builder asks to trust the folder");
  const p = presentCard(f.card, f.live);
  assert.equal(recordInboxGroup(f.card), "running");
  assert.deepEqual(inboxRowsOf(f.card, p, true), []);
}
{
  // The Challenger reviewing: Working on the Board, Running in the Inbox,
  // in the card's words — not "The work is done · review it".
  const f = fixture("Reviewing");
  const p = presentCard(f.card, f.live);
  const rows = inboxRowsOf(f.card, p);
  assert.equal(rows[0].group, "running");
  assert.deepEqual(rows[0].presented, { detail: "Reviewing", action: null });
}
{
  // A ship stopped on a conflict: Rust's own row, in the Board's words —
  // a cold workspace (no presentation) says it too.
  const words = inboxRowWords(rustRow(fixtureCard("c"), "needs_you", { detail: SHIP_CONFLICT_INBOX_DETAIL }));
  assert.equal(words.detail, SHIP_CONFLICT_HEADLINE);
  assert.equal(words.action, "Open card");
}
{
  // 1.170.0 (G6): a conflict met bringing in main's changes, cold, in the
  // card's words ("Conflict with main").
  const words = inboxRowWords(
    rustRow(fixtureCard("c"), "needs_you", { id: "conflict:c:manual", detail: "conflict with main" }),
  );
  assert.equal(words.detail, "Conflict with main");
  assert.equal(words.action, "Open card");
}
{
  // A cold workspace keeps Rust's rows unchanged.
  const f = fixture("changes sent to the Builder");
  const rows = [rustRow(f.card, "needs_you")];
  const feed = feedOf(rows);
  assert.equal(reconcileFeed({ feed, loaded: new Map(), waitingCards: new Set() }), feed);
}

{
  // (Challenger) Two Rust rows for one card moved into the card's group are
  // one row, not the same words twice.
  const f = fixture("Reviewing");
  const p = presentCard(f.card, f.live);
  const rows = [rustRow(f.card, "needs_you"), rustRow(f.card, "needs_you", { id: `failed:${f.card.id}:r1`, kind: "card_failed" })];
  const loaded = new Map([[WS, [{ card: f.card, presentation: p }]]]);
  const events = reconcileFeed({ feed: feedOf(rows), loaded, waitingCards: new Set() })!.events;
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0].group, p.inbox.group);
}

// ── UX P-A Mac walk: the Inbox row agrees with the Board card ──────────

{
  // Finding 2: an approved Builder card still in In progress, its session
  // open, no checks set up — the Board says "Ready to ship" (Ship it). Rust's
  // row says "The work is done · review it" (it knows only Complete cards
  // ship); the reconciled row says what the Board says, with its press.
  const card = fixtureCard("approved-in-progress", {
    columnId: "in_progress",
    lastRunStatus: "success",
    verifyStatus: "passed",
    verifyHistory: [{ status: "passed", steps: [] } as never],
    worktreePath: "/w/a",
    branchName: "card/a",
    builder: {
      vendor: "claude",
      bypass: false,
      sessionLost: false,
      ptyId: "pty-a",
      startedAt: NOW - 60_000,
      snapshots: [{ n: 1, sha: "aaaaaaaa1", at: NOW - 30_000 }],
      review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "approve", at: NOW - 1000 },
    },
  });
  const tip = { branchTip: "aaaaaaaa1", commitsSinceReview: 0 } as never;
  const p = presentCard(card, cardLive({ reviewTip: tip, now: NOW }));
  assert.equal(p.headline, "Ready to ship");
  assert.equal(p.rule, "base");
  assert.equal(recordInboxGroup(card), "needs_you");
  assert.deepEqual(
    { group: p.inbox.group, detail: p.inbox.detail, action: p.inbox.action, ship: p.inbox.ship, live: p.inbox.live },
    { group: "needs_you", detail: "Ready to ship · no checks set up", action: "Ship it", ship: true, live: true },
  );
  const rows = inboxRowsOf(card, p);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, `review:${card.id}:manual`, "Rust's row, rewritten — not a second row");
  // 1.173.0 (F1, Challenger 5): the row's press is the Board's — here the
  // result isn't read yet, so See the review, not Ship it.
  assert.deepEqual(rows[0].presented, { detail: p.headline, action: boardNextPress(p) });
  assert.equal(boardNextPress(p), "See the review");
  // Without the live tip (the Inbox read none before the fix) the Board
  // itself would say "Result ready": the row follows the tip it is given.
  const noTip = presentCard(card, cardLive({ now: NOW }));
  assert.notEqual(noTip.headline, "Ready to ship");
  assert.equal(noTip.inbox.ship, undefined);
}
{
  // Finding 2: a ship that just stopped on a conflict — Rust's old row (its
  // "review it") reads the conflict at once, before the feed brings Rust's
  // own conflict row.
  const f = fixture("a local ship stopped on a conflict");
  const p = presentCard(f.card, f.live);
  assert.equal(p.inbox.live, true);
  const rows = inboxRowsOf(f.card, p);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].presented, { detail: SHIP_CONFLICT_HEADLINE, action: boardNextPress(p) ?? "Open card" });
}
{
  // Findings 4 and 5: one presentation for the session panel's header and
  // the sidebar's session row, with the card's own dot.
  const trust = fixture("its Builder asks to trust the folder");
  const t = presentCard(trust.card, trust.live);
  assert.equal(t.dot.state, "aborted", "a question nothing moves past is amber, not a running dot");
  assert.deepEqual(cardSessionWords(t, "claude"), {
    header: "Asks to trust the folder",
    row: "Claude · asks to trust the folder",
    dot: "aborted",
    asks: true,
  });
  const conflict = fixture("a local ship stopped on a conflict");
  const c = presentCard(conflict.card, conflict.live);
  assert.deepEqual(cardSessionWords(c, "codex"), {
    header: "Ship stopped on a conflict",
    row: "Codex · ship stopped on a conflict",
    dot: "aborted",
    asks: false,
  });
  // A card whose rule does not outrank the session lets the session speak.
  const reviewing = fixture("Reviewing");
  assert.equal(cardSessionWords(presentCard(reviewing.card, reviewing.live), "claude"), null);
}

// ── The shared fixtures' Rust rows, reconciled ────────────────────────

type AttentionFixture = {
  name: string;
  lastRunStatus: KanbanCard["lastRunStatus"];
  reviewStatus: KanbanCard["reviewStatus"];
  verifyStatus: KanbanCard["verifyStatus"];
  shipStatus: KanbanCard["shipStatus"];
  columnId: KanbanCard["columnId"];
  archived: boolean;
  /** 1.169.1 (R1): the card's pull request, when the fixture has one. */
  prUrl?: string;
  pr?: KanbanCard["pr"];
  /** 1.170.0 (G6): a conflict record, when the fixture has one. */
  shipConflict?: KanbanCard["shipConflict"];
  /** 1.173.0 (F1): the card's Builder, when the fixture has one. */
  builder?: KanbanCard["builder"];
  /** 1.175.0 (D3): open questions on its issue's title or brief. */
  editConflicts?: KanbanCard["editConflicts"];
  expectedGroup: string;
};
const shared = JSON.parse(
  readFileSync(new URL("./attention.fixtures.json", import.meta.url), "utf8"),
) as AttentionFixture[];
for (const s of shared) {
  const card = fixtureCard(s.name.replace(/\s+/g, "-"), {
    lastRunStatus: s.lastRunStatus,
    reviewStatus: s.reviewStatus,
    verifyStatus: s.verifyStatus,
    shipStatus: s.shipStatus,
    columnId: s.columnId,
    archived: s.archived,
    ...(s.pr ? { pr: s.pr, prUrl: s.prUrl } : {}),
    ...(s.shipConflict ? { shipConflict: s.shipConflict } : {}),
    ...(s.builder ? { builder: s.builder } : {}),
    ...(s.editConflicts ? { editConflicts: s.editConflicts } : {}),
  });
  const p = presentCard(card, cardLive({ now: NOW }));
  // The record's group is the fixture's (Rust's `derive_card_events`).
  assert.equal(recordInboxGroup(card) ?? "none", s.expectedGroup, `${s.name}: record group`);
  const rows = s.expectedGroup === "none" ? [] : [rustRow(card, s.expectedGroup as InboxEvent["group"])];
  const loaded = new Map([[WS, p.inbox.live ? [{ card, presentation: p }] : []]]);
  const after = reconcileFeed({ feed: feedOf(rows), loaded, waitingCards: new Set() })!.events;
  const group = after[0]?.group ?? null;
  // What the Inbox shows is the card's group, whatever Rust's row said.
  assert.equal(group, p.inbox.group, `${s.name}: reconciled group`);
}

// ── P-B (point 4): a Builder waiting on the person, from waitingSessions ──
{
  // The Inbox counts the waiting Builder; the Board reads the same
  // derivation (`builderWaiting.ts`), so its column is Needs you and the
  // Inbox's group for the card is needs_you — one row, the session's.
  const card = fixtureCard("waits", {
    columnId: "in_progress",
    lastRunStatus: "running",
    worktreePath: "/w/waits",
    builder: {
      vendor: "claude",
      bypass: false,
      sessionLost: false,
      startedAt: NOW - 10 * 60_000,
      snapshots: [],
      ptyId: "pty-w",
    },
  });
  const cardOf = (ws: string, id: string) => (ws === WS && id === card.id ? card : null);
  const sessionsAt = (lastOutputAt: number, turnIdle: boolean, now: number) =>
    waitingSessions({
      tilesByWorkspace: {},
      builders: {
        [card.id]: { workspaceId: WS, ptyId: "pty-w", vendor: "claude", startedAt: NOW - 10 * 60_000, lastOutputAt, promptBoxIdle: true, turnIdle },
      },
      cardTitle: () => card.title,
      card: cardOf,
      loaded: () => true,
      now,
    });
  const at = NOW;
  const waiting = sessionsAt(at - 30_000, true, at);
  assert.equal(waiting.length, 1, "the Inbox counts it");
  assert.equal(waiting[0].session, "stopped");
  assert.equal(waitingWords(waiting[0]).title, "Claude · Your turn");
  const held = holdBuilderWaiting({}, waitingBuildersByCard(waiting), at);
  const entry = held[builderWaitingKey(WS, card.id)];
  assert.deepEqual(entry, { state: "stopped", vendor: "claude", releaseAt: null });
  const live = cardLive({ now: at, session: { vendor: entry.vendor, state: entry.state, block: null, held: false } });
  const p = presentCard(card, live);
  assert.equal(p.rule, "builder-waiting");
  assert.equal(p.headline, "Your turn");
  assert.equal(p.column, "needs-you", "Board: Needs you");
  assert.equal(p.action.id, "finish-and-check", "its one primary is Finish and check");
  assert.equal(p.inbox.group, "needs_you", "Inbox: needs you");
  const keys = new Set(waiting.filter((s) => s.target.kind === "card").map((s) => `${s.workspaceId}::${(s.target as { cardId: string }).cardId}`));
  const loaded = new Map([[WS, [{ card, presentation: p }]]]);
  const events = reconcileFeed({ feed: feedOf([rustRow(card, "running")]), loaded, waitingCards: keys })!.events;
  assert.deepEqual(events.filter((e) => e.cardId === card.id), [], "Rust's Running row folds into the session's row");

  // A Builder whose work is saved and that is only idle is not waiting:
  // the column stays Working (the Inbox leaves it out the same way).
  const saved = { ...card, lastRunStatus: "success" as const, builder: { ...card.builder!, snapshots: [{ n: 1, sha: "s1", at: at - 60_000 }] } };
  const none = waitingSessions({
    tilesByWorkspace: {},
    builders: { [card.id]: { workspaceId: WS, ptyId: "pty-w", vendor: "claude", startedAt: NOW - 10 * 60_000, lastOutputAt: at - 30_000, promptBoxIdle: true, turnIdle: true } },
    cardTitle: () => card.title,
    card: (ws, id) => (ws === WS && id === card.id ? saved : null),
    loaded: () => true,
    now: at,
  });
  assert.equal(none.length, 0);
  assert.deepEqual(holdBuilderWaiting({}, waitingBuildersByCard(none), at), {});

  // The hold: answered (output again), the card stays in Needs you for 3 s
  // while the Inbox, which reads the session itself, lists it as Running.
  const answered = holdBuilderWaiting(held, waitingBuildersByCard(sessionsAt(at + 1_000, false, at + 1_000)), at + 1_000);
  const heldEntry = answered[builderWaitingKey(WS, card.id)];
  assert.equal(heldEntry.releaseAt, at + 1_000 + BUILDER_WAITING_HOLD_MS);
  const heldP = presentCard(card, cardLive({ now: at + 1_000, session: { vendor: "claude", state: heldEntry.state, block: null, held: true } }));
  assert.equal(heldP.column, "needs-you", "held in Needs you");
  assert.equal(heldP.inbox.group, "running", "the Inbox does not hold it");
  const gone = holdBuilderWaiting(answered, new Map(), at + 1_000 + BUILDER_WAITING_HOLD_MS);
  assert.deepEqual(gone, {}, "3 s later it is back in Working");
  assert.equal(presentCard(card, cardLive({ now: at + 5_000 })).column, "working");

  // UX P-B Mac walk 3: a turn a settled scan found over, nothing submitted
  // since, is "stopped" at once — not "Building" for the rest of the ten
  // seconds of silence, while the session's header already says stopped.
  const justStopped = (patch: Record<string, unknown>, submittedAt?: number) =>
    waitingSessions({
      tilesByWorkspace: {},
      builders: {
        [card.id]: {
          workspaceId: WS,
          ptyId: "pty-w",
          vendor: "claude",
          startedAt: NOW - 10 * 60_000,
          lastOutputAt: at - 2_000,
          promptBoxIdle: true,
          turnIdle: true,
          turnIdleAt: at - 1_500,
          lastSettledScanAt: at - 1_000,
          turnIdleSettled: true,
          ...patch,
        },
      },
      cardTitle: () => card.title,
      card: cardOf,
      loaded: () => true,
      now: at,
      ...(submittedAt != null ? { submittedAt: { [card.id]: submittedAt } } : {}),
    });
  const atOnce = justStopped({});
  assert.equal(atOnce.length, 1, "waiting at once, two seconds after its last output");
  assert.equal(atOnce[0].session, "stopped");
  assert.equal(justStopped({}, at - 500).length, 0, "a submit after the scan is a new turn");
  assert.equal(justStopped({ turnIdle: false, turnIdleSettled: false }).length, 0, "a turn still running is working");
  assert.equal(justStopped({ lastSettledScanAt: undefined, turnIdleSettled: false }).length, 0, "no settled scan: its silence decides");
}

// ── UX P-B Mac walk 1: one card, one row ──────────────────────────────
{
  // The walk: the Challenger requested changes and Claude ended a turn —
  // the Inbox listed "Claude has stopped" and "Changes requested" for the
  // one card. The card's presentation decides the words: its own row.
  const requested = fixture("Reviewer requests changes (delivered)");
  const card = { ...requested.card, builder: { ...requested.card.builder!, ptyId: "pty-r" } };
  const waitingOf = (session: "stopped" | "quiet" | "question") => [
    {
      id: `builder:${card.id}`,
      workspaceId: WS,
      agent: "Claude" as const,
      where: card.title,
      since: NOW,
      target: { kind: "card" as const, cardId: card.id },
      session,
      vendor: "claude" as const,
    },
  ];
  const tile = { id: "tile:t1", workspaceId: WS, agent: "Claude" as const, where: "t1", since: NOW, target: { kind: "tile" as const, tileId: "t1" } };
  // 1.171.0 C1 (CF1): its turn over after the fixes, the card's row says
  // "Claude finished the fixes"; the session's "Claude has stopped" folds in.
  // (A message went in after the verdict: `since`.) Without that, or a
  // delivery into this session, the request's own words stay (Challenger 5).
  for (const session of ["stopped", "quiet"] as const) {
    const p = presentCard(card, { ...requested.live, session: { vendor: "claude", state: session, block: null } });
    assert.equal(p.headline, "Reviewer requests changes", session);
    assert.equal(p.inbox.sessionRow, undefined, `${session}: the card's own row speaks`);
  }
  for (const session of ["stopped"] as const) {
    const p = presentCard(card, { ...requested.live, session: { vendor: "claude", state: session, block: null, since: NOW } });
    assert.equal(p.headline, "Claude finished the fixes", session);
    const loaded = new Map([[WS, [{ card, presentation: p }]]]);
    const waiting = [...waitingOf(session), tile];
    const feed = reconcileFeed({ feed: feedOf([rustRow(card, "needs_you")]), loaded, waitingCards: new Set([`${WS}::${card.id}`]) });
    const cardRows = feed!.events.filter((e) => e.cardId === card.id);
    assert.equal(cardRows.length, 1, `${session}: the card's own row stays`);
    const folded = foldWaitingIntoCardRows(waiting, feed, loaded);
    assert.deepEqual(folded.map((s) => s.id), ["tile:t1"], `${session}: the Builder's row folds into the card's; a tile stays`);
    assert.equal(attentionCounts(feed, folded).needs, 2, `${session}: counted once (the card's row and the tile)`);
    // No row of its own (none in the feed): the session's row stays.
    const bare = reconcileFeed({ feed: feedOf([]), loaded, waitingCards: new Set([`${WS}::${card.id}`]) });
    assert.equal(foldWaitingIntoCardRows(waiting, bare, loaded).length, 2, `${session}: never lost`);
  }
  // 1.171.0 C1: gone quiet in the fix round is rule 9's — its row is the
  // session's ("Claude may be waiting for you"), Rust's folds into it.
  {
    const quiet = presentCard(card, { ...requested.live, session: { vendor: "claude", state: "quiet", block: null, since: NOW } });
    assert.equal(quiet.inbox.sessionRow, true);
    const loadedQ = new Map([[WS, [{ card, presentation: quiet }]]]);
    const feedQ = reconcileFeed({ feed: feedOf([rustRow(card, "needs_you")]), loaded: loadedQ, waitingCards: new Set([`${WS}::${card.id}`]) });
    assert.deepEqual(feedQ!.events.filter((e) => e.cardId === card.id), [], "quiet: Rust's row folds into the session's");
  }
  // A question outranks the request (Mac walk 2): the card's row is the
  // session's, and Rust's "Changes requested" folds into it.
  const asked = presentCard(card, { ...requested.live, session: { vendor: "claude", state: "question", block: null } });
  assert.equal(asked.rule, "builder-waiting");
  const loaded = new Map([[WS, [{ card, presentation: asked }]]]);
  const feed = reconcileFeed({ feed: feedOf([rustRow(card, "needs_you")]), loaded, waitingCards: new Set([`${WS}::${card.id}`]) });
  assert.deepEqual(feed!.events.filter((e) => e.cardId === card.id), [], "Rust's row folds into the session's");
  const waiting = waitingOf("question");
  assert.equal(foldWaitingIntoCardRows(waiting, feed, loaded), waiting, "the session's row stays, unchanged");
  assert.equal(waitingWords(waiting[0]).title, "Claude · Asks you something");
  assert.equal(attentionCounts(feed, waiting).needs, 1, "one row, counted once");
}

{
  // UX P-B Mac walk 2: a loaded card's Inbox row never falls back to Rust's
  // generic "The work is done · review it" with Review (UX P1's "never
  // seen"), whatever the fixture and whatever group Rust put it in.
  for (const f of PRESENTATION_FIXTURES) {
    const p = presentCard(f.card, f.live);
    for (const group of ["needs_you", "on_hold", "running"] as const) {
      const loaded = new Map([[WS, [{ card: f.card, presentation: p }]]]);
      const feed = reconcileFeed({ feed: feedOf([rustRow(f.card, group)]), loaded, waitingCards: new Set() });
      for (const ev of (feed?.events ?? []) as ReconciledEvent[]) {
        const words = ev.presented ?? inboxRowWords(ev, {});
        assert.notEqual(words.detail, "The work is done · review it", f.name);
        assert.notEqual(words.action, "Review", f.name);
      }
    }
  }
}

{
  // G5: a card merged on GitHub is Done on the Board, but while this
  // computer is behind GitHub's its Rust row (Bring this computer up to
  // date) stays in the Inbox — the Done column doesn't fold it away.
  const f = fixture("merged as a pull request");
  const card = { ...f.card, pr: { ...f.card.pr!, upToDateRefused: "You have changes that aren't in a commit" } };
  const p = presentCard(card, f.live);
  const row = rustRow(card, "needs_you", { id: "up-to-date:merged:5:h", kind: "bring_up_to_date", detail: "You have changes that aren't in a commit" });
  const loaded = new Map([[WS, [{ card, presentation: p }]]]);
  const feed = reconcileFeed({ feed: feedOf([row]), loaded, waitingCards: new Set() });
  assert.deepEqual(
    (feed?.events ?? []).map((e) => [e.kind, e.group, (e as ReconciledEvent).presented ?? null]),
    [["bring_up_to_date", "needs_you", null]],
  );
  assert.equal(inboxRowWords(row).action, "Bring this Mac up to date");
}

{
  // G7: Fix failing checks by itself stopped on the card's open pull
  // request whose checks failed. 1.173.0 (F1, one count): the card is one
  // Needs you row, in its Board card's words — the reason is on the card.
  const f = fixture("its pull request is open");
  const pr = { ...f.card.pr!, checks: "failing" as const, headSha: "h", autoFix: { heads: ["h"], stopped: { reason: "exhausted", head: "h", at: 5 } } };
  const card = { ...f.card, pr };
  const p = presentCard(card, f.live);
  const failed = rustRow(card, "needs_you", { id: "pr-checks:c:5:h", kind: "pr_checks_failed", detail: "test" });
  const stopped = rustRow(card, "needs_you", { id: "pr-autofix:c:5:h:exhausted", kind: "pr_auto_fix_stopped", detail: "exhausted" });
  const loaded = new Map([[WS, [{ card, presentation: p }]]]);
  const feed = reconcileFeed({ feed: feedOf([failed, stopped]), loaded, waitingCards: new Set() });
  const rows = (feed?.events ?? []) as ReconciledEvent[];
  assert.equal(p.column, "needs-you");
  assert.equal(rows.length, 1, JSON.stringify(rows.map((e) => [e.kind, e.group])));
  assert.equal(rows[0].presented?.detail, p.headline);
  assert.equal(rows[0].presented?.action, boardNextPress(p) ?? "Open card");
  // A cold workspace keeps Rust's own row and words.
  assert.equal(inboxRowWords(stopped, {}).detail, "Stopped fixing checks after 3 tries");
}

console.log(`surfaceAgreement: ${PRESENTATION_FIXTURES.length} fixtures on four surfaces, ${shared.length} shared Inbox rows`);

{
  // F1 (Challenger 2): a cold workspace's card is one Needs you row too —
  // Rust rows it for each thing its pull request says; the failure is kept.
  const card = fixtureCard("cold");
  const rows = [
    rustRow(card, "needs_you", { id: "pr-review:cold:5:1", kind: "pr_changes_requested" }),
    rustRow(card, "needs_you", { id: "pr-checks:cold:5:h", kind: "pr_checks_failed", detail: "test" }),
    rustRow(card, "needs_you", { id: "pr-conflict:cold:5:h", kind: "pr_conflict" }),
    rustRow(card, "needs_you", { id: "other-ws", workspaceId: "ws2", kind: "pr_conflict" }),
  ];
  const feed = reconcileFeed({ feed: feedOf(rows), loaded: new Map(), waitingCards: new Set() })!;
  assert.deepEqual(feed.events.map((e) => e.id), ["pr-checks:cold:5:h", "other-ws"]);
  assert.equal(attentionCounts(feed, []).needs, 2, "one card, one count, per workspace");
  assert.equal(onePerCard(feed.events), feed.events, "nothing more to fold");
}

{
  // F1 (Challenger 5): where the Board's press is Ship it, the row ships.
  for (const f of PRESENTATION_FIXTURES) {
    const p = presentCard(f.card, f.live);
    if (p.column !== "needs-you" || p.inbox.sessionRow) continue;
    const loaded = new Map([[WS, [{ card: f.card, presentation: p }]]]);
    const row = reconcileFeed({ feed: feedOf([rustRow(f.card, "needs_you")]), loaded, waitingCards: new Set() })!.events[0] as ReconciledEvent;
    // 1.175.0 B2 (the strings approved 2026-11-09): the one named exception.
    // The checks' OK is given on the card, where the two versions are shown:
    // the Board says "Allow and run", and the Inbox row opens the card — it
    // never carries the consent's own verb (`cardRowWords`).
    if (p.rule === "checks-ok") {
      assert.equal(boardNextPress(p), "Allow and run", `${f.name}: the Board's press`);
      assert.equal(row.presented?.action, "Open card", `${f.name}: the row opens the card`);
      assert.notEqual(row.presented?.ship, true, `${f.name}: never ships`);
      continue;
    }
    assert.equal(row.presented?.action, boardNextPress(p) ?? "Open card", `${f.name}: the Board's press`);
    assert.equal(row.presented?.ship === true, boardNextPress(p) === "Ship it", `${f.name}: ships only as the Board's Ship it`);
  }
}
