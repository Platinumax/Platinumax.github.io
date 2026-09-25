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
    const storage = options.storage || new Map();
    const weekCatalog = options.weekly || weekly;
    const catalog = options.catalog || weekly.concat(invalid, boundaries, premieres);
    const tmdb = {
        main() { throw Error('Unexpected native main'); },
        list() { throw Error('Unexpected native list'); },
        get(url, params, done) {
            requests.push({url, page: params.page});
            let selected = url.startsWith('discover/') ? catalog : weekCatalog;
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
                rows: {weekly: weekCatalog, monthly: options.feedCatalog || catalog}});
            this.onreadystatechange();
        }
    }
    const Lampa = {
        Api: {sources: {tmdb, cub: {reactionsGet(p, done) {
            reacted.push(Number(p.id));
            if (options.cubUnavailable) { done(null); return; }
            done({result: options.reactions ? options.reactions(Number(p.id)) :
                [{type: Number(p.id) === 306 ? 'shit' : 'fire', counter: 50}]});
        }}}},
        Storage: {get(key, fallback) {
            if (storage.has(key)) return storage.get(key);
            if (key === 'my_lampa_home_week') return !options.onlyMonth;
            if (key === 'my_lampa_home_month') return true;
            if (key === 'my_lampa_home_genre_35' && options.comedy) return 'include';
            if (key.startsWith('my_lampa_home_genre_') ||
                key === 'my_lampa_home_hide_viewed' || key.endsWith('reaction_cache')) return fallback;
            return false;
        }, set(key, value) { storage.set(key, value); }},
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
        assert.equal(month.title, 'Сейчас популярны: релизы за месяц');
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
    const mild = Array.from({length: 20}, (_, i) => movie(800 + i, '2026-01-06'));
    const ratings = id => id >= 800 ? [{type: 'nice', counter: 4 + id % 5},
        {type: 'think', counter: 30}] : [{type: id === 306 ? 'shit' : 'fire', counter: 50}];
    for (const feed of [false, true]) {
        // Old caches stored mild scores as null. The new policy must recheck them.
        const oldCache = Object.fromEntries(mild.map(c => [String(c.id),
            {at: new Date('2026-01-15T12:00:00Z').getTime(), value: null}]));
        const user = app({onlyMonth: true, feed, reactions: ratings,
            storage: new Map([['my_lampa_home_reaction_cache', oldCache]]),
            catalog: invalid.concat(premieres.slice(0, 3), mild)});
        const [row] = await user.main();
        assert.equal(row.results.length, 10, 'Three strong premieres were not topped up to ten');
        assert.ok(row.results.slice(0, 3).every(c => c.vlas_score >= 5.6));
        assert.ok(row.results.slice(3).every(c => c.vlas_score >= 5 && c.vlas_score < 5.6));
        assert.ok(row.results.every(c => c.release_date.startsWith('2026-01')));
        assert.ok(!row.results.some(c => c.id === 306 || c.id === 305));
        const scores = Array.from(row.results.slice(3), c => c.vlas_score);
        assert.deepEqual(scores, scores.slice().sort((a, b) => b - a));
        assert.equal((await user.list(1)).results.length, 10);
        assert.deepEqual(Array.from((await user.main())[0].results, c => c.id),
            Array.from(row.results, c => c.id), 'Cached mild scores changed the selection');
    }
    // Weak scores rejected in the weekly row remain eligible only for monthly top-up.
    const isolated = app({weekly: premieres.slice(0, 3).concat(mild), reactions: ratings,
        catalog: premieres.slice(0, 6).concat(mild)});
    const isolatedRows = await isolated.main();
    assert.equal(isolatedRows[0].results.length, 3);
    assert.equal(isolatedRows[1].results.length, 10);
    assert.equal(new Set(isolatedRows.flatMap(r => r.results.map(c => c.id))).size, 13);
    const enough = app({onlyMonth: true, reactions: ratings, catalog: mild.concat(premieres)});
    const [strong] = await enough.main();
    assert.equal(strong.results.length, 24, 'Ten became a cap for strong premieres');
    assert.ok(strong.results.every(c => c.vlas_score >= 5.6));
    assert.ok((await enough.list(2)).results.every(c => c.vlas_score >= 5.6));
    const shortFeed = app({onlyMonth: true, feed: true, reactions: ratings,
        feedCatalog: invalid.concat(premieres.slice(0, 3)),
        catalog: invalid.concat(premieres.slice(0, 3), mild)});
    const [fedThenFilled] = await shortFeed.main();
    assert.equal(fedThenFilled.results.length, 10, 'Short monthly feed did not continue with fallback search');
    assert.ok(shortFeed.requests.some(r => r.url.startsWith('discover/')),
        'Short monthly feed never requested fallback discovery pages');
    assert.ok(fedThenFilled.results.every(c => c.release_date >= '2026-01-01' &&
        c.release_date <= '2026-01-15'));
    const noCub = Array.from({length: 20}, (_, i) => movie(900 + i, '2026-01-07'));
    const scarceReactions = id => id >= 900 ? [] : ratings(id);
    const filledWithoutCub = app({onlyMonth: true, reactions: scarceReactions,
        catalog: invalid.concat(premieres.slice(0, 3), noCub)});
    const [weakFilled] = await filledWithoutCub.main();
    assert.equal(weakFilled.results.length, 3, 'Missing audience evidence must not fill the top row');
    assert.ok(weakFilled.results.slice(0, 3).every(c => c.vlas_score >= 5.6));
    assert.ok(!weakFilled.results.some(c => c.id === 306));
    // Screenshot regression: all nine reactions are negative, not an unknown rating.
    const badSamples = [
        [{type: 'shit', counter: 5}, {type: 'bore', counter: 4}],
        [{type: 'fire', counter: 14}], // high score, insufficient evidence
        [],
        [{type: 'think', counter: 30}], // neutral is not audience approval
        [{type: 'nice', counter: 15}, {type: 'bore', counter: 10}], // 40% negative
        [{type: 'nice', counter: 10}, {type: 'bore', counter: 10}, {type: 'think', counter: 10}]
    ];
    const rejected = badSamples.map((_, i) => movie(1100 + i, '2026-01-07'));
    rejected[0].title = 'After Impact';
    const qualityReactions = id => id >= 1100 && id < 1106 ? badSamples[id - 1100] : ratings(id);
    for (const feed of [false, true]) {
        const previousCache = Object.fromEntries(rejected.map(c => [String(c.id), {
            at: new Date('2026-01-15T12:00:00Z').getTime(), version: 3,
            value: {score: 0, total: 9, weak: true}
        }]));
        const user = app({onlyMonth: true, feed, reactions: qualityReactions,
            storage: new Map([['my_lampa_home_reaction_cache', previousCache]]),
            catalog: rejected.concat(premieres.slice(0, 3), mild)});
        const [row] = await user.main();
        assert.equal(row.results.length, 10);
        assert.ok(!row.results.some(c => c.id >= 1100), 'Negative or unverified premiere passed');
        assert.ok(user.reacted.includes(1100), 'Old low-signal cache was not invalidated');
        assert.ok(!(await user.list(1)).results.some(c => c.id >= 1100));
        // Put bad candidates after a full preview to exercise continuation too.
        const more = app({onlyMonth: true, feed, reactions: qualityReactions,
            catalog: premieres.slice(0, 40).concat(rejected, premieres.slice(40))});
        await more.main();
        const moreCards = (await more.list(2)).results;
        assert.equal(moreCards.length, 24);
        assert.ok(!moreCards.some(c => c.id >= 1100), 'More bypassed audience validation');
    }
    assert.equal((await app({onlyMonth: true, cubUnavailable: true}).main()).length, 0,
        'CUB failure must not be treated as audience approval');
    const tiny = app({onlyMonth: true, reactions: ratings, catalog: premieres.slice(0, 3).concat(mild.slice(0, 2))});
    assert.equal((await tiny.main())[0].results.length, 5, 'Not enough valid films must not fabricate ten');
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
