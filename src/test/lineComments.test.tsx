// SL-5: line comments on the card's review diff — select lines (a range
// across hunks, added, removed and context lines), write a comment, see it
// on the card, edit or remove it, and Send to Builder: one paste into the
// Builder session (resumed first when closed), then marked sent. Only Tauri
// is a stub; the stores and the panel are the app's.
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { CardReviewPanel } from "../components/CardReviewPanel";
import type { KanbanCard, LineComment, ReviewDiff } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { ALREADY_DELIVERING_ERROR, useBuilder, writeBuilderInput } from "../store/builderStore";
import { PASTE_START } from "../lib/builderInject";
import { liveBuilderSessionState } from "../lib/cardLifecycle";
import { SESSION_ENDED_ERROR } from "../lib/handedOverDelivery";
import { renderUi, screen, tauri } from "./render";

// Launch G1 (round 2, P2-a): new work for a Builder session asks the Free card
// slot first; these cards hold it (or the plan has no slot).

const WS = "ws-1";

const builder = {
  vendor: "claude" as const,
  bypass: false,
  ptyId: "pty-1",
  sessionLost: false,
  startedAt: 1,
  snapshots: [],
};

const baseCard: KanbanCard = {
  id: "card-1",
  workspaceId: WS,
  title: "Tidy the parser",
  columnId: "in_progress",
  worktreePath: "/tmp/ply-test/card-1",
  branchName: "card/card-1",
  builder,
  createdAt: 1,
  updatedAt: 1,
} as KanbanCard;

const diff: ReviewDiff = {
  cardId: "card-1",
  baseBranch: "main",
  cardBranch: "card/card-1",
  generatedAt: 1,
  files: [
    {
      path: "src/a.ts",
      kind: "modified",
      hunks: [
        { header: "@@ -10,3 +10,4 @@", oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, body: " keep\n-gone\n+new a\n+new b\n tail\n" },
        { header: "@@ -40,3 +42,2 @@", oldStart: 40, oldLines: 3, newStart: 42, newLines: 2, body: " ctx40\n-drop41\n-drop42\n+add43\n" },
      ],
    },
  ],
};

function Panel({ shipBusy = false }: { shipBusy?: boolean }) {
  const card = useKanban((s) => s.byWorkspace[WS]?.cards[0]);
  return card ? <CardReviewPanel workspaceId={WS} card={card} shipBusy={shipBusy} /> : null;
}

function seed(card: KanbanCard) {
  useKanban.setState({ byWorkspace: { [WS]: { cards: [card], loaded: true } } } as never);
}

function row(order: number): HTMLElement {
  return document.querySelector(`[data-ply-diff-row="${order}"]`) as HTMLElement;
}

function pastes(calls: { args: Record<string, unknown> }[]): string[] {
  return calls.map((c) => new TextDecoder().decode(new Uint8Array(c.args.data as number[])));
}

const stored: LineComment = {
  id: "lc-1",
  path: "src/a.ts",
  newStart: 11,
  newEnd: 42,
  oldStart: 41,
  oldEnd: 41,
  quoted: "+new a\n+new b\n tail\n…\n ctx40\n-drop41",
  body: "Split this in two.",
  createdAt: 2,
  updatedAt: 2,
};

// PR #375: the panel reads a Builder card's branch tip (none here).
beforeEach(() => tauri().fixture("card_review_tip", null));

describe("line comments on the review diff (SL-5)", () => {
  it("maps a selection across hunks to its lines and saves the comment on the card", async () => {
    seed(baseCard);
    const { tauri } = renderUi(<Panel />, {
      fixtures: {
        card_review_diff: diff,
        card_line_comment_add: () => ({ ...baseCard, lineComments: [stored] }),
      },
    });
    await screen.findByText(/Click a line to comment on it/);
    fireEvent.click(row(2));
    fireEvent.click(row(6), { shiftKey: true });
    expect(
      screen.getByText("src/a.ts, lines 11–42, and removed line 41 of the base version"),
    ).toBeTruthy();
    expect(row(4).getAttribute("aria-selected")).toBe("true");
    expect(row(7).getAttribute("aria-selected")).toBe("false");

    fireEvent.change(screen.getByLabelText("Comment for the Builder"), {
      target: { value: "Split this in two." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    await waitFor(() => expect(tauri.callsOf("card_line_comment_add")).toHaveLength(1));
    expect(tauri.callsOf("card_line_comment_add")[0].args).toEqual({
      workspaceId: WS,
      cardId: "card-1",
      draft: {
        path: "src/a.ts",
        newStart: 11,
        newEnd: 42,
        oldStart: 41,
        oldEnd: 41,
        quoted: "+new a\n+new b\n tail\n…\n ctx40\n-drop41",
        body: "Split this in two.",
      },
    });
    // On the card's list, and the composer is gone.
    expect(await screen.findByText("Split this in two.")).toBeTruthy();
    expect(screen.queryByLabelText("Comment for the Builder")).toBeNull();
    expect(screen.getByRole("button", { name: "Send to Builder (1)" })).toBeTruthy();
    // Nothing reached GitHub.
    expect(tauri.calls.some((c) => /gh|github|pr_/.test(c.cmd))).toBe(false);
  });

  it("edits and removes an unsent comment", async () => {
    seed({ ...baseCard, lineComments: [stored] });
    const { tauri } = renderUi(<Panel />, {
      fixtures: {
        card_review_diff: diff,
        card_line_comment_update: ({ body }: Record<string, unknown>) => ({
          ...baseCard,
          lineComments: [{ ...stored, body: body as string }],
        }),
        card_line_comment_remove: () => ({ ...baseCard, lineComments: [] }),
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit the comment"), { target: { value: "Split it." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Split it.")).toBeTruthy();
    expect(tauri.callsOf("card_line_comment_update")[0].args).toMatchObject({
      commentId: "lc-1",
      body: "Split it.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("Split it.")).toBeNull());
    expect(tauri.callsOf("card_line_comment_remove")).toHaveLength(1);
  });

  it("sends every unsent comment in one paste into the live session, then marks them sent", async () => {
    const sentOne = { ...stored, id: "lc-0", body: "Old note", sentAt: 1 };
    seed({ ...baseCard, lineComments: [sentOne, stored] });
    useBuilder.getState().attach("card-1", WS, "pty-1", "claude");
    useBuilder.getState().markPromptBox("card-1", true);
    const { tauri } = renderUi(<Panel />, {
      fixtures: {
        card_review_diff: diff,
        pty_write: null,
        card_line_comments_mark_sent: ({ commentIds }: Record<string, unknown>) => ({
          ...baseCard,
          lineComments: [sentOne, { ...stored, sentAt: 9 }].filter(
            (c) => c.sentAt || (commentIds as string[]).includes(c.id),
          ),
        }),
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Send to Builder (1)" }));
    await waitFor(() => expect(tauri.callsOf("card_line_comments_mark_sent")).toHaveLength(1));
    const written = pastes(tauri.callsOf("pty_write"));
    expect(written).toHaveLength(1);
    expect(written[0].startsWith(PASTE_START)).toBe(true);
    expect(written[0]).toContain("Review comments on this card's changes (1)");
    expect(written[0]).toContain("1. src/a.ts, lines 11–42, and removed line 41 of the base version");
    expect(written[0]).toContain("Comment: Split this in two.");
    expect(written[0]).not.toContain("Old note");
    expect(tauri.callsOf("card_line_comments_mark_sent")[0].args.commentIds).toEqual(["lc-1"]);
    expect(await screen.findByText("Every comment has been sent to the Builder.")).toBeTruthy();
    expect(screen.getByText("Sent (2)")).toBeTruthy();
  });

  it("resumes a closed session in the card's worktree, then pastes once it is at its prompt", async () => {
    const closed = { ...baseCard, builder: { ...builder, ptyId: null }, lineComments: [stored] };
    seed(closed);
    const resumed = { ...closed, builder: { ...builder, ptyId: "pty-2" } };
    const { tauri } = renderUi(<Panel />, {
      fixtures: {
        card_review_diff: diff,
        pty_write: null,
        builder_resume: () => ({ ptyId: "pty-2", card: resumed }),
        kanban_load: () => [resumed],
        card_line_comments_mark_sent: () => ({ ...resumed, lineComments: [{ ...stored, sentAt: 9 }] }),
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Send to Builder (1)" }));
    await waitFor(() => expect(tauri.callsOf("builder_resume")).toHaveLength(1));
    // The card's terminal attaches to the new session (BuilderSession does
    // this on the card page); the message waits for the prompt.
    await act(async () => {
      useBuilder.getState().attach("card-1", WS, "pty-2", "claude");
    });
    await waitFor(() => expect(useBuilder.getState().byCard["card-1"]?.pending).toHaveLength(1));
    expect(tauri.callsOf("pty_write")).toHaveLength(0);
    expect(tauri.callsOf("card_line_comments_mark_sent")).toHaveLength(0);
    await act(async () => {
      useBuilder.getState().markPromptBox("card-1", true);
    });
    await waitFor(() => expect(tauri.callsOf("card_line_comments_mark_sent")).toHaveLength(1));
    expect(tauri.callsOf("pty_write")[0].args.id ?? tauri.callsOf("pty_write")[0].args.ptyId).toBe("pty-2");
  });

  it("keeps a typed comment when other lines are clicked", async () => {
    seed(baseCard);
    renderUi(<Panel />, { fixtures: { card_review_diff: diff } });
    await screen.findByText(/Click a line to comment on it/);
    fireEvent.click(row(2));
    fireEvent.change(screen.getByLabelText("Comment for the Builder"), {
      target: { value: "Half written" },
    });
    fireEvent.click(row(6));
    expect((screen.getByLabelText("Comment for the Builder") as HTMLTextAreaElement).value).toBe(
      "Half written",
    );
    expect(screen.getByText("src/a.ts, removed line 41 of the base version")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(row(3));
    expect((screen.getByLabelText("Comment for the Builder") as HTMLTextAreaElement).value).toBe("");
  });

  it("sends once when the card is opened again while the first message is held, and a second press sends nothing", async () => {
    seed({ ...baseCard, lineComments: [stored] });
    useBuilder.getState().attach("card-1", WS, "pty-1", "claude");
    // Mid-turn: the message is held for the prompt.
    useBuilder.getState().markPromptBox("card-1", false);
    const fixtures = {
      card_review_diff: diff,
      pty_write: null,
      card_line_comments_mark_sent: () => ({ ...baseCard, lineComments: [{ ...stored, sentAt: 9 }] }),
    };
    const first = renderUi(<Panel />, { fixtures });
    fireEvent.click(await screen.findByRole("button", { name: "Send to Builder (1)" }));
    await waitFor(() => expect(useBuilder.getState().byCard["card-1"]?.pending).toHaveLength(1));
    // The card page closes and opens again: the send is still held.
    first.unmount();
    renderUi(<Panel />, { fixtures });
    const send = await screen.findByRole("button", { name: "Send to Builder (1)" });
    expect(screen.getByText("Queued for the Builder: they go in when it is back at its prompt.")).toBeTruthy();
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(send);
    fireEvent.click(send);
    expect(useBuilder.getState().byCard["card-1"]?.pending).toHaveLength(1);
    await act(async () => {
      useBuilder.getState().markPromptBox("card-1", true);
    });
    await waitFor(() => expect(first.tauri.callsOf("card_line_comments_mark_sent")).toHaveLength(1));
    expect(first.tauri.callsOf("pty_write")).toHaveLength(1);
    expect(useBuilder.getState().lineCommentSend["card-1"]).toBeUndefined();
  });

  it("waits while the card is being shipped", async () => {
    seed({ ...baseCard, lineComments: [stored] });
    renderUi(<Panel shipBusy />, { fixtures: { card_review_diff: diff } });
    const send = await screen.findByRole("button", { name: "Send to Builder (1)" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("The card is being shipped. Send them once the ship is over.")).toBeTruthy();
  });

  it("selects, extends, clears and comments with the keyboard only (walk F21)", async () => {
    seed(baseCard);
    const { tauri } = renderUi(<Panel />, {
      fixtures: {
        card_review_diff: diff,
        card_line_comment_add: () => ({
          ...baseCard,
          lineComments: [{ ...stored, newStart: null, newEnd: null, oldStart: 41, oldEnd: 42 }],
        }),
      },
    });
    await screen.findByText(/Click a line to comment on it/);
    // Each line is a named option in a listbox; the meta line is not one.
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(9);
    expect(screen.getAllByRole("listbox")).toHaveLength(2);
    expect(screen.getByRole("option", { name: "src/a.ts, added line 11: new a" })).toBe(row(2));
    expect(
      screen.getByRole("option", { name: "src/a.ts, removed line 41 of the base version: drop41" }),
    ).toBe(row(6));
    expect(
      screen.getByRole("option", {
        name: "src/a.ts, unchanged line 42 (line 40 of the base version): ctx40",
      }),
    ).toBe(row(5));
    // One tab stop for the file's lines: the first line.
    expect(options.filter((o) => o.tabIndex === 0)).toEqual([row(0)]);
    const key = (k: string, init: Record<string, unknown> = {}) =>
      fireEvent.keyDown(document.activeElement as Element, { key: k, ...init });
    act(() => row(0).focus());
    key("ArrowDown");
    key("ArrowDown");
    expect(document.activeElement).toBe(row(2));
    expect(row(2).tabIndex).toBe(0);
    expect(row(0).tabIndex).toBe(-1);
    // Space selects; the focus stays on the line.
    key(" ");
    expect(row(2).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("src/a.ts, line 11")).toBeTruthy();
    expect(document.activeElement).toBe(row(2));
    // Shift+ArrowDown takes the next lines, across the hunks.
    for (let i = 0; i < 4; i++) key("ArrowDown", { shiftKey: true });
    expect(document.activeElement).toBe(row(6));
    expect(
      screen.getByText("src/a.ts, lines 11–42, and removed line 41 of the base version"),
    ).toBeTruthy();
    expect(row(4).getAttribute("aria-selected")).toBe("true");
    // Shift+ArrowUp gives one back.
    key("ArrowUp", { shiftKey: true });
    expect(document.activeElement).toBe(row(5));
    expect(row(6).getAttribute("aria-selected")).toBe("false");
    // Esc clears.
    key("Escape");
    expect(screen.queryByLabelText("Comment for the Builder")).toBeNull();
    expect(options.every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    // Space on a removed line, Shift+Space on the next: a removed-only range.
    key("ArrowDown");
    key(" ");
    key("ArrowDown");
    key(" ", { shiftKey: true });
    expect(screen.getByText("src/a.ts, removed lines 41–42 of the base version")).toBeTruthy();
    // Enter takes the keyboard into the comment box; Esc there gives it back.
    key("Enter");
    const box = screen.getByLabelText("Comment for the Builder");
    expect(document.activeElement).toBe(box);
    key("Escape");
    expect(screen.queryByLabelText("Comment for the Builder")).toBeNull();
    expect(document.activeElement).toBe(row(7));
    // Again, and add the comment with Cmd+Enter.
    key("ArrowUp");
    key(" ");
    key("ArrowDown", { shiftKey: true });
    key("Enter");
    fireEvent.change(document.activeElement as Element, { target: { value: "Keep these." } });
    key("Enter", { metaKey: true });
    await waitFor(() => expect(tauri.callsOf("card_line_comment_add")).toHaveLength(1));
    expect(tauri.callsOf("card_line_comment_add")[0].args.draft).toEqual({
      path: "src/a.ts",
      newStart: null,
      newEnd: null,
      oldStart: 41,
      oldEnd: 42,
      quoted: "-drop41\n-drop42",
      body: "Keep these.",
    });
    // Added: the keyboard is back on the line it left.
    await waitFor(() => expect(screen.queryByLabelText("Comment for the Builder")).toBeNull());
    expect(document.activeElement).toBe(row(7));
  });

  it("keeps the no-newline marker out of the listbox", async () => {
    seed(baseCard);
    renderUi(<Panel />, {
      fixtures: {
        card_review_diff: {
          ...diff,
          files: [
            {
              path: "src/b.ts",
              kind: "modified",
              hunks: [{ header: "@@ -1,1 +1,1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: "-old\n+new\n\\ No newline at end of file\n" }],
            },
          ],
        },
      },
    });
    await screen.findByText(/Click a line to comment on it/);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(row(2).getAttribute("role")).toBe("presentation");
    expect(row(2).getAttribute("aria-hidden")).toBe("true");
    expect(row(2).tabIndex).toBe(-1);
    expect(row(2).hasAttribute("tabindex")).toBe(false);
  });

  it("offers no line selection on a card without a Builder", async () => {
    seed({ ...baseCard, builder: null });
    renderUi(<Panel />, { fixtures: { card_review_diff: diff } });
    await screen.findByText("src/a.ts");
    expect(screen.queryByText(/Click a line to comment on it/)).toBeNull();
    expect(row(2).className).not.toContain("is-pickable");
  });
});

describe("deliverWhenIdle (SL-5)", () => {
  it("writes at once at the prompt", async () => {
    const { tauri } = renderUi(<></>, { fixtures: { pty_write: null } });
    useBuilder.getState().attach("c1", WS, "pty-1", "claude");
    useBuilder.getState().markPromptBox("c1", true);
    await useBuilder.getState().deliverWhenIdle("c1", "hello");
    expect(pastes(tauri.callsOf("pty_write"))).toHaveLength(1);
  });

  it("settles once the held messages are flushed, and refuses a second of the same key meanwhile", async () => {
    const { tauri } = renderUi(<></>, { fixtures: { pty_write: null } });
    useBuilder.getState().attach("c1", WS, "pty-1", "claude");
    let queued = 0;
    let settled = false;
    const held = useBuilder.getState().deliverWhenIdle("c1", "one", () => queued++, "k")!;
    void held.then(() => (settled = true));
    expect(queued).toBe(1);
    await expect(useBuilder.getState().deliverWhenIdle("c1", "two", undefined, "k")!).rejects.toThrow(
      ALREADY_DELIVERING_ERROR,
    );
    expect(useBuilder.getState().byCard["c1"].pending).toEqual(["one"]);
    await Promise.resolve();
    expect(settled).toBe(false);
    await act(async () => {
      useBuilder.getState().markPromptBox("c1", true);
    });
    await held;
    expect(pastes(tauri.callsOf("pty_write"))[0]).toContain("one");
    // The key is free again once the first is written.
    useBuilder.getState().markPromptBox("c1", false);
    const again = useBuilder.getState().deliverWhenIdle("c1", "three", undefined, "k");
    expect(again).not.toBeNull();
    useBuilder.getState().detach("c1", "pty-1");
    await expect(again!).rejects.toThrow(SESSION_ENDED_ERROR);
  });

  it("records that work went into the session, so a done build reads Working again (v1.154.1 J5)", async () => {
    renderUi(<></>, { fixtures: { pty_write: null } });
    useBuilder.setState({ sentAt: {} });
    useBuilder.getState().attach("c1", WS, "pty-1", "claude");
    useBuilder.getState().markPromptBox("c1", true);
    const before = Date.now();
    await useBuilder.getState().deliverWhenIdle("c1", "fix the failed check");
    const sent = useBuilder.getState().sentAt["c1"];
    expect(sent).toBeGreaterThanOrEqual(before);
    const card = {
      lastRunStatus: "success" as const,
      builder: { snapshots: [{ n: 1, sha: "s", at: before - 1 }] } as unknown as KanbanCard["builder"],
    };
    expect(liveBuilderSessionState(card, "working", sent).label).toBe("Working");
    expect(liveBuilderSessionState(card, "working", null).label).toBe("Your turn");
    useBuilder.getState().detach("c1", "pty-1");
  });

  it("counts the person typing, not the terminal's own reports (v1.154.1 J5)", async () => {
    renderUi(<></>, { fixtures: { pty_write: null } });
    useBuilder.setState({ sentAt: {} });
    useBuilder.getState().attach("c1", WS, "pty-1", "claude");
    writeBuilderInput("pty-1", "\x1b[I");
    writeBuilderInput("pty-1", "\x1b[12;40R");
    writeBuilderInput("pty-1", "\x1b[<0;10;5M");
    expect(useBuilder.getState().sentAt["c1"]).toBeUndefined();
    writeBuilderInput("pty-1", "y");
    expect(useBuilder.getState().sentAt["c1"]).toBeGreaterThan(0);
    useBuilder.getState().detach("c1", "pty-1");
  });

  it("rejects when the session ends before the prompt, and is null with no session", async () => {
    renderUi(<></>, { fixtures: {} });
    expect(useBuilder.getState().deliverWhenIdle("c1", "x")).toBeNull();
    useBuilder.getState().attach("c1", WS, "pty-1", "claude");
    const held = useBuilder.getState().deliverWhenIdle("c1", "x")!;
    useBuilder.getState().detach("c1", "pty-1");
    await expect(held).rejects.toThrow(SESSION_ENDED_ERROR);
  });
});
