# ADR 0001 — Builder/Challenger replaces role-chain swarms as the meaning of Run

Date: 2026-09-09. Status: accepted (owner decision, interview of 2026-09-09).

## Context

Ply's Run step dispatched a swarm: a chain of headless, stateless roles
(scout → builder → reviewer, or coordinator-driven pools) each launched as
`claude -p` or `codex exec`, handing artifacts through a mailbox. In spring
2026 this was the only way to get planning, execution and review from
single-shot CLIs. By September 2026 both CLIs orchestrate internally
(subagents, plan modes, skills, multi-agent review) with one shared context.
Ply's own development history confirms it: v1.64–v1.105 were built in long
interactive sessions, not by Ply's swarms.

## Decision

A Run is one live, human-attended **Builder** session (Claude Code or
Codex, TUI by default) in the card's worktree, started with the brief plus
any plan-challenge synthesis and the human's decisions on its disagreement
ledger. The other vendor is the **Challenger**: it challenges the plan on
request (Discussion pipeline) and always reviews the diff at "Build done",
read-only, in parallel with Verify. Changes requested and Verify failures are
injected into the open Builder session. Role-chain swarm templates move
behind Advanced, code intact, for later retirement.

## Consequences

- Ply's differentiator becomes the ring and the referee: worktree isolation,
  mechanical Verify, read-only cross-vendor review, git-canonical ship,
  evidence-backed Knowledge. Not orchestration of narrow roles.
- The Builder can ask the human questions and use its vendor's own
  subagents; no context is lost between plan, build and fix.
- Ply reads less structure from a TUI Builder than from headless JSON runs;
  Outcome shows diff, Verify and Verdict, not a role transcript.
- Processes are still never resurrected: a lost session offers native
  resume (`claude --continue`, `codex resume`) in the same worktree.
- The swarm modules stay in the tree until a month of non-use justifies
  removal; nothing is deleted in this decision.
- **Update, 2026-10-02 (launch decision D8, card G4):** the Advanced switch
  and everything it showed are removed from the UI — the card's agent and
  swarm template pickers, Brainstorm, the swarm notifications and the
  card-swarm cap row. `swarm_start` refuses a swarm for a card that never ran
  one; cards already running, suspended or queued for a swarm finish as
  before (resume and the queue pump are unchanged). The runtime stays.

## Alternatives rejected

- Keep role chains as the default Run: stateless, slow in fresh worktrees,
  mute, and redundant with the CLIs' internal orchestration.
- Drive the CLIs headlessly through Agent SDK / app-server only: violates
  the spirit of Hard Rule #1 today and depends on unsettled metering; a
  possible later evolution of this decision, not an alternative to it.
- Alternate two Builders on the same code: thrash. One Builder per card.
