## Verdict

CHANGES_REQUESTED

## Findings

1. **P1 — Stale adoption status can publish cards to another repository.** `src/components/AdoptionBanner.tsx:32`, `:92`, `:116`  
   `KanbanBoard` is reused when switching workspaces. Its banner can therefore render workspace B with workspace A’s retained status; resetting status in an effect does not invalidate the automatic effect’s current closure. Outstanding requests can also return A’s status afterward. A `switchBoard` result then switches B to A’s repository and migrates B’s cards there. **Fix:** associate status with workspace ID and request generation, reject stale responses, and prohibit actions unless the status belongs to the current workspace.

2. **P1 — Background migration can discard edits and race other issue creators.** `src-tauri/src/commands.rs:4072`; `src-tauri/src/github_sync.rs:544`  
   Migration now runs while the board remains editable. If a brief changes after the bulk snapshot, the edit marks the card pending, but migration subsequently clears that flag using its old snapshot. The following pull replaces the new brief with the old issue body. Similarly, `kanban_card_create` does not take the new board-pass lock: migration can pick up its newly persisted card while its own issue creation is outstanding, producing two issues. **Fix:** coordinate bulk migration with per-card creation/editing, reread eligible cards, and acknowledge only the revision actually uploaded.

3. **P1 — New adoption subprocesses lack timeout and exit cleanup.** `src-tauri/src/workspace_adoption.rs:470`, `:518`; `src-tauri/src/commands.rs:4081`  
   These paths use `github::run_gh`, which executes unbounded `Command::output()` without registering the child for exit cleanup. A stalled access check, label operation, or issue migration can remain outstanding indefinitely and survive Cmd-Q. This violates hard rule 4; `spawn_blocking` does not manage child lifetime. **Fix:** route these operations through a bounded, exit-registered runner, as the shared-config channel already does.

4. **P2 — Applying an existing definition bypasses local-card migration.** `src-tauri/src/workspace_adoption.rs:247`, `:266`; `src/components/AdoptionBanner.tsx:143`  
   When refresh applies an existing `githubIssues` definition, `decide` returns `none` even with local cards remaining. Reconcile only uploads `sync_pending` cards, whereas existing local cards default to false. This affects another Mac adopting the definition, licence activation, the `alreadyShared` race, and restart after the board switched but before migration completed. **Fix:** persist or derive unfinished migration independently of the Share callback and board-setting change, and resume it on open/Sync.

5. **P2 — Another Mac can miss a definition newly published on `staging`.** `src-tauri/src/workspace_definition.rs:606`, `:620`, `:811`  
   Discovery tests cached remote-tracking tips for the file before fetching candidates. A mini cloned before Share has no file in its stale `origin/staging`; refresh fetches only the default branch, excludes `staging`, and keeps asking to Share. The 50-branch cutoff also silently excludes valid integration branches. **Fix:** refresh remote discovery before filtering for the definition and avoid silently excluding the authoritative branch. Test with two independent clones created before Share.

6. **P2 — Failed issue creations lose the original column when retried.** `src-tauri/src/github_sync.rs:559`, `:567`  
   A failed migration creation sets `sync_pending`. On the next reconcile, `push_pending_card` creates the issue, but its no-number branch never pushes status labels. Reconcile clears pending and pulls the unlabelled issue as Todo. An inactive Complete or In Progress card consequently moves to Todo. **Fix:** apply or durably queue the current status label after every successful creation, including reconcile retries; test failure followed by successful Sync.

7. **P2 — Failed label setup cannot recover through Sync.** `src-tauri/src/commands.rs:4081`; `src-tauri/src/workspace_adoption.rs:518`  
   Both adoption paths log `ensure_labels` failures and continue. If a required label was never created, migration leaves `gh_labels_pending`, but subsequent Sync only retries attaching the nonexistent label. Other Macs see the wrong column indefinitely. **Fix:** retry label creation before pending label writes, or retain label setup as a prerequisite that Sync resumes.

8. **P2 — A transient automatic-switch failure disables recovery until restart.** `src/components/AdoptionBanner.tsx:112`  
   The session guard claims the switch before `workspaceSetKanbanSyncMode` succeeds. If label setup fails temporarily, later status reads still request `switchBoard`, but the guard refuses every retry. No banner or retry control appears, and Settings hides the backing control for the shared workspace. **Fix:** distinguish in-flight work from successful completion and release failed attempts, with an explicit retry or bounded retry policy.

9. **P2 — Automatic legacy conversion does not establish owner identity.** `src-tauri/src/workspace_adoption.rs:465`  
   Any collaborator with push permission qualifies for automatic conversion; unknown permission and access-check errors qualify too. A teammate opening first can publish a definition seeded from their local project configuration before the owner’s Mac performs the specified conversion. **Fix:** use the established team-owner identity check for automatic legacy conversion, and defer conversion when ownership cannot be established.

10. **P2 — “Not on this Mac” can overwrite concurrent settings changes.** `src-tauri/src/workspace_adoption.rs:489`  
    Decline snapshots the entire settings object and later replaces it from a worker. Two overlapping declines, or a decline overlapping a preference save, can overwrite each other’s changes. `SettingsStore::replace` also writes the shared temporary filename outside its state mutex. **Fix:** perform the decline as a field-level mutation under a lock covering read, atomic persistence, and state update; coordinate other settings writers with that lock.

11. **P2 — Later ignore rules defeat the generated carve-out.** `src-tauri/src/workspace_adoption.rs:96`, `:103`  
    With `.atelier/` followed later by `.atelier/*`, exceptions are inserted after the first replacement rule and before the later contents rule. Git’s last matching rule wins, so the promised shared files remain ignored. A second call reports no change because it sees the earlier exceptions. **Fix:** place effective exceptions after the final relevant exclusion, and test the resulting ignore behavior rather than only the generated text.

12. **P2 — Existing team workspaces convert only when their board is displayed.** `src/components/AdoptionBanner.tsx:92`  
    All automatic conversion lives in this component, which `NewWorkspaceShell` mounts only in board mode. Opening an existing workspace in its terminal mode runs definition refresh but never queues legacy publication. That misses the required conversion on first workspace open. **Fix:** initiate conversion from the workspace-open lifecycle or backend adoption coordinator, independently of banner rendering.

13. **P2 — Definition existence and definition adoption use conflicting rules.** `src-tauri/src/workspace_adoption.rs:289`; `src-tauri/src/workspace_definition.rs:823`  
    A cached feature branch containing `workspace.json` that names `main`, where `main` has no definition, makes `repo_has_file` return true. Refresh deliberately rejects that copy. Status nevertheless reports `hasDefinition: true` and `none`: the board remains local, the question disappears, and Settings hides its backing control. **Fix:** share one authoritative-definition resolver between status and refresh; a rejected branch copy must not count as an adopted definition.

14. **P2 — An ambiguous creation failure can create duplicate issues.** `src-tauri/src/github_sync.rs:550`, `:567`; `src/components/AdoptionBanner.tsx:78`  
    If GitHub creates an issue but the response is lost, migration records only `sync_pending`. Its immediate reconcile retries creation before listing issues, producing another issue for the same card. Restart between remote creation and local number persistence has the same problem. **Fix:** give each migration a durable card/repository identity in the issue and recover an existing creation before retrying an uncertain request. Add a lost-response recovery test.

## Non-blocking

- **P3 — Progress disappears before migration finishes.** `src/components/AdoptionBanner.tsx:71`  
  The progress toast uses the normal six-second info timeout. Several sequential GitHub calls can easily exceed that. Pause its timer until the `finally` dismissal.

- **P3 — The “main unchanged” assertion is tautological.** `src-tauri/src/workspace_adoption_tests.rs:732`  
  It compares the current `main` SHA with itself. Capture the SHA before Share and compare afterward.

## Checklist

- **A. Requirements:** Findings 4–9 and 11–13; checked question persistence, seeding, publication, gitignore, automatic board adoption, licence handling, and legacy conversion.
- **B. Concurrency and ordering:** Findings 1–2, 8, 10; checked React request lifetimes, workspace switching, board locks, mutation hooks, and settings replacement.
- **C. State and persistence:** Findings 4, 10, 14; checked cache/queue writes, additive settings defaults, interruption recovery, and issue-number persistence.
- **D. Failure paths:** Findings 5–8, 13–14; checked stale refs, failed creation/setup, retries, and automatic-action recovery.
- **E. Processes and resources:** Finding 3; checked `gh` execution and exit registries. Shared-config network operations already use the bounded runner.
- **F. Boundaries and contracts:** Findings 1, 9, 13; IPC/serde names and new enum shapes checked — nothing additional.
- **G. Data safety:** Findings 1–2, 9–10, 14; checked publication targets, concurrent edits, owner conversion, settings preservation, and duplicate creation.
- **H. Tests:** Missing coverage for the reported transitions and races; the second-Mac fixture reuses the first checkout, and the main-SHA assertion is ineffective.
- **I. User-facing text and states:** Findings 8, 13 and the progress-toast note; checked banner, licence explanation, failure toast, and recovery controls.

## Verification gaps

- Read-only review of all pass-1 changes plus relevant callers and persistence/sync implementations. No builds, tests, or UI actions were run.
- The documented PPVP and Rust-test results were not independently verified.
- The required LYRA/Climbr two-Mac Tier 4 walkthrough remains explicitly unperformed.
- Pass 2 still needs its separate review; contextual inspection here does not replace it.