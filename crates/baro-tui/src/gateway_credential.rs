//! Acquire a short-lived, login-backed credential for a local JigJoy run.
//!
//! The Node helper owns HTTP/TLS and strict response validation. Rust only
//! supervises that bundled helper and keeps its secret output in memory long
//! enough to seed the child phase environment.

use std::path::Path;

use serde::Deserialize;
use tokio::process::Command;

use crate::discovery::{self, ScriptEntry};

const SCRIPT_REL_PATH: &str =
    "packages/baro-orchestrator/scripts/acquire-gateway-credential.ts";
const BUNDLE_NAME: &str = "acquire-gateway-credential.mjs";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayCredential {
    pub schema_version: u8,
    pub run_id: String,
    pub gateway_base_url: String,
    pub api_key: String,
    pub expires_at: String,
}

pub async fn acquire(cwd: &Path) -> Result<GatewayCredential, String> {
    let entry = discovery::locate_script(cwd, SCRIPT_REL_PATH, BUNDLE_NAME)?;
    let mut command = match entry {
        ScriptEntry::Tsx { tsx, script } => {
            let mut command = Command::new(tsx);
            command.arg(script);
            command
        }
        ScriptEntry::NodeJs(script) => {
            let mut command = Command::new("node");
            command.arg(script);
            command
        }
    };
    command.kill_on_drop(true);
    let output = command
        .output()
        .await
        .map_err(|error| format!("could not start Gateway credential exchange: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        return Err(if message.is_empty() {
            "Gateway credential exchange failed".to_string()
        } else {
            message.chars().take(512).collect()
        });
    }
    parse_output(&output.stdout)
}

fn parse_output(output: &[u8]) -> Result<GatewayCredential, String> {
    // Never include stdout in an error: a malformed response may still contain
    // the issued bearer token.
    if output.is_empty() || output.len() > 32 * 1024 {
        return Err("Gateway credential helper returned an invalid response".into());
    }
    let credential: GatewayCredential = serde_json::from_slice(output)
        .map_err(|_| "Gateway credential helper returned an invalid response".to_string())?;
    if credential.schema_version != 1
        || !credential.run_id.starts_with("run-local-")
        || credential.run_id.len() > 138
        || !credential.gateway_base_url.starts_with("http")
        || !credential.api_key.starts_with("gk_v1.")
        || credential.api_key.len() > 16 * 1024
        || credential.expires_at.is_empty()
    {
        return Err("Gateway credential helper returned an invalid response".into());
    }
    Ok(credential)
}

#[cfg(test)]
mod tests {
    use super::parse_output;

    #[test]
    fn parses_only_the_strict_helper_contract() {
        let valid = br#"{"schemaVersion":1,"runId":"run-local-abcdefghijklmnopqrstuvwxyz","gatewayBaseUrl":"https://gw.baro.jigjoy.ai/v1","apiKey":"gk_v1.payload.signature","expiresAt":"2026-07-15T00:00:00.000Z"}"#;
        let credential = parse_output(valid).unwrap();
        assert_eq!(credential.run_id, "run-local-abcdefghijklmnopqrstuvwxyz");

        let with_extra = br#"{"schemaVersion":1,"runId":"run-local-abcdefghijklmnopqrstuvwxyz","gatewayBaseUrl":"https://gw.baro.jigjoy.ai/v1","apiKey":"gk_v1.payload.signature","expiresAt":"2026-07-15T00:00:00.000Z","tenant":"attacker"}"#;
        assert!(parse_output(with_extra).is_err());
    }

    #[test]
    fn malformed_output_error_never_echoes_a_token() {
        let secret = b"gk_v1.this-is-a-secret";
        let error = parse_output(secret).unwrap_err();
        assert!(!error.contains("this-is-a-secret"));
    }
}
