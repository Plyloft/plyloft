// CL-7 round 3: what counts as a submitted turn, at the store — the
// keystrokes `BuilderSession` hands `writeBuilderInput`, Plyloft's own
// `writePaste`, and the prompt scans (`markPromptBox`) — read back through
// `cardActor` as the Now callout and the sidebar say it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tauri } from "./tauri";
import { setPlatformForTests } from "../lib/platform";
import { useBuilder, writeBuilderInput, writePaste, SUBMIT_SETTLE_MS } from "../store/builderStore";
import { PASTE_END, PASTE_START } from "../lib/builderInject";
import { cardActor, type ActorCard } from "../lib/sessionActor";

const T0 = 1_900_000_000_000;
const card: ActorCard = {
  lastRunStatus: "running",
  builder: { vendor: "claude", startedAt: T0 - 60 * 60_000, ptyId: "pty1", snapshots: [] },
};

function words(): string | undefined {
  const s = useBuilder.getState();
  return cardActor({
    card,
    live: s.byCard.c1 ?? null,
    sentAt: s.sentAt.c1 ?? null,
    submittedAt: s.submittedAt.c1 ?? null,
    now: Date.now(),
  })?.words;
}

/** Output now (the echo, or the vendor's own), past the 1 s coalescing. */
function output() {
  vi.advanceTimersByTime(1_100);
  useBuilder.getState().markOutput("c1");
}

/** A prompt scan: `turnIdle` true is the turn over at an idle prompt. */
function scan(turnIdle: boolean) {
  useBuilder.getState().markPromptBox("c1", true, turnIdle);
}

/** At its prompt, its turn over. */
function atPrompt() {
  useBuilder.getState().attach("c1", "ws", "pty1", "claude");
  output();
  scan(true);
  // The person reads, then types: time passes after the scan.
  vi.advanceTimersByTime(2_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  setPlatformForTests("mac");
  tauri().fixture("pty_write", null);
  tauri().fixture("builder_last_output_at", null);
  useBuilder.setState({ byCard: {}, sentAt: {}, submittedAt: {}, doneAt: {} });
});

afterEach(() => {
  useBuilder.setState({ byCard: {}, sentAt: {}, submittedAt: {}, doneAt: {} });
  vi.useRealTimers();
});

describe("a typed submit (CL-7 round 3)", () => {
  it("a bracketed paste with its own line breaks is not a submit", () => {
    atPrompt();
    writeBuilderInput("pty1", `${PASTE_START}line one\rline two\n${PASTE_END}`);
    output();
    expect(useBuilder.getState().submittedAt.c1).toBeUndefined();
    expect(words()).toBe("Claude · your turn");
  });

  it("Option+Enter (a newline in the composer) is not a submit", () => {
    atPrompt();
    writeBuilderInput("pty1", "first line\x1b\r");
    output();
    expect(useBuilder.getState().submittedAt.c1).toBeUndefined();
    expect(words()).toBe("Claude · your turn");
  });

  it("a real Enter at the prompt is building at once, the clock from it", () => {
    atPrompt();
    writeBuilderInput("pty1", "fix the test\r");
    output();
    // Before the next scan has seen the turn start: building, not waiting.
    expect(words()).toBe("Claude · working");
    scan(false);
    vi.advanceTimersByTime(3 * 60_000);
    output();
    expect(words()).toBe("Claude · working · 3m");
  });

  it("an Enter mid-turn (answering a question) does not restart the clock", () => {
    atPrompt();
    writeBuilderInput("pty1", "go\r");
    output();
    scan(false);
    const submitted = useBuilder.getState().submittedAt.c1;
    vi.advanceTimersByTime(5 * 60_000);
    writeBuilderInput("pty1", "\r");
    output();
    expect(useBuilder.getState().submittedAt.c1).toBe(submitted);
    expect(words()).toBe("Claude · working · 5m");
  });

  it("an Enter that starts no turn corrects itself at the next scan", () => {
    atPrompt();
    // An empty prompt's Enter (or a menu pick): no turn begins.
    writeBuilderInput("pty1", "\r");
    output();
    expect(words()).toBe("Claude · working");
    // A scan a settle later still finds the turn over.
    vi.advanceTimersByTime(SUBMIT_SETTLE_MS);
    output();
    scan(true);
    // Typing again: the echo is output, and it is still waiting for you.
    writeBuilderInput("pty1", "h");
    output();
    expect(words()).toBe("Claude · your turn");
  });

  it("a scan right after a real Enter does not undo it", () => {
    atPrompt();
    writeBuilderInput("pty1", "go\r");
    // Within the settle the turn has not been drawn yet.
    vi.advanceTimersByTime(500);
    scan(true);
    useBuilder.getState().markOutput("c1");
    expect(words()).toBe("Claude · working");
  });

  it("a paste of Plyloft's is a submit, even mid-turn", async () => {
    atPrompt();
    writeBuilderInput("pty1", "go\r");
    output();
    scan(false);
    vi.advanceTimersByTime(4 * 60_000);
    await writePaste("pty1", "[Plyloft] the verdict");
    output();
    expect(useBuilder.getState().submittedAt.c1).toBe(Date.now() - 1_100);
    expect(words()).toBe("Claude · working");
  });
});

// SP-1 walk + Challenger: Claude's prompt suggestion after its turn is
// output, not a turn — but only a SETTLED scan that found the turn over
// stands through it.
describe("the settled turn-over (turnIdleSettled)", () => {
  const settledScan = (turnIdle: boolean) => useBuilder.getState().markPromptBox("c1", true, turnIdle, false, true);

  it("a settled scan sets it; the suggestion's output keeps it: waiting for you", () => {
    useBuilder.getState().attach("c1", "ws", "pty1", "claude");
    output();
    settledScan(true);
    expect(useBuilder.getState().byCard.c1.turnIdleSettled).toBe(true);
    vi.advanceTimersByTime(1_500);
    output(); // the dim suggestion drawn into the input box
    expect(useBuilder.getState().byCard.c1.turnIdleSettled).toBe(true);
    expect(words()).toBe("Claude · your turn");
  });

  it("a max-wait scan mid-stream never sets it: building", () => {
    useBuilder.getState().attach("c1", "ws", "pty1", "claude");
    output();
    scan(true); // a half-redrawn frame read as the turn over, not settled
    output();
    expect(useBuilder.getState().byCard.c1.turnIdleSettled).not.toBe(true);
    expect(words()).toMatch(/^Claude · working/);
  });

  it("a scan that finds the turn running, or a submit, clears it", () => {
    useBuilder.getState().attach("c1", "ws", "pty1", "claude");
    output();
    settledScan(true);
    scan(false);
    expect(useBuilder.getState().byCard.c1.turnIdleSettled).toBe(false);
    settledScan(true);
    useBuilder.getState().noteSubmitted("c1");
    expect(useBuilder.getState().byCard.c1.turnIdleSettled).toBe(false);
    output();
    expect(words()).toMatch(/^Claude · working/);
  });
});
