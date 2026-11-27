// Claude's review folder trust step: when it shows, what it matches, its words.
// Run with Node 22+: node --experimental-strip-types src/lib/claudeReviewTrust.test.ts
import assert from "node:assert/strict";
import type { DiscussionRecord } from "../ipc.ts";
import {
  FOLDER_TRUST_REFUSAL,
  discussionMetTrustQuestion,
  isFolderTrustRefusal,
  proposalMetTrustQuestion,
  reviewMetTrustQuestion,
  showsTrustStep,
  trustStepError,
} from "./claudeReviewTrust.ts";

// The refusal is matched inside a wrapped error, and nothing else is.
assert.ok(isFolderTrustRefusal(`${FOLDER_TRUST_REFUSAL}.`));
assert.ok(isFolderTrustRefusal(`pass 2: ${FOLDER_TRUST_REFUSAL}`));
assert.ok(!isFolderTrustRefusal("Provider quota blocked the review"));
assert.ok(!isFolderTrustRefusal(null));

// Untrusted shows; trusted never; unreadable only after a refusal.
assert.equal(showsTrustStep(false, false), true);
assert.equal(showsTrustStep(true, true), false);
assert.equal(showsTrustStep(null, false), false);
assert.equal(showsTrustStep(null, true), true);

// A Challenger review: Claude only, by its error or its reason.
assert.ok(reviewMetTrustQuestion({ provider: "claude", error: `${FOLDER_TRUST_REFUSAL}.` }));
assert.ok(reviewMetTrustQuestion({ provider: "claude", failureReason: FOLDER_TRUST_REFUSAL }));
assert.ok(!reviewMetTrustQuestion({ provider: "codex", error: FOLDER_TRUST_REFUSAL }));
assert.ok(!reviewMetTrustQuestion({ provider: "claude", error: "timed out" }));
assert.ok(!reviewMetTrustQuestion(null));

// A discussion: the last attempt of a Claude leg; a retry that went through settles it.
const leg = (provider: "claude" | "codex", ...errors: (string | null)[]) => ({
  provider,
  attemptHistory: errors.map((error, i) => ({ number: i + 1, error })),
});
const record = (legs: Record<string, unknown>) =>
  ({ legs }) as unknown as Pick<DiscussionRecord, "legs">;
assert.ok(discussionMetTrustQuestion(record({ a: leg("claude", FOLDER_TRUST_REFUSAL) })));
assert.ok(!discussionMetTrustQuestion(record({ a: leg("claude", FOLDER_TRUST_REFUSAL, null) })));
assert.ok(!discussionMetTrustQuestion(record({ a: leg("codex", FOLDER_TRUST_REFUSAL) })));
assert.ok(!discussionMetTrustQuestion(record({ a: leg("claude") })));

// The words: one primary way out, then Look again; the folder under Details.
const error = trustStepError("/cfg");
assert.equal(error.title, "Claude needs to trust Plyloft's review folder.");
assert.deepEqual(
  error.actions.map((a) => [a.label, a.primary === true]),
  [
    ["Open Claude there", true],
    ["Look again", false],
  ],
);
assert.match(error.todo, /Choose “Yes, I trust this folder”, then close the tile\./);
assert.doesNotMatch(error.todo, /yet/);
assert.match(trustStepError("/cfg", true).todo, /^Claude doesn't trust it yet\./);
assert.equal(error.details, "/cfg");

// No workspace: no tile to open, so the way without one, and Look again alone.
{
  const alone = trustStepError("/cfg", false, true);
  assert.deepEqual(alone.actions.map((a) => [a.label, a.primary === true]), [["Look again", true]]);
  assert.match(alone.todo, /Open a workspace/);
  assert.match(alone.todo, /run claude in the folder under Details from any terminal/);
  assert.match(alone.todo, /Yes, I trust this folder/);
}

// A card's improvement proposal stopped at the question: that card only, no
// proposal for it, and not a second copy beside its review's.
assert.ok(proposalMetTrustQuestion("c1", "c1", false, false));
assert.ok(!proposalMetTrustQuestion("c2", "c1", false, false), "another card's pass");
assert.ok(!proposalMetTrustQuestion("c1", null, false, false), "no pass stopped");
assert.ok(!proposalMetTrustQuestion("c1", undefined, false, false), "not read yet");
assert.ok(!proposalMetTrustQuestion("c1", "c1", true, false), "a proposal came after all");
assert.ok(!proposalMetTrustQuestion("c1", "c1", false, true), "the review shows it already");
{
  const proposal = trustStepError("/cfg", false, false, "proposal");
  assert.match(proposal.happened, /suggest a skill change for this card/);
  assert.equal(proposal.untouched, "No suggested skill change was written, and nothing in your projects changed.");
  assert.deepEqual(proposal.actions, error.actions);
  assert.equal(error.untouched, "No review ran, and nothing in your projects changed.");
}

console.log("claudeReviewTrust: all assertions passed");
