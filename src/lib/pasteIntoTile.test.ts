// 1.177.0 Compare: the tile-keyed paste. Run with:
//
//     node --experimental-strip-types src/lib/pasteIntoTile.test.ts
import assert from "node:assert/strict";
import { pasteIntoTile, type PasteTileDeps } from "./pasteIntoTile.ts";
import type { TileScreenNow } from "./tileScreen.ts";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const ESC = "\x1b";

function rig(opts: { failAt?: number; screen?: Partial<TileScreenNow> | null } = {}) {
  let t = 0;
  const writes: string[] = [];
  let calls = 0;
  const deps: PasteTileDeps = {
    write: async (b) => {
      calls += 1;
      if (opts.failAt === calls) throw new Error("pty gone");
      writes.push(dec(b));
    },
    screen: () =>
      opts.screen === null
        ? null
        : { tail: "", blockTail: "", lastInputAt: 0, promptIdle: true, draft: false, working: false, decision: false, overlay: false, lastOutputAt: 0, holds: () => null, ...opts.screen },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { writes, deps };
}
const base = { guard: () => null as string | null };

// Mac, Claude, Send: the bracketed paste and its Enter in one write.
{
  const r = rig();
  const res = await pasteIntoTile("plan", { ...base, vendor: "claude", windows: false, submit: true }, r.deps);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(r.writes, [`${ESC}[200~plan${ESC}[201~\r`]);
}
// Mac, Codex, Send: the same.
{
  const r = rig();
  await pasteIntoTile("plan", { ...base, vendor: "codex", windows: false, submit: true }, r.deps);
  assert.deepEqual(r.writes, [`${ESC}[200~plan${ESC}[201~\r`]);
}
// A leading ! or / gets the composer guard's space.
{
  const r = rig();
  await pasteIntoTile("/clear", { ...base, vendor: "claude", windows: false, submit: true }, r.deps);
  assert.deepEqual(r.writes, [`${ESC}[200~ /clear${ESC}[201~\r`]);
}
// Put it in its box never submits (Mac and Windows, both vendors).
for (const [vendor, windows] of [["claude", false], ["codex", false], ["claude", true], ["codex", true]] as const) {
  const r = rig();
  const res = await pasteIntoTile("a\nb", { ...base, vendor, windows, submit: false }, r.deps);
  assert.equal(res.ok, true);
  assert.equal(r.writes.length, 1);
  assert.ok(!r.writes[0].includes("\r"), `${vendor} windows=${windows}`);
  assert.ok(r.writes[0].startsWith(`${ESC}[200~`) && r.writes[0].endsWith(`${ESC}[201~`));
}
// Windows Codex Put: plain keys (arrows and curly quotes spelled in ASCII).
{
  const r = rig();
  await pasteIntoTile("a → “b”", { ...base, vendor: "codex", windows: true, submit: false }, r.deps);
  assert.deepEqual(r.writes, [`${ESC}[200~a -> "b"${ESC}[201~`]);
}
// Windows Codex Send: the paste first, the Enter as its own write after it settled.
{
  const r = rig();
  const res = await pasteIntoTile("plan →", { ...base, vendor: "codex", windows: true, submit: true }, r.deps);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(r.writes, [`${ESC}[200~plan ->${ESC}[201~`, "\r"]);
}
// Windows Claude Send: one write with the Enter, as on the Mac.
{
  const r = rig();
  await pasteIntoTile("plan", { ...base, vendor: "claude", windows: true, submit: true }, r.deps);
  assert.deepEqual(r.writes, [`${ESC}[200~plan${ESC}[201~\r`]);
}
// A guard that refuses writes nothing and says why.
{
  const r = rig();
  const res = await pasteIntoTile("plan", { vendor: "claude", windows: false, submit: true, guard: () => "Claude is working." }, r.deps);
  assert.deepEqual(res, { ok: false, written: false, words: "Claude is working." });
  assert.deepEqual(r.writes, []);
}
// The guard is read synchronously, right before the write: a state that
// flips between the press and the write stops it.
{
  let ready = true;
  const r = rig();
  const promise = pasteIntoTile("plan", { vendor: "claude", windows: false, submit: true, guard: () => (ready ? null : "flipped") }, r.deps);
  ready = false; // flips after the call began; the guard already ran for this call
  const res = await promise;
  assert.equal(res.ok, true);
  const r2 = rig();
  const res2 = await pasteIntoTile("plan", { vendor: "claude", windows: false, submit: true, guard: () => (ready ? null : "flipped") }, r2.deps);
  assert.equal(res2.ok, false);
  assert.deepEqual(r2.writes, []);
}
// A failed first write: nothing reached the tile, and it says so.
{
  const r = rig({ failAt: 1 });
  const res = await pasteIntoTile("plan", { ...base, vendor: "codex", windows: false, submit: true }, r.deps);
  assert.deepEqual(res, { ok: false, written: false, failed: true, words: "That didn't reach Codex. Nothing was sent." });
}
// A failed Enter after a Windows Codex paste: it is in the box; it says what is true.
{
  const r = rig({ failAt: 2 });
  const res = await pasteIntoTile("plan", { ...base, vendor: "codex", windows: true, submit: true }, r.deps);
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.written, true);
  assert.equal(res.ok === false && res.words, "It reached Codex's box, but Plyloft couldn't send it. Press Enter in its tile.");
}
// Codex's transcript search open: nothing typed, and the existing words.
{
  const r = rig({ screen: { overlay: true } });
  const res = await pasteIntoTile("plan", { ...base, vendor: "codex", windows: true, submit: true }, r.deps);
  assert.equal(res.ok, false);
  assert.deepEqual(r.writes, []);
  assert.match(res.ok === false ? res.words : "", /transcript search/);
}
// The error never carries the text.
{
  const r = rig({ failAt: 1 });
  const res = await pasteIntoTile("SECRET-ANSWER", { ...base, vendor: "claude", windows: false, submit: false }, r.deps);
  assert.ok(!JSON.stringify(res).includes("SECRET"));
}
// 1.177.0 review M3: Windows Codex Send — no Enter if the member typed into
// the tile since the paste began, or the pass is no longer wanted.
{
  let t = 0;
  let typedAt = 0;
  const writes: string[] = [];
  const deps: PasteTileDeps = {
    write: async (b) => {
      writes.push(dec(b));
    },
    screen: () => ({ tail: "", blockTail: "", promptIdle: true, draft: false, working: false, decision: false, overlay: false, lastOutputAt: t, lastInputAt: typedAt, holds: () => null }),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      if (t > 300) typedAt = t; // the member types during the settle
    },
  };
  const res = await pasteIntoTile("plan", { ...base, vendor: "codex", windows: true, submit: true }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.written, true);
  assert.equal(res.ok === false && res.words, "It reached Codex's box, but Plyloft couldn't send it. Press Enter in its tile.");
  assert.deepEqual(writes, [`${ESC}[200~plan${ESC}[201~`], "only the paste; no Enter");
}
{
  let wanted = true;
  const r = rig();
  const wrapped = { ...r.deps, sleep: async (ms: number) => { await r.deps.sleep(ms); wanted = false; } };
  const res = await pasteIntoTile("plan", { ...base, vendor: "codex", windows: true, submit: true, stillWanted: () => wanted }, wrapped);
  assert.equal(res.ok, false);
  assert.deepEqual(r.writes, [`${ESC}[200~plan${ESC}[201~`]);
}
// Not typed since: the Enter goes (the earlier Send test covers it) — and an
// input stamp from before the paste is not "typed since".
{
  const r = rig({ screen: { lastInputAt: -5 } });
  const res = await pasteIntoTile("plan", { ...base, vendor: "codex", windows: true, submit: true }, r.deps);
  assert.equal(res.ok, true);
}
console.log("pasteIntoTile ok");
