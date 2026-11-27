//! Installed-bundle provenance for the observation-only self-check.
//!
//! The bootstrap installer deliberately keeps its shell implementation in
//! `scripts/install-local-lib.sh`. The signed app uses this native
//! implementation: no shell, subprocess, or IPC-supplied path. A parity test
//! below runs both implementations over one adversarial fixture and requires
//! identical manifest bytes and digest.

use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleFingerprint {
    pub digest: String,
    pub manifest: Vec<u8>,
}

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn hash_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| {
        format!(
            "open bundle file '{}': {error}",
            path.to_string_lossy()
        )
    })?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|error| {
            format!(
                "read bundle file '{}': {error}",
                path.to_string_lossy()
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_entries(root: &Path, path: &Path, entries: &mut Vec<Vec<u8>>) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "inspect bundle entry '{}': {error}",
            path.to_string_lossy()
        )
    })?;
    let relative = if path == root {
        std::borrow::Cow::Borrowed(b".".as_slice())
    } else {
        crate::platform::os_bytes(
            path.strip_prefix(root)
                .map_err(|_| "bundle entry escaped its root".to_string())?
                .as_os_str(),
        )
    };
    let relative_bytes: &[u8] = &relative;
    if relative_bytes
        .iter()
        .any(|byte| *byte == b'\n' || *byte == b'\r')
    {
        return Err(format!(
            "bundle path contains a newline: {}",
            String::from_utf8_lossy(relative_bytes)
        ));
    }

    let mode = crate::platform::mode_of(path, &metadata) & 0o7777;
    let file_type = metadata.file_type();
    let (kind, payload) = if file_type.is_symlink() {
        let target = fs::read_link(path).map_err(|error| {
            format!(
                "read bundle symlink '{}': {error}",
                path.to_string_lossy()
            )
        })?;
        // The accepted installer manifest hashes `readlink`'s stdout, which
        // includes the utility's trailing newline. Preserve that byte exactly
        // so native and shell provenance remain byte-for-byte identical.
        let mut readlink_stdout = crate::platform::os_bytes(target.as_os_str()).into_owned();
        readlink_stdout.push(b'\n');
        ("symlink", hex_bytes(&readlink_stdout))
    } else if file_type.is_dir() {
        ("directory", "-".to_string())
    } else if file_type.is_file() {
        ("file", hash_file(path)?)
    } else {
        return Err(format!(
            "unsupported bundle entry: {}",
            String::from_utf8_lossy(relative_bytes)
        ));
    };

    entries.push(
        format!(
            "{}\t{kind}\t{mode:o}\t{payload}\n",
            hex_bytes(relative_bytes)
        )
        .into_bytes(),
    );

    if file_type.is_dir() {
        let children = fs::read_dir(path).map_err(|error| {
            format!(
                "read bundle directory '{}': {error}",
                path.to_string_lossy()
            )
        })?;
        for child in children {
            let child = child.map_err(|error| {
                format!(
                    "read bundle directory entry '{}': {error}",
                    path.to_string_lossy()
                )
            })?;
            collect_entries(root, &child.path(), entries)?;
        }
    }
    Ok(())
}

/// Compute the accepted bundle manifest and its SHA-256 identity.
///
/// This path is internal-only. The installed self-check calls
/// [`current_app_bundle`] and never accepts a bundle path from IPC.
pub(crate) fn fingerprint_bundle(bundle: &Path) -> Result<BundleFingerprint, String> {
    if !bundle.is_absolute() {
        return Err(format!(
            "bundle must be absolute: {}",
            bundle.to_string_lossy()
        ));
    }
    let root_metadata = fs::symlink_metadata(bundle)
        .map_err(|error| format!("inspect bundle '{}': {error}", bundle.to_string_lossy()))?;
    if root_metadata.file_type().is_symlink() {
        return Err(format!(
            "bundle root cannot be a symlink: {}",
            bundle.to_string_lossy()
        ));
    }
    if !root_metadata.file_type().is_dir() {
        return Err(format!(
            "bundle is not an existing directory: {}",
            bundle.to_string_lossy()
        ));
    }

    let mut entries = Vec::new();
    collect_entries(bundle, bundle, &mut entries)?;
    entries.sort();
    let manifest = entries.concat();
    let digest = format!("{:x}", Sha256::digest(&manifest));
    Ok(BundleFingerprint { digest, manifest })
}

fn app_bundle_for_executable(executable: &Path) -> Result<PathBuf, String> {
    executable
        .ancestors()
        .find(|ancestor| ancestor.extension() == Some(OsStr::new("app")))
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            format!(
                "current executable is not inside an app bundle: {}",
                executable.to_string_lossy()
            )
        })
}

/// Whether an installed Ply has a bundle to fingerprint: the Mac's `.app`.
/// Windows installs a plain directory (NSIS), so there provenance is not
/// applicable rather than unavailable.
pub(crate) const PROVENANCE_APPLIES: bool = cfg!(not(windows));

/// Resolve the `.app` containing the currently executing Ply binary.
pub(crate) fn current_app_bundle() -> Result<PathBuf, String> {
    if !PROVENANCE_APPLIES {
        return Err("installed bundle provenance is not applicable on Windows".into());
    }
    let executable =
        std::env::current_exe().map_err(|error| format!("resolve Plyloft executable: {error}"))?;
    app_bundle_for_executable(&executable)
}

#[cfg(test)]
mod tests {
    use super::*;
    // The fixtures need symlinks, mode bits and the installer's bash script.
    #[cfg(unix)]
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[cfg(unix)]
    #[cfg(unix)]
    use tempfile::TempDir;

    #[cfg(unix)]
    fn fixture_bundle() -> (TempDir, PathBuf) {
        let temp = TempDir::new().unwrap();
        let bundle = temp.path().join("Parity Fixture.app");
        let macos = bundle.join("Contents").join("MacOS");
        let resources = bundle.join("Contents").join("Resources").join("space dir");
        fs::create_dir_all(&macos).unwrap();
        fs::create_dir_all(&resources).unwrap();

        let executable = macos.join("Ply Fixture");
        fs::write(&executable, b"#!/bin/sh\nprintf 'fixture\\n'\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(resources.join("empty"), b"").unwrap();
        fs::write(resources.join("bytes.bin"), [0, 1, 2, 0xfe, 0xff]).unwrap();
        symlink("../MacOS/Ply Fixture", bundle.join("Contents").join("Ply Link")).unwrap();
        symlink("missing-target", resources.join("dangling link")).unwrap();
        (temp, bundle)
    }

    #[cfg(unix)]
    fn shell_fingerprint(bundle: &Path, manifest: &Path) -> String {
        let library = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("scripts")
            .join("install-local-lib.sh");
        let output = crate::platform::new_command("/bin/bash")
            .arg("-c")
            .arg("source \"$1\"; bundle_fingerprint \"$2\" \"$3\"")
            .arg("bash")
            .arg(library)
            .arg(bundle)
            .arg(manifest)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "shell fingerprint failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .to_string()
    }

    #[test]
    #[cfg(unix)]
    fn native_manifest_matches_installer_shell_byte_for_byte() {
        let (_temp, bundle) = fixture_bundle();
        let native = fingerprint_bundle(&bundle).unwrap();
        let shell_manifest = bundle.parent().unwrap().join("shell-manifest");
        let shell_digest = shell_fingerprint(&bundle, &shell_manifest);
        let shell_manifest = fs::read(shell_manifest).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&native.manifest),
            String::from_utf8_lossy(&shell_manifest),
            "native and shell manifests differ"
        );
        assert_eq!(native.digest, shell_digest);
    }

    #[test]
    #[cfg(unix)]
    fn file_bytes_modes_and_symlink_targets_change_identity() {
        let (_temp, bundle) = fixture_bundle();
        let original = fingerprint_bundle(&bundle).unwrap().digest;

        let binary = bundle
            .join("Contents")
            .join("Resources")
            .join("space dir")
            .join("bytes.bin");
        let mut file = fs::OpenOptions::new().append(true).open(&binary).unwrap();
        file.write_all(b"x").unwrap();
        let bytes_changed = fingerprint_bundle(&bundle).unwrap().digest;
        assert_ne!(original, bytes_changed);

        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let mode_changed = fingerprint_bundle(&bundle).unwrap().digest;
        assert_ne!(bytes_changed, mode_changed);

        let link = bundle.join("Contents").join("Ply Link");
        fs::remove_file(&link).unwrap();
        symlink("../Resources/space dir/bytes.bin", &link).unwrap();
        let link_changed = fingerprint_bundle(&bundle).unwrap().digest;
        assert_ne!(mode_changed, link_changed);
    }

    #[test]
    #[cfg(unix)]
    fn rejects_newline_and_carriage_return_paths_like_the_installer() {
        for invalid in ["bad\nname", "bad\rname"] {
            let (_temp, bundle) = fixture_bundle();
            fs::write(bundle.join("Contents").join(invalid), b"x").unwrap();
            let error = fingerprint_bundle(&bundle).unwrap_err();
            assert!(error.contains("contains a newline"), "{error}");
        }
    }

    #[test]
    #[cfg(unix)]
    fn rejects_relative_missing_and_symlink_roots() {
        assert!(fingerprint_bundle(Path::new("Ply.app")).is_err());
        let temp = TempDir::new().unwrap();
        assert!(fingerprint_bundle(&temp.path().join("missing.app")).is_err());
        let real = temp.path().join("real.app");
        fs::create_dir(&real).unwrap();
        let link = temp.path().join("link.app");
        symlink(&real, &link).unwrap();
        assert!(fingerprint_bundle(&link).is_err());
    }

    #[test]
    fn app_bundle_resolution_stops_at_the_containing_app() {
        let executable = Path::new("/Applications/Ply.app/Contents/MacOS/atelier");
        assert_eq!(
            app_bundle_for_executable(executable).unwrap(),
            Path::new("/Applications/Ply.app")
        );
        assert!(app_bundle_for_executable(Path::new(
            "/workspace/src-tauri/target/debug/atelier"
        ))
        .is_err());
    }

    #[test]
    fn production_fingerprint_path_has_no_shell_or_subprocess() {
        let source = include_str!("bundle_fingerprint.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("bundle fingerprint test boundary");
        for forbidden in [
            "std::process",
            "Command::",
            "/bin/bash",
            "bundle_fingerprint(",
        ] {
            assert!(
                !production.contains(forbidden),
                "production fingerprint path contains forbidden surface {forbidden}"
            );
        }
    }
}
