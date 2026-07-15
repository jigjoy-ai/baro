use std::collections::{HashMap, HashSet};

use serde::Serialize;

use super::{
    render_planning_prompt, ConversationError, ConversationPhase, ConversationSession,
    GoalEnvelope, TranscriptRole,
};

pub const CONVERSATION_CONTEXT_SCHEMA_VERSION: u8 = 1;
pub const MAX_CONVERSATION_CONTEXT_BYTES: usize = 128 * 1024;
pub const MAX_CONVERSATION_CONTEXT_HISTORY: usize = 24;

const MAX_CONTEXT_TEXT_UTF16_UNITS: usize = 8_000;
const MAX_GOAL_ITEM_UTF16_UNITS: usize = 2_000;

/// Accepted-goal lifecycle phases that may be handed to the run-local
/// DialogueAgent. Intake-only phases are deliberately not representable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationContextPhase {
    Ready,
    Planning,
    Executing,
    Verifying,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ConversationContextRole {
    User,
    Assistant,
    System,
}

/// One exact context-history record. `requestId` is always present in JSON;
/// it is null only for deterministic system observations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationContextHistoryEntry {
    request_id: Option<String>,
    role: ConversationContextRole,
    text: String,
}

/// Ephemeral, bounded projection of the durable conversation. It intentionally
/// omits pending-request state, replay sets, route/model choices, DAG state,
/// leases, retries, and every other control-plane field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationContextSnapshot {
    schema_version: u8,
    session_id: String,
    phase: ConversationContextPhase,
    goal_envelope: GoalEnvelope,
    summary: Option<String>,
    history: Vec<ConversationContextHistoryEntry>,
}

impl ConversationContextSnapshot {
    /// Serialize the exact v1 transport value. Projection already enforces the
    /// byte ceiling, but this assertion keeps future schema additions honest.
    pub(crate) fn json_bytes(&self) -> Result<Vec<u8>, ConversationError> {
        let bytes = serde_json::to_vec(self)
            .map_err(|error| ConversationError::InvalidJson(error.to_string()))?;
        if bytes.len() > MAX_CONVERSATION_CONTEXT_BYTES {
            return Err(ConversationError::ContextTooLarge {
                actual: bytes.len(),
                limit: MAX_CONVERSATION_CONTEXT_BYTES,
            });
        }
        Ok(bytes)
    }
}

impl ConversationSession {
    /// Produce the only conversation state allowed to cross into the runtime
    /// orchestrator. `Ok(None)` means intake has not accepted a goal yet.
    ///
    /// History is reduced to complete correlated user/assistant turns plus
    /// uncorrelated system observations. Oldest complete units are discarded
    /// until both the 24-record and 128-KiB limits hold.
    pub fn conversation_context_snapshot(
        &self,
        summary: Option<&str>,
    ) -> Result<Option<ConversationContextSnapshot>, ConversationError> {
        let Some(goal_envelope) = self.goal_envelope().cloned() else {
            return Ok(None);
        };
        validate_context_goal(&goal_envelope)?;
        let phase = context_phase(self.phase())?;
        let mut snapshot = ConversationContextSnapshot {
            schema_version: CONVERSATION_CONTEXT_SCHEMA_VERSION,
            session_id: self.session_id().to_string(),
            phase,
            goal_envelope,
            summary: summary
                .map(|text| normalized_context_text(text, MAX_CONTEXT_TEXT_UTF16_UNITS))
                .transpose()?,
            history: complete_context_history(self)?,
        };

        while snapshot.history.len() > MAX_CONVERSATION_CONTEXT_HISTORY {
            drop_oldest_complete_unit(&mut snapshot.history);
        }
        while serialized_len(&snapshot)? > MAX_CONVERSATION_CONTEXT_BYTES
            && !snapshot.history.is_empty()
        {
            drop_oldest_complete_unit(&mut snapshot.history);
        }
        if serialized_len(&snapshot)? > MAX_CONVERSATION_CONTEXT_BYTES {
            // Summary is optional context, while the accepted goal must remain
            // byte-for-byte identical to the PRD binding.
            snapshot.summary = None;
        }
        let actual = serialized_len(&snapshot)?;
        if actual > MAX_CONVERSATION_CONTEXT_BYTES {
            return Err(ConversationError::ContextTooLarge {
                actual,
                limit: MAX_CONVERSATION_CONTEXT_BYTES,
            });
        }
        Ok(Some(snapshot))
    }
}

fn context_phase(phase: ConversationPhase) -> Result<ConversationContextPhase, ConversationError> {
    match phase {
        ConversationPhase::Ready => Ok(ConversationContextPhase::Ready),
        ConversationPhase::Planning => Ok(ConversationContextPhase::Planning),
        ConversationPhase::Executing => Ok(ConversationContextPhase::Executing),
        ConversationPhase::Verifying => Ok(ConversationContextPhase::Verifying),
        ConversationPhase::Completed => Ok(ConversationContextPhase::Completed),
        ConversationPhase::Failed => Ok(ConversationContextPhase::Failed),
        ConversationPhase::Clarifying | ConversationPhase::NeedsInput => {
            Err(ConversationError::InvalidPersistedState(
                "conversation context requires an accepted-goal phase".to_string(),
            ))
        }
    }
}

fn validate_context_goal(goal: &GoalEnvelope) -> Result<(), ConversationError> {
    // Reuse the domain validator first, then enforce JavaScript's UTF-16 length
    // semantics so a Rust-valid emoji-heavy goal cannot be rejected downstream.
    render_planning_prompt(goal)?;
    validate_utf16_len(
        "goal objective",
        &goal.objective,
        MAX_CONTEXT_TEXT_UTF16_UNITS,
    )?;
    for value in goal
        .constraints
        .iter()
        .chain(&goal.acceptance_criteria)
        .chain(&goal.non_goals)
        .chain(&goal.assumptions)
    {
        validate_utf16_len("goal envelope item", value, MAX_GOAL_ITEM_UTF16_UNITS)?;
    }
    Ok(())
}

#[derive(Default)]
struct CorrelationState {
    user_index: Option<usize>,
    assistant_index: Option<usize>,
    invalid: bool,
}

fn complete_context_history(
    session: &ConversationSession,
) -> Result<Vec<ConversationContextHistoryEntry>, ConversationError> {
    let mut correlations: HashMap<String, CorrelationState> = HashMap::new();
    for (index, turn) in session.transcript().iter().enumerate() {
        let Some(request_id) = turn.request_id.as_ref() else {
            continue;
        };
        let state = correlations.entry(request_id.clone()).or_default();
        match turn.role {
            TranscriptRole::User => {
                if state.user_index.replace(index).is_some() {
                    state.invalid = true;
                }
            }
            TranscriptRole::Assistant => {
                if state.assistant_index.replace(index).is_some() {
                    state.invalid = true;
                }
            }
            // Correlated system failures are persistence diagnostics, not a
            // user/assistant exchange. They never enter runtime history.
            TranscriptRole::System => state.invalid = true,
        }
    }
    let complete_ids: HashSet<&str> = correlations
        .iter()
        .filter_map(|(request_id, state)| {
            let complete = !state.invalid
                && state
                    .user_index
                    .zip(state.assistant_index)
                    .is_some_and(|(user, assistant)| user < assistant);
            complete.then_some(request_id.as_str())
        })
        .collect();

    let mut history = Vec::new();
    for turn in session.transcript() {
        let (role, request_id) = match turn.role {
            TranscriptRole::System if turn.request_id.is_none() => {
                (ConversationContextRole::System, None)
            }
            TranscriptRole::User
                if turn
                    .request_id
                    .as_deref()
                    .is_some_and(|id| complete_ids.contains(id)) =>
            {
                (ConversationContextRole::User, turn.request_id.clone())
            }
            TranscriptRole::Assistant
                if turn
                    .request_id
                    .as_deref()
                    .is_some_and(|id| complete_ids.contains(id)) =>
            {
                (ConversationContextRole::Assistant, turn.request_id.clone())
            }
            _ => continue,
        };
        history.push(ConversationContextHistoryEntry {
            request_id,
            role,
            text: normalized_context_text(&turn.text, MAX_CONTEXT_TEXT_UTF16_UNITS)?,
        });
    }
    Ok(history)
}

fn drop_oldest_complete_unit(history: &mut Vec<ConversationContextHistoryEntry>) {
    let Some(first) = history.first() else {
        return;
    };
    match first.role {
        ConversationContextRole::System => {
            history.remove(0);
        }
        ConversationContextRole::User => {
            let request_id = first.request_id.clone();
            if let Some(assistant_index) = history.iter().position(|entry| {
                entry.role == ConversationContextRole::Assistant && entry.request_id == request_id
            }) {
                history.remove(assistant_index);
            }
            history.remove(0);
        }
        // This should be unreachable after complete-pair filtering. Removing a
        // malformed first record still makes trimming terminate fail-closed.
        ConversationContextRole::Assistant => {
            history.remove(0);
        }
    }
}

fn normalized_context_text(
    value: &str,
    max_utf16_units: usize,
) -> Result<String, ConversationError> {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return Err(ConversationError::MissingRequired(
            "conversation context text",
        ));
    }
    if trimmed
        .chars()
        .any(|character| matches!(character as u32, 0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f))
    {
        return Err(ConversationError::UnsafeControlCharacter(
            "conversation context text",
        ));
    }
    let mut used = 0;
    let bounded: String = trimmed
        .chars()
        .take_while(|character| {
            let next = used + character.len_utf16();
            if next > max_utf16_units {
                false
            } else {
                used = next;
                true
            }
        })
        .collect();
    Ok(bounded)
}

fn validate_utf16_len(
    field: &'static str,
    value: &str,
    limit: usize,
) -> Result<(), ConversationError> {
    let actual = value.encode_utf16().count();
    if actual > limit {
        return Err(ConversationError::TextTooLong {
            field,
            actual,
            limit,
        });
    }
    Ok(())
}

fn serialized_len(snapshot: &ConversationContextSnapshot) -> Result<usize, ConversationError> {
    serde_json::to_vec(snapshot)
        .map(|bytes| bytes.len())
        .map_err(|error| ConversationError::InvalidJson(error.to_string()))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::conversation::{ConversationKind, ConversationWireResponse};

    fn envelope() -> GoalEnvelope {
        GoalEnvelope {
            objective: "Keep the accepted conversation across the run".to_string(),
            constraints: vec!["Dialogue has no control-plane authority".to_string()],
            acceptance_criteria: vec!["Runtime receives bounded context".to_string()],
            non_goals: vec!["Do not persist runtime context in the PRD".to_string()],
            assumptions: vec!["The accepted PRD is session-bound".to_string()],
        }
    }

    fn ready_session() -> ConversationSession {
        let mut session = ConversationSession::new("session-context-1").unwrap();
        session
            .begin_request("request-ready", "Do the clear task")
            .unwrap();
        session
            .apply_response(ConversationWireResponse {
                schema_version: 1,
                session_id: "session-context-1".to_string(),
                request_id: "request-ready".to_string(),
                kind: ConversationKind::Ready,
                message: "Clear. Sending the accepted goal to planning.".to_string(),
                questions: vec![],
                goal_envelope: Some(envelope()),
            })
            .unwrap();
        session
    }

    #[test]
    fn emits_the_exact_v1_schema_with_nullable_system_correlation() {
        let mut session = ready_session();
        session.take_ready_handoff().unwrap().unwrap();
        session.transition_to(ConversationPhase::Planning).unwrap();
        session.record_system_turn("Planning started.").unwrap();
        let snapshot = session
            .conversation_context_snapshot(Some("The accepted goal is being planned."))
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_slice(&snapshot.json_bytes().unwrap()).unwrap();

        let keys = value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<HashSet<_>>();
        assert_eq!(
            keys,
            [
                "schemaVersion",
                "sessionId",
                "phase",
                "goalEnvelope",
                "summary",
                "history"
            ]
            .into_iter()
            .map(str::to_string)
            .collect()
        );
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["phase"], "planning");
        assert_eq!(value["history"][2]["role"], "system");
        assert!(value["history"][2]["requestId"].is_null());
    }

    #[test]
    fn keeps_only_complete_pairs_and_bounds_recent_history() {
        let mut session = ready_session();
        session.take_ready_handoff().unwrap().unwrap();
        session.transition_to(ConversationPhase::Planning).unwrap();
        session.transition_to(ConversationPhase::Executing).unwrap();
        for index in 0..20 {
            let request_id = format!("request-runtime-{index}");
            session
                .begin_request(&request_id, format!("Question {index}"))
                .unwrap();
            session
                .apply_runtime_answer(&request_id, format!("Answer {index}"))
                .unwrap();
        }
        session
            .begin_request("request-pending", "This pair is incomplete")
            .unwrap();

        let snapshot = session
            .conversation_context_snapshot(None)
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_slice(&snapshot.json_bytes().unwrap()).unwrap();
        let history = value["history"].as_array().unwrap();
        assert!(history.len() <= MAX_CONVERSATION_CONTEXT_HISTORY);
        assert!(!history
            .iter()
            .any(|entry| { entry["requestId"] == Value::String("request-pending".to_string()) }));
        for chunk in history.chunks(2) {
            assert_eq!(chunk.len(), 2);
            assert_eq!(chunk[0]["role"], "user");
            assert_eq!(chunk[1]["role"], "assistant");
            assert_eq!(chunk[0]["requestId"], chunk[1]["requestId"]);
        }
    }

    #[test]
    fn truncates_history_using_javascript_utf16_units() {
        let mut session = ready_session();
        session.take_ready_handoff().unwrap().unwrap();
        session.transition_to(ConversationPhase::Planning).unwrap();
        session.transition_to(ConversationPhase::Executing).unwrap();
        session.begin_request("request-emoji", "Question").unwrap();
        session
            .apply_runtime_answer("request-emoji", "😀".repeat(8_000))
            .unwrap();

        let snapshot = session
            .conversation_context_snapshot(None)
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_slice(&snapshot.json_bytes().unwrap()).unwrap();
        let answer = value["history"].as_array().unwrap().last().unwrap()["text"]
            .as_str()
            .unwrap();
        assert_eq!(answer.encode_utf16().count(), MAX_CONTEXT_TEXT_UTF16_UNITS);
        assert!(snapshot.json_bytes().unwrap().len() <= MAX_CONVERSATION_CONTEXT_BYTES);
    }

    #[test]
    fn pre_goal_session_has_no_runtime_context() {
        let session = ConversationSession::new("session-no-goal").unwrap();
        assert!(session
            .conversation_context_snapshot(None)
            .unwrap()
            .is_none());
    }
}
