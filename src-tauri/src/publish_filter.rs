//! 1.175.0 (lane d, X2; owner 2026-11-09): what an AI wrote, before Plyloft
//! posts it on GitHub.
//!
//! The Codex Reviewer runs in a sandbox that limits writing and the network,
//! not reading, and its notes go into the pull request comment at every
//! Ship; the Builder writes the pull request's title and description. A live
//! proof (`P4`, SEC-9) did not get a secret into the notes in one run, and
//! the owner asked for a light filter all the same: **what is posted** loses
//! what has the shape of a secret; **what the card keeps is whole**.
//!
//! Light means by shape, never by meaning. It is not a guarantee: a secret
//! with no recognisable shape — a password in a sentence, a connection
//! string, a key split over two lines — goes through. And it is conservative
//! the other way too: ordinary code a review quotes must survive, or the
//! comment is useless. `const API_KEY = process.env.API_KEY` is code;
//! `API_KEY=sk_live_…` is a secret.
//!
//! What goes:
//! - **Private key blocks**, from `-----BEGIN … PRIVATE KEY-----` to their
//!   `-----END … PRIVATE KEY-----`, or to the end of the text when the block
//!   isn't closed.
//! - **Token shapes**: GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
//!   `github_pat_`), OpenAI and Anthropic (`sk-…`, `sk-proj-…`, `sk-ant-…`),
//!   Stripe (`sk_live_`, `sk_test_`, `rk_live_`, `rk_test_`, `whsec_`), AWS
//!   access key ids (`AKIA`/`ASIA` and sixteen more), Slack (`xox[baprs]-`),
//!   Google API keys (`AIza` and thirty-five more), JSON Web Tokens (three
//!   dotted parts, the first two starting `eyJ`), and the token after
//!   `Bearer `.
//! - **The value of `NAME=value`** where `NAME` is written like an
//!   environment variable and names a secret (`…_KEY`, `…_TOKEN`,
//!   `…_SECRET`, `PASSWORD`, …) and the value is long and token-like.
//!
//! Each becomes [`REMOVED`], and is counted ([`removed_line`]).
//!
//! What is rewritten, and not counted — nothing is removed ([`Places`]):
//! - **The reviewed project.** A path under the card's copy, or under the
//!   Reviewer's own read-only tree of it, is shown relative to the project
//!   (`src/app.js`).
//! - **The member's home folder**, as an exact prefix, in every spelling a
//!   tool prints it (`C:\Users\Mario Rossi`, `C:/…`, `c:\users\…`,
//!   `\\?\C:\…`, Git Bash's `/c/Users/…`, WSL's `/mnt/c/Users/…`): `~`.
//! - **Any other home folder** (`/Users/<name>/…`, `/home/<name>/…`,
//!   `C:\Users\<name>\…` and the spellings above, and one on a network
//!   share, `\\server\share\Users\<name>\…`): the name goes, the tail stays
//!   behind `~`.

use std::path::{Path, PathBuf};

/// What stands where something with the shape of a secret was.
pub const REMOVED: &str = "[removed by Plyloft]";

/// A text as it is posted, and how many things were removed from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    pub text: String,
    pub removed: usize,
}

/// The folders a posted text may name, handed in by the caller so the
/// filter itself reads nothing from the machine.
#[derive(Debug, Clone, Copy, Default)]
pub struct Places<'a> {
    /// The reviewed project: the card's copy. A path under it is shown
    /// relative to it.
    pub project: &'a [&'a Path],
    /// Plyloft's session roots (`<config>/claude-sessions`). A Reviewer
    /// reads a pinned tree of the project at `<root>/<kind>/worktrees/<id>`:
    /// a path under one is the project's too, and is shown the same way.
    pub session_roots: &'a [PathBuf],
    /// The member's own home folder.
    pub home: Option<&'a Path>,
}

/// `text` as Plyloft posts it on GitHub. A text with nothing to remove or
/// rewrite comes back byte for byte.
pub fn for_github(text: &str, places: &Places) -> Published {
    let mut removed = 0;
    let text = private_key_blocks(text, &mut removed);
    let text = token_shapes(&text, &mut removed);
    let text = secret_assignments(&text, &mut removed);
    let text = anonymous_paths(&text, places);
    Published { text, removed }
}

/// [`for_github`] on this computer: the card's copy as the project, with
/// the member's home folder and Plyloft's session roots as they are here.
/// The one impure line of the module; the callers that post use it.
pub fn for_github_here(text: &str, project: &[&Path]) -> Published {
    let home = crate::platform::home_dir();
    let session_roots = crate::claude_session::known_session_roots();
    for_github(text, &Places { project, session_roots: &session_roots, home: home.as_deref() })
}

/// What a count line is under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Posted {
    /// The Reviewer's notes, in the pull request comment. The card keeps
    /// them whole, and the line says so.
    Notes,
    /// The Builder's description of the pull request. Its draft is deleted
    /// once Ship took it and the card never stores it, so the line says
    /// only that something was removed.
    Description,
}

/// The line that says, under a text Plyloft posted, that something was
/// removed from it; `None` when nothing was. Modelled on the comment's own
/// "Plyloft: 3 files, reviewed in 2 passes." (To approve: `STRINGS.md`,
/// "Da approvare".)
pub fn removed_line(removed: usize, posted: Posted) -> Option<String> {
    let (what, kept) = match posted {
        Posted::Notes => ("these notes", " The card keeps the whole text."),
        Posted::Description => ("this description", ""),
    };
    match removed {
        0 => None,
        1 => Some(format!("Plyloft: 1 thing that looked like a secret was removed from {what} before posting.{kept}")),
        n => Some(format!("Plyloft: {n} things that looked like secrets were removed from {what} before posting.{kept}")),
    }
}

// ── Private key blocks ──────────────────────────────────────────────────

fn private_key_blocks(text: &str, removed: &mut usize) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((start, after_begin)) = key_boundary_line(rest, "-----BEGIN ") {
        out.push_str(&rest[..start]);
        out.push_str(REMOVED);
        *removed += 1;
        let body = &rest[after_begin..];
        match key_boundary_line(body, "-----END ") {
            Some((_, after_end)) => rest = &body[after_end..],
            // Not closed: everything after the header may be key material.
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// `<lead><LABEL>-----` where LABEL is capitals, digits and spaces and holds
/// "PRIVATE KEY" (`RSA PRIVATE KEY`, `OPENSSH PRIVATE KEY`, `PGP PRIVATE KEY
/// BLOCK`): where it starts, and where it ends.
fn key_boundary_line(text: &str, lead: &str) -> Option<(usize, usize)> {
    let mut from = 0;
    while let Some(at) = text[from..].find(lead) {
        let start = from + at;
        let label_start = start + lead.len();
        let label_len = text[label_start..].bytes().take(64).take_while(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b' ').count();
        let label = &text[label_start..label_start + label_len];
        let after = label_start + label_len;
        if label.contains("PRIVATE KEY") && text[after..].starts_with("-----") {
            return Some((start, after + 5));
        }
        from = label_start;
    }
    None
}

// ── Token shapes ────────────────────────────────────────────────────────

/// How many leading bytes of `s` satisfy `is`.
fn run(s: &str, is: impl Fn(u8) -> bool) -> usize {
    s.bytes().take_while(|b| is(*b)).count()
}

fn alnum(b: u8) -> bool {
    b.is_ascii_alphanumeric()
}

/// Letters, digits, `_` and `-`: base64url, and most vendors' key bodies.
fn key_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// A byte that can be part of a word a token might be the tail of.
fn word_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The run of [`key_char`] bytes a scan is in, read once: every shape that
/// starts inside it asks its end and where its last digit and capital are,
/// instead of walking it again. A megabyte of `sk-sk-sk-…` was a walk of the
/// rest of the run from each `sk-`: quadratic.
#[derive(Debug, Clone, Copy, Default)]
struct KeyRun {
    end: usize,
    last_digit: Option<usize>,
    last_upper: Option<usize>,
    /// Where the third word from the end starts: the run's parts between
    /// dashes that are three or more letters and nothing else.
    third_last_word: Option<usize>,
    /// When what follows the run is the rest of a JSON Web Token
    /// (`.eyJ<payload>.<signature>`): how long that rest is. Read once for
    /// the run (round 3): every `eyJ` that starts in the run has the same
    /// rest, and walking it from each was quadratic.
    jwt_rest: Option<usize>,
}

impl KeyRun {
    fn from(text: &str, start: usize) -> Self {
        let mut run = KeyRun { end: start, ..Default::default() };
        let mut words = [None::<usize>; 3];
        let (mut part_start, mut letters_only) = (start, true);
        let mut close_part = |part_start: usize, end: usize, letters_only: bool| {
            if letters_only && end - part_start >= 3 {
                words = [words[1], words[2], Some(part_start)];
            }
        };
        for (offset, b) in text.as_bytes()[start..].iter().enumerate() {
            let at = start + offset;
            if !key_char(*b) {
                break;
            }
            if *b == b'-' {
                close_part(part_start, at, letters_only);
                (part_start, letters_only) = (at + 1, true);
            } else if !b.is_ascii_alphabetic() {
                letters_only = false;
            }
            if b.is_ascii_digit() {
                run.last_digit = Some(at);
            } else if b.is_ascii_uppercase() {
                run.last_upper = Some(at);
            }
            run.end = at + 1;
        }
        close_part(part_start, run.end, letters_only);
        run.third_last_word = words[0];
        let rest = &text[run.end..];
        if rest.starts_with(".eyJ") {
            let payload = self::run(&rest[1..], key_char);
            let tail = &rest[1 + payload..];
            if payload >= 13 && tail.starts_with('.') {
                let signature = self::run(&tail[1..], key_char);
                if signature >= 10 {
                    run.jwt_rest = Some(1 + payload + 1 + signature);
                }
            }
        }
        run
    }

    /// A bare `sk-` is also how ordinary names start. A key's body is
    /// random; a string of words joined by dashes is a name
    /// (`sk-spinner-three-bounce-wrapper-Large2`, a class). Whether the run
    /// from `from` (the start of a part) holds three such words or more.
    fn reads_as_words(&self, from: usize) -> bool {
        self.third_last_word.is_some_and(|start| start >= from)
    }
}

/// The length of the secret-shaped token `text[at..]` starts with, if it
/// does. `run`: the [`key_char`] run `at` is in.
fn token_len(text: &str, at: usize, run: &KeyRun) -> Option<usize> {
    let s = &text[at..];
    // How much of the key run is left after `prefix`, when `s` starts with it.
    let in_run = |prefix: &str| s.starts_with(prefix).then(|| run.end.saturating_sub(at + prefix.len()));
    let after = |prefix: &str, is: fn(u8) -> bool, at_least: usize| -> Option<usize> {
        // Never further than the key run: these sets are all inside it.
        let rest = s.strip_prefix(prefix)?;
        let body = rest.bytes().take(run.end.saturating_sub(at + prefix.len())).take_while(|b| is(*b)).count();
        (body >= at_least).then_some(prefix.len() + body)
    };
    // GitHub.
    for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        if let Some(len) = after(prefix, alnum, 20) {
            return Some(len);
        }
    }
    if let Some(len) = after("github_pat_", word_char, 20) {
        return Some(len);
    }
    // Stripe.
    for prefix in ["sk_live_", "sk_test_", "rk_live_", "rk_test_", "whsec_"] {
        if let Some(len) = after(prefix, alnum, 16) {
            return Some(len);
        }
    }
    // Anthropic, OpenAI.
    for prefix in ["sk-ant-", "sk-proj-"] {
        if let Some(body) = in_run(prefix).filter(|body| *body >= 20) {
            return Some(prefix.len() + body);
        }
    }
    if let Some(body) = in_run("sk-").filter(|body| *body >= 20) {
        let from = at + 3;
        let random = run.last_digit.is_some_and(|p| p >= from) && run.last_upper.is_some_and(|p| p >= from);
        if random && !run.reads_as_words(from) {
            return Some(3 + body);
        }
    }
    // Slack. (The body is taken to the end of the key run: a Slack token
    // has no `_`, and one that follows it is not worth keeping.)
    if s.starts_with("xox") && s[3..].bytes().next().is_some_and(|b| b"baprs".contains(&b)) && s[4..].starts_with('-') {
        let body = run.end.saturating_sub(at + 5);
        if body >= 10 && run.last_digit.is_some_and(|p| p >= at + 5) {
            return Some(5 + body);
        }
    }
    // AWS access key id: exactly twenty capitals and digits.
    if s.starts_with("AKIA") || s.starts_with("ASIA") {
        let body = s[4..].bytes().take(17).take_while(|b| b.is_ascii_uppercase() || b.is_ascii_digit()).count();
        if body == 16 && !s[20..].bytes().next().is_some_and(word_char) {
            return Some(20);
        }
    }
    // Google API key: `AIza` and thirty-five more.
    if in_run("AIza") == Some(35) {
        return Some(39);
    }
    // A JSON Web Token: header.payload.signature, both JSON objects in
    // base64url. The header is the rest of this run; the other two parts
    // were read with the run ([`KeyRun::jwt_rest`]).
    if s.starts_with("eyJ") {
        let header = run.end - at;
        if let Some(rest) = run.jwt_rest.filter(|_| header >= 13) {
            return Some(header + rest);
        }
    }
    None
}

/// The token after `Bearer `: long, and with a digit in it (prose after the
/// word, and placeholders like `<token>` or `${TOKEN}`, are not one) — and
/// not a path: `Bearer auth/middleware/v2/refresh_handler.rs` is a sentence
/// that goes on. A token with `/` in it is base64, which has capitals and
/// no file extension.
fn bearer_token_len(s: &str) -> Option<usize> {
    let len = run(s, |b| b.is_ascii_alphanumeric() || b"._~+/=-".contains(&b));
    let token = &s[..len];
    if len < 20 || !token.bytes().any(|b| b.is_ascii_digit()) {
        return None;
    }
    if token.contains('/') {
        let extension = token.rsplit_once('.').is_some_and(|(_, ext)| (1..=5).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) && ext.bytes().any(|b| b.is_ascii_lowercase()));
        if extension || !token.bytes().any(|b| b.is_ascii_uppercase()) {
            return None;
        }
    }
    Some(len)
}

fn token_shapes(text: &str, removed: &mut usize) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    let mut key_run = KeyRun::default();
    while i < bytes.len() {
        // Only ASCII starts a shape, and never in the middle of a word.
        if !bytes[i].is_ascii_alphabetic() || (i > 0 && word_char(bytes[i - 1])) {
            i += 1;
            continue;
        }
        if i >= key_run.end {
            key_run = KeyRun::from(text, i);
        }
        let here = &text[i..];
        let bearer = here.len() > 7 && here.as_bytes()[..6].eq_ignore_ascii_case(b"bearer") && here.as_bytes()[6] == b' ';
        let found = if bearer {
            bearer_token_len(&here[7..]).map(|len| (7, len))
        } else {
            token_len(text, i, &key_run).map(|len| (0, len))
        };
        match found {
            Some((kept, len)) => {
                out.push_str(&text[copied..i + kept]);
                out.push_str(REMOVED);
                *removed += 1;
                i += kept + len;
                copied = i;
            }
            None => i += 1,
        }
    }
    out.push_str(&text[copied..]);
    out
}

// ── NAME=value ──────────────────────────────────────────────────────────

/// Whether an environment-style name names a secret: its last part, or any
/// part, says so — unless its last part says it is something about one, not
/// the secret itself (`PASSWORD_RESET_PATH`, `TOKEN_URL`, `SECRET_NAME`).
///
/// Round 3: `…_SECRET_ID` and `…_TOKEN_ID` are not "about" one. An id that
/// follows `SECRET` or `TOKEN` is itself what is presented to get in
/// (`VAULT_SECRET_ID`, `CLIENT_SECRET_ID`), so `ID` exempts nothing there.
/// The other endings stay exempt after `SECRET` or `TOKEN` too: a path, a
/// URL, a file, a name, a header, a prefix, a time to live, a length, a type
/// or a version of a secret says where or what it is, and is not it. (An id
/// after `KEY` — `ACCESS_KEY_ID` — is the public half of a pair; its own
/// shape, `AKIA…`, is caught as a token.)
fn secret_name(name: &str) -> bool {
    let parts: Vec<&str> = name.split('_').filter(|part| !part.is_empty()).collect();
    let last = parts.last().copied().unwrap_or_default();
    let before_last = parts.len().checked_sub(2).map(|at| parts[at]).unwrap_or_default();
    let id_of_a_secret = last == "ID" && matches!(before_last, "SECRET" | "TOKEN");
    if !id_of_a_secret
        && matches!(
        last,
        "PATH" | "URL" | "URI" | "FILE" | "DIR" | "NAME" | "ID" | "HEADER" | "FIELD" | "PREFIX" | "SUFFIX" | "TTL" | "LENGTH"
            | "LEN" | "SIZE" | "COUNT" | "ENABLED" | "EXPIRY" | "EXPIRES" | "TIMEOUT" | "ENDPOINT" | "HOST" | "PORT" | "TYPE"
            | "ALGORITHM" | "ALG" | "VERSION"
        )
    {
        return false;
    }
    matches!(last, "KEY" | "TOKEN" | "SECRET" | "PASSWORD" | "PASSWD" | "PWD" | "CREDENTIALS" | "CREDENTIAL")
        || parts.iter().any(|part| matches!(*part, "SECRET" | "PASSWORD" | "PASSWD" | "TOKEN"))
}

/// Whether a name is a password's or a secret's by its own word, not only a
/// key's or a token's: its value is one whatever it reads like.
fn password_name(name: &str) -> bool {
    name.split('_').any(|part| matches!(part, "SECRET" | "PASSWORD" | "PASSWD" | "PWD"))
}

/// A value that reads as a path or as a name, not as something random:
/// lower-case words and short version-like parts (`v2`, `01`) joined by
/// `/`, `_`, `-` or `.` — `users/profile/v2/list`, `created_at_desc_v2`. A
/// hex string, a UUID and base64 are not: their parts mix letters and
/// digits, or have capitals.
fn reads_as_a_name(value: &str) -> bool {
    if value.bytes().any(|b| b.is_ascii_uppercase() || b"+=".contains(&b)) || !value.bytes().any(|b| b"/_-.".contains(&b)) {
        return false;
    }
    value.split(['/', '_', '-', '.']).filter(|part| !part.is_empty()).all(|part| {
        let letters = part.bytes().filter(|b| b.is_ascii_alphabetic()).count();
        let digits = part.len() - letters;
        // A word; a short number; or a word with a short number on it (`v2`, `utf8`).
        (digits == 0) || (letters == 0 && digits <= 4) || (digits <= 2 && letters <= 8 && part.bytes().next().is_some_and(|b| b.is_ascii_alphabetic()))
    })
}

/// Whether `value` is long and token-like enough to be a secret, and not
/// code: no reference (`$VAR`, `process.env.X`), no call, no URL, no
/// placeholder in words, and — for a key or a token — no path and no name
/// ([`reads_as_a_name`]). A password's value is taken whatever it reads
/// like, unless it is plainly a path (it starts with `/`).
fn secret_value(name: &str, value: &str) -> bool {
    let token_like = value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-+/=.".contains(&b));
    let reference = ["process.env", "os.environ", "env.", "ENV.", "System.getenv", "import.meta"].iter().any(|r| value.starts_with(r));
    let named = if password_name(name) { value.starts_with('/') && reads_as_a_name(value) } else { reads_as_a_name(value) };
    value.len() >= 12
        && token_like
        && !reference
        && !named
        && (value.bytes().any(|b| b.is_ascii_digit()) || value.len() >= 20)
}

fn secret_assignments(text: &str, removed: &mut usize) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        // A name starts with a capital, and not inside a word, a path or a member access.
        if !bytes[i].is_ascii_uppercase() || (i > 0 && (word_char(bytes[i - 1]) || bytes[i - 1] == b'.')) {
            i += 1;
            continue;
        }
        let name_len = run(&text[i..], |b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
        let after_name = i + name_len;
        if bytes.get(after_name) != Some(&b'=') || !secret_name(&text[i..after_name]) {
            i = after_name.max(i + 1);
            continue;
        }
        let mut value_start = after_name + 1;
        let quote = bytes.get(value_start).copied().filter(|b| *b == b'"' || *b == b'\'');
        if quote.is_some() {
            value_start += 1;
        }
        let value_len = run(&text[value_start..], |b| match quote {
            Some(q) => b != q && b != b'\n',
            None => !b.is_ascii_whitespace() && !b"`\"',;)".contains(&b),
        });
        let value = &text[value_start..value_start + value_len];
        if secret_value(&text[i..after_name], value) {
            out.push_str(&text[copied..value_start]);
            out.push_str(REMOVED);
            *removed += 1;
            copied = value_start + value_len;
        }
        i = value_start + value_len;
    }
    out.push_str(&text[copied..]);
    out
}

// ── Folders ─────────────────────────────────────────────────────────────

/// A byte a path can't follow directly: before it, `/Users/…` is the tail
/// of something else (a URL's path, a longer path).
fn path_glue(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"._~/\\-".contains(&b)
}

fn separator(b: u8) -> bool {
    b == b'/' || b == b'\\'
}

/// A folder as a text may spell it, and whether its letters' case matters.
struct Spellings {
    forms: Vec<String>,
    ignore_case: bool,
}

/// Every way a tool prints `folder`. A Windows folder (`C:\a\b`): with `\`,
/// with `/`, with `\\` (inside JSON or a string literal), as Git Bash
/// (`/c/a/b`) and as WSL (`/mnt/c/a/b`) spell it — in any case, as that file
/// system reads them. Any other folder: as it is.
fn spellings(folder: &Path) -> Option<Spellings> {
    let text = folder.to_string_lossy();
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    let text = text.trim_end_matches(['/', '\\']);
    if text.len() < 2 {
        return None;
    }
    let bytes = text.as_bytes();
    if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let parts: Vec<&str> = text[2..].split(['/', '\\']).filter(|part| !part.is_empty()).collect();
        if parts.is_empty() {
            return None;
        }
        let forms = vec![
            format!("{drive}:\\\\{}", parts.join("\\\\")),
            format!("{drive}:\\{}", parts.join("\\")),
            format!("{drive}:/{}", parts.join("/")),
            format!("/mnt/{drive}/{}", parts.join("/")),
            format!("/{drive}/{}", parts.join("/")),
        ];
        return Some(Spellings { forms, ignore_case: true });
    }
    Some(Spellings { forms: vec![text.to_string()], ignore_case: false })
}

impl Spellings {
    /// The first place at or after `from` where `text` spells the folder:
    /// where it starts and ends.
    fn find(&self, text: &str, from: usize) -> Option<(usize, usize)> {
        let bytes = text.as_bytes();
        (from..bytes.len()).find_map(|at| {
            // Every form starts with an ASCII byte, so `at` cuts no character.
            self.forms.iter().find_map(|form| {
                let form = form.as_bytes();
                let here = bytes.get(at..at + form.len())?;
                let same = if self.ignore_case { here.eq_ignore_ascii_case(form) } else { here == form };
                same.then_some((at, at + form.len()))
            })
        })
    }
}

/// The verbatim prefix Windows puts before a long path (`\\?\`), in its
/// three spellings: when `before` ends with one, how long it is.
fn verbatim_prefix_len(before: &str) -> usize {
    [r"\\\\?\\", r"\\?\", "//?/"].iter().find(|prefix| before.ends_with(**prefix)).map_or(0, |prefix| prefix.len())
}

/// What a folder found in a text is replaced with.
enum Shown {
    /// The project: what is under it is shown relative to it, itself as `.`.
    Relative,
    /// The member's home: `~`, the tail kept.
    Home,
    /// A session root: under it, `<kind>/worktrees/<id>` is a Reviewer's
    /// tree of the project, shown like the project. Anything else under it
    /// is left for the home rules.
    SessionRoot,
}

/// Replace every spelling of `folder` in `text` that stands as a folder: not
/// the tail of a longer path, not the start of a longer name
/// (`…/card-abc-2`, `/Users/matteo2`).
fn show_folder(text: &str, folder: &Path, shown: Shown) -> String {
    let Some(spellings) = spellings(folder) else { return text.to_string() };
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut from = 0;
    while let Some((found, end)) = spellings.find(text, from) {
        from = found + 1;
        let start = found - verbatim_prefix_len(&text[..found]);
        let free = start == 0 || !path_glue(bytes[start - 1]) || text[..start].ends_with("file://");
        let next = bytes.get(end).copied();
        let under = next.is_some_and(separator);
        if start < copied || !free || (!under && next.is_some_and(path_glue)) {
            continue;
        }
        // Past the folder and the separators after it.
        let tail = end + text[end..].bytes().take_while(|b| separator(*b)).count();
        let tail_is_a_path = bytes.get(tail).is_some_and(|b| path_glue(*b));
        let (replacement, resume) = match shown {
            Shown::Home => ("~", end),
            Shown::Relative if under && tail_is_a_path => ("", tail),
            Shown::Relative => (".", tail),
            Shown::SessionRoot => {
                // `<kind>/worktrees/<id>`: three names, the middle one fixed.
                let mut at = tail;
                let mut names = [""; 3];
                for name in &mut names {
                    let len = text[at..].bytes().take_while(|b| !separator(*b) && !b.is_ascii_whitespace() && !b"\"'`<>:,;)]|".contains(b)).count();
                    *name = &text[at..at + len];
                    at += len;
                    at += text[at..].bytes().take_while(|b| separator(*b)).count();
                }
                if !under || names.iter().any(|name| name.is_empty()) || names[1] != "worktrees" {
                    continue;
                }
                let ends_in_a_separator = at > 0 && separator(bytes[at - 1]);
                match bytes.get(at).is_some_and(|b| path_glue(*b)) && ends_in_a_separator {
                    true => ("", at),
                    false => (".", at),
                }
            }
        };
        out.push_str(&text[copied..start]);
        out.push_str(replacement);
        copied = resume;
        from = resume.max(found + 1);
    }
    out.push_str(&text[copied..]);
    out
}

// ── Any other home folder ───────────────────────────────────────────────

/// A byte that can be in a person's folder name: anything but a separator,
/// a line end, and what plainly ends a path in a text.
fn name_byte(b: u8) -> bool {
    !separator(b) && !b.is_ascii_whitespace() && !b"\"'`<>:,;()[]{}|*?=".contains(&b)
}

/// How much of `s` is the user's name in a home path.
///
/// Up to the next separator. A name can hold spaces (`Mario Rossi`, `José
/// María`), and then nothing in the text says where it ends: `/Users/matteo
/// and then src/app.js` is a name and a sentence, `/Users/Mario Rossi/proj`
/// is a name. So a space is taken into the name when what follows is at
/// most two more words of name bytes and then a separator — a name of up to
/// three words that is plainly followed by the rest of a path. That removes
/// a word or two of an ordinary sentence now and then (`/Users/matteo and
/// src/app.js` → `~/app.js`); it never leaves half a name, which is what
/// the filter is for.
fn name_len(s: &str) -> usize {
    let bytes = s.as_bytes();
    let first = run(s, name_byte);
    if first == 0 || bytes.get(first).is_some_and(|b| separator(*b)) {
        return first;
    }
    let mut end = first;
    for _ in 0..2 {
        if bytes.get(end) != Some(&b' ') {
            return first;
        }
        let word = run(&s[end + 1..], name_byte);
        if word == 0 {
            return first;
        }
        end += 1 + word;
        if bytes.get(end).is_some_and(|b| separator(*b)) {
            return end;
        }
    }
    first
}

/// Whether `s` starts with `lead` whatever the case of its ASCII letters.
fn starts_with_ignoring_case(s: &str, lead: &str) -> bool {
    s.as_bytes().get(..lead.len()).is_some_and(|head| head.eq_ignore_ascii_case(lead.as_bytes()))
}

/// A server's or a share's name in a network path: no separator, nothing
/// that ends a path in a text.
fn network_name_len(s: &str) -> usize {
    run(s, name_byte)
}

/// Round 3: how much of `s` is `\\<server>\<share>\Users\` — the homes on a
/// network share — in the spellings of a path on Windows: `\`, doubled `\\`
/// (inside JSON or a string literal), and, when `slashes` allows it, `/`
/// (`//server/share/Users/…`, as Git Bash prints it).
fn network_homes_lead_len(s: &str, slashes: bool) -> Option<usize> {
    [("\\\\\\\\", "\\\\"), ("\\\\", "\\"), ("//", "/")].iter().find_map(|(lead, sep)| {
        if *sep == "/" && !slashes {
            return None;
        }
        let rest = s.strip_prefix(lead)?;
        let server = network_name_len(rest);
        let rest = rest[server..].strip_prefix(sep).filter(|_| server > 0)?;
        let share = network_name_len(rest);
        let rest = rest[share..].strip_prefix(sep).filter(|_| share > 0)?;
        let rest = starts_with_ignoring_case(rest, "Users").then(|| &rest[5..])?.strip_prefix(sep)?;
        Some(s.len() - rest.len())
    })
}

/// How much of `s` names the folder that holds the homes, when it starts
/// with one: `/Users/`, `/home/`; a drive's `X:\Users\`, in any case and
/// with `/` or `\\`; Git Bash's `/x/Users/`; WSL's `/mnt/x/Users/`; a
/// network share's `\\server\share\Users\`.
///
/// Round 3: after `/x/` and `/mnt/x/` the folder is `Users` as written.
/// Git Bash and WSL print it with its capital, and without one the same
/// shape is a route (`GET /v/users/42/profile`).
///
/// `after_scheme`: `s` follows a `:`, as the `//` of a URL does. Then
/// `//host/a/Users/…` is an address, not a share.
fn homes_lead_len(s: &str, after_scheme: bool) -> Option<usize> {
    let bytes = s.as_bytes();
    if let Some(lead) = network_homes_lead_len(s, !after_scheme) {
        return Some(lead);
    }
    for lead in ["/Users/", "/home/"] {
        if s.starts_with(lead) {
            return Some(lead.len());
        }
    }
    let users = |at: usize| -> Option<usize> {
        [":\\\\Users\\\\", ":\\Users\\", ":/Users/"]
            .iter()
            .find(|lead| starts_with_ignoring_case(&s[at..], lead))
            .map(|lead| at + lead.len())
    };
    if bytes.first().is_some_and(|b| b.is_ascii_alphabetic()) && bytes.get(1) == Some(&b':') {
        return users(1);
    }
    // `/c/Users/…` and `/mnt/c/Users/…`: a drive spelled as a folder.
    for mount in ["/mnt/", "/"] {
        let Some(rest) = s.strip_prefix(mount) else { continue };
        if rest.as_bytes().first().is_some_and(|b| b.is_ascii_alphabetic()) && rest[1..].starts_with("/Users/") {
            return Some(mount.len() + 1 + "/Users/".len());
        }
    }
    None
}

fn other_homes(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        // A home path starts with `/`, `\` or a drive letter; all are ASCII,
        // so the slice below never cuts a character.
        if !separator(bytes[i]) && !bytes[i].is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        let verbatim = verbatim_prefix_len(&text[..i]);
        let start = i - verbatim;
        let free = start == 0 || !path_glue(bytes[start - 1]) || text[..start].ends_with("file://");
        let after_scheme = i > 0 && bytes[i - 1] == b':';
        let Some(lead) = (free && start >= copied).then(|| homes_lead_len(&text[i..], after_scheme)).flatten() else {
            i += 1;
            continue;
        };
        let name = name_len(&text[i + lead..]);
        let who = &text[i + lead..i + lead + name];
        if name == 0 || who.eq_ignore_ascii_case("Shared") || who.eq_ignore_ascii_case("Public") {
            i += lead;
            continue;
        }
        out.push_str(&text[copied..start]);
        out.push('~');
        i += lead + name;
        copied = i;
    }
    out.push_str(&text[copied..]);
    out
}

fn anonymous_paths(text: &str, places: &Places) -> String {
    // The reviewed project first, the longest folder first: a path under it
    // is shown relative to it.
    let mut project: Vec<&Path> = places.project.to_vec();
    project.sort_by_key(|folder| std::cmp::Reverse(folder.as_os_str().len()));
    let mut text = text.to_string();
    for folder in project {
        text = show_folder(&text, folder, Shown::Relative);
    }
    // The Reviewer's own tree of the project, under a session root.
    for root in places.session_roots {
        text = show_folder(&text, root, Shown::SessionRoot);
    }
    // The member's own home, as an exact prefix: its name may hold spaces.
    if let Some(home) = places.home {
        text = show_folder(&text, home, Shown::Home);
    }
    // Then any other home folder: the user's name goes, the tail stays.
    other_homes(&text)
}

#[cfg(test)]
#[path = "publish_filter_tests.rs"]
mod tests;
