// Windows port: how Ply's messages reach a live Builder PTY, at the store —
// the paste and its Enter in one write, or (Codex on Windows) the paste, then
// the Enter once the session is quiet; and the human's keystrokes from the
// Builder terminal, held while such a paste waits for its Enter so they are
// never submitted with Ply's message.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tauri } from "./tauri";
import { setPlatformForTests } from "../lib/platform";
import { useToasts } from "../store/toastStore";
import {
  deliverSelfCheck,
  registerBuilderScreen,
  selfCheckDeps,
  setBuilderObserved,
  useBuilder,
  writeBuilderInput,
  writePaste,
} from "../store/builderStore";
import { OVERLAY_ALREADY_OPEN, OVERLAY_TOOK_PASTE, PASTE_END, PASTE_START, PASTE_STILL_UNSENT } from "../lib/builderInject";

function writes(): string[] {
  return tauri()
    .callsOf("pty_write")
    .map((c) => new TextDecoder().decode(new Uint8Array(c.args.data as number[])));
}

function attach(vendor: "claude" | "codex") {
  useBuilder.getState().attach("c1", "ws", "pty1", vendor);
}

beforeEach(() => {
  vi.useFakeTimers();
  tauri().fixture("pty_write", null);
  tauri().fixture("builder_last_output_at", null);
});

afterEach(() => {
  vi.useRealTimers();
});

const msg = "[Plyloft] self-check\nline two";

describe("writePaste", () => {
  it("chains the paste and a separate Enter for Codex on Windows", async () => {
    setPlatformForTests("windows");
    attach("codex");
    const done = writePaste("pty1", msg);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}`]);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}`, "\r"]);
  });

  it("keeps a second message out of the first one's paste and Enter", async () => {
    setPlatformForTests("windows");
    attach("codex");
    const first = writePaste("pty1", "one");
    const second = writePaste("pty1", "two");
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([first, second]);
    expect(writes()).toEqual([
      `${PASTE_START}one${PASTE_END}`,
      "\r",
      `${PASTE_START}two${PASTE_END}`,
      "\r",
    ]);
  });

  // 1.170.0 F1 (Windows walk 2026-10-26): the live screen still shows the
  // paste unsent after the Enter — the Enter goes once more, nothing else.
  it("sends the Enter again while Codex's composer on screen still holds the paste", async () => {
    setPlatformForTests("windows");
    attach("codex");
    setBuilderObserved("c1", true);
    const held = ["• Done.", "", "› [Pasted Content 3210 chars]", "", "  GPT-6-Astra default · C:\\tmp"].join("\n");
    const empty = ["› [Pasted Content 3210 chars]", "", "• Working (1s • esc to interrupt)", "", "› Ask Codex to do anything", "", "  GPT-6-Astra default · C:\\tmp"].join("\n");
    const enters = () => writes().filter((w) => w === "\r").length;
    const off = registerBuilderScreen("c1", () => (enters() < 2 ? held : empty));
    try {
      const done = writePaste("pty1", msg);
      await vi.advanceTimersByTimeAsync(8_000);
      await done;
      expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}`, "\r", "\r"]);
    } finally {
      off();
      setBuilderObserved("c1", false);
    }
  });

  // 1.170.0 Challenger MAJOR 1: the Enter was taken and the turn prints
  // without a pause — the screen decides at once, and the person's typing
  // held meanwhile goes after the confirmation wait, not after its limit.
  it("releases the person's typing at the confirmation wait while the turn runs", async () => {
    setPlatformForTests("windows");
    attach("codex");
    setBuilderObserved("c1", true);
    const pastedAt = Date.now();
    // Quiet after the paste's own redraw; never quiet once the Enter went.
    tauri().fixture("builder_last_output_at", () => (writes().includes("\r") ? Date.now() : pastedAt + 20));
    const working = ["› [Pasted Content 3210 chars]", "", "• Working (1s • esc to interrupt)", "", "› Ask Codex to do anything"].join("\n");
    const off = registerBuilderScreen("c1", () => working);
    try {
      const done = writePaste("pty1", msg);
      writeBuilderInput("pty1", "a");
      await vi.advanceTimersByTimeAsync(600);
      expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}`, "\r"]);
      await vi.advanceTimersByTimeAsync(1_700);
      await done;
      await vi.advanceTimersByTimeAsync(0);
      expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}`, "\r", "a"]);
    } finally {
      off();
      setBuilderObserved("c1", false);
    }
  });

  it("sends nothing more when the screen shows the message taken", async () => {
    setPlatformForTests("windows");
    attach("codex");
    setBuilderObserved("c1", true);
    const off = registerBuilderScreen("c1", () => ["› Ask Codex to do anything", "", "  GPT-6-Astra default"].join("\n"));
    try {
      const done = writePaste("pty1", msg);
      await vi.advanceTimersByTimeAsync(15_000);
      await done;
      expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}`, "\r"]);
    } finally {
      off();
      setBuilderObserved("c1", false);
    }
  });

  // 1.172.0 E2 (Windows walk 2026-10-28): Codex's transcript search took
  // the message's keys. No Enter goes into it, and the write rejects — the
  // delivery is "failed", not "Sent".
  it("rejects, with no Enter, when Codex shows its transcript search", async () => {
    setPlatformForTests("windows");
    attach("codex");
    setBuilderObserved("c1", true);
    const find = ["› Ask Codex to do anything", "", "  GPT-6.1-Sol default · C:\\tmp", "Find: and settles case handling.", "No matches · full transcript · esc cancel"].join("\n");
    const composer = find.split("\n").slice(0, 3).join("\n");
    let typed = false;
    const off = registerBuilderScreen("c1", () => (typed ? find : composer));
    tauri().fixture("pty_write", () => {
      typed = true;
      return null;
    });
    try {
      const done = writePaste("pty1", msg);
      const outcome = done.then(
        () => "resolved",
        (e: Error) => e.message,
      );
      writeBuilderInput("pty1", "a");
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await outcome).toBe(OVERLAY_TOOK_PASTE);
      await vi.advanceTimersByTimeAsync(0);
      // The person's own typing still goes, after it.
      expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}`, "a"]);
    } finally {
      off();
      setBuilderObserved("c1", false);
    }
  });

  it("types nothing while Codex's transcript search is already open", async () => {
    setPlatformForTests("windows");
    attach("codex");
    setBuilderObserved("c1", true);
    const find = ["› Ask Codex to do anything", "", "Find: ", "Type to find · full transcript · esc cancel"].join("\n");
    const off = registerBuilderScreen("c1", () => find);
    try {
      const outcome = writePaste("pty1", msg).then(
        () => "resolved",
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcome).toBe(OVERLAY_ALREADY_OPEN);
      expect(writes()).toEqual([]);
    } finally {
      off();
      setBuilderObserved("c1", false);
    }
  });

  it("types Codex's Windows paste as plain keys; the Mac's is unchanged", async () => {
    setPlatformForTests("windows");
    attach("codex");
    const done = writePaste("pty1", "a \u2192 b\n\n\n\u201cc\u201d");
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(writes()).toEqual([`${PASTE_START}a -> b\n\n"c"${PASTE_END}`, "\r"]);
  });

  // E2 (Challenger 5, 2): the composer shows the plain text Plyloft typed —
  // still there after every Enter, it is "still unsent", not "Sent"; and the
  // retry of the same message sends only the Enter, never a second copy.
  it("reads a typographic message held as its plain text, and never pastes it twice", async () => {
    setPlatformForTests("windows");
    attach("codex");
    setBuilderObserved("c1", true);
    const text = "[Plyloft] Fix: a \u2192 b \u201cc\u201d and \u2018d\u2019";
    const held = ["• Done.", "", "› [Plyloft] Fix: a -> b \"c\" and 'd'", "", "  GPT-6.1-Sol default · C:\\tmp"].join("\n");
    const off = registerBuilderScreen("c1", () => held);
    const plainPaste = `${PASTE_START}[Plyloft] Fix: a -> b "c" and 'd'${PASTE_END}`;
    try {
      const first = writePaste("pty1", text).then(
        () => "resolved",
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await first).toBe(PASTE_STILL_UNSENT);
      expect(writes()).toEqual([plainPaste, "\r", "\r", "\r"]);
      const again = writePaste("pty1", text).then(
        () => "resolved",
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await again).toBe(PASTE_STILL_UNSENT);
      expect(writes().filter((w) => w.startsWith(PASTE_START))).toEqual([plainPaste]);
    } finally {
      off();
      setBuilderObserved("c1", false);
    }
  });

  // E2 (Challenger 2, 4): the self-check left in Codex's composer counts as
  // there — no retry pastes on top of it — and the search open says so once
  // on the card's toast, with nothing typed.
  it("self-check: left unsent is not retried; the search open is told once", async () => {
    setPlatformForTests("windows");
    attach("codex");
    setBuilderObserved("c1", true);
    const message = "[Plyloft] Finish and check - self-check first.";
    useBuilder.setState((s) => ({
      selfCheck: { ...s.selfCheck, c1: { workspaceId: "ws", startedAt: Date.now(), deliveredAt: null, message, token: "tok-e2" } },
    }));
    let screen = ["› Ask Codex to do anything", "", "Find: ", "Type to find · full transcript · esc cancel"].join("\n");
    const off = registerBuilderScreen("c1", () => screen);
    const toasts = () => useToasts.getState().toasts.filter((t) => t.title === "Re-reading didn't reach the Builder");
    try {
      const a = deliverSelfCheck("c1");
      await vi.advanceTimersByTimeAsync(0);
      expect(await a).toBe(false);
      const b = deliverSelfCheck("c1");
      await vi.advanceTimersByTimeAsync(0);
      expect(await b).toBe(false);
      expect(writes()).toEqual([]);
      expect(toasts()).toHaveLength(1);
      expect(toasts()[0].body).toMatch(/Press Esc in the session/);
      // The search closed; the message then sits in the composer unsent.
      screen = ["• Done.", "", `› ${message}`, "", "  GPT-6.1-Sol default"].join("\n");
      const c = deliverSelfCheck("c1");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await c).toBe(true);
      expect(writes().filter((w) => w.startsWith(PASTE_START))).toHaveLength(1);
    } finally {
      off();
      setBuilderObserved("c1", false);
      useBuilder.setState((s) => {
        const rest = { ...s.selfCheck };
        delete rest.c1;
        return { selfCheck: rest };
      });
    }
  });

  // 1.173.0 A1 (the known issue from the 1.169.1 Windows walk, re-walked
  // 2026-10-27 03:51 as step 2): the first Finish and check of a Codex
  // Builder that had been stopped. Codex drew the long self-check as text
  // in a composer scrolled to its cursor, under "Conversation interrupted",
  // and took the first Enter as a newline. Through the store's delivery,
  // that screen reads as held, so the Enter goes once more and nothing is
  // pasted twice; the check counts as delivered.
  it("self-check: drawn as text after an interrupted turn, the Enter goes again", async () => {
    setPlatformForTests("windows");
    attach("codex");
    setBuilderObserved("c1", true);
    const paragraphs = [
      "[Plyloft] Finish and check - self-check first. Go over your own change on this branch.",
      "",
      "For each class, look for a defect of that kind in what you wrote and open the code.",
      "Fix what you find and run the tests again. Do not start other work.",
      "",
      "Then answer with one line per class, A to I. End your answer with this line:",
      "Self-check complete: <number of classes> classes (ply-a1walk)",
      "Then stop and wait: Plyloft takes the snapshot once it sees that line.",
    ];
    const message = paragraphs.join("\n");
    useBuilder.setState((s) => ({
      selfCheck: { ...s.selfCheck, c1: { workspaceId: "ws", startedAt: Date.now(), deliveredAt: null, message, token: "tok-a1" } },
    }));
    const footer = "  GPT-6.1-Sol default · C:\\ply-test\\sandboxes\\n170\\.plyloft-worktrees\\card-a1";
    const interrupted = ["  Task:", "  Win: Add a triple function", "", "", "■ Conversation interrupted - use /feedback if something went wrong", "", ""];
    // Scrolled: the chevron row is a blank line from the middle of the
    // message; the newline the first Enter became is the empty row under it.
    const held = [...interrupted, "›", ...paragraphs.slice(2).map((l) => (l ? `  ${l}` : "")), "", "", footer].join("\n");
    const taken = [...paragraphs.slice(5).map((l) => `  ${l}`), "", "• Working (1s • esc to interrupt)", "", "› Ask Codex to do anything", "", footer].join("\n");
    const enters = () => writes().filter((w) => w === "\r").length;
    const off = registerBuilderScreen("c1", () => (enters() < 2 ? held : taken));
    try {
      const done = deliverSelfCheck("c1");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await done).toBe(true);
      expect(writes()).toEqual([`${PASTE_START}${message}${PASTE_END}`, "\r", "\r"]);
    } finally {
      off();
      setBuilderObserved("c1", false);
      useBuilder.setState((s) => {
        const rest = { ...s.selfCheck };
        delete rest.c1;
        return { selfCheck: rest };
      });
    }
  });

  // Round 3: the search took part of the self-check — the toast says it is
  // typed in again once the session is quiet; the told-once mark goes with
  // the run (selfCheckDeps.setRun), so the next run is told again.
  it("self-check: told once per run, and again for the next run", async () => {
    setPlatformForTests("windows");
    attach("codex");
    setBuilderObserved("c1", true);
    const message = "[Plyloft] Finish and check - self-check first.";
    const startRun = () =>
      useBuilder.setState((s) => ({
        selfCheck: { ...s.selfCheck, c1: { workspaceId: "ws", startedAt: Date.now(), deliveredAt: null, message, token: "tok-again" } },
      }));
    const composer = ["› Ask Codex to do anything", "", "  GPT-6.1-Sol default"].join("\n");
    const find = [...composer.split("\n"), "Find: ", "Type to find · full transcript · esc cancel"].join("\n");
    // The search opens once the paste was written.
    const screen = () => (writes().some((w) => w.startsWith(PASTE_START)) ? find : composer);
    const off = registerBuilderScreen("c1", () => screen());
    const told = () => useToasts.getState().toasts.filter((t) => t.title === "Re-reading didn't reach the Builder");
    try {
      startRun();
      const a = deliverSelfCheck("c1");
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await a).toBe(false);
      expect(told()).toHaveLength(1);
      expect(told()[0].body).toMatch(/clear Codex's message box first: Plyloft types it in again once the session has been quiet for a few seconds\.$/);
      const b = deliverSelfCheck("c1");
      await vi.advanceTimersByTimeAsync(0);
      expect(await b).toBe(false);
      expect(told()).toHaveLength(1);
      // The run ends; a new one with the same token is told again.
      selfCheckDeps().setRun("c1", null);
      useToasts.setState({ toasts: [] });
      startRun();
      const c = deliverSelfCheck("c1");
      await vi.advanceTimersByTimeAsync(0);
      expect(await c).toBe(false);
      expect(told()).toHaveLength(1);
    } finally {
      off();
      setBuilderObserved("c1", false);
      selfCheckDeps().setRun("c1", null);
    }
  });

  // Round 2 (Challenger 3): the person's Enter sends the message left
  // unsent; once the screen shows it taken it is no longer "unsent", so a
  // later send of the same message is pasted as a new one.
  it("forgets a message left unsent once the person's Enter took it", async () => {
    setPlatformForTests("windows");
    attach("codex");
    setBuilderObserved("c1", true);
    const text = "[Plyloft] The Reviewer approved it, nothing else is needed.";
    let screen = ["• Done.", "", `› ${text}`, "", "  GPT-6.1-Sol default"].join("\n");
    const off = registerBuilderScreen("c1", () => screen);
    try {
      const first = writePaste("pty1", text).then(
        () => "resolved",
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await first).toBe(PASTE_STILL_UNSENT);
      // The person presses Enter; Codex takes it into a turn.
      writeBuilderInput("pty1", "\r");
      screen = [`› ${text}`, "", "• Working (1s • esc to interrupt)", "", "› Ask Codex to do anything", "", "  GPT-6.1-Sol default"].join("\n");
      await vi.advanceTimersByTimeAsync(2_000);
      // The same words in the box again (typed by the person, say): it is
      // no longer Plyloft's unsent paste, so the send pastes its own copy
      // rather than submitting theirs.
      screen = ["• Done.", "", `› ${text}`, "", "  GPT-6.1-Sol default"].join("\n");
      const again = writePaste("pty1", text).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(15_000);
      await again;
      expect(writes().filter((w) => w.startsWith(PASTE_START))).toHaveLength(2);
    } finally {
      off();
      setBuilderObserved("c1", false);
    }
  });

  it("drops a cursor position report that comes during the paste, and holds the rest", async () => {
    setPlatformForTests("windows");
    attach("codex");
    const done = writePaste("pty1", msg);
    writeBuilderInput("pty1", "\x1b[38;1R");
    writeBuilderInput("pty1", "\x1b[I");
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}`, "\r", "\x1b[I"]);
  });

  it("sends Claude's paste and CR in one write on Windows", async () => {
    setPlatformForTests("windows");
    attach("claude");
    await writePaste("pty1", msg);
    expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}\r`]);
    expect(tauri().callsOf("builder_last_output_at")).toHaveLength(0);
  });

  it.each(["claude", "codex"] as const)("sends %s's paste and CR in one write on the Mac", async (vendor) => {
    setPlatformForTests("mac");
    attach(vendor);
    await writePaste("pty1", msg);
    expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}\r`]);
    expect(tauri().callsOf("builder_last_output_at")).toHaveLength(0);
  });
});

// 2026-10-15 (Claude Code 2.1.300): text reaching the composer with `!` as
// its first character runs a shell command, even in the read-only profile;
// a leading `/` opens the slash menu. Plyloft's own messages get one space
// in front; the member's keystrokes are written as typed.
describe("composer guard", () => {
  it.each(["claude", "codex"] as const)("sends %s an injected message that starts with ! with a leading space", async (vendor) => {
    setPlatformForTests("mac");
    attach(vendor);
    useBuilder.getState().markPromptBox("c1", true);
    useBuilder.getState().inject("c1", "!touch pwned\n[Plyloft] findings");
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual([`${PASTE_START} !touch pwned\n[Plyloft] findings${PASTE_END}\r`]);
  });

  it("guards a held message when the prompt box frees up", async () => {
    setPlatformForTests("mac");
    attach("claude");
    useBuilder.getState().markPromptBox("c1", false);
    useBuilder.getState().inject("c1", "/clear this");
    expect(writes()).toEqual([]);
    useBuilder.getState().markPromptBox("c1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual([`${PASTE_START} /clear this${PASTE_END}\r`]);
  });

  it("guards only the start of a multi-message flush: a later message starting with ! is unchanged", async () => {
    setPlatformForTests("mac");
    attach("claude");
    useBuilder.getState().markPromptBox("c1", false);
    useBuilder.getState().inject("c1", "[Plyloft] findings");
    useBuilder.getState().inject("c1", "!second");
    useBuilder.getState().markPromptBox("c1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual([`${PASTE_START}[Plyloft] findings\n\n!second${PASTE_END}\r`]);
  });

  it("guards Codex's separate-Enter paste on Windows", async () => {
    setPlatformForTests("windows");
    attach("codex");
    const done = writePaste("pty1", "!x");
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(writes()).toEqual([`${PASTE_START} !x${PASTE_END}`, "\r"]);
  });

  it("leaves an ordinary message and the member's own ! keystroke as they are", async () => {
    setPlatformForTests("mac");
    attach("claude");
    await writePaste("pty1", msg);
    writeBuilderInput("pty1", "!");
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}\r`, "!"]);
  });
});

describe("writeBuilderInput", () => {
  it("writes each keystroke at once when no paste is pending", async () => {
    setPlatformForTests("windows");
    attach("codex");
    writeBuilderInput("pty1", "h");
    writeBuilderInput("pty1", "i");
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual(["h", "i"]);
  });

  it("holds the human's typing while Codex's paste waits for its Enter, then writes it in order after", async () => {
    setPlatformForTests("windows");
    attach("codex");
    const done = writePaste("pty1", msg);
    writeBuilderInput("pty1", "a");
    await vi.advanceTimersByTimeAsync(200);
    writeBuilderInput("pty1", "b");
    writeBuilderInput("pty1", "\r");
    // Nothing of the human's is in the composer before Ply's Enter.
    expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}`]);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}`, "\r", "ab\r"]);
    // And afterwards, straight through again.
    writeBuilderInput("pty1", "c");
    await vi.advanceTimersByTimeAsync(0);
    expect(writes().slice(-1)[0]).toBe("c");
  });

  it("holds through queued pastes and writes the typing after the last Enter", async () => {
    setPlatformForTests("windows");
    attach("codex");
    const first = writePaste("pty1", "one");
    const second = writePaste("pty1", "two");
    writeBuilderInput("pty1", "x");
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual([
      `${PASTE_START}one${PASTE_END}`,
      "\r",
      `${PASTE_START}two${PASTE_END}`,
      "\r",
      "x",
    ]);
  });

  it("still writes the held typing when the paste's write fails", async () => {
    setPlatformForTests("windows");
    attach("codex");
    let failNext = true;
    tauri().fixture("pty_write", () => {
      if (failNext) {
        failNext = false;
        throw new Error("pty gone");
      }
      return null;
    });
    const done = writePaste("pty1", msg);
    writeBuilderInput("pty1", "z");
    await expect(done).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes().slice(-1)[0]).toBe("z");
  });

  it("is never held on the Mac", async () => {
    setPlatformForTests("mac");
    attach("codex");
    const done = writePaste("pty1", msg);
    writeBuilderInput("pty1", "k");
    await done;
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}\r`, "k"]);
  });
});

// 1.172.0 B3 (self-check leftovers): a write of Ply's stamps the PTY's
// activity beacon even when the CLI draws nothing for it, so the card's
// live terminal scans its screen again — after a paste, and after the
// keystrokes held behind one (whose `onWritten` never ran).
describe("the rescan after Ply's writes", () => {
  it("asks the live terminal to scan again once a paste is written", async () => {
    setPlatformForTests("mac");
    attach("claude");
    const rescan = vi.fn();
    const off = registerBuilderScreen("c1", () => "", rescan);
    try {
      await writePaste("pty1", msg);
      expect(rescan).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
    // Unregistered: nothing is asked.
    await writePaste("pty1", msg);
    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it("asks again after the held keystrokes are written (Windows' Codex)", async () => {
    setPlatformForTests("windows");
    attach("codex");
    const rescan = vi.fn();
    const off = registerBuilderScreen("c1", () => "", rescan);
    try {
      const done = writePaste("pty1", msg);
      writeBuilderInput("pty1", "a");
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      await vi.advanceTimersByTimeAsync(0);
      expect(writes()).toEqual([`${PASTE_START}${msg}${PASTE_END}`, "\r", "a"]);
      // Once for the paste, once for the held keystrokes.
      expect(rescan).toHaveBeenCalledTimes(2);
    } finally {
      off();
    }
  });

  it("asks nothing when the paste's write fails", async () => {
    setPlatformForTests("mac");
    attach("claude");
    tauri().fixture("pty_write", () => {
      throw new Error("pty gone");
    });
    const rescan = vi.fn();
    const off = registerBuilderScreen("c1", () => "", rescan);
    try {
      await expect(writePaste("pty1", msg)).rejects.toBeTruthy();
      expect(rescan).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });
});
