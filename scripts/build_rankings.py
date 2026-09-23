"""Build the static Lampa feed from official Trakt and TMDB APIs.

Requires TRAKT_CLIENT_ID and TMDB_API_TOKEN in the GitHub Actions environment.
The daily Trakt archive supports a real rolling 180-day activity ranking after
180 consecutive daily snapshots; until then the client uses its honest fallback.
"""
import datetime as dt
import json
import math
import os
from pathlib import Path
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
HISTORY = DATA / "watch-history.json"
FEED = DATA / "rankings.json"
TODAY = dt.datetime.now(dt.timezone.utc).date()
TRAKT_KEY = os.environ["TRAKT_CLIENT_ID"]
TMDB_TOKEN = os.environ["TMDB_API_TOKEN"]


def get_json(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)


def trakt(period, limit=100):
    url = "https://api.trakt.tv/movies/watched/{}?page=1&limit={}".format(period, limit)
    payload = get_json(url, {
        "trakt-api-key": TRAKT_KEY,
        "trakt-api-version": "2",
        "Content-Type": "application/json",
        "User-Agent": "VlasLampaHome/3.0",
    })
    movies = []
    for item in payload:
        movie = item.get("movie") or {}
        tmdb_id = (movie.get("ids") or {}).get("tmdb")
        watchers = item.get("watcher_count")
        if isinstance(tmdb_id, int) and isinstance(watchers, int) and watchers > 0:
            movies.append((tmdb_id, watchers))
    return movies


def movie_details(tmdb_id):
    url = "https://api.themoviedb.org/3/movie/{}?language=ru-RU".format(tmdb_id)
    movie = get_json(url, {
        "Authorization": "Bearer " + TMDB_TOKEN,
        "accept": "application/json",
        "User-Agent": "VlasLampaHome/3.0",
    })
    return {
        "id": movie["id"], "title": movie.get("title"),
        "original_title": movie.get("original_title"),
        "overview": movie.get("overview"),
        "release_date": movie.get("release_date"),
        "poster_path": movie.get("poster_path"),
        "backdrop_path": movie.get("backdrop_path"),
        "vote_average": movie.get("vote_average"),
        "vote_count": movie.get("vote_count"),
        "genre_ids": [g["id"] for g in movie.get("genres", [])],
        "adult": movie.get("adult", False),
        "original_language": movie.get("original_language"),
        "popularity": movie.get("popularity"),
    }


def valid(movie):
    date = movie.get("release_date") or ""
    if not movie.get("poster_path") or not movie.get("title") or movie.get("adult"):
        return False
    if len(date) != 10 or date > TODAY.isoformat():
        return False
    if any(x in movie["genre_ids"] for x in (16, 99, 10770)):
        return False
    return movie.get("vote_average", 0) >= 5.5 and movie.get("vote_count", 0) >= 30


def roll_halfyear(history):
    days = [(TODAY - dt.timedelta(days=offset)).isoformat() for offset in range(179, -1, -1)]
    if not all(day in history for day in days):
        return []
    counts = {}
    for day in days:
        for tmdb_id, count in history[day].items():
            counts[int(tmdb_id)] = counts.get(int(tmdb_id), 0) + count
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:100]


def main():
    DATA.mkdir(exist_ok=True)
    try:
        history = json.loads(HISTORY.read_text("utf-8"))
    except FileNotFoundError:
        history = {}

    raw = {period: trakt(period) for period in ("weekly", "monthly", "yearly")}
    daily = trakt("daily", 250)
    history[TODAY.isoformat()] = {str(tmdb_id): count for tmdb_id, count in daily}
    history = {key: value for key, value in history.items()
               if (TODAY - dt.timedelta(days=179)).isoformat() <= key <= TODAY.isoformat()}
    raw["halfyear"] = roll_halfyear(history)

    ids = {tmdb_id for movies in raw.values() for tmdb_id, _ in movies}
    # A failed TMDB response must not publish a partial ranking.
    with ThreadPoolExecutor(max_workers=4) as pool:
        details = dict(zip(ids, pool.map(movie_details, ids)))

    rows = {}
    for period, movies in raw.items():
        max_watchers = max((count for _, count in movies), default=1)
        row = []
        for rank, (tmdb_id, watchers) in enumerate(movies):
            item = details[tmdb_id]
            if not valid(item):
                continue
            votes, rating = item["vote_count"], item["vote_average"]
            quality = (votes * rating + 650 * 6.5) / (votes + 650)
            popularity = 0.7 * (1 - rank / max(len(movies), 1)) + \
                0.3 * math.log1p(watchers) / math.log1p(max_watchers)
            score = 8 * popularity + 0.2 * quality
            card = dict(item)
            card["vlas_score"] = round(score, 2)
            row.append(card)
        rows[period] = sorted(row, key=lambda card: -card["vlas_score"])

    now = dt.datetime.now(dt.timezone.utc)
    result = {"version": 1, "generated_at": now.isoformat(),
              "generated_at_epoch": int(now.timestamp()),
              "sources": ["Trakt", "TMDB"], "rows": rows}
    HISTORY.write_text(json.dumps(history, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    FEED.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    print("Built rows:", {name: len(items) for name, items in rows.items()})


if __name__ == "__main__":
    main()
