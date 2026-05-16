//! Run the Architect phase by spawning the TS subprocess at
//! `packages/baro-orchestrator/scripts/run-architect.ts`.
//!
//! The actual Architect implementation lives in TypeScript —
//! `architect-claude.ts` shells out to `claude --print`,
//! `architect-openai.ts` drives Mozaik's native OpenAI runner.
//! Which one runs is decided inside the TS script based on `--llm`.
//! Rust's job here is purely process supervision: locate `tsx`,
//! pipe the (long-form) project context via a tempfile to avoid
//! argv length limits, capture stdout = decision-document markdown,
//! persist a log, return the doc string.
//!
//! Pairs with `subprocess::spawn_and_capture` for log persistence
//! and structured errors, and `discovery::find_dev_repo` to locate
//! the TS toolchain.

use std::io::Write;
use std::path::Path;

use tokio::process::Command;

use crate::app::LlmProvider;
use crate::discovery;
use crate::subprocess::{self, ProcessRunError};

const SCRIPT_REL_PATH: &str = "packages/baro-orchestrator/scripts/run-architect.ts";

/// Spawn the TS Architect, return the markdown decision document.
///
/// `context` is the project's CLAUDE.md content (or equivalent) that
/// the Architect prepends to its user message. Passed via a tempfile
/// rather than as an argv string so large CLAUDE.md files don't
/// blow past `ARG_MAX`.
pub async fn run_architect(
    goal: &str,
    cwd: &Path,
    llm: LlmProvider,
    model: Option<&str>,
    context: Option<&str>,
    openai_api_key: Option<&str>,
) -> Result<String, ProcessRunError> {
    let repo = discovery::find_dev_repo(cwd).ok_or_else(|| ProcessRunError {
        message:
            "could not locate baro repo — no `packages/baro-orchestrator/` found upward \
             from the binary or in the project cwd. Run from inside a baro checkout."
                .into(),
        log_path: None,
    })?;
    let tsx = discovery::find_tsx(&repo).ok_or_else(|| ProcessRunError {
        message: format!(
            "tsx not found at {}/node_modules/.bin/tsx — run `npm install` in the baro repo.",
            repo.display()
        ),
        log_path: None,
    })?;

    let script = repo.join(SCRIPT_REL_PATH);

    // Stash CLAUDE.md (or equivalent) in a tempfile so we can pass
    // `--context-file` rather than a multi-KB argv string. Tempfile
    // is kept alive until the subprocess exits via the binding below.
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

    let mut cmd = Command::new(&tsx);
    cmd.arg(&script)
        .arg("--goal").arg(goal)
        .arg("--cwd").arg(cwd)
        .arg("--llm").arg(llm.as_str());
    if let Some(m) = model {
        cmd.arg("--model").arg(m);
    }
    if let Some(ref f) = ctx_tempfile {
        cmd.arg("--context-file").arg(f.path());
    }
    // Inject OPENAI_API_KEY only when llm=openai and we have one
    // (either entered on the API-key screen or pre-loaded from the
    // user's shell env). The Claude path ignores this var.
    if matches!(llm, LlmProvider::OpenAI) {
        if let Some(key) = openai_api_key {
            cmd.env("OPENAI_API_KEY", key);
        }
    }

    let captured = subprocess::spawn_and_capture(cmd, "architect").await?;
    drop(ctx_tempfile); // explicit cleanup, paranoid about Drop ordering

    let doc = captured.stdout.trim().to_string();
    if doc.is_empty() {
        return Err(ProcessRunError {
            message: "architect returned an empty document".into(),
            log_path: captured.log_path,
        });
    }
    Ok(doc)
}
