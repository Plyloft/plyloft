// GH #210 / #211: drive a real `CodexSession` (the `codex-chat` tile body)
// through the stubbed Tauri layer. The App Server's side is played by emitting
// `codex-app://message` events with the protocol's own shapes (generated with
// `codex app-server generate-ts`: `TurnCompletedNotification` is
// `{ threadId, turn }`, `turn.status` one of completed | interrupted | failed |
// inProgress; `ItemStartedNotification` is `{ item, threadId, turnId }`).
import { expect } from "vitest";
import { CodexSession } from "../components/CodexSession";
import { act, nextFrame, renderUi, screen, tauri, waitFor } from "./render";

export const SESSION = "codex-chat-test";
const PROCESS = 7;
const THREAD = "thread-1";

/** Deliver one App Server message, without `act` — for a test that needs it
 *  in the same `act` as something else, before React re-renders. */
export function deliverCodex(message: Record<string, unknown>) {
  tauri().emit("codex-app://message", { sessionId: SESSION, processId: PROCESS, message });
}

export function emitCodex(message: Record<string, unknown>) {
  act(() => deliverCodex(message));
}

export function writes(): Record<string, unknown>[] {
  return tauri()
    .callsOf("codex_app_write")
    .map((c) => c.args.message as Record<string, unknown>);
}

/** Render the tile and answer the handshake: initialize, then thread/start. */
export async function renderReadySession() {
  const r = renderUi(<CodexSession sessionId={SESSION} workspaceId="ws" cwd="/p" />, {
    fixtures: {
      codex_approval_list: [],
      cli_fresh_check: null,
      codex_app_start: PROCESS,
      codex_app_write: () => null,
      codex_app_stop: () => null,
    },
  });
  await waitFor(() => expect(writes().some((m) => m.method === "initialize")).toBe(true));
  emitCodex({ id: 1, result: {} });
  await waitFor(() => expect(writes().some((m) => m.method === "thread/start")).toBe(true));
  emitCodex({ id: 2, result: { thread: { id: THREAD } } });
  await screen.findByText("Codex ready");
  return r;
}

/** Wait for the session to be back between turns (GH #294: the tile header
 *  says "Ready", so the session marks it on its root, not in words). */
export async function settled() {
  await waitFor(() =>
    expect(document.querySelector(".codex-session")?.getAttribute("data-state")).toBe("ready"),
  );
}

/** Send a prompt and let the App Server start the turn. */
export async function startTurn(r: ReturnType<typeof renderUi>, turnId: string) {
  await r.user.type(screen.getByPlaceholderText("Ask Codex…"), "do it");
  await r.user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(writes().some((m) => m.method === "turn/start")).toBe(true));
  emitCodex({
    method: "turn/started",
    params: { threadId: THREAD, turn: { id: turnId, status: "inProgress", items: [] } },
  });
  await nextFrame();
}

export function turnCompleted(turnId: string, status: string): Record<string, unknown> {
  return {
    method: "turn/completed",
    params: { threadId: THREAD, turn: { id: turnId, status, items: [], error: null } },
  };
}

export function completeTurn(turnId: string, status: string) {
  emitCodex(turnCompleted(turnId, status));
}

/** A command that runs: started, prints, completes. `commandActions` is
 *  Codex's reading of it (`read` | `listFiles` | `search` | `unknown`);
 *  left out, the item carries none. */
export function runCommand(
  turnId: string,
  itemId: string,
  command: string,
  commandActions?: { type: string; command: string }[],
) {
  const item = { type: "commandExecution", id: itemId, command, ...(commandActions ? { commandActions } : {}) };
  emitCodex({
    method: "item/started",
    params: { threadId: THREAD, turnId, item: { ...item, status: "inProgress" } },
  });
  emitCodex({
    method: "item/commandExecution/outputDelta",
    params: { threadId: THREAD, turnId, itemId, delta: "output\n" },
  });
  emitCodex({
    method: "item/completed",
    params: { threadId: THREAD, turnId, item: { ...item, status: "completed", exitCode: 0 } },
  });
}

export function emitExit() {
  act(() =>
    tauri().emit("codex-app://exit", { sessionId: SESSION, processId: PROCESS, exitCode: 1 }),
  );
}

/** The transcript's lines, in order. */
export function transcriptLines(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".codex-entry")].map((e) => e.textContent ?? "");
}
