// Disposable harness only: synthetic accounts, real transactional DB and browsers.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {request} from 'node:http';
import fs from 'node:fs';
const base=new URL(process.env.BASE_URL), database=new URL(process.env.TEST_DB_URL);
for(const u of [base,database]) { assert.equal(u.protocol,'http:'); assert.equal(u.hostname,'127.0.0.1'); assert.ok(u.port&&!['9000','8010'].includes(u.port)); }
const run=randomBytes(6).toString('hex'), id=(table,label)=>`${table}:views_${run}_${label}`, hash=x=>createHash('sha256').update(x).digest('hex');
const password=`Aa1${randomBytes(24).toString('hex')}`;
async function sql(body) {
    const response=await fetch(new URL('/sql',database),{method:'POST',headers:{Authorization:'Basic '+Buffer.from('itroot:itpass').toString('base64'),Accept:'application/json','surreal-ns':'taskmanager_it','surreal-db':'main'},body});
    assert.equal(response.status,200); const rows=await response.json(); for(const row of rows)assert.equal(row.status,'OK',row.result);return rows.at(-1).result;
}
function api(user,path,method='GET',body,{csrf=true}={}) {
    const payload=body===undefined?undefined:JSON.stringify(body);
    return new Promise((resolve,reject)=>{
        const req=request(new URL(path,base),{method,localAddress:'127.0.0.14',timeout:30000,headers:{'Content-Type':'application/json',...(payload===undefined?{}:{'Content-Length':Buffer.byteLength(payload)}),...(user?{Cookie:`session_token=${user.token}`,...(csrf?{'X-CSRF-Token':user.csrf}:{})}:{})}},res=>{
            const chunks=[];res.on('data',x=>chunks.push(x));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks).toString())});}catch(e){reject(e);}});
        });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Saved view fixture timeout')));req.end(payload);
    });
}
const seed=`views-seed-${run}@example.invalid`;
assert.equal((await api(null,'/api/auth/signup','POST',{email:seed,name:'Views seed',password})).status,201);
const passwordHash=(await sql(`SELECT password_hash FROM users WHERE email = '${seed}';`))[0].password_hash;
let serial=0,passed=0;
async function fixture(){
    const n=++serial, f={ws:id('workspaces',n)};
    let body=`CREATE ${f.ws} SET name = 'Saved views fixture', owner_id = ${id('users',n+'_owner')};`;
    for(const role of ['owner','admin','member','viewer','outside']) {
        const u=f[role]={id:id('users',n+'_'+role),membership:id('workspace_members',n+'_'+role),email:`${n}-${role}-${run}@example.invalid`,token:randomBytes(32).toString('hex'),csrf:randomBytes(32).toString('hex')};
        body+=`CREATE ${u.id} SET name = '${role}', email = '${u.email}', password_hash = ${JSON.stringify(passwordHash)}, email_verified = true; CREATE sessions SET user_id = ${u.id}, token = '${hash(u.token)}', csrf_hash = '${hash(u.csrf)}', expires_at = time::now() + 1h;`;
        if(role!=='outside')body+=`CREATE ${u.membership} SET user_id = ${u.id}, workspace_id = ${f.ws}, role = '${role}';`;
    }
    body+=`CREATE tasks SET user_id = ${f.owner.id}, workspace_id = ${f.ws}, title = 'Unchanged task';`;
    await sql(body);return f;
}
const path=f=>`/api/workspaces/${f.ws}/views`;
const view=(id='focus',extra={})=>({id,name:'Focus <work>',search:'',filter:'high',tagFilter:null,sort:'priority',view:'board',...extra});
const save=(f,user=f.owner,items=[view()],version=0,extra={})=>api(user,path(f),'PUT',{expected_membership:user.membership,expected_version:version,items,...extra});
const read=(f,user=f.owner)=>api(user,path(f));
async function check(name,fn){await fn();passed++;console.log(`PASS ${name}`);}

await check('empty reads are private and do not create database rows',async()=>{
    const f=await fixture(),r=await read(f);assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store');
    assert.deepEqual(r.data,{membership_id:f.owner.membership,version:0,items:[]});assert.equal((await sql(`SELECT id FROM saved_view_sets WHERE workspace_id = ${f.ws};`)).length,0);
});
await check('all current roles can save personal views without changing tasks',async()=>{
    const f=await fixture(),before=await sql(`SELECT * FROM tasks WHERE workspace_id = ${f.ws};`);
    for(const role of ['owner','admin','member','viewer']){const r=await save(f,f[role]);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.version,1);assert.deepEqual((await read(f,f[role])).data.items,[view()]);}
    assert.deepEqual(await sql(`SELECT * FROM tasks WHERE workspace_id = ${f.ws};`),before);
});
await check('same-workspace teammates and spoofed owner fields cannot read or overwrite another collection',async()=>{
    const f=await fixture();await save(f);assert.deepEqual((await read(f,f.admin)).data.items,[]);
    assert.equal((await save(f,f.member,[view('own')],0,{owner_id:f.owner.id})).status,200);
    assert.equal((await save(f,f.admin,[view()],0,{expected_membership:f.owner.membership})).status,409);
    assert.deepEqual((await read(f)).data.items,[view()]);assert.deepEqual((await read(f,f.member)).data.items,[view('own')]);
});
await check('session, CSRF, method, typed workspace and membership access are enforced',async()=>{
    const f=await fixture();assert.equal((await api(null,path(f))).status,401);assert.equal((await api(f.owner,path(f),'PUT',{expected_membership:f.owner.membership,expected_version:0,items:[]},{csrf:false})).status,403);
    for(const method of ['GET','PUT'])assert.equal((await api(f.outside,path(f),method,method==='PUT'?{expected_membership:f.owner.membership,expected_version:0,items:[]}:undefined)).status,403);
    const wrong=await api(f.owner,path(f),'POST',{});assert.equal(wrong.status,405);assert.equal(wrong.headers.allow,'GET, PUT');
    assert.equal((await api(f.owner,`/api/workspaces/${f.owner.id}/views`)).status,400);
});
await check('invalid types, bounds, enums, controls, duplicate IDs and oversized arrays fail without storage',async()=>{
    const f=await fixture();const bad=[{}, {expected_version:-1}, {expected_version:1.5}, {expected_version:9007199254740991}, {expected_membership:f.owner.id}, {items:[view(),view()]}, {items:Array.from({length:13},(_,n)=>view('v'+n))}];
    for(const extra of bad){const body=Object.keys(extra).length?{expected_membership:f.owner.membership,expected_version:0,items:[view()],...extra}:extra;assert.equal((await api(f.owner,path(f),'PUT',body)).status,400);}
    for(const change of [{id:''},{id:'x;DELETE users'},{name:' '},{name:'x'.repeat(49)},{search:'é'.repeat(251)},{tagFilter:'x'.repeat(129)},{search:'x\n'},{filter:'raw'},{sort:'desc'},{view:'html'}])assert.equal((await save(f,f.owner,[view('x',change)])).status,400);
    assert.equal((await save(f,f.owner,[],0,{padding:'x'.repeat(32769)})).status,400);
    assert.equal((await read(f)).data.version,0);
});
await check('quoted Unicode and injection-shaped strings round-trip as data and null tags survive',async()=>{
    const f=await fixture(),item=view('safe',{name:'Şedință <img onerror=x>',search:'"; DELETE users; -- \\ 😀',tagFilter:'"\\tag'});
    assert.equal((await save(f,f.owner,[item,view('null')])).status,200);assert.deepEqual((await read(f)).data.items,[item,view('null')]);assert.equal((await sql(`SELECT id FROM ${f.owner.id};`)).length,1);
});
await check('12 views are allowed; replacement/deletion advance revisions without an empty-set ABA',async()=>{
    const f=await fixture(),items=Array.from({length:12},(_,n)=>view('v'+n));assert.equal((await save(f,f.owner,items)).status,200);
    assert.equal((await save(f,f.owner,[],1)).status,200);assert.equal((await save(f,f.owner,[view()],0)).status,409);
    assert.equal((await save(f,f.owner,[view()],2)).status,200);assert.equal((await save(f,f.owner,[],1)).status,409);assert.equal((await read(f)).data.version,3);
});
await check('concurrent first saves have one winner and one conflict, never duplicate collections',async()=>{
    const f=await fixture(),r=await Promise.all([save(f,f.owner,[view('a')]),save(f,f.owner,[view('b')])]);assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);
    assert.equal((await sql(`SELECT id FROM saved_view_sets WHERE workspace_id = ${f.ws};`)).length,1);assert.equal((await read(f)).data.version,1);
});
await check('archive does not freeze personal preferences or grant task-write rights to viewers',async()=>{
    const f=await fixture();assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/archive`,'POST',{archived:true,expected_version:0})).status,200);
    assert.equal((await save(f,f.viewer)).status,200);assert.equal((await api(f.viewer,'/api/tasks','POST',{workspace_id:f.ws,title:'Denied'})).status,403);
});
await check('workspace scope isolates collections belonging to the same account',async()=>{
    const f=await fixture(),other=id('workspaces','other'+serial),m=id('workspace_members','other'+serial);
    await sql(`CREATE ${other} SET owner_id = ${f.owner.id}, name = 'Other'; CREATE ${m} SET user_id = ${f.owner.id}, workspace_id = ${other}, role = 'owner';`);
    await save(f);const r=await api(f.owner,`/api/workspaces/${other}/views`);assert.equal(r.status,200);assert.deepEqual(r.data.items,[]);
});
await check('member removal deletes personal data and old membership revisions cannot replay after rejoin',async()=>{
    const f=await fixture();await save(f,f.member);
    assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/members`,'DELETE',{user_id:f.member.id})).status,200);
    assert.equal((await read(f,f.member)).status,403);assert.equal((await sql(`SELECT id FROM saved_view_sets WHERE owner_id = ${f.member.id};`)).length,0);
    await sql(`CREATE workspace_members SET user_id = ${f.member.id}, workspace_id = ${f.ws}, role = 'member';`);
    assert.equal((await save(f,f.member,[],0)).status,409);const current=(await read(f,f.member)).data;assert.equal(current.version,0);assert.notEqual(current.membership_id,f.member.membership);
});
await check('account export includes only the caller’s views across accessible workspaces',async()=>{
    const f=await fixture();await save(f);await save(f,f.member,[view('private')]);
    const exported=await api(f.owner,'/api/export');assert.equal(exported.status,200);assert.deepEqual(exported.data.saved_views,[{workspace_id:f.ws,version:1,items:[view()]}]);
    assert.ok(!JSON.stringify(exported.data.saved_views).includes('private'));
});
await check('account deletion clears owned personal data and all views in owned workspaces',async()=>{
    const f=await fixture();await save(f);await save(f,f.member);assert.equal((await api(f.member,'/api/account','DELETE',{password})).status,200);
    assert.equal((await sql(`SELECT id FROM saved_view_sets WHERE owner_id = ${f.member.id};`)).length,0);assert.equal((await read(f)).data.version,1);
    await save(f,f.viewer);assert.equal((await api(f.owner,'/api/account','DELETE',{password})).status,200);assert.equal((await sql(`SELECT id FROM saved_view_sets WHERE workspace_id = ${f.ws};`)).length,0);
});
await check('failed collection write rolls back both data and revision',async()=>{
    const f=await fixture(),event=`views_fail_${run}`;await save(f);
    await sql(`DEFINE EVENT ${event} ON saved_view_sets WHEN $event = 'UPDATE' AND $after.owner_id = ${f.owner.id} THEN { THROW 'fixture'; };`);
    try{assert.equal((await save(f,f.owner,[],1)).status,500);assert.deepEqual((await read(f)).data.items,[view()]);assert.equal((await read(f)).data.version,1);}finally{await sql(`REMOVE EVENT ${event} ON saved_view_sets;`);}
});
await check('failed saved-view cleanup rolls back membership removal',async()=>{
    const f=await fixture(),event=`views_cleanup_${run}`;await save(f,f.member);
    await sql(`DEFINE EVENT ${event} ON saved_view_sets WHEN $event = 'DELETE' AND $before.owner_id = ${f.member.id} THEN { THROW 'fixture'; };`);
    try{assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/members`,'DELETE',{user_id:f.member.id})).status,500);assert.equal((await read(f,f.member)).status,200);}finally{await sql(`REMOVE EVENT ${event} ON saved_view_sets;`);}
});
await check('revocation defeats an in-flight save without orphaned private data',async()=>{
    const f=await fixture(),event=`views_delay_${run}`;
    await sql(`DEFINE EVENT ${event} ON saved_view_sets WHEN $event = 'CREATE' AND $after.owner_id = ${f.member.id} THEN { FOR $n IN 0..48 { LET $unused = crypto::argon2::generate('isolated saved view race'); }; };`);
    try{let finished=false;const pending=save(f,f.member).finally(()=>{finished=true;});await new Promise(r=>setTimeout(r,500));assert.equal(finished,false);
        assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/members`,'DELETE',{user_id:f.member.id})).status,200);assert.equal((await pending).status,409);
        assert.equal((await sql(`SELECT id FROM saved_view_sets WHERE owner_id = ${f.member.id};`)).length,0);
    }finally{await sql(`REMOVE EVENT ${event} ON saved_view_sets;`);}
});
await check('failed view cleanup rolls back account deletion and preserves its workspace',async()=>{
    const f=await fixture(),event=`views_account_fail_${run}`;await save(f);
    await sql(`DEFINE EVENT ${event} ON saved_view_sets WHEN $event = 'DELETE' AND $before.owner_id = ${f.owner.id} THEN { THROW 'fixture'; };`);
    try{assert.equal((await api(f.owner,'/api/account','DELETE',{password})).status,500);assert.equal((await read(f)).data.version,1);assert.equal((await sql(`SELECT id FROM ${f.ws};`)).length,1);}finally{await sql(`REMOVE EVENT ${event} ON saved_view_sets;`);}
});
await check('account deletion defeats an already-authorized saved-view creation',async()=>{
    const f=await fixture(),event=`views_account_race_${run}`;
    await sql(`DEFINE EVENT ${event} ON saved_view_sets WHEN $event = 'CREATE' AND $after.owner_id = ${f.member.id} THEN { FOR $n IN 0..48 { LET $unused = crypto::argon2::generate('isolated account and view race'); }; };`);
    try{let finished=false;const pending=save(f,f.member).finally(()=>{finished=true;});await new Promise(r=>setTimeout(r,500));assert.equal(finished,false);
        assert.equal((await api(f.member,'/api/account','DELETE',{password})).status,200);assert.equal((await pending).status,409);assert.equal((await sql(`SELECT id FROM saved_view_sets WHERE owner_id = ${f.member.id};`)).length,0);
    }finally{await sql(`REMOVE EVENT ${event} ON saved_view_sets;`);}
});
await check('personal writes share the task-write budget and return Retry-After',async()=>{
    const f=await fixture();for(let n=0;n<60;n++)assert.equal((await api(f.owner,path(f),'PUT',{})).status,400);
    const r=await save(f);assert.equal(r.status,429);assert.equal(r.headers['retry-after'],'60');assert.equal((await read(f)).data.version,0);
});

if(process.env.RUN_UI==='1'){
    const {chromium}=await import('playwright-core');let executablePath=process.env.CHROME_PATH;
    for(const root of [`${process.env.HOME}/.cache/ms-playwright`,'/ms-playwright'])if(!executablePath&&fs.existsSync(root))for(const dir of fs.readdirSync(root))for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']){const file=`${root}/${dir}/${rel}`;if(fs.existsSync(file))executablePath=file;}
    const browser=await chromium.launch({executablePath,args:['--no-sandbox']}),errors=[];
    try{
        async function pageFor(user){const context=await browser.newContext({viewport:{width:320,height:900},isMobile:true,hasTouch:true});await context.addCookies([{name:'session_token',value:user.token,url:base.origin,httpOnly:true},{name:'csrf_token',value:user.csrf,url:base.origin}]);const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base.origin,{waitUntil:'networkidle'});await p.waitForFunction(()=>savedViewSync.ready);await p.click('.saved-view-panel summary');return p;}
        const f=await fixture(),p=await pageFor(f.owner),q=await pageFor(f.owner);
        await check('mobile save synchronizes only after confirmation and another device refreshes it',async()=>{
            await p.click('[data-filter="high"]');await p.fill('#savedViewName','Focus <script>alert(1)</script>');await p.click('#saveViewForm button');await p.waitForFunction(()=>savedViewSync.ready&&savedViewSync.version===1);
            assert.equal(await q.locator('#savedViews option').count(),1);await q.click('#refreshViewsBtn');await q.waitForFunction(()=>savedViewSync.ready&&savedViewSync.version===1);
            assert.equal(await q.locator('#savedViews option').count(),2);assert.equal(await q.locator('#savedViews option').last().textContent(),'Focus <script>alert(1)</script>');assert.equal(await q.evaluate(()=>state.filter),'all');
            await q.selectOption('#savedViews',(await read(f)).data.items[0].id);assert.equal(await q.evaluate(()=>state.filter),'high');assert.ok(await q.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
            const dir=process.env.SAVED_VIEWS_ARTIFACT_DIR;if(dir){fs.mkdirSync(dir,{recursive:true,mode:0o700});await q.locator('.saved-view-panel').scrollIntoViewIfNeeded();await q.screenshot({path:`${dir}/saved-views-mobile.png`});}
        });
        await check('two-device conflicts retain filters/name and require an explicit refresh, never retry',async()=>{
            await p.fill('#savedViewName','Second');await p.click('#saveViewForm button');await p.waitForFunction(()=>savedViewSync.version===2);
            await q.fill('#savedViewName','Conflicted draft');await q.click('#saveViewForm button');await q.waitForFunction(()=>!savedViewSync.busy&&!savedViewSync.ready);
            assert.equal(await q.inputValue('#savedViewName'),'Conflicted draft');assert.equal(await q.evaluate(()=>state.filter),'high');assert.ok(await q.locator('#saveViewForm button').isDisabled());assert.equal((await read(f)).data.version,2);
            await q.click('#refreshViewsBtn');await q.waitForFunction(()=>savedViewSync.ready);assert.equal(await q.locator('#savedViews option').count(),3);
        });
        await check('deletion syncs to another device and does not alter the current task filters',async()=>{
            const selected=(await read(f)).data.items[0].id;await q.selectOption('#savedViews',selected);await q.click('#deleteViewBtn');await q.waitForFunction(()=>savedViewSync.ready&&savedViewSync.version===3);
            await p.click('#refreshViewsBtn');await p.waitForFunction(()=>savedViewSync.ready&&savedViewSync.version===3);assert.equal(await p.locator('#savedViews option').count(),2);assert.equal(await q.evaluate(()=>state.filter),'high');
        });
        await check('device views are not auto-uploaded; explicit import preserves unrelated local data',async()=>{
            const g=await fixture(),page=await pageFor(g.owner),key=`zigTasks:views:${g.owner.id}:${g.ws}`,guest='zigTasks:views:guest:local';
            await page.evaluate(({key,guest,item})=>{localStorage.setItem(key,JSON.stringify([item]));localStorage.setItem(guest,JSON.stringify([item]));}, {key,guest,item:view('legacy')});
            await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>savedViewSync.ready);await page.click('.saved-view-panel summary');assert.equal((await read(g)).data.version,0);
            page.once('dialog',d=>d.dismiss());await page.click('#importViewsBtn');assert.equal((await read(g)).data.version,0);
            page.once('dialog',d=>d.accept());await page.click('#importViewsBtn');await page.waitForFunction(()=>savedViewSync.ready&&savedViewSync.version===1);
            assert.deepEqual((await read(g)).data.items,[view('legacy')]);assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),null);assert.ok(await page.evaluate(key=>localStorage.getItem(key),guest));
            await page.context().close();
        });
        await check('network ambiguity keeps local filters and locks mutation until fresh read',async()=>{
            await p.route('**/api/workspaces/*/views',route=>route.request().method()==='PUT'?route.abort():route.continue());await p.fill('#savedViewName','Retained after failure');await p.click('#saveViewForm button');await p.waitForFunction(()=>!savedViewSync.busy&&!savedViewSync.ready);
            assert.equal(await p.inputValue('#savedViewName'),'Retained after failure');assert.ok(await p.locator('#saveViewForm button').isDisabled());await p.unroute('**/api/workspaces/*/views');await p.click('#refreshViewsBtn');await p.waitForFunction(()=>savedViewSync.ready);
        });
        await check('malformed success is not accepted and does not invent a synced view',async()=>{
            const before=(await read(f)).data.version;await p.route('**/api/workspaces/*/views',route=>route.request().method()==='PUT'?route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({membership_id:f.owner.membership,version:before+1,items:[]})}):route.continue());
            await p.fill('#savedViewName','Malformed response');await p.click('#saveViewForm button');await p.waitForFunction(()=>!savedViewSync.busy&&!savedViewSync.ready);assert.equal((await read(f)).data.version,before);
            await p.unroute('**/api/workspaces/*/views');await p.click('#refreshViewsBtn');await p.waitForFunction(()=>savedViewSync.ready);
        });
        await check('denied refresh clears private selections and disallows saving',async()=>{
            const g=await fixture();await save(g,g.member);const page=await pageFor(g.member);assert.equal(await page.locator('#savedViews option').count(),2);
            await api(g.owner,`/api/workspaces/${g.ws}/members`,'DELETE',{user_id:g.member.id});await page.click('#refreshViewsBtn');await page.waitForFunction(()=>!savedViewSync.busy&&!savedViewSync.ready);
            assert.equal(await page.locator('#savedViews option').count(),1);assert.ok(await page.locator('#saveViewForm button').isDisabled());await page.context().close();
        });
        await check('late save response cannot repopulate a signed-out account',async()=>{
            let release,received;const requestSeen=new Promise(r=>received=r),hold=new Promise(r=>release=r);
            await p.route('**/api/workspaces/*/views',async route=>{if(route.request().method()!=='PUT')return route.continue();const response=await route.fetch();received();await hold;await route.fulfill({response}).catch(()=>{});});
            await p.fill('#savedViewName','Late private view');await p.click('#saveViewForm button');await requestSeen;await p.evaluate(()=>showLoggedOut());release();await p.waitForTimeout(100);
            assert.equal(await p.evaluate(()=>state.user),null);assert.equal(await p.locator('#savedViews option').count(),1);assert.equal(await p.inputValue('#savedViewName'),'');assert.equal(await p.evaluate(()=>pendingViewWrites.size),0);
        });
        await check('committed but timed-out save is reconciled by read and duplicate submission stays blocked',async()=>{
            const g=await fixture(),page=await pageFor(g.owner);let release,received,writes=0;const hold=new Promise(r=>release=r),seen=new Promise(r=>received=r);
            await page.route('**/api/workspaces/*/views',async route=>{if(route.request().method()!=='PUT')return route.continue();writes++;const response=await route.fetch();received();await hold;await route.fulfill({response}).catch(()=>{});});
            await page.evaluate(()=>{window.originalViewsTimer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>originalViewsTimer(fn,ms===20000?50:ms,...args);});
            await page.fill('#savedViewName','Confirmed on refresh');await page.click('#saveViewForm button');await page.evaluate(()=>document.getElementById('saveViewForm').requestSubmit());
            await seen;await page.waitForFunction(()=>!savedViewSync.busy&&!savedViewSync.ready);assert.equal(writes,1);assert.equal((await read(g)).data.version,1);assert.equal(await page.inputValue('#savedViewName'),'Confirmed on refresh');
            release();await page.unroute('**/api/workspaces/*/views');await page.evaluate(()=>{window.setTimeout=window.originalViewsTimer;});
            await page.click('#refreshViewsBtn');await page.waitForFunction(()=>savedViewSync.ready);assert.equal(await page.locator('#savedViews option').count(),2);assert.equal(writes,1);await page.context().close();
        });
        await check('late reads cannot cross a workspace switch or leak the previous name draft',async()=>{
            const g=await fixture();await save(g);const other=id('workspaces','browser_other'+serial),m=id('workspace_members','browser_other'+serial);
            await sql(`CREATE ${other} SET owner_id = ${g.owner.id}, name = 'Other workspace'; CREATE ${m} SET user_id = ${g.owner.id}, workspace_id = ${other}, role = 'owner';`);
            const page=await pageFor(g.owner);if(await page.inputValue('#workspaceSelect')!==g.ws){await page.selectOption('#workspaceSelect',g.ws);await page.waitForFunction(()=>savedViewSync.ready);}
            let release,received;const hold=new Promise(r=>release=r),seen=new Promise(r=>received=r);
            await page.route('**/api/workspaces/*/views',async route=>{if(!decodeURIComponent(route.request().url()).includes(g.ws))return route.continue();const response=await route.fetch();received();await hold;await route.fulfill({response}).catch(()=>{});});
            await page.fill('#savedViewName','Private workspace draft');await page.click('#refreshViewsBtn');await seen;await page.selectOption('#workspaceSelect',other);await page.waitForFunction(()=>savedViewSync.ready);release();await page.waitForTimeout(100);
            assert.equal(await page.locator('#savedViews option').count(),1);assert.equal(await page.inputValue('#savedViewName'),'');assert.equal(await page.evaluate(()=>savedViewSync.membership),m);await page.context().close();
        });
        await check('refresh does not discard a task draft and applying a view honors cancellation',async()=>{
            const g=await fixture();await save(g);const page=await pageFor(g.owner);await page.waitForFunction(()=>!state.loading&&!mainView.timer);
            await page.locator('[data-act="edit"]').first().click();await page.fill('.task-edit [data-field="notes"]','Keep this draft');
            await page.click('#refreshViewsBtn');await page.waitForFunction(()=>savedViewSync.ready);assert.equal(await page.inputValue('.task-edit [data-field="notes"]'),'Keep this draft');
            page.once('dialog',d=>d.dismiss());await page.selectOption('#savedViews','focus');assert.equal(await page.inputValue('.task-edit [data-field="notes"]'),'Keep this draft');assert.equal(await page.inputValue('#savedViews'),'');assert.equal(await page.evaluate(()=>state.filter),'all');await page.context().close();
        });
        await check('saved-view flows have no browser execution errors',async()=>assert.deepEqual(errors,[]));
    }finally{await browser.close();}
}
console.log(`Saved views suite: ${passed} checks passed`);
