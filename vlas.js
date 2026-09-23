/* My Lampa Home 1.0 — film collections for the standard TMDB source.
 * ES5 syntax for older webOS browsers. No API key and no extra server.
 * Edit COLLECTIONS below to change the selection rules and order.
 */
(function () {
    'use strict';

    if (window.my_lampa_home_loaded) return;

    var KEY = 'my_lampa_home_';
    var year = (new Date()).getFullYear();
    var firstRecent = year - 2;
    var firstDecade = year - 9;

    // These are movie rows, not extra sections in the side menu.
    // Genre IDs: comedy 35, thriller 53, science fiction 878, mystery 9648.
    var COLLECTIONS = [
        { id: 'fresh', title: 'Новые фильмы с хорошими оценками',
          url: 'discover/movie?sort_by=popularity.desc&primary_release_date.gte=' + firstRecent + '-01-01&primary_release_date.lte=' + year + '-12-31&vote_average.gte=6.5&vote_count.gte=100&without_genres=99' },
        { id: 'week', title: 'Фильмы, о которых говорят на этой неделе',
          url: 'trending/movie/week' },
        { id: 'best', title: 'Лучшие фильмы последних лет',
          url: 'discover/movie?sort_by=vote_average.desc&primary_release_date.gte=' + firstDecade + '-01-01&vote_average.gte=7.5&vote_count.gte=1500&without_genres=99' },
        { id: 'comedy', title: 'Комедии для вечера',
          url: 'discover/movie?with_genres=35&sort_by=popularity.desc&vote_average.gte=6.5&vote_count.gte=350&without_genres=16' },
        { id: 'thriller', title: 'Триллеры с высоким рейтингом',
          url: 'discover/movie?with_genres=53&sort_by=popularity.desc&vote_average.gte=6.8&vote_count.gte=400' },
        { id: 'scifi', title: 'Фантастика, которую стоит посмотреть',
          url: 'discover/movie?with_genres=878&sort_by=popularity.desc&vote_average.gte=6.8&vote_count.gte=500' },
        { id: 'mystery', title: 'Детективы и загадки',
          url: 'discover/movie?with_genres=9648&sort_by=popularity.desc&vote_average.gte=6.8&vote_count.gte=300' },
        { id: 'gems', title: 'Малоизвестные хорошие фильмы',
          url: 'discover/movie?sort_by=vote_average.desc&vote_average.gte=7.2&vote_count.gte=200&vote_count.lte=1500&primary_release_date.gte=2000-01-01&without_genres=99' }
    ];

    function enabled(id) {
        try { return Lampa.Storage.get(KEY + id, true) !== false; }
        catch (ignore) { return true; }
    }

    function makeRow(source, config, params) {
        return function (ready) {
            var finished = false;
            var timer;

            function finish(data) {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                data = data || {};
                if (!data.results || !data.results.length) data.results = [];
                data.title = config.title;
                data.name = config.title;
                data.source = 'tmdb';
                ready(data);
            }

            // A stalled network request must never block the whole home screen.
            timer = setTimeout(function () { finish({ results: [] }); }, 12000);
            try {
                source.get(config.url, params, function (data) {
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
            var i;
            for (i = 0; i < COLLECTIONS.length; i++) {
                if (enabled(COLLECTIONS[i].id)) {
                    rows.push(makeRow(source, COLLECTIONS[i], params || {}));
                }
            }
            if (!rows.length) return originalMain.apply(source, arguments);

            function next(done, fail) {
                Lampa.Api.partNext(rows, 3, done, fail);
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
