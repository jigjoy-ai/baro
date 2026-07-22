//! Private bridge for progressive planning.
//!
//! The planner already writes newline-delimited events before it exits, and
//! the orchestrator already accepts newline-delimited JSON commands on stdin.
//! This module owns recognition and typed conversion at that boundary;
//! `planner_host` supplies the live process wiring.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::mpsc;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum ProgressivePlannerEvent {
    #[serde(rename = "planning_open")]
    PlanningOpen {
        #[serde(alias = "runId")]
        run_id: String,
        #[serde(alias = "planningId")]
        planning_id: String,
    },
    #[serde(rename = "plan_fragment")]
    PlanFragment {
        #[serde(alias = "runId")]
        run_id: String,
        #[serde(alias = "planningId")]
        planning_id: String,
        #[serde(alias = "fragmentId")]
        fragment_id: String,
        ordinal: u64,
        stories: Vec<Value>,
    },
    #[serde(rename = "plan_complete")]
    PlanComplete {
        #[serde(alias = "runId")]
        run_id: String,
        #[serde(alias = "planningId")]
        planning_id: String,
        #[serde(alias = "finalPrd")]
        final_prd: Value,
    },
    #[serde(rename = "plan_failed")]
    PlanFailed {
        #[serde(alias = "runId")]
        run_id: String,
        #[serde(alias = "planningId")]
        planning_id: String,
        code: String,
        reason: String,
    },
}

#[derive(Debug)]
pub(crate) enum PlannerStreamBridgeError {
    InvalidEvent(String),
    Io(std::io::Error),
    CommandLaneClosed,
}

impl fmt::Display for PlannerStreamBridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidEvent(reason) => {
                write!(formatter, "invalid progressive planner event: {reason}")
            }
            Self::Io(error) => write!(formatter, "planner stdout read failed: {error}"),
            Self::CommandLaneClosed => {
                write!(formatter, "private orchestrator command lane closed")
            }
        }
    }
}

impl std::error::Error for PlannerStreamBridgeError {}

impl From<std::io::Error> for PlannerStreamBridgeError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Recognize only progressive-planning records. Existing planner progress
/// events (for example `story_log`) return `Ok(None)` and remain available to
/// the normal UI event sink.
#[allow(dead_code)]
pub(crate) fn parse_progressive_planner_event(
    line: &str,
) -> Result<Option<ProgressivePlannerEvent>, PlannerStreamBridgeError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let value: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        // Planner stdout historically permits non-protocol diagnostic lines.
        Err(_) => return Ok(None),
    };
    let Some(event_type) = value.get("type").and_then(Value::as_str) else {
        return Ok(None);
    };
    if !matches!(
        event_type,
        "planning_open" | "plan_fragment" | "plan_complete" | "plan_failed"
    ) {
        return Ok(None);
    }

    let event: ProgressivePlannerEvent = serde_json::from_value(value)
        .map_err(|error| PlannerStreamBridgeError::InvalidEvent(error.to_string()))?;
    validate(&event)?;
    Ok(Some(event))
}

/// Convert one recognized stdout record into the private command accepted by
/// the orchestrator-side bridge. The returned string has no trailing
/// newline, matching `orchestrator_client`'s existing stdin sender contract.
#[allow(dead_code)]
pub(crate) fn planner_stdout_line_to_command(
    line: &str,
) -> Result<Option<String>, PlannerStreamBridgeError> {
    let Some(event) = parse_progressive_planner_event(line)? else {
        return Ok(None);
    };
    // These records are the private stdin commands themselves. The typed
    // round trip strips unrelated stdout fields without changing correlation.
    serde_json::to_string(&event)
        .map(Some)
        .map_err(|error| PlannerStreamBridgeError::InvalidEvent(error.to_string()))
}

/// Testable streaming seam for a direct `ChildStdout`. Production currently
/// calls `planner_stdout_line_to_command` inside the existing event callback
/// and `try_send`s the result without waiting for planner EOF.
#[allow(dead_code)]
pub(crate) async fn relay_progressive_planner_stdout<R>(
    reader: R,
    command_tx: mpsc::Sender<String>,
) -> Result<usize, PlannerStreamBridgeError>
where
    R: AsyncRead + Unpin,
{
    let mut relayed = 0;
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await? {
        let Some(command) = planner_stdout_line_to_command(&line)? else {
            continue;
        };
        command_tx
            .send(command)
            .await
            .map_err(|_| PlannerStreamBridgeError::CommandLaneClosed)?;
        relayed += 1;
    }
    Ok(relayed)
}

fn validate(event: &ProgressivePlannerEvent) -> Result<(), PlannerStreamBridgeError> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

    let invalid = |reason: &str| Err(PlannerStreamBridgeError::InvalidEvent(reason.to_string()));
    let (run_id, planning_id) = match event {
        ProgressivePlannerEvent::PlanningOpen {
            run_id,
            planning_id,
        } => (run_id, planning_id),
        ProgressivePlannerEvent::PlanFragment {
            run_id,
            planning_id,
            fragment_id,
            ordinal,
            stories,
        } => {
            if fragment_id.trim().is_empty() {
                return invalid("fragment_id must be non-empty");
            }
            if *ordinal == 0 || *ordinal > MAX_SAFE_INTEGER {
                return invalid("ordinal must be a positive safe integer");
            }
            if stories.is_empty() || stories.iter().any(|story| !story.is_object()) {
                return invalid("stories must contain at least one JSON object");
            }
            (run_id, planning_id)
        }
        ProgressivePlannerEvent::PlanComplete {
            run_id,
            planning_id,
            final_prd: _,
        } => (run_id, planning_id),
        ProgressivePlannerEvent::PlanFailed {
            run_id,
            planning_id,
            code,
            reason,
            ..
        } => {
            if code.trim().is_empty() || reason.trim().is_empty() {
                return invalid("planning failure requires non-empty code and reason");
            }
            (run_id, planning_id)
        }
    };
    if run_id.trim().is_empty() || planning_id.trim().is_empty() {
        return invalid("run_id and planning_id must be non-empty");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use tokio::io::AsyncWriteExt;
    use tokio::time::timeout;

    use super::{
        parse_progressive_planner_event, planner_stdout_line_to_command,
        relay_progressive_planner_stdout, ProgressivePlannerEvent,
    };

    const FRAGMENT: &str = r#"{"type":"plan_fragment","run_id":"run-1","planning_id":"planning-1","fragment_id":"fragment-1","ordinal":1,"stories":[{"id":"S1","priority":1,"title":"First","description":"Implement it","dependsOn":[],"acceptance":["works"],"tests":["cargo test"]}]}"#;

    #[test]
    fn recognizes_fragment_and_builds_private_command() {
        let event = parse_progressive_planner_event(FRAGMENT)
            .expect("valid record")
            .expect("recognized fragment");
        assert!(matches!(
            event,
            ProgressivePlannerEvent::PlanFragment { ordinal: 1, .. }
        ));

        let command = planner_stdout_line_to_command(FRAGMENT)
            .expect("conversion succeeds")
            .expect("command produced");
        let value: serde_json::Value = serde_json::from_str(&command).unwrap();
        assert_eq!(value["type"], "plan_fragment");
        assert_eq!(value["fragment_id"], "fragment-1");
        assert!(!command.ends_with('\n'));
    }

    #[test]
    fn ignores_existing_planner_ui_events_but_rejects_malformed_fragments() {
        assert!(parse_progressive_planner_event(
            r#"{"type":"story_log","id":"plan","line":"reading src/main.rs"}"#
        )
        .unwrap()
        .is_none());
        assert!(
            parse_progressive_planner_event(r#"{"type":"plan_fragment","run_id":"run-1"}"#)
                .is_err()
        );
    }

    #[test]
    fn ignores_bounded_plan_complete_summary_announcements() {
        // The planner announces completion on stdout only as a bounded
        // summary; the full PRD reaches the host through the result file.
        let summary = r#"{"type":"plan_complete_summary","run_id":"run-1","planning_id":"planning-1","stories":8,"final_prd_chars":90000,"final_prd_sha256":"abc"}"#;
        assert!(parse_progressive_planner_event(summary).unwrap().is_none());
        assert!(planner_stdout_line_to_command(summary).unwrap().is_none());
    }

    #[tokio::test]
    async fn relays_a_plan_complete_larger_than_the_64kib_pipe_capacity() {
        let final_prd = serde_json::json!({
            "project": "target",
            "description": "d".repeat(80 * 1024),
            "userStories": [{"id": "S1"}],
        });
        let line = serde_json::json!({
            "type": "plan_complete",
            "run_id": "run-1",
            "planning_id": "planning-1",
            "final_prd": final_prd,
        })
        .to_string();
        assert!(line.len() > 64 * 1024);

        let (mut planner_stdout, rust_reader) = tokio::io::duplex(8 * 1024);
        let (command_tx, mut command_rx) = tokio::sync::mpsc::channel(4);
        let relay = tokio::spawn(relay_progressive_planner_stdout(rust_reader, command_tx));

        let writer = tokio::spawn(async move {
            planner_stdout.write_all(line.as_bytes()).await.unwrap();
            planner_stdout.write_all(b"\n").await.unwrap();
            planner_stdout.flush().await.unwrap();
            drop(planner_stdout);
        });

        let command = timeout(Duration::from_secs(5), command_rx.recv())
            .await
            .expect("oversized record must still arrive")
            .expect("command lane remains open");
        let value: serde_json::Value = serde_json::from_str(&command)
            .expect("relayed oversized record must be complete valid JSON");
        assert_eq!(value["type"], "plan_complete");
        assert_eq!(
            value["final_prd"]["description"].as_str().unwrap().len(),
            80 * 1024,
        );
        writer.await.unwrap();
        assert_eq!(relay.await.unwrap().unwrap(), 1);
    }

    #[test]
    fn rejects_zero_fragment_ordinal() {
        let zero = FRAGMENT.replace(r#""ordinal":1"#, r#""ordinal":0"#);
        let error = parse_progressive_planner_event(&zero).unwrap_err();
        assert!(error.to_string().contains("positive safe integer"));
    }

    #[tokio::test]
    async fn relays_fragment_before_planner_stream_closes() {
        let (mut planner_stdout, rust_reader) = tokio::io::duplex(8 * 1024);
        let (command_tx, mut command_rx) = tokio::sync::mpsc::channel(4);
        let relay = tokio::spawn(relay_progressive_planner_stdout(rust_reader, command_tx));

        planner_stdout.write_all(FRAGMENT.as_bytes()).await.unwrap();
        planner_stdout.write_all(b"\n").await.unwrap();
        planner_stdout.flush().await.unwrap();

        let command = timeout(Duration::from_secs(1), command_rx.recv())
            .await
            .expect("fragment must arrive without waiting for EOF")
            .expect("command lane remains open");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&command).unwrap(),
            json!({
                "type": "plan_fragment",
                "run_id": "run-1",
                "planning_id": "planning-1",
                "fragment_id": "fragment-1",
                "ordinal": 1,
                "stories": [{
                    "id": "S1",
                    "priority": 1,
                    "title": "First",
                    "description": "Implement it",
                    "dependsOn": [],
                    "acceptance": ["works"],
                    "tests": ["cargo test"]
                }]
            })
        );
        assert!(
            !relay.is_finished(),
            "the reader must still be waiting for planner exit/EOF"
        );

        drop(planner_stdout);
        assert_eq!(relay.await.unwrap().unwrap(), 1);
    }
}
