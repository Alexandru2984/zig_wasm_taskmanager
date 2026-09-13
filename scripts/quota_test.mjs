// Only disposable loopback DB/app fixtures. Never use production credentials/ports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request} from 'node:http';
const main=new URL(process.env.BASE_URL),database=new URL(process.env.TEST_DB_URL);
for(const url of [main,database]){assert.equal(url.hostname,'127.0.0.1');assert.equal(url.protocol,'http:');assert.ok(url.port&&!['9000','8010'].includes(url.port));}
assert.ok(process.env.TEST_WORKDIR.startsWith('/tmp/')&&process.env.TEST_APP_BINARY.startsWith(process.env.TEST_WORKDIR+'/'));
const port=await new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const base=new URL(`http://127.0.0.1:${port}`);
const run=randomBytes(6).toString('hex'),id=(table,name)=>`${table}:quota_${run}_${name}`,hash=x=>createHash('sha256').update(x).digest('hex');
async function sql(body){const r=await fetch(new URL('/sql',database),{method:'POST',headers:{Authorization:'Basic '+Buffer.from('itroot:itpass').toString('base64'),Accept:'application/json','surreal-ns':'taskmanager_it','surreal-db':'main'},body});assert.equal(r.status,200);const rows=await r.json();for(const row of rows)assert.equal(row.status,'OK',row.result);return rows.at(-1).result;}
const people=[];
for(let i=0;i<5;i++){const p={id:id('users',`person${i}`),token:randomBytes(32).toString('hex'),csrf:randomBytes(32).toString('hex')};people.push(p);await sql(`CREATE ${p.id} SET name='Quota fixture',email='quota-${i}-${run}@example.invalid',password_hash='reset-required',email_verified=true;CREATE sessions SET user_id=${p.id},token='${hash(p.token)}',csrf_hash='${hash(p.csrf)}',expires_at=time::now()+1h;`);}
const [owner,member,member2,viewer,outside]=people;
const workspace=id('workspaces','scope');
await sql(`CREATE ${workspace} SET owner_id=${owner.id},name='Quota fixture';`);
for(const p of [owner,member,member2,viewer])await sql(`CREATE workspace_members SET user_id=${p.id},workspace_id=${workspace},role='${p===owner?'owner':p===viewer?'viewer':'member'}';`);
function api(person,path,method='GET',body,version,target=base){return new Promise((resolve,reject)=>{const req=request(new URL(path,target),{method,localAddress:'127.0.0.8',timeout:15000,headers:{Origin:target.origin,'Content-Type':'application/json',...(person?{Cookie:`session_token=${person.token}`,'X-CSRF-Token':person.csrf}:{}),...(version!==undefined?{'If-Match':`"v${version}"`}:{})}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks))});}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Quota fixture timeout')));req.end(body===undefined?undefined:JSON.stringify(body));});}
const create=(person,body)=>api(person,'/api/tasks','POST',{workspace_id:workspace,...body});
const usage=person=>api(person,`/api/workspaces/${workspace}/usage`);
let passed=0,log='';
const check=async(name,fn)=>{await fn();passed++;console.log(`PASS ${name}`);};
const app=spawn(process.env.TEST_APP_BINARY,[],{cwd:process.env.TEST_WORKDIR,env:{PATH:process.env.PATH,LD_LIBRARY_PATH:process.env.TEST_LIBRARY_DIR,SURREAL_URL:database.origin,SURREAL_NS:'taskmanager_it',SURREAL_DB:'main',SURREAL_USER:'itapp',SURREAL_PASS:'integration-only-app',SURREAL_AUTH_LEVEL:'database',DB_AUTO_MIGRATE:'0',MAIL_OUTBOX_KEY:process.env.TEST_MAIL_KEY,MAIL_WORKER_ENABLED:'0',TASK_REMINDERS_ENABLED:'0',PORT:String(port),CORS_ORIGIN:base.origin,APP_BASE_URL:base.origin,COOKIE_INSECURE:'1',SERVER_THREADS:'4',WORKSPACE_TASK_LIMIT:'4',WORKSPACE_TEXT_BYTES_LIMIT:'500',OWNED_WORKSPACE_LIMIT:'3'},stdio:['ignore','pipe','pipe']});
for(const stream of [app.stdout,app.stderr])stream.on('data',chunk=>{log=(log+chunk).slice(-6000);});
try {
    for(let i=0;i<30;i++){try{assert.equal((await api(null,'/api/ready')).status,200);break;}catch(e){if(i===29)throw e;await new Promise(r=>setTimeout(r,200));}}
    await check('usage is authenticated, typed, scoped, no-store and safe for viewers',async()=>{
        assert.equal((await usage(null)).status,401);assert.equal((await usage(outside)).status,403);
        assert.equal((await api(owner,`/api/workspaces/${owner.id}/usage`)).status,400);
        const result=await usage(viewer);assert.equal(result.status,200);assert.equal(result.headers['cache-control'],'no-store');assert.deepEqual(result.data.limits,{tasks:4,text_bytes:500,workspaces:3});assert.equal(result.data.usage.retained,0);
        assert.equal((await api(owner,`/api/workspaces/${workspace}/usage`,'POST',{})).status,405);
    });
    await check('UTF-8 titles, notes and tags count exactly; client accounting fields are ignored',async()=>{
        const result=await create(owner,{title:'ș😀',notes:'abc',tags:['x','y'],text_bytes:-999,quota_tasks:99999});assert.equal(result.status,201);
        assert.equal((await usage(owner)).data.usage.text_bytes,11);
        const row=await api(owner,`/api/tasks/${result.data.id}`,'PUT',{notes:'abcD'},result.data.version);assert.equal(row.status,200);assert.equal((await usage(owner)).data.usage.text_bytes,12);
    });
    await check('cross-member concurrent creates cannot exceed the remaining task slot',async()=>{
        assert.equal((await create(owner,{title:'Second'})).status,201);assert.equal((await create(member,{title:'Third'})).status,201);
        const results=await Promise.all([owner,member,member2].map((p,i)=>create(p,{title:`Concurrent ${i}`})));
        assert.equal(results.filter(r=>r.status===201).length,1);assert.ok(results.every(r=>[201,409,422].includes(r.status)));
        assert.equal((await usage(owner)).data.usage.retained,4);assert.equal((await create(member2,{title:'No extra slot'})).status,422);
    });
    await check('trash retains quota and restore does not consume capacity twice',async()=>{
        const rows=(await api(owner,`/api/tasks?workspace_id=${workspace}`)).data;const task=rows[0];
        const deleted=await api(owner,`/api/tasks/${task.id}`,'DELETE',undefined,task.version);assert.equal(deleted.status,200);
        const after=(await usage(owner)).data.usage;assert.equal(after.retained,4);assert.equal(after.trash,1);assert.equal((await create(owner,{title:'Trash is not free storage'})).status,422);
        assert.equal((await api(owner,`/api/trash/${task.id}`,'POST',{delete_batch:deleted.data.delete_batch})).status,200);
        assert.equal((await usage(owner)).data.usage.retained,4);
    });
    await check('over-quota text growth rolls back the task and its conditional version',async()=>{
        const task=(await api(owner,`/api/tasks?workspace_id=${workspace}`)).data[0];
        const result=await api(owner,`/api/tasks/${task.id}`,'PUT',{notes:'z'.repeat(501)},task.version);assert.equal(result.status,422);
        const current=(await api(owner,`/api/tasks/${task.id}`)).data;assert.equal(current.version,task.version);assert.equal(current.notes,task.notes);
    });
    await check('recurring completion at quota rolls back both completion and successor; disabling recurrence permits completion',async()=>{
        const task=(await api(owner,`/api/tasks?workspace_id=${workspace}`)).data[0];
        const due=new Date(Date.now()+86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const setup=await api(owner,`/api/tasks/${task.id}`,'PUT',{completed:false,recurrence:'daily',due_date:due},task.version);assert.equal(setup.status,200,JSON.stringify(setup.data));
        assert.equal((await api(owner,`/api/tasks/${task.id}`,'PUT',{completed:true},setup.data.version)).status,422);
        const current=(await api(owner,`/api/tasks/${task.id}`)).data;assert.equal(current.completed,false);assert.equal(current.version,setup.data.version);assert.equal((await usage(owner)).data.usage.retained,4);
        assert.equal((await api(owner,`/api/tasks/${task.id}`,'PUT',{completed:true,recurrence:'none'},current.version)).status,200);
    });
    await check('existing overages survive reads/export and can shrink without blocking unrelated edits',async()=>{
        const extra=id('tasks','imported');await sql(`CREATE ${extra} SET user_id=${owner.id},workspace_id=${workspace},title='Old retained data',notes='${'a'.repeat(700)}';`);
        const before=(await usage(owner)).data.usage;assert.equal(before.retained,5);assert.ok(before.text_bytes>500);
        const changed=await api(owner,`/api/tasks/${extra}`,'PUT',{priority:'high'},0);assert.equal(changed.status,200);
        const smaller=await api(owner,`/api/tasks/${extra}`,'PUT',{notes:'a'.repeat(600)},changed.data.version);assert.equal(smaller.status,200);assert.ok((await usage(owner)).data.usage.text_bytes>500);
        assert.equal((await api(owner,`/api/tasks/${extra}`,'PUT',{notes:'a'.repeat(601)},smaller.data.version)).status,422);
        const exported=await api(owner,'/api/export');assert.equal(exported.status,200);assert.ok(exported.data.tasks.some(t=>t.id===extra));
        assert.equal((await api(owner,`/api/tasks/${extra}`,'PUT',{notes:''},smaller.data.version)).status,200);
    });
    await check('own legacy usage is separate, foreign legacy is not exposed, and legacy growth is fenced',async()=>{
        const legacy=id('tasks','legacy');await sql(`CREATE ${legacy} SET user_id=${owner.id},title='Legacy',notes='${'b'.repeat(501)}';CREATE ${id('tasks','foreign')} SET user_id=${outside.id},title='Foreign',notes='${'c'.repeat(600)}';`);
        const read=(await usage(owner)).data.usage;assert.equal(read.legacy_retained,1);assert.equal(read.legacy_text_bytes,507);assert.equal((await usage(viewer)).data.usage.legacy_retained,0);
        assert.equal((await api(owner,`/api/tasks/${legacy}`,'PUT',{notes:'b'.repeat(502)},0)).status,422);
        assert.equal((await api(owner,`/api/tasks/${legacy}`,'PUT',{notes:'short'},0)).status,200);
    });
    const byteWorkspace=id('workspaces','bytes'),byteTasks=[id('tasks','bytes0'),id('tasks','bytes1')];
    await sql(`CREATE ${byteWorkspace} SET owner_id=${member.id},name='Byte quota fixture';`);
    for(const p of [owner,member])await sql(`CREATE workspace_members SET user_id=${p.id},workspace_id=${byteWorkspace},role='member';`);
    for(const task of byteTasks)await sql(`CREATE ${task} SET user_id=${owner.id},workspace_id=${byteWorkspace},title='Byte task';`);
    await check('concurrent text growth on different tasks cannot bypass the shared byte budget',async()=>{
        const results=await Promise.all([owner,member].map((p,i)=>api(p,`/api/tasks/${byteTasks[i]}`,'PUT',{notes:'x'.repeat(300)},0)));
        assert.equal(results.filter(r=>r.status===200).length,1);assert.ok(results.every(r=>[200,409,422].includes(r.status)),JSON.stringify(results));
        const result=await api(owner,`/api/workspaces/${byteWorkspace}/usage`);assert.equal(result.status,200);assert.equal(result.data.usage.text_bytes,318);assert.equal(result.data.usage.retained,2);
    });
    await check('recurrence text overflow rolls back even when another task slot remains',async()=>{
        const task=(await api(owner,`/api/tasks?workspace_id=${byteWorkspace}`)).data.find(t=>t.notes.length===300);
        const due=new Date(Date.now()+86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const setup=await api(owner,`/api/tasks/${task.id}`,'PUT',{recurrence:'daily',due_date:due},task.version);assert.equal(setup.status,200,JSON.stringify(setup.data));
        const denied=await api(owner,`/api/tasks/${task.id}`,'PUT',{completed:true},setup.data.version);assert.equal(denied.status,422);assert.match(denied.data.error,/text quota/);
        const current=(await api(owner,`/api/tasks/${task.id}`)).data;assert.equal(current.completed,false);assert.equal(current.version,setup.data.version);
        const result=await api(owner,`/api/workspaces/${byteWorkspace}/usage`);assert.equal(result.data.usage.retained,2);assert.equal(result.data.usage.text_bytes,318);
    });
    await check('owned-workspace cap counts all owned spaces and serializes concurrent creation',async()=>{
        const one=await api(owner,'/api/workspaces','POST',{name:'Second owned'});assert.equal(one.status,201);
        const results=await Promise.all([1,2,3].map(i=>api(owner,'/api/workspaces','POST',{name:`Last slot ${i}`})));
        assert.equal(results.filter(r=>r.status===201).length,1);assert.ok(results.every(r=>[201,409,422].includes(r.status)));
        assert.equal((await api(owner,'/api/workspaces','POST',{name:'No fourth'})).status,422);assert.equal((await usage(owner)).data.usage.owned_workspaces,3);
    });
    await check('revocation denies later usage reads rather than leaking stale counts',async()=>{
        await sql(`DELETE workspace_members WHERE workspace_id=${workspace} AND user_id=${viewer.id};`);assert.equal((await usage(viewer)).status,403);
    });
    if(process.env.RUN_UI==='1'){
        const {chromium}=await import('playwright-core');let executablePath=process.env.CHROME_PATH;
        for(const root of [`${process.env.HOME}/.cache/ms-playwright`,'/ms-playwright'])if(!executablePath&&fs.existsSync(root))for(const dir of fs.readdirSync(root))for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']){const p=`${root}/${dir}/${rel}`;if(fs.existsSync(p))executablePath=p;}
        const browser=await chromium.launch({executablePath,args:['--no-sandbox']});
        try{
            const context=await browser.newContext({viewport:{width:320,height:900},isMobile:true,hasTouch:true});await context.addCookies([{name:'session_token',value:owner.token,url:base.origin,httpOnly:true},{name:'csrf_token',value:owner.csrf,url:base.origin}]);
            const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(ws=>localStorage.setItem('workspaceId',ws),workspace);await page.goto(base.origin,{waitUntil:'networkidle'});await page.waitForFunction(()=>state.user&&!state.loading);
            await check('usage panel explains retained trash and separates own legacy; mobile and focus work',async()=>{
                await page.evaluate(()=>openUsage());await page.waitForFunction(()=>!usageAbort);assert.match(await page.locator('#usageStatus').textContent(),/At or above/);assert.match(await page.locator('#usageList').textContent(),/5 \/ 4/);assert.match(await page.locator('#usageList').textContent(),/legacy/);assert.equal(await page.evaluate(()=>document.activeElement.id),'usageStatus');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
            });
            await check('usage outage clears prior figures and offers explicit retry without inventing zero usage',async()=>{
                await page.route('**/usage',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic usage outage"}'}));await page.click('#refreshUsage');await page.waitForFunction(()=>!usageAbort);assert.equal(await page.locator('#usageList li').count(),0);assert.match(await page.locator('#usageStatus').textContent(),/outage/);await page.unroute('**/usage');await page.click('#refreshUsage');await page.waitForFunction(()=>!usageAbort);assert.ok(await page.locator('#usageList li').count()>0);
            });
            await check('quota rejection preserves inline draft and does not report a saved task',async()=>{
                await page.keyboard.press('Escape');await page.locator('[data-act="edit"]').first().click();await page.fill('.task-edit [data-field="notes"]','rejected draft '.repeat(70));await page.locator('.task-edit button[type="submit"]').click();await page.waitForFunction(()=>pendingTaskWrites.size===0);assert.ok(await page.locator('.task-edit').isVisible());assert.equal(await page.inputValue('.task-edit [data-field="notes"]'),'rejected draft '.repeat(70));await page.keyboard.press('Escape');
            });
            await check('close and logout fence late usage responses and clear private figures',async()=>{
                for(const action of ['close','logout'])assert.ok(await page.evaluate(async action=>{showModal('usageModal');const original=window.fetch;let finish;window.fetch=()=>new Promise(resolve=>{finish=resolve;});try{const pending=loadUsage();if(action==='close')hideModal('usageModal');else showLoggedOut();finish(new Response(JSON.stringify({workspace_id:state.currentWorkspaceId,usage:{retained:999},limits:{tasks:4,text_bytes:500,workspaces:3}}),{headers:{'Content-Type':'application/json'}}));await pending;return !usageAbort&&document.getElementById('usageList').children.length===0&&document.getElementById('usageWorkspace').textContent==='';}finally{window.fetch=original;}},action));
                assert.deepEqual(errors,[]);
            });
        }finally{await browser.close();}
    }
    // A bounded synthetic mixed workload on the normal-limit test app, not prod.
    await check('four concurrent synthetic clients exercise read/search/write conflicts without unexpected server failures',async()=>{
        const loadWs=id('workspaces','load');await sql(`CREATE ${loadWs} SET owner_id=${owner.id},name='Synthetic load';`);
        for(const p of people.slice(0,4))await sql(`CREATE workspace_members SET user_id=${p.id},workspace_id=${loadWs},role='member';`);
        for(let start=0;start<1000;start+=200)await sql('BEGIN TRANSACTION;'+Array.from({length:200},(_,n)=>`CREATE ${id('tasks','load'+(start+n))} SET user_id=${owner.id},workspace_id=${loadWs},title='Load task ${start+n}',notes='Synthetic text';`).join('')+'COMMIT TRANSACTION;');
        const samples=[],statuses={};const started=performance.now();
        await Promise.all(people.slice(0,4).map(async(p,client)=>{for(let i=0;i<12;i++){const begin=performance.now();let r;
            if(i%3===0)r=await api(p,`/api/tasks?page=1&workspace_id=${loadWs}`,'GET',undefined,undefined,main);
            else if(i%3===1)r=await api(p,'/api/tasks/search','POST',{workspace_id:loadWs,q:'Synthetic',limit:50},undefined,main);
            else r=await api(p,'/api/tasks','POST',{workspace_id:loadWs,title:`Client ${client} operation ${i}`},undefined,main);
            samples.push(performance.now()-begin);statuses[r.status]=(statuses[r.status]||0)+1;
            assert.ok((i%3===0?[200]:i%3===1?[200,503]:[201,409]).includes(r.status),JSON.stringify(r));
        }}));
        const elapsed=performance.now()-started;samples.sort((a,b)=>a-b);assert.equal(samples.length,48);assert.ok(statuses[200]>0&&statuses[201]>0);
        console.log(`Mixed load: 4 clients, 1000 initial tasks, 48 requests in ${Math.round(elapsed)}ms; ${(48000/elapsed).toFixed(2)} requests/s; p50=${Math.round(samples[24])}ms p95=${Math.round(samples[45])}ms max=${Math.round(samples.at(-1))}ms; statuses=${JSON.stringify(statuses)}. Synthetic localhost, not an SLA or production capacity guarantee.`);
    });
    console.log(`Quota suite: ${passed} checks passed`);
}catch(error){console.error('Quota fixture failed; recent synthetic app log:',log);throw error;}
finally{app.kill('SIGTERM');await new Promise(resolve=>{if(app.exitCode!==null)return resolve();const timer=setTimeout(()=>app.kill('SIGKILL'),10000);app.once('exit',()=>{clearTimeout(timer);resolve();});});}
