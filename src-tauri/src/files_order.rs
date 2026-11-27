use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const FILE: &str = "files-order.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct OrdersFile {
    /// Map of workspaceId -> (dirPath -> ordered filename list)
    pub workspaces: HashMap<String, HashMap<String, Vec<String>>>,
}

pub struct FilesOrderStore {
    config_dir: PathBuf,
    state: Mutex<OrdersFile>,
}

impl FilesOrderStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&config_dir).map_err(|e| format!("create_dir_all: {e}"))?;
        let path = config_dir.join(FILE);
        let state = if path.exists() {
            let bytes = fs::read(&path).unwrap_or_default();
            if bytes.is_empty() {
                OrdersFile::default()
            } else {
                serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                    log::warn!("files_order: parse failed ({e}); using empty");
                    OrdersFile::default()
                })
            }
        } else {
            OrdersFile::default()
        };
        Ok(Self {
            config_dir,
            state: Mutex::new(state),
        })
    }

    fn save_atomic(&self, file: &OrdersFile) -> Result<(), String> {
        let path = self.config_dir.join(FILE);
        let tmp = self.config_dir.join(format!("{FILE}.tmp"));
        let json = serde_json::to_vec_pretty(file).map_err(|e| format!("encode: {e}"))?;
        if let Ok(existing) = fs::read(&path) {
            if existing == json {
                return Ok(());
            }
        }
        fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
        crate::platform::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }

    pub fn get(&self, workspace_id: &str, dir: &str) -> Option<Vec<String>> {
        self.state
            .lock()
            .workspaces
            .get(workspace_id)
            .and_then(|m| m.get(dir).cloned())
    }

    pub fn set(
        &self,
        workspace_id: String,
        dir: String,
        order: Vec<String>,
    ) -> Result<(), String> {
        let file = {
            let mut state = self.state.lock();
            state
                .workspaces
                .entry(workspace_id)
                .or_default()
                .insert(dir, order);
            state.clone()
        };
        self.save_atomic(&file)
    }

    pub fn clear_dir(&self, workspace_id: &str, dir: &str) -> Result<(), String> {
        let file = {
            let mut state = self.state.lock();
            if let Some(m) = state.workspaces.get_mut(workspace_id) {
                m.remove(dir);
            }
            state.clone()
        };
        self.save_atomic(&file)
    }

    #[allow(dead_code)]
    pub fn store_path(&self) -> PathBuf {
        self.config_dir.join(FILE)
    }
}

#[allow(dead_code)]
pub fn dir_of(path: &Path) -> Option<String> {
    path.parent().map(|p| p.to_string_lossy().to_string())
}
