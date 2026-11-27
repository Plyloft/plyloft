// Walk tooling configuration for the Node scripts (team-walk/*.mjs): the same
// file and rules as walk-config.sh (docs/app-tester/DESIGN.md, "Walk
// configuration"). The file is $PLY_WALK_ENV, or walk.env beside this module
// (git-ignored, never exported; the template is walk.env.example). A variable
// set and not empty in the environment wins over the file. Plain KEY=value
// lines, a value optionally in "…" or '…', "#" comments, blank lines; an
// unknown key is refused.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WALK_VARS = [
  "PLY_WALK_OWNER_LOGIN",
  "PLY_WALK_OWNER_ID",
  "PLY_WALK_MEMBER_LOGIN",
  "PLY_WALK_MEMBER_ID",
  "PLY_WALK_SANDBOX_REPO",
  "PLY_WALK_TEAM_REPO",
  "PLY_WALK_DEV_GITHUB_CLIENT_ID",
  "PLY_TEST_VM",
];
export const WALK_EXAMPLE = "scripts/app-tester/walk.env.example";

export function walkEnvFile(env = process.env) {
  return env.PLY_WALK_ENV || join(dirname(fileURLToPath(import.meta.url)), "walk.env");
}

/** The file's values. Throws, with one line, on a line it can't read. */
export function parseWalkEnv(text, file = "walk.env") {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length);
    const at = line.indexOf("=");
    if (at < 0) throw new Error(`${file}: not a KEY=value line: ${line}`);
    const key = line.slice(0, at);
    let value = line.slice(at + 1);
    if (!WALK_VARS.includes(key)) throw new Error(`${file}: unknown variable ${key} (the known ones are in ${WALK_EXAMPLE})`);
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

export function missingLine(name, file) {
  return `✗ ${name} is not set: put it in ${file} (copy ${WALK_EXAMPLE}) or export it`;
}

/** The values of `names`, the environment over the file; `missing` is the first
 *  one neither gives (null when all are there). */
export function resolveWalk(names, { env = process.env, file = walkEnvFile(env), read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null) } = {}) {
  const text = read(file);
  const fromFile = text == null ? {} : parseWalkEnv(text, file);
  const values = {};
  let missing = null;
  for (const name of names) {
    values[name] = env[name] || fromFile[name] || "";
    if (!values[name] && !missing) missing = name;
  }
  return { values, missing, file };
}

/** For scripts: the values, or one line on stderr and exit 2. */
export function requireWalk(names, options) {
  let result;
  try {
    result = resolveWalk(names, options);
  } catch (error) {
    process.stderr.write(`✗ ${error.message}\n`);
    process.exit(2);
  }
  if (result.missing) {
    process.stderr.write(`${missingLine(result.missing, result.file)}\n`);
    process.exit(2);
  }
  return result.values;
}
