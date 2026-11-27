// 1.176.3: the five buttons 1.176.2's error words wanted — Open the card,
// Open Program folders, Read it again (Release sheet, Inbox) and Try again
// (file tree). Each is drawn only when pressing it can help, shows it is
// busy, runs once however often it is pressed, and clears or repeats the
// error in place (never a second toast).
import { describe, expect, it } from "vitest";
import { FilesPanel } from "../components/FilesPanel";
import { InboxPanel } from "../components/InboxPanel";
import { ReleaseSheet } from "../components/ReleaseSheet";
import { retryCanHelp, openTheCardAction } from "../lib/errorButtons";
import { runFailure } from "../lib/aiTools";
import { useWorkspaces } from "../store/workspaceStore";
import { useUi } from "../store/uiStore";
import { useToasts } from "../store/toastStore";
import { useInbox } from "../store/inboxStore";
import { useKanban } from "../store/kanbanStore";
import { act, nextFrame, renderUi, screen, tauri, waitFor } from "./render";
import { relAudit, relScope, releaseFixtures } from "./releaseFixtures";
import type { DirEntry } from "../types";

const WS = "ws-1";
const seedWs = () =>
  act(() => useWorkspaces.setState({ workspaces: [{ id: WS, name: "lyra", cwd: "/p" }] as never, activeId: WS }));

describe("retryCanHelp", () => {
  it("is false for a folder that isn't there, true for anything that may differ next time", () => {
    expect(retryCanHelp("No such file or directory (os error 2)")).toBe(false);
    expect(retryCanHelp(new Error("ENOENT: /p"))).toBe(false);
    expect(retryCanHelp("not a git repository")).toBe(false);
    expect(retryCanHelp("Operation timed out")).toBe(true);
    expect(retryCanHelp("Permission denied (os error 13)")).toBe(true);
  });

  it("reads the backend's typed mark first, and the texts Rust really sends as a fallback", () => {
    expect(retryCanHelp("PLY_PATH_GONE_V1:{}\nworkspace cwd does not exist: /p")).toBe(false);
    expect(retryCanHelp("PLY_PATH_GONE_V1:{}\nread_dir: Impossibile trovare il percorso specificato. (os error 3)")).toBe(false);
    expect(retryCanHelp("workspace cwd does not exist: /p")).toBe(false);
    expect(retryCanHelp("workspace not found: ws")).toBe(false);
    expect(retryCanHelp("read_dir: La directory non è valida. (os error 267)")).toBe(false);
    // A translated git line without the mark can't be told: the button stays.
    expect(retryCanHelp("workspace cwd is not inside a git repo: /p (fatal: non è un repository Git)")).toBe(true);
  });
});

describe("Open the card", () => {
  it("is offered for a card that isn't open, and not for the one on screen or a gone project", () => {
    seedWs();
    expect(openTheCardAction(WS, "c1")?.label).toBe("Open the card");
    expect(openTheCardAction("gone", "c1")).toBeUndefined();
    act(() => {
      useUi.setState({ selectedCardId: { [WS]: "c1" }, centerMode: { [WS]: "board" } } as never);
    });
    expect(openTheCardAction(WS, "c1")).toBeUndefined();
    expect(openTheCardAction(WS, "c2")?.label).toBe("Open the card");
  });

  it("opens that card on its Ship step", () => {
    seedWs();
    act(() => useKanban.setState({ byWorkspace: { [WS]: { cards: [{ id: "c9", title: "x" }], loaded: true } } } as never));
    openTheCardAction(WS, "c9")!.onClick();
    expect(useUi.getState().selectedCardId[WS]).toBe("c9");
  });
});

describe("Open Program folders", () => {
  const evidence = { cause: "command-not-found" as const, causePath: "node" };
  const actions = (folders: boolean) =>
    runFailure("install.claude" as never, "failed" as never, 127, [], "claude install", evidence as never, folders)?.actions.map((a) => a.label);

  it("replaces Do it yourself only while Program folders is set and the command wasn't found", () => {
    expect(actions(true)).toEqual(["Try again", "Open Program folders"]);
    expect(actions(false)).toEqual(["Try again", "Do it yourself"]);
  });
});

const dir = (path: string): DirEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir: true,
  size: 0,
  isSymlink: false,
});

describe("Try again in the file tree", () => {
  it("lists a folder that failed again, in place, once, and clears the error", async () => {
    let calls = 0;
    let release: (v: DirEntry[]) => void = () => {};
    const r = renderUi(<FilesPanel workspaceId={WS} cwd="/p" onOpen={() => {}} />, {
      withToasts: true,
      fixtures: {
        fs_list_dir: ({ path }: Record<string, unknown>) => {
          if (path === "/p") return [dir("/p/src")];
          calls++;
          if (calls === 1) throw new Error("Operation timed out");
          return new Promise<DirEntry[]>((res) => (release = res));
        },
        files_order_get: null,
      },
    });
    await r.user.click(await screen.findByText("src"));
    const again = await screen.findByRole("button", { name: /^Try again/ });
    await r.user.click(again);
    const busy = await screen.findByRole("button", { name: "Reading…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await r.user.click(busy);
    expect(calls).toBe(2);
    await act(async () => release([]));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Try again|Reading/ })).toBeNull());
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it("draws no button for a folder that isn't there", async () => {
    const r = renderUi(<FilesPanel workspaceId={WS} cwd="/p" onOpen={() => {}} />, {
      fixtures: {
        fs_list_dir: ({ path }: Record<string, unknown>) => {
          if (path === "/p") return [dir("/p/src")];
          throw new Error("No such file or directory (os error 2)");
        },
        files_order_get: null,
      },
    });
    await r.user.click(await screen.findByText("src"));
    await waitFor(() => expect(document.querySelector(".tree-error")).not.toBeNull());
    expect(screen.queryByRole("button", { name: /^Try again/ })).toBeNull();
  });

  it("offers Try again when the project folder itself can't be listed, not when it is gone", async () => {
    renderUi(<FilesPanel workspaceId={WS} cwd="/p" onOpen={() => {}} />, {
      fixtures: { fs_list_dir: () => { throw new Error("Operation timed out"); }, files_order_get: null },
    });
    expect(await screen.findByRole("button", { name: /^Try again/ })).toBeTruthy();
  });

  it("offers nothing for a project folder that is gone", async () => {
    renderUi(<FilesPanel workspaceId={WS} cwd="/p" onOpen={() => {}} />, {
      fixtures: { fs_list_dir: () => { throw new Error("PLY_PATH_GONE_V1:{}\nread_dir: Impossibile trovare il percorso specificato. (os error 3)"); }, files_order_get: null },
    });
    await waitFor(() => expect(document.querySelector(".files-error")).not.toBeNull());
    expect(screen.queryByRole("button", { name: /^Try again/ })).toBeNull();
  });
});

describe("Read it again in the Release sheet", () => {
  it("reads again once, keeps Release unavailable until it succeeds, then reads", async () => {
    seedWs();
    let n = 0;
    let finish: (v: unknown) => void = () => {};
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: {
        ...releaseFixtures(relScope()),
        release_scope: () => {
          n++;
          if (n === 1) throw new Error("Operation timed out");
          return new Promise((res) => (finish = res));
        },
      },
    });
    const again = await screen.findByRole("button", { name: "Read it again" });
    const release = () => screen.queryAllByRole("button").find((b) => /^Release v/.test(b.textContent ?? ""));
    expect((release() as HTMLButtonElement).disabled).toBe(true);
    await r.user.click(again);
    const busy = await screen.findByRole("button", { name: "Reading…" });
    await r.user.click(busy);
    expect(n).toBe(2);
    await act(async () => finish(relScope()));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Read it again|Reading…/ })).toBeNull());
    await waitFor(() => expect((release() as HTMLButtonElement).textContent).toMatch(/^Release v3/));
    void relAudit;
  });

  it("keeps the words and draws no button when the folder is gone", async () => {
    seedWs();
    renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: {
        ...releaseFixtures(relScope()),
        release_scope: () => {
          throw new Error("PLY_PATH_GONE_V1:{}\nworkspace cwd does not exist: /p");
        },
      },
    });
    expect(await screen.findByText(/couldn't read what this release would carry\. The project's folder isn't there/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Read it again" })).toBeNull();
  });
});

describe("Read it again in the Inbox", () => {
  it("reads the Inbox again once and clears the error, with no second toast", async () => {
    seedWs();
    let n = 0;
    let finish: (v: unknown) => void = () => {};
    const feed = { generatedAt: Date.now(), windowDays: 28, events: [], costRollup: [], eligibilityProof: {} };
    const r = renderUi(<InboxPanel />, {
      withToasts: true,
      fixtures: {
        branch_cleanup_pending: [],
        inbox_feed: () => {
          n++;
          if (n === 1) throw new Error("Operation timed out");
          return new Promise((res) => (finish = res));
        },
      },
    });
    const again = await screen.findByRole("button", { name: "Read it again" });
    await r.user.click(again);
    const busy = await screen.findByRole("button", { name: "Reading…" });
    await r.user.click(busy);
    expect(n).toBe(2);
    await act(async () => finish(feed));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Read it again|Reading/ })).toBeNull());
    expect(useInbox.getState().error).toBeNull();
    expect(useToasts.getState().toasts).toEqual([]);
    void tauri;
  });
});

describe("Open Program folders on a tile that didn't start", () => {
  const render = async (cause: "gone" | "wontRun", folders: boolean) => {
    const { TileStartFailedLine } = await import("../components/TileStartFailedLine");
    const { useSettings } = await import("../store/settingsStore");
    act(() =>
      useSettings.setState((s) => ({
        settings: { ...s.settings, shell: { ...s.settings.shell, pathOverride: folders ? "/opt/bin" : null } },
      })),
    );
    return renderUi(
      <TileStartFailedLine tile={{ kind: "claude", status: "crashed", startFailed: { tool: "claude", cause } } as never} />,
    );
  };
  it("is there when Program folders is set and the tool wasn't found", async () => {
    const r = await render("gone", true);
    await r.user.click(screen.getByRole("button", { name: "Open Program folders" }));
    expect(useUi.getState().settingsSection).toBe("editor-terminals");
    expect(useUi.getState().settingsRow).toBe("Program folders");
  });
  it("is not there without the setting, or when the cause is another", async () => {
    await render("gone", false);
    expect(screen.queryByRole("button", { name: "Open Program folders" })).toBeNull();
  });
  it("is not there when the program couldn't run (not a folders cause)", async () => {
    await render("wontRun", true);
    expect(screen.queryByRole("button", { name: "Open Program folders" })).toBeNull();
  });
});

describe("a toast with one of these buttons", () => {
  it("stays until dismissed (it never expires while its action runs)", async () => {
    const { computeTtl } = await import("../store/toastStore");
    const { errorToastFor } = await import("../lib/errorToast");
    seedWs();
    const t = errorToastFor("The card wasn't shipped", "x", { action: openTheCardAction(WS, "c3") });
    expect(t.action?.label).toBe("Open the card");
    expect(computeTtl(t)).toBeNull();
  });
});


describe("Open the card on the Release sheet's refusal", () => {
  const card = { id: "r1", workspaceId: WS, title: "Blog: RSS feed", columnId: "complete", verifyStatus: "passed", shipStatus: "unshipped", worktreePath: "/tmp/w", createdAt: 1, updatedAt: 1 };
  const refusal = "ship_batch blocked: card `Blog: RSS feed` has verify_status Failed";
  const seed = (cards: object[] = [card]) => {
    seedWs();
    act(() => useKanban.setState({ byWorkspace: { [WS]: { cards, loaded: true } } } as never));
  };
  const run = async (onClose = () => {}) => {
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={onClose} />, {
      withToasts: true,
      fixtures: { ...releaseFixtures(relScope({ readyCardIds: ["r1"] })), release_area: () => Promise.reject(refusal), kanban_load: { cards: [] } },
    });
    const press = await screen.findByRole("button", { name: /^Release v3/ });
    await waitFor(() => expect((press as HTMLButtonElement).disabled).toBe(false));
    await r.user.click(press);
    return r;
  };

  it("leads to the ticked card the refusal names, closing the sheet", async () => {
    seed();
    let closed = false;
    const r = await run(() => (closed = true));
    await r.user.click(await screen.findByRole("button", { name: "Open the card" }));
    expect(closed).toBe(true);
    expect(useUi.getState().selectedCardId[WS]).toBe("r1");
  });

  it("on the toast, says so and navigates nowhere when the card has gone since", () => {
    seed();
    const action = openTheCardAction(WS, "r1")!;
    act(() => useKanban.setState({ byWorkspace: { [WS]: { cards: [], loaded: true } } } as never));
    action.onClick();
    expect(useToasts.getState().toasts[0]?.title).toBe("That card isn't on the Board any more.");
    expect(useUi.getState().selectedCardId[WS]).toBeUndefined();
  });

  it("offers no button when two ticked cards share the title", async () => {
    seed([card, { ...card, id: "r2" }]);
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: { ...releaseFixtures(relScope({ readyCardIds: ["r1", "r2"] })), release_area: () => Promise.reject(refusal) },
    });
    const press = await screen.findByRole("button", { name: /^Release v3/ });
    await waitFor(() => expect((press as HTMLButtonElement).disabled).toBe(false));
    await r.user.click(press);
    await screen.findByText(/can't go in this release/);
    expect(screen.queryByRole("button", { name: "Open the card" })).toBeNull();
  });
});

describe("the Release sheet reads both again", () => {
  it("scope and audit both failed: one press reads both and Release is enabled", async () => {
    seedWs();
    let n = 0;
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: {
        ...releaseFixtures(relScope()),
        release_scope: () => { if (++n === 1) throw new Error("Operation timed out"); return relScope(); },
        ship_audit: () => { if (n < 2) throw new Error("Operation timed out"); return relAudit(); },
      },
    });
    await r.user.click(await screen.findByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Read it again" })).toBeNull());
    await waitFor(() => expect((screen.getByRole("button", { name: /^Release v3/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(document.body.textContent).not.toContain("Close this and open it again");
  });
});

describe("the Inbox's Read it again never does nothing", () => {
  it("while a read runs from elsewhere it waits for it, then reads", async () => {
    seedWs();
    let n = 0;
    let release1: (v: unknown) => void = () => {};
    const feed = { generatedAt: Date.now(), windowDays: 28, events: [], costRollup: [], eligibilityProof: {} };
    const r = renderUi(<InboxPanel />, {
      fixtures: {
        branch_cleanup_pending: [],
        inbox_feed: () => {
          n++;
          if (n === 1) throw new Error("Operation timed out");
          if (n === 2) return new Promise((res) => (release1 = res));
          return feed;
        },
      },
    });
    const again = await screen.findByRole("button", { name: "Read it again" });
    // An event-driven read is running when the person presses.
    void useInbox.getState().refresh();
    await waitFor(() => expect(n).toBe(2));
    // Busy, not dead: the button says it is reading while that read runs.
    expect((await screen.findByRole("button", { name: "Reading…" }) as HTMLButtonElement).disabled).toBe(true);
    // And the press's own run waits for it, then reads once more.
    const again2 = useInbox.getState().readItAgain();
    await act(async () => release1(feed));
    await again2;
    expect(n).toBe(3);
    expect(useInbox.getState().error).toBeNull();
    void again; void r;
  });
});

describe("the file tree's listings never land stale", () => {
  it("a root listing still out when the folder changed never lands over the new one", async () => {
    let release: (v: DirEntry[]) => void = () => {};
    const fx = {
      fs_list_dir: ({ path }: Record<string, unknown>) =>
        path === "/old" ? new Promise<DirEntry[]>((res) => (release = res)) : [dir("/new/fresh")],
      files_order_get: null,
    };
    const r = renderUi(<FilesPanel workspaceId={WS} cwd="/old" onOpen={() => {}} />, { fixtures: fx });
    await waitFor(() => expect(tauri().callsOf("fs_list_dir").length).toBe(1));
    r.rerender(<FilesPanel workspaceId={WS} cwd="/new" onOpen={() => {}} />);
    await screen.findByText("fresh");
    await act(async () => release([dir("/old/stale")]));
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByText("fresh")).toBeTruthy();
  });

  it("a row click during Try again starts no second listing", async () => {
    let calls = 0;
    const r = renderUi(<FilesPanel workspaceId={WS} cwd="/p" onOpen={() => {}} />, {
      fixtures: {
        fs_list_dir: ({ path }: Record<string, unknown>) => {
          if (path === "/p") return [dir("/p/src")];
          calls++;
          if (calls === 1) throw new Error("Operation timed out");
          return new Promise<DirEntry[]>(() => {});
        },
        files_order_get: null,
      },
    });
    await r.user.click(await screen.findByText("src"));
    await r.user.click(await screen.findByRole("button", { name: /^Try again/ }));
    await waitFor(() => expect(calls).toBe(2));
    await r.user.click(screen.getByText("src"));
    expect(calls).toBe(2);
  });
});

describe("the palette's Claude binary toast", () => {
  const press = async (folders: boolean, times = 1) => {
    const { CommandPalette } = await import("../components/CommandPalette");
    const { useSettings } = await import("../store/settingsStore");
    const { useAgents } = await import("../store/agentStore");
    tauri().allowUnhandled();
    act(() => {
      useWorkspaces.setState({ workspaces: [{ id: "l", name: "Lyra", cwd: "/p" }] as never, activeId: "l" });
      useSettings.setState((s) => ({ settings: { ...s.settings, shell: { ...s.settings.shell, pathOverride: folders ? "/opt/bin" : null } } }));
      useAgents.setState({ byWorkspace: { l: { cwd: "/p", agents: [{ id: "a1", name: "Scout", description: "", runtimeMode: "x" }], runs: [], loading: false, error: null, selectedRunId: null } } } as never);
    });
    const r = renderUi(<CommandPalette activeWorkspaceId="l" claudeAvailable={false} onOpenInstalledSelfCheck={() => {}} />);
    for (let i = 0; i < times; i++) {
      act(() => useUi.getState().openPalette("commands"));
      await nextFrame();
      await r.user.type(screen.getByRole("textbox", { name: "Search" }), "Run agent: Scout");
      await r.user.keyboard("{Enter}");
      await waitFor(() => expect(useToasts.getState().toasts.length).toBe(1));
    }
    return r;
  };
  it("carries Open Program folders with the setting set, and opens that row", async () => {
    await press(true);
    const t = useToasts.getState().toasts[0];
    expect(t.title).toBe("Claude binary not found");
    expect(t.action?.label).toBe("Open Program folders");
    t.action!.onClick();
    expect(useUi.getState().settingsRow).toBe("Program folders");
  });
  it("carries Repair Claude Code without it", async () => {
    await press(false);
    expect(useToasts.getState().toasts[0].action?.label).toBe("Repair Claude Code");
  });
  it("said three times it is still one toast", async () => {
    await press(true, 3);
    const st = useToasts.getState();
    expect(st.toasts.length + st.queue.length).toBe(1);
  });
});
