fn main() {
    conpty_bundle();
    // Windows spike: Tauri links its Common Controls v6 manifest into the app
    // binary only, and a test binary without it dies before main with
    // STATUS_ENTRYPOINT_NOT_FOUND. On MSVC the same manifest is embedded by
    // the linker into every binary instead, tests included.
    let msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if msvc {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        let attributes = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attributes).expect("tauri build");
    } else {
        tauri_build::build()
    }
}

/// 1.169.0 (B2): a Windows build ships Microsoft's ConPTY (conpty.dll and
/// OpenConsole.exe, NuGet Microsoft.Windows.Console.ConPTY, MIT) in
/// `<install dir>\conpty\` — `tauri.windows.conf.json` maps
/// `windows/conpty/bundle` there, and tauri-build copies it beside the exe
/// for `tauri dev` and the tests. `scripts/fetch-conpty.mjs` fetches the
/// version pinned in `windows/conpty.lock.json` (once, cached), checks every
/// SHA-256 and lays out the target's arch; it does nothing when the dir is
/// already right. Never for the Mac; never at runtime
/// (`conpty_host.rs` loads what is there, else the system ConPTY).
fn conpty_bundle() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x64",
        Ok("aarch64") => "arm64",
        other => panic!("no bundled ConPTY for target arch {other:?} (windows/conpty.lock.json)"),
    };
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let script = manifest.join("..").join("scripts").join("fetch-conpty.mjs");
    let lock = manifest.join("windows").join("conpty.lock.json");
    let out = manifest.join("windows").join("conpty").join("bundle");
    for path in [&script, &lock, &manifest.join("windows").join("ConPTY-LICENSE.txt")] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rerun-if-changed={}", out.display());
    let status = std::process::Command::new("node")
        .arg(&script)
        .args(["--arch", arch, "--out"])
        .arg(&out)
        .status()
        .unwrap_or_else(|e| panic!("bundled ConPTY: could not run `node {}` ({e}); Node.js is needed to build for Windows", script.display()));
    assert!(status.success(), "bundled ConPTY: `node {} --arch {arch}` failed (see above)", script.display());
}
