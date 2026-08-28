//! The decision a resume run makes when one of its own preconditions turns out
//! to be false. Kept pure, next to `decide_launch`, so that "Resume plus a
//! violated assumption" can never be answered by falling through to planning:
//! the answer is a value the caller has to act on, not a branch it can skip.

// Every item here is called from main.rs, which lands separately; until then
// the binary target sees them as unreachable.
#![allow(dead_code)]

use crate::cli::launch::LaunchMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrdState {
    Absent,
    /// The file is there but could not be read or parsed as a plan; this is the
    /// state that used to collapse to "no prd at all".
    Unreadable,
    Loaded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeAssumption {
    PrdReadable,
    PrdPresent,
    UnfinishedStories,
    ResumeBranch,
    BranchAuthority,
}

impl ResumeAssumption {
    pub fn name(self) -> &'static str {
        match self {
            ResumeAssumption::PrdReadable => "prd.json is readable and parses as a plan",
            ResumeAssumption::PrdPresent => "prd.json exists in the working directory",
            ResumeAssumption::UnfinishedStories => {
                "the saved plan still has at least one unfinished story"
            }
            ResumeAssumption::ResumeBranch => {
                "the saved resume branch exists and can be checked out"
            }
            ResumeAssumption::BranchAuthority => {
                "the checked-out branch matches the saved plan's branch"
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumeGate {
    Proceed,
    Terminate { assumption: ResumeAssumption, detail: String },
}

pub const RESUME_ASSUMPTION_PREFIX: &str =
    "baro: resume was decided for this run, but the resume assumption";
pub const RESUME_EXITS: &str = "Baro will not fall back to planning. Either run `baro --continue` to re-plan on top of the existing work, or delete prd.json to start a completely fresh run.";

/// The detail text belongs to the call site, so a `Terminate` carries an empty
/// one; callers pass their own into [`resume_failure_message`].
pub fn decide_resume_continuation(
    launch_mode: LaunchMode,
    prd_state: PrdState,
    has_incomplete_stories: bool,
) -> ResumeGate {
    let terminate =
        |assumption| ResumeGate::Terminate { assumption, detail: String::new() };

    // An unparseable prd.json is a fault under any inferred mode: only an
    // operator who named the mode themselves gets to walk past it.
    if prd_state == PrdState::Unreadable && launch_mode != LaunchMode::Explicit {
        return terminate(ResumeAssumption::PrdReadable);
    }
    if launch_mode != LaunchMode::Resume {
        return ResumeGate::Proceed;
    }
    if prd_state == PrdState::Absent {
        return terminate(ResumeAssumption::PrdPresent);
    }
    if !has_incomplete_stories {
        return terminate(ResumeAssumption::UnfinishedStories);
    }
    ResumeGate::Proceed
}

pub fn resume_failure_message(assumption: ResumeAssumption, detail: &str) -> String {
    let name = assumption.name();
    if detail.is_empty() {
        format!("{RESUME_ASSUMPTION_PREFIX} \"{name}\" does not hold\n{RESUME_EXITS}")
    } else {
        format!("{RESUME_ASSUMPTION_PREFIX} \"{name}\" does not hold: {detail}\n{RESUME_EXITS}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_ASSUMPTIONS: [ResumeAssumption; 5] = [
        ResumeAssumption::PrdReadable,
        ResumeAssumption::PrdPresent,
        ResumeAssumption::UnfinishedStories,
        ResumeAssumption::ResumeBranch,
        ResumeAssumption::BranchAuthority,
    ];

    fn terminating(assumption: ResumeAssumption) -> ResumeGate {
        ResumeGate::Terminate { assumption, detail: String::new() }
    }

    #[test]
    fn every_mode_state_and_story_combination_lands_where_the_rule_table_says() {
        let expected = |mode: LaunchMode, state: PrdState, has_incomplete: bool| match (
            mode, state, has_incomplete,
        ) {
            (LaunchMode::Explicit, PrdState::Unreadable, _) => ResumeGate::Proceed,
            (_, PrdState::Unreadable, _) => terminating(ResumeAssumption::PrdReadable),
            (LaunchMode::Fresh, _, _) | (LaunchMode::Explicit, _, _) => ResumeGate::Proceed,
            (LaunchMode::Resume, PrdState::Absent, _) => terminating(ResumeAssumption::PrdPresent),
            (LaunchMode::Resume, PrdState::Loaded, false) => {
                terminating(ResumeAssumption::UnfinishedStories)
            }
            (LaunchMode::Resume, PrdState::Loaded, true) => ResumeGate::Proceed,
        };

        let mut cases = 0;
        for mode in [LaunchMode::Fresh, LaunchMode::Resume, LaunchMode::Explicit] {
            for state in [PrdState::Absent, PrdState::Unreadable, PrdState::Loaded] {
                for has_incomplete in [false, true] {
                    let gate = decide_resume_continuation(mode, state, has_incomplete);
                    assert_eq!(
                        gate,
                        expected(mode, state, has_incomplete),
                        "{mode:?} {state:?} has_incomplete={has_incomplete}"
                    );
                    cases += 1;
                }
            }
        }
        assert_eq!(cases, 18);
    }

    #[test]
    fn a_resume_whose_assumption_is_violated_never_proceeds() {
        for state in [PrdState::Absent, PrdState::Unreadable, PrdState::Loaded] {
            for has_incomplete in [false, true] {
                let violated = state != PrdState::Loaded || !has_incomplete;
                if !violated {
                    continue;
                }
                let gate = decide_resume_continuation(LaunchMode::Resume, state, has_incomplete);
                assert_ne!(
                    gate,
                    ResumeGate::Proceed,
                    "resume with {state:?} has_incomplete={has_incomplete} fell through to planning"
                );
            }
        }
    }

    #[test]
    fn a_healthy_resume_proceeds_on_the_plan_that_came_off_disk() {
        assert_eq!(
            decide_resume_continuation(LaunchMode::Resume, PrdState::Loaded, true),
            ResumeGate::Proceed
        );
    }

    #[test]
    fn the_failure_message_names_the_assumption_and_both_honest_exits() {
        for assumption in ALL_ASSUMPTIONS {
            let message = resume_failure_message(assumption, "the branch baro/x is gone");

            assert!(message.contains(assumption.name()), "{message}");
            assert!(message.contains(RESUME_ASSUMPTION_PREFIX), "{message}");
            assert!(message.contains("the branch baro/x is gone"), "{message}");
            assert!(message.contains(RESUME_EXITS), "{message}");
            assert!(message.contains("--continue"), "{message}");
            assert!(message.contains("prd.json"), "{message}");
        }
    }

    #[test]
    fn an_empty_detail_leaves_no_dangling_colon() {
        let message = resume_failure_message(ResumeAssumption::PrdPresent, "");

        assert!(message.contains("does not hold\n"), "{message}");
        assert!(!message.contains("does not hold: "), "{message}");
        assert!(message.contains(RESUME_EXITS), "{message}");
    }
}
