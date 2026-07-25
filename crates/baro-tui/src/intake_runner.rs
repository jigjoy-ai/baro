//! Run the Intake phase by spawning the TS subprocess
//! (`run-intake.ts`) — same shape as `planner_runner`. Stdout is a
//! ModeContract JSON blob. Never fails: any error collapses to a
//! focused heuristic contract so intake can't block a run.

use std::io::Write;
use std::path::Path;

use tokio::process::Command;

use crate::app::LlmProvider;
use crate::discovery::{self, ScriptEntry};
use crate::subprocess;

const SCRIPT_REL_PATH: &str = "packages/baro-orchestrator/scripts/run-intake.ts";
const BUNDLE_NAME: &str = "run-intake.mjs";

pub const FALLBACK_CONTRACT: &str = r#"{"mode":"focused","confidence":0.5,"reason":"Intake unavailable — defaulting to focused.","maxStories":1,"parallelism":1,"source":"heuristic"}"#;

pub async fn run_intake(
    goal: &str,
    cwd: &Path,
    llm: LlmProvider,
    model: Option<&str>,
    context: Option<&str>,
    decision_doc: Option<&str>,
    openai_api_key: Option<&str>,
    openai_base_url: Option<&str>,
    on_progress: impl Fn(&str),
    on_event: impl Fn(&str),
) -> String {
    match try_run(
        goal,
        cwd,
        llm,
        model,
        context,
        decision_doc,
        openai_api_key,
        openai_base_url,
        on_progress,
        on_event,
    )
    .await
    {
        Ok(json) => json,
        Err(_) => FALLBACK_CONTRACT.to_string(),
    }
}

async fn try_run(
    goal: &str,
    cwd: &Path,
    llm: LlmProvider,
    model: Option<&str>,
    context: Option<&str>,
    decision_doc: Option<&str>,
    openai_api_key: Option<&str>,
    openai_base_url: Option<&str>,
    on_progress: impl Fn(&str),
    on_event: impl Fn(&str),
) -> Result<String, String> {
    let entry = discovery::locate_script(cwd, SCRIPT_REL_PATH, BUNDLE_NAME)?;

    // Both tempfiles must stay alive until the child exits.
    let ctx_tempfile = write_optional_tempfile("context", context)?;
    let dec_tempfile = write_optional_tempfile("decision", decision_doc)?;

    let mut cmd = match &entry {
        ScriptEntry::Tsx { tsx, script } => {
            let mut c = Command::new(tsx);
            c.arg(script);
            c
        }
        ScriptEntry::NodeJs(mjs) => {
            let mut c = Command::new("node");
            c.arg(mjs);
            c
        }
    };
    cmd.arg("--goal").arg(goal)
        .arg("--cwd").arg(cwd)
        .arg("--llm").arg(llm.as_str());
    if let Some(m) = model {
        cmd.arg("--model").arg(m);
    }
    if let Some(ref f) = ctx_tempfile {
        cmd.arg("--context-file").arg(f.path());
    }
    if let Some(ref f) = dec_tempfile {
        cmd.arg("--decision-file").arg(f.path());
    }
    if matches!(llm, LlmProvider::OpenAI) {
        if let Some(key) = openai_api_key {
            cmd.env("OPENAI_API_KEY", key);
        }
        if let Some(url) = openai_base_url {
            cmd.env("OPENAI_BASE_URL", url);
        }
    }

    let captured = subprocess::spawn_and_capture_streaming(cmd, "intake", |line| {
        if let Some(msg) = line.strip_prefix("@baro-progress ") {
            on_progress(msg);
        } else if let Some(event) = line.strip_prefix("@baro-event ") {
            on_event(event);
        }
    })
    .await
    .map_err(|e| e.message)?;
    drop(ctx_tempfile);
    drop(dec_tempfile);

    let raw = captured.stdout.trim().to_string();
    // Reject non-JSON stdout here so callers can trust the string.
    serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| format!("intake returned invalid JSON: {}", e))?;
    Ok(raw)
}

fn write_optional_tempfile(
    label: &str,
    body: Option<&str>,
) -> Result<Option<tempfile::NamedTempFile>, String> {
    match body {
        Some(b) if !b.is_empty() => {
            let mut f = tempfile::NamedTempFile::new()
                .map_err(|e| format!("could not create tempfile for intake {}: {}", label, e))?;
            f.write_all(b.as_bytes())
                .map_err(|e| format!("could not write intake {} tempfile: {}", label, e))?;
            Ok(Some(f))
        }
        _ => Ok(None),
    }
}
