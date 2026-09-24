const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'vlas.js'), 'utf8');
const KEY = 'my_lampa_home_';
const rowIds = ['week', 'month', 'halfyear', 'year', 'fresh', 'best', 'comedy',
    'thriller', 'scifi', 'gems', 'classics'];
const kinds = [[18], [35], [878], [27], [35, 27], [16], [99], [10770],
    [53], [9648], [35, 878], [], [18, 35]];
const fixtures = Array.from({length: 780}, (_, i) => ({
    id: i + 1, title: `Movie ${i + 1}`, poster_path: '/p.jpg',
    release_date: '2020-03-01', genre_ids: kinds[i % kinds.length],
    vote_average: 9.9
}));

function app(options = {}) {
    const storage = options.storage || new Map();
    const params = [], components = [], requests = [], notices = [], reactions = [];
    const pending = [], opened = [];
    let paused = false, nativeCalls = 0, updates = 0;
    const catalog = options.catalog || fixtures;
    const enabled = options.enabled || ['week'];
    const tmdb = {
        main() { nativeCalls++; throw Error('Unfiltered native main'); },
        list(p, done) { nativeCalls++; done({results: []}); },
        get(url, p, done) {
            requests.push({url, page: p.page});
            let movies = catalog;
            if (url.startsWith('discover/')) {
                const query = new URLSearchParams(url.split('?')[1]);
                const without = (query.get('without_genres') || '').split(',').map(Number);
                const withIds = (query.get('with_genres') || '').split('|').map(Number).filter(Boolean);
                movies = movies.filter(c => !c.genre_ids.some(id => without.includes(id)) &&
                    (!withIds.length || c.genre_ids.some(id => withIds.includes(id))));
            }
            done({results: movies.slice((p.page - 1) * 20, p.page * 20),
                total_pages: Math.ceil(movies.length / 20)});
        }
    };
    class XHR {
        open() {}
        send() {
            this.status = options.feed ? 200 : 404;
            this.readyState = 4;
            this.responseText = JSON.stringify(options.feed || {});
            this.onreadystatechange();
        }
    }
    const lampa = {
        Api: {sources: {tmdb, cub: {reactionsGet(p, done) {
            reactions.push(Number(p.id));
            const deliver = () => done({result: Number(p.id) === 1
                ? [{type: 'shit', counter: 1000}]
                : [{type: 'fire', counter: 30}, {type: 'nice', counter: 20}]});
            if (paused) pending.push(deliver); else deliver();
        }}}},
        Storage: {get(k, fallback) {
            if (storage.has(k)) return storage.get(k);
            if (rowIds.includes(k.slice(KEY.length))) return enabled.includes(k.slice(KEY.length));
            return fallback;
        }, set(k, value) { storage.set(k, value); }},
        Favorite: {check() { return {}; }},
        Noty: {show(text) { notices.push(text); }},
        Template: {add() {}},
        Settings: {create(id) { opened.push(id); }, update() { updates++; }},
        SettingsApi: {addComponent(c) { components.push(c); }, addParam(p) { params.push(p); }}
    };
    vm.runInNewContext(code, {window: {Lampa: lampa}, Lampa: lampa,
        XMLHttpRequest: XHR, Date, setTimeout(fn, delay) {
            const timer = setTimeout(fn, delay); timer.unref(); return timer;
        }, clearTimeout, Math, JSON, Object, isFinite});
    function change(name, value) {
        const setting = params.find(p => p.param.name === KEY + name);
        assert.ok(setting, `Setting ${name} is missing`);
        setting.onChange(value);
    }
    return {
        storage, params, components, requests, notices, reactions, opened, change,
        genre(id, mode) { change('genre_' + id, mode); },
        main() { return new Promise(resolve => tmdb.main({}, resolve, () => resolve([]))); },
        list(url, page = 1) {
            return new Promise(resolve => tmdb.list({url, page}, resolve,
                () => resolve({results: []})));
        },
        pause() { paused = true; },
        flush() { while (pending.length) pending.shift()(); paused = false; },
        get nativeCalls() { return nativeCalls; },
        get updates() { return updates; }
    };
}

function checkSelected(cards) {
    assert.ok(cards.length > 0);
    for (const c of cards) {
        assert.ok(c.genre_ids.includes(35) || c.genre_ids.includes(878));
        assert.ok(!c.genre_ids.includes(27), 'Excluded mixed genre leaked');
    }
}

(async () => {
    const user = app();
    assert.equal(user.params.filter(p => p.param.type === 'select').length, 19);
    user.change('genres');
    assert.equal(user.opened[0], 'my_lampa_home_genres');
    const [legacy] = await user.main();
    assert.equal(legacy.results.length, 24);
    assert.ok(legacy.results.every(c => !c.genre_ids.some(id => [16, 27, 99, 10770].includes(id))));

    user.genre(35, 'include'); user.genre(878, 'include');
    const [selected] = await user.main();
    checkSelected(selected.results);
    const more = await user.list(selected.url, 2);
    checkSelected(more.results);
    assert.equal(new Set(selected.results.concat(more.results).map(c => c.id)).size,
        selected.results.length + more.results.length);
    assert.ok(user.reactions.every(id => ![16, 27, 99, 10770].some(g => fixtures[id - 1].genre_ids.includes(g))),
        'Excluded genres consumed reaction requests');

    const restored = app({storage: user.storage});
    checkSelected((await restored.main())[0].results);
    assert.ok((await app().main())[0].results.some(c => c.genre_ids.includes(18) && !c.genre_ids.includes(35)),
        'Independent viewers shared genre preferences');

    user.genre(35, 'allow'); user.genre(878, 'allow'); user.genre(27, 'include');
    const rebuilt = await user.list(selected.url);
    assert.equal(rebuilt.results.length, 24);
    assert.ok(rebuilt.results.every(c => c.genre_ids.includes(27)), 'Old More preview leaked after change');
    assert.equal(user.nativeCalls, 0);

    user.storage.set(KEY + 'filmix_button', false);
    user.change('genres_all');
    assert.equal(user.storage.get(KEY + 'filmix_button'), false);
    const [all] = await user.main();
    for (const id of [16, 27, 99, 10770]) assert.ok(all.results.some(c => c.genre_ids.includes(id)));
    assert.ok(all.results.some(c => !c.genre_ids.length));
    assert.ok(!all.results.some(c => c.id === 1), 'Allow all bypassed reaction quality');
    user.change('genres_defaults');
    assert.ok((await user.main())[0].results.every(c => !c.genre_ids.includes(27)));
    assert.equal(user.updates, 2);

    const generic = app({enabled: ['best']});
    generic.genre(35, 'include'); generic.genre(878, 'include');
    checkSelected((await generic.main())[0].results);
    assert.ok(generic.requests[0].url.includes('with_genres=35|878'));
    assert.ok(!generic.requests[0].url.includes('without_genres=16,27,99,10770&'));

    const comedy = app({enabled: ['comedy']});
    comedy.genre(878, 'include');
    const [mixed] = await comedy.main();
    assert.ok(mixed.results.length > 0);
    assert.ok(mixed.results.every(c => c.genre_ids.includes(35) && c.genre_ids.includes(878)));
    assert.ok(comedy.requests[0].url.includes('with_genres=35'));
    comedy.genre(35, 'exclude');
    const calls = comedy.requests.length;
    assert.equal((await comedy.main()).length, 0);
    assert.equal(comedy.requests.length, calls, 'Impossible theme still queried');
    assert.equal(comedy.nativeCalls, 0);

    const mystery = app({enabled: ['thriller']});
    mystery.genre(53, 'exclude');
    const [mysteryRow] = await mystery.main();
    assert.ok(mysteryRow.results.every(c => c.genre_ids.includes(9648) && !c.genre_ids.includes(53)));
    assert.ok(mystery.requests[0].url.includes('with_genres=9648'));

    for (const setting of user.params.filter(p => p.param.type === 'select'))
        setting.onChange('exclude');
    assert.equal((await user.main()).length, 0);
    assert.equal(user.nativeCalls, 0, 'All excluded fell back to unrestricted main');
    assert.ok(user.notices.some(n => n.includes('Все жанры')));

    const feed = {version: 1, generated_at_epoch: Date.now() / 1000,
        genre_policy: 'all', rows: {weekly: fixtures}};
    const fed = app({feed});
    fed.genre(27, 'include');
    const [fedRow] = await fed.main();
    assert.equal(fed.requests.length, 0);
    assert.ok(fedRow.results.every(c => c.genre_ids.includes(27)));
    assert.ok((await fed.list(fedRow.url, 2)).results.every(c => c.genre_ids.includes(27)));
    const oldFeed = app({feed: {...feed, genre_policy: undefined}});
    oldFeed.genre(27, 'include');
    assert.ok((await oldFeed.main())[0].results.every(c => c.genre_ids.includes(27)));
    assert.ok(oldFeed.requests.length, 'Old prefiltered feed hid newly allowed horror');

    const changing = app();
    changing.pause();
    const pendingMain = changing.main();
    changing.genre(27, 'include');
    changing.flush();
    assert.equal((await pendingMain).length, 0, 'Stale async home was displayed');
    const [before] = await changing.main();
    changing.pause();
    const pendingMore = changing.list(before.url, 3);
    changing.genre(27, 'exclude'); changing.genre(35, 'include');
    changing.flush();
    const after = await pendingMore;
    assert.ok(after.results.length);
    assert.ok(after.results.every(c => c.genre_ids.includes(35) && !c.genre_ids.includes(27)),
        'Stale async More was displayed');

    const history = new Map([[KEY + 'rotation_comedy', {week: 0,
        current: [1], previous: [2], genres: 'old-filter'}]]);
    const rotated = app({storage: history, enabled: ['comedy']});
    rotated.genre(878, 'include');
    await rotated.main();
    const saved = history.get(KEY + 'rotation_comedy');
    assert.equal(saved.genres, '878|16,99,27,10770');
    assert.equal(saved.previous.length, 0);
    console.log('Genre settings: defaults, OR selection, exclusion priority, themes, More, races, feeds and isolation: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
