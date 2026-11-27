// Try it TI-5 (TRY_IT_SPEC §3.2): when Try it in <project> is offered, the
// common ports' fallback, and what Code's Show localhost preview lists first.
// Run with Node 22+:
//   node --experimental-strip-types src/lib/tryProject.test.ts
import assert from "node:assert/strict";
import { emptyRun, type TryRun } from "./tryPanel.ts";
import { PROJECT_TRY_ID } from "./tryTile.ts";
import {
  newlyOpenPorts,
  portsOfOtherRuns,
  tryInProjectOffer,
  shipOffersTryInProject,
  shippedLocally,
  tryInProjectLabel,
  tryPreviewChoices,
  type ShippedCard,
} from "./tryProject.ts";

// ── The words ─────────────────────────────────────────────────────────
assert.equal(tryInProjectLabel("lyra"), "Try it in lyra");
assert.equal(tryInProjectLabel("  "), "Try it in your project");

// ── Offered after a local merge only ──────────────────────────────────
const entry = { commitSha: "abc", shippedVersion: "1.0.0", releaseKind: "local" as const, shippedAt: 1 };
const shipped = (patch: Partial<ShippedCard> = {}): ShippedCard =>
  ({ shipStatus: "shipped", shipHistory: [entry], builder: null, linkedSwarmId: null, ...patch }) as ShippedCard;
assert.equal(shippedLocally(shipped()), true, "landed here");
assert.equal(shippedLocally(shipped({ shipStatus: "unshipped" } as Partial<ShippedCard>)), false, "not shipped");
assert.equal(shippedLocally(shipped({ shipHistory: [] })), false, "no ship recorded");
const prUrl = "https://github.com/o/r/pull/9";
for (const state of ["merged", "open"] as const) {
  assert.equal(shippedLocally(shipped({ prUrl, pr: { state } as never })), false, `a ${state} pull request`);
}
assert.equal(shippedLocally(shipped({ prUrl, pr: null })), false, "a pull request shipped before SL-1");
assert.equal(shippedLocally(shipped({ prUrl, pr: { state: "closed" } as never })), true, "closed, then landed here");
assert.equal(shippedLocally(shipped({ prReview: {} as never })), false, "a pull request review");
assert.equal(shippedLocally(shipped({ kind: { type: "skill" } as never })), false, "a skill card");

// The receipt: a local merge, or a merged pull request (its merge commit,
// for the project folder's checkout to hold).
assert.deepEqual(tryInProjectOffer(shipped()), { kind: "local" });
assert.deepEqual(
  tryInProjectOffer(shipped({ prUrl, pr: { state: "merged", mergeCommit: " abc1234 " } as never })),
  { kind: "pr", mergeCommit: "abc1234" },
);
assert.equal(tryInProjectOffer(shipped({ prUrl, pr: { state: "merged" } as never })), null, "no merge commit read");
assert.equal(tryInProjectOffer(shipped({ prUrl, pr: { state: "open" } as never })), null);
assert.equal(tryInProjectOffer(shipped({ prUrl, pr: null })), null);
assert.equal(
  tryInProjectOffer(shipped({ prUrl, pr: { state: "merged", mergeCommit: "abc" } as never, kind: { type: "skill" } as never })),
  null,
  "a skill card",
);

// The Shipped toast: a merge here, not a conflict, a PR or a skill-only ship.
assert.equal(shipOffersTryInProject({ kind: "local_merge", merged: true }), true);
assert.equal(shipOffersTryInProject({ kind: "merged_live", merged: true }), false, "a go-live step rebuilds first");
assert.equal(shipOffersTryInProject({ kind: "local_merge", merged: false }), false, "a conflict");
assert.equal(shipOffersTryInProject({ kind: "pr", merged: false }), false);
assert.equal(shipOffersTryInProject({ kind: "verify_pending", merged: false }), false);
assert.equal(shipOffersTryInProject({ kind: "local_merge", merged: true, skillOnly: true }), false);

// ── The common ports' fallback ────────────────────────────────────────
assert.deepEqual(newlyOpenPorts([3000, 5173, 8080], new Set([3000])), [5173, 8080]);
assert.deepEqual(newlyOpenPorts([3000], new Set([3000])), []);
assert.deepEqual(newlyOpenPorts([3000, 5173], new Set(), new Set([5173])), [3000], "another Try session's port");

// ── Show localhost preview lists the running Try sessions first ───────
const key = (ws: string, card: string, lane = "") => `${ws}\u0000${card}\u0000${lane}`;
const running = (address: string, over: Partial<TryRun> = {}): TryRun => ({ ...emptyRun("npm run dev"), phase: "running", address, ...over });
const titles: Record<string, string> = { c1: "Dark mode", c2: "Banner" };
const titleOf = (cardId: string, lane: string | null) =>
  titles[cardId] ? `${titles[cardId]}${lane ? ` (${lane})` : ""}` : null;
const runs: Record<string, TryRun | undefined> = {
  [key("ws", "c1")]: running("http://localhost:41000/"),
  [key("ws", "c2", "b")]: running("http://127.0.0.1:41013/app"),
  [key("ws", PROJECT_TRY_ID)]: running("http://localhost:5173/"),
  [key("ws", "c3")]: running("http://localhost:41020/"), // a card that is gone
  [key("ws", "c4")]: running("https://localhost:41030/", { secure: true }),
  [key("ws", "c5")]: { ...emptyRun("npm run dev"), phase: "starting" },
  [key("ws", "c6")]: running("http://localhost:41040/", { phase: "stopped" }),
  [key("other", "c1")]: running("http://localhost:41050/"),
};
assert.deepEqual(
  tryPreviewChoices(runs, "ws", "lyra", titleOf).map((c) => [c.label, c.address]),
  [
    ["Preview lyra · localhost:5173", "http://localhost:5173/"],
    ["Preview Banner (b) · 127.0.0.1:41013", "http://127.0.0.1:41013/app"],
    ["Preview Dark mode · localhost:41000", "http://localhost:41000/"],
  ],
  "the project's first, then the cards' by title; only running, loadable, this workspace's",
);
assert.deepEqual(tryPreviewChoices({}, "ws", "lyra", titleOf), []);

// The ports other live Try sessions' addresses are on.
assert.deepEqual(
  [...portsOfOtherRuns(runs, key("ws", PROJECT_TRY_ID))].sort(),
  [41000, 41013, 41020, 41030, 41050],
  "starting or running ones with an address, the project's own left out",
);

console.log("tryProject tests passed");
