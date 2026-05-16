//! Pre-orchestration git helpers used by main.rs.
//!
//! The TS Mozaik orchestrator (`packages/baro-orchestrator/src/git.ts`)
//! owns all per-story git activity (push with retry, pull --rebase,
//! file-stat collection). This module survives only for the
//! welcome-screen → planning flow which still needs to set up the
//! `baro/<name>` branch in Rust before handing control off to the
//! orchestrator.

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

/// Create a fresh branch for a new baro run. ALWAYS produces a new
/// branch — appends a Unix-timestamp suffix to the requested base name
/// so two runs against the same project (e.g. side-by-side
/// `--llm claude` / `--llm openai` from sibling clones sharing an
/// origin) can't collide on `git push`. Returns the actual full
/// branch name used; callers should persist it in `prd.json` so
/// resume can pick the same branch later.
///
/// Push is best-effort: failures are logged to stderr but don't fail
/// the function. Subsequent per-story pushes from the orchestrator
/// will retry.
pub async fn create_fresh_branch(cwd: &Path, base_name: &str) -> BaroResult<String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Modulo to keep the suffix short and readable; 5 digits handles
    // ~28 hours of uniqueness which is plenty between runs.
    let suffix = stamp % 100_000;
    let branch_name = format!("{}-{}", base_name, suffix);

    let create = Command::new("git")
        .args(["checkout", "-b", &branch_name])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to run git checkout -b: {}", e))?;

    if !create.status.success() {
        // Same-second name collision (very rare); fall through to a
        // randomised suffix once. Beyond that, surface the failure.
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
        return push_branch_best_effort(cwd, &extra).await.map(|_| extra);
    }

    push_branch_best_effort(cwd, &branch_name).await?;
    Ok(branch_name)
}

/// Checkout an existing local branch for a resumed run.
///
/// Used when `prd.json` already has a `branchName` from an earlier
/// `create_fresh_branch` call; the resume path needs that exact
/// branch (with the same suffix the prior run wrote) so it can pick
/// up where the agents left off.
pub async fn checkout_existing_branch(cwd: &Path, branch_name: &str) -> BaroResult<()> {
    let checkout = Command::new("git")
        .args(["checkout", branch_name])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to run git checkout: {}", e))?;
    if !checkout.status.success() {
        let stderr = String::from_utf8_lossy(&checkout.stderr).trim().to_string();
        return Err(
            format!("Failed to checkout branch '{}': {}", branch_name, stderr).into(),
        );
    }
    Ok(())
}

async fn push_branch_best_effort(cwd: &Path, branch_name: &str) -> BaroResult<()> {
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
