//! Host-side boundary around the Planner subprocess.
//!
//! This module owns the immutable invocation data, PRD decoding, and the
//! optional progressive stdout-to-orchestrator command bridge. The TUI event
//! loop remains responsible only for applying the resulting outcome to `App`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;

use crate::app::{LlmProvider, ReviewStory};
use crate::planner_runner::{self, ProgressivePlannerInvocation};
use crate::planner_stream_bridge;

#[derive(Clone)]
pub(crate) struct PlannerRunSpec {
    pub goal: String,
    pub cwd: PathBuf,
    pub planner_llm: LlmProvider,
    pub model: Option<String>,
    pub context: Option<String>,
    pub decision_doc: Option<String>,
    pub quick: bool,
    pub openai_api_key: Option<String>,
    pub openai_base_url: Option<String>,
    pub effort: String,
    pub mode_json: Option<String>,
}

pub(crate) struct ProgressivePlannerRuntime {
    invocation: ProgressivePlannerInvocation,
    orchestrator_stdin: mpsc::Sender<String>,
}

impl ProgressivePlannerRuntime {
    pub(crate) fn new(
        run_id: String,
        planning_id: String,
        bootstrap_json: String,
        orchestrator_stdin: mpsc::Sender<String>,
    ) -> Self {
        Self {
            invocation: ProgressivePlannerInvocation {
                run_id,
                planning_id,
                bootstrap_json,
            },
            orchestrator_stdin,
        }
    }
}

pub(crate) enum PlannerOutcome {
    Ready {
        stories: Vec<ReviewStory>,
        project: String,
        branch: String,
        description: String,
        execution_mode: Option<Value>,
        progressive: bool,
    },
    Failed {
        message: String,
        log_path: Option<PathBuf>,
        progressive: bool,
    },
}

#[derive(Clone, Default)]
struct BridgeFailureRecorder {
    first: Arc<Mutex<Option<String>>>,
}

impl BridgeFailureRecorder {
    fn record(&self, message: String) {
        eprintln!("[baro] progressive planner transport failed: {message}");
        let mut first = self
            .first
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if first.is_none() {
            *first = Some(message);
        }
    }

    fn first(&self) -> Option<String> {
        self.first
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

/// Run the Planner and normalize both legacy and progressive completion into
/// one UI-independent outcome. Progressive protocol records are copied to the
/// private orchestrator command lane before the ordinary event sink sees them.
pub(crate) async fn run_planner(
    spec: PlannerRunSpec,
    progressive: Option<ProgressivePlannerRuntime>,
    on_event: impl Fn(&str),
) -> PlannerOutcome {
    let bridge_failures = BridgeFailureRecorder::default();
    let progressive_invocation = progressive
        .as_ref()
        .map(|runtime| runtime.invocation.clone());
    let command_tx = progressive
        .as_ref()
        .map(|runtime| runtime.orchestrator_stdin.clone());
    let event_failures = bridge_failures.clone();
    let event_sink = move |raw: &str| {
        if let Some(command_tx) = command_tx.as_ref() {
            forward_progressive_event(raw, command_tx, &event_failures);
        }
        on_event(raw);
    };

    let result = planner_runner::run_planner(
        &spec.goal,
        &spec.cwd,
        spec.planner_llm,
        spec.model.as_deref(),
        spec.context.as_deref(),
        spec.decision_doc.as_deref(),
        spec.quick,
        spec.openai_api_key.as_deref(),
        spec.openai_base_url.as_deref(),
        &spec.effort,
        spec.mode_json.as_deref(),
        progressive_invocation.as_ref(),
        event_sink,
    )
    .await;

    match result.and_then(parse_planner_prd) {
        Ok(parsed) => finish_planner_success(parsed, progressive.as_ref(), &bridge_failures).await,
        Err(error) => finish_planner_failure(error, progressive.as_ref(), &bridge_failures).await,
    }
}

fn forward_progressive_event(
    raw: &str,
    command_tx: &mpsc::Sender<String>,
    failures: &BridgeFailureRecorder,
) {
    match planner_stream_bridge::planner_stdout_line_to_command(raw) {
        Ok(Some(command)) => {
            if let Err(error) =
                try_send_progressive_command(command_tx, command, "planner stream event")
            {
                failures.record(error);
            }
        }
        Ok(None) => {}
        Err(error) => failures.record(format!("planner stream bridge rejected event: {error}")),
    }
}

fn try_send_progressive_command(
    command_tx: &mpsc::Sender<String>,
    command: String,
    context: &str,
) -> Result<(), String> {
    command_tx.try_send(command).map_err(|error| match error {
        TrySendError::Full(_) => {
            format!("private orchestrator command lane is full while forwarding {context}")
        }
        TrySendError::Closed(_) => {
            format!("private orchestrator command lane closed while forwarding {context}")
        }
    })
}

async fn send_terminal_command(
    command_tx: &mpsc::Sender<String>,
    command: String,
    context: &str,
) -> Result<(), String> {
    command_tx
        .send(command)
        .await
        .map_err(|_| format!("private orchestrator command lane closed while forwarding {context}"))
}

async fn finish_planner_success(
    parsed: ParsedPlannerPrd,
    progressive: Option<&ProgressivePlannerRuntime>,
    bridge_failures: &BridgeFailureRecorder,
) -> PlannerOutcome {
    let (stories, project, branch, description, execution_mode, raw_json) = parsed;
    if let Some(bridge_failure) = bridge_failures.first() {
        let mut message = format!("progressive planner stream was not delivered: {bridge_failure}");
        if let Some(runtime) = progressive {
            if let Err(terminal_failure) =
                send_correlated_failure(runtime, "planner_stream_transport_failed", &message).await
            {
                eprintln!("[baro] progressive planner transport failed: {terminal_failure}");
                message.push_str(&format!("; {terminal_failure}"));
            }
        }
        return PlannerOutcome::Failed {
            message,
            log_path: None,
            progressive: progressive.is_some(),
        };
    }

    if let Some(runtime) = progressive {
        let final_prd = match serde_json::from_str::<Value>(&raw_json) {
            Ok(final_prd) => final_prd,
            Err(error) => {
                let mut message = format!("could not encode progressive plan_complete: {error}");
                if let Err(terminal_failure) =
                    send_correlated_failure(runtime, "plan_complete_encoding_failed", &message)
                        .await
                {
                    eprintln!("[baro] progressive planner transport failed: {terminal_failure}");
                    message.push_str(&format!("; {terminal_failure}"));
                }
                return PlannerOutcome::Failed {
                    message,
                    log_path: None,
                    progressive: true,
                };
            }
        };
        let command = serde_json::json!({
            "type": "plan_complete",
            "run_id": runtime.invocation.run_id,
            "planning_id": runtime.invocation.planning_id,
            "final_prd": final_prd,
        })
        .to_string();
        if let Err(message) =
            send_terminal_command(&runtime.orchestrator_stdin, command, "plan_complete").await
        {
            eprintln!("[baro] progressive planner transport failed: {message}");
            return PlannerOutcome::Failed {
                message,
                log_path: None,
                progressive: true,
            };
        }
    }

    PlannerOutcome::Ready {
        stories,
        project,
        branch,
        description,
        execution_mode,
        progressive: progressive.is_some(),
    }
}

async fn finish_planner_failure(
    error: crate::subprocess::ProcessRunError,
    progressive: Option<&ProgressivePlannerRuntime>,
    bridge_failures: &BridgeFailureRecorder,
) -> PlannerOutcome {
    let mut message = error.message;
    if let Some(bridge_failure) = bridge_failures.first() {
        message.push_str(&format!(
            "; progressive planner stream was not delivered: {bridge_failure}"
        ));
    }
    if let Some(runtime) = progressive {
        if let Err(terminal_failure) =
            send_correlated_failure(runtime, "planner_process_failed", &message).await
        {
            eprintln!("[baro] progressive planner transport failed: {terminal_failure}");
            message.push_str(&format!("; {terminal_failure}"));
        }
    }
    PlannerOutcome::Failed {
        message,
        log_path: error.log_path,
        progressive: progressive.is_some(),
    }
}

async fn send_correlated_failure(
    runtime: &ProgressivePlannerRuntime,
    code: &str,
    reason: &str,
) -> Result<(), String> {
    let command = serde_json::json!({
        "type": "plan_failed",
        "run_id": runtime.invocation.run_id,
        "planning_id": runtime.invocation.planning_id,
        "code": code,
        "reason": reason,
    })
    .to_string();
    send_terminal_command(&runtime.orchestrator_stdin, command, "plan_failed").await
}

/// Pull the human-readable line out of a planner/architect BaroEvent JSON.
pub(crate) fn line_from_event(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    match value.get("type").and_then(Value::as_str)? {
        "story_log" => value
            .get("line")
            .and_then(Value::as_str)
            .map(str::to_string),
        "activity" => value
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

type ParsedPlannerPrd = (
    Vec<ReviewStory>,
    String,
    String,
    String,
    Option<Value>,
    String,
);

fn parse_planner_prd(
    raw_json: String,
) -> Result<ParsedPlannerPrd, crate::subprocess::ProcessRunError> {
    let prd: PrdOutput =
        serde_json::from_str(&raw_json).map_err(|error| crate::subprocess::ProcessRunError {
            message: format!(
                "Failed to parse PRD JSON from planner: {}\nRaw (first 500 chars): {}",
                error,
                &raw_json[..raw_json.len().min(500)],
            ),
            log_path: None,
        })?;
    Ok((
        prd.user_stories
            .into_iter()
            .map(ReviewStory::from)
            .collect(),
        prd.project,
        prd.branch_name,
        prd.description,
        prd.execution_mode,
        raw_json,
    ))
}

#[derive(Deserialize)]
pub(crate) struct PrdOutput {
    pub(crate) project: String,
    #[serde(default, rename = "branchName")]
    pub(crate) branch_name: String,
    #[serde(default)]
    pub(crate) description: String,
    #[serde(rename = "userStories")]
    pub(crate) user_stories: Vec<PrdStoryOutput>,
    #[serde(default, rename = "executionMode")]
    pub(crate) execution_mode: Option<Value>,
}

#[derive(Deserialize)]
pub(crate) struct PrdStoryOutput {
    id: String,
    #[serde(default)]
    priority: i32,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default, rename = "dependsOn")]
    depends_on: Vec<String>,
    #[serde(default = "default_story_retries")]
    retries: u32,
    #[serde(default)]
    acceptance: Vec<String>,
    #[serde(default)]
    tests: Vec<String>,
    #[serde(default, rename = "goalInvariantIds")]
    goal_invariant_ids: Vec<String>,
    #[serde(default)]
    model: Option<String>,
}

fn default_story_retries() -> u32 {
    2
}

impl From<PrdStoryOutput> for ReviewStory {
    fn from(story: PrdStoryOutput) -> Self {
        Self {
            id: story.id,
            priority: story.priority,
            title: story.title,
            description: story.description,
            depends_on: story.depends_on,
            retries: story.retries,
            acceptance: story.acceptance,
            tests: story.tests,
            goal_invariant_ids: story.goal_invariant_ids,
            completed: false,
            model: story.model,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{
        finish_planner_success, forward_progressive_event, BridgeFailureRecorder, ParsedPlannerPrd,
        PlannerOutcome, PrdStoryOutput, ProgressivePlannerRuntime,
    };
    use crate::app::ReviewStory;
    use tokio::time::timeout;

    const FRAGMENT: &str = r#"{"type":"plan_fragment","run_id":"run-1","planning_id":"planning-1","fragment_id":"fragment-1","ordinal":1,"stories":[{"id":"S1"}]}"#;

    fn successful_plan() -> ParsedPlannerPrd {
        (
            Vec::new(),
            "baro".to_string(),
            "baro/progressive".to_string(),
            "Progressive plan".to_string(),
            None,
            "{}".to_string(),
        )
    }

    #[test]
    fn planner_story_metadata_reaches_review_story() {
        let output: PrdStoryOutput = serde_json::from_str(
            r#"{"id":"S4","priority":17,"title":"Keep metadata","description":"Round trip","dependsOn":["S1"],"retries":4,"acceptance":["criterion"],"tests":["cargo test"],"model":"heavy"}"#,
        )
        .unwrap();

        let story = ReviewStory::from(output);
        assert_eq!(story.priority, 17);
        assert_eq!(story.depends_on, ["S1"]);
        assert_eq!(story.retries, 4);
        assert_eq!(story.acceptance, ["criterion"]);
        assert_eq!(story.tests, ["cargo test"]);
        assert_eq!(story.model.as_deref(), Some("heavy"));
    }

    #[tokio::test]
    async fn full_fragment_lane_is_recorded_and_success_fails_closed() {
        let (command_tx, mut command_rx) = tokio::sync::mpsc::channel(1);
        command_tx.try_send("occupied".to_string()).unwrap();
        let failures = BridgeFailureRecorder::default();

        forward_progressive_event(FRAGMENT, &command_tx, &failures);
        assert!(failures.first().unwrap().contains("lane is full"));

        let runtime = ProgressivePlannerRuntime::new(
            "run-1".to_string(),
            "planning-1".to_string(),
            "{}".to_string(),
            command_tx,
        );
        let consumer = tokio::spawn(async move {
            assert_eq!(command_rx.recv().await.as_deref(), Some("occupied"));
            command_rx.recv().await.expect("plan_failed must follow")
        });
        let outcome = timeout(
            Duration::from_secs(1),
            finish_planner_success(successful_plan(), Some(&runtime), &failures),
        )
        .await
        .expect("terminal failure send must unblock after the consumer drains");
        match outcome {
            PlannerOutcome::Failed {
                message,
                progressive,
                ..
            } => {
                assert!(progressive);
                assert!(message.contains("stream was not delivered"));
            }
            PlannerOutcome::Ready { .. } => panic!("fragment loss must fail closed"),
        }
        let terminal: serde_json::Value = serde_json::from_str(&consumer.await.unwrap()).unwrap();
        assert_eq!(terminal["type"], "plan_failed");
        assert_eq!(terminal["code"], "planner_stream_transport_failed");
    }

    #[tokio::test]
    async fn full_terminal_lane_backpressures_without_losing_plan_complete() {
        let (command_tx, mut command_rx) = tokio::sync::mpsc::channel(1);
        command_tx.try_send("occupied".to_string()).unwrap();
        let runtime = ProgressivePlannerRuntime::new(
            "run-1".to_string(),
            "planning-1".to_string(),
            "{}".to_string(),
            command_tx,
        );
        let consumer = tokio::spawn(async move {
            assert_eq!(command_rx.recv().await.as_deref(), Some("occupied"));
            command_rx.recv().await.expect("plan_complete must follow")
        });
        let outcome = timeout(
            Duration::from_secs(1),
            finish_planner_success(
                successful_plan(),
                Some(&runtime),
                &BridgeFailureRecorder::default(),
            ),
        )
        .await
        .expect("terminal completion send must unblock after the consumer drains");
        match outcome {
            PlannerOutcome::Ready { progressive, .. } => {
                assert!(progressive);
            }
            PlannerOutcome::Failed { message, .. } => {
                panic!("backpressured terminal send must succeed: {message}")
            }
        }
        let terminal: serde_json::Value = serde_json::from_str(&consumer.await.unwrap()).unwrap();
        assert_eq!(terminal["type"], "plan_complete");
    }

    #[tokio::test]
    async fn closed_fragment_lane_is_recorded_and_success_fails_closed() {
        let (command_tx, command_rx) = tokio::sync::mpsc::channel(1);
        drop(command_rx);
        let failures = BridgeFailureRecorder::default();

        forward_progressive_event(FRAGMENT, &command_tx, &failures);
        assert!(failures.first().unwrap().contains("lane closed"));

        let runtime = ProgressivePlannerRuntime::new(
            "run-1".to_string(),
            "planning-1".to_string(),
            "{}".to_string(),
            command_tx,
        );
        let outcome = finish_planner_success(successful_plan(), Some(&runtime), &failures).await;
        match outcome {
            PlannerOutcome::Failed {
                message,
                progressive,
                ..
            } => {
                assert!(progressive);
                assert!(message.contains("stream was not delivered"));
                assert!(message.contains("plan_failed"));
                assert!(message.contains("lane closed"));
            }
            PlannerOutcome::Ready { .. } => panic!("closed command lane must fail closed"),
        }
    }
}
