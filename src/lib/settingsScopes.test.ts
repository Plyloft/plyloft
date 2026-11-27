// 1.174.0 (DS1, G2 walk): every section of a Settings page says where it is
// kept — "on this Mac", "shared with the project", "on this Mac until you
// share the project", "shared with the team" or "your Plyloft account" — by
// its `scope`. A section that truly holds nothing kept anywhere says why in a
// comment right above it: `// scope: none — <why>` (or `{/* scope: none —
// <why> */}`), so a missing mark is a decision, never an oversight.
// Run with Node 22+:  node --experimental-strip-types src/lib/settingsScopes.test.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** The files whose Sections are Settings pages' sections. */
function settingsFiles(): string[] {
  const dir = join(SRC, "components/settings");
  const out = readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isFile() && p.endsWith(".tsx"));
  out.push(join(SRC, "components/RepositorySettings.tsx"));
  return out;
}

/** The end of a JSX opening tag that starts at `from` (braces and strings
 *  skipped). */
function tagEnd(text: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return text.length;
}

export function unmarked(text: string): number[] {
  const lines: number[] = [];
  for (const m of text.matchAll(/<Section\b/g)) {
    const tag = text.slice(m.index!, tagEnd(text, m.index! + m[0].length) + 1);
    if (/\bscope=/.test(tag)) continue;
    const before = text.slice(Math.max(0, m.index! - 400), m.index!).split("\n").slice(-4).join("\n");
    if (/scope: none — \S/.test(before)) continue;
    lines.push(text.slice(0, m.index!).split("\n").length);
  }
  return lines;
}

const missing: string[] = [];
for (const abs of settingsFiles()) {
  for (const line of unmarked(readFileSync(abs, "utf8"))) missing.push(`${relative(SRC, abs)}:${line}`);
}
assert.deepEqual(missing, [], "every Settings section takes a scope, or says why it has none (`// scope: none — …`)");

// The reader itself.
assert.deepEqual(unmarked(`<Section title="A" scope="this-mac">`), []);
assert.deepEqual(unmarked(`<Section\n  title="A"\n  count={n > 1 ? "x" : "y"}\n  scope="repository"\n  shared={s}\n>`), []);
assert.deepEqual(unmarked(`<Section title="A">`), [1]);
assert.deepEqual(unmarked(`{/* scope: none — a list of other things */}\n<Section title="A">`), []);
assert.deepEqual(unmarked(`// scope: none\n<Section title="A">`), [2], "the reason is required");

// 1.174.0 G3a walk: every project mark knows whether the project can be
// shared at all, so a solo project never says "until you share the
// project". Settings provides it once around every page; the mark reads it
// unless a page says otherwise (Areas, from its own reading).
{
  const layer = readFileSync(join(SRC, "components/ux/Page.tsx"), "utf8");
  assert.match(layer, /const pageShareable = useContext\(ProjectShareableContext\);/, "the mark reads the page's shareable");
  assert.match(layer, /props\.shareable \?\? pageShareable/, "a page's own answer wins");
  const overlay = readFileSync(join(SRC, "components/SettingsOverlay.tsx"), "utf8");
  assert.match(
    overlay,
    /<ProjectShareableContext\.Provider value=\{projectShareable\(status, solo\)\}>\s*<SettingsApp\b/,
    "Settings tells every page whether its project can be shared",
  );
  // No project-scope Section or ScopeMark in a Settings page hard-codes
  // whether the project can be shared: each takes Settings' answer, or the
  // page's own reading (Areas: `shareable={edit.shareable}`).
  const outside: string[] = [];
  for (const abs of settingsFiles()) {
    const text = readFileSync(abs, "utf8");
    for (const m of text.matchAll(/<(?:Section|ScopeMark)\b/g)) {
      const tag = text.slice(m.index!, tagEnd(text, m.index! + m[0].length) + 1);
      if (/scope="repository"/.test(tag) && /shareable=\{(true|false)\}/.test(tag)) outside.push(relative(SRC, abs));
    }
  }
  assert.deepEqual(outside, [], "no project mark hard-codes whether the project can be shared");
}

console.log(`settingsScopes: ${settingsFiles().length} files, every section marked — ok`);
