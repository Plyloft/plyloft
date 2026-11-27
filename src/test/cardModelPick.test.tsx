// 1.168.1 (E2/E3): the card's Builder and Challenger models, as the person
// meets them on the real card page — the model each role will run on in the
// facts line ("the tool's default" when nothing is chosen anywhere), pressed
// to choose one for this card only, saved through `kanban_card_set_models`.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import type { KanbanCard } from "../ipc";
import { useUi } from "../store/uiStore";
import { useKanban } from "../store/kanbanStore";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, waitFor, within } from "./render";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: () => {
    useEffect(() => {}, []);
    return <div data-testid="builder-terminal" />;
  },
}));
vi.mock("../components/CardReviewPanel", () => ({ CardReviewPanel: () => <div /> }));
vi.mock("../components/IntakeConversation", () => ({ IntakeConversation: () => <div /> }));
vi.mock("../components/OutcomeScreen", () => ({ OutcomeScreen: () => <div data-testid="outcome" /> }));

function open(card: KanbanCard, models = DEFAULT_SETTINGS.behavior.models) {
  act(() =>
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, behavior: { ...DEFAULT_SETTINGS.behavior, builderVendor: "claude", models } },
      loaded: true,
    }),
  );
  seedBoard([card]);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    withToasts: true,
    fixtures: {
      card_overlap_check: [],
      reviewer_list: [],
      verify_status: null,
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      ship_pending_release: { release: null, unreadable: null },
      card_review_tip: null,
      kanban_card_set_models: (args: Record<string, unknown>) => ({
        ...useKanban.getState().byWorkspace[BOARD_WS]!.cards[0]!,
        models: args.models ?? null,
      }),
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

// The card page puts focus on its Now title a frame after it opens; a test
// presses only once that has happened, as a person would.
const settle = () =>
  waitFor(() => expect(document.activeElement?.classList.contains("ux-callout-title")).toBe(true));

// 1.172.0 D2 (CP-25): the facts line is words; the pickers are behind its
// Change…, opened here the way a person does.
const facts = () => {
  let pickers = document.querySelector<HTMLElement>("[data-ply-card-pickers]");
  if (!pickers) {
    const change = document.querySelector<HTMLElement>("[data-ply-card-change]");
    if (change) act(() => change.click());
    pickers = document.querySelector<HTMLElement>("[data-ply-card-pickers]");
  }
  return within(pickers ?? document.querySelector<HTMLElement>(".ux-props")!);
};

describe("a card's own models (1.168.1 E2/E3)", () => {
  it("says the tool's default when nothing is chosen anywhere, the Reviewer's too before any build", () => {
    open(boardCard("c1", { notes: "Do it" }));
    expect(facts().getByRole("button", { name: /Builder model \(Claude\): the tool's default/ })).toBeTruthy();
    // V-1 leaves out the empty review word, not the Challenger's model.
    expect(facts().getByRole("button", { name: /Reviewer model \(Codex\): the tool's default/ })).toBeTruthy();
    expect(screen.queryByText("Not reviewed yet")).toBeNull();
  });

  // Walk 2026-10-22: Esc and a press outside closed the menu and dropped
  // the typed name; only Enter saved it.
  it.each([
    ["Esc", async (user: ReturnType<typeof open>["user"]) => user.keyboard("{Escape}")],
    ["a press outside", async (user: ReturnType<typeof open>["user"]) => user.click(document.body)],
    ["Tab", async (user: ReturnType<typeof open>["user"]) => user.keyboard("{Tab}")],
  ])("saves the typed model when %s leaves the field", async (_how, leave) => {
    const { user, tauri } = open(boardCard("c1", { notes: "Do it" }));
    await settle();
    await user.click(facts().getByRole("button", { name: /Builder model \(Claude\)/ }));
    await user.keyboard("  sonnet ");
    await leave(user);
    await waitFor(() => expect(tauri.callsOf("kanban_card_set_models")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_set_models")[0]!.args.models).toEqual({ claude: { builder: "sonnet" }, codex: {} });
    await waitFor(() => expect(facts().getByRole("button", { name: /Builder model \(Claude\): sonnet/ })).toBeTruthy());
  });

  it("saves nothing when the menu closes with the field as it was", async () => {
    const { user, tauri } = open(boardCard("c1", { notes: "Do it" }));
    await settle();
    await user.click(facts().getByRole("button", { name: /Builder model \(Claude\)/ }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(tauri.callsOf("kanban_card_set_models")).toHaveLength(0);
  });

  it("opens with the model field focused, by a press or by Enter", async () => {
    const { user } = open(boardCard("c1", { notes: "Do it" }));
    const chip = facts().getByRole("button", { name: /Builder model \(Claude\)/ });
    await settle();
    await user.click(chip);
    const field = () => screen.getByRole("textbox", { name: "Builder model (Claude) for this card" });
    await waitFor(() => expect(document.activeElement).toBe(field()));
    await user.keyboard("t");
    expect((field() as HTMLInputElement).value, "typing goes to the field").toBe("t");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(chip));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(field()));
  });

  it("keeps focus in the menu after Use the workspace's, so Esc closes only the menu", async () => {
    const { user, tauri } = open(
      boardCard("c1", { notes: "Do it", models: { claude: { builder: "sonnet" }, codex: {} } }),
    );
    await settle();
    await user.click(facts().getByRole("button", { name: /Builder model \(Claude\): sonnet/ }));
    const menu = screen.getByRole("dialog", { name: "Builder model (Claude) for this card" });
    await user.click(within(menu).getByRole("button", { name: "Use the workspace's" }));
    await waitFor(() => expect(tauri.callsOf("kanban_card_set_models")).toHaveLength(1));
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).toBe(within(menu).getByRole("textbox"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The card page is still open; nothing else was saved.
    expect(facts().getByRole("button", { name: /Builder model \(Claude\)/ })).toBeTruthy();
    expect(tauri.callsOf("kanban_card_set_models")).toHaveLength(1);
  });

  it("gives focus back to the chip when Esc closes the menu", async () => {
    const { user } = open(boardCard("c1", { notes: "Do it" }));
    const chip = facts().getByRole("button", { name: /Builder model \(Claude\)/ });
    await settle();
    await user.click(chip);
    await user.click(within(screen.getByRole("dialog", { name: "Builder model (Claude) for this card" })).getByRole("textbox"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Builder model (Claude) for this card" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(chip));
  });

  it("names a running review's model beside the next one", () => {
    open(
      boardCard("c1", {
        notes: "Do it",
        columnId: "in_progress",
        worktreePath: "/tmp/wt/c1",
        models: { claude: {}, codex: { challenger: "gpt-7" } },
        builder: {
          vendor: "claude",
          bypass: false,
          ptyId: null,
          sessionLost: true,
          startedAt: 1,
          snapshots: [],
          review: { provider: "codex", status: "running", model: "gpt-5.5", snapshotN: 1, at: 2, findings: [] },
        } as unknown as KanbanCard["builder"],
      }),
    );
    expect(facts().getByRole("button", { name: /Reviewer model \(Codex\): gpt-5.5 now · gpt-7 next/ })).toBeTruthy();
  });

  it("chooses the Builder's model for this card only, and goes back to the workspace's", async () => {
    const { user, tauri } = open(boardCard("c1", { notes: "Do it" }), {
      claude: { builder: "opus" },
      codex: {},
    });
    const chip = facts().getByRole("button", { name: /Builder model \(Claude\): opus/ });
    await settle();
    await user.click(chip);
    const menu = screen.getByRole("dialog", { name: "Builder model (Claude) for this card" });
    expect(within(menu).getByText(/from its next Builder session/)).toBeTruthy();
    expect(within(menu).getByText("Runs on opus (app default).")).toBeTruthy();
    const field = within(menu).getByRole("textbox", { name: "Builder model (Claude) for this card" });
    await user.type(field, "sonnet{Enter}");
    await waitFor(() => expect(tauri.callsOf("kanban_card_set_models")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_set_models")[0]!.args).toEqual({
      workspaceId: BOARD_WS,
      cardId: "c1",
      models: { claude: { builder: "sonnet" }, codex: {} },
    });
    await waitFor(() => expect(facts().getByRole("button", { name: /Builder model \(Claude\): sonnet/ })).toBeTruthy());
    expect(within(menu).getByText("Runs on sonnet (this card).")).toBeTruthy();

    await user.click(within(menu).getByRole("button", { name: "Use the workspace's" }));
    await waitFor(() => expect(tauri.callsOf("kanban_card_set_models")).toHaveLength(2));
    expect(tauri.callsOf("kanban_card_set_models")[1]!.args.models).toBeNull();
    await waitFor(() => expect(facts().getByRole("button", { name: /Builder model \(Claude\): opus/ })).toBeTruthy());
  });

  it("1.176.3: a name no list holds is asked about once; Save it anyway saves it, Keep writes nothing", async () => {
    const { user, tauri } = open(boardCard("c1", { notes: "Do it" }), { claude: { builder: "opus" }, codex: {} });
    tauri.fixture("model_catalog_get", {
      claude: { efforts: ["low", "high"], models: [{ id: "claude-opus-5-5", label: "Opus 5.5" }] },
      codex: { efforts: ["low"], models: [] },
      fileFrom: "bundled",
    });
    await settle();
    await user.click(facts().getByRole("button", { name: /Builder model \(Claude\): opus/ }));
    const menu = screen.getByRole("dialog", { name: "Builder model (Claude) for this card" });
    const field = within(menu).getByRole("textbox", { name: "Builder model (Claude) for this card" });
    await new Promise((r) => setTimeout(r, 50));
    await user.type(field, "claude-opus-5-55{Enter}");
    const sheet = await screen.findByRole("dialog", { name: "Save this model name?" });
    expect(sheet.textContent).toMatch(/for Builder model \(Claude\) for this card/);
    expect(screen.getAllByRole("dialog", { name: "Save this model name?" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Keep what was there" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save this model name?" })).toBeNull());
    expect(tauri.callsOf("kanban_card_set_models")).toHaveLength(0);
  });

  it("offers Codex's effort and names a running session's model beside the next one", async () => {
    const { user, tauri } = open(
      boardCard("c1", {
        notes: "Do it",
        columnId: "in_progress",
        worktreePath: "/tmp/wt/c1",
        models: { claude: {}, codex: { builder: "gpt-7" } },
        builder: { vendor: "codex", bypass: false, model: "gpt-5.5", ptyId: "p1", sessionLost: false, startedAt: 1, snapshots: [] } as unknown as KanbanCard["builder"],
      }),
    );
    const chip = facts().getByRole("button", { name: /Builder model \(Codex\): gpt-5.5 now · gpt-7 next/ });
    await settle();
    await user.click(chip);
    const menu = screen.getByRole("dialog", { name: "Builder model (Codex) for this card" });
    await user.selectOptions(within(menu).getByRole("combobox", { name: "Builder effort (Codex) for this card" }), "high");
    await waitFor(() => expect(tauri.callsOf("kanban_card_set_models")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_set_models")[0]!.args.models).toEqual({
      claude: {},
      codex: { builder: "gpt-7", builderReasoning: "high" },
    });
    // The Challenger is the other AI, on its own row.
    expect(facts().getByRole("button", { name: /Reviewer model \(Claude\): the tool's default/ })).toBeTruthy();
  });

  // 1.169.0 (A3, owner B): a settled verdict is re-reviewed once on another
  // model, on the vendor Rust names; the card's models stay.
  const reviewedCard = (review: object) =>
    boardCard("c1", {
      notes: "Do it",
      columnId: "in_progress",
      worktreePath: "/tmp/wt/c1",
      builder: {
        vendor: "claude",
        bypass: false,
        model: "claude-opus-5-5",
        ptyId: null,
        sessionLost: false,
        startedAt: 1,
        snapshots: [{ n: 1, sha: "abc", at: 2 }],
        review: { provider: "codex", snapshotN: 1, at: 3, findings: [], ...review },
      } as unknown as KanbanCard["builder"],
    });

  it("retries an approved review once on another model; the card's models stay", async () => {
    const { user, tauri } = open(reviewedCard({ status: "done", verdict: "approve", model: "gpt-6-astra medium" }));
    tauri.fixture("card_retry_plan", { vendor: "codex" });
    tauri.fixture("builder_review_retry", 1);
    await settle();
    expect(facts().getByRole("button", { name: "Retry on… another model for the Builder round (Claude)" })).toBeTruthy();
    await user.click(await facts().findByRole("button", { name: "Retry on… another model for the Reviewer round (Codex)" }));
    const menu = await screen.findByRole("dialog", { name: /Retry on… another model for the Reviewer round \(Codex\)/ });
    expect(within(menu).getByText("Reviews the same work again once on it. The card's own model stays as it is.")).toBeTruthy();
    const model = within(menu).getByRole("textbox", { name: "Retry model (Codex)" });
    await user.clear(model);
    await user.type(model, "gpt-6-luna");
    await user.selectOptions(within(menu).getByRole("combobox", { name: "Retry effort (Codex)" }), "high");
    await user.click(within(menu).getByRole("button", { name: "Retry the review" }));
    await waitFor(() => expect(tauri.callsOf("builder_review_retry")).toHaveLength(1));
    expect(tauri.callsOf("builder_review_retry")[0]!.args).toEqual({
      workspaceId: BOARD_WS,
      cardId: "c1",
      vendor: "codex",
      retry: { model: "gpt-6-luna", reasoning: "high" },
    });
    expect(tauri.callsOf("builder_review_again")).toHaveLength(0);
    expect(tauri.callsOf("kanban_card_set_models")).toHaveLength(0);
  });

  it("a refused retry says so once", async () => {
    const { user, tauri } = open(reviewedCard({ status: "failed" }));
    tauri.fixture("card_retry_plan", { vendor: "codex" });
    tauri.fixture("builder_review_retry", () => {
      throw new Error("The Reviewer is already reviewing this card");
    });
    await settle();
    await user.click(await facts().findByRole("button", { name: "Retry on… another model for the Reviewer round (Codex)" }));
    const menu = await screen.findByRole("dialog", { name: /Reviewer round/ });
    await user.click(within(menu).getByRole("button", { name: "Retry the review" }));
    await waitFor(() => expect(tauri.callsOf("builder_review_retry")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByText(/already reviewing this card/).length).toBe(1));
  });

  it("the Builder's retry starts a new session with its choice, and only that start carries it", async () => {
    const { user, tauri } = open(reviewedCard({ status: "done", verdict: "approve" }));
    tauri.fixture("card_retry_plan", { vendor: "codex" });
    await settle();
    await user.click(facts().getByRole("button", { name: "Retry on… another model for the Builder round (Claude)" }));
    const menu = await screen.findByRole("dialog", { name: /Builder round/ });
    expect(within(menu).getByText("Starts a new session on the work already in the card's copy. The card's own model stays as it is.")).toBeTruthy();
    const model = within(menu).getByRole("textbox", { name: "Retry model (Claude)" });
    await user.clear(model);
    await user.type(model, "claude-sonnet-5-5");
    await user.selectOptions(within(menu).getByRole("combobox", { name: "Retry effort (Claude)" }), "max");
    await user.click(within(menu).getByRole("button", { name: "Retry the Builder" }));
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("builder_start")[0]!.args).toMatchObject({ retry: { model: "claude-sonnet-5-5", reasoning: "max" } });
  });

  it("hides Retry on… for a session lost on a restart and a record no session ran in", () => {
    const lost = reviewedCard({ status: "done", verdict: "approve" });
    lost.builder!.sessionLost = true;
    lost.builder!.lostOnRestart = true;
    open(lost);
    expect(facts().queryByRole("button", { name: /Retry on… another model for the Builder round/ })).toBeNull();
  });

  // 1.169.0 (A2): the team's suggestion reaches the chip, named as the team's.
  it("names the team's suggestion on the chip and in the menu", async () => {
    const view = open(boardCard("c1", { notes: "Do it" }));
    view.tauri.fixture("team_models_get", {
      shared: true,
      readOnly: false,
      models: { claude: { builder: "claude-opus-5-5", builderReasoning: "high" } },
    });
    const { useTeamModelsStore } = await import("../store/teamModelsStore");
    await act(() => useTeamModelsStore.getState().load(BOARD_WS));
    await waitFor(() =>
      expect(facts().getByRole("button", { name: /Builder model \(Claude\): claude-opus-5-5 high · Team/ })).toBeTruthy(),
    );
    await settle();
    await view.user.click(facts().getByRole("button", { name: /Builder model \(Claude\)/ }));
    const menu = screen.getByRole("dialog", { name: "Builder model (Claude) for this card" });
    expect(within(menu).getByText("Runs on claude-opus-5-5 (team), high effort (team).")).toBeTruthy();
  });

  // 1.169.0 (A1): Claude's effort on the card, and the chip says it.
  it("offers Claude's effort for this card and the chip shows it", async () => {
    const { user, tauri } = open(boardCard("c1", { notes: "Do it", models: { claude: { builder: "opus" }, codex: {} } }));
    await settle();
    await user.click(facts().getByRole("button", { name: /Builder model \(Claude\): opus/ }));
    const menu = screen.getByRole("dialog", { name: "Builder model (Claude) for this card" });
    const effort = within(menu).getByRole("combobox", { name: "Builder effort (Claude) for this card" }) as HTMLSelectElement;
    expect([...effort.options].map((o) => o.value)).toEqual(["", "The tool's default", "low", "medium", "high", "xhigh", "max"]);
    await user.selectOptions(effort, "xhigh");
    await waitFor(() => expect(tauri.callsOf("kanban_card_set_models")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_set_models")[0]!.args.models).toEqual({
      claude: { builder: "opus", builderReasoning: "xhigh" },
      codex: {},
    });
    await waitFor(() => expect(facts().getByRole("button", { name: /Builder model \(Claude\): opus xhigh/ })).toBeTruthy());
  });

  it("names what the session and the review ran on under Technical details, the tool's default included", () => {
    open(
      boardCard("c1", {
        notes: "Do it",
        columnId: "in_progress",
        worktreePath: "/tmp/wt/c1",
        builder: {
          vendor: "claude",
          bypass: false,
          model: null,
          ptyId: null,
          sessionLost: true,
          startedAt: 1,
          snapshots: [],
          review: { provider: "codex", status: "done", verdict: "approved", model: "gpt-5.5 medium", snapshotN: 1, at: 2, findings: [] },
        } as unknown as KanbanCard["builder"],
      }),
    );
    const details = within(screen.getByText("Technical").closest("details")!);
    const row = (label: string) => details.getByText(label).nextElementSibling?.textContent;
    expect(row("Builder model")).toBe("the tool's default");
    expect(row("Reviewer model")).toBe("gpt-5.5, medium effort");
  });
});
