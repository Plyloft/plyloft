// UX language card 8 (GH #103): the Diagnostics row model, one case per state
// the Dependency Doctor can be in. Run with:
//
//     node --experimental-strip-types src/lib/diagnostics.test.ts

import assert from "node:assert/strict";
import {
  ZSH,
  preferredTileShell,
  allDetails,
  microphoneRow,
  needsRows,
  readyLine,
  rowDetails,
  probeFailedError,
  hasPathOverride,
  lookAgainHint,
  checkingHint,
  tileShellRow,
  toolRow,
  identityRow,
  aiReadyOf,
  noAiSentence,
  missingRequiredTools,
  welcomeWarning,
  watchDelayMs,
  WATCH_LIMIT_MS,
  doctorReadArgs,
  diagnosticsHint,
  shortModelHint,
  diagnosticsTitle,
  reviewerRow,
  reviewerSummary,
} from "./diagnostics.ts";
import type {
  DictationShellStatus,
  DoctorReport,
  MicrophoneStatus,
  ToolStatus,
  WhisperModelStatus,
} from "../ipc.ts";
import { setPlatformForTests } from "./platform.ts";

function tool(over: Partial<ToolStatus> = {}): ToolStatus {
  return {
    id: "gh",
    name: "GitHub command",
    required: false,
    found: true,
    path: "/opt/homebrew/bin/gh",
    version: "2.60.0",
    versionOk: true,
    detail: "Found. Diagnostics can check whether it is signed in.",
    installCmd: "brew install gh",
    docsUrl: "https://cli.github.com",
    reviewer: null,
    ...over,
  };
}

// ── A tool: found · too old · signed out · missing ────────────────────────

{
  const row = toolRow(tool());
  assert.equal(row.signal, "ok");
  assert.deepEqual(row.fix, { kind: "ready" });
  assert.equal(row.label, "gh");
  assert.equal(row.mono, true, "a command reads in mono");
}
{
  // Required and missing is an error; optional and missing is a warning —
  // and either way the step is an install the person runs.
  const missing = toolRow(tool({ id: "git", required: true, found: false, path: null }));
  assert.equal(missing.signal, "error");
  assert.deepEqual(missing.fix, {
    kind: "person",
    action: "Install",
    command: "brew install gh",
  });
  assert.equal(toolRow(tool({ found: false, path: null })).signal, "warn");
}
{
  const old = toolRow(
    tool({
      id: "claude",
      required: true,
      versionOk: false,
      installCmd: "claude update",
      detail: "Installed but too old — update it for token tracking and stream output.",
    }),
  );
  assert.equal(old.signal, "warn", "found but too old is not a block");
  assert.deepEqual(old.fix, { kind: "person", action: "Update", command: "claude update" });
  assert.match(old.hint, /too old/);
}
{
  // BOARDS.md §5: `gh` — `Found, but not signed in — pull requests can't be
  // opened from here.` — `Sign in`.
  const out = toolRow(
    tool({
      auth: {
        signedIn: false,
        detail: "Found, but not signed in — pull requests can't be opened from here.",
        command: "gh auth login",
        action: "Sign in",
      },
    }),
  );
  assert.equal(out.signal, "warn");
  assert.equal(out.hint, "Found, but not signed in — pull requests can't be opened from here.");
  assert.deepEqual(out.fix, { kind: "person", action: "Sign in", command: "gh auth login" });
}
{
  const inn = toolRow(
    tool({
      auth: {
        signedIn: true,
        detail: "Found and signed in — pull requests can be opened from here.",
        command: "gh auth status",
        action: "Check",
      },
    }),
  );
  assert.equal(inn.signal, "ok");
  assert.deepEqual(inn.fix, { kind: "ready" });
  assert.match(inn.hint, /signed in/);
}
{
  const unknown = toolRow(
    tool({
      auth: {
        signedIn: null,
        detail: "Found. Plyloft asked whether you are signed in and could not read the answer.",
        command: "gh auth status",
        action: "Check",
      },
    }),
  );
  assert.equal(unknown.signal, "warn");
  assert.deepEqual(unknown.fix, {
    kind: "person",
    action: "Check",
    command: "gh auth status",
  });
}
// ── GH #169: claude — signed in · Ply could not tell · not found ─────────

function claude(over: Partial<ToolStatus> = {}): ToolStatus {
  return tool({
    id: "claude",
    name: "Claude Code",
    required: true,
    path: "/Users/me/.local/bin/claude",
    version: "2.1.0",
    detail: "Runs your Claude agents and swarms.",
    installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
    docsUrl: "https://docs.claude.com/en/docs/claude-code",
    ...over,
  });
}
{
  // BOARDS.md §5: `claude` — `Found and signed in. Nothing to do.` — `Ready`.
  const row = toolRow(
    claude({
      auth: {
        signedIn: true,
        detail: "Found and signed in. Nothing to do.",
        command: "claude auth status",
        action: "Check",
      },
    }),
  );
  assert.equal(row.signal, "ok");
  assert.deepEqual(row.fix, { kind: "ready" });
  assert.equal(row.hint, "Found and signed in. Nothing to do.");
}
{
  // Review 1: no credential seen is NEUTRAL — it counts toward `N of M
  // ready`, warns about nothing, says what Ply could not see (never "signed
  // out"), and offers the login only as a secondary step, never the row's.
  const UNSEEN =
    "Found. Plyloft could not see a Claude sign-in on this Mac; if your Claude tiles start, there is nothing to do.";
  const report = claude({
    auth: {
      signedIn: null,
      detail: UNSEEN,
      command: "claude auth login",
      action: "Sign in",
      optionalStep: true,
    },
  });
  const row = toolRow(report);
  assert.equal(row.signal, "ok", "neutral, not a warning");
  assert.deepEqual(row.fix, { kind: "ready" }, "the row's own step is none");
  assert.equal(row.hint, UNSEEN);
  assert.doesNotMatch(row.hint, /not signed in|signed out/);
  assert.deepEqual(row.secondary, {
    kind: "person",
    action: "Sign in",
    command: "claude auth login",
  });
  const doctor: DoctorReport = {
    tools: [report, tool()],
    teamSkills: null,
    projectSkills: null,
    microphone: null,
    whisperModel: null,
    dictationShell: null,
    sharedDefinition: null,
    probeError: null,
    allRequiredOk: true,
  } as DoctorReport;
  assert.equal(readyLine(needsRows(doctor)), "2 of 2 ready", "it counts as ready");
  assert.match(rowDetails(doctor, row) ?? "", /signed in: Plyloft could not tell/);
  // Without `optionalStep` (gh's "could not read the answer") it still warns.
  const ghUnknown = toolRow(
    tool({ auth: { signedIn: null, detail: "x", command: "gh auth status", action: "Check" } }),
  );
  assert.equal(ghUnknown.signal, "warn");
  assert.equal(ghUnknown.secondary, null);
  // A stale or missing claude still leads with its own step, no secondary.
  const stale = toolRow(
    claude({
      versionOk: false,
      installCmd: "claude update",
      auth: { signedIn: null, detail: UNSEEN, command: "claude auth login", action: "Sign in", optionalStep: true },
    }),
  );
  assert.deepEqual(stale.fix, { kind: "person", action: "Update", command: "claude update" });
  assert.equal(stale.secondary, null);
}
{
  // 1.176.0 R3: a Claude (or Codex) that doesn't answer `--version` is
  // reinstalled with the official installer, never updated with itself.
  const install = "curl -fsSL https://claude.ai/install.sh | bash";
  const dead = toolRow(
    claude({ versionOk: false, version: null, installCmd: install, detail: "Installed but not starting — Repair puts it right, so Claude tiles start again." }),
  );
  assert.equal(dead.signal, "warn");
  assert.deepEqual(dead.fix, { kind: "person", action: "Reinstall", command: install });
  assert.match(dead.hint, /not starting/);
  const deadCodex = toolRow(
    tool({ id: "codex", versionOk: false, version: null, installCmd: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" }),
  );
  assert.deepEqual(deadCodex.fix, { kind: "person", action: "Reinstall", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" });
  // Another tool keeps its word.
  const ghFix = toolRow(tool({ id: "gh", versionOk: false, version: null })).fix;
  assert.equal(ghFix.kind === "person" ? ghFix.action : null, "Update");
}
{
  // Not asked (every read but Diagnostics'): the found/not-found row as before.
  const row = toolRow(claude());
  assert.equal(row.signal, "ok");
  assert.equal(row.hint, "Runs your Claude agents and swarms.");
  // Not found: the install, whatever a stale answer said.
  const missing = toolRow(
    claude({
      found: false,
      path: null,
      auth: { signedIn: true, detail: "Found and signed in. Nothing to do.", command: "claude auth status", action: "Check" },
    }),
  );
  assert.equal(missing.signal, "error");
  assert.equal(missing.fix.kind === "person" && missing.fix.action, "Install");
}

// ── GH #189: gh signed in · keychain locked (cannot tell) · not signed in ──

{
  const LOCKED = "Found. The keychain is locked, so Plyloft can't check whether it is signed in.";
  const signedIn = toolRow(
    tool({
      auth: {
        signedIn: true,
        detail: "Found and signed in — pull requests can be opened from here.",
        command: "gh auth status",
        action: "Check",
        optionalStep: false,
      },
    }),
  );
  const lockedTool = tool({
    auth: { signedIn: null, detail: LOCKED, command: "gh auth login", action: "Sign in", optionalStep: true },
  });
  const locked = toolRow(lockedTool);
  const signedOutTool = tool({
    auth: {
      signedIn: false,
      detail: "Found, but not signed in — pull requests can't be opened from here.",
      command: "gh auth login",
      action: "Sign in",
      optionalStep: false,
    },
  });
  const signedOut = toolRow(signedOutTool);
  assert.equal(signedIn.signal, "ok");
  assert.deepEqual(signedIn.fix, { kind: "ready" });
  assert.equal(signedIn.secondary, null);
  // Locked: neutral. Ready, the keychain's sentence, `Sign in` only offered.
  assert.equal(locked.signal, "ok", "a locked keychain is not a warning");
  assert.deepEqual(locked.fix, { kind: "ready" }, "no primary Sign in");
  assert.equal(locked.hint, LOCKED);
  assert.doesNotMatch(locked.hint, /not signed in|signed out/);
  assert.deepEqual(locked.secondary, { kind: "person", action: "Sign in", command: "gh auth login" });
  // Not signed in at all: today's warning, `Sign in` the row's own step.
  assert.equal(signedOut.signal, "warn");
  assert.deepEqual(signedOut.fix, { kind: "person", action: "Sign in", command: "gh auth login" });
  assert.equal(signedOut.secondary, null);
  const report = (gh: ToolStatus): DoctorReport =>
    ({
      tools: [claude(), gh],
      teamSkills: null,
      projectSkills: null,
      microphone: null,
      whisperModel: null,
      dictationShell: null,
      sharedDefinition: null,
      probeError: null,
      allRequiredOk: true,
    }) as DoctorReport;
  assert.equal(readyLine(needsRows(report(lockedTool))), "2 of 2 ready", "locked counts as ready");
  assert.match(rowDetails(report(lockedTool), locked) ?? "", /signed in: Plyloft could not tell/);
  assert.equal(readyLine(needsRows(report(signedOutTool))), "1 of 2 ready", "signed out does not");
}

// ── GH #173: a read that does not ask cannot force an ask ─────────────────

assert.deepEqual(doctorReadArgs(false, false), [false, false], "launch, a switch, the welcome screen");
assert.deepEqual(doctorReadArgs(false, true), [false, false], "a re-probe off Diagnostics");
assert.deepEqual(doctorReadArgs(true, false), [true, false], "Diagnostics and its watch");
assert.deepEqual(doctorReadArgs(true, true), [true, true], "Look again, from scratch");

{
  // A missing tool never says "sign in": both cannot be true, and installing
  // comes first.
  const both = toolRow(
    tool({
      found: false,
      path: null,
      auth: { signedIn: false, detail: "signed out", command: "gh auth login", action: "Sign in" },
    }),
  );
  assert.equal(both.fix.kind, "person");
  assert.equal((both.fix as { command: string }).command, "brew install gh");
  assert.equal(both.hint, tool().detail, "the tool's own sentence, not the sign-in one");
}

// ── The tile shell: the row Ply puts right itself ─────────────────────────

function shell(over: Partial<DictationShellStatus> = {}): DictationShellStatus {
  return {
    shell: "/bin/bash",
    label: "bash 3.2.57",
    found: true,
    ok: false,
    detail: "/bin/bash has no paste mode, so pasting into a tile can garble long text.",
    ...over,
  };
}
{
  // BOARDS.md §5: `Tile shell` — … — `Choose zsh`. A step Ply can take
  // itself, it takes.
  const row = tileShellRow(shell());
  assert.equal(row.signal, "warn");
  assert.deepEqual(row.fix, { kind: "ply", action: "Choose zsh", what: "tile-shell-zsh" });
  assert.equal(row.mono, false);
  assert.equal(row.where, "/bin/bash");
}
{
  const ok = tileShellRow(shell({ shell: ZSH, label: "zsh", ok: true, detail: "zsh reads pasted text." }));
  assert.equal(ok.signal, "ok");
  assert.deepEqual(ok.fix, { kind: "ready" });
}
{
  // zsh itself failing cannot be fixed by choosing zsh — that would offer the
  // broken thing as its own cure.
  const broken = tileShellRow(shell({ shell: ZSH, label: "zsh", ok: false }));
  assert.equal(broken.fix.kind, "person");
  assert.equal((broken.fix as { command: string }).command, "brew install bash");
}
{
  const gone = tileShellRow(shell({ found: false, ok: false }));
  assert.equal(gone.signal, "error", "a tile cannot start at all");
  assert.deepEqual(gone.fix, { kind: "ply", action: "Choose zsh", what: "tile-shell-zsh" });
}
{
  // W5: on Windows the row offers PowerShell 7, and a failing pwsh is
  // installed with winget rather than chosen again.
  setPlatformForTests("windows");
  try {
    assert.equal(preferredTileShell(), "pwsh");
    const cmd = tileShellRow(shell({ shell: "cmd", label: "cmd", ok: false }));
    assert.deepEqual(cmd.fix, { kind: "ply", action: "Choose PowerShell 7", what: "tile-shell-zsh" });
    const broken = tileShellRow(shell({ shell: "pwsh", label: "pwsh", ok: false }));
    assert.equal((broken.fix as { command: string }).command, "winget install --id Microsoft.PowerShell");
  } finally {
    setPlatformForTests(null);
  }
  assert.equal(preferredTileShell(), ZSH);
}

// ── Microphone and the dictation model: steps inside Ply ──────────────────

const mic = (over: Partial<MicrophoneStatus> = {}): MicrophoneStatus => ({
  access: "not-asked",
  detail: "Plyloft has not asked for the microphone yet.",
  settingsUrl: null,
  ...over,
});
assert.deepEqual(microphoneRow(mic()).fix, {
  kind: "app",
  action: "Ask macOS",
  what: "microphone",
});
assert.equal(microphoneRow(mic()).signal, "warn");
assert.deepEqual(microphoneRow(mic({ access: "granted" })).fix, { kind: "ready" });
assert.equal(microphoneRow(mic({ access: "denied" })).signal, "error");
assert.deepEqual(microphoneRow(mic({ access: "denied", settingsUrl: "x-apple:" })).fix, {
  kind: "app",
  action: "Open System Settings",
  what: "privacy-pane",
});

// ── The whole section, and `N of M ready` ─────────────────────────────────

const model: WhisperModelStatus = {
  model: "small",
  present: false,
  path: "/models/small.bin",
  detail: "The small model is not on this Mac yet.",
};

const report: DoctorReport = {
  tools: [
    tool({
      id: "claude",
      name: "Claude Code",
      required: true,
      path: "/usr/local/bin/claude",
      version: "1.5.0",
      detail: "Runs your Claude agents and swarms.",
      installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
      docsUrl: "https://docs.claude.com/en/docs/claude-code/setup",
    }),
    tool({
      auth: {
        signedIn: false,
        detail: "Found, but not signed in — pull requests can't be opened from here.",
        command: "gh auth login",
        action: "Sign in",
      },
    }),
  ],
  teamSkills: null,
  projectSkills: null,
  microphone: null,
  whisperModel: model,
  dictationShell: shell(),
  sharedDefinition: null,
  probeError: null,
  allRequiredOk: true,
};

const rows = needsRows(report);
assert.deepEqual(
  rows.map((r) => r.id),
  ["tool:claude", "tool:gh", "tile-shell", "whisper-model"],
  "the tools, then the shell they run in, then dictation",
);
assert.equal(readyLine(rows), "1 of 4 ready");
assert.equal(
  readyLine(needsRows({ ...report, tools: [tool()], whisperModel: null, dictationShell: null })),
  "1 of 1 ready",
);
// BOARDS.md §5's own example: two of three.
assert.equal(
  readyLine([
    { ...rows[0], signal: "ok" },
    { ...rows[1], signal: "ok" },
    { ...rows[2], signal: "warn" },
  ]),
  "2 of 3 ready",
);
// Every row offers exactly one step, or says Ready.
for (const row of rows) {
  if (row.signal === "ok") assert.equal(row.fix.kind, "ready", `${row.id} is ready`);
  else assert.notEqual(row.fix.kind, "ready", `${row.id} offers a step`);
  assert.ok(row.hint.length > 0, `${row.id} says what is true now`);
}

// ── Details: the probe's own words, nothing invented ──────────────────────

const ghDetails = rowDetails(report, rows[1])!;
assert.match(ghDetails, /^gh: \/opt\/homebrew\/bin\/gh$/m);
assert.match(ghDetails, /^signed in: no$/m);
assert.match(ghDetails, /^install: brew install gh$/m);
assert.match(rowDetails(report, rows[2])!, /^reads pasted text: no$/m);
assert.equal(rowDetails(report, { ...rows[0], id: "nothing" }), null);

const all = allDetails({ ...report, probeError: "your login shell exited 127" });
assert.match(all, /^probe: your login shell exited 127$/m);
assert.match(all, /reads pasted text: no/);
assert.ok(!allDetails(report).startsWith("probe:"), "no probe error, no probe line");
// 1.173.0 (D1): the Railway row's words, only when there is one.
assert.ok(!allDetails(report).includes("railway"), "no Railway row, no Railway line");
assert.match(
  allDetails({
    ...report,
    railway: { workspace: "acme", state: "ok", summary: "signed in · project acme-project", detail: "" },
  }),
  /^railway \(acme\): ok — signed in · project acme-project$/m,
);
assert.match(
  allDetails({
    ...report,
    railway: { workspace: "acme", state: "unknown", summary: "couldn't be read", detail: "", technical: "GraphQL 500" },
  }),
  /^railway said: GraphQL 500$/m,
);


// ── OB-2 (§13.1): one AI is enough ───────────────────────────────────────

function aiReport(over: Partial<DoctorReport> = {}, tools: ToolStatus[] = []): DoctorReport {
  return {
    tools,
    teamSkills: null,
    projectSkills: null,
    microphone: null,
    whisperModel: null,
    dictationShell: null,
    sharedDefinition: null,
    probeError: null,
    allRequiredOk: true,
    aiReady: true,
    gitIdentity: null,
    ...over,
  };
}
const gitT = (found: boolean) =>
  tool({ id: "git", name: "Git", required: true, found, installCmd: "xcode-select --install" });
const claudeT = (found: boolean) =>
  tool({ id: "claude", name: "Claude Code", required: false, found, installCmd: "claude update" });
const codexT = (found: boolean) =>
  tool({ id: "codex", name: "Codex CLI", required: false, found, installCmd: "codex" });
{
  // Codex only: ready, nothing to say, and no row names Claude as missing.
  const codexOnly = aiReport({}, [gitT(true), claudeT(false), codexT(true)]);
  assert.equal(aiReadyOf(codexOnly), true);
  assert.equal(noAiSentence(codexOnly), null);
  assert.deepEqual(missingRequiredTools(codexOnly), []);
  assert.equal(welcomeWarning(codexOnly), null);
  // A missing AI is a warning, never an error: neither is required alone.
  assert.equal(toolRow(claudeT(false)).signal, "warn");
  assert.equal(toolRow(claudeT(false)).required, false);
}
{
  // Neither: the words name no AI in particular.
  const neither = aiReport({ allRequiredOk: false, aiReady: false }, [gitT(true), claudeT(false), codexT(false)]);
  assert.equal(noAiSentence(neither), "No AI tool is installed");
  assert.deepEqual(missingRequiredTools(neither), [], "an AI is never a required tool on its own");
  // Review P3-4: with no AI ready, the pair is drawn as what is missing.
  const pair = needsRows(neither).filter((r) => r.id === "tool:claude" || r.id === "tool:codex");
  assert.deepEqual(pair.map((r) => [r.signal, r.chip]), [["error", "One needed"], ["error", "One needed"]]);
  // With one ready, the other is a plain optional warning.
  const ok = needsRows(aiReport({}, [gitT(true), claudeT(false), codexT(true)]));
  assert.equal(ok.find((r) => r.id === "tool:claude")?.signal, "warn");
  assert.equal(ok.find((r) => r.id === "tool:claude")?.chip, undefined);
  assert.equal(
    welcomeWarning(neither),
    "No AI tool is installed yet. One is enough: Claude or Codex. You can still look around, but agents won't run until one is ready.",
  );
  // Found but not ready (a signed-out Codex).
  const signedOut = aiReport({ allRequiredOk: false, aiReady: false }, [gitT(true), claudeT(false), codexT(true)]);
  assert.equal(noAiSentence(signedOut), "No AI tool is ready");
  // Git missing as well.
  const both = aiReport({ allRequiredOk: false, aiReady: false }, [gitT(false), claudeT(false), codexT(false)]);
  assert.deepEqual(missingRequiredTools(both), [{ id: "git", name: "Git" }]);
  assert.equal(
    welcomeWarning(both),
    "Git and an AI tool (Claude or Codex) aren't ready yet — you can still look around, but agents won't run until the rows above are ready.",
  );
  const gitOnly = aiReport({ allRequiredOk: false }, [gitT(false), claudeT(true)]);
  assert.equal(
    welcomeWarning(gitOnly),
    "Git isn't installed yet — you can still look around, but cards can't start until it is.",
  );
  for (const r of [neither, signedOut, both, gitOnly]) {
    assert.ok(!(welcomeWarning(r) ?? "").includes("Claude Code isn't"), "never Claude alone");
  }
  // An older-shaped report (no aiReady) reads it from the rows.
  const legacy = { ...aiReport({}, [gitT(true), claudeT(false), codexT(true)]), aiReady: undefined };
  assert.equal(aiReadyOf(legacy), true);
}
{
  // Windows: Git Bash reads in words, not as a command.
  const bash = toolRow(
    tool({ id: "git-bash", name: "Git Bash", required: true, found: false, detail: "Git works, but Git Bash wasn't found. Plyloft needs it to run project checks." }),
  );
  assert.equal(bash.label, "Git Bash");
  assert.equal(bash.mono, false);
  assert.equal(bash.signal, "error");
  // Review P3-5: the step says what gets installed.
  assert.equal(bash.fix.kind === "person" && bash.fix.action, "Install Git for Windows");
  assert.equal(toolRow(tool({ id: "node", name: "Node.js" })).label, "node");
}
{
  // Codex sign-in, from its file: signed out offers `codex login`.
  const out = toolRow(
    tool({
      id: "codex",
      auth: { signedIn: false, detail: "Not signed in.", command: "codex login", action: "Sign in" },
    }),
  );
  assert.equal(out.signal, "warn");
  assert.equal(out.hint, "Not signed in.");
  assert.deepEqual(out.fix, { kind: "person", action: "Sign in", command: "codex login" });
}
{
  // D6: a newer release — the row stays ready, the step is a quiet Update.
  const newer = toolRow(
    tool({
      id: "claude",
      detail: "Runs your Claude agents and swarms.",
      update: { latest: "2.1.290", detail: "Version 2.1.290 is available.", command: "claude update" },
    }),
  );
  assert.equal(newer.signal, "ok", "an update never turns a row amber");
  assert.equal(newer.hint, "Runs your Claude agents and swarms. Version 2.1.290 is available.");
  assert.deepEqual(newer.fix, { kind: "person", action: "Update", command: "claude update", update: true });
  // G2 Windows walk: signed in with a newer release — no "Nothing to do."
  // beside Update.
  const signedNewer = toolRow(
    tool({
      id: "claude",
      auth: { signedIn: true, detail: "Found and signed in. Nothing to do.", command: "claude auth login", action: "Sign in" },
      update: { latest: "2.1.316", detail: "Version 2.1.316 is available.", command: "claude update" },
    }),
  );
  assert.equal(signedNewer.hint, "Found and signed in. Version 2.1.316 is available.");
  assert.equal(signedNewer.fix.kind === "person" && signedNewer.fix.action, "Update");
  assert.equal(
    toolRow(tool({ id: "claude", auth: { signedIn: true, detail: "Found and signed in. Nothing to do.", command: "x", action: "Sign in" }, update: null })).hint,
    "Found and signed in. Nothing to do.",
    "without a newer one, nothing to do",
  );
  // A sign-in comes first.
  const both = toolRow(
    tool({
      id: "codex",
      auth: { signedIn: false, detail: "Not signed in.", command: "codex login", action: "Sign in" },
      update: { latest: "0.157.1", detail: "Version 0.157.1 is available.", command: "codex update" },
    }),
  );
  assert.equal(both.fix.kind === "person" && both.fix.command, "codex login");
  // Offline: no update line at all.
  assert.deepEqual(toolRow(tool({ id: "claude", update: null })).fix, { kind: "ready" });
  // A missing tool is installed, not updated.
  const missing = toolRow(
    tool({ found: false, update: { latest: "9.9.9", detail: "Version 9.9.9 is available.", command: "x" } }),
  );
  assert.equal(missing.fix.kind === "person" && missing.fix.action, "Install");
  assert.ok(!missing.hint.includes("available"));
}
{
  // The git identity row.
  const unset = identityRow({ name: null, email: null, set: false, detail: "Git doesn't know your name yet." });
  assert.equal(unset.signal, "warn");
  assert.equal(unset.hint, "Git doesn't know your name yet.");
  assert.deepEqual(unset.fix, { kind: "app", action: "Set", what: "git-identity" });
  const set = identityRow({ name: "M", email: "m@x", set: true, detail: "Git knows you as M <m@x>." });
  assert.deepEqual(set.fix, { kind: "ready" });
  const r = aiReport({ gitIdentity: { name: "M", email: null, set: false, detail: "Git doesn't know your email yet." } }, [gitT(true)]);
  const rows = needsRows(r);
  assert.deepEqual(rows.map((x) => x.id), ["tool:git", "git-identity"]);
  assert.match(rowDetails(r, rows[1]) ?? "", /user.email: \(not set\)/);
}
{
  // D2/D4: no step Diagnostics offers runs `claude auth status` or `codex
  // login status` — they run only in Setup's AI step.
  const auths = [
    { signedIn: true, detail: "Found and signed in. Nothing to do.", command: "claude auth login", action: "Sign in" },
    { signedIn: null, detail: "Found. Ply could not see…", command: "claude auth login", action: "Sign in", optionalStep: true },
    { signedIn: false, detail: "Not signed in.", command: "codex login", action: "Sign in" },
    { signedIn: null, detail: "Found. Plyloft could not see a Codex sign-in…", command: "codex login", action: "Sign in", optionalStep: true },
  ];
  for (const id of ["claude", "codex"] as const) {
    for (const auth of auths) {
      const row = toolRow(tool({ id, auth }));
      for (const cmd of [row.fix.kind === "person" ? row.fix.command : "", row.secondary?.command ?? ""]) {
        assert.ok(!/auth status|login status/.test(cmd), `${id}: ${cmd}`);
      }
    }
  }
}

// ── A failed probe is an error about Ply, not about the Mac ──────────────
const probe = probeFailedError("your login shell exited 127", false, false);
assert.equal(probe.title, "Plyloft couldn't read this Mac's program folders.");
assert.match(probe.happened, /exited 127/);
assert.match(probe.untouched, /may only mean Plyloft looked in the wrong place/);
assert.deepEqual(
  probe.actions.map((a) => a.id),
  ["reprobe", "path"],
  "two ways out, one per way",
);
assert.equal(probe.details, "your login shell exited 127");

// ── With a PATH override the login shell was never asked ─────────────────
// 2026-10-16 walk: "It asked your login shell … No AI tool found in your PATH
// override" contradicted itself. With an override the probe looked only in
// that PATH, and the way out is that PATH.
const overrideError =
  "Neither claude nor codex is in your Program folders (Settings › Look and feel › Editor and terminals). Check them, or empty them so Plyloft asks your login shell again.";
const overridden = probeFailedError(overrideError, true, false);
assert.equal(overridden.title, "Plyloft found no AI tool in the program folders you set.");
assert.equal(
  overridden.happened,
  "Plyloft looked only in the program folders you set in Editor and terminals, and neither claude nor codex is there.",
);
assert.doesNotMatch(
  [overridden.title, overridden.happened, overridden.untouched].join(" "),
  /login shell/,
  "nothing says the login shell was asked",
);
assert.match(overridden.todo, /Check those folders, or empty them/);
assert.deepEqual(overridden.actions.map((a) => a.id), ["reprobe", "path"]);
assert.equal(overridden.details, overrideError);
assert.equal(probeFailedError("x", false).happened, probeFailedError("x").happened, "no override is the default");
// 1.176.1: the reason the setting can't work, and the button to its row.
const why = probeFailedError(overrideError, true, false, "it names a file, not a folder and it is written with ~");
assert.match(why.happened, /neither claude nor codex is there\. They can't work as written: it names a file, not a folder and it is written with ~\.$/);
assert.equal(why.actions[1].label, "Open Program folders");

// The two hints that say where Plyloft looks follow the override.
assert.equal(hasPathOverride(null), false);
assert.equal(hasPathOverride("   "), false, "blank counts as none, as in the backend");
assert.equal(hasPathOverride("/opt/homebrew/bin:/usr/bin"), true);
assert.equal(
  lookAgainHint(false, false),
  "Plyloft asks your login shell all over again, instead of reading what it noted at startup.",
);
assert.equal(
  lookAgainHint(true, false),
  "Plyloft looks again in the program folders you set in Editor and terminals, instead of reading what it noted at startup.",
);
assert.equal(
  lookAgainHint(false, true),
  "Plyloft looks again in the program folders Windows gave it and where these tools usually install, instead of reading what it noted at startup.",
);
assert.doesNotMatch(lookAgainHint(false, true), /login shell/);
assert.equal(lookAgainHint(true, true), lookAgainHint(true, false), "an override reads the same on both");
assert.equal(checkingHint(false, true), "Plyloft is looking in the program folders Windows gave it.");
assert.doesNotMatch(probeFailedError("x", false, true).happened, /login shell/);
assert.doesNotMatch(probeFailedError("x", true, true).todo ?? "", /login shell/);
assert.equal(checkingHint(false, false), "Plyloft is asking your login shell.");
assert.equal(checkingHint(true, false), "Plyloft is looking in the program folders you set in Editor and terminals.");

// ── The wait backs off ───────────────────────────────────────────────────
// Reading the report asks `gh auth status` over the network. A flat four-second
// poll for the whole wait would be a hundred and fifty requests to GitHub for
// one login, so the first half minute is quick and the rest is not.
assert.equal(watchDelayMs(0), 3_000);
assert.equal(watchDelayMs(29_999), 3_000);
assert.equal(watchDelayMs(30_000), 10_000);
assert.equal(watchDelayMs(119_999), 10_000);
assert.equal(watchDelayMs(120_000), 30_000);
assert.equal(watchDelayMs(WATCH_LIMIT_MS), 30_000);
// The whole wait costs well under fifty reads.
let reads = 0;
for (let t = 0; t < WATCH_LIMIT_MS; t += watchDelayMs(t)) reads++;
assert.ok(reads < 50, `${reads} reads over the whole wait`);
assert.ok(reads > 10, `${reads} reads — the first half minute is still quick`);

// 1.174.0 (DS7, scene 13): titled by what it is for, the program in the hint.
{
  const base = { id: "tool:git", label: "git", mono: true, signal: "ok" as const, hint: "Ready.", fix: { kind: "ready" as const }, required: true };
  assert.equal(diagnosticsTitle(base), "Gives each card its own copy of the project");
  assert.equal(diagnosticsHint({ ...base, version: "2.46.0" }), "git 2.46.0 · Ready.");
  assert.equal(diagnosticsHint({ ...base, version: "git version 2.46.0" }), "git version 2.46.0 · Ready.", "no name twice");
  assert.equal(diagnosticsHint({ ...base, version: null }), "git · Ready.");
  assert.equal(diagnosticsTitle({ ...base, id: "tool:gh", label: "gh" }), "Opens pull requests and reads GitHub's checks");
  assert.equal(diagnosticsTitle({ ...base, id: "git-identity", label: "Git identity" }), "Git identity", "words stay");
  assert.equal(diagnosticsHint({ ...base, id: "tile-shell", label: "Tile shell", version: "zsh 5.9", hint: "Fine." }), "zsh 5.9 · Fine.");
  const now = Date.UTC(2026, 9, 31, 12);
  const cap = {
    provider: "claude", installed: true, executablePath: "/x/claude", version: "2.1", level: "harness-enforced",
    outcome: "passed", eligible: true, stale: false, proof: "Claude dontAsk mode … sentinel absent.", probedAt: now - 2 * 86_400_000, probing: false,
  } as const;
  assert.equal(reviewerSummary(cap as never, now), "checked 2 days ago");
  assert.equal(reviewerSummary({ ...cap, stale: true, eligible: false } as never, now), "It has updated since, so the proof is out of date.");
  assert.equal(reviewerSummary({ ...cap, eligible: false, outcome: null, probedAt: null } as never, now), "Not proved yet.");
  assert.equal(reviewerSummary({ ...cap, eligible: false, outcome: "write-escaped" } as never, now), "A change got through in its last proof, so it doesn't review.");
  const row = reviewerRow({ id: "claude", name: "Claude Code", found: true, reviewer: cap } as never, now)!;
  assert.equal(row.label, "Claude as a reviewer");
  assert.equal(row.details, `Harness enforced: ${cap.proof}`, "the level and the proof are Copy details");
  // DS7 round 1: one line per outcome.
  const lines: Record<string, string> = {
    passed: "Its last proof couldn't show that it can't change files, so it doesn't review.",
    "write-escaped": "A change got through in its last proof, so it doesn't review.",
    inconclusive: "Its last proof showed nothing either way, so it doesn't review.",
    "quota-blocked": "Its last proof hit your plan's limit. Run it again later.",
    "auth-blocked": "Its last proof needed a sign-in. Sign in, then run it again.",
    "timed-out": "Its last proof took too long. Run it again.",
    failed: "Its last proof didn't show that it can't change files, so it doesn't review.",
  };
  for (const [outcome, line] of Object.entries(lines)) {
    assert.equal(reviewerSummary({ ...cap, eligible: false, outcome } as never, now), line, outcome);
  }
  assert.equal(diagnosticsTitle({ ...base, id: "tool:whisper-cli", label: "whisper-cli" }), "Dictation");
  assert.equal(diagnosticsHint(row), "checked 2 days ago", "no program or level in a reviewer's hint");
  assert.equal(reviewerRow({ id: "claude", name: "Claude Code", found: true, reviewer: { ...cap, eligible: false, outcome: "timed-out" } } as never, now)!.label, "Claude as a reviewer");
}

// 1.176.1 walk: Program folders set and a tool missing from the snapshot —
// "not in your Program folders", the fix opens that row, never Install.
{
  const out = toolRow(tool({ id: "git", required: true, found: false, path: null }), true);
  assert.equal(out.hint, "Not in your Program folders.");
  assert.deepEqual(out.fix, { kind: "app", action: "Open Program folders", what: "program-folders" });
  assert.equal(out.command, null);
  assert.equal(toolRow(tool({ id: "gh", found: false, path: null }), true).fix.kind, "app");
  assert.equal(toolRow(tool({ id: "gh", found: false, path: null }), false).fix.kind, "person", "without the setting, Install as before");
}

// F6 (1.176.2): the Dictation model row says what is missing, not the path to the button.
assert.equal(
  shortModelHint("Not downloaded — Settings › Look and feel › Dictation › The model file › Download (~466 MB)."),
  "Not downloaded (~466 MB).",
);
assert.equal(shortModelHint("Downloaded."), "Downloaded.");

console.log(`diagnostics: all assertions passed (${rows.length} rows)`);
