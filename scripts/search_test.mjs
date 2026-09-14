// Synthetic loopback fixtures only. Never send search/mutation tests to production.
import assert from 'node:assert/strict';
import {randomBytes, createHash} from 'node:crypto';
import {request} from 'node:http';
import fs from 'node:fs';
const base = new URL(process.env.BASE_URL), database = new URL(process.env.TEST_DB_URL);
for (const target of [base, database]) {
    assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.protocol, 'http:');
    assert.ok(target.port && !['9000','8010'].includes(target.port));
}
const run = randomBytes(6).toString('hex'), id = (table,name) => `${table}:find_${run}_${name}`;
const hash = text => createHash('sha256').update(text).digest('hex');
async function sql(body) {
    const response = await fetch(new URL('/sql',database), {method:'POST', headers:{Authorization:`Basic ${Buffer.from('itroot:itpass').toString('base64')}`,Accept:'application/json','surreal-ns':'taskmanager_it','surreal-db':'main'},body});
    assert.equal(response.status,200); const results = await response.json();
    for (const result of results) assert.equal(result.status,'OK',result.result);
    return results.at(-1).result;
}
const people = {};
for (const name of ['owner','viewer','outside','limited','browser']) {
    const p = people[name] = {id:id('users',name),token:randomBytes(32).toString('hex'),csrf:randomBytes(32).toString('hex')};
    await sql(`CREATE ${p.id} SET name='${name}', email='find-${name}-${run}@example.invalid', password_hash='reset-required', email_verified=true;
        CREATE sessions SET user_id=${p.id}, token='${hash(p.token)}', csrf_hash='${hash(p.csrf)}', expires_at=time::now()+1h;`);
}
const {owner,viewer,outside,limited,browser:browserUser} = people;
const workspace = id('workspaces','primary'), other = id('workspaces','other');
await sql(`CREATE ${workspace} SET name='Search fixture', owner_id=${owner.id}; CREATE ${other} SET name='Other search space', owner_id=${owner.id};
    CREATE workspace_members SET workspace_id=${other}, user_id=${owner.id}, role='owner';
    CREATE workspace_members SET workspace_id=${other}, user_id=${browserUser.id}, role='member';`);
for (const person of [owner,viewer,browserUser]) await sql(`CREATE workspace_members SET workspace_id=${workspace}, user_id=${person.id}, role='${person === owner ? 'owner' : 'viewer'}';`);
const fixture = [];
const total = 207;
for (let i=0;i<total;i++) {
    fixture.push({id:id('tasks',`row${String(i).padStart(4,'0')}`),title:i === 0 ? '<img src=x onerror=alert(1)> Ședință' : `Common ${String(i%13).padStart(2,'0')}`,
        notes:i === 206 ? 'hidden needle beyond first page' : 'Common notes', tags:[i%2 ? 'Team' : 'team'],
        completed:i%3===0, status:['done','todo','doing'][i%3], priority:['high','normal','low'][i%3],
        created_at:`2025-01-${String(1+i%9).padStart(2,'0')}T00:00:00Z`, due_date:i%4 ? `2025-03-${String(1+i%7).padStart(2,'0')}T00:00:00Z` : null,
        assignee_id:i%5 === 0 ? owner.id : null, parent_id:i === 206 ? id('tasks','row0001') : null});
}
for (let begin=0;begin<total;begin+=100) await sql('BEGIN TRANSACTION;'+fixture.slice(begin,begin+100).map(t=>
    `CREATE ${t.id} SET user_id=${owner.id}, workspace_id=${workspace}, title=${JSON.stringify(t.title)}, notes=${JSON.stringify(t.notes)}, tags=${JSON.stringify(t.tags)}, completed=${t.completed}, status='${t.status}', priority='${t.priority}', created_at=d'${t.created_at}', due_date=${t.due_date ? `d'${t.due_date}'` : 'NONE'}, assignee_id=${t.assignee_id || 'NONE'}, parent_id=${t.parent_id || 'NONE'};`).join('')+'COMMIT TRANSACTION;');
const legacy = id('tasks','legacy'), foreign = id('tasks','foreign'), trash = id('tasks','trash'), otherTask = id('tasks','other');
await sql(`CREATE ${legacy} SET user_id=${owner.id}, title='Owned legacy'; CREATE ${foreign} SET user_id=${outside.id}, title='Foreign legacy';
    CREATE ${trash} SET user_id=${owner.id}, workspace_id=${workspace}, title='Private trash', deleted_at=time::unix(), delete_batch='${'a'.repeat(64)}';
    CREATE ${otherTask} SET user_id=${owner.id}, workspace_id=${other}, title='Other task';`);
const latencies=[];
function api(person, body={}, path='/api/tasks/search', method='POST', csrf=true) {
    const start=performance.now();
    return new Promise((resolve,reject)=>{
        const req=request(new URL(path,base),{method,localAddress:'127.0.0.7',timeout:15000,headers:{'Content-Type':'application/json',Origin:base.origin,...(person ? {Cookie:`session_token=${person.token}`, ...(csrf ? {'X-CSRF-Token':person.csrf} : {})} : {})}},res=>{
            const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
            res.on('end',()=>{try {latencies.push(performance.now()-start);resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks))});}catch(e){reject(e);}});
        }); req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Search fixture timeout')));
        req.end(method === 'GET' ? undefined : JSON.stringify(body));
    });
}
let passed=0;
async function check(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
const scoped={workspace_id:workspace};
async function walk(person,query) {
    let cursor=null,asOf=null;const items=[],seen=new Set();
    do {
        const r=await api(person,{...query,cursor});assert.equal(r.status,200,JSON.stringify(r.data));
        assert.ok(r.data.items.length <= (query.limit || 50));
        if (asOf !== null) assert.equal(r.data.as_of,asOf);asOf=r.data.as_of;
        for(const item of r.data.items){assert.ok(!seen.has(item.id),'no duplicate on stable traversal');seen.add(item.id);items.push(item);}
        cursor=r.data.next_cursor;assert.ok(seen.size<=total+10);
    } while(cursor);
    return items;
}
await check('read-only search requires auth and CSRF, rejects GET and checks workspace scope',async()=>{
    assert.equal((await api(null,scoped)).status,401);
    assert.equal((await api(owner,scoped,'/api/tasks/search','POST',false)).status,403);
    const method=await api(owner,{},'/api/tasks/search','GET');assert.equal(method.status,405);assert.equal(method.headers.allow,'POST');
    assert.equal((await api(outside,scoped)).status,403);
    const allowed=await api(viewer,{...scoped,limit:1});assert.equal(allowed.status,200);assert.equal(allowed.headers['cache-control'],'no-store');
});
await check('five keyset sorts traverse tied values, all children and null dates exactly once',async()=>{
    for (const sort of ['created_desc','created_asc','due_asc','priority','title']) {
        const items=await walk(viewer,{...scoped,sort,limit:100});
        const key=t=>sort==='created_desc' ? -Date.parse(t.created_at) : sort==='created_asc' ? Date.parse(t.created_at) : sort==='due_asc' ? (t.due_date ? Date.parse(t.due_date) : Number.MAX_SAFE_INTEGER) : sort==='priority' ? ({high:0,normal:1,low:2}[t.priority]) : t.title.toLowerCase();
        const expected=[...fixture].sort((a,b)=>key(a)<key(b) ? -1 : key(a)>key(b) ? 1 : a.id<b.id ? -1 : 1);
        assert.deepEqual(items.map(t=>t.id),expected.map(t=>t.id),sort);
        assert.ok(items.every(t=>Number.isSafeInteger(t.version)));
    }
});
await check('substring search covers notes, tags, Romanian case and literal injection text',async()=>{
    for (const [q,expected] of [['hidden NEEDLE',[fixture[206].id]],['ședință',[fixture[0].id]],["'; DELETE tasks; --",[]]]) {
        const result=await walk(viewer,{...scoped,q});assert.deepEqual(result.map(t=>t.id),expected);
    }
    const tags=await walk(viewer,{...scoped,q:'TEAM',limit:100});assert.equal(tags.length,total);
    assert.equal((await api(viewer,{...scoped,q:'hidden needle',tag:'Team'})).data.items.length,0);
    assert.equal((await api(viewer,{...scoped,q:'hidden needle',tag:'team'})).data.items[0].id,fixture[206].id);
});
await check('combined status, priority, assignment and exclusive due windows match exact predicates',async()=>{
    const cases=[
        [{status:'active',priority:'high'},t=>!t.completed&&t.priority==='high'],
        [{status:'doing',tag:'Team'},t=>t.status==='doing'&&t.tags.includes('Team')],
        [{assignee:'me'},t=>t.assignee_id===owner.id],
        [{assignee:'unassigned',due:'none'},t=>!t.assignee_id&&!t.due_date],
        [{due:'overdue'},t=>!t.completed&&!!t.due_date],
        [{due:'range',due_from:Date.parse('2025-03-02T00:00:00Z'),due_before:Date.parse('2025-03-03T00:00:00Z')},t=>t.due_date==='2025-03-02T00:00:00Z'],
    ];
    for(const [query,predicate] of cases){const items=await walk(owner,{...scoped,...query,q:'common',limit:100});assert.deepEqual(items.map(t=>t.id).sort(),fixture.filter(t=>predicate(t)).map(t=>t.id).sort());}
});
await check('all-workspace search includes owned legacy but never foreign rows or trash',async()=>{
    const items=await walk(owner,{limit:100});const ids=new Set(items.map(t=>t.id));
    assert.equal(ids.size,total+2);assert.ok(ids.has(legacy)&&ids.has(otherTask));assert.ok(!ids.has(foreign)&&!ids.has(trash));
    assert.deepEqual((await walk(outside,{})).map(t=>t.id),[foreign]);
});
await check('bad enums, bounds, record types, controls, date ranges and tokens fail closed',async()=>{
    for (const input of [{limit:0},{limit:101},{limit:-1},{q:'x'.repeat(501)},{q:'line\nline'},{tag:'t'.repeat(129)},{workspace_id:'users:wrong'},
        {status:'bogus'},{priority:'bogus'},{assignee:'users:other'},{sort:'title;DELETE users'},{due:'range'},{due_from:1},{due:'range',due_from:2,due_before:1},{cursor:'not!base64'},{cursor:'a'.repeat(8193)}])
        assert.equal((await api(owner,{...scoped,...input})).status,400,JSON.stringify(input));
});
await check('cursor binding rejects changed filters/sort/limit/actor while removed cursor rows remain traversable',async()=>{
    const first=await api(owner,{...scoped,limit:2,sort:'title'});assert.equal(first.status,200);
    const cursor=first.data.next_cursor;
    for(const change of [{q:'new'},{sort:'priority'},{limit:3},{workspace_id:other}]) assert.equal((await api(owner,{...scoped,limit:2,sort:'title',cursor,...change})).status,400);
    assert.equal((await api(outside,{...scoped,limit:2,sort:'title',cursor})).status,400);
    const removed=first.data.items.at(-1).id;
    await sql(`UPDATE ${removed} SET deleted_at=time::unix();`);
    const next=await api(owner,{...scoped,limit:2,sort:'title',cursor});assert.equal(next.status,200);assert.ok(next.data.items.every(t=>t.id!==removed));
    await sql(`UPDATE ${removed} SET deleted_at=NONE;`);
});
await check('creation cutoff and current membership are checked on each search page',async()=>{
    const first=await api(viewer,{...scoped,limit:2});
    const later=id('tasks','later');await sql(`CREATE ${later} SET user_id=${owner.id},workspace_id=${workspace},title='Later insert';`);
    const second=await api(viewer,{...scoped,limit:2,cursor:first.data.next_cursor});assert.equal(second.status,200);assert.ok(second.data.items.every(t=>t.id!==later));
    await sql(`DELETE workspace_members WHERE user_id=${viewer.id} AND workspace_id=${workspace};`);
    assert.equal((await api(viewer,{...scoped,limit:2,cursor:first.data.next_cursor})).status,403);
    await sql(`DELETE ${later}; CREATE workspace_members SET user_id=${viewer.id},workspace_id=${workspace},role='viewer';`);
});
await check('per-user search budget fails with retry guidance without consuming task-write quota',async()=>{
    for(let i=0;i<120;i++) assert.equal((await api(limited,{})).status,200);
    const denied=await api(limited,{});assert.equal(denied.status,429);assert.equal(denied.headers['retry-after'],'60');
    assert.equal((await api(limited,{title:'Search limit is separate'},'/api/tasks')).status,201);
});

if(process.env.RUN_UI==='1') {
    const {chromium}=await import('playwright-core');
    let executablePath=process.env.CHROME_PATH;
    for(const root of [`${process.env.HOME}/.cache/ms-playwright`,'/ms-playwright']) if(!executablePath&&fs.existsSync(root)) for(const dir of fs.readdirSync(root)) for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']) {const p=`${root}/${dir}/${rel}`;if(fs.existsSync(p))executablePath=p;}
    const browser=await chromium.launch({executablePath,args:['--no-sandbox']});
    try {
        const context=await browser.newContext({viewport:{width:320,height:900},isMobile:true,hasTouch:true,timezoneId:'Europe/Bucharest'});
        await context.addCookies([{name:'session_token',value:browserUser.token,url:base.origin,httpOnly:true},{name:'csrf_token',value:browserUser.csrf,url:base.origin}]);
        const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
        await page.addInitScript(ws=>localStorage.setItem('workspaceId',ws),other);
        await page.goto(base.origin,{waitUntil:'networkidle'});
        await page.waitForFunction(()=>state.user&&!state.loading&&state.tasks.length===1);
        const search=async q=>{await page.fill('#remoteSearchText',q);await page.click('#taskSearchSubmit');await page.waitForFunction(()=>!taskSearch.abort);};
        await check('global search finds a subtask outside the loaded workspace without replacing its list',async()=>{
            await page.click('#openTaskSearch');await search('hidden needle');
            assert.equal(await page.locator('#taskSearchResults li').count(),1);
            assert.match(await page.locator('#taskSearchResults').textContent(),/Subtask/);
            assert.equal(await page.evaluate(()=>state.tasks.length),1);
            assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        });
        await check('current preview is read-only and opening a subtask locates its workspace and parent',async()=>{
            await page.getByRole('button',{name:'View current details',exact:true}).click();
            await page.waitForFunction(()=>taskSearch.preview!==null);
            assert.match(await page.locator('#taskSearchPreviewText').textContent(),/hidden needle/);
            await page.evaluate(()=>taskDrafts.set('synthetic-unsaved',{dirty:true}));
            page.once('dialog',dialog=>dialog.dismiss());
            await page.click('#taskSearchReveal');
            assert.equal(await page.evaluate(()=>state.currentWorkspaceId),other);
            assert.ok(await page.locator('#taskSearchModal').isVisible());
            await page.evaluate(()=>taskDrafts.clear());
            await page.click('#taskSearchReveal');
            await page.waitForFunction(ws=>state.currentWorkspaceId===ws&&!state.loading&&document.getElementById('taskSearchModal').hidden,workspace);
            await page.waitForFunction(task=>mainView.focus && mainView.child && !mainView.child.busy && state.tasks.some(t=>t.id===task),fixture[206].id);
            assert.ok(await page.evaluate(task=>document.activeElement.querySelector('[data-act="toggle"]')?.dataset.id===task,fixture[206].id));
        });
        await check('one bounded page, previous/next and title sort are keyboard/mobile safe',async()=>{
            await page.click('#openTaskSearch');await page.selectOption('#remoteSearchWorkspace',workspace);await search('common');
            assert.equal(await page.locator('#taskSearchResults li').count(),50);
            const first=await page.locator('#taskSearchResults').textContent();
            await page.click('#taskSearchNext');await page.waitForFunction(()=>!taskSearch.abort);assert.match(await page.locator('#taskSearchStatus').textContent(),/Page 2/);
            assert.equal(await page.evaluate(()=>document.activeElement.id),'taskSearchStatus');
            await page.click('#taskSearchPrevious');await page.waitForFunction(()=>!taskSearch.abort);assert.equal(await page.locator('#taskSearchResults').textContent(),first);
            await page.selectOption('#remoteSearchSort','title');assert.equal(await page.locator('#taskSearchResults li').count(),0);assert.ok(await page.locator('#taskSearchNext').isDisabled());
        });
        await check('hostile text previews are escaped and private queries/results never enter URL or browser storage',async()=>{
            await search('ȘEDINȚĂ');await page.getByRole('button',{name:'View current details',exact:true}).click();await page.waitForFunction(()=>taskSearch.preview!==null);
            assert.match(await page.locator('#taskSearchPreviewText').textContent(),/<img/);assert.equal(await page.locator('#taskSearchModal img').count(),0);
            assert.ok(!page.url().includes('EDIN'));assert.ok(await page.evaluate(()=>![...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>value.includes('ȘEDINȚĂ')||value.includes('onerror=alert'))));
            assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        });
        await check('local calendar date filters handle the 25-hour daylight-saving day',async()=>{
            await page.selectOption('#remoteSearchDue','range');await page.fill('#remoteSearchFrom','2026-10-25');await page.fill('#remoteSearchThrough','2026-10-25');
            assert.equal(await page.evaluate(()=>{const q=taskSearchFilters();return q.due_before-q.due_from;}),25*3600000);
            await page.selectOption('#remoteSearchDue','any');
        });
        await check('failed continuation clears old results and explicit search retries from the first page',async()=>{
            await search('common');
            await page.route('**/api/tasks/search',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic search outage"}'}));
            await page.click('#taskSearchNext');await page.waitForFunction(()=>!taskSearch.abort);
            assert.equal(await page.locator('#taskSearchResults li').count(),0);assert.match(await page.locator('#taskSearchStatus').textContent(),/Synthetic search outage/);
            await page.unroute('**/api/tasks/search');await page.click('#taskSearchSubmit');await page.waitForFunction(()=>!taskSearch.abort);
            assert.equal(await page.locator('#taskSearchResults li').count(),50);assert.match(await page.locator('#taskSearchStatus').textContent(),/Page 1/);
        });
        await check('cancel, changed filters and closed modal discard late responses',async()=>{
            for(const action of ['cancel','filters','close']) assert.ok(await page.evaluate(async action=>{
                if(document.getElementById('taskSearchModal').hidden)openTaskSearch();
                const original=window.fetch;let finish;window.fetch=()=>new Promise(resolve=>{finish=resolve;});
                try {
                    const pending=loadTaskSearch(0,true);
                    if(action==='cancel')document.getElementById('taskSearchCancel').click();
                    if(action==='filters'){document.getElementById('remoteSearchText').value='new';document.getElementById('remoteSearchText').dispatchEvent(new Event('input',{bubbles:true}));}
                    if(action==='close')hideModal('taskSearchModal');
                    finish(new Response(JSON.stringify({items:[{id:'tasks:late',title:'Private late result'}],as_of:Date.now(),next_cursor:null}),{headers:{'Content-Type':'application/json'}}));await pending;
                    return document.getElementById('taskSearchResults').children.length===0&&!taskSearch.abort;
                } finally{window.fetch=original;}
            },action));
        });
        await check('task removed before preview clears stale results and cannot be opened',async()=>{
            await page.click('#openTaskSearch');await search('hidden needle');
            await page.route('**/api/tasks/tasks*',route=>route.fulfill({status:404,contentType:'application/json',body:'{"error":"Task unavailable"}'}));
            await page.getByRole('button',{name:'View current details',exact:true}).click();
            await page.waitForFunction(()=>!taskSearch.abort);
            assert.equal(await page.locator('#taskSearchResults li').count(),0);
            assert.ok(await page.locator('#taskSearchPreview').isHidden());
            assert.match(await page.locator('#taskSearchStatus').textContent(),/Task unavailable/);
            await page.unroute('**/api/tasks/tasks*');
        });
        await check('logout clears search terms, preview and tokens and prevents late private publication',async()=>{
            assert.ok(await page.evaluate(async()=>{
                openTaskSearch();document.getElementById('remoteSearchText').value='private phrase';
                const original=window.fetch;let finish;window.fetch=()=>new Promise(resolve=>{finish=resolve;});
                try {const pending=loadTaskSearch(0,true);showLoggedOut();finish(new Response(JSON.stringify({items:[{id:'tasks:late',title:'Private'}],as_of:Date.now(),next_cursor:null}),{headers:{'Content-Type':'application/json'}}));await pending;
                    return !state.user&&!taskSearch.query&&!taskSearch.preview&&document.getElementById('taskSearchModal').hidden&&!document.getElementById('remoteSearchText').value&&!document.getElementById('taskSearchResults').children.length&&document.getElementById('remoteSearchWorkspace').options.length===1;
                }finally{window.fetch=original;}
            }));
        });
        await check('search browser has no uncaught JavaScript errors',async()=>assert.deepEqual(errors,[]));
    } finally{await browser.close();}
}
latencies.sort((a,b)=>a-b);
console.log(`Search suite: ${passed} checks passed. ${latencies.length} synthetic loopback samples, p50=${Math.round(latencies[Math.floor(latencies.length*.5)])}ms, p95=${Math.round(latencies[Math.floor(latencies.length*.95)])}ms; not a capacity or SLA claim.`);
