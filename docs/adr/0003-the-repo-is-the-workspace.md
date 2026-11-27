# ADR 0003 — The repository is the workspace

**Status:** accepted, 2026-09-16. Cards GH #79–#82.

## Context

Two people opening the same GitHub repository in Ply got two workspaces
that drifted: only `.atelier/workspace_default.json` travelled, read once at
import, while the project config (integration branch, Verify pipeline,
version files, install script, caches) and the board backing lived per Mac.
For the product to work for people outside the owner's control, the two
workspaces must be the same with no setup and no instructions.

Alternatives considered: the team manifest carrying each workspace's config
(works only with a team); per-user overrides layered on a shared base
(reintroduces drift); propagation through card pull requests only (days of
latency, and a card PR carrying unrelated settings).

## Decision

The shared definition of a workspace lives in the repository, in a tracked
`.atelier/` folder, and is read live from the integration branch; the repo
always wins over the local copy. It covers identity, board, project config,
shared Knowledge and project skills. Tiles, editor state, personal Knowledge
and skills, CLI logins and agent models stay per user.

A change to the shared definition is published by Ply as a direct commit to
the integration branch, limited to `.atelier/` (and `.claude/skills/`),
never from the user's checkout, with a pull request as the fallback when a
push is refused. On the same field, the last writer wins and the other
author is told. A workspace whose board is a GitHub repository uses GitHub
Issues as its board, with existing local cards migrated to issues. Adoption
asks one question, once, to whoever opens a repo without a definition.

## Consequences

- Ply gains a write path to the integration branch. It is confined to the
  definition files; the rule that Ply never pushes code to main stands.
- A collaborator without write access sees the shared fields read-only.
- Licensing of the shared board for external users is a separate decision;
  the mechanism does not depend on it.
- The team manifest shrinks to a list of repositories.

## Amendment — 2026-10-01 (SP-5)

The write path to the integration branch also covers an **approved
improvement proposal** (a skill or instruction file, the same file limits) in
a workspace with **no** shared definition: the solo user's case. It is one
commit made with plumbing and a scratch index, from the branch tip's bytes,
never over a file that moved since the Challenger read it. With a remote it
is published at once through the same channel (a pull request when the file
moved); without one it is committed to the local branch, moving the checkout
only at the claimed paths and refusing when those are dirty. The button says
which: `Approve and publish`, or `Approve and commit to <branch>`.

## Amendment — 2026-10-23 (1.169.0, A2)

Each person's own model choices still stay per user (app rows, a
workspace's own rows, a card's). What is new is a **suggestion**: the shared
definition may carry `models` — a model and effort per role and vendor —
which applies below everyone's own choice for the workspace and above their
app rows (card > own workspace > team > own app > the tool's default). It
travels like every shared field (read live, published through the same
queue by whoever can push, read-only otherwise); a team suggests values
only, never "the tool's default".
