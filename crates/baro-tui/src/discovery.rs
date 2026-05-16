//! Locating TS subprocess entry points from inside the Rust binary.
//!
//! Three Rust callers spawn TS subprocesses, and they all need to
//! answer the same question — "where does this TS script live?" —
//! whose answer depends on how baro was installed:
//!
//!   `orchestrator_client` runs `cli.ts` / `cli.mjs`
//!   `architect_runner`    runs `run-architect.ts` / `run-architect.mjs`
//!   `planner_runner`      runs `run-planner.ts`   / `run-planner.mjs`
//!
//! Three install modes to resolve, in priority order:
//!
//!   1. Production bundle co-located with the binary
//!      (`~/.baro/bin/<script>.mjs` after `npm install -g baro-ai`
//!      runs postinstall). Runs via `node`.
//!
//!   2. Local-install bundle inside the project being orchestrated
//!      (`<cwd>/node_modules/baro-ai/dist/<script>.mjs`). Runs via
//!      `node`.
//!
//!   3. Dev tsx — walk upward from the binary (and cwd) looking for
//!      `packages/baro-orchestrator/scripts/cli.ts` as a marker.
//!      Runs via `<repo>/node_modules/.bin/tsx <script>.ts`.

use std::path::{Path, PathBuf};

/// Marker file used to confirm a candidate directory is the baro
/// repo root. `cli.ts` is the file orchestrator_client has always
/// used; the new architect / planner runners share this marker so
/// dev-repo discovery is identical across all three.
const REPO_MARKER: &str = "packages/baro-orchestrator/scripts/cli.ts";

/// Resolved subprocess entry for a TS script.
#[derive(Debug)]
pub enum ScriptEntry {
    /// Production-bundled `.mjs` next to the binary or inside the
    /// project's `node_modules`. Invoke with `node <path>`.
    NodeJs(PathBuf),
    /// Dev mode — invoke with `<tsx> <script>` from a cloned baro
    /// repo with `npm install` already run.
    Tsx { tsx: PathBuf, script: PathBuf },
}

/// Locate a TS script by name across the three install modes.
///
/// `ts_rel` is the relative path of the dev-mode source script
/// inside the baro repo, e.g.
/// `"packages/baro-orchestrator/scripts/run-architect.ts"`.
///
/// `bundle_name` is the filename of the production-bundled `.mjs`
/// (no path), e.g. `"run-architect.mjs"`.
pub fn locate_script(
    cwd: &Path,
    ts_rel: &str,
    bundle_name: &str,
) -> Result<ScriptEntry, String> {
    // (1) Co-located bundle next to the running binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let sibling = parent.join(bundle_name);
            if sibling.exists() {
                return Ok(ScriptEntry::NodeJs(sibling));
            }
        }
    }

    // (2) Local-install bundle in the project being orchestrated.
    let bundled = cwd.join(format!("node_modules/baro-ai/dist/{}", bundle_name));
    if bundled.exists() {
        return Ok(ScriptEntry::NodeJs(bundled));
    }

    // (3) Dev tsx — walk-up + node_modules/.bin/tsx.
    let repo = find_dev_repo(cwd).ok_or_else(|| {
        format!(
            "could not locate baro: no `{}` next to the binary, no \
             `node_modules/baro-ai/dist/{}` in the project, and no baro repo \
             found by walking up from the binary or the project cwd. Either \
             `npm install -g baro-ai` (re-runs postinstall and stages the bundles), \
             or run baro out of a cloned baro source tree with `npm install` \
             complete.",
            bundle_name, bundle_name,
        )
    })?;
    let tsx = find_tsx(&repo).ok_or_else(|| {
        format!(
            "tsx not found at {}/node_modules/.bin/tsx — run `npm install` in the baro repo",
            repo.display()
        )
    })?;
    let script = repo.join(ts_rel);
    Ok(ScriptEntry::Tsx { tsx, script })
}

/// Walk upward from the running binary (and, as a fallback, from
/// `cwd`) looking for a directory that contains `REPO_MARKER`.
/// Returns the first match.
///
/// Public so `orchestrator_client` can still use it for legacy
/// reasons; new callers should prefer `locate_script` which already
/// covers the production bundle case.
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
/// the repo hasn't been `npm install`-ed yet.
pub fn find_tsx(repo: &Path) -> Option<PathBuf> {
    let p = repo.join("node_modules/.bin/tsx");
    if p.exists() { Some(p) } else { None }
}
