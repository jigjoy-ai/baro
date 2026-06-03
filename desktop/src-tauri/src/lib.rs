//! baro-desktop — Tauri core. Spawns the long-lived `session.ts`
//! (plan → run) orchestrator process and bridges it to the WebView:
//!   • the session's stdout JSON events  → Tauri `session-event`
//!   • the session's stderr lines         → Tauri `session-log`
//!   • frontend commands (plan_message / run_plan / shutdown) → session stdin
//!
//! One engine, one event stream — the desktop app is just another consumer
//! of the same protocol the TUI speaks (issue #37).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

/// Absolute path to the orchestrator session script, resolved at build
/// time relative to this crate (desktop/src-tauri → repo root).
const SESSION_SCRIPT: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/baro-orchestrator/scripts/session.ts");
/// Repo root — the session runs `npx tsx`, which resolves tsx from the
/// repo's node_modules, so the child's cwd must be the repo root.
const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

#[derive(Default)]
struct Session {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
}

#[derive(Deserialize)]
struct StartArgs {
    goal: String,
    /// Working directory baro runs against (the target project).
    cwd: String,
    #[serde(default)]
    planner_model: Option<String>,
    #[serde(default)]
    llm: Option<String>,
    #[serde(default)]
    tier_map: Option<String>,
    #[serde(default)]
    openai_endpoints: Vec<String>,
    #[serde(default)]
    no_git: bool,
    #[serde(default)]
    effort: Option<String>,
}

#[tauri::command]
fn start_session(app: AppHandle, state: State<Session>, args: StartArgs) -> Result<(), String> {
    if state.child.lock().unwrap().is_some() {
        return Err("a session is already running".into());
    }

    let mut cmd = Command::new("npx");
    cmd.arg("tsx")
        .arg(SESSION_SCRIPT)
        .arg("--goal")
        .arg(&args.goal)
        .arg("--cwd")
        .arg(&args.cwd)
        .arg("--planner-model")
        .arg(args.planner_model.as_deref().unwrap_or("sonnet"));
    if let Some(l) = &args.llm {
        cmd.arg("--llm").arg(l);
    }
    if let Some(t) = &args.tier_map {
        cmd.arg("--tier-map").arg(t);
    }
    for ep in &args.openai_endpoints {
        cmd.arg("--openai-endpoint").arg(ep);
    }
    if args.no_git {
        cmd.arg("--no-git");
    }
    if let Some(e) = &args.effort {
        cmd.arg("--effort").arg(e);
    }
    cmd.current_dir(REPO_ROOT)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take().ok_or("no stdin")?;

    // stdout: each line is one protocol event.
    let a1 = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = a1.emit("session-event", line);
            }
        }
        let _ = a1.emit("session-event", r#"{"type":"session_exit"}"#.to_string());
    });

    // stderr: human/debug log.
    let a2 = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = a2.emit("session-log", line);
        }
    });

    *state.stdin.lock().unwrap() = Some(stdin);
    *state.child.lock().unwrap() = Some(child);
    Ok(())
}

/// Write one command line (`{"type":"plan_message",…}` / `{"type":"run_plan"}`
/// / `{"type":"shutdown"}`) to the running session's stdin.
#[tauri::command]
fn send_command(state: State<Session>, line: String) -> Result<(), String> {
    let mut guard = state.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("no running session")?;
    stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn stop_session(state: State<Session>) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    *state.stdin.lock().unwrap() = None;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Session::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_session,
            send_command,
            stop_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
