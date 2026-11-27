//! Where the test profile lives in the VM. Tauri resolves the app config dir
//! to `%APPDATA%\<identifier>` and logs to `%LOCALAPPDATA%\<identifier>\logs`.

use crate::TEST_IDENTIFIER;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Paths {
    /// `%APPDATA%\com.mbadv.ply.test` — workspaces.json and the other stores.
    pub profile: PathBuf,
    /// `%LOCALAPPDATA%\com.mbadv.ply.test` — logs, the WebView2 data.
    pub local: PathBuf,
    /// `$PLY_TEST_ROOT` or `<profile>\app-tester`; `run\` holds the bridge
    /// port and token, the helper's pid and `stop`.
    pub root: PathBuf,
}

impl Paths {
    pub fn from_env(root: Option<PathBuf>) -> Result<Self, String> {
        let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
        let appdata = var("APPDATA").ok_or("APPDATA is not set")?;
        let local = var("LOCALAPPDATA").ok_or("LOCALAPPDATA is not set")?;
        let profile = appdata.join(TEST_IDENTIFIER);
        let root = root.or_else(|| var("PLY_TEST_ROOT")).unwrap_or_else(|| profile.join("app-tester"));
        Ok(Self { profile, local: local.join(TEST_IDENTIFIER), root })
    }

    pub fn run(&self) -> PathBuf {
        self.root.join("run")
    }

    pub fn stop_file(&self) -> PathBuf {
        self.run().join("stop")
    }

    pub fn logs(&self) -> PathBuf {
        self.local.join("logs")
    }
}
