// 1.172.2 D5: a file dropped anywhere on a card page joins the card's Files.
// Before, only the Files area took a drop — and it sits inside the card's
// closed Details, so on an open card a drop met the guard with nowhere to go.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent } from "@testing-library/react";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { CARD_PAGE_DROP_LABEL, CARD_PAGE_LEAVE_MS } from "../components/CardMore";
import { HINT_IDLE_MS } from "../lib/dropGuard";
import type { CardAttachment } from "../ipc";
import { useBuilder } from "../store/builderStore";
import { useUi } from "../store/uiStore";
import { useToasts } from "../store/toastStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, waitFor } from "./render";

/** A raw drop request (1.172.2 D3) carries the file's name in a header. */
function droppedName(headers?: Record<string, string>): string {
  return decodeURIComponent(headers?.["x-ply-file-name"] ?? "");
}

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: ({ cardId }: { cardId: string }) => {
    useEffect(() => {}, []);
    return <div data-testid={`terminal-${cardId}`} />;
  },
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: () => <div data-testid="outcome" />,
}));

function open(extra: Record<string, unknown> = {}) {
  seedBoard([boardCard("c1", { title: "Add nod" })]);
  useUi.setState({ selectedCardId: { [BOARD_WS]: "c1" }, centerMode: { [BOARD_WS]: "board" } });
  useBuilder.setState({ byCard: {}, vendorPref: {}, trustAsking: {} });
  useToasts.setState({ toasts: [], queue: [] });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    fixtures: {
      card_overlap_check: [],
      reviewer_list: [],
      verify_status: null,
      verify_list_inflight: [],
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      ship_pending_release: { release: null, unreadable: null },
      card_review_tip: null,
      worktree_env_proposal: [],
      kanban_attachment_add_from_bytes: (body: unknown, headers?: Record<string, string>): CardAttachment => ({
        id: `att-${droppedName(headers)}`,
        displayName: droppedName(headers),
        storedPath: `/att/${droppedName(headers)}`,
        sizeBytes: (body as Uint8Array).length ?? 0,
        mimeType: "application/octet-stream",
        addedAt: 1,
      }),
      ...extra,
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

function file(name: string, bytes: number): File {
  const data = new Uint8Array(bytes).fill(7);
  return {
    name,
    size: bytes,
    type: "image/png",
    arrayBuffer: async () => data.slice().buffer,
    slice: () => ({ arrayBuffer: async () => data.slice().buffer }),
  } as unknown as File;
}

const transfer = (files: File[], types = files.length ? ["Files"] : ["text/plain"]) => ({
  dataTransfer: { types, files, dropEffect: "none", getData: () => "" },
});
const page = () => document.querySelector<HTMLElement>("[data-ply-card-host]")!;
const added = (view: ReturnType<typeof open>) =>
  view.tauri.callsOf("kanban_attachment_add_from_bytes").map((c) => droppedName(c.headers));
const detailsOpen = () =>
  document.querySelector("[data-ply-card-details-files]")!.closest("details")!.open;

describe("a file dropped anywhere on a card (1.172.2 D5)", () => {
  it("is a drop zone for files only", () => {
    open();
    expect(page().getAttribute("data-drop-zone")).toBe("card-page");
    expect(page().getAttribute("data-drop-accepts")).toBe("files");
  });

  it("shows the label while a file is over the title, and adds it on release; Details opens on Files", async () => {
    const view = open();
    const title = screen.getByRole("textbox", { name: "What you want" });
    expect(detailsOpen()).toBe(false);
    const shot = file("shot.png", 2048);
    fireEvent.dragOver(title, transfer([shot]));
    expect(screen.getByText(CARD_PAGE_DROP_LABEL)).toBeTruthy();
    fireEvent.drop(title, transfer([shot]));
    expect(screen.queryByText(CARD_PAGE_DROP_LABEL)).toBeNull();
    await waitFor(() => expect(added(view)).toEqual(["shot.png"]));
    expect(detailsOpen()).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: /Files \(1\)/ })).toBeTruthy());
  });

  it("shows no label for a text drag, and adds nothing", () => {
    const view = open();
    const title = screen.getByRole("textbox", { name: "What you want" });
    fireEvent.dragOver(title, transfer([]));
    expect(screen.queryByText(CARD_PAGE_DROP_LABEL)).toBeNull();
    fireEvent.drop(title, transfer([]));
    expect(added(view)).toEqual([]);
  });

  it("leaves a drop anywhere on the card chat — its list too — to the chat", async () => {
    const view = open({ chat_messages: null });
    act(() => useUi.setState((st) => ({ cardStep: { ...st.cardStep, c1: "chat" } })));
    const chat = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-ply-chat]");
      expect(el).toBeTruthy();
      return el!;
    });
    // The real ChatPanel marks its whole root as its zone.
    expect(chat.getAttribute("data-drop-zone")).toBe("card-chat");
    const list = chat.querySelector<HTMLElement>("[data-ply-chat-log]") ?? chat;
    const shot = file("shot.png", 2048);
    fireEvent.dragOver(list, transfer([shot]));
    expect(screen.queryByText(CARD_PAGE_DROP_LABEL)).toBeNull();
    fireEvent.drop(list, transfer([shot]));
    await act(async () => {});
    expect(added(view)).toEqual([]);
  });

  it("keeps the label while the drag crosses into a child, and takes it down when it leaves", () => {
    vi.useFakeTimers();
    try {
      open();
      const title = screen.getByRole("textbox", { name: "What you want" });
      const shot = file("shot.png", 2048);
      fireEvent.dragOver(title, transfer([shot]));
      // WKWebView can say nothing about where the drag went.
      fireEvent.dragLeave(page(), { ...transfer([shot]), relatedTarget: null });
      fireEvent.dragEnter(title, transfer([shot]));
      act(() => void vi.advanceTimersByTime(CARD_PAGE_LEAVE_MS * 4));
      expect(screen.getByText(CARD_PAGE_DROP_LABEL)).toBeTruthy();
      // Into a child, named: kept.
      const into = createEvent.dragLeave(page(), transfer([shot]));
      // jsdom drops `relatedTarget` from a drag event's init.
      Object.defineProperty(into, "relatedTarget", { value: title });
      fireEvent(page(), into);
      act(() => void vi.advanceTimersByTime(CARD_PAGE_LEAVE_MS * 4));
      expect(screen.getByText(CARD_PAGE_DROP_LABEL)).toBeTruthy();
      // Out of the window, or Esc: a leave and nothing after it.
      fireEvent.dragLeave(page(), { ...transfer([shot]), relatedTarget: null });
      act(() => void vi.advanceTimersByTime(CARD_PAGE_LEAVE_MS + 10));
      expect(screen.queryByText(CARD_PAGE_DROP_LABEL)).toBeNull();
      // Silence alone takes it down too.
      fireEvent.dragOver(title, transfer([shot]));
      expect(screen.getByText(CARD_PAGE_DROP_LABEL)).toBeTruthy();
      act(() => void vi.advanceTimersByTime(HINT_IDLE_MS + 10));
      expect(screen.queryByText(CARD_PAGE_DROP_LABEL)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says one file was not added and the others were, never \"Nothing was added\"", async () => {
    const view = open({
      kanban_attachment_add_from_bytes: (_body: unknown, headers?: Record<string, string>) => {
        if (droppedName(headers) === "bad.png") throw new Error("disk full");
        return { id: "a1", displayName: droppedName(headers), storedPath: "/att/x", sizeBytes: 1, mimeType: null, addedAt: 1 };
      },
    });
    const title = screen.getByRole("textbox", { name: "What you want" });
    act(() => {
      fireEvent.drop(title, transfer([file("good.png", 10), file("bad.png", 10)]));
    });
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.title)).toContain("bad.png wasn't added"));
    expect(added(view)).toEqual(["good.png", "bad.png"]);
    const toast = useToasts.getState().toasts.find((t) => t.title === "bad.png wasn't added")!;
    expect(toast.body).toBe("The others were added. Drop it again, or pick it with Attach.");
    expect(toast.details).toBe("bad.png: disk full");
  });

  it("refuses a file over 5 MB in plain words, and adds nothing", async () => {
    const view = open();
    const title = screen.getByRole("textbox", { name: "What you want" });
    act(() => {
      fireEvent.drop(title, transfer([file("movie.mov", 6 * 1024 * 1024)]));
    });
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.title)).toContain("movie.mov is too big"));
    const toast = useToasts.getState().toasts.find((t) => t.title === "movie.mov is too big")!;
    expect(toast.body).toBe("It is 6 MB; a card takes files up to 5 MB.");
    expect(added(view)).toEqual([]);
  });

  it("says several refused files of one drop in one toast", async () => {
    open();
    const title = screen.getByRole("textbox", { name: "What you want" });
    act(() => {
      fireEvent.drop(title, transfer([file("a.mov", 6 * 1024 * 1024), file("b.mov", 7 * 1024 * 1024)]));
    });
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.title)).toContain("2 files weren't added"));
    const all = [...useToasts.getState().toasts, ...useToasts.getState().queue];
    expect(all).toHaveLength(1);
    expect(all[0].body).toBe("a.mov and b.mov. They are too big; a card takes files up to 5 MB each.");
  });
});
