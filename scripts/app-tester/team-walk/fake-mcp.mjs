// The fake MCP the scenario's tests run against: no app, no GitHub. `extra` adds
// lines to its tree and answers of its own, for what a mode needs beyond these.
/** The MCP as far as the scenario can tell, with a board that behaves. Its
 *  filtered snapshot has the real shape: only the lines with the text, any
 *  case, and the MCP's `focused:` and `open dialogs:` after them. */
export function fakeMcp({ board = "local", failOn = null, statusWhy = null, extra = null } = {}) {
  const calls = [];
  const issue = (title) => ({ number: 200, title, state: "OPEN", author: { login: "test-owner" }, labels: [{ name: "area:site" }], assignees: [] });
  const state = { board, issue: null, cardOnOwner: true };
  const tree = (who) => {
    const i = state.issue;
    const closed = i?.state === "CLOSED";
    const claimed = i?.assignees.length ? " Claimed by test-user" : (extra?.freeRow ?? "");
    const hasCard = i && (who === "member" || state.cardOnOwner);
    return [
      '- button "Board" [ref=e7]',
      // Setup's step list: since 1.175.0 the team step is deduced (the walk's Team plan).
      '- button "Your team" [ref=e10]',
      '- button "Claim" [ref=e6]',
      '- button "Join" [ref=e1]',
      ...(extra?.tree ? [] : ['- button "Get new issues" [ref=e8]']),
      ...(state.board === "githubIssues" ? ['- text "Board On GitHub Issues · test-owner/plyloft-ci-sandbox. Everyone sees the same cards." '] : []),
      ...(hasCard ? [`- button "${i.title}${closed ? " Closed · #200" : claimed}" [ref=e9]`] : []),
      '- dialog "d" [ref=e2]',
      '  - button "Join" [ref=e3]',
      ...(state.board === "local" ? ['  - button "Move to GitHub Issues" [ref=e4]'] : []),
      '  - button "Close issue & delete" [ref=e5]',
      ...(extra?.tree?.(who, state) ?? []),
    ];
  };
  const tool = async (name, args = {}) => {
    calls.push([name, args]);
    if (failOn && failOn(name, args)) throw new Error(`refused: ${name}`);
    const answer = extra?.tool?.(name, args, state);
    if (answer !== undefined) return answer;
    const who = args.instance;
    const id = who === "member" ? "com.mbadv.ply.test2" : "com.mbadv.ply.test";
    switch (name) {
      case "gh_read":
        if (args.query === "sandbox_definition") return { output: { board: state.board } };
        if (args.query === "issue_list" || args.query === "issue_list_open") return { output: state.issue ? [state.issue] : [] };
        return { output: state.issue };
      case "app_launch":
        return { info: { pid: who === "member" ? 2 : 1, identifier: id } };
      case "app_dev_team_plan":
        return { plan: "team", teamRole: who, login: who === "member" ? "test-user" : "test-owner" };
      case "app_state":
        if (args.kind === "profile") return { configDir: `/p/${id}` };
        if (args.kind === "workspaces") return { activeWorkspaceId: id, workspaces: [{ id, cwd: `/p/${id}/team-clones/plyloft-ci-sandbox` }] };
        if (who === "owner" && !state.cardOnOwner) return [];
        return [{ ghIssueNumber: 200, ghAssignees: state.issue?.assignees.map((a) => a.login) ?? [], columnId: state.issue?.state === "CLOSED" ? "complete" : "todo" }];
      case "ui_snapshot": {
        const lines = tree(who);
        const kept = args.filter ? lines.filter((l) => l.toLowerCase().includes(args.filter.toLowerCase())) : lines;
        return `${kept.join("\n")}\n\nfocused: {"name":"Closed Move to GitHub Issues"}`;
      }
      case "ui_click":
        if (args.ref === "e4") state.board = "githubIssues";
        if (args.ref === "e5") { state.issue.state = "CLOSED"; state.cardOnOwner = false; }
        if (args.ref === "e6") state.issue.assignees = [{ login: "test-user" }];
        return { clicked: true };
      case "ui_type":
        if (args.submit) state.issue = issue(args.text);
        return { typed: true };
      case "app_status":
        return statusWhy ? { running: false, why: statusWhy } : { running: true };
      case "app_quit":
        return { quit: true, orphans: [] };
      case "walk_start":
        return { dir: state.dir };
      case "walk_finish":
        return { outcome: "passato", report: "report.md" };
      default:
        return { met: true };
    }
  };
  return { tool, calls, state, close: () => {} };
}
