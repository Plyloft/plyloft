// What a Repository page's draft does while a save is out, and while the
// read that follows it comes back — or does not (card #94 review, F1, F3).
//
// The page is a dispatcher: it says what happened and `draftSession`
// decides. So the sequence below is the real one, event for event, with a
// save that finishes when this test says so and a read that fails when it
// says so — neither is a stand-in.
//
// Run: node --experimental-strip-types src/lib/draftSession.test.ts

import {
  discardable,
  editable,
  emptySession,
  reduce,
  type DraftEvent,
  type DraftSession,
} from "./draftSession.ts";
import { changes, savePayload, BUILD_FIELDS } from "./repositoryPage.ts";
import type { Draft, Values } from "./repositoryPage.ts";
import type { WorkspaceDefinition } from "../ipc";

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
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

const verify = [{ kind: "script", path: "scripts/verify.sh" }];

/**
 * A page, driven the way the real one drives the session: a save that
 * settles when the test says so, and a read the test can make fail.
 * `values` is what Ply has read — it moves only when a read succeeds,
 * which is the whole point of the phase this exercises.
 */
function page(initial: Values = base) {
  let session = emptySession();
  let values = initial;
  const send = (event: DraftEvent) => {
    const r = reduce(session, event);
    session = r.session;
    return r.accepted;
  };
  return {
    get draft() {
      return session.draft;
    },
    get editable() {
      return editable(session);
    },
    get discardable() {
      return discardable(session);
    },
    get phase() {
      return session.phase;
    },
    edit: (next: Draft) => send({ kind: "edit", values, next }),
    discard: () => send({ kind: "discard" }),
    /** Publish pressed. The save settles when the test releases it, and
     *  the page then waits for a read, as the real one does. */
    publish() {
      send({ kind: "publishBegan" });
      const sent = session.sent ?? {};
      let release!: (ok: boolean) => void;
      const done = new Promise<boolean>((ok) => {
        release = ok;
      }).then((landed) => {
        send(landed ? { kind: "publishSaved" } : { kind: "publishFailed" });
        return landed;
      });
      return { sent, done, land: () => release(true), fail: () => release(false) };
    },
    /** A read came back with what Ply now has. */
    read(next: Values = values) {
      values = next;
      return send({ kind: "read", ok: true, values: next });
    },
    /** A read came back with nothing: it failed. */
    readFailed() {
      return send({ kind: "read", ok: false });
    },
    /** What the page shows moved without a read of its own — a rename in
     *  the sidebar, an accent picked there. */
    valuesChanged(next: Values) {
      values = next;
      return send({ kind: "valuesChanged", values: next });
    },
  };
}

await it("an edit made while the save is out is refused, not swallowed", async () => {
  // F1, F3: the cache was On, the draft turned it Off, and it is turned
  // back On while the save is waiting behind a refresh. Taking that edit
  // would prune it against a baseline about to move and lose it; the page
  // refuses it instead, so the control stays where it was.
  const p = page();
  p.edit({ sharedBuildCache: false });
  const save = p.publish();
  eq(save.sent, { sharedBuildCache: false });
  eq(p.editable, false, "the page is holding still");
  eq(p.edit({ sharedBuildCache: true }), false, "and says so");
  eq(p.draft, { sharedBuildCache: false }, "nothing moved under the save");
  save.land();
  await save.done;
  p.read({ ...base, sharedBuildCache: false });
  eq(p.draft, {}, "what was published is gone");
  eq(p.editable, true);
  eq(p.edit({ sharedBuildCache: true }), true, "and the page takes edits again");
});

await it("the page holds still until a read says what the save did", async () => {
  const p = page();
  p.edit({ sharedBuildCache: false });
  const save = p.publish();
  save.land();
  await save.done;
  eq(p.phase, "settling");
  eq(p.draft, {}, "what was published is gone");
  eq(p.editable, false, "but the page waits for the read");
  eq(p.edit({ sharedBuildCache: true }), false);
  p.read({ ...base, sharedBuildCache: false });
  eq(p.phase, "idle");
  eq(p.edit({ sharedBuildCache: true }), true);
  eq(p.draft, { sharedBuildCache: true });
});

await it("a read that failed does not hand back a stale baseline", async () => {
  // F3: the save applied On→Off here and then failed; the read that would
  // say so fails too. Taking an edit now would measure it against the On
  // Ply still has in hand, and the next successful read would wipe it.
  const p = page();
  p.edit({ sharedBuildCache: false });
  const save = p.publish();
  save.fail();
  await save.done;
  eq(p.readFailed(), false, "a read that brought nothing answers nothing");
  eq(p.phase, "settling");
  eq(p.editable, false, "so the page is no wiser and keeps still");
  eq(p.edit({ sharedBuildCache: true }), false);
  eq(p.draft, { sharedBuildCache: false }, "and the draft is untouched");
  // Twice over: a page waiting on a read that keeps failing keeps waiting.
  p.readFailed();
  eq(p.editable, false);
  // A read that succeeds is what lets it be edited again, against what Ply
  // really has — which the failed save had already applied here.
  p.read({ ...base, sharedBuildCache: false });
  eq(p.phase, "idle");
  eq(p.draft, {}, "the draft matched what this Mac now has");
  eq(p.edit({ sharedBuildCache: true }), true);
  eq(p.draft, { sharedBuildCache: true }, "measured against Off, so a change");
});

await it("Discard is the person's once the save itself is done", async () => {
  // Their way out of a page waiting on a read that keeps failing.
  const p = page();
  p.edit({ verifyPipeline: verify });
  const save = p.publish();
  eq(p.discardable, false, "not while the save is carrying it");
  eq(p.discard(), false);
  eq(p.draft, { verifyPipeline: verify });
  save.fail();
  await save.done;
  p.readFailed();
  eq(p.editable, false, "still waiting to know what happened");
  eq(p.discardable, true, "but dropping unsent work is always theirs");
  eq(p.discard(), true);
  eq(p.draft, {});
});

await it("a save that failed leaves the draft whole", async () => {
  const p = page();
  p.edit({ verifyPipeline: verify });
  p.edit({ sharedBuildCache: false });
  const save = p.publish();
  save.fail();
  await save.done;
  p.read(base);
  eq(p.draft, { verifyPipeline: verify, sharedBuildCache: false }, "still there to try again");
  eq(p.editable, true);
  eq(changes(BUILD_FIELDS, base, p.draft).length, 2, "and still two changes on the bar");
});

await it("only what the save carried is cleared", async () => {
  // Handed a draft with more in it than the save carried, the rule takes
  // away only what was sent.
  const more: DraftSession = {
    draft: { verifyPipeline: verify, sharedBuildCache: false },
    phase: "publishing",
    sent: { verifyPipeline: verify },
    bases: {},
    published: null,
  };
  const after = reduce(more, { kind: "publishSaved" }).session;
  eq(after.draft, { sharedBuildCache: false });
  eq(after.phase, "settling", "still held until a read lands");
  eq(after.sent, null);
  // And a row edited again while its own save was out keeps the newer
  // value: that value was never published.
  const again: DraftSession = {
    draft: { verifyPipeline: null },
    phase: "publishing",
    sent: { verifyPipeline: verify },
    bases: {},
    published: null,
  };
  eq(reduce(again, { kind: "publishSaved" }).session.draft, { verifyPipeline: null });
});

await it("a read while the save is out prunes, and does not release", async () => {
  const p = page();
  p.edit({ verifyPipeline: verify, sharedBuildCache: false });
  const save = p.publish();
  // Someone else published the pipeline meanwhile: that key is theirs now.
  p.read({ ...base, verifyPipeline: verify });
  eq(Object.keys(p.draft), ["sharedBuildCache"]);
  eq(p.phase, "publishing", "the save is still out, so nothing is released");
  eq(p.editable, false);
  save.land();
  await save.done;
  p.read({ ...base, verifyPipeline: verify, sharedBuildCache: false });
  eq(p.draft, {}, "and the rest went with the save");
  eq(p.editable, true);
});

await it("a refused This-Mac save puts back only what it tried", async () => {
  eq(
    reduce(
      { draft: { verifyPipeline: verify, sharedBuildCache: false }, phase: "idle", sent: null, bases: {}, published: null },
      { kind: "localSaveFailed", tried: { sharedBuildCache: false } },
    ).session.draft,
    { verifyPipeline: verify },
  );
  // A row edited again since keeps the newer value: it has its own save.
  eq(
    reduce(
      { draft: { sharedBuildCache: true }, phase: "idle", sent: null, bases: {}, published: null },
      { kind: "localSaveFailed", tried: { sharedBuildCache: false } },
    ).session.draft,
    { sharedBuildCache: true },
  );
});

await it("the page belongs to one workspace at a time", async () => {
  const held: DraftSession = {
    draft: { verifyPipeline: verify },
    phase: "settling",
    sent: null,
    bases: {},
    published: null,
  };
  eq(
    reduce(held, { kind: "reset" }).session,
    emptySession(),
    "another workspace starts clean, and unfrozen",
  );
});

await it("values that move without a read still rebase the draft", async () => {
  // F6: a key left in the draft is invisible while the values agree with
  // it, and becomes a change — publishable over someone else's — the
  // moment they move. The page shows values that can move on their own: a
  // rename or an accent picked in the sidebar reaches it without a read.
  const p = page();
  p.edit({ name: "LYRA" });
  eq(p.draft, {}, "the same name as the values: no change");
  p.edit({ name: "LYRA renamed" });
  eq(p.draft, { name: "LYRA renamed" });
  // The rename lands from elsewhere: the draft has caught up with it.
  p.valuesChanged({ ...base, name: "LYRA renamed" });
  eq(p.draft, {}, "nothing left to publish");
  eq(p.phase, "idle");
  // And it settles nothing: a page waiting to know what its save did is
  // still waiting, because only a read says that.
  const p2 = page();
  p2.edit({ sharedBuildCache: false });
  const save = p2.publish();
  save.fail();
  await save.done;
  eq(p2.phase, "settling");
  p2.valuesChanged({ ...base, name: "renamed elsewhere" });
  eq(p2.phase, "settling", "a rename is not an answer about the save");
  eq(p2.editable, false);
  p2.read({ ...base, sharedBuildCache: false });
  eq(p2.editable, true);
});

await it("the payload is built from what the save carried, not from later", async () => {
  const definition: WorkspaceDefinition = {
    schemaVersion: 1,
    name: "LYRA",
    board: "local",
    integrationBranch: "staging",
  };
  const p = page();
  p.edit({ verifyPipeline: verify });
  const save = p.publish();
  const payload = savePayload(definition, BUILD_FIELDS, base, save.sent);
  eq(payload.verifyPipeline, verify);
  eq("sharedBuildCache" in payload, false, "nothing the save did not carry");
  save.land();
  await save.done;
});

if (failed > 0) {
  console.error(`draftSession.test.ts: ${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`draftSession.test.ts: ${passed} passed`);

// ── 1.175.0 (C3, SC-3): what each drafted field was changed from ──────
await it("a drafted field keeps the value it was changed from, through a read", async () => {
  const values = (patch: Partial<Values>): Values => ({ ...base, ...patch });
  const first = values({ sharedBuildCache: false, verifyPipeline: null });
  let s = emptySession();
  s = reduce(s, { kind: "edit", values: first, next: { sharedBuildCache: true } }).session;
  eq(s.bases, { sharedBuildCache: false }, "the value in use at the first edit");
  // Put back as it was: the key and its base go.
  s = reduce(s, { kind: "edit", values: first, next: { sharedBuildCache: false } }).session;
  eq(s.draft, {}, "put back as it was");
  eq(s.bases, {}, "and the base goes with the draft key");
  s = reduce(s, { kind: "edit", values: first, next: { sharedBuildCache: true } }).session;
  s = reduce(s, { kind: "edit", values: first, next: { verifyPipeline: verify } }).session;
  eq(s.bases, { sharedBuildCache: false, verifyPipeline: null });
  // A teammate publishes another value meanwhile; the read applies it here.
  const moved = values({ sharedBuildCache: false, verifyPipeline: [{ kind: "script", path: "theirs.sh" }] });
  s = reduce(s, { kind: "read", ok: true, values: moved }).session;
  eq(s.draft, { sharedBuildCache: true, verifyPipeline: verify }, "the draft stays");
  eq(s.bases, { sharedBuildCache: false, verifyPipeline: null }, "and so does what it was changed from");
  // A read that brings the drafted value drops the key and its base.
  const caught = values({ sharedBuildCache: true, verifyPipeline: [{ kind: "script", path: "theirs.sh" }] });
  s = reduce(s, { kind: "read", ok: true, values: caught }).session;
  eq(s.bases, { verifyPipeline: null });
  // Publish: the sent fields are counted, their bases go once the save landed.
  s = reduce(s, { kind: "publishBegan" }).session;
  s = reduce(s, { kind: "publishSaved" }).session;
  eq(s.published, ["verifyPipeline"]);
  eq(s.bases, {});
  // Discard clears both.
  s = reduce(emptySession(), { kind: "edit", values: first, next: { sharedBuildCache: true } }).session;
  s = reduce(s, { kind: "discard" }).session;
  eq(s.bases, {});
  eq(reduce(s, { kind: "reset" }).session, emptySession());
});
