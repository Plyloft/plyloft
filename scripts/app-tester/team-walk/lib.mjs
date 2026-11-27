// Team walk scenario (docs/app-tester/DESIGN.md, "Team walks"): the parts with
// no app and no GitHub, tested by lib.test.mjs. The runner speaks to one thing,
// the ply-test MCP, so identity checks, clone roots, env, orphan checks and the
// agent audit stay in one place (Rust) and can't be bypassed from here.
import { execFileSync, spawn } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireWalk } from "../walk-config.mjs";

// The walk's accounts, from walk.env (../walk-config.mjs; the template is
// ../walk.env.example). The ply-test MCP pins the same two repositories.
const WALK = requireWalk(["PLY_WALK_SANDBOX_REPO", "PLY_WALK_OWNER_LOGIN", "PLY_WALK_MEMBER_LOGIN", "PLY_WALK_TEAM_REPO"]);
export const SANDBOX_REPO = WALK.PLY_WALK_SANDBOX_REPO;
export const OWNER_LOGIN = WALK.PLY_WALK_OWNER_LOGIN;
export const MEMBER_LOGIN = WALK.PLY_WALK_MEMBER_LOGIN;
export const TEAM_REPO = WALK.PLY_WALK_TEAM_REPO;
/** A well-formed login GitHub answered 404 for on 2026-11-03, the same word as
 *  `NO_SUCH_LOGIN` in the MCP's readers.rs. `--membership` stops if it exists. */
export const GHOST_LOGIN = "plyloft-walk-no-such-login-7f3k";
/** Every issue the scenario creates starts with this, and cleanup closes
 *  nothing else. No issue on the sandbox had it when it was chosen. */
export const TITLE_PREFIX = "Team walk auto: ";

/** The title a scenario card gets: the prefix and a 14-digit stamp, no more. */
const SCENARIO_TITLE = /^Team walk auto: \d{14}$/;

/** An issue this scenario made and left open. Nothing else counts as one, so
 *  a person's "Team walk auto: flaky sync notes" or another author's is safe. */
export function isScenarioIssue(issue) {
  return issue.state === "OPEN" && typeof issue.title === "string" && SCENARIO_TITLE.test(issue.title) && issue.author?.login === OWNER_LOGIN;
}

/** Whether this module is what node was asked to run. `~/ply-build` is a
 *  symlink, and node resolves the module's path but not argv[1]. */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

export const supportDir = () => join(homedir(), "Library/Application Support");
export const lockPath = () => join(supportDir(), "ply-test-team-walk.lock");
export const orphansPath = () => join(supportDir(), "ply-test-team-walk-orphans.json");

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const processStart = (pid) => {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

/** Who holds the lock, if a live process does. One whose process is gone, or
 *  whose pid now belongs to another process, holds nothing. */
export function lockHolder(path = lockPath(), startOf = processStart) {
  let holder;
  try {
    holder = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
  const start = startOf(holder.pid);
  return start && start === holder.start ? holder : null;
}

/** One run of run.mjs or cleanup.mjs at a time. Throws naming the other one;
 *  released on exit, and a stale one left by a crash is taken over. */
export function acquireLock(label, { path = lockPath(), pid = process.pid, startOf = processStart, onExit = (fn) => process.on("exit", fn) } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid, start: startOf(pid), label }));
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(tmp, path); // Atomic: it fails if the lock exists.
        const release = () => {
          try {
            if (JSON.parse(readFileSync(path, "utf8")).pid === pid) rmSync(path);
          } catch {
            // Already gone.
          }
        };
        onExit(release);
        return release;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const holder = lockHolder(path, startOf);
        if (holder) throw new Error(`another run holds the lock: ${holder.label} (pid ${holder.pid}). Wait for it or stop it first`);
        rmSync(path, { force: true });
      }
    }
    throw new Error(`could not take the lock at ${path}`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const BUNDLES = { owner: "Plyloft Test\\.app/Contents/MacOS/", member: "Plyloft Test Member\\.app/Contents/MacOS/" };
const defaultPgrep = (pattern) => execFileSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** The instance's pids. pgrep's exit 1 is "none"; anything else isn't an
 *  answer, and is never read as "not running". */
export function pidsOf(instance, pgrep = defaultPgrep) {
  try {
    return String(pgrep(BUNDLES[instance])).trim().split(/\s+/).filter(Boolean);
  } catch (error) {
    if (error.status === 1) return [];
    throw new Error(`can't tell whether the ${instance} instance runs: ${error.message}`);
  }
}

export const isRunning = (instance, pgrep = defaultPgrep) => pidsOf(instance, pgrep).length > 0;

/** Orphans outlive the run that found them: kept here until they are gone. */
export function recordOrphans(instance, orphans, { path = orphansPath() } = {}) {
  if (!orphans?.length) return;
  let known = [];
  try {
    known = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    known = [];
  }
  for (const o of orphans) {
    if (!known.some((k) => k.pid === o.pid)) known.push({ ...o, instance });
  }
  writeAtomic(path, `${JSON.stringify(known, null, 2)}\n`);
}

const commandOf = (pid) => {
  try {
    return execFileSync("/bin/ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

/** The recorded orphans still alive (the same pid running the same command).
 *  The ones gone leave the file. */
export function liveOrphans({ path = orphansPath(), command = commandOf } = {}) {
  let known;
  try {
    known = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const live = known.filter((o) => command(o.pid) === o.command);
  if (live.length === 0) rmSync(path, { force: true });
  else if (live.length !== known.length) writeAtomic(path, `${JSON.stringify(live, null, 2)}\n`);
  return live;
}

export const orphanLine = (o) => `orphan still alive: pid ${o.pid} ${o.command} (${o.instance}): end it by hand (kill ${o.pid})`;

/** How a person closes what the MCP couldn't: this instance's window, or these
 *  pids. Never a pattern. */
export function manualClose(instance, pids) {
  const app = instance === "member" ? "Plyloft Test Member" : "Plyloft Test";
  return `${instance}: press Cmd-Q in the "${app}" window${pids.length ? `, or kill ${pids.join(" ")}` : ""}`;
}

/** Closes these instances through a fresh MCP, recording orphans. What it can't
 *  close comes back in `problems`, with how to do it by hand. */
export async function closeInstances(instances, { openMcp, pids = pidsOf, record = recordOrphans }) {
  const out = { closed: [], orphans: [], problems: [] };
  if (instances.length === 0) return out;
  let mcp = null;
  try {
    mcp = await openMcp();
  } catch (error) {
    for (const who of instances) out.problems.push(`${error.message}. ${manualClose(who, safePids(pids, who))}`);
    return out;
  }
  try {
    for (const who of instances) {
      try {
        const quit = await mcp.tool("app_quit", { instance: who });
        out.closed.push(who);
        if (quit.orphans?.length) {
          record(who, quit.orphans);
          out.orphans.push(...quit.orphans.map((o) => ({ ...o, instance: who })));
        }
      } catch (error) {
        out.problems.push(`${error.message}. ${manualClose(who, safePids(pids, who))}`);
      }
    }
  } finally {
    mcp.close();
  }
  return out;
}

function safePids(pids, who) {
  try {
    return pids(who);
  } catch {
    return [];
  }
}

export const defaultMcp = () => process.env.PLY_TEST_MCP || join(homedir(), "ply-build/tools/ply-test-mcp");

export function cardTitle(stamp) {
  return `${TITLE_PREFIX}${stamp}`;
}

/** One control line of a `ui_snapshot` tree: `  - button "Ship" [ref=e31] (disabled)`. */
const LINE = /^(\s*)- (\S+)(?: "((?:[^"\\]|\\.)*)")?(?: \[ref=(e\d+)\])?(.*)$/;

export function parseTree(tree) {
  const nodes = [];
  for (const line of String(tree).split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    // A plain text line has no quotes: `- text: Board On GitHub Issues · o/r.`
    const plain = m[2].endsWith(":");
    nodes.push({
      depth: m[1].length,
      role: plain ? m[2].slice(0, -1) : m[2],
      name: plain ? m[5].trim() : (m[3] ?? "").replace(/\\(.)/g, "$1"),
      ref: m[4] ?? null,
      states: m[5].trim(),
    });
  }
  return nodes;
}

/** The nodes under the last open `within` role (a dialog on top of a page). */
export function inside(nodes, role) {
  const at = nodes.map((n) => n.role).lastIndexOf(role);
  if (at < 0) return [];
  const out = [];
  for (const n of nodes.slice(at + 1)) {
    if (n.depth <= nodes[at].depth) break;
    out.push(n);
  }
  return out;
}

/**
 * The one control with this name, resolved as the bridge does: exact, then
 * case-insensitive, then substring. More than one at the best level is an
 * error naming them, never a guess.
 */
export function findControl(tree, { name, role = null, within = null, exact = false }) {
  const all = parseTree(tree);
  const pool = (within ? inside(all, within) : all).filter((n) => n.ref && (!role || n.role === role));
  const lower = name.toLowerCase();
  const levels = [(n) => n.name === name, (n) => n.name.toLowerCase() === lower, (n) => n.name.toLowerCase().includes(lower)];
  for (const test of exact ? levels.slice(0, 1) : levels) {
    const hits = pool.filter(test);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new Error(`${hits.length} controls match "${name}": ${hits.map((h) => `${h.role} "${h.name}" [${h.ref}]`).join(", ")}`);
    }
  }
  return null;
}

/** The text of a tool's answer; JSON when it is JSON. */
export function answerOf(result) {
  const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `gh_read` wraps the command's output in `{command, output, pending}`. */
export const ghOutput = (answer) => (answer && typeof answer === "object" && "output" in answer ? answer.output : answer);

export function withTimeout(promise, ms, what, onTimeout = () => {}) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${Math.round(ms / 1000)} s: ${what}`));
    }, ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** The MCP for one step: once that step has timed out, whatever is still
 *  running of it can press nothing more. */
function guardedMcp(mcp, token, id) {
  return {
    tool: (name, args) => {
      if (token.cancelled) return Promise.reject(new Error(`step ${id} timed out: ${name} not sent`));
      return mcp.tool(name, args);
    },
  };
}

/** What the runner knows, as text: written after each step, so that a dead MCP
 *  or a signal still leaves a report. */
export function runnerReport(run) {
  const lines = [
    `# Team walk (runner) ${run.stamp}`,
    "",
    `- Modalità: ${run.mode}`,
    `- Esito della MCP: ${run.outcome ?? "nessuno (walk_finish non è arrivato)"}`,
    ...(run.interrupted ? [`- Interrotto da ${run.interrupted}`] : []),
    ...(run.report ? [`- Report della MCP: ${run.report}`] : []),
    "",
    "| Passo | Esito | Durata | Prova |",
    "|---|---|---|---|",
    ...run.results.map((r) => `| ${r.id} | ${r.verdict} | ${r.seconds.toFixed(1)} s | ${String(r.evidence).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
    "",
  ];
  if (run.closed) {
    lines.push(`Chiuse con una MCP nuova: ${run.closed.closed.join(", ") || "nessuna"}.`, "");
    for (const o of run.closed.orphans) lines.push(`- ${orphanLine(o)}`);
    for (const p of run.closed.problems) lines.push(`- Ancora aperta: ${p}`);
    lines.push("");
  }
  if (run.notes.length) lines.push("## Note", "", ...run.notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}

export function writeRunnerReport(run, walksDir) {
  const dir = run.dir ?? join(walksDir, `${run.stamp}-team-walk-runner`);
  const path = join(dir, "runner-report.md");
  writeAtomic(path, runnerReport(run));
  writeAtomic(join(dir, "timings.json"), `${JSON.stringify(run.results.map((r) => ({ id: r.id, verdict: r.verdict, seconds: r.seconds })), null, 2)}\n`);
  return path;
}

/** What a step throws when it couldn't look at what it came for, which isn't a
 *  failure of the thing looked at. */
export class Unverifiable extends Error {
  verdict = "non verificabile";
}

/**
 * Runs the steps in order. A step whose `needs` didn't pass is not run and is
 * `non verificabile`; a step with `always` runs whatever happened. Each gets
 * its own timeout and duration. `record` receives every result as it is known.
 */
export async function runSteps(steps, ctx, { record = async () => {}, now = Date.now } = {}) {
  const results = [];
  const baseMcp = ctx.mcp ?? null;
  const passed = new Set();
  for (const step of steps) {
    const started = now();
    const token = { cancelled: false };
    // This step's own view: what's left of it after a timeout keeps this guard,
    // whatever step runs by then. What it sets on ctx reaches the next ones.
    const guard = baseMcp && guardedMcp(baseMcp, token, step.id);
    const stepCtx = guard ? new Proxy(ctx, { get: (target, key) => (key === "mcp" ? guard : target[key]) }) : ctx;
    const missing = (step.needs ?? []).filter((id) => !passed.has(id));
    const result = { id: step.id, title: step.title, expected: step.expected, instance: step.instance ?? "owner", seconds: 0 };
    if (missing.length > 0 && !step.always) {
      result.verdict = "non verificabile";
      result.evidence = `not run: ${missing.join(", ")} did not pass`;
    } else {
      try {
        result.evidence = (await withTimeout(Promise.resolve().then(() => step.run(stepCtx)), step.timeoutMs, step.id, () => { token.cancelled = true; })) || "ok";
        result.verdict = "passato";
        passed.add(step.id);
      } catch (error) {
        result.verdict = error?.verdict ?? "fallito";
        result.evidence = String(error?.message ?? error);
      }
    }
    result.seconds = (now() - started) / 1000;
    results.push(result);
    // The MCP may be gone by now; the rest must still run, quit above all.
    try {
      await record(result);
    } catch (error) {
      result.recordError = String(error?.message ?? error);
    }
  }
  return results;
}

/** Waits for `check` to return something truthy (polling from here). */
export async function poll(check, { timeoutMs, everyMs = 2000, what, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const started = now();
  let last = null;
  for (;;) {
    last = await check();
    if (last) return last;
    if (now() - started >= timeoutMs) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s: ${what}`);
    await sleep(everyMs);
  }
}

/** The ply-test MCP over stdio: JSON-RPC, one line each way. */
export class McpClient {
  constructor(command = defaultMcp(), args = []) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    // A write to an MCP that has died is its exit's failure, not a crash here.
    this.child.stdin.on("error", () => {});
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.failure = null;
    const fail = (error) => {
      this.failure = error;
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    };
    this.child.on("error", (e) => fail(new Error(`${command}: ${e.message}`)));
    this.child.on("exit", (code) => fail(new Error(`the MCP exited (${code})`)));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let at;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
    });
  }

  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async start() {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "team-walk", version: "1" } });
    return this;
  }

  /** A tool's answer; a tool's error becomes a thrown one with its own words. */
  async tool(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    const answer = answerOf(result);
    if (result.isError) throw new Error(typeof answer === "string" ? answer : JSON.stringify(answer));
    return answer;
  }

  close() {
    this.failure ??= new Error("the MCP was closed");
    this.child.stdin.end();
    this.child.removeAllListeners("exit");
    this.child.kill();
  }
}

/** Reads a repository file a test checks strings against. */
export const readRepoFile = (root, path) => readFileSync(join(root, path), "utf8");
