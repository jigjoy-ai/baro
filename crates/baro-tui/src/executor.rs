//! PRD types + a few helpers main.rs still calls. Story execution
//! happens in the TS orchestrator (`packages/baro-orchestrator/`);
//! this module is just the type surface crossing that boundary.

use std::io::Write;
use std::path::Path;

use crate::app::ReviewStory;
use crate::conversation::{ConversationContextSnapshot, GoalEnvelope};

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
    #[serde(
        rename = "decisionDocument",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub decision_document: Option<String>,
    /// Planner-stamped ModeContract, opaque to Rust — round-tripped into
    /// prd.json for the orchestrator.
    #[serde(
        rename = "executionMode",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub execution_mode: Option<serde_json::Value>,
    /// Collective runtime DAG version, accounting and decision ledger. Rust
    /// does not interpret it, but must preserve it if a resumed PRD is ever
    /// serialized again.
    #[serde(
        rename = "runtimeGraph",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub runtime_graph: Option<serde_json::Value>,
    /// Stable identity of the user-facing conversation that owns this goal.
    /// This is deliberately distinct from per-attempt runtime/run ids.
    #[serde(
        rename = "conversationSessionId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub conversation_session_id: Option<String>,
    /// Validated intent handed from the conversation agent to planning. It is
    /// durable PRD metadata so a resume can recover the same session identity
    /// even if the local transcript snapshot is unavailable.
    #[serde(
        rename = "goalEnvelope",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub goal_envelope: Option<GoalEnvelope>,
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
    /// Ephemeral, accepted-goal context for the run-local DialogueAgent.
    /// This is handed to the child through a temporary file and is never
    /// written into the repository PRD.
    pub conversation_context: Option<ConversationContextSnapshot>,
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
        user_stories: stories.iter().map(prd_story_from_review).collect(),
        decision_document,
        execution_mode,
        runtime_graph: None,
        conversation_session_id: None,
        goal_envelope: None,
    }
}

/// Rebuild a resumed PRD from the refined Review state without allowing a
/// planner response to erase durable completion history. Completed stories
/// are immutable by id (and restored if the refiner omitted them); incomplete
/// stories may be edited, removed, or supplemented. Run-level opaque metadata
/// remains attached to the resumed branch.
pub fn prd_from_resume_review(
    original: &PrdFile,
    project: &str,
    description: &str,
    stories: &[ReviewStory],
    execution_mode: Option<serde_json::Value>,
) -> Result<PrdFile, String> {
    let mut seen = std::collections::HashSet::new();
    let mut merged = Vec::with_capacity(stories.len());
    let completed_ids: std::collections::HashSet<&str> = original
        .user_stories
        .iter()
        .filter(|story| story.passes)
        .map(|story| story.id.as_str())
        .collect();

    for story in stories {
        seen.insert(story.id.clone());
        if let Some(completed) = original
            .user_stories
            .iter()
            .find(|candidate| candidate.id == story.id && candidate.passes)
        {
            merged.push(completed.clone());
        } else {
            let mut pending = prd_story_from_review(story);
            // The resume refiner works on a pending-only DAG and therefore
            // treats dependencies on already-completed stories as satisfied.
            // Restore those historical edges for existing pending stories
            // before validating and persisting the complete graph.
            if let Some(original_pending) = original
                .user_stories
                .iter()
                .find(|candidate| candidate.id == story.id && !candidate.passes)
            {
                for dependency in &original_pending.depends_on {
                    if completed_ids.contains(dependency.as_str())
                        && !pending.depends_on.contains(dependency)
                    {
                        pending.depends_on.push(dependency.clone());
                    }
                }
            }
            merged.push(pending);
        }
    }
    for completed in original
        .user_stories
        .iter()
        .filter(|story| story.passes && !seen.contains(&story.id))
    {
        merged.push(completed.clone());
    }

    let prd = PrdFile {
        project: project.to_string(),
        branch_name: original.branch_name.clone(),
        description: description.to_string(),
        user_stories: merged,
        decision_document: original.decision_document.clone(),
        execution_mode: execution_mode.or_else(|| original.execution_mode.clone()),
        runtime_graph: original.runtime_graph.clone(),
        conversation_session_id: original.conversation_session_id.clone(),
        goal_envelope: original.goal_envelope.clone(),
    };
    validate_resume_prd(&prd)?;
    Ok(prd)
}

fn validate_resume_prd(prd: &PrdFile) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    for story in &prd.user_stories {
        if story.id.trim().is_empty() || story.id.trim() != story.id {
            return Err(format!(
                "resume PRD contains invalid story id {:?}",
                story.id
            ));
        }
        if !ids.insert(story.id.as_str()) {
            return Err(format!(
                "resume PRD contains duplicate story id '{}'",
                story.id
            ));
        }
        if !story.passes {
            if story.title.trim().is_empty() || story.description.trim().is_empty() {
                return Err(format!(
                    "pending story '{}' must have a non-empty title and description",
                    story.id
                ));
            }
            if story.acceptance.is_empty()
                || story.acceptance.iter().any(|item| item.trim().is_empty())
                || story.tests.is_empty()
                || story.tests.iter().any(|item| item.trim().is_empty())
            {
                return Err(format!(
                    "pending story '{}' must have non-empty acceptance criteria and tests",
                    story.id
                ));
            }
        }
    }

    let mut dependencies = std::collections::HashMap::new();
    for story in &prd.user_stories {
        let mut unique = std::collections::HashSet::new();
        for dependency in &story.depends_on {
            if dependency == &story.id {
                return Err(format!("story '{}' depends on itself", story.id));
            }
            if !ids.contains(dependency.as_str()) {
                return Err(format!(
                    "story '{}' depends on unknown story '{}'",
                    story.id, dependency
                ));
            }
            if !unique.insert(dependency.as_str()) {
                return Err(format!(
                    "story '{}' contains duplicate dependency '{}'",
                    story.id, dependency
                ));
            }
        }
        dependencies.insert(story.id.as_str(), story.depends_on.as_slice());
    }

    let mut completed = std::collections::HashSet::new();
    while completed.len() < dependencies.len() {
        let ready: Vec<&str> = dependencies
            .iter()
            .filter_map(|(id, story_dependencies)| {
                (!completed.contains(id)
                    && story_dependencies
                        .iter()
                        .all(|dependency| completed.contains(dependency.as_str())))
                .then_some(*id)
            })
            .collect();
        if ready.is_empty() {
            return Err("resume PRD dependency graph contains a cycle".to_string());
        }
        completed.extend(ready);
    }
    Ok(())
}

fn prd_story_from_review(story: &ReviewStory) -> PrdStory {
    PrdStory {
        id: story.id.clone(),
        priority: story.priority,
        title: story.title.clone(),
        description: story.description.clone(),
        depends_on: story.depends_on.clone(),
        retries: story.retries,
        acceptance: story.acceptance.clone(),
        tests: story.tests.clone(),
        passes: false,
        completed_at: None,
        duration_secs: None,
        model: story.model.clone(),
    }
}

/// Write a PrdFile as `prd.json` inside `cwd`.
pub fn write_prd(prd: &PrdFile, cwd: &Path) -> std::io::Result<()> {
    let prd_path = cwd.join("prd.json");
    let content = serde_json::to_string_pretty(prd).map_err(std::io::Error::other)?;
    let mut temporary = tempfile::NamedTempFile::new_in(cwd)?;
    temporary.write_all(format!("{}\n", content).as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(&prd_path).map_err(|error| error.error)?;
    // Rename durability requires syncing the containing directory on Unix.
    // Opening directories as files is not portable to Windows, where
    // NamedTempFile::persist still provides the same-directory replacement.
    #[cfg(unix)]
    std::fs::File::open(cwd)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{prd_from_resume_review, prd_from_review, write_prd, PrdFile};
    use crate::app::ReviewStory;
    use std::fs;

    #[test]
    fn execution_mode_round_trips() {
        let raw = r#"{"project":"p","branchName":"b","userStories":[],"executionMode":{"mode":"focused","maxStories":1,"source":"user"}}"#;
        let prd: PrdFile = serde_json::from_str(raw).unwrap();
        let out = serde_json::to_string(&prd).unwrap();
        assert!(
            out.contains(r#""executionMode":{"maxStories":1,"mode":"focused","source":"user"}"#)
        );
    }

    #[test]
    fn runtime_graph_round_trips_opaquely() {
        let raw = r#"{"project":"p","branchName":"b","userStories":[],"runtimeGraph":{"runId":"run-1","version":3,"dynamicStories":1,"policyStories":2,"appliedDecisions":[{"opaque":true}]}}"#;
        let prd: PrdFile = serde_json::from_str(raw).unwrap();
        let out = serde_json::to_value(&prd).unwrap();
        assert_eq!(
            out["runtimeGraph"],
            serde_json::json!({
                "runId": "run-1",
                "version": 3,
                "dynamicStories": 1,
                "policyStories": 2,
                "appliedDecisions": [{"opaque": true}],
            }),
        );
    }

    #[test]
    fn conversation_metadata_round_trips_with_the_prd() {
        let raw = serde_json::json!({
            "project": "p",
            "branchName": "baro/p",
            "description": "",
            "userStories": [],
            "conversationSessionId": "session-42",
            "goalEnvelope": {
                "objective": "Keep one durable conversation around the run",
                "constraints": ["Do not merge conversation authority into Board"],
                "acceptanceCriteria": ["Resume restores the same session id"],
                "nonGoals": [],
                "assumptions": ["The PRD is the durable run checkpoint"]
            }
        });
        let prd: PrdFile = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(prd.conversation_session_id.as_deref(), Some("session-42"));
        assert_eq!(serde_json::to_value(prd).unwrap(), raw);
    }

    #[test]
    fn review_story_metadata_is_preserved_in_prd() {
        let stories = vec![ReviewStory {
            id: "S7".to_string(),
            priority: 42,
            title: "Preserve the planner contract".to_string(),
            description: "Carry every execution field through review.".to_string(),
            depends_on: vec!["S3".to_string()],
            retries: 5,
            acceptance: vec![
                "Acceptance criteria reach the story agent".to_string(),
                "Priority remains unchanged".to_string(),
            ],
            tests: vec!["cargo test -p baro-tui".to_string()],
            completed: false,
            model: Some("heavy".to_string()),
        }];

        let prd = prd_from_review(
            "baro",
            "baro/metadata-roundtrip",
            "metadata regression",
            &stories,
            None,
            None,
        );

        let story = &prd.user_stories[0];
        assert_eq!(story.id, "S7");
        assert_eq!(story.priority, 42);
        assert_eq!(story.depends_on, ["S3"]);
        assert_eq!(story.retries, 5);
        assert_eq!(
            story.acceptance,
            [
                "Acceptance criteria reach the story agent",
                "Priority remains unchanged",
            ]
        );
        assert_eq!(story.tests, ["cargo test -p baro-tui"]);
        assert_eq!(story.model.as_deref(), Some("heavy"));
    }

    #[test]
    fn refined_resume_keeps_completed_history_and_opaque_runtime_state() {
        let original: PrdFile = serde_json::from_value(serde_json::json!({
            "project": "old",
            "branchName": "baro/existing",
            "description": "old description",
            "decisionDocument": "fixed architecture",
            "executionMode": { "mode": "parallel", "source": "user" },
            "runtimeGraph": {
                "runId": "prior-run",
                "version": 3,
                "dynamicStories": 1,
                "policyStories": 0,
                "appliedDecisions": []
            },
            "conversationSessionId": "session-resume",
            "goalEnvelope": {
                "objective": "Finish the pending work",
                "constraints": [],
                "acceptanceCriteria": ["All pending stories pass"],
                "nonGoals": [],
                "assumptions": []
            },
            "userStories": [
                {
                    "id": "S1", "priority": 1, "title": "Done",
                    "description": "already shipped", "dependsOn": [],
                    "retries": 2, "acceptance": ["done"], "tests": ["test S1"],
                    "passes": true, "completedAt": "2026-07-01T00:00:00Z",
                    "durationSecs": 12, "model": "heavy"
                },
                {
                    "id": "S2", "priority": 2, "title": "Old pending",
                    "description": "replace me", "dependsOn": ["S1"],
                    "retries": 2, "acceptance": ["old"], "tests": ["old test"],
                    "passes": false, "completedAt": null, "durationSecs": null,
                    "model": "standard"
                }
            ]
        }))
        .unwrap();
        let refined = vec![ReviewStory {
            id: "S3".into(),
            priority: 9,
            title: "New pending".into(),
            description: "replacement scope".into(),
            depends_on: vec!["S1".into()],
            retries: 3,
            acceptance: vec!["new behavior".into()],
            tests: vec!["cargo test".into()],
            completed: true, // untrusted planner output must not grant a pass
            model: Some("light".into()),
        }];

        let merged =
            prd_from_resume_review(&original, "refined", "refined description", &refined, None)
                .unwrap();
        assert_eq!(merged.branch_name, "baro/existing");
        assert_eq!(merged.user_stories.len(), 2);
        assert_eq!(merged.user_stories[0].id, "S3");
        assert!(!merged.user_stories[0].passes);
        assert_eq!(merged.user_stories[1].id, "S1");
        assert!(merged.user_stories[1].passes);
        assert_eq!(merged.user_stories[1].duration_secs, Some(12));
        assert_eq!(
            merged.decision_document.as_deref(),
            Some("fixed architecture")
        );
        assert_eq!(merged.execution_mode.as_ref().unwrap()["mode"], "parallel");
        assert_eq!(merged.runtime_graph.as_ref().unwrap()["version"], 3);
        assert_eq!(
            merged.conversation_session_id.as_deref(),
            Some("session-resume")
        );
        assert_eq!(
            merged.goal_envelope.as_ref().unwrap().objective,
            "Finish the pending work"
        );
    }

    #[test]
    fn resume_restores_completed_edges_and_rejects_invalid_union() {
        let original: PrdFile = serde_json::from_value(serde_json::json!({
            "project": "p",
            "branchName": "baro/p",
            "userStories": [
                {
                    "id": "S1", "priority": 1, "title": "Done",
                    "description": "done", "dependsOn": [], "retries": 2,
                    "acceptance": ["done"], "tests": ["test done"],
                    "passes": true
                },
                {
                    "id": "S2", "priority": 2, "title": "Pending",
                    "description": "pending", "dependsOn": ["S1"], "retries": 2,
                    "acceptance": ["pending"], "tests": ["test pending"],
                    "passes": false
                }
            ]
        }))
        .unwrap();
        let pending = ReviewStory {
            id: "S2".into(),
            priority: 2,
            title: "Refined pending".into(),
            description: "refined pending".into(),
            depends_on: vec![],
            retries: 2,
            acceptance: vec!["refined".into()],
            tests: vec!["test refined".into()],
            completed: false,
            model: Some("standard".into()),
        };

        let merged =
            prd_from_resume_review(&original, "p", "d", std::slice::from_ref(&pending), None)
                .unwrap();
        assert_eq!(merged.user_stories[0].depends_on, ["S1"]);

        let mut invalid = pending;
        invalid.depends_on = vec!["missing".into()];
        let error = prd_from_resume_review(&original, "p", "d", &[invalid], None).unwrap_err();
        assert!(error.contains("unknown story 'missing'"));
    }

    #[test]
    fn write_prd_atomically_replaces_the_snapshot_without_temp_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("prd.json"), "old truncated candidate").unwrap();
        let prd = prd_from_review(
            "atomic",
            "baro/atomic",
            "complete snapshot",
            &[],
            None,
            None,
        );

        write_prd(&prd, dir.path()).unwrap();

        let persisted: PrdFile =
            serde_json::from_str(&fs::read_to_string(dir.path().join("prd.json")).unwrap())
                .unwrap();
        assert_eq!(persisted.project, "atomic");
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            1,
            "temporary file must be removed after replacement"
        );
    }
}
