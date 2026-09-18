//! Runner token resolution — keeps the token out of argv and out of service
//! files. Precedence: `--token` flag, then `BARO_RUNNER_TOKEN`, then the
//! legacy `RUNNER_TOKEN`, then the 0600 file under `baro_home()`.

use std::io;
use std::path::PathBuf;

use crate::baro_home::baro_home;

pub fn token_file() -> PathBuf {
    baro_home().join("runner-token")
}

pub fn resolve_runner_token(flag: Option<String>) -> Option<String> {
    let non_empty = |v: Option<String>| v.filter(|s| !s.trim().is_empty());
    non_empty(flag)
        .or_else(|| non_empty(std::env::var("BARO_RUNNER_TOKEN").ok()))
        .or_else(|| non_empty(std::env::var("RUNNER_TOKEN").ok()))
        .or_else(|| {
            std::fs::read_to_string(token_file())
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
}

pub fn write_token_file(token: &str) -> io::Result<()> {
    let path = token_file();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Drops `--token X` and `--token=X` so the token never lands in argv (and
/// therefore never shows up in `ps`).
pub fn scrub_token_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--token" {
            i += 2;
        } else if args[i].starts_with("--token=") {
            i += 1;
        } else {
            out.push(args[i].clone());
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rust tests share one process, so every env-mutating test in this module
    /// must hold this before touching BARO_HOME / *_TOKEN vars.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn restore(prev: Option<std::ffi::OsString>, key: &str) {
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }

    #[test]
    fn scrub_token_args_drops_space_and_equals_forms() {
        let args = [
            "--service".to_string(),
            "--token".to_string(),
            "rt_secret".to_string(),
            "--workspace".to_string(),
            ".".to_string(),
        ];
        assert_eq!(
            scrub_token_args(&args),
            vec!["--service".to_string(), "--workspace".to_string(), ".".to_string()]
        );

        let args = ["--token=rt_secret".to_string(), "--once".to_string()];
        assert_eq!(scrub_token_args(&args), vec!["--once".to_string()]);

        // A dangling --token with no value is still dropped.
        let args = ["--token".to_string()];
        assert!(scrub_token_args(&args).is_empty());
    }

    #[test]
    fn resolve_and_write_token_file_follow_precedence_under_baro_home() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("baro-home");

        let prev_home = std::env::var_os("BARO_HOME");
        let prev_baro_token = std::env::var_os("BARO_RUNNER_TOKEN");
        let prev_token = std::env::var_os("RUNNER_TOKEN");
        std::env::set_var("BARO_HOME", &home);
        std::env::remove_var("BARO_RUNNER_TOKEN");
        std::env::remove_var("RUNNER_TOKEN");

        assert_eq!(resolve_runner_token(None), None);

        write_token_file("rt_from_file").unwrap();
        let path = token_file();
        assert_eq!(path, home.join("runner-token"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "rt_from_file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        assert_eq!(resolve_runner_token(None), Some("rt_from_file".to_string()));

        std::env::set_var("RUNNER_TOKEN", "rt_from_legacy_env");
        assert_eq!(resolve_runner_token(None), Some("rt_from_legacy_env".to_string()));

        std::env::set_var("BARO_RUNNER_TOKEN", "rt_from_env");
        assert_eq!(resolve_runner_token(None), Some("rt_from_env".to_string()));

        assert_eq!(
            resolve_runner_token(Some("rt_from_flag".to_string())),
            Some("rt_from_flag".to_string())
        );

        restore(prev_home, "BARO_HOME");
        restore(prev_baro_token, "BARO_RUNNER_TOKEN");
        restore(prev_token, "RUNNER_TOKEN");
    }
}
