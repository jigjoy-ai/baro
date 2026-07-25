//! Safety policy for reusing an existing branch across conversation runs.
//!
//! `--continue` is allowed to update an established Baro PR branch; it must
//! never turn an intake/planning retry into commits on the repository's
//! default branch merely because that happens to be the current checkout.

use std::path::Path;

use crate::git;

const PROTECTED_BRANCHES: [&str; 5] = ["main", "master", "trunk", "develop", "development"];

/// Re-read the checkout immediately before handing work to the orchestrator.
///
/// Branch creation/checkout and executor spawn are separated by asynchronous
/// persistence and event delivery. Treat the branch name returned by the git
/// setup step as authority, but never assume it is still the active checkout.
pub(crate) async fn verify_execution_branch(cwd: &Path, expected: &str) -> Result<(), String> {
    let actual = git::get_current_branch(cwd).await.map_err(|error| {
        format!(
            "Branch verification failed for expected '{expected}': {error}. Refusing to start the executor."
        )
    })?;
    verify_execution_branch_name(expected, &actual)
}

fn verify_execution_branch_name(expected: &str, actual: &str) -> Result<(), String> {
    if actual == expected {
        return Ok(());
    }
    Err(format!(
        "Branch verification failed: expected '{expected}', got '{actual}'. Refusing to start the executor."
    ))
}

pub(crate) fn verify_continuation_branch(
    current: &str,
    prd_branch_hint: Option<&str>,
) -> Result<String, String> {
    let current = current.trim();
    if current.is_empty() || current == "HEAD" {
        return Err("--continue requires a named branch checkout".to_string());
    }
    if PROTECTED_BRANCHES
        .iter()
        .any(|protected| current.eq_ignore_ascii_case(protected))
    {
        return Err(format!(
            "refusing --continue on protected branch '{current}'; check out the existing Baro PR branch first"
        ));
    }

    if let Some(hint) = prd_branch_hint
        .map(str::trim)
        .filter(|hint| !hint.is_empty())
    {
        let normalized = if hint.starts_with("baro/") {
            hint.to_string()
        } else {
            format!("baro/{hint}")
        };
        if current != normalized {
            return Err(format!(
                "--continue branch mismatch: current branch is '{current}', but prd.json owns '{normalized}'"
            ));
        }
        return Ok(current.to_string());
    }

    if !current.starts_with("baro/") {
        return Err(format!(
            "refusing --continue on unverified branch '{current}'; no matching Baro branch checkpoint was found"
        ));
    }
    Ok(current.to_string())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    use tempfile::tempdir;

    use super::*;

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

    #[test]
    fn continuation_requires_an_established_baro_branch() {
        assert_eq!(
            verify_continuation_branch("baro/auth-2", Some("baro/auth-2")).unwrap(),
            "baro/auth-2"
        );
        assert_eq!(
            verify_continuation_branch("baro/auth", Some("auth")).unwrap(),
            "baro/auth"
        );
        assert_eq!(
            verify_continuation_branch("baro/auth", None).unwrap(),
            "baro/auth"
        );
    }

    #[test]
    fn continuation_rejects_protected_detached_and_mismatched_checkouts() {
        for branch in ["main", "MASTER", "trunk", "HEAD", ""] {
            assert!(verify_continuation_branch(branch, None).is_err());
        }
        assert!(verify_continuation_branch("feature/manual", None).is_err());
        assert!(verify_continuation_branch("baro/other", Some("baro/auth")).is_err());
    }

    #[test]
    fn execution_branch_name_requires_an_exact_match() {
        assert!(verify_execution_branch_name("baro/auth-2", "baro/auth-2").is_ok());
        assert_eq!(
            verify_execution_branch_name("baro/auth-2", "main").unwrap_err(),
            "Branch verification failed: expected 'baro/auth-2', got 'main'. Refusing to start the executor."
        );
    }

    #[tokio::test]
    async fn execution_branch_guard_reads_the_live_checkout() {
        let root = tempdir().expect("temp root");
        let repo = root.path().join("repo");
        fs::create_dir(&repo).expect("repo dir");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Baro Test"]);
        git(&repo, &["config", "user.email", "baro@test.invalid"]);
        fs::write(repo.join("README.md"), "base\n").expect("seed file");
        git(&repo, &["add", "README.md"]);
        git(&repo, &["commit", "-m", "base"]);
        git(&repo, &["checkout", "-b", "baro/expected"]);

        verify_execution_branch(&repo, "baro/expected")
            .await
            .expect("expected checkout should pass");

        git(&repo, &["checkout", "main"]);
        let error = verify_execution_branch(&repo, "baro/expected")
            .await
            .expect_err("changed checkout must fail closed");
        assert!(error.contains("expected 'baro/expected', got 'main'"));
    }
}
