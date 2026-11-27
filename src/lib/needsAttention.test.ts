// 1.176.1: the sidebar's one "something needs you" indicator, per class.
// Run: node --experimental-strip-types src/lib/needsAttention.test.ts
import assert from "node:assert/strict";
import type { DoctorReport, ToolStatus } from "../ipc.ts";
import { andMoreWords, ghAnswerOf, ghSignedInNow, needsAttention, NO_AI_IN_FOLDERS, rememberGhSignIn, type AttentionInput } from "./needsAttention.ts";

function tool(id: string, patch: Partial<ToolStatus> = {}): ToolStatus {
  return {
    id,
    name: id === "git" ? "Git" : id,
    required: id === "git",
    found: true,
    path: `/bin/${id}`,
    version: "1.0.0",
    versionOk: true,
    detail: "",
    installCmd: "",
    docsUrl: "",
    reviewer: null,
    ...patch,
  } as ToolStatus;
}
const signedOut = { signedIn: false, detail: "", command: "x auth login", action: "Sign in" };

function report(over: { tools?: ToolStatus[]; probeError?: string | null } = {}): DoctorReport {
  const tools = over.tools ?? [tool("git"), tool("claude"), tool("codex"), tool("gh")];
  const aiReady = tools.some(
    (t) => (t.id === "claude" || t.id === "codex") && t.found && t.versionOk && t.auth?.signedIn !== false,
  );
  return {
    tools,
    probeError: over.probeError ?? null,
    aiReady,
    allRequiredOk: tools.every((t) => !t.required || t.found) && aiReady,
  } as unknown as DoctorReport;
}

function input(patch: Partial<AttentionInput> = {}): AttentionInput {
  return {
    report: report(),
    env: null,
    programFolders: false,
    chosen: "claude",
    tileKinds: [],
    gone: [],
    codexUpdating: false,
    usesGithub: false,
    ...patch,
  };
}
const kinds = (i: AttentionInput) => needsAttention(i).map((x) => x.kind);

// All well: nothing.
assert.deepEqual(needsAttention(input()), []);

// Never during launch: no report, no env answer.
assert.deepEqual(needsAttention(input({ report: null })), []);
// Before the report only the shell snapshot speaks, and only for "no AI at all".
assert.deepEqual(kinds(input({ report: null, env: { claudePath: null, codexPath: null } })), ["ai-missing"]);
assert.deepEqual(kinds(input({ report: null, env: { claudePath: null, codexPath: "/x/codex" } })), []);
assert.equal(
  needsAttention(input({ report: null, env: { claudePath: null, codexPath: null }, programFolders: true }))[0].words,
  NO_AI_IN_FOLDERS,
);

// 1. Program folders: set, and no AI tool in them.
const noAi = report({ tools: [tool("git"), tool("claude", { found: false, versionOk: false }), tool("codex", { found: false, versionOk: false })] });
const p1 = needsAttention(input({ report: noAi, programFolders: true }));
assert.deepEqual(p1.map((x) => x.kind), ["program-folders"]);
assert.equal(p1[0].words, "Program folders find no AI tool");
assert.deepEqual(p1[0].action.target, { to: "setting", section: "editor-terminals", row: "Program folders" });
// Without the setting it is the plain missing row.
const p2 = needsAttention(input({ report: noAi }));
assert.deepEqual(p2.map((x) => [x.kind, x.words]), [["ai-missing", "No AI tool is installed"]]);
// Set, but an AI was found (just signed out): not "no AI tool in your folders".
const foundOut = report({ tools: [tool("git"), tool("claude", { auth: signedOut }), tool("codex", { found: false, versionOk: false })] });
assert.deepEqual(kinds(input({ report: foundOut, programFolders: true })), ["ai-missing"]);
assert.equal(needsAttention(input({ report: foundOut }))[0].words, "No AI tool is ready");
// The probe's own error with the setting on is Program folders too.
assert.deepEqual(kinds(input({ programFolders: true, report: report({ probeError: "Neither claude nor codex is in the PATH you set in Settings › Look and feel › Editor and terminals. Check that PATH." }) })), ["program-folders"]);

// 2. A chosen AI doesn't start → Repair; unused tool → nothing.
const broken = report({ tools: [tool("git"), tool("claude", { version: null, versionOk: false }), tool("codex")] });
const p3 = needsAttention(input({ report: broken }));
assert.deepEqual(p3.map((x) => [x.kind, x.words, x.action.label]), [["ai-broken", "Claude Code doesn't start", "Repair"]]);
assert.deepEqual(p3[0].action.target, { to: "repair", tool: "claude" });
assert.deepEqual(kinds(input({ report: broken, chosen: "codex" })), [], "claude unused");
assert.deepEqual(kinds(input({ report: broken, chosen: "codex", tileKinds: ["claude"] })), ["ai-broken"]);
const slow = report({ tools: [tool("git"), tool("claude", { version: null, versionOk: true }), tool("codex")] });
assert.deepEqual(kinds(input({ report: slow })), [], "a slow answer is not a failure");
const codexBroken = report({ tools: [tool("git"), tool("claude"), tool("codex", { versionOk: false })] });
assert.deepEqual(kinds(input({ report: codexBroken, chosen: "codex", codexUpdating: true })), [], "while Codex updates");

// 3. git missing (a Mac without the Command Line Tools reads as git not found).
const noGit = report({ tools: [tool("git", { found: false, versionOk: false }), tool("claude"), tool("codex")] });
const p4 = needsAttention(input({ report: noGit }));
assert.deepEqual(p4.map((x) => [x.kind, x.words]), [["tool-missing", "Git isn't installed"]]);
const noGitBash = report({ tools: [tool("git", { found: false }), tool("git-bash", { required: true, found: false, name: "Git Bash" }), tool("claude")] });
assert.equal(needsAttention(input({ report: noGitBash }))[0].words, "Git and Git Bash aren't installed");

// 4. gh: only where the project uses GitHub; missing, or clearly signed out.
const noGh = report({ tools: [tool("git"), tool("claude"), tool("gh", { found: false })] });
assert.deepEqual(kinds(input({ report: noGh })), [], "a project that doesn't use GitHub");
assert.deepEqual(kinds(input({ report: noGh, usesGithub: true })), ["github-missing"]);
const ghOut = report({ tools: [tool("git"), tool("claude"), tool("gh", { auth: signedOut })] });
assert.deepEqual(kinds(input({ report: ghOut })), []);
const p5 = needsAttention(input({ report: ghOut, usesGithub: true }));
assert.deepEqual(p5.map((x) => [x.words, x.action.label]), [["GitHub isn't signed in", "Sign in"]]);
// Unknown / merely offered sign-in states say nothing.
const ghUnknown = report({ tools: [tool("git"), tool("claude"), tool("gh", { auth: { ...signedOut, signedIn: null } })] });
assert.deepEqual(kinds(input({ report: ghUnknown, usesGithub: true })), []);
const ghOffered = report({ tools: [tool("git"), tool("claude"), tool("gh", { auth: { ...signedOut, signedIn: false, optionalStep: true } })] });
assert.deepEqual(kinds(input({ report: ghOffered, usesGithub: true })), []);
const ghNoAuth = report({ tools: [tool("git"), tool("claude"), tool("gh")] });
assert.deepEqual(kinds(input({ report: ghNoAuth, usesGithub: true })), [], "no sign-in read yet");

// 5. An AI the person uses is signed out, while another is ready.
const claudeOut = report({ tools: [tool("git"), tool("claude", { auth: signedOut }), tool("codex")] });
const p6 = needsAttention(input({ report: claudeOut }));
assert.deepEqual(p6.map((x) => [x.kind, x.words, x.action.label]), [["ai-signed-out", "Claude Code is signed out", "Sign in"]]);
assert.deepEqual(kinds(input({ report: claudeOut, chosen: "codex" })), [], "claude unused");
const claudeUnknown = report({ tools: [tool("git"), tool("claude", { auth: { ...signedOut, signedIn: null } }), tool("codex")] });
assert.deepEqual(kinds(input({ report: claudeUnknown })), []);

// 6. The shell couldn't be read.
assert.deepEqual(kinds(input({ report: report({ probeError: "bad answer" }) })), ["shell-unread"]);

// Priority order, whatever the order they were found in; "and N more".
const everything = report({
  tools: [tool("git", { found: false }), tool("claude", { auth: signedOut }), tool("codex", { versionOk: false }), tool("gh", { auth: signedOut })],
  probeError: "bad answer",
});
const all = needsAttention(input({ report: { ...everything, aiReady: true } as DoctorReport, usesGithub: true, chosen: "claude", tileKinds: ["codex"] }));
assert.deepEqual(all.map((x) => x.kind), ["ai-broken", "tool-missing", "github-signed-out", "ai-signed-out", "shell-unread"]);
assert.equal(andMoreWords(all.length - 1), "and 4 more");
const folders = needsAttention(input({ report: { ...everything, tools: [tool("git", { found: false }), tool("claude", { found: false }), tool("codex", { found: false })], aiReady: false } as DoctorReport, programFolders: true }));
assert.deepEqual(folders.map((x) => x.kind), ["program-folders", "tool-missing"]);

// Clears by itself: the same input with a healthy report is empty.
assert.deepEqual(needsAttention(input({ report: report() })), []);

// The backend's own "no AI found" probe error is the missing-AI row's, never a
// shell that couldn't be read: no second item beside a no-AI item.
const NO_AI_ERR = "No AI tool found. Install Claude Code or Codex, or set a PATH override in Settings › Look and feel › Editor and terminals.";
const noAiWithError = report({ tools: [tool("git"), tool("claude", { found: false, versionOk: false }), tool("codex", { found: false, versionOk: false })], probeError: NO_AI_ERR });
assert.deepEqual(needsAttention(input({ report: noAiWithError })).map((x) => x.kind), ["ai-missing"]);
// ...and not even when an AI is found but the error is that message (stale).
assert.deepEqual(kinds(input({ report: report({ probeError: NO_AI_ERR }) })), []);
// A real shell failure next to a missing AI is still only said once (the AI row).
assert.deepEqual(kinds(input({ report: { ...noAiWithError, probeError: "login shell exited 127" } as DoctorReport })), ["ai-missing"]);

// gh's sign-in: the report's clear answer, else the last one seen for this account.
assert.equal(ghAnswerOf(ghOut), false);
assert.equal(ghAnswerOf(ghUnknown), null);
assert.equal(ghAnswerOf(ghOffered), null);
assert.equal(ghAnswerOf(ghNoAuth), null);
let mem = rememberGhSignIn({}, "me", ghOut);
assert.deepEqual(mem, { me: false });
// A later plain read carries no answer: the remembered one stands.
assert.equal(ghSignedInNow(mem, "me", ghNoAuth), false);
assert.deepEqual(kinds(input({ report: ghNoAuth, usesGithub: true, ghSignedIn: ghSignedInNow(mem, "me", ghNoAuth) })), ["github-signed-out"]);
assert.equal(rememberGhSignIn(mem, "me", ghNoAuth), mem, "an unknown answer clears nothing");
assert.equal(rememberGhSignIn(mem, "me", ghUnknown), mem);
// Another account has no answer; a fresh contradicting read replaces it.
assert.equal(ghSignedInNow(mem, "other", ghNoAuth), null);
const ghIn = report({ tools: [tool("git"), tool("claude"), tool("gh", { auth: { ...signedOut, signedIn: true } })] });
mem = rememberGhSignIn(mem, "me", ghIn);
assert.deepEqual(mem, { me: true });
assert.deepEqual(kinds(input({ report: ghNoAuth, usesGithub: true, ghSignedIn: ghSignedInNow(mem, "me", ghNoAuth) })), []);
// gh gone: forgotten, and no signed-out row.
assert.deepEqual(rememberGhSignIn({ me: false }, "me", noGh), {});
assert.equal(ghSignedInNow({ me: false }, "me", noGh), null);

// Other parts' setting problems: a typed slot, after a missing tool and before GitHub's.
const slot = [{ id: "tile-shell", words: "Your tile shell can't start", target: { to: "setting", section: "shell", row: "Tile shell" } }] as const;
const withSlot = needsAttention(input({ report: report({ tools: [tool("git", { found: false }), tool("claude"), tool("gh", { auth: signedOut })] }), usesGithub: true, settingProblems: slot }));
assert.deepEqual(withSlot.map((x) => x.kind), ["tool-missing", "setting-problem", "github-signed-out"]);
assert.deepEqual(withSlot[1].action, { label: "Open the setting", target: slot[0].target, title: "Open the setting" });
assert.deepEqual(kinds(input({ settingProblems: slot })), ["setting-problem"]);

// 1.176.1 walk: with Program folders set, git and gh missing from the
// snapshot are "not in your Program folders", and Fix opens that row.
{
  const out = needsAttention(input({ report: { ...everything, tools: [tool("git", { found: false }), tool("gh", { found: false }), tool("claude"), tool("codex")], aiReady: true } as DoctorReport, programFolders: true, usesGithub: true }));
  const git = out.find((x) => x.kind === "tool-missing")!;
  assert.equal(git.words, "Git isn't in your Program folders");
  assert.deepEqual(git.action.target, { to: "setting", section: "editor-terminals", row: "Program folders" });
  const gh = out.find((x) => x.kind === "github-missing")!;
  assert.equal(gh.words, "The gh command isn't in your Program folders");
  assert.doesNotMatch(out.map((x) => x.words).join(" "), /isn't installed/);
}

console.log("needsAttention: ok");
