from datetime import date

from dates import days_between, overlaps


def test_days_between_counts_both_ends():
    assert days_between(date(2026, 1, 1), date(2026, 1, 1)) == 1
    assert days_between(date(2026, 1, 1), date(2026, 1, 31)) == 31


def test_overlaps_on_shared_edge_day():
    assert overlaps((date(2026, 1, 1), date(2026, 1, 10)), (date(2026, 1, 10), date(2026, 1, 20)))


def test_disjoint_ranges_do_not_overlap():
    assert not overlaps((date(2026, 1, 1), date(2026, 1, 9)), (date(2026, 1, 10), date(2026, 1, 20)))
