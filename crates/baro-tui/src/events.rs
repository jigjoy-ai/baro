use serde::Deserialize;

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, Clone)]
pub struct StoryInfo {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct DagNode {
    pub id: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct DoneStats {
    pub stories_completed: u32,
    pub stories_skipped: u32,
    pub total_commits: u32,
    pub files_created: u32,
    pub files_modified: u32,
}

#[derive(Debug, Deserialize, Clone)]
pub struct DiffFile {
    pub path: String,
    pub added: u32,
    pub removed: u32,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct ReplanStory {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct ReplanRewire {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum BaroEvent {
    #[serde(rename = "init")]
    Init {
        project: String,
        stories: Vec<StoryInfo>,
        /// Where this run executes (hostname for the local CLI). Optional for
        /// backwards-compat with orchestrators that don't emit it.
        #[serde(default)]
        runner: Option<String>,
        /// Resolved execution mode (focused/sequential/parallel).
        #[serde(default)]
        mode: Option<String>,
    },

    #[serde(rename = "dag")]
    Dag {
        levels: Vec<Vec<DagNode>>,
    },

    #[serde(rename = "story_start")]
    StoryStart {
        id: String,
        title: String,
    },

    #[serde(rename = "story_log")]
    StoryLog {
        id: String,
        line: String,
    },

    /// One condensed, typed entry for the structured Activity feed.
    #[serde(rename = "activity")]
    Activity {
        id: String,
        kind: String,
        text: String,
        #[serde(default)]
        tool: Option<String>,
        // Contract field (file_change); not rendered yet.
        #[allow(dead_code)]
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        op: Option<String>,
        #[serde(default)]
        ok: Option<bool>,
    },

    #[serde(rename = "story_complete")]
    StoryComplete {
        id: String,
        duration_secs: u64,
        files_created: u32,
        files_modified: u32,
    },

    #[serde(rename = "story_error")]
    StoryError {
        id: String,
        error: String,
        attempt: u32,
        max_retries: u32,
    },

    #[serde(rename = "story_retry")]
    StoryRetry {
        id: String,
        attempt: u32,
    },

    #[serde(rename = "progress")]
    Progress {
        completed: u32,
        total: u32,
        percentage: u32,
    },

    #[serde(rename = "push_status")]
    PushStatus {
        id: String,
        success: bool,
        error: Option<String>,
    },

    #[serde(rename = "review_start")]
    ReviewStart {
        level: usize,
    },

    #[serde(rename = "review_log")]
    ReviewLog {
        line: String,
    },

    #[serde(rename = "review_complete")]
    ReviewComplete {
        level: usize,
        passed: bool,
        fix_count: u32,
    },

    #[serde(rename = "finalize_start")]
    FinalizeStart,

    #[serde(rename = "finalize_complete")]
    FinalizeComplete {
        pr_url: Option<String>,
    },

    #[serde(rename = "done")]
    Done {
        total_time_secs: u64,
        stats: DoneStats,
        /// True when every original story passed and nothing was dropped.
        /// Optional for backwards compat with older orchestrators that
        /// always emit Done as if successful. Default `true` if absent.
        #[serde(default = "default_true")]
        success: bool,
        /// Reason for an abort/early-termination if `success` is false.
        #[serde(default)]
        abort_reason: Option<String>,
    },

    #[serde(rename = "notification_ready")]
    NotificationReady,

    #[serde(rename = "token_usage")]
    TokenUsage {
        id: String,
        input_tokens: u64,
        output_tokens: u64,
        /// Per-story USD cost when the backend reports it (Claude CLI). Absent
        /// for subscription paths. Summed into a per-run cost.
        #[serde(default)]
        cost_usd: Option<f64>,
    },

    /// Per-story changes merged into the run branch: file list + capped diff.
    #[serde(rename = "story_diff")]
    StoryDiff {
        id: String,
        files: Vec<DiffFile>,
        #[serde(default)]
        diff: Option<String>,
    },

    // --- v2 structured semantic events (docs/tui-protocol-v2.md). All
    // fields default so the TUI tolerates partial/growing payloads.
    #[serde(rename = "replan")]
    Replan {
        #[serde(default)]
        source: String,
        #[serde(default)]
        reason: String,
        #[serde(default)]
        added: Vec<ReplanStory>,
        #[serde(default)]
        removed: Vec<String>,
        #[serde(default)]
        rewired: Vec<ReplanRewire>,
    },

    #[serde(rename = "intervention")]
    Intervention {
        #[serde(default)]
        id: String,
        #[serde(default)]
        source: String,
        #[serde(default)]
        action: String,
        #[serde(default)]
        reason: String,
    },

    #[serde(rename = "story_merged")]
    StoryMerged {
        #[serde(default)]
        id: String,
        #[serde(default)]
        mode: String,
    },

    #[serde(rename = "merge_failed")]
    MergeFailed {
        #[serde(default)]
        id: String,
        #[serde(default)]
        error: String,
    },

    #[serde(rename = "level_started")]
    LevelStarted {
        #[serde(default)]
        ordinal: usize,
        // Contract field; per-story state comes from story events.
        #[allow(dead_code)]
        #[serde(default)]
        story_ids: Vec<String>,
    },

    #[serde(rename = "level_completed")]
    LevelCompleted {
        #[serde(default)]
        ordinal: usize,
        // Contract field; per-story state comes from story events.
        #[allow(dead_code)]
        #[serde(default)]
        passed: Vec<String>,
        #[serde(default)]
        failed: Vec<String>,
    },

    #[serde(rename = "recovery_started")]
    RecoveryStarted {
        #[serde(default)]
        attempt: u32,
        #[serde(default)]
        story_ids: Vec<String>,
    },

    #[serde(rename = "routed")]
    Routed {
        #[serde(default)]
        id: String,
        #[serde(default)]
        backend: String,
        #[serde(default)]
        model: String,
    },

    #[serde(rename = "critique")]
    Critique {
        #[serde(default)]
        id: String,
        /// "pass" | "fail"
        #[serde(default)]
        verdict: String,
        #[serde(default)]
        reasoning: String,
        #[serde(default)]
        violated: Vec<String>,
    },

    /// Synthetic event the orchestrator client emits exactly once when
    /// the orchestrator subprocess terminates — whether cleanly with a
    /// preceding `Done` event or abruptly. Lets the TUI escape any
    /// "waiting for next story" state and show a terminal banner.
    /// Not produced by the TS orchestrator itself.
    #[serde(rename = "orchestrator_exited")]
    OrchestratorExited {
        code: Option<i32>,
        reason: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> BaroEvent {
        serde_json::from_str(json).expect(json)
    }

    #[test]
    fn parses_replan() {
        let e = parse(
            r#"{"type":"replan","source":"sentry","reason":"scope shift",
                "added":[{"id":"S9","title":"New story","depends_on":["S1"]}],
                "removed":["S3"],"rewired":[{"id":"S4","depends_on":["S9"]}]}"#,
        );
        match e {
            BaroEvent::Replan { added, removed, rewired, .. } => {
                assert_eq!(added[0].id, "S9");
                assert_eq!(added[0].depends_on, vec!["S1"]);
                assert_eq!(removed, vec!["S3"]);
                assert_eq!(rewired[0].depends_on, vec!["S9"]);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn parses_intervention_and_merge_events() {
        match parse(r#"{"type":"intervention","id":"S1","source":"sentry","action":"aborted","reason":"stall"}"#) {
            BaroEvent::Intervention { id, action, .. } => {
                assert_eq!(id, "S1");
                assert_eq!(action, "aborted");
            }
            other => panic!("wrong variant: {:?}", other),
        }
        match parse(r#"{"type":"story_merged","id":"S1","mode":"worktree"}"#) {
            BaroEvent::StoryMerged { id, mode } => {
                assert_eq!((id.as_str(), mode.as_str()), ("S1", "worktree"));
            }
            other => panic!("wrong variant: {:?}", other),
        }
        match parse(r#"{"type":"merge_failed","id":"S2","error":"conflict"}"#) {
            BaroEvent::MergeFailed { id, error } => {
                assert_eq!((id.as_str(), error.as_str()), ("S2", "conflict"));
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn parses_level_and_recovery_events() {
        match parse(r#"{"type":"level_started","ordinal":2,"story_ids":["S3","S4"]}"#) {
            BaroEvent::LevelStarted { ordinal, story_ids } => {
                assert_eq!(ordinal, 2);
                assert_eq!(story_ids, vec!["S3", "S4"]);
            }
            other => panic!("wrong variant: {:?}", other),
        }
        match parse(r#"{"type":"level_completed","ordinal":2,"passed":["S3"],"failed":["S4"]}"#) {
            BaroEvent::LevelCompleted { passed, failed, .. } => {
                assert_eq!(passed, vec!["S3"]);
                assert_eq!(failed, vec!["S4"]);
            }
            other => panic!("wrong variant: {:?}", other),
        }
        match parse(r#"{"type":"recovery_started","attempt":1,"story_ids":["S4"]}"#) {
            BaroEvent::RecoveryStarted { attempt, story_ids } => {
                assert_eq!(attempt, 1);
                assert_eq!(story_ids, vec!["S4"]);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn parses_routed_and_critique() {
        match parse(r#"{"type":"routed","id":"S1","backend":"codex","model":"gpt-5.3-codex"}"#) {
            BaroEvent::Routed { id, backend, model } => {
                assert_eq!((id.as_str(), backend.as_str(), model.as_str()), ("S1", "codex", "gpt-5.3-codex"));
            }
            other => panic!("wrong variant: {:?}", other),
        }
        match parse(r#"{"type":"critique","id":"S1","verdict":"fail","reasoning":"missing tests","violated":["AC2"]}"#) {
            BaroEvent::Critique { verdict, violated, .. } => {
                assert_eq!(verdict, "fail");
                assert_eq!(violated, vec!["AC2"]);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn tolerates_missing_and_unknown_fields() {
        // Minimal payloads (defaults) and unknown extra fields must both parse.
        parse(r#"{"type":"replan"}"#);
        parse(r#"{"type":"critique","id":"S1"}"#);
        parse(r#"{"type":"routed","id":"S1","backend":"claude","model":"opus","future_field":42}"#);
        match parse(r#"{"type":"activity","id":"S1","kind":"file_change","text":"src/a.rs","path":"src/a.rs","op":"modify"}"#) {
            BaroEvent::Activity { path, op, .. } => {
                assert_eq!(path.as_deref(), Some("src/a.rs"));
                assert_eq!(op.as_deref(), Some("modify"));
            }
            other => panic!("wrong variant: {:?}", other),
        }
        match parse(r#"{"type":"init","project":"p","stories":[],"mode":"focused"}"#) {
            BaroEvent::Init { mode, .. } => assert_eq!(mode.as_deref(), Some("focused")),
            other => panic!("wrong variant: {:?}", other),
        }
    }
}
