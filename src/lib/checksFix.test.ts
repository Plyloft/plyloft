// QoL 1.168 (C2, C4): the words a failed check and a dirty project folder
// send to the Builder — plain, bounded, the failing steps by name.
import assert from "node:assert/strict";
import type { KanbanCard, VerifyStepResult } from "../ipc.ts";
import {
  builderMayCommit,
  MAX_CHARS,
  MAX_LINES,
  MAX_STEPS,
  checksFixMessage,
  commitDirtyMessage,
  failingSteps,
  plainTail,
  commitStop,
  hookFixMessage,
} from "./checksFix.ts";

const step = (kind: string, passed: boolean, reason?: string): VerifyStepResult => ({ kind, passed, elapsedMs: 10, reason });

// plainTail: no colours or control codes; only the end of a long output.
assert.equal(plainTail("\u001b[31mFAIL\u001b[0m src/a.test.ts\r\n  expected 1\u0007"), "FAIL src/a.test.ts\n  expected 1");
const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
const tail = plainTail(long);
assert.ok(tail.startsWith("(earlier lines left out)\n"), "a cut output says so");
assert.ok(tail.endsWith("line 199"), "the end is kept");
assert.equal(tail.split("\n").length, MAX_LINES + 1);
const wide = "x".repeat(MAX_CHARS * 3);
assert.ok(plainTail(wide).length <= MAX_CHARS + 30, "bounded in characters too");

// failingSteps: the live run's failing steps, else the last recorded failed run's.
const card = (status: "failed" | "passed", steps: VerifyStepResult[]) =>
  ({ verifyHistory: [{ verifyRunId: "r", status, endedAt: 1, steps }] }) as Pick<KanbanCard, "verifyHistory">;
assert.deepEqual(failingSteps(card("failed", [step("npm test", false, "boom"), step("lint", true)]), null).map((s) => s.kind), ["npm test"]);
assert.deepEqual(failingSteps(card("passed", [step("npm test", false)]), null), [], "a run that passed sends nothing");
assert.deepEqual(failingSteps(card("failed", []), [step("live", false)]).map((s) => s.kind), ["live"], "the live run wins");
assert.deepEqual(failingSteps({ verifyHistory: [] }, null), []);

// checksFixMessage: names each failing check with its output; never asks to change the checks.
const msg = checksFixMessage([step("script:scripts/test.sh", false, "\u001b[1mAssertionError\u001b[0m: 2 !== 3")], null);
assert.match(msg, /^The project's checks failed on this card's copy\./);
assert.match(msg, /Don't change or skip the checks themselves\./);
assert.match(msg, /Failing check: script:scripts\/test\.sh\nAssertionError: 2 !== 3/);
assert.doesNotMatch(msg, /\u001b/);
assert.match(checksFixMessage([step("lint", false)], null), /Failing check: lint\n\(it printed nothing\)/);
assert.match(checksFixMessage([], "The verify script exited 1."), /What the run said:\nThe verify script exited 1\./);
assert.match(checksFixMessage([], null), /The run didn't say which check failed\./);
const many = Array.from({ length: MAX_STEPS + 2 }, (_, i) => step(`s${i}`, false, "x"));
const manyMsg = checksFixMessage(many, null);
assert.equal(manyMsg.match(/Failing check:/g)?.length, MAX_STEPS);
assert.match(manyMsg, /Also failing: s5, s6\./);

// commitDirtyMessage: the project folder, only these tracked files, nothing else.
const dirty = commitDirtyMessage("/Users/me/notes-app", { totalCount: 3, paths: ["a.txt", "b/c d.ts"], truncated: true });
assert.match(dirty, /the project folder \/Users\/me\/notes-app has 3 changed files that aren't in a commit\. They are not part of this card\./);
assert.match(dirty, /- a\.txt\n- b\/c d\.ts/);
assert.match(dirty, /only the first 2 of 3\. Run `git status --untracked-files=no` in \/Users\/me\/notes-app/);
assert.match(dirty, /`git add -u -- "a\.txt" "b\/c d\.ts"`/);
assert.match(dirty, /`git commit -m "<what they are, in a few words>" -- "a\.txt" "b\/c d\.ts"`/);
assert.match(dirty, /on the branch checked out there/);
assert.match(dirty, /Leave untracked files alone\. Don't use --amend or --no-verify, don't switch branches/);
assert.match(dirty, /the person presses Ship it again\.$/);
const one = commitDirtyMessage("C:\\p", { totalCount: 1, paths: ["x"], truncated: false });
assert.match(one, /has 1 changed file that isn't in a commit/);
assert.doesNotMatch(one, /untracked-files=no/, "a whole list needs no git status");
assert.match(commitDirtyMessage("/p", { totalCount: 1, paths: ['we"ird$.txt'], truncated: false }), /"we\\"ird\\\$\.txt"/);

// builderMayCommit: a Claude Builder that asks first; never Codex or Build without asking.
assert.equal(builderMayCommit({ builder: { vendor: "claude", bypass: false } as KanbanCard["builder"] }), true);
assert.equal(builderMayCommit({ builder: { vendor: "codex", bypass: false } as KanbanCard["builder"] }), false);
assert.equal(builderMayCommit({ builder: { vendor: "claude", bypass: true } as KanbanCard["builder"] }), false);
assert.equal(builderMayCommit({ builder: null }), false);

console.log("checksFix: ok");

// R8: the hook's words, read back from the error, and what the Builder is told.
{
  assert.deepEqual(commitStop("A hook in this project refused the commit:\nbad\n\nNothing was committed. Nothing was released."), {
    kind: "hook",
    said: "bad",
  });
  assert.deepEqual(
    commitStop("Committing took too long — a hook or a signing prompt in this project may be waiting. Nothing was committed."),
    { kind: "timeout" },
  );
  assert.equal(commitStop("git commit failed: fatal: no identity"), null);
  const told = hookFixMessage("lint: 2 problems");
  assert.ok(told.includes("lint: 2 problems") && told.includes("--no-verify"), told);
}

// 1.175.0 F5 round 2: the button's title follows the card's "After a fix round".
{
  const { askBuilderFixChecksTitle } = await import("./checksFix.ts");
  assert.match(askBuilderFixChecksTitle(true), /When it's done, Plyloft checks the fix by itself\.$/);
  assert.match(askBuilderFixChecksTitle(false), /Press Finish and check when it says it's done\.$/);
  console.log("checksFix F5 round 2: ok");
}
