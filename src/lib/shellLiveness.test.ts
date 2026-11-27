// Tier 3 source-contract test (GH #95, ADR 0005). Run with Node 22+:
//   node --experimental-strip-types src/lib/shellLiveness.test.ts
//
// Retiring the Live rail and the pinned right panel is presentation only.
// Switching modes must neither spawn nor kill a PTY: the Terminals host and
// the per-workspace card hosts stay mounted and CSS-hidden, and the new
// sidebar session rows never call a tile lifecycle action.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const shell = read("../components/NewWorkspaceShell.tsx");
const sidebar = read("../components/WorkspaceSidebar.tsx");
const rows = read("./sessionRows.ts");

let passed = 0;

// The rail and the right panel are gone.
assert.equal(existsSync(new URL("../components/LiveRail.tsx", import.meta.url)), false);
assert.equal(existsSync(new URL("../components/RightTabs.tsx", import.meta.url)), false);
assert.doesNotMatch(shell, /<LiveRail|<RightTabs|from "\.\/(LiveRail|RightTabs)"|ws-shell-right/);
assert.doesNotMatch(read("../App.css"), /^\.live-rail|^\.right-tabs-host/m);
passed += 1;

// The Terminals host is always rendered and toggled by class, not by mount.
assert.match(
  shell,
  /className=\{`center-mode-host\$\{\s*activeMode === "terminals" \? "" : " hidden"\s*\}`\}/,
);
assert.match(shell, /className=\{`tile-grid-host\$\{visible \? "" : " hidden"\}`\}/);
// Card hosts (Builder xterms) stay one per warmed workspace, CSS-hidden.
assert.match(shell, /\[\.\.\.warmed\]\.map\(\(id\) => \{[\s\S]*?center-card-host\$\{/);
passed += 1;

// GH #95 (Challenger P1 ×2): Code and Knowledge are sticky hosts too — one
// per warmed workspace, hidden by class, never gated on the active mode. A
// mode gate here destroyed CodeMirror's undo history and unsaved Knowledge
// drafts. GH #96: the Library inherited that host, and its Notes page is the
// same panel with the same draft.
assert.doesNotMatch(shell, /activeMode === "(code|library)" &&/);
for (const mode of ["code", "library"]) {
  assert.match(
    shell,
    new RegExp(
      `\\[\\.\\.\\.warmed\\]\\.map\\(\\(id\\) => \\{[\\s\\S]*?stickyHosts\\[\`\\$\\{id\\}:${mode}\`\\][\\s\\S]*?center-mode-sticky`,
    ),
  );
}
// Hiding a sticky host must not unmount it: `.hidden` keeps it displayed.
assert.match(
  read("../App.css"),
  /\.center-mode-sticky\.hidden \{\s*display: flex;\s*visibility: hidden;/,
);
passed += 1;

// Session rows and the sidebar never drive a tile or PTY lifecycle.
const lifecycle =
  /\b(addShellTile|addClaudeTile|addCodexTile|addCodexChatTile|addAgentRunTile|addTilesFromTemplate|closeTile|removeTile|pty_spawn|pty_kill|builder_stop)\b/;
assert.doesNotMatch(rows, lifecycle);
assert.doesNotMatch(sidebar, lifecycle);
assert.doesNotMatch(rows, /from "\.\.\/store|invoke\(/);
passed += 1;

console.log(`shellLiveness: ${passed}/4 passed`);
