//! Launch-time decisions that must be made before any process exists: where a
//! detached run's log lands, and whether a bare invocation continues the run
//! already described by prd.json or starts a new one. Both are kept pure so the
//! choice can be tested without spawning a run or touching a home directory.

// Every item here is called from main.rs, which lands separately; until then
// the binary target sees them as unreachable.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetachPlan {
    /// stdout/stderr are redirected at spawn time, before the child pid — and
    /// therefore the run id — is known, so the stream first lands here.
    pub pending_log: PathBuf,
    pub final_log: PathBuf,
    /// Argv of the sibling process that keeps the machine awake for the run.
    pub caffeinate: Option<Vec<String>>,
}

pub fn plan_detach(
    logs_dir: &Path,
    parent_pid: u32,
    nanos: u128,
    child_pid: Option<u32>,
    is_macos: bool,
    caffeinate_binary_exists: bool,
) -> DetachPlan {
    let pending_log = logs_dir.join(format!(".pending-{parent_pid}-{nanos}.log"));
    let final_log = match child_pid {
        Some(pid) => logs_dir.join(format!("run-{pid}.log")),
        None => pending_log.clone(),
    };
    let caffeinate = match child_pid {
        Some(pid) if is_macos && caffeinate_binary_exists => Some(vec![
            "caffeinate".to_string(),
            "-i".to_string(),
            "-w".to_string(),
            pid.to_string(),
        ]),
        _ => None,
    };
    DetachPlan { pending_log, final_log, caffeinate }
}

/// FNV-1a 64, formatted `fnv1a64:{16 hex}`. Equality of goal text is all this
/// has to decide, so a non-cryptographic hash carrying no new dependency is
/// enough; it is never an identity or a security token.
pub fn goal_fingerprint(goal: &str) -> String {
    // Splitting on whitespace subsumes CRLF, surrounding blanks and reflowed
    // indentation: the same goal pasted twice must fingerprint the same.
    let normalized = goal.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normalized.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("fnv1a64:{hash:016x}")
}

/// An inherited BARO_RUN_ID belongs to whoever launched this process; leaving
/// it in place would make this run report under another run's identity.
pub fn scrub_inherited_run_id() {
    std::env::remove_var("BARO_RUN_ID");
}

/// The value BASH_DEFAULT_TIMEOUT_MS should take, or `None` to leave the
/// environment alone. `operator_value` is taken only so the precedence the
/// flag's help promises is a function of both inputs.
pub fn shell_budget_env(flag_secs: Option<u64>, operator_value: Option<&str>) -> Option<String> {
    let _ = operator_value;
    flag_secs.map(|secs| secs.saturating_mul(1000).to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchMode {
    Fresh,
    Resume,
    /// The operator named the mode themselves; the flag decides, not the PRD.
    Explicit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchDecision {
    pub mode: LaunchMode,
    pub message: Option<String>,
}

pub const RESUMING_INTERRUPTED_RUN: &str =
    "found an interrupted run for this goal; resuming (use --continue to re-plan)";
pub const UNFINISHED_PRD_FOR_OTHER_GOAL: &str =
    "an unfinished prd.json exists for a different goal; starting fresh (use --continue to re-plan it)";

pub fn decide_launch(
    explicit_resume: bool,
    explicit_continue: bool,
    positional_goal: Option<&str>,
    prd_fingerprint: Option<&str>,
    has_incomplete_stories: bool,
) -> LaunchDecision {
    if explicit_resume || explicit_continue {
        return LaunchDecision { mode: LaunchMode::Explicit, message: None };
    }
    if !has_incomplete_stories {
        return LaunchDecision { mode: LaunchMode::Fresh, message: None };
    }
    let same_goal = match positional_goal {
        Some(goal) => prd_fingerprint == Some(goal_fingerprint(goal).as_str()),
        // No new goal text was offered, so nothing contradicts the unfinished
        // run: this is the `baro` re-invocation that has always resumed.
        None => true,
    };
    if same_goal {
        LaunchDecision {
            mode: LaunchMode::Resume,
            message: Some(RESUMING_INTERRUPTED_RUN.to_string()),
        }
    } else {
        LaunchDecision {
            mode: LaunchMode::Fresh,
            message: Some(UNFINISHED_PRD_FOR_OTHER_GOAL.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rust tests share one process, so every env-mutating test in this module
    /// must hold this before touching the environment.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn logs_dir() -> PathBuf {
        PathBuf::from("/home/op/.baro/logs")
    }

    #[test]
    fn the_stream_is_renamed_from_the_pending_file_to_the_run_id_log() {
        let plan = plan_detach(&logs_dir(), 41, 7, Some(4242), false, false);

        assert_eq!(plan.pending_log, logs_dir().join(".pending-41-7.log"));
        assert_eq!(plan.final_log, logs_dir().join("run-4242.log"));
    }

    #[test]
    fn without_a_child_pid_the_pending_file_is_all_there_is() {
        let plan = plan_detach(&logs_dir(), 41, 7, None, true, true);

        assert_eq!(plan.final_log, plan.pending_log);
        assert_eq!(plan.caffeinate, None);
    }

    #[test]
    fn caffeinate_waits_on_the_child_only_on_macos_with_the_binary_present() {
        let plan = plan_detach(&logs_dir(), 41, 7, Some(4242), true, true);
        assert_eq!(
            plan.caffeinate,
            Some(vec![
                "caffeinate".to_string(),
                "-i".to_string(),
                "-w".to_string(),
                "4242".to_string(),
            ])
        );

        for (is_macos, binary_exists) in [(true, false), (false, true), (false, false)] {
            let plan = plan_detach(&logs_dir(), 41, 7, Some(4242), is_macos, binary_exists);
            assert_eq!(plan.caffeinate, None, "macos={is_macos} binary={binary_exists}");
        }
    }

    #[test]
    fn the_same_goal_fingerprints_the_same_through_line_endings_and_reflow() {
        let base = goal_fingerprint("ship the launcher");

        assert_eq!(base, goal_fingerprint("  ship the launcher\n"));
        assert_eq!(base, goal_fingerprint("ship\r\nthe\tlauncher"));
        assert_eq!(base, goal_fingerprint("ship   the\n\n  launcher  "));
        assert_ne!(base, goal_fingerprint("ship the launcher twice"));
        assert!(base.starts_with("fnv1a64:"));
        assert_eq!(base.len(), "fnv1a64:".len() + 16);
    }

    #[test]
    fn an_interrupted_run_for_this_goal_resumes_itself() {
        let fingerprint = goal_fingerprint("ship the launcher");

        let decision =
            decide_launch(false, false, Some("ship the launcher"), Some(&fingerprint), true);

        assert_eq!(decision.mode, LaunchMode::Resume);
        assert_eq!(decision.message.as_deref(), Some(RESUMING_INTERRUPTED_RUN));
    }

    #[test]
    fn a_different_or_absent_fingerprint_starts_fresh_with_one_warning() {
        let other = goal_fingerprint("something else entirely");

        let differing = decide_launch(false, false, Some("ship the launcher"), Some(&other), true);
        assert_eq!(differing.mode, LaunchMode::Fresh);
        assert_eq!(differing.message.as_deref(), Some(UNFINISHED_PRD_FOR_OTHER_GOAL));

        // A prd.json written before fingerprints existed is treated as another goal.
        let missing = decide_launch(false, false, Some("ship the launcher"), None, true);
        assert_eq!(missing.mode, LaunchMode::Fresh);
        assert_eq!(missing.message.as_deref(), Some(UNFINISHED_PRD_FOR_OTHER_GOAL));
    }

    #[test]
    fn re_invoking_baro_with_no_goal_keeps_resuming_the_unfinished_run() {
        let decision = decide_launch(false, false, None, None, true);

        assert_eq!(decision.mode, LaunchMode::Resume);
        assert_eq!(decision.message.as_deref(), Some(RESUMING_INTERRUPTED_RUN));
    }

    #[test]
    fn an_explicit_flag_decides_the_mode_and_says_nothing() {
        let fingerprint = goal_fingerprint("ship the launcher");

        for (resume, continue_run) in [(true, false), (false, true), (true, true)] {
            for prd_fingerprint in [Some(fingerprint.as_str()), None] {
                let decision =
                    decide_launch(resume, continue_run, Some("ship the launcher"), prd_fingerprint, true);
                assert_eq!(decision.mode, LaunchMode::Explicit);
                assert_eq!(decision.message, None);
            }
        }
    }

    #[test]
    fn a_finished_prd_starts_fresh_without_a_word() {
        let fingerprint = goal_fingerprint("ship the launcher");

        let decision =
            decide_launch(false, false, Some("ship the launcher"), Some(&fingerprint), false);

        assert_eq!(decision.mode, LaunchMode::Fresh);
        assert_eq!(decision.message, None);
    }

    #[test]
    fn an_inherited_run_id_is_gone_but_a_freshly_set_one_survives() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        std::env::set_var("BARO_RUN_ID", "inherited");
        scrub_inherited_run_id();
        assert!(std::env::var("BARO_RUN_ID").is_err());

        // The scrub must not stop the run from minting and exporting its own id.
        std::env::set_var("BARO_RUN_ID", "run-local");
        assert_eq!(std::env::var("BARO_RUN_ID").as_deref(), Ok("run-local"));

        std::env::remove_var("BARO_RUN_ID");
    }

    #[test]
    fn the_shell_budget_flag_wins_over_an_operator_set_timeout() {
        assert_eq!(shell_budget_env(Some(45), None).as_deref(), Some("45000"));
        assert_eq!(shell_budget_env(Some(45), Some("900000")).as_deref(), Some("45000"));
        assert_eq!(shell_budget_env(None, Some("900000")), None);
        assert_eq!(shell_budget_env(None, None), None);
    }
}
