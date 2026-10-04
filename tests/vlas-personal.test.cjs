const assert = require('node:assert/strict');
const {app, movie} = require('./selection-harness.cjs');
const KEY = 'my_lampa_home_';
const ids = row => Array.from(row.results, c => c.id);
const date = (now, days) => new Date(Date.parse(now) - days * 86400000).toISOString().slice(0, 10);

(async () => {
    const now = '2026-10-04T12:00:00Z';

    {
        const sample = Array.from({length:80}, (_,i)=>movie(100+i, date(now, i % 20)));
        const user = app({now, personal:true, enabled:['week'], weekly:sample, catalog:sample});
        const rows = await user.all();
        assert.equal(rows[0].title, 'Моя подборка');
        const week = rows.find(r=>r.url==='vlas/week');
        assert.ok(week);
        assert.ok(ids(rows[0]).some(id => ids(week).includes(id)),
            'Personal row unexpectedly participated in standard deduplication');
    }

    {
        const storage = new Map([
            [KEY+'personal_period','10y'],
            [KEY+'personal_date_from','2024-03-01'],
            [KEY+'personal_date_to','2025-06-30'],
            [KEY+'personal_year_from','2025'],
            [KEY+'personal_year_to','2025']
        ]);
        const sample=[movie(1,'2024-05-01'),movie(2,'2025-02-01'),
            movie(3,'2025-07-01'),movie(4,'2026-01-01')];
        const user=app({now,onlyPeriod:'personal',storage,catalog:sample});
        assert.deepEqual(ids((await user.main())[0]),[2]);
    }

    {
        const storage=new Map([[KEY+'personal_period','31_60']]);
        const sample=[movie(10,date(now,30)),movie(11,date(now,31)),
            movie(12,date(now,60)),movie(13,date(now,61))];
        const user=app({now,onlyPeriod:'personal',storage,catalog:sample,leaky:true});
        assert.deepEqual(ids((await user.main())[0]),[11,12]);
    }

    {
        const storage=new Map([
            [KEY+'personal_genre_878','include'],
            [KEY+'personal_genre_27','exclude'],
            [KEY+'genre_878','exclude']
        ]);
        const sample=[
            {...movie(20,'2026-09-01',878),genre_ids:[878]},
            {...movie(21,'2026-09-01',878),genre_ids:[878,27]},
            {...movie(22,'2026-09-01',35),genre_ids:[35]}
        ];
        const user=app({now,onlyPeriod:'personal',storage,catalog:sample});
        assert.deepEqual(ids((await user.main())[0]),[20]);
    }

    {
        const storage=new Map([
            [KEY+'personal_cub_min','7'],
            [KEY+'personal_reactions_min','100']
        ]);
        const sample=[movie(30,'2026-09-01'),movie(31,'2026-09-01')];
        const user=app({now,onlyPeriod:'personal',storage,catalog:sample,
            reactions:id=> id===30 ? [{type:'fire',counter:100}] : [{type:'fire',counter:20}]});
        assert.deepEqual(ids((await user.main())[0]),[30]);
    }

    {
        const storage=new Map([
            [KEY+'personal_country','KR'],
            [KEY+'personal_language','ko']
        ]);
        const sample=[
            {...movie(40,'2026-09-01'),origin_country:['KR'],original_language:'ko'},
            {...movie(41,'2026-09-01'),origin_country:['US'],original_language:'en'}
        ];
        const user=app({now,onlyPeriod:'personal',storage,catalog:sample});
        assert.deepEqual(ids((await user.main())[0]),[40]);
        assert.ok(user.requests.some(r=>r.url.includes('with_origin_country=KR')));
        assert.ok(user.requests.some(r=>r.url.includes('with_original_language=ko')));
    }

    {
        const sample=Array.from({length:150},(_,i)=>movie(1000+i,'2026-09-01'));
        const user=app({now,onlyPeriod:'personal',catalog:sample});
        const preview=(await user.main())[0];
        assert.equal(preview.results.length,24);
        const collected=[];
        for(let page=1;page<=6;page++){
            const full=await user.anyList('personal',page);
            collected.push(...ids(full));
        }
        assert.ok(collected.length>100);
        assert.equal(new Set(collected).size,collected.length);
    }

    {
        const base=[movie(2000,'2026-07-01'),movie(2001,'2026-09-01'),movie(2002,'2026-08-01')];
        const byReactions=new Map([[KEY+'personal_sort','reactions']]);
        let user=app({now,onlyPeriod:'personal',storage:byReactions,catalog:base,
            reactions:id=>[{type:'fire',counter:id===2000?200:id===2001?50:100}]});
        assert.deepEqual(ids((await user.main())[0]),[2000,2002,2001]);

        const newest=new Map([[KEY+'personal_sort','new']]);
        user=app({now,onlyPeriod:'personal',storage:newest,catalog:base});
        assert.deepEqual(ids((await user.main())[0]),[2001,2002,2000]);
    }

    console.log('Personal row: filters, dates, years, CUB, country/language, sorting and paged More: OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
