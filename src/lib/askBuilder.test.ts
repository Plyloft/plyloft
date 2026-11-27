// QoL 13.2: the words Ask the Builder sends and the rows say. Run by node
// (--experimental-strip-types) and by vitest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASK_BUILDER, bringBranchPrompt, folderBehindLine } from "./askBuilder.ts";

test("the row says the folder is behind, naming the branch", () => {
  assert.equal(folderBehindLine("staging"), "Your project folder is behind staging.");
  assert.equal(folderBehindLine(null), "Your project folder is behind the integration branch.");
});

test("the request asks for a fast-forward only and never touches the member's changes", () => {
  const prompt = bringBranchPrompt("staging", "review-rules");
  assert.match(prompt, /^My project folder is behind staging\. I need it for review-rules\./);
  assert.match(prompt, /only if that needs no merge \(git merge --ff-only\)/);
  assert.doesNotMatch(prompt, /fast-forward/);
  assert.match(prompt, /wait for my answer/);
  assert.match(prompt, /Don't discard, stash, reset or commit any of my changes/);
  // A positional argument: never read as a flag by the CLI.
  assert.ok(!prompt.startsWith("-"));
  assert.equal(ASK_BUILDER, "Ask the Builder");
});
