/* Vlas Home 5.1 — collections, native continuation and optional Filmix.
 * ES5 syntax for older webOS browsers. Trakt data is prepared on GitHub Pages.
 * TMDB supplies movie metadata only; visible scores come from Lampa reactions.
 */
(function () {
    'use strict';

    if (window.my_lampa_home_loaded) return;

    var KEY = 'my_lampa_home_';
    var COMMON = '&without_genres=16,27,99,10770&with_runtime.gte=75&include_adult=false';
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
          fromYears: 12, beforeYears: 4,
          query: 'sort_by=popularity.desc' },
        { id: 'comedy', title: 'Комедии с хорошими отзывами',
          fromYear: 1995, genre: 35,
          query: 'with_genres=35&sort_by=popularity.desc' },
        { id: 'thriller', title: 'Триллеры и детективы с сильными оценками',
          fromYear: 1995, genres: [53, 9648],
          query: 'with_genres=53|9648&sort_by=popularity.desc' },
        { id: 'scifi', title: 'Фантастика с высоким рейтингом',
          fromYear: 1995, genre: 878,
          query: 'with_genres=878&sort_by=popularity.desc' },
        { id: 'gems', title: 'Хорошие фильмы вне главных хитов',
          fromYear: 2000, startPage: 2,
          query: 'sort_by=popularity.desc' },
        { id: 'classics', title: 'Проверенное кино до 2000 года',
          beforeYear: 2000,
          query: 'sort_by=popularity.desc' }
    ];

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

    function valid(card, config, cutoff, year) {
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
        if (!card.genre_ids || hasGenre(card, 27) || hasGenre(card, 16) || hasGenre(card, 99) ||
            hasGenre(card, 10770)) return false;
        return true;
    }

    function requestUrl(config, cutoff, year) {
        var upper = cutoff;
        var boundary;
        var url = 'discover/movie?' + config.query;
        if (config.id === 'week') return config.query;
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

    function makeRow(source, config, params, used, rowIndex) {
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
            var page = config.startPage || 1;
            var feedCards = null;
            var feedOffset = 0;
            var usedFeed = false;
            var exhausted = false;
            var rowTitle = config.fallbackTitle || config.title;

            function finish() {
                var i, data, hasMore;
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                for (i = 0; i < repeats.length && results.length < TARGET; i++) {
                    results.push(repeats[i]);
                }
                if (config.feed) {
                    results.sort(function (a, b) { return b.vlas_rank - a.vlas_rank; });
                } else {
                    results.sort(function (a, b) { return b.vlas_score - a.vlas_score; });
                }
                hasMore = results.length > TARGET || !exhausted;
                if (results.length > TARGET) results.length = TARGET;
                for (i = 0; i < results.length; i++) {
                    used[String(results[i].id)] = config.id;
                    delete results[i].vlas_rank;
                }
                rowSessions[config.id] = {
                    cards: results.slice(0), config: config, params: params,
                    used: used, title: rowTitle, hasMore: hasMore,
                    usedFeed: usedFeed, rowIndex: rowIndex
                };
                data = { results: results, title: rowTitle, name: rowTitle,
                    source: 'tmdb', url: 'vlas/' + config.id,
                    total_pages: hasMore ? FULL_PAGES : 1 };
                ready(data);
            }

            function check(input, fromFeed, next) {
                var card, id, i, candidates = [], pending;
                for (i = 0; i < input.length; i++) {
                    card = input[i];
                    // Feed rows describe when viewers watched a film, regardless of release year.
                    if (!valid(card, fromFeed ? {} : config, cutoff, now.getFullYear())) continue;
                    id = String(card.id);
                    if (seen[id] || (rowIndex < 5 && used[id])) continue;
                    if (hideViewed() && watched(card)) continue;
                    seen[id] = true;
                    candidates.push({ card: card, repeat: !config.feed && !!used[id],
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
                                if (results.length >= TARGET) finish();
                                else next();
                            }
                        });
                    })(candidates[i]);
                }
            }

            function nextFeed() {
                var batch;
                if (finished) return;
                if (results.length >= TARGET || checked >= ROW_CANDIDATES ||
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
                if (results.length >= TARGET || checked >= ROW_CANDIDATES ||
                    page > (config.startPage || 1) + ROW_PAGES - 1) { finish(); return; }
                current = page++;
                for (field in params) if (Object.prototype.hasOwnProperty.call(params, field)) {
                    requestParams[field] = params[field];
                }
                requestParams.page = current;
                try {
                    source.get(requestUrl(config, cutoff, now.getFullYear()), requestParams, function (data) {
                        if (finished) return;
                        if (!data || !data.results || !data.results.length) {
                            exhausted = true; finish(); return;
                        }
                        check(data.results, false, function () {
                            if (data.total_pages && current >= Number(data.total_pages)) {
                                exhausted = true; finish();
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
                if (cards && cards.length) {
                    feedCards = cards;
                    usedFeed = true;
                    nextFeed();
                } else nextPage();
            });
            else nextPage();
        };
    }

    // The category/full screen asks the selected row for additional pages.
    // Retain its vetted preview and fill later pages only when the user opens it.
    function fullSession(source, session) {
        var cards = session.cards.slice(0);
        var seen = {};
        var config = session.config;
        var now = new Date();
        var minimumAge = new Date(now.getTime());
        var page = config.startPage || 1;
        var feedOffset = 0;
        var checked = 0;
        var exhausted = !session.hasMore;
        var requestId = 0;
        var busy = false;
        var waiting = [];
        var i;
        minimumAge.setDate(minimumAge.getDate() - (config.ageDays || 0));
        for (i = 0; i < cards.length; i++) seen[String(cards[i].id)] = true;

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
                var candidates = [], j, card, id, pending;
                if (currentId !== requestId) return;
                for (j = 0; j < input.length && checked < 700; j++) {
                    card = input[j];
                    if (!valid(card, fromFeed ? {} : config,
                        formatDate(minimumAge), now.getFullYear())) continue;
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
                                delete copy.vlas_rank;
                                cards.push(copy);
                            }
                            pending--;
                            if (!pending) next();
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
                    page > (config.startPage || 1) + 34) {
                    if (checked >= 700 || page > (config.startPage || 1) + 34)
                        exhausted = true;
                    finish(); return;
                }
                current = page++;
                for (field in session.params) {
                    if (Object.prototype.hasOwnProperty.call(session.params, field))
                        requestParams[field] = session.params[field];
                }
                requestParams.page = current;
                try {
                    source.get(requestUrl(config, formatDate(minimumAge),
                        now.getFullYear()), requestParams, function (data) {
                        if (currentId !== requestId) return;
                        if (!data || !data.results || !data.results.length) {
                            exhausted = true; finish(); return;
                        }
                        accept(data.results, false, function () {
                            if (data.total_pages && current >= Number(data.total_pages))
                                exhausted = true;
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
            var page;
            if (!session) return originalList.apply(source, arguments);
            page = Math.max(1, Math.min(FULL_PAGES, parseInt(params.page, 10) || 1));
            if (!session.full) session.full = fullSession(source, session);
            session.full.ensure(page * FULL_PAGE, function (cards, exhausted) {
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
            var i;
            for (i = 0; i < COLLECTIONS.length; i++) {
                if (enabled(COLLECTIONS[i].id)) {
                    rows.push(makeRow(source, COLLECTIONS[i], params || {}, used, i));
                }
            }
            if (!rows.length) return originalMain.apply(source, arguments);

            function next(done, fail) {
                var collected = [];
                function take() {
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

    function addSettings() {
        if (!Lampa.SettingsApi || !Lampa.SettingsApi.addComponent ||
            !Lampa.SettingsApi.addParam) return;
        try {
            Lampa.SettingsApi.addComponent({
                component: 'my_lampa_home',
                name: 'Моя главная',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg"><path d="M3 11L12 4l9 7v10H3z" fill="none" stroke="currentColor" stroke-width="2"/></svg>'
            });
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
                        field: { name: row.title, description: 'Оценка по реакциям Lampa; ужасы скрыты' },
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
