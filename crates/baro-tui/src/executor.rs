//! PRD types + a few helpers main.rs still calls. Story execution
//! happens in the TS orchestrator (`packages/baro-orchestrator/`);
//! this module is just the type surface crossing that boundary.

use std::path::Path;

use crate::app::ReviewStory;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct PrdFile {
    pub project: String,
    #[serde(rename = "branchName", default)]
    pub branch_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "userStories")]
    pub user_stories: Vec<PrdStory>,
    /// Architect's DecisionDocument; the TS Conductor prepends it to
    /// every story prompt as authoritative spec.
    #[serde(rename = "decisionDocument", default, skip_serializing_if = "Option::is_none")]
    pub decision_document: Option<String>,
    /// Planner-stamped ModeContract, opaque to Rust — round-tripped into
    /// prd.json for the orchestrator.
    #[serde(rename = "executionMode", default, skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct PrdStory {
    pub id: String,
    pub priority: i32,
    pub title: String,
    pub description: String,
    #[serde(rename = "dependsOn", default)]
    pub depends_on: Vec<String>,
    #[serde(default = "default_retries")]
    pub retries: u32,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub tests: Vec<String>,
    #[serde(default)]
    pub passes: bool,
    #[serde(rename = "completedAt", default)]
    pub completed_at: Option<String>,
    #[serde(rename = "durationSecs", default)]
    pub duration_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

fn default_retries() -> u32 {
    2
}

/// Knobs that flow from CLI/UI through `spawn_executor` to the TS
/// orchestrator subprocess. The `with_*` observer fields map to
/// mixed-polarity orchestrator flags (`--with-critic`,
/// `--no-librarian`, `--no-sentry`).
pub struct ExecutorConfig {
    pub parallel: u32,
    pub timeout_secs: u64,
    pub model_routing: bool,
    pub override_model: Option<String>,
    pub with_critic: bool,
    pub critic_model: Option<String>,
    pub with_librarian: bool,
    pub with_memory: bool,
    pub with_sentry: bool,
    pub with_surgeon: bool,
    pub surgeon_use_llm: bool,
    pub surgeon_model: Option<String>,
    pub intra_level_delay_secs: Option<u64>,
    /// Forwarded to orchestrate.ts as `--llm`.
    pub llm: crate::app::LlmProvider,
    /// Per-phase overrides forwarded as `--story-llm` / `--critic-llm`
    /// / `--surgeon-llm`. When equal to `llm` the orchestrator treats
    /// them as "no override" and the global default flows.
    pub story_llm: crate::app::LlmProvider,
    pub critic_llm: crate::app::LlmProvider,
    pub surgeon_llm: crate::app::LlmProvider,
    /// From `OPENAI_API_KEY` or the ApiKeyInput screen; passed to the
    /// subprocess env when `llm = OpenAI`.
    pub openai_api_key: Option<String>,
    /// Forwarded to the subprocess as `OPENAI_BASE_URL`.
    pub openai_base_url: Option<String>,
    /// Forwarded as `--effort`.
    pub effort: String,
    /// Story-model override; beats each story's own `model` field in
    /// the PRD.
    pub story_model: Option<String>,
    /// Per-story tier→backend:model map, forwarded as `--tier-map`.
    pub tier_map: Option<String>,
    /// Named OpenAI-compatible endpoints (`name=url`), forwarded as
    /// `--openai-endpoint`; routes reference them via `openai:model@name`.
    pub openai_endpoints: Vec<String>,
}

/// Build a PrdFile from the in-memory review-screen story list.
pub fn prd_from_review(
    project: &str,
    branch_name: &str,
    description: &str,
    stories: &[ReviewStory],
    decision_document: Option<String>,
    execution_mode: Option<serde_json::Value>,
) -> PrdFile {
    PrdFile {
        project: project.to_string(),
        branch_name: branch_name.to_string(),
        description: description.to_string(),
        user_stories: stories
            .iter()
            .enumerate()
            .map(|(i, s)| PrdStory {
                id: s.id.clone(),
                priority: (i + 1) as i32,
                title: s.title.clone(),
                description: s.description.clone(),
                depends_on: s.depends_on.clone(),
                retries: 2,
                acceptance: Vec::new(),
                tests: Vec::new(),
                passes: false,
                completed_at: None,
                duration_secs: None,
                model: s.model.clone(),
            })
            .collect(),
        decision_document,
        execution_mode,
    }
}

/// Write a PrdFile as `prd.json` inside `cwd`.
pub fn write_prd(prd: &PrdFile, cwd: &Path) -> std::io::Result<()> {
    let prd_path = cwd.join("prd.json");
    let content = serde_json::to_string_pretty(prd).map_err(std::io::Error::other)?;
    std::fs::write(prd_path, format!("{}\n", content))
}

#[cfg(test)]
mod tests {
    use super::PrdFile;

    #[test]
    fn execution_mode_round_trips() {
        let raw = r#"{"project":"p","branchName":"b","userStories":[],"executionMode":{"mode":"focused","maxStories":1,"source":"user"}}"#;
        let prd: PrdFile = serde_json::from_str(raw).unwrap();
        let out = serde_json::to_string(&prd).unwrap();
        assert!(out.contains(r#""executionMode":{"maxStories":1,"mode":"focused","source":"user"}"#));
    }
}
