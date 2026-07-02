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
/// best-effort — the orchestrator's per-story pushes retry later.
pub async fn create_fresh_branch(cwd: &Path, base_name: &str) -> BaroResult<String> {
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
        return push_branch_best_effort(cwd, &extra).await.map(|_| extra);
    }

    push_branch_best_effort(cwd, &branch_name).await?;
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
        return Err(
            format!("Failed to checkout branch '{}': {}", branch_name, stderr).into(),
        );
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
