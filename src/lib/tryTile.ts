// Try it (TI-2, docs/try-it/TRY_IT_SPEC.md §4.1, §4.5, §7): the pure half of
// a card's Try session — its title, which tile is a card copy's Try session
// (one per copy), the folder it runs in, the Windows `.cmd` shims and the
// words for a stop Plyloft made. No store, no Tauri, so node runs
// `tryTile.test.ts`. `lib/trySession.ts` is the part that touches the stores.

import { basename } from "./paths.ts";

/** A build of a card built by both. */
export type TryLane = "a" | "b";

/** Which card copy a tile is the Try session of. In memory only, like the
 *  tile itself: processes never survive a relaunch. */
export interface TryOf {
  cardId: string;
  /** The build of a card built by both; absent for the card's own copy. */
  lane?: TryLane | null;
  /** The command as the member typed it, typed again on a Restart. */
  command?: string;
}

/** TI-5: the card id a workspace's own Try session carries — Try it in
 *  <project>, in the project folder after Ship — so a workspace has at most
 *  one, and no card's stop or removal ever names it (a card id never has a
 *  colon). The Rust twin is `try_session::PROJECT_TRY_CARD_ID`. */
export const PROJECT_TRY_ID = "plyloft:project";

/** Whether `tryOf` (or a card id) is the workspace's own Try session. */
export function isProjectTry(tryOf: Pick<TryOf, "cardId"> | string | null | undefined): boolean {
  const id = typeof tryOf === "string" ? tryOf : tryOf?.cardId;
  return id === PROJECT_TRY_ID;
}

/** The tile's title: "Try · <card title>". */
export function tryTileTitle(cardTitle: string): string {
  const title = cardTitle.trim();
  return title ? `Try · ${title}` : "Try";
}

/** Whether `tryOf` is the Try session of that card copy. */
export function isTryOf(tryOf: TryOf | null | undefined, cardId: string, lane?: TryLane | null): boolean {
  return !!tryOf && tryOf.cardId === cardId && (tryOf.lane ?? null) === (lane ?? null);
}

/** What the one-per-copy rule reads of a tile. */
export interface TryTileLike {
  id: string;
  tryOf?: TryOf;
  status: string;
  pendingClose: boolean;
}

/** A tile whose shell still runs: neither ended nor being closed. */
export function isLiveTryTile(tile: TryTileLike): boolean {
  return !tile.pendingClose && tile.status !== "done" && tile.status !== "crashed";
}

/** The card copy's Try session — the first live one — or null. One per
 *  copy: a second Try it returns this one instead of starting another. */
export function findTryTile<T extends TryTileLike>(
  tiles: readonly T[],
  cardId: string,
  lane?: TryLane | null,
): T | null {
  return tiles.find((t) => isTryOf(t.tryOf, cardId, lane) && isLiveTryTile(t)) ?? null;
}

/** That copy's ended Try tiles, which a new start replaces. */
export function endedTryTiles<T extends TryTileLike>(
  tiles: readonly T[],
  cardId: string,
  lane?: TryLane | null,
): T[] {
  return tiles.filter((t) => isTryOf(t.tryOf, cardId, lane) && !t.pendingClose && !isLiveTryTile(t));
}

/** What the folder rule reads of a card. */
export interface TryCardLike {
  worktreePath?: string | null;
  buildBoth?: { lanes: ReadonlyArray<{ lane: string; worktreePath: string }> } | null;
}

/** The folder a Try session runs in: that build's copy, else the card's own
 *  copy; null when the card has none (after Ship the caller passes the
 *  project folder itself). */
export function tryCwdFor(card: TryCardLike, lane?: TryLane | null): string | null {
  if (lane) {
    const path = card.buildBoth?.lanes.find((l) => l.lane === lane)?.worktreePath;
    if (path) return path;
  }
  return card.worktreePath?.trim() ? card.worktreePath : null;
}

// ── Windows `.cmd` shims (spec §7) ───────────────────────────────────────

export type TryPlatform = "mac" | "windows" | "linux";

/** The package managers whose PowerShell shim (`npm.ps1`) the default
 *  execution policy refuses, where a `.cmd` shim beside it runs under any
 *  policy. Each is typed as `<name>.cmd` only when that shim is on the
 *  cached PATH (`try_cmd_shims_available`): `bun`'s own installer, for one,
 *  puts a native `bun.exe` and no `bun.cmd`. */
export const TRY_SHIM_NAMES: readonly string[] = ["npm", "pnpm", "yarn", "npx", "bun"];

/** Which family a tile shell is. An empty shell on Windows is the backend's
 *  default (`platform::default_shell`): PowerShell 7, else Windows
 *  PowerShell, else cmd — read as PowerShell, and the `.cmd` form runs in
 *  cmd too. */
export function shellFamily(shell: string, platform: TryPlatform): "powershell" | "cmd" | "posix" {
  if (platform !== "windows") return "posix";
  const name = basename(shell.trim(), true).replace(/\.exe$/i, "").toLowerCase();
  if (name === "" || name === "pwsh" || name === "powershell") return "powershell";
  if (name === "cmd") return "cmd";
  return "posix";
}

/** PowerShell's leading `$env:NAME=value;` assignments, then the program. */
const LEADING_PROGRAM =
  /^(\s*(?:\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:"[^"]*"|'[^']*'|[^;\s]*)\s*;\s*)*)([A-Za-z]+)(?=\s|$)/;

function withCmdShim(command: string, shims: Iterable<string>): string {
  const available = new Set([...shims].map((n) => n.toLowerCase()));
  const m = LEADING_PROGRAM.exec(command);
  if (!m) return command;
  const name = m[2].toLowerCase();
  if (!TRY_SHIM_NAMES.includes(name) || !available.has(name)) return command;
  return `${m[1]}${m[2]}.cmd${command.slice(m[0].length)}`;
}

/**
 * The command a Try session types for the member's `command` in `shell`.
 * In PowerShell on Windows a leading `npm`/`pnpm`/`yarn`/`npx`/`bun` (after
 * any `$env:X=…;` assignments) becomes its `.cmd` shim when `shims` — the
 * names with a `.cmd` on the cached PATH — has it, so the execution policy
 * never applies; the sheet still shows what the member typed. Otherwise,
 * in cmd, and on the Mac and Linux, it stays as typed.
 */
export function tryCommandForShell(
  command: string,
  shell: string,
  platform: TryPlatform,
  shims: Iterable<string>,
): string {
  if (shellFamily(shell, platform) !== "powershell") return command;
  return withCmdShim(command, shims);
}

/** "Try again" after PowerShell refused a script: the `.cmd` form of the
 *  command whatever the shell, where `shims` has that shim. */
export function tryCommandCmdForm(command: string, shims: Iterable<string>): string {
  return withCmdShim(command, shims);
}

// ── A stop Plyloft made (spec §4.5) ──────────────────────────────────────

/** Why the backend stopped a card's Try sessions (`try_session::TryStopReason`). */
export type TryStopReason = "ship" | "archive" | "delete" | "discard" | "copy-removed" | "requested";

/** What the card says after a ship stopped its preview (TI-4 shows it).
 *  The Rust twin is `try_session::STOPPED_FOR_SHIP_WORDS`. */
export const TRY_STOPPED_FOR_SHIP = "Plyloft stopped your app's preview to ship it.";

/** The card's words for a stop, or null when the stop needs none (the card
 *  was archived or deleted, or the member asked). */
export function tryStoppedWords(reason: TryStopReason): string | null {
  return reason === "ship" ? TRY_STOPPED_FOR_SHIP : null;
}

// ── The card's port for Vite and Astro (spec §4.1) ───────────────────────

/** A package manager a start command runs a script with. */
export type TryScriptRunner = "npm" | "pnpm" | "yarn" | "bun";

/** Words after `pnpm`/`yarn`/`bun` that are the tool's own, not a script. */
const RUNNER_BUILTINS = new Set(["install", "i", "add", "remove", "rm", "exec", "dlx", "x", "create", "init", "link"]);

/**
 * The `package.json` script a start command runs, or null: `npm run dev`,
 * `npm run-script dev`, `npm start`, `pnpm dev`, `pnpm run dev`, `yarn
 * dev`, `bun run dev`… (a Windows `.cmd` shim allowed). Anything else —
 * leading assignments, another program, a chain (`&&`, `||`, `;`, `|`, a
 * background `&`) — is not read.
 */
export function tryScriptOf(command: string): { runner: TryScriptRunner; script: string } | null {
  // A chain, a pipe or a background job: the appended words would reach
  // something else.
  if (/&&|\|\||;|\||&/.test(command)) return null;
  const m = /^(npm|pnpm|yarn|bun)(?:\.cmd)?\s+(\S+)(?:\s+(\S+))?/i.exec(command.trim());
  if (!m) return null;
  const runner = m[1].toLowerCase() as TryScriptRunner;
  const first = m[2];
  const named = /^[\w:.@/-]+$/;
  if (first === "run" || first === "run-script") {
    return m[3] && named.test(m[3]) && !m[3].startsWith("-") ? { runner, script: m[3] } : null;
  }
  if (runner === "npm") return first === "start" ? { runner, script: "start" } : null;
  if (first.startsWith("-") || RUNNER_BUILTINS.has(first) || !named.test(first)) return null;
  // `bun ./server.ts` runs a file, not a script.
  if (runner === "bun" && /[./]/.test(first)) return null;
  return { runner, script: first };
}

/** The dev servers that ignore `PORT`, by the program a script's last
 *  command runs: Vite (and SvelteKit's `vite dev`), Astro and Nuxt, all set
 *  with `--port`. No `--strictPort`: a Vite whose port is taken moves to the
 *  next one, still inside the card's block, where the block's probe finds
 *  it. */
type TryServer = "vite" | "astro" | "nuxt";
function serverOf(program: string, sub: string | undefined): TryServer | null {
  const isFlag = (w: string | undefined) => w === undefined || w.startsWith("-");
  switch (program) {
    case "vite":
      return isFlag(sub) || sub === "dev" || sub === "serve" || sub === "preview" ? "vite" : null;
    case "astro":
      return sub === "dev" || sub === "start" || sub === "preview" ? "astro" : null;
    case "nuxi":
    case "nuxt":
      return sub === "dev" || sub === "preview" ? "nuxt" : null;
    default:
      return null;
  }
}

/** The server a script body's last command starts, or null: its last command
 *  (after `&&`, `||` or `;` — what the appended words reach) runs Vite,
 *  Astro or Nuxt, perhaps through `npx`/`bunx`/`pnpm exec` or after
 *  `cross-env`/`VAR=value`. A pipe or a background `&` is never touched. */
function scriptServer(body: string): TryServer | null {
  const segments = body.split(/&&|\|\||;/);
  const last = segments[segments.length - 1].trim();
  if (!last || /[|&<>`]|\$\(/.test(last)) return null;
  const words = last.split(/\s+/);
  let i = 0;
  const skipAssignments = () => {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
  };
  skipAssignments();
  if (words[i] === "cross-env") {
    i += 1;
    skipAssignments();
  }
  if (words[i] === "npx" || words[i] === "bunx") {
    i += 1;
    // `npx --yes vite`: the runner's own options.
    while (i < words.length && words[i].startsWith("-")) i += 1;
  } else if (words[i] === "pnpm" && words[i + 1] === "exec") i += 2;
  const program = words[i]?.replace(/^\.\/node_modules\/\.bin\//, "");
  if (!program) return null;
  return serverOf(program, words[i + 1]);
}

/**
 * The line a Try session in a card's copy types for the saved `command`:
 * Vite, Astro and Nuxt ignore `PORT`, so when the command runs a
 * `package.json` script (`scriptBody`, its body; null when none) whose
 * server is one of them, the card's port goes on the line — npm through
 * `--` (quoted `'--'` in PowerShell, which would swallow a bare one), pnpm,
 * Yarn and Bun straight after the script name (they pass a `--` on to the
 * script, and Vite would ignore what follows it). Unchanged when the
 * command or the script already names a port, when there is no port
 * (`portBase` null: the project folder after Ship), or for anything else.
 * The saved command stays as written; Details shows this line.
 */
export function tryTypedCommand(
  command: string,
  scriptBody: string | null | undefined,
  portBase: number | null | undefined,
  shell: "powershell" | "cmd" | "posix",
): string {
  const trimmed = command.trim();
  if (portBase == null || !scriptBody) return command;
  const run = tryScriptOf(trimmed);
  if (!run) return command;
  const server = scriptServer(scriptBody);
  if (!server) return command;
  const names = (re: RegExp) => re.test(trimmed) || re.test(scriptBody);
  if (names(/(?:^|\s)--port(?:[\s=]|$)/)) return command;
  // Astro and Nuxt also take `-p`.
  if (server !== "vite" && names(/(?:^|\s)-p(?:[\s=\d]|$)/)) return command;
  // pnpm, Yarn and Bun pass a `--` on to the script: what follows it is lost.
  if (/(?:^|\s)--(?:\s|$)/.test(trimmed) && run.runner !== "npm") return command;
  const port = `--port ${portBase}`;
  if (run.runner !== "npm") return `${trimmed} ${port}`;
  const hasSeparator = /\s(?:--|'--'|"--")(?:\s|$)/.test(trimmed);
  if (hasSeparator) return `${trimmed} ${port}`;
  return `${trimmed} ${shell === "powershell" ? "'--'" : "--"} ${port}`;
}
