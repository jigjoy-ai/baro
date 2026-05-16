//! Provider picker — the first screen `baro` shows when invoked with
//! no goal. Two options:
//!
//!   0. Claude Code      — uses the existing `claude` CLI session.
//!                         No API key needed.
//!   1. Mozaik native    — every phase routes through Mozaik's
//!      (OpenAI)          native OpenAI runner. Needs an
//!                         `OPENAI_API_KEY` (read from env, or
//!                         entered on the next screen).
//!
//! Up/Down to highlight, Enter to confirm. The picked
//! `LlmProvider` lands in `app.llm`; the next screen is decided in
//! `main.rs` based on env presence.

use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::app::App;
use crate::theme;

pub fn draw(f: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2), // top padding
            Constraint::Length(2), // title
            Constraint::Length(2), // subtitle
            Constraint::Length(2), // gap
            Constraint::Length(7), // option 1
            Constraint::Length(1), // gap
            Constraint::Length(7), // option 2
            Constraint::Length(2), // gap
            Constraint::Length(2), // hint
            Constraint::Min(0),
        ])
        .split(centred(area, 78));

    let title = Paragraph::new(Line::from(vec![Span::styled(
        "baro",
        Style::default()
            .fg(theme::LOGO_2)
            .add_modifier(Modifier::BOLD),
    )]))
    .alignment(Alignment::Center);
    f.render_widget(title, chunks[1]);

    let subtitle = Paragraph::new(Line::from(vec![Span::styled(
        "Pick a backend",
        Style::default().fg(theme::TEXT),
    )]))
    .alignment(Alignment::Center);
    f.render_widget(subtitle, chunks[2]);

    let claude_selected = app.provider_picker_index == 0;
    let openai_selected = app.provider_picker_index == 1;

    f.render_widget(
        option_widget(
            claude_selected,
            "Claude Code",
            &[
                "The default. Drives every phase through your existing",
                "`claude` CLI session — no API key, your subscription does",
                "the work. Best when you're already paying for Claude Pro/Max.",
            ],
        ),
        chunks[4],
    );

    f.render_widget(
        option_widget(
            openai_selected,
            "Mozaik native — OpenAI",
            &[
                "Runs every phase through gpt-5.x via Mozaik's native",
                "OpenAI inference runner. Requires OPENAI_API_KEY (either",
                "in your shell already, or entered on the next screen).",
            ],
        ),
        chunks[6],
    );

    let hint = Paragraph::new(Line::from(vec![
        Span::styled("↑", Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)),
        Span::styled("/", Style::default().fg(theme::MUTED)),
        Span::styled("↓", Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)),
        Span::styled("  choose    ", Style::default().fg(theme::MUTED)),
        Span::styled("Enter", Style::default().fg(theme::SUCCESS).add_modifier(Modifier::BOLD)),
        Span::styled("  confirm    ", Style::default().fg(theme::MUTED)),
        Span::styled("q", Style::default().fg(theme::ERROR).add_modifier(Modifier::BOLD)),
        Span::styled("  quit", Style::default().fg(theme::MUTED)),
    ]))
    .alignment(Alignment::Center);
    f.render_widget(hint, chunks[8]);
}

fn option_widget(selected: bool, title: &str, body: &[&str]) -> Paragraph<'static> {
    let (border, title_style, marker) = if selected {
        (
            theme::ACCENT,
            Style::default()
                .fg(theme::ACCENT_BRIGHT)
                .add_modifier(Modifier::BOLD),
            "▶  ",
        )
    } else {
        (
            theme::BORDER,
            Style::default().fg(theme::TEXT_DIM),
            "   ",
        )
    };

    let mut lines: Vec<Line<'static>> = Vec::new();
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled(marker.to_string(), Style::default().fg(theme::ACCENT)),
        Span::styled(title.to_string(), title_style),
    ]));
    for body_line in body {
        lines.push(Line::from(vec![
            Span::raw("   "),
            Span::styled(body_line.to_string(), Style::default().fg(theme::MUTED)),
        ]));
    }

    Paragraph::new(lines)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(border)),
        )
        .wrap(Wrap { trim: false })
}

/// Horizontally centre a sub-area `width` wide inside the parent
/// terminal `area`. If the terminal is narrower than `width`, fall
/// back to the full width.
fn centred(area: Rect, width: u16) -> Rect {
    if area.width <= width {
        return area;
    }
    let pad = (area.width - width) / 2;
    Rect {
        x: area.x + pad,
        y: area.y,
        width,
        height: area.height,
    }
}
