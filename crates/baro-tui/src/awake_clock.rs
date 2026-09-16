use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub const SUSPENSION_GAP_THRESHOLD_MS: u64 = 2_000;

// Capped so a long-lived TUI cannot grow the ring unbounded; oldest-first is
// safe because a run only ever sums gaps detected after it started.
const MAX_TRACKED_GAPS: usize = 256;

static GLOBAL: Mutex<Option<AwakeClock>> = Mutex::new(None);

pub struct AwakeClock {
    monotonic_origin: Instant,
    last_wall_ms: u64,
    last_monotonic_ms: u64,
    // (detected_at_wall_ms, gap_ms)
    gaps: VecDeque<(u64, u64)>,
}

impl AwakeClock {
    pub fn new() -> Self {
        Self {
            monotonic_origin: Instant::now(),
            last_wall_ms: wall_now_ms(),
            last_monotonic_ms: 0,
            gaps: VecDeque::new(),
        }
    }

    pub fn sample(&mut self) -> Option<u64> {
        let monotonic_ms = self.monotonic_origin.elapsed().as_millis() as u64;
        self.sample_at(wall_now_ms(), monotonic_ms)
    }

    pub fn absorbed_gap_ms_since(&self, started_wall_ms: u64) -> u64 {
        self.gaps
            .iter()
            .filter(|(detected_at_wall_ms, _)| *detected_at_wall_ms >= started_wall_ms)
            .map(|(_, gap_ms)| *gap_ms)
            .sum()
    }

    // Instant does not advance while the machine is suspended, so wall time
    // running ahead of it is the gap. Saturating throughout: a backwards wall
    // clock (NTP step) must read as no gap, never as a negative one.
    fn sample_at(&mut self, wall_ms: u64, monotonic_ms: u64) -> Option<u64> {
        let wall_delta = wall_ms.saturating_sub(self.last_wall_ms);
        let monotonic_delta = monotonic_ms.saturating_sub(self.last_monotonic_ms);
        self.last_wall_ms = wall_ms;
        self.last_monotonic_ms = monotonic_ms;

        let gap_ms = wall_delta.saturating_sub(monotonic_delta);
        if gap_ms < SUSPENSION_GAP_THRESHOLD_MS {
            return None;
        }
        if self.gaps.len() == MAX_TRACKED_GAPS {
            self.gaps.pop_front();
        }
        self.gaps.push_back((wall_ms, gap_ms));
        Some(gap_ms)
    }
}

pub fn sample_global() -> Option<u64> {
    with_global(|clock| clock.sample())
}

pub fn absorbed_gap_ms_since_global(started_wall_ms: u64) -> u64 {
    with_global(|clock| clock.absorbed_gap_ms_since(started_wall_ms))
}

fn with_global<T>(f: impl FnOnce(&mut AwakeClock) -> T) -> T {
    let mut guard = GLOBAL.lock().unwrap_or_else(PoisonError::into_inner);
    f(guard.get_or_insert_with(AwakeClock::new))
}

fn wall_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operator_client::{OperatorRun, OperatorStory};

    fn clock_at(wall_ms: u64, monotonic_ms: u64) -> AwakeClock {
        AwakeClock {
            monotonic_origin: Instant::now(),
            last_wall_ms: wall_ms,
            last_monotonic_ms: monotonic_ms,
            gaps: VecDeque::new(),
        }
    }

    fn run(started_ms: u64, finished_ms: Option<u64>) -> OperatorRun {
        OperatorRun {
            id: "run-1".to_string(),
            state: "running".to_string(),
            phase: "execute".to_string(),
            completed: 0,
            total: 0,
            goal: String::new(),
            elapsed: String::new(),
            started_ms: Some(started_ms),
            finished_ms,
            pr_url: None,
            activity: None,
            stories: Vec::<OperatorStory>::new(),
            milestones: Vec::new(),
            activity_tail: Vec::new(),
            error: None,
        }
    }

    #[test]
    fn drift_below_the_threshold_is_never_absorbed() {
        let mut clock = clock_at(1_000_000, 0);
        for step in 1..=10u64 {
            let drift = SUSPENSION_GAP_THRESHOLD_MS - 1;
            assert_eq!(clock.sample_at(1_000_000 + step * (100 + drift), step * 100), None);
        }
        assert_eq!(clock.absorbed_gap_ms_since(0), 0);
    }

    #[test]
    fn one_large_gap_is_absorbed_whole() {
        let mut clock = clock_at(1_000_000, 0);
        let suspend_ms = 4 * 60 * 60 * 1_000;

        assert_eq!(clock.sample_at(1_000_000 + suspend_ms + 100, 100), Some(suspend_ms));
        assert_eq!(clock.absorbed_gap_ms_since(0), suspend_ms);
    }

    #[test]
    fn a_gap_exactly_at_the_threshold_is_absorbed() {
        let mut clock = clock_at(0, 0);

        assert_eq!(clock.sample_at(SUSPENSION_GAP_THRESHOLD_MS, 0), Some(SUSPENSION_GAP_THRESHOLD_MS));
    }

    #[test]
    fn many_small_gaps_accumulate_and_only_those_after_the_start_count() {
        let mut clock = clock_at(500_000, 0);
        for step in 1..=5u64 {
            assert_eq!(clock.sample_at(500_000 + step * 5_000, step * 1_000), Some(4_000));
        }

        assert_eq!(clock.absorbed_gap_ms_since(0), 20_000);
        // Detection wall time keys the ring, so a run that started midway
        // inherits only the gaps detected after it began.
        assert_eq!(clock.absorbed_gap_ms_since(500_000 + 3 * 5_000), 12_000);
        assert_eq!(clock.absorbed_gap_ms_since(500_000 + 5 * 5_000 + 1), 0);
    }

    #[test]
    fn the_gap_ring_drops_the_oldest_past_its_cap() {
        let mut clock = clock_at(0, 0);
        for step in 1..=(MAX_TRACKED_GAPS as u64 + 10) {
            assert_eq!(clock.sample_at(step * 10_000, step * 1_000), Some(9_000));
        }

        assert_eq!(clock.gaps.len(), MAX_TRACKED_GAPS);
        assert_eq!(clock.absorbed_gap_ms_since(0), MAX_TRACKED_GAPS as u64 * 9_000);
        assert_eq!(clock.gaps.front().map(|(at, _)| *at), Some(11 * 10_000));
    }

    // The only test that touches the process-global clock, so it may seed it.
    #[test]
    fn elapsed_now_matches_instant_elapsed_across_absorbed_gap() {
        let started = 1_700_000_000_000u64;
        let awake_ms = 30_000u64;
        let suspend_ms = 3 * 60 * 60 * 1_000u64;

        assert_eq!(run(started, Some(started + awake_ms)).elapsed_now(), "30s");

        with_global(|clock| {
            clock.gaps.clear();
            clock.last_wall_ms = started;
            clock.last_monotonic_ms = 0;
            assert_eq!(
                clock.sample_at(started + suspend_ms + awake_ms, awake_ms),
                Some(suspend_ms)
            );
        });

        // app.rs reports 30s from its Instant, which never ran during the
        // suspend; elapsed_now must subtract the absorbed gap to agree.
        assert_eq!(
            run(started, Some(started + suspend_ms + awake_ms)).elapsed_now(),
            "30s"
        );

        with_global(|clock| clock.gaps.clear());
    }
}
