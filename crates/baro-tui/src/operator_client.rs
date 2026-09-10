//! The operator as a subprocess: `operator.mjs --protocol json`, one JSON
//! object per line each way (docs/operator-protocol.md). The TUI draws what
//! arrives and forwards what the person types; the Node side owns the model,
//! its tools and the baro runs it delegates.

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::discovery::{self, ScriptEntry};

const SCRIPT_REL_PATH: &str = "packages/baro-orchestrator/scripts/operator.ts";
const BUNDLE_NAME: &str = "operator.mjs";

#[derive(Debug, Clone, Deserialize)]
pub struct OperatorRun {
    pub id: String,
    pub state: String,
    pub phase: String,
    #[serde(default)]
    pub completed: u32,
    #[serde(default)]
    pub total: u32,
    // Carried for the run drill-in that follows; the strip shows the rest.
    #[allow(dead_code)]
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub elapsed: String,
    #[allow(dead_code)]
    #[serde(default)]
    pub pr_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum OperatorEvent {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "note")]
    Note { text: String },
    #[serde(rename = "assistant_delta")]
    AssistantDelta { text: String },
    #[serde(rename = "tool_call")]
    ToolCall { name: String, summary: String },
    #[serde(rename = "ask")]
    Ask {
        id: String,
        kind: String,
        prompt: String,
        #[serde(default)]
        tool: Option<String>,
        #[serde(default)]
        summary: Option<String>,
    },
    #[serde(rename = "turn_done")]
    TurnDone {
        #[serde(default)]
        duration_ms: Option<f64>,
        #[serde(default)]
        cost_usd: Option<f64>,
    },
    #[serde(rename = "runs")]
    Runs { runs: Vec<OperatorRun> },
    #[serde(rename = "exit")]
    Exit,
    /// The process is gone; `reason` is set when it did not say goodbye.
    #[serde(skip)]
    Gone { reason: Option<String> },
}

pub struct OperatorLaunch {
    pub cwd: std::path::PathBuf,
    pub model: Option<String>,
    pub permission_auto: bool,
    pub local_only: bool,
}

/// Spawn the operator; events arrive on `tx`, stdin lines leave through the
/// returned sender. The child dies with the TUI (kill_on_drop); the baro runs
/// it delegated are detached and outlive both.
pub fn spawn_operator(
    launch: OperatorLaunch,
    tx: mpsc::Sender<OperatorEvent>,
) -> Result<mpsc::Sender<String>, String> {
    let entry = discovery::locate_script(&launch.cwd, SCRIPT_REL_PATH, BUNDLE_NAME)?;
    let mut cmd = match &entry {
        ScriptEntry::Tsx { tsx, script } => {
            let mut c = tokio::process::Command::new(tsx);
            c.arg(script);
            c
        }
        ScriptEntry::NodeJs(js) => {
            let mut c = tokio::process::Command::new("node");
            c.arg(js);
            c
        }
    };
    cmd.arg("--protocol").arg("json");
    cmd.arg("--cwd").arg(&launch.cwd);
    if let Some(model) = &launch.model {
        cmd.arg("--model").arg(model);
    }
    if launch.permission_auto {
        cmd.arg("--permission").arg("auto");
    }
    if launch.local_only {
        cmd.arg("--local-only");
    }
    // A child that inherits the host's run id believes it is that run.
    cmd.env_remove("BARO_RUN_ID");
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|error| format!("failed to spawn the operator: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "operator stdout missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "operator stderr missing".to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "operator stdin missing".to_string())?;

    let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(64);
    tokio::spawn(async move {
        while let Some(line) = stdin_rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
            {
                break;
            }
            let _ = stdin.flush().await;
        }
    });

    let stderr_tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let tail_writer = stderr_tail.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut tail = tail_writer.lock().unwrap();
            tail.push(line);
            if tail.len() > 20 {
                tail.remove(0);
            }
        }
    });

    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut said_goodbye = false;
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<OperatorEvent>(trimmed) {
                Ok(event) => {
                    if matches!(event, OperatorEvent::Exit) {
                        said_goodbye = true;
                    }
                    if tx.send(event).await.is_err() {
                        break;
                    }
                }
                Err(_) => {
                    // Unknown event types are the protocol growing; ignore.
                }
            }
        }
        let status = child.wait().await.ok();
        let reason = if said_goodbye {
            None
        } else {
            let tail = stderr_tail.lock().unwrap().join("\n");
            Some(match status {
                Some(status) if tail.is_empty() => format!("operator exited ({status})"),
                Some(status) => format!("operator exited ({status}): {tail}"),
                None => "operator exited".to_string(),
            })
        };
        let _ = tx.send(OperatorEvent::Gone { reason }).await;
    });

    Ok(stdin_tx)
}

pub fn user_command(text: &str) -> String {
    serde_json::json!({ "type": "user", "text": text }).to_string()
}

pub fn answer_command(id: &str, answer: &str) -> String {
    serde_json::json!({ "type": "answer", "id": id, "answer": answer }).to_string()
}

pub fn quit_command(stop_runs: bool) -> String {
    serde_json::json!({ "type": "quit", "stop_runs": stop_runs }).to_string()
}
