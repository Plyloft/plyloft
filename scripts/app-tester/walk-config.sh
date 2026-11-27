# Walk tooling configuration (docs/app-tester/DESIGN.md, "Walk configuration").
# Sourced, never run, by the app-tester scripts that sit in its own directory
# (and by the installed MCP wrapper, beside which build-mcp.sh copies it):
#
#   . "$(dirname "$0")/walk-config.sh"
#   walk_config_require PLY_WALK_OWNER_LOGIN PLY_WALK_OWNER_ID
#
# It reads the walk's accounts and ids from ONE file, $PLY_WALK_ENV or else
# walk.env beside the sourcing script (git-ignored, never exported; copy
# walk.env.example and fill it in). A variable already set and not empty in
# the environment wins over the file. The file holds plain KEY=value lines
# (a value may be wrapped in "…" or '…'; no shell expansion, since
# team-walk/*.mjs read the same file through walk-config.mjs), "#" comments
# and blank lines; a key it doesn't know is refused, so a typo can't pass for
# a missing value. Every known variable that ends up set is exported.
# POSIX sh: the wrapper runs under /bin/sh, the other scripts under bash.

PLY_WALK_VARS="PLY_WALK_OWNER_LOGIN PLY_WALK_OWNER_ID PLY_WALK_MEMBER_LOGIN PLY_WALK_MEMBER_ID PLY_WALK_SANDBOX_REPO PLY_WALK_TEAM_REPO PLY_WALK_DEV_GITHUB_CLIENT_ID PLY_TEST_VM"
PLY_WALK_EXAMPLE="scripts/app-tester/walk.env.example"
PLY_WALK_ENV_FILE="${PLY_WALK_ENV:-$(dirname "$0")/walk.env}"

walk_config_load() { # [file]
  _wc_file="${1:-$PLY_WALK_ENV_FILE}"
  [ -f "$_wc_file" ] || return 0
  while IFS= read -r _wc_line || [ -n "$_wc_line" ]; do
    _wc_trim="$(printf '%s' "$_wc_line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    case "$_wc_trim" in '' | '#'*) continue ;; esac
    _wc_trim="${_wc_trim#export }"
    case "$_wc_trim" in *=*) ;; *) echo "✗ $_wc_file: not a KEY=value line: $_wc_trim" >&2; exit 2 ;; esac
    _wc_key="${_wc_trim%%=*}"
    _wc_val="${_wc_trim#*=}"
    case " $PLY_WALK_VARS " in
      *" $_wc_key "*) ;;
      *) echo "✗ $_wc_file: unknown variable $_wc_key (the known ones are in $PLY_WALK_EXAMPLE)" >&2; exit 2 ;;
    esac
    case "$_wc_val" in
      \"*\") _wc_val="${_wc_val#\"}"; _wc_val="${_wc_val%\"}" ;;
      \'*\') _wc_val="${_wc_val#\'}"; _wc_val="${_wc_val%\'}" ;;
    esac
    eval "_wc_cur=\${$_wc_key:-}"
    [ -n "$_wc_cur" ] || eval "$_wc_key=\$_wc_val"
  done <"$_wc_file"
  for _wc_key in $PLY_WALK_VARS; do
    eval "_wc_cur=\${$_wc_key:-}"
    [ -z "$_wc_cur" ] || export "$_wc_key"
  done
}

walk_config_require() { # <VAR>...: exits 2 with one line at the first one missing
  for _wc_key in "$@"; do
    eval "_wc_cur=\${$_wc_key:-}"
    if [ -z "$_wc_cur" ]; then
      echo "✗ $_wc_key is not set: put it in $PLY_WALK_ENV_FILE (copy $PLY_WALK_EXAMPLE) or export it" >&2
      exit 2
    fi
  done
}

walk_config_load
