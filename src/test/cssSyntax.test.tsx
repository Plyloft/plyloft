// A stray declaration left outside any rule (a merge in 2026-09 left three
// lines after `.editor-pane-body`) is not only a build warning: the browser
// reads it as the start of the next rule's selector and drops that rule, so
// `.agents-btn` lost its style. No stylesheet under src/ has a declaration
// outside a rule or an unmatched brace.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/** The top-level problems of one stylesheet, by line. Comments and strings
 *  are blanked first (newlines kept, so line numbers stay right). */
function topLevelProblems(css: string): string[] {
  const text = css
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (s) => s.replace(/[^\n]/g, " "));
  const problems: string[] = [];
  let depth = 0;
  let line = 1;
  let prelude = "";
  let preludeLine = 1;
  for (const ch of text) {
    if (ch === "\n") line++;
    if (depth === 0) {
      if (ch === "{" || ch === "}") {
        // `@import …;` / `@charset …;` end with `;` at the top level; any
        // other `;` there means a declaration outside a rule.
        const statements = prelude.split(";");
        statements.pop();
        if (statements.some((s) => s.trim() && !s.trim().startsWith("@"))) {
          problems.push(`line ${preludeLine}: declaration outside a rule`);
        }
        if (ch === "}") problems.push(`line ${line}: unmatched }`);
        else depth = 1;
        prelude = "";
      } else {
        if (!prelude.trim() && ch.trim()) preludeLine = line;
        prelude += ch;
      }
    } else if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (depth !== 0) problems.push(`unclosed { at the end`);
  return problems;
}

describe("stylesheets", () => {
  it("catch a declaration outside a rule", () => {
    expect(topLevelProblems(".a { x: 1; }\n\n  border: 0;\n  y: 2;\n}\n.b { z: 3; }")).toEqual([
      "line 3: declaration outside a rule",
      "line 5: unmatched }",
    ]);
    expect(topLevelProblems('@import "x.css";\n.a { b: "}" }\n@media (x) { .c { d: 1; } }')).toEqual([]);
  });

  it("under src/ have no declaration outside a rule", () => {
    const files = stylesheets(SRC);
    expect(files.length).toBeGreaterThan(0);
    const problems = files.flatMap((file) =>
      topLevelProblems(readFileSync(file, "utf8")).map((p) => `${relative(SRC, file)} ${p}`),
    );
    expect(problems).toEqual([]);
  });
});
