// Docs contract (GH #212). Run with Node 22+:
//   node --experimental-strip-types src/lib/architectureDoc.test.ts
//
// ARCHITECTURE.md's file map named three files that had been deleted for
// several releases (`components/ProjectConfigPanel.tsx`,
// `components/InstructionFilesPanel.tsx`, `lib/agentTemplates.ts`): a row is
// written when a file is added and nothing reminds anyone when it goes. This
// holds the file map's **first column** to the tree: every backticked file
// path named there must exist, relative to `src/`, `src-tauri/src/`,
// `src-tauri/` or the repository root.
//
// Deliberately narrow. Prose elsewhere in the document names app-support state
// (`settings.json`, `agents/runs/`), user-project files a scan looks for
// (`scripts/verify.sh`) and files as history ("was `TeamSection.tsx`",
// "moved out of the retired `RightTabs.tsx`"): those are not claims that a
// file exists here. So inside a first cell, italic `*(…)*` notes (where a
// row says what a file replaced) are skipped, and a row that opens with
// `*(retired` lists files that are gone on purpose.
//
// Review 1 of GH #212 found the same rot in the other kind of table: the
// `| Command |` tables named IPC commands retired releases ago
// (`instruction_files_check`, `kanban_save`, `show_settings_window`,
// `github_review_requested`). So every command a Command table's first
// column names must be registered in `lib.rs`'s invoke handler. First column
// only, for the same reason: the Purpose prose names Rust functions and the
// history of commands, which are not claims that a command exists.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const doc = readFileSync(new URL("../../docs/ARCHITECTURE.md", import.meta.url), "utf8");
const BASES = ["", "src/", "src-tauri/src/", "src-tauri/"];
const FILE = /\.(rs|tsx?|css|mjs|sh|json|md)$/;

const libRs = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
// Any module's command (`commands::`, `chat::`, `codex_app::` …).
const registered = new Set([...libRs.matchAll(/\b[a-z_]+::([a-z0-9_]+),/g)].map((m) => m[1]));

let checked = 0;
let commands = 0;
let inCommandTable = false;
const missing: string[] = [];
const unregistered: string[] = [];
doc.split("\n").forEach((line, index) => {
  if (!line.startsWith("|")) {
    inCommandTable = false;
    return;
  }
  if (/^\|\s*Command\s*\|/.test(line)) {
    inCommandTable = true;
    return;
  }
  if (inCommandTable && line.startsWith("| `")) {
    const first = line.split("|")[1] ?? "";
    for (const [, name] of first.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?=[(`])/g)) {
      commands += 1;
      if (!registered.has(name)) unregistered.push(`ARCHITECTURE.md:${index + 1} \`${name}\``);
    }
    return;
  }
  if (!line.startsWith("| `") && !line.startsWith("| *(")) return;
  const first = line.split("|")[1] ?? "";
  if (first.trim().startsWith("*(retired")) return;
  const named = first.replace(/\*\([^)]*\)\*/g, "");
  for (const [, token] of named.matchAll(/`([^`]+)`/g)) {
    if (!FILE.test(token) || /[\s()<>*{}]/.test(token)) continue;
    checked += 1;
    if (!BASES.some((base) => existsSync(repo + base + token))) {
      missing.push(`ARCHITECTURE.md:${index + 1} \`${token}\``);
    }
  }
});

// The check has something to hold: the file map is a table of files.
assert.ok(checked > 100, `only ${checked} file-map paths found — did the table's shape change?`);
assert.deepEqual(missing, [], `the file map names files that do not exist:\n${missing.join("\n")}`);
assert.ok(commands > 80, `only ${commands} commands found in the Command tables — did their shape change?`);
assert.deepEqual(
  unregistered,
  [],
  `the Command tables name commands lib.rs does not register:\n${unregistered.join("\n")}`,
);
console.log(`architectureDoc: ${checked} file-map paths exist; ${commands} commands are registered`);
