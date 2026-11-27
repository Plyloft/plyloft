// 1.172.0 (A1): what the person told the Builder after the first result is
// kept on the card — "Asked later (n)" under What you want, with each one's
// words and time, removable until the card is done — and the chat's "Not
// right — tell the Builder" keeps it once it reached the Builder. Only Tauri
// is a stub; the stores and the component are the app's.
import { describe, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { LaterRequests } from "../components/LaterRequests";
import type { KanbanCard, LaterRequest } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { useBuilder } from "../store/builderStore";
import { renderUi, screen } from "./render";

const WS = "ws-1";

const asked: LaterRequest[] = [
  { id: "lr-1", text: "also add a comment at the top of the changed file", at: new Date(2026, 9, 27, 21, 14).getTime(), source: "chat" },
  { id: "lr-2", text: "and say it in the changelog", at: new Date(2026, 9, 27, 21, 30).getTime(), source: "notRight" },
];

const card: KanbanCard = {
  id: "card-1",
  workspaceId: WS,
  title: "Add a line",
  columnId: "in_progress",
  builder: { vendor: "claude", ptyId: "pty-1", snapshots: [] } as unknown as KanbanCard["builder"],
  laterRequests: asked,
  createdAt: 1,
  updatedAt: 1,
} as KanbanCard;

function seed(c: KanbanCard) {
  useKanban.setState({ byWorkspace: { [WS]: { cards: [c], loaded: true } } } as never);
}

function Mounted({ done }: { done: boolean }) {
  const c = useKanban((s) => s.byWorkspace[WS]?.cards[0]);
  return c ? <LaterRequests card={c} readOnly={done} /> : null;
}


describe("Asked later on the card (A1)", () => {
  it("lists each request's words, time and where it was asked", () => {
    seed(card);
    renderUi(<Mounted done={false} />);
    expect(screen.getByRole("heading", { name: "Asked later (2)" })).toBeTruthy();
    expect(screen.getByText("also add a comment at the top of the changed file")).toBeTruthy();
    expect(screen.getByText(/27 Oct, 21:14 · from Ask about this card/)).toBeTruthy();
    expect(screen.getByText(/27 Oct, 21:30 · from Not right/)).toBeTruthy();
    expect(screen.getByText(/The Reviewer checks the work against these too/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Asked later (2)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: 'Remove "also add a comment at the top of the cha…"' })).toBeTruthy();
    expect(screen.getByRole("button", { name: 'Remove "and say it in the changelog"' })).toBeTruthy();
  });

  it("shows nothing on a card without any", () => {
    seed({ ...card, laterRequests: undefined });
    const { container } = renderUi(<Mounted done={false} />);
    expect(container.querySelector("[data-ply-card-later]")).toBeNull();
  });

  it("removes one through the card's own write", async () => {
    seed(card);
    const { tauri } = renderUi(<Mounted done={false} />, {
      fixtures: { kanban_card_remove_later_request: () => ({ ...card, laterRequests: [asked[1]] }) },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Remove "also add a comment/ }));
    await waitFor(() => expect(tauri.callsOf("kanban_card_remove_later_request")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_remove_later_request")[0].args).toEqual({ workspaceId: WS, cardId: "card-1", requestId: "lr-1" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Asked later (1)" })).toBeTruthy());
    expect(tauri.calls.some((c) => /gh|github/.test(c.cmd))).toBe(false);
  });

  it("is read-only once the card is done, or on a team board this Mac can't write", () => {
    seed(card);
    renderUi(<Mounted done />);
    expect(screen.getByRole("heading", { name: "Asked later (2)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });
});

describe("a message to the Builder with the person's words (A1)", () => {
  function session() {
    seed({ ...card, laterRequests: undefined });
    useBuilder.getState().attach(card.id, WS, "pty-1", "claude");
    useBuilder.getState().markPromptBox(card.id, true);
  }

  it("keeps them on the card once sent", async () => {
    session();
    const { tauri } = renderUi(<Mounted done={false} />, {
      fixtures: {
        pty_write: null,
        kanban_card_add_later_request: ({ text, source }: Record<string, unknown>) => ({
          ...card,
          laterRequests: [{ id: "lr-9", text, at: 5, source }],
        }),
      },
    });
    const outcome = await useBuilder.getState().askBuilder(WS, card.id, "Make this change: also add a comment", {
      sentBody: "Sent.",
      markSent: true,
      key: "chat-tell-builder",
      laterRequest: { text: "also add a comment", source: "chat" },
    });
    expect(outcome).toBe("sent");
    expect(tauri.callsOf("kanban_card_add_later_request")[0].args).toEqual({
      workspaceId: WS,
      cardId: card.id,
      text: "also add a comment",
      source: "chat",
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Asked later (1)" })).toBeTruthy());
    useBuilder.setState({ changesSent: {} });
  });

  it("keeps nothing when it didn't reach the Builder", async () => {
    seed({ ...card, laterRequests: undefined, builder: null } as unknown as KanbanCard);
    const { tauri } = renderUi(<Mounted done={false} />, { fixtures: { builder_resume: () => { throw new Error("no copy"); } } });
    const outcome = await useBuilder.getState().askBuilder(WS, card.id, "x", {
      sentBody: "Sent.",
      markSent: true,
      key: "chat-tell-builder",
      laterRequest: { text: "x", source: "chat" },
    });
    expect(outcome).toBe("failed");
    expect(tauri.callsOf("kanban_card_add_later_request")).toHaveLength(0);
  });
});
