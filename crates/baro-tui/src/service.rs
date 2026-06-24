//! Install `baro connect` as a per-user background service so the runner
//! survives a closed terminal, logout, and reboot — without the user learning
//! launchd vs systemd vs Task Scheduler. One command, OS-detected plumbing:
//! launchd LaunchAgent (macOS), systemd `--user` unit (Linux), logon Scheduled
//! Task (Windows). Each restarts the runner on crash and starts it at login.
//!
//! OS is detected at runtime (not `cfg!`), so every backend compiles on every
//! platform and the unsupported-OS path is a clean error, not a build failure.

use std::path::PathBuf;
use std::process::Command;

/// What the installed service should launch.
pub struct ServiceConfig {
    /// The baro binary to run (`std::env::current_exe()`).
    pub exe: PathBuf,
    /// Per-org pairing token (`rt_…`).
    pub token: String,
    /// Local workspace dir the runner serves repo-less runs from.
    pub workspace: PathBuf,
    /// Optional control-plane override (defaults to prod inside the runner).
    pub control_url: Option<String>,
}

const LABEL: &str = "ai.baro.runner";
const UNIT: &str = "baro-runner"; // systemd unit + Windows task name

type R = Result<(), Box<dyn std::error::Error>>;

pub fn install(cfg: &ServiceConfig) -> R {
    match std::env::consts::OS {
        "macos" => install_macos(cfg),
        "linux" => install_linux(cfg),
        "windows" => install_windows(cfg),
        other => Err(unsupported(other)),
    }
}

pub fn uninstall() -> R {
    match std::env::consts::OS {
        "macos" => uninstall_macos(),
        "linux" => uninstall_linux(),
        "windows" => uninstall_windows(),
        other => Err(unsupported(other)),
    }
}

fn unsupported(os: &str) -> Box<dyn std::error::Error> {
    format!("--install-service isn't supported on {os}; run `baro connect` under your own process manager (pm2, Docker, supervisor)").into()
}

fn home() -> Result<PathBuf, Box<dyn std::error::Error>> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "could not resolve the home directory".into())
}

/// Where the runner writes its stdout/stderr — `~/.baro/runner.log`.
fn log_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = home()?.join(".baro");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("runner.log"))
}

/// The `connect …` argument list the service re-invokes (without the install flag).
fn connect_args(cfg: &ServiceConfig) -> Vec<String> {
    let mut args = vec![
        "connect".to_string(),
        "--token".to_string(),
        cfg.token.clone(),
        "--workspace".to_string(),
        cfg.workspace.display().to_string(),
    ];
    if let Some(url) = &cfg.control_url {
        args.push("--control-url".to_string());
        args.push(url.clone());
    }
    args
}

// ───────────────────────────────── macOS ─────────────────────────────────

fn plist_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(home()?.join("Library/LaunchAgents").join(format!("{LABEL}.plist")))
}

fn install_macos(cfg: &ServiceConfig) -> R {
    let path = plist_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let log = log_path()?;
    let log = log.display().to_string();

    // ProgramArguments: the exe, then `connect …`.
    let mut program = vec![cfg.exe.display().to_string()];
    program.extend(connect_args(cfg));
    let program_xml = program
        .iter()
        .map(|a| format!("    <string>{}</string>", xml_escape(a)))
        .collect::<Vec<_>>()
        .join("\n");

    // launchd starts services with a bare PATH (no /usr/local/bin, /opt/homebrew/…),
    // so node/tsx/claude wouldn't be found. Bake the PATH that was in effect at
    // install time — whatever made `baro` + `node` resolvable in the user's shell.
    let path_env = xml_escape(&install_path());

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{program_xml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>{path_env}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#
    );
    std::fs::write(&path, plist)?;
    let p = path.display().to_string();
    // Reload: unload any prior copy (silently — it usually isn't loaded), then
    // load enabled.
    let _ = Command::new("launchctl")
        .args(["unload", &p])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let status = Command::new("launchctl").args(["load", "-w", &p]).status()?;
    if !status.success() {
        return Err(format!("launchctl load failed for {p}").into());
    }
    println!("✓ Installed launchd service '{LABEL}' — runner starts at login and restarts on crash.");
    println!("  logs:      {log}");
    println!("  status:    launchctl list | grep {LABEL}");
    println!("  uninstall: baro connect --uninstall-service");
    Ok(())
}

fn uninstall_macos() -> R {
    let path = plist_path()?;
    let p = path.display().to_string();
    let _ = Command::new("launchctl").args(["unload", "-w", &p]).status();
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    println!("✓ Removed launchd service '{LABEL}'.");
    Ok(())
}

// ───────────────────────────────── Linux ─────────────────────────────────

fn unit_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(home()?.join(".config/systemd/user").join(format!("{UNIT}.service")))
}

fn install_linux(cfg: &ServiceConfig) -> R {
    let path = unit_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // ExecStart is a single line; quote args so paths with spaces survive.
    let mut parts = vec![cfg.exe.display().to_string()];
    parts.extend(connect_args(cfg));
    let exec = parts.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ");

    // Bake the install-time PATH so node/tsx/claude resolve under systemd's
    // otherwise-minimal environment (same reason as the launchd plist).
    let path_env = install_path();
    let unit = format!(
        "[Unit]\n\
         Description=baro-cloud runner\n\
         After=network-online.target\n\
         Wants=network-online.target\n\n\
         [Service]\n\
         Environment=PATH={path_env}\n\
         ExecStart={exec}\n\
         Restart=always\n\
         RestartSec=2\n\n\
         [Install]\n\
         WantedBy=default.target\n"
    );
    std::fs::write(&path, unit)?;

    Command::new("systemctl").args(["--user", "daemon-reload"]).status()?;
    let status = Command::new("systemctl")
        .args(["--user", "enable", "--now", &format!("{UNIT}.service")])
        .status()?;
    if !status.success() {
        return Err("`systemctl --user enable --now` failed (is systemd user mode available?)".into());
    }
    // Keep the user manager alive without an active login so it runs after reboot.
    if let Ok(user) = std::env::var("USER") {
        let _ = Command::new("loginctl").args(["enable-linger", &user]).status();
    }
    println!("✓ Installed systemd user service '{UNIT}' — runner starts at boot and restarts on crash.");
    println!("  logs:      journalctl --user -u {UNIT} -f");
    println!("  status:    systemctl --user status {UNIT}");
    println!("  uninstall: baro connect --uninstall-service");
    Ok(())
}

fn uninstall_linux() -> R {
    let _ = Command::new("systemctl")
        .args(["--user", "disable", "--now", &format!("{UNIT}.service")])
        .status();
    let path = unit_path()?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    let _ = Command::new("systemctl").args(["--user", "daemon-reload"]).status();
    println!("✓ Removed systemd user service '{UNIT}'.");
    Ok(())
}

// ──────────────────────────────── Windows ────────────────────────────────

fn install_windows(cfg: &ServiceConfig) -> R {
    // A logon Scheduled Task runs in the user's session (needed for the claude
    // CLI subscription auth) and survives logout/reboot. No admin, no service
    // wrapper, no extra dependency — the cleanest dependency-free option.
    let mut parts = vec![cfg.exe.display().to_string()];
    parts.extend(connect_args(cfg));
    // The task action is one string; wrap each part in quotes (escaping inner ").
    let action = parts
        .iter()
        .map(|a| format!("\\\"{}\\\"", a.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(" ");

    let status = Command::new("schtasks")
        .args([
            "/create",
            "/tn",
            UNIT,
            "/sc",
            "onlogon",
            "/rl",
            "highest",
            "/f",
            "/tr",
            &action,
        ])
        .status()?;
    if !status.success() {
        return Err("`schtasks /create` failed".into());
    }
    // Start it now too, so the user doesn't have to log out/in first.
    let _ = Command::new("schtasks").args(["/run", "/tn", UNIT]).status();
    println!("✓ Installed logon Scheduled Task '{UNIT}' — runner starts at logon and is running now.");
    println!("  status:    schtasks /query /tn {UNIT}");
    println!("  uninstall: baro connect --uninstall-service");
    Ok(())
}

fn uninstall_windows() -> R {
    let _ = Command::new("schtasks").args(["/end", "/tn", UNIT]).status();
    let status = Command::new("schtasks").args(["/delete", "/tn", UNIT, "/f"]).status()?;
    if !status.success() {
        return Err("`schtasks /delete` failed".into());
    }
    println!("✓ Removed Scheduled Task '{UNIT}'.");
    Ok(())
}

// ──────────────────────────────── helpers ────────────────────────────────

/// Minimal XML escaping for launchd plist string values.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// PATH to bake into the service so background launches find node/tsx/claude.
/// Falls back to common install dirs if the environment somehow has none.
fn install_path() -> String {
    match std::env::var("PATH") {
        Ok(p) if !p.is_empty() => p,
        _ => "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin".to_string(),
    }
}

/// Single-quote a string for a systemd ExecStart token (POSIX shell quoting).
fn sh_quote(s: &str) -> String {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./:=".contains(&b)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}
