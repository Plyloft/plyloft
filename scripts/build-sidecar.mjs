#!/usr/bin/env node
//
// Runs scripts/build-sidecar.sh with a bash that can run it, so Tauri's
// beforeBuildCommand/beforeDevCommand work from sh (macOS) and cmd (Windows).
// Arguments pass through unchanged.
//
// macOS/Linux: `bash` from PATH, what the script's shebang used.
// Windows: Git Bash (`<Git>\bin\bash.exe`, found above `git --exec-path` or
// under Program Files). Never a bare `bash`: Windows resolves that to
// System32's WSL launcher, another OS with another toolchain.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "build-sidecar.sh");

function gitBash() {
  const candidates = [];
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (git.status === 0 && git.stdout.trim()) {
    // <Git>\mingw64\libexec\git-core → <Git>\bin\bash.exe
    let dir = resolve(git.stdout.trim());
    for (let i = 0; i < 4; i += 1) {
      candidates.push(join(dir, "bin", "bash.exe"));
      dir = dirname(dir);
    }
  }
  for (const key of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
    if (process.env[key]) candidates.push(join(process.env[key], "Git", "bin", "bash.exe"));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }
  const windowsDir = (process.env.SystemRoot || "C:\\Windows").toLowerCase();
  return candidates.find(
    (bash) => !bash.toLowerCase().startsWith(windowsDir) && existsSync(bash),
  );
}

let bash = "bash";
let scriptArg = script;
if (process.platform === "win32") {
  bash = gitBash();
  if (!bash) {
    console.error("✗ building the ply-mcp sidecar needs Git Bash on Windows — install Git for Windows (git-scm.com)");
    process.exit(1);
  }
  // Bash reads backslashes as escapes.
  scriptArg = script.replaceAll("\\", "/");
}

const run = spawnSync(bash, [scriptArg, ...process.argv.slice(2)], { stdio: "inherit" });
if (run.error) {
  console.error(`✗ could not run ${bash}: ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
