// 1.175.0 F6 (UX-6; owner I8): the pull request's title and description
// written during the review, against the stubbed Tauri layer — asked once
// when the review of the last build starts, only into an idle Builder; the
// Review's line in its states; Read it saves locally (never GitHub); Ship
// uses a ready draft at once, with no "writing" wait.
import { beforeEach, describe, expect, it } from "vitest";
import type { KanbanCard } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { setBuilderObserved, useBuilder } from "../store/builderStore";
import { earlyDraftForShip, resetPrDraftEarlyForTests, stepEarlyDraft, usePrDraftEarly } from "../store/prDraftEarlyStore";
import { PrDraftRow } from "../components/PrDraftRow";
import { setPlatformForTests } from "../lib/platform";
import { renderUi, screen, tauri, waitFor } from "./render";

const WS = "ws-1";
const card = (patch: Partial<KanbanCard> = {}): KanbanCard =>
  ({
    id: "card-1",
    workspaceId: WS,
    title: "Add sum",
    columnId: "in_progress",
    worktreePath: "/tmp/ply-test/card-1",
    builder: {
      vendor: "claude",
      bypass: false,
      startedAt: 0,
      ptyId: "pty1",
      snapshots: [{ n: 1, sha: "aaa", at: 0 }],
      review: { snapshotN: 1, provider: "codex", degraded: false, status: "running", verdict: null, at: 5 },
    },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }) as KanbanCard;

function seed(c: KanbanCard) {
  useKanban.setState({ byWorkspace: { [WS]: { cards: [c], loaded: true } } } as never);
}
const current = () => useKanban.getState().byWorkspace[WS]!.cards[0];

function idleSession(extra: Record<string, unknown> = {}) {
  useBuilder.getState().attach("card-1", WS, "pty1", "claude");
  useBuilder.setState((s) => ({
    selfCheck: {},
    doneBusy: {},
    byCard: {
      ...s.byCard,
      "card-1": { ...s.byCard["card-1"]!, promptBoxIdle: true, turnIdle: true, turnIdleAt: 1, turnIdleSettled: true, lastOutputAt: 0, lastSettledScanAt: Date.now(), questionInView: false, ...extra },
    },
  }));
}

beforeEach(() => {
  setPlatformForTests("mac");
  resetPrDraftEarlyForTests();
  tauri().fixture("pty_write", null);
  tauri().fixture("card_pr_draft_prepare", { message: "[Plyloft] write the pull request", requestId: "r1", ptyId: "pty1" });
  tauri().fixture("card_pr_draft_read", { state: "missing" });
  tauri().fixture("builder_last_output_at", null);
  tauri().fixture("card_pr_draft_forget", null);
});

describe("F6: the pull request draft during the review", () => {
  it("is asked once, when the review of the last build starts, into an idle Builder", async () => {
    seed(card());
    idleSession();
    // The card's terminal is on screen and its last scan found the turn over.
    setBuilderObserved("card-1", true);
    useBuilder.getState().markPromptBox("card-1", true, true, false, true);
    try {
      await stepEarlyDraft(current(), Date.now());
      await stepEarlyDraft(current(), Date.now());
      await stepEarlyDraft(current(), Date.now());
    } finally {
      setBuilderObserved("card-1", false);
    }
    const asked = tauri().callsOf("card_pr_draft_prepare");
    expect(asked).toHaveLength(1);
    expect(asked[0].args).toEqual({ workspaceId: WS, cardId: "card-1", mode: "ship_it", duringReview: true });
    const written = tauri()
      .callsOf("pty_write")
      .map((c) => new TextDecoder().decode(new Uint8Array(c.args.data as number[])));
    expect(written.filter((t) => t.includes("[Plyloft] write the pull request"))).toHaveLength(1);
    expect(usePrDraftEarly.getState().byCard["card-1"]).toMatchObject({ requestId: "r1", commit: "aaa" });
  });

  // Round 2 (review): the whole guard again at the moment it types.
  it("types nothing when a question, a trust prompt or a check starts while it asks", async () => {
    const changes: Array<() => void> = [
      () => useBuilder.setState((s) => ({ byCard: { ...s.byCard, "card-1": { ...s.byCard["card-1"]!, questionInView: true } } })),
      () => useBuilder.setState({ trustAsking: { "card-1": "claude" } } as never),
      () => useBuilder.setState({ selfCheck: { "card-1": { workspaceId: WS, startedAt: 1, deliveredAt: null, message: "m", token: "t" } } } as never),
    ];
    for (const change of changes) {
      resetPrDraftEarlyForTests();
      seed(card());
      idleSession();
      useBuilder.setState({ trustAsking: {}, sessionBlocks: {} } as never);
      setBuilderObserved("card-1", true);
      useBuilder.getState().markPromptBox("card-1", true, true, false, true);
      tauri().fixture("card_pr_draft_prepare", () => {
        change();
        return { message: "[Plyloft] write the pull request", requestId: "r1", ptyId: "pty1" };
      });
      try {
        await stepEarlyDraft(current(), Date.now());
      } finally {
        setBuilderObserved("card-1", false);
      }
      expect(tauri().callsOf("card_pr_draft_prepare").length).toBeGreaterThan(0);
      expect(
        tauri()
          .callsOf("pty_write")
          .map((c) => new TextDecoder().decode(new Uint8Array(c.args.data as number[])))
          .filter((t) => t.includes("[Plyloft] write the pull request")),
      ).toHaveLength(0);
      expect(usePrDraftEarly.getState().byCard["card-1"]).toMatchObject({ requestId: null, skip: "busy" });
      // F7 round 2: the request never typed is forgotten, with the card's record.
      const forgets = tauri().callsOf("card_pr_draft_forget");
      expect(forgets[forgets.length - 1]?.args).toEqual({ workspaceId: WS, cardId: "card-1", requestId: "r1" });
    }
  });

  it("asks nothing of a Builder that is asking, holds text, or a review card", async () => {
    for (const extra of [{ questionInView: true }, { composerDraft: true }]) {
      resetPrDraftEarlyForTests();
      seed(card());
      idleSession(extra);
      await stepEarlyDraft(current(), Date.now());
      expect(tauri().callsOf("card_pr_draft_prepare")).toHaveLength(0);
      expect(usePrDraftEarly.getState().byCard["card-1"]?.skip).toBe("busy");
    }
    resetPrDraftEarlyForTests();
    seed(card({ prReview: { number: 3 } as never }));
    await stepEarlyDraft(current(), Date.now());
    expect(usePrDraftEarly.getState().byCard["card-1"]).toBeUndefined();
  });

  // Walk 6.1: at the review's start the Builder was answering Plyloft's own
  // "No checks are set up…" message, so the request was skipped as busy and
  // never asked again. Busy is asked again while that review runs.
  it("a Builder busy when the review starts is asked once it is idle, while the review runs", async () => {
    seed(card());
    idleSession({ questionInView: true });
    await stepEarlyDraft(current(), Date.now());
    expect(usePrDraftEarly.getState().byCard["card-1"]?.skip).toBe("busy");
    expect(tauri().callsOf("card_pr_draft_prepare")).toHaveLength(0);
    idleSession();
    setBuilderObserved("card-1", true);
    useBuilder.getState().markPromptBox("card-1", true, true, false, true);
    try {
      await stepEarlyDraft(current(), Date.now());
      await stepEarlyDraft(current(), Date.now());
    } finally {
      setBuilderObserved("card-1", false);
    }
    expect(tauri().callsOf("card_pr_draft_prepare")).toHaveLength(1);
    expect(usePrDraftEarly.getState().byCard["card-1"]).toMatchObject({ requestId: "r1", commit: "aaa" });
    // Once the review is over, a busy Builder is left to Ship, as before.
    resetPrDraftEarlyForTests();
    const done = card({ builder: { ...card().builder!, review: { ...card().builder!.review!, status: "done", verdict: "approve" } } });
    seed(done);
    usePrDraftEarly.setState({ byCard: { "card-1": { requestId: null, commit: "aaa", askedAt: 1, skip: "busy" } } });
    await stepEarlyDraft(current(), Date.now());
    expect(tauri().callsOf("card_pr_draft_prepare")).toHaveLength(1);
  });

  // Review of the walk fix: a request that fails at the moment it types is
  // not prepared again on every tick — only after the Builder's next turn end.
  it("after a failure at write time, asks again only after the session's next turn end", async () => {
    seed(card());
    idleSession();
    setBuilderObserved("card-1", true);
    useBuilder.getState().markPromptBox("card-1", true, true, false, true);
    let block = true;
    tauri().fixture("card_pr_draft_prepare", () => {
      // A question comes up while the request is being prepared.
      if (block) useBuilder.setState((s) => ({ byCard: { ...s.byCard, "card-1": { ...s.byCard["card-1"]!, questionInView: true } } }));
      return { message: "[Plyloft] write the pull request", requestId: `r${tauri().callsOf("card_pr_draft_prepare").length}`, ptyId: "pty1" };
    });
    const clearQuestion = () => useBuilder.setState((s) => ({ byCard: { ...s.byCard, "card-1": { ...s.byCard["card-1"]!, questionInView: false } } }));
    try {
      for (let i = 0; i < 4; i++) {
        await stepEarlyDraft(current(), Date.now());
        clearQuestion();
      }
      expect(tauri().callsOf("card_pr_draft_prepare")).toHaveLength(1);
      expect(tauri().callsOf("card_pr_draft_forget")).toHaveLength(1);
      // The turn ends again: asked once more, and this time it goes.
      block = false;
      useBuilder.setState((s) => ({ byCard: { ...s.byCard, "card-1": { ...s.byCard["card-1"]!, turnIdleAt: 2 } } }));
      await stepEarlyDraft(current(), Date.now());
    } finally {
      setBuilderObserved("card-1", false);
    }
    expect(tauri().callsOf("card_pr_draft_prepare")).toHaveLength(2);
    expect(usePrDraftEarly.getState().byCard["card-1"]?.requestId).toBeTruthy();
  });

  it("the Review's line, and Read it saves only in the card's copy", async () => {
    seed(card());
    usePrDraftEarly.setState({ byCard: { "card-1": { requestId: "r1", commit: "aaa", askedAt: Date.now() } } });
    const { user } = renderUi(<PrDraftRow card={current()} />);
    expect(screen.getByText("Claude is still writing the pull request's title and description.")).toBeTruthy();
    usePrDraftEarly.setState({ byCard: { "card-1": { requestId: "r1", commit: "aaa", askedAt: Date.now(), ready: true } } });
    await waitFor(() => expect(screen.getByText("Claude wrote the pull request's title and description.")).toBeTruthy());
    tauri().fixture("card_pr_draft_read", { state: "ready", title: "Add sum", body: "Adds it." });
    tauri().fixture("card_pr_draft_save", { state: "ready", title: "Add the sum", body: "Adds it." });
    await user.click(screen.getByRole("button", { name: "Read it" }));
    expect(await screen.findByText("Written by Claude. Nothing goes to GitHub until you press Ship it.")).toBeTruthy();
    const title = await screen.findByDisplayValue("Add sum");
    await user.clear(title);
    await user.type(title, "Add the sum");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(tauri().callsOf("card_pr_draft_save")).toHaveLength(1));
    expect(tauri().callsOf("card_pr_draft_save")[0].args).toMatchObject({ title: "Add the sum", body: "Adds it." });
    expect(tauri().callsOf("card_pr_edit")).toHaveLength(0);
    expect(tauri().calls.some((c) => /gh_|card_pr_edit|card_pr_text/.test(c.cmd))).toBe(false);
  });

  it("Ship uses a ready draft at once; another commit's is asked again", async () => {
    seed(card());
    usePrDraftEarly.setState({ byCard: { "card-1": { requestId: "r1", commit: "aaa", askedAt: Date.now(), ready: true } } });
    const writing: boolean[] = [];
    const unsub = useBuilder.subscribe((s) => writing.push(s.prDraftWriting["card-1"] === true));
    expect(await earlyDraftForShip(current())).toEqual({ kind: "draft", requestId: "r1" });
    unsub();
    expect(writing.includes(true)).toBe(false);
    usePrDraftEarly.setState({ byCard: { "card-1": { requestId: "r1", commit: "zzz", askedAt: Date.now(), ready: true } } });
    expect(await earlyDraftForShip(current())).toBeNull();
  });
});
