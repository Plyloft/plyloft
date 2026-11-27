// node --test scripts/app-tester/team-walk/*.test.mjs  (run by ppvp): the runner's pure
// parts and the scenario against a fake MCP. No app, no GitHub.
import "./test-walk-env.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { answerOf, cardTitle, findControl, ghOutput, McpClient, parseTree, poll, readRepoFile, runnerReport, runSteps, TITLE_PREFIX, withTimeout } from "./lib.mjs";
import { closeLeftovers, parseArgs, planText, stampNow, walkRun } from "./run.mjs";
import { buildSteps, closedEvidence, hasIssuesRow, ISSUES_ROW, person, teamStepRoute } from "./scenario.mjs";
import { TEMPLATES, wordInSource, WORDS } from "./strings.mjs";
import { fakeMcp } from "./fake-mcp.mjs";
import { missingLine, parseWalkEnv, resolveWalk } from "../walk-config.mjs";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const TREE = `- region "Board" [ref=e4]
  - heading "In progress" [ref=e9]
  - button "Ship now" [ref=e31] (disabled)
  - button "Move to GitHub Issues" [ref=e40]
  - button "Team walk \\"quoted\\" card" [ref=e41]
- dialog "Move this repository's board?" [ref=e50]
  - text "Moving it changes it for everyone"
  - button "Cancel" [ref=e51]
  - button "Move to GitHub Issues" [ref=e52]
- button "After the dialog" [ref=e60]`;

test("a tree reads as the bridge writes it", () => {
  const nodes = parseTree(TREE);
  assert.deepEqual(nodes[2], { depth: 2, role: "button", name: "Ship now", ref: "e31", states: "(disabled)" });
  assert.equal(nodes[4].name, 'Team walk "quoted" card');
  assert.equal(nodes[6].ref, null);
});

test("a control is found as the bridge resolves it: exact, any case, substring", () => {
  assert.equal(findControl(TREE, { name: "Ship now" }).ref, "e31");
  assert.equal(findControl(TREE, { name: "ship NOW" }).ref, "e31");
  assert.equal(findControl(TREE, { name: "Ship" }).ref, "e31");
  assert.equal(findControl(TREE, { name: "Ship", role: "heading" }), null);
  assert.equal(findControl(TREE, { name: "Nothing" }), null);
});

test("two matches are an error naming them, never a guess", () => {
  assert.throws(() => findControl(TREE, { name: "Move to GitHub Issues" }), /2 controls match.*e40.*e52/);
});

test("within reaches only the open dialog", () => {
  assert.equal(findControl(TREE, { name: "Move to GitHub Issues", within: "dialog" }).ref, "e52");
  assert.equal(findControl(TREE, { name: "Ship now", within: "dialog" }), null);
  assert.equal(findControl(TREE, { name: "After the dialog", within: "dialog" }), null);
  assert.equal(findControl("- button \"x\" [ref=e1]", { name: "x", within: "dialog" }), null);
});

test("answers read as JSON or text; gh_read's output unwraps", () => {
  assert.deepEqual(answerOf({ content: [{ type: "text", text: '{"a":1}' }] }), { a: 1 });
  assert.equal(answerOf({ content: [{ type: "text", text: "- button" }] }), "- button");
  assert.deepEqual(ghOutput({ command: "gh", output: [1], pending: false }), [1]);
  assert.equal(ghOutput("plain"), "plain");
});

test("a step's failure stops what depends on it and always-steps still run", async () => {
  const ran = [];
  const step = (id, extra = {}) => ({ id, title: id, expected: "e", timeoutMs: 1000, run: async () => { ran.push(id); return id; }, ...extra });
  const recorded = [];
  const results = await runSteps(
    [
      step("a"),
      step("b", { needs: ["a"], run: async () => { throw new Error("broken"); } }),
      step("c", { needs: ["b"] }),
      step("d", { needs: ["c"] }),
      step("e", { needs: ["a"] }),
      step("cleanup", { needs: ["b"], always: true }),
    ],
    {},
    { record: async (r) => recorded.push(r.id) },
  );
  assert.deepEqual(results.map((r) => r.verdict), ["passato", "fallito", "non verificabile", "non verificabile", "passato", "passato"]);
  assert.equal(results[1].evidence, "broken");
  assert.match(results[2].evidence, /b did not pass/);
  assert.match(results[3].evidence, /c did not pass/);
  assert.deepEqual(ran, ["a", "e", "cleanup"]);
  assert.equal(recorded.length, 6);
});

test("each step gets its timeout and its duration", async () => {
  let t = 0;
  const [slow, fast] = await runSteps(
    [
      { id: "slow", title: "s", expected: "e", timeoutMs: 20, run: () => new Promise(() => {}) },
      { id: "fast", title: "f", expected: "e", timeoutMs: 1000, run: async () => { t += 2500; return "ok"; } },
    ],
    {},
    { now: () => t },
  );
  assert.equal(slow.verdict, "fallito");
  assert.match(slow.evidence, /timed out.*slow/);
  assert.equal(fast.seconds, 2.5);
  await assert.rejects(withTimeout(new Promise(() => {}), 5, "x"), /timed out/);
});

test("poll returns the first truthy answer and says what it waited for", async () => {
  let t = 0;
  const opts = { everyMs: 1, now: () => (t += 10), sleep: async () => {} };
  let n = 0;
  assert.equal(await poll(async () => (++n === 3 ? "yes" : null), { ...opts, timeoutMs: 1000, what: "x" }), "yes");
  await assert.rejects(poll(async () => null, { ...opts, timeoutMs: 20, what: "the thing" }), /the thing/);
});

test("the options are few and an unknown one is refused", () => {
  assert.deepEqual(parseArgs(["--fresh"]).fresh, true);
  assert.equal(parseArgs(["--unattended", "--board-wait-minutes", "2"]).boardWaitMs, 120_000);
  assert.throws(() => parseArgs(["--board-wait-minutes", "2"]), /--unattended/, "the wait is that mode's");
  assert.throws(() => parseArgs(["--apply"]), /unknown option/);
  assert.throws(() => parseArgs(["--unattended", "--board-wait-minutes", "x"]), /minutes/);
  assert.equal(stampNow(new Date("2026-11-02T16:19:36Z")), "20261102161936");
});

test("each of the app's words is drawn where the table says, as a string or a JSX label", () => {
  for (const [key, [text, file]] of Object.entries(WORDS)) {
    assert.ok(wordInSource(readRepoFile(ROOT, file), text), `${key}: "${text}" isn't a string or label in ${file}`);
  }
  for (const [code, file] of TEMPLATES) assert.ok(readRepoFile(ROOT, file).includes(code), `${code} in ${file}`);
});

test("a word's letters in a comment or a longer word don't count", () => {
  assert.ok(wordInSource('label: "Closed",', "Closed"));
  assert.ok(wordInSource("return `Claimed by ${x}`", "Claimed by"));
  assert.ok(wordInSource("<CBtn>\n  Claim\n</CBtn>", "Claim"));
  assert.ok(wordInSource('Cards of{" "}\n<p>Cards of{" "}', "Cards of"));
  for (const source of ["// Closed by hand", 'x = "Closed issues"', 'title="Claim it too"', "Claimed", "<b>Claim it too</b>"]) {
    assert.ok(!wordInSource(source, source.includes("Closed") ? "Closed" : "Claim"), source);
  }
});

test("every card title carries the prefix cleanup looks for", () => {
  assert.ok(cardTitle("x").startsWith(TITLE_PREFIX));
});

test("a person names itself on every tool call", async () => {
  const calls = [];
  const mcp = { tool: async (name, args) => { calls.push([name, args]); return "- button \"x\" [ref=e1]"; } };
  const who = person(mcp, "member");
  await who.click("x");
  await who.waitText("x");
  await who.waitControl("x");
  await who.snapshot("x");
  await who.state("board");
  await who.clickTitled("x");
  assert.ok(calls.every(([, args]) => args.instance === "member"), JSON.stringify(calls));
});

test("the steps depend on what they need, and quit always runs", () => {
  const steps = buildSteps({ stamp: "s" });
  const ids = steps.map((s) => s.id);
  for (const [i, s] of steps.entries()) {
    assert.ok(s.timeoutMs > 0, s.id);
    for (const need of s.needs ?? []) assert.ok(ids.slice(0, i).includes(need), `${s.id} needs ${need}, later or unknown`);
  }
  assert.equal(steps.at(-1).id, "quit");
  assert.equal(steps.at(-1).always, true);
  assert.deepEqual(steps.filter((s) => s.always).map((s) => s.id), ["quit"]);
});

test("the whole scenario passes against a fake, every app call naming its instance", async () => {
  const mcp = fakeMcp();
  const results = await runSteps(buildSteps({ stamp: "s" }), { mcp });
  assert.deepEqual(results.filter((r) => r.verdict !== "passato").map((r) => [r.id, r.evidence]), []);
  const named = mcp.calls.filter(([name]) => /^(ui_|native_|app_)/.test(name));
  assert.ok(named.length > 30);
  assert.ok(named.every(([, args]) => args.instance === "owner" || args.instance === "member"), "an unnamed call");
  assert.ok(!mcp.calls.some(([, args]) => args.name === "Your AI"), "never opens the AI step");
  assert.ok(mcp.calls.some(([n, a]) => n === "ui_click" && a.instance === "member" && a.ref === "e6"), "the member claims");
  assert.ok(mcp.calls.some(([n, a]) => n === "app_quit" && a.instance === "member"));
});

test("1.175.0 (F2): no Solo or team step — the team step is listed, or Add the team step puts it there", () => {
  assert.equal(teamStepRoute('- button "Your team" [ref=e1]'), "listed");
  assert.equal(teamStepRoute('- text "Your team · Connect GitHub first"'), "listed");
  assert.equal(teamStepRoute('- text "Joining a team?"\n- button "Add the team step" [ref=e2]'), "link");
  assert.equal(teamStepRoute('- button "Your teams" [ref=e1]'), null, "a longer word isn't the step");
  assert.equal(teamStepRoute('- text "Your team needs GitHub."'), null, "the GitHub step's sentence isn't the step");
  assert.equal(teamStepRoute('- heading "Just the essentials"'), null, "neither yet: wait");
});

test("1.175.0 (F2): with the link, Setup asks With a team, then goes on to Your team", async () => {
  // An `extra.tree` replaces the fake's Get new issues: it is given back here.
  const mcp = fakeMcp({ extra: { tree: () => ['- button "Get new issues" [ref=e8]', '- button "Add the team step" [ref=e11]'] } });
  const results = await runSteps(buildSteps({ stamp: "s" }), { mcp });
  assert.deepEqual(results.filter((r) => r.verdict !== "passato").map((r) => [r.id, r.evidence]), []);
  for (const who of ["owner", "member"]) {
    const clicks = mcp.calls.filter(([n, a]) => n === "ui_click" && a.instance === who).map(([, a]) => a.name ?? a.ref);
    const link = clicks.indexOf("Add the team step");
    assert.ok(link >= 0, `${who} presses the link`);
    assert.deepEqual(clicks.slice(link, link + 5), ["Add the team step", "With a team", "Continue", "Switch to step by step", "Your team"], who);
  }
});

test("1.175.0 (F2): the deduced team needs no question, and no removed step is pressed", async () => {
  const mcp = fakeMcp();
  await runSteps(buildSteps({ stamp: "s" }), { mcp });
  const names = mcp.calls.filter(([n]) => n === "ui_click").map(([, a]) => a.name);
  for (const gone of ["Add the team step", "With a team", "On my own", "Use this folder", "Where your projects live", "Solo or team"]) {
    assert.ok(!names.includes(gone), gone);
  }
  assert.ok(names.includes("Your team"));
});

test("a sandbox not on local stops before launching anything, and quit still checks", async () => {
  const mcp = fakeMcp({ board: "githubIssues" });
  const results = await runSteps(buildSteps({ stamp: "s" }), { mcp });
  assert.equal(results[0].verdict, "fallito");
  assert.match(results[0].evidence, /cleanup/);
  assert.ok(!mcp.calls.some(([n]) => n === "app_launch"));
  assert.equal(results.at(-1).verdict, "passato");
  assert.ok(results.slice(1, -1).every((r) => r.verdict === "non verificabile"));
});

test("a refused identity fails the launch; the MCP's own words are the evidence", async () => {
  const mcp = fakeMcp({ failOn: (n, a) => n === "app_launch" && a.instance === "member" });
  const results = await runSteps(buildSteps({ stamp: "s" }), { mcp });
  const launch = results.find((r) => r.id === "launch");
  assert.equal(launch.verdict, "fallito");
  assert.match(launch.evidence, /refused: app_launch/);
  assert.ok(!mcp.calls.some(([n]) => n === "app_dev_team_plan"));
  assert.ok(mcp.calls.some(([n, a]) => n === "app_quit" && a.instance === "owner"), "the instance that did start is closed");
});

test("the stdio client speaks JSON-RPC and turns a tool's error into its words", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-"));
  const fake = join(dir, "mcp");
  writeFileSync(fake, `#!/usr/bin/env node
require("readline").createInterface({input: process.stdin}).on("line", (l) => {
  const m = JSON.parse(l);
  const ok = (result) => console.log(JSON.stringify({jsonrpc: "2.0", id: m.id, result}));
  if (m.method === "initialize") return ok({});
  if (m.params.name === "bad") return ok({content: [{type: "text", text: "no such thing"}], isError: true});
  ok({content: [{type: "text", text: JSON.stringify({echo: m.params.arguments})}], isError: false});
});
`);
  chmodSync(fake, 0o755);
  const client = await new McpClient(fake).start();
  try {
    assert.deepEqual(await client.tool("x", { a: 1 }), { echo: { a: 1 } });
    await assert.rejects(client.tool("bad"), /no such thing/);
  } finally {
    client.close();
    rmSync(dir, { recursive: true });
  }
});

test("two honest modes: only --unattended claims to measure the follow", () => {
  const ids = (unattended) => buildSteps({ stamp: "s", unattended }).map((s) => s.id);
  assert.ok(ids(false).includes("member-settings-reads") && ids(false).includes("member-board-after-read"));
  assert.ok(!ids(false).includes("member-board-follows"));
  assert.ok(ids(true).includes("member-board-follows") && ids(true).includes("member-on-board"));
  assert.ok(!ids(true).includes("member-settings-reads"), "nothing opens Settings");
  const after = buildSteps({ stamp: "s" }).find((s) => s.id === "member-board-after-read");
  assert.match(after.title, /dopo la lettura/);
  assert.doesNotMatch(`${after.title} ${after.expected}`, /senza premere/);
  assert.match(planText({ unattended: false }), /Modalità: default/);
  assert.match(planText({ unattended: true }), /Modalità: unattended/);
  for (const unattended of [false, true]) {
    const steps = buildSteps({ stamp: "s", unattended });
    for (const [i, s] of steps.entries()) for (const need of s.needs ?? []) assert.ok(steps.slice(0, i).some((p) => p.id === need), `${s.id}: ${need}`);
  }
});

test("--unattended presses nothing on the member's side between the Board and the row", async () => {
  const mcp = fakeMcp();
  const results = await runSteps(buildSteps({ stamp: "s", unattended: true }), { mcp });
  assert.deepEqual(results.filter((r) => r.verdict !== "passato").map((r) => [r.id, r.evidence]), []);
  const follows = mcp.calls.findIndex(([n, a]) => n === "ui_wait_for" && a.text?.startsWith("Cards come from"));
  const before = mcp.calls.slice(0, follows).findLastIndex(([n, a]) => n === "ui_click" && a.instance === "member");
  const moved = mcp.calls.findIndex(([n, a]) => n === "ui_click" && a.ref === "e4");
  assert.ok(before < moved, "the member's last press comes before the owner moves the board");
  assert.ok(!mcp.calls.some(([n, a]) => n === "ui_click" && a.instance === "member" && a.name === "Settings"));
});

test("member-sees: only --unattended waits for the Board's own read, and only it calls its duration the data", async () => {
  const pressesOnBoard = (mcp) => {
    const created = mcp.calls.findIndex(([n, a]) => n === "ui_type" && a.submit);
    const claim = mcp.calls.findIndex(([n, a]) => n === "ui_click" && a.ref === "e6");
    return mcp.calls.slice(created, claim).filter(([n, a]) => n === "ui_click" && a.instance === "member" && a.ref === "e8");
  };
  const step = (unattended) => buildSteps({ stamp: "s", unattended }).find((s) => s.id === "member-sees");
  assert.match(step(true).expected, /durata/);
  assert.doesNotMatch(step(false).expected, /la durata di questo passo/);
  assert.match(step(false).expected, /--unattended/);
  assert.match(step(false).title, /Get new issues/);
  assert.doesNotMatch(step(true).title, /Get new issues/);

  const pressed = fakeMcp();
  const plain = await runSteps(buildSteps({ stamp: "s" }), { mcp: pressed });
  const plainSees = plain.find((r) => r.id === "member-sees");
  assert.deepEqual(plain.filter((r) => r.verdict !== "passato").map((r) => [r.id, r.evidence]), []);
  assert.equal(pressesOnBoard(pressed).length, 1, "the press is what brings the card");
  assert.match(plainSees.evidence, /Get new issues premuto \(pressioni: 1\)/);

  const waited = fakeMcp();
  const results = await runSteps(buildSteps({ stamp: "s", unattended: true }), { mcp: waited });
  assert.deepEqual(results.filter((r) => r.verdict !== "passato").map((r) => [r.id, r.evidence]), []);
  assert.equal(pressesOnBoard(waited).length, 0, "nothing pressed, so the duration is the Board's");
});

test("member-sees: a read already running holds the press, and an empty read is pressed again", async () => {
  let looks = 0;
  let presses = 0;
  const extra = {
    tool: (name, args) => {
      if (args.instance !== "member") return undefined;
      if (name === "ui_snapshot" && args.filter === "Get new issues") {
        looks += 1;
        return `- button "Get new issues" [ref=e8]${looks <= 2 ? " (disabled)" : ""}`;
      }
      if (name === "ui_click" && args.ref === "e8") {
        presses += 1;
        return { clicked: true };
      }
      if (name === "app_state" && args.kind === "board" && presses < 2) return [];
      return undefined;
    },
  };
  const mcp = fakeMcp({ extra });
  const step = buildSteps({ stamp: "s", repressMs: 0, pressLookMs: 1 }).find((s) => s.id === "member-sees");
  const said = await step.run({ mcp, number: 200, memberWorkspace: { id: "m" } });
  assert.equal(presses, 2, "the first press found nothing");
  assert.equal(looks, 4, "two looks at a disabled button, then a press each");
  assert.match(said, /pressioni: 2/);
});

test("the issues row must be the real one, in its own case and in a control", () => {
  assert.ok(hasIssuesRow(`- text "Board ${ISSUES_ROW}. Everyone"`));
  // The shape a real snapshot has.
  assert.ok(hasIssuesRow(`  - group "Where the cards live" [ref=e185]\n    - text: Board ${ISSUES_ROW}. Everyone who opens`));
  for (const tree of [
    '- text "The team\'s board is on GitHub Issues"',
    '- text "On GitHub Issues"',
    `- text "on github issues · test-owner/plyloft-ci-sandbox"`,
    `- text "On GitHub Issues · someone/else"`,
    `\nfocused: {"name":"${ISSUES_ROW}"}`,
    `open dialogs: ["${ISSUES_ROW}"]`,
  ]) {
    assert.ok(!hasIssuesRow(tree), tree);
  }
});

test("a closed card is shown by its own row or its column, never by absence", () => {
  const title = "Team walk auto: 20261102161936";
  assert.match(closedEvidence({ tree: `- button "${title} Closed · #200" [ref=e9]`, title }), /Closed/);
  assert.match(closedEvidence({ tree: "", title, card: { ghIssueNumber: 200, columnId: "complete" } }), /Complete/);
  for (const tree of [
    "",
    "- region \"Board\" [ref=e1]\n… (truncated: pass a scope ref or a filter)",
    `- button "${title} Ready to start" [ref=e9]`,
    `- button "${title} Disclosed" [ref=e9]`,
    `- button "An older card Closed" [ref=e8]`,
    `- text "${title} Closed"`,
    `focused: {"name":"${title} Closed"}`,
    `open dialogs: ["${title} Closed"]`,
  ]) {
    assert.equal(closedEvidence({ tree, title, card: { columnId: "todo" } }), null, tree);
    assert.equal(closedEvidence({ tree, title }), null, tree);
  }
});

test("Claim means Claim: Claim it too doesn't pass for it", () => {
  assert.equal(findControl('- button "Claim it too" [ref=e1]', { name: "Claim", role: "button", exact: true }), null);
  assert.equal(findControl('- button "claim" [ref=e1]', { name: "Claim", exact: true }), null);
  assert.equal(findControl('- button "Claim" [ref=e1]', { name: "Claim", exact: true }).ref, "e1");
});

test("a failing record doesn't end the steps, and quit still runs", async () => {
  const seen = [];
  const results = await runSteps(
    [
      { id: "a", title: "a", expected: "e", timeoutMs: 100, run: async () => "x" },
      { id: "quit", title: "q", expected: "e", always: true, timeoutMs: 100, run: async () => { seen.push("quit"); return "x"; } },
    ],
    {},
    { record: async () => { throw new Error("the MCP exited (1)"); } },
  );
  assert.deepEqual(seen, ["quit"]);
  assert.equal(results[0].recordError, "the MCP exited (1)");
});

test("a timed-out step can press nothing more", async () => {
  const sent = [];
  let release;
  const held = new Promise((r) => { release = r; });
  const mcp = { tool: async (name) => { sent.push(name); return "x"; } };
  let late = null;
  await runSteps(
    [{
      id: "slow",
      title: "s",
      expected: "e",
      timeoutMs: 10,
      run: async (ctx) => {
        await ctx.mcp.tool("first");
        await held;
        late = ctx.mcp.tool("second").catch((e) => e.message);
      },
    }],
    { mcp },
  );
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sent, ["first"]);
  assert.match(await late, /timed out: second not sent/);
});

test("quit doesn't call a hung app closed", async () => {
  const hung = fakeMcp({ statusWhy: "no reply to app.info in 30s" });
  const step = buildSteps({ stamp: "s" }).at(-1);
  await assert.rejects(step.run({ mcp: hung }), /doesn't answer/);
  const closed = fakeMcp({ statusWhy: "Plyloft Test is not running (app_launch starts it)" });
  assert.match(await step.run({ mcp: closed }), /non era aperta/);
});

function runWorld(mcp, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tw-run-"));
  const logs = [];
  return {
    dir,
    logs,
    deps: {
      stamp: "20261102161936",
      walksDir: dir,
      openMcp: async () => mcp,
      running: () => false,
      onOrphans: () => {},
      wipe: () => {},
      log: (l) => logs.push(l),
      ...extra,
    },
  };
}

test("an MCP that dies mid-walk still leaves a report, and a fresh MCP closes the apps", async () => {
  let dead = false;
  const dying = fakeMcp();
  const tool = dying.tool;
  const dyingMcp = { close: () => {}, tool: async (n, a) => {
    if (n === "app_dev_team_plan") dead = true;
    if (dead) throw new Error("the MCP exited (1)");
    return tool(n, a);
  } };
  const fresh = { calls: [], close: () => {}, tool: async (n, a) => (fresh.calls.push([n, a.instance]), { orphans: [] }) };
  const opened = [dyingMcp, fresh];
  const up = new Set(["owner", "member"]);
  const { dir, deps, logs } = runWorld(dyingMcp, { openMcp: async () => opened.shift(), running: (w) => up.has(w) });
  try {
    dying.state.dir = join(dir, "walk");
    const code = await walkRun({ unattended: false }, deps);
    assert.equal(code, 1);
    assert.deepEqual(fresh.calls, [["app_quit", "owner"], ["app_quit", "member"]]);
    const report = readFileSync(join(dir, "walk", "runner-report.md"), "utf8");
    assert.match(report, /Modalità: default/);
    assert.match(report, /nessuno \(walk_finish non è arrivato\)/);
    assert.match(report, /\| plan \| fallito/);
    assert.match(report, /\| quit \| fallito/);
    assert.match(report, /Chiuse con una MCP nuova: owner, member/);
    assert.ok(existsSync(join(dir, "walk", "timings.json")));
    assert.ok(logs.some((l) => l.includes("runner-report.md")));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("an MCP that won't start at all: a report, and how to close by hand", async () => {
  const { dir, deps } = runWorld(null, {
    openMcp: async () => { throw new Error("no MCP binary"); },
    running: (w) => w === "member",
    pids: () => ["4242"],
  });
  try {
    assert.equal(await walkRun({ unattended: true }, deps), 2);
    const report = readFileSync(join(dir, "20261102161936-team-walk-runner", "runner-report.md"), "utf8");
    assert.match(report, /Modalità: unattended/);
    assert.match(report, /no MCP binary/);
    assert.match(report, /Cmd-Q in the "Plyloft Test Member" window, or kill 4242/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("--fresh wipes only after the sandbox is known to be right", async () => {
  let wiped = 0;
  const wrong = fakeMcp({ board: "githubIssues" });
  const { dir, deps } = runWorld(wrong, { wipe: () => { wiped += 1; } });
  try {
    assert.equal(await walkRun({ fresh: true, unattended: false }, deps), 2);
    assert.equal(wiped, 0);
    const right = fakeMcp();
    right.state.dir = join(dir, "walk");
    const ok = runWorld(right, { wipe: () => { wiped += 1; } });
    assert.equal(await walkRun({ fresh: true, unattended: false }, ok.deps), 0);
    assert.equal(wiped, 1);
    rmSync(ok.dir, { recursive: true });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a pgrep error leaves the run saying it can't tell, not clean", async () => {
  const run = { notes: [], closed: null, leftOpen: false };
  await closeLeftovers(run, { running: () => { throw new Error("can't tell whether the owner instance runs"); } });
  assert.equal(run.leftOpen, true);
  assert.match(run.notes[0], /can't tell/);
  assert.match(runnerReport({ stamp: "s", mode: "m", results: [], notes: ["n"], outcome: null }), /nessuno/);
});

test("SIGTERM closes through a fresh MCP, leaves a report and frees the lock", async () => {
  const running = spawnSync("/usr/bin/pgrep", ["-f", "Plyloft Test( Member)?\\.app/Contents/MacOS/"]);
  if (running.status === 0) return; // A real instance is up: not this test's to touch.
  const home = mkdtempSync(join(tmpdir(), "tw-sig-"));
  try {
    const fake = join(home, "mcp");
    writeFileSync(fake, `#!/usr/bin/env node
require("readline").createInterface({input: process.stdin}).on("line", (l) => {
  const m = JSON.parse(l);
  const ok = (v) => console.log(JSON.stringify({jsonrpc: "2.0", id: m.id, result: {content: [{type: "text", text: JSON.stringify(v)}], isError: false}}));
  if (m.method === "initialize") return console.log(JSON.stringify({jsonrpc: "2.0", id: m.id, result: {}}));
  if (m.params.name === "walk_start") return ok({dir: process.env.WALK_DIR});
  if (m.params.name === "walk_step") return ok({});
  // gh_read never answers: the first step hangs.
});
`);
    chmodSync(fake, 0o755);
    const walkDir = join(home, "walk");
    const child = spawn(process.execPath, [join(HERE, "run.mjs"), "--mcp", fake], {
      env: { ...process.env, HOME: home, WALK_DIR: walkDir, PLY_APP_WALKS_DIR: home },
      stdio: "ignore",
    });
    const lock = join(home, "Library/Application Support/ply-test-team-walk.lock");
    await poll(async () => existsSync(lock), { timeoutMs: 10_000, everyMs: 50, what: "the lock" });
    await new Promise((r) => setTimeout(r, 400));
    const exited = new Promise((r) => child.on("exit", r));
    child.kill("SIGTERM");
    assert.equal(await exited, 143);
    assert.ok(!existsSync(lock), "the lock is freed");
    const report = readFileSync(join(walkDir, "runner-report.md"), "utf8");
    assert.match(report, /Interrotto da SIGTERM/);
  } finally {
    rmSync(home, { recursive: true });
  }
});

test("walk-config.mjs: the file, the environment over it, and one line for what's missing", () => {
  const text = '# c\n\nPLY_WALK_OWNER_LOGIN=file-owner\nexport PLY_WALK_MEMBER_LOGIN="file-member"\n  PLY_TEST_VM=\'Some VM\'\n';
  assert.deepEqual(parseWalkEnv(text), { PLY_WALK_OWNER_LOGIN: "file-owner", PLY_WALK_MEMBER_LOGIN: "file-member", PLY_TEST_VM: "Some VM" });
  assert.throws(() => parseWalkEnv("PLY_WALK_OWNR_LOGIN=x", "w.env"), /w\.env: unknown variable PLY_WALK_OWNR_LOGIN/);
  assert.throws(() => parseWalkEnv("just words"), /not a KEY=value line/);
  const read = () => text;
  const got = resolveWalk(["PLY_WALK_OWNER_LOGIN", "PLY_WALK_MEMBER_LOGIN"], { env: { PLY_WALK_OWNER_LOGIN: "env-owner", PLY_WALK_MEMBER_LOGIN: "" }, file: "w.env", read });
  assert.deepEqual(got.values, { PLY_WALK_OWNER_LOGIN: "env-owner", PLY_WALK_MEMBER_LOGIN: "file-member" });
  assert.equal(got.missing, null);
  const none = resolveWalk(["PLY_WALK_OWNER_LOGIN", "PLY_WALK_TEAM_REPO", "PLY_WALK_SANDBOX_REPO"], { env: {}, file: "w.env", read: () => null });
  assert.equal(none.missing, "PLY_WALK_OWNER_LOGIN");
  assert.equal(missingLine(none.missing, none.file), "✗ PLY_WALK_OWNER_LOGIN is not set: put it in w.env (copy scripts/app-tester/walk.env.example) or export it");
});
