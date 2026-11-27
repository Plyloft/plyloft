// GH #282: placeholders used the browser's own grey (#757575), 3.1–4.3:1 on
// Ply's surfaces. One base rule gives every input and textarea `--placeholder`
// (the muted text), which must clear WCAG AA (4.5:1) on every surface a field
// sits on, in all three themes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/App.css", "utf8");

/** The declarations of every top-level block whose selector is exactly
 *  `selector`, in order. */
function block(selector: string): string {
  const out: string[] = [];
  for (let at = css.indexOf(`\n${selector} {`); at >= 0; at = css.indexOf(`\n${selector} {`, at + 1)) {
    out.push(css.slice(at, css.indexOf("}", at)));
  }
  expect(out.length, `${selector} is declared in App.css`).toBeGreaterThan(0);
  return out.join("\n");
}

function token(scope: string, name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block(scope));
  expect(m, `${name} in ${scope}`).not.toBeNull();
  return m![1].trim();
}

type Rgb = [number, number, number];
function parse(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [n >> 16, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (!fn) throw new Error(`not a colour: ${value}`);
  const [r, g, b, a = "1"] = fn[1].split(",").map((s) => s.trim());
  return { rgb: [Number(r), Number(g), Number(b)], alpha: Number(a) };
}
function luminance([r, g, b]: Rgb): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
function contrast(fg: string, bg: string): number {
  const back = parse(bg).rgb;
  const { rgb, alpha } = parse(fg);
  const over = rgb.map((c, i) => c * alpha + back[i] * (1 - alpha)) as Rgb;
  const [hi, lo] = [luminance(over), luminance(back)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

describe("placeholders (GH #282)", () => {
  it("are the --placeholder colour on every input and textarea", () => {
    const rule = block(":where(input, textarea)::placeholder");
    expect(rule).toMatch(/color:\s*var\(--placeholder\)/);
    expect(rule).toMatch(/opacity:\s*1/);
    expect(css).toMatch(/--placeholder:\s*var\(--muted\)/);
  });

  it.each([
    ["light", ":root"],
    ["dark", ':root[data-theme="dark"]'],
    ["void", ':root[data-theme="void"]'],
  ])("clear 4.5:1 on every surface in %s", (_theme, scope) => {
    const muted = token(scope, "--muted");
    for (const surface of ["--bg", "--panel-bg", "--raised"]) {
      expect(contrast(muted, token(scope, surface)), surface).toBeGreaterThanOrEqual(4.5);
    }
  });
});
