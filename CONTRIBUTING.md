# Contributing

Thanks for looking. Plyloft is maintained by one person, so the process is
short.

## Proposing a change

1. Open an issue first for anything bigger than a small fix, so the direction
   is agreed before you write it.
2. Fork, make a branch, keep the change focused on one thing.
3. Read `AGENTS.md`. It lists the rules a change must keep (the CLIs run in a
   PTY with the user's own login and never an API key, the cached PATH is
   injected into every spawn, JSON state is written atomically, children are
   killed at exit, closing the window hides it). Read `docs/PATTERNS.md` before
   touching React, zustand or a persisted struct.
4. Open a pull request that says what changed and why.

## What a pull request must pass

- `./scripts/ppvp.sh` passes (see `docs/PPVP.md`). On a machine with the dev
  server running the count differs; what matters is that it passes.
- A new persisted field comes with a test that loads a file written without it.
- A change to a terminal, an agent or saved state keeps the checks `AGENTS.md`
  names for it.
- A user-visible change updates the user guide (`docs/onboarding/USER_GUIDE.md`)
  and the tutorial step it affects, as `AGENTS.md` describes; the frontend
  tests check this.
- No secret, token or personal account goes into code, tests or fixtures; use
  placeholders.

A security problem is not an issue or a pull request: report it privately, as
`SECURITY.md` says.

## What Plyloft writes to GitHub

The list in `AGENTS.md`, under "Product boundaries", of what Plyloft may write
to GitHub is deliberate: each entry is scoped, and no push is ever forced. A
change that adds another kind of write, widens one, or loosens its consent is
not accepted as a drive-by; propose it in an issue, and it is decided there.

## Licence

By contributing you agree that your contribution is licensed under the
[MIT licence](LICENSE) of this repository. The name "Plyloft" and its logo are
not covered by it.
