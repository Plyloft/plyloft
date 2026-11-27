// QoL 1.168 G1 and S3: the update sheet counts every open session and
// terminal (not only Builders) in plain words, offers "Install when my work is
// done" (the sidebar row then waits), and a failure is an ErrorBlock with Try
// again and the download page — the raw text only under Details.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UpdatePromptView,
  UpdateStatusRow,
  installAtQuitWithin,
  setUpdateFlowForTests,
} from "../components/UpdatePrompt";
import { updateValue } from "../components/settings/ProfilePage";
import { UpdateFlow, type UpdateHandle } from "../lib/updateFlow";
import { useTiles } from "../store/tileStore";
import type { Tile } from "../store/tileStore";
import { act, renderUi, screen, tauri, waitFor } from "./render";

function handle(version: string, download: () => Promise<void> = async () => {}): UpdateHandle {
  return { version, download, install: async () => {}, close: async () => {} };
}

function tile(id: string, kind: string): Tile {
  return { id, kind, status: "running", label: id, ptyId: `pty-${id}` } as unknown as Tile;
}

beforeEach(() => {
  tauri().allowUnhandled();
  act(() =>
    useTiles.setState({
      byWorkspace: {
        ws: {
          tiles: [tile("a", "claude"), tile("b", "codex"), tile("c", "shell")],
          expandedTileId: null,
          detailTileId: null,
        },
      },
    }),
  );
});

afterEach(() => {
  setUpdateFlowForTests(null);
  act(() => useTiles.setState({ byWorkspace: {} }));
});

describe("the update sheet", () => {
  it("counts every open session and terminal, without jargon", async () => {
    const flow = new UpdateFlow({
      check: async () => handle("1.169.0"),
      relaunch: async () => {},
      log: { info: () => {}, error: () => {} },
    });
    setUpdateFlowForTests(flow);
    await flow.runCheck("launch");
    renderUi(<UpdatePromptView />);
    const dialog = await screen.findByRole("dialog");
    const text = dialog.textContent ?? "";
    expect(text).toContain("2 open sessions and 1 terminal close.");
    expect(text).toContain("Claude and Codex keep their conversations");
    expect(text).not.toMatch(/worktree|terminal panes|transcripts|terminate/i);
    expect(screen.getByRole("button", { name: "Install and restart" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Later" })).toBeTruthy();
  });

  it("Install when my work is done leaves a waiting row with Install now", async () => {
    let release: () => void = () => {};
    const flow = new UpdateFlow({
      check: async () => handle("1.169.0", () => new Promise<void>((r) => (release = r))),
      relaunch: async () => {},
      log: { info: () => {}, error: () => {} },
    });
    setUpdateFlowForTests(flow);
    await flow.runCheck("launch");
    const r = renderUi(
      <>
        <UpdatePromptView />
        <UpdateStatusRow />
      </>,
    );
    await r.user.click(await screen.findByRole("button", { name: "Install when my work is done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Plyloft 1.169.0 installs when your work is done")).toBeTruthy();
    expect(flow.getState().kind).toBe("scheduled");
    release();
    await r.user.click(screen.getByRole("button", { name: "Install now" }));
    expect(flow.getState().kind).toBe("confirming");
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("a failure is an error block with Try again, the raw text under Details", async () => {
    let fail = false;
    const flow = new UpdateFlow({
      check: async () => handle("1.169.0", async () => {
        if (fail) throw "error decoding response body";
      }),
      relaunch: async () => {},
      log: { info: () => {}, error: () => {} },
    });
    setUpdateFlowForTests(flow);
    await flow.runCheck("launch");
    fail = true;
    await act(() => flow.confirmInstall());
    renderUi(<UpdatePromptView />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Plyloft couldn't download the update.");
    expect(dialog.textContent).toContain("This version of Plyloft keeps working");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download from plyloft.com" })).toBeTruthy();
    // The raw text sits in the closed Details, not in a sentence.
    const sentences = [...dialog.querySelectorAll(".ux-error-sentence, .ux-error-title")].map((n) => n.textContent);
    expect(sentences.join(" ")).not.toContain("error decoding");
    expect(dialog.querySelector(".ux-error-output")?.textContent).toContain("error decoding response body");
  });

  it("while it installs at quit, says Plyloft quits when it's done", async () => {
    let finish: () => void = () => {};
    const h: UpdateHandle = {
      version: "1.169.0",
      download: async () => {},
      install: () => new Promise<void>((r) => (finish = r)),
      close: async () => {},
    };
    const flow = new UpdateFlow({ check: async () => h, relaunch: async () => {}, log: { info: () => {}, error: () => {} } });
    setUpdateFlowForTests(flow);
    await flow.runCheck("launch");
    flow.installWhenIdle();
    await waitFor(() => expect(flow.canInstallAtQuit()).toBe(true));
    renderUi(<UpdatePromptView />);
    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = flow.installAtQuit();
    });
    const dialog = await screen.findByRole("dialog", { name: "Installing the update…" });
    expect(dialog.textContent).toContain("Plyloft quits when 1.169.0 is in place.");
    finish();
    expect(await done).toBe(true);
  });

  it("never holds a quit past its limit", async () => {
    const stuck = { installAtQuit: () => new Promise<boolean>(() => {}) } as unknown as UpdateFlow;
    expect(await installAtQuitWithin(stuck, 20)).toBe(false);
    const quick = { installAtQuit: async () => true } as unknown as UpdateFlow;
    expect(await installAtQuitWithin(quick, 1000)).toBe(true);
  });
});

describe("Settings › Profile › Updates says only what it knows", () => {
  const none = { downloaded: null, lastLooked: null };
  it("never claims a look that didn't answer, nor a download that isn't there", () => {
    expect(updateValue({ kind: "idle" }, none)).toBe("Not checked yet");
    expect(updateValue({ kind: "idle" }, { downloaded: null, lastLooked: { ok: false } })).toBe("Couldn't check");
    expect(updateValue({ kind: "idle" }, { downloaded: null, lastLooked: { ok: true } })).toBe("Up to date");
    expect(updateValue({ kind: "available", version: "2.0.0" }, none)).toBe("2.0.0 is available");
    expect(updateValue({ kind: "available", version: "2.0.0" }, { downloaded: "2.0.0", lastLooked: null })).toBe(
      "2.0.0 is downloaded",
    );
    expect(updateValue({ kind: "ready", version: "2.0.0" }, none)).toBe("2.0.0 is downloaded");
    expect(updateValue({ kind: "scheduled", version: "2.0.0" }, none)).toBe("2.0.0 installs when your work is done");
  });
});

