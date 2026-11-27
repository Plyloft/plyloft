# Builder / Challenger — design

> **Status 2026-09-09: implemented, v1.106.0–v1.110.0.** Deviation: the
> Codex chat form of the Builder (D3) is deferred; Codex builds in its TUI.

Decided with the owner on 2026-09-09 (interview, 17 decisions). Vocabulary
in `CONTEXT.md`; structural decision in `docs/adr/0001`. This document is
the build authority for v1.106–v1.110; each rung ships alone through PPVP,
STATUS and `release.sh`, with a one-Mac Tier 4.

## Goal

Get the most out of Anthropic's and OpenAI's models used together: one
full-agency **Builder** per card, the other vendor as read-only
**Challenger** on the plan and on the diff, inside Ply's mechanical gates
(worktree, Verify, git-canonical Ship, evidence-backed Knowledge). Ply is
the ring and the referee; the human is the tiebreaker.

## Decisions (D1–D17)

| # | Decision |
|---|---|
| D1 | Contenders are **Builder** and **Challenger**. Challenger is always the other vendor. "Reviewer" is the UI word for the Challenger on a diff; "Critic" is retired. |
| D2 | Builder vendor: default in Settings › Behavior (Claude), overridable per card at Run. |
| D3 | Codex Builder form is a Settings choice: **TUI** (default) or chat (app-server). TUI always launches with `--sandbox workspace-write`. |
| D4 | Role-chain swarm templates move behind **Advanced**; code intact; removal reconsidered after a month of non-use. |
| D5 | **Plan challenge** is an opt-in button on the Intake step (Phase 5 Discussion). |
| D6 | **Build done** is an explicit button in the card. It moves the card to Outcome. The Builder tile stays open. |
| D7 | The Challenger's diff review starts **always** at Build done, in parallel with Verify. "Skip review" checkbox mirrors "Skip verify". GH #135: it is one press — the Build done that uses it, and start/resume of a session, clear it. |
| D8 | **Changes requested** are injected into the still-open Builder session. Never a fresh session by itself. GH #135: the card records the settled verdict as unsent (`BuilderState.undeliveredVerdict`) rather than relying on the Run step being mounted when the review settles, so it reaches the Builder when the card is next opened — once per verdict, marked delivered per session. The human can accept the Builder's pushback instead (Build done + Skip review on an unchanged tree, or the header button): the review is recorded as overridden, and Ship and the PR body say so. |
| D9 | Sequence: v1.106 live Run (Claude) → v1.107 Codex Builder → v1.108 Challenger on diff → v1.109 Plan challenge → v1.110 swarm behind Advanced. Then P0-4 is the first real card of the new flow. |
| D10 | Builder start prompt = brief + Discussion synthesis + the human's ledger decisions, composed by Ply. Brief only when no challenge was run. |
| D11 | The Builder tile lives **inside the card's Run step** (lifecycle owns the center), and appears in the LiveRail. |
| D12 | Verify failure: the tail of the output is injected into the Builder session; full log saved in the worktree. |
| D13 | App relaunch: card shows **Session lost** + **Resume** (`claude --continue` / `codex resume` in the same worktree). No process resurrection. |
| D14 | Permissions: native CLI confirmations by default; per-card checkbox **Build without asking** launches with bypass (`--dangerously-skip-permissions` / `--full-auto`). The checkbox copy states the risk. |
| D15 | Plan-challenge synthesis is written by the **Builder's vendor**; disagreements go to the human. |
| E1 | Build done makes a **build snapshot** commit of the worktree on the card branch (even if the Builder did not commit). Verify and the Challenger work on that revision. |
| E2 | Single installed vendor: the review runs **same-vendor, degraded and labelled**, never skipped silently. |
| E3 | Ship **closes the Builder tile**, with confirmation. |
| E4 | The Challenger's verdict is posted to the PR as a comment at Ship (v1.108, reusing the outcome comment). |

## Rules that follow (no owner decision needed)

- **Injection contract.** Text goes into the PTY with bracketed paste. Keep
  the injected message short; put the full verdict or verify log in
  `<worktree>/.atelier/build/<n>-{verdict,verify}.md` and reference it.
  Inject only when the tile is at its prompt (`promptBoxIdle === true`,
  the v1.34/v1.105 attention signal). Otherwise hold it as a **pending
  message** with a visible chip in the card; deliver on the next idle.
- **Verify vs Builder race.** At Build done, inject "Verification is
  running on snapshot <sha>; do not edit until the result arrives", then
  run Verify; inject the result afterwards.
- **Build snapshot commit** message: `build: snapshot <n> for <card title>`.
  Skipped when the tree is clean (the Builder committed itself). Never
  pushes. Ship's existing preflight and land paths are unchanged.
- **The Builder may push or open PRs on its own.** Not preventable; the
  composed prompt says "Do not push or open pull requests; Ply ships." An
  accepted limit, documented in the brief template.
- **Claude has no sandbox.** Only permissions. "Build without asking" copy:
  "The Builder can change files outside this card's worktree."
- **Challenger unavailable** (vendor missing, not logged in, capability
  probe fails): review recorded as skipped with the reason; Ship never
  blocked (agent-collab invariant #5). E2 covers the single-vendor case.
  When the vendor's probe is already running (the automatic re-probe after
  a CLI update), the Challenger waits for it, up to 90 s, instead of
  starting on the stale record or racing a second probe.
- **Provider failure mid-review** (GH #99, decided 2026-09-17): a failure that
  passes with time (capacity, rate limit, 5xx, network, a timeout before any
  output) retries the failed pass once, after 30 s, and the card says
  "Challenger unavailable — trying again in 30 s". Anything else, or a second
  failure, leaves the review failed: the card says "The last commit was not
  reviewed" with the reason, Review again and Ship anyway, and a PR body says
  it too. A verdict belongs to the revision it read; an approval of an older
  commit is not the card's verdict.
- **History.** Each Build done appends to `verifyHistory` and
  `reviewDecisions`; Outcome shows the latest with the history below.
- **Swarm cards in flight** keep running on the old code; the lifecycle
  derivation accepts both states. New card fields are `serde(default)` with
  a Tier 2 load test.
- **Stale challenge.** Notes edited after a Plan challenge show "plan
  changed since the challenge" with a re-run offer.
- **Update prompt** while builds are live: "N builds in progress" and a
  "later" option (relaunch kills PTYs by Hard Rule #4).
- **Two Builders on two cards** may run concurrently: human-attended
  sessions are never refused (agent-collab invariant #1). Verify jobs keep
  their existing per-workspace serialization.
- **Knowledge MCP** is already injected into interactive PTYs for both
  vendors (`pty.rs` → `mcp_launch`); nothing to add.
- **Intake stays Claude.** Outcome for a live session shows diff, Verify and
  Verdict; there is no role transcript.

## Rungs

### v1.106 — live Run (Claude)
Run opens a Claude REPL tile in the card worktree, inside the Run step, with
the composed prompt sent as first input. Build done → build snapshot →
Outcome + Verify. Verify tail injection. Build without asking. Session lost
+ Resume (`--continue`). Ship closes the tile with confirmation. Persisted:
`builder` on the card (`{vendor, form, bypass, sessionTileId?, snapshots[]}`,
serde default) + Tier 2 test. Swarm dispatch stays reachable under a
temporary "Run as swarm" secondary action until v1.110.
Tier 4: throwaway card, Run, ask for a one-line change, Build done, Verify
green, Ship; relaunch mid-build, Resume continues the thread.

### v1.107 — Codex Builder
Settings › Behavior: default vendor, Codex form (TUI default). Per-card
override at Run. TUI launches with `--sandbox workspace-write`; chat uses the
existing app-server session. Resume via `codex resume`. Injection into the
TUI uses the v1.105 Codex prompt-box matcher for the idle gate.
Tier 4: same card with Codex TUI, then chat.

### v1.108 — Challenger on the diff
At Build done, in parallel with Verify, the Phase 4 independent reviewer
runs with the other vendor on the build snapshot. Verdict in Outcome;
changes requested injected; Skip review checkbox; same-vendor degraded
label; verdict appended to the PR comment at Ship.
Tier 4: build with a deliberate defect, verdict finds it, injection,
fix, second Build done, green verdict; PR shows the verdict.

### v1.109 — Plan challenge
"Challenge the plan" on Intake runs the Phase 5 Discussion with the
Builder's vendor as synthesizer; ledger decisions UI; composed Builder prompt
includes synthesis + decisions; stale-challenge hint.
Tier 4: brief with an open choice; vendors diverge; decide; Builder follows
the decision.

### v1.110 — swarm behind Advanced
Templates and Settings › Swarm templates under Advanced; the temporary "Run
as swarm" action removed from the primary flow; UI strings aligned with
CONTEXT.md; update prompt shows live builds.
Tier 4: no scout/critic wording in the normal flow; swarm still runnable
from Advanced.

## After the staircase

Milestone C resumes as cards of the new flow: P0-4 (first pilot, Builder
Codex TUI, Challenger Claude), P0-3 split in two cards, P0-1, claim warning.
Astra's chat is not part of the loop; the file-based protocol in
`docs/team-tier/C_PROTOCOL.md` remains a documented fallback only.

## Out of scope by decision

Removal of swarm modules; Agent SDK / headless app-server drivers; a non-
Claude intake; process resurrection; mandatory plan challenge; field-level
merge of verdicts.
