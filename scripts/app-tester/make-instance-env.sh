#!/usr/bin/env bash
# Team walks (docs/app-tester/DESIGN.md): creates each instance's identity,
# ~/Library/Application Support/ply-test-owner and ply-test-member, each with
# gh/ (GH_CONFIG_DIR, naming only that person) and gitconfig (GIT_CONFIG_GLOBAL).
# Safe to run again. For a person to run; no tool exposes it to the agent.
#
#   scripts/app-tester/make-instance-env.sh
#
# Both logins must already be in gh's own config (`gh auth login`). No token is
# read, copied or printed: gh keeps finding them in the keychain, which stays
# shared, so `gh auth token --user <the other login>` still answers in either
# env (known limit; app_launch's identity check closes the app's route). It
# logs nobody in or out. PLY_TEST_ENV_BASE replaces the parent directory (tests).
#
# The two logins and ids come from walk.env (walk-config.sh; the template is
# walk.env.example): PLY_WALK_OWNER_LOGIN, PLY_WALK_OWNER_ID,
# PLY_WALK_MEMBER_LOGIN, PLY_WALK_MEMBER_ID.
set -euo pipefail
. "$(dirname "$0")/walk-config.sh"
walk_config_require PLY_WALK_OWNER_LOGIN PLY_WALK_OWNER_ID PLY_WALK_MEMBER_LOGIN PLY_WALK_MEMBER_ID
BASE="${PLY_TEST_ENV_BASE:-$HOME/Library/Application Support}"
SOURCE="${GH_CONFIG_DIR:-$HOME/.config/gh}"
GH="$(command -v gh)" || { echo "✗ gh is not installed" >&2; exit 1; }

write_atomic() { # <path> <text>
  local tmp="$1.$$.tmp"
  (umask 077; printf '%s\n' "$2" >"$tmp")
  mv "$tmp" "$1"
}

make_env() { # <dir name> <login> <github id>
  local dir="$BASE/$1" login="$2" id="$3"
  grep -qE "^[[:space:]]+$login:" "$SOURCE/hosts.yml" 2>/dev/null \
    || { echo "✗ $login is not signed in to gh ($SOURCE/hosts.yml): gh auth login first" >&2; exit 1; }
  mkdir -p "$dir/gh"
  chmod 700 "$dir" "$dir/gh"
  if [ -f "$SOURCE/config.yml" ] && [ ! -f "$dir/gh/config.yml" ]; then
    (umask 077; cp "$SOURCE/config.yml" "$dir/gh/config.yml")
  fi
  write_atomic "$dir/gh/hosts.yml" "github.com:
    git_protocol: https
    users:
        $login:
    user: $login"
  write_atomic "$dir/gitconfig" "[user]
	name = $login
	email = $id+$login@users.noreply.github.com
[credential \"https://github.com\"]
	helper =
	helper = !$GH auth git-credential"
  local found
  found="$(env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN -u GH_HOST \
    GH_CONFIG_DIR="$dir/gh" GH_PROMPT_DISABLED=1 "$GH" api user --jq .login)" \
    || { echo "✗ gh could not answer in $dir/gh" >&2; exit 1; }
  [ "$found" = "$login" ] || { echo "✗ gh in $dir/gh answers as $found, not $login" >&2; exit 1; }
  echo "✓ $dir answers as $login"
}

make_env ply-test-owner "$PLY_WALK_OWNER_LOGIN" "$PLY_WALK_OWNER_ID"
make_env ply-test-member "$PLY_WALK_MEMBER_LOGIN" "$PLY_WALK_MEMBER_ID"
