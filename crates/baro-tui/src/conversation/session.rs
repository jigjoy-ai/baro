use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::contract::{normalized_text, validate_id, validate_response};
use super::{
    render_planning_prompt, ConversationError, ConversationKind, ConversationWireResponse,
    GoalEnvelope, CONVERSATION_SCHEMA_VERSION, MAX_MESSAGE_CHARS, MAX_TRANSCRIPT_TURNS,
};

/// The caller-visible lifecycle of one conversation-backed goal.
///
/// Only `Ready -> Planning -> Executing -> Verifying -> Completed` is advanced
/// by the caller. `Clarifying`, `Ready`, and `NeedsInput` are driven by accepted
/// conversation responses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConversationPhase {
    Clarifying,
    Ready,
    Planning,
    Executing,
    Verifying,
    Completed,
    Failed,
    NeedsInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptTurn {
    pub role: TranscriptRole,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ConversationKind>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyHandoff {
    pub session_id: String,
    pub request_id: String,
    pub goal_envelope: GoalEnvelope,
    pub planning_prompt: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyOutcome {
    Accepted(ConversationKind),
    Duplicate,
}

/// Serializable state for a single conversation-backed goal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationSession {
    pub(super) schema_version: u8,
    pub(super) session_id: String,
    pub(super) phase: ConversationPhase,
    pub(super) transcript: Vec<TranscriptTurn>,
    pub(super) pending_request_id: Option<String>,
    pub(super) completed_request_ids: BTreeSet<String>,
    pub(super) goal_envelope: Option<GoalEnvelope>,
    pub(super) ready_request_id: Option<String>,
    pub(super) ready_handoff_taken: bool,
}

impl ConversationSession {
    pub fn new(session_id: impl Into<String>) -> Result<Self, ConversationError> {
        let session_id = session_id.into();
        validate_id("sessionId", &session_id)?;
        Ok(Self {
            schema_version: CONVERSATION_SCHEMA_VERSION,
            session_id,
            phase: ConversationPhase::Clarifying,
            transcript: Vec::new(),
            pending_request_id: None,
            completed_request_ids: BTreeSet::new(),
            goal_envelope: None,
            ready_request_id: None,
            ready_handoff_taken: false,
        })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn phase(&self) -> ConversationPhase {
        self.phase
    }

    pub fn transcript(&self) -> &[TranscriptTurn] {
        &self.transcript
    }

    pub fn pending_request_id(&self) -> Option<&str> {
        self.pending_request_id.as_deref()
    }

    pub fn goal_envelope(&self) -> Option<&GoalEnvelope> {
        self.goal_envelope.as_ref()
    }

    /// Record a caller-correlated user turn and open exactly one response slot.
    pub fn begin_request(
        &mut self,
        request_id: impl Into<String>,
        text: impl Into<String>,
    ) -> Result<(), ConversationError> {
        let request_id = request_id.into();
        let text = normalized_text("user message", text.into(), MAX_MESSAGE_CHARS)?;
        validate_id("requestId", &request_id)?;
        if let Some(active) = &self.pending_request_id {
            return Err(ConversationError::RequestInFlight(active.clone()));
        }
        if self.completed_request_ids.contains(&request_id) {
            return Err(ConversationError::DuplicateRequest(request_id));
        }
        if self.phase == ConversationPhase::NeedsInput {
            self.phase = ConversationPhase::Clarifying;
        }
        self.push_turn(TranscriptTurn {
            role: TranscriptRole::User,
            text,
            request_id: Some(request_id.clone()),
            kind: None,
        });
        self.pending_request_id = Some(request_id);
        Ok(())
    }

    /// Accept a correlated response at most once.
    ///
    /// Invalid responses leave the request pending, allowing a transport/model
    /// repair to retry the same correlation ID. A replay of an already accepted
    /// response returns `Duplicate` without changing state or transcript.
    pub fn apply_response(
        &mut self,
        response: ConversationWireResponse,
    ) -> Result<ApplyOutcome, ConversationError> {
        if response.schema_version != CONVERSATION_SCHEMA_VERSION {
            return Err(ConversationError::UnsupportedSchemaVersion {
                expected: CONVERSATION_SCHEMA_VERSION,
                actual: response.schema_version,
            });
        }
        if response.session_id != self.session_id {
            return Err(ConversationError::SessionMismatch {
                expected: self.session_id.clone(),
                actual: response.session_id,
            });
        }
        validate_id("requestId", &response.request_id)?;
        if self.completed_request_ids.contains(&response.request_id) {
            return Ok(ApplyOutcome::Duplicate);
        }
        match self.pending_request_id.as_deref() {
            Some(expected) if expected == response.request_id => {}
            expected => {
                return Err(ConversationError::StaleRequest {
                    expected: expected.map(str::to_string),
                    actual: response.request_id,
                });
            }
        }

        let previous_phase = self.phase;
        let validated = validate_response(response, self.phase, self.goal_envelope.is_some())?;
        let request_id = validated.request_id.clone();
        let kind = validated.kind;
        let assistant_text = response_history_text(&validated);
        self.push_turn(TranscriptTurn {
            role: TranscriptRole::Assistant,
            text: assistant_text,
            request_id: Some(request_id.clone()),
            kind: Some(kind),
        });

        match kind {
            ConversationKind::Ready => {
                self.goal_envelope = validated.goal_envelope;
                self.ready_request_id = Some(request_id.clone());
                self.ready_handoff_taken = false;
                self.phase = ConversationPhase::Ready;
            }
            ConversationKind::Clarify => {
                if matches!(
                    previous_phase,
                    ConversationPhase::Completed | ConversationPhase::Failed
                ) {
                    self.goal_envelope = None;
                    self.ready_request_id = None;
                    self.ready_handoff_taken = false;
                }
                self.phase = ConversationPhase::NeedsInput;
            }
            ConversationKind::Answer => {}
        }

        self.pending_request_id = None;
        self.completed_request_ids.insert(request_id);
        Ok(ApplyOutcome::Accepted(kind))
    }

    /// Correlate a reply from the run-local DialogueAgent without allowing it
    /// to mutate the goal lifecycle. Runtime conversation is advisory; only a
    /// later front-door `Ready` response may create a new planning handoff.
    pub fn apply_runtime_answer(
        &mut self,
        request_id: impl Into<String>,
        text: impl Into<String>,
    ) -> Result<ApplyOutcome, ConversationError> {
        let request_id = request_id.into();
        validate_id("requestId", &request_id)?;
        if self.completed_request_ids.contains(&request_id) {
            return Ok(ApplyOutcome::Duplicate);
        }
        match self.pending_request_id.as_deref() {
            Some(expected) if expected == request_id => {}
            expected => {
                return Err(ConversationError::StaleRequest {
                    expected: expected.map(str::to_string),
                    actual: request_id,
                });
            }
        }
        if !matches!(
            self.phase,
            ConversationPhase::Executing
                | ConversationPhase::Verifying
                | ConversationPhase::Completed
                | ConversationPhase::Failed
        ) {
            return Err(ConversationError::ResponseNotAllowedInPhase {
                kind: ConversationKind::Answer,
                phase: self.phase,
            });
        }
        let text = normalized_text("assistant message", text.into(), MAX_MESSAGE_CHARS)?;
        self.push_turn(TranscriptTurn {
            role: TranscriptRole::Assistant,
            text,
            request_id: Some(request_id.clone()),
            kind: Some(ConversationKind::Answer),
        });
        self.pending_request_id = None;
        self.completed_request_ids.insert(request_id);
        Ok(ApplyOutcome::Accepted(ConversationKind::Answer))
    }

    /// Observe the orchestrator's echo of a runtime user request. Local TUI
    /// sends are already recorded before crossing stdin, while cloud/headless
    /// sends first become visible here; identical echoes are idempotent.
    pub fn observe_runtime_request(
        &mut self,
        request_id: impl Into<String>,
        text: impl Into<String>,
    ) -> Result<ApplyOutcome, ConversationError> {
        let request_id = request_id.into();
        let text = normalized_text("user message", text.into(), MAX_MESSAGE_CHARS)?;
        validate_id("requestId", &request_id)?;
        if self.completed_request_ids.contains(&request_id) {
            return Ok(ApplyOutcome::Duplicate);
        }
        if self.pending_request_id.as_deref() == Some(request_id.as_str()) {
            let identical = self.transcript.iter().rev().any(|turn| {
                turn.role == TranscriptRole::User
                    && turn.request_id.as_deref() == Some(request_id.as_str())
                    && turn.text == text
            });
            return if identical {
                Ok(ApplyOutcome::Duplicate)
            } else {
                Err(ConversationError::DuplicateRequest(request_id))
            };
        }
        self.begin_request(request_id, text)?;
        Ok(ApplyOutcome::Accepted(ConversationKind::Answer))
    }

    /// Close a correlated runtime turn that could not produce an answer. The
    /// failure is durable and the user can submit a fresh request immediately.
    pub fn apply_runtime_failure(
        &mut self,
        request_id: impl Into<String>,
        error: impl Into<String>,
    ) -> Result<ApplyOutcome, ConversationError> {
        let request_id = request_id.into();
        validate_id("requestId", &request_id)?;
        if self.completed_request_ids.contains(&request_id) {
            return Ok(ApplyOutcome::Duplicate);
        }
        match self.pending_request_id.as_deref() {
            Some(expected) if expected == request_id => {}
            expected => {
                return Err(ConversationError::StaleRequest {
                    expected: expected.map(str::to_string),
                    actual: request_id,
                });
            }
        }
        let error = normalized_text(
            "runtime conversation error",
            error.into(),
            MAX_MESSAGE_CHARS,
        )?;
        self.push_turn(TranscriptTurn {
            role: TranscriptRole::System,
            text: format!("Conversation turn failed: {error}"),
            request_id: Some(request_id.clone()),
            kind: None,
        });
        self.pending_request_id = None;
        self.completed_request_ids.insert(request_id);
        Ok(ApplyOutcome::Accepted(ConversationKind::Answer))
    }

    /// Consume the initial planning handoff exactly once.
    pub fn take_ready_handoff(&mut self) -> Result<Option<ReadyHandoff>, ConversationError> {
        if self.phase != ConversationPhase::Ready || self.ready_handoff_taken {
            return Ok(None);
        }
        let request_id =
            self.ready_request_id
                .clone()
                .ok_or(ConversationError::InvalidPersistedState(
                    "ready phase has no ready request id".to_string(),
                ))?;
        let goal_envelope =
            self.goal_envelope
                .clone()
                .ok_or(ConversationError::InvalidPersistedState(
                    "ready phase has no goal envelope".to_string(),
                ))?;
        let planning_prompt = render_planning_prompt(&goal_envelope)?;
        self.ready_handoff_taken = true;
        Ok(Some(ReadyHandoff {
            session_id: self.session_id.clone(),
            request_id,
            goal_envelope,
            planning_prompt,
        }))
    }

    /// Advance a caller-owned lifecycle phase. Conversation responses cannot
    /// skip these boundaries.
    pub fn transition_to(&mut self, next: ConversationPhase) -> Result<(), ConversationError> {
        if self.phase == next {
            return Ok(());
        }
        let allowed = matches!(
            (self.phase, next),
            (ConversationPhase::Ready, ConversationPhase::Planning)
                | (ConversationPhase::Planning, ConversationPhase::Executing)
                | (ConversationPhase::Executing, ConversationPhase::Verifying)
                | (ConversationPhase::Verifying, ConversationPhase::Completed)
                | (ConversationPhase::Planning, ConversationPhase::Failed)
                | (ConversationPhase::Executing, ConversationPhase::Failed)
                | (ConversationPhase::Verifying, ConversationPhase::Failed)
                // A failed/interrupted run may be retried from its durable
                // checkpoint without manufacturing a second goal handoff.
                | (ConversationPhase::Failed, ConversationPhase::Executing)
        );
        if !allowed {
            return Err(ConversationError::InvalidPhaseTransition {
                from: self.phase,
                to: next,
            });
        }
        if next == ConversationPhase::Planning && !self.ready_handoff_taken {
            return Err(ConversationError::ReadyHandoffNotTaken);
        }
        self.phase = next;
        Ok(())
    }

    /// Add a deterministic lifecycle/status line without a model call.
    pub fn record_system_turn(&mut self, text: impl Into<String>) -> Result<(), ConversationError> {
        let text = normalized_text("system message", text.into(), MAX_MESSAGE_CHARS)?;
        self.push_turn(TranscriptTurn {
            role: TranscriptRole::System,
            text,
            request_id: None,
            kind: None,
        });
        Ok(())
    }

    /// Re-open a durable post-handoff session at the review/planning boundary
    /// after a process or machine restart. The PRD remains the execution
    /// checkpoint; any response that was in flight when the process stopped is
    /// deliberately abandoned and may be re-asked by the user.
    pub fn prepare_resume(&mut self) -> Result<(), ConversationError> {
        if self.goal_envelope.is_none() || !self.ready_handoff_taken {
            return Err(ConversationError::InvalidPersistedState(
                "cannot resume a conversation before its goal handoff".to_string(),
            ));
        }
        self.pending_request_id = None;
        self.phase = ConversationPhase::Planning;
        self.record_system_turn("Resumed the existing goal from its durable PRD checkpoint.")
    }

    fn push_turn(&mut self, turn: TranscriptTurn) {
        self.transcript.push(turn);
        if self.transcript.len() > MAX_TRANSCRIPT_TURNS {
            let overflow = self.transcript.len() - MAX_TRANSCRIPT_TURNS;
            self.transcript.drain(0..overflow);
        }
    }
}

fn response_history_text(response: &ConversationWireResponse) -> String {
    if response.questions.is_empty() {
        return response.message.clone();
    }
    let questions = response
        .questions
        .iter()
        .map(|question| {
            let reason = question
                .reason
                .as_deref()
                .map(|value| format!(" ({value})"))
                .unwrap_or_default();
            format!("- [{}] {}{}", question.id, question.text, reason)
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("{}\nQuestions:\n{}", response.message, questions)
}

#[cfg(test)]
mod tests {
    use super::super::contract::ClarificationQuestion;
    use super::*;

    fn envelope() -> GoalEnvelope {
        GoalEnvelope {
            objective: "Add a conversation-first entry point".to_string(),
            constraints: vec!["Keep Board authority separate".to_string()],
            acceptance_criteria: vec!["Ambiguous goals cause a question".to_string()],
            non_goals: vec!["Do not change model routing".to_string()],
            assumptions: vec!["The repository is already selected".to_string()],
        }
    }

    fn response(
        request_id: &str,
        kind: ConversationKind,
        questions: Vec<ClarificationQuestion>,
        goal_envelope: Option<GoalEnvelope>,
    ) -> ConversationWireResponse {
        ConversationWireResponse {
            schema_version: CONVERSATION_SCHEMA_VERSION,
            session_id: "session-1".to_string(),
            request_id: request_id.to_string(),
            kind,
            message: match kind {
                ConversationKind::Ready => "Clear. Sending this to planning.".to_string(),
                ConversationKind::Clarify => "I need one detail before planning.".to_string(),
                ConversationKind::Answer => "Three workers are active.".to_string(),
            },
            questions,
            goal_envelope,
        }
    }

    #[test]
    fn clarification_then_ready_produces_one_handoff() {
        let mut session = ConversationSession::new("session-1").unwrap();
        session
            .begin_request("request-1", "Make it better")
            .unwrap();
        let clarification = response(
            "request-1",
            ConversationKind::Clarify,
            vec![ClarificationQuestion {
                id: "scope".to_string(),
                text: "Which behavior must remain compatible?".to_string(),
                reason: Some("It changes the implementation boundary".to_string()),
            }],
            None,
        );
        assert_eq!(
            session.apply_response(clarification).unwrap(),
            ApplyOutcome::Accepted(ConversationKind::Clarify)
        );
        assert_eq!(session.phase(), ConversationPhase::NeedsInput);

        session
            .begin_request("request-2", "Keep the existing Board authority")
            .unwrap();
        assert_eq!(session.phase(), ConversationPhase::Clarifying);
        assert_eq!(
            session
                .apply_response(response(
                    "request-2",
                    ConversationKind::Ready,
                    vec![],
                    Some(envelope()),
                ))
                .unwrap(),
            ApplyOutcome::Accepted(ConversationKind::Ready)
        );
        assert_eq!(session.phase(), ConversationPhase::Ready);

        let handoff = session.take_ready_handoff().unwrap().unwrap();
        assert_eq!(handoff.request_id, "request-2");
        assert!(handoff.planning_prompt.contains("Objective:"));
        assert!(handoff.planning_prompt.contains("Acceptance criteria:"));
        assert!(session.take_ready_handoff().unwrap().is_none());
    }

    #[test]
    fn duplicate_is_ignored_and_stale_response_is_rejected() {
        let mut session = ConversationSession::new("session-1").unwrap();
        session
            .begin_request("request-1", "What is happening?")
            .unwrap();
        let answer = response("request-1", ConversationKind::Answer, vec![], None);
        assert_eq!(
            session.apply_response(answer.clone()).unwrap(),
            ApplyOutcome::Accepted(ConversationKind::Answer)
        );
        let turn_count = session.transcript().len();
        assert_eq!(
            session.apply_response(answer).unwrap(),
            ApplyOutcome::Duplicate
        );
        assert_eq!(session.transcript().len(), turn_count);

        session.begin_request("request-2", "And now?").unwrap();
        assert!(matches!(
            session.apply_response(response(
                "request-old",
                ConversationKind::Answer,
                vec![],
                None,
            )),
            Err(ConversationError::StaleRequest { .. })
        ));
        assert_eq!(session.pending_request_id(), Some("request-2"));
    }

    #[test]
    fn rejected_response_keeps_the_request_open_for_repair() {
        let mut session = ConversationSession::new("session-1").unwrap();
        session
            .begin_request("request-1", "Implement the clear goal")
            .unwrap();
        let malformed = response("request-1", ConversationKind::Ready, vec![], None);
        assert!(matches!(
            session.apply_response(malformed),
            Err(ConversationError::InvalidWireShape(_))
        ));
        assert_eq!(session.pending_request_id(), Some("request-1"));
        session
            .apply_response(response(
                "request-1",
                ConversationKind::Ready,
                vec![],
                Some(envelope()),
            ))
            .unwrap();
        assert_eq!(session.phase(), ConversationPhase::Ready);
    }

    #[test]
    fn ready_handoff_is_required_before_caller_phase_progression() {
        let mut session = ConversationSession::new("session-1").unwrap();
        session.begin_request("request-1", "Clear task").unwrap();
        session
            .apply_response(response(
                "request-1",
                ConversationKind::Ready,
                vec![],
                Some(envelope()),
            ))
            .unwrap();
        assert_eq!(
            session.transition_to(ConversationPhase::Planning),
            Err(ConversationError::ReadyHandoffNotTaken)
        );
        session.take_ready_handoff().unwrap().unwrap();
        session.transition_to(ConversationPhase::Planning).unwrap();
        session.transition_to(ConversationPhase::Executing).unwrap();
        session.transition_to(ConversationPhase::Verifying).unwrap();
        session.transition_to(ConversationPhase::Completed).unwrap();
        assert_eq!(session.phase(), ConversationPhase::Completed);
        assert!(matches!(
            session.transition_to(ConversationPhase::Executing),
            Err(ConversationError::InvalidPhaseTransition { .. })
        ));
    }

    #[test]
    fn failed_execution_can_retry_without_reissuing_the_goal_handoff() {
        let mut session = ConversationSession::new("session-1").unwrap();
        session.begin_request("request-1", "Clear task").unwrap();
        session
            .apply_response(response(
                "request-1",
                ConversationKind::Ready,
                vec![],
                Some(envelope()),
            ))
            .unwrap();
        session.take_ready_handoff().unwrap().unwrap();
        session.transition_to(ConversationPhase::Planning).unwrap();
        session.transition_to(ConversationPhase::Executing).unwrap();
        session.transition_to(ConversationPhase::Failed).unwrap();
        session.transition_to(ConversationPhase::Executing).unwrap();
        assert_eq!(session.phase(), ConversationPhase::Executing);
    }

    #[test]
    fn resume_reopens_the_same_session_at_the_planning_boundary() {
        let mut session = ConversationSession::new("session-1").unwrap();
        session.begin_request("request-1", "Clear task").unwrap();
        session
            .apply_response(response(
                "request-1",
                ConversationKind::Ready,
                vec![],
                Some(envelope()),
            ))
            .unwrap();
        session.take_ready_handoff().unwrap().unwrap();
        session.transition_to(ConversationPhase::Planning).unwrap();
        session.transition_to(ConversationPhase::Executing).unwrap();
        session
            .begin_request("status-while-running", "Any update?")
            .unwrap();

        session.prepare_resume().unwrap();

        assert_eq!(session.phase(), ConversationPhase::Planning);
        assert_eq!(session.session_id(), "session-1");
        assert_eq!(session.pending_request_id(), None);
        assert_eq!(session.goal_envelope(), Some(&envelope()));
    }

    #[test]
    fn runtime_dialogue_is_correlated_without_changing_execution_phase() {
        let mut session = ConversationSession::new("session-1").unwrap();
        session.begin_request("request-1", "Clear task").unwrap();
        session
            .apply_response(response(
                "request-1",
                ConversationKind::Ready,
                vec![],
                Some(envelope()),
            ))
            .unwrap();
        session.take_ready_handoff().unwrap().unwrap();
        session.transition_to(ConversationPhase::Planning).unwrap();
        session.transition_to(ConversationPhase::Executing).unwrap();

        session
            .begin_request("runtime-1", "What is blocked?")
            .unwrap();
        assert_eq!(
            session
                .observe_runtime_request("runtime-1", "What is blocked?")
                .unwrap(),
            ApplyOutcome::Duplicate
        );
        assert_eq!(
            session
                .apply_runtime_answer("runtime-1", "Nothing is blocked.")
                .unwrap(),
            ApplyOutcome::Accepted(ConversationKind::Answer)
        );
        assert_eq!(session.phase(), ConversationPhase::Executing);
        assert_eq!(session.pending_request_id(), None);
        assert_eq!(
            session
                .apply_runtime_answer("runtime-1", "duplicate")
                .unwrap(),
            ApplyOutcome::Duplicate
        );

        session.begin_request("runtime-2", "And now?").unwrap();
        session
            .apply_runtime_failure("runtime-2", "backend unavailable")
            .unwrap();
        assert_eq!(session.phase(), ConversationPhase::Executing);
        assert_eq!(session.pending_request_id(), None);

        assert_eq!(
            session
                .observe_runtime_request("runtime-cloud", "Cloud status?")
                .unwrap(),
            ApplyOutcome::Accepted(ConversationKind::Answer)
        );
        session
            .apply_runtime_answer("runtime-cloud", "Cloud is connected.")
            .unwrap();
    }

    #[test]
    fn validates_bounds_ids_controls_and_semantic_shapes() {
        assert!(ConversationSession::new("../unsafe").is_err());
        let mut session = ConversationSession::new("session-1").unwrap();
        assert!(session.begin_request("request-1", "bad\0message").is_err());
        session
            .begin_request("request-1", "Need clarification")
            .unwrap();
        let duplicate_questions = vec![
            ClarificationQuestion {
                id: "same".to_string(),
                text: "First?".to_string(),
                reason: None,
            },
            ClarificationQuestion {
                id: "same".to_string(),
                text: "Second?".to_string(),
                reason: None,
            },
        ];
        assert!(matches!(
            session.apply_response(response(
                "request-1",
                ConversationKind::Clarify,
                duplicate_questions,
                None,
            )),
            Err(ConversationError::DuplicateItem { .. })
        ));
    }

    #[test]
    fn transcript_is_bounded_without_losing_request_dedupe() {
        let mut session = ConversationSession::new("session-1").unwrap();
        for index in 0..(MAX_TRANSCRIPT_TURNS + 20) {
            let request_id = format!("request-{index}");
            session.begin_request(&request_id, "status").unwrap();
            session
                .apply_response(response(
                    &request_id,
                    ConversationKind::Answer,
                    vec![],
                    None,
                ))
                .unwrap();
        }
        assert_eq!(session.transcript().len(), MAX_TRANSCRIPT_TURNS);
        assert!(matches!(
            session.begin_request("request-0", "replay"),
            Err(ConversationError::DuplicateRequest(_))
        ));
    }
}
