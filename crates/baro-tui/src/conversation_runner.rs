//! Isolated provider bridge for one durable conversation turn.
//!
//! Rust owns the session and lifecycle. The TypeScript child owns bounded
//! bounded RepoScout research calls followed by one text-only Conversation call and
//! exits, so planning/run Mozaik state can never leak across follow-ups.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use crate::app::LlmProvider;
use crate::conversation::{
    ConversationError, ConversationSession, ConversationWireResponse, TranscriptRole,
};
use crate::discovery::{self, ScriptEntry};
use crate::subprocess::{self, ProcessRunError};

const SCRIPT_REL_PATH: &str = "packages/baro-orchestrator/scripts/run-conversation.ts";
const BUNDLE_NAME: &str = "run-conversation.mjs";
const HISTORY_LIMIT: usize = 24;
const OUTER_TIMEOUT_SHUTDOWN_GRACE_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationIntent {
    Goal,
    Clarification,
    Chat,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnInput<'a> {
    schema_version: u8,
    session_id: &'a str,
    request_id: &'a str,
    intent: ConversationIntent,
    text: &'a str,
    history: Vec<HistoryEntry<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry<'a> {
    request_id: &'a str,
    role: &'static str,
    text: &'a str,
}

pub struct ConversationRunOptions<'a> {
    pub cwd: &'a Path,
    pub llm: LlmProvider,
    pub model: Option<&'a str>,
    /// Hard deadline for the complete RepoScout + Conversation turn.
    pub timeout_ms: u64,
    /// Deadline for one provider invocation inside that turn.
    pub provider_timeout_ms: u64,
    pub openai_api_key: Option<&'a str>,
    pub openai_base_url: Option<&'a str>,
}

/// Run the exact pending request in a fresh provider subprocess.
pub async fn run_conversation_turn(
    session: &ConversationSession,
    intent: ConversationIntent,
    options: ConversationRunOptions<'_>,
) -> Result<ConversationWireResponse, ProcessRunError> {
    let request_id = session
        .pending_request_id()
        .ok_or_else(|| ProcessRunError {
            message: "conversation has no pending request".to_string(),
            log_path: None,
        })?;
    let text = pending_user_text(session, request_id).ok_or_else(|| ProcessRunError {
        message: "conversation pending request has no user turn".to_string(),
        log_path: None,
    })?;
    let llm = conversation_backend(options.llm);
    let entry =
        discovery::locate_script(options.cwd, SCRIPT_REL_PATH, BUNDLE_NAME).map_err(|message| {
            ProcessRunError {
                message,
                log_path: None,
            }
        })?;

    let input = TurnInput {
        schema_version: 1,
        session_id: session.session_id(),
        request_id,
        intent,
        text,
        history: completed_history(session),
    };
    let mut input_file = tempfile::NamedTempFile::new().map_err(|error| ProcessRunError {
        message: format!("could not create conversation input: {error}"),
        log_path: None,
    })?;
    serde_json::to_writer(&mut input_file, &input).map_err(|error| ProcessRunError {
        message: format!("could not serialize conversation input: {error}"),
        log_path: None,
    })?;
    input_file.flush().map_err(|error| ProcessRunError {
        message: format!("could not flush conversation input: {error}"),
        log_path: None,
    })?;
    let result_file = tempfile::NamedTempFile::new().map_err(|error| ProcessRunError {
        message: format!("could not create conversation result: {error}"),
        log_path: None,
    })?;

    let mut command = match entry {
        ScriptEntry::Tsx { tsx, script } => {
            let mut command = Command::new(tsx);
            command.arg(script);
            command
        }
        ScriptEntry::NodeJs(bundle) => {
            let mut command = Command::new("node");
            command.arg(bundle);
            command
        }
    };
    command
        .arg("--input-file")
        .arg(input_file.path())
        .arg("--result-file")
        .arg(result_file.path())
        .arg("--cwd")
        .arg(options.cwd)
        .arg("--llm")
        .arg(llm)
        .arg("--timeout-ms")
        .arg(options.provider_timeout_ms.to_string())
        .arg("--turn-timeout-ms")
        .arg(options.timeout_ms.to_string());
    if let Some(model) = options.model {
        command.arg("--model").arg(model);
    }
    if options.llm == LlmProvider::OpenAI {
        if let Some(key) = options.openai_api_key {
            command.env("OPENAI_API_KEY", key);
        }
        if let Some(base_url) = options.openai_base_url {
            command.env("OPENAI_BASE_URL", base_url);
        }
    }

    let outer_timeout = Duration::from_millis(
        options
            .timeout_ms
            .saturating_add(OUTER_TIMEOUT_SHUTDOWN_GRACE_MS),
    );
    match tokio::time::timeout(
        outer_timeout,
        subprocess::spawn_and_capture_streaming(command, "conversation", |_| {}),
    )
    .await
    {
        Ok(result) => {
            result?;
        }
        Err(_) => {
            return Err(ProcessRunError {
                message: format!(
                    "conversation turn exceeded its {}ms wall-clock deadline",
                    options.timeout_ms
                ),
                log_path: None,
            });
        }
    }
    let raw = std::fs::read_to_string(result_file.path()).map_err(|error| ProcessRunError {
        message: format!("could not read conversation result: {error}"),
        log_path: None,
    })?;
    ConversationWireResponse::from_json(&raw).map_err(conversation_error)
}

fn pending_user_text<'a>(session: &'a ConversationSession, request_id: &str) -> Option<&'a str> {
    session
        .transcript()
        .iter()
        .rev()
        .find(|turn| {
            turn.role == TranscriptRole::User && turn.request_id.as_deref() == Some(request_id)
        })
        .map(|turn| turn.text.as_str())
}

fn completed_history(session: &ConversationSession) -> Vec<HistoryEntry<'_>> {
    let turns = session.transcript();
    let mut pairs: Vec<(HistoryEntry<'_>, HistoryEntry<'_>)> = Vec::new();
    for (index, user) in turns.iter().enumerate() {
        if user.role != TranscriptRole::User {
            continue;
        }
        let Some(request_id) = user.request_id.as_deref() else {
            continue;
        };
        let Some(assistant) = turns[index + 1..].iter().find(|candidate| {
            candidate.role == TranscriptRole::Assistant
                && candidate.request_id.as_deref() == Some(request_id)
        }) else {
            continue;
        };
        pairs.push((
            HistoryEntry {
                request_id,
                role: "user",
                text: &user.text,
            },
            HistoryEntry {
                request_id,
                role: "assistant",
                text: &assistant.text,
            },
        ));
    }
    let keep_pairs = HISTORY_LIMIT / 2;
    let start = pairs.len().saturating_sub(keep_pairs);
    pairs
        .into_iter()
        .skip(start)
        .flat_map(|(user, assistant)| [user, assistant])
        .collect()
}

fn conversation_error(error: ConversationError) -> ProcessRunError {
    ProcessRunError {
        message: error.to_string(),
        log_path: None,
    }
}

fn conversation_backend(provider: LlmProvider) -> &'static str {
    match provider {
        LlmProvider::Claude => "claude",
        LlmProvider::OpenAI => "openai",
        LlmProvider::Codex => "codex",
        LlmProvider::OpenCode => "opencode",
        LlmProvider::Pi => "pi",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation::{
        ApplyOutcome, ConversationKind, ConversationWireResponse, GoalEnvelope,
    };

    fn ready(session_id: &str, request_id: &str) -> ConversationWireResponse {
        ConversationWireResponse {
            schema_version: 1,
            session_id: session_id.to_string(),
            request_id: request_id.to_string(),
            kind: ConversationKind::Ready,
            message: "Clear; sending this to planning.".to_string(),
            questions: vec![],
            goal_envelope: Some(GoalEnvelope {
                objective: "Implement the requested change".to_string(),
                constraints: vec![],
                acceptance_criteria: vec!["Focused tests pass".to_string()],
                non_goals: vec![],
                assumptions: vec![],
            }),
        }
    }

    #[test]
    fn history_contains_only_complete_correlated_pairs() {
        let mut session = ConversationSession::new("session-1").unwrap();
        session.begin_request("request-1", "first").unwrap();
        assert_eq!(
            session.apply_response(ready("session-1", "request-1")),
            Ok(ApplyOutcome::Accepted(ConversationKind::Ready))
        );
        session.take_ready_handoff().unwrap();
        session
            .transition_to(crate::conversation::ConversationPhase::Planning)
            .unwrap();
        session
            .transition_to(crate::conversation::ConversationPhase::Executing)
            .unwrap();
        session
            .transition_to(crate::conversation::ConversationPhase::Verifying)
            .unwrap();
        session
            .transition_to(crate::conversation::ConversationPhase::Completed)
            .unwrap();
        session.record_system_turn("run finished").unwrap();
        session.begin_request("request-2", "what changed?").unwrap();

        let history = completed_history(&session);
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].request_id, "request-1");
        assert_eq!(history[0].role, "user");
        assert_eq!(history[1].role, "assistant");
    }

    #[test]
    fn turn_input_matches_the_exact_ts_contract_and_excludes_the_pending_turn_from_history() {
        let mut session = ConversationSession::new("session-1").unwrap();
        complete_ready_cycle(&mut session, "request-1", "first goal");
        session
            .begin_request("request-2", "follow-up clarification")
            .unwrap();

        let input = TurnInput {
            schema_version: 1,
            session_id: session.session_id(),
            request_id: session.pending_request_id().unwrap(),
            intent: ConversationIntent::Clarification,
            text: pending_user_text(&session, "request-2").unwrap(),
            history: completed_history(&session),
        };
        let value = serde_json::to_value(input).unwrap();

        assert_eq!(
            value
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec![
                "history",
                "intent",
                "requestId",
                "schemaVersion",
                "sessionId",
                "text",
            ]
        );
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["sessionId"], "session-1");
        assert_eq!(value["requestId"], "request-2");
        assert_eq!(value["intent"], "clarification");
        assert_eq!(value["text"], "follow-up clarification");
        assert_eq!(value["history"].as_array().unwrap().len(), 2);
        assert_eq!(value["history"][0]["requestId"], "request-1");
        assert_eq!(value["history"][0]["role"], "user");
        assert_eq!(value["history"][1]["requestId"], "request-1");
        assert_eq!(value["history"][1]["role"], "assistant");
    }

    #[test]
    fn history_projection_keeps_the_latest_twelve_complete_pairs() {
        let mut session = ConversationSession::new("session-history").unwrap();
        for number in 1..=13 {
            let request_id = format!("request-{number}");
            let text = format!("goal {number}");
            complete_ready_cycle(&mut session, &request_id, &text);
        }

        let history = completed_history(&session);
        assert_eq!(history.len(), HISTORY_LIMIT);
        assert_eq!(history.first().unwrap().request_id, "request-2");
        assert_eq!(history.first().unwrap().role, "user");
        assert_eq!(history.last().unwrap().request_id, "request-13");
        assert_eq!(history.last().unwrap().role, "assistant");
    }

    #[test]
    fn every_local_provider_has_a_conversation_front_door_adapter() {
        assert_eq!(conversation_backend(LlmProvider::Claude), "claude");
        assert_eq!(conversation_backend(LlmProvider::OpenAI), "openai");
        assert_eq!(conversation_backend(LlmProvider::Codex), "codex");
        assert_eq!(conversation_backend(LlmProvider::OpenCode), "opencode");
        assert_eq!(conversation_backend(LlmProvider::Pi), "pi");
    }

    fn complete_ready_cycle(session: &mut ConversationSession, request_id: &str, text: &str) {
        session.begin_request(request_id, text).unwrap();
        assert_eq!(
            session.apply_response(ready(session.session_id(), request_id)),
            Ok(ApplyOutcome::Accepted(ConversationKind::Ready))
        );
        session.take_ready_handoff().unwrap().unwrap();
        session
            .transition_to(crate::conversation::ConversationPhase::Planning)
            .unwrap();
        session
            .transition_to(crate::conversation::ConversationPhase::Executing)
            .unwrap();
        session
            .transition_to(crate::conversation::ConversationPhase::Verifying)
            .unwrap();
        session
            .transition_to(crate::conversation::ConversationPhase::Completed)
            .unwrap();
    }
}
