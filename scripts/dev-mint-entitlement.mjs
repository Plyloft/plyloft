#!/usr/bin/env node
// Launch G walks (docs/plans/N14_WALKS.md, "Plans and gates"): mint a PLY2
// entitlement with the DEV keypair, for a debug build only.
//
// A debug build trusts the dev public key when it is started with
//   PLYLOFT_ENTITLEMENT_PUBKEY=$(cat ~/ply-build/launch-dev-keys/entitlement-dev.pub.hex)
// and loads the token with the debug-only command `account_dev_load_entitlement`
// (compiled out of release builds). A release build never accepts a dev token:
// it has no override and its embedded key is the production one.
//
// Usage:
//   node scripts/dev-mint-entitlement.mjs --device <32 hex> --plan free|pro|team \
//     [--login octocat] [--sub 1] [--team-repo owner/name] [--role owner|member] \
//     [--minutes N | --days N] [--key path/to/entitlement-dev.pem] \
//     [--status active|past_due] [--comp]
//
// Launch A3 (Settings › Plan walks): `--status past_due` shows the payment
// problem; `--comp` an internal account ("Included", no period end).
//
// The device id is `deviceId` in the debug profile's account.dev.json
// (`~/Library/Application Support/com.mbadv.ply/account.dev.json`, or the
// test profile's directory). Prints the token on stdout.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const fail = (why) => {
  console.error(why);
  process.exit(1);
};

const device = opt("device");
const plan = opt("plan");
if (!device || !/^[0-9a-f]{32}$/.test(device)) fail("--device must be the 32 hex deviceId from account.dev.json");
if (!["free", "pro", "team"].includes(plan)) fail("--plan must be free, pro or team");
const teamRepo = opt("team-repo", null);
if (plan === "team" && teamRepo && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(teamRepo)) {
  fail("--team-repo must be owner/name");
}
const role = opt("role", plan === "team" ? "owner" : null);
const keyPath = opt("key", join(homedir(), "ply-build/launch-dev-keys/entitlement-dev.pem"));
const now = Date.now();
const minutes = opt("minutes");
const days = Number(opt("days", "30"));
const exp = minutes ? now + Number(minutes) * 60_000 : now + days * 86_400_000;
const comp = args.includes("--comp");
const status = opt("status", plan === "free" || comp ? null : "active");
if (status !== null && !["active", "trialing", "past_due"].includes(status)) {
  fail("--status must be active, trialing or past_due (anything else is Free on the server)");
}

// LAUNCH_API § Entitlement token: the exact bytes signed are the bytes sent.
const payload = JSON.stringify({
  v: 2,
  sub: opt("sub", "1"),
  login: opt("login", "octocat"),
  plan,
  teamRepo: plan === "team" ? teamRepo : null,
  teamRole: plan === "team" ? role : null,
  deviceId: device,
  iat: now,
  exp,
  periodEnd: plan === "free" || comp ? null : exp,
  status,
  comp,
});
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const key = createPrivateKey(readFileSync(keyPath));
const sig = sign(null, Buffer.from(payload), key);
console.error(`plan ${plan}${teamRepo ? ` (${teamRepo})` : ""}, expires ${new Date(exp).toISOString()}`);
console.log(`PLY2-${b64url(payload)}.${b64url(sig)}`);
