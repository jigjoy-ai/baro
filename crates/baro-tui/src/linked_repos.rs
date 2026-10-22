//! Linked repositories (`--repo`): sibling git repos a goal may span. This
//! first increment makes the topology visible to planning and reporting; baro
//! still executes, commits and opens a PR only in the primary checkout.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

pub const MAX_LINKED_REPOSITORIES: usize = 8;
const MANIFEST_DIRS: &[&str] = &["apps", "packages", "crates", "libs"];
const NODE_DEPENDENCY_SECTIONS: &[&str] = &[
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedRepository {
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    /// How the primary repository consumes this one, e.g.
    /// `package.json dependencies "@scope/engine": "^1.2.0"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
}

/// Validate `--repo` values and capture what planning and reporting need.
/// Relative paths resolve against the primary checkout so a detached child,
/// which runs from `--cwd`, resolves them identically.
pub fn resolve(primary: &Path, raw: &[String]) -> Result<Vec<LinkedRepository>, String> {
    if raw.len() > MAX_LINKED_REPOSITORIES {
        return Err(format!(
            "--repo accepts at most {MAX_LINKED_REPOSITORIES} linked repositories"
        ));
    }
    let primary_root = git_toplevel(primary).unwrap_or_else(|| primary.to_path_buf());
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut repos = Vec::new();
    for value in raw {
        let candidate = primary.join(value);
        let canonical = crate::canonical_path::canonicalize(&candidate)
            .map_err(|error| format!("--repo '{value}': {error}"))?;
        if !canonical.is_dir() {
            return Err(format!("--repo '{value}' is not a directory"));
        }
        let root = git_toplevel(&canonical)
            .ok_or_else(|| format!("--repo '{value}' is not inside a git repository"))?;
        if root == primary_root {
            return Err(format!(
                "--repo '{value}' is the primary repository (--cwd); pass a different repository"
            ));
        }
        if seen.contains(&root) {
            return Err(format!("--repo '{value}' is listed more than once"));
        }
        seen.push(root.clone());
        let package = manifest_package_name(&root);
        repos.push(LinkedRepository {
            name: root
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| root.display().to_string()),
            path: root.display().to_string(),
            dependency: package
                .as_deref()
                .and_then(|name| find_dependency_link(&primary_root, name)),
            package,
            branch: git_output(&root, &["rev-parse", "--abbrev-ref", "HEAD"]),
            head_sha: git_output(&root, &["rev-parse", "HEAD"]),
        });
    }
    Ok(repos)
}

/// Planning context for Architect, intake and Planner. Story agents are
/// sandboxed to the primary worktree, so the plan must not route work into a
/// linked repository nor quietly patch its installed copy.
pub fn render_context(primary: &Path, repos: &[LinkedRepository]) -> Option<String> {
    if repos.is_empty() {
        return None;
    }
    let mut md = String::from("# Linked repositories\n\n");
    md.push_str(&format!(
        "This goal may span repositories beyond the primary checkout `{}`. baro executes stories, commits and opens a pull request ONLY in the primary repository; story agents are sandboxed to it and cannot write to these linked repositories:\n\n",
        primary.display()
    ));
    for repo in repos {
        md.push_str(&format!("- `{}` at `{}`", repo.name, repo.path));
        let mut facts = Vec::new();
        if let Some(package) = &repo.package {
            facts.push(format!("package `{package}`"));
        }
        if let Some(branch) = &repo.branch {
            let sha = repo.head_sha.as_deref().map(short_sha).unwrap_or("?");
            facts.push(format!("branch `{branch}` @ `{sha}`"));
        }
        if !facts.is_empty() {
            md.push_str(&format!(" ({})", facts.join(", ")));
        }
        match &repo.dependency {
            Some(link) => md.push_str(&format!(
                "; the primary repository consumes it via {link}"
            )),
            None => md.push_str("; no dependency link from the primary repository was detected"),
        }
        md.push('\n');
    }
    md.push_str(
        "\nRouting rules:\n\
- Attribute every required change to the repository whose source owns the observable effect (for example generated output rendered by a dependency belongs to that dependency, not to the consumer's UI).\n\
- Do not plan stories that edit a linked repository, and do not silently patch its installed copy in the primary repository (`node_modules` edits, `pnpm patch`, `patch-package`, vendored copies).\n\
- List each change owned by a linked repository explicitly in the decision document as out-of-run work for that repository: what must change there, and the release or version bump the primary repository must consume afterwards. Never present such a change as done in this run.\n\
- Patch a linked dependency from the primary repository only when the goal explicitly asks for it; then a single story owns every patch to that dependency and names the dependency in its title.\n",
    );
    Some(md)
}

pub fn with_context(base: Option<&str>, linked: Option<&str>) -> Option<String> {
    match (base, linked) {
        (Some(base), Some(linked)) => Some(format!("{base}\n\n{linked}")),
        (base, linked) => base.or(linked).map(str::to_string),
    }
}

fn short_sha(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

fn git_output(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn git_toplevel(dir: &Path) -> Option<PathBuf> {
    let top = git_output(dir, &["rev-parse", "--show-toplevel"])?;
    crate::canonical_path::canonicalize(top).ok()
}

fn manifest_package_name(root: &Path) -> Option<String> {
    if let Some(name) = std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("name")?.as_str().map(str::to_string))
    {
        return Some(name);
    }
    std::fs::read_to_string(root.join("Cargo.toml"))
        .ok()
        .and_then(|text| cargo_package_name(&text))
}

fn cargo_package_name(manifest: &str) -> Option<String> {
    let mut in_package = false;
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            in_package = line == "[package]";
            continue;
        }
        if !in_package {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            if key.trim() == "name" {
                let name = value.trim().trim_matches('"');
                return (!name.is_empty()).then(|| name.to_string());
            }
        }
    }
    None
}

/// The primary root's manifests plus one level of the conventional monorepo
/// directories; a deeper or unconventional layout reports no link.
fn find_dependency_link(primary_root: &Path, package: &str) -> Option<String> {
    let mut dirs = vec![primary_root.to_path_buf()];
    for parent in MANIFEST_DIRS {
        let Ok(entries) = std::fs::read_dir(primary_root.join(parent)) else {
            continue;
        };
        let mut children: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        children.sort();
        dirs.extend(children);
    }
    dirs.iter().find_map(|dir| {
        let relative = |file: &str| {
            dir.join(file)
                .strip_prefix(primary_root)
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| file.to_string())
        };
        if let Some(link) = std::fs::read_to_string(dir.join("package.json"))
            .ok()
            .and_then(|text| node_dependency(&text, package))
        {
            return Some(format!("{} {link}", relative("package.json")));
        }
        std::fs::read_to_string(dir.join("Cargo.toml"))
            .ok()
            .and_then(|text| cargo_dependency(&text, package))
            .map(|link| format!("{} {link}", relative("Cargo.toml")))
    })
}

fn node_dependency(manifest: &str, package: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(manifest).ok()?;
    NODE_DEPENDENCY_SECTIONS.iter().find_map(|section| {
        let spec = json.get(*section)?.get(package)?;
        Some(format!(
            "{section} \"{package}\": {}",
            serde_json::to_string(spec).ok()?
        ))
    })
}

fn cargo_dependency(manifest: &str, package: &str) -> Option<String> {
    let mut section = String::new();
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            section = line.trim_matches(['[', ']']).to_string();
            if let Some(name) = section.rsplit_once('.').map(|(_, name)| name) {
                if section.contains("dependencies") && name.trim_matches('"') == package {
                    return Some(format!("[{section}]"));
                }
            }
            continue;
        }
        if !section.ends_with("dependencies") {
            continue;
        }
        let key = line
            .split(['=', '.'])
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches('"');
        if key == package {
            return Some(format!("[{section}] {line}"));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git_repo(path: &Path) {
        fs::create_dir_all(path).unwrap();
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(path)
                .output()
                .unwrap();
            assert!(status.status.success(), "git {args:?} failed");
        };
        run(&["init", "-q"]);
        run(&["-c", "user.email=t@baro.test", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
    }

    #[test]
    fn resolves_a_sibling_engine_and_detects_the_workspace_dependency() {
        let dir = tempfile::tempdir().unwrap();
        let platform = dir.path().join("platform");
        let engine = dir.path().join("engine");
        git_repo(&platform);
        git_repo(&engine);
        fs::write(engine.join("package.json"), r#"{"name":"@acme/engine-core"}"#).unwrap();
        fs::create_dir_all(platform.join("apps/web")).unwrap();
        fs::write(platform.join("package.json"), r#"{"name":"platform"}"#).unwrap();
        fs::write(
            platform.join("apps/web/package.json"),
            r#"{"dependencies":{"@acme/engine-core":"^0.6.89"}}"#,
        )
        .unwrap();
        let primary = crate::canonical_path::canonicalize(&platform).unwrap();

        let repos = resolve(&primary, &["../engine".to_string()]).unwrap();

        assert_eq!(repos.len(), 1);
        let repo = &repos[0];
        assert_eq!(repo.name, "engine");
        assert_eq!(
            repo.path,
            crate::canonical_path::canonicalize(&engine).unwrap().display().to_string()
        );
        assert_eq!(repo.package.as_deref(), Some("@acme/engine-core"));
        let expected = format!(
            "{} dependencies \"@acme/engine-core\": \"^0.6.89\"",
            Path::new("apps/web/package.json").display()
        );
        assert_eq!(repo.dependency.as_deref(), Some(expected.as_str()));
        assert_eq!(repo.head_sha.as_ref().map(String::len), Some(40));
        assert!(repo.branch.is_some());
    }

    #[test]
    fn rejects_the_primary_repo_duplicates_and_non_repositories() {
        let dir = tempfile::tempdir().unwrap();
        let platform = dir.path().join("platform");
        let engine = dir.path().join("engine");
        let plain = dir.path().join("plain");
        git_repo(&platform);
        git_repo(&engine);
        fs::create_dir_all(platform.join("src")).unwrap();
        fs::create_dir_all(&plain).unwrap();
        let primary = crate::canonical_path::canonicalize(&platform).unwrap();

        let err = resolve(&primary, &["src".to_string()]).unwrap_err();
        assert!(err.contains("is the primary repository"), "{err}");
        let err = resolve(&primary, &["../engine".to_string(), engine.display().to_string()])
            .unwrap_err();
        assert!(err.contains("listed more than once"), "{err}");
        let err = resolve(&primary, &["../missing".to_string()]).unwrap_err();
        assert!(err.starts_with("--repo '../missing':"), "{err}");
        if git_toplevel(&plain).is_none() {
            let err = resolve(&primary, &["../plain".to_string()]).unwrap_err();
            assert!(err.contains("not inside a git repository"), "{err}");
        }
        let many = vec!["../engine".to_string(); MAX_LINKED_REPOSITORIES + 1];
        assert!(resolve(&primary, &many).unwrap_err().contains("at most"));
        assert_eq!(resolve(&primary, &[]).unwrap(), Vec::new());
    }

    #[test]
    fn cargo_manifests_name_packages_and_dependencies() {
        let manifest = r#"
[package]
name = "app"

[dependencies]
serde = "1"
engine = { path = "../engine" }

[target.'cfg(unix)'.dependencies.engine-sys]
version = "2"
"#;
        assert_eq!(cargo_package_name(manifest).as_deref(), Some("app"));
        assert_eq!(
            cargo_dependency(manifest, "engine").as_deref(),
            Some(r#"[dependencies] engine = { path = "../engine" }"#)
        );
        assert_eq!(
            cargo_dependency(manifest, "engine-sys").as_deref(),
            Some("[target.'cfg(unix)'.dependencies.engine-sys]")
        );
        assert_eq!(cargo_dependency(manifest, "missing"), None);
        assert_eq!(cargo_package_name("[workspace]\nname = \"x\"\n"), None);
    }

    #[test]
    fn context_names_each_repo_and_forbids_silent_dependency_patching() {
        let repos = vec![
            LinkedRepository {
                name: "engine".to_string(),
                path: "/work/engine".to_string(),
                package: Some("@acme/engine-core".to_string()),
                dependency: Some("package.json dependencies \"@acme/engine-core\": \"^1\"".to_string()),
                branch: Some("main".to_string()),
                head_sha: Some("0123456789abcdef".to_string()),
            },
            LinkedRepository {
                name: "schema".to_string(),
                path: "/work/schema".to_string(),
                package: None,
                dependency: None,
                branch: None,
                head_sha: None,
            },
        ];

        let md = render_context(Path::new("/work/platform"), &repos).unwrap();

        assert!(md.contains("primary checkout `/work/platform`"));
        assert!(md.contains(
            "- `engine` at `/work/engine` (package `@acme/engine-core`, branch `main` @ `0123456`); the primary repository consumes it via package.json dependencies"
        ));
        assert!(md.contains("- `schema` at `/work/schema`; no dependency link"));
        assert!(md.contains("`pnpm patch`"));
        assert!(md.contains("out-of-run work"));
        assert_eq!(render_context(Path::new("/work/platform"), &[]), None);
    }

    #[test]
    fn with_context_appends_linked_section_to_project_context() {
        assert_eq!(
            with_context(Some("# Project"), Some("# Linked")).as_deref(),
            Some("# Project\n\n# Linked")
        );
        assert_eq!(with_context(None, Some("# Linked")).as_deref(), Some("# Linked"));
        assert_eq!(with_context(Some("# Project"), None).as_deref(), Some("# Project"));
        assert_eq!(with_context(None, None), None);
    }

    #[test]
    fn serializes_camel_case_and_omits_unknown_facts() {
        let repo = LinkedRepository {
            name: "engine".to_string(),
            path: "/work/engine".to_string(),
            package: None,
            dependency: None,
            branch: None,
            head_sha: Some("abc".to_string()),
        };
        let json = serde_json::to_string(&repo).unwrap();
        assert_eq!(json, r#"{"name":"engine","path":"/work/engine","headSha":"abc"}"#);
        assert_eq!(serde_json::from_str::<LinkedRepository>(&json).unwrap(), repo);
    }
}
