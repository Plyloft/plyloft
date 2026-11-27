// GH #326: the layouts are named in words — no "sh", "Claude" capitalised,
// no "+" or "×" drawn as text — and each description says what opens.
import assert from "node:assert/strict";

import { WORKSPACE_TEMPLATES, countClaudeTiles } from "./workspaceTemplates.ts";

for (const t of WORKSPACE_TEMPLATES) {
  for (const text of [t.label, t.description ?? ""]) {
    assert.doesNotMatch(text, /\bsh\b/, `${t.id}: ${text}`);
    assert.doesNotMatch(text, /\bclaude\b/, `${t.id}: "Claude" is a name: ${text}`);
    assert.doesNotMatch(text, /[+×]/, `${t.id}: ${text}`);
    assert.doesNotMatch(text, /\b(pane|tile)s?\b/i, `${t.id}: sessions, not panes or tiles: ${text}`);
  }
  assert.ok(t.description, `${t.id} is described`);
  // The name says what opens.
  const claude = countClaudeTiles(t);
  const shells = t.tiles.length - claude;
  if (claude > 0) assert.match(t.label, new RegExp(`${claude} Claude session`), t.label);
  if (shells > 0) assert.match(t.label, new RegExp(`${shells} shells?`), t.label);
}

console.log("workspaceTemplates: all assertions passed");
