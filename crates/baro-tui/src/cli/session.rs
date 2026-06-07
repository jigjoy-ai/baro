use std::{fs, path::{Path, PathBuf}};

pub struct SessionLock {
    path: PathBuf,
}

#[cfg(not(unix))]
fn is_process_alive(_pid: u32) -> bool {
    // On non-Unix platforms, assume stale lock
    false
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

impl SessionLock {
    pub fn acquire(cwd: &Path) -> Result<Self, String> {
        let lock_path = cwd.join("baro.lock");

        if lock_path.exists() {
            if let Ok(contents) = fs::read_to_string(&lock_path) {
                if let Ok(pid) = contents.trim().parse::<u32>() {
                    if is_process_alive(pid) {
                        return Err("Another baro session is active in this directory. Multiple sessions per project coming soon.".to_string())
                    }
                }
            }
        }

        fs::write(&lock_path, std::process::id().to_string()).map_err(|e| format!("Failed to create lock file: {}", e))?;

        Ok(SessionLock { path: lock_path })
    }
}

impl Drop for SessionLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}