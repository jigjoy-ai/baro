//! Resume branch authority and asynchronous refine-result guards.

use std::path::Path;

use crate::app::Screen;
use crate::run_state::{self, RunState};
use crate::{executor, git};

#[derive(Debug)]
pub enum ResumeDetection {
    None,
    Resumable(RunState),
    MissingBranch { run_id: String, branch: String },
}

pub async fn detect_resume(cwd: &Path) -> ResumeDetection {
    classify_saved_run(cwd, run_state::find_resumable(cwd)).await
}

async fn classify_saved_run(cwd: &Path, saved: Option<RunState>) -> ResumeDetection {
    let Some(state) = saved else {
        return ResumeDetection::None;
    };
    let branch = canonical_branch(&state.branch).unwrap_or_else(|_| state.branch.clone());
    match git::branch_ref_exists(cwd, &branch).await {
        Ok(false) => ResumeDetection::MissingBranch {
            run_id: state.run_id,
            branch,
        },
        _ => ResumeDetection::Resumable(state),
    }
}

pub fn missing_branch_offer(run_id: &str, branch: &str) -> String {
    format!(
        "Saved run {run_id} targets branch '{branch}', which no longer exists. \
         [d] discard saved run  [f] discard and start fresh"
    )
}

/// Answers the missing-branch offer before any terminal takeover. Returns
/// whether the launch should continue with a fresh run.
pub fn resolve_missing_branch(
    cli: &crate::cli::cli::Cli,
    run_id: &str,
    branch: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let cwd = std::path::Path::new(&cli.cwd);
    let discard = || -> std::io::Result<()> {
        match run_state::find_resumable(cwd) {
            Some(state) if state.run_id == run_id => run_state::discard(&state),
            _ => Ok(()),
        }
    };
    let offer = missing_branch_offer(run_id, branch);
    if cli.headless || cli.detach {
        if cli.goal.is_some() {
            discard()?;
            eprintln!("baro: discarded saved run {run_id}; starting fresh");
            return Ok(true);
        }
        println!("{offer}\nrerun with a goal to start fresh");
        return Ok(false);
    }
    eprintln!("baro: {offer}");
    loop {
        eprint!("> ");
        let mut answer = String::new();
        if std::io::stdin().read_line(&mut answer)? == 0 {
            return Ok(false);
        }
        match answer.trim() {
            "d" | "D" => {
                discard()?;
                eprintln!("baro: discarded saved run {run_id}");
                return Ok(false);
            }
            "f" | "F" => {
                discard()?;
                return Ok(true);
            }
            _ => eprintln!("baro: answer d or f"),
        }
    }
}

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

/// Load the saved PRD once its goal ref exists; no checkout happens.
pub(crate) async fn checkout_and_load_prd(
    cwd: &Path,
    prd_path: &Path,
    saved_branch_name: &str,
) -> Result<executor::PrdFile, String> {
    let expected_branch = canonical_branch(saved_branch_name)?;
    if !git::branch_ref_exists(cwd, &expected_branch).await? {
        return Err(format!(
            "cannot establish resume branch '{expected_branch}': branch does not exist"
        ));
    }

    let contents = std::fs::read_to_string(prd_path)
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
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    use tempfile::tempdir;

    use super::{
        canonical_branch, checkout_and_load_prd, classify_saved_run, missing_branch_offer,
        should_accept_refine_result, ResumeDetection,
    };
    use crate::app::Screen;
    use crate::run_state::{create_run_in, find_resumable_in};

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git command should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn repo_on_main(root: &Path) -> std::path::PathBuf {
        let repo = root.join("repo");
        fs::create_dir(&repo).expect("repo dir");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Baro Test"]);
        git(&repo, &["config", "user.email", "baro@test.invalid"]);
        fs::write(repo.join("README.md"), "base\n").expect("seed file");
        git(&repo, &["add", "README.md"]);
        git(&repo, &["commit", "-m", "base"]);
        repo
    }

    #[tokio::test]
    async fn resume_loads_existing_goal_branch_without_checkout() {
        let root = tempdir().expect("temp root");
        let repo = repo_on_main(root.path());
        git(&repo, &["branch", "baro/run-1"]);
        let head = git(&repo, &["rev-parse", "HEAD"]);
        fs::write(
            repo.join("prd.json"),
            r#"{"project":"p","branchName":"run-1","userStories":[]}"#,
        )
        .expect("prd");

        let prd = checkout_and_load_prd(&repo, &repo.join("prd.json"), "run-1")
            .await
            .expect("resume should load");

        assert_eq!(prd.branch_name, "baro/run-1");
        assert_eq!(git(&repo, &["branch", "--show-current"]), "main");
        assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
    }

    #[tokio::test]
    async fn resume_rejects_missing_goal_branch() {
        let root = tempdir().expect("temp root");
        let repo = repo_on_main(root.path());
        let head = git(&repo, &["rev-parse", "HEAD"]);

        let error = checkout_and_load_prd(&repo, &repo.join("prd.json"), "baro/gone")
            .await
            .expect_err("missing ref must fail");

        assert_eq!(
            error,
            "cannot establish resume branch 'baro/gone': branch does not exist"
        );
        assert_eq!(git(&repo, &["branch", "--show-current"]), "main");
        assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
    }

    #[tokio::test]
    async fn resume_detection_offers_discard_when_saved_branch_is_missing() {
        let root = tempdir().expect("temp root");
        let home = root.path().join("baro-home");
        let repo = repo_on_main(root.path());
        create_run_in(&home, &repo, "baro/gone", "run-7".into()).expect("run state");

        let detection = classify_saved_run(&repo, find_resumable_in(&home, &repo)).await;

        match detection {
            ResumeDetection::MissingBranch { run_id, branch } => {
                assert_eq!(run_id, "run-7");
                assert_eq!(branch, "baro/gone");
                let offer = missing_branch_offer(&run_id, &branch);
                assert_eq!(
                    offer,
                    "Saved run run-7 targets branch 'baro/gone', which no longer exists. \
                     [d] discard saved run  [f] discard and start fresh"
                );
            }
            other => panic!("expected MissingBranch, got {other:?}"),
        }

        git(&repo, &["branch", "baro/gone"]);
        let detection = classify_saved_run(&repo, find_resumable_in(&home, &repo)).await;
        assert!(matches!(detection, ResumeDetection::Resumable(state) if state.run_id == "run-7"));
        assert!(matches!(
            classify_saved_run(&repo, None).await,
            ResumeDetection::None
        ));
    }

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
