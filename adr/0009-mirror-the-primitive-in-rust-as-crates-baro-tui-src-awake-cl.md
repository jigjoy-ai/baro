# ADR-0009: Mirror the primitive in Rust as `crates/baro-tui/src/awake_clock.rs`, sampled on the existing 100ms Tick

**Status:** Accepted
**Context:** app.rs derives `elapsed_secs` (:2140-2146) and `planning_elapsed_secs` (:894-898) from `std::time::Instant`, which does not advance while the machine is asleep, whereas operator_client.rs `elapsed_now` (:55-74) subtracts two `SystemTime` epoch-millis values and therefore does count sleep. For the same run the two already disagree. main.rs:1437-1438 drives a 100ms `AppEvent::Tick` whose handler (:3209-3211) only bumps `tick_count`, so a sampling point already exists and no new loop is needed.
**Decision:** Add `crates/baro-tui/src/awake_clock.rs` (declared as a module in main.rs alongside the existing ones) exporting:
`pub const SUSPENSION_GAP_THRESHOLD_MS: u64 = 2_000;`
`pub struct AwakeClock { /* last_wall_ms, last_monotonic: Instant, gaps: VecDeque<(u64 /*detected_at_wall_ms*/, u64 /*gap_ms*/)> */ }`
`impl AwakeClock { pub fn new() -> Self; pub fn sample(&mut self) -> Option<u64>; pub fn absorbed_gap_ms_since(&self, started_wall_ms: u64) -> u64; }`
plus a process-global accessor pair for the UI path: `pub fn sample_global() -> Option<u64>` and `pub fn absorbed_gap_ms_since_global(started_wall_ms: u64) -> u64`, backed by a `static` `Mutex<AwakeClock>` (std only — no new crate). Detection compares wall (`SystemTime::now()` epoch millis) delta against `Instant` delta; a difference `>= SUSPENSION_GAP_THRESHOLD_MS` is recorded as a gap. The gap ring is capped at 256 entries, dropping oldest.

Wiring:
- main.rs `Some(AppEvent::Tick)` arm (:3209-3211) keeps `app.tick_count += 1` and additionally calls `awake_clock::sample_global()`; nothing else changes in that loop and the 100ms cadence is not altered.
- app.rs `elapsed_secs` and `planning_elapsed_secs` stay `Instant`-based — `Instant` already excludes suspend on the supported platforms, so they are awake time by construction. Add at most one short comment saying so; do not restructure them.
- operator_client.rs `elapsed_now` (:55-74) subtracts the absorbed gap: `let secs = end.saturating_sub(started).saturating_sub(awake_clock::absorbed_gap_ms_since_global(started)) / 1000;`. The `started_ms`/`finished_ms` fields, the serde shape and the `{secs}s` / `{m}m {ss}s` formatting stay byte-identical.
- src/conversation_frontdoor.rs: verify only. `tokio::time::sleep` already pauses across suspend, so no compensation is applied there; record the finding as a one-line comment at the relevant sleep and do not change its structure.

Unit tests go in an inline `#[cfg(test)] mod tests` in awake_clock.rs (the crate's convention, cf. provider_ownership.rs:395), driving `AwakeClock` with injected wall/monotonic values — no real sleeping.
**Consequences:** app.rs and operator_client.rs report the same awake elapsed for one run. Only main.rs, operator_client.rs and the new module change on the Rust side; app.rs is comment-only. Gaps detected before a run's `started_ms` are correctly excluded because the ring is keyed on wall detection time.
