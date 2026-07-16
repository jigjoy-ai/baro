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

mod outcome;

#[allow(unused_imports)]
pub use outcome::{
    parse_architect_outcome_transport_v1, ArchitectClarificationQuestionV1,
    ArchitectOutcomeContractError, ArchitectOutcomeKindV1, ArchitectOutcomeTransportV1,
    ArchitectOutcomeV1, ArchitectRepositoryEvidenceV1, ARCHITECT_OUTCOME_SCHEMA_VERSION,
    MAX_ARCHITECT_OUTCOME_BYTES,
};

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
        ProcessRunError {
            message: e,
            log_path: None,
        }
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
    cmd.arg("--goal")
        .arg(goal)
        .arg("--cwd")
        .arg(cwd)
        .arg("--llm")
        .arg(llm.as_str());
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

/// Opt-in repository-aware Architect run. Unlike [`run_architect`], this path
/// requires the TS child to write an exact, correlated `ArchitectOutcomeV1`
/// wrapper. Existing markdown callers remain byte-for-byte unchanged.
pub async fn run_architect_outcome(
    goal: &str,
    cwd: &Path,
    llm: LlmProvider,
    model: Option<&str>,
    context: Option<&str>,
    mode_json: Option<&str>,
    openai_api_key: Option<&str>,
    openai_base_url: Option<&str>,
    effort: &str,
    session_id: &str,
    goal_request_id: &str,
    architect_request_id: &str,
    on_event: impl Fn(&str),
) -> Result<ArchitectOutcomeTransportV1, ProcessRunError> {
    let entry = discovery::locate_script(cwd, SCRIPT_REL_PATH, BUNDLE_NAME).map_err(|message| {
        ProcessRunError {
            message,
            log_path: None,
        }
    })?;
    run_architect_outcome_with_entry(
        entry,
        goal,
        cwd,
        llm,
        model,
        context,
        mode_json,
        openai_api_key,
        openai_base_url,
        effort,
        session_id,
        goal_request_id,
        architect_request_id,
        on_event,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_architect_outcome_with_entry(
    entry: ScriptEntry,
    goal: &str,
    cwd: &Path,
    llm: LlmProvider,
    model: Option<&str>,
    context: Option<&str>,
    mode_json: Option<&str>,
    openai_api_key: Option<&str>,
    openai_base_url: Option<&str>,
    effort: &str,
    session_id: &str,
    goal_request_id: &str,
    architect_request_id: &str,
    on_event: impl Fn(&str),
) -> Result<ArchitectOutcomeTransportV1, ProcessRunError> {
    for (label, value) in [
        ("sessionId", session_id),
        ("goalRequestId", goal_request_id),
        ("architectRequestId", architect_request_id),
    ] {
        outcome::validate_safe_id(label, value).map_err(|error| ProcessRunError {
            message: error.to_string(),
            log_path: None,
        })?;
    }

    let ctx_tempfile = outcome_input_tempfile("architect context", context)?;
    let mode_tempfile = outcome_input_tempfile("architect mode", mode_json)?;
    let outcome_tempfile = tempfile::NamedTempFile::new().map_err(|error| ProcessRunError {
        message: format!("could not create architect outcome tempfile: {error}"),
        log_path: None,
    })?;

    let mut cmd = match entry {
        ScriptEntry::Tsx { tsx, script } => {
            let mut command = Command::new(tsx);
            command.arg(script);
            command
        }
        ScriptEntry::NodeJs(mjs) => {
            let mut command = Command::new("node");
            command.arg(mjs);
            command
        }
    };
    cmd.arg("--goal")
        .arg(goal)
        .arg("--cwd")
        .arg(cwd)
        .arg("--llm")
        .arg(llm.as_str());
    if let Some(model) = model {
        cmd.arg("--model").arg(model);
    }
    cmd.arg("--effort").arg(effort);
    if let Some(ref file) = ctx_tempfile {
        cmd.arg("--context-file").arg(file.path());
    }
    if let Some(ref file) = mode_tempfile {
        cmd.arg("--mode-file").arg(file.path());
    }
    cmd.arg("--outcome-file")
        .arg(outcome_tempfile.path())
        .arg("--conversation-session-id")
        .arg(session_id)
        .arg("--goal-request-id")
        .arg(goal_request_id)
        .arg("--architect-request-id")
        .arg(architect_request_id);
    if matches!(llm, LlmProvider::OpenAI) {
        if let Some(key) = openai_api_key {
            cmd.env("OPENAI_API_KEY", key);
        }
        if let Some(url) = openai_base_url {
            cmd.env("OPENAI_BASE_URL", url);
        }
    }

    let log_path = subprocess::spawn_and_stream_events(cmd, "architect", on_event).await?;
    drop(ctx_tempfile);
    drop(mode_tempfile);

    let metadata = std::fs::metadata(outcome_tempfile.path()).map_err(|error| ProcessRunError {
        message: format!("could not inspect architect outcome file: {error}"),
        log_path: log_path.clone(),
    })?;
    if metadata.len() > MAX_ARCHITECT_OUTCOME_BYTES as u64 {
        return Err(ProcessRunError {
            message: format!(
                "architect outcome transport is {} bytes; limit is {}",
                metadata.len(),
                MAX_ARCHITECT_OUTCOME_BYTES
            ),
            log_path,
        });
    }
    let raw =
        std::fs::read_to_string(outcome_tempfile.path()).map_err(|error| ProcessRunError {
            message: format!("could not read architect outcome file: {error}"),
            log_path: log_path.clone(),
        })?;
    if raw.trim().is_empty() {
        return Err(ProcessRunError {
            message: "architect returned an empty outcome".to_string(),
            log_path,
        });
    }
    parse_architect_outcome_transport_v1(&raw, session_id, goal_request_id, architect_request_id)
        .map_err(|error| ProcessRunError {
            message: format!("invalid architect outcome: {error}"),
            log_path,
        })
}

fn outcome_input_tempfile(
    label: &str,
    value: Option<&str>,
) -> Result<Option<tempfile::NamedTempFile>, ProcessRunError> {
    match value {
        Some(value) if !value.is_empty() => {
            let mut file = tempfile::NamedTempFile::new().map_err(|error| ProcessRunError {
                message: format!("could not create tempfile for {label}: {error}"),
                log_path: None,
            })?;
            file.write_all(value.as_bytes())
                .map_err(|error| ProcessRunError {
                    message: format!("could not write {label} tempfile: {error}"),
                    log_path: None,
                })?;
            Ok(Some(file))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Mutex;

    use super::*;

    fn fake_node_script(body: &str) -> (tempfile::TempDir, ScriptEntry) {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("fake-architect.mjs");
        fs::write(&script, body).unwrap();
        (directory, ScriptEntry::NodeJs(script))
    }

    async fn run_fake(
        entry: ScriptEntry,
        events: &Mutex<Vec<String>>,
    ) -> Result<ArchitectOutcomeTransportV1, ProcessRunError> {
        run_fake_with_context(entry, events, "project context").await
    }

    async fn run_fake_with_context(
        entry: ScriptEntry,
        events: &Mutex<Vec<String>>,
        context: &str,
    ) -> Result<ArchitectOutcomeTransportV1, ProcessRunError> {
        run_architect_outcome_with_entry(
            entry,
            "Implement it",
            Path::new("."),
            LlmProvider::Claude,
            None,
            Some(context),
            Some(r#"{"schemaVersion":1}"#),
            None,
            None,
            "high",
            "session-1",
            "goal-1",
            "architect-1",
            |event| events.lock().unwrap().push(event.to_string()),
        )
        .await
    }

    #[tokio::test]
    async fn outcome_subprocess_passes_correlations_and_streams_events() {
        let (_directory, entry) = fake_node_script(
            r#"
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
if (get("--conversation-session-id") !== "session-1" ||
    get("--goal-request-id") !== "goal-1" ||
    get("--architect-request-id") !== "architect-1" ||
    readFileSync(get("--context-file"), "utf8") !== "project context" ||
    readFileSync(get("--mode-file"), "utf8") !== '{"schemaVersion":1}') {
  process.exit(9);
}
writeFileSync(get("--outcome-file"), JSON.stringify({
  schemaVersion: 1,
  sessionId: get("--conversation-session-id"),
  goalRequestId: get("--goal-request-id"),
  architectRequestId: get("--architect-request-id"),
  outcome: {
    schemaVersion: 1,
    kind: "needsInput",
    message: "Choose the public API.",
    questions: [{id: "q1", text: "Which API?"}],
    evidence: [{path: "src/lib.rs", line: 3, fact: "Two APIs exist."}],
    decisionDocument: null
  }
}));
process.stdout.write('{"type":"agent_status","status":"working"}\n');
"#,
        );
        let events = Mutex::new(Vec::new());
        let outcome = run_fake(entry, &events).await.unwrap();
        assert_eq!(outcome.outcome.kind, ArchitectOutcomeKindV1::NeedsInput);
        assert_eq!(events.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn repository_brief_deep_evidence_reaches_the_architect_context_file() {
        let raw = format!(
            r#"{{"schemaVersion":1,"sessionId":"session-1","requestId":"goal-1","repositoryBrief":{{"schemaVersion":1,"snapshotId":"sha256:{}","summary":"The deep abort coordinator was inspected.","facts":[{{"statement":"The coordinator contains baro-sidecar-deep-evidence.","evidencePath":"src/runtime/cancellation/abort-coordinator.ts","line":1,"confidence":"high"}}],"relevantPaths":["src/runtime/cancellation/abort-coordinator.ts"],"unknowns":[],"truncated":false}}}}"#,
            "a".repeat(64),
        );
        let brief = crate::repository_brief::parse_repository_brief_sidecar(
            &raw,
            "session-1",
            "goal-1",
        )
        .unwrap();
        let context = brief.render_architect_context().unwrap();
        let (_directory, entry) = fake_node_script(
            r#"
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
const context = readFileSync(get("--context-file"), "utf8");
if (!context.includes("src/runtime/cancellation/abort-coordinator.ts") ||
    !context.includes("baro-sidecar-deep-evidence")) {
  process.exit(9);
}
writeFileSync(get("--outcome-file"), JSON.stringify({
  schemaVersion: 1,
  sessionId: get("--conversation-session-id"),
  goalRequestId: get("--goal-request-id"),
  architectRequestId: get("--architect-request-id"),
  outcome: {
    schemaVersion: 1,
    kind: "needsInput",
    message: "Choose the public API.",
    questions: [{id: "q1", text: "Which API?"}],
    evidence: [{path: "src/runtime/cancellation/abort-coordinator.ts", line: 1, fact: "Two APIs exist."}],
    decisionDocument: null
  }
}));
"#,
        );
        let events = Mutex::new(Vec::new());

        let outcome = run_fake_with_context(entry, &events, &context).await.unwrap();

        assert_eq!(outcome.outcome.kind, ArchitectOutcomeKindV1::NeedsInput);
    }

    #[tokio::test]
    async fn outcome_subprocess_fails_closed_on_empty_and_malformed_files() {
        let events = Mutex::new(Vec::new());
        let (_empty_directory, empty_entry) = fake_node_script("// leave outcome file empty");
        let empty = run_fake(empty_entry, &events).await.unwrap_err();
        assert!(empty.message.contains("empty outcome"), "{}", empty.message);

        let (_bad_directory, bad_entry) = fake_node_script(
            r#"
const args = process.argv.slice(2);
const output = args[args.indexOf("--outcome-file") + 1];
(await import("node:fs")).writeFileSync(output, "not-json");
"#,
        );
        let malformed = run_fake(bad_entry, &events).await.unwrap_err();
        assert!(
            malformed.message.contains("invalid architect outcome"),
            "{}",
            malformed.message
        );
    }
}
