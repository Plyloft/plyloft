import assert from "node:assert/strict";
import { chosenNewTileKind, newTileKindFor, writeNewTileKind } from "./newTileKind.ts";

const both = { claude: true, codex: true };
// A 1.167 file (no newTileKind) keeps what it said.
assert.equal(chosenNewTileKind({ defaultNewPaneKind: "shell" }), "shell");
assert.equal(chosenNewTileKind({ defaultNewPaneKind: "claude" }), "claude");
assert.equal(chosenNewTileKind({ defaultNewPaneKind: "claude", newTileKind: null }), "claude");
// The new field wins.
assert.equal(chosenNewTileKind({ defaultNewPaneKind: "shell", newTileKind: "codex" }), "codex");
assert.equal(chosenNewTileKind({ defaultNewPaneKind: "claude", newTileKind: "shell" }), "shell");
// Not installed here: a shell.
assert.equal(newTileKindFor({ defaultNewPaneKind: "claude" }, { claude: false, codex: true }), "shell");
assert.equal(newTileKindFor({ defaultNewPaneKind: "shell", newTileKind: "codex" }, { claude: true, codex: false }), "shell");
assert.equal(newTileKindFor({ defaultNewPaneKind: "shell", newTileKind: "codex" }, both), "codex");
// An older Plyloft reads a value it knows.
assert.deepEqual(writeNewTileKind("codex"), { newTileKind: "codex", defaultNewPaneKind: "shell" });
assert.deepEqual(writeNewTileKind("claude"), { newTileKind: null, defaultNewPaneKind: "claude" });
assert.deepEqual(writeNewTileKind("shell"), { newTileKind: null, defaultNewPaneKind: "shell" });
console.log("newTileKind: all assertions passed");
