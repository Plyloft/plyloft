// Try it TI-3 (docs/try-it/TRY_IT_SPEC.md §3.2, §4.2): the localhost preview
// keeps the port it was opened on, shows one fixed address for the Try
// panel, and `openCodePreview` lands Code with the strip on a found address.
import { describe, expect, it, vi } from "vitest";
import { BrowserPane } from "../components/BrowserPane";
import { CodeModeHost } from "../components/CodeModeHost";
import { useEditor } from "../store/editorStore";
import { openCodePreview, useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, renderUi, screen, tauri, waitFor } from "./render";

vi.mock("../components/FilesPanel", () => ({ FilesPanel: () => <div /> }));

const WS = "ws-try";
const SANDBOX = "allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts";

function iframe(): HTMLIFrameElement | null {
  return document.querySelector("iframe.browser-iframe");
}

async function probed() {
  await waitFor(() => expect(tauri().callsOf("probe_localhost_ports")).toHaveLength(1));
  // Let the probe's answer land.
  await act(async () => {});
}

describe("BrowserPane's initialPort", () => {
  it("the first probe keeps it, though another server answers and it does not (yet)", async () => {
    renderUi(<BrowserPane workspaceId={WS} initialPort={41003} />, {
      fixtures: { probe_localhost_ports: [3000] },
    });
    await probed();
    expect(iframe()?.getAttribute("src")).toBe("http://localhost:41003");
    // It is listed beside what the probe found.
    const options = Array.from(document.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["localhost:41003", "localhost:3000"]);
  });

  it("without one, the first port found is shown (the control)", async () => {
    renderUi(<BrowserPane workspaceId={WS} />, { fixtures: { probe_localhost_ports: [3000] } });
    await probed();
    expect(iframe()?.getAttribute("src")).toBe("http://localhost:3000");
  });

  it("a Rescan the person asks for may move off it", async () => {
    const r = renderUi(<BrowserPane workspaceId={WS} initialPort={41003} />, {
      fixtures: { probe_localhost_ports: [3000] },
    });
    await probed();
    await r.user.click(screen.getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(iframe()?.getAttribute("src")).toBe("http://localhost:3000"));
  });

  it("an initial address off this machine is ignored", async () => {
    renderUi(<BrowserPane workspaceId={WS} initialAddress="http://192.168.1.4:3000/" />, {
      fixtures: { probe_localhost_ports: [] },
    });
    await probed();
    expect(iframe()).toBeNull();
  });

  it("an initial address keeps its path while its port is shown", async () => {
    renderUi(<BrowserPane workspaceId={WS} initialAddress="http://localhost:1313/blog/" />, {
      fixtures: { probe_localhost_ports: [1313] },
    });
    await probed();
    expect(iframe()?.getAttribute("src")).toBe("http://localhost:1313/blog/");
  });
});

describe("BrowserPane's fixed address", () => {
  it("shows only that address: no mode switch, no rescan, no list, no probe", async () => {
    const r = renderUi(<BrowserPane workspaceId={WS} address="http://localhost:41003/" reloadKey={0} />);
    await act(async () => {});
    const frame = iframe()!;
    expect(frame.getAttribute("src")).toBe("http://localhost:41003/");
    expect(frame.getAttribute("sandbox")).toBe(SANDBOX);
    expect(screen.queryByRole("group", { name: "What to preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rescan" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(tauri().callsOf("probe_localhost_ports")).toHaveLength(0);

    // Reload: a new key is a fresh iframe on the same address.
    r.rerender(<BrowserPane workspaceId={WS} address="http://localhost:41003/" reloadKey={1} />);
    expect(iframe()).not.toBe(frame);
    expect(iframe()?.getAttribute("src")).toBe("http://localhost:41003/");
  });

  it("loads nothing that is not a loopback address", async () => {
    for (const address of ["javascript:alert(1)", "http://example.com/", "http://192.168.1.4:3000/"]) {
      const r = renderUi(<BrowserPane workspaceId={WS} address={address} />);
      await act(async () => {});
      expect(iframe()).toBeNull();
      expect(screen.getByText("No address to show yet.")).toBeTruthy();
      r.unmount();
    }
    // A backslash and an @: what loads is the checked, normalised href.
    {
      const r = renderUi(<BrowserPane workspaceId={WS} address={"http://localhost:3000\\@evil.com/"} />);
      await act(async () => {});
      expect(iframe()?.getAttribute("src")).toBe("http://localhost:3000/@evil.com/");
      r.unmount();
      const r2 = renderUi(<BrowserPane workspaceId={WS} address={"http://evil.com\\@localhost:3000/"} />);
      await act(async () => {});
      expect(iframe()).toBeNull();
      r2.unmount();
    }
    // The control: loopback in 127/8 and ::1 load.
    for (const address of ["http://127.0.0.1:8000/", "http://[::1]:3000/"]) {
      const r = renderUi(<BrowserPane workspaceId={WS} address={address} />);
      await act(async () => {});
      expect(iframe()?.getAttribute("src")).toBe(address);
      r.unmount();
    }
  });
});

function seedWorkspace() {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Lyra", cwd: "/p" } as never],
    activeId: WS,
  });
}

describe("openCodePreview", () => {
  it("opens Code with the strip on the found address, and leaves the editor mounted", async () => {
    tauri().allowUnhandled();
    seedWorkspace();
    useEditor.getState().open(WS, "/p/main.rs", "fn main() {}\n", null);
    // The person had the strip on a web page before.
    useUi.getState().setBrowserMode(WS, "generic");
    renderUi(<CodeModeHost workspaceId={WS} cwd="/p" />, {
      fixtures: { probe_localhost_ports: [3000] },
    });
    await act(async () => {});
    const editor = document.querySelector(".code-mode-editor");
    expect(editor).not.toBeNull();
    expect(document.querySelector(".browser-pane")).toBeNull();

    act(() => openCodePreview(WS, "http://localhost:41003/"));

    const ui = useUi.getState();
    expect(ui.centerMode[WS]).toBe("code");
    expect(ui.gridVisible).toBe(true);
    expect(ui.codePreviewOpen[WS]).toBe(true);
    expect(ui.codePreviewTarget[WS]).toEqual({ address: "http://localhost:41003/", nonce: 1 });
    expect(ui.browserMode[WS]).toBe("localhost");
    await probed();
    expect(iframe()?.getAttribute("src")).toBe("http://localhost:41003/");
    expect(document.querySelector(".code-mode-editor")).toBe(editor);
  });

  it("asking again for the same address boots the strip on it again", async () => {
    tauri().allowUnhandled();
    seedWorkspace();
    const r = renderUi(<CodeModeHost workspaceId={WS} cwd="/p" />, {
      fixtures: { probe_localhost_ports: [3000] },
    });
    act(() => openCodePreview(WS, "http://localhost:41003/"));
    await probed();
    // The person moves the strip to another server.
    await r.user.selectOptions(screen.getByRole("combobox"), "3000");
    expect(iframe()?.getAttribute("src")).toBe("http://localhost:3000");
    act(() => openCodePreview(WS, "http://localhost:41003/"));
    expect(useUi.getState().codePreviewTarget[WS]?.nonce).toBe(2);
    await waitFor(() => expect(iframe()?.getAttribute("src")).toBe("http://localhost:41003/"));
  });

  it("refuses an address off this machine, an https one, and a workspace that is gone", () => {
    seedWorkspace();
    let answers: boolean[] = [];
    act(() => {
      answers = [
        openCodePreview(WS, "http://example.com:3000/"),
        openCodePreview("ws-deleted", "http://localhost:41003/"),
        // https: the embedded preview cannot take a self-signed certificate.
        openCodePreview(WS, "https://localhost:5173/"),
      ];
    });
    expect(answers).toEqual([false, false, false]);
    const ui = useUi.getState();
    expect(ui.codePreviewTarget).toEqual({});
    expect(ui.codePreviewOpen).toEqual({});
    expect(ui.centerMode[WS]).toBeUndefined();
    expect(ui.centerMode["ws-deleted"]).toBeUndefined();
    // The control: the same call on a live workspace and a loopback address opens it.
    let opened = false;
    act(() => {
      opened = openCodePreview(WS, "http://localhost:41003/");
    });
    expect(opened).toBe(true);
    expect(useUi.getState().centerMode[WS]).toBe("code");
  });

  it("the strip is per workspace", () => {
    seedWorkspace();
    act(() => openCodePreview(WS, "http://localhost:41003/"));
    expect(useUi.getState().codePreviewOpen["ws-other"]).toBeUndefined();
    expect(useUi.getState().codePreviewTarget["ws-other"]).toBeUndefined();
  });
});
