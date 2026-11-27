// Shared: launch Chrome, open the app with the mocked backend for one theme.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSeedData } from "./fixtures.mjs";
import { REPO, CHROME } from "./config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(REPO + "/package.json");
export const puppeteer = (await import(req.resolve("puppeteer-core"))).default;
const SEED_JS = fs.readFileSync(path.join(here, "seed-browser.js"), "utf8");
const MOCK_JS = fs.readFileSync(path.join(here, "mock.js"), "utf8");
const HELPERS_JS = fs.readFileSync(path.join(here, "page-helpers.js"), "utf8");

export async function launch() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_PATH`);
  return puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none", "--hide-scrollbars=false"],
    protocolTimeout: 120_000,
  });
}

/**
 * Open a fresh page with the mock installed. `opts.theme` / `opts.accent` /
 * `opts.flags` / `opts.settingsPatch` shape the seed.
 */
export async function openApp(browser, { url, width, height, theme = "light", accent = "violet", flags = {}, settingsPatch = null }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const data = buildSeedData();
  data.settings.appearance = { theme, accent };
  data.settings.behavior.openOn = "inbox";
  data.settings.windows = { settings: null, settingsPage: null, sidebar: { width: 240, collapsed: false } };
  if (settingsPatch) settingsPatch(data.settings);
  data.flags = flags;
  const log = { console: [], pageErrors: [] };
  page.on("console", (m) => {
    const t = m.type();
    if ((m.location() && /\/__(ls|fs|walk)/.test(m.location().url || "")) || /status of 4(04|13|15)/.test(m.text())) return; // harness file-server answers, not app output
    if (t === "error" || t === "warn" || t === "warning") log.console.push({ type: t, text: m.text().slice(0, 500) });
  });
  page.on("dialog", (d) => { log.console.push({ type: "dialog", text: `${d.type()}: ${d.message()}`.slice(0, 300) }); d.accept().catch(() => {}); });
  page.on("pageerror", (e) => log.pageErrors.push(String(e && e.message ? e.message : e).slice(0, 500)));
  await page.evaluateOnNewDocument(`window.__HARNESS_DATA__ = ${JSON.stringify(data)};\n${SEED_JS}\n${MOCK_JS}\n${HELPERS_JS}`);
  // Emulate the OS scheme too, so `system` would agree with the named theme.
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme === "light" ? "light" : "dark" }, { name: "prefers-reduced-motion", value: "reduce" }]);
  await page.goto(url, { waitUntil: "load", timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector("#root") && document.querySelector("#root").children.length > 0 && window.__ply, { timeout: 15_000 });
  await sleep(1200);
  return { page, log, data };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
