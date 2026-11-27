// v1.154.1 walk H1 (Challenger): a message held for the Builder's prompt is
// written anyway once it has waited HELD_VALVE_MS while the session printed
// nothing — an idle screen the prompt matcher doesn't recognise must not hold
// it forever. A session that keeps printing (a running turn's spinner) keeps
// holding it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tauri } from "./tauri";
import { setPlatformForTests } from "../lib/platform";
import { HELD_VALVE_MS, draftHoldNotice, heldValveDue, useBuilder, writeBuilderInput } from "../store/builderStore";
import { composerEscapedMatcherFor, settledTail } from "../lib/attention";

function writes(): string[] {
  return tauri()
    .callsOf("pty_write")
    .map((c) => new TextDecoder().decode(new Uint8Array(c.args.data as number[])));
}

beforeEach(() => {
  vi.useFakeTimers();
  setPlatformForTests("mac");
  tauri().fixture("pty_write", null);
  useBuilder.getState().attach("c1", "ws", "pty1", "claude");
  useBuilder.getState().markPromptBox("c1", false);
});

afterEach(() => {
  useBuilder.getState().detach("c1", "pty1");
  vi.useRealTimers();
  setPlatformForTests(null);
});

describe("the held-message valve", () => {
  it("writes a held message after two silent minutes, once", async () => {
    const queued = vi.fn();
    const delivery = useBuilder.getState().deliverWhenIdle("c1", "[Plyloft] hello", queued)!;
    expect(queued).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HELD_VALVE_MS - 20_000);
    expect(writes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(40_000);
    await delivery;
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toContain("[Plyloft] hello");
    expect(useBuilder.getState().byCard.c1.pending).toEqual([]);
    await vi.advanceTimersByTimeAsync(HELD_VALVE_MS);
    expect(writes()).toHaveLength(1);
  });

  it("1.174.5: a message waits for what the person typed, and goes once it's gone", async () => {
    const plyloftWrites = () => writes().filter((w) => w.includes("[Plyloft]"));
    writeBuilderInput(useBuilder.getState().byCard.c1.ptyId, "h");
    // Keys no scan has read yet hold it too.
    const delivery = useBuilder.getState().deliverWhenIdle("c1", "[Plyloft] hello")!;
    useBuilder.getState().markPromptBox("c1", true, true, false, true, false, false, false, false, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(plyloftWrites()).toEqual([]);
    expect(draftHoldNotice(useBuilder.getState().byCard.c1)).toBe(
      "A Plyloft message is waiting: send or clear what you typed in the Builder's prompt.",
    );
    // The silent valve never writes onto it either, and the turn stays over.
    await vi.advanceTimersByTimeAsync(3 * HELD_VALVE_MS);
    useBuilder.getState().markPromptBox("c1", true, true, false, true, false, false, false, false, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(plyloftWrites()).toEqual([]);
    expect(useBuilder.getState().byCard.c1.turnIdle).toBe(true);
    // Sent or cleared: the next scan delivers.
    useBuilder.getState().markPromptBox("c1", true, true, false, true, false, false, false, false, false);
    await delivery;
    expect(plyloftWrites()).toHaveLength(1);
    expect(draftHoldNotice(useBuilder.getState().byCard.c1)).toBeNull();
  });

  it("1.174.5: text in the row that nobody typed holds nothing", async () => {
    useBuilder.getState().markPromptBox("c1", true, true, false, true, false, false, false, false, true);
    expect(useBuilder.getState().byCard.c1.composerDraft ?? false).toBe(false);
    await useBuilder.getState().deliverWhenIdle("c1", "[Plyloft] hello");
    expect(writes().filter((w) => w.includes("[Plyloft]"))).toHaveLength(1);
  });

  it("1.174.5: a screen that can't say keeps what the last scan read", async () => {
    writeBuilderInput(useBuilder.getState().byCard.c1.ptyId, "h");
    useBuilder.getState().markPromptBox("c1", true, true, false, true, false, false, false, false, true);
    useBuilder.getState().markPromptBox("c1", true, false, true, true, false, false, false, false, null);
    expect(useBuilder.getState().byCard.c1.composerDraft).toBe(true);
    // Beside a question, the question is what Now says.
    expect(draftHoldNotice(useBuilder.getState().byCard.c1, true)).toBeNull();
  });

  it("1.174.5: a press that must not hold is refused while text is there", async () => {
    writeBuilderInput(useBuilder.getState().byCard.c1.ptyId, "h");
    useBuilder.getState().markPromptBox("c1", true, true, false, true, false, false, false, false, true);
    await expect(useBuilder.getState().deliverWhenIdle("c1", "[Plyloft] x", undefined, undefined, { noHold: true })).rejects.toThrow();
    useBuilder.getState().inject("c1", "[Plyloft] y");
    await vi.advanceTimersByTimeAsync(0);
    expect(writes().filter((w) => w.includes("[Plyloft]"))).toEqual([]);
    expect(useBuilder.getState().byCard.c1.pending).toEqual(["[Plyloft] y"]);
  });

  it("1.174.5: a self-check waiting on what was typed says so", () => {
    const rt = { composerDraft: true, pending: [] };
    expect(draftHoldNotice(rt)).toBeNull();
    expect(draftHoldNotice(rt, true)).toMatch(/send or clear what you typed/);
  });

  it("keeps holding while the session prints (a running turn)", async () => {
    void useBuilder.getState().deliverWhenIdle("c1", "[Plyloft] later")!.catch(() => {});
    for (let t = 0; t < 3 * HELD_VALVE_MS; t += 5_000) {
      useBuilder.getState().markOutput("c1");
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(writes()).toEqual([]);
    // Back at its prompt: written then, as before.
    useBuilder.getState().markPromptBox("c1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toHaveLength(1);
  });

  it("never writes into the member's ! draft: it waits with a notice, and goes once the draft is cleared", async () => {
    // A settled scan: the member's draft starts with `!` (not idle, escaped).
    useBuilder.getState().markPromptBox("c1", false, false, false, true, true);
    const delivery = useBuilder.getState().deliverWhenIdle("c1", "[Plyloft] findings")!;
    await vi.advanceTimersByTimeAsync(2 * HELD_VALVE_MS);
    expect(writes()).toEqual([]);
    expect(draftHoldNotice(useBuilder.getState().byCard.c1)).toBe(
      "A Plyloft message is waiting: clear the ! (or /) in the Builder's prompt.",
    );
    // The member clears the `!`: the next scan finds the box idle.
    useBuilder.getState().markPromptBox("c1", true, true, false, true, false);
    await delivery;
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toContain("[Plyloft] findings");
    expect(draftHoldNotice(useBuilder.getState().byCard.c1)).toBeNull();
  });

  it("a scan with no composer in view (a picker) keeps the ! hold; nothing is written", async () => {
    useBuilder.getState().markPromptBox("c1", false, false, false, true, true);
    void useBuilder.getState().deliverWhenIdle("c1", "[Plyloft] later")!.catch(() => {});
    useBuilder.getState().markPromptBox("c1", false, false, false, true, null);
    await vi.advanceTimersByTimeAsync(2 * HELD_VALVE_MS);
    expect(useBuilder.getState().byCard.c1.composerEscaped).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("holds on a / draft with the slash menu open: no write, the notice shows (walk F1)", async () => {
    const RULE = "─".repeat(60);
    const screen = [
      RULE,
      "❯ /",
      RULE,
      "  ❯ /ply:release-notes                  (ply) Writes the release note",
      ...Array.from({ length: 30 }, (_, i) => `    /cmd-${i}                              Does thing ${i}`),
    ];
    const escaped = composerEscapedMatcherFor("claude");
    // What BuilderSession sends: the 20-row tail for the box, a taller read for the draft.
    const tail20 = settledTail(screen, 20).join("\n");
    useBuilder.getState().markPromptBox("c1", false, false, false, true, escaped(screen.join("\n")));
    expect(escaped(tail20)).toBe(true);
    const delivery = useBuilder.getState().deliverWhenIdle("c1", "[Plyloft] Review comments")!;
    await vi.advanceTimersByTimeAsync(2 * HELD_VALVE_MS);
    expect(writes()).toEqual([]);
    expect(draftHoldNotice(useBuilder.getState().byCard.c1)).not.toBeNull();
    useBuilder.getState().markPromptBox("c1", true, true, false, true, false);
    await delivery;
    expect(writes()).toHaveLength(1);
  });

  it("a scan that cannot see the composer right after the member typed holds (walk F1)", async () => {
    useBuilder.getState().markPromptBox("c1", false, false, false, true, false);
    writeBuilderInput("pty1", "/");
    useBuilder.getState().markPromptBox("c1", false, false, false, true, null);
    expect(useBuilder.getState().byCard.c1.composerEscaped).toBe(true);
    void useBuilder.getState().deliverWhenIdle("c1", "[Plyloft] later")!.catch(() => {});
    await vi.advanceTimersByTimeAsync(2 * HELD_VALVE_MS);
    expect(writes()).toEqual(["/"]);
  });

  it("is due only when both the wait and the silence are long enough", () => {
    expect(heldValveDue({ heldSince: 0, startedAt: 0 }, HELD_VALVE_MS)).toBe(true);
    expect(heldValveDue({ heldSince: 0, startedAt: 0, lastOutputAt: 60_000 }, HELD_VALVE_MS)).toBe(false);
    expect(heldValveDue({ heldSince: 60_000, startedAt: 0 }, HELD_VALVE_MS)).toBe(false);
  });
});
