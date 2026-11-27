#!/usr/bin/env node
// Team walk with no agent: the scenario of scenario.mjs against both Plyloft
// Test instances, through the ply-test MCP.
//
//   node scripts/app-tester/team-walk/run.mjs [--unattended | --membership] [--fresh] [--plan]
//     [--board-wait-minutes N] [--sync-wait-minutes N] [--member-may-stay-out] [--mcp PATH]
//
// Default mode: the member's Settings re-reads the project, and that's what is
// proved; the new card comes with a press of Get new issues. --unattended: no
// Settings; the member only waits, and it's the one mode whose durations measure
// the board's ten-minute follow (--board-wait-minutes belongs to it) and its
// three-minute read. --membership: after the claim, U17, U14, removing the member,
// inviting them back and their way in again (membership.mjs); it stops before
// Remove while the way back can't land, and --member-may-stay-out presses it
// anyway. --plan prints the steps and runs nothing. --fresh wipes both
// test profiles first, once the sandbox's state is known to be right
// (reset-profile.sh, which refuses while an instance runs): the scenario starts
// from a first run; without it, an instance that already joined fails its
// Setup step.
//
// Report: the walk's dir under ~/ply-build/app-walks/, with report.md (the
// MCP's) and always runner-report.md and timings.json (this script's), even if
// the MCP dies or a signal comes. Anything left open is closed through a fresh
// MCP; what can't be, it says how to close. Exit 0 only when the walk's outcome
// is passato and nothing is left open. One run at a time, with cleanup.mjs too.
// Afterwards: scripts/app-tester/team-walk/cleanup.mjs.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, closeInstances, defaultMcp, isMain, isRunning, McpClient, MEMBER_LOGIN, recordOrphans, runSteps, withTimeout, writeRunnerReport } from "./lib.mjs";
import { memberState, membershipStatement } from "./membership.mjs";
import { buildSteps, checkStartState, modeName } from "./scenario.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const out = { fresh: false, plan: false, unattended: false, membership: false, memberMayStayOut: false, boardWaitMs: undefined, syncWaitMs: undefined, mcp: defaultMcp() };
  const minutes = (value, flag) => {
    const n = Number(value);
    if (!(n > 0)) throw new Error(`${flag} needs a number of minutes`);
    return n * 60_000;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fresh") out.fresh = true;
    else if (arg === "--plan") out.plan = true;
    else if (arg === "--unattended") out.unattended = true;
    else if (arg === "--membership") out.membership = true;
    else if (arg === "--member-may-stay-out") out.memberMayStayOut = true;
    else if (arg === "--board-wait-minutes") out.boardWaitMs = minutes(argv[(i += 1)], arg);
    else if (arg === "--sync-wait-minutes") out.syncWaitMs = minutes(argv[(i += 1)], arg);
    else if (arg === "--mcp") out.mcp = argv[(i += 1)];
    else throw new Error(`unknown option ${arg}`);
  }
  if (out.boardWaitMs && !out.unattended) throw new Error("--board-wait-minutes only means something with --unattended");
  if (out.membership && out.unattended) throw new Error("--membership and --unattended are two different walks: choose one");
  if (out.memberMayStayOut && !out.membership) throw new Error("--member-may-stay-out only means something with --membership");
  return out;
}

export function stampNow(date = new Date()) {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

export function stepsFor(options, stamp) {
  return buildSteps({
    stamp,
    unattended: options.unattended,
    membership: options.membership,
    memberMayStayOut: options.memberMayStayOut,
    ...(options.boardWaitMs ? { boardWaitMs: options.boardWaitMs } : {}),
    ...(options.syncWaitMs ? { syncWaitMs: options.syncWaitMs } : {}),
  });
}

export function planText(options) {
  const lines = [`Modalità: ${modeName(options.unattended, options.membership)}`];
  for (const [i, s] of stepsFor(options, "00000000000000").entries()) {
    lines.push(`${i + 1}. [${s.instance}] ${s.title} (≤ ${Math.round(s.timeoutMs / 1000)} s)\n   atteso: ${s.expected}`);
  }
  return lines.join("\n");
}

/** Whatever is still open goes through a fresh MCP; the walk's own may be dead. */
export async function closeLeftovers(run, deps) {
  let up = [];
  try {
    up = ["owner", "member"].filter(deps.running);
  } catch (error) {
    run.notes.push(`${error.message}: controlla a mano se le istanze sono aperte`);
    run.leftOpen = true;
    return;
  }
  if (up.length === 0) return;
  run.closed = await closeInstances(up, { openMcp: deps.openMcp, record: deps.onOrphans, ...(deps.pids ? { pids: deps.pids } : {}) });
  if (run.closed.problems.length || run.closed.orphans.length) run.leftOpen = true;
}

/** After a signal, if Remove was pressed: where the member stands, through a
 *  fresh MCP (the walk's is closed by then), or that it can't be said. Bounded,
 *  never throws. The way back isn't tried: a signal means stop. */
export async function sayWhereMemberIs(run, { openMcp, log = console.error, timeoutMs = 30_000 }) {
  if (!run.stepCtx?.removePressed) return;
  let mcp = null;
  let text;
  try {
    const read = async () => {
      mcp = await openMcp();
      return membershipStatement(await memberState(mcp));
    };
    text = await withTimeout(read(), timeoutMs, "reading where the member stands");
  } catch (error) {
    text = `Remove was pressed and the run stopped: Plyloft can't say where ${MEMBER_LOGIN} stands (${error.message}). Check both repositories by hand.`;
  } finally {
    mcp?.close();
  }
  run.notes.push(text);
  log(`✗ ${text}`);
}

/**
 * The whole run, with what touches the world given by `deps`: `openMcp`,
 * `running`, `wipe`, `onOrphans`, `walksDir`, `stamp`, `log`, `onStart` (handed
 * the run and a closer, for the signals). Returns the exit code.
 */
export async function walkRun(options, deps) {
  const { log = console.log, stamp } = deps;
  const run = { stamp, mode: modeName(options.unattended, options.membership), results: [], dir: null, outcome: null, report: null, interrupted: null, closed: null, leftOpen: false, notes: [] };
  const save = () => {
    try {
      return writeRunnerReport(run, deps.walksDir);
    } catch (error) {
      log(`✗ runner report: ${error.message}`);
      return null;
    }
  };
  let mcp = null;
  deps.onStart?.(run, () => mcp?.close(), save);
  const finish = async (code) => {
    mcp?.close();
    await closeLeftovers(run, deps);
    const path = save();
    log(`\nesito: ${run.outcome ?? "nessuno"}\nreport del runner: ${path}${run.report ? `\nreport: ${run.report}` : ""}`);
    for (const p of run.closed?.problems ?? []) log(`✗ ancora aperta: ${p}`);
    for (const o of run.closed?.orphans ?? []) log(`✗ orfano: pid ${o.pid} ${o.command} (${o.instance})`);
    log("Poi: node scripts/app-tester/team-walk/cleanup.mjs");
    return run.leftOpen ? Math.max(code, 1) : code;
  };
  try {
    mcp = await deps.openMcp();
    if (options.fresh) {
      await checkStartState(mcp, { membership: options.membership });
      deps.wipe();
    }
    const walk = await mcp.tool("walk_start", {
      guide: `team-walk scenario (scripts/app-tester/team-walk), ${options.membership ? "membership" : options.unattended ? "unattended" : "default"}`,
      title: `Team walk senza agente ${stamp}, modalità ${run.mode}`,
      allow_agent_tiles: false,
      team: true,
      target: "mac",
    });
    run.dir = walk.dir;
  } catch (error) {
    run.notes.push(`non partito: ${error.message}`);
    log(`✗ ${error.message}`);
    return finish(2);
  }
  // What the person must not miss: in the report's notes and on stderr at once.
  const warn = (text) => {
    run.notes.push(text);
    (deps.warn ?? console.error)(`✗ ${text}`);
    save();
  };
  run.stepCtx = { mcp, onOrphans: deps.onOrphans, warn };
  await runSteps(stepsFor(options, stamp), run.stepCtx, {
    record: async (result) => {
      run.results.push(result);
      log(`${result.verdict.padEnd(16)} ${result.seconds.toFixed(1).padStart(7)} s  ${result.id}: ${result.evidence}`);
      save();
      await mcp.tool("walk_step", {
        action: result.title,
        expected: result.expected,
        verdict: result.verdict,
        evidence: result.evidence,
        note: `durata ${result.seconds.toFixed(1)} s (${result.id})`,
        instance: result.instance,
      });
    },
  });
  const failed = run.results.filter((r) => r.verdict !== "passato").map((r) => r.id);
  try {
    const done = await mcp.tool("walk_finish", {
      summary: `Scenario senza agente, modalità ${run.mode}. ${failed.length ? `Non passati: ${failed.join(", ")}.` : "Tutti i passi passati."}`,
    });
    run.outcome = done.outcome;
    run.report = done.report;
  } catch (error) {
    run.notes.push(`walk_finish non riuscito, resta questo report: ${error.message}`);
  }
  return finish(run.outcome === "passato" ? 0 : 1);
}

const EXIT_ON = { SIGINT: 130, SIGTERM: 143 };

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.plan) {
    console.log(planText(options));
    return 0;
  }
  acquireLock("run.mjs");
  const deps = {
    stamp: stampNow(),
    walksDir: process.env.PLY_APP_WALKS_DIR || join(homedir(), "ply-build/app-walks"),
    openMcp: () => new McpClient(options.mcp).start(),
    running: (who) => isRunning(who),
    onOrphans: recordOrphans,
    wipe: () => {
      const reset = join(here, "../reset-profile.sh");
      execFileSync(reset, [], { stdio: "inherit" });
      execFileSync(reset, ["--member"], { stdio: "inherit" });
    },
    onStart: (run, closeMcp, save) => {
      let stopping = false;
      for (const [signal, code] of Object.entries(EXIT_ON)) {
        process.on(signal, () => {
          if (stopping) process.exit(code); // A second one means now.
          stopping = true;
          run.interrupted = signal;
          closeMcp();
          closeLeftovers(run, deps)
            .catch((error) => run.notes.push(error.message))
            .then(() => sayWhereMemberIs(run, { openMcp: deps.openMcp }))
            .finally(() => {
              const path = save();
              console.error(`\n✗ interrotto da ${signal}; report del runner: ${path}`);
              for (const p of run.closed?.problems ?? []) console.error(`✗ ancora aperta: ${p}`);
              process.exit(code);
            });
        });
      }
    },
  };
  return walkRun(options, deps);
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`✗ ${error.message}`);
      process.exit(2);
    },
  );
}
