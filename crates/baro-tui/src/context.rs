use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tokio::fs;
use tokio::process::Command;

use crate::utils::BaroResult;

/// Build a CLAUDE.md context string by scanning the project at `cwd`.
pub async fn build_context(cwd: &Path) -> BaroResult<String> {
    let tech_stack = detect_tech_stack(cwd).await;
    let dir_tree = build_directory_tree(cwd, cwd, 0, crate::constants::DIRECTORY_TREE_DEPTH).await;
    let entry_points = find_entry_points(cwd).await;
    let build_commands = detect_build_commands(cwd).await;
    let conventions = detect_conventions(cwd).await;

    let project_name = tech_stack
        .iter()
        .find_map(|ts| ts.project_name.clone())
        .unwrap_or_else(|| {
            cwd.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "Unknown Project".to_string())
        });

    let description = tech_stack
        .iter()
        .find_map(|ts| ts.description.clone())
        .unwrap_or_default();

    let mut md = String::new();

    md.push_str(&format!("# Project Overview\n\n**{}**", project_name));
    if !description.is_empty() {
        md.push_str(&format!(" — {}", description));
    }
    md.push('\n');

    md.push_str("\n## Tech Stack\n\n");
    if tech_stack.is_empty() {
        md.push_str("No recognized config files found.\n");
    } else {
        for ts in &tech_stack {
            md.push_str(&format!("- **{}**", ts.config_file));
            if let Some(v) = &ts.version {
                md.push_str(&format!(" (v{})", v));
            }
            md.push('\n');
            for dep in &ts.key_deps {
                md.push_str(&format!("  - {}\n", dep));
            }
        }
    }

    md.push_str("\n## Directory Structure\n\n```\n");
    md.push_str(&dir_tree);
    md.push_str("```\n");

    md.push_str("\n## Build and Test Commands\n\n");
    if build_commands.is_empty() {
        md.push_str("No build commands detected.\n");
    } else {
        for (label, cmd) in &build_commands {
            md.push_str(&format!("- **{}**: `{}`\n", label, cmd));
        }
    }

    md.push_str("\n## Key Files\n\n");
    if entry_points.is_empty() {
        md.push_str("No standard entry points detected.\n");
    } else {
        for ep in &entry_points {
            md.push_str(&format!("- `{}`\n", ep));
        }
    }
    for ts in &tech_stack {
        md.push_str(&format!("- `{}`\n", ts.config_file));
    }

    md.push_str("\n## Conventions\n\n");
    if conventions.linter_configs.is_empty() && conventions.test_dirs.is_empty() {
        md.push_str("No linter/formatter configs or test directories detected.\n");
    } else {
        if !conventions.linter_configs.is_empty() {
            md.push_str("**Linter/Formatter configs:**\n");
            for c in &conventions.linter_configs {
                md.push_str(&format!("- `{}`\n", c));
            }
        }
        if !conventions.test_dirs.is_empty() {
            md.push_str("\n**Test directories:**\n");
            for d in &conventions.test_dirs {
                md.push_str(&format!("- `{}/`\n", d));
            }
        }
    }

    if let Some(enhanced) = enhance_with_haiku(&md).await {
        Ok(enhanced)
    } else {
        Ok(md)
    }
}

/// Use the haiku model to refine the raw project scan into a concise, well-structured CLAUDE.md.
/// Falls back to the raw scan if haiku is unavailable or returns an empty result.
async fn enhance_with_haiku(raw_context: &str) -> Option<String> {
    let prompt = format!(
        "You are a technical documentation assistant. Below is raw project scan data. \
         Rewrite it as a clean, concise CLAUDE.md file that helps an AI coding assistant \
         understand this project. Keep it under 500 words. Use markdown headers. \
         Include: project overview, tech stack, key files, build commands, and conventions.\n\n\
         Raw scan data:\n{}\n\nReturn ONLY the CLAUDE.md content, no preamble or code fences.",
        raw_context
    );

    let output = Command::new("claude")
        .args([
            "--dangerously-skip-permissions",
            "--model",
            "haiku",
            "--output-format",
            "json",
            "-p",
            &prompt,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&stdout).ok()?;
    let result = json.get("result").and_then(|r| r.as_str())?;
    let trimmed = result.trim().to_string();
    if trimmed.is_empty() || trimmed == "No response." {
        return None;
    }
    Some(trimmed)
}

struct TechStackEntry {
    config_file: String,
    project_name: Option<String>,
    description: Option<String>,
    version: Option<String>,
    key_deps: Vec<String>,
}

async fn detect_tech_stack(cwd: &Path) -> Vec<TechStackEntry> {
    let mut entries = Vec::new();

    if let Some(e) = parse_package_json(cwd).await {
        entries.push(e);
    }
    if let Some(e) = parse_cargo_toml(cwd).await {
        entries.push(e);
    }
    if let Some(e) = parse_go_mod(cwd).await {
        entries.push(e);
    }
    if let Some(e) = parse_pyproject_toml(cwd).await {
        entries.push(e);
    }
    if let Some(e) = parse_requirements_txt(cwd).await {
        entries.push(e);
    }

    // Presence-only detection for configs we don't parse
    let simple_configs = [
        "Makefile",
        "CMakeLists.txt",
        "build.gradle",
        "pom.xml",
        "Gemfile",
        "composer.json",
    ];
    for name in simple_configs {
        let path = cwd.join(name);
        if fs::metadata(&path).await.is_ok() {
            entries.push(TechStackEntry {
                config_file: name.to_string(),
                project_name: None,
                description: None,
                version: None,
                key_deps: Vec::new(),
            });
        }
    }

    entries
}

async fn parse_package_json(cwd: &Path) -> Option<TechStackEntry> {
    let content = fs::read_to_string(cwd.join("package.json")).await.ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;

    let project_name = json.get("name").and_then(|v| v.as_str()).map(String::from);
    let description = json
        .get("description")
        .and_then(|v| v.as_str())
        .map(String::from);
    let version = json
        .get("version")
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut key_deps = Vec::new();
    if let Some(deps) = json.get("dependencies").and_then(|v| v.as_object()) {
        for k in deps.keys().take(10) {
            key_deps.push(k.clone());
        }
    }

    Some(TechStackEntry {
        config_file: "package.json".to_string(),
        project_name,
        description,
        version,
        key_deps,
    })
}

async fn parse_cargo_toml(cwd: &Path) -> Option<TechStackEntry> {
    let content = fs::read_to_string(cwd.join("Cargo.toml")).await.ok()?;

    let project_name = extract_toml_value(&content, "name");
    let description = extract_toml_value(&content, "description");
    let version = extract_toml_value(&content, "version");

    let mut key_deps = Vec::new();
    let mut in_deps = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[dependencies]") || trimmed.starts_with("[dev-dependencies]") {
            in_deps = true;
            continue;
        }
        if trimmed.starts_with('[') {
            in_deps = false;
            continue;
        }
        if in_deps {
            if let Some(name) = trimmed.split('=').next() {
                let name = name.trim();
                if !name.is_empty() && key_deps.len() < 10 {
                    key_deps.push(name.to_string());
                }
            }
        }
    }

    Some(TechStackEntry {
        config_file: "Cargo.toml".to_string(),
        project_name,
        description,
        version,
        key_deps,
    })
}

async fn parse_go_mod(cwd: &Path) -> Option<TechStackEntry> {
    let content = fs::read_to_string(cwd.join("go.mod")).await.ok()?;

    let project_name = content
        .lines()
        .find(|l| l.starts_with("module "))
        .map(|l| l.trim_start_matches("module ").trim().to_string());

    let mut key_deps = Vec::new();
    let mut in_require = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("require (") {
            in_require = true;
            continue;
        }
        if trimmed == ")" {
            in_require = false;
            continue;
        }
        if in_require && key_deps.len() < 10 {
            if let Some(dep) = trimmed.split_whitespace().next() {
                if !dep.is_empty() {
                    key_deps.push(dep.to_string());
                }
            }
        }
    }

    Some(TechStackEntry {
        config_file: "go.mod".to_string(),
        project_name,
        description: None,
        version: None,
        key_deps,
    })
}

async fn parse_pyproject_toml(cwd: &Path) -> Option<TechStackEntry> {
    let content = fs::read_to_string(cwd.join("pyproject.toml")).await.ok()?;

    let project_name = extract_toml_value(&content, "name");
    let description = extract_toml_value(&content, "description");
    let version = extract_toml_value(&content, "version");

    Some(TechStackEntry {
        config_file: "pyproject.toml".to_string(),
        project_name,
        description,
        version,
        key_deps: Vec::new(),
    })
}

async fn parse_requirements_txt(cwd: &Path) -> Option<TechStackEntry> {
    let content = fs::read_to_string(cwd.join("requirements.txt"))
        .await
        .ok()?;

    let key_deps: Vec<String> = content
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .take(10)
        .map(|l| {
            l.split(['=', '>', '<', '!', '~', ';'])
                .next()
                .unwrap_or(l)
                .trim()
                .to_string()
        })
        .collect();

    Some(TechStackEntry {
        config_file: "requirements.txt".to_string(),
        project_name: None,
        description: None,
        version: None,
        key_deps,
    })
}

/// Extract a simple `key = "value"` from TOML content (within [package] or top-level).
fn extract_toml_value(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with(&format!("{} ", key)) || trimmed.starts_with(&format!("{}=", key)) {
            if let Some(val) = trimmed.split_once('=').map(|x| x.1) {
                let val = val.trim().trim_matches('"');
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    ".git",
    "__pycache__",
    ".next",
    "build",
    "vendor",
    ".gradle",
    ".idea",
    ".vscode",
    "venv",
    ".env",
];

async fn build_directory_tree(base: &Path, dir: &Path, depth: u32, max_depth: u32) -> String {
    if depth >= max_depth {
        return String::new();
    }

    let mut entries: Vec<PathBuf> = Vec::new();
    let mut read_dir = match fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(_) => return String::new(),
    };

    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if SKIP_DIRS.contains(&name_str.as_ref()) {
            continue;
        }
        entries.push(entry.path());
    }

    entries.sort();

    let mut result = String::new();
    let indent = "  ".repeat(depth as usize);

    for entry_path in entries {
        let name = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if let Ok(meta) = fs::metadata(&entry_path).await {
            if meta.is_dir() {
                result.push_str(&format!("{}{}/\n", indent, name));
                let subtree =
                    Box::pin(build_directory_tree(base, &entry_path, depth + 1, max_depth)).await;
                result.push_str(&subtree);
            } else {
                result.push_str(&format!("{}{}\n", indent, name));
            }
        }
    }

    result
}

const ENTRY_POINT_FILES: &[&str] = &[
    "main.rs",
    "main.go",
    "main.py",
    "index.ts",
    "index.js",
    "App.tsx",
    "app.py",
    "manage.py",
];

async fn find_entry_points(cwd: &Path) -> Vec<String> {
    let mut found = Vec::new();

    let src_dir = cwd.join("src");
    if fs::metadata(&src_dir).await.is_ok() {
        found.push("src/".to_string());
        for name in ENTRY_POINT_FILES {
            let p = src_dir.join(name);
            if fs::metadata(&p).await.is_ok() {
                found.push(format!("src/{}", name));
            }
        }
    }

    let bin_dir = cwd.join("bin");
    if fs::metadata(&bin_dir).await.is_ok() {
        found.push("bin/".to_string());
    }

    for name in ENTRY_POINT_FILES {
        let p = cwd.join(name);
        if fs::metadata(&p).await.is_ok() {
            found.push(name.to_string());
        }
    }

    found
}

async fn detect_build_commands(cwd: &Path) -> Vec<(String, String)> {
    let mut commands = Vec::new();

    if let Ok(content) = fs::read_to_string(cwd.join("package.json")).await {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(scripts) = json.get("scripts").and_then(|v| v.as_object()) {
                for (k, v) in scripts {
                    if let Some(cmd) = v.as_str() {
                        commands.push((format!("npm run {}", k), cmd.to_string()));
                    }
                }
            }
        }
    }

    if fs::metadata(cwd.join("Cargo.toml")).await.is_ok() {
        commands.push(("Build (Rust)".to_string(), "cargo build".to_string()));
        commands.push(("Test (Rust)".to_string(), "cargo test".to_string()));
    }

    if fs::metadata(cwd.join("go.mod")).await.is_ok() {
        commands.push(("Build (Go)".to_string(), "go build ./...".to_string()));
        commands.push(("Test (Go)".to_string(), "go test ./...".to_string()));
    }

    if let Ok(content) = fs::read_to_string(cwd.join("Makefile")).await {
        for line in content.lines() {
            if let Some(target) = line.strip_suffix(':') {
                let target = target.trim();
                // Only simple targets: no variables, no prerequisites
                if !target.is_empty()
                    && !target.contains('$')
                    && !target.contains(' ')
                    && !target.starts_with('.')
                    && !target.starts_with('#')
                {
                    commands.push((format!("make {}", target), format!("make {}", target)));
                }
            }
        }
    }

    if let Ok(content) = fs::read_to_string(cwd.join("pyproject.toml")).await {
        let mut in_scripts = false;
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed == "[tool.poetry.scripts]" || trimmed == "[project.scripts]" {
                in_scripts = true;
                continue;
            }
            if trimmed.starts_with('[') {
                in_scripts = false;
                continue;
            }
            if in_scripts {
                if let Some((name, _)) = trimmed.split_once('=') {
                    commands.push((name.trim().to_string(), name.trim().to_string()));
                }
            }
        }
    }

    commands
}

struct Conventions {
    linter_configs: Vec<String>,
    test_dirs: Vec<String>,
}

async fn detect_conventions(cwd: &Path) -> Conventions {
    let mut linter_configs = Vec::new();
    let mut test_dirs = Vec::new();

    let exact_configs = [
        "rustfmt.toml",
        ".rustfmt.toml",
        "clippy.toml",
        ".golangci.yml",
        ".flake8",
        "setup.cfg",
        ".editorconfig",
        "tsconfig.json",
    ];

    for name in exact_configs {
        if fs::metadata(cwd.join(name)).await.is_ok() {
            linter_configs.push(name.to_string());
        }
    }

    let prefix_configs: BTreeMap<&str, &[&str]> = BTreeMap::from([
        (
            ".eslintrc",
            &[
                ".eslintrc",
                ".eslintrc.js",
                ".eslintrc.cjs",
                ".eslintrc.json",
                ".eslintrc.yml",
            ][..],
        ),
        (
            ".prettierrc",
            &[
                ".prettierrc",
                ".prettierrc.js",
                ".prettierrc.cjs",
                ".prettierrc.json",
                ".prettierrc.yml",
            ][..],
        ),
    ]);

    for variants in prefix_configs.values() {
        for name in *variants {
            if fs::metadata(cwd.join(name)).await.is_ok() {
                linter_configs.push(name.to_string());
                break;
            }
        }
    }

    if let Ok(content) = fs::read_to_string(cwd.join("pyproject.toml")).await {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("[tool.") && trimmed.ends_with(']') {
                let tool_name = trimmed
                    .trim_start_matches("[tool.")
                    .trim_end_matches(']')
                    .split('.')
                    .next()
                    .unwrap_or("");
                let entry = format!("pyproject.toml [tool.{}]", tool_name);
                if !linter_configs.contains(&entry) {
                    linter_configs.push(entry);
                }
            }
        }
    }

    let test_dir_names = ["tests", "test", "__tests__", "spec"];
    for name in test_dir_names {
        let path = cwd.join(name);
        if let Ok(meta) = fs::metadata(&path).await {
            if meta.is_dir() {
                test_dirs.push(name.to_string());
            }
        }
    }

    Conventions {
        linter_configs,
        test_dirs,
    }
}
