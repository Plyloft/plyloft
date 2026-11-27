// 1.171.0 B1: where a card's change is — the stage table, the path line,
// and the presenter's headline, column and dot at each stage. Run with
//   node --experimental-strip-types src/lib/deliveryStage.test.ts
import assert from "node:assert/strict";
import type { KanbanCard, PrStatus } from "../ipc.ts";
import { FIXES_NOT_ON_IT, deliveryHeadline, deliveryPath, deliveryStage, localShipOnGitHub, plyloftMergesPending, quitMergeCount, releasePath, shipTargetOf } from "./deliveryStage.ts";
import { DELIVERY_STAGE_WORDS, type DeliveryStage } from "./deliveryWords.ts";
import { PR_MERGES_WHEN_OPEN_LABEL, PR_OPEN_LABEL, PR_SIGN_IN_LABEL, openPrBoard, prNowFact, prShipLine } from "./prStatus.ts";
import { cardLive, presentCard } from "./cardPresentation.ts";
import { boardCardFact } from "./boardSemantics.ts";
import { machineWords } from "./platform.ts";
import { LAUNCH_LOOK_MS } from "./appStartedAt.ts";

const { JARGON } = (await import(new URL("../../scripts/ux-check.mjs", import.meta.url).href)) as {
  JARGON: [string, RegExp][];
};

const PR_URL = "https://github.com/o/r/pull/12";
const STARTED = 10_000;
/** Within the poller's first look after the launch (`LAUNCH_LOOK_MS`). */
const SOON = STARTED + 20_000;

const pr = (patch: Partial<PrStatus> = {}): PrStatus => ({
  number: 12,
  state: "open",
  checks: "pending",
  checksTotal: 5,
  checksPassed: 2,
  checksPending: 3,
  failingChecks: [],
  mergeable: "mergeable",
  reviewDecision: "none",
  openedAt: 1_000,
  checkedAt: STARTED + 2_000,
  pushedHead: "h1",
  headSha: "h1",
  ...patch,
});

const card = (patch: Partial<KanbanCard> = {}): KanbanCard => ({
  id: "c1",
  workspaceId: "ws",
  title: "Add sum",
  columnId: "in_progress",
  createdAt: 1,
  updatedAt: 1,
  lastRunStatus: "success",
  verifyStatus: "passed",
  reviewStatus: "merged",
  prUrl: PR_URL,
  pr: pr(),
  ...patch,
});

const green = { checks: "passing", checksPassed: 5, checksPending: 0, mergeState: "clean" } as const;

// The cards of every stage, with what the table says of them.
const merged = card({
  pr: pr({ state: "merged", mergedAt: 5_000, mergeCommit: "m1", ...green }),
  shipStatus: "shipped",
  shippedVersion: "1.0.0",
  shipHistory: [{ commitSha: "m1", shippedVersion: "1.0.0", releaseKind: "local", shippedAt: 5_000 }],
  columnId: "complete",
});
const landed = card({
  prUrl: null,
  pr: null,
  reviewStatus: null,
  shipStatus: "shipped",
  shippedVersion: "1.0.0",
  shipHistory: [{ commitSha: "l1", shippedVersion: "1.0.0", releaseKind: "local", shippedAt: 5_000 }],
  columnId: "complete",
});
const released = card({
  prUrl: null,
  pr: null,
  reviewStatus: null,
  shipStatus: "shipped",
  shippedVersion: "1.2.0",
  shipHistory: [{ commitSha: "r1", shippedVersion: "1.2.0", releaseKind: "github", shippedAt: 5_000 }],
  columnId: "complete",
});

const TABLE: ReadonlyArray<[string, KanbanCard, DeliveryStage | null, { shipping?: boolean }?]> = [
  ["checks running, the person merges", card(), "waitingForChecks"],
  ["GitHub's own auto-merge", card({ pr: pr({ autoMerge: true }) }), "mergesByItself"],
  ["Plyloft's own merge, read since launch", card({ pr: pr({ plyloftAutoMerge: true }) }), "plyloftMerges"],
  ["Plyloft's merge due, read since launch (it merges on that read)", card({ pr: pr({ plyloftAutoMerge: true, ...green }) }), "plyloftMerges"],
  [
    "Plyloft's merge due by a read before this launch",
    card({ pr: pr({ plyloftAutoMerge: true, ...green, checkedAt: STARTED - 60_000 }) }),
    "plyloftMergesWhenOpen",
  ],
  [
    "Plyloft's merge, checks still running when it last read before launch",
    card({ pr: pr({ plyloftAutoMerge: true, checkedAt: STARTED - 60_000 }) }),
    "plyloftMerges",
  ],
  ["merged on GitHub", merged, "shippedOnGitHub"],
  ["landed only on this Mac", landed, "shippedOnlyHere"],
  ["released (tag and GitHub release)", released, "shippedOnGitHub"],
  ["closed without merging", card({ pr: pr({ state: "closed", closedAt: 3_000 }), reviewStatus: "pending" }), null],
  ["never shipped", card({ prUrl: null, pr: null, reviewStatus: null }), null],
  ["shipping now", card({ prUrl: null, pr: null, reviewStatus: null }), "onThisMachine", { shipping: true }],
  ["shipped as a pull request before Plyloft read them back", card({ pr: null }), null],
];
for (const [name, c, want, opts] of TABLE) {
  assert.equal(deliveryStage(c, { appStartedAt: STARTED, now: SOON, ...opts }), want, name);
}
// Challenger 1: the poller's first look is over and its read changed
// nothing on the board (a write skipped, a merge GitHub didn't answer): no
// longer "merges when Plyloft is open" — what it says while open.
{
  const owed = card({ pr: pr({ plyloftAutoMerge: true, ...green, checkedAt: STARTED - 60_000 }) });
  assert.equal(deliveryStage(owed, { appStartedAt: STARTED, now: SOON }), "plyloftMergesWhenOpen");
  assert.equal(deliveryStage(owed, { appStartedAt: STARTED, now: STARTED + LAUNCH_LOOK_MS }), "plyloftMerges");
  const later = presentCard(owed, cardLive({ appStartedAt: STARTED, now: STARTED + LAUNCH_LOOK_MS + 1 }));
  assert.equal(later.headline, "Plyloft merges it while it's open on this Mac");
  assert.equal(later.column, "working");
  // Not due as merge_due has it: no commit Plyloft pushed, or the head
  // isn't reviewed — never "owed since the launch".
  const unpushed = card({ pr: pr({ plyloftAutoMerge: true, ...green, checkedAt: STARTED - 60_000, pushedHead: null }) });
  assert.equal(deliveryStage(unpushed, { appStartedAt: STARTED, now: SOON }), "plyloftMerges");
  const unreviewed = card({
    pr: pr({ plyloftAutoMerge: true, ...green, checkedAt: STARTED - 60_000 }),
    builder: { vendor: "claude", bypass: false, sessionLost: false, snapshots: [{ n: 1, sha: "h1", at: 1 }] } as never,
  });
  assert.equal(deliveryStage(unreviewed, { appStartedAt: STARTED, now: SOON }), "plyloftMerges");
}
// Without a launch time nothing is owed since one.
assert.equal(
  deliveryStage(card({ pr: pr({ plyloftAutoMerge: true, ...green, checkedAt: STARTED - 60_000 }) })),
  "plyloftMerges",
);

// ── The path line ──────────────────────────────────────────────────────
const line = (c: KanbanCard, opts = {}) => deliveryPath(c, { appStartedAt: STARTED, now: SOON, ...opts })?.line ?? null;
assert.equal(
  line(card({ pr: pr({ plyloftAutoMerge: true }) })),
  "On this Mac → On GitHub, pull request #12 · checks 2 of 5 → Next: Shipped · on GitHub",
  "walk 6a: the headline says Plyloft merges it; the path doesn't repeat it",
);
assert.equal(
  line(card({ pr: pr({ autoMerge: true }) })),
  "On this Mac → On GitHub, pull request #12 · checks 2 of 5 · GitHub merges it when they pass → Next: Shipped · on GitHub",
);
assert.equal(
  line(card({ pr: pr(green) })),
  "On this Mac → On GitHub, pull request #12 · checks passed · ready to merge → Next: Shipped · on GitHub",
);
assert.equal(
  line(card({ pr: pr({ ...green, reviewDecision: "review_required", mergeState: "blocked" }) })),
  "On this Mac → On GitHub, pull request #12 · checks passed · waiting for a review on GitHub → Next: Shipped · on GitHub",
);
assert.equal(
  line(card({ pr: pr({ plyloftAutoMerge: true, ...green, checkedAt: STARTED - 60_000 }) })),
  "On this Mac → On GitHub, pull request #12 · checks passed · Plyloft merges it on its next look at GitHub → Next: Shipped · on GitHub",
);
// 1.171.0 B walk: a shipped card's path never repeats its headline.
assert.equal(line(merged), "On this Mac → On GitHub, pull request #12 · merged");
assert.equal(line(released), "On this Mac → On GitHub");
assert.equal(line(landed), "", "an only-here ship: the headline says it, the helper says where");
assert.deepEqual(deliveryPath(landed)?.steps, []);
for (const c of [merged, released, landed]) {
  const p = deliveryPath(c)!;
  const headline = presentCard(c, cardLive({ appStartedAt: STARTED, now: SOON })).headline;
  assert.equal(p.steps[p.steps.length - 1]?.text === p.word, false, `${p.line}: the last stop isn't the headline`);
  assert.ok(!p.steps.some((s) => s.text === headline), `${p.line}: no stop says ${headline}`);
}
// 1.171.0 B walk: a fix made after the pull request opened and not sent —
// GitHub's checks and "ready to merge" are the commit before it.
{
  const snapshots = (sha: string) => ({ vendor: "codex", bypass: false, startedAt: 0, snapshots: [{ n: 1, sha: "h1", at: 1 }, { n: 2, sha, at: 2 }] }) as never;
  assert.equal(
    line(card({ pr: pr(green), builder: snapshots("h2") })),
    "On this Mac → On GitHub, pull request #12 · your latest fixes aren't on it yet → Next: Shipped · on GitHub",
  );
  // Sent: GitHub runs its checks on it again.
  assert.equal(
    line(card({ pr: pr({ ...green, pushedHead: "h2", awaitingChecks: true }), builder: snapshots("h2") })),
    "On this Mac → On GitHub, pull request #12 · GitHub is starting its checks → Next: Shipped · on GitHub",
  );
  // On it: as before.
  assert.equal(
    line(card({ pr: pr({ ...green, headSha: "h2", pushedHead: "h2" }), builder: snapshots("h2") })),
    "On this Mac → On GitHub, pull request #12 · checks passed · ready to merge → Next: Shipped · on GitHub",
  );
  // The Board and the Inbox don't say Ready to merge for it either.
  assert.notEqual(openPrBoard(card({ pr: pr(green), builder: snapshots("h2") }))?.label, "Ready to merge");
}
assert.equal(deliveryPath(landed, { target: "main" })?.helper, "main on this Mac has it; GitHub doesn't.");
assert.equal(deliveryPath(landed)?.helper, "Your main branch on this Mac has it; GitHub doesn't.");
assert.equal(line(card({ prUrl: null, pr: null, reviewStatus: null }), { shipping: true }), "On this Mac · shipping now");
// U29: a ship to GitHub isn't "on this Mac".
assert.equal(line(card({ prUrl: null, pr: null, reviewStatus: null }), { shipping: true, shippingToGitHub: true }), "On its way to GitHub");
assert.equal(line(card({ pr: pr({ state: "closed", closedAt: 3_000 }), reviewStatus: "pending" })), null);
{
  const path = deliveryPath(card())!;
  assert.deepEqual(path.steps.map((s) => s.at), ["done", "now", "next"], "one stop is the current one");
  assert.equal(path.word, "On GitHub · waiting for checks");
  assert.equal(path.signIn, false);
}

// A repository with no checks: the wait after the opening says so, then
// Plyloft merges it (no endless "waiting for checks").
{
  const none = { checks: "none", checksTotal: 0, checksPassed: 0, checksPending: 0, checksSeen: false } as const;
  assert.equal(
    line(card({ pr: pr({ ...none, awaitingChecks: true, plyloftAutoMerge: true }) })),
    "On this Mac → On GitHub, pull request #12 · no checks on GitHub · it merges after a short wait → Next: Shipped · on GitHub",
  );
  assert.equal(
    line(card({ pr: pr({ ...none, mergeState: "clean" }) })),
    "On this Mac → On GitHub, pull request #12 · no checks on GitHub · ready to merge → Next: Shipped · on GitHub",
  );
  assert.equal(
    line(card({ pr: pr({ ...none, awaitingChecks: true, checksSeen: true }) })),
    "On this Mac → On GitHub, pull request #12 · GitHub is starting its checks → Next: Shipped · on GitHub",
  );
}

// gh signed out while it waits: said, with the sign-in, never a wait.
{
  const signedOut = card({ pr: pr({ plyloftAutoMerge: true, signInNeeded: true }) });
  const path = deliveryPath(signedOut, { appStartedAt: STARTED })!;
  assert.equal(path.signIn, true);
  assert.equal(
    path.line,
    "On this Mac → On GitHub, pull request #12 · Plyloft can't read GitHub: sign in again → Next: Shipped · on GitHub",
  );
  assert.deepEqual(openPrBoard(signedOut), { label: PR_SIGN_IN_LABEL, attention: "waiting" });
  assert.equal(prNowFact(signedOut, () => "x"), "Its pull request #12 is on GitHub, but Plyloft can't read GitHub: sign in again.");
  assert.deepEqual(prShipLine(signedOut), { text: "Pull request #12 is open. Plyloft can't read GitHub: sign in again.", state: "aborted" });
  const p = presentCard(signedOut, cardLive({ appStartedAt: STARTED, now: SOON }));
  assert.equal(p.headline, PR_SIGN_IN_LABEL);
  assert.equal(p.column, "waiting");
  assert.equal(p.inbox.group, null, "On hold asks no Inbox row");
}

// ── The presenter at each stage: headline, column, dot, Board fact ─────
const live = cardLive({ appStartedAt: STARTED, now: SOON });
const PRESENTED: ReadonlyArray<[string, KanbanCard, string, string, string]> = [
  ["open, checks running", card(), "On GitHub · waiting for checks", "working", "running"],
  ["GitHub's auto-merge", card({ pr: pr({ autoMerge: true }) }), "On GitHub · merges when checks pass", "working", "running"],
  ["Plyloft merges it", card({ pr: pr({ plyloftAutoMerge: true }) }), "Plyloft merges it while it's open on this Mac", "working", "running"],
  [
    "Plyloft's merge owed since launch",
    card({ pr: pr({ plyloftAutoMerge: true, ...green, checkedAt: STARTED - 60_000 }) }),
    PR_MERGES_WHEN_OPEN_LABEL,
    "waiting",
    "done",
  ],
  ["open, nothing running", card({ pr: pr({ ...green, mergeState: "behind" }) }), PR_OPEN_LABEL, "waiting", "done"],
  ["merged on GitHub", merged, "Shipped · on GitHub", "done", "done"],
  ["landed here", landed, "Shipped · only on this Mac", "done", "done"],
  ["released", released, "Shipped · on GitHub", "done", "done"],
  ["closed", card({ pr: pr({ state: "closed", closedAt: 3_000 }), reviewStatus: "pending" }), "Pull request closed", "needs-you", "done"],
];
for (const [name, c, headline, column, dot] of PRESENTED) {
  const p = presentCard(c, live);
  assert.equal(p.headline, headline, `${name}: headline`);
  assert.equal(p.column, column, `${name}: column`);
  assert.equal(p.dot.state, dot, `${name}: dot`);
  // CP-2: never "Shipped" while its pull request is open.
  if (c.pr?.state === "open") {
    assert.ok(!/shipped/i.test(p.headline), `${name}: no "Shipped" headline while open`);
    assert.ok(!/shipped/i.test(p.sentence), `${name}: no "Shipped" sentence while open (${p.sentence})`);
  }
}
// BI-20: the Done tile says the same two facts, with its pull request or version.
assert.equal(boardCardFact(merged, "shipped", 0), "#12");
assert.equal(boardCardFact(released, "shipped", 0), "v1.2.0");
assert.equal(deliveryHeadline("plyloftMergesWhenOpen"), "On GitHub · merges when Plyloft is open");
assert.equal(deliveryHeadline("shippedOnlyHere"), "Shipped · only on this Mac");
// F3 walk (R13): after Put it on GitHub, GitHub has a commit shipped only
// here before: that card is on GitHub now (`put_on_github_sent`'s fact).
assert.equal(localShipOnGitHub(landed, new Set(["l1"])), true);
assert.equal(localShipOnGitHub(landed, new Set(["x9"])), false);
assert.equal(localShipOnGitHub(released, new Set(["r1"])), false, "not a land here");
assert.equal(deliveryStage(landed, { localShipOnGitHub: true }), "shippedOnGitHub");
assert.equal(deliveryPath(landed, { localShipOnGitHub: true, target: "main" })?.helper ?? null, null, "no \"GitHub doesn't\"");
assert.equal(presentCard(landed, cardLive({ localShipOnGitHub: true })).headline, "Shipped · on GitHub");
assert.equal(presentCard(landed, cardLive()).headline, "Shipped · only on this Mac");

// ── Words: JARGON and this PC ──────────────────────────────────────────
// 1.171.0 B2: a card in a release on its way (B1 Challenger leftover).
const releaseLines = (["building", "built", "pushed", "open", "merging", "merged", "tagged"] as const).map(
  (step) => releasePath({ tag: "v1.2.0", step, number: step === "building" || step === "built" ? null : 7 }),
);
assert.equal(releaseLines[0].line, "On this Mac · making v1.2.0 → Next: On GitHub, release pull request");
assert.equal(releaseLines[0].stage, "onThisMachine");
assert.equal(
  releaseLines[3].line,
  "On this Mac → On GitHub, release pull request #7 · merges when its checks pass → Next: Released v1.2.0",
);
// A record with no tag yet names no version (shipRefusal's fallback words).
const untagged = (step: "built" | "merged") => releasePath({ tag: "The release", step, number: step === "merged" ? 7 : null }).line;
assert.equal(untagged("built"), "On this Mac · making the release → Next: On GitHub, release pull request");
assert.equal(untagged("merged"), "On this Mac → On GitHub, release pull request #7 · merged → Tagging it → Next: Released");
assert.ok(!/The release/.test(untagged("built") + untagged("merged")));
assert.equal(releaseLines[4].line, "On this Mac → On GitHub, release pull request #7 · merging → Next: Released v1.2.0");
// 1.172.0 B3 (bfix glance): the merged stop never starts with the shipped
// headline; the last stop is the version released.
assert.equal(releaseLines[5].line, "On this Mac → On GitHub, release pull request #7 · merged → Tagging v1.2.0 → Next: Released v1.2.0");
assert.equal(releaseLines[6].line, "On this Mac → On GitHub, release pull request #7 · merged → Released v1.2.0");
assert.equal(releaseLines[6].stage, "shippedOnGitHub");
for (const p of releaseLines) assert.ok(!p.line.includes(DELIVERY_STAGE_WORDS.shippedOnGitHub), p.line);
// 1.172.0 B3: at Merging the release pull request's stop says who merges it.
const merging = (patch: { plyloftMerges?: boolean; mergeOnItsWay?: boolean }) =>
  releasePath({ tag: "v1.2.0", step: "merging", number: 7, ...patch });
assert.equal(
  merging({ plyloftMerges: true }).line,
  "On this Mac → On GitHub, release pull request #7 · Plyloft merges it when its checks pass, while it's open on this Mac → Next: Released v1.2.0",
);
assert.equal(merging({ plyloftMerges: true }).stage, "plyloftMerges");
assert.equal(
  machineWords(merging({ plyloftMerges: true }).steps[1].text, "windows"),
  "On GitHub, release pull request #7 · Plyloft merges it when its checks pass, while it's open on this PC",
);
assert.equal(
  merging({ mergeOnItsWay: true }).line,
  "On this Mac → On GitHub, release pull request #7 · GitHub merges it when its checks pass → Next: Released v1.2.0",
);
assert.equal(merging({ mergeOnItsWay: true }).stage, "mergesByItself");
// Before Merging Plyloft hasn't asked GitHub: the fact isn't said yet.
assert.equal(
  releasePath({ tag: "v1.2.0", step: "open", number: 7, plyloftMerges: true }).steps[1].text,
  "On GitHub, release pull request #7 · merges when its checks pass",
);
for (const p of [merging({ plyloftMerges: true }), merging({ mergeOnItsWay: true })]) {
  for (const [why, re] of JARGON) assert.ok(!re.test(p.line), `${why}: ${p.line}`);
}
for (const p of releaseLines) assert.equal(p.steps.filter((s) => s.at === "now").length, 1, p.line);

// 1.171.0 B2 (K4): the pull requests that wait for Plyloft's own merge.
assert.equal(
  plyloftMergesPending([
    card({ pr: pr({ plyloftAutoMerge: true }) }),
    card({ pr: pr({ plyloftAutoMerge: true, ...green, checkedAt: STARTED - 60_000 }) }),
    card({ pr: pr({ plyloftAutoMerge: true }), archived: true }),
    card({ pr: pr({ plyloftAutoMerge: true, autoMerge: true }) }),
    card({ pr: pr() }),
    merged,
    landed,
  ]),
  2,
);
assert.equal(plyloftMergesPending([]), 0);
// 1.172.0 B2: the backend's count (every workspace, releases too) wins once
// it answered; until then, or when it can't, the warmed boards'.
assert.equal(quitMergeCount(3, 1), 3);
assert.equal(quitMergeCount(0, 2), 0);
assert.equal(quitMergeCount(null, 2), 2);
assert.equal(quitMergeCount(undefined, 0), 0);

// 1.171.0 B2 (Challenger 1): the target outlives the ship, which clears
// worktreeBase — the last ship's recorded target first.
const base = { refName: "origin/main" } as KanbanCard["worktreeBase"];
assert.equal(shipTargetOf({}), null);
assert.equal(shipTargetOf({ worktreeBase: base }), "origin/main");
assert.equal(
  shipTargetOf({ shipHistory: [{ commitSha: "a", shippedVersion: "1", releaseKind: "local", shippedAt: 1, target: "develop" }] }),
  "develop",
);
assert.equal(
  shipTargetOf({ worktreeBase: base, shipHistory: [{ commitSha: "a", shippedVersion: "1", releaseKind: "local", shippedAt: 1 }] }),
  "origin/main",
  "an older entry without one: where the copy started",
);

const lines: string[] = [
  ...TABLE.flatMap(([, c, , opts]) => {
    const p = deliveryPath(c, { appStartedAt: STARTED, now: SOON, ...opts });
    return p ? [p.line, p.helper ?? ""] : [];
  }),
  ...PRESENTED.map(([, c]) => presentCard(c, live).headline),
  PR_SIGN_IN_LABEL,
  PR_MERGES_WHEN_OPEN_LABEL,
  PR_OPEN_LABEL,
  ...Object.keys(DELIVERY_STAGE_WORDS).map((s) => deliveryHeadline(s as DeliveryStage)),
  ...releaseLines.map((p) => p.line),
  FIXES_NOT_ON_IT,
];
for (const text of lines) {
  for (const [word, re] of JARGON) {
    re.lastIndex = 0;
    assert.ok(!re.test(text), `"${text}" says ${word}`);
  }
  assert.ok(!machineWords(text, "windows").includes("this Mac"), `"${text}" reads this PC on Windows`);
}
assert.equal(machineWords(deliveryHeadline("shippedOnlyHere"), "windows"), "Shipped · only on this PC");
assert.equal(machineWords(deliveryPath(landed)!.helper!, "windows"), "Your main branch on this PC has it; GitHub doesn't.");
assert.equal(machineWords(line(card({ pr: pr(green), builder: { vendor: "codex", bypass: false, startedAt: 0, snapshots: [{ n: 2, sha: "h2", at: 2 }] } as never }))!, "windows").includes("this Mac"), false);

console.log(`deliveryStage: ${TABLE.length} stages, ${PRESENTED.length} presented, ${lines.length} lines`);

// 1.174.0 (DR2 round 1): a merged pull request is on GitHub first, even when
// a later release entry was recorded "local" (a release kept on this Mac
// that carried it).
assert.equal(
  deliveryStage({
    shipStatus: "shipped",
    prUrl: "https://github.com/o/r/pull/7",
    pr: { number: 7, state: "merged", mergeCommit: "m7" } as unknown as PrStatus,
    reviewStatus: null,
    commitSha: "m7",
    shipHistory: [
      { commitSha: "m7", shippedVersion: "1.0.0", releaseKind: "local", shippedAt: 1 },
      { commitSha: "r1", shippedVersion: "1.0.1", releaseKind: "local", shippedAt: 2, tag: "v1.0.1" },
    ],
  } as never),
  "shippedOnGitHub",
);
console.log("deliveryStage DR2 round 1 ok");
