// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/reviewerAutoProbe.test.ts
import assert from "node:assert/strict";
import type { ReviewerAutoProbeEvent } from "../ipc.ts";
import { reviewerAutoProbeToast } from "./reviewerAutoProbe.ts";
import { FOLDER_TRUST_REFUSAL } from "./claudeReviewTrust.ts";

function event(
  overrides: Partial<ReviewerAutoProbeEvent> = {},
): ReviewerAutoProbeEvent {
  return {
    provider: "claude",
    providerName: "Claude Code",
    version: "2.1.271",
    result: "reverified",
    level: "harness-enforced",
    detail: "proved",
    ...overrides,
  };
}

// A pass is quiet: the doctor row turns green, no toast.
assert.equal(reviewerAutoProbeToast(event()), null);

// A skip (offline, review in flight, already settled) is quiet too.
assert.equal(reviewerAutoProbeToast(event({ result: "skipped" })), null);

// A failure warns: what it means for the person, the version that updated,
// and the press in the toast (E3) — never a "Settings › Diagnostics ›" path.
{
  const toast = reviewerAutoProbeToast(
    event({
      result: "failed",
      level: null,
      detail: "Provider quota blocked the probe; retry after the quota resets.",
    }),
  );
  assert.ok(toast);
  assert.equal(toast.kind, "warn");
  assert.equal(toast.title, "Claude can't review your cards yet");
  assert.equal(
    toast.body,
    "Claude Code 2.1.271 didn't pass Plyloft's check that its reviews can't change your files.",
  );
  // The probe's own words wait behind Details.
  assert.match(toast.details ?? "", /quota blocked/);
  assert.doesNotMatch(toast.body, /quota|probe|Settings ›/);
  assert.deepEqual(toast.press, { kind: "prove-again", label: "Prove it again" });
}

// Codex is named Codex.
{
  const toast = reviewerAutoProbeToast(
    event({ provider: "codex", providerName: "Codex CLI", version: "0.50.0", result: "failed", detail: "x" }),
  );
  assert.equal(toast?.title, "Codex can't review your cards yet");
}

// A probe that met Claude's folder-trust question offers the trust step's
// own press, not another probe run (which would meet the same question).
{
  const toast = reviewerAutoProbeToast(
    event({ result: "failed", level: null, version: "2.1.312", detail: `${FOLDER_TRUST_REFUSAL}` }),
  );
  assert.ok(toast);
  assert.equal(toast.title, "Claude can't review your cards yet");
  assert.equal(
    toast.body,
    "Claude Code 2.1.312 needs your OK on Plyloft's review folder before it can review again: open Claude there and answer Yes.",
  );
  assert.deepEqual(toast.press, { kind: "open-trust", label: "Open Claude there" });
  assert.doesNotMatch(toast.body, /Settings ›|Prove it again/);
}

console.log("reviewerAutoProbe tests passed");
