// UX-8.5: Code's header shows the open file relative to the workspace.
import assert from "node:assert/strict";

import { pathCrumbs, relativeToWorkspace, sharedNameIds, switcherFolder } from "./workspacePath.ts";

const cwd = "/Users/someone/code/lyra";
assert.equal(relativeToWorkspace(`${cwd}/src/auth/redirect.ts`, cwd), "src/auth/redirect.ts");
assert.equal(relativeToWorkspace(`${cwd}/src/a.ts`, `${cwd}/`), "src/a.ts");
assert.equal(relativeToWorkspace("/Users/someone/code/lyra2/a.ts", cwd), null);
assert.equal(relativeToWorkspace(cwd, cwd), null);
assert.equal(relativeToWorkspace(`${cwd}/a.ts`, null), null);

assert.deepEqual(pathCrumbs(`${cwd}/src/auth/redirect.ts`, cwd), {
  folders: ["src", "auth"],
  name: "redirect.ts",
});
assert.deepEqual(pathCrumbs(`${cwd}/README.md`, cwd), { folders: [], name: "README.md" });
assert.deepEqual(pathCrumbs("/Library/Caches/ply/dropped/x-notes.txt", cwd), {
  folders: [],
  name: "x-notes.txt",
});

// 1.174.0 (TX2, T9): the folder line, only for names another workspace shares.
assert.deepEqual(
  [...sharedNameIds([
    { id: "a", name: "sandbox monorepo" },
    { id: "b", name: "sandbox monorepo " },
    { id: "c", name: "lyra" },
  ])].sort(),
  ["a", "b"],
);
assert.equal(sharedNameIds([{ id: "a", name: "lyra" }, { id: "b", name: "vega" }]).size, 0);
assert.equal(switcherFolder("/Users/someone/code/sandbox-monorepo", "/Users/someone", false), "~/code/sandbox-monorepo");
assert.equal(switcherFolder("/Users/someone/Desktop/sandbox-monorepo/", "/Users/someone", false), "~/Desktop/sandbox-monorepo");
assert.equal(switcherFolder("/Volumes/Work/sandbox-monorepo", "/Users/someone", false), "/Volumes/Work/sandbox-monorepo");
assert.equal(switcherFolder("/Users/someone/code/x", null, false), "/Users/someone/code/x");
assert.equal(switcherFolder("C:\\Users\\someone\\code\\sandbox-monorepo", "C:\\Users\\someone", true), "…\\code\\sandbox-monorepo");
assert.equal(switcherFolder("D:\\work\\sandbox-monorepo", "C:\\Users\\someone", true), "D:\\work\\sandbox-monorepo");

console.log("workspacePath: all assertions passed");
