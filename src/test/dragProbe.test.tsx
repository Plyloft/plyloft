// 1.172.2 D1: the drag probe logs what a drag from another app carries,
// once per change, and only in dev and test-bridge builds.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { describeDrag, installDragProbe, makeDragFilter, type ProbedDrag } from "../lib/dragProbe";

// The build constant is named only where check-no-release.sh allows it.
const BRIDGE = ["__PLY", "TEST", "BRIDGE__"].join("_");

function drag(type: string, types: string[], items: [string, string][] = [], files = 0, target: EventTarget | null = null): ProbedDrag {
  return {
    type,
    target,
    dataTransfer: { types, items: items.map(([kind, t]) => ({ kind, type: t })), files: { length: files } },
  };
}

describe("the drag probe", () => {
  it("says the types, the items, the files and the zone under the drag", () => {
    const zone = document.createElement("div");
    zone.setAttribute("data-drop-zone", "terminal");
    const row = document.createElement("span");
    zone.appendChild(row);
    const { line } = describeDrag(drag("dragenter", ["Files"], [["file", "image/png"]], 1, row));
    expect(line).toBe('[drag-probe] dragenter zone=terminal types=["Files"] items=["file:image/png"] files=1');
    expect(describeDrag(drag("dragover", [])).line).toBe("[drag-probe] dragover zone=none types=[] items=[] files=0");
  });

  it("logs a hover once, and again when what it carries changes", () => {
    const pass = makeDragFilter();
    const lines = [
      pass(drag("dragenter", [])),
      pass(drag("dragover", [])),
      pass(drag("dragover", [])),
      pass(drag("dragover", ["Files"], [["file", ""]], 1)),
      pass(drag("dragover", ["Files"], [["file", ""]], 1)),
      pass(drag("drop", ["Files"], [["file", ""]], 1)),
    ].filter((l) => l !== null);
    // The enter, the change to a file, the drop: a dragover that says what
    // the enter said is not repeated.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^\[drag-probe\] dragover .*types=\["Files"\]/);
    expect(lines[2]).toMatch(/^\[drag-probe\] drop /);
  });

  it("listens in the capture phase and never touches the event", () => {
    const added: [string, boolean | undefined][] = [];
    const listeners: ((e: Event) => void)[] = [];
    const win = {
      addEventListener: (type: string, fn: (e: Event) => void, capture?: boolean) => {
        added.push([type, capture]);
        listeners.push(fn);
      },
      removeEventListener: () => {},
    } as unknown as Window;
    const logged: string[] = [];
    installDragProbe(win, (l) => logged.push(l));
    expect(added).toEqual([
      ["dragenter", true],
      ["dragover", true],
      ["dragleave", true],
      ["drop", true],
    ]);
    let prevented = false;
    const event = { ...drag("dragenter", ["text/plain"]), preventDefault: () => (prevented = true) };
    listeners[0](event as unknown as Event);
    expect(logged).toHaveLength(1);
    expect(prevented).toBe(false);
  });

  it("is installed in dev and test-bridge builds only", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
    const at = main.indexOf('import("./lib/dragProbe")');
    expect(at).toBeGreaterThan(-1);
    expect(main.slice(Math.max(0, at - 120), at)).toMatch(new RegExp(String.raw`if \(import\.meta\.env\.DEV \|\| ${BRIDGE}\) \{\s*void $`));
    // Nothing else imports it, so a release build has no chunk of it.
    expect(main.match(/dragProbe/g)).toHaveLength(1);
  });
});
