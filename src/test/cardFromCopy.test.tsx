// 1.173.0 A3 walk fix (a, b): a card made from a copy waits in Not started
// and its page says the work in its copy is its own — what changed there and
// that Start build carries on with it.
import { describe, expect, it } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { useUi } from "../store/uiStore";
import { useSettings } from "../store/settingsStore";
import { useKanban } from "../store/kanbanStore";
import { useToasts } from "../store/toastStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, fireEvent, renderUi, screen, waitFor, within } from "./render";

describe("a card made from a copy", () => {
  it("says, in Now, the copy's work and what Start build does with it", async () => {
    const card = boardCard("c-copy", {
      title: "walk-copy-2",
      notes: "Made from the copy “walk-copy-2” in Terminals. The work done there so far is in this card's copy.",
      columnId: "todo",
      worktreePath: "/Users/someone/code/lyra/.plyloft-worktrees/copy-92e59440",
      branchName: "plyloft/copy-92e59440-walk-copy-2",
      fromCopy: { id: "copy-92e59440", name: "walk-copy-2" },
    });
    act(() => {
      seedBoard([card]);
      useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
    });
    const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      fixtures: { card_copy_changes: { count: 1, files: ["two.txt"] } },
    });
    view.tauri.allowUnhandled();
    const now = within(await screen.findByRole("region", { name: "Now" }));
    await waitFor(() =>
      expect(
        now.getByText(
          "Made from the copy “walk-copy-2”, with the work done there. 1 file changed: two.txt. Start build carries on with it; then the Reviewer and your checks look at it.",
        ),
      ).toBeTruthy(),
    );
    expect(now.getByRole("button", { name: "Start build" })).toBeTruthy();
    expect(view.tauri.callsOf("card_copy_changes")[0].args).toMatchObject({ workspaceId: BOARD_WS, cardId: "c-copy" });
  });

  // 1.174.0 C4 (P17): the brief starts empty, with the cursor in it, and
  // Start build waits for it, saying why; Activity says where it came from.
  it("starts with an empty brief: Start build off with its reason, no Verify", async () => {
    const card = boardCard("c-empty", {
      title: "Pricing: drop the third plan card",
      notes: "",
      columnId: "todo",
      worktreePath: "/Users/someone/code/lyra/.plyloft-worktrees/copy-5e6f7a8b",
      branchName: "plyloft/copy-5e6f7a8b-win-copy-1",
      fromCopy: { id: "copy-5e6f7a8b", name: "win-copy-1" },
    });
    act(() => {
      seedBoard([card]);
      useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
    });
    const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      fixtures: { card_copy_changes: { count: 3, files: ["a.html", "b.css", "c.ts"] } },
    });
    view.tauri.allowUnhandled();
    const nowRegion = await screen.findByRole("region", { name: "Now" });
    const now = within(nowRegion);
    expect(now.getByText("Ready to start, once you say what you want")).toBeTruthy();
    await waitFor(() => expect(nowRegion.textContent).toContain("3 files changed"));
    expect(nowRegion.textContent).toContain("Start build carries on with it; then the Reviewer and your checks look at it.");
    expect(nowRegion.textContent).toContain("Say what the Builder should do first.");
    expect(nowRegion.textContent).not.toMatch(/Verify/);
    const start = now.getByRole("button", { name: "Start build" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    const brief = screen.getByRole("textbox", { name: "What you want" }) as HTMLTextAreaElement;
    expect(brief.value).toBe("");
    expect(brief.placeholder).toBe("What should the Builder do with the work in “win-copy-1”?");
    await waitFor(() => expect(document.activeElement).toBe(brief));
    // 1.174.0 (C1): not built yet, so the brief leads, never folded.
    expect(document.querySelector(".ux-card-brief-fold")).toBeNull();
    expect(brief.closest("[data-ply-card-brief-block='first']")).toBeTruthy();
    expect(screen.getByText("Made from the copy “win-copy-1” in Terminals")).toBeTruthy();
    // G3a walk: every Start build on the page holds — The run's too — with
    // the same reason beside it.
    // (The run is mounted always, shown when opened — the toast's Open the card opens it.)
    const starts = screen.getAllByRole("button", { name: "Start build", hidden: true }) as HTMLButtonElement[];
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts.every((b) => b.disabled)).toBe(true);
    expect(document.querySelector("[data-ply-start-held-reason]")?.textContent).toBe("Say what the Builder should do first.");
    // Once written, Start build is on again.
    fireEvent.change(brief, { target: { value: "Keep two plans" } });
    await waitFor(() => expect((now.getByRole("button", { name: "Start build" }) as HTMLButtonElement).disabled).toBe(false));
    expect(nowRegion.textContent).not.toContain("Say what the Builder should do first.");
    expect((screen.getAllByRole("button", { name: "Start build", hidden: true }) as HTMLButtonElement[]).every((b) => !b.disabled)).toBe(true);
    expect(document.querySelector("[data-ply-start-held-reason]")).toBeNull();
  });

  // C4 round 1: the Board's move doesn't start it either.
  it("the Board's move to Working is refused while the brief is empty", async () => {
    const card = boardCard("c-drag", {
      title: "Pricing: drop the third plan card",
      notes: "",
      columnId: "todo",
      fromCopy: { id: "copy-5e6f7a8b", name: "win-copy-1" },
    });
    act(() => seedBoard([card]));
    const view = renderUi(<div />);
    view.tauri.allowUnhandled();
    await act(() => useKanban.getState().moveCard("c-drag", "in_progress"));
    expect(view.tauri.callsOf("kanban_card_advance_to_in_progress")).toHaveLength(0);
    const toast = useToasts.getState().toasts.find((t) => t.title === "Say what the Builder should do first.");
    expect(toast?.kind).toBe("warn");
    expect(useKanban.getState().byWorkspace[BOARD_WS].cards.find((c) => c.id === "c-drag")!.columnId).toBe("todo");
  });

  // C4 round 1: typed, then pressed before any save — the brief reaches the
  // card before the build starts (Rust's start_refusal reads it).
  it("saves the typed brief before Start build starts", async () => {
    const card = boardCard("c-race", {
      title: "Pricing: drop the third plan card",
      notes: "",
      columnId: "todo",
      worktreePath: "/Users/someone/code/lyra/.plyloft-worktrees/copy-5e6f7a8b",
      branchName: "plyloft/copy-5e6f7a8b-win-copy-1",
      fromCopy: { id: "copy-5e6f7a8b", name: "win-copy-1" },
    });
    act(() => {
      seedBoard([card]);
      useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
    });
    let saved: (v: unknown) => void = () => {};
    const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      fixtures: {
        card_copy_changes: { count: 1, files: ["a.html"] },
        kanban_card_patch: (args: Record<string, unknown>) =>
          new Promise((resolve) => (saved = () => resolve({ ...card, ...(args.patch as object) }))),
      },
    });
    view.tauri.allowUnhandled();
    const now = within(await screen.findByRole("region", { name: "Now" }));
    const brief = screen.getByRole("textbox", { name: "What you want" });
    fireEvent.change(brief, { target: { value: "Keep two plans" } });
    const start = await waitFor(() => {
      const b = now.getByRole("button", { name: "Start build" }) as HTMLButtonElement;
      expect(b.disabled).toBe(false);
      return b;
    });
    fireEvent.click(start);
    await waitFor(() => expect(view.tauri.callsOf("kanban_card_patch")).toHaveLength(1));
    expect(view.tauri.callsOf("kanban_card_patch")[0].args).toMatchObject({ patch: { notes: "Keep two plans" } });
    expect(view.tauri.callsOf("builder_start")).toHaveLength(0);
    // Round 3: while it saves, the press says so and can't run twice.
    await waitFor(() => {
      const busy = now.getByRole("button", { name: "Starting…" }) as HTMLButtonElement;
      expect(busy.disabled).toBe(true);
    });
    fireEvent.click(now.getByRole("button", { name: "Starting…" }));
    expect(view.tauri.callsOf("kanban_card_patch")).toHaveLength(1);
    await act(async () => saved(undefined));
    await waitFor(() => expect(view.tauri.callsOf("builder_start")).toHaveLength(1));
  });

  // C4 approval: a save the store hands back trimmed (a GitHub reconcile)
  // still starts.
  it("starts when the saved brief comes back trimmed", async () => {
    const card = boardCard("c-trim", {
      title: "Pricing: drop the third plan card",
      notes: "",
      columnId: "todo",
      worktreePath: "/Users/someone/code/lyra/.plyloft-worktrees/copy-5e6f7a8b",
      branchName: "plyloft/copy-5e6f7a8b-win-copy-1",
      fromCopy: { id: "copy-5e6f7a8b", name: "win-copy-1" },
    });
    act(() => {
      seedBoard([card]);
      useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
    });
    const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      fixtures: {
        card_copy_changes: { count: 1, files: ["a.html"] },
        kanban_card_patch: (args: Record<string, unknown>) => {
          const notes = String((args.patch as { notes?: string }).notes ?? "");
          return { ...card, notes: notes.trim() };
        },
      },
    });
    view.tauri.allowUnhandled();
    const now = within(await screen.findByRole("region", { name: "Now" }));
    fireEvent.change(screen.getByRole("textbox", { name: "What you want" }), { target: { value: "Keep two plans\n" } });
    const start = await waitFor(() => {
      const b = now.getByRole("button", { name: "Start build" }) as HTMLButtonElement;
      expect(b.disabled).toBe(false);
      return b;
    });
    fireEvent.click(start);
    await waitFor(() => expect(view.tauri.callsOf("kanban_card_patch")).toHaveLength(1));
    expect(view.tauri.callsOf("kanban_card_patch")[0].args).toMatchObject({ patch: { notes: "Keep two plans\n" } });
    await waitFor(() => expect(view.tauri.callsOf("builder_start")).toHaveLength(1));
  });

  // C4 round 3: a save that didn't land never starts on the old brief.
  it("doesn't start when the typed brief couldn't be saved", async () => {
    const card = boardCard("c-fail", {
      title: "Pricing: drop the third plan card",
      notes: "",
      columnId: "todo",
      worktreePath: "/Users/someone/code/lyra/.plyloft-worktrees/copy-5e6f7a8b",
      branchName: "plyloft/copy-5e6f7a8b-win-copy-1",
      fromCopy: { id: "copy-5e6f7a8b", name: "win-copy-1" },
    });
    act(() => {
      seedBoard([card]);
      useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
    });
    const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      fixtures: {
        card_copy_changes: { count: 1, files: ["a.html"] },
        kanban_card_patch: () => Promise.reject(new Error("disk full")),
        kanban_load: [card],
      },
    });
    view.tauri.allowUnhandled();
    const now = within(await screen.findByRole("region", { name: "Now" }));
    fireEvent.change(screen.getByRole("textbox", { name: "What you want" }), { target: { value: "Keep two plans" } });
    const start = await waitFor(() => {
      const b = now.getByRole("button", { name: "Start build" }) as HTMLButtonElement;
      expect(b.disabled).toBe(false);
      return b;
    });
    fireEvent.click(start);
    await waitFor(() => expect(view.tauri.callsOf("kanban_card_patch")).toHaveLength(1));
    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.title === "The change to the card wasn't saved")).toBe(true),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(view.tauri.callsOf("builder_start")).toHaveLength(0);
  });

  it("says so first even as the tour's first card (Windows walk)", async () => {
    const card = boardCard("c-first", {
      title: "win-copy",
      notes: "Made from the copy “win-copy” in Terminals. The work done there so far is in this card's copy.",
      columnId: "todo",
      createdAt: Date.now(),
      worktreePath: "C:/Users/someone/lyra/.plyloft-worktrees/copy-1a2b3c4d",
      branchName: "plyloft/copy-1a2b3c4d-win-copy",
      fromCopy: { id: "copy-1a2b3c4d", name: "win-copy" },
    });
    const before = useSettings.getState().settings;
    act(() => {
      seedBoard([card]);
      useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
      useSettings.setState({
        settings: {
          ...before,
          onboarding: {
            ...before.onboarding,
            tutorial: { workspaceId: BOARD_WS, cardId: card.id, startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: null, done: {} } as never,
          },
        },
      });
    });
    try {
      const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
        fixtures: { card_copy_changes: { count: 1, files: ["win.txt"] } },
      });
      view.tauri.allowUnhandled();
      const now = within(await screen.findByRole("region", { name: "Now" }));
      await waitFor(() => expect(now.getByText(/Made from the copy “win-copy”, with the work done there\. 1 file changed: win\.txt\./)).toBeTruthy());
      expect(now.queryByText(/For this first card/)).toBeNull();
    } finally {
      act(() => useSettings.setState({ settings: before }));
    }
  });
});
