// Card chat (part 2): the card's Chat tab, rendered against the stubbed
// Tauri layer (no real Claude or Codex).
//
//  1. The store merges `chat://messages` by id, per vendor.
//  2. The tab reads the chat and draws every role; idle opens the composer;
//     tokens are counted, never priced.
//  3. Enter sends (Shift+Enter is a new line), opening the vendor first; a
//     refused send keeps the draft and says why.
//  4. Working: no composer, Stop interrupts. Stopped with a reason: the
//     reason; with Claude's trust question: the trust step.
//  5. `attention`: Show terminal mounts an xterm on the chat's PTY — first
//     paint from `chat_screen`, then `pty://data`; keys go to `pty_write`.
//  6. Attachments: drop and paste (raw bytes and headers), chips, remove,
//     a refused file with its reason.
//  7. Switching the vendor keeps both histories.
//  8. A finished answer is announced; another card's events change nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { ChatPanel } from "../components/ChatPanel";
import type { ChatMessage, ChatSnapshot, ChatVendor } from "../ipc";
import { FOLDER_TRUST_REFUSAL } from "../lib/claudeReviewTrust";
import { CHAT_ATTACHMENT_ACCEPT, TELL_BUILDER_SENT, attachmentAddedWords, pastedFileName, tellBuilderMessage } from "../lib/chatView";
import { lifecycleStepChanged } from "../lib/cardLifecycle";
import { setPlatformForTests } from "../lib/platform";
import { chatKey, useChat } from "../store/chatStore";
import { useWorkspaces } from "../store/workspaceStore";
import { fireEvent, renderUi, screen, waitFor, within } from "./render";
import { tauri } from "./tauri";

const written: string[] = [];
let typeInto: ((data: string) => void) | null = null;

vi.mock("@xterm/xterm", () => {
  const noop = () => ({ dispose() {} });
  class FakeTerm {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { length: 0, getLine: () => undefined } };
    constructor(options: { cols?: number; rows?: number } = {}) {
      this.cols = options.cols ?? 80;
      this.rows = options.rows ?? 24;
      written.push(`[new ${this.cols}x${this.rows}]`);
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          return noop;
        },
      });
    }
    // As a real xterm: a write is parsed later, then its callback runs.
    write(data: string | Uint8Array, done?: () => void) {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      setTimeout(() => {
        written.push(text);
        done?.();
      }, 0);
    }
    onData(handler: (data: string) => void) {
      typeInto = handler;
      return { dispose() {} };
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      written.push(`[resize ${cols}x${rows}]`);
    }
    dispose() {
      written.push("[disposed]");
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return undefined;
    }
    fit() {
      written.push("[fit]");
    }
    dispose() {}
  },
}));

const WS = "ws-1";
const CARD = "card-1";
const USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };

function msg(id: string, role: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text, attachmentIds: [], done: true, isError: false, at: 1, ...extra };
}

function snapshot(vendor: ChatVendor, extra: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    workspaceId: WS,
    cardId: CARD,
    vendor,
    status: "idle",
    reason: null,
    attention: null,
    messages: [],
    usage: USAGE,
    attachments: [],
    ptyId: null,
    ...extra,
  };
}

function mount(fixtures: Record<string, unknown> = {}) {
  return renderUi(<ChatPanel workspaceId={WS} cardId={CARD} />, {
    fixtures: { chat_messages: snapshot("claude"), ...fixtures },
  });
}

async function loaded() {
  await waitFor(() => expect(useChat.getState().byKey[chatKey(WS, CARD)]?.loaded).toBe(true));
}

/** A dropped or pasted file as WebKit hands it over (jsdom's `File` has no
 *  `arrayBuffer`). */
function fakeFile(name: string, bytes: Uint8Array, type = "", size = bytes.length): File {
  return { name, type, size, arrayBuffer: async () => bytes.slice().buffer } as unknown as File;
}

function composer() {
  return screen.getByRole("textbox", { name: /Message to/ }) as HTMLTextAreaElement;
}

function emitState(status: string, extra: Record<string, unknown> = {}) {
  act(() =>
    tauri().emit("chat://state", { workspaceId: WS, cardId: CARD, vendor: "claude", status, usage: USAGE, ...extra }),
  );
}

beforeEach(() => {
  written.length = 0;
  typeInto = null;
  useWorkspaces.setState({ workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply" } as never], activeId: WS });
});

describe("chatStore", () => {
  it("merges chat://messages by id, per vendor, keeping the order", () => {
    const store = useChat.getState();
    store.applySnapshot(snapshot("claude", { messages: [msg("u1", "user", "hi"), msg("a1", "assistant", "He", { done: false })] }), false);
    store.applyMessages({
      workspaceId: WS,
      cardId: CARD,
      vendor: "claude",
      messages: [msg("a1", "assistant", "Hello there"), msg("t1", "tool", "")],
    });
    store.applyMessages({ workspaceId: WS, cardId: CARD, vendor: "codex", messages: [msg("c1", "assistant", "codex")] });
    const view = useChat.getState().byKey[chatKey(WS, CARD)];
    expect(view.conversations.claude?.messages.map((m) => [m.id, m.text])).toEqual([
      ["u1", "hi"],
      ["a1", "Hello there"],
      ["t1", ""],
    ]);
    expect(view.conversations.codex?.messages.map((m) => m.id)).toEqual(["c1"]);
  });
});

describe("the card's Chat tab", () => {
  it("reads the chat and draws every role; tokens, never a cost", async () => {
    mount({
      chat_messages: snapshot("claude", {
        usage: { ...USAGE, inputTokens: 1200, outputTokens: 340, cacheReadTokens: 5000 },
        messages: [
          msg("u1", "user", "What does this card want?"),
          msg("t1", "tool", "", { tool: { name: "Read", detail: "src/main.ts", outcome: "done" } }),
          msg("a1", "assistant", "It wants **one** thing."),
          msg("s1", "shell", "ls -la", { tool: { name: "shell", detail: "total 0", outcome: "done" } }),
          msg("i1", "interrupted", ""),
          msg("n1", "notice", "The conversation starts afresh.", { isError: true }),
          msg("u2", "user", "lost", { isError: true }),
        ],
      }),
    });
    await loaded();
    const log = screen.getByRole("list", { name: "Conversation with Claude" });
    expect(within(log).getByText("What does this card want?")).toBeTruthy();
    expect(within(log).getByText("Claude used Read: src/main.ts")).toBeTruthy();
    expect(within(log).getByText("A shell command ran")).toBeTruthy();
    expect(within(log).getByText("ls -la")).toBeTruthy();
    expect(within(log).getByText("You stopped this answer.")).toBeTruthy();
    expect(within(log).getByText("The conversation starts afresh.")).toBeTruthy();
    expect(within(log).getByText(/Not sent\./)).toBeTruthy();
    await waitFor(() => expect(log.querySelector("[data-ply-markdown] strong")?.textContent).toBe("one"));
    const tokens = screen.getByText(/Tokens in this conversation/).textContent ?? "";
    expect(tokens).toContain("1,200 in");
    expect(tokens).toContain("340 out");
    expect(tokens).toContain("5,000 read from the cache");
    expect(tokens).not.toContain("$");
    expect(screen.getByText(/Discussion only/)).toBeTruthy();
    expect(composer().disabled).toBe(false);
  });

  // 1.174.0 E10 (T14): no "tokens" line at zero, and one control.
  it("has no tokens line before anything was used, and one control to pick who answers", async () => {
    mount({ chat_messages: snapshot("claude", { usage: USAGE, messages: [] }) });
    await loaded();
    expect(document.querySelector("[data-ply-chat-tokens]")).toBeNull();
    expect(document.body.textContent).not.toContain("No tokens used yet");
    const groups = screen.getAllByRole("group", { name: "Use this tab to" });
    expect(groups).toHaveLength(1);
    expect(screen.queryByRole("group", { name: "Chat with" })).toBeNull();
    // No plan offered here: the two AIs only.
    expect(within(groups[0]).getAllByRole("button").map((b) => b.textContent)).toEqual(["Ask Claude", "Ask Codex"]);
    expect(within(groups[0]).getByRole("button", { name: "Ask Claude" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("sends on Enter (opening the vendor first), keeps Shift+Enter a new line, and clears the draft", async () => {
    const sent = msg("u1", "user", "Hello");
    const { user } = mount({ chat_open: snapshot("claude"), chat_send: sent });
    await loaded();
    await user.type(composer(), "Hello{Shift>}{Enter}{/Shift}there");
    expect(tauri().callsOf("chat_send")).toHaveLength(0);
    expect(composer().value).toBe("Hello\nthere");
    await user.type(composer(), "{Enter}");
    await waitFor(() => expect(tauri().callsOf("chat_send")).toHaveLength(1));
    expect(tauri().callsOf("chat_open")[0].args).toMatchObject({ workspaceId: WS, cardId: CARD, vendor: "claude" });
    expect(tauri().callsOf("chat_send")[0].args).toMatchObject({ text: "Hello\nthere", attachmentIds: [] });
    await waitFor(() => expect(composer().value).toBe(""));
    expect(within(screen.getByRole("list", { name: "Conversation with Claude" })).getByText("Hello")).toBeTruthy();
  });

  it("keeps the draft and says why when a send is refused", async () => {
    const { user } = mount({
      chat_open: snapshot("claude"),
      chat_send: () => {
        throw "Claude is answering. Wait for it, or press Stop.";
      },
    });
    await loaded();
    await user.type(composer(), "Again{Enter}");
    expect(await screen.findByText(/Your message wasn't sent. Claude is answering/)).toBeTruthy();
    expect(composer().value).toBe("Again");
  });

  it("while working: a draft can be written but not sent, and Stop interrupts", async () => {
    const { user } = mount({ chat_interrupt: null, chat_open: snapshot("claude"), chat_send: msg("u1", "user", "next") });
    await loaded();
    emitState("working");
    expect(composer().disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    await user.type(composer(), "next{Enter}");
    // Not sendable now: Enter is a new line, never a key that does nothing.
    expect(composer().value).toBe("next\n");
    expect(tauri().callsOf("chat_send")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(tauri().callsOf("chat_interrupt")[0].args).toMatchObject({ workspaceId: WS, cardId: CARD });
    emitState("ready");
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    composer().focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(tauri().callsOf("chat_send")).toHaveLength(1));
    await waitFor(() => expect(composer().value).toBe(""));
    // Focus stays in the composer for the next message.
    expect(document.activeElement).toBe(composer());
  });

  it("stopped: shows the reason, and Claude's trust question as the trust step", async () => {
    mount({ claude_review_trust_status: { folder: "/cfg/claude-sessions", trusted: false } });
    await loaded();
    emitState("stopped", { reason: "Claude asks you to sign in. Plyloft never signs in for you." });
    expect(screen.getByText(/Claude asks you to sign in/)).toBeTruthy();
    expect(composer().disabled).toBe(false);
    emitState("stopped", { reason: FOLDER_TRUST_REFUSAL });
    expect(await screen.findByText("Claude needs to trust Plyloft's review folder.")).toBeTruthy();
    expect(screen.getByText(/before this chat could start/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Claude there" })).toBeTruthy();
    // The question is never answered for the member: nothing is written.
    expect(tauri().callsOf("pty_write")).toHaveLength(0);
  });

  it("attention: Show terminal paints chat_screen at the grid's 120 × 40, never resizing the PTY; keys reach it", async () => {
    const { user } = mount({
      chat_screen: { ptyId: "pty-9", formatted: "\u001b[?2004h\u001b[H❯ 1. Opus", offset: 0, rows: 40, cols: 120 },
      pty_write: null,
    });
    await loaded();
    emitState("working", { attention: "Claude shows a menu.", ptyId: "pty-9" });
    expect(screen.getByText(/Claude is waiting on its own screen$/)).toBeTruthy();
    const show = screen.getByRole("button", { name: "Show terminal" });
    await user.click(show);
    await waitFor(() => expect(written.join("")).toContain("❯ 1. Opus"));
    // Made at the grid's size, no resize, then the paint — which carries
    // bracketed paste on.
    const paint = written.findIndex((w) => w.includes("❯ 1. Opus"));
    expect(written.indexOf("[new 120x40]")).toBeLessThan(paint);
    expect(written.some((w) => w.startsWith("[resize"))).toBe(false);
    expect(written[paint]).toContain("\u001b[?2004h");
    expect(document.querySelector(".ux-chat-terminal-scroll .ux-chat-terminal-pane")).toBeTruthy();
    expect(show.getAttribute("aria-controls")).toBe(document.querySelector("[data-ply-chat-terminal]")?.id);
    expect(screen.getByText(/Ctrl\+C goes to Claude/)).toBeTruthy();
    expect(screen.getByText(/runs with your rights/)).toBeTruthy();
    expect(tauri().callsOf("chat_screen")[0].args).toMatchObject({ workspaceId: WS, cardId: CARD });
    act(() => tauri().emit("pty://data", { id: "pty-9", data: Array.from(new TextEncoder().encode("after")), offset: 0 }));
    act(() => tauri().emit("pty://data", { id: "pty-other", data: Array.from(new TextEncoder().encode("not mine")) }));
    await waitFor(() => expect(written.join("")).toContain("after"));
    expect(written.join("")).not.toContain("not mine");
    act(() => typeInto?.("2"));
    await waitFor(() => expect(tauri().callsOf("pty_write")).toHaveLength(1));
    expect(tauri().callsOf("pty_write")[0].args).toMatchObject({ id: "pty-9" });
    // The view never ends the session.
    expect(tauri().callsOf("pty_kill")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Hide terminal" }));
    expect(document.querySelector("[data-ply-chat-terminal]")).toBeNull();
    // Neither shown nor hidden does the view resize or end the PTY.
    expect(tauri().callsOf("pty_resize")).toHaveLength(0);
    expect(tauri().callsOf("pty_kill")).toHaveLength(0);
  });

  it("takes a grid of another size before painting it, and still sends no size", async () => {
    const { user } = mount({
      chat_screen: { ptyId: "pty-9", formatted: "[paint]", offset: 0, rows: 24, cols: 60 },
    });
    await loaded();
    emitState("ready", { ptyId: "pty-9" });
    await user.click(screen.getByRole("button", { name: "Show terminal" }));
    await waitFor(() => expect(written).toContain("[paint]"));
    expect(written.indexOf("[resize 60x24]")).toBeGreaterThanOrEqual(0);
    expect(written.indexOf("[resize 60x24]")).toBeLessThan(written.indexOf("[paint]"));
    expect(written).not.toContain("[fit]");
    expect(tauri().callsOf("pty_resize")).toHaveLength(0);
  });

  it("Add files… offers exactly the kinds the backend takes", async () => {
    const { readFileSync } = await import("node:fs");
    const rust = readFileSync("src-tauri/src/chat_attachments.rs", "utf8");
    const list = (name: string) =>
      [...(new RegExp(`const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`).exec(rust)?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    const backend = [...list("IMAGE_EXTENSIONS"), "pdf", "docx", ...list("TEXT_EXTENSIONS")];
    expect(list("TEXT_EXTENSIONS").length).toBeGreaterThan(0);
    expect(CHAT_ATTACHMENT_ACCEPT.split(",")).toEqual(backend.map((e) => `.${e}`));
    // Windows filters the picker by them; macOS's panel gets no filter
    // (WKWebView could keep Open disabled, Mac walk F3): the backend checks.
    setPlatformForTests("windows");
    const win = mount();
    await loaded();
    expect(document.querySelector<HTMLInputElement>("[data-ply-file-pick]")!.accept).toBe(CHAT_ATTACHMENT_ACCEPT);
    win.unmount();
    setPlatformForTests("mac");
    mount();
    await loaded();
    expect(document.querySelector<HTMLInputElement>("[data-ply-file-pick]")!.hasAttribute("accept")).toBe(false);
  });

  it("the self-check counts no step for the Chat, but does for a step beside it", () => {
    expect(lifecycleStepChanged(null, "chat")).toBe(false);
    expect(lifecycleStepChanged("chat", null)).toBe(false);
    expect(lifecycleStepChanged("run", "chat")).toBe(true);
    expect(lifecycleStepChanged("chat", "run")).toBe(true);
    expect(lifecycleStepChanged("run", "outcome")).toBe(true);
  });

  it("writes only the stream bytes the first paint doesn't hold: none doubled, none lost", async () => {
    let answer: (v: unknown) => void = () => {};
    const { user } = mount({
      chat_screen: () => new Promise((resolve) => (answer = resolve)),
    });
    await loaded();
    emitState("ready", { ptyId: "pty-9" });
    await user.click(screen.getByRole("button", { name: "Show terminal" }));
    await waitFor(() => expect(tauri().callsOf("chat_screen")).toHaveLength(1));
    const enc = (t: string) => Array.from(new TextEncoder().encode(t));
    // Arrives while the screen is read: "AAAA" is in the grid (offset 0–4),
    // "BB" straddles its end (4–6), "CC" comes after it.
    act(() => tauri().emit("pty://data", { id: "pty-9", data: enc("AAAA"), offset: 0 }));
    act(() => tauri().emit("pty://data", { id: "pty-9", data: enc("XBB"), offset: 4 }));
    act(() => answer({ ptyId: "pty-9", formatted: "grid", offset: 5, rows: 40, cols: 120 }));
    await waitFor(() => expect(written.join("")).toContain("grid"));
    act(() => tauri().emit("pty://data", { id: "pty-9", data: enc("CC"), offset: 7 }));
    await waitFor(() => expect(written.join("")).toContain("CC"));
    const out = written.filter((w) => !w.startsWith("[")).join("");
    expect(out).toBe("gridBBCC");
  });

  it("unmounted with the card page: listeners and the xterm go, the PTY stays as it was", async () => {
    const view = mount({
      chat_screen: { ptyId: "pty-9", formatted: "x", offset: 1, rows: 40, cols: 120 },
    });
    await loaded();
    emitState("ready", { ptyId: "pty-9" });
    await view.user.click(screen.getByRole("button", { name: "Show terminal" }));
    await waitFor(() => expect(written).toContain("x"));
    expect(tauri().listeners("pty://data")).toBe(1);
    expect(tauri().listeners("chat://state")).toBe(1);
    view.unmount();
    expect(tauri().listeners("pty://data")).toBe(0);
    expect(tauri().listeners("pty://exit")).toBe(0);
    expect(tauri().listeners("chat://state")).toBe(0);
    expect(tauri().listeners("chat://messages")).toBe(0);
    expect(written).toContain("[disposed]");
    expect(tauri().callsOf("pty_resize")).toHaveLength(0);
    expect(tauri().callsOf("pty_kill")).toHaveLength(0);
  });

  it("an unmount before the listeners are in leaves none behind", async () => {
    const view = mount();
    view.unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(tauri().listeners("chat://state")).toBe(0);
    expect(tauri().listeners("chat://messages")).toBe(0);
  });

  it("Add files… feeds the picked files through the same raw-bytes path", async () => {
    const doc = { id: "att-3", name: "notes.docx", kind: "docx", bytes: 4096, pages: null, note: null };
    const { user } = mount({ chat_attachment_add: doc });
    await loaded();
    const input = document.querySelector<HTMLInputElement>("[data-ply-file-pick]")!;
    expect(input.type).toBe("file");
    expect(input.multiple).toBe(true);
    const clicked = vi.spyOn(input, "click").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    expect(clicked).toHaveBeenCalledTimes(1);
    Object.defineProperty(input, "files", { value: [fakeFile("notes.docx", new Uint8Array([80, 75, 3, 4]))], configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(tauri().callsOf("chat_attachment_add")).toHaveLength(1));
    expect(tauri().callsOf("chat_attachment_add")[0].args).toBeInstanceOf(Uint8Array);
    const chips = await screen.findByRole("list", { name: "Files sent with your next message" });
    expect(within(chips).getByText("Word · 4.0 KB")).toBeTruthy();
  });

  it("names a pasted image by when it was pasted, and says Remove deletes only Plyloft's copy", async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (...a: unknown[]) => unknown } })
      .__TAURI_INTERNALS__;
    const spy = vi.spyOn(internals, "invoke");
    const image = { id: "att-4", name: "Pasted image", kind: "image", bytes: 3, pages: null, note: null };
    mount({ chat_attachment_add: image });
    await loaded();
    fireEvent.paste(composer(), {
      clipboardData: { types: ["Files"], files: [fakeFile("image.png", new Uint8Array([1, 2, 3]), "image/png")], getData: () => "" },
    });
    await waitFor(() => expect(tauri().callsOf("chat_attachment_add")).toHaveLength(1));
    const call = spy.mock.calls.find((c) => c[0] === "chat_attachment_add");
    const name = decodeURIComponent((call?.[2] as { headers: Record<string, string> }).headers["x-ply-file-name"]);
    expect(name).toMatch(/^Pasted image \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.png$/);
    const remove = await screen.findAllByRole("button", { name: "Remove Pasted image" });
    expect(remove[0].getAttribute("title")).toBe(
      "Remove Pasted image from this chat. Only Plyloft's copy is deleted; your own file stays where it was.",
    );
  });

  it("names pasted images the same way on every platform", () => {
    const at = new Date(2026, 9, 15, 19, 42, 7);
    expect(pastedFileName({ name: "image.png", type: "image/png" }, at)).toBe("Pasted image 2026-10-15 19.42.07.png");
    expect(pastedFileName({ name: "clip", type: "image/jpeg" }, at)).toBe("Pasted image 2026-10-15 19.42.07.jpg");
    expect(pastedFileName({ name: "notes.txt", type: "text/plain" }, at)).toBe("notes.txt");
  });

  it("attaches a dropped file as raw bytes with its headers, shows its chip, sends and removes it", async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (...a: unknown[]) => unknown } })
      .__TAURI_INTERNALS__;
    const spy = vi.spyOn(internals, "invoke");
    const pdf = { id: "att-1", name: "Brief é.pdf", kind: "pdf", bytes: 2048, pages: 15, note: null };
    const { user } = mount({
      chat_attachment_add: pdf,
      chat_attachment_remove: null,
      chat_open: snapshot("claude", { attachments: [pdf as never] }),
      chat_send: msg("u1", "user", "", { attachmentIds: ["att-1"] }),
    });
    await loaded();
    const file = fakeFile("Brief é.pdf", new TextEncoder().encode("%PDF-1.4 x"), "application/pdf");
    const zone = composer().closest("[data-drop-zone]") as HTMLElement;
    expect(zone.getAttribute("data-drop-accepts")).toBe("files");
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [file], getData: () => "" } });
    await waitFor(() => expect(tauri().callsOf("chat_attachment_add")).toHaveLength(1));
    const call = spy.mock.calls.find((c) => c[0] === "chat_attachment_add");
    expect(call?.[1]).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(call?.[1] as Uint8Array)).toBe("%PDF-1.4 x");
    expect((call?.[2] as { headers: Record<string, string> }).headers).toEqual({
      "x-ply-workspace-id": WS,
      "x-ply-card-id": CARD,
      "x-ply-file-name": "Brief%20%C3%A9.pdf",
    });
    const chips = await screen.findByRole("list", { name: "Files sent with your next message" });
    expect(within(chips).getByText("Brief é.pdf")).toBeTruthy();
    expect(within(chips).getByText("PDF · 2.0 KB · 15 pages")).toBeTruthy();
    // A file alone can be sent.
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(tauri().callsOf("chat_send")).toHaveLength(1));
    expect(tauri().callsOf("chat_send")[0].args).toMatchObject({ attachmentIds: ["att-1"] });
    await waitFor(() => expect(screen.queryByRole("list", { name: "Files sent with your next message" })).toBeNull());
    // It is still the card's, until removed.
    await user.click(screen.getByText("Files in this chat (1)"));
    await user.click(screen.getByRole("button", { name: "Remove Brief é.pdf" }));
    await waitFor(() => expect(tauri().callsOf("chat_attachment_remove")).toHaveLength(1));
    expect(tauri().callsOf("chat_attachment_remove")[0].args).toMatchObject({ attachmentId: "att-1" });
    await waitFor(() => expect(screen.queryByText("Files in this chat (1)")).toBeNull());
  });

  it("attaches a pasted image, and not a document's picture of its own text", async () => {
    const image = { id: "att-2", name: "image.png", kind: "image", bytes: 10, pages: null, note: null };
    mount({ chat_attachment_add: image });
    await loaded();
    const png = fakeFile("image.png", new Uint8Array([1, 2, 3]), "image/png");
    fireEvent.paste(composer(), { clipboardData: { types: ["text/plain", "Files"], files: [png], getData: () => "words" } });
    expect(tauri().callsOf("chat_attachment_add")).toHaveLength(0);
    fireEvent.paste(composer(), { clipboardData: { types: ["Files"], files: [png], getData: () => "" } });
    await waitFor(() => expect(tauri().callsOf("chat_attachment_add")).toHaveLength(1));
    const chips = await screen.findByRole("list", { name: "Files sent with your next message" });
    expect(within(chips).getByText("Image · 10 B")).toBeTruthy();
  });

  it("says why a file was refused, and attaches nothing", async () => {
    mount({
      chat_attachment_add: () => {
        throw "notes.exe isn't a file a chat takes: images, PDFs, Word files and text.";
      },
    });
    await loaded();
    const exe = fakeFile("notes.exe", new Uint8Array([77, 90]));
    fireEvent.drop(composer().closest("[data-drop-zone]") as HTMLElement, {
      dataTransfer: { types: ["Files"], files: [exe], getData: () => "" },
    });
    const alert = await screen.findByText(/notes\.exe wasn't attached\. notes\.exe isn't a file a chat takes/);
    expect(alert.closest("[role=alert]")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Files sent with your next message" })).toBeNull();
    // Too large for any kind: refused before its bytes are read.
    const huge = fakeFile("huge.pdf", new Uint8Array(1), "", 40 * 1024 * 1024);
    fireEvent.drop(composer().closest("[data-drop-zone]") as HTMLElement, {
      dataTransfer: { types: ["Files"], files: [huge], getData: () => "" },
    });
    expect(await screen.findByText(/huge\.pdf wasn't attached\. It is 40\.0 MB/)).toBeTruthy();
    expect(tauri().callsOf("chat_attachment_add")).toHaveLength(1);
  });

  it("a stopped answer is finished: no Writing… after the interrupt or once the turn is over", async () => {
    mount();
    await loaded();
    const emitMessages = (messages: ChatMessage[]) =>
      act(() => tauri().emit("chat://messages", { workspaceId: WS, cardId: CARD, vendor: "claude", messages }));
    emitState("working");
    emitMessages([msg("a1", "assistant", "Rivers are", { done: false })]);
    expect(screen.getByText("Writing…")).toBeTruthy();
    emitMessages([msg("i1", "interrupted", "")]);
    expect(screen.queryByText("Writing…")).toBeNull();
    // The same once the state says no turn runs, whatever came first.
    emitMessages([msg("a2", "assistant", "Mountains", { done: false })]);
    expect(screen.getByText("Writing…")).toBeTruthy();
    emitState("ready");
    expect(screen.queryByText("Writing…")).toBeNull();
  });

  it("a stopped answer stays finished after a switch to Codex and back (chat_open still says done: false)", async () => {
    const stopped = [
      msg("u1", "user", "Write an essay"),
      // As the backend before the fix (and an older chat.json) kept it.
      msg("a1", "assistant", "# From SCCS to Git", { done: false }),
      msg("i1", "interrupted", ""),
    ];
    const { user } = mount({
      chat_messages: snapshot("claude", { status: "ready", messages: stopped }),
      chat_open: (args: Record<string, unknown>) =>
        args.vendor === "claude" ? snapshot("claude", { messages: stopped }) : snapshot("codex"),
    });
    await loaded();
    expect(screen.queryByText("Writing…")).toBeNull();
    expect(screen.getByRole("heading", { name: "From SCCS to Git" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Ask Codex" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message to Codex" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Ask Claude" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message to Claude" })).toBeTruthy());
    expect(screen.queryByText("Writing…")).toBeNull();
    expect(screen.getByRole("heading", { name: "From SCCS to Git" })).toBeTruthy();
    expect(screen.queryByText(/# From SCCS/)).toBeNull();
    // "You stopped this answer." is its own text node inside the item, for
    // the test bridge's tree as for a screen reader.
    const line = document.querySelector('[data-ply-chat-role="interrupted"]') as HTMLElement;
    expect(line.querySelector("span")?.textContent).toBe("You stopped this answer.");
  });

  it("keeps one draft per vendor, and doesn't announce the other vendor's last answer after a switch", async () => {
    const { user } = mount({ chat_open: (args: Record<string, unknown>) => snapshot(args.vendor as ChatVendor) });
    await loaded();
    act(() =>
      tauri().emit("chat://messages", { workspaceId: WS, cardId: CARD, vendor: "claude", messages: [msg("a1", "assistant", "TWO")] }),
    );
    const live = document.querySelector("[data-ply-chat-announce]") as HTMLElement;
    await waitFor(() => expect(live.textContent).toBe("Claude answered: TWO"));
    await user.type(composer(), "for Claude");
    await user.click(screen.getByRole("button", { name: "Ask Codex" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message to Codex" })).toBeTruthy());
    expect(composer().value).toBe("");
    expect(live.textContent).toBe("");
    await user.type(composer(), "for Codex");
    await user.click(screen.getByRole("button", { name: "Ask Claude" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message to Claude" })).toBeTruthy());
    expect(composer().value).toBe("for Claude");
    expect(live.textContent).toBe("");
  });

  it("a notice and a tool line are their own text inside the item (the test bridge's tree reads them)", async () => {
    mount({
      chat_messages: snapshot("claude", {
        messages: [
          msg("n1", "notice", "Claude went back to its prompt without saying it had finished; the chat treats this answer as done."),
          msg("t1", "tool", "", { tool: { name: "Read", detail: "README.md", outcome: "done" } } as Partial<ChatMessage>),
        ],
      }),
    });
    await loaded();
    const notice = document.querySelector('[data-ply-chat-role="notice"]') as HTMLElement;
    expect(notice.querySelector("span")?.textContent).toContain("without saying it had finished");
    const tool = document.querySelector('[data-ply-chat-role="tool"]') as HTMLElement;
    expect(tool.querySelector("span")?.textContent).toBe("Claude used Read: README.md");
  });

  it("with a menu on Claude's screen the state line says it waits there, not ready", async () => {
    mount();
    await loaded();
    emitState("ready", { ptyId: "pty-1" });
    expect(screen.getByText("Claude is ready.")).toBeTruthy();
    emitState("ready", { ptyId: "pty-1", attention: "Claude shows a menu on its screen and waits for a choice." });
    expect(screen.getByText("Claude waits for an answer on its own screen.")).toBeTruthy();
    expect(screen.queryByText("Claude is ready.")).toBeNull();
    expect(screen.getByText(/Claude is waiting on its own screen$/)).toBeTruthy(); // the notice's title
    emitState("ready", { ptyId: "pty-1", attention: null });
    expect(screen.getByText("Claude is ready.")).toBeTruthy();
  });

  it("after a refused send the state line says so, not ready", async () => {
    const { user } = mount({
      chat_open: snapshot("claude"),
      chat_send: () => {
        throw "Claude isn't at its prompt right now (its screen shows something else); nothing was sent.";
      },
    });
    await loaded();
    emitState("ready");
    expect(screen.getByText("Claude is ready.")).toBeTruthy();
    await user.type(composer(), "Hi{Enter}");
    expect(await screen.findByText("Claude didn't take your last message. The reason is below.")).toBeTruthy();
    expect(screen.queryByText("Claude is ready.")).toBeNull();
    emitState("working");
    expect(screen.getByText("Claude is answering…")).toBeTruthy();
  });

  it("a name no header can carry is refused with a sentence", async () => {
    mount();
    await loaded();
    fireEvent.drop(composer().closest("[data-drop-zone]") as HTMLElement, {
      dataTransfer: { types: ["Files"], files: [fakeFile("bad\uD800.png", new Uint8Array([1]))], getData: () => "" },
    });
    expect(await screen.findByText(/wasn't attached\. Its name has a character Plyloft can't pass on/)).toBeTruthy();
    expect(tauri().callsOf("chat_attachment_add")).toHaveLength(0);
  });

  it("holds events while a snapshot is on its way: a ready that lands before an older working snapshot wins", async () => {
    let answer: (v: unknown) => void = () => {};
    mount({ chat_messages: () => new Promise((resolve) => (answer = resolve)) });
    await waitFor(() => expect(tauri().callsOf("chat_messages")).toHaveLength(1));
    emitState("ready");
    act(() =>
      tauri().emit("chat://messages", { workspaceId: WS, cardId: CARD, vendor: "claude", messages: [msg("a1", "assistant", "Done")] }),
    );
    await act(async () => answer(snapshot("claude", { status: "working", messages: [msg("a1", "assistant", "Do", { done: false })] })));
    await loaded();
    const claude = useChat.getState().byKey[chatKey(WS, CARD)].conversations.claude!;
    expect(claude.status).toBe("ready");
    expect(claude.messages.map((m) => m.text)).toEqual(["Done"]);
  });

  it("a send's reply lands in the vendor it went to, and the picker waits while it is sent", async () => {
    let answer: (v: unknown) => void = () => {};
    const { user } = mount({
      chat_open: (args: Record<string, unknown>) => snapshot(args.vendor as ChatVendor),
      chat_send: () => new Promise((resolve) => (answer = resolve)),
    });
    await loaded();
    await user.type(composer(), "Hi{Enter}");
    await waitFor(() => expect(tauri().callsOf("chat_send")).toHaveLength(1));
    expect((screen.getByRole("button", { name: "Ask Codex" }) as HTMLButtonElement).disabled).toBe(true);
    // The tab moved to Codex meanwhile (another way in): the reply stays Claude's.
    act(() => useChat.getState().applySnapshot(snapshot("codex"), true));
    await act(async () => answer(msg("u1", "user", "Hi")));
    await waitFor(() => expect(useChat.getState().byKey[chatKey(WS, CARD)].conversations.claude?.messages).toHaveLength(1));
    expect(useChat.getState().byKey[chatKey(WS, CARD)].conversations.codex?.messages ?? []).toHaveLength(0);
  });

  it("switching the vendor keeps both histories", async () => {
    const { user } = mount({
      chat_messages: snapshot("claude", { messages: [msg("a1", "assistant", "From Claude")] }),
      chat_open: (args: Record<string, unknown>) =>
        args.vendor === "codex"
          ? snapshot("codex", { messages: [msg("c1", "assistant", "From Codex")] })
          : snapshot("claude", { messages: [msg("a1", "assistant", "From Claude")] }),
    });
    await loaded();
    expect(await screen.findByText("From Claude")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Ask Codex" }));
    expect(await screen.findByText("From Codex")).toBeTruthy();
    expect(screen.queryByText("From Claude")).toBeNull();
    expect(screen.getByRole("list", { name: "Conversation with Codex" })).toBeTruthy();
    const view = useChat.getState().byKey[chatKey(WS, CARD)];
    expect(view.conversations.claude?.messages.map((m) => m.text)).toEqual(["From Claude"]);
    await user.click(screen.getByRole("button", { name: "Ask Claude" }));
    expect(await screen.findByText("From Claude")).toBeTruthy();
    expect(tauri().callsOf("chat_open").map((c) => c.args.vendor)).toEqual(["codex", "claude"]);
  });

  it("can't switch the vendor while an answer is on its way", async () => {
    mount();
    await loaded();
    emitState("working");
    expect((screen.getByRole("button", { name: "Ask Codex" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("announces a finished answer, and ignores another card's events", async () => {
    mount();
    await loaded();
    const live = document.querySelector("[data-ply-chat-announce]") as HTMLElement;
    expect(live.getAttribute("aria-live")).toBe("polite");
    act(() =>
      tauri().emit("chat://messages", {
        workspaceId: WS,
        cardId: "card-2",
        vendor: "claude",
        messages: [msg("x1", "assistant", "Someone else's")],
      }),
    );
    expect(screen.queryByText("Someone else's")).toBeNull();
    act(() =>
      tauri().emit("chat://messages", {
        workspaceId: WS,
        cardId: CARD,
        vendor: "claude",
        messages: [msg("a1", "assistant", "Half", { done: false })],
      }),
    );
    expect(screen.getByText("Writing…")).toBeTruthy();
    expect(live.textContent).toBe("");
    act(() =>
      tauri().emit("chat://messages", {
        workspaceId: WS,
        cardId: CARD,
        vendor: "claude",
        messages: [msg("a1", "assistant", "Half and done")],
      }),
    );
    await waitFor(() => expect(live.textContent).toBe("Claude answered: Half and done"));
    expect(screen.queryByText("Writing…")).toBeNull();
  });
});

// Follow-ups (Mac walk of 567616d4): files of one name told apart, a file
// being read listed as such, and the conversation that opens at its end.
describe("card chat follow-ups", () => {
  it("tells apart files of one name: (2), (3) and when each was added", async () => {
    const added = new Date(2026, 9, 16, 9, 5).getTime();
    const pdf = (id: string, at: number) => ({ id, name: "fifteen pages.pdf", kind: "pdf", bytes: 2048, pages: 15, note: null, addedAt: at });
    const attachments = [
      pdf("p1", added),
      pdf("p2", added + 60_000),
      { id: "d1", name: "small doc.docx", kind: "docx", bytes: 10, pages: null, note: null, addedAt: added },
      pdf("p3", added + 120_000),
    ];
    const { user } = mount({ chat_messages: snapshot("claude", { attachments: attachments as never }) });
    await loaded();
    await user.click(screen.getByText("Files in this chat (4)"));
    const list = screen.getByRole("list", { name: "Files in this chat" });
    expect(within(list).getByText("fifteen pages.pdf")).toBeTruthy();
    expect(within(list).getByText("fifteen pages.pdf (2)")).toBeTruthy();
    expect(within(list).getByText("fifteen pages.pdf (3)")).toBeTruthy();
    // Each Remove names the one it removes.
    expect(within(list).getByRole("button", { name: "Remove fifteen pages.pdf" })).toBeTruthy();
    expect(within(list).getByRole("button", { name: "Remove fifteen pages.pdf (3)" })).toBeTruthy();
    // When it was added, only where a name repeats (another day: with the date).
    expect(within(list).getByText(/^PDF · 2\.0 KB · 15 pages · added (16 Oct )?09:06$/)).toBeTruthy();
    expect(within(list).getByText("Word · 10 B")).toBeTruthy();
  });

  it("names a file of a repeated name by its label when its removal is refused", async () => {
    const pdf = (id: string) => ({ id, name: "same.pdf", kind: "pdf", bytes: 10, pages: 1, note: null, addedAt: 1 });
    const { user } = mount({
      chat_messages: snapshot("claude", { attachments: [pdf("p1"), pdf("p2")] as never }),
      chat_attachment_remove: () => Promise.reject("the folder is locked"),
    });
    await loaded();
    await user.click(screen.getByText("Files in this chat (2)"));
    const list = screen.getByRole("list", { name: "Files in this chat" });
    await user.click(within(list).getByRole("button", { name: "Remove same.pdf (2)" }));
    expect(await screen.findByText(/^same\.pdf \(2\) wasn't removed\. /)).toBeTruthy();
  });

  it("names the added time by day", () => {
    const at = new Date(2026, 9, 15, 19, 42).getTime();
    expect(attachmentAddedWords(at, new Date(2026, 9, 15, 23, 0))).toBe("added 19:42");
    expect(attachmentAddedWords(at, new Date(2026, 9, 16, 8, 0))).toBe("added 15 Oct 19:42");
    // Another year says which: the same day a year on is not "today".
    expect(attachmentAddedWords(at, new Date(2027, 9, 15, 20, 0))).toBe("added 15 Oct 2026 19:42");
    expect(attachmentAddedWords(at, new Date(2027, 0, 2, 8, 0))).toBe("added 15 Oct 2026 19:42");
    expect(attachmentAddedWords(undefined)).toBeNull();
    expect(attachmentAddedWords(0)).toBeNull();
  });

  it("lists a file still being read in Files in this chat, saying Reading…", async () => {
    let answer: (a: unknown) => void = () => {};
    const kept = { id: "k1", name: "notes.txt", kind: "text", bytes: 5, pages: null, note: null };
    const { user } = mount({
      chat_messages: snapshot("claude", { attachments: [kept as never] }),
      chat_attachment_add: () => new Promise((done) => (answer = done)),
    });
    await loaded();
    const file = fakeFile("slow big.pdf", new TextEncoder().encode("%PDF-1.4 x"), "application/pdf");
    fireEvent.drop(composer().closest("[data-drop-zone]") as HTMLElement, {
      dataTransfer: { types: ["Files"], files: [file], getData: () => "" },
    });
    await waitFor(() => expect(tauri().callsOf("chat_attachment_add")).toHaveLength(1));
    await user.click(screen.getByText("Files in this chat (2)"));
    const list = screen.getByRole("list", { name: "Files in this chat" });
    const row = within(list).getByText("slow big.pdf").closest("li") as HTMLElement;
    expect(row.getAttribute("aria-busy")).toBe("true");
    expect(within(row).getByText("Reading…")).toBeTruthy();
    // Read: the row becomes the file's own.
    await act(async () => answer({ id: "s1", name: "slow big.pdf", kind: "pdf", bytes: 10, pages: 40, note: null }));
    await waitFor(() => expect(within(list).queryByText("Reading…")).toBeNull());
    expect(within(list).getByText("PDF · 10 B · 40 pages")).toBeTruthy();
    expect(screen.getByText("Files in this chat (2)")).toBeTruthy();
  });

  /** The log laid out as a browser would: `height` of content in a 200 px box. */
  function layOut(log: HTMLElement) {
    const box = { height: 1000, top: 0 };
    const client = 200;
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => box.height });
    Object.defineProperty(log, "clientHeight", { configurable: true, get: () => client });
    Object.defineProperty(log, "scrollTop", {
      configurable: true,
      get: () => box.top,
      set: (v: number) => (box.top = Math.max(0, Math.min(v, box.height - client))),
    });
    const scrollTo = vi.fn((o: { top: number }) => {
      log.scrollTop = o.top;
    });
    (log as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
    return { box, scrollTo };
  }

  function say(id: string, text: string) {
    act(() =>
      tauri().emit("chat://messages", { workspaceId: WS, cardId: CARD, vendor: "claude", messages: [msg(id, "assistant", text)] }),
    );
  }

  it("opens at the end, and follows an answer whose markdown is drawn after it lands", async () => {
    const history = [msg("u1", "user", "Hi"), msg("a1", "assistant", "## Hello\n\n- one\n- two")];
    mount({ chat_messages: snapshot("claude", { messages: history }) });
    const log = document.querySelector("[data-ply-chat-log]") as HTMLElement;
    const { box, scrollTo } = layOut(log);
    await loaded();
    await waitFor(() => expect(log.querySelector("[data-ply-markdown]")).toBeTruthy());
    expect(box.top).toBe(800);
    // The next answer's markdown, drawn a moment after it lands, makes the
    // log taller: it is followed to the new end.
    say("a2", "**More**");
    box.height = 1400;
    await waitFor(() => expect(log.querySelectorAll("[data-ply-markdown]")).toHaveLength(2));
    await waitFor(() => expect(box.top).toBe(1200));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1400 });
  });

  it("keeps following after content grew under a scroll at the end (a relaunch), and not after a scroll up", async () => {
    mount({ chat_messages: snapshot("claude", { messages: [msg("a1", "assistant", "First")] }) });
    const log = document.querySelector("[data-ply-chat-log]") as HTMLElement;
    const { box, scrollTo } = layOut(log);
    await loaded();
    log.scrollTop = 800;
    fireEvent.scroll(log);
    // Its scroll event lands after the content grew: the member didn't move.
    box.height = 1500;
    fireEvent.scroll(log);
    scrollTo.mockClear();
    say("a2", "Second");
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 1500 }));
    expect(box.top).toBe(1300);
    // Scrolled up to read: a new answer doesn't move it.
    log.scrollTop = 400;
    fireEvent.scroll(log);
    scrollTo.mockClear();
    box.height = 1700;
    say("a3", "Third");
    await screen.findByText("Third");
    await new Promise((r) => setTimeout(r, 50));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(box.top).toBe(400);
    // Back at the end: it follows again.
    log.scrollTop = 1500;
    fireEvent.scroll(log);
    say("a4", "Fourth");
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
  });
});

// 1.171.0 (E1; CP-1, CF19, LG-21, walk 2026-10-27 #6): the chat is "Ask
// about this card", follows the card's Builder, says the Builder doesn't see
// it, and hands a point to the Builder through Not right's path.
describe("Ask about this card and the Builder", () => {
  function mountWith(
    builder: Parameters<typeof ChatPanel>[0]["builder"],
    fixtures: Record<string, unknown> = {},
  ) {
    return renderUi(<ChatPanel workspaceId={WS} cardId={CARD} builder={builder} />, {
      fixtures: { chat_messages: snapshot("codex"), ...fixtures },
    });
  }

  it("asks for the card's Builder's vendor when the chat never chose one", async () => {
    mountWith({ vendor: "codex", reach: "unbuilt" });
    await loaded();
    expect(tauri().callsOf("chat_messages")[0].args).toMatchObject({ workspaceId: WS, cardId: CARD, vendor: null, preferred: "codex" });
    expect(screen.getByRole("textbox", { name: "Message to Codex" })).toBeTruthy();
  });

  it.each([
    ["builder", "The Builder doesn't see this chat. To change the work, send it to the Builder."],
    ["unbuilt", "The Builder doesn't see this chat. To change what it builds, edit What you want."],
    ["done", "The Builder doesn't see this chat. This card is done: for more changes, use Follow up."],
  ] as const)("says where the Builder stands (%s)", async (reach, line) => {
    mountWith({ vendor: "claude", reach });
    await loaded();
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Send to the Builder" }).length > 0).toBe(false);
  });

  it("Send to the Builder sends the draft to the Builder, not the chat, and clears it once sent", async () => {
    const tell = vi.fn(async () => "sent" as const);
    const { user } = mountWith({ vendor: "claude", reach: "builder", tell }, { chat_messages: snapshot("claude") });
    await loaded();
    const press = screen.getByRole("button", { name: "Send to the Builder" }) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    await user.type(composer(), "Make the button blue");
    expect(press.disabled).toBe(false);
    await user.click(press);
    await waitFor(() => expect(tell).toHaveBeenCalledWith("Make the button blue"));
    await waitFor(() => expect(composer().value).toBe(""));
    expect(tauri().callsOf("chat_send")).toHaveLength(0);
  });

  // 1.175.0 F10 (UX-11; to confirm at the strings' reread): with the field
  // empty, the person's last message goes; the title quotes it.
  // 1.175.0 F10 round 2 (review): with the field empty, Send to the Builder
  // never sends by itself — it puts the person's own last message back in
  // the field; a second press sends it. Messages read back from the CLI's
  // transcript (the session's priming) or relayed are never offered.
  it("Send to the Builder with the field empty puts the person's own last message back; a second press sends it", async () => {
    const tell = vi.fn(async () => "sent" as const);
    const said = (id: string, role: string, text: string, extra: Record<string, unknown> = {}) => ({
      id, role, text, attachmentIds: [], done: true, isError: false, at: 1, ...extra,
    });
    const { user } = mountWith(
      { vendor: "claude", reach: "builder", tell },
      {
        chat_messages: snapshot("claude", {
          messages: [
            // Read back from the session's transcript: Plyloft's priming.
            said("p1", "user", "You are helping with the card “Contact form”."),
            said("r1", "user", "Codex answered: use green.", { relayOf: "a0" }),
            said("a1", "assistant", "I can describe how."),
          ],
        } as never),
        chat_open: snapshot("claude"),
        chat_send: ({ text }: Record<string, unknown>) => said("u9", "user", String(text)),
      },
    );
    await loaded();
    const press = () => screen.getByRole("button", { name: "Send to the Builder" }) as HTMLButtonElement;
    // Nothing the person wrote here yet: off.
    expect(press().disabled).toBe(true);
    // The person writes and sends a message in the chat.
    await user.type(composer(), "Also make the confirmation green and add a small check icon.{Enter}");
    await waitFor(() => expect(tauri().callsOf("chat_send")).toHaveLength(1));
    await waitFor(() => expect(composer().value).toBe(""));
    await waitFor(() => expect(press().disabled).toBe(false));
    expect(press().getAttribute("title")).toBe(
      "Puts your last message, “Also make the confirmation green and add…”, back in the field: read it, then press Send to the Builder to send it to the Builder's session.",
    );
    // First press: back in the field, nothing sent.
    await user.click(press());
    expect(composer().value).toBe("Also make the confirmation green and add a small check icon.");
    expect(tell).not.toHaveBeenCalled();
    // Second press: sent, and the field cleared.
    await user.click(press());
    await waitFor(() => expect(tell).toHaveBeenCalledWith("Also make the confirmation green and add a small check icon."));
    await waitFor(() => expect(composer().value).toBe(""));
  });

  // Immediacy walk 4.8: a message the person typed and sent to the Builder
  // with Send to the Builder is theirs too — the empty field offers it back.
  it("a message sent with Send to the Builder is the one an empty field puts back", async () => {
    const tell = vi.fn(async () => "sent" as const);
    const { user } = mountWith({ vendor: "claude", reach: "builder", tell }, { chat_messages: snapshot("claude"), chat_open: snapshot("claude") });
    await loaded();
    const press = () => screen.getByRole("button", { name: "Send to the Builder" }) as HTMLButtonElement;
    expect(press().disabled).toBe(true);
    await user.type(composer(), "Also add a line 'two' to notes.txt");
    await user.click(press());
    await waitFor(() => expect(tell).toHaveBeenCalledWith("Also add a line 'two' to notes.txt"));
    await waitFor(() => expect(composer().value).toBe(""));
    // The field is empty: the press is on, and puts that message back.
    await waitFor(() => expect(press().disabled).toBe(false));
    await user.click(press());
    expect(composer().value).toBe("Also add a line 'two' to notes.txt");
    expect(tell).toHaveBeenCalledTimes(1);
    expect(tauri().callsOf("chat_send")).toHaveLength(0);
  });

  it("the Builder reads its own intro, not a reviewer's rejection, and is told the files stay in the chat", () => {
    const message = tellBuilderMessage("  Make the button blue \n");
    expect(message).toBe(
      "The person sent you this from the card's chat, a side conversation you don't see. Make this change to the card's work:\n\nMake the button blue",
    );
    expect(message).not.toMatch(/review|reject/i);
    expect(TELL_BUILDER_SENT).toMatch(/Files added in the chat stay there/);
    expect(TELL_BUILDER_SENT).toMatch(/opened so you can watch/);
  });

  it("keeps the draft when it didn't reach the Builder", async () => {
    const tell = vi.fn(async () => "failed" as const);
    const { user } = mountWith({ vendor: "claude", reach: "builder", tell }, { chat_messages: snapshot("claude") });
    await loaded();
    await user.type(composer(), "Not this");
    await user.click(screen.getByRole("button", { name: "Send to the Builder" }));
    await waitFor(() => expect(tell).toHaveBeenCalled());
    expect(composer().value).toBe("Not this");
  });

  it("a pull request's card keeps its own scope line and offers no Not right here", async () => {
    renderUi(
      <ChatPanel
        workspaceId={WS}
        cardId={CARD}
        pullRequest={{ pushable: true }}
        builder={{ vendor: "claude", reach: "builder", tell: async () => "sent" }}
      />,
      { fixtures: { chat_messages: snapshot("claude") } },
    );
    await loaded();
    expect(screen.queryByText(/The Builder doesn't see this chat/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Send to the Builder" })).toBeNull();
  });
});
