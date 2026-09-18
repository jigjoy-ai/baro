//! Install `baro connect` as a per-user background service — launchd
//! LaunchAgent (macOS), systemd `--user` unit (Linux), logon Scheduled
//! Task (Windows) — restarting on crash and starting at login. OS is
//! detected at runtime (not `cfg!`) so every backend compiles on every
//! platform and an unsupported OS is a clean error, not a build failure.

use std::path::PathBuf;
use std::process::Command;

/// What the installed service should launch. The runner token is never part
/// of this: it is written to the 0600 token file before install, and the
/// relaunched `connect` reads it from there instead of from argv.
pub struct ServiceConfig {
    /// The baro binary to run (`std::env::current_exe()`).
    pub exe: PathBuf,
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

/// The `connect …` argument list the service re-invokes (without the install
/// flag or a token — `connect` reads the token from the 0600 file).
fn connect_args(cfg: &ServiceConfig) -> Vec<String> {
    let mut args = vec![
        "connect".to_string(),
        // Marks this as the managed service invocation, so the runner knows it may
        // self-update and exit-to-restart (the service relaunches the new version).
        "--service".to_string(),
        "--workspace".to_string(),
        cfg.workspace.display().to_string(),
    ];
    if let Some(url) = &cfg.control_url {
        args.push("--control-url".to_string());
        args.push(url.clone());
    }
    args
}

fn plist_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(home()?.join("Library/LaunchAgents").join(format!("{LABEL}.plist")))
}

/// Pure launchd plist renderer — `program` is the full argv (exe first).
pub fn launchd_plist(program: &[String], path_env: &str, log: &str) -> String {
    let program_xml = program
        .iter()
        .map(|a| format!("    <string>{}</string>", xml_escape(a)))
        .collect::<Vec<_>>()
        .join("\n");
    let path_env = xml_escape(path_env);
    let log = xml_escape(log);
    format!(
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
    <key>BARO_SERVICE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#
    )
}

fn install_macos(cfg: &ServiceConfig) -> R {
    let path = plist_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let log = log_path()?;
    let log = log.display().to_string();

    let mut program = vec![cfg.exe.display().to_string()];
    program.extend(connect_args(cfg));

    // launchd starts services with a bare PATH, so node/tsx/claude wouldn't
    // resolve — bake in the PATH that was in effect at install time.
    let plist = launchd_plist(&program, &install_path(), &log);
    std::fs::write(&path, plist)?;
    let p = path.display().to_string();
    // Unload any prior copy (usually not loaded), then load enabled.
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

fn unit_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(home()?.join(".config/systemd/user").join(format!("{UNIT}.service")))
}

/// Pure systemd unit renderer — `exec` is the already shell-quoted ExecStart line.
pub fn systemd_unit(path_env: &str, exec: &str) -> String {
    format!(
        "[Unit]\n\
         Description=baro-cloud runner\n\
         After=network-online.target\n\
         Wants=network-online.target\n\n\
         [Service]\n\
         Environment=PATH={path_env}\n\
         Environment=BARO_SERVICE=1\n\
         ExecStart={exec}\n\
         Restart=always\n\
         RestartSec=2\n\n\
         [Install]\n\
         WantedBy=default.target\n"
    )
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

    // Bake the install-time PATH — systemd's environment is otherwise
    // minimal (same reason as the launchd plist).
    let unit = systemd_unit(&install_path(), &exec);
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

/// Pure Windows Scheduled Task `/tr` action renderer — `parts` is the full
/// argv (exe first).
pub fn windows_task_action(parts: &[String]) -> String {
    parts
        .iter()
        .map(|a| format!("\\\"{}\\\"", a.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn install_windows(cfg: &ServiceConfig) -> R {
    // A logon Scheduled Task runs in the user's session (needed for claude
    // CLI subscription auth), survives logout/reboot, and needs no admin
    // rights or service wrapper.
    let mut parts = vec![cfg.exe.display().to_string()];
    parts.extend(connect_args(cfg));
    let action = windows_task_action(&parts);

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

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_TOKEN: &str = "rt_sample_should_never_render";

    fn cfg() -> ServiceConfig {
        ServiceConfig {
            exe: PathBuf::from("/usr/local/bin/baro"),
            workspace: PathBuf::from("/home/op/code/repo"),
            control_url: Some("https://control.example".to_string()),
        }
    }

    #[test]
    fn connect_args_relaunch_command_has_no_token() {
        let args = connect_args(&cfg());
        assert_eq!(
            args,
            vec![
                "connect".to_string(),
                "--service".to_string(),
                "--workspace".to_string(),
                "/home/op/code/repo".to_string(),
                "--control-url".to_string(),
                "https://control.example".to_string(),
            ]
        );
        assert!(!args.iter().any(|a| a == "--token" || a.contains(SAMPLE_TOKEN)));
    }

    #[test]
    fn launchd_plist_renders_without_the_token() {
        let mut program = vec!["/usr/local/bin/baro".to_string()];
        program.extend(connect_args(&cfg()));
        let plist = launchd_plist(&program, "/usr/bin:/bin", "/home/op/.baro/runner.log");
        assert!(!plist.contains(SAMPLE_TOKEN));
        assert!(!plist.contains("--token"));
        assert!(plist.contains("<string>connect</string>"));
        assert!(plist.contains("<string>--service</string>"));
    }

    #[test]
    fn systemd_unit_renders_without_the_token() {
        let mut parts = vec!["/usr/local/bin/baro".to_string()];
        parts.extend(connect_args(&cfg()));
        let exec = parts.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ");
        let unit = systemd_unit("/usr/bin:/bin", &exec);
        assert!(!unit.contains(SAMPLE_TOKEN));
        assert!(!unit.contains("--token"));
        assert!(unit.contains("ExecStart=/usr/local/bin/baro connect --service --workspace"));
    }

    #[test]
    fn windows_task_action_renders_without_the_token() {
        let mut parts = vec!["C:\\baro\\baro.exe".to_string()];
        parts.extend(connect_args(&cfg()));
        let action = windows_task_action(&parts);
        assert!(!action.contains(SAMPLE_TOKEN));
        assert!(!action.contains("--token"));
        assert!(action.contains("\\\"connect\\\""));
    }

    #[test]
    fn xml_escape_and_sh_quote_stay_correct() {
        assert_eq!(xml_escape("a & b < c > d"), "a &amp; b &lt; c &gt; d");
        assert_eq!(sh_quote("plain-path_1.txt"), "plain-path_1.txt");
        assert_eq!(sh_quote("has space"), "'has space'");
    }
}
