# ADR-0013: #152: Add OSC 52 copy, release the mouse while typing, and save handed-over commands to a file

**Status:** Accepted
**Context:** Mouse capture is enabled once at main.rs:562. There is no clipboard code, and the footer hints are in screens/session.rs:1118-1137.
**Decision:** New file crates/baro-tui/src/clipboard.rs:
- `pub fn osc52_sequence(text:&str)->String` = "\x1b]52;c;<base64>\x07", using a small hand-written base64. Do NOT add a crate.
- `pub fn last_code_block(md:&str)->Option<String>`.

Copy key: Ctrl+Y on Screen::Conversation copies the last fenced code block of the last assistant message, or else the whole message. The sequence is written to stdout and a transient status line 'copied' is shown. Add the footer hint `ctrl+y copy` next to the operator hints.

Mouse capture:
- main.rs keeps `mouse_captured: bool`.
- DisableMouseCapture when the conversation input box has focus; EnableMouseCapture when focus is cleared.

Handed-over commands:
- Fenced blocks tagged sh|bash|shell|zsh in operator assistant messages are appended to baro_home()/operator/last-commands.sh, each preceded by a `# <timestamp>` line.
- The directory is created if missing.
- A transcript line shows `commands saved to <path>`.

Rust unit tests cover osc52_sequence, last_code_block and the append helper.
**Consequences:** Touches main.rs event handling only in the conversation branch. Must not change the ±1 scroll mapping.
