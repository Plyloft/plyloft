//! 1.174.0 X1 (CH-8): the three largest files stop growing. Each has a
//! ceiling, its line count at the end of 1.174.0; a change that makes one
//! longer fails here. New work goes to its own module instead (as
//! `card_pr_commands.rs`, `next_improvement.rs`, `deploy_map.rs` and
//! `card_area.rs` did for `commands.rs`), or something else of the file
//! moves out first. The ratchet only goes down: when a file gets shorter,
//! lower its ceiling to the new count in the same change.
//!
//! Read from disk like the bounded-`gh` scan (`github.rs`,
//! `no_gh_is_spawned_without_a_bound`), so the counts are the files' own.

use std::path::Path;

/// (path from the repository root, ceiling in lines).
const CEILINGS: &[(&str, usize)] = &[
    // 1.175.0 (G3): 26397 lines once lane 4 moved its commands out, plus a
    // margin for a line or two of wiring in a fix; the rule is in
    // `docs/PATTERNS.md` ("New commands live in their own module").
    // 1.176.0 R5: the Codex updater moved to `codex_auto_update.rs` (26039
    // lines then), with the same margin for a line or two of wiring.
    // 1.176.2: 26025 lines after the fixes of this block; the ceiling comes
    // down with the file, with the same margin.
    // 1.176.3: 26019 after the verdict comment's post moved to
    // `verdict_comment.rs`; the same margin.
    ("src-tauri/src/commands.rs", 26039),
    // 1.175.0 (F6): the pull request draft's wrappers moved to src/lib/prDraftIpc.ts;
    // the immediacy merge: the old Ply install's to src/lib/legacyInstallIpc.ts.
    // 1.176.0 R3: the PTY spawn's to src/lib/ptySpawnIpc.ts.
    // 1.176.0 R5: the Codex update's (now events) to src/lib/codexUpdateIpc.ts
    // (12274 lines then; a margin for a line or two of wiring).
    ("src/ipc.ts", 12285),
    // 1.175.0 F8, F10: 5059 before; its errors went to `CardTroubles.tsx`,
    // its Change… panel to `CardPickers.tsx`; the immediacy merge: the Now
    // note to `CardNowNote.tsx`, `useCopyChanges` to `hooks/`.
    ("src/components/CardDetailPanel.tsx", 4780),
];

#[test]
fn the_largest_files_do_not_grow_past_their_ceiling() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("the repository root");
    for (path, ceiling) in CEILINGS {
        let source = std::fs::read_to_string(repo.join(path)).unwrap_or_else(|e| panic!("{path}: {e}"));
        let lines = source.lines().count();
        assert!(
            lines <= *ceiling,
            "{path} has {lines} lines, past its ceiling of {ceiling} (1.174.0 X1): put the new work in its own module, or move something out first"
        );
    }
}
