// Unit tests for the Try session's address scanner (src/lib/tryAddress.ts,
// Try it TI-3, docs/try-it/TRY_IT_SPEC.md §4.2 and §7).
//
// Run: node --experimental-strip-types src/lib/tryAddress.test.ts

import {
  AnsiStripper,
  TryAddressScanner,
  cardPortList,
  isLoopbackAddress,
  loopbackUrl,
  portOfAddress,
  scanTryOutput,
} from "./tryAddress.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

function eq(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`expected ${b}, got ${a}`);
}

const ESC = "\x1b";
const addr = (text: string) => scanTryOutput(text).address;

// ── Dev servers as they print ────────────────────────

it("Vite", () => {
  const out =
    `\r\n  ${ESC}[32m${ESC}[1mVITE${ESC}[22m v5.4.2${ESC}[39m  ${ESC}[2mready in ${ESC}[0m${ESC}[1m312${ESC}[22m${ESC}[2m${ESC}[0m ms${ESC}[22m\r\n\r\n` +
    `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m\r\n` +
    `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mNetwork${ESC}[22m${ESC}[2m: use ${ESC}[22m${ESC}[1m--host${ESC}[22m${ESC}[2m to expose${ESC}[22m\r\n`;
  eq(addr(out), "http://localhost:5173/");
});

it("Vite, plain", () => {
  eq(addr("  ➜  Local:   http://localhost:5173/\n"), "http://localhost:5173/");
});

it("Next", () => {
  eq(
    addr("  ▲ Next.js 14.2.3\n   - Local:        http://localhost:3000\n   - Environments: .env\n"),
    "http://localhost:3000",
  );
});

it("Astro", () => {
  eq(
    addr(" astro  v4.15.0 ready in 210 ms\n\n┃ Local    http://localhost:4321/\n┃ Network  use --host to expose\n"),
    "http://localhost:4321/",
  );
});

it("Create React App", () => {
  eq(
    addr(
      "Compiled successfully!\n\nYou can now view my-app in the browser.\n\n  Local:            http://localhost:3000\n  On Your Network:  http://192.168.1.4:3000\n",
    ),
    "http://localhost:3000",
  );
});

it("Django", () => {
  eq(
    addr("Django version 5.0, using settings 'app.settings'\nStarting development server at http://127.0.0.1:8000/\nQuit the server with CONTROL-C.\n"),
    "http://127.0.0.1:8000/",
  );
});

it("Rails / Puma", () => {
  eq(
    addr("Puma starting in single mode...\n* Listening on http://127.0.0.1:3000\n* Listening on http://[::1]:3000\nUse Ctrl-C to stop\n"),
    "http://127.0.0.1:3000",
  );
});

it("Flask", () => {
  eq(
    addr(" * Debug mode: on\nWARNING: This is a development server.\n * Running on http://127.0.0.1:5000\nPress CTRL+C to quit\n"),
    "http://127.0.0.1:5000",
  );
});

it("Hugo, with its path", () => {
  eq(
    addr("Built in 41 ms\nWeb Server is available at http://localhost:1313/blog/ (bind address 127.0.0.1)\nPress Ctrl+C to stop\n"),
    "http://localhost:1313/blog/",
  );
});

it("[::1] alone", () => {
  eq(addr("Listening on http://[::1]:8080\n"), "http://[::1]:8080");
});

it("0.0.0.0 opens as localhost", () => {
  eq(addr("Server listening on http://0.0.0.0:8000/app\n"), "http://localhost:8000/app");
});

it("a full stop after the address is not part of it", () => {
  eq(addr("Open http://localhost:4000/docs. Have fun\n"), "http://localhost:4000/docs");
});

it("the first address wins", () => {
  eq(addr("http://localhost:41003/\nhttp://localhost:5173/\n"), "http://localhost:41003/");
});

it("a remote address is not the app's", () => {
  eq(addr("Docs at http://example.com:80/ and http://192.168.1.4:3000\n"), null);
  eq(addr("Bound to http://127.0.0.999:3000\n"), null);
});

it("https is kept, and said", () => {
  const r = scanTryOutput("  ➜  Local:   https://localhost:5173/\n");
  eq([r.address, r.secure], ["https://localhost:5173/", true]);
  eq(scanTryOutput("  ➜  Local:   http://localhost:5173/\n").secure, false);
});

it("another loopback address in 127/8 counts", () => {
  eq(addr("Running on http://127.0.1.1:5000\n"), "http://127.0.1.1:5000");
});

// ── Ranking: the app's own address, not the first one printed ──

it("a proxy line printed before Vite's Local: is never taken", () => {
  const out =
    "[vite] proxy /api -> http://localhost:4000\n" +
    "  /graphql → http://127.0.0.1:4001/graphql\n" +
    "  ➜  Local:   http://localhost:5173/\n";
  eq(addr(out), "http://localhost:5173/");
});

it("an arrow after the address does not make it a proxy line", () => {
  eq(addr("Listening on http://localhost:3000 → open it\n"), "http://localhost:3000");
  eq(addr("Server ready at http://localhost:3000 (proxy for /api on 4000)\n"), "http://localhost:3000");
});

it("an API listening on :4000 before Vite's Local: loses to Local", () => {
  const out =
    "[api] Server listening on http://localhost:4000\n" +
    "[web]   ➜  Local:   http://localhost:5173/\n";
  eq(addr(out), "http://localhost:5173/");
});

it("an unlabelled address is tentative until a labelled one", () => {
  const s = new TryAddressScanner();
  const first = s.feed("Fetching schema from http://localhost:8080/schema\n");
  eq([first.address, first.confident], ["http://localhost:8080/schema", false]);
  const then = s.feed("Ready on http://localhost:3000\n");
  eq([then.address, then.confident], ["http://localhost:3000", true]);
});

it("the label is the words before the address, not after", () => {
  eq(addr("http://localhost:9229 (inspector, not local)\nListening on http://localhost:3000\n"), "http://localhost:3000");
});

it("an address in the card's block beats a labelled one elsewhere", () => {
  const out = "  ➜  Local:   http://localhost:5173/\nserver at http://localhost:41003\n";
  eq(scanTryOutput(out, { portBlock: cardPortList(41000) }).address, "http://localhost:41003");
  // The control: without the block, Local wins.
  eq(scanTryOutput(out).address, "http://localhost:5173/");
});

it("a port out of range is no address", () => {
  eq(addr("http://localhost:99999/\n"), null);
});

// ── Chunks split anywhere ────────────────────────────

it("ANSI codes inside the URL", () => {
  eq(
    addr(`Local: ${ESC}[36mhttp://local${ESC}[1mhost:${ESC}[22m51${ESC}[0m73/${ESC}[39m\r\n`),
    "http://localhost:5173/",
  );
});

it("an OSC 8 hyperlink around the URL", () => {
  eq(
    addr(`Local: ${ESC}]8;;http://localhost:5173/${ESC}\\http://localhost:5173/${ESC}]8;;${ESC}\\\n`),
    "http://localhost:5173/",
  );
});

it("a URL split across two chunks", () => {
  const s = new TryAddressScanner();
  eq(s.feed("  ➜  Local:   http://localhost:51").address, null);
  eq(s.feed("73/\r\n").address, "http://localhost:5173/");
});

it("an escape sequence split across chunks", () => {
  const s = new TryAddressScanner();
  eq(s.feed(`Local: ${ESC}`).address, null);
  eq(s.feed("[3").address, null);
  eq(s.feed("6mhttp://localhost:3000").address, null);
  eq(s.feed(`${ESC}[39m\n`).address, "http://localhost:3000");
});

it("every split of a Vite stream finds the same address", () => {
  const out = `  ${ESC}[32m➜${ESC}[39m  Local:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m\r\n`;
  for (let i = 0; i <= out.length; i++) {
    const s = new TryAddressScanner();
    s.feed(out.slice(0, i));
    const r = s.feed(out.slice(i));
    if (r.address !== "http://localhost:5173/") throw new Error(`split at ${i}: ${r.address}`);
  }
});

it("an unfinished line gives its address once something ends it", () => {
  const s = new TryAddressScanner();
  eq(s.feed("Ready on http://localhost:3000").address, null);
  eq(s.feed(" (press q)").address, "http://localhost:3000");
});

it("flush judges the last line", () => {
  const s = new TryAddressScanner();
  s.feed("Ready on http://localhost:3000");
  eq(s.flush().address, "http://localhost:3000");
});

it("a Windows \\r\\n stream", () => {
  eq(
    addr("\r\n> app@1.0.0 dev\r\n> vite\r\n\r\n\r\n  VITE v5.4.2  ready in 401 ms\r\n\r\n  ➜  Local:   http://localhost:5173/\r\n"),
    "http://localhost:5173/",
  );
});

it("no URL at all", () => {
  const r = scanTryOutput("> app@1.0.0 dev\n> node build.js\nBuilt 14 files.\nWatching for changes…\n");
  eq(r, { address: null, secure: false, confident: false, scriptsBlocked: false });
});

it("a ConPTY repaint: cursor moves for newlines and spaces", () => {
  const out =
    `${ESC}[?25l${ESC}[1;1H  VITE v5.4.2  ready in 401 ms${ESC}[K` +
    `${ESC}[3;3H➜${ESC}[2CLocal:${ESC}[3Chttp://localhost:5173/${ESC}[K` +
    `${ESC}[4;3H➜${ESC}[2CNetwork: use --host to expose${ESC}[K${ESC}[?25h`;
  eq(addr(out), "http://localhost:5173/");
  // Without the moves read as breaks, two lines would run into one.
  const s = new TryAddressScanner();
  s.feed(`${ESC}[1;1Hfoo http://localhost:3000${ESC}[2;1Hbar`);
  eq(s.current().address, "http://localhost:3000");
});

// ── Windows: PowerShell refuses npm.ps1 (spec §7) ────

it("the PowerShell execution-policy error is its own signal", () => {
  const out =
    "npm : File C:\\Program Files\\nodejs\\npm.ps1 cannot be loaded because running scripts is disabled on this\r\n" +
    "system. For more information, see about_Execution_Policies at https:/go.microsoft.com/fwlink/?LinkID=135170.\r\n";
  // PowerShell wraps the sentence at the console width.
  eq(scanTryOutput(out).scriptsBlocked, true);
  const oneLine =
    `${ESC}[31;1mnpm : File C:\\Program Files\\nodejs\\npm.ps1 cannot be loaded because running scripts is disabled on this system. For more information, see about_Execution_Policies.${ESC}[0m\r\n`;
  eq(scanTryOutput(oneLine).scriptsBlocked, true);
});

it("the policy error wrapped by ConPTY in the middle of a word", () => {
  const out =
    "npm : File C:\\Program Files\\nodejs\\npm.ps1 cannot be loaded because running scripts is disab\r\n" +
    "led on this system. For more information, see about_Execution_Policies.\r\n";
  eq(scanTryOutput(out).scriptsBlocked, true);
});

it("the policy error in another language, by its invariant tokens", () => {
  // German PowerShell: the sentence differs, the tokens do not.
  const out =
    "npm : Die Datei \"C:\\Program Files\\nodejs\\npm.ps1\" kann nicht geladen werden, da die Ausführung von Skripts auf\r\n" +
    "diesem System deaktiviert ist.\r\n" +
    "In Zeile:1 Zeichen:1\r\n" +
    "+ npm run dev\r\n" +
    "    + CategoryInfo          : Sicherheitsfehler: (:) [], PSSecurityException\r\n" +
    "    + FullyQualifiedErrorId : UnauthorizedAccess\r\n";
  eq(scanTryOutput(out).scriptsBlocked, true);
});

it("the latest .ps1 line counts, not the first: a profile long before the error", () => {
  const out =
    "Loading personal and system profiles took 812ms.\r\n" +
    ". C:\\Users\\me\\Documents\\PowerShell\\profile.ps1\r\n" +
    "line\r\n".repeat(12) +
    "npm : Impossibile caricare il file C:\\Program Files\\nodejs\\npm.ps1. L'esecuzione di script è disabilitata nel sistema.\r\n" +
    "In riga:1 car:1\r\n" +
    "+ npm run dev\r\n" +
    "    + CategoryInfo          : Errore di protezione: (:) [], PSSecurityException\r\n" +
    "    + FullyQualifiedErrorId : UnauthorizedAccess\r\n";
  eq(scanTryOutput(out).scriptsBlocked, true);
});

it("a .ps1 alone, or a token far from it, is not the policy error", () => {
  eq(scanTryOutput("Running build.ps1\nDone.\n").scriptsBlocked, false);
  const far = "Running build.ps1\n" + "line\n".repeat(20) + "UnauthorizedAccess while reading cache\n";
  eq(scanTryOutput(far).scriptsBlocked, false);
});

it("a mere mention of scripts is not the policy error", () => {
  eq(scanTryOutput("running scripts\nis fine here\n").scriptsBlocked, false);
});

it("the policy error and an address are told apart", () => {
  const s = new TryAddressScanner();
  s.feed("pnpm : running scripts is disabled on this system.\r\n");
  const r = s.feed("Local: http://localhost:5173/\r\n");
  eq([r.address, r.scriptsBlocked], ["http://localhost:5173/", true]);
});

// ── The stripper and the helpers ─────────────────────

it("the stripper keeps text and drops CSI, OSC and charset selects", () => {
  const st = new AnsiStripper();
  eq(st.feed(`a${ESC}[1;31mb${ESC}]0;title\x07c${ESC}(Bd${ESC}[?25le`), "abcde");
});

it("portOfAddress", () => {
  eq(portOfAddress("http://localhost:5173/"), 5173);
  eq(portOfAddress("http://127.0.0.1:8000"), 8000);
  eq(portOfAddress("http://[::1]:3000/x"), 3000);
  eq(portOfAddress("http://localhost/"), null);
  eq(portOfAddress("not a url"), null);
});

it("cardPortList is the card's block of ten", () => {
  eq(cardPortList(41000), [41000, 41001, 41002, 41003, 41004, 41005, 41006, 41007, 41008, 41009]);
  eq(cardPortList(41000, 3), [41000, 41001, 41002]);
  eq(cardPortList(65534), [65534, 65535]);
  eq(cardPortList(0), []);
  eq(cardPortList(1020), [1024, 1025, 1026, 1027, 1028, 1029]);
});

it("loopbackUrl gives back the href the browser will load", () => {
  eq(loopbackUrl("http://localhost:5173"), "http://localhost:5173/");
  eq(loopbackUrl("  HTTP://LocalHost:3000/x  "), "http://localhost:3000/x");
  // A backslash is a slash to the URL parser: the host is localhost, the
  // "@evil.com" only a path — and the href says so.
  eq(loopbackUrl("http://localhost:3000\\@evil.com/"), "http://localhost:3000/@evil.com/");
  // The other way round, the host is evil.com: refused.
  eq(loopbackUrl("http://evil.com\\@localhost:3000/"), null);
});

it("isLoopbackAddress: localhost, 127/8 and ::1 only", () => {
  for (const ok of ["http://localhost:5173/", "https://localhost:3000", "http://127.0.0.1:8000", "http://127.5.6.7:1", "http://[::1]:3000/x"]) {
    if (!isLoopbackAddress(ok)) throw new Error(`refused ${ok}`);
  }
  for (const no of [
    "http://example.com/",
    "http://192.168.1.4:3000",
    "http://0.0.0.0:3000",
    "http://localhost.evil.com:3000",
    "http://user:pw@localhost:3000",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
  ]) {
    if (isLoopbackAddress(no)) throw new Error(`allowed ${no}`);
  }
});

console.log(`tryAddress: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
