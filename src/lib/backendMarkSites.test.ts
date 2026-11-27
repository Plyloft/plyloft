// 1.176.0 seams: no backend mark (`backendMarks.ts`) is ever shown. The
// fields that can carry one — a run's error, a lane's failure, a review's
// error, a plan's pause, a Verify step's reason, a chat's reason, a swarm's
// end, a discussion leg — are found wherever the window reads them, and
// every place that draws or sends one (a JSX child, a prop, a template, a
// list of texts, an object's words, a PTY inject) must pass it through a
// stripping helper on that line. A new unstripped site fails here; one that
// reads the field for a condition only is not a render. A use of a field of
// another struct with the same name is listed in ALLOWED, with why.
// Run: node --experimental-strip-types src/lib/backendMarkSites.test.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The reads of fields that can carry a mark (TS names, `ipc.ts`). */
const FIELDS: RegExp[] = [
  /\brun\.error\b/, // AgentRun.error (agent runs, swarm roles)
  /\blane\.failed\b/, // BuildLane.failed
  /\b(?:record|attempt)\.error\b/, // review records, discussion attempts
  /\breview\.error\b/, // BuilderReview.error ("No eligible reviewer: …")
  /\bc\.error\b/, // BuildCompare.error
  /\bpause\??\.reason\b/, // plan pauses
  /\b(?:s|step)\.reason\b/, // VerifyStepResult.reason
  /\bverify\??\.state\.reason\b/, // a Verify run's own reason
  /\.unavailable\.reason\b/, // a discussion leg
  /\bendReason\b/, // Swarm.endReason
  /\(e\.body as \{ reason: unknown \}\)\.reason/, // a swarm mailbox's terminate body
];

/** What strips (or reads for Repair) on the same line. */
const HELPERS = /showBackendText\(|stripCliMarks\(|reviewerWords\(|RepairFor\b|backendMarkTool\(|stepOutputMarked\(|isFolderTrustRefusal\(/;

/** Shapes that draw or send the value (the field written as `F`). */
const renders = (line: string, field: RegExp): boolean => {
  const f = field.source;
  return [
    new RegExp(`\\$\\{[^}]*${f}`), // a template
    new RegExp(`\\{\\s*${f}\\s*\\}`), // a JSX child
    new RegExp(`=\\{\\s*${f}`), // a prop
    new RegExp(`\\[\\s*${f}`), // a list of texts
    new RegExp(`:\\s*${f}\\s*(?:[,}]|\\?\\.|\\?\\?|\\|\\||$)`), // an object's words
    new RegExp(`\\?\\s*${f}\\s*:`), // a ternary's value
    new RegExp(`(?:inject|write|push)\\([^)]*${f}`), // sent on
    new RegExp(`String\\(${f}`), // made the words
  ].some((r) => r.test(line));
};

/** Other structs with fields of the same name (no mark can reach them). */
const ALLOWED: Array<[string, RegExp, string]> = [
  ["src/components/library/SkillsPage.tsx", /done\.skipped\.map/, "a skipped skill's reason"],
  ["src/lib/worktreeSetup.ts", /record\.skipped/, "a setup step's skipped path"],
  ["src/lib/vendorReadiness.ts", /\bs\.reason\b/, "a VendorState's own words"],
  ["src/lib/needsYou.ts", /intakeStoppedWords/, "an intake's own words (never a mark)"],
  ["src/lib/tryPanel.ts", /run\.error/, "a Try run's error (its own words)"],
  ["src/components/TryItPanel.tsx", /run\.error/, "a Try run's error, a condition"],
  ["src/components/errors/VerifyStepLogs.tsx", /const parts = failed/, "the marked join: `stepOutput` strips it, `ErrorBlock` reads it for Repair"],
];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "test" || name === "testBridge") continue;
      out.push(...files(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const leaks: string[] = [];
for (const path of files(join(ROOT, "src"))) {
  const rel = relative(ROOT, path);
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const field of FIELDS) {
      if (!field.test(line) || !renders(line, field) || HELPERS.test(line)) continue;
      if (ALLOWED.some(([file, pattern]) => file === rel && pattern.test(line))) continue;
      leaks.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  });
}
assert.deepEqual(leaks, [], "a backend text drawn without `showBackendText` (or add it to ALLOWED with why)");

// The shared primitives strip on their own; the sites below rely on that.
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
assert.match(read("src/components/ux/Page.tsx"), /showBackendText\(text\)/, "forMachine (Callout, StatusLine, rows) strips");
assert.match(read("src/store/toastStore.ts"), /showBackendText\(t\.title\)/, "every toast strips");
assert.match(read("src/components/ux/ErrorBlock.tsx"), /withCliRepair\(given\)/, "ErrorBlock strips and offers Repair");
assert.match(read("src/components/ux/FailureText.tsx"), /showBackendText\(failure\.sentence\)/, "FailureText strips");
assert.match(read("src/components/ChatPanel.tsx"), /<RepairFor texts=\{\[reason\]\}/, "a chat that stopped offers Repair");

// The detector itself: a raw site is caught, a stripped or conditional one isn't.
const caught = (line: string) => FIELDS.some((f) => f.test(line) && renders(line, f) && !HELPERS.test(line));
assert.equal(caught("<p>{lane.failed}</p>"), true);
assert.equal(caught("inject(id, `failed — ${verify.state.reason}`)"), true);
assert.equal(caught("details: review.error?.trim() || null,"), true);
assert.equal(caught("<Callout text={run.error} />"), true);
assert.equal(caught("? String((e.body as { reason: unknown }).reason)"), true);
assert.equal(caught("<p>{showBackendText(lane.failed)}</p>"), false);
assert.equal(caught("{lane.failed && ("), false);
assert.equal(caught("if (review.error) return;"), false);

console.log("backendMarkSites: ok");
