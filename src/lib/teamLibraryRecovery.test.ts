// GH #226: the words of "Reapply mine on top", as pure rules.
//   node --experimental-strip-types src/lib/teamLibraryRecovery.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHOICE_LABELS,
  MOVE_ASIDE_ACTION,
  PUBLISH_ACTION,
  UNDO_ACTION,
  allChosen,
  REAPPLY_ACTION,
  REAPPLY_LABEL,
  REVEAL_ACTION,
  divergenceError,
  interruptionError,
  reapplyError,
  reapplyToast,
} from "./teamLibraryRecovery.ts";
import type { UxError } from "./uxError.ts";
import { setPlatformForTests } from "./platform.ts";
import type { ReapplyReport, ReapplyResult } from "../ipc";

function report(result: ReapplyResult, over: Partial<ReapplyReport> = {}): ReapplyReport {
  return {
    result,
    reapplied: 2,
    broughtIn: 1,
    paths: [],
    backupRef: "refs/ply/backup/20260923T100000Z-abcdef123456",
    cloneDir: "/app-support/team/mb__team",
    message: "backend sentence",
    detail: "git's words",
    ...over,
  };
}

// The divergence block: the three parts, counted, and exactly one way out.
const block = divergenceError({ ahead: 2, behind: 1, cloneDir: "/app-support/team/mb__team" });
assert.match(block.happened, /2 changes to the team library/);
assert.match(block.happened, /published 1 change meanwhile/);
assert.match(block.untouched, /Nothing was lost or overwritten/);
assert.match(block.todo, /same file, it stops, changes nothing/);
assert.deepEqual(block.actions, [{ id: REAPPLY_ACTION, label: REAPPLY_LABEL, primary: true }]);
// Review 1 (m5): the clone's path is in Details, never in the three parts.
assert.equal(block.details, "Team clone: /app-support/team/mb__team");

/** No path, ref or git output in the three parts (PATTERNS §4). */
function wordsOnly(error: UxError, label: string) {
  for (const part of [error.title, error.happened, error.untouched, error.todo]) {
    for (const leaked of ["/app-support", "refs/ply", "library/", "git's words"]) {
      assert.ok(!part.includes(leaked), `${label}: ${leaked} in "${part}"`);
    }
  }
}
wordsOnly(block, "divergence");

// Review 1 (M1): an interrupted reapply of Ply's own is finished by the same
// press; one Ply didn't start gets no press but Finder, and its path in Details.
const own = interruptionError({ own: true, cloneDir: "/app-support/team/mb__team" });
assert.deepEqual(own.actions.map((a) => a.id), [REAPPLY_ACTION]);
const foreign = interruptionError({ own: false, cloneDir: "/app-support/team/mb__team" });
assert.deepEqual(foreign.actions.map((a) => a.id), [REVEAL_ACTION]);
assert.match(foreign.details!, /\/app-support\/team\/mb__team/);
wordsOnly(own, "own");
wordsOnly(foreign, "foreign");

// Success leaves nothing on the page.
assert.equal(reapplyError(report("published")), null);
assert.equal(reapplyError(report("in_step")), null);

// A collision names the files, keeps the backup in Details, offers no press
// that would only collide again.
const collision = reapplyError(
  report("collision", { paths: ["library/knowledge/a.md", "library/knowledge/b.md"] }),
)!;
assert.match(collision.happened, /a\.md and b\.md/);
assert.match(collision.untouched, /nothing was published or lost/);
// Review 1 (m6): its one way out shows the clone in Finder, to settle it.
assert.deepEqual(collision.actions.map((a) => a.id), [REVEAL_ACTION]);
assert.match(collision.details!, /library\/knowledge\/a\.md/);
wordsOnly(collision, "collision");
assert.match(collision.details!, /refs\/ply\/backup\/20260923T100000Z-abcdef123456/);
assert.match(collision.details!, /\/app-support\/team\/mb__team/);
assert.match(collision.details!, /Backup of this Mac's changes: refs\/ply\/backup\//);
// n15: Plyloft's own words in Details name the machine as Windows does.
setPlatformForTests("windows");
try {
  const onPc = reapplyError(report("collision", { paths: ["library/knowledge/a.md"] }))!;
  assert.match(onPc.details!, /Backup of this PC's changes: refs\/ply\/backup\//);
  assert.doesNotMatch(onPc.details!, /Mac/);
} finally {
  setPlatformForTests(null);
}

// Everything retryable offers the same press again, first.
for (const result of ["stopped", "fetch_failed", "push_refused", "push_timed_out"] as const) {
  const error = reapplyError(report(result, { paths: ["library/knowledge/x.md"] }))!;
  assert.equal(error.actions[0].id, REAPPLY_ACTION, result);
  assert.ok(error.title.endsWith("."), result);
  wordsOnly(error, result);
}
// QoL 13.3: uncommitted edits in the clone are moved aside by Plyloft, first.
{
  const dirty = reapplyError(report("dirty", { paths: ["library/knowledge/x.md"] }))!;
  assert.deepEqual(dirty.actions.map((a) => a.id), [MOVE_ASIDE_ACTION, REVEAL_ACTION]);
  assert.equal(dirty.actions[0].label, "Move them aside");
  assert.match(dirty.todo, /dated folder/);
  wordsOnly(dirty, "dirty");
}
// QoL 13.3: a collision is chosen here, per file — no "by hand".
assert.doesNotMatch(collision.todo, /by hand/);
assert.match(collision.todo, /Put them together/);
assert.deepEqual(CHOICE_LABELS.map((c) => c.label), ["Keep mine", "Keep theirs", "Keep both"]);
assert.equal(allChosen(["a", "b"], { a: "mine" }), false);
assert.equal(allChosen(["a", "b"], { a: "mine", b: "both" }), true);
assert.equal(allChosen([], {}), false);
// …and once put together: Publish first, Undo beside it, nothing published.
{
  const settled = reapplyError(
    report("resolved", { paths: ["library/knowledge/a.md"], asideDir: "/app-support/team-set-aside/mb__team 2026-10-22 101500" }),
  )!;
  assert.deepEqual(settled.actions.map((a) => a.id), [PUBLISH_ACTION, UNDO_ACTION]);
  assert.match(settled.untouched, /Nothing is published yet/);
  assert.match(settled.happened, /saved in a folder/);
  assert.match(settled.details!, /Saved versions: \/app-support\/team-set-aside/);
  wordsOnly(settled, "resolved");
  assert.equal(reapplyToast(report("resolved")).kind, "info");
}
// Review 1 (m4): a push GitHub denies offers no press that can only be denied.
const denied = reapplyError(report("push_denied"))!;
assert.deepEqual(denied.actions, []);
assert.match(denied.todo, /Pressing again won't help/);
for (const result of ["foreign", "unrecovered"] as const) {
  const error = reapplyError(report(result))!;
  assert.deepEqual(error.actions.map((a) => a.id), [REVEAL_ACTION], result);
  wordsOnly(error, result);
}
assert.match(reapplyError(report("dirty", { paths: ["library/x.md"] }))!.happened, /^x\.md is changed/);
assert.match(reapplyError(report("push_timed_out"))!.todo, /changes nothing if they did/);

// Toasts: success confirms; everything else is an error in the backend's words.
assert.equal(reapplyToast(report("published")).kind, "info");
assert.equal(reapplyToast(report("in_step")).kind, "info");
for (const result of [
  "collision",
  "stopped",
  "dirty",
  "foreign",
  "fetch_failed",
  "push_refused",
  "push_denied",
  "push_timed_out",
  "unrecovered",
] as const) {
  const toast = reapplyToast(report(result));
  assert.equal(toast.kind, "error", result);
  assert.equal(toast.body, "backend sentence", result);
}

// The variants are the backend's, one for one.
const teamRs = readFileSync(new URL("../../src-tauri/src/team.rs", import.meta.url), "utf8");
const variants = /pub enum ReapplyResult \{([\s\S]*?)\n\}/.exec(teamRs)![1];
const names = [...variants.matchAll(/^\s{4}([A-Z]\w+),/gm)].map((m) =>
  m[1].replace(/[A-Z]/g, (c, i: number) => (i ? "_" : "") + c.toLowerCase()),
);
assert.deepEqual(names.sort(), [
  "collision",
  "dirty",
  "fetch_failed",
  "foreign",
  "in_step",
  "published",
  "push_denied",
  "push_refused",
  "push_timed_out",
  "resolved",
  "stopped",
  "unrecovered",
]);
// And the backend's sentence names the action by the label the surfaces draw.
assert.ok(teamRs.includes(REAPPLY_LABEL), "team.rs says “Reapply mine on top”");

console.log("teamLibraryRecovery.test.ts ok");
