# ADR 0002 — A team is a GitHub repository, not a Ply service

**Status:** accepted, 2026-09-10. **Superseded in part by
[ADR 0008](0008-plyloft-account-and-licence-server.md)** (1.158.0): the
licence key is retired. Plans, seats and the team's paid status now come from
the Plyloft account and the licence server. The team is still a GitHub
repository as decided here.

## Context

Ply's team tier needs a shared definition of "who is in the team" and a
shared place for cross-project Knowledge and skills. Ply has no backend by
design (closed-free desktop app; billing later). The alternatives were:

1. A Ply service (accounts, sync, ACLs).
2. The GitHub organization as the team.
3. The signed license key alone.
4. A private GitHub repository chosen by the owner, holding a manifest and
   the shared library.

## Decision

Option 4. The team repo defines the team; membership is the manifest plus
GitHub read access; write access to the repo is the right to share into
the library; the owner alone edits members and workspaces. The license key
carries the repo slug so joining is one paste. Ply clones, pulls and pushes
the repo itself so members never see git behind the library.

## Consequences

- No server to run, no accounts to protect, no sync protocol; GitHub's
  permissions are the only ACL, and they already exist for every repo the
  team works on.
- Works for teams without a GitHub organization; an organization can later
  feed the manifest without changing the model.
- Everything the team shares is versioned and auditable as commits.
- Offline: reads work from the local clone; shares fail loudly until the
  push succeeds. Conflicts on the library are real git conflicts, kept
  rare by one-file-per-entry layouts and by the owner being the only
  writer of the manifest.
- Issued keys cannot be revoked (pre-existing limit); removing a member is
  removing GitHub access, which is immediate.
- Reversing this later means building the service the decision avoided;
  the manifest format is small on purpose so that migration would be an
  import, not a redesign.
