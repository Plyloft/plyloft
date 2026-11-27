// Try it TI-4 (docs/try-it/TRY_IT_SPEC.md §3.1, D18) on the real card page:
//
//  1. No Try it before the card has changes; once it has, Try it in Now (the
//     tour's anchor) and in the review.
//  2. Pressed, the card's Try it panel appears under Now.
//  3. Tier 1.5-style: the panel coming, changing and going never unmounts the
//     Builder's terminal (a stand-in that counts its mounts), and the Try
//     session's tile is the same tile throughout.
import { useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import type { KanbanCard } from "../ipc";
import { useBuilder } from "../store/builderStore";
import { useTiles } from "../store/tileStore";
import { useUi } from "../store/uiStore";
import { stopTryWatchesForTests } from "../store/tryRunStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";

const mounts = vi.hoisted(() => ({ builder: 0 }));

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: ({ cardId }: { cardId: string }) => {
    useEffect(() => {
      mounts.builder += 1;
    }, []);
    return <div data-testid="builder-terminal" data-card={cardId} />;
  },
}));
vi.mock("../components/CardReviewPanel", () => ({
  CardReviewPanel: () => <div data-testid="review-diff" />,
}));
vi.mock("../components/IntakeConversation", () => ({
  IntakeConversation: () => <div data-testid="intake-terminal" />,
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: ({
    onPresentationChange,
    tryIt,
  }: {
    onPresentationChange?: (s: { loading: boolean; filesChanged: number | null; shipBusy: boolean }) => void;
    tryIt?: ReactNode;
  }) => {
    useEffect(() => {
      const t = setTimeout(() => onPresentationChange?.({ loading: false, filesChanged: 3, shipBusy: false }));
      return () => clearTimeout(t);
    }, [onPresentationChange]);
    return <div data-testid="outcome">{tryIt}</div>;
  },
}));

let offTerminal: (() => void) | null = null;
afterEach(() => {
  offTerminal?.();
  offTerminal = null;
  stopTryWatchesForTests();
});

function tiles() {
  return useTiles.getState().byWorkspace[BOARD_WS]?.tiles ?? [];
}

function open(card: KanbanCard) {
  // The stand-in terminal for the Try tile: a PTY and a prompt at once.
  let n = 0;
  offTerminal = useTiles.subscribe(() => {
    for (const t of tiles()) {
      if (!t.ptyId) {
        n += 1;
        useTiles.getState().setPtyId(t.id, `try-pty-${n}`);
        useTiles.getState().markOutput(`try-pty-${n}`);
      }
    }
  });
  seedBoard([card]);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    fixtures: {
      card_overlap_check: [],
      reviewer_list: [],
      verify_status: null,
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      ship_pending_release: { release: null, unreadable: null },
      card_review_tip: null,
      project_try_command_get: {
        command: "npm run dev",
        approved: true,
        shared: false,
        readOnly: false,
        hasConfig: true,
        detection: { kind: "none" },
      },
      try_copy_needs_packages: null,
      try_package_script: null,
      pty_command_running: null,
      pty_write: null,
      pty_kill: null,
      probe_ports: [],
      try_cmd_shims_available: [],
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

const now = () => within(screen.getByRole("region", { name: "Now" }));
const ready = (patch: Partial<KanbanCard> = {}) =>
  boardCard("c1", {
    notes: "x",
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    worktreePath: "/r/.plyloft-worktrees/c1",
    portBase: 41000,
    ...patch,
  });

describe("Try it on the card page", () => {
  it("is not offered before the card has changes", () => {
    open(boardCard("c1", { notes: "Do it", worktreePath: "/r/.plyloft-worktrees/c1" }));
    expect(now().queryByRole("button", { name: "Try it" })).toBeNull();
    expect(document.querySelector("[data-ply-tour='card-try-it']")).toBeNull();
    expect(document.querySelector("[data-ply-try-it='review']")).toBeNull();
  });

  // 1.172.0 (C2; CP-3): on a card Ready to ship Try it is the Review's —
  // Now has Read the review and Ship it ▾ — and the tour's anchor is on it.
  it("is offered in the Review on a card Ready to ship, and opens its panel", async () => {
    const { user } = open(ready());
    await user.click(await now().findByRole("button", { name: "Read the review" }));
    expect(now().queryByRole("button", { name: "Try it" })).toBeNull();
    const review = within(screen.getByRole("region", { name: "Review" }));
    const button = await review.findByRole("button", { name: "Try it" });
    expect(button.getAttribute("data-ply-tour")).toBe("card-try-it");
    expect(button.getAttribute("data-ply-try-it")).toBe("review");
    expect(document.querySelectorAll("[data-ply-tour='card-try-it']")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Try it" })).toBeNull();
    await user.click(button);
    const panel = await screen.findByRole("region", { name: "Try it" });
    await waitFor(() => expect(within(panel).getByText("Starting your app…")).toBeTruthy());
    expect(tiles().filter((t) => t.tryOf)).toHaveLength(1);
    // Try it keeps the person on the card: Terminals is not opened.
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("board");
    // Pressed again while it runs: the same session, nothing typed again.
    await user.click(button);
    expect(tiles().filter((t) => t.tryOf)).toHaveLength(1);
    expect(tauri().callsOf("pty_write")).toHaveLength(1);
  });

  it("is offered in Now (not again in the Review) on a card whose checks failed", async () => {
    open(ready({ verifyStatus: "failed" }));
    const button = await now().findByRole("button", { name: "Try it" });
    expect(button.getAttribute("data-ply-tour")).toBe("card-try-it");
    expect(document.querySelector("[data-ply-try-it='review']")).toBeNull();
  });

  it("never unmounts the Builder's terminal or the Try tile as the panel comes and goes", async () => {
    mounts.builder = 0;
    const card = ready({
      builder: {
        vendor: "claude",
        bypass: false,
        ptyId: "pty-1",
        sessionLost: false,
        startedAt: Date.now() - 60_000,
        snapshots: [{ n: 1, sha: "s1", at: 1 }],
      } as never,
    });
    useBuilder.setState({
      byCard: {
        c1: { workspaceId: BOARD_WS, ptyId: "pty-1", vendor: "claude", startedAt: Date.now() - 60_000, lastOutputAt: Date.now(), promptBoxIdle: true, pending: [] } as never,
      },
    });
    const { user } = open(card);
    const terminal = screen.getByTestId("builder-terminal");
    const before = mounts.builder;
    expect(before).toBe(1);
    // 1.172.0 (C2): Ready to ship — Try it is the Review's.
    await user.click(await now().findByRole("button", { name: "Read the review" }));
    await user.click(await within(screen.getByRole("region", { name: "Review" })).findByRole("button", { name: "Try it" }));
    const panel = await screen.findByRole("region", { name: "Try it" });
    await waitFor(() => expect(tauri().callsOf("pty_write")).toHaveLength(1));
    const tryTile = tiles().find((t) => t.tryOf)!;
    act(() => {
      tauri().emit("pty://data", {
        id: tryTile.ptyId,
        data: Array.from(new TextEncoder().encode("Local: http://localhost:41000/\n")),
      });
    });
    await waitFor(() => expect(within(panel).getByText("Running on localhost:41000")).toBeTruthy());
    expect(screen.getByTestId("builder-terminal")).toBe(terminal);
    expect(tiles().find((t) => t.tryOf)?.id).toBe(tryTile.id);
    await user.click(within(panel).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(within(panel).getByText("Stopped")).toBeTruthy());
    expect(screen.getByTestId("builder-terminal")).toBe(terminal);
    expect(mounts.builder).toBe(before);
    // Only the Try tile was closed; the Builder's session was never touched.
    expect(tauri().callsOf("pty_kill").map((c) => c.args.id)).toEqual([tryTile.ptyId]);
  });
});
