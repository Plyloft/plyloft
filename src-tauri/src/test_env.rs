//! Tests whose prerequisite a machine may lack (a symlink privilege, `jq`, a
//! real Win32 GUI binary) skip with a printed reason instead of failing.
//! `PLY_TEST_REQUIRE_ALL=1` turns every such skip into a failure, so CI —
//! where the prerequisites exist — keeps these tests strict.

/// Call when a prerequisite is missing, then `return` from the test: prints
/// `skipped: <reason>`, or panics when `PLY_TEST_REQUIRE_ALL=1`.
pub(crate) fn skip(reason: &str) {
    if std::env::var("PLY_TEST_REQUIRE_ALL").as_deref() == Ok("1") {
        panic!("PLY_TEST_REQUIRE_ALL=1 and a prerequisite is missing: {reason}");
    }
    eprintln!("skipped: {reason}");
}

/// Whether this process may create a symlink. `false` only for Windows'
/// ERROR_PRIVILEGE_NOT_HELD (1314: no Developer Mode, not elevated); any
/// other failure panics, so a real bug is not skipped.
pub(crate) fn can_symlink() -> bool {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(dir.path().join("probe-target"), b"probe").expect("probe target");
    match crate::platform::symlink(&dir.path().join("probe-target"), &dir.path().join("probe-link")) {
        Ok(()) => true,
        Err(err) if err.raw_os_error() == Some(1314) && cfg!(windows) => false,
        Err(err) => panic!("probe symlink: {err}"),
    }
}

/// The address the app's own pages load from on this platform. An IPC request
/// from any other origin is remote, and from tauri 2.11.1 a remote origin
/// reaches no app command, so a test that invokes one must come from here.
pub(crate) fn local_invoke_url() -> tauri::Url {
    let url = if cfg!(any(windows, target_os = "android")) { "http://tauri.localhost" } else { "tauri://localhost" };
    url.parse().expect("invoke URL")
}
