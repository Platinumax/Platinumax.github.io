const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Freeze time across a year boundary to exercise the rolling 30-day window.
class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-01-15T12:00:00Z'])); }
    static now() { return new Clock().getTime(); }
}
function movie(id, premiere, eventDate, type = 4, genre = 18) {
    return {id, title: `Film ${id}`, poster_path: '/poster.jpg',
        release_date: premiere, genre_ids: [genre], vote_average: 10,
        releases: [{date: eventDate, type}]};
}
const weekly = Array.from({length: 24}, (_, i) =>
    movie(i + 1, '2026-01-01', '2026-01-01', 3));
const premieres = Array.from({length: 5}, (_, i) =>
    movie(i + 25, '2026-01-02', '2026-01-02', 3));
const digital = Array.from({length: 105}, (_, i) =>
    movie(i + 100, '2025-05-01', '2026-01-05', i % 2 ? 5 : 4));
const extras = [
    movie(300, '2025-03-01', '2026-01-03'), // negative reactions
    movie(301, '2025-03-01', '2026-01-03', 4, 27), // excluded genre
    movie(302, '2025-03-01', '2026-01-03'), // already watched
    movie(303, '2025-03-01', '2026-01-16'), // future digital event
    movie(304, '2025-03-01', '2025-12-15'), // outside 30 days
    movie(305, '2025-03-01', '2026-01-03', 1), // festival premiere only
    movie(306, '2026-01-16', '2026-01-03'), // future card date
    movie(307, '2025-03-01', '2025-12-16'), // inclusive lower boundary
    movie(308, '2025-03-01', '2026-01-15') // inclusive upper boundary
];
const catalog = weekly.concat(premieres, extras, digital);

function app(code, allowedGenres = null) {
    const requests = [], reacted = [];
    const tmdb = {
        main() { throw Error('Unexpected native main'); },
        list() { throw Error('Unexpected native list'); },
        get(url, params, done) {
            requests.push({url, page: params.page});
            let selected = weekly;
            if (url.startsWith('discover/')) {
                const q = new URLSearchParams(url.split('?')[1]);
                const primaryFrom = q.get('primary_release_date.gte');
                const primaryTo = q.get('primary_release_date.lte');
                const from = q.get('release_date.gte');
                const to = q.get('release_date.lte');
                const types = (q.get('with_release_type') || '').split('|').map(Number);
                const without = (q.get('without_genres') || '').split(',').map(Number);
                const withIds = (q.get('with_genres') || '').split('|').map(Number).filter(Boolean);
                selected = catalog.filter(c =>
                    (!primaryFrom || c.release_date >= primaryFrom) &&
                    (!primaryTo || c.release_date <= primaryTo) &&
                    !c.genre_ids.some(g => without.includes(g)) &&
                    (!withIds.length || c.genre_ids.some(g => withIds.includes(g))) &&
                    (!from || c.releases.some(r => r.date >= from && r.date <= to && types.includes(r.type))));
            }
            // Model a real Discover response: no release-event metadata on cards.
            const cards = selected.slice((params.page - 1) * 20, params.page * 20)
                .map(({releases, ...c}) => c);
            done({results: cards, total_pages: Math.ceil(selected.length / 20)});
        }
    };
    class XHR {
        open() {}
        send() { this.status = 404; this.readyState = 4; this.onreadystatechange(); }
    }
    const Lampa = {
        Api: {sources: {tmdb, cub: {reactionsGet(p, done) {
            reacted.push(Number(p.id));
            done({result: [{type: Number(p.id) === 300 ? 'shit' : 'fire', counter: 50}]});
        }}}},
        Storage: {get(key, fallback) {
            if (key === 'my_lampa_home_week' || key === 'my_lampa_home_month') return true;
            if (key === 'my_lampa_home_genre_35' && allowedGenres) return 'include';
            if (key.startsWith('my_lampa_home_genre_') ||
                key === 'my_lampa_home_hide_viewed' || key.endsWith('reaction_cache')) return fallback;
            return false;
        }, set() {}},
        Favorite: {check(c) { return {viewed: c.id === 302}; }}
    };
    vm.runInNewContext(code, {window: {Lampa}, Lampa, XMLHttpRequest: XHR,
        Date: Clock, Math, JSON, Object, isFinite, clearTimeout,
        setTimeout(fn, ms) { const t = setTimeout(fn, ms); t.unref(); return t; }});
    return {requests, reacted,
        main: () => new Promise(resolve => tmdb.main({}, resolve, () => resolve([]))),
        list: page => new Promise((resolve, reject) => tmdb.list({url: 'vlas/month', page},
            resolve, () => reject(Error('Empty continuation'))))};
}
(async () => {
    const code = fs.readFileSync(process.env.VLAS_TEST_CODE || path.join(__dirname, '..', 'vlas.js'), 'utf8');
    const user = app(code);
    const [week, month] = await user.main();
    assert.equal(week.results.length, 24);
    assert.equal(month.results.length, 24, 'Monthly row lost digital releases with older premieres');
    assert.equal(month.title, 'Сейчас популярны: релизы за месяц');
    assert.ok(month.total_pages > 1);
    assert.ok(month.results.some(c => c.release_date === '2025-05-01'));
    const first = await user.list(1), second = await user.list(2), third = await user.list(3);
    assert.deepEqual(Array.from(first.results, c => c.id), Array.from(month.results, c => c.id));
    assert.equal(second.results.length, 24);
    assert.equal(third.results.length, 24);
    const cards = week.results.concat(first.results, second.results, third.results);
    assert.equal(new Set(cards.map(c => c.id)).size, cards.length, 'Repeated film in preview or continuation');
    assert.ok(cards.some(c => c.id === 307) && cards.some(c => c.id === 308));
    assert.ok(cards.every(c => c.id < 300 || c.id > 306));
    assert.ok(!user.reacted.some(id => [301, 302, 303, 304, 305, 306].includes(id)));
    for (const request of user.requests.filter(r => r.url.startsWith('discover/'))) {
        const q = new URLSearchParams(request.url.split('?')[1]);
        assert.equal(q.get('release_date.gte'), '2025-12-16');
        assert.equal(q.get('release_date.lte'), '2026-01-15');
        assert.equal(q.get('primary_release_date.gte'), null);
        assert.equal(q.get('with_release_type'), '3|4|5');
    }
    assert.equal((await app(code, ['comedy']).main()).length, 0, 'Monthly row bypassed user genres');
    console.log('Monthly releases: old premieres, 30-day bounds, filters, unique rows and More OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
