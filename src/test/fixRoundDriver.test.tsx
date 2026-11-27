// 1.175.0 F5: the driver of Finish and check by itself, against the stubbed
// Tauri layer and a fake Builder session — a round Plyloft sent starts the
// check once, after a clean finish; Stop ends it with nothing saved; "Don't
// check by itself" holds for that round; text in the prompt, a cut-off turn
// and the third round in a row wait; Not right never starts it.
import { beforeEach, describe, expect, it } from "vitest";
import type { BuildDone, KanbanCard } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { deliverSelfCheck, noteFixRoundSent, useBuilder } from "../store/builderStore";
import {
  dontCheckThisRound,
  fixRoundFactsOf,
  resetFixRoundForTests,
  stepFixRound,
  stopCheckByItself,
  useFixRound,
} from "../store/fixRoundStore";
import { useSettings } from "../store/settingsStore";
import { setPlatformForTests } from "../lib/platform";
import { FIX_ROUND_RECHECK_MS } from "../lib/fixRoundCheck";
import { tauri } from "./render";

const WS = "ws-1";

const card = (patch: Partial<KanbanCard> = {}): KanbanCard =>
  ({
    id: "card-1",
    workspaceId: WS,
    title: "Add sum",
    columnId: "in_progress",
    lastRunStatus: "success",
    worktreePath: "/tmp/ply-test/card-1",
    builder: {
      vendor: "claude",
      bypass: false,
      startedAt: 0,
      ptyId: "pty1",
      snapshots: [{ n: 1, sha: "aaa", at: 0 }],
      review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "changes_requested", at: 5 },
    },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }) as KanbanCard;

function seed(c: KanbanCard) {
  useKanban.setState({ byWorkspace: { [WS]: { cards: [c], loaded: true } } } as never);
}
const current = () => useKanban.getState().byWorkspace[WS]!.cards[0];

/** The fake session: at its prompt, its turn over at `at`. */
function idle(at: number, extra: Record<string, unknown> = {}) {
  useBuilder.setState((s) => ({
    byCard: {
      ...s.byCard,
      "card-1": { ...s.byCard["card-1"]!, promptBoxIdle: true, turnIdle: true, turnIdleAt: at, questionInView: false, ...extra },
    },
  }));
}
function working() {
  useBuilder.setState((s) => ({ byCard: { ...s.byCard, "card-1": { ...s.byCard["card-1"]!, turnIdle: false, promptBoxIdle: false } } }));
}

let finished = 0;

beforeEach(() => {
  setPlatformForTests("mac");
  resetFixRoundForTests();
  finished = 0;
  useBuilder.setState({ fixRoundSent: {}, selfCheck: {}, doneBusy: {} } as never);
  useBuilder.getState().attach("card-1", WS, "pty1", "claude");
  useSettings.setState((s) => ({ settings: { ...s.settings, behavior: { ...s.settings.behavior, checkFixRoundsByItself: true } } }));
  seed(card());
  tauri().fixture("card_fix_round_changed", true);
  tauri().fixture("card_fix_round_self_checks_set", (args: Record<string, unknown>) => {
    seed({ ...current(), fixRoundSelfChecks: Number(args.count) });
    return args.count;
  });
  useBuilder.setState({
    done: async () => {
      finished += 1;
      return { snapshot: { n: 2, sha: "bbb", at: 0 }, newSnapshot: true, reselected: false } as BuildDone;
    },
  } as never);
});

/** The findings went in; the Builder works, then its turn is over. */
async function roundThenClean(key = "findings:5"): Promise<number> {
  noteFixRoundSent("card-1", "findings", "pty1", key);
  const sentAt = useBuilder.getState().fixRoundSent["card-1"]!.at;
  await stepFixRound(current());
  working();
  await stepFixRound(current());
  expect(useFixRound.getState().rounds["card-1"]?.turnStarted).toBe(true);
  expect(fixRoundFactsOf(current())?.byItself).toBe(true);
  idle(sentAt + 5_000);
  await stepFixRound(current()); // asks whether the copy changed
  await stepFixRound(current()); // then starts
  return sentAt;
}

describe("F5: Finish and check by itself after a fix round", () => {
  it("walk 5.4: an approval delivered is no fix round — the person's queued change never starts a check", async () => {
    seed(card({ builder: { ...card().builder!, review: { ...card().builder!.review!, verdict: "approve" } } }));
    noteFixRoundSent("card-1", "findings", "pty1", "findings:9");
    const sentAt = useBuilder.getState().fixRoundSent["card-1"]!.at;
    await stepFixRound(current());
    working();
    await stepFixRound(current());
    idle(sentAt + 5_000);
    await stepFixRound(current());
    await stepFixRound(current());
    expect(useFixRound.getState().rounds["card-1"]).toBeUndefined();
    expect(finished).toBe(0);
  });

  it("walk 5.4: a copy read as unchanged too early is read once more, and the check starts", async () => {
    let reads = 0;
    // The first read comes while the edit is still landing.
    tauri().fixture("card_fix_round_changed", () => (++reads === 1 ? false : true));
    noteFixRoundSent("card-1", "findings", "pty1", "findings:5");
    const sentAt = useBuilder.getState().fixRoundSent["card-1"]!.at;
    await stepFixRound(current(), sentAt + 100);
    working();
    await stepFixRound(current(), sentAt + 200);
    idle(sentAt + 5_000);
    await stepFixRound(current(), sentAt + 5_100); // reads: unchanged
    await stepFixRound(current(), sentAt + 5_200); // a moment more
    expect(fixRoundFactsOf(current())?.held).toBeNull();
    await stepFixRound(current(), sentAt + 5_100 + FIX_ROUND_RECHECK_MS); // reads again: changed
    await stepFixRound(current(), sentAt + 5_200 + FIX_ROUND_RECHECK_MS); // starts
    expect(reads).toBe(2);
    expect(finished).toBe(1);
  });

  it("starts once after a clean finish, counted on the card", async () => {
    await roundThenClean();
    expect(finished).toBe(1);
    expect(tauri().callsOf("card_fix_round_self_checks_set")[0].args).toEqual({ workspaceId: WS, cardId: "card-1", count: 1 });
    expect(fixRoundFactsOf(current())?.checking).not.toBeNull();
    // Nothing more for the same round.
    await stepFixRound(current());
    await stepFixRound(current());
    expect(finished).toBe(1);
    // Never a write to GitHub or into the Builder's prompt.
    expect(tauri().callsOf("pty_write")).toHaveLength(0);
    expect(tauri().calls.some((c) => /pr_push|pr_merge|gh_/.test(c.cmd))).toBe(false);
  });

  it("Stop ends the check by itself with nothing saved", async () => {
    // The check's self-check is running when Stop is pressed.
    useBuilder.setState({
      done: async () => {
        finished += 1;
        useBuilder.setState({ selfCheck: { "card-1": { workspaceId: WS, startedAt: Date.now(), deliveredAt: null, message: "[Plyloft] check", token: "t" } } } as never);
        return null;
      },
    } as never);
    await roundThenClean();
    expect(finished).toBe(1);
    expect(stopCheckByItself("card-1")).toBe(true);
    expect(useBuilder.getState().selfCheck["card-1"]).toBeUndefined();
    expect(fixRoundFactsOf(current())).toMatchObject({ stopped: true, checking: null });
    expect(tauri().callsOf("builder_done")).toHaveLength(0);
  });

  it("Don't check by itself holds for that round only", async () => {
    noteFixRoundSent("card-1", "findings", "pty1", "findings:5");
    const sentAt = useBuilder.getState().fixRoundSent["card-1"]!.at;
    await stepFixRound(current());
    dontCheckThisRound("card-1");
    working();
    await stepFixRound(current());
    idle(sentAt + 5_000);
    await stepFixRound(current());
    await stepFixRound(current());
    expect(finished).toBe(0);
    // The next round (the next review's findings) checks by itself again.
    await new Promise((r) => setTimeout(r, 5));
    await roundThenClean("findings:6");
    expect(finished).toBe(1);
  });

  it("waits, and says why: text in the prompt, a cut-off turn, the third round", async () => {
    for (const [extra, reason] of [
      [{ composerDraft: true }, "draft"],
      [{ turnCutOff: true }, "interrupted"],
    ] as const) {
      resetFixRoundForTests();
      noteFixRoundSent("card-1", "findings", "pty1", `findings:${reason}`);
      const sentAt = useBuilder.getState().fixRoundSent["card-1"]!.at;
      await stepFixRound(current());
      working();
      await stepFixRound(current());
      idle(sentAt + 5_000, extra);
      await stepFixRound(current());
      expect(fixRoundFactsOf(current())?.held, reason).toBe(reason);
      idle(sentAt + 5_000, { composerDraft: false, turnCutOff: false });
    }
    expect(finished).toBe(0);
    // Two in a row already: the third waits.
    resetFixRoundForTests();
    seed({ ...current(), fixRoundSelfChecks: 2 });
    noteFixRoundSent("card-1", "findings", "pty1", "findings:cap");
    const sentAt = useBuilder.getState().fixRoundSent["card-1"]!.at;
    await stepFixRound(current());
    working();
    await stepFixRound(current());
    idle(sentAt + 5_000);
    await stepFixRound(current());
    expect(fixRoundFactsOf(current())?.held).toBe("cap");
    expect(finished).toBe(0);
  });

  it("never for the person's own changes, a review card, or when switched off", async () => {
    noteFixRoundSent("card-1", null);
    await stepFixRound(current());
    expect(useFixRound.getState().rounds["card-1"]).toBeUndefined();
    seed(card({ fixRoundCheck: false }));
    await roundThenClean().catch(() => {});
    expect(finished).toBe(0);
    resetFixRoundForTests();
    seed(card({ prReview: { number: 3 } as never }));
    noteFixRoundSent("card-1", "findings", "pty1", "findings:review");
    await stepFixRound(current());
    expect(useFixRound.getState().rounds["card-1"]).toBeUndefined();
  });

  // Round 2 (review): the self-check is never typed into a question on
  // screen — it waits, and the next tick asks again.
  it("never types the self-check into a question, a trust prompt or a block", async () => {
    tauri().fixture("pty_write", null);
    const run = { workspaceId: WS, startedAt: Date.now(), deliveredAt: null, message: "[Plyloft] re-read", token: "t" };
    for (const [patch, extra] of [
      [{ questionInView: true }, {}],
      [{}, { trustAsking: { "card-1": "claude" } }],
      [{}, { sessionBlocks: { "card-1": { kind: "usageLimit", resetsAt: null } } }],
    ] as const) {
      useBuilder.setState({ selfCheck: { "card-1": run }, trustAsking: {}, sessionBlocks: {}, ...extra } as never);
      idle(Date.now(), patch);
      expect(await deliverSelfCheck("card-1")).toBe(false);
    }
    expect(tauri().callsOf("pty_write")).toHaveLength(0);
    useBuilder.setState({ selfCheck: { "card-1": run }, trustAsking: {}, sessionBlocks: {} } as never);
    idle(Date.now(), { questionInView: false, composerDraft: false });
    expect(await deliverSelfCheck("card-1")).toBe(true);
  });
});

