# Team Mode — the mental model

> The app is **Ply**. The repo / crate / npm package keep the internal name
> `atelier`. This doc explains how two (or a few) developers work on the same
> projects without sharing credentials.

## The one hard rule

**Execution is always local, per developer, under that developer's own Claude
subscription.** Ply spawns the real `claude` CLI in a PTY and inherits the Max
session token from each user's `~/.claude/`. We never share a subscription, an
API key, or a session. (Hard Rule #1 — see `CLAUDE.md`.) So Team Mode is about
coordinating *what* gets worked on, never *how* it runs.

## Three planes

```
   GitHub (coordination)          Each Mac (execution)         The repo (shared config)
   ┌───────────────────┐          ┌──────────────────┐         ┌────────────────────────┐
   │ Issues ◀▶ cards    │          │ claude CLI (your │         │ <repo>/.atelier/library/│
   │ PRs     → ship      │  clone  │   own Max auth)  │  git    │   prompts.json          │
   │ reviews → merge      │ ◀────▶ │ ~/Library/.../   │ ◀────▶ │   swarm_templates.json  │
   │ outcomes → comments  │  pull  │   com.mbadv.ply/ │  push   │   templates.json        │
   │ (merge authority =   │  push  │   (PRIVATE: runs,│         │ <repo>/.atelier/agents/ │
   │  the owner)          │        │   settings, memory)│       │   *.json                │
   └───────────────────┘          └──────────────────┘         │   workspace_default.json│
                                                                └────────────────────────┘
```

Nothing runs on a server we operate. GitHub is the coordination plane, each Mac
is the execution plane, the repo is the shared-config plane.

## Where your data lives — three tiers

1. **Personal & machine-local** — `~/Library/Application Support/com.mbadv.ply/`.
   Your `workspaces.json`, `settings.json`, local kanban boards, swarm run
   history, snapshots, memory. **Never synced, never leaves your Mac.** Two
   developers have two independent copies. (A workspace in GitHub-Issues mode
   mirrors its cards to issues — see plane 3 — but the run state behind them
   stays local.)

2. **Shared via the repo** — `<repo>/.atelier/` (committed):
   - `library/prompts.json` — shared prompts
   - `library/swarm_templates.json` — shared swarm templates
   - `library/templates.json` — shared workspace-layout templates
   - `agents/*.json` — project-scoped agent configs
   - `workspace_default.json` — the per-repo workspace default
     (name/accent/layout/syncMode/ownerRepo) that onboarding imports on a fresh
     clone (shared-safe fields only — never identity/run state)

   These reach teammates as **ordinary git commits**. Ply writes the file when
   you Share/Promote an asset, but **never auto-commits** — you commit & push
   when you're ready, like any other change.

3. **GitHub** — Issues, PRs, reviews, outcomes. A workspace set to **GitHub
   Issues** kanban mode (`kanbanSyncMode: "githubIssues"`, `githubOwnerRepo`)
   mirrors its cards to issues in that repo and claims work via the issue
   **assignee**; run outcomes post back as issue comments and the ship PR links
   the issue (`Closes #N`). This is the shared source of truth for *what gets
   worked on* — see "What's shared vs not" below.

## Identity

There's no login screen. Ply reads `git config --global user.email` once at
startup and caches it as your identity (Settings → About shows "Signed in as
…"). Every shared-library write you make is stamped with `author` (on create)
and `lastEditedBy` (on edit). **Set your git email before first launch** or
those stamps stay empty until you set it and relaunch.

## Working with the shared library

In the Prompts library and the Swarm Templates editor, each item shows a
**Shared** chip when it lives in `.atelier/library/`. Per-item actions:

- **Share / Promote** — copy a personal asset into `.atelier/library/` (same id).
- **Unshare / Demote** — move it back to your personal store.
- **Fork** — make a personal copy with a new id.

Resolution at read time is additive; on an id collision the **shared** version
wins. Concurrent edits to the same `.atelier/library/*.json` are normal git
merge conflicts — resolve them like any file.

**Shared swarm templates need local agent bindings.** A shared template
references role ids (`scout`, `builder`, …). The first time you dispatch one in
a workspace where a role isn't bound to a local agent, Ply blocks the run and
tells you which roles to bind (suggesting matches from `.atelier/agents/`).
Bindings are per-workspace, per-user, and local.

## Ship policy

`main` is **PR-only**, and as of Phase 6 it's **enforced** by GitHub branch
protection (require PR + 1 approval, dismiss stale reviews, no force-push — see
`BRANCH_PROTECTION.md`). Ply's card "Ship as a PR" path
pushes the card's worktree branch and opens a GitHub PR (`gh`); it never pushes
to `main` directly. A committed `.github/CODEOWNERS` auto-requests the **owner**
on high-blast-radius paths; approval is *standard* (not codeowners-only) so the
PR author can self-merge once the owner approves. The **owner is the merge
authority** and the only producer of signed/notarized release builds (signing
credentials never leave the owner's Mac).

Two **read-only** in-app affordances surface this policy without leaving Ply
(awareness only — no merge/approve/push buttons): a "PRs awaiting your review"
widget on the workspace dashboard, and a ribbon above the editor that warns when
you're editing a CODEOWNERS-flagged file.

## What's shared vs what's NOT (current state, honest)

| Thing | Shared? | How |
|---|---|---|
| Prompts / swarm templates / user templates | ✅ | `.atelier/library/` via git |
| Project agent configs | ✅ | `.atelier/agents/` via git |
| Per-repo workspace default | ✅ | `.atelier/workspace_default.json` via git |
| Authorship stamps (`author` / `lastEditedBy`) | ✅ | on every shared record |
| Source code | ✅ | the repo |
| Ship / PRs / reviews / outcomes | ✅ | GitHub (`gh`); outcomes post as issue comments |
| **Kanban board / cards** | ✅ *in GitHub-Issues mode* | cards ↔ issues; claim via assignee |
| Local-only kanban boards | ❌ | a workspace left in `local` sync mode stays per-Mac |
| Swarm run history, snapshots, memory | ❌ by design | stays personal/local |

**Coordination:** in a GitHub-Issues workspace the board *is* the shared source
of truth — a card is an issue, you claim it by assigning yourself, and Ply
blocks moving a card you don't own. Run outcomes post back to the issue and the
ship PR links it. For a workspace still in `local` sync mode, coordinate
out-of-band (issue + assignees + PR comments) or flip it to GitHub-Issues mode.

## Out of scope (deliberately, at N=2)

No central server, no live activity feed / presence, no shared run history, no
shared memory, no users table or auth beyond `git config user.email`. Re-evaluate
if the team grows past a handful.
