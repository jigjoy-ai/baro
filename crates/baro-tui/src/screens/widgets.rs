//! Shared render helpers used by the workbench explorer, main views and DAG.

use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, ListItem},
};

use crate::app::{ActivityEntry, ReplanMark, StoryState, StoryStatus};
use crate::theme;

pub(crate) fn status_icon_color(status: &StoryStatus) -> (&'static str, Color) {
    match status {
        StoryStatus::Complete => ("✓", theme::SUCCESS),
        StoryStatus::Running => ("▶", theme::WARNING),
        StoryStatus::Failed => ("✗", theme::ERROR),
        StoryStatus::Retrying(_) => ("↻", theme::WARNING),
        StoryStatus::Skipped => ("⊘", theme::MUTED), // dropped (e.g. dep failed)
        StoryStatus::Pending => ("○", theme::MUTED),
    }
}

/// Truncate a string to `max` *characters* (not bytes), appending an
/// ellipsis if it was shortened. Operates on `chars()` so multi-byte
/// codepoints don't get cut in half.
pub(crate) fn truncate_for_panel(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Bordered pane with the workbench title treatment; active focus gets
/// the amber border.
pub(crate) fn pane_block(title: String, active: bool) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(if active {
            theme::BORDER_ACTIVE
        } else {
            theme::BORDER
        }))
        .title(Span::styled(
            title,
            Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
        ))
}

/// Compact signal pills after the title — only rendered when the signal
/// actually fired, so quiet stories stay quiet.
pub(crate) fn story_pills(story: &StoryState) -> Vec<Span<'static>> {
    let mut pills: Vec<Span> = Vec::new();
    let mut pill = |text: String, color: Color| {
        pills.push(Span::styled(format!(" {}", text), Style::default().fg(color)));
    };

    let retries = match story.status {
        StoryStatus::Retrying(n) => n.max(story.retry_count),
        _ => story.retry_count,
    };
    if retries > 0 {
        pill(format!("↻{}", retries), theme::WARNING);
    }
    match story.critic_pass {
        Some(true) => pill("✓critic".into(), theme::SUCCESS),
        Some(false) => pill("✗critic".into(), theme::ERROR),
        None => {}
    }
    if let Some(action) = &story.intervened {
        let color = if action.contains("abort") { theme::ERROR } else { theme::WARNING };
        pill("⚠stall".into(), color);
    }
    match story.merge {
        Some(true) => pill("✓merged".into(), theme::SUCCESS),
        Some(false) => pill("✗merge".into(), theme::ERROR),
        None => {}
    }
    if story.replan.is_some() {
        pill("✂replan".into(), theme::REPLAN);
    }
    pills
}

/// One agent/story row: status icon, id, truncated title, duration, push
/// indicator, signal pills, model lane. `title_budget` scales with the
/// hosting panel's width so the explorer's compact variant stays readable.
pub(crate) fn story_list_item(
    story: &StoryState,
    push_results: &[(String, bool, Option<String>)],
    title_budget: usize,
) -> ListItem<'static> {
    let (icon, color) = status_icon_color(&story.status);
    let style = Style::default().fg(color);

    let duration = story
        .duration_secs
        .map(|d| format!(" ({}:{:02})", d / 60, d % 60))
        .unwrap_or_default();

    let push_indicator = if story.status == StoryStatus::Complete {
        if let Some((_, success, _)) = push_results.iter().find(|(id, _, _)| id == &story.id) {
            if *success {
                Some(Span::styled(" ↑", Style::default().fg(theme::SUCCESS)))
            } else {
                Some(Span::styled(" ↑!", Style::default().fg(theme::ERROR)))
            }
        } else {
            None
        }
    } else {
        None
    };

    let title = truncate_for_panel(&story.title, title_budget.max(8));

    // Removed-by-replan stories read as struck plan surgery, not failure.
    let title_style = if matches!(story.replan, Some(ReplanMark::Removed(_))) {
        Style::default().fg(theme::MUTED).add_modifier(Modifier::CROSSED_OUT)
    } else {
        style
    };

    let mut spans = vec![
        Span::raw("   "),
        Span::styled(format!("{} {}: ", icon, story.id), style),
        Span::styled(title, title_style),
        Span::styled(duration, style),
    ];
    if let Some(indicator) = push_indicator {
        spans.push(indicator);
    }
    spans.extend(story_pills(story));
    if let Some(route) = &story.route {
        spans.push(Span::styled(
            format!("  {}", route),
            Style::default().fg(theme::MUTED),
        ));
    }

    ListItem::new(Line::from(spans))
}

/// One Activity entry → a color-coded line. Icon carries the type signal;
/// file changes + test verdicts color the whole line (diff-like). The panel
/// is already scoped to one story, so no per-line agent prefix. System
/// entries (replan/intervention/recovery/merge) get a ▸ accent prefix so run
/// machinery stands apart from agent output.
pub(crate) fn activity_line(e: &ActivityEntry, width: usize) -> Line<'static> {
    if e.system {
        let text_color = match e.kind.as_str() {
            "replan" => theme::REPLAN,
            "warn" | "conflict" => theme::WARNING,
            "error" => theme::ERROR,
            "merge" => theme::SUCCESS,
            "verdict" => {
                if e.ok == Some(true) { theme::SUCCESS } else { theme::ERROR }
            }
            _ => theme::ACCENT,
        };
        let budget = width.saturating_sub(2).max(8);
        return Line::from(vec![
            Span::styled("▸ ", Style::default().fg(theme::ACCENT)),
            Span::styled(truncate_for_panel(&e.text, budget), Style::default().fg(text_color)),
        ]);
    }
    let (icon, icon_color, text_color) = match e.kind.as_str() {
        "tool_call" => match e.tool.as_deref() {
            Some("bash") => ("$ ", theme::ACCENT, theme::TEXT),
            Some("read") => ("· ", theme::TEXT_DIM, theme::TEXT_DIM),
            _ => ("» ", theme::ACCENT, theme::TEXT),
        },
        "file_change" => match e.op.as_deref() {
            Some("modify") => ("~ ", theme::WARNING, theme::WARNING),
            _ => ("+ ", theme::SUCCESS, theme::SUCCESS),
        },
        "agent_msg" => ("› ", theme::TEXT_DIM, theme::TEXT_DIM),
        "tool_result" => ("  ", theme::MUTED, theme::MUTED),
        "test" | "verdict" => {
            if e.ok == Some(true) {
                ("✓ ", theme::SUCCESS, theme::SUCCESS)
            } else {
                ("✗ ", theme::ERROR, theme::ERROR)
            }
        }
        "decision" => ("◆ ", theme::ACCENT, theme::TEXT),
        "conflict" | "warn" => ("! ", theme::WARNING, theme::WARNING),
        "error" => ("✗ ", theme::ERROR, theme::ERROR),
        _ => ("  ", theme::TEXT, theme::TEXT),
    };
    // Truncate to the panel width (minus the 2-char icon) so long lines get a
    // clean ellipsis instead of ratatui clipping them mid-word at the edge.
    let budget = width.saturating_sub(icon.chars().count()).max(8);
    Line::from(vec![
        Span::styled(icon, Style::default().fg(icon_color)),
        Span::styled(truncate_for_panel(&e.text, budget), Style::default().fg(text_color)),
    ])
}
