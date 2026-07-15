use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::{ConversationError, ConversationPhase, MAX_MESSAGE_CHARS};

const MAX_WIRE_BYTES: usize = 128 * 1024;
const MAX_ID_CHARS: usize = 128;
const MAX_QUESTION_CHARS: usize = 1_000;
const MAX_REASON_CHARS: usize = 1_000;
const MAX_OBJECTIVE_CHARS: usize = 8_000;
const MAX_ENVELOPE_ITEM_CHARS: usize = 2_000;
const MAX_ENVELOPE_ITEMS: usize = 32;
const MAX_QUESTIONS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationKind {
    Ready,
    Clarify,
    Answer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClarificationQuestion {
    pub id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The normalized, reviewable contract handed to Architect/Planner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalEnvelope {
    pub objective: String,
    pub constraints: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    pub non_goals: Vec<String>,
    pub assumptions: Vec<String>,
}

/// Exact schema-v1 model/transport response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationWireResponse {
    pub schema_version: u8,
    pub session_id: String,
    pub request_id: String,
    pub kind: ConversationKind,
    pub message: String,
    pub questions: Vec<ClarificationQuestion>,
    pub goal_envelope: Option<GoalEnvelope>,
}

impl ConversationWireResponse {
    /// Parse an exact schema-v1 JSON object with a bounded input size.
    ///
    /// Unlike a bare serde call, this also requires all seven top-level keys,
    /// including `questions` and a present-but-null `goalEnvelope`.
    pub fn from_json(input: &str) -> Result<Self, ConversationError> {
        if input.len() > MAX_WIRE_BYTES {
            return Err(ConversationError::WireTooLarge {
                actual: input.len(),
                limit: MAX_WIRE_BYTES,
            });
        }
        let value: serde_json::Value = serde_json::from_str(input)
            .map_err(|error| ConversationError::InvalidJson(error.to_string()))?;
        let object = value.as_object().ok_or_else(|| {
            ConversationError::InvalidWireShape("top-level value must be an object".to_string())
        })?;
        const KEYS: [&str; 7] = [
            "schemaVersion",
            "sessionId",
            "requestId",
            "kind",
            "message",
            "questions",
            "goalEnvelope",
        ];
        if object.len() != KEYS.len() || KEYS.iter().any(|key| !object.contains_key(*key)) {
            return Err(ConversationError::InvalidWireShape(
                "response must contain exactly schemaVersion, sessionId, requestId, kind, message, questions, and goalEnvelope"
                    .to_string(),
            ));
        }
        serde_json::from_value(value)
            .map_err(|error| ConversationError::InvalidJson(error.to_string()))
    }

    #[cfg(test)]
    pub fn to_json_line(&self) -> Result<String, ConversationError> {
        let mut json = serde_json::to_string(self)
            .map_err(|error| ConversationError::InvalidJson(error.to_string()))?;
        json.push('\n');
        Ok(json)
    }
}

/// Deterministically render the only text handed to the existing planning
/// pipeline. No transcript or model prose is silently promoted into scope.
pub fn render_planning_prompt(envelope: &GoalEnvelope) -> Result<String, ConversationError> {
    validate_goal_envelope(envelope)?;
    let mut sections = vec![
        "Goal envelope (confirmed before planning)".to_string(),
        String::new(),
        "Objective:".to_string(),
        envelope.objective.trim().to_string(),
    ];
    push_prompt_list(&mut sections, "Constraints", &envelope.constraints);
    push_prompt_list(
        &mut sections,
        "Acceptance criteria",
        &envelope.acceptance_criteria,
    );
    push_prompt_list(&mut sections, "Non-goals", &envelope.non_goals);
    push_prompt_list(&mut sections, "Assumptions", &envelope.assumptions);
    Ok(sections.join("\n"))
}

fn push_prompt_list(output: &mut Vec<String>, title: &str, items: &[String]) {
    output.push(String::new());
    output.push(format!("{title}:"));
    if items.is_empty() {
        output.push("- (none specified)".to_string());
    } else {
        output.extend(items.iter().map(|item| format!("- {}", item.trim())));
    }
}

pub(super) fn validate_response(
    mut response: ConversationWireResponse,
    phase: ConversationPhase,
    already_ready: bool,
) -> Result<ConversationWireResponse, ConversationError> {
    response.message = normalized_text("message", response.message, MAX_MESSAGE_CHARS)?;
    if response.questions.len() > MAX_QUESTIONS {
        return Err(ConversationError::TooManyItems {
            field: "questions",
            actual: response.questions.len(),
            limit: MAX_QUESTIONS,
        });
    }
    let mut question_ids = BTreeSet::new();
    for question in &mut response.questions {
        validate_id("question.id", &question.id)?;
        if !question_ids.insert(question.id.clone()) {
            return Err(ConversationError::DuplicateItem {
                field: "questions.id",
                value: question.id.clone(),
            });
        }
        question.text = normalized_text(
            "question.text",
            std::mem::take(&mut question.text),
            MAX_QUESTION_CHARS,
        )?;
        if let Some(reason) = question.reason.take() {
            question.reason = Some(normalized_text(
                "question.reason",
                reason,
                MAX_REASON_CHARS,
            )?);
        }
    }

    match response.kind {
        ConversationKind::Ready => {
            if already_ready
                && !matches!(
                    phase,
                    ConversationPhase::Completed | ConversationPhase::Failed
                )
            {
                return Err(ConversationError::ReadyAlreadyAccepted);
            }
            if !matches!(
                phase,
                ConversationPhase::Clarifying
                    | ConversationPhase::NeedsInput
                    | ConversationPhase::Completed
                    | ConversationPhase::Failed
            ) {
                return Err(ConversationError::ResponseNotAllowedInPhase {
                    kind: response.kind,
                    phase,
                });
            }
            if !response.questions.is_empty() {
                return Err(ConversationError::InvalidWireShape(
                    "ready response must have an empty questions array".to_string(),
                ));
            }
            let envelope = response.goal_envelope.as_mut().ok_or_else(|| {
                ConversationError::InvalidWireShape(
                    "ready response requires goalEnvelope".to_string(),
                )
            })?;
            normalize_goal_envelope(envelope)?;
        }
        ConversationKind::Clarify => {
            if !matches!(
                phase,
                ConversationPhase::Clarifying
                    | ConversationPhase::NeedsInput
                    | ConversationPhase::Completed
                    | ConversationPhase::Failed
            ) {
                return Err(ConversationError::ResponseNotAllowedInPhase {
                    kind: response.kind,
                    phase,
                });
            }
            if response.questions.is_empty() {
                return Err(ConversationError::InvalidWireShape(
                    "clarify response requires at least one question".to_string(),
                ));
            }
            if response.goal_envelope.is_some() {
                return Err(ConversationError::InvalidWireShape(
                    "clarify response must set goalEnvelope to null".to_string(),
                ));
            }
        }
        ConversationKind::Answer => {
            if !matches!(
                phase,
                ConversationPhase::Clarifying
                    | ConversationPhase::NeedsInput
                    | ConversationPhase::Completed
                    | ConversationPhase::Failed
            ) {
                return Err(ConversationError::ResponseNotAllowedInPhase {
                    kind: response.kind,
                    phase,
                });
            }
            if !response.questions.is_empty() || response.goal_envelope.is_some() {
                return Err(ConversationError::InvalidWireShape(
                    "answer response requires empty questions and null goalEnvelope".to_string(),
                ));
            }
        }
    }
    Ok(response)
}

fn normalize_goal_envelope(envelope: &mut GoalEnvelope) -> Result<(), ConversationError> {
    envelope.objective = normalized_text(
        "goalEnvelope.objective",
        std::mem::take(&mut envelope.objective),
        MAX_OBJECTIVE_CHARS,
    )?;
    normalize_string_list("goalEnvelope.constraints", &mut envelope.constraints, true)?;
    normalize_string_list(
        "goalEnvelope.acceptanceCriteria",
        &mut envelope.acceptance_criteria,
        false,
    )?;
    normalize_string_list("goalEnvelope.nonGoals", &mut envelope.non_goals, true)?;
    normalize_string_list("goalEnvelope.assumptions", &mut envelope.assumptions, true)?;
    Ok(())
}

pub(super) fn validate_goal_envelope(envelope: &GoalEnvelope) -> Result<(), ConversationError> {
    validate_text(
        "goalEnvelope.objective",
        &envelope.objective,
        MAX_OBJECTIVE_CHARS,
    )?;
    validate_string_list("goalEnvelope.constraints", &envelope.constraints, true)?;
    validate_string_list(
        "goalEnvelope.acceptanceCriteria",
        &envelope.acceptance_criteria,
        false,
    )?;
    validate_string_list("goalEnvelope.nonGoals", &envelope.non_goals, true)?;
    validate_string_list("goalEnvelope.assumptions", &envelope.assumptions, true)?;
    Ok(())
}

fn normalize_string_list(
    field: &'static str,
    values: &mut Vec<String>,
    allow_empty: bool,
) -> Result<(), ConversationError> {
    validate_list_len(field, values, allow_empty)?;
    let mut seen = BTreeSet::new();
    for value in values.iter_mut() {
        *value = normalized_text(field, std::mem::take(value), MAX_ENVELOPE_ITEM_CHARS)?;
        if !seen.insert(value.clone()) {
            return Err(ConversationError::DuplicateItem {
                field,
                value: value.clone(),
            });
        }
    }
    Ok(())
}

fn validate_string_list(
    field: &'static str,
    values: &[String],
    allow_empty: bool,
) -> Result<(), ConversationError> {
    validate_list_len(field, values, allow_empty)?;
    let mut seen = BTreeSet::new();
    for value in values {
        validate_text(field, value, MAX_ENVELOPE_ITEM_CHARS)?;
        if !seen.insert(value) {
            return Err(ConversationError::DuplicateItem {
                field,
                value: value.clone(),
            });
        }
    }
    Ok(())
}

fn validate_list_len(
    field: &'static str,
    values: &[String],
    allow_empty: bool,
) -> Result<(), ConversationError> {
    if !allow_empty && values.is_empty() {
        return Err(ConversationError::MissingRequired(field));
    }
    if values.len() > MAX_ENVELOPE_ITEMS {
        return Err(ConversationError::TooManyItems {
            field,
            actual: values.len(),
            limit: MAX_ENVELOPE_ITEMS,
        });
    }
    Ok(())
}

pub(super) fn normalized_text(
    field: &'static str,
    value: String,
    max_chars: usize,
) -> Result<String, ConversationError> {
    let normalized = value.trim().to_string();
    validate_text(field, &normalized, max_chars)?;
    Ok(normalized)
}

pub(super) fn validate_text(
    field: &'static str,
    value: &str,
    max_chars: usize,
) -> Result<(), ConversationError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ConversationError::MissingRequired(field));
    }
    let chars = trimmed.chars().count();
    if chars > max_chars {
        return Err(ConversationError::TextTooLong {
            field,
            actual: chars,
            limit: max_chars,
        });
    }
    if trimmed
        .chars()
        .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        return Err(ConversationError::UnsafeControlCharacter(field));
    }
    Ok(())
}

pub(super) fn validate_id(field: &'static str, value: &str) -> Result<(), ConversationError> {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(ConversationError::InvalidId {
            field,
            value: value.to_string(),
        });
    };
    let valid = value.chars().count() <= MAX_ID_CHARS
        && first.is_ascii_alphanumeric()
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        });
    if !valid {
        return Err(ConversationError::InvalidId {
            field,
            value: value.to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn parses_and_serializes_the_exact_camel_case_wire_schema() {
        let raw = r#"{
            "schemaVersion":1,
            "sessionId":"session-1",
            "requestId":"request-1",
            "kind":"ready",
            "message":"This is clear.",
            "questions":[],
            "goalEnvelope":{
                "objective":"Implement it",
                "constraints":[],
                "acceptanceCriteria":["Tests pass"],
                "nonGoals":[],
                "assumptions":[]
            }
        }"#;
        let parsed = ConversationWireResponse::from_json(raw).unwrap();
        assert_eq!(parsed.kind, ConversationKind::Ready);
        assert_eq!(
            parsed.goal_envelope.unwrap().acceptance_criteria,
            vec!["Tests pass".to_string()]
        );

        let missing_nullable = raw.replace(
            ",\n            \"goalEnvelope\":{",
            ",\n            \"renamed\":{",
        );
        assert!(matches!(
            ConversationWireResponse::from_json(&missing_nullable),
            Err(ConversationError::InvalidWireShape(_))
        ));
        let unknown = raw.replace("\"message\":", "\"extra\":true,\"message\":");
        assert!(matches!(
            ConversationWireResponse::from_json(&unknown),
            Err(ConversationError::InvalidWireShape(_))
        ));
        assert!(ConversationWireResponse::from_json(raw)
            .unwrap()
            .to_json_line()
            .unwrap()
            .ends_with('\n'));
    }

    #[test]
    fn planning_prompt_contains_only_the_structured_envelope() {
        let rendered = render_planning_prompt(&envelope()).unwrap();
        assert_eq!(
            rendered,
            "Goal envelope (confirmed before planning)\n\n\
             Objective:\nAdd a conversation-first entry point\n\n\
             Constraints:\n- Keep Board authority separate\n\n\
             Acceptance criteria:\n- Ambiguous goals cause a question\n\n\
             Non-goals:\n- Do not change model routing\n\n\
             Assumptions:\n- The repository is already selected"
        );

        let mut no_acceptance = envelope();
        no_acceptance.acceptance_criteria.clear();
        assert!(render_planning_prompt(&no_acceptance).is_err());
    }
}
