// Unit tests for LatestRequest (src/lib/latestRequest.ts).
//
// Run: node --experimental-strip-types src/lib/latestRequest.test.ts

import { LatestRequest } from "./latestRequest.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

function eq<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

it("a single request may apply its response", () => {
  const gate = new LatestRequest();
  const ticket = gate.begin();
  eq(gate.isCurrent(ticket), true);
});

it("a slow earlier response is discarded once a newer request starts", () => {
  const gate = new LatestRequest();
  const slow = gate.begin(); // the old key's refresh
  const fresh = gate.begin(); // the new key's refresh
  // The old one comes back last — the out-of-order case that repainted the
  // panel with the previous team.
  eq(gate.isCurrent(fresh), true);
  eq(gate.isCurrent(slow), false);
});

it("the newest ticket stays current after the older ones resolve", () => {
  const gate = new LatestRequest();
  gate.begin();
  gate.begin();
  const newest = gate.begin();
  eq(gate.isCurrent(newest), true);
});

it("retireAll discards everything in flight and starts nothing", () => {
  const gate = new LatestRequest();
  const inFlight = gate.begin();
  gate.retireAll(); // the key changed, or the panel unmounted
  eq(gate.isCurrent(inFlight), false);
  // Nothing is current now — a stale response cannot sneak in as "newest".
  eq(gate.isCurrent(0), false);
});

it("a request started after retireAll is current again", () => {
  const gate = new LatestRequest();
  gate.begin();
  gate.retireAll();
  const next = gate.begin();
  eq(gate.isCurrent(next), true);
});

it("tickets are never reused, so an old one can never become current", () => {
  const gate = new LatestRequest();
  const first = gate.begin();
  for (let i = 0; i < 100; i++) gate.begin();
  eq(gate.isCurrent(first), false);
});

if (failed > 0) {
  console.error(`✗ ${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} passed`);
