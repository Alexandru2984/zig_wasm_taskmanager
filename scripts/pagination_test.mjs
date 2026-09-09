// Isolated fixtures only. No production accounts, ports or SMTP.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { request } from 'node:http';
import fs from 'node:fs';
const base = new URL(process.env.BASE_URL), database = new URL(process.env.TEST_DB_URL);
for (const target of [base, database]) {
    assert.equal(target.protocol, 'http:'); assert.equal(target.hostname, '127.0.0.1');
    assert.ok(target.port && !['9000', '8010'].includes(target.port));
}
const run = randomBytes(6).toString('hex'), id = (table, name) => `${table}:page_${run}_${name}`;
const hash = value => createHash('sha256').update(value).digest('hex');
async function sql(body) {
    const response = await fetch(new URL('/sql', database), {method:'POST',headers:{Authorization:`Basic ${Buffer.from('itroot:itpass').toString('base64')}`,Accept:'application/json','surreal-ns':'taskmanager_it','surreal-db':'main'},body});
    assert.equal(response.status,200); const rows = await response.json();
    for (const row of rows) assert.equal(row.status,'OK',row.result);
    return rows.at(-1).result;
}
const people = {};
for (const name of ['owner','viewer','outside']) {
    const person = people[name] = {id:id('users',name),token:randomBytes(32).toString('hex'),csrf:randomBytes(32).toString('hex')};
    await sql(`CREATE ${person.id} SET name = '${name}', email = '${name}-${run}@example.invalid', password_hash = 'reset-required', email_verified = true;
        CREATE sessions SET user_id = ${person.id}, token = '${hash(person.token)}', csrf_hash = '${hash(person.csrf)}', expires_at = time::now() + 1h;`);
}
const {owner,viewer,outside} = people, workspace = id('workspaces','primary'), other = id('workspaces','other');
await sql(`CREATE ${workspace} SET name = 'Pagination fixture', owner_id = ${owner.id}; CREATE ${other} SET name = 'Other workspace', owner_id = ${owner.id};
    CREATE workspace_members SET workspace_id = ${workspace}, user_id = ${owner.id}, role = 'owner';
    CREATE workspace_members SET workspace_id = ${workspace}, user_id = ${viewer.id}, role = 'viewer';
    CREATE workspace_members SET workspace_id = ${other}, user_id = ${owner.id}, role = 'owner';`);
const taskId = i => id('tasks', `row${String(i).padStart(5,'0')}`);
const total = 2105, parents = 2050, started = performance.now();
for (let begin = 0; begin < total; begin += 200) {
    await sql('BEGIN TRANSACTION;\n' + Array.from({length:Math.min(200,total-begin)},(_,j)=>{
        const i = begin+j;
        return `CREATE ${taskId(i)} SET user_id = ${owner.id}, workspace_id = ${workspace}, title = 'Fixture ${String(i).padStart(5,'0')}',
            created_at = d'2025-01-01T00:00:00Z', notes = '${i === 2001 ? 'needle beyond old limit' : 'Original notes'}', tags = ['${i === 2001 ? 'far-tag' : 'common'}'], priority = '${i%10 === 0 ? 'high' : 'normal'}',
            completed = ${i%3 === 0}, status = '${i%3 === 0 ? 'done' : 'todo'}'${i >= parents ? `, parent_id = ${taskId(0)}` : ''};`;
    }).join('\n') + '\nCOMMIT TRANSACTION;');
}
await sql(`CREATE ${id('tasks','other')} SET user_id = ${owner.id}, workspace_id = ${other}, title = 'Other workspace sentinel';
    CREATE ${id('tasks','trash')} SET user_id = ${owner.id}, workspace_id = ${workspace}, title = 'Retained trash', deleted_at = time::unix(), delete_batch = '${'a'.repeat(64)}';
    CREATE ${id('tasks','legacy')} SET user_id = ${owner.id}, title = 'Owned legacy task';
    CREATE ${id('tasks','foreign')} SET user_id = ${outside.id}, title = 'Foreign legacy sentinel';`);
const latencies = [];
function api(person, path) {
    const start = performance.now();
    return new Promise((resolve,reject)=>{
        const req = request(new URL(path,base),{localAddress:'127.0.0.5',timeout:15000,headers:person ? {Cookie:`session_token=${person.token}`} : {}},res=>{
            const chunks=[]; res.on('data',x=>chunks.push(x));res.on('error',reject);
            res.on('end',()=>{try { latencies.push(performance.now()-start); resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks).toString())}); } catch(e){reject(e);} });
        });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('fixture timeout')));req.end();
    });
}
const pagePath = `/api/tasks?page=1&workspace_id=${workspace}`;
let passed = 0;
async function check(name, fn) {await fn();passed++;console.log(`PASS ${name}`);}
let first;
await check('pages are bounded and protect auth, scope, private cache and legacy clients',async()=>{
    assert.equal((await api(null,pagePath)).status,401);
    assert.equal((await api(outside,pagePath)).status,403);
    first = await api(owner,pagePath);assert.equal(first.status,200);assert.equal(first.data.items.length,100);assert.ok(first.data.next_cursor);
    assert.equal(first.headers['cache-control'],'no-store');
    assert.equal((await api(owner,'/api/tasks')).status,409);
    assert.equal((await api(outside,'/api/tasks')).data.length,1);
    const small = await api(owner,`/api/tasks?page=1&workspace_id=${other}&limit=1`);
    assert.equal(small.data.items.length,1);assert.ok(small.data.next_cursor);
});
await check('invalid limits, cursors, timestamps and cross-table IDs fail closed',async()=>{
    for (const query of ['page=2','page=1&limit=0','page=1&limit=101','page=1&limit=-1','page=1&limit=1.5','page=1&limit=99999999999999999999999',
        'page=1&workspace_id=users:wrong','page=1&cursor=users:wrong&as_of=1','page=1&cursor=tasks:valid',
        'page=1&as_of=999999999999999999','page=1&as_of=0',`page=1&cursor=${encodeURIComponent('tasks:abc; DELETE users;')}&as_of=1`,'limit=1'])
        assert.equal((await api(owner,`/api/tasks?${query}`)).status,400,query);
});
await check('more than 2000 tasks and children traverse exactly once without timestamp ties losing rows',async()=>{
    let result = first, pages = 0; const seen = new Set();
    do {
        assert.equal(result.status,200);assert.ok(result.data.items.length<=100);assert.equal(result.data.as_of,first.data.as_of);
        for (const task of result.data.items) {assert.ok(!seen.has(task.id));seen.add(task.id);assert.equal(task.deleted_at,null);assert.ok(task.workspace_id === workspace || task.id === id('tasks','legacy'));}
        assert.ok(++pages<=23);
        if (!result.data.next_cursor) break;
        result = await api(owner,`${pagePath}&cursor=${result.data.next_cursor}&as_of=${result.data.as_of}`);
    } while (true);
    assert.equal(seen.size,total+1);for(let i=0;i<total;i++)assert.ok(seen.has(taskId(i)));
    console.log(`Traversal: ${seen.size} rows / ${pages} pages`);
});
await check('creation cutoff excludes later inserts and a removed cursor remains usable',async()=>{
    await sql(`CREATE ${id('tasks','new')} SET user_id = ${owner.id}, workspace_id = ${workspace}, title = 'Later insert';`);
    const after = await api(owner,`${pagePath}&as_of=${first.data.as_of}`);
    assert.ok(!after.data.items.some(t=>t.id === id('tasks','new')));
    const cursor = first.data.next_cursor;
    await sql(`UPDATE ${cursor} SET deleted_at = time::unix(), delete_batch = '${'b'.repeat(64)}';`);
    const next = await api(owner,`${pagePath}&cursor=${cursor}&as_of=${first.data.as_of}`);
    assert.equal(next.status,200);assert.equal(next.data.items.length,100);assert.ok(next.data.items.every(t=>t.id<cursor));
    await sql(`UPDATE ${cursor} SET deleted_at = NONE, delete_batch = NONE; DELETE ${id('tasks','new')};`);
});
await check('membership revocation between pages denies continuation',async()=>{
    const before = await api(viewer,pagePath);assert.equal(before.status,200);
    await sql(`DELETE workspace_members WHERE workspace_id = ${workspace} AND user_id = ${viewer.id};`);
    assert.equal((await api(viewer,`${pagePath}&cursor=${before.data.next_cursor}&as_of=${before.data.as_of}`)).status,403);
});
await check('export remains complete including other workspaces and retained trash',async()=>{
    const exported = await api(owner,'/api/export');assert.equal(exported.status,200);
    assert.equal(exported.data.tasks.length,total+3);
    assert.ok(exported.data.tasks.some(t=>t.id === id('tasks','trash') && t.deleted_at));
    assert.ok(exported.data.tasks.some(t=>t.id === id('tasks','other')));
    assert.ok(!exported.data.tasks.some(t=>t.id === id('tasks','foreign')));
});

if (process.env.RUN_UI === '1') {
    const {chromium} = await import('playwright-core');
    const roots = [`${process.env.HOME}/.cache/ms-playwright`,'/ms-playwright'];
    let executablePath = process.env.CHROME_PATH;
    for (const root of roots) if (!executablePath && fs.existsSync(root)) for(const dir of fs.readdirSync(root)) for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']) {
        const file = `${root}/${dir}/${rel}`;if(fs.existsSync(file))executablePath=file;
    }
    const browser = await chromium.launch({executablePath,args:['--no-sandbox']});
    try {
        const context = await browser.newContext({viewport:{width:320,height:900},isMobile:true,hasTouch:true});
        await context.addCookies([{name:'session_token',value:owner.token,url:base.origin,httpOnly:true},{name:'csrf_token',value:owner.csrf,url:base.origin}]);
        const page = await context.newPage(), errors = [];
        page.on('pageerror',error=>errors.push(error.message));
        await page.addInitScript(ws=>localStorage.setItem('workspaceId',ws),workspace);
        const browserStart = performance.now();
        await page.goto(base.origin,{waitUntil:'networkidle'});
        await page.waitForFunction(expected=>state.tasks.length === expected && !state.loading,total+1,{timeout:60000});
        console.log(`Browser full workspace load: ${Math.round(performance.now()-browserStart)} ms (320px, ${total+1} tasks)`);
        await check('browser loads all tasks but renders at most 50 parents with phone-safe page controls',async()=>{
            assert.equal(await page.locator('.task-item').count(),50);
            assert.equal(await page.locator('#totalCount').textContent(),String(parents+1));
            assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
            await page.click('#tasksNext');assert.match(await page.locator('#taskPageStatus').textContent(),/^51–100/);
            assert.equal(await page.evaluate(()=>document.activeElement.id),'taskPageStatus');
        });
        await check('search, tags, saved views and board include results outside the first page',async()=>{
            await page.fill('#searchInput','needle beyond old limit');assert.equal(await page.locator('.task-item').count(),1);
            assert.ok((await page.locator('.task-item').textContent()).includes('Fixture 02001'));
            await page.click('[data-view="board"]');assert.equal(await page.locator('.board-card').count(),1);
            await page.fill('#searchInput','');assert.equal(await page.locator('.board-card').count(),50);
            await page.click('[data-view="list"]');
            await page.locator('#tagChips [data-tag="far-tag"]').click();assert.equal(await page.locator('.task-item').count(),1);
            await page.locator('#tagChips [data-tag="far-tag"]').click();
            await page.evaluate(()=>{state.savedViews.push({id:'paging',name:'Paging view',search:'needle beyond old limit',filter:'all',tagFilter:null,sort:'title',view:'list'});renderTasks();});
            await page.locator('.saved-view-panel > summary').click();
            await page.selectOption('#savedViews','paging');assert.equal(await page.locator('.task-item').count(),1);
            await page.fill('#searchInput','');
        });
        await check('child paging retains complete progress and makes the final child reachable',async()=>{
            await page.fill('#searchInput','Fixture 00000');assert.equal(await page.locator('.subtask').count(),50);
            assert.ok((await page.locator('.task-content').textContent()).includes('/55'));
            await page.getByRole('button',{name:'Next subtasks',exact:true}).click();assert.equal(await page.locator('.subtask').count(),5);
            assert.ok(await page.evaluate(()=>document.activeElement.hasAttribute('data-parent-page')));
            await page.fill('#searchInput','');
        });
        await check('partial network failure never publishes an incomplete list; explicit retry succeeds',async()=>{
            let calls = 0;
            await page.route('**/api/tasks?*',route=>++calls === 2 ? route.fulfill({status:503,contentType:'application/json',body:'{"error":"fixture failure"}'}) : route.continue());
            await page.evaluate(()=>loadTasks());assert.equal(calls,2);
            assert.equal(await page.evaluate(()=>state.tasks.length),total+1);
            assert.ok(await page.locator('#taskLoadError').isVisible());
            await page.unroute('**/api/tasks?*');await page.click('#retryTasksBtn');
            await page.waitForFunction(()=>!state.loading && document.getElementById('taskLoadError').classList.contains('hidden'),null,{timeout:60000});
        });
        await check('late workspace responses cannot replace the newly selected workspace',async()=>{
            assert.ok(await page.evaluate(async other=>{
                const original = window.fetch;let finish;
                window.fetch=(path,options)=>path.startsWith('/api/tasks?') ? new Promise(resolve=>{finish=resolve;}) : original(path,options);
                const pending=loadTasks(); const complete=finish;
                window.fetch=original;
                await switchWorkspace(other);
                complete(new Response(JSON.stringify({items:[],next_cursor:null,as_of:Date.now()}),{headers:{'Content-Type':'application/json'}}));
                await pending;
                return state.currentWorkspaceId===other && state.tasks.length===2;
            },other));
        });
        await check('cancel loading preserves the last list and stops stale publication',async()=>{
            assert.ok(await page.evaluate(async()=>{
                const original=window.fetch;let finish;const before=state.tasks;
                window.fetch=()=>new Promise(resolve=>{finish=resolve;});
                try {const pending=loadTasks();cancelTaskLoad(true);finish(new Response(JSON.stringify({items:[],next_cursor:null,as_of:Date.now()}),{headers:{'Content-Type':'application/json'}}));await pending;
                    return !state.loading && state.tasks===before && !document.getElementById('taskLoadError').classList.contains('hidden');
                } finally {window.fetch=original;}
            }));
        });
        await check('newer refresh wins even if an older same-workspace response arrives last',async()=>{
            assert.ok(await page.evaluate(async()=>{
                const original=window.fetch, before=state.tasks;let finish;
                window.fetch=()=>new Promise(resolve=>{finish=resolve;});
                try {
                    const old=loadTasks(), finishOld=finish;
                    const fresh=loadTasks(), finishFresh=finish;
                    const response=items=>new Response(JSON.stringify({items,next_cursor:null,as_of:Date.now()}),{headers:{'Content-Type':'application/json'}});
                    finishFresh(response(before));await fresh;finishOld(response([]));await old;
                    return state.tasks.length===before.length && !state.loading;
                } finally {window.fetch=original;}
            }));
        });
        await check('a completed local write invalidates a refresh started while the write was pending',async()=>{
            assert.ok(await page.evaluate(async()=>{
                const original=window.fetch, before=state.tasks;let finishRead,finishWrite;
                window.fetch=(path,options)=>new Promise(resolve=>{if(options.method==='PUT')finishWrite=resolve;else finishRead=resolve;});
                try {
                    const write=api(`/api/tasks/${state.tasks[0].id}`,{method:'PUT',body:{notes:'synthetic response only'}});
                    const read=loadTasks();
                    finishWrite(new Response('{}',{headers:{'Content-Type':'application/json'}}));await write;
                    finishRead(new Response(JSON.stringify({items:[],next_cursor:null,as_of:Date.now()}),{headers:{'Content-Type':'application/json'}}));await read;
                    return state.tasks===before && !state.loading;
                } finally {window.fetch=original;}
            }));
        });
        await check('denied refresh clears retained private tasks and is not reported as an empty workspace',async()=>{
            await page.route('**/api/tasks?*',route=>route.fulfill({status:403,contentType:'application/json',body:'{"error":"Workspace unavailable"}'}));
            await page.evaluate(()=>loadTasks());assert.equal(await page.evaluate(()=>state.tasks.length),0);
            assert.equal(await page.locator('#emptyTitle').textContent(),'Tasks not loaded');
            assert.ok(await page.locator('#taskLoadError').isVisible());
            await page.unroute('**/api/tasks?*');
        });
        await check('pagination browser has no uncaught errors',async()=>assert.deepEqual(errors,[]));
    } finally {await browser.close();}
}
latencies.sort((a,b)=>a-b);
console.log(`Read samples: ${latencies.length}; p50=${Math.round(latencies[Math.floor(latencies.length*.5)])} ms; p95=${Math.round(latencies[Math.floor(latencies.length*.95)])} ms; max=${Math.round(latencies.at(-1))} ms. Loopback, synthetic data; not a concurrency/SLA claim.`);
console.log(`Pagination suite: ${passed} checks passed in ${Math.round(performance.now()-started)} ms`);
