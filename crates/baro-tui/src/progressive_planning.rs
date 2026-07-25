//! Opt-in bootstrap primitives for progressive planning.
//!
//! Nothing in this module changes process launch order. It only constructs the
//! empty, durable PRD that the opt-in headless collective path hands to the
//! orchestrator while the Planner continues producing fragments.

use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::conversation::GoalEnvelope;
use crate::executor::PrdFile;

pub(crate) const PROGRESSIVE_PLANNING_ENV: &str = "BARO_PROGRESSIVE_PLANNING";

const MAX_CONTROL_ID_CHARS: usize = 128;
const MAX_GOAL_CHARS: usize = 8_000;
const BRANCH_SLUG_CHARS: usize = 48;
static ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Explicitly gated compatibility predicate. Merely running headless or using
/// the collective does not change startup semantics; one of the flag/env
/// inputs must also opt in.
#[allow(dead_code)]
pub(crate) fn progressive_planning_enabled(
    headless: bool,
    coordination: &str,
    explicit_flag: bool,
) -> bool {
    let env_value = std::env::var(PROGRESSIVE_PLANNING_ENV).ok();
    progressive_planning_enabled_with_env(
        headless,
        coordination,
        explicit_flag,
        env_value.as_deref(),
    )
}

fn progressive_planning_enabled_with_env(
    headless: bool,
    coordination: &str,
    explicit_flag: bool,
    env_value: Option<&str>,
) -> bool {
    headless && coordination == "collective" && (explicit_flag || env_value.is_some_and(truthy_env))
}

fn truthy_env(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgressivePlanningIds {
    run_id: String,
    planning_id: String,
}

impl ProgressivePlanningIds {
    /// Accept externally supplied identities (for example a cloud run id) only
    /// through the same conservative control-plane character set used by the
    /// locally generated values.
    #[allow(dead_code)]
    pub(crate) fn new(
        run_id: impl Into<String>,
        planning_id: impl Into<String>,
    ) -> Result<Self, ProgressivePlanningBootstrapError> {
        let run_id = run_id.into();
        let planning_id = planning_id.into();
        validate_control_id("run_id", &run_id)?;
        validate_control_id("planning_id", &planning_id)?;
        if run_id == planning_id {
            return Err(ProgressivePlanningBootstrapError::InvalidId {
                field: "planning_id",
                reason: "must be distinct from run_id".to_string(),
            });
        }
        Ok(Self {
            run_id,
            planning_id,
        })
    }

    #[allow(dead_code)]
    pub(crate) fn generate() -> Self {
        let sequence = ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let nonce = stable_hash64(format!("{nanos}:{}:{sequence}", std::process::id()).as_bytes());
        Self {
            run_id: format!("run-progressive-{nonce:016x}"),
            planning_id: format!("planning-{nonce:016x}-{sequence:x}"),
        }
    }

    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }

    pub(crate) fn planning_id(&self) -> &str {
        &self.planning_id
    }
}

fn validate_control_id(
    field: &'static str,
    value: &str,
) -> Result<(), ProgressivePlanningBootstrapError> {
    if value.is_empty() || value.len() > MAX_CONTROL_ID_CHARS {
        return Err(ProgressivePlanningBootstrapError::InvalidId {
            field,
            reason: format!("must contain 1..={MAX_CONTROL_ID_CHARS} ASCII characters"),
        });
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(ProgressivePlanningBootstrapError::InvalidId {
            field,
            reason: "contains a character outside [A-Za-z0-9._:-]".to_string(),
        });
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgressiveBootstrapMetadata {
    pub project: String,
    pub branch_name: String,
    pub description: String,
}

/// Produce metadata before the final PRD exists. The final Planner response
/// must echo these values exactly, so this function has no wall-clock input.
#[allow(dead_code)]
pub(crate) fn deterministic_bootstrap_metadata(
    cwd: &Path,
    goal: &str,
) -> Result<ProgressiveBootstrapMetadata, ProgressivePlanningBootstrapError> {
    let description = normalize_goal(goal)?;
    let project = cwd
        .file_name()
        .map(|name| normalized_display(name.to_string_lossy().as_ref()))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "workspace".to_string());
    let branch_slug = {
        let goal_slug = ascii_slug(&description, BRANCH_SLUG_CHARS);
        if goal_slug.is_empty() {
            let project_slug = ascii_slug(&project, BRANCH_SLUG_CHARS);
            if project_slug.is_empty() {
                "progressive-plan".to_string()
            } else {
                project_slug
            }
        } else {
            goal_slug
        }
    };
    let mut hash_input = cwd.to_string_lossy().as_bytes().to_vec();
    hash_input.push(0);
    hash_input.extend_from_slice(description.as_bytes());
    let suffix = stable_hash64(&hash_input) as u32;

    Ok(ProgressiveBootstrapMetadata {
        project,
        branch_name: format!("baro/{branch_slug}-{suffix:08x}"),
        description,
    })
}

fn normalize_goal(goal: &str) -> Result<String, ProgressivePlanningBootstrapError> {
    let normalized = goal.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Err(ProgressivePlanningBootstrapError::InvalidGoal(
            "goal must be non-empty".to_string(),
        ));
    }
    if normalized.chars().count() > MAX_GOAL_CHARS {
        return Err(ProgressivePlanningBootstrapError::InvalidGoal(format!(
            "goal exceeds {MAX_GOAL_CHARS} characters"
        )));
    }
    Ok(normalized)
}

fn normalized_display(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn ascii_slug(value: &str, max_chars: usize) -> String {
    let mut slug = String::new();
    let mut pending_separator = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_separator && !slug.is_empty() && slug.len() < max_chars {
                slug.push('-');
            }
            pending_separator = false;
            if slug.len() >= max_chars {
                break;
            }
            slug.push(character.to_ascii_lowercase());
        } else {
            pending_separator = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}

fn stable_hash64(bytes: &[u8]) -> u64 {
    // Fixed FNV-1a constants: stable across Rust versions and processes.
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

pub(crate) struct ProgressiveBootstrapInput<'a> {
    pub cwd: &'a Path,
    pub goal: &'a str,
    pub ids: &'a ProgressivePlanningIds,
    pub decision_document: Option<&'a str>,
    pub execution_mode: Option<&'a Value>,
    pub conversation_session_id: Option<&'a str>,
    pub goal_envelope: Option<&'a GoalEnvelope>,
}

/// Build the empty PRD consumed by the collective Board while planning remains
/// open. The runtimeGraph value intentionally mirrors the TypeScript durable
/// schema rather than introducing a second Rust interpretation of it.
#[allow(dead_code)]
pub(crate) fn build_progressive_bootstrap_prd(
    input: ProgressiveBootstrapInput<'_>,
) -> Result<PrdFile, ProgressivePlanningBootstrapError> {
    validate_control_id("run_id", input.ids.run_id())?;
    validate_control_id("planning_id", input.ids.planning_id())?;
    if let Some(session_id) = input.conversation_session_id {
        if session_id.trim().is_empty() {
            return Err(ProgressivePlanningBootstrapError::InvalidId {
                field: "conversation_session_id",
                reason: "must be non-empty when present".to_string(),
            });
        }
    }
    let metadata = deterministic_bootstrap_metadata(input.cwd, input.goal)?;
    let runtime_graph = json!({
        "runId": input.ids.run_id(),
        "version": 1,
        "dynamicStories": 0,
        "policyStories": 0,
        "appliedDecisions": [],
        "planning": {
            "schemaVersion": 1,
            "runId": input.ids.run_id(),
            "planningId": input.ids.planning_id(),
            "status": "open",
            "nextOrdinal": 1,
            "admittedStoryIds": [],
            "fragments": []
        }
    });

    Ok(PrdFile {
        project: metadata.project,
        branch_name: metadata.branch_name,
        description: metadata.description,
        user_stories: Vec::new(),
        decision_document: input.decision_document.map(str::to_string),
        execution_mode: input.execution_mode.cloned(),
        runtime_graph: Some(runtime_graph),
        conversation_session_id: input.conversation_session_id.map(str::to_string),
        goal_envelope: input.goal_envelope.cloned(),
    })
}

/// RAII owner for the private bootstrap file. Keeping this value alive keeps
/// the path valid for both future planner and orchestrator subprocesses; drop
/// unlinks it automatically.
pub(crate) struct PrivateProgressiveBootstrapFile {
    file: tempfile::NamedTempFile,
}

impl PrivateProgressiveBootstrapFile {
    #[allow(dead_code)]
    pub(crate) fn create(prd: &PrdFile) -> Result<Self, ProgressivePlanningBootstrapError> {
        let mut file = tempfile::Builder::new()
            .prefix("baro-progressive-bootstrap-")
            .suffix(".json")
            .tempfile()?;
        serde_json::to_writer_pretty(file.as_file_mut(), prd)?;
        file.write_all(b"\n")?;
        file.as_file_mut().sync_all()?;
        if !file.path().is_absolute() {
            return Err(ProgressivePlanningBootstrapError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "progressive bootstrap tempfile path is not absolute",
            )));
        }
        Ok(Self { file })
    }

    pub(crate) fn path(&self) -> &Path {
        self.file.path()
    }

    #[allow(dead_code)]
    pub(crate) fn path_buf(&self) -> PathBuf {
        self.path().to_path_buf()
    }
}

#[derive(Debug)]
pub(crate) enum ProgressivePlanningBootstrapError {
    InvalidGoal(String),
    InvalidId { field: &'static str, reason: String },
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for ProgressivePlanningBootstrapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidGoal(reason) => write!(formatter, "invalid progressive goal: {reason}"),
            Self::InvalidId { field, reason } => {
                write!(formatter, "invalid progressive {field}: {reason}")
            }
            Self::Io(error) => write!(formatter, "progressive bootstrap I/O failed: {error}"),
            Self::Json(error) => {
                write!(formatter, "progressive bootstrap JSON failed: {error}")
            }
        }
    }
}

impl std::error::Error for ProgressivePlanningBootstrapError {}

impl From<std::io::Error> for ProgressivePlanningBootstrapError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for ProgressivePlanningBootstrapError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    use super::{
        build_progressive_bootstrap_prd, deterministic_bootstrap_metadata,
        progressive_planning_enabled_with_env, PrivateProgressiveBootstrapFile,
        ProgressiveBootstrapInput, ProgressivePlanningIds,
    };
    use crate::conversation::GoalEnvelope;
    use crate::executor::PrdFile;

    #[test]
    fn opt_in_requires_headless_collective_and_explicit_switch() {
        assert!(progressive_planning_enabled_with_env(
            true,
            "collective",
            true,
            None
        ));
        assert!(progressive_planning_enabled_with_env(
            true,
            "collective",
            false,
            Some("YES")
        ));
        for (headless, coordination, flag, env) in [
            (false, "collective", true, Some("1")),
            (true, "legacy", true, Some("1")),
            (true, "collective", false, None),
            (true, "collective", false, Some("false")),
        ] {
            assert!(!progressive_planning_enabled_with_env(
                headless,
                coordination,
                flag,
                env
            ));
        }
    }

    #[test]
    fn generated_and_external_ids_are_safe_and_distinct() {
        let first = ProgressivePlanningIds::generate();
        let second = ProgressivePlanningIds::generate();
        assert_ne!(first, second);
        for value in [first.run_id(), first.planning_id()] {
            assert!(!value.is_empty());
            assert!(value.len() <= 128);
            assert!(value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
            }));
        }
        assert!(ProgressivePlanningIds::new("run-7", "planning-7").is_ok());
        assert!(ProgressivePlanningIds::new("run 7", "planning-7").is_err());
        assert!(ProgressivePlanningIds::new("same", "same").is_err());
    }

    #[test]
    fn bootstrap_metadata_is_deterministic_and_branch_safe() {
        let cwd = Path::new("/tmp/My Repository");
        let first = deterministic_bootstrap_metadata(
            cwd,
            "  Add progressive planning while keeping legacy safe.  ",
        )
        .unwrap();
        let second = deterministic_bootstrap_metadata(
            cwd,
            "Add progressive planning while keeping legacy safe.",
        )
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(first.project, "My Repository");
        assert_eq!(
            first.description,
            "Add progressive planning while keeping legacy safe."
        );
        assert!(first
            .branch_name
            .starts_with("baro/add-progressive-planning-"));
        assert!(first
            .branch_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-')));
        assert_ne!(
            first.branch_name,
            deterministic_bootstrap_metadata(cwd, "A different goal")
                .unwrap()
                .branch_name
        );
    }

    #[test]
    fn builds_empty_v1_prd_with_all_existing_metadata() {
        let ids = ProgressivePlanningIds::new("run-7", "planning-7").unwrap();
        let mode = json!({
            "mode": "parallel",
            "reason": "independent early work",
            "source": "llm"
        });
        let envelope = GoalEnvelope {
            objective: "Implement progressive planning".to_string(),
            constraints: vec!["Keep legacy startup unchanged".to_string()],
            acceptance_criteria: vec!["First fragment executes early".to_string()],
            non_goals: vec!["TUI redesign".to_string()],
            assumptions: vec!["Collective mode".to_string()],
        };
        let prd = build_progressive_bootstrap_prd(ProgressiveBootstrapInput {
            cwd: Path::new("/work/baro"),
            goal: "Implement progressive planning",
            ids: &ids,
            decision_document: Some("# Decisions\n- Preserve event authority"),
            execution_mode: Some(&mode),
            conversation_session_id: Some("conversation-3"),
            goal_envelope: Some(&envelope),
        })
        .unwrap();

        assert_eq!(prd.project, "baro");
        assert!(prd.user_stories.is_empty());
        assert_eq!(
            prd.decision_document.as_deref(),
            Some("# Decisions\n- Preserve event authority")
        );
        assert_eq!(prd.execution_mode.as_ref(), Some(&mode));
        assert_eq!(
            prd.conversation_session_id.as_deref(),
            Some("conversation-3")
        );
        assert_eq!(prd.goal_envelope.as_ref(), Some(&envelope));
        assert_eq!(
            prd.runtime_graph.as_ref().unwrap(),
            &json!({
                "runId": "run-7",
                "version": 1,
                "dynamicStories": 0,
                "policyStories": 0,
                "appliedDecisions": [],
                "planning": {
                    "schemaVersion": 1,
                    "runId": "run-7",
                    "planningId": "planning-7",
                    "status": "open",
                    "nextOrdinal": 1,
                    "admittedStoryIds": [],
                    "fragments": []
                }
            })
        );
    }

    #[test]
    fn private_file_round_trips_and_is_removed_on_drop() {
        let ids = ProgressivePlanningIds::new("run-file", "planning-file").unwrap();
        let prd = build_progressive_bootstrap_prd(ProgressiveBootstrapInput {
            cwd: Path::new("/work/baro"),
            goal: "Stream a plan",
            ids: &ids,
            decision_document: None,
            execution_mode: None,
            conversation_session_id: None,
            goal_envelope: None,
        })
        .unwrap();
        let file = PrivateProgressiveBootstrapFile::create(&prd).unwrap();
        let path = file.path_buf();
        assert!(path.is_absolute());
        assert!(path.exists());
        let restored: PrdFile =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(restored.user_stories.is_empty());
        assert_eq!(restored.runtime_graph, prd.runtime_graph);

        drop(file);
        assert!(!path.exists());
    }
}
