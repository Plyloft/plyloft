# ADR 0009 — The Skills hub: linked copies, libraries that keep themselves current, one view of every skill

**Status:** accepted, 2026-10-16 (owner decisions D1–D17 and §14 answers in
the Skills hub spec); built in phases H1–H10,
2026-10-16 → 2026-10-20. Amends [ADR 0005](0005-the-library-replaces-knowledge.md)
(scopes and the Plyloft switch, spec §13 C5–C6). Keeps
[ADR 0002](0002-team-is-a-github-repo.md) (no server for skills) and
[ADR 0008](0008-plyloft-account-and-licence-server.md) (plans are checked
offline from the `PLY2` entitlement). H1–H10, the 2026-10-19 fixes
and the owner decisions of 2026-10-20 are on `main` (H10 as PR #430, the
decisions as #429), released together as 1.167.0.

## Context

Up to 1.166.0 a skill lived in one of four scopes (ADR 0005) and Plyloft
showed them one workspace at a time. A copy from the team library into a
repository was a plain, untracked set of files with no memory of where it
came from, so nothing could tell a member that the team's version moved on,
that their edit and the team's now disagreed, or that the same skill sat in
six repositories. The team clone was pulled only when Settings › Team was
opened, and Claude's `--plugin-dir` pointed into the clone's working tree, so
a pull would have changed what a running session read (spec §1, correction
2). A solo member had no way to carry their own skills across computers.

Alternatives the spec weighed and left: a Plyloft server holding skills
(ADR 0002 rules it out; GitHub is the store and the access list); symbolic
links into a library (break on Windows without Developer Mode and change
under running sessions); background updates that write a repository
(break "a repository changes through a card"); a pull request against
yourself when one member edits My library on two computers (Q4: an in-app
compare instead).

## Decision

**Principles kept.** Nobody's work is written over: a write whose base
moved becomes a pull request or a question. A repository changes only
through a card or the shared channel, never from a background job. Plyloft
never writes the member's own CLI folders (`~/.claude`, `~/.agents`,
`~/.codex`). What a session loads is fixed when it starts. Hooks and MCP
servers in anything shared are refused. No telemetry, no server for skills.
Every phase ships on Mac and Windows together.

1. **Session snapshots (H1, D13).** A session gets each library as a
   content-named snapshot built from the git objects of one commit — one per
   Claude plugin, one per Codex marketplace, named by tree id, never the
   clone's working tree, no lock on the launch path. A pull never changes a
   running session; the next session gets the new version, and a session
   whose skills moved shows *Skill updated after this session started*.
   Snapshots are plain files on every platform, pruned after 30 days
   unstamped and past 512 MB per library (Q25). Measured 2026-10-16 with
   Claude Code 2.1.302: Claude re-reads a cwd skill, so repository skills
   show no such line. Card chat and `codex app-server` get no library skills
   (accepted gap).

2. **The team library pulls itself (H2, D1, D16, D17).** At startup, every
   10 minutes (± jitter), on wake and after a team write, as the team's gh
   account, only with the Team plan. A change by someone else is one toast
   (*Ana changed review-rules*). Offline, sessions keep the last copy and
   the section says when it was last updated. GitHub refusing the
   repository three times over 30 minutes asks before switching the library
   off on this Mac; leaving the team moves the clone to the Trash / Recycle
   Bin. A lapsed plan keeps today's delivery rule (Q7). Team Knowledge stays
   live (Q21). `TeamManifest` keeps unknown keys, so mixed app versions keep
   later fields.

3. **Linked copies and the skill card (H3a, H3b, D2, Q1, Q2, Q24, Q29).** A
   copy in a repository records its origin in a committed link record, one
   file per skill: `.atelier/skill-links/<name>.json` (origin, version, the
   base of each CLI's copy, `keptMine`; GitHub names and commits only, never
   a person or a path). Install, Update, Copy to…, Link, Remove, Detach,
   Rename, Align and Personalize each make a **skill card**: one commit
   written by Plyloft on the target branch, opened at Ship. Ship skips
   Verify (*Not needed — only skill files changed*) only when it computes on
   the commit that nothing outside the skill and its link changed; a skill
   card never holds the Free plan's card slot and runs no install script
   (Q23). A skill card sent to a Builder becomes an ordinary card. The
   untracked Install is retired. Copies installed before links are offered
   **Link** / **Link all** when they equal a version in the library's history.

4. **Never override, in both directions (H4, D3, D7, D8).** A copy edited
   here is *Modified here* and stays linked. When the library also moved it
   is *Both changed*, with an Inbox row and a 3-way Compare: **Keep mine**
   (records the decision), **Take upstream** (a card), **Propose mine
   upstream** (a pull request in the team library from a
   `plyloft/skill-<name>-<timestamp>` branch). Nothing the library does
   writes a repository. **Promote** to the team library compares the skill
   with what this Mac last saw: changed meanwhile → a pull request, never a
   push over it; branch protection → a pull request; read-only → a plain
   sentence. A skill removed or renamed upstream asks once per workspace
   (*Keep* / *Remove*, *Rename here* / *Keep the old name*), and only from a
   clone this Mac trusts — an unreadable origin is *not available on this
   Mac*, never *removed*.

5. **Twins (H5, D12).** A skill's Claude and Codex copies are one row. When
   exactly one changed since the last aligned state (link record, a per-Mac
   ledger, or the card's base) it wins: a Builder card is aligned when its
   run ends, before Verify, so Verify and Ship read one tree. When both
   changed, **Align** asks which wins and chooses nothing for the person
   (owner, 2026-10-19). `.codex/skills` is never written.

6. **Scripts need your OK (H6a, H6b, D15, Q15, Q26).** A shared skill that
   brings a script or a non-text file waits for this Mac's OK: library
   deliveries keep the previously approved version until then (H6a, shipped
   before the background pull); Install, Update and Copy to… show the files
   before the card is written (H6b). Approvals are per Mac. Owner decisions:
   an OK follows a rename upstream when the scripts are identical
   (2026-10-19); **Publish to <branch>** in a shared workspace asks for a new
   or changed script first, since no card reviews it (2026-10-19); a script
   the other CLI's copy already holds on the branch asks nothing
   (2026-10-20). A script outside a skill's
   own folder refuses its plugin, as hooks do.

7. **All skills (H7, D4, D14, Q17, Q18).** An app-level page in the sidebar
   lists every skill this Mac can see — each workspace's repository skills
   (warm or cold, never warmed by it), the team library, My library, this
   Mac and Plyloft — with its scope, CLIs, link state and **Used in**. It is
   drawn over the workspace hosts, which stay mounted. Its count is muted;
   the Inbox keeps the one accent count (C9). The index hashes content in
   process (git's tree ids), caches in `skills_hub/index.json`, and starts no
   watcher, PTY or GitHub call.

8. **Copy to… (H8, D5).** A skill copied into other workspaces on this Mac
   arrives in each as a skill card writing a linked copy; free on every
   plan. A workspace origin with a GitHub repository is committed; a
   local-only or this-Mac origin is kept on this Mac (`localLinks`).
   "Upstream" for a workspace origin is what is committed at its checkout's
   `HEAD`, never an uncommitted edit. A destination that is not a git
   repository is refused.

9. **Plyloft skills: versions, Personalize, the switch (H9, D9, Q3, Q9,
   Q27).** Each bundled skill shows its version and what changed
   (`resources/ply-skills/CHANGES.json` and the history, checked by PPVP and
   `release.sh`). **Personalize** forks one into a repository (a skill card,
   free) or the team library. The switch has three levels: workspace → team
   (owner only, can only switch off) → this Mac. Owner, 2026-10-20: a fork
   switches Plyloft's copy off where the fork is (its link record beside its
   copy); Personalize writes no workspace definition, so no checkout that
   hasn't pulled the fork is left without either copy. A workspace's choice
   is kept on this Mac in `projects/<ws>/ply_skills.json` and, for a shared
   workspace, published as `library.plySkills` in `.atelier/workspace.json`.

10. **My library (H10, D6, Q4–Q6, Q22, Q28).** A
    Pro member's own private GitHub repository under a gh account they
    choose (any account, no match with the Plyloft account), in the team
    library's layout, cloned on each of their computers, pulled in the
    background and delivered to their sessions as `mine` (Codex marketplace
    `plyloft-mine`). Skills only, no Knowledge. Two computers that both
    changed a skill get an in-app compare (*Keep this Mac's* / *Keep the
    other's*), judged against the version each computer last published.
    Links to it may be committed into shared repositories (the create sheet
    says the repository's name becomes visible). **The scoped push
    exception (owner, 2026-10-20, AGENTS.md on that branch):** My library
    pushes only to the member's own My library repository, only the skill
    they pressed *Add to My library* for (or *Create it again*), by an
    explicit refspec, never forced; nothing else of it is written to GitHub.

**Plans (D11, spec §9).** Free: All skills, Copy to…, Link, 2-way Compare,
Removed / Renamed choices, Align, script approvals, Plyloft versions and
switches, Personalize into a repository. Pro: linked updates (Update, the
3-way Compare, Keep mine, Take upstream, Propose mine upstream, updates of a
personalized fork) and My library. Team: the team library and its
background pull. Every gated control stays visible with its mark; the
backend refuses on its own. Lapses never stop running work or delivery.

## Consequences

- ADR 0005's four scopes become five (My library is a new git library, not
  `~/.claude/skills`), and its per-Mac Plyloft switch is the last of three
  levels. "Personal skills … Ply never writes them" is unchanged.
- The card is now also how a library reaches a repository, so the ship
  gate, the Free slot rule and Ship batch know a skill card kind
  (`KanbanCard.kind`). An older app reading a board drops the kind and the
  card becomes ordinary (it then needs Verify) — accepted, boards are per Mac.
- Per-Mac state grows: `skills_hub/state.json` (approvals, pull records,
  proposals, the twin ledger, local links, My library bases), the base
  store, snapshots, the index cache, the stage repository and the My
  library clone (ARCHITECTURE persistence map). All derived files are safe to
  delete with Plyloft closed; `state.json` and the settings are not.
- A third scoped push exception exists beside `card_ship` and
  `card_pr_push_update`, recorded by the owner in AGENTS.md.
- Not built, and still the spec's defaults until the owner says otherwise:
  the per-Mac *Updated* chip and the `seen` / `dismissed` keys of §5.2 (All
  skills has *Changed recently* instead); the *Keep libraries up to date in
  the background* switch and Settings › Library (no such page yet); the
  3-way Compare, Keep mine, Propose and removal choices for a Plyloft fork;
  Update from Plyloft for a fork personalized into the team library;
  *Edit in Code* at the My library compare; proposals to My library,
  another workspace or Plyloft.
