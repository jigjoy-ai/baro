//! Session transcript blocks: the chat-first spine of the v2 TUI.
//!
//! Conversation turns and run lifecycle events append blocks to one
//! scrolling feed (claude-code style). Story blocks render live from
//! `App` state so a running story's line updates in place instead of
//! appending a new line per event.

#[derive(Debug, Clone, PartialEq)]
pub enum SessionBlock {
    /// Plan accepted: the story list snapshot shown once, inline.
    PlanReady { total: u32, mode: String },
    /// A DAG level opened; its stories render live below it.
    Level { ordinal: u32, story_ids: Vec<String> },
    /// Live line for one story — content is derived from App state at
    /// render time (status glyph, route, elapsed, last activity).
    Story { id: String },
    /// Critic verdict for a story (kept even after the story line moves on).
    Critique { id: String, pass: bool, reason: String },
    /// DAG surgery: stories added/removed mid-run.
    Replan { source: String, reason: String },
    /// Merge outcome for an integrated story.
    Merge { id: String, ok: bool, detail: Option<String> },
    /// Recovery wave / supervisor intervention / verification — one-line
    /// system note in the run's voice.
    Note { text: String },
    /// Terminal summary card.
    Done { success: bool, summary: Vec<(String, String)> },
}

/// Feed with tail-follow semantics: `scroll_back == 0` pins to the tail;
/// scrolling up sets a distance from the tail so new blocks don't yank
/// the viewport.
#[derive(Debug, Default)]
pub struct SessionFeed {
    blocks: Vec<(u64, SessionBlock)>,
    /// Shared ordering clock: feed blocks and conversation turns take
    /// sequence numbers from the same counter so the transcript renders
    /// chronologically (mid-run chat lands between story lines).
    seq: u64,
    pub scroll_back: usize,
}

impl SessionFeed {
    pub fn next_seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    pub fn push(&mut self, block: SessionBlock) {
        // One live line per story: drop an earlier Story block when the
        // same story re-enters (retry/recovery) so it renders once.
        if let SessionBlock::Story { id } = &block {
            self.blocks.retain(
                |(_, b)| !matches!(b, SessionBlock::Story { id: existing } if existing == id),
            )
        }
        let seq = self.next_seq();
        self.blocks.push((seq, block));
    }

    pub fn blocks(&self) -> impl Iterator<Item = &SessionBlock> {
        self.blocks.iter().map(|(_, b)| b)
    }

    pub fn sequenced(&self) -> &[(u64, SessionBlock)] {
        &self.blocks
    }

    pub fn clear(&mut self) {
        self.blocks.clear();
        self.scroll_back = 0;
    }

    pub fn scroll_up(&mut self) {
        self.scroll_up_by(3);
    }

    pub fn scroll_down(&mut self) {
        self.scroll_down_by(3);
    }

    pub fn scroll_up_by(&mut self, rows: usize) {
        self.scroll_back = self.scroll_back.saturating_add(rows);
    }

    pub fn scroll_down_by(&mut self, rows: usize) {
        self.scroll_back = self.scroll_back.saturating_sub(rows);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn story_blocks_are_unique_per_story() {
        let mut feed = SessionFeed::default();
        feed.push(SessionBlock::Story { id: "S1".into() });
        feed.push(SessionBlock::Story { id: "S2".into() });
        feed.push(SessionBlock::Story { id: "S1".into() });
        let stories: Vec<_> = feed
            .blocks()
            .filter(|b| matches!(b, SessionBlock::Story { .. }))
            .collect();
        assert_eq!(stories.len(), 2);
        assert_eq!(
            feed.sequenced().last().map(|(_, b)| b),
            Some(&SessionBlock::Story { id: "S1".into() })
        );
    }

    #[test]
    fn tail_follow_survives_scrolling() {
        let mut feed = SessionFeed::default();
        feed.scroll_up();
        assert_eq!(feed.scroll_back, 3);
        feed.scroll_down();
        assert_eq!(feed.scroll_back, 0);
    }
}
