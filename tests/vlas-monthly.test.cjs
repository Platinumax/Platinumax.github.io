const assert = require('node:assert/strict');
const {app, movie} = require('./selection-harness.cjs');
const ids = row => Array.from(row.results, c => c.id);
const movies = (start, n, date) => Array.from({length:n}, (_,i)=>movie(start+i,date));
(async () => {
    // No 30-day release constraint; exactly 24 current-year films must not widen.
    for (const feed of [true, false]) {
        for (const count of [0, 5, 23, 24, 40]) {
            const catalog = movies(1000, 40, '2024-06-01').concat(movies(2000, count, '2026-01-01'));
            const user = app({feed, onlyPeriod:'month', catalog});
            const [row] = await user.main();
            assert.ok(row.title.endsWith(feed ? ' · Trakt' : ' · TMDB'));
            assert.equal(row.results.length, 24);
            assert.equal(row.results.some(c => c.release_date.startsWith('2024')), count < 24);
            const more = await user.anyList('month');
            assert.ok(more.results.every(c => c.release_date.startsWith('2026')));
        }
        const catalog = movies(100, 70, '2026-02-01').concat(movies(200, 70, '2025-01-01'), movies(300, 50, '2024-01-01'));
        const user = app({feed, onlyPeriod:'month', now:'2026-09-28T12:00:00Z', catalog});
        assert.equal((await user.main())[0].results.length, 24);
        let all = [];
        for (let p=1;p<=6;p++) all.push(...(await user.anyList('month',p)).results);
        assert.equal(all.length,140);
        assert.equal(new Set(all.map(c=>c.id)).size,140);
        assert.ok(all.every(c=>c.release_date >= '2025-01-01'));
    }
    // First four rows exclude only earlier displayed rows, even when some are disabled.
    const now = '2026-09-28T12:00:00Z';
    const catalog = movies(1000, 170, '2026-09-01');
    const user = app({now, feed:true, enabled:['week','month','halfyear','year','topcurrent'],
        weekly:catalog, catalog, feedRows:{weekly:catalog,monthly:catalog,yearly:catalog}});
    const rows = await user.all();
    assert.equal(rows.length,5);
    assert.equal(new Set(rows.slice(0,4).flatMap(ids)).size,96);
    assert.equal(rows[4].results.length,24);
    assert.ok(ids(rows[4]).some(id=>ids(rows[0]).includes(id)));
    for (let r=1;r<4;r++) {
        const more=await user.anyList(['week','month','halfyear','year'][r]);
        const previous=rows.slice(0,r).flatMap(ids);
        assert.ok(ids(more).every(id=>!previous.includes(id)));
    }
    const disabled = app({now, feed:true, enabled:['month','year'],catalog,
        feedRows:{monthly:catalog, yearly:catalog}});
    const dr=await disabled.all();
    assert.equal(new Set(dr.flatMap(ids)).size,48);
    // Release boundaries are inclusive, future releases invalid, yearly is the source.
    for (const feed of [true,false]) for (const [period, days] of [['halfyear',180],['year',365]]) {
        const date = offset => new Date(Date.parse(now)-offset*86400000).toISOString().slice(0,10);
        const sample=[movie(10,date(0)),movie(11,date(days)),movie(12,date(days+1)),movie(13,date(-1))];
        const u=app({now,feed,onlyPeriod:period,catalog:sample,leaky:true,
            feedRows:{yearly:sample, halfyear:[movie(99,'2026-09-01')]}});
        const [r]=await u.main();
        assert.deepEqual(ids(r),[10,11]);
        assert.deepEqual(ids(await u.anyList(period)),[10,11]);
        for(const req of u.requests) {
            const q=new URLSearchParams(req.url.split('?')[1]);
            assert.equal(q.getAll('primary_release_date.gte').length,1);
        }
    }
    // Top rows allow duplicates, have strict calendar bounds and a 50-film total.
    for (const feed of [true,false]) for (const period of ['topcurrent','topprevious']) {
        const sample=movies(100,80,'2026-01-01').concat(movies(200,80,'2025-06-01'), movies(300,20,'2024-06-01'));
        const u=app({feed,onlyPeriod:period,catalog:sample,feedRows:{yearly:sample}});
        const [r]=await u.main(); const full=await u.anyList(period);
        assert.ok(r.title.endsWith(feed ? ' · Trakt' : ' · TMDB'));
        assert.equal(full.title, r.title);
        assert.equal(r.results.length,24); assert.equal(full.results.length,50);
        assert.equal(full.total_pages,1);
        assert.deepEqual(ids(r),ids(full).slice(0,24));
        assert.ok(full.results.every(c=>c.release_date.startsWith(period==='topcurrent'?'2026':'2025')));
        assert.equal((await u.anyList(period,2)).results.length,0);
    }
    const scarce=app({onlyPeriod:'topcurrent',catalog:movies(1,8,'2026-01-01').concat(movies(20,60,'2025-01-01'))});
    assert.equal((await scarce.main())[0].results.length,8);
    const exact=app({onlyPeriod:'month',catalog:movies(1,24,'2026-01-01').concat(movies(50,50,'2025-01-01'))});
    assert.ok((await exact.main())[0].total_pages > 1, '24 current-year films hid previous-year More');
    // New Year invalidates both top scopes and preview filters.
    const changing=app({onlyPeriod:'topcurrent',catalog:movies(1,50,'2026-01-01').concat(movies(60,8,'2027-01-01'))});
    await changing.main(); changing.setDate('2027-01-02T12:00:00Z');
    assert.equal((await changing.anyList('topcurrent')).results.length,8);
    // CUB quality and mixed sorting retained; missing reactions cannot fill monthly.
    const quality=app({onlyPeriod:'month',catalog:movies(1,6,'2026-01-01'),
        reactions:id=> id===1 ? [{type:'nice',counter:50}] : id===2 ? [{type:'fire',counter:50}] : id===3 ? [] : [{type:'shit',counter:50}]});
    const [qr]=await quality.main(); assert.deepEqual(ids(qr),[2,1]);
    assert.equal((await app({onlyMonth:true,cubUnavailable:true}).main()).length,0);
    // A short but working feed does not silently switch to TMDB.
    const short=app({feed:true,onlyPeriod:'month',feedCatalog:movies(1,3,'2026-01-01'),catalog:movies(100,100,'2026-01-01')});
    assert.equal((await short.main())[0].results.length,3);
    assert.equal(short.requests.length,0);
    // Existing discovery rows retain their filters, More is one full 50-film page.
    const old=app({now,onlyPeriod:'comedy',catalog:movies(1,90,'2026-01-01').map(c=>({...c,genre_ids:[35]}))});
    const [oldRow] = await old.main();
    assert.equal(oldRow.results.length,24);
    assert.ok(oldRow.title.endsWith(' · TMDB'));
    assert.equal((await old.anyList('comedy')).results.length,50);
    const fresh=app({now,enabled:['week','fresh'],weekly:catalog,catalog});
    const fr=await fresh.all();
    assert.ok(ids(fr[1]).some(id=>ids(fr[0]).includes(id)));
    // A year constraint is not widened when current-year quality meets the threshold.
    const filtered=app({onlyPeriod:'month',catalog:movies(1,30,'2026-01-01').concat(movies(40,40,'2025-01-01')),
        reactions:id=>[{type:id<=10?'shit':'fire',counter:50}]});
    assert.ok((await filtered.main())[0].results.some(c=>c.release_date.startsWith('2025')));
    console.log('Agreed selection: year fallback, deduplication, dates, yearly tops, More and CUB: OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
