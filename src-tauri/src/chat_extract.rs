//! Text Plyloft reads out of a card chat's attachments itself: PDFs and Word
//! files, on the Mac and on Windows alike (`docs/spikes/CHAT_ATTACHMENTS_SPIKE.md`,
//! Phase 0 §4, owner decision of 2026-10-15).
//!
//! Neither vendor's own file tool reads them all (measured, Claude Code
//! 2.1.300 and codex-cli 0.162.1): Claude's Read takes a PDF of up to 10
//! pages natively, but past that it renders page ranges with poppler's
//! `pdftoppm`, which a stock Mac or PC does not have ("pdftoppm is not
//! installed"); it refuses a `.docx` outright ("This tool cannot read binary
//! files"); and Codex has no PDF or Word reader at all. So Plyloft hands
//! either model the text instead.
//!
//! Pure Rust, no system library: `pdf-extract` (fonts, encodings and CMaps,
//! over `lopdf`) for PDFs; `zip` + `quick-xml` for a `.docx`
//! (`word/document.xml`). Every reader is bounded — input size (checked by
//! the caller, `chat_attachments::max_bytes`), pages, the size a zip entry
//! inflates to, and the text kept.
//!
//! **A PDF is read in a child process** (Challenger round 1, P1-2): a hostile
//! or broken file — a deflate bomb, a page tree that loops, a parser panic or
//! stack overflow — can take memory, time or the whole process with it, so
//! the parse runs in Plyloft's own binary started again with a hidden
//! argument (`--ply-extract-pdf <in> <out>`, [`dispatch`], from `main.rs`),
//! under a wall-clock limit ([`PDF_LIMITS`]: 20 s) and a memory cap (1 GiB:
//! a job with a process memory limit on Windows, `RLIMIT_AS` on Linux, the
//! child's memory footprint watched on macOS, which enforces no `RLIMIT_AS`);
//! the child also bounds itself (`RLIMIT_CPU`, an alarm, an exit when its
//! parent is gone), reads and writes only inside its own `ply-pdf-*` folder,
//! and extracts in one pass.
//! The page count is read first and only the first [`MAX_PDF_PAGES`] pages are
//! extracted. A child still running when Plyloft quits is killed with its
//! group ([`kill_active`], Hard rule 4).

use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

/// The most text kept from one attachment: what the extracted `.txt` holds
/// and what a model is pointed at. About 250 000 words.
pub(crate) const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

/// The most pages read from a PDF (the rest are left out, and said so).
pub(crate) const MAX_PDF_PAGES: usize = 2000;

/// The most a `.docx`'s `word/document.xml` may inflate to: a 20 MB Word
/// file is mostly images; its text part is a few MB at most. A zip bomb
/// stops here rather than filling memory.
pub(crate) const MAX_DOCX_XML_BYTES: u64 = 64 * 1024 * 1024;

/// Text read out of an attachment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Extracted {
    pub text: String,
    /// A PDF's page count (the pages read); `None` for other kinds.
    pub pages: Option<usize>,
    /// Text was cut at [`MAX_TEXT_BYTES`] or pages at [`MAX_PDF_PAGES`].
    pub truncated: bool,
}

/// The extraction child's limits.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ChildLimits {
    pub timeout: Duration,
    pub memory_bytes: u64,
}

pub(crate) const PDF_LIMITS: ChildLimits =
    ChildLimits { timeout: Duration::from_secs(20), memory_bytes: 1024 * 1024 * 1024 };

/// The hidden argument that makes Plyloft's binary an extraction child.
pub(crate) const CHILD_FLAG: &str = "--ply-extract-pdf";

/// The prefix of the temporary folder a child reads from and writes to.
const TEMP_PREFIX: &str = "ply-pdf-";

/// `main.rs`: `[CHILD_FLAG, in, out]` runs the child and returns its exit
/// code; anything else is no child. Both paths must sit in one
/// `ply-pdf-*` folder (the one [`pdf_text_with`] made), so the argument can
/// make Plyloft read or write nothing else.
pub fn dispatch(args: &[String]) -> Option<i32> {
    match args {
        [flag, input, output] if flag == CHILD_FLAG => {
            let (input, output) = (Path::new(input), Path::new(output));
            // A `ply-pdf-*` folder directly in the system's temp folder.
            let temp = crate::platform::canonicalize(&std::env::temp_dir()).ok();
            let ours = |path: &Path| {
                let Some(dir) = path.parent() else { return false };
                let named = dir.file_name().and_then(|name| name.to_str()).is_some_and(|n| n.starts_with(TEMP_PREFIX));
                let in_temp = dir
                    .parent()
                    .and_then(|parent| crate::platform::canonicalize(parent).ok())
                    .is_some_and(|parent| Some(parent) == temp);
                named && in_temp
            };
            if !ours(input) || input.parent() != output.parent() {
                return Some(6);
            }
            Some(child_main(input, output))
        }
        _ => None,
    }
}

/// At launch: temporary folders a child left (Plyloft quit or crashed while
/// it read), older than an hour.
pub(crate) fn clean_leftovers() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| at.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(3600));
        if old && name.to_string_lossy().starts_with(TEMP_PREFIX) && entry.path().is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Extraction children running now (their pids, each its group's leader).
fn active() -> &'static parking_lot::Mutex<std::collections::HashSet<u32>> {
    static ACTIVE: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashSet<u32>>> =
        std::sync::OnceLock::new();
    ACTIVE.get_or_init(Default::default)
}

/// Quit (Hard rule 4): every extraction child, with its group.
pub(crate) fn kill_active() -> usize {
    let pids: Vec<u32> = active().lock().drain().collect();
    for pid in &pids {
        #[cfg(unix)]
        crate::platform::kill_group(*pid as crate::platform::Pgid);
        #[cfg(windows)]
        {
            let _ = crate::platform::new_command("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).status();
        }
    }
    pids.len()
}

/// A PDF's text, page by page, each page headed `--- Page N ---` so a model
/// can cite where it read something; read in a child process
/// ([`PDF_LIMITS`]).
pub(crate) fn pdf_text(bytes: &[u8]) -> Result<Extracted, String> {
    pdf_text_with(bytes, PDF_LIMITS)
}

const DAMAGED: &str = "Plyloft couldn't read this PDF (its structure is damaged).";

pub(crate) fn pdf_text_with(bytes: &[u8], limits: ChildLimits) -> Result<Extracted, String> {
    let dir = tempfile::Builder::new()
        .prefix(TEMP_PREFIX)
        .tempdir()
        .map_err(|e| format!("Plyloft couldn't prepare to read this PDF ({e})."))?;
    let input = dir.path().join("in.pdf");
    let output = dir.path().join("out.json");
    std::fs::write(&input, bytes).map_err(|e| format!("Plyloft couldn't prepare to read this PDF ({e})."))?;
    let mut command = child_command(&input, &output)?;
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    crate::platform::own_group(&mut command);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let cap = limits.memory_bytes as libc::rlim_t;
        // SAFETY: only async-signal-safe setrlimit between fork and exec.
        unsafe {
            command.pre_exec(move || {
                let limit = libc::rlimit { rlim_cur: cap, rlim_max: cap };
                libc::setrlimit(libc::RLIMIT_AS, &limit);
                Ok(())
            });
        }
    }
    let mut child = command.spawn().map_err(|e| format!("Plyloft couldn't start reading this PDF ({e})."))?;
    let pid = child.id();
    active().lock().insert(pid);
    let _cap = crate::platform::cap_memory(&child, limits.memory_bytes);
    let started = Instant::now();
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {}
            Err(e) => break Err(format!("Plyloft lost the PDF reader ({e}).")),
        }
        if started.elapsed() >= limits.timeout {
            break Err(format!("Plyloft couldn't read this PDF in time ({} s).", limits.timeout.as_secs()));
        }
        if footprint_bytes(pid).is_some_and(|bytes| bytes > limits.memory_bytes) {
            break Err("Plyloft stopped reading this PDF: it needs too much memory.".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    if outcome.is_err() || matches!(outcome, Ok(status) if !status.success()) {
        #[cfg(unix)]
        crate::platform::kill_group(pid as crate::platform::Pgid);
        let _ = child.kill();
        let _ = child.wait();
    }
    active().lock().remove(&pid);
    let status = outcome?;
    if !status.success() {
        // Killed by its memory cap (Windows, Linux) or crashed (a stack
        // overflow on a looping page tree, a panic).
        return Err(DAMAGED.into());
    }
    let answer: serde_json::Value = std::fs::read_to_string(&output)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| DAMAGED.to_string())?;
    if let Some(error) = answer.get("error").and_then(|e| e.as_str()) {
        return Err(error.to_string());
    }
    Ok(Extracted {
        text: answer.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        pages: answer.get("pages").and_then(|p| p.as_u64()).map(|p| p as usize),
        truncated: answer.get("truncated").and_then(|t| t.as_bool()).unwrap_or(false),
    })
}

/// The child's command: Plyloft's own binary with [`CHILD_FLAG`]. A test
/// binary has no such argument, so tests run the test that plays the child
/// (`tests::extraction_child`), handed the paths in the environment.
fn child_command(input: &Path, output: &Path) -> Result<std::process::Command, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Plyloft couldn't find itself to read this PDF ({e})."))?;
    let mut command = crate::platform::new_command(exe);
    #[cfg(not(test))]
    command.arg(CHILD_FLAG).arg(input).arg(output);
    #[cfg(test)]
    command
        .args(["--exact", "chat_extract::tests::extraction_child", "--nocapture", "--test-threads=1", "--quiet"])
        .env("PLY_TEST_EXTRACT_CHILD", format!("{}\n{}", input.display(), output.display()));
    Ok(command)
}

/// The child's memory footprint, where the parent must watch it (macOS
/// enforces no `RLIMIT_AS`): `ri_phys_footprint` (`proc_pid_rusage`,
/// `RUSAGE_INFO_V4`), what Activity Monitor calls Memory — compressed and
/// swapped pages included, where the resident size would miss them. `None`
/// where the OS enforces the cap.
fn footprint_bytes(pid: u32) -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: zeroed plain-data struct, filled by the kernel.
        let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
        // SAFETY: the buffer is the flavor's own struct.
        let read = unsafe {
            libc::proc_pid_rusage(
                pid as libc::c_int,
                libc::RUSAGE_INFO_V4,
                (&mut info as *mut libc::rusage_info_v4).cast(),
            )
        };
        (read == 0).then_some(info.ri_phys_footprint)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pid;
        None
    }
}

/// The child bounds itself too, should the parent's watch fail: CPU time
/// (`RLIMIT_CPU`) and a wall-clock alarm a little past the parent's limit,
/// and an exit as soon as its parent is gone (re-parented). Windows: the
/// parent's job is kill-on-close, so the child goes with the parent.
fn bound_self() {
    #[cfg(unix)]
    {
        let limit = PDF_LIMITS.timeout.as_secs() + 10;
        // SAFETY: plain syscalls on this process.
        unsafe {
            let cpu = libc::rlimit { rlim_cur: limit as libc::rlim_t, rlim_max: limit as libc::rlim_t };
            libc::setrlimit(libc::RLIMIT_CPU, &cpu);
            libc::alarm(limit as libc::c_uint);
        }
        // SAFETY: getppid never fails.
        let parent = unsafe { libc::getppid() };
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(200));
            // SAFETY: as above.
            if unsafe { libc::getppid() } != parent {
                std::process::exit(5);
            }
        });
    }
}

/// The extraction child: reads `input`, writes its answer to `output` as
/// JSON (`{text, pages, truncated}` or `{error}`), exit 0, into a file it
/// creates (never over one). A crash (a panic, a stack overflow, a limit)
/// exits otherwise, and the parent says the file is damaged.
pub(crate) fn child_main(input: &Path, output: &Path) -> i32 {
    bound_self();
    let Ok(bytes) = std::fs::read(input) else {
        return 2;
    };
    let answer = match std::panic::catch_unwind(|| extract_pdf(&bytes)) {
        Ok(Ok(extracted)) => serde_json::json!({
            "text": extracted.text,
            "pages": extracted.pages,
            "truncated": extracted.truncated,
        }),
        Ok(Err(error)) => serde_json::json!({ "error": error }),
        Err(_) => return 3,
    };
    use std::io::Write as _;
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .and_then(|mut file| file.write_all(answer.to_string().as_bytes()));
    match written {
        Ok(()) => 0,
        Err(_) => 4,
    }
}

/// The text of a PDF's pages as `pdf-extract` draws them, page by page, in
/// one pass over the document (`output_doc` walks the page tree once). It
/// stops the pass past [`MAX_PDF_PAGES`] or [`MAX_TEXT_BYTES`]. The spacing
/// rules are `pdf_extract::PlainTextOutput`'s.
#[derive(Default)]
struct PageText {
    pages: Vec<String>,
    bytes: usize,
    stopped: bool,
    first_char: bool,
    last_y: f64,
    last_end: f64,
}

impl pdf_extract::OutputDev for PageText {
    fn begin_page(
        &mut self,
        _page_num: u32,
        _media_box: &pdf_extract::MediaBox,
        _art_box: Option<(f64, f64, f64, f64)>,
    ) -> Result<(), pdf_extract::OutputError> {
        if self.pages.len() >= MAX_PDF_PAGES || self.bytes >= MAX_TEXT_BYTES {
            self.stopped = true;
            return Err(pdf_extract::OutputError::FormatError(std::fmt::Error));
        }
        self.pages.push(String::new());
        self.first_char = false;
        self.last_y = 0.0;
        self.last_end = 0.0;
        Ok(())
    }

    fn end_page(&mut self) -> Result<(), pdf_extract::OutputError> {
        Ok(())
    }

    fn output_character(
        &mut self,
        trm: &pdf_extract::Transform,
        width: f64,
        _spacing: f64,
        font_size: f64,
        char: &str,
    ) -> Result<(), pdf_extract::OutputError> {
        let (x, y) = (trm.m31, trm.m32);
        let vx = font_size * trm.m11 + font_size * trm.m21;
        let vy = font_size * trm.m12 + font_size * trm.m22;
        let size = (vx * vy).abs().sqrt();
        let Some(page) = self.pages.last_mut() else {
            return Ok(());
        };
        if self.first_char {
            if (y - self.last_y).abs() > size * 1.5 {
                page.push('\n');
            }
            if x < self.last_end && (y - self.last_y).abs() > size * 0.5 {
                page.push('\n');
            }
            if x > self.last_end + size * 0.1 {
                page.push(' ');
            }
        }
        page.push_str(char);
        self.bytes += char.len();
        self.first_char = false;
        self.last_y = y;
        self.last_end = x + width * size;
        Ok(())
    }

    fn begin_word(&mut self) -> Result<(), pdf_extract::OutputError> {
        self.first_char = true;
        Ok(())
    }

    fn end_word(&mut self) -> Result<(), pdf_extract::OutputError> {
        Ok(())
    }

    fn end_line(&mut self) -> Result<(), pdf_extract::OutputError> {
        Ok(())
    }
}

/// The PDF's page count first (one walk of its page tree), then the text of
/// its first [`MAX_PDF_PAGES`] pages in one pass. A page the parser breaks
/// on (it unwraps a missing MediaBox) ends the pass: the pages before it are
/// kept and the text is marked cut.
fn extract_pdf(bytes: &[u8]) -> Result<Extracted, String> {
    let mut doc = pdf_extract::Document::load_mem(bytes).map_err(|e| pdf_error(&e.to_string()))?;
    if doc.is_encrypted() && doc.decrypt("").is_err() {
        return Err(pdf_error("encrypted"));
    }
    let page_count = doc.get_pages().len();
    if page_count == 0 {
        return Err("Plyloft couldn't read any page of this PDF.".into());
    }
    let mut out = PageText::default();
    let pass = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| pdf_extract::output_doc(&doc, &mut out)));
    let broke = !matches!(pass, Ok(Ok(()))) && !out.stopped;
    if broke && out.pages.is_empty() {
        return Err(DAMAGED.into());
    }
    let mut text = String::new();
    let mut truncated = page_count > MAX_PDF_PAGES || out.stopped || broke;
    for (index, page) in out.pages.iter().enumerate() {
        let block = format!("--- Page {} ---\n{}\n\n", index + 1, page.trim());
        if text.len() + block.len() > MAX_TEXT_BYTES {
            truncated = true;
            break;
        }
        text.push_str(&block);
    }
    Ok(Extracted { text: text.trim_end().to_string(), pages: Some(page_count), truncated })
}

/// The member's words for a PDF the parser refused.
fn pdf_error(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("decrypt") || lower.contains("encrypt") || lower.contains("password") {
        return "This PDF is protected with a password; Plyloft can't read its text.".into();
    }
    format!("Plyloft couldn't read this PDF ({raw}).")
}

/// Whether a PDF's extracted text holds any words: a scanned PDF (pages that
/// are only images) yields page headings and nothing else.
pub(crate) fn has_words(extracted: &Extracted) -> bool {
    extracted
        .text
        .lines()
        .filter(|line| !(line.starts_with("--- Page ") && line.ends_with(" ---")))
        .any(|line| line.chars().any(char::is_alphanumeric))
}

/// A Word file's text: its paragraphs, one per line; tabs and line breaks
/// kept; table cells separated by tabs.
pub(crate) fn docx_text(bytes: &[u8]) -> Result<Extracted, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "This isn't a Word (.docx) file Plyloft can open: it is not a zip archive.".to_string())?;
    let mut entry = archive.by_name("word/document.xml").map_err(|_| {
        "This isn't a Word (.docx) file Plyloft can open: it has no document part.".to_string()
    })?;
    if entry.size() > MAX_DOCX_XML_BYTES {
        return Err("This Word file's text part is too large for Plyloft to read.".into());
    }
    let mut xml = Vec::new();
    entry
        .by_ref()
        .take(MAX_DOCX_XML_BYTES + 1)
        .read_to_end(&mut xml)
        .map_err(|error| format!("Plyloft couldn't unpack this Word file ({error})."))?;
    if xml.len() as u64 > MAX_DOCX_XML_BYTES {
        return Err("This Word file's text part is too large for Plyloft to read.".into());
    }
    let text = document_xml_text(&xml)?;
    let (text, truncated) = cap_text(text);
    Ok(Extracted { text, pages: None, truncated })
}

/// The text runs of a WordprocessingML `document.xml`.
fn document_xml_text(xml: &[u8]) -> Result<String, String> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(xml);
    let mut out = String::new();
    // Inside a `<w:t>` (or `<w:delText>` is skipped: deleted text in a
    // tracked change is not the document).
    let mut in_text = false;
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(tag)) => match tag.local_name().as_ref() {
                b"t" => in_text = true,
                b"tab" => out.push('\t'),
                b"br" | b"cr" => out.push('\n'),
                _ => {}
            },
            Ok(Event::Empty(tag)) => match tag.local_name().as_ref() {
                b"tab" => out.push('\t'),
                b"br" | b"cr" => out.push('\n'),
                _ => {}
            },
            Ok(Event::End(tag)) => match tag.local_name().as_ref() {
                b"t" => in_text = false,
                b"p" => out.push('\n'),
                b"tc" => out.push('\t'),
                _ => {}
            },
            Ok(Event::Text(text)) if in_text => {
                let decoded = text
                    .unescape()
                    .map_err(|error| format!("Plyloft couldn't read this Word file's text ({error})."))?;
                out.push_str(&decoded);
            }
            Ok(Event::CData(text)) if in_text => out.push_str(&String::from_utf8_lossy(&text)),
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(format!("Plyloft couldn't read this Word file's text ({error}).")),
        }
        if out.len() > MAX_TEXT_BYTES + 1024 {
            break;
        }
        buf.clear();
    }
    // A paragraph that ends in a cell leaves "\t\n" runs; tidy trailing tabs.
    let tidy: Vec<&str> = out.lines().map(|line| line.trim_end_matches('\t')).collect();
    Ok(tidy.join("\n").trim().to_string())
}

/// A text attachment's text: UTF-8 (a BOM dropped); anything with a NUL
/// byte or invalid UTF-8 is no text file.
pub(crate) fn plain_text(bytes: &[u8]) -> Result<Extracted, String> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    if bytes.contains(&0) {
        return Err("This file isn't plain text (it holds binary data).".into());
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "This file isn't UTF-8 text; save it as UTF-8 and attach it again.".to_string())?;
    let (text, truncated) = cap_text(text.to_string());
    Ok(Extracted { text, pages: None, truncated })
}

/// `text` cut to [`MAX_TEXT_BYTES`] on a character boundary.
fn cap_text(mut text: String) -> (String, bool) {
    if text.len() <= MAX_TEXT_BYTES {
        return (text, false);
    }
    let mut end = MAX_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    (text, true)
}

#[cfg(test)]
pub(crate) mod test_files {
    //! Real-shaped files built in the test: deflated content streams and a
    //! deflated `document.xml`, as real PDFs and Word files are (the Phase 0
    //! fallbacks only worked on uncompressed ones).
    use std::io::Write;

    fn deflate(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// A PDF with one line of Helvetica text per page, each page's content
    /// stream FlateDecode-compressed, and a correct cross-reference table.
    pub(crate) fn pdf(pages: &[&str]) -> Vec<u8> {
        let n = pages.len();
        // Objects: 1 catalog, 2 pages, 3 font, then per page: page, content.
        let mut objects: Vec<Vec<u8>> = Vec::new();
        objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", 4 + 2 * i)).collect();
        objects.push(format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), n).into_bytes());
        objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_vec());
        for (i, text) in pages.iter().enumerate() {
            let content_id = 5 + 2 * i;
            objects.push(
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
                )
                .into_bytes(),
            );
            // Padded with a comment so deflate really compresses it (a few
            // dozen bytes would go in a stored block, the text in the clear).
            let padding = "% padding\n".repeat(40);
            let stream = deflate(format!("{padding}BT /F1 12 Tf 72 720 Td ({text}) Tj ET\n").as_bytes());
            objects.push(stream_object(&stream));
        }
        from_objects(&objects)
    }

    /// A PDF of `pages` pages with `lines` lines of prose each (one content
    /// stream per page, deflated), a real document's shape.
    pub(crate) fn pdf_with_lines(pages: usize, lines: usize) -> Vec<u8> {
        let mut objects: Vec<Vec<u8>> = Vec::new();
        objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        let kids: Vec<String> = (0..pages).map(|i| format!("{} 0 R", 4 + 2 * i)).collect();
        objects.push(format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), pages).into_bytes());
        objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_vec());
        for page in 0..pages {
            objects.push(
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {} 0 R >>",
                    5 + 2 * page
                )
                .into_bytes(),
            );
            let mut content = String::from("BT /F1 11 Tf 14 TL 72 740 Td\n");
            for line in 0..lines {
                content.push_str(&format!(
                    "(Page {} line {}: the quarterly plan keeps the import small and ships it in two steps.) Tj T*\n",
                    page + 1,
                    line + 1
                ));
            }
            content.push_str("ET\n");
            objects.push(stream_object(&deflate(content.as_bytes())));
        }
        from_objects(&objects)
    }

    fn stream_object(deflated: &[u8]) -> Vec<u8> {
        let mut object = format!("<< /Length {} /Filter /FlateDecode >>\nstream\n", deflated.len()).into_bytes();
        object.extend_from_slice(deflated);
        object.extend_from_slice(b"\nendstream");
        object
    }

    /// A one-page PDF whose content stream inflates to `inflated` bytes of
    /// zeros: a deflate bomb.
    pub(crate) fn deflate_bomb(inflated: usize) -> Vec<u8> {
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        let chunk = vec![0u8; 1 << 20];
        for _ in 0..inflated.div_ceil(chunk.len()) {
            encoder.write_all(&chunk).unwrap();
        }
        let stream = encoder.finish().unwrap();
        from_objects(&[
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>".to_vec(),
            stream_object(&stream),
        ])
    }

    /// A PDF whose page tree contains itself (`/Kids` naming its own node).
    pub(crate) fn page_tree_cycle() -> Vec<u8> {
        from_objects(&[
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 /Parent 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [2 0 R] /Count 1 /Parent 2 0 R >>".to_vec(),
        ])
    }

    /// `objects` (numbered from 1) as a PDF with a correct xref table.
    pub(crate) fn from_objects(objects: &[Vec<u8>]) -> Vec<u8> {
        let mut out = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
        let mut offsets = Vec::new();
        for (index, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
        for offset in offsets {
            out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes(),
        );
        out
    }

    /// A `.docx` (zip, deflated) whose body is `document_body` (WordprocessingML
    /// inside `<w:body>`).
    pub(crate) fn docx(document_body: &str) -> Vec<u8> {
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{document_body}</w:body></w:document>"#
        );
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("[Content_Types].xml", options).unwrap();
        zip.write_all(br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>"#)
            .unwrap();
        zip.start_file("word/document.xml", options).unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap().into_inner()
    }
}

#[cfg(test)]
mod tests {
    use super::test_files;
    use super::*;

    #[test]
    fn a_compressed_pdf_over_ten_pages_reads_page_by_page() {
        let words: Vec<String> = (1..=15).map(|n| format!("Fruit number {n} is ripe")).collect();
        let pages: Vec<&str> = words.iter().map(String::as_str).collect();
        let pdf = test_files::pdf(&pages);
        assert!(!pdf.windows(5).any(|w| w == b"Fruit"), "the text is compressed, not in the clear");
        let extracted = pdf_text(&pdf).unwrap();
        assert_eq!(extracted.pages, Some(15));
        assert!(!extracted.truncated);
        assert!(extracted.text.starts_with("--- Page 1 ---\nFruit number 1 is ripe"), "{}", extracted.text);
        assert!(extracted.text.contains("--- Page 12 ---\nFruit number 12 is ripe"));
        assert!(extracted.text.contains("Fruit number 15 is ripe"));
        assert!(has_words(&extracted));
    }

    /// Plays the extraction child when a test's `pdf_text` starts this test
    /// binary for it (`child_command`); otherwise a no-op.
    #[test]
    fn extraction_child() {
        let Ok(spec) = std::env::var("PLY_TEST_EXTRACT_CHILD") else {
            return;
        };
        let (input, output) = spec.split_once('\n').expect("in\\nout");
        let code = dispatch(&[CHILD_FLAG.to_string(), input.to_string(), output.to_string()]).expect("dispatched");
        std::process::exit(code);
    }

    /// Only the child argument, with both paths in one `ply-pdf-*` folder,
    /// runs the child (never in this process: the child bounds itself with
    /// an alarm and a CPU limit).
    #[test]
    fn the_child_argument_is_dispatched_only_for_its_own_folder() {
        assert_eq!(dispatch(&["--other".into()]), None);
        assert_eq!(dispatch(&[CHILD_FLAG.into(), "only-one".into()]), None);
        let elsewhere = tempfile::tempdir().unwrap();
        let input = elsewhere.path().join("in.pdf");
        let args = [CHILD_FLAG.to_string(), input.display().to_string(), elsewhere.path().join("out.json").display().to_string()];
        assert_eq!(dispatch(&args), Some(6), "not a ply-pdf folder");
        let nested = elsewhere.path().join(format!("{TEMP_PREFIX}x"));
        std::fs::create_dir_all(&nested).unwrap();
        let args = [CHILD_FLAG.to_string(), nested.join("in.pdf").display().to_string(), nested.join("out.json").display().to_string()];
        assert_eq!(dispatch(&args), Some(6), "a ply-pdf folder outside the temp folder");
        let ours = tempfile::Builder::new().prefix(TEMP_PREFIX).tempdir().unwrap();
        let other = tempfile::Builder::new().prefix(TEMP_PREFIX).tempdir().unwrap();
        let args = [
            CHILD_FLAG.to_string(),
            ours.path().join("in.pdf").display().to_string(),
            other.path().join("out.json").display().to_string(),
        ];
        assert_eq!(dispatch(&args), Some(6), "both paths in one folder");
        assert!(!other.path().join("out.json").exists());
    }

    /// A deflate bomb is stopped by the child's memory cap, and only the
    /// child goes: this process carries on.
    #[test]
    fn a_deflate_bomb_stops_the_child_not_the_app() {
        let bomb = test_files::deflate_bomb(512 * 1024 * 1024);
        assert!(bomb.len() < 4 * 1024 * 1024, "small on disk: {} bytes", bomb.len());
        let limits = ChildLimits { timeout: Duration::from_secs(15), memory_bytes: 128 * 1024 * 1024 };
        let started = Instant::now();
        let error = pdf_text_with(&bomb, limits).unwrap_err();
        // macOS: the parent reads the child's footprint; Linux and Windows
        // kill it at the cap themselves (a crash, read as damaged).
        if cfg!(target_os = "macos") {
            assert!(error.contains("too much memory"), "{error}");
        } else {
            assert!(error.contains("too much memory") || error.contains("damaged"), "{error}");
        }
        assert!(started.elapsed() < Duration::from_secs(15));
    }

    /// Release build, by hand (`cargo test --release --lib
    /// chat_extract::tests::a_thousand_page_pdf -- --ignored --nocapture`):
    /// how long a 1000-page PDF of real-shaped text takes through the child.
    #[test]
    #[ignore]
    fn a_thousand_page_pdf_reads_in_time() {
        // 20 lines a page: about 1.8 MB of text, under the 2 MB cap, so
        // every page is read.
        let pdf = test_files::pdf_with_lines(1000, 20);
        let started = Instant::now();
        let extracted = pdf_text(&pdf).unwrap();
        let took = started.elapsed();
        assert!(!extracted.truncated, "every page read");
        println!("1000 pages × 20 lines, {} KB: {:.2} s, {} KB of text", pdf.len() / 1024, took.as_secs_f64(), extracted.text.len() / 1024);
        assert_eq!(extracted.pages, Some(1000));
        assert!(took < PDF_LIMITS.timeout);
    }

    #[test]
    fn a_page_tree_that_contains_itself_ends_with_a_sentence() {
        let limits = ChildLimits { timeout: Duration::from_secs(30), memory_bytes: 512 * 1024 * 1024 };
        let error = pdf_text_with(&test_files::page_tree_cycle(), limits).unwrap_err();
        assert!(error.starts_with("Plyloft"), "{error}");
    }

    #[test]
    fn a_pdf_with_more_pages_than_the_cap_counts_them_all_and_reads_the_first() {
        let words: Vec<String> = (1..=MAX_PDF_PAGES + 5).map(|n| format!("p{n}")).collect();
        let pages: Vec<&str> = words.iter().map(String::as_str).collect();
        let limits = ChildLimits { timeout: Duration::from_secs(120), memory_bytes: PDF_LIMITS.memory_bytes };
        let extracted = pdf_text_with(&test_files::pdf(&pages), limits).unwrap();
        assert_eq!(extracted.pages, Some(MAX_PDF_PAGES + 5), "the count from before the extraction");
        assert!(extracted.truncated);
        assert!(extracted.text.contains(&format!("--- Page {MAX_PDF_PAGES} ---")));
        assert!(!extracted.text.contains(&format!("--- Page {} ---", MAX_PDF_PAGES + 1)));
    }

    #[test]
    fn a_docx_whose_text_part_inflates_past_the_cap_is_refused() {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        zip.start_file("word/document.xml", options).unwrap();
        let chunk = vec![b' '; 1 << 20];
        for _ in 0..(MAX_DOCX_XML_BYTES as usize / chunk.len() + 2) {
            zip.write_all(&chunk).unwrap();
        }
        let bomb = zip.finish().unwrap().into_inner();
        assert!(bomb.len() < 2 * 1024 * 1024);
        assert!(docx_text(&bomb).unwrap_err().contains("too large"));
    }

    #[test]
    fn a_damaged_or_empty_pdf_is_a_sentence_not_a_crash() {
        let error = pdf_text(b"%PDF-1.7\nthis is not a pdf at all").unwrap_err();
        assert!(error.starts_with("Plyloft couldn't read"), "{error}");
        let mut cut = test_files::pdf(&["one", "two"]);
        cut.truncate(cut.len() / 2);
        assert!(pdf_text(&cut).is_err());
    }

    #[test]
    fn a_pdf_of_only_headings_has_no_words() {
        let scanned = Extracted { text: "--- Page 1 ---\n\n\n--- Page 2 ---\n".into(), pages: Some(2), truncated: false };
        assert!(!has_words(&scanned));
    }

    #[test]
    fn a_compressed_docx_reads_its_paragraphs_tabs_breaks_and_cells() {
        let docx = test_files::docx(concat!(
            r#"<w:p><w:r><w:t>Quarterly plan</w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:t xml:space="preserve">Goal: </w:t></w:r><w:r><w:t>ship &amp; learn</w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>"#,
            r#"<w:p><w:del><w:r><w:delText>removed</w:delText></w:r></w:del></w:p>"#,
            r#"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell one</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>cell two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#,
        ));
        assert!(!docx.windows(9).any(|w| w == b"Quarterly"), "the document part is deflated");
        let extracted = docx_text(&docx).unwrap();
        assert_eq!(extracted.pages, None);
        assert!(!extracted.text.contains("removed"), "tracked deletions are not the text");
        assert!(extracted.text.starts_with("Quarterly plan\nGoal: ship & learn\na\tb\nc\n"), "{:?}", extracted.text);
        assert!(extracted.text.contains("cell one"));
        assert!(extracted.text.contains("cell two"));
    }

    #[test]
    fn a_file_that_is_no_docx_says_so() {
        assert!(docx_text(b"not a zip").unwrap_err().contains("not a zip archive"));
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file("other.xml", zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut zip, b"<x/>").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        assert!(docx_text(&bytes).unwrap_err().contains("no document part"));
    }

    /// A stored (uncompressed) `.docx` with one `word/document.xml`, and where
    /// its name sits in the local header and in the central directory.
    fn stored_docx(xml: &[u8]) -> (Vec<u8>, usize, usize) {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("word/document.xml", options).unwrap();
        std::io::Write::write_all(&mut zip, xml).unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let name = b"word/document.xml";
        let mut at = bytes.windows(name.len()).enumerate().filter(|(_, w)| w == name).map(|(i, _)| i);
        let local = at.next().expect("the name in the local header");
        let central = at.next().expect("the name in the central directory");
        (bytes, local, central)
    }

    #[test]
    fn a_docx_whose_text_part_is_marked_encrypted_is_a_sentence_not_a_crash() {
        let (mut bytes, local, central) = stored_docx(b"<w:document><w:body/></w:document>");
        // General purpose bit 0 ("encrypted"): 24 bytes before the name in the
        // local header, 38 before it in the central directory.
        bytes[local - 24] |= 1;
        bytes[central - 38] |= 1;
        let error = docx_text(&bytes).unwrap_err();
        assert!(error.contains("Word"), "{error}");
    }

    #[test]
    fn a_docx_whose_directory_declares_a_huge_text_part_is_refused() {
        let (mut bytes, _, central) = stored_docx(b"<w:document><w:body/></w:document>");
        // The uncompressed size in the central directory: 22 bytes before the
        // name. A size no real part has, far past the cap.
        bytes[central - 22..central - 18].copy_from_slice(&0xFFFF_FFF0_u32.to_le_bytes());
        match docx_text(&bytes) {
            Err(error) => assert!(error.contains("Word"), "{error}"),
            Ok(extracted) => assert!(extracted.text.len() <= MAX_TEXT_BYTES),
        }
    }

    #[test]
    fn plain_text_is_utf8_without_nul_and_capped() {
        assert_eq!(plain_text(b"\xEF\xBB\xBFhello").unwrap().text, "hello");
        assert!(plain_text(b"a\0b").unwrap_err().contains("binary"));
        assert!(plain_text(&[0xff, 0xfe, 0x41]).unwrap_err().contains("UTF-8"));
        let big = "é".repeat(MAX_TEXT_BYTES); // 2 bytes each: twice the cap
        let capped = plain_text(big.as_bytes()).unwrap();
        assert!(capped.truncated);
        assert!(capped.text.len() <= MAX_TEXT_BYTES);
        assert!(capped.text.chars().all(|c| c == 'é'), "cut on a character boundary");
    }
}
