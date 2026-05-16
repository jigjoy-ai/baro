//! Locating the baro repo / TS toolchain from inside the Rust binary.
//!
//! Multiple Rust callers need to spawn TS subprocesses against the
//! same baro repo: `orchestrator_client` runs `cli.ts`, the new
//! `architect_runner` runs `run-architect.ts`, and Phase 5+ will add
//! a `planner_runner` for `run-planner.ts`. They all need to answer:
//! "where does the TS code live?" — and the answer depends on how
//! baro was installed (production bundle vs. `npm install` in the
//! repo we cloned for development).
//!
//! Production support is on the caller's side (orchestrator_client
//! knows how to find a co-located `cli.mjs`); this module only
//! provides the dev-repo walk-up that every caller shares.

use std::path::{Path, PathBuf};

/// Marker file used to confirm a candidate directory is the baro
/// repo root. Picked because it's the file orchestrator_client has
/// always used, so introducing this helper doesn't change discovery
/// semantics for any existing caller.
const REPO_MARKER: &str = "packages/baro-orchestrator/scripts/cli.ts";

/// Walk upward from the running binary (and, as a fallback, from
/// `cwd`) looking for a directory that contains `REPO_MARKER`.
/// Returns the first match.
///
/// Used in dev mode where baro is run out of a cloned repo with
/// `cargo run` or via the release binary in `target/release/`.
pub fn find_dev_repo(cwd: &Path) -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        while let Some(d) = dir {
            if d.join(REPO_MARKER).exists() {
                return Some(d);
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }

    if cwd.join(REPO_MARKER).exists() {
        return Some(cwd.to_path_buf());
    }

    None
}

/// Path to `tsx` inside the repo's `node_modules`. Returns `None` if
/// the repo hasn't been `npm install`-ed yet — callers surface this
/// as a clear "run npm install in the baro repo" error.
pub fn find_tsx(repo: &Path) -> Option<PathBuf> {
    let p = repo.join("node_modules/.bin/tsx");
    if p.exists() { Some(p) } else { None }
}
