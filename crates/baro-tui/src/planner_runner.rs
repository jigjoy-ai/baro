//! Run the Planner phase by spawning the TS subprocess
//! (`run-planner.ts`) — same shape as `architect_runner`. Returns the
//! raw PRD JSON; callers deserialise it in main.rs so the schema has
//! one source of truth. Context blobs travel via tempfiles to dodge
//! argv length limits.

use std::io::Write;
use std::path::Path;

use tokio::process::Command;

use crate::app::LlmProvider;
use crate::discovery::{self, ScriptEntry};
use crate::subprocess::{self, ProcessRunError};

const SCRIPT_REL_PATH: &str = "packages/baro-orchestrator/scripts/run-planner.ts";
const BUNDLE_NAME: &str = "run-planner.mjs";

pub async fn run_planner(
    goal: &str,
    cwd: &Path,
    llm: LlmProvider,
    model: Option<&str>,
    context: Option<&str>,
    decision_doc: Option<&str>,
    quick: bool,
    openai_api_key: Option<&str>,
    openai_base_url: Option<&str>,
    effort: &str,
) -> Result<String, ProcessRunError> {
    let entry = discovery::locate_script(cwd, SCRIPT_REL_PATH, BUNDLE_NAME).map_err(|e| {
        ProcessRunError { message: e, log_path: None }
    })?;

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
    cmd.arg("--effort").arg(effort);
    if let Some(ref f) = ctx_tempfile {
        cmd.arg("--context-file").arg(f.path());
    }
    if let Some(ref f) = dec_tempfile {
        cmd.arg("--decision-file").arg(f.path());
    }
    if quick {
        cmd.arg("--quick");
    }
    if matches!(llm, LlmProvider::OpenAI) {
        if let Some(key) = openai_api_key {
            cmd.env("OPENAI_API_KEY", key);
        }
        if let Some(url) = openai_base_url {
            cmd.env("OPENAI_BASE_URL", url);
        }
    }

    let captured = subprocess::spawn_and_capture(cmd, "planner").await?;
    drop(ctx_tempfile);
    drop(dec_tempfile);

    let raw = captured.stdout.trim().to_string();
    if raw.is_empty() {
        return Err(ProcessRunError {
            message: "planner returned an empty response".into(),
            log_path: captured.log_path,
        });
    }
    Ok(raw)
}

fn write_optional_tempfile(
    label: &str,
    body: Option<&str>,
) -> Result<Option<tempfile::NamedTempFile>, ProcessRunError> {
    match body {
        Some(b) if !b.is_empty() => {
            let mut f = tempfile::NamedTempFile::new().map_err(|e| ProcessRunError {
                message: format!("could not create tempfile for planner {}: {}", label, e),
                log_path: None,
            })?;
            f.write_all(b.as_bytes()).map_err(|e| ProcessRunError {
                message: format!("could not write planner {} tempfile: {}", label, e),
                log_path: None,
            })?;
            Ok(Some(f))
        }
        _ => Ok(None),
    }
}
