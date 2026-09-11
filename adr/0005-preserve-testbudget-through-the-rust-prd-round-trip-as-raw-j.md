# ADR-0005: Preserve testBudget through the Rust PRD round-trip as raw JSON

**Status:** Accepted
**Context:** `executor.rs` `write_prd` serializes `PrdStory`, and serde drops unknown fields. `ReviewStory` (app.rs) and `PrdStoryOutput` (planner_host.rs) do the same. This is the same bug the conformance test documents for `writes`. The value is kept raw so that admission, not Rust, judges it.
**Decision:** executor.rs `PrdStory`: add `#[serde(rename = "testBudget", default, skip_serializing_if = "Option::is_none")] pub test_budget: Option<serde_json::Value>`.

app.rs `ReviewStory`: add `pub test_budget: Option<serde_json::Value>` (Value implements Eq).

planner_host.rs `PrdStoryOutput`: add `#[serde(default, rename = "testBudget")] test_budget: Option<Value>` and map it in `From<PrdStoryOutput> for ReviewStory`.

executor.rs `prd_story_from_review`: add `test_budget: story.test_budget.clone()`.

review_refiner.rs projections (~:144, :161): add `"testBudget": story.test_budget`.

Every other `ReviewStory {..}` literal (main.rs, screens/session.rs, executor.rs tests, review_refiner.rs): copy the field if a source story is available, otherwise set `test_budget: None`.

No validation happens in Rust.
**Consequences:** `cargo build` and `cargo test` must pass. The conformance test passes because executor.rs names test_budget/testBudget.
