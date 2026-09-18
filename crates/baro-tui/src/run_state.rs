//! Per-run state under `baro_home()/runs/<runId>/`, so a run never leaves
//! prd.json behind in the checkout.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::baro_home::baro_home;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Active,
    Finished,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RunState {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub checkout: String,
    pub branch: String,
    pub status: RunStatus,
    #[serde(skip)]
    dir: PathBuf,
}

impl RunState {
    pub fn prd_path(&self) -> PathBuf {
        self.dir.join("prd.json")
    }

    fn save(&self) -> io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let body = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.dir)?;
        io::Write::write_all(&mut temporary, format!("{body}\n").as_bytes())?;
        temporary
            .persist(self.dir.join("run.json"))
            .map_err(|e| e.error)?;
        Ok(())
    }
}

fn canonical_checkout(cwd: &Path) -> String {
    std::fs::canonicalize(cwd)
        .unwrap_or_else(|_| cwd.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

// FNV-1a: std's DefaultHasher is not guaranteed stable across releases.
fn stable_hash(text: &str) -> u32 {
    text.bytes().fold(0x811c_9dc5_u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)
    })
}

fn new_run_id(checkout: &str) -> String {
    if let Some(id) = std::env::var("BARO_RUN_ID")
        .ok()
        .filter(|id| !id.trim().is_empty())
    {
        return id;
    }
    let unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{unix_ms}-{:08x}", stable_hash(checkout))
}

fn runs_dir(home: &Path) -> PathBuf {
    home.join("runs")
}

pub fn create_run(cwd: &Path, branch: &str) -> io::Result<RunState> {
    let run_id = new_run_id(&canonical_checkout(cwd));
    create_run_in(&baro_home(), cwd, branch, run_id)
}

pub(crate) fn create_run_in(
    home: &Path,
    cwd: &Path,
    branch: &str,
    run_id: String,
) -> io::Result<RunState> {
    let checkout = canonical_checkout(cwd);
    let state = RunState {
        dir: runs_dir(home).join(&run_id),
        run_id,
        checkout,
        branch: branch.to_string(),
        status: RunStatus::Active,
    };
    state.save()?;
    Ok(state)
}

pub fn find_resumable(cwd: &Path) -> Option<RunState> {
    find_resumable_in(&baro_home(), cwd)
}

pub(crate) fn find_resumable_in(home: &Path, cwd: &Path) -> Option<RunState> {
    let checkout = canonical_checkout(cwd);
    // runs/ also holds flat audit logs; only subdirectories with run.json count.
    let mut candidates: Vec<(SystemTime, RunState)> = std::fs::read_dir(runs_dir(home))
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let dir = entry.path();
            let file = dir.join("run.json");
            let modified = std::fs::metadata(&file).and_then(|m| m.modified()).ok()?;
            let raw = std::fs::read_to_string(&file).ok()?;
            let mut state: RunState = serde_json::from_str(&raw).ok()?;
            state.dir = dir;
            (state.checkout == checkout && state.status != RunStatus::Finished)
                .then_some((modified, state))
        })
        .collect();
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.run_id.cmp(&a.1.run_id)));
    candidates.into_iter().next().map(|(_, state)| state)
}

pub fn mark_finished(state: &RunState) -> io::Result<()> {
    let mut finished = state.clone();
    finished.status = RunStatus::Finished;
    finished.save()
}

pub fn discard(state: &RunState) -> io::Result<()> {
    match std::fs::remove_dir_all(&state.dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

enum Location {
    Run(RunState),
    // Legacy resume: a pre-#140 prd.json in the checkout stays where it is.
    Checkout,
}

static ACTIVE: Mutex<Option<Location>> = Mutex::new(None);

fn active() -> std::sync::MutexGuard<'static, Option<Location>> {
    ACTIVE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn activate(state: RunState) {
    *active() = Some(Location::Run(state));
}

pub fn activate_legacy() {
    *active() = Some(Location::Checkout);
}

/// Directory that receives this run's prd.json, creating the run on first use.
pub fn prd_dir(cwd: &Path, branch: &str) -> io::Result<PathBuf> {
    let mut guard = active();
    match guard.as_mut() {
        Some(Location::Checkout) => Ok(cwd.to_path_buf()),
        Some(Location::Run(state)) => {
            if state.branch != branch {
                state.branch = branch.to_string();
                state.save()?;
            }
            Ok(state.dir.clone())
        }
        None => {
            let state = create_run(cwd, branch)?;
            let dir = state.dir.clone();
            *guard = Some(Location::Run(state));
            Ok(dir)
        }
    }
}

pub fn prd_path(cwd: &Path) -> PathBuf {
    match active().as_ref() {
        Some(Location::Run(state)) => state.prd_path(),
        _ => cwd.join("prd.json"),
    }
}

/// Called only on success; a failed run stays resumable.
pub fn finish_active() {
    let mut guard = active();
    if let Some(Location::Run(state)) = guard.as_ref() {
        if let Err(error) = mark_finished(state) {
            eprintln!(
                "[baro] warning: could not mark run {} finished: {error}",
                state.run_id
            );
        }
    }
    *guard = None;
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    use tempfile::tempdir;

    use super::*;
    use crate::cli::session::SessionLock;
    use crate::executor;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git command should start");
        assert!(output.status.success(), "git {args:?} failed");
        String::from_utf8_lossy(&output.stdout).to_string()
    }

    fn repo(root: &Path) -> PathBuf {
        let repo = root.join("repo");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Baro Test"]);
        git(&repo, &["config", "user.email", "baro@test.invalid"]);
        fs::write(repo.join("README.md"), "base\n").unwrap();
        git(&repo, &["add", "README.md"]);
        git(&repo, &["commit", "-m", "base"]);
        repo
    }

    fn run_to_end(home: &Path, repo: &Path, succeed: bool) -> RunState {
        let lock = SessionLock::acquire(repo).expect("lock");
        let state = create_run_in(home, repo, "baro/goal", "run-goal".into()).expect("create run");
        let prd = executor::PrdFile {
            project: "p".into(),
            branch_name: "baro/goal".into(),
            ..Default::default()
        };
        executor::write_prd(&prd, &state.dir).expect("write prd");
        if succeed {
            mark_finished(&state).expect("finish");
        }
        drop(lock);
        state
    }

    #[test]
    fn run_state_lives_under_baro_home_and_leaves_checkout_clean() {
        for succeed in [true, false] {
            let root = tempdir().unwrap();
            let home = root.path().join("baro-home");
            let repo = repo(root.path());

            let state = run_to_end(&home, &repo, succeed);

            let dir = home.join("runs").join(&state.run_id);
            assert!(dir.join("prd.json").is_file());
            let saved: RunState =
                serde_json::from_str(&fs::read_to_string(dir.join("run.json")).unwrap()).unwrap();
            assert_eq!(saved.run_id, state.run_id);
            assert_eq!(saved.branch, "baro/goal");
            assert_eq!(saved.checkout, canonical_checkout(&repo));
            let expected = if succeed {
                RunStatus::Finished
            } else {
                RunStatus::Active
            };
            assert_eq!(saved.status, expected);
            assert_eq!(git(&repo, &["status", "--porcelain", "--ignored"]), "");
        }
    }

    #[test]
    fn run_state_resumable_is_newest_unfinished_run_of_this_checkout() {
        let root = tempdir().unwrap();
        let home = root.path().join("baro-home");
        let repo = repo(root.path());
        let other = root.path().join("other");
        fs::create_dir(&other).unwrap();
        fs::create_dir_all(home.join("runs")).unwrap();
        fs::write(home.join("runs").join("audit-1.jsonl"), "").unwrap();

        assert!(find_resumable_in(&home, &repo).is_none());
        let first = create_run_in(&home, &repo, "baro/a", "run-a".into()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let second = create_run_in(&home, &repo, "baro/b", "run-b".into()).unwrap();
        create_run_in(&home, &other, "baro/c", "run-c".into()).unwrap();

        assert_eq!(
            find_resumable_in(&home, &repo).unwrap().run_id,
            second.run_id
        );
        mark_finished(&second).unwrap();
        assert_eq!(
            find_resumable_in(&home, &repo).unwrap().run_id,
            first.run_id
        );
        discard(&first).unwrap();
        assert!(!first.dir.exists());
        assert!(find_resumable_in(&home, &repo).is_none());
    }

    #[test]
    fn run_state_id_hashes_checkout_stably() {
        assert_eq!(stable_hash("/repo"), stable_hash("/repo"));
        assert_ne!(stable_hash("/repo"), stable_hash("/other"));
        if std::env::var_os("BARO_RUN_ID").is_none() {
            let id = new_run_id("/repo");
            assert!(
                id.ends_with(&format!("-{:08x}", stable_hash("/repo"))),
                "{id}"
            );
        }
    }
}
