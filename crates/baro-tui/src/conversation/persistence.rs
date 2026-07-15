use std::fs;
use std::io::Write;
use std::path::Path;

use super::contract::{validate_goal_envelope, validate_id, validate_text};
use super::{
    ConversationError, ConversationPhase, ConversationSession, CONVERSATION_SCHEMA_VERSION,
    MAX_COMPLETED_REQUESTS, MAX_MESSAGE_CHARS, MAX_PERSISTED_BYTES, MAX_TRANSCRIPT_TURNS,
};

impl ConversationSession {
    /// Persist this snapshot to exactly the caller-provided path.
    /// Parent directories are intentionally not created.
    pub fn save_to_path(&self, path: &Path) -> Result<(), ConversationError> {
        self.validate_persisted_state()?;
        let mut bytes = serde_json::to_vec_pretty(self)
            .map_err(|error| ConversationError::InvalidJson(error.to_string()))?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_PERSISTED_BYTES {
            return Err(ConversationError::PersistenceTooLarge {
                actual: bytes.len() as u64,
                limit: MAX_PERSISTED_BYTES,
            });
        }
        let parent = path.parent().ok_or_else(|| ConversationError::Io {
            operation: "write",
            path: path.display().to_string(),
            message: "snapshot path has no parent directory".to_string(),
        })?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|error| ConversationError::Io {
                operation: "create temporary",
                path: path.display().to_string(),
                message: error.to_string(),
            })?;
        temporary
            .write_all(&bytes)
            .and_then(|()| temporary.as_file().sync_all())
            .map_err(|error| ConversationError::Io {
                operation: "write temporary",
                path: path.display().to_string(),
                message: error.to_string(),
            })?;
        temporary
            .persist(path)
            .map(|_| ())
            .map_err(|error| ConversationError::Io {
                operation: "replace",
                path: path.display().to_string(),
                message: error.error.to_string(),
            })
    }

    /// Load and fully revalidate a snapshot from exactly the caller path.
    pub fn load_from_path(path: &Path) -> Result<Self, ConversationError> {
        let metadata = fs::metadata(path).map_err(|error| ConversationError::Io {
            operation: "inspect",
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
        if metadata.len() > MAX_PERSISTED_BYTES {
            return Err(ConversationError::PersistenceTooLarge {
                actual: metadata.len(),
                limit: MAX_PERSISTED_BYTES,
            });
        }
        let bytes = fs::read(path).map_err(|error| ConversationError::Io {
            operation: "read",
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
        if bytes.len() as u64 > MAX_PERSISTED_BYTES {
            return Err(ConversationError::PersistenceTooLarge {
                actual: bytes.len() as u64,
                limit: MAX_PERSISTED_BYTES,
            });
        }
        let session: Self = serde_json::from_slice(&bytes)
            .map_err(|error| ConversationError::InvalidJson(error.to_string()))?;
        session.validate_persisted_state()?;
        Ok(session)
    }

    fn validate_persisted_state(&self) -> Result<(), ConversationError> {
        if self.schema_version != CONVERSATION_SCHEMA_VERSION {
            return Err(ConversationError::UnsupportedSchemaVersion {
                expected: CONVERSATION_SCHEMA_VERSION,
                actual: self.schema_version,
            });
        }
        validate_id("sessionId", &self.session_id)?;
        if self.transcript.len() > MAX_TRANSCRIPT_TURNS {
            return Err(ConversationError::InvalidPersistedState(format!(
                "transcript exceeds {MAX_TRANSCRIPT_TURNS} turns"
            )));
        }
        for turn in &self.transcript {
            validate_text("transcript text", &turn.text, MAX_MESSAGE_CHARS)?;
            if let Some(request_id) = &turn.request_id {
                validate_id("transcript requestId", request_id)?;
            }
        }
        if self.completed_request_ids.len() > MAX_COMPLETED_REQUESTS {
            return Err(ConversationError::InvalidPersistedState(format!(
                "completed request set exceeds {MAX_COMPLETED_REQUESTS} entries"
            )));
        }
        for request_id in &self.completed_request_ids {
            validate_id("completed requestId", request_id)?;
        }
        if let Some(request_id) = &self.pending_request_id {
            validate_id("pending requestId", request_id)?;
            if self.completed_request_ids.contains(request_id) {
                return Err(ConversationError::InvalidPersistedState(
                    "pending request is already completed".to_string(),
                ));
            }
        }

        match (&self.goal_envelope, &self.ready_request_id) {
            (Some(envelope), Some(request_id)) => {
                validate_goal_envelope(envelope)?;
                validate_id("ready requestId", request_id)?;
                if !self.completed_request_ids.contains(request_id) {
                    return Err(ConversationError::InvalidPersistedState(
                        "ready request is not in the completed request set".to_string(),
                    ));
                }
            }
            (None, None) => {}
            _ => {
                return Err(ConversationError::InvalidPersistedState(
                    "goal envelope and ready request id must appear together".to_string(),
                ));
            }
        }

        match self.phase {
            ConversationPhase::Clarifying | ConversationPhase::NeedsInput => {
                if self.goal_envelope.is_some() || self.ready_handoff_taken {
                    return Err(ConversationError::InvalidPersistedState(
                        "pre-ready phase contains ready-goal state".to_string(),
                    ));
                }
            }
            ConversationPhase::Ready => {
                if self.goal_envelope.is_none() {
                    return Err(ConversationError::InvalidPersistedState(
                        "ready phase has no goal envelope".to_string(),
                    ));
                }
            }
            ConversationPhase::Planning
            | ConversationPhase::Executing
            | ConversationPhase::Verifying
            | ConversationPhase::Completed
            | ConversationPhase::Failed => {
                if self.goal_envelope.is_none() {
                    return Err(ConversationError::InvalidPersistedState(
                        "post-clarification phase has no goal envelope".to_string(),
                    ));
                }
                if !self.ready_handoff_taken {
                    return Err(ConversationError::InvalidPersistedState(
                        "post-ready phase has an unconsumed handoff".to_string(),
                    ));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::{ApplyOutcome, ConversationKind, ConversationWireResponse, GoalEnvelope};
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

    fn ready_response() -> ConversationWireResponse {
        ConversationWireResponse {
            schema_version: CONVERSATION_SCHEMA_VERSION,
            session_id: "session-1".to_string(),
            request_id: "request-1".to_string(),
            kind: ConversationKind::Ready,
            message: "Clear. Sending this to planning.".to_string(),
            questions: vec![],
            goal_envelope: Some(envelope()),
        }
    }

    #[test]
    fn explicit_path_persistence_round_trips_dedupe_and_handoff_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("conversation.json");
        let mut session = ConversationSession::new("session-1").unwrap();
        session.begin_request("request-1", "Clear task").unwrap();
        session.apply_response(ready_response()).unwrap();
        session.take_ready_handoff().unwrap().unwrap();
        session
            .record_system_turn("Planning will start now.")
            .unwrap();
        session.save_to_path(&path).unwrap();

        let mut loaded = ConversationSession::load_from_path(&path).unwrap();
        assert_eq!(loaded, session);

        session
            .record_system_turn("The atomic snapshot can replace an existing file.")
            .unwrap();
        session.save_to_path(&path).unwrap();
        assert_eq!(ConversationSession::load_from_path(&path).unwrap(), session);

        assert!(loaded.take_ready_handoff().unwrap().is_none());
        assert_eq!(
            loaded.apply_response(ready_response()),
            Ok(ApplyOutcome::Duplicate)
        );

        let missing_parent = directory.path().join("missing").join("state.json");
        assert!(matches!(
            session.save_to_path(&missing_parent),
            Err(ConversationError::Io { .. })
        ));
        assert!(!missing_parent.exists());
    }
}
