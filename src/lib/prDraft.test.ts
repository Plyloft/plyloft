// Runs standalone: node --experimental-strip-types src/lib/prDraft.test.ts
import assert from "node:assert/strict";
import type { PrDraftAsk, PrDraftRead } from "./prDraftIpc.ts";
import {
  questionLeftByDraft,
  draftPullRequest,
  PR_DRAFT_MIN_TURN_MS,
  PR_DRAFT_NOT_SUBMITTED_MS,
  PR_DRAFT_WAIT_MS,
  type PrDraftDeps,
} from "./prDraft.ts";
import { prEditOffered, prEditSaveable } from "./prEdit.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (!ok) {
    failed++;
    console.error("FAIL", name);
  }
}

type Fake = PrDraftDeps & { written: string[]; writing: (on: boolean) => void; log: string[] };

/** A fake app: a clock that `sleep` moves, and the draft file read at each
 *  poll from `reads` (the last one repeats). */
function fake(opts: {
  idle?: string | null;
  ask?: PrDraftAsk;
  reads?: PrDraftRead[];
  turnOverAt?: number | null;
  aliveUntil?: number;
  /** When a scan first saw the Builder working; null: unknown (no live
   *  terminal). Default: at once. */
  startedAt?: number | null;
}): Fake {
  let now = 0;
  let polls = 0;
  const reads = opts.reads ?? [{ state: "missing" }];
  const log: string[] = [];
  const written: string[] = [];
  return {
    log,
    written,
    idleSession: () => (opts.idle === undefined ? "pty1" : opts.idle),
    prepare: async () => {
      log.push("prepare");
      return opts.ask ?? { message: "[Plyloft] write it", ptyId: "pty1", requestId: "r1" };
    },
    write: async (_pty, text) => {
      written.push(text);
    },
    read: async () => reads[Math.min(polls++, reads.length - 1)],
    sessionAlive: () => now < (opts.aliveUntil ?? Infinity),
    turnOverSince: () => opts.turnOverAt != null && now >= opts.turnOverAt,
    turnStartedSince: () =>
      opts.startedAt === null ? null : now >= (opts.startedAt ?? 0),
    forget: async (id) => {
      log.push(`forget:${id}`);
    },
    writing: (on) => log.push(on ? "writing:on" : "writing:off"),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

const ready: PrDraftRead = { state: "ready", title: "T", body: "B" };

// A session that is not at its prompt is never sent anything.
{
  const f = fake({ idle: null });
  const out = await draftPullRequest(f);
  check("busy: template", out.kind === "template");
  check("busy: nothing asked", f.log.length === 0 && f.written.length === 0);
}
// No message from the backend (no live session, no pull request): template, nothing written.
{
  const f = fake({ ask: { skip: "the Builder session is closed" } });
  const out = await draftPullRequest(f);
  check("skip: template with why", out.kind === "template" && out.why === "the Builder session is closed");
  check("skip: nothing written", f.written.length === 0 && !f.log.includes("writing:on"));
}
// A message for another session than the idle one is not sent.
{
  const f = fake({ ask: { message: "m", ptyId: "pty2", requestId: "r2" } });
  check("another session: template", (await draftPullRequest(f)).kind === "template" && f.written.length === 0);
  check("another session: the request is forgotten", f.log.includes("forget:r2"));
}
// The draft read twice the same: done, without waiting out the time.
{
  const f = fake({ reads: [{ state: "missing" }, ready, ready] });
  const out = await draftPullRequest(f);
  check("ready twice: draft with this press's request", out.kind === "draft" && out.requestId === "r1");
  check("ready twice: nothing forgotten", !f.log.some((l) => l.startsWith("forget")));
  check("ready twice: the message was written once", f.written.length === 1 && f.written[0] === "[Plyloft] write it");
  check("ready twice: the line went on and off", f.log.join(",") === "prepare,writing:on,writing:off");
}
// The Builder's turn ended with a usable draft: done at once.
{
  const f = fake({ reads: [ready], turnOverAt: PR_DRAFT_MIN_TURN_MS });
  check("turn over + ready: draft", (await draftPullRequest(f)).kind === "draft");
}
// The Builder's turn ended with no draft: template, before the 90 s.
{
  const f = fake({ reads: [{ state: "missing" }], turnOverAt: PR_DRAFT_MIN_TURN_MS });
  const out = await draftPullRequest(f);
  check("turn over, nothing: template", out.kind === "template" && out.why === "the Builder wrote no draft");
}
// An unusable draft at the end of the turn: template, with its reason.
{
  const f = fake({ reads: [{ state: "unusable", reason: "its title is 90 characters" }], turnOverAt: PR_DRAFT_MIN_TURN_MS });
  const out = await draftPullRequest(f);
  check("unusable: template with reason", out.kind === "template" && out.why === "its title is 90 characters");
}
// A turn that looks over in its first seconds is not the answer.
{
  let now = 0;
  const f = fake({ reads: [{ state: "missing" }, { state: "missing" }, ready, ready] });
  f.now = () => now;
  f.sleep = async (ms) => {
    now += ms;
  };
  f.turnOverSince = () => true;
  const out = await draftPullRequest(f);
  check("early idle is not the end: the draft still came", out.kind === "draft");
}
// Nothing comes: Ship goes on at 90 s with the template.
{
  let at = 0;
  const f = fake({ reads: [{ state: "missing" }] });
  const sleep = f.sleep;
  f.sleep = async (ms) => {
    await sleep(ms);
    at = f.now();
  };
  const out = await draftPullRequest(f);
  check("timeout: template", out.kind === "template" && /90 seconds/.test((out as { why: string }).why));
  check("timeout: at most 90 s", at <= PR_DRAFT_WAIT_MS && at >= PR_DRAFT_WAIT_MS - 1_000);
  check("timeout: the request is forgotten", f.log.includes("forget:r1"));
}
// The session ended while it was writing: template.
{
  const f = fake({ reads: [{ state: "missing" }], aliveUntil: 3_000 });
  const out = await draftPullRequest(f);
  check("ended: template", out.kind === "template" && out.why === "the Builder session ended");
  check("ended: the line went off", f.log[f.log.length - 1] === "writing:off");
  check("ended: the request is forgotten", f.log.includes("forget:r1"));
}
// A write that failed: template, the line off.
{
  const f = fake({});
  f.write = async () => {
    throw new Error("pty gone");
  };
  const out = await draftPullRequest(f);
  check("write failed: template", out.kind === "template" && f.log[f.log.length - 1] === "writing:off");
  check("write failed: forgotten", f.log.includes("forget:r1"));
}
// G4 Challenger 1: an answer without a request id asks nothing.
{
  const f = fake({ ask: { message: "m", ptyId: "pty1" } });
  check("no request id: template, nothing written", (await draftPullRequest(f)).kind === "template" && f.written.length === 0);
}
// G4 Challenger 9: no turn started 10 s after the paste — not submitted;
// the template at once, the request forgotten, nothing else written.
{
  const f = fake({ reads: [{ state: "missing" }], startedAt: Infinity });
  let at = 0;
  const sleep = f.sleep;
  f.sleep = async (ms) => {
    await sleep(ms);
    at = f.now();
  };
  const out = await draftPullRequest(f);
  check("not submitted: template", out.kind === "template" && out.why.startsWith("not submitted"));
  check("not submitted: early", at >= PR_DRAFT_NOT_SUBMITTED_MS && at < PR_DRAFT_NOT_SUBMITTED_MS + 2_000);
  check("not submitted: one write only", f.written.length === 1);
  check("not submitted: forgotten", f.log.includes("forget:r1"));
}
// Unknown (no live terminal scans it): the full wait, never an early end.
{
  const f = fake({ reads: [{ state: "missing" }], startedAt: null });
  const out = await draftPullRequest(f);
  check("unknown start: the full wait", out.kind === "template" && /90 seconds/.test((out as { why: string }).why));
}
// A turn that started late (5 s) is a turn: the draft still comes.
{
  const reads: PrDraftRead[] = Array.from({ length: 20 }, () => ({ state: "missing" }) as PrDraftRead);
  const f = fake({ reads: [...reads, ready, ready], startedAt: 5_000 });
  check("started: the draft comes", (await draftPullRequest(f)).kind === "draft");
}

// Edit title and description.
const loaded = { title: "Old", body: "Body" };
check("edit: nothing read yet", !prEditSaveable(null, "New", "Body"));
check("edit: unchanged", !prEditSaveable(loaded, "Old", "Body"));
check("edit: unchanged but spaces", !prEditSaveable(loaded, " Old ", "Body"));
check("edit: a new title", prEditSaveable(loaded, "New", "Body"));
check("edit: a new body", prEditSaveable(loaded, "Old", "Body 2"));
check("edit: empty title", !prEditSaveable(loaded, "  ", "Body 2"));
check("edit: title too long", !prEditSaveable(loaded, "x".repeat(257), "Body"));
check("edit offered: own open PR", prEditOffered({ prUrl: "u" }, true));
check("edit offered: not closed", !prEditOffered({ prUrl: "u" }, false));
check("edit offered: not a PR it reviews", !prEditOffered({ prUrl: "u", prReview: {} }, true));

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("prDraft: all passed");

// U25: only a question that came after the draft was asked for.
check("left: asked, no draft, a question", questionLeftByDraft(true, "template", true));
check("left: already on screen, it stopped the asking", !questionLeftByDraft(false, "template", true));
check("left: a draft came", !questionLeftByDraft(true, "draft", true));
check("left: no question", !questionLeftByDraft(true, "template", false));

// ── 1.175.0 F6: the draft written during the review ─────────────────────
{
  const { earlyDraftAtShip, draftRow, reviewWithDraftSentence, PR_DRAFT_WAIT_MS: WAIT } = await import("./prDraft.ts");
  const early = { requestId: "r1", commit: "aaa", askedAt: 1_000 };
  // Ship: ready → now; still writing → only what is left of the 90 s; another commit → ask again.
  assert.deepEqual(earlyDraftAtShip({ ...early, ready: true }, "aaa", 5_000), { use: "now", requestId: "r1" });
  assert.deepEqual(earlyDraftAtShip(early, "aaa", 31_000), { use: "wait", requestId: "r1", ms: WAIT - 30_000 });
  assert.deepEqual(earlyDraftAtShip(early, "aaa", 1_000 + WAIT + 5), { use: "now", requestId: "r1" }, "time's up: Ship goes on");
  assert.deepEqual(earlyDraftAtShip(early, "bbb", 2_000), { use: "ask" }, "a fix round since");
  assert.deepEqual(earlyDraftAtShip(null, "aaa", 2_000), { use: "ask" });
  // Round 2: busy at the review's start → Ship asks as before; would ask / closed → Plyloft's text.
  assert.deepEqual(earlyDraftAtShip({ requestId: null, commit: "aaa", askedAt: 1, skip: "busy" }, "aaa", 2), { use: "ask" });
  assert.deepEqual(earlyDraftAtShip({ requestId: null, commit: "aaa", askedAt: 1, skip: "the Builder would ask before writing the draft" }, "aaa", 2), { use: "template" });
  assert.deepEqual(earlyDraftAtShip({ requestId: null, commit: "aaa", askedAt: 1, skip: "the Builder session is closed" }, "aaa", 2), { use: "template" });
  // The Review's line, in its four states.
  assert.deepEqual(draftRow({ ...early, ready: true }, "aaa", "Claude"), { kind: "ready", line: "Claude wrote the pull request's title and description." });
  assert.deepEqual(draftRow(early, "aaa", "Claude"), { kind: "writing", line: "Claude is still writing the pull request's title and description." });
  assert.equal(draftRow(early, "bbb", "Claude")?.line, "The work changed after the pull request's text was written. Ship it asks Claude for it again, up to 90 seconds.");
  assert.equal(
    draftRow({ requestId: null, commit: "aaa", askedAt: 1, skip: "the Builder would ask before writing the draft" }, "aaa", "Claude")?.line,
    "Plyloft writes the pull request's title and description itself: Claude may ask before it writes a file on this card.",
  );
  assert.match(draftRow({ requestId: null, commit: "aaa", askedAt: 1, skip: "the Builder session is closed" }, "aaa", "Claude")!.line, /the Builder's session is closed\.$/);
  assert.equal(
    draftRow({ requestId: null, commit: "aaa", askedAt: 1, skip: "busy" }, "aaa", "Codex")!.line,
    "Codex was busy when the review started. Ship it asks Codex for the pull request's title and description, up to 90 seconds.",
  );
  assert.equal(draftRow({ requestId: null, commit: "aaa", askedAt: 1, skip: "this press opens no pull request" }, "aaa", "Claude"), null, "no pull request: nothing to say");
  assert.equal(draftRow(null, "aaa", "Claude"), null);
  assert.equal(
    reviewWithDraftSentence("Codex", "Claude", true),
    "Codex is reviewing Claude's work without changing it, and your checks are running. Meanwhile Claude writes the pull request's title and description. You can leave this; Plyloft tells you when it's done.",
  );
  console.log("prDraft F6: ok");
}
