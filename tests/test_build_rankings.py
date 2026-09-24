"""The shared feed must retain genres for each viewer's local filtering."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class FeedGenres(unittest.TestCase):
    def test_shared_feed_retains_all_genres(self):
        source = Path(__file__).resolve().parents[1] / "scripts" / "build_rankings.py"
        with patch.dict(os.environ, {"TRAKT_CLIENT_ID": "test", "TMDB_API_TOKEN": "test"}):
            spec = importlib.util.spec_from_file_location("rankings", source)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        genres = [16, 27, 99, 10770, 35]
        movies = {i + 1: {"id": i + 1, "title": "Film", "poster_path": "/p.jpg",
                          "release_date": "2020-01-01", "genre_ids": [genre], "adult": False}
                  for i, genre in enumerate(genres)}
        movies[6] = dict(movies[1], id=6, adult=True)
        movies[7] = dict(movies[1], id=7, release_date="2999-01-01")
        movies[8] = dict(movies[1], id=8, poster_path=None)
        with tempfile.TemporaryDirectory() as folder:
            module.DATA = Path(folder)
            module.HISTORY = module.DATA / "history.json"
            module.FEED = module.DATA / "rankings.json"
            with patch.object(module, "trakt", return_value=[(i, 100) for i in movies]), \
                    patch.object(module, "movie_details", side_effect=movies.__getitem__):
                module.main()
            feed = json.loads(module.FEED.read_text())
        self.assertEqual(feed["genre_policy"], "all")
        for period in ("weekly", "monthly", "yearly"):
            self.assertEqual([item["id"] for item in feed["rows"][period]], [1, 2, 3, 4, 5])


if __name__ == "__main__":
    unittest.main()
