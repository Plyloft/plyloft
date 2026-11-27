//! A dev-only Team plan for a walk: runs `scripts/dev-mint-entitlement.mjs`
//! (embedded, so the installed server needs no checkout) with the dev key. The
//! token comes back on stdout and goes straight to the bridge; it is never in
//! an argument, a tool answer or a log. No server is involved. For the Windows
//! target this still runs on the Mac: only the token goes to the VM, whose test
//! build trusts it through `PLYLOFT_ENTITLEMENT_PUBKEY`, the public half.

use crate::readers::TEAM_REPO;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

const MINT_SCRIPT: &str = include_str!("../../../scripts/dev-mint-entitlement.mjs");

/// The fixed arguments of one mint. `key` only in tests: by default the script
/// reads `~/ply-build/launch-dev-keys/entitlement-dev.pem`.
pub fn mint_argv(device: &str, login: &str, sub: &str, role: &str, key: Option<&Path>) -> Vec<String> {
    let mut argv: Vec<String> = [
        "--device", device, "--plan", "team", "--team-repo", TEAM_REPO, "--role", role, "--login", login, "--sub", sub,
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();
    if let Some(key) = key {
        argv.push("--key".into());
        argv.push(key.display().to_string());
    }
    argv
}

pub fn mint_team(device: &str, login: &str, sub: &str, role: &str, key: Option<&Path>) -> Result<String, String> {
    let mut child = Command::new("node")
        .args(["--input-type=module", "-"])
        .args(mint_argv(device, login, sub, role, key))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("node (to mint the dev plan): {e}"))?;
    child
        .stdin
        .take()
        .ok_or("node has no stdin")?
        .write_all(MINT_SCRIPT.as_bytes())
        .map_err(|e| format!("node stdin: {e}"))?;
    let output = child.wait_with_output().map_err(|e| format!("node: {e}"))?;
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || !token.starts_with("PLY2-") {
        return Err(format!("minting the dev plan failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::Value;

    const DEVICE: &str = "0123456789abcdef0123456789abcdef";

    fn dev_key(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("key.pem");
        let script = "const {generateKeyPairSync:g}=require('crypto');\
            require('fs').writeFileSync(process.argv[1],g('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))";
        assert!(Command::new("node").args(["-e", script]).arg(&path).status().unwrap().success());
        path
    }

    #[test]
    fn a_minted_plan_names_the_team_the_role_and_the_person() {
        let dir = tempfile::tempdir().unwrap();
        let key = dev_key(dir.path());
        let token = mint_team(DEVICE, "test-user", "1000002", "member", Some(&key)).unwrap();
        let body = token.strip_prefix("PLY2-").unwrap().split('.').next().unwrap();
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body).unwrap();
        let payload: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(payload["plan"], "team");
        assert_eq!(payload["teamRepo"], TEAM_REPO);
        assert_eq!(payload["teamRole"], "member");
        assert_eq!(payload["deviceId"], DEVICE);
        assert_eq!(payload["login"], "test-user");
        assert_eq!(payload["sub"], "1000002");
    }

    #[test]
    fn a_failed_mint_says_why_and_hands_back_no_token() {
        let dir = tempfile::tempdir().unwrap();
        let key = dev_key(dir.path());
        let bad = mint_team("not-a-device", "a", "1", "owner", Some(&key)).unwrap_err();
        assert!(bad.contains("--device"), "{bad}");
        assert!(!bad.contains("PLY2-"), "{bad}");
        let missing = mint_team(DEVICE, "a", "1", "owner", Some(&dir.path().join("none.pem"))).unwrap_err();
        assert!(missing.contains("minting the dev plan failed"), "{missing}");
    }
}
