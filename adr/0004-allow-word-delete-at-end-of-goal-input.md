# ADR-0004: Allow Ctrl+W word-delete at the end of the goal input

**Status:** Accepted (supersedes the "no word-delete" clause of ADR-0003)

**Context:** ADR-0003 kept goal editing append-only and excluded word-delete. The user then asked for terminal-style word deletion. Alt/Option+Delete was tried but does not reach the app reliably across terminals, so it is dropped; Ctrl+W is the portable chord. Mid-string cursor movement and insert-at-cursor remain out of scope — only deletion at the end of the buffer.

**Decision:** In `main.rs`, on `KeyCode::Char('w')` with `CONTROL`, delete the previous word from the end of `app.goal_input` via a small `delete_prev_word(&mut String)` helper (trim trailing whitespace, then drop the trailing run of non-whitespace, char-boundary safe, with a unit test). No `goal_cursor` field, no insert-at-cursor, no arrow-key movement.

**Consequences:** Editing stays append/end-only — no `App` state change beyond the existing `goal_input` string. True in-line editing remains a future ADR.
