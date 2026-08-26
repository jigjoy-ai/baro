//! Re-executes baro as a background child whose stream lands in the run
//! registry's log file. The decisions (log paths, caffeinate argv) come from
//! `launch::plan_detach`; this module owns only the parts that need a process:
//! rebuilding the child's argv, finding a binary on PATH, and the spawn itself.

// The main.rs call site lands separately; until then the binary target sees
// this module as unreachable.
#![allow(dead_code)]

use std::{
    io,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::cli::{launch, run_registry};

/// The parent's argv minus `--detach` and `--goal-file`, forced headless. The
/// child has no TTY, and `resolve_goal` has already read the goal file into
/// `cli.goal`, so the file need not exist (or be readable) for the child.
pub fn detached_child_args(raw_args: &[String], resolved_goal: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(raw_args.len());
    let mut skip_next_value = false;
    for arg in raw_args.iter().skip(1) {
        if skip_next_value {
            skip_next_value = false;
            continue;
        }
        if arg == "--detach" {
            continue;
        }
        if arg == "--goal-file" {
            skip_next_value = true;
            continue;
        }
        if arg.starts_with("--goal-file=") {
            continue;
        }
        out.push(arg.clone());
    }

    if !out.iter().any(|a| a == "--headless" || a.starts_with("--headless=")) {
        out.push("--headless".to_string());
    }

    // A surviving positional goal is byte-identical to the resolved goal
    // (clap rejects passing both a positional and --goal-file), so its absence
    // from the filtered argv is exactly the case that needs the goal appended.
    if let Some(goal) = resolved_goal {
        if !out.iter().any(|a| a == goal) {
            out.push(goal.to_string());
        }
    }
    out
}

pub fn binary_on_path(name: &str, path_var: Option<&str>) -> bool {
    let Some(path_var) = path_var else {
        return false;
    };
    path_var
        .split(':')
        .filter(|entry| !entry.is_empty())
        .any(|entry| std::path::Path::new(entry).join(name).exists())
}

/// Spawns the background run and returns its pid, which is also its run id.
/// The caller is the parent and exits immediately afterwards.
pub fn run_detached(cli: &crate::cli::cli::Cli, raw_args: &[String]) -> io::Result<u32> {
    let logs_dir = run_registry::logs_dir()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no writable ~/.baro/logs"))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| io::Error::new(io::ErrorKind::Other, err))?
        .as_nanos();
    let parent_pid = std::process::id();

    // The stream must be redirected before spawn, and the run id is the child
    // pid, so the log opens under a pending name and is renamed once known.
    let pending = launch::plan_detach(
        &logs_dir,
        parent_pid,
        nanos,
        None,
        cfg!(target_os = "macos"),
        false,
    );
    let out = std::fs::File::create(&pending.pending_log)?;
    let err = out.try_clone()?;

    let mut command = Command::new(std::env::current_exe()?);
    command
        .args(detached_child_args(raw_args, cli.goal.as_deref()))
        .current_dir(&cli.cwd)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own group, so a signal to the launching shell's group stops
        // neither the run nor anything it spawns.
        command.process_group(0);
    }
    let child = command.spawn()?;
    let child_pid = child.id();

    let plan = launch::plan_detach(
        &logs_dir,
        parent_pid,
        nanos,
        Some(child_pid),
        cfg!(target_os = "macos"),
        binary_on_path("caffeinate", std::env::var("PATH").ok().as_deref()),
    );
    let log_path = match std::fs::rename(&plan.pending_log, &plan.final_log) {
        Ok(()) => plan.final_log.clone(),
        // The child is already writing; a failed rename costs the conventional
        // name, not the run.
        Err(_) => plan.pending_log.clone(),
    };
    let _ = run_registry::register_detached(
        cli.goal.as_deref().unwrap_or(""),
        &cli.cwd,
        child_pid,
        &log_path,
    );

    if let Some(argv) = plan.caffeinate.as_ref() {
        let _ = Command::new(&argv[0])
            .args(&argv[1..])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
    Ok(child_pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn the_child_argv_drops_detach_and_goal_file_and_forces_headless() {
        let separate = detached_child_args(
            &argv(&["baro", "--detach", "--resume", "--goal-file", "./goal.md", "--shell-budget", "45"]),
            Some("ship it"),
        );
        assert_eq!(separate, argv(&["--resume", "--shell-budget", "45", "--headless", "ship it"]));

        let inline = detached_child_args(
            &argv(&["baro", "--detach", "--continue", "--goal-file=./goal.md"]),
            Some("ship it"),
        );
        assert_eq!(inline, argv(&["--continue", "--headless", "ship it"]));
    }

    #[test]
    fn an_already_headless_argv_is_not_given_a_second_headless_flag() {
        let already = detached_child_args(
            &argv(&["baro", "--detach", "--resume", "--headless", "--shell-budget", "45"]),
            None,
        );
        assert_eq!(already, argv(&["--resume", "--headless", "--shell-budget", "45"]));
        assert_eq!(already.iter().filter(|a| *a == "--headless").count(), 1);

        let with_goal =
            detached_child_args(&argv(&["baro", "--detach", "--headless", "ship it"]), Some("ship it"));
        assert_eq!(with_goal, argv(&["--headless", "ship it"]));
    }

    #[test]
    fn the_resolved_goal_is_appended_only_when_no_positional_survives() {
        let positional = detached_child_args(&argv(&["baro", "ship it", "--detach"]), Some("ship it"));
        assert_eq!(positional, argv(&["ship it", "--headless"]));

        // From --goal-file the goal is file text no surviving token can equal.
        let from_file = detached_child_args(
            &argv(&["baro", "--detach", "--goal-file", "./goal.md"]),
            Some("read from the file"),
        );
        assert_eq!(from_file, argv(&["--headless", "read from the file"]));

        // A flag value is not a positional, so the goal still has to be added.
        let value_only = detached_child_args(
            &argv(&["baro", "--detach", "--shell-budget", "45"]),
            Some("ship it"),
        );
        assert_eq!(value_only, argv(&["--shell-budget", "45", "--headless", "ship it"]));

        assert_eq!(detached_child_args(&argv(&["baro", "--detach"]), None), argv(&["--headless"]));
    }

    #[test]
    fn a_binary_is_found_only_on_a_path_entry_that_holds_it() {
        let held = env!("CARGO_MANIFEST_DIR");

        assert!(binary_on_path("Cargo.toml", Some(&format!("/nonexistent:{held}"))));
        // Empty entries are skipped rather than read as the current directory.
        assert!(binary_on_path("Cargo.toml", Some(&format!("::{held}:"))));
        assert!(!binary_on_path("Cargo.toml", Some("/nonexistent:/also-nonexistent")));
        assert!(!binary_on_path("definitely-not-a-file", Some(held)));
        assert!(!binary_on_path("Cargo.toml", None));
        assert!(!binary_on_path("Cargo.toml", Some("")));
    }
}
