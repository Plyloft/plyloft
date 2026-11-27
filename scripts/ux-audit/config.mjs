// Where the harness reads from and writes to. Shared by every harness module.
//
//   --state <dir> | PLY_STATE_DIR   a copy of Ply's app-support directory
//                                   (settings.json, workspaces.json,
//                                   kanban/workspaces/*.json, intake/transcripts).
//                                   Optional: without it a synthetic seed is used.
//                                   Real state is private — never copy it into the repo.
//   --out <dir>   | UX_AUDIT_OUT    output (shots/, results.json, INDEX.md, the
//                                   harness build in dist/). Default: <repo>/ux-audit-out
//                                   (gitignored).
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const HERE = here;
/** The repository the harness builds and serves: the one it lives in. */
export const REPO = path.resolve(here, "../..");

const argv = process.argv.slice(2);
export const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
export const has = (k) => argv.includes(k);

const stateArg = arg("--state", null) || process.env.PLY_STATE_DIR || null;
export const STATE_DIR = stateArg ? path.resolve(stateArg) : null;
export const OUT = path.resolve(arg("--out", null) || process.env.UX_AUDIT_OUT || path.join(REPO, "ux-audit-out"));
export const DIST = path.join(OUT, "dist");
export const SHOTS = path.join(OUT, "shots");
export const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
