// GH #294: the Codex chat tile on the one scale.
//
//  1. The state is said once — by the tile header. The session's toolbar
//     carries no second "Ready" (and no green), and it is gone entirely for
//     an idle session with no allowed folders.
//  2. An approval leads with what Codex asks, in words, then Allow once (the
//     primary), Allow for this session, Always allow and Deny (quiet).
//  3. The CSS: no literal px font size under .codex-*, nothing below the
//     caption size, the placeholder muted, fields on --border-control and
//     no amber frame around the approval.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { screen, within } from "./render";
import { emitCodex, renderReadySession, startTurn } from "./codexChat";

describe("the Codex chat tile (GH #294)", () => {
  it("says Ready only in the tile header, and has no toolbar when idle", async () => {
    const r = await renderReadySession();
    expect(r.container.querySelector(".codex-session")?.getAttribute("data-state")).toBe("ready");
    expect(screen.queryByText("Ready")).toBeNull();
    expect(r.container.querySelector(".codex-session-toolbar")).toBeNull();
    expect(screen.queryByText(/Remembered scopes/)).toBeNull();
    expect(screen.getByPlaceholderText("Ask Codex…")).toBeTruthy();
  });

  it("keeps Stop in the toolbar while a turn runs, still without a state word", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    const toolbar = r.container.querySelector(".codex-session-toolbar") as HTMLElement;
    expect(within(toolbar).getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(toolbar.querySelector(".codex-session-state")).toBeNull();
  });

  it("asks for an approval in words, with one primary", async () => {
    const r = await renderReadySession();
    await startTurn(r, "turn-1");
    emitCodex({
      id: 40,
      method: "item/commandExecution/requestApproval",
      params: { command: "npm test", reason: "Run the tests", proposedExecpolicyAmendment: ["npm", "test"] },
    });
    const card = await screen.findByRole("dialog", { name: "Codex asks to run a command" });
    expect(card.querySelector(".codex-approval-dot")).toBeTruthy();
    const buttons = within(card).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Allow once",
      "Allow for this session",
      "Always allow",
      "Deny",
    ]);
    expect(buttons[0].className).toContain("cbtn--accent");
    expect(buttons.filter((b) => b.className.includes("cbtn--accent"))).toHaveLength(1);
    expect(buttons[3].className).toContain("cbtn--quiet");
    expect(r.container.textContent).not.toMatch(/Don't ask again|Remembered scope|App Server/);
  });
});

describe("the Codex chat tile's CSS (GH #294)", () => {
  const css = readFileSync("src/components/terminals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const app = readFileSync("src/App.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const codexRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes(".codex-"));

  it("lives in terminals.css, on tokens", () => {
    expect(codexRules.length).toBeGreaterThan(10);
    // Only the tile body's layout rule names it there.
    expect(app).not.toMatch(/(^|\})\s*\.codex-/);
    for (const [, sel, body] of codexRules) {
      expect(`${sel}{${body}}`).not.toMatch(/font-size:\s*\d+px/);
      expect(`${sel}{${body}}`).not.toMatch(/border-radius:\s*\d+px/);
    }
  });

  it("mutes the placeholder, edges the field for 3:1, and frames no approval in amber", () => {
    expect(css).toMatch(/\.codex-composer textarea::placeholder\s*\{[^}]*color:\s*var\(--muted\)/);
    expect(css).toMatch(/\.codex-composer textarea\s*\{[^}]*border:\s*1px solid var\(--border-control\)/);
    expect(css).toMatch(/\.codex-approval-card\s*\{[^}]*border:\s*1px solid var\(--border-strong\)/);
    expect(css).not.toMatch(/\.codex-session-state\.is-ready/);
  });
});
