# Agent collaboration — program retrospective

> Written 2026-07-27 by Claude Code (Fable 5), the program's reviewer, at
> close-out on signed Ply v1.92.1. This is the entry point to the
> best-documented subsystem in the repo: read this page, then follow the
> links. Everything below shipped between 2026-07-23 (v1.87.0) and
> 2026-07-27 (v1.92.1).

## What this program built

Claude Code and Codex working on the same projects inside Ply — with shared
project knowledge, coordinated sessions, provably read-only reviewers, an
adversarial-but-fair two-agent discussion pipeline, and evidence-backed
Knowledge that traces every accepted entry to a landed Git commit.

| Capability | Shipped in | Core modules |
|---|---|---|
| Shared instruction convention (`AGENTS.md` canonical, `CLAUDE.md` = `@AGENTS.md`) + workspace doctor | v1.89.0 (Phase 1C) | `instruction` doctor in Settings |
| Read-only Knowledge MCP sidecar, injected ephemerally per provider launch | v1.89.0 (Phase 1A/1B) | `crates/ply-memory`, `crates/ply-mcp`, `mcp_launch.rs` |
| Advisory session records, same-worktree warning chips, snapshot-backed handoffs | v1.89.0 (Phase 2) | `coordination.rs`, `crates/ply-collab` |
| Unattended-writer exclusivity with queue-by-default (humans never refused) | v1.89.1 (Phase 3) | `coordination.rs` |
| Behaviorally-proved read-only reviewers with pinned detached worktrees | v1.90.0–v1.90.2 (Phase 4) | `review_capabilities.rs`, `reviewer.rs`, `review.rs` |
| Independent → cross-review → single-synthesis discussions with a lossless disagreement ledger | v1.91.0–v1.91.1 (Phase 5) | `discussion.rs` |
| Evidence-backed Knowledge proposals from landed ships, human-gated acceptance | v1.92.0–v1.92.1 (Phase 6) | `ship_evidence.rs`, `knowledge_proposals.rs`, `knowledge_generation.rs`, `crates/ply-memory/src/evidence.rs` |

## The documents

- **`PLAN.md`** — the approved MVP plan (revised from Codex's
  original coordination-kernel proposal after Claude's round-1 review).
- **`CLAUDE_REVIEW.md`** — the decision record. Four
  review rounds: the original critique and re-sequencing (Round 1), the
  revised-plan approval with nine refinements (Round 2), and the Phase 5 and
  Phase 6 design approvals (Rounds 3–4). The six owner decisions that shaped
  everything — advisory-for-humans, bounded runtime scope, labeled reviewer
  floors, locks cut, free-tier MCP, `AGENTS.md` canonical — are recorded
  there and are still binding.
- **`PHASE<N>_DESIGN.md` / `_EXECUTION.md` / `_FINDINGS.md`** — one triple
  per phase. Designs are contracts; executions are the rung-by-rung log;
  findings are the honest close-out including what the installed gate caught.

## How it was built (the part worth copying)

Three parties: the owner decided, Codex implemented, Claude reviewed —
adversarially, with independent verification of every phase (full workspace
suite + PPVP run by the reviewer, plus targeted code checks against each
design's promises). From Phase 5 onward, designs were written and approved
**before** implementation; drift stopped the rung.

The gates earned their cost by catching real defects that source-level
verification could not or did not:

- **v1.90.2** — installed reviewer probes failed because GUI apps don't
  inherit the shell PATH (Hard Rule #2, rediscovered live).
- **v1.91.1** — the first real discussion hit an over-budget ledger
  candidate; fixed by tuning prompts and retry mapping, never the validator.
- **Phase 6B fix** — review caught all four ship routes propagating
  proposal-persistence failures after Git had already succeeded; ships are
  now never rolled back for ancillary failures (see
  `docs/PATTERNS.md`, post-git best-effort rule).
- **v1.92.1** — the installed self-ship proved the generation wall timeout
  too tight; the bound was raised (the design fixed the *existence* of a
  bound, not its value), while interruption handling behaved exactly as
  designed throughout the failure.

## Invariants future work must keep

1. **Advisory for humans, exclusive for unattended writers.** A
   human-attended session is never refused; unattended writers queue per
   canonical worktree. (Owner decision #1; `coordination.rs`.)
2. **The MCP surface is mutation-free, forever.** Reads are free-tier;
   search returns evidence summaries, `knowledge_get` returns full
   envelopes. All writes go through the Tauri UI and its gates.
3. **Capability is proved behaviorally, per exact executable + version.**
   `prompt-only` never counts as a reviewer; write escapes downgrade the
   proof. Probe argv must equal launch argv.
4. **Evidence is mechanical; models produce only content.** The ship
   pipeline attaches provenance; citations are enrichment, never validity;
   human acceptance is the only transition into durable Knowledge.
5. **Git is canonical.** Nothing downstream of a successful land may fail
   the ship; post-git steps are best-effort with surfaced diagnostics.
6. **Paid attempts are marked before launch and never replayed
   automatically.**
7. **Records, not resurrection.** Session/discussion/proposal records
   describe executions; startup reconciles state, it never recreates
   processes.
8. Single-process coordination: one Tauri backend, process mutex, atomic
   JSON, startup reconciliation. No leases, heartbeats, or expiry — revisit
   only when a genuine second writer process exists (team tier, remote).

## Deferred by decision

- **Operational locks** (deploy/migration/branch mutual exclusion): cut from
  the MVP; the coordination schema is versioned so a remote-backed version
  can land with the team tier. The per-workspace `ShipRegistry` mutex is the
  only surviving operational exclusion.
- **Codex as a card/oneshot default runtime**: provider is recorded
  everywhere so this stays additive.
- **PR-merge reconciliation** for proposals (a PR-open is not a landed
  commit; a future merge-reconciliation path may invoke the same finalizer).
- **External-session visibility**: Ply cannot see terminals it didn't
  launch; enforcement scope is deliberately limited to Ply-launched
  unattended work.

## The closing proof

The final accepted Knowledge entry of the program — *"Treat Knowledge
proposal presence as a post-ship gate"* — was generated by the Phase 6
pipeline from the Phase 6F fixture ship (commit `0b81103`), carries a full
evidence envelope (diff digests, reviewer, discussion, five verification
receipts), was accepted by a human, and is retrievable by both Claude and
Codex through `ply-mcp`. The pipeline's first durable lesson is a rule about
the pipeline itself, with the receipts to prove it.
