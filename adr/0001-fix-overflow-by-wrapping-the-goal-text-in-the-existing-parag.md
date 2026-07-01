# ADR-0001: Fix overflow by wrapping the goal text in the existing `Paragraph` — no new dependency

**Status:** Accepted
**Context:** The goal box overflows because its `Paragraph` neither wraps nor scrolls. Options considered: (a) add `tui-textarea` for full terminal-style editing; (b) implement horizontal single-line scrolling with a cursor index; (c) enable ratatui's built-in word-wrap so the text flows onto multiple lines. The user asked only to fix overflow ("input text is getting overflowed"), not for a full terminal editor — full editing is out of scope (see ADR-003). Adding a crate or a hand-rolled scroll/cursor model is more code than the bug needs. ratatui's `Paragraph::wrap` solves overflow directly.
**Decision:** In `crates/baro-tui/src/screens/welcome.rs`:
- Keep `app.goal_input` as a single `String`. **Do NOT** add `tui-textarea` or any new dependency. **Do NOT** add a cursor-index/scroll-offset field to `App`.
- Replace the three-line `display_text` construction (the leading/trailing blank `Line::from("")` padding and the single text `Line`) with a single content `Line` (typed text styled as today, followed by the existing blinking `cursor_char` span) for the non-empty case, and the existing placeholder line for the empty case. Drop the blank-line vertical padding so wrapped lines have room to use the full inner height.
- Add `.wrap(ratatui::widgets::Wrap { trim: false })` to the goal `Paragraph` (import `Wrap` from `ratatui::widgets`). `trim: false` preserves the leading space and the user's spacing.
- Leave `input_width`, the `center(...)` helper, the border/title styling, and the blinking-cursor logic unchanged.
**Consequences:** Long goals now wrap onto subsequent inner rows instead of being clipped. The cursor block stays at the end of the typed text and wraps with it. No `Cargo.toml` change, no `App` struct change. Editing semantics are untouched here (handled in ADR-003).
