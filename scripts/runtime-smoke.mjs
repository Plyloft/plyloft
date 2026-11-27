#!/usr/bin/env node
//
// PPVP Tier 1.5 — runtime React-mount smoke test.
//
// Boots the built bundle (assumes `vite preview` is already running on
// http://localhost:4173) in headless system Chrome, stubs Tauri APIs so
// invoke() calls don't crash the page, mounts for 3s, then fails if any
// pageerror or React "Maximum update depth" error fired.
//
// This is the Tier 1.5 gate that catches the class of bug Tier 1 missed —
// build-clean code that infinite-loops at startup. See docs/PATTERNS.md.
//
// Usage: node scripts/runtime-smoke.mjs [url]
//   defaults to http://localhost:4173/
//   exit 0 on green, 1 on errors detected, 2 on infrastructure failure
//   (Chrome missing, puppeteer-core missing, page never loaded).

import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const URL = process.argv[2] ?? "http://localhost:4173/";
const CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MOUNT_HOLD_MS = 3000;
const PAGE_TIMEOUT_MS = 15000;

if (!existsSync(CHROME_PATH)) {
  console.error(
    `infra: system Chrome not found at ${CHROME_PATH} — skipping smoke`,
  );
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const errors = [];
const RELEVANT = [
  /Maximum update depth/i,
  /Too many re-renders/i,
  /Cannot update.+during.+render/i,
  /Invalid hook call/i,
  /Rendered more hooks than/i,
  /Installed self-check observer/i,
  /Dependency re-probe toolbar sync/i,
  /Drop guard failed/i,
  /Tutorial panel failed/i,
  // Production builds emit minified codes — React error #185 is
  // "Maximum update depth exceeded", #300/#301 are similar render-loop
  // signals, and the broader #1[0-9]{2} range covers other render-time
  // failures that should never reach a release build.
  /Minified React error #1\d{2}/,
  /Minified React error #(185|300|301|321)/,
];

try {
  const page = await browser.newPage();
  // UX-3.4: the window Ply opens (1280 × 800). Puppeteer's 800 × 600 default
  // is below the 1000 px where the sidebar becomes an overlay, and below the
  // window's own minimum width (900).
  await page.setViewport({ width: 1280, height: 800 });
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  // Stub Tauri APIs before any app script runs. Without this, every
  // invoke() call rejects loudly and shadows the real React errors we
  // want to surface.
  await page.evaluateOnNewDocument(() => {
    const noop = () => Promise.resolve(undefined);
    const noopList = () => Promise.resolve([]);
    const noopUnlisten = () => Promise.resolve(() => {});
    let shellEnvReprobed = false;
    const shellEnvSnapshot = (claudeFound) => ({
      path: "/usr/bin:/usr/local/bin",
      shell: "/bin/zsh",
      claudePath: claudeFound ? "/usr/local/bin/claude" : null,
      claudeVersion: claudeFound ? "2.1.232" : null,
      codexPath: null,
      codexVersion: null,
      codexHealthy: false,
      gitPath: "/usr/bin/git",
      gitVersion: "2.50.1",
      ghPath: null,
      ghVersion: null,
      supportsStreamJson: claudeFound,
      probeError: claudeFound ? null : "claude binary not found in PATH",
    });
    const doctorTool = (overrides) => ({
      id: "git",
      name: "Git",
      required: true,
      found: true,
      path: "/usr/bin/git",
      version: "2.50.1",
      versionOk: true,
      detail: "Version control",
      installCmd: "xcode-select --install",
      docsUrl: "https://git-scm.com/downloads",
      reviewer: null,
      ...overrides,
    });
    const doctorSnapshot = (claudeFound) => ({
      tools: [
        doctorTool({}),
        doctorTool({
          id: "claude",
          name: "Claude Code",
          found: claudeFound,
          path: claudeFound ? "/usr/local/bin/claude" : null,
          version: claudeFound ? "2.1.232" : null,
          versionOk: claudeFound,
          detail: claudeFound
            ? "Runs your Claude agents and swarms."
            : "Required — agents can't run without the Claude Code CLI.",
          installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
          docsUrl: "https://docs.claude.com/en/docs/claude-code/setup",
        }),
      ],
      probeError: claudeFound ? null : "claude binary not found in PATH",
      allRequiredOk: claudeFound,
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { windowLabel: "main", label: "main" },
        },
        invoke: (cmd, args) => {
          // Return shapes the app can survive against
          if (cmd === "shell_env_info")
            return Promise.resolve(shellEnvSnapshot(shellEnvReprobed));
          if (cmd === "shell_env_retry") {
            shellEnvReprobed = true;
            return Promise.resolve(shellEnvSnapshot(true));
          }
          if (cmd === "workspace_list")
            return Promise.resolve({
              workspaces: [
                {
                  id: "smoke-ws-1",
                  name: "smoke",
                  cwd: "/tmp/smoke",
                  createdAt: 0,
                  lastOpenedAt: 0,
                  openFiles: [],
                  activeFile: null,
                  accentColor: null,
                },
              ],
              activeWorkspaceId: "smoke-ws-1",
            });
          // Launch A2: a signed-in account, so the Sign-in screen (D1) is
          // not drawn over the shell this smoke drives.
          if (cmd === "account_get")
            return Promise.resolve({
              signedIn: true, login: "smoke", sub: "1", plan: "free", teamRepo: null, teamRole: null,
              status: null, periodEnd: null, exp: 4102444800000, comp: false, entitlementValid: true,
              lastCheckedAt: 0, offline: false, replacedBy: null, deviceName: "Smoke",
            });
          if (cmd === "account_dev_skip_sign_in") return Promise.resolve(false);
          if (cmd === "workspace_cwd_exists") return Promise.resolve(true);
          if (cmd === "agent_list") return Promise.resolve([]);
          if (cmd === "agent_run_list") return Promise.resolve([]);
          if (cmd === "reviewer_list") return Promise.resolve([]);
          if (cmd === "fs_list_dir") return Promise.resolve([]);
          if (cmd === "fs_watch_workspace") return Promise.resolve();
          if (cmd === "probe_localhost_ports") return Promise.resolve([]);
          if (cmd === "ripgrep_available") return Promise.resolve(true);
          if (cmd === "drain_status")
            return Promise.resolve({ draining: false, startedAt: null });
          if (cmd === "dependency_doctor")
            return Promise.resolve(doctorSnapshot(shellEnvReprobed));
          // 1.176.0: the Repair's reads, answered as the engine does for a
          // machine where nothing needs repairing (never null: Diagnostics'
          // Repair group reads the plan of both tools).
          if (cmd === "cli_repair_plan")
            return Promise.resolve({
              tool: args?.tool ?? "claude",
              situations: [{ kind: "healthy" }],
              notes: [],
              steps: [],
              block: { kind: "nothingToRepair", healthyEnough: false },
              nextStep: null,
              manual: [],
              quick: !!args?.request?.quick,
            });
          if (cmd === "cli_health")
            return Promise.resolve({ tool: args?.tool ?? "claude", healthy: true, runsToday: null, shouldRun: null, installDir: null, cached: null, copies: [], folders: [], findings: [], passedOver: null });
          if (cmd === "cli_repair_in_use") return Promise.resolve([]);
          if (cmd === "cli_repair_report") return Promise.resolve("");
          if (cmd === "setup_last_run") return Promise.resolve(null);
          // The backend saves what it is sent and answers with it; a null
          // answer would leave the app with no settings at all.
          if (cmd === "settings_set") return Promise.resolve(args?.settings ?? null);
          if (cmd === "settings_get")
            return Promise.resolve({
              schemaVersion: 1,
              appearance: { theme: "system" },
              terminals: { defaultNewPaneKind: "shell", scrollbackLines: 5000 },
              shell: { pathOverride: null },
              // OB-4: a Mac that has seen Setup, so its overlay (which
              // opens once for anyone without `setupVersion`) is not drawn
              // over the shell this smoke drives.
              onboarding: { firstRunCompletedAt: "2026-01-01T00:00:00Z", setupVersion: 2 },
              editor: { tabSize: 2, lineNumbers: true, wordWrap: false },
              behavior: {
                fileWatcherEnabled: true,
                externalWriteReloadStrategy: "promptIfDirty",
                notifyOnAgentDone: true,
                experimentalLayout: false,
              },
            });
          return Promise.resolve(null);
        },
        transformCallback: (cb) => cb,
      },
      configurable: true,
    });
    // Stub the event listen API used by ipc.ts wrappers
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      value: { unregisterListener: noop },
      configurable: true,
    });
    // Tauri's listen() polyfill: we just register listeners that never fire
    window.__TAURI_LISTEN_STUB__ = { noop, noopList, noopUnlisten };
  });

  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message} :: ${String(err.stack).split("\n").slice(1, 4).join(" | ")}`);
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Filter known-Tauri-stub noise; only surface React / actual errors
    if (text.includes("__TAURI") || text.includes("listen")) return;
    if (text.includes("not found in registry")) return;
    errors.push(`console.error: ${text}`);
  });

  await page.goto(URL, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS });
  // v1.101.x: a dependency re-probe must update the app shell's executable
  // snapshot, not only the doctor's report. Regression: the missing-Claude
  // modal used to close while the Terminals toolbar stayed on its startup
  // snapshot and hid "+ New claude" until the next app launch.
  // UX-3.8: the missing tool is a status row at the sidebar's foot; its Fix
  // opens Settings › Diagnostics, whose Look again re-probes.
  let dependencySyncStage = "open Diagnostics from the status row";
  try {
    const clickButton = (label) =>
      page.evaluate((text) => {
        const button = [...document.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === text,
        );
        button?.click();
        return Boolean(button);
      }, label);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".shell-status-action")].some(
          (b) => b.textContent === "Fix",
        ),
      { timeout: 3000 },
    );
    await page.evaluate(() => {
      [...document.querySelectorAll(".shell-status-action")]
        .find((b) => b.textContent === "Fix")
        ?.click();
    });
    dependencySyncStage = "run dependency re-probe";
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent?.trim() === "Look again",
        ),
      { timeout: 3000 },
    );
    await clickButton("Look again");
    dependencySyncStage = "observe Claude tile action";
    await page.waitForFunction(
      () =>
        // UX-8.2: "New Claude session" (the empty Terminals), sentence case.
        [...document.querySelectorAll("button")].some((button) =>
          /new claude/i.test(button.textContent ?? ""),
        ),
      { timeout: 3000 },
    );
    dependencySyncStage = "the resolved status row goes";
    await page.waitForFunction(
      () => !document.querySelector(".shell-status"),
      { timeout: 3000 },
    );
    dependencySyncStage = "close Settings";
    await page.click('button[aria-label="Close settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]', {
      hidden: true,
      timeout: 3000,
    });
  } catch (error) {
    errors.push(
      `Dependency re-probe toolbar sync failed at ${dependencySyncStage}: ${error.message}`,
    );
  }
  // v1.95.0 SC-2: mount and unmount the exact-query observer once. This is
  // deliberately the real palette path so selector-identity/render-loop
  // regressions cannot hide behind an observer that Tier 1.5 never mounts.
  let selfCheckStage = "open palette";
  try {
    await new Promise((r) => setTimeout(r, 250));
    // Headless Chrome on macOS does not reliably deliver a Meta-modified key
    // to the page. Use the same app-owned event as the visible Commands row;
    // this still exercises the production palette and exact-query route.
    await page.evaluate(() => {
      window.dispatchEvent(new Event("ply:open-palette"));
    });
    await page.waitForSelector(".palette-input", { timeout: 3000 });
    selfCheckStage = "enter exact diagnostic query";
    // The dependency re-probe immediately above closes a modal and restores
    // focus asynchronously. Waiting for the palette input to exist does not
    // prove it still owns keyboard input, so make that precondition explicit
    // before exercising the real typing path.
    await page.focus(".palette-input");
    await page.keyboard.type("Ply diagnostics: P3-1 self-check");
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".palette-item-label")].some(
          (element) =>
            element.textContent === "Ply diagnostics: P3-1 self-check",
        ),
      { timeout: 3000 },
    );
    selfCheckStage = "invoke diagnostic command";
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-ply-installed-self-check]", {
      timeout: 3000,
    });
    selfCheckStage = "close diagnostic observer";
    await page.click(
      '[data-ply-installed-self-check] button[aria-label="Close self-check"]',
    );
    await page.waitForSelector("[data-ply-installed-self-check]", {
      hidden: true,
      timeout: 3000,
    });
  } catch (error) {
    errors.push(
      `Installed self-check observer mount failed at ${selfCheckStage}: ${error.message}`,
    );
  }
  // GH #138: a file released outside a drop zone used to navigate the whole
  // webview to that file. The shell's drop guard must neutralize it, and must
  // stand aside only for a zone that accepts what the drag is carrying.
  //
  // The guard runs in the capture phase on `window`, so a probe registered
  // here — also in capture, and therefore after it — sees what it left
  // behind. `dropEffect` is not asserted: Chrome pins a synthetic
  // DataTransfer's effectAllowed and dropEffect at "none" whatever anyone
  // assigns, so the assertion would pass on the default and prove nothing.
  // src/lib/dropGuard.test.ts covers it.
  const TOAST = "Drop files on a terminal, a card, or the editor";
  await page.evaluate(() => {
    // Drag `types` onto `target` and report what the guard did. `own` is null
    // for a target with no handlers of its own, false for one that only
    // listens, true for one that claims with preventDefault, and
    // "stop-only" for the case the brief's own review asked for: a descendant
    // that calls stopPropagation() without cancelling.
    window.__plyDropProbe = (target, own, types) => {
      const seen = [];
      const probe = (e) =>
        seen.push({ type: e.type, prevented: e.defaultPrevented });
      window.addEventListener("dragover", probe, true);
      window.addEventListener("dragenter", probe, true);
      window.addEventListener("drop", probe, true);
      let reached = 0;
      const claim = (e) => {
        reached++;
        if (own === "stop-only") e.stopPropagation();
        else if (own) e.preventDefault();
      };
      if (own !== null) {
        for (const t of ["dragenter", "dragover", "drop"]) {
          target.addEventListener(t, claim);
        }
      }
      const hrefBefore = location.href;
      const dt = new DataTransfer();
      if (types.includes("Files")) {
        dt.items.add(new File(["shot"], "shot.png", { type: "image/png" }));
      }
      for (const type of types) {
        if (type !== "Files") dt.setData(type, "payload");
      }
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      // End the drag the way a UA does, so the guard takes its guidance down
      // instead of leaving it for the next case to trip over.
      window.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
      for (const t of ["dragover", "dragenter", "drop"]) {
        window.removeEventListener(t, probe, true);
      }
      return { seen, reached, hrefBefore, hrefAfter: location.href };
    };
    window.__plyWithElement = (html, own, types) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      const el = host.firstElementChild;
      document.body.appendChild(el);
      const result = window.__plyDropProbe(el, own, types);
      el.remove();
      return result;
    };
  });
  // QoL 1.168 block 8 (A2, Challenger H1): a toast that stays until
  // dismissed ("Updated to …") is put back, never dropped, by a newer one —
  // so closing the one on screen can show the next. Close them one by one,
  // letting the page draw the next between presses, until none is left.
  const closeAllToasts = async () => {
    for (let i = 0; i < 20; i++) {
      const closed = await page.evaluate(() => {
        const b = document.querySelector(".toast-dismiss");
        if (!b) return false;
        b.click();
        return true;
      });
      if (!closed) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const countToasts = (text) =>
    page.evaluate(
      (t) =>
        [...document.querySelectorAll(".toast-title")].filter(
          (el) => el.textContent === t,
        ).length,
      text,
    );
  const allPrevented = (result) =>
    result.seen.length > 0 && result.seen.every((r) => r.prevented);
  const nonePrevented = (result) =>
    result.seen.length > 0 && result.seen.every((r) => !r.prevented);

  let dropGuardStage = "drop a file on document.body";
  try {
    const unclaimed = await page.evaluate(() =>
      window.__plyDropProbe(document.body, null, ["Files"]),
    );
    if (!allPrevented(unclaimed))
      throw new Error(
        `not every drag event was cancelled: ${JSON.stringify(unclaimed.seen)}`,
      );
    if (unclaimed.hrefAfter !== unclaimed.hrefBefore)
      throw new Error(
        `location changed: ${unclaimed.hrefBefore} -> ${unclaimed.hrefAfter}`,
      );

    dropGuardStage = "observe the guidance while the drag is over open ground";
    // The guidance is raised while the drag is over ground that will refuse
    // it, and taken down when the drag is claimed or ends — so it is on
    // screen at the release rather than expiring under the user's hand. One
    // at a time, never a stack. GH #296: one toast on screen at a time, so
    // the rejected releases above are dismissed first and the count
    // starts from nothing. QoL 1.168 block 8 (A2): an info waits behind a
    // warn or an error, so closing one may show the next — close until none.
    await closeAllToasts();
    await page.waitForFunction(() => document.querySelectorAll(".toast").length === 0, {
      timeout: 3000,
    });
    const baseline = 0;
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["shot"], "shot.png", { type: "image/png" }));
      window.__plyHoverTransfer = dt;
      window.__plyHoverFire = (type) =>
        document.body.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: window.__plyHoverTransfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      window.__plyHoverFire("dragenter");
    });
    await page.waitForFunction(
      (text, want) =>
        [...document.querySelectorAll(".toast-title")].filter(
          (el) => el.textContent === text,
        ).length === want,
      { timeout: 3000 },
      TOAST,
      baseline + 1,
    );
    await page.evaluate(() => {
      for (let i = 0; i < 20; i++) window.__plyHoverFire("dragover");
    });
    const whileHovering = (await countToasts(TOAST)) - baseline;
    if (whileHovering !== 1)
      throw new Error(
        `hovering raised ${whileHovering} messages — it must not accumulate`,
      );

    dropGuardStage = "leaving and re-entering does not raise it again";
    // GH #138 F5: the pointer crossing a real target, or leaving the window
    // entirely, is not a rejected release and is not a new gesture. One
    // gesture is told once.
    await page.evaluate(() => {
      window.__plyHoverFire("dragleave");
      window.__plyHoverFire("dragenter");
      window.__plyHoverFire("dragover");
    });
    const afterReentry = (await countToasts(TOAST)) - baseline;
    if (afterReentry > 1)
      throw new Error(
        `re-entering raised the guidance again: ${afterReentry} messages`,
      );

    dropGuardStage = "a delivered release over open ground is announced once";
    // The hover guidance goes with the drag, but a `drop` that really did
    // arrive is a release that happened here and was refused — nothing is
    // inferred, so it is said once in a message that outlives the gesture.
    await page.evaluate(() => {
      window.__plyHoverFire("drop");
      window.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 400));
    const afterRelease = (await countToasts(TOAST)) - baseline;
    if (afterRelease !== 1)
      throw new Error(
        `the rejected release left ${afterRelease} messages, expected 1`,
      );

    dropGuardStage = "drop a file on a zone that accepts text only";
    // The zone matches, but not for this payload: the guard must still take
    // it. This is the hole a selector-only registry would leave open.
    const wrongPayload = await page.evaluate(() =>
      window.__plyWithElement(
        '<div data-drop-zone="smoke" data-drop-accepts="text"></div>',
        false,
        ["Files"],
      ),
    );
    if (!allPrevented(wrongPayload))
      throw new Error("a zone claimed a payload it does not accept");

    dropGuardStage = "drop a file on an ordinary textarea";
    // …but a file is not something a text field inserts, and the webview's
    // navigation default is still behind it.
    const fileOnField = await page.evaluate(() =>
      window.__plyWithElement("<textarea></textarea>", null, ["Files"]),
    );
    if (!allPrevented(fileOnField))
      throw new Error("a file drop on a textarea was left to the webview");

    dropGuardStage = "drop a Finder file, text twin and all, on a textarea";
    // What a Finder file really arrives as. Claiming it because the field
    // takes one of the twins leaves the file consumed by nobody.
    const mixedOnField = await page.evaluate(() =>
      window.__plyWithElement("<textarea></textarea>", null, [
        "Files",
        "text/uri-list",
        "text/plain",
      ]),
    );
    if (!allPrevented(mixedOnField))
      throw new Error(
        "a file that also carried text/plain was exempted by the text rule",
      );

    dropGuardStage = "drop a mixed file payload on a zone that accepts text";
    const mixedOnTextZone = await page.evaluate(() =>
      window.__plyWithElement(
        '<div data-drop-zone="smoke" data-drop-accepts="text uri"></div>',
        false,
        ["Files", "text/uri-list", "text/plain"],
      ),
    );
    if (!allPrevented(mixedOnTextZone))
      throw new Error("a text zone claimed a file that rode in with a twin");

    dropGuardStage = "drop web-page text, HTML twin and all, on a textarea";
    // GH #138 F14: dragging selected text out of a web page carries
    // text/html beside text/plain. The HTML must not veto the text.
    for (const types of [
      ["text/html", "text/plain"],
      ["text/html", "text/uri-list", "text/plain"],
    ]) {
      const rich = await page.evaluate(
        (t) => window.__plyWithElement("<textarea></textarea>", null, t),
        types,
      );
      if (!nonePrevented(rich))
        throw new Error(`the guard refused rich text (${types.join(", ")})`);
    }

    dropGuardStage = "drop URI-only and HTML-only payloads on a text zone";
    // A declaration must match what the handler consumes: a zone that reads
    // text/plain does not get a URL list or HTML handed to it in silence.
    for (const types of [["text/uri-list"], ["text/html"]]) {
      const unread = await page.evaluate(
        (t) =>
          window.__plyWithElement(
            '<div data-drop-zone="smoke" data-drop-accepts="text"></div>',
            false,
            t,
          ),
        types,
      );
      if (!allPrevented(unread))
        throw new Error(`${types[0]} was claimed by a zone that only reads text`);
    }

    dropGuardStage = "drop text on a readonly and a disabled field";
    for (const html of [
      "<textarea readonly></textarea>",
      "<textarea disabled></textarea>",
      '<input type="text" readonly>',
      '<input type="text" disabled>',
    ]) {
      const inert = await page.evaluate(
        (markup) => window.__plyWithElement(markup, null, ["text/plain"]),
        html,
      );
      if (!allPrevented(inert))
        throw new Error(`${html} was exempted although it inserts nothing`);
    }

    dropGuardStage = "drop a file on a descendant that only stops propagation";
    // Capture is what makes this safe: the guard has already cancelled by the
    // time a descendant gets the event, so stopPropagation cannot bypass it.
    const stopped = await page.evaluate(() =>
      window.__plyWithElement("<div></div>", "stop-only", ["Files"]),
    );
    if (stopped.reached !== 3)
      throw new Error(
        `the descendant's handlers ran ${stopped.reached} times, expected 3`,
      );
    if (!allPrevented(stopped))
      throw new Error(
        "a descendant that stopped propagation without cancelling got past the guard",
      );

    // Everything from here on is a drag a real target owns. The guard must
    // leave all of it alone and say nothing about any of it, so the toast
    // count is taken once before and once after rather than per case — the
    // rate limit on the guidance must not be what makes this pass.
    dropGuardStage = "count the guidance before the claimed drops";
    const toastsBefore = await countToasts(TOAST);

    dropGuardStage = "drop a file on a zone that accepts files";
    const zoned = await page.evaluate(() =>
      window.__plyWithElement(
        '<div data-drop-zone="smoke" data-drop-accepts="files"></div>',
        false,
        ["Files"],
      ),
    );
    if (zoned.reached !== 3)
      throw new Error(
        `the zone's own handlers ran ${zoned.reached} times, expected 3`,
      );
    if (!nonePrevented(zoned))
      throw new Error("the guard took a drop its own registry accepts");

    dropGuardStage = "drop text on an ordinary textarea";
    // Native text insertion must survive, or text drag-and-drop dies in every
    // field in the app.
    const textOnField = await page.evaluate(() =>
      window.__plyWithElement("<textarea></textarea>", null, ["text/plain"]),
    );
    if (!nonePrevented(textOnField))
      throw new Error("the guard refused a textarea's own text drop");

    dropGuardStage = "drop a URL on a zone that accepts URLs";
    const uriOnUriZone = await page.evaluate(() =>
      window.__plyWithElement(
        '<div data-drop-zone="smoke" data-drop-accepts="uri text"></div>',
        false,
        ["text/uri-list", "text/plain"],
      ),
    );
    if (!nonePrevented(uriOnUriZone))
      throw new Error("the guard took a URL from a zone that reads URLs");

    dropGuardStage = "drop a file on a target that claims with preventDefault";
    const owned = await page.evaluate(() =>
      window.__plyWithElement(
        '<div data-drop-zone="smoke" data-drop-accepts="files"></div>',
        true,
        ["Files"],
      ),
    );
    if (owned.reached !== 3)
      throw new Error(
        `the claiming target's handlers ran ${owned.reached} times, expected 3`,
      );

    dropGuardStage = "confirm the claimed drops raised no guidance";
    const toastsAfter = await countToasts(TOAST);
    if (toastsAfter !== toastsBefore)
      throw new Error(
        `a claimed drop raised guidance: ${toastsBefore} -> ${toastsAfter}`,
      );
  } catch (error) {
    errors.push(`Drop guard failed at ${dropGuardStage}: ${error.message}`);
  }
  // Getting started TU-4 (TUTORIAL_SPEC §3, §15 TU-4 acceptance): opening and
  // closing the Guide panel never unmounts a host, so terminals keep their
  // scrollback and the editor keeps its view. Every warmed host on the page
  // — the Terminals stack and its per-workspace host, the card host, Code's
  // sticky host with its CodeMirror view, any xterm — is tagged before the
  // tour opens, and must be the very same node after each of: Help › Getting
  // started, Start (the coach-mark on the Board row), Pause (no pill since
  // 1.174.0: the sidebar row), Resume, and ⋯ › End the tour. The tour's surfaces are never modal.
  let tourStage = "open Code so its sticky host and editor mount";
  try {
    await closeAllToasts();
    await page.evaluate(() => {
      document.querySelector('[data-ply-tour="nav-code"]')?.click();
    });
    await page.waitForFunction(
      () => document.querySelector(".center-mode-sticky:not(.hidden)") != null,
      { timeout: 3000 },
    );
    tourStage = "tag the hosts";
    const tagged = await page.evaluate(() => {
      const hosts = [
        ...document.querySelectorAll(
          ".tile-grid-host, .center-mode-host, .center-card-host, .cm-editor, .xterm",
        ),
      ].filter((el) => !el.closest(".center-mode-board"));
      window.__plyTourHosts = hosts;
      return hosts.map((el) => el.className.split(" ")[0]);
    });
    for (const kind of ["tile-grid-host", "center-mode-host", "center-card-host"]) {
      if (!tagged.includes(kind)) throw new Error(`no ${kind} on the page to watch (${tagged.join(", ")})`);
    }
    const hostsKept = async (when) => {
      const lost = await page.evaluate(() =>
        window.__plyTourHosts.filter((el) => !el.isConnected).map((el) => el.className),
      );
      if (lost.length > 0) throw new Error(`${when} unmounted ${lost.join(" | ")}`);
    };
    const press = (selector, text) =>
      page.evaluate(
        (sel, t) => {
          const el = [...document.querySelectorAll(sel)].find(
            (b) => t == null || b.textContent?.trim() === t,
          );
          el?.click();
          return Boolean(el);
        },
        selector,
        text,
      );

    tourStage = "Help › Getting started";
    if (!(await press('[data-ply-tour="help"]'))) throw new Error("no Help button in the sidebar");
    await page.waitForSelector('[role="menu"][aria-label="Help"]', { timeout: 3000 });
    if (!(await press('[role="menu"][aria-label="Help"] [role="menuitem"]', "Getting started")))
      throw new Error("no Getting started in the Help menu");
    await page.waitForSelector("[data-ply-tour-panel]", { timeout: 3000 });
    const modal = await page.evaluate(() => {
      const panel = document.querySelector("[data-ply-tour-panel]");
      return panel.getAttribute("role") !== "region" || panel.closest('[aria-modal="true"]') != null;
    });
    if (modal) throw new Error("the Guide panel is not a plain region");
    await hostsKept("opening the panel");

    tourStage = "Start: the coach-mark on the Board row";
    if (!(await press("[data-ply-tour-panel] button", "Start"))) throw new Error("no Start on B1");
    await page.waitForSelector('[data-ply-tour-coach="nav-board"]', { timeout: 3000 });
    const coach = await page.evaluate(() => {
      const el = document.querySelector('[data-ply-tour-coach="nav-board"]');
      const row = document.querySelector('[data-ply-tour="nav-board"]');
      return {
        modal: el.getAttribute("aria-modal"),
        described: (row.getAttribute("aria-describedby") ?? "").includes(el.getAttribute("aria-describedby")),
        focusInside: el.contains(document.activeElement),
      };
    });
    if (coach.modal !== "false") throw new Error(`the coach-mark is aria-modal=${coach.modal}`);
    if (!coach.described) throw new Error("the Board row does not name the coach-mark's words");
    if (coach.focusInside) throw new Error("the coach-mark took the focus on appear");
    await hostsKept("the coach-mark");

    tourStage = "Pause: no pill, the sidebar row's Resume";
    if (!(await press("[data-ply-tour-panel] button", "Pause"))) throw new Error("no Pause");
    await page.waitForFunction(() => !document.querySelector("[data-ply-tour-panel], [data-ply-tour-coach]"), {
      timeout: 3000,
    });
    // The tour's own row, whose text starts with "Getting started" (another
    // row may say Resume too).
    await page.waitForFunction(
      () => {
        const row = [...document.querySelectorAll(".shell-status")].find((r) =>
          r.textContent?.trim().startsWith("Getting started"),
        );
        const active = document.activeElement;
        return row != null && row.contains(active) && active?.matches(".shell-status-action") && active.textContent?.trim() === "Resume";
      },
      { timeout: 3000 },
    );
    if (await page.evaluate(() => document.querySelector(".ux-tour-pill") != null)) throw new Error("a pill after Pause");
    await hostsKept("closing the panel (Pause)");

    tourStage = "Resume: the panel again";
    const resumed = await page.evaluate(() => {
      const row = [...document.querySelectorAll(".shell-status")].find((r) =>
        r.textContent?.trim().startsWith("Getting started"),
      );
      const button = row?.querySelector(".shell-status-action");
      if (!button || button.textContent?.trim() !== "Resume") return false;
      button.click();
      return true;
    });
    if (!resumed) throw new Error("no Resume on the sidebar's Getting started row");
    await page.waitForSelector("[data-ply-tour-panel]", { timeout: 3000 });
    await hostsKept("reopening the panel (Resume)");

    tourStage = "⋯ › End the tour";
    if (!(await press('[data-ply-tour-panel] button[aria-label="More for Getting started"]')))
      throw new Error("no ⋯ on the panel");
    await page.waitForSelector('[role="menu"][aria-label="More for Getting started"]', { timeout: 3000 });
    if (!(await press('[role="menu"] [role="menuitem"]', "End the tour"))) throw new Error("no End the tour");
    await page.waitForFunction(
      () => !document.querySelector("[data-ply-tour-panel], [data-ply-tour-coach]"),
      { timeout: 3000 },
    );
    await hostsKept("ending the tour");
  } catch (error) {
    errors.push(`Tutorial panel failed at ${tourStage}: ${error.message}`);
  }
  // Hold the page open so any deferred infinite-loop has time to trip.
  await new Promise((r) => setTimeout(r, MOUNT_HOLD_MS));
} catch (err) {
  await browser.close();
  console.error(`infra: ${err.message}`);
  process.exit(2);
}

await browser.close();

// Distinguish "noise we don't care about" from "render-loop class" errors.
const fatal = errors.filter((e) => RELEVANT.some((r) => r.test(e)));

if (fatal.length > 0) {
  console.error(`Runtime smoke ✗ — ${fatal.length} React error(s):`);
  for (const e of fatal) console.error(`  • ${e}`);
  if (errors.length > fatal.length) {
    console.error("(other errors, not classified as fatal:)");
    for (const e of errors)
      if (!fatal.includes(e)) console.error(`  · ${e}`);
  }
  process.exit(1);
}

if (errors.length > 0) {
  // Non-fatal noise — print but still pass
  console.log(`Runtime smoke ✓ (${errors.length} non-React errors observed)`);
  for (const e of errors) console.log(`  · ${e}`);
} else {
  console.log("Runtime smoke ✓ (no errors after 3s mount)");
}
process.exit(0);
