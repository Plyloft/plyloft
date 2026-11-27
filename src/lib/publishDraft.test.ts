// Publishing a Repository page's draft, from the press to the read that
// says what the save did (card #94 review, F1, F3, F30).
//
// The save settles when this test says so and the read fails when it says
// so, and the session underneath is the real reducer — so what is asserted
// is the sequence the page runs, not a retelling of it.
//
// Run: node --experimental-strip-types src/lib/publishDraft.test.ts

import { emptySession, reduce, editable, type DraftEvent, type DraftSession } from "./draftSession.ts";
import { publishDraft, withBases, type PublishProblem, type SaveAnswer } from "./publishDraft.ts";
import { BUILD_FIELDS, type Values } from "./repositoryPage.ts";
import type { WorkspaceDefinition } from "../ipc";

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function it(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
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

const definition: WorkspaceDefinition = {
  schemaVersion: 1,
  name: "LYRA",
  board: "local",
  integrationBranch: "staging",
  versionFiles: [],
  sharedBuildCache: true,
};

const base: Values = {
  integrationBranch: "staging",
  verifyPipeline: null,
  installScript: null,
  versionFiles: null,
  sharedBuildCache: true,
  cachePaths: null,
  selfCheck: true,
  reviewChecklist: null,
  name: "LYRA",
  accentColor: null,
};

const landed: SaveAnswer = {
  queue: { fields: { sharedBuildCache: {} } },
  cache: { branch: "staging" },
};

/**
 * A page: the real session, a save and a read the test drives. `values` is
 * what Ply has read, and moves only when a read succeeds.
 */
function page(options: { readFails?: boolean; values?: Values } = {}) {
  let session = emptySession();
  let values = options.values ?? base;
  let problem: PublishProblem | null = null;
  let published: { queued: boolean; branch: string; count: number } | null = null;
  const saves: Record<string, unknown>[] = [];
  const reads: string[] = [];
  let readFails = options.readFails ?? false;
  let releaseSave!: (answer: SaveAnswer | Error) => void;

  const dispatch = (event: DraftEvent) => {
    const r = reduce(session, event);
    session = r.session;
    return r.accepted;
  };
  // The page's own reaction to a read completing, as its effects do it.
  const readCompleted = () => {
    reads.push(readFails ? "failed" : "ok");
    dispatch(readFails ? { kind: "read", ok: false } : { kind: "read", ok: true, values });
  };

  return {
    get session(): DraftSession {
      return session;
    },
    get editable() {
      return editable(session);
    },
    get problem() {
      return problem;
    },
    get published() {
      return published;
    },
    get saves() {
      return saves;
    },
    get reads() {
      return reads;
    },
    edit(next: Record<string, unknown>) {
      return dispatch({ kind: "edit", values, next });
    },
    /** What a read brings, once one succeeds. */
    setValues(next: Values) {
      values = next;
    },
    letReadsFail(fails: boolean) {
      readFails = fails;
    },
    /** Presses Publish. The save settles when the test releases it. */
    publish(over: { readError?: string | null; definition?: WorkspaceDefinition | null; target?: string | null } = {}) {
      const done = publishDraft({
        session: () => session,
        dispatch,
        definition: over.definition === undefined ? definition : over.definition,
        values,
        branch: "staging",
        target: over.target ?? null,
        sharedProject: true,
        readError: over.readError ?? null,
        order: BUILD_FIELDS,
        save: (_base, payload) => {
          saves.push(payload);
          return new Promise<SaveAnswer>((ok, no) => {
            releaseSave = (answer) => (answer instanceof Error ? no(answer) : ok(answer));
          });
        },
        reload: async () => readCompleted(),
        refreshWorkspaces: async () => {},
        onProblem: (p) => {
          problem = p;
        },
        onPublished: (p) => {
          published = p;
        },
        onFailed: () => {},
      });
      return {
        done,
        land: (answer: SaveAnswer = landed) => releaseSave(answer),
        fail: (why = "staging refused the push") => releaseSave(new Error(why)),
      };
    },
  };
}

await it("one call carries every change, and the page holds still for it", async () => {
  const p = page();
  p.edit({ sharedBuildCache: false });
  p.edit({ verifyPipeline: [{ kind: "script", path: "scripts/verify.sh" }] });
  const save = p.publish();
  await Promise.resolve();
  eq(p.saves.length, 1, "one save");
  eq(p.saves[0].sharedBuildCache, false);
  eq(p.saves[0].verifyPipeline, [{ kind: "script", path: "scripts/verify.sh" }]);
  eq(p.session.phase, "publishing");
  eq(p.editable, false, "and nothing may be edited under it");
  eq(p.edit({ sharedBuildCache: true }), false);
  save.land();
  eq(await save.done, true);
  eq(p.published, { queued: true, branch: "staging", count: 2 });
  eq(p.problem, null);
  eq(p.session.phase, "idle", "the read that followed released it");
  eq(p.session.draft, {});
});

await it("Windows walk (C5): the toast names where the publish really goes", async () => {
  const p = page();
  p.edit({ sharedBuildCache: false });
  const save = p.publish({ target: "release" });
  await Promise.resolve();
  save.land();
  eq(await save.done, true);
  eq(p.published?.branch, "release", "not the gone branch the cache still names");
});

await it("a second press while the save is out sends nothing", async () => {
  const p = page();
  p.edit({ sharedBuildCache: false });
  const save = p.publish();
  await Promise.resolve();
  const second = p.publish();
  eq(await second.done, false, "refused");
  eq(p.saves.length, 1, "one save, so one commit");
  save.land();
  await save.done;
});

await it("a deferred save, a failed read, and then a good one", async () => {
  // F3, end to end. The save applies On→Off on this Mac and then fails;
  // the read that would say so fails too. Until one succeeds the page has
  // no baseline to measure an edit against, so it takes none — and the
  // draft it kept is still there to try again.
  const p = page({ readFails: true });
  p.edit({ sharedBuildCache: false });
  const save = p.publish();
  await Promise.resolve();
  save.fail("staging refused the push");
  eq(await save.done, false);
  eq(p.reads, ["failed"], "it asked, and was told nothing");
  eq(p.session.phase, "settling");
  eq(p.editable, false, "so it keeps still");
  eq(p.edit({ sharedBuildCache: true }), false, "and refuses the edit rather than losing it");
  eq(p.session.draft, { sharedBuildCache: false }, "the draft is whole");
  eq(p.problem?.title, "Your changes couldn't be published to staging.");
  eq(p.problem?.untouched.includes("may already be in the rows below"), true);

  // A press while it is still held sends nothing and changes nothing.
  const second = p.publish();
  eq(await second.done, false);
  eq(p.saves.length, 1, "still the one save");
  eq(p.problem?.title, "Your changes couldn't be published to staging.", "and the same reason");
});

await it("nothing is published while a read has failed", async () => {
  // The first build field published carries values Ply read here, so a
  // page that could not read them does not send.
  const p = page();
  p.edit({ sharedBuildCache: false });
  const attempt = p.publish({ readError: "could not resolve host github.com" });
  eq(await attempt.done, false);
  eq(p.saves.length, 0, "nothing was sent");
  eq(p.problem?.title, "Publishing waits until Plyloft can read these settings again.");
  eq(p.problem?.todo.includes("Read again"), true);
  eq(p.session.phase, "idle", "and the page was never held still for it");
});

await it("the read that succeeds hands the page a baseline again", async () => {
  const p = page({ readFails: true });
  p.edit({ sharedBuildCache: false });
  const save = p.publish();
  await Promise.resolve();
  save.fail();
  await save.done;
  eq(p.editable, false);
  // The page asks again — as `Read again` does — and this one brings
  // values: the save had applied Off here before it failed.
  p.letReadsFail(false);
  p.setValues({ ...base, sharedBuildCache: false });
  const r = reduce(p.session, { kind: "read", ok: true, values: { ...base, sharedBuildCache: false } });
  eq(r.session.phase, "idle", "released by a read that brought something");
  eq(r.session.draft, {}, "and the draft matched what this Mac now has");
});

await it("reading back cannot turn a publish that landed into one that failed", async () => {
  // F30: the reload and the workspace refresh come after the save. Their
  // trouble is not the save's, and the page must not say it was.
  const p = page();
  p.edit({ sharedBuildCache: false });
  const save = p.publish();
  await Promise.resolve();
  save.land({ queue: { fields: {} }, cache: { branch: "staging" } });
  eq(await save.done, true, "the save landed, and that is what is reported");
  eq(p.problem, null, "no failure on the page");
  eq(p.published?.queued, false, "and it says the repository already had it");
});

await it("nothing is published to a repository that shares nothing", async () => {
  const p = page();
  p.edit({ sharedBuildCache: false });
  const attempt = p.publish({ definition: null });
  eq(await attempt.done, false);
  eq(p.saves.length, 0);
  eq(p.problem?.title, "There is nothing to publish to.");
  eq(p.session.phase, "idle", "and the page was never held still for it");
});

if (failed > 0) {
  console.error(`publishDraft.test.ts: ${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`publishDraft.test.ts: ${passed} passed`);

// ── 1.175.0 (C3, SC-3): the save's base says what each field was changed from ──
{
  const sent = { integrationBranch: "develop", sharedBuildCache: false };
  const values: Values = { ...base, integrationBranch: "release" };
  const out = withBases(definition as unknown as Record<string, unknown>, BUILD_FIELDS, values, sent, {
    integrationBranch: "staging",
  });
  eq(out.integrationBranch, "staging", "what it was changed from, not the repository's value now");
  eq(out.sharedBuildCache, true, "no base recorded: the definition's value");
  eq(out.name, "LYRA", "a field not sent is untouched");
  // A field sent at the value in use is no change, and takes no base.
  eq(withBases(definition as unknown as Record<string, unknown>, BUILD_FIELDS, values, { integrationBranch: "release" }, { integrationBranch: "staging" }).integrationBranch, "staging");
}
console.log("publishDraft.test.ts: C3 ok");
