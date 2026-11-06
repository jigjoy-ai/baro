//! A goal the intake confidently sizes as one focused change skips the Architect:
//! its job is aligning parallel stories, and a one-story run has none to align.
//! Critic and Surgeon still run; only the design pass is skipped.

const MIN_CONFIDENCE: f64 = 0.85;
const DISABLE_ENV: &str = "BARO_ARCHITECT_FAST_PATH";

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FastPath {
    pub(crate) contract_json: String,
    pub(crate) reason: String,
}

pub(crate) fn enabled() -> bool {
    enabled_with(std::env::var(DISABLE_ENV).ok().as_deref())
}

fn enabled_with(value: Option<&str>) -> bool {
    !matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("0" | "false" | "no" | "off")
    )
}

/// Only a model's own judgement qualifies: the heuristic fallback contract is
/// also "focused", and it is what a failed intake returns.
pub(crate) fn decide(contract_json: &str) -> Option<FastPath> {
    let contract: serde_json::Value = serde_json::from_str(contract_json).ok()?;
    let mode = contract.get("mode")?.as_str()?;
    let source = contract.get("source")?.as_str()?;
    let confidence = contract.get("confidence")?.as_f64()?;
    let max_stories = contract.get("maxStories")?.as_u64()?;
    if mode != "focused" || source != "llm" || confidence < MIN_CONFIDENCE || max_stories != 1 {
        return None;
    }
    let why = contract
        .get("reason")
        .and_then(|reason| reason.as_str())
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("one focused change");
    Some(FastPath {
        contract_json: contract_json.to_string(),
        reason: format!(
            "Intake sized this goal as one focused change (confidence {confidence:.2}): {why} Planning without an Architect pass; set {DISABLE_ENV}=0 to always run it."
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract(mode: &str, source: &str, confidence: f64, max_stories: Option<u64>) -> String {
        let mut value = serde_json::json!({
            "mode": mode,
            "confidence": confidence,
            "reason": "One route plus its tests.",
            "parallelism": 1,
            "source": source,
        });
        if let Some(max) = max_stories {
            value["maxStories"] = serde_json::json!(max);
        }
        value.to_string()
    }

    #[test]
    fn a_confident_single_story_llm_contract_takes_the_fast_path() {
        let json = contract("focused", "llm", 0.93, Some(1));
        let fast = decide(&json).expect("fast path");
        assert_eq!(fast.contract_json, json);
        assert!(fast.reason.contains("confidence 0.93"));
        assert!(fast.reason.contains("One route plus its tests."));
    }

    #[test]
    fn the_intake_fallback_never_skips_the_architect() {
        assert_eq!(decide(crate::intake_runner::FALLBACK_CONTRACT), None);
    }

    #[test]
    fn anything_less_than_a_confident_single_story_keeps_the_architect() {
        assert_eq!(decide(&contract("focused", "llm", 0.84, Some(1))), None);
        assert_eq!(decide(&contract("focused", "user", 1.0, Some(1))), None);
        assert_eq!(decide(&contract("focused", "llm", 0.95, Some(2))), None);
        assert_eq!(decide(&contract("focused", "llm", 0.95, None)), None);
        assert_eq!(decide(&contract("sequential", "llm", 0.95, Some(1))), None);
        assert_eq!(decide(&contract("parallel", "llm", 0.95, None)), None);
        assert_eq!(decide("not json"), None);
    }

    #[test]
    fn the_fast_path_can_be_turned_off() {
        assert!(enabled_with(None));
        assert!(enabled_with(Some("1")));
        assert!(!enabled_with(Some("0")));
        assert!(!enabled_with(Some(" OFF ")));
        assert!(!enabled_with(Some("false")));
    }
}
