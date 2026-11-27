//! A card chat's attachments: images, PDFs, Word files and text files the
//! member gives the chat, stored per card on this machine only, and how each
//! vendor is handed them (`docs/spikes/CHAT_ATTACHMENTS_SPIKE.md`, Phase 0 §4
//! and §6; owner decisions of 2026-10-15).
//!
//! - **Where:** `<config>/projects/<ws>/cards/<card>/attachments/`, each file
//!   written atomically and never over another (`commands::save_dropped_bytes`:
//!   tempfile, fsync, `persist_noclobber`, a uuid-prefixed sanitized name).
//!   Text Plyloft extracts goes to `attachments/extracted/<id>.txt`. The
//!   folder goes with the card (`chat::forget_card`). Never synced.
//! - **What:** the kind is the extension *and* the file's own signature
//!   (PNG, JPEG, GIF, WebP magic; `%PDF-`; a zip for `.docx`; UTF-8 without
//!   NUL for text). A file that says it is an image but isn't is refused, so
//!   Codex is never handed a PDF as `localImage` (Phase 0 §6: accepted
//!   silently, then read with shell tools).
//! - **Claude** gets quoted absolute paths and "Read each one" (the session
//!   has `--add-dir` on the attachments folder; the macOS config path has a
//!   space, so no `@` mention): images and PDFs of up to 10 pages as they
//!   are, and the extracted text file for a longer PDF and for a `.docx`.
//! - **Codex** gets `{"type":"localImage","path"}` for real images only, and
//!   every document's text inline in its message (its read-only sandbox may
//!   not run the shell commands it would read a file with).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Claude's Read takes a PDF whole up to this many pages; past it, it needs
/// `pdftoppm` (Claude Code docs, measured Phase 0 §4).
pub(crate) const CLAUDE_PDF_NATIVE_PAGES: usize = 10;

/// The most attachments one card keeps.
pub(crate) const MAX_ATTACHMENTS_PER_CARD: usize = 50;

/// What an attachment is, by its extension and its bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AttachmentKind {
    Image,
    Pdf,
    Text,
    Docx,
    /// A kind a newer Plyloft wrote: kept, handed to no model.
    #[serde(other)]
    Other,
}

/// The largest attachment of each kind, refused before anything is written.
/// Images: the Claude API's 5 MB per image (Read re-encodes large ones, the
/// API refuses past this); PDFs: the API's 32 MB request cap for a document;
/// Word files: 20 MB (mostly images, the text is far smaller); text: 2 MB,
/// the most text Plyloft keeps of any attachment (`chat_extract::MAX_TEXT_BYTES`).
pub(crate) fn max_bytes(kind: AttachmentKind) -> u64 {
    match kind {
        AttachmentKind::Image => 5 * 1024 * 1024,
        AttachmentKind::Pdf => 32 * 1024 * 1024,
        AttachmentKind::Docx => 20 * 1024 * 1024,
        AttachmentKind::Text | AttachmentKind::Other => 2 * 1024 * 1024,
    }
}

const IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
const TEXT_EXTENSIONS: [&str; 16] = [
    "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "toml", "log", "html", "htm", "xml", "rtf", "ini",
    "sql",
];

fn extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// The kind `name` claims by its extension, or why Plyloft takes no such file.
pub(crate) fn kind_by_name(name: &str) -> Result<AttachmentKind, String> {
    let ext = extension(name);
    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Ok(AttachmentKind::Image)
    } else if ext == "pdf" {
        Ok(AttachmentKind::Pdf)
    } else if ext == "docx" {
        Ok(AttachmentKind::Docx)
    } else if TEXT_EXTENSIONS.contains(&ext.as_str()) {
        Ok(AttachmentKind::Text)
    } else {
        Err(format!(
            "{name}: a chat takes images (PNG, JPEG, GIF, WebP), PDFs, Word files (.docx) and text files."
        ))
    }
}

/// Whether `head` (a file's first bytes) is a PNG, JPEG, GIF or WebP image.
pub(crate) fn is_image_signature(head: &[u8]) -> bool {
    head.starts_with(b"\x89PNG\r\n\x1a\n")
        || head.starts_with(b"\xFF\xD8\xFF")
        || head.starts_with(b"GIF87a")
        || head.starts_with(b"GIF89a")
        || (head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP")
}

/// Whether `bytes` start like a PDF: `%PDF-` within the first 1 KB (the
/// spec allows leading junk there).
pub(crate) fn is_pdf_signature(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(1024)].windows(5).any(|w| w == b"%PDF-")
}

/// The file's kind once its bytes agree with its name.
pub(crate) fn checked_kind(name: &str, bytes: &[u8]) -> Result<AttachmentKind, String> {
    let kind = kind_by_name(name)?;
    let agrees = match kind {
        AttachmentKind::Image => is_image_signature(bytes),
        AttachmentKind::Pdf => is_pdf_signature(bytes),
        AttachmentKind::Docx => bytes.starts_with(b"PK\x03\x04"),
        // Checked by reading it (`chat_extract::plain_text`).
        AttachmentKind::Text | AttachmentKind::Other => true,
    };
    if !agrees {
        let what = match kind {
            AttachmentKind::Image => "an image",
            AttachmentKind::Pdf => "a PDF",
            AttachmentKind::Docx => "a Word file",
            _ => "that kind of file",
        };
        return Err(format!("{name} isn't {what}, whatever its name says; it wasn't attached."));
    }
    let limit = max_bytes(kind);
    if bytes.len() as u64 > limit {
        return Err(format!(
            "{name} is {:.1} MB; a chat attachment of its kind can be at most {} MB.",
            bytes.len() as f64 / (1024.0 * 1024.0),
            limit / (1024 * 1024)
        ));
    }
    Ok(kind)
}

/// One attachment, as `chat.json` keeps it (`chat_store::CardChatFile`).
/// Every field after `kind` has a default, so an older file reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Attachment {
    pub id: String,
    /// The member's own file name, for the chip.
    pub name: String,
    pub kind: AttachmentKind,
    #[serde(default)]
    pub bytes: u64,
    /// The stored copy's file name inside the attachments folder.
    #[serde(default)]
    pub stored_name: String,
    #[serde(default)]
    pub added_at: i64,
    /// A PDF's page count, when Plyloft could read it.
    #[serde(default)]
    pub pages: Option<u32>,
    /// The extracted text's file name inside `attachments/extracted/`
    /// (PDFs, Word files), when there is text.
    #[serde(default)]
    pub text_name: Option<String>,
    /// The extracted text was cut at Plyloft's limit.
    #[serde(default)]
    pub text_truncated: bool,
    /// What the member should know (a PDF with no text layer, an extraction
    /// that failed but the file is still usable).
    #[serde(default)]
    pub note: Option<String>,
}

impl Attachment {
    pub(crate) fn path(&self, dir: &Path) -> PathBuf {
        dir.join(&self.stored_name)
    }

    pub(crate) fn text_path(&self, dir: &Path) -> Option<PathBuf> {
        self.text_name.as_ref().map(|name| dir.join(EXTRACTED_DIR).join(name))
    }

    /// Whether Claude reads the extracted text rather than the original: a
    /// Word file always, a PDF past [`CLAUDE_PDF_NATIVE_PAGES`].
    fn claude_reads_text(&self) -> bool {
        match self.kind {
            AttachmentKind::Docx => true,
            AttachmentKind::Pdf => self.pages.is_some_and(|pages| pages as usize > CLAUDE_PDF_NATIVE_PAGES),
            _ => false,
        }
    }
}

/// Where extracted text lives inside a card's attachments folder.
pub(crate) const EXTRACTED_DIR: &str = "extracted";

/// Text Plyloft puts in front of a model with no terminal control in it:
/// ESC and every other C0 control but `\n` and `\t`, DEL and the C1 controls
/// are dropped (a pasted `ESC[201~` would end Claude's bracketed paste
/// early, and a CR would submit what follows; Challenger round 1, P1-3).
pub(crate) fn clean_text(text: &str) -> String {
    text.chars()
        .filter(|c| matches!(c, '\n' | '\t') || !c.is_control())
        .collect()
}

/// An attachment checked and read, with nothing written yet
/// ([`prepare`]); [`commit`] stores it.
#[derive(Debug)]
pub(crate) struct Prepared {
    name: String,
    kind: AttachmentKind,
    /// A PDF's or a Word file's text (or why a PDF's couldn't be read).
    extracted: Option<Result<crate::chat_extract::Extracted, String>>,
}

/// Checks `bytes` as an attachment named `name` and reads its text, writing
/// nothing to the card: the name (one file name, no control character),
/// kind, signature and size; a text file that isn't text and a Word file
/// with no readable text are refused whole; a PDF is read in a child process
/// (`chat_extract::pdf_text`), and one it can't read is still kept, with a
/// note (Claude reads a short one itself). Slow for a big PDF: called
/// without the card's lock.
pub(crate) fn prepare(name: &str, bytes: &[u8]) -> Result<Prepared, String> {
    if name.chars().any(char::is_control) {
        return Err("The file's name holds control characters; rename it and attach it again.".into());
    }
    let name = name.trim();
    // Only its last part: a name with folders in it never reaches outside
    // the card's folder.
    let name = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty() && *n != "." && *n != "..")
        .ok_or_else(|| "The file has no usable name.".to_string())?
        .to_string();
    let kind = checked_kind(&name, bytes)?;
    let extracted = match kind {
        AttachmentKind::Text => {
            crate::chat_extract::plain_text(bytes).map_err(|error| format!("{name}: {error}"))?;
            None
        }
        AttachmentKind::Docx => {
            Some(Ok(crate::chat_extract::docx_text(bytes).map_err(|error| format!("{name}: {error}"))?))
        }
        AttachmentKind::Pdf => Some(crate::chat_extract::pdf_text(bytes)),
        _ => None,
    };
    Ok(Prepared { name, kind, extracted })
}

/// [`prepare`] then [`commit`] (tests and simple callers).
#[cfg(test)]
pub(crate) fn store(dir: &Path, name: &str, bytes: &[u8], now_ms: i64) -> Result<Attachment, String> {
    commit(dir, prepare(name, bytes)?, bytes, now_ms)
}

/// Stores a prepared attachment in `dir`: its copy (atomic, never over
/// another file), then its extracted text. Fast: the caller holds the card's
/// lock, so a deleted card never gets its folder back.
pub(crate) fn commit(dir: &Path, prepared: Prepared, bytes: &[u8], now_ms: i64) -> Result<Attachment, String> {
    let Prepared { name, kind, extracted } = prepared;
    let path = crate::commands::save_dropped_bytes(dir, &name, bytes, Some(bytes.len() as u64))?;
    let stored_name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
    let id = uuid::Uuid::new_v4().to_string();
    let mut attachment = Attachment {
        id: id.clone(),
        name: name.clone(),
        kind,
        bytes: bytes.len() as u64,
        stored_name,
        added_at: now_ms,
        pages: None,
        text_name: None,
        text_truncated: false,
        note: None,
    };
    let text = match extracted {
        None => None,
        Some(Ok(text)) => Some(text),
        Some(Err(error)) => {
            // Only a PDF reaches here with an error (a Word file's was
            // returned above).
            attachment.note = Some(format!("{error} Claude can still read a PDF of up to 10 pages itself."));
            None
        }
    };
    if let Some(text) = text {
        attachment.pages = text.pages.map(|pages| pages as u32);
        if kind == AttachmentKind::Pdf && !crate::chat_extract::has_words(&text) {
            attachment.note = Some("This PDF has no text layer (a scan?): Plyloft found no words in it.".into());
        } else {
            let text_name = format!("{id}.txt");
            let target = dir.join(EXTRACTED_DIR).join(&text_name);
            if let Err(error) = std::fs::create_dir_all(dir.join(EXTRACTED_DIR))
                .map_err(|e| e.to_string())
                .and_then(|()| crate::atomic::write_atomic_text(&target, &text.text))
            {
                let _ = std::fs::remove_file(&path);
                return Err(format!("{name}: Plyloft couldn't save the text it read ({error})."));
            }
            attachment.text_name = Some(text_name);
            attachment.text_truncated = text.truncated;
        }
    }
    Ok(attachment)
}

/// Removes an attachment's files (its copy and its extracted text). Only
/// names inside `dir` are touched.
pub(crate) fn remove_files(dir: &Path, attachment: &Attachment) {
    let mut paths = vec![attachment.path(dir)];
    paths.extend(attachment.text_path(dir));
    for path in paths {
        let inside = path.parent().is_some_and(|parent| parent == dir || parent == dir.join(EXTRACTED_DIR));
        let plain = Path::new(&attachment.stored_name).components().count() <= 1
            && attachment.text_name.as_deref().is_none_or(|name| Path::new(name).components().count() <= 1);
        if !inside || !plain {
            log::warn!("chat attachment {}: refusing to remove {}", attachment.id, path.display());
            continue;
        }
        if let Err(error) = std::fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("chat attachment {}: remove {}: {error}", attachment.id, path.display());
            }
        }
    }
}

/// The words that start Plyloft's attachment block in a Claude message; the
/// transcript reader cuts a user entry there (`chat_transcript`).
pub(crate) const CLAUDE_ATTACHMENTS_LEAD: &str = "The member attached these files.";

fn pages_word(pages: u32) -> String {
    if pages == 1 {
        "1 page".to_string()
    } else {
        format!("{pages} pages")
    }
}

/// The message typed into Claude's composer for `text` with `attachments`
/// (stored in `dir`).
pub(crate) fn claude_message(text: &str, attachments: &[Attachment], dir: &Path) -> String {
    let usable: Vec<&Attachment> = attachments.iter().filter(|a| a.kind != AttachmentKind::Other).collect();
    if usable.is_empty() {
        return text.to_string();
    }
    let mut message = String::from(text.trim_end());
    message.push_str("\n\n");
    message.push_str(CLAUDE_ATTACHMENTS_LEAD);
    message.push_str(" Read each one with the Read tool before you answer:\n");
    for attachment in usable {
        let (path, what) = match (attachment.claude_reads_text(), attachment.text_path(dir)) {
            (true, Some(text)) => (
                text,
                match attachment.kind {
                    AttachmentKind::Docx => "text Plyloft extracted from the Word file".to_string(),
                    _ => format!(
                        "text Plyloft extracted from the PDF, {}",
                        pages_word(attachment.pages.unwrap_or_default())
                    ),
                },
            ),
            _ => (
                attachment.path(dir),
                match attachment.kind {
                    AttachmentKind::Image => "image".to_string(),
                    AttachmentKind::Pdf => match attachment.pages {
                        Some(pages) => format!("PDF, {}", pages_word(pages)),
                        None => "PDF".to_string(),
                    },
                    AttachmentKind::Docx => "Word file; Plyloft could not read its text".to_string(),
                    _ => "text".to_string(),
                },
            ),
        };
        let cut = if attachment.claude_reads_text() && attachment.text_truncated { "; cut at Plyloft's limit" } else { "" };
        message.push_str(&format!("- \"{}\" ({what}{cut}: {})\n", path.display(), clean_text(&attachment.name)));
    }
    message.trim_end().to_string()
}

/// The most of one document's text inlined into a Codex message, and of all
/// of them together. Past it the message names the full text's file.
pub(crate) const CODEX_INLINE_CHARS: usize = 60_000;
pub(crate) const CODEX_INLINE_TOTAL_CHARS: usize = 180_000;

/// Whether the stored copy really is an image: its first bytes, read again
/// at send time (a file changed on disk since it was attached is not
/// trusted by its record).
fn still_an_image(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 16];
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let read = file.read(&mut head).unwrap_or(0);
    is_image_signature(&head[..read])
}

/// Codex app-server `turn/start` input for `text` with `attachments`
/// (`UserInput`, codex-cli 0.162.1): one `text` item — the member's words,
/// then each document's text inline — and one `localImage` per real image.
pub(crate) fn codex_input(text: &str, attachments: &[Attachment], dir: &Path) -> serde_json::Value {
    let mut prose = String::from(text.trim_end());
    let mut images = Vec::new();
    let mut documents = String::new();
    let mut budget = CODEX_INLINE_TOTAL_CHARS;
    for attachment in attachments {
        match attachment.kind {
            AttachmentKind::Image => {
                let path = attachment.path(dir);
                if still_an_image(&path) {
                    images.push(serde_json::json!({ "type": "localImage", "path": path.to_string_lossy() }));
                } else {
                    documents.push_str(&format!("\n--- {} (image) ---\n(Plyloft didn't send it: the stored file is no longer an image.)\n", clean_text(&attachment.name)));
                }
            }
            AttachmentKind::Pdf | AttachmentKind::Docx | AttachmentKind::Text => {
                let what = match attachment.kind {
                    AttachmentKind::Pdf => "PDF",
                    AttachmentKind::Docx => "Word file",
                    _ => "text file",
                };
                let source = match attachment.kind {
                    AttachmentKind::Text => attachment.path(dir),
                    _ => match attachment.text_path(dir) {
                        Some(path) => path,
                        None => {
                            let why = attachment.note.as_deref().unwrap_or("Plyloft could not read its text.");
                            documents.push_str(&format!("\n--- {} ({what}) ---\n({why})\n", clean_text(&attachment.name)));
                            continue;
                        }
                    },
                };
                let body = std::fs::read_to_string(&source).unwrap_or_default();
                let limit = CODEX_INLINE_CHARS.min(budget);
                let shown: String = body.chars().take(limit).collect();
                budget = budget.saturating_sub(shown.chars().count());
                documents.push_str(&format!("\n--- {} ({what}) ---\n{shown}\n", clean_text(&attachment.name)));
                if shown.chars().count() < body.chars().count() {
                    documents.push_str(&format!(
                        "(The rest is cut here; the whole text is in \"{}\".)\n",
                        source.display()
                    ));
                }
            }
            AttachmentKind::Other => {}
        }
    }
    if !documents.is_empty() {
        prose.push_str("\n\nThe member attached these files; their text follows.\n");
        prose.push_str(&documents);
    }
    let mut input = vec![serde_json::json!({ "type": "text", "text": prose.trim_end(), "text_elements": [] })];
    input.extend(images);
    serde_json::Value::Array(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_extract::test_files;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn the_kind_is_the_name_and_the_bytes_together() {
        assert_eq!(checked_kind("shot.PNG", PNG).unwrap(), AttachmentKind::Image);
        assert_eq!(checked_kind("a.jpg", b"\xFF\xD8\xFF\xE0").unwrap(), AttachmentKind::Image);
        assert_eq!(checked_kind("a.webp", b"RIFF\0\0\0\0WEBPVP8 ").unwrap(), AttachmentKind::Image);
        assert_eq!(checked_kind("plan.pdf", b"%PDF-1.7 rest").unwrap(), AttachmentKind::Pdf);
        assert_eq!(checked_kind("notes.md", b"# hi").unwrap(), AttachmentKind::Text);
        // A PDF renamed .png is no image: Codex would get it as localImage.
        assert!(checked_kind("fake.png", b"%PDF-1.7").unwrap_err().contains("isn't an image"));
        assert!(checked_kind("fake.pdf", b"hello").unwrap_err().contains("isn't a PDF"));
        assert!(checked_kind("fake.docx", b"hello").unwrap_err().contains("isn't a Word file"));
        assert!(checked_kind("tool.exe", b"MZ").unwrap_err().contains("a chat takes images"));
        let big = vec![0u8; (max_bytes(AttachmentKind::Image) + 1) as usize];
        let mut big_png = PNG.to_vec();
        big_png.extend_from_slice(&big);
        assert!(checked_kind("huge.png", &big_png).unwrap_err().contains("at most 5 MB"));
    }

    #[test]
    fn storing_writes_atomically_never_over_another_and_refuses_before_writing() {
        let dir = tempfile::tempdir().unwrap();
        let a = store(dir.path(), "Quarterly plan.md", b"# plan", 1).unwrap();
        let b = store(dir.path(), "Quarterly plan.md", b"# other", 2).unwrap();
        assert_ne!(a.stored_name, b.stored_name, "never over another attachment");
        assert_ne!(a.id, b.id);
        assert!(a.stored_name.ends_with("Quarterly-plan.md"));
        assert_eq!(std::fs::read(a.path(dir.path())).unwrap(), b"# plan");
        assert!(store(dir.path(), "x.png", b"not an image", 3).is_err());
        assert!(store(dir.path(), "x.txt", b"bin\0ary", 3).is_err());
        assert!(store(dir.path(), "x.docx", b"PK\x03\x04broken", 3).is_err());
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 2, "only the two stored copies, no temp file and nothing refused: {names:?}");
        remove_files(dir.path(), &a);
        assert!(!a.path(dir.path()).exists());
        assert!(b.path(dir.path()).exists());
    }

    #[test]
    fn a_long_pdf_and_a_docx_get_their_text_extracted() {
        let dir = tempfile::tempdir().unwrap();
        let words: Vec<String> = (1..=12).map(|n| format!("Line {n}")).collect();
        let pages: Vec<&str> = words.iter().map(String::as_str).collect();
        let pdf = store(dir.path(), "spec.pdf", &test_files::pdf(&pages), 1).unwrap();
        assert_eq!(pdf.pages, Some(12));
        let text = std::fs::read_to_string(pdf.text_path(dir.path()).unwrap()).unwrap();
        assert!(text.contains("--- Page 12 ---\nLine 12"));
        let docx = store(dir.path(), "brief.docx", &test_files::docx("<w:p><w:r><w:t>Hello brief</w:t></w:r></w:p>"), 2)
            .unwrap();
        assert_eq!(std::fs::read_to_string(docx.text_path(dir.path()).unwrap()).unwrap(), "Hello brief");
        let short = store(dir.path(), "short.pdf", &test_files::pdf(&["Only page"]), 3).unwrap();
        assert_eq!(short.pages, Some(1));
        // A PDF Plyloft can't parse is still kept: Claude reads short ones.
        let odd = store(dir.path(), "odd.pdf", b"%PDF-1.4 garbage", 4).unwrap();
        assert!(odd.text_name.is_none());
        assert!(odd.note.as_deref().unwrap().contains("10 pages"));
        remove_files(dir.path(), &pdf);
        assert!(!pdf.text_path(dir.path()).unwrap().exists(), "the extracted text goes with it");
    }

    fn sample(dir: &Path) -> Vec<Attachment> {
        let words: Vec<String> = (1..=11).map(|n| format!("Page {n} words")).collect();
        let pages: Vec<&str> = words.iter().map(String::as_str).collect();
        vec![
            store(dir, "shot one.png", PNG, 1).unwrap(),
            store(dir, "short.pdf", &test_files::pdf(&["Brief words"]), 2).unwrap(),
            store(dir, "long.pdf", &test_files::pdf(&pages), 3).unwrap(),
            store(dir, "brief.docx", &test_files::docx("<w:p><w:r><w:t>Docx words</w:t></w:r></w:p>"), 4).unwrap(),
            store(dir, "notes.md", b"Markdown words", 5).unwrap(),
        ]
    }

    #[test]
    fn claude_gets_quoted_paths_and_the_extracted_text_for_long_pdfs_and_docx() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("Application Support").join("attachments");
        let atts = sample(&dir);
        let message = claude_message("Compare these", &atts, &dir);
        assert!(message.starts_with("Compare these\n\nThe member attached these files. Read each one"));
        let line = |name: &str| message.lines().find(|l| l.ends_with(&format!(": {name})"))).unwrap().to_string();
        assert_eq!(line("shot one.png"), format!("- \"{}\" (image: shot one.png)", atts[0].path(&dir).display()));
        assert_eq!(line("short.pdf"), format!("- \"{}\" (PDF, 1 page: short.pdf)", atts[1].path(&dir).display()));
        assert_eq!(
            line("long.pdf"),
            format!(
                "- \"{}\" (text Plyloft extracted from the PDF, 11 pages: long.pdf)",
                atts[2].text_path(&dir).unwrap().display()
            )
        );
        assert!(line("brief.docx").contains(&format!("\"{}\"", atts[3].text_path(&dir).unwrap().display())));
        assert!(line("brief.docx").contains("Word file"));
        assert!(line("notes.md").contains("(text: notes.md)"));
        assert_eq!(claude_message("plain", &[], &dir), "plain");
    }

    #[test]
    fn codex_gets_local_image_only_for_real_images_and_document_text_inline() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("attachments");
        let atts = sample(&dir);
        let input = codex_input("Compare these", &atts, &dir);
        let items = input.as_array().unwrap();
        assert_eq!(items.len(), 2, "one text item and the one image: {input}");
        assert_eq!(items[1], serde_json::json!({"type":"localImage","path": atts[0].path(&dir).to_string_lossy()}));
        let text = items[0]["text"].as_str().unwrap();
        assert!(text.starts_with("Compare these\n\nThe member attached these files"));
        for words in ["Brief words", "Page 11 words", "Docx words", "Markdown words"] {
            assert!(text.contains(words), "{words} inline: {text}");
        }
        assert!(!text.contains("shot one.png"), "the image goes as localImage, not text");

        // A stored image overwritten with a PDF is no longer sent as one.
        std::fs::write(atts[0].path(&dir), b"%PDF-1.7").unwrap();
        let input = codex_input("again", &atts[..1], &dir);
        assert_eq!(input.as_array().unwrap().len(), 1);
        assert!(input[0]["text"].as_str().unwrap().contains("no longer an image"));
    }

    #[test]
    fn a_long_document_is_cut_inline_and_names_its_whole_text() {
        let dir = tempfile::tempdir().unwrap();
        let body = "x".repeat(CODEX_INLINE_CHARS + 10);
        let att = store(dir.path(), "big.txt", body.as_bytes(), 1).unwrap();
        let input = codex_input("read", &[att.clone()], dir.path());
        let text = input[0]["text"].as_str().unwrap();
        assert!(text.contains("The rest is cut here"));
        assert!(text.contains(&att.path(dir.path()).display().to_string()));
    }

    #[test]
    fn an_attachment_record_from_before_any_optional_field_reads() {
        let old: Attachment =
            serde_json::from_str(r#"{"id":"a","name":"x.png","kind":"image"}"#).unwrap();
        assert_eq!(old.bytes, 0);
        assert_eq!(old.text_name, None);
        let future: Attachment = serde_json::from_str(r#"{"id":"a","name":"x.key","kind":"keynote"}"#).unwrap();
        assert_eq!(future.kind, AttachmentKind::Other);
    }
}
