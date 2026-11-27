// node scripts/ux-audit/build.mjs [--out <dir>] — builds the real frontend with the harness entry into <out>/dist
import { createRequire } from "node:module";
import { config, ROOT } from "./vite.harness.config.mjs";
const req = createRequire(ROOT + "/package.json");
const vite = await import(req.resolve("vite"));
await vite.build(config);
console.log("harness build done");
