const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(process.env.VLAS_TEST_CODE || path.join(__dirname, '..', 'vlas.js'), 'utf8');
function movie(id, date, genre = 18) {
    return {id, title: `Film ${id}`, poster_path: '/p.jpg', release_date: date,
        genre_ids: [genre], vote_average: 10, popularity: 1000 - id,
        original_language: 'en', origin_country: ['US']};
}
const weekly = Array.from({length: 24}, (_, i) => movie(i + 1, '2026-01-10'));
const premieres = Array.from({length: 100}, (_, i) => movie(i + 100, '2026-01-05'));
const invalid = [movie(300, '2025-05-01'), movie(301, '2025-12-15'),
    movie(302, '2026-01-16'), movie(303, ''), movie(304, '2024-01-05'),
    movie(305, '2026-01-05', 27), movie(306, '2026-01-05'), movie(307, '2026-01-05')];
const boundaries = [movie(308, '2025-12-16'), movie(309, '2026-01-15')];
function app(options = {}) {
    let now = options.now || '2026-01-15T12:00:00Z';
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return new Clock().getTime(); }
    }
    const requests = [], reacted = [];
    const storage = options.storage || new Map();
    const rowIds = ['personal','week','month','twomonth','halfyear','year','topcurrent',
        'topprevious','fresh','best','comedy','thriller','scifi','gems','classics'];
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
                const country = q.get('with_origin_country'), language = q.get('with_original_language');
                selected = selected.filter(c => (!from || c.release_date >= from) &&
                    (!to || c.release_date <= to) &&
                    (!country || !c.origin_country || c.origin_country.includes(country)) &&
                    (!language || !c.original_language || c.original_language === language));
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
                rows: options.feedRows || {weekly: weekCatalog, monthly: options.feedCatalog || catalog}});
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
            if (key === 'my_lampa_home_personal')
                return options.personal === true || options.onlyPeriod === 'personal';
            if (options.enabled && rowIds.some(id => key === 'my_lampa_home_' + id))
                return options.enabled.includes(key.slice('my_lampa_home_'.length));
            if (options.onlyPeriod && rowIds.some(id => key === 'my_lampa_home_' + id))
                return key === 'my_lampa_home_' + options.onlyPeriod;
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
    return {requests, reacted, storage,
        anyList: (id, page = 1) => new Promise(resolve => tmdb.list({url: 'vlas/' + id, page}, resolve, () => resolve({results: []}))),
        all: async () => {
            let next;
            const first = await new Promise(resolve => { next = tmdb.main({}, resolve, () => resolve([])); });
            let rows = first, chunk;
            while ((chunk = await new Promise(resolve => next(resolve, () => resolve([])))).length) rows = rows.concat(chunk);
            return rows;
        }, setDate(date) { now = date; },
        weekList: page => new Promise(resolve => tmdb.list({url: 'vlas/week', page}, resolve, () => resolve({results: []}))),
        main: () => new Promise(resolve => tmdb.main({}, resolve, () => resolve([]))),
        list: page => new Promise(resolve => tmdb.list({url: 'vlas/month', page},
            resolve, () => resolve({results: []})))};
}

module.exports = {app, movie};

