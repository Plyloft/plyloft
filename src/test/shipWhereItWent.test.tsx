// 1.169.1 (R13): Ship and Release say where the change went. A local Ship
// never pushes, so on a project on GitHub its toast and its receipt say it
// isn't there yet; a pull request's result opens it on GitHub.
import { afterEach, describe, expect, it } from "vitest";
import type { KanbanCard, ShipOutcome } from "../ipc";
import { CardShipStep } from "../components/CardShipStep";
import { OutcomeScreen } from "../components/OutcomeScreen";
import { FOLDER_CHANGES_LEDE, FolderChangesSheet } from "../components/FolderChangesSheet";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { useUi } from "../store/uiStore";
import { useToasts } from "../store/toastStore";
import { useWorkspaces } from "../store/workspaceStore";
import { openFolderChanges, useProjectFolder } from "../store/projectFolderStore";
import { localShipLine } from "../lib/worktreeBase";
import { RELEASE_KINDS } from "../lib/cardPage";
import { setPlatformForTests } from "../lib/platform";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, fireEvent, renderUi, screen, tauri, waitFor, within } from "./render";

const WS = BOARD_WS;
const ROOT = "/r/lyra";

function withWorkspace() {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "lyra", cwd: ROOT, createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
    activeId: WS,
  });
}

const outcomeFixtures = (hasRemote: boolean | null) => ({
  card_outcome: { filesChanged: 1, verifyConfigured: false, isRecon: false, reconVerdictNegative: false, hasRemote },
  improvement_proposal_state: null,
  improvement_proposal_trust_stopped: null,
  reviewer_list: [],
  verify_status: null,
  card_overlap_check: [],
  card_review_tip: null,
  ship_pending_release: { release: null, unreadable: null },
  project_try_command_get: null,
  card_review_diff: { cardId: "c1", baseBranch: "main", cardBranch: "plyloft/card-c1", files: [], generatedAt: 1 },
});

async function shipWith(
  res: ShipOutcome,
  { hasRemote, base }: { hasRemote: boolean | null; base: KanbanCard["worktreeBase"] },
) {
  withWorkspace();
  const card = boardCard("c1", {
    title: "Dark mode",
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    worktreePath: "/tmp/wt/c1",
    branchName: "plyloft/card-c1",
    worktreeBase: base,
  } as Partial<KanbanCard>);
  act(() => seedBoard([card], { name: "lyra", cwd: ROOT }));
  let runner: ((mode: "merge_live" | "pr") => Promise<void>) | null = null;
  const r = renderUi(
    <OutcomeScreen workspaceId={WS} card={card} onShipReady={(run) => (runner = run as typeof runner)} />,
    { withToasts: true, fixtures: { ...outcomeFixtures(hasRemote), card_ship: res, kanban_load: [card] } },
  );
  r.tauri.allowUnhandled();
  await waitFor(() => expect(tauri().callsOf("card_outcome").length).toBeGreaterThan(0));
  await waitFor(() => expect(runner).not.toBeNull());
  // The outcome's read lands before the press (its `hasRemote`).
  await act(async () => {});
  await act(async () => {
    await runner!("merge_live");
  });
  const shipped = useToasts.getState().toasts.filter((t) => t.title === "Shipped");
  return shipped[shipped.length - 1];
}

const merged = (over: Partial<ShipOutcome> = {}): ShipOutcome =>
  ({ kind: "local_merge", merged: true, conflictingPaths: [], fellBack: false, ...over }) as ShipOutcome;

const githubBase = { commit: "a".repeat(40), refName: "origin/trunk", source: "origin", originSlug: "o/lyra" } as const;
const plainBase = { commit: "a".repeat(40), refName: "origin/main", source: "origin" } as const;

describe("the Shipped toast says where the change went", () => {
  afterEach(() => setPlatformForTests(null));

  it("on a project on GitHub: on the target, by name, on this Mac — not on GitHub yet", async () => {
    const shipped = await shipWith(merged({ target: "trunk", onGitHub: true }), { hasRemote: true, base: githubBase });
    expect(shipped?.body).toBe("Shipped · only on this Mac. trunk on this Mac has it; GitHub doesn't.");
    expect(shipped?.body).not.toMatch(/build branch/);
  });

  it("names the target and GitHub as the backend says, not as the card recorded", async () => {
    // The card started from origin/main with no GitHub recorded; Ship went
    // to trunk on a project on GitHub.
    const shipped = await shipWith(merged({ target: "trunk", onGitHub: true }), { hasRemote: false, base: plainBase });
    expect(shipped?.body).toBe("Shipped · only on this Mac. trunk on this Mac has it; GitHub doesn't.");
    // The outcome's "a pull request is offered" is not "on GitHub".
    const other = await shipWith(merged({ target: "main" }), { hasRemote: true, base: githubBase });
    expect(other?.body).toBe("Merged into main on this Mac. Nothing runs after shipping in this project; Settings › Cards › Shipping › “After a release, run” sets one.");
  });

  it("an older backend that names no target: your main branch", async () => {
    const shipped = await shipWith(merged(), { hasRemote: false, base: githubBase });
    expect(shipped?.body).toBe("Merged into your main branch on this Mac. Nothing runs after shipping in this project; Settings › Cards › Shipping › “After a release, run” sets one.");
  });

  it("after a go-live step on a project on GitHub, it still isn't on GitHub", async () => {
    const shipped = await shipWith(merged({ kind: "merged_live", target: "trunk", onGitHub: true }), {
      hasRemote: true,
      base: githubBase,
    });
    // 1.171.0 A3 (DL-30): any project's install step runs; only Plyloft's
    // own relaunches.
    expect(shipped?.body).toBe(
      "Shipped · only on this Mac. trunk on this Mac has it; GitHub doesn't. Its install step is running in the background.",
    );
  });

  it("only Plyloft's own install says it relaunches", async () => {
    const shipped = await shipWith(merged({ kind: "merged_live", target: "main", onGitHub: true, relaunches: true }), {
      hasRemote: true,
      base: githubBase,
    });
    expect(shipped?.body).toBe("Shipped · only on this Mac. main on this Mac has it; GitHub doesn't. Rebuilding your app; it'll relaunch shortly.");
  });

  it("on Windows the toast says this PC", async () => {
    setPlatformForTests("windows");
    const shipped = await shipWith(merged({ target: "trunk", onGitHub: true }), { hasRemote: true, base: githubBase });
    expect(shipped?.body).toBe("Shipped · only on this PC. trunk on this PC has it; GitHub doesn't.");
  });

  it("names the target by its own name", () => {
    expect(localShipLine(null, false)).toBe("Merged into your main branch on this Mac.");
    expect(localShipLine("origin/develop", true)).toBe("Shipped · only on this Mac. develop on this Mac has it; GitHub doesn't.");
  });
});

// TX5 (1.174.0, P40, T30/T31): a ship the project folder's changes stopped
// says so in the app's words, and Show them opens the 1.172.1 changes sheet.
describe("a ship the project folder's changes stopped", () => {
  afterEach(() => useProjectFolder.setState({ sheetFor: null }));

  it("names the changes, points at Show them, and Show them opens the sheet", async () => {
    withWorkspace();
    const card = boardCard("c1", {
      title: "Dark mode",
      columnId: "complete",
      lastRunStatus: "success",
      verifyStatus: "passed",
      worktreePath: "/tmp/wt/c1",
      branchName: "plyloft/card-c1",
      worktreeBase: plainBase,
    } as Partial<KanbanCard>);
    act(() => seedBoard([card], { name: "lyra", cwd: ROOT }));
    let runner: ((mode: "merge_live" | "pr") => Promise<void>) | null = null;
    const dirty = 'PLY_TARGET_DIRTY_V1:{"totalCount":3,"paths":["a.txt","b.txt","c.txt"],"truncated":false}';
    const changes = {
      totalCount: 3,
      truncated: false,
      files: ["a.txt", "b.txt", "c.txt"].map((path) => ({
        path,
        kind: "modified",
        hunks: [{ header: "@@ -1 +1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: "-old\n+new" }],
      })),
    };
    const r = renderUi(
      <>
        <OutcomeScreen workspaceId={WS} card={card} onShipReady={(run) => (runner = run as typeof runner)} />
        <FolderChangesSheet />
      </>,
      {
        withToasts: true,
        fixtures: {
          ...outcomeFixtures(false),
          card_ship: () => Promise.reject(dirty),
          kanban_load: [card],
          project_folder_changes_detail: changes,
        },
      },
    );
    r.tauri.allowUnhandled();
    await waitFor(() => expect(runner).not.toBeNull());
    await act(async () => {});
    await act(async () => {
      await runner!("merge_live");
    });
    const toast = useToasts.getState().toasts.find((t) => t.title === "Your project folder has changes that aren't saved");
    expect(toast?.body).toBe(
      "3 changed files in your project folder aren't saved in a commit, so Plyloft won't ship into it. Show them opens them, and Claude can save them for you; then ship again.",
    );
    expect(toast?.body).not.toMatch(/uncommitted/);
    expect(toast?.action?.label).toBe("Show them");
    fireEvent.click(await screen.findByRole("button", { name: "Show them" }));
    expect(useProjectFolder.getState().sheetFor).toBe(WS);
    expect(useProjectFolder.getState().sheetReason).toBe("ship");
    // T30b: the sheet opened from a ship says why it stops the ship, and
    // has no Sync again; Close and Ask Claude to save them stay.
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("3 changes in your project folder");
    expect(
      within(dialog).getByText("Plyloft won't ship into your project folder while these aren't saved in a commit."),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Sync again" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Ask Claude to save them" })).toBeTruthy();

    // Saved meanwhile: opened from a ship again, nothing is in the way, and
    // there is nothing for Claude to save.
    tauri().fixture("project_folder_changes_detail", { totalCount: 0, truncated: false, files: [] });
    act(() => useProjectFolder.getState().closeSheet());
    act(() => openFolderChanges(WS, "ship"));
    const empty = await screen.findByRole("dialog");
    await within(empty).findByText("Nothing is in the way any more. Ship it again.");
    expect(within(empty).queryByRole("button", { name: "Ask Claude to save them" })).toBeNull();
    expect(within(empty).queryByRole("button", { name: "Sync again" })).toBeNull();

    // The same sheet from the Board's ask (no reason) keeps its own words
    // and Sync again.
    tauri().fixture("project_folder_changes_detail", changes);
    act(() => useProjectFolder.getState().closeSheet());
    act(() => openFolderChanges(WS));
    expect(useProjectFolder.getState().sheetReason).toBe("sync");
    const fromSync = await screen.findByRole("dialog");
    await within(fromSync).findByText(FOLDER_CHANGES_LEDE);
    expect(within(fromSync).getByRole("button", { name: "Sync again" })).toBeTruthy();
  });
});

describe("the receipt of a local ship", () => {
  afterEach(() => setPlatformForTests(null));

  const shippedCard = (over: Partial<KanbanCard> = {}) =>
    boardCard("c1", {
      title: "Dark mode",
      columnId: "complete",
      shipStatus: "shipped",
      shipHistory: [{ commitSha: "abc", shippedVersion: "", releaseKind: "local", shippedAt: Date.now() }],
      ...over,
    } as Partial<KanbanCard>);

  function renderReceipt(
    origin: { hasOrigin: boolean; defaultBranch: string | null; githubRepo?: string | null },
    over: Partial<KanbanCard> = {},
    sent: string[] = [],
  ) {
    withWorkspace();
    const card = shippedCard(over);
    const r = renderUi(<CardShipStep card={card} onOpenRelease={() => {}} />, {
      fixtures: {
        project_local_origin: origin,
        put_on_github_sent: () => sent,
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        ship_pending_release: { release: null, unreadable: null },
        project_try_command_get: null,
        kanban_load: [card],
      },
    });
    r.tauri.allowUnhandled();
    return screen.getByRole("region", { name: "Ship history" });
  }

  it("on a project on GitHub, says it isn't on GitHub yet — the toast's words", async () => {
    const history = renderReceipt({ hasOrigin: true, defaultBranch: "main", githubRepo: "o/lyra" });
    expect(await within(history).findByText("Only on this Mac — not on GitHub")).toBeTruthy();
    // The toast for the same ship says the same thing.
    expect(localShipLine("main", true)).toContain("only on this Mac");
  });

  it("1.175.0 F3 (R13): shipped here before the project was put on GitHub — it went with main, so not 'not on GitHub'", async () => {
    const history = renderReceipt({ hasOrigin: true, defaultBranch: "main", githubRepo: "o/lyra" }, {}, ["abc"]);
    await waitFor(() => expect(tauri().callsOf("put_on_github_sent").length).toBeGreaterThan(0));
    await waitFor(() => expect(within(history).getByText("On this Mac")).toBeTruthy());
    expect(within(history).queryByText(/not on GitHub/)).toBeNull();
  });

  it("on Windows, On this PC", async () => {
    setPlatformForTests("windows");
    const history = renderReceipt({ hasOrigin: true, defaultBranch: "main", githubRepo: "o/lyra" });
    expect(await within(history).findByText("Only on this PC — not on GitHub")).toBeTruthy();
  });

  it("without GitHub, stays On this Mac", async () => {
    const history = renderReceipt({ hasOrigin: false, defaultBranch: null, githubRepo: null });
    await waitFor(() => expect(tauri().callsOf("project_local_origin").length).toBeGreaterThan(0));
    await act(async () => {});
    expect(within(history).getByText("On this Mac")).toBeTruthy();
    expect(within(history).queryByText(/GitHub/)).toBeNull();
  });

  it("a GitHub release's receipt says tagged and pushed — never a release Plyloft made", async () => {
    const history = renderReceipt(
      { hasOrigin: true, defaultBranch: "main", githubRepo: "o/lyra" },
      { shipHistory: [{ commitSha: "abc", shippedVersion: "1.2.0", releaseKind: "github", shippedAt: Date.now() }] },
    );
    expect(within(history).getByText("Tagged and pushed")).toBeTruthy();
    expect(within(history).queryByText("A GitHub release")).toBeNull();
  });
});

describe("a pull request's result opens it on GitHub", () => {
  const prCard = (over: Partial<KanbanCard> = {}) =>
    boardCard("c1", {
      title: "Dark mode",
      columnId: "complete",
      lastRunStatus: "success",
      reviewStatus: "merged",
      prUrl: "https://github.com/o/lyra/pull/9",
      worktreePath: "/tmp/wt/c1",
      ...over,
    } as Partial<KanbanCard>);

  it("the Outcome screen has a persistent Open on GitHub beside the link", async () => {
    withWorkspace();
    const card = prCard({ pr: null });
    const r = renderUi(<OutcomeScreen workspaceId={WS} card={card} />, {
      fixtures: { ...outcomeFixtures(true), kanban_load: [card], open_web_link: null },
    });
    r.tauri.allowUnhandled();
    const open = screen.getByRole("button", { name: "Open on GitHub" });
    // The link is still there to copy, behind Details.
    expect(screen.getByText("https://github.com/o/lyra/pull/9")).toBeTruthy();
    fireEvent.click(open);
    await waitFor(() => expect(tauri().callsOf("open_web_link")).toHaveLength(1));
    expect(tauri().callsOf("open_web_link")[0].args.url).toBe("https://github.com/o/lyra/pull/9");
  });

  it("once read back, the result leaves Open on GitHub to Shipping's pull request block", () => {
    withWorkspace();
    const card = prCard({ pr: { number: 9, state: "open" } as KanbanCard["pr"] });
    const r = renderUi(<OutcomeScreen workspaceId={WS} card={card} />, {
      fixtures: { ...outcomeFixtures(true), kanban_load: [card], open_web_link: null },
    });
    r.tauri.allowUnhandled();
    expect(screen.queryByRole("button", { name: "Open on GitHub" })).toBeNull();
    expect(screen.getByText("https://github.com/o/lyra/pull/9")).toBeTruthy();
  });

  it("the Shipping section of a pull request never read back keeps Copy; Open is the result's", async () => {
    withWorkspace();
    const card = prCard({ pr: null });
    const r = renderUi(<CardShipStep card={card} onOpenRelease={() => {}} />, {
      fixtures: {
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        ship_pending_release: { release: null, unreadable: null },
        kanban_load: [card],
        open_web_link: null,
      },
    });
    r.tauri.allowUnhandled();
    expect(screen.getByRole("button", { name: "Copy the pull request link" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open on GitHub" })).toBeNull();
  });

  it("a pull request read back: the page's one Open on GitHub is Shipping's", async () => {
    withWorkspace();
    const pr = { number: 9, state: "merged", checks: [], checkedAt: 1 } as unknown as KanbanCard["pr"];
    const card = prCard({ pr, branchName: "plyloft/card-c1" });
    act(() => seedBoard([card], { name: "lyra", cwd: ROOT }));
    useUi.setState({ selectedCardId: { [WS]: card.id }, centerMode: { [WS]: "board" } });
    const r = renderUi(<CardDetailPanel workspaceId={WS} />, {
      fixtures: { ...outcomeFixtures(true), kanban_load: [card], open_web_link: null },
    });
    r.tauri.allowUnhandled();
    await act(async () => {});
    expect(screen.getAllByRole("button", { name: "Open on GitHub", hidden: true })).toHaveLength(1);
  });

  it("the whole card page has one Open on GitHub, and Technical details opens it beside Copy", async () => {
    withWorkspace();
    const card = prCard({ pr: null, branchName: "plyloft/card-c1" });
    act(() => seedBoard([card], { name: "lyra", cwd: ROOT }));
    useUi.setState({ selectedCardId: { [WS]: card.id }, centerMode: { [WS]: "board" } });
    const r = renderUi(<CardDetailPanel workspaceId={WS} />, {
      fixtures: {
        ...outcomeFixtures(true),
        kanban_load: [card],
        open_web_link: null,
        project_local_origin: { hasOrigin: true, defaultBranch: "main", githubRepo: "o/lyra" },
      },
    });
    r.tauri.allowUnhandled();
    await act(async () => {});
    // (Sections below the fold count too: `hidden` reads every one.)
    expect(screen.getAllByRole("button", { name: "Open on GitHub", hidden: true })).toHaveLength(1);
    const details = within(screen.getByText("Technical").closest("details")!);
    fireEvent.click(details.getByRole("button", { name: "Open the pull request on GitHub", hidden: true }));
    await waitFor(() => expect(tauri().callsOf("open_web_link")).toHaveLength(1));
    expect(tauri().callsOf("open_web_link")[0].args.url).toBe("https://github.com/o/lyra/pull/9");
    expect(details.getByRole("button", { name: "Copy the pull request link", hidden: true })).toBeTruthy();
  });
});

describe("Release's Put the version on GitHub, with a release page", () => {
  afterEach(() => setPlatformForTests(null));

  it("On this Mac only reads On this PC only on Windows (the choice list's machineWords)", async () => {
    setPlatformForTests("windows");
    const { ChoiceList } = await import("../components/ux");
    renderUi(
      <ChoiceList
        label="How far it goes"
        value="local"
        onChange={() => {}}
        options={RELEASE_KINDS.map((k) => ({ value: k.value, label: k.label, hint: k.hint }))}
      />,
    );
    expect(screen.getByText("On this PC only")).toBeTruthy();
    expect(screen.queryByText("On this Mac only")).toBeNull();
  });

  it("says what it does in 1.169.1: the tag, and the release page by your own workflow", () => {
    expect(RELEASE_KINDS.find((k) => k.value === "github")?.hint).toBe(
      "Pushes the release and its tag; the release page on GitHub is created by your own workflow, if you have one.",
    );
  });
});
