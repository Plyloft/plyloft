// The team walk's steps, with no process of their own: `ctx.mcp.tool` does all
// the work, so a fake MCP can run them (lib.test.mjs). What the first walk
// covered (~/ply-build/app-walks/2026-11-02-161936-…): launch both, plan, join,
// the board on GitHub Issues, a card in area Site, the member sees and claims
// it, the owner sees the claim, delete, the member's card closed, quit, orphan
// check. Two modes, and only one measures the board's own follow:
// - default: the member opens Settings › General, which re-reads the project,
//   and the Board step after it shows the result of that read;
//   Its member-sees presses Get new issues, so it says nothing of the Board's read.
// - unattended: the member stays on the Board pressing nothing, and the step's
//   duration is how long the board took to follow (up to the ten-minute read);
//   its member-sees waits for the Board's own read: the one measure of that cadence.
// A third, --membership, runs as default up to the claim, then membership.mjs.
import { checkMembershipStart, membershipSteps, toBoard } from "./membership.mjs";
import { cardTitle, findControl, ghOutput, isScenarioIssue, MEMBER_LOGIN, OWNER_LOGIN, parseTree, poll, SANDBOX_REPO } from "./lib.mjs";
import { JOIN_SHEET_TITLE, JOIN_THE_TEAM, PROJECT, word } from "./strings.mjs";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** member-sees, outside --unattended: how long a pressed read may take. */
const PRESSED_READ_MS = 2 * MINUTE;

/** The row Settings › General draws for a board on GitHub Issues, in its own
 *  case and with the sandbox's name, which no other copy on screen has. */
export const ISSUES_ROW = `${word("onIssues")} · ${SANDBOX_REPO}`;
export const hasIssuesRow = (tree) => parseTree(tree).some((n) => n.name.includes(ISSUES_ROW));

async function waitForIssuesRow(who, timeoutMs) {
  await poll(async () => hasIssuesRow(await who.snapshot(ISSUES_ROW)), { timeoutMs, what: `the row "${ISSUES_ROW}"` });
}

/**
 * How the member's board shows a card whose issue was closed, or null: this
 * card's own row has the word, or the board has it in Complete (github_sync.rs).
 * A title that isn't on screen proves nothing, nor do the snapshot's `focused:`
 * and `open dialogs:` lines, which aren't controls: a card can be scrolled off,
 * or the tree truncated.
 */
export function closedEvidence({ tree, title, card }) {
  const row = parseTree(tree).find((n) => n.role === "button" && n.name.includes(title));
  if (row && new RegExp(`\\b${word("closedWord")}\\b`).test(row.name)) return `riga: "${row.name}"`;
  if (card?.columnId === "complete") return `card #${card.ghIssueNumber} in Complete`;
  return null;
}

/** The start a walk needs: also checked before `--fresh` wipes anything. */
export async function checkStartState(mcp, { membership = false } = {}) {
  const def = ghOutput(await mcp.tool("gh_read", { query: "sandbox_definition" }));
  if (def.board !== "local") throw new Error(`the sandbox's board is ${def.board}: run scripts/app-tester/team-walk/cleanup.mjs first`);
  const open = ghOutput(await mcp.tool("gh_read", { query: "issue_list_open" })).filter(isScenarioIssue);
  if (open.length) throw new Error(`open issues from an earlier run: ${open.map((i) => `#${i.number}`).join(", ")}: cleanup.mjs first`);
  const start = "board local, nessun issue dello scenario aperto";
  return membership ? `${start}; ${await checkMembershipStart(mcp)}` : start;
}

/** What one instance does, always naming itself (the MCP requires it). */
export function person(mcp, instance) {
  const tool = (name, args = {}) => mcp.tool(name, { ...args, instance });
  const self = {
    instance,
    snapshot: async (filter) => {
      const text = await tool("ui_snapshot", filter ? { filter } : {});
      return typeof text === "string" ? text : JSON.stringify(text);
    },
    click: (name, role = "button") => tool("ui_click", { name, role }),
    clickIn: async (within, name, role = "button") => {
      const found = findControl(await self.snapshot(), { name, role, within });
      if (!found) throw new Error(`no ${role} "${name}" in the open ${within}`);
      return tool("ui_click", { ref: found.ref });
    },
    clickRef: (ref) => tool("ui_click", { ref }),
    clickTitled: async (title) => {
      const found = findControl(await self.snapshot(title), { name: title, role: "button" });
      if (!found) throw new Error(`no button named "${title}" on the ${instance}'s screen`);
      return tool("ui_click", { ref: found.ref });
    },
    waitText: (text, timeoutMs = 20 * SECOND, gone = false) => tool("ui_wait_for", { text, timeout_ms: timeoutMs, gone }),
    waitControl: (name, role = "button", timeoutMs = 20 * SECOND) => tool("ui_wait_for", { name, role, timeout_ms: timeoutMs }),
    state: (kind, extra = {}) => tool("app_state", { kind, ...extra }),
  };
  return self;
}

/** A card's Claim sits in Details › Technical, which may already be open, and
 *  pressing an open one would close it: open them only when Claim isn't there.
 *  The card page's own Details is the last one on the screen. */
async function pressClaim(who) {
  // Exactly: "Claim it too" must never pass for it.
  const claim = async () => findControl(await who.snapshot(), { name: word("claim"), role: "button", exact: true });
  let found = await claim();
  if (!found) {
    const refs = [...(await who.snapshot()).matchAll(new RegExp(`button "${word("details")}" \\[ref=(e\\d+)\\]`, "g"))];
    if (refs.length) await who.clickRef(refs[refs.length - 1][1]);
    found = await claim();
  }
  if (!found) {
    await who.click(word("technical"));
    await who.waitControl(word("claim"), "button", 15 * SECOND);
    found = await claim();
  }
  if (!found) throw new Error("no Claim on the card");
  return who.clickRef(found.ref);
}

/**
 * How the team step gets into Setup's list since 1.175.0 (F2): there is no
 * "Solo or team" step any more. The mode is deduced (`setupSteps.ts::
 * deduceWorkMode`); the walk's Team plan (step "plan") makes it team and
 * `deductionSaves` saves it, so "Your team" is already listed. While the
 * deduction says solo — not read yet, or a build that reads the plan later —
 * "Joining a team? Add the team step" sits under the checklist instead, and
 * its press opens the question. `listed`, `link`, or null while neither shows.
 */
export function teamStepRoute(tree) {
  if (findControl(tree, { name: word("addTeamStep"), role: "button", exact: true })) return "link";
  // Not "Your team needs GitHub." (the GitHub step's sentence, `githubStep.ts`).
  const listed = parseTree(tree).some(
    (n) => n.name === word("yourTeam") || (n.name.startsWith(`${word("yourTeam")} `) && !n.name.startsWith(`${word("yourTeam")} needs`)),
  );
  return listed ? "listed" : null;
}

/**
 * Setup on a fresh profile as far as the team's project, without the "Your AI"
 * step: the checklist (`I use them regularly`) doesn't mount that step, and
 * opening it would run the two status checks. With the team step not listed
 * yet, Add the team step › With a team › Continue puts it there (Continue on
 * the fast path's question goes back to the checklist, `onwardIn`). Back on
 * step by step, the list has Your team to press.
 */
async function joinAndGetProject(who) {
  await who.waitText(word("welcomeTitle"), 30 * SECOND);
  await who.click(word("useRegularly"), "radio");
  await who.click(word("cont"));
  await who.waitText(word("essentials"));
  const route = await poll(async () => teamStepRoute(await who.snapshot()), {
    timeoutMs: 45 * SECOND,
    what: `"${word("yourTeam")}" in the checklist, or "${word("addTeamStep")}" under it`,
  });
  if (route === "link") {
    await who.click(word("addTeamStep"));
    await who.waitControl(word("withTeam"), "radio", 15 * SECOND);
    await who.click(word("withTeam"), "radio");
    await who.click(word("cont"));
    await who.waitText(word("essentials"));
  }
  await who.click(word("stepByStep"));
  await who.waitControl(word("yourTeam"));
  await who.click(word("yourTeam"));
  await who.waitControl(word("joinTeam"), "radio", 30 * SECOND);
  await who.click(word("joinTeam"), "radio");
  await who.waitControl(JOIN_THE_TEAM, "button", 45 * SECOND);
  await who.click(JOIN_THE_TEAM);
  await who.waitText(JOIN_SHEET_TITLE, 30 * SECOND);
  await who.clickIn("dialog", word("join"));
  await who.waitControl(PROJECT, "checkbox", 60 * SECOND);
  // The team's only project starts ticked: a press would untick it.
  const box = findControl(await who.snapshot(PROJECT), { name: PROJECT, role: "checkbox" });
  if (!box?.states.includes("checked") || box.states.includes("unchecked")) await who.click(PROJECT, "checkbox");
  await who.click(word("getOne"));
  await who.waitText(word("added"), 2 * MINUTE);
  await who.click(word("closeSetup"));
  const profile = await who.state("profile");
  const list = await who.state("workspaces");
  const expected = `${profile.configDir}/team-clones/${PROJECT}`;
  const workspace = (list?.workspaces ?? []).find((w) => w.cwd === expected);
  if (!workspace) throw new Error(`no workspace at ${expected}; has: ${(list?.workspaces ?? []).map((w) => w.cwd).join(", ")}`);
  if (list.activeWorkspaceId !== workspace.id) throw new Error(`the project isn't the active one (${list.activeWorkspaceId})`);
  return workspace;
}

export const isOpenWithTitle = (issue, title) => issue.title === title && issue.state === "OPEN";

export const modeName = (unattended, membership = false) =>
  membership ? "membership (U17, U14, rimozione e rientro del membro)" : unattended ? "unattended (misura il follow del board)" : "default (Settings rilegge il progetto)";

export function buildSteps({ stamp, unattended = false, boardWaitMs = 11 * MINUTE, syncWaitMs = 5 * MINUTE, membership = false, memberMayStayOut = false, claimsWaitMs, settleMs, backWaitMs, repressMs = 20 * SECOND, pressLookMs = 2 * SECOND }) {
  const title = cardTitle(stamp);
  const definition = async (mcp) => ghOutput(await mcp.tool("gh_read", { query: "sandbox_definition" }));
  const issues = async (mcp) => ghOutput(await mcp.tool("gh_read", { query: "issue_list" }));
  const issue = async (mcp, number) => ghOutput(await mcp.tool("gh_read", { query: "issue_view", number }));
  const cardFor = (ctx) => person(ctx.mcp, "owner");
  const memberOf = (ctx) => person(ctx.mcp, "member");
  const cards = async (who, workspaceId) => {
    const state = await who.state("board", { workspace: workspaceId });
    return Array.isArray(state) ? state : (state?.cards ?? []);
  };

  return [
    {
      id: "start-state",
      title: "Stato iniziale: board del sandbox locale, nessun issue aperto dello scenario",
      expected: "`board: local` e nessun issue aperto con il prefisso (altrimenti cleanup.mjs)",
      instance: "owner",
      timeoutMs: MINUTE,
      run: ({ mcp }) => checkStartState(mcp, { membership }),
    },
    {
      id: "launch",
      title: "Owner e member: avvio",
      expected: "Partono entrambi con i controlli di identità della MCP",
      instance: "both",
      needs: ["start-state"],
      timeoutMs: 4 * MINUTE,
      run: async ({ mcp }) => {
        const owner = await mcp.tool("app_launch", { instance: "owner" });
        const member = await mcp.tool("app_launch", { instance: "member" });
        for (const [who, id, got] of [["owner", "com.mbadv.ply.test", owner], ["member", "com.mbadv.ply.test2", member]]) {
          if (got.info?.identifier !== id) throw new Error(`${who} answers as ${got.info?.identifier}`);
        }
        return `owner pid ${owner.info.pid}, member pid ${member.info.pid}`;
      },
    },
    {
      id: "plan",
      title: "Owner e member: piano Team con la chiave di sviluppo",
      expected: "plan team, ruolo owner e member, login giusti",
      instance: "both",
      needs: ["launch"],
      timeoutMs: MINUTE,
      run: async ({ mcp }) => {
        const owner = await mcp.tool("app_dev_team_plan", { instance: "owner" });
        const member = await mcp.tool("app_dev_team_plan", { instance: "member" });
        const bad = (got, role, login) => got.plan !== "team" || got.teamRole !== role || got.login !== login;
        if (bad(owner, "owner", OWNER_LOGIN) || bad(member, "member", MEMBER_LOGIN)) {
          throw new Error(`plans: ${JSON.stringify({ owner, member })}`);
        }
        return `owner ${owner.login}/${owner.teamRole}, member ${member.login}/${member.teamRole}`;
      },
    },
    {
      id: "join-owner",
      title: "Owner: Setup › Your team (dedotto dal piano Team, o Add the team step › With a team) › Join, poi il progetto del team",
      expected: "Nessun passo Solo or team né Where your projects live; il progetto si apre sotto team-clones del profilo owner",
      instance: "owner",
      needs: ["plan"],
      timeoutMs: 6 * MINUTE,
      run: async (ctx) => {
        ctx.ownerWorkspace = await joinAndGetProject(cardFor(ctx));
        return ctx.ownerWorkspace.cwd;
      },
    },
    {
      id: "join-member",
      title: "Member: Setup › Your team (dedotto dal piano Team, o Add the team step › With a team) › Join, poi il progetto del team",
      expected: "Nessun passo Solo or team né Where your projects live; il progetto si apre sotto team-clones del profilo member, cartella diversa da quella dell'owner",
      instance: "member",
      needs: ["plan"],
      timeoutMs: 6 * MINUTE,
      run: async (ctx) => {
        ctx.memberWorkspace = await joinAndGetProject(memberOf(ctx));
        if (ctx.memberWorkspace.cwd === ctx.ownerWorkspace?.cwd) throw new Error(`both use ${ctx.memberWorkspace.cwd}`);
        return ctx.memberWorkspace.cwd;
      },
    },
    ...(unattended
      ? [
          {
            id: "member-on-board",
            title: "Member: va sul Board prima dello spostamento",
            expected: "Da qui il member non preme più nulla fino alla riga degli issue",
            instance: "member",
            needs: ["join-member"],
            timeoutMs: MINUTE,
            run: async (ctx) => {
              await memberOf(ctx).click(word("board"));
              return "sul Board";
            },
          },
        ]
      : [
          {
            id: "member-on-general",
            title: "Member: resta su Settings › General prima dello spostamento",
            expected: "Da qui il member non preme più nulla fino alla riga degli issue",
            instance: "member",
            needs: ["join-member"],
            timeoutMs: MINUTE,
            run: async (ctx) => {
              const member = memberOf(ctx);
              await member.click(word("settings"));
              await member.click(word("general"));
              return "su General";
            },
          },
        ]),
    {
      id: "move-board",
      title: "Owner: Settings › General › Move to GitHub Issues, con conferma",
      expected: "La riga dice On GitHub Issues e .atelier/workspace.json su main ha board githubIssues",
      instance: "owner",
      needs: ["join-owner"],
      timeoutMs: 3 * MINUTE,
      run: async (ctx) => {
        const owner = cardFor(ctx);
        await owner.click(word("settings"));
        await owner.click(word("general"));
        await owner.waitControl(word("moveBoard"), "button", 30 * SECOND);
        await owner.click(word("moveBoard"));
        // Move reads the project before it asks, so the sheet comes a little later.
        const started = Date.now();
        const confirm = await poll(
          async () => findControl(await owner.snapshot(), { name: word("moveBoard"), role: "button", within: "dialog" }),
          { timeoutMs: 30 * SECOND, what: "the sheet that asks to move the board" },
        );
        ctx.moveSheetMs = Date.now() - started;
        await owner.clickRef(confirm.ref);
        await waitForIssuesRow(owner, 90 * SECOND);
        // The row changes before the publish reaches GitHub.
        await poll(async () => (await definition(ctx.mcp)).board === "githubIssues", {
          timeoutMs: 90 * SECOND,
          what: "board githubIssues on main",
        });
        await owner.click(word("closeSettings"));
        await owner.click(word("board"));
        return `board githubIssues su main; il foglio è arrivato in ${(ctx.moveSheetMs / 1000).toFixed(1)} s`;
      },
    },
    ...(unattended
      ? [
          {
            id: "member-board-follows",
            title: "Member: il board segue lo spostamento senza premere nulla",
            expected: "Compare la riga degli issue; la durata di questo passo è il dato (solo in questa modalità)",
            instance: "member",
            needs: ["member-on-board", "move-board"],
            timeoutMs: boardWaitMs + MINUTE,
            run: async (ctx) => {
              await memberOf(ctx).waitText(word("issuesLine"), boardWaitMs);
              return `riga vista senza premere nulla: "${word("issuesLine")}"`;
            },
          },
        ]
      : [
          {
            id: "member-settings-reads",
            title: "Member: General è rimasta aperta, il progetto si rilegge da solo",
            expected: `La riga dice "${ISSUES_ROW}" entro 90 secondi, senza ${word("moveBoard")}`,
            instance: "member",
            needs: ["member-on-general", "move-board"],
            timeoutMs: 2 * MINUTE,
            run: async (ctx) => {
              const member = memberOf(ctx);
              await waitForIssuesRow(member, 90 * SECOND);
              if (findControl(await member.snapshot(), { name: word("moveBoard"), role: "button" })) {
                throw new Error(`"${word("moveBoard")}" is still offered`);
              }
              await member.click(word("closeSettings"));
              return `"${ISSUES_ROW}", senza ${word("moveBoard")}`;
            },
          },
          {
            id: "member-board-after-read",
            title: "Member: il Board dopo la lettura di Settings",
            expected: "Compare la riga degli issue. Non misura il follow del board: lo fa --unattended",
            instance: "member",
            needs: ["member-settings-reads"],
            timeoutMs: 2 * MINUTE,
            run: async (ctx) => {
              const member = memberOf(ctx);
              await member.click(word("board"));
              await member.waitText(word("issuesLine"), MINUTE);
              return `riga vista dopo la lettura: "${word("issuesLine")}"`;
            },
          },
        ]),
    {
      id: "create-card",
      title: "Owner: New card con titolo a prefisso, Area Site",
      expected: "Issue aperto con quel titolo e label area:site",
      instance: "owner",
      needs: ["move-board"],
      timeoutMs: 2 * MINUTE,
      run: async (ctx) => {
        const owner = cardFor(ctx);
        await owner.click(word("newCard"));
        await ctx.mcp.tool("ui_type", { instance: "owner", name: word("area"), text: "site" });
        await ctx.mcp.tool("ui_type", { instance: "owner", name: word("newCardTitle"), text: title, submit: true });
        const found = await poll(async () => (await issues(ctx.mcp)).find((i) => isOpenWithTitle(i, title)), {
          timeoutMs: 60 * SECOND,
          what: `an open issue titled ${title}`,
        });
        ctx.number = found.number;
        // The app adds the label just after it creates the issue.
        await poll(
          async () =>
            (await issues(ctx.mcp)).find((i) => i.number === found.number)?.labels?.some((l) => l.name === "area:site"),
          { timeoutMs: 60 * SECOND, what: `label area:site on #${found.number}` },
        );
        return `issue #${found.number}, label area:site`;
      },
    },
    {
      id: "member-sees",
      ...(unattended
        ? {
            title: "Member: la card compare senza premere nulla",
            expected: "Titolo sul Board del member; la durata di questo passo è la lettura del Board (solo in questa modalità)",
            timeoutMs: syncWaitMs + MINUTE,
          }
        : {
            title: `Member: ${word("getNewIssues")}, la card compare`,
            expected: "Titolo sul Board del member dopo la pressione. Non misura la lettura del Board: lo fa --unattended",
            timeoutMs: PRESSED_READ_MS + MINUTE,
          }),
      instance: "member",
      needs: ["create-card", unattended ? "member-board-follows" : "member-board-after-read"],
      run: async (ctx) => {
        const member = memberOf(ctx);
        const seen = async () => (await cards(member, ctx.memberWorkspace.id)).some((c) => c.ghIssueNumber === ctx.number);
        const what = `card #${ctx.number} on the member's board`;
        let presses = 0;
        if (unattended) {
          await poll(seen, { timeoutMs: syncWaitMs, what });
        } else {
          await member.waitControl(word("getNewIssues"), "button", 30 * SECOND);
          // A read already running had its list before the issue existed, so
          // the press waits for it, and comes again if the card still isn't there.
          let pressedAt = -Infinity;
          await poll(
            async () => {
              if (Date.now() - pressedAt >= repressMs) {
                const button = findControl(await member.snapshot(word("getNewIssues")), { name: word("getNewIssues"), role: "button", exact: true });
                if (button && !button.states.includes("disabled")) {
                  await member.clickRef(button.ref);
                  presses += 1;
                  pressedAt = Date.now();
                }
              }
              return presses > 0 && seen();
            },
            { timeoutMs: PRESSED_READ_MS, everyMs: pressLookMs, what },
          );
        }
        await member.waitControl(title, "button", 30 * SECOND);
        return `#${ctx.number} "${title}" sul Board del member${unattended ? "" : `, ${word("getNewIssues")} premuto (pressioni: ${presses})`}`;
      },
    },
    {
      id: "member-claims",
      title: "Member: card › Details › Technical › Claim",
      expected: "issue_view ha assignee il member",
      instance: "member",
      needs: ["member-sees"],
      timeoutMs: 2 * MINUTE,
      run: async (ctx) => {
        const member = memberOf(ctx);
        await member.clickTitled(title);
        await pressClaim(member);
        const seen = await poll(
          async () => {
            const got = await issue(ctx.mcp, ctx.number);
            return got.assignees?.some((a) => a.login === MEMBER_LOGIN) ? got : null;
          },
          { timeoutMs: 45 * SECOND, what: `#${ctx.number} assigned to ${MEMBER_LOGIN}` },
        );
        return `#${seen.number} assignees: ${seen.assignees.map((a) => a.login).join(", ")}`;
      },
    },
    {
      id: "owner-sees-claim",
      title: "Owner: vede la card presa dal member",
      expected: `Sul Board "${word("claimedBy")} ${MEMBER_LOGIN}"; la durata di questo passo è il dato`,
      instance: "owner",
      needs: ["member-claims"],
      timeoutMs: syncWaitMs + MINUTE,
      run: async (ctx) => {
        // This card's own row: an older closed card can carry the same words.
        const owner = cardFor(ctx);
        const words = `${word("claimedBy")} ${MEMBER_LOGIN}`;
        const row = await poll(
          async () => {
            const card = (await cards(owner, ctx.ownerWorkspace.id)).find((c) => c.ghIssueNumber === ctx.number);
            if (!card?.ghAssignees?.includes(MEMBER_LOGIN)) return null;
            const found = findControl(await owner.snapshot(title), { name: title, role: "button" });
            return found?.name.includes(words) ? found.name : null;
          },
          { timeoutMs: syncWaitMs, what: `"${words}" on card #${ctx.number}` },
        );
        return `"${row}"`;
      },
    },
    ...(membership ? membershipSteps({ title, ownerOf: cardFor, memberOf, cards, issue, memberMayStayOut, claimsWaitMs, settleMs, backWaitMs }) : []),
    {
      id: "delete",
      title: "Owner: card › Delete card… › Close issue & delete",
      expected: "Issue chiuso e card sparita dal Board dell'owner",
      instance: "owner",
      needs: ["create-card"],
      timeoutMs: 2 * MINUTE,
      run: async (ctx) => {
        const owner = cardFor(ctx);
        await owner.clickTitled(title);
        await owner.click(word("moreForCard"));
        await owner.click(word("deleteCard"), "menuitem");
        await owner.clickIn("dialog", word("closeAndDelete"));
        await poll(async () => (await issue(ctx.mcp, ctx.number)).state === "CLOSED", {
          timeoutMs: 45 * SECOND,
          what: `#${ctx.number} closed`,
        });
        await poll(async () => !(await cards(owner, ctx.ownerWorkspace.id)).some((c) => c.ghIssueNumber === ctx.number), {
          timeoutMs: 30 * SECOND,
          what: `no card #${ctx.number} on the owner's board`,
        });
        return `#${ctx.number} chiuso, card sparita dal Board dell'owner`;
      },
    },
    {
      id: "member-after-delete",
      title: "Member: Board, Get new issues",
      expected: `La riga della card dice ${word("closedWord")}, o il board la tiene in Complete, a lettura finita (github_sync.rs)`,
      instance: "member",
      needs: ["delete", "member-sees", ...(membership ? ["accept-rejoin"] : [])],
      timeoutMs: 3 * MINUTE,
      run: async (ctx) => {
        const member = memberOf(ctx);
        await toBoard(member);
        await member.waitControl(word("getNewIssues"), "button", 30 * SECOND);
        await member.click(word("getNewIssues"));
        const line = await poll(
          async () => {
            // While the read runs the button is disabled and the card still old.
            const button = findControl(await member.snapshot(word("getNewIssues")), { name: word("getNewIssues"), role: "button", exact: true });
            if (!button || button.states.includes("disabled")) return null;
            const card = (await cards(member, ctx.memberWorkspace.id)).find((c) => c.ghIssueNumber === ctx.number);
            return closedEvidence({ tree: await member.snapshot(title), title, card });
          },
          { timeoutMs: 2 * MINUTE, what: `card #${ctx.number} closed on the member's board` },
        );
        return `Board del member: ${line}`;
      },
    },
    {
      id: "quit",
      title: "app_quit di member e owner",
      expected: "orphans [] per entrambi",
      instance: "both",
      always: true,
      timeoutMs: 2 * MINUTE,
      run: async ({ mcp, onOrphans }) => {
        const out = [];
        const problems = [];
        for (const instance of ["member", "owner"]) {
          const status = await mcp.tool("app_status", { instance });
          if (status.running === false) {
            // An app that doesn't answer isn't a closed one.
            if (/is not running/.test(status.why ?? "")) out.push(`${instance}: non era aperta`);
            else problems.push(`${instance} doesn't answer: ${status.why}`);
            continue;
          }
          try {
            const quit = await mcp.tool("app_quit", { instance });
            out.push(`${instance}: orphans ${JSON.stringify(quit.orphans)}`);
            if (quit.orphans?.length) {
              onOrphans?.(instance, quit.orphans);
              problems.push(`${instance} left ${JSON.stringify(quit.orphans)}`);
            }
          } catch (error) {
            problems.push(`${instance}: ${error.message}`);
          }
        }
        if (problems.length) throw new Error(problems.join("; "));
        return out.join("; ");
      },
    },
  ];
}
