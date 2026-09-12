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

#[derive(Debug, Deserialize, Clone)]
pub struct VerificationCommandEvidence {
    pub command: String,
    pub status: String,
    #[allow(dead_code)]
    pub duration_ms: u64,
    #[allow(dead_code)]
    #[serde(default)]
    pub tail: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct RunVerificationEvidence {
    #[allow(dead_code)]
    pub verification_id: String,
    pub status: String,
    pub duration_ms: u64,
    #[serde(default)]
    pub commands: Vec<VerificationCommandEvidence>,
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
    Dag { levels: Vec<Vec<DagNode>> },

    #[serde(rename = "story_start")]
    StoryStart { id: String, title: String },

    /// A worker quiesced because an accepted dependency block made its
    /// current lease temporarily unrunnable. This is not a failure.
    #[serde(rename = "story_suspended")]
    StorySuspended { id: String, block_id: String },

    #[serde(rename = "story_log")]
    StoryLog { id: String, line: String },

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
    StoryRetry { id: String, attempt: u32 },

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
    ReviewStart { level: usize },

    #[serde(rename = "review_log")]
    ReviewLog { line: String },

    #[serde(rename = "review_complete")]
    ReviewComplete {
        level: usize,
        passed: bool,
        fix_count: u32,
    },

    #[serde(rename = "finalize_start")]
    FinalizeStart,

    #[serde(rename = "finalize_complete")]
    FinalizeComplete { pr_url: Option<String> },

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
        /// Objective run-level gate. `skipped` means no build/test command
        /// could be detected, so the run is complete but not verified.
        #[serde(default)]
        verification_status: Option<String>,
        /// Full correlated command evidence behind `verification_status`.
        #[serde(default)]
        verification: Option<RunVerificationEvidence>,
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

    /// Full backend-neutral measurement. The current UI keeps using the
    /// compatibility TokenUsage projection while Cloud/audit consume this.
    #[serde(rename = "model_usage")]
    ModelUsage {
        #[allow(dead_code)]
        measurement: serde_json::Value,
    },

    /// Latest cumulative live estimate; unlike TokenUsage this is not a delta.
    #[serde(rename = "token_progress")]
    TokenProgress {
        id: String,
        input_tokens: u64,
        output_tokens: u64,
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
        // Contract field; suspended stories remain pending for a later wave.
        #[allow(dead_code)]
        #[serde(default)]
        blocked: Vec<String>,
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

    /// Correlated reply from the run-local DialogueAgent. Compatibility
    /// activity/story_log mirrors may follow, but this event is what updates
    /// the durable user-facing conversation session.
    #[serde(rename = "conversation_request")]
    ConversationRequest { message_id: String, text: String },

    #[serde(rename = "conversation_response")]
    ConversationResponse { message_id: String, text: String },

    #[serde(rename = "conversation_failed")]
    ConversationFailed { message_id: String, error: String },

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

/// Headless stdout is a machine-readable JSONL stream. A subprocess that
/// dies mid-write, or a 64 KiB pipe read clipped at EOF, hands the echo
/// path a partial JSON line; echoing it verbatim corrupts the stream, so a
/// non-JSON line is wrapped into a bounded, valid `story_log` envelope.
pub fn jsonl_safe_line<'a>(raw: &'a str, wrap_id: &str) -> std::borrow::Cow<'a, str> {
    if serde_json::from_str::<serde_json::Value>(raw).is_ok() {
        return std::borrow::Cow::Borrowed(raw);
    }
    let bounded: String = raw.chars().take(2_000).collect();
    std::borrow::Cow::Owned(
        serde_json::json!({
            "type": "story_log",
            "id": wrap_id,
            "line": format!(
                "[non-json line, {} bytes] {}",
                raw.len(),
                bounded,
            ),
        })
        .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> BaroEvent {
        serde_json::from_str(json).expect(json)
    }

    #[test]
    fn safe_line_passes_valid_json_through_unchanged() {
        let raw = r#"{"type":"plan_complete_summary","stories":8}"#;
        assert_eq!(jsonl_safe_line(raw, "plan"), raw);
    }

    #[test]
    fn safe_line_wraps_a_clipped_json_line_into_valid_jsonl() {
        // A 64 KiB pipe clip ends mid-string with no closing quote/brace.
        let clipped = format!(
            r#"{{"type":"plan_complete","final_prd":{{"description":"{}"#,
            "x".repeat(70_000),
        );
        let wrapped = jsonl_safe_line(&clipped, "plan");
        let value: serde_json::Value =
            serde_json::from_str(&wrapped).expect("wrapped line must be valid JSON");
        assert_eq!(value["type"], "story_log");
        assert_eq!(value["id"], "plan");
        let line = value["line"].as_str().unwrap();
        assert!(line.starts_with("[non-json line,"));
        assert!(line.len() < 3_000, "wrapped line must stay bounded");
    }

    #[test]
    fn parses_replan() {
        let e = parse(
            r#"{"type":"replan","source":"sentry","reason":"scope shift",
                "added":[{"id":"S9","title":"New story","depends_on":["S1"]}],
                "removed":["S3"],"rewired":[{"id":"S4","depends_on":["S9"]}]}"#,
        );
        match e {
            BaroEvent::Replan {
                added,
                removed,
                rewired,
                ..
            } => {
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
        match parse(
            r#"{"type":"intervention","id":"S1","source":"sentry","action":"aborted","reason":"stall"}"#,
        ) {
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
    fn parses_dependency_suspension_as_its_own_event() {
        match parse(r#"{"type":"story_suspended","id":"S2","block_id":"block-S2-S1"}"#) {
            BaroEvent::StorySuspended { id, block_id } => {
                assert_eq!(id, "S2");
                assert_eq!(block_id, "block-S2-S1");
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
        match parse(
            r#"{"type":"level_completed","ordinal":2,"passed":["S3"],"failed":["S4"],"blocked":["S5"]}"#,
        ) {
            BaroEvent::LevelCompleted {
                passed,
                failed,
                blocked,
                ..
            } => {
                assert_eq!(passed, vec!["S3"]);
                assert_eq!(failed, vec!["S4"]);
                assert_eq!(blocked, vec!["S5"]);
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
                assert_eq!(
                    (id.as_str(), backend.as_str(), model.as_str()),
                    ("S1", "codex", "gpt-5.3-codex")
                );
            }
            other => panic!("wrong variant: {:?}", other),
        }
        match parse(
            r#"{"type":"critique","id":"S1","verdict":"fail","reasoning":"missing tests","violated":["AC2"]}"#,
        ) {
            BaroEvent::Critique {
                verdict, violated, ..
            } => {
                assert_eq!(verdict, "fail");
                assert_eq!(violated, vec!["AC2"]);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn parses_correlated_runtime_conversation_events() {
        match parse(r#"{"type":"conversation_request","message_id":"request-6","text":"Status?"}"#)
        {
            BaroEvent::ConversationRequest { message_id, text } => {
                assert_eq!(message_id, "request-6");
                assert_eq!(text, "Status?");
            }
            other => panic!("wrong variant: {:?}", other),
        }
        match parse(
            r#"{"type":"conversation_response","message_id":"request-7","text":"Still working.","actions":[{"recipient_id":"S1","text":"Run tests"}]}"#,
        ) {
            BaroEvent::ConversationResponse { message_id, text } => {
                assert_eq!(message_id, "request-7");
                assert_eq!(text, "Still working.");
            }
            other => panic!("wrong variant: {:?}", other),
        }
        match parse(r#"{"type":"conversation_failed","message_id":"request-8","error":"timeout"}"#)
        {
            BaroEvent::ConversationFailed { message_id, error } => {
                assert_eq!(message_id, "request-8");
                assert_eq!(error, "timeout");
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
        match parse(
            r#"{"type":"activity","id":"S1","kind":"file_change","text":"src/a.rs","path":"src/a.rs","op":"modify"}"#,
        ) {
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

/// Stamp `ts` onto one JSONL line when the emitter did not provide it. The
/// v3 stream contract promises a timestamp on every line, and the Rust host
/// is the one emitter that does not route through the orchestrator's emit().
pub fn stamped_jsonl(value: serde_json::Value) -> String {
    let mut value = value;
    if let serde_json::Value::Object(ref mut map) = value {
        if !map.contains_key("ts") {
            map.insert(
                "ts".to_string(),
                serde_json::Value::String(now_iso8601()),
            );
        }
    }
    value.to_string()
}

pub fn now_iso8601() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = secs / 86_400;
    let (y, mo, d) = civil_from_days(days as i64);
    let s = secs % 86_400;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, mo, d, s / 3600, (s % 3600) / 60, s % 60, millis
    )
}

/// Howard Hinnant's civil-from-days; avoids a chrono dependency for one stamp.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod stamp_tests {
    use super::*;

    #[test]
    fn a_line_without_ts_gains_the_moment_of_emission() {
        let line = stamped_jsonl(serde_json::json!({"type": "story_log", "id": "plan", "line": "x"}));
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        let ts = value["ts"].as_str().expect("ts present");
        assert!(ts.ends_with('Z') && ts.contains('T'), "ISO-8601: {ts}");
        assert_eq!(value["type"], "story_log");
    }

    #[test]
    fn an_emitter_that_already_stamped_is_left_alone() {
        let line = stamped_jsonl(serde_json::json!({"type": "init", "ts": "2026-01-01T00:00:00.000Z"}));
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["ts"], "2026-01-01T00:00:00.000Z");
    }

    #[test]
    fn the_date_math_is_right_on_a_known_epoch() {
        // 2026-08-16 is day 20681 since the epoch; a leap-year boundary bug
        // would land this on the wrong civil date.
        let (y, m, d) = civil_from_days(20_681);
        assert_eq!((y, m, d), (2026, 8, 16));
    }
}
