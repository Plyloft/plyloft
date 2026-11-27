// Try it (TI-2): the pure half of a Try session — the Windows `.cmd` shims
// (spec §7), the one-per-copy rule, the folder and the words. Run with:
//
//     node --experimental-strip-types src/lib/tryTile.test.ts

import assert from "node:assert/strict";
import {
  TRY_STOPPED_FOR_SHIP,
  endedTryTiles,
  findTryTile,
  isTryOf,
  shellFamily,
  tryCommandCmdForm,
  tryCommandForShell,
  tryCwdFor,
  tryStoppedWords,
  tryScriptOf,
  tryTileTitle,
  tryTypedCommand,
} from "./tryTile.ts";

let passed = 0;

// ── The shims ────────────────────────────────────────────────────────────
// The names with a `.cmd` on the cached PATH (`try_cmd_shims_available`).
const ALL = ["npm", "pnpm", "yarn", "npx", "bun"];
const NODE_ONLY = ["npm", "npx"];
// PowerShell on Windows: the package manager at the start runs as its .cmd.
for (const shell of ["pwsh", "powershell", "pwsh.exe", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "POWERSHELL.EXE", ""]) {
  assert.equal(tryCommandForShell("npm run dev", shell, "windows", ALL), "npm.cmd run dev", shell);
}
assert.equal(tryCommandForShell("pnpm run dev", "pwsh", "windows", ALL), "pnpm.cmd run dev");
assert.equal(tryCommandForShell("yarn dev", "pwsh", "windows", ALL), "yarn.cmd dev");
assert.equal(tryCommandForShell("npx vite", "pwsh", "windows", ALL), "npx.cmd vite");
assert.equal(tryCommandForShell("NPM start", "pwsh", "windows", ALL), "NPM.cmd start", "PowerShell ignores case");
assert.equal(tryCommandForShell("npm", "pwsh", "windows", ALL), "npm.cmd", "alone");
assert.equal(tryCommandForShell("  npm run dev", "pwsh", "windows", ALL), "  npm.cmd run dev", "leading space kept");
// Only where the shim exists: no pnpm.cmd, no bun.cmd (a native bun.exe).
assert.equal(tryCommandForShell("pnpm run dev", "pwsh", "windows", NODE_ONLY), "pnpm run dev");
assert.equal(tryCommandForShell("bun run dev", "pwsh", "windows", NODE_ONLY), "bun run dev");
assert.equal(tryCommandForShell("bun run dev", "pwsh", "windows", ALL), "bun.cmd run dev", "an npm-installed bun");
assert.equal(tryCommandForShell("npm run dev", "pwsh", "windows", []), "npm run dev", "nothing found");
assert.equal(tryCommandForShell("npm run dev", "pwsh", "windows", new Set(["npm"])), "npm.cmd run dev", "a set works too");
// Leading `$env:X=…;` assignments: the program after them.
assert.equal(
  tryCommandForShell("$env:PORT=3000; npm run dev", "pwsh", "windows", ALL),
  "$env:PORT=3000; npm.cmd run dev",
);
assert.equal(
  tryCommandForShell(`$env:NODE_ENV="development"; $env:X='a b';npm run dev`, "pwsh", "windows", ALL),
  `$env:NODE_ENV="development"; $env:X='a b';npm.cmd run dev`,
);
assert.equal(tryCommandForShell("$env:PORT=3000; python app.py", "pwsh", "windows", ALL), "$env:PORT=3000; python app.py");
// Only the first word, only a whole word, never twice.
assert.equal(tryCommandForShell("npm.cmd run dev", "pwsh", "windows", ALL), "npm.cmd run dev", "already .cmd");
assert.equal(tryCommandForShell("yarn.cmd dev", "pwsh", "windows", ALL), "yarn.cmd dev", "already .cmd");
assert.equal(tryCommandForShell("npmx run", "pwsh", "windows", ALL), "npmx run");
assert.equal(tryCommandForShell("python manage.py runserver", "pwsh", "windows", ALL), "python manage.py runserver");
assert.equal(tryCommandForShell("bin/rails server", "pwsh", "windows", ALL), "bin/rails server");
assert.equal(tryCommandForShell("echo npm", "pwsh", "windows", ALL), "echo npm");
// cmd: as typed. Git Bash: as typed. The Mac and Linux: as typed, whatever the shell.
assert.equal(tryCommandForShell("npm run dev", "cmd", "windows", ALL), "npm run dev");
assert.equal(tryCommandForShell("npm run dev", "C:\\Windows\\System32\\cmd.exe", "windows", ALL), "npm run dev");
assert.equal(tryCommandForShell("npm run dev", "C:\\Program Files\\Git\\bin\\bash.exe", "windows", ALL), "npm run dev", "Git Bash");
for (const platform of ["mac", "linux"] as const) {
  for (const shell of ["/bin/zsh", "pwsh", ""]) {
    assert.equal(tryCommandForShell("npm run dev", shell, platform, ALL), "npm run dev", `${platform} ${shell}`);
  }
}
assert.equal(shellFamily("pwsh", "mac"), "posix");
assert.equal(shellFamily("cmd.exe", "windows"), "cmd");
assert.equal(shellFamily("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "windows"), "powershell");
// "Try again": the .cmd form whatever the shell, where the shim exists.
assert.equal(tryCommandCmdForm("npm run dev", ALL), "npm.cmd run dev");
assert.equal(tryCommandCmdForm("bun run dev", ALL), "bun.cmd run dev");
assert.equal(tryCommandCmdForm("bun run dev", NODE_ONLY), "bun run dev");
assert.equal(tryCommandCmdForm("yarn.cmd dev", ALL), "yarn.cmd dev");
assert.equal(tryCommandCmdForm("python app.py", ALL), "python app.py");
passed += 1;

// ── One per copy ─────────────────────────────────────────────────────────
const tile = (id: string, extra: object) => ({ id, status: "running", pendingClose: false, ...extra });
const tiles = [
  tile("plain", {}),
  tile("own", { tryOf: { cardId: "c1" } }),
  tile("lane-b", { tryOf: { cardId: "c1", lane: "b" } }),
  tile("ended", { tryOf: { cardId: "c2" }, status: "done" }),
  tile("closing", { tryOf: { cardId: "c3" }, pendingClose: true }),
];
assert.equal(findTryTile(tiles, "c1")?.id, "own");
assert.equal(findTryTile(tiles, "c1", null)?.id, "own");
assert.equal(findTryTile(tiles, "c1", "b")?.id, "lane-b");
assert.equal(findTryTile(tiles, "c1", "a"), null);
assert.equal(findTryTile(tiles, "c2"), null, "an ended session is not running");
assert.equal(findTryTile(tiles, "c3"), null, "nor one being closed");
assert.deepEqual(endedTryTiles(tiles, "c2").map((t) => t.id), ["ended"]);
assert.deepEqual(endedTryTiles(tiles, "c1"), []);
assert.ok(isTryOf({ cardId: "c1", lane: null }, "c1"));
assert.ok(!isTryOf(undefined, "c1"));
passed += 1;

// ── The folder, the title, the words ─────────────────────────────────────
const card = {
  worktreePath: "/r/.plyloft-worktrees/c1",
  buildBoth: { lanes: [{ lane: "a", worktreePath: "/r/.plyloft-worktrees/c1" }, { lane: "b", worktreePath: "/r/.plyloft-worktrees/c1-b" }] },
};
assert.equal(tryCwdFor(card), "/r/.plyloft-worktrees/c1");
assert.equal(tryCwdFor(card, "b"), "/r/.plyloft-worktrees/c1-b");
assert.equal(tryCwdFor({ worktreePath: null }), null);
assert.equal(tryTileTitle("  Dark mode "), "Try · Dark mode");
assert.equal(tryTileTitle(""), "Try");
assert.equal(TRY_STOPPED_FOR_SHIP, "Plyloft stopped your app's preview to ship it.");
assert.equal(tryStoppedWords("ship"), TRY_STOPPED_FOR_SHIP);
assert.equal(tryStoppedWords("archive"), null);
assert.equal(tryStoppedWords("requested"), null);
passed += 1;

// ── The card's port for Vite and Astro (walk fix, spec §4.1) ─────────────
assert.deepEqual(tryScriptOf("npm run dev"), { runner: "npm", script: "dev" });
assert.deepEqual(tryScriptOf("npm.cmd run-script dev"), { runner: "npm", script: "dev" });
assert.deepEqual(tryScriptOf("npm start"), { runner: "npm", script: "start" });
assert.deepEqual(tryScriptOf("pnpm dev"), { runner: "pnpm", script: "dev" });
assert.deepEqual(tryScriptOf("yarn run dev:web"), { runner: "yarn", script: "dev:web" });
assert.deepEqual(tryScriptOf("bun run dev"), { runner: "bun", script: "dev" });
assert.equal(tryScriptOf("npm dev"), null);
assert.equal(tryScriptOf("pnpm install"), null);
assert.equal(tryScriptOf("bun ./server.ts"), null);
assert.equal(tryScriptOf("npx vite"), null);
assert.equal(tryScriptOf("$env:X=1; npm run dev"), null);
assert.equal(tryScriptOf("python3 manage.py runserver"), null);

const P = 41150;
// npm: through `--`; PowerShell gets it quoted (it swallows a bare one).
assert.equal(tryTypedCommand("npm run dev", "vite", P, "posix"), "npm run dev -- --port 41150");
assert.equal(tryTypedCommand("npm run dev", "vite", P, "cmd"), "npm run dev -- --port 41150");
assert.equal(tryTypedCommand("npm run dev", "vite", P, "powershell"), "npm run dev '--' --port 41150");
assert.equal(tryTypedCommand("npm start", "vite dev --host", P, "posix"), "npm start -- --port 41150");
assert.equal(tryTypedCommand("npm run dev -- --host", "vite", P, "posix"), "npm run dev -- --host --port 41150");
// pnpm, Yarn and Bun pass a `--` on to the script: the flags go straight after.
assert.equal(tryTypedCommand("pnpm dev", "vite", P, "posix"), "pnpm dev --port 41150");
assert.equal(tryTypedCommand("pnpm run dev", "vite", P, "powershell"), "pnpm run dev --port 41150");
assert.equal(tryTypedCommand("yarn dev", "vite", P, "posix"), "yarn dev --port 41150");
assert.equal(tryTypedCommand("bun run dev", "vite", P, "posix"), "bun run dev --port 41150");
assert.equal(tryTypedCommand("pnpm dev -- --host", "vite", P, "posix"), "pnpm dev -- --host");
// The script's server: Vite (SvelteKit's `vite dev`), Astro, Nuxt.
assert.equal(tryTypedCommand("npm run dev", "vite --host", P, "posix"), "npm run dev -- --port 41150");
assert.equal(tryTypedCommand("npm run dev", "vite dev", P, "posix"), "npm run dev -- --port 41150");
assert.equal(tryTypedCommand("npm run preview", "vite preview", P, "posix"), "npm run preview -- --port 41150");
assert.equal(tryTypedCommand("npm run dev", "npx --yes vite", P, "posix"), "npm run dev -- --port 41150");
assert.equal(tryTypedCommand("npm run dev", "cross-env NODE_ENV=dev vite", P, "posix"), "npm run dev -- --port 41150");
assert.equal(tryTypedCommand("npm run dev", "tsc -b && vite", P, "posix"), "npm run dev -- --port 41150");
assert.equal(tryTypedCommand("npm run dev", "astro dev", P, "posix"), "npm run dev -- --port 41150");
assert.equal(tryTypedCommand("pnpm dev", "nuxi dev", P, "posix"), "pnpm dev --port 41150");
assert.equal(tryTypedCommand("npm run dev", "nuxt dev", P, "posix"), "npm run dev -- --port 41150");
// Left alone: a port named already, no port, no script, another server, a
// build, a chain that ends elsewhere, a pipe or a background job.
assert.equal(tryTypedCommand("npm run dev", "vite --port 3000", P, "posix"), "npm run dev");
assert.equal(tryTypedCommand("npm run dev -- --port 3000", "vite", P, "posix"), "npm run dev -- --port 3000");
assert.equal(tryTypedCommand("npm run dev", "vite --port=3000", P, "posix"), "npm run dev");
assert.equal(tryTypedCommand("npm run dev", "vite", null, "posix"), "npm run dev");
assert.equal(tryTypedCommand("npm run dev", null, P, "posix"), "npm run dev");
assert.equal(tryTypedCommand("npm run dev", "next dev", P, "posix"), "npm run dev");
assert.equal(tryTypedCommand("npm run build", "vite build", P, "posix"), "npm run build");
assert.equal(tryTypedCommand("npm run dev", "astro build", P, "posix"), "npm run dev");
assert.equal(tryTypedCommand("npm run dev", "vite && node server.js", P, "posix"), "npm run dev");
assert.equal(tryTypedCommand("npm run dev", "vite | tee log", P, "posix"), "npm run dev");
assert.equal(tryTypedCommand("npm run dev", "vite & node api.js", P, "posix"), "npm run dev");
assert.equal(tryTypedCommand("npm run dev", "concurrently \"vite\" \"node api\"", P, "posix"), "npm run dev");
assert.equal(tryTypedCommand("python3 manage.py runserver", "vite", P, "posix"), "python3 manage.py runserver");
// Challenger: a saved command that chains, pipes or backgrounds is left
// as typed, and so are runners that start several servers.
assert.equal(tryScriptOf("npm run dev && echo done"), null);
assert.equal(tryTypedCommand("npm run dev && echo", "vite", P, "posix"), "npm run dev && echo");
assert.equal(tryTypedCommand("npm run dev || true", "vite", P, "posix"), "npm run dev || true");
assert.equal(tryTypedCommand("npm run dev; echo", "vite", P, "posix"), "npm run dev; echo");
assert.equal(tryTypedCommand("npm run dev | tee log", "vite", P, "posix"), "npm run dev | tee log");
assert.equal(tryTypedCommand("npm run dev &", "vite", P, "posix"), "npm run dev &");
assert.equal(tryTypedCommand("vite build && vite preview", "vite", P, "posix"), "vite build && vite preview");
assert.equal(tryTypedCommand("npm run dev", 'concurrently "vite" "api"', P, "posix"), "npm run dev");
assert.equal(tryTypedCommand("npm run dev", "run-p dev:web dev:api", P, "posix"), "npm run dev");
// Astro and Nuxt also take `-p`: a port named that way is kept.
assert.equal(tryTypedCommand("npm run dev", "astro dev -p 4000", P, "posix"), "npm run dev");
assert.equal(tryTypedCommand("pnpm dev -p 4000", "nuxi dev", P, "posix"), "pnpm dev -p 4000");
assert.equal(tryTypedCommand("npm run dev", "nuxt dev -p=4000", P, "posix"), "npm run dev");
// No --strictPort: a taken port moves Vite to the next one in the block.
assert.ok(!tryTypedCommand("npm run dev", "vite", P, "posix").includes("strictPort"));
// Typed twice (a Restart): unchanged the second time.
const once = tryTypedCommand("npm run dev", "vite", P, "posix");
assert.equal(tryTypedCommand(once, "vite", P, "posix"), once);
passed += 1;

console.log(`tryTile: ${passed}/4 passed`);
