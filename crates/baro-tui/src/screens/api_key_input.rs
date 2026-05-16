//! API-key entry — shown only when the user picked Mozaik native on
//! the provider screen AND `OPENAI_API_KEY` was not already in the
//! environment. The key is held in `app.api_key_input` while typing
//! and confirmed into `app.openai_api_key` on Enter. Subsequent
//! subprocess spawns inject it as the env var; nothing is written
//! to disk.
//!
//! Masking: we show the first 7 characters (`sk-prox`-ish) plus the
//! last 4, and dot the middle. A user pasting in their key still
//! sees enough to recognise typos at the boundary, but a screen
//! recording wouldn't capture the secret in full.

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
            Constraint::Length(3), // input box
            Constraint::Length(1), // gap
            Constraint::Length(4), // help text
            Constraint::Length(2), // gap
            Constraint::Length(1), // hint
            Constraint::Min(0),
        ])
        .split(centred(area, 70));

    let title = Paragraph::new(Line::from(vec![Span::styled(
        "baro",
        Style::default()
            .fg(theme::LOGO_2)
            .add_modifier(Modifier::BOLD),
    )]))
    .alignment(Alignment::Center);
    f.render_widget(title, chunks[1]);

    let subtitle = Paragraph::new(Line::from(vec![Span::styled(
        "OpenAI API key",
        Style::default().fg(theme::TEXT),
    )]))
    .alignment(Alignment::Center);
    f.render_widget(subtitle, chunks[2]);

    let masked = mask(&app.api_key_input);
    let input = Paragraph::new(Line::from(vec![Span::styled(
        if masked.is_empty() {
            "  (paste your sk-…)".to_string()
        } else {
            format!("  {}_", masked)
        },
        Style::default().fg(theme::TEXT),
    )]))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::ACCENT)),
    );
    f.render_widget(input, chunks[4]);

    let help_lines = vec![
        Line::from(vec![Span::styled(
            "Get one at platform.openai.com.",
            Style::default().fg(theme::MUTED),
        )]),
        Line::from(vec![Span::styled(
            "Held in memory only, never written to disk — entered fresh",
            Style::default().fg(theme::MUTED),
        )]),
        Line::from(vec![Span::styled(
            "each run unless OPENAI_API_KEY is already in your shell.",
            Style::default().fg(theme::MUTED),
        )]),
    ];
    let help = Paragraph::new(help_lines)
        .alignment(Alignment::Center)
        .wrap(Wrap { trim: false });
    f.render_widget(help, chunks[6]);

    let hint = Paragraph::new(Line::from(vec![
        Span::styled(
            "Enter",
            Style::default()
                .fg(theme::SUCCESS)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("  confirm    ", Style::default().fg(theme::MUTED)),
        Span::styled(
            "Esc",
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("  back    ", Style::default().fg(theme::MUTED)),
        Span::styled(
            "q",
            Style::default()
                .fg(theme::ERROR)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("  quit", Style::default().fg(theme::MUTED)),
    ]))
    .alignment(Alignment::Center);
    f.render_widget(hint, chunks[8]);
}

/// Show first 7 + last 4 chars, dot the middle. Anything shorter
/// than 11 chars renders fully (user is still mid-paste).
fn mask(raw: &str) -> String {
    let n = raw.chars().count();
    if n <= 11 {
        return raw.to_string();
    }
    let head: String = raw.chars().take(7).collect();
    let tail: String = raw.chars().skip(n - 4).collect();
    let middle_len = n.saturating_sub(11).min(40);
    format!("{}{}{}", head, "•".repeat(middle_len), tail)
}

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
