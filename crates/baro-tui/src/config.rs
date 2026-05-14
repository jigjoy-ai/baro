use std::path::Path;

/// Project-level config loaded from `.barorc` in the working directory.
#[derive(Debug, Clone)]
pub struct BaroConfig {
    pub model: Option<String>,     // "routed", "opus", "sonnet", "haiku"
    pub parallel: Option<u32>,
    pub timeout: Option<u64>,
    pub planner: Option<String>,   // "claude", "openai"
}

impl Default for BaroConfig {
    fn default() -> Self {
        Self {
            model: None,
            parallel: None,
            timeout: None,
            planner: None,
        }
    }
}

/// Load config from `.barorc` in the given directory. Returns defaults if not found.
pub fn load_config(cwd: &Path) -> BaroConfig {
    let rc_path = cwd.join(".barorc");
    let content = match std::fs::read_to_string(&rc_path) {
        Ok(c) => c,
        Err(_) => return BaroConfig::default(),
    };

    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return BaroConfig::default(),
    };

    BaroConfig {
        model: json.get("model").and_then(|v| v.as_str()).map(|s| s.to_string()),
        parallel: json.get("parallel").and_then(|v| v.as_u64()).map(|v| v as u32),
        timeout: json.get("timeout").and_then(|v| v.as_u64()),
        planner: json.get("planner").and_then(|v| v.as_str()).map(|s| s.to_string()),
    }
}
