// 1.177.0 Compare: the store is per workspace, in memory only, and a closed
// tile undoes the pair.
import { describe, expect, it } from "vitest";
import { HISTORY_CAP, useCompare } from "../store/compareStore";

const W = "w1";
const pass = (i: number) => ({
  from: "claude" as const,
  to: "codex" as const,
  ask: "just-pass" as const,
  withNote: false,
  at: i,
  mode: "send" as const,
  sent: `s${i}`,
  answer: `a${i}`,
  cut: false,
});

describe("the Compare store", () => {
  it("is off until turned on, per workspace; off keeps the pair and the history, and drops the rest", () => {
    const s = useCompare.getState();
    s.setOn(W, true);
    s.choose(W, "claude", "c1");
    s.addPass(W, pass(1));
    expect(useCompare.getState().byWorkspace[W].on).toBe(true);
    expect(useCompare.getState().byWorkspace["other"]).toBeUndefined();
    s.setOn(W, false);
    expect(useCompare.getState().byWorkspace[W]).toMatchObject({ on: false, claudeId: "c1", sent: null, composer: null, answers: {} });
    expect(useCompare.getState().byWorkspace[W].history).toHaveLength(1);
  });

  it("numbers passes, newest first, and caps the history", () => {
    const s = useCompare.getState();
    s.setOn(W, true);
    for (let i = 1; i <= HISTORY_CAP + 5; i++) s.addPass(W, pass(i));
    const h = useCompare.getState().byWorkspace[W].history;
    expect(h).toHaveLength(HISTORY_CAP);
    expect(h[0].n).toBe(HISTORY_CAP + 5);
    expect(useCompare.getState().byWorkspace[W].sent).toMatchObject({ to: "codex", mode: "send" });
  });

  it("undoes the pair when a paired tile is gone, and says which", () => {
    const s = useCompare.getState();
    s.setOn(W, true);
    s.adopt(W, "claude", "c1");
    s.adopt(W, "codex", "x1");
    s.reconcile(W, [{ id: "x1", vendor: "codex" }]);
    expect(useCompare.getState().byWorkspace[W]).toMatchObject({ claudeId: null, codexId: "x1", closed: "claude" });
    // One Claude tile again pairs by itself: nothing left to say.
    s.reconcile(W, [{ id: "x1", vendor: "codex" }, { id: "c2", vendor: "claude" }]);
    expect(useCompare.getState().byWorkspace[W].closed).toBeNull();
  });

  it("remembers when a tile's newest plan finished, in memory", () => {
    const s = useCompare.getState();
    s.setOn(W, true);
    const a = { vendor: "claude" as const, conversation: "known" as const, turn: "done" as const, answer: "p", answerKind: "plan" as const, cut: false };
    s.setAnswer(W, "claude", { ...a, finishedAtMs: 200 });
    s.setAnswer(W, "claude", { ...a, finishedAtMs: 100 });
    s.setAnswer(W, "claude", { ...a, answerKind: "text", finishedAtMs: 900 });
    expect(useCompare.getState().byWorkspace[W].planSeenAt).toEqual({ claude: 200 });
    s.choose(W, "claude", "c9");
    expect(useCompare.getState().byWorkspace[W].planSeenAt).toEqual({});
  });

  it("1.177.1: holds the first answer the pass's tile finishes after the pass, until a pass succeeds", () => {
    const s = useCompare.getState();
    s.setOn(W, false);
    s.setOn(W, true);
    const t0 = Date.now() - 60_000;
    const a = (vendor: "claude" | "codex", text: string, at: number) => ({ vendor, conversation: "known" as const, turn: "done" as const, answer: text, answerKind: "text" as const, finishedAtMs: at, cut: false });
    s.addPass(W, { ...pass(1), at: t0 });
    const w = () => useCompare.getState().byWorkspace[W];
    expect(w().returnPending).toMatchObject({ into: "codex", at: t0 });
    s.setAnswer(W, "codex", a("codex", "old", t0 - 1));
    expect(w().returnHeld).toBeNull();
    s.setAnswer(W, "claude", a("claude", "Claude's own", t0 + 5));
    expect(w().returnHeld).toBeNull();
    s.setAnswer(W, "codex", a("codex", "the review", t0 + 10));
    expect(w().returnHeld).toMatchObject({ from: "codex", answer: { answer: "the review" } });
    expect(w().returnPending).toBeNull();
    // The same answer read again keeps it.
    s.setAnswer(W, "codex", a("codex", "the review", t0 + 10));
    expect(w().returnHeld?.answer.answer).toBe("the review");
    // The return pass consumes it and waits for Claude's answer.
    s.addPass(W, { ...pass(2), from: "codex", to: "claude", at: t0 + 30 });
    expect(w().returnHeld).toBeNull();
    expect(w().returnPending).toMatchObject({ into: "claude", at: t0 + 30 });
  });

  it("1.177.1: the held answer goes with Swap, a pair change, a closed tile and Compare off", () => {
    const s = useCompare.getState();
    const w = () => useCompare.getState().byWorkspace[W];
    const t0 = Date.now() - 60_000;
    const hold = () => {
      s.setOn(W, true);
      s.adopt(W, "claude", "c1");
      s.adopt(W, "codex", "x1");
      s.addPass(W, { ...pass(1), at: t0 });
      s.setAnswer(W, "codex", { vendor: "codex", conversation: "known", turn: "done", answer: "r", finishedAtMs: t0 + 1, cut: false });
      expect(w().returnHeld).not.toBeNull();
    };
    hold();
    s.flip(W, true);
    expect(w()).toMatchObject({ returnHeld: null, returnPending: null, flipped: true });
    hold();
    s.choose(W, "codex", "x2");
    expect(w().returnHeld).toBeNull();
    s.choose(W, "codex", "x1");
    hold();
    s.reconcile(W, [{ id: "c1", vendor: "claude" }]);
    expect(w().returnHeld).toBeNull();
    s.adopt(W, "codex", "x1");
    hold();
    s.setOn(W, false);
    expect(w()).toMatchObject({ returnHeld: null, returnPending: null });
    hold();
    s.dropReturn(W);
    expect(w()).toMatchObject({ returnHeld: null, returnPending: null });
    // Seen working: noted once.
    s.addPass(W, { ...pass(3), at: t0 + 50 });
    s.noteReturnWork(W);
    expect(w().returnPending?.sawWork).toBe(true);
  });

  it("round 1 (H2): a held plan of a turn still open is replaced by plan v2, then frozen by the turn's end", () => {
    const s = useCompare.getState();
    s.setOn(W, false);
    s.setOn(W, true);
    const w = () => useCompare.getState().byWorkspace[W];
    const t0 = Date.now() - 60_000;
    const plan = (text: string, at: number) => ({ vendor: "claude" as const, conversation: "known" as const, turn: "open" as const, answer: text, answerKind: "plan" as const, planPending: true, finishedAtMs: at, cut: false });
    s.addPass(W, { ...pass(1), from: "codex", to: "claude", at: t0 });
    s.setAnswer(W, "claude", plan("Plan v1", t0 + 10));
    expect(w().returnHeld?.answer.answer).toBe("Plan v1");
    s.setAnswer(W, "claude", plan("Plan v2", t0 + 20));
    expect(w().returnHeld?.answer.answer).toBe("Plan v2");
    s.setAnswer(W, "claude", { vendor: "claude", conversation: "known", turn: "done", answer: "Done it.", answerKind: "text", finishedAtMs: t0 + 30, cut: false });
    expect(w().returnHeld?.answer.answer).toBe("Done it.");
    // 1.179.0: a later, separate answer of that tile lapses the hold.
    s.setAnswer(W, "claude", { vendor: "claude", conversation: "known", turn: "done", answer: "Something else", answerKind: "text", finishedAtMs: t0 + 40, cut: false });
    expect(w().returnHeld).toBeNull();
  });

  it("round 5 (D): a Swap applies to the offer in view; a new finished answer from either tile is a new offer and drops the flip; a held answer stays until its own tile answers again", () => {
    const s = useCompare.getState();
    s.setOn(W, false);
    s.setOn(W, true);
    const w = () => useCompare.getState().byWorkspace[W];
    const a = (vendor: "claude" | "codex", text: string, at: number) => ({ vendor, conversation: "known" as const, turn: "done" as const, answer: text, answerKind: "text" as const, finishedAtMs: at, cut: false });
    const t0 = Date.now() - 600_000;
    s.setAnswer(W, "claude", a("claude", "c1", t0));
    s.setAnswer(W, "codex", a("codex", "x1", t0 + 10));
    s.flip(W);
    expect(w().flipped).toBe(true);
    // The same answers read again: the Swap stays.
    s.setAnswer(W, "claude", a("claude", "c1", t0));
    s.setAnswer(W, "codex", a("codex", "x1", t0 + 10));
    expect(w().flipped).toBe(true);
    // Claude finishes a new answer (its plan menu, in the walk): a new offer.
    s.setAnswer(W, "claude", a("claude", "c2", t0 + 20));
    expect(w().flipped).toBe(false);
    // A held return keeps its direction and text whatever arrives after it.
    s.addPass(W, { ...pass(1), at: t0 + 30 });
    s.setAnswer(W, "codex", a("codex", "the reply", t0 + 40));
    expect(w().returnHeld?.answer.answer).toBe("the reply");
    s.setAnswer(W, "claude", a("claude", "c3", t0 + 50));
    expect(w().returnHeld?.answer.answer).toBe("the reply");
    expect(w().returnHeld?.from).toBe("codex");
    // 1.179.0: Codex finishes a newer answer of its own: the hold lapses.
    s.setAnswer(W, "codex", a("codex", "x later", t0 + 60));
    expect(w().returnHeld).toBeNull();
  });

  it("1.179.0 (measured): a held answer lapses when its tile finishes a newer answer that is not the answer to a pass", () => {
    const s = useCompare.getState();
    s.setOn(W, false);
    s.setOn(W, true);
    const w = () => useCompare.getState().byWorkspace[W];
    const t0 = Date.now() - 3_600_000;
    const a = (vendor: "claude" | "codex", text: string, at: number, turn: "open" | "done" = "done") => ({ vendor, conversation: "known" as const, turn, answer: text, answerKind: "text" as const, finishedAtMs: at, cut: false });
    // Pass into Codex; Codex answers it: answer 1, held.
    s.addPass(W, { ...pass(1), at: t0 });
    s.setAnswer(W, "codex", a("codex", "answer 1", t0 + 10_000));
    expect(w().returnHeld?.answer.answer).toBe("answer 1");
    // Read again, and a newer answer in the Claude tile: still held.
    s.setAnswer(W, "codex", a("codex", "answer 1", t0 + 10_000));
    s.setAnswer(W, "claude", a("claude", "Claude moved on", t0 + 20_000));
    expect(w().returnHeld?.answer.answer).toBe("answer 1");
    // Hours later the member asks Codex something of their own; while its
    // turn is open, the read still gives answer 1 beside it: still held.
    s.setAnswer(W, "codex", a("codex", "answer 1", t0 + 10_000, "open"));
    expect(w().returnHeld?.answer.answer).toBe("answer 1");
    // Codex finishes answer 2, no pass into it waited for: the hold lapses
    // and answer 2 is the answer on offer.
    s.setAnswer(W, "codex", a("codex", "answer 2", t0 + 3_000_000));
    expect(w().returnHeld).toBeNull();
    expect(w().returnPending).toBeNull();
    expect(w().answers.codex?.answer).toBe("answer 2");
  });

  it("1.179.0: with a pass into that tile waited for, its newer answer becomes the held one, as before", () => {
    const s = useCompare.getState();
    s.setOn(W, false);
    s.setOn(W, true);
    const w = () => useCompare.getState().byWorkspace[W];
    const t0 = Date.now() - 600_000;
    const a = (text: string, at: number) => ({ vendor: "codex" as const, conversation: "known" as const, turn: "done" as const, answer: text, answerKind: "text" as const, finishedAtMs: at, cut: false });
    s.addPass(W, { ...pass(1), at: t0 });
    s.setAnswer(W, "codex", a("answer 1", t0 + 10));
    expect(w().returnHeld?.answer.answer).toBe("answer 1");
    // Another pass into Codex (it consumes the hold), then Codex answers it.
    s.addPass(W, { ...pass(2), at: t0 + 100 });
    s.setAnswer(W, "codex", a("answer 2", t0 + 200));
    expect(w().returnHeld?.answer.answer).toBe("answer 2");
    expect(w().returnPending).toBeNull();
  });

  it("writes nothing to storage", () => {
    const s = useCompare.getState();
    s.setOn(W, true);
    s.addPass(W, pass(1));
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
