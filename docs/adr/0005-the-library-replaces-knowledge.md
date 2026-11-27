# ADR 0005 — The Library replaces Knowledge; four scopes

**Status:** accepted, 2026-09-17. Interview with the owner the same day.

## Context

Knowledge (born "memory", v1.35) was designed when a note injected by Ply was
the only way to tell an agent something. Since v1.116–v1.117 skills and agent
instructions are shared through the repository and the team library, in the
CLIs' own formats, loaded even outside Ply. After four months of real use the
owner's Mac held 18 notes (the newest from July), no saved prompts, and
post-ship lessons he had almost never seen — against 34 project skills in one
repository and 65 personal skills. Knowledge still held the only pinned
right-hand panel, while skills and instructions sat inside Settings › Project,
where they are content, not settings, and caused most of its clutter.

Alternatives considered: retiring notes outright (throws away on-demand
search by agents and the shared notes just built in #82); relabelling
Knowledge and leaving skills in Settings (answers nothing); ranking
duplicates so the most specific skill wins (a hidden rule; the CLIs already
tell copies apart by origin).

## Decision

Everything a person gives the agents lives in one surface, the **Library**, a
centre mode beside Board, Code and Terminals: instructions, skills and notes,
each with its scope. Instructions and skills carry the weight; notes are
kept working and receive no new investment; saved prompts leave the
interface. Text is edited in Code, the one home of the editor; the Library
reads, compares, publishes and promotes.

Skills have four scopes. **Ply** skills ship inside the app, are updated
with it, and are switched on or off per Mac (a per-workspace exception comes
later); the first four cover writing a card brief, verifying before saying
done, answering the Challenger, and release and status notes. **Team** and
**Repository** skills work as today. **Personal** skills in the user's own
CLI folders are shown read-only with Promote; Ply never writes them. The
same name at several scopes is allowed and flagged with a comparison. Which
CLIs a skill reaches is a property of the skill, with an action that keeps
both copies aligned.

The post-ship lesson becomes an **improvement proposal**: after a card that
met friction, at most one suggested diff to a skill or to the instructions,
shown in the Ship step and in the Inbox, published through the shared
channel when approved. Nothing is pinned to the right of the centre any
more; a panel appears there only for what is on screen.

Fixed on the boards (2026-09-17): the Challenger writes the improvement
proposal, in a short read-only pass of its own, and a proposal may change only
the repository's skills and instructions. The agent instruction files
(`AGENTS.md`, `CLAUDE.md`) travel on the shared channel too, but never by
"last writer wins": a direct commit when the file has not changed upstream
since the edit began, a pull request otherwise — they are long documents that
people edit by hand. A duplicate skill has no winner; its notice can be
silenced per Mac until either copy changes.

Liveness has one home, the sidebar. The 54 px Live rail (v1.70) is retired
with the right-hand panel: the live sessions of the active workspace are
listed under its Terminals entry, each with its run-state dot, and a click
opens the session. A strip of the window for three icons was not worth the
width once nothing else stood on that side (owner, on the first boards,
2026-09-17).

## Consequences

- Settings › Repository keeps Definition and Build & release; Agent
  instructions and Skills move to the Library.
- Ply becomes a distributor of skills: their quality is part of the product
  and they need an owner and a review habit.
- If notes stay unused they can be retired by a small card; the sidecar's
  search goes with them.
- Build order: foundations (tokens, components, the PPVP check, the Settings
  shell), the Library, the Settings pages, skills for both CLIs, Ply skills,
  improvement proposals, search in Settings.

## Amendments

- **Notes' surface retired (UX-9.5, v1.150–v1.151).** The Library holds
  instructions and skills; the Notes page and the panel code are gone
  (ARCHITECTURE, retired `MemoryPanel.tsx`). What agents already read on
  demand through the sidecar is unchanged. Read "instructions, skills and
  notes" above as the decision taken on 2026-09-17.
- **Proposals, as built (#104).** The proposal's own home is its target's
  Library page; the Inbox row and the Ship step's line open it there.
- **Who owns the skills that come with Plyloft (group B decision §9,
  2026-09-30).** The owner is Matteo, the product owner. The habit: at every
  release that changes a file under `src-tauri/resources/ply-skills/`, the
  owner reads each changed skill whole — as a member's agent would meet it,
  in somebody else's repository — before the release goes out, and the
  release note says which skill changed. The mechanical half is a PPVP step,
  "bundled Plyloft skills (owner check)" (`ply_skills_tests.rs`): frontmatter
  `name` equals the directory, `description` present, with a trigger
  sentence starting "Use " (`Use when…`, `Use on…`, `Use before…` — the
  sentence an agent decides by) and at most 1024 characters, each skill at most 16 KB, no Plyloft-internal term (Tier, PPVP,
  STATUS.md, docs/, scripts/, AGENTS.md, Plyloft) and no absolute path. The
  check guards the shape; whether a skill is still good advice is the
  owner's read.
- **Which skills a review follows (GH #216, 2026-09-30).** The read-only
  Claude Reviewer, Challenger and proposal pass get the `Skill` tool, with
  writes still denied. They follow the repository's skills **as the
  integration branch has them**: every branch skill arrives as the
  `project` plugin, built from the mirror, and nothing is loaded from the
  card's worktree (`--restricted` ignores its `.claude/skills` anyway). A
  Builder could add or change a skill in the card telling the reviewer to
  approve; the reviewer follows the rules already on the branch, never the
  ones under review. Team and Plyloft skills arrive as plugins, as for any
  session; personal skills do not reach a review. Codex reads `.agents/skills` from its working directory
  with no switch to stop it, so every review's detached read worktree has
  its skill folders (`.claude/skills`, `.agents/skills`, `.codex/skills`)
  replaced before the pass (`pinned_read::pin_skills_to`) by the
  integration branch tip's — the same skills Claude's `project` plugin
  carries: the workspace's mirror build, or with no mirror `origin/<target>`
  as last fetched, never the local `<target>` ref a Builder's session could
  move; with neither, no repository skills. The Challenger's improvement
  proposal pass is pinned the same way. The change's own skill files stay in
  the reviewed commits and the diff, and are also written, as the reviewed
  commit has them, to `.ply-review/changed-skills/` (outside every skill
  root) so a reviewer without `git show` reads them as code. A skill root
  holding a symbolic link is left out. The write guard compares against the
  pinned state, the side folder included. Probed with codex-cli 0.158.0: without it a
  skill planted in the card was listed and used; with it only the branch's. A workspace without a shared
  mirror (its library not shared on the branch) gives the Claude reviewer no
  repository skills at all. How a skill shows in a review: the answer is the review
  schema's JSON (ADR 0006), which has no free text, so a skill shapes
  **what** is checked, and the answer's `skillsFollowed` names each skill
  used with what it asked of the review (a line or token it asks for,
  verbatim). The card's review shows `Followed: <skill>` under the verdict
  and the notes last. Walked on 2026-09-30: before this field, a Claude
  Challenger loaded `review-rules` with the Skill tool and could not put
  its token anywhere.
- **Skills never override either (skills group B §2, 2026-09-30).** The owner
  chose the full rule before launch: a repository skill travels like the
  instruction files, never by "last writer wins". `Update on <branch>`,
  `Remove from <branch>`, `Align` and an approved proposal on a skill record,
  per root, the branch's tree the change was made against; if a root the change
  writes is not that tree any more when it is published — any file edited,
  added or removed, in either CLI's copy — the commit waits in a pull request
  `Skill: <name>` instead, and the row shows `Open pull request`. For `Update
  on <branch>` that base is the version the checkout's copy was last in sync
  with (the one this Mac last published from it, or the branch's version in the
  checkout's own history), not the mirror's latest — otherwise a teammate's edit
  fetched a minute before the press would be written over. A brand-new skill
  is committed; a plain `Make available to both` copy cannot override anything
  and is committed as before. Notes keep "last writer wins" with the author
  named in the commit.
- **Five scopes and three switch levels (Skills hub, 2026-10-16; spec §13
  C5–C6).** [ADR 0009](0009-skills-hub.md) adds **My library**, a personal
  library in the member's own private GitHub repository, so the four scopes
  above become five; it is a git library like the team's, not the member's
  CLI folders, which Plyloft still never writes. The per-Mac switch for a
  Plyloft skill is now the last of three levels: workspace, then team (the
  owner, off only), then this Mac. A repository copy of a library or
  Plyloft skill can be linked to its origin and updated through a card.
