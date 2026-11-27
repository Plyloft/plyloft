# Ply — glossary

Terms as used in the product and the code. Definitions only; no
implementation detail. Decisions live in `docs/adr/`.

## Card lifecycle

- **Card** — one unit of outcome on a workspace board. Steps: Intake, Run,
  Outcome, Ship.
- **Intake** — the conversation that sharpens a card into a brief before any
  code is written.
- **Brief** — the card's notes plus its dispatch prompt: what the Builder is
  asked to achieve, with the decisions already taken.
- **Run** — the step in which a card's code is changed. Since the
  Builder/Challenger model, a Run is one live Builder session in the card's
  worktree, not a chain of headless roles.
- **Finish and check** (called "Build done" before UX P-B) — the explicit
  human declaration that the Run is complete.
  It moves the card to Outcome and starts Verify and the Challenger's review.
- **Outcome** — where the human reads what happened: the diff, the Verify
  result, the Challenger's verdict.
- **Verify** — the mechanical gate (the project's verify pipeline, for Ply
  itself `ppvp.sh`). Never an LLM judgement.
- **Ship** — landing the card: branch pushed, pull request opened, or merged
  live per project setting.

## The two contenders

- **Builder** — the live, human-attended agent session that changes code in
  a card's worktree. One vendor per card (Claude Code or Codex). Chosen from
  the Settings default, overridable per card at Run.
- **Challenger** — always read-only. Challenges the plan (see Plan
  challenge) and reviews the diff (see Verdict). It is the other vendor when
  both are available, which gives the more independent review; with only
  one vendor on the machine (or the other unavailable) it is a separate
  session of the Builder's own vendor, and the review says so.
- **Vendor** — Anthropic (Claude Code) or OpenAI (Codex). Ply never shares
  credentials between vendors or between people.
- **Reviewer** — the Challenger acting on a diff. Kept as the UI word for
  that phase.

## Challenge

- **Plan challenge** — an opt-in Discussion on a card's brief: independent
  analyses by both vendors, cross-review, one synthesis written by the
  Builder's vendor, and a disagreement ledger.
- **Disagreement ledger** — the list of points the two vendors did not
  reconcile. The human decides each; those decisions travel with the brief
  into the Builder session.
- **Build snapshot** — the commit Ply makes of the card worktree at Build
  done, so Verify and the Challenger examine one fixed revision.
- **Pending message** — a verdict or Verify result waiting to be delivered
  to a Builder session that is not at its prompt yet.
- **Verdict** — the Challenger's review result on a diff: approve or changes
  requested, with reasons. Changes requested are injected into the still-open
  Builder session; they never start a fresh session by themselves.
- **Finding** — one defect the Challenger reports, with its severity. **P1**
  breaks data or function. **P2** is a real defect in a plausible case. **P3**
  is an improvement or a remote case. P1 and P2 block; a P3 is listed as
  non-blocking and never changes the verdict.
- **Risk checklist** — the classes of risk a review must walk before it may
  give a verdict, answering each with findings or "checked, nothing". A core
  ships with Ply; a repository adds its own classes in its shared definition.
- **Self-check** — the Builder going over its own work against the risk
  checklist at Finish and check, before Verify and the Challenger see it.
- **Sweep** — the Challenger's first review of a card: the whole change
  against the brief and the risk checklist, reporting everything it finds,
  not the first defect.
- **Follow-up review** — every review after the sweep: the earlier findings
  and the diff of the fixes, to confirm each finding is closed and to look for
  what the fixes broke.
- **Synthesis pass** — when a change is reviewed in several passes, the last
  one: it looks only for defects that sit between files of different passes.
- **Ship with follow-up** — after repeated changes-requested rounds, shipping
  the card while its open findings become a new card.

## Team and sharing

- **Workspace** — a local folder registered in Ply, always one Git
  repository. Everything Ply keeps per project (board, terminals,
  Knowledge, skills) hangs off a workspace.
- **Team** — the group of people who share workspaces and a library. A
  team is defined by its **team repo**; a person is a **member** when the
  team's manifest lists them and GitHub lets them read the team repo.
- **Team repo** — the GitHub repository that defines a team: its
  manifest (name, members, team workspaces) and its team library. Owned by
  the team owner; there is no Ply server behind it.
- **Team owner** — the person who created the team and the only one who
  adds members and team workspaces.
- **Team workspace** — a repository listed in the team manifest. A member
  can pick it in Ply and get it cloned and registered as a workspace.
- **Team library** — the Knowledge and skills that belong to the whole
  team, across projects, stored in the team repo. Any member with write
  access to the team repo can share into it.
- **Team key** — a signed license key that names a team and its team
  repo. Optional while teams are free during the beta (owner decision
  2026-09-27): a member joins with an **invite code** from the owner, or
  directly when GitHub already gave them access to a team repo. Existing
  keys keep working.
- **Scope** — where a setting, a note or a skill lives, and so who gets
  it. **Ply**: ships with the app, the same for every user; switched on or
  off per Mac. **Team**: in the team library; every team workspace gets it.
  **Repository**: part of the shared workspace definition; everyone who
  opens the repo gets it. **This Mac**: kept on this machine only; it does
  not follow the person to another Mac. One vocabulary for the whole app.
- **Library** — everything a person gives the agents, in one place:
  **instructions** (the repo's and This Mac's agent instruction files),
  **skills** and **notes**, each with its scope. Instructions and skills
  are the forms that carry the weight; notes are kept, not grown.
- **Note** — a short written fact an agent can search on demand. Formerly a
  "Knowledge entry".
- **Improvement proposal** — after a card that met friction (repeated
  Challenger objections, a failed Verify, a correction by the user), Ply's
  suggested change to a skill or to the instructions, shown as a diff to
  approve. At most one per card.
- **Knowledge scopes** — scope plus reach (*one project* or *everywhere*).
  **Workspace** = This Mac, one project. **Global** = This Mac, everywhere.
  **Project** = Repository (the scope previously labelled "Team").
  **Team** = Team.
- **Skill** — an instruction package a vendor CLI loads (Claude Code
  skills, Codex skills/plugins). **Ply skill** = written for Ply and shipped
  inside the app; Ply hands the ones switched on to the sessions it
  launches. **Team skill** = lives in the team library and Ply hands it to
  the sessions it launches; it may carry skills and agents, never hooks.
  **Project skill** = lives in the repo and the CLI loads it natively.
  **Personal skill** = lives in the user's own CLI folders on This Mac; the
  CLI loads it natively and Ply never writes it.
- **Promote / Install** — moving a skill or Knowledge entry up to the team
  library, or down from it into a project. Same words in both directions
  as for Knowledge today.

- **Shared workspace definition** — the part of a workspace that belongs to
  the repository, not to a person: identity, board, project config, shared
  Knowledge and project skills. It lives in the repo (`.atelier/`), is read
  from the integration branch, and wins over any local copy. What is not in
  it (tiles, editor state, This Mac's Knowledge and skills, CLI logins, agent
  models) has scope This Mac.
- **Integration branch** — the branch a workspace's cards start from and
  land on, and where its shared definition is read and written. The repo's
  default branch unless the definition names another.
- **Publish** (a shared change) — Ply committing a change to the shared
  definition, a shared Knowledge note or a project skill onto the
  integration branch on the user's behalf, or opening a pull request for it
  when a push is refused.

## Retired vocabulary

- **Swarm**, **role chain**, **scout / critic / coordinator** — the
  pre-Builder/Challenger model of headless specialised roles. Still runnable
  under Advanced; no longer the meaning of Run.
- **Team** as a Knowledge scope label for "shared inside one repository" —
  renamed **Project**; "Team" now means the cross-project library.
- **Knowledge** as a section of the app, and **lesson** for what a card
  taught — the section became the **Library**, its entries **notes**, and a
  lesson an **improvement proposal** aimed at a skill or the instructions.
  Saved **prompts** were never used and left the interface.
- **Personal** / **Shared** as scope labels — replaced by **This Mac**,
  **Repository** and **Team**. "Personal" suggested something that follows
  the person; nothing in that scope leaves the machine.
