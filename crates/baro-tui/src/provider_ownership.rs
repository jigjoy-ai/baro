#[cfg(unix)]
use std::collections::HashMap;
#[cfg(unix)]
use std::fs::File;
use std::fs::OpenOptions;
#[cfg(unix)]
use std::io::Read;
use std::io::Write;
#[cfg(any(unix, test))]
use std::path::Path;
use std::path::PathBuf;
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use serde::Deserialize;
use tokio::process::Command;

const MANIFEST_SCHEMA_VERSION: u32 = 1;
#[cfg(unix)]
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
#[cfg(unix)]
const MAX_PROVIDER_GROUPS: usize = 512;
#[cfg(unix)]
const MAX_MEMBERS_PER_GROUP: usize = 16;
#[cfg(unix)]
const VALIDATION_BUDGET: Duration = Duration::from_millis(750);
#[cfg(unix)]
const PS_TABLE_TIMEOUT: Duration = Duration::from_millis(500);

// Linux procfs start ticks are a strong per-boot PID identity. The portable
// macOS `ps lstart` fallback is only second-resolution; it is intentionally
// validated and signalled in one bounded pass, but is not a kernel-unique ID.

pub(crate) struct ProviderOwnershipManifest {
    _directory: tempfile::TempDir,
    path: PathBuf,
    run_token: String,
}

impl ProviderOwnershipManifest {
    pub(crate) fn create() -> Result<Self, String> {
        let directory = tempfile::Builder::new()
            .prefix("baro-provider-ownership-")
            .tempdir()
            .map_err(|error| format!("failed to create provider ownership directory: {error}"))?;
        let run_token = directory
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| name.len() >= 8)
            .ok_or_else(|| "provider ownership directory has no safe run token".to_string())?
            .to_string();
        let path = directory.path().join("ownership.json");
        let body = serde_json::json!({
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "runToken": run_token,
            "generation": 0,
            "providers": [],
        });
        let bytes = serde_json::to_vec(&body)
            .map_err(|error| format!("failed to encode provider ownership manifest: {error}"))?;
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|error| format!("failed to create provider ownership manifest: {error}"))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| {
                format!("failed to initialize provider ownership manifest: {error}")
            })?;
        Ok(Self {
            _directory: directory,
            path,
            run_token,
        })
    }

    pub(crate) fn configure_command(&self, command: &mut Command) {
        command
            .env("BARO_INTERNAL_PROVIDER_OWNERSHIP_MANIFEST", &self.path)
            .env("BARO_INTERNAL_PROVIDER_OWNERSHIP_TOKEN", &self.run_token);
    }

    #[cfg(unix)]
    pub(crate) async fn terminate_validated_groups(&self, outer_group: Option<u32>) -> usize {
        let Some(manifest) = self.read_valid_manifest() else {
            return 0;
        };
        let future = async {
            terminate_provider_groups(manifest.providers, outer_group, current_process_group())
                .await
        };
        tokio::time::timeout(VALIDATION_BUDGET, future)
            .await
            .unwrap_or(0)
    }

    #[cfg(not(unix))]
    pub(crate) async fn terminate_validated_groups(&self, _outer_group: Option<u32>) -> usize {
        0
    }

    #[cfg(unix)]
    fn read_valid_manifest(&self) -> Option<OwnershipManifestWire> {
        let metadata = std::fs::symlink_metadata(&self.path).ok()?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_MANIFEST_BYTES {
            return None;
        }
        let file = File::open(&self.path).ok()?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return None;
        }
        let manifest: OwnershipManifestWire = serde_json::from_slice(&bytes).ok()?;
        if manifest.schema_version != MANIFEST_SCHEMA_VERSION
            || manifest.run_token != self.run_token
            || manifest.providers.len() > MAX_PROVIDER_GROUPS
            || manifest.providers.iter().any(|provider| {
                provider.process_group_id < 2
                    || provider.members.is_empty()
                    || provider.members.len() > MAX_MEMBERS_PER_GROUP
            })
        {
            return None;
        }
        Some(manifest)
    }

    #[cfg(test)]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    #[cfg(test)]
    pub(crate) fn run_token(&self) -> &str {
        &self.run_token
    }
}

#[cfg(unix)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnershipManifestWire {
    schema_version: u32,
    run_token: String,
    #[allow(dead_code)]
    generation: u64,
    providers: Vec<ProviderGroupWire>,
}

#[cfg(unix)]
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderGroupWire {
    process_group_id: u32,
    identity_source: IdentitySourceWire,
    members: Vec<ProviderMemberWire>,
}

#[cfg(unix)]
#[derive(Clone, Copy, Deserialize, Eq, PartialEq)]
enum IdentitySourceWire {
    #[serde(rename = "linux-proc-stat-v1")]
    LinuxProcStatV1,
    #[serde(rename = "posix-ps-lstart-v1")]
    PosixPsLstartV1,
}

#[cfg(unix)]
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderMemberWire {
    pid: u32,
    start_time: String,
}

#[cfg(unix)]
async fn terminate_provider_groups(
    providers: Vec<ProviderGroupWire>,
    outer_group: Option<u32>,
    rust_group: Option<u32>,
) -> usize {
    let mut unique = HashMap::new();
    for provider in providers {
        if Some(provider.process_group_id) == outer_group
            || Some(provider.process_group_id) == rust_group
        {
            continue;
        }
        unique.entry(provider.process_group_id).or_insert(provider);
    }

    let mut proc_tasks = tokio::task::JoinSet::new();
    let mut ps_groups = Vec::new();
    for provider in unique.into_values() {
        match provider.identity_source {
            IdentitySourceWire::LinuxProcStatV1 => {
                proc_tasks.spawn_blocking(move || {
                    let valid = provider.members.iter().any(|member| {
                        linux_proc_observation(member.pid).is_some_and(|observed| {
                            identity_matches(&observed, provider.process_group_id, member)
                        })
                    });
                    (provider.process_group_id, valid)
                });
            }
            IdentitySourceWire::PosixPsLstartV1 => ps_groups.push(provider),
        }
    }

    // Start the one bounded `ps -A` snapshot concurrently with Linux procfs
    // validation. A group is signalled as soon as its identity is validated;
    // we never retain a batch of validated PGIDs long enough for a completed
    // group to disappear and make its numeric PGID eligible for reuse.
    let ps_task = if ps_groups.is_empty() {
        None
    } else {
        Some(tokio::spawn(ps_process_table()))
    };
    let mut terminated = 0;
    while let Some(result) = proc_tasks.join_next().await {
        if let Ok((group, true)) = result {
            signal_process_group(group, 9);
            terminated += 1;
        }
    }

    if let Some(ps_task) = ps_task {
        let ps_observations = ps_task.await.ok().flatten().unwrap_or_default();
        for provider in ps_groups {
            let valid = provider.members.iter().any(|member| {
                ps_observations.get(&member.pid).is_some_and(|observed| {
                    identity_matches(observed, provider.process_group_id, member)
                })
            });
            if valid {
                signal_process_group(provider.process_group_id, 9);
                terminated += 1;
            }
        }
    }
    terminated
}

#[cfg(unix)]
fn identity_matches(
    observed: &ProcessObservation,
    expected_group: u32,
    expected: &ProviderMemberWire,
) -> bool {
    expected.pid >= 2
        && !expected.start_time.is_empty()
        && expected.start_time.len() <= 128
        && observed.process_group_id == expected_group
        && !observed.state.trim_start().starts_with('Z')
        && normalize_start_time(&observed.start_time) == normalize_start_time(&expected.start_time)
}

#[cfg(unix)]
#[derive(Clone)]
struct ProcessObservation {
    process_group_id: u32,
    state: String,
    start_time: String,
}

#[cfg(unix)]
fn linux_proc_observation(pid: u32) -> Option<ProcessObservation> {
    #[cfg(target_os = "linux")]
    {
        let value = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let open = value.find('(')?;
        let close = value.rfind(')')?;
        if open < 1 || close <= open {
            return None;
        }
        let fields = value[close + 1..].split_whitespace().collect::<Vec<_>>();
        Some(ProcessObservation {
            state: fields.first()?.to_string(),
            process_group_id: fields.get(2)?.parse().ok()?,
            start_time: fields.get(19)?.to_string(),
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

#[cfg(unix)]
async fn ps_process_table() -> Option<HashMap<u32, ProcessObservation>> {
    let ps = if Path::new("/bin/ps").is_file() {
        "/bin/ps"
    } else {
        "/usr/bin/ps"
    };
    let mut command = Command::new(ps);
    command
        .kill_on_drop(true)
        .args(["-A", "-o", "pid=,pgid=,state=,lstart="])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let output = tokio::time::timeout(PS_TABLE_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() || output.stdout.len() > 16 * 1024 * 1024 {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let mut observations = HashMap::new();
    for line in value.lines() {
        let mut fields = line.split_whitespace();
        let pid = fields.next()?.parse::<u32>().ok()?;
        let process_group_id = fields.next()?.parse().ok()?;
        let state = fields.next()?.to_string();
        let start_time = fields.collect::<Vec<_>>().join(" ");
        if start_time.is_empty() {
            return None;
        }
        observations.insert(
            pid,
            ProcessObservation {
                process_group_id,
                state,
                start_time,
            },
        );
    }
    Some(observations)
}

#[cfg(unix)]
fn normalize_start_time(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(unix)]
fn current_process_group() -> Option<u32> {
    unsafe extern "C" {
        fn getpgrp() -> i32;
    }
    let group = unsafe { getpgrp() };
    u32::try_from(group).ok()
}

#[cfg(unix)]
fn signal_process_group(group: u32, signal: i32) {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    if let Ok(group) = i32::try_from(group) {
        let _ = unsafe { kill(-group, signal) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn private_manifest_is_removed_with_its_run_directory() {
        let manifest = ProviderOwnershipManifest::create().unwrap();
        let path = manifest.path().to_path_buf();
        let directory = path.parent().unwrap().to_path_buf();
        assert!(path.is_file());
        drop(manifest);
        assert!(!path.exists());
        assert!(!directory.exists());
    }

    #[tokio::test]
    async fn missing_malformed_and_oversized_manifests_fail_closed() {
        let manifest = ProviderOwnershipManifest::create().unwrap();
        std::fs::remove_file(manifest.path()).unwrap();
        assert_eq!(manifest.terminate_validated_groups(None).await, 0);

        std::fs::write(manifest.path(), b"not-json").unwrap();
        assert_eq!(manifest.terminate_validated_groups(None).await, 0);

        let oversized = vec![b'x'; MAX_MANIFEST_BYTES as usize + 1];
        std::fs::write(manifest.path(), oversized).unwrap();
        let started = tokio::time::Instant::now();
        assert_eq!(manifest.terminate_validated_groups(None).await, 0);
        assert!(started.elapsed() < Duration::from_millis(100));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn validates_and_kills_multiple_owned_groups_with_one_bounded_snapshot() {
        use std::os::unix::process::CommandExt;

        let manifest = ProviderOwnershipManifest::create().unwrap();
        let mut children = Vec::new();
        for _ in 0..8 {
            let mut command = Command::new("node");
            command
                .kill_on_drop(true)
                .args(["-e", "setInterval(() => {}, 1000)"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            command.as_std_mut().process_group(0);
            children.push(command.spawn().unwrap());
        }

        let identity_source = if cfg!(target_os = "linux") {
            "linux-proc-stat-v1"
        } else {
            "posix-ps-lstart-v1"
        };
        let ps_table = if cfg!(target_os = "linux") {
            HashMap::new()
        } else {
            ps_process_table().await.unwrap()
        };
        let providers = children
            .iter()
            .map(|child| {
                let pid = child.id().unwrap();
                let observed = if cfg!(target_os = "linux") {
                    linux_proc_observation(pid).unwrap()
                } else {
                    ps_table.get(&pid).unwrap().clone()
                };
                serde_json::json!({
                    "processGroupId": pid,
                    "identitySource": identity_source,
                    "members": [{ "pid": pid, "startTime": observed.start_time }],
                })
            })
            .collect::<Vec<_>>();
        std::fs::write(
            manifest.path(),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "runToken": manifest.run_token(),
                "generation": 1,
                "providers": providers,
            }))
            .unwrap(),
        )
        .unwrap();

        let started = tokio::time::Instant::now();
        assert_eq!(manifest.terminate_validated_groups(None).await, 8);
        assert!(started.elapsed() < Duration::from_secs(1));
        for child in &mut children {
            tokio::time::timeout(Duration::from_secs(1), child.wait())
                .await
                .expect("owned group was not killed")
                .unwrap();
        }
    }
}
