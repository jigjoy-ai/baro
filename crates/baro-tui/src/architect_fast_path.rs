//! A goal the intake confidently sizes as one focused change skips the Architect:
//! its job is aligning parallel stories, and a one-story run has none to align.
//! A confident sequential goal runs the same way, as one story: its steps ran
//! one at a time anyway, and splitting the chain paid a handoff, a Critic loop
//! and a merge per step (a three-step refactor took 40 minutes against 15 for
//! one agent). A confident parallel goal of a few parts goes the same way:
//! planning it into stories took two to four times as long as one agent doing
//! all of it (three small modules: 358-675 s planned, 165 s by one agent), and
//! that agent may hand parts to forks of its own session when they are large.
//! Critic and Surgeon still run; only the design pass is skipped.

const MIN_CONFIDENCE: f64 = 0.85;
/// Longer chains keep the Architect: one agent's context should hold the whole goal.
const MAX_SEQUENTIAL_STEPS: u64 = 6;
/// The lead plus the stories it may add (`maxDynamicStories` in the orchestrator).
const MAX_LEAD_PARTS: u64 = 4;
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
    let max_stories = contract.get("maxStories").and_then(|value| value.as_u64());
    if source != "llm" || confidence < MIN_CONFIDENCE {
        return None;
    }
    let why = contract
        .get("reason")
        .and_then(|reason| reason.as_str())
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("one focused change");
    match mode {
        "focused" if max_stories == Some(1) => Some(FastPath {
            contract_json: contract_json.to_string(),
            reason: format!(
                "Intake sized this goal as one focused change (confidence {confidence:.2}): {why} Planning without an Architect pass; set {DISABLE_ENV}=0 to always run it."
            ),
        }),
        "sequential" if max_stories.map_or(true, |max| max <= MAX_SEQUENTIAL_STEPS) => {
            let mut focused = contract.clone();
            focused["mode"] = serde_json::json!("focused");
            focused["maxStories"] = serde_json::json!(1);
            focused["parallelism"] = serde_json::json!(1);
            focused["reason"] = serde_json::json!(format!(
                "Sequential steps, run by one agent in order: {why}"
            ));
            Some(FastPath {
                contract_json: focused.to_string(),
                reason: format!(
                    "Intake sized this goal as sequential steps (confidence {confidence:.2}): {why} One agent does them in order, without an Architect pass; set {DISABLE_ENV}=0 to always run it."
                ),
            })
        }
        "parallel" if max_stories.is_some_and(|max| max <= MAX_LEAD_PARTS) => {
            let mut focused = contract.clone();
            focused["mode"] = serde_json::json!("focused");
            focused["maxStories"] = serde_json::json!(1);
            focused["reason"] = serde_json::json!(format!(
                "A few independent parts, held by one agent that may hand them to parallel stories: {why}"
            ));
            Some(FastPath {
                contract_json: focused.to_string(),
                reason: format!(
                    "Intake sized this goal as a few parallel parts (confidence {confidence:.2}): {why} One agent starts at once and may hand parts to forks of its session, without an Architect pass; set {DISABLE_ENV}=0 to always run it."
                ),
            })
        }
        _ => None,
    }
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
        assert_eq!(decide("not json"), None);
    }

    #[test]
    fn a_confident_sequential_goal_runs_as_one_story_in_order() {
        let fast = decide(&contract("sequential", "llm", 0.9, Some(3))).expect("fast path");
        let focused: serde_json::Value = serde_json::from_str(&fast.contract_json).unwrap();
        assert_eq!(focused["mode"], "focused");
        assert_eq!(focused["maxStories"], 1);
        assert_eq!(focused["parallelism"], 1);
        assert_eq!(focused["source"], "llm");
        assert!(focused["reason"].as_str().unwrap().contains("One route plus its tests."));
        assert!(fast.reason.contains("sequential steps"));
        assert!(decide(&contract("sequential", "llm", 0.9, None)).is_some());
    }

    #[test]
    fn a_long_or_unsure_sequential_goal_keeps_the_architect() {
        assert_eq!(decide(&contract("sequential", "llm", 0.95, Some(7))), None);
        assert_eq!(decide(&contract("sequential", "llm", 0.8, Some(3))), None);
        assert_eq!(decide(&contract("sequential", "heuristic", 1.0, Some(3))), None);
    }

    #[test]
    fn a_confident_parallel_goal_of_a_few_parts_starts_with_one_lead() {
        let fast = decide(&contract("parallel", "llm", 0.9, Some(4))).expect("fast path");
        let lead: serde_json::Value = serde_json::from_str(&fast.contract_json).unwrap();
        assert_eq!(lead["mode"], "focused");
        assert_eq!(lead["maxStories"], 1);
        assert!(lead["reason"].as_str().unwrap().contains("may hand them to parallel stories"));
        assert!(fast.reason.contains("a few parallel parts"));
    }

    #[test]
    fn a_large_unsized_or_unsure_parallel_goal_is_planned() {
        assert_eq!(decide(&contract("parallel", "llm", 0.95, Some(5))), None);
        assert_eq!(decide(&contract("parallel", "llm", 0.95, None)), None);
        assert_eq!(decide(&contract("parallel", "llm", 0.8, Some(3))), None);
        assert_eq!(decide(&contract("parallel", "heuristic", 1.0, Some(3))), None);
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
