// Unit tests for the Repository pages' view model (src/lib/repositoryPage.ts,
// UX language card 2).
//
// Run: node --experimental-strip-types src/lib/repositoryPage.test.ts

import {
  AREA_FIELDS,
  BUILD_FIELDS,
  movedSince,
  teamValuesSheet,
  teamValuesToast,
  reviewMovedNote,
  GENERAL_FIELDS,
  SHIPPING_FIELDS,
  SHIPPING_ORDER,
  areaFolderWords,
  areaName,
  andMore,
  changeWord,
  changedFields,
  cachePathProblem,
  changes,
  clearSent,
  commitMessage,
  consequenceOf,
  currentValue,
  describe as describeValue,
  leaveBody,
  leaveQuestion,
  listWords,
  markHint,
  wasWords,
  isConfigField,
  normalise,
  patchConfig,
  publishBar,
  readOnlyFooter,
  readOnlyRowLine,
  restingHint,
  nameHint,
  WORKTREE_PORTS_HINT,
  worktreePortsHint,
  reviewLede,
  publishTarget,
  publishTargetOfDraft,
  branchesUnreadWhy,
  reviewTitle,
  rowLabel,
  accentColorRowLabel,
  pruneDraft,
  restoreFile,
  rowMark,
  savePayload,
  statusLine,
  isBranchMissing,
  valueText,
  versionFileFor,
  versionFileKindWords,
  versionFileRows,
  withoutFile,
  deriveRepository,
  detailText,
  firstSharedProjectNote,
  hasProject,
  matchesFilter,
  needsFilter,
  whyNotAVersionFile,
  setupApprovalNote,
  type DefinitionViewLike,
  type Draft,
  type PendingPublish,
  type ProjectConfigLike,
  type Values,
  type WorkspaceLike,
  areasChangeDetail,
} from "./repositoryPage.ts";

/** The draft's mechanics are one rule for every page: these tests run them
 *  on the build and shipping rows together, in the order Build and release
 *  drew them before 1.174.0 split them (DS2), so their numbers stay put. */
const ORDER = [
  "integrationBranch",
  "verifyPipeline",
  "installScript",
  "versionFiles",
  "selfCheck",
  "reviewChecklist",
  "sharedBuildCache",
  "cachePaths",
  "worktreeCopy",
  "worktreeSetup",
] as const;
import {
  clearLeaveGuard,
  hasLeaveGuard,
  leavePage,
  setLeaveGuard,
} from "./leaveGuard.ts";
import { ACCENT_CHOICES, accentChoice, accentName, resolveAccent } from "./repositoryAccent.ts";
import type { ProjectConfig, VersionFileEntry, WorkspaceDefinition } from "../ipc";
import { setPlatformForTests } from "./platform.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

function eq(actual: unknown, expected: unknown, msg = ""): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}

const files: VersionFileEntry[] = [
  { path: "frontend/package.json", kind: "package_json" },
  { path: "api/pyproject.toml", kind: "py_project_toml" },
];

const base: Values = {
  integrationBranch: "staging",
  verifyPipeline: null,
  installScript: null,
  versionFiles: files,
  sharedBuildCache: true,
  cachePaths: null,
  selfCheck: true,
  reviewChecklist: null,
  name: "LYRA - Jun 2025",
  accentColor: null,
};

// ── Values and change detection ────────────────────────────────────────

it("a switch with no value reads as on", () => {
  eq(normalise("sharedBuildCache", undefined), true);
  eq(normalise("selfCheck", null), true);
  eq(normalise("versionFiles", []), null, "an empty list is none");
  eq(normalise("installScript", ""), null);
});

it("only a field that really differs is a change", () => {
  eq(changedFields(ORDER, base, {}), []);
  eq(changedFields(ORDER, base, { integrationBranch: "staging" }), [], "same value");
  eq(changedFields(ORDER, base, { sharedBuildCache: true }), [], "on is the default");
  eq(changedFields(ORDER, base, { sharedBuildCache: false }), ["sharedBuildCache"]);
  eq(changedFields(ORDER, base, { versionFiles: [] }), ["versionFiles"]);
});

it("the changes are numbered in page order, whatever order they were made", () => {
  const draft: Draft = {
    sharedBuildCache: false,
    verifyPipeline: [{ kind: "script", path: "scripts/verify.sh" }],
  };
  const list = changes(ORDER, base, draft);
  eq(
    list.map((c) => [c.n, c.key]),
    [
      [1, "verifyPipeline"],
      [2, "sharedBuildCache"],
    ],
  );
  eq(list[0].fromText, "None");
  eq(list[0].toText, "scripts/verify.sh");
  eq(list[1].fromText, "On");
  eq(list[1].toText, "Off");
});

it("Discard drops the draft, and every row is back as it was", () => {
  const drafted: Draft = {
    verifyPipeline: [{ kind: "script", path: "scripts/verify.sh" }],
    sharedBuildCache: false,
    versionFiles: [],
  };
  eq(changes(ORDER, base, drafted).length, 3);
  // Discard is an empty draft: nothing of the page's own is left.
  const discarded: Draft = {};
  eq(changes(ORDER, base, discarded), []);
  eq(publishBar(changes(ORDER, base, discarded), "staging", null), null);
  for (const key of ORDER) {
    eq(currentValue(key, base, discarded), base[key] ?? null, key);
    eq(rowMark(key, base, discarded, null, ORDER).kind, "rest", key);
  }
});

it("a row shows the draft's value and falls back to the one in use", () => {
  eq(currentValue("integrationBranch", base, {}), "staging");
  eq(currentValue("integrationBranch", base, { integrationBranch: "main" }), "main");
});

// ── The changed mark ───────────────────────────────────────────────────

it("a drafted row is marked with its number and the value it had", () => {
  const mark = rowMark("sharedBuildCache", base, { sharedBuildCache: false }, null, ORDER);
  eq(mark, { kind: "draft", n: 1, was: "On" });
  eq(markHint(mark), "Changed here, not published yet — was On.");
});

it("an unchanged row rests", () => {
  eq(rowMark("installScript", base, {}, null, ORDER), { kind: "rest" });
  eq(markHint({ kind: "rest" }), null);
});

it("a queued change keeps its mark and says it already works here", () => {
  const pending = {
    fields: { verifyPipeline: [{ kind: "script", path: "scripts/verify.sh" }] },
    pullRequests: {},
    repository: { ...base, verifyPipeline: null },
  };
  const mark = rowMark("verifyPipeline", base, {}, pending, ORDER);
  eq(mark, { kind: "queued", was: "None" });
  eq(
    markHint(mark),
    "Changed here, not published yet — was nothing. It works on this Mac already.",
  );
  // C12 (AR-4): the areas say there were none.
  eq(markHint({ kind: "draft", n: 1, was: "None" }, "areas"), "Changed here, not published yet — there were no areas before.");
  eq(markHint({ kind: "draft", n: 1, was: "2 areas" }, "areas"), "Changed here, not published yet — was 2 areas.");
  eq(wasWords("versionFiles", "None"), "was nothing");
});

it("a change waiting in a pull request names it", () => {
  const pending = {
    fields: { installScript: "scripts/install.sh" },
    pullRequests: { installScript: 412 },
    repository: { ...base, installScript: null },
  };
  const mark = rowMark("installScript", base, {}, pending, ORDER);
  // W6 (1.174.0): After a release, run says its empty choice as the menu does.
  eq(mark, { kind: "pullRequest", was: "Nothing", number: 412 });
  eq(markHint(mark)?.includes("pull request #412"), true);
});

it("a draft on a row that is already queued wins the mark", () => {
  const pending = {
    fields: { installScript: "scripts/install.sh" },
    pullRequests: {},
    repository: { ...base, installScript: null },
  };
  // Touched and put back: no draft change, so the queued mark is what shows.
  const mark = rowMark("installScript", base, { installScript: null }, pending, ORDER);
  eq(mark.kind, "queued");
  const other = rowMark(
    "installScript",
    { ...base, installScript: "scripts/install.sh" },
    { installScript: "scripts/other.sh" },
    pending,
    ORDER,
  );
  eq(other, { kind: "draft", n: 1, was: "scripts/install.sh" });
});

// ── The publish bar ────────────────────────────────────────────────────

it("a draft raises the bar with one jump per change", () => {
  const list = changes(ORDER, base, {
    verifyPipeline: [{ kind: "script", path: "scripts/verify.sh" }],
    sharedBuildCache: false,
  });
  const bar = publishBar(list, "staging", null);
  eq(bar?.kind, "draft");
  if (bar?.kind !== "draft") throw new Error("not a draft bar");
  eq(bar.sentence, "2 changes · reaches everyone who opens this repository");
  eq(
    bar.jumps.map((j) => `${j.n} ${j.label}`),
    ["1 Checks before shipping", "2 Shared build cache"],
  );
  eq(bar.publishLabel, "Publish to staging");
});

const pending = (over: Partial<PendingPublish> = {}): PendingPublish => ({
  queued: [],
  creating: false,
  pullRequest: null,
  offline: false,
  lastError: null,
  ...over,
});

it("C3: a field both sides changed waits for a choice, never 'Publishing…'", () => {
  const bar = publishBar(
    [],
    "staging",
    pending({ queued: ["verifyPipeline", "name"], choosing: [{ field: "verifyPipeline", label: "Verify pipeline" }] }),
  );
  eq(bar?.kind, "choosing");
  if (bar?.kind !== "choosing") throw new Error("not the choosing bar");
  eq(bar.sentence, "Waiting for your choice: Verify pipeline");
  eq(bar.field, "verifyPipeline");
  eq(bar.detail.includes("once you choose"), true);
  // Nothing held: as before.
  eq(publishBar([], "staging", pending({ queued: ["name"], choosing: [] }))?.kind, "publishing");

  const base = { verifyPipeline: [{ kind: "script", path: "scripts/mine.sh" }] } as never;
  const mark = rowMark(
    "verifyPipeline",
    base,
    {},
    {
      fields: { verifyPipeline: [{ kind: "script", path: "scripts/ppvp.sh" }] },
      pullRequests: {},
      repository: base,
      choosing: ["verifyPipeline"],
    },
    ORDER,
  );
  eq(mark.kind, "choosing");
  eq(markHint(mark), "Changed here and in the repository too — waiting for your choice. It works on this Mac already.");
});

it("C3: the view's held fields reach the bar and the rows", () => {
  const view = {
    cache: { definition: { schemaVersion: 1, name: "Ply", board: "local" }, branch: "main", author: null, pending: { name: "Ply 2" } },
    effective: { schemaVersion: 1, name: "Ply 2", board: "local" },
    defaultBranch: "main",
    queue: { createDefinition: false, fields: { name: { pullRequest: null } }, createPullRequest: null, lastError: null },
    conflicts: [{ field: "name", label: "Name" }],
  };
  const repo = deriveRepository({ view: view as never, config: null, review: null, workspace: null });
  eq(repo.publishing?.choosing, [{ field: "name", label: "Name" }]);
  eq(repo.pending?.choosing, ["name"]);
});

it("offline, the bar waits and says the change works here", () => {
  const bar = publishBar([], "staging", pending({ queued: ["verifyPipeline"], offline: true }));
  eq(bar?.kind, "waiting");
  if (bar?.kind !== "waiting") throw new Error("not the waiting bar");
  eq(bar.sentence, "Waiting to publish — you're offline");
  eq(bar.detail.includes("works on this Mac"), true);
  eq(bar.detail.includes("staging"), true);
});

it("a queue held up since a previous launch says why, not 'publishing'", () => {
  // F19: nothing is running, and no refresh report is coming to say so —
  // the queue's own error is what the page has to go on.
  const bar = publishBar(
    [],
    "staging",
    pending({ queued: ["verifyPipeline"], lastError: "could not resolve host github.com" }),
  );
  eq(bar?.kind, "waiting");
  if (bar?.kind !== "waiting") throw new Error("not the waiting bar");
  eq(bar.sentence, "Waiting to publish to staging");
  eq(bar.detail.includes("could not resolve host github.com"), true);
  eq(bar.detail.includes("next Sync"), true);
});

it("a definition that has never reached the branch waits too", () => {
  // F20: the whole file is queued, with no field of its own.
  const bar = publishBar([], "staging", pending({ creating: true, offline: true }));
  eq(bar?.kind, "waiting");
  eq(bar?.sentence, "Waiting to publish — you're offline");
  eq(
    publishBar([], "staging", pending({ creating: true, pullRequest: 7 }))?.kind,
    "pullRequest",
  );
});

it("a waiting pull request is the bar's whole message", () => {
  const bar = publishBar([], "staging", pending({ queued: ["installScript"], pullRequest: 412 }));
  eq(bar?.kind, "pullRequest");
  eq(bar?.sentence, "Waiting in pull request #412");
});

it("a queue draining says so, and nothing pending says nothing", () => {
  eq(publishBar([], "staging", pending({ queued: ["installScript"] }))?.kind, "publishing");
  eq(publishBar([], "staging", pending()), null);
  eq(publishBar([], "staging", null), null);
});

it("a draft outranks a waiting publish in the bar", () => {
  const list = changes(ORDER, base, { sharedBuildCache: false });
  const bar = publishBar(list, "staging", pending({ queued: ["installScript"], pullRequest: 412 }));
  eq(bar?.kind, "draft");
});

// ── The review sheet and the commit ────────────────────────────────────

it("the review names the count and promises one commit", () => {
  eq(reviewTitle(2), "Review 2 changes");
  eq(reviewTitle(1), "Review 1 change");
  eq(changeWord(1), "1 change");
  eq(reviewLede("staging").startsWith("Publishing makes one commit on staging."), true);
});

it("the commit message is the one the channel writes", () => {
  const list = changes(ORDER, base, {
    verifyPipeline: [{ kind: "script", path: "scripts/verify.sh" }],
    sharedBuildCache: false,
    accentColor: "#8b5cf6",
  });
  eq(commitMessage(list), [
    "chore(config): “Checks before shipping” — none → scripts/verify.sh",
    "chore(config): “Shared build cache” — true → false",
  ]);
  eq(describeValue(null), "none");
  eq(describeValue([]), "none");
  eq(describeValue(files), "frontend/package.json, api/pyproject.toml");
});

it("General's own fields are numbered on their own page", () => {
  const list = changes(GENERAL_FIELDS, base, { name: "LYRA" });
  eq(
    list.map((c) => [c.n, c.label, c.fromText, c.toText]),
    [[1, "Name", "LYRA - Jun 2025", "LYRA"]],
  );
  eq(commitMessage(list), ["chore(config): “Name” — LYRA - Jun 2025 → LYRA"]);
  // R8 Challenger minor: a subject past 100 characters is cut, every line
  // follows in full (`commit_message::config_message`).
  const long = commitMessage([{ key: "name", from: "a", to: "b ".repeat(60) } as never]);
  eq(long.length, 3);
  eq([...long[0]].length <= 100 && long[0].endsWith("…"), true);
  eq(long[1], "");
  eq(long[2].startsWith("chore(config): “Name” — a → b b"), true);
  eq(rowLabel("accentColor"), "Workspace colour", "the page's word");
// QoL 1.168 G10 (Windows walk): "shared" only where the repository shares.
eq(accentColorRowLabel(true), "Workspace colour (shared with everyone who opens this repository)", "a sharing repository");
eq(accentColorRowLabel(false), "Workspace colour", "a repository that shares nothing");
  eq(commitMessage(changes(GENERAL_FIELDS, base, { accentColor: "#22d3ee" })), [
    "chore(config): “Accent color” — none → #22d3ee",
  ]);
});

// ── Leaving a draft ────────────────────────────────────────────────────

it("leaving asks once, and says a draft reaches nobody", () => {
  const list = changes(ORDER, base, {
    verifyPipeline: [{ kind: "script", path: "scripts/verify.sh" }],
    sharedBuildCache: false,
  });
  eq(leaveQuestion(list.length), "Leave with 2 changes nobody else has?");
  eq(
    leaveBody(list),
    "Checks before shipping and Shared build cache are changed on this page only. " +
      "Nobody gets them — this Mac included — until you publish.",
  );
  eq(
    leaveBody(changes(ORDER, base, { sharedBuildCache: false })),
    "Shared build cache is changed on this page only. " +
      "Nobody gets it — this Mac included — until you publish.",
  );
  // G2 Windows walk: this PC on Windows.
  eq(
    leaveBody(changes(ORDER, base, { sharedBuildCache: false }), "windows"),
    "Shared build cache is changed on this page only. " +
      "Nobody gets it — this PC included — until you publish.",
  );
  eq(
    leaveBody(changes(ORDER, base, { sharedBuildCache: false }), "mac"),
    "Shared build cache is changed on this page only. " +
      "Nobody gets it — this Mac included — until you publish.",
  );
  eq(listWords(["A", "B", "C"]), "A, B and C");
});

// ── One save carries every changed field ───────────────────────────────

it("the save is the definition it opened on plus every change", () => {
  const definition: WorkspaceDefinition = {
    schemaVersion: 1,
    name: "LYRA - Jun 2025",
    board: "githubIssues",
    githubOwnerRepo: "MatteoB-adv/lyra-jun-2025",
    integrationBranch: "staging",
    versionFiles: files,
  };
  const payload = savePayload(definition, ORDER, base, {
    verifyPipeline: [{ kind: "script", path: "scripts/verify.sh" }],
    sharedBuildCache: false,
    installScript: null,
  });
  eq(payload.name, "LYRA - Jun 2025", "untouched fields travel as they were");
  eq(payload.githubOwnerRepo, "MatteoB-adv/lyra-jun-2025");
  eq(payload.verifyPipeline, [{ kind: "script", path: "scripts/verify.sh" }]);
  eq(payload.sharedBuildCache, false);
  eq("installScript" in payload, false, "touched and put back is not a change");
  eq(
    Object.keys(payload).filter((k) => !(k in definition)),
    ["verifyPipeline", "sharedBuildCache"],
    "one call, every change: the channel makes one commit",
  );
});

// ── The review's own words, and the draft's housekeeping ──────────────

it("Review says what the lists are, while the rows keep their counts", () => {
  // F8, F21: '2 files → 2 files' tells the person nothing about what they
  // are publishing.
  const swapped: VersionFileEntry[] = [
    files[0],
    { path: "api/app/version.py", kind: "python_module_var", variableName: "__version__" },
  ];
  const [change] = changes(ORDER, base, { versionFiles: swapped });
  eq(change.fromText, "2 files", "the row is a glance");
  eq(change.toText, "2 files");
  eq(change.fromDetail, "frontend/package.json, api/pyproject.toml");
  eq(change.toDetail, "frontend/package.json, api/app/version.py");
  eq(detailText("cachePaths", ["a/b", "c/d"]), "a/b, c/d");
  eq(
    detailText("reviewChecklist", [{ name: "Branch discovery", sentence: "Names the remote." }]),
    "Branch discovery — Names the remote.",
  );
  eq(detailText("versionFiles", []), "None");
  eq(detailText("sharedBuildCache", false), "Off", "a switch reads the same either way");
});

it("a value put back as it was leaves no key behind", () => {
  // F6: a key left in the draft is invisible while the baseline agrees, and
  // becomes a change — publishable over someone else's — after a refresh.
  const touched: Draft = { name: base.name, sharedBuildCache: true, installScript: null };
  eq(changes(ORDER, base, touched), [], "nothing shows while it agrees");
  eq(Object.keys(pruneDraft(base, touched)), []);
  // The same draft against a repository that has moved on: without the
  // pruning, the old values would be published back over the new ones.
  const moved: Values = { ...base, sharedBuildCache: false };
  eq(
    changes(ORDER, moved, touched).map((c) => c.key),
    ["sharedBuildCache"],
    "a stale key would republish the old value",
  );
  eq(changes(ORDER, moved, pruneDraft(base, touched)), []);
  // A real change survives the pruning.
  eq(Object.keys(pruneDraft(base, { ...touched, installScript: "scripts/install.sh" })), [
    "installScript",
  ]);
});

it("Put back returns a file where the repository has it", () => {
  // F15: appending it would publish an invisible reorder, and the row
  // would stay marked although nothing changed.
  const removed = withoutFile(files, files[0].path);
  eq(removed.length, 1);
  const back = restoreFile(removed, files, files[0].path);
  eq(back, files, "the list is the published one again");
  eq(changes(ORDER, base, { versionFiles: back }), [], "so the change is gone");
  // A file added since keeps its place after the published ones.
  const added: VersionFileEntry = { path: "Cargo.toml", kind: "cargo_toml" };
  eq(
    restoreFile([files[1], added], files, files[0].path).map((f) => f.path),
    ["frontend/package.json", "api/pyproject.toml", "Cargo.toml"],
  );
  eq(restoreFile(files, files, files[0].path), files, "already there: nothing moves");
  eq(restoreFile(removed, files, "nothing/here.json"), removed, "unknown: nothing moves");
});

it("a read-only row names the author and the day", () => {
  // F10: the footer gives way when the authors differ, so the row carries
  // both halves of "who set it and when".
  eq(
    readOnlyRowLine({ author: "MatteoB-adv", changedAt: 1_789_603_200 }),
    "Set by MatteoB-adv on 17 Sep 2026.",
  );
  eq(readOnlyRowLine(undefined), null);
});

it("a Python source file is refused, with where it comes from instead", () => {
  // F22: which variable carries the version can only be told by reading the
  // file, and a guess publishes a file Ship then cannot bump.
  eq(versionFileFor("api/app/version.py"), null);
  eq(whyNotAVersionFile("api/app/version.py").includes("Re-detect"), true);
  eq(whyNotAVersionFile("README.md").includes("package.json"), true);
});

it("the install script is described where it really runs", () => {
  // F24: not before a build. 1.174.0 (A1, owner): after a release, or after
  // Ship it on this Mac — never after Ship it's pull request; no "commit and
  // tag" (Ship it on GitHub makes neither on this Mac).
  const hint = restingHint("installScript", "scripts/install-local.sh");
  eq(
    hint,
    "scripts/install-local.sh runs after a release, or after Ship it on this Mac — not when Ship it opens a pull request.",
  );
  eq(hint.includes("before an agent builds"), false);
  eq(restingHint("installScript", null), "None — nothing is built or installed after a release.");
  // 1.175.0 B2: and that the other computers ask before they run it.
  eq(
    consequenceOf("installScript", "scripts/install-local.sh"),
    "It will run after a release, or after Ship it on this Mac. Every other computer asks its person (Allow and run) before it runs the new install step.",
  );
  eq(consequenceOf("installScript", null), "Nothing will run after a release.");
  eq(consequenceOf("installScript", null), "Nothing will run after a release.");
  eq(rowLabel("installScript"), "After a release, run");
  for (const line of [hint, restingHint("installScript", null), consequenceOf("installScript", null)]) {
    eq(/commit|tag/.test(line), false);
  }
  setPlatformForTests("windows");
  eq(restingHint("installScript", "x.sh"), "x.sh runs after a release, or after Ship it on this PC — not when Ship it opens a pull request.");
  eq(
    consequenceOf("installScript", "x.sh"),
    "It will run after a release, or after Ship it on this PC. Every other computer asks its person (Allow and run) before it runs the new install step.",
  );
  setPlatformForTests(null);
});

it("a first build setting says what else it takes with it", () => {
  // F25: a repository cannot hold half a project, so the channel fills the
  // rest from this Mac — Review says so before Publish does it.
  const list = changes(ORDER, base, { sharedBuildCache: false });
  const note = firstSharedProjectNote(false, base, list);
  eq(note?.includes("shares no build settings yet"), true);
  eq(note?.includes("“Cards go to” (staging)"), true);
  eq(note?.includes("“Version files” (2 files)"), true);
  eq(note?.includes("Shared build cache"), false, "what is being published is not 'the rest'");
  eq(firstSharedProjectNote(true, base, list), null, "it already shares them");
  eq(
    firstSharedProjectNote(false, base, changes(GENERAL_FIELDS, base, { name: "LYRA" })),
    null,
    "a general field brings no project part",
  );
  eq(firstSharedProjectNote(false, {}, list), null, "nothing of its own to take along");
});

it("a publish clears what it carried, and nothing edited since", () => {
  // F1, F3: the save can wait behind a refresh, and a row changed while it
  // waits was never sent — clearing the whole draft would lose it.
  const sent: Draft = { verifyPipeline: [{ kind: "script", path: "scripts/verify.sh" }] };
  const meanwhile: Draft = { ...sent, sharedBuildCache: false };
  eq(Object.keys(clearSent(meanwhile, sent)), ["sharedBuildCache"]);
  // The same row changed again while its own publish was in flight keeps
  // the newer value: it has not been published.
  const changedAgain: Draft = { verifyPipeline: null };
  eq(clearSent(changedAgain, sent), changedAgain);
  eq(Object.keys(clearSent(sent, sent)), [], "what landed goes");
  eq(clearSent({}, sent), {}, "a draft already pruned stays empty");
});

it("a cache path Plyloft would drop is refused where it is typed", () => {
  // `worktrees.rs::cache_rel_paths` keeps only plain relative paths and
  // says nothing about the rest, so the row must not publish one.
  eq(cachePathProblem("frontend/node_modules"), null);
  eq(cachePathProblem("target/"), null, "a trailing slash is fine");
  eq(cachePathProblem("/tmp/build")?.includes("can't start with /"), true);
  eq(cachePathProblem("../outside")?.includes("no . or .."), true);
  eq(cachePathProblem("a/../b")?.includes("no . or .."), true);
  eq(cachePathProblem("./here")?.includes("no . or .."), true);
  eq(cachePathProblem("a//b")?.includes("no . or .."), true);
  eq(cachePathProblem("   "), "A path is needed.");
  eq(cachePathProblem("C:/x"), null, "the Mac reads it as it always has");
});

it("on Windows a cache path is still relative and still uses / (W5)", () => {
  setPlatformForTests("windows");
  try {
    eq(cachePathProblem("frontend/node_modules"), null);
    eq(cachePathProblem("target\\"), null, "a trailing separator is fine");
    eq(cachePathProblem("C:\\build")?.includes("can't start with a drive"), true);
    eq(cachePathProblem("C:/build")?.includes("can't start with a drive"), true);
    eq(cachePathProblem("\\\\server\\share")?.includes("can't start with a drive"), true);
    eq(cachePathProblem("/tmp/build")?.includes("can't start with a drive"), true);
    eq(cachePathProblem("frontend\\node_modules")?.includes("separated by /"), true);
  } finally {
    setPlatformForTests(null);
  }
});

// ── This Mac's own config ──────────────────────────────────────────────

it("1.174.0 (DS2): each row is on one page, and Shipping holds the path after the build", () => {
  eq([...SHIPPING_FIELDS], ["integrationBranch", "installScript", "releaseKind", "versionFiles"]);
  eq([...SHIPPING_ORDER], ["integrationBranch", "installScript", "releaseKind", "areas", "versionFiles"]);
  eq(BUILD_FIELDS.some((k) => (SHIPPING_ORDER as readonly string[]).includes(k)), false, "no row on two pages");
  eq([...BUILD_FIELDS, ...SHIPPING_FIELDS].filter(isConfigField).sort(), [...ORDER.filter(isConfigField)].sort());
  // P37, T24, SL-2, owner (A1): the rows' names.
  eq(
    (["integrationBranch", "installScript", "versionFiles", "verifyPipeline", "selfCheck", "worktreeSetup"] as const).map(rowLabel),
    [
      "Cards go to",
      "After a release, run",
      "Version files",
      "Checks before shipping",
      "The Builder checks its own work first",
      "Before the Builder starts, run",
    ],
  );
  eq(restingHint("integrationBranch", "main"), "The branch every card's change goes to, and new cards start from.");
  eq(valueText("installScript", null), "Nothing");
  // A change Building and checking drafts never joins Shipping's Review, nor
  // the other way round: each page numbers only its own rows.
  const draft = { installScript: "scripts/install.sh", verifyPipeline: [{ kind: "script", path: "v.sh" }] };
  eq(changes(SHIPPING_ORDER, base, draft).map((c) => c.key), ["installScript"]);
  eq(changes(BUILD_FIELDS, base, draft).map((c) => c.key), ["verifyPipeline"]);
});

it("each field goes to the one place this Mac keeps it", () => {
  // The name and the accent belong to the workspace record, the self-check
  // and the classes to review.json: neither is written into config.json.
  eq(ORDER.filter(isConfigField), [
    "integrationBranch",
    "verifyPipeline",
    "installScript",
    "versionFiles",
    "sharedBuildCache",
    "cachePaths",
  ]);
  eq(GENERAL_FIELDS.filter(isConfigField), []);
  eq(isConfigField("selfCheck"), false);
  eq(isConfigField("reviewChecklist"), false);
});

it("a local change writes the whole config, each field in its own key", () => {
  const config: ProjectConfig = {
    schemaVersion: 2,
    targetBranch: "develop",
    versionFiles: files,
    installScript: "scripts/install.sh",
    createdAt: 7,
    updatedAt: 8,
  };
  const next = patchConfig(config, {
    verifyPipeline: [{ kind: "script", path: "scripts/verify.sh" }],
    sharedBuildCache: false,
    cachePaths: ["frontend/node_modules"],
    versionFiles: [],
    name: "ignored here",
    selfCheck: false,
  });
  eq(next.targetBranch, "develop", "an untouched field keeps its value");
  eq(next.installScript, "scripts/install.sh");
  eq(next.createdAt, 7);
  eq(next.verifyPipeline, [{ kind: "script", path: "scripts/verify.sh" }]);
  eq(next.sharedBuildCache, false);
  eq(next.cachePaths, ["frontend/node_modules"]);
  eq(next.versionFiles, []);
  eq("name" in next, false, "the workspace's own fields stay out of the config");
  eq("selfCheck" in next, false, "review.json keeps the self-check");
  // None is null, never an empty step list the pipeline would run.
  eq(patchConfig(config, { verifyPipeline: [] }).verifyPipeline, null);
  eq(patchConfig(config, { installScript: "" }).installScript, null);
  eq(patchConfig(config, { integrationBranch: "" }).targetBranch, "develop");
});

// ── Words on the rows ──────────────────────────────────────────────────

it("the Name row says when this Mac keeps a name of its own (owner, 2026-10-20)", () => {
  const plain = "What everyone sees in the sidebar.";
  eq(nameHint(true, { name: "Theirs", chosen: false }, "Theirs"), plain);
  eq(nameHint(false, { name: "Mine", chosen: true }, "Mine"), plain, "not shared: the name is only this Mac's");
  eq(nameHint(true, null, "Theirs"), plain);
  eq(
    nameHint(true, { name: "Mine", chosen: true }, "Theirs"),
    "What everyone sees in the sidebar, unless they named the workspace themselves. You named it “Mine” on this Mac.",
  );
  eq(
    nameHint(true, { name: "Theirs", chosen: true }, "Theirs"),
    "What everyone sees in the sidebar, unless they named the workspace themselves.",
  );
});

it("a row says what is true now", () => {
  // T25 (1.174.0).
  eq(restingHint("verifyPipeline", null), "None — nothing checks a card before it ships.");
  eq(restingHint("installScript", null), "None — nothing is built or installed after a release.");
  eq(
    restingHint("versionFiles", files),
    "Bumped together on every release — frontend/package.json and 1 more.",
  );
  eq(restingHint("cachePaths", null), "None — only the dependency folders are shared.");
  eq(valueText("versionFiles", files), "2 files");
  eq(valueText("versionFiles", []), "None");
  eq(andMore(["a"]), "a");
  eq(andMore(["a", "b", "c", "d", "e"]), "a and 4 more");
});

it("the review says the consequence in words", () => {
  eq(consequenceOf("verifyPipeline", null), "Nothing will check a card before it ships.");
  // 1.175.0 B2: and that the other computers ask before they run them.
  eq(
    consequenceOf("verifyPipeline", [{ kind: "script", path: "v.sh" }]),
    "These checks will run before anything ships. Every other computer asks its person (Allow and run) before it runs the new checks.",
  );
  eq(consequenceOf("verifyPipeline", []), "Nothing will check a card before it ships.");
  eq(
    consequenceOf("sharedBuildCache", false),
    "Every agent will install the dependencies itself. First runs get slower.",
  );
});

// ── The status line ────────────────────────────────────────────────────

const now = 1_700_000_000;

it("the shared status names the branch, the author and the age", () => {
  const view = statusLine(
    {
      branch: "staging",
      author: "MatteoB-adv",
      changedAt: now - 12 * 3600,
      readOnly: false,
      repository: "MatteoB-adv/lyra-jun-2025",
      offline: false,
      local: false,
    },
    now,
  );
  eq(view.state, "done");
  if (view.kind !== "shared") throw new Error("not shared");
  eq(view.branch, "staging");
  eq(view.tail, ", last changed by MatteoB-adv 12 h ago.");
});

it("read-only says who to ask; offline says Plyloft can't reach it", () => {
  const ro = statusLine(
    {
      branch: "staging",
      author: "MatteoB-adv",
      changedAt: null,
      readOnly: true,
      repository: "MatteoB-adv/lyra-jun-2025",
      offline: false,
      local: false,
    },
    now,
  );
  eq(ro.kind, "readOnly");
  eq(ro.state, "empty");
  if (ro.kind !== "readOnly") throw new Error("not read-only");
  eq(
    ro.text,
    "You can read this page. Changing it needs write access to MatteoB-adv/lyra-jun-2025. Ask MatteoB-adv.",
  );
  const off = statusLine(
    {
      branch: "staging",
      author: null,
      changedAt: null,
      readOnly: false,
      repository: null,
      offline: true,
      local: false,
    },
    now,
  );
  eq(off.kind, "offline");
  eq(off.state, "empty");
});

it("a branch origin lacks is said as such, never as offline (F3/F9)", () => {
  const MISSING =
    "walk-base isn't on GitHub any more. Choose where cards go in Settings › Cards › Shipping.";
  const pending = {
    queued: ["board"],
    creating: false,
    pullRequest: null,
    offline: false,
    lastError: MISSING,
  };
  eq(isBranchMissing(pending), true);
  eq(isBranchMissing({ ...pending, offline: true }), false);
  eq(isBranchMissing({ ...pending, lastError: "no git identity" }), false);
  eq(isBranchMissing(null), false);
  const view = statusLine(
    {
      branch: "walk-base",
      author: null,
      changedAt: null,
      readOnly: false,
      repository: null,
      offline: false,
      branchMissing: isBranchMissing(pending),
      local: false,
    },
    now,
  );
  eq(view.kind, "branchMissing");
  eq(view.state, "empty");
  if (view.kind !== "branchMissing") throw new Error("not branchMissing");
  eq(view.branch, "walk-base");
  eq(view.tail.startsWith(" isn't on GitHub any more"), true);
  eq(/offline/.test(view.tail), false);
  const bar = publishBar([], "walk-base", pending);
  eq(bar?.kind, "waiting");
  if (bar?.kind !== "waiting") throw new Error("not waiting");
  eq(bar.sentence, "Not published — walk-base isn't on GitHub any more");
  eq(/offline|Publishing/.test(bar.sentence + bar.detail), false);
  eq(bar.detail.includes(MISSING), true);
});

it("with no shared definition the page says the settings are this Mac's", () => {
  const view = statusLine(
    {
      branch: "main",
      author: null,
      changedAt: null,
      readOnly: false,
      repository: null,
      offline: false,
      local: true,
    },
    now,
  );
  eq(view.kind, "local");
  if (view.kind !== "local") throw new Error("not local");
  eq(view.text.includes("this Mac's own"), true);
  eq(view.text.includes("Saved as you change them."), true);
});

it("the read-only footer speaks once when one author set everything", () => {
  const same = { author: "MatteoB-adv", changedAt: 1_789_603_200 };
  eq(
    readOnlyFooter(ORDER, { integrationBranch: same, versionFiles: same }, null),
    "Every setting on this page was set by MatteoB-adv on 17 Sep 2026.",
  );
  eq(
    readOnlyFooter(
      ORDER,
      { integrationBranch: same, versionFiles: { author: "Someone", changedAt: same.changedAt } },
      null,
    ),
    null,
    "authors differ: the rows carry their own hints",
  );
  eq(
    readOnlyFooter(ORDER, undefined, "MatteoB-adv"),
    "Every setting on this page was set by MatteoB-adv.",
  );
});

// ── The Version files sub-page ─────────────────────────────────────────

it("a removed file keeps its place, struck through, until it is published", () => {
  const rows = versionFileRows(files, withoutFile(files, "api/pyproject.toml"));
  eq(
    rows.map((r) => [r.file.path, r.removed]),
    [
      ["frontend/package.json", false],
      ["api/pyproject.toml", true],
    ],
  );
  eq(versionFileRows(files, null).every((r) => !r.removed), true);
});

it("an added file sits after the published ones", () => {
  const added: VersionFileEntry = { path: "Cargo.toml", kind: "cargo_toml" };
  const rows = versionFileRows(files, [...files, added]);
  eq(rows.length, 3);
  eq(rows[2].file.path, "Cargo.toml");
  eq(rows[2].removed, false);
});

it("Plyloft reads a chosen file's kind from its name, or refuses it", () => {
  eq(versionFileFor("frontend/package.json")?.kind, "package_json");
  eq(versionFileFor("src-tauri/Cargo.toml")?.kind, "cargo_toml");
  eq(versionFileFor("api/pyproject.toml")?.kind, "py_project_toml");
  eq(versionFileFor("README.md"), null);
  eq(versionFileKindWords(files[0]), "npm package");
  eq(versionFileKindWords(files[1]), "Python project");
});

// ── One page, the scope changes (ADR 0004) ────────────────────────────

it("the same fields serve both scopes; only the words around them differ", () => {
  // With a shared definition the page publishes; without one it edits this
  // Mac's config under the same field names and saves as it changes.
  const local: Values = { ...base, integrationBranch: "main", versionFiles: [] };
  eq(valueText("integrationBranch", local.integrationBranch), "main");
  eq(valueText("versionFiles", local.versionFiles), "None");
  eq(restingHint("versionFiles", local.versionFiles).startsWith("None —"), true);
  // No draft is kept in the local scope, so no bar rises.
  eq(publishBar([], "main", null), null);
  // And the status line says which page you are on.
  const shared = statusLine(
    { branch: "staging", author: "MatteoB-adv", changedAt: now, readOnly: false,
      repository: "o/r", offline: false, local: false },
    now,
  );
  const mac = statusLine(
    { branch: "main", author: null, changedAt: null, readOnly: false,
      repository: null, offline: false, local: true },
    now,
  );
  eq(shared.kind, "shared");
  eq(mac.kind, "local");
});

// ── The accent colours ────────────────────────────────────────────────

it("an accent is named, and one of its own says so", () => {
  eq(ACCENT_CHOICES.map((c) => c.name), ["Violet", "Cyan", "Magenta", "Sunset"]);
  eq(accentName(ACCENT_CHOICES[1].value), "Cyan");
  eq(accentName(ACCENT_CHOICES[1].value.toUpperCase()), "Cyan");
  eq(accentName(null), "None — the theme's own");
  eq(accentName("#123456"), "Custom colour");
});

// GH #272: one palette for the field. Every colour the older pickers stored
// (the switcher's seven, General's first four) is shown chosen as a preset,
// painted as that preset, and never named by its hex.
it("a colour from an older picker reads as the nearest preset", () => {
  const legacy: [string, string][] = [
    ["#7c3aed", "Violet"], ["#2563eb", "Cyan"], ["#0d9488", "Cyan"], ["#16a34a", "Cyan"],
    ["#ca8a04", "Sunset"], ["#dc2626", "Sunset"], ["#db2777", "Magenta"],
    ["#8b5cf6", "Violet"], ["#22d3ee", "Cyan"], ["#f472b6", "Magenta"], ["#ffa647", "Sunset"],
  ];
  for (const [stored, name] of legacy) {
    eq(accentName(stored), name, stored);
    eq(accentName(stored.toUpperCase()), name, stored);
    const chosen = accentChoice(stored);
    eq(chosen?.name, name, stored);
    eq(resolveAccent(stored), chosen?.value, stored);
  }
  // Each circle shows the value it writes.
  for (const c of ACCENT_CHOICES) eq(c.color, c.value, c.id);
  // A colour from elsewhere is kept and called custom, with no hex.
  eq(resolveAccent("#123456"), "#123456");
  eq(resolveAccent(""), null);
  eq(valueText("accentColor", "#7c3aed"), "Violet");
  eq(valueText("accentColor", "#123456"), "Custom colour");
});

// ── Leaving a draft goes through the guard ────────────────────────────

it("a page with a draft holds the move until it answers", () => {
  let went = 0;
  leavePage(() => went++);
  eq(went, 1, "nothing registered: the move goes through");

  let held: (() => void) | null = null;
  const guard = (proceed: () => void) => {
    held = proceed;
    return false;
  };
  setLeaveGuard(guard);
  eq(hasLeaveGuard(), true);
  leavePage(() => went++);
  eq(went, 1, "the page asked first");
  (held as unknown as () => void)();
  eq(went, 2, "and the page let it through itself");

  clearLeaveGuard(guard);
  eq(hasLeaveGuard(), false);
  leavePage(() => went++);
  eq(went, 3);

  // A page that unmounts after another registered must not take the new
  // guard down with it.
  const newer = () => false;
  setLeaveGuard(newer);
  clearLeaveGuard(guard);
  eq(hasLeaveGuard(), true);
  clearLeaveGuard(newer);
});


// ── What the pages make of what Ply read (F38) ────────────────────────

const view = (over: Record<string, unknown> = {}): DefinitionViewLike => {
  const definition: WorkspaceDefinition = {
    schemaVersion: 1,
    name: "LYRA - Jun 2025",
    board: "githubIssues",
    githubOwnerRepo: "MatteoB-adv/lyra-jun-2025",
    integrationBranch: "staging",
    versionFiles: files,
    ...((over.definition as object) ?? {}),
  };
  return {
    cache: {
      definition,
      branch: "staging",
      author: "MatteoB-adv",
      changedAt: now - 3600,
      pending: {},
    },
    effective: definition,
    defaultBranch: "main",
    queue: {
      createDefinition: false,
      fields: {},
      createPullRequest: null,
      lastError: null,
      lastOffline: false,
    },
    ...over,
  } as DefinitionViewLike;
};

const config: ProjectConfigLike = {
  targetBranch: "develop",
  versionFiles: [{ path: "Cargo.toml", kind: "cargo_toml" }],
  installScript: "scripts/install.sh",
  verifyPipeline: [{ kind: "script", path: "scripts/ppvp.sh" }],
  cachePaths: ["target"],
  sharedBuildCache: false,
};

const workspace: WorkspaceLike = {
  name: "LYRA - Jun 2025",
  accentColor: null,
  kanbanSyncMode: "githubIssues",
  githubOwnerRepo: "MatteoB-adv/lyra-jun-2025",
};

it("Try it: a start command queued alone still shows the band", () => {
  // Its row saves on its own, so it is never in the draft; the queue is what
  // says it is on its way.
  const derived = deriveRepository({
    view: view({
      cache: { ...view().cache, pending: { tryCommand: "npm run dev" } },
      queue: {
        createDefinition: false,
        fields: { tryCommand: { pullRequest: null } },
        createPullRequest: null,
        lastError: null,
        lastOffline: false,
      },
    }),
    config,
    review: { selfCheck: true, reviewChecklist: [] },
    workspace,
  });
  eq(derived.publishing!.queued, ["tryCommand"]);
  eq(derived.pending!.fields.tryCommand, "npm run dev");
  eq(publishBar([], "staging", derived.publishing)!.kind, "publishing");
});

it("teamfix (C4): the winner's own merged creation pull request is never 'shared first'", () => {
  const withCreation = (creationOpen: number | null) =>
    deriveRepository({
      view: view({
        cache: { ...view().cache, source: "repo", author: "example-teammate", pending: {} },
        queue: {
          createDefinition: false,
          fields: {},
          createPullRequest: { number: 215 },
          creationOpen,
          lastError: null,
          lastOffline: false,
        },
      }),
      config,
      review: { selfCheck: true, reviewChecklist: [] },
      workspace,
    });
  // Not known to be open (merged, or not asked yet): not "isn't needed".
  eq(withCreation(null).publishing!.sharedFirst, null);
  // GitHub said it is open, and the branch has the setup: somebody else's came first.
  eq(withCreation(215).publishing!.sharedFirst, { who: "example-teammate" });
});

it("teamfix (C5): read-only by a refused push offers the team's values, as the page says", () => {
  const derived = deriveRepository({
    view: {
      ...view({
        cache: { ...view().cache, pending: { verifyPipeline: null }, writeAccess: { canPush: true } },
        queue: { createDefinition: false, fields: { verifyPipeline: { pullRequest: null } }, createPullRequest: null, lastError: "main refused the push", lastOffline: false },
      }),
      readOnly: true,
    },
    config,
    review: { selfCheck: true, reviewChecklist: [] },
    workspace,
  });
  eq(derived.readOnly, true);
  eq(derived.publishing!.cantWrite != null, true);
  eq(publishBar([], "staging", derived.publishing)!.kind, "cantWrite");
});

it("a queue left offline says so when the page opens again", () => {
  // F19: no refresh report is coming — the queue is all the page has.
  const offline = deriveRepository({
    view: view({
      cache: { ...view().cache, pending: { verifyPipeline: null } },
      queue: {
        createDefinition: false,
        fields: { verifyPipeline: { pullRequest: null } },
        createPullRequest: null,
        lastError: "could not resolve host github.com",
        lastOffline: true,
      },
    }),
    config: null,
    review: null,
    workspace,
  });
  eq(offline.publishing?.offline, true);
  eq(publishBar([], "staging", offline.publishing)?.sentence, "Waiting to publish — you're offline");
  // A refresh Ply watched knows better than the queue's memory.
  const back = deriveRepository({
    view: view({
      cache: { ...view().cache, pending: { verifyPipeline: null } },
      queue: {
        createDefinition: false,
        fields: { verifyPipeline: { pullRequest: null } },
        createPullRequest: null,
        lastError: "could not resolve host github.com",
        lastOffline: true,
      },
    }),
    config: null,
    review: null,
    workspace,
    offlineNow: false,
  });
  eq(back.publishing?.offline, false);
  eq(publishBar([], "staging", back.publishing)?.kind, "waiting");
});

it("a definition waiting to be created is a pending publish of its own", () => {
  // F20: no field of its own is queued.
  const derived = deriveRepository({
    view: view({
      queue: {
        createDefinition: true,
        fields: {},
        createPullRequest: { number: 7 },
        lastError: null,
        lastOffline: false,
      },
    }),
    config: null,
    review: null,
    workspace,
  });
  eq(derived.publishing?.creating, true);
  eq(derived.publishing?.pullRequest, 7);
  eq(publishBar([], "staging", derived.publishing)?.kind, "pullRequest");
});

it("the Board reads the backing this Mac applied, not the one asked for", () => {
  // F23: a licence gate holds the board local although the definition
  // says GitHub Issues.
  const held = deriveRepository({
    view: view(),
    config: null,
    review: null,
    workspace: { ...workspace, kanbanSyncMode: "local" },
  });
  eq(held.board, "local");
  eq(held.repository, "MatteoB-adv/lyra-jun-2025", "the definition still lives there");
  eq(
    deriveRepository({ view: view(), config: null, review: null, workspace }).board,
    "githubIssues",
  );
});

it("a definition with no build settings shows this Mac's, and its own name", () => {
  // F25: the repository shares a name and a board only; the build settings
  // are still this Mac's, and they are what publishing one would share.
  const general: WorkspaceDefinition = {
    schemaVersion: 1,
    name: "Shared name",
    board: "githubIssues",
    githubOwnerRepo: "MatteoB-adv/lyra-jun-2025",
  };
  const derived = deriveRepository({
    view: view({ definition: general, effective: general, cache: { ...view().cache, definition: general } }),
    config,
    review: { selfCheck: true, reviewChecklist: [] },
    workspace,
  });
  eq(derived.shared, true);
  eq(derived.sharedProject, false);
  eq(derived.values.installScript, "scripts/install.sh", "this Mac's, not none");
  eq(derived.values.integrationBranch, "develop");
  eq(derived.values.name, "Shared name", "the name is the repository's");
  eq(hasProject(general), false);
  eq(hasProject(view().effective), true);
});

it("without a definition every value is this Mac's own", () => {
  const derived = deriveRepository({
    view: null,
    config,
    review: { selfCheck: false, reviewChecklist: [] },
    workspace,
  });
  eq(derived.shared, false);
  eq(derived.readOnly, false);
  eq(derived.branch, "develop", "the branch this Mac already ships to");
  eq(derived.values.selfCheck, false);
  eq(derived.publishing, null, "nothing to publish, so no bar");
  eq(derived.pending, null);
  // With no config either, the repository's default branch rather than a guess.
  eq(
    deriveRepository({ view: view({ effective: null }), config: null, review: null, workspace })
      .branch,
    "main",
  );
});

it("a first shared build field carries the rest of this Mac's with it", () => {
  // F36: the backend normalises a partial project part with defaults and
  // applies it here, so a payload of one field would wipe the rest.
  const general: WorkspaceDefinition = {
    schemaVersion: 1,
    name: "Shared name",
    board: "local",
  };
  const values = deriveRepository({
    view: view({ definition: general, effective: general, cache: { ...view().cache, definition: general } }),
    config,
    review: { selfCheck: true, reviewChecklist: [] },
    workspace,
  }).values;
  const payload = savePayload(general, ORDER, values, { sharedBuildCache: true }, {
    fillProject: true,
    branch: "develop",
  });
  eq(payload.sharedBuildCache, true, "what was edited");
  eq(payload.installScript, "scripts/install.sh", "and everything else this Mac runs");
  eq(payload.verifyPipeline, config.verifyPipeline);
  eq(payload.versionFiles, config.versionFiles);
  eq(payload.cachePaths, ["target"]);
  eq(payload.integrationBranch, "develop");
  eq(payload.name, "Shared name", "the definition's own fields are untouched");

  // Clearing the only local script still leaves a concrete project part,
  // so the change is applied rather than read as "no project".
  const cleared = savePayload(
    general,
    ORDER,
    { ...values, verifyPipeline: null, versionFiles: null, cachePaths: null },
    { installScript: null },
    { fillProject: true, branch: "develop" },
  );
  eq(cleared.installScript, null);
  eq(cleared.integrationBranch, "develop", "one field is always concrete");

  // Try it: this Mac's start command goes with a first share (it has no
  // field on the page), and never overrides one the draft carries.
  const withTry = savePayload(general, ORDER, values, { sharedBuildCache: true }, {
    fillProject: true,
    branch: "develop",
    tryCommand: "npm run dev",
  });
  eq(withTry.tryCommand, "npm run dev");
  eq(
    "tryCommand" in
      savePayload(general, ORDER, values, { sharedBuildCache: true }, {
        fillProject: false,
        branch: "develop",
        tryCommand: "npm run dev",
      }),
    false,
    "a repository that shares its build settings already has its own",
  );

  // A repository that already shares its build settings fills nothing.
  eq(
    "installScript" in
      savePayload(general, ORDER, values, { sharedBuildCache: true }, {
        fillProject: false,
        branch: "develop",
      }),
    false,
  );
  // And a general-only change brings no project part along.
  eq(
    "installScript" in
      savePayload(general, GENERAL_FIELDS, values, { name: "New" }, {
        fillProject: true,
        branch: "develop",
      }),
    false,
  );
});

it("SL-4: the worktree rows read this Mac's settings, or the repository's", () => {
  const worktree = { worktreeCopy: [".env", "apps/*/.env.local"], worktreeSetup: "npm ci" };
  const local = deriveRepository({ view: null, config, review: null, workspace, worktree });
  eq(local.values.worktreeCopy, [".env", "apps/*/.env.local"]);
  eq(local.values.worktreeSetup, "npm ci");
  eq(deriveRepository({ view: null, config, review: null, workspace }).values.worktreeCopy, null, "absent reads as none");
  // A shared definition's own values win, with or without build settings.
  const general: WorkspaceDefinition = {
    schemaVersion: 1,
    name: "Shared name",
    board: "local",
    worktreeSetup: "pnpm install",
  };
  const shared = deriveRepository({
    view: view({ definition: general, effective: general, cache: { ...view().cache, definition: general } }),
    config,
    review: null,
    workspace,
    worktree,
  });
  eq(shared.values.worktreeSetup, "pnpm install");
  eq(shared.values.worktreeCopy, null, "the repository copies nothing");
  // An empty list or command is none, never a change against none.
  eq(normalise("worktreeCopy", []), null);
  eq(normalise("worktreeSetup", ""), null);
  eq(changedFields(ORDER, { worktreeCopy: null }, { worktreeCopy: [] }), []);
  eq(isConfigField("worktreeCopy"), false, "not the project config's");
  eq(isConfigField("worktreeSetup"), false);
  // Words.
  eq(valueText("worktreeCopy", [".env"]), "1 path");
  eq(valueText("worktreeCopy", null), "None");
  eq(valueText("worktreeSetup", "npm ci"), "npm ci");
  eq(detailText("worktreeCopy", [".env", "b"]), ".env, b");
  eq(rowLabel("worktreeCopy"), "Files copied in");
  eq(rowLabel("worktreeSetup"), "Before the Builder starts, run");
  eq(restingHint("worktreeSetup", "npm ci"), `npm ci runs in every new card's copy before its Builder starts. ${WORKTREE_PORTS_HINT}`);
  eq(restingHint("worktreeSetup", null).endsWith("PORT=$PLYLOFT_PORT_BASE npm run dev."), true);
  // 1.174.1 P2 (T2): on Windows, PowerShell's form too.
  setPlatformForTests("windows");
  try {
    eq(
      restingHint("worktreeSetup", null),
      "None — the Builder starts as soon as the card's copy is made. Each card's copy has its own 10 ports from $PLYLOFT_PORT_BASE, e.g. PORT=$PLYLOFT_PORT_BASE npm run dev. In PowerShell: $env:PLYLOFT_PORT_BASE.",
    );
  } finally {
    setPlatformForTests(null);
  }
  eq(worktreePortsHint(false), WORKTREE_PORTS_HINT);
  eq(restingHint("worktreeCopy", null), "None — a card's copy starts with the repository's tracked files only.");
  eq(consequenceOf("worktreeSetup", null), "Nothing runs in a new card's copy before the Builder starts.");
  eq(
    commitMessage(changes(ORDER, { worktreeSetup: null }, { worktreeSetup: "npm ci" })),
    ["chore(config): “Before the Builder starts, run” — none → npm ci"],
    "the words the backend's commit uses",
  );
});

it("a long list gets a filter, and filtering never changes the list", () => {
  // PATTERNS.md §3: a filter above the group once it passes twelve rows.
  eq(needsFilter(12), false);
  eq(needsFilter(13), true);
  eq(matchesFilter("frontend/package.json", "pack"), true);
  eq(matchesFilter("frontend/package.json", "  PACK "), true, "case and spacing ignored");
  eq(matchesFilter("frontend/package.json", ""), true, "an empty filter hides nothing");
  eq(matchesFilter("frontend/package.json", "cargo"), false);
});

it("F7: a setup command this Mac hasn't allowed says it waits for Allow and run", () => {
  const theirs = { worktreeSetup: "npm ci", approvedSetup: null };
  const note = setupApprovalNote(theirs, "npm ci") ?? "";
  eq(note.includes("hasn't been allowed on this Mac") && note.includes("Allow and run"), true, note);
  eq(setupApprovalNote({ worktreeSetup: "npm ci", approvedSetup: "npm ci" }, "npm ci"), null, "allowed here");
  eq(setupApprovalNote({ worktreeSetup: "npm ci", approvedSetup: "npm install" }, "npm ci"), note, "a changed command");
  eq(setupApprovalNote({ worktreeSetup: null }, ""), null, "no command");
  eq(setupApprovalNote(theirs, "pnpm i"), null, "an unpublished edit of one's own");
  eq(setupApprovalNote(null, "npm ci"), null);
});

// ── 1.173.0 (B1): areas ───────────────────────────────────────────────

const AREAS = [
  { id: "app", name: "App", path: "" },
  { id: "site", name: "Site", path: "lyrappc-astro", targetBranch: "main" },
];

it("areas are a field of their own, on no Build or General page", () => {
  eq([...AREA_FIELDS], ["areas"]);
  eq((ORDER as readonly string[]).includes("areas"), false);
  eq((GENERAL_FIELDS as readonly string[]).includes("areas"), false);
  eq(isConfigField("areas"), false, "not this Mac's config.json");
  eq(rowLabel("areas"), "Areas");
});

it("areas read in words: count, names and folders, what saving does", () => {
  eq(valueText("areas", AREAS), "2 areas");
  eq(valueText("areas", AREAS.slice(1)), "1 area");
  eq(valueText("areas", null), "None");
  eq(detailText("areas", AREAS), "App (the whole repository) · Site (lyrappc-astro/)");
  // G2 walk: a change inside an area says that area's field, both sides.
  const withSite = (patch: Record<string, unknown>) => AREAS.map((x) => (x.id === "site" ? { ...x, ...patch } : x));
  eq(areasChangeDetail(AREAS, withSite({ lookAt: "https://www.lyrappc.com" })), {
    fromDetail: "Site — Where to look at it: nothing",
    toDetail: "Site — Where to look at it: https://www.lyrappc.com",
  });
  eq(areasChangeDetail(AREAS, withSite({ targetBranch: "staging" }))?.toDetail, "Site — Cards go to: staging");
  eq(areasChangeDetail(AREAS, AREAS.slice(0, 1)), { fromDetail: "Site (lyrappc-astro/)", toDetail: "Site: no longer an area" });
  eq(areasChangeDetail(AREAS.slice(0, 1), AREAS), { fromDetail: "Site: not an area yet", toDetail: "Site (lyrappc-astro/), added" });
  eq(areasChangeDetail([], []), null);
  const change = changes(["areas"], { areas: AREAS } as never, { areas: withSite({ lookAt: "https://www.lyrappc.com" }) } as never)[0];
  eq(change.fromDetail === change.toDetail, false, "the leaving question never shows the same text twice");
  eq(restingHint("areas", AREAS), "Parts of this repository that ship on their own — App and Site.");
  eq(restingHint("areas", []), "None — the whole repository ships as one.");
  eq(consequenceOf("areas", AREAS).includes("Each card belongs to one area"), true);
  eq(consequenceOf("areas", null).includes("ships as one again"), true);
  eq(areaName({ id: "site", name: " ", path: "" }), "site");
  eq(areaFolderWords("/"), "the whole repository");
  eq(areaFolderWords("./web\\blog/"), "web/blog/");
  eq(normalise("areas", []), null, "no areas is none");
  // The commit names the areas, as `shared_config::describe` does.
  eq(describeValue([...AREAS, { id: "docs", name: "", path: "docs" }]), "App, Site, docs");
});

it("a change of one area's values names that area in the commit, as Rust does", () => {
  const edited = [AREAS[0], { ...AREAS[1], targetBranch: "staging" }];
  const list = changes(AREA_FIELDS, { areas: AREAS }, { areas: edited });
  eq(commitMessage(list), ["chore(config): “Areas” — Site changed"]);
  const added = changes(AREA_FIELDS, { areas: null }, { areas: AREAS });
  eq(commitMessage(added), ["chore(config): “Areas” — none → App, Site"]);
});

it("the shared definition's areas reach the page; this Mac alone has none", () => {
  const shared = deriveRepository({
    view: view({ definition: { areas: AREAS } }),
    config,
    review: null,
    workspace,
  });
  eq(shared.values.areas, AREAS);
  const notShared = deriveRepository({ view: view({ definition: { areas: null } }), config, review: null, workspace });
  eq(notShared.values.areas, null);
  // A queued change of the areas is on its way like any field.
  const queued = deriveRepository({
    view: view({
      definition: { areas: AREAS },
      cache: { ...view().cache, pending: { areas: AREAS } },
      queue: {
        createDefinition: false,
        fields: { areas: { pullRequest: null } },
        createPullRequest: null,
        lastError: null,
        lastOffline: false,
      },
    }),
    config,
    review: null,
    workspace,
  });
  eq(queued.publishing!.queued, ["areas"]);
  const local = deriveRepository({ view: null, config, review: null, workspace });
  eq(local.values.areas, null);
});

if (failed > 0) {
  console.error(`repositoryPage.test.ts: ${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`repositoryPage.test.ts: ${passed} passed`);

// ── 1.175.0 (C3, SC-3): a drafted field the repository moved meanwhile ──
{
  const drafted = { integrationBranch: "develop" };
  const edited = { bases: { integrationBranch: "staging" }, author: "example-teammate" };
  // The repository still holds what the draft was changed from: a plain draft.
  eq(movedSince("integrationBranch", base, edited), null);
  eq(rowMark("integrationBranch", base, drafted, null, SHIPPING_ORDER, edited).kind, "draft");
  // It holds another value now: the row says so, with who and what.
  const moved: Values = { ...base, integrationBranch: "release" };
  eq(movedSince("integrationBranch", moved, edited), "staging");
  const mark = rowMark("integrationBranch", moved, drafted, null, SHIPPING_ORDER, edited);
  eq(mark, { kind: "draftMoved", n: 1, was: "staging", now: "release", who: "example-teammate" });
  eq(
    markHint(mark, "integrationBranch"),
    "Changed here, and example-teammate changed it in the repository meanwhile: it is release there now. Publish asks which to keep.",
  );
  eq(
    markHint({ kind: "draftMoved", n: 1, was: "staging", now: "release", who: null }, "integrationBranch"),
    "Changed here, and someone changed it in the repository meanwhile: it is release there now. Publish asks which to keep.",
  );
  // No base recorded (a draft from before): a plain draft.
  eq(rowMark("integrationBranch", moved, drafted, null, SHIPPING_ORDER).kind, "draft");
  // The Review sheet's line.
  const now = 1_762_700_000;
  eq(
    reviewMovedNote("integrationBranch", moved, { ...edited, changedAt: now - 240 }, now),
    "example-teammate set it to release 4 min ago; Publish asks which to keep.",
  );
  eq(reviewMovedNote("integrationBranch", moved, { ...edited, changedAt: null }, now), "example-teammate set it to release; Publish asks which to keep.");
  eq(reviewMovedNote("integrationBranch", base, { ...edited, changedAt: null }, now), null);
  // The bar after the sheet was closed without an answer: the other fields went out.
  const choosing = { queued: ["integrationBranch"], creating: false, pullRequest: null, offline: false, lastError: null, choosing: [{ field: "integrationBranch", label: "Cards go to" }] };
  eq(publishBar([], "staging", choosing, ["integrationBranch", "verifyPipeline", "installScript"]), {
    kind: "choosing",
    sentence: "Waiting for your choice: Cards go to",
    detail: "It changed here and in the repository too. Plyloft publishes it once you choose. Your other 2 changes were published.",
    field: "integrationBranch",
  });
  eq((publishBar([], "staging", choosing, ["integrationBranch", "verifyPipeline"]) as { detail: string }).detail, "It changed here and in the repository too. Plyloft publishes it once you choose. Your other change was published.");
  eq((publishBar([], "staging", choosing, ["integrationBranch"]) as { detail: string }).detail, "It changed here and in the repository too. Plyloft publishes it once you choose.");
  eq((publishBar([], "staging", choosing) as { detail: string }).detail, "It changed here and in the repository too. Plyloft publishes it once you choose.");
}

// ── 1.175.0 (C4, SC-7 / SC-4): sign-in trouble said as such ───────────
{
  const pending = (patch: Record<string, unknown>) => ({
    queued: ["verifyPipeline", "integrationBranch"],
    creating: false,
    pullRequest: null,
    offline: false,
    lastError: "x",
    ...patch,
  });
  eq(publishBar([], "staging", pending({ trouble: { kind: "gitSignIn" } })), {
    kind: "trouble",
    sentence: "Not published — Git couldn't sign in to GitHub",
    detail: '2 changes are kept here and work on this Mac. In Settings › Setup and account › Setup › GitHub, turn on "Git uses your GitHub sign-in"; Plyloft publishes them at the next Sync.',
    action: { id: "githubSetup", label: "Open GitHub setup" },
  });
  eq(publishBar([], "staging", pending({ trouble: { kind: "ghSignedOut" } })), {
    kind: "trouble",
    sentence: "Not published — GitHub isn't signed in on this Mac",
    detail: "2 changes are kept here and work on this Mac. Publishing them to staging needs the GitHub command signed in. Sign in to GitHub with the account this project uses; Plyloft publishes them at the next Sync.",
    action: { id: "signIn", label: "Sign in to GitHub" },
  });
  eq(publishBar([], "staging", pending({ trouble: { kind: "sso", org: "mbadv" } })), {
    kind: "trouble",
    sentence: "Not published — “mbadv” needs you to authorize single sign-on",
    detail: "2 changes are kept here and work on this Mac. Your organization “mbadv” needs you to authorize the GitHub command for single sign-on; Plyloft publishes them at the next Sync.",
    action: { id: "authorize", label: "Authorize", org: "mbadv" },
  });
  // Offline stays as it was, only for the network.
  eq((publishBar([], "staging", pending({ offline: true, trouble: { kind: "network" } })) as { sentence: string }).sentence, "Waiting to publish — you're offline");
  // A queue from before (no kind) and "other": the words that came with it.
  eq((publishBar([], "staging", pending({})) as { sentence: string }).sentence, "Waiting to publish to staging");
  eq((publishBar([], "staging", pending({ trouble: { kind: "other" } })) as { sentence: string }).sentence, "Waiting to publish to staging");
  // The status line under the title.
  const line = { branch: "staging", author: null, changedAt: null, readOnly: false, repository: "mbadv/lyra", offline: false, local: false };
  eq(statusLine({ ...line, trouble: { kind: "gitSignIn" } }, 1), { state: "empty", kind: "offline", branch: "staging", tail: ". Git couldn't sign in to GitHub, so Plyloft can't write it right now." });
  eq((statusLine({ ...line, trouble: { kind: "ghSignedOut" } }, 1) as { tail: string }).tail, ". GitHub isn't signed in on this Mac, so Plyloft can't write it right now.");
  eq((statusLine({ ...line, trouble: { kind: "sso", org: "mbadv" } }, 1) as { tail: string }).tail, ". “mbadv” needs you to authorize single sign-on, so Plyloft can't write it right now.");
  eq((statusLine({ ...line, offline: true, trouble: { kind: "network" } }, 1) as { tail: string }).tail, ". You're offline, so Plyloft can't read or write it right now.");
  // SC-4: the creation pull request someone else's share made unneeded.
  eq(publishBar([], "staging", { queued: [], creating: true, pullRequest: 215, offline: false, lastError: null, sharedFirst: { who: "example-teammate" } }), {
    kind: "pullRequest",
    sentence: "Pull request #215 is still open, and isn't needed",
    // WALKFIX-3: not tried yet — never "couldn't close" before a refusal.
    detail: "example-teammate shared this project's setup first, and this Mac follows it. Plyloft closes its own pull request at the next Sync.",
    number: 215,
  });
  // After GitHub refused the close: then it says so.
  eq(
    (publishBar([], "staging", { queued: [], creating: false, pullRequest: null, offline: false, lastError: null, sharedFirstLeft: { number: 215, url: "u", who: "example-teammate", outcome: "refused" } }) as { detail: string }).detail,
    "example-teammate shared this project's setup first, and this Mac follows it. Plyloft couldn't close its own pull request; close it on GitHub.",
  );
}

// ── 1.175.0 (C5, SC-5 / SC-8) ─────────────────────────────────────────
{
  const queued = { queued: ["verifyPipeline", "integrationBranch"], creating: false, pullRequest: null, offline: false, lastError: "x" };
  // Renamed: the bar says the new name and moves there.
  eq(publishBar([], "staging", { ...queued, branchGone: { branch: "staging", renamedTo: "develop" } }), {
    kind: "moveTo",
    sentence: "Not published — staging is called develop on GitHub now",
    detail: "2 changes are kept here and work on this Mac. Move the shared setup to develop to publish them.",
    to: "develop",
  });
  // Deleted: the missing-branch bar, in its new words.
  eq(
    (publishBar([], "staging", { ...queued, lastError: "staging isn't on GitHub any more. Choose where cards go in Settings › Cards › Shipping.", branchGone: { branch: "staging", renamedTo: null } }) as { sentence: string }).sentence,
    "Not published — staging isn't on GitHub any more",
  );
  // A draft that chooses where cards go moves the setup there.
  const draft = changes(SHIPPING_ORDER, base, { integrationBranch: "release" });
  const bar = publishBar(draft, "staging", { ...queued, queued: [], branchGone: { branch: "staging", renamedTo: null } }) as { sentence: string; publishLabel: string };
  eq(bar.sentence, "1 change · moves the shared setup to release · reaches everyone who opens this repository");
  eq(bar.publishLabel, "Publish to release");
  // WALKFIX-3 (item 2): the Review sheet says the same branch — its lede,
  // its button and its details use publishTarget, never the gone one.
  const gone = { ...queued, queued: [], branchGone: { branch: "staging", renamedTo: null } };
  eq(publishTarget(draft, "staging", gone), "release");
  eq(reviewLede(publishTarget(draft, "staging", gone)), "Publishing makes one commit on release. Everyone who opens this repository gets them.");
  eq(publishTarget(draft, "staging", { ...queued, queued: [] }), "staging", "nothing gone: the branch it reads");
  // Windows walk (C4): a sign-in trouble reading the branches isn't "offline".
  eq(branchesUnreadWhy({ kind: "gitSignIn" }), "Can't be changed: Git couldn't sign in to GitHub, so Plyloft can't read the branches.");
  eq(branchesUnreadWhy({ kind: "ghSignedOut" }), "Can't be changed: GitHub isn't signed in on this Mac, so Plyloft can't read the branches.");
  eq(branchesUnreadWhy({ kind: "network" }), "Can't be changed while offline — Plyloft needs the repository to read the branches.");
  eq(branchesUnreadWhy(null), "Can't be changed while offline — Plyloft needs the repository to read the branches.", "an older backend: as before");
  // F3 walk: a project on GitLab never hears of GitHub here.
  eq(branchesUnreadWhy({ kind: "gitSignIn" }, "gitlab.com"), "Can't be changed: Git couldn't sign in to gitlab.com, so Plyloft can't read the branches.");
  eq(branchesUnreadWhy({ kind: "ghSignedOut" }, "gitlab.com"), "Can't be changed: Git couldn't sign in to gitlab.com, so Plyloft can't read the branches.");
  eq(branchesUnreadWhy({ kind: "sso", org: "acme" }, "gitlab.com"), "Can't be changed: Git couldn't sign in to gitlab.com, so Plyloft can't read the branches.");
  eq(branchesUnreadWhy({ kind: "other" }, "gitlab.com"), "Can't be changed: Plyloft couldn't read the branches from gitlab.com.");
  eq(branchesUnreadWhy({ kind: "network" }, "gitlab.com"), "Can't be changed while offline — Plyloft needs the repository to read the branches.");
  // Windows walk: the same from the draft the Publish sends.
  eq(publishTargetOfDraft({ integrationBranch: "release" }, "staging", gone), "release");
  eq(publishTargetOfDraft({ integrationBranch: "release" }, "staging", { ...queued, queued: [] }), "staging");
  eq(publishTargetOfDraft({ sharedBuildCache: false }, "staging", gone), "staging");
  // A member who can't write: the bar, the row hint, the sheet and the toast.
  eq(publishBar([], "staging", { ...queued, cantWrite: { labels: ["Checks before shipping", "Cards go to"], repository: "mbadv/lyra", author: "example-teammate" } }), {
    kind: "cantWrite",
    sentence: "Not published — you can't write to mbadv/lyra",
    detail: "2 changes are kept here and work on this Mac only: Checks before shipping and Cards go to. Your team has other values. Ask example-teammate for write access to publish them, or use the team's values.",
  });
  const mark = rowMark("integrationBranch", base, {}, { fields: { integrationBranch: "release" }, pullRequests: {}, repository: base, cantWrite: "mbadv/lyra" }, SHIPPING_ORDER);
  eq(markHint(mark, "integrationBranch"), "Changed here, not published — you can't write to mbadv/lyra. The team has staging.");
  const sheet = teamValuesSheet(["integrationBranch"], { ...base, integrationBranch: "release" }, base, "mbadv/lyra");
  eq(sheet.title, "Use the team's values on this Mac?");
  eq(sheet.body, "Your 1 change can't be published without write access to mbadv/lyra. Using the team's values drops it from this Mac.");
  eq(sheet.items, ["Cards go to — release on this Mac · staging for the team"]);
  eq([sheet.cancelLabel, sheet.confirmLabel, sheet.focusCancel], ["Not now", "Use the team's values", true]);
  eq(teamValuesToast(["Cards go to"]), { title: "This Mac uses the team's values", body: "Your change to “Cards go to” was dropped." });
  eq(teamValuesToast(["Checks before shipping", "Cards go to"]).body, "Your changes to “Checks before shipping” and “Cards go to” were dropped.");
}

// ── C3 round 2: the count of the other changes comes from the queue ───
{
  const choosing = { queued: ["integrationBranch", "installScript"], creating: false, pullRequest: null, offline: false, lastError: null, choosing: [{ field: "integrationBranch", label: "Cards go to" }] };
  // Three sent: one waits for the choice, one is still queued, one landed.
  eq((publishBar([], "staging", choosing, ["integrationBranch", "verifyPipeline", "installScript"]) as { detail: string }).detail,
    "It changed here and in the repository too. Plyloft publishes it once you choose. Your other change was published.");
  // One waits in a pull request: said so.
  eq((publishBar([], "staging", { ...choosing, pullRequest: 231 }, ["integrationBranch", "verifyPipeline", "installScript"]) as { detail: string }).detail,
    "It changed here and in the repository too. Plyloft publishes it once you choose. Your other change was published. Your other change waits in pull request #231.");
}
// ── C4 round 2: what was left of an unneeded creation pull request ──
{
  const base = { queued: [], creating: false, pullRequest: null, offline: false, lastError: null };
  eq(publishBar([], "staging", { ...base, sharedFirstLeft: { number: 215, url: "https://github.com/old/lyra/pull/215", who: "example-teammate", outcome: "notOurs" } }), {
    kind: "openUrl",
    sentence: "Pull request #215 is no longer followed",
    detail: "example-teammate shared this project's setup first, and this Mac follows it. Pull request #215, which Plyloft had opened from this Mac, isn't in this repository as Plyloft left it.",
    url: "https://github.com/old/lyra/pull/215",
  });
  eq((publishBar([], "staging", { ...base, sharedFirstLeft: { number: 215, url: "u", who: null, outcome: "refused" } }) as { sentence: string }).sentence,
    "Pull request #215 is still open, and isn't needed");
  // The GitHub-not-signed-in bar doesn't claim a refused push.
  const q = { queued: ["verifyPipeline"], creating: false, pullRequest: null, offline: false, lastError: "x", trouble: { kind: "ghSignedOut" as const } };
  eq((publishBar([], "staging", q) as { detail: string }).detail,
    "1 change is kept here and works on this Mac. Publishing it to staging needs the GitHub command signed in. Sign in to GitHub with the account this project uses; Plyloft publishes it at the next Sync.");
}
