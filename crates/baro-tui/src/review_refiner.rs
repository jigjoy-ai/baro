//! Review-screen plan refinement and resume-state protection.
//!
//! Refinement deliberately reuses the same planner subprocess/routing as the
//! initial plan. This keeps provider selection, runnable-PRD validation, mode
//! enforcement, and JigJoy gateway routing identical across both paths.

use std::path::Path;

use tokio::sync::mpsc;

use crate::app::{App, ReviewStory};
use crate::{
    fixed_mode_contract, plan_event_sink, planner_runner, subprocess, AppEvent, PrdOutput,
};

pub(crate) fn spawn_refiner(
    app: &App,
    generation: u64,
    feedback: &str,
    cwd: &Path,
    tx: mpsc::Sender<AppEvent>,
) {
    let feedback = feedback.to_string();
    let cwd = cwd.to_path_buf();
    let model = app.model_for_phase("planning");
    let effort = app.effort.clone();
    let context = app.claude_md_content.clone();
    let decision_doc = app.decision_document.clone();
    let planner_llm = app.planner_llm;
    let openai_api_key = app.openai_api_key.clone();
    let openai_base_url = app.openai_base_url.clone();
    let quick = app.quick;
    let is_resume = app.is_resume;
    let mode_json = refinement_mode_contract(app);
    let plan = review_plan_json(app);
    let plan = serde_json::to_string_pretty(&plan).unwrap_or_default();

    tokio::spawn(async move {
        let goal = if is_resume {
            format!(
                "Refine only the pending portion of this resumed runnable PRD using the user's feedback. completedHistory is immutable, already satisfied context: do not emit those stories in userStories. Keep every pending story and field the user did not ask to change, preserve requirement coverage, and return the complete updated pending runnable PRD. Dependencies on completedHistory are already satisfied and are restored by Baro after validation.\n\nCURRENT PENDING PRD AND COMPLETED CONTEXT:\n{}\n\nUSER FEEDBACK:\n{}",
                plan, feedback,
            )
        } else {
            format!(
                "Refine the current runnable PRD using the user's feedback. Keep every story and field the user did not ask to change, preserve requirement coverage and the execution-mode contract, and return the complete updated runnable PRD.\n\nCURRENT PRD:\n{}\n\nUSER FEEDBACK:\n{}",
                plan, feedback,
            )
        };
        let result = planner_runner::run_planner(
            &goal,
            &cwd,
            planner_llm,
            model.as_deref(),
            context.as_deref(),
            decision_doc.as_deref(),
            quick,
            openai_api_key.as_deref(),
            openai_base_url.as_deref(),
            &effort,
            mode_json.as_deref(),
            plan_event_sink(false, tx.clone()),
        )
        .await
        .and_then(|raw_json| {
            let prd: PrdOutput = serde_json::from_str(&raw_json).map_err(|error| {
                let preview: String = raw_json.chars().take(500).collect();
                subprocess::ProcessRunError {
                    message: format!(
                        "Failed to parse refined PRD JSON: {}\nRaw (first 500 chars): {}",
                        error, preview,
                    ),
                    log_path: None,
                }
            })?;
            let stories = prd
                .user_stories
                .into_iter()
                .map(ReviewStory::from)
                .collect();
            Ok((
                stories,
                prd.project,
                prd.branch_name,
                prd.description,
                prd.execution_mode,
            ))
        });

        match result {
            Ok((stories, project, branch, description, execution_mode)) => {
                let _ = tx
                    .send(AppEvent::RefineReady(
                        generation,
                        stories,
                        project,
                        branch,
                        description,
                        execution_mode,
                    ))
                    .await;
            }
            Err(error) => {
                let _ = tx
                    .send(AppEvent::RefineError(generation, error.message))
                    .await;
            }
        }
    });
}

fn review_plan_json(app: &App) -> serde_json::Value {
    let completed_ids: std::collections::HashSet<&str> = app
        .review_stories
        .iter()
        .filter(|story| app.is_resume && story.completed)
        .map(|story| story.id.as_str())
        .collect();
    let stories: Vec<serde_json::Value> = app
        .review_stories
        .iter()
        .filter(|story| !app.is_resume || !story.completed)
        .map(|story| {
            let dependencies: Vec<&String> = story
                .depends_on
                .iter()
                .filter(|dependency| !completed_ids.contains(dependency.as_str()))
                .collect();
            serde_json::json!({
                "id": story.id,
                "priority": story.priority,
                "title": story.title,
                "description": story.description,
                "dependsOn": dependencies,
                "retries": story.retries,
                "acceptance": story.acceptance,
                "tests": story.tests,
                "passes": story.completed,
                "model": story.model,
            })
        })
        .collect();
    let completed_history: Vec<serde_json::Value> = app
        .review_stories
        .iter()
        .filter(|story| app.is_resume && story.completed)
        .map(|story| {
            serde_json::json!({
                "id": story.id,
                "title": story.title,
                "description": story.description,
                "acceptance": story.acceptance,
                "tests": story.tests,
                "passes": true,
            })
        })
        .collect();
    let mut plan = serde_json::json!({
        "project": app.project,
        "branchName": app.branch_name,
        "description": app.description,
        "userStories": stories,
        "executionMode": app.execution_mode,
    });
    if app.is_resume {
        plan["completedHistory"] = serde_json::Value::Array(completed_history);
    }
    plan
}

fn refinement_mode_contract(app: &App) -> Option<String> {
    let contract = app
        .execution_mode
        .as_ref()
        .and_then(|mode| serde_json::to_string(mode).ok())
        .or_else(|| fixed_mode_contract(app.quick, &app.mode));
    // A parallel run can legitimately have a one-story/serial tail after
    // earlier levels completed. The initial parallel-width invariant has
    // already done its job; applying it again to pending-only resume work
    // would reject a valid tail. The original executionMode remains immutable
    // in Rust and is restored when the pending plan is merged.
    if app.is_resume
        && contract.as_deref().is_some_and(|raw| {
            serde_json::from_str::<serde_json::Value>(raw)
                .ok()
                .and_then(|value| value.get("mode")?.as_str().map(str::to_owned))
                .as_deref()
                == Some("parallel")
        })
    {
        None
    } else {
        contract
    }
}

pub(crate) fn preserve_completed_review_stories(
    previous: &[ReviewStory],
    mut refined: Vec<ReviewStory>,
) -> Vec<ReviewStory> {
    let completed: Vec<&ReviewStory> = previous.iter().filter(|story| story.completed).collect();
    let mut seen = std::collections::HashSet::new();
    for story in &mut refined {
        seen.insert(story.id.clone());
        if let Some(original) = completed.iter().find(|item| item.id == story.id) {
            *story = (*original).clone();
        }
    }
    refined.extend(
        completed
            .into_iter()
            .filter(|story| !seen.contains(&story.id))
            .cloned(),
    );
    refined
}

#[cfg(test)]
mod tests {
    use super::{preserve_completed_review_stories, refinement_mode_contract, review_plan_json};
    use crate::app::{App, ReviewStory};

    fn story(id: &str, completed: bool) -> ReviewStory {
        ReviewStory {
            id: id.into(),
            priority: 17,
            title: format!("Story {id}"),
            description: "All execution fields survive refinement.".into(),
            depends_on: vec!["S0".into()],
            retries: 4,
            acceptance: vec!["Metadata remains observable".into()],
            tests: vec!["cargo test -p baro-tui".into()],
            completed,
            model: Some("heavy".into()),
        }
    }

    #[test]
    fn snapshot_preserves_runnable_story_metadata_and_mode() {
        let mut app = App::new();
        app.project = "Refine me".into();
        app.branch_name = "baro/refine-me".into();
        app.description = "Keep the complete contract".into();
        app.execution_mode = Some(serde_json::json!({
            "mode": "parallel",
            "confidence": 1,
            "reason": "operator selected",
            "parallelism": 4,
            "source": "user",
        }));
        app.review_stories.push(story("S7", false));

        let snapshot = review_plan_json(&app);
        let story = &snapshot["userStories"][0];
        assert_eq!(story["id"], "S7");
        assert_eq!(story["priority"], 17);
        assert_eq!(story["dependsOn"][0], "S0");
        assert_eq!(story["retries"], 4);
        assert_eq!(story["acceptance"][0], "Metadata remains observable");
        assert_eq!(story["tests"][0], "cargo test -p baro-tui");
        assert_eq!(story["model"], "heavy");
        assert_eq!(story["passes"], false);
        assert_eq!(snapshot["executionMode"]["mode"], "parallel");
    }

    #[test]
    fn resume_cannot_rewrite_or_drop_completed_stories() {
        let completed = story("S1", true);
        let mut forged_edit = completed.clone();
        forged_edit.title = "Planner rewrote completed work".into();
        forged_edit.completed = false;
        let pending = story("S2", false);

        let kept = preserve_completed_review_stories(
            &[completed.clone()],
            vec![forged_edit, pending.clone()],
        );
        assert_eq!(kept, vec![completed.clone(), pending]);

        let restored = preserve_completed_review_stories(&[completed.clone()], vec![]);
        assert_eq!(restored, vec![completed]);
    }

    #[test]
    fn resume_projection_only_enforces_mode_over_pending_work() {
        let mut app = App::new();
        app.is_resume = true;
        app.execution_mode = Some(serde_json::json!({
            "mode": "parallel",
            "reason": "original DAG was parallel",
            "source": "user",
        }));
        let completed = story("S1", true);
        let mut pending = story("S2", false);
        pending.depends_on = vec!["S1".into()];
        app.review_stories = vec![completed, pending];

        let projection = review_plan_json(&app);
        assert_eq!(projection["userStories"].as_array().unwrap().len(), 1);
        assert_eq!(projection["userStories"][0]["id"], "S2");
        assert_eq!(
            projection["userStories"][0]["dependsOn"],
            serde_json::json!([]),
        );
        assert_eq!(projection["completedHistory"][0]["id"], "S1");
        assert_eq!(refinement_mode_contract(&app), None);

        app.execution_mode = Some(serde_json::json!({
            "mode": "focused",
            "reason": "one pending repair",
            "source": "user",
            "maxStories": 1,
        }));
        assert!(refinement_mode_contract(&app).is_some());
    }
}
