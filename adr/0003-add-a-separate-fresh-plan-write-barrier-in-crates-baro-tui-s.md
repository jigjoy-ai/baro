# ADR-0003: Add a separate fresh-plan write barrier in `crates/baro-tui/src/prd_write_guard.rs` at the fresh-plan write sites only

**Status:** Accepted
**Context:** prd.json must stay byte-identical along the whole failing resume path, and the goal requires a new protection placed exactly where a fresh plan would be written, separate from TS `persistPrdPreserving` (prd.ts:262-331), which must stay unchanged. Rust has a single blind full-file writer, `executor::write_prd` (executor.rs:359-373); guarding inside it would also block the legitimate resume-refine write at main.rs:2622 and the suffixed-branch rewrites.
**Decision:** Create `crates/baro-tui/src/prd_write_guard.rs` and register `mod prd_write_guard;` in main.rs's module list (main.rs:1-40). Public API, pure, no I/O:

```rust
pub const FRESH_PLAN_DURING_RESUME: &str = "baro: refusing to overwrite prd.json with a fresh plan while this run is resuming";
pub fn guard_fresh_plan_write(is_resume: bool) -> Result<(), String>;
```
Returns `Err(format!("{FRESH_PLAN_DURING_RESUME}\n{}", crate::cli::resume_guard::RESUME_EXITS))` when `is_resume` is true, `Ok(())` otherwise.

Call it in main.rs immediately before `executor::write_prd` at exactly these three fresh-plan sites, passing `app.is_resume`: main.rs:2652 (after `prd_from_review` 2642-2649), main.rs:3996 (`confirm_and_execute`), main.rs:4161 (progressive bootstrap). On `Err`, surface the string as the existing failure surface for that site (`return Err(msg.into())` where the enclosing fn returns `Result`, otherwise `app.exit_reason = Some(msg)` and abort the path) — never continue to `write_prd`.
Do NOT guard: main.rs:2622 (resume-refine write, derived from the resume-branch PRD and legitimate during resume), main.rs:2770 and main.rs:4092 (suffixed-branch rewrites of an already-written in-memory plan). Do NOT modify `executor::write_prd`, `executor::PrdFile`, or `packages/baro-orchestrator/src/prd.ts`.
**Consequences:** A fresh plan can never overwrite a resumed prd.json even if a future edit reintroduces a fall-through; the barrier is redundant with ADR-002 by design and both must hold. The three guarded call sites are the only ones that construct a plan from `prd_from_review`/`build_progressive_bootstrap_prd`; if a fourth is added later it must also call the barrier. Because the barrier lives in its own file, a story owning it writes `crates/baro-tui/src/prd_write_guard.rs` plus main.rs, and must not run in parallel with the ADR-002 story.
