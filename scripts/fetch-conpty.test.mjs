#!/usr/bin/env node
// Tests for scripts/fetch-conpty.mjs (1.169.0, B2): the pinned package, what
// each arch ships, and the zip reader. No network: the zip is built here.
//
//     node scripts/fetch-conpty.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { bundlePlan, checkPackage, readZip, sha256, stampFor } from "./fetch-conpty.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(join(ROOT, "src-tauri/windows/conpty.lock.json"), "utf8"));

// The pin: one version, its URL, a SHA-256 for the package and every file.
assert.equal(lock.package, "Microsoft.Windows.Console.ConPTY");
assert.match(lock.version, /^\d+\.\d+\.\d+$/, "a stable version (no -preview)");
assert.ok(lock.url.includes(`/${lock.version}/`), "the URL names the pinned version");
for (const h of [lock.sha256, ...Object.values(lock.files)]) assert.match(h, /^[0-9a-f]{64}$/);

// x64 (the release): conpty.dll beside both OpenConsoles, as Microsoft's own
// MSBuild targets lay out an x64 app — conpty.dll picks <native arch>\, so
// an x64 Plyloft on an ARM64 PC runs the native ARM64 console host.
assert.deepEqual(Object.keys(bundlePlan(lock, "x64")).sort(), ["arm64/OpenConsole.exe", "conpty.dll", "x64/OpenConsole.exe"]);
assert.equal(bundlePlan(lock, "x64")["conpty.dll"], "runtimes/win-x64/native/conpty.dll");
// ARM64 (the VM's test build): its own DLL and the ARM64 host only.
assert.deepEqual(Object.keys(bundlePlan(lock, "arm64")).sort(), ["arm64/OpenConsole.exe", "conpty.dll"]);
assert.equal(bundlePlan(lock, "arm64")["conpty.dll"], "runtimes/win-arm64/native/conpty.dll");
assert.throws(() => bundlePlan(lock, "x86"), /no ConPTY bundle for arch x86/);
assert.throws(() => bundlePlan({ ...lock, files: {} }, "x64"), /has no sha256/);

// The stamp changes with the version, the hash and the arch.
assert.notEqual(stampFor(lock, "x64"), stampFor(lock, "arm64"));
assert.notEqual(stampFor(lock, "x64"), stampFor({ ...lock, version: "9.9.9" }, "x64"));

// A package with another hash fails the build, naming both hashes.
const tampered = Buffer.from("not the pinned package");
assert.throws(() => checkPackage(tampered, lock), new RegExp(`SHA-256 ${sha256(tampered)}, expected ${lock.sha256}`));
const pinnedLike = Buffer.from("pretend package");
assert.equal(checkPackage(pinnedLike, { ...lock, sha256: sha256(pinnedLike) }), pinnedLike);

// The licence notice ships with it and names the package.
const notice = readFileSync(join(ROOT, "src-tauri/windows/ConPTY-LICENSE.txt"), "utf8");
assert.ok(notice.includes("MIT License") && notice.includes(lock.version), "MIT notice for the pinned version");

// readZip: a stored and a deflated entry.
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data, deflate] of files) {
    const body = deflate ? deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, body);
    centrals.push(central, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const a = Buffer.from("stored bytes");
const b = Buffer.from("deflated ".repeat(50));
const entries = readZip(zip([["a/one.txt", a, false], ["b/two.dll", b, true]]));
assert.deepEqual([...entries.keys()], ["a/one.txt", "b/two.dll"]);
assert.equal(sha256(entries.get("a/one.txt")()), sha256(a));
assert.equal(sha256(entries.get("b/two.dll")()), sha256(b));
assert.throws(() => readZip(Buffer.from("not a zip at all, not a zip at all")), /not a zip/);

console.log("fetch-conpty: all assertions passed");
