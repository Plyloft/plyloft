// 1.176.1: the one scrub for every plain-text report a person pastes when
// asking for help (Diagnostics' Copy report). The Rust side scrubs its own
// report (`cli_repair_report::scrub`); text composed here is run through
// this, with the same promises: the home folder is `~`, the user name and the
// Mac's name are gone, and no secret survives. Pure (node runs it:
// `src/lib/reportScrub.test.ts`).

/** Folders under `Users`/`home` that belong to nobody. */
const SHARED = new Set(["shared", "public", "default", "guest"]);

const HOME_UNIX = /(^|[^A-Za-z0-9_])\/(Users|home)\/([^/\\\s:"'`)<>|]+)/g;
// `C:\Users\x`, `C:/Users/x`, the long form `\\?\C:\Users\x`, and Git Bash's
// `/c/Users/x` and WSL's `/mnt/c/Users/x`.
const HOME_WIN = /(^|[^A-Za-z0-9_])(?:(?:\\\\\?\\|\/\/\?\/)?[A-Za-z]:|(?:\/mnt)?\/[A-Za-z])(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)([^/\\\s:"'`)<>|]+)/gi;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `text` with the home as `~`, the user and host names as `<user>` and
 *  `<host>`, and credentials and tokens removed. */
export function scrubReport(text: string): string {
  let out = text;

  // Credentials inside an address: scheme://user:pass@host -> scheme://host.
  out = out.replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, "$1");
  // Tokens.
  out = out
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<token>")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "<token>")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "<token>")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "<token>")
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "<token>")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<token>")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 <token>")
    .replace(/\b(token|password|passwd|secret|api[_-]?key)(\s*[=:]\s*)[^\s"',;&]+/gi, "$1$2<removed>");
  // Email addresses (an ssh remote's `git@` is not one).
  out = out.replace(/\b(?!git@)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, "<email>");

  // The home folder, learning the user's name from it.
  const users = new Set<string>();
  out = out.replace(HOME_WIN, (all, before: string, name: string) => {
    if (SHARED.has(name.toLowerCase())) return all;
    users.add(name);
    return `${before}~`;
  });

  out = out.replace(HOME_UNIX, (all, before: string, _root: string, name: string) => {
    if (SHARED.has(name.toLowerCase())) return all;
    users.add(name);
    return `${before}~`;
  });
  // The Mac's own name.
  out = out.replace(/\b[A-Za-z0-9][A-Za-z0-9-]*\.local\b/g, "<host>");

  // The name where it is a path component (`/var/x/<name>/`, `\\<name>\\`),
  // never as a free word: a short name ("mb", "dev") would eat "120 MB" and
  // "npm run dev".
  for (const name of users) {
    out = out.replace(new RegExp(`([/\\\\])${escapeRe(name)}(?=[/\\\\]|$|[\\s)"'])`, "gi"), "$1<user>");
  }
  return out;
}
