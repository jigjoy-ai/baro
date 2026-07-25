//! Resume branch authority and asynchronous refine-result guards.

use std::path::Path;

use crate::app::Screen;
use crate::{executor, git};

pub(crate) fn canonical_branch(branch_name: &str) -> Result<String, String> {
    let mut branch = branch_name.trim().to_string();
    if branch.is_empty() {
        return Err("saved PRD has an empty branchName".to_string());
    }
    while branch.starts_with("baro/baro/") {
        branch = branch["baro/".len()..].to_string();
    }
    if !branch.starts_with("baro/") {
        branch = format!("baro/{branch}");
    }
    if branch == "baro/" {
        return Err("saved PRD has an empty Baro branch name".to_string());
    }
    Ok(branch)
}

pub(crate) fn should_accept_refine_result(
    screen: Screen,
    refining: bool,
    active_generation: Option<u64>,
    result_generation: u64,
) -> bool {
    screen == Screen::Review && refining && active_generation == Some(result_generation)
}

/// Establish the saved branch before its repository files or PRD become
/// resume authority. The post-checkout reload prevents a stale copy from the
/// previously checked-out branch overwriting newer completion/runtime state.
pub(crate) async fn checkout_and_load_prd(
    cwd: &Path,
    saved_branch_name: &str,
) -> Result<executor::PrdFile, String> {
    let expected_branch = canonical_branch(saved_branch_name)?;
    git::checkout_existing_branch(cwd, &expected_branch)
        .await
        .map_err(|error| format!("failed to checkout saved branch '{expected_branch}': {error}"))?;
    let actual_branch = git::get_current_branch(cwd)
        .await
        .map_err(|error| format!("failed to verify resume branch: {error}"))?;
    if actual_branch != expected_branch {
        return Err(format!(
            "resume branch mismatch: expected '{expected_branch}', got '{actual_branch}'"
        ));
    }

    let prd_path = cwd.join("prd.json");
    let contents = std::fs::read_to_string(&prd_path)
        .map_err(|error| format!("failed to read target-branch prd.json: {error}"))?;
    let mut prd: executor::PrdFile = serde_json::from_str(&contents)
        .map_err(|error| format!("failed to parse target-branch prd.json: {error}"))?;
    let target_branch = canonical_branch(&prd.branch_name)?;
    if target_branch != expected_branch {
        return Err(format!(
            "target-branch prd.json points to '{target_branch}', expected '{expected_branch}'"
        ));
    }
    // Canonicalize legacy bare names before any later persistence/spawn.
    prd.branch_name = expected_branch;
    Ok(prd)
}

#[cfg(test)]
mod tests {
    use super::{canonical_branch, should_accept_refine_result};
    use crate::app::Screen;

    #[test]
    fn branch_names_are_canonical_before_persistence() {
        assert_eq!(canonical_branch("run-123").unwrap(), "baro/run-123");
        assert_eq!(canonical_branch("baro/run-123").unwrap(), "baro/run-123");
        assert_eq!(
            canonical_branch("baro/baro/run-123").unwrap(),
            "baro/run-123"
        );
        assert!(canonical_branch("  ").is_err());
    }

    #[test]
    fn refine_results_require_matching_generation_and_review_state() {
        assert!(should_accept_refine_result(
            Screen::Review,
            true,
            Some(7),
            7
        ));
        assert!(!should_accept_refine_result(
            Screen::Review,
            true,
            Some(8),
            7
        ));
        assert!(!should_accept_refine_result(
            Screen::Execute,
            true,
            Some(7),
            7
        ));
        assert!(!should_accept_refine_result(
            Screen::Review,
            false,
            Some(7),
            7
        ));
    }
}
