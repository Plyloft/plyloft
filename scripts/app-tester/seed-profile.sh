#!/usr/bin/env bash
# SL-0 app tester (docs/app-tester/DESIGN.md): adds a project to the *test*
# profile of "Plyloft Test" (com.mbadv.ply.test) without the Open panel, so a
# walk can start on a prepared sandbox repo. Run by the app-walk skill before
# app_launch; never touches the installed Plyloft's profile.
#
#   scripts/app-tester/seed-profile.sh [--member] <project-dir> [name]
#
# --member (anywhere on the line) seeds the second person of a team walk
# (com.mbadv.ply.test2, the profile of "Plyloft Test Member") instead. A project
# directory already seeded in the other profile is refused: two people must
# not share a checkout. A member's project must have an HTTPS origin, or none:
# over SSH, git would answer with this Mac's key, not the member's gh.
#
# The project becomes the active workspace. Written atomically (temp +
# rename); refused while either instance runs, because the app owns the file
# then.
#
# N14 walk F9: this writes workspaces.json only, so the project has no build
# settings yet — unlike a folder added in the app (Setup, or the sidebar `+`,
# which reads the repository and saves them). Its first Start build says
# "this repository isn't set up yet"; press Set up › Re-detect, or plan that
# step in the walk.
set -euo pipefail
TEST_ID="com.mbadv.ply.test"
OTHER_ID="com.mbadv.ply.test2"
positional=()
for arg in "$@"; do
  case "$arg" in
    --member) TEST_ID="com.mbadv.ply.test2"; OTHER_ID="com.mbadv.ply.test" ;;
    -*) echo "✗ unknown option $arg (usage: seed-profile.sh [--member] <project-dir> [name])" >&2; exit 1 ;;
    *) positional+=("$arg") ;;
  esac
done
set -- ${positional[@]+"${positional[@]}"}
PROFILE="$HOME/Library/Application Support/$TEST_ID"
dir="${1:?usage: seed-profile.sh [--member] <project-dir> [name]}"
dir="$(cd "$dir" && pwd -P)"
name="${2:-$(basename "$dir")}"

if pgrep -f "Plyloft Test( Member)?\.app/Contents/MacOS/" >/dev/null; then
  echo "✗ Plyloft Test (or its Member copy) is running: quit it first (app_quit)" >&2
  exit 1
fi
case "$PROFILE" in */com.mbadv.ply.test | */com.mbadv.ply.test2) ;; *) echo "✗ not the test profile: $PROFILE" >&2; exit 1 ;; esac
if [ "$TEST_ID" = "com.mbadv.ply.test2" ]; then
  origin="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    "" | https://*) ;;
    *) echo "✗ refused: the member's project needs an HTTPS origin, not $origin" >&2; exit 1 ;;
  esac
fi
mkdir -p "$PROFILE"

node - "$PROFILE/workspaces.json" "$dir" "$name" "$(dirname "$PROFILE")/$OTHER_ID/workspaces.json" <<'JS'
const fs = require("fs");
const crypto = require("crypto");
const [file, cwd, name, other] = process.argv.slice(2);
if (fs.existsSync(other)) {
  const seeded = JSON.parse(fs.readFileSync(other, "utf8")).workspaces || [];
  if (seeded.some((w) => w.cwd === cwd)) {
    console.error(`✗ refused: ${cwd} is already a project of the other instance (${other})`);
    process.exit(1);
  }
}
let data = { workspaces: [], activeWorkspaceId: null };
if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8"));
data.workspaces = data.workspaces || [];
let ws = data.workspaces.find((w) => w.cwd === cwd);
const now = Date.now();
if (!ws) {
  ws = { id: crypto.randomUUID(), name, cwd, createdAt: now, lastOpenedAt: now, openFiles: [], activeFile: null };
  data.workspaces.push(ws);
}
ws.lastOpenedAt = now;
data.activeWorkspaceId = ws.id;
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
fs.renameSync(tmp, file);
console.log(JSON.stringify({ workspace: ws.id, name: ws.name, cwd }));
JS
