use ratatui::style::Color;

// Brand palette (amber on near-black) matching baro.rs / the dashboard.
// Terminals without truecolor degrade to the nearest ANSI tone; hex refs
// mirror the web tokens (--primary #ffb547, --muted-foreground #8b8b8f,
// --destructive #ff7a7a).

pub const ACCENT: Color = Color::Rgb(255, 181, 71); // #ffb547
pub const ACCENT_BRIGHT: Color = Color::Rgb(255, 201, 112); // #ffc970
pub const ACCENT_DIM: Color = Color::Rgb(176, 124, 54); // #b07c36

pub const SUCCESS: Color = Color::Rgb(127, 217, 127); // #7fd97f — additions / done
pub const WARNING: Color = Color::Rgb(245, 201, 92); // #f5c95c
pub const WARNING_DIM: Color = Color::Rgb(122, 110, 70);
pub const ERROR: Color = Color::Rgb(255, 122, 122); // #ff7a7a
pub const ERROR_DIM: Color = Color::Rgb(120, 70, 70);

// Replan marker — muted magenta, deliberately outside the amber family so
// DAG surgery reads as "the plan changed", not success/failure.
pub const REPLAN: Color = Color::Rgb(201, 138, 214); // #c98ad6

pub const TEXT: Color = Color::Rgb(230, 230, 235); // #e6e6eb foreground
pub const TEXT_DIM: Color = Color::Rgb(139, 139, 143); // #8b8b8f muted-foreground
pub const MUTED: Color = Color::Rgb(90, 90, 96); // #5a5a60

pub const BG: Color = Color::Rgb(10, 10, 11); // #0a0a0b background
pub const BORDER: Color = Color::Rgb(58, 58, 64); // #3a3a40 subtle
pub const BORDER_ACTIVE: Color = Color::Rgb(255, 181, 71); // amber — active = brand

// Logo — warm amber gradient (fan → converge)
pub const LOGO_1: Color = Color::Rgb(255, 209, 128); // #ffd180
pub const LOGO_2: Color = Color::Rgb(255, 181, 71); // #ffb547
pub const LOGO_3: Color = Color::Rgb(214, 140, 40); // #d68c28

pub const GAUGE_FG: Color = Color::Rgb(255, 181, 71); // amber
