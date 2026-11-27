// node --test scripts/app-tester/team-walk/*.test.mjs  (run by ppvp): cleanup's guards,
// with a fake gh and a throwaway support dir. It never reaches GitHub.
import "./test-walk-env.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apply,
  assertAllowedGh,
  definitionBackToLocal,
  describe,
  isRunning,
  quitOnly,
  ghRunner,
  guardedCloneRoot,
  issuesToClose,
  memberLine,
  memberState,
  parseArgs,
  readState,
} from "./cleanup.mjs";
import { acquireLock, isMain, liveOrphans, lockHolder, MEMBER_LOGIN, recordOrphans, SANDBOX_REPO, TEAM_REPO, TITLE_PREFIX } from "./lib.mjs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER = { login: "test-owner" };
const MINE = { number: 200, title: `${TITLE_PREFIX}20261102161936`, state: "OPEN", author: OWNER };

/** The sandbox's open issues when this was written (2026-11-02), and the
 *  closed one of the first walk: cleanup must leave every one alone. */
const OLD_ISSUES = [
  { number: 84, title: "Skill: install team-free from the team library", state: "OPEN", author: OWNER },
  { number: 80, title: "H5 Windows walk: Builder line in team-moved", state: "OPEN" },
  { number: 46, title: "Walk P-B 2: note file", state: "OPEN" },
  { number: 45, title: "Walk P-B: hello file", state: "OPEN" },
  { number: 44, title: "Walk: README line", state: "OPEN" },
  { number: 31, title: "H1 walk card", state: "OPEN" },
  { number: 25, title: "negate", state: "OPEN" },
  { number: 24, title: "safeDivide", state: "OPEN" },
  { number: 149, title: "Team walk: first card", state: "CLOSED" },
];

test("no old issue is ever one to close", () => {
  assert.deepEqual(issuesToClose(OLD_ISSUES), []);
});

test("only an open issue with the exact title and author closes", () => {
  assert.deepEqual(issuesToClose([...OLD_ISSUES, MINE]), [MINE]);
  for (const title of [
    "Team walk auto: flaky sync notes",
    "team walk auto: 20261102161936",
    ` ${MINE.title}`,
    `${MINE.title} `,
    `${MINE.title}0`,
    "Team walk auto: 2026110216193",
    "Team walk automation",
    "Team walk auto:20261102161936",
    null,
  ]) {
    assert.deepEqual(issuesToClose([{ ...MINE, title }]), [], String(title));
  }
  assert.deepEqual(issuesToClose([{ ...MINE, author: { login: "test-user" } }]), [], "a member's, with a matching title");
  assert.deepEqual(issuesToClose([{ ...MINE, author: undefined }]), [], "no author read");
  assert.deepEqual(issuesToClose([{ ...MINE, state: "CLOSED" }]), []);
});

test("the member's line only reads, on both repositories, and says what it can't", () => {
  const asked = [];
  const gh = (args) => {
    assertAllowedGh(args);
    asked.push(args);
    if (args[1] === `repos/${TEAM_REPO}/collaborators`) return JSON.stringify([OWNER.login, MEMBER_LOGIN]);
    if (args[1] === `repos/${SANDBOX_REPO}/collaborators`) return JSON.stringify([OWNER.login]);
    if (args[1] === `repos/${SANDBOX_REPO}/invitations`) return JSON.stringify([MEMBER_LOGIN]);
    return "[]";
  };
  const line = memberLine(memberState(gh));
  assert.match(line, new RegExp(`${TEAM_REPO}: collaborator; ${SANDBOX_REPO}: invitation pending`));
  assert.ok(asked.every((a) => a[0] === "api" && !a.includes("--method") && !a.includes("-X")), "reads only");
  assert.match(memberLine(memberState(() => "{not json")), /can't read.*can't read/, "never taken for an answer");
  assert.match(memberLine(memberState(() => "[]")), /NOT a collaborator, no invitation; .*NOT a collaborator, no invitation/);
  for (const write of [
    ["api", "--method", "PUT", `repos/${TEAM_REPO}/collaborators/x`],
    ["api", "--method", "DELETE", `repos/${SANDBOX_REPO}/collaborators/x`],
    ["api", "-X", "DELETE", `repos/${SANDBOX_REPO}/collaborators/x`],
    ["api", `repos/${TEAM_REPO}/collaborators`],
    ["api", `repos/${TEAM_REPO}/contents/team.json`],
    ["api", "repos/someone/else/collaborators", "--jq", "[.[] | .login]"],
  ]) {
    assert.throws(() => assertAllowedGh(write), /refused/, write.join(" "));
  }
});

const DEFINITION = (board, repo) =>
  JSON.stringify({ schemaVersion: 1, name: "sandbox monorepo", board, ...(repo ? { githubOwnerRepo: SANDBOX_REPO } : {}), integrationBranch: "main", areas: [{ id: "site" }] }, null, 2);

test("the definition goes back to local from any board, keeping the rest and its order", () => {
  const back = definitionBackToLocal(DEFINITION("githubIssues", true));
  assert.equal(back.from, "githubIssues");
  const next = JSON.parse(back.next);
  assert.equal(next.board, "local");
  assert.ok(!("githubOwnerRepo" in next));
  assert.deepEqual(Object.keys(next), ["schemaVersion", "name", "board", "integrationBranch", "areas"]);
  assert.deepEqual(next.areas, [{ id: "site" }]);
  assert.equal(definitionBackToLocal(DEFINITION("somethingNew", false)).from, "somethingNew");
  assert.equal(definitionBackToLocal(DEFINITION("local", false)), null, "nothing to do");
  assert.throws(() => definitionBackToLocal('{"schemaVersion":1}'), /no board/, "it isn't added");
});

test("only cleanup's few gh commands, only on the sandbox, go through", () => {
  const contents = `repos/${SANDBOX_REPO}/contents/.atelier/workspace.json`;
  for (const ok of [
    ["api", "user", "--jq", ".login"],
    ["issue", "list", "-R", SANDBOX_REPO, "--state", "open"],
    ["issue", "close", "200", "-R", SANDBOX_REPO],
    ["api", `${contents}?ref=main`],
    ["api", "--method", "PUT", contents, "-f", "branch=main"],
  ]) {
    assertAllowedGh(ok);
  }
  for (const bad of [
    ["issue", "close", "200", "-R", "test-owner/plyloft-test-team"],
    ["issue", "list", "-R", "someone/else"],
    ["issue", "close", "200"],
    ["issue", "close", "1; rm", "-R", SANDBOX_REPO],
    ["issue", "delete", "200", "-R", SANDBOX_REPO],
    ["api", "--method", "PUT", "repos/someone/else/contents/.atelier/workspace.json"],
    ["api", "--method", "PUT", `repos/${SANDBOX_REPO}/contents/README.md`],
    ["api", "--method", "DELETE", contents],
    ["api", `repos/someone/else/contents/.atelier/workspace.json?ref=main`],
    ["auth", "token"],
    ["repo", "delete", SANDBOX_REPO],
  ]) {
    assert.throws(() => assertAllowedGh(bad), /refused/, bad.join(" "));
  }
});

test("another repository is refused on the command line, and so is an unknown option", () => {
  assert.equal(parseArgs([]).apply, false, "a dry run by default");
  assert.equal(parseArgs(["--apply"]).apply, true);
  assert.equal(parseArgs(["--repo", SANDBOX_REPO]).apply, false);
  assert.throws(() => parseArgs(["--repo", "test-owner/plyloft-test-team", "--apply"]), /refused/);
  assert.throws(() => parseArgs(["--force"]), /unknown/);
});

function world() {
  const dir = mkdtempSync(join(tmpdir(), "tw-clean-"));
  const support = join(dir, "support");
  for (const id of ["com.mbadv.ply", "com.mbadv.ply.test", "com.mbadv.ply.test2"]) {
    mkdirSync(join(support, id, "team-clones", "repo"), { recursive: true });
    writeFileSync(join(support, id, "workspaces.json"), "{}");
  }
  return { dir, support };
}

test("the path guard allows the two team-clones and nothing else", () => {
  const { dir, support } = world();
  try {
    assert.ok(guardedCloneRoot(join(support, "com.mbadv.ply.test", "team-clones"), support));
    assert.ok(guardedCloneRoot(join(support, "com.mbadv.ply.test2", "team-clones"), support));
    for (const bad of [
      join(support, "com.mbadv.ply", "team-clones"),
      join(support, "com.mbadv.ply.test"),
      join(support, "com.mbadv.ply.test", "team-clones", "repo"),
      join(support, "com.mbadv.ply.test", "team-clones", "..", "..", "com.mbadv.ply", "team-clones"),
      join(support, "com.mbadv.ply.test3", "team-clones"),
      support,
      "/",
    ]) {
      assert.throws(() => guardedCloneRoot(bad, support), /refused/, bad);
    }
    const linked = join(support, "com.mbadv.ply.test2", "team-clones");
    rmSync(linked, { recursive: true });
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), linked);
    assert.throws(() => guardedCloneRoot(linked, support), /refused/, "a symlink");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

/** A fake gh: answers from a small world, logs every call and token it saw. */
function fakeGh(dir, { login = "test-owner", issues = [], definition = DEFINITION("githubIssues", true) } = {}) {
  const path = join(dir, "gh");
  writeFileSync(join(dir, "issues.json"), JSON.stringify(issues));
  writeFileSync(join(dir, "content.json"), JSON.stringify({ sha: "abc", content: Buffer.from(definition).toString("base64") }));
  writeFileSync(
    path,
    `#!/bin/sh
echo "\${GH_CONFIG_DIR:-default}|\${GH_TOKEN:-none}|$*" >> "${dir}/calls.log"
case "$1 $2" in
  "api user") echo ${login} ;;
  "issue list") cat "${dir}/issues.json" ;;
  api\\ repos/*) cat "${dir}/content.json" ;;
esac
`,
  );
  chmodSync(path, 0o755);
  return ghRunner({ program: path, ownerGh: join(dir, "owner-gh") });
}

const calls = (dir) => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : []);

test("the dry run's reads write nothing and say what would happen", () => {
  const { dir, support } = world();
  try {
    const mine = MINE;
    const gh = fakeGh(dir, { issues: [...OLD_ISSUES, mine] });
    process.env.GH_TOKEN = "leak";
    const state = readState({ gh, running: (who) => who === "member", support });
    delete process.env.GH_TOKEN;
    const lines = describe(state);
    assert.equal(lines.length, 5, lines.join("\n"));
    assert.match(lines[0], /quit the member/);
    assert.match(lines[1], /#200/);
    assert.match(lines[2], /board back to local \(it says "githubIssues" now\)/);
    assert.match(lines[3], /com\.mbadv\.ply\.test\/team-clones/);
    assert.ok(!lines.join("\n").includes("#84"), "an old issue");
    const log = calls(dir);
    assert.ok(log.every((l) => !/issue close|PUT/.test(l)), log.join("\n"));
    assert.ok(log.every((l) => l.includes("|none|") && l.startsWith(join(dir, "owner-gh"))), "scrubbed, owner's config");
    assert.ok(existsSync(join(support, "com.mbadv.ply.test", "team-clones")));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("apply does exactly that, and leaves the installed profile and the old issues alone", async () => {
  const { dir, support } = world();
  try {
    const mine = MINE;
    const gh = fakeGh(dir, { issues: [...OLD_ISSUES, mine] });
    const quits = [];
    const state = readState({ gh, running: (who) => who === "owner", support });
    await apply(state, { gh, support, quit: async (who) => quits.push(who) });
    assert.deepEqual(quits, ["owner"]);
    const log = calls(dir);
    const closes = log.filter((l) => l.includes("issue close"));
    assert.equal(closes.length, 1);
    assert.match(closes[0], /issue close 200 -R test-owner\/plyloft-ci-sandbox/);
    const put = log.find((l) => l.includes("--method PUT"));
    assert.match(put, /contents\/\.atelier\/workspace\.json/);
    assert.match(put, /branch=main/);
    assert.match(put, /sha=abc/);
    assert.match(put, /githubIssues → local/);
    assert.ok(!existsSync(join(support, "com.mbadv.ply.test", "team-clones")));
    assert.ok(!existsSync(join(support, "com.mbadv.ply.test2", "team-clones")));
    assert.ok(existsSync(join(support, "com.mbadv.ply", "team-clones", "repo")), "the installed profile");
    assert.ok(existsSync(join(support, "com.mbadv.ply.test", "workspaces.json")), "the rest of a test profile");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("nothing to do is an answer, and apply then writes nothing", async () => {
  const { dir, support } = world();
  try {
    for (const id of ["com.mbadv.ply.test", "com.mbadv.ply.test2"]) rmSync(join(support, id, "team-clones"), { recursive: true });
    const gh = fakeGh(dir, { issues: OLD_ISSUES, definition: DEFINITION("local", false) });
    const state = readState({ gh, running: () => false, support });
    assert.deepEqual(describe(state), []);
    await apply(state, { gh, support, quit: async () => assert.fail("nothing to quit") });
    assert.ok(calls(dir).every((l) => !/issue close|PUT/.test(l)));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("gh answering as anyone else writes nothing, and quits nothing", async () => {
  const { dir, support } = world();
  try {
    const gh = fakeGh(dir, { login: "test-user", issues: [MINE] });
    const state = readState({ gh, running: () => true, support });
    await assert.rejects(apply(state, { gh, support, quit: async () => assert.fail("quit") }), /answers as test-user/);
    assert.ok(calls(dir).every((l) => !/issue close|PUT/.test(l)));
    assert.ok(existsSync(join(support, "com.mbadv.ply.test", "team-clones")));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a bad clone path stops apply before anything happens", async () => {
  const { dir, support } = world();
  try {
    const gh = fakeGh(dir, { issues: [MINE] });
    const state = readState({ gh, running: () => false, support });
    state.clones.push(join(support, "com.mbadv.ply", "team-clones"));
    await assert.rejects(apply(state, { gh, support, quit: async () => {} }), /refused/);
    assert.ok(calls(dir).every((l) => !/issue close|PUT/.test(l)));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

function scratch() {
  return mkdtempSync(join(tmpdir(), "tw-state-"));
}

test("through a symlink the scripts still run, --apply included", () => {
  const dir = scratch();
  try {
    const link = join(dir, "link");
    symlinkSync(HERE, link);
    const env = { ...process.env, HOME: dir };
    // An option it refuses is the proof the guard let main run: exit 1, not a silent 0.
    const bad = spawnSync(process.execPath, [join(link, "cleanup.mjs"), "--apply", "--no-such-option"], { encoding: "utf8", env });
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stderr, /unknown option/);
    const plan = spawnSync(process.execPath, [join(link, "run.mjs"), "--plan"], { encoding: "utf8", env });
    assert.equal(plan.status, 0);
    assert.match(plan.stdout, /Modalità/);
    const direct = pathToFileURL(join(HERE, "run.mjs")).href;
    assert.ok(isMain(direct, join(link, "run.mjs")));
    assert.ok(!isMain(direct, join(HERE, "cleanup.mjs")));
    assert.ok(!isMain(direct, undefined));
    assert.ok(!isMain(direct, join(dir, "missing")));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("the lock keeps a second run out, and is released and stale-safe", () => {
  const dir = scratch();
  try {
    const path = join(dir, "x.lock");
    const noExit = { onExit: () => {} };
    const release = acquireLock("first", { path, pid: 10, startOf: () => "t", ...noExit });
    assert.throws(() => acquireLock("second", { path, pid: 11, startOf: () => "t", ...noExit }), /first \(pid 10\)/);
    assert.equal(lockHolder(path, () => "t").label, "first");
    release();
    assert.equal(lockHolder(path, () => "t"), null);
    acquireLock("crashed", { path, pid: 12, startOf: () => "t", ...noExit });
    const gone = (pid) => (pid === 12 ? "" : "t");
    acquireLock("after a crash", { path, pid: 13, startOf: gone, ...noExit });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).label, "after a crash");
    const reused = (pid) => (pid === 13 ? "another start" : "t");
    acquireLock("after a pid came back", { path, pid: 14, startOf: reused, ...noExit });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 14);
    release();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 14, "a release takes only its own");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("an orphan stays on record until it's gone", () => {
  const dir = scratch();
  try {
    const path = join(dir, "orphans.json");
    assert.deepEqual(liveOrphans({ path }), []);
    recordOrphans("member", [{ pid: 7, command: "gh" }], { path });
    recordOrphans("member", [{ pid: 7, command: "gh" }], { path });
    recordOrphans("owner", [{ pid: 8, command: "git" }], { path });
    const alive = (pid) => ({ 7: "gh", 8: "git" })[pid] ?? "";
    assert.equal(liveOrphans({ path, command: alive }).length, 2);
    assert.equal(liveOrphans({ path, command: alive })[0].instance, "member");
    assert.deepEqual(liveOrphans({ path, command: (pid) => (pid === 7 ? "gh" : "") }).map((o) => o.pid), [7]);
    assert.deepEqual(liveOrphans({ path, command: alive }).map((o) => o.pid), [7], "the gone one left the file");
    assert.deepEqual(liveOrphans({ path, command: () => "something else on that pid" }), []);
    assert.ok(!existsSync(path));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a rerun keeps saying the orphan is there, even with nothing else to do", () => {
  const { dir, support } = world();
  try {
    for (const id of ["com.mbadv.ply.test", "com.mbadv.ply.test2"]) rmSync(join(support, id, "team-clones"), { recursive: true });
    const gh = fakeGh(dir, { issues: OLD_ISSUES, definition: DEFINITION("local", false) });
    const state = readState({ gh, running: () => false, support, orphans: () => [{ pid: 7, command: "gh", instance: "member" }] });
    assert.deepEqual(describe(state), []);
    assert.equal(state.orphans.length, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a pgrep that can't answer isn't read as not running", () => {
  const fail = (status) => () => {
    throw Object.assign(new Error("boom"), { status });
  };
  assert.equal(isRunning("owner", fail(1)), false, "exit 1 is no match");
  assert.equal(isRunning("owner", () => "123\n"), true);
  assert.throws(() => isRunning("owner", fail(2)), /can't tell/);
  assert.throws(() => isRunning("member", fail(undefined)), /can't tell/, "no pgrep at all");
});

test("--quit-only needs no gh, closes what runs, and says how when it can't", async () => {
  const out = [];
  const log = (l) => out.push(l);
  const orphans = () => [];
  const quits = [];
  const mcp = { tool: async (n, a) => (quits.push([n, a.instance]), { orphans: [] }), close: () => {} };
  assert.equal(await quitOnly({ running: () => true, openMcp: async () => mcp, orphans, log }), 0);
  assert.deepEqual(quits, [["app_quit", "owner"], ["app_quit", "member"]]);
  out.length = 0;
  assert.equal(await quitOnly({ running: () => false, openMcp: async () => assert.fail("no MCP needed"), orphans, log }), 0);
  assert.match(out[0], /closed/);
  out.length = 0;
  const code = await quitOnly({
    running: (who) => who === "member",
    openMcp: async () => { throw new Error("no MCP"); },
    pids: () => ["4242"],
    orphans,
    log,
  });
  assert.equal(code, 1);
  assert.match(out.join("\n"), /Cmd-Q in the "Plyloft Test Member" window, or kill 4242/);
  const recorded = [];
  const left = { tool: async () => ({ orphans: [{ pid: 9, command: "gh" }] }), close: () => {} };
  const orphanCode = await quitOnly({ running: (w) => w === "owner", openMcp: async () => left, record: (w, o) => recorded.push([w, o]), orphans: () => [{ pid: 9, command: "gh", instance: "owner" }], log });
  assert.equal(orphanCode, 1);
  assert.equal(recorded[0][0], "owner");
  assert.deepEqual(parseArgs(["--quit-only"]).quitOnly, true);
  assert.throws(() => parseArgs(["--quit-only", "--apply"]), /choose one/);
});
