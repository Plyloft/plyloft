// 1.171.0 D3 (FR-5): the card says its copy started without the folder's
// unsaved changes. Run: node --experimental-strip-types src/lib/unsavedWork.test.ts
import assert from "node:assert/strict";
import { asksAboutUnsavedWork, startedWithoutLine } from "./unsavedWork.ts";

const on = (files: number, branch: string | null = "main") => ({ files, branch });
assert.equal(startedWithoutLine(on(0), "main"), null);
assert.equal(startedWithoutLine(on(Number.NaN), "main"), null);
assert.equal(
  startedWithoutLine(on(12), "origin/main"),
  "Started from the last saved version of your project. Your project folder, on main, has changes in 12 files or folders that aren't saved in Git, so this card doesn't have them.",
);
assert.match(startedWithoutLine(on(1), null) ?? "", /changes in 1 file or folder that/);
// Another branch, or detached: those changes were never the card's.
assert.equal(startedWithoutLine(on(12, "my-work"), "origin/main"), null);
assert.equal(startedWithoutLine(on(12, null), "main"), null);

const card = { worktreePath: "/p/.plyloft-worktrees/card-1", archived: false, prReview: null, landed: false };
assert.equal(asksAboutUnsavedWork(card), true);
assert.equal(asksAboutUnsavedWork({ ...card, worktreePath: null }), false, "not started");
assert.equal(asksAboutUnsavedWork({ ...card, landed: true }), false, "shipped");
assert.equal(asksAboutUnsavedWork({ ...card, archived: true }), false, "archived");
assert.equal(asksAboutUnsavedWork({ ...card, prReview: {} }), false, "a pull request review");

console.log("unsavedWork: ok");
