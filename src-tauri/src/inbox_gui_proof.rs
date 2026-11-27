//! Opt-in, one-way redacted observations of the actual GUI Inbox feed.
//! No receiver, file writes, worker, alternate evaluator or control interface.

use std::ffi::OsString;
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt};
#[cfg(unix)]
use std::os::unix::net::UnixDatagram;
#[cfg(unix)]
use std::path::Component;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::inbox::{is_lower_sha256, InboxEligibilityProof, InboxFeed, RequiredInboxSet};

const MAX_RECORDS: u64 = 128;
const MAX_BYTES: usize = 8192;
const MAX_AGE: Duration = Duration::from_secs(600);
// Room for BSD mbuf accounting as well as the maximum payload.
#[cfg(unix)]
const SEND_BUFFER: libc::c_int = 32768;
const STARTUP_ERROR: &str = "Inbox GUI proof configuration is invalid";
const OBSERVATION_ERROR: &str = "Inbox GUI proof observation failed; restart required";
#[cfg(unix)]
const CONNECT_ERROR: &str = STARTUP_ERROR;
#[cfg(windows)]
const CONNECT_ERROR: &str = "Inbox GUI proof is not supported on Windows yet";

#[derive(Default)]
pub struct GuiInboxProof {
    session: Option<Mutex<Session>>,
}

struct Session {
    socket: UnixDatagram,
    nonce: String,
    target: String,
    required_set: String,
    started: Instant,
    sequence: u64,
    failed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation<'a> {
    schema_version: u8,
    session: &'a str,
    process_id: u32,
    sequence: u64,
    assembly_started_elapsed_ms: u128,
    emitted_elapsed_ms: u128,
    required_set_sha256: &'a str,
    target_sha256: &'a str,
    proof: &'a InboxEligibilityProof,
}

impl GuiInboxProof {
    pub fn from_environment(required: &RequiredInboxSet) -> Result<Self, &'static str> {
        Self::from_inputs(
            std::env::var_os("PLY_INBOX_PROOF_SOCKET"),
            std::env::var_os("PLY_INBOX_PROOF_SESSION"),
            std::env::var_os("PLY_INBOX_PROOF_TARGET_SHA256"),
            required,
        )
    }

    pub(crate) fn from_inputs(
        socket: Option<OsString>,
        nonce: Option<OsString>,
        target: Option<OsString>,
        required: &RequiredInboxSet,
    ) -> Result<Self, &'static str> {
        if socket.is_none() && nonce.is_none() && target.is_none() {
            return Ok(Self::default());
        }
        let (Some(socket), Some(nonce), Some(target)) = (socket, nonce, target) else {
            return Err(STARTUP_ERROR);
        };
        let socket = socket.into_string().map_err(|_| STARTUP_ERROR)?;
        let nonce = nonce.into_string().map_err(|_| STARTUP_ERROR)?;
        let target = target.into_string().map_err(|_| STARTUP_ERROR)?;
        let required_set = required
            .required_digest()
            .map_err(|_| STARTUP_ERROR)?
            .ok_or(STARTUP_ERROR)?;
        if !is_lower_sha256(&nonce) || !is_lower_sha256(&target) {
            return Err(STARTUP_ERROR);
        }
        let socket = connect_private(Path::new(&socket)).map_err(|_| CONNECT_ERROR)?;
        Ok(Self {
            session: Some(Mutex::new(Session {
                socket,
                nonce,
                target,
                required_set: required_set.to_owned(),
                started: Instant::now(),
                sequence: 0,
                failed: false,
            })),
        })
    }

    pub fn observe(
        &self,
        assemble: impl FnOnce(Option<&str>) -> Result<InboxFeed, String>,
    ) -> Result<InboxFeed, String> {
        let Some(session) = &self.session else {
            return assemble(None);
        };
        let mut session = session.lock().map_err(|_| OBSERVATION_ERROR.to_string())?;
        let started = session.started;
        session.capture(assemble, || started.elapsed())
    }
}

impl Session {
    fn capture(
        &mut self,
        assemble: impl FnOnce(Option<&str>) -> Result<InboxFeed, String>,
        mut elapsed: impl FnMut() -> Duration,
    ) -> Result<InboxFeed, String> {
        if self.failed {
            return Err(OBSERVATION_ERROR.into());
        }
        // Arm failure *before* every fallible operation (and before a panic).
        // Only an entire datagram accepted by the kernel disarms it.
        self.failed = true;
        let assembly_started = elapsed();
        if self.sequence >= MAX_RECORDS || assembly_started >= MAX_AGE {
            return Err(OBSERVATION_ERROR.into());
        }
        let feed = assemble(Some(&self.target)).map_err(|_| OBSERVATION_ERROR.to_string())?;
        let emitted = elapsed();
        if emitted >= MAX_AGE || emitted < assembly_started {
            return Err(OBSERVATION_ERROR.into());
        }
        let payload = serde_json::to_vec(&Observation {
            schema_version: 1,
            session: &self.nonce,
            process_id: std::process::id(),
            sequence: self.sequence + 1,
            assembly_started_elapsed_ms: assembly_started.as_millis(),
            emitted_elapsed_ms: emitted.as_millis(),
            required_set_sha256: &self.required_set,
            target_sha256: &self.target,
            proof: &feed.eligibility_proof,
        })
        .map_err(|_| OBSERVATION_ERROR.to_string())?;
        if payload.len() > MAX_BYTES {
            return Err(OBSERVATION_ERROR.into());
        }
        let sent = self
            .socket
            .send(&payload)
            .map_err(|_| OBSERVATION_ERROR.to_string())?;
        if sent != payload.len() {
            return Err(OBSERVATION_ERROR.into());
        }
        self.sequence += 1;
        self.failed = false;
        Ok(feed)
    }
}

#[cfg(unix)]
fn private_identity(path: &Path, socket: bool, uid: u32) -> Result<(u64, u64), ()> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| ())?;
    let expected_mode = if socket { 0o600 } else { 0o700 };
    if metadata.uid() != uid
        || metadata.mode() & 0o7777 != expected_mode
        || if socket {
            !metadata.file_type().is_socket()
        } else {
            !metadata.is_dir()
        }
    {
        return Err(());
    }
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(unix)]
fn set_buffer(socket: &UnixDatagram, option: libc::c_int, size: libc::c_int) -> Result<(), ()> {
    let fd = socket.as_raw_fd();
    let mut actual: libc::c_int = 0;
    let mut length = std::mem::size_of_val(&actual) as libc::socklen_t;
    // SAFETY: valid live socket; pointers refer to correctly sized c_int values.
    let success = unsafe {
        libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            option,
            (&size as *const libc::c_int).cast(),
            length,
        ) == 0
            && libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                option,
                (&mut actual as *mut libc::c_int).cast(),
                &mut length,
            ) == 0
    };
    if !success || length as usize != std::mem::size_of_val(&actual) || actual < size {
        return Err(());
    }
    Ok(())
}

#[cfg(unix)]
fn connect_private(path: &Path) -> Result<UnixDatagram, ()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
    {
        return Err(());
    }
    let parent = path.parent().ok_or(())?;
    if crate::platform::canonicalize(parent).map_err(|_| ())? != parent {
        return Err(());
    }
    let uid = unsafe { libc::geteuid() };
    let parent_before = private_identity(parent, false, uid)?;
    let socket_before = private_identity(path, true, uid)?;
    let sender = UnixDatagram::unbound().map_err(|_| ())?;
    set_buffer(&sender, libc::SO_SNDBUF, SEND_BUFFER)?;
    sender.set_nonblocking(true).map_err(|_| ())?;
    sender.connect(path).map_err(|_| ())?;
    if private_identity(parent, false, uid)? != parent_before
        || private_identity(path, true, uid)? != socket_before
    {
        return Err(());
    }
    Ok(sender)
}

// Windows spike: the proof sends over a private unix datagram socket whose
// owner, mode and inode it checks. The real port needs a named pipe (or AF_UNIX
// on Windows 10+) with an ACL check; until then enabling the proof fails at
// startup and the socket type is uninhabited.
#[cfg(windows)]
enum UnixDatagram {}

#[cfg(windows)]
impl UnixDatagram {
    fn send(&self, _payload: &[u8]) -> std::io::Result<usize> {
        match *self {}
    }
}

#[cfg(windows)]
fn connect_private(_path: &Path) -> Result<UnixDatagram, ()> {
    Err(())
}

// The tests bind real unix sockets and check unix owners and modes.
#[cfg(all(test, unix))]
mod tests;
