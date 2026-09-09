// Optimistic concurrency fixtures. No production mutation or real SMTP.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { request } from 'node:http';
import fs from 'node:fs';
const base = new URL(process.env.BASE_URL), database = new URL(process.env.TEST_DB_URL);
for (const target of [base,database]) {assert.equal(target.protocol,'http:');assert.equal(target.hostname,'127.0.0.1');assert.ok(target.port && !['9000','8010'].includes(target.port));}
const run=randomBytes(6).toString('hex'), id=(table,name)=>`${table}:version_${run}_${name}`;
const hash=value=>createHash('sha256').update(value).digest('hex');
async function sql(body) {
    const response=await fetch(new URL('/sql',database),{method:'POST',headers:{Authorization:`Basic ${Buffer.from('itroot:itpass').toString('base64')}`,Accept:'application/json','surreal-ns':'taskmanager_it','surreal-db':'main'},body});
    assert.equal(response.status,200);const rows=await response.json();for(const row of rows)assert.equal(row.status,'OK',row.result);return rows.at(-1).result;
}
const people={};
for(const name of ['owner','viewer','outside','assignee','browser']) {
    const person=people[name]={id:id('users',name),token:randomBytes(32).toString('hex'),csrf:randomBytes(32).toString('hex')};
    await sql(`CREATE ${person.id} SET name = '${name}', email = '${name}-${run}@example.invalid', password_hash = 'reset-required', email_verified = true;
        CREATE sessions SET user_id = ${person.id}, token = '${hash(person.token)}', csrf_hash = '${hash(person.csrf)}', expires_at = time::now() + 1h;`);
}
const {owner,viewer,outside,assignee}=people, workspace=id('workspaces','primary');
await sql(`CREATE ${workspace} SET name = 'Version fixture', owner_id = ${owner.id};`);
for(const [name,role] of [['owner','owner'],['viewer','viewer'],['assignee','member']])await sql(`CREATE workspace_members SET workspace_id = ${workspace}, user_id = ${people[name].id}, role = '${role}';`);
function api(person,path,method='GET',body,tag,csrf=true) {
    const payload=body===undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve,reject)=>{
        const req=request(new URL(path,base),{method,localAddress:'127.0.0.6',timeout:15000,headers:{'Content-Type':'application/json',...(payload===undefined?{}:{'Content-Length':Buffer.byteLength(payload)}),...(tag===undefined?{}:{'If-Match':tag}),...(person?{Cookie:`session_token=${person.token}`,...(csrf?{'X-CSRF-Token':person.csrf}:{})}:{})}},res=>{
            const chunks=[];res.on('data',x=>chunks.push(x));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks).toString())});}catch(e){reject(e);}});
        });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('fixture timeout')));req.end(payload);
    });
}
let passed=0;async function check(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
const created=await api(owner,'/api/tasks','POST',{title:'Original',notes:'Original notes',workspace_id:workspace,assignee_id:assignee.id});assert.equal(created.status,201);
const task=created.data, path=`/api/tasks/${task.id}`;
const read=()=>api(owner,path), write=async body=>{const current=await read();return api(owner,path,'PUT',body,current.headers.etag);};
await check('create and scoped single-task read return matching strong versions and no-store',async()=>{
    assert.equal(task.version,0);assert.equal(created.headers.etag,'"v0"');
    const current=await read();assert.deepEqual(current.data,task);assert.equal(current.headers.etag,created.headers.etag);assert.equal(current.headers['cache-control'],'no-store');
    assert.equal((await api(null,path)).status,401);assert.equal((await api(outside,path)).status,404);assert.equal((await api(viewer,path)).status,200);
});
await check('missing or non-specific preconditions cannot mutate tasks',async()=>{
    for(const method of ['PUT','DELETE'])assert.equal((await api(owner,path,method)).status,428);
    for(const tag of ['*','W/"v0"','v0','"v00"','"v-1"','"v0", "v1"','"v9007199254740992"'])assert.equal((await api(owner,path,'PUT',{notes:'Do not write'},tag)).status,400,tag);
    assert.equal((await read()).data.version,0);
});
await check('a stale edit or deletion cannot overwrite a newer successful edit',async()=>{
    const saved=await api(owner,path,'PUT',{title:'Newer title'},created.headers.etag);assert.equal(saved.status,200);assert.equal(saved.data.version,1);assert.equal(saved.headers.etag,'"v1"');
    assert.equal((await api(owner,path,'PUT',{notes:'Stale notes'},created.headers.etag)).status,412);
    assert.equal((await api(owner,path,'DELETE',undefined,created.headers.etag)).status,412);
    assert.equal((await read()).data.notes,'Original notes');
});
await check('concurrent same-version edits have one winner without automatic replay',async()=>{
    const current=await read();
    const results=await Promise.all([1,2,3,4].map(n=>api(owner,path,'PUT',{notes:`Concurrent ${n}`},current.headers.etag)));
    assert.equal(results.filter(r=>r.status===200).length,1);assert.ok(results.every(r=>[200,409,412].includes(r.status)));
    const after=await read();assert.equal(after.data.version,current.data.version+1);
    assert.equal((await api(owner,path,'PUT',{notes:'Late replay'},current.headers.etag)).status,412);
    assert.equal((await read()).data.version,after.data.version);
});
await check('bodyless toggle is conditional and cannot reverse itself on replay',async()=>{
    const current=await read(), result=await api(owner,path,'PUT',undefined,current.headers.etag);assert.equal(result.status,200);assert.equal(result.data.completed,!current.data.completed);
    assert.equal((await api(owner,path,'PUT',undefined,current.headers.etag)).status,412);
    assert.equal((await read()).data.completed,result.data.completed);
});
await check('versions never replace role authorization or CSRF',async()=>{
    const tag=(await read()).headers.etag;
    assert.equal((await api(viewer,path,'PUT',{notes:'Denied'},tag)).status,403);
    assert.equal((await api(outside,path,'DELETE',undefined,tag)).status,403);
    assert.equal((await api(owner,path,'PUT',{notes:'Denied'},tag,false)).status,403);
});
await check('delete and restore advance parent and child versions without changing business metadata',async()=>{
    const child=(await api(owner,'/api/tasks','POST',{title:'Child',workspace_id:workspace,parent_id:task.id})).data;
    const before=await read();const deleted=await api(owner,path,'DELETE',undefined,before.headers.etag);assert.equal(deleted.status,200);assert.equal((await read()).status,404);
    assert.equal((await api(owner,`/api/trash/${task.id}`,'POST',{delete_batch:deleted.data.delete_batch})).status,200);
    const after=await read(), kid=await api(owner,`/api/tasks/${child.id}`);
    assert.equal(after.data.version,before.data.version+2);assert.equal(kid.data.version,child.version+2);
    assert.equal(after.data.updated_at,before.data.updated_at);assert.equal(after.data.notes,before.data.notes);
    assert.equal((await api(owner,path,'PUT',{title:'Pre-delete draft'},before.headers.etag)).status,412);
});
await check('membership cleanup invalidates a form containing an old assignment',async()=>{
    const before=await read();
    assert.equal((await api(owner,`/api/workspaces/${workspace}/members`,'DELETE',{user_id:assignee.id})).status,200);
    const after=await read();assert.equal(after.data.assignee_id,null);assert.ok(after.data.version>before.data.version);
    assert.equal((await api(owner,path,'PUT',{notes:'Old draft'},before.headers.etag)).status,412);
});
await check('failed task update rolls back both the content and its version',async()=>{
    const before=await read(), event=`version_fail_${run}`;
    await sql(`DEFINE EVENT ${event} ON TABLE tasks WHEN $event = 'UPDATE' AND $after.id = ${task.id} AND $after.notes = 'Injected failure' THEN { THROW 'Synthetic update failure'; };`);
    try {assert.equal((await api(owner,path,'PUT',{notes:'Injected failure'},before.headers.etag)).status,500);assert.deepEqual((await read()).data,before.data);}
    finally {await sql(`REMOVE EVENT ${event} ON TABLE tasks;`);}
});
await check('version is server-controlled and retained by export',async()=>{
    const before=await read(), result=await write({notes:'Valid update',version:99999});assert.equal(result.status,200);assert.equal(result.data.version,before.data.version+1);
    const exported=await api(owner,'/api/export');assert.equal(exported.data.tasks.find(row=>row.id===task.id).version,result.data.version);
});

if(process.env.RUN_UI==='1') {
    const {chromium}=await import('playwright-core');let executablePath=process.env.CHROME_PATH;
    for(const root of [`${process.env.HOME}/.cache/ms-playwright`,'/ms-playwright'])if(!executablePath&&fs.existsSync(root))for(const dir of fs.readdirSync(root))for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']){const file=`${root}/${dir}/${rel}`;if(fs.existsSync(file))executablePath=file;}
    const browser=await chromium.launch({executablePath,args:['--no-sandbox']});
    try {
        const user=people.browser, ws=id('workspaces','browser'), record=id('tasks','browser');
        await sql(`CREATE ${ws} SET name = 'Two-tab fixture', owner_id = ${user.id}; CREATE workspace_members SET workspace_id = ${ws}, user_id = ${user.id}, role = 'owner'; CREATE ${record} SET workspace_id = ${ws}, user_id = ${user.id}, title = 'Shared original', notes = 'Initial notes';`);
        const context=await browser.newContext({viewport:{width:320,height:900},isMobile:true,hasTouch:true});
        await context.addCookies([{name:'session_token',value:user.token,url:base.origin,httpOnly:true},{name:'csrf_token',value:user.csrf,url:base.origin}]);
        const a=await context.newPage(), b=await context.newPage(), errors=[];for(const p of [a,b])p.on('pageerror',e=>errors.push(e.message));
        await Promise.all([a,b].map(p=>p.goto(base.origin,{waitUntil:'networkidle'})));
        const edit=async p=>{await p.locator(`[data-act="edit"][data-id="${record}"]`).click();};
        const save=async p=>p.locator('.task-edit button[type="submit"]').click();
        const current=()=>api(user,`/api/tasks/${record}`);
        await check('two-tab conflict preserves the draft, disables resubmission and survives rerender',async()=>{
            await edit(a);await a.fill('.task-edit [data-field="notes"]','My private draft');
            await b.evaluate(id=>changeTask(id,{title:'Remote <img src=x onerror=alert(1)>'}),record);
            await save(a);await a.waitForSelector('.task-conflict');
            assert.equal(await a.inputValue('.task-edit [data-field="notes"]'),'My private draft');
            await a.evaluate(()=>renderTasks());assert.equal(await a.inputValue('.task-edit [data-field="notes"]'),'My private draft');
            assert.ok(await a.locator('.task-edit button[type="submit"]').isDisabled());
            assert.equal((await current()).data.notes,'Initial notes');
        });
        await check('conflict review can fail and retry safely, escapes remote text and fits a phone',async()=>{
            await a.route('**/api/tasks/*',route=>route.request().method()==='GET'?route.fulfill({status:503,contentType:'application/json',body:'{"error":"Fixture unavailable"}'}):route.continue());
            await a.click('[data-act="review-conflict"]');await a.waitForFunction(()=>document.querySelector('.task-conflict').textContent.includes('Fixture unavailable'));
            assert.equal(await a.inputValue('.task-edit [data-field="notes"]'),'My private draft');
            await a.unroute('**/api/tasks/*');await a.click('[data-act="review-conflict"]');await a.waitForSelector('.conflict-latest');
            assert.ok((await a.locator('.conflict-latest').textContent()).includes('<img'));
            assert.equal(await a.locator('.conflict-latest img').count(),0);
            assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
            assert.ok(await a.evaluate(()=>document.activeElement.hasAttribute('data-conflict-status')));
        });
        await check('manual rebase keeps only edited fields and still rejects another intervening edit',async()=>{
            await b.evaluate(id=>changeTask(id,{priority:'high'}),record);
            await a.click('[data-act="keep-draft"]');assert.equal(await a.inputValue('.task-edit [data-field="notes"]'),'My private draft');
            assert.match(await a.inputValue('.task-edit [data-field="title"]'),/^Remote/);
            await save(a);await a.waitForSelector('.task-conflict');assert.equal((await current()).data.notes,'Initial notes');
            await a.click('[data-act="review-conflict"]');await a.waitForSelector('.conflict-latest');await a.click('[data-act="keep-draft"]');
            assert.equal(await a.inputValue('.task-edit [data-field="priority"]'),'high');
            const version=(await current()).data.version;await save(a);await a.waitForSelector('.task-edit',{state:'detached'});
            const result=await current();assert.equal(result.data.version,version+1);assert.equal(result.data.notes,'My private draft');assert.equal(result.data.priority,'high');assert.match(result.data.title,/^Remote/);
        });
        await check('using the current version replaces the editor without silently saving it',async()=>{
            await edit(a);await a.fill('.task-edit [data-field="notes"]','Discard this draft');
            await b.evaluate(()=>loadTasks());await b.evaluate(id=>changeTask(id,{notes:'Latest remote notes'}),record);
            await save(a);await a.waitForSelector('.task-conflict');await a.click('[data-act="review-conflict"]');await a.waitForSelector('.conflict-latest');
            const version=(await current()).data.version;await a.click('[data-act="use-latest"]');
            assert.equal(await a.inputValue('.task-edit [data-field="notes"]'),'Latest remote notes');assert.equal((await current()).data.version,version);
            await a.click('[data-act="cancel-edit"]');
        });
        await check('stale checkbox and deletion do not mutate or replay automatically',async()=>{
            await b.evaluate(id=>changeTask(id,{notes:'Ahead of checkbox'}),record);
            const before=(await current()).data;await a.evaluate(id=>toggleTask(id),record);
            assert.equal((await current()).data.version,before.version);assert.equal((await current()).data.completed,before.completed);
            await a.evaluate(()=>loadTasks());await a.evaluate(id=>toggleTask(id),record);
            await b.evaluate(id=>deleteTask(id),record);assert.equal((await current()).status,200);
            assert.ok(await b.evaluate(id=>state.tasks.some(t=>t.id===id),record));
        });
        await check('bulk completion reports partial failure without overwriting a stale row',async()=>{
            const second=id('tasks','second');await sql(`CREATE ${second} SET workspace_id = ${ws}, user_id = ${user.id}, title = 'Second task';`);
            await Promise.all([a,b].map(p=>p.evaluate(()=>loadTasks())));
            await b.evaluate(id=>changeTask(id,{notes:'Ahead of bulk'}),record);
            const version=(await current()).data.version;
            await a.evaluate(async ids=>{state.selection=new Set(ids);await bulkApply('complete');},[record,second]);
            assert.equal((await current()).data.version,version);assert.equal((await api(user,`/api/tasks/${second}`)).data.completed,true);
            assert.ok((await a.locator('#toastRegion').textContent()).includes('1 updated, 1 failed'));
        });
        await check('refresh preserves drafts and logout removes them without browser storage',async()=>{
            await edit(a);await a.fill('.task-edit [data-field="notes"]','Never persist this private draft');await a.evaluate(()=>loadTasks());
            assert.equal(await a.inputValue('.task-edit [data-field="notes"]'),'Never persist this private draft');
            assert.ok(await a.evaluate(()=>!Object.values(localStorage).some(value=>value.includes('Never persist this private draft'))));
            await a.evaluate(()=>showLoggedOut());assert.equal(await a.evaluate(()=>taskDrafts.size),0);assert.equal(await a.locator('.task-edit').count(),0);
        });
        await check('two-tab workflow has no uncaught browser errors',async()=>assert.deepEqual(errors,[]));
    } finally {await browser.close();}
}
console.log(`${passed} task version checks passed`);
