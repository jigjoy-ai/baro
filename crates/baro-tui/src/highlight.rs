//! Lazy syntect highlighting for fenced code in the session transcript.
//! The syntax set costs ~100ms+ to load, so `warm()` builds it on a
//! background thread at startup; until it is ready (or for unknown
//! languages) callers fall back to their single-color rendering.

use std::sync::OnceLock;

use ratatui::{
    style::{Color, Style},
    text::{Line, Span},
};
use syntect::{
    easy::HighlightLines,
    highlighting::{Theme, ThemeSet},
    parsing::SyntaxSet,
};

static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();
static THEME: OnceLock<Theme> = OnceLock::new();

fn theme() -> &'static Theme {
    THEME.get_or_init(|| {
        let mut themes = ThemeSet::load_defaults();
        // Muted pastels that sit well on the near-black background.
        themes
            .themes
            .remove("base16-eighties.dark")
            .expect("bundled syntect theme exists")
    })
}

/// Build the syntax set off the render thread. Safe to call more than once.
pub fn warm() {
    std::thread::spawn(|| {
        let _ = SYNTAXES.get_or_init(SyntaxSet::load_defaults_newlines);
    });
}

/// Highlight one fenced block. `None` when the set is still loading or the
/// language is unknown — the caller keeps its plain rendering.
pub fn highlight_block(
    lang: &str,
    code: &str,
    indent: &str,
) -> Option<Vec<Line<'static>>> {
    if lang.is_empty() {
        return None;
    }
    let syntaxes = SYNTAXES.get()?;
    let syntax = syntaxes
        .find_syntax_by_token(lang)
        .or_else(|| syntaxes.find_syntax_by_extension(lang))?;
    let mut highlighter = HighlightLines::new(syntax, theme());
    let mut lines = Vec::new();
    for raw in code.lines() {
        let mut spans: Vec<Span> =
            vec![Span::raw(format!("{indent}  "))];
        match highlighter.highlight_line(raw, syntaxes) {
            Ok(regions) => {
                for (style, text) in regions {
                    let fg = style.foreground;
                    spans.push(Span::styled(
                        text.to_string(),
                        Style::default().fg(Color::Rgb(fg.r, fg.g, fg.b)),
                    ));
                }
            }
            Err(_) => spans.push(Span::raw(raw.to_string())),
        }
        lines.push(Line::from(spans));
    }
    Some(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highlights_rust_once_the_set_is_loaded() {
        let _ = SYNTAXES.get_or_init(SyntaxSet::load_defaults_newlines);
        let lines = highlight_block("rust", "fn main() {}\n", "  ")
            .expect("rust grammar is bundled");
        assert_eq!(lines.len(), 1);
        assert!(lines[0].spans.len() > 2, "expected multiple colored tokens");
    }

    #[test]
    fn unknown_language_falls_back() {
        let _ = SYNTAXES.get_or_init(SyntaxSet::load_defaults_newlines);
        assert!(highlight_block("notalang", "x", "").is_none());
        assert!(highlight_block("", "x", "").is_none());
    }
}
