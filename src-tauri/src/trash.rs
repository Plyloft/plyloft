//! The macOS Trash (GH #102).
//!
//! `Move the local copy to Trash` is the destructive way out of GH #88's
//! fast-forward refusal, and PATTERNS.md §4 fixes what destructive means here:
//! "A destructive way out moves things to the Trash, never deletes." So this
//! module only ever calls `NSFileManager -trashItemAtURL:resultingItemURL:`,
//! the same move Finder makes — the file lands in the Trash, keeps its
//! "Put Back" origin and can be recovered. There is no `remove_file` in here,
//! and no code path that falls back to one.
//!
//! No new dependency: the bindings come from `objc2-foundation`, already a
//! dependency for `app_nap.rs`, with its `NSFileManager`, `NSURL` and
//! `NSError` features switched on.

use crate::worktrees::TrashRefusal;
use std::path::{Path, PathBuf};

/// The one message [`trash_item`] answers when the Trash cannot be reached at
/// all. The tests skip on exactly this and on nothing else, so a Trash that
/// refuses a file for any other reason is a red test and not a quiet pass.
#[cfg(not(windows))]
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub const NO_TRASH_HERE: &str = "Plyloft only moves files to the Trash on macOS";
/// A volume with no Recycle Bin (a network share, a removable drive): Ply
/// refuses rather than let the shell delete for good.
#[cfg(windows)]
pub const NO_TRASH_HERE: &str = NO_RECYCLE_BIN_WORDS;

/// What the member's platform calls the place, for the words Ply answers in.
#[cfg(not(windows))]
pub const BIN: &str = "the Trash";
#[cfg(windows)]
pub const BIN: &str = "the Recycle Bin";

/// Move every path to the macOS Trash, answering where each one landed.
///
/// It **tries** to be all or nothing (BOARDS.md §5: "a failure to trash changes
/// nothing and says so"): every path is checked before the first move, and a
/// move that fails part way puts back whatever already went, from the URL the
/// Trash reported, so the file returns to the name it had.
///
/// It cannot always be (GH #102 review 1). A place taken since the move is not
/// overwritten — that would destroy whatever is there now — so that copy stays
/// in the Trash, and a rename can fail on its own. Those two facts are
/// different and come back as different values, because the block has to say
/// which is true: the error is a `TrashRefusal`, and every path whose copy is
/// still in the Trash is named in `stuck_in_trash`. Empty means the disk is
/// exactly as it was.
pub fn trash_all(paths: &[PathBuf]) -> Result<Vec<PathBuf>, TrashRefusal> {
    if paths.is_empty() {
        return Err(format!("nothing to move to {BIN}").into());
    }
    for path in paths {
        if std::fs::symlink_metadata(path).is_err() {
            return Err(format!(
                "{} isn't there any more; nothing was moved to {BIN}",
                path.display()
            )
            .into());
        }
    }
    // (original, where the Trash put it) for the ones already moved.
    let mut moved: Vec<(&PathBuf, PathBuf)> = Vec::new();
    for path in paths {
        match trash_item(path) {
            Ok(landed) => moved.push((path, landed)),
            Err(reason) => {
                let stuck = put_back(&moved);
                let mut refusal = TrashRefusal {
                    reason: format!(
                        "couldn't move {} to {BIN}: {}",
                        path.display(),
                        plain_reason(&reason)
                    ),
                    // The paths the member knows — where the files came from,
                    // not where the Trash keeps them.
                    stuck_in_trash: stuck.iter().map(|p| p.display().to_string()).collect(),
                };
                if stuck.is_empty() {
                    refusal.reason.push_str(". Nothing was moved.");
                } else {
                    refusal.reason.push_str(&format!(
                        ". What had already moved could not be put back, so it is in {BIN}."
                    ));
                }
                return Err(refusal);
            }
        }
    }
    Ok(moved.into_iter().map(|(_, landed)| landed).collect())
}

/// Skills hub H2 (Windows walk): the shell once answered a failed move with
/// no words at all, and the line read "…to the Recycle Bin: . Nothing was
/// moved." A reason is never empty.
pub(crate) fn plain_reason(reason: &str) -> String {
    let reason = reason.trim().trim_end_matches('.').trim();
    if reason.is_empty() {
        "the system gave no reason".to_string()
    } else {
        reason.to_string()
    }
}

/// Skills hub H2 (Windows walk): what a failed Recycle Bin move's HRESULT
/// means, in words, and whether one more try may go through (a file held
/// open for a moment — an antivirus scan or the indexer reading what a pull
/// just wrote). Codes from `winerror.h` (the `windows` crate's
/// `COPYENGINE_E_*`); `message` is the system's own text, often empty for
/// the shell's codes. Pure, so it is tested on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn recycle_failure_words(code: u32, message: &str) -> (String, bool) {
    let message = message.trim().trim_end_matches('.').trim();
    let (plain, retry) = match code {
        // COPYENGINE_E_SHARING_VIOLATION_SRC, ERROR_SHARING_VIOLATION,
        // ERROR_LOCK_VIOLATION.
        0x8027_0027 | 0x8007_0020 | 0x8007_0021 => {
            (Some("a file in it is open in another program"), true)
        }
        // COPYENGINE_E_ACCESS_DENIED_SRC, E_ACCESSDENIED,
        // COPYENGINE_E_ACCESSDENIED_READONLY.
        0x8027_0021 | 0x8007_0005 | 0x8027_003F => {
            (Some("Windows refused access to a file in it"), true)
        }
        // COPYENGINE_E_PATH_TOO_DEEP_SRC, COPYENGINE_E_RECYCLE_PATH_TOO_LONG,
        // ERROR_FILENAME_EXCED_RANGE, COPYENGINE_E_NEWFILE/NEWFOLDER_NAME_TOO_LONG.
        0x8027_001D | 0x8027_0038 | 0x8007_00CE | 0x8027_003B | 0x8027_003C => {
            (Some("a path inside it is too long for the Recycle Bin"), false)
        }
        // COPYENGINE_E_RECYCLE_SIZE_TOO_BIG.
        0x8027_0037 => (Some("it is too big for the Recycle Bin"), false),
        // COPYENGINE_E_RECYCLE_BIN_NOT_FOUND, COPYENGINE_E_RECYCLE_FORCE_NUKE.
        0x8027_003A | 0x8027_0036 => (Some(NO_RECYCLE_BIN_WORDS), false),
        // COPYENGINE_E_USER_CANCELLED, COPYENGINE_E_CANCELLED, E_ABORT.
        0x8027_0000 | 0x8027_0001 | 0x8000_4004 => (Some("the move was cancelled"), false),
        _ => (None, true),
    };
    let words = match (plain, message.is_empty()) {
        (Some(plain), _) => plain.to_string(),
        (None, false) => message.to_string(),
        (None, true) => "Windows gave no reason".to_string(),
    };
    (format!("{words} (error 0x{code:08X})"), retry)
}

/// The words [`recycle_failure_words`] gives a drive whose Recycle Bin the
/// shell can't use; on Windows the same as [`NO_TRASH_HERE`].
const NO_RECYCLE_BIN_WORDS: &str = "this drive has no Recycle Bin";

/// QoL 6.3: Undo of a file the Code tree moved to the bin — `landed` (where
/// [`trash_all`] said it went) back to `original`. Never over something that
/// took the name since: that is refused, and the file stays in the bin.
pub fn restore(original: &Path, landed: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(original).is_ok() {
        return Err(format!(
            "something named {} is there now, so the file stays in {BIN}",
            original.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        ));
    }
    if std::fs::symlink_metadata(landed).is_err() {
        return Err(format!("the file isn't in {BIN} any more"));
    }
    let original = original.to_path_buf();
    if put_back(&[(&original, landed.to_path_buf())]).is_empty() {
        Ok(())
    } else {
        Err(format!("it couldn't be moved back, so it is still in {BIN}"))
    }
}

/// Rename each trashed item back to where it came from, newest first, and
/// answer **the places** that are still empty because their copy stayed in the
/// Trash — the paths the member knows, not the Trash's own.
///
/// A rename would happily overwrite whatever now sits at the original path —
/// a file the member, or a fast-forward, has since written there — so an
/// occupied place is left alone and its copy is reported stuck (GH #102 review
/// 1). Recovering that one is Put Back in Finder (Restore in the Recycle
/// Bin), which asks first.
fn put_back(moved: &[(&PathBuf, PathBuf)]) -> Vec<PathBuf> {
    let mut stuck = Vec::new();
    for (original, landed) in moved.iter().rev() {
        let occupied = std::fs::symlink_metadata(original).is_ok();
        if occupied || std::fs::rename(landed, original).is_err() {
            log::warn!(
                "trash: {} stays in {BIN} at {}",
                original.display(),
                landed.display()
            );
            stuck.push((*original).clone());
        } else {
            #[cfg(windows)]
            forget_recycled(landed);
        }
    }
    stuck
}

/// The Recycle Bin keeps each item as `$R<id>` beside a `$I<id>` record of
/// where it came from. Once the item is renamed back, the record describes
/// nothing, so it goes too; it holds no content of the member's. Only ever
/// inside a `$Recycle.Bin` folder.
#[cfg(windows)]
fn forget_recycled(landed: &Path) {
    let in_bin = landed.parent().is_some_and(|dir| {
        dir.components()
            .any(|c| c.as_os_str().eq_ignore_ascii_case("$Recycle.Bin"))
    });
    let Some(name) = landed.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    if !in_bin {
        return;
    }
    if let Some(id) = name.strip_prefix("$R") {
        let _ = std::fs::remove_file(landed.with_file_name(format!("$I{id}")));
    }
}

/// One item to the Trash, answering where it landed.
#[cfg(target_os = "macos")]
fn trash_item(path: &Path) -> Result<PathBuf, String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let text = path.to_str().ok_or_else(|| "the path isn't UTF-8".to_string())?;
    // Safety: every call is a plain Foundation message on the calling thread;
    // NSFileManager and NSURL are thread-safe for this, and the only pointer
    // handed over is the out-parameter for the resulting URL.
    unsafe {
        let manager = NSFileManager::defaultManager();
        let url = NSURL::fileURLWithPath(&NSString::from_str(text));
        let mut landed: Option<objc2::rc::Retained<NSURL>> = None;
        manager
            .trashItemAtURL_resultingItemURL_error(&url, Some(&mut landed))
            .map_err(|e| e.localizedDescription().to_string())?;
        // The Trash always reports where it put the item; without that answer
        // there is nothing to put back, so say so rather than guess a path.
        let landed = landed.ok_or_else(|| {
            "the Trash didn't say where it put the file".to_string()
        })?;
        let at = landed
            .path()
            .ok_or_else(|| "the Trash reported a place with no path".to_string())?;
        Ok(PathBuf::from(at.to_string()))
    }
}

/// One item to the Recycle Bin, answering where it landed (the bin's own
/// `$R…` name, which `put_back` renames back like the Trash's copy).
#[cfg(windows)]
fn trash_item(path: &Path) -> Result<PathBuf, String> {
    recycle::recycle(path)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn trash_item(_path: &Path) -> Result<PathBuf, String> {
    Err(NO_TRASH_HERE.to_string())
}

/// `IFileOperation`, the move Explorer's Delete makes, with a progress sink:
/// `PostDeleteItem` hands over the item the Recycle Bin created, which is how
/// Ply learns where the file went. `SHFileOperationW` recycles too but never
/// says where, and without that nothing could be put back.
#[cfg(windows)]
mod recycle {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};
    use windows::core::{implement, ComObject, Ref, Result as WinResult, HRESULT, HSTRING, PCWSTR};
    use windows::Win32::Foundation::E_ABORT;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumePathNameW};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, IFileOperationProgressSink, IFileOperationProgressSink_Impl,
        IShellItem, SHCreateItemFromParsingName, SHQueryRecycleBinW, FOFX_RECYCLEONDELETE,
        FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, SHQUERYRBINFO,
        SIGDN_FILESYSPATH,
    };

    /// `DRIVE_FIXED` from GetDriveTypeW.
    const DRIVE_FIXED: u32 = 3;
    /// `TSF_DELETE_RECYCLE_IF_POSSIBLE` in `PreDeleteItem`'s flags: the shell
    /// is about to recycle, not destroy.
    const TSF_DELETE_RECYCLE_IF_POSSIBLE: u32 = 0x80;
    const NOT_RECYCLED: &str =
        "Windows would have deleted it instead of moving it to the Recycle Bin";
    /// How long a second try waits for a file held open a moment to be let go.
    const RETRY_AFTER: std::time::Duration = std::time::Duration::from_millis(1500);

    /// Why one try failed, and whether another may go through (H2 walk).
    struct Failure {
        words: String,
        retry: bool,
    }

    impl Failure {
        /// Final: a veto, a drive with no bin, a path the shell can't take.
        fn final_words(words: impl Into<String>) -> Self {
            Self { words: words.into(), retry: false }
        }
        fn of_code(code: HRESULT, message: &str) -> Self {
            let (words, retry) = super::recycle_failure_words(code.0 as u32, message);
            Self { words, retry }
        }
        fn of_error(error: windows::core::Error) -> Self {
            Self::of_code(error.code(), &error.message())
        }
    }

    /// What the sink saw for the one item: the first answer is kept.
    #[implement(IFileOperationProgressSink)]
    struct Landed(RefCell<Option<Result<PathBuf, Failure>>>);

    impl Landed {
        fn answer(&self, answer: Result<PathBuf, Failure>) {
            let mut slot = self.0.borrow_mut();
            if slot.is_none() {
                *slot = Some(answer);
            }
        }
    }

    impl IFileOperationProgressSink_Impl for Landed_Impl {
        /// A delete that would not recycle is vetoed before it happens:
        /// PATTERNS.md §4, never delete.
        fn PreDeleteItem(&self, flags: u32, _item: Ref<'_, IShellItem>) -> WinResult<()> {
            if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE == 0 {
                self.answer(Err(Failure::final_words(NOT_RECYCLED)));
                return Err(E_ABORT.into());
            }
            Ok(())
        }
        fn PostDeleteItem(
            &self,
            _flags: u32,
            _item: Ref<'_, IShellItem>,
            result: HRESULT,
            created: Ref<'_, IShellItem>,
        ) -> WinResult<()> {
            self.answer(if result.is_err() {
                // H2 walk: the shell's own codes often have no system text;
                // the words then come from the code, never empty.
                Err(Failure::of_code(result, &result.message()))
            } else {
                match created.as_ref() {
                    Some(item) => file_path(item).map_err(Failure::final_words),
                    // No item in the bin: the shell destroyed the file.
                    None => Err(Failure::final_words(NOT_RECYCLED)),
                }
            });
            Ok(())
        }
        fn StartOperations(&self) -> WinResult<()> {
            Ok(())
        }
        fn FinishOperations(&self, _: HRESULT) -> WinResult<()> {
            Ok(())
        }
        fn PreRenameItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR) -> WinResult<()> {
            Ok(())
        }
        fn PostRenameItem(
            &self,
            _: u32,
            _: Ref<'_, IShellItem>,
            _: &PCWSTR,
            _: HRESULT,
            _: Ref<'_, IShellItem>,
        ) -> WinResult<()> {
            Ok(())
        }
        fn PreMoveItem(
            &self,
            _: u32,
            _: Ref<'_, IShellItem>,
            _: Ref<'_, IShellItem>,
            _: &PCWSTR,
        ) -> WinResult<()> {
            Ok(())
        }
        fn PostMoveItem(
            &self,
            _: u32,
            _: Ref<'_, IShellItem>,
            _: Ref<'_, IShellItem>,
            _: &PCWSTR,
            _: HRESULT,
            _: Ref<'_, IShellItem>,
        ) -> WinResult<()> {
            Ok(())
        }
        fn PreCopyItem(
            &self,
            _: u32,
            _: Ref<'_, IShellItem>,
            _: Ref<'_, IShellItem>,
            _: &PCWSTR,
        ) -> WinResult<()> {
            Ok(())
        }
        fn PostCopyItem(
            &self,
            _: u32,
            _: Ref<'_, IShellItem>,
            _: Ref<'_, IShellItem>,
            _: &PCWSTR,
            _: HRESULT,
            _: Ref<'_, IShellItem>,
        ) -> WinResult<()> {
            Ok(())
        }
        fn PreNewItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR) -> WinResult<()> {
            Ok(())
        }
        fn PostNewItem(
            &self,
            _: u32,
            _: Ref<'_, IShellItem>,
            _: &PCWSTR,
            _: &PCWSTR,
            _: u32,
            _: HRESULT,
            _: Ref<'_, IShellItem>,
        ) -> WinResult<()> {
            Ok(())
        }
        fn UpdateProgress(&self, _: u32, _: u32) -> WinResult<()> {
            Ok(())
        }
        fn ResetTimer(&self) -> WinResult<()> {
            Ok(())
        }
        fn PauseTimer(&self) -> WinResult<()> {
            Ok(())
        }
        fn ResumeTimer(&self) -> WinResult<()> {
            Ok(())
        }
    }

    fn file_path(item: &IShellItem) -> Result<PathBuf, String> {
        // SAFETY: the shell allocates the string; it is copied, then freed
        // with the allocator it came from.
        unsafe {
            let raw = item
                .GetDisplayName(SIGDN_FILESYSPATH)
                .map_err(|_| "the Recycle Bin didn't say where it put the file".to_string())?;
            let path = raw.to_string().map_err(|e| e.to_string());
            CoTaskMemFree(Some(raw.0 as *const _));
            path.map(PathBuf::from)
        }
    }

    /// Whether the volume `path` is on keeps a Recycle Bin: a fixed drive
    /// whose bin the shell can answer for. Asked first, so a drive that would
    /// only delete is refused in words and nothing is touched.
    fn has_recycle_bin(path: &Path) -> bool {
        let target = HSTRING::from(path.as_os_str());
        let mut root = [0u16; 261];
        // SAFETY: a NUL-terminated input and a buffer we own, sized for the
        // call; the query writes only the struct handed to it.
        unsafe {
            if GetVolumePathNameW(&target, &mut root).is_err() {
                return false;
            }
            let root = PCWSTR(root.as_ptr());
            if GetDriveTypeW(root) != DRIVE_FIXED {
                return false;
            }
            let mut info = SHQUERYRBINFO {
                cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
                ..Default::default()
            };
            SHQueryRecycleBinW(root, &mut info).is_ok()
        }
    }

    pub fn recycle(path: &Path) -> Result<PathBuf, String> {
        // The shell wants an absolute path without `\\?\`.
        let absolute = std::path::absolute(path).map_err(|e| e.to_string())?;
        let target = dunce::simplified(&absolute).to_path_buf();
        if !has_recycle_bin(&target) {
            return Err(format!("{}, so nothing was deleted", super::NO_TRASH_HERE));
        }
        // IFileOperation is apartment-threaded: it runs on a thread of its
        // own that enters a single-threaded apartment, never on a caller's
        // thread that may already be in the multithreaded one.
        let once = |target: PathBuf| {
            std::thread::spawn(move || {
                // SAFETY: COM is entered and left on this thread only.
                unsafe {
                    CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
                        .ok()
                        .map_err(Failure::of_error)?;
                    let out = run(&HSTRING::from(target.as_os_str()));
                    CoUninitialize();
                    out
                }
            })
            .join()
            .unwrap_or_else(|_| Err(Failure::final_words("the Recycle Bin move stopped unexpectedly")))
        };
        match once(target.clone()) {
            Ok(landed) => Ok(landed),
            // Skills hub H2 (Windows walk): a move right after a pull failed
            // and the same move went through later — a file held open for a
            // moment (an antivirus scan, the indexer). One more try, after a
            // pause, while the folder is still where it was.
            Err(first) if first.retry && std::fs::symlink_metadata(&target).is_ok() => {
                log::info!(
                    "trash: the Recycle Bin refused {} ({}); trying once more",
                    target.display(),
                    first.words
                );
                std::thread::sleep(RETRY_AFTER);
                match once(target.clone()) {
                    Ok(landed) => {
                        log::info!("trash: {} went to the Recycle Bin on the second try", target.display());
                        Ok(landed)
                    }
                    Err(second) => Err(format!("{} (tried twice)", second.words)),
                }
            }
            Err(first) => Err(first.words),
        }
    }

    /// No confirmation and no dialog of any kind: this runs behind a
    /// command, where a modal would wait for nobody. A delete that would not
    /// recycle is vetoed by the sink instead.
    unsafe fn run(target: &HSTRING) -> Result<PathBuf, Failure> {
        let words = Failure::of_error;
        let op: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(words)?;
        op.SetOperationFlags(
            FOFX_RECYCLEONDELETE | FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
        )
        .map_err(words)?;
        let item: IShellItem = SHCreateItemFromParsingName(target, None).map_err(words)?;
        let landed = ComObject::new(Landed(RefCell::new(None)));
        let sink: IFileOperationProgressSink = landed.to_interface();
        op.DeleteItem(&item, &sink).map_err(words)?;
        let performed = op.PerformOperations();
        // The sink's answer first: a veto surfaces as an aborted operation.
        if let Some(answer) = landed.0.borrow_mut().take() {
            return answer;
        }
        performed.map_err(words)?;
        if op.GetAnyOperationsAborted().map_err(words)?.as_bool() {
            return Err(Failure::final_words("the move to the Recycle Bin was cancelled"));
        }
        Err(Failure::final_words("the Recycle Bin didn't say where it put the file"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Removes a path when the test leaves, however it leaves: an assert that
    /// fires mid-test must never leave a file in the owner's Trash
    /// (GH #102 review 1).
    struct Sweep(PathBuf);
    impl Drop for Sweep {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// A path that is not there is refused before anything moves: the check
    /// runs over the whole list first, so one missing file cannot leave the
    /// others in the Trash.
    #[test]
    fn a_missing_path_is_refused_before_anything_moves() {
        let tmp = tempfile::tempdir().unwrap();
        let here = tmp.path().join("here.md");
        std::fs::write(&here, b"mine\n").unwrap();
        let gone = tmp.path().join("gone.md");

        let out = trash_all(&[here.clone(), gone]);
        let refusal = out.expect_err("a missing path is refused");
        assert!(refusal.reason.contains("nothing was moved"), "{refusal:?}");
        assert!(refusal.stuck_in_trash.is_empty(), "and nothing is in the Trash");
        assert!(here.exists(), "the file that was there is untouched");
    }

    /// Skills hub H2 (Windows walk): "…to the Recycle Bin: . Nothing was
    /// moved." A reason is never empty, and a shell code with no system text
    /// still says what it means and which code it was.
    #[test]
    fn a_failed_move_always_says_why() {
        assert_eq!(plain_reason(""), "the system gave no reason");
        assert_eq!(plain_reason("  . "), "the system gave no reason");
        assert_eq!(plain_reason("Access is denied."), "Access is denied");

        let (words, retry) = recycle_failure_words(0x8027_0027, "");
        assert_eq!(words, "a file in it is open in another program (error 0x80270027)");
        assert!(retry, "a file held a moment is worth a second try");
        let (words, retry) = recycle_failure_words(0x8027_0038, "");
        assert!(words.starts_with("a path inside it is too long"), "{words}");
        assert!(!retry);
        let (words, retry) = recycle_failure_words(0x8027_0099, "");
        assert_eq!(words, "Windows gave no reason (error 0x80270099)");
        assert!(retry);
        let (words, _) = recycle_failure_words(0x8007_0057, "The parameter is incorrect.\r\n");
        assert_eq!(words, "The parameter is incorrect (error 0x80070057)");
        let (_, retry) = recycle_failure_words(0x8027_003A, "");
        assert!(!retry, "no Recycle Bin: final");
    }

    /// The codes `recycle_failure_words` names are the `windows` crate's.
    #[cfg(windows)]
    #[test]
    fn the_named_codes_are_the_shells() {
        use windows::Win32::UI::Shell::*;
        for (code, expected) in [
            (COPYENGINE_E_SHARING_VIOLATION_SRC, 0x8027_0027u32),
            (COPYENGINE_E_ACCESS_DENIED_SRC, 0x8027_0021),
            (COPYENGINE_E_ACCESSDENIED_READONLY, 0x8027_003F),
            (COPYENGINE_E_PATH_TOO_DEEP_SRC, 0x8027_001D),
            (COPYENGINE_E_RECYCLE_PATH_TOO_LONG, 0x8027_0038),
            (COPYENGINE_E_NEWFILE_NAME_TOO_LONG, 0x8027_003B),
            (COPYENGINE_E_NEWFOLDER_NAME_TOO_LONG, 0x8027_003C),
            (COPYENGINE_E_RECYCLE_SIZE_TOO_BIG, 0x8027_0037),
            (COPYENGINE_E_RECYCLE_BIN_NOT_FOUND, 0x8027_003A),
            (COPYENGINE_E_RECYCLE_FORCE_NUKE, 0x8027_0036),
            (COPYENGINE_E_USER_CANCELLED, 0x8027_0000),
            (COPYENGINE_E_CANCELLED, 0x8027_0001),
        ] {
            assert_eq!(code.0 as u32, expected);
        }
    }

    #[test]
    fn an_empty_list_is_refused() {
        let refusal = trash_all(&[]).expect_err("an empty list is refused");
        assert!(refusal.stuck_in_trash.is_empty());
    }

    /// The real move, and the recovery that proves it was a move and not a
    /// delete: the file is in the Trash, with its bytes, and `put_back`
    /// returns it. Nothing outside the temporary directory is touched.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_file_goes_to_the_trash_and_can_be_put_back() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("ply-trash-test.md");
        std::fs::write(&path, b"# mine\n").unwrap();

        let landed = match trash_item(&path) {
            Ok(landed) => landed,
            // Only "there is no Trash here" is skipped. Any other refusal is a
            // defect and fails, rather than passing over an untested path.
            Err(reason) if reason.contains(NO_TRASH_HERE) => {
                eprintln!("skipped: {reason}");
                return;
            }
            Err(reason) => panic!("the Trash refused the move: {reason}"),
        };
        let _sweep = Sweep(landed.clone());
        assert!(!path.exists(), "the file left its place");
        assert!(landed.exists(), "and is in the Trash at {}", landed.display());
        assert_eq!(std::fs::read_to_string(&landed).unwrap(), "# mine\n");
        assert!(put_back(&[(&path, landed.clone())]).is_empty(), "nothing stayed behind");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# mine\n");
        assert!(!landed.exists(), "the Trash copy is gone again");
    }

    /// Windows: the file goes to the Recycle Bin and comes back from where
    /// the bin said it put it, and its `$I` record goes with it. A runner
    /// whose drive has no Recycle Bin is skipped, said out loud.
    #[cfg(windows)]
    #[test]
    fn a_file_goes_to_the_recycle_bin_and_can_be_put_back() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("ply-trash-test.md");
        std::fs::write(&path, b"# mine\n").unwrap();

        let landed = match trash_item(&path) {
            Ok(landed) => landed,
            // Only a drive with no Recycle Bin is skipped; any other refusal
            // (a veto that fires on every move included) fails.
            Err(reason) if reason.contains(NO_TRASH_HERE) => {
                assert!(path.exists(), "a refused move leaves the file: {reason}");
                eprintln!("skipped: {reason}");
                return;
            }
            Err(reason) => panic!("the Recycle Bin refused the move: {reason}"),
        };
        let _sweep = Sweep(landed.clone());
        assert!(!path.exists(), "the file left its place");
        assert!(landed.exists(), "and is in the Recycle Bin at {}", landed.display());
        assert_eq!(std::fs::read_to_string(&landed).unwrap(), "# mine\n");
        assert!(put_back(&[(&path, landed.clone())]).is_empty(), "nothing stayed behind");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# mine\n");
        let name = landed.file_name().unwrap().to_string_lossy().into_owned();
        if let Some(id) = name.strip_prefix("$R") {
            assert!(!landed.with_file_name(format!("$I{id}")).exists(), "the record went too");
        }
    }

    /// Outside a `$Recycle.Bin` folder a `$I` name is nobody's record.
    #[cfg(windows)]
    #[test]
    fn only_a_recycle_bin_record_is_forgotten() {
        let tmp = tempfile::tempdir().unwrap();
        let record = tmp.path().join("$Iabc.md");
        std::fs::write(&record, b"mine").unwrap();
        forget_recycled(&tmp.path().join("$Rabc.md"));
        assert!(record.exists());
    }

    /// The rollback never overwrites: a place taken since the move is left
    /// alone and the trashed copy is reported stuck, so the block can say so
    /// instead of claiming nothing changed (GH #102 review 1).
    #[test]
    fn a_place_taken_since_the_move_is_not_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let original = tmp.path().join("SKILL.md");
        let landed = tmp.path().join("pretend-trash-SKILL.md");
        std::fs::write(&original, b"written since\n").unwrap();
        std::fs::write(&landed, b"the trashed copy\n").unwrap();

        let stuck = put_back(&[(&original, landed.clone())]);
        assert_eq!(stuck, vec![original.clone()], "the place it came from is named");
        assert_eq!(
            std::fs::read_to_string(&original).unwrap(),
            "written since\n",
            "what was written since is untouched",
        );
        assert!(landed.exists(), "and the trashed copy is still there to Put Back");
    }
}
