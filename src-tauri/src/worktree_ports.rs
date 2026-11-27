//! A port range per card worktree.
//!
//! Two cards that start the same dev server or database used to collide on
//! its port. Each card worktree now owns a block of [`PORT_COUNT`] ports,
//! `base … base + 9`, inside [`RANGE_START`]`..=`[`RANGE_LAST_BASE`]` + 9`
//! (41000–48999: above the usual dev-server defaults — 3000, 5173, 8080 —
//! and below macOS's ephemeral range, 49152 and up, where the OS picks a
//! connection's local port).
//!
//! **Allocation.** `KanbanStore::ensure_port_base` hands a worktree its
//! block when the card's worktree is made (and lazily, the first time
//! something is spawned in a worktree made before this), and records it on
//! the card (`KanbanCard::port_base`; a Build-with-both lane `b` worktree on
//! its lane). A block is in use while the card (or lane) that holds it has a
//! worktree: a removed worktree frees its block without a write, and the
//! card keeps its number so the same card gets the same ports back when it
//! starts again, unless another card took them meanwhile. A free block with
//! a port in use is skipped, at most [`MAX_BUSY_SKIPS`] of them. The ports
//! are probed with no lock held ([`block_is_free`]); the pick is checked
//! again under the lock before it is written.
//!
//! **Exposure.** Everything run inside a card worktree gets
//! `PLYLOFT_PORT_BASE` and `PLYLOFT_PORT_COUNT` ([`port_env`]): the PTY
//! spawns (`pty::PtyRegistry::{spawn, spawn_with_capture, spawn_collect}`:
//! tiles, Builders, verify slash steps, reviewers) through
//! `pty::session_env`'s caller variables, the worktree setup command, the
//! Verify pipeline's shell steps and the Codex app-server. Each asks
//! [`env_for_cwd`] with its working directory; the main checkout and any
//! directory outside a card worktree get nothing.

use std::collections::HashSet;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
#[cfg(unix)]
use std::net::{Ipv6Addr, SocketAddrV6, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};
#[cfg(unix)]
use std::time::Duration;

/// The first port of the first block.
pub const RANGE_START: u16 = 41000;
/// The first port of the last block (its last port is 48999).
pub const RANGE_LAST_BASE: u16 = 48990;
/// Ports per card worktree.
pub const PORT_COUNT: u16 = 10;
/// Free blocks with a listening port skipped before the next free block is
/// taken anyway.
pub const MAX_BUSY_SKIPS: usize = 32;
/// Picks probed outside the lock and found taken on the re-check before one
/// is written without probing.
pub const MAX_PICK_ATTEMPTS: usize = 4;

pub const ENV_BASE: &str = "PLYLOFT_PORT_BASE";
pub const ENV_COUNT: &str = "PLYLOFT_PORT_COUNT";

/// The variables a process in a worktree with port block `base` gets.
pub fn port_env(base: u16) -> Vec<(String, String)> {
    vec![
        (ENV_BASE.to_string(), base.to_string()),
        (ENV_COUNT.to_string(), PORT_COUNT.to_string()),
    ]
}

/// True for the first port of a block in the range.
pub fn is_block_base(base: u16) -> bool {
    (RANGE_START..=RANGE_LAST_BASE).contains(&base) && (base - RANGE_START) % PORT_COUNT == 0
}

/// Every block's base, lowest first.
fn block_bases() -> impl Iterator<Item = u16> {
    (RANGE_START..=RANGE_LAST_BASE).step_by(PORT_COUNT as usize)
}

/// How long a probe waits for a loopback connection on macOS and Linux,
/// where a refused one is answered at once.
#[cfg(unix)]
const PROBE_TIMEOUT: Duration = Duration::from_millis(50);

/// True when no port of the block is in use now, its ports probed in
/// parallel. Called with no lock held (`KanbanStore::ensure_port_base`).
pub fn block_is_free(base: u16) -> bool {
    std::thread::scope(|scope| {
        let probes: Vec<_> = (base..base + PORT_COUNT).map(|port| scope.spawn(move || port_is_free(port))).collect();
        probes.into_iter().all(|p| p.join().unwrap_or(false))
    })
}

/// macOS and Linux: busy when 127.0.0.1 can't be bound, or something
/// accepts a connection on 127.0.0.1 or [::1] — which finds a server on
/// 0.0.0.0 or [::] that a bind with `SO_REUSEADDR` (std's default on unix)
/// would not. No probe binds 0.0.0.0: listening on every interface can
/// raise the macOS firewall's "accept incoming connections?" prompt.
/// Without IPv6 the [::1] connect fails, which counts as free.
#[cfg(unix)]
fn port_is_free(port: u16) -> bool {
    let v4 = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let v6 = SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, port, 0, 0));
    TcpListener::bind(v4).is_ok()
        && TcpStream::connect_timeout(&v4, PROBE_TIMEOUT).is_err()
        && TcpStream::connect_timeout(&v6, PROBE_TIMEOUT).is_err()
}

/// Windows: binds with `SO_EXCLUSIVEADDRUSE` and no listen (no firewall
/// prompt), each released at once. 127.0.0.1 and [::1] for a loopback
/// server; 0.0.0.0 and [::] because Windows lets a specific bind sit beside
/// another socket's wildcard one, while an exclusive wildcard bind fails
/// when any socket holds the port (measured on Windows 11: a 127.0.0.1 bind
/// alone missed a 0.0.0.0 listener). No connect: Windows retries a refused
/// loopback connect for about a second. Without IPv6 the [::1] / [::]
/// socket or bind fails for another reason than the port being in use,
/// which counts as free.
#[cfg(windows)]
fn port_is_free(port: u16) -> bool {
    use std::net::{Ipv6Addr, SocketAddrV6};
    let v4 = |ip: Ipv4Addr| SocketAddr::V4(SocketAddrV4::new(ip, port));
    let v6 = |ip: Ipv6Addr| SocketAddr::V6(SocketAddrV6::new(ip, port, 0, 0));
    let in_use = |e: std::io::Error| matches!(e.kind(), std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied);
    [Ipv4Addr::LOCALHOST, Ipv4Addr::UNSPECIFIED]
        .into_iter()
        .all(|ip| exclusive_bind(socket2::Domain::IPV4, v4(ip)).is_ok())
        && [Ipv6Addr::LOCALHOST, Ipv6Addr::UNSPECIFIED]
            .into_iter()
            .all(|ip| exclusive_bind(socket2::Domain::IPV6, v6(ip)).map_or_else(|e| !in_use(e), |()| true))
}

#[cfg(windows)]
fn exclusive_bind(domain: socket2::Domain, addr: SocketAddr) -> std::io::Result<()> {
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Networking::WinSock::{setsockopt, SOL_SOCKET, SO_EXCLUSIVEADDRUSE};
    let socket = socket2::Socket::new(domain, socket2::Type::STREAM, None)?;
    let on: i32 = 1;
    // SAFETY: a live socket this function owns, and a 4-byte option value.
    let set = unsafe {
        setsockopt(
            socket.as_raw_socket() as usize,
            SOL_SOCKET,
            SO_EXCLUSIVEADDRUSE,
            (&on as *const i32).cast(),
            std::mem::size_of::<i32>() as i32,
        )
    };
    if set != 0 {
        return Err(std::io::Error::last_os_error());
    }
    socket.bind(&addr.into())
}

/// The block a worktree gets: `current` when it is a block nobody else uses
/// (stable across restarts, even while its own server listens there), else
/// the lowest block not in `used` whose ports are free, skipping at most
/// [`MAX_BUSY_SKIPS`] busy ones; `None` only when every block is in use.
pub fn pick_block(used: &HashSet<u16>, current: Option<u16>, is_free: impl Fn(u16) -> bool) -> Option<u16> {
    if let Some(base) = current.filter(|b| is_block_base(*b) && !used.contains(b)) {
        return Some(base);
    }
    let mut skipped = 0;
    let mut first_unused = None;
    for base in block_bases().filter(|b| !used.contains(b)) {
        first_unused.get_or_insert(base);
        if skipped >= MAX_BUSY_SKIPS || is_free(base) {
            return Some(base);
        }
        skipped += 1;
    }
    first_unused
}

/// The card worktree `cwd` is in, as `(worktree root, its directory name)`:
/// `<workspace>/.plyloft-worktrees/<dir>` (or a legacy root) for any `cwd`
/// at or under it. `None` for the main checkout, the trash, the shared
/// Cargo target and anything else.
pub fn worktree_of(cwd: &Path) -> Option<(PathBuf, String)> {
    let mut prefix = PathBuf::new();
    let mut parts = cwd.components();
    while let Some(part) = parts.next() {
        prefix.push(part.as_os_str());
        if let Component::Normal(name) = part {
            if name.to_str().is_some_and(crate::worktrees::is_worktrees_dir_name) {
                let Some(Component::Normal(dir)) = parts.next() else { return None };
                let dir = dir.to_str()?;
                if dir == crate::worktrees::TRASH_DIR || dir == crate::worktrees::SHARED_TARGET_DIR {
                    return None;
                }
                prefix.push(dir);
                return Some((prefix, dir.to_string()));
            }
        }
    }
    None
}

/// The card ids a worktree directory can belong to: `<id>`, and `<id>` for
/// a Build-with-both `<id>-b`.
pub fn card_ids_for_dir(dir: &str) -> Vec<String> {
    let mut ids = vec![dir.to_string()];
    if let Some(id) = dir.strip_suffix(crate::build_both::VARIANT_SUFFIX).filter(|id| !id.is_empty()) {
        ids.push(id.to_string());
    }
    ids
}

/// True when two paths name the same directory (resolved when they exist).
pub fn same_dir(a: &Path, b: &Path) -> bool {
    let resolve = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    a == b || resolve(a) == resolve(b)
}

type Resolver = Arc<dyn Fn(&Path) -> Option<u16> + Send + Sync>;
type Holder = Arc<dyn Fn() -> HashSet<u16> + Send + Sync>;

/// 1.173.0 A3: serializes every hand-out of a block — a card's
/// (`KanbanStore::ensure_port_base`) and a copy's
/// (`copies::port_base_for_cwd`) — so the two never pick the same one.
/// Taken before the kanban cache lock or `copies.json`'s, never under them.
pub static PICK_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 1.173.0 A3: who else holds blocks besides the cards — the copies.
static HOLDERS: RwLock<Vec<Holder>> = RwLock::new(Vec::new());

/// Install a holder: the blocks it holds, read when a card's block is
/// picked, so no card is handed one of them.
pub fn install_holder(holder: Holder) {
    HOLDERS.write().unwrap_or_else(|p| p.into_inner()).push(holder);
}

/// Every block the installed holders (copies) hold.
pub fn held_by_others() -> HashSet<u16> {
    let holders = HOLDERS.read().unwrap_or_else(|p| p.into_inner()).clone();
    holders.iter().flat_map(|h| h()).collect()
}

/// Who maps a worktree to its block: the app's `KanbanStore` (installed at
/// startup), plus any a test adds for its own temporary directory.
static RESOLVERS: RwLock<Vec<Resolver>> = RwLock::new(Vec::new());

/// Install a resolver: `cwd` → the port block of the card worktree it is
/// in, allocating one if needed.
pub fn install_resolver(resolver: Resolver) {
    RESOLVERS.write().unwrap_or_else(|p| p.into_inner()).push(resolver);
}

/// The port variables for a process started in `cwd`: empty unless `cwd`
/// is in a card worktree that has (or now gets) a block.
pub fn env_for_cwd(cwd: Option<&Path>) -> Vec<(String, String)> {
    let Some(cwd) = cwd else { return Vec::new() };
    if worktree_of(cwd).is_none() {
        return Vec::new();
    }
    let resolvers = RESOLVERS.read().unwrap_or_else(|p| p.into_inner()).clone();
    resolvers.iter().find_map(|r| r(cwd)).map(port_env).unwrap_or_default()
}

#[cfg(test)]
#[path = "worktree_ports_tests.rs"]
mod tests;
