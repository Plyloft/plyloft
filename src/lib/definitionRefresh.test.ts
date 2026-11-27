// Unit tests for the shared-definition refresh scheduler and toasts
// (src/lib/definitionRefresh.ts, GH #79).
//
// Run: node --experimental-strip-types src/lib/definitionRefresh.test.ts

import {
  DEFINITION_REFRESH_INTERVAL_MS,
  DefinitionRefreshScheduler,
  definitionChangeToasts,
  definitionStatusKey,
  DefinitionStatusTracker,
  ago,
  publishToasts,
  pageReadFoundNothing,
  definitionReadKey,
  waitingToastStep,
  type IntervalClock,
  type PublishReportLike,
  type RefreshMoment,
} from "./definitionRefresh.ts";
import { setPlatformForTests } from "./platform.ts";
import { readFileSync } from "node:fs";
import { FIELD_LABELS, areaChangeWords, withWorkspaceName } from "./definitionRefresh.ts";

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

function eq(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`expected ${b}, got ${a}`);
}

// 1.169.0 walk: every shared field's words are Rust's (`workspace_definition::FIELDS`),
// so a publish toast never names a field by its key.
it("the field labels are workspace_definition.rs's FIELDS", () => {
  const rust = readFileSync(new URL("../../src-tauri/src/workspace_definition.rs", import.meta.url), "utf8");
  const block = rust.slice(rust.indexOf("pub const FIELDS"), rust.indexOf("];", rust.indexOf("pub const FIELDS")));
  const pairs = Object.fromEntries([...block.matchAll(/\("([A-Za-z]+)", "([^"]+)"\)/g)].map((m) => [m[1], m[2]]));
  eq(FIELD_LABELS, pairs);
  eq(FIELD_LABELS.models, "Suggested models and effort");
  eq(FIELD_LABELS.areas, "Areas");
});

// 1.173.0 (B1): a change of the areas names them, never their folders.
it("a change of areas names each area", () => {
  const toasts = definitionChangeToasts({
    author: "test-owner",
    branch: "main",
    changes: [
      {
        field: "areas",
        label: "Areas",
        value: [
          { id: "app", name: "App", path: "" },
          { id: "site", name: "", path: "lyrappc-astro" },
        ],
      },
    ],
  });
  eq(toasts.length, 1);
  if (!`${toasts[0].title} ${toasts[0].body ?? ""}`.includes("App, site")) {
    throw new Error(JSON.stringify(toasts[0]));
  }
});

// B1 Challenger 10: the same areas before and after — the toast says which changed.
it("a change of one area names that area", () => {
  const before = [
    { id: "app", name: "App", path: "" },
    { id: "site", name: "Site", path: "web", targetBranch: "main" },
  ];
  const after = [before[0], { ...before[1], targetBranch: "staging" }];
  eq(areaChangeWords(before, after), "Site changed");
  eq(areaChangeWords(before, [{ path: "", name: "App", id: "app" }, after[1]]), "Site changed");
  eq(areaChangeWords(before, before), null);
  eq(areaChangeWords(null, after), null);
  eq(areaChangeWords(before, after.slice(0, 1)), null);
  const toasts = definitionChangeToasts({
    author: "ana",
    branch: "main",
    changes: [{ field: "areas", label: "Areas", value: after, previous: before }],
  });
  eq(toasts[0].body, "Site changed. From .atelier/workspace.json on main.");
});

function fakeClock() {
  let next = 1;
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const clock: IntervalClock = {
    setInterval: (fn, ms) => {
      const id = next++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (handle) => {
      intervals.delete(handle as number);
    },
  };
  return {
    clock,
    intervals,
    tick: () => {
      for (const { fn } of intervals.values()) fn();
    },
  };
}

it("a newly warmed workspace is read at once, then every ten minutes", () => {
  const calls: Array<[string, RefreshMoment]> = [];
  const { clock, intervals, tick } = fakeClock();
  const scheduler = new DefinitionRefreshScheduler(
    (id, moment) => calls.push([id, moment]),
    clock,
  );
  scheduler.sync(["a"]);
  eq(calls, [["a", "open"]]);
  eq([...intervals.values()].map((i) => i.ms), [DEFINITION_REFRESH_INTERVAL_MS]);
  eq(DEFINITION_REFRESH_INTERVAL_MS, 600_000);
  tick();
  tick();
  eq(calls, [
    ["a", "open"],
    ["a", "periodic"],
    ["a", "periodic"],
  ]);
});

it("a workspace that stays warmed is not re-opened on the next sync", () => {
  const calls: Array<[string, RefreshMoment]> = [];
  const { clock, intervals } = fakeClock();
  const scheduler = new DefinitionRefreshScheduler(
    (id, moment) => calls.push([id, moment]),
    clock,
  );
  scheduler.sync(["a"]);
  scheduler.sync(["a", "b"]);
  eq(calls, [
    ["a", "open"],
    ["b", "open"],
  ]);
  eq(intervals.size, 2);
});

it("an evicted workspace stops being read; re-warming opens it again", () => {
  const calls: Array<[string, RefreshMoment]> = [];
  const { clock, intervals, tick } = fakeClock();
  const scheduler = new DefinitionRefreshScheduler(
    (id, moment) => calls.push([id, moment]),
    clock,
  );
  scheduler.sync(["a", "b"]);
  scheduler.sync(["b"]);
  eq(intervals.size, 1);
  calls.length = 0;
  tick();
  eq(calls, [["b", "periodic"]]);
  scheduler.sync(["a", "b"]);
  eq(calls, [
    ["b", "periodic"],
    ["a", "open"],
  ]);
  scheduler.stop();
  eq(intervals.size, 0);
});

it("a changed field is announced with its author and label", () => {
  eq(
    definitionChangeToasts({
      author: "test-owner",
      branch: "main",
      changes: [
        {
          field: "verifyPipeline",
          label: "Checks before shipping",
          value: [{ kind: "script", path: "scripts/verify.sh" }],
        },
      ],
    }),
    [
      {
        kind: "warn",
        title: "test-owner changed “Checks before shipping”",
        // 1.175.0 B2: checks from the branch run once this Mac allows them.
        body: "Runs on this Mac once you allow it: scripts/verify.sh. From .atelier/workspace.json on main.",
      },
    ],
  );
  // The install step too; the setup command and the start command keep their
  // words (their own OK is asked where they run).
  eq(
    definitionChangeToasts({
      author: "example-teammate",
      branch: "staging",
      changes: [
        { field: "installScript", label: "After a release, run", value: "scripts/deploy-all.sh" },
        { field: "worktreeSetup", label: "Setup command", value: "npm ci" },
      ],
    }).map((t) => t.body),
    [
      "Runs on this Mac once you allow it: scripts/deploy-all.sh. From .atelier/workspace.json on staging.",
      "Now runs on this Mac: npm ci. From .atelier/workspace.json on staging.",
    ],
  );
  eq(
    definitionChangeToasts({
      author: "someone",
      branch: "main",
      changes: [{ field: "name", label: "Name", value: "Ply" }],
    })[0],
    {
      kind: "info",
      title: "someone changed “Name”",
      body: "Now: Ply. From .atelier/workspace.json on main.",
    },
  );
});

it("Windows: a field that runs here says this PC (T6)", () => {
  setPlatformForTests("windows");
  try {
    eq(
      definitionChangeToasts({
        author: "test-owner",
        branch: "main",
        changes: [{ field: "verifyPipeline", label: "Checks before shipping", value: [{ kind: "script", path: "v.sh" }] }],
      })[0].body,
      "Runs on this PC once you allow it: v.sh. From .atelier/workspace.json on main.",
    );
  } finally {
    setPlatformForTests(null);
  }
});

it("the first read sets the workspace up and names nobody (T6)", () => {
  const toasts = definitionChangeToasts({
    author: "MatteoB-adv",
    branch: "walk-base",
    firstRead: true,
    changes: [
      { field: "name", label: "Name", value: "ghpr" },
      { field: "integrationBranch", label: "Cards go to", value: "walk-base" },
      { field: "cachePaths", label: "Cache paths", value: [] },
    ],
  });
  eq(toasts.length, 1);
  eq(toasts[0].title, "Set up from .atelier/workspace.json on walk-base: “Name”, “Cards go to” and “Cache paths”");
  eq(toasts[0].body, undefined);
  eq(/MatteoB-adv|changed/.test(toasts[0].title), false);
  eq(definitionChangeToasts({ firstRead: true, branch: "main", changes: [] }), []);
});

// 1.173.0 walk: three workspaces on one repository, one toast that named
// none of them. With more than one open, the toast starts with its name.
it("with more than one workspace open, a toast names its workspace", () => {
  const toasts = definitionChangeToasts({
    firstRead: true,
    branch: "main",
    changes: [
      { field: "name", label: "Name", value: "sandbox monorepo" },
      { field: "integrationBranch", label: "Cards go to", value: "main" },
    ],
  });
  const one = [{ id: "w1", name: "atelier" }];
  eq(withWorkspaceName(toasts, "w1", one), toasts); // one workspace: no prefix
  const two = [...one, { id: "w2", name: "walk 1173 A" }];
  const named = withWorkspaceName(toasts, "w1", two);
  eq(named[0].title, "atelier: Set up from .atelier/workspace.json on main: “Name” and “Cards go to”");
  eq(named[0].kind, toasts[0].kind);
  eq(withWorkspaceName(toasts, "gone", two), toasts); // an unknown workspace: as it was
  eq(withWorkspaceName([], "w1", two), []);
});

it("many changes collapse into one toast; none raise nothing", () => {
  eq(definitionChangeToasts({ author: "x", changes: [] }), []);
  const toasts = definitionChangeToasts({
    author: null,
    branch: "main",
    changes: [
      { field: "name", label: "Name", value: "P" },
      { field: "accentColor", label: "Accent color", value: "#fff" },
      { field: "installScript", label: "After a release, run", value: null },
    ],
  });
  eq(toasts.length, 1);
  eq(toasts[0].kind, "warn");
  // 1.174.0 (DS2): the rows' names are quoted in a sentence.
  eq(toasts[0].title, "Someone changed “Name”, “Accent color” and “After a release, run”");
});

it("the Doctor key changes when an error clears or pending edits publish", () => {
  const broken = definitionStatusKey({
    hasDefinition: true,
    unreadable: { line: 3, message: "x" },
    pendingFields: [],
  });
  const fixed = definitionStatusKey({ hasDefinition: true, unreadable: null, pendingFields: [] });
  const pending = definitionStatusKey({
    hasDefinition: true,
    unreadable: null,
    pendingFields: ["name"],
  });
  if (broken === fixed || fixed === pending) throw new Error("keys must differ");
  // A committed revert: nothing pending before or after, only the state moves.
  const revertShown = definitionStatusKey({
    hasDefinition: true,
    unreadable: null,
    pendingFields: [],
    pendingState: "writtenToCheckout",
  });
  const revertCommitted = definitionStatusKey({
    hasDefinition: true,
    unreadable: null,
    pendingFields: [],
    pendingState: null,
  });
  if (revertShown === revertCommitted) throw new Error("pendingState must count");
});

it("the Doctor reloads when a published workspace.json replaces the legacy conversion", () => {
  const tracker = new DefinitionStatusTracker();
  const base = {
    workspaceId: "w",
    hasDefinition: true,
    unreadable: null,
    pendingFields: [] as string[],
    pendingState: null,
    branch: "main",
    changes: [] as unknown[],
  };
  eq(tracker.observe({ ...base, source: "legacy", author: "a" }), true);
  eq(tracker.observe({ ...base, source: "legacy", author: "a" }), false);
  eq(tracker.observe({ ...base, source: "repo", author: "a" }), true);
  eq(tracker.observe({ ...base, source: "repo", author: "b" }), true);
  eq(tracker.observe({ ...base, source: "repo", author: "b", branch: "staging" }), true);
  eq(
    definitionStatusKey({ hasDefinition: true, pendingFields: ["b", "a"] }),
    definitionStatusKey({ hasDefinition: true, pendingFields: ["a", "b"] }),
  );
});

it("after a local edit the next refresh reloads the Doctor even if its status looks unchanged", () => {
  const tracker = new DefinitionStatusTracker();
  const clean = {
    workspaceId: "w",
    hasDefinition: true,
    unreadable: null,
    pendingFields: [] as string[],
    changes: [] as unknown[],
  };
  eq(tracker.observe(clean), true);
  eq(tracker.observe(clean), false);
  // A local edit made the row "pending" (Doctor reloaded on the edited
  // event); it was published before the next refresh, which is clean again.
  tracker.forget("w");
  eq(tracker.observe(clean), true);
  eq(tracker.observe({ ...clean, changes: [{}] }), true);
  // Other workspaces are unaffected.
  eq(tracker.observe({ ...clean, workspaceId: "x" }), true);
  tracker.forget("w");
  eq(tracker.observe({ ...clean, workspaceId: "x" }), false);
});

// ── GH #80: the write channel ─────────────────────────────────────────

const noPublish: PublishReportLike = {
  branch: "staging",
  published: [],
  commit: null,
  overrides: [],
  pullRequest: null,
  pullRequestFields: [],
  closedPullRequests: [],
  error: null,
  offline: false,
};

it("a push names the branch and whose value it replaced", () => {
  eq(publishToasts({ moment: "publish", publish: null }), []);
  const [toast] = publishToasts(
    {
      moment: "publish",
      publish: {
        ...noPublish,
        published: ["verifyPipeline"],
        commit: "abc",
        overrides: [
          { field: "verifyPipeline", author: "test-owner", changedAt: 1000 },
        ],
      },
    },
    1120,
  );
  eq(toast.title, "Published “Checks before shipping” to staging");
  eq(toast.body, "Replaced test-owner’s “Checks before shipping” from 2 min ago.");
  const [plain] = publishToasts({
    moment: "sync",
    publish: { ...noPublish, published: ["accentColor"], commit: "abc" },
  });
  eq(plain.body, "Committed .atelier/workspace.json; your project folder is untouched.");
  // Already on the branch (nothing pushed): no toast.
  eq(
    publishToasts({ moment: "sync", publish: { ...noPublish, published: ["name"] } }),
    [],
  );
});

it("a refused push says which pull request it waits in", () => {
  const [toast] = publishToasts({
    moment: "publish",
    publish: {
      ...noPublish,
      pullRequest: { number: 42, url: "https://github.com/o/r/pull/42" },
      pullRequestFields: ["verifyPipeline"],
    },
  });
  eq(toast.kind, "warn");
  eq(toast.title, "Waiting for pull request #42 to merge");
  const [closed] = publishToasts({
    moment: "periodic",
    publish: { ...noPublish, closedPullRequests: [42] },
  });
  eq(closed.title, "Pull request #42 was closed without merging");
});

it("offline stays quiet; other failures speak only right after the edit", () => {
  const offline = { ...noPublish, error: "Could not resolve host", offline: true };
  eq(publishToasts({ moment: "publish", publish: offline }), []);
  const failed = { ...noPublish, error: "gh is missing." };
  eq(publishToasts({ moment: "periodic", publish: failed }), []);
  eq(publishToasts({ moment: "publish", publish: failed }).length, 1);
  eq(ago(100, 100), "just now");
  eq(ago(3 * 86_400, 0), "3 days ago");
});

it("WALKFIX-1: the file's creation waiting in a pull request names no empty field", () => {
  const [toast] = publishToasts({
    moment: "publish",
    publish: { ...noPublish, branch: "main", pullRequest: { number: 7, url: "https://github.com/o/r/pull/7" }, pullRequestFields: [] },
  });
  eq(toast.title, "Waiting for pull request #7 to merge");
  eq(
    toast.body,
    "main refused a direct push, so Plyloft opened a pull request that shares this project's setup. It is shared once that merges.",
  );
  eq((toast.body ?? "").includes(" for ."), false);
});

it("WALKFIX-3: the waiting toast once per pull request, gone once settled", () => {
  const waits = (n: number) => ({ pendingFields: ["name"], source: "repo", publish: { pullRequest: { number: n, url: "u" }, closedPullRequests: [] } });
  eq(waitingToastStep(null, waits(221)), { push: true, dismiss: false, shown: 221 });
  // Every drain that still waits: nothing new pushed.
  eq(waitingToastStep(221, waits(221)), { push: false, dismiss: false, shown: 221 });
  // Still pending, no new word: it stays.
  eq(waitingToastStep(221, { pendingFields: ["name"], source: "repo", publish: null }), { push: false, dismiss: false, shown: 221 });
  // Closed without merging: gone.
  eq(waitingToastStep(221, { pendingFields: [], source: "repo", publish: { pullRequest: null, closedPullRequests: [221] } }), { push: false, dismiss: true, shown: null });
  // Merged: nothing pending any more, gone.
  eq(waitingToastStep(221, { pendingFields: [], source: "repo", publish: null }), { push: false, dismiss: true, shown: null });
  // A Share waiting: stays while the source is still the seed.
  eq(waitingToastStep(224, { pendingFields: [], source: "seeded", publish: null }), { push: false, dismiss: false, shown: 224 });
  // Another pull request: the old one goes, the new one comes.
  eq(waitingToastStep(221, waits(222)), { push: true, dismiss: true, shown: 222 });
});

it("WALKFIX-3: a page read that finds the cards' branch gone reloads the Board's notice", () => {
  const base = { moment: "pageRead" as RefreshMoment, hasDefinition: true, source: "repo", branch: "w1175-dev", commit: "c1", unreadable: null, changes: [] };
  const seen = definitionReadKey(base);
  eq(pageReadFoundNothing(base, seen), true);
  eq(pageReadFoundNothing({ ...base, branchGone: { branch: "w1175-dev", renamedTo: null } }, seen), false);
});

it("a publish error reloads the Doctor row", () => {
  const base = { hasDefinition: true, pendingFields: ["name"] };
  const a = definitionStatusKey({ ...base, publish: { error: null } });
  const b = definitionStatusKey({ ...base, publish: { error: "offline" } });
  eq(a === b, false);
});

if (failed > 0) {
  console.error(`✗ ${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} passed`);
