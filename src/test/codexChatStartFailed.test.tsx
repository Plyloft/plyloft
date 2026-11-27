// 1.176.0 R7: a `codex-chat` tile whose Codex didn't start says why in plain
// words when it is known, and offers Repair Codex beside Restart — and not
// for a session that answered first, or a refusal that isn't Codex's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSession } from "../components/CodexSession";
import { act, renderUi, screen, tauri, waitFor } from "./render";

const openRepair = vi.fn(async (_tool: string) => {});
vi.mock("../lib/openRepair", () => ({ openRepair: (tool: string) => openRepair(tool) }));

const SESSION = "codex-chat-r7";
const PROCESS = 9;

afterEach(() => openRepair.mockClear());

function mount(fixtures: Record<string, unknown> = {}) {
  return renderUi(<CodexSession sessionId={SESSION} workspaceId="ws" cwd="/p" />, {
    fixtures: {
      codex_approval_list: [],
      cli_fresh_check: null,
      codex_app_start: PROCESS,
      codex_app_write: () => null,
      codex_app_stop: () => null,
      cli_start_verdict: "fails",
      ...fixtures,
    },
  });
}

const emit = (event: string, payload: Record<string, unknown>) =>
  act(() => tauri().emit(event, { sessionId: SESSION, processId: PROCESS, ...payload }));

describe("codex-chat: Codex didn't start", () => {
  it("not there even after looking again: the cause, and Repair Codex", async () => {
    const r = mount({
      cli_fresh_check: () => {
        throw 'PLY_CLI_UNAVAILABLE_V1:{"tool":"codex","was":"/opt/homebrew/bin/codex"}\ncodex: not found in PATH; it was at /opt/homebrew/bin/codex.';
      },
    });
    await screen.findByText(/^Codex couldn't start: Plyloft can't find it on this (Mac|PC) any more\.$/);
    expect(r.tauri.callsOf("codex_app_start")).toEqual([]);
    await r.user.click(screen.getByRole("button", { name: "Repair Codex" }));
    expect(openRepair).toHaveBeenCalledWith("codex");
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
  });

  it("installed but not starting (the backend's refusal): the plain cause, and Repair", async () => {
    mount({
      codex_app_start: () => {
        throw 'PLY_CLI_NOT_STARTING_V1:{"tool":"codex"}\n' + "Codex CLI is installed at /opt/homebrew/bin/codex but doesn't start — its install is incomplete. Repair it in Settings › Setup and account › Diagnostics › Repair, or reinstall it yourself (npm i -g @openai/codex) and press Look again there.";
      },
    });
    await screen.findByText("Codex couldn't start: it is installed but not starting.");
    expect(screen.getByRole("button", { name: "Repair Codex" })).toBeTruthy();
  });

  it("another refusal: the plain sentence alone, no Repair", async () => {
    mount({
      codex_app_start: () => {
        throw "workspace directory does not exist: /p";
      },
    });
    await screen.findByText("Codex couldn't start.");
    expect(screen.queryByRole("button", { name: "Repair Codex" })).toBeNull();
  });

  it("the App Server dies before its first answer and the backend confirms: its stderr stays, and Repair", async () => {
    mount();
    await waitFor(() => expect(tauri().callsOf("codex_app_start").length).toBe(1));
    emit("codex-app://stderr", { text: "Error: Cannot find module '@openai/codex-darwin-arm64'" });
    emit("codex-app://exit", { exitCode: 1 });
    await screen.findByText(
      "Codex couldn't start: it stopped as soon as it started, and it doesn't answer Plyloft's check. What it printed is above.",
    );
    expect(screen.getByText("Error: Cannot find module '@openai/codex-darwin-arm64'")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Repair Codex" })).toBeTruthy();
  });

  it("a session that answered first and then ended: the neutral stop, no Repair", async () => {
    mount();
    await waitFor(() => expect(tauri().callsOf("codex_app_start").length).toBe(1));
    emit("codex-app://message", { message: { id: 1, result: {} } });
    emit("codex-app://exit", { exitCode: 1 });
    await screen.findByText("Codex stopped (exit 1)");
    expect(screen.queryByRole("button", { name: "Repair Codex" })).toBeNull();
  });

  it("a config error before the first answer (Codex answers --version): no Repair", async () => {
    mount({ cli_start_verdict: "starts" });
    await waitFor(() => expect(tauri().callsOf("codex_app_start").length).toBe(1));
    emit("codex-app://stderr", { text: "Error loading config.toml: invalid type" });
    emit("codex-app://exit", { exitCode: 1 });
    await screen.findByText("Codex stopped (exit 1)");
    await waitFor(() => expect(tauri().callsOf("cli_start_verdict").length).toBe(1));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByRole("button", { name: "Repair Codex" })).toBeNull();
  });

  it("an exit Plyloft's own stop causes (Restart) asks nothing", async () => {
    let stops = 0;
    const r = mount({
      cli_start_verdict: "starts",
      codex_app_stop: () => {
        stops += 1;
        // The old App Server's exit lands while Restart stops it.
        tauri().emit("codex-app://exit", { sessionId: SESSION, processId: PROCESS, exitCode: 1 });
        return null;
      },
    });
    await waitFor(() => expect(tauri().callsOf("codex_app_start").length).toBe(1));
    emit("codex-app://exit", { exitCode: 1 });
    await waitFor(() => expect(tauri().callsOf("cli_start_verdict").length).toBe(1));
    await r.user.click(await screen.findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(stops).toBeGreaterThan(0));
    await act(async () => new Promise((res) => setTimeout(res, 20)));
    expect(tauri().callsOf("cli_start_verdict").length).toBe(1);
  });
});
