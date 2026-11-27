#!/usr/bin/env node
//
// 1.169.0 (B2): the ConPTY Plyloft ships on Windows (conpty.dll and
// OpenConsole.exe from Microsoft's NuGet package Microsoft.Windows.Console.ConPTY,
// MIT). Build time only — never at runtime: src-tauri/build.rs runs this for
// a Windows target, before tauri-build copies the bundle dir as a resource
// (tauri.windows.conf.json → `<install dir>\conpty\`).
//
//   node scripts/fetch-conpty.mjs --arch x64|arm64 --out <dir>
//
// The package pinned in src-tauri/windows/conpty.lock.json is downloaded once
// into src-tauri/windows/conpty/cache/ (ignored by git), its SHA-256 checked
// against the lock, and the files the arch ships are extracted, checked one by
// one, and written to <dir> with the licence notice. A cached package with
// another hash is fetched again; a download with the wrong hash fails the
// build. <dir> is emptied first, so it never mixes two arches or versions.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join(ROOT, "src-tauri", "windows", "conpty.lock.json");
const LICENSE = join(ROOT, "src-tauri", "windows", "ConPTY-LICENSE.txt");
const CACHE = join(ROOT, "src-tauri", "windows", "conpty", "cache");

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A zip's (a .nupkg's) stored and deflated entries, by name. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    entries.set(name, () => {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad zip entry ${name}`);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`zip entry ${name}: method ${method} not supported`);
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** What `<dir>` holds for `arch`: published path → package path. */
export function bundlePlan(lock, arch) {
  const plan = lock.bundle?.[arch];
  if (!plan) throw new Error(`no ConPTY bundle for arch ${arch} (have: ${Object.keys(lock.bundle).join(", ")})`);
  for (const from of Object.values(plan)) {
    if (!lock.files[from]) throw new Error(`conpty.lock.json: ${from} has no sha256`);
  }
  return plan;
}

/** The stamp a finished `<dir>` carries: rerun only when it changes. */
export function stampFor(lock, arch) {
  return `${lock.package} ${lock.version} ${lock.sha256} ${arch}\n`;
}

/** `bytes` if they are the pinned package, else the reason they are not. */
export function checkPackage(bytes, lock) {
  const got = sha256(bytes);
  if (got !== lock.sha256) {
    throw new Error(`${lock.package} ${lock.version}: SHA-256 ${got}, expected ${lock.sha256} (conpty.lock.json)`);
  }
  return bytes;
}

async function packageBytes(lock) {
  const cached = join(CACHE, `${lock.package}.${lock.version}.nupkg`);
  if (existsSync(cached)) {
    const bytes = readFileSync(cached);
    if (sha256(bytes) === lock.sha256) return bytes;
  }
  const res = await fetch(lock.url);
  if (!res.ok) throw new Error(`download ${lock.url}: HTTP ${res.status}`);
  const bytes = checkPackage(Buffer.from(await res.arrayBuffer()), lock);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cached, bytes);
  return bytes;
}

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const arch = arg("--arch");
  const out = arg("--out");
  if (!arch || !out) throw new Error("usage: fetch-conpty.mjs --arch x64|arm64 --out <dir>");
  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  const plan = bundlePlan(lock, arch);
  const stamp = stampFor(lock, arch);
  // Beside the dir, not in it: the dir is published as is.
  const stampPath = `${out}.stamp`;
  if (existsSync(stampPath) && readFileSync(stampPath, "utf8") === stamp) {
    const intact = Object.entries(plan).every(([to, from]) => {
      const p = join(out, to);
      return existsSync(p) && sha256(readFileSync(p)) === lock.files[from];
    });
    if (intact) return;
  }
  const zip = readZip(await packageBytes(lock));
  // Laid out beside it, then swapped in: a build that stops half-way never
  // leaves a half-written dir. Two first builds of different arches at once
  // still share the one dir (tauri.windows.conf.json names it): the last
  // one wins and the other's next build lays it out again (its stamp).
  const staging = `${out}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  for (const [to, from] of Object.entries(plan)) {
    const read = zip.get(from);
    if (!read) throw new Error(`${lock.package} ${lock.version} has no ${from}`);
    const bytes = read();
    const got = sha256(bytes);
    if (got !== lock.files[from]) throw new Error(`${from}: SHA-256 ${got}, expected ${lock.files[from]}`);
    mkdirSync(dirname(join(staging, to)), { recursive: true });
    writeFileSync(join(staging, to), bytes);
  }
  writeFileSync(join(staging, "LICENSE-ConPTY.txt"), readFileSync(LICENSE));
  rmSync(out, { recursive: true, force: true });
  renameSync(staging, out);
  writeFileSync(stampPath, stamp);
  console.log(`ConPTY ${lock.version} (${arch}) → ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`✗ fetch-conpty: ${e.message}`);
    process.exit(1);
  });
}
