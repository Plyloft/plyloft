//! 1.176.3: a typed mark for the errors that say "the folder is not there",
//! so the window never guesses from English text (or git's translated
//! stderr) whether reading again could help. Shape of the other marks
//! (`cli_fresh.rs`): the prefix, `{}`, a newline, then the plain sentence.
//! Read (and stripped before anything is shown) by `src/lib/backendMarks.ts`.

use std::io;

pub(crate) const PATH_GONE_PREFIX: &str = "PLY_PATH_GONE_V1:";

/// `sentence`, marked as [`PATH_GONE_PREFIX`].
pub(crate) fn marked(sentence: &str) -> String {
    format!("{PATH_GONE_PREFIX}{{}}\n{sentence}")
}

/// An I/O error that reading again cannot change: nothing there, not a
/// folder, or a loop of links. Windows' own codes (3, 267) are read from the
/// OS error, which stays English-independent.
pub(crate) fn io_is_gone(e: &io::Error) -> bool {
    if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) {
        return true;
    }
    match e.raw_os_error() {
        #[cfg(windows)]
        Some(2 | 3 | 267) => true,
        #[cfg(unix)]
        Some(2 | 20 | 40 | 62) => true,
        _ => false,
    }
}

/// `format!("{what}: {e}")`, marked when `e` is a gone folder.
pub(crate) fn io_sentence(what: &str, e: &io::Error) -> String {
    let text = format!("{what}: {e}");
    if io_is_gone(e) {
        marked(&text)
    } else {
        text
    }
}

/// The project-folder errors Rust itself writes (`ship::resolve_workspace_repo_root`
/// and the release scope's workspace lookup), marked. The prefixes are ours,
/// never git's text, so this does not depend on a language.
pub(crate) fn mark_workspace_error(text: String) -> String {
    const OURS: [&str; 3] = ["workspace cwd does not exist", "workspace cwd is not inside a git repo", "workspace not found"];
    if OURS.iter().any(|p| text.starts_with(p)) {
        marked(&text)
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_only_the_project_folder_errors_it_wrote() {
        let m = mark_workspace_error("workspace cwd does not exist: /p".into());
        assert_eq!(m, "PLY_PATH_GONE_V1:{}\nworkspace cwd does not exist: /p");
        assert!(mark_workspace_error("workspace cwd is not inside a git repo: /p (fatal: x)".into()).starts_with(PATH_GONE_PREFIX));
        assert!(mark_workspace_error("workspace not found: ws".into()).starts_with(PATH_GONE_PREFIX));
        assert_eq!(mark_workspace_error("spawn git rev-parse: boom".into()), "spawn git rev-parse: boom");
    }

    #[test]
    fn a_missing_folder_is_gone_a_busy_one_is_not() {
        let missing = std::fs::read_dir("/definitely/not/here/ply").unwrap_err();
        assert!(io_is_gone(&missing));
        assert!(io_sentence("read_dir", &missing).starts_with(PATH_GONE_PREFIX));
        let busy = io::Error::from(io::ErrorKind::TimedOut);
        assert!(!io_is_gone(&busy));
        assert!(!io_sentence("read_dir", &busy).starts_with(PATH_GONE_PREFIX));
    }

    #[cfg(unix)]
    #[test]
    fn a_file_where_a_folder_was_and_a_link_loop_are_gone() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f");
        std::fs::write(&file, "x").unwrap();
        assert!(io_is_gone(&std::fs::read_dir(&file).unwrap_err()));
        let a = dir.path().join("a");
        std::os::unix::fs::symlink(&a, &a).unwrap();
        assert!(io_is_gone(&std::fs::read_dir(&a).unwrap_err()));
    }
}
