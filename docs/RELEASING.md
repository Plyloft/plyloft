# Releasing Plyloft

This guide covers the one-time setup to enable signed, notarized, auto-updating builds, plus the per-release workflow.

**Current owner path:** signed releases are cut from the owner's Mac with [`scripts/release.sh`](#signed-release--auto-update-publish-scriptsreleasesh) — build → sign → notarize → staple → publish to the public feed. No workflow builds the Mac release: a tag push starts nothing. The Windows installer is the one release made on GitHub Actions, by the manual **release-windows** workflow.

**Order of a release:** bump the version and push the release commit to `main` → `./scripts/release.sh` (publishes the Mac release to the feed, then pushes the source tag `vX.Y.Z` to this repo) → run **release-windows** with that tag.

**Windows:** the installer is built after the Mac release by a manual workflow that checks out `vX.Y.Z` from this repo and adds a `windows-x86_64` entry to the same `latest.json` — see [RELEASING_WINDOWS](windows/RELEASING_WINDOWS.md). Re-running `scripts/release.sh` for the same tag keeps that entry.

**From the public repository:** from the release after the public repository `plyloft/plyloft` opens ([ADR 0010](adr/0010-free-for-one-person-open-source.md)), releases are cut from `plyloft/plyloft`, not from this repository. The details are open: the release scripts and workflows move with the export.

## One-time setup

### 1. Apple Developer Program ($99/yr)

Enroll at https://developer.apple.com/programs/. Once active:

1. In Xcode → Settings → Accounts, add the Apple ID that owns the membership.
2. Manage Certificates → "+" → **Developer ID Application** → create.
3. Keep the cert + private key in the release Mac's login keychain (`scripts/release.sh` signs with it there). To move it to another Mac, export both from Keychain Access as a `.p12` file with a password.
4. Generate an **app-specific password** at https://appleid.apple.com/account/manage → Sign-In & Security → App-Specific Passwords. This is what `notarytool` will use; store it in the keychain profile `ply-notary` (`xcrun notarytool store-credentials ply-notary`).
5. Note your **Team ID** from https://developer.apple.com/account → Membership.

### 2. Updater signing keypair

Tauri uses a separate keypair (not Apple's cert) to sign update payloads. The app's bundled public key verifies that updates haven't been tampered with.

```bash
npm run tauri signer generate -- -w ~/.tauri/ply.key
```

It prints a public key (base64) and writes the private key to the file. **Store the private key in a password manager and a printout in a safe — losing it means you can never publish another auto-update.** Never rotate the public key; once published it's permanent.

Paste the public key into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`, and point `endpoints` at the public releases feed. **Both are already configured:** the pubkey matches `~/.tauri/ply.key`, and the endpoint is `https://github.com/MatteoB-adv/ply-releases/releases/latest/download/latest.json` (a public repo holding only signed artifacts; the feed stays there in 1.178.0, whichever repository the source is in).

The base config (`tauri.conf.json`) keeps `plugins.updater.active: false` and `bundle.createUpdaterArtifacts: false` so local builds work without a private key. `scripts/release.sh` (and the release-windows workflow) merge in `src-tauri/tauri.release.conf.json` via `--config` to flip both to `true` for release builds.

### 3. GitHub Actions secrets (release-windows)

The Mac release needs no GitHub secret: `scripts/release.sh` signs,
notarizes and signs the update with what is on the release Mac (the Developer
ID certificate in the login keychain, the `ply-notary` notarytool profile,
`~/.tauri/ply.key`). Only the **release-windows** workflow reads secrets; a
fork's pull request never sees them, and it runs only on a manual dispatch by
someone with write access. In the repository → Settings → Secrets and
variables → Actions → New repository secret:

| Secret | Needed | Value |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | yes | The updater private key, the contents of `~/.tauri/ply.key` on the release Mac. The same key as the Mac release: a new one breaks every installed app's updates. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | yes | Its passphrase. |
| `PLY_RELEASES_TOKEN` | yes, to publish | A fine-grained token with *Contents: read and write* on the releases feed repository (`MatteoB-adv/ply-releases`) only. The workflow's own `GITHUB_TOKEN` cannot write to another account's repository. |
| `WINDOWS_CERTIFICATE` | no (absent today) | Base64 of an Authenticode `.pfx`. Without it the installer is unsigned. |
| `WINDOWS_CERTIFICATE_PASSWORD` | no (absent today) | The `.pfx` password. |

`GITHUB_TOKEN` is automatic; release-windows asks it for `contents: read`
only. No workflow reads a repository variable (`vars.*`).

### 4. Plyloft sign-in and the PLY2 entitlement key (1.158.0)

From 1.158.0 every build signs people in to Plyloft
([ADR 0008](adr/0008-plyloft-account-and-licence-server.md)); from 1.178.0
the sign-in is optional and needed only for Team
([ADR 0010](adr/0010-free-for-one-person-open-source.md)). Two values in
`src-tauri/src/account.rs` are compiled into every release:

| Constant | What it is | Where the secret half lives |
|---|---|---|
| `PLYLOFT_GITHUB_CLIENT_ID` | Client id of the production GitHub OAuth App "Plyloft" (account `MatteoB-adv`, Device Flow on). Public. | The client secret: Railway (`GITHUB_CLIENT_SECRET`) and 1Password. Never in the repo. |
| `ENTITLEMENT_PUBKEY_HEX` | The production **PLY2** Ed25519 public key (32 bytes, hex). The app verifies every plan with it, offline. | The private key: only in the Railway production service (`server`, `ENTITLEMENT_PRIVATE_KEY`) and in 1Password. Nowhere else: not on a Mac, not in a repo. Staging runs the **dev** keypair, not this one. |

- **Never rotate the PLY2 key casually.** Every installed app trusts only the
  embedded public key. A new keypair means a release carrying the new public
  key, then waiting until users have updated, before the server may sign with
  the new private key. An app that can't verify its token reads its plan as
  Free, and signing in again doesn't help, because the new token fails the
  same check. Up to 1.177.1 that app showed the Sign-in screen and was locked
  out of Plyloft until it updated; from 1.178.0 everything for one person
  keeps working, and Team stays off on every app still on the old key until
  it updates. Rotate only after the private key is exposed, and plan the
  order first.
- **If the private key is lost,** restore it from 1Password. Without it, the
  only way out is a rotation, with the lock-out described above.
- Staging and local servers sign with the **dev keypair**
  (`~/ply-build/launch-dev-keys/`, also used by `scripts/dev-mint-entitlement.mjs`);
  production has its own key, above. Debug builds trust the dev key through
  `PLYLOFT_ENTITLEMENT_PUBKEY` (hex) and pick a server with `PLYLOFT_API_URL`.
  Release builds ignore both: they always use `https://api.plyloft.com/v1` and
  the embedded production key.
- **Release guard.** `scripts/check-account-config.sh` refuses a release whose
  client id or public key is empty, or whose key is not 32 bytes of hex. Such
  a build could sign nobody in ("Sign-in isn't set up"): up to 1.177.1 that
  locked every user out, and from 1.178.0 it leaves Team out of reach. It runs at the
  start of `scripts/release.sh` (not with `--publish-only`) and as a step of
  the `release-windows` workflow. Its contract test is
  `scripts/test-check-account-config.sh`, run by PPVP's pure-contracts step.

### 5. Prices

From 1.178.0 there is no founding price (owner, 2026-11-26,
[ADR 0010](adr/0010-free-for-one-person-open-source.md)): only Team is sold,
at €9 per member per month or €86.40 per member per year, from two members.
The 1.178.0 site has no `FOUNDING_OPEN` and no founding labels, and the
server's runbook no longer has a day when list prices replace founding ones.
The server finds the Team prices by their Stripe lookup keys
(`PRICE_TEAM_MONTHLY` / `PRICE_TEAM_YEARLY`, default `team_monthly_founding` /
`team_yearly_founding`): the names are historical, and the server's README
says not to rename them. How a future price change would be made is open.

The app shows the Team price before Checkout from `SEAT_PRICE_CENTS` in
`src/lib/teamBilling.ts` (VAT included): a price change changes it too, in an
app release.

## Per-release workflow

### 1.178.0: order of this release

*For 1.178.0 only (Free and Team, open source; [ADR 0010](adr/0010-free-for-one-person-open-source.md)).*

1. **The licence server first.** The 1.178 server (`plyloft-server`, branch
   `next/free-and-team`, migration 008) goes to staging, then to production,
   **before** the app is released, following the server README's runbook
   *Deploying the 1.178 server*. The owner pushes the server's `main`. The
   new server is compatible with every installed app. An app 1.178.0 against
   the old server stays on Free and shows no Team state, so the app must not
   go out first.
2. **Then the app**, with the two commands below.
3. **The site's link to the public repository and `/plyloft-vs-orca`** go
   live only once the public repository `plyloft/plyloft` exists.

### The two commands

The owner releases from two Macs: the site is published from the Mac mini, the
app from the MacBook (`scripts/release.sh`). Each half has one script that does
the steps and refuses, before anything else, what has gone wrong before: a
command pasted across two lines, a stale changelog draft in the site repo, an
Apple agreement that expired. Run them in this order, after the version bump
and the release commit are on `origin/main`.

1. **Mac mini** (the app repo on `main`, clean, equal to `origin/main`):

   ```bash
   ./scripts/release-site-step.sh
   ```

   It makes the user guide page from HEAD into the site repo
   (`$PLY_SITE_REPO`, default `~/code/plyloft-site`, on `main` and not behind
   `origin/main`), builds the site, runs `npm run check:seo`, commits
   `User guide for X.Y.Z` (only if the guide changed) and `lastmod for X.Y.Z`
   (only if `lastmod.json` changed), staging exactly those two files and
   nothing else in the site repo. It never pushes: it ends by printing the one
   command for the owner to type, which a hook allows in exactly this form:

   ```bash
   cd /Users/example/code/plyloft-site && git push origin main
   ```

   `--check` changes nothing in your files and says what it would do (it does
   fetch from GitHub, which updates the remote-tracking refs, as the preflight
   does). Before the push line it lists the commits that push sends. A second
   run says there is nothing to do: once a `lastmod for X.Y.Z` commit exists
   and the guide is unchanged, `lastmod` is not run again (it dates pages in UTC,
   so near local midnight it would otherwise commit again).

2. **MacBook**: `./scripts/release-preflight.sh`, which changes nothing in your files (it
   does fetch from GitHub). It checks the app
   repo (on `main`, clean, equal to `origin/main` after a fetch, the version
   files in step, `node_modules` equal to the lockfile), the site repo (fetched,
   `main` equal to `origin/main`, and the stale `src/data/releases.ts` draft
   that `release.sh` leaves after each release, named with the two commands to
   save it aside and discard it; the script never discards it), the guide check
   `release.sh` will run, the highlights' date against today (a warning), the
   signing identity, the updater key, and whether Apple accepts the notary
   profile right now (an expired agreement answers 403 and has nothing to do
   with the code). Every `✗` has its one fix; any `✗` exits non-zero. When
   everything passes it prints the release line:

   ```bash
   RELEASE_NOTES="$(cat /Users/mb/.plyloft-release-notes-X.Y.Z.txt)" ./scripts/release.sh
   ```

   The notes are read from that file (the first run drafts it from the
   version's highlights; edit it if you want other words, an existing file is
   never overwritten), so the line is always one short physical line with none
   of the notes' quotes or newlines in it: a paste cannot run half of it.
   Pull the site and the app first if the preflight said so (`git pull
   --ff-only`), and `npm ci` if it said `node_modules` differs.

Then **release-windows** with the tag, exactly as described in the order of a
release above and in [RELEASING_WINDOWS](windows/RELEASING_WINDOWS.md); the
exact command is printed at the end of `release.sh`. The detailed sections
below are the reference for what these scripts do. The shared checks live in
`scripts/lib/release-checks.sh`, sourced by `release.sh` and the preflight; the
contracts are `scripts/test-release-site-step.sh`,
`scripts/test-release-preflight.sh` and `scripts/test-release.sh`.

### Signed release + auto-update publish (`scripts/release.sh`)

The path actually used to cut a notarized, auto-updating build from the owner's
Mac — no CI required. Prereqs (one-time, above): Developer ID cert in the
keychain, a `notarytool` keychain profile named `ply-notary`, the updater
private key at `~/.tauri/ply.key`, and `gh` authenticated (plus `jq`).

```bash
# Bump package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json in
# lockstep first (the ppvp version-sync check enforces they agree), then:
./scripts/release.sh
```

For the v1.90.2 Phase 4 reviewer PATH release, the canonical Terminal.app
invocation is:

```bash
cd /Users/mb/code/atelier
RELEASE_NOTES="Ply 1.90.2 — Reviewer probe reliability: provider version checks now inherit Ply's cached GUI-safe PATH, restoring Codex capability detection, and Claude's proof label matches its verified dontAsk harness." ./scripts/release.sh
```

For the v1.92.1 Phase 6 installed-gate correction, use:

```bash
cd /Users/mb/code/atelier
RELEASE_NOTES="Ply 1.92.1 — Evidence-backed Knowledge generation now allows a bounded five-minute Claude startup window while preserving explicit retry and no automatic paid replay." ./scripts/release.sh
```

For the v1.93.0 UX hierarchy fidelity release, use:

```bash
cd /Users/mb/code/atelier
RELEASE_NOTES="Ply 1.93.0 — A clearer guided workflow: contextual Knowledge, honest Commands, one current workspace shell, project-first workspace creation, and optional Terminals tile layouts." ./scripts/release.sh
```

The version bump, release commit, and `git push origin main` must already be
complete before this command runs. A bundled skill changed in this release has
a `src-tauri/resources/ply-skills/CHANGES.json` entry (and a
`ply-skills-history/<skill>/<version>/` copy) written on its branch; the
script stops when an entry names a version later than the one being released,
so rename it to this version first. `RELEASE_NOTES` changes only the published
notes; it does not change the app or updater-manifest version.
The user guide must also be on the site first (D26): see *The user guide on
the site* below. Until the site has its page, every release stops there.

#### The source tag

`release-windows.yml` checks out `vX.Y.Z` from **this** repo, but `gh release
create` makes that tag only in the feed repo. So `release.sh` also tags the
commit it builds (HEAD) here:

- **Before building** (and before publishing, with `--publish-only`) it stops,
  with nothing built or pushed, when HEAD's committed `package.json`,
  `src-tauri/tauri.conf.json` or `src-tauri/Cargo.toml` doesn't say the version
  being released, when HEAD isn't on `origin/main` after a fetch (push the
  release commit first), or when `vX.Y.Z` already exists here or on `origin` on
  another commit. A tag is never moved. A tag on a different commit with the
  same tree counts as the same source (the release commit and the PR merge
  that brought it to `main` unchanged).
- **After a successful publish** it creates the annotated tag `vX.Y.Z`
  (`Plyloft X.Y.Z`) on HEAD and pushes only that ref
  (`git push origin refs/tags/vX.Y.Z`). A failed run leaves no tag. A re-run
  (a full run or `--publish-only`) finds the tag and says so; a tag that exists
  only locally is pushed. If the push fails, the Mac release is already out:
  the script exits non-zero and prints the commands to push the tag.
- It ends with the next step:
  `gh workflow run release-windows.yml -f tag=vX.Y.Z -f publish=true`.

Tags up to v1.151.0 exist only in the feed repo, not here. v1.152.0 was
pushed here by hand (annotated, on the release commit `38b831a5`).

> **Run this in a real terminal (Terminal.app / iTerm), NOT via Claude Code's
> `!` prefix.** The script prompts for the updater-key password with `read -s`,
> which needs a TTY. Through the chat `!` shell there's no TTY, so it silently
> stalls right after the preflight (preflight prints, then nothing) and never
> builds or publishes — the feed stays on the previous version and running apps
> see no update. (Cost us a confused round-trip on the v1.62.0 release.)

It runs, in order: preflight → build and Developer-ID-sign the target-triple
`ply-mcp` input → build the app with the release overlay
(`tauri.release.conf.json`, which flips `updater.active` +
`createUpdaterArtifacts` true and sets the signing identity + entitlements) →
verify the nested sidecar's executable bit, protocol marker, and exact signing
identity in both `Plyloft.app` and the updater archive → `codesign --verify` →
`notarytool submit --wait` → `stapler staple` → generate `latest.json` (Tauri v2
format, the `.sig` contents inlined as the `signature`) → `gh release create
v<X.Y.Z>` on `MatteoB-adv/ply-releases` with the `.dmg` + `Plyloft.app.tar.gz` +
`latest.json`, marked `--latest`. Re-running clobbers a tag's assets idempotently.

When the tag already has a `latest.json` of the same version, the new one keeps
its other platform entries (the `windows-x86_64` entry the
[Windows workflow](windows/RELEASING_WINDOWS.md) merged in) and replaces only
`darwin-aarch64`, `version`, `notes` and `pub_date`; the script prints which
platforms it kept. A `latest.json` of another version, or an unparseable one,
is replaced with `darwin-aarch64` only. If the tag has a `latest.json` that
can't be downloaded, the script stops before uploading. Order: the Mac release
first, then the Windows workflow for the same tag.

The DMG published is always `Plyloft_<version>_aarch64.dmg` for the version in
`package.json`; older DMGs left in `bundle/dmg/` are ignored. The updater
archive's `Info.plist` `CFBundleShortVersionString` must equal that version.

#### The user guide on the site

> **A release prerequisite, from the release that ships the Getting started
> tour on.** `release.sh` stops before building (and before publishing, with
> `--publish-only`) until `plyloft-site` has this commit's user guide
> committed on its `main` as `src/content/docs/docs/guide.md`. That page does
> not exist yet, and site edits need the owner's go, so **the next release
> stops here** until the owner does the one-time steps and the site step
> below. Nothing is built or pushed when it stops; the message prints the
> commands.

The user guide is published on the site at every release (D26,
[TUTORIAL_SPEC](tutorial/TUTORIAL_SPEC.md) §12.3). Its source stays
`docs/onboarding/USER_GUIDE.md`; the site's copy is one Starlight page,
`src/content/docs/docs/guide.md` in `plyloft-site` (`https://www.plyloft.com/docs/guide/`),
made by `scripts/site-guide.mjs` and never edited by hand. The script keeps
the guide's text, puts its `# ` title and a fixed description in the
frontmatter, and drops the HTML comments (the `<!-- tour:… -->` markers and
review notes; each must sit on one line). It is a `.md` page, not `.mdx`, so
the guide's Markdown is read as it is.

**What `release.sh` checks.** Right after the version check, it makes HEAD's
guide into that page and compares it with the copy **committed on the site's
`main`** (`$PLY_SITE_BRANCH` names another branch) in `$PLY_SITE_REPO`
(default `~/code/plyloft-site`), whatever branch the site's checkout is on:

- it stops, with nothing built or pushed, when `main` has no copy or a copy of
  another guide (the guide changed since it was last published), and says
  when the checkout's file is right but isn't committed on `main`; it also
  stops when HEAD's guide can't be made into a page (no `# ` title, or an
  HTML comment over several lines). It prints the commands that write and
  commit the copy;
- it says `✓ The site's copy of the user guide matches HEAD's (… on main)`
  and goes on when it matches, with a warning (not a stop) when the site's
  `main` has commits that are not on its `origin/main` as this Mac last saw
  it;
- it is skipped, with a line saying so, when there is no site repository
  (no `src/content/docs` in `$PLY_SITE_REPO`) or when HEAD has no guide.

It checks the site's repository, not what plyloft.com serves: publish the
site before releasing.

**Once, before the tour ships** (the owner, in `plyloft-site`; the page must
exist first, D26):

1. Make the page: the site step below.
2. List it first under *Start here* in `src/data/docsNav.ts`:
   `{ label: 'User guide', slug: 'docs/guide' }`. The sidebar, `/llms.txt` and
   `/llms-full.txt` follow that list.
3. **Help › User guide** opens `https://www.plyloft.com/docs/` (D14,
   `USER_GUIDE_URL` in `src/components/tutorial/HelpMenu.tsx`), today the
   *Install Plyloft* page. Add a line at its top that links to
   `/docs/guide/`, or move the guide to `/docs/` and *Install Plyloft* to its
   own page; the latter changes D14's page, so it is the owner's choice. The
   app's link stays `/docs/` either way.
4. The site's own docs pages (for example *Guided setup*, whose Ready step
   still says *Try a guided first card*, and *Your first card*) are written by
   hand and are not checked by `release.sh`; re-read them against the guide
   when it changes.

**The site step, every release whose guide changed** (the first time too).
From this repository, on the release commit:

```bash
git show HEAD:docs/onboarding/USER_GUIDE.md > /tmp/USER_GUIDE.md
node scripts/site-guide.mjs --write --guide /tmp/USER_GUIDE.md \
  --out ~/code/plyloft-site/src/content/docs/docs/guide.md
cd ~/code/plyloft-site        # on main
npx astro build && npm run check:seo
git add src/content/docs/docs/guide.md
git commit -m "User guide for X.Y.Z"
```

Then publish the site as its README says (`npm run lastmod` first, then its
`main` pushed), and run `./scripts/release.sh`.

#### Site labels (warning)

The site draws the app's screens by hand (its scenes) and quotes the app's
words in its copy, so an app rename leaves the site behind unless someone
notices. Right after the user guide check, `release.sh` runs
`scripts/site-labels.mjs --check --warn` on the same committed site branch
(`$PLY_SITE_REPO`, `$PLY_SITE_BRANCH`) against HEAD's app sources, and prints
each word that differs as a `⚠ Site labels: file:line: "old" → "new"` line
(at most 30, then a count and the full command for the rest). Since 1.169.0
it also compares the site's `public/models.json` (served as
www.plyloft.com/models.json) with the app's `src-tauri/catalog/models.json` and
says when they differ, the site's isn't `schemaVersion: 1`, or a site with a
`public/` folder has none (rule `models`). **It never
stops a release**, and it is skipped, with one line, when there is no site
repository. It reads the site's *local* branch, as the guide check does; when
that branch is behind `origin/main` as this Mac last fetched it, it adds
`⚠ Site labels read your local main, N commit(s) behind origin/main as last
fetched: pull the site first, or these may already be fixed.`

It looks for two things, and only in shapes that can only be a drawing of the
app (the script's header has the exact rules):

- **Retired words**, a short list in the script with each word's replacement
  and release: *Build done* (now `FINISH_LABEL`, *Finish and check*), *Board
  and worktrees*, *Put back in To do*, the old *Waiting* column, *Profile and
  licence*, *Windows 10*, and finding codes such as *F1 · P1*. Its own test
  fails when a replacement is no longer in the app either, so the list can't
  drift quietly.
- **Live words**, read from the app's sources: the Board's columns
  (`boardSemantics.ts`), the Settings entries (`settingsNav.ts`), the Setup
  steps (`setupSteps.ts`) and the sidebar rows (`sidebarNav.ts`). A drawn
  Board, Settings list, Setup rail or sidebar on the site that has a name the
  app doesn't, or lacks one it has, is listed.

The site's `src/data/releases.ts` (history), its generated `docs/guide.md`
(D26 checks it) and blog drafts (`draft: true`) are not checked. A name a
drawn part lacks is said once per file. A line that mentions an old word on
purpose (*Windows 10 isn't supported*) carries `site-labels: allow` in a
comment on that line (`{/* site-labels: allow */}` in `.mdx`, `// …` in
code), and its findings are dropped.

To see the whole list before a release, from this repository's folder:
`node scripts/site-labels.mjs --check --repo ~/code/plyloft-site --ref main`.
`--ref main` is the site's local branch; `--ref origin/main` reads what this
Mac last fetched. When the app retires a word, add it to
`RETIRED` in the script and a case to `site-labels.test.mjs`.

#### New in this version (the app's highlights)

Help › New in this version shows each release's highlights from
`src/lib/releaseHighlights.ts` (newest first): a one-line title and three to
five points, in the site changelog's plain words, shorter, with no card
numbers. Write the new version's entry in the release PR, from its STATUS
entry, and point a highlight at its place where one fits (`action: { nav: … }`
— a mode, a Library page, All skills or a Settings page — or `{ tour: true }`).
The site's changelog entry, which `release.sh` drafts after the tag, is then
rewritten to agree with it. The pure contracts (`releaseHighlights.test.ts`)
fail the gate when the minor version (`x.y.0`) of `package.json` has no entry,
so a minor's bump and its highlights land together; a patch release shows its
minor's, or its own entry (one to five points) when it has one. The owner
approves the words in that PR.

#### The site changelog draft

After the tag, `release.sh` writes a draft entry for the version into the
site's `src/data/releases.ts` (`$PLY_SITE_REPO`, default
`~/code/plyloft-site`) from the top entry of `docs/STATUS.md` at the built
commit: the headline up to its colon as the title, one note per top-level
bullet of the "What" part (its label and first sentence, card numbers
removed), guessed areas, and `SINCE.count` one up
(`scripts/site-changelog.mjs`). The change is left **uncommitted**: review and
rewrite it in the site's plain words, commit it there, and rebuild the site.
The step never fails the release. It is skipped, with a line saying why, when
the site folder is missing, when STATUS.md's top entry is another version, or
when the version is already listed. Write the STATUS entry before releasing.

#### When the upload fails

The publish step (`gh release create`, or `upload --clobber` + `edit --latest`
when the tag exists) is tried up to 4 times, 15 s apart
(`PLY_RELEASE_UPLOAD_ATTEMPTS`, `PLY_RELEASE_UPLOAD_PAUSE_SECONDS`). If it
still fails, the build, signing and notarization already done are kept in
`src-tauri/target/aarch64-apple-darwin/release/bundle`. Publish them again
without rebuilding or notarizing a second time:

```bash
./scripts/release.sh --publish-only
# with the same notes as the failed run:
RELEASE_NOTES="Plyloft X.Y.Z — …" ./scripts/release.sh --publish-only
```

`--publish-only` needs `gh` (authenticated) and `jq`. It does not need the
notary profile, the keychain identity or the updater-key password. It checks
that this version's DMG, `Plyloft.app.tar.gz` and `.sig` exist, the archive's
version, the nested `ply-mcp` (protocol marker, signed by the configured
identity), `stapler validate` and `spctl` on the DMG. Then it regenerates
`latest.json` (keeping the tag's other platforms of the same version, as
above) and publishes, taking the `--clobber` path if the tag already
exists. If an artifact is missing or of another version, it stops, names the
file and says a full run is needed. It checks and pushes the source tag as a
full run does, on HEAD: run it from the commit that was built.

Local Tauri dev/build hooks call `scripts/build-sidecar.sh` automatically,
through `scripts/build-sidecar.mjs` (which runs it with Git Bash on Windows).
Generated `src-tauri/binaries/ply-mcp-<target>` files are build inputs and are
ignored by Git. Release builds set `PLY_SIDECAR_SKIP_BUILD=1` only after signing
that input, so Tauri validates and reuses the signed bytes instead of replacing
them during its before-build hook.

Result: the `.dmg` installs on any Mac with no Gatekeeper warning (hand it to a
teammate once), and every running Plyloft on an older version sees the new one on
next launch and offers a one-click in-place update. `install-local.sh` stays the
**unsigned** fast-iteration path; `release.sh` is the **signed-publish** path.

### Bundle rename: Ply.app → Plyloft.app (one-time owner migration)

From v1.154.2 Plyloft offers this removal at launch (`legacy_install.rs`: the
old folder or `Ply.app` and its shortcuts go to the Recycle Bin / Trash, the
uninstall key is deleted, the profile is never touched), and its NSIS
installer refuses a downgrade (`src-tauri/windows/installer-hooks.nsh`). An
old Ply that is still installed can otherwise run the latest Plyloft
installer and overwrite a newer Plyloft (seen in the VM, 2026-09-30). The
manual steps below stay for installs older than that.

The `identifier` (`com.mbadv.ply`), the updater feed and pubkey, and every
persisted data path are unchanged by this rename — only `productName` (and so
the bundle, DMG, updater archive and NSIS installer names) moved from `Ply` to
`Plyloft`. Existing installs on the owner's machines need one manual, one-time
step each; after that, ordinary auto-update keeps working.

- **macOS:** install `Plyloft.app` from the new DMG (drag it to
  `/Applications` as usual), quit and delete the old `/Applications/Ply.app`.
  Your workspaces, settings and Kanban stay put — `identifier` didn't change,
  so `~/Library/Application Support/com.mbadv.ply/` is untouched. From then on
  the in-app updater installs new versions of `Plyloft.app` in place.
  Accepting the in-app update *before* doing this is harmless either way: the
  updater installs in place at whatever path the running app already lives
  at, so an old `Ply.app` that took an in-app update just keeps running as
  `Ply.app` (now on the new version) from `/Applications/Ply.app` until you
  move it by hand — there's no second copy on macOS.
- **Windows VM — do this BEFORE the first Plyloft release is published, or
  before opening the update prompt on the VM:** on the update prompt, click
  **Later** (do not accept it). Uninstall "Ply" from *Settings → Installed
  apps* **without** checking the delete-app-data option, then run
  `Plyloft_<version>_x64-setup.exe` **interactively** (double-click it, don't
  let the in-app updater run it silently). Data at `%APPDATA%\com.mbadv.ply`
  and `%LOCALAPPDATA%\com.mbadv.ply` (keyed by `identifier`, not
  `productName`) survives either way; the delete-app-data option is what
  would actually remove it.
  - **If the update was already accepted** (so the VM now has a copy at
    `%LOCALAPPDATA%\Plyloft` installed via `installMode: "passive"`, with no
    Start Menu shortcuts — Windows' passive/update mode skips shortcut
    creation, so the Start Menu still launches the old 1.152.x copy): the
    recovery is the same sequence run after the fact — uninstall "Ply"
    without deleting app data, then run the Plyloft `setup.exe`
    **interactively** so the installer creates the Start Menu shortcuts this
    time.

Why this can't be skipped: the macOS updater always installs in place at the
existing app path, so a stale `/Applications/Ply.app` next to the fresh
`Plyloft.app` is just a leftover to clean up, not a second running copy. On
Windows the NSIS installer keys its default install directory off
`productName` (`$LOCALAPPDATA\${PRODUCTNAME}`), so a `productName` change
means the *new* installer's default location (`%LOCALAPPDATA%\Plyloft`)
differs from where the *old* one put itself (`%LOCALAPPDATA%\Ply`) —
installing straight over an existing "Ply" without uninstalling first leaves
two side-by-side copies instead of one updated app. Worse, the in-app
updater always runs the installer passively (`tauri.conf.json` →
`plugins.updater.windows.installMode: "passive"`), and Tauri's NSIS
installer skips creating Start Menu shortcuts in that mode — so an
in-app-accepted update silently produces a second, shortcut-less
`%LOCALAPPDATA%\Plyloft` copy while the Start Menu keeps launching the old
`Ply` one.

### v1.9+ ship gate (preferred)

Starting in v1.9.0, ship through the in-app **Ship now** / **Ship batch**
buttons (per-card on `CardDetailPanel`, batch on `AppToolbar`). The ship
pipeline:

1. Verifies the working branch is `main` and the new tag doesn't already exist.
2. Syncs the version across `package.json` / `src-tauri/Cargo.toml` /
   `src-tauri/tauri.conf.json` atomically.
3. Stages + commits with a `Card: <id>` trailer per shipped card. Batch
   ships use one commit listing every card title in the body. Only tracked
   changes are staged (`git add -u`: the squash-merged card work, the version
   files, tracked edits) — never an untracked file in the checkout (GH #196).
   A declared version file must be tracked (the ship is refused otherwise); an
   untracked `Cargo.lock` still gets its version rewritten on disk but is not
   committed.
4. Tags `v<X.Y.Z>`.
5. If `release_kind == "github"`: pushes `main` + the tag. No workflow
   starts on the tag: the signed, notarized Mac release is then made with
   `scripts/release.sh` on the release Mac, and the Windows one with the
   release-windows workflow (above).
6. Runs `scripts/install-local.sh` (detached) to overwrite
   `/Applications/Atelier.app`.

**Milestone-trigger guidance**: select `release_kind: github` only for
*shippable* milestones — each one is meant to become a signed release
(`scripts/release.sh`). Per-card iterations should
default to `release_kind: local`. A reasonable cadence is one GitHub
release per phase boundary (e.g. v1.10.0, v1.11.0) or per N completed
cards rather than per card. Skip-verify ships (`-unverified` suffix)
are blocked from the GitHub path by policy — they can only ship as
`local`.

### Manual fallback

If the in-app ship fails (e.g. mid-build crash), you can still cut a
release manually:

```bash
# 1. Bump versions in lockstep
#    - package.json
#    - src-tauri/Cargo.toml
#    - src-tauri/tauri.conf.json
npm version 0.2.0 --no-git-tag-version
# (manually update Cargo.toml and tauri.conf.json to match)

git add -u   # tracked changes only; never sweep untracked files into a release
git commit -m "release: v0.2.0"
git tag v0.2.0
git push origin main --tags
```

The push starts no workflow. Then run `./scripts/release-preflight.sh` and
`./scripts/release.sh` on the release Mac (above): it builds for
`aarch64-apple-darwin`, signs with the Developer ID certificate, notarizes and
staples, signs the updater payload, and publishes the `.dmg`, `.app.tar.gz`,
its `.sig` and `latest.json` to the feed. Then dispatch release-windows with
the tag.

Existing instances pick up the update on next launch (or manually via the in-app prompt).

## Rollback

`tauri-plugin-updater` does not support automatic rollback. If a release is broken:

1. Manually delete the broken `latest.json` from the GitHub Release (or attach an older one).
2. Tell users to download the previous `.dmg` manually.
3. Investigate, fix, and ship a new tag.

To reduce blast radius, mark in-progress releases as **prerelease** in GitHub — `latest.json` should always point to a stable build.

## Apple Silicon only

`scripts/release.sh` builds only `aarch64-apple-darwin` (`TARGET` at its top). Intel Mac users have to build manually. A universal build would change it to `universal-apple-darwin` (with the `x86_64-apple-darwin` Rust target installed), and the feed entry and `.dmg` name the script writes; the build time roughly doubles.

## Troubleshooting

- **`release.sh` hangs on "Notarizing"**: Apple's queue. Wait 15 min; if still stuck, check https://developer.apple.com/system-status/.
- **`spctl --assess` fails on the produced `.app`**: stapler probably didn't run. Add `xcrun stapler staple Atelier.app` after the `tauri build` step.
- **First signed build re-prompts for TCC permissions** (Documents, Desktop, Downloads): expected. Note in release notes.
- **Update verification fails**: pubkey in `tauri.conf.json` doesn't match the private key used to sign. Check both.
- **Release stops on nested `ply-mcp` verification**: do not bypass it. Confirm the target triple, the `protocol 1` marker from `--version`, and that the nested executable's `Authority=` matches `bundle.macOS.signingIdentity` in `tauri.release.conf.json`.
