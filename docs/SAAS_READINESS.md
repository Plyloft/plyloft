# Atelier — SaaS-readiness lens

> This is **not a build plan**. It is a decision lens. Nothing here is scheduled
> for implementation. Its job: make current "fundamentals" development choose
> options that keep a future product pivot cheap, without committing to that
> pivot now.

## Context

Atelier today is a personal Mac workspace shell — a tool used to drive
Claude Code / Codex agents across personal projects. The question on the table:
could Atelier become a product a stranger downloads as a `.dmg` from a website
and pays a monthly subscription to use?

We are **not** building that now. But the idea is worth carrying as a lens,
because a few choices made carelessly during normal development would be
expensive to undo later. This doc captures the decisions made, the
"no-regret" principles to follow now, and the deferred product work — so the
later pivot (if it happens) is a known quantity, not a surprise.

## Status at the 1.158.0 launch (2026-10)

> **Superseded 2026-11-26 by [ADR 0010](adr/0010-free-for-one-person-open-source.md)** (1.178.0) for the plans: Free is everything for one person with no card limit, Pro is retired, Team is €9 per member a month from two members with no founding price, the account is needed only for Team, and the app's code is open source (MIT).

The pivot happened. What below was deferred is now done, or decided otherwise:

- **Deferred work 1–5, done.** Signed and notarized Mac builds, Windows
  builds, guided onboarding with the dependency doctor, the auto-updater, and
  now licensing, a backend and payments: the Plyloft account (GitHub sign-in),
  the licence server `plyloft-server`, and Stripe
  ([ADR 0008](adr/0008-plyloft-account-and-licence-server.md),
  LAUNCH_PLAN).
- **Decisions that changed:** there is **no trial** (Free plan instead: one
  card building at a time). Pricing is Free, Pro at €9 a month, and Team at
  €9 per member, with a founding price while it is open (no fixed end date
  since 2026-11-09; before: until 2026-11-30). The bundle id is
  `com.mbadv.ply` and the product name is Plyloft.
- **Open questions answered:** the price is set; a lapse never stops running
  work, and paid plans hold for 3 days past the paid period offline; support
  is support@plyloft.com.
- **Principle 4 still holds.** The server knows the GitHub id and login,
  device names, and the Stripe subscription. It never receives code,
  transcripts or project data. The AI is still the customer's own
  subscription (Hard rule 1).
- **Still open:** the legal texts (Terms, Privacy, Cookies) and the lawyer's
  review; the production environment and live Stripe.

## Decisions locked (from brainstorm, 2026-05-15)

| Question | Decision | Consequence |
|---|---|---|
| Where does the AI come from? | **Customer brings their own** Claude/Codex subscription | Atelier stays a pure orchestration shell. **No API keys, no token billing, Hard Rule #1 survives intact.** Core architecture unchanged. |
| How do customers pay? | **Monthly subscription** for the app itself | Needs a licensing check + backend *eventually* — not now. |
| Free trial? | **Yes — ~7 days** (card-up-front vs not: TBD) | Whenever the license system is designed, it must support a time-limited trial state from the start. |
| Who is the customer? | **Vibe coders** (build real things with AI, not deep engineers) | Onboarding must be near-zero-friction; errors must be friendly and specific. |
| How does this affect what we build now? | **Just inform decisions** | No product-shell work scheduled. Only: avoid painting into corners. |

## The headline: the pivot is additive

Because the customer brings their own AI subscription, **none of the hard parts
change**: the PTY-subprocess model, swarms, per-card worktrees, the diff viewer,
the ship pipeline, atomic persistence — all stay exactly as they are. A paying
customer wants the *same engine* you already built.

The "product" is a **shell around** the existing app: onboarding, code signing,
auto-update, and a license check. That's why "just inform" works — there is no
race, no deadline, no rewrite. We are simply not building walls.

## Value proposition (why someone pays)

"One app to manage all your projects" is true but it is the *table-stakes*
half — Superset, Nimbalyst, and Claude Code's own desktop app all already do
multi-project. Aggregation alone will not justify a fee *on top of* a customer's
Claude Max subscription.

The defensible half is **autonomy + structure**: in Atelier the Kanban board
*is* the control panel. You describe a task on a card, drag it, and an agent or
multi-role swarm picks it up, works in an isolated copy of the code, and hands
back a reviewable diff — across all your projects, without babysitting a
terminal.

One-line pitch: **"Your projects run themselves. You review the results."**
The multi-project surface is the hook; the autonomy is the product. This is why
the feature roadmap (parallel swarms, review surface, coordinator)
*is* the monetization work — those features are the thing being sold.

## No-regret principles to follow during current development

These are cheap to honor per-change and expensive to retrofit. Apply them as a
review checklist on every future cycle:

1. **Don't hardcode personal identity into new code.** No personal name, no
   machine paths, no machine-specific assumptions baked into features. The
   bundle id `com.matteo.atelier` can stay for now (renaming it later moves the
   data directory — a one-time migration), but don't *spread* personal strings.
2. **Don't deepen the Atelier-ships-itself coupling.** The in-app Ship button
   currently rebuilds Atelier via `scripts/install-local.sh`. That self-ship
   path must stay a clearly-flagged special case in `src-tauri/src/ship.rs`.
   Customer projects must ship only through the *general* `project_config`
   path. When touching `ship.rs`, keep the two cleanly separated.
3. **Never assume a tool exists.** Any new feature that shells out to `git`,
   `claude`, `codex`, or `node` should fail with a friendly, specific message
   ("Claude Code CLI not found — install it, then sign in") instead of a raw
   error. Cheap per-feature; this is also the seed of future onboarding, and
   it helps you today too.
4. **Keep customer code on the customer's Mac.** Never add telemetry or
   analytics that sends file contents, transcripts, or project data
   off-machine. If crash reporting is added later, scope it to non-content
   metadata only. "Your code never leaves your Mac" is a real selling point —
   protect it by default.
5. **Build features a stranger could use.** Avoid features that only make sense
   for one specific developer's own workflow. The feature roadmap (parallel
   swarms, review surface, coordinator, card dependencies) all pass this test —
   keep it that way.

## Deferred product work — enumerated, not scheduled

If the pivot happens, this is the shell, roughly in the order it would be
needed. Listed so it is never a surprise:

1. **Code signing + notarization** — Apple Developer Program (~$99/yr).
   Smallest effort but chronologically first: an unsigned `.dmg` triggers a
   scary Gatekeeper warning or is blocked outright. Nothing ships externally
   without this. (Currently marked "out of scope" in `docs/UPDATING.md` /
   `docs/RELEASING.md` — that note would be revisited.)
2. **First-run onboarding + dependency doctor** — detect `git` / `claude` /
   `codex`, guide install and sign-in. The single biggest piece for a
   vibe-coder audience. Principle #3 above pre-seeds it.
3. **Auto-updater** — Tauri ships a built-in updater plugin; needs signed
   releases plus an update feed. Replaces today's manual rebuild.
4. **Licensing / activation** — a launch-time "is this subscription active?"
   check. Needs the backend below.
5. **Backend + website + payments** — Stripe monthly subscription, a download
   page, a small license API. This is the actual "SaaS" infrastructure.
6. **Pre-release audit pass** — sweep for personal assumptions, generalize the
   ship pipeline, confirm principles 1–5 hold everywhere.

## Bundle identifier — decide the name now, rename later

The app's hidden internal id is `com.matteo.atelier` (in `tauri.conf.json`). It
drives the data-folder location (`~/Library/Application Support/<id>/`), the
code-signing certificate, and app identity. The personal name in it looks
unprofessional in a product (customers glimpse it in macOS permission dialogs).

Decision: **pick the final neutral id now** (e.g. `agency.mbadv.atelier` or
`app.atelier`), but **do the actual rename later, bundled with code signing** —
signing needs the final id anyway, so the rename + one-time data migration
happens exactly once. Until then: don't hardcode `com.matteo.atelier` into new
code (principle #1). Renaming requires a first-launch migration that detects the
old data folder and moves it to the new one — otherwise existing workspaces look
lost.

## Open questions to settle *when* you pivot (not now)

- Trial mechanics: card-up-front or not; what the app does when the 7 days end.
- Exact monthly price.
- Grace behavior: what happens to a customer's in-flight swarms if their
  subscription lapses mid-run?
- Support channel (email? Discord?).
- ~~Does Atelier ever update the customer's `claude` CLI, or leave that to them?~~
  Answered 2026-09-27 (guided onboarding, `docs/onboarding/`): Ply installs
  the CLIs with consent and offers **Update** when one is too old or a newer
  version exists; it never updates on its own.

## How this re-ranks the feature roadmap

It mostly **doesn't** — which is the reassuring part. The Fundamental-tier
features from the competitive assessment are all things a paying vibe-coder
wants:

- Lift the one-active-swarm gate → true parallel swarms
- A first-class Review surface
- LLM-driven coordinator
- Card dependencies (board-as-DAG)

The only adjustment: the **Review surface** and **friendly error states** get a
small priority bump. A paying non-expert needs to *trust and understand* what
the agents did to their code. In practice, "just inform" means: build the same
features — but build each one so a stranger could use it.

## Verification (for a lens doc)

There is no code to run. "Verification" = apply this checklist when reviewing
any future change:

- [ ] Does it hardcode a personal name, path, or machine assumption? → fix
- [ ] Does it assume `git`/`claude`/`codex`/`node` exists without a friendly
      failure? → add a specific error
- [ ] Does it send file contents / transcripts / project data off-machine? → remove
- [ ] Does it deepen the Atelier-ships-itself coupling in `ship.rs`? → isolate
- [ ] Could a stranger with their own Claude subscription use this feature? → if no, reconsider

If all checks pass, the change is product-safe and no pivot cost was incurred.
