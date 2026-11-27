//! R8 (owner, 2026-10-26): the messages of the commits Plyloft makes itself,
//! in the Conventional Commits form a project's `commit-msg` hook
//! (commitlint and the like) expects — and the readers that recognise them
//! again, in the new form and in the one before it.
//!
//! - Land: `feat: <card title>` (was `Land card: <card title>`)
//! - Release: `chore(release): vX.Y.Z`, the cards' titles in the body, one
//!   `Card:` trailer per card (was `vX.Y.Z: <title>`)
//! - Build snapshot: `chore: snapshot N for <card title>` (was `build: …`)
//! - Work in progress and recovery commits: `chore: …`, meaning as before.
//!
//! Subjects keep to what `@commitlint/config-conventional` accepts: at most
//! [`MAX_HEADER`] characters, no full stop at the end, and a description
//! that doesn't start with a capital (`subject-case`) — a card titled
//! "Add a tagline" lands as `feat: add a tagline`. A first word that is an
//! acronym or a name with capitals inside it ("API", "GitHub") is kept.

/// commitlint's `header-max-length` (and `body-max-line-length`).
pub const MAX_HEADER: usize = 100;

/// The pre-R8 Land subject's start.
const LEGACY_LAND_PREFIX: &str = "Land card: ";

/// `<kind>: <text>`, with `text` made to fit the rules above.
fn header(kind: &str, text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = lower_first(text.trim_end_matches('.'));
    fit(&format!("{kind}: {text}"), MAX_HEADER)
}

/// The first letter lowered when the first word reads as an ordinary
/// capitalised word ("Add", "V2"), never an acronym or a name ("API",
/// "GitHub", "iOS"): only a capital after the first letter keeps it.
fn lower_first(text: &str) -> String {
    let first_word = text.split_whitespace().next().unwrap_or("");
    let mut chars = first_word.chars();
    let Some(first) = chars.next() else { return text.to_string() };
    let ordinary = first.is_uppercase() && !chars.any(|c| c.is_uppercase());
    if !ordinary {
        return text.to_string();
    }
    let mut out: String = first.to_lowercase().collect();
    out.push_str(&text[first.len_utf8()..]);
    out
}

/// `line` cut to `max` characters, the cut marked with "…".
fn fit(line: &str, max: usize) -> String {
    if line.chars().count() <= max {
        return line.to_string();
    }
    let mut cut: String = line.chars().take(max - 1).collect();
    cut = cut.trim_end().to_string();
    cut.push('…');
    cut
}

/// The Conventional Commits types commitlint's conventional config knows.
const TYPES: [&str; 11] =
    ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];

/// `title`'s own type prefix (`fix: `, `feat(ui)!: `), if it starts with one.
fn own_type(title: &str) -> Option<(&str, &str)> {
    let (head, rest) = title.split_once(": ")?;
    let kind = head.trim_end_matches('!');
    let kind = match kind.split_once('(') {
        Some((k, scope)) if scope.ends_with(')') && scope.len() > 1 => k,
        Some(_) => return None,
        None => kind,
    };
    TYPES.contains(&kind.to_ascii_lowercase().as_str()).then_some((head, rest))
}

/// The subject of a card's Land commit: `feat: <title>`; a title that
/// already starts with a type ("fix: footer") keeps it; an empty title is
/// `feat: card <short id>`.
pub fn land_subject(title: &str, card_id: &str) -> String {
    let title = one_line(title);
    if title.trim_end_matches('.').is_empty() {
        let short: String = card_id.chars().take(8).collect();
        return header("feat", &format!("card {short}"));
    }
    match own_type(&title) {
        Some((head, rest)) => header(&head.to_ascii_lowercase(), rest),
        None => header("feat", &title),
    }
}

/// Whether `subject` is the Land commit of the card `card_id` titled
/// `title`, in either form. It reads the subject only: a commit written by
/// hand as `feat: <title>` reads as the Land too (the backfill then stamps
/// the card at it — the card's title is the evidence it has).
pub fn is_land_subject(subject: &str, title: &str, card_id: &str) -> bool {
    subject == land_subject(title, card_id) || subject == format!("{LEGACY_LAND_PREFIX}{title}")
}

/// The subject of a release commit (tests: the tag-free form 1.172 wrote).
#[cfg(test)]
pub fn release_subject(version: &str) -> String {
    release_tag_subject(&format!("v{version}"))
}

/// 1.173.0 (B4): the subject of a release commit by its tag — an area's
/// `chore(release): site-v1.0.1`; without areas the same as
/// [`release_subject`].
pub fn release_tag_subject(tag: &str) -> String {
    fit(&format!("chore(release): {tag}"), MAX_HEADER)
}

/// The body of a release commit: one line per card title.
pub fn release_body(titles: &[String]) -> String {
    titles
        .iter()
        .map(|t| fit(&format!("- {}", t.split_whitespace().collect::<Vec<_>>().join(" ")), MAX_HEADER))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The subject of a Builder's build snapshot `n`.
pub fn snapshot_subject(n: u32, title: &str) -> String {
    fit(&format!("chore: snapshot {n} for {}", one_line(title)), MAX_HEADER)
}

/// The snapshot that commits the merge Plyloft started for a ship conflict.
pub fn snapshot_merge_subject(n: u32, title: &str, branch: &str, short_sha: &str) -> String {
    // The merge's own words go first, so a cut takes the title's end.
    let tail = format!(" (merges {branch} at {short_sha})");
    let head = fit(
        &format!("chore: snapshot {n} for {}", one_line(title)),
        MAX_HEADER.saturating_sub(tail.chars().count()).max(20),
    );
    format!("{head}{tail}")
}

/// The commit Ship makes of a card's uncommitted edits (no Builder) before
/// it merges the card's branch.
pub fn wip_subject(title: &str) -> String {
    fit(&format!("chore: work in progress on {}", one_line(title)), MAX_HEADER)
}

/// A build set aside by Build with both: what was left in its copy.
pub fn set_aside_subject(vendor: &str, title: &str) -> String {
    fit(&format!("chore: set aside the {vendor} build of {}", one_line(title)), MAX_HEADER)
}

/// Build with both: a vendor's finished build, committed in its copy.
pub fn vendor_build_subject(vendor: &str, title: &str) -> String {
    fit(&format!("chore: {vendor} build of {}", one_line(title)), MAX_HEADER)
}

/// R8 Challenger M2: a line of a shared-config commit — the first is its
/// subject — `chore(config): <field> — <old> → <new>` (was `config: …`;
/// nothing reads either form back: the history readers go by path).
pub fn config_line(text: &str) -> String {
    format!("chore(config): {}", lower_first(&one_line(text)))
}

/// R8 Challenger minor: a shared-config commit's message from its lines —
/// the first is the subject, fitted to [`MAX_HEADER`]; when it had to be
/// cut, every line follows in full in the body, so nothing is lost.
pub fn config_message(lines: &[String]) -> String {
    let Some(first) = lines.first() else { return String::new() };
    let subject = fit(first, MAX_HEADER);
    let mut message = if subject == *first {
        lines.join("\n")
    } else {
        format!("{subject}\n\n{}", lines.join("\n"))
    };
    message.push('\n');
    message
}

/// F2: the areas the library commits named in their subject before
/// (`skills: share "x" with the team`, `team: add alice as a member`,
/// `knowledge: …`); the scope says it now.
const LEGACY_LIBRARY_AREAS: [&str; 3] = ["skills: ", "team: ", "knowledge: "];

/// F2: the message of a commit in a library repository Plyloft owns (My
/// library, the team library, a team proposal): `chore(library): <text>`,
/// `text` without its old area prefix; a text with its own type keeps it.
/// When the subject had to be cut, the text follows in full in the body.
/// Nothing reads these subjects back: the library readers go by path.
pub fn library_message(text: &str) -> String {
    let text = one_line(text);
    let subject = match own_type(&text) {
        Some((head, rest)) => header(&head.to_ascii_lowercase(), rest),
        None => {
            let rest = LEGACY_LIBRARY_AREAS
                .iter()
                .find_map(|area| text.strip_prefix(area))
                .unwrap_or(&text);
            let rest = if rest.trim_end_matches('.').trim().is_empty() { "update" } else { rest };
            header("chore(library)", rest)
        }
    };
    if subject.ends_with('…') {
        format!("{subject}\n\n{text}")
    } else {
        subject
    }
}

/// The first commit of a project Plyloft sets up.
pub const FIRST_COMMIT: &str = "chore: first commit";

/// 1.171.0 D3: the commit "Save my current work first" makes of a folder's
/// changes when it is added (`project_setup::save_work`). The sheet shows it
/// (`SAVE_WORK_COMMIT` in `src/lib/firstProject.ts`).
pub const SAVE_WORK: &str = "chore: save work before adding to Plyloft";

/// 1.173.0 (B3): the commit *Leave those out* makes of the files a card
/// changed outside its area, put back as they were.
pub fn leave_out_subject(area: &str) -> String {
    header("chore", &format!("leave out files outside {}", one_line(area)))
}

/// What was left in a card's copy when the card was set aside.
pub fn kept_subject(title: &str) -> String {
    fit(&format!("chore: kept when “{}” was set aside", one_line(title)), MAX_HEADER)
}

/// Subject of the commit that flushes a swarm's uncommitted edits onto its
/// card branch (review diff, local land, a Ship of verified edits).
pub const REVIEW_CHECKPOINT: &str = "chore: review checkpoint — flush uncommitted swarm edits";

/// Subject of the commit Ship makes from uncommitted edits Verify has not
/// passed on, on a card with no Builder (an interrupted or crashed run).
pub const SHIP_RECOVERY: &str = "chore: ship recovery — commit uncommitted edits for Verify";
const LEGACY_SHIP_RECOVERY: &str = "Ship recovery — commit uncommitted edits for Verify";

/// Whether `subject` is a Ship recovery commit's, in either form.
pub fn is_ship_recovery(subject: &str) -> bool {
    subject == SHIP_RECOVERY || subject == LEGACY_SHIP_RECOVERY
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn land_is_feat_with_the_title_in_commitlints_case() {
        let land = |t: &str| land_subject(t, "abcdef0123456789");
        assert_eq!(land("Add a tagline"), "feat: add a tagline");
        assert_eq!(land("GitHub sign-in."), "feat: GitHub sign-in");
        assert_eq!(land("API keys"), "feat: API keys");
        assert_eq!(land("fix the  footer\n"), "feat: fix the footer");
        // Challenger MINOR 5: a digit is no exemption; only an inner capital.
        assert_eq!(land("V2 export"), "feat: v2 export");
        assert_eq!(land("H3b layout"), "feat: h3b layout");
        // A title with its own type keeps it.
        assert_eq!(land("fix: footer"), "fix: footer");
        assert_eq!(land("Fix(ui): The footer."), "fix(ui): the footer");
        assert_eq!(land("docs!: Drop v1"), "docs!: drop v1");
        assert_eq!(land("Note: this"), "feat: note: this");
        // An empty title names the card.
        assert_eq!(land(""), "feat: card abcdef01");
        assert_eq!(land("  . "), "feat: card abcdef01");
        let long = land(&"Word ".repeat(40));
        assert_eq!(long.chars().count(), MAX_HEADER);
        assert!(long.starts_with("feat: word Word") && long.ends_with('…'), "{long}");
    }

    #[test]
    fn a_land_subject_is_read_back_in_both_forms() {
        assert!(is_land_subject("feat: add a tagline", "Add a tagline", "c1"));
        assert!(is_land_subject("Land card: Add a tagline", "Add a tagline", "c1"));
        assert!(!is_land_subject("feat: add a tagline", "Add a footer", "c1"));
        assert!(!is_land_subject("Land card: add a tagline", "Add a tagline", "c1"));
        assert!(is_land_subject("fix: footer", "fix: footer", "c1"));
        assert!(is_land_subject("feat: card c1", "", "c1"));
    }

    #[test]
    fn release_snapshot_and_chores_are_conventional() {
        assert_eq!(release_subject("1.2.3"), "chore(release): v1.2.3");
        assert_eq!(release_tag_subject("v1.2.3"), release_subject("1.2.3"), "no areas: byte for byte");
        assert_eq!(release_tag_subject("site-v1.2.3"), "chore(release): site-v1.2.3");
        assert_eq!(release_body(&["Add a tagline".into(), "Fix it".into()]), "- Add a tagline\n- Fix it");
        assert_eq!(snapshot_subject(3, "Add a tagline"), "chore: snapshot 3 for Add a tagline");
        assert_eq!(
            snapshot_merge_subject(4, "Add a tagline", "main", "abc1234"),
            "chore: snapshot 4 for Add a tagline (merges main at abc1234)"
        );
        let merge = snapshot_merge_subject(4, &"Long ".repeat(40), "main", "abc1234");
        assert!(merge.chars().count() <= MAX_HEADER && merge.ends_with("(merges main at abc1234)"), "{merge}");
        assert_eq!(wip_subject("Add a tagline"), "chore: work in progress on Add a tagline");
        assert_eq!(set_aside_subject("Codex", "X"), "chore: set aside the Codex build of X");
        assert_eq!(kept_subject("X"), "chore: kept when “X” was set aside");
        assert_eq!(vendor_build_subject("Codex", "X"), "chore: Codex build of X");
        assert_eq!(FIRST_COMMIT, "chore: first commit");
        assert_eq!(SAVE_WORK, "chore: save work before adding to Plyloft");
        assert_eq!(config_line("Verify pipeline — none → x"), "chore(config): verify pipeline — none → x");
        // 1.174.0 (DS2 round 1): a quoted row name is left as it is
        // (`repositoryPage.ts::lowerFirst` does the same).
        assert_eq!(
            config_line("“Checks before shipping” — none → x"),
            "chore(config): “Checks before shipping” — none → x"
        );
        assert_eq!(config_line(".gitignore — track"), "chore(config): .gitignore — track");
        assert_eq!(config_line("Name —  a\n b"), "chore(config): name — a b");
        let short = vec!["chore(config): a".to_string(), "chore(config): b".to_string()];
        assert_eq!(config_message(&short), "chore(config): a\nchore(config): b\n");
        let long = vec![format!("chore(config): {}", "x".repeat(120))];
        let msg = config_message(&long);
        let subject = msg.lines().next().unwrap();
        assert!(subject.chars().count() == MAX_HEADER && subject.ends_with('…'), "{subject}");
        assert!(msg.ends_with(&format!("\n\n{}\n", long[0])), "{msg}");
        for s in [REVIEW_CHECKPOINT, SHIP_RECOVERY] {
            assert!(s.starts_with("chore: ") && s.chars().count() <= MAX_HEADER);
        }
    }

    #[test]
    fn library_commits_are_chore_library() {
        assert_eq!(library_message("create My library"), "chore(library): create My library");
        assert_eq!(library_message("Add review from MacBook"), "chore(library): add review from MacBook");
        assert_eq!(
            library_message("skills: share \"ship-a-card\" with the team"),
            "chore(library): share \"ship-a-card\" with the team"
        );
        assert_eq!(library_message("team: add alice as a member"), "chore(library): add alice as a member");
        assert_eq!(library_message("team: Acme manifest and empty library"), "chore(library): acme manifest and empty library");
        assert_eq!(
            library_message("knowledge: move \"Auth flow\" out of the team library."),
            "chore(library): move \"Auth flow\" out of the team library"
        );
        assert_eq!(library_message("fix(skills): keep x"), "fix(skills): keep x");
        assert_eq!(library_message("chore(library): already"), "chore(library): already");
        assert_eq!(library_message("  "), "chore(library): update");
        let long = format!("skills: share \"{}\" with the team", "x".repeat(120));
        let msg = library_message(&long);
        let (subject, body) = msg.split_once("\n\n").expect("the full text in the body");
        assert!(subject.starts_with("chore(library): share") && subject.chars().count() == MAX_HEADER, "{subject}");
        assert_eq!(body, long);
    }

    #[test]
    fn a_recovery_commit_is_read_back_in_both_forms() {
        assert!(is_ship_recovery(SHIP_RECOVERY));
        assert!(is_ship_recovery("Ship recovery — commit uncommitted edits for Verify"));
        assert!(!is_ship_recovery(REVIEW_CHECKPOINT));
    }

    /// 1.171.0 D3: the sheet names the commit the save makes, word for word.
    #[test]
    fn the_save_work_sheet_names_the_same_commit() {
        let ts = include_str!("../../src/lib/firstProject.ts");
        assert!(
            ts.contains(&format!("export const SAVE_WORK_COMMIT = \"{SAVE_WORK}\";")),
            "SAVE_WORK_COMMIT in firstProject.ts drifted from commit_message::SAVE_WORK"
        );
    }
}
