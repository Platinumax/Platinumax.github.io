/* My Lampa Home 2.0 — selected films for the standard TMDB source.
 * ES5 syntax for older webOS browsers. No API key and no extra server.
 * The visible card rating remains the TMDB rating.
 */
(function () {
    'use strict';

    if (window.my_lampa_home_loaded) return;

    var KEY = 'my_lampa_home_';
    var COMMON = '&without_genres=16,99,10770&with_runtime.gte=75&include_adult=false';

    function formatDate(date) {
        var month = date.getMonth() + 1;
        var day = date.getDate();
        return date.getFullYear() + '-' + (month < 10 ? '0' : '') + month +
            '-' + (day < 10 ? '0' : '') + day;
    }

    // The server query produces candidates; validate() checks every card again.
    var COLLECTIONS = [
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

            function finish(data) {
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
                    if (!valid(card, config, cutoff, now.getFullYear())) continue;
                    id = String(card.id);
                    if (local[id] || used[id]) continue;
                    local[id] = true;
                    results.push(card);
                }
                results.sort(function (a, b) {
                    return quality(b) - quality(a) || Number(b.vote_count) - Number(a.vote_count);
                });
                if (results.length > 18) results.length = 18;
                for (i = 0; i < results.length; i++) used[String(results[i].id)] = true;
                data.results = results;
                data.title = config.title;
                data.name = config.title;
                data.source = 'tmdb';
                ready(data);
            }

            // A stalled network request must never block the whole home screen.
            timer = setTimeout(function () { finish({ results: [] }); }, 12000);
            try {
                source.get(requestUrl(config, cutoff, now.getFullYear()), params, function (data) {
                    finish(data);
                }, function () {
                    finish({ results: [] });
                });
            } catch (ignore) {
                finish({ results: [] });
            }
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
