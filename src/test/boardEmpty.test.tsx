// GH #251: an empty Board has one primary — the header's New card. The hero
// is a heading, an outcome sentence and a quiet field Enter starts; nothing
// to switch, find or filter; no glyphs; its rules sit on the one scale.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { KanbanBoard } from "../components/KanbanBoard";
import { useKanban } from "../store/kanbanStore";
import { useSettings } from "../store/settingsStore";
import { act, renderUi, screen, within } from "./render";
import { seedBoard, BOARD_WS } from "./boardFixtures";

describe("the empty Board (GH #251)", () => {
  it("has one accent button, no view/search/filter, and no glyphs", async () => {
    act(() => seedBoard([]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    const hero = document.querySelector("[data-board-empty]") as HTMLElement;
    expect(hero).not.toBeNull();
    // 1.176.3: while the Board is empty the box in the middle holds the one
    // filled button; the header's New card (the tour's anchor) is not filled.
    expect(document.querySelectorAll(".cbtn--accent")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "New card" }).className).not.toContain("cbtn--accent");
    expect(screen.getByRole("button", { name: "New card" }).getAttribute("data-ply-tour")).toBe("board-new-card");
    expect(screen.getByRole("button", { name: "Make the card" }).className).toContain("cbtn--accent");
    expect(screen.queryByRole("radiogroup", { name: "View" })).toBeNull();
    expect(screen.queryByRole("radio", { name: /^(Board|List)$/ }) ?? screen.queryByRole("button", { name: /^(Board|List)$/ })).toBeNull();
    expect(screen.queryByPlaceholderText("Find a card")).toBeNull();
    expect(screen.queryByRole("button", { name: /Filter/i })).toBeNull();
    expect(hero.textContent).not.toMatch(/[✦→…]/);
    expect(hero.textContent).toContain(
      "Write one sentence, then press Enter. Plyloft makes the card and opens it. You add details there.",
    );

    let added = "";
    let notes: string | undefined;
    act(() =>
      useKanban.setState({
        addCard: (async (_ws: string, title: string, n?: string) => {
          added = title;
          notes = n;
          return { id: "new" };
        }) as never,
      }),
    );
    const field = screen.getByRole("textbox", { name: "What do you want to build?" });
    await r.user.type(field, "Export reports as CSV{Enter}");
    expect(added).toBe("Export reports as CSV");
    expect(notes).toBeUndefined();

    // Team walk 2026-10-01 (F10): a paragraph names the card by its first
    // sentence and goes whole into What you want.
    const para = "Add dark mode. It should follow the system setting.";
    await r.user.type(field, `${para}{Enter}`);
    expect(added).toBe("Add dark mode");
    expect(notes).toBe(para);
  });

  // 1.174.0 (A6, G16, D2c; mockups/board.html 5a, 6).
  it("a new person's empty Board: no Next improvement, the hero makes the card, ⋯ › Next improvement… shows the line", async () => {
    act(() => seedBoard([]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    r.tauri.allowUnhandled();
    const make = screen.getByRole("button", { name: "Make the card" });
    expect(make.getAttribute("title")).toBe("Make a card from this; nothing starts until you press Start build");
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("region", { name: "Next improvement" })).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    const item = screen.getByRole("menuitem", { name: /^Next improvement…/ });
    expect(item.textContent).toContain(
      "Ideas for this project, one at a time. It opens above the Board by itself once a card has shipped.",
    );
    expect(screen.queryByRole("menuitem", { name: /Show Next improvement/ })).toBeNull();
    await r.user.click(item);
    const ni = await screen.findByRole("region", { name: "Next improvement" });
    expect(within(ni).getByText(/often one idea, sometimes none · a few minutes/)).toBeTruthy();
  });

  it("after the first shipped card on this Mac: the line by itself, and no Next improvement… in the ⋯", async () => {
    act(() => seedBoard([]));
    act(() =>
      useSettings.setState((s) => ({
        settings: { ...s.settings, nextImprovement: { view: {}, firstCardShippedAt: "2026-10-01T09:00:00.000Z" } },
      })),
    );
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    r.tauri.allowUnhandled();
    expect(await screen.findByRole("region", { name: "Next improvement" })).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    expect(screen.queryByRole("menuitem", { name: /^Next improvement…/ })).toBeNull();
  });

  it("styles the hero from tokens only", () => {
    const board = readFileSync("src/components/board.css", "utf8");
    const at = board.indexOf(".board-empty {");
    expect(at).toBeGreaterThan(0);
    const rules = board.slice(at, board.indexOf("/*", at + 1) === -1 ? undefined : board.indexOf("/*", at + 1));
    expect(rules).not.toMatch(/font-size:\s*\d|border-radius:\s*\d|--text-(md|sm)/);
    expect(readFileSync("src/App.css", "utf8")).not.toContain(".kanban-empty-");
  });
});
