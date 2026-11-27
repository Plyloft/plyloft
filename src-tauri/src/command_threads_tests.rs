//! 1.174.0 B4 (CH-1): a Tauri command that runs git or `gh` is off the main
//! thread. A plain `#[tauri::command]` on a sync `fn` runs on the main
//! thread, so a slow git or a `gh` that waits on GitHub freezes the whole
//! window (the 50 s launch freeze, `card_overlap_check`). Such a command is
//! `#[tauri::command(async)]` or an `async fn`, or hands the work to a
//! worker (`spawn_blocking`, `thread::spawn`) itself.
//!
//! The scan reads every source file (not the tests) as the bounded-`gh` test
//! does (`github.rs`, `no_gh_is_spawned_without_a_bound`). "Spawns" means the
//! command's own body names git or `gh` directly, or a helper known to run
//! them ([`SPAWNS`]); a helper further down is not followed.

use std::path::Path;

/// What in a command's own body runs git or `gh`, or another process: the
/// spawn itself, or a helper known to run one (round 1: the helpers a
/// command body calls directly; one further down is not followed).
const SPAWNS: &[&str] = &[
    "git_command(",
    "git_command_for(",
    "new_command(",
    // Split so platform.rs's raw-spawn scan doesn't count the marker.
    concat!("Command", "::new("),
    "crate::git::",
    "git::capture",
    "crate::github::",
    "crate::overlap::",
    "crate::worktrees::list_for_workspace(",
    "crate::worktrees::card_diff_base(",
    "gh_sync_card_create(",
    "gh_sync_card_edit(",
    "adopt_gh_remainder(",
    "local_target_matches_origin(",
    "detect_from_filesystem(",
    "list_shared(",
    "crate::builder::done(",
    "head_sha(",
    "codex_git_grants(",
    "crate::inbox::assemble_feed(",
];

/// A body that hands its work to a worker is not on the main thread.
const WORKER: &[&str] = &["spawn_blocking(", "thread::spawn(", "async_runtime::spawn("];

/// Sync commands that spawn git or `gh` today, each with why it stays — the
/// ratchet only goes down: a new one fails, and an entry that no longer
/// applies (gone, made async, no longer spawning) fails until removed.
/// 1.174.0 B4 deleted `workspace_branch_pulse` and
/// `workspace_worktree_overlaps` and made `card_overlap_check`,
/// `worktree_list`, `inbox_mark_all_seen`, `project_config_detect`,
/// `knowledge_list_project`, `builder_done`, `builder_accept_pushback` and
/// `builder_review_again` async.
const GH_204: &str = "GH #204: bounded create on the main thread, timeout handed to Sync";
const BASELINE: &[(&str, &str)] = &[
    ("kanban_card_create", GH_204),
    ("kanban_card_follow_up", GH_204),
    ("kanban_card_patch", GH_204),
    ("kanban_card_use_issue_remainder", GH_204),
];

#[derive(Debug)]
struct Command {
    file: String,
    name: String,
    is_async: bool,
    spawns: Vec<&'static str>,
    worker: bool,
}

/// `code` with every comment and the inside of every string and char
/// literal turned into spaces, byte for byte (so offsets still match): a
/// brace, a marker or an attribute in a doc comment or a string is not code.
fn blank(code: &str) -> String {
    let b = code.as_bytes();
    let mut out = b.to_vec();
    let ident = |i: usize| i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_');
    let mut i = 0;
    while i < b.len() {
        let start = i;
        if b[i..].starts_with(b"//") {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else if b[i..].starts_with(b"/*") {
            let mut depth = 0;
            while i < b.len() {
                if b[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if b[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
        } else if (b[i] == b'r' || b[i..].starts_with(b"br")) && !ident(i) && {
            let r = if b[i] == b'b' { i + 2 } else { i + 1 };
            let hashes = b[r..].iter().take_while(|&&c| c == b'#').count();
            b.get(r + hashes) == Some(&b'"')
        } {
            // A raw string: r#"…"#, closed by the same number of hashes.
            let r = if b[i] == b'b' { i + 2 } else { i + 1 };
            let hashes = b[r..].iter().take_while(|&&c| c == b'#').count();
            let mut close = vec![b'"'];
            close.extend(std::iter::repeat_n(b'#', hashes));
            i = r + hashes + 1;
            while i < b.len() && !b[i..].starts_with(&close) {
                i += 1;
            }
            let end = (i + close.len()).min(b.len());
            out[r + hashes + 1..i.min(b.len())].fill(b' ');
            i = end;
            continue;
        } else if b[i] == b'"' {
            i += 1;
            while i < b.len() && b[i] != b'"' {
                i += if b[i] == b'\\' { 2 } else { 1 };
            }
            let end = i.min(b.len());
            out[start + 1..end].fill(b' ');
            i = end + 1;
            continue;
        } else if b[i] == b'\'' {
            // A char literal ('x', '\n', '\u{1F600}', 'é'), not a lifetime.
            let next = code[i + 1..].chars().next();
            let len = next.map_or(0, char::len_utf8);
            let end = if next == Some('\\') {
                code[i + 2..].find('\'').map(|p| i + 2 + p)
            } else if b.get(i + 1 + len) == Some(&b'\'') {
                Some(i + 1 + len)
            } else {
                None
            };
            match end {
                Some(end) => {
                    out[i + 1..end].fill(b' ');
                    i = end + 1;
                }
                None => i += 1,
            }
            continue;
        } else {
            i += 1;
            continue;
        }
        out[start..i.min(b.len())].fill(b' ');
    }
    String::from_utf8(out).expect("blanking keeps UTF-8")
}

/// The matching close of the bracket at `open` (`(`, `[` or `{`), in
/// blanked code.
fn matching(code: &[u8], open: usize) -> Option<usize> {
    let o = code[open];
    let c = match o {
        b'(' => b')',
        b'[' => b']',
        _ => b'}',
    };
    let mut depth = 0usize;
    for (i, &b) in code.iter().enumerate().skip(open) {
        if b == o {
            depth += 1;
        } else if b == c {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

/// `marker` in `body` as a word (not the tail of a longer name).
fn names(body: &str, marker: &str) -> bool {
    body.match_indices(marker).any(|(at, _)| {
        at == 0 || {
            let c = body.as_bytes()[at - 1];
            !(c.is_ascii_alphanumeric() || c == b'_')
        }
    })
}

/// Every Tauri command in `code` (one file, its tests cut off):
/// `#[tauri::command…]` and the shipping `#[cfg_attr(not(test),
/// tauri::command…)]` (a `cfg_attr(test, …)` twin is skipped).
fn commands_in(file: &str, code: &str) -> Vec<Command> {
    let blanked = blank(code);
    let code = blanked.as_str();
    let bytes = code.as_bytes();
    let mut out = Vec::new();
    for (at, _) in code.match_indices("tauri::command") {
        let Some(open) = code[..at].rfind("#[") else { continue };
        let Some(close) = matching(bytes, open + 1) else { continue };
        if close < at || code[open..at].contains('\n') {
            continue;
        }
        let attr = &code[open..=close];
        let prefix = &code[open + 2..at];
        if !(prefix.is_empty() || prefix.starts_with("cfg_attr(")) {
            continue;
        }
        if prefix.starts_with("cfg_attr(") && !prefix.starts_with("cfg_attr(not(test)") {
            continue;
        }
        let rest = &code[close + 1..];
        let Some(fn_at) = rest.find("fn ") else { continue };
        let head = &rest[..fn_at];
        let name: String = rest[fn_at + 3..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        let base = close + 1 + fn_at;
        let Some(paren) = code[base..].find('(').map(|p| base + p) else { continue };
        let Some(params_end) = matching(bytes, paren) else { continue };
        let Some(brace) = code[params_end..].find('{').map(|p| params_end + p) else { continue };
        let Some(body_end) = matching(bytes, brace) else { continue };
        let body = &code[brace..=body_end];
        out.push(Command {
            file: file.to_string(),
            name,
            is_async: attr.contains("async") || head.contains("async"),
            spawns: SPAWNS.iter().copied().filter(|m| names(body, m)).collect(),
            worker: WORKER.iter().any(|w| names(body, w)),
        });
    }
    out
}

/// Every `.rs` under `dir`, its subfolders too, but the tests (`*_tests.rs`,
/// `tests.rs`, and a `tests/` folder's files).
fn sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if path.is_dir() {
            if name != "tests" {
                sources(&path, out);
            }
        } else if name.ends_with(".rs") && !name.ends_with("_tests.rs") && name != "tests.rs" {
            out.push(path);
        }
    }
}

fn all_commands() -> Vec<Command> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&src, &mut files);
    let mut out = Vec::new();
    for path in files {
        let name = path.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
        let source = std::fs::read_to_string(&path).unwrap();
        let code = source.split("#[cfg(test)]\nmod tests").next().unwrap();
        out.extend(commands_in(&name, code));
    }
    out
}

fn on_the_main_thread_spawning(c: &Command) -> bool {
    !c.is_async && !c.worker && !c.spawns.is_empty()
}

#[test]
fn every_command_that_runs_git_or_gh_is_off_the_main_thread() {
    let commands = all_commands();
    assert!(commands.len() > 400, "the scan found only {} commands", commands.len());
    let offending: Vec<String> = commands
        .iter()
        .filter(|c| on_the_main_thread_spawning(c))
        .filter(|c| !BASELINE.iter().any(|(n, _)| *n == c.name))
        .map(|c| format!("{}: `{}` runs {:?} on the main thread", c.file, c.name, c.spawns))
        .collect();
    assert!(
        offending.is_empty(),
        "make these `#[tauri::command(async)]` (or an `async fn`):\n{}",
        offending.join("\n")
    );
}

#[test]
fn the_baseline_only_goes_down() {
    let commands = all_commands();
    for (name, reason) in BASELINE {
        assert!(!reason.trim().is_empty(), "`{name}`: say why it stays sync");
        let c = commands.iter().find(|c| c.name == *name);
        assert!(
            c.is_some_and(on_the_main_thread_spawning),
            "`{name}` is gone, async or no longer runs git: take it out of BASELINE"
        );
    }
}

#[test]
fn the_scan_sees_the_commands_it_guards() {
    let commands = all_commands();
    let find = |n: &str| commands.iter().find(|c| c.name == n).unwrap_or_else(|| panic!("no `{n}`"));
    // CH-1: git per card plus `gh pr list`.
    let overlap = find("card_overlap_check");
    assert!(overlap.is_async && overlap.spawns.contains(&"crate::overlap::"), "{overlap:?}");
    assert!(overlap.spawns.contains(&"crate::github::"), "{overlap:?}");
    // Round 1: a cfg_attr command is seen (the shipping attribute is async).
    let feed = find("inbox_feed");
    assert!(feed.is_async, "{feed:?}");
    for name in ["inbox_mark_all_seen", "project_config_detect", "builder_done"] {
        let c = find(name);
        assert!(c.is_async && !c.spawns.is_empty(), "{c:?}");
    }
    // Traced by hand (their git is a helper further down): async too.
    for name in ["builder_review_again", "builder_accept_pushback"] {
        assert!(find(name).is_async, "{name}");
    }
    // Polish: subfolders are walked (today they hold only tests), and no
    // test file is read.
    let dir = std::env::temp_dir().join(format!("command-threads-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("sub/tests")).unwrap();
    for f in ["a.rs", "a_tests.rs", "sub/b.rs", "sub/tests.rs", "sub/tests/c.rs", "sub/notes.md"] {
        std::fs::write(dir.join(f), "").unwrap();
    }
    let mut files = Vec::new();
    sources(&dir, &mut files);
    let mut names: Vec<String> =
        files.iter().map(|p| p.strip_prefix(&dir).unwrap().to_string_lossy().replace('\\', "/")).collect();
    names.sort();
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(names, vec!["a.rs", "sub/b.rs"]);
    let list = find("worktree_list");
    assert!(list.is_async && !list.spawns.is_empty(), "{list:?}");
    // The scanner itself: a sync body naming git is caught; async and a
    // worker are not.
    let code = "#[tauri::command]\npub fn a(x: String) -> R { crate::git::capture(p, &[]) }\n\
                #[tauri::command(async)]\npub fn b() { crate::git::capture(p, &[]) }\n\
                #[tauri::command]\npub async fn c() { crate::github::pr_list() }\n\
                #[tauri::command]\npub fn d() { tauri::async_runtime::spawn_blocking(move || crate::git::run(p, &[])) }\n\
                #[tauri::command]\npub fn e(s: State<'_, S>) -> Result<(), String> { s.save() }\n";
    let parsed = commands_in("x.rs", code);
    let flagged: Vec<&str> = parsed.iter().filter(|c| on_the_main_thread_spawning(c)).map(|c| c.name.as_str()).collect();
    assert_eq!(parsed.len(), 5);
    assert_eq!(flagged, vec!["a"]);
    // Round 1: braces and markers in strings, chars and comments are not
    // code; the shipping half of a cfg_attr pair is read, its test twin
    // skipped; a helper's name must be the whole word.
    // The raw spawn is split (`concat!`) so platform.rs's scan doesn't count it.
    let code = concat!("#[tauri::command]\npub fn f() { let _ = \"}\"; let _ = '}'; // }\n /* } */ let r = r#\"}\"#; ok() }\n\
                fn after() { crate::git::capture(p, &[]) }\n\
                /// `#[tauri::command]` in a doc comment\nfn doc() { crate::git::run(p, &[]) }\n\
                #[cfg_attr(not(test), tauri::command(async))]\n#[cfg_attr(test, tauri::command)]\npub fn g() { crate::git::capture(p, &[]) }\n\
                #[cfg_attr(not(test), tauri::command)]\n#[cfg_attr(test, tauri::command)]\npub fn h<'a>(s: &'a str) { std::process::Command", "::new(s) }\n\
                #[tauri::command]\npub fn i() { my_head_sha(p); x.list_shared_names() }\n");
    let parsed = commands_in("y.rs", code);
    let names: Vec<&str> = parsed.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["f", "g", "h", "i"]);
    assert!(parsed[0].spawns.is_empty(), "f's body ends at its own brace: {:?}", parsed[0]);
    assert!(parsed[1].is_async && !parsed[1].spawns.is_empty());
    assert!(on_the_main_thread_spawning(&parsed[2]), "{:?}", parsed[2]);
    assert!(parsed[3].spawns.is_empty(), "{:?}", parsed[3]);
}
