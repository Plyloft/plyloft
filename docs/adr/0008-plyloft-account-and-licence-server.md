# ADR 0008 — A Plyloft account is a GitHub sign-in, checked by a licence server

> **Amended by [ADR 0010](0010-free-for-one-person-open-source.md)** (2026-11-26, 1.178.0): the plans are Free and Team, the account is optional for one person, and only Team is held on one computer. The text below is kept as written.

**Status:** accepted, 2026-10-02 (owner decisions D1–D22 in
LAUNCH_PLAN); shipped in 1.158.0. Supersedes the
licence parts of [ADR 0002](0002-team-is-a-github-repo.md). The team is still
a GitHub repository. The contract between the app and the server is
[LAUNCH_API](../plans/LAUNCH_API.md).

The launch plan calls this "ADR 0003". That number was already taken by
[0003 — The repository is the workspace](0003-the-repo-is-the-workspace.md),
so it is 0008.

## Context

Plyloft is sold as Free, Pro (€9 a month) and Team (€9 per member). Up to
1.157.0, plans were checked with offline `PLY1` keys (ADR 0002, `license.rs`).
A review on 2026-10-02 found these problems:

- A paid key was bound to nothing. It carried no login, its team repository
  could be overridden in settings, and its seat count was never enforced. One
  key could unlock any team on any number of machines.
- Keys could not be revoked. The owner minted them by hand on his Mac.
- There was no Free or Pro plan, only "team or not". `TEAM_FREE_DURING_BETA`
  opened every team gate.
- Owner rights and membership were checked only on the client, from
  `team.json`.

Selling subscriptions needs four things: an identity that payment can be tied
to, a plan that follows the subscription's state (renewal, failed payment,
cancellation), seats that are enforced, and a way to end access.

## Decision

1. **Identity: the Plyloft account is a GitHub sign-in.** It is required for
   everyone, Free included. The app uses the GitHub OAuth App "Plyloft" with
   the **Device Flow**. The client id is public, there is no client secret in
   the app, and no scopes are requested. The app sends the GitHub token once
   to `POST /v1/session`. The server checks that GitHub issued the token to
   Plyloft's app, upserts the user by GitHub numeric id, and returns its own
   session token. Neither side keeps the GitHub token. The session token is
   stored in the OS keychain. The account proves who the person is and
   nothing else: projects can stay local, and no repository on GitHub is
   needed. It is separate from the `gh` login used for pull requests.
2. **A licence server.** `plyloft-server` (TypeScript, Hono, Postgres) runs on
   Railway at `api.plyloft.com`, with a staging service on the Stripe sandbox.
   It holds users, sessions, the active device, subscriptions, teams, seats
   and a comp list. It holds no code, transcripts or project data.
3. **Entitlements: `PLY2`, Ed25519, verified offline.** The server signs
   `PLY2-<payload>.<sig>` (`{v, sub, login, plan, teamRepo, teamRole,
   deviceId, iat, exp, periodEnd, status, cancelAtPeriodEnd, comp}`) with a
   **new** keypair. The app verifies it with the public key embedded in
   `account.rs` (`verify_strict`, `v == 2`, its own `deviceId`, `now < exp`)
   and caches it in `account.json`.
   Paid and comp tokens last at most 14 days from when they were issued (and
   never past the paid period's end plus 3 days); Free tokens last 30 days
   (1.175.0, SRV-1; before: the paid period's end plus 3 days, and 30 days for
   a comp). The app refreshes at
   launch, every 6 hours, when the window regains focus (at most once a
   minute), and on Check now. The **production private key exists only in the
   production server's environment and in 1Password.**
4. **Payment: Stripe.** Checkout and the Customer Portal are opened from the
   site or from the app (Upgrade, Create team, Manage subscription), tied to
   the account. Prices include VAT. The server derives the plan from the
   subscription's current state, fetched again on every webhook, and never
   from the order of events. `active`, `trialing` and `past_due` are paid.
   `canceled`, `unpaid` and `incomplete_expired` are Free. Stripe retries a
   failed renewal, then cancels.
5. **Seats.** A Team owner buys N seats (2–50, the owner counts as one) and
   assigns them by GitHub numeric id. A seat is taken on the server before
   the GitHub invitation is sent. The server refuses a seat beyond N, and a
   seat decrease below the assigned count. Only seat holders get Team, and
   only for the bound team repository.
6. **One device.** The last sign-in wins. The older device's session is
   marked `replaced`, and that device drops to the Sign-in screen at its next
   refresh. Comp accounts (internal and test accounts) are exempt.
   *Amended 2026-10-21 (QoL 1.168, owner D1):* the replaced device stays
   signed in on Free instead, and *Use it here* takes the plan back with the
   session it holds (`POST /session/reclaim`: once per session, token
   rotated, within 90 days, 20 a user a day, audited), no new GitHub code.
7. **Plan derivation: the highest plan wins.** The order is: comp entry, then
   Team owner, then Team seat holder, then Pro, then Free. A user who is both
   Pro and a seat holder gets Team. One team per user.
8. **Team gates require all three:** plan `team`, `teamRepo` equal to the team
   this Mac is in, and the Plyloft account equal to the GitHub account the
   team uses (`settings.team.account`).

`PLY1` keys are retired. A stored key unlocks nothing. `license.json` is left
untouched, and the app still reads it so it can report the key.

## Alternatives considered

- **Keep keys, issued by email (`PLY1` plus a mailed key).** No server to
  run, but keys stay unbound to a person or machine. Seats could not be
  enforced, keys could not be revoked, and every renewal would need a new
  key. Rejected: the 2026-10-02 review showed this is not a product that can
  be sold.
- **Email accounts (magic link or password).** Needs mail delivery, account
  recovery and possibly password storage. It also adds an identity separate
  from the GitHub account the team already works with, so seats and the D10
  account match would need a second mapping. Rejected. Stripe still collects
  an email at checkout for receipts.
- **A GitHub App instead of an OAuth App.** Installations and repository
  permissions are more than identity needs, and sign-in would read as an
  access request. Rejected: an OAuth App with no scopes proves the GitHub id
  and grants nothing.
- **Online checks only, no signed token.** Simpler, but the app would stop
  working whenever the server or the network was down. Rejected: the
  offline-verified token keeps the app working until `exp`.

## Consequences

- **There is a server to run:** Railway Postgres backups, structured logs
  without tokens, a health check, and alerts on webhook failures and
  disputes. The app's work never depends on the server: running work is
  never stopped, and a lapse or an offline period degrades only at action
  points.
- **First launch needs a connection** to sign in. After that, the cached
  entitlement covers offline use until `exp`. Accepted limit: an offline old
  device keeps its plan until `exp` — 14 days at most from 1.175.0.
- **Access can now end.** Revoked sessions, `replaced` devices, removed seats
  and lapsed subscriptions all take effect at the next refresh (6 hours at
  most when online).
- **The PLY2 public key ships in every build.** Replacing the keypair means
  an app update that every user must install before the server can sign with
  the new key. Do not rotate it except after a compromise
  ([RELEASING](../RELEASING.md)). `scripts/check-account-config.sh` refuses a
  release with an empty client id or public key.
- **ADR 0002 still holds for the team itself.** The team repository, its
  manifest, GitHub access as the ACL, and the shared library are unchanged.
  What changed: the key no longer carries the repository, seats are enforced
  by the server, and the D10 account match adds a condition. Owner-only
  actions on the team remain a client check on the manifest, except seats,
  which the server enforces.
- **Personal data held by Plyloft:** GitHub id and login, a generic label and
  the platform of each signed-in computer (not its name, from 1.175.0), and
  Stripe customer and subscription ids. The address and user agent of a "Use
  it here" are kept 90 days. Payment details stay with Stripe. An account is
  erased on request with the server's `erase-user` command; subscription and
  consent records stay without the person. The legal texts (D21) must say this.
- **Out of scope for this release:** moving a team to another owner, binding
  a different repository, more than one team per user, and devices beyond
  one.
