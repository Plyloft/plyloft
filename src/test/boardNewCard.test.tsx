// QoL 1.168 (block 5.4: C9, C10, part of C6): a new card without surprises —
// it is brought into view where it lands, its text is kept when creating it
// fails, ⌘↵ adds and opens it (the field says so), and ⌘⇧N is New card.
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { useKanban } from "../store/kanbanStore";
import { useUi } from "../store/uiStore";
import { matchShortcut, shortcutKeys, SHORTCUTS } from "../lib/shortcuts";
import { setPlatformForTests } from "../lib/platform";
import { NEW_CARD_HERO_HINT } from "../lib/boardCommands";
import { act, renderUi, screen, waitFor } from "./render";
import { boardCard, seedBoard, BOARD_WS } from "./boardFixtures";

describe("a new card (QoL 1.168 block 5.4)", () => {
  it("C10: the empty Board's text stays when the card can't be made, with the error under it", async () => {
    act(() => seedBoard([]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    act(() =>
      useKanban.setState({
        addCard: (async () => {
          throw new Error("disk full");
        }) as never,
      }),
    );
    const field = screen.getByRole("textbox", { name: "What do you want to build?" }) as HTMLInputElement;
    await r.user.type(field, "Export reports as CSV{Enter}");
    expect(field.value).toBe("Export reports as CSV");
    expect((await screen.findByRole("alert")).textContent).toMatch(/The card wasn't added\. Your text is still here/);
  });

  it("C10: the column's field opens again with the title when the card can't be made", async () => {
    act(() => seedBoard([boardCard("a", { title: "Existing" })]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    act(() =>
      useKanban.setState({
        addCard: (async () => {
          throw new Error("disk full");
        }) as never,
      }),
    );
    await r.user.click(screen.getByRole("button", { name: "New card" }));
    const field = await screen.findByRole("textbox", { name: "New card title" });
    expect(screen.getByText(/^Enter adds it · ⌘↵ adds it and opens it$/)).toBeTruthy();
    await r.user.type(field, "Add a search box{Enter}");
    const again = (await screen.findByRole("textbox", { name: "New card title" })) as HTMLInputElement;
    await waitFor(() => expect(again.value).toBe("Add a search box"));
    expect(screen.getByRole("alert").textContent).toMatch(/The card wasn't added/);
  });

  it("C10: a failure that lands while the next card's field is open leaves that field's text alone", async () => {
    act(() => seedBoard([boardCard("a", { title: "Existing" })]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    let fail: (e: Error) => void = () => {};
    act(() =>
      useKanban.setState({
        addCard: (() => new Promise((_resolve, reject) => (fail = reject))) as never,
      }),
    );
    await r.user.click(screen.getByRole("button", { name: "New card" }));
    await r.user.type(await screen.findByRole("textbox", { name: "New card title" }), "First{Enter}");
    await r.user.click(screen.getByRole("button", { name: "New card" }));
    const next = (await screen.findByRole("textbox", { name: "New card title" })) as HTMLInputElement;
    await r.user.type(next, "Second");
    await act(async () => fail(new Error("disk full")));
    expect(next.value).toBe("Second");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("C9: a card made in the column is marked where it lands; ⌘↵ adds and opens it", async () => {
    act(() => seedBoard([boardCard("a", { title: "Existing" })]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    let n = 0;
    act(() =>
      useKanban.setState({
        addCard: (async (_ws: string, title: string) => {
          n += 1;
          const card = boardCard(`new-${n}`, { title });
          act(() => seedBoard([...(useKanban.getState().byWorkspace[BOARD_WS]?.cards ?? []), card]));
          return card;
        }) as never,
      }),
    );
    await r.user.click(screen.getByRole("button", { name: "New card" }));
    await r.user.type(await screen.findByRole("textbox", { name: "New card title" }), "Show a counter{Enter}");
    await waitFor(() =>
      expect(document.querySelector('[data-board-card-id="new-1"]')?.className).toContain("board-card--arrived"),
    );
    // 1.171.0 (E2): and read out where it landed.
    expect(screen.getByText("Card “Show a counter” added to Not started.").getAttribute("aria-live")).toBe("polite");
    expect(useUi.getState().selectedCardId[BOARD_WS] ?? null).toBeNull();

    await r.user.click(screen.getByRole("button", { name: "New card" }));
    await r.user.type(await screen.findByRole("textbox", { name: "New card title" }), "Open me{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("new-2"));
  });

  // 1.171.0 (E2; walk 2026-10-27 #2): New card on the empty Board did
  // nothing anyone could see — only the field took the keyboard.
  it("E2: New card on the empty Board marks its field and says what to do next", async () => {
    act(() => seedBoard([]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    const field = screen.getByRole("textbox", { name: "What do you want to build?" });
    expect(screen.queryByText(NEW_CARD_HERO_HINT)).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "New card" }));
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(document.querySelector(".board-empty-field")?.className).toContain("board-empty-field--asked");
    const hint = screen.getByText(NEW_CARD_HERO_HINT);
    expect(hint.getAttribute("aria-live")).toBe("polite");
  });

  it("C6: ⌘⇧N is New card, listed with the shortcuts (Ctrl+Shift+N on Windows)", () => {
    const entry = SHORTCUTS.find((s) => s.id === "newCard")!;
    expect(entry.label).toBe("New card (on the Board)");
    expect(matchShortcut({ key: "N", metaKey: true, shiftKey: true, altKey: false })).toBe("newCard");
    expect(matchShortcut({ key: "n", metaKey: true, shiftKey: false, altKey: false })).toBeNull();
    expect(shortcutKeys("newCard")).toBe("⌘⇧N");
    setPlatformForTests("windows");
    try {
      expect(shortcutKeys("newCard")).toBe("Ctrl+Shift+N");
      expect(matchShortcut({ key: "N", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false }, { inTerminal: true })).toBe("newCard");
    } finally {
      setPlatformForTests(null);
    }
  });
});

// 1.172.0 Mac walk A+B (E1): a card made and opened with ⌘↵ had no Builder
// combobox for assistive tech until it was opened again. The page is one
// mount per workspace, shared by every card it shows: what was open on the
// card before (its pickers) is not carried to the new one, and the new
// card's Change… exposes the Builder field at once.
describe("⌘↵: the new card's page, as a screen reader finds it", () => {
  const fixtures = {
    card_overlap_check: [],
    reviewer_list: [],
    verify_status: null,
    improvement_proposal_state: null,
    improvement_proposal_trust_stopped: null,
    ship_pending_release: { release: null, unreadable: null },
    card_review_tip: null,
  };

  it("has the Builder field behind Change…, named and reachable, on the first open", async () => {
    act(() => {
      seedBoard([boardCard("a", { title: "Existing" })]);
      useUi.setState({ selectedCardId: { [BOARD_WS]: "a" }, centerMode: { [BOARD_WS]: "board" } });
    });
    let n = 0;
    const r = renderUi(
      <>
        <KanbanBoard workspaceId={BOARD_WS} />
        <CardDetailPanel workspaceId={BOARD_WS} />
      </>,
      { fixtures },
    );
    r.tauri.allowUnhandled();
    act(() =>
      useKanban.setState({
        addCard: (async (_ws: string, title: string) => {
          n += 1;
          const card = boardCard(`new-${n}`, { title });
          act(() => seedBoard([...(useKanban.getState().byWorkspace[BOARD_WS]?.cards ?? []), card]));
          return card;
        }) as never,
      }),
    );
    // The card open before had its pickers and its Details open.
    const changeOn = () => document.querySelector<HTMLElement>("[data-ply-card-change]")!;
    const details = () => document.querySelector<HTMLDetailsElement>("details[data-ply-self-check-disclosure]")!;
    await r.user.click(changeOn());
    expect(screen.getByRole("combobox", { name: "Builder" })).toBeTruthy();
    await r.user.click(details().querySelector("summary")!);
    await waitFor(() => expect(details().open).toBe(true));
    // Back to the Board; ⌘↵ adds the next card and opens it.
    act(() => useUi.getState().selectCard(BOARD_WS, null, false));
    await r.user.click(screen.getByRole("button", { name: "New card" }));
    await r.user.type(await screen.findByRole("textbox", { name: "New card title" }), "Count words{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("new-1"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Count words" })).toBeTruthy());
    // Nothing chosen is open yet on the new card: no pickers, no Details.
    expect(document.querySelector("[data-ply-card-pickers]")).toBeNull();
    expect(details().open).toBe(false);
    const change = changeOn();
    expect(change.getAttribute("aria-expanded")).toBe("false");
    await r.user.click(change);
    const builder = screen.getByRole("combobox", { name: "Builder" }) as HTMLSelectElement;
    expect([...builder.options].map((o) => o.value)).toEqual(["claude", "codex"]);
    expect(builder.closest("[aria-hidden='true'], [inert]")).toBeNull();
  });
});
