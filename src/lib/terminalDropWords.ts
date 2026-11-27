// D4 (1.172.2): what a terminal tile says about a file dragged over it, and
// while a dropped file is on its way. The owner dropped a screenshot several
// times because nothing showed between the drop and the path in the prompt.

/** The terminals a file can be dropped on (a structured Codex tile takes no
 *  drops; `Terminal` gets its kind through the `readiness` prop). */
export type DropTerminalKind = "claude" | "codex" | "shell";

/** The label over a terminal while a file drag that it will take is over it. */
export function dropHintWords(kind: DropTerminalKind | undefined, count: number): string {
  const many = count > 1;
  if (kind === "claude") return many ? "Drop to give Claude these files" : "Drop to give Claude this file";
  if (kind === "codex") return many ? "Drop to give Codex these files" : "Drop to give Codex this file";
  return many ? "Drop to type these files' paths" : "Drop to type this file's path";
}

/** 1.174.0 E6 (P23): a Codex chat tile takes no files. What it says while a
 *  file is dragged over it, and once if one is released there anyway —
 *  where the file can go instead, never the shell's generic words. */
export function codexChatRefusalWords(count: number): string {
  return count > 1
    ? "Codex chat can't take files. Drop them on a Claude or Codex terminal, or on a card."
    : "Codex chat can't take files. Drop it on a Claude or Codex terminal, or on a card.";
}

/** The zones that refuse every drop with words of their own
 *  (`data-drop-refusal`). */
export type DropRefusalKind = "codex-chat";

export function dropRefusalWords(kind: DropRefusalKind, count: number): string {
  switch (kind) {
    case "codex-chat":
      return codexChatRefusalWords(count);
  }
}

/** The line at the tile's bottom from the drop until the path is typed. */
export function addingWords(names: readonly string[]): string {
  if (names.length === 1) return `Adding ${names[0]}…`;
  return `Adding ${names.length} files…`;
}

/** How many files a drag carries, as far as the web view says before the
 *  drop: `items` lists them during the drag, `files` often only at the drop.
 *  Unknown (an internal path, an empty list) counts as one. */
export function dragFileCount(
  dataTransfer: {
    items?: ArrayLike<{ kind: string }> | null;
    files?: ArrayLike<unknown> | null;
  } | null,
): number {
  if (!dataTransfer) return 1;
  let files = 0;
  const items = dataTransfer.items;
  if (items) {
    for (let i = 0; i < items.length; i++) if (items[i]?.kind === "file") files += 1;
  }
  if (files === 0) files = dataTransfer.files?.length ?? 0;
  return Math.max(1, files);
}
