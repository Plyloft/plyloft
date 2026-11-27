// QoL 1.168 block 4 (D6): a tile's links. Web addresses open in the browser
// (open_web_link) and the workspace's file paths in Code at their line —
// only a path the backend says is a file inside the workspace, only on
// ⌘-click (Ctrl-click on Windows).
import { describe, expect, it } from "vitest";
import { Terminal as RealXTerm, type ILink, type ILinkProvider, type Terminal as XTerm } from "@xterm/xterm";
import { forgetLinkTargetsForTests, installTerminalLinks, linkRowCacheReachable } from "../components/terminalLinkProvider";
import { setPlatformForTests } from "../lib/platform";
import { useUi } from "../store/uiStore";
import { tauri } from "./tauri";
import { waitFor } from "./render";

type FakeCell = { ch: string; getWidth(): number; getChars(): string };

function cellOf(ch = ""): FakeCell {
  return { ch, getWidth: () => 1, getChars() { return this.ch; } };
}

/** Just enough of xterm: rows of text, a link provider and the options. */
function fakeTerm(rows: string[]) {
  let provider: ILinkProvider | null = null;
  const element = document.createElement("div");
  const term = {
    element,
    options: {} as Record<string, unknown>,
    buffer: {
      active: {
        getNullCell: () => cellOf(),
        getLine: (y: number) => {
          const text = rows[y];
          if (text == null) return undefined;
          return {
            isWrapped: false,
            length: text.length,
            getCell(x: number, cell?: FakeCell) {
              if (x >= text.length) return undefined;
              const c = cell ?? cellOf();
              c.ch = text[x];
              return c;
            },
          };
        },
      },
    },
    registerLinkProvider(p: ILinkProvider) {
      provider = p;
      return { dispose: () => (provider = null) };
    },
  };
  const links = (y: number) =>
    new Promise<ILink[]>((resolve) => provider!.provideLinks(y, (l) => resolve(l ?? [])));
  return { term: term as unknown as XTerm, links, element };
}

const click = (meta: boolean, ctrl = false) => ({ metaKey: meta, ctrlKey: ctrl }) as MouseEvent;

describe("a tile's links", () => {
  it("open a web address on ⌘-click, and a workspace file at its line", async () => {
    forgetLinkTargetsForTests();
    const stub = tauri();
    stub.fixture("terminal_link_target", ({ path }: Record<string, unknown>) =>
      path === "src/app.ts" ? "/w/lyra/src/app.ts" : null,
    );
    stub.fixture("open_web_link", null);
    stub.fixture("fs_read_text_file", "const a = 1;\n");
    const { term, links } = fakeTerm(["see src/app.ts:12:3 and notes.txt at http://localhost:5173/ now"]);
    const off = installTerminalLinks(term, () => ({ workspaceId: "w1", cwd: "/w/lyra" }));
    const found = await links(1);
    expect(found.map((l) => l.text).sort()).toEqual(["http://localhost:5173/", "src/app.ts:12:3"]);
    const url = found.find((l) => l.text.startsWith("http"))!;
    expect(url.range).toEqual({ start: { x: 38, y: 1 }, end: { x: 59, y: 1 } });

    // A plain click selects: nothing opens.
    url.activate(click(false), url.text);
    expect(stub.callsOf("open_web_link")).toHaveLength(0);
    url.activate(click(true), url.text);
    expect(stub.callsOf("open_web_link").map((c) => c.args)).toEqual([{ url: "http://localhost:5173/" }]);

    const lines: unknown[] = [];
    const onGoto = (e: Event) => lines.push((e as CustomEvent).detail);
    window.addEventListener("atelier:goto-line", onGoto);
    const path = found.find((l) => l.text.startsWith("src"))!;
    path.activate(click(true), path.text);
    await waitFor(() => expect(lines).toEqual([{ workspaceId: "w1", path: "/w/lyra/src/app.ts", line: 12, col: 3 }]));
    expect(stub.callsOf("fs_read_text_file").map((c) => c.args)).toEqual([{ path: "/w/lyra/src/app.ts" }]);
    expect(useUi.getState().centerMode.w1).toBe("code");
    window.removeEventListener("atelier:goto-line", onGoto);
    // The path outside the workspace was asked about, and is no link.
    expect(stub.callsOf("terminal_link_target").map((c) => c.args.path).sort()).toEqual(["notes.txt", "src/app.ts"]);
    off.dispose();
    expect(term.options.linkHandler).toBeNull();
  });

  it("on Windows, Ctrl-click opens and ⌘ is not a key there", async () => {
    setPlatformForTests("windows");
    forgetLinkTargetsForTests();
    const stub = tauri();
    stub.fixture("terminal_link_target", null);
    stub.fixture("open_web_link", null);
    const { term, links } = fakeTerm(["C:\\app\\main.rs:3 https://github.com/me/app/pull/12"]);
    installTerminalLinks(term, () => ({ workspaceId: "w1", cwd: "C:\\app" }));
    const found = await links(1);
    expect(found.map((l) => l.text)).toEqual(["https://github.com/me/app/pull/12"]);
    found[0].activate(click(true), found[0].text);
    expect(stub.callsOf("open_web_link")).toHaveLength(0);
    found[0].activate(click(false, true), found[0].text);
    expect(stub.callsOf("open_web_link")).toHaveLength(1);
    expect(stub.callsOf("terminal_link_target").map((c) => c.args)).toEqual([
      { workspaceId: "w1", cwd: "C:\\app", path: "C:\\app\\main.rs" },
    ]);
  });

  it("OSC 8 links follow the same rules", async () => {
    forgetLinkTargetsForTests();
    const stub = tauri();
    stub.fixture("open_web_link", null);
    stub.fixture("terminal_link_target", "/w/lyra/a b.ts");
    stub.fixture("fs_read_text_file", "x\n");
    const { term } = fakeTerm([""]);
    installTerminalLinks(term, () => ({ workspaceId: "w1", cwd: "/w/lyra" }));
    const handler = term.options.linkHandler as { activate: (e: MouseEvent, url: string) => void };
    handler.activate(click(true), "javascript:alert(1)");
    handler.activate(click(true), "https://a.dev/x");
    expect(stub.callsOf("open_web_link").map((c) => c.args.url)).toEqual(["https://a.dev/x"]);
    handler.activate(click(true), "file:///w/lyra/a%20b.ts");
    await waitFor(() => expect(stub.callsOf("fs_read_text_file").map((c) => c.args)).toEqual([{ path: "/w/lyra/a b.ts" }]));
  });

  it("install on a real terminal and come off again", () => {
    const term = new RealXTerm({ allowProposedApi: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    term.open(host);
    const off = installTerminalLinks(term, () => ({ workspaceId: "w1", cwd: "/w/lyra" }));
    expect(term.options.linkHandler).toBeTruthy();
    off.dispose();
    expect(term.options.linkHandler).toBeNull();
    term.dispose();
    host.remove();
  });

  // Lane-1 Mac walk: `echo https://example.com` had no underline and ⌘-click
  // did nothing. Through xterm's own linkifier, on a real buffer.
  it("a web address in a real terminal's output is a link under the mouse, punctuation left out", async () => {
    forgetLinkTargetsForTests();
    const stub = tauri();
    stub.fixture("terminal_link_target", null);
    stub.fixture("open_web_link", null);
    const term = new RealXTerm({ allowProposedApi: true, cols: 80, rows: 10 });
    const host = document.createElement("div");
    document.body.appendChild(host);
    term.open(host);
    const off = installTerminalLinks(term, () => ({ workspaceId: "w1", cwd: "/w/lyra" }));
    const lk = (term as unknown as { _core: { linkifier: Record<string, unknown> & {
      _handleMouseMove(e: MouseEvent): void;
      _currentLink?: { link: ILink };
    } } })._core.linkifier;
    const hover = (x: number, y: number) => {
      // jsdom lays nothing out: the cell under the mouse is given.
      lk._positionFromMouseEvent = () => ({ x, y });
      lk._handleMouseMove(new MouseEvent("mousemove"));
    };
    const under = async (x: number, y: number) => {
      hover(x, y);
      await new Promise((r) => setTimeout(r, 10));
      return lk._currentLink?.link ?? null;
    };

    // The mouse rests on the first row before anything is printed there.
    hover(3, 1);
    expect(linkRowCacheReachable(term)).toBe(true);
    await new Promise<void>((r) =>
      term.write("https://example.com\r\nSee https://example.com/docs.\r\n(https://x.dev/a_(b)), then\r\n", r),
    );
    const first = await under(5, 1);
    expect(first?.text).toBe("https://example.com");
    first!.activate(click(false), first!.text);
    expect(stub.callsOf("open_web_link")).toHaveLength(0);
    first!.activate(click(true), first!.text);
    expect(stub.callsOf("open_web_link").map((c) => c.args.url)).toEqual(["https://example.com"]);

    const docs = await under(10, 2);
    expect(docs?.text).toBe("https://example.com/docs");
    expect(docs?.range).toEqual({ start: { x: 5, y: 2 }, end: { x: 28, y: 2 } });
    expect((await under(29, 2))?.text ?? null).toBeNull();
    expect((await under(4, 3))?.text).toBe("https://x.dev/a_(b)");

    off.dispose();
    term.dispose();
    host.remove();
  });
});

// TX6 round 1 (E10): a web address the browser didn't take is the one form —
// the address as the body and Copy the address — not the "web addresses
// only" refusal.
describe("a tile's web link that didn't open", () => {
  it("says the link didn't open and gives its address", async () => {
    const { useToasts } = await import("../store/toastStore");
    forgetLinkTargetsForTests();
    const stub = tauri();
    stub.fixture("open_web_link", () => {
      throw new Error("no browser");
    });
    const { term, links } = fakeTerm(["at https://a.dev/x now"]);
    const off = installTerminalLinks(term, () => ({ workspaceId: "w1", cwd: "/w/lyra" }));
    const [url] = await links(1);
    url.activate(click(true), url.text);
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    const toast = useToasts.getState().toasts[0];
    expect(toast.kind).toBe("warn");
    expect(toast.title).toBe("The link didn't open");
    expect(toast.body).toBe("https://a.dev/x");
    expect(toast.action?.label).toBe("Copy the address");
    expect(toast.details).toBe("no browser");
    off.dispose();
  });
});
