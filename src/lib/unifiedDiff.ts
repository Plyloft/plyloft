/**
 * A minimal unified-diff reader for the `codex-chat` tile.
 *
 * `turn/diff/updated` hands over the whole turn's aggregated diff as one
 * string. Rendering it needs two things: which files it touches (for the bar
 * above the composer) and how to colour each line. CodeMirror's MergeView —
 * what `RunChangesPanel` uses — wants before/after text instead, which the
 * protocol never sends, so this reads the patch directly.
 *
 * Deliberately not a patch *applier*: nothing here reconstructs file content,
 * so a malformed hunk degrades to plainly-rendered lines instead of a wrong
 * answer.
 */

export type DiffLineKind = "add" | "del" | "context" | "hunk" | "meta";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
};

export type DiffFile = {
  /** Display path: the "b/" side when present, else the "a/" side. */
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
};

function stripPrefix(raw: string): string {
  const path = raw.trim();
  if (path === "/dev/null") return path;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

/** The paths on a `diff --git a/x b/y` line, when it has two. */
function pathsFromGitHeader(line: string): [string, string] | null {
  const rest = line.slice("diff --git ".length).trim();
  const halves = rest.split(" b/");
  if (halves.length !== 2) return null;
  return [stripPrefix(halves[0]), stripPrefix(`b/${halves[1]}`)];
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  if (!diff.trim()) return [];
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;

  // Returns the file so the assignment happens in the loop body: TypeScript
  // does not track assignments made inside a closure, and narrowing `current`
  // afterwards would collapse it to `never`.
  const openFile = (path: string): DiffFile => {
    const file: DiffFile = { path, added: 0, removed: 0, lines: [] };
    files.push(file);
    return file;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const paths = pathsFromGitHeader(line);
      current = openFile(paths ? paths[1] : "(unknown)");
      continue;
    }
    if (line.startsWith("--- ")) {
      // A bare `---`/`+++` pair without a `diff --git` header still opens a
      // file: Codex is not required to emit git-style headers.
      if (!current) current = openFile(stripPrefix(line.slice(4)));
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = stripPrefix(line.slice(4));
      if (current && (current.path === "(unknown)" || current.lines.length === 0)) {
        if (path !== "/dev/null") current.path = path;
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      current.lines.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      current.added += 1;
      current.lines.push({ kind: "add", text: line });
      continue;
    }
    if (line.startsWith("-")) {
      current.removed += 1;
      current.lines.push({ kind: "del", text: line });
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("rename ") ||
      line.startsWith("similarity ") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode")
    ) {
      current.lines.push({ kind: "meta", text: line });
      continue;
    }
    current.lines.push({ kind: "context", text: line });
  }

  return files;
}

/** "3 files changed", "1 file changed" — the label on the bar. */
export function describeDiff(files: DiffFile[]): string {
  if (files.length === 0) return "No file changes yet";
  return `${files.length} file${files.length === 1 ? "" : "s"} changed`;
}
