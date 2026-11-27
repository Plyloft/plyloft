// Command blocks' marks in a gutter (the 2026-10-20 walks, Windows PowerShell
// 5.1 and Mac zsh): the ✓/✗ mark sat at column 0 of the command's first
// output row and covered its first character ("T" of "Tue", "l" of "ls:").
// A shell tile's xterm now keeps a left gutter (its own padding, which the fit
// addon subtracts before counting columns) and the mark is drawn in it, left
// of column 0.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Terminal } from "../components/Terminal";
import { renderUi, waitFor } from "./render";

vi.mock("@xterm/xterm", () => {
  const deep = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === "dispose" ? () => {} : deep()),
      apply: () => deep(),
    });
  class FakeTerm {
    cols = 100;
    rows = 3;
    options: Record<string, unknown> = {};
    buffer = { active: { baseY: 0, length: 0, type: "normal", getLine: () => undefined } };
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          if (prop === "then") return undefined;
          return deep();
        },
      });
    }
    write(_data: string | Uint8Array, done?: () => void) {
      done?.();
    }
  }
  return { Terminal: FakeTerm };
});
// What the fit addon would propose now (null: nothing), and each fit().
const fitState = vi.hoisted(() => ({ proposed: null as { cols: number; rows: number } | null, fits: 0, webgl: 0 }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {
      fitState.fits++;
    }
    dispose() {}
    proposeDimensions() {
      return fitState.proposed ?? undefined;
    }
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() {
      fitState.webgl++;
    }
    dispose() {}
    onContextLoss() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { dispose() {} } }));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: class { dispose() {} } }));

const css = readFileSync(resolve(__dirname, "../components/terminals.css"), "utf8");
/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(m, `no rule ${selector}`).not.toBeNull();
  return m![1].replace(/\s+/g, " ");
}

describe("the shell tile's gutter", () => {
  it("is the xterm element's own left padding, not the pane's", () => {
    expect(rule(".terminal-pane.is-shell")).toContain("--command-block-gutter: var(--space-lg);");
    expect(rule(".terminal-pane.is-shell")).toContain("padding-left: 0;");
    expect(rule(".terminal-pane.is-shell .xterm")).toContain("padding-left: var(--command-block-gutter);");
  });

  // 1.169.0 (B1 Challenger): xterm 6 leaves its viewport at xterm.css's
  // #000, and the viewport spans the gutter: it is the terminal background.
  it("is the terminal background, not xterm.css's black viewport", () => {
    expect(rule(".xterm .xterm-viewport")).toContain("background-color: var(--term-bg);");
  });

  it("is where the mark draws: left of column 0, as wide as the gutter", () => {
    const marker = rule(".command-block-marker");
    // xterm sets the decoration's width inline and leaves `left` empty for
    // x 0: both are overridden, so the mark never sits on a text cell.
    expect(marker).toContain("left: calc(-1 * var(--command-block-gutter, var(--space-lg))) !important;");
    expect(marker).toContain("width: var(--command-block-gutter, var(--space-lg)) !important;");
  });

  // 1.174.0 A7 round 1: pass and fail differ by shape, not only colour.
  it("draws a filled dot when it passed and an empty ring when it failed", () => {
    expect(rule(".command-block-marker::before")).toContain("background: currentColor;");
    const fail = rule(".command-block-marker.fail::before");
    expect(fail).toContain("background: transparent;");
    expect(fail).toContain("border: 1.5px solid currentColor;");
  });

  it("is subtracted by the fit addon, so the PTY gets the text area's columns", async () => {
    const { FitAddon } = await vi.importActual<typeof import("@xterm/addon-fit")>("@xterm/addon-fit");
    const parent = document.createElement("div");
    // 808px of text area plus the 14px xterm 6 keeps for its own scrollbar
    // (the fit addon subtracts it whenever there is scrollback).
    parent.style.width = "822px";
    parent.style.height = "320px";
    const element = document.createElement("div");
    parent.appendChild(element);
    document.body.appendChild(parent);
    const term = {
      element,
      options: { scrollback: 5000 },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };
    const fit = new FitAddon();
    fit.activate(term as never);
    element.style.padding = "0";
    expect(fit.proposeDimensions()?.cols).toBe(101);
    // The 16px gutter: two columns fewer, none of them under the mark.
    element.style.paddingLeft = "16px";
    expect(fit.proposeDimensions()?.cols).toBe(99);
    parent.remove();
  });

  // 1.177.0 (walk, F5): the last row was cut at the tile's bottom edge. The
  // fit addon reads the pane's height as its border box (padding included)
  // and subtracts only the xterm element's padding: the top inset is the
  // element's, so the rows fit the pane.
  it("keeps the top inset on the xterm element, so the last row is whole", async () => {
    expect(rule(".terminal-pane")).toContain("padding: 0;");
    expect(rule(".terminal-pane .xterm")).toContain("padding: var(--space-xs) 0 0 var(--space-sm);");
    const { FitAddon } = await vi.importActual<typeof import("@xterm/addon-fit")>("@xterm/addon-fit");
    const parent = document.createElement("div");
    parent.style.width = "822px";
    parent.style.height = "322px"; // the border box, as getComputedStyle gives it
    const element = document.createElement("div");
    parent.appendChild(element);
    document.body.appendChild(parent);
    const term = {
      element,
      options: { scrollback: 5000 },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };
    const fit = new FitAddon();
    fit.activate(term as never);
    // The inset on the pane: 20 rows (320 px) in the 318 px under it.
    parent.style.paddingTop = "4px";
    element.style.padding = "0";
    expect(fit.proposeDimensions()?.rows).toBe(20);
    // The inset on the element: 19 rows, whole.
    parent.style.paddingTop = "0";
    element.style.paddingTop = "4px";
    expect(fit.proposeDimensions()?.rows).toBe(19);
    // The left inset likewise (review L2): 8 px off the columns.
    parent.style.paddingLeft = "8px";
    element.style.paddingLeft = "0";
    expect(fit.proposeDimensions()?.cols).toBe(101);
    parent.style.paddingLeft = "0";
    element.style.paddingLeft = "8px";
    expect(fit.proposeDimensions()?.cols).toBe(100);
    parent.remove();
  });

  it("is refitted once the WebGL renderer's cells replace the DOM renderer's", async () => {
    // The 2026-10-20 Mac walk: the first shell tile kept the columns fitted
    // with the DOM renderer's wider cells (120 where 125 fit) until a layout
    // change. Once WebGL is loaded, a different proposal is fitted and sent.
    fitState.proposed = { cols: 125, rows: 3 };
    fitState.webgl = 0;
    const fixtures = { pty_spawn: "pty-1", cli_fresh_check: null, pty_resize: null, pty_prompt_state: null, pty_prompt_idle: false };
    const view = renderUi(<Terminal cmd="zsh" readiness="shell" />, { fixtures });
    view.tauri.allowUnhandled();
    await waitFor(() => expect(view.tauri.callsOf("pty_spawn")).toHaveLength(1));
    const fitsBefore = fitState.fits;
    const resizesBefore = view.tauri.callsOf("pty_resize").length;
    await waitFor(() => expect(fitState.webgl).toBe(1), { timeout: 2000 });
    await waitFor(() => expect(fitState.fits).toBeGreaterThan(fitsBefore));
    expect(view.tauri.callsOf("pty_resize").length).toBeGreaterThan(resizesBefore);
    view.unmount();
    fitState.proposed = null;
  });

  it("is not refitted when the renderer swap leaves the size as it was", async () => {
    const fixtures = { pty_spawn: "pty-1", cli_fresh_check: null, pty_resize: null, pty_prompt_state: null, pty_prompt_idle: false };
    fitState.proposed = { cols: 100, rows: 3 };
    fitState.webgl = 0;
    const same = renderUi(<Terminal cmd="zsh" readiness="shell" />, { fixtures });
    same.tauri.allowUnhandled();
    await waitFor(() => expect(same.tauri.callsOf("pty_spawn")).toHaveLength(1));
    const fits = fitState.fits;
    const resizes = same.tauri.callsOf("pty_resize").length;
    await waitFor(() => expect(fitState.webgl).toBe(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(fitState.fits).toBe(fits);
    expect(same.tauri.callsOf("pty_resize")).toHaveLength(resizes);
    same.unmount();
    fitState.proposed = null;
  });

  it("is a shell tile's only (Claude and Codex tiles keep the plain pane)", async () => {
    const fixtures = { pty_spawn: "pty-1", cli_fresh_check: null, pty_resize: null, pty_prompt_state: null, pty_prompt_idle: false };
    const shell = renderUi(<Terminal cmd="zsh" workspaceId="ws" readiness="shell" />, { fixtures });
    shell.tauri.allowUnhandled();
    await waitFor(() => expect(shell.container.querySelector(".terminal-pane")).not.toBeNull());
    expect(shell.container.querySelector(".terminal-pane")?.classList.contains("is-shell")).toBe(true);
    shell.unmount();

    const claude = renderUi(<Terminal cmd="claude" cli="claude" workspaceId="ws" readiness="claude" />, { fixtures });
    claude.tauri.allowUnhandled();
    await waitFor(() => expect(claude.container.querySelector(".terminal-pane")).not.toBeNull());
    expect(claude.container.querySelector(".terminal-pane")?.classList.contains("is-shell")).toBe(false);
    claude.unmount();
  });
});
