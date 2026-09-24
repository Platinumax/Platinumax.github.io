/* Vlas Home 5.3 — personal genre selection and weekly themed rotation.
 * ES5 syntax for older webOS browsers. Trakt data is prepared on GitHub Pages.
 * TMDB supplies movie metadata only; visible scores come from Lampa reactions.
 */
(function () {
    'use strict';

    if (window.my_lampa_home_loaded) return;

    var KEY = 'my_lampa_home_';
    var COMMON = '&with_runtime.gte=75&include_adult=false';
    var GENRES = [
        { id: 28, name: 'Боевик' }, { id: 12, name: 'Приключения' },
        { id: 16, name: 'Мультфильм', hidden: true }, { id: 35, name: 'Комедия' },
        { id: 80, name: 'Криминал' }, { id: 99, name: 'Документальный', hidden: true },
        { id: 18, name: 'Драма' }, { id: 10751, name: 'Семейный' },
        { id: 14, name: 'Фэнтези' }, { id: 36, name: 'История' },
        { id: 27, name: 'Ужасы', hidden: true }, { id: 10402, name: 'Музыка' },
        { id: 9648, name: 'Детектив' }, { id: 10749, name: 'Мелодрама' },
        { id: 878, name: 'Фантастика' }, { id: 10770, name: 'Телефильм', hidden: true },
        { id: 53, name: 'Триллер' }, { id: 10752, name: 'Военный' },
        { id: 37, name: 'Вестерн' }
    ];
    var FEED = 'https://platinumax.github.io/data/rankings.json';
    var FILMIX_SCRIPT = 'https://lampaplugins.github.io/store/fx.js';
    var filmixLoading = false;
    var filmixWaiters = [];
    var feedState = 0;
    var feedData = null;
    var feedWaiters = [];
    var reactionCache = {};
    var reactionQueue = [];
    var reactionActive = 0;
    var savedReactions = {};
    var savedLoaded = false;
    var saveTimer = null;
    var REACTION_TTL = 6 * 60 * 60 * 1000;
    var TARGET = 24;
    var ROW_CANDIDATES = 240;
    var ROW_PAGES = 12;
    var FULL_PAGE = 24;
    var FULL_PAGES = 6;
    var ROTATION_WINDOWS = 6;
    var rowSessions = {};

    function loadSaved() {
        if (savedLoaded) return;
        savedLoaded = true;
        try { savedReactions = Lampa.Storage.get(KEY + 'reaction_cache', {}) || {}; }
        catch (ignore) { savedReactions = {}; }
    }

    function rememberReaction(id, value) {
        var keys, i, now = new Date().getTime();
        savedReactions[id] = { at: now, value: value,
            ttl: value ? REACTION_TTL : 20 * 60 * 1000 };
        if (saveTimer) return;
        saveTimer = setTimeout(function () {
            saveTimer = null;
            keys = Object.keys(savedReactions);
            if (keys.length > 350) {
                keys.sort(function (a, b) { return savedReactions[b].at - savedReactions[a].at; });
                for (i = 350; i < keys.length; i++) delete savedReactions[keys[i]];
            }
            try { Lampa.Storage.set(KEY + 'reaction_cache', savedReactions); }
            catch (ignore) { /* Memory cache still works. */ }
        }, 1500);
    }

    function reactionFor(id, callback) {
        loadSaved();
        var key = String(id), cached = reactionCache[key];
        var saved = savedReactions[key];
        if (saved && saved.at && new Date().getTime() - saved.at <
            (saved.ttl || REACTION_TTL)) {
            callback(saved.value);
            return;
        }
        if (cached && cached.done) {
            delete reactionCache[key];
            cached = null;
        }
        if (cached) {
            if (cached.done) callback(cached.value);
            else cached.waiters.push(callback);
            return;
        }
        reactionCache[key] = { done: false, waiters: [callback], value: null };
        reactionQueue.push(key);
        drainReactions();
    }

    function drainReactions() {
        var key, entry;
        while (reactionActive < 5 && reactionQueue.length) {
            key = reactionQueue.shift();
            entry = reactionCache[key];
            reactionActive++;
            // Keep each request's callbacks and timeout independent of the queue loop.
            (function (movieId, item) {
                var done = false, source;
                var timeout = setTimeout(function () { complete(null, false); }, 5500);
                function complete(value, cacheable) {
                    var waiters, i;
                    if (done) return;
                    done = true;
                    clearTimeout(timeout);
                    item.value = value;
                    item.done = true;
                    if (cacheable !== false) rememberReaction(movieId, value);
                    waiters = item.waiters;
                    item.waiters = [];
                    reactionActive--;
                    for (i = 0; i < waiters.length; i++) waiters[i](value);
                    drainReactions();
                }
                try {
                    source = Lampa.Api.sources.cub;
                    if (!source || typeof source.reactionsGet !== 'function') {
                        complete(null, false);
                    } else {
                        source.reactionsGet({ method: 'movie', id: movieId }, function (data) {
                            complete(readReactions(data));
                        });
                    }
                } catch (ignore) { complete(null, false); }
            })(key, entry);
        }
    }

    function readReactions(data) {
        var counts = { fire: 0, nice: 0, think: 0, bore: 0, shit: 0 };
        var rows = data && data.result;
        var i, type, count, total, positive, negative, score;
        if (!rows || !rows.length) return null;
        for (i = 0; i < rows.length; i++) {
            type = rows[i] && rows[i].type;
            count = Number(rows[i] && rows[i].counter);
            if (Object.prototype.hasOwnProperty.call(counts, type) &&
                isFinite(count) && count >= 0) counts[type] += count;
        }
        total = counts.fire + counts.nice + counts.think + counts.bore + counts.shit;
        if (total < 15) return null;
        positive = counts.fire + counts.nice;
        negative = counts.bore + counts.shit;
        // A strong negative signal vetoes a movie regardless of its popularity.
        if (total >= 30 && (negative / total >= 0.38 ||
            (counts.shit >= 20 && counts.shit / total >= 0.2))) return null;
        score = (10 * counts.fire + 8 * counts.nice + 5 * counts.think +
            2 * counts.bore + 20 * 5) / (total + 20);
        if (score < 5.6 || positive <= negative) return null;
        return { score: score, total: total };
    }

    function loadFeed(callback) {
        var request, timer, finished = false;
        if (feedState === 2) { callback(feedData); return; }
        feedWaiters.push(callback);
        if (feedState === 1) return;
        feedState = 1;
        function done(data) {
            var waiters, i;
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            feedData = data;
            feedState = 2;
            waiters = feedWaiters;
            feedWaiters = [];
            for (i = 0; i < waiters.length; i++) waiters[i](feedData);
        }
        timer = setTimeout(function () { done(null); }, 6500);
        try {
            request = new XMLHttpRequest();
            request.open('GET', FEED + '?day=' + formatDate(new Date()), true);
            request.onreadystatechange = function () {
                var data, age;
                if (request.readyState !== 4 || finished) return;
                if (request.status !== 200) { done(null); return; }
                try {
                    data = JSON.parse(request.responseText);
                    age = new Date().getTime() - Number(data.generated_at_epoch) * 1000;
                    if (data.version !== 1 || !data.rows || !isFinite(age) ||
                        age < -3600000 || age > 72 * 3600000) data = null;
                } catch (ignore) { data = null; }
                done(data);
            };
            request.onerror = function () { done(null); };
            request.send(null);
        } catch (ignore) { done(null); }
    }

    function formatDate(date) {
        var month = date.getMonth() + 1;
        var day = date.getDate();
        return date.getFullYear() + '-' + (month < 10 ? '0' : '') + month +
            '-' + (day < 10 ? '0' : '') + day;
    }

    // TMDB queries supply candidates; reactions determine whether they qualify.
    var COLLECTIONS = [
        { id: 'week', title: 'Самые популярные за неделю',
          fallbackTitle: 'В тренде на этой неделе', feed: 'weekly',
          query: 'trending/movie/week' },
        { id: 'month', title: 'Самые популярные за месяц',
          fallbackTitle: 'Сейчас популярны: релизы за месяц', feed: 'monthly',
          releaseDays: 30,
          query: 'sort_by=popularity.desc' },
        { id: 'halfyear', title: 'Самые популярные за полгода',
          fallbackTitle: 'Сейчас популярны: релизы 2–6 месяцев назад', feed: 'halfyear',
          releaseDays: 180, olderThanDays: 30,
          query: 'sort_by=popularity.desc' },
        { id: 'year', title: 'Самые популярные за год',
          fallbackTitle: 'Сейчас популярны: релизы 7–12 месяцев назад', feed: 'yearly',
          releaseDays: 365, olderThanDays: 180,
          query: 'sort_by=popularity.desc' },
        { id: 'fresh', title: 'Новые фильмы, которые оценили зрители',
          currentYear: true, ageDays: 14,
          query: 'sort_by=popularity.desc' },
        { id: 'best', title: 'Лучшие фильмы последних лет',
          fromYears: 12, beforeYears: 4, rotate: 0,
          query: 'sort_by=popularity.desc' },
        { id: 'comedy', title: 'Комедии с хорошими отзывами',
          fromYear: 1995, genre: 35, rotate: 1,
          query: 'sort_by=popularity.desc' },
        { id: 'thriller', title: 'Триллеры и детективы с сильными оценками',
          fromYear: 1995, genres: [53, 9648], rotate: 2,
          query: 'sort_by=popularity.desc' },
        { id: 'scifi', title: 'Фантастика с высоким рейтингом',
          fromYear: 1995, genre: 878, rotate: 3,
          query: 'sort_by=popularity.desc' },
        { id: 'gems', title: 'Хорошие фильмы вне главных хитов',
          fromYear: 2000, startPage: 2, rotate: 4,
          query: 'sort_by=popularity.desc' },
        { id: 'classics', title: 'Проверенное кино до 2000 года',
          beforeYear: 2000, rotate: 5,
          query: 'sort_by=popularity.desc' }
    ];

    function weekNumber(date) {
        // Monday 00:00 UTC, independent of the TV's local timezone.
        return Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(),
            date.getUTCDate()) - Date.UTC(1970, 0, 5)) / 604800000);
    }

    function firstPage(config, date) {
        var base = config.startPage || 1;
        if (typeof config.rotate !== 'number') return base;
        return base + 2 * ((weekNumber(date) + config.rotate) % ROTATION_WINDOWS);
    }

    function lastWeekIds(config, week, filter) {
        var saved, ids, recent = {}, i;
        if (typeof config.rotate !== 'number') return recent;
        try { saved = Lampa.Storage.get(KEY + 'rotation_' + config.id, null); }
        catch (ignore) { return recent; }
        if (saved && (saved.genres || defaultGenreKey()) !== filter.key) return recent;
        ids = saved && (saved.week === week ? saved.previous :
            saved.week === week - 1 ? saved.current : null);
        if (ids && ids.length) for (i = 0; i < ids.length; i++)
            recent[String(ids[i])] = true;
        return recent;
    }

    function saveWeekIds(config, week, cards, filter) {
        var saved, previous = [], ids = [], i;
        if (typeof config.rotate !== 'number' || !cards.length) return;
        try {
            saved = Lampa.Storage.get(KEY + 'rotation_' + config.id, null);
            if (saved && (saved.genres || defaultGenreKey()) !== filter.key) saved = null;
            if (saved && saved.week === week) previous = saved.previous || [];
            else if (saved && saved.week === week - 1) previous = saved.current || [];
            for (i = 0; i < cards.length; i++) ids.push(cards[i].id);
            Lampa.Storage.set(KEY + 'rotation_' + config.id,
                { week: week, current: ids, previous: previous, genres: filter.key });
        } catch (ignore) { /* Weekly page rotation still works without storage. */ }
    }

    function enabled(id) {
        try { return Lampa.Storage.get(KEY + id, true) !== false; }
        catch (ignore) { return true; }
    }

    function hideViewed() {
        try { return Lampa.Storage.get(KEY + 'hide_viewed', true) !== false; }
        catch (ignore) { return true; }
    }

    function watched(card) {
        try {
            var mark = Lampa.Favorite && Lampa.Favorite.check(card);
            return !!(mark && (mark.viewed || mark.thrown));
        } catch (ignore) { return false; }
    }

    function hasGenre(card, genre) {
        var ids = card.genre_ids;
        var i;
        if (!ids || !ids.length) return false;
        for (i = 0; i < ids.length; i++) {
            if (Number(ids[i]) === genre) return true;
        }
        return false;
    }

    function defaultGenreKey() {
        return '|16,99,27,10770';
    }

    function genreFilter() {
        var include = [], exclude = [], i, mode, fallback;
        for (i = 0; i < GENRES.length; i++) {
            fallback = GENRES[i].hidden ? 'exclude' : 'allow';
            try { mode = Lampa.Storage.get(KEY + 'genre_' + GENRES[i].id, fallback); }
            catch (ignore) { mode = fallback; }
            if (mode !== 'include' && mode !== 'exclude' && mode !== 'allow') mode = fallback;
            if (mode === 'include') include.push(GENRES[i].id);
            if (mode === 'exclude') exclude.push(GENRES[i].id);
        }
        return { include: include, exclude: exclude,
            key: include.join(',') + '|' + exclude.join(',') };
    }

    function genreMatches(card, filter) {
        var i, match = !filter.include.length;
        // Unknown genres cannot satisfy a requested restriction.
        if (!card.genre_ids || !card.genre_ids.length)
            return !filter.include.length && !filter.exclude.length;
        for (i = 0; i < filter.exclude.length; i++)
            if (hasGenre(card, filter.exclude[i])) return false;
        for (i = 0; i < filter.include.length; i++)
            if (hasGenre(card, filter.include[i])) match = true;
        return match;
    }

    function rowGenres(config, filter) {
        var ids = config.genre ? [config.genre] : (config.genres || []);
        var allowed = [], i;
        for (i = 0; i < ids.length; i++)
            if (filter.exclude.indexOf(ids[i]) === -1) allowed.push(ids[i]);
        return allowed;
    }

    function rowAllowed(config, filter) {
        if (filter.exclude.length === GENRES.length) return false;
        return !(config.genre || config.genres) || rowGenres(config, filter).length > 0;
    }

    function feedSupportsGenres(feed, filter) {
        var i;
        if (!feed) return false;
        if (feed.genre_policy === 'all') return true;
        // Older feeds removed these genres before reaching the viewer's device.
        for (i = 0; i < GENRES.length; i++)
            if (GENRES[i].hidden && filter.exclude.indexOf(GENRES[i].id) === -1) return false;
        return true;
    }

    function valid(card, config, cutoff, year, filter) {
        var date, match, i;
        if (!card || !card.id || !card.poster_path || card.adult === true ||
            (!card.title && !card.name)) return false;
        date = card.release_date;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > cutoff ||
            Number(date.substr(0, 4)) < 1900) return false;
        if (config.fromYear && Number(date.substr(0, 4)) < config.fromYear) return false;
        if (config.beforeYear && Number(date.substr(0, 4)) >= config.beforeYear) return false;
        if (config.fromYears && Number(date.substr(0, 4)) < year - config.fromYears) return false;
        if (config.currentYear && Number(date.substr(0, 4)) !== year) return false;
        if (config.releaseDays) {
            var first = new Date();
            first.setDate(first.getDate() - config.releaseDays);
            if (date < formatDate(first)) return false;
        }
        if (config.olderThanDays) {
            var latest = new Date();
            latest.setDate(latest.getDate() - config.olderThanDays);
            if (date > formatDate(latest)) return false;
        }
        if (config.beforeYears && Number(date.substr(0, 4)) > year - config.beforeYears) return false;
        if (config.genre && !hasGenre(card, config.genre)) return false;
        if (config.genres) {
            match = false;
            for (i = 0; i < config.genres.length; i++) {
                if (hasGenre(card, config.genres[i])) match = true;
            }
            if (!match) return false;
        }
        return genreMatches(card, filter);
    }

    function requestUrl(config, cutoff, year, filter) {
        var upper = cutoff;
        var boundary;
        var url = 'discover/movie?' + config.query;
        if (config.id === 'week') return config.query;
        var genres = rowGenres(config, filter);
        // The row theme is also checked locally, alongside the user's OR selection.
        if (!genres.length) genres = filter.include;
        if (genres.length) url += '&with_genres=' + genres.join('|');
        if (filter.exclude.length) url += '&without_genres=' + filter.exclude.join(',');
        if (config.releaseDays) {
            boundary = new Date();
            boundary.setDate(boundary.getDate() - config.releaseDays);
            url += '&primary_release_date.gte=' + formatDate(boundary);
        }
        if (config.olderThanDays) {
            boundary = new Date();
            boundary.setDate(boundary.getDate() - config.olderThanDays);
            if (formatDate(boundary) < upper) upper = formatDate(boundary);
        }
        if (config.fromYears) url += '&primary_release_date.gte=' + (year - config.fromYears) + '-01-01';
        if (config.currentYear) url += '&primary_release_date.gte=' + year + '-01-01';
        if (config.fromYear) url += '&primary_release_date.gte=' + config.fromYear + '-01-01';
        if (config.beforeYears) {
            boundary = (year - config.beforeYears) + '-12-31';
            if (boundary < upper) upper = boundary;
        }
        if (config.beforeYear) {
            boundary = (config.beforeYear - 1) + '-12-31';
            if (boundary < upper) upper = boundary;
        }
        return url + '&primary_release_date.lte=' + upper + COMMON;
    }

    function ratedCard(card, reaction, position) {
        var copy = {}, field;
        for (field in card) if (Object.prototype.hasOwnProperty.call(card, field)) {
            copy[field] = card[field];
        }
        copy.cub_hundred_rating = 0;
        copy.cub_hundred_fire = 0;
        copy.vote_average = Math.round(reaction.score * 10) / 10;
        copy.vote_count = reaction.total;
        copy.vlas_score = reaction.score;
        copy.vlas_rank = (1 - position / 400) * 6 + reaction.score * 0.4;
        return copy;
    }

    function makeRow(source, config, params, used, visibleState, filter) {
        return function (ready) {
            var finished = false;
            var timer;
            var now = new Date();
            var minimumAge = new Date(now.getTime());
            minimumAge.setDate(minimumAge.getDate() - (config.ageDays || 0));
            var cutoff = formatDate(minimumAge);
            var results = [];
            var repeats = [];
            var seen = {};
            var checked = 0;
            var week = weekNumber(now);
            var recent = lastWeekIds(config, week, filter);
            var basePage = config.startPage || 1;
            var rotatingPage = firstPage(config, now);
            var page = rotatingPage;
            var pagesRead = 0;
            var wrapped = false;
            var feedCards = null;
            var feedOffset = 0;
            var usedFeed = false;
            var exhausted = false;
            var rowTitle = config.fallbackTitle || config.title;

            function finish() {
                var i, data, hasMore, preview;
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                if (filter.key !== genreFilter().key) { ready({ results: [] }); return; }
                for (i = 0; i < repeats.length && results.length < TARGET + 1; i++) {
                    results.push(repeats[i]);
                }
                if (config.feed) {
                    results.sort(function (a, b) { return b.vlas_rank - a.vlas_rank; });
                } else {
                    results.sort(function (a, b) { return b.vlas_score - a.vlas_score; });
                }
                hasMore = results.length > TARGET;
                for (i = 0; i < results.length; i++) delete results[i].vlas_rank;
                preview = results.slice(0, TARGET);
                for (i = 0; i < preview.length; i++)
                    used[String(preview[i].id)] = config.id;
                if (preview.length) visibleState.count++;
                saveWeekIds(config, week, preview, filter);
                rowSessions[config.id] = {
                    filter: filter,
                    cards: preview, extra: results.slice(TARGET), seen: seen,
                    checked: checked, page: page, pagesRead: pagesRead,
                    wrapped: wrapped, feedOffset: feedOffset,
                    rotatingPage: rotatingPage, config: config, params: params,
                    used: used, title: rowTitle, hasMore: hasMore,
                    usedFeed: usedFeed
                };
                data = { results: preview, title: rowTitle, name: rowTitle,
                    source: 'tmdb', url: 'vlas/' + config.id,
                    total_pages: hasMore ? FULL_PAGES : 1 };
                ready(data);
            }

            function check(input, fromFeed, next) {
                var card, id, i, candidates = [], pending;
                for (i = 0; i < input.length; i++) {
                    card = input[i];
                    // Feed rows describe when viewers watched a film, regardless of release year.
                    if (!valid(card, fromFeed ? {} : config, cutoff, now.getFullYear(), filter)) continue;
                    id = String(card.id);
                    if (seen[id] || (visibleState.count < 5 && used[id])) continue;
                    if (hideViewed() && watched(card)) continue;
                    seen[id] = true;
                    candidates.push({ card: card, repeat: (!config.feed && !!used[id]) ||
                        !!recent[id],
                        position: checked++ });
                    if (checked >= ROW_CANDIDATES) break;
                }
                rowTitle = fromFeed ? config.title : (config.fallbackTitle || config.title);
                pending = candidates.length;
                if (!pending) { next(); return; }
                for (i = 0; i < candidates.length; i++) {
                    (function (candidate) {
                        reactionFor(candidate.card.id, function (reaction) {
                            var copy;
                            if (finished) return;
                            if (reaction) {
                                copy = ratedCard(candidate.card, reaction, candidate.position);
                                (candidate.repeat ? repeats : results).push(copy);
                            }
                            pending--;
                            if (!pending) {
                                if (results.length >= TARGET + 1) finish();
                                else next();
                            }
                        });
                    })(candidates[i]);
                }
            }

            function nextFeed() {
                var batch;
                if (finished) return;
                if (results.length >= TARGET + 1 || checked >= ROW_CANDIDATES ||
                    feedOffset >= feedCards.length) {
                    if (feedOffset >= feedCards.length) exhausted = true;
                    finish(); return;
                }
                batch = feedCards.slice(feedOffset, feedOffset + 20);
                feedOffset += batch.length;
                check(batch, true, nextFeed);
            }

            function nextPage() {
                var requestParams = {}, field, current;
                if (finished) return;
                if (results.length >= TARGET + 1 || checked >= ROW_CANDIDATES ||
                    pagesRead >= ROW_PAGES || (wrapped && page >= rotatingPage)) {
                    finish(); return;
                }
                current = page++;
                pagesRead++;
                for (field in params) if (Object.prototype.hasOwnProperty.call(params, field)) {
                    requestParams[field] = params[field];
                }
                requestParams.page = current;
                try {
                    source.get(requestUrl(config, cutoff, now.getFullYear(), filter), requestParams, function (data) {
                        if (finished) return;
                        if (!data || !data.results || !data.results.length) {
                            if (!wrapped && rotatingPage > basePage) {
                                wrapped = true; page = basePage; nextPage();
                            } else { exhausted = true; finish(); }
                            return;
                        }
                        check(data.results, false, function () {
                            if (data.total_pages && current >= Number(data.total_pages)) {
                                if (!wrapped && rotatingPage > basePage) {
                                    wrapped = true; page = basePage; nextPage();
                                } else { exhausted = true; finish(); }
                            }
                            else nextPage();
                        });
                    }, finish);
                } catch (ignore) { finish(); }
            }
            // Bound cold-start waits; subsequent openings reuse the six-hour reaction cache.
            timer = setTimeout(finish, 45000);
            if (config.feed) loadFeed(function (feed) {
                var cards = feed && feed.rows[config.feed];
                if (finished) return;
                if (cards && cards.length && feedSupportsGenres(feed, filter)) {
                    feedCards = cards;
                    usedFeed = true;
                    nextFeed();
                } else nextPage();
            });
            else nextPage();
        };
    }

    // The category/full screen asks the selected row for additional pages.
    // Continue from the vetted preview's cursor instead of restarting the search.
    function fullSession(source, session) {
        var cards = session.cards.concat(session.extra || []);
        var seen = session.seen || {};
        var config = session.config;
        var filter = session.filter;
        var now = new Date();
        var minimumAge = new Date(now.getTime());
        var page = session.page;
        var pagesRead = session.pagesRead;
        var rotatingPage = session.rotatingPage;
        var wrapped = session.wrapped;
        var feedOffset = session.feedOffset;
        var checked = session.checked;
        var exhausted = !session.hasMore;
        var requestId = 0;
        var busy = false;
        var waiting = [];
        minimumAge.setDate(minimumAge.getDate() - (config.ageDays || 0));

        function ensure(wanted, callback) {
            waiting.push({ wanted: wanted, callback: callback });
            if (busy) return;
            start();
        }

        function start() {
            var request, timer, done = false;
            if (!waiting.length) return;
            request = waiting[0];
            if (cards.length >= request.wanted || exhausted) {
                waiting.shift().callback(cards, exhausted);
                start(); return;
            }
            busy = true;
            requestId++;
            var currentId = requestId;

            function finish() {
                if (done) return;
                done = true;
                clearTimeout(timer);
                requestId++;
                busy = false;
                waiting.shift().callback(cards, exhausted);
                start();
            }

            function accept(input, fromFeed, next) {
                var candidates = [], approved = [], j, card, id, pending;
                if (currentId !== requestId) return;
                for (j = 0; j < input.length && checked < 700; j++) {
                    card = input[j];
                    if (!valid(card, fromFeed ? {} : config,
                        formatDate(minimumAge), now.getFullYear(), filter)) continue;
                    id = String(card.id);
                    if (seen[id]) continue;
                    if (hideViewed() && watched(card)) continue;
                    seen[id] = true;
                    candidates.push({ card: card, position: checked++ });
                }
                pending = candidates.length;
                if (!pending) { next(); return; }
                for (j = 0; j < candidates.length; j++) {
                    (function (candidate) {
                        reactionFor(candidate.card.id, function (reaction) {
                            if (currentId !== requestId) return;
                            if (reaction) {
                                var copy = ratedCard(candidate.card, reaction,
                                    candidate.position);
                                approved.push(copy);
                            }
                            pending--;
                            if (!pending) {
                                approved.sort(function (a, b) {
                                    return config.feed ? b.vlas_rank - a.vlas_rank :
                                        b.vlas_score - a.vlas_score;
                                });
                                for (var k = 0; k < approved.length; k++) {
                                    delete approved[k].vlas_rank;
                                    cards.push(approved[k]);
                                }
                                next();
                            }
                        });
                    })(candidates[j]);
                }
            }

            function nextFeed(feed) {
                var batch;
                if (currentId !== requestId) return;
                if (!feed || !feed.rows || !feed.rows[config.feed]) {
                    exhausted = true; finish(); return;
                }
                batch = feed.rows[config.feed].slice(feedOffset, feedOffset + 20);
                feedOffset += batch.length;
                if (!batch.length) { exhausted = true; finish(); return; }
                accept(batch, true, function () {
                    if (cards.length >= request.wanted) {
                        if (feedOffset >= feed.rows[config.feed].length) exhausted = true;
                        finish();
                    } else nextFeed(feed);
                });
            }

            function nextPage() {
                var requestParams = {}, field, current;
                if (currentId !== requestId) return;
                if (cards.length >= request.wanted || checked >= 700 ||
                    pagesRead >= 35 || (wrapped && page >= rotatingPage)) {
                    if (checked >= 700 || pagesRead >= 35 ||
                        (wrapped && page >= rotatingPage))
                        exhausted = true;
                    finish(); return;
                }
                current = page++;
                pagesRead++;
                for (field in session.params) {
                    if (Object.prototype.hasOwnProperty.call(session.params, field))
                        requestParams[field] = session.params[field];
                }
                requestParams.page = current;
                try {
                    source.get(requestUrl(config, formatDate(minimumAge),
                        now.getFullYear(), filter), requestParams, function (data) {
                        if (currentId !== requestId) return;
                        if (!data || !data.results || !data.results.length) {
                            if (!wrapped && rotatingPage > (config.startPage || 1)) {
                                wrapped = true; page = config.startPage || 1;
                                nextPage();
                            } else { exhausted = true; finish(); }
                            return;
                        }
                        accept(data.results, false, function () {
                            if (data.total_pages && current >= Number(data.total_pages)) {
                                if (!wrapped && rotatingPage > (config.startPage || 1)) {
                                    wrapped = true; page = config.startPage || 1;
                                } else exhausted = true;
                            }
                            if (cards.length >= request.wanted || exhausted) finish();
                            else nextPage();
                        });
                    }, function () { if (currentId === requestId) finish(); });
                } catch (ignore) { finish(); }
            }

            timer = setTimeout(finish, 45000);
            if (session.usedFeed) loadFeed(nextFeed);
            else nextPage();
        }

        return { ensure: ensure };
    }

    function install() {
        if (!window.Lampa || !Lampa.Api || !Lampa.Api.sources ||
            !Lampa.Api.sources.tmdb) return false;

        var source = Lampa.Api.sources.tmdb;
        var originalMain = source.main;
        var originalList = source.list;
        if (typeof originalMain !== 'function' || typeof originalList !== 'function' ||
            typeof source.get !== 'function') return false;

        source.list = function (params, oncomplete, onerror) {
            var match = /^vlas\/([a-z]+)$/.exec(params && params.url || '');
            var session = match && rowSessions[match[1]];
            var page, config, i, filter = genreFilter();
            if (!match) return originalList.apply(source, arguments);
            // Rebuild stale previews; never send a Vlas URL to the native API.
            if (!session || session.filter.key !== filter.key) {
                for (i = 0; i < COLLECTIONS.length; i++)
                    if (COLLECTIONS[i].id === match[1]) config = COLLECTIONS[i];
                if (!config || !enabled(config.id) || !rowAllowed(config, filter)) {
                    if (onerror) onerror();
                    return;
                }
                makeRow(source, config, params || {}, {}, { count: 0 }, filter)(function (data) {
                    if (data.results.length) source.list(params, oncomplete, onerror);
                    else if (onerror) onerror();
                });
                return;
            }
            page = Math.max(1, Math.min(FULL_PAGES, parseInt(params.page, 10) || 1));
            if (!session.full) session.full = fullSession(source, session);
            session.full.ensure(page * FULL_PAGE, function (cards, exhausted) {
                if (session.filter.key !== genreFilter().key) {
                    source.list(params, oncomplete, onerror);
                    return;
                }
                var pageCards = cards.slice((page - 1) * FULL_PAGE,
                    page * FULL_PAGE);
                if (!pageCards.length) { onerror(); return; }
                oncomplete({ results: pageCards, source: 'tmdb',
                    page: page, title: session.title,
                    total_pages: exhausted ?
                        Math.max(1, Math.ceil(cards.length / FULL_PAGE)) : FULL_PAGES });
            });
        };

        source.main = function (params, oncomplete, onerror) {
            var rows = [];
            var used = {};
            var visibleState = { count: 0 };
            var i, anyEnabled = false, filter = genreFilter();
            for (i = 0; i < COLLECTIONS.length; i++) {
                if (enabled(COLLECTIONS[i].id)) {
                    anyEnabled = true;
                    if (rowAllowed(COLLECTIONS[i], filter))
                        rows.push(makeRow(source, COLLECTIONS[i], params || {},
                            used, visibleState, filter));
                }
            }
            if (!anyEnabled) return originalMain.apply(source, arguments);
            if (!rows.length && Lampa.Noty)
                Lampa.Noty.show('Все жанры для включённых рядов исключены. Измените настройки «Жанры Vlas».');

            function next(done, fail) {
                var collected = [];
                function take() {
                    if (filter.key !== genreFilter().key) {
                        rows = [];
                        if (fail) fail();
                        return;
                    }
                    if (collected.length >= 2 || !rows.length) {
                        if (collected.length) done(collected);
                        else if (fail) fail();
                        return;
                    }
                    rows.shift()(function (data) {
                        if (data && data.results && data.results.length)
                            collected.push(data);
                        take();
                    });
                }
                take();
            }
            next(oncomplete, onerror);
            return next;
        };

        window.my_lampa_home_loaded = true;
        addSettings();
        addFilmixButton();
        return true;
    }

    function filmixEnabled() {
        try { return Lampa.Storage.get(KEY + 'filmix_button', true) !== false; }
        catch (ignore) { return true; }
    }

    function loadFilmix(callback) {
        var script, timeout, finished = false;
        if (window.online_filmix) { callback(true); return; }
        if (!Lampa.Manifest || Number(Lampa.Manifest.app_digital) < 155) {
            callback(false); return;
        }
        filmixWaiters.push(callback);
        if (filmixLoading) return;
        filmixLoading = true;

        function finish(ok) {
            var waiting, i;
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            if (!ok && script && script.parentNode)
                script.parentNode.removeChild(script);
            filmixLoading = false;
            waiting = filmixWaiters;
            filmixWaiters = [];
            for (i = 0; i < waiting.length; i++) waiting[i](ok);
        }

        try {
            script = document.createElement('script');
            script.src = FILMIX_SCRIPT;
            script.async = true;
            script.onload = function () { finish(!!window.online_filmix); };
            script.onerror = function () { finish(false); };
            timeout = setTimeout(function () { finish(!!window.online_filmix); }, 15000);
            (document.head || document.body).appendChild(script);
        } catch (ignore) { finish(false); }
    }

    function addFilmixButton() {
        if (!Lampa.Listener || !Lampa.Listener.follow) return;
        Lampa.Listener.follow('full', function (event) {
            var movie, buttons, anchor, button, opening = false;
            if (event.type !== 'complite' || !filmixEnabled() ||
                window.online_filmix || !event.data || !event.data.movie ||
                !event.object || !event.object.activity ||
                typeof $ !== 'function') return;
            movie = event.data.movie;
            buttons = event.object.activity.render();
            anchor = buttons.find('.view--torrent');
            if (!anchor.length || buttons.find('.view--vlas-filmix').length) return;
            button = $('<div class="full-start__button selector view--vlas-filmix" data-subtitle="Filmix"><svg width="50" height="50" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg><span>Filmix</span></div>');
            button.on('hover:enter', function () {
                if (opening) return;
                opening = true;
                loadFilmix(function (ok) {
                    opening = false;
                    if (!ok) {
                        if (Lampa.Noty && Lampa.Noty.show)
                            Lampa.Noty.show('Filmix недоступен. Проверьте сеть и версию Lampa.');
                        return;
                    }
                    if (!filmixEnabled() || !document.documentElement.contains(button[0])) return;
                    Lampa.Activity.push({
                        url: '', title: Lampa.Lang.translate('title_online'),
                        component: 'online_fxapi', search: movie.title || movie.name,
                        search_one: movie.title || movie.name,
                        search_two: movie.original_title || movie.original_name,
                        movie: movie, page: 1
                    });
                });
            });
            anchor.after(button);
        });
    }

    function genresChanged() {
        rowSessions = {};
        if (Lampa.Noty && Lampa.Noty.show)
            Lampa.Noty.show('Жанры сохранены. Откройте главную заново, чтобы обновить подборки.');
    }

    function setGenrePreset(defaults) {
        for (var i = 0; i < GENRES.length; i++)
            Lampa.Storage.set(KEY + 'genre_' + GENRES[i].id,
                defaults && GENRES[i].hidden ? 'exclude' : 'allow');
        genresChanged();
        if (Lampa.Settings && Lampa.Settings.update) Lampa.Settings.update();
    }

    function addGenreSettings() {
        var component = 'my_lampa_home_genres';
        Lampa.SettingsApi.addComponent({
            component: component, name: 'Жанры Vlas',
            icon: '<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg"><path d="M3 5h18M6 12h12M9 19h6" fill="none" stroke="currentColor" stroke-width="2"/></svg>'
        });
        Lampa.SettingsApi.addParam({
            component: 'my_lampa_home',
            param: { name: KEY + 'genres', type: 'button' },
            field: { name: 'Жанры для подборок',
                description: 'Персональный выбор и исключения для всех рядов Vlas и «Ещё»' },
            onChange: function () {
                if (Lampa.Settings && Lampa.Settings.create) Lampa.Settings.create(component);
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'genres_help', type: 'static' },
            field: { name: 'Как работает выбор',
                description: '«Выбирать» — хотя бы один из выбранных жанров. «Исключать» — скрывать фильм целиком. «Разрешать» — без предпочтения. После изменений откройте главную заново.' }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'genres_all', type: 'button' },
            field: { name: 'Разрешить все жанры',
                description: 'Сбросить выбор и исключения жанров. Проверка реакций зрителей сохранится.' },
            onChange: function () { setGenrePreset(false); }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'genres_defaults', type: 'button' },
            field: { name: 'Вернуть исходные настройки жанров',
                description: 'Исключить ужасы, мультфильмы, документальные и телефильмы; остальные разрешить.' },
            onChange: function () { setGenrePreset(true); }
        });
        for (var i = 0; i < GENRES.length; i++) {
            (function (genre) {
                Lampa.SettingsApi.addParam({
                    component: component,
                    param: { name: KEY + 'genre_' + genre.id, type: 'select',
                        values: { allow: 'Разрешать', include: 'Выбирать', exclude: 'Исключать' },
                        default: genre.hidden ? 'exclude' : 'allow' },
                    field: { name: genre.name },
                    onChange: function (value) {
                        if (value !== 'allow' && value !== 'include' && value !== 'exclude') return;
                        Lampa.Storage.set(KEY + 'genre_' + genre.id, value);
                        genresChanged();
                    }
                });
            })(GENRES[i]);
        }
    }

    function addSettings() {
        if (!Lampa.SettingsApi || !Lampa.SettingsApi.addComponent ||
            !Lampa.SettingsApi.addParam) return;
        try {
            Lampa.SettingsApi.addComponent({
                component: 'my_lampa_home',
                name: 'Моя главная',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg"><path d="M3 11L12 4l9 7v10H3z" fill="none" stroke="currentColor" stroke-width="2"/></svg>'
            });
            addGenreSettings();
            Lampa.SettingsApi.addParam({
                component: 'my_lampa_home',
                param: { name: KEY + 'hide_viewed', type: 'trigger', default: true },
                field: { name: 'Скрывать уже просмотренное',
                    description: 'Использует отметки просмотра самой Lampa' },
                onChange: function (value) {
                    Lampa.Storage.set(KEY + 'hide_viewed', value);
                }
            });
            Lampa.SettingsApi.addParam({
                component: 'my_lampa_home',
                param: { name: KEY + 'filmix_button', type: 'trigger', default: true },
                field: { name: 'Кнопка Filmix на странице фильма',
                    description: 'Подключает Filmix после нажатия кнопки' },
                onChange: function (value) {
                    Lampa.Storage.set(KEY + 'filmix_button', value);
                }
            });
            for (var i = 0; i < COLLECTIONS.length; i++) {
                (function (row) {
                    Lampa.SettingsApi.addParam({
                        component: 'my_lampa_home',
                        param: { name: KEY + row.id, type: 'trigger', default: true },
                        field: { name: row.title, description: 'Оценка по реакциям Lampa; учитывается ваш выбор жанров' },
                        onChange: function (value) {
                            Lampa.Storage.set(KEY + row.id, value);
                        }
                    });
                })(COLLECTIONS[i]);
            }
        } catch (ignore) {
            // Older Lampa versions can still use the home rows without settings.
        }
    }

    if (!install() && window.Lampa && Lampa.Listener && Lampa.Listener.follow) {
        Lampa.Listener.follow('app', function (event) {
            if (event.type === 'ready') install();
        });
    }
})();
