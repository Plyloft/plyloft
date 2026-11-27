// `run.mjs --membership`: what a person used to check by hand on two instances
// (owner's approval, 2026-11-03, on the sandbox and the test team only). After
// the usual claim: a login GitHub doesn't know (U17), the Remove sheet's words
// and what removal does (U14), the member's Board after it (U21), the invitation
// back and their way in again.
//
// Writes on GitHub come only from the app's presses and the MCP's
// `gh_accept_invitation`; here `gh_read` looks. Once Remove has been pressed the
// way back is tried whatever failed in between, and the last step says plainly
// where the member stands, in the runner's report and on stderr.
//
// What the code says removal does: `team_admin.rs::remove_member_with` revokes
// on `team_repos`, the team repository and every workspace `team.json` lists, so
// the sandbox too, and the manifest only once all of them succeeded. The app
// never unassigns anyone; whether an issue loses its assignee is GitHub's doing
// (`teamAdmin.ts::removalClaimsNote`), so it's read here, not assumed.
import { findControl, ghOutput, GHOST_LOGIN, inside, MEMBER_LOGIN, parseTree, poll, SANDBOX_REPO, TEAM_REPO, Unverifiable } from "./lib.mjs";
import { INVITE_PLAN_TITLE, MORE_FOR, NO_ACCOUNT_LINE, REMOVAL_CLAIMS_NOTE, REMOVAL_NORMAL, REMOVAL_RESULTS, REPO_BUTTON_TAIL, word } from "./strings.mjs";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/** GitHub's own passing trouble. A read is safe to ask again, and after Remove a
 *  blip must not read as "we don't know where the member stands". */
const GITHUB_BLIP = /no server is currently available|HTTP 50[0234]|i\/o timeout|TLS handshake timeout|connection reset/i;

export async function read(mcp, query, { tries = 4, waitMs = 5 * SECOND } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return ghOutput(await mcp.tool("gh_read", { query }));
    } catch (error) {
      if (/unknown query/.test(error.message)) {
        throw new Error(`${error.message}: this MCP is older than --membership, rebuild it with scripts/app-tester/build-mcp.sh`);
      }
      if (attempt >= tries || !GITHUB_BLIP.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** A list, or nothing is known: an odd answer is never read as "not on it". */
function listOf(answer, what) {
  if (!Array.isArray(answer)) throw new Error(`${what} isn't a list: ${JSON.stringify(answer)}`);
  return answer;
}

/** What `team.json` lists besides the sandbox. Remove and Send invites act on
 *  every workspace it lists, and this mode is approved for the sandbox only. */
export function otherWorkspaces(manifest) {
  return listOf(manifest?.workspaces, "team.json's workspaces").map((w) => w.repo).filter((repo) => !same(repo, SANDBOX_REPO));
}

/** Where the member stands on both repositories, as GitHub says now. */
export async function memberState(mcp, login = MEMBER_LOGIN) {
  const on = async (query) => listOf(await read(mcp, query), query).some((c) => same(c.login, login));
  const invited = async (query) => listOf(await read(mcp, query), query).some((i) => same(i.invitee, login) && !i.expired);
  const manifest = await read(mcp, "team_manifest");
  return {
    otherWorkspaces: otherWorkspaces(manifest),
    onTeam: await on("team_collaborators"),
    onSandbox: await on("sandbox_collaborators"),
    invitedTeam: await invited("team_invitations"),
    invitedSandbox: await invited("sandbox_invitations"),
    listed: listOf(manifest?.members, "team.json's members").some((m) => same(m.login, login)),
  };
}

export const memberIsIn = (s) => s.onTeam && s.onSandbox && s.listed;

/** Which of the two repositories the member is on and what's missing. */
export function membershipStatement(s, login = MEMBER_LOGIN) {
  const yes = (v) => (v ? "yes" : "no");
  const facts = `${login}: collaborator on ${TEAM_REPO} ${yes(s.onTeam)}, on ${SANDBOX_REPO} ${yes(s.onSandbox)}; in team.json ${yes(s.listed)}; invitation pending on the team ${yes(s.invitedTeam)}, on the sandbox ${yes(s.invitedSandbox)}.`;
  if (memberIsIn(s)) return `${facts} Nothing missing.`;
  const missing = [
    ...(s.onTeam ? [] : [s.invitedTeam ? "accepting the team's invitation" : `access to ${TEAM_REPO}`]),
    ...(s.onSandbox ? [] : [s.invitedSandbox ? "accepting the sandbox's invitation" : `access to ${SANDBOX_REPO}`]),
    ...(s.listed ? [] : ["their line in team.json"]),
  ];
  return `THE MEMBER IS NOT BACK. ${facts} Missing: ${missing.join("; ")}. A person has to put that right: Plyloft signed in as the owner (Send invites needs a real server session), or by hand on GitHub. The next --membership refuses to start until then.`;
}

/** The login U17 types must not be anybody. Its 404 is the good answer. */
export async function assertGhostMissing(mcp, login = GHOST_LOGIN) {
  try {
    await read(mcp, "team_no_such_user");
  } catch (error) {
    if (/HTTP 404/.test(error.message)) return;
    throw error;
  }
  throw new Error(`${login} exists on GitHub now, and U17 would type it: stopped. Choose another (GHOST_LOGIN in lib.mjs, NO_SUCH_LOGIN in the MCP's readers.rs)`);
}

/** This mode's start: everything it takes away must be there to begin with. */
export async function checkMembershipStart(mcp) {
  const s = await memberState(mcp);
  const problems = [];
  if (s.invitedTeam || s.invitedSandbox) problems.push("an invitation is pending: accept it (gh_accept_invitation during a walk, or on GitHub as the member)");
  if (!s.onTeam || !s.onSandbox) problems.push("they must be a collaborator on both repositories: a person puts them back first");
  if (!s.listed) problems.push("team.json doesn't list them: a person puts that back first");
  if (s.otherWorkspaces.length) problems.push(`team.json lists ${s.otherWorkspaces.join(", ")} too, and Remove and Send invites would act on it: only ${SANDBOX_REPO} may be there`);
  if (problems.length) throw new Error(`--membership won't start. ${problems.join("; ")}. Now: ${membershipStatement(s)}`);
  await assertGhostMissing(mcp);
  return `${MEMBER_LOGIN} collaboratore su entrambi, nessun invito; ${GHOST_LOGIN} non esiste`;
}

/** On a card's page the sidebar's Board does nothing (it reads current=page);
 *  the way back is the breadcrumb's, the last button with that name. */
export async function toBoard(who) {
  const found = [...(await who.snapshot()).matchAll(new RegExp(`button "${word("board")}" \\[ref=(e\\d+)\\]`, "g"))];
  if (!found.length) throw new Error(`no Board button on the ${who.instance}'s screen`);
  await who.clickRef(found[found.length - 1][1]);
}

async function openTeamPage(who) {
  const tree = await who.snapshot();
  const cancel = findControl(tree, { name: word("cancel"), role: "button", within: "dialog", exact: true });
  if (cancel) await who.clickRef(cancel.ref);
  if (!findControl(tree, { name: word("closeSettings"), role: "button" })) await who.click(word("settings"));
  await who.click(word("membersPage"));
}

async function openMembers(who) {
  await openTeamPage(who);
  await who.waitControl(word("addSomebody"), "textbox", 45 * SECOND);
}

/** The plan's one send: its label depends on what there is to grant. */
export function sendButton(tree) {
  return findControl(tree, { name: word("sendInvites"), role: "button", exact: true }) ?? findControl(tree, { name: word("addToTeam"), role: "button", exact: true });
}

const isDisabled = (control) => control.states.includes("disabled");

/** Add somebody › Review, as far as the plan. Returns the send button. */
async function reviewLogin(mcp, who, login) {
  await openMembers(who);
  await mcp.tool("ui_type", { instance: who.instance, name: word("addSomebody"), role: "textbox", text: login });
  const review = findControl(await who.snapshot(), { name: word("review"), role: "button", exact: true });
  if (!review) throw new Error(`no ${word("review")} under ${word("addSomebody")}`);
  await who.clickRef(review.ref);
  await who.waitControl(INVITE_PLAN_TITLE(login), "heading", 45 * SECOND);
  const send = sendButton(await who.snapshot());
  if (!send) throw new Error(`the plan for ${login} has no send button`);
  return send;
}

async function cancelPlan(who) {
  const cancel = findControl(await who.snapshot(), { name: word("cancel"), role: "button", exact: true });
  if (cancel) await who.clickRef(cancel.ref);
}

/** U17: the refused send, as drawn. `alert` is the inline line in its role; its
 *  full words are the text inside (a control's name stops at 120 characters).
 *  `toast`: the old way of saying it, a toast titled without the full stop. */
export function refusedSend(tree) {
  const nodes = parseTree(tree);
  const words = word("couldntAdd");
  const alert = nodes.find((n) => n.role === "alert" && n.name.startsWith(words));
  if (!alert) return null;
  const line = nodes.find((n) => n.role === "text" && n.name.startsWith(words))?.name ?? alert.name;
  const title = words.replace(/\.$/, "");
  const toast = nodes.some((n) => (n.role === "text" && n.name === title) || (n.role === "status" && n.name.includes(title)));
  return { line, toast };
}

/** The result line Members keeps after Remove, whole (a toast's title has no
 *  sentence after it). The snapshot cuts a text at 400 characters. */
export function removalLine(tree, login = MEMBER_LOGIN) {
  const starts = REMOVAL_RESULTS(login).map((w) => `${w}. `);
  return parseTree(tree).find((n) => n.role === "text" && starts.some((s) => n.name.startsWith(s)))?.name ?? null;
}

/** The Board's source line, word for word: "Cards come from the GitHub issues of
 *  o/r · read just now · Get new issues". `read` is its middle part. */
export function boardLine(tree) {
  const nodes = parseTree(tree);
  const from = nodes.findIndex((n) => n.role === "text" && n.name.startsWith(word("issuesLine")));
  const get = nodes.findIndex((n, i) => i > from && n.role === "button" && n.name === word("getNewIssues"));
  if (from < 0 || get <= from + 1) return null;
  const repo = nodes.slice(from + 1, get).find((n) => n.role === "button")?.name.replace(REPO_BUTTON_TAIL, "");
  const read = nodes[get - 1].name;
  return { line: `${nodes[from].name}${repo ? ` ${repo}` : ""} · ${read} · ${nodes[get].name}`, read, busy: isDisabled(nodes[get]) };
}

/**
 * The sheet's sentence is conditional, so the check is too. Null when the card,
 * the issue and the sheet agree; else what doesn't. Access gone: the sheet says
 * GitHub takes them off, so an assignee kept is what must be reported. Access
 * kept: the sheet promises nothing, and only card and issue must agree.
 */
export function claimsProblem({ onSandbox, issueAssignees, cardAssignees, row, login = MEMBER_LOGIN }) {
  const onIssue = issueAssignees.some((a) => same(a, login));
  if (onIssue !== cardAssignees.some((a) => same(a, login))) {
    return `card and issue disagree: issue [${issueAssignees}], card [${cardAssignees}]`;
  }
  if (onIssue && !onSandbox) return `GitHub gives them no access, the issue still has them, and the sheet says it takes them off`;
  if (onIssue && !row.includes(`${word("claimedBy")} ${login}`)) return `the issue has them but the row reads "${row}"`;
  if (!onIssue && !row.includes(word("readyToStart"))) return `the issue is free but the row reads "${row}"`;
  return null;
}

/**
 * Why Remove may be pressed. The plan comes from `app_dev_team_plan`, which has
 * no server session, and Send invites takes the seat before GitHub. A test-bridge
 * build skips the seat for such a plan (`account.rs::dev_plan_has_no_seats_at`,
 * `commands.rs::take_seat`), and `app_state account` says so as
 * `devPlanHasNoSeats`. It's the running owner that's asked: a build without that
 * code, or a plan that isn't dev-loaded, reads as no, and Remove isn't pressed.
 */
export const WAY_BACK_CLOSED =
  "L'app in esecuzione non dice devPlanHasNoSeats: su questo build Send invites si ferma al seggio, prima di GitHub (walk del 2026-11-02 passo 12), e dopo Remove il membro resterebbe fuori da entrambi i repository e da team.json finché una persona non lo rimette. Remove NON premuto, il membro non è stato toccato. Ricostruisci Plyloft Test e la copia del membro da questo ramo";

export function membershipSteps({ title, ownerOf, memberOf, cards, issue, memberMayStayOut = false, claimsWaitMs = 90 * SECOND, settleMs = 5 * SECOND, backWaitMs = 30 * SECOND }) {
  const ghostLeftNoTrace = async (mcp) => {
    const invited = [...listOf(await read(mcp, "team_invitations"), "team_invitations"), ...listOf(await read(mcp, "sandbox_invitations"), "sandbox_invitations")];
    if (invited.some((i) => same(i.invitee, GHOST_LOGIN))) throw new Error(`an invitation to ${GHOST_LOGIN} exists on GitHub`);
    const manifest = await read(mcp, "team_manifest");
    if (listOf(manifest?.members, "team.json's members").some((m) => same(m.login, GHOST_LOGIN))) throw new Error(`team.json lists ${GHOST_LOGIN}`);
    return "nessun invito su GitHub, team.json non lo elenca";
  };
  /** Get new issues, until the read has really ended. */
  const readBoard = async (who, until) => {
    await who.waitControl(word("getNewIssues"), "button", 30 * SECOND);
    await who.click(word("getNewIssues"));
    const started = Date.now();
    return poll(
      async () => {
        const seen = boardLine(await who.snapshot());
        if (!seen) return null;
        // The press takes a moment to show: an idle button right after it says nothing.
        return until(seen) || (!seen.busy && Date.now() - started >= settleMs) ? seen : null;
      },
      { timeoutMs: 90 * SECOND, what: `the ${who.instance}'s board to finish its read` },
    );
  };
  /** Only once Remove was pressed is there anything to bring back. */
  const onlyAfterRemove = (ctx) => {
    if (!ctx.removePressed) throw new Unverifiable("Remove non premuto: il membro non è stato toccato");
  };

  return [
    {
      id: "u17-refused",
      title: `U17. Owner: Members › Add somebody › ${GHOST_LOGIN} › Review`,
      expected: `Il piano dice "${word("noAccountChip")}" e "${NO_ACCOUNT_LINE(GHOST_LOGIN)}", ${word("sendInvites")} è spento, nessun invito su GitHub. "${word("couldntAdd")}" non può comparire qui: si registra quando un invio viene rifiutato davvero (passo del re-invito)`,
      instance: "owner",
      needs: ["join-owner"],
      timeoutMs: 3 * MINUTE,
      run: async (ctx) => {
        const owner = ownerOf(ctx);
        await assertGhostMissing(ctx.mcp);
        const send = await reviewLogin(ctx.mcp, owner, GHOST_LOGIN);
        // Never pressed, even if it's on: a send to a login nobody has isn't this step's to try.
        const nodes = parseTree(await owner.snapshot());
        const has = (words) => nodes.some((n) => n.name.includes(words));
        const trace = await ghostLeftNoTrace(ctx.mcp);
        await cancelPlan(owner);
        if (has(word("couldNotCheck"))) throw new Error(`the plan still says "${word("couldNotCheck")}"`);
        if (!has(word("noAccountChip"))) throw new Error(`the plan doesn't say "${word("noAccountChip")}"`);
        if (!has(NO_ACCOUNT_LINE(GHOST_LOGIN))) throw new Error(`the plan doesn't say "${NO_ACCOUNT_LINE(GHOST_LOGIN)}"`);
        if (!isDisabled(send) || send.name !== word("sendInvites")) throw new Error(`the button reads "${send.name}" ${send.states}: it should be ${word("sendInvites")}, off`);
        return `"${word("noAccountChip")}", "${NO_ACCOUNT_LINE(GHOST_LOGIN)}", ${send.name} spento. ${trace}`;
      },
    },
    {
      id: "u14-words",
      title: `U14, le parole. Owner: ${MORE_FOR(MEMBER_LOGIN)} › ${word("removeMenu")}`,
      expected: `Il foglio dice: "${REMOVAL_CLAIMS_NOTE(MEMBER_LOGIN)}". Poi Cancel`,
      instance: "owner",
      needs: ["member-claims"],
      timeoutMs: 2 * MINUTE,
      run: async (ctx) => {
        const owner = ownerOf(ctx);
        await openSheet(owner);
        // `includes`: the bridge reads a block with no controls as one text.
        const words = inside(parseTree(await owner.snapshot()), "dialog").find((n) => n.role === "text" && n.name.includes(REMOVAL_CLAIMS_NOTE(MEMBER_LOGIN)));
        await owner.clickIn("dialog", word("cancel"));
        if (!words) throw new Error(`the sheet doesn't say: ${REMOVAL_CLAIMS_NOTE(MEMBER_LOGIN)}`);
        return `"${REMOVAL_CLAIMS_NOTE(MEMBER_LOGIN)}"`;
      },
    },
    {
      id: "way-back",
      title: "Prima di Remove: la via del ritorno può riuscire?",
      expected: "app_state account dice devPlanHasNoSeats sull'owner, oppure il run si ferma qui senza toccare il membro",
      instance: "owner",
      needs: ["u14-words"],
      timeoutMs: 5 * SECOND,
      run: async (ctx) => {
        const account = await ownerOf(ctx).state("account");
        if (account?.devPlanHasNoSeats === true) return "l'owner ha un piano dev e questo build salta il seggio: il rientro può arrivare a GitHub";
        if (!memberMayStayOut) throw new Error(WAY_BACK_CLOSED);
        return "--member-may-stay-out: si preme Remove sapendo che il rientro può fermarsi al seggio";
      },
    },
    {
      id: "remove",
      title: `U14, cosa succede. Owner: ${word("removeConfirm")}`,
      expected: `"${REMOVAL_NORMAL(MEMBER_LOGIN, TEAM_REPO, SANDBOX_REPO)}"; team_collaborators non ha più il membro; sandbox e team.json registrati come dati`,
      instance: "owner",
      needs: ["way-back"],
      timeoutMs: 3 * MINUTE,
      run: async (ctx) => {
        const owner = ownerOf(ctx);
        const before = await memberState(ctx.mcp);
        if (!before.onTeam || !before.onSandbox) throw new Error(`not on both before Remove: ${membershipStatement(before)}`);
        if (before.otherWorkspaces.length) throw new Error(`team.json now lists ${before.otherWorkspaces.join(", ")} too: Remove not pressed`);
        await openSheet(owner);
        ctx.removePressed = true; // Before the press: it may land whatever comes back.
        ctx.warn?.(`Remove from team premuto per ${MEMBER_LOGIN}: finché il passo membership-state non dice altro, il membro può essere fuori.`);
        await owner.clickIn("dialog", word("removeConfirm"));
        const line = await poll(async () => removalLine(await owner.snapshot(MEMBER_LOGIN)), { timeoutMs: MINUTE, what: `the line Members keeps after Remove` });
        const state = await poll(
          async () => {
            const s = await memberState(ctx.mcp);
            return s.onTeam ? null : s;
          },
          { timeoutMs: 30 * SECOND, what: `${MEMBER_LOGIN} off team_collaborators` },
        );
        ctx.removal = state;
        if (!line.startsWith(REMOVAL_RESULTS(MEMBER_LOGIN)[0])) throw new Error(`the result isn't the normal one: "${line}"`);
        const other = line === REMOVAL_NORMAL(MEMBER_LOGIN, TEAM_REPO, SANDBOX_REPO) ? "" : " (parole diverse da quelle attese)";
        return `"${line}"${other}. team_collaborators senza il membro; sandbox: ${state.onSandbox ? "LO ELENCA ANCORA" : "non lo elenca più"}; team.json: ${state.listed ? "lo elenca ancora" : "non lo elenca più"}`;
      },
    },
    {
      id: "claims-after-removal",
      title: "U14: issue e card dell'owner dopo la rimozione, con una lettura del Board",
      expected: "Card, issue e foglio concordano: accesso tolto e assegnatario tolto, card Ready to start; se l'accesso resta, si riporta quello che si vede",
      instance: "owner",
      needs: ["remove"],
      timeoutMs: 5 * MINUTE,
      run: async (ctx) => {
        const owner = ownerOf(ctx);
        const started = Date.now();
        const assigneesOf = async () => (await issue(ctx.mcp, ctx.number)).assignees?.map((a) => a.login) ?? [];
        let assignees = await assigneesOf();
        // GitHub may take a moment; a kept assignee is an answer, not an error here.
        await poll(
          async () => {
            assignees = await assigneesOf();
            return !assignees.some((a) => same(a, MEMBER_LOGIN));
          },
          { timeoutMs: claimsWaitMs, what: "the assignee" },
        ).catch(() => {});
        const seconds = Math.round((Date.now() - started) / 1000);
        await owner.click(word("closeSettings"));
        await toBoard(owner);
        let seen = null;
        const look = async () => {
          const card = (await cards(owner, ctx.ownerWorkspace.id)).find((c) => c.ghIssueNumber === ctx.number);
          const row = findControl(await owner.snapshot(title), { name: title, role: "button" })?.name ?? "";
          seen = { card, row, problem: claimsProblem({ onSandbox: ctx.removal.onSandbox, issueAssignees: assignees, cardAssignees: card?.ghAssignees ?? [], row }) };
          return !seen.problem;
        };
        await readBoard(owner, () => false);
        await poll(look, { timeoutMs: claimsWaitMs, what: "the card to agree with the issue" }).catch(() => {});
        const facts = `issue #${ctx.number} assegnatari [${assignees}] dopo ${seconds} s; accesso al sandbox ${ctx.removal.onSandbox ? "rimasto" : "tolto"}; riga "${seen.row}"`;
        if (seen.problem) throw new Error(`${seen.problem}. ${facts}`);
        return facts;
      },
    },
    {
      id: "member-after-removal",
      title: `Member: Board › ${word("getNewIssues")} dopo la rimozione`,
      expected: `La riga del Board contiene "${word("noAccess")}" quando GitHub rifiuta il repository; se il membro ha ancora accesso, si registra quello`,
      instance: "member",
      needs: ["remove"],
      timeoutMs: 3 * MINUTE,
      run: async (ctx) => {
        const member = memberOf(ctx);
        await toBoard(member);
        const seen = await readBoard(member, (b) => b.read.includes(word("noAccess")));
        if (seen.read.includes(word("noAccess"))) return `"${seen.line}"`;
        if (ctx.removal.onSandbox) return `il membro ha ancora accesso al sandbox: "${seen.line}"`;
        throw new Error(`no "${word("noAccess")}" though the sandbox no longer lists them: "${seen.line}"`);
      },
    },
    {
      id: "reinvite",
      title: `Owner: ${word("addSomebody")} › ${MEMBER_LOGIN} › ${word("review")} › ${word("sendInvites")}`,
      expected: `Inviti su team_invitations e sandbox_invitations. Se l'invio è rifiutato, la riga "${word("couldntAdd")}" è la prova di U17 e il membro resta fuori, detto chiaramente. Si tenta sempre dopo Remove`,
      instance: "owner",
      always: true,
      timeoutMs: 3 * MINUTE,
      run: async (ctx) => {
        onlyAfterRemove(ctx);
        const owner = ownerOf(ctx);
        const before = await memberState(ctx.mcp);
        if (memberIsIn(before)) return "ancora su entrambi e in team.json: nessun invito da mandare";
        let send = await reviewLogin(ctx.mcp, owner, MEMBER_LOGIN);
        // GitHub may just not have answered: read the plan again, twice at most.
        for (let again = 0; again < 2 && isDisabled(send) && parseTree(await owner.snapshot()).some((n) => n.name.includes(word("couldNotCheck"))); again += 1) {
          await cancelPlan(owner);
          send = await reviewLogin(ctx.mcp, owner, MEMBER_LOGIN);
        }
        if (isDisabled(send)) throw new Error(`"${send.name}" is off on the plan for ${MEMBER_LOGIN}`);
        await owner.clickRef(send.ref);
        const got = await poll(
          async () => {
            const refused = refusedSend(await owner.snapshot());
            if (refused) return { refused };
            const s = await memberState(ctx.mcp);
            return (s.invitedTeam || s.onTeam) && (s.invitedSandbox || s.onSandbox) ? { state: s } : null;
          },
          { timeoutMs: MINUTE, what: "the invitations, or the refusal" },
        );
        if (got.refused) {
          await cancelPlan(owner);
          throw new Error(`refused${got.refused.toast ? " (and a toast says it too)" : " (U17: role alert, no toast)"}: "${got.refused.line}"`);
        }
        return `team: ${got.state.invitedTeam ? "invito" : "già collaboratore"}; sandbox: ${got.state.invitedSandbox ? "invito" : "già collaboratore"}`;
      },
    },
    {
      id: "accept-rejoin",
      title: "Accetta con gh_accept_invitation, poi Member: Settings › Members and library › Read it again",
      expected: `Di nuovo su team_collaborators, "${word("member")} of ${TEAM_REPO}", il progetto e il suo Board. Il foglio Join non c'è: il membro non ha mai lasciato il team su questo computer (settings.team resta)`,
      instance: "member",
      always: true,
      timeoutMs: 5 * MINUTE,
      run: async (ctx) => {
        onlyAfterRemove(ctx);
        const accepted = [];
        for (const repo of ["team", "sandbox"]) {
          // One refused must not keep the member off the other.
          try {
            const got = await ctx.mcp.tool("gh_accept_invitation", { repo });
            accepted.push(`${repo}: ${got.accepted ? "accettato" : got.why}`);
          } catch (error) {
            accepted.push(`${repo}: NON accettato (${error.message})`);
          }
        }
        const said = accepted.join("; ");
        await poll(
          async () => {
            const s = await memberState(ctx.mcp);
            return s.onTeam && s.onSandbox;
          },
          { timeoutMs: backWaitMs, what: `${MEMBER_LOGIN} back on both repositories (${said})` },
        );
        const member = memberOf(ctx);
        await openTeamPage(member);
        await member.waitControl(word("readItAgain"), "button", 30 * SECOND);
        await member.click(word("readItAgain"));
        // The repository is its own span, so the line comes as several text nodes.
        let lastStatus = "";
        const wanted = `${word("member")} of ${TEAM_REPO}`;
        const line = await poll(
          async () => {
            const text = parseTree(await member.snapshot()).filter((n) => n.role === "text").map((n) => n.name).join(" ").replace(/\s+/g, " ");
            const at = text.indexOf(TEAM_REPO);
            lastStatus = at < 0 ? text.slice(0, 200) : text.slice(Math.max(0, at - 40), at + TEAM_REPO.length + 80);
            return text.includes(wanted) ? lastStatus : null;
          },
          { timeoutMs: 90 * SECOND, what: `"${wanted}" on the member's Team page` },
        ).catch((e) => {
          throw new Error(`${e.message}; the page says: "${lastStatus}"`);
        });
        const list = await member.state("workspaces");
        if (!(list?.workspaces ?? []).some((w) => w.id === ctx.memberWorkspace.id)) throw new Error(`the project left the member's list: ${JSON.stringify(list)}`);
        await member.click(word("closeSettings"));
        await toBoard(member);
        const seen = await readBoard(member, (b) => !b.busy && /^read /.test(b.read));
        if (!/^read /.test(seen.read)) throw new Error(`the Board doesn't read: "${seen.line}"`);
        return `${said}. "${line}". Board: "${seen.line}"`;
      },
    },
    {
      id: "membership-state",
      title: "Dove sta il membro, detto chiaramente",
      expected: "Collaboratore su entrambi i repository e in team.json. Altrimenti lo dice qui, nel report del runner e su stderr",
      instance: "both",
      always: true,
      timeoutMs: MINUTE,
      run: async (ctx) => {
        let state;
        try {
          state = await memberState(ctx.mcp);
        } catch (error) {
          const text = `Non so dire dove sta ${MEMBER_LOGIN}: ${error.message}. ${ctx.removePressed ? "Remove è stato premuto: controlla entrambi i repository a mano." : "Remove non è stato premuto."}`;
          ctx.warn?.(text);
          throw new Error(text);
        }
        const text = membershipStatement(state);
        if (memberIsIn(state)) return text;
        ctx.warn?.(text);
        throw new Error(text);
      },
    },
    {
      id: "owner-to-board",
      title: "Owner: di nuovo sul Board, per la cancellazione",
      expected: "Fogli e Settings chiusi",
      instance: "owner",
      needs: ["create-card"],
      timeoutMs: MINUTE,
      run: async (ctx) => {
        const owner = ownerOf(ctx);
        const tree = await owner.snapshot();
        const cancel = findControl(tree, { name: word("cancel"), role: "button", within: "dialog", exact: true });
        if (cancel) await owner.clickRef(cancel.ref);
        if (findControl(tree, { name: word("closeSettings"), role: "button" })) await owner.click(word("closeSettings"));
        await toBoard(owner);
        return "sul Board";
      },
    },
  ];

  async function openSheet(owner) {
    await openMembers(owner);
    await owner.click(MORE_FOR(MEMBER_LOGIN));
    await owner.click(word("removeMenu"), "menuitem");
    await poll(async () => findControl(await owner.snapshot(), { name: word("removeConfirm"), role: "button", within: "dialog", exact: true }), {
      timeoutMs: 15 * SECOND,
      what: "the Remove sheet",
    });
  }
}
