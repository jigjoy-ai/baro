use serde::Deserialize;

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
#[serde(tag = "type")]
pub enum BaroEvent {
    #[serde(rename = "init")]
    Init {
        project: String,
        stories: Vec<StoryInfo>,
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
    },

    #[serde(rename = "notification_ready")]
    NotificationReady,

    #[serde(rename = "token_usage")]
    TokenUsage {
        id: String,
        input_tokens: u64,
        output_tokens: u64,
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
