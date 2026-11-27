// Writes INDEX.md from results.json: every screenshot, then automated
// findings grouped by area (counts + worst items), unhandled IPCs and the
// states the mock could not reach.
import fs from "node:fs";
import path from "node:path";

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function writeIndex(results, outDir) {
  const screens = Object.values(results.screens).sort((a, b) => a.file.localeCompare(b.file));
  const L = [];
  L.push(`# ${results.meta.app || "Ply"} — UX audit capture`);
  L.push("");
  L.push(`Generated ${results.meta.generatedAt}. ${screens.length} screenshots. ${results.meta.note}`);
  L.push("");
  L.push("- Harness: `scripts/ux-audit/run.mjs` (re-run: `node scripts/ux-audit/run.mjs [--state <dir>] [--out <dir>]`, options `--no-build --only <area|id> --sizes 1280 --themes light --no-accents`).");
  L.push("- Machine-readable results: `results.json` (`screens[file].checks` = contrast / overflow / edge / smallFonts / uppercase / glyphs; `tabWalk`; `console`; `pageErrors`; `unhandledIpc`).");
  L.push("- How it works: `build.mjs` builds the repo's real `src/` with Vite into `<out>/dist/`, with one change — the HTML entry is a virtual module that imports the real `src/main.tsx` and exposes the app's zustand stores on `window.__ply` (used to jump to a card/page/mode). `server.mjs` serves it and maps the Ply workspace's files read-only onto the repo for Code. `mock.js` + `seed-browser.js` + `fixtures.mjs` (+ `synthetic.mjs` without a snapshot) install `window.__TAURI_INTERNALS__` before load and answer every command in memory (never disk). `scenarios.mjs` lists the states; `audit.js` holds the in-page checks.");
  L.push("- Tab walk: a stop counts as having a visible ring when the element's own outline / box-shadow / border / background changes on focus, or when one of its four nearest ancestors draws the ring (`:has(:focus-visible)`), reported as `ringKind: \"ancestor\"`.");
  L.push("- Contrast rows carry `zone` (`ui` / `editor` = CodeMirror syntax colours) and `placeholder: true` for input placeholders; terminals (xterm) are excluded.");
  L.push("- File name: `shots/<nn>-<area>-<state>--<theme>[-accent]-<width>.png`.");
  L.push(`- Seed: ${results.meta.seed === "synthetic" ? "the synthetic seed (synthetic.mjs)" : "a Ply state snapshot"}. **Fixture states**: cards whose id starts \`fx-\` are fixtures added to the Ply board to reach every lifecycle state. Workspaces \`fx-ws-*\` are fixtures to cross the switcher's search threshold (6). Inbox rows, History rows, tiles, skills, diagnostics are fixtures; workspaces, settings and the other cards come from the seed.`);
  L.push("");

  // ---- findings summary
  const areas = [...new Set(screens.map((s) => s.area))];
  const count = (s, k) => (s.checks && s.checks[k] ? s.checks[k].length : 0);
  L.push("## Automated findings — summary by area");
  L.push("");
  L.push("Counts are summed over every screenshot of the area (all themes and sizes), so a problem present in 9 variants counts 9 times; *unique* counts collapse by selector+text.");
  L.push("");
  L.push("| Area | Shots | Contrast (uniq) | Overflow/clip (uniq) | Viewport edge (uniq) | <12px text (uniq) | Uppercase (uniq) | Glyph icons (uniq) | Console err/warn | Page errors | Unhandled IPC | Focus stops w/o ring |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const uniq = (list, k, key) => new Set(list.flatMap((s) => (s.checks && s.checks[k] ? s.checks[k].map(key) : []))).size;
  for (const a of areas) {
    const list = screens.filter((s) => s.area === a);
    const sum = (k) => list.reduce((n, s) => n + count(s, k), 0);
    const tabNoRing = list.reduce((n, s) => n + (s.tabWalk ? s.tabWalk.filter((t) => t.tag !== "body" && !t.visibleRing).length : 0), 0);
    L.push(`| ${a} | ${list.length} | ${sum("contrast")} (${uniq(list, "contrast", (x) => x.selector + x.text)}) | ${sum("overflow")} (${uniq(list, "overflow", (x) => x.selector + x.text)}) | ${sum("edge")} (${uniq(list, "edge", (x) => x.selector)}) | ${sum("smallFonts")} (${uniq(list, "smallFonts", (x) => x.selector)}) | ${sum("uppercase")} (${uniq(list, "uppercase", (x) => x.selector)}) | ${sum("glyphs")} (${uniq(list, "glyphs", (x) => x.selector + x.chars)}) | ${list.reduce((n, s) => n + (s.console || []).length, 0)} | ${list.reduce((n, s) => n + (s.pageErrors || []).length, 0)} | ${new Set(list.flatMap((s) => s.unhandledIpc || [])).size} | ${tabNoRing} |`);
  }
  L.push("");
  const hscroll = screens.filter((s) => s.checks && s.checks.stats && s.checks.stats.horizontalScroll);
  L.push(`Horizontal scroll on the root: ${hscroll.length} screenshot(s)${hscroll.length ? ": " + hscroll.slice(0, 20).map((s) => "`" + s.file + "`").join(", ") : ""}.`);
  L.push("");

  // ---- per-area top items
  L.push("## Top items per area");
  L.push("");
  for (const a of areas) {
    const list = screens.filter((s) => s.area === a);
    L.push(`### ${a}`);
    L.push("");
    const worstContrast = new Map();
    for (const s of list) for (const c of (s.checks && s.checks.contrast) || []) {
      const k = c.selector + "|" + c.text + "|" + s.theme + (s.accent !== "violet" ? "-" + s.accent : "");
      const prev = worstContrast.get(k);
      if (!prev || c.ratio < prev.c.ratio) worstContrast.set(k, { c, s, n: (prev ? prev.n : 0) + 1 }); else prev.n++;
    }
    const wc = [...worstContrast.values()].filter((x) => !x.c.disabled).sort((x, y) => x.c.ratio - y.c.ratio).slice(0, 8);
    if (wc.length) {
      L.push("Worst contrast (not disabled):");
      L.push("");
      L.push("| ratio | need | text | fg / bg | px | theme | selector | example |");
      L.push("|---|---|---|---|---|---|---|---|");
      for (const { c, s } of wc) L.push(`| ${c.ratio} | ${c.need} | ${esc(c.text).slice(0, 50)} | ${c.fg} / ${c.bg} | ${c.fontSize} | ${s.theme}${s.accent !== "violet" ? "·" + s.accent : ""} | \`${esc(c.selector).slice(0, 80)}\` | \`${s.file}\` |`);
      L.push("");
    }
    const ov = new Map();
    for (const s of list) for (const o of (s.checks && s.checks.overflow) || []) { const k = o.selector + "|" + o.text; if (!ov.has(k)) ov.set(k, { o, s, n: 0 }); ov.get(k).n++; }
    const ovTop = [...ov.values()].sort((x, y) => y.n - x.n).slice(0, 8);
    if (ovTop.length) {
      L.push("Clipped / truncated text (most frequent):");
      L.push("");
      for (const { o, s, n } of ovTop) L.push(`- ${o.kind} ×${n}: “${esc(o.text).slice(0, 70)}” \`${esc(o.selector).slice(0, 80)}\`${o.title ? " (has title)" : " (no title)"} — e.g. \`${s.file}\``);
      L.push("");
    }
    const ed = new Map();
    for (const s of list) for (const e of (s.checks && s.checks.edge) || []) { const k = e.selector; if (!ed.has(k)) ed.set(k, { e, s, n: 0 }); ed.get(k).n++; }
    const edTop = [...ed.values()].sort((x, y) => y.n - x.n).slice(0, 5);
    if (edTop.length) {
      L.push("Past the viewport edge:");
      L.push("");
      for (const { e, s, n } of edTop) L.push(`- ×${n}: “${esc(e.text).slice(0, 50)}” left ${e.left} right ${e.right} (vw ${e.viewport}) \`${esc(e.selector).slice(0, 80)}\` — e.g. \`${s.file}\``);
      L.push("");
    }
    const gl = new Map();
    for (const s of list) for (const g of (s.checks && s.checks.glyphs) || []) { const k = g.selector + g.chars; if (!gl.has(k)) gl.set(k, { g, s, n: 0 }); gl.get(k).n++; }
    if (gl.size) {
      L.push("Glyph characters inside controls:");
      L.push("");
      for (const { g, s, n } of [...gl.values()].slice(0, 8)) L.push(`- ${g.chars} (${g.codepoints}) in “${esc(g.text).slice(0, 50)}” \`${esc(g.selector).slice(0, 70)}\` ×${n}`);
      L.push("");
    }
    const sf = new Map();
    for (const s of list) for (const f of (s.checks && s.checks.smallFonts) || []) { const k = f.selector + f.fontSize; if (!sf.has(k)) sf.set(k, { f, n: 0 }); sf.get(k).n++; }
    if (sf.size) {
      L.push(`Text under 12px: ${[...sf.values()].slice(0, 6).map(({ f }) => `${f.fontSize}px “${esc(f.text).slice(0, 30)}”`).join("; ")}${sf.size > 6 ? ` … (${sf.size} unique)` : ""}`);
      L.push("");
    }
    const up = new Set();
    for (const s of list) for (const u of (s.checks && s.checks.uppercase) || []) up.add(u.text.slice(0, 30));
    if (up.size) { L.push(`Uppercase text-transform: ${[...up].slice(0, 8).map((t) => `“${esc(t)}”`).join(", ")}${up.size > 8 ? " …" : ""}`); L.push(""); }
    const cons = new Map();
    for (const s of list) for (const c of [...(s.console || []).map((x) => x.type + ": " + x.text), ...(s.pageErrors || []).map((x) => "pageerror: " + x)]) cons.set(c.slice(0, 160), (cons.get(c.slice(0, 160)) || 0) + 1);
    if (cons.size) {
      L.push("Console / page errors:");
      L.push("");
      for (const [t, n] of [...cons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) L.push(`- ×${n} ${esc(t)}`);
      L.push("");
    }
    const walks = list.filter((s) => s.tabWalk && s.theme === "light" && s.width === 1280);
    for (const s of walks) {
      const stops = s.tabWalk.filter((t) => t.tag !== "body");
      const noRing = stops.filter((t) => !t.visibleRing);
      L.push(`Tab walk \`${s.file}\`: ${stops.length} stops, ${noRing.length} without a visible ring${noRing.length ? ": " + noRing.slice(0, 8).map((t) => `${t.tag}“${esc(t.name).slice(0, 30)}”`).join(", ") : ""}.`);
    }
    if (walks.length) L.push("");
    const errs = list.filter((s) => s.error);
    if (errs.length) { L.push(`Scenario errors: ${errs.length} — ${[...new Set(errs.map((s) => s.id + ": " + s.error.slice(0, 120)))].slice(0, 5).map(esc).join("; ")}`); L.push(""); }
  }

  // ---- unhandled IPC
  L.push("## Unhandled IPC commands (no mock fixture; answered with a default)");
  L.push("");
  const un = Object.entries(results.unhandledIpc || {});
  if (!un.length) L.push("None.");
  for (const [cmd, u] of un.sort((a, b) => b[1].count - a[1].count)) L.push(`- \`${cmd}\` ×${u.count} — screens: ${u.screens.join(", ")} — args: \`${esc(JSON.stringify(u.args)).slice(0, 140)}\``);
  L.push("");

  // ---- unreachable
  L.push("## States not reached (and why)");
  L.push("");
  const unr = results.unreachable || [];
  const errored = [...new Map(screens.filter((s) => s.error).map((s) => [s.id, s])).values()];
  if (!unr.length && !errored.length && !(results.notReached || []).length) L.push("None.");
  for (const u of unr) L.push(`- **${u.id}** — ${esc(u.why)}`);
  for (const s of errored) L.push(`- **${s.id}** — scenario error (screenshot shows where it stopped): ${esc(s.error).slice(0, 200)}`);
  for (const n of results.notReached || []) L.push(`- **${n.id}** — ${esc(n.why)}`);
  L.push("");

  // ---- screenshot table
  L.push("## Every screenshot");
  L.push("");
  L.push("| File | Area | State | Theme | Size | Notes |");
  L.push("|---|---|---|---|---|---|");
  for (const s of screens) {
    const notes = [s.fixture ? `fixture: ${s.fixture}` : "", s.unreachable ? `UNREACHED: ${s.unreachable}` : "", s.error ? "ERROR" : "", s.note || ""].filter(Boolean).join("; ");
    L.push(`| [${s.file}](shots/${s.file}) | ${s.area} | ${s.state} | ${s.theme}${s.accent && s.accent !== "violet" ? " · " + s.accent : ""} | ${s.width}×${s.height} | ${esc(notes)} |`);
  }
  fs.writeFileSync(path.join(outDir, "INDEX.md"), L.join("\n") + "\n");
}

if (process.argv[1] && process.argv[1].endsWith("report.mjs")) {
  // node scripts/ux-audit/report.mjs [--out <dir>] — rewrite INDEX.md from results.json
  const { OUT: out } = await import("./config.mjs");
  writeIndex(JSON.parse(fs.readFileSync(path.join(out, "results.json"), "utf8")), out);
  console.log("INDEX.md written");
}
