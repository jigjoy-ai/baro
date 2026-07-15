//! Durable conversation-session lifecycle integration for the TUI host.
//!
//! The conversation domain owns state-transition rules. This module connects
//! those rules to the application's PRD metadata, on-disk snapshots, and run
//! lifecycle without coupling the domain itself to the TUI `App`.

use std::path::{Path, PathBuf};

use crate::app::App;
use crate::conversation::{self, ConversationKind, ConversationPhase, ConversationWireResponse};
use crate::executor;

fn conversation_snapshot_path(repository_root: &Path, session_id: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    Some(
        home.join(".baro")
            .join("sessions")
            .join(repository_storage_key(repository_root))
            .join(format!("{session_id}.json")),
    )
}

fn repository_storage_key(repository_root: &Path) -> String {
    // Stable FNV-1a/128 over the canonical root supplied by run_app. The path
    // itself is not exposed in the session directory name, and snapshots from
    // another checkout cannot be selected by a copied PRD session id.
    const OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
    const PRIME: u128 = 0x0000000001000000000000000000013b;
    let mut hash = OFFSET;
    for byte in repository_root.as_os_str().to_string_lossy().as_bytes() {
        hash ^= u128::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:032x}")
}

pub(crate) fn persist_conversation(
    session: &conversation::ConversationSession,
    repository_root: &Path,
) {
    let Some(path) = conversation_snapshot_path(repository_root, session.session_id()) else {
        return;
    };
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            eprintln!("[baro] warning: could not create conversation session directory: {error}");
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(error) =
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            {
                eprintln!(
                    "[baro] warning: could not restrict conversation session directory: {error}"
                );
                return;
            }
        }
    }
    if let Err(error) = session.save_to_path(&path) {
        eprintln!("[baro] warning: could not persist conversation: {error}");
    }
}

pub(crate) fn attach_conversation_metadata(prd: &mut executor::PrdFile, app: &App) {
    let Some(goal_envelope) = app.conversation.goal_envelope() else {
        return;
    };
    prd.conversation_session_id = Some(app.conversation.session_id().to_string());
    prd.goal_envelope = Some(goal_envelope.clone());
}

pub(crate) fn restore_conversation_from_prd(
    app: &mut App,
    prd: &executor::PrdFile,
    repository_root: &Path,
) {
    let (session_id, goal_envelope) = match (
        prd.conversation_session_id.as_deref(),
        prd.goal_envelope.as_ref(),
    ) {
        (Some(session_id), Some(goal_envelope)) => {
            (session_id.to_string(), goal_envelope.clone())
        }
        (None, None) => {
            // PRDs created before conversation-first still need a valid
            // execution-phase owner. Reconstruct only the minimum bounded
            // intent already represented by the checkpoint; do not ask a
            // model to reinterpret or expand legacy scope during resume.
            (
                app.conversation.session_id().to_string(),
                legacy_goal_envelope(prd),
            )
        }
        _ => {
            eprintln!(
                "[baro] warning: incomplete conversation metadata in prd.json; runtime conversation remains disabled for this resume"
            );
            app.dialogue_enabled = false;
            return;
        }
    };

    // Validate before deriving a filesystem path from PRD-controlled data.
    if let Err(error) = conversation::ConversationSession::new(session_id.clone()) {
        eprintln!("[baro] warning: invalid conversation session id in prd.json: {error}");
        app.dialogue_enabled = false;
        return;
    }

    let restored = conversation_snapshot_path(repository_root, &session_id)
        .filter(|path| path.exists())
        .and_then(|path| match conversation::ConversationSession::load_from_path(&path) {
            Ok(mut session) if session.goal_envelope() == Some(&goal_envelope) => {
                match session.prepare_resume() {
                    Ok(()) => Some(session),
                    Err(error) => {
                        eprintln!(
                            "[baro] warning: conversation snapshot cannot resume: {error}; rebuilding from prd.json"
                        );
                        None
                    }
                }
            }
            Ok(_) => {
                eprintln!(
                    "[baro] warning: conversation snapshot does not match prd.json; rebuilding from the PRD"
                );
                None
            }
            Err(error) => {
                eprintln!(
                    "[baro] warning: conversation snapshot is invalid: {error}; rebuilding from prd.json"
                );
                None
            }
        })
        .or_else(|| rebuild_conversation_from_prd(&session_id, &goal_envelope).ok());

    if let Some(session) = restored {
        app.conversation = session;
        persist_conversation(&app.conversation, repository_root);
    } else {
        eprintln!(
            "[baro] warning: could not restore conversation metadata; execution remains legacy-compatible"
        );
        app.dialogue_enabled = false;
    }
}

fn legacy_goal_envelope(prd: &executor::PrdFile) -> conversation::GoalEnvelope {
    let objective_source = if prd.description.trim().is_empty() {
        format!("Resume the '{}' PRD checkpoint", prd.project.trim())
    } else {
        prd.description.trim().to_string()
    };
    let mut objective = objective_source.chars().take(8_000).collect::<String>();
    if objective.trim().is_empty() {
        objective = "Resume the existing PRD checkpoint".to_string();
    }
    conversation::GoalEnvelope {
        objective,
        constraints: vec![
            "Preserve the existing branch, completed stories, and durable PRD state.".to_string(),
        ],
        acceptance_criteria: vec![
            "Complete the remaining PRD stories and pass objective verification.".to_string(),
        ],
        non_goals: Vec::new(),
        assumptions: vec![
            "This goal was reconstructed from a legacy prd.json that predates conversation metadata."
                .to_string(),
        ],
    }
}

fn rebuild_conversation_from_prd(
    session_id: &str,
    goal_envelope: &conversation::GoalEnvelope,
) -> Result<conversation::ConversationSession, conversation::ConversationError> {
    let mut session = conversation::ConversationSession::new(session_id.to_string())?;
    let request_id = "prd-resume-goal";
    session.begin_request(request_id, goal_envelope.objective.clone())?;
    session.apply_response(ConversationWireResponse {
        schema_version: conversation::CONVERSATION_SCHEMA_VERSION,
        session_id: session_id.to_string(),
        request_id: request_id.to_string(),
        kind: ConversationKind::Ready,
        message: "Restored the accepted goal from prd.json.".to_string(),
        questions: Vec::new(),
        goal_envelope: Some(goal_envelope.clone()),
    })?;
    let _ = session.take_ready_handoff()?;
    session.transition_to(ConversationPhase::Planning)?;
    session.record_system_turn("Rebuilt the conversation session from durable PRD metadata.")?;
    Ok(session)
}

pub(crate) fn begin_conversation_execution(
    app: &mut App,
    repository_root: &Path,
) -> Result<(), String> {
    if app.conversation.goal_envelope().is_none() {
        return Ok(());
    }
    match app.conversation.phase() {
        ConversationPhase::Planning | ConversationPhase::Failed => app
            .conversation
            .transition_to(ConversationPhase::Executing)
            .map_err(|error| error.to_string())?,
        ConversationPhase::Executing => {}
        ConversationPhase::Verifying => {
            app.conversation
                .transition_to(ConversationPhase::Failed)
                .map_err(|error| error.to_string())?;
            app.conversation
                .transition_to(ConversationPhase::Executing)
                .map_err(|error| error.to_string())?;
        }
        phase => {
            return Err(format!(
                "conversation session cannot start execution from {phase:?}"
            ));
        }
    }
    app.conversation
        .record_system_turn("Plan accepted. The execution collective is starting.")
        .map_err(|error| error.to_string())?;
    persist_conversation(&app.conversation, repository_root);
    Ok(())
}

pub(crate) fn fail_conversation_run(app: &mut App, reason: &str, repository_root: &Path) {
    if app.conversation.goal_envelope().is_none() {
        return;
    }
    close_pending_runtime_conversation(app, "the run stopped before the reply arrived");
    let transition = match app.conversation.phase() {
        ConversationPhase::Planning
        | ConversationPhase::Executing
        | ConversationPhase::Verifying => app.conversation.transition_to(ConversationPhase::Failed),
        ConversationPhase::Failed | ConversationPhase::Completed => Ok(()),
        _ => return,
    };
    let status = format!("Run stopped: {}", bounded_status_text(reason));
    if let Err(error) = transition.and_then(|()| app.conversation.record_system_turn(status)) {
        app.conversation_error = Some(format!("conversation lifecycle error: {error}"));
    }
    persist_conversation(&app.conversation, repository_root);
}

pub(crate) fn finish_conversation_run(
    app: &mut App,
    received_done: bool,
    repository_root: &Path,
) {
    if app.conversation.goal_envelope().is_none() {
        return;
    }
    close_pending_runtime_conversation(app, "the run ended before the reply arrived");
    if !received_done {
        if !matches!(
            app.conversation.phase(),
            ConversationPhase::Completed | ConversationPhase::Failed
        ) {
            let reason = app
                .exit_reason
                .clone()
                .unwrap_or_else(|| "orchestrator exited without a final result".to_string());
            fail_conversation_run(app, &reason, repository_root);
        }
        return;
    }

    let result = (|| -> Result<(), conversation::ConversationError> {
        if app.conversation.phase() == ConversationPhase::Planning {
            app.conversation
                .transition_to(ConversationPhase::Executing)?;
        }
        if app.conversation.phase() == ConversationPhase::Executing {
            app.conversation
                .transition_to(ConversationPhase::Verifying)?;
        }
        if app.conversation.phase() != ConversationPhase::Verifying {
            return Ok(());
        }
        let successful =
            app.exit_reason.is_none() && app.verification_status.as_deref() != Some("failed");
        if successful {
            app.conversation
                .transition_to(ConversationPhase::Completed)?;
            let verification = app.verification_status.as_deref().unwrap_or("not reported");
            app.conversation.record_system_turn(format!(
                "Run completed in {}s. Objective verification: {verification}.",
                app.total_time_secs
            ))?;
        } else {
            app.conversation.transition_to(ConversationPhase::Failed)?;
            let reason = app
                .exit_reason
                .as_deref()
                .unwrap_or("objective verification failed");
            app.conversation
                .record_system_turn(format!("Run stopped: {}", bounded_status_text(reason)))?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        app.conversation_error = Some(format!("conversation lifecycle error: {error}"));
    }
    persist_conversation(&app.conversation, repository_root);
}

fn close_pending_runtime_conversation(app: &mut App, reason: &str) {
    let Some(request_id) = app.conversation.pending_request_id().map(str::to_string) else {
        return;
    };
    if let Err(error) = app
        .conversation
        .apply_runtime_failure(request_id, reason.to_string())
    {
        app.conversation_error = Some(format!(
            "could not close the pending conversation turn: {error}"
        ));
    }
}

fn bounded_status_text(value: &str) -> String {
    const MAX_STATUS_CHARS: usize = 4_000;
    let mut text = value.chars().take(MAX_STATUS_CHARS).collect::<String>();
    if value.chars().count() > MAX_STATUS_CHARS {
        text.push('…');
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_snapshots_are_namespaced_by_repository_root() {
        let first = repository_storage_key(Path::new("/workspace/first"));
        let second = repository_storage_key(Path::new("/workspace/second"));

        assert_ne!(first, second);
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn legacy_prd_rebuilds_a_valid_planning_phase_owner() {
        let prd = executor::PrdFile {
            project: "legacy-project".to_string(),
            branch_name: "baro/legacy".to_string(),
            description: "Finish the legacy checkpoint".to_string(),
            user_stories: Vec::new(),
            decision_document: None,
            execution_mode: None,
            runtime_graph: None,
            conversation_session_id: None,
            goal_envelope: None,
        };
        let envelope = legacy_goal_envelope(&prd);
        let session = rebuild_conversation_from_prd("session-legacy", &envelope).unwrap();
        assert_eq!(session.phase(), ConversationPhase::Planning);
        assert_eq!(session.goal_envelope(), Some(&envelope));
    }
}
