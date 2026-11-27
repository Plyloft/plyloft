// UX-0.1: a PTY tile whose process ends stays on the grid with its output and
// says how it ended. Before, every exit read "Killed" and the tile was removed
// after 1.5 s, output included.
//
//  1. Exit code 0 → "done", the code kept; a crash → "crashed" with its code.
//  2. A later report without a code never erases the one already known.
//  3. Restart replaces the tile in place: same label and cwd, a new id (so the
//     grid mounts a fresh PTY), running again, still expanded if it was.
//  4. Closing an ended tile removes it at once and kills nothing.
//  5. The header labels.
import { describe, expect, it } from "vitest";
import { useTiles } from "../store/tileStore";
import { exitedLabel, exitStatus } from "../lib/tileExit";
import { tauri } from "./render";

const WS = "ws-exit";

function tiles() {
  return useTiles.getState().byWorkspace[WS]?.tiles ?? [];
}

function newShell() {
  const t = useTiles.getState().addShellTile(WS, "/tmp/project");
  useTiles.getState().setPtyId(t.id, "pty-1");
  return t;
}

describe("an ended PTY tile", () => {
  it("stays, as done for code 0 and crashed otherwise", () => {
    const a = newShell();
    useTiles.getState().markExited(a.id, 0);
    expect(tiles()[0]).toMatchObject({ id: a.id, status: "done", exitCode: 0 });

    const b = useTiles.getState().addClaudeTile(WS, "/tmp/project");
    useTiles.getState().markExited(b.id, 137);
    expect(tiles()[1]).toMatchObject({ id: b.id, status: "crashed", exitCode: 137 });
  });

  it("keeps a known code when a later report has none", () => {
    const a = newShell();
    useTiles.getState().markExited(a.id, 2);
    useTiles.getState().markExited(a.id, null);
    expect(tiles()[0]).toMatchObject({ status: "crashed", exitCode: 2 });
  });

  it("restarts in place with a new id", () => {
    const a = newShell();
    useTiles.getState().setExpanded(WS, a.id);
    useTiles.getState().markExited(a.id, 0);
    useTiles.getState().restartTile(a.id);
    const [fresh] = tiles();
    expect(tiles()).toHaveLength(1);
    expect(fresh.id).not.toBe(a.id);
    expect(fresh).toMatchObject({
      label: a.label,
      cwd: a.cwd,
      status: "running",
      ptyId: null,
    });
    expect(fresh.exitCode).toBeUndefined();
    expect(useTiles.getState().byWorkspace[WS].expandedTileId).toBe(fresh.id);
  });

  it("does not restart a tile that is still running", () => {
    const a = newShell();
    useTiles.getState().restartTile(a.id);
    expect(tiles()[0].id).toBe(a.id);
  });

  it("closes at once without killing anything", async () => {
    const a = newShell();
    useTiles.getState().markExited(a.id, 0);
    await useTiles.getState().closeTile(a.id);
    expect(tiles()).toHaveLength(0);
    expect(tauri().callsOf("pty_kill")).toHaveLength(0);
  });

  it("labels the header", () => {
    // QoL 1.168 (block 4, S3-1): plain words; the code in the tooltip.
    expect(exitedLabel(exitStatus(0), 0)).toBe("Ended");
    expect(exitedLabel(exitStatus(1), 1)).toBe("Ended · error code 1");
    expect(exitedLabel(exitStatus(130), 130)).toBe("Ended with Ctrl-C");
    expect(exitedLabel(exitStatus(137), 137)).toBe("Ended · error code 137");
    expect(exitedLabel(exitStatus(null), null)).toBe("Stopped unexpectedly");
    // QoL 1.168 (block 10 Mac walk): Claude or Codex ending with a code.
    expect(exitedLabel(exitStatus(1), 1, false, "claude")).toBe("Stopped unexpectedly");
    expect(exitedLabel(exitStatus(130), 130, false, "codex")).toBe("Ended with Ctrl-C");
  });
});
