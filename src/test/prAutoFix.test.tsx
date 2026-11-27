// G7: Fix failing checks by itself, driven end to end against the stubbed
// Tauri layer — a failed check on the card's pull request with its switch
// on: the try is counted, the failed logs (only) go into the open Builder
// session, Finish and check runs once its turn is over, and Push update
// once Verify passed. A closed session is never resumed: the stop is
// recorded instead. Off (the default), nothing happens. The card's switch.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CardShipStep } from "../components/CardShipStep";
import { CardAutoFixPick, autoFixPickShown } from "../components/CardAutoFixPick";
import type { BuildDone, KanbanCard, PrFixMessage, PrStatus, PushUpdateResult } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { isBuilderObserved, setBuilderObserved, useBuilder } from "../store/builderStore";
import { builderWatchKey, resetPrAutoFixForTests, sessionOf, startPrAutoFix, stepCard, usePrAutoFix } from "../store/prAutoFixStore";
import { setPlatformForTests } from "../lib/platform";
import { AUTO_FIX_TURN_QUIET_MS } from "../lib/prAutoFix";
import { renderUi, screen, tauri, waitFor } from "./render";
import { pressOnce, prPushPressKey } from "../lib/pressOnce";

const WS = "ws-1";
const URL = "https://github.com/o/r/pull/8";

const pr = (patch: Partial<PrStatus> = {}): PrStatus => ({
  number: 8,
  state: "open",
  checks: "failing",
  checksTotal: 1,
  checksPassed: 0,
  checksPending: 0,
  failingChecks: [{ name: "test", workflow: "test", url: "https://github.com/o/r/actions/runs/1/job/2" }],
  mergeable: "mergeable",
  reviewDecision: "none",
  headSha: "aaa",
  openedAt: 1,
  checkedAt: 2,
  ...patch,
});

const builder = (shas: string[], ptyId: string | null, at = 0) =>
  ({
    vendor: "codex",
    bypass: false,
    startedAt: 0,
    snapshots: shas.map((sha, i) => ({ n: i + 1, sha, at })),
    ptyId,
  }) as unknown as KanbanCard["builder"];

const card = (patch: Partial<KanbanCard> = {}): KanbanCard => ({
  id: "card-1",
  workspaceId: WS,
  title: "Add sum",
  columnId: "in_progress",
  lastRunStatus: "success",
  verifyStatus: "passed",
  reviewStatus: "merged",
  prUrl: URL,
  pr: pr(),
  prAutoFix: true,
  worktreePath: "/tmp/ply-test/card-1",
  branchName: "card/card-1",
  builder: builder(["aaa"], "pty1"),
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

function seed(c: KanbanCard) {
  useKanban.setState({ byWorkspace: { [WS]: { cards: [c], loaded: true } } } as never);
}

function current(): KanbanCard {
  return useKanban.getState().byWorkspace[WS]!.cards[0];
}

const FIX: PrFixMessage = { prNumber: 8, kinds: ["checks"], message: "[Plyloft] Pull request #8 needs a fix", notes: [] };

function pasted(): string[] {
  return tauri()
    .callsOf("pty_write")
    .map((c) => new TextDecoder().decode(new Uint8Array(c.args.data as number[])));
}

function attachIdle() {
  useBuilder.getState().attach("card-1", WS, "pty1", "codex");
  // The card's terminal (`BuilderSession`) is mounted: it observes.
  if (!isBuilderObserved("card-1")) setBuilderObserved("card-1", true);
  useBuilder.getState().markPromptBox("card-1", true, true);
}

beforeEach(() => {
  while (isBuilderObserved("card-1")) setBuilderObserved("card-1", false);
  setPlatformForTests("mac");
  resetPrAutoFixForTests();
  tauri().fixture("pty_write", null);
});

describe("G7: Fix failing checks by itself", () => {
  it("counts a try, sends the failed logs, finishes, checks and pushes", async () => {
    seed(card());
    attachIdle();
    const counted = card({ pr: pr({ autoFix: { heads: ["aaa"] } }) });
    tauri().fixture("card_pr_auto_fix_begin", () => {
      seed(counted);
      return { begin: { kind: "started", attempt: 1 }, card: counted };
    });
    tauri().fixture("card_pr_fix_message", FIX);

    await stepCard(current());
    expect(tauri().callsOf("card_pr_auto_fix_begin")[0].args).toEqual({ workspaceId: WS, cardId: "card-1", head: "aaa" });
    expect(tauri().callsOf("card_pr_fix_message")[0].args).toEqual({ workspaceId: WS, cardId: "card-1", checksOnly: true });
    await waitFor(() => expect(pasted()).toHaveLength(1));
    expect(pasted()[0]).toContain(FIX.message);
    const working = usePrAutoFix.getState().phases["card-1"];
    expect(working?.step).toBe("working");

    // Still working: nothing more.
    useBuilder.getState().markPromptBox("card-1", false, false);
    await stepCard(current());
    expect(usePrAutoFix.getState().phases["card-1"]?.step).toBe("working");

    // Its turn is over after the fix: Finish and check (stubbed here: it
    // saves snapshot 2 and Verify passes on it).
    let finished = 0;
    const saved = card({
      pr: pr({ autoFix: { heads: ["aaa"] } }),
      // G7 fixes (Minor 1): the Challenger approved the fix.
      builder: {
        ...builder(["aaa", "bbb"], "pty1", Date.now())!,
        review: { snapshotN: 2, provider: "claude", degraded: false, status: "done", verdict: "approve", at: 1 },
      },
      verifyHistory: [{ verifyRunId: "v", status: "passed", endedAt: Date.now() + 10 }],
    });
    useBuilder.setState({
      done: async () => {
        finished += 1;
        seed(saved);
        return { snapshot: { n: 2, sha: "bbb", at: 0 }, newSnapshot: true, reselected: false } as BuildDone;
      },
    } as never);
    useBuilder.getState().markPromptBox("card-1", true, true);
    useBuilder.setState((s) => ({
      byCard: { ...s.byCard, "card-1": { ...s.byCard["card-1"]!, turnIdleAt: (working?.at ?? 0) + 5_000 } },
    }));
    await stepCard(current(), (working?.at ?? 0) + 5_000 + AUTO_FIX_TURN_QUIET_MS);
    expect(finished).toBe(1);

    // Saved, verified and approved: Push update.
    const pushedCard = { ...saved, pr: pr({ headSha: "bbb", checks: "pending", autoFix: { heads: ["aaa"] } }) };
    const pushed: PushUpdateResult = { card: pushedCard, pushed: true, refused: null, git: null };
    tauri().fixture("card_pr_push_update", pushed);
    await stepCard(current());
    expect(tauri().callsOf("card_pr_push_update")).toHaveLength(1);
    // 1.174.0 B6: the loop's push is the automatic one, which Rust gates.
    expect(tauri().callsOf("card_pr_push_update")[0].args).toEqual({ workspaceId: card().workspaceId, cardId: "card-1", auto: true });
    expect(usePrAutoFix.getState().phases["card-1"]?.step).toBe("pushed");
    // GitHub has the pushed head now: the try is over.
    await stepCard(current());
    expect(usePrAutoFix.getState().phases["card-1"]).toBeUndefined();
    // Never auto-merge, never a merge.
    expect(tauri().callsOf("card_pr_set_auto_merge")).toHaveLength(0);
    expect(tauri().callsOf("card_pr_merge")).toHaveLength(0);
  });

  // Walk 7: a try stopped with "didn't change anything" 10 s in, while Codex
  // was still working — a moment between two steps read as the turn's end.
  it("decides no_change only after the Builder's turn really ended (a slow turn)", async () => {
    seed(card());
    attachIdle();
    const counted = card({ pr: pr({ autoFix: { heads: ["aaa"] } }) });
    tauri().fixture("card_pr_auto_fix_begin", () => {
      seed(counted);
      return { begin: { kind: "started", attempt: 1 }, card: counted };
    });
    tauri().fixture("card_pr_fix_message", FIX);
    tauri().fixture("card_pr_auto_fix_stop", null);
    await stepCard(current());
    await waitFor(() => expect(pasted()).toHaveLength(1));
    const at = usePrAutoFix.getState().phases["card-1"]!.at;
    let finished = 0;
    useBuilder.setState({
      done: async () => {
        finished += 1;
        return { snapshot: { n: 1, sha: "aaa", at: 0 }, newSnapshot: false, reselected: false } as BuildDone;
      },
    } as never);
    const turn = (idle: boolean, idleAt?: number) => {
      useBuilder.getState().markPromptBox("card-1", idle, idle);
      if (idleAt != null) useBuilder.setState((s) => ({ byCard: { ...s.byCard, "card-1": { ...s.byCard["card-1"]!, turnIdleAt: idleAt } } }));
    };
    // Working, then a moment that looks idle 9 s in: no Finish and check yet.
    turn(false);
    await stepCard(current(), at + 2_000);
    turn(true, at + 9_000);
    await stepCard(current(), at + 9_500);
    expect(finished).toBe(0);
    // The turn went on: still working. Finish runs only once it stays over.
    turn(false);
    await stepCard(current(), at + 12_000);
    expect(usePrAutoFix.getState().phases["card-1"]?.step).toBe("working");
    // Had the finish come too early anyway (nothing saved yet) while the turn
    // then went on, the try goes back to waiting — never "no_change".
    turn(true, at + 60_000);
    useBuilder.setState({
      done: async () => {
        finished += 1;
        turn(false);
        return { snapshot: { n: 1, sha: "aaa", at: 0 }, newSnapshot: false, reselected: false } as BuildDone;
      },
    } as never);
    await stepCard(current(), at + 60_000 + AUTO_FIX_TURN_QUIET_MS);
    expect(finished).toBe(1);
    expect(tauri().callsOf("card_pr_auto_fix_stop")).toHaveLength(0);
    expect(usePrAutoFix.getState().phases["card-1"]?.step).toBe("working");
  });

  it("never resumes a closed session: it says so on the card instead", async () => {
    seed(card({ builder: builder(["aaa"], null) }));
    tauri().fixture("card_pr_auto_fix_stop", (args: Record<string, unknown>) => {
      const stopped = card({
        builder: builder(["aaa"], null),
        pr: pr({ autoFix: { heads: [], stopped: { reason: String(args.reason), head: "aaa", at: 5 } } }),
      });
      seed(stopped);
      return stopped;
    });
    await stepCard(current());
    expect(tauri().callsOf("card_pr_auto_fix_stop")[0].args).toEqual({
      workspaceId: WS,
      cardId: "card-1",
      head: "aaa",
      reason: "session_closed",
      detail: null,
    });
    expect(tauri().callsOf("builder_resume")).toHaveLength(0);
    expect(tauri().callsOf("card_pr_auto_fix_begin")).toHaveLength(0);
    expect(pasted()).toHaveLength(0);
    // The stop stands for that head: nothing more.
    await stepCard(current());
    expect(tauri().callsOf("card_pr_auto_fix_stop")).toHaveLength(1);
  });

  it("waits for a live Builder whose card isn't shown, and starts once it is", async () => {
    // G7 fixes (M1): live in Plyloft's registry, its terminal not attached.
    seed(card());
    tauri().fixture("builder_last_output_at", 123);
    tauri().fixture("card_pr_auto_fix_stop", (args: Record<string, unknown>) => {
      const stopped = card({ pr: pr({ autoFix: { heads: [], stopped: { reason: String(args.reason), head: "aaa", at: 5 } } }) });
      seed(stopped);
      return stopped;
    });
    await stepCard(current());
    expect(tauri().callsOf("card_pr_auto_fix_stop").map((c) => c.args.reason)).toEqual(["not_shown"]);
    expect(tauri().callsOf("card_pr_auto_fix_begin")).toHaveLength(0);
    // Said once while it stands.
    await stepCard(current(), Date.now() + 20_000);
    expect(tauri().callsOf("card_pr_auto_fix_stop")).toHaveLength(1);
    // The card is shown: the wait clears on its own and the try starts.
    attachIdle();
    const counted = card({ pr: pr({ autoFix: { heads: ["aaa"] } }) });
    tauri().fixture("card_pr_auto_fix_begin", () => {
      seed(counted);
      return { begin: { kind: "started", attempt: 1 }, card: counted };
    });
    tauri().fixture("card_pr_fix_message", FIX);
    await stepCard(current());
    expect(tauri().callsOf("card_pr_auto_fix_begin")).toHaveLength(1);
    await waitFor(() => expect(pasted()).toHaveLength(1));
  });

  it("1.176.2 (A5F-02): a runtime left behind by its card's terminal is not attached; it waits as not shown", async () => {
    seed(card());
    attachIdle();
    expect(sessionOf(current()).attached).toBe(true);
    // Another card is opened: the terminal goes, the runtime and its last
    // (idle) screen read stay.
    setBuilderObserved("card-1", false);
    expect(sessionOf(current()).attached).toBe(false);
    tauri().fixture("builder_last_output_at", 123);
    tauri().fixture("card_pr_auto_fix_stop", (args: Record<string, unknown>) => {
      const stopped = card({ pr: pr({ autoFix: { heads: [], stopped: { reason: String(args.reason), head: "aaa", at: 5 } } }) });
      seed(stopped);
      return stopped;
    });
    await stepCard(current());
    // No try spent, nothing pasted into a session nobody watches.
    expect(tauri().callsOf("card_pr_auto_fix_stop").map((c) => c.args.reason)).toEqual(["not_shown"]);
    expect(tauri().callsOf("card_pr_auto_fix_begin")).toHaveLength(0);
    expect(pasted()).toHaveLength(0);
  });

  it("never holds the failed logs: busy after the gather, it stops with nothing written", async () => {
    // G7 fixes (M2): the Builder took its prompt back while GitHub was read.
    seed(card());
    attachIdle();
    const counted = card({ pr: pr({ autoFix: { heads: ["aaa"] } }) });
    tauri().fixture("card_pr_auto_fix_begin", () => {
      seed(counted);
      return { begin: { kind: "started", attempt: 1 }, card: counted };
    });
    tauri().fixture("card_pr_fix_message", () => {
      useBuilder.getState().markPromptBox("card-1", false, false);
      return FIX;
    });
    tauri().fixture("card_pr_auto_fix_stop", () => current());
    await stepCard(current());
    expect(tauri().callsOf("card_pr_auto_fix_stop").map((c) => c.args.reason)).toEqual(["session_busy"]);
    expect(pasted()).toHaveLength(0);
    expect(useBuilder.getState().byCard["card-1"]?.pending ?? []).toHaveLength(0);
    expect(usePrAutoFix.getState().phases["card-1"]).toBeUndefined();
  });

  it("keeps Fix with the Builder offered for a review that came with the failed checks", async () => {
    // G7 fixes (M3): the loop sends the failed checks only.
    const both = pr({ reviewDecision: "changes_requested", changesRequested: { author: "r", body: "b", submittedAt: 3 } as never });
    seed(card({ pr: both }));
    attachIdle();
    const counted = card({ pr: { ...both, autoFix: { heads: ["aaa"] } } });
    tauri().fixture("card_pr_auto_fix_begin", () => {
      seed(counted);
      return { begin: { kind: "started", attempt: 1 }, card: counted };
    });
    tauri().fixture("card_pr_fix_message", FIX);
    await stepCard(current());
    await waitFor(() => expect(pasted()).toHaveLength(1));
    expect(useBuilder.getState().fixSent["card-1"]).toBeUndefined();
  });

  it("says a try no window followed after a relaunch", async () => {
    // G7 fixes: counted for this head, no phase in memory.
    seed(card({ pr: pr({ autoFix: { heads: ["aaa"] } }) }));
    attachIdle();
    tauri().fixture("card_pr_auto_fix_stop", () => current());
    await stepCard(current());
    const stop = tauri().callsOf("card_pr_auto_fix_stop")[0].args;
    expect(stop.reason).toBe("not_delivered");
    expect(tauri().callsOf("card_pr_auto_fix_begin")).toHaveLength(0);
    expect(pasted()).toHaveLength(0);
  });

  it("does nothing while it is off (the default)", async () => {
    seed(card({ prAutoFix: undefined }));
    attachIdle();
    await stepCard(current());
    expect(tauri().calls.filter((c) => c.cmd.startsWith("card_pr"))).toHaveLength(0);
    expect(pasted()).toHaveLength(0);
  });

  // 1.175.0 F10 (I11): the switch is under the card's Change…, not in the
  // Shipping section.
  it("the card's switch turns it on, under Change…, and Shipping has none", async () => {
    const c = card({ prAutoFix: undefined });
    seed(c);
    tauri().fixture("card_set_pr_auto_fix", () => card());
    const ship = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: {
        card_pr_refresh: c,
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        ship_pending_release: null,
      },
    });
    expect(screen.queryByRole("switch", { name: "Fix failing checks by itself" })).toBeNull();
    ship.unmount();
    expect(autoFixPickShown(c)).toBe(true);
    const { user } = renderUi(<CardAutoFixPick card={c} />);
    expect(
      screen.getByText(
        "When checks fail on GitHub, the Builder gets the failed logs, then Plyloft runs Finish and check and pushes the fix, up to 3 tries. Reviews and conflicts stay yours.",
      ),
    ).toBeTruthy();
    const sw = screen.getByRole("switch", { name: "Fix failing checks by itself" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await user.click(sw);
    await waitFor(() => expect(tauri().callsOf("card_set_pr_auto_fix")).toHaveLength(1));
    expect(tauri().callsOf("card_set_pr_auto_fix")[0].args).toEqual({ workspaceId: WS, cardId: "card-1", on: true });
  });

  // 1.172.0 (A2, owner): Codex (or Claude) in Asks before every change
  // holds each automatic fix for the person's OK — the card says so where
  // the switch is on and offers Edits its copy for this card, saved for its
  // next fresh start; the open session keeps asking.
  const renderShip = (c: KanbanCard) =>
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: {
        card_pr_refresh: c,
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        ship_pending_release: null,
      },
    });
  const asking = (vendor: "codex" | "claude", permissions: string) =>
    ({ ...(builder(["aaa"], "pty1") as object), vendor, permissions }) as unknown as KanbanCard["builder"];
  const note = () => document.querySelector<HTMLElement>("[data-ply-unattended-asks]");

  it("A2: Codex in Asks before every change says its automatic fixes wait, and offers Edits its copy for this card", async () => {
    const c = card({ builder: asking("codex", "asks") });
    seed(c);
    tauri().fixture("kanban_card_set_builder_permissions", ({ permissions }: Record<string, unknown>) => ({
      ...c,
      builderPermissions: permissions,
    }));
    const { user, rerender } = renderShip(c);
    expect(note()?.dataset.plyUnattendedAsks).toBe("autoFix");
    expect(note()!.textContent).toContain(
      "Codex asks before every change in this card, so its automatic fixes wait for your OK in the Builder's session.",
    );
    expect(note()!.textContent).toContain("The open session keeps asking.");
    await user.click(screen.getByRole("button", { name: "Use Edits its copy without asking for this card" }));
    await waitFor(() => expect(tauri().callsOf("kanban_card_set_builder_permissions")).toHaveLength(1));
    expect(tauri().callsOf("kanban_card_set_builder_permissions")[0].args).toMatchObject({
      cardId: "card-1",
      permissions: "editsCopy",
    });
    // Nothing else was changed: no session closed or restarted.
    expect(tauri().callsOf("builder_close")).toHaveLength(0);
    expect(tauri().callsOf("builder_start")).toHaveLength(0);
    rerender(<CardShipStep card={current()} onOpenRelease={() => {}} />);
    expect(screen.queryByRole("button", { name: "Use Edits its copy without asking for this card" })).toBeNull();
    expect(note()!.textContent).toContain(
      "The Builder's next fresh start uses Edits its copy without asking. The open session keeps asking.",
    );
  });

  it("A2: Claude in Asks before every change says the same; Edits its copy, or the switch off, says nothing", () => {
    const claude = card({ builder: asking("claude", "asks") });
    seed(claude);
    const first = renderShip(claude);
    expect(note()!.textContent).toContain("Claude uses its own permission setting in this card: if it asks before a change");
    first.unmount();
    const edits = card({ builder: asking("codex", "editsCopy") });
    seed(edits);
    const second = renderShip(edits);
    expect(note()).toBeNull();
    second.unmount();
    const off = card({ builder: asking("codex", "asks"), prAutoFix: false });
    seed(off);
    renderShip(off);
    expect(note()).toBeNull();
  });
});

// 1.174.0 (E13, CH-10): the loop listens to the Builder only for the cards it
// steps — another session's output is no step.
describe("the loop's Builder subscription", () => {
  it("keys on the stepped cards' sessions only", () => {
    seed(card());
    const before = builderWatchKey();
    useBuilder.getState().attach("card-other", WS, "pty9", "codex");
    useBuilder.getState().markPromptBox("card-other", true, true);
    expect(builderWatchKey()).toBe(before);
    attachIdle();
    expect(builderWatchKey()).not.toBe(before);
  });

  it("takes no step on unrelated output, and one when its card's session moves", async () => {
    vi.useFakeTimers();
    try {
      tauri().fixture("builder_last_output_at", null);
      tauri().allowUnhandled();
      seed(card());
      startPrAutoFix();
      useBuilder.getState().attach("card-other", WS, "pty9", "codex");
      useBuilder.getState().markPromptBox("card-other", true, true);
      await vi.advanceTimersByTimeAsync(400);
      expect(tauri().callsOf("builder_last_output_at")).toHaveLength(0);
      expect(tauri().callsOf("card_pr_auto_fix_begin")).toHaveLength(0);

      attachIdle();
      await vi.advanceTimersByTimeAsync(400);
      expect(tauri().callsOf("card_pr_auto_fix_begin").length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // 1.175.0 F7 round 2: the switch went off (Undo of Turn on) after the push
  // was chosen — the try ends quietly: no push, no "push refused" stop.
  it("ends quietly when the switch went off before the push", async () => {
    const approved = card({
      pr: pr({ autoFix: { heads: ["aaa"] } }),
      builder: {
        ...builder(["aaa", "bbb"], "pty1", Date.now())!,
        review: { snapshotN: 2, provider: "claude", degraded: false, status: "done", verdict: "approve", at: 1 },
      },
      verifyHistory: [{ verifyRunId: "v", status: "passed", endedAt: Date.now() + 10 }],
    });
    // The store already has the switch off; the step was chosen on the card as it was.
    seed({ ...approved, prAutoFix: false });
    attachIdle();
    usePrAutoFix.setState({ phases: { "card-1": { step: "checking", head: "aaa", attempt: 1, at: Date.now(), snapshotN: 2, snapshotAt: 0 } }, busySince: {} });
    tauri().fixture("card_pr_push_update", { card: approved, pushed: true, refused: null, git: null });
    await stepCard(approved);
    expect(tauri().callsOf("card_pr_push_update")).toHaveLength(0);
    expect(tauri().callsOf("card_pr_auto_fix_stop")).toHaveLength(0);
    expect(usePrAutoFix.getState().phases["card-1"]).toBeUndefined();
  });
});

// 1.176.2 F2 (review F1): the loop's push and the person's Send the fixes to
// GitHub share one slot — one push either way, no try burned, no "push
// refused" stop, no phase left at "pushing".
describe("the loop's push and the person's push go once", () => {
  const approved = () =>
    card({
      pr: pr({ autoFix: { heads: ["aaa"] } }),
      builder: {
        ...builder(["aaa", "bbb"], "pty1", Date.now())!,
        review: { snapshotN: 2, provider: "claude", degraded: false, status: "done", verdict: "approve", at: 1 },
      },
      verifyHistory: [{ verifyRunId: "v", status: "passed", endedAt: Date.now() + 10 }],
    });
  function setUp() {
    const c = approved();
    seed(c);
    attachIdle();
    usePrAutoFix.setState({ phases: { "card-1": { step: "checking", head: "aaa", attempt: 1, at: Date.now(), snapshotN: 2, snapshotAt: 0 } }, busySince: {} });
    const pushedCard = { ...c, pr: pr({ headSha: "bbb", checks: "pending", autoFix: { heads: ["aaa"] } }) };
    const waiting: (() => void)[] = [];
    tauri().fixture(
      "card_pr_push_update",
      () => new Promise((resolve) => waiting.push(() => resolve({ card: pushedCard, pushed: true, refused: null, git: null }))),
    );
    tauri().fixture("card_pr_auto_fix_stop", null);
    return { c, land: () => waiting.splice(0).forEach((go) => go()) };
  }
  const manualPush = () => pressOnce(prPushPressKey(WS, "card-1"), () => useKanban.getState().pushPrUpdate(WS, "card-1"));

  it("the person's push first: the loop's step does nothing, then forgets the try once GitHub has the head", async () => {
    const { c, land } = setUp();
    const manual = manualPush();
    await stepCard(c);
    expect(tauri().callsOf("card_pr_push_update")).toHaveLength(1);
    expect(tauri().callsOf("card_pr_push_update")[0].args).toEqual({ workspaceId: WS, cardId: "card-1" });
    expect(usePrAutoFix.getState().phases["card-1"]?.step).toBe("checking");
    land();
    await manual;
    await stepCard(current());
    expect(tauri().callsOf("card_pr_push_update")).toHaveLength(1);
    expect(tauri().callsOf("card_pr_auto_fix_stop")).toHaveLength(0);
    expect(usePrAutoFix.getState().phases["card-1"]).toBeUndefined();
  });

  it("the loop's push first: the person's press sends nothing, and the try ends pushed", async () => {
    const { c, land } = setUp();
    const step = stepCard(c);
    await waitFor(() => expect(tauri().callsOf("card_pr_push_update")).toHaveLength(1));
    expect(await manualPush()).toBeUndefined();
    land();
    await step;
    expect(tauri().callsOf("card_pr_push_update")).toHaveLength(1);
    expect(tauri().callsOf("card_pr_push_update")[0].args).toMatchObject({ auto: true });
    expect(tauri().callsOf("card_pr_auto_fix_stop")).toHaveLength(0);
    expect(usePrAutoFix.getState().phases["card-1"]?.step).toBe("pushed");
  });
});
