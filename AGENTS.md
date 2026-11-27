# Atelier

Workspace shell for macOS and Windows (Plyloft; ids and paths are still `com.mbadv.ply`/`ply`): Tauri 2, React 19, Vite and TypeScript.
Each project workspace has files, a CodeMirror editor, terminal tiles, Kanban,
agent configurations and prompts. Source lives in `src/` and `src-tauri/`.

## Hard rules

1. **Agents use the user's own subscription through the official CLIs in a PTY.**
   Claude Pro or Max through `claude`, or ChatGPT through `codex`. Ply never uses
   the Anthropic SDK or an API key of its own. Rust `portable-pty` spawns the CLI,
   which inherits authentication from its own login (`~/.claude/`, `~/.codex/`);
   do not replace it with JS node-pty. A second Claude subscription is Claude's
   own login in its own folder (`CLAUDE_CONFIG_DIR`, `ai_accounts.rs`); Plyloft
   never reads the login, only whether one exists.
2. **Inject the cached PATH into every PTY spawn.** GUI apps do not read shell
   startup files. Use `shell_env::init()` and the `pty.rs::spawn` pattern.
   Plyloft's own Setup and Repair install, update and removal steps get the
   system folders appended after their PATH, and its own `gh` children built by
   `github_account::apply_to_gh` or `project_setup::Tools::gh` the probed
   working git's folder: on Windows appended, through `apply_to_gh` only, when
   their PATH lacks it, and on a Mac whose probe found no Command Line Tools,
   through either, in front when `/usr/bin` would come first (Setup's terminal
   `gh` steps, such as the clone and `gh auth setup-git`, get neither); tiles
   and agents get the cached PATH as it is, with none of these additions.
3. **Persist JSON atomically:** tempfile plus rename, never an in-place write.
   This covers workspace/settings/board/agent/prompt/template/snapshot state.
4. **Kill children on app exit.** `ExitRequested` kills AgentRegistry then
   PtyRegistry; new long-running children need equivalent cleanup. The
   automatic Codex update and Repair spawn only through their allowlisted
   runners and are killed at exit.
5. **Window close hides; it does not quit.** Preserve hide + prevent_close,
   `RunEvent::Reopen` re-show on dock click, and Cmd-Q as the actual quit path.
6. **Keep `dragDropEnabled: false` on the main window.** Enabling it breaks
   internal HTML5 drag/drop on macOS. Finder drops use the HTML5 drop handler
   and `fs_save_dropped_file`; see the [runtime invariants](docs/agent-collab/PROJECT_RUNTIME_INVARIANTS.md).
   `onDragDropEvent` (`@tauri-apps/api/webview`) is not an option: with the flag
   off, Tauri 2.11 never installs its handler. Do not re-enable the window flag.

## Read for the affected task

- Current shipped state, deferred work, known issues or a resumed feature:
  relevant sections of [STATUS](docs/STATUS.md).
- Structural changes, IPC or persistence layout: [ARCHITECTURE](docs/ARCHITECTURE.md).
- React/zustand or persisted struct fields: [PATTERNS](docs/PATTERNS.md) before editing.
- PTYs, runs, Kanban or swarms: [runtime invariants](docs/agent-collab/PROJECT_RUNTIME_INVARIANTS.md).
- Codex tiles: [tile design](docs/codex-tiles/DESIGN.md).
- Sign-in, plans, gates, seats or billing: [LAUNCH_API](docs/plans/LAUNCH_API.md)
  (the app ↔ `plyloft-server` contract), [ADR 0008](docs/adr/0008-plyloft-account-and-licence-server.md)
  and [ADR 0010](docs/adr/0010-free-for-one-person-open-source.md) (Free and Team, open source).
- Feature acceptance: [PPVP](docs/PPVP.md), including applicable schema and UI tiers.
- Installation/release: [UPDATING](docs/UPDATING.md), [RELEASING](docs/RELEASING.md),
  and [installer recovery](docs/ux-revamp/P3_0_INSTALLER_RECOVERY.md).
- Non-trivial choices affecting the eventual downloadable product: apply the
  five-point review in [SAAS_READINESS](docs/SAAS_READINESS.md). It is not a build plan.

Persisted app state is in `~/Library/Application Support/com.mbadv.ply/`;
`migrate.rs` handles the pre-rebrand directory. Read the persistence map before
touching live state; an implementation request does not authorize resetting it.

## UI and lifecycle invariants

- Render per-workspace hosts for **all warmed workspaces**. Hide inactive ones
  with `visibility: hidden; pointer-events: none`; do not unmount terminals or
  editors on workspace/tab switches. Unmounting disposes xterm and kills PTYs.
- Keep the editor container div mounted unconditionally; overlay the empty state.
  Its one-time EditorView effect cannot attach to a conditionally absent ref.
- Tiles name their own PTY id before the spawn (`pty_tile_id`); keep listening
  before spawning.
- Keep `workspaceId` keyed through editor, terminal, agent and Kanban stores.
  Prompts and user templates are intentionally global.
- `codex` is the CLI TUI in a PTY; `codex-chat` uses `codex app-server` through
  CodexSession/codex_app. Never convert one lifecycle into the other.
- Compare (Terminals' relay bar: `compare.rs`, `CompareBar`, `CompareComposer`,
  `compareActions`)
  writes into a Claude or Codex tile only on the member's press, only the
  text `compare_prepare_paste` returned, and never while a guard is unknown:
  not into a question, a menu, a turn in progress or a box holding the
  member's typing. Plyloft answers no screen of an AI. The answers it reads
  from the CLIs' own conversation files stay in memory: never logged,
  never persisted. With two pairs, the shortcut and every write act on the
  pair the member is in, and *Include my question* adds only the member's
  own words from the same in-memory read, never logged or persisted.
- Tauri plugin permissions are opt-in through `src-tauri/capabilities/default.json`.
- Rust changes in `tauri dev` trigger rebuilds and reset running window/pane state.

## Verification and shipping

- Run `./scripts/ppvp.sh` after every feature before declaring it done. It must
  pass; the normal no-dev-server result is 11/11. Preserve additional PPVP tiers.
  In a plan of several cards, the full gate, the builds and the Tier 4 walks
  run once per block of cards (and early for a heavy phase later cards build
  on), each card keeping its focused checks and the ones a hard rule ties to
  it (Max-auth tile and exit/orphan for a PTY change, the migration test for a
  persisted field): [PPVP](docs/PPVP.md), *Plans of several cards*.
- Documentation-only and copy-only edits use focused inspection. Changes to
  executable behavior or configuration receive applicable focused checks;
  calling an edit "small" does not waive a required feature gate.
- After checks pass, rerun only those invalidated by later edits, failures or
  unresolved concerns. Fix failures caused by this task; report unrelated ones
  without silently expanding the repair scope.
- Changes touching PTYs, agents or persisted state retain PPVP. PTY changes also
  require Max-auth tile verification and an exit/orphan check. New persisted
  fields require a backward-compatible schema-migration test. Each new feature
  requires the applicable PPVP Tier 4 walkthrough; document why any UI checks
  are inapplicable rather than claiming unperformed verification.
- Adding, renaming or moving a navigated destination (mode, sidebar entry,
  Library or Settings page, card section) or a `data-ply-tour` anchor updates
  its tutorial step and `since` (or its `NOT_A_TOUR_STEP` reason) and the
  step's `<!-- tour:… -->` marker and copy in `docs/onboarding/USER_GUIDE.md`;
  `tutorialCoverage.test.tsx` and `tutorialEngine.test.ts` enforce it. A
  changed guide needs its site copy before `release.sh` releases ([RELEASING](docs/RELEASING.md)).
- Shipping uses per-card `Ship now` or `Ship batch`. `install-local.sh` is a rare
  recovery/bootstrap tool, only synchronously from an **external interactive
  terminal**. Never run it from a Ply tile, detached job or Ply-owned entry.

```bash
npm run tauri dev
./scripts/ppvp.sh
# Backend tests, from src-tauri/:
cargo test --workspace --lib
```

## Product boundaries

- Tauri and the fixed layout are intentional: do not suggest Electron or dockview.
- Mac releases are signed with Developer ID and notarized by `scripts/release.sh`;
  Windows code signing is not set up yet. Persisting terminal processes across
  launches remains out of scope.
  Claude history is managed by Claude Code; processes cannot be resurrected.
- A Plyloft account is a GitHub sign-in (identity only, no scopes), and the
  licence server `plyloft-server` (Railway, Stripe) signs the plan as a `PLY2`
  entitlement that the app verifies offline. It never carries AI access: Ply
  still never uses an AI API key (Hard rule 1).
  From 1.178.0 (owner, 2026-11-26, [ADR 0010](docs/adr/0010-free-for-one-person-open-source.md))
  the plans are Free and Team: Free is everything one person does, with no
  card limit; Pro is retired (a `pro` entitlement still parses and reads as
  Free). The account is optional for one person and needed only for Team, and
  a Team plan or seat is active on one computer at a time (*Use Team on this
  computer*).
- From 1.178.0 the app's source is public under the MIT licence (copyright
  MB Adv), in a new repository `plyloft/plyloft` with a fresh history. This
  repository stays private as the archive, and `plyloft-server` stays
  private. After launch, development and releases move to the public
  repository.
- No general git push/branch UI. Plyloft writes to GitHub only as listed
  here — the complete list (owner, 2026-10-26). Each entry is scoped as
  written; no push is ever forced, and no other kind of write is added
  without the owner's decision recorded here.
  - **Ship as a pull request.** The card-scoped `commands::card_ship` flow may push the
    card worktree branch and open its GitHub PR; keep that exception scoped.
    The push is the commit Ship's gate verified, to `refs/heads/<card branch>`.
    The same exception covers that card's own pull request afterwards: *Send
    the fixes to GitHub* (`card_pr_push_update` on a card that shipped the PR;
    labelled *Push update* before 1.171.0) pushes the
    card's verified commit to the same branch; Ship posts the Challenger's
    verdict (`gh pr comment`, `post_challenger_verdict_comment` through
    `verdict_comment::post_once`, only when no comment with the same body is
    already there) and keeps the
    PR body's "Last commit not reviewed" line current (`gh pr edit --body`);
    *Merge* and *Merge when checks pass* (`pr_merge.rs`) run `gh pr merge
    --squash` (`--auto`, `--disable-auto`), never `--admin`.
    From 1.170.0 (owner, 2026-10-26) the same card's pull request also takes:
    the merge method its repository allows (`merge_method.rs`: `gh pr merge
    --squash|--merge|--rebase`, squash first, with `--match-head-commit`);
    `gh pr merge --disable-auto` when a commit nobody reviewed is pushed to
    it, turned back on (`--auto`) once that commit is reviewed. Where the
    base branch requires no status checks, `--auto` would merge at once, so
    *Merge when checks pass* is Plyloft's own instead: the poller runs the
    same `gh pr merge` (method, `--match-head-commit`, never `--auto` or
    `--admin`) once the card's *Merge* would, only while Plyloft is open
    (`PrStatus.plyloftAutoMerge`, walk fix, owner 2026-10-27); `gh pr edit`
    of its title and body on the person's press (`pr_draft.rs`), and the
    existing "Last commit not reviewed" refresh, both with the body on stdin
    (`--body-file -`). *Bring in main's changes* (`card_sync.rs`) merges the
    target into the card's copy here, never rebased, and that merge reaches
    GitHub only through *Send the fixes to GitHub*. It may also run by itself,
    through the same `card_pr_push_update` and only for the card's verified
    commit to the same branch, on a card whose "Fix failing checks by itself"
    is on (G7, owner 2026-10-26), after Verify passed and the Challenger
    approved that fix or the person skipped its review — at most three tries
    per pull request, never on a pull request review card, never forced,
    never a merge or auto-merge. After the pull request merged
    (`after_merge.rs`), the card's branch on GitHub is deleted through the
    refs API (`gh api --method DELETE repos/{o}/{r}/git/refs/heads/<branch>`):
    only a card branch of a same-repository pull request, only while GitHub
    has it at the head that merged — read before the checks and once more right
    before the delete; the delete itself carries no such condition — never the target or the default
    branch, and never while another open pull request has it as its head or
    its base.
  - **Release.** Ship's release (`ship::push_release`) pushes the release's own commit to
    the workspace's target branch (`<sha>:refs/heads/<branch>`), then its tag.
    The branch is pushed by name instead only when the record holds no whole
    commit id, or when origin can't fast-forward to that commit and a fetch
    doesn't show origin's branch already holding it (if it does, only the tag
    is pushed); a branch that moved on is left for the person to merge.
    From 1.170.0 (owner, 2026-10-26), on a project whose `origin` is GitHub,
    the two kinds that push ("Put the version on GitHub", "…with a release
    page"; "Tag and push" and "Publish a GitHub release" before 1.174.0)
    release through a pull request instead (`ship/release_pr.rs`: Release…,
    a card's Release… and Release N cards…, one pull request per release): it
    pushes the `plyloft/release-vX.Y.Z` branch, never forced (*Update the
    release* merges the target into it and pushes that as a fast-forward),
    opens its pull request (`gh pr create`) and merges it with the
    repository's method and `--match-head-commit` — `--auto`, or by Plyloft
    once its checks on GitHub passed where auto-merge isn't allowed or the
    base branch requires no checks, never `--admin`. After the merge it tags
    the merge commit and pushes the tag; for "…with a release page" only,
    `gh release create --verify-tag`. Dismiss, and *Stop the release* on a
    release whose pull request is open, turn its auto-merge off (`gh pr merge
    --disable-auto`) and leave the pull request open.
    From 1.174.0 (owner, 2026-10-31, D1(b)), what a release carries is the
    target branch of its area since that area's last tag (`<prefix>vX.Y.Z`,
    `release_scope.rs`): everything merged there — cards shipped with Ship it,
    other pull requests and commits — plus the cards ready but not yet there
    that the person ticks; it may carry no card of its own, and then its only
    commit is the version commit on GitHub's target. Its writes to GitHub are
    the ones above and no others. Before a release kept on this computer,
    Plyloft may bring this computer's target up to GitHub's (`git fetch`, then
    a fast-forward only), which writes nothing to GitHub.
  - **Shared config.** The shared-config channel (`shared_config.rs`, through
    `worktrees::push_origin`) writes only `.atelier/`, `.claude/skills/`,
    `.agents/skills/` (the Codex copy of a project skill) and the two root
    instruction files (`check_path`) — and the root `.gitignore`, only in the
    commit that first shares a setup on a repository whose `.gitignore` hides
    `.atelier/workspace.json` — as commits onto the integration branch (`git
    push origin <sha>:<branch>`). The shared definition, with that
    `.gitignore` line, goes as a `chore(config): …` commit, only after the
    person changed a shared field in the app (1.169.1, R14). Shared Knowledge,
    project skills and the instruction files go as `knowledge: …`, `skill: …`
    (or the action's own `skills: …`) and `instructions: …` commits
    (`shared_library_sync.rs`), only after the person's own action on that
    item in the app (a save, a publish or update, a removal, an align or copy,
    an approved proposal). When the remote refuses a commit — and always for a
    skill or an instruction file somebody changed on the branch since — it
    pushes a branch of its own (`atelier/config-<field>-<ts>`;
    `atelier/knowledge-…`, `atelier/skill-…`, `atelier/instructions-…`) and
    opens a pull request (`Settings: <field>`; `Knowledge: <title>`, `Skill:
    <name>` or `Skills: …`, `Instructions: <file>`), which it may later edit
    or close. None of these branches is ever forced (1.175.0): one that
    already ends in another commit is left as it is, its pull request is
    closed, and the change goes to the next name (`-2`, `-3`) or, for a
    setting or an item changed again, to a branch of its own, whose pull
    request names the ones it replaces (`Replaces #N`).
    Two existing automatic publishes are allowed (owner,
    2026-10-26): the adoption banner's ConvertLegacy publish of
    `.atelier/workspace.json` (`AdoptionAction::ConvertLegacy` →
    `workspaceDefinitionPublish`), and the refresh's kept Try-it command
    (`kept_try` in `workspace_definition.rs`), queued as this Mac's edit.
    A third is allowed (owner, 2026-10-30 E6, recorded here 2026-11-02): a
    Next improvement direction kept on this computer while the setup wasn't
    shared moves to the integration branch by itself once the setup is shared
    (`next_improvement::adopt_local`, then `drain_with`), at any read but a
    page's. A push the branch refuses goes as a pull request from
    `atelier/config-next-improvement-<area>-<ts>`; a read-only computer
    publishes nothing. A page's read (`RefreshMoment::PageRead`: an open
    Settings page, "Read it again", the press that moves a board): the read
    itself publishes nothing; what it finds can start the Board's existing
    automatic steps, as any read does.
    From 1.175.0 (owner, 2026-11-09): **Stop sharing.** On the person's press
    of *Stop sharing* in Settings › Project › General (`stop_sharing::stop`),
    and only then, Plyloft removes `.atelier/workspace.json` from the
    integration branch it was read from with one `chore(config): stop sharing
    the workspace setup` commit (`stop_sharing::remove_from_branch`: `git push
    origin <sha>:<branch>`, never forced, built again once on a branch that
    moved), touching no other path. When the remote refuses it, it pushes an
    `atelier/config-stop-sharing-<ts>` branch (never forced; the fallback walk
    of `shared_config::push_fallback`, as for a shared setting) and opens a
    `Settings: stop sharing the workspace setup` pull request; the setup stays
    shared until that merges, and Plyloft neither merges nor closes it by
    itself — only another press of *Stop sharing* may reuse, edit or replace
    it. Once that press has really taken the file off the branch — on the
    direct commit, or when its removal pull request reads merged on this
    computer, after a read that still finds the setup not shared — Plyloft
    closes the open shared-setting pull requests this computer opened and
    still follows (`stop_sharing::close_own`, `Publisher::close_after_stop`:
    the ones in its publish queue), each only while it is still that pull
    request: recorded in the repository origin is now, its head branch the
    recorded one in that same repository, and open (one `gh pr view` first),
    with the comment "Withdrawn by Plyloft: this project's shared setup
    stopped being shared." Never the removal's own pull request, never one
    somebody else opened, never while the removal only waits or was closed
    without merging, and never on a computer that only finds a removal made
    elsewhere; one that isn't closed is left open and named. A setup removed
    from its branch, by this or by hand, is never created again by itself. An
    edit never creates the file: `publish_pending` gives the channel a copy to
    create it from only for a creation that is queued — *Share* and *Share it
    again* (both `workspace_adoption::share`), and the conversion of a
    repository whose history never removed the file — and for the move to a
    named integration branch whose history never deleted the file after the
    copy that names it was written (`RepoSource::deletion`; where git can't
    say, nothing is created). The refresh lets go of the cached copy when the
    file is gone from the branch it was read from, or from the branch that a
    copy left elsewhere names. After a removal the older
    `workspace_default.json` is converted only on a press: where a branch's
    history deleted `.atelier/workspace.json` the conversion never runs by
    itself, and where git can't read the history (a shallow clone) it doesn't
    either. *Keep it on this Mac* writes nothing to GitHub.
    When the person publishes a new integration branch ("Cards go to"), the
    same channel then writes the whole current `.atelier/workspace.json` onto
    that branch in one `chore(config)` commit (`git push origin
    <sha>:<branch>`, never forced) that names the copy it moved
    (`Plyloft-Moved-From`), replacing only a copy there that is older than the
    one moved — judged by that trailer, then by ancestry, then by committer
    time — or creating it where that branch's history never removed it; it
    opens no pull request for this move, and never replaces a newer copy (the
    fields that differ are then asked about at the person's next publish).
    From 1.175.0 (owner, 2026-11-09, C4-a): when a read finds the shared setup
    on the branch from another computer's commit while this computer's own
    creation pull request (Share, or the conversion of the older file) is
    still open on GitHub, Plyloft closes that pull request
    (`workspace_definition::publish_pending`, `Publisher::close_own_saying`:
    only while it is still this computer's — its recorded address in origin's
    repository now, the recorded head branch in that same repository, open —
    never while GitHub can't say whether it is open, with the comment
    "Withdrawn by Plyloft: this project's setup was shared from another
    computer first, so this pull request isn't needed."); one GitHub won't
    close is left open and named.
  - **GitHub Issues board.** On a workspace whose board is GitHub Issues
    (`github_sync.rs`, `github.rs` issue functions): cards are mirrored as
    issues — create, edit, status labels (`gh label create --force` for
    Plyloft's labels), close on delete or when a skill card lands, on a Sync a closed issue's
    status label follows its card to Done (U33, owner, 2026-11-03: with the
    label retries, at most 25 writes a Sync) — this
    Mac's local cards are turned into issues, claiming a card (also Start
    build's claim) assigns the member (`kanban_card_claim`), and a card's
    outcome is posted as an issue comment.
    From 1.175.0 (owner, 2026-11-09) Plyloft also takes the member's own name
    off an issue (`github::issue_remove_assignee_me`: `gh issue edit
    --remove-assignee @me`, with no login to pass), never anyone else's. When
    the member leaves a card that isn't Done, has no pull request, hasn't
    shipped and whose issue carries their name (`leave_issue::leave`): the
    two ways into `kanban_card_put_back` — *Move back to Ready to start* and
    Stop during the start (the Free plan's *Pause it and start this one* went
    with the card limit in 1.178.0) — and *Archive* by hand, never the
    auto-archive. A removal GitHub refused is tried again at each next Sync, before that Sync reads and first within its
    cap of 25 writes (`leave_issue::retry_pending`), until it goes through,
    GitHub says the issue is gone, or the card no longer asks for it: the
    member started or claimed it again, it is In progress or Done, it got a
    pull request, or its issue no longer carries the name. And at a claim
    (Start build's, or Claim) of an issue nobody held, when the reading after
    it shows a teammate's name put on first (`second_claim::after_claim`), so
    the second build doesn't start. This computer's claim marker in the issue
    body stays while the card's copy is on that computer: it comes off at
    Done, Archive and Delete, when the copy is deleted or found missing, and
    after the card's pull request merged — no longer when the Builder session
    is closed, or on a Move back that keeps the copy.
  - **Team library.** The team library clone's own branch takes a plain `git
    push` of the change the member pressed (`team::publish_library_paths`:
    Promote, team defaults, the team's workspace list, the members manifest);
    a change GitHub refuses there, or one whose paths moved upstream, goes as a
    pull request from a `plyloft/skill-…` branch (`team_proposal.rs`).
    Creating a team (`team_create`) runs `gh repo create --private` and pushes
    its first manifest; inviting and removing members invite, cancel an
    invitation or remove a collaborator on that repository (`gh api`).
  - **New project.** Project setup may create the member's private repository
    (`project_setup::github_copy`: `gh repo create <login>/<slug> --private
    --source . --push`) and, after the consent sheet, push the first commit
    (`first_commit_push`: `git push -u origin main`, only for a clone with no
    commit whose origin has no branch).
    From 1.175.0 (owner, 2026-11-09), the same private repository for a
    project already on this computer whose repository has no `origin`, only on
    the person's press (*Put it on GitHub…* on a card ready to ship and in
    Settings › Cards › Shipping; the ticked *Also keep a private copy on
    GitHub* in Add a project › A folder) and after its consent sheet
    (`put_on_github.rs`: `gh repo create <login>/<name> --private --source .
    --remote origin`, then `git push -u origin refs/heads/<target
    branch>:refs/heads/<target branch>`): under the chosen GitHub account's
    own login, never an organisation's, only the branch cards go to, never
    forced. Nothing is created when that branch holds a file over GitHub's 100
    MB limit. A push that doesn't land, or that the person stopped, leaves the
    repository as GitHub has it and is tried again only on the person's press
    (*Send it again*), only into that repository and only while GitHub doesn't
    have that branch.
  - **Pull request review fix.** A second, equally scoped exception (owner,
    2026-10-15): on a card that reviews a pull request, only
    `card_pr_push_update` ("Send the fixes to GitHub", "Push the fixes" before
    1.171.0) may push, only the card's verified
    fix, only to the head branch of the member's own same-repository pull
    request, never forced (`--force-with-lease` on the head the fix is built
    on), refused when that branch is the workspace target, the repository's
    default branch or the pull request's base, and only while GitHub's current
    head equals the head the fix was built on. Nothing else of a pull request
    review is ever written to GitHub.
  - **My library.** A third, equally scoped exception (owner, 2026-10-20): My
    library (`my_library.rs`) may push only to the member's own My library
    repository — the repository recorded in `settings.library.myLibrary`, under
    the chosen GitHub account's own login, never an organisation's, another
    account's or the team library — only the skill the member pressed *Add to My
    library* for (or, with *Create it again*, that computer's clone back into
    the repository it was), by an explicit refspec to the same branch, never
    forced; a push that doesn't land is undone, except one the time limit
    stopped, whose commit stays on this computer and goes to GitHub only with
    a later press of *Add to My library* whose push goes through, and only
    while every commit that push carries is Plyloft's own *Add to My library*
    commit; at a press that finds a kept commit GitHub refuses (in words
    Plyloft recognises as a refusal, not a passing server error or rate
    limit) or one GitHub's branch moved past meanwhile, that commit is set
    aside on this computer (a `refs/ply/backup/…` ref) and the clone goes back
    to GitHub's copy; a press that finds a tracked file in the clone edited
    beyond its line endings (in the working copy or staged) does nothing at
    all (1.176.4, owner 2026-11-23). `gh repo create --private`
    creates only that repository. Nothing else of My library is ever written to
    GitHub.
  - **Copies, areas and claims.** Approved by the owner (2026-10-30, 1.173.0):
    a copy without a card (`copies.rs`) may push its own `plyloft/copy-…`
    branch, never forced, by an explicit refspec to the same branch name, and
    open its pull request (`gh pr create`, Ship's own body and footer) for the
    target branch of its area, only on the person's press (*Open a pull
    request*); after the merge the cards' branch cleanup (`after_merge.rs`)
    applies to it. On a GitHub Issues board, the `area:<name>` labels and the
    hidden claim marker in the issue body (`<!-- plyloft:claim … -->`). The
    release of an area: tags and branches with the area's prefix (the first
    area keeps `vX.Y.Z`; the others `<area>-vX.Y.Z` and
    `plyloft/release-<area>-vX.Y.Z`).
    From 1.175.0, a claim's marker write (`device_claim::claim_on_issue`) may
    also replace a marker left by somebody who is no longer among the issue's
    assignees (they moved the card back, their copy still on their computer);
    a marker of somebody still assigned is replaced only by *Take it over
    here*, as before.
    From 1.175.0 (B3), a claim marker in an issue whose text was last written
    by somebody outside the repository (its author is not the owner, a member
    or a collaborator, and nobody else edited it since:
    `issue_text::written_outside`) is text like any other, not a claim: no
    computer is read from it, and the marker write of whoever claims the card
    (`device_claim::claim_on_issue`) replaces it without asking.
- No MCP server configuration UI; Claude CLI manages its own MCP configuration.
