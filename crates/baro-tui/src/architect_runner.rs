//! Run the Architect phase by spawning the TS subprocess
//! (`run-architect.ts`); the TS side picks the claude vs openai
//! implementation from `--llm`. Rust only supervises the process;
//! stdout is the decision-document markdown.

use std::io::Write;
use std::path::Path;

use tokio::process::Command;

use crate::app::LlmProvider;
use crate::discovery::{self, ScriptEntry};
use crate::subprocess::{self, ProcessRunError};

const SCRIPT_REL_PATH: &str = "packages/baro-orchestrator/scripts/run-architect.ts";
const BUNDLE_NAME: &str = "run-architect.mjs";

/// Spawn the TS Architect, return the markdown decision document.
/// `context` (the project's CLAUDE.md or equivalent) travels via a
/// tempfile so large files don't blow past `ARG_MAX`. An operator-fixed
/// execution-mode contract uses the same tempfile boundary.
pub async fn run_architect(
    goal: &str,
    cwd: &Path,
    llm: LlmProvider,
    model: Option<&str>,
    context: Option<&str>,
    mode_json: Option<&str>,
    openai_api_key: Option<&str>,
    openai_base_url: Option<&str>,
    effort: &str,
    on_event: impl Fn(&str),
) -> Result<String, ProcessRunError> {
    let entry = discovery::locate_script(cwd, SCRIPT_REL_PATH, BUNDLE_NAME).map_err(|e| {
        ProcessRunError { message: e, log_path: None }
    })?;

    // The tempfile must outlive the subprocess — kept alive by this binding.
    let ctx_tempfile = match context {
        Some(c) if !c.is_empty() => {
            let mut f = tempfile::NamedTempFile::new().map_err(|e| ProcessRunError {
                message: format!("could not create tempfile for architect context: {}", e),
                log_path: None,
            })?;
            f.write_all(c.as_bytes()).map_err(|e| ProcessRunError {
                message: format!("could not write architect context tempfile: {}", e),
                log_path: None,
            })?;
            Some(f)
        }
        _ => None,
    };

    let mode_tempfile = match mode_json {
        Some(mode) if !mode.is_empty() => {
            let mut f = tempfile::NamedTempFile::new().map_err(|e| ProcessRunError {
                message: format!("could not create tempfile for architect mode: {}", e),
                log_path: None,
            })?;
            f.write_all(mode.as_bytes()).map_err(|e| ProcessRunError {
                message: format!("could not write architect mode tempfile: {}", e),
                log_path: None,
            })?;
            Some(f)
        }
        _ => None,
    };

    // The child writes the decision doc here so its stdout is free for the
    // event stream; we read the file back after it exits.
    let result_tempfile = tempfile::NamedTempFile::new().map_err(|e| ProcessRunError {
        message: format!("could not create architect result tempfile: {}", e),
        log_path: None,
    })?;

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
    if let Some(ref f) = mode_tempfile {
        cmd.arg("--mode-file").arg(f.path());
    }
    cmd.arg("--result-file").arg(result_tempfile.path());
    if matches!(llm, LlmProvider::OpenAI) {
        if let Some(key) = openai_api_key {
            cmd.env("OPENAI_API_KEY", key);
        }
        if let Some(url) = openai_base_url {
            cmd.env("OPENAI_BASE_URL", url);
        }
    }

    // Stdout is now the architect's live BaroEvent stream; forward each line.
    let log_path = subprocess::spawn_and_stream_events(cmd, "architect", on_event).await?;
    drop(ctx_tempfile); // explicit cleanup, paranoid about Drop ordering
    drop(mode_tempfile);

    let doc = std::fs::read_to_string(result_tempfile.path())
        .map_err(|e| ProcessRunError {
            message: format!("could not read architect result file: {}", e),
            log_path: log_path.clone(),
        })?
        .trim()
        .to_string();
    if doc.is_empty() {
        return Err(ProcessRunError {
            message: "architect returned an empty document".into(),
            log_path,
        });
    }
    Ok(doc)
}
