// W5: which platform the shell is on, the shortcut modifier, how a chord is
// drawn and the words that name the machine.
// Run with Node 22+:  node --experimental-strip-types src/lib/platform.test.ts
import assert from "node:assert/strict";
import {
  detectPlatform,
  formatKeys,
  installCommand,
  isMac,
  isQuitChord,
  isWindows,
  machineWords,
  mod,
  modOnly,
  platform,
  platformWord,
  setPlatformForTests,
  windowDragRegion,
} from "./platform.ts";

// Detection: WebView2 says Windows; WKWebView and every test host is the Mac.
{
  const webview2 =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0";
  const wkwebview = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  assert.equal(detectPlatform({ userAgent: webview2, platform: "Win32" }), "windows");
  assert.equal(detectPlatform({ userAgent: webview2 }), "windows");
  assert.equal(detectPlatform({ userAgentData: { platform: "Windows" } }), "windows");
  assert.equal(detectPlatform({ userAgent: wkwebview, platform: "MacIntel" }), "mac");
  // Test hosts on Windows: node 21+ says "Win32" as its platform, jsdom puts
  // "(win32)" in its user agent. Neither is a browser saying Windows.
  assert.equal(detectPlatform({ platform: "Win32", userAgent: "Node.js/24" }), "mac");
  assert.equal(detectPlatform({ platform: "Win32" }), "mac");
  assert.equal(
    detectPlatform({ userAgent: "Mozilla/5.0 (win32) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/25.0.1" }),
    "mac",
  );
  assert.equal(
    detectPlatform({ userAgent: "Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/25.0.1" }),
    "mac",
  );
  assert.equal(detectPlatform({ userAgent: "Node.js/24" }), "mac");
  assert.equal(detectPlatform(null), "mac");
}

// Under a test host the platform is the Mac, and a test can force either.
{
  assert.equal(platform(), "mac");
  assert.ok(isMac() && !isWindows());
  setPlatformForTests("windows");
  try {
    assert.ok(isWindows() && !isMac());
  } finally {
    setPlatformForTests(null);
  }
  assert.equal(platform(), "mac");
}

// The modifier: ⌘ on the Mac, Ctrl (without the Windows key) on Windows.
{
  const k = (m: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...m,
  });
  assert.equal(mod(k({ metaKey: true })), true);
  assert.equal(mod(k({ ctrlKey: true })), false);
  assert.equal(modOnly(k({ metaKey: true })), true);
  assert.equal(modOnly(k({ metaKey: true, ctrlKey: true })), false);
  assert.equal(modOnly(k({ metaKey: true, shiftKey: true })), false);
  setPlatformForTests("windows");
  try {
    assert.equal(mod(k({ ctrlKey: true })), true);
    assert.equal(mod(k({ metaKey: true })), false);
    assert.equal(mod(k({ ctrlKey: true, metaKey: true })), false);
    assert.equal(modOnly(k({ ctrlKey: true })), true);
    assert.equal(modOnly(k({ ctrlKey: true, altKey: true })), false);
    assert.equal(modOnly(k({ ctrlKey: true, shiftKey: true })), false);
  } finally {
    setPlatformForTests(null);
  }
}

// Drawing a chord: the Mac's glyphs as written; Windows spells them out.
{
  for (const keys of ["⌘K", "⌘⇧F", "⌘⌥1", "/ or ⌘F", "⌘\\", "⌘1–9", "Esc", "F2"]) {
    assert.equal(formatKeys(keys, "mac"), keys);
  }
  assert.equal(formatKeys("⌘K", "windows"), "Ctrl+K");
  assert.equal(formatKeys("⌘⇧F", "windows"), "Ctrl+Shift+F");
  assert.equal(formatKeys("⌘⌥1", "windows"), "Ctrl+Alt+1");
  assert.equal(formatKeys("⇧⌥⌘K", "windows"), "Ctrl+Alt+Shift+K", "Windows' own order");
  assert.equal(formatKeys("⌘1–9", "windows"), "Ctrl+1–9");
  assert.equal(formatKeys("⌘\\", "windows"), "Ctrl+\\");
  assert.equal(formatKeys("⌘,", "windows"), "Ctrl+,");
  assert.equal(formatKeys("/ or ⌘F", "windows"), "/ or Ctrl+F");
  assert.equal(formatKeys("Esc", "windows"), "Esc");
  assert.equal(
    formatKeys("⌘T opens this kind. ⌘⇧T always opens Claude, ⌘⇧X Codex.", "windows"),
    "Ctrl+T opens this kind. Ctrl+Shift+T always opens Claude, Ctrl+Shift+X Codex.",
  );
  assert.equal(formatKeys("Save (⌘S) to recreate it.", "windows"), "Save (Ctrl+S) to recreate it.");
  // The default follows the platform.
  assert.equal(formatKeys("⌘K"), "⌘K");
  setPlatformForTests("windows");
  try {
    assert.equal(formatKeys("⌘K"), "Ctrl+K");
  } finally {
    setPlatformForTests(null);
  }
}

// The words for the machine.
{
  assert.equal(platformWord("reveal", "mac"), "Reveal in Finder");
  assert.equal(platformWord("showIn", "mac"), "Show in Finder");
  assert.equal(platformWord("fileManager", "mac"), "Finder");
  assert.equal(platformWord("thisMachine", "mac"), "This Mac");
  assert.equal(platformWord("reveal", "windows"), "Show in File Explorer");
  assert.equal(platformWord("showIn", "windows"), "Show in File Explorer");
  assert.equal(platformWord("fileManager", "windows"), "File Explorer");
  assert.equal(platformWord("thisMachine", "windows"), "This PC");
  assert.equal(platformWord("thisMachine"), "This Mac");
}

// A sentence written for the Mac, on Windows.
{
  const said = [
    "Reset all settings on this Mac",
    "This Mac keeps them locally.",
    "3 on this Mac. Other Macs decide for themselves.",
    "Claude and Codex on other Macs load it.",
    "A macOS notification when a run finishes.",
    "Diagnostics holds the Mac-wide one.",
    "the key this Mac's account holds",
    "Plyloft drives command-line tools already on your Mac.",
  ];
  for (const s of said) assert.equal(machineWords(s, "mac"), s, "the Mac's words as written");
  assert.deepEqual(
    said.map((s) => machineWords(s, "windows")),
    [
      "Reset all settings on this PC",
      "This PC keeps them locally.",
      "3 on this PC. Other PCs decide for themselves.",
      "Claude and Codex on other PCs load it.",
      "A Windows notification when a run finishes.",
      "Diagnostics holds the PC-wide one.",
      "the key this PC's account holds",
      "Plyloft drives command-line tools already on your PC.",
    ],
  );
  // The Library's and Settings' other ways of naming the machine.
  assert.deepEqual(
    [
      "3 · switched on per Mac",
      "Comes with Plyloft, and switched on per Mac.",
      "Everyone on your team can read it, and every Mac gets it at its next refresh.",
      "once their Mac reads the team again",
      "Each Mac decides.",
      "on the Mac that starts the card",
    ].map((s) => machineWords(s, "windows")),
    [
      "3 · switched on per PC",
      "Comes with Plyloft, and switched on per PC.",
      "Everyone on your team can read it, and every PC gets it at its next refresh.",
      "once their PC reads the team again",
      "Each PC decides.",
      "on the PC that starts the card",
    ],
  );
  assert.equal(machineWords("switched on per Mac", "mac"), "switched on per Mac");
  // 1.173.0 (C2): "your other Mac" (a card's claim, a failed take-over).
  assert.equal(machineWords("On your other Mac", "windows"), "On your other PC");
  assert.equal(
    machineWords("The card is still marked as being built on your other Mac. Check the connection and try again.", "windows"),
    "The card is still marked as being built on your other PC. Check the connection and try again.",
  );
  assert.equal(machineWords("Other Mac", "windows"), "Other PC");
  assert.equal(machineWords("the other Mac mini", "windows"), "the other Mac mini", "hardware named stays");
  assert.equal(machineWords("On your other Mac", "mac"), "On your other Mac");
  assert.equal(
    machineWords("Builds on this Mac mini, every Mac mini and your Mac mini stay.", "windows"),
    "Builds on this Mac mini, every Mac mini and your Mac mini stay.",
  );
  assert.equal(machineWords("Macintosh and MacBook stay", "windows"), "Macintosh and MacBook stay");
  assert.equal(machineWords("on this Mac"), "on this Mac", "the default is the platform");
}

// An install hint names the platform's own installer, or none.
{
  assert.equal(installCommand("rg", "mac"), "brew install ripgrep");
  assert.equal(installCommand("rg", "windows"), "winget install --id BurntSushi.ripgrep.MSVC");
  assert.equal(installCommand("codex", "mac"), "curl -fsSL https://chatgpt.com/codex/install.sh | sh");
  assert.equal(installCommand("codex", "windows"), "irm https://chatgpt.com/codex/install.ps1 | iex");
  assert.equal(installCommand("bash", "mac"), "brew install bash");
  assert.equal(installCommand("bash", "windows"), null);
  assert.equal(installCommand("whisper", "mac"), "brew install whisper.cpp");
  assert.equal(installCommand("whisper", "windows"), null);
  assert.equal(installCommand("rg"), "brew install ripgrep", "the default is the platform");
}

// W4: the window. The Mac drags from the page's top edge; Windows has its
// own title bar.
{
  assert.equal(windowDragRegion("mac"), "deep");
  assert.equal(windowDragRegion("windows"), undefined);
  assert.equal(windowDragRegion(), "deep", "the default is the platform");
}

// W4: Ctrl+Shift+Q quits on Windows only, by physical key.
{
  const q = { code: "KeyQ", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
  assert.equal(isQuitChord(q, "windows"), true);
  assert.equal(isQuitChord(q, "mac"), false, "never on the Mac");
  assert.equal(isQuitChord({ ...q, shiftKey: false }, "windows"), false, "Ctrl+Q is the terminal's");
  assert.equal(isQuitChord({ ...q, altKey: true }, "windows"), false, "AltGr is a character");
  assert.equal(isQuitChord({ ...q, metaKey: true }, "windows"), false);
  assert.equal(isQuitChord({ ...q, code: "KeyA" }, "windows"), false);
  assert.equal(isQuitChord(q), false, "the default is the platform");
}

console.log("platform: all assertions passed");
