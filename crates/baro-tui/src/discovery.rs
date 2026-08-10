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
                check_staged_dependency_link(parent)?;
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

/// The staged bundles import their externalized dependencies through a
/// `node_modules` link beside them. It can be left pointing at a directory that
/// no longer exists — an install that ran from a temporary checkout claims the
/// link, then that checkout goes away. Node then fails at import time, before
/// any of our code runs, with a missing-package error naming neither the link
/// nor the repair. Say it here instead, while there is still a sentence to say.
pub fn check_staged_dependency_link(staged_dir: &Path) -> Result<(), String> {
    let link = staged_dir.join("node_modules");
    let Ok(target) = std::fs::read_link(&link) else {
        return Ok(());
    };
    if target.exists() {
        return Ok(());
    }
    Err(format!(
        "{} points at {}, which no longer exists, so the bundled orchestrator \
         cannot import its dependencies. Re-run `npm install -g baro-ai` to \
         restage it, or delete the link if the dependencies are already \
         resolvable beside the bundles.",
        link.display(),
        target.display(),
    ))
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

#[cfg(test)]
mod tests {
    use super::check_staged_dependency_link;

    #[test]
    fn a_link_into_a_deleted_directory_is_named_before_node_trips_on_it() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("was-a-worktree");
        std::fs::create_dir(&gone).unwrap();
        std::os::unix::fs::symlink(&gone, dir.path().join("node_modules")).unwrap();
        std::fs::remove_dir(&gone).unwrap();

        let error = check_staged_dependency_link(dir.path()).unwrap_err();
        assert!(error.contains("node_modules"), "{error}");
        assert!(error.contains("was-a-worktree"), "the dead target: {error}");
        assert!(error.contains("npm install -g baro-ai"), "the repair: {error}");
    }

    #[test]
    fn a_link_that_still_resolves_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, dir.path().join("node_modules")).unwrap();

        assert!(check_staged_dependency_link(dir.path()).is_ok());
    }

    #[test]
    fn no_link_at_all_is_not_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        assert!(check_staged_dependency_link(dir.path()).is_ok());
    }
}
