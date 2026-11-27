import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { CardDeleteOutcome, CardWorktreeState } from "../ipc.ts";
import {
  atStake,
  deleteBlockedReason,
  deleteBranchNote,
  deleteChoices,
  COMMIT_LINE_MAX,
  deleteCommitLines,
  deleteFolderLine,
  deleteNote,
  deleteOutcomeToast,
  deleteRecoveryNote,
  deleteWarning,
  killRunDefault,
  runToKill,
  stillReading,
} from "./cardDeleteSheet.ts";
import { setPlatformForTests } from "./platform.ts";

function wt(over: Partial<CardWorktreeState> = {}): CardWorktreeState {
  return {
    disposition: "remove",
    path: "/ws/.atelier-worktrees/card1",
    branch: "atelier/card-card1-fix",
    dirtyFiles: 0,
    unpushedCommits: 0,
    liveSession: false,
    unreadable: false,
    busy: null,
    cardBranch: "atelier/card-card1-fix",
    cardBranchCommits: 0 as number | null,
    ...over,
  };
}

// GH #116: the sheet names what is at stake, in the issue's own words.
assert.equal(
  deleteWarning(wt({ disposition: "ask", unpushedCommits: 2, dirtyFiles: 3, path: null })),
  "This card has 2 commits and 3 changed files that exist only on this Mac.",
);
assert.equal(atStake(wt({ unpushedCommits: 1, dirtyFiles: 1 })), "1 commit, 1 changed file");
assert.equal(atStake(wt({ unpushedCommits: 0, dirtyFiles: 4 })), "4 changed files");
assert.equal(atStake(wt({ unpushedCommits: 5, dirtyFiles: 0 })), "5 commits");

// A folder Ply couldn't read as this card's checkout says so; it never
// invents counts, which would be the workspace repository's.
const unreadable = deleteWarning(wt({ disposition: "ask", unreadable: true, path: null }));
assert.equal(
  unreadable,
  "Plyloft couldn't confirm this folder is this card's own, so it won't remove it on its own.",
);
// GH #276: no path in the first layer — it is behind Details.
assert.doesNotMatch(
  deleteWarning(wt({ disposition: "ask", unpushedCommits: 1, path: "/ws/.atelier-worktrees/c" })) ?? "",
  /\//,
);
assert.equal(
  deleteWarning(wt({ disposition: "ask", unpushedCommits: 1, dirtyFiles: 0 })),
  "This card has 1 commit that exists only on this Mac.",
);
assert.equal(
  deleteFolderLine(wt({ disposition: "ask", path: "/ws/.atelier-worktrees/c" })),
  "The folder: /ws/.atelier-worktrees/c",
);
assert.equal(deleteFolderLine(wt()), null);

// Nothing at risk, or nothing on disk: no warning at all.
assert.equal(deleteWarning(wt()), null);
assert.equal(deleteWarning(wt({ disposition: "keep" })), null);
assert.equal(deleteWarning(null), null);

// `Delete everything` is recoverable for a week, and says so — Ply
// never deletes a checkout outright.
assert.match(
  deleteRecoveryNote(wt({ disposition: "ask", unpushedCommits: 1 })) ?? "",
  /\.trash\/ for 7 days/,
);
assert.match(deleteRecoveryNote(wt({ disposition: "ask", unreadable: true })) ?? "", /7 days/);
// N16: the trash named is the one beside the folder — a card made before
// the rename keeps `.atelier-worktrees/`, a new one is under `.plyloft-worktrees/`.
assert.match(
  deleteRecoveryNote(wt({ disposition: "ask", unpushedCommits: 1, path: "/ws/.atelier-worktrees/c" })) ?? "",
  /moves the folder to \.atelier-worktrees\/\.trash\/ for 7 days/,
);
assert.match(
  deleteRecoveryNote(wt({ disposition: "ask", unpushedCommits: 1, path: "/ws/.plyloft-worktrees/c" })) ?? "",
  /moves the folder to \.plyloft-worktrees\/\.trash\/ for 7 days/,
);
// Windows walk of 1.160.0: on Windows the trash is written with backslashes,
// like "The folder: C:\…\.plyloft-worktrees\card-…" above it.
setPlatformForTests("windows");
{
  const path = "C:\\Users\\me\\code\\app\\.plyloft-worktrees\\card-1";
  assert.equal(deleteFolderLine(wt({ disposition: "ask", unpushedCommits: 1, path })), `The folder: ${path}`);
  const note = deleteRecoveryNote(wt({ disposition: "ask", unpushedCommits: 1, path })) ?? "";
  assert.ok(note.includes("moves the folder to .plyloft-worktrees\\.trash\\ for 7 days"), note);
  assert.ok(!note.includes("/"), note);
}
setPlatformForTests(null);
assert.equal(deleteRecoveryNote(wt()), null, "nothing to recover from a safe one");
assert.equal(deleteRecoveryNote(null), null);

// The quiet note tells the user what the plain Delete takes with it.
assert.match(deleteNote(wt()) ?? "", /atelier\/card-card1-fix/);
assert.match(
  deleteNote(wt({ liveSession: true })) ?? "",
  /Builder session is ended first/,
);
assert.equal(deleteNote(wt({ disposition: "ask" })), null);
assert.equal(deleteNote(wt({ disposition: "keep" })), null);
// F8 (SL-4 walk): a refused delete doesn't say the folder and branch go with it.
assert.equal(deleteNote(wt({ busy: { kind: "setup", reason: "the card's setup is running in this card's folder" } })), null);
assert.equal(deleteNote(wt({ busy: { kind: "verify", reason: "a verify run is running" } })), null);
assert.equal(deleteNote(wt({ busy: { kind: "run", reason: "an agent run is running" } }), false), null);
assert.match(deleteNote(wt({ busy: { kind: "run", reason: "an agent run is running" } }), true) ?? "", /go with it/);

// The read hasn't landed: the sheet holds every destructive button.
assert.equal(stillReading(null), true);
assert.equal(stillReading(wt()), false);

// Work that exists only here replaces the single Delete with the two
// explicit choices — and only the second one removes anything.
const asked = deleteChoices(wt({ disposition: "ask", unpushedCommits: 2 }), false, false);
assert.deepEqual(
  asked.map((b) => [b.label, b.choice]),
  [
    ["Keep the folder", "keep"],
    ["Delete everything", "everything"],
  ],
);
assert.equal(asked.filter((b) => b.choice === "everything").length, 1);

// Safe, or nothing of the card's own on disk: one plain Delete, `auto`.
for (const disposition of ["remove", "keep"] as const) {
  assert.deepEqual(
    deleteChoices(wt({ disposition }), false, false).map((b) => [b.label, b.choice]),
    [["Delete", "auto"]],
  );
  assert.deepEqual(
    deleteChoices(wt({ disposition }), true, false).map((b) => [b.label, b.choice]),
    [["Close issue & delete", "auto"]],
  );
}

// The GitHub-backed sheet asks the same two questions; closing the issue
// is the other half of the same button.
assert.deepEqual(
  deleteChoices(wt({ disposition: "ask" }), true, false).map((b) => b.choice),
  ["keep", "everything"],
);

// ── What the delete owes the user afterwards (GH #116 F6) ──────────

function outcome(over: Partial<CardDeleteOutcome> = {}): CardDeleteOutcome {
  return {
    worktreeRemoved: false,
    branchRemoved: false,
    keptPath: null,
    problem: null,
    keptInTrash: null,
    keptReason: null,
    ...over,
  };
}

// A rename that failed: the folder is named, which is the whole point.
const renameFailed = deleteOutcomeToast(
  outcome({
    keptPath: "/ws/.atelier-worktrees/card1",
    problem: "rename to trash: Permission denied",
  }),
  "everything",
);
assert.equal(renameFailed?.kind, "error");
assert.equal(renameFailed?.title, "Card deleted — its folder stayed");
assert.match(renameFailed?.body ?? "", /\/ws\/\.atelier-worktrees\/card1/);
assert.match(renameFailed?.body ?? "", /Permission denied/);

// A workspace that couldn't be resolved names the recorded folder too.
const noWorkspace = deleteOutcomeToast(
  outcome({
    keptPath: "/ws/.atelier-worktrees/card1",
    problem: "Plyloft couldn't find the workspace's folder: workspace 'ws' not found",
  }),
  undefined,
);
assert.match(noWorkspace?.body ?? "", /\/ws\/\.atelier-worktrees\/card1/);

// The folder went and only the branch stayed: don't claim otherwise.
const branchOnly = deleteOutcomeToast(
  outcome({
    worktreeRemoved: true,
    problem: "atelier/card-card1-fix moved past what Plyloft checked",
  }),
  "auto",
);
assert.equal(branchOnly?.kind, "error");
assert.equal(branchOnly?.title, "Card deleted — its branch stayed");

// A folder kept on purpose says nothing; one kept unasked names itself.
assert.equal(
  deleteOutcomeToast(outcome({ keptPath: "/ws/.atelier-worktrees/card1" }), "keep"),
  null,
);
const keptUnasked = deleteOutcomeToast(
  outcome({ keptPath: "/ws/.atelier-worktrees/card1" }),
  "auto",
);
assert.equal(keptUnasked?.kind, "info");
assert.match(keptUnasked?.body ?? "", /\/ws\/\.atelier-worktrees\/card1/);

// The clean case says nothing at all.
assert.equal(
  deleteOutcomeToast(outcome({ worktreeRemoved: true, branchRemoved: true }), "auto"),
  null,
);

// ── What the sheet says it will take, and when it refuses ──────────

// `Delete everything` over a folder that proves no branch still drops
// the card's own branch, so the sheet names it and measures it.
const unjudgeable = wt({ disposition: "ask", unreadable: true, branch: null, cardBranchCommits: 2 });
assert.equal(
  deleteBranchNote(unjudgeable),
  "Deleting everything also drops this card's branch atelier/card-card1-fix, which has 2 commits that exist only on this Mac.",
);
assert.match(
  deleteBranchNote({ ...unjudgeable, cardBranchCommits: 1 }) ?? "",
  /has 1 commit that exists only on this Mac/,
);
assert.match(
  deleteBranchNote({ ...unjudgeable, cardBranchCommits: 0 }) ?? "",
  /has no commits of its own/,
);
// An unmeasurable branch says so, rather than the reassuring zero right
// before it is dropped.
assert.match(
  deleteBranchNote({ ...unjudgeable, cardBranchCommits: null }) ?? "",
  /which Plyloft couldn't measure\./,
);
// Nothing to add when the folder speaks for its own branch, or when
// there is no card branch, or when the delete is not asking.
assert.equal(deleteBranchNote(wt({ disposition: "ask", unpushedCommits: 1 })), null);
assert.equal(deleteBranchNote({ ...unjudgeable, cardBranch: null }), null);
assert.equal(deleteBranchNote(wt()), null);

// A run in the folder refuses the delete: the sheet says what to stop
// and offers no destructive button at all.
const verifying = wt({
  busy: { kind: "verify", reason: "a Verify run is working in this card's folder" },
});
assert.equal(
  deleteBlockedReason(verifying, false),
  "A Verify run is working in this card's folder. Stop it first, then delete the card.",
);
// Nobody's to kill from here: ticking the agent box changes nothing.
assert.equal(deleteBlockedReason(verifying, true), deleteBlockedReason(verifying, false));
// #378 (P3-2): a terminal tile open in the worktree: close it first.
const terminal = wt({
  disposition: "ask",
  busy: { kind: "terminal", reason: "a terminal tile is open in this card's folder" },
});
assert.equal(
  deleteBlockedReason(terminal, true),
  "A terminal tile is open in this card's folder. Close it, then delete the card.",
);
assert.equal(deleteRecoveryNote(terminal), null);
assert.deepEqual(deleteChoices(verifying, false, false), []);
assert.deepEqual(deleteChoices(verifying, true, true), []);
// …and the sheet says nothing about a delete that is not on offer.
assert.equal(
  deleteRecoveryNote({ ...verifying, disposition: "ask", unpushedCommits: 1 }),
  null,
);

// The card's own agent run is the one the sheet can clear. Unticked it
// blocks and says which box to tick; ticked, the delete is on offer
// again — it kills the run before it starts, which is that box's whole
// job, and the backend then sees a run already ended.
const running = wt({
  busy: { kind: "run", reason: "an agent run is working in this card's folder" },
});
assert.equal(
  deleteBlockedReason(running, false),
  'An agent run is working in this card\'s folder. Tick "Also kill the running agent on this card", or stop it first.',
);
assert.deepEqual(deleteChoices(running, false, false), []);
assert.equal(deleteBlockedReason(running, true), null);
assert.deepEqual(
  deleteChoices(running, false, true).map((b) => b.choice),
  ["auto"],
);
assert.deepEqual(
  deleteChoices({ ...running, disposition: "ask" }, false, true).map((b) => b.choice),
  ["keep", "everything"],
);
// A delete it can still offer keeps the line about the week.
assert.match(
  deleteRecoveryNote({ ...running, disposition: "ask" }) ?? "",
  /7 days/,
);

// The kill the user asked for happens on their tick, not on the card's
// mirrored status: the sheet offers the kill for a run only the backend
// found, whose mirror says nothing useful, and gating on it left that
// offer unable to keep its word.
assert.equal(
  runToKill({ linkedRunId: "run-1", lastRunStatus: null }, { alsoKillRun: true }),
  "run-1",
  "a stale mirror does not skip the kill the user asked for",
);
assert.equal(
  runToKill({ linkedRunId: "run-1", lastRunStatus: "running" }, { alsoKillRun: true }),
  "run-1",
);
assert.equal(runToKill({ linkedRunId: "run-1" }, { alsoKillRun: false }), null);
assert.equal(runToKill({ linkedRunId: "run-1" }, undefined), null);
assert.equal(runToKill({ linkedRunId: null }, { alsoKillRun: true }), null);

// The read must not re-tick a box the user deliberately cleared.
const foundByRead = wt({
  busy: { kind: "run", reason: "an agent run is working in this card's folder" },
});
assert.equal(
  killRunDefault({ killRun: false, hasRunningRun: false }, foundByRead),
  true,
  "a run only the read found arrives with nothing ticked",
);
assert.equal(
  killRunDefault({ killRun: false, hasRunningRun: true }, foundByRead),
  false,
  "the card advertised it, so unticked is the user's own choice",
);
assert.equal(killRunDefault({ killRun: true, hasRunningRun: true }, foundByRead), true);
assert.equal(killRunDefault({ killRun: false, hasRunningRun: false }, wt()), false);

assert.equal(deleteBlockedReason(wt(), false), null);
assert.equal(deleteBlockedReason(null, false), null);

// The safe-case note no longer claims nothing in the folder exists only
// on this Mac — its build output does, and the removal drops it.
const safeNote = deleteNote(wt()) ?? "";
assert.match(safeNote, /Nothing in it is unsaved or unpushed/);
assert.match(safeNote, /build output is not kept/);
assert.doesNotMatch(safeNote, /nothing in there exists only on this Mac/);

// ── The callers actually call them (GH #116 F9, F10) ───────────────
//
// Both of those findings were a decision that existed and a caller that
// did not use it: the sheet dropped the button its own checkbox needed,
// and the cascade gated the kill on the mirror instead of the tick. A
// pure function passing its own tests proves neither, so the two seams
// are pinned here the way `p3Integration.test.ts` pins its components'.

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const store = source("../store/kanbanStore.ts");
assert.match(store, /const killRunId = runToKill\(card, opts\)/);
assert.doesNotMatch(
  store,
  /lastRunStatus === "running"/,
  "the cascade must not gate the kill on the card's mirrored status",
);

// GH #116: a kept folder is only findable because the page lists it. GH #103
// moved that page onto the `ux` layer (`WorktreesPanel` → `WorktreesPage`);
// the four things this contract is about came with it.
const panel = source("../components/settings/WorktreesPage.tsx");
assert.match(panel, /worktreeKeptList\(workspaceId\)/);
assert.match(panel, /Kept from deleted cards/);
assert.match(panel, /Delete for good/);
assert.match(
  panel,
  /console\.warn\("worktrees: reading the kept entries failed:/,
  "and a trash it cannot read must not take the page down with it",
);

const dialog = source("../components/CardDeleteDialog.tsx");
assert.match(dialog, /deleteChoices\(wt, ghBacked, killRun\)/);
assert.match(dialog, /deleteBlockedReason\(wt, killRun\)/);
assert.match(dialog, /killRun: killRunDefault\(cur, worktree\)/);
assert.match(
  dialog,
  /wt\?\.busy\?\.kind === "run"/,
  "the kill box shows for a run only the read found",
);

// A folder kept in the trash is said first and names where it is: it
// is the one outcome that leaves work waiting on a decision.
const kept = deleteOutcomeToast(
  outcome({
    worktreeRemoved: true,
    keptInTrash: "/ws/.atelier-worktrees/.trash/card1-171",
    keptReason: "its folder has 1 uncommitted or untracked file, found once it was staged",
  }),
  "auto",
);
assert.equal(kept?.kind, "info");
assert.match(kept?.title ?? "", /kept, not queued for deletion/);
assert.match(kept?.body ?? "", /found once it was staged/);
assert.match(kept?.body ?? "", /\.trash\/card1-171/);
assert.match(kept?.body ?? "", /listed in Settings › Project › Cards' copies/);

// n16: with no origin every commit is only on this Mac — the line says
// what matters: the commits aren't on the target branch. With an origin
// (or an older answer that doesn't say) the wording is as it was.
{
  const local = { disposition: "ask" as const, hasOrigin: false, targetBranch: "main" };
  assert.equal(deleteWarning(wt({ ...local, unpushedCommits: 1 })), "This card has 1 commit that isn't on main.");
  assert.equal(deleteWarning(wt({ ...local, unpushedCommits: 3 })), "This card has 3 commits that aren't on main.");
  assert.equal(
    deleteWarning(wt({ ...local, unpushedCommits: 2, dirtyFiles: 1 })),
    "This card has 2 commits that aren't on main and 1 changed file that exists only on this Mac.",
  );
  assert.equal(
    deleteWarning(wt({ ...local, dirtyFiles: 2 })),
    "This card has 2 changed files that exist only on this Mac.",
  );
  assert.equal(
    deleteWarning(wt({ disposition: "ask", hasOrigin: true, targetBranch: "main", unpushedCommits: 1 })),
    "This card has 1 commit that exists only on this Mac.",
  );
  assert.equal(
    deleteBranchNote(wt({ ...local, branch: null, cardBranchCommits: 1 })),
    "Deleting everything also drops this card's branch atelier/card-card1-fix, which has 1 commit that isn't on main.",
  );
  // Details: short sha and subject, capped, with how many more.
  assert.deepEqual(deleteCommitLines(wt({ ...local, unpushedCommits: 1, localOnlySubjects: ["abc1234 build: snapshot 1"] })), [
    "Its commit:",
    "abc1234 build: snapshot 1",
  ]);
  const five = ["a1 e", "a2 d", "a3 c", "a4 b", "a5 a"];
  assert.deepEqual(deleteCommitLines(wt({ ...local, unpushedCommits: 7, localOnlySubjects: five })), [
    "Its commits:",
    ...five,
    "and 2 more",
  ]);
  const unproven = deleteCommitLines(wt({ ...local, branch: null, cardBranchCommits: 6, localOnlySubjects: five }));
  assert.equal(unproven[unproven.length - 1], "and 1 more");
  assert.deepEqual(deleteCommitLines(wt({ ...local, unpushedCommits: 1 })), []);
  assert.deepEqual(deleteCommitLines(wt({ disposition: "remove", localOnlySubjects: five })), []);
}

// n16: commits with nothing to measure them against have their own words,
// never "couldn't confirm this folder is this card's own", and still ask.
{
  const unmeasured = wt({ disposition: "ask", commitsUnmeasured: true });
  assert.equal(
    deleteWarning(unmeasured),
    "Plyloft couldn't tell which of this card's commits are elsewhere, so it won't remove them on its own.",
  );
  assert.equal(
    deleteWarning(wt({ disposition: "ask", commitsUnmeasured: true, dirtyFiles: 1 })),
    "Plyloft couldn't tell which of this card's commits are elsewhere, so it won't remove them on its own. It also has 1 changed file that exists only on this Mac.",
  );
  assert.deepEqual(
    deleteChoices(unmeasured, false, false).map((c) => c.choice),
    deleteChoices(wt({ disposition: "ask", unpushedCommits: 1 }), false, false).map((c) => c.choice),
    "the sheet asks as it does over local-only work",
  );
  // A subject past the cap ends in "…" at the cap.
  const long = `abc1234 ${"x".repeat(200)}`;
  const [, capped] = deleteCommitLines(wt({ disposition: "ask", unpushedCommits: 1, localOnlySubjects: [long] }));
  assert.equal([...capped].length, COMMIT_LINE_MAX);
  assert.ok(capped.endsWith("…") && capped.startsWith("abc1234 x"));
  const short = "abc1234 fine";
  assert.equal(deleteCommitLines(wt({ disposition: "ask", unpushedCommits: 1, localOnlySubjects: [short] }))[1], short);
}

console.log("cardDeleteSheet: ok");
