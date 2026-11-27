# Team sharing — design

Owner decisions of 2026-09-10 (interview on the MacBook, build on the Mac
mini). Vocabulary is in [`CONTEXT.md`](../../CONTEXT.md) — read that first;
this document never redefines a term. Why the team is a GitHub repo and not a
service: [ADR 0002](../adr/0002-team-is-a-github-repo.md).

## Goal

A member of a team gets, with one paste, access to the team's workspaces,
its shared Knowledge and its shared skills — guided by Ply, enforced by
GitHub, with no Ply server. A third developer who joins tomorrow works on a
team workspace with the same context and the same validation mechanisms the
owner has built up.

## The model

- **Team repo.** A private GitHub repository chosen by the team owner. It
  holds:
  - `team.json` — the manifest: team name, members (GitHub logins, one
    marked owner), team workspaces (`owner/repo` list, optional display
    name and default branch).
  - `library/knowledge/` — Team-scope Knowledge, same on-disk format as the
    per-repo `.atelier/library/knowledge/` (which becomes the Project scope).
  - `library/claude/` — a Claude Code plugin directory (skills and agents;
    no hooks).
  - `library/codex/` — a Codex plugin marketplace with the same skills.
- **Membership** = listed in `team.json` AND able to read the team repo on
  GitHub. Ply explains which of the two is missing when someone cannot get
  in.
- **Permissions.** The owner is the only one who edits members and team
  workspaces. Anyone with GitHub write access to the team repo can share
  into the library (Knowledge, skills). GitHub is the enforcement; Ply only
  reads `gh` to know what it may offer.
- **Joining.** The team key (`PLY1-…`, Ed25519-signed, minted by
  `scripts/issue-license.sh`) gains an optional `team_repo` field. Pasting
  the key in Settings › Team both activates the paid tier and points Ply at
  the team repo. Keys without the field keep working as today.
- **Team workspaces.** The manifest list is the truth. Ply shows the list
  as a picker; a picked repo is cloned under the clone root (Settings ›
  Team, default `~/code`) and registered exactly as `import_default` does
  (the repo's committed `.atelier/workspace_default.json` applies). Assisted
  discovery (accessible repos that carry a `workspace_default.json`) only
  proposes; the owner decides.
- **Team library writes.** Ply commits and pushes the team repo itself:
  pull before every write, commit, push, and a clear message on conflict.
  A member never has to know there is a repository behind the library.
  A clone left ahead *and* behind GitHub (a pending commit plus a
  teammate's publish) is offered "Reapply mine on top" (GH #226): a backup
  ref, a rebase onto GitHub's branch, a plain push — never a force-push; a
  collision is aborted with the clone as it was and the file named.
- **Skills delivery.** Ply passes the team library to the sessions it
  launches — Claude via `--plugin-dir`, Codex via a Ply-owned `CODEX_HOME`
  overlay that links the member's own home and adds the marketplace (the
  per-session config override this first assumed does not exist; see
  team-tier/ROADMAP.md) — and never writes into `~/.claude` or `~/.codex`.
  Project skills (in the repo's native directories) are loaded by the CLIs
  themselves; Ply lists them and offers Promote (to team) and Install (from
  team into the repo).
- **Knowledge scopes.** Two axes in the panel: Personal / Shared ×
  Project / Everywhere. The scope previously labelled "Team" is relabelled
  "Project"; its files do not move. "Team" is the new Everywhere-shared
  scope, backed by the team library.
- **Paid gate** (unchanged from the team-tier roadmap): reading, cloning
  and loading are free; sharing into the library, adding members and team
  workspaces need a valid key.

## Local state (per machine)

- The team repo is cloned by Ply under app support (`team/<slug>/`) and
  pulled at launch, on window focus and before every library write. It is
  never a workspace.
- The clone root for team workspaces and the member's GitHub login (read
  from `gh`) are settings; nothing else new is persisted.

## Candidate for rung 5 — merge policy in the manifest (owner note, 2026-09-10)

`team.json` may declare who merges: the owner only, any member, or only
after a review. Ply applies it on every member's Mac without setup: Builder
sessions it launches get a permission deny on pushes to the default branch,
Ship offers only "Ship as a PR" when the policy requires review, and a
GitHub branch protection, when the team's plan has one, is detected and
respected. This turns the hand-installed git guard hook into product
behaviour. Not scheduled yet.

## What this program does not do

- No live presence, no chat, no remote agent control (the shared-workspace
  scope decision of 2026-09-09 stands).
- No hooks in team skills until Ply can show a member what would execute.
- No branch protection or code-owner enforcement — still a GitHub-plan
  limit, still convention-enforced.
- No migration of existing Knowledge files: only labels change.

## Acceptance — one journey

From the MacBook (owner): create the team, add `atelier` and one more
workspace, mint a key. On the Mac mini (member, second GitHub account with
write access): paste the key, pick both workspaces, open a card; the Builder
sees team Knowledge and team skills. The member shares one lesson and one
skill; both appear on the MacBook. The whole journey runs on the mini
without the owner's help.
