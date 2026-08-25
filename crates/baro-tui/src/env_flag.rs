//! Shared opt-out boolean environment-flag parsing for baro-tui.

pub(crate) fn env_flag_enabled(name: &str) -> bool {
    env_flag_value(std::env::var(name).ok().as_deref())
}

/// Opt-out env flag: unset/missing (None) or any value other than the literal "0" → enabled (true); only Some("0") → disabled (false).
pub(crate) fn env_flag_value(value: Option<&str>) -> bool {
    value != Some("0")
}

#[cfg(test)]
mod tests {
    use super::env_flag_value;

    #[test]
    fn unset_or_missing_env_defaults_to_enabled() {
        assert!(env_flag_value(None));
    }

    #[test]
    fn literal_zero_is_the_only_opt_out() {
        assert!(!env_flag_value(Some("0")));
    }

    #[test]
    fn any_other_value_stays_enabled() {
        assert!(env_flag_value(Some("1")));
        assert!(env_flag_value(Some("false")));
        assert!(env_flag_value(Some("")));
    }

    #[test]
    fn baro_planner_bus_default_on_and_zero_off_take_different_paths() {
        // main.rs branches on exactly this bool: unset/default → true
        // (enabled, early return on the planner-bus path) vs "0" → false
        // (disabled, falls through to the legacy subprocess-planner path).
        assert!(env_flag_value(None));
        assert!(!env_flag_value(Some("0")));
    }
}
