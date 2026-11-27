#!/usr/bin/env node
// D26 (docs/tutorial/DECISIONS.md, TUTORIAL_SPEC §12.3): the user guide is
// published on the site at every release. Its source stays
// docs/onboarding/USER_GUIDE.md; the site's copy is one Starlight page,
// SITE_GUIDE_PATH in the site repository (plyloft.com/docs/guide/), made from
// the guide by `siteGuide` below and never edited by hand. release.sh runs
// `--check` before it builds and refuses a release whose guide differs from
// the site's copy (docs/RELEASING.md, "The user guide on the site").
//
//   node scripts/site-guide.mjs --write [--guide <USER_GUIDE.md>] --out <file>
//   node scripts/site-guide.mjs --check [--guide <USER_GUIDE.md>] --out <file>
//
// --guide defaults to this repository's docs/onboarding/USER_GUIDE.md.
// Exit 0: written, or (--check) the copy matches. Exit 1: the copy is missing
// or differs (--check). Exit 2: wrong arguments. Exit 3: the guide can't be
// read or made into a page (no `# ` title); the reason on stderr.
// Tests: site-guide.test.mjs.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where the copy lives in the site repository. */
export const SITE_GUIDE_PATH = "src/content/docs/docs/guide.md";

export const SITE_GUIDE_DESCRIPTION =
  "From nothing to your first shipped card, on a Mac or a Windows PC: setup, your first card, the Getting started tour, and where to change things later.";

/**
 * The site's page for a guide: Starlight frontmatter (the guide's `# ` title,
 * which Starlight draws as the page's heading, and a fixed description), then
 * the guide without that title and without its HTML comments (the
 * `<!-- tour:… -->` markers and review notes). A comment alone on its line
 * becomes a blank line: the items a marker splits stay one (loose) list,
 * and an indented paragraph after a marker stays its own paragraph inside
 * the item above.
 * Deterministic: the same guide always gives the same bytes.
 */
export function siteGuide(guideMd) {
  const lines = guideMd.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((l) => /^# \S/.test(l));
  if (at < 0) throw new Error("the guide has no '# ' title");
  const title = lines[at].slice(2).trim();
  const body = lines
    .slice(at + 1)
    .map((l) => (/^\s*<!--.*-->\s*$/.test(l) ? "" : l.replace(/\s*<!--.*?-->/g, "").replace(/\s+$/, "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n*$/, "\n");
  // A comment over several lines would reach the site's page as text.
  if (body.includes("<!--")) throw new Error("the guide has an HTML comment over several lines; keep each on one line");
  return [
    "---",
    "# Generated from docs/onboarding/USER_GUIDE.md in the app's repository by",
    "# scripts/site-guide.mjs at each release. Edit the guide there, not this file.",
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(SITE_GUIDE_DESCRIPTION)}`,
    "---",
    "",
    body,
  ].join("\n");
}

function parseArgs(argv) {
  const out = { mode: null, guide: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write" || a === "--check") {
      if (out.mode) return null;
      out.mode = a.slice(2);
    } else if (a === "--guide" || a === "--out") {
      const v = argv[++i];
      if (!v) return null;
      out[a.slice(2)] = v;
    } else return null;
  }
  return out.mode && out.out ? out : null;
}

export function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    console.error("Usage: node scripts/site-guide.mjs --write|--check [--guide <USER_GUIDE.md>] --out <file>");
    return 2;
  }
  const guidePath =
    args.guide ?? join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "onboarding", "USER_GUIDE.md");
  let want;
  try {
    want = siteGuide(readFileSync(guidePath, "utf8"));
  } catch (e) {
    console.error(`The user guide can't be read (${guidePath}): ${e.message}`);
    return 3;
  }
  if (args.mode === "write") {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, want);
    console.log(`Wrote the site's copy of the user guide: ${args.out}`);
    return 0;
  }
  if (!existsSync(args.out)) {
    console.error(`The site has no copy of the user guide yet: ${args.out}`);
    return 1;
  }
  if (readFileSync(args.out, "utf8") !== want) {
    console.error(`The site's copy of the user guide is not this guide: ${args.out}`);
    return 1;
  }
  console.log(`The site's copy of the user guide matches: ${args.out}`);
  return 0;
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
