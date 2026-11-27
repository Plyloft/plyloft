#!/usr/bin/env node
// Brings the team walk back to its starting state. A dry run by default: it
// prints what it would do; --apply does it.
//
//   node scripts/app-tester/team-walk/cleanup.mjs [--apply | --quit-only]
//
// --quit-only closes the two instances through a fresh MCP and nothing else: no
// gh, and the issues and clones stay as evidence. What it can't close, it says
// how to. It acts without --apply, and kills nothing.
//
// - both instances closed, through the MCP's app_quit (with its orphan check);
// - the issues the scenario created closed: open, on the sandbox, titled exactly
//   `Team walk auto: <14 digits>`, by the owner (PLY_WALK_OWNER_LOGIN), and never another;
// - the sandbox's board back to `local` in .atelier/workspace.json from whatever
//   it says (it prints what), one commit on main of the sandbox
//   (PLY_WALK_SANDBOX_REPO); a file with no `board` is refused;
// - each test profile's team-clones removed, through a path guard.
//
// It also says, reading only, where the test member stands on the sandbox and the
// test team: nothing here writes either's people. Any write to a repository other
// than the sandbox is refused, and GitHub writes run only
// when gh answers as the owner, in the owner's env dir when there is one.
// Nothing else is touched: a profile's other state is reset-profile.sh's.
// An orphan a quit found is recorded, and every later run says so until it's
// gone. --apply and --quit-only take the same lock as run.mjs.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  closeInstances,
  defaultMcp,
  isMain,
  isRunning,
  isScenarioIssue,
  liveOrphans,
  lockHolder,
  McpClient,
  MEMBER_LOGIN,
  orphanLine,
  orphansPath,
  OWNER_LOGIN,
  pidsOf,
  recordOrphans,
  SANDBOX_REPO,
  TEAM_REPO,
} from "./lib.mjs";

export { isRunning };

export const PROFILE_IDS = ["com.mbadv.ply.test", "com.mbadv.ply.test2"];
const DEFINITION = ".atelier/workspace.json";

export function parseArgs(argv) {
  const out = { apply: false, quitOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--quit-only") out.quitOnly = true;
    else if (arg === "--repo") {
      if (argv[(i += 1)] !== SANDBOX_REPO) throw new Error(`refused: only ${SANDBOX_REPO}`);
    } else throw new Error(`unknown option ${arg}`);
  }
  if (out.apply && out.quitOnly) throw new Error("--quit-only and --apply are two different things: choose one");
  return out;
}

/** The only issues cleanup may close. */
export const issuesToClose = (list) => list.filter(isScenarioIssue);

/** The file with its board back to local, whatever the board is now, and what
 *  it was. Null if it's local already. A file with no `board` isn't one this
 *  scenario knows: it is refused, not given one. */
export function definitionBackToLocal(text) {
  const parsed = JSON.parse(text);
  if (typeof parsed.board !== "string") throw new Error(`refused: ${DEFINITION} has no board`);
  if (parsed.board === "local") return null;
  const from = parsed.board;
  parsed.board = "local";
  delete parsed.githubOwnerRepo;
  return { from, next: `${JSON.stringify(parsed, null, 2)}\n` };
}

const COLLABORATORS_JQ = "[.[] | .login]";
const INVITATIONS_JQ = "[.[] | select(.expired | not) | .invitee.login]";
const peopleReads = (repo) => [
  ["api", `repos/${repo}/collaborators`, "--jq", COLLABORATORS_JQ],
  ["api", `repos/${repo}/invitations`, "--jq", INVITATIONS_JQ],
];

/** Throws unless this `gh` command is one of cleanup's few, on the sandbox; of
 *  the test team it may only read who is in it. */
export function assertAllowedGh(args) {
  if ([SANDBOX_REPO, TEAM_REPO].some((repo) => peopleReads(repo).some((read) => read.join("\0") === args.join("\0")))) return;
  const contents = `repos/${SANDBOX_REPO}/contents/${DEFINITION}`;
  const line = args.join(" ");
  const onSandbox = (a) => a[a.indexOf("-R") + 1] === SANDBOX_REPO;
  if (args[0] === "issue" && args[1] === "list" && onSandbox(args)) return;
  if (args[0] === "issue" && args[1] === "close" && /^\d+$/.test(args[2] ?? "") && onSandbox(args)) return;
  if (args[0] === "api" && args[1] === "user" && line === "api user --jq .login") return;
  if (args[0] === "api" && (args[1] === `${contents}?ref=main` || (args[1] === "--method" && args[2] === "PUT" && args[3] === contents))) return;
  throw new Error(`refused gh ${line}: not one of cleanup's commands on ${SANDBOX_REPO}`);
}

/** `gh` scrubbed of tokens, in the owner's env dir when it exists. */
export function ghRunner({ program = "gh", ownerGh = null } = {}) {
  return (args) => {
    assertAllowedGh(args);
    const env = { ...process.env, GH_PROMPT_DISABLED: "1" };
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"]) delete env[name];
    if (ownerGh) env.GH_CONFIG_DIR = ownerGh;
    return execFileSync(program, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  };
}

/**
 * The path it may remove: exactly `<support>/<test profile>/team-clones`, a real
 * directory, reached with no symlink. Anything else throws.
 */
export function guardedCloneRoot(path, support) {
  const allowed = PROFILE_IDS.map((id) => join(support, id, "team-clones"));
  const wanted = resolve(path);
  if (!allowed.includes(wanted)) throw new Error(`refused: ${path} is not a test profile's team-clones`);
  if (lstatSync(wanted).isSymbolicLink() || !lstatSync(wanted).isDirectory()) throw new Error(`refused: ${path} is not a plain directory`);
  if (realpathSync(wanted) !== join(realpathSync(support), wanted.slice(resolve(support).length + 1))) {
    throw new Error(`refused: ${path} goes through a symlink`);
  }
  return wanted;
}

/** Where the member stands on both repositories. Reads only; what can't be read
 *  is said, never taken for an answer. */
export function memberState(gh, login = MEMBER_LOGIN) {
  const has = (args) => JSON.parse(gh(args)).some((l) => l?.toLowerCase() === login.toLowerCase());
  return [["team", TEAM_REPO], ["sandbox", SANDBOX_REPO]].map(([name, repo]) => {
    try {
      const [people, invitations] = peopleReads(repo);
      return { name, repo, on: has(people), invited: has(invitations) };
    } catch (error) {
      return { name, repo, error: error.message };
    }
  });
}

export function memberLine(state, login = MEMBER_LOGIN) {
  const where = state.map((r) => `${r.repo}: ${r.error ? `can't read (${r.error})` : r.on ? "collaborator" : r.invited ? "invitation pending" : "NOT a collaborator, no invitation"}`);
  return `The member ${login} (read only, cleanup doesn't change it): ${where.join("; ")}`;
}

/** What's to do now. Reads only. */
export function readState({ gh, running, support, orphans = () => [] }) {
  const login = gh(["api", "user", "--jq", ".login"]).trim();
  const issues = issuesToClose(JSON.parse(gh(["issue", "list", "-R", SANDBOX_REPO, "--state", "open", "--limit", "200", "--json", "number,title,state,author"])));
  const file = JSON.parse(gh(["api", `repos/${SANDBOX_REPO}/contents/${DEFINITION}?ref=main`]));
  const text = Buffer.from(file.content, "base64").toString("utf8");
  return {
    login,
    running: ["owner", "member"].filter(running),
    issues,
    definition: { sha: file.sha, ...(definitionBackToLocal(text) ?? { next: null, from: null }) },
    orphans: orphans(),
    member: memberState(gh),
    clones: PROFILE_IDS.map((id) => join(support, id, "team-clones")).filter((p) => existsSync(p)),
  };
}

export function describe(state) {
  const lines = [];
  for (const who of state.running) lines.push(`quit the ${who} instance (app_quit, with its orphan check)`);
  for (const i of state.issues) lines.push(`close issue #${i.number} "${i.title}"`);
  if (state.definition.next) lines.push(`commit board back to local (it says "${state.definition.from}" now) in ${DEFINITION} on main of ${SANDBOX_REPO}`);
  for (const path of state.clones) lines.push(`remove ${path}`);
  return lines;
}

export async function apply(state, { gh, quit, support }) {
  if (state.login !== OWNER_LOGIN) throw new Error(`refused: gh answers as ${state.login}, not ${OWNER_LOGIN}`);
  // Guards first: nothing happens if a path is wrong.
  const clones = state.clones.map((p) => guardedCloneRoot(p, support));
  for (const who of state.running) await quit(who);
  for (const i of state.issues) {
    gh(["issue", "close", String(i.number), "-R", SANDBOX_REPO, "--reason", "not planned", "--comment", "Closed by the team walk's cleanup."]);
  }
  if (state.definition.next) {
    gh([
      "api", "--method", "PUT", `repos/${SANDBOX_REPO}/contents/${DEFINITION}`,
      "-f", `message=chore(config): “Board” — ${state.definition.from} → local (team walk cleanup)`,
      "-f", `content=${Buffer.from(state.definition.next).toString("base64")}`,
      "-f", `sha=${state.definition.sha}`,
      "-f", "branch=main",
    ]);
  }
  for (const path of clones) rmSync(path, { recursive: true, force: false });
}

/** The instances closed, nothing else; no gh. Returns the exit code. */
export async function quitOnly({ running, openMcp, pids = pidsOf, record = recordOrphans, orphans = liveOrphans, log = console.log }) {
  const up = ["owner", "member"].filter(running);
  if (up.length === 0) log("Both instances are closed.");
  const result = await closeInstances(up, { openMcp, pids, record });
  for (const who of result.closed) log(`closed the ${who} instance`);
  for (const p of result.problems) log(`✗ couldn't close it: ${p}`);
  const left = orphans();
  for (const o of left) log(`✗ ${orphanLine(o)}`);
  return result.problems.length || left.length ? 1 : 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const openMcp = () => new McpClient(defaultMcp()).start();
  if (options.quitOnly) {
    acquireLock("cleanup.mjs --quit-only");
    return quitOnly({ running: (who) => isRunning(who), openMcp });
  }
  if (options.apply) acquireLock("cleanup.mjs --apply");
  else {
    const holder = lockHolder();
    if (holder) console.log(`Note: ${holder.label} (pid ${holder.pid}) is running; what follows may change under it.`);
  }
  const support = join(homedir(), "Library/Application Support");
  const ownerEnv = process.env.PLY_TEST_OWNER_ENV || join(support, "ply-test-owner");
  const ownerGh = existsSync(join(ownerEnv, "gh")) ? join(ownerEnv, "gh") : null;
  const gh = ghRunner({ ownerGh });
  const state = readState({ gh, running: (who) => isRunning(who), support, orphans: liveOrphans });
  const lines = describe(state);
  console.log(`gh answers as ${state.login}${ownerGh ? ` (${ownerGh})` : " (gh's default config)"}`);
  console.log(memberLine(state.member));
  const sayOrphans = (list) => {
    for (const o of list) console.log(`✗ ${orphanLine(o)}`);
    return list.length ? 1 : 0;
  };
  if (lines.length === 0) {
    if (state.orphans.length === 0) console.log("Nothing to do: both apps closed, no issue of the scenario open, board local, no team clones.");
    return sayOrphans(state.orphans);
  }
  console.log(options.apply ? "Doing:" : "Would do (dry run; --apply does it):");
  for (const line of lines) console.log(`  - ${line}`);
  if (!options.apply) return sayOrphans(state.orphans);
  let mcp = null;
  try {
    await apply(state, {
      gh,
      support,
      quit: async (who) => {
        mcp ??= await openMcp();
        const quit = await mcp.tool("app_quit", { instance: who });
        if (quit.orphans?.length) {
          recordOrphans(who, quit.orphans);
          throw new Error(`${who} left orphans, recorded in ${orphansPath()}: ${JSON.stringify(quit.orphans)}. Stopped here; end them and run this again`);
        }
      },
    });
  } finally {
    mcp?.close();
  }
  const left = liveOrphans();
  if (left.length) return sayOrphans(left);
  console.log("Done. A profile still lists its removed projects until reset-profile.sh (run.mjs --fresh does it).");
  return 0;
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`✗ ${error.message}`);
      process.exit(1);
    },
  );
}
