// Try it (TI-2): a card copy's Try session through the stores.
//
//  1. Start: a shell tile titled "Try · <card>", in the card's copy, marked
//     as that copy's Try session, spawned with its `tryTarget`, the command
//     typed once the shell is ready.
//  2. One per copy: a second start returns the running one and types nothing;
//     another build of the card gets its own.
//  3. Windows PowerShell: `npm run dev` is typed as `npm.cmd run dev`.
//  4. Stop kills the PTY (`pty_kill`), and the tile goes with the exit.
//  5. Output reaches `onOutput` (TI-3's scanner) for that tile only.
//  6. A restarted Try tile stays that copy's.
//  7. A stop Plyloft made (`card://try-stopped`) removes the tiles.
import { describe, expect, it } from "vitest";
import { useTiles } from "../store/tileStore";
import { useDoctor } from "../store/doctorStore";
import { setPlatformForTests } from "../lib/platform";
import {
  onOutput,
  restartTrySession,
  startTrySession,
  stopTrySession,
  trySessionFor,
  type TryCard,
} from "../lib/trySession";
import { startTileSubscriptions } from "../store/tileStore";
import { tauri } from "./render";

const WS = "ws-try";
const card: TryCard = {
  id: "c1",
  workspaceId: WS,
  title: "Dark mode",
  worktreePath: "/r/.plyloft-worktrees/c1",
  buildBoth: { lanes: [{ lane: "b", worktreePath: "/r/.plyloft-worktrees/c1-b" }] },
};

function tiles() {
  return useTiles.getState().byWorkspace[WS]?.tiles ?? [];
}

function writes(): string[] {
  return tauri()
    .callsOf("pty_write")
    .map((c) => new TextDecoder().decode(new Uint8Array(c.args.data as number[])));
}

/** The seams: each wait gives the newest tile without a PTY one and output. */
let ptyCount = 0;
function seams() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
      const pending = tiles().find((t) => !t.ptyId);
      if (pending) {
        ptyCount += 1;
        useTiles.getState().setPtyId(pending.id, `pty-${ptyCount}`);
        useTiles.getState().markOutput(`pty-${ptyCount}`);
      }
    },
  };
}

function start(lane?: "b", command = "npm run dev") {
  return startTrySession(card, lane, { command, ...seams() });
}

describe("a Try session", () => {
  it("starts as the copy's own titled shell tile with the command typed", async () => {
    tauri().fixture("pty_write", null);
    const { tileId, reused } = await start();
    expect(reused).toBe(false);
    const [tile] = tiles();
    expect(tile).toMatchObject({
      id: tileId,
      kind: "shell",
      label: "Try · Dark mode",
      cwd: "/r/.plyloft-worktrees/c1",
      tryOf: { cardId: "c1" },
    });
    expect(writes()).toEqual(["npm run dev\r"]);
    expect(trySessionFor(card)?.id).toBe(tileId);
  });

  it("is one per copy: a second start returns it and types nothing", async () => {
    tauri().fixture("pty_write", null);
    const first = await start();
    const again = await start();
    expect(again).toEqual({ tileId: first.tileId, reused: true });
    expect(tiles()).toHaveLength(1);
    expect(writes()).toHaveLength(1);
    // Another build of the card is another copy.
    const lane = await start("b");
    expect(lane.reused).toBe(false);
    expect(tiles().find((t) => t.id === lane.tileId)).toMatchObject({
      cwd: "/r/.plyloft-worktrees/c1-b",
      tryOf: { cardId: "c1", lane: "b" },
    });
    expect(trySessionFor(card, "b")?.id).toBe(lane.tileId);
    expect(trySessionFor(card)?.id).toBe(first.tileId);
  });

  it("two quick presses start one session", async () => {
    tauri().fixture("pty_write", null);
    const [a, b] = await Promise.all([start(), start()]);
    expect(a.tileId).toBe(b.tileId);
    expect(tiles()).toHaveLength(1);
  });

  it("replaces an ended Try tile of the copy", async () => {
    tauri().fixture("pty_write", null);
    const first = await start();
    useTiles.getState().markExited(first.tileId, 1);
    const next = await start();
    expect(next.tileId).not.toBe(first.tileId);
    expect(tiles().map((t) => t.id)).toEqual([next.tileId]);
  });

  it("types the .cmd shim in PowerShell on Windows where the PATH has it", async () => {
    setPlatformForTests("windows");
    tauri().fixture("pty_write", null);
    tauri().fixture("try_cmd_shims_available", () => ["npm", "npx"]);
    useDoctor.getState().setEnv({ ...(useDoctor.getState().env ?? {}), shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" } as never);
    await start();
    expect(writes()).toEqual(["npm.cmd run dev\r"]);
    expect(tauri().callsOf("try_cmd_shims_available")[0].args).toEqual({ names: ["npm", "pnpm", "yarn", "npx", "bun"] });
    // No bun.cmd on the PATH (a native bun.exe): as typed.
    await start("b", "bun run dev");
    expect(writes()[1]).toBe("bun run dev\r");
  });

  it("types the command as typed when no shim is found, and never asks off PowerShell", async () => {
    setPlatformForTests("windows");
    tauri().fixture("pty_write", null);
    tauri().fixture("try_cmd_shims_available", () => []);
    useDoctor.getState().setEnv({ ...(useDoctor.getState().env ?? {}), shell: "pwsh" } as never);
    await start();
    expect(writes()).toEqual(["npm run dev\r"]);
    // The Mac: no lookup at all.
    setPlatformForTests("mac");
    await start("b");
    expect(writes()[1]).toBe("npm run dev\r");
    expect(tauri().callsOf("try_cmd_shims_available")).toHaveLength(1);
  });

  it("stops through pty_kill, and the tile goes with the exit", async () => {
    tauri().fixture("pty_write", null);
    tauri().fixture("pty_kill", null);
    const { tileId } = await start();
    const ptyId = tiles()[0].ptyId;
    await stopTrySession(card);
    expect(tauri().callsOf("pty_kill").map((c) => c.args.id)).toEqual([ptyId]);
    expect(tiles()[0]).toMatchObject({ id: tileId, pendingClose: true });
    expect(trySessionFor(card)).toBeNull();
    // Nothing running: nothing to stop.
    await stopTrySession({ id: "nope", workspaceId: WS });
    expect(tauri().callsOf("pty_kill")).toHaveLength(1);
  });

  it("feeds its output to onOutput, that tile's only", async () => {
    tauri().fixture("pty_write", null);
    const seen: string[] = [];
    const { tileId } = await start();
    const off = onOutput(tileId, (d) => seen.push(new TextDecoder().decode(d)));
    await new Promise((r) => setTimeout(r, 0));
    const ptyId = tiles()[0].ptyId;
    tauri().emit("pty://data", { id: ptyId, data: Array.from(new TextEncoder().encode("Local: http://localhost:5173/")) });
    tauri().emit("pty://data", { id: "someone-else", data: [65] });
    expect(seen).toEqual(["Local: http://localhost:5173/"]);
    off();
    tauri().emit("pty://data", { id: ptyId, data: [66] });
    expect(seen).toHaveLength(1);
  });

  it("subscribes startTrySession's onOutput before typing", async () => {
    tauri().fixture("pty_write", null);
    let subscribedBeforeWrite = false;
    await startTrySession(card, null, {
      command: "npm run dev",
      onOutput: () => {},
      onSubscribed: () => {
        subscribedBeforeWrite = writes().length === 0;
      },
      ...seams(),
    });
    expect(subscribedBeforeWrite).toBe(true);
  });

  it("stays the copy's Try session when restarted", async () => {
    tauri().fixture("pty_write", null);
    const { tileId } = await start();
    useTiles.getState().markExited(tileId, 0);
    useTiles.getState().restartTile(tileId);
    expect(tiles()[0]).toMatchObject({ label: "Try · Dark mode", tryOf: { cardId: "c1" }, status: "running" });
  });

  it("restarts with the command typed again while its folder is there", async () => {
    tauri().fixture("pty_write", null);
    tauri().fixture("try_folder_exists", () => true);
    const { tileId } = await start();
    useTiles.getState().markExited(tileId, 1);
    const fresh = await restartTrySession(tileId, seams());
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(tileId);
    expect(tiles()).toHaveLength(1);
    expect(tiles()[0]).toMatchObject({ id: fresh, status: "running", tryOf: { cardId: "c1", command: "npm run dev" } });
    expect(tauri().callsOf("try_folder_exists")[0].args).toEqual({ path: "/r/.plyloft-worktrees/c1" });
    expect(writes()).toEqual(["npm run dev\r", "npm run dev\r"]);
  });

  it("goes instead of restarting in a copy that was removed", async () => {
    tauri().fixture("pty_write", null);
    tauri().fixture("try_folder_exists", () => false);
    const { tileId } = await start();
    useTiles.getState().markExited(tileId, 1);
    expect(await restartTrySession(tileId, seams())).toBeNull();
    expect(tiles()).toHaveLength(0);
    expect(writes()).toHaveLength(1);
  });

  it("goes when Plyloft stopped it to remove the copy", async () => {
    tauri().allowUnhandled();
    tauri().fixture("pty_write", null);
    await startTileSubscriptions(async () => null);
    const { tileId } = await start();
    const plain = useTiles.getState().addShellTile(WS, "/r");
    useTiles.getState().setPtyId(plain.id, "pty-plain");
    const claude = useTiles.getState().addClaudeTile(WS, "/r/.plyloft-worktrees/c1");
    useTiles.getState().setPtyId(claude.id, "pty-claude");
    const before = tiles().filter((t) => !t.tryOf);
    const ptyId = tiles().find((t) => t.id === tileId)!.ptyId;
    tauri().emit("card://try-stopped", {
      workspaceId: WS,
      cardId: "c1",
      lane: null,
      reason: "ship",
      ptyIds: [ptyId, "pty-plain", "pty-claude"],
      words: "Plyloft stopped your app's preview to ship it.",
    });
    // Only the Try tile goes; the others stay, the very same objects (their
    // terminals stay mounted).
    expect(tiles().map((t) => t.id)).toEqual([plain.id, claude.id]);
    tiles().filter((t) => !t.tryOf).forEach((t, i) => expect(t).toBe(before[i]));
  });
});
