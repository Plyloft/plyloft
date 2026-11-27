//! GH #101 (ADR 0005, `docs/ux-language/boards/BOARDS.md` §5) — the instruction
//! files of **this Mac**, for the Instructions page's `On this Mac` section.
//!
//! **Read only, by construction**, and for the same reason
//! [`crate::personal_skills`] is: a file in the member's own CLI folder is
//! theirs. Ply lists it, says how long it is, and shows it in Finder. Nothing
//! here opens a path for writing, creates a directory or removes one —
//! `personal_skills_tests` snapshots the whole home around both readers and
//! compares the bytes.
//!
//! `Open in Code` — the **writable** editor — is deliberately **not** offered:
//! a file Ply must never write is not a file Ply hands to an editor it also
//! saves from. That is the same single fact `openInCode` is on a skill's row
//! (GH #96 review 1's blocker).
//!
//! GH #174: what *is* offered, since GH #142 gave Code a reading view, is the
//! row's `›`, which opens the file **read-only** (place `this-mac`). Its bytes
//! come from [`read_listed_instruction_file`], which reads only a path
//! [`listed_instruction_file`] accepts — the window names a path this module
//! listed, never one it composed.
//!
//! ## The files, and why these
//!
//! Each CLI reads one personal instruction file, and neither reads the other's:
//!
//! - Claude Code reads `~/.claude/CLAUDE.md`;
//! - Codex reads `~/.codex/AGENTS.md`.
//!
//! Nothing is assumed about `~/.agents`: it holds a skills directory both here
//! and in [`crate::personal_skills`], and no measured Codex release reads an
//! `AGENTS.md` from it. A name Ply cannot show a CLI reading is a name Ply does
//! not list.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::platform::THIS_MACHINE;
use crate::team_skills::Vendor;

/// One home-relative instruction file a CLI reads.
pub struct PersonalInstructionRoot {
    pub rel: &'static str,
    pub vendor: Vendor,
}

/// Every personal instruction file either CLI reads, in the order the page
/// lists them.
pub const PERSONAL_INSTRUCTION_FILES: &[PersonalInstructionRoot] = &[
    PersonalInstructionRoot {
        rel: ".claude/CLAUDE.md",
        vendor: Vendor::Claude,
    },
    PersonalInstructionRoot {
        rel: ".codex/AGENTS.md",
        vendor: Vendor::Codex,
    },
];

/// One instruction file of this Mac, as the page's row needs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalInstructionFile {
    /// Home-relative, which is also the row's label: `~/.claude/CLAUDE.md`
    /// without the home, so two Macs' pages read the same.
    pub rel: String,
    /// The absolute path, for `Details` and for `Reveal in Finder`.
    pub path: String,
    /// Which CLI reads it, in words.
    pub cli: String,
    pub lines: usize,
}

/// What the `On this Mac` section shows, and what it could not read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalInstructions {
    pub files: Vec<PersonalInstructionFile>,
    /// A path that is there and is not a plain file Ply may list (a symlink, a
    /// directory, unreadable, not UTF-8). Named rather than hidden: silence
    /// about a file the CLI does read would read as Ply not seeing it.
    pub errors: Vec<String>,
}

/// Read every personal instruction file under `home`.
///
/// Never fails: an absent file is ordinary (a member who never wrote one has
/// neither), and a path Ply will not read is named in `errors` while the rest
/// still list — the rule every other Library reader follows.
pub fn read_personal_instructions(home: &Path) -> PersonalInstructions {
    let mut out = PersonalInstructions::default();
    for root in PERSONAL_INSTRUCTION_FILES {
        let path = crate::project_skills::under(home, root.rel);
        // `symlink_metadata`, so a link is seen as a link rather than followed:
        // the same refusal `personal_skills::child_dirs` makes, for the same
        // reason — a link can point anywhere, and `Reveal in Finder` would then
        // show a file outside the member's CLI folders entirely.
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            out.errors.push(format!(
                "{} is a symlink, so Plyloft does not read it — the same refusal the integration branch's mirror makes.",
                root.rel,
            ));
            continue;
        }
        if !metadata.is_file() {
            out.errors
                .push(format!("{} is not a file, so Plyloft does not read it.", root.rel));
            continue;
        }
        let text = match std::fs::read(&path) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(_) => {
                    out.errors.push(format!(
                        "{} is not UTF-8 text, so Plyloft cannot say what is in it.",
                        root.rel,
                    ));
                    continue;
                }
            },
            Err(error) => {
                out.errors
                    .push(format!("{} could not be read: {error}", root.rel));
                continue;
            }
        };
        out.files.push(PersonalInstructionFile {
            rel: root.rel.to_string(),
            path: path.to_string_lossy().into_owned(),
            cli: root.vendor.label().to_string(),
            lines: text.lines().count(),
        });
    }
    out
}

/// The instruction file `path` names, when it is one Ply lists — otherwise the
/// refusal, in words.
///
/// GH #101: `Details` on a personal instruction file holds the path and
/// `Reveal in Finder`, and Finder is reached by handing a path to `open -R`. A
/// window may only ever name a file Ply itself listed, so the set this accepts
/// is exactly the set [`read_personal_instructions`] walks: one of
/// [`PERSONAL_INSTRUCTION_FILES`] under **this** Mac's home, as a real regular
/// file.
///
/// The shape of [`crate::personal_skills::listed_skill_dir`], and its rules:
///
/// - the path is compared **literally** against `home.join(rel)`, so no other
///   path can arrive at one of them;
/// - a relative path, or one holding `.` or `..`, is refused outright rather
///   than normalised — a guard that judged a normalised path while `open` was
///   handed the original would be a guard about a different string;
/// - a symlink is refused, because followed it could reveal anything on the
///   disk;
/// - anything that is not a regular file, or is not there any more, is refused.
///
/// Read-only, like the rest of this module: no `canonicalize`, which would
/// follow the very links the third rule refuses.
pub fn listed_instruction_file(home: &Path, path: &str) -> Result<PathBuf, String> {
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err("Plyloft only reveals an instruction file it listed, by its full path.".into());
    }
    if path.split('/').any(|piece| piece == "." || piece == "..") {
        return Err("Plyloft only reveals an instruction file it listed, by its full path.".into());
    }
    let listed = PERSONAL_INSTRUCTION_FILES
        .iter()
        .any(|root| target == crate::project_skills::under(home, root.rel));
    if !listed {
        return Err(
            format!("That is not one of {THIS_MACHINE}'s instruction files, so Plyloft will not reveal it."),
        );
    }
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("That file");
    let metadata = std::fs::symlink_metadata(target)
        .map_err(|_| format!("{name} is not on {THIS_MACHINE} any more — refresh the Library."))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "{name} is a symlink, so Plyloft does not read it — the same refusal the \
             integration branch's mirror makes."
        ));
    }
    if !metadata.is_file() {
        return Err(format!("{name} is not a file."));
    }
    Ok(target.to_path_buf())
}

/// GH #174 review 1: the most a personal instruction file may be for Code's
/// reading view. Far above any real `CLAUDE.md` (the board's is 212 lines), and
/// low enough that a file grown by mistake cannot stall the window.
pub const MAX_INSTRUCTION_BYTES: u64 = 1024 * 1024;

/// GH #174: the text of the instruction file `path` names, for the `›` that
/// opens it in Code **read-only** — or the refusal, in words.
///
/// The same gate as `Reveal in Finder`: [`listed_instruction_file`] judges the
/// path first, so the only files this can read are the ones
/// [`read_personal_instructions`] lists, under this Mac's home, as real regular
/// files. Then it reads, and nothing else — a read-only handle, the same UTF-8
/// refusal the listing makes.
///
/// Review 1 (MINOR, TOCTOU): the guard `stat`s the path and the read opens it,
/// and the path can change in between. So the open itself refuses what the
/// guard refused: `O_NOFOLLOW` fails on a symlink swapped in at the last
/// component, `O_NONBLOCK` keeps a FIFO swapped in from blocking the open, and
/// the **opened** handle's metadata must be a regular file. What is read is
/// capped at [`MAX_INSTRUCTION_BYTES`], refused above it rather than cut.
pub fn read_listed_instruction_file(home: &Path, path: &str) -> Result<String, String> {
    let file = listed_instruction_file(home, path)?;
    read_without_following(&file)
}

/// The read behind [`read_listed_instruction_file`], after the guard: refuses at
/// the open what the guard refused at its `stat`, in case the path changed in
/// between. Separate so a test can hand it the swapped-in shapes directly.
fn read_without_following(file: &Path) -> Result<String, String> {
    use std::io::Read;

    let name = file
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("That file")
        .to_string();
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let handle = options.open(file).map_err(|error| {
        #[cfg(unix)]
        let looped = error.raw_os_error() == Some(libc::ELOOP);
        #[cfg(not(unix))]
        let looped = false;
        if looped {
            format!(
                "{name} is a symlink, so Plyloft does not read it — the same refusal the \
                 integration branch's mirror makes."
            )
        } else {
            format!("{name} could not be read: {error}")
        }
    })?;
    let metadata = handle
        .metadata()
        .map_err(|error| format!("{name} could not be read: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{name} is not a file."));
    }
    let mut bytes = Vec::new();
    handle
        .take(MAX_INSTRUCTION_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{name} could not be read: {error}"))?;
    if bytes.len() as u64 > MAX_INSTRUCTION_BYTES {
        return Err(format!(
            "{name} is larger than 1 MiB, so Plyloft does not open it in Code."
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| format!("{name} is not UTF-8 text, so Plyloft cannot say what is in it."))
}

#[cfg(test)]
#[path = "personal_instructions_tests.rs"]
mod tests;
