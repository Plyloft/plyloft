// 1.175.0 (C1, SC-2): Settings › Project › General's "Shared setup" row in
// each of its states, the Stop sharing sheet (focus on "Keep sharing"), and
// the Board's notice for a shared setup that was removed (two bordered
// buttons; nothing written to GitHub until one is pressed).
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { SharedSetupRow } from "../components/RepositorySettings";
import { useWorkMode } from "../store/workModeStore";
import type { AdoptionStatus } from "../lib/adoption";
import type { SharedSetup } from "../lib/sharedSetup";
import { act, nextFrame, renderUi, screen, waitFor, within } from "./render";
import { seedBoard, boardWorkspace, BOARD_WS } from "./boardFixtures";
import { useKanban } from "../store/kanbanStore";
import { useWorkspaces } from "../store/workspaceStore";

const NOW = Math.floor(Date.now() / 1000);

const status = (patch: Partial<AdoptionStatus>): AdoptionStatus => ({
  githubRepo: "mbadv/lyra",
  hasDefinition: true,
  boardRepo: "mbadv/lyra",
  action: { kind: "none" },
  ...patch,
});

const SHARED: SharedSetup = {
  state: "shared",
  branch: "staging",
  readOnly: false,
  author: "example-teammate",
  pending: [],
  pullRequest: null,
};

function row(sharedSetup: SharedSetup | null, offline = false, more: Record<string, (args: any) => unknown> = {}) {
  act(() => seedBoard([]));
  act(() => useWorkMode.setState({ mode: "team", chosen: true }));
  const r = renderUi(<SharedSetupRow workspaceId={BOARD_WS} offline={offline} />, {
    fixtures: { workspace_adoption_status: () => status({ sharedSetup }), ...more },
    withToasts: true,
  });
  r.tauri.allowUnhandled();
  return r;
}

describe("Settings › Project › General: the Shared setup row (C1)", () => {
  it("is not drawn for a project that never shared its setup", async () => {
    const r = row(null);
    await waitFor(() => expect(r.tauri.callsOf("workspace_adoption_status").length).toBeGreaterThan(0));
    await act(async () => {});
    expect(screen.queryByText("Shared setup")).toBeNull();
  });

  it("shared: says where it lives and offers Stop sharing…, bordered", async () => {
    row(SHARED);
    expect(
      await screen.findByText(
        "This project's setup is shared: .atelier/workspace.json on staging, in mbadv/lyra. Everyone who opens this repository gets it, and a change published from one computer reaches the others.",
      ),
    ).toBeTruthy();
    const button = screen.getByRole("button", { name: "Stop sharing…" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    // Not red on the page: the red one is the sheet's.
    expect(button.className).not.toMatch(/danger|accent/);
  });

  it("the sheet puts the focus on Keep sharing, and Keep sharing changes nothing", async () => {
    const r = row({ ...SHARED, pending: ["verifyPipeline", "integrationBranch"] });
    await r.user.click(await screen.findByRole("button", { name: "Stop sharing…" }));
    const sheet = await screen.findByRole("dialog", { name: "Stop sharing this project's setup?" });
    expect(
      within(sheet).getByText(
        "Plyloft removes .atelier/workspace.json from staging on GitHub, in one small commit. It stays in that branch's history.",
      ),
    ).toBeTruthy();
    expect(within(sheet).getByText("The Board and its cards stay where they are.")).toBeTruthy();
    expect(
      within(sheet).getByText("2 changes not published yet stay on this Mac: Checks before shipping, Cards go to."),
    ).toBeTruthy();
    expect(
      within(sheet).getByText(
        "If staging doesn't take a direct push, the removal goes as a pull request, and the setup stays shared until it merges.",
      ),
    ).toBeTruthy();
    await nextFrame();
    // WALKFIX-1: the row behind the open sheet still says Stop sharing…,
    // not Stopping… — nothing has been pressed yet.
    expect(screen.queryByText("Stopping…")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop sharing…", hidden: true })).toBeTruthy();
    const keep = within(sheet).getByRole("button", { name: "Keep sharing" });
    expect(document.activeElement).toBe(keep);
    // The confirm is the one filled, red button.
    expect(within(sheet).getByRole("button", { name: "Stop sharing" }).className).toMatch(/danger/);
    await r.user.click(keep);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(r.tauri.callsOf("workspace_stop_sharing")).toHaveLength(0);
  });

  it("Stop sharing removes it and says so", async () => {
    const r = row(SHARED, false, { workspace_stop_sharing: () => ({ kind: "stopped", branch: "staging" }) });
    await r.user.click(await screen.findByRole("button", { name: "Stop sharing…" }));
    const sheet = await screen.findByRole("dialog", { name: "Stop sharing this project's setup?" });
    await r.user.click(within(sheet).getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_stop_sharing")).toHaveLength(1));
    expect(r.tauri.callsOf("workspace_stop_sharing")[0].args).toEqual({ workspaceId: BOARD_WS });
    expect(await screen.findByText("Stopped sharing this project's setup.")).toBeTruthy();
    expect(
      screen.getByText("Removed .atelier/workspace.json from staging in one commit. This Mac keeps its values."),
    ).toBeTruthy();
  });

  it("a refused push says it waits in a pull request, with the way to open it", async () => {
    const r = row(SHARED, false, {
      workspace_stop_sharing: () => ({ kind: "pullRequest", branch: "staging", number: 231, url: "https://github.com/mbadv/lyra/pull/231" }),
      workspace_definition_open_pull_request: () => null,
    });
    await r.user.click(await screen.findByRole("button", { name: "Stop sharing…" }));
    const sheet = await screen.findByRole("dialog", { name: "Stop sharing this project's setup?" });
    await r.user.click(within(sheet).getByRole("button", { name: "Stop sharing" }));
    expect(await screen.findByText(/^Waiting for pull request #231 to merge\.?$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open pull request" })).toBeTruthy();
    expect(
      screen.getByText(
        "staging refused a direct push, so Plyloft opened a pull request that removes the shared setup. It stays shared until that merges.",
      ),
    ).toBeTruthy();
  });

  it("a failure says nothing changed, and the reason is in Details", async () => {
    const r = row(SHARED, false, {
      workspace_stop_sharing: () => {
        throw new Error("Plyloft couldn't reach GitHub (could not resolve host: github.com).");
      },
    });
    await r.user.click(await screen.findByRole("button", { name: "Stop sharing…" }));
    const sheet = await screen.findByRole("dialog", { name: "Stop sharing this project's setup?" });
    await r.user.click(within(sheet).getByRole("button", { name: "Stop sharing" }));
    expect(await screen.findByText("Couldn't stop sharing.")).toBeTruthy();
    expect(
      screen.getByText("Nothing changed on GitHub, and the setup is still shared. Details has the reason."),
    ).toBeTruthy();
  });

  it("waiting for the removal's pull request: still shared, one button that opens it", async () => {
    const r = row(
      { ...SHARED, pullRequest: { number: 231, url: "https://github.com/mbadv/lyra/pull/231" } },
      false,
      { workspace_definition_open_pull_request: () => null },
    );
    expect(
      await screen.findByText(
        "Still shared: stopping waits in pull request #231. staging refused a direct push; the setup stays shared until that pull request merges.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop sharing…" })).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "Open pull request" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_open_pull_request")).toHaveLength(1));
    expect(r.tauri.callsOf("workspace_definition_open_pull_request")[0].args).toMatchObject({ number: 231 });
  });

  it("read-only: says whom to ask, and offers no button", async () => {
    row({ ...SHARED, readOnly: true });
    expect(
      await screen.findByText(
        "This project's setup is shared: .atelier/workspace.json on staging, in mbadv/lyra. Stopping needs write access to mbadv/lyra. Ask example-teammate.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offline: the button is there and can't be pressed, and the row says why", async () => {
    row(SHARED, true);
    expect(
      await screen.findByText(
        "This project's setup is shared: .atelier/workspace.json on staging, in mbadv/lyra. Can't be stopped while offline — Plyloft needs the repository.",
      ),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "Stop sharing…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("not shared: says who stopped, and Share it again… asks first with the focus on Not now", async () => {
    const r = row(
      { state: "notShared", who: "example-teammate", at: NOW - 7200, here: false, readOnly: false },
      false,
      { workspace_adoption_share: () => ({ alreadyShared: false, board: "local", localCards: 0, boardHeld: null }) },
    );
    expect(
      await screen.findByText(/^Not shared: this project's setup is kept on this Mac\. example-teammate stopped sharing it on \d+ [A-Z][a-z]{2}\.$/),
    ).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Share it again…" }));
    const sheet = await screen.findByRole("dialog", { name: "Share this project's setup again?" });
    expect(
      within(sheet).getByText(
        "example-teammate stopped sharing it 2 h ago. Sharing again commits .atelier/workspace.json to mbadv/lyra with this Mac's name, color and project settings, for everyone who opens the repository.",
      ),
    ).toBeTruthy();
    await nextFrame();
    const notNow = within(sheet).getByRole("button", { name: "Not now" });
    expect(document.activeElement).toBe(notNow);
    await r.user.click(notNow);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(r.tauri.callsOf("workspace_adoption_share")).toHaveLength(0);
    // Pressed again and confirmed: the Share the Board's question runs.
    await r.user.click(screen.getByRole("button", { name: "Share it again…" }));
    const again = await screen.findByRole("dialog", { name: "Share this project's setup again?" });
    await r.user.click(within(again).getByRole("button", { name: "Share it again" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_adoption_share")).toHaveLength(1));
  });

  it("removed, not chosen yet: the notice's two answers, and keeping it writes nothing to GitHub", async () => {
    const r = row(
      { state: "removed", branch: "staging", who: "example-teammate", at: NOW - 7200, readOnly: false },
      false,
      { workspace_keep_setup_local: () => null },
    );
    expect(
      await screen.findByText(
        "The shared setup was removed from staging by example-teammate 2 h ago. This Mac still has the values it read last.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share it again…" })).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Keep it on this Mac" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_keep_setup_local")).toHaveLength(1));
    expect(await screen.findByText("This project's setup is this Mac's own now.")).toBeTruthy();
    expect(screen.getByText("Nothing was written to GitHub.")).toBeTruthy();
    expect(r.tauri.callsOf("workspace_adoption_share")).toHaveLength(0);
    expect(r.tauri.callsOf("workspace_definition_publish")).toHaveLength(0);
    expect(r.tauri.callsOf("workspace_stop_sharing")).toHaveLength(0);
  });
});

describe("a declined conversion of the older file (C2, SC-1)", () => {
  it("the Board says it once, with one action, and records that it was seen", async () => {
    act(() => seedBoard([]));
    act(() => useWorkMode.setState({ mode: "team", chosen: true }));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        workspace_adoption_status: () =>
          status({ action: { kind: "conversionDeclined", pullRequest: 214, who: "example-teammate" } }),
        workspace_conversion_notice_seen: () => null,
        workspace_propose_conversion_again: () => ({}),
      },
      withToasts: true,
    });
    r.tauri.allowUnhandled();
    const notice = await screen.findByRole("region", { name: "The shared setup stays in its older file" });
    expect(
      within(notice).getByText(
        "Plyloft proposed moving it to .atelier/workspace.json in pull request #214, and example-teammate closed it without merging. Plyloft won't propose it again by itself. Everything works as before on this Mac.",
      ),
    ).toBeTruthy();
    expect(within(notice).getAllByRole("button")).toHaveLength(1);
    await waitFor(() => expect(r.tauri.callsOf("workspace_conversion_notice_seen")).toHaveLength(1));
    // Nothing is proposed by itself.
    expect(r.tauri.callsOf("workspace_definition_publish")).toHaveLength(0);
    expect(r.tauri.callsOf("workspace_propose_conversion_again")).toHaveLength(0);
    await r.user.click(within(notice).getByRole("button", { name: "Propose it again" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_propose_conversion_again")).toHaveLength(1));
    expect(r.tauri.callsOf("workspace_propose_conversion_again")[0].args).toEqual({ workspaceId: BOARD_WS });
  });

  it("round 5: a notice drawn in a hidden window is not seen until the window shows", async () => {
    const visibility = (state: "hidden" | "visible") => {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    visibility("hidden");
    try {
      // Its own workspace: "seen" is recorded once per workspace a session.
      act(() => seedBoard([]));
      act(() => {
        useWorkspaces.setState({ workspaces: [{ ...boardWorkspace, id: "ws-hidden" }], activeId: "ws-hidden" });
        useKanban.setState({ byWorkspace: { "ws-hidden": { cards: [], loaded: true } } });
      });
      act(() => useWorkMode.setState({ mode: "team", chosen: true }));
      const r = renderUi(<KanbanBoard workspaceId="ws-hidden" />, {
        fixtures: {
          workspace_adoption_status: () =>
            status({ action: { kind: "conversionDeclined", pullRequest: 214, who: null } }),
          workspace_conversion_notice_seen: () => null,
        },
      });
      r.tauri.allowUnhandled();
      await screen.findByRole("region", { name: "The shared setup stays in its older file" });
      await act(async () => {});
      expect(r.tauri.callsOf("workspace_conversion_notice_seen")).toHaveLength(0);
      act(() => visibility("visible"));
      await waitFor(() => expect(r.tauri.callsOf("workspace_conversion_notice_seen")).toHaveLength(1));
      expect(r.tauri.callsOf("workspace_conversion_notice_seen")[0].args).toEqual({ workspaceId: "ws-hidden" });
    } finally {
      visibility("visible");
    }
  });

  it("round 5: an older file read on a folder whose history can't be read keeps the press in Settings", async () => {
    const r = row({ state: "olderFile", readOnly: false }, false, { workspace_propose_conversion_again: () => ({}) });
    expect(
      await screen.findByText(
        "This project's setup is in its older file. Plyloft can't read this folder's whole history, so it doesn't move it to .atelier/workspace.json by itself.",
      ),
    ).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Propose moving it" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_propose_conversion_again")).toHaveLength(1));
  });

  it("Settings keeps the same sentence and the same button", async () => {
    const r = row({ state: "declined", pullRequest: 214, who: null, readOnly: false }, false, {
      workspace_propose_conversion_again: () => ({}),
    });
    expect(
      await screen.findByText(
        "Plyloft proposed moving it to .atelier/workspace.json in pull request #214, and it was closed without merging. Plyloft won't propose it again by itself. Everything works as before on this Mac.",
      ),
    ).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Propose it again" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_propose_conversion_again")).toHaveLength(1));
    // The row alone never records the notice as seen.
    expect(r.tauri.callsOf("workspace_conversion_notice_seen")).toHaveLength(0);
  });
});

describe("round 2: a member found to have no push (C1)", () => {
  it("the read that learned it says so once, as a toast", async () => {
    act(() => seedBoard([]));
    act(() => useWorkMode.setState({ mode: "team", chosen: true }));
    const r = renderUi(<SharedSetupRow workspaceId={BOARD_WS} offline={false} />, {
      fixtures: {
        workspace_adoption_status: () =>
          status({
            hasDefinition: false,
            sharedSetup: { state: "notShared", who: "example-teammate", at: NOW - 7200, here: false, readOnly: true },
            sharingNote: { kind: "stoppedBy", who: "example-teammate" },
          }),
      },
      withToasts: true,
    });
    r.tauri.allowUnhandled();
    expect(await screen.findByText("example-teammate stopped sharing this project's setup.")).toBeTruthy();
    expect(screen.getByText("This Mac keeps the values it read last, as its own.")).toBeTruthy();
    // The row says not shared, with no button: they can't share it again.
    expect(await screen.findByText(/^Not shared: this project's setup is kept on this Mac\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share it again…" })).toBeNull();
  });
});

describe("the Board's notice for a removed shared setup (C1, SC-2)", () => {
  function board(action: AdoptionStatus["action"], more: Record<string, (args: any) => unknown> = {}) {
    act(() => seedBoard([]));
    act(() => useWorkMode.setState({ mode: "team", chosen: true }));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { workspace_adoption_status: () => status({ hasDefinition: false, action }), ...more },
      withToasts: true,
    });
    r.tauri.allowUnhandled();
    return r;
  }

  it("says who removed it and offers the two answers, both bordered; nothing runs by itself", async () => {
    const r = board({ kind: "setupRemoved", branch: "staging", who: "example-teammate", at: NOW - 7200, pending: 2 });
    const notice = await screen.findByRole("region", { name: "The shared setup was removed from staging" });
    expect(
      within(notice).getByText(
        "example-teammate removed .atelier/workspace.json 2 h ago. This Mac still has the values it read last. Plyloft changes nothing until you choose. Your 2 changes not published yet stay on this Mac.",
      ),
    ).toBeTruthy();
    const keep = within(notice).getByRole("button", { name: "Keep it on this Mac" });
    const again = within(notice).getByRole("button", { name: "Share it again…" });
    for (const button of [keep, again]) expect(button.className).not.toMatch(/accent|danger|strong/);
    await act(async () => {});
    for (const cmd of ["workspace_definition_publish", "workspace_adoption_share", "workspace_keep_setup_local", "workspace_stop_sharing"]) {
      expect(r.tauri.callsOf(cmd), cmd).toHaveLength(0);
    }
  });

  it("Keep it on this Mac records the answer and writes nothing to GitHub", async () => {
    const r = board(
      { kind: "setupRemoved", branch: "staging", who: null, at: null, pending: 0 },
      { workspace_keep_setup_local: () => null },
    );
    const notice = await screen.findByRole("region", { name: "The shared setup is no longer on staging" });
    expect(
      within(notice).getByText(
        ".atelier/workspace.json was there when this Mac last read it. This Mac still has the values it read last. Plyloft changes nothing until you choose.",
      ),
    ).toBeTruthy();
    await r.user.click(within(notice).getByRole("button", { name: "Keep it on this Mac" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_keep_setup_local")).toHaveLength(1));
    expect(r.tauri.callsOf("workspace_adoption_share")).toHaveLength(0);
    expect(r.tauri.callsOf("workspace_definition_publish")).toHaveLength(0);
    expect(await screen.findByText("This project's setup is this Mac's own now.")).toBeTruthy();
  });

  it("Share it again… asks first, and Not now shares nothing", async () => {
    const r = board({ kind: "setupRemoved", branch: "staging", who: "example-teammate", at: NOW - 7200, pending: 0 });
    const notice = await screen.findByRole("region", { name: "The shared setup was removed from staging" });
    await r.user.click(within(notice).getByRole("button", { name: "Share it again…" }));
    const sheet = await screen.findByRole("dialog", { name: "Share this project's setup again?" });
    await nextFrame();
    expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Not now" }));
    await r.user.click(within(sheet).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(r.tauri.callsOf("workspace_adoption_share")).toHaveLength(0);
  });
});
