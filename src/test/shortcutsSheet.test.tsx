import { readFileSync } from "node:fs";
// UX-3.7: ⌘/ lists every shortcut, from the one list App.tsx's handler
// matches with (src/lib/shortcuts.ts); ⌘K reaches it by name too.
import { describe, expect, it } from "vitest";
import { CommandPalette } from "../components/CommandPalette";
import { ShortcutsSheet } from "../components/ShortcutsSheet";
import { LISTED_SHORTCUTS, SHORTCUT_GROUPS } from "../lib/shortcuts";
import { setPlatformForTests } from "../lib/platform";
import { useUi } from "../store/uiStore";
import { act, nextFrame, renderUi, screen, waitFor, within } from "./render";

describe("the shortcuts sheet", () => {
  it("lists every shortcut in the list, by group", async () => {
    renderUi(<ShortcutsSheet />);
    act(() => useUi.getState().setShortcutsOpen(true));
    await nextFrame();
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    for (const group of SHORTCUT_GROUPS) {
      expect(within(sheet).getByRole("region", { name: group })).toBeTruthy();
    }
    const rows = sheet.querySelectorAll(".shell-shortcuts-row");
    expect(rows).toHaveLength(LISTED_SHORTCUTS.length);
    const drawn = [...rows].map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("kbd")?.textContent,
    ]);
    expect(drawn).toEqual(
      SHORTCUT_GROUPS.flatMap((g) => LISTED_SHORTCUTS.filter((s) => s.group === g).map((s) => [s.label, s.keys])),
    );
    expect(drawn).toContainEqual([
      "Keyboard shortcuts (outside the editor; from anywhere, Search and commands › Keyboard shortcuts)",
      "⌘/",
    ]);
    // QoL walk of block 6: the US-only chord says so, and names the menu.
    expect(drawn.some(([label]) => label?.includes("Help › Keyboard Shortcuts"))).toBe(true);
    expect(drawn.map(([label]) => label)).not.toContain("Quit Plyloft");
    expect(sheet.textContent).not.toContain("plain Ctrl letters");
    expect(sheet.textContent).not.toContain("Ctrl and a letter");
    // 1.174.0 E5 (P22): copying and pasting in a terminal are listed, Mac too.
    expect(drawn).toContainEqual(["Copy in a terminal", "⌘C"]);
    expect(drawn).toContainEqual(["Paste in a terminal", "⌘V"]);
    // The Mac has one form: ⌘ is never a terminal key.
    expect(sheet.textContent).not.toContain("in a terminal ⌘");
    // GH #322: the Library once, under its own name — not "The Library" too.
    expect(drawn.filter(([label]) => /Library/.test(label ?? ""))).toEqual([["Library", "⌘⌥6"]]);
  });

  it("spells the keys out on Windows (W5)", async () => {
    setPlatformForTests("windows");
    try {
      renderUi(<ShortcutsSheet />);
      act(() => useUi.getState().setShortcutsOpen(true));
      await nextFrame();
      const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
      const drawn = [...sheet.querySelectorAll(".shell-shortcuts-row")].map((row) => [
        row.querySelector("dt")?.textContent,
        row.querySelector("kbd")?.textContent,
      ]);
      expect(drawn).toContainEqual([
        "Keyboard shortcuts (outside the editor; from anywhere, Search and commands › Keyboard shortcuts)",
        // 1.174.0 E5: Shift was always free there; now it is said.
        "Ctrl+/ · in a terminal Ctrl+Shift+/",
      ]);
      // No Mac-only chord on Windows: there is no Help menu there.
      expect(drawn.some(([label]) => label?.includes("Help ›"))).toBe(false);
      expect(drawn).toContainEqual(["Search text in files", "Ctrl+Shift+F"]);
      expect(drawn).toContainEqual(["Library", "Ctrl+Alt+6"]);
      // W4: Windows' own quit, listed there only.
      expect(drawn).toContainEqual(["Quit Plyloft", "Ctrl+Shift+Q"]);
      expect(sheet.textContent).not.toMatch(/[⌘⌥⇧]/);
      // 1.174.0 E5 (P22, D5 b): every row a terminal changes shows both forms.
      expect(drawn).toContainEqual(["Search and commands", "Ctrl+K · in a terminal Ctrl+Shift+K"]);
      expect(drawn).toContainEqual(["Go to file", "Ctrl+P · in a terminal Ctrl+Shift+P"]);
      expect(drawn).toContainEqual([
        "New tile (a shell, or the kind Settings chooses)",
        "Ctrl+T · in a terminal Ctrl+Alt+T",
      ]);
      expect(drawn).toContainEqual([
        "Restore an expanded tile, or close the file in Code",
        "Ctrl+W · in a terminal Ctrl+Shift+M",
      ]);
      expect(drawn).toContainEqual(["Settings", "Ctrl+, · in a terminal Ctrl+Shift+,"]);
      expect(drawn).toContainEqual(["Show or hide the sidebar", "Ctrl+\\ · in a terminal Ctrl+Shift+\\"]);
      expect(drawn).toContainEqual(["New Claude session", "Ctrl+Shift+T"]);
      expect(drawn).toContainEqual(["Copy in a terminal", "Ctrl+Shift+C, or Ctrl+C on a selection"]);
      expect(drawn).toContainEqual(["Paste in a terminal", "Ctrl+Shift+V, or Ctrl+V"]);
      expect(sheet.textContent).toContain(
        "In a terminal, Ctrl and a letter go to the program in it (PowerShell, Claude, Codex). Plyloft's own keys there add Shift, or Alt for a new tile.",
      );
      expect(sheet.textContent).not.toContain("plain Ctrl letters");
    } finally {
      setPlatformForTests(null);
    }
  });

  it("offers one Library command in ⌘K (GH #322)", async () => {
    const r = renderUi(
      <CommandPalette activeWorkspaceId="w" claudeAvailable={false} onOpenInstalledSelfCheck={() => {}} />,
    );
    act(() => useUi.getState().openPalette("commands"));
    await nextFrame();
    await r.user.type(screen.getByRole("textbox", { name: "Search" }), "library");
    const labels = [...document.querySelectorAll(".palette-item-label")].map((l) => l.textContent);
    expect(labels.filter((l) => /Library/.test(l ?? "") && !/defaults/.test(l ?? ""))).toEqual([
      "Go to Library",
    ]);
  });

  it("opens from ⌘K by name and closes on Esc", async () => {
    const r = renderUi(
      <>
        <CommandPalette activeWorkspaceId={null} claudeAvailable={false} onOpenInstalledSelfCheck={() => {}} />
        <ShortcutsSheet />
      </>,
    );
    act(() => useUi.getState().openPalette("commands"));
    await nextFrame();
    await r.user.type(screen.getByRole("textbox", { name: "Search" }), "keyboard shortcuts");
    await r.user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy());
    await nextFrame();
    await r.user.keyboard("{Escape}");
    expect(useUi.getState().shortcutsOpen).toBe(false);
  });
});

// X6 (G1 Windows walk): labels kept one word per line and long chips ran out
// of the column at Windows widths; the note was monospace.
describe("the shortcuts sheet's layout (X6)", () => {
  const css = readFileSync("src/components/shell.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (sel: string) => css.match(new RegExp(`(^|\\})\\s*${sel.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`))?.[2] ?? "";

  it("gives the label at least 45% of the row and wraps a chip inside its cell", () => {
    expect(rule(".shell-shortcuts-row")).toMatch(/grid-template-columns:\s*minmax\(45%, 1fr\) minmax\(0, auto\)/);
    expect(rule(".shell-shortcuts-keys")).toMatch(/min-width:\s*0/);
    expect(rule(".shell-shortcuts-keys kbd")).toMatch(/white-space:\s*normal/);
    expect(rule(".shell-shortcuts-keys kbd")).toMatch(/overflow-wrap:\s*break-word/);
    expect(rule(".shell-shortcuts-keys")).not.toMatch(/flex:\s*none/);
  });

  it("writes the Windows note in the body font", async () => {
    setPlatformForTests("windows");
    try {
      renderUi(<ShortcutsSheet />);
      act(() => useUi.getState().setShortcutsOpen(true));
      await nextFrame();
      expect(document.querySelector(".ux-sheet-note .shell-shortcuts-note")?.textContent).toMatch(/^In a terminal, Ctrl and a letter/);
      expect(rule(".ux-sheet-note .shell-shortcuts-note")).toMatch(/font-family:\s*var\(--font-ui\)/);
    } finally {
      setPlatformForTests(null);
    }
  });
});

// 1.169.0 Mac walk: on a small window the sheet's last rows were cut off and
// Page Down did nothing. Its body scrolls, from the keyboard too.
describe("the shortcuts sheet on a small window", () => {
  it("scrolls its body with Page Down / Page Up from the sheet or its Close button", async () => {
    const { user } = renderUi(<ShortcutsSheet />);
    act(() => useUi.getState().setShortcutsOpen(true));
    await nextFrame();
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const body = sheet.querySelector(".ux-sheet-body") as HTMLElement;
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: 1200 });
    const tops: number[] = [];
    body.scrollTo = ((o: ScrollToOptions) => {
      body.scrollTop = o.top ?? 0;
      tops.push(body.scrollTop);
    }) as typeof body.scrollTo;
    within(sheet).getByRole("button", { name: "Close" }).focus();
    await user.keyboard("{PageDown}");
    expect(tops).toEqual([260]);
    await user.keyboard("{PageUp}");
    expect(tops).toEqual([260, 0]);
    sheet.focus();
    await user.keyboard("{End}");
    expect(tops[tops.length - 1]).toBe(1200);
  });
});
