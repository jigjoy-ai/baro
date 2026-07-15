//! Pure conversation-session domain state.
//!
//! This module deliberately owns no terminal, process, network, repository, or
//! global-environment behavior. Callers provide correlation IDs, transport the
//! wire response, decide when execution phases advance, and opt in to
//! persistence by passing an explicit path.

mod context;
mod contract;
mod persistence;
mod session;

use std::fmt;

pub use context::ConversationContextSnapshot;
pub use contract::{
    render_planning_prompt, ClarificationQuestion, ConversationKind, ConversationWireResponse,
    GoalEnvelope,
};
pub use session::{ApplyOutcome, ConversationPhase, ConversationSession, TranscriptRole};

pub const CONVERSATION_SCHEMA_VERSION: u8 = 1;

pub(super) const MAX_PERSISTED_BYTES: u64 = 2 * 1024 * 1024;
pub(super) const MAX_MESSAGE_CHARS: usize = 8_000;
pub(super) const MAX_TRANSCRIPT_TURNS: usize = 256;
pub(super) const MAX_COMPLETED_REQUESTS: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversationError {
    UnsupportedSchemaVersion {
        expected: u8,
        actual: u8,
    },
    InvalidJson(String),
    InvalidWireShape(String),
    WireTooLarge {
        actual: usize,
        limit: usize,
    },
    PersistenceTooLarge {
        actual: u64,
        limit: u64,
    },
    ContextTooLarge {
        actual: usize,
        limit: usize,
    },
    InvalidId {
        field: &'static str,
        value: String,
    },
    MissingRequired(&'static str),
    TextTooLong {
        field: &'static str,
        actual: usize,
        limit: usize,
    },
    UnsafeControlCharacter(&'static str),
    TooManyItems {
        field: &'static str,
        actual: usize,
        limit: usize,
    },
    DuplicateItem {
        field: &'static str,
        value: String,
    },
    SessionMismatch {
        expected: String,
        actual: String,
    },
    RequestInFlight(String),
    DuplicateRequest(String),
    StaleRequest {
        expected: Option<String>,
        actual: String,
    },
    ReadyAlreadyAccepted,
    ReadyHandoffNotTaken,
    ResponseNotAllowedInPhase {
        kind: ConversationKind,
        phase: ConversationPhase,
    },
    InitialRequestFailureNotAllowedInPhase {
        phase: ConversationPhase,
    },
    InvalidPhaseTransition {
        from: ConversationPhase,
        to: ConversationPhase,
    },
    InvalidPersistedState(String),
    Io {
        operation: &'static str,
        path: String,
        message: String,
    },
}

impl fmt::Display for ConversationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchemaVersion { expected, actual } => write!(
                formatter,
                "unsupported conversation schema {actual}; expected {expected}"
            ),
            Self::InvalidJson(message) => write!(formatter, "invalid conversation JSON: {message}"),
            Self::InvalidWireShape(message) => {
                write!(formatter, "invalid conversation response: {message}")
            }
            Self::WireTooLarge { actual, limit } => write!(
                formatter,
                "conversation response is {actual} bytes; limit is {limit}"
            ),
            Self::PersistenceTooLarge { actual, limit } => write!(
                formatter,
                "conversation snapshot is {actual} bytes; limit is {limit}"
            ),
            Self::ContextTooLarge { actual, limit } => write!(
                formatter,
                "conversation runtime context is {actual} bytes; limit is {limit}"
            ),
            Self::InvalidId { field, value } => write!(formatter, "invalid {field}: {value:?}"),
            Self::MissingRequired(field) => write!(formatter, "{field} must not be empty"),
            Self::TextTooLong {
                field,
                actual,
                limit,
            } => write!(
                formatter,
                "{field} is {actual} characters; limit is {limit}"
            ),
            Self::UnsafeControlCharacter(field) => {
                write!(formatter, "{field} contains a disallowed control character")
            }
            Self::TooManyItems {
                field,
                actual,
                limit,
            } => write!(formatter, "{field} has {actual} items; limit is {limit}"),
            Self::DuplicateItem { field, value } => {
                write!(formatter, "{field} contains duplicate value {value:?}")
            }
            Self::SessionMismatch { expected, actual } => write!(
                formatter,
                "response session {actual:?} does not match {expected:?}"
            ),
            Self::RequestInFlight(request_id) => write!(
                formatter,
                "request {request_id:?} is still awaiting a response"
            ),
            Self::DuplicateRequest(request_id) => {
                write!(formatter, "request {request_id:?} was already completed")
            }
            Self::StaleRequest { expected, actual } => match expected {
                Some(expected) => write!(
                    formatter,
                    "response request {actual:?} is stale; awaiting {expected:?}"
                ),
                None => write!(
                    formatter,
                    "response request {actual:?} has no pending request"
                ),
            },
            Self::ReadyAlreadyAccepted => write!(formatter, "a ready goal was already accepted"),
            Self::ReadyHandoffNotTaken => {
                write!(formatter, "ready handoff must be consumed before planning")
            }
            Self::ResponseNotAllowedInPhase { kind, phase } => write!(
                formatter,
                "{kind:?} response is not allowed in phase {phase:?}"
            ),
            Self::InitialRequestFailureNotAllowedInPhase { phase } => write!(
                formatter,
                "an initial conversation request cannot fail in phase {phase:?}"
            ),
            Self::InvalidPhaseTransition { from, to } => write!(
                formatter,
                "invalid conversation phase transition {from:?} -> {to:?}"
            ),
            Self::InvalidPersistedState(message) => {
                write!(formatter, "invalid persisted conversation state: {message}")
            }
            Self::Io {
                operation,
                path,
                message,
            } => write!(
                formatter,
                "could not {operation} conversation snapshot {path}: {message}"
            ),
        }
    }
}

impl std::error::Error for ConversationError {}
