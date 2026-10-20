import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError


class MissingMovies(unittest.TestCase):
    def setUp(self):
        with patch.dict(os.environ, TRAKT_CLIENT_ID='test', TMDB_API_TOKEN='test'):
            spec = importlib.util.spec_from_file_location('rankings', Path(__file__).resolve().parents[1] / 'scripts/build_rankings.py')
            self.m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.m)

    def test_missing_movie_skipped_in_every_row_without_reordering_or_losing_history(self):
        missing = 1795166
        def details(url, headers):
            movie_id = int(url.split('/movie/')[1].split('?')[0])
            if movie_id == missing:
                raise HTTPError(url, 404, 'Not Found', {}, None)
            return {'id': movie_id, 'title': 'Film', 'poster_path': '/p.jpg', 'release_date': '2026-01-01'}
        with tempfile.TemporaryDirectory() as directory:
            self.m.DATA = Path(directory)
            self.m.HISTORY = self.m.DATA / 'history.json'
            self.m.FEED = self.m.DATA / 'rankings.json'
            candidates = [(3, 30), (missing, 20), (1, 10)]
            with patch.object(self.m, 'trakt', return_value=candidates), patch.object(self.m, 'get_json', side_effect=details), patch.object(self.m, 'roll_history', return_value=candidates):
                self.m.main()
            feed = json.loads(self.m.FEED.read_text())
            history = json.loads(self.m.HISTORY.read_text())
            for row in feed['rows'].values():
                self.assertEqual([c['id'] for c in row], [3, 1])
                self.assertEqual([c['trakt_watchers'] for c in row], [30, 10])
            self.assertEqual(feed['tmdb_missing_ids'], [missing])
            self.assertEqual(history[self.m.TODAY.isoformat()][str(missing)], 20)

    def test_other_failures_do_not_overwrite_existing_files(self):
        failures = [HTTPError('https://example.test', code, 'error', {}, None) for code in (401,403,429,500)]
        failures += [URLError('offline'), ValueError('invalid JSON')]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__, code=getattr(failure, 'code', None)), tempfile.TemporaryDirectory() as directory:
                self.m.DATA = Path(directory)
                self.m.HISTORY = self.m.DATA / 'history.json'
                self.m.FEED = self.m.DATA / 'rankings.json'
                self.m.HISTORY.write_text('{}')
                self.m.FEED.write_text('{"previous":true}')
                with patch.object(self.m, 'trakt', return_value=[(1, 10)]), patch.object(self.m, 'get_json', side_effect=failure):
                    with self.assertRaises(type(failure)):
                        self.m.main()
                self.assertEqual(self.m.HISTORY.read_text(), '{}')
                self.assertEqual(self.m.FEED.read_text(), '{"previous":true}')
