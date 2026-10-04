/* Vlas Home 5.4.2 — up to 100 qualifying movies in every More view.
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
    var filmixSettingsOpening = false;
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
    var MORE_LIMIT = 100;
    var ROTATION_WINDOWS = 6;
    var EXCLUSIVE_ROWS = ['week', 'month', 'twomonth', 'halfyear', 'year'];
    var PERSONAL_MAX_ITEMS = 700;
    var PERSONAL_COUNTRIES = {
        any: 'Любая', UA: 'Украина', US: 'США', GB: 'Великобритания',
        FR: 'Франция', DE: 'Германия', IT: 'Италия', ES: 'Испания',
        CA: 'Канада', AU: 'Австралия', KR: 'Южная Корея', JP: 'Япония',
        IN: 'Индия', PL: 'Польша', TR: 'Турция', RU: 'Россия'
    };
    var PERSONAL_LANGUAGES = {
        any: 'Любой', ru: 'Русский', uk: 'Украинский', en: 'Английский',
        fr: 'Французский', de: 'Немецкий', es: 'Испанский', it: 'Итальянский',
        ko: 'Корейский', ja: 'Японский', pl: 'Польский', tr: 'Турецкий'
    };
    var rowSessions = {};

    function loadSaved() {
        if (savedLoaded) return;
        savedLoaded = true;
        try { savedReactions = Lampa.Storage.get(KEY + 'reaction_cache', {}) || {}; }
        catch (ignore) { savedReactions = {}; }
    }

    function rememberReaction(id, value) {
        var keys, i, now = new Date().getTime();
        savedReactions[id] = { at: now, value: value, version: 4,
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
        if (saved && saved.version === 4 && saved.at && new Date().getTime() - saved.at <
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
                            if (!data || !data.result) complete(null, false);
                            else complete(readReactions(data));
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
        if (!rows || !rows.length) return { score: 0, total: 0, weak: true };
        for (i = 0; i < rows.length; i++) {
            type = rows[i] && rows[i].type;
            count = Number(rows[i] && rows[i].counter);
            if (Object.prototype.hasOwnProperty.call(counts, type) &&
                isFinite(count) && count >= 0) counts[type] += count;
        }
        total = counts.fire + counts.nice + counts.think + counts.bore + counts.shit;
        positive = counts.fire + counts.nice;
        negative = counts.bore + counts.shit;
        // Reject a small but clearly negative sample before classifying weak data.
        if ((total >= 5 && negative > positive && negative / total >= 0.5) ||
            (total >= 30 && (negative / total >= 0.38 ||
            (counts.shit >= 20 && counts.shit / total >= 0.2)))) {
            return { blocked: true, total: total };
        }
        score = total ? (10 * counts.fire + 8 * counts.nice + 5 * counts.think +
            2 * counts.bore + 20 * 5) / (total + 20) : 0;
        if (total < 15) return { score: score, total: total, weak: true };
        if (score >= 5.6 && positive > negative) return { score: score, total: total, positive: positive, negative: negative };
        if (score >= 4.5) return { score: score, total: total, positive: positive, negative: negative, soft: true };
        return { blocked: true, total: total };
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
                // Equal membership does not mean equal period statistics.
                if (data && data.row_sources && data.row_sources.yearly === 'daily_history_365')
                    data.rows.yearly = [];
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

    function stored(name, fallback) {
        try { return Lampa.Storage.get(KEY + name, fallback); }
        catch (ignore) { return fallback; }
    }

    function cleanDate(value) {
        var text = String(value || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
        var parsed = new Date(text + 'T00:00:00Z');
        return isFinite(parsed.getTime()) && formatDate(parsed) === text ? text : '';
    }

    function cleanYear(value) {
        var year = parseInt(value, 10);
        return isFinite(year) && year >= 1900 && year <= 2100 ? year : 0;
    }

    function dateDaysAgo(days) {
        var date = new Date();
        date.setDate(date.getDate() - days);
        return formatDate(date);
    }

    function dateYearsAgo(years) {
        var date = new Date();
        date.setFullYear(date.getFullYear() - years);
        return formatDate(date);
    }

    function personalEnabled() {
        return stored('personal', true) !== false;
    }

    function personalSettingsKey() {
        return [
            stored('personal_period', 'any'),
            stored('personal_date_from', ''), stored('personal_date_to', ''),
            stored('personal_year_from', ''), stored('personal_year_to', ''),
            stored('personal_cub_min', '0'), stored('personal_reactions_min', '15'),
            stored('personal_hide_viewed', true) !== false ? '1' : '0',
            stored('personal_sort', 'match'), stored('personal_country', 'any'),
            stored('personal_language', 'any')
        ].join('|');
    }

    function personalConfig() {
        var period = stored('personal_period', 'any');
        var manualFrom = cleanDate(stored('personal_date_from', ''));
        var manualTo = cleanDate(stored('personal_date_to', ''));
        var from = '', to = '', sort = stored('personal_sort', 'match');
        if (manualFrom || manualTo) {
            from = manualFrom; to = manualTo;
        } else {
            if (period === '7') from = dateDaysAgo(7);
            else if (period === '30') from = dateDaysAgo(30);
            else if (period === '31_60') { from = dateDaysAgo(60); to = dateDaysAgo(31); }
            else if (period === '61_180') { from = dateDaysAgo(180); to = dateDaysAgo(61); }
            else if (period === '181_365') { from = dateDaysAgo(365); to = dateDaysAgo(181); }
            else if (period === '3y') from = dateYearsAgo(3);
            else if (period === '5y') from = dateYearsAgo(5);
            else if (period === '10y') from = dateYearsAgo(10);
        }
        return {
            id: 'personal', title: 'Моя подборка', fallbackTitle: 'Моя подборка',
            personal: true, plainTitle: true,
            query: sort === 'new' ? 'sort_by=primary_release_date.desc' : 'sort_by=popularity.desc',
            dateFrom: from, dateTo: to,
            yearFrom: cleanYear(stored('personal_year_from', '')),
            yearTo: cleanYear(stored('personal_year_to', '')),
            minScore: Number(stored('personal_cub_min', '0')) || 0,
            minReactions: Number(stored('personal_reactions_min', '15')) || 15,
            personalSort: sort,
            originCountry: stored('personal_country', 'any') === 'any' ? '' :
                stored('personal_country', 'any'),
            originalLanguage: stored('personal_language', 'any') === 'any' ? '' :
                stored('personal_language', 'any'),
            settingsKey: personalSettingsKey()
        };
    }

    // TMDB queries supply candidates; reactions determine whether they qualify.
    var COLLECTIONS = [
        { id: 'week', title: 'Самые популярные за неделю',
          fallbackTitle: 'В тренде на этой неделе', feed: 'weekly',
          releaseDays: 7, preferYear: true, moreYears: 2, feedKeepsFilters: true,
          query: 'trending/movie/week' },
        { id: 'month', title: 'Самые популярные за месяц',
          fallbackTitle: 'Популярные фильмы', feed: 'monthly',
          releaseDays: 30, preferYear: true, moreYears: 2, feedKeepsFilters: true, excludeRows: ['week'],
          query: 'sort_by=popularity.desc' },
        { id: 'twomonth', title: 'Самые популярные за 2 месяца',
          fallbackTitle: 'Популярные фильмы 31–60 дней назад', feed: 'monthly',
          releaseDays: 60, olderThanDays: 31, preferYear: true, moreYears: 2, feedKeepsFilters: true, excludeRows: ['week', 'month'],
          query: 'sort_by=popularity.desc' },
        { id: 'halfyear', title: 'Самые популярные за полгода',
          fallbackTitle: 'Популярные фильмы последних 180 дней', feed: 'yearly',
          releaseDays: 180, preferYear: true, feedKeepsFilters: true, excludeRows: ['week', 'month', 'twomonth'],
          query: 'sort_by=popularity.desc' },
        { id: 'year', title: 'Самые популярные за предыдущее полугодие',
          fallbackTitle: 'Популярные фильмы 181–365 дней назад', feed: 'yearly',
          releaseDays: 365, olderThanDays: 181, preferYear: true, feedKeepsFilters: true, excludeRows: ['week', 'month', 'twomonth', 'halfyear'],
          query: 'sort_by=popularity.desc' },
        { id: 'topcurrent', title: 'Топ — текущий год',
          feed: 'yearly', currentYear: true, feedKeepsFilters: true, maxItems: MORE_LIMIT,
          query: 'sort_by=popularity.desc' },
        { id: 'topprevious', title: 'Топ — предыдущий год',
          feed: 'yearly', previousYear: true, feedKeepsFilters: true, maxItems: MORE_LIMIT,
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

    function personalGenreFilter() {
        var include = [], exclude = [], i, mode;
        for (i = 0; i < GENRES.length; i++) {
            mode = stored('personal_genre_' + GENRES[i].id, 'allow');
            if (mode !== 'include' && mode !== 'exclude' && mode !== 'allow') mode = 'allow';
            if (mode === 'include') include.push(GENRES[i].id);
            if (mode === 'exclude') exclude.push(GENRES[i].id);
        }
        return { include: include, exclude: exclude,
            key: include.join(',') + '|' + exclude.join(',') };
    }

    function filterForConfig(config) {
        return config && config.personal ? personalGenreFilter() : genreFilter();
    }

    function hideViewedFor(config) {
        if (config && config.personal) return stored('personal_hide_viewed', true) !== false;
        return hideViewed();
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
        if (config.dateFrom && date < config.dateFrom) return false;
        if (config.dateTo && date > config.dateTo) return false;
        if (config.yearFrom && Number(date.substr(0, 4)) < config.yearFrom) return false;
        if (config.yearTo && Number(date.substr(0, 4)) > config.yearTo) return false;
        if (config.originalLanguage && card.original_language &&
            card.original_language !== config.originalLanguage) return false;
        if (config.originCountry && card.origin_country && card.origin_country.length &&
            card.origin_country.indexOf(config.originCountry) === -1) return false;
        if (config.fromYear && Number(date.substr(0, 4)) < config.fromYear) return false;
        if (config.beforeYear && Number(date.substr(0, 4)) >= config.beforeYear) return false;
        if (config.fromYears && Number(date.substr(0, 4)) < year - config.fromYears) return false;
        if (config.currentYear && Number(date.substr(0, 4)) !== year) return false;
        if (config.previousYear && Number(date.substr(0, 4)) !== year - 1) return false;
        if (config.moreYears && Number(date.substr(0, 4)) < year - config.moreYears + 1) return false;
        if (config.currentMonth && date < cutoff.substr(0, 7) + '-01') return false;
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
        var upper = cutoff, lower = '';
        var boundary;
        var url = 'discover/movie?' + config.query;
        if (config.id === 'week') return config.query;
        var genres = rowGenres(config, filter);
        // The row theme is also checked locally, alongside the user's OR selection.
        if (!genres.length) genres = filter.include;
        if (genres.length) url += '&with_genres=' + genres.join('|');
        if (filter.exclude.length) url += '&without_genres=' + filter.exclude.join(',');
        if (config.originCountry) url += '&with_origin_country=' + encodeURIComponent(config.originCountry);
        if (config.originalLanguage) url += '&with_original_language=' + encodeURIComponent(config.originalLanguage);
        if (config.releaseDays) {
            boundary = new Date();
            boundary.setDate(boundary.getDate() - config.releaseDays);
            lower = formatDate(boundary);
        }
        if (config.currentMonth) lower = cutoff.substr(0, 7) + '-01';
        if (config.olderThanDays) {
            boundary = new Date();
            boundary.setDate(boundary.getDate() - config.olderThanDays);
            if (formatDate(boundary) < upper) upper = formatDate(boundary);
        }
        if (config.fromYears) lower = (year - config.fromYears) + '-01-01';
        if (config.currentYear && year + '-01-01' > lower) lower = year + '-01-01';
        if (config.previousYear) { lower = (year - 1) + '-01-01'; upper = (year - 1) + '-12-31'; }
        if (config.moreYears) lower = (year - config.moreYears + 1) + '-01-01';
        if (config.fromYear) lower = config.fromYear + '-01-01';
        if (config.dateFrom && config.dateFrom > lower) lower = config.dateFrom;
        if (config.dateTo && config.dateTo < upper) upper = config.dateTo;
        if (config.yearFrom && config.yearFrom + '-01-01' > lower)
            lower = config.yearFrom + '-01-01';
        if (config.yearTo) {
            boundary = config.yearTo + '-12-31';
            if (boundary < upper) upper = boundary;
        }
        if (config.beforeYears) {
            boundary = (year - config.beforeYears) + '-12-31';
            if (boundary < upper) upper = boundary;
        }
        if (config.beforeYear) {
            boundary = (config.beforeYear - 1) + '-12-31';
            if (boundary < upper) upper = boundary;
        }
        return url + (lower ? '&primary_release_date.gte=' + lower : '') +
            '&primary_release_date.lte=' + upper + COMMON;
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
        copy.vlas_position = position;
        return copy;
    }

    function fillerCard(card, reaction, position) {
        var copy = {}, field, score = reaction && isFinite(reaction.score) ?
            reaction.score : Number(card.vote_average) || 0;
        for (field in card) if (Object.prototype.hasOwnProperty.call(card, field)) {
            copy[field] = card[field];
        }
        if (reaction && reaction.total >= 15 && reaction.score) {
            copy.cub_hundred_rating = 0;
            copy.cub_hundred_fire = 0;
            copy.vote_average = Math.round(reaction.score * 10) / 10;
            copy.vote_count = reaction.total;
        }
        copy.vlas_score = score;
        copy.vlas_rank = (1 - position / 400) * 6 + score * 0.2;
        return copy;
    }

    function approvedReaction(reaction, config) {
        if (config && config.personal) {
            if (!reaction || reaction.blocked || reaction.weak ||
                reaction.total < (config.minReactions || 15)) return false;
            if (config.minScore && reaction.score < config.minScore) return false;
            return reaction.positive > reaction.negative;
        }
        if (!reaction || reaction.blocked || reaction.weak || reaction.total < 15) return false;
        return !reaction.soft && reaction.score >= 5.6;
    }

    function sortCards(cards, config) {
        if (config && config.personal) {
            if (config.personalSort === 'popular') {
                cards.sort(function (a, b) {
                    return (a.vlas_position || 0) - (b.vlas_position || 0);
                });
            } else if (config.personalSort === 'cub') {
                cards.sort(function (a, b) {
                    return (b.vlas_score || 0) - (a.vlas_score || 0) ||
                        (b.vote_count || 0) - (a.vote_count || 0);
                });
            } else if (config.personalSort === 'reactions') {
                cards.sort(function (a, b) {
                    return (b.vote_count || 0) - (a.vote_count || 0) ||
                        (b.vlas_score || 0) - (a.vlas_score || 0);
                });
            } else if (config.personalSort === 'new') {
                cards.sort(function (a, b) {
                    return String(b.release_date || '').localeCompare(String(a.release_date || '')) ||
                        (b.vlas_score || 0) - (a.vlas_score || 0);
                });
            } else {
                cards.sort(function (a, b) {
                    return (b.vlas_rank || 0) - (a.vlas_rank || 0) ||
                        (b.vote_count || 0) - (a.vote_count || 0);
                });
            }
            return;
        }
        if (config && config.feed)
            cards.sort(function (a, b) { return b.vlas_rank - a.vlas_rank; });
        else
            cards.sort(function (a, b) { return b.vlas_score - a.vlas_score; });
    }

    function canFillWeak(card, reaction, config) {
        var vote;
        if (!config.fillWeak || !reaction || reaction.blocked) return false;
        vote = Number(card && card.vote_average) || 0;
        if (vote && vote < (config.fillerVoteMin || 0)) return false;
        if (reaction.total >= 15 && reaction.negative > 0)
            return reaction.positive > reaction.negative &&
                reaction.negative / reaction.total < 0.45;
        return true;
    }

    function exclusiveRow(id) {
        return EXCLUSIVE_ROWS.indexOf(id) !== -1;
    }

    function excludedByRows(id, config, used) {
        return config.excludeRows && config.excludeRows.indexOf(used[id]) !== -1;
    }

    function ownedByOtherExclusiveRow(id, config, used) {
        return exclusiveRow(config.id) && used[id] && used[id] !== config.id &&
            exclusiveRow(used[id]);
    }

    function previousRows(config, filter) {
        var used = {}, i, j, session;
        for (i = 0; i < (config.excludeRows || []).length; i++) {
            session = rowSessions[config.excludeRows[i]];
            if (!session || session.filter.key !== filter.key || session.date !== formatDate(new Date())) continue;
            for (j = 0; j < session.cards.length; j++) used[String(session.cards[j].id)] = session.config.id;
        }
        return used;
    }

    function makeRow(source, config, params, used, visibleState, filter) {
        return function (ready) {
            var originalConfig = config, field, selection = {};
            for (field in config) if (Object.prototype.hasOwnProperty.call(config, field)) selection[field] = config[field];
            config = selection;
            delete config.moreYears;
            if (config.preferYear) config.currentYear = true;
            var finished = false;
            var timedOut = false;
            var wanted = config.maxItems ? ROW_CANDIDATES : TARGET + 1;
            var timer;
            var now = new Date();
            var minimumAge = new Date(now.getTime());
            minimumAge.setDate(minimumAge.getDate() - (config.ageDays || 0));
            var cutoff = formatDate(minimumAge);
            var results = [];
            var fillers = [];
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
            var rowTitle = config.plainTitle ? config.title :
                (config.fallbackTitle || config.title) + ' · TMDB';

            function finish() {
                var i, data, hasMore, preview;
                if (finished) return;
                if (!timedOut && config.preferYear && config.currentYear && results.length < TARGET) {
                    config.currentYear = false;
                    results = []; fillers = []; repeats = []; seen = {}; checked = 0;
                    page = rotatingPage; pagesRead = 0; wrapped = false; feedOffset = 0;
                    exhausted = false;
                    if (usedFeed) nextFeed(); else nextPage();
                    return;
                }
                finished = true;
                clearTimeout(timer);
                if (filter.key !== filterForConfig(config).key || (config.currentMonth &&
                    cutoff.substr(0, 7) !== formatDate(new Date()).substr(0, 7))) {
                    ready({ results: [] }); return;
                }
                for (i = 0; i < repeats.length && results.length < TARGET + 1; i++) {
                    results.push(repeats[i]);
                }
                sortCards(results, config);
                if (config.fillWeak && results.length < TARGET + 1) {
                    fillers.sort(function (a, b) {
                        return b.vlas_rank - a.vlas_rank || b.vlas_score - a.vlas_score;
                    });
                    for (i = 0; i < fillers.length && results.length < TARGET + 1; i++)
                        results.push(fillers[i]);
                }
                if (config.maxItems) results = results.slice(0, config.maxItems);
                hasMore = results.length > TARGET;
                if (!config.personal)
                    for (i = 0; i < results.length; i++) delete results[i].vlas_rank;
                preview = results.slice(0, TARGET);
                if (exclusiveRow(config.id))
                    for (i = 0; i < results.length; i++) used[String(results[i].id)] = config.id;
                if (preview.length) visibleState.count++;
                saveWeekIds(config, week, preview, filter);
                rowSessions[config.id] = {
                    filter: filter,
                    cards: preview, extra: results.slice(TARGET), seen: seen,
                    checked: checked, page: page, pagesRead: pagesRead,
                    wrapped: wrapped, feedOffset: feedOffset,
                    rotatingPage: rotatingPage, config: originalConfig, selection: config, params: params,
                    used: used, title: rowTitle, hasMore: hasMore,
                    cutoff: cutoff,
                    date: formatDate(now),
                    month: cutoff.substr(0, 7),
                    usedFeed: usedFeed
                };
                data = { results: preview, title: rowTitle, name: rowTitle,
                    source: 'tmdb', url: 'vlas/' + config.id,
                    total_pages: hasMore ? 2 : 1 };
                if (originalConfig.moreYears && preview.length) {
                    var session = rowSessions[config.id];
                    session.full = fullSession(source, session);
                    session.full.ensure(TARGET + 1, function (cards) {
                        if (filter.key !== genreFilter().key) { ready({ results: [] }); return; }
                        var previewIds = {}, j;
                        for (j = 0; j < preview.length; j++) previewIds[String(preview[j].id)] = true;
                        session.hasMore = cards.some(function (card) { return !previewIds[String(card.id)]; });
                        data.total_pages = session.hasMore ? 2 : 1;
                        ready(data);
                    });
                } else ready(data);
            }

            function check(input, fromFeed, next) {
                var card, id, i, candidates = [], pending;
                for (i = 0; i < input.length; i++) {
                    card = input[i];
                    // Some prepared feeds must still respect the row's local date
                    // window, while broad ranking feeds stay as-is.
                    if (!valid(card, fromFeed && !config.feedKeepsFilters ? {} : config,
                        cutoff, now.getFullYear(), filter)) continue;
                    id = String(card.id);
                    if (seen[id] || excludedByRows(id, config, used)) continue;
                    if (hideViewedFor(config) && watched(card)) continue;
                    seen[id] = true;
                    candidates.push({ card: card, repeat: (config.allowUsedAsRepeat &&
                        !!used[id]) || (!config.feed && config.id !== 'fresh' && !!used[id]) || !!recent[id],
                        position: checked++ });
                    if (checked >= ROW_CANDIDATES) break;
                }
                rowTitle = config.plainTitle ? config.title :
                    (fromFeed ? config.title : (config.fallbackTitle || config.title)) +
                    (fromFeed ? ' · Trakt' : ' · TMDB');
                pending = candidates.length;
                if (!pending) { next(); return; }
                for (i = 0; i < candidates.length; i++) {
                    (function (candidate) {
                        reactionFor(candidate.card.id, function (reaction) {
                            var copy;
                            if (finished) return;
                            if (approvedReaction(reaction, config)) {
                                copy = ratedCard(candidate.card, reaction, candidate.position);
                                (candidate.repeat ? repeats : results).push(copy);
                            } else if (canFillWeak(candidate.card, reaction, config)) {
                                fillers.push(fillerCard(candidate.card, reaction,
                                    candidate.position));
                            }
                            pending--;
                            if (!pending) {
                                if (results.length >= wanted) finish();
                                else next();
                            }
                        });
                    })(candidates[i]);
                }
            }

            function nextFeed() {
                var batch;
                if (finished) return;
                if (results.length >= wanted || checked >= ROW_CANDIDATES ||
                    feedOffset >= feedCards.length) {
                    if (feedOffset >= feedCards.length) {
                        // Short prepared feeds continue through the normal row source
                        // with the same local date window and quality rules.
                        if (config.feedFallback &&
                            results.length < TARGET + 1 &&
                            checked < ROW_CANDIDATES && pagesRead < ROW_PAGES) {
                            usedFeed = false;
                            nextPage(); return;
                        }
                        exhausted = true;
                    }
                    finish(); return;
                }
                batch = feedCards.slice(feedOffset, feedOffset + 20);
                feedOffset += batch.length;
                check(batch, true, nextFeed);
            }

            function nextPage() {
                var requestParams = {}, field, current;
                if (finished) return;
                if (results.length >= wanted || checked >= ROW_CANDIDATES ||
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
            timer = setTimeout(function () { timedOut = true; finish(); }, 45000);
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
        var config = session.selection || session.config;
        var maxItems = session.config.personal ? PERSONAL_MAX_ITEMS : MORE_LIMIT;
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
        // Weekly/monthly More has its own two-calendar-year scope. Revisit
        // the source so films excluded by the home year's filter can qualify.
        if (session.config.moreYears) {
            var fullConfig = {}, field;
            for (field in config) if (Object.prototype.hasOwnProperty.call(config, field)) fullConfig[field] = config[field];
            config = fullConfig;
            config.currentYear = false;
            config.moreYears = session.config.moreYears;
            cards = []; seen = {}; checked = 0;
            page = rotatingPage; pagesRead = 0; wrapped = false; feedOffset = 0;
            exhausted = false;
        }

        function ensure(wanted, callback) {
            waiting.push({ wanted: Math.min(wanted, maxItems), callback: callback });
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
                cards = cards.slice(0, maxItems);
                if (cards.length >= maxItems) exhausted = true;
                waiting.shift().callback(cards, exhausted);
                start();
            }

            function accept(input, fromFeed, next) {
                var candidates = [], approved = [], fillers = [], j, card, id, pending;
                if (currentId !== requestId) return;
                for (j = 0; j < input.length && checked < 700; j++) {
                    card = input[j];
                    if (!valid(card, fromFeed && !config.feedKeepsFilters ? {} : config,
                        formatDate(minimumAge), now.getFullYear(), filter)) continue;
                    id = String(card.id);
                    if (seen[id] || excludedByRows(id, config, session.used) ||
                        ownedByOtherExclusiveRow(id, config, session.used)) continue;
                    if (hideViewedFor(config) && watched(card)) continue;
                    seen[id] = true;
                    candidates.push({ card: card, position: checked++ });
                }
                pending = candidates.length;
                if (!pending) { next(); return; }
                for (j = 0; j < candidates.length; j++) {
                    (function (candidate) {
                        reactionFor(candidate.card.id, function (reaction) {
                            if (currentId !== requestId) return;
                            if (approvedReaction(reaction, config)) {
                                var copy = ratedCard(candidate.card, reaction,
                                    candidate.position);
                                if (exclusiveRow(config.id))
                                    session.used[String(candidate.card.id)] = config.id;
                                approved.push(copy);
                            } else if (canFillWeak(candidate.card, reaction, config)) {
                                if (exclusiveRow(config.id))
                                    session.used[String(candidate.card.id)] = config.id;
                                fillers.push(fillerCard(candidate.card, reaction,
                                    candidate.position));
                            }
                            pending--;
                            if (!pending) {
                                sortCards(approved, config);
                                fillers.sort(function (a, b) {
                                    return b.vlas_rank - a.vlas_rank ||
                                        b.vlas_score - a.vlas_score;
                                });
                                for (var k = 0; k < approved.length; k++) {
                                    if (!config.personal) delete approved[k].vlas_rank;
                                    cards.push(approved[k]);
                                }
                                for (k = 0; k < fillers.length; k++) {
                                    delete fillers[k].vlas_rank;
                                    cards.push(fillers[k]);
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
                if (checked >= 700 || cards.length >= maxItems) { exhausted = true; finish(); return; }
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
            var page, config, i, filter;
            if (!match) return originalList.apply(source, arguments);
            if (match[1] === 'personal') {
                config = personalConfig();
                filter = personalGenreFilter();
            } else {
                filter = genreFilter();
                for (i = 0; i < COLLECTIONS.length; i++)
                    if (COLLECTIONS[i].id === match[1]) config = COLLECTIONS[i];
            }
            if (!session || session.filter.key !== filter.key ||
                (config && config.personal && session.config.settingsKey !== config.settingsKey) ||
                (session && session.config.currentMonth &&
                session.month !== formatDate(new Date()).substr(0, 7)) ||
                (session && session.date !== formatDate(new Date()))) {
                if (!config || (config.personal ? !personalEnabled() : !enabled(config.id)) ||
                    !rowAllowed(config, filter)) {
                    if (onerror) onerror();
                    return;
                }
                makeRow(source, config, params || {},
                    config.personal ? {} : previousRows(config, filter),
                    { count: 0 }, filter)(function (data) {
                    if (data.results.length) source.list(params, oncomplete, onerror);
                    else if (onerror) onerror();
                });
                return;
            }
            var pageSize = session.config.personal ? TARGET : MORE_LIMIT;
            var pageLimit = session.config.personal ? Math.ceil(PERSONAL_MAX_ITEMS / TARGET) : 1;
            page = Math.max(1, parseInt(params.page, 10) || 1);
            if (page > pageLimit) { if (onerror) onerror(); return; }
            if (!session.full) session.full = fullSession(source, session);
            session.full.ensure(page * pageSize, function (cards, exhausted) {
                var currentConfig = session.config.personal ? personalConfig() : session.config;
                if (session.filter.key !== filterForConfig(currentConfig).key ||
                    (session.config.personal && session.config.settingsKey !== currentConfig.settingsKey) ||
                    (session.config.currentMonth &&
                    session.month !== formatDate(new Date()).substr(0, 7)) ||
                    session.date !== formatDate(new Date())) {
                    source.list(params, oncomplete, onerror);
                    return;
                }
                var pageCards = cards.slice((page - 1) * pageSize, page * pageSize);
                if (!pageCards.length) { if (onerror) onerror(); return; }
                oncomplete({ results: pageCards, source: 'tmdb',
                    page: page, title: session.title,
                    total_pages: exhausted ?
                        Math.max(1, Math.ceil(cards.length / pageSize)) :
                        (session.config.personal ? Math.min(pageLimit, page + 1) : pageLimit) });
            });
        };

        source.main = function (params, oncomplete, onerror) {
            var rows = [];
            var used = {};
            var visibleState = { count: 0 };
            var i, anyEnabled = false, filter = genreFilter();
            var personal = null, personalFilter = null;
            if (personalEnabled()) {
                anyEnabled = true;
                personal = personalConfig();
                personalFilter = personalGenreFilter();
                if (rowAllowed(personal, personalFilter))
                    rows.push(makeRow(source, personal, params || {}, {},
                        visibleState, personalFilter));
            }
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
                Lampa.Noty.show('Все жанры для включённых подборок исключены. Проверьте фильтры Vlas.');

            function changed() {
                if (filter.key !== genreFilter().key) return true;
                if (personal && (personalFilter.key !== personalGenreFilter().key ||
                    personal.settingsKey !== personalConfig().settingsKey)) return true;
                return false;
            }

            function next(done, fail) {
                var collected = [];
                function take() {
                    if (changed()) {
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

    function openFilmixSettings() {
        if (filmixSettingsOpening) return;
        if (!Lampa.Settings || typeof Lampa.Settings.create !== 'function') {
            if (Lampa.Noty && Lampa.Noty.show)
                Lampa.Noty.show('Настройки Filmix недоступны в этой версии Lampa. Обновите Lampa.');
            return;
        }
        filmixSettingsOpening = true;
        loadFilmix(function (ok) {
            filmixSettingsOpening = false;
            if (!ok) {
                if (Lampa.Noty && Lampa.Noty.show)
                    Lampa.Noty.show('Не удалось загрузить Filmix. Проверьте сеть и версию Lampa, затем повторите нажатие.');
                return;
            }
            try {
                // Some unrelated/partially loaded Filmix plugins set the global
                // flag without registering FX settings. Do not open a blank page.
                if (Lampa.SettingsApi.getComponent && !Lampa.SettingsApi.getComponent('fxapi'))
                    throw new Error('Filmix settings are not registered');
                Lampa.Settings.create('fxapi', { onBack: function () {
                    Lampa.Settings.create(nestedSettingsAvailable() ?
                        'my_lampa_home_filmix' : 'my_lampa_home');
                } });
            } catch (ignore) {
                if (Lampa.Noty && Lampa.Noty.show)
                    Lampa.Noty.show('Настройки Filmix не загрузились. Перезапустите Lampa и повторите нажатие.');
            }
        });
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

    function nestedSettingsAvailable() {
        return !!(Lampa.Template && Lampa.Template.add &&
            Lampa.Settings && Lampa.Settings.create);
    }

    function settingsChanged(message) {
        rowSessions = {};
        if (message && Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message);
    }

    function genresChanged() {
        settingsChanged('Жанры сохранены. Откройте главную заново, чтобы обновить подборки.');
    }

    function personalChanged() {
        settingsChanged();
    }

    function setGenrePreset(defaults) {
        for (var i = 0; i < GENRES.length; i++)
            Lampa.Storage.set(KEY + 'genre_' + GENRES[i].id,
                defaults && GENRES[i].hidden ? 'exclude' : 'allow');
        genresChanged();
        if (Lampa.Settings && Lampa.Settings.update) Lampa.Settings.update();
    }

    function setPersonalGenrePreset() {
        for (var i = 0; i < GENRES.length; i++)
            Lampa.Storage.set(KEY + 'personal_genre_' + GENRES[i].id, 'allow');
        personalChanged();
        if (Lampa.Settings && Lampa.Settings.update) Lampa.Settings.update();
    }

    function addNestedSection(parent, component, key, name, description) {
        if (!nestedSettingsAvailable()) return parent;
        Lampa.Template.add('settings_' + component, '<div></div>');
        Lampa.SettingsApi.addParam({
            component: parent,
            param: { name: KEY + key, type: 'button' },
            field: { name: name, description: description || '' },
            onChange: function () {
                Lampa.Settings.create(component, { onBack: function () {
                    Lampa.Settings.create(parent);
                } });
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + key + '_back', type: 'button' },
            field: { name: 'Назад' },
            onChange: function () { Lampa.Settings.create(parent); }
        });
        return component;
    }

    function addGenreControls(component, personal) {
        var prefix = personal ? 'personal_genre_' : 'genre_';
        var helpName = personal ? 'personal_genres_help' : 'genres_help';
        var allName = personal ? 'personal_genres_all' : 'genres_all';
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + helpName, type: 'static' },
            field: { name: 'Как работает выбор',
                description: '«Выбирать» — хотя бы один выбранный жанр. «Исключать» — фильм скрывается целиком. «Разрешать» — жанр не влияет на отбор.' }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + allName, type: 'button' },
            field: { name: 'Разрешить все жанры' },
            onChange: personal ? setPersonalGenrePreset : function () { setGenrePreset(false); }
        });
        if (!personal) {
            Lampa.SettingsApi.addParam({
                component: component,
                param: { name: KEY + 'genres_defaults', type: 'button' },
                field: { name: 'Вернуть исходные настройки жанров',
                    description: 'Исключить ужасы, мультфильмы, документальные и телефильмы; остальные разрешить.' },
                onChange: function () { setGenrePreset(true); }
            });
        }
        for (var i = 0; i < GENRES.length; i++) {
            (function (genre) {
                var fallback = personal ? 'allow' : (genre.hidden ? 'exclude' : 'allow');
                Lampa.SettingsApi.addParam({
                    component: component,
                    param: { name: KEY + prefix + genre.id, type: 'select',
                        values: { allow: 'Разрешать', include: 'Выбирать', exclude: 'Исключать' },
                        default: fallback },
                    field: { name: genre.name },
                    onChange: function (value) {
                        if (value !== 'allow' && value !== 'include' && value !== 'exclude') return;
                        Lampa.Storage.set(KEY + prefix + genre.id, value);
                        if (personal) personalChanged(); else genresChanged();
                    }
                });
            })(GENRES[i]);
        }
    }

    function addGlobalGenreSettings(parent) {
        var component = addNestedSection(parent, 'my_lampa_home_genres',
            'genres', 'Жанры для стандартных подборок',
            'Выбор и исключения жанров для стандартных рядов и их «Ещё»');
        addGenreControls(component, false);
    }

    function addPersonalSettings(parent) {
        var component = addNestedSection(parent, 'my_lampa_home_personal',
            'personal_section', 'Моя подборка',
            'Персональный первый ряд на главной и его фильтры');
        var genreComponent = addNestedSection(component, 'my_lampa_home_personal_genres',
            'personal_genres', 'Жанры',
            'Отдельные жанровые правила только для «Моей подборки»');

        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'personal', type: 'trigger', default: true },
            field: { name: 'Показывать «Мою подборку»',
                description: 'Первый ряд на главной странице Vlas' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'personal', value); personalChanged();
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'personal_period', type: 'select',
                values: { any: 'Любой период', '7': 'Последние 7 дней',
                    '30': 'Последние 30 дней', '31_60': '31–60 дней назад',
                    '61_180': '61–180 дней назад', '181_365': '181–365 дней назад',
                    '3y': 'Последние 3 года', '5y': 'Последние 5 лет',
                    '10y': 'Последние 10 лет' }, default: 'any' },
            field: { name: 'Период релиза',
                description: 'Ручные даты ниже имеют приоритет над этим быстрым периодом' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'personal_period', value); personalChanged();
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'personal_date_from', type: 'input',
                values: '', placeholder: 'YYYY-MM-DD', default: '' },
            field: { name: 'Своя дата — от',
                description: 'Можно указать только одну границу. Формат: YYYY-MM-DD' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'personal_date_from', value || ''); personalChanged();
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'personal_date_to', type: 'input',
                values: '', placeholder: 'YYYY-MM-DD', default: '' },
            field: { name: 'Своя дата — до',
                description: 'Если указана хотя бы одна корректная ручная дата, быстрый период не используется' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'personal_date_to', value || ''); personalChanged();
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'personal_year_from', type: 'input',
                values: '', placeholder: 'например 2020', default: '' },
            field: { name: 'Год релиза — от',
                description: 'Дополнительное условие, пересекается с периодом релиза' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'personal_year_from', value || ''); personalChanged();
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'personal_year_to', type: 'input',
                values: '', placeholder: 'например 2026', default: '' },
            field: { name: 'Год релиза — до',
                description: 'Оставьте пустым, если верхняя граница не нужна' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'personal_year_to', value || ''); personalChanged();
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'personal_cub_min', type: 'select',
                values: { '0': 'Без дополнительного ограничения',
                    '5': '5.0+', '5.5': '5.5+', '6': '6.0+', '6.5': '6.5+',
                    '7': '7.0+', '7.5': '7.5+', '8': '8.0+' }, default: '0' },
            field: { name: 'Минимальная оценка CUB' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'personal_cub_min', value); personalChanged();
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'personal_reactions_min', type: 'select',
                values: { '15': '15+', '30': '30+', '50': '50+', '100': '100+',
                    '250': '250+', '500': '500+' }, default: '15' },
            field: { name: 'Минимум реакций CUB' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'personal_reactions_min', value); personalChanged();
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'personal_hide_viewed', type: 'trigger', default: true },
            field: { name: 'Скрывать просмотренное',
                description: 'Отдельная настройка только для «Моей подборки»' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'personal_hide_viewed', value); personalChanged();
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'personal_sort', type: 'select',
                values: { match: 'Лучшее совпадение', popular: 'Популярность',
                    cub: 'Оценка CUB', reactions: 'Количество реакций',
                    new: 'Сначала новые' }, default: 'match' },
            field: { name: 'Сортировка' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'personal_sort', value); personalChanged();
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'personal_country', type: 'select',
                values: PERSONAL_COUNTRIES, default: 'any' },
            field: { name: 'Страна происхождения',
                description: 'В первой версии можно выбрать одну страну' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'personal_country', value); personalChanged();
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'personal_language', type: 'select',
                values: PERSONAL_LANGUAGES, default: 'any' },
            field: { name: 'Оригинальный язык',
                description: 'Необязательный фильтр; по умолчанию любой язык' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'personal_language', value); personalChanged();
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'personal_reset', type: 'button' },
            field: { name: 'Сбросить фильтры «Моей подборки»',
                description: 'Возвращает широкую выдачу, не затрагивая стандартные подборки' },
            onChange: function () {
                Lampa.Storage.set(KEY + 'personal_period', 'any');
                Lampa.Storage.set(KEY + 'personal_date_from', '');
                Lampa.Storage.set(KEY + 'personal_date_to', '');
                Lampa.Storage.set(KEY + 'personal_year_from', '');
                Lampa.Storage.set(KEY + 'personal_year_to', '');
                Lampa.Storage.set(KEY + 'personal_cub_min', '0');
                Lampa.Storage.set(KEY + 'personal_reactions_min', '15');
                Lampa.Storage.set(KEY + 'personal_hide_viewed', true);
                Lampa.Storage.set(KEY + 'personal_sort', 'match');
                Lampa.Storage.set(KEY + 'personal_country', 'any');
                Lampa.Storage.set(KEY + 'personal_language', 'any');
                setPersonalGenrePreset();
                personalChanged();
                if (Lampa.Settings && Lampa.Settings.update) Lampa.Settings.update();
            }
        });
        addGenreControls(genreComponent, true);
    }

    function addRowsSettings(parent) {
        var component = addNestedSection(parent, 'my_lampa_home_rows',
            'rows_section', 'Стандартные подборки',
            'Включение и выключение стандартных рядов Vlas');
        for (var i = 0; i < COLLECTIONS.length; i++) {
            (function (row) {
                Lampa.SettingsApi.addParam({
                    component: component,
                    param: { name: KEY + row.id, type: 'trigger', default: true },
                    field: { name: row.title,
                        description: 'Оценка по реакциям Lampa; учитываются общие жанровые фильтры' },
                    onChange: function (value) {
                        Lampa.Storage.set(KEY + row.id, value);
                        settingsChanged();
                    }
                });
            })(COLLECTIONS[i]);
        }
    }

    function addCommonSettings(parent) {
        var component = addNestedSection(parent, 'my_lampa_home_common',
            'common_section', 'Общие фильтры',
            'Фильтры, которые применяются к стандартным подборкам');
        addGlobalGenreSettings(component);
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'hide_viewed', type: 'trigger', default: true },
            field: { name: 'Скрывать уже просмотренное',
                description: 'Использует отметки просмотра самой Lampa' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'hide_viewed', value); settingsChanged();
            }
        });
    }

    function addFilmixSettings(parent) {
        var component = addNestedSection(parent, 'my_lampa_home_filmix',
            'filmix_section', 'Filmix',
            'Кнопка просмотра, вход и настройки Filmix');
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'filmix_button', type: 'trigger', default: true },
            field: { name: 'Кнопка Filmix на странице фильма',
                description: 'Подключает Filmix после нажатия кнопки' },
            onChange: function (value) {
                Lampa.Storage.set(KEY + 'filmix_button', value);
            }
        });
        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: KEY + 'filmix_settings', type: 'button' },
            field: { name: 'Filmix — вход и настройки',
                description: 'Откройте «Добавить устройство на Filmix» и введите полученный код на https://filmix.my/consoles. Отдельная установка плагина не нужна.' },
            onChange: openFilmixSettings
        });
    }

    function addSettings() {
        if (!Lampa.SettingsApi || !Lampa.SettingsApi.addComponent ||
            !Lampa.SettingsApi.addParam) return;
        try {
            Lampa.SettingsApi.addComponent({
                component: 'my_lampa_home',
                name: 'Настройки Vlas',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg"><path d="M3 11L12 4l9 7v10H3z" fill="none" stroke="currentColor" stroke-width="2"/></svg>'
            });
            addPersonalSettings('my_lampa_home');
            addRowsSettings('my_lampa_home');
            addCommonSettings('my_lampa_home');
            addFilmixSettings('my_lampa_home');
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
