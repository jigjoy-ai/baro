//! OSC 52 terminal clipboard copy and the operator's handed-over-commands log.

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let bytes = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((bytes[0] as u32) << 16) | ((bytes[1] as u32) << 8) | bytes[2] as u32;
        out.push(BASE64_ALPHABET[((n >> 18) & 0x3F) as usize] as char);
        out.push(BASE64_ALPHABET[((n >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            BASE64_ALPHABET[((n >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_ALPHABET[(n & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// The OSC 52 "set clipboard" control sequence for `text`.
pub fn osc52_sequence(text: &str) -> String {
    format!("\x1b]52;c;{}\x07", base64_encode(text.as_bytes()))
}

struct FencedBlock {
    lang: String,
    content: String,
}

fn fenced_blocks(md: &str) -> Vec<FencedBlock> {
    let mut blocks = Vec::new();
    let mut lines = md.lines();
    while let Some(line) = lines.next() {
        let Some(lang) = line.trim_start().strip_prefix("```") else {
            continue;
        };
        let lang = lang.trim().to_string();
        let mut content_lines = Vec::new();
        for inner in lines.by_ref() {
            if inner.trim_start().starts_with("```") {
                break;
            }
            content_lines.push(inner);
        }
        blocks.push(FencedBlock { lang, content: content_lines.join("\n") });
    }
    blocks
}

/// The last fenced code block in `md`, or `None` when it has no fence.
pub fn last_code_block(md: &str) -> Option<String> {
    fenced_blocks(md).into_iter().next_back().map(|b| b.content)
}

const SHELL_LANGS: [&str; 4] = ["sh", "bash", "shell", "zsh"];

fn shell_command_blocks(md: &str) -> Vec<String> {
    fenced_blocks(md)
        .into_iter()
        .filter(|b| SHELL_LANGS.contains(&b.lang.as_str()))
        .map(|b| b.content)
        .collect()
}

/// Appends every sh/bash/shell/zsh fenced block in `text` to
/// `<baro_home>/operator/last-commands.sh`, each preceded by a `# <timestamp>`
/// line. Creates the directory if missing. Returns the log path, or `None`
/// when `text` had no shell-tagged block to hand over.
pub fn append_last_commands(
    baro_home: &Path,
    timestamp: &str,
    text: &str,
) -> io::Result<Option<PathBuf>> {
    let blocks = shell_command_blocks(text);
    if blocks.is_empty() {
        return Ok(None);
    }
    let dir = baro_home.join("operator");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("last-commands.sh");
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    for block in &blocks {
        writeln!(file, "# {timestamp}")?;
        writeln!(file, "{}", block.trim_end_matches('\n'))?;
    }
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_osc52_sequence_wraps_base64_payload() {
        assert_eq!(osc52_sequence("hi"), "\x1b]52;c;aGk=\x07");
    }

    #[test]
    fn clipboard_osc52_sequence_pads_short_final_chunks() {
        // "hello" is 5 bytes: one full 3-byte chunk plus a 2-byte remainder,
        // which must end in a single '=' pad, not zero.
        assert_eq!(osc52_sequence("hello"), "\x1b]52;c;aGVsbG8=\x07");
    }

    #[test]
    fn clipboard_last_code_block_returns_the_last_fence() {
        let md = "before\n```rust\nfn a() {}\n```\ntext\n```sh\necho hi\n```\n";
        assert_eq!(last_code_block(md), Some("echo hi".to_string()));
    }

    #[test]
    fn clipboard_last_code_block_is_none_without_a_fence() {
        assert_eq!(last_code_block("just prose, no fences here"), None);
    }

    #[test]
    fn last_commands_creates_operator_dir_and_appends_tagged_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let baro_home = dir.path();
        assert!(!baro_home.join("operator").exists());
        let md = "run this:\n```sh\necho one\n```\nskip:\n```python\nprint('skip')\n```\nthen:\n```bash\necho two\n```\n";

        let path = append_last_commands(baro_home, "2026-01-01T00:00:00.000Z", md)
            .unwrap()
            .expect("shell blocks present");

        assert_eq!(path, baro_home.join("operator").join("last-commands.sh"));
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            "# 2026-01-01T00:00:00.000Z\necho one\n# 2026-01-01T00:00:00.000Z\necho two\n"
        );
    }

    #[test]
    fn last_commands_appends_across_calls_instead_of_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let baro_home = dir.path();
        append_last_commands(baro_home, "t1", "```zsh\necho a\n```\n").unwrap();
        append_last_commands(baro_home, "t2", "```shell\necho b\n```\n").unwrap();

        let content =
            std::fs::read_to_string(baro_home.join("operator").join("last-commands.sh")).unwrap();
        assert_eq!(content, "# t1\necho a\n# t2\necho b\n");
    }

    #[test]
    fn last_commands_returns_none_and_creates_nothing_without_a_shell_block() {
        let dir = tempfile::tempdir().unwrap();
        let result =
            append_last_commands(dir.path(), "t", "```python\nprint(1)\n```\n").unwrap();
        assert!(result.is_none());
        assert!(!dir.path().join("operator").exists());
    }
}
