## Verdict

CHANGES_REQUESTED

## Findings

1. **P1 — Adoption can publish one workspace’s cards into another repository.**  
   `src/components/KanbanBoard.tsx:265`, through `src/components/AdoptionBanner.tsx:30` and `:109`.  
   The board reuses the unkeyed banner when switching workspaces. Its status still belongs to workspace A when the effect first runs with workspace B’s ID; delayed requests can also restore A’s status afterward. If A’s action is `switchBoard`, the effect passes **B’s workspace ID and A’s repository** to the setter, then migrates B’s cards into A.  
   **Smallest fix:** key the banner by workspace ID, reject stale status responses using request generations, and ensure a status belongs to the current workspace before any mutation. Apply the request protection to the Settings consumer too. Test switching workspaces with a delayed status response.

2. **P2 — Existing local cards are stranded when the shared definition arrives through refresh.**  
   `src/components/KanbanBoard.tsx:265`, through `src/components/AdoptionBanner.tsx:109` and `:143`.  
   Suppose this Mac has local cards and another Mac publishes a definition with `board: githubIssues`. Refresh applies that mode directly; adoption then returns `none`, so neither migration branch runs. Reconcile only pushes `sync_pending` cards, leaving ordinary local cards unpublished. The same gap occurs after interruption between persisting the board switch and starting migration, and when Share returns `alreadyShared`.  
   **Smallest fix:** make outstanding local-card migration independently discoverable and resumable after adopting a definition, regardless of whether this invocation changed the board mode. Preserve the archived-card exclusion. Test remote adoption, `alreadyShared`, and restart before migration.

3. **P2 — One transient switch failure disables adoption until application restart.**  
   `src/lib/adoption.ts:119`.  
   `claim()` permanently marks an operation before it succeeds. If `ensure_labels` fails during an automatic switch—for example, because GitHub is temporarily unreachable—the board stays local, later status refreshes cannot retry, the banner renders nothing for `switchBoard`, and Settings hides the backing control. Recovering connectivity leaves no normal retry action.  
   **Smallest fix:** distinguish in-flight, successful, and failed attempts; expose an explicit retry or bounded retry mechanism without creating an immediate error loop. Test failure followed by recovery in the same session.

4. **P2 — Automatic legacy conversion depends on visiting the board.**  
   `src/components/KanbanBoard.tsx:265`.  
   The automatic conversion and board-switch effects live exclusively inside `AdoptionBanner`. `NewWorkspaceShell` mounts this board only in board mode. An existing team workspace opened in terminals mode therefore caches its legacy definition but never queues its publication or automatic board switch, contrary to conversion on first open.  
   **Smallest fix:** run automatic adoption from the workspace-open lifecycle independently of the visible mode; retain the question’s presentation on the board. Test opening a legacy workspace directly into terminals.

5. **P2 — Settings falsely reports GitHub Issues when licensing keeps the board local.**  
   `src/components/SettingsApp.tsx:1063`, with `src/lib/adoption.ts:110`.  
   For a shared GitHub workspace with no Team licence and a local board, `showKanbanBacking()` returns false. Settings consequently says the board “is GitHub Issues,” hiding the previous licence explanation and Team-key action even though adoption reports `boardHeld`. A failed switch produces the same false success statement.  
   **Smallest fix:** keep the selector hidden where required, but render the actual local/held/pending state and licence reason; only claim GitHub Issues is active when `ghBacked` is true. Add held-board and failed-switch rendering cases.

## Non-blocking

- **P3 — Migration progress disappears before migration finishes.**  
  `src/lib/adoption.ts:77`. The progress notification is an ordinary information toast, which `toastStore` automatically dismisses after six seconds. Sequential issue creation can readily exceed that duration. Use a persistent progress notification dismissed by the operation’s existing `finally` block.

## Checklist

- **A. Requirements:** Findings 2–5; inspected adoption decisions, seed/gitignore tests, migration wiring, legacy conversion, and documented claims.
- **B. Concurrency and ordering:** Finding 1; inspected component reuse, asynchronous status responses, automatic guards, and backend board-pass serialization.
- **C. State and persistence:** Finding 2; inspected restart boundaries, pending-card handling, settings defaults, and atomic settings persistence.
- **D. Failure paths:** Finding 3; traced label-creation failure, retry suppression, and available recovery controls.
- **E. Processes and resources:** Checked — nothing additional in these files; inspected effect subscription cleanup and IPC worker dispatch. No new process ownership originates in this pass.
- **F. Boundaries and contracts:** Checked — nothing additional; TypeScript action names, outcome fields, `seeded`, and settings defaults match Rust serialization.
- **G. Data safety:** Finding 1; traced the mixed workspace/repository arguments through board persistence and issue publication.
- **H. Tests:** Existing tests cover pure decisions and isolated migration, but miss workspace-switch races, interrupted adoption, automatic retry, terminals-first opening, and held Settings rendering.
- **I. User-facing text and states:** Findings 3 and 5, plus the progress-toast observation; inspected banner, settings, and toast behavior.

## Verification gaps

- Read-only source review only; no builds, tests, installs, or mutations performed.
- The reported PPVP and Rust results were not independently reproduced.
- The required LYRA/Climbr two-Mac Tier 4 walkthrough remains unperformed, as acknowledged in `docs/STATUS.md`.
- Review covered this pass’s seven files and relevant dependencies; it does not replace pass 1’s review.