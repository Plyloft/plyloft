//! v1.62.0 (Phase 6 — guardrail awareness): parse a repo's
//! `.github/CODEOWNERS` and decide whether a repo-relative path is "owned"
//! (i.e. editing it will auto-request a reviewer). Powers the in-app ribbon
//! that warns before you touch a high-blast-radius file.
//!
//! Scope: a **minimal** gitignore-style matcher covering the patterns we
//! actually author in CODEOWNERS — anchored paths, directory prefixes, and
//! `*`/`**` globs — NOT the full CODEOWNERS spec. It honors **last-match-wins**:
//! GitHub applies only the *last* matching rule, and a rule with **no owners**
//! clears ownership for that subpath. So `flagged_owners` returns the owners of
//! the last matching rule (empty ⇒ not flagged), never a union.

/// One CODEOWNERS line: a path pattern and zero or more owners (`@user`,
/// `@org/team`, or an email).
#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    pub pattern: String,
    pub owners: Vec<String>,
}

/// Parse CODEOWNERS text into rules in file order, skipping blanks + comments.
pub fn parse(text: &str) -> Vec<Rule> {
    text.lines().filter_map(parse_line).collect()
}

fn parse_line(line: &str) -> Option<Rule> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let mut parts = line.split_whitespace();
    let pattern = parts.next()?.to_string();
    let owners = parts.map(str::to_string).collect();
    Some(Rule { pattern, owners })
}

/// Owners of the **last** rule whose pattern matches `rel_path`. Empty when no
/// rule matches OR the last matching rule has no owners (ownership cleared).
/// `rel_path` is repo-relative, `/`-separated (a leading `/` is tolerated).
pub fn flagged_owners(text: &str, rel_path: &str) -> Vec<String> {
    let mut owners = Vec::new();
    for r in parse(text) {
        if path_matches(&r.pattern, rel_path) {
            owners = r.owners; // last match wins
        }
    }
    owners
}

/// Minimal gitignore/CODEOWNERS pattern match. Handles a leading `/` (anchor at
/// repo root), a trailing `/` (directory — matches everything under it), `*`
/// (within a path segment) and `**` (across segments). A pattern with no `/`
/// (e.g. `*.rs`) matches at any depth, per gitignore semantics.
pub fn path_matches(pattern: &str, path: &str) -> bool {
    let path = path.trim_start_matches('/');
    // "Anchored" = rooted at the repo top. A pattern is anchored if it has a
    // leading `/` or contains an interior `/`; a bare name matches at any depth.
    let anchored = pattern.starts_with('/') || pattern.trim_end_matches('/').contains('/');
    let p = pattern.trim_start_matches('/');
    let is_dir = p.ends_with('/');
    let p = p.trim_end_matches('/');
    if p.is_empty() {
        return false;
    }

    // A directory pattern matches the dir itself and anything beneath it.
    let glob = if is_dir { format!("{p}/**") } else { p.to_string() };

    if anchored {
        glob_path(&glob, path)
    } else {
        glob_path(&glob, path) || glob_path(&format!("**/{glob}"), path)
    }
}

/// Glob over `/`-separated paths: `*` matches a run of non-`/` chars, `**`
/// matches zero or more whole segments.
fn glob_path(pattern: &str, text: &str) -> bool {
    let pat: Vec<&str> = pattern.split('/').collect();
    let txt: Vec<&str> = text.split('/').collect();
    match_segments(&pat, &txt)
}

fn match_segments(pat: &[&str], txt: &[&str]) -> bool {
    match pat.first() {
        None => txt.is_empty(),
        Some(&"**") => {
            // `**` consumes zero or more segments.
            if match_segments(&pat[1..], txt) {
                return true;
            }
            !txt.is_empty() && match_segments(pat, &txt[1..])
        }
        Some(seg) => match txt.first() {
            Some(t) if glob_segment(seg, t) => match_segments(&pat[1..], &txt[1..]),
            _ => false,
        },
    }
}

/// Classic single-segment wildcard match (`*` only; segments never contain `/`).
fn glob_segment(pat: &str, text: &str) -> bool {
    let p = pat.as_bytes();
    let t = text.as_bytes();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && p[pi] == b'*' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_skips_comments_and_blanks() {
        let text = "# header\n\n/a/b.rs   @me\n  \n/c/ @me @team\n";
        let rules = parse(text);
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].pattern, "/a/b.rs");
        assert_eq!(rules[0].owners, vec!["@me"]);
        assert_eq!(rules[1].pattern, "/c/");
        assert_eq!(rules[1].owners, vec!["@me", "@team"]);
    }

    #[test]
    fn anchored_exact_file() {
        assert!(path_matches("/src-tauri/src/pty.rs", "src-tauri/src/pty.rs"));
        assert!(path_matches("/src-tauri/src/pty.rs", "/src-tauri/src/pty.rs"));
        assert!(!path_matches("/src-tauri/src/pty.rs", "src-tauri/src/kanban.rs"));
        // not a loose substring/segment match
        assert!(!path_matches("/src-tauri/src/pty.rs", "other/src-tauri/src/pty.rs"));
    }

    #[test]
    fn directory_prefix_matches_everything_under() {
        assert!(path_matches("/src-tauri/capabilities/", "src-tauri/capabilities/default.json"));
        assert!(path_matches("/src-tauri/capabilities/", "src-tauri/capabilities/sub/x.json"));
        assert!(!path_matches("/src-tauri/capabilities/", "src-tauri/src/pty.rs"));
    }

    #[test]
    fn bare_name_matches_at_any_depth() {
        assert!(path_matches("*.rs", "src-tauri/src/pty.rs"));
        assert!(path_matches("*.rs", "lib.rs"));
        assert!(!path_matches("*.rs", "docs/README.md"));
    }

    #[test]
    fn star_does_not_cross_slash() {
        assert!(path_matches("/docs/*.md", "docs/TEAM.md"));
        assert!(!path_matches("/docs/*.md", "docs/sub/TEAM.md"));
    }

    #[test]
    fn last_match_wins() {
        // a later, more specific rule overrides an earlier one
        let text = "/src-tauri/ @team\n/src-tauri/src/pty.rs @owner\n";
        assert_eq!(flagged_owners(text, "src-tauri/src/pty.rs"), vec!["@owner"]);
        // a path only the first rule covers still gets @team
        assert_eq!(flagged_owners(text, "src-tauri/build.rs"), vec!["@team"]);
    }

    #[test]
    fn no_owner_rule_clears_ownership() {
        // last matching rule has no owners → not flagged
        let text = "/src-tauri/src/ @owner\n/src-tauri/src/generated.rs\n";
        assert!(flagged_owners(text, "src-tauri/src/generated.rs").is_empty());
        // sibling still owned
        assert_eq!(flagged_owners(text, "src-tauri/src/pty.rs"), vec!["@owner"]);
    }

    #[test]
    fn unmatched_path_is_not_flagged() {
        let text = "/src-tauri/src/pty.rs @owner\n";
        assert!(flagged_owners(text, "README.md").is_empty());
        assert!(flagged_owners("", "anything.rs").is_empty());
    }

    #[test]
    fn matches_our_real_codeowners_shape() {
        // mirror of the shipped .github/CODEOWNERS patterns
        let text = "\
# comment
/src-tauri/src/kanban.rs  @MatteoB-adv
/src-tauri/capabilities/  @MatteoB-adv
/.github/CODEOWNERS       @MatteoB-adv
";
        assert_eq!(
            flagged_owners(text, "src-tauri/src/kanban.rs"),
            vec!["@MatteoB-adv"]
        );
        assert_eq!(
            flagged_owners(text, ".github/CODEOWNERS"),
            vec!["@MatteoB-adv"]
        );
        assert!(flagged_owners(text, "README.md").is_empty());
        assert!(flagged_owners(text, "src-tauri/src/lib.rs").is_empty());
    }
}
