// GH #308: Code's failures in the error shape — words first, the raw error
// only as Details. Run: node --experimental-strip-types src/lib/codeErrors.test.ts
import assert from "node:assert/strict";
import { revealFailedError, saveFailedError } from "./codeErrors.ts";

const save = saveFailedError("KanbanBoard.tsx", "EACCES: permission denied");
assert.equal(save.title, "KanbanBoard.tsx wasn't saved.");
assert.equal(save.untouched, "Your edits are still here, in this tab.");
assert.equal(save.details, "EACCES: permission denied");
for (const part of [save.title, save.happened, save.untouched, save.todo]) {
  assert.doesNotMatch(part, /EACCES/, "the raw error is Details only");
}
assert.deepEqual(save.actions, [{ id: "dismiss", label: "Dismiss" }]);

const reveal = revealFailedError(new Error("Finder is not running"));
assert.equal(reveal.title, "Finder couldn't show the file.");
assert.equal(reveal.details, "Finder is not running");
assert.equal(revealFailedError("").details, null);

console.log("codeErrors: all contracts passed");
