// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/worktreeBase.test.ts
import assert from "node:assert/strict";
import type { FolderFacts, LocalBranchReport, LocalBranchSync, WorktreeBase } from "../ipc.ts";
import {
  describeWorktreeBase,
  folderDateWords,
  folderDetails,
  folderUpdateSaid,
  folderUpdateSettled,
  folderVersionLine,
  localBranchIsClear,
  projectFolderAsk,
  saveChangesPrompt,
  startMayBeLocal,
  startedLocalLine,
  formatDiskBytes,
  localBranchNoticeSay,
  localBranchStateKey,
  localBranchSyncToast,
  prunedWorktreesToast,
  syncFinishedToast,
  trashCleanupToast,
  worktreeBaseNoticeToast,
  worktreeTrashFolder,
} from "./worktreeBase.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function base(overrides: Partial<WorktreeBase> = {}): WorktreeBase {
  return { commit: SHA, refName: "origin/main", source: "origin", ...overrides };
}

// Header line names the ref and a short SHA; the full SHA is in the title.
{
  const d = describeWorktreeBase(base());
  assert.equal(d.label, "from origin/main @ 0123456");
  assert.ok(d.title.includes(SHA));
  const offline = describeWorktreeBase(
    base({ refName: "main", source: "localOffline", note: "fetch failed" }),
  );
  assert.equal(offline.label, "from main @ 0123456 · offline");
  assert.equal(
    describeWorktreeBase(base({ refName: "staging", source: "localOffline", note: "fatal: couldn't find remote ref refs/heads/staging" })).label,
    "from staging @ 0123456 · only on this Mac",
  );
  assert.ok(offline.title.includes("fetch failed"));
  // H6b (Windows walk): a skill card on a diverged target says what it lacks.
  const skill = describeWorktreeBase(
    base({ refName: "main", source: "localAhead", note: "local main has diverged from origin; this skill card starts from it" }),
  );
  assert.ok(skill.title.includes("this skill card starts from it"), skill.title);
  assert.ok(!skill.title.includes("already contains origin"), skill.title);
}

// Start-time notice: offline and diverged toast; a plain origin base doesn't.
{
  const notice = (b: WorktreeBase) =>
    worktreeBaseNoticeToast({
      workspaceId: "ws",
      cardId: "c1",
      cardTitle: "Rung 2",
      base: b,
    });
  assert.equal(notice(base()), null);
  assert.equal(notice(base({ refName: "main", source: "localAhead" })), null);
  const offline = notice(
    base({ refName: "main", source: "localOffline", originSlug: "acme/app", note: "fetch failed" }),
  );
  assert.equal(offline?.kind, "warn");
  assert.equal(offline?.title, "Card started without the latest from GitHub");
  assert.ok(offline?.body.includes("Rung 2"));
  // Sync only moves local main; the toast must not promise it fixes the card.
  assert.ok(offline?.body.includes("Sync won't change this card's branch"));
  assert.ok(offline?.body.includes("bring in the latest main"));
  // 1.175.0 F9: the way to update it, in the app's words.
  assert.ok(offline?.details?.includes("press Bring in main's changes when you're online"));
  // 1.174.4: GitHub answered, and has no such branch: not "couldn't reach".
  const noBranch = notice(
    base({ refName: "staging", source: "localOffline", originSlug: "acme/app", note: "git fetch origin staging failed: fatal: couldn't find remote ref refs/heads/staging" }),
  );
  assert.equal(noBranch?.title, "Card started from a branch GitHub doesn't have");
  assert.ok(!noBranch?.body.includes("couldn't reach"));
  assert.ok(offline?.details?.includes("fetch failed"));
  // P-D2 (Challenger): "GitHub" only for a GitHub origin; a GitLab, self-
  // hosted or local-path origin records no slug and reads "the online copy".
  const elsewhere = notice(
    base({ refName: "main", source: "localOffline", originUrl: "git@gitlab.com:a/b.git" }),
  );
  assert.equal(elsewhere?.title, "Card started without the latest from the online copy");
  assert.ok(elsewhere?.body.startsWith("Plyloft couldn't reach the online copy,"));
  assert.ok(!elsewhere?.body.includes("GitHub"));
  // The diverged note is Rust's sentence (origin, unpushed): the toast says
  // it plainly and keeps the ref and the note under Details.
  const note = "local main has diverged from origin; its 2 unpushed commit(s) are not in this card's branch";
  const diverged = notice(base({ refName: "origin/main", originSlug: "acme/app", note }));
  assert.equal(diverged?.kind, "warn");
  assert.equal(diverged?.title, "Card started from GitHub's main");
  assert.equal(
    diverged?.body,
    "“Rung 2” started from main as it is on GitHub. main on this Mac has 2 commits GitHub doesn't, and they aren't in this card's branch.",
  );
  assert.ok(!/origin|unpushed|diverged/.test(diverged?.body ?? ""));
  assert.ok(diverged?.details?.includes(note));
  const one = notice(base({ refName: "origin/main", note: note.replace("2", "1") }));
  assert.ok(one?.body.includes("has 1 commit the online copy doesn't, and it isn't"));
}

// Reconcile/Sync outcome: fast-forward informs, refusals warn, quiet stays quiet.
{
  const ff = localBranchSyncToast({
    branch: "main",
    outcome: { kind: "fastForwarded", from: SHA, to: "fedcba9876", commits: 2 },
  });
  assert.equal(ff?.kind, "info");
  assert.equal(ff?.title, "main on this Mac is up to date");
  assert.equal(ff?.body, "Brought in 2 commits from GitHub.");
  assert.ok(ff?.details?.includes("0123456 → fedcba9"));

  // F1 (1.172.1): changes in the way are the folder's ask now — info, the
  // branch named, the owner's words, the two presses.
  const dirty = localBranchSyncToast({
    branch: "main",
    outcome: { kind: "dirty", behind: 1 },
  });
  assert.equal(dirty?.kind, "info");
  assert.equal(dirty?.title, "Your project folder is behind GitHub's main");
  assert.equal(
    dirty?.body,
    "It's on main. GitHub's main has a newer update. Your cards always start from GitHub, so they aren't affected — only Code and terminals opened here show the old version.",
  );
  assert.deepEqual(dirty?.presses, [
    { kind: "bring-up-to-date", label: "Bring it up to date" },
    { kind: "dont-work-here", label: "I don't work here" },
  ]);
  assert.ok(!/commit|origin/i.test(dirty?.body ?? ""));
  const many = localBranchSyncToast({ branch: "staging", outcome: { kind: "dirty", behind: 527 } });
  assert.ok(many?.body.includes("GitHub's staging has 527 newer updates."));

  const elsewhere = localBranchSyncToast({
    branch: "staging",
    outcome: { kind: "checkedOutElsewhere", path: "/tmp/other", behind: 527 },
  });
  assert.equal(elsewhere?.title, "staging on this Mac is behind GitHub");
  assert.equal(
    elsewhere?.body,
    "staging is in use in another folder (Details shows where), so Plyloft didn't bring in GitHub's 527 newer updates. Your cards aren't affected.",
  );
  assert.equal(elsewhere?.details, "/tmp/other");

  const failed = localBranchSyncToast({ branch: "main", outcome: { kind: "failed", reason: "fatal: cannot lock ref" } });
  assert.equal(failed?.title, "Couldn't bring GitHub's main to this Mac");
  assert.equal(failed?.body, "Nothing changed, and your cards aren't affected.");
  assert.equal(failed?.details, "fatal: cannot lock ref");
  assert.deepEqual(failed?.presses, [{ kind: "sync-again", label: "Sync again" }]);

  const diverged = localBranchSyncToast({
    branch: "main",
    outcome: { kind: "diverged", ahead: 1, behind: 3 },
  });
  assert.equal(diverged?.kind, "warn");
  // H6b (Windows walk): a skill card on a diverged target starts locally.
  assert.equal(
    diverged?.body,
    "Plyloft won't combine them: new cards start from GitHub's main, a skill card from this Mac's, where its ship lands.",
  );

  // GH #102: the refusal of GH #88 needs doing, so no toast here carries it
  // any more — `announceError` raises the one that leads to its block, and
  // `src/lib/uxError.test.ts` holds the words and the source contract.
  const untracked = (paths: string[], repeated = false) =>
    localBranchSyncToast({
      branch: "staging",
      outcome: { kind: "untrackedDiffers", behind: 1, from: SHA, to: SHA, paths, repeated },
    });
  assert.equal(untracked([".claude/skills/x/SKILL.md"]), null);
  assert.equal(untracked(["a", "b"]), null);
  assert.equal(untracked(["a"], true), null);

  for (const kind of ["upToDate", "noRemote", "noLocalBranch"] as const) {
    assert.equal(localBranchSyncToast({ branch: "main", outcome: { kind } }), null);
  }
  assert.equal(
    localBranchSyncToast({ branch: "main", outcome: { kind: "ahead", ahead: 2 } }),
    null,
  );
  assert.equal(
    localBranchSyncToast({
      branch: "main",
      outcome: { kind: "offline", reason: "no network" },
    }),
    null,
  );
}

// E3 (owner, 2026-10-28): a Sync nobody pressed says a lasting state once
// per workspace, branch and state; a pressed Sync always says it; a state
// that goes away is said again when it comes back.
{
  const dirty = { branch: "staging", outcome: { kind: "dirty", behind: 527 } } as const;
  const more = { branch: "staging", outcome: { kind: "dirty", behind: 530 } } as const;
  const first = localBranchNoticeSay(dirty, null, false);
  assert.deepEqual(first, { say: true, remember: localBranchStateKey(dirty) });
  // The next launch: the same state (a different count is the same state).
  assert.equal(localBranchNoticeSay(more, first.remember, false).say, false);
  // Pressed: said.
  assert.equal(localBranchNoticeSay(more, first.remember, true).say, true);
  // Another state of the same branch is news.
  const diverged = { branch: "staging", outcome: { kind: "diverged", ahead: 1, behind: 2 } } as const;
  assert.equal(localBranchNoticeSay(diverged, first.remember, false).say, true);
  // Another branch is news.
  assert.equal(localBranchNoticeSay({ ...dirty, branch: "main" }, first.remember, false).say, true);
  // Round 2 (Challenger 3): offline says nothing about the branch — the key
  // is left as it was, so the next launch stays quiet.
  const offline = localBranchNoticeSay({ branch: "staging", outcome: { kind: "offline", reason: "x" } }, first.remember, false);
  assert.equal(offline.remember, undefined);
  assert.equal(localBranchNoticeSay({ branch: "staging", outcome: { kind: "noRemote" } }, first.remember, false).remember, undefined);
  // Gone: forgotten, so it is said again when it comes back.
  const clear = localBranchNoticeSay({ branch: "staging", outcome: { kind: "upToDate" } }, first.remember, false);
  assert.equal(clear.remember, null);
  assert.equal(localBranchNoticeSay(dirty, clear.remember, false).say, true);
  assert.equal(localBranchStateKey({ branch: "main", outcome: { kind: "fastForwarded", from: SHA, to: SHA, commits: 1 } }), null);
}

// F1 (1.172.1, owner 2026-10-28): the project folder's true facts.
{
  const SEP16 = Math.floor(new Date(2026, 8, 16, 12).getTime() / 1000);
  const now = new Date(2026, 9, 28);
  assert.equal(folderDateWords(SEP16, now), "16 Sep");
  assert.equal(folderDateWords(SEP16, new Date(2027, 0, 2)), "16 Sep 2026");

  const facts = (over: Partial<FolderFacts> = {}): FolderFacts => ({
    branch: "main",
    head: SHA,
    headAt: SEP16,
    targetLocal: null,
    targetRemote: "fedcba9876543210fedcba9876543210fedcba98",
    newer: 695,
    onlyHere: 0,
    changedCount: 0,
    changedPaths: [],
    ...over,
  });
  // The owner's LYRA folder: on main since 16 Sep, cards on staging, no
  // local staging — never "behind", it says what the folder is.
  const lyra: LocalBranchReport = { branch: "staging", outcome: { kind: "noLocalBranch" }, folder: facts() };
  const ask = projectFolderAsk(lyra);
  assert.deepEqual(ask, { target: "staging", folderBranch: "main", onTarget: false, newer: 695, changed: 0, headAt: SEP16 });
  const toast = localBranchSyncToast(lyra);
  assert.equal(toast?.kind, "info");
  assert.match(toast?.title ?? "", /^Your project folder is from \d+ Sep( 2026)?$/);
  assert.equal(
    toast?.body,
    "It's on main. GitHub's staging has 695 newer updates. Your cards always start from GitHub, so they aren't affected — only Code and terminals opened here show the old version.",
  );
  assert.ok(!/behind/.test(toast?.title ?? ""), "never the behind warning for another branch");
  // Details: branches, commits here and on GitHub, the counts.
  const details = folderDetails(lyra) ?? "";
  assert.ok(details.includes("Project folder: main at 0123456, last commit 16 Sep 2026"), details);
  assert.ok(details.includes("staging on GitHub: fedcba9"), details);
  assert.ok(details.includes("staging on this Mac: not here"), details);
  assert.ok(details.includes("GitHub's staging has 695 commits the folder doesn't; the folder has 0 commits it doesn't."), details);
  assert.equal(toast?.details, details);
  // One state per target and folder branch: a new count is the same state.
  const later: LocalBranchReport = { ...lyra, folder: facts({ newer: 700 }) };
  assert.equal(localBranchStateKey(later), localBranchStateKey(lyra));
  assert.notEqual(localBranchStateKey(lyra), null);
  // Said once on a Sync nobody pressed.
  const first = localBranchNoticeSay(lyra, null, false);
  assert.equal(first.say, true);
  assert.equal(localBranchNoticeSay(later, first.remember ?? null, false).say, false);

  // Item 2: no local target and nothing to ask — clear, quiet, key forgotten.
  const missing: LocalBranchReport = { branch: "staging", outcome: { kind: "noLocalBranch" } };
  assert.equal(localBranchSyncToast(missing), null);
  assert.equal(localBranchIsClear(missing), true);
  assert.deepEqual(localBranchNoticeSay(missing, "staging\u0000dirty", false), { say: true, remember: null });

  // On the target and up to date, or nothing newer on GitHub: no ask.
  assert.equal(projectFolderAsk({ branch: "main", outcome: { kind: "upToDate" }, folder: facts({ newer: 0 }) }), null);
  assert.equal(projectFolderAsk({ branch: "staging", outcome: { kind: "upToDate" }, folder: facts({ newer: 0 }) }), null);
  // A state of the target's own keeps its words (and gains the facts).
  const diverged = localBranchSyncToast({ branch: "staging", outcome: { kind: "diverged", ahead: 1, behind: 2 }, folder: facts() });
  assert.equal(diverged?.title, "staging on this Mac and on GitHub have both moved");
  assert.ok(diverged?.details?.includes("Project folder: main"));
  // Offline: nothing said, nothing asked.
  assert.equal(projectFolderAsk({ branch: "staging", outcome: { kind: "offline", reason: "x" }, folder: facts() }), null);

  // Changes in the way on the target: the branch named, the changes counted,
  // the files under Details.
  const dirty: LocalBranchReport = {
    branch: "staging",
    outcome: { kind: "dirty", behind: 12 },
    folder: facts({ branch: "staging", newer: 12, changedCount: 2, changedPaths: ["CONTEXT.md", ".claude/settings.json"] }),
  };
  const said = localBranchSyncToast(dirty);
  assert.equal(
    said?.body,
    "It's on staging, with 2 changes not saved in Git yet. GitHub's staging has 12 newer updates. Your cards always start from GitHub, so they aren't affected — only Code and terminals opened here show the old version.",
  );
  assert.ok(said?.details?.includes("Changed files (2): CONTEXT.md, .claude/settings.json"));
  assert.equal(localBranchStateKey(dirty), "staging\u0000folder\u0000staging");

  // The quiet line Code and terminals keep.
  assert.match(folderVersionLine(ask!), /^This is the version from \d+ Sep/);

  // Bring it up to date, per case — never a switch of branch.
  const own = folderUpdateSaid({
    kind: "ownBranch",
    branch: "main",
    target: "staging",
    outcome: { kind: "fastForwarded", from: SHA, to: SHA, commits: 54 },
  });
  assert.equal(own.openSheet, false);
  assert.equal(own.toast?.title, "main is now up to date with GitHub's main");
  assert.equal(own.toast?.body, "Brought in 54 updates. Cards keep using GitHub's staging.");
  assert.equal(
    folderUpdateSaid({ kind: "ownBranch", branch: "main", target: "staging", outcome: { kind: "upToDate" } }).toast?.title,
    "main already matches GitHub's main",
  );
  const offline = folderUpdateSaid({ kind: "ownBranch", branch: "main", target: "staging", outcome: { kind: "offline", reason: "no network" } });
  assert.equal(offline.toast?.kind, "warn");
  assert.equal(offline.toast?.details, "no network");
  assert.deepEqual(folderUpdateSaid({ kind: "changes", count: 2 }), { toast: null, openSheet: true });
  assert.equal(folderUpdateSaid({ kind: "target", branch: "main", outcome: { kind: "dirty", behind: 1 } }).openSheet, true);
  assert.equal(
    folderUpdateSaid({ kind: "target", branch: "main", outcome: { kind: "fastForwarded", from: SHA, to: SHA, commits: 1 } }).toast?.body,
    "Brought in 1 update from GitHub's main.",
  );
  assert.equal(folderUpdateSaid({ kind: "noBranch" }).toast?.title, "Plyloft left your project folder as it is");

  // Challenger 1: only a move (or nothing to bring) answers the ask.
  const ff = { kind: "fastForwarded", from: SHA, to: SHA, commits: 1 } as const;
  assert.equal(folderUpdateSettled({ kind: "ownBranch", branch: "main", target: "staging", outcome: ff }), true);
  assert.equal(folderUpdateSettled({ kind: "target", branch: "main", outcome: { kind: "upToDate" } }), true);
  assert.equal(folderUpdateSettled({ kind: "ownBranch", branch: "main", target: "staging", outcome: { kind: "ahead", ahead: 1 } }), true);
  const refusals: LocalBranchSync[] = [
    { kind: "diverged", ahead: 1, behind: 1 },
    { kind: "offline", reason: "x" },
    { kind: "failed", reason: "x" },
    { kind: "untrackedDiffers", behind: 1, from: SHA, to: SHA, paths: ["a"], repeated: false },
  ];
  for (const outcome of refusals) {
    assert.equal(folderUpdateSettled({ kind: "ownBranch", branch: "main", target: "staging", outcome }), false, outcome.kind);
  }
  assert.equal(folderUpdateSettled({ kind: "changes", count: 1 }), false);
  assert.equal(folderUpdateSettled({ kind: "noBranch" }), false);
  assert.equal(folderUpdateSettled({ kind: "noGitHubBranch", branch: "mine", target: "staging" }), false);

  // Challenger 2: a branch only on this Mac is not "couldn't read GitHub".
  const onlyHere = folderUpdateSaid({ kind: "noGitHubBranch", branch: "mine", target: "staging" });
  assert.equal(onlyHere.toast?.title, "GitHub has no mine");
  assert.equal(onlyHere.toast?.body, "mine is only on this Mac, so there's nothing to bring in. Cards keep using GitHub's staging.");

  // Challenger 3: files not in Git in the way — said, and named under Details.
  const untracked = folderUpdateSaid({
    kind: "ownBranch",
    branch: "main",
    target: "staging",
    outcome: { kind: "untrackedDiffers", behind: 2, from: SHA, to: SHA, paths: ["notes.md", "draft.md"], repeated: false },
  });
  assert.equal(untracked.toast?.title, "Couldn't bring main up to date");
  assert.equal(
    untracked.toast?.body,
    "2 files in your project folder that aren't saved in Git would be overwritten by GitHub's main, so nothing changed. Cards keep using GitHub's staging.",
  );
  assert.equal(untracked.toast?.details, "notes.md\ndraft.md");
  const onTarget = folderUpdateSaid({
    kind: "target",
    branch: "main",
    outcome: { kind: "untrackedDiffers", behind: 1, from: SHA, to: SHA, paths: ["notes.md"], repeated: false },
  });
  assert.equal(onTarget.toast?.details, "notes.md");
  assert.ok(onTarget.toast?.body.startsWith("A file in your project folder that isn't saved in Git would be overwritten"));

  // Challenger 7: a folder on no branch is not offered Bring it up to date.
  const detached = localBranchSyncToast({ branch: "staging", outcome: { kind: "noLocalBranch" }, folder: facts({ branch: null }) });
  assert.ok(detached?.body.startsWith("It isn't on a branch."));
  assert.deepEqual(detached?.presses, [{ kind: "dont-work-here", label: "I don't work here" }]);

  // Ask Claude to save them: the files named, no push, no switch.
  assert.equal(
    saveChangesPrompt(["CONTEXT.md", ".claude/settings.json"]),
    "Save these changes in Git with a clear commit message: CONTEXT.md, .claude/settings.json. Commit them on the branch the folder is on; don't push, and don't switch branches.",
  );
  assert.ok(saveChangesPrompt(["a"], 3).includes("a, and 3 more."));
}

// Merged-worktree cleanup: counts pruned, stays quiet when nothing was.
{
  const three = prunedWorktreesToast(3);
  assert.equal(three?.kind, "info");
  assert.equal(three?.title, "Cleaned up 3 finished cards");
  assert.ok(three?.body.includes("moved their copies to the trash (kept 7 days)"));
  assert.ok(three?.details?.includes(".trash"));
  assert.equal(prunedWorktreesToast(1)?.title, "Cleaned up 1 finished card");

  const withKept = prunedWorktreesToast(1, [
    { cardId: "gh-issue-20", reason: "its worktree has uncommitted or untracked changes" },
  ]);
  assert.ok(withKept?.body.includes("1 finished card was kept."));
  assert.ok(withKept?.details?.includes("Kept 1 merged: gh-issue-20 (its worktree has"));

  assert.equal(prunedWorktreesToast(0), null);
  assert.equal(
    prunedWorktreesToast(0, [{ cardId: "gh-issue-20", reason: "dirty" }]),
    null,
    "kept-only stays quiet: it would repeat on every board open",
  );
}

console.log("worktreeBase.test.ts: ok");

// Trash sweep: says how much it freed, stays quiet when nothing.
{
  assert.equal(formatDiskBytes(0), "0 B");
  assert.equal(formatDiskBytes(12_345), "12 KB");
  assert.equal(formatDiskBytes(333_000_000), "333 MB");
  assert.equal(formatDiskBytes(4_200_000_000), "4.2 GB");
  assert.equal(formatDiskBytes(81_000_000_000), "81 GB");

  const toast = trashCleanupToast(81_000_000_000);
  assert.equal(toast?.kind, "info");
  assert.equal(toast?.title, "Freed 81 GB");
  assert.ok(toast?.body.includes("work is kept"));
  assert.equal(trashCleanupToast(0), null);
}

// N16: a worktree's trash is the one in its own root; unknown → the new root.
assert.equal(worktreeTrashFolder("/ws/.plyloft-worktrees/card1"), ".plyloft-worktrees/.trash/");
assert.equal(worktreeTrashFolder("/ws/.atelier-worktrees/card1"), ".atelier-worktrees/.trash/");
assert.equal(worktreeTrashFolder("C:\\code\\app\\.atelier-worktrees\\card1"), ".atelier-worktrees/.trash/");
assert.equal(worktreeTrashFolder("/elsewhere/card1"), ".plyloft-worktrees/.trash/");
assert.equal(worktreeTrashFolder(null), ".plyloft-worktrees/.trash/");
// Windows walk of 1.160.0: on Windows the line uses backslashes, like the
// worktree path the delete sheet shows above it.
assert.equal(
  worktreeTrashFolder("C:\\Users\\me\\code\\app\\.plyloft-worktrees\\card-1", true),
  ".plyloft-worktrees\\.trash\\",
);
assert.equal(worktreeTrashFolder("C:\\code\\app\\.atelier-worktrees\\card1", true), ".atelier-worktrees\\.trash\\");
assert.equal(worktreeTrashFolder(null, true), ".plyloft-worktrees\\.trash\\");
assert.equal(worktreeTrashFolder("/ws/.plyloft-worktrees/card1", false), ".plyloft-worktrees/.trash/");
assert.ok(prunedWorktreesToast(2, [], true)?.details?.includes(".trash\\ beside"));
assert.ok(prunedWorktreesToast(2, [], false)?.details?.includes(".trash/ beside"));
assert.ok(trashCleanupToast(1_000_000)?.details?.includes("(target, node_modules, dist…)"));

// P-D2 Mac walk: a pressed Sync with nothing else to say says it finished;
// the Sync on opening the Board, or one another toast spoke for, stays quiet.
assert.deepEqual(syncFinishedToast({ created: 0, patched: 0 }, { manual: true, saidSomething: false }), {
  kind: "info",
  title: "Synced with GitHub",
  body: "The board is up to date.",
});
assert.equal(
  syncFinishedToast({ created: 2, patched: 1 }, { manual: true, saidSomething: false })?.body,
  "2 new cards from GitHub, 1 card updated.",
);
assert.equal(syncFinishedToast({ created: 0, patched: 0 }, { manual: false, saidSomething: false }), null);
assert.equal(syncFinishedToast({ created: 0, patched: 0 }, { manual: true, saidSomething: true }), null);

// 1.169.1 (R2): the card's own line about a start on this Mac.
{
  const github = { originSlug: "acme/web" };
  assert.equal(
    startedLocalLine(github, { target: "main", count: 1, subjects: ["x"] }),
    "Started from main on this Mac, which has 1 change not on GitHub yet.",
  );
  assert.equal(
    startedLocalLine({ originSlug: null }, { target: "walk-delivery-3", count: 3, subjects: [] }),
    "Started from walk-delivery-3 on this Mac, which has 3 changes not on the online copy yet.",
  );
  assert.equal(startedLocalLine(github, null), null);
  assert.equal(startedLocalLine(null, { target: "main", count: 1, subjects: [] }), null);
  assert.equal(startMayBeLocal({ source: "localAhead" }), true);
  assert.equal(startMayBeLocal({ source: "localOffline" }), true);
  assert.equal(startMayBeLocal({ source: "origin" }), false);
  assert.equal(startMayBeLocal({ source: "localNoRemote" }), false);
  assert.equal(startMayBeLocal(undefined), false);
}
