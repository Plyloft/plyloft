// QoL 1.168 S1-1 + E4: ⌘W never closes a hidden editor tab; ⌘S and ⌘⌥S
// save only in Code.
import assert from "node:assert/strict";
import { closeTabAction, saveKeyAction } from "./editorKeys.ts";

const place = { settingsOpen: false, modalOpen: false };
const w = (mode: string, extra: Partial<Parameters<typeof closeTabAction>[0]> = {}) =>
  closeTabAction({ ...place, mode, expandedTile: false, activeFile: true, ...extra });

assert.equal(w("code"), "closeFile");
assert.equal(w("code", { activeFile: false }), "nothing");
// From the Board, the Inbox or Terminals the hidden editor tab is left alone.
assert.equal(w("board"), "nothing");
assert.equal(w("inbox"), "nothing");
assert.equal(w("terminals"), "nothing");
assert.equal(w("terminals", { expandedTile: true }), "collapseTile");
// An expanded tile in the hidden Terminals doesn't win over the file in Code.
assert.equal(w("code", { expandedTile: true }), "closeFile");
// Settings or a sheet over Code: nothing.
assert.equal(w("code", { settingsOpen: true }), "nothing");
assert.equal(w("code", { modalOpen: true }), "nothing");
assert.equal(w("terminals", { expandedTile: true, modalOpen: true }), "nothing");

const s = (id: "save" | "saveAll", mode: string, inEditorText = false, extra = {}) =>
  saveKeyAction(id, { ...place, mode, inEditorText, ...extra });
assert.equal(s("save", "code", true), "editor", "the editor's own ⌘S");
assert.equal(s("save", "code"), "saveActive");
assert.equal(s("saveAll", "code"), "saveAll");
assert.equal(s("saveAll", "code", true), "saveAll");
assert.equal(s("save", "board"), "ignore");
assert.equal(s("saveAll", "terminals"), "ignore");
assert.equal(s("save", "code", false, { modalOpen: true }), "ignore");

console.log("editorKeys.test.ts: ok");
