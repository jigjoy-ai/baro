//! Durable conversation-session lifecycle integration for the TUI host.
//!
//! The conversation domain owns state-transition rules. This module connects
//! those rules to the application's PRD metadata, on-disk snapshots, and run
//! lifecycle without coupling the domain itself to the TUI `App`.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::app::App;
use crate::conversation::{self, ConversationKind, ConversationPhase, ConversationWireResponse};
use crate::executor;

const ACTIVE_SESSION_FILE: &str = "active-session";
const MAX_ACTIVE_SESSION_BYTES: u64 = 256;

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
        return;
    }
    if let Some(directory) = path.parent() {
        if let Err(error) = write_active_session_index(directory, session.session_id()) {
            eprintln!("[baro] warning: could not persist active conversation index: {error}");
        }
    }
}

fn write_active_session_index(directory: &Path, session_id: &str) -> Result<(), String> {
    // Session ids have already passed the conversation contract. Keep the
    // index intentionally tiny and atomically replace it only after the full
    // snapshot has been persisted.
    if session_id.is_empty() || session_id.len() as u64 > MAX_ACTIVE_SESSION_BYTES {
        return Err("session id is outside active-index bounds".to_string());
    }
    let path = directory.join(ACTIVE_SESSION_FILE);
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("could not create temporary index: {error}"))?;
    temporary
        .write_all(session_id.as_bytes())
        .and_then(|()| temporary.write_all(b"\n"))
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| format!("could not write temporary index: {error}"))?;
    temporary
        .persist(&path)
        .map(|_| ())
        .map_err(|error| format!("could not replace active index: {}", error.error))
}

fn read_active_session_index(directory: &Path) -> Result<Option<String>, String> {
    let path = directory.join(ACTIVE_SESSION_FILE);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not inspect active index: {error}")),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_ACTIVE_SESSION_BYTES
    {
        return Err("active conversation index is not a bounded regular file".to_string());
    }
    let session_id = std::fs::read_to_string(&path)
        .map_err(|error| format!("could not read active index: {error}"))?
        .trim()
        .to_string();
    conversation::ConversationSession::new(session_id.clone())
        .map_err(|error| format!("active index has an invalid session id: {error}"))?;
    Ok(Some(session_id))
}

fn load_snapshot_no_follow(path: &Path) -> Result<conversation::ConversationSession, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect active snapshot: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("active conversation snapshot is not a regular file".to_string());
    }
    conversation::ConversationSession::load_from_path(path)
        .map_err(|error| format!("could not load active snapshot: {error}"))
}

fn restore_pre_prd_from_directory(app: &mut App, directory: &Path) -> Result<bool, String> {
    let Some(session_id) = read_active_session_index(directory)? else {
        return Ok(false);
    };
    let path = directory.join(format!("{session_id}.json"));
    let mut session = load_snapshot_no_follow(&path)?;
    if session.goal_envelope().is_some() {
        return Ok(false);
    }

    match (
        session.phase(),
        session.pending_request_id().map(str::to_string),
    ) {
        (ConversationPhase::NeedsInput | ConversationPhase::Clarifying, None) => {}
        (ConversationPhase::Clarifying, Some(request_id)) => {
            session
                .fail_pending_initial_request(
                    request_id,
                    "Baro restarted before this response completed. Retry the request.",
                )
                .map_err(|error| format!("could not reconcile interrupted request: {error}"))?;
        }
        _ => return Ok(false),
    }

    app.conversation = session;
    app.conversation_busy = false;
    Ok(true)
}

/// Restore only an unfinished pre-PRD conversation for this checkout. A new
/// explicit CLI goal deliberately starts a new session; the caller controls
/// that precedence. Interrupted provider turns are closed deterministically so
/// a late child result cannot consume a newly opened request after restart.
pub(crate) fn restore_pre_prd_conversation(app: &mut App, repository_root: &Path) -> bool {
    let Some(path) = conversation_snapshot_path(repository_root, app.conversation.session_id())
    else {
        return false;
    };
    let Some(directory) = path.parent() else {
        return false;
    };
    match restore_pre_prd_from_directory(app, directory) {
        Ok(true) => {
            persist_conversation(&app.conversation, repository_root);
            true
        }
        Ok(false) => false,
        Err(error) => {
            eprintln!("[baro] warning: could not restore active conversation: {error}");
            false
        }
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
        (Some(session_id), Some(goal_envelope)) => (session_id.to_string(), goal_envelope.clone()),
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

pub(crate) fn finish_conversation_run(app: &mut App, received_done: bool, repository_root: &Path) {
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

    fn save_active_fixture(directory: &Path, session: &conversation::ConversationSession) {
        session
            .save_to_path(&directory.join(format!("{}.json", session.session_id())))
            .unwrap();
        write_active_session_index(directory, session.session_id()).unwrap();
    }

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

    #[test]
    fn unfinished_clarification_resumes_from_the_repository_active_index() {
        let directory = tempfile::tempdir().unwrap();
        let mut session = conversation::ConversationSession::new("session-active").unwrap();
        session
            .begin_request("request-1", "Change the public API")
            .unwrap();
        session
            .apply_response(ConversationWireResponse {
                schema_version: conversation::CONVERSATION_SCHEMA_VERSION,
                session_id: "session-active".to_string(),
                request_id: "request-1".to_string(),
                kind: ConversationKind::Clarify,
                message: "One compatibility choice is still needed.".to_string(),
                questions: vec![conversation::ClarificationQuestion {
                    id: "q1".to_string(),
                    text: "Which API must remain compatible?".to_string(),
                    reason: None,
                }],
                goal_envelope: None,
            })
            .unwrap();
        save_active_fixture(directory.path(), &session);

        let mut app = App::new();
        assert!(restore_pre_prd_from_directory(&mut app, directory.path()).unwrap());
        assert_eq!(app.conversation.session_id(), "session-active");
        assert_eq!(app.conversation.phase(), ConversationPhase::NeedsInput);
        assert_eq!(app.conversation.pending_request_id(), None);
    }

    #[test]
    fn interrupted_pre_prd_turn_is_closed_before_a_retry_can_start() {
        let directory = tempfile::tempdir().unwrap();
        let mut session = conversation::ConversationSession::new("session-interrupted").unwrap();
        session
            .begin_request("request-old", "Inspect the repository")
            .unwrap();
        save_active_fixture(directory.path(), &session);

        let mut app = App::new();
        assert!(restore_pre_prd_from_directory(&mut app, directory.path()).unwrap());
        assert_eq!(app.conversation.pending_request_id(), None);
        assert!(app
            .conversation
            .transcript()
            .iter()
            .any(|turn| turn.text.contains("Baro restarted")));
        assert_eq!(
            app.conversation
                .apply_response(ConversationWireResponse {
                    schema_version: conversation::CONVERSATION_SCHEMA_VERSION,
                    session_id: "session-interrupted".to_string(),
                    request_id: "request-old".to_string(),
                    kind: ConversationKind::Answer,
                    message: "late result".to_string(),
                    questions: vec![],
                    goal_envelope: None,
                })
                .unwrap(),
            conversation::ApplyOutcome::Duplicate,
        );
        app.conversation
            .begin_request("request-new", "Retry the inspection")
            .unwrap();
        assert_eq!(app.conversation.pending_request_id(), Some("request-new"));
    }

    #[test]
    fn reconciled_pre_prd_turn_keeps_its_transcript_across_repeated_restarts() {
        let directory = tempfile::tempdir().unwrap();
        let mut session =
            conversation::ConversationSession::new("session-restarted-twice").unwrap();
        session
            .begin_request("request-interrupted", "Inspect the public protocol")
            .unwrap();
        save_active_fixture(directory.path(), &session);

        let mut first_restart = App::new();
        assert!(restore_pre_prd_from_directory(&mut first_restart, directory.path()).unwrap());
        assert_eq!(
            first_restart.conversation.phase(),
            ConversationPhase::Clarifying
        );
        assert_eq!(first_restart.conversation.pending_request_id(), None);
        let reconciled_transcript = first_restart.conversation.transcript().to_vec();
        assert!(reconciled_transcript
            .iter()
            .any(|turn| turn.text.contains("Baro restarted")));
        save_active_fixture(directory.path(), &first_restart.conversation);

        let mut second_restart = App::new();
        assert!(restore_pre_prd_from_directory(&mut second_restart, directory.path()).unwrap());
        assert_eq!(
            second_restart.conversation.phase(),
            ConversationPhase::Clarifying
        );
        assert_eq!(second_restart.conversation.pending_request_id(), None);
        assert_eq!(
            second_restart.conversation.transcript(),
            reconciled_transcript
        );
    }

    #[test]
    fn answered_pre_prd_chat_is_restored_without_inventing_a_pending_turn() {
        let directory = tempfile::tempdir().unwrap();
        let mut session = conversation::ConversationSession::new("session-chat").unwrap();
        session
            .begin_request("request-chat", "What does this repository contain?")
            .unwrap();
        session
            .apply_response(ConversationWireResponse {
                schema_version: conversation::CONVERSATION_SCHEMA_VERSION,
                session_id: "session-chat".to_string(),
                request_id: "request-chat".to_string(),
                kind: ConversationKind::Answer,
                message: "It contains the Rust TUI and TypeScript orchestrator.".to_string(),
                questions: vec![],
                goal_envelope: None,
            })
            .unwrap();
        save_active_fixture(directory.path(), &session);

        let mut app = App::new();
        assert!(restore_pre_prd_from_directory(&mut app, directory.path()).unwrap());
        assert_eq!(app.conversation.phase(), ConversationPhase::Clarifying);
        assert_eq!(app.conversation.pending_request_id(), None);
        assert_eq!(app.conversation.transcript(), session.transcript());
    }

    #[cfg(unix)]
    #[test]
    fn active_index_and_snapshot_must_be_regular_files() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_index = outside.path().join("index");
        std::fs::write(&outside_index, "session-linked\n").unwrap();
        symlink(&outside_index, directory.path().join(ACTIVE_SESSION_FILE)).unwrap();
        assert!(read_active_session_index(directory.path()).is_err());

        std::fs::remove_file(directory.path().join(ACTIVE_SESSION_FILE)).unwrap();
        write_active_session_index(directory.path(), "session-linked").unwrap();
        let outside_snapshot = outside.path().join("snapshot.json");
        let session = conversation::ConversationSession::new("session-linked").unwrap();
        session.save_to_path(&outside_snapshot).unwrap();
        symlink(
            &outside_snapshot,
            directory.path().join("session-linked.json"),
        )
        .unwrap();

        let mut app = App::new();
        assert!(restore_pre_prd_from_directory(&mut app, directory.path()).is_err());
    }
}
