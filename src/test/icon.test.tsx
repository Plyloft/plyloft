// UX-2.2: the one icon set. An icon is decorative unless labelled, sits at
// the one scale's two sizes, and lucide-react is imported in one place only.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Icon, ICONS } from "../components/ux";
import { renderUi } from "./render";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("Icon", () => {
  it("is hidden from assistive tech unless labelled", () => {
    const r = renderUi(
      <div>
        <Icon name="inbox" />
        <Icon name="close" size="sm" label="Close" />
      </div>,
    );
    const [plain, named] = Array.from(r.container.querySelectorAll("svg"));
    expect(plain.getAttribute("aria-hidden")).toBe("true");
    expect(plain.getAttribute("class")).toContain("ux-icon");
    expect(named.getAttribute("aria-label")).toBe("Close");
    expect(named.getAttribute("role")).toBe("img");
    expect(named.getAttribute("class")).toContain("ux-icon--sm");
    expect(named.getAttribute("stroke-width")).toBe("1.5");
  });

  it("gives every meaning its own icon", () => {
    const glyphs = Object.values(ICONS);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("is the only importer of lucide-react", () => {
    const importers = sources("src").filter((f) =>
      /from\s+["']lucide-react["']/.test(readFileSync(f, "utf8")),
    );
    expect(importers.map((f) => f.replace(/\\/g, "/"))).toEqual(["src/components/ux/Icon.tsx"]);
  });
});
