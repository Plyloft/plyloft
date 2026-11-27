// 1.176.1: Diagnostics' Copy report, as text.
// Run: node --experimental-strip-types src/lib/diagnosticsReport.test.ts
import assert from "node:assert/strict";
import type { DiagnosticRow } from "./diagnostics.ts";
import type { DoctorReport } from "../ipc.ts";
import { buildCacheLine, COULDNT_BE_READ, diagnosticsReport, otherLines, projectLabeller, rowLine, type ReportParts } from "./diagnosticsReport.ts";

const READY = { kind: "ready" } as const;
const row = (patch: Partial<DiagnosticRow>): DiagnosticRow => ({
  id: "tool:git", label: "git", mono: true, signal: "ok", hint: "Nothing to do.", fix: READY, required: true, version: "2.46", ...patch,
});

assert.equal(rowLine(row({})), "- Gives each card its own copy of the project: Ready. git 2.46 · Nothing to do.");
assert.equal(
  rowLine(row({ id: "tool:gh", label: "gh", signal: "warn", hint: "Not signed in.", fix: { kind: "person", action: "Sign in", command: "gh auth login" }, version: null })),
  "- Opens pull requests and reads GitHub's checks: Needs a look (Sign in). gh · Not signed in.",
);
assert.equal(rowLine(row({ id: "tool:claude", label: "claude", signal: "error", fix: { kind: "person", action: "Install", command: "x" }, version: null, hint: "Not installed." })), "- Claude: Not ready (Install). claude · Not installed.");
// 1.176.1 walk 2: a tool outside Program folders reads as its state, not as the page's button.
assert.match(
  rowLine(row({ id: "tool:claude", label: "claude", signal: "error", fix: { kind: "app", action: "Open Program folders", what: "program-folders" }, version: null, hint: "Not in your Program folders." })),
  /^- Claude: Not in your Program folders\./,
);
// Walk 3: said once; the program's name stays.
assert.equal(
  rowLine(row({ id: "tool:codex", label: "codex", signal: "error", fix: { kind: "app", action: "Open Program folders", what: "program-folders" }, version: null, hint: "Not in your Program folders." })).split("Not in your Program folders").length - 1,
  1,
);
// A row that isn't a tool states its state, not the button.
assert.doesNotMatch(
  rowLine(row({ id: "microphone", label: "Microphone", signal: "warn", fix: { kind: "app", action: "Ask macOS", what: "microphone" }, hint: "Not asked yet." })),
  /\(Ask macOS\)/,
);
// The Git identity's sentence names the person: a set one doesn't say it.
const who = rowLine({ ...row({}), id: "git-identity", label: "Git identity", mono: false, hint: "Git knows you as Ana <ana@x.com>." });
assert.equal(who, "- Git identity: Ready. Set.");

const parts = (patch: Partial<ReportParts> = {}): ReportParts => ({
  version: "1.176.1",
  platform: "Mac",
  needs: [row({})],
  probeError: null,
  other: ["- Responsiveness: No freezes since Plyloft started."],
  reviewers: [],
  buildCache: "- Build cache: Lyra, 1.2 GB at /Users/matteo/proj/.cargo-target.",
  folders: { setting: "", reading: null, source: "your login shell, plus where these tools usually install", dirs: ["/Users/matteo/.local/bin", "/usr/bin"] },
  tools: [{ name: "Claude Code", text: "Claude Code 2.1 at /Users/matteo/.local/bin/claude" }, { name: "Codex", text: "Codex 0.5" }],
  ...patch,
});

const text = diagnosticsReport(parts());
assert.ok(text.startsWith("Plyloft Diagnostics report\nPlyloft 1.176.1 on Mac\n"));
for (const heading of ["What Plyloft needs", "What else Plyloft read", "What Plyloft is keeping on this disk", "Program folders", "Claude Code", "Codex"]) {
  assert.ok(text.includes(`\n${heading}\n`), heading);
}
// Page order, scrubbed.
assert.ok(text.indexOf("What Plyloft needs") < text.indexOf("What else") && text.indexOf("What else") < text.indexOf("Program folders"));
assert.ok(!text.includes("matteo"), text);
assert.ok(text.includes("  ~/.local/bin\n  /usr/bin"));
assert.ok(text.includes("- Setting: not set"));

// A set value, its reading, and the folders it holds.
const set = diagnosticsReport(parts({ folders: { setting: "~/.local/bin/claude", reading: "Can't work as written: it names a file, not a folder.", source: "your Program folders setting", dirs: [] } }));
assert.ok(set.includes("- Setting: ~/.local/bin/claude\n- Reading: Can't work as written"));

// A part that couldn't be read is said, and the rest stays.
const part = diagnosticsReport(
  parts({ needs: null, other: null, buildCache: null, folders: { setting: "x", reading: null, source: "s", dirs: null }, tools: [{ name: "Codex", text: null }], version: null }),
);
assert.ok(part.includes(`(version ${COULDNT_BE_READ})`));
assert.ok(part.includes(`The tools check ${COULDNT_BE_READ}.`));
assert.ok(part.includes(`The build cache ${COULDNT_BE_READ}.`));
assert.ok(part.includes(`- Reading: It ${COULDNT_BE_READ}.`));
assert.ok(part.includes(`The list of folders ${COULDNT_BE_READ}.`));
assert.ok(part.includes(`\nCodex\nIts report ${COULDNT_BE_READ}.\n`));

// Secrets in any part are scrubbed, whatever part carried them.
const leak = diagnosticsReport(parts({ other: ["- x: https://u:p@h.com/a ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"], probeError: "C:\\Users\\Matteo\\bin" }));
assert.ok(!leak.includes("u:p@") && !leak.includes("ghp_") && !leak.includes("Matteo"), leak);

// Names: projects become labels; an author and the Railway project are left out.
const named = {
  teamSkills: null,
  projectSkills: { workspace: "Acme Rebrand", loaded: 3, detail: "3 skills load in Acme Rebrand.", gitignored: [] },
  sharedDefinition: { workspace: "Acme Rebrand", state: "ok", summary: "from main", detail: "Acme Rebrand follows .atelier/workspace.json on main, last changed by Giulia Rossi." },
  railway: { workspace: "Acme Rebrand", state: "ok", summary: "signed in · project acme-prod", detail: "Linked in Acme Rebrand." },
} as unknown as DoctorReport;
const lines = otherLines(named, null, ["Acme Rebrand"]).join("\n");
assert.ok(!/Acme|acme|Giulia|Rossi/.test(lines), lines);
assert.ok(lines.includes("- Skills in this project: 3 loaded. 3 skills load in this project."));
assert.ok(lines.includes("- Shared setup of this project: from main. this project follows .atelier/workspace.json on main."));
assert.ok(lines.includes("- Railway: signed in · project (name left out). Linked in this project."));
const label = projectLabeller(["Acme", "Beta", "Acme"]);
assert.deepEqual([label("Acme"), label("Beta")], ["this project", "project 2"]);
assert.equal(buildCacheLine({ workspaceName: "Acme", enabled: false, status: { exists: true } }, "1.2 GB", "this project"), "- Build cache: this project, 1.2 GB (off).");

console.log("diagnosticsReport: ok");
