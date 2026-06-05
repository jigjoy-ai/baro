//! Provider picker — the first screen `baro` shows when invoked with
//! no goal and no explicit `--llm`. Dynamically shows backends detected
//! at startup:
//!
//!   - Claude Code      — always available
//!   - Mozaik native    — always available (needs OPENAI_API_KEY)
//!   - Codex            — shown when `codex` is on PATH
//!   - OpenCode         — shown when `opencode` is on PATH
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

use crate::app::{App, LlmProvider};
use crate::theme;

/// Description text for each provider option.
fn provider_description(provider: LlmProvider) -> &'static [&'static str] {
    match provider {
        LlmProvider::Claude => &[
            "The default. Drives every phase through your existing",
            "`claude` CLI session — no API key, your subscription does",
            "the work. Best when you're already paying for Claude Pro/Max.",
        ],
        LlmProvider::OpenAI => &[
            "Runs every phase through gpt-5.x via Mozaik's native",
            "OpenAI inference runner. Requires OPENAI_API_KEY (either",
            "in your shell already, or entered on the next screen).",
        ],
        LlmProvider::Codex => &[
            "OpenAI Codex CLI. Drives every phase through your",
            "`codex` CLI session — ChatGPT Pro/Plus subscription",
            "billing. One-shot non-interactive per story.",
        ],
        LlmProvider::OpenCode => &[
            "OpenCode CLI — multi-provider agent shell. Uses whatever",
            "model you configured in opencode (any provider). No extra",
            "API keys needed, opencode manages its own credentials.",
        ],
        LlmProvider::Copilot => &[
            "GitHub Copilot CLI. Drives every phase through your",
            "`copilot` CLI session — uses your gh/Copilot auth. No extra",
            "API keys needed. One-shot non-interactive per story.",
        ],
    }
}

fn provider_title(provider: LlmProvider) -> &'static str {
    match provider {
        LlmProvider::Claude => "Claude Code",
        LlmProvider::OpenAI => "Mozaik native — OpenAI",
        LlmProvider::Codex => "Codex CLI",
        LlmProvider::OpenCode => "OpenCode",
        LlmProvider::Copilot => "GitHub Copilot CLI",
    }
}

pub fn draw(f: &mut Frame, app: &App, area: Rect) {
    let num_options = app.provider_picker_options.len();

    // Dynamic layout: title area + one 7-row box per option + gaps + hint
    let mut constraints: Vec<Constraint> = vec![
        Constraint::Length(2), // top padding
        Constraint::Length(2), // title
        Constraint::Length(2), // subtitle
        Constraint::Length(1), // gap
    ];
    for i in 0..num_options {
        constraints.push(Constraint::Length(7)); // option box
        if i < num_options - 1 {
            constraints.push(Constraint::Length(1)); // gap between options
        }
    }
    constraints.push(Constraint::Length(2)); // gap before hint
    constraints.push(Constraint::Length(2)); // hint
    constraints.push(Constraint::Min(0)); // remaining

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
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

    // Render each option box
    let options_start = 4; // chunk index where option boxes begin
    for (i, &provider) in app.provider_picker_options.iter().enumerate() {
        let selected = app.provider_picker_index == i;
        // Options alternate with gap chunks: option at +0, gap at +1
        let chunk_idx = options_start + i * 2;
        if chunk_idx < chunks.len() {
            f.render_widget(
                option_widget(
                    selected,
                    provider_title(provider),
                    provider_description(provider),
                ),
                chunks[chunk_idx],
            );
        }
    }

    // Hint line is at chunks.len() - 2 (before the Min(0) filler)
    let hint_idx = chunks.len() - 2;
    let hint = Paragraph::new(Line::from(vec![
        Span::styled(
            "↑",
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("/", Style::default().fg(theme::MUTED)),
        Span::styled(
            "↓",
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("  choose    ", Style::default().fg(theme::MUTED)),
        Span::styled(
            "Enter",
            Style::default()
                .fg(theme::SUCCESS)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("  confirm    ", Style::default().fg(theme::MUTED)),
        Span::styled(
            "q",
            Style::default()
                .fg(theme::ERROR)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("  quit", Style::default().fg(theme::MUTED)),
    ]))
    .alignment(Alignment::Center);
    f.render_widget(hint, chunks[hint_idx]);
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
