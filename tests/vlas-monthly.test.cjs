const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(process.env.VLAS_TEST_CODE || path.join(__dirname, '..', 'vlas.js'), 'utf8');
function movie(id, date, genre = 18) {
    return {id, title: `Film ${id}`, poster_path: '/p.jpg', release_date: date,
        genre_ids: [genre], vote_average: 10};
}
const weekly = Array.from({length: 24}, (_, i) => movie(i + 1, '2026-01-02'));
const premieres = Array.from({length: 100}, (_, i) => movie(i + 100, '2026-01-05'));
const invalid = [movie(300, '2025-05-01'), movie(301, '2025-12-31'),
    movie(302, '2026-01-16'), movie(303, ''), movie(304, '2024-01-05'),
    movie(305, '2026-01-05', 27), movie(306, '2026-01-05'), movie(307, '2026-01-05')];
const boundaries = [movie(308, '2026-01-01'), movie(309, '2026-01-15')];
function app(options = {}) {
    let now = options.now || '2026-01-15T12:00:00Z';
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return new Clock().getTime(); }
    }
    const requests = [], reacted = [];
    const catalog = options.catalog || weekly.concat(invalid, boundaries, premieres);
    const tmdb = {
        main() { throw Error('Unexpected native main'); },
        list() { throw Error('Unexpected native list'); },
        get(url, params, done) {
            requests.push({url, page: params.page});
            let selected = url.startsWith('discover/') ? catalog : weekly;
            if (url.startsWith('discover/') && !options.leaky) {
                const q = new URLSearchParams(url.split('?')[1]);
                const from = q.get('primary_release_date.gte'), to = q.get('primary_release_date.lte');
                selected = selected.filter(c => (!from || c.release_date >= from) &&
                    (!to || c.release_date <= to));
            }
            done({results: selected.slice((params.page - 1) * 20, params.page * 20),
                total_pages: Math.ceil(selected.length / 20)});
        }
    };
    class XHR {
        open() {}
        send() {
            this.status = options.feed ? 200 : 404; this.readyState = 4;
            this.responseText = JSON.stringify({version: 1, genre_policy: 'all',
                generated_at_epoch: Clock.now() / 1000,
                rows: {weekly, monthly: catalog}});
            this.onreadystatechange();
        }
    }
    const Lampa = {
        Api: {sources: {tmdb, cub: {reactionsGet(p, done) {
            reacted.push(Number(p.id));
            done({result: [{type: Number(p.id) === 306 ? 'shit' : 'fire', counter: 50}]});
        }}}},
        Storage: {get(key, fallback) {
            if (key === 'my_lampa_home_week') return !options.onlyMonth;
            if (key === 'my_lampa_home_month') return true;
            if (key === 'my_lampa_home_genre_35' && options.comedy) return 'include';
            if (key.startsWith('my_lampa_home_genre_') ||
                key === 'my_lampa_home_hide_viewed' || key.endsWith('reaction_cache')) return fallback;
            return false;
        }, set() {}},
        Favorite: {check(c) { return {viewed: c.id === 307}; }}
    };
    vm.runInNewContext(code, {window: {Lampa}, Lampa, XMLHttpRequest: XHR,
        Date: Clock, Math, JSON, Object, isFinite, clearTimeout,
        setTimeout(fn, ms) { const t = setTimeout(fn, ms); t.unref(); return t; }});
    return {requests, reacted, setDate(date) { now = date; },
        main: () => new Promise(resolve => tmdb.main({}, resolve, () => resolve([]))),
        list: page => new Promise(resolve => tmdb.list({url: 'vlas/month', page},
            resolve, () => resolve({results: []})))};
}
(async () => {
    for (const options of [{}, {leaky: true}, {feed: true}]) {
        const user = app(options);
        const [week, month] = await user.main();
        assert.equal(week.results.length, 24);
        assert.equal(month.results.length, 24);
        assert.ok(month.results.every(c => c.release_date >= '2026-01-01' &&
            c.release_date <= '2026-01-15'), 'Monthly preview contains old or future premieres');
        assert.equal(month.title, options.feed ? 'Популярные премьеры этого месяца' :
            'Премьеры этого месяца: популярны сейчас');
        const first = await user.list(1), second = await user.list(2), third = await user.list(3);
        assert.deepEqual(Array.from(first.results, c => c.id), Array.from(month.results, c => c.id));
        assert.equal(second.results.length, 24);
        assert.equal(third.results.length, 24);
        const cards = week.results.concat(first.results, second.results, third.results);
        assert.equal(new Set(cards.map(c => c.id)).size, cards.length);
        assert.ok(cards.every(c => c.release_date >= '2026-01-01' && c.release_date <= '2026-01-15'),
            'Old/future premiere passed the monthly filter');
        assert.ok(cards.some(c => c.id === 308) && cards.some(c => c.id === 309));
        assert.ok(!cards.some(c => c.id >= 300 && c.id <= 307));
        assert.ok(!user.reacted.some(id => [300, 301, 302, 303, 304, 305, 307].includes(id)));
        for (const req of user.requests.filter(r => r.url.startsWith('discover/'))) {
            const q = new URLSearchParams(req.url.split('?')[1]);
            assert.equal(q.get('primary_release_date.gte'), '2026-01-01');
            assert.equal(q.get('primary_release_date.lte'), '2026-01-15');
            assert.equal(q.get('with_release_type'), null);
            assert.equal(q.get('release_date.gte'), null);
        }
    }
    const scarce = app({onlyMonth: true, catalog: invalid.concat(premieres.slice(0, 5))});
    const [short] = await scarce.main();
    assert.equal(short.results.length, 5, 'Scarcity widened the release window');
    assert.equal(short.total_pages, 1);
    assert.equal((await app({comedy: true}).main()).length, 0);
    // The next calendar month must invalidate an already opened More session.
    const rollover = app({onlyMonth: true, catalog: premieres.concat(
        Array.from({length: 40}, (_, i) => movie(1000 + i, '2026-02-01')))});
    await rollover.main();
    rollover.setDate('2026-02-01T12:00:00Z');
    const feb = await rollover.list(1);
    assert.equal(feb.results.length, 24);
    assert.ok(feb.results.every(c => c.release_date === '2026-02-01'));
    for (const [now, from, until] of [
        ['2026-01-01T12:00:00Z', '2026-01-01', '2026-01-01'],
        ['2024-02-29T12:00:00Z', '2024-02-01', '2024-02-29'],
        ['2026-09-25T12:00:00Z', '2026-09-01', '2026-09-25']
    ]) {
        const edge = app({now, onlyMonth: true, catalog: [movie(600, from), movie(601, until)]});
        const [row] = await edge.main();
        assert.equal(row.results.length, 2);
        assert.ok(edge.requests[0].url.includes('primary_release_date.gte=' + from));
    }
    console.log('Calendar month: premiere dates, source validation, scarcity, More, rollover, genres and reactions OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
