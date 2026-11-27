//! CL-6: the Challenger's findings placed on the review diff.
//!
//! A ledger finding names a line of a file at the revision its review read
//! (`LedgerFinding::reviewed_revision`). The review diff shows the branch as
//! it is now, so after fix commits that line may sit elsewhere, have been
//! rewritten, or be gone. This maps each finding's line from its revision to
//! the branch tip through `git diff -U0 <revision> <tip>` of that file alone
//! (`map_line`, pure) and says which happened: the same line, the line
//! moved (placed where it went), the line changed or removed (placed by the
//! code that replaced it, said to have changed), the file removed, or not
//! known (an anchor without a revision, from ledgers before CL-6, or a
//! revision git no longer has).
//!
//! Cost stays bounded: one `--name-status` and one `-U0` diff per reviewed
//! revision, the latter limited to files with findings; at most
//! `MAX_REVISIONS` revisions are read, the rest are "not known".

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::Serialize;

use crate::git::DiffHunk;
use crate::review_ledger::{CardLedger, FindingState, LedgerFinding};

/// Reviewed revisions read for one diff; findings of older ones are "not known".
const MAX_REVISIONS: usize = 16;

/// What happened to a finding's line between its review and now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnchorFate {
    /// The same line number holds the same line.
    Same,
    /// The line is unchanged but other lines above it moved it.
    Moved,
    /// The line was rewritten; `line` is where the new code starts.
    Changed,
    /// The line was deleted; `line` is the line before the gap, if any.
    Removed,
    /// The whole file was removed.
    FileRemoved,
    /// No revision to map from, or git could not say.
    Unknown,
}

/// A line's place now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineMap {
    pub fate: AnchorFate,
    /// Where to show it now: the line itself (same, moved), or the closest
    /// line (changed, removed). None when there is none.
    pub line: Option<u32>,
}

/// Map `line` (1-based, at the reviewed revision) through the zero-context
/// hunks of `git diff -U0 <reviewed> <now> -- <file>`, in file order. With
/// `-U0` each hunk is exactly the changed region: `-a,0` inserts after old
/// line `a`; `-a,n` replaces old lines `a..a+n`.
pub fn map_line(line: u32, hunks: &[DiffHunk]) -> LineMap {
    let mut delta: i64 = 0;
    let mut sorted: Vec<&DiffHunk> = hunks.iter().collect();
    sorted.sort_by_key(|hunk| (hunk.old_start, hunk.old_lines));
    for hunk in sorted {
        if hunk.old_lines == 0 {
            // An insertion after old line `old_start` (0: at the top).
            if line > hunk.old_start {
                delta += i64::from(hunk.new_lines);
                continue;
            }
            break;
        }
        let end = hunk.old_start + hunk.old_lines - 1;
        if line < hunk.old_start {
            break;
        }
        if line <= end {
            return if hunk.new_lines == 0 {
                // `+b,0`: the lines went after new line `b` (0: at the top).
                LineMap {
                    fate: AnchorFate::Removed,
                    line: (hunk.new_start > 0).then_some(hunk.new_start),
                }
            } else {
                LineMap {
                    fate: AnchorFate::Changed,
                    line: Some(hunk.new_start.max(1)),
                }
            };
        }
        delta += i64::from(hunk.new_lines) - i64::from(hunk.old_lines);
    }
    let now = i64::from(line) + delta;
    LineMap {
        fate: if delta == 0 { AnchorFate::Same } else { AnchorFate::Moved },
        line: u32::try_from(now).ok().filter(|now| *now > 0),
    }
}

/// One file of a reviewed revision, as it is now.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileNow {
    /// Its path now (a rename's new path); None when it was removed.
    pub path: Option<String>,
    /// Its `-U0` hunks from the reviewed revision to now; empty when unchanged.
    pub hunks: Vec<DiffHunk>,
    /// Git said it changed but its diff could not be read (a path git
    /// quotes, an unknown status): where the line is now is not known.
    pub unread: bool,
}

/// Where `line` of `path` at the reviewed revision is now, given what
/// happened to the file. A file absent from `files` did not change.
pub fn place(path: &str, line: u32, files: &HashMap<String, FileNow>) -> (String, LineMap) {
    let reviewed = path;
    match files.get(path) {
        None => (path.to_string(), LineMap { fate: AnchorFate::Same, line: Some(line) }),
        Some(FileNow { unread: true, path, .. }) => (
            path.clone().unwrap_or_else(|| reviewed.to_string()),
            LineMap { fate: AnchorFate::Unknown, line: None },
        ),
        Some(FileNow { path: None, .. }) => (
            path.to_string(),
            LineMap { fate: AnchorFate::FileRemoved, line: None },
        ),
        Some(FileNow { path: Some(now), hunks, .. }) => {
            let mapped = map_line(line, hunks);
            // A rename that kept the line is still the same line, under the new name.
            (now.clone(), mapped)
        }
    }
}

/// `git diff --name-status -z -M` output: (status letter, old path, new path).
pub fn parse_name_status_z(out: &str) -> Vec<(char, String, Option<String>)> {
    let mut parts = out.split('\0').filter(|part| !part.is_empty());
    let mut entries = Vec::new();
    while let Some(status) = parts.next() {
        let Some(letter) = status.chars().next() else { continue };
        let Some(first) = parts.next() else { break };
        let second = if matches!(letter, 'R' | 'C') {
            parts.next().map(str::to_string)
        } else {
            None
        };
        entries.push((letter, first.to_string(), second));
    }
    entries
}

/// What happened between `revision` and `head` to each of `paths` that
/// changed (unchanged ones are left out), read from git.
fn files_since(repo: &Path, revision: &str, head: &str, paths: &[String]) -> Result<HashMap<String, FileNow>, String> {
    let mut files: HashMap<String, FileNow> = HashMap::new();
    if revision == head {
        return Ok(files);
    }
    let names = crate::git::capture(
        repo,
        &["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--name-status", "-z", "-M", revision, head],
    )?;
    let mut specs: Vec<String> = Vec::new();
    for (letter, old, new) in parse_name_status_z(&names) {
        if !paths.contains(&old) {
            continue;
        }
        match letter {
            'D' => {
                files.insert(old, FileNow { path: None, ..FileNow::default() });
            }
            'R' => {
                let now = new.unwrap_or_else(|| old.clone());
                specs.push(old.clone());
                specs.push(now.clone());
                files.insert(old, FileNow { path: Some(now), unread: true, ..FileNow::default() });
            }
            // A cannot name an old path; C (only with -C) leaves the old file as it was.
            'A' | 'C' => {}
            'M' | 'T' => {
                specs.push(old.clone());
                files.insert(old.clone(), FileNow { path: Some(old), unread: true, ..FileNow::default() });
            }
            // An unmerged or unknown status: changed, in a way not read here.
            _ => {
                files.insert(old.clone(), FileNow { path: Some(old), unread: true, ..FileNow::default() });
            }
        }
    }
    if specs.is_empty() {
        return Ok(files);
    }
    // `core.quotePath=false`: non-ASCII paths come raw, as `-z` gave them
    // above. A path git still quotes (a quote mark, a backslash, a control
    // character) does not match and stays unread: not known, never "same".
    let mut args: Vec<&str> = vec![
        "-c",
        "core.quotePath=false",
        "--literal-pathspecs",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "-U0",
        "-M",
        revision,
        head,
        "--",
    ];
    args.extend(specs.iter().map(String::as_str));
    let diff = crate::git::capture(repo, &args)?;
    for file in crate::git::parse_unified_diff(&diff) {
        let old = file.old_path.clone().unwrap_or_else(|| file.path.clone());
        if let Some(known) = files.get_mut(&old) {
            known.hunks = file.hunks;
            known.unread = false;
        }
    }
    Ok(files)
}

/// A reviewer's path as git names it: forward slashes, no leading `./`.
pub fn repo_path(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    let mut rest = path.as_str();
    while let Some(stripped) = rest.strip_prefix("./") {
        rest = stripped;
    }
    rest.to_string()
}

/// One finding placed on the review diff (`ReviewDiff::anchors`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingAnchor {
    pub id: String,
    pub severity: Option<String>,
    pub state: FindingState,
    /// Never asks for changes (P3, pre-existing, a note, below the
    /// workspace's threshold, or dismissed).
    pub non_blocking: bool,
    /// Findings filter: the member dismissed it as not a real issue.
    pub dismissed: bool,
    /// Who dismissed it and why (Tier 4 walk 2026-10-14: the anchor says
    /// it as the findings list does). Absent unless dismissed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dismissal: Option<crate::review_ledger::Dismissal>,
    /// In code this change did not write.
    pub pre_existing: bool,
    pub title: String,
    /// The finding's complete text (bounded by the ledger).
    pub body: String,
    pub reason: Option<String>,
    pub round: u32,
    pub updated_round: u32,
    /// The file now (a rename's new path).
    pub path: String,
    /// The line the review named, in the revision it read.
    pub reviewed_line: u32,
    /// Where to show it now (see `LineMap::line`).
    pub line: Option<u32>,
    pub fate: AnchorFate,
}

/// The card's findings that name a line, placed on the branch's tip
/// (`head`, a commit-ish in `repo`). Findings with a path alone, or none,
/// are not anchors: they stay in the findings list. Ledger order is kept.
pub fn anchors(repo: &Path, head: &str, ledger: Option<&CardLedger>) -> Vec<FindingAnchor> {
    let Some(ledger) = ledger else { return Vec::new() };
    let head = crate::git::capture(repo, &["rev-parse", "--verify", "--end-of-options", &format!("{head}^{{commit}}")])
        .map(|out| out.trim().to_string())
        .ok();
    anchors_with(&ledger.findings, |revision, paths| match &head {
        Some(head) => {
            let full = crate::git::capture(repo, &["rev-parse", "--verify", "--end-of-options", &format!("{revision}^{{commit}}")])?;
            files_since(repo, full.trim(), head, paths)
        }
        None => Err("the branch tip could not be read".into()),
    })
}

/// `anchors` with the git reads behind `files_since(revision, paths)`.
pub fn anchors_with(
    findings: &[LedgerFinding],
    mut files_since: impl FnMut(&str, &[String]) -> Result<HashMap<String, FileNow>, String>,
) -> Vec<FindingAnchor> {
    let lined: Vec<(&LedgerFinding, String, u32, Option<String>)> = findings
        .iter()
        .filter_map(|finding| {
            let (path, line, revision) = finding.anchor()?;
            Some((finding, repo_path(&path), line?, revision.map(str::to_string)))
        })
        .collect();
    // The paths each revision needs, newest revisions first in the cap:
    // a later round's findings are the ones the diff is about.
    let mut by_revision: BTreeMap<String, (u32, Vec<String>)> = BTreeMap::new();
    for (finding, path, _, revision) in &lined {
        if let Some(revision) = revision {
            let entry = by_revision.entry(revision.clone()).or_insert((0, Vec::new()));
            entry.0 = entry.0.max(finding.updated_round);
            if !entry.1.contains(path) {
                entry.1.push(path.clone());
            }
        }
    }
    let mut order: Vec<(&String, &(u32, Vec<String>))> = by_revision.iter().collect();
    order.sort_by_key(|(_, (round, _))| std::cmp::Reverse(*round));
    let read: HashMap<String, Option<HashMap<String, FileNow>>> = order
        .into_iter()
        .enumerate()
        .map(|(index, (revision, (_, paths)))| {
            let files = (index < MAX_REVISIONS)
                .then(|| match files_since(revision, paths) {
                    Ok(files) => Some(files),
                    Err(error) => {
                        log::info!("review anchors: {revision}: {error}");
                        None
                    }
                })
                .flatten();
            (revision.clone(), files)
        })
        .collect();
    lined
        .into_iter()
        .map(|(finding, path, line, revision)| {
            let files = revision.as_ref().and_then(|revision| read.get(revision)).and_then(Option::as_ref);
            let (now, map) = match files {
                Some(files) => place(&path, line, files),
                None => (path.clone(), LineMap { fate: AnchorFate::Unknown, line: None }),
            };
            FindingAnchor {
                id: finding.id.clone(),
                severity: finding.severity.clone(),
                state: finding.state,
                non_blocking: !finding.blocks(),
                dismissed: finding.dismissal.is_some(),
                dismissal: finding.dismissal.clone(),
                pre_existing: finding.pre_existing,
                title: finding.title.clone(),
                body: finding.body.clone(),
                reason: finding.reason.clone(),
                round: finding.round,
                updated_round: finding.updated_round,
                path: now,
                reviewed_line: line,
                line: map.line,
                fate: map.fate,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hunk(old_start: u32, old_lines: u32, new_start: u32, new_lines: u32) -> DiffHunk {
        DiffHunk {
            header: format!("@@ -{old_start},{old_lines} +{new_start},{new_lines} @@"),
            old_start,
            old_lines,
            new_start,
            new_lines,
            body: String::new(),
        }
    }

    fn at(fate: AnchorFate, line: Option<u32>) -> LineMap {
        LineMap { fate, line }
    }

    #[test]
    fn an_untouched_file_keeps_its_line() {
        assert_eq!(map_line(12, &[]), at(AnchorFate::Same, Some(12)));
    }

    #[test]
    fn lines_inserted_above_move_it_down_and_below_leave_it() {
        // Three lines after old line 4; one at the very top.
        assert_eq!(map_line(12, &[hunk(4, 0, 5, 3)]), at(AnchorFate::Moved, Some(15)));
        assert_eq!(map_line(12, &[hunk(0, 0, 1, 1), hunk(4, 0, 6, 3)]), at(AnchorFate::Moved, Some(16)));
        // Inserted right after the line itself: the line stays.
        assert_eq!(map_line(12, &[hunk(12, 0, 13, 2)]), at(AnchorFate::Same, Some(12)));
        // Below it.
        assert_eq!(map_line(12, &[hunk(30, 0, 31, 5)]), at(AnchorFate::Same, Some(12)));
    }

    #[test]
    fn lines_deleted_above_move_it_up() {
        // Old 3..5 deleted (gap after new line 2).
        assert_eq!(map_line(12, &[hunk(3, 3, 2, 0)]), at(AnchorFate::Moved, Some(9)));
        // A rewrite above that adds lines, and a deletion above too.
        assert_eq!(map_line(20, &[hunk(2, 1, 2, 4), hunk(10, 2, 13, 0)]), at(AnchorFate::Moved, Some(21)));
        // Insertions and deletions that cancel out: the same number.
        assert_eq!(map_line(20, &[hunk(2, 0, 3, 2), hunk(10, 2, 11, 0)]), at(AnchorFate::Same, Some(20)));
    }

    #[test]
    fn an_edit_on_the_line_is_a_change_placed_at_the_new_code() {
        assert_eq!(map_line(12, &[hunk(12, 1, 12, 1)]), at(AnchorFate::Changed, Some(12)));
        // Inside a rewritten block, after other moves.
        assert_eq!(map_line(12, &[hunk(1, 0, 2, 2), hunk(10, 5, 12, 2)]), at(AnchorFate::Changed, Some(12)));
        // The block's first and last line are in it.
        assert_eq!(map_line(10, &[hunk(10, 5, 10, 1)]).fate, AnchorFate::Changed);
        assert_eq!(map_line(14, &[hunk(10, 5, 10, 1)]).fate, AnchorFate::Changed);
        assert_eq!(map_line(15, &[hunk(10, 5, 10, 1)]), at(AnchorFate::Moved, Some(11)));
    }

    #[test]
    fn a_deleted_line_is_removed_placed_before_the_gap() {
        assert_eq!(map_line(12, &[hunk(11, 3, 10, 0)]), at(AnchorFate::Removed, Some(10)));
        // Deleted at the very top: nothing before it.
        assert_eq!(map_line(1, &[hunk(1, 2, 0, 0)]), at(AnchorFate::Removed, None));
    }

    #[test]
    fn unsorted_hunks_map_the_same() {
        let hunks = [hunk(40, 1, 41, 1), hunk(2, 0, 3, 1)];
        assert_eq!(map_line(20, &hunks), at(AnchorFate::Moved, Some(21)));
    }

    #[test]
    fn a_renamed_or_removed_file_is_placed_by_what_happened_to_it() {
        let mut files = HashMap::new();
        files.insert("old.rs".to_string(), FileNow { path: Some("new.rs".into()), hunks: vec![hunk(1, 0, 2, 1)], unread: false });
        files.insert("gone.rs".to_string(), FileNow { path: None, hunks: vec![], unread: false });
        assert_eq!(place("old.rs", 5, &files), ("new.rs".to_string(), at(AnchorFate::Moved, Some(6))));
        assert_eq!(place("gone.rs", 5, &files), ("gone.rs".to_string(), at(AnchorFate::FileRemoved, None)));
        assert_eq!(place("same.rs", 5, &files), ("same.rs".to_string(), at(AnchorFate::Same, Some(5))));
        // A pure rename keeps the line under the new name.
        files.insert("a.rs".to_string(), FileNow { path: Some("b.rs".into()), hunks: vec![], unread: false });
        assert_eq!(place("a.rs", 7, &files), ("b.rs".to_string(), at(AnchorFate::Same, Some(7))));
    }

    #[test]
    fn a_reviewers_path_is_read_as_git_names_it() {
        assert_eq!(repo_path("./src/a.rs"), "src/a.rs");
        assert_eq!(repo_path("src\\ui\\a.ts"), "src/ui/a.ts");
        assert_eq!(repo_path(" a.rs "), "a.rs");
    }

    #[test]
    fn name_status_reads_renames_with_two_paths() {
        let out = "M\0src/a.rs\0R087\0old name.rs\0new name.rs\0D\0gone.rs\0A\0fresh.rs\0";
        assert_eq!(
            parse_name_status_z(out),
            vec![
                ('M', "src/a.rs".into(), None),
                ('R', "old name.rs".into(), Some("new name.rs".into())),
                ('D', "gone.rs".into(), None),
                ('A', "fresh.rs".into(), None),
            ]
        );
    }

    fn finding(id: &str, severity: &str, path: Option<&str>, line: Option<u32>, revision: Option<&str>) -> LedgerFinding {
        LedgerFinding {
            id: id.into(),
            severity: Some(severity.into()),
            title: format!("Title {id}"),
            body: format!("Body {id}"),
            round: 1,
            updated_round: 1,
            path: path.map(str::to_string),
            line,
            reviewed_revision: revision.map(str::to_string),
            ..LedgerFinding::default()
        }
    }

    #[test]
    fn only_findings_with_a_line_are_anchors_and_unknown_without_a_revision() {
        let mut old = finding("F4", "P2", None, None, None);
        old.location = Some("src/old.rs:8".into());
        let findings = vec![
            finding("F1", "P1", Some("src/a.rs"), Some(10), Some("rev1")),
            finding("F2", "P2", Some("src/a.rs"), None, Some("rev1")),
            finding("F3", "P3", None, None, None),
            old,
        ];
        let mut asked = Vec::new();
        let anchors = anchors_with(&findings, |revision, paths| {
            asked.push((revision.to_string(), paths.to_vec()));
            let mut files = HashMap::new();
            files.insert("src/a.rs".to_string(), FileNow { path: Some("src/a.rs".into()), hunks: vec![hunk(1, 0, 2, 3)], unread: false });
            Ok(files)
        });
        assert_eq!(asked, vec![("rev1".to_string(), vec!["src/a.rs".to_string()])], "only files with findings are read");
        assert_eq!(anchors.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["F1", "F4"]);
        assert_eq!((anchors[0].fate, anchors[0].line, anchors[0].reviewed_line), (AnchorFate::Moved, Some(13), 10));
        assert!(!anchors[0].non_blocking);
        assert_eq!((anchors[1].fate, anchors[1].line, anchors[1].path.as_str()), (AnchorFate::Unknown, None, "src/old.rs"));
    }

    /// Tier 4 walk 2026-10-14: a dismissed finding's anchor says so, with
    /// who dismissed it and why, as the findings list does.
    #[test]
    fn a_dismissed_finding_carries_its_dismissal() {
        let mut gone = finding("F1", "P2", Some("a.rs"), Some(1), Some("rev1"));
        gone.dismissal = Some(crate::review_ledger::Dismissal {
            reason: Some("walk test".into()),
            by: Some("ana@example.com".into()),
            at: 5,
            round: 2,
        });
        let kept = finding("F2", "P2", Some("a.rs"), Some(1), Some("rev1"));
        let anchors = anchors_with(&[gone, kept], |_, _| Ok(HashMap::new()));
        assert!(anchors[0].dismissed && anchors[0].non_blocking);
        assert_eq!(anchors[0].dismissal.as_ref().and_then(|d| d.by.as_deref()), Some("ana@example.com"));
        let json = serde_json::to_value(&anchors[0]).unwrap();
        assert_eq!(json["dismissal"]["reason"], "walk test");
        assert!(anchors[1].dismissal.is_none());
        assert!(serde_json::to_value(&anchors[1]).unwrap().get("dismissal").is_none());
    }

    #[test]
    fn a_revision_git_cannot_read_is_unknown_and_the_cap_holds() {
        let findings: Vec<LedgerFinding> = (0..20)
            .map(|i| {
                let mut f = finding(&format!("F{i}"), "P3", Some("a.rs"), Some(1), Some(&format!("rev{i}")));
                f.updated_round = i;
                f
            })
            .collect();
        let mut reads = 0;
        let anchors = anchors_with(&findings, |revision, _| {
            reads += 1;
            if revision == "rev19" { Err("bad object".into()) } else { Ok(HashMap::new()) }
        });
        assert_eq!(reads, MAX_REVISIONS);
        assert_eq!(anchors[19].fate, AnchorFate::Unknown, "git could not read it");
        assert_eq!(anchors[18].fate, AnchorFate::Same, "a recent revision is read");
        assert_eq!(anchors[0].fate, AnchorFate::Unknown, "past the cap, the oldest are not read");
        assert!(anchors[0].non_blocking);
    }

    fn git(repo: &Path, args: &[&str]) -> String {
        let out = crate::platform::git_command().args(args).current_dir(repo).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn numbered(from: u32, to: u32) -> String {
        (from..=to).map(|n| format!("line {n}\n")).collect()
    }

    /// The real git: a review at one commit, then a fix commit that inserts
    /// lines above one finding, rewrites another's line, renames a file and
    /// removes another.
    #[test]
    fn anchors_follow_a_fix_commit_in_a_real_repository() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-q", "-b", "card"]);
        git(repo, &["config", "user.email", "t@t"]);
        git(repo, &["config", "user.name", "t"]);
        git(repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("a.rs"), numbered(1, 30)).unwrap();
        std::fs::write(repo.join("old name.rs"), numbered(1, 40)).unwrap();
        std::fs::write(repo.join("gone.rs"), numbered(1, 5)).unwrap();
        std::fs::write(repo.join("calm.rs"), numbered(1, 5)).unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-qm", "build"]);
        let reviewed = git(repo, &["rev-parse", "HEAD"]);
        // The fix: two lines above line 20 of a.rs, line 25 rewritten.
        let mut a = String::from("new top 1\nnew top 2\n");
        a.push_str(&numbered(1, 24));
        a.push_str("line 25 fixed\n");
        a.push_str(&numbered(26, 30));
        std::fs::write(repo.join("a.rs"), a).unwrap();
        git(repo, &["mv", "old name.rs", "new name.rs"]);
        git(repo, &["rm", "-q", "gone.rs"]);
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-qm", "fix"]);
        let mut ledger = CardLedger::new("w", "c");
        ledger.findings = vec![
            finding("F1", "P1", Some("a.rs"), Some(20), Some(&reviewed)),
            finding("F2", "P2", Some("a.rs"), Some(25), Some(&reviewed)),
            finding("F3", "P2", Some("old name.rs"), Some(7), Some(&reviewed)),
            finding("F4", "P3", Some("gone.rs"), Some(2), Some(&reviewed)),
            finding("F5", "P2", Some("calm.rs"), Some(3), Some(&reviewed)),
            finding("F6", "P2", Some("a.rs"), Some(3), Some("0000000000000000000000000000000000000000")),
        ];
        let anchors = anchors(repo, "card", Some(&ledger));
        let got: Vec<(&str, &str, Option<u32>, AnchorFate)> =
            anchors.iter().map(|a| (a.id.as_str(), a.path.as_str(), a.line, a.fate)).collect();
        assert_eq!(
            got,
            vec![
                ("F1", "a.rs", Some(22), AnchorFate::Moved),
                ("F2", "a.rs", Some(27), AnchorFate::Changed),
                ("F3", "new name.rs", Some(7), AnchorFate::Same),
                ("F4", "gone.rs", None, AnchorFate::FileRemoved),
                ("F5", "calm.rs", Some(3), AnchorFate::Same),
                ("F6", "a.rs", None, AnchorFate::Unknown),
            ]
        );
        // At the reviewed revision itself, nothing moved.
        let here = super::anchors(repo, &reviewed, Some(&ledger));
        assert_eq!(here[0].fate, AnchorFate::Same);
        assert!(super::anchors(repo, "card", None).is_empty());
        // A branch that is not there: every anchor is not known.
        let lost = super::anchors(repo, "no-such-branch", Some(&ledger));
        assert!(lost.iter().all(|a| a.fate == AnchorFate::Unknown));
    }

    /// CL-6 round 2 (Challenger F1): a non-ASCII path and one with a space
    /// are read through their diff, not taken as unchanged; a file git said
    /// changed whose diff was not read is not known, never "same".
    #[test]
    fn unicode_and_spaced_paths_are_mapped_and_an_unread_diff_is_not_known() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-q", "-b", "card"]);
        git(repo, &["config", "user.email", "t@t"]);
        git(repo, &["config", "user.name", "t"]);
        git(repo, &["config", "commit.gpgsign", "false"]);
        std::fs::create_dir_all(repo.join("src/città")).unwrap();
        std::fs::write(repo.join("src/città/café.rs"), numbered(1, 20)).unwrap();
        std::fs::write(repo.join("with space.rs"), numbered(1, 20)).unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-qm", "build"]);
        let reviewed = git(repo, &["rev-parse", "HEAD"]);
        for name in ["src/città/café.rs", "with space.rs"] {
            let mut text = String::from("added 1\nadded 2\nadded 3\n");
            text.push_str(&numbered(1, 20));
            std::fs::write(repo.join(name), text).unwrap();
        }
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-qm", "fix"]);
        let mut ledger = CardLedger::new("w", "c");
        ledger.findings = vec![
            finding("F1", "P2", Some("src/città/café.rs"), Some(10), Some(&reviewed)),
            finding("F2", "P2", Some("with space.rs"), Some(10), Some(&reviewed)),
        ];
        let got: Vec<(String, Option<u32>, AnchorFate)> =
            super::anchors(repo, "card", Some(&ledger)).into_iter().map(|a| (a.path, a.line, a.fate)).collect();
        assert_eq!(
            got,
            vec![
                ("src/città/café.rs".to_string(), Some(13), AnchorFate::Moved),
                ("with space.rs".to_string(), Some(13), AnchorFate::Moved),
            ]
        );
        // The paths the review diff draws are the same, unquoted.
        let files = crate::git::diff_hunks(repo, &reviewed, "card").unwrap();
        let mut paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["src/città/café.rs", "with space.rs"]);
        // Unread: changed per git, no diff read.
        let mut unread = HashMap::new();
        unread.insert("a.rs".to_string(), FileNow { path: Some("a.rs".into()), hunks: vec![], unread: true });
        assert_eq!(place("a.rs", 4, &unread), ("a.rs".to_string(), at(AnchorFate::Unknown, None)));
    }
}
