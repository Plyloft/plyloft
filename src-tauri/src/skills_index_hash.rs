//! Skills hub H7 (`docs/plans/SKILLS_HUB.md` §7.3): **content ids in
//! process** — git's own tree hashing, with no `git` process per skill.
//!
//! A skill's content id is the git tree id of its directory: SHA-1 over
//! `blob <len>\0<bytes>` for each file, and over the tree entry format
//! (`<mode> <name>\0<20-byte id>`, entries in git's order, a directory sorted
//! as if its name ended in `/`) for each directory. Equal ids are the same
//! skill byte for byte, executable bits included — the same id
//! `checkout_root_tree` asks git for, so the index and the Library agree.
//!
//! **Line endings and modes (§8): `git hash-object --path`'s rules.** A
//! checkout's files are hashed as git would store them: `core.autocrlf` as
//! the default, then the `text` / `eol` / `crlf` / `binary` attributes of the
//! global file, `.gitattributes` from the repository's top down to the file
//! and `info/attributes` ([`Eol`]). `text` stores CRLF pairs as LF; `auto`
//! (autocrlf, `text=auto`) does too unless git's `gather_stats` guesses the
//! file binary (a NUL, a lone CR, too many control bytes — counted exactly as
//! git counts). A file whose attributes ask for a conversion only git can make
//! (`filter=`, `ident`, `working-tree-encoding`) gives its directory no id.
//! Where the executable bit means nothing (`core.fileMode` false, always on
//! Windows) the mode is `HEAD`'s, as the Library's `as_git_records` takes it.
//! Files over 1 MB are hashed streaming (two passes when converting: one to
//! learn the length git would store, one to hash).
//!
//! **What is refused.** A symbolic link anywhere in the directory (the CLIs and
//! the publish path refuse one too), more than [`super::MAX_FILES`] files (or
//! four times as many entries, folders counted), or a directory named in the
//! watcher's noisy list (`node_modules`, `target`, …) inside a skill: no id,
//! and the row says *Too many files to index*. A file whose bytes are only in
//! the cloud (iCloud Drive's dataless files, a Windows offline file) is never
//! read — reading it would download it — so its directory has no id. OS junk
//! (`.DS_Store`, `Thumbs.db`, `desktop.ini`) is never part of a skill, and in
//! the index ([`walk_skill`]) neither is a `.git`: a clone of a skill is its
//! files, as git's own tree of it would be.

use std::io::Read;
use std::path::Path;

// ── SHA-1 ────────────────────────────────────────────────────────────

/// SHA-1, as git uses it for object ids. Not used for anything that needs
/// collision resistance: it names content the way git already names it.
pub(crate) struct Sha1 {
    state: [u32; 5],
    buffer: [u8; 64],
    buffered: usize,
    length: u64,
}

impl Sha1 {
    pub(crate) fn new() -> Self {
        Self {
            state: [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0],
            buffer: [0; 64],
            buffered: 0,
            length: 0,
        }
    }

    pub(crate) fn update(&mut self, mut data: &[u8]) {
        self.length = self.length.wrapping_add(data.len() as u64);
        if self.buffered > 0 {
            let take = (64 - self.buffered).min(data.len());
            self.buffer[self.buffered..self.buffered + take].copy_from_slice(&data[..take]);
            self.buffered += take;
            data = &data[take..];
            if self.buffered == 64 {
                let block = self.buffer;
                self.block(&block);
                self.buffered = 0;
            }
        }
        while data.len() >= 64 {
            let (block, rest) = data.split_at(64);
            self.block(block.try_into().expect("64-byte block"));
            data = rest;
        }
        if !data.is_empty() {
            self.buffer[..data.len()].copy_from_slice(data);
            self.buffered = data.len();
        }
    }

    pub(crate) fn finish(mut self) -> [u8; 20] {
        let bits = self.length.wrapping_mul(8);
        let mut pad = vec![0x80u8];
        let used = (self.buffered + 1) % 64;
        let zeros = if used <= 56 { 56 - used } else { 120 - used };
        pad.extend(std::iter::repeat(0u8).take(zeros));
        pad.extend_from_slice(&bits.to_be_bytes());
        // `update` would count the padding into the length; it is already
        // taken, so feed the blocks directly.
        let length = self.length;
        self.update(&pad);
        self.length = length;
        debug_assert_eq!(self.buffered, 0);
        let mut out = [0u8; 20];
        for (i, word) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    fn block(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 80];
        for (i, chunk) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = self.state;
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        for (slot, value) in self.state.iter_mut().zip([a, b, c, d, e]) {
            *slot = slot.wrapping_add(value);
        }
    }
}

pub(crate) fn hex(id: &[u8; 20]) -> String {
    id.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ── Blobs ────────────────────────────────────────────────────────────

/// How a file's bytes become the blob git would store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Normalise {
    /// As they are on disk.
    None,
    /// A text file's CRLF pairs as LF (`core.autocrlf` true or input).
    Crlf,
}

/// Above this a file is hashed in chunks rather than read whole.
pub(crate) const STREAM_ABOVE: u64 = 1024 * 1024;
const CHUNK: usize = 64 * 1024;

/// What git's `gather_stats` (convert.c) learns of a file, enough for its
/// binary rule — counted exactly as git counts: a CRLF pair and a lone LF
/// are neither printable nor not, and a final `^Z` (DOS EOF) is not held
/// against the file.
#[derive(Default)]
struct Stats {
    nul: bool,
    lone_cr: bool,
    crlf: u64,
    printable: u64,
    nonprintable: u64,
    last: Option<u8>,
}

impl Stats {
    fn feed(&mut self, bytes: &[u8], pending_cr: &mut bool) {
        for &byte in bytes {
            self.last = Some(byte);
            if *pending_cr {
                *pending_cr = false;
                if byte == b'\n' {
                    self.crlf += 1;
                    continue;
                }
                self.lone_cr = true;
            }
            match byte {
                b'\r' => *pending_cr = true,
                b'\n' => {}
                0 => {
                    self.nul = true;
                    self.nonprintable += 1;
                }
                b'\t' | 0x08 | 0x1b | 0x0c => self.printable += 1,
                127 => self.nonprintable += 1,
                byte if byte < 32 => self.nonprintable += 1,
                _ => self.printable += 1,
            }
        }
    }

    fn end(&mut self, pending_cr: bool) {
        if pending_cr {
            self.lone_cr = true;
        }
        if self.last == Some(0x1a) {
            self.nonprintable = self.nonprintable.saturating_sub(1);
        }
    }

    /// git's `convert_is_binary`: such a file is never converted by `auto`.
    fn binary(&self) -> bool {
        self.lone_cr || self.nul || (self.printable >> 7) < self.nonprintable
    }

    /// Whether `convert` changes these bytes.
    fn converts(&self, convert: Convert) -> bool {
        match convert {
            Convert::Raw => false,
            Convert::Text => self.crlf > 0,
            Convert::Auto => self.crlf > 0 && !self.binary(),
        }
    }
}

/// What `git add` (`git hash-object --path`) does to one file's line
/// endings, from `core.autocrlf` and the `text` / `eol` / `crlf` attributes
/// (convert.c `convert_attrs`, `crlf_to_git`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Convert {
    /// Stored as it is (no conversion, `-text`, `binary`).
    Raw,
    /// `text` (or `eol=`): every CRLF pair stored as LF, no binary guess.
    Text,
    /// `text=auto` or `core.autocrlf`: CRLF as LF unless git guesses binary.
    Auto,
}

impl From<Normalise> for Convert {
    fn from(normalise: Normalise) -> Self {
        match normalise {
            Normalise::None => Convert::Raw,
            Normalise::Crlf => Convert::Auto,
        }
    }
}

/// The blob id of `bytes` as git would store them.
pub(crate) fn blob_id_of(bytes: &[u8], convert: impl Into<Convert>) -> [u8; 20] {
    let convert = convert.into();
    if convert != Convert::Raw {
        let mut stats = Stats::default();
        let mut pending = false;
        stats.feed(bytes, &mut pending);
        stats.end(pending);
        if stats.converts(convert) {
            let mut out = Vec::with_capacity(bytes.len());
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            return raw_blob_id(&out);
        }
    }
    raw_blob_id(bytes)
}

fn raw_blob_id(bytes: &[u8]) -> [u8; 20] {
    let mut sha = Sha1::new();
    sha.update(format!("blob {}\0", bytes.len()).as_bytes());
    sha.update(bytes);
    sha.finish()
}

/// The blob id of the file at `path` (`len` bytes on disk).
pub(crate) fn blob_id_of_file(path: &Path, len: u64, convert: impl Into<Convert>) -> std::io::Result<[u8; 20]> {
    let convert = convert.into();
    if len <= STREAM_ABOVE {
        return Ok(blob_id_of(&std::fs::read(path)?, convert));
    }
    // Streaming. First pass only when the bytes might be converted.
    let mut converts = false;
    let mut stored = len;
    if convert != Convert::Raw {
        let mut stats = Stats::default();
        let mut pending = false;
        let mut file = std::fs::File::open(path)?;
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            stats.feed(&buf[..n], &mut pending);
        }
        stats.end(pending);
        converts = stats.converts(convert);
        if converts {
            stored = len - stats.crlf;
        }
    }
    let mut sha = Sha1::new();
    sha.update(format!("blob {stored}\0").as_bytes());
    let mut file = std::fs::File::open(path)?;
    let mut buf = vec![0u8; CHUNK];
    let mut held_cr = false;
    let mut out = Vec::with_capacity(CHUNK);
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        if !converts {
            sha.update(&buf[..n]);
            continue;
        }
        out.clear();
        for &byte in &buf[..n] {
            if held_cr {
                held_cr = false;
                if byte != b'\n' {
                    out.push(b'\r');
                }
            }
            if byte == b'\r' {
                held_cr = true;
            } else {
                out.push(byte);
            }
        }
        sha.update(&out);
    }
    if held_cr {
        sha.update(b"\r");
    }
    Ok(sha.finish())
}

// ── Trees ────────────────────────────────────────────────────────────

/// One file of a skill directory, as walked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WalkedFile {
    /// Relative to the skill directory, with `/`.
    pub rel: String,
    pub size: u64,
    /// Modification time, ms since the epoch (0 when the platform has none).
    pub mtime_ms: i64,
    pub executable: bool,
}

/// Why a directory has no content id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// A symbolic link (or a junction) inside it.
    Link,
    /// More than the file cap, or a noisy directory inside it.
    TooMany,
    /// It could not be read.
    Unreadable,
}

/// Every file under `dir`, sorted by path, OS junk left out. Never follows a
/// link; stops at `cap` files.
pub(crate) fn walk(dir: &Path, cap: usize) -> Result<Vec<WalkedFile>, Refusal> {
    walk_with(dir, cap, false)
}

/// [`walk`] for All skills' index: a `.git` (folder or file, at any depth, in
/// any case, as `project_skills::private_entry` reads it) isn't entered or
/// counted, so a skill that is a clone isn't *Too many files to index*. Copying
/// keeps [`walk`], whose refusal stands for a skill that holds one.
///
/// Round 3 (S3): a file git ignores in that folder is no part of the skill
/// ([`crate::skill_ignored`]) — a publish leaves it out, so the id leaves it
/// out too, or the row would read "modified here" for good.
pub(crate) fn walk_skill(dir: &Path, cap: usize) -> Result<Vec<WalkedFile>, Refusal> {
    let mut files = walk_with(dir, cap, true)?;
    let left = {
        let rels: Vec<&str> = files.iter().map(|file| file.rel.as_str()).collect();
        crate::skill_ignored::left_out(dir, &rels)
    };
    if !left.is_empty() {
        files.retain(|file| !left.contains(&file.rel));
    }
    Ok(files)
}

/// Whether a `/`-separated path relative to a skill is inside a `.git`.
pub(crate) fn is_in_git(rel: &str) -> bool {
    rel.split('/').any(|part| part.eq_ignore_ascii_case(".git"))
}

fn walk_with(dir: &Path, cap: usize, skip_git: bool) -> Result<Vec<WalkedFile>, Refusal> {
    let mut out = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), String::new())];
    // Every entry counts, folders too: a skill of 100,000 empty folders is
    // refused as soon as one of a few files would be.
    let mut seen = 0usize;
    while let Some((at, prefix)) = stack.pop() {
        let entries = std::fs::read_dir(&at).map_err(|_| Refusal::Unreadable)?;
        for entry in entries {
            let entry = entry.map_err(|_| Refusal::Unreadable)?;
            if skip_git && entry.file_name().eq_ignore_ascii_case(".git") {
                continue;
            }
            seen += 1;
            if seen > cap.saturating_mul(4) {
                return Err(Refusal::TooMany);
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                return Err(Refusal::Unreadable);
            };
            let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let meta = std::fs::symlink_metadata(entry.path()).map_err(|_| Refusal::Unreadable)?;
            if meta.file_type().is_symlink() || is_reparse_point(&meta) {
                return Err(Refusal::Link);
            }
            if meta.is_dir() {
                if crate::watcher::is_noisy_dir_name(&name) {
                    return Err(Refusal::TooMany);
                }
                stack.push((entry.path(), rel));
            } else if meta.is_file() {
                if crate::shared_library_sync::is_os_junk(&rel) {
                    continue;
                }
                // A file whose bytes are in the cloud only (iCloud Drive's
                // dataless files, an offline file): reading it would download
                // it, so the directory has no id rather than a fetch.
                if not_on_disk(&meta) {
                    return Err(Refusal::Unreadable);
                }
                out.push(WalkedFile {
                    rel,
                    size: meta.len(),
                    mtime_ms: mtime_ms(&meta),
                    executable: executable(&meta),
                });
                if out.len() > cap {
                    return Err(Refusal::TooMany);
                }
            }
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

/// macOS `SF_DATALESS` (iCloud Drive "Optimise Mac Storage"); Windows
/// offline / recall-on-access files (OneDrive's are reparse points too, and
/// refused as links before this).
#[cfg(target_os = "macos")]
fn not_on_disk(meta: &std::fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    const SF_DATALESS: u32 = 0x4000_0000;
    meta.st_flags() & SF_DATALESS != 0
}

#[cfg(windows)]
fn not_on_disk(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const OFFLINE: u32 = 0x1000;
    const RECALL_ON_OPEN: u32 = 0x4_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;
    meta.file_attributes() & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0
}

#[cfg(not(any(target_os = "macos", windows)))]
fn not_on_disk(_meta: &std::fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &std::fs::Metadata) -> bool {
    false
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    // git records 100755 when the owner may execute it (`S_IXUSR`).
    meta.permissions().mode() & 0o100 != 0
}

/// Windows keeps no executable bit: every file reads `100644` here, and a
/// checkout's ids take `HEAD`'s modes instead ([`Eol`], `core.fileMode`
/// false), as git and the Library do.
#[cfg(not(unix))]
fn executable(_meta: &std::fs::Metadata) -> bool {
    false
}

/// What decides whether a directory's id must be computed again: every
/// file's path, size, modification time and executable bit.
pub(crate) fn fingerprint(files: &[WalkedFile]) -> String {
    let mut sha = Sha1::new();
    for file in files {
        sha.update(file.rel.as_bytes());
        sha.update(format!("\0{}\0{}\0{}\n", file.size, file.mtime_ms, file.executable as u8).as_bytes());
    }
    hex(&sha.finish())
}

/// The git tree id of `dir` made of `files` (as [`walk`] returned them),
/// leaving out each file `skip` names. `None` when a file can't be read, a
/// file's attributes ask for a filter git applies and this can't (`filter=`,
/// `ident`, `working-tree-encoding`), or nothing is left (git has no tree
/// for an empty directory).
pub(crate) fn tree_id(dir: &Path, files: &[WalkedFile], eol: impl Into<Eol>, skip: impl Fn(&str) -> bool) -> Option<String> {
    let eol = eol.into();
    let plan = eol.plan(dir, files)?;
    let mut entries: Vec<(String, bool, [u8; 20])> = Vec::with_capacity(files.len());
    for (file, (convert, executable)) in files.iter().zip(plan).filter(|(file, _)| !skip(&file.rel)) {
        let path = file.rel.split('/').fold(dir.to_path_buf(), |at, part| at.join(part));
        let id = blob_id_of_file(&path, file.size, convert).ok()?;
        entries.push((file.rel.clone(), executable, id));
    }
    tree_of_blobs(&entries).map(|id| hex(&id))
}

/// The tree id of files given by relative path, executable bit and blob id.
pub(crate) fn tree_of_blobs(files: &[(String, bool, [u8; 20])]) -> Option<[u8; 20]> {
    fn build(files: &[(&str, bool, [u8; 20])]) -> Option<[u8; 20]> {
        // name → (is_dir, entry)
        let mut blobs: Vec<(String, &'static str, [u8; 20])> = Vec::new();
        let mut dirs: std::collections::BTreeMap<String, Vec<(&str, bool, [u8; 20])>> = Default::default();
        for (rel, exec, id) in files {
            match rel.split_once('/') {
                Some((head, rest)) => dirs.entry(head.to_string()).or_default().push((rest, *exec, *id)),
                None => blobs.push((rel.to_string(), if *exec { "100755" } else { "100644" }, *id)),
            }
        }
        let mut entries: Vec<(String, String, &'static str, [u8; 20])> = blobs
            .into_iter()
            .map(|(name, mode, id)| (name.clone(), name, mode, id))
            .collect();
        for (name, children) in dirs {
            if let Some(id) = build(&children) {
                entries.push((format!("{name}/"), name, "40000", id));
            }
        }
        if entries.is_empty() {
            return None;
        }
        // git's order: by name bytes, a directory as if its name ended in `/`.
        entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let mut body = Vec::new();
        for (_, name, mode, id) in &entries {
            body.extend_from_slice(mode.as_bytes());
            body.push(b' ');
            body.extend_from_slice(name.as_bytes());
            body.push(0);
            body.extend_from_slice(id);
        }
        let mut sha = Sha1::new();
        sha.update(format!("tree {}\0", body.len()).as_bytes());
        sha.update(&body);
        Some(sha.finish())
    }
    let borrowed: Vec<(&str, bool, [u8; 20])> = files.iter().map(|(rel, exec, id)| (rel.as_str(), *exec, *id)).collect();
    build(&borrowed)
}

// ── Attributes (§8 line endings) ─────────────────────────────────────

/// How a directory's files are stored by git: `core.autocrlf` as the
/// default, and — inside a repository — its attributes files, and where the
/// executable bit means nothing (`core.fileMode` false: always on Windows)
/// the modes `HEAD` records, as the Library's `as_git_records` takes them. A
/// plain folder (this Mac's, Plyloft's, a mirror of stored blobs) has none.
#[derive(Debug, Clone)]
pub(crate) struct Eol {
    pub default: Normalise,
    pub attrs: Option<std::sync::Arc<Attrs>>,
    pub modes: Option<std::sync::Arc<HeadModes>>,
}

impl From<Normalise> for Eol {
    fn from(default: Normalise) -> Self {
        Eol { default, attrs: None, modes: None }
    }
}

/// The executable bits `HEAD` records, by repository path, read once — and
/// only when a directory's id must be computed (a warm refresh reads none).
pub(crate) struct HeadModes {
    load: Box<dyn Fn() -> std::collections::HashMap<String, bool> + Send + Sync>,
    map: std::sync::OnceLock<std::collections::HashMap<String, bool>>,
}

impl HeadModes {
    pub(crate) fn new(load: impl Fn() -> std::collections::HashMap<String, bool> + Send + Sync + 'static) -> Self {
        HeadModes { load: Box::new(load), map: std::sync::OnceLock::new() }
    }

    /// `100755` at `HEAD`; a file `HEAD` doesn't have is `100644`.
    fn executable(&self, path: &str) -> bool {
        self.map.get_or_init(|| (self.load)()).get(path).copied().unwrap_or(false)
    }
}

impl std::fmt::Debug for HeadModes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HeadModes")
    }
}

impl From<&Eol> for Eol {
    fn from(eol: &Eol) -> Self {
        eol.clone()
    }
}

/// A repository's attribute rules outside the skill directories: the global
/// file, `.gitattributes` at the root and along the skill roots (`low`), and
/// `$GIT_DIR/info/attributes` (`high`, git's highest).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Attrs {
    pub root: std::path::PathBuf,
    pub low: Vec<AttrRule>,
    pub high: Vec<AttrRule>,
    /// Names these rules in the directory cache's key.
    pub tag: String,
}

/// An attribute as a rule leaves it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AttrState {
    Set,
    Unset,
    Value(String),
    /// `!name`: back to unspecified.
    Unspecified,
}

/// One line of an attributes file: its pattern, where it applies from
/// (`base`, repository-relative, `""` at the root), and the attributes that
/// decide how its files are stored.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct AttrRule {
    pub base: String,
    pub pattern: String,
    pub text: Option<AttrState>,
    pub crlf: Option<AttrState>,
    pub eol: Option<AttrState>,
    /// `filter`, `ident`, `working-tree-encoding`: a conversion git runs that
    /// this does not — such a file has no in-process id.
    pub opaque: Option<bool>,
}

/// The rules of one attributes file whose directory is `base`.
pub(crate) fn parse_attributes(text: &str, base: &str) -> Vec<AttrRule> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("[attr]") || line.starts_with('"') {
            continue;
        }
        let mut words = line.split_whitespace();
        let Some(pattern) = words.next() else { continue };
        // A directory pattern (`docs/`) never applies to files (gitattributes(5)).
        if pattern.ends_with('/') || pattern.starts_with('!') {
            continue;
        }
        let mut rule = AttrRule { base: base.to_string(), pattern: pattern.to_string(), ..Default::default() };
        for word in words {
            let (name, state) = if let Some(name) = word.strip_prefix('-') {
                (name, AttrState::Unset)
            } else if let Some(name) = word.strip_prefix('!') {
                (name, AttrState::Unspecified)
            } else if let Some((name, value)) = word.split_once('=') {
                (name, AttrState::Value(value.to_string()))
            } else {
                (word, AttrState::Set)
            };
            match name {
                "text" => rule.text = Some(state),
                "crlf" => rule.crlf = Some(state),
                "eol" => rule.eol = Some(state),
                "binary" if state == AttrState::Set => rule.text = Some(AttrState::Unset),
                "filter" | "ident" | "working-tree-encoding" => {
                    rule.opaque = Some(matches!(state, AttrState::Set | AttrState::Value(_)))
                }
                _ => {}
            }
        }
        if rule.text.is_some() || rule.crlf.is_some() || rule.eol.is_some() || rule.opaque.is_some() {
            out.push(rule);
        }
    }
    out
}

impl AttrRule {
    /// Whether this rule names `path` (repository-relative, `/`-separated).
    fn matches(&self, path: &str) -> bool {
        let rest = if self.base.is_empty() {
            path
        } else {
            match path.strip_prefix(self.base.as_str()).and_then(|r| r.strip_prefix('/')) {
                Some(rest) => rest,
                None => return false,
            }
        };
        let pattern = self.pattern.as_bytes();
        if self.pattern.contains('/') {
            let pattern = pattern.strip_prefix(b"/").unwrap_or(pattern);
            wildmatch(pattern, rest.as_bytes())
        } else {
            let name = rest.rsplit('/').next().unwrap_or(rest);
            wildmatch(pattern, name.as_bytes())
        }
    }
}

/// git's `wildmatch` with `WM_PATHNAME`: `*` and `?` stop at `/`, `**`
/// between slashes spans directories, `[...]` classes, `\` escapes.
pub(crate) fn wildmatch(p: &[u8], t: &[u8]) -> bool {
    match p.first() {
        None => t.is_empty(),
        Some(b'*') if p.get(1) == Some(&b'*') => {
            let rest = &p[2..];
            if let Some(after) = rest.strip_prefix(b"/") {
                // `**/`: zero or more whole directories.
                (0..=t.len()).any(|i| (i == 0 || t[i - 1] == b'/') && wildmatch(after, &t[i..]))
            } else {
                (0..=t.len()).any(|i| wildmatch(rest, &t[i..]))
            }
        }
        Some(b'*') => {
            let rest = &p[1..];
            for i in 0..=t.len() {
                if wildmatch(rest, &t[i..]) {
                    return true;
                }
                if i < t.len() && t[i] == b'/' {
                    break;
                }
            }
            false
        }
        Some(b'?') => t.first().is_some_and(|&c| c != b'/') && wildmatch(&p[1..], &t[1..]),
        Some(b'[') => {
            let Some(&c) = t.first() else { return false };
            match class(&p[1..], c) {
                Some((hit, used)) => hit && c != b'/' && wildmatch(&p[1 + used..], &t[1..]),
                None => c == b'[' && wildmatch(&p[1..], &t[1..]),
            }
        }
        Some(b'\\') if p.len() > 1 => t.first() == Some(&p[1]) && wildmatch(&p[2..], &t[1..]),
        Some(&c) => t.first() == Some(&c) && wildmatch(&p[1..], &t[1..]),
    }
}

/// A `[...]` class after its `[`: whether `c` is in it, and the bytes it
/// takes up to and with its `]`. `None`: no closing `]` (a literal `[`).
fn class(p: &[u8], c: u8) -> Option<(bool, usize)> {
    let mut i = 0;
    let negate = matches!(p.first(), Some(b'!') | Some(b'^'));
    if negate {
        i += 1;
    }
    let mut hit = false;
    let mut first = true;
    while i < p.len() {
        let at = p[i];
        if at == b']' && !first {
            return Some((hit != negate, i + 1));
        }
        first = false;
        if i + 2 < p.len() && p[i + 1] == b'-' && p[i + 2] != b']' {
            if (at..=p[i + 2]).contains(&c) {
                hit = true;
            }
            i += 3;
        } else {
            if at == c {
                hit = true;
            }
            i += 1;
        }
    }
    None
}

impl Eol {
    /// How each of `files` (under `dir`) is stored, in order, with the
    /// executable bit git records — `None` when one needs a conversion only
    /// git can make.
    pub(crate) fn plan(&self, dir: &Path, files: &[WalkedFile]) -> Option<Vec<(Convert, bool)>> {
        let default = Convert::from(self.default);
        let as_walked = || Some(files.iter().map(|f| (default, f.executable)).collect());
        let Some(attrs) = self.attrs.as_deref() else {
            return as_walked();
        };
        let Some(prefix) = dir.strip_prefix(&attrs.root).ok().and_then(|rel| {
            rel.components().map(|c| c.as_os_str().to_str()).collect::<Option<Vec<_>>>().map(|parts| parts.join("/"))
        }) else {
            return as_walked();
        };
        let join = |rel: &str| if prefix.is_empty() { rel.to_string() } else { format!("{prefix}/{rel}") };
        // `.gitattributes` inside the skill: deeper ones above shallower.
        let mut inner: Vec<(usize, Vec<AttrRule>)> = files
            .iter()
            .filter(|f| f.rel == ".gitattributes" || f.rel.ends_with("/.gitattributes"))
            .filter_map(|f| {
                let text = std::fs::read_to_string(dir.join(&f.rel)).ok()?;
                let at = f.rel.rsplit_once('/').map(|(d, _)| join(d)).unwrap_or_else(|| prefix.clone());
                Some((f.rel.matches('/').count(), parse_attributes(&text, &at)))
            })
            .collect();
        inner.sort_by_key(|(depth, _)| *depth);
        let rules: Vec<&AttrRule> =
            attrs.low.iter().chain(inner.iter().flat_map(|(_, r)| r.iter())).chain(attrs.high.iter()).collect();
        files
            .iter()
            .map(|f| {
                let path = join(&f.rel);
                let executable = self.modes.as_deref().map_or(f.executable, |modes| modes.executable(&path));
                convert_of(&rules, &path, self.default).map(|convert| (convert, executable))
            })
            .collect()
    }
}

/// convert.c's decision for one path: the last rule naming each attribute
/// wins.
fn convert_of(rules: &[&AttrRule], path: &str, default: Normalise) -> Option<Convert> {
    let mut text = None;
    let mut crlf = None;
    let mut eol = None;
    let mut opaque = false;
    for rule in rules.iter().filter(|rule| rule.matches(path)) {
        if let Some(state) = &rule.text {
            text = Some(state);
        }
        if let Some(state) = &rule.crlf {
            crlf = Some(state);
        }
        if let Some(state) = &rule.eol {
            eol = Some(state);
        }
        if let Some(on) = rule.opaque {
            opaque = on;
        }
    }
    if opaque {
        return None;
    }
    #[derive(PartialEq)]
    enum Action {
        Undefined,
        Binary,
        Text,
        Auto,
    }
    let action_of = |state: Option<&AttrState>| match state {
        Some(AttrState::Set) => Action::Text,
        Some(AttrState::Unset) => Action::Binary,
        Some(AttrState::Value(v)) if v == "input" => Action::Text,
        Some(AttrState::Value(v)) if v == "auto" => Action::Auto,
        _ => Action::Undefined,
    };
    let mut action = action_of(text);
    if action == Action::Undefined {
        action = action_of(crlf);
    }
    let eol_set = matches!(eol, Some(AttrState::Value(v)) if v == "lf" || v == "crlf");
    if action == Action::Undefined && eol_set {
        action = Action::Text;
    }
    Some(match action {
        Action::Binary => Convert::Raw,
        Action::Text => Convert::Text,
        Action::Auto => Convert::Auto,
        Action::Undefined => Convert::from(default),
    })
}
