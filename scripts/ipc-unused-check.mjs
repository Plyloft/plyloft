#!/usr/bin/env node
// Unused IPC (1.174.0 B4, CH-7); run in scripts/ppvp.sh's ux-check step.
// Tests: scripts/ipc-unused-check.test.mjs.
//
// Lists the Tauri commands registered in src-tauri/src/lib.rs
// (`generate_handler![…]`) that the window never invokes: no string literal
// naming the command in src/**/*.ts(x) outside the tests. A name that only an
// `src/ipc.ts` wrapper holds counts only when something outside ipc.ts (or
// another ipc.ts export) uses that wrapper, so a dead wrapper doesn't keep
// its command alive.
//
// A warning, not a failure: a command kept on purpose (a proof test drives
// it, a later card wires it) goes in scripts/ipc-unused-allowlist.json with
// its reason. An allowlist entry that is invoked again, or no longer
// registered, is reported too, so the list only goes down.
//
// Usage: node scripts/ipc-unused-check.mjs [--root DIR] [--strict]
//   --strict  exit 1 when there is anything to report (the tests use it).

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LIB_RS = "src-tauri/src/lib.rs";
export const IPC_TS = "src/ipc.ts";
export const ALLOWLIST_FILE = "scripts/ipc-unused-allowlist.json";

/** Every command name in the `generate_handler![…]` lists of `librs`. */
export function registeredCommands(librs) {
  const names = new Set();
  const re = /generate_handler!\s*\[([\s\S]*?)\]\s*\)/g;
  let m;
  while ((m = re.exec(librs))) {
    const body = m[1].replace(/\/\/[^\n]*/g, "").replace(/#\[[^\]]*\]/g, "");
    for (const tok of body.split(",")) {
      const path = tok.trim();
      if (!path) continue;
      names.add(path.split("::").pop());
    }
  }
  return names;
}

const STRING = /["'`]([a-z][a-z0-9_]*)["'`]/g;

/** `text` without its `//` and `/* *\/` comments (strings and template
 *  literals kept whole, so a URL's `//` stays): a command named in a comment
 *  — "`inbox_mark_all_seen` stays a backend command" — is not invoked. */
export function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      out += " ";
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") j++;
        else if (c !== "`" && text[j] === "\n") break;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function stringsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(STRING)) out.add(m[1]);
  return out;
}

/** ipc.ts cut at each top-level declaration: [{ name, text }]. */
export function ipcSegments(ipc) {
  const segments = [];
  const decl = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
  let current = { name: null, text: "" };
  for (const line of ipc.split("\n")) {
    const m = decl.exec(line);
    if (m) {
      segments.push(current);
      current = { name: m[1], text: "" };
    }
    current.text += line + "\n";
  }
  segments.push(current);
  return segments;
}

/** The command names the window can invoke. `others`: the text of every
 *  non-test TS file but ipc.ts. */
export function invokedStrings(ipc, others) {
  ipc = stripComments(ipc);
  others = others.map(stripComments);
  const invoked = new Set();
  for (const text of others) for (const s of stringsIn(text)) invoked.add(s);
  const segments = ipcSegments(ipc);
  const outside = others.join("\n");
  for (const seg of segments) {
    const name = seg.name;
    const word = name ? new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`) : null;
    const used =
      !name ||
      word.test(outside) ||
      segments.some((o) => o !== seg && word.test(o.text));
    if (used) for (const s of stringsIn(seg.text)) invoked.add(s);
  }
  return invoked;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "test") continue;
      walk(path, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** { unused, stale } for the tree at `root`. */
export function run(root) {
  const registered = registeredCommands(readFileSync(join(root, LIB_RS), "utf8"));
  const ipcPath = join(root, IPC_TS);
  const ipc = existsSync(ipcPath) ? readFileSync(ipcPath, "utf8") : "";
  const others = walk(join(root, "src"))
    .filter((p) => relative(root, p).split(sep).join("/") !== IPC_TS)
    .map((p) => readFileSync(p, "utf8"));
  const invoked = invokedStrings(ipc, others);
  const allowPath = join(root, ALLOWLIST_FILE);
  const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, "utf8")) : {};
  const unused = [...registered].filter((n) => !invoked.has(n) && !(n in allow)).sort();
  const stale = Object.keys(allow)
    .filter((n) => !registered.has(n) || invoked.has(n) || !String(allow[n] ?? "").trim())
    .sort();
  return { registered: registered.size, unused, stale };
}

function main(argv) {
  const at = argv.indexOf("--root");
  const root = at >= 0 ? argv[at + 1] : join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const { registered, unused, stale } = run(root);
  console.log(`ipc-unused-check: ${registered} registered commands`);
  for (const n of unused) console.log(`ipc-unused-check: warning: \`${n}\` is registered but the window never invokes it`);
  for (const n of stale)
    console.log(`ipc-unused-check: warning: \`${n}\` in ${ALLOWLIST_FILE} is invoked, unregistered or has no reason: take it out`);
  if (!unused.length && !stale.length) console.log("ipc-unused-check: clean");
  return argv.includes("--strict") && (unused.length || stale.length) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
