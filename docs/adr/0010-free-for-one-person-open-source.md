# ADR 0010 — Free for one person, paid for teams, and the app's code is open

**Status:** accepted, 2026-11-26 (owner decisions 1–9 of the 1.178.0 plan);
built for 1.178.0 on `next/1.178.0` (app) and `next/free-and-team`
(`plyloft-server`). Amends [ADR 0008](0008-plyloft-account-and-licence-server.md):
its context (the plans), points 1, 4, 6 and 7, and three of its consequences.
The contract between the app and the server is still
[LAUNCH_API](../plans/LAUNCH_API.md).

## Context

From 1.158.0 Plyloft was sold as Free (one card building at a time), Pro
(€9 a month: cards in parallel and the individual extras) and Team (€9 per
member), with a founding price while it was open, and every computer needed a
Plyloft account (ADR 0008).

On 2026-11-26 two facts changed the picture:

- **A free MIT competitor.** Orca (Stably AI) is a free, MIT-licensed desktop
  app that runs Claude Code, Codex and other CLI agents in parallel, each in
  its own worktree, on Mac, Windows and Linux, on the subscriptions people
  already have. Against it, a paid plan for one person's parallel cards is
  hard to defend.
- **Nobody had subscribed to Pro.** Retiring it needs no refund and no
  migration.

## Decision

1. **Two plans: Free and Team.** Free is everything one person does, with no
   card limit: cards build in parallel, and *Build with both*, *Release N
   cards…*, My library and every other individual feature are on. Pro is
   retired. `Plan::Pro` still parses and verifies, and reads as Free in the
   app (`account.rs`, `license.rs`); the server still derives `pro` for a
   comp Pro (or a Pro subscription row, though none exists) so that apps up
   to 1.177.1 keep cards in parallel. `POST /checkout {plan:"pro"}` and both
   `switch-to-team` routes answer `410 plan_retired`.
2. **The account is optional.** A Plyloft account (GitHub sign-in, identity
   only, as in ADR 0008) is not needed to work alone, and there is no
   full-window sign-in screen. Setup's *Plyloft account* step can be skipped.
   Starting or joining a team asks for the sign-in at that moment; a team
   action without it is refused with its own reason.
3. **Team: €9 per member per month, from two members.** Yearly is €86.40 per
   member. There is no founding price. Team is bought from the site or the
   app (Checkout: 2–50 seats, 2 by default).
4. **A sign-in revokes nobody.** One person may be signed in on any number of
   computers. Only a Team plan or seat is active on **one** computer, recorded
   on the server (`users.team_session_id`, migration 008), and moved with
   *Use Team on this computer* (`POST /v1/session/use-team`). The app sends
   `X-Plyloft-Team-Choice: 1` on every call; the server echoes it and says
   where Team is in the unsigned `team` field. The signed `PLY2` payload does
   not change: a computer where Team isn't active is signed the plan without
   Team. A computer takes Team by itself only when its own paid Checkout
   names it, when it is the only computer in use while none holds Team, or
   when it signs in while none holds Team. A comp with unlimited devices has
   Team on every computer.
5. **The app's code is open source.** MIT licence, copyright MB Adv
   (`LICENSE`, and the licence field of the crates and `package.json`). It
   goes to a **new public repository**, `plyloft/plyloft`, with a fresh
   history made by `scripts/export-public.sh`. The name "Plyloft" and its
   logo are not covered by the licence. This repository (`atelier`) stays
   private as the archive. After launch, development and releases move to
   the public repository.
6. **The price change, the open code and the new site ship together** as one
   announcement.

## Alternatives considered

- **Open the code in this repository.** Its history holds plans, walk
  records, test accounts and internal paths. Rejected: a new repository with
  a fresh history, exported from a reviewed tree.
- **Keep "one computer at a time" for every plan.** It revoked a Free
  person's other computers at each sign-in, which makes no sense once Free is
  everything for one person. Rejected: only the paid Team plan is held on one
  computer.

## Consequences

- **What Team sells** is what the app's team gate (`license.rs`,
  `team_allowed`) still guards: the shared GitHub Issues board with claims
  (`github_board_runs_here`, `team_gate_github_card_write`), the team library
  (skills, prompts, templates, Knowledge), teammates' pull requests in a
  card's overlap check (`card_overlap_check`; the local half runs on every
  plan) and the pull requests a teammate asks you to review in the Inbox
  (`inbox.rs`), plus seats and invitations. The shared project setup (*Share*)
  is not Team: it works without a plan.
- **What stays private:** `plyloft-server` (the licence server, Stripe and the
  signing keys), this repository as the archive, the release secrets (Apple
  signing, the updater key, the `PLY2` private key) and the internal plans the
  export leaves out (`docs/plans/`, among others).
- **Team on one computer.** A person on Free with two computers who receives
  a seat chooses where it runs; nobody's individual work stops on either
  computer. Team management (`GET /team`, seats, *Give up the seat…*) works
  from every signed-in computer of the account.
- **Old apps.** Apps up to 1.177.1 decide the card limit locally, so a Free
  account stays on one card at a time there until it updates; a comp Pro keeps
  parallel cards. They send no `X-Plyloft-Team-Choice`, so for a Team account
  their sign-in and *Use it here* still take Team (owner D4, temporary) and
  their other computers get `409 replaced`; a Free account is never
  `replaced`. *Get Pro* in them shows the `plan_retired` sentence.
- **Release order.** The 1.178 server goes to staging, then production,
  before app 1.178.0 is released: against the old server, app 1.178.0 stays
  on Free and shows no Team state ([RELEASING](../RELEASING.md)).
- **The update feed doesn't move.** Installed apps keep updating from
  `MatteoB-adv/ply-releases` with the same updater key.

## What this amends in ADR 0008

- **Context:** the plans are Free and Team, not Free, Pro and Team.
- **Point 1:** the account is optional for one person and required only for
  Team (no longer "required for everyone, Free included").
- **Point 4:** Checkout is for Team only; there is no *Upgrade* to Pro.
- **Point 6 (One device):** replaced by decision 4 above. Signing in no
  longer revokes another computer; only Team is held on one computer.
  `POST /session/reclaim` stays for sessions replaced before the 1.178 server
  and for apps up to 1.177.1.
- **Point 7:** Pro stays in the derivation for comps and old apps, and grants
  nothing more than Free.
- **Consequences:** a first launch no longer needs a connection; "access can
  end" applies to Team only; "devices beyond one" is no longer out of scope
  (Free has no device limit).
