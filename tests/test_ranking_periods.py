import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

class Periods(unittest.TestCase):
    def setUp(self):
        with patch.dict(os.environ, TRAKT_CLIENT_ID='test', TMDB_API_TOKEN='test'):
            spec = importlib.util.spec_from_file_location('rankings', Path(__file__).resolve().parents[1] / 'scripts/build_rankings.py')
            self.m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.m)
        self.m.TODAY = dt.date(2026, 9, 27)

    def history(self, days):
        return {(self.m.TODAY-dt.timedelta(days=i)).isoformat(): {'1': 2, '2': 3} for i in range(days)}

    def test_rolling_boundaries_gaps_and_totals(self):
        for window in (180, 365):
            self.assertEqual(self.m.roll_history(self.history(window-1), window), [])
            history = self.history(window+1)
            self.assertEqual(self.m.roll_history(history, window), [(2, window*3), (1, window*2)])
            del history[(self.m.TODAY-dt.timedelta(days=17)).isoformat()]
            self.assertEqual(self.m.roll_history(history, window), [])
            history[(self.m.TODAY-dt.timedelta(days=17)).isoformat()] = {}
            self.assertEqual(self.m.roll_history(history, window), [])

    def build(self, yearly, history_days=1, daily=None):
        with tempfile.TemporaryDirectory() as directory:
            self.m.DATA = Path(directory)
            self.m.HISTORY = self.m.DATA/'history.json'
            self.m.FEED = self.m.DATA/'rankings.json'
            self.m.HISTORY.write_text(json.dumps(self.history(history_days)))
            raw = {'weekly': [(1, 90), (2, 80), (3, 70), (4, 60)], 'monthly': [(2, 80)], 'yearly': yearly,
                   'daily': [(1, 2), (2, 3)] if daily is None else daily}
            dates = {1: '2026-01-01', 2: '2025-12-31', 3: '2026-09-27', 4: '2026-09-28'}
            def details(i):
                return {'id': i, 'title': 'Film', 'poster_path': '/p', 'release_date': dates[i]}
            with patch.object(self.m, 'trakt', side_effect=lambda period, *args: raw[period]), patch.object(self.m, 'movie_details', side_effect=details):
                self.m.main()
            return json.loads(self.m.FEED.read_text()), json.loads(self.m.HISTORY.read_text())

    def test_duplicate_membership_before_weekly_filter(self):
        feed, _ = self.build([(4, 900), (3, 800), (2, 700), (1, 600)])
        self.assertEqual([c['id'] for c in feed['rows']['weekly']], [1, 3])
        self.assertEqual(feed['rows']['yearly'], [])
        self.assertEqual(feed['rows']['halfyear'], [])
        self.assertEqual(feed['row_sources']['yearly'], 'tmdb_fallback')

    def test_distinct_yearly_and_complete_history(self):
        feed, _ = self.build([(2, 80)])
        self.assertEqual(feed['row_sources']['yearly'], 'trakt_yearly')
        feed, history = self.build([(1, 90)], 366)
        self.assertEqual(len(history), 365)
        self.assertEqual(feed['row_sources']['yearly'], 'daily_history_365')
        self.assertEqual(feed['row_sources']['halfyear'], 'daily_history_180')
        self.assertEqual(feed['rows']['yearly'][0]['trakt_watchers'], 1095)

    def test_empty_daily_fails(self):
        with self.assertRaises(ValueError):
            self.build([], daily=[])

if __name__ == '__main__':
    unittest.main()
