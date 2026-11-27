# Launch API contract — app ↔ plyloft-server (v1)

Companion to LAUNCH_PLAN.md §3. Both sides build against
this page; a change here is a change to both. From 1.178.0 the plans are Free
and Team, and only Team is held on one computer
([ADR 0010](../adr/0010-free-for-one-person-open-source.md)).

## Base

- **Base URLs:**
  - production `https://api.plyloft.com/v1`
  - staging `https://staging-api.plyloft.com/v1`
  - local `http://localhost:8787/v1`
- **App build-time selection:** release builds use production. Debug/dev builds read `PLYLOFT_API_URL` (default local).
- **Format:**
  - JSON, UTF-8, camelCase fields.
  - Times are **milliseconds since epoch** (like `license.rs`).
- **Auth:** `Authorization: Bearer <sessionToken>`, except `POST /session` and the webhook.
- **Team-computer capability** (1.178.0, owner 2026-11-26; see [One computer at a time: Team only](#one-computer-at-a-time-team-only)):
  - the app (1.178.0+) sends `X-Plyloft-Team-Choice: 1` on **every** API call;
  - the server (from the 1.178 server) answers `X-Plyloft-Team-Choice: 1` on **every** `/v1/…`
    answer, errors included (not on `/health`). An answer without it comes from an older server
    (a rollback): the app then makes no silent reclaim and shows no Team state, and a `409
    replaced` from that server leaves the account signed in on Free, asking again at each refresh.
  - A request without the header is an app up to 1.177.1: the server keeps that app's rules
    (below). Judged per request, not per session (the token survives an app update).
- **Errors:** `{ "error": "<code>", "message": "<plain words for the user>" }` with a 4xx/5xx status.

| code | when |
|---|---|
| `bad_request` | malformed body |
| `github_token_invalid` | GitHub says the token is not ours / invalid |
| `unauthorized` | missing/unknown/revoked session |
| `replaced` | 409. A session a newer sign-in revoked before the 1.178 server (or an older session of the same device); and, **only for an app without `X-Plyloft-Team-Choice`**, a Team account's computer where Team isn't active (nothing is revoked then) |
| `forbidden` | not the team owner, etc. |
| `seat_limit` | no free seat (409) |
| `seat_in_use` | quantity below assigned seats (409) |
| `not_found` | no team / no subscription |
| `rate_limited` | 429 |
| `already_bound` | the team already has a different repo (409) |
| `plan_retired` | 410 (1.178.0): Pro is no longer sold — `POST /checkout {plan:"pro"}` and both `switch-to-team` routes. `message` is the sentence to show |
| `no_team` | 409 (1.178.0): `POST /session/use-team` on an account with no Team plan |
| `github_unavailable` | GitHub didn't answer (502) |
| `internal` | server error (500) |

## Entitlement token (PLY2)

```
PLY2-<base64url(payload_json)>.<base64url(ed25519_sig over the exact payload bytes)>
```

base64url **without padding**, like PLY1. Payload:

```json
{
  "v": 2,
  "sub": "1234567",
  "login": "octocat",
  "plan": "free",
  "teamRepo": null,
  "teamRole": null,
  "deviceId": "6f1c…",
  "iat": 1760000000000,
  "exp": 1762592000000,
  "periodEnd": null,
  "status": null,
  "cancelAtPeriodEnd": false,
  "comp": false
}
```

- `sub`: GitHub numeric user id as a string. This is the identity.
- `plan`: `"free" | "pro" | "team"`. From 1.178.0 Pro is no longer sold, but a comp Pro (and any
  Pro subscription still found) is still signed `pro`; app 1.178.0 reads it as Free. A computer
  where the account's Team plan isn't active is signed the plan **without** Team (`free`, or a
  comp Pro's `pro`): the payload is unchanged, and where Team is travels in the unsigned `team`
  field of the answers.
- `teamRepo`: `"owner/name"` when `plan == "team"`, else `null`.
- `teamRole`: `"owner" | "member"` when `plan == "team"`.
- `deviceId`: the device the token was issued to. The app refuses a token whose `deviceId` isn't its own.
- `exp` (from 1.175.0, owner 2026-11-09, SRV-1: a token that grants Pro or Team
  is good offline for at most 14 days from when it was issued):
  - free: `iat + 30 days`;
  - paid (an own plan, or a seat on a paid team): the earlier of
    `max(periodEnd, iat) + 3 days` and `iat + 14 days` (never issued already
    expired);
  - comp, and a seat on a comp team: `iat + 14 days`.
  `periodEnd` is still the end of the paid period; dates shown to the person
  come from it, never from `exp`. Before 1.175.0 a paid token ran to
  `periodEnd + 3 days` and a comp's for 30 days.
- `status`: the Stripe subscription status that produced the plan, or `null`. The app shows `past_due` as "payment problem".
- `cancelAtPeriodEnd`: true when the paid subscription won't renew (cancelled in the Portal); false otherwise. Optional for the app (older tokens lack it).
- `comp`: true for the server-side comp list (internal accounts).
- **Verification (app):**
  - prefix `PLY2-`;
  - Ed25519 `verify_strict` with the embedded public key;
  - `v == 2`, the `deviceId` matches, and `now < exp`.
  - Debug builds may override the public key with `PLYLOFT_ENTITLEMENT_PUBKEY` (hex); release builds may not.

## Endpoints

### `POST /session`

Sign in from the app after the GitHub Device Flow.

Request:

```json
{ "githubToken": "gho_…", "deviceId": "6f1c…", "deviceName": "Matteo's MacBook Pro", "platform": "macos" }
```

`deviceId`: 32 lowercase hex characters (the server accepts `^[0-9a-f]{32}$`).
`platform`: `"macos" | "windows" | "linux"`. `deviceName`: optional from
1.175.0; when sent, ≤ 100 characters, trimmed, not empty.

**The server does not store `deviceName`** (1.175.0, SRV-4). It keeps a generic
label instead: on macOS the Mac model when the name contains one (`MacBook
Pro`, `MacBook Air`, `MacBook`, `Mac mini`, `Mac Studio`, `Mac Pro`, `iMac`),
else `Mac`; `Windows PC`; `Linux computer`. That label is the `deviceName` of
`409 replaced` and the `device.name` of `GET /account`. An app that may meet a
server older than 1.175 keeps sending the field (that server requires it).
**App (1.175.0):** it sends the short name, never the computer's own — on a
Mac its name without the owner ("MacBook Pro"), on Windows "Windows PC"
(`account::sent_device_name`) — and names the computer that took the plan
"another computer (MacBook Pro)".

The server checks the token with `POST https://api.github.com/applications/{client_id}/token` (Basic `client_id:client_secret`). It requires `app.client_id == ours`, then reads `user.id` and `user.login`. It **does not store** the GitHub token. It upserts the user and creates a session for this device.

**No sign-in revokes another computer** (1.178.0; before: "last sign-in wins" on every plan).
Only an older session of **this same device** (`deviceId`) is closed (`replaced`, not
reclaimable). A Team plan is active on one computer; the sign-in takes it only as in
[One computer at a time: Team only](#one-computer-at-a-time-team-only): with the header, when no
computer holds it and no paid Team Checkout names another computer; **without** the header (apps up
to 1.177.1), always — a *temporary* rule (owner D4, 2026-11-26) that may take Team from a 1.178
computer of the same account.

Response `200`:

```json
{ "sessionToken": "pls_…", "entitlement": "PLY2-…", "account": { "sub": "1234567", "login": "octocat" }, "team": null }
```

`team` (1.178.0, additive, unsigned): see [The `team` field](#the-team-field).

`sessionToken`: opaque, ≥ 32 random bytes, stored hashed (SHA-256) by the server. It has no expiry while used; it is revoked by sign-out or replacement.

### `DELETE /session`

Sign out this device. `204`.

### `GET /entitlement`

Refresh. Header `X-Plyloft-Device: <deviceId>` must match the session's device.

- `200`: `{ "entitlement": "PLY2-…", "team": … }` (`team` from 1.178.0, see [The `team` field](#the-team-field)).
- 1.178.0: an app **without** `X-Plyloft-Team-Choice` on a Team account whose Team is active on
  another computer gets `409 replaced` with that computer's label and `reclaimable: true`
  (`false` when reclaim is switched off), though nothing was revoked: its *Use it here* takes Team
  back. With the header that session gets `200` with the plan without Team and `team.active:
  "elsewhere"`. A Free account never gets `replaced` for a session it still has.
- `409 replaced` (a revoked session), with `message` naming the newer device (`"Your plan moved to <deviceName>."`)
  and a separate field `deviceName` carrying the same name, so the app never parses the message.
  From 1.175.0 `deviceName` is the server's generic label for the computer
  ("Mac mini"), not the computer's own name, and `message` reads "Your plan
  moved to another computer (Mac mini)." (before: "Your plan moved to
  <deviceName>.").
  Additive (QoL 1.168, 2026-10-21): `reclaimable: boolean` — whether `POST /session/reclaim`
  would take the plan back with this session. Apps up to 1.167.0 ignore it.
  **App (1.168.0 to 1.177.1, owner D1):** `replaced` keeps the account signed in on
  **Free** — the entitlement is dropped, the session token stays in the keychain —
  and "Use it here" calls `POST /session/reclaim`. Apps up to 1.167.0 sign out.
  **App 1.178.0:** nobody sees a `replaced` state and there is no *Use it here*: the
  entitlement goes, and from a server that echoes `X-Plyloft-Team-Choice` the session is
  taken back silently (see `POST /session/reclaim`); from an older server it stays signed
  in on Free.
- `401 unauthorized`: the session is gone (signed out elsewhere, revoked). The app treats
  it as signed out; there is no separate `signed_out` code.

### `POST /session/reclaim`

*Added 2026-10-21 (QoL 1.168 card 12.1, owner D1).* "Use it here" on a device a
newer sign-in replaced: the plan comes back **without a GitHub device code**.
`Authorization: Bearer <the replaced session's token>` and
`X-Plyloft-Device: <deviceId>` (must be the session's own); no body.

- The device proves it is the same signed-in account on the same device with what
  it already holds: its own session token (256 random bits, only in that device's
  keychain) and its device id.
- Allowed for an app session that was `replaced` within **90 days** (or is still
  active), **once per session**: the answer carries a **new** session token and the
  old one is dead afterwards (it answers `409 replaced` naming this device), so a
  copy of it can't take the plan back again. Never for a signed-out session.
- **Only sessions marked reclaimable** (`sessions.reclaimable`, Challenger H1):
  - false for every session that existed when migration 005 ran, so nothing
    replaced before the deploy (1.167.0 devices included) comes back;
  - set true when a session is replaced from then on (`POST /session`, a reclaim);
  - set false again by a fresh GitHub sign-in of the same user for every session
    replaced **before** it (a real sign-in ends a reclaim chain; the device it
    replaces now stays reclaimable), by `DELETE /session` (also on a replaced
    session: it becomes `signed_out`), by `POST /sessions/others/sign-out`, and
    by the reclaim of that session.
- `RECLAIM_ENABLED=0` (server variable, a restart, no deploy) switches reclaim
  off: the endpoint answers `401` and every `409 replaced` says `reclaimable: false`.
- At most **20 reclaims per user in 24 h that move the Team plan** (`429 rate_limited`;
  `session_reclaims.takes_plan`, 1.178.0; before, every reclaim counted), besides the per-address
  limit of `POST /session`.
- 1.178.0: **no other session is revoked.** The new session keeps what the old one had (Team
  active here, and the hint of a Team Checkout paid from here: `team_checkout_session_id` moves
  to the new session, its subscription stays).
  - **Without** `X-Plyloft-Team-Choice` (apps up to 1.177.1, *Use it here*): on a Team account the
    new session takes Team (counts towards the daily limit).
  - **With** it (app 1.178.0): **never moves Team** and **never counts** towards the daily limit
    (owner D3). It is how app 1.178.0 takes back, silently, a session a sign-in replaced before
    the 1.178 server: on `409 replaced` with `reclaimable: true` it calls this (at most once per
    retry window), stores the new token and reads `team`; no prompt. `reclaimable: false`, or a
    reclaim answered `401`, signs the account out quietly, as any `unauthorized` does (there is
    no sign-in screen in 1.178.0); any other failure leaves it signed in on Free until the next
    try.
- Audit: one `session_reclaims` row (user, from-session, to-session, the session
  that held the plan before, time) and a `plan reclaimed` log line, no tokens.

Response `200`: as `POST /session` (`{sessionToken, entitlement, account, team}`).
`401 unauthorized`: not reclaimable, replaced too long ago, already reclaimed,
signed out, unknown, or another device's id — the app signs out and asks for a
new sign-in. Two reclaims of one session at once: one wins, the other is `401`.

**A lost answer** (L1): the server has rotated the token before the answer
reaches the app (a dropped connection). The app keeps the old, now dead token;
its next reclaim is `401`, so it signs out and the person signs in again with a
GitHub code. Nothing else is lost; the plan is on this device on the server.

**App (1.168.0 to 1.177.1):** `reclaimable: false` in a `409 replaced` → sign out naming the
device ("Sign in here"), as 1.167.0 did; `true` or absent → signed in on Free with
"Use it here". App 1.178.0: see above (silent reclaim).

### `POST /sessions/others/sign-out`

*Added 2026-10-22 (Challenger H1).* App only (Bearer, an active session). Every
other app session of the user — active or replaced — becomes `signed_out` and
never reclaimable; this one stays. `200 { "signedOut": 2 }`. 1.178.0: on a Team account this
computer becomes the one where Team is active. Settings › Plan's
**Sign out other computers** (from 1.178.0 shown only where Team is active); the site may
offer it later (not yet). Apps 1.168.0 to 1.177.1 also offered **Sign in and sign out the
other computers** on a replaced device (the Sign-in screen and Settings › Plan): a GitHub
sign-in, then this call at once, so a session the new sign-in replaced can't reclaim in
between. 1.178.0 removed it with the Sign-in screen.

### `POST /session/use-team`

*Added 1.178.0 (owner, 2026-11-26).* **Use Team on this computer.** App only: `Authorization:
Bearer`, `X-Plyloft-Device: <deviceId>` (the session's own), no body. The account's Team plan
becomes active on this session; the computer that had it is **not** signed out and gets the plan
without Team (and `team.active: "elsewhere"`) at its next refresh.

- `200 { "entitlement": "PLY2-…", "team": { "active": "here", … } }`. Idempotent.
- `409 no_team` ("Your account has no Team plan right now."): Free, a comp Pro, a seat removed.
- `400` without `X-Plyloft-Device`; `401` with another device's id; `401`, `409 replaced`, `429`
  as on every route. Per-address limit of `POST /session` (20 a minute); no daily limit and no
  audit row. Log line `team computer chosen` (internal ids only: `userId`, `sessionId`, `moved:
  true|false` — false for a press where Team already was — and `fromSession`, the session that
  had Team before a move, or `null`).
- Serialised per user with sign-ins and reclaims (`FOR UPDATE` on the user row): two computers
  pressing at once leave exactly one with Team (the later one).

### One computer at a time: Team only

*1.178.0 (owner, 2026-11-26), amends ADR 0008 point 6.* A Free account (or a comp Pro) may be
signed in on any number of computers; none is ever revoked by another's sign-in. When the
account's plan is **Team** (owner, seat, or a comp team without `unlimitedDevices`), it is active
on **one** app session, recorded on the server (`users.team_session_id`, for that Team). The
others are signed the plan without Team.

A computer takes Team **by itself** only when:
1. its own Team Checkout was paid (the **Checkout hint**, see [`POST /checkout`](#post-checkout))
   and no computer holds Team yet, within 2 days of the payment;
2. it is the only computer **in use** (seen in the last 30 days) while no computer holds Team and
   no fresh hint names a signed-in computer;
3. it signs in (with the header) while no computer holds Team and no fresh hint names a signed-in computer.

Otherwise only `POST /session/use-team` moves it.

**The hint** (`users.team_checkout_session_id`, `team_checkout_at`,
`team_checkout_subscription_id`) applies only to a Team the account **owns and pays for**
(`teamRole: "owner"`, not a comp, not a seat somebody else assigned), and only while the
subscription its Checkout paid for is the one giving the account Team: a late Stripe event of an
older Checkout never hands a newer Team to its computer. It is used once: it is cleared as soon as
that Team is on a computer, however it got there, and any resolve clears it once expired.

**Upgrade from the old server** (migration 008): every account without unlimited devices that
had exactly one active app session gets the pointer set to it, with the provisional key `pre-008`,
so the computer that held the plan before the deploy keeps Team. The first resolve that finds the
account on Team writes the real key (`team:<id>` or `comp:<github id>`) before any other rule; one
that finds it without Team clears the pointer, so a Free account that gets a seat later starts
from no computer. An app without the header keeps the old rule
for Team accounts (its sign-in and its *Use it here* take Team; its other computers get `409
replaced`) — temporary, until no 1.177 apps remain.

Team stops being active anywhere when the plan stops being Team (seat removed or left, lapse,
comp removed): every computer reads Free/Pro, with no `replaced`. The choice is kept for that
team: the same team renewed is active on the same computer again; a seat on another team is not
taken by itself. Signing out the Team computer frees it (rule 2 then applies). A comp with
`unlimitedDevices` has Team on every computer, as before. Team management routes (`GET /team`,
`POST /team`, seats, `DELETE /team/seat`) work from every signed-in computer of the account.

#### The `team` field

In the answers of `POST /session`, `GET /entitlement`, `POST /session/reclaim` and `POST
/session/use-team`. Unsigned (UI only: what runs is decided by the signed `plan`). `null` when the
account's plan isn't Team; otherwise:

```json
{ "active": "here" | "elsewhere" | "nowhere", "teamRepo": "acme/board" | null, "teamRole": "owner" | "member",
  "device": { "name": "Mac mini", "platform": "macos", "lastSeen": 1764150000000 } | null }
```

- `here`: Team is active on this computer (`plan: "team"` is signed).
- `elsewhere`: on another computer, named by its generic label in `device` (never its own name).
- `nowhere`: on none yet — ready to be chosen (`teamRole` says "Your Team plan is ready" vs "Your
  seat on `teamRepo` is ready"; `teamRepo` is `null` before the owner binds one).
- `device` is set only with `elsewhere`. A comp with `unlimitedDevices` always reads `here`.

### `POST /switch-to-team` · `POST /switch-to-team/preview` (retired)

*Retired 1.178.0* with Pro (QoL 1.168 card 12.3 until 1.177.1). No Pro subscription can exist, so
both answer `410 plan_retired` ("Pro is no longer sold, so there is no Pro plan to switch. To start
a team, choose Team instead.") to anyone: no session or body is read, nothing is written, Stripe
is never called. They stay (rather than 404) so an app up to 1.177.1 shows that sentence. The
`consents` rows of earlier switches are kept.

### `POST /checkout`

Body: `{ "plan": "team", "interval": "month" | "year", "seats": 2 }`. `seats`: range 2–50 (default 2), and the quantity stays adjustable in Checkout within 2–50.

- 1.178.0: `plan: "pro"` answers `410 plan_retired` ("Pro is no longer sold: everything for one
  person is free in Plyloft. Update Plyloft to the latest version.") before Stripe is asked
  anything, also for an account that already pays.
- **The computer that pays takes Team** (1.178.0). Opening a Checkout writes nothing. From the
  app (an app session), the session id travels in that Checkout Session's own `metadata`
  (`appSessionId`, not `subscription_data.metadata`); from the site there is none. Each call
  expires the user's open Checkout Sessions and creates a new one, so a Session carries only its
  opener's id. The webhook's `checkout.session.completed` of a Team purchase (`metadata.plan =
  team`) records the hint for that session (followed through its rotations on the same device)
  and the event's `subscription`, before it syncs the subscription that brings the plan. With no
  computer to name (a site purchase, a computer signed out since) it clears a hint for no
  subscription or for its own, never another live one's; an event without a subscription writes
  nothing. A Checkout opened before the 1.178 server and paid after carries no `appSessionId`:
  the normal rules apply. Rules: [One computer at a time](#one-computer-at-a-time-team-only).

Response: `{ "url": "https://checkout.stripe.com/…" }`. The session's `client_reference_id` is the user's internal id.

- `409` with `{error:"already_subscribed"}` when a paid subscription is already active. The app then opens the Portal instead.

### `POST /portal`

Response: `{ "url": "https://billing.stripe.com/…" }`. It opens the Portal for the user's Stripe customer.

- `404 not_found` when the user never had a subscription (a Stripe customer
  created by an abandoned Checkout doesn't count).
- For a Team owner, the Portal session uses a configuration whose Team
  `adjustable_quantity.minimum` is `max(2, assigned seats)`, so seats can't be
  reduced below the people holding them. Configurations are reused per
  product, minimum and price set (metadata `plyloftProduct`, `plyloftMinSeats`, `plyloftPrices`). This
  replaces `seat_in_use`, which no endpoint returns.

### Optional `locale` (`POST /checkout`, `POST /portal`)

JSON body field `locale`: `"it" | "de" | "fr" | "es"`. Missing, `"en"` or any
other value means English and is never an error (strict allowlist). `POST /portal`
may still be sent with no body. The app sends none; the site sends it from its
localised pages. With a locale:

- Checkout `cancel_url` = `{SITE_ORIGIN}/{locale}/pricing` (English: `/pricing`).
- Checkout `success_url` = `{SITE_ORIGIN}/checkout/success?lang={locale}&session_id={CHECKOUT_SESSION_ID}`
  (English: no `lang`). The success page reads `lang` for its buttons.
- Portal `return_url` = `{SITE_ORIGIN}/{locale}/account` (English: `/account`).
- Stripe Checkout and Portal `locale` are set to the same language; English sends none (Stripe's `auto`).

### `GET /team`

For the caller's Team subscription, as owner or seat holder:

```json
{ "teamRepo": "owner/name", "owner": {"sub":"1","login":"a"}, "seats": 5, "assigned": [ {"sub":"1","login":"a"}, {"sub":"2","login":"b"} ], "status": "active", "interval": "month", "periodEnd": 1762592000000 }
```

`teamRepo` may be `null` before the bind. A lapsed team is returned with its
`status` (the app says the team's plan lapsed); `404` only when the caller never
had one.

### `POST /team`

Owner only. Binds the repo after payment: `{ "teamRepo": "owner/name" }`.

- `200`: as `GET /team`.
- `409 already_bound` if a different repo is already bound. Rebinding is not supported in this release.
- A **comp** with plan `team` may bind one repo too. Its seat limit is the
  comp row's `seats` (default 10). It is `teamRole: "owner"` with that repo
  once bound, and `teamRepo: null` before.

### `PUT /team/seats/{sub}` · `DELETE /team/seats/{sub}`

Owner only. `PUT` body: `{ "login": "b" }`.

- The owner's own seat is implicit and can't be deleted.
- `PUT` → `200` (as `GET /team`), or `409 seat_limit` when the assigned count equals `seats`.
- `DELETE` → `200`, or `404 not_found` when that person holds no seat on this team.
- Seat holders get `plan: "team"` at their next refresh, on the computer where they choose it
  (or by itself, see [One computer at a time](#one-computer-at-a-time-team-only)); removed ones,
  and the ones who left (`DELETE /team/seat`), drop to their own plan on every computer.
- `PUT` → `403 forbidden` when the one-team rule stops it (a seat on another
  live team, a Team plan of their own, a comp team; the three are never told
  apart and no team is named). From 1.175.0 the message is "<login> can't take
  a seat on this team yet. Only they can see why: ask them to open Settings ›
  Plan in Plyloft." (before: "<login> is already on another team."). `<login>`
  is the one the owner sent. The app shows `message` and never parses it.

### `DELETE /team/seat`

*Added 2026-11-09 (1.175.0, SRV-2).* The seat holder gives up their own seat
(**Leave this team**, and **Give up the seat…** in Settings › Plan). App only
(Bearer). No body and no parameters: nothing from the client names a team or an
account, the seat is the session's own. Every seat row of the caller goes, on
whatever team holds it.

- `200 { "left": true }`: a seat was held and is free now.
- `200 { "left": false }`: the caller held no seat. Idempotent: a second press,
  or a seat the owner freed meanwhile, is a success.
- `403 forbidden` ("You own this team, and the owner's seat can't be left."):
  the caller owns a live team and holds no seat on anyone else's. The owner's
  seat is implicit.
- `401`, `409 replaced`, `429` as on every route.

The caller's next `GET /entitlement` is their own plan (Free, or a comp Pro). The answer carries no entitlement: the app refreshes.

A server older than 1.175 answers `404 not_found` for this path. The app treats
that as a failure and changes nothing on the computer; it is never read as
"already free", which is why that case is a `200`.

Serialised with `PUT /team/seats/{sub}`: the team row, then the member's
advisory lock.

### Site web flow

These routes are for the site only:
- `GET /auth/github/start?return=<path>`
- `GET /auth/github/callback`

Sign-in failures redirect to `SITE_ORIGIN` + the sanitised `return` path (else `/account`) with `signin=error`. `POST /auth/signout` clears the site session (204, Origin-checked). These routes set an HttpOnly, Secure, SameSite=Lax cookie `plyloft_session` on `.plyloft.com`. With that cookie, the site calls `POST /checkout`, `POST /portal` and `GET /account` → `{sub, login, plan, periodEnd, status, cancelAtPeriodEnd, device: {name, platform, lastSeen} | null}` (`device`: from 1.178.0, for a Team plan held on one computer, that computer, or `null` while Team is active on none — migration 008's `pre-008` pointer counts as the current Team's; for Free, a comp Pro and a comp with `unlimitedDevices`, the newest signed-in computer). CORS allows only `https://plyloft.com` (plus `http://localhost:4321` in non-production).

### `POST /stripe/webhook`

The Stripe signature is checked. Events are deduped on `event.id`. On each event the server re-fetches the subscription and derives the plan as in LAUNCH_PLAN §3.3. From 1.178.0 a `checkout.session.completed` of a Team purchase first records or clears the Checkout hint ([`POST /checkout`](#post-checkout)).

## Plan derivation (server)

1. A comp entry → its plan (normally `team` with no repo, or `pro`), `comp: true`.
2. The user owns a Team subscription with status `active | trialing | past_due` → `team`, `teamRole: "owner"`.
3. The user holds a seat on such a **Team** subscription (or on a comp team) → `team`, `teamRole: "member"`.
4. The user has a Pro subscription with those statuses → `pro` (none can be bought from 1.178.0).
5. Otherwise → `free`.

When a user is both a member somewhere and Pro, Team wins. Only one team per user.

6. **Per session (1.178.0):** when the result is `team`, only the session where Team is active is
   signed `team`; the others get steps 1, 4, 5 without any Team source (a comp Pro, Pro, or
   Free). See [One computer at a time: Team only](#one-computer-at-a-time-team-only).
