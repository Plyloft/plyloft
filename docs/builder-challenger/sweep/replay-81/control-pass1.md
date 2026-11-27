## Verdict

CHANGES_REQUESTED

## Findings

1. **P1 — Stale adoption status can migrate cards to the wrong repository.** `src/components/AdoptionBanner.tsx:30–40,109–122`: status responses are not tied to the current workspace, and switching workspaces reuses this component. A delayed `switchBoard` response for workspace A can therefore execute with workspace B’s ID and A’s repository, publishing B’s cards into A. Bind status to its workspace and discard stale responses before running automatic actions.

2. **P2 — Refresh-driven board adoption skips local-card migration.** `src-tauri/src/workspace_adoption.rs:250–267`: when another Mac has already published `board: githubIssues`, refresh applies that board locally, but `decide` returns `None` regardless of remaining local cards. Reconcile only pushes `sync_pending` cards; ordinary local cards remain unshared indefinitely. Migration must also cover adopting an existing GitHub Issues definition, including after licence activation.

3. **P2 — Branch discovery misses definitions published after this clone’s last fetch.** `src-tauri/src/workspace_definition.rs:606–620,810–815`: discovery filters branches using their cached remote-tracking contents before fetching them. The preceding refresh fetches only the default/configured branches. A definition newly published on `staging` is consequently invisible to another existing clone without that configuration, which can incorrectly offer Share again. Refresh candidate remote refs before testing their contents.

4. **P2 — Retried issue creation loses the card’s column.** `src-tauri/src/github_sync.rs:559–567`: successful migration pushes status labels, but failed creation only marks `sync_pending`. When reconcile retries successfully, its creation path stamps the issue number without pushing labels or marking them pending. The subsequent pull can move an inactive Review/Complete card to Todo. Apply the same status-label handling when retry creates an issue.

## Verification gaps

- Read-only review of pass 1 and relevant surrounding code; no builds or tests run.
- The documented two-Mac Tier 4 walkthrough remains unperformed. The supplied “second Mac” test reuses the publishing clone, so it does not exercise stale remote-tracking refs in an independent clone.