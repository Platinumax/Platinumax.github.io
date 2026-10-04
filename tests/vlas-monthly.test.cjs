const assert = require('node:assert/strict');
const {app, movie} = require('./selection-harness.cjs');
const ids = row => Array.from(row.results, c => c.id);
const movies = (start, n, date) => Array.from({length:n}, (_,i)=>movie(start+i,date));
(async () => {
    // Month is a strict rolling 30-day release window in both the row and More.
    {
        const now = '2026-09-28T12:00:00Z';
        const date = offset => new Date(Date.parse(now)-offset*86400000).toISOString().slice(0,10);
        for (const feed of [true, false]) {
            const sample = movies(1000,40,date(0)).concat(
                movies(1100,40,date(30)), movies(1200,40,date(31)), movies(1300,10,date(-1)));
            const user = app({feed, onlyPeriod:'month', now, catalog:sample,
                feedRows:{monthly:sample}});
            const [row] = await user.main();
            assert.equal(row.results.length,24);
            assert.ok(row.results.every(c=>c.release_date>=date(30) && c.release_date<=date(0)));
            const full = await user.anyList('month');
            assert.equal(full.results.length,80);
            assert.ok(full.results.every(c=>c.release_date>=date(30) && c.release_date<=date(0)));
        }
    }
    // The first four rows own their films across both the home preview and «Ещё».
    {
        const now = '2026-09-28T12:00:00Z';
        const recent = movies(1000,170,'2026-09-25');
        const oldHalf = movies(2000,170,'2026-01-15');
        const user = app({now, feed:true, enabled:['week','month','halfyear','year','topcurrent'],
            weekly:recent, catalog:recent.concat(oldHalf),
            feedRows:{weekly:recent,monthly:recent,yearly:recent.concat(oldHalf)}});
        const rows = await user.all();
        assert.equal(rows.length,5);
        assert.equal(new Set(rows.slice(0,4).flatMap(ids)).size,96);
        assert.equal(rows[4].results.length,24);
        assert.ok(ids(rows[4]).some(id=>ids(rows[0]).includes(id)));

        const fullWeek = await user.anyList('week');
        const fullMonth = await user.anyList('month');
        const fullHalf = await user.anyList('halfyear');
        const fullYear = await user.anyList('year');
        const exclusive = [fullWeek, fullMonth, fullHalf, fullYear].map(ids);
        for (let a=0;a<exclusive.length;a++) for (let b=a+1;b<exclusive.length;b++)
            assert.ok(exclusive[a].every(id=>!exclusive[b].includes(id)),
                'More lists of exclusive rows overlap');

        const disabled = app({now, feed:true, enabled:['month','year'],
            catalog:recent.concat(oldHalf),
            feedRows:{monthly:recent, yearly:oldHalf}});
        const dr=await disabled.all();
        assert.equal(new Set(dr.flatMap(ids)).size,48);
    }
    // Release boundaries are inclusive; future releases and adjacent windows are rejected.
    {
        const now = '2026-09-28T12:00:00Z';
        const date = offset => new Date(Date.parse(now)-offset*86400000).toISOString().slice(0,10);
        const cases = [
            ['week', [movie(10,date(0)),movie(11,date(7)),movie(12,date(8)),movie(13,date(-1))], [10,11]],
            ['month',[movie(20,date(0)),movie(21,date(30)),movie(22,date(31)),movie(23,date(-1))],[20,21]],
            ['halfyear',[movie(30,date(0)),movie(31,date(180)),movie(32,date(181)),movie(33,date(-1))],[30,31]],
            ['year',[movie(40,date(180)),movie(41,date(181)),movie(42,date(365)),movie(43,date(366))],[41,42]]
        ];
        for (const feed of [true,false]) for (const [period,sample,expected] of cases) {
            const feedRows = period==='week' ? {weekly:sample} :
                period==='month' ? {monthly:sample} : {yearly:sample};
            const u=app({now,feed,onlyPeriod:period,catalog:sample,weekly:sample,leaky:true,feedRows});
            const [r]=await u.main();
            assert.deepEqual(ids(r),expected,period);
            assert.deepEqual(ids(await u.anyList(period)),expected,period+' More');
        }
    }
    // Top rows allow duplicates, have strict calendar bounds and a 100-film total.
    for (const feed of [true,false]) for (const period of ['topcurrent','topprevious']) {
        const sample=movies(1000,130,'2026-01-01').concat(movies(2000,130,'2025-06-01'), movies(3000,20,'2024-06-01'));
        const u=app({feed,onlyPeriod:period,catalog:sample,feedRows:{yearly:sample}});
        const [r]=await u.main(); const full=await u.anyList(period);
        assert.ok(r.title.endsWith(feed ? ' · Trakt' : ' · TMDB'));
        assert.equal(full.title, r.title);
        assert.equal(r.results.length,24); assert.equal(full.results.length,100);
        assert.equal(full.total_pages,1);
        assert.deepEqual(ids(r),ids(full).slice(0,24));
        assert.ok(full.results.every(c=>c.release_date.startsWith(period==='topcurrent'?'2026':'2025')));
        assert.equal((await u.anyList(period,2)).results.length,0);
    }
    const scarce=app({onlyPeriod:'topcurrent',catalog:movies(1,8,'2026-01-01').concat(movies(20,60,'2025-01-01'))});
    assert.equal((await scarce.main())[0].results.length,8);
    const exact=app({onlyPeriod:'month',catalog:movies(1,24,'2026-01-01').concat(movies(50,50,'2025-01-01'))});
    assert.equal((await exact.main())[0].total_pages,1, 'Month widened beyond its 30-day release window');
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
    // Fewer eligible movies stay fewer: never pad a 90-film list to 100.
    const old=app({now,onlyPeriod:'comedy',catalog:movies(1,90,'2026-01-01').map(c=>({...c,genre_ids:[35]}))});
    const [oldRow] = await old.main();
    assert.equal(oldRow.results.length,24);
    assert.ok(oldRow.title.endsWith(' · TMDB'));
    assert.equal((await old.anyList('comedy')).results.length,90);
    // All thirteen rows expose one capped full list without changing their filters.
    for (const period of ['week','month','halfyear','year','topcurrent','topprevious',
        'fresh','best','comedy','thriller','scifi','gems','classics']) {
        const date = period === 'week' ? '2026-09-25' : period === 'month' ? '2026-09-10' :
            period === 'halfyear' ? '2026-06-01' : period === 'year' ? '2026-01-15' :
            period === 'topprevious' ? '2025-06-01' : period === 'best' ? '2020-06-01' :
            period === 'classics' ? '1990-06-01' : '2026-09-01';
        const genre = period === 'comedy' ? 35 : period === 'thriller' ? 53 : period === 'scifi' ? 878 : 18;
        const sample = movies(4000,250,date).map(c=>({...c,genre_ids:[genre]}));
        const u = app({now,onlyPeriod:period,feed:true,weekly:sample,catalog:sample,
            feedRows:{weekly:sample,monthly:sample,yearly:sample}});
        const [preview] = await u.main();
        const full = await u.anyList(period);
        assert.equal(preview.results.length,24, period);
        assert.ok(preview.total_pages > 1, period + ' More button missing');
        assert.equal(full.results.length,100, period);
        assert.equal(full.total_pages,1, period);
        assert.equal(new Set(ids(full)).size,100, period);
    }
    const fresh=app({now,enabled:['week','fresh'],weekly:catalog,catalog});
    const fr=await fresh.all();
    assert.ok(ids(fr[1]).some(id=>ids(fr[0]).includes(id)));
    // A release window is never widened to fill the row.
    const filtered=app({onlyPeriod:'month',catalog:movies(1,30,'2026-01-01').concat(movies(40,40,'2025-01-01')),
        reactions:id=>[{type:id<=10?'shit':'fire',counter:50}]});
    assert.ok((await filtered.main())[0].results.every(c=>c.release_date.startsWith('2026')));
    console.log('Agreed selection: year fallback, deduplication, dates, yearly tops, More and CUB: OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
