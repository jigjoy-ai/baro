//! A barrier standing exactly where a fresh plan would be written over
//! prd.json. It is deliberately redundant with the resume gate: even if a
//! future edit reopens a path from Resume to planning, the plan on disk still
//! survives, because the last step before the write refuses to take it.

/// Refusal text for a fresh-plan write attempted during a resume run. Paired
/// with `RESUME_EXITS` so the two honest ways out read identically here and at
/// the resume gate.
pub const FRESH_PLAN_DURING_RESUME: &str =
    "baro: refusing to overwrite prd.json with a fresh plan while this run is resuming";

pub fn guard_fresh_plan_write(is_resume: bool) -> Result<(), String> {
    if is_resume {
        return Err(format!(
            "{FRESH_PLAN_DURING_RESUME}\n{}",
            crate::cli::resume_guard::RESUME_EXITS
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{guard_fresh_plan_write, FRESH_PLAN_DURING_RESUME};
    use crate::cli::launch::LaunchMode;
    use crate::cli::resume_guard::{
        decide_resume_continuation, resume_failure_message, PrdState, ResumeGate, RESUME_EXITS,
    };
    use crate::executor;

    #[test]
    fn a_fresh_plan_write_during_a_resume_is_refused_with_both_exits() {
        let message = guard_fresh_plan_write(true).unwrap_err();

        assert!(message.contains(FRESH_PLAN_DURING_RESUME), "{message}");
        assert!(message.contains(RESUME_EXITS), "{message}");
    }

    #[test]
    fn a_run_that_is_not_resuming_may_write_its_fresh_plan() {
        assert_eq!(guard_fresh_plan_write(false), Ok(()));
    }

    #[test]
    fn the_whole_failing_resume_path_leaves_prd_json_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        let prd = executor::prd_from_review(
            "atomic",
            "baro/atomic",
            "complete snapshot",
            &[],
            None,
            None,
        );
        executor::write_prd(&prd, dir.path()).unwrap();
        let prd_path = dir.path().join("prd.json");
        let before = fs::read(&prd_path).unwrap();

        let gate = decide_resume_continuation(LaunchMode::Resume, PrdState::Loaded, false);
        let ResumeGate::Terminate { assumption, .. } = gate else {
            panic!("a resume with no unfinished story must terminate, got {gate:?}");
        };
        let termination = resume_failure_message(assumption, "every story is already passing");
        assert!(termination.contains(RESUME_EXITS), "{termination}");
        let refusal = guard_fresh_plan_write(true).unwrap_err();
        assert!(refusal.contains(FRESH_PLAN_DURING_RESUME), "{refusal}");

        let after = fs::read(&prd_path).unwrap();
        assert_eq!(before, after, "prd.json changed on the failing resume path");
    }
}
