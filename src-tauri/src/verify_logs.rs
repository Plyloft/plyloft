//! Full step logs of a card's last Verify run (GH #62).
//!
//! A step's persisted `reason` is only the end of its output; the complete
//! output lives on disk so "Open full log" can show what the reason cut:
//!
//!   `<config_dir>/projects/<workspace_id>/verify/<card_id>/<verify_run_id>/<step>.log`
//!
//! One run per card: starting a run removes the card's previous run, and
//! removing the card's worktree removes the card's logs. A step script may
//! drop further logs into the run directory through `PLY_VERIFY_LOG_DIR`
//! (`scripts/ppvp.sh` keeps each failing sub-step's complete log there).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Environment variable naming the run directory to a step's process.
pub const LOG_DIR_ENV: &str = "PLY_VERIFY_LOG_DIR";

static PROJECTS_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Set once at launch from the app's config dir.
pub fn init(config_dir: &Path) {
    let _ = PROJECTS_ROOT.set(config_dir.join("projects"));
}

fn root() -> Option<&'static Path> {
    PROJECTS_ROOT.get().map(PathBuf::as_path)
}

/// An id used as one path component: never empty, a separator or a
/// parent reference.
fn component(id: &str) -> Result<&str, String> {
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\', '\0']) {
        return Err(format!("not a valid id: {id:?}"));
    }
    Ok(id)
}

fn card_dir_in(root: &Path, workspace_id: &str, card_id: &str) -> Result<PathBuf, String> {
    Ok(root
        .join(component(workspace_id)?)
        .join("verify")
        .join(component(card_id)?))
}

/// File name of a step's log: the step kind with anything but
/// `[A-Za-z0-9._-]` replaced, so `script:scripts/ppvp.sh` stays one file.
pub fn step_file_name(step_kind: &str) -> String {
    let name: String = step_kind
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    format!("{}.log", name.trim_start_matches('.'))
}

/// Start a run: remove the card's previous run and return this run's
/// directory (created when the first log is written).
pub fn begin_run_in(
    root: &Path,
    workspace_id: &str,
    card_id: &str,
    verify_run_id: &str,
) -> Result<PathBuf, String> {
    let card_dir = card_dir_in(root, workspace_id, card_id)?;
    let run_dir = card_dir.join(component(verify_run_id)?);
    match fs::remove_dir_all(&card_dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("remove previous verify logs: {e}")),
    }
    Ok(run_dir)
}

/// [`begin_run_in`] under the app's config dir. `None` (logged) when the
/// root isn't set or the previous run can't be removed: Verify still runs,
/// only without a full log.
pub fn begin_run(workspace_id: &str, card_id: &str, verify_run_id: &str) -> Option<PathBuf> {
    let root = root()?;
    match begin_run_in(root, workspace_id, card_id, verify_run_id) {
        Ok(dir) => Some(dir),
        Err(e) => {
            log::warn!("verify {verify_run_id}: full step logs disabled: {e}");
            None
        }
    }
}

/// Write one step's complete output into the run directory.
pub fn write_step(run_dir: &Path, step_kind: &str, output: &str) -> Result<PathBuf, String> {
    let path = run_dir.join(step_file_name(step_kind));
    crate::atomic::write_atomic_text(&path, output)?;
    Ok(path)
}

/// Raw bytes of a running step's output, published by [`publish_raw`].
pub fn raw_capture_path(run_dir: &Path, step_kind: &str) -> PathBuf {
    run_dir.join(format!("{}.raw", step_file_name(step_kind)))
}

/// Publish a step's raw capture as its log: ANSI stripped line by line,
/// written to a tempfile and renamed into place; the raw file is removed.
pub fn publish_raw(run_dir: &Path, step_kind: &str, raw: &Path) -> Result<PathBuf, String> {
    use std::io::{BufRead, BufReader, BufWriter, Write};
    let path = run_dir.join(step_file_name(step_kind));
    let tmp = run_dir.join(format!("{}.atelier-tmp", step_file_name(step_kind)));
    let result = (|| -> std::io::Result<()> {
        let mut reader = BufReader::new(fs::File::open(raw)?);
        let mut writer = BufWriter::new(fs::File::create(&tmp)?);
        let mut line = Vec::new();
        while reader.read_until(b'\n', &mut line)? > 0 {
            writer.write_all(crate::verify::strip_ansi(&String::from_utf8_lossy(&line)).as_bytes())?;
            line.clear();
        }
        writer.flush()?;
        drop(writer);
        crate::platform::rename(&tmp, &path)
    })();
    let _ = fs::remove_file(raw);
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("publish step log: {e}"));
    }
    Ok(path)
}

/// Where a step's log is (or was) for one run.
pub fn step_log_path_in(
    root: &Path,
    workspace_id: &str,
    card_id: &str,
    verify_run_id: &str,
    step_kind: &str,
) -> Result<PathBuf, String> {
    Ok(card_dir_in(root, workspace_id, card_id)?
        .join(component(verify_run_id)?)
        .join(step_file_name(step_kind)))
}

pub fn step_log_path(
    workspace_id: &str,
    card_id: &str,
    verify_run_id: &str,
    step_kind: &str,
) -> Result<PathBuf, String> {
    let root = root().ok_or("verify logs are not initialised")?;
    step_log_path_in(root, workspace_id, card_id, verify_run_id, step_kind)
}

pub fn remove_card_in(root: &Path, workspace_id: &str, card_id: &str) -> Result<(), String> {
    let dir = card_dir_in(root, workspace_id, card_id)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove verify logs: {e}")),
    }
}

/// A card's worktree was removed (ship cleanup, archive, put back, branch
/// cleanup, merge, delete, the launch's ship backfill): every such path
/// calls this, and a source test holds every `prune_worktree_at` caller to
/// it (`chat::tests`). Its Verify logs go, and its chat session ends — it
/// reads that folder (`--add-dir`); the history stays and the next message
/// resumes it on what is there then.
pub fn card_worktree_removed(workspace_id: &str, card_id: &str) {
    crate::chat::end_card_session(workspace_id, card_id);
    remove_card(workspace_id, card_id);
}

/// Remove a card's Verify logs (`card_worktree_removed`).
/// Best-effort: a failure is logged, never returned.
pub fn remove_card(workspace_id: &str, card_id: &str) {
    let Some(root) = root() else { return };
    if let Err(e) = remove_card_in(root, workspace_id, card_id) {
        log::warn!("verify logs for {workspace_id}/{card_id}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_file_name_is_one_path_component() {
        assert_eq!(step_file_name("cargo-test"), "cargo-test.log");
        assert_eq!(step_file_name("script:scripts/ppvp.sh"), "script_scripts_ppvp.sh.log");
        assert_eq!(step_file_name("slash:/ppvp (step 2)"), "slash__ppvp__step_2_.log");
        assert_eq!(step_file_name("../x"), "_x.log");
    }

    #[test]
    fn ids_that_escape_the_card_dir_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["", ".", "..", "a/b"] {
            assert!(begin_run_in(tmp.path(), bad, "card", "run").is_err());
            assert!(begin_run_in(tmp.path(), "ws", bad, "run").is_err());
            assert!(step_log_path_in(tmp.path(), "ws", "card", bad, "step").is_err());
        }
    }

    #[test]
    fn a_new_run_replaces_the_previous_runs_logs() {
        let tmp = tempfile::tempdir().unwrap();
        let first = begin_run_in(tmp.path(), "ws", "card", "verify-1").unwrap();
        let first_log = write_step(&first, "cargo-test", "first output").unwrap();
        assert_eq!(fs::read_to_string(&first_log).unwrap(), "first output");

        let second = begin_run_in(tmp.path(), "ws", "card", "verify-2").unwrap();
        assert!(!first.exists(), "the previous run is removed when the next starts");
        let second_log = write_step(&second, "cargo-test", "second output").unwrap();
        assert_eq!(
            second_log,
            step_log_path_in(tmp.path(), "ws", "card", "verify-2", "cargo-test").unwrap()
        );
        assert_eq!(fs::read_to_string(&second_log).unwrap(), "second output");
    }

    #[test]
    fn other_cards_keep_their_logs_and_removal_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let a = begin_run_in(tmp.path(), "ws", "card-a", "verify-1").unwrap();
        let b = begin_run_in(tmp.path(), "ws", "card-b", "verify-1").unwrap();
        write_step(&a, "s", "a").unwrap();
        let b_log = write_step(&b, "s", "b").unwrap();

        begin_run_in(tmp.path(), "ws", "card-a", "verify-2").unwrap();
        assert!(b_log.exists());

        remove_card_in(tmp.path(), "ws", "card-b").unwrap();
        assert!(!b_log.exists());
        remove_card_in(tmp.path(), "ws", "card-b").unwrap();
    }
}
