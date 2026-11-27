// Windows port (W5): what a shell tile runs when nothing is chosen, the
// shells offered under the Tile shell field, and the arguments a shell is
// started with. Pure, so node can test it.

import { basename } from "./paths.ts";
import { isWindows } from "./platform.ts";

/** The Mac's shell when neither the tile, the setting nor the login shell
 *  names one. On Windows an empty command lets the backend start the
 *  platform's default shell. */
export function fallbackTileShell(): string {
  return isWindows() ? "" : "/bin/zsh";
}

/** The shells offered under the caret; anything else can be typed. */
export function tileShellChoices(): string[] {
  return isWindows()
    ? ["pwsh", "powershell", "cmd"]
    : ["/bin/zsh", "/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/fish"];
}

/** Every Mac shell starts as a login shell (`-l`), so it reads the profile
 *  the PATH lives in. On Windows only the POSIX shells take `-l` (Git Bash's
 *  bash, a zsh or fish); PowerShell and cmd would refuse or misread it. */
export function tileShellArgs(cmd: string): string[] {
  if (!isWindows()) return ["-l"];
  const name = basename(cmd).replace(/\.exe$/i, "").toLowerCase();
  return ["bash", "sh", "zsh", "fish"].includes(name) ? ["-l"] : [];
}
