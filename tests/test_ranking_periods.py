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

    def build(self, yearly, history_days=1, daily=None, failures=None):
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
            def fetch(period, *args):
                if failures and period in failures:
                    raise failures[period]
                return raw[period]
            with patch.object(self.m, 'trakt', side_effect=fetch), patch.object(self.m, 'movie_details', side_effect=details):
                self.m.main()
            return json.loads(self.m.FEED.read_text()), json.loads(self.m.HISTORY.read_text())

    def test_same_movies_are_valid_in_different_periods_and_years(self):
        feed, _ = self.build([(4, 900), (3, 800), (2, 700), (1, 600)])
        self.assertEqual([c['id'] for c in feed['rows']['weekly']], [1, 2, 3])
        self.assertEqual([c['id'] for c in feed['rows']['yearly']], [3, 2, 1])
        self.assertEqual(feed['rows']['halfyear'], [])
        self.assertEqual(feed['row_sources']['yearly'], 'trakt_yearly')

    def test_distinct_yearly_and_complete_history(self):
        feed, _ = self.build([(2, 80)])
        self.assertEqual(feed['row_sources']['yearly'], 'trakt_yearly')
        feed, history = self.build([(1, 90)], 366)
        self.assertEqual(len(history), 365)
        self.assertEqual(feed['row_sources']['yearly'], 'trakt_yearly')
        self.assertEqual(feed['row_sources']['halfyear'], 'daily_history_180')
        self.assertEqual(feed['rows']['yearly'][0]['trakt_watchers'], 90)

    def test_temporary_http_errors_retry_but_auth_errors_do_not(self):
        from urllib.error import HTTPError
        from io import BytesIO
        transient = HTTPError('https://example.test', 500, 'temporary', {}, None)
        with patch.object(self.m.urllib.request, 'urlopen', side_effect=[transient, BytesIO(b'[]')]) as request, patch.object(self.m.time, 'sleep'):
            self.assertEqual(self.m.get_json('https://example.test', {}), [])
            self.assertEqual(request.call_count, 2)
        for code in (401, 500):
            with patch.object(self.m.urllib.request, 'urlopen', side_effect=HTTPError('https://example.test', code, 'error', {}, None)) as request, patch.object(self.m.time, 'sleep'):
                with self.assertRaises(HTTPError):
                    self.m.get_json('https://example.test', {})
                self.assertEqual(request.call_count, 1 if code == 401 else 3)

    def test_empty_daily_preserves_existing_snapshot(self):
        _, history = self.build([], daily=[])
        self.assertEqual(history, self.history(1))
        feed, history = self.build([], history_days=0, daily=[])
        self.assertEqual(history, {})
        self.assertEqual(feed['trakt_errors']['daily'], 'empty_response')

    def test_outages_isolated_and_failed_day_not_fabricated(self):
        from urllib.error import HTTPError
        failure = HTTPError('https://api.trakt.tv', 500, 'error', {}, None)
        feed, history = self.build([(2, 80)], history_days=0,
                                   failures={'daily': failure, 'yearly': failure})
        self.assertEqual([c['id'] for c in feed['rows']['weekly']], [1, 2, 3])
        self.assertEqual(history, {})
        self.assertEqual(feed['row_sources']['yearly'], 'tmdb_fallback')
        self.assertEqual(feed['trakt_errors'], {'daily': 'http_500', 'yearly': 'http_500'})
        feed, _ = self.build([], failures={p: failure for p in ('daily','weekly','monthly','yearly')})
        self.assertTrue(all(not row for row in feed['rows'].values()))
        self.assertEqual(set(feed['row_sources'].values()), {'tmdb_fallback'})
        with self.assertRaises(HTTPError):
            self.build([], failures={'daily': HTTPError('https://api.trakt.tv',401,'error',{},None)})

    def test_complete_history_does_not_replace_agreed_yearly_source(self):
        feed, _ = self.build([(2, 80)], history_days=365)
        self.assertEqual(feed['row_sources']['yearly'], 'trakt_yearly')
        self.assertEqual([c['id'] for c in feed['rows']['yearly']], [2])

    def test_pagination_preserves_order_deduplicates_and_stops(self):
        def item(i):
            return {'movie': {'ids': {'tmdb': i}}, 'watcher_count': 100 - i}
        with patch.object(self.m, 'get_json', side_effect=[[item(1), item(2)], [item(2), item(3)], []]) as request:
            self.assertEqual(self.m.trakt('yearly', 2), [(1, 99), (2, 98), (3, 97)])
            self.assertIn('page=3', request.call_args[0][0])
        with patch.object(self.m, 'get_json', return_value=[item(1), item(2)]) as request:
            self.assertEqual(len(self.m.trakt('yearly', 2)), 2)
            self.assertEqual(request.call_count, 2)

if __name__ == '__main__':
    unittest.main()
