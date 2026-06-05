//! PRD types + a few helpers main.rs still calls.
//!
//! The real story execution now happens in the TypeScript Mozaik
//! orchestrator (`packages/baro-orchestrator/`); this module survives
//! only as the type surface that crosses the spawn-executor /
//! orchestrator-client boundary. Everything in here is plain data —
//! the legacy in-process executor that used to live alongside these
//! types is gone.

use std::path::Path;

use crate::app::ReviewStory;

// ─── PRD types (for reading/writing prd.json) ───────────────────────

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct PrdFile {
    pub project: String,
    #[serde(rename = "branchName", default)]
    pub branch_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "userStories")]
    pub user_stories: Vec<PrdStory>,
    /// Architect's DecisionDocument captured during planning. The TS
    /// orchestrator's Conductor prepends this to every story prompt as
    /// authoritative spec. Omitted entirely from JSON when None.
    #[serde(rename = "decisionDocument", default, skip_serializing_if = "Option::is_none")]
    pub decision_document: Option<String>,
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

// ─── Executor config (passed across the orchestrator boundary) ───────

/// Knobs that flow from CLI/UI through `spawn_executor` to the TS
/// orchestrator subprocess. The fields named after observers ("with_critic",
/// "with_librarian", "with_sentry") map to the orchestrator's CLI flags
/// (`--with-critic`, `--no-librarian`, `--no-sentry`).
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
    /// LLM provider — "claude" routes every phase through the Claude
    /// CLI (current behaviour); "openai" routes through Mozaik 3.9's
    /// native OpenAI participants. Plumbed through to orchestrate.ts
    /// as `--llm`; subsequent phases will use this to pick the right
    /// participant sibling per LLM-using role.
    pub llm: crate::app::LlmProvider,
    /// Per-phase overrides forwarded to orchestrate.ts as
    /// `--story-llm` / `--critic-llm` / `--surgeon-llm`. When equal
    /// to `llm`, the orchestrator treats them as "no override" and
    /// the global default flows. Used by the `--llm hybrid` preset
    /// to keep Story + Critic on a different backend than the rest.
    pub story_llm: crate::app::LlmProvider,
    pub critic_llm: crate::app::LlmProvider,
    pub surgeon_llm: crate::app::LlmProvider,
    /// OpenAI API key captured by the TUI (either from `OPENAI_API_KEY`
    /// in the shell env or typed into the ApiKeyInput screen). Forwarded
    /// to the orchestrator subprocess as an env var when `llm = OpenAI`.
    pub openai_api_key: Option<String>,
    /// Optional custom base URL for OpenAI-compatible API endpoints.
    /// Forwarded to the orchestrator subprocess as `OPENAI_BASE_URL`.
    pub openai_base_url: Option<String>,
    /// Effort level for spawned `claude` processes, forwarded as
    /// `--effort` to the orchestrator subprocess. Default "high".
    pub effort: String,
    /// Per-phase model override for StoryAgent. When set, overrides
    /// each story's individual `model` field in the PRD as well as
    /// the OpenAI default. `--architect-model` and `--planner-model`
    /// flow through their existing function-arg paths in spawn_planner
    /// and don't need an executor-side field.
    pub story_model: Option<String>,
    /// Per-story tier→backend:model map, forwarded to the orchestrator as
    /// `--tier-map`. Lets one DAG mix claude/openai/codex story-by-story.
    pub tier_map: Option<String>,
    /// Named OpenAI-compatible endpoints (`name=url`), forwarded as
    /// `--openai-endpoint`. Routes reference them via `openai:model@name`.
    pub openai_endpoints: Vec<String>,
    /// Skip `gh pr create` at end of run (from `--no-pr`). Pushed through
    /// to the orchestrator as `--no-pr`; branch creation + push are
    /// unaffected. Distinct from the orchestrator's `--no-git`.
    pub skip_pr: bool,
}

// ─── Helpers used by main.rs ────────────────────────────────────────

/// Build a PrdFile from the in-memory review-screen story list.
pub fn prd_from_review(
    project: &str,
    branch_name: &str,
    description: &str,
    stories: &[ReviewStory],
    decision_document: Option<String>,
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
    }
}

/// Write a PrdFile as `prd.json` inside `cwd`.
pub fn write_prd(prd: &PrdFile, cwd: &Path) -> std::io::Result<()> {
    let prd_path = cwd.join("prd.json");
    let content = serde_json::to_string_pretty(prd).map_err(std::io::Error::other)?;
    std::fs::write(prd_path, format!("{}\n", content))
}
