// GH #210: after Stop, "Interrupting…" said work was under way; once the turn
// ends it must not keep saying so. The line is closed in place with what
// happened. The real `CodexSession`, the App Server played through the stub.
//
//  1. Stop → "Interrupting…" → turn/completed (interrupted) → "Interrupted.",
//     and no "Interrupting…" left anywhere.
//  2. A turn Codex reports `completed` (the interrupt came too late) →
//     "Finished before it could be stopped." (review 1, n3)
//  3. Two presses in one turn → one line, one closed line.
//  4. The process exits mid-interrupt (no turn/completed follows) → closed.
//  Review 1:
//  5. m4 — Stop pressed after turn/completed arrived, before the re-render:
//     no line, no request, nothing carried into the next turn.
//  6. m4 — another turn's completion does not close the line; a new turn
//     starting drops a line whose turn's end was never seen.
//  7. n2 — a refused turn/interrupt write: the line goes, the error shows.
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, tauri, waitFor } from "./render";
import {
  completeTurn,
  deliverCodex,
  emitCodex,
  turnCompleted,
  emitExit,
  renderReadySession,
  startTurn,
  transcriptLines,
  writes,
  settled,
} from "./codexChat";

async function pressStop() {
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(screen.getByText("Interrupting…")).toBeTruthy());
}

describe("the Interrupting… line closes when the turn ends (GH #210)", () => {
  it("1. interrupted turn → Interrupted.", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    await pressStop();
    expect(writes().some((m) => m.method === "turn/interrupt")).toBe(true);

    completeTurn("turn-1", "interrupted");
    await screen.findByText("Interrupted.");
    expect(transcriptLines(r.container)).not.toContain("Interrupting…");
    // The session is back between turns and the line is where Stop put it: last.
    await settled();
    expect(transcriptLines(r.container).slice(-1)).toEqual(["Interrupted."]);
  });

  it("2. a turn that completed anyway says so", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    await pressStop();

    completeTurn("turn-1", "completed");
    await screen.findByText("Finished before it could be stopped.");
    expect(transcriptLines(r.container)).not.toContain("Interrupting…");
    expect(transcriptLines(r.container)).not.toContain("Interrupted.");
  });

  it("3. two presses, one line", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    await pressStop();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(writes().filter((m) => m.method === "turn/interrupt")).toHaveLength(2),
    );
    expect(transcriptLines(r.container).filter((l) => l === "Interrupting…")).toHaveLength(1);

    completeTurn("turn-1", "interrupted");
    await screen.findByText("Interrupted.");
    expect(transcriptLines(r.container).filter((l) => l === "Interrupted.")).toHaveLength(1);
    expect(transcriptLines(r.container)).not.toContain("Interrupting…");

    // The next turn's Stop opens a line of its own.
    await startTurn(r, "turn-2");
    await pressStop();
    completeTurn("turn-2", "interrupted");
    await waitFor(() =>
      expect(transcriptLines(r.container).filter((l) => l === "Interrupted.")).toHaveLength(2),
    );
    expect(transcriptLines(r.container)).not.toContain("Interrupting…");
  });

  it("4. the process exits before the turn completes: the line still closes", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    await pressStop();

    emitExit();
    await screen.findByText("Interrupted.");
    expect(transcriptLines(r.container)).not.toContain("Interrupting…");
  });

  it("5. Stop after turn/completed arrived but before the re-render opens nothing", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    const stop = screen.getByRole("button", { name: "Stop" });
    // One act: the completion is handled, and the Stop that was still on
    // screen is pressed before React re-renders it away.
    act(() => {
      deliverCodex(turnCompleted("turn-1", "completed"));
      stop.click();
    });
    await settled();
    expect(writes().some((m) => m.method === "turn/interrupt")).toBe(false);
    expect(transcriptLines(r.container)).not.toContain("Interrupting…");

    // The next turn inherits nothing: its end says nothing about a Stop.
    await startTurn(r, "turn-2");
    completeTurn("turn-2", "interrupted");
    await settled();
    const lines = transcriptLines(r.container);
    expect(lines).not.toContain("Interrupting…");
    expect(lines).not.toContain("Interrupted.");
  });

  it("6. only its own turn closes the line; a new turn drops a stale one", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    await pressStop();

    // Another turn's end is not this one's.
    completeTurn("turn-0", "interrupted");
    expect(transcriptLines(r.container)).toContain("Interrupting…");
    expect(transcriptLines(r.container)).not.toContain("Interrupted.");

    // turn-1's end never arrives; turn-2 starts. Its outcome is unknown, so
    // the line goes rather than be closed with a guess.
    emitCodex({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress", items: [] } },
    });
    await waitFor(() => expect(transcriptLines(r.container)).not.toContain("Interrupting…"));
    expect(transcriptLines(r.container)).not.toContain("Interrupted.");
  });

  it("7. a refused interrupt request: the line goes and the error shows", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    tauri().fixture("codex_app_write", ({ message }: Record<string, unknown>) => {
      if ((message as { method?: string }).method === "turn/interrupt") {
        throw new Error("pipe closed");
      }
      return null;
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText(/pipe closed/);
    expect(transcriptLines(r.container)).not.toContain("Interrupting…");

    // The turn's own end then closes nothing.
    completeTurn("turn-1", "completed");
    await settled();
    expect(transcriptLines(r.container)).not.toContain("Interrupted.");
    expect(transcriptLines(r.container)).not.toContain("Finished before it could be stopped.");
  });
});
