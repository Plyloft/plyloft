## Verdict

CHANGES_REQUESTED — two additional cross-file defects.

## Findings

1. **P1 — Share retargets existing issue numbers to a different repository.**  
   **Sides:** `src-tauri/src/workspace_adoption.rs:164`, `src-tauri/src/workspace_definition.rs:1016`; `src/components/AdoptionBanner.tsx:149`, `src-tauri/src/github_sync.rs:181`, `:386`.

   A workspace can already use `team/issues` for its board while its GitHub origin is `team/code`. With no shared definition, Share seeds `githubOwnerRepo` from origin and replaces the board target without changing cards’ existing issue associations. The subsequent reconcile treats `team/issues#12` as `team/code#12`: a pending card overwrites that unrelated issue; otherwise the pull replaces the original card’s contents. This requires no workspace-switch race.

   **Smallest fix:** before applying the seed, detect an existing backing target that differs from origin and defer retargeting while linked cards exist. Repository changes must explicitly migrate issue associations before synchronization resumes.

2. **P2 — Workspace registration bypasses the new licence hold.**  
   **Sides:** `src-tauri/src/workspace_definition.rs:695`, `src-tauri/src/workspace_adoption.rs:260`; `src-tauri/src/workspace.rs:345`, `:527`, `src/components/KanbanBoard.tsx:67`.

   On an unlicensed Mac, adding or importing a clone whose checkout contains the shared GitHub Issues definition immediately persists `GitHubIssues` through `WorkspaceStore::create` or `import_default`. The new hold only protects boards that are already Local, so refresh leaves this newly registered board GitHub-backed. Adoption returns `none`, and the board becomes read-only instead of remaining local with the promised explanation.

   **Smallest fix:** apply the licence decision during registration/import, initializing an unlicensed newcomer’s board as Local while retaining the shared definition. Preserve the separate lapse behavior for previously active GitHub boards.

## Non-blocking

None additional.

## Verification gaps

- Read-only source review against `a7a454a6d3...c56ce8bdd8`; no builds, tests, installs or mutations performed.
- Existing adoption fixtures do not cover Share with a different existing issue repository, or unlicensed registration from a checkout already containing the definition.
- `workspace_adoption_tests.rs:544` names a next-Sync retry test, but stops after checking `gh_labels_pending`; it never executes that retry.
- Reported PPVP/Rust results and the LYRA/Climbr two-Mac Tier 4 walkthrough were not independently verified.