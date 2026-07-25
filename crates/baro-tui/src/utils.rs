pub(crate) type BaroResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Format a number with comma separators (e.g. 1234567 -> "1,234,567").
pub fn format_commas(n: u64) -> String {
    let s = n.to_string();
    let mut result = String::new();
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            result.push(',');
        }
        result.push(c);
    }
    result.chars().rev().collect()
}
