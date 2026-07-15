//! Repository-aware validation for the durable conversation front door.
//!
//! Conversation owns user intent and the pending response slot. Architect may
//! inspect the selected checkout before that slot is accepted, but it can only
//! validate the candidate or turn it into a correlated clarification.

use std::path::Path;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::app::{App, LlmProvider};
use crate::conversation::{
    self, ClarificationQuestion, ConversationKind, ConversationWireResponse,
};
use crate::{
    architect_runner, fixed_mode_contract, plan_event_sink, plan_progress_sink, preaccept_context,
    subprocess, AppEvent,
};

const MAX_PREACCEPT_GOAL_BYTES: usize = 8 * 1024;
const DEFAULT_CONVERSATION_TURN_TIMEOUT_SECS: u64 = 30 * 60;
const MIN_CONVERSATION_TURN_TIMEOUT_SECS: u64 = 60;
const MAX_CONVERSATION_TURN_TIMEOUT_SECS: u64 = 2 * 60 * 60;
const DEFAULT_CONVERSATION_PROVIDER_TIMEOUT_SECS: u64 = 5 * 60;
const MIN_CONVERSATION_PROVIDER_TIMEOUT_SECS: u64 = 15;
const MAX_CONVERSATION_PROVIDER_TIMEOUT_SECS: u64 = 30 * 60;
const CONVERSATION_PROVIDER_CLEANUP_MARGIN_SECS: u64 = 30;

/// Generous wall-clock fail-safe for one front-door turn, including autonomous
/// repository research. This is deliberately not a model turn/tool budget.
pub(crate) fn conversation_turn_timeout_ms() -> u64 {
    bounded_conversation_timeout_secs(
        std::env::var("BARO_CONVERSATION_TURN_TIMEOUT_SECS")
            .ok()
            .as_deref(),
    ) * 1_000
}

/// Per-provider deadline. A RepoScout provider timeout degrades to the
/// deterministic brief while the larger turn deadline remains authoritative.
pub(crate) fn conversation_provider_timeout_ms(turn_timeout_ms: u64) -> u64 {
    let requested = bounded_timeout_secs(
        std::env::var("BARO_CONVERSATION_PROVIDER_TIMEOUT_SECS")
            .ok()
            .as_deref(),
        MIN_CONVERSATION_PROVIDER_TIMEOUT_SECS,
        MAX_CONVERSATION_PROVIDER_TIMEOUT_SECS,
        DEFAULT_CONVERSATION_PROVIDER_TIMEOUT_SECS,
    );
    effective_provider_timeout_secs(requested, turn_timeout_ms / 1_000) * 1_000
}

fn effective_provider_timeout_secs(requested: u64, turn_timeout: u64) -> u64 {
    let provider_cap = turn_timeout
        .saturating_sub(CONVERSATION_PROVIDER_CLEANUP_MARGIN_SECS)
        .checked_div(2)
        .unwrap_or(0)
        .max(1);
    requested.min(provider_cap)
}

fn bounded_conversation_timeout_secs(value: Option<&str>) -> u64 {
    bounded_timeout_secs(
        value,
        MIN_CONVERSATION_TURN_TIMEOUT_SECS,
        MAX_CONVERSATION_TURN_TIMEOUT_SECS,
        DEFAULT_CONVERSATION_TURN_TIMEOUT_SECS,
    )
}

fn bounded_timeout_secs(value: Option<&str>, minimum: u64, maximum: u64, default: u64) -> u64 {
    value
        .and_then(|candidate| candidate.parse::<u64>().ok())
        .filter(|seconds| (minimum..=maximum).contains(seconds))
        .unwrap_or(default)
}

pub(crate) fn supports_preaccept_architect_outcome(provider: LlmProvider) -> bool {
    matches!(
        provider,
        LlmProvider::Claude
            | LlmProvider::Codex
            | LlmProvider::OpenAI
            | LlmProvider::OpenCode
            | LlmProvider::Pi
    )
}

fn preaccept_architect_timeout() -> Duration {
    const DEFAULT_SECS: u64 = 30 * 60;
    const MIN_SECS: u64 = 60;
    const MAX_SECS: u64 = 2 * 60 * 60;
    let seconds = std::env::var("BARO_PREACCEPT_ARCHITECT_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (MIN_SECS..=MAX_SECS).contains(value))
        .unwrap_or(DEFAULT_SECS);
    Duration::from_secs(seconds)
}

#[derive(Debug, Clone)]
pub(crate) struct PrevalidatedArchitect {
    pub(crate) repository_context: String,
    pub(crate) decision_document: String,
}

pub(crate) fn close_failed_initial_request(
    app: &mut App,
    request_id: &str,
    deterministic_reason: &str,
) -> Result<bool, String> {
    app.conversation
        .fail_pending_initial_request(request_id, deterministic_reason)
        .map_err(|error| format!("could not close failed request {request_id:?}: {error}"))
}

pub(crate) fn apply_or_close_conversation_response(
    app: &mut App,
    response: ConversationWireResponse,
) -> Result<conversation::ApplyOutcome, String> {
    let request_id = response.request_id.clone();
    match app.conversation.apply_response(response) {
        Ok(conversation::ApplyOutcome::Duplicate) => Ok(conversation::ApplyOutcome::Duplicate),
        Ok(outcome @ conversation::ApplyOutcome::Accepted(_)) => {
            app.conversation_busy = false;
            Ok(outcome)
        }
        Err(error) => {
            // The failed response's own correlation is the only slot it may
            // close. Never substitute the session's current pending ID: a
            // late malformed response for request-1 must not cancel request-2.
            let close_result = close_failed_initial_request(
                app,
                &request_id,
                "The conversation backend returned an invalid response; retry the request.",
            );
            if matches!(&close_result, Ok(true)) {
                app.conversation_busy = false;
            }
            let error = match close_result {
                Err(close_error) => format!("{error}; {close_error}"),
                Ok(_) => error.to_string(),
            };
            Err(format!("invalid conversation response: {error}"))
        }
    }
}

/// Convert the repository-aware Architect's `needsInput` disposition into the
/// exact response slot that is still pending for the conversation candidate.
/// Repository evidence is rendered as bounded, user-visible citations, while
/// the Architect remains unable to manufacture a new session or request ID.
pub(crate) fn architect_clarification_response(
    candidate: &ConversationWireResponse,
    outcome: architect_runner::ArchitectOutcomeV1,
) -> Result<ConversationWireResponse, String> {
    if outcome.kind != architect_runner::ArchitectOutcomeKindV1::NeedsInput
        || outcome.decision_document.is_some()
        || outcome.questions.is_empty()
        || outcome.evidence.is_empty()
    {
        return Err("Architect clarification does not satisfy needsInput invariants".to_string());
    }

    let mut message = outcome.message;
    let heading = "\n\nRepository evidence:";
    let mut added_heading = false;
    for evidence in outcome.evidence {
        let location = match evidence.line {
            Some(line) => format!("{}:{line}", evidence.path),
            None => evidence.path,
        };
        let citation = format!("\n- `{location}`: {}", evidence.fact);
        let heading_cost = if added_heading {
            0
        } else {
            heading.encode_utf16().count()
        };
        if message.encode_utf16().count() + heading_cost + citation.encode_utf16().count() > 8_000 {
            break;
        }
        if !added_heading {
            message.push_str(heading);
            added_heading = true;
        }
        message.push_str(&citation);
    }

    let questions = outcome
        .questions
        .into_iter()
        .map(|question| ClarificationQuestion {
            id: question.id,
            text: question.text,
            reason: question.reason,
        })
        .collect::<Vec<_>>();
    Ok(ConversationWireResponse {
        schema_version: candidate.schema_version,
        session_id: candidate.session_id.clone(),
        request_id: candidate.request_id.clone(),
        kind: ConversationKind::Clarify,
        message,
        questions,
        goal_envelope: None,
    })
}

/// Validate a candidate GoalEnvelope against the selected checkout before the
/// durable conversation accepts it. The candidate remains the sole pending
/// response until either the original `ready` result or an Architect-authored
/// clarification is applied by the main event loop.
pub(crate) fn spawn_conversation_architect_validation(
    app: &mut App,
    cwd: &Path,
    tx: mpsc::Sender<AppEvent>,
    candidate: ConversationWireResponse,
    headless: bool,
) -> Result<(), String> {
    if candidate.kind != ConversationKind::Ready {
        return Err("Architect validation requires a ready candidate".to_string());
    }

    // Validate all conversation correlations and GoalEnvelope bounds without
    // consuming the authoritative pending response in `app.conversation`.
    let mut probe = app.conversation.clone();
    match probe.apply_response(candidate.clone()) {
        Ok(conversation::ApplyOutcome::Accepted(ConversationKind::Ready)) => {}
        Ok(conversation::ApplyOutcome::Accepted(kind)) => {
            return Err(format!("Architect validation received {kind:?}"));
        }
        Ok(conversation::ApplyOutcome::Duplicate) => {
            return Err("Architect validation candidate is a replay".to_string());
        }
        Err(error) => return Err(format!("invalid ready candidate: {error}")),
    }
    let handoff = probe
        .take_ready_handoff()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "ready candidate produced no planning handoff".to_string())?;

    let goal = handoff.planning_prompt;
    if goal.len() > MAX_PREACCEPT_GOAL_BYTES {
        return Err(format!(
            "candidate goal is {} bytes; pre-accept limit is {}",
            goal.len(),
            MAX_PREACCEPT_GOAL_BYTES,
        ));
    }
    let session_id = handoff.session_id;
    let goal_request_id = handoff.request_id;
    let request_nonce = app.next_conversation_request_id();
    let architect_request_id = format!(
        "architect-{}",
        request_nonce
            .strip_prefix("request-")
            .unwrap_or(request_nonce.as_str())
    );
    let cwd = cwd.to_path_buf();
    let architect_llm = app.architect_llm;
    let architect_model = app.model_for_phase("architect");
    let fixed_mode_json = fixed_mode_contract(app.quick, &app.mode);
    let openai_api_key = app.openai_api_key.clone();
    let openai_base_url = app.openai_base_url.clone();
    let effort = app.effort.clone();
    let validation_timeout = preaccept_architect_timeout();
    app.conversation_error = None;

    tokio::spawn(async move {
        let _ = tx.send(AppEvent::ArchitectStarted).await;
        let progress = plan_progress_sink(headless, tx.clone());
        progress("validating the candidate goal against repository evidence");

        let failure_request_id = goal_request_id.clone();
        // Keep the timeout outside provider-specific harness behavior. It is
        // a generous wall-clock fail-safe, not an exploration/turn budget.
        // The inner scope drops the subprocess future before publishing the
        // failure; `kill_on_drop` then prevents an orphaned paid process.
        let result = {
            let event_tx = tx.clone();
            let validation = async {
                let repository_context = preaccept_context::build(&cwd).map_err(|error| {
                    subprocess::ProcessRunError {
                        message: format!("repository context discovery failed: {error}"),
                        log_path: None,
                    }
                })?;
                let transport = architect_runner::run_architect_outcome(
                    &goal,
                    &cwd,
                    architect_llm,
                    architect_model.as_deref(),
                    Some(&repository_context),
                    fixed_mode_json.as_deref(),
                    openai_api_key.as_deref(),
                    openai_base_url.as_deref(),
                    &effort,
                    &session_id,
                    &goal_request_id,
                    &architect_request_id,
                    plan_event_sink(headless, event_tx),
                )
                .await?;
                Ok::<_, subprocess::ProcessRunError>((repository_context, transport))
            };
            tokio::pin!(validation);
            let deadline = tokio::time::sleep(validation_timeout);
            tokio::pin!(deadline);

            let mut heartbeat = tokio::time::interval(Duration::from_secs(45));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            heartbeat.tick().await;
            loop {
                tokio::select! {
                    result = &mut validation => break result,
                    _ = heartbeat.tick() => {
                        progress("Architect is still validating repository evidence");
                    }
                    _ = &mut deadline => {
                        break Err(subprocess::ProcessRunError {
                            message: format!(
                                "Architect repository validation exceeded its {}s wall-clock fail-safe",
                                validation_timeout.as_secs(),
                            ),
                            log_path: None,
                        });
                    }
                }
            }
        };

        match result {
            Ok((repository_context, transport)) => {
                let _ = tx
                    .send(AppEvent::ConversationArchitectOutcome {
                        candidate,
                        repository_context,
                        transport,
                    })
                    .await;
            }
            Err(error) => {
                let _ = tx
                    .send(AppEvent::ConversationError {
                        request_id: failure_request_id,
                        error: error.message,
                        log_path: error.log_path,
                    })
                    .await;
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_candidate(session_id: &str) -> ConversationWireResponse {
        ConversationWireResponse {
            schema_version: 1,
            session_id: session_id.to_string(),
            request_id: "request-1".to_string(),
            kind: ConversationKind::Ready,
            message: "The goal is clear.".to_string(),
            questions: vec![],
            goal_envelope: Some(conversation::GoalEnvelope {
                objective: "Implement the repository-aware flow".to_string(),
                constraints: vec![],
                acceptance_criteria: vec!["Focused tests pass".to_string()],
                non_goals: vec![],
                assumptions: vec![],
            }),
        }
    }

    fn needs_input_outcome(message: String) -> architect_runner::ArchitectOutcomeV1 {
        architect_runner::ArchitectOutcomeV1 {
            schema_version: 1,
            kind: architect_runner::ArchitectOutcomeKindV1::NeedsInput,
            message,
            questions: vec![architect_runner::ArchitectClarificationQuestionV1 {
                id: "q1".to_string(),
                text: "Which public API must remain compatible?".to_string(),
                reason: Some("The repository exports two APIs.".to_string()),
            }],
            evidence: vec![architect_runner::ArchitectRepositoryEvidenceV1 {
                path: "src/lib.rs".to_string(),
                line: Some(12),
                fact: "Both APIs are public.".to_string(),
            }],
            decision_document: None,
        }
    }

    #[test]
    fn only_supported_harnesses_run_preaccept_architect_outcomes() {
        assert!(supports_preaccept_architect_outcome(LlmProvider::Claude));
        assert!(supports_preaccept_architect_outcome(LlmProvider::Codex));
        assert!(supports_preaccept_architect_outcome(LlmProvider::OpenAI));
        assert!(supports_preaccept_architect_outcome(LlmProvider::OpenCode));
        assert!(supports_preaccept_architect_outcome(LlmProvider::Pi));
    }

    #[test]
    fn autonomous_conversation_timeout_is_a_bounded_wall_clock_fail_safe() {
        assert_eq!(bounded_conversation_timeout_secs(None), 30 * 60);
        assert_eq!(bounded_conversation_timeout_secs(Some("60")), 60);
        assert_eq!(bounded_conversation_timeout_secs(Some("7200")), 7200);
        assert_eq!(bounded_conversation_timeout_secs(Some("59")), 30 * 60);
        assert_eq!(bounded_conversation_timeout_secs(Some("7201")), 30 * 60);
        assert_eq!(bounded_conversation_timeout_secs(Some("invalid")), 30 * 60);
    }

    #[test]
    fn provider_timeout_is_shorter_and_independently_bounded() {
        assert_eq!(
            bounded_timeout_secs(
                None,
                MIN_CONVERSATION_PROVIDER_TIMEOUT_SECS,
                MAX_CONVERSATION_PROVIDER_TIMEOUT_SECS,
                DEFAULT_CONVERSATION_PROVIDER_TIMEOUT_SECS,
            ),
            5 * 60,
        );
        assert_eq!(bounded_timeout_secs(Some("15"), 15, 30 * 60, 5 * 60), 15,);
        assert_eq!(
            bounded_timeout_secs(Some("1801"), 15, 30 * 60, 5 * 60),
            5 * 60,
        );
        assert_eq!(effective_provider_timeout_secs(5 * 60, 60), 15);
        assert_eq!(effective_provider_timeout_secs(30 * 60, 30 * 60), 885);
        assert_eq!(effective_provider_timeout_secs(5 * 60, 30 * 60), 5 * 60);
    }

    #[test]
    fn failure_bridge_closes_the_trusted_frontdoor_request() {
        let mut app = App::new();
        app.conversation
            .begin_request("request-1", "Implement it")
            .unwrap();
        assert!(close_failed_initial_request(
            &mut app,
            "request-1",
            "The backend failed; retry the request.",
        )
        .unwrap());

        assert_eq!(app.conversation.pending_request_id(), None);
        app.conversation
            .begin_request("request-2", "Retry it")
            .unwrap();
        assert_eq!(app.conversation.pending_request_id(), Some("request-2"));
    }

    #[test]
    fn late_malformed_response_cannot_close_a_newer_pending_request() {
        let mut app = App::new();
        let session_id = app.conversation.session_id().to_string();
        app.conversation
            .begin_request("request-1", "First turn")
            .unwrap();
        app.conversation
            .apply_response(ConversationWireResponse {
                schema_version: 1,
                session_id,
                request_id: "request-1".to_string(),
                kind: ConversationKind::Answer,
                message: "First response".to_string(),
                questions: vec![],
                goal_envelope: None,
            })
            .unwrap();
        app.conversation
            .begin_request("request-2", "Second turn")
            .unwrap();
        app.conversation_busy = true;

        let late = ConversationWireResponse {
            schema_version: 1,
            session_id: "wrong-session".to_string(),
            request_id: "request-1".to_string(),
            kind: ConversationKind::Answer,
            message: "Late malformed response".to_string(),
            questions: vec![],
            goal_envelope: None,
        };
        assert!(apply_or_close_conversation_response(&mut app, late).is_err());
        assert_eq!(app.conversation.pending_request_id(), Some("request-2"));
        assert!(app.conversation_busy);

        assert!(close_failed_initial_request(
            &mut app,
            "request-foreign",
            "Foreign response failed validation.",
        )
        .is_err());
        assert_eq!(app.conversation.pending_request_id(), Some("request-2"));
        assert!(app.conversation_busy);
    }

    #[test]
    fn architect_clarification_reuses_candidate_authority_and_cites_evidence() {
        let candidate = ready_candidate("session-1");
        let response = architect_clarification_response(
            &candidate,
            needs_input_outcome("A compatibility choice is required.".to_string()),
        )
        .unwrap();

        assert_eq!(response.session_id, candidate.session_id);
        assert_eq!(response.request_id, candidate.request_id);
        assert_eq!(response.kind, ConversationKind::Clarify);
        assert!(response.goal_envelope.is_none());
        assert_eq!(response.questions.len(), 1);
        assert!(response.message.contains("`src/lib.rs:12`"));
        assert!(response.message.contains("Both APIs are public."));
    }

    #[test]
    fn architect_clarification_keeps_the_conversation_message_bounded() {
        let candidate = ready_candidate("session-1");
        let response =
            architect_clarification_response(&candidate, needs_input_outcome("x".repeat(8_000)))
                .unwrap();

        assert_eq!(response.message.encode_utf16().count(), 8_000);
        assert!(!response.message.contains("Repository evidence:"));
    }

    #[test]
    fn oversized_candidate_is_rejected_before_spawning_an_architect_cli() {
        let mut app = App::new();
        let session_id = app.conversation.session_id().to_string();
        app.conversation
            .begin_request("request-1", "A deliberately large candidate")
            .unwrap();
        let mut candidate = ready_candidate(&session_id);
        let envelope = candidate.goal_envelope.as_mut().unwrap();
        envelope.objective = "o".repeat(8_000);
        envelope.acceptance_criteria = vec!["a".repeat(2_000)];
        let (tx, _rx) = mpsc::channel(1);

        let error =
            spawn_conversation_architect_validation(&mut app, Path::new("."), tx, candidate, true)
                .unwrap_err();

        assert!(error.contains("pre-accept limit"));
        assert_eq!(app.conversation.pending_request_id(), Some("request-1"));
    }
}
