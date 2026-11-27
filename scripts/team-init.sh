#!/usr/bin/env bash
#
# Ply — create a team (owner-side, v1.114.0, team sharing rung 1).
#
# SUPERSEDED by Settings → Team → Create team (v1.118.0, rung 5). That is
# now the way a team is created: it does the same three things — private
# repo, manifest, empty library — and then attaches the team to the owner's
# Team plan (launch T1). Team keys are retired: nothing is minted.
#
# This script is kept as the recovery and scripting path, the way
# `install-local.sh` is: it needs no Ply and no key, so it is what remains
# when the app will not start, and it is what a shell script can call. Its
# manifest is the one `src-tauri/src/team_admin.rs` writes and
# `src-tauri/src/team.rs` parses; the three must not drift, and
# `scripts/test-team-init.sh` plus `team_admin_tests.rs` are what say so.
#
# A team IS a private GitHub repository: docs/adr/0002-team-is-a-github-repo.md.
#
# Usage:
#   ./scripts/team-init.sh --name "MB Adv" [--repo owner/name]
#                          [--workspace owner/repo]... [--member login]...
#
#   --name       team display name (required).
#   --repo       team repo to create; default <your login>/<slugified name>-team.
#   --workspace  a team workspace. Repeatable. With none given, the repo of
#                the current directory is used (so running this from inside
#                the repo you already share is the zero-argument path).
#   --member     an extra member login (you are always added, as owner).
#
# Idempotent-ish: it refuses to touch a team repo that already exists rather
# than overwrite a manifest with members in it. Deleting a team is a GitHub
# operation the owner does by hand — on purpose.
#
# Afterwards: attach the team to your Team plan in Plyloft (Settings → Team →
# Finish creating your team), and add members there (each takes a seat).
set -euo pipefail

say()  { printf '\n\033[1m── %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '  ▸ %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

NAME=""
REPO=""
WORKSPACES=()
MEMBERS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)      NAME="$2"; shift 2 ;;
    --repo)      REPO="$2"; shift 2 ;;
    --workspace) WORKSPACES+=("$2"); shift 2 ;;
    --member)    [[ -n "$2" ]] && MEMBERS+=("$2"); shift 2 ;;
    *) die "unknown arg: $1
usage: $0 --name \"Team\" [--repo owner/name] [--workspace owner/repo]... [--member login]..." ;;
  esac
done

[[ -n "$NAME" ]] || die "--name is required (the team's display name)."
command -v gh >/dev/null 2>&1 || die "GitHub CLI (gh) is required."
command -v jq >/dev/null 2>&1 || die "jq is required."
gh auth status >/dev/null 2>&1 || die "gh is not authenticated — run: gh auth login"

# Extra member logins, one per line, and nothing (status 0) when there are
# none. Bash 3.2 rejects "${MEMBERS[@]}" on an empty array under `set -u`,
# and a `[[ … ]] && …` loop body leaves a non-zero status that `set -e`
# plus `pipefail` turn into an exit — which used to abandon the run after
# `gh repo create` had already succeeded.
extra_members() {
  if ((${#MEMBERS[@]})); then
    printf '%s\n' "${MEMBERS[@]}"
  fi
}

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

is_slug() { [[ "$1" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; }

LOGIN="$(gh api user --jq .login)"
[[ -n "$LOGIN" ]] || die "Could not read your GitHub login from gh."

if [[ -z "$REPO" ]]; then
  # F6: a name already ending in "team" keeps it once (team_admin::suggest_team_repo).
  NAME_SLUG="$(slugify "$NAME")"
  if [[ "$NAME_SLUG" == "team" || "$NAME_SLUG" == *-team ]]; then
    REPO="$LOGIN/$NAME_SLUG"
  else
    REPO="$LOGIN/$NAME_SLUG-team"
  fi
fi
is_slug "$REPO" || die "--repo must be owner/name (got: $REPO)"

# Default workspace: the repo this script is being run inside.
if [[ ${#WORKSPACES[@]} -eq 0 ]]; then
  CURRENT="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
  [[ -n "$CURRENT" ]] || die "No --workspace given and the current directory is not a GitHub repo."
  WORKSPACES=("$CURRENT")
  note "no --workspace given — using the current repo: $CURRENT"
fi
for slug in "${WORKSPACES[@]}"; do
  is_slug "$slug" || die "--workspace must be owner/name (got: $slug)"
done
while IFS= read -r login; do
  [[ "$login" =~ ^[A-Za-z0-9-]+$ ]] || die "--member must be a GitHub login (got: $login)"
done < <(extra_members)

say "Creating the team repo"
if gh repo view "$REPO" >/dev/null 2>&1; then
  die "$REPO already exists. Point --repo at a new name, or edit its team.json by hand —
    this script will not overwrite a manifest that may already list members."
fi
gh repo create "$REPO" --private --description "Ply team: $NAME" >/dev/null
ok "created private repo $REPO"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CLONE="$WORK/team"
gh repo clone "$REPO" "$CLONE" -- --quiet 2>/dev/null || gh repo clone "$REPO" "$CLONE"
ok "cloned to a temporary checkout"

say "Writing the manifest"
# The manifest IS the team: name, members (one owner), team workspaces.
# `src-tauri/src/team.rs::parse_manifest` reads exactly this shape.
MEMBERS_JSON="$(
  {
    printf '%s\n' "$LOGIN"
    extra_members
  } | jq -R . | jq -s --arg owner "$LOGIN" \
      'unique_by(.) | map({login: ., owner: (. == $owner)}) | sort_by(.owner | not)'
)"
WORKSPACES_JSON="$(printf '%s\n' "${WORKSPACES[@]}" | jq -R . | jq -s 'map({repo: .})')"
jq -n \
  --arg name "$NAME" \
  --argjson members "$MEMBERS_JSON" \
  --argjson workspaces "$WORKSPACES_JSON" \
  '{schemaVersion: 1, name: $name, members: $members, workspaces: $workspaces}' \
  > "$CLONE/team.json"
ok "team.json — $(printf '%s' "$MEMBERS_JSON" | jq length) member(s), ${#WORKSPACES[@]} workspace(s)"

# The library directories rungs 2 and 3 fill. Empty directories do not exist
# in git, so each carries a .gitkeep; Ply creates nothing on a member's Mac.
for dir in library/knowledge library/claude library/codex; do
  mkdir -p "$CLONE/$dir"
  : > "$CLONE/$dir/.gitkeep"
done
cat > "$CLONE/README.md" <<README
# $NAME — Ply team

This repository **is** the team (Ply, ADR 0002). Nothing here is meant to be
edited by hand except by the team owner.

- \`team.json\` — the manifest: team name, members, team workspaces.
  Membership = listed here **and** able to read this repo on GitHub.
- \`library/knowledge/\` — Team-scope Knowledge (Ply writes it).
- \`library/claude/\`, \`library/codex/\` — team skills for both CLIs.

Members join by pasting a Ply team key that names this repo; Ply clones it
under its own app support and never treats it as a workspace.
README

git -C "$CLONE" add -A
# Only stand in for a missing git identity — never override the owner's.
IDENT=()
git -C "$CLONE" config user.name  >/dev/null 2>&1 || IDENT+=(-c "user.name=$LOGIN")
git -C "$CLONE" config user.email >/dev/null 2>&1 ||
  IDENT+=(-c "user.email=$LOGIN@users.noreply.github.com")
git -C "$CLONE" ${IDENT[@]+"${IDENT[@]}"} commit -q -m "team: $NAME manifest and empty library"
git -C "$CLONE" push -q origin HEAD
ok "pushed the manifest"

say "Next: grant access, then attach the team to your plan"
echo "  1. Give every member read access to $REPO (write, to share into the library):"
while IFS= read -r login; do
  echo "       gh api -X PUT repos/$REPO/collaborators/$login -f permission=push"
done < <(extra_members)
echo "     …and to each team workspace they should get."
echo
echo "  2. Attach the team to your Team plan: in Plyloft, Settings → Team →"
echo "     Finish creating your team. Members each take a seat there."
echo
echo "  --team-repo value:"
echo
echo "$REPO"
