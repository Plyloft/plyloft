// SL-0 app tester: the JS agent's controls tree, name resolution and DOM
// input, under jsdom. The bridge's socket side is tested in Rust
// (`test_bridge.rs`), the live wiring by the pilot walk.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resetRefs } from "./tree";
import { dispatch, snapshot } from "./index";
import { parseChord } from "./input";
import { registry, type RegisteredTerm } from "./terminals";

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  resetRefs();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  registry().clear();
});

function html(markup: string) {
  host.innerHTML = markup;
}

function tree(): string {
  return snapshot({}).tree;
}

describe("the controls tree", () => {
  it("names controls the way assistive tech does and skips what is hidden", () => {
    html(`
      <section aria-label="Board">
        <h2>In progress</h2>
        <div><div><button>Ship now</button></div></div>
        <button aria-label="Close tile"><svg></svg></button>
        <button disabled>Merge</button>
        <label for="f">Card title</label><input id="f" value="Fix it" />
        <input placeholder="Search files" />
        <input type="checkbox" aria-label="Automerge" checked />
        <div style="display:none"><button>Hidden</button></div>
        <div style="visibility:hidden"><button>Inactive workspace</button></div>
        <div aria-hidden="true"><button>Decor</button></div>
        <p>No cards yet</p>
      </section>
    `);
    const text = tree();
    expect(text).toContain('- region "Board"');
    expect(text).toContain('heading "In progress"');
    expect(text).toContain('button "Ship now"');
    expect(text).toContain('button "Close tile"');
    expect(text).toMatch(/button "Merge" \[ref=e\d+\] \(disabled\)/);
    expect(text).toMatch(/textbox "Card title" \[ref=e\d+\] \(value="Fix it"\)/);
    expect(text).toContain('textbox "Search files"');
    expect(text).toMatch(/checkbox "Automerge" \[ref=e\d+\] \(checked\)/);
    expect(text).toContain("text: No cards yet");
    expect(text).not.toContain("Hidden");
    expect(text).not.toContain("Inactive workspace");
    expect(text).not.toContain("Decor");
  });

  it("keeps long text readable and caps control names", () => {
    const sentence = "Skills in repo are gitignored, so no card worktree and no teammate ever gets them. ".repeat(3);
    html(`<p>${sentence}</p><button>${"Very long label ".repeat(20)}</button>`);
    const text = tree();
    expect(text).toContain("no teammate ever gets them. Skills in repo are gitignored");
    expect(text).toMatch(/button "[^"]{110,120}…"/);
  });

  it("reads a paragraph with inline code whole", () => {
    html(`<p>These changes live only on the card's worktree branch (<code>atelier/card-1</code>) — nothing is merged.</p>`);
    expect(tree()).toContain("text: These changes live only on the card's worktree branch ( atelier/card-1 ) — nothing is merged.");
  });

  it("reads a list item's own words (1.173.0 walk)", () => {
    html(`<section aria-label="Next improvement"><ul><li>Claude reads the code and the web</li><li><span>You decide</span></li></ul><button>Not now</button></section>`);
    const text = tree();
    expect(text).toMatch(/- listitem \[ref=e\d+\]\n\s+- text: Claude reads the code and the web/);
    expect(text).toContain("text: You decide");
  });

  it("keeps a ref stable while the element lives", () => {
    html(`<button>One</button>`);
    const first = tree().match(/ref=(e\d+)/)?.[1];
    const second = tree().match(/ref=(e\d+)/)?.[1];
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("filters lines and reports open dialogs", () => {
    html(`<div role="dialog" aria-label="Discard changes?"><button>Discard</button><button>Keep</button></div>`);
    const result = snapshot({ filter: "keep" });
    expect(result.tree.trim().split("\n")).toHaveLength(1);
    expect(result.openDialogs.map((d) => d.name)).toEqual(["Discard changes?"]);
  });

  it("shows a terminal by its tile name with its last lines", () => {
    html(`<div class="tile"><span class="tile-label">shell · repo</span><div class="xterm" id="t"></div></div>`);
    const term: RegisteredTerm = {
      element: document.getElementById("t") ?? undefined,
      buffer: {
        active: {
          length: 4,
          getLine: (y: number) => ({ translateToString: () => ["$ git status", "clean", "$", ""][y] }),
        },
      },
      input: vi.fn(),
      focus: vi.fn(),
    };
    registry().add(term);
    const text = tree();
    expect(text).toMatch(/terminal "shell · repo" \[ref=e\d+\] \(3 lines\)/);
    expect(text).toContain("clean");
  });
});

describe("finding a control", () => {
  it("prefers an exact name, then case, then substring, and never guesses", async () => {
    html(`<button>Ship</button><button>Ship now</button><button>ship batch</button>`);
    const exact = (await dispatch("ui.click", { name: "Ship" })) as { clicked: { name: string } };
    expect(exact.clicked.name).toBe("Ship");
    await expect(dispatch("ui.click", { name: "ship n" })).resolves.toBeTruthy();
    await expect(dispatch("ui.click", { name: "hip" })).rejects.toThrow(/3 controls match/);
    const second = (await dispatch("ui.click", { name: "hip", index: 1 })) as { clicked: { name: string } };
    expect(second.clicked.name).toBe("Ship now");
    await expect(dispatch("ui.click", { name: "Deploy" })).rejects.toThrow(/no visible control/);
  });

  it("narrows by role and refuses a disabled control", async () => {
    html(`<a href="#">Settings</a><button disabled>Settings</button>`);
    await expect(dispatch("ui.click", { name: "Settings", role: "button" })).rejects.toThrow(/disabled/);
    const link = (await dispatch("ui.click", { name: "Settings", role: "link" })) as { clicked: { role: string } };
    expect(link.clicked.role).toBe("link");
  });

  it("says when a ref is gone", async () => {
    html(`<button>Temp</button>`);
    const ref = tree().match(/ref=(e\d+)/)?.[1];
    html(``);
    await expect(dispatch("ui.click", { ref })).rejects.toThrow(/gone/);
  });
});

describe("DOM input", () => {
  it("clicks reach React handlers and typing reaches a controlled field", async () => {
    const seen: string[] = [];
    function Form() {
      const [title, setTitle] = useState("");
      return (
        <div>
          <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button onClick={() => seen.push(`saved:${title}`)}>Save</button>
        </div>
      );
    }
    root = createRoot(host);
    act(() => root?.render(<Form />));
    await act(async () => {
      await dispatch("ui.type", { name: "Title", text: "New card" });
    });
    expect(tree()).toContain('value="New card"');
    await act(async () => {
      await dispatch("ui.click", { name: "Save" });
    });
    expect(seen).toEqual(["saved:New card"]);
  });

  it("types into a terminal through xterm's input", async () => {
    html(`<div class="tile"><span class="tile-label">zsh</span><div class="xterm" id="t"></div></div>`);
    const input = vi.fn();
    registry().add({
      element: document.getElementById("t") ?? undefined,
      buffer: { active: { length: 0, getLine: () => undefined } },
      input,
      focus: vi.fn(),
    });
    await dispatch("ui.type", { name: "zsh", role: "terminal", text: "ls", submit: true });
    expect(input.mock.calls).toEqual([["ls", true], ["\r", true]]);
  });

  it("waits for text to appear and times out with what it waited for", async () => {
    html(`<div id="slot"></div>`);
    setTimeout(() => {
      document.getElementById("slot")!.innerHTML = "<p>Pushed</p>";
    }, 50);
    await expect(dispatch("ui.wait", { text: "pushed", timeout_ms: 2000 })).resolves.toMatchObject({ met: true });
    await expect(dispatch("ui.wait", { text: "never", timeout_ms: 200 })).rejects.toThrow(/waiting for text "never"/);
  });

  it("checks once, without timers, for the caller to poll", async () => {
    html(`<p>Pushed</p><button>Ship</button>`);
    await expect(dispatch("ui.check", { text: "pushed" })).resolves.toEqual({ present: true, met: true });
    await expect(dispatch("ui.check", { name: "Deploy" })).resolves.toEqual({ present: false, met: false });
    await expect(dispatch("ui.check", { name: "Ship", gone: true })).resolves.toEqual({ present: true, met: false });
  });

  it("sends named keys to a terminal as its escape sequences", async () => {
    html(`<div class="tile"><span class="tile-label">claude</span><div class="xterm" id="t"></div></div>`);
    const input = vi.fn();
    registry().add({
      element: document.getElementById("t") ?? undefined,
      buffer: { active: { length: 0, getLine: () => undefined } },
      input,
      focus: vi.fn(),
    });
    for (const [keys, sent] of [
      ["down", "\x1b[B"],
      ["up", "\x1b[A"],
      ["enter", "\r"],
      ["escape", "\x1b"],
      ["ctrl+c", "\x03"],
      ["shift+tab", "\x1b[Z"],
    ]) {
      await dispatch("ui.key", { name: "claude", role: "terminal", keys });
      expect(input).toHaveBeenLastCalledWith(sent, true);
    }
    await expect(dispatch("ui.key", { name: "claude", role: "terminal", keys: "cmd+k" })).rejects.toThrow(/mode trusted/);
  });

  it("parses key chords", () => {
    expect(parseChord("cmd+shift+p", true)).toMatchObject({ key: "p", meta: true, shift: true, ctrl: false });
    // Windows: cmd is the app's Ctrl shortcut; meta stays the Windows key.
    expect(parseChord("cmd+shift+p", false)).toMatchObject({ key: "p", meta: false, shift: true, ctrl: true });
    expect(parseChord("meta+k", false)).toMatchObject({ meta: true, ctrl: false });
    expect(parseChord("esc")).toMatchObject({ key: "Escape" });
    expect(() => parseChord("hyper+k")).toThrow(/unknown modifier/);
  });
});
