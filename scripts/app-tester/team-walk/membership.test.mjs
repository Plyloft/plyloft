// node --test scripts/app-tester/team-walk/*.test.mjs  (run by ppvp): --membership
// against a fake MCP. No app, no GitHub.
import "./test-walk-env.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeMcp } from "./fake-mcp.mjs";
import { GHOST_LOGIN, MEMBER_LOGIN, readRepoFile, runSteps } from "./lib.mjs";
import { read, boardLine, checkMembershipStart, claimsProblem, membershipStatement, refusedSend, removalLine, WAY_BACK_CLOSED } from "./membership.mjs";
import { parseArgs, planText, sayWhereMemberIs } from "./run.mjs";
import { buildSteps } from "./scenario.mjs";
import { NO_ACCOUNT_LINE, REMOVAL_CLAIMS_NOTE, REMOVAL_NORMAL, word } from "./strings.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const OWNER = "test-owner";
const FAST = { claimsWaitMs: 20, settleMs: 0, backWaitMs: 20 };
const REFUSAL = `Couldn't add the member. Plyloft couldn't give ${MEMBER_LOGIN} a seat on the team's plan: Plyloft couldn't reach its server. Nothing was changed on GitHub.`;
const RESULT = REMOVAL_NORMAL(MEMBER_LOGIN, "test-owner/plyloft-test-team", "test-owner/plyloft-ci-sandbox");

/** GitHub and Members as the mode sees them. `seatRefuses`: a build without the
 *  dev plan's way past the seat, which also doesn't report it. */
function world({ seatRefuses = false, ghostExists = false, ghostSendOn = false, keepsAssignee = false, keepsSandbox = false, removalThrows = false, start = {}, workspaces = ["test-owner/plyloft-ci-sandbox"], unresolvedReviews = 0, acceptThrows = null } = {}) {
  const gh = { onTeam: true, onSandbox: true, invitedTeam: false, invitedSandbox: false, listed: true, ...start };
  const ui = { unresolved: unresolvedReviews, reviews: 0, plan: null, sheet: false, removed: null, refused: null, read: "read just now", removePresses: 0, sends: [] };
  const extra = {
    freeRow: " Ready to start",
    tree: (who) => {
      if (who === "member") {
        return [
          `- text: Member of test-owner/plyloft-test-team, as ${MEMBER_LOGIN}`,
          '- button "Close settings" [ref=e70]',
          '- button "Read it again" [ref=e71]',
          "- text: Cards come from the GitHub issues of",
          '- button "test-owner/plyloft-ci-sandbox, open its issues on GitHub" [ref=e72]',
          `- text: ${gh.onSandbox ? "read just now" : "no access on GitHub, last read just now"}`,
          '- button "Get new issues" [ref=e73]',
        ];
      }
      return [
        ...(ui.removed ? [`- text: ${ui.removed}`] : []),
        "- text: Cards come from the GitHub issues of",
        '- button "test-owner/plyloft-ci-sandbox, open its issues on GitHub" [ref=e75]',
        "- text: read just now",
        '- button "Get new issues" [ref=e76]',
        '- button "Review" [ref=e80]',
        '- button "Close settings" [ref=e81]',
        ...(ui.plan
          ? [
              `- heading "Add ${ui.plan} to Plyloft test team" [ref=e82]`,
              ...(ui.plan === GHOST_LOGIN
                ? [`- text: ${NO_ACCOUNT_LINE(GHOST_LOGIN)}`, `- text: o/r The team repository — Read the team. no GitHub account with this name`, `- button "Send invites" [ref=e83]${ghostSendOn ? "" : " (disabled)"}`]
                : ui.unresolved > 0
                  ? ["- text: could not check — read it again", '- button "Add to the team" [ref=e83] (disabled)']
                  : ['- button "Send invites" [ref=e83]']),
              '- button "Cancel" [ref=e84]',
              ...(ui.refused ? [`- alert "${ui.refused.slice(0, 119)}…" [ref=e85]`, `  - text: ${ui.refused}`] : []),
            ]
          : []),
        ...(ui.sheet
          ? ['- dialog "Remove?" [ref=e90]', `  - text: ${REMOVAL_CLAIMS_NOTE(MEMBER_LOGIN)}`, '  - button "Cancel" [ref=e91]', '  - button "Remove from team" [ref=e92]']
          : []),
      ];
    },
    tool: (name, args, state) => {
      if (name === "app_state" && args.kind === "account") return seatRefuses ? { deviceId: "d" } : { deviceId: "d", devPlanHasNoSeats: true };
      if (name === "gh_read") {
        const people = (on) => [{ login: OWNER }, ...(on ? [{ login: MEMBER_LOGIN }] : [])];
        const invites = (on) => (on ? [{ invitee: MEMBER_LOGIN, expired: false }] : []);
        switch (args.query) {
          case "team_collaborators": return { output: people(gh.onTeam) };
          case "sandbox_collaborators": return { output: people(gh.onSandbox) };
          case "team_invitations": return { output: invites(gh.invitedTeam) };
          case "sandbox_invitations": return { output: invites(gh.invitedSandbox) };
          case "team_manifest": return { output: { members: people(gh.listed), workspaces: Array.isArray(workspaces) ? workspaces.map((repo) => ({ repo })) : workspaces } };
          case "team_no_such_user":
            if (ghostExists) return { output: GHOST_LOGIN };
            throw new Error("gh api users/x failed: gh: Not Found (HTTP 404)");
          default: return undefined;
        }
      }
      if (name === "ui_type" && args.name === word("addSomebody")) {
        ui.typed = args.text;
        return { typed: true };
      }
      if (name === "gh_accept_invitation") {
        if (args.repo === acceptThrows) throw new Error(`GitHub refused the ${args.repo} one`);
        const key = args.repo === "team" ? "invitedTeam" : "invitedSandbox";
        if (!gh[key]) return { accepted: false, why: "no pending invitation to this repository" };
        gh[key] = false;
        gh[args.repo === "team" ? "onTeam" : "onSandbox"] = true;
        return { accepted: true };
      }
      if (name === "ui_click") {
        if (args.name === `More for ${MEMBER_LOGIN}`) return { clicked: true };
        if (args.name === word("removeMenu")) { ui.sheet = true; return { clicked: true }; }
        switch (args.ref) {
          case "e80": ui.plan = ui.typed; ui.refused = null; ui.reviews += 1; return { clicked: true };
          case "e84": if (ui.plan === MEMBER_LOGIN && ui.unresolved > 0) ui.unresolved -= 1; ui.plan = null; return { clicked: true };
          case "e91": ui.sheet = false; return { clicked: true };
          case "e92":
            ui.removePresses += 1;
            ui.sheet = false;
            if (removalThrows) throw new Error("the press died");
            gh.onTeam = false;
            gh.listed = false;
            gh.onSandbox = keepsSandbox;
            ui.removed = RESULT;
            if (!keepsAssignee && state.issue) state.issue.assignees = [];
            return { clicked: true };
          case "e83":
            ui.sends.push(ui.plan);
            if (ui.plan === GHOST_LOGIN || seatRefuses) { ui.refused = REFUSAL; return { clicked: true }; }
            gh.listed = true;
            gh.invitedTeam = !gh.onTeam;
            gh.invitedSandbox = !gh.onSandbox;
            ui.plan = null;
            return { clicked: true };
          default: return undefined;
        }
      }
      return undefined;
    },
  };
  return { mcp: fakeMcp({ extra }), gh, ui };
}

const run = async (w, options = {}, warn = () => {}) => runSteps(buildSteps({ stamp: "20261103120000", membership: true, ...FAST, ...options }), { mcp: w.mcp, warn });
const verdicts = (results) => Object.fromEntries(results.map((r) => [r.id, r.verdict]));
const byId = (results, id) => results.find((r) => r.id === id);

test("the options: one mode at a time, and the override only with it", () => {
  assert.equal(parseArgs(["--membership"]).membership, true);
  assert.equal(parseArgs(["--membership"]).memberMayStayOut, false);
  assert.equal(parseArgs(["--membership", "--member-may-stay-out"]).memberMayStayOut, true);
  assert.throws(() => parseArgs(["--membership", "--unattended"]), /choose one/);
  assert.throws(() => parseArgs(["--member-may-stay-out"]), /--membership/);
});

test("--plan lists this mode's steps; the other two don't get them", () => {
  const plan = planText({ unattended: false, membership: true });
  assert.match(plan, /Modalità: membership/);
  for (const id of ["U17", "U14, le parole", "U14, cosa succede", "gh_accept_invitation", "Dove sta il membro"]) assert.ok(plan.includes(id), id);
  for (const unattended of [false, true]) {
    const ids = buildSteps({ stamp: "s", unattended }).map((s) => s.id);
    assert.ok(!ids.some((id) => /u17|u14|way-back|remove|reinvite|rejoin|membership/.test(id)), ids.join());
  }
  const steps = buildSteps({ stamp: "s", membership: true });
  const ids = steps.map((s) => s.id);
  for (const [i, s] of steps.entries()) for (const need of s.needs ?? []) assert.ok(ids.slice(0, i).includes(need), `${s.id} needs ${need}`);
  assert.deepEqual(ids.slice(ids.indexOf("owner-sees-claim") + 1), [
    "u17-refused", "u14-words", "way-back", "remove", "claims-after-removal", "member-after-removal", "reinvite", "accept-rejoin", "membership-state", "owner-to-board", "delete", "member-after-delete", "quit",
  ]);
});

test("a build without the way past the seat: Remove is never pressed, the member is untouched, and the run isn't a pass", async () => {
  const w = world({ seatRefuses: true });
  const warned = [];
  const results = await run(w, {}, (t) => warned.push(t));
  const v = verdicts(results);
  assert.equal(v["u17-refused"], "passato");
  assert.equal(v["u14-words"], "passato");
  assert.ok(byId(results, "u14-words").evidence.includes(REMOVAL_CLAIMS_NOTE(MEMBER_LOGIN)));
  assert.equal(v["way-back"], "fallito");
  assert.equal(byId(results, "way-back").evidence, WAY_BACK_CLOSED);
  assert.equal(v.remove, "non verificabile");
  assert.equal(w.ui.removePresses, 0);
  assert.deepEqual(w.ui.sends, [], "no send pressed either");
  assert.ok(!w.mcp.calls.some(([n]) => n === "gh_accept_invitation"));
  assert.equal(v.reinvite, "non verificabile");
  assert.equal(v["accept-rejoin"], "non verificabile");
  assert.equal(v["membership-state"], "passato");
  assert.equal(v.delete, "passato");
  assert.equal(v.quit, "passato");
  assert.deepEqual(warned, []);
});

test("a refused send after Remove (--member-may-stay-out, unused today) is U17's proof and the member being out is said", async () => {
  const w = world({ seatRefuses: true });
  const warned = [];
  const results = await run(w, { memberMayStayOut: true }, (t) => warned.push(t));
  const v = verdicts(results);
  assert.equal(w.ui.removePresses, 1);
  assert.equal(v.remove, "passato");
  assert.ok(byId(results, "remove").evidence.includes(RESULT), "the result word for word");
  assert.match(byId(results, "remove").evidence, /sandbox: non lo elenca più/);
  assert.equal(v["claims-after-removal"], "passato");
  assert.match(byId(results, "claims-after-removal").evidence, /assegnatari \[\].*Ready to start/);
  assert.equal(v["member-after-removal"], "passato");
  assert.match(byId(results, "member-after-removal").evidence, /plyloft-ci-sandbox · no access on GitHub, last read just now · Get new issues/);
  assert.equal(v.reinvite, "fallito");
  assert.match(byId(results, "reinvite").evidence, /U17: role alert, no toast.*Couldn't add the member\. Plyloft couldn't give/);
  assert.equal(v["accept-rejoin"], "fallito", "nothing to accept, and it says so");
  assert.equal(v["membership-state"], "fallito");
  const said = byId(results, "membership-state").evidence;
  assert.match(said, /NOT BACK.*plyloft-test-team no.*plyloft-ci-sandbox no.*team\.json no/);
  assert.ok(warned[0].startsWith("Remove from team premuto"), "before the press");
  assert.equal(warned.at(-1), said, "the report and stderr get it too");
  assert.equal(v.delete, "passato", "the card still goes");
  assert.equal(v["member-after-delete"], "non verificabile");
  assert.equal(v.quit, "passato");
});

test("once the way back lands, the whole mode passes and the member ends where they began", async () => {
  const w = world();
  const results = await run(w);
  assert.deepEqual(results.filter((r) => r.verdict !== "passato").map((r) => [r.id, r.evidence]), []);
  assert.equal(byId(results, "remove").evidence.split('". ')[0], `"${RESULT}`, "the normal line, whole");
  assert.doesNotMatch(byId(results, "remove").evidence, /parole diverse/);
  assert.deepEqual(w.ui.sends, [MEMBER_LOGIN]);
  assert.deepEqual(w.mcp.calls.filter(([n]) => n === "gh_accept_invitation").map(([, a]) => a.repo), ["team", "sandbox"]);
  assert.match(byId(results, "accept-rejoin").evidence, /accettato.*accettato.*Member of test-owner\/plyloft-test-team.*read just now/);
  assert.match(byId(results, "membership-state").evidence, /Nothing missing/);
  assert.ok(w.gh.onTeam && w.gh.onSandbox && w.gh.listed);
});

test("a failure after the press still tries the way back and says where the member stands", async () => {
  const w = world({ removalThrows: true });
  const results = await run(w);
  const v = verdicts(results);
  assert.equal(v.remove, "fallito");
  assert.equal(v["claims-after-removal"], "non verificabile");
  assert.equal(v["member-after-removal"], "non verificabile");
  assert.equal(v.reinvite, "passato", "it reads first: still on both, nothing to send");
  assert.match(byId(results, "reinvite").evidence, /nessun invito da mandare/);
  assert.ok(w.mcp.calls.some(([n]) => n === "gh_accept_invitation"), "the same way back");
  assert.equal(v["membership-state"], "passato");
});

test("if GitHub leaves access or the assignee, the step reports what it saw", async () => {
  const kept = await run(world({ keepsSandbox: true, keepsAssignee: true }));
  const said = byId(kept, "claims-after-removal");
  assert.match(byId(kept, "remove").evidence, /sandbox: LO ELENCA ANCORA/);
  assert.equal(said.verdict, "passato", said.evidence);
  assert.match(said.evidence, /accesso al sandbox rimasto.*Claimed by/);
  assert.match(byId(kept, "member-after-removal").evidence, /ha ancora accesso al sandbox: ".*read just now/);

  const noAccessButKept = await run(world({ keepsAssignee: true }));
  const step = byId(noAccessButKept, "claims-after-removal");
  assert.equal(step.verdict, "fallito");
  assert.match(step.evidence, /the sheet says it takes them off.*accesso al sandbox tolto/);
});

test("U17: a login nobody has gets its own words and an off button, and is never pressed", async () => {
  const w = world();
  const results = await run(w);
  const step = byId(results, "u17-refused");
  assert.equal(step.verdict, "passato", step.evidence);
  assert.ok(step.evidence.includes(word("noAccountChip")) && step.evidence.includes(NO_ACCOUNT_LINE(GHOST_LOGIN)));
  assert.match(step.evidence, /Send invites spento.*nessun invito/);
  assert.ok(!w.ui.sends.includes(GHOST_LOGIN));

  const on = world({ ghostSendOn: true });
  const pressed = byId(await run(on), "u17-refused");
  assert.equal(pressed.verdict, "fallito");
  assert.match(pressed.evidence, /should be Send invites, off/);
  assert.ok(!on.ui.sends.includes(GHOST_LOGIN), "not pressed even so");
});

test("the refused send's line: inline as an alert, and a toast is told apart", () => {
  const inline = `- alert "${REFUSAL.slice(0, 119)}…" [ref=e1]\n  - text: ${REFUSAL}`;
  assert.deepEqual(refusedSend(inline), { line: REFUSAL, toast: false });
  assert.equal(refusedSend(`${inline}\n- status "Couldn't add the member" [ref=e2]\n  - text: Couldn't add the member`).toast, true);
  assert.equal(refusedSend('- status "Couldn\'t add the member" [ref=e2]'), null, "a toast alone isn't the line");
});

test("the start refuses a member who isn't all there, an invitation, and a login that exists", async () => {
  const refused = async (start, more = {}) => {
    const w = world({ start, ...more });
    const [first, launch] = await run(w);
    assert.equal(first.verdict, "fallito");
    assert.equal(launch.verdict, "non verificabile");
    assert.ok(!w.mcp.calls.some(([n]) => n === "app_launch"));
    return first.evidence;
  };
  assert.match(await refused({ onSandbox: false }), /won't start.*collaborator on both.*plyloft-ci-sandbox no/);
  assert.match(await refused({ onTeam: false }), /collaborator on both/);
  assert.match(await refused({ invitedTeam: true }), /invitation is pending/);
  assert.match(await refused({ listed: false }), /team\.json/);
  assert.match(await refused({}, { ghostExists: true }), /exists on GitHub now/);
  assert.match(await checkMembershipStart(world().mcp), /collaboratore su entrambi/);
  await assert.rejects(
    checkMembershipStart({ tool: async () => { throw new Error('unknown query "sandbox_collaborators"'); } }),
    /build-mcp\.sh/,
    "an older MCP says what to do",
  );
  await assert.rejects(checkMembershipStart({ tool: async () => ({ output: { message: "odd" } }) }), /isn't a list|members/, "an odd answer isn't \"not on it\"");
});

test("an unanswered plan is read again, at most twice more", async () => {
  const twice = world({ unresolvedReviews: 2 });
  const passed = await run(twice);
  assert.equal(byId(passed, "reinvite").verdict, "passato", byId(passed, "reinvite").evidence);
  assert.deepEqual(twice.ui.sends, [MEMBER_LOGIN]);
  assert.equal(twice.ui.reviews, 4, "the ghost's, then three of the member's");

  const thrice = world({ unresolvedReviews: 3 });
  const failed = byId(await run(thrice), "reinvite");
  assert.equal(failed.verdict, "fallito");
  assert.match(failed.evidence, /"Add to the team" is off/);
  assert.deepEqual(thrice.ui.sends, []);
  assert.equal(thrice.ui.reviews, 4, "bounded");
});

test("a refused accept still tries the other, and the step says which", async () => {
  const w = world({ acceptThrows: "team" });
  const results = await run(w);
  assert.deepEqual(w.mcp.calls.filter(([n]) => n === "gh_accept_invitation").map(([, a]) => a.repo), ["team", "sandbox"]);
  const step = byId(results, "accept-rejoin");
  assert.equal(step.verdict, "fallito");
  assert.match(step.evidence, /team: NON accettato \(GitHub refused the team one\); sandbox: accettato/);
  assert.equal(w.gh.onSandbox, true, "the other landed");
  assert.equal(verdicts(results)["membership-state"], "fallito");
});

test("any workspace but the sandbox stops the mode before anything is touched", async () => {
  const w = world({ workspaces: ["test-owner/plyloft-ci-sandbox", "test-owner/real-project"] });
  const [first] = await run(w);
  assert.equal(first.verdict, "fallito");
  assert.match(first.evidence, /team\.json lists test-owner\/real-project too/);
  assert.ok(!w.mcp.calls.some(([n]) => n === "app_launch"));
  await assert.rejects(checkMembershipStart(world({ workspaces: "odd" }).mcp), /workspaces isn't a list/);
});

test("a signal after Remove says where the member stands, through a fresh MCP", async () => {
  const lines = [];
  const log = (t) => lines.push(t);
  const closed = [];
  const fresh = (mcp) => async () => ({ tool: mcp.tool, close: () => closed.push(true) });

  await sayWhereMemberIs({ stepCtx: { removePressed: false }, notes: [] }, { openMcp: async () => assert.fail("not opened"), log });
  await sayWhereMemberIs({ notes: [] }, { openMcp: async () => assert.fail("not opened"), log });
  assert.deepEqual(lines, [], "Remove not pressed: nothing to say");

  const out = world({ start: { onTeam: false, onSandbox: false, listed: false } });
  const run1 = { stepCtx: { removePressed: true }, notes: [] };
  await sayWhereMemberIs(run1, { openMcp: fresh(out.mcp), log });
  assert.match(lines[0], /NOT BACK.*plyloft-test-team no.*plyloft-ci-sandbox no/);
  assert.equal(run1.notes.length, 1, "in the report too");
  assert.equal(closed.length, 1);

  const run2 = { stepCtx: { removePressed: true }, notes: [] };
  await sayWhereMemberIs(run2, { openMcp: async () => { throw new Error("no MCP"); }, log });
  assert.match(lines[1], /can't say where .* stands \(no MCP\)\. Check both repositories by hand/);

  await sayWhereMemberIs({ stepCtx: { removePressed: true }, notes: [] }, { openMcp: () => new Promise(() => {}), log, timeoutMs: 5 });
  assert.match(lines[2], /can't say where.*timed out/);
});

test("the only tools it writes with are the app's presses and the two accepts; no agent", async () => {
  const w = world();
  await run(w);
  const reads = new Set(["gh_read", "ui_snapshot", "ui_wait_for", "app_state", "app_status"]);
  const writes = new Set(w.mcp.calls.map(([n]) => n).filter((n) => !reads.has(n)));
  assert.deepEqual([...writes].sort(), ["app_dev_team_plan", "app_launch", "app_quit", "gh_accept_invitation", "ui_click", "ui_type"]);
  const source = readRepoFile(ROOT, "scripts/app-tester/team-walk/membership.mjs");
  assert.ok(!/child_process|execFile|spawn\(/.test(source), "no gh of its own");
  assert.ok(!/claude|codex|Start build/i.test(source), "no agent");
});

test("the words the mode reads, as the app draws them", () => {
  const tree = [
    "- text: · ·",
    "- text: Cards come from the GitHub issues of",
    '- button "o/r, open its issues on GitHub" [ref=e1]',
    "- text: reading…",
    '- button "Get new issues" [ref=e2] (disabled)',
  ].join("\n");
  assert.deepEqual(boardLine(tree), { line: "Cards come from the GitHub issues of o/r · reading… · Get new issues", read: "reading…", busy: true });
  assert.equal(boardLine('- button "Get new issues" [ref=e2]'), null);
  assert.equal(removalLine(`- text: ${RESULT}`), RESULT);
  assert.equal(removalLine(`- text: ${MEMBER_LOGIN} removed from the team`), null, "a toast's title");
  assert.equal(removalLine(`- text: ${MEMBER_LOGIN} is still in the team. Not done on: x.`), `${MEMBER_LOGIN} is still in the team. Not done on: x.`);
});

test("claims agree with the sheet, or it's said what doesn't", () => {
  const c = (over) => claimsProblem({ onSandbox: false, issueAssignees: [], cardAssignees: [], row: "T Ready to start", ...over });
  assert.equal(c({}), null);
  assert.match(c({ row: "T On hold" }), /issue is free but/);
  assert.match(c({ issueAssignees: [MEMBER_LOGIN], cardAssignees: [MEMBER_LOGIN] }), /sheet says it takes them off/);
  assert.match(c({ cardAssignees: [MEMBER_LOGIN] }), /disagree/);
  const kept = { onSandbox: true, issueAssignees: [MEMBER_LOGIN], cardAssignees: [MEMBER_LOGIN] };
  assert.equal(c({ ...kept, row: `T Claimed by ${MEMBER_LOGIN}` }), null, "access kept, nothing promised");
  assert.match(c({ ...kept, row: "T Ready to start" }), /has them but/);
});

test("the statement names both repositories and what's missing", () => {
  const out = membershipStatement({ onTeam: true, onSandbox: false, invitedTeam: false, invitedSandbox: true, listed: true });
  assert.match(out, /plyloft-test-team yes, on test-owner\/plyloft-ci-sandbox no/);
  assert.match(out, /Missing: accepting the sandbox's invitation/);
  assert.match(membershipStatement({ onTeam: true, onSandbox: true, listed: true }), /Nothing missing/);
});

// What opens the gate, read where it lives: without it the running build reports
// nothing and Remove isn't pressed (the test above); this names what broke.
test("the way-back gate opens because of this code", () => {
  const gate = '#[cfg(all(feature = "test-bridge", debug_assertions))]';
  const commands = readRepoFile(ROOT, "src-tauri/src/commands.rs");
  const take = commands.split("fn take_seat(")[1];
  assert.ok(take.includes(`${gate}\n    if account.dev_plan_has_no_seats_at(`) && take.indexOf("dev_plan_has_no_seats_at") < take.indexOf("seat_put("), "take_seat skips the seat first, gated");
  assert.ok(commands.split("pub async fn team_member_remove(")[1].includes(`${gate}\n                if account.dev_plan_has_no_seats_at(`), "Remove's free, gated");
  const account = readRepoFile(ROOT, "src-tauri/src/account.rs");
  assert.ok(account.includes('#[cfg(all(debug_assertions, any(test, feature = "test-bridge")))]\n    pub fn dev_plan_has_no_seats_at('));
  assert.ok(readRepoFile(ROOT, "src-tauri/src/test_bridge.rs").includes('"devPlanHasNoSeats": store.dev_plan_has_no_seats_at(now)'));
  assert.match(readRepoFile(ROOT, "scripts/app-tester/team-walk/membership.mjs"), /account\?\.devPlanHasNoSeats === true/);
  assert.match(readRepoFile(ROOT, "tools/ply-test-mcp/src/server.rs"), /fn app_dev_team_plan[\s\S]*signInSkipped/, "the mode's plan is a dev plan");
});

test("the ghost login is one word in the runner and the MCP, and the app's form takes it", () => {
  assert.ok(readRepoFile(ROOT, "tools/ply-test-mcp/src/readers.rs").includes(`NO_SUCH_LOGIN: &str = "${GHOST_LOGIN}"`));
  assert.match(GHOST_LOGIN, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(GHOST_LOGIN.length <= 39);
});

test("a read asks again after GitHub's passing trouble, and only then", async () => {
  const answers = (...list) => {
    let calls = 0;
    return {
      calls: () => calls,
      tool: async () => {
        calls += 1;
        const next = list.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    };
  };
  const blip = new Error("gh: No server is currently available to service your request.");
  const fast = { waitMs: 0 };
  await assert.rejects(read(answers(blip, blip, blip, blip), "q", fast), /No server/);
  const refused = answers(new Error("gh: Not Found (HTTP 404)"));
  await assert.rejects(read(refused, "q", fast), /404/);
  assert.equal(refused.calls(), 1, "a real answer isn't asked again");
  const passing = answers(blip, new Error("not json, so the blip is over"));
  await assert.rejects(read(passing, "q", fast), /blip is over/);
  assert.equal(passing.calls(), 2);
});
