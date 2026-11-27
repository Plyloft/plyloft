#!/usr/bin/env node
// Ply UX audit harness — scenario runner.
//
//   node scripts/ux-audit/run.mjs                        # build + full run (all viewports × themes + accents)
//   node scripts/ux-audit/run.mjs --state <dir>          # seed from a Ply state snapshot (else synthetic)
//   node scripts/ux-audit/run.mjs --out <dir>            # output dir (default <repo>/ux-audit-out)
//   node scripts/ux-audit/run.mjs --no-build             # reuse <out>/dist
//   node scripts/ux-audit/run.mjs --only board           # scenarios whose id/area matches
//   node scripts/ux-audit/run.mjs --sizes 1280 --themes light --no-accents --jobs 5
//
// Output: <out>/shots/*.png, <out>/results.json, <out>/INDEX.md
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launch, openApp, sleep } from "./lib.mjs";
import { startServer } from "./server.mjs";
import { SCENARIOS, ACCENT_SCENARIOS, NOT_REACHED, makeCtx } from "./scenarios.mjs";
import { writeIndex } from "./report.mjs";
import { HERE, REPO, OUT, SHOTS, STATE_DIR, arg, has } from "./config.mjs";
import { buildSeedData } from "./fixtures.mjs";

const AUDIT_JS = fs.readFileSync(path.join(HERE, "audit.js"), "utf8");

const SIZES = { 900: [900, 600], 1280: [1280, 800], 1600: [1600, 1000] };
const sizes = (arg("--sizes", "900,1280,1600")).split(",").map(Number);
const themes = (arg("--themes", "light,dark,void")).split(",");
const only = arg("--only", null);
const skipAccents = has("--no-accents");
const PORT = Number(arg("--port", 4174));
const CONCURRENCY = Number(arg("--jobs", 5));

fs.mkdirSync(OUT, { recursive: true });
if (!has("--no-build")) {
  console.log("building harness bundle…");
  execFileSync(process.execPath, [path.join(HERE, "build.mjs"), "--out", OUT], { stdio: "inherit" });
}
fs.mkdirSync(SHOTS, { recursive: true });
if (!only) for (const f of fs.readdirSync(SHOTS)) if (f.endsWith(".png") || f.endsWith(".jpg")) fs.unlinkSync(path.join(SHOTS, f));

const seed0 = buildSeedData();
console.log(`seed: ${STATE_DIR ? "state snapshot " + STATE_DIR : "synthetic (no --state / PLY_STATE_DIR)"}; out: ${OUT}`);
const server = await startServer(PORT, { wsCwd: seed0.plyCwd });
const URL = `http://127.0.0.1:${PORT}/`;
const resultsPath = path.join(OUT, "results.json");
const prior = only && fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, "utf8")) : null;
const results = prior || { meta: {}, screens: {}, unreachable: [], unhandledIpc: {} };
const git = (...a) => { try { return execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim(); } catch { return "?"; } };
const version = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
results.meta = { app: `Ply ${version} (${git("rev-parse", "--abbrev-ref", "HEAD")} ${git("rev-parse", "--short=8", "HEAD")})`, generatedAt: new Date().toISOString(), sizes, themes, url: URL,
  seed: STATE_DIR ? "state snapshot" : "synthetic",
  note: `Real app bundle (harness entry exposes stores); mocked Tauri backend seeded from ${STATE_DIR ? "a Ply state snapshot" : "the synthetic seed"} + fixtures.` };

const onlyList = only ? only.split(",") : null;
const scenarios = SCENARIOS.filter((s) => !onlyList || onlyList.some((o) => s.id.includes(o) || s.area === o));
const jobs = [];
const CHUNK = 12;
for (const w of sizes) for (const theme of themes) for (let i = 0; i < scenarios.length; i += CHUNK) jobs.push({ w, theme, list: scenarios.slice(i, i + CHUNK), accent: "violet" });
if (!skipAccents && (!onlyList || onlyList.includes("accent"))) {
  for (const theme of ["light", "dark", "void"]) for (const accent of ["cyan", "magenta", "sunset"]) jobs.push({ w: 1280, theme, accent, list: ACCENT_SCENARIOS });
}

let done = 0, total = jobs.reduce((n, j) => n + j.list.length, 0);
const unreachable = new Map(results.unreachable.map((u) => [u.id, u]));

async function runJob(browser, job) {
  const [width, height] = SIZES[job.w];
  for (const sc of job.list) {
    if (sc.sizes && !sc.sizes.includes(job.w)) { done++; continue; }
    const accentTag = job.accent !== "violet" ? `-${job.accent}` : "";
    const file = `${sc.nn}-${sc.area}-${sc.state}--${job.theme}${accentTag}-${job.w}.png`;
    const entry = { file, id: sc.id, area: sc.area, state: sc.state, theme: job.theme, accent: job.accent, width, height, fixture: sc.fixture || null };
    let page;
    try {
      const opened = await openApp(browser, { url: URL, width, height, theme: job.theme, accent: job.accent, flags: sc.flags || {}, settingsPatch: sc.settingsPatch });
      page = opened.page;
      const ctx = makeCtx(page, { width, height, theme: job.theme });
      await page.evaluate(() => window.__harness.takeLog());
      opened.log.console.length = 0; opened.log.pageErrors.length = 0;
      const note = await Promise.race([sc.run(ctx), sleep(45_000).then(() => { throw new Error("scenario timed out after 45s"); })]);
      if (note && note.unreachable) {
        unreachable.set(sc.id, { id: sc.id, area: sc.area, state: sc.state, why: note.unreachable });
        entry.unreachable = note.unreachable;
      }
      await sleep(sc.settle ?? 500);
      await page.evaluate(AUDIT_JS);
      await page.screenshot({ path: path.join(SHOTS, file) });
      entry.checks = await page.evaluate(() => window.__audit.run());
      if (sc.tabWalk && job.accent === "violet") entry.tabWalk = await Promise.race([tabWalk(page, sc.tabWalk === true ? 40 : sc.tabWalk), sleep(40_000).then(() => [{ i: 0, tag: "timeout", name: "tab walk timed out" }])]);
      const ipc = await page.evaluate(() => window.__harness.takeLog());
      entry.unhandledIpc = Object.keys(ipc.unhandled);
      entry.ipcErrors = ipc.errors;
      for (const [cmd, u] of Object.entries(ipc.unhandled)) {
        const agg = results.unhandledIpc[cmd] || (results.unhandledIpc[cmd] = { count: 0, screens: [], args: u.args });
        agg.count += u.count; if (agg.screens.length < 8 && !agg.screens.includes(sc.id)) agg.screens.push(sc.id);
      }
      entry.console = opened.log.console.slice(0, 40);
      entry.pageErrors = opened.log.pageErrors.slice(0, 20);
      if (note && note.info) entry.note = note.info;
    } catch (e) {
      entry.error = String(e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e);
      try { if (page) await page.screenshot({ path: path.join(SHOTS, file) }); entry.errorShot = true; } catch {}
      console.warn(`✗ ${file}: ${entry.error}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
    results.screens[file] = entry;
    done++;
    if (done % 10 === 0) console.log(`${done}/${total}`);
  }
}

const browsers = await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => launch()));
const queue = jobs.slice();
await Promise.all(browsers.map(async (b) => { while (queue.length) await runJob(b, queue.shift()); }));
await Promise.all(browsers.map((b) => b.close()));
server.close();

results.unreachable = [...unreachable.values()];
results.notReached = NOT_REACHED;
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 1));
writeIndex(results, OUT);
console.log(`done: ${Object.keys(results.screens).length} screens → ${resultsPath}`);
process.exit(0); // keep-alive sockets on the static server would otherwise hold the process

async function tabWalk(page, max) {
  await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.getSelection().removeAllRanges(); });
  // start from the top of the document
  await page.evaluate(() => { const b = document.body; b.setAttribute("tabindex", "-1"); b.focus(); b.removeAttribute("tabindex"); });
  const stops = [];
  const seen = new Set();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    await sleep(60);
    const s = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const A = window.__audit;
      const f = A.focusStyle(el);
      const fv = el.matches(":focus-visible");
      const sel = A.cssPath(el);
      const r = el.getBoundingClientRect();
      el.blur();
      const b = A.focusStyle(el);
      el.focus();
      const ringByOutline = f.outlineStyle !== "none" && f.outlineWidth > 0;
      const changed = f.boxShadow !== b.boxShadow || f.borderColor !== b.borderColor || f.background !== b.background || f.outlineWidth !== b.outlineWidth;
      // A ring drawn on an ancestor through `:has(:focus-visible)` (a field
      // wrapper, a row that opens) counts: compare the nearest few ancestors'
      // outline / box-shadow / border with and without the focus.
      let ancestorRing = null;
      if (!ringByOutline && !changed) {
        const anc = [];
        for (let p = el.parentElement, d = 0; p && p !== document.body && d < 4; p = p.parentElement, d++) anc.push(p);
        const withFocus = anc.map((p) => A.focusStyle(p));
        el.blur();
        const without = anc.map((p) => A.focusStyle(p));
        el.focus();
        for (let k = 0; k < anc.length; k++) {
          const a = withFocus[k], z = without[k];
          const ring = (a.outlineStyle !== "none" && a.outlineWidth > 0 && (z.outlineStyle === "none" || z.outlineWidth !== a.outlineWidth || z.outlineColor !== a.outlineColor)) || a.boxShadow !== z.boxShadow || a.borderColor !== z.borderColor;
          if (ring) { ancestorRing = A.cssPath(anc[k]); break; }
        }
      }
      const visibleRing = ringByOutline || changed || !!ancestorRing;
      return { i: 0, tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), name: A.accName(el), selector: sel, focusVisible: fv, visibleRing, ringKind: ringByOutline ? "outline" : changed ? "style-change" : ancestorRing ? "ancestor" : "none", ringOn: ancestorRing, outline: `${f.outlineStyle} ${f.outlineWidth}px`, inViewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth };
    });
    if (!s) { stops.push({ i, tag: "body", name: "(focus left the document / body)" }); continue; }
    s.i = i;
    const key = s.selector + "|" + s.name;
    stops.push(s);
    if (seen.has(key) && stops.length > 3) break; // cycled
    seen.add(key);
  }
  await page.keyboard.press("Escape");
  return stops;
}
