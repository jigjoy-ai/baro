//! Locate TS subprocess entry points from the Rust binary. Where a
//! script lives depends on install mode, tried in priority order:
//! production bundle co-located with the binary (`~/.baro/bin/*.mjs`),
//! local-install bundle in the project's `node_modules/baro-ai/dist`,
//! then dev mode — walk up from the binary/cwd to the repo root and
//! run the `.ts` source via `node_modules/.bin/tsx`.

use std::path::{Path, PathBuf};

/// Marker confirming a candidate directory is the baro repo root.
const REPO_MARKER: &str = "packages/baro-orchestrator/scripts/cli.ts";

/// Resolved subprocess entry for a TS script.
#[derive(Debug)]
pub enum ScriptEntry {
    /// Bundled `.mjs` — invoke with `node <path>`.
    NodeJs(PathBuf),
    /// Dev mode — invoke with `<tsx> <script>`.
    Tsx { tsx: PathBuf, script: PathBuf },
}

/// Locate a TS script across the install modes. `ts_rel` is the
/// dev-mode source path inside the repo; `bundle_name` the bundled
/// `.mjs` filename (no path).
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

/// Walk upward from the running binary (fallback: `cwd`) to the first
/// directory containing `REPO_MARKER`. Prefer `locate_script`, which
/// also covers the production-bundle modes.
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

/// Path to `tsx` in the repo's `node_modules`, if installed.
pub fn find_tsx(repo: &Path) -> Option<PathBuf> {
    let p = repo.join("node_modules/.bin/tsx");
    if p.exists() { Some(p) } else { None }
}
