"""Build the static Lampa feed from official Trakt and TMDB APIs.

Requires TRAKT_CLIENT_ID and TMDB_API_TOKEN in the GitHub Actions environment.
The daily Trakt archive supports a real rolling 180-day activity ranking after
180/365 consecutive daily snapshots; until then the client uses its honest fallback.
"""
import datetime as dt
import json
import os
from pathlib import Path
import urllib.request
import urllib.error
import time
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
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=25) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(2 ** (attempt + 1))


def trakt(period, limit=200):
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
        "genre_ids": [g["id"] for g in movie.get("genres", [])],
        "adult": movie.get("adult", False),
        "original_language": movie.get("original_language"),
        "popularity": movie.get("popularity"),
    }


def valid(movie):
    date = movie.get("release_date") or ""
    if not movie.get("poster_path") or not movie.get("title") or movie.get("adult"):
        return False
    try:
        released = dt.date.fromisoformat(date)
    except ValueError:
        return False
    if released > TODAY or released.isoformat() != date:
        return False
    # Genre preferences belong to each viewer and are applied by the plugin.
    return True


def roll_history(history, window):
    days = [(TODAY - dt.timedelta(days=offset)).isoformat() for offset in range(window - 1, -1, -1)]
    if not all(history.get(day) for day in days):
        return []
    counts = {}
    for day in days:
        for tmdb_id, count in history[day].items():
            counts[int(tmdb_id)] = counts.get(int(tmdb_id), 0) + count
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:200]


def main():
    DATA.mkdir(exist_ok=True)
    try:
        history = json.loads(HISTORY.read_text("utf-8"))
    except FileNotFoundError:
        history = {}

    raw = {period: trakt(period) for period in ("weekly", "monthly", "yearly")}
    daily = trakt("daily", 250)
    if not daily:
        raise ValueError("Empty daily snapshot; refusing to publish incomplete history")
    history[TODAY.isoformat()] = {str(tmdb_id): count for tmdb_id, count in daily}
    history = {key: value for key, value in history.items()
               if (TODAY - dt.timedelta(days=364)).isoformat() <= key <= TODAY.isoformat()}
    raw["halfyear"] = roll_history(history, 180)
    yearly = roll_history(history, 365)
    duplicate_year = bool(raw["weekly"]) and {i for i, _ in raw["yearly"]} == {i for i, _ in raw["weekly"]}
    sources = {"weekly": "trakt_weekly", "monthly": "trakt_monthly",
               "halfyear": "daily_history_180" if raw["halfyear"] else "tmdb_fallback",
               "yearly": "daily_history_365" if yearly else "trakt_yearly"}
    if yearly:
        raw["yearly"] = yearly
    elif duplicate_year or not raw["yearly"]:
        raw["yearly"] = []
        sources["yearly"] = "tmdb_fallback"

    ids = {tmdb_id for movies in raw.values() for tmdb_id, _ in movies}
    # A failed TMDB response must not publish a partial ranking.
    with ThreadPoolExecutor(max_workers=4) as pool:
        details = dict(zip(ids, pool.map(movie_details, ids)))

    rows = {}
    for period, movies in raw.items():
        row = []
        for tmdb_id, watchers in movies:
            item = details[tmdb_id]
            if not valid(item):
                continue
            if period == "weekly" and not item["release_date"].startswith(str(TODAY.year) + "-"):
                continue
            card = dict(item)
            card["trakt_watchers"] = watchers
            row.append(card)
        rows[period] = row

    now = dt.datetime.now(dt.timezone.utc)
    result = {"version": 1, "genre_policy": "all", "generated_at": now.isoformat(),
              "generated_at_epoch": int(now.timestamp()),
              "sources": ["Trakt popularity", "TMDB metadata", "CUB reactions in Lampa"],
              "row_sources": sources, "weekly_release_year": TODAY.year,
              "yearly_duplicates_weekly": duplicate_year, "rows": rows}
    HISTORY.write_text(json.dumps(history, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    FEED.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    print("Built rows:", {name: len(items) for name, items in rows.items()})


if __name__ == "__main__":
    main()
