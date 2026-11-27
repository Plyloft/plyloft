//! Ply's own dictation, for the tiles that have none (#47): Codex (the `codex`
//! TUI and `codex-chat`) and shell tiles. Claude tiles keep Claude Code's
//! `/voice`, and Ply never intercepts Space there.
//!
//! The webview captures and encodes the audio (16 kHz mono WAV, no ffmpeg or
//! SoX). Everything after that lives here: the model files, the
//! `whisper-cli` run and its timeout, the temp WAV's removal, and exit
//! cleanup of every child this module starts (Hard Rule #4). Local only —
//! whisper.cpp from Homebrew, no cloud and no API key.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The Homebrew formula is `whisper.cpp` (`whisper-cpp` is a rename alias);
/// the binary it installs is `whisper-cli`.
pub const WHISPER_CLI: &str = "whisper-cli";
pub const WHISPER_INSTALL_CMD: &str = "brew install whisper.cpp";
/// Windows has no one-line whisper.cpp install, so Ply says so instead of
/// offering a command.
pub const WHISPER_UNAVAILABLE: &str =
    "Optional — dictation in Codex and shell tiles isn't available on Windows yet: whisper.cpp has no one-line install there.";

/// What a dictation that finds no whisper-cli tells the person.
pub fn whisper_missing_message() -> String {
    match crate::doctor::install_cmd(WHISPER_CLI) {
        Some(cmd) => format!("whisper-cli isn't installed. Run `{cmd}`."),
        None => "whisper-cli isn't installed, and dictation's local model isn't available on Windows yet.".into(),
    }
}
pub const WHISPER_DOCS: &str = "https://github.com/ggml-org/whisper.cpp";
const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
/// Every whisper.cpp model file starts with the ggml magic `0x67676d6c`,
/// written little-endian.
const GGML_MAGIC: [u8; 4] = *b"lmgg";
/// Smaller than any real multilingual model (base is ~142 MB). Keeps a
/// truncated download or a stray test model from reading as "ready".
const MIN_MODEL_BYTES: u64 = 10 * 1024 * 1024;
/// Five minutes of 16 kHz mono 16-bit PCM. The frontend stops a recording
/// long before this; the cap only refuses a malformed payload.
pub const MAX_WAV_BYTES: usize = 5 * 60 * 16_000 * 2 + 44;
/// Brew prefixes, consulted after the cached PATH: a GUI app's login-shell
/// probe can fail, and dictation should not then read as "not installed".
const BREW_BIN_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

/// The multilingual models Ply offers. English-only (`.en`) models are not
/// offered: the owner dictates in Italian as well as English.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "camelCase")]
pub enum DictationModel {
    #[default]
    Small,
    Base,
}

impl DictationModel {
    pub const ALL: [DictationModel; 2] = [DictationModel::Small, DictationModel::Base];

    pub fn as_str(self) -> &'static str {
        match self {
            DictationModel::Small => "small",
            DictationModel::Base => "base",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|model| model.as_str() == raw)
    }

    pub fn file_name(self) -> &'static str {
        match self {
            DictationModel::Small => "ggml-small.bin",
            DictationModel::Base => "ggml-base.bin",
        }
    }

    /// For display before a download starts ("~466 MB"). The download
    /// itself checks against the server's Content-Length.
    pub fn approx_bytes(self) -> u64 {
        match self {
            DictationModel::Small => 466 * 1024 * 1024,
            DictationModel::Base => 142 * 1024 * 1024,
        }
    }

    pub fn url(self) -> String {
        format!("{MODEL_BASE_URL}/{}", self.file_name())
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum DictationLanguage {
    #[default]
    Auto,
    It,
    En,
}

impl DictationLanguage {
    /// whisper-cli's `-l` value.
    pub fn as_arg(self) -> &'static str {
        match self {
            DictationLanguage::Auto => "auto",
            DictationLanguage::It => "it",
            DictationLanguage::En => "en",
        }
    }
}

/// Why a transcription or download did not produce its result. `kind` is
/// what the frontend branches on (which doctor row a toast names); `message`
/// is safe to show as-is.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct DictationError {
    pub kind: DictationErrorKind,
    pub message: String,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DictationErrorKind {
    WhisperMissing,
    ModelMissing,
    InvalidAudio,
    Timeout,
    Cancelled,
    Busy,
    Quitting,
    Failed,
}

impl DictationError {
    fn new(kind: DictationErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

// ── model files ─────────────────────────────────────────────────────────

/// `~/Library/Application Support/com.mbadv.ply/whisper/models/`.
pub fn models_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("whisper").join("models")
}

pub fn model_path(config_dir: &Path, model: DictationModel) -> PathBuf {
    models_dir(config_dir).join(model.file_name())
}

/// A model counts as present only when it is a plausibly sized ggml file,
/// so a truncated or foreign file reads as missing rather than failing
/// inside whisper-cli after the user has already spoken.
pub fn model_present(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let big_enough = file
        .metadata()
        .map(|meta| meta.is_file() && meta.len() >= MIN_MODEL_BYTES)
        .unwrap_or(false);
    let mut magic = [0u8; 4];
    big_enough && file.read_exact(&mut magic).is_ok() && magic == GGML_MAGIC
}

/// Resolve `whisper-cli` against the cached login-shell PATH, then the brew
/// prefixes.
pub fn resolve_whisper_cli(env_path: &str) -> Option<String> {
    crate::shell_env::find_in_path(env_path, WHISPER_CLI).or_else(|| {
        crate::shell_env::find_in_path(&crate::platform::join_path_list(&BREW_BIN_DIRS), WHISPER_CLI)
    })
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: DictationModel,
    pub file_name: &'static str,
    pub path: String,
    pub present: bool,
    pub size_bytes: Option<u64>,
    pub approx_bytes: u64,
    pub downloading: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    pub whisper_cli: Option<String>,
    pub models: Vec<ModelStatus>,
}

pub fn status(config_dir: &Path, env_path: &str, jobs: &JobRegistry) -> DictationStatus {
    let models = DictationModel::ALL
        .into_iter()
        .map(|model| {
            let path = model_path(config_dir, model);
            let present = model_present(&path);
            ModelStatus {
                id: model,
                file_name: model.file_name(),
                size_bytes: present
                    .then(|| std::fs::metadata(&path).ok().map(|meta| meta.len()))
                    .flatten(),
                path: path.to_string_lossy().to_string(),
                present,
                approx_bytes: model.approx_bytes(),
                downloading: jobs.is_running(&download_key(model)),
            }
        })
        .collect();
    DictationStatus {
        whisper_cli: resolve_whisper_cli(env_path),
        models,
    }
}

// ── whisper-cli ─────────────────────────────────────────────────────────

/// `whisper-cli -m <model> -f <wav> -l <lang|auto> -nt -np`: no timestamps,
/// nothing on stdout but the transcription.
pub fn whisper_argv(model: &Path, wav: &Path, language: DictationLanguage) -> Vec<String> {
    vec![
        "-m".into(),
        model.to_string_lossy().to_string(),
        "-f".into(),
        wav.to_string_lossy().to_string(),
        "-l".into(),
        language.as_arg().into(),
        "-nt".into(),
        "-np".into(),
    ]
}

/// whisper-cli's stdout to the one line of text inserted into the prompt.
///
/// Segments arrive one per line with a leading space. Non-speech
/// annotations are dropped: `[BLANK_AUDIO]`, `[MUSIC]` and friends anywhere,
/// and a segment that is wholly `(…)` or `*…*` (`(silence)`, `*music*`).
/// Control characters become spaces — the text is typed into a PTY, where
/// an ESC or a ^C is an action, not a letter — and whitespace collapses, so
/// no newline can ever reach a prompt and submit it.
pub fn parse_transcript(stdout: &str) -> String {
    let mut out = String::new();
    for line in stdout.lines() {
        let printable: String = line
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        let without_brackets = strip_bracketed(&printable);
        let segment = without_brackets.trim();
        let annotation = (segment.starts_with('(') && segment.ends_with(')'))
            || (segment.len() > 1 && segment.starts_with('*') && segment.ends_with('*'));
        if segment.is_empty() || annotation {
            continue;
        }
        out.push(' ');
        out.push_str(segment);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Drop each `[…]` group. A `[` that never closes on its line is text, not
/// the start of an annotation, and is kept with everything after it.
fn strip_bracketed(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        let Some(close) = rest[open..].find(']') else {
            break;
        };
        out.push_str(&rest[..open]);
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    out
}

/// The audio length a canonical PCM WAV header describes.
pub fn wav_duration(bytes: &[u8]) -> Duration {
    if bytes.len() < 44 {
        return Duration::ZERO;
    }
    let byte_rate = u32::from_le_bytes([bytes[28], bytes[29], bytes[30], bytes[31]]);
    if byte_rate == 0 {
        return Duration::ZERO;
    }
    Duration::from_secs_f64((bytes.len() - 44) as f64 / byte_rate as f64)
}

/// Generous for a model's first load (Metal shader setup included), bounded
/// so a wedged run can never leave the tile in "Transcribing…" for good.
pub fn transcribe_timeout(audio: Duration) -> Duration {
    (Duration::from_secs(30) + audio * 4).min(Duration::from_secs(600))
}

fn validate_wav(bytes: &[u8]) -> Result<(), DictationError> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(DictationError::new(
            DictationErrorKind::InvalidAudio,
            "The recording is not a WAV file.",
        ));
    }
    if bytes.len() > MAX_WAV_BYTES {
        return Err(DictationError::new(
            DictationErrorKind::InvalidAudio,
            "The recording is longer than five minutes.",
        ));
    }
    Ok(())
}

pub struct TranscribeRequest<'a> {
    pub whisper_cli: &'a Path,
    pub model: &'a Path,
    pub language: DictationLanguage,
    pub wav: &'a [u8],
    /// Reserved under the frontend's request id before any work starts, so
    /// a cancel that arrives while the request is still queued or writing
    /// its WAV stops it before whisper-cli runs.
    pub job: &'a JobReservation<'a>,
    pub env_path: &'a str,
}

/// Write the WAV to a temp file, run whisper-cli on it under a timeout,
/// and return the parsed text. The temp file is removed on every path out.
pub fn transcribe(
    request: TranscribeRequest<'_>,
    timeout: Option<Duration>,
) -> Result<String, DictationError> {
    validate_wav(request.wav)?;
    request.job.check_cancelled()?;
    let failed = |e: std::io::Error| {
        DictationError::new(DictationErrorKind::Failed, format!("temp WAV: {e}"))
    };
    // Dropping the handle deletes the file, whatever happens below.
    let mut wav = tempfile::Builder::new()
        .prefix("ply-dictation-")
        .suffix(".wav")
        .tempfile()
        .map_err(failed)?;
    wav.write_all(request.wav).map_err(failed)?;
    wav.flush().map_err(failed)?;

    let mut cmd = crate::platform::new_command(request.whisper_cli);
    cmd.args(whisper_argv(request.model, wav.path(), request.language))
        .env("PATH", request.env_path);
    let timeout = timeout.unwrap_or_else(|| transcribe_timeout(wav_duration(request.wav)));
    let run = request.job.run(&mut cmd, timeout, &|| {})?;
    if !run.status.success() {
        return Err(DictationError::new(
            DictationErrorKind::Failed,
            format!("whisper-cli failed ({}): {}", run.status, stderr_tail(&run.stderr)),
        ));
    }
    Ok(parse_transcript(&run.stdout))
}

fn stderr_tail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(2)..].join(" · ");
    if tail.is_empty() {
        "no error output".into()
    } else {
        tail
    }
}

// ── model download ──────────────────────────────────────────────────────

pub fn download_key(model: DictationModel) -> String {
    format!("download:{}", model.as_str())
}

/// The final response's Content-Length from `curl -sSIL` output (one
/// header block per redirect hop). Each status line starts a new block, so a
/// redirect's own length is never mistaken for the model's when the final
/// response carries none.
pub fn parse_content_length(headers: &str) -> Option<u64> {
    let mut length = None;
    for line in headers.lines() {
        if line.starts_with("HTTP/") {
            length = None;
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<u64>().ok();
            }
        }
    }
    length
}

/// Download `model` into the models directory through `curl` (its own
/// process group, registered for exit cleanup), reporting progress as the
/// partial file grows. Written to `<file>.part` and renamed into place only
/// once it is complete and carries the ggml magic, so a model file is never
/// half-written.
///
/// `job` is the caller's reservation of [`download_key`]`(model)`, taken
/// before the work is queued: one reservation covers the queue, the size
/// check and the transfer, so Cancel at any of them ends the download, and a
/// second click while this model downloads is refused at `reserve`, before
/// its `.part` is touched.
pub fn download_model(
    job: &JobReservation<'_>,
    config_dir: &Path,
    model: DictationModel,
    on_progress: &dyn Fn(u64, Option<u64>),
) -> Result<PathBuf, DictationError> {
    download_model_with(job, config_dir, model, Path::new("/usr/bin/curl"), on_progress)
}

fn download_model_with(
    job: &JobReservation<'_>,
    config_dir: &Path,
    model: DictationModel,
    curl: &Path,
    on_progress: &dyn Fn(u64, Option<u64>),
) -> Result<PathBuf, DictationError> {
    let failed = |message: String| DictationError::new(DictationErrorKind::Failed, message);
    job.check_cancelled()?;
    let dir = models_dir(config_dir);
    std::fs::create_dir_all(&dir).map_err(|e| failed(format!("create {}: {e}", dir.display())))?;
    let target = dir.join(model.file_name());
    let part = dir.join(format!("{}.part", model.file_name()));
    let url = model.url();

    let mut head = crate::platform::new_command(curl);
    head.args(["-sSIL", "--max-time", "30", &url]);
    // The size only drives progress: a failed or slow HEAD downloads without
    // it, but a cancelled one stops here.
    let total = match job.run(&mut head, Duration::from_secs(40), &|| {}) {
        Ok(run) if run.status.success() => parse_content_length(&run.stdout),
        Err(error)
            if matches!(error.kind, DictationErrorKind::Cancelled | DictationErrorKind::Quitting) =>
        {
            return Err(error)
        }
        _ => None,
    };

    let mut get = crate::platform::new_command(curl);
    get.args([
        "-fL",
        "-sS",
        "--retry",
        "2",
        "--connect-timeout",
        "20",
        // A stalled transfer (under 1 KB/s for a minute) fails on its own.
        "--speed-limit",
        "1024",
        "--speed-time",
        "60",
        "-o",
    ])
    .arg(&part)
    .arg(&url);
    let result = job.run(&mut get, Duration::from_secs(3 * 60 * 60), &|| {
        let received = std::fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
        on_progress(received, total);
    });
    let outcome = result.and_then(|run| {
        if !run.status.success() {
            return Err(failed(format!(
                "Download failed: {}",
                stderr_tail(&run.stderr)
            )));
        }
        let received = std::fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
        if total.is_some_and(|total| total != received) {
            return Err(failed(format!(
                "Download incomplete: {received} of {} bytes.",
                total.unwrap_or_default()
            )));
        }
        if !model_present(&part) {
            return Err(failed("The downloaded file is not a whisper.cpp model.".into()));
        }
        on_progress(received, total.or(Some(received)));
        std::fs::rename(&part, &target).map_err(|e| failed(format!("install model: {e}")))?;
        Ok(target.clone())
    });
    if outcome.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    outcome
}

// ── child processes ─────────────────────────────────────────────────────

/// Every child this module starts (whisper-cli, curl) runs in its own
/// process group under a reserved key, so a request can be cancelled and app
/// exit kills whatever is still running (Hard Rule #4). A reservation can
/// run several children in turn; a cancel sticks to the reservation, so the
/// next stage is refused rather than started.
pub struct JobRegistry {
    state: std::sync::Mutex<JobState>,
}

#[derive(Default)]
struct JobState {
    shutting_down: bool,
    /// Reserved keys, with the process group of the child running now.
    jobs: HashMap<String, Option<crate::platform::Pgid>>,
    cancelled: HashSet<String>,
    /// Requests cancelled before they reserved: the cancel won the race with
    /// the transcription's own IPC call. Bounded; ids are unique per request.
    cancelled_early: std::collections::VecDeque<String>,
}

const MAX_EARLY_CANCELS: usize = 32;

#[derive(Debug)]
pub struct JobRun {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

/// A reserved job key. Dropping it kills anything left in its group and
/// frees the key.
pub struct JobReservation<'a> {
    registry: &'a JobRegistry,
    key: String,
}

pub static JOBS: std::sync::LazyLock<JobRegistry> = std::sync::LazyLock::new(JobRegistry::new);

fn kill_group(pgid: Option<crate::platform::Pgid>) {
    if let Some(pgid) = pgid {
        // A process group this registry created; its leader is not reaped
        // until the waiter has seen it exit.
        crate::platform::kill_group(pgid);
    }
}

fn cancelled_error() -> DictationError {
    DictationError::new(DictationErrorKind::Cancelled, "Cancelled.")
}

impl JobRegistry {
    pub fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(JobState::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, JobState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Whether the key is reserved — a job running, or between its stages.
    pub fn is_running(&self, key: &str) -> bool {
        self.lock().jobs.contains_key(key)
    }

    pub fn reserve(&self, key: &str) -> Result<JobReservation<'_>, DictationError> {
        let mut state = self.lock();
        if state.shutting_down {
            return Err(DictationError::new(DictationErrorKind::Quitting, "Plyloft is quitting."));
        }
        if state.jobs.contains_key(key) {
            return Err(DictationError::new(
                DictationErrorKind::Busy,
                "That request is already running.",
            ));
        }
        if let Some(index) = state.cancelled_early.iter().position(|k| k == key) {
            state.cancelled_early.remove(index);
            return Err(cancelled_error());
        }
        state.jobs.insert(key.to_string(), None);
        state.cancelled.remove(key);
        Ok(JobReservation {
            registry: self,
            key: key.to_string(),
        })
    }

    /// Cancel a reserved job: kill its running child, and refuse any later
    /// stage. The waiting call returns `Cancelled`.
    pub fn cancel(&self, key: &str) -> bool {
        let mut state = self.lock();
        let Some(pgid) = state.jobs.get(key).copied() else {
            return false;
        };
        state.cancelled.insert(key.to_string());
        kill_group(pgid);
        true
    }

    /// Cancel a one-off request by id, including one that has not reserved
    /// yet: it is then refused when it does. Not for downloads, whose keys
    /// are reused — a stale early cancel would stop the next one.
    pub fn cancel_request(&self, key: &str) -> bool {
        if self.cancel(key) {
            return true;
        }
        let mut state = self.lock();
        if state.jobs.contains_key(key) {
            // Reserved between the two locks: cancel it properly.
            drop(state);
            return self.cancel(key);
        }
        if state.cancelled_early.len() >= MAX_EARLY_CANCELS {
            state.cancelled_early.pop_front();
        }
        state.cancelled_early.push_back(key.to_string());
        false
    }

    /// App exit: refuse new jobs and cancel every reserved one. Returns how
    /// many were signalled.
    pub fn shutdown(&self) -> usize {
        let mut state = self.lock();
        state.shutting_down = true;
        let keys: Vec<String> = state.jobs.keys().cloned().collect();
        state.cancelled.extend(keys);
        for pgid in state.jobs.values() {
            kill_group(*pgid);
        }
        state.jobs.len()
    }

    /// Reserve `key` for a single child and run it.
    pub fn run(
        &self,
        key: &str,
        cmd: &mut Command,
        timeout: Duration,
    ) -> Result<JobRun, DictationError> {
        self.reserve(key)?.run(cmd, timeout, &|| {})
    }
}

impl JobReservation<'_> {
    /// `Cancelled` once the job has been cancelled, before any child runs.
    pub fn check_cancelled(&self) -> Result<(), DictationError> {
        if self.registry.lock().cancelled.contains(&self.key) {
            Err(cancelled_error())
        } else {
            Ok(())
        }
    }

    fn spawn(&self, cmd: &mut Command) -> Result<Child, DictationError> {
        let mut state = self.registry.lock();
        if state.cancelled.contains(&self.key) {
            return Err(cancelled_error());
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::platform::own_group(cmd);
        let program = cmd.get_program().to_string_lossy().to_string();
        let child = cmd.spawn().map_err(|e| {
            let kind = if e.kind() == std::io::ErrorKind::NotFound {
                DictationErrorKind::WhisperMissing
            } else {
                DictationErrorKind::Failed
            };
            DictationError::new(kind, format!("start {program}: {e}"))
        })?;
        crate::platform::adopt(&child);
        state
            .jobs
            .insert(self.key.clone(), Some(child.id() as crate::platform::Pgid));
        Ok(child)
    }

    /// The child has exited (or been killed): end whatever it left in its
    /// group, and report whether the job was cancelled.
    fn child_done(&self) -> bool {
        let mut state = self.registry.lock();
        if let Some(slot) = state.jobs.get_mut(&self.key) {
            kill_group(slot.take());
        }
        state.cancelled.contains(&self.key)
    }

    /// Run one child to completion, calling `poll` about four times a
    /// second. Output is drained on threads so a chatty child cannot fill a
    /// pipe and stall.
    pub fn run(
        &self,
        cmd: &mut Command,
        timeout: Duration,
        poll: &dyn Fn(),
    ) -> Result<JobRun, DictationError> {
        let mut child = self.spawn(cmd)?;
        let stdout = drain(child.stdout.take());
        let stderr = drain(child.stderr.take());
        let started = Instant::now();
        let mut last_poll = Instant::now();
        let waited = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {}
                Err(e) => break Err(format!("wait: {e}")),
            }
            if started.elapsed() >= timeout {
                // A timeout ends this child, not the reservation: a later
                // stage may still run.
                kill_group(Some(child.id() as crate::platform::Pgid));
                let _ = child.wait();
                if self.child_done() {
                    return Err(cancelled_error());
                }
                return Err(DictationError::new(
                    DictationErrorKind::Timeout,
                    format!("Timed out after {}s.", timeout.as_secs()),
                ));
            }
            if last_poll.elapsed() >= Duration::from_millis(250) {
                poll();
                last_poll = Instant::now();
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        if self.child_done() {
            return Err(cancelled_error());
        }
        let status = waited.map_err(|e| DictationError::new(DictationErrorKind::Failed, e))?;
        let collect = |rx: mpsc::Receiver<Vec<u8>>| {
            String::from_utf8_lossy(&rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default())
                .to_string()
        };
        Ok(JobRun {
            status,
            stdout: collect(stdout),
            stderr: collect(stderr),
        })
    }
}

impl Drop for JobReservation<'_> {
    fn drop(&mut self) {
        let mut state = self.registry.lock();
        if let Some(pgid) = state.jobs.remove(&self.key) {
            kill_group(pgid);
        }
        state.cancelled.remove(&self.key);
    }
}

impl Default for JobRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    if let Some(mut pipe) = pipe {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
    }
    rx
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav_of(samples: usize) -> Vec<u8> {
        let data_len = (samples * 2) as u32;
        let mut bytes = Vec::with_capacity(44 + samples * 2);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&16_000u32.to_le_bytes());
        bytes.extend_from_slice(&32_000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        bytes.resize(44 + samples * 2, 0);
        bytes
    }

    #[cfg(unix)]
    fn script(dir: &Path, body: &str) -> PathBuf {
        script_named(dir, "fake-whisper-cli", body)
    }

    #[cfg(unix)]
    fn script_named(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// A one-shot handshake between a stub and the test that drives it: the
    /// stub opens the write end when it reaches the moment the test cares
    /// about, and `wait` blocks on the read end until it does.
    ///
    /// Why a FIFO and not a clock (GH #145, same shape as #90/#98/#130):
    /// macOS assesses a freshly written executable on its first exec, after
    /// spawn has returned, and those checks queue behind every other test's
    /// fresh stubs — #90 measured ~280 ms alone and ~10.5 s with 40 at once.
    /// Any wall-clock deadline for "the stub has started" is therefore a bet
    /// on machine load. Blocking on the stub's own signal is not: a slow
    /// first exec only makes the test slower, never red.
    #[cfg(unix)]
    struct Rendezvous {
        path: PathBuf,
        signal: mpsc::Receiver<()>,
    }

    #[cfg(unix)]
    impl Rendezvous {
        fn new(path: PathBuf) -> Self {
            use std::os::unix::ffi::OsStrExt;
            let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
            // SAFETY: plain syscall with a NUL-terminated path, in a
            // tempdir this test owns.
            let made = unsafe { libc::mkfifo(name.as_ptr(), 0o600) };
            assert_eq!(
                made,
                0,
                "mkfifo {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            );
            let (tx, signal) = mpsc::channel();
            let read_end = path.clone();
            std::thread::spawn(move || {
                // Opening a FIFO for reading blocks until a writer opens it:
                // that open *is* the handshake.
                if let Ok(mut fifo) = std::fs::File::open(&read_end) {
                    let mut seen = String::new();
                    let _ = fifo.read_to_string(&mut seen);
                    let _ = tx.send(());
                }
            });
            Self { path, signal }
        }

        /// Shell to embed in a stub's body where it should signal.
        fn shell_signal(&self) -> String {
            format!("echo here > '{}'", self.path.display())
        }

        /// Block until the stub signals. `worker` is the thread running it:
        /// a worker that ends without ever signalling means the stub never
        /// got where the test needed it, which is a setup failure and is
        /// reported as one — never a pass, and never a wait on a clock.
        fn wait<T>(&self, worker: &std::thread::JoinHandle<T>, what: &str) {
            loop {
                match self.signal.recv_timeout(Duration::from_millis(20)) {
                    Ok(()) => return,
                    // The worker's own timeout bounds this wait, so a stub
                    // that never runs cannot hang the suite.
                    Err(mpsc::RecvTimeoutError::Timeout) if worker.is_finished() => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            // The signal may have landed just as the worker ended.
            if self.signal.try_recv().is_ok() {
                return;
            }
            panic!("test setup failure: {what} never signalled — the run ended first, so the test proves nothing");
        }
    }

    #[test]
    fn argv_is_model_file_language_without_timestamps_or_prints() {
        let argv = whisper_argv(
            Path::new("/m/ggml-small.bin"),
            Path::new("/tmp/a.wav"),
            DictationLanguage::It,
        );
        assert_eq!(
            argv,
            ["-m", "/m/ggml-small.bin", "-f", "/tmp/a.wav", "-l", "it", "-nt", "-np"]
        );
        let auto = whisper_argv(Path::new("m"), Path::new("w"), DictationLanguage::Auto);
        assert_eq!(auto[5], "auto");
        assert_eq!(whisper_argv(Path::new("m"), Path::new("w"), DictationLanguage::En)[5], "en");
    }

    #[cfg(unix)]
    #[test]
    fn transcript_joins_segments_into_one_trimmed_line() {
        let stdout = " Ciao, questa è una prova.\n E questa è la seconda frase.  \n\n";
        assert_eq!(
            parse_transcript(stdout),
            "Ciao, questa è una prova. E questa è la seconda frase."
        );
    }

    #[cfg(unix)]
    #[test]
    fn transcript_drops_non_speech_annotations() {
        assert_eq!(parse_transcript(" [BLANK_AUDIO]\n"), "");
        assert_eq!(parse_transcript(" (silence)\n *music*\n"), "");
        assert_eq!(
            parse_transcript(" [MUSIC] Fix the build. [ Silence ]\n (laughs)\n Then run it.\n"),
            "Fix the build. Then run it."
        );
        // Parentheses inside speech are kept.
        assert_eq!(parse_transcript(" Use the (new) API\n"), "Use the (new) API");
    }

    #[cfg(unix)]
    #[test]
    fn transcript_never_carries_control_characters_or_newlines() {
        let parsed = parse_transcript(" rm\u{1b}[2J -rf\r\n\u{3} ok\t\n");
        assert_eq!(parsed, "rm [2J -rf ok");
        assert!(!parsed.chars().any(char::is_control));
    }

    #[test]
    fn wav_duration_reads_the_byte_rate() {
        assert_eq!(wav_duration(&wav_of(16_000)), Duration::from_secs(1));
        assert_eq!(wav_duration(&[0u8; 10]), Duration::ZERO);
    }

    #[test]
    fn timeout_grows_with_the_audio_and_is_capped() {
        assert_eq!(transcribe_timeout(Duration::ZERO), Duration::from_secs(30));
        assert_eq!(transcribe_timeout(Duration::from_secs(10)), Duration::from_secs(70));
        assert_eq!(transcribe_timeout(Duration::from_secs(3600)), Duration::from_secs(600));
    }

    #[test]
    fn content_length_is_the_final_hops() {
        let headers = "HTTP/2 302\r\ncontent-length: 1234\r\nlocation: x\r\n\r\nHTTP/2 200\r\nContent-Length: 487601967\r\n\r\n";
        assert_eq!(parse_content_length(headers), Some(487_601_967));
        assert_eq!(parse_content_length("HTTP/2 200\r\n"), None);
        // The redirect has a length and the final response does not: no size,
        // rather than the redirect body's.
        let final_without =
            "HTTP/2 302\r\ncontent-length: 1234\r\nlocation: x\r\n\r\nHTTP/2 200\r\ncontent-type: application/octet-stream\r\n\r\n";
        assert_eq!(parse_content_length(final_without), None);
    }

    #[test]
    fn a_model_is_present_only_as_a_big_enough_ggml_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = model_path(dir.path(), DictationModel::Base);
        assert!(path.ends_with("whisper/models/ggml-base.bin"));
        assert!(!model_present(&path));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"lmgg-too-small").unwrap();
        assert!(!model_present(&path));
        let mut big = b"html".to_vec();
        big.resize(MIN_MODEL_BYTES as usize, 0);
        std::fs::write(&path, &big).unwrap();
        assert!(!model_present(&path), "wrong magic");
        big[0..4].copy_from_slice(&GGML_MAGIC);
        std::fs::write(&path, &big).unwrap();
        assert!(model_present(&path));
    }

    #[test]
    fn settings_values_parse_and_serialize_as_the_frontend_spells_them() {
        assert_eq!(DictationModel::parse("small"), Some(DictationModel::Small));
        assert_eq!(DictationModel::parse("medium"), None);
        assert_eq!(
            serde_json::to_string(&(DictationModel::Base, DictationLanguage::Auto)).unwrap(),
            r#"["base","auto"]"#
        );
        assert_eq!(
            DictationModel::Small.url(),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
        );
    }

    #[cfg(unix)]
    #[test]
    fn transcribe_runs_the_cli_on_a_temp_wav_and_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("argv.txt");
        // Records its argv and whether the WAV exists while it runs.
        let cli = script(
            dir.path(),
            &format!(
                "echo \"$@\" > '{}'; [ -f \"$4\" ] && echo present >> '{}'; printf ' Ciao mondo.\\n [BLANK_AUDIO]\\n'",
                log.display(),
                log.display()
            ),
        );
        let jobs = JobRegistry::new();
        let wav = wav_of(8_000);
        let text = transcribe(
            TranscribeRequest {
                whisper_cli: &cli,
                model: Path::new("/models/ggml-small.bin"),
                language: DictationLanguage::Auto,
                wav: &wav,
                job: &jobs.reserve("req-1").unwrap(),
                env_path: "/usr/bin:/bin",
            },
            None,
        )
        .unwrap();
        assert_eq!(text, "Ciao mondo.");
        let recorded = std::fs::read_to_string(&log).unwrap();
        let argv: Vec<&str> = recorded.lines().next().unwrap().split(' ').collect();
        assert_eq!(argv[0..2], ["-m", "/models/ggml-small.bin"]);
        assert!(argv[3].contains("ply-dictation-") && argv[3].ends_with(".wav"));
        assert_eq!(argv[4..], ["-l", "auto", "-nt", "-np"]);
        assert!(recorded.contains("present"), "the WAV exists during the run");
        assert!(!Path::new(argv[3]).exists(), "the temp WAV is removed after");
        assert!(!jobs.is_running("req-1"));
    }

    #[cfg(unix)]
    #[test]
    fn a_slow_cli_times_out_and_is_killed() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let cli = script(dir.path(), &format!("echo $$ > '{}'; sleep 30", pid_file.display()));
        let jobs = JobRegistry::new();
        let started = Instant::now();
        let wav = wav_of(100);
        let error = transcribe(
            TranscribeRequest {
                whisper_cli: &cli,
                model: Path::new("m"),
                language: DictationLanguage::En,
                wav: &wav,
                job: &jobs.reserve("slow").unwrap(),
                env_path: "/usr/bin:/bin",
            },
            // Room for a loaded machine (Verify runs beside the Challenger)
            // to start the script before the timeout kills it.
            Some(Duration::from_secs(5)),
        )
        .unwrap_err();
        assert_eq!(error.kind, DictationErrorKind::Timeout);
        assert!(started.elapsed() < Duration::from_secs(15));
        // Killed before its first line ran, the script wrote no pid: it is
        // gone all the same. When it did, that process must be gone.
        if let Ok(text) = std::fs::read_to_string(&pid_file) {
            let pid: i32 = text.trim().parse().unwrap();
            // SAFETY: signal 0 only checks for existence.
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "whisper-cli is gone");
        }
        assert!(!jobs.is_running("slow"));
    }

    #[cfg(unix)]
    #[test]
    fn cancel_and_shutdown_kill_the_running_child() {
        let dir = tempfile::tempdir().unwrap();
        // GH #145, same defect as the download test below: each child signals
        // that it is running, so the cancel and the shutdown always land on a
        // child that has actually started — the kill can never pass vacuously
        // on a reservation whose stub had not been exec'd yet. The old wait
        // was a 5 s clock, and it was computed *once* and reused for the
        // second child, so that wait could expire before it was entered:
        // `shutdown()` then saw no reservation and returned 0.
        let running = Rendezvous::new(dir.path().join("cancel-running"));
        let quitting = Rendezvous::new(dir.path().join("shutdown-running"));
        let body = |signal: String| format!("{signal}\nsleep 30");
        let cancel_cli = script_named(dir.path(), "cancel-cli", &body(running.shell_signal()));
        let quit_cli = script_named(dir.path(), "quit-cli", &body(quitting.shell_signal()));
        let jobs = std::sync::Arc::new(JobRegistry::new());
        let runner = {
            let jobs = jobs.clone();
            std::thread::spawn(move || {
                jobs.run("c", &mut crate::platform::new_command(cancel_cli), Duration::from_secs(20))
                    .map(|_| ())
            })
        };
        running.wait(&runner, "the cancelled child");
        assert!(jobs.cancel("c"));
        assert_eq!(runner.join().unwrap().unwrap_err().kind, DictationErrorKind::Cancelled);

        let runner = {
            let jobs = jobs.clone();
            std::thread::spawn(move || {
                jobs.run("q", &mut crate::platform::new_command(quit_cli), Duration::from_secs(20))
                    .map(|_| ())
            })
        };
        quitting.wait(&runner, "the child caught by shutdown");
        assert_eq!(jobs.shutdown(), 1);
        assert_eq!(runner.join().unwrap().unwrap_err().kind, DictationErrorKind::Cancelled);
        let refused = jobs
            .run("later", &mut crate::platform::new_command("/bin/echo"), Duration::from_secs(1))
            .map(|_| ())
            .unwrap_err();
        assert_eq!(refused.kind, DictationErrorKind::Quitting);
    }

    #[test]
    fn a_second_download_of_the_same_model_is_refused_at_reserve() {
        let jobs = JobRegistry::new();
        let key = download_key(DictationModel::Small);
        let running = jobs.reserve(&key).unwrap();
        assert_eq!(jobs.reserve(&key).map(|_| ()).unwrap_err().kind, DictationErrorKind::Busy);
        drop(running);
        assert!(jobs.reserve(&key).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_cancel_while_the_download_is_queued_never_runs_curl() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("calls.txt");
        let curl = fake_curl(dir.path(), &log, "");
        let jobs = JobRegistry::new();
        // The command reserves, then queues the worker; Cancel lands between.
        let job = jobs.reserve(&download_key(DictationModel::Small)).unwrap();
        assert!(jobs.cancel(&download_key(DictationModel::Small)));
        let error = download_model_with(&job, dir.path(), DictationModel::Small, &curl, &|_, _| {})
            .unwrap_err();
        assert_eq!(error.kind, DictationErrorKind::Cancelled);
        assert!(!log.exists(), "curl never ran");
    }

    /// A fake curl: logs each call, and a HEAD (`-sSIL`) runs `on_head` (a
    /// rendezvous signal, or nothing) and then hangs so the test can cancel
    /// it. The call is logged *before* the signal, so a test that has been
    /// signalled can read the log without racing it.
    #[cfg(unix)]
    fn fake_curl(dir: &Path, log: &Path, on_head: &str) -> PathBuf {
        script_named(
            dir,
            "fake-curl",
            &format!(
                "echo \"$1\" >> '{}'\nif [ \"$1\" = -sSIL ]; then\n{on_head}\nsleep 30\nfi",
                log.display()
            ),
        )
    }

    #[cfg(unix)]
    #[test]
    fn cancelling_the_size_check_never_starts_the_download() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("calls.txt");
        // GH #145: the point of the test is that a cancel *during* the size
        // check stops the download, so the cancel must land while the HEAD is
        // running. The stub says when that is. Waiting up to 5 s for its log
        // file instead lost the race in a loaded full-suite run: the cancel
        // then landed before the stub had run at all, and the read below
        // panicked on a log file that was never written (or, worse, the test
        // would have passed vacuously with nothing to cancel).
        let head_running = Rendezvous::new(dir.path().join("head-running"));
        let curl = fake_curl(dir.path(), &log, &head_running.shell_signal());
        let jobs = std::sync::Arc::new(JobRegistry::new());
        let runner = {
            let jobs = jobs.clone();
            let config = dir.path().to_path_buf();
            std::thread::spawn(move || {
                let job = jobs.reserve(&download_key(DictationModel::Base))?;
                download_model_with(&job, &config, DictationModel::Base, &curl, &|_, _| {})
            })
        };
        head_running.wait(&runner, "the stub curl's size check");
        assert!(jobs.cancel(&download_key(DictationModel::Base)));
        let error = runner.join().unwrap().unwrap_err();
        assert_eq!(error.kind, DictationErrorKind::Cancelled);
        // Not a race: the GET would have been logged before the join above
        // returned. This only catches one leaked behind the cancel.
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(std::fs::read_to_string(&log).unwrap().trim(), "-sSIL", "no GET ran");
        assert!(!jobs.is_running(&download_key(DictationModel::Base)));
        assert!(!models_dir(dir.path()).join("ggml-base.bin.part").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_cancel_between_stages_refuses_the_next_stage() {
        let jobs = JobRegistry::new();
        let job = jobs.reserve("two-stage").unwrap();
        job.run(&mut crate::platform::new_command("/usr/bin/true"), Duration::from_secs(5), &|| {})
            .unwrap();
        assert!(jobs.is_running("two-stage"), "reserved between stages");
        assert!(jobs.cancel("two-stage"));
        let error = job
            .run(&mut crate::platform::new_command("/usr/bin/true"), Duration::from_secs(5), &|| {})
            .unwrap_err();
        assert_eq!(error.kind, DictationErrorKind::Cancelled);
        drop(job);
        assert!(!jobs.is_running("two-stage"));
        // The key is free again, with no stale cancel attached.
        assert!(jobs.run("two-stage", &mut crate::platform::new_command("/usr/bin/true"), Duration::from_secs(5)).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_timed_out_stage_does_not_cancel_the_reservation() {
        let jobs = JobRegistry::new();
        let job = jobs.reserve("slow-head").unwrap();
        let error = job
            .run(&mut crate::platform::new_command("/bin/sleep").arg("30"), Duration::from_millis(200), &|| {})
            .unwrap_err();
        assert_eq!(error.kind, DictationErrorKind::Timeout);
        assert!(job.run(&mut crate::platform::new_command("/usr/bin/true"), Duration::from_secs(5), &|| {}).is_ok());
    }

    #[test]
    fn a_cancel_before_the_request_reserves_refuses_it() {
        let jobs = JobRegistry::new();
        assert!(!jobs.cancel_request("early"), "nothing was running yet");
        assert_eq!(jobs.reserve("early").map(|_| ()).unwrap_err().kind, DictationErrorKind::Cancelled);
        // Consumed: a later request with the same id is not affected.
        assert!(jobs.reserve("early").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_cancel_while_queued_stops_the_request_before_whisper_runs() {
        let dir = tempfile::tempdir().unwrap();
        let ran = dir.path().join("ran");
        let cli = script(dir.path(), &format!("touch '{}'", ran.display()));
        let jobs = JobRegistry::new();
        // The command reserves before handing the work to a worker thread;
        // the cancel lands in between.
        let job = jobs.reserve("queued").unwrap();
        assert!(jobs.cancel_request("queued"));
        let wav = wav_of(100);
        let error = transcribe(
            TranscribeRequest {
                whisper_cli: &cli,
                model: Path::new("m"),
                language: DictationLanguage::Auto,
                wav: &wav,
                job: &job,
                env_path: "/usr/bin:/bin",
            },
            None,
        )
        .unwrap_err();
        assert_eq!(error.kind, DictationErrorKind::Cancelled);
        assert!(!ran.exists(), "whisper-cli never started");
        drop(job);
        assert!(!jobs.is_running("queued"));
    }

    #[test]
    fn invalid_audio_is_refused_before_anything_runs() {
        let jobs = JobRegistry::new();
        let error = transcribe(
            TranscribeRequest {
                whisper_cli: Path::new("/nonexistent/whisper-cli"),
                model: Path::new("m"),
                language: DictationLanguage::Auto,
                wav: b"not a wav at all, definitely not one, no no no no",
                job: &jobs.reserve("bad").unwrap(),
                env_path: "",
            },
            None,
        )
        .unwrap_err();
        assert_eq!(error.kind, DictationErrorKind::InvalidAudio);
    }

    #[test]
    fn a_missing_cli_reports_whisper_missing() {
        let jobs = JobRegistry::new();
        let wav = wav_of(10);
        let error = transcribe(
            TranscribeRequest {
                whisper_cli: Path::new("/nonexistent/whisper-cli"),
                model: Path::new("m"),
                language: DictationLanguage::Auto,
                wav: &wav,
                job: &jobs.reserve("missing").unwrap(),
                env_path: "",
            },
            None,
        )
        .unwrap_err();
        assert_eq!(error.kind, DictationErrorKind::WhisperMissing);
    }

    /// Live, opt-in: downloads the real base model into
    /// `$PLY_DICTATION_LIVE_DIR` through `download_model`, then transcribes
    /// Homebrew's `jfk.wav` with the real whisper-cli.
    /// `PLY_DICTATION_LIVE_DIR=/some/dir cargo test --lib live_ -- --ignored`
    #[test]
    #[ignore]
    fn live_download_and_transcribe() {
        let dir = PathBuf::from(std::env::var("PLY_DICTATION_LIVE_DIR").expect("set PLY_DICTATION_LIVE_DIR"));
        let jobs = JobRegistry::new();
        let last = std::sync::Mutex::new((0u64, None));
        let job = jobs.reserve(&download_key(DictationModel::Base)).unwrap();
        let model = download_model(&job, &dir, DictationModel::Base, &|received, total| {
            *last.lock().unwrap() = (received, total);
        })
        .expect("download");
        assert!(model_present(&model));
        let (received, total) = *last.lock().unwrap();
        assert_eq!(Some(received), total, "progress reached the Content-Length");
        let cli = resolve_whisper_cli("/usr/bin:/bin").expect("whisper-cli installed");
        let wav = std::fs::read("/opt/homebrew/share/whisper.cpp/jfk.wav").expect("jfk.wav");
        let text = transcribe(
            TranscribeRequest {
                whisper_cli: Path::new(&cli),
                model: &model,
                language: DictationLanguage::Auto,
                wav: &wav,
                job: &jobs.reserve("live").unwrap(),
                env_path: "/opt/homebrew/bin:/usr/bin:/bin",
            },
            None,
        )
        .expect("transcribe");
        eprintln!("live transcript: {text:?}");
        assert!(text.to_lowercase().contains("ask not what your country can do for you"), "{text}");
    }

    #[test]
    fn status_lists_both_models_and_the_resolved_cli() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        // A bare name on Windows finds the `.exe`.
        let file = format!("{WHISPER_CLI}{}", std::env::consts::EXE_SUFFIX);
        std::fs::write(bin.join(&file), "").unwrap();
        let status = status(dir.path(), &bin.to_string_lossy(), &JobRegistry::new());
        assert_eq!(
            status.whisper_cli.as_deref(),
            Some(bin.join(&file).to_string_lossy().as_ref())
        );
        assert_eq!(status.models.len(), 2);
        assert!(status.models.iter().all(|m| !m.present && !m.downloading));
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["models"][0]["id"], "small");
        assert_eq!(json["models"][0]["fileName"], "ggml-small.bin");
    }
}
