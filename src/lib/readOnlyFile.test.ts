// GH #142. Run with Node 22+:
//   node --experimental-strip-types src/lib/readOnlyFile.test.ts
//
// Two halves, the card's two tests.
//
// **The rule.** Which copy of a skill Code may write, per scope — the whole of
// it, in one pure function, so the four places the Library reaches cannot be
// decided differently in four files. That is the defect GH #96 review 1 found
// (a second derivation on the skill's page offered to save into the team clone),
// and the answer then was to offer no editor at all.
//
// **The source contract.** No save path reaches a read-only file. The editor has
// exactly one call that writes a file, and this asserts it is guarded — plus the
// three paths the card names that could become one: autosave, format-on-save, and
// the external-write reload, whose prompt offers "⌘S will overwrite the disk".
// The behaviour itself is Tier 4 (the files are byte-identical afterwards); what
// is held here is that there is nothing in the source that could do it.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Review 1 (MAJOR) found one `history()` serving every tab, so a buffer load in
// the undo stack was an edit the member could undo **onto another tab**. GH #170
// gave each open file its own `EditorState`; the rule that makes that safe is run
// for real here — `EditorState` and `history` need no DOM. The behaviour itself
// is rendered in `src/test/editorTabHistory.test.tsx`.
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import {
  OPEN_IN_CODE,
  READ_IN_CODE,
  READ_ONLY_TAB,
  WRITABLE,
  instructionFileMode,
  readOnlyLine,
  skillFileMode,
  type FileOpenMode,
  type InstructionCopy,
  type ReadOnlyPlace,
} from "./readOnlyFile.ts";
// The store itself, exercised rather than only read: `zustand`'s vanilla store
// needs no DOM, so the flag's whole lifetime — set, tampered with, saved,
// reopened both ways — can be a real test instead of a regex.
import { DIRTY_WRITABLE_REFUSAL, isFileDirty, useEditor } from "../store/editorStore.ts";
import { setPlatformForTests } from "./platform.ts";

let passed = 0;
const it = (what: string, run: () => void) => {
  run();
  passed += 1;
  void what;
};

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// ── The rule, per row scope ──────────────────────────────────────────────

it("only a checkout copy of a repository skill is writable", () => {
  assert.deepEqual(
    skillFileMode({ scope: "repository", fromMirror: false }),
    { readOnly: false },
    "the checkout is the one tree Plyloft may write",
  );
  assert.deepEqual(WRITABLE, { readOnly: false });
});

it("every other copy opens read-only, and says which place it is in", () => {
  const cases: [{ scope: "repository" | "team" | "this-mac" | "ply"; fromMirror: boolean }, ReadOnlyPlace][] = [
    // On the branch and not in this checkout: the bytes are Ply's mirror,
    // rebuilt from the branch on every refresh.
    [{ scope: "repository", fromMirror: true }, "mirror"],
    // The team library clone, which `TeamStore::sync` pulls `--ff-only`.
    [{ scope: "team", fromMirror: false }, "team"],
    // ADR 0005: Ply reads this Mac's own folder and never writes it.
    [{ scope: "this-mac", fromMirror: false }, "this-mac"],
    // The bundle inside the app.
    [{ scope: "ply", fromMirror: false }, "ply"],
  ];
  for (const [row, place] of cases) {
    assert.deepEqual(
      skillFileMode(row),
      { readOnly: true, place },
      `${row.scope}${row.fromMirror ? " (mirror)" : ""}`,
    );
  }
});

it("the rule is total: every scope answers, and only one answer is writable", () => {
  const every: FileOpenMode[] = (["repository", "team", "this-mac", "ply"] as const).flatMap(
    (scope) => [
      skillFileMode({ scope, fromMirror: false }),
      skillFileMode({ scope, fromMirror: true }),
    ],
  );
  assert.equal(every.length, 8);
  assert.equal(
    every.filter((mode) => !mode.readOnly).length,
    1,
    "`fromMirror` is meaningless outside the repository, and a scope that is " +
      "read-only is read-only whatever Plyloft read it from",
  );
});

it("the rule covers the Instructions page too, personal files included (GH #174)", () => {
  // Each copy of an instruction file is the skill scope it lives in, so the
  // Instructions page asks the same rule and cannot answer differently.
  assert.deepEqual(instructionFileMode("checkout"), WRITABLE, "the checkout is writable");
  assert.deepEqual(instructionFileMode("branch"), { readOnly: true, place: "mirror" });
  // `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`: this Mac's own folder, which
  // Ply reads and never writes — the same answer a personal skill gets.
  assert.deepEqual(instructionFileMode("this-mac"), { readOnly: true, place: "this-mac" });
  assert.deepEqual(
    instructionFileMode("this-mac"),
    skillFileMode({ scope: "this-mac", fromMirror: false }),
  );
  // Review 1 (copy): the skill's `this-mac` sentence offers `Promote`, which an
  // instruction file does not have, so the page says what the file is instead.
  assert.equal(
    readOnlyLine("this-mac", null, "instructions"),
    "Read-only — your own instruction file on this Mac, which every session here reads. " +
      "Plyloft reads it and never writes it; edit it in your own editor.",
  );
  // n15: the line is drawn raw (the editor's banner, a tab's tooltip), so it
  // names the machine as Windows does itself.
  setPlatformForTests("windows");
  try {
    assert.equal(
      readOnlyLine("this-mac", null, "instructions"),
      "Read-only — your own instruction file on this PC, which every session here reads. " +
        "Plyloft reads it and never writes it; edit it in your own editor.",
    );
    assert.match(readOnlyLine("team", null), /^Read-only — the team library on this PC, kept in step/);
  } finally {
    setPlatformForTests(null);
  }
  assert.equal(readOnlyLine("this-mac", null), readOnlyLine("this-mac", null, "skill"));
  assert.match(readOnlyLine("this-mac", null, "skill"), /promote it/);
  // The kind changes only the personal place's words.
  for (const place of ["mirror", "team", "ply"] as const) {
    assert.equal(readOnlyLine(place, "staging", "instructions"), readOnlyLine(place, "staging"));
  }
  const every: InstructionCopy[] = ["checkout", "branch", "this-mac"];
  assert.equal(
    every.filter((copy) => !instructionFileMode(copy).readOnly).length,
    1,
    "only one of the page's three copies is writable",
  );
});

it("the line says where the copy lives and why it cannot be edited here", () => {
  const branchNamed = readOnlyLine("mirror", "staging");
  assert.match(branchNamed, /staging/, "the branch is named when Plyloft knows it");
  assert.match(
    readOnlyLine("mirror", null),
    /the integration branch/,
    "and called what the rest of the Library calls it when Plyloft does not",
  );
  assert.doesNotMatch(readOnlyLine("mirror", null), /null/);
  for (const place of ["mirror", "team", "this-mac", "ply"] as const) {
    const line = readOnlyLine(place, "staging");
    assert.match(line, /^Read-only — /, `${place}: it opens with what it is`);
    // Why, not only what: each line carries the reason this copy is not Ply's
    // to change, so the member is not left to guess at a refusal.
    assert.ok(line.length > 60, `${place}: a reason, not a label`);
  }
  // Four places, four different sentences.
  const lines = new Set(
    (["mirror", "team", "this-mac", "ply"] as const).map((p) => readOnlyLine(p, "staging")),
  );
  assert.equal(lines.size, 4);
  assert.equal(READ_ONLY_TAB, "read-only");
  assert.notEqual(READ_IN_CODE, OPEN_IN_CODE);
});

// ── The source contract: no save path reaches a read-only file ───────────

const panel = read("../components/EditorPanel.tsx");
const store = read("../store/editorStore.ts");
const tabs = read("../components/EditorTabContent.tsx");

it("the editor writes a file in exactly one place, and it is guarded", () => {
  const writes = [...panel.matchAll(/invoke<[^>]*>\("fs_write_text_file"/g)];
  assert.equal(writes.length, 1, "one save path in the editor, and one only");
  // …and it is `saveCmd`, whose first act is to refuse a read-only copy. The
  // guard reads the store rather than a ref: which path is in the view is a
  // fact about the view, and whether that path is a reading view is a fact
  // about the open file.
  const body = panel.slice(panel.indexOf("const saveCmd = ("), writes[0].index);
  assert.match(body, /if \(file\?\.readOnly\) return true;/);
  // GH #170: the path and the bytes are the same state's — the one ⌘S was
  // pressed in — so a save can only write a file's own document to that file.
  assert.match(body, /const path = target\.state\.facet\(FILE_PATH\);/);
  // Windows re-check of block 6: `sliceDoc` keeps a CRLF file's line ends.
  assert.match(body, /const content = target\.state\.sliceDoc\(\);/);
  assert.match(
    body,
    /useEditor\s*\n?\s*\.getState\(\)[\s\S]*?\.openFiles\.find\(/,
    "the guard is read from the store, not from a ref or a path",
  );
  // ⌘S is the only key bound to it, and it is bound once.
  assert.equal(
    (panel.match(/key: "Mod-s", run: saveCmd/g) ?? []).length,
    1,
    "one binding for the one save",
  );
});

it("nothing in the editor saves without a keystroke", () => {
  // The card names autosave and format-on-save. Neither exists, and this is
  // what keeps it that way: either would be a second write path, and a second
  // write path is how a reading view becomes a write nobody asked for.
  assert.doesNotMatch(panel, /autosave|autoSave|formatOnSave|onSave\b/i);
  assert.doesNotMatch(
    panel,
    /set(Timeout|Interval)\([^)]*save/i,
    "no timer may reach a save",
  );
  assert.doesNotMatch(
    panel,
    /saveCmd\(\)/,
    "`saveCmd` is a keymap command; nothing else calls it",
  );
});

/** Every `.ts`/`.tsx` of the app that is not a test, by repo-relative path. */
const src = fileURLToPath(new URL("..", import.meta.url));
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const at = join(dir, name);
    if (statSync(at).isDirectory()) walk(at, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(at);
  }
  return out;
}
const appFiles = walk(src).map((at) => ({
  path: at.slice(src.length).split("\\").join("/"),
  text: readFileSync(at, "utf8"),
}));

it("the whole app's writes of a file are three, and one of them is the editor's", () => {
  // Review 1 (NIT): counted across the whole of `src/`, not asserted over a list
  // that a fourth caller could simply not be on. The other two are not open
  // editor files — a run's edited prompt, a swarm's state — and a fourth has to
  // be looked at against this card before it lands. (GH #171 took the fourth
  // away: an agent's exported definition, with Settings › Agents.)
  const callers = appFiles
    .filter((f) => /fs_write_text_file/.test(f.text))
    .map((f) => f.path)
    .sort();
  assert.deepEqual(callers, [
    "components/AgentRunView.tsx",
    "components/EditorPanel.tsx",
    "lib/editorSave.ts",
    "store/swarmStore.ts",
  ]);
  // And the Library, which is what opens these tabs, is not among them.
  assert.ok(!callers.some((path) => path.startsWith("components/library/")));
});

it("QoL 1.168: Save all and Save and close write an open file only through isFileDirty", () => {
  // `lib/editorSave.ts` saves open files from outside their editor (the quit
  // sheet's Save all, ⌘⌥S, the tab's Save and close). Its one write sits
  // behind `isFileDirty` — false for a read-only copy — and the refused check,
  // so a reading view or a "can't open here" tab is never written.
  const save = appFiles.find((f) => f.path === "lib/editorSave.ts")!.text;
  const writes = [...save.matchAll(/invoke<[^>]*>\("fs_write_text_file"/g)];
  assert.equal(writes.length, 1);
  const before = save.slice(0, writes[0].index);
  assert.match(before, /if \(!file \|\| !isFileDirty\(file\) \|\| file\.refused\) return;\s*$/m);
});

it("a tab switch is a new state in the view, never a dispatch", () => {
  // GH #170, replacing GH #142's count of five whole-document dispatches, three of
  // them annotated `LOAD`. Each open file has its own `EditorState`, so its own
  // history, and a switch hands the view that state with `setState` — there is no
  // load for any history to record, and nothing for any writer to remember.
  assert.doesNotMatch(
    panel,
    /addToHistory\.of|annotations: LOAD|const LOAD\b/,
    "no load is annotated, because no load is dispatched",
  );
  assert.match(panel, /const statesRef = useRef\(new Map<string, EditorState>\(\)\);/);
  assert.equal((panel.match(/view\.setState\(/g) ?? []).length, 2, "the incoming file's state, and the blank");
  assert.match(panel, /view\.setState\(state\);/);
  assert.match(panel, /view\.setState\(createBlankState\(\)\);/);
  // Every dispatch is written inline as a spec object, so it can be read here;
  // a `dispatch(tr)` has to be looked at against this card.
  assert.doesNotMatch(panel, /\.dispatch\((?!\{)/);
  const all = [...panel.matchAll(/\.dispatch\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  assert.equal((panel.match(/\.dispatch\(/g) ?? []).length, all.length, "every site parsed");
  // Exactly one changes a document: the reload from disk, and only into the
  // state of the file it reloads — the view's only when the view's state
  // carries that path, and otherwise the file's stored state.
  const changing = all.filter((spec) => /changes:/.test(spec));
  assert.equal(changing.length, 1, `one document-changing dispatch:\n${changing.join("\n")}`);
  assert.match(changing[0], /insert: content \},\s*\n\s*annotations: RELOAD,/);
  const reload = panel.slice(
    panel.indexOf("function reloadIntoOwnState("),
    panel.indexOf("replaceFromDisk(workspaceId, path, content);"),
  );
  assert.ok(reload.includes(changing[0]), "the one change is `reloadIntoOwnState`'s");
  // Windows re-check of block 6: `let`, because a reload that changes the
  // file's line ends (LF ↔ CRLF) drops the state for the swap effect to build.
  assert.match(reload, /let own = stateOf\(path\);/);
  assert.match(reload, /if \(view && own && own === view\.state\) \{/);
  assert.match(reload, /own\.update\(\{\s*\n\s*changes: [^\n]*\n\s*annotations: RELOAD,/);
  // Review 1: the map is read in one place, `stateOf`, which answers the live
  // `view.state` for the file that is showing — never its stale map entry.
  assert.match(
    panel,
    /function stateOf\(path: string\): EditorState \| undefined \{\s*\n\s*const view = viewRef\.current;\s*\n\s*if \(view && view\.state\.facet\(FILE_PATH\) === path\) return view\.state;\s*\n\s*return statesRef\.current\.get\(path\);/,
  );
  assert.equal((panel.match(/statesRef\.current\.get\(|\bstates\.get\(/g) ?? []).length, 1);
  // No other state is changed outside the view either.
  assert.equal((panel.match(/\.update\(\{\s*\n?\s*changes:/g) ?? []).length, 1);
  // …and it is how every reload reaches a buffer: the watcher's, the prompt's
  // and (Windows re-check of block 6) the "isn't plain text" notice's Reload.
  assert.equal((panel.match(/reloadIntoOwnState\(/g) ?? []).length, 4, "defined once, called three times");
  // The rest change no document: the theme and wrap compartments, the
  // line-number and tab-size compartments (GH #205), the scroll snapshot on
  // switch-in, and the goto-line selection.
  assert.equal(all.length - changing.length, 5);
  // The reload stays undoable (GH #142 review 2) — an undo step of its own.
  assert.match(panel, /const RELOAD = isolateHistory\.of\("full"\);/);
  // A state's changes are recorded against its own path, never a ref's.
  assert.match(panel, /const path = update\.state\.facet\(FILE_PATH\);/);
});

it("library documentation: two states have two histories, and a read-only state refuses undo", () => {
  // Not a test of `EditorPanel` (review 1, NIT): it exercises CodeMirror alone,
  // and records the two library facts the per-file design stands on — a load in
  // one state is nothing to undo in another, and `undo` refuses a read-only
  // state. The panel's own behaviour is `src/test/editorTabHistory.test.tsx`.
  const a0 = EditorState.create({ doc: "the checkout's own file", extensions: [history()] });
  const a1 = a0.update({ changes: { from: 0, insert: "typed " } }).state;
  const b = EditorState.create({ doc: "PERSONAL, from ~/.claude/skills", extensions: [history()] });
  assert.equal(undo({ state: b, dispatch: () => assert.fail("B has nothing to undo") }), false);
  let after: string | null = null;
  undo({ state: a1, dispatch: (tr) => void (after = tr.state.doc.toString()) });
  assert.equal(after, "the checkout's own file");
  // And a reading view has no ⌘Z at all: `undo` refuses a read-only state.
  const reading = EditorState.create({
    doc: "read me",
    extensions: [history(), EditorState.readOnly.of(true)],
  }).update({ changes: { from: 0, insert: "reloaded " } }).state;
  let dispatched = false;
  assert.equal(
    undo({ state: reading, dispatch: () => void (dispatched = true) }),
    false,
  );
  assert.equal(dispatched, false);
});

it("the document itself refuses the edit, both ways", () => {
  assert.match(
    panel,
    /EditorState\.readOnly\.of\(true\), EditorView\.editable\.of\(false\)/,
    "`readOnly` stops the transactions; `editable(false)` stops the affordances",
  );
  // GH #170: built into each file's own state when it is created, from the
  // file's own flag — and a state whose flag no longer matches the store's is
  // replaced, never reconfigured, so a reading view's state never becomes a
  // writable one with its history behind it.
  // UX-8.5: a tab showing the "can't open here" page is read-only too.
  assert.match(panel, /readOnlyCompRef\.current!\.of\(file\.readOnly \|\| file\.refused \? READ_ONLY : EDITABLE\)/);
  assert.match(panel, /state\.readOnly !== !!\(file\.readOnly \|\| file\.refused\) \|\|/);
  assert.doesNotMatch(panel, /readOnlyComp[A-Za-z.]*\.reconfigure\(/);
  // The blank the view mounts on, and shows with no file open, is read-only
  // too, so no frame shows a read-only file as editable.
  assert.match(panel, /wrapCompRef\.current!\.of\(WRAP_OFF\),\s*\n\s*readOnlyCompRef\.current!\.of\(READ_ONLY\),/);
});

it("the external-write reload can never prompt a read-only file", () => {
  // Both answers of that question are about a write — "reload and lose your
  // edits" or "keep mine, and ⌘S overwrites the disk" — and a reading view has
  // neither. It follows the file it is reading instead.
  assert.match(panel, /const promptDirty =\s*\n?\s*!file\.readOnly &&/);
  assert.match(panel, /const promptAlways =\s*\n?\s*!file\.readOnly &&/);
  // And the removal toast does not offer a ⌘S that would do nothing.
  assert.match(panel, /body: file\.readOnly\s*\n?\s*\?/);
  // The prompt's own `Reload from disk` writes nothing: it replaces the buffer.
  const dialog = panel.slice(panel.indexOf("{pendingExternal && ("));
  assert.doesNotMatch(dialog, /fs_write_text_file/);
});

it("a read-only file has no dirty state, and so no Save anywhere", () => {
  assert.match(
    store,
    /return !!file && !file\.readOnly && file\.content !== file\.initialContent;/,
    "`isFileDirty` is what the dot, the close question and Ship all read",
  );
  // `markSaved` is the only thing that moves the baseline, and it refuses too.
  assert.match(
    store,
    /if \(ws\.openFiles\.find\(\(f\) => samePath\(f\.path, path\)\)\?\.readOnly\) return state;/,
  );
  // The dirty dot and the discard-on-close question are `isFileDirty`'s.
  assert.match(panel, /const dirty = isFileDirty\(f\);/);
  // QoL 1.168 S1-1: the close question is `closeEditorTab`'s (the × and ⌘W
  // share it), and it asks only when `isFileDirty` says so.
  assert.match(panel, /void closeEditorTab\(workspaceId, f\.path\);/);
  const save = read("./editorSave.ts");
  assert.match(save, /if \(!isFileDirty\(file\)\) \{\s*\n\s*useEditor\.getState\(\)\.close\(/);
  // The status bar says what it is instead of "⌘S to save".
  assert.match(panel, /\{readOnly\s*\n?\s*\? READ_ONLY_TAB/);
  // …and so does Ship, which lists the unsaved files before a release: it asks
  // the same helper rather than comparing the two fields itself.
  const ship = read("../components/ReleaseSheet.tsx");
  assert.match(ship, /openFiles\.filter\(\(f\) => isFileDirty\(f\)\)/);
  assert.doesNotMatch(ship, /f\.content !== f\.initialContent/);
});

it("the flag is per open, and never inherited by a writable one", () => {
  // Reopening a path already open used to be "bring the tab forward" and
  // nothing else. A reading view of `~/.claude/skills/x/SKILL.md` must not make
  // a later writable open of the same path a reading view — nor the reverse,
  // which would be a writable tab over a file Ply may not write.
  // One tab per file, however the path is spelled (Windows walk 2026-09-30).
  assert.match(store, /const already = ws\.openFiles\.find\(\(f\) => samePath\(f\.path, asked\)\);/);
  assert.match(
    store,
    /if \(next === null && \(already\.readOnly \?\? null\) === null\)/,
    "the tab is brought forward only between two writable opens — a read-only " +
      "reopen always rebuilds, so it cannot show stale bytes (review 1, MINOR)",
  );
  assert.match(
    store,
    /initialContent: content,[\s\S]{0,300}?\.\.\.\(next \? \{ readOnly: next \} : \{\}\),/,
    "a changed context rebuilds the tab from the bytes this open read",
  );
});

it("a read-only tab is not persisted, so a restart cannot hand it back writable", () => {
  // `Workspace.openFiles` is paths alone and the restore reopens each of them
  // through the ordinary writable path, so persisting one would undo all of the
  // above on the next launch.
  assert.match(tabs, /const kept = ws\.openFiles\.filter\(\(f\) => !f\.readOnly\);/);
  assert.match(tabs, /\.setFiles\(workspaceId, kept\.map\(\(f\) => f\.path\), active\)/);
  assert.match(
    tabs,
    /kept\.some\(\(f\) => f\.path === ws\.activePath\)/,
    "nor may the active path be one of them",
  );
});

// ── The Library opens them, through the one rule ─────────────────────────

it("the Library decides with the rule and nothing else", () => {
  const page = read("../components/library/SkillsPage.tsx");
  // One way into Code from this page, and `mode` is what the tab is.
  assert.equal((page.match(/async function openInCode\(/g) ?? []).length, 1);
  assert.match(page, /async function openInCode\(path: string, mode: FileOpenMode\)/);
  assert.match(page, /openInCode\(path, skillFileMode\(row\)\)/, "the `⋯`'s entry");
  assert.match(page, /openInCode\(path, skillFileMode\(open\)\)/, "the page's file rows");
  // `Edit in Code` stays checkout-only (GH #100), and says so at the call.
  assert.match(page, /openInCode\(joinPath\(dir, "SKILL\.md"\), WRITABLE\)/);
  // The place and the line travel with the file; the branch's name is the
  // Library's to know, not the editor's.
  assert.match(page, /line: readOnlyLine\(mode\.place, library\?\.branch \?\? null\)/);
});

it("the rows that said `Read here` open, and the file rows keep one call", () => {
  const detail = read("../components/library/SkillDetail.tsx");
  // Team walk 2026-10-01 (F4): the row's own files and the other CLI's copy
  // are one list of paths, opened by one call; `dir` still guards the first.
  assert.match(detail, /path: dir \? joinPath\(dir, file\.name\) : null/);
  assert.match(detail, /onOpen=\{item\.path \? \(\) => onOpenFile\(item\.path!\) : undefined\}/);
  assert.match(detail, /\{openable \? OPEN_IN_CODE : READ_IN_CODE\}/);
  assert.equal((detail.match(/onOpenFile\(/g) ?? []).length, 1);
  // `openInCode` is still the one fact for a savable tab (GH #96 review 1).
  assert.match(detail, /const openable = row\.openInCode;/);
});

it("only the branch's own copy gets a reading view, never a queued one", () => {
  // Review 1 (MINOR). The mirror carries the queue laid over the branch's tree
  // (GH #161), so for a queued row those bytes are the pending change's — and
  // this line, which is the one the editor would draw over them, says the branch
  // has the file and tells the member to pull it. Both halves would be false.
  // 1.174.0 E10 (T13): it names the branch to edit on.
  assert.match(readOnlyLine("mirror", "staging"), /rebuilds this from staging/);
  assert.match(readOnlyLine("mirror", "staging"), /edit it in your project folder on that branch/);
  assert.doesNotMatch(readOnlyLine("team", null), /team repo|repository/);
  // So Rust sets the path from `located`, and for `BranchOnly` alone. A
  // cross-language contract, like `NEVER_OVERRIDE_MARKER`: widening that arm has
  // to come past this line and past the words above it.
  const rust = read("../../src-tauri/src/instruction_files.rs");
  assert.match(
    rust,
    /read_only_path: match located \{\s*\n\s*InstructionFileWhere::BranchOnly => Some\(on_branch\.path\.clone\(\)\),\s*\n\s*_ => None,/,
  );
  assert.match(rust, /fn a_file_only_a_queued_change_wrote_is_not_read_as_the_branchs\(\)/);
});

it("the Instructions page's branch-only row opens the mirror's own path", () => {
  const instructions = read("../components/library/InstructionsPage.tsx");
  const data = read("../components/library/useInstructionsData.ts");
  assert.match(
    instructions,
    /: file\.readOnlyPath\s*\n?\s*\? \(\) => void openReadOnly\(file\.readOnlyPath!, "branch"\)/,
  );
  // The path is Rust's (`file_rows`), never one the window composed.
  assert.doesNotMatch(instructions, /readOnlyPath\s*\+|`\$\{[^}]*readOnlyPath/);
  // The mode is the rule's, and the place and the line travel with it.
  assert.match(data, /const mode = instructionFileMode\(copy\);/);
  assert.match(data, /if \(!mode\.readOnly\) throw /);
  assert.match(
    data,
    /\? \{ place: mode\.place, line: readOnlyLine\(mode\.place, branch, "instructions"\) \}\s*\n?\s*: null/,
  );
  // The checkout's copy, the one writable tab, is asked for by name.
  assert.match(data, /showInCode\(path, content, instructionFileMode\("checkout"\), null\)/);
});

it("the `On this Mac` section opens only read-only (GH #101, as GH #174 left it)", () => {
  // GH #101 kept a personal instruction file away from Code altogether, because
  // Code had no reading view. GH #142 gave it one, and GH #174 gives the row the
  // `›` a personal skill has: read-only, and nothing else.
  const instructions = read("../components/library/InstructionsPage.tsx");
  const data = read("../components/library/useInstructionsData.ts");
  const section = instructions.split("THIS_MAC_SECTION} count")[1] ?? "";
  assert.ok(section, "the section must remain discoverable");
  // One open in the section, and it is the read-only one, asked for `this-mac`,
  // with the path Rust listed — never the writable `openInCode`.
  assert.doesNotMatch(section, /openInCode/, "never a writable tab");
  const opens = [...section.matchAll(/open(ReadOnly|InCode)\(/g)];
  assert.equal(opens.length, 1, "one open in the section");
  assert.match(section, /onOpen=\{\(\) => void openReadOnly\(file\.path, "this-mac"\)\}/);
  assert.doesNotMatch(section, /file\.path\s*\+|`\$\{[^}]*file\.path/);
  // `openReadOnly` cannot be asked for the checkout: its copy type leaves it out.
  assert.match(data, /openReadOnly: \(path: string, copy: ReadOnlyInstructionCopy\) =>/);
  // And the bytes come through Rust's guard, not a general read of that path.
  assert.match(
    data,
    /copy === "this-mac"\s*\n?\s*\? await personalInstructionRead\(path\)/,
  );
});

// ── The store, run ───────────────────────────────────────────────────────

it("a read-only file cannot be made dirty, or marked saved", () => {
  const path = "/h/.claude/skills/captions/SKILL.md";
  const mine = { place: "this-mac" as const, line: readOnlyLine("this-mac", null) };
  useEditor.getState().open("w1", path, "body", mine);
  const file = () => useEditor.getState().byWorkspace.w1!.openFiles[0]!;
  assert.deepEqual(file().readOnly, mine);
  assert.equal(isFileDirty(file()), false);

  // Even handed a change directly — which the non-editable view cannot produce,
  // and this is the second lock the store keeps anyway.
  useEditor.getState().setContent("w1", path, "tampered");
  assert.equal(isFileDirty(file()), false, "a reading view is never dirty");
  useEditor.getState().markSaved("w1", path);
  assert.equal(
    file().initialContent,
    "body",
    "`markSaved` refuses it: nothing wrote, so nothing was saved",
  );
});

it("the same path reopened writable does not inherit the flag", () => {
  const path = "/h/.claude/skills/captions/SKILL.md";
  // Whichever way round, the tab is rebuilt from the bytes that open read — a
  // read-only baseline must not survive into a writable tab, and the flag must
  // not survive into one either.
  useEditor.getState().open("w1", path, "fresh");
  const file = () => useEditor.getState().byWorkspace.w1!.openFiles[0]!;
  assert.equal(file().readOnly, undefined, "writable again");
  assert.equal(file().content, "fresh");
  assert.equal(isFileDirty(file()), false);

  useEditor
    .getState()
    .open("w1", path, "fresh2", { place: "mirror", line: readOnlyLine("mirror", "staging") });
  assert.equal(file().readOnly?.place, "mirror");
  assert.equal(file().content, "fresh2");
  // One tab throughout: reopening a path has never opened a second one.
  assert.equal(useEditor.getState().byWorkspace.w1!.openFiles.length, 1);
  useEditor.getState().reset("w1");
});

it("the view is told about a reopen under the same path", () => {
  // Review 2 (MINOR): the store rebuilt the open file and the `EditorView` did
  // not, because the swap effect watched the active **path** and a rebuild keeps
  // it — so the screen showed the first press's bytes while the Markdown preview,
  // which renders from the store, showed the new ones.
  assert.match(store, /loadId\?: number;/);
  assert.match(store, /loadId: \(f\.loadId \?\? 0\) \+ 1,/);
  assert.equal(
    (store.match(/loadId: \(f\.loadId \?\? 0\) \+ 1,/g) ?? []).length,
    2,
    "a rebuild in `open` and a `replaceFromDisk` are the two loads",
  );
  // The effect watches it, beside the path.
  assert.match(panel, /\}, \[wsState\?\.activePath, activeFile\?\.loadId\]\);/);
  // …and keeps the file's state — history, selection, scroll — when it already
  // holds these bytes, so a load that changes nothing (and a reload the panel
  // already put into the state) costs the member nothing (GH #170).
  assert.match(panel, /state\.sliceDoc\(\) !== file\.content\s*\n\s*\) \{\s*\n\s*state = createFileState\(file\);/);
  assert.match(panel, /if \(state !== view\.state\) \{\s*\n\s*view\.setState\(state\);/);
  // A keystroke is not a load: `setContent` and `markSaved` leave `loadId` alone,
  // or the effect would fight the member for the cursor on every character.
  const setContent = store.slice(store.indexOf("setContent: (wsId"), store.indexOf("markSaved: (wsId"));
  assert.doesNotMatch(setContent, /loadId/);
  const markSaved = store.slice(store.indexOf("markSaved: (wsId"), store.indexOf("replaceFromDisk: (wsId"));
  assert.doesNotMatch(markSaved, /loadId/);
});

it("a read-only reopen always shows the bytes it just read", () => {
  // Review 1 (MINOR): nothing refreshes a reading view once it is open — no
  // watcher covers Application Support or `~/.claude`, and there is no ⌘S to pull
  // one — so the "bring the tab forward" shortcut showed the **first** press's
  // bytes under a banner claiming to be reading the file on disk.
  const path = "/h/.claude/skills/captions/SKILL.md";
  const mine = { place: "this-mac" as const, line: readOnlyLine("this-mac", null) };
  useEditor.getState().open("w3", path, "before", mine);
  useEditor.getState().open("w3", path, "after the member edited it in Zed", mine);
  const file = useEditor.getState().byWorkspace.w3!.openFiles[0]!;
  assert.equal(file.content, "after the member edited it in Zed");
  assert.equal(file.initialContent, file.content, "and no dirty baseline behind it");
  assert.equal(file.readOnly?.place, "this-mac");
  assert.equal(useEditor.getState().byWorkspace.w3!.openFiles.length, 1);
  // …and the view is told, which watching the path alone could not do (review 2).
  assert.equal(file.loadId, 1, "the rebuild bumped the load");
  useEditor.getState().open("w3", path, "later still", mine);
  assert.equal(useEditor.getState().byWorkspace.w3!.openFiles[0]!.loadId, 2);
  // A replacement from disk is a load too.
  useEditor.getState().replaceFromDisk("w3", path, "from disk");
  assert.equal(useEditor.getState().byWorkspace.w3!.openFiles[0]!.loadId, 3);
  useEditor.getState().reset("w3");
});

it("an open reading view keeps its unsaved-free tab across a reopen of the same kind", () => {
  // The other half of the rule: same context, so the tab is brought forward and
  // nothing is rebuilt. For a writable file that is what protects unsaved edits.
  const path = "/repo/.claude/skills/deploy/SKILL.md";
  useEditor.getState().open("w2", path, "one");
  useEditor.getState().setContent("w2", path, "one edited");
  useEditor.getState().open("w2", path, "one");
  const file = useEditor.getState().byWorkspace.w2!.openFiles[0]!;
  assert.equal(file.content, "one edited", "reopening never discards an edit");
  assert.equal(isFileDirty(file), true);
  assert.equal(file.loadId, undefined, "nothing was loaded, so nothing is bumped");
  useEditor.getState().reset("w2");
});

it("a dirty writable tab is never rebuilt into a reading view (GH #174 review 1)", () => {
  // Reachable: a workspace rooted at `~/.claude` has `CLAUDE.md` as a checkout
  // file **and** as `On this Mac`'s personal file — the same absolute path.
  const path = "/h/.claude/CLAUDE.md";
  const mine = { place: "this-mac" as const, line: readOnlyLine("this-mac", null, "instructions") };
  const ws = () => useEditor.getState().byWorkspace.w4!;
  assert.deepEqual(useEditor.getState().open("w4", path, "on disk"), { opened: true });
  useEditor.getState().setContent("w4", path, "on disk, edited");
  useEditor.getState().open("w4", "/repo/other.md", "other");
  assert.equal(ws().activePath, "/repo/other.md");

  const answer = useEditor.getState().open("w4", path, "on disk", mine);
  assert.deepEqual(answer, { opened: false, reason: DIRTY_WRITABLE_REFUSAL });
  const file = ws().openFiles.find((f) => f.path === path)!;
  assert.equal(file.content, "on disk, edited", "the unsaved edit is kept");
  assert.equal(file.readOnly, undefined, "and the tab stays writable");
  assert.equal(isFileDirty(file), true);
  assert.equal(ws().activePath, path, "the writable tab is brought forward");

  // Clean, the same open does rebuild it as a reading view.
  useEditor.getState().markSaved("w4", path);
  assert.deepEqual(useEditor.getState().open("w4", path, "on disk, edited", mine), {
    opened: true,
  });
  assert.equal(ws().openFiles.find((f) => f.path === path)!.readOnly?.place, "this-mac");
  useEditor.getState().reset("w4");
});

console.log(`readOnlyFile.test.ts: ${passed} groups passed`);
