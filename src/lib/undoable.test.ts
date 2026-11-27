// UX language card 8, review 1 (GH #103): one live Undo per field, and an Undo
// that has been overtaken does nothing. Run with:
//
//     node --experimental-strip-types src/lib/undoable.test.ts

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  UNDO_SUPERSEDED,
  claimUndo,
  fieldUndoKey,
  liveUndo,
  releaseUndo,
  resetUndoKey,
  runUndo,
  undoStillApplies,
} from "./undoable.ts";
import { createMutationQueue } from "./settingsQueue.ts";

// ── One live Undo per field ──────────────────────────────────────────────

const live = new Map<string, string>();
const theme = fieldUndoKey("appearance.theme");
const accent = fieldUndoKey("appearance.accent");

assert.equal(claimUndo(live, theme, "t1"), null, "the first change replaces nothing");
assert.equal(liveUndo(live, theme), "t1");

// The same field again within the window: the older toast is handed back to be
// dismissed, so two Undos for one field can never both be on screen. This is
// the bug: `TypeOrChoose` commits on blur and again on the pick, so one gesture
// made two — and pressing the older one restored the value from before the
// first change and threw the second away silently.
assert.equal(claimUndo(live, theme, "t2"), "t1");
assert.equal(liveUndo(live, theme), "t2");

// A different field keeps its own.
assert.equal(claimUndo(live, accent, "a1"), null);
assert.equal(liveUndo(live, theme), "t2", "one field's change does not touch another's");
assert.equal(liveUndo(live, accent), "a1");

// Claiming with the id already live replaces nothing (nothing to dismiss).
assert.equal(claimUndo(live, theme, "t2"), null);

// Releasing only clears the entry when it is still this toast's.
releaseUndo(live, theme, "t1");
assert.equal(liveUndo(live, theme), "t2", "an expired older toast does not clear the newer");
releaseUndo(live, theme, "t2");
assert.equal(liveUndo(live, theme), null);
assert.equal(liveUndo(live, accent), "a1", "and leaves the other field alone");

// A page's reset is filed separately from any of its fields.
assert.notEqual(resetUndoKey("appearance"), fieldUndoKey("appearance"));
assert.notEqual(resetUndoKey("appearance"), fieldUndoKey("appearance.theme"));

// ── An Undo that has been overtaken is inert ─────────────────────────────

assert.equal(undoStillApplies("dark", "dark"), true);
assert.equal(undoStillApplies("dark", "void"), false, "something else changed it");
// `null` and absent are one value in settings.json: a model field written blank
// over an absent one has not moved.
assert.equal(undoStillApplies(null, undefined), true);
assert.equal(undoStillApplies(undefined, null), true);
assert.equal(undoStillApplies(null, ""), false);
assert.equal(undoStillApplies(true, false), false);
assert.equal(undoStillApplies(30, 30), true);
assert.equal(undoStillApplies({ days: 30 }, { days: 30 }), true, "objects by value");
assert.equal(undoStillApplies({ days: 30 }, { days: 7 }), false);

assert.ok(UNDO_SUPERSEDED.includes("Nothing was changed"), "it says what it did not do");
assert.ok(UNDO_SUPERSEDED.endsWith("."));

// ── An Undo decides inside the mutation, not before it ───────────────────
// Review 2 (N1): comparing before enqueueing reads the last *committed* state,
// and a second change to the same field can be in flight — its write sent, its
// result not back. Driven here through the real queue with a deliberately slow
// write, the way #100 review 2 drove its own in-flight case.

type Box = { v: string };

function slowQueue(state: Box, delayMs: number) {
  const sent: Box[] = [];
  let committed = state;
  const mutate = createMutationQueue<Box>({
    read: () => committed,
    send: async (next) => {
      sent.push(next);
      await new Promise((r) => setTimeout(r, delayMs));
      return next;
    },
    commit: (saved) => {
      committed = saved;
    },
  });
  return { mutate, sent, get committed() { return committed; } };
}

{
  // Nothing else happened: the Undo writes, and says it did.
  const q = slowQueue({ v: "" }, 1);
  await q.mutate(() => ({ v: "a" }));
  const applied = await runUndo(q.mutate, {
    announced: "a",
    read: (s: Box) => s.v,
    restore: () => ({ v: "" }),
  });
  assert.equal(applied, true);
  assert.equal(q.committed.v, "");
}

{
  // The bug. A second change is **in flight** — sent, not committed — when the
  // first change's Undo is pressed. Reading the committed state would see "a",
  // pass, and queue a restore behind that write, throwing "b" away silently.
  const q = slowQueue({ v: "" }, 20);
  await q.mutate(() => ({ v: "a" }));
  const second = q.mutate(() => ({ v: "b" }));
  // Pressed while `second` is still on the wire: `committed` is still "a".
  assert.equal(q.committed.v, "a", "the second write has not landed yet");
  const undone = runUndo(q.mutate, {
    announced: "a",
    read: (s: Box) => s.v,
    restore: () => ({ v: "" }),
  });
  await second;
  assert.equal(await undone, false, "it found the value had moved on");
  assert.equal(q.committed.v, "b", "and left the second change alone");
}

{
  // And the queue is not wedged by a refusal: the next change still lands.
  const q = slowQueue({ v: "a" }, 1);
  assert.equal(
    await runUndo(q.mutate, {
      announced: "z",
      read: (s: Box) => s.v,
      restore: () => ({ v: "" }),
    }),
    false,
  );
  await q.mutate(() => ({ v: "c" }));
  assert.equal(q.committed.v, "c");
  assert.deepEqual(
    q.sent.map((s) => s.v),
    ["c"],
    // GH #178: it used to send the state unchanged (a whole `settings_set`
    // for nothing); a mutation that returns `latest` now sends nothing.
    "a refused Undo sends nothing; the next change is sent once",
  );
}

// ── The hook uses both rules, and the pages never start a procedure on blur ──

const hook = readFileSync(
  new URL("../components/settings/useMacSettings.ts", import.meta.url),
  "utf8",
);
assert.match(hook, /claimUndo\(/, "one live Undo per field");
assert.match(hook, /dismissToast\(/, "and the one it replaces is taken off the screen");
assert.match(hook, /runUndo\(update, \{/, "the check happens inside the mutation");
assert.doesNotMatch(
  hook,
  /undoStillApplies\(/,
  "and never against the last committed state from outside one (N1)",
);
assert.match(hook, /if \(!applied\) pushToast/, "inertness is reported by the mutation");
assert.match(hook, /UNDO_SUPERSEDED/, "and says why it did not write");
assert.match(hook, /resetUndoKey\(/, "the page reset is filed under its own key");

// Review 1 (BLOCKER): `onCommit` fires on blur as well as Enter, so it is for a
// setting — which saves as it changes and can be undone. A field whose Enter
// runs a procedure takes `onEnter`, and a page that hands `onCommit` anything
// but a settings write is the bug this contract exists to stop.
const controls = readFileSync(
  new URL("../components/ux/controls.tsx", import.meta.url),
  "utf8",
);
// 1.176.2: the field names itself as the row in use first, then commits.
assert.match(
  controls,
  /onBlur=\{\(e\) => \{\s*noteBlurredField\(e\.target\);\s*onCommit\?\.\(e\.target\.value\);\s*\}\}/,
);
assert.doesNotMatch(controls, /onBlur=\{[^}]*onEnter/, "onEnter never fires on blur");
assert.match(controls, /onEnter\?\.\(e\.currentTarget\.value\)/);

// Review 2 (N3): inverted, so a page this test has never heard of is covered.
// **Every** `onCommit=` in `components/settings/` has to resolve to a settings
// write or a local state setter; anything else is a procedure being started by
// looking away, which is the blocker round 1 found. Brace-matched, so a
// multi-line handler is read whole.
const PAGES = new URL("../components/settings/", import.meta.url);
const settingsFiles = readdirSync(PAGES).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
assert.ok(settingsFiles.length >= 12, `${settingsFiles.length} settings files scanned`);

/** A handler's code, without its comments — prose is not a call. */
function code(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** The `{…}` expression of every `prop={…}` in `text`, brace-matched. */
function handlers(text: string, prop: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`${prop}=\\{`, "g");
  for (let m = open.exec(text); m; m = open.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    out.push(text.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

// What a commit is allowed to call. `mac.set` is the settings write; a `set…`
// name is a React state setter or a named settings write (`setCloneRoot`); the
// rest are reads, promise plumbing and string work. `correctionAfterSave`
// (1.176.2) is a read: it says what the box should show once a save answered.
// `confirmUnknownModel` (1.176.3) asks and writes nothing: the save stays in
// the same handler, after its answer.
const COMMIT_CALLS =
  /^(mac\.set|mac\.latest|draft\.set|set[A-Z]\w*|String|Number|Boolean|then|catch|finally|onSaved|map|trim|correctionAfterSave|confirmUnknownModel)$/;
/** Language, not calls: `if (…)`, `for (…)`, `return (…)`. */
const KEYWORDS = /^(if|for|while|switch|return|await|void|typeof|new|function|catch)$/;

let commits = 0;
for (const name of settingsFiles) {
  const text = readFileSync(new URL(name, PAGES), "utf8");
  for (const body of handlers(text, "onCommit").map(code)) {
    commits++;
    const called = [...body.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)].map(
      (c) => c[1],
    );
    assert.ok(
      called.some((c) => /^(mac\.set|draft\.set|set[A-Z]\w*)$/.test(c)),
      `${name}: an onCommit must write a setting — found ${JSON.stringify(called)}`,
    );
    for (const call of called) {
      if (KEYWORDS.test(call)) continue;
      const tail = call.includes(".") ? call.split(".").pop()! : call;
      assert.ok(
        COMMIT_CALLS.test(call) || COMMIT_CALLS.test(tail),
        `${name}: onCommit calls ${call}(), which is not a settings write — a procedure belongs on onEnter`,
      );
    }
  }
  // And the way out of a question is on the keyboard.
  for (const body of handlers(text, "onEnter")) {
    assert.ok(body.length > 0, `${name}: an empty onEnter`);
  }
}
// Three today: `TextRow`, `ChooseField` and the clone root. Every other field
// in Settings either runs a procedure (`onEnter`) or is committed by a button.
assert.ok(commits >= 3, `${commits} onCommit handlers checked`);
// The pages whose Enter runs a procedure keep it off onCommit, and each has a
// way out. (Launch A3 retired the Licence page and its key flow.)
for (const name of ["BoardPage.tsx", "TeamPage.tsx"] as const) {
  const text = readFileSync(new URL(name, PAGES), "utf8");
  assert.ok(handlers(text, "onEnter").length > 0, `${name} runs its procedure on Enter`);
  assert.ok(handlers(text, "onCancel").length > 0, `${name}: Esc abandons the question`);
}

// Review 2 (N4): a refused write leaves what was typed where it is.
const rows = readFileSync(new URL("rows.tsx", PAGES), "utf8");
assert.equal(
  (rows.match(/\.then\(\(ok\) => \{/g) ?? []).length,
  2,
  "both commit paths read the write's answer",
);
assert.equal(
  (rows.match(/if \(!ok\) return;/g) ?? []).length,
  2,
  "and neither wipes the box when it was refused",
);

// 1.176.3: the question writes nothing — pinned, so a later edit that makes it
// write fails here instead of hiding behind the onCommit allowlist.
const ask = readFileSync(new URL("./unknownModelAsk.ts", import.meta.url), "utf8");
const askImports = [...ask.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]).sort();
assert.deepEqual(askImports, ["../store/confirmStore", "./roleModels", "./unknownModel"], "the ask imports no store that writes");
assert.doesNotMatch(ask, /mac\.set|invoke\(|settings_set|\.set\(/, "the ask never writes");

console.log("undoable: all assertions passed");
