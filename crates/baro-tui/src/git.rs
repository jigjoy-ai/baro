//! Pre-orchestration git helpers. The TS orchestrator owns all
//! per-story git activity; this survives only for the welcome-screen →
//! planning flow, which sets up the `baro/<name>` branch before
//! handing off.

use std::path::Path;

use tokio::process::Command;

use crate::utils::BaroResult;

/// Return the name of the currently checked-out branch in `cwd`.
pub(crate) async fn get_current_branch(cwd: &Path) -> BaroResult<String> {
    let output = Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to get branch: {}", e))?;

    let branch_name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch_name.is_empty() {
        return Err("Could not determine current branch".into());
    }
    Ok(branch_name)
}

/// Create a fresh branch for a new baro run. ALWAYS appends a
/// timestamp suffix so runs from sibling clones sharing an origin
/// can't collide on `git push`. Returns the actual branch name;
/// callers must persist it in `prd.json` for resume. Push is
/// best-effort — the orchestrator's per-story pushes retry later. In
/// `BARO_LOCAL_ONLY=1` mode the branch stays local.
pub async fn create_fresh_branch(cwd: &Path, base_name: &str) -> BaroResult<String> {
    let publish_remote = std::env::var("BARO_LOCAL_ONLY").as_deref() != Ok("1");
    create_fresh_branch_with_publish(cwd, base_name, publish_remote).await
}

async fn create_fresh_branch_with_publish(
    cwd: &Path,
    base_name: &str,
    publish_remote: bool,
) -> BaroResult<String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 5 digits ≈ 28h of uniqueness, plenty between runs.
    let suffix = stamp % 100_000;
    let branch_name = format!("{}-{}", base_name, suffix);

    let create = Command::new("git")
        .args(["checkout", "-b", &branch_name])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to run git checkout -b: {}", e))?;

    if !create.status.success() {
        // Same-second name collision: retry once with a randomised
        // suffix, then surface the failure.
        let extra = format!("{}-x{:x}", branch_name, (stamp ^ 0xdeadbeef) & 0xffff);
        let retry = Command::new("git")
            .args(["checkout", "-b", &extra])
            .current_dir(cwd)
            .output()
            .await
            .map_err(|e| format!("Failed to retry git checkout -b: {}", e))?;
        if !retry.status.success() {
            let stderr = String::from_utf8_lossy(&retry.stderr).trim().to_string();
            return Err(format!(
                "Failed to create fresh branch (tried `{}` and `{}`): {}",
                branch_name, extra, stderr
            )
            .into());
        }
        if publish_remote {
            push_branch_best_effort(cwd, &extra).await?;
        } else {
            eprintln!("[git] local-only — not pushing {}", extra);
        }
        return Ok(extra);
    }

    if publish_remote {
        push_branch_best_effort(cwd, &branch_name).await?;
    } else {
        eprintln!("[git] local-only — not pushing {}", branch_name);
    }
    Ok(branch_name)
}

/// Checkout the exact branch a prior run persisted in `prd.json`
/// (same suffix) so resume picks up where the agents left off.
pub async fn checkout_existing_branch(cwd: &Path, branch_name: &str) -> BaroResult<()> {
    let checkout = Command::new("git")
        .args(["checkout", branch_name])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to run git checkout: {}", e))?;
    if !checkout.status.success() {
        let stderr = String::from_utf8_lossy(&checkout.stderr).trim().to_string();
        return Err(format!("Failed to checkout branch '{}': {}", branch_name, stderr).into());
    }
    Ok(())
}

async fn push_branch_best_effort(cwd: &Path, branch_name: &str) -> BaroResult<()> {
    // Preview/local runs have no origin (the cloud runner strips it in
    // diffOnly mode) — skip quietly instead of failing noisily.
    let has_origin = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !has_origin {
        eprintln!("[git] no origin remote — skipping push (preview/local run)");
        return Ok(());
    }
    let push = Command::new("git")
        .args(["push", "-u", "origin", branch_name])
        .current_dir(cwd)
        .output()
        .await;
    match push {
        Ok(output) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            eprintln!(
                "[git] push -u origin {} failed (best-effort): {}",
                branch_name, stderr
            );
        }
        Err(e) => {
            eprintln!(
                "[git] push -u origin {} failed (best-effort): {}",
                branch_name, e
            );
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::process::Command as StdCommand;

    use tempfile::tempdir;

    use super::create_fresh_branch_with_publish;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git")
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

    #[tokio::test]
    async fn local_only_branch_does_not_publish_to_origin() {
        let root = tempdir().expect("temp root");
        let repo = root.path().join("repo");
        let origin = root.path().join("origin.git");
        fs::create_dir(&repo).expect("repo dir");
        fs::create_dir(&origin).expect("origin dir");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Baro Test"]);
        git(&repo, &["config", "user.email", "baro@test.invalid"]);
        fs::write(repo.join("README.md"), "base\n").expect("seed file");
        git(&repo, &["add", "README.md"]);
        git(&repo, &["commit", "-m", "base"]);
        git(&origin, &["init", "--bare"]);
        git(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                origin.to_str().expect("origin path"),
            ],
        );

        let branch = create_fresh_branch_with_publish(&repo, "baro/local", false)
            .await
            .expect("local branch");

        assert_eq!(git(&repo, &["branch", "--show-current"]), branch);
        assert_eq!(git(&origin, &["for-each-ref", "--format=%(refname)"]), "");
    }
}
