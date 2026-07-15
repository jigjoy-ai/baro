use std::collections::BTreeSet;
use std::fmt;

use serde::{Deserialize, Serialize};

pub const ARCHITECT_OUTCOME_SCHEMA_VERSION: u8 = 1;
pub const MAX_ARCHITECT_OUTCOME_BYTES: usize = 128 * 1024;

const MAX_MESSAGE_CHARS: usize = 8_000;
const MAX_DECISION_DOCUMENT_CHARS: usize = 96 * 1024;
const MAX_QUESTIONS: usize = 3;
const MAX_QUESTION_TEXT_CHARS: usize = 1_000;
const MAX_QUESTION_REASON_CHARS: usize = 1_000;
const MAX_EVIDENCE: usize = 16;
const MAX_EVIDENCE_PATH_CHARS: usize = 512;
const MAX_EVIDENCE_FACT_CHARS: usize = 2_000;
const MAX_CORRELATION_ID_CHARS: usize = 128;
const MAX_LINE_NUMBER: u32 = 10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchitectOutcomeKindV1 {
    Ready,
    NeedsInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchitectClarificationQuestionV1 {
    pub id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchitectRepositoryEvidenceV1 {
    pub path: String,
    pub line: Option<u32>,
    pub fact: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchitectOutcomeV1 {
    pub schema_version: u8,
    pub kind: ArchitectOutcomeKindV1,
    pub message: String,
    pub questions: Vec<ArchitectClarificationQuestionV1>,
    pub evidence: Vec<ArchitectRepositoryEvidenceV1>,
    pub decision_document: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchitectOutcomeTransportV1 {
    pub schema_version: u8,
    pub session_id: String,
    pub goal_request_id: String,
    pub architect_request_id: String,
    pub outcome: ArchitectOutcomeV1,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchitectOutcomeContractError {
    message: String,
}

impl ArchitectOutcomeContractError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for ArchitectOutcomeContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ArchitectOutcomeContractError {}

/// Parse the exact v1 Architect transport and bind its model-produced payload
/// to trusted caller correlations. The wrapper is intentionally rejected if
/// any correlation differs, even when the nested outcome is otherwise valid.
pub fn parse_architect_outcome_transport_v1(
    raw: &str,
    expected_session_id: &str,
    expected_goal_request_id: &str,
    expected_architect_request_id: &str,
) -> Result<ArchitectOutcomeTransportV1, ArchitectOutcomeContractError> {
    if raw.len() > MAX_ARCHITECT_OUTCOME_BYTES {
        return Err(ArchitectOutcomeContractError::new(format!(
            "architect outcome transport is {} bytes; limit is {}",
            raw.len(),
            MAX_ARCHITECT_OUTCOME_BYTES
        )));
    }

    validate_safe_id("expected sessionId", expected_session_id)?;
    validate_safe_id("expected goalRequestId", expected_goal_request_id)?;
    validate_safe_id("expected architectRequestId", expected_architect_request_id)?;

    let value: serde_json::Value = serde_json::from_str(raw.trim()).map_err(|error| {
        ArchitectOutcomeContractError::new(format!(
            "architect outcome transport is not valid JSON: {error}"
        ))
    })?;
    validate_exact_json_shapes(&value)?;

    let mut transport: ArchitectOutcomeTransportV1 =
        serde_json::from_value(value).map_err(|error| {
            ArchitectOutcomeContractError::new(format!(
                "architect outcome transport does not match schema v1: {error}"
            ))
        })?;
    validate_and_normalize_transport(
        &mut transport,
        expected_session_id,
        expected_goal_request_id,
        expected_architect_request_id,
    )?;
    Ok(transport)
}

pub(super) fn validate_safe_id(
    label: &'static str,
    value: &str,
) -> Result<(), ArchitectOutcomeContractError> {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(ArchitectOutcomeContractError::new(format!(
            "{label} is not a safe correlation id"
        )));
    };
    let valid = value.encode_utf16().count() <= MAX_CORRELATION_ID_CHARS
        && first.is_ascii_alphanumeric()
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        });
    if !valid {
        return Err(ArchitectOutcomeContractError::new(format!(
            "{label} is not a safe correlation id"
        )));
    }
    Ok(())
}

fn validate_exact_json_shapes(
    value: &serde_json::Value,
) -> Result<(), ArchitectOutcomeContractError> {
    exact_keys(
        value,
        "architect outcome transport",
        &[
            "schemaVersion",
            "sessionId",
            "goalRequestId",
            "architectRequestId",
            "outcome",
        ],
    )?;
    let outcome = value.get("outcome").expect("exact_keys checked outcome");
    exact_keys(
        outcome,
        "architect outcome",
        &[
            "schemaVersion",
            "kind",
            "message",
            "questions",
            "evidence",
            "decisionDocument",
        ],
    )?;

    let questions = outcome
        .get("questions")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            ArchitectOutcomeContractError::new("architect questions must be an array")
        })?;
    for question in questions {
        let object = question.as_object().ok_or_else(|| {
            ArchitectOutcomeContractError::new("architect question must be an object")
        })?;
        let keys = if object.contains_key("reason") {
            &["id", "text", "reason"][..]
        } else {
            &["id", "text"][..]
        };
        exact_keys(question, "architect question", keys)?;
        if object.contains_key("reason")
            && !object
                .get("reason")
                .is_some_and(serde_json::Value::is_string)
        {
            return Err(ArchitectOutcomeContractError::new(
                "architect question reason must be a string when present",
            ));
        }
    }

    let evidence = outcome
        .get("evidence")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ArchitectOutcomeContractError::new("architect evidence must be an array"))?;
    for entry in evidence {
        exact_keys(entry, "architect evidence", &["path", "line", "fact"])?;
    }
    Ok(())
}

fn exact_keys(
    value: &serde_json::Value,
    label: &str,
    expected: &[&str],
) -> Result<(), ArchitectOutcomeContractError> {
    let object = value
        .as_object()
        .ok_or_else(|| ArchitectOutcomeContractError::new(format!("{label} must be an object")))?;
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(ArchitectOutcomeContractError::new(format!(
            "{label} must use the exact v1 shape"
        )));
    }
    Ok(())
}

fn validate_and_normalize_transport(
    transport: &mut ArchitectOutcomeTransportV1,
    expected_session_id: &str,
    expected_goal_request_id: &str,
    expected_architect_request_id: &str,
) -> Result<(), ArchitectOutcomeContractError> {
    if transport.schema_version != ARCHITECT_OUTCOME_SCHEMA_VERSION {
        return Err(ArchitectOutcomeContractError::new(
            "unsupported architect outcome transport schemaVersion",
        ));
    }
    validate_safe_id("sessionId", &transport.session_id)?;
    validate_safe_id("goalRequestId", &transport.goal_request_id)?;
    validate_safe_id("architectRequestId", &transport.architect_request_id)?;
    require_correlation("sessionId", expected_session_id, &transport.session_id)?;
    require_correlation(
        "goalRequestId",
        expected_goal_request_id,
        &transport.goal_request_id,
    )?;
    require_correlation(
        "architectRequestId",
        expected_architect_request_id,
        &transport.architect_request_id,
    )?;
    validate_and_normalize_outcome(&mut transport.outcome)
}

fn require_correlation(
    label: &str,
    expected: &str,
    actual: &str,
) -> Result<(), ArchitectOutcomeContractError> {
    if expected != actual {
        return Err(ArchitectOutcomeContractError::new(format!(
            "architect outcome {label} {actual:?} does not match trusted {expected:?}"
        )));
    }
    Ok(())
}

fn validate_and_normalize_outcome(
    outcome: &mut ArchitectOutcomeV1,
) -> Result<(), ArchitectOutcomeContractError> {
    if outcome.schema_version != ARCHITECT_OUTCOME_SCHEMA_VERSION {
        return Err(ArchitectOutcomeContractError::new(
            "unsupported architect outcome schemaVersion",
        ));
    }
    outcome.message = normalized_text(
        "architect message",
        std::mem::take(&mut outcome.message),
        MAX_MESSAGE_CHARS,
    )?;

    if outcome.questions.len() > MAX_QUESTIONS {
        return Err(ArchitectOutcomeContractError::new(format!(
            "architect questions must contain at most {MAX_QUESTIONS} entries"
        )));
    }
    let mut question_ids = BTreeSet::new();
    for question in &mut outcome.questions {
        validate_safe_id("architect question id", &question.id)?;
        if !question_ids.insert(question.id.clone()) {
            return Err(ArchitectOutcomeContractError::new(
                "architect question ids must be unique",
            ));
        }
        question.text = normalized_text(
            "architect question text",
            std::mem::take(&mut question.text),
            MAX_QUESTION_TEXT_CHARS,
        )?;
        if let Some(reason) = question.reason.take() {
            question.reason = Some(normalized_text(
                "architect question reason",
                reason,
                MAX_QUESTION_REASON_CHARS,
            )?);
        }
    }

    if outcome.evidence.len() > MAX_EVIDENCE {
        return Err(ArchitectOutcomeContractError::new(format!(
            "architect evidence must contain at most {MAX_EVIDENCE} entries"
        )));
    }
    let mut evidence_entries = BTreeSet::new();
    for evidence in &mut outcome.evidence {
        evidence.path = normalized_text(
            "architect evidence path",
            std::mem::take(&mut evidence.path),
            MAX_EVIDENCE_PATH_CHARS,
        )?;
        validate_relative_path(&evidence.path)?;
        if evidence
            .line
            .is_some_and(|line| line == 0 || line > MAX_LINE_NUMBER)
        {
            return Err(ArchitectOutcomeContractError::new(
                "architect evidence line must be null or a positive bounded integer",
            ));
        }
        evidence.fact = normalized_text(
            "architect evidence fact",
            std::mem::take(&mut evidence.fact),
            MAX_EVIDENCE_FACT_CHARS,
        )?;
        if !evidence_entries.insert((evidence.path.clone(), evidence.line, evidence.fact.clone())) {
            return Err(ArchitectOutcomeContractError::new(
                "architect evidence entries must be unique",
            ));
        }
    }

    match outcome.kind {
        ArchitectOutcomeKindV1::Ready => {
            if !outcome.questions.is_empty() || !outcome.evidence.is_empty() {
                return Err(ArchitectOutcomeContractError::new(
                    "ready architect outcome requires empty questions and evidence",
                ));
            }
            let document = outcome.decision_document.take().ok_or_else(|| {
                ArchitectOutcomeContractError::new(
                    "ready architect outcome requires decisionDocument",
                )
            })?;
            let document = normalized_text(
                "architect decisionDocument",
                document,
                MAX_DECISION_DOCUMENT_CHARS,
            )?;
            validate_architecture_document(&document)?;
            outcome.decision_document = Some(document);
        }
        ArchitectOutcomeKindV1::NeedsInput => {
            if outcome.decision_document.is_some() {
                return Err(ArchitectOutcomeContractError::new(
                    "needsInput architect outcome requires decisionDocument null",
                ));
            }
            if !(1..=MAX_QUESTIONS).contains(&outcome.questions.len()) {
                return Err(ArchitectOutcomeContractError::new(
                    "needsInput architect outcome requires 1-3 questions",
                ));
            }
            if outcome.evidence.is_empty() {
                return Err(ArchitectOutcomeContractError::new(
                    "needsInput architect outcome requires repository evidence",
                ));
            }
        }
    }
    Ok(())
}

fn normalized_text(
    label: &str,
    value: String,
    maximum: usize,
) -> Result<String, ArchitectOutcomeContractError> {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.trim().to_string();
    let unsafe_control = normalized.chars().any(
        |character| matches!(character as u32, 0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f),
    );
    if normalized.is_empty() || normalized.encode_utf16().count() > maximum || unsafe_control {
        return Err(ArchitectOutcomeContractError::new(format!(
            "{label} is empty, too long, or unsafe"
        )));
    }
    Ok(normalized)
}

fn validate_relative_path(path: &str) -> Result<(), ArchitectOutcomeContractError> {
    let bytes = path.as_bytes();
    let has_drive_prefix = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let invalid_segment = path
        .split('/')
        .any(|segment| segment.is_empty() || matches!(segment, "." | ".."));
    if path.starts_with('/')
        || path.starts_with('\\')
        || has_drive_prefix
        || path.contains('\\')
        || invalid_segment
    {
        return Err(ArchitectOutcomeContractError::new(
            "architect evidence path must be a portable project-relative path",
        ));
    }
    Ok(())
}

fn validate_architecture_document(document: &str) -> Result<(), ArchitectOutcomeContractError> {
    let lines: Vec<&str> = document.lines().collect();
    let has_adr = lines.iter().any(|line| {
        let Some(rest) = line.strip_prefix("## ADR-") else {
            return false;
        };
        let bytes = rest.as_bytes();
        bytes.len() > 5 && bytes[..3].iter().all(u8::is_ascii_digit) && &bytes[3..5] == b": "
    });
    let has_fields = ["Status", "Context", "Decision", "Consequences"]
        .iter()
        .all(|field| {
            let prefix = format!("**{field}:**");
            lines.iter().any(|line| line.starts_with(&prefix))
        });
    let trivial = lines
        .iter()
        .any(|line| *line == "## ADR-001: No cross-cutting decisions needed");
    let has_existing_context = lines.iter().any(|line| *line == "## Existing context");
    if !has_adr || !has_fields || (!trivial && !has_existing_context) {
        return Err(ArchitectOutcomeContractError::new(
            "ready architect outcome requires a valid ADR decisionDocument",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const READY_DOCUMENT: &str = "## Existing context\nObserved repository.\n\n## ADR-001: Keep the existing boundary\n**Status:** Accepted\n**Context:** Existing code uses it.\n**Decision:** Keep it.\n**Consequences:** Tests cover it.";

    fn transport(outcome: serde_json::Value) -> String {
        serde_json::json!({
            "schemaVersion": 1,
            "sessionId": "session-1",
            "goalRequestId": "goal-1",
            "architectRequestId": "architect-1",
            "outcome": outcome,
        })
        .to_string()
    }

    fn parse(raw: &str) -> Result<ArchitectOutcomeTransportV1, ArchitectOutcomeContractError> {
        parse_architect_outcome_transport_v1(raw, "session-1", "goal-1", "architect-1")
    }

    #[test]
    fn parses_ready_and_needs_input_outcomes() {
        let ready = parse(&transport(serde_json::json!({
            "schemaVersion": 1,
            "kind": "ready",
            "message": " Planning may proceed. ",
            "questions": [],
            "evidence": [],
            "decisionDocument": READY_DOCUMENT,
        })))
        .unwrap();
        assert_eq!(ready.outcome.kind, ArchitectOutcomeKindV1::Ready);
        assert_eq!(ready.outcome.message, "Planning may proceed.");
        assert_eq!(
            ready.outcome.decision_document.as_deref(),
            Some(READY_DOCUMENT)
        );

        let needs_input = parse(&transport(serde_json::json!({
            "schemaVersion": 1,
            "kind": "needsInput",
            "message": "A compatibility choice is required.",
            "questions": [{"id":"q1","text":"Which API?","reason":"Both exist."}],
            "evidence": [{"path":"src/api.rs","line":12,"fact":"Two APIs are exported."}],
            "decisionDocument": null,
        })))
        .unwrap();
        assert_eq!(needs_input.outcome.kind, ArchitectOutcomeKindV1::NeedsInput);
        assert_eq!(needs_input.outcome.questions.len(), 1);
        assert_eq!(needs_input.outcome.evidence[0].line, Some(12));
    }

    #[test]
    fn rejects_unknown_missing_and_wrong_discriminator_shapes() {
        let mut unknown: serde_json::Value = serde_json::from_str(&transport(serde_json::json!({
            "schemaVersion": 1,
            "kind": "ready",
            "message": "Ready.",
            "questions": [],
            "evidence": [],
            "decisionDocument": READY_DOCUMENT,
        })))
        .unwrap();
        unknown["extra"] = serde_json::json!(true);
        assert!(parse(&unknown.to_string()).is_err());

        let missing = transport(serde_json::json!({
            "schemaVersion": 1,
            "kind": "needsInput",
            "message": "Choose.",
            "questions": [{"id":"q1","text":"Which?"}],
            "evidence": [{"path":"src/lib.rs","line":null,"fact":"Two options exist."}]
        }));
        assert!(parse(&missing).is_err());

        let ready_with_questions = transport(serde_json::json!({
            "schemaVersion": 1,
            "kind": "ready",
            "message": "Ready.",
            "questions": [{"id":"q1","text":"Which?"}],
            "evidence": [],
            "decisionDocument": READY_DOCUMENT,
        }));
        assert!(parse(&ready_with_questions).is_err());

        let needs_document = transport(serde_json::json!({
            "schemaVersion": 1,
            "kind": "needsInput",
            "message": "Choose.",
            "questions": [{"id":"q1","text":"Which?"}],
            "evidence": [{"path":"src/lib.rs","line":null,"fact":"Two options exist."}],
            "decisionDocument": READY_DOCUMENT,
        }));
        assert!(parse(&needs_document).is_err());
    }

    #[test]
    fn rejects_correlation_replays_and_unsafe_ids() {
        let raw = transport(serde_json::json!({
            "schemaVersion": 1,
            "kind": "ready",
            "message": "Ready.",
            "questions": [],
            "evidence": [],
            "decisionDocument": READY_DOCUMENT,
        }));
        assert!(parse_architect_outcome_transport_v1(
            &raw,
            "different-session",
            "goal-1",
            "architect-1"
        )
        .is_err());
        assert!(parse_architect_outcome_transport_v1(
            &raw,
            "session-1",
            "../unsafe",
            "architect-1"
        )
        .is_err());
    }

    #[test]
    fn enforces_question_evidence_path_line_text_and_duplicate_bounds() {
        let duplicate_questions = transport(serde_json::json!({
            "schemaVersion": 1,
            "kind": "needsInput",
            "message": "Choose.",
            "questions": [
                {"id":"q1","text":"First?"},
                {"id":"q1","text":"Second?"}
            ],
            "evidence": [{"path":"src/lib.rs","line":1,"fact":"Two options exist."}],
            "decisionDocument": null,
        }));
        assert!(parse(&duplicate_questions).is_err());

        for path in [
            "/etc/passwd",
            "../secret",
            "src/../secret",
            "C:/secret",
            "src\\lib.rs",
        ] {
            let unsafe_path = transport(serde_json::json!({
                "schemaVersion": 1,
                "kind": "needsInput",
                "message": "Choose.",
                "questions": [{"id":"q1","text":"Which?"}],
                "evidence": [{"path":path,"line":1,"fact":"Two options exist."}],
                "decisionDocument": null,
            }));
            assert!(parse(&unsafe_path).is_err(), "accepted {path:?}");
        }

        for line in [0, 10_000_001] {
            let unsafe_line = transport(serde_json::json!({
                "schemaVersion": 1,
                "kind": "needsInput",
                "message": "Choose.",
                "questions": [{"id":"q1","text":"Which?"}],
                "evidence": [{"path":"src/lib.rs","line":line,"fact":"Two options exist."}],
                "decisionDocument": null,
            }));
            assert!(parse(&unsafe_line).is_err());
        }

        let evidence = serde_json::json!({"path":"src/lib.rs","line":1,"fact":"Same."});
        let duplicate_evidence = transport(serde_json::json!({
            "schemaVersion": 1,
            "kind": "needsInput",
            "message": "Choose.",
            "questions": [{"id":"q1","text":"Which?"}],
            "evidence": [evidence.clone(), evidence],
            "decisionDocument": null,
        }));
        assert!(parse(&duplicate_evidence).is_err());

        let unsafe_control = transport(serde_json::json!({
            "schemaVersion": 1,
            "kind": "needsInput",
            "message": "Choose.\u{0000}",
            "questions": [{"id":"q1","text":"Which?"}],
            "evidence": [{"path":"src/lib.rs","line":null,"fact":"Two options exist."}],
            "decisionDocument": null,
        }));
        assert!(parse(&unsafe_control).is_err());
    }

    #[test]
    fn enforces_wire_and_utf16_text_bounds() {
        let oversized = " ".repeat(MAX_ARCHITECT_OUTCOME_BYTES + 1);
        assert!(parse(&oversized).is_err());

        // One non-BMP scalar consumes two JavaScript/Rust UTF-16 code units.
        let too_long = "🚀".repeat(MAX_QUESTION_TEXT_CHARS / 2 + 1);
        let raw = transport(serde_json::json!({
            "schemaVersion": 1,
            "kind": "needsInput",
            "message": "Choose.",
            "questions": [{"id":"q1","text":too_long}],
            "evidence": [{"path":"src/lib.rs","line":null,"fact":"Two options exist."}],
            "decisionDocument": null,
        }));
        assert!(parse(&raw).is_err());
    }
}
