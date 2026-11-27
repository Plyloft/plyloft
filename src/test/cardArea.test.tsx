// 1.173.0 (B3): a card belongs to an area, as the person meets it — the
// card page's Area fact (changed while Not started, "Which area is this?"
// on a card with none), Start and Ship asking first, the sheet about files
// outside the area (scene 4) with Leave those out running the checks
// again, and the Board measuring a card from its area's branch. Only Tauri
// is a stub.
import { describe, expect, it } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { KanbanBoard } from "../components/KanbanBoard";
import type { CardAreaState, KanbanCard, OutsideFiles, ResolvedArea } from "../ipc";
import { askOutsideFiles, ensureCardArea, useCardArea } from "../store/cardAreaStore";
import { useBuildBoth } from "../store/buildBothStore";
import { useDoctor } from "../store/doctorStore";
import type { DoctorReport, ToolStatus } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { useToasts } from "../store/toastStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, fireEvent, renderUi, screen, waitFor, within } from "./render";
import { FREE_GATES, setPlanGates } from "./planGates";
import { useSettingUp } from "../lib/autoSetUp";

const resolved = (id: string, name: string, branch: string, root = false): ResolvedArea => ({
  id,
  name,
  path: root ? "" : `${id}/`,
  root,
  first: root,
  targetBranch: branch,
  branch,
  versionFiles: null,
  tagPrefix: root ? "" : `${id}-`,
  label: `area:${id}`,
  lookAt: null,
});
const app = resolved("app", "App", "staging", true);
const site = resolved("site", "Site", "main");
const areaState = (patch: Partial<CardAreaState>): CardAreaState => ({
  kind: "area",
  areas: [app, site],
  area: null,
  sentence: null,
  suggested: null,
  editable: false,
  fits: ["app", "site"],
  ...patch,
});

const PAGE_FIXTURES = {
  card_outcome: { filesChanged: 0, verifyConfigured: false, isRecon: false, reconVerdictNegative: false },
  improvement_proposal_state: null,
  improvement_proposal_trust_stopped: null,
  reviewer_list: [],
  verify_status: null,
  card_overlap_check: [],
  card_review_tip: null,
  ship_pending_release: { release: null, unreadable: null },
  verify_list_inflight: [],
  worktree_env_proposal: [],
  cards_target_sync: { target: "staging", cards: {} },
};

function workspace() {
  useWorkspaces.setState({
    workspaces: [{ id: BOARD_WS, name: "Mono", cwd: "/tmp/mono", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
    activeId: BOARD_WS,
  });
}

function page(card: KanbanCard, fixtures: Record<string, unknown>) {
  workspace();
  useCardArea.setState({ byCard: {}, asked: {} });
  act(() => seedBoard([card]));
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  const rendered = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    withToasts: true,
    fixtures: { ...PAGE_FIXTURES, kanban_load: () => [card], ...fixtures },
  });
  rendered.tauri.allowUnhandled();
  return rendered;
}

const areaFact = () => document.querySelector("[data-ply-card-area]") as HTMLElement | null;
const areaPick = () => document.querySelector("[data-ply-card-area-pick]") as HTMLElement | null;
const factsLine = () => document.querySelector(".ux-props--line") as HTMLElement;

describe("a card's area on its page", () => {
  it("a Not started card says its area in words, and Change… changes it on a choice (C2)", async () => {
    const card = boardCard("c1", { title: "Pricing page", area: "site" });
    const { tauri, user } = page(card, {
      card_area_state: () => areaState({ area: site, editable: true }),
      kanban_card_set_area: { ...card, area: "app" },
    });
    await waitFor(() => expect(areaFact()?.textContent).toBe("Site · cards go to main"));
    // 1.174.0 (C2, BCI-11): no field in the facts line.
    expect(factsLine().querySelector("select")).toBeNull();
    // 1.175.0 F10: a card not built yet — its one Change… is the sentence's,
    // and it also says the area ("It goes to Site.", two areas).
    expect(document.querySelector("[data-ply-brief-setup]")!.textContent).toContain("It goes to Site.");
    await user.click(screen.getByRole("button", { name: "Change…" }));
    const pickers = screen.getByRole("region", { name: "Change who builds and reviews" });
    const field = within(pickers).getByRole("combobox", { name: "Area" }) as HTMLSelectElement;
    expect(field.closest("[data-ply-card-area-pick]")).toBeTruthy();
    expect(field.value).toBe("site");
    expect([...field.options].map((o) => o.textContent)).toEqual(["App · cards go to staging", "Site · cards go to main"]);
    await user.selectOptions(field, "app");
    await waitFor(() => expect(tauri.callsOf("kanban_card_set_area")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_set_area")[0].args).toEqual({ workspaceId: BOARD_WS, cardId: "c1", area: "app" });
  });

  it("a started card with no area can choose only an area of the branch its copy was cut from", async () => {
    const card = boardCard("c1", { title: "Old card", columnId: "in_progress", worktreePath: "/tmp/wt/c1" });
    const { user } = page(card, {
      card_area_state: () => areaState({ kind: "needsArea", sentence: "Which area is this?", editable: true, fits: ["site"] }),
    });
    await waitFor(() => expect(areaFact()?.textContent).toBe("Not chosen yet"));
    expect(areaFact()!.querySelector(".ux-card-area-name")).toBeTruthy();
    await user.click(within(factsLine()).getByRole("button", { name: "Change…" }));
    const field = within(areaPick()!).getByRole("combobox", { name: "Area" }) as HTMLSelectElement;
    expect([...field.options].map((o) => [o.value, o.disabled])).toEqual([["app", true], ["site", false]]);
    expect(field.value).toBe("site");
  });

  it("a started card says its area without a choice", async () => {
    const card = boardCard("c1", { area: "site", columnId: "in_progress" });
    const { user } = page(card, { card_area_state: () => areaState({ area: site, editable: false }) });
    await waitFor(() => expect(areaFact()?.textContent).toBe("Site · cards go to main"));
    expect(within(areaFact()!).queryByRole("combobox")).toBeNull();
    const change = within(factsLine()).queryByRole("button", { name: "Change…" });
    if (change) await user.click(change);
    expect(areaPick()).toBeNull();
  });

  // 1.174.0 (C10 walk, step 13): a project not set up yet, its areas kept
  // on this Mac — the backend answers with no branch of the project's own.
  it("a project not set up yet says the card's area and where its cards go in words", async () => {
    const card = boardCard("c1", { area: "site", columnId: "in_progress" });
    const unset = { ...site, branch: "", targetBranch: null };
    page(card, { card_area_state: () => areaState({ area: unset, areas: [{ ...app, branch: "" }, unset], editable: false }) });
    await waitFor(() => expect(areaFact()?.textContent).toBe("Site · cards go to the project's branch"));
  });

  it("C1: a card whose area label hasn't reached GitHub says so, quietly", async () => {
    const card = boardCard("c1", { area: "site", columnId: "in_progress", ghIssueNumber: 5 });
    page(card, {
      card_area_state: () => areaState({ area: site, editable: false, labelLine: "Its area label hasn't reached GitHub yet." }),
    });
    await waitFor(() =>
      expect(areaFact()?.textContent).toBe("Site · cards go to main Its area label hasn't reached GitHub yet."),
    );
  });

  it("a card with no area reads Not chosen yet; Change… chooses it, starting on the area its files point to", async () => {
    const card = boardCard("c1", { title: "Old card", area: "docs" });
    const { tauri, user } = page(card, {
      card_area_state: () =>
        areaState({
          kind: "unknown",
          sentence: "Its issue is labeled area:docs, which isn't one of this repository's areas. Which area is this?",
          suggested: "site",
          editable: true,
        }),
      kanban_card_set_area: { ...card, area: "site" },
    });
    await waitFor(() => expect(areaFact()?.getAttribute("data-ply-card-area")).toBe("choose"));
    // An area the repository no longer lists is named; Change… says why.
    expect(areaFact()!.textContent).toBe("docs · not in the areas any more");
    expect(factsLine().querySelector("select")).toBeNull();
    expect(within(factsLine()).queryByRole("button", { name: "Use this area" })).toBeNull();
    // 1.175.0 F10: before the first build, the card's one Change… is the
    // sentence's under What you want.
    expect(within(factsLine()).queryByRole("button", { name: "Change…" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change…" }));
    expect(within(areaPick()!).getByText(/labeled area:docs/)).toBeTruthy();
    const field = within(areaPick()!).getByRole("combobox", { name: "Area" }) as HTMLSelectElement;
    expect(field.value).toBe("site");
    expect(tauri.callsOf("kanban_card_set_area")).toHaveLength(0);
    const use = within(areaPick()!).getByRole("button", { name: "Use this area" });
    // One filled press on the page: Now's. This one is bordered.
    expect(use.className).not.toMatch(/accent/);
    await user.click(use);
    await waitFor(() => expect(tauri.callsOf("kanban_card_set_area")[0]?.args.area).toBe("site"));
  });

  it("a Start that had to ask opens Change… with the focus on the area on a started card (C2)", async () => {
    const card = boardCard("c1", {
      title: "Old card",
      notes: "brief",
      columnId: "in_progress",
      worktreePath: "/tmp/wt/c1",
      lastRunStatus: "running",
      builder: { vendor: "claude", bypass: false, ptyId: "p1", sessionLost: false, startedAt: 1, snapshots: [] },
    } as Partial<KanbanCard>);
    const { user } = page(card, {
      card_area_state: () => areaState({ kind: "needsArea", sentence: "Which area is this?", suggested: "site", editable: true }),
    });
    await waitFor(() => expect(areaFact()?.getAttribute("data-ply-card-area")).toBe("choose"));
    act(() => useCardArea.getState().ask("c1"));
    await waitFor(() => expect(areaPick()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(within(areaPick()!).getByRole("combobox", { name: "Area" })));
    // Done answers the ask: the card shown again doesn't reopen Change….
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(useCardArea.getState().asked.c1).toBeUndefined();
    expect(areaPick()).toBeNull();
  });

  it("a repository with fewer than two areas shows nothing", async () => {
    const card = boardCard("c1");
    const { tauri } = page(card, { card_area_state: () => areaState({ kind: "none", areas: [] }) });
    await waitFor(() => expect(tauri.callsOf("card_area_state").length).toBeGreaterThan(0));
    expect(areaFact()).toBeNull();
    expect(screen.queryByText("Area")).toBeNull();
  });
});

// 1.174.0 (C3, P9; card-page.html §2, §2c, §2d): Now asks, before the press.
describe("Now asks for the area (C3)", () => {
  const nowBox = () => screen.getByRole("region", { name: "Now" });
  const primary = () => document.querySelector<HTMLButtonElement>("[data-ply-primary-action-id]")!;
  const needsArea = () => areaState({ kind: "needsArea", sentence: "Which area is this?", suggested: "site", editable: true });

  it("first time: the question, the areas starting where its files are, Start in Site — chosen and started in one press, no toast", async () => {
    const card = boardCard("c1", { title: "Pricing page", notes: "Copy the viewport line" });
    let chosen: string | null = null;
    const { tauri, user } = page(card, {
      card_area_state: () => (chosen ? areaState({ area: chosen === "site" ? site : app, editable: true }) : needsArea()),
      kanban_card_set_area: (args: Record<string, unknown>) => {
        chosen = String(args.area);
        return { ...card, area: chosen };
      },
    });
    await waitFor(() => expect(within(nowBox()).getByText("Which area is this card for?")).toBeTruthy());
    expect(within(nowBox()).getByText(/It was made on All areas\. Its area decides where its changes go and which release takes it\./)).toBeTruthy();
    const field = within(nowBox()).getByRole("combobox", { name: "Area" }) as HTMLSelectElement;
    expect(field.value).toBe("site");
    expect(within(nowBox()).getByText("Its files are in site/")).toBeTruthy();
    expect(primary().textContent).toBe("Start in Site");
    // One filled press in the view: Now's.
    expect(document.querySelectorAll(".cbtn--accent:not(.ux-split-toggle)")).toHaveLength(1);
    await user.selectOptions(field, "app");
    expect(primary().textContent).toBe("Start in App");
    await user.selectOptions(field, "site");
    await user.click(primary());
    await waitFor(() => expect(tauri.callsOf("kanban_card_set_area")[0]?.args.area).toBe("site"));
    // …and the same press starts it.
    await waitFor(() => expect(tauri.calls.map((c) => c.cmd)).toEqual(expect.arrayContaining(["builder_start"])));
    expect(useToasts.getState().toasts.find((t) => t.title === "Which area is this?")).toBeUndefined();
  });

  it("1.174.4: a branch that's nowhere: the press says so on the card and in a toast", async () => {
    const card = boardCard("c1", { title: "Pricing page", notes: "brief", area: "app" });
    const app = { id: "app", name: "App", branch: "staging", folders: [] } as unknown as ResolvedArea;
    const { tauri, user } = page(card, {
      card_area_state: () => areaState({ kind: "area", areas: [app], area: app }),
      builder_start: () => {
        throw "branch `staging` is neither on origin nor in this repository";
      },
    });
    await waitFor(() => expect(primary().textContent).toMatch(/Start/));
    await user.click(primary());
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    // 1.175.0 F8: the error leads Now (its group keeps the title).
    await waitFor(() => expect(screen.getByRole("group", { name: "Start build didn't go through." })).toBeTruthy());
    expect(screen.getByText(/^Area App sends its cards to the branch staging, which isn't on GitHub or on this computer\./)).toBeTruthy();
    expect(useToasts.getState().toasts.find((t) => t.title === "Start build didn't go through")?.body).toBe("What happened is on the card.");
  });

  // Challenger 1–2 (§2b): one press while the area is saved; the start
  // said as the mockup draws it, with Stop.
  it("two quick presses: one area saved and one start; Starting in Site… while it saves", async () => {
    const card = boardCard("c1", { title: "Pricing page", notes: "brief" });
    let chosen = false;
    let release: () => void = () => {};
    const { tauri } = page(card, {
      card_area_state: () => (chosen ? areaState({ area: site, editable: true }) : needsArea()),
      kanban_card_set_area: () =>
        new Promise((resolve) => {
          release = () => {
            chosen = true;
            resolve({ ...card, area: "site" });
          };
        }),
      builder_start: null,
    });
    await waitFor(() => expect(primary().textContent).toBe("Start in Site"));
    const press = primary();
    fireEvent.click(press);
    fireEvent.click(press);
    await waitFor(() => expect(within(nowBox()).getByText("Starting in Site…")).toBeTruthy());
    // Stop is drawn, bordered, and waits for the area to be saved.
    expect(primary().textContent).toBe("Stop");
    expect(primary().className).not.toMatch(/accent/);
    expect(primary().disabled).toBe(true);
    expect((within(nowBox()).getByRole("combobox", { name: "Area" }) as HTMLSelectElement).disabled).toBe(true);
    await act(async () => release());
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_set_area")).toHaveLength(1);
  });

  it("once saved: Area set to Site · Claude is opening this card's copy; Stop closes it, frees the claim and puts it back", async () => {
    const card = boardCard("c1", { title: "Pricing page", notes: "brief" });
    let chosen = false;
    let releaseStart: () => void = () => {};
    const { tauri } = page(card, {
      card_area_state: () => (chosen ? areaState({ area: site, editable: true }) : needsArea()),
      kanban_card_set_area: () => {
        chosen = true;
        return { ...card, area: "site" };
      },
      builder_start: () => new Promise((resolve) => (releaseStart = () => resolve(null))),
      builder_close: null,
      kanban_card_device_release: null,
      kanban_card_put_back: { ...card, area: "site" },
    });
    await waitFor(() => expect(primary().textContent).toBe("Start in Site"));
    const press = primary();
    fireEvent.click(press, { detail: 1 });
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(within(nowBox()).getByText("Starting in Site…")).toBeTruthy();
    expect(nowBox().textContent).toContain("Area set to Site · Claude is opening this card's copy");
    expect(primary().textContent).toBe("Stop");
    expect(primary().disabled).toBe(false);
    // Not armed yet: no pointerup or keyup since Stop came on.
    fireEvent.click(primary(), { detail: 1 });
    // A double-click's second click, armed or not, is no Stop.
    fireEvent.pointerUp(document.body);
    fireEvent.click(primary(), { detail: 2 });
    await act(async () => {});
    expect(primary().disabled).toBe(false);
    // An armed, single press stops.
    fireEvent.click(primary(), { detail: 1 });
    await act(async () => releaseStart());
    await waitFor(() => expect(tauri.callsOf("kanban_card_put_back")).toHaveLength(1));
    expect(tauri.callsOf("builder_close")).toHaveLength(1);
    expect(tauri.callsOf("kanban_card_device_release")).toHaveLength(1);
    const order = tauri.calls.map((c) => c.cmd).filter((c) => /builder_close|device_release|put_back$/.test(c));
    expect(order).toEqual(["builder_close", "kanban_card_device_release", "kanban_card_put_back"]);
    expect(tauri.callsOf("kanban_card_set_area")).toHaveLength(1);
    expect(tauri.callsOf("builder_start")).toHaveLength(1);
  });

  // 1.175.0 (D2): Stop during the start leaves the card — the member's own
  // name comes off its issue, and the toast says so. Without a name of
  // theirs on an issue there is no toast, as before.
  it("Stop during the start says the member's name is off the issue", async () => {
    const card = boardCard("c1", { title: "Pricing page", notes: "brief" });
    let chosen = false;
    let releaseStart: () => void = () => {};
    const { tauri } = page(card, {
      card_area_state: () => (chosen ? areaState({ area: site, editable: true }) : needsArea()),
      kanban_card_set_area: () => {
        chosen = true;
        return { ...card, area: "site" };
      },
      builder_start: () => new Promise((resolve) => (releaseStart = () => resolve(null))),
      builder_close: null,
      kanban_card_device_release: null,
      kanban_card_put_back: { ...card, area: "site" },
      card_name_off_outcome: { kind: "off", number: 161 },
    });
    await waitFor(() => expect(primary().textContent).toBe("Start in Site"));
    fireEvent.click(primary(), { detail: 1 });
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    fireEvent.pointerUp(document.body);
    fireEvent.click(primary(), { detail: 1 });
    await act(async () => releaseStart());
    await waitFor(() => expect(tauri.callsOf("card_name_off_outcome")).toHaveLength(1));
    const order = tauri.calls.map((c) => c.cmd).filter((c) => /put_back$|name_off_outcome/.test(c));
    expect(order).toEqual(["kanban_card_put_back", "card_name_off_outcome"]);
    const { useToasts } = await import("../store/toastStore");
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => [t.kind, t.title, t.body])).toEqual([
        ["info", "Back to Ready to start", "Nothing was built. Your name is off issue #161."],
      ]),
    );
  });

  it("a long setup takes over from Starting in Site… (round 2, Challenger 3)", async () => {
    const card = boardCard("c1", { title: "Pricing page", notes: "brief" });
    let chosen = false;
    page(card, {
      card_area_state: () => (chosen ? areaState({ area: site, editable: true }) : needsArea()),
      kanban_card_set_area: () => {
        chosen = true;
        return { ...card, area: "site" };
      },
      builder_start: () => new Promise(() => {}),
    });
    await waitFor(() => expect(primary().textContent).toBe("Start in Site"));
    fireEvent.click(primary());
    await waitFor(() => expect(within(nowBox()).getByText("Starting in Site…")).toBeTruthy());
    act(() => useSettingUp.setState((s) => ({ ...s, byCard: { ...s.byCard, c1: true } }) as never));
    await waitFor(() => expect(within(nowBox()).queryByText("Starting in Site…")).toBeNull());
    expect(primary().textContent).not.toBe("Stop");
    act(() => useSettingUp.setState((s) => ({ ...s, byCard: {} }) as never));
  });

  it("a held key's repeat doesn't arm Stop", async () => {
    const card = boardCard("c1", { title: "Pricing page", notes: "brief" });
    let chosen = false;
    const { tauri } = page(card, {
      card_area_state: () => (chosen ? areaState({ area: site, editable: true }) : needsArea()),
      kanban_card_set_area: () => {
        chosen = true;
        return { ...card, area: "site" };
      },
      builder_start: () => new Promise(() => {}),
    });
    await waitFor(() => expect(primary().textContent).toBe("Start in Site"));
    fireEvent.click(primary(), { detail: 0 });
    await waitFor(() => expect(primary().textContent).toBe("Stop"));
    fireEvent.keyUp(document.body, { key: "Enter", repeat: true });
    fireEvent.click(primary(), { detail: 0 });
    await act(async () => {});
    expect(primary().disabled).toBe(false);
    expect(tauri.callsOf("builder_close")).toHaveLength(0);
  });

  it("a press belongs to its card: another card's page draws no Starting in, nor its Stop", async () => {
    const card = boardCard("c1", { title: "Pricing page", notes: "brief" });
    const other = boardCard("c2", { title: "Other card", notes: "brief" });
    let release: () => void = () => {};
    let chosen = false;
    workspace();
    useCardArea.setState({ byCard: {}, asked: {} });
    act(() => seedBoard([card, other]));
    useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
    const { tauri } = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      withToasts: true,
      fixtures: {
        ...PAGE_FIXTURES,
        kanban_load: () => [card, other],
        card_area_state: (args: Record<string, unknown>) =>
          args.cardId === "c1" && chosen ? areaState({ area: site, editable: true }) : needsArea(),
        kanban_card_set_area: () =>
          new Promise((resolve) => {
            release = () => {
              chosen = true;
              resolve({ ...card, area: "site" });
            };
          }),
        builder_start: null,
      },
    });
    tauri.allowUnhandled();
    await waitFor(() => expect(primary().textContent).toBe("Start in Site"));
    fireEvent.click(primary());
    await waitFor(() => expect(within(nowBox()).getByText("Starting in Site…")).toBeTruthy());
    act(() => useUi.getState().selectCard(BOARD_WS, "c2"));
    await waitFor(() => expect(primary().textContent).toBe("Start in Site"));
    expect(within(nowBox()).queryByText("Starting in Site…")).toBeNull();
    expect((within(nowBox()).getByRole("combobox", { name: "Area" }) as HTMLSelectElement).disabled).toBe(false);
    await act(async () => release());
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("builder_start")[0].args.cardId).toBe("c1");
    act(() => useUi.getState().selectCard(BOARD_WS, "c1"));
    await waitFor(() => expect(within(nowBox()).queryByText("Starting in Site…")).toBeNull());
  });

  it("an area that isn't saved starts nothing", async () => {
    const card = boardCard("c1", { title: "Pricing page", notes: "brief" });
    const { tauri, user } = page(card, {
      card_area_state: needsArea,
      kanban_card_set_area: () => {
        throw "The areas changed on GitHub.";
      },
    });
    await waitFor(() => expect(primary().textContent).toBe("Start in Site"));
    await user.click(primary());
    await waitFor(() => expect(tauri.callsOf("kanban_card_set_area")).toHaveLength(1));
    await act(async () => {});
    expect(tauri.callsOf("builder_start")).toHaveLength(0);
    expect(primary().textContent).toBe("Start in Site");
  });

  it("on Free too, the press is Start in Site, with no plan line", async () => {
    setPlanGates(FREE_GATES);
    try {
      const card = boardCard("c1", { title: "Pricing page", notes: "brief" });
      page(card, {
        card_area_state: needsArea,
        kanban_card_set_area: { ...card, area: "site" },
      });
      await waitFor(() => expect(primary().textContent).toBe("Start in Site"));
      expect(nowBox().textContent).not.toContain("Free plan");
    } finally {
      setPlanGates(null);
    }
  });

  it("held areas: the problem, the way to Settings, no filled press", async () => {
    const card = boardCard("c1", { title: "Pricing page", notes: "brief" });
    const { user } = page(card, {
      card_area_state: () => areaState({ kind: "held", sentence: "The areas list on GitHub has two areas in the same folder." }),
    });
    await waitFor(() => expect(within(nowBox()).getByText("This repository's areas can't be used")).toBeTruthy());
    expect(primary().textContent).toBe("Open Settings › Project › Areas");
    expect(document.querySelectorAll(".cbtn--accent")).toHaveLength(0);
    const opened: string[] = [];
    const before = useUi.getState().openSettingsSection;
    useUi.setState({ openSettingsSection: (section: string) => void opened.push(section) });
    try {
      await user.click(primary());
      expect(opened).toEqual(["areas"]);
    } finally {
      useUi.setState({ openSettingsSection: before });
    }
  });

  it("a press elsewhere that had to ask lands on Now's select", async () => {
    const card = boardCard("c1", { title: "Old card", notes: "brief" });
    page(card, { card_area_state: needsArea });
    await waitFor(() => expect(within(nowBox()).queryByRole("combobox", { name: "Area" })).not.toBeNull());
    act(() => useCardArea.getState().ask("c1"));
    await waitFor(() => expect(document.activeElement).toBe(within(nowBox()).getByRole("combobox", { name: "Area" })));
    expect(areaPick()).toBeNull();
  });
});

describe("Start and Ship ask first", () => {
  it("a card with no area is not started: its page is opened with the area asked for", async () => {
    workspace();
    useCardArea.setState({ byCard: {}, asked: {} });
    const { tauri } = renderUi(<div />, {
      withToasts: true,
      fixtures: { card_area_state: () => areaState({ kind: "needsArea", sentence: "Which area is this?", editable: true }) },
    });
    let go = true;
    await act(async () => {
      go = await ensureCardArea(BOARD_WS, "c1", "start");
    });
    expect(go).toBe(false);
    expect(useCardArea.getState().asked.c1).toBeTruthy();
    const toast = useToasts.getState().toasts[0];
    expect(toast?.title).toBe("Which area is this?");
    expect(toast?.body).toBe("Choose its area on the card, then start it again.");
    expect(toast?.action?.label).toBe("Open the card");
    expect(tauri.callsOf("kanban_card_advance_to_in_progress")).toHaveLength(0);
  });

  it("C1: an issue label no area has: the question is the title, the label in the body", async () => {
    workspace();
    useCardArea.setState({ byCard: {}, asked: {} });
    renderUi(<div />, {
      withToasts: true,
      fixtures: {
        card_area_state: () =>
          areaState({
            kind: "needsArea",
            sentence: "Its issue is labeled area:docs, which isn't one of this repository's areas. Which area is this?",
            editable: true,
          }),
      },
    });
    await act(async () => {
      await ensureCardArea(BOARD_WS, "c1", "start");
    });
    const toast = useToasts.getState().toasts[0];
    expect(toast?.title).toBe("Which area is this?");
    expect(toast?.body).toBe(
      "Its issue is labeled area:docs, which isn't one of this repository's areas. Choose its area on the card, then start it again.",
    );
  });

  it("held areas refuse with the problem and the way to Settings; a card with its area goes on", async () => {
    workspace();
    let answer = areaState({
      kind: "held",
      sentence: "This repository's areas can't be used: Two areas share the folder site/. Fix them in Settings › Project › Areas.",
    });
    renderUi(<div />, { withToasts: true, fixtures: { card_area_state: () => answer } });
    let go = true;
    await act(async () => {
      go = await ensureCardArea(BOARD_WS, "c1", "ship");
    });
    expect(go).toBe(false);
    expect(useToasts.getState().toasts[0]?.title).toMatch(/^This repository's areas can't be used/);
    expect(useToasts.getState().toasts[0]?.action?.label).toBe("Open Settings › Project › Areas");
    answer = areaState({ area: site });
    await act(async () => {
      go = await ensureCardArea(BOARD_WS, "c1", "ship");
    });
    expect(go).toBe(true);
  });

  it("Start build on the Board asks before the card moves or any copy is made", async () => {
    workspace();
    useCardArea.setState({ byCard: {}, asked: {} });
    const card = boardCard("c1", { title: "Old card" });
    act(() => seedBoard([card]));
    const { tauri } = renderUi(<div />, {
      withToasts: true,
      fixtures: {
        card_area_state: () => areaState({ kind: "needsArea", sentence: "Which area is this?", editable: true }),
        kanban_load: () => [card],
      },
    });
    tauri.allowUnhandled();
    await act(async () => {
      await useKanban.getState().moveCard("c1", "in_progress");
    });
    expect(tauri.callsOf("kanban_card_advance_to_in_progress")).toHaveLength(0);
    expect(useKanban.getState().byWorkspace[BOARD_WS]?.cards[0]?.columnId).toBe("todo");
  });

  it("Build with both asks before the .env question, the claim or any copy (Reviewer 2)", async () => {
    workspace();
    const tool = (id: string): ToolStatus => ({
      id: id as ToolStatus["id"], name: id, required: false, found: true, path: `/bin/${id}`, version: "1.0.0",
      versionOk: true, detail: "", installCmd: "", docsUrl: "", reviewer: null,
    });
    const report: DoctorReport = {
      tools: [tool("git"), tool("claude"), tool("codex")], teamSkills: null, projectSkills: null, microphone: null,
      whisperModel: null, dictationShell: null, sharedDefinition: null, probeError: null, allRequiredOk: true, aiReady: true,
    };
    useDoctor.setState({ report });
    const card = boardCard("c1", { title: "Old card" });
    act(() => seedBoard([card]));
    const { tauri } = renderUi(<div />, {
      withToasts: true,
      fixtures: {
        card_area_state: () => areaState({ kind: "needsArea", sentence: "Which area is this?", editable: true }),
        kanban_load: () => [card],
      },
    });
    tauri.allowUnhandled();
    await act(async () => {
      await useBuildBoth.getState().startWith(BOARD_WS, "c1");
    });
    expect(tauri.callsOf("card_area_state")).toHaveLength(1);
    expect(tauri.callsOf("build_both_start")).toHaveLength(0);
    expect(tauri.callsOf("worktree_env_proposal")).toHaveLength(0);
    expect(useToasts.getState().toasts[0]?.title).toBe("Which area is this?");
  });

  it("a new card is made in the current area (none until the picker sets one)", async () => {
    workspace();
    act(() => seedBoard([]));
    const { tauri } = renderUi(<div />, {
      fixtures: {
        kanban_card_create: (args: Record<string, unknown>) => boardCard(String(args.cardId), { title: String(args.title), area: (args.area as string) ?? null }),
      },
    });
    tauri.allowUnhandled();
    await act(async () => {
      await useKanban.getState().addCard(BOARD_WS, "One");
      await useKanban.getState().addCard(BOARD_WS, "Two", undefined, "todo", "site");
    });
    const calls = tauri.callsOf("kanban_card_create");
    expect(calls.map((c) => c.args.area)).toEqual([null, "site"]);
  });
});

const outside: OutsideFiles = {
  area: site,
  files: [
    { path: "AGENTS.md", area: "app", belongs: "whole repository" },
    { path: "frontend/src/pages/Legal.tsx", area: "app", belongs: "App" },
  ],
  hint: "If they ship with this card, they reach main before the rest of App's work on staging.",
};

describe("files outside the card's area, before Ship (scene 4)", () => {
  it("the sheet names them; focus starts on Leave those out, between Back and Ship anyway", async () => {
    workspace();
    const { user } = renderUi(<div />, { fixtures: { card_outside_files: outside } });
    let answer: Promise<"go" | "stop"> = Promise.resolve("stop");
    act(() => {
      answer = askOutsideFiles(BOARD_WS, "c1");
    });
    const sheet = await screen.findByRole("dialog", { name: "This card also changes files outside Site" });
    expect(within(sheet).getByText("Site cards go to main. These files belong somewhere else:")).toBeTruthy();
    // Scene 4's rows: the path in code style and an outline chip, no tint.
    const rows = sheet.querySelectorAll(".ux-confirm-files li");
    expect([...rows].map((r) => [r.querySelector("code")?.textContent, r.querySelector(".cchip--outline")?.textContent])).toEqual([
      ["AGENTS.md", "whole repository"],
      ["frontend/src/pages/Legal.tsx", "App"],
    ]);
    expect(within(sheet).getByText(outside.hint)).toBeTruthy();
    const buttons = within(sheet).getAllByRole("button").map((b) => b.textContent);
    expect(buttons.slice(-3)).toEqual(["Back", "Leave those out", "Ship anyway"]);
    const leave = within(sheet).getByRole("button", { name: "Leave those out" });
    await waitFor(() => expect(document.activeElement).toBe(leave));
    await user.click(within(sheet).getByRole("button", { name: "Ship anyway" }));
    await expect(answer).resolves.toBe("go");

    act(() => {
      answer = askOutsideFiles(BOARD_WS, "c1");
    });
    await user.click(await screen.findByRole("button", { name: "Back" }));
    await expect(answer).resolves.toBe("stop");
  });

  it("Leave those out puts them back and runs the checks again; nothing ships now", async () => {
    workspace();
    act(() => seedBoard([boardCard("c1", { area: "site", columnId: "complete" })]));
    const { tauri, user } = renderUi(<div />, {
      withToasts: true,
      fixtures: {
        card_outside_files: outside,
        card_leave_out_files: { leftOut: ["AGENTS.md", "frontend/src/pages/Legal.tsx"], sha: "abc", builder: false },
        kanban_load: () => [boardCard("c1", { area: "site", columnId: "complete" })],
        verify_start: "run-1",
      },
    });
    tauri.allowUnhandled();
    let answer: Promise<"go" | "stop"> = Promise.resolve("go");
    act(() => {
      answer = askOutsideFiles(BOARD_WS, "c1");
    });
    await user.click(await screen.findByRole("button", { name: "Leave those out" }));
    await expect(answer).resolves.toBe("stop");
    expect(tauri.callsOf("card_leave_out_files")[0].args).toEqual({
      workspaceId: BOARD_WS,
      cardId: "c1",
      paths: ["AGENTS.md", "frontend/src/pages/Legal.tsx"],
    });
    expect(tauri.callsOf("verify_start")).toHaveLength(1);
    expect(tauri.callsOf("card_ship")).toHaveLength(0);
    expect(useToasts.getState().toasts.some((t) => t.title === "2 files left out")).toBe(true);
  });

  it("no files outside: no sheet", async () => {
    workspace();
    renderUi(<div />, { fixtures: { card_outside_files: { ...outside, files: [] } } });
    await expect(askOutsideFiles(BOARD_WS, "c1")).resolves.toBe("go");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the Board measures a card from its area's branch", () => {
  it("a site card reads Behind main while the workspace's branch is staging", async () => {
    workspace();
    useUi.setState({ centerMode: { [BOARD_WS]: "board" } });
    const card = boardCard("c1", {
      title: "Site card",
      area: "site",
      columnId: "complete",
      lastRunStatus: "success",
      worktreePath: "/tmp/wt/c1",
      branchName: "plyloft/card-c1",
    } as Partial<KanbanCard>);
    act(() => seedBoard([card]));
    const board = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { cards_target_sync: { target: "staging", cards: { c1: { behind: 2, conflict: false, merging: false, target: "main" } } } },
    });
    board.tauri.allowUnhandled();
    const tile = () => document.querySelector('[data-board-card-id="c1"]') as HTMLElement;
    await waitFor(() => expect(within(tile()).getByText("Behind main")).toBeTruthy());
    expect(within(tile()).queryByText("Behind staging")).toBeNull();
  });
});
