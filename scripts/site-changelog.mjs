#!/usr/bin/env node
// W5 (launch plan; owner decision 2026-10-02): a DRAFT entry for the site's
// changelog, written from the top entry of docs/STATUS.md into the site's
// src/data/releases.ts. release.sh runs it after publishing and leaves the
// change uncommitted in the site repository: the owner reviews and rewrites
// it there before committing. The site's notes are plain words without card
// numbers; this draft only gets them started.
//
//   node scripts/site-changelog.mjs --status <STATUS.md> --releases <releases.ts> \
//     --version 1.158.0 [--date 2026-10-30]
//
// Exit 0: written, or the version is already there (nothing changed).
// Exit 1: nothing written (the reason on stderr). Tests: site-changelog.test.mjs.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The site's areas (src/data/releases.ts `Area`), in its order, with the
 *  words that suggest each. A guess for the owner to correct. */
export const AREA_HINTS = [
  ["Review", /\b(review|challenger|findings?)\b/i],
  ["Skills", /\bskills?\b/i],
  ["Board", /\b(board|cards?|inbox)\b/i],
  ["Ship", /\b(ship|pull requests?|merge)\b/i],
  ["Windows", /\bwindows\b/i],
  ["Team", /\b(teams?|seats?|members?)\b/i],
  ["Setup", /\b(setup|sign[- ]in|sign in)\b/i],
  ["Fixes", /\bfix(es|ed)?\b/i],
];

/** The first `## vX.Y.Z — headline` entry of STATUS.md: its version, its
 *  headline, and its top-level bullets. The bullets are the ones in the
 *  "**What…**" part when there is one (up to the next bold paragraph lead
 *  such as "**Limits.**"), otherwise every top-level bullet of the entry.
 *  Returns null when STATUS.md has no version entry. */
export function topEntry(statusMd) {
  const lines = statusMd.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## v\d+\.\d+\.\d+\b/.test(l));
  if (start < 0) return null;
  const head = lines[start].match(/^## v(\d+\.\d+\.\d+)\s*(?:[—–-]\s*(.*))?$/);
  if (!head) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);

  const whatAt = body.findIndex((l) => /^\*\*What\b/.test(l));
  let part = body;
  if (whatAt >= 0) {
    const stop = body.findIndex((l, i) => i > whatAt && /^\*\*[^*]+\*\*/.test(l));
    part = body.slice(whatAt + 1, stop < 0 ? body.length : stop);
  }

  // Top-level bullets with their continuation lines. Nested bullets (and
  // their own continuation lines) are left out on purpose; a blank line or
  // a new paragraph ends the bullet being continued.
  const bullets = [];
  let open = false;
  let nested = false;
  for (const line of part) {
    if (/^- /.test(line)) {
      bullets.push(line.slice(2).trim());
      open = true;
      nested = false;
    } else if (open && /^\s+- /.test(line)) {
      nested = true;
    } else if (open && !nested && /^\s+\S/.test(line)) {
      bullets[bullets.length - 1] += " " + line.trim();
    } else if (!line.trim() || /^\S/.test(line)) {
      open = false;
    }
  }
  return {
    version: head[1],
    headline: (head[2] ?? "").trim(),
    bullets,
  };
}

/** A parenthesis that holds only card numbers: "(A1, A2)", "(G1–G3)",
 *  "(SP-7)", "(GH #216)", "(N14 1–9)", "(F1–F15)". */
const CARD_REF = /^(GH #\d+|N\d+ [\d–-]+|[A-Z]{1,3}-?\d+(?:[–-][A-Z]{0,3}-?\d+)?)$/;
function isCardRefs(inner) {
  return inner.split(/,\s*|\s+and\s+/).every((part) => CARD_REF.test(part.trim()));
}

/** Markdown and card numbers out; one line. */
export function plainText(md) {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^\w*])\*([^*]+)\*(?!\w)/g, "$1$2")
    .replace(/\s*\(([^()]*)\)/g, (whole, inner) => (isCardRefs(inner) ? "" : whole))
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/** The first sentence of a text (up to ". " followed by a capital, or the end). */
export function firstSentence(text) {
  const m = text.match(/^(.+?[.!?])\s+(?=[A-Z"“])/);
  return (m ? m[1] : text).trim();
}

/** One note per bullet: a leading "*Label.*" becomes "Label: " followed by
 *  the first sentence after it; otherwise the bullet's first sentence. */
export function noteOf(bullet) {
  const label = bullet.match(/^\*([^*]+?)\.?\*\s*(.*)$/);
  if (label) {
    const name = plainText(label[1]).replace(/[.:]$/, "");
    const rest = firstSentence(plainText(label[2]));
    return rest ? `${name}: ${rest}` : `${name}.`;
  }
  return firstSentence(plainText(bullet));
}

/** The site's short title: the headline up to its first colon, capitalised. */
export function titleOf(headline) {
  const short = plainText(headline).split(":")[0].trim();
  return short ? short[0].toUpperCase() + short.slice(1) : "";
}

export function areasOf(text) {
  const found = AREA_HINTS.filter(([, re]) => re.test(text)).map(([area]) => area);
  return found.length ? found : ["Fixes"];
}

/** A single-quoted TypeScript string. */
export function tsString(s) {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/** The release as releases.ts writes it (tabs, like the file). */
export function releaseSource({ version, date, title, areas, notes }) {
  return [
    "\t{",
    `\t\tv: ${tsString(version)}, date: ${tsString(date)}, title: ${tsString(title)},`,
    `\t\tareas: [${areas.map(tsString).join(", ")}],`,
    "\t\tnotes: [",
    ...notes.map((n) => `\t\t\t${tsString(n)},`),
    "\t\t],",
    "\t},",
    "",
  ].join("\n");
}

/** releases.ts with the release first in RELEASES and SINCE.count one up.
 *  `{ text, changed: false, reason }` when the version is already there or
 *  the file isn't the shape this script knows. */
export function insertRelease(releasesTs, release) {
  if (new RegExp(`\\bv:\\s*'${release.version.replace(/\./g, "\\.")}'`).test(releasesTs)) {
    return { text: releasesTs, changed: false, reason: `${release.version} is already in the site's changelog` };
  }
  const open = releasesTs.match(/export const RELEASES: Release\[\] = \[\r?\n/);
  if (!open) {
    return { text: releasesTs, changed: false, reason: "no `export const RELEASES: Release[] = [` line in releases.ts" };
  }
  const at = open.index + open[0].length;
  let text = releasesTs.slice(0, at) + releaseSource(release) + releasesTs.slice(at);
  let sinceBumped = false;
  text = text.replace(/(export const SINCE = \{ count: )(\d+)/, (_, lead, n) => {
    sinceBumped = true;
    return lead + String(Number(n) + 1);
  });
  return { text, changed: true, sinceBumped };
}

/** STATUS.md's top entry → the site's draft release, or an error string. */
export function draftRelease(statusMd, version, date) {
  const entry = topEntry(statusMd);
  if (!entry) return { error: "STATUS.md has no `## vX.Y.Z` entry" };
  if (entry.version !== version) {
    return { error: `STATUS.md's top entry is v${entry.version}, not v${version}: write its entry first` };
  }
  if (!entry.bullets.length) return { error: `STATUS.md's v${version} entry has no bullets` };
  const notes = entry.bullets.map(noteOf).filter(Boolean);
  return {
    release: {
      version,
      date,
      title: titleOf(entry.headline) || `Plyloft ${version}`,
      areas: areasOf([entry.headline, ...notes].join(" ")),
      notes,
    },
  };
}

function arg(argv, name) {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function main(argv, today = new Date().toISOString().slice(0, 10)) {
  const status = arg(argv, "status");
  const releases = arg(argv, "releases");
  const version = arg(argv, "version");
  const date = arg(argv, "date") ?? today;
  if (!status || !releases || !version) {
    console.error("usage: site-changelog.mjs --status <STATUS.md> --releases <releases.ts> --version X.Y.Z [--date YYYY-MM-DD]");
    return 2;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`site changelog: --date ${date} is not YYYY-MM-DD`);
    return 1;
  }
  let statusMd, releasesTs;
  try {
    statusMd = readFileSync(status, "utf8");
    releasesTs = readFileSync(releases, "utf8");
  } catch (e) {
    console.error(`site changelog: ${e.message}`);
    return 1;
  }
  const draft = draftRelease(statusMd, version, date);
  if (draft.error) {
    console.error(`site changelog: ${draft.error}`);
    return 1;
  }
  const out = insertRelease(releasesTs, draft.release);
  if (!out.changed) {
    if (out.reason.includes("already")) {
      console.log(`site changelog: ${out.reason}; nothing written`);
      return 0;
    }
    console.error(`site changelog: ${out.reason}`);
    return 1;
  }
  writeFileSync(releases, out.text);
  console.log(
    `site changelog: draft for ${version} written to ${releases} (${draft.release.notes.length} notes` +
      (out.sinceBumped ? ", SINCE.count +1" : ", SINCE.count not found") +
      ")",
  );
  return 0;
}

// Run as a script (through a symlinked path too, such as macOS's /var → /private/var).
function invokedDirectly() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  process.exit(main(process.argv.slice(2)));
}
