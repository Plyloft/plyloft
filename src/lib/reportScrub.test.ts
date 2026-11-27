// 1.176.1: what every pasted report is scrubbed with.
// Run: node --experimental-strip-types src/lib/reportScrub.test.ts
import assert from "node:assert/strict";
import { scrubReport } from "./reportScrub.ts";

// A Mac home: the folder is ~, the name goes wherever it appears.
assert.equal(scrubReport("claude: /Users/matteo/.local/bin/claude"), "claude: ~/.local/bin/claude");
assert.equal(scrubReport("Hello matteo, /Users/matteo/x and /Users/matteo"), "Hello matteo, ~/x and ~");
// The name is replaced as a path component only, never as a free word.
assert.equal(scrubReport("/var/matteo/cache"), "/var/matteo/cache");
assert.equal(scrubReport("/Users/Shared/tools"), "/Users/Shared/tools");
assert.equal(scrubReport("/home/ana/bin:/usr/bin"), "~/bin:/usr/bin");

// A Windows home, either slash, doubled backslashes, any case.
assert.equal(scrubReport("C:\\Users\\Matteo\\AppData\\Local\\bin"), "~\\AppData\\Local\\bin");
assert.equal(scrubReport("c:/users/Matteo/bin"), "~/bin");
assert.equal(scrubReport("C:\\\\Users\\\\Matteo\\\\bin"), "~\\\\bin");
assert.equal(scrubReport("C:\\Users\\Matteo\\x; owner Matteo"), "~\\x; owner Matteo");

// A one-letter name: the path loses it, ordinary words keep every "a".
assert.equal(scrubReport("/Users/a/bin and a bag of apples, /var/a/x"), "~/bin and a bag of apples, /var/<user>/x");
assert.equal(scrubReport("C:\\Users\\a\\bin"), "~\\bin");

// Credentials in an address.
assert.equal(scrubReport("origin https://user:pass@github.com/me/repo.git"), "origin https://github.com/me/repo.git");
assert.equal(scrubReport("ssh://bob@example.com/x"), "ssh://example.com/x");
assert.equal(scrubReport("git@github.com:me/repo.git"), "git@github.com:me/repo.git");

// Tokens.
const gh = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
assert.equal(scrubReport(`token ${gh} ok`), "token <token> ok");
assert.ok(!scrubReport(`signed in with ${gh}`).includes("ghp_"));
assert.equal(scrubReport("key sk-ant-api03-abcdefghijklmnop1234 end"), "key <token> end");
assert.equal(scrubReport("github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuv"), "<token>");
assert.equal(scrubReport("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123"), "Authorization: Bearer <token>");
assert.equal(scrubReport("password=hunter2 next"), "password=<removed> next");

// Emails and the Mac's name.
assert.equal(scrubReport("Git knows you as Ana <ana@example.com>."), "Git knows you as Ana <<email>>.");
assert.equal(scrubReport("on matteos-macbook.local now"), "on <host> now");

// Nothing to scrub: unchanged.
assert.equal(scrubReport("Git 2.46 · Ready.\nclaude 2.1 (found at /opt/homebrew/bin/claude)"), "Git 2.46 · Ready.\nclaude 2.1 (found at /opt/homebrew/bin/claude)");

// Windows homes in other forms: Git Bash, WSL, the long form.
assert.equal(scrubReport("/c/Users/Matteo/bin/claude"), "~/bin/claude");
assert.equal(scrubReport("/mnt/c/Users/Matteo/bin"), "~/bin");
assert.equal(scrubReport("C:/Users/Matteo/bin"), "~/bin");
assert.equal(scrubReport("\\\\?\\C:\\Users\\Matteo\\bin"), "~\\bin");
assert.equal(scrubReport("//?/C:/Users/Matteo/bin"), "~/bin");
assert.equal(scrubReport("/c/Users/Public/x"), "/c/Users/Public/x");

// A JWT-looking string (three base64url parts).
assert.equal(
  scrubReport("session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r end"),
  "session <token> end",
);

// A short user name is never replaced as a word.
assert.equal(scrubReport("/Users/mb/bin: 120 MB used, mb"), "~/bin: 120 MB used, mb");
assert.equal(scrubReport("C:\\Users\\dev\\x: npm run dev"), "~\\x: npm run dev");
assert.equal(scrubReport("/Users/dev/a, /srv/dev/b"), "~/a, /srv/<user>/b");

console.log("reportScrub: ok");
