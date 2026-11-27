// GH #318: the danger zone (Diagnostics › Reset this Mac) speaks the danger
// colour, not a failure's amber — DS v2: "Red is only for destruction … A
// failure is amber, never red." 1.174.0 (A7, P32; mockups/board.html §7b):
// its surface is calm — the group's raised surface and a hairline — and the
// red lives on its destructive buttons' border and words; a danger button's
// hover is the neutral wash.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DangerZone } from "../components/ux";
import { ResetThisMac } from "../components/settings/ResetPage";
import { renderUi, screen, waitFor, within } from "./render";

const css = readFileSync("src/components/ux/ux.css", "utf8");

/** Every declaration block whose selector is exactly `selector`. */
function rules(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`\\n${esc} \\{([^}]*)\\}`, "g"))].map((m) => m[1]).join("\n");
}

describe("the danger zone", () => {
  it("is a calm surface with a hairline, never a wash or the aborted amber", () => {
    renderUi(
      <DangerZone>
        <span>Reset this Mac</span>
      </DangerZone>,
    );
    const group = screen.getByRole("group", { name: "Danger zone" });
    expect(group.className).toContain("ux-danger-zone");
    // Owner (A7 round 1): the red is an icon by the first row, drawn last so
    // the rows stay the group's first children.
    expect(group.lastElementChild?.className).toBe("ux-danger-zone-icon");
    expect(group.firstElementChild?.textContent).toBe("Reset this Mac");
    expect(rules(".ux-danger-zone-icon")).toMatch(/color: var\(--danger\)/);
    const zone = rules(".ux-danger-zone");
    expect(zone).toMatch(/border-color: var\(--border-strong\)/);
    expect(zone).not.toMatch(/danger-wash|color-mix|signal-aborted/);
  });
});

describe("Reset this Mac's confirmation", () => {
  // Owner decision 2026-09-30: a destructive confirm opens on Cancel.
  it("opens with focus on Cancel, so Enter resets nothing", async () => {
    const { user } = renderUi(<ResetThisMac />);
    await user.click(screen.getByRole("button", { name: "Reset" }));
    const sheet = screen.getByRole("dialog", { name: "Reset every setting on this Mac?" });
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Cancel" })));
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("every danger button (GH #318)", () => {
  const app = readFileSync("src/App.css", "utf8");
  /** Every declaration block whose selector list names a danger button. */
  function dangerButtonRules(text: string): string[] {
    return [...text.matchAll(/([^{}]*)\{([^}]*)\}/g)]
      .filter(([, sel]) =>
        /\.cbtn--danger|\.destructive\b|ux-danger-fill|menu-item--danger|-delete\b/.test(
          sel.replace(/\/\*[\s\S]*?\*\//g, ""),
        ),
      )
      .map(([, sel, body]) => `${sel.replace(/\/\*[\s\S]*?\*\//g, "").trim()} { ${body.trim()} }`);
  }

  it("draws --danger and the neutral hover, never a wash or the aborted amber", () => {
    const all = [...dangerButtonRules(css), ...dangerButtonRules(app)];
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const rule of all) {
      expect(rule).not.toMatch(/signal-aborted|--warn\b/);
      for (const m of rule.matchAll(/(?:^|[;{\s])(border-color|background|color):\s*([^;]+)/g)) {
        expect(`${m[1]}: ${m[2].trim()}`).toMatch(
          /: (transparent|none|var\(--(danger|on-danger|hover)\))$/,
        );
      }
    }
  });

  it("the layer's danger button: --danger border and ink, the neutral wash on hover, filled when pressed", () => {
    const layer = dangerButtonRules(css).join("\n");
    expect(layer).toMatch(/\.cbtn--danger,[^{]*\{ background: transparent;\s*border-color: var\(--danger\);\s*color: var\(--danger\);/);
    expect(layer).toMatch(/\.cbtn--danger:hover:not\(:disabled\) \{ background: var\(--hover\);/);
    expect(layer).toMatch(/\.cbtn--danger:active:not\(:disabled\) \{ background: var\(--danger\);\s*border-color: var\(--danger\);\s*color: var\(--on-danger\);/);
  });
});
