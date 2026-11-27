// W5: what a shell tile runs and is started with, on the Mac and on Windows.
// Run with Node 22+:  node --experimental-strip-types src/lib/tileShell.test.ts
import assert from "node:assert/strict";
import { setPlatformForTests } from "./platform.ts";
import { fallbackTileShell, tileShellArgs, tileShellChoices } from "./tileShell.ts";

// The Mac, as it always was.
{
  assert.equal(fallbackTileShell(), "/bin/zsh");
  assert.deepEqual(tileShellChoices(), [
    "/bin/zsh",
    "/opt/homebrew/bin/bash",
    "/usr/local/bin/bash",
    "/opt/homebrew/bin/fish",
  ]);
  assert.deepEqual(tileShellArgs("/bin/zsh"), ["-l"]);
  assert.deepEqual(tileShellArgs("/opt/homebrew/bin/fish"), ["-l"]);
}

setPlatformForTests("windows");
try {
  assert.equal(fallbackTileShell(), "", "empty: the backend starts the platform's shell");
  assert.deepEqual(tileShellChoices(), ["pwsh", "powershell", "cmd"]);
  assert.deepEqual(tileShellArgs("pwsh"), []);
  assert.deepEqual(tileShellArgs("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), []);
  assert.deepEqual(tileShellArgs("cmd"), []);
  assert.deepEqual(tileShellArgs(""), []);
  assert.deepEqual(tileShellArgs("C:\\Program Files\\Git\\bin\\bash.exe"), ["-l"], "Git Bash is a login shell");
  assert.deepEqual(tileShellArgs("C:/msys64/usr/bin/zsh.exe"), ["-l"]);
} finally {
  setPlatformForTests(null);
}

console.log("tileShell: all assertions passed");
