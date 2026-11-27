#!/usr/bin/env node
// Tests for scripts/ux-check.mjs: each failure mode and the baseline
// ratchet, on throwaway roots (nothing here reads or writes the repository).
//
//     node scripts/ux-check.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BASELINE_FILE,
  MIGRATED_FILE,
  checkLayerCss,
  checkTsx,
  classWords,
  colourLiteralsIn,
  declarations,
  localBinding,
  countCss,
  rawErrorToasts,
  countScriptColours,
  run,
  spacingIsToken,
  undefinedTokens,
  jargonHits,
  rawErrorsInline,
  readsCopy,
  TECHNICAL_FILE,
  bareErrorToasts,
  linkToastHits,
  rustStrings,
  tsStrings,
  agentWordHits,
  isNextImprovementFile,
  JARGON,
} from "./ux-check.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "ux-check.mjs");
const temp = mkdtempSync(join(tmpdir(), "ply-ux-check-test."));
process.on("exit", () => rmSync(temp, { recursive: true, force: true }));

// ── units ──────────────────────────────────────────────────────────────

// UX-0.4: a var() naming a property nothing defines fails, fallback or not;
// a definition in CSS, a style object or setProperty counts; a name built
// in a template, a comment and a class name that merely contains `--x:` do not.
assert.deepEqual(
  undefinedTokens([
    {
      file: "src/a.css",
      text: ":root { --fg: #000; }\n.cbtn--accent:hover { color: var(--accent, #7c3aed); }\n/* var(--ghost) */\n.x { color: var(--fg); font: var(--mono); }",
    },
    {
      file: "src/b.tsx",
      text: 'el.style.setProperty("--ws-hue", h); const s = { "--chip": c }; const t = `var(--ws-${k})`; const u = "var(--ws-hue) var(--chip)";',
    },
  ]),
  [
    "src/a.css:2: var(--accent) — no such token is defined",
    "src/a.css:4: var(--mono) — no such token is defined",
  ],
);

assert.deepEqual(
  classWords('ok ? "ux-row ux-row--opens" : `ux-status--${s} cbtn`').words.map((w) => w.word),
  ["ux-row", "ux-row--opens", "ux-status--", "cbtn"],
);
// F2: classes inside a template substitution are judged…
assert.deepEqual(
  classWords("`ux-page ${active ? 'settings-field' : ''}`").words.map((w) => w.word),
  ["ux-page", "settings-field"],
);
// …a suffix hole's literals complete the word…
assert.deepEqual(
  classWords("`ux-row--${open ? 'opens' : 'flat'}`").words.map((w) => w.word),
  ["ux-row--opens", "ux-row--flat"],
);
// …a local constant is followed to its value…
const withConst = 'const cls = ["ux-row", on ? "settings-field" : ""].join(" ");';
assert.deepEqual(
  classWords("cls", (n) => localBinding(withConst, n)).words.map((w) => w.word),
  ["ux-row", "settings-field"],
);
// …and what cannot be known is not waved through.
assert.equal(classWords("props.className").unvalidated, true);
assert.equal(classWords("`${cls}`").unvalidated, true, "an unknown whole-word hole");
assert.equal(classWords("`ux-page ${extra}`").unvalidated, true);
assert.equal(classWords('active ? "ux-a" : ""').unvalidated, false, "a condition is not a class");
// Round 2: every value position is judged, even beside literal branches.
assert.equal(classWords("active ? 'ux-row' : props.className").unvalidated, true);
assert.equal(classWords("props.className || 'ux-row'").unvalidated, true);
assert.equal(classWords("extra ?? 'ux-row'").unvalidated, true, "an unbound identifier is a value here");
assert.equal(classWords("open && extra").unvalidated, true);
assert.equal(classWords("open && 'ux-row--opens'").unvalidated, false, "the condition of && is not a value");
assert.equal(classWords("helper('ux-row', flag)").unvalidated, true, "a call's result cannot be known");
assert.equal(classWords("['ux-row', on ? 'ux-row--on' : x].filter(Boolean).join(' ')").unvalidated, true);
assert.equal(classWords("['ux-row', on ? 'ux-row--on' : ''].filter(Boolean).join(' ')").unvalidated, false);
assert.equal(classWords("`ux-row ${on ? 'ux-row--on' : props.x}`").unvalidated, true);
assert.equal(classWords("row?.changed ? 'ux-a' : 'ux-b'").unvalidated, false, "?. is not a ternary");
assert.equal(classWords("a ? 'ux-a' : b ? 'ux-b' : c").unvalidated, true, "nested ternary branches");
// Round 3: a hole glued to a prefix carries its own failure — a prop there
// can give any classes ("opens settings-field").
assert.equal(classWords("`ux-row--${active ? 'opens' : props.className}`").unvalidated, true);
assert.equal(classWords("`ux-row--${kind}`").unvalidated, true, "an unbound suffix");
assert.deepEqual(
  classWords("`ux-row--${on ? 'opens' : 'flat'}`").words.map((w) => w.word),
  ["ux-row--opens", "ux-row--flat"],
);
assert.deepEqual(
  classWords("`ux-row--${on ? 'opens settings-field' : ''}`").words.map((w) => w.word),
  ["ux-row--opens", "settings-field", "ux-row--"],
  "a second word stands alone; an empty hole leaves the bare prefix",
);
assert.equal(classWords("`ux-${a ? 'x' : 'y'}-z`").unvalidated, true, "text glued after a hole");
// A lookup in a local object literal judges every value it holds.
const table = 'const T = { a: "ux-status ux-status--a", b: "settings-field" } as const;';
assert.deepEqual(
  classWords("T[state]", (n) => localBinding(table, n)).words.map((w) => w.word),
  ["ux-status", "ux-status--a", "settings-field"],
);
assert.equal(classWords("T[state]", (n) => localBinding('const T = makeTable();', n)).unvalidated, true);
assert.equal(classWords("T[state]").unvalidated, true);
const bound = 'const base = "ux-row"; const cls = on ? base : "ux-row--on";';
assert.equal(classWords("cls", (n) => localBinding(bound, n)).unvalidated, false);
assert.deepEqual(
  classWords("cls", (n) => localBinding(bound, n)).words.map((w) => w.word).sort(),
  ["ux-row", "ux-row--on"],
);

assert.ok(spacingIsToken("0"));
assert.ok(spacingIsToken("auto"));
assert.ok(spacingIsToken("var(--page-space-md) var(--page-space-lg)"));
assert.ok(spacingIsToken("calc(var(--page-inset-field) + var(--page-space-lg))"));
assert.ok(spacingIsToken("calc(-1 * var(--focus-w))"));
assert.ok(spacingIsToken("0 var(--page-space-sm)"));
assert.ok(!spacingIsToken("10px"));
assert.ok(!spacingIsToken("0 var(--page-space-sm) 3px"));
assert.ok(!spacingIsToken("calc(var(--page-space-sm) + 2px)"));
assert.ok(!spacingIsToken("1rem"));
// F5: percentages, other units and literal fallbacks are not tokens.
assert.ok(!spacingIsToken("10%"));
assert.ok(!spacingIsToken("0 10%"));
assert.ok(!spacingIsToken("1cm"));
assert.ok(!spacingIsToken("2vw"));
assert.ok(!spacingIsToken("12"), "a bare number is not a token");
assert.ok(!spacingIsToken("var(--missing, 10px)"));
assert.ok(!spacingIsToken("calc(var(--a, 4px) * 2)"));
assert.ok(spacingIsToken("var(--page-space-sm, var(--page-space-xs))"));
assert.ok(spacingIsToken("var(--page-space-sm, 0)"));

assert.deepEqual(colourLiteralsIn("1px solid #fff"), ["#fff"]);
assert.deepEqual(colourLiteralsIn("0 8px 32px rgba(0, 0, 0, 0.3)"), ["rgba("]);
assert.deepEqual(colourLiteralsIn("white"), ["white"]);
assert.deepEqual(colourLiteralsIn("var(--claude-accent)"), []);
assert.deepEqual(colourLiteralsIn("transparent"), []);

assert.equal(countScriptColours('const a = "#ef4444"; // see #110\nconst b = "Card #412";'), 1);
assert.equal(countScriptColours('x = "#000"; y = "rgb(1,2,3)"; /* #fff */'), 2);
// F3: in a styling context every hex and named colour counts; prose does not.
assert.equal(countScriptColours('<p style={{ color: "#123", background: "red" }}>Card #412</p>'), 2);
assert.equal(countScriptColours('<circle fill="#123" stroke="white" />'), 2);
assert.equal(countScriptColours('const label = "red flag"; const n = "#412";'), 0);
// Round 2: the complete named-colour set, in script and in CSS.
assert.equal(countScriptColours('<p style={{ color: "aliceblue", borderColor: "rebeccapurple" }} />'), 2);
assert.equal(countCss(".a { color: aliceblue; background: papayawhip }").colours, 2);
assert.equal(countCss(".a { color: var(--tan-bg); background: var(--snow) }").colours, 0, "token names are not colours");

// F4: a last declaration without its semicolon is still a declaration.
assert.deepEqual(
  declarations(".a { padding: 10px }\n.b{color:#fff}").map((d) => [d.prop, d.value, d.line]),
  [["padding", "10px", 1], ["color", "#fff", 2]],
);

const counted = countCss(`
:root { --x: #fff; }
.a-btn, .a-btn--sm { color: #111; }
.b-button:hover { background: rgba(0,0,0,.1); }
.agents-panel { border: 1px solid var(--border); }
.card-modal .inner { color: red; }
.no-semi { background: #222 }
.words { transition: color 1s; content: "red"; }
`);
assert.deepEqual([...counted.buttons].sort(), ["a-btn", "b-button"]);
assert.deepEqual([...counted.panels].sort(), ["agents-panel", "card-modal"]);
assert.equal(counted.colours, 4, "named colours in colour properties count; token definitions and other words do not");

// ── the strict checks ──────────────────────────────────────────────────

const catalogue = new Set(["ux-row", "ux-row--opens", "ux-status--done"]);
assert.deepEqual(checkTsx("a.tsx", '<div className="ux-row cbtn cicon--x cchip" />', catalogue), []);
// Owner-side review: logical sides and quoted kebab-case keys are spacings too.
assert.match(checkTsx("a.tsx", "<div style={{ marginInlineStart: 8 }} />", catalogue)[0], /marginInlineStart: 8 — spacing must be a token/);
assert.match(checkTsx("a.tsx", '<div style={{ paddingBlockEnd: "4px" }} />', catalogue)[0], /paddingBlockEnd/);
assert.match(checkTsx("a.tsx", '<div style={{ "margin-top": 8 }} />', catalogue)[0], /margin-top: 8/);
assert.deepEqual(checkTsx("a.tsx", '<div style={{ paddingInlineStart: "var(--page-space-sm)" }} />', catalogue), []);
const off = checkTsx("a.tsx", '\n<div className="ux-row settings-field" />', catalogue);
assert.equal(off.length, 1);
assert.match(off[0], /^a\.tsx:2: className "settings-field" is off the catalogue/);
const unknown = checkTsx("a.tsx", '<div className="ux-nope" />', catalogue);
assert.match(unknown[0], /"ux-nope" is not defined by the ux layer's CSS/);
// Round 3: an unknown suffix is not a prefix to wave through.
assert.match(checkTsx("a.tsx", "<p className={`ux-status--${s}`} />", catalogue)[0], /cannot be validated/);
assert.deepEqual(checkTsx("a.tsx", "<p className={`ux-status--${on ? 'done' : 'done'}`} />", catalogue), []);
for (const el of ["button", "input", "select"]) {
  const raw = checkTsx("a.tsx", `<${el} type="x" />`, catalogue);
  assert.equal(raw.length, 1, `raw <${el}> fails`);
  assert.match(raw[0], new RegExp(`raw <${el}>`));
}
assert.deepEqual(checkTsx("a.tsx", "<button />", catalogue, { raw: false }), [], "the layer builds on raw elements");
assert.deepEqual(checkTsx("a.tsx", '// <button className="x" />\n', catalogue), [], "comments are not code");
assert.deepEqual(checkTsx("a.tsx", "<Select options={o} />", catalogue), [], "the layer's Select is not raw");
// GH #274: the shared controls draw Lucide icons, never text glyphs.
for (const g of ["⋯", "⌕", "✕", "▾", "▸", "←"]) {
  const glyph = checkTsx("a.tsx", `<button>${g}</button>`, catalogue, { raw: false });
  assert.match(glyph[0] ?? "", /text glyph .* use <Icon/, `${g} as button content`);
  assert.match(checkLayerCss("ux.css", `.ux-a::before { content: "${g}"; }`)[0] ?? "", /a text glyph/);
}
assert.deepEqual(checkTsx("a.tsx", '<CIcon icon="more" />', catalogue, { raw: false }), []);
// GH #297: a raw error is never a toast's body; it goes in `details`.
assert.match(rawErrorToasts("a.tsx", 'pushToast({ kind: "error", title: "Save failed", body: String(e) });')[0], /a\.tsx:1: a raw error as a toast's body/);
assert.equal(rawErrorToasts("a.tsx", "pushToast({ title: 'x', body: rawError(err) });").length, 1);
assert.equal(rawErrorToasts("a.tsx", "pushToast({ title: 'x', body: `${path}\\n${String(err)}` });").length, 1);
assert.deepEqual(rawErrorToasts("a.tsx", 'pushToast({ title: "Save failed", body: path, details: String(e) });'), []);
assert.deepEqual(rawErrorToasts("a.tsx", "// body: String(e)\n"), [], "a comment is not a toast");
// GH #297 remainder: the raw text by another name is the raw text.
assert.equal(rawErrorToasts("a.ts", 'notify({ kind: "error", title: "The card wasn\'t claimed", body: errorText(e) });').length, 1);
assert.equal(rawErrorToasts("a.ts", "pushToast({ title: t, body: errMsg(err) });").length, 1);
assert.equal(rawErrorToasts("a.ts", "pushToast({ title: t, body: describeError(cause) });").length, 1);
assert.equal(rawErrorToasts("a.ts", "pushToast({ title: t, body: String((cause as Error)?.message ?? cause) });").length, 1);
assert.deepEqual(rawErrorToasts("a.ts", "pushToast({ title: t, body: 'Try again.', details: errorText(e) });"), []);
assert.deepEqual(rawErrorToasts("a.ts", "pushToast({ title: t, body: decision.message });"), [], "a worded message is not a caught error");
assert.deepEqual(rawErrorToasts("a.ts", "pushToast({ title: t, body: cardText(card) });"), [], "a helper over something else");
assert.deepEqual(checkTsx("a.tsx", "// the ⋯ of a row\n<p />", catalogue, { raw: false }), [], "a comment may name it");

assert.deepEqual(
  checkLayerCss("ux.css", ".ux-a { padding: 0 var(--page-space-sm); color: var(--fg); }"),
  [],
);
assert.match(checkLayerCss("ux.css", ".ux-a { color: #fff; }")[0], /ux\.css:1: colour literal "#fff" in color/);
assert.match(checkLayerCss("ux.css", ".ux-a {\n  background: white;\n}")[0], /ux\.css:2: colour literal "white"/);
assert.match(checkLayerCss("ux.css", ".ux-a { box-shadow: 0 0 1px rgba(0,0,0,1); }")[0], /colour literal "rgba\("/);
assert.match(checkLayerCss("ux.css", ".ux-a { gap: 10px; }")[0], /gap: 10px — spacing must be a token/);
assert.match(checkLayerCss("ux.css", ".ux-a { margin-top: 3px; }")[0], /margin-top: 3px/);
assert.match(checkLayerCss("ux.css", ".ux-a { --mine: 10px; }")[0], /declares --mine — tokens live in src\/App\.css/);
// F4/F5 in the layer's CSS: no trailing semicolon, a percentage, a fallback.
assert.match(checkLayerCss("ux.css", ".ux-a { padding: 10px }")[0], /padding: 10px — spacing must be a token/);
assert.match(checkLayerCss("ux.css", ".ux-a { color: #fff }")[0], /colour literal "#fff"/);
assert.match(checkLayerCss("ux.css", ".ux-a { padding: 10%; }")[0], /padding: 10%/);
assert.match(checkLayerCss("ux.css", ".ux-a { margin: var(--missing, 10px); }")[0], /margin: var\(--missing, 10px\)/);
// F2/F3 in a migrated file.
assert.match(
  checkTsx("a.tsx", "<div className={`ux-row--${active ? 'opens' : props.className}`} />", catalogue)[0],
  /cannot be validated/,
);
const tmplOff = checkTsx("a.tsx", "<div className={`ux-row ${on ? 'settings-field' : ''}`} />", catalogue);
assert.match(tmplOff.join("\n"), /"settings-field" is off the catalogue/);
const constOff = checkTsx("a.tsx", 'const cls = "settings-field";\n<div className={cls} />', catalogue);
assert.match(constOff.join("\n"), /a\.tsx:2: className "settings-field" is off the catalogue/);
assert.match(checkTsx("a.tsx", "<div className={props.className} />", catalogue)[0], /cannot be validated/);
assert.match(checkTsx("a.tsx", '<div className="ux-row" style={{ color: "aliceblue" }} />', catalogue)[0], /colour literal "aliceblue"/);
assert.match(checkLayerCss("ux.css", ".ux-a { color: aliceblue }")[0], /colour literal "aliceblue"/);
assert.match(checkTsx("a.tsx", "<div className={active ? 'ux-row' : props.className} />", catalogue)[0], /cannot be validated/);
const styled = checkTsx("a.tsx", '<div className="ux-row" style={{ color: "#123", background: "red" }} />', catalogue);
assert.equal(styled.length, 2, styled.join("\n"));
assert.match(checkTsx("a.tsx", '<div className="ux-row" style={{ padding: "var(--x, 4px)" }} />', catalogue)[0], /padding/);
assert.deepEqual(checkLayerCss("ux.css", "/* #fff 10px */ .ux-a { width: 38px; top: 2px; }"), [], "sizes are not spacings");

// ── end to end, and the ratchet ────────────────────────────────────────

function makeRoot(name, { migrated = ["src/components/Shell.tsx"], pending, legacy, shell, layerCss, app } = {}) {
  const root = join(temp, name);
  mkdirSync(join(root, "src/components/ux"), { recursive: true });
  mkdirSync(join(root, "docs/ux-language"), { recursive: true });
  writeFileSync(
    join(root, "src/components/ux/ux.css"),
    layerCss ?? ".ux-page { padding: var(--page-space-xl); color: var(--fg); }\n",
  );
  writeFileSync(
    join(root, "src/components/ux/Page.tsx"),
    'export const Page = () => <div className="ux-page"><button /></div>;\n',
  );
  writeFileSync(
    join(root, "src/components/Shell.tsx"),
    shell ?? 'export const Shell = () => <div className="ux-page"><CBtn className="cbtn--x" /></div>;\n',
  );
  writeFileSync(
    join(root, "src/App.css"),
    app ?? ":root { --fg: #111; --page-space-xl: 24px; }\n.old-btn { color: #222; }\n.old-panel { background: rgb(1,2,3); }\n",
  );
  writeFileSync(join(root, "src/Old.tsx"), 'const c = "#abcdef";\n');
  writeFileSync(join(root, MIGRATED_FILE), JSON.stringify({ files: migrated, pending, legacy }));
  return root;
}

// Clean root: needs a baseline first, then passes and prints the counts.
const clean = makeRoot("clean");
const missing = run(clean);
assert.equal(missing.ok, false);
assert.match(missing.output, /ux-baseline\.json is missing/);
assert.equal(run(clean, { writeBaseline: true }).ok, true);
assert.deepEqual(JSON.parse(readFileSync(join(clean, BASELINE_FILE), "utf8")), {
  buttonFamilies: 1,
  panelFamilies: 1,
  colourLiterals: 3,
  jargon: {},
  rawErrorsInline: {},
  uxAllows: {},
  bareErrorToasts: {},
  agentWords: {},
  jargonWords: JARGON.map(([w]) => w),
  legacyComponents: [],
});
const cleanRun = run(clean);
assert.equal(cleanRun.ok, true, cleanRun.output);
assert.match(
  cleanRun.output,
  /button families 1 \(baseline 1\) · panel families 1 \(baseline 1\) · colour literals 3 \(baseline 3\)/,
);

// The CLI: exit 0 on a clean root, 1 on a failing one; output printed.
const cli = spawnSync(process.execPath, [SCRIPT, "--root", clean], { encoding: "utf8" });
assert.equal(cli.status, 0, cli.stdout + cli.stderr);
assert.match(cli.stdout, /colour literals 3/);

// A migrated file off the catalogue fails; the same file unmigrated counts
// only toward the app's numbers.
const offCat = makeRoot("off-catalogue", {
  shell: 'export const S = () => <div className="ux-page settings-field" />;\n',
});
run(offCat, { writeBaseline: true });
const offRun = run(offCat);
assert.equal(offRun.ok, false);
assert.match(offRun.output, /src\/components\/Shell\.tsx:1: className "settings-field" is off the catalogue/);
const cliFail = spawnSync(process.execPath, [SCRIPT, "--root", offCat], { encoding: "utf8" });
assert.equal(cliFail.status, 1);

const rawEl = makeRoot("raw", { shell: "export const S = () => <select />;\n" });
run(rawEl, { writeBaseline: true });
assert.match(run(rawEl).output, /Shell\.tsx:1: raw <select>/);

const notMigrated = makeRoot("not-migrated", {
  migrated: [],
  legacy: ["src/components/Shell.tsx"],
  shell: 'export const S = () => <select className="settings-field" />;\n',
});
run(notMigrated, { writeBaseline: true });
assert.equal(run(notMigrated).ok, true, "an unmigrated file is only counted");

const gone = makeRoot("gone", { migrated: ["src/components/Gone.tsx"] });
run(gone, { writeBaseline: true });
assert.match(run(gone).output, /"src\/components\/Gone\.tsx" does not exist/);

// The layer's CSS: a colour literal and a non-token spacing fail.
const badCss = makeRoot("bad-css", {
  layerCss: ".ux-page {\n  padding: 10px;\n  color: #fff;\n}\n",
});
run(badCss, { writeBaseline: true });
const badRun = run(badCss);
assert.equal(badRun.ok, false);
assert.match(badRun.output, /ux\.css:2: padding: 10px/);
assert.match(badRun.output, /ux\.css:3: colour literal "#fff"/);

// The ratchet: a rise fails, a fall passes and says how to ratchet down.
const ratchet = makeRoot("ratchet");
run(ratchet, { writeBaseline: true });
writeFileSync(
  join(ratchet, "src/App.css"),
  ":root { --fg: #111; }\n.old-btn { color: #222; }\n.new-btn { color: #333; }\n.old-panel { background: rgb(1,2,3); }\n.x-sheet { color: var(--fg); }\n",
);
const rose = run(ratchet);
assert.equal(rose.ok, false);
assert.match(rose.output, /button families rose from 1 to 2/);
assert.match(rose.output, /panel families rose from 1 to 2/);
assert.match(rose.output, /colour literals rose from 3 to 4/);
writeFileSync(
  join(ratchet, "src/App.css"),
  ":root { --fg: #111; --page-space-xl: 24px; }\n.old-btn { color: var(--fg); }\n",
);
const fell = run(ratchet);
assert.equal(fell.ok, true, fell.output);
assert.match(fell.output, /a count fell — run `node scripts\/ux-check\.mjs --write-baseline`/);
run(ratchet, { writeBaseline: true });
assert.deepEqual(JSON.parse(readFileSync(join(ratchet, BASELINE_FILE), "utf8")), {
  buttonFamilies: 1,
  panelFamilies: 0,
  colourLiterals: 1,
  jargon: {},
  rawErrorsInline: {},
  uxAllows: {},
  bareErrorToasts: {},
  agentWords: {},
  jargonWords: JARGON.map(([w]) => w),
  legacyComponents: [],
});
// Migrated files and the layer are held to the strict rules, not counted.
const excluded = makeRoot("excluded", {
  shell: 'export const S = () => <div className="ux-page" style={{ color: "#123456", padding: 10, gap: "var(--page-space-sm)", margin: "0 4px" }} />;\n',
});
run(excluded, { writeBaseline: true });
assert.equal(JSON.parse(readFileSync(join(excluded, BASELINE_FILE), "utf8")).colourLiterals, 3);
const strict = run(excluded);
assert.equal(strict.ok, false);
assert.match(strict.output, /Shell\.tsx:1: colour literal "#123456"/);
assert.match(strict.output, /Shell\.tsx:1: padding: 10 — spacing must be a token/);
assert.match(strict.output, /Shell\.tsx:1: margin: "0 4px" — spacing must be a token/);
assert.doesNotMatch(strict.output, /gap:/);
assert.match(checkTsx("a.tsx", 'const c = "rgba(0,0,0,.5)";', catalogue)[0], /colour literal "rgba\("/);


// VC-6 (1.174.0): every component is registered — "files", "pending" with
// its count, or the closed "legacy" list. A new one fails and says how.
const registryOf = (root) => JSON.parse(readFileSync(join(root, MIGRATED_FILE), "utf8"));
const unreg = makeRoot("unregistered", { migrated: [] });
run(unreg, { writeBaseline: true });
const unregRun = run(unreg);
assert.equal(unregRun.ok, false);
assert.match(
  unregRun.output,
  /src\/components\/Shell\.tsx is a new component that docs\/ux-language\/migrated\.json doesn't list — it passes the migrated rules: add it to "files"/,
);
const unregBad = makeRoot("unregistered-bad", {
  migrated: [],
  shell: 'export const S = () => <div className="old-row"><button /></div>;\n',
});
run(unregBad, { writeBaseline: true });
assert.match(
  run(unregBad).output,
  /Shell\.tsx is a new component .* it has 2 problem\(s\) under the migrated rules: fix them and add it to "files", or add "src\/components\/Shell\.tsx": 2 to "pending"/,
);
assert.deepEqual(registryOf(unregBad).pending, undefined, "--write-baseline never registers a file");
// Tests and the layer are not components; a file outside src/components is not either.
writeFileSync(join(unreg, "src/components/Shell.test.tsx"), "it('x', () => {});\n");
assert.doesNotMatch(run(unreg).output, /Shell\.test\.tsx|Page\.tsx is a new|Old\.tsx is a new/);

// Pending: the count may stay or fall, never rise; a fall is noted until
// --write-baseline records it; at 0 the write moves it to "files".
const two = 'export const S = () => <div className="old-row"><button /></div>;\n';
const pend = makeRoot("pending", { migrated: [], pending: { "src/components/Shell.tsx": 2 }, shell: two });
run(pend, { writeBaseline: true });
const pendRun = run(pend);
assert.equal(pendRun.ok, true, pendRun.output);
assert.match(pendRun.output, /0 migrated file\(s\), 1 pending \(2 problem\(s\)\), 0 legacy/);
writeFileSync(join(pend, "src/components/Shell.tsx"), 'export const S = () => <div className="old-row old-col"><button /></div>;\n');
const pendRose = run(pend);
assert.equal(pendRose.ok, false);
assert.match(pendRose.output, /Shell\.tsx: 3 problem\(s\), "pending" allows 2 — a pending file's count only goes down/);
assert.match(pendRose.output, /Shell\.tsx:1: className "old-col" is off the catalogue/);
run(pend, { writeBaseline: true });
assert.deepEqual(registryOf(pend).pending, { "src/components/Shell.tsx": 2 }, "a write never raises a pending count");
writeFileSync(join(pend, "src/components/Shell.tsx"), 'export const S = () => <div className="old-row" />;\n');
const pendFell = run(pend);
assert.equal(pendFell.ok, true, pendFell.output);
assert.match(pendFell.output, /pending src\/components\/Shell\.tsx 2 → 1 — run `node scripts\/ux-check\.mjs --write-baseline` to record it/);
run(pend, { writeBaseline: true });
assert.deepEqual(registryOf(pend).pending, { "src/components/Shell.tsx": 1 });
writeFileSync(join(pend, "src/components/Shell.tsx"), 'export const S = () => <div className="ux-page" />;\n');
assert.match(run(pend).output, /Shell\.tsx passes the migrated rules now \(pending 1 → 0\)/);
run(pend, { writeBaseline: true });
assert.deepEqual(registryOf(pend), { files: ["src/components/Shell.tsx"], pending: {}, legacy: [] });
assert.equal(run(pend).ok, true);

// A file in two lists, and a listed file that is gone, fail.
const twice = makeRoot("twice", { legacy: ["src/components/Shell.tsx", "src/components/Was.tsx"], pending: { "src/components/Gone.tsx": 1 } });
run(twice, { writeBaseline: true });
const twiceRun = run(twice);
assert.match(twiceRun.output, /"src\/components\/Shell\.tsx" is in both "files" and "legacy"/);
assert.match(twiceRun.output, /legacy "src\/components\/Was\.tsx" does not exist — if it was renamed or moved, list the new path in "pending"/);
assert.match(twiceRun.output, /pending "src\/components\/Gone\.tsx" does not exist — if it was renamed or moved, change its entry to the new path/);

// B1 round 1: the same path twice in one list says so.
const dup = makeRoot("dup", { migrated: ["src/components/Shell.tsx", "src/components/Shell.tsx"] });
run(dup, { writeBaseline: true });
assert.match(run(dup).output, /"src\/components\/Shell\.tsx" is listed twice in "files" — keep one/);
assert.doesNotMatch(run(dup).output, /in both "files" and "files"/);

// B1 round 1: "legacy" is closed — the baseline keeps it (legacyComponents),
// a write only shrinks it, and an entry added by hand fails.
const closed = makeRoot("closed-legacy", { migrated: [], legacy: ["src/components/Shell.tsx"] });
run(closed, { writeBaseline: true });
const legacyBaseOf = (root) => JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8"));
assert.deepEqual(legacyBaseOf(closed).legacyComponents, ["src/components/Shell.tsx"]);
assert.equal(run(closed).ok, true, run(closed).output);
writeFileSync(join(closed, "src/components/Added.tsx"), 'export const A = () => <div className="old-row" />;\n');
writeFileSync(join(closed, MIGRATED_FILE), JSON.stringify({ files: [], legacy: ["src/components/Shell.tsx", "src/components/Added.tsx"] }));
const addedRun = run(closed);
assert.equal(addedRun.ok, false);
assert.match(addedRun.output, /"src\/components\/Added\.tsx" is in "legacy", which is closed .* or to "pending" as "src\/components\/Added\.tsx": 1/);
run(closed, { writeBaseline: true });
assert.deepEqual(legacyBaseOf(closed).legacyComponents, ["src/components/Shell.tsx"], "a write never adds to the closed list");
writeFileSync(join(closed, MIGRATED_FILE), JSON.stringify({ files: ["src/components/Shell.tsx"], pending: { "src/components/Added.tsx": 1 }, legacy: [] }));
run(closed, { writeBaseline: true });
assert.deepEqual(legacyBaseOf(closed).legacyComponents, [], "a file that leaves legacy leaves the closed list");
writeFileSync(join(closed, MIGRATED_FILE), JSON.stringify({ files: [], pending: { "src/components/Added.tsx": 1 }, legacy: ["src/components/Shell.tsx"] }));
assert.match(run(closed).output, /"src\/components\/Shell\.tsx" is in "legacy", which is closed .* it passes the migrated rules: move it to "files"/);
// A baseline written before the closed list existed asks for one write.
const oldBase = legacyBaseOf(closed);
delete oldBase.legacyComponents;
writeFileSync(join(closed, BASELINE_FILE), JSON.stringify(oldBase));
assert.match(run(closed).output, /has no legacyComponents — run with --write-baseline once/);

// B1 round 1: an unregistered component in a subfolder is named by its full path.
const sub = makeRoot("sub-unregistered");
mkdirSync(join(sub, "src/components/settings"), { recursive: true });
writeFileSync(join(sub, "src/components/settings/X.tsx"), 'export const X = () => <div className="ux-page" />;\n');
run(sub, { writeBaseline: true });
const subRun = run(sub);
assert.equal(subRun.ok, false);
assert.match(subRun.output, /src\/components\/settings\/X\.tsx is a new component that docs\/ux-language\/migrated\.json doesn't list/);

// B1 round 1: a pending file renamed — its old entry is gone and the new
// path is unregistered: both fail.
const renamed = makeRoot("pending-renamed", { migrated: [], pending: { "src/components/Shell.tsx": 2 }, shell: 'export const S = () => <div className="old-row"><button /></div>;\n' });
run(renamed, { writeBaseline: true });
renameSync(join(renamed, "src/components/Shell.tsx"), join(renamed, "src/components/Frame.tsx"));
const renamedRun = run(renamed);
assert.equal(renamedRun.ok, false);
assert.match(renamedRun.output, /pending "src\/components\/Shell\.tsx" does not exist — if it was renamed or moved, change its entry to the new path/);
assert.match(renamedRun.output, /src\/components\/Frame\.tsx is a new component .* add "src\/components\/Frame\.tsx": 2 to "pending"/);

// UX-0.4 end to end: a var() nothing defines fails the run.
const ghost = makeRoot("ghost");
run(ghost, { writeBaseline: true });
writeFileSync(join(ghost, "src/Ghost.css"), ".g { color: var(--accent, #7c3aed); }\n");
const ghostRun = run(ghost);
assert.equal(ghostRun.ok, false);
assert.match(ghostRun.output, /src\/Ghost\.css:1: var\(--accent\) — no such token is defined/);

// ── jargon and raw errors in visible copy (UX P-D1) ────────────────────

const words = (file, text, opts) => jargonHits(file, text, opts).map((h) => `${h.line}:${h.found}`);

// DR6 round 1: the Settings index's search synonyms may keep a banned old
// name ("tag and push" still finds Default release); its hint may not.
{
  const src = 'export const X = { a: { hint: "Same as Ship it, or tag and push.", synonyms: ["tag and push", "release"] } };';
  assert.deepEqual(words("src/lib/settingsIndex.ts", src), ["1:tag and push"]);
  assert.deepEqual(words("src/lib/other.ts", 'export const s = { synonyms: ["tag and push"] };'), ["1:tag and push"]);
}

// X5 (G1 walk): a doctor tool's name in a copy template is read as each
// of the doctor's names ("Codex CLI"); a fixed name is read as it is.
{
  const toolNames = ["Claude Code", "Codex CLI", "Git"];
  const src = 'import type { ToolStatus } from "../ipc";\nexport const row = (tool: ToolStatus) => ({ label: `${tool.name} as a reviewer` });';
  assert.deepEqual(words("src/lib/d.ts", src, { toolNames }), ["2:CLI (the tool's name “Codex CLI”)"]);
  assert.deepEqual(words("src/lib/d.ts", src.replace("${tool.name}", "Codex"), { toolNames }), []);
  // Not a doctor tool: a file that has no ToolStatus.
  assert.deepEqual(words("src/lib/d.ts", "export const row = (a: { name: string }) => ({ label: `${a.name} as a reviewer` });", { toolNames }), []);
}

// Read: a toast's title and body, in a .ts file under src/lib.
assert.deepEqual(
  words("src/lib/x.ts", 'pushToast({ kind: "warn", title: "Worktree gone",\n  body: "The worktree is intact." });'),
  ["1:Worktree", "2:worktree"],
);
// Read: JSX text, a copy prop, the branches of a JSX child expression.
assert.deepEqual(
  words(
    "src/A.tsx",
    'export const A = () => (\n  <p title="Snapshot it" className="worktree-x" data-x="snapshot">\n    Open the worktree\n    {busy ? "Snapshotting…" : "Build done"}\n  </p>\n);',
  ),
  ["2:Snapshot", "3:worktree", "4:Snapshotting", "4:Build done"],
);
// Read: an inline error's lines, a copy constant, a function that returns copy.
assert.deepEqual(
  words(
    "src/lib/x.ts",
    [
      "const e = { happened: `origin's main moved`, todo: \"Stash them\" };",
      'export const OPEN_LABEL = "Open the worktree";',
      'export const PLAIN = "worktree";',
      'export const STAGE_WORDS = { a: "In the diff", b: cond ? "x" : "a sandboxed run" } as const;',
      "export function shipLine(n: number): string {\n  if (n) return `Snapshot ${n}`;\n  return { id: \"snapshot-1\" };\n}",
      'function idOf() { return "snapshot"; }',
    ].join("\n"),
  ),
  ["1:origin", "1:Stash", "2:worktree", "4:diff", "4:sandboxed", "6:Snapshot"],
);
// Not read: a template's `${…}` code, an object key, an id, a different word.
assert.deepEqual(
  words(
    "src/lib/x.ts",
    'const t = { title: `Open ${worktreePath} at ${snapshot.sha}`, label: "different files", hint: "the path to it", text: `${n} snapshots` };\nconst k = { worktree: 1 };',
  ),
  ["1:snapshots"],
);
// Uppercase-only words: PATH, SHA, HEAD.
assert.deepEqual(words("src/lib/x.ts", 'const t = { hint: "Not on your PATH; its SHA and HEAD", label: "a sha in the head path" };'), [
  "1:PATH",
  "1:SHA",
  "1:HEAD",
]);
// P-D2 walk: the first column's old name, as a label, a heading or "in To
// do"; prose that begins "To do this" or says "things to do" is not it.
assert.deepEqual(
  words(
    "src/lib/x.ts",
    [
      'const s = { id: "to-do", label: "To do" };',
      "const h = { title: `To do · ${n}` };",
      'const t = { body: "“X” is in To do. Start it." };',
      'const u = { hint: "Makes a card in To do that links back" };',
      'const p = { hint: "To do this, open Settings. Two things to do. What to do next." };',
    ].join("\n"),
  ),
  ["1:To do", "2:To do", "3:in To do", "4:in To do"],
);
// Allowed: details and copyText, <Details> children, a message to the
// agent, an agent prompt, comments, a ux-allow line, a technical function.
assert.deepEqual(
  words(
    "src/B.tsx",
    [
      'pushToast({ title: "Ship stopped", details: "git stash list", copyText: `git push origin ${b}` });',
      "const B = () => <div><Details><p>origin/main at abc</p></Details><p>origin</p></div>;",
      'const m = { text: "[Plyloft] Snapshot 3 is ready" };',
      "export const BUILDER_BRIEF_PROMPT = `Work in the worktree. ${x}`;",
      'const REVIEW_BRIEF_FOR_AGENT = { title: "Review snapshot 2" };',
      "// the worktree",
      "const C = () => <p>{/* worktree */}fine</p>;",
      'const nav = { label: "Worktrees", // ux-allow: technical page name',
      '  lede: "The git worktrees." };',
      "// ux-allow: data",
      'const rel = { title: "snapshot 4" };',
      "function CardTechnicalDetails() { return <p>worktree</p>; }",
    ].join("\n"),
    { technicalFunctions: ["CardTechnicalDetails"] },
  ),
  ["2:origin", "9:worktrees"],
);

// A <Details> disclosure's own summary is read; only its children are allowed.
assert.deepEqual(words("src/D.tsx", 'const D = () => <Details summary="See the diff"><p>origin/main</p></Details>;'), ["1:diff"]);

// Raw errors inline: a state setter, an error block's line, JSX — not
// details, console, throw, or a setter of details.
assert.deepEqual(
  rawErrorsInline(
    "src/C.tsx",
    [
      "catch (e) { setError(String(e)); }",
      "catch (e) { setNote(`Couldn't save: ${e}`); }",
      "const b = { hint: String(err), details: String(e) };",
      "const C = () => <p>{String(e)}</p>;",
      "console.error(String(e)); throw new Error(`x ${e}`); setErrorDetails(String(e));",
      "setImageError(`Couldn't: ${e instanceof Error ? e.message : String(e)}`);",
    ].join("\n"),
  ).map((h) => h.line),
  [1, 2, 3, 4, 6],
);

// (Challenger) Read: notify(kind, title, body, details)'s title and body (not
// its details), a machineWords(…) argument, a footnote and a …Label prop or
// key, an unexported FOOTNOTE, an UPPER_SNAKE constant that is a sentence.
// Not read: an UPPER_SNAKE id, a …_MARKER matched against. Not allowed: a
// ux-allow outside a comment, or one with no reason.
assert.deepEqual(
  words(
    "src/lib/x.tsx",
    [
      'deps.notify("warn", "Build done stopped", `Resume the worktree ${n}`, "git stash list");',
      'const t = { title: machineWords("Not on this Mac\'s PATH."), cancelLabel: "Keep the snapshot" };',
      'const F = () => <Field footnote="Any model your CLI accepts" menuLabel="diff" />;',
      'const FOOTNOTE = "Or type the name of any model your CLI accepts.";',
      'export const PUSH_WAITS = "Close the session (press Build done first), then push.";',
      'const SECTION = "diff"; const BRANCH_MISSING_MARKER = "isn\'t on origin";',
      'const u = { label: "a worktree ux-allow: data" };',
      'const w = { label: "the worktree" }; // ux-allow:',
    ].join("\n"),
  ),
  [
    "1:Build done", "1:worktree", "2:PATH", "2:snapshot", "3:CLI", "3:diff", "4:CLI", "5:Build done",
    "7:worktree", "8:worktree",
  ],
);

// (Challenger) Raw errors: a transcript line `append("error", String(error))`
// and a notify body; `${reason}` only in a file that catches a `reason`.
assert.deepEqual(
  rawErrorsInline(
    "src/C.tsx",
    [
      '.catch((error) => append("error", String(error)));',
      'deps.notify("warn", "Self-check not sent", `${String(e)} It goes on.`);',
      "const reason = record.reason; const r = { text: `${reason} Nothing started.` };",
    ].join("\n"),
  ).map((h) => h.line),
  [1, 2],
);
assert.deepEqual(
  rawErrorsInline("src/D.tsx", "p.catch((reason) => { const r = { text: `${reason} Nothing started.` }; });").map((h) => h.line),
  [1],
);

// The file set: .ts and .tsx under src/, not tests, fixtures, the test
// bridge or the IPC types.
assert.equal(readsCopy("src/lib/words.ts"), true);
assert.equal(readsCopy("src/components/A.tsx"), true);
for (const f of ["src/lib/words.test.ts", "src/lib/a.fixtures.ts", "src/testBridge/tree.ts", "src/test/render.tsx", "src/ipc.ts", "src/vite-env.d.ts"]) {
  assert.equal(readsCopy(f), false, f);
}

// End to end: the per-file ratchet, moves, and --write-baseline never raising.
const copyRoot = makeRoot("copy");
mkdirSync(join(copyRoot, "src/lib"), { recursive: true });
mkdirSync(join(copyRoot, "src/testBridge"), { recursive: true });
const wordsTs = join(copyRoot, "src/lib/words.ts");
const otherTs = join(copyRoot, "src/lib/other.ts");
writeFileSync(wordsTs, 'export const A = { title: "Open the worktree" };\n');
writeFileSync(join(copyRoot, "src/lib/words.test.ts"), 'const t = { title: "worktree" };\n');
writeFileSync(join(copyRoot, "src/testBridge/x.ts"), 'const t = { title: "worktree" };\n');
writeFileSync(join(copyRoot, "src/Shown.tsx"), "export const S = () => <p>ok</p>;\n");
assert.equal(run(copyRoot, { writeBaseline: true }).ok, true);
const baselineOf = () => JSON.parse(readFileSync(join(copyRoot, BASELINE_FILE), "utf8"));
assert.deepEqual(baselineOf().jargon, { "src/lib/words.ts": 1 });
assert.deepEqual(baselineOf().rawErrorsInline, {});
assert.match(run(copyRoot).output, /jargon 1 in 1 file\(s\) \(baseline 1\)/);
assert.match(run(copyRoot).output, /jargon by word — worktree 1 · snapshot 0/);

// A rise fails and names every hit of the file that rose…
writeFileSync(wordsTs, 'export const A = { title: "Open the worktree" };\nexport const B = { hint: "Snapshot it" };\n');
const jRose = run(copyRoot);
assert.equal(jRose.ok, false);
assert.match(jRose.output, /jargon rose from 1 to 2/);
assert.match(jRose.output, /src\/lib\/words\.ts:2: "Snapshot"/);
// …and --write-baseline refuses to record it.
const refusedWrite = run(copyRoot, { writeBaseline: true });
assert.equal(refusedWrite.ok, false);
assert.match(refusedWrite.output, /--write-baseline refused: a count would rise — jargon 1 → 2 \(src\/lib\/words\.ts\)/);
assert.deepEqual(baselineOf().jargon, { "src/lib/words.ts": 1 });
const cliRefused = spawnSync(process.execPath, [SCRIPT, "--root", copyRoot, "--write-baseline"], { encoding: "utf8" });
assert.equal(cliRefused.status, 1);

// A move between files with the total unchanged is named and recorded by
// --write-baseline; (Challenger) until then the run asks for the write.
writeFileSync(wordsTs, "export const A = 1;\n");
writeFileSync(otherTs, 'export const B = { hint: "Snapshot it" };\n');
const moved = run(copyRoot);
assert.equal(moved.ok, false, moved.output);
assert.match(moved.output, /jargon: src\/lib\/other\.ts 0 → 1 \(moved from src\/lib\/words\.ts\)/);
assert.match(moved.output, /jargon 1 → 1 is not recorded in docs\/ux-language\/ux-baseline\.json — run `node scripts\/ux-check\.mjs --write-baseline`/);
assert.equal(run(copyRoot, { writeBaseline: true }).ok, true);
assert.deepEqual(baselineOf().jargon, { "src/lib/other.ts": 1 });
assert.equal(run(copyRoot).ok, true);

// A move that raises the total fails.
writeFileSync(otherTs, "export const B = 1;\n");
writeFileSync(wordsTs, 'export const A = { title: "the worktree", hint: "its snapshot" };\n');
const movedUp = run(copyRoot);
assert.equal(movedUp.ok, false);
assert.match(movedUp.output, /jargon rose from 1 to 2/);

// (Challenger) A fall must be recorded in the same change, and the write
// drops files at 0: a fall left in the baseline would be credit…
writeFileSync(wordsTs, "export const A = 1;\n");
const jFell = run(copyRoot);
assert.equal(jFell.ok, false, jFell.output);
assert.match(jFell.output, /jargon: src\/lib\/other\.ts 1 → 0/);
assert.match(jFell.output, /jargon 1 → 0 is not recorded/);
// …that a later change spends elsewhere, passing as a "move".
writeFileSync(wordsTs, 'export const A = { title: "a snapshot" };\n');
const spent = run(copyRoot);
assert.equal(spent.ok, false, spent.output);
assert.match(spent.output, /moved from src\/lib\/other\.ts/);
writeFileSync(wordsTs, "export const A = 1;\n");
run(copyRoot, { writeBaseline: true });
assert.deepEqual(baselineOf().jargon, {});
assert.equal(run(copyRoot).ok, true);

// (Challenger) A new ux-allow lowers no count silently: the run names it
// with its reason until --write-baseline records it, and the write may
// raise this one count (so the baseline's diff shows the marker).
writeFileSync(wordsTs, 'export const A = { title: "a snapshot" }; // ux-allow: data\n');
const allowed = run(copyRoot);
assert.equal(allowed.ok, false, allowed.output);
assert.match(allowed.output, /ux-allow markers: src\/lib\/words\.ts 0 → 1 \(new\)/);
assert.match(allowed.output, /src\/lib\/words\.ts:1: "ux-allow: data"/);
assert.match(allowed.output, /jargon 0 in 0 file\(s\)/);
assert.equal(run(copyRoot, { writeBaseline: true }).ok, true);
assert.deepEqual(baselineOf().uxAllows, { "src/lib/words.ts": 1 });
assert.equal(run(copyRoot).ok, true);
writeFileSync(wordsTs, "export const A = 1;\n");
run(copyRoot, { writeBaseline: true });
assert.deepEqual(baselineOf().uxAllows, {});

// Raw errors inline: the same ratchet.
writeFileSync(join(copyRoot, "src/Shown.tsx"), "export const S = () => { try {} catch (e) { setError(String(e)); } return <p>ok</p>; };\n");
const rawRose = run(copyRoot);
assert.equal(rawRose.ok, false);
assert.match(rawRose.output, /raw errors inline rose from 0 to 1/);
assert.match(rawRose.output, /src\/Shown\.tsx:1: "setError\(String\(e\)"/);

// A technical surface's file is not counted; a listed file must exist.
writeFileSync(join(copyRoot, "src/Shown.tsx"), "export const S = () => <p>ok</p>;\n");
writeFileSync(join(copyRoot, "src/Tech.tsx"), "export const T = () => <p>git worktree list</p>;\n");
writeFileSync(
  join(copyRoot, TECHNICAL_FILE),
  JSON.stringify({ files: [{ file: "src/Tech.tsx" }], functions: [{ file: "src/Gone.tsx", name: "X" }] }),
);
const tech = run(copyRoot);
assert.match(tech.output, /jargon 0 in 0 file\(s\)/);
assert.match(tech.output, /technical-surfaces\.json: "src\/Gone\.tsx" does not exist/);

// A baseline from before P-D1 (no per-file maps) asks for one write.
const oldRoot = makeRoot("old-baseline");
writeFileSync(join(oldRoot, BASELINE_FILE), JSON.stringify({ buttonFamilies: 1, panelFamilies: 1, colourLiterals: 3 }));
assert.match(run(oldRoot).output, /has no jargon counts — run with --write-baseline once/);
assert.equal(run(oldRoot, { writeBaseline: true }).ok, true);
assert.equal(run(oldRoot).ok, true);

// QoL 1.168 block 8 (A4): the words the 1.168 review found, and the state
// words — "Waiting" alone is never a state; a payment page is not git's.
assert.deepEqual(
  words(
    "src/lib/q.ts",
    [
      'const a = { title: "Stop this swarm?", hint: "The other vendor reads it." };',
      'const b = { label: "Conclude intake", body: "Your checkout is untouched." };',
      'const c = { label: "P1 only", text: "Merged into main." };',
      'const d = { label: "Waiting", hint: "Waiting for the payment…" };',
      'const e = { title: "Opening the checkout page…", body: "Ended with exit code 1." };',
    ].join("\n"),
  ),
  ["1:swarm", "1:vendor", "2:intake", "2:checkout", "3:P1", "3:into main", "4:Waiting", "5:exit code 1"],
);
// (A5) a template that prints a caught error, as copy or a terminal line;
// a template handed to details is not read.
assert.deepEqual(
  rawErrorsInline(
    "src/T.tsx",
    [
      "catch (e) { term.writeln(`[spawn failed: ${String(e)}]`); }",
      "catch (e) { pushToast({ kind: \"error\", title: `Failed: ${rawError(e)}` }); }",
      "catch (e) { setActionError(`Not sent: ${rawError(e)}`); }",
      "catch (e) { pushToast({ kind: \"error\", title: \"Failed\", details: `${e}` }); }",
    ].join("\n"),
  ).map((h) => h.line),
  [1, 2, 3],
);

// G2 (1.173.0): the Reviewer's old name, the old improvement proposal and
// Ship batch are banned in copy; the saved ids in lower case are not copy.
assert.deepEqual(
  words(
    "src/lib/x.ts",
    [
      'export const A_TITLE = "The Challenger reviews it";',
      'const s = { state: "challenger-reviewing", label: "Reviewing" };',
      'export const B_LABEL = "Improvement proposal";',
      'export const C_HINT = "Ship batch, part of Pro";',
    ].join("\n"),
  ),
  ["1:Challenger", "3:Improvement proposal", "4:Ship batch"],
);

// B3 (1.174.0; UX audit P35, P36, G3, G4, G9, G19, NI-7; owner D11): the
// Reviewer's other names, "Verify" as a step, "repo" and "uncommitted".
assert.deepEqual(
  words(
    "src/lib/x.ts",
    [
      'export const A_LABEL = "Check without the second AI’s review";',
      'export const B_HINT = "You write it, an AI builds it, a second AI checks it.";',
      'export const C_HINT = "A second AI, the Reviewer, checks the work.";',
      'export const D_HINT = "a second opinion from the other AI.";',
      'export const E_HINT = "A second pass sets aside ideas that only add.";',
      'export const F_TITLE = "Verify failed.";',
      'export const G_HINT = "the Reviewer and Verify check it.";',
      'export const H_HINT = "Verify the build before you ship.";',
      'export const I_HINT = "everyone who opens this repo";',
      'export const J_HINT = "This repository has it.";',
      'export const K_HINT = "gh auth refresh -h github.com -s repo,read:org";',
      'export const L_HINT = "Open owner/repo on GitHub.";',
      'export const M_TITLE = "Target workspace has uncommitted changes";',
    ].join("\n"),
  ),
  ["1:second AI’s review", "2:a second AI checks", "4:second opinion", "5:second pass", "6:Verify", "7:Verify", "9:repo", "13:uncommitted"],
);
// "second opinion" is Next improvement's own word (D11), nowhere else's.
assert.deepEqual(words("src/lib/nextImprovement.ts", 'export const A_LABEL = "Set aside by the second opinion";'), []);
assert.deepEqual(words("src/components/NiDirectionSheet.tsx", 'export const A_LABEL = "Proposes · second opinion";'), []);
assert.deepEqual(words("src/lib/quickTour.ts", 'export const A_LABEL = "a second opinion";'), ["1:second opinion"]);
assert.equal(isNextImprovementFile("src/store/nextImprovementStore.ts"), true);
assert.equal(isNextImprovementFile("src/lib/tutorial/manifest.ts"), false);

// TX10 (1.174.0, PLAN §4.1): American spelling on screen. The British
// spellings are banned in copy; an action id spelled the old way
// (`id: "authorise"`) is no copy and stays.
assert.deepEqual(
  words(
    "src/lib/x.ts",
    [
      'export const A_HINT = "It stays in grey until the limit resets.";',
      'export const B_LABEL = "Workspace colour";',
      'export const C_HINT = "Pick from the colours below.";',
      'export const D_HINT = "Cards come from the issues labelled area:site";',
      'export const E_HINT = "Your organisation needs single sign-on.";',
      'export const F_HINT = "Two organisations can see it.";',
      'export const G_HINT = "Authorise the GitHub command, then check again.";',
      'export const H_HINT = "It stays in gray, labeled, in its color, for your organization.";',
      'export const ACTION = { id: "authorise", label: "Authorize" };',
    ].join("\n"),
  ),
  ["1:grey", "2:colour", "3:colours", "4:labelled", "5:organisation", "6:organisations", "7:Authorise"],
);

// B3: an error toast says what to do next — a body or an action. A ternary's
// branches are each judged; a warn, a spread, a toast passed by name are not.
assert.deepEqual(
  bareErrorToasts(
    "src/A.tsx",
    [
      'pushToast({ kind: "error", title: "Archive failed", details: rawError(e) });',
      'pushToast({ kind: "error", title: "Not archived", body: "It is back in its column; try again." });',
      'pushToast({ kind: "error", title: "Not sent", action: { label: "Try again", run: retry } });',
      'pushToast(dirty ? { kind: "warn", title: "Changes" } : { kind: "error", title: "Ship failed" });',
      'pushToast({ kind: ok ? "info" : "error", title });',
      'pushToast({ ...base, kind: "error", title: "x" });',
      'pushToast(toast);',
      '// pushToast({ kind: "error", title: "In a comment" });',
      'useToasts.getState().pushToast({ kind: "error", title: "Member call" });',
    ].join("\n"),
  ),
  [
    { line: 1, found: '"Archive failed"' },
    { line: 4, found: '"Ship failed"' },
    { line: 5, found: "title" },
  ],
);
assert.deepEqual(bareErrorToasts("src/A.ts", 'pushToast({\n  kind: "error",\n  title: `Couldn\'t save ${name}`,\n});'), [
  { line: 1, found: "`Couldn't save ${name}`" },
]);

// TX6 (E10, round 1 of A5): every openWebLink tells a link that didn't open
// with linkDidNotOpen — through .then chains, a handler passed by name and a
// silent catch judged too.
{
  const hits = linkToastHits(
    "src/A.tsx",
    [
      'void openWebLink(url).catch((e) => pushToast({ kind: "error", title: "The browser didn\'t open", body: url }));',
      "void openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e)));",
      "void openWebLink(url).catch(() => {});",
      "void openWebLink(url);",
      "void openWebLink(`https://x/${a(b)}`)",
      '  .catch((e) =>',
      '    pushToast({ kind: "warn", title: "Couldn\'t open the link", body: url }),',
      "  );",
      '// openWebLink(u).catch(() => pushToast({ kind: "error", title: "x" }));',
      "void openWebLink(url).then(() => done()).catch((e) => pushToast(linkDidNotOpen(url, e)));",
      "void openWebLink(url).then(() => done()).catch(() => {});",
      "void openWebLink(url).catch(onError);",
      "export function openWebLink(url: string) {",
    ].join("\n"),
  );
  assert.deepEqual(
    hits.map((h) => h.split(": ")[0]),
    ["src/A.tsx:1", "src/A.tsx:3", "src/A.tsx:4", "src/A.tsx:5", "src/A.tsx:11", "src/A.tsx:12"],
  );
  assert.match(hits[0], /linkDidNotOpen/);
  assert.deepEqual(linkToastHits("src/lib/linkToast.ts", "openWebLink(u).catch(() => pushToast(t));"), []);
  assert.deepEqual(linkToastHits("src/ipc.ts", "export function openWebLink(url) { return invoke(url); }\nopenWebLink(u);"), []);
  // The try/await form: the innermost try around an awaited call (known
  // limit: its catch is shared with any other await in the block).
  const tryHits = linkToastHits(
    "src/B.tsx",
    [
      "async function a(url) {",
      "  try {",
      "    await openWebLink(url);",
      "  } catch (e) {",
      '    pushToast({ kind: "error", title: "Couldn\'t open GitHub", details: String(e) });',
      "  }",
      "}",
      "async function b(url) {",
      "  try { await openWebLink(url); } catch (e) { pushToast(linkDidNotOpen(url, e)); }",
      "  try { await other(); } catch (e) { pushToast({ kind: \"error\", title: \"x\" }); }",
      "  try { await openWebLink(url); } catch { /* quiet */ }",
      "  try { act({ onClick: () => void openWebLink(url).catch(() => {}) }); } catch (e) { pushToast(linkDidNotOpen(u, e)); }",
      "  await openWebLink(url);",
      "  try { try { await openWebLink(url); } catch (e) { throw e; } } catch (e) { pushToast(linkDidNotOpen(url, e)); }",
      "}",
    ].join("\n"),
  );
  assert.deepEqual(
    tryHits.map((h) => h.split(": ")[0]),
    ["src/B.tsx:3", "src/B.tsx:11", "src/B.tsx:12", "src/B.tsx:13", "src/B.tsx:14"],
  );
}

// B3: string literals, for the agent-words rule.
assert.deepEqual(
  tsStrings("src/A.tsx", 'const P_PROMPT = `You are the ${role}: read it`;\nconst r = /it\'s/;\nconst a = <p title="Hi">Don\'t "x"</p>;\n// "comment"\n').map((x) => `${x.line}:${x.text}`),
  ["1:You are the ", "1:: read it", "3:Hi"],
);
assert.deepEqual(
  rustStrings(
    [
      'const A: &str = r#"You are the Challenger"#;',
      "// \"a comment\"",
      "fn f<'a>(x: &'a str) -> char { let c = '\"'; \"two\\\"quoted\" ; 'x' }",
      "#[cfg(test)]",
      'const T: &str = "test only";',
      "#[cfg(test)]",
      "mod tests {",
      '    fn t() { let s = "in tests"; }',
      "}",
      "#[cfg(not(test))]",
      'const N: &str = "not test";',
      'const B: &[u8] = b"bytes";',
    ].join("\n"),
  ).map((x) => `${x.line}:${x.text}`),
  ["1:You are the Challenger", '3:two\\"quoted', "11:not test", "12:bytes"],
);
// End to end: a prompt with the old name, in TS or Rust, is counted per file
// (agentWords); a test file, a test module and a JSX text are not.
{
  const root = makeRoot("agent-words");
  mkdirSync(join(root, "src/lib"), { recursive: true });
  mkdirSync(join(root, "src-tauri/src"), { recursive: true });
  writeFileSync(join(root, "src/lib/ask.ts"), 'export const ASK_PROMPT = "The Challenger found this; fix it.";\n');
  writeFileSync(join(root, "src/lib/ask.test.ts"), 'const s = "You are the Challenger";\n');
  writeFileSync(join(root, "src-tauri/src/review.rs"), 'const T: &str = "You are the Challenger";\n#[cfg(test)]\nmod tests { const X: &str = "Challenger"; }\n');
  writeFileSync(join(root, "src-tauri/src/review_tests.rs"), 'const X: &str = "Challenger";\n');
  // TX7: in releaseHighlights.ts only, a line with a ux-allow marker (the
  // point that announces the rename) is not counted; the line after it is,
  // and a marker in any other file (a prompt) hides nothing.
  const news = join(root, "src/lib/releaseHighlights.ts");
  writeFileSync(news, 'export const A = "The Challenger is now the Reviewer."; // ux-allow: names the old name to announce the rename\n');
  assert.deepEqual([...agentWordHits(root).keys()].sort(), ["src-tauri/src/review.rs", "src/lib/ask.ts"]);
  writeFileSync(news, 'export const A = "x"; // ux-allow: names the old name to announce the rename\nexport const B = "The Challenger";\n');
  assert.deepEqual(agentWordHits(root).get("src/lib/releaseHighlights.ts")?.map((h) => h.line), [2]);
  rmSync(news);
  const prompt = join(root, "src/lib/other.ts");
  writeFileSync(prompt, 'export const P_PROMPT = "You are the Challenger"; // ux-allow: names the old name to announce the rename\n');
  assert.deepEqual(agentWordHits(root).get("src/lib/other.ts")?.map((h) => h.line), [1]);
  rmSync(prompt);
  assert.deepEqual([...agentWordHits(root).keys()].sort(), ["src-tauri/src/review.rs", "src/lib/ask.ts"]);
  run(root, { writeBaseline: true });
  const base = JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8"));
  assert.deepEqual(base.agentWords, { "src-tauri/src/review.rs": 1, "src/lib/ask.ts": 1 });
  assert.equal(run(root).ok, true, run(root).output);
  writeFileSync(join(root, "src/lib/ask.ts"), 'export const ASK_PROMPT = "The Challenger found this; the Challengers agree.";\n');
  const rose = run(root);
  assert.equal(rose.ok, false);
  assert.match(rose.output, /the Reviewer's old name in agent text rose from 2 to 3/);
  writeFileSync(join(root, "src/lib/ask.ts"), 'export const ASK_PROMPT = "The Reviewer found this; fix it.";\n');
  assert.match(run(root).output, /the Reviewer's old name in agent text 2 → 1 is not recorded/);
  // Error toasts with only a title: the same ratchet.
  writeFileSync(join(root, "src/lib/save.ts"), 'pushToast({ kind: "error", title: "Save failed" });\n');
  run(root, { writeBaseline: true });
  assert.deepEqual(JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8")).bareErrorToasts, {}, "a rise is never written");
  assert.match(run(root).output, /error toasts with no body or action rose from 0 to 1/);
  assert.match(run(root, { list: true }).output, /src\/lib\/save\.ts:1: ""Save failed""/);
}

// B3: a word added to JARGON records its hits once. The baseline lists the
// words its counts were taken with; until the write, the run names the new
// word; the write records it, but a known word may still never rise.
{
  const root = makeRoot("new-word");
  mkdirSync(join(root, "src/lib"), { recursive: true });
  writeFileSync(join(root, "src/lib/a.ts"), 'export const A_TITLE = "Target workspace has uncommitted changes";\n');
  run(root, { writeBaseline: true });
  const path = join(root, BASELINE_FILE);
  const known = JARGON.map(([w]) => w).filter((w) => w !== "uncommitted");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), jargon: {}, jargonWords: known }));
  const before = run(root);
  assert.equal(before.ok, false);
  assert.match(before.output, /new banned word\(s\) "uncommitted": their hits today aren't in docs\/ux-language\/ux-baseline\.json/);
  // A known word's rise in the same change is still refused.
  writeFileSync(join(root, "src/lib/b.ts"), 'export const B_TITLE = "The worktree";\n');
  assert.match(run(root, { writeBaseline: true }).output, /--write-baseline refused: a count would rise — jargon 0 → 1 \(src\/lib\/b\.ts\)/);
  writeFileSync(join(root, "src/lib/b.ts"), "export const B = 1;\n");
  assert.equal(run(root, { writeBaseline: true }).ok, true);
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(after.jargon, { "src/lib/a.ts": 1 });
  assert.ok(after.jargonWords.includes("uncommitted"));
  assert.equal(run(root).ok, true);
  // Once known, it only goes down.
  writeFileSync(join(root, "src/lib/b.ts"), 'export const B_TITLE = "uncommitted";\n');
  assert.match(run(root).output, /jargon rose from 1 to 2/);
  // A baseline from before the list asks for one write.
  delete after.jargonWords;
  writeFileSync(path, JSON.stringify(after));
  assert.match(run(root).output, /has no jargonWords — run with --write-baseline once/);
}

// B3 round 1: "repo" in a command is not the word.
assert.deepEqual(
  words(
    "src/lib/x.ts",
    [
      'export const A_HINT = "Run gh repo clone x first.";',
      'export const B_HINT = "gh auth refresh -h github.com -s repo";',
      'export const C_HINT = "Open the repo.";',
    ].join("\n"),
  ),
  ["3:repo"],
);
// 1.175.0 F9 (UX-17): the four words of the extended ban — "repo",
// "worktree", "Verify" as a step's name, and a git "remote" — each caught in
// copy; a command's token or a config key is not the word.
assert.deepEqual(
  words(
    "src/lib/x.ts",
    [
      'export const A_HINT = "This repo already has this exact skill";',
      'export const B_LABEL = "Open the worktree";',
      'export const C_HINT = "each card\'s Verify builds it.";',
      'export const D_HINT = "This repository has no remote, so there is nowhere to publish to.";',
      'export const E_HINT = "Pull requests need a GitHub remote.";',
      'export const F_HINT = "Run git remote -v to see it.";',
      'export const G_HINT = "Set remote.pushDefault there.";',
      'export const H_HINT = "Its remotes changed.";',
    ].join("\n"),
  ),
  ["1:repo", "2:worktree", "3:Verify", "4:remote", "5:remote", "8:remotes"],
);
// B3 round 1: the seven B3 words are read in any string with a space — a
// key that isn't a copy key, a function whose name doesn't say copy — but
// never in an agent prompt, a details value or a one-word id.
assert.deepEqual(
  words(
    "src/lib/x.ts",
    [
      'const keys = { verifyPipeline: "Verify pipeline", meaning: "everyone who opens this repo" };',
      'function lead() { return ["then the Reviewer and Verify check it."]; }',
      'const ASK_PROMPT = "Commit the uncommitted work in this repo.";',
      'pushToast({ kind: "error", title: "x", body: "y", details: "the repo is uncommitted" });',
      'const id = "repo";',
      'const t = "The worktree is here";',
    ].join("\n"),
  ),
  ["1:Verify", "1:repo", "2:Verify"],
  "an older word stays at copy positions only",
);
// "second opinion" in the glossary's own definition is allowed (D11).
assert.deepEqual(words("src/lib/glossary.ts", 'const G = { s: "A second opinion is Next improvement\'s separate pass." };'), []);
assert.deepEqual(words("src/lib/other.ts", 'const G = { s: "A second opinion is a pass." };'), ["1:second opinion"]);
// TX5 round 1b: "second pass" too, in the glossary's definition only.
assert.deepEqual(words("src/lib/glossary.ts", 'const G = { s: "A second opinion is Next improvement\'s second pass." };'), []);
assert.deepEqual(words("src/lib/other.ts", 'const G = { s: "It is a second pass." };'), ["1:second pass"]);

// B3 round 1: --write-baseline writes both files or neither. A registry
// error leaves the baseline (and its closed legacy list) as it was.
{
  const root = makeRoot("all-or-nothing", { migrated: [], legacy: ["src/components/Shell.tsx"] });
  run(root, { writeBaseline: true });
  const path = join(root, BASELINE_FILE);
  const before = readFileSync(path, "utf8");
  writeFileSync(join(root, MIGRATED_FILE), JSON.stringify({ files: [], legacy: [] }));
  const r = run(root, { writeBaseline: true });
  assert.equal(r.ok, false);
  assert.match(r.output, /--write-baseline refused: the component registry has 1 problem\(s\) — fix them first/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(JSON.parse(before).legacyComponents, ["src/components/Shell.tsx"]);
  // A count that would rise leaves migrated.json as it was too.
  writeFileSync(join(root, MIGRATED_FILE), JSON.stringify({ files: [], pending: { "src/components/Shell.tsx": 5 }, legacy: [] }));
  mkdirSync(join(root, "src/lib"), { recursive: true });
  writeFileSync(join(root, "src/lib/a.ts"), 'export const A_TITLE = "The worktree";\n');
  const rose = run(root, { writeBaseline: true });
  assert.match(rose.output, /--write-baseline refused: a count would rise — jargon 0 → 1/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, MIGRATED_FILE), "utf8")).pending, { "src/components/Shell.tsx": 5 });
}

// B3 round 1: a banned word taken out while a new one is recorded (a
// rename) is refused: the old word's hits would pass as the new one's start.
{
  const root = makeRoot("word-swap");
  run(root, { writeBaseline: true });
  const path = join(root, BASELINE_FILE);
  const b = JSON.parse(readFileSync(path, "utf8"));
  const swapped = [...JARGON.map(([w]) => w).filter((w) => w !== "uncommitted"), "an old word"];
  writeFileSync(path, JSON.stringify({ ...b, jargonWords: swapped }));
  const r = run(root, { writeBaseline: true });
  assert.equal(r.ok, false);
  assert.match(r.output, /a banned word is taken out \("an old word"\) while a new one is recorded \("uncommitted"\) — record them in separate changes/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).jargonWords, swapped);
  // Taken out alone, it is recorded.
  writeFileSync(path, JSON.stringify({ ...b, jargonWords: [...JARGON.map(([w]) => w), "an old word"] }));
  assert.equal(run(root, { writeBaseline: true }).ok, true);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).jargonWords, JARGON.map(([w]) => w));
}

console.log("ux-check.test: all assertions passed");
