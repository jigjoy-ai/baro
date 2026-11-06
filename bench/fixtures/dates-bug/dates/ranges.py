from datetime import date


def days_between(start: date, end: date) -> int:
    """Whole days from start to end, inclusive of both ends."""
    return (end - start).days


def overlaps(a: tuple[date, date], b: tuple[date, date]) -> bool:
    """Whether two inclusive date ranges share at least one day."""
    return a[0] < b[1] and b[0] < a[1]
