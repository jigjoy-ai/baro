use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::app::{App, Planner, WelcomeField};
use crate::theme;

// Giant blocky letters - each is ~12 wide, 9 rows tall
const LETTER_B: [&str; 9] = [
    "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}  ",
    "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588} ",
    "\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}  ",
    "\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588} ",
    "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}  ",
];

const LETTER_A: [&str; 9] = [
    "   \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}   ",
    "  \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}  ",
    " \u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588} ",
    "\u{2588}\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
];

const LETTER_R: [&str; 9] = [
    "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}  ",
    "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588} ",
    "\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588} ",
    "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}   ",
    "\u{2588}\u{2588}\u{2588}  \u{2588}\u{2588}\u{2588}\u{2588}  ",
    "\u{2588}\u{2588}\u{2588}   \u{2588}\u{2588}\u{2588}\u{2588} ",
    "\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
];

const LETTER_O: [&str; 9] = [
    "  \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}  ",
    " \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588} ",
    "\u{2588}\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    "\u{2588}\u{2588}\u{2588}\u{2588}    \u{2588}\u{2588}\u{2588}\u{2588}",
    " \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588} ",
    "  \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}  ",
];

fn rainbow(idx: usize) -> Color {
    match idx % 7 {
        0 => Color::LightRed,
        1 => Color::LightYellow,
        2 => Color::LightGreen,
        3 => Color::LightCyan,
        4 => Color::LightBlue,
        5 => Color::LightMagenta,
        6 => Color::Yellow,
        _ => Color::White,
    }
}

fn radio(selected: bool, label: &str, focused: bool) -> Vec<Span<'static>> {
    let marker = if selected { "\u{25c9}" } else { "\u{25cb}" };
    let style = if selected && focused {
        Style::default().fg(theme::ACCENT_BRIGHT).add_modifier(Modifier::BOLD)
    } else if selected {
        Style::default().fg(theme::ACCENT)
    } else {
        Style::default().fg(theme::MUTED)
    };
    vec![
        Span::styled(format!("{} ", marker), style),
        Span::styled(label.to_string(), style),
    ]
}

pub fn render(f: &mut Frame, app: &App) {
    let area = f.area();
    let w = area.width;
    let focused = app.welcome_field;

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(1),
            Constraint::Length(9),  // Logo
            Constraint::Length(1),  // Spacer
            Constraint::Length(1),  // Tagline
            Constraint::Length(2),  // Spacer
            Constraint::Length(5),  // Goal input
            Constraint::Length(1),  // Spacer
            Constraint::Length(9),  // Settings box (model + parallel + timeout + context + planner)
            Constraint::Length(2),  // Spacer
            Constraint::Length(1),  // Help text
            Constraint::Length(1),  // Version
            Constraint::Min(1),
        ])
        .split(area);

    let center = |area: Rect, width: u16| -> Rect {
        let pad = area.width.saturating_sub(width) / 2;
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(pad),
                Constraint::Length(width.min(area.width)),
                Constraint::Min(0),
            ])
            .split(area)[1]
    };

    // ── Giant logo with animated rainbow ──
    let tick = app.tick_count as usize;
    let phase = tick / 3;

    let mut logo_lines: Vec<Line> = Vec::new();
    for row in 0..9 {
        let b_color = rainbow(phase + row);
        let a_color = rainbow(phase + 2 + row);
        let r_color = rainbow(phase + 4 + row);
        let o_color = rainbow(phase + 6 + row);

        logo_lines.push(Line::from(vec![
            Span::styled(LETTER_B[row], Style::default().fg(b_color).add_modifier(Modifier::BOLD)),
            Span::raw("   "),
            Span::styled(LETTER_A[row], Style::default().fg(a_color).add_modifier(Modifier::BOLD)),
            Span::raw("   "),
            Span::styled(LETTER_R[row], Style::default().fg(r_color).add_modifier(Modifier::BOLD)),
            Span::raw("   "),
            Span::styled(LETTER_O[row], Style::default().fg(o_color).add_modifier(Modifier::BOLD)),
        ]));
    }

    let logo = Paragraph::new(logo_lines).alignment(Alignment::Center);
    f.render_widget(logo, chunks[1]);

    // ── Tagline ──
    let tagline = Paragraph::new(Line::from(vec![
        Span::styled("autonomous ", Style::default().fg(theme::ACCENT_BRIGHT)),
        Span::styled("parallel ", Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD)),
        Span::styled("coding", Style::default().fg(theme::ACCENT_BRIGHT)),
    ]))
    .alignment(Alignment::Center);
    f.render_widget(tagline, chunks[3]);

    // ── Goal input ──
    let input_width = w.saturating_sub(10).min(100);
    let input_area = center(chunks[5], input_width);

    let cursor_visible = (app.tick_count / 5).is_multiple_of(2);
    let cursor_char = if cursor_visible && focused == WelcomeField::Goal { "\u{2588}" } else { " " };

    let display_text = if app.goal_input.is_empty() {
        Line::from(vec![
            Span::styled(" What do you want to build?  ", Style::default().fg(theme::MUTED)),
            Span::styled(cursor_char, Style::default().fg(theme::SUCCESS).add_modifier(Modifier::BOLD)),
        ])
    } else {
        Line::from(vec![
            Span::styled(format!(" {}", &app.goal_input), Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD)),
            Span::styled(cursor_char, Style::default().fg(theme::SUCCESS).add_modifier(Modifier::BOLD)),
        ])
    };

    // Wrap the typed goal and scroll so the last 3 inner rows (with the cursor) stay visible.
    // Inner text width = box width minus the 2 border columns; +1 accounts for the leading space.
    let inner_text_width = input_area.width.saturating_sub(2);
    let wrapped_rows = if inner_text_width == 0 {
        1
    } else {
        let chars = app.goal_input.chars().count() as u16 + 1;
        chars.div_ceil(inner_text_width).max(1)
    };
    let overflow_rows = wrapped_rows.saturating_sub(3);

    let goal_border = if focused == WelcomeField::Goal { theme::BORDER_ACTIVE } else { theme::BORDER };
    let input = Paragraph::new(display_text)
        .wrap(ratatui::widgets::Wrap { trim: false })
        .scroll((overflow_rows, 0))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(goal_border))
                .title(Span::styled(" Goal ", Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD))),
        );
    f.render_widget(input, input_area);

    // ── Settings box ──
    let settings_area = center(chunks[7], input_width);

    let model_focused = focused == WelcomeField::Model;
    let is_routed = app.model_routing && app.override_model.is_none();
    let is_opus = app.override_model.as_deref() == Some("opus");
    let is_sonnet = app.override_model.as_deref() == Some("sonnet");
    let is_haiku = app.override_model.as_deref() == Some("haiku");

    let mut model_spans = vec![
        Span::styled("  Model:    ", Style::default().fg(theme::MUTED)),
    ];
    model_spans.extend(radio(is_routed, "routed", model_focused));
    model_spans.push(Span::raw("  "));
    model_spans.extend(radio(is_opus, "opus", model_focused));
    model_spans.push(Span::raw("  "));
    model_spans.extend(radio(is_sonnet, "sonnet", model_focused));
    model_spans.push(Span::raw("  "));
    model_spans.extend(radio(is_haiku, "haiku", model_focused));

    let parallel_focused = focused == WelcomeField::Parallel;
    let parallel_val = if app.parallel_limit == 0 { "\u{221E}".to_string() } else { app.parallel_limit.to_string() };
    let par_style = if parallel_focused {
        Style::default().fg(theme::ACCENT_BRIGHT).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(theme::ACCENT)
    };

    let timeout_focused = focused == WelcomeField::Timeout;
    let timeout_style = if timeout_focused {
        Style::default().fg(theme::ACCENT_BRIGHT).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(theme::ACCENT)
    };

    let planner_focused = focused == WelcomeField::Planner;

    let mut planner_spans = vec![
        Span::styled("  Planner:  ", Style::default().fg(theme::MUTED)),
    ];
    planner_spans.extend(radio(app.planner == Planner::Claude, "claude", planner_focused));
    planner_spans.push(Span::raw("  "));
    planner_spans.extend(radio(app.planner == Planner::OpenAI, "openai", planner_focused));
    planner_spans.push(Span::raw("  "));
    planner_spans.extend(radio(app.planner == Planner::Codex, "codex", planner_focused));
    planner_spans.push(Span::raw("  "));
    planner_spans.extend(radio(app.planner == Planner::OpenCode, "opencode", planner_focused));
    planner_spans.push(Span::raw("  "));
    planner_spans.extend(radio(app.planner == Planner::Pi, "pi", planner_focused));

    let settings_lines = vec![
        Line::from(model_spans),
        Line::from(vec![
            Span::styled("  Parallel: ", Style::default().fg(theme::MUTED)),
            Span::styled(format!("[{}]", parallel_val), par_style),
            Span::styled("          Timeout: ", Style::default().fg(theme::MUTED)),
            Span::styled(
                if app.timeout_secs == 0 {
                    "[auto]".to_string()
                } else {
                    format!("[{}s]", app.timeout_secs)
                },
                timeout_style,
            ),
        ]),
        Line::from(planner_spans),
    ];

    let settings_border = if focused != WelcomeField::Goal { theme::BORDER_ACTIVE } else { theme::BORDER };
    let settings = Paragraph::new(settings_lines).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(settings_border))
            .title(Span::styled(
                " Settings ",
                Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
            )),
    );
    f.render_widget(settings, settings_area);

    // ── Keybinds ──
    let help = Paragraph::new(Line::from(vec![
        Span::styled("Enter", Style::default().fg(theme::SUCCESS).add_modifier(Modifier::BOLD)),
        Span::styled(" start   ", Style::default().fg(theme::TEXT_DIM)),
        Span::styled("Tab", Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)),
        Span::styled(" next   ", Style::default().fg(theme::TEXT_DIM)),
        Span::styled("\u{2190}\u{2192}", Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)),
        Span::styled(" change   ", Style::default().fg(theme::TEXT_DIM)),
        Span::styled("Esc", Style::default().fg(theme::ERROR).add_modifier(Modifier::BOLD)),
        Span::styled(" quit", Style::default().fg(theme::TEXT_DIM)),
    ]))
    .alignment(Alignment::Center);
    f.render_widget(help, chunks[9]);

    // ── Version ──
    let version_str = format!("v{}", env!("CARGO_PKG_VERSION"));
    let version = Paragraph::new(Line::from(Span::styled(version_str, Style::default().fg(theme::MUTED))))
        .alignment(Alignment::Center);
    f.render_widget(version, chunks[10]);
}
