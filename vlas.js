/* My Lampa Home 3.0 — popular movies and curated collections.
 * ES5 syntax for older webOS browsers. Trakt data is prepared on GitHub Pages.
 * The visible card rating remains the TMDB rating; Vlas score sorts the cards.
 */
(function () {
    'use strict';

    if (window.my_lampa_home_loaded) return;

    var KEY = 'my_lampa_home_';
    var COMMON = '&without_genres=16,99,10770&with_runtime.gte=75&include_adult=false';
    var FEED = 'https://platinumax.github.io/data/rankings.json';
    var feedState = 0;
    var feedData = null;
    var feedWaiters = [];

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

    // The server query produces candidates; validate() checks every card again.
    var COLLECTIONS = [
        { id: 'week', title: 'Самые популярные за неделю',
          fallbackTitle: 'В тренде TMDB на этой неделе', feed: 'weekly',
          minRating: 5.5, minVotes: 30, query: 'trending/movie/week' },
        { id: 'month', title: 'Самые популярные за месяц',
          fallbackTitle: 'Сейчас популярны: релизы за месяц', feed: 'monthly',
          minRating: 5.5, minVotes: 30, releaseDays: 30,
          query: 'sort_by=popularity.desc' },
        { id: 'halfyear', title: 'Самые популярные за полгода',
          fallbackTitle: 'Сейчас популярны: релизы за полгода', feed: 'halfyear',
          minRating: 5.5, minVotes: 60, releaseDays: 180,
          query: 'sort_by=popularity.desc' },
        { id: 'year', title: 'Самые популярные за год',
          fallbackTitle: 'Сейчас популярны: релизы за год', feed: 'yearly',
          minRating: 5.5, minVotes: 80, releaseDays: 365,
          query: 'sort_by=popularity.desc' },
        { id: 'fresh', title: 'Новые фильмы, которые оценили зрители',
          minRating: 7.1, minVotes: 700, fromYears: 3, ageDays: 30,
          query: 'sort_by=popularity.desc&vote_average.gte=7.1&vote_count.gte=700' },
        { id: 'best', title: 'Лучшие фильмы последних лет',
          minRating: 7.7, minVotes: 2500, fromYears: 12, beforeYears: 4,
          query: 'sort_by=vote_average.desc&vote_average.gte=7.7&vote_count.gte=2500' },
        { id: 'comedy', title: 'Комедии с хорошими отзывами',
          minRating: 7.1, minVotes: 800, fromYear: 1995, genre: 35,
          query: 'with_genres=35&sort_by=vote_average.desc&vote_average.gte=7.1&vote_count.gte=800' },
        { id: 'thriller', title: 'Триллеры и детективы с сильными оценками',
          minRating: 7.3, minVotes: 900, fromYear: 1995, genres: [53, 9648],
          query: 'with_genres=53|9648&sort_by=vote_average.desc&vote_average.gte=7.3&vote_count.gte=900' },
        { id: 'scifi', title: 'Фантастика с высоким рейтингом',
          minRating: 7.3, minVotes: 1000, fromYear: 1995, genre: 878,
          query: 'with_genres=878&sort_by=vote_average.desc&vote_average.gte=7.3&vote_count.gte=1000' },
        { id: 'gems', title: 'Хорошие фильмы вне главных хитов',
          minRating: 7.6, minVotes: 400, maxVotes: 2500, fromYear: 2000,
          query: 'sort_by=vote_average.desc&vote_average.gte=7.6&vote_count.gte=400&vote_count.lte=2500' },
        { id: 'classics', title: 'Проверенное кино до 2000 года',
          minRating: 7.8, minVotes: 1600, beforeYear: 2000,
          query: 'sort_by=vote_average.desc&vote_average.gte=7.8&vote_count.gte=1600' }
    ];

    function enabled(id) {
        try { return Lampa.Storage.get(KEY + id, true) !== false; }
        catch (ignore) { return true; }
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
        var date, votes, rating, match, i;
        if (!card || !card.id || !card.poster_path || card.adult === true ||
            (!card.title && !card.name)) return false;
        date = card.release_date;
        votes = Number(card.vote_count);
        rating = Number(card.vote_average);
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > cutoff ||
            !isFinite(votes) || !isFinite(rating) || votes < config.minVotes ||
            rating < config.minRating || rating > 10) return false;
        if (config.maxVotes && votes > config.maxVotes) return false;
        if (config.fromYear && Number(date.substr(0, 4)) < config.fromYear) return false;
        if (config.beforeYear && Number(date.substr(0, 4)) >= config.beforeYear) return false;
        if (config.fromYears && Number(date.substr(0, 4)) < year - config.fromYears) return false;
        if (config.releaseDays) {
            var first = new Date();
            first.setDate(first.getDate() - config.releaseDays);
            if (date < formatDate(first)) return false;
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
        if (card.genre_ids && (hasGenre(card, 16) || hasGenre(card, 99) ||
            hasGenre(card, 10770))) return false;
        return true;
    }

    function quality(card) {
        var votes = Number(card.vote_count);
        return (votes * Number(card.vote_average) + 650 * 6.5) / (votes + 650);
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
        if (config.fromYears) url += '&primary_release_date.gte=' + (year - config.fromYears) + '-01-01';
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

    function makeRow(source, config, params, used) {
        return function (ready) {
            var finished = false;
            var timer;
            var now = new Date();
            var minimumAge = new Date(now.getTime());
            minimumAge.setDate(minimumAge.getDate() - (config.ageDays || 0));
            var cutoff = formatDate(minimumAge);

            function finish(data, fromFeed) {
                var input, results, local, card, id, i;
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                data = data || {};
                input = data.results || [];
                results = [];
                local = {};
                for (i = 0; i < input.length; i++) {
                    card = input[i];
                    // Feed rows describe when viewers watched a film, regardless of release year.
                    if (!valid(card, fromFeed ? {
                        minRating: config.minRating, minVotes: config.minVotes
                    } : config, cutoff, now.getFullYear())) continue;
                    id = String(card.id);
                    if (local[id] || (!config.feed && used[id])) continue;
                    local[id] = true;
                    results.push(card);
                }
                if (fromFeed) results.sort(function (a, b) {
                    return Number(b.vlas_score) - Number(a.vlas_score);
                });
                else if (!config.feed) results.sort(function (a, b) {
                    return quality(b) - quality(a) || Number(b.vote_count) - Number(a.vote_count);
                });
                if (results.length > 18) results.length = 18;
                for (i = 0; i < results.length; i++) used[String(results[i].id)] = true;
                data.results = results;
                data.title = fromFeed ? config.title : (config.fallbackTitle || config.title);
                data.name = data.title;
                data.source = 'tmdb';
                ready(data);
            }

            // A stalled network request must never block the whole home screen.
            timer = setTimeout(function () { finish({ results: [] }); }, 12000);
            function fallback() {
                try {
                    source.get(requestUrl(config, cutoff, now.getFullYear()), params, function (data) {
                        finish(data, false);
                    }, function () { finish({ results: [] }, false); });
                } catch (ignore) { finish({ results: [] }, false); }
            }
            if (config.feed) loadFeed(function (feed) {
                var cards = feed && feed.rows[config.feed];
                if (cards && cards.length) finish({ results: cards }, true);
                else fallback();
            });
            else fallback();
        };
    }

    function install() {
        if (!window.Lampa || !Lampa.Api || !Lampa.Api.sources ||
            !Lampa.Api.sources.tmdb || !Lampa.Api.partNext) return false;

        var source = Lampa.Api.sources.tmdb;
        var originalMain = source.main;
        if (typeof originalMain !== 'function' || typeof source.get !== 'function') return false;

        source.main = function (params, oncomplete, onerror) {
            var rows = [];
            var used = {};
            var i;
            for (i = 0; i < COLLECTIONS.length; i++) {
                if (enabled(COLLECTIONS[i].id)) {
                    rows.push(makeRow(source, COLLECTIONS[i], params || {}, used));
                }
            }
            if (!rows.length) return originalMain.apply(source, arguments);

            function next(done, fail) {
                Lampa.Api.partNext(rows, 2, done, fail);
            }
            next(oncomplete, onerror);
            return next;
        };

        window.my_lampa_home_loaded = true;
        addSettings();
        return true;
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
            for (var i = 0; i < COLLECTIONS.length; i++) {
                (function (row) {
                    Lampa.SettingsApi.addParam({
                        component: 'my_lampa_home',
                        param: { name: KEY + row.id, type: 'trigger', default: true },
                        field: { name: row.title, description: 'Показывать этот ряд на главной' },
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
