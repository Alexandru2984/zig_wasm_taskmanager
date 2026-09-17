// Synthetic accounts on the disposable harness only; never production ports/SMTP.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {request} from 'node:http';
import fs from 'node:fs';
const base=new URL(process.env.BASE_URL),database=new URL(process.env.TEST_DB_URL);
for(const url of [base,database]){assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');assert.ok(url.port&&!['9000','8010'].includes(url.port));}
const run=randomBytes(6).toString('hex'),id=(table,name)=>`${table}:archive_${run}_${name}`,hash=x=>createHash('sha256').update(x).digest('hex');
const password=`Aa1${randomBytes(24).toString('hex')}`;
async function sql(body){const r=await fetch(new URL('/sql',database),{method:'POST',headers:{Authorization:'Basic '+Buffer.from('itroot:itpass').toString('base64'),Accept:'application/json','surreal-ns':'taskmanager_it','surreal-db':'main'},body});assert.equal(r.status,200);const rows=await r.json();for(const row of rows)assert.equal(row.status,'OK',row.result);return rows.at(-1).result;}
function api(user,path,method='GET',body,{csrf=true,version}={}) {
    const payload=body===undefined?undefined:JSON.stringify(body);
    return new Promise((resolve,reject)=>{const req=request(new URL(path,base),{method,localAddress:'127.0.0.13',timeout:30000,headers:{'Content-Type':'application/json',...(payload===undefined?{}:{'Content-Length':Buffer.byteLength(payload)}),...(version===undefined?{}:{'If-Match':`"v${version}"`}),...(user?{Cookie:`session_token=${user.token}`,...(csrf?{'X-CSRF-Token':user.csrf}:{})}:{})}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks).toString())});}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Archive fixture timeout')));req.end(payload);});
}
const seed=`archive-seed-${run}@example.invalid`;
assert.equal((await api(null,'/api/auth/signup','POST',{email:seed,name:'Archive seed',password})).status,201);
const passwordHash=(await sql(`SELECT password_hash FROM users WHERE email = '${seed}';`))[0].password_hash;
let serial=0,passed=0;
async function fixture(){
    const n=++serial,f={ws:id('workspaces',n),task:id('tasks',n),trash:id('tasks',n+'_trash')};
    let body=`CREATE ${f.ws} SET name = 'Archive fixture', owner_id = ${id('users',n+'_owner')};`;
    for(const role of ['owner','admin','member','viewer','outside']){
        const u=f[role]={id:id('users',n+'_'+role),email:`${n}-${role}-${run}@example.invalid`,token:randomBytes(32).toString('hex'),csrf:randomBytes(32).toString('hex')};
        body+=`CREATE ${u.id} SET name = '${role}', email = '${u.email}', password_hash = ${JSON.stringify(passwordHash)}, email_verified = true; CREATE sessions SET user_id = ${u.id}, token = '${hash(u.token)}', csrf_hash = '${hash(u.csrf)}', expires_at = time::now() + 1h;`;
        if(role!=='outside')body+=`CREATE workspace_members SET user_id = ${u.id}, workspace_id = ${f.ws}, role = '${role}';`;
    }
    body+=`CREATE ${f.task} SET user_id = ${f.owner.id}, workspace_id = ${f.ws}, title = 'Retained task', notes = 'Preserved notes', assignee_id = ${f.member.id}, recurrence = 'daily', due_date = time::now() + 1d; CREATE ${f.trash} SET user_id = ${f.owner.id}, workspace_id = ${f.ws}, title = 'Retained trash', deleted_at = time::unix(), delete_batch = '${'a'.repeat(64)}';`;
    await sql(body);return f;
}
const archive=(f,archived=true,version=0,user=f.owner,options)=>api(user,`/api/workspaces/${f.ws}/archive`,'POST',{archived,expected_version:version},options);
const workspace=async f=>(await sql(`SELECT * FROM ${f.ws};`))[0];
const tasks=f=>sql(`SELECT * FROM tasks WHERE workspace_id = ${f.ws} ORDER BY id;`);
async function check(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
await check('archive and unarchive preserve task contents, ownership, versions and retained quota',async()=>{
    const f=await fixture(),before=await tasks(f),usage=(await api(f.owner,`/api/workspaces/${f.ws}/usage`)).data;
    const r=await archive(f);assert.equal(r.status,200);assert.deepEqual(r.data,{id:f.ws,archived:true,archive_version:1});assert.equal(r.headers['cache-control'],'no-store');
    assert.deepEqual(await tasks(f),before);assert.equal((await workspace(f)).owner_id,f.owner.id);assert.ok((await workspace(f)).archived_at);
    assert.deepEqual((await api(f.owner,`/api/workspaces/${f.ws}/usage`)).data,usage);
    const listed=(await api(f.viewer,'/api/workspaces')).data.find(w=>w.id===f.ws);assert.equal(listed.archived,true);assert.equal(listed.archive_version,1);
    assert.equal((await archive(f,false,1,f.admin)).status,200);assert.deepEqual(await tasks(f),before);assert.equal((await workspace(f)).archived,false);assert.equal((await workspace(f)).archive_version,2);
    const events=await sql(`SELECT action FROM activity_events WHERE entity_id = '${f.ws}';`);assert.deepEqual(events.map(x=>x.action).sort(),['archive_workspace','unarchive_workspace']);
});
await check('archive requires session, CSRF, admin role, a typed ID and POST',async()=>{
    const f=await fixture();assert.equal((await archive(f,true,0,null)).status,401);assert.equal((await archive(f,true,0,f.owner,{csrf:false})).status,403);
    for(const role of ['member','viewer','outside'])assert.equal((await archive(f,true,0,f[role])).status,403);
    const wrongMethod=await api(f.owner,`/api/workspaces/${f.ws}/archive`);assert.equal(wrongMethod.status,405);assert.equal(wrongMethod.headers.allow,'POST');
    assert.equal((await api(f.owner,`/api/workspaces/${f.owner.id}/archive`,'POST',{archived:true,expected_version:0})).status,400);assert.equal((await workspace(f)).archived,false);
});
await check('missing, unsafe and stale archive revisions fail without side effects or replay',async()=>{
    const f=await fixture();for(const body of [{archived:true},{archived:'yes',expected_version:0},{archived:true,expected_version:-1},{archived:true,expected_version:1.5},{archived:true,expected_version:9007199254740991}])assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/archive`,'POST',body)).status,400);
    assert.equal((await archive(f,true,9)).status,409);assert.equal((await archive(f,false,0)).status,409);assert.equal((await archive(f)).status,200);assert.equal((await archive(f)).status,409);
    assert.equal((await archive(f,false,1)).status,200);assert.equal((await archive(f,true,0)).status,409);assert.equal((await workspace(f)).archive_version,2);
});
await check('all task write routes, recurrence, subtasks, restore, rename and ownership transfer are blocked',async()=>{
    const f=await fixture(),before=await tasks(f);assert.equal((await archive(f)).status,200);
    for(const user of [f.owner,f.admin,f.member]){
        assert.equal((await api(user,'/api/tasks','POST',{workspace_id:f.ws,title:'Denied'})).status,423);
        assert.equal((await api(user,'/api/tasks','POST',{workspace_id:f.ws,parent_id:f.task,title:'Denied child'})).status,423);
        for(const [method,body] of [['PUT',{title:'Denied edit'}],['PUT',{}],['PUT',{status:'done'}],['DELETE',undefined]])assert.equal((await api(user,`/api/tasks/${f.task}`,method,body,{version:0})).status,423);
        assert.equal((await api(user,`/api/trash/${f.trash}`,'POST',{})).status,423);
    }
    assert.equal((await api(f.admin,`/api/workspaces/${f.ws}`,'PATCH',{name:'Denied rename',expected_name:'Archive fixture'})).status,423);
    assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/owner`,'POST',{user_id:f.member.id,password})).status,423);
    assert.deepEqual(await tasks(f),before);assert.equal((await workspace(f)).name,'Archive fixture');
});
await check('archive shares the account task-write budget and rejects excess attempts without a transition',async()=>{
    const f=await fixture();for(let n=0;n<60;n++)assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/archive`,'POST',{})).status,400);
    const r=await archive(f);assert.equal(r.status,429);assert.equal(r.headers['retry-after'],'60');assert.equal((await workspace(f)).archived,false);
    assert.equal((await api(f.owner,'/api/tasks','POST',{workspace_id:f.ws,title:'Budget exhausted'})).status,429);
});
await check('archived data remains readable and exported but outsiders gain no visibility',async()=>{
    const f=await fixture();await archive(f);
    for(const user of [f.owner,f.admin,f.member,f.viewer]){
        assert.equal((await api(user,`/api/tasks/${f.task}`)).status,200);assert.equal((await api(user,`/api/trash?workspace_id=${f.ws}`)).status,200);
        assert.equal((await api(user,`/api/workspaces/${f.ws}/directory`)).status,200);
    }
    assert.equal((await api(f.outside,`/api/tasks/${f.task}`)).status,404);
    const exported=await api(f.owner,'/api/export');assert.equal(exported.status,200);assert.ok(JSON.stringify(exported.data).includes(f.task));assert.equal(exported.data.workspaces.find(w=>w.id===f.ws).archived,true);
});
async function invitation(f){
    const invite=id('workspace_invites',serial),token=randomBytes(32).toString('hex'),job=id('mail_outbox',serial);
    await sql(`CREATE ${invite} SET workspace_id = ${f.ws}, email = '${f.outside.email}', role = 'member', token = '${hash(token)}', invited_by = ${f.owner.id}, expires_at = time::unix() + 3600;
        CREATE ${job} SET owner_id = ${f.owner.id}, reference_id = ${invite}, kind = 'workspace_invite', encrypted_payload = 'synthetic-encrypted', secret_hash = '${hash(token)}', expires_at = time::unix() + 3600;`);
    return {invite,token,job};
}
await check('archive atomically cancels unaccepted invitations and erases pending mail secrets permanently',async()=>{
    const f=await fixture(),i=await invitation(f);assert.equal((await archive(f)).status,200);
    assert.equal((await sql(`SELECT * FROM ${i.invite};`)).length,0);const job=(await sql(`SELECT * FROM ${i.job};`))[0];assert.equal(job.status,'cancelled');assert.equal(job.encrypted_payload,'');assert.equal(job.secret_hash,'');
    assert.equal((await api(f.outside,'/api/workspaces/invites/accept','POST',{token:i.token})).status,404);
    assert.equal((await api(f.admin,`/api/workspaces/${f.ws}/invites`,'POST',{email:'new@example.invalid',role:'member'})).status,423);
    await archive(f,false,1);assert.equal((await api(f.outside,'/api/workspaces/invites/accept','POST',{token:i.token})).status,404);
});
await check('legacy pending grants are denied while archived even if they escaped cancellation',async()=>{
    const f=await fixture();await archive(f);const i=await invitation(f);
    assert.equal((await api(f.outside,'/api/workspaces/invites/accept','POST',{token:i.token})).status,423);
    assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/invites`,'DELETE',{invite_id:i.invite})).status,200);
});
await check('failed history write rolls back archive state, invitation removal and mail cancellation',async()=>{
    const f=await fixture(),i=await invitation(f),event=`archive_failure_${run}`,before=[await workspace(f),await sql(`SELECT * FROM ${i.invite};`),await sql(`SELECT * FROM ${i.job};`)];
    await sql(`DEFINE EVENT ${event} ON TABLE activity_events WHEN $event = 'CREATE' AND $after.action = 'archive_workspace' AND $after.entity_id = '${f.ws}' THEN { THROW 'Synthetic archive failure'; };`);
    try{assert.equal((await archive(f)).status,500);assert.deepEqual([await workspace(f),await sql(`SELECT * FROM ${i.invite};`),await sql(`SELECT * FROM ${i.job};`)],before);}finally{await sql(`REMOVE EVENT ${event} ON TABLE activity_events;`);}
});
await check('two administrators cannot silently replay or reverse a concurrent archive transition',async()=>{
    const f=await fixture(),r=await Promise.all([archive(f),archive(f,true,0,f.admin)]);assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);assert.equal((await workspace(f)).archive_version,1);
});
await check('security access management remains possible while archived without permitting content writes',async()=>{
    const f=await fixture();await archive(f);
    assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/members`,'PUT',{user_id:f.admin.id,role:'viewer'})).status,200);
    assert.equal((await archive(f,false,1,f.admin)).status,403);
    assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/members`,'DELETE',{user_id:f.member.id})).status,200);
    assert.equal((await api(f.member,`/api/tasks/${f.task}`)).status,404);assert.equal((await tasks(f)).find(t=>t.id===f.task).assignee_id,undefined);
});
async function delayWrite(f,table,condition,write,concurrent){
    const event=`archive_delay_${run}_${serial}`;
    await sql(`DEFINE EVENT ${event} ON TABLE ${table} WHEN ${condition} THEN { FOR $n IN 0..48 { LET $unused = crypto::argon2::generate('isolated archive serialization'); }; };`);
    try{let finished=false;const pending=write().finally(()=>{finished=true;});await new Promise(r=>setTimeout(r,500));assert.equal(finished,false);await concurrent();const result=await pending;assert.ok([400,403,404,409,423].includes(result.status),JSON.stringify(result));}
    finally{await sql(`REMOVE EVENT ${event} ON TABLE ${table};`);}
}
await check('archive defeats an in-flight task update through their shared transaction fence',async()=>{
    const f=await fixture();await delayWrite(f,'tasks',`$event = 'UPDATE' AND $after.id = ${f.task} AND $after.title = 'Delayed write'`,()=>api(f.member,`/api/tasks/${f.task}`,'PUT',{title:'Delayed write'},{version:0}),async()=>assert.equal((await archive(f)).status,200));
    assert.equal((await workspace(f)).archived,true);assert.equal((await tasks(f)).find(t=>t.id===f.task).title,'Retained task');
});
await check('archive defeats an in-flight invitation acceptance without leaving a late member',async()=>{
    const f=await fixture(),i=await invitation(f);await delayWrite(f,'workspace_members',`$event = 'CREATE' AND $after.workspace_id = ${f.ws} AND $after.user_id = ${f.outside.id}`,()=>api(f.outside,'/api/workspaces/invites/accept','POST',{token:i.token}),async()=>assert.equal((await archive(f)).status,200));
    assert.equal((await sql(`SELECT id FROM workspace_members WHERE workspace_id = ${f.ws} AND user_id = ${f.outside.id};`)).length,0);
});
await check('administrator revocation defeats an already-started archive',async()=>{
    const f=await fixture();await delayWrite(f,'workspaces',`$event = 'UPDATE' AND $after.id = ${f.ws} AND $after.archived = true AND $before.archived != true`,()=>archive(f,true,0,f.admin),async()=>assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/members`,'PUT',{user_id:f.admin.id,role:'viewer'})).status,200));
    assert.equal((await workspace(f)).archived,false);
});
await check('account deletion remains explicit and follows ownership even for archived workspaces',async()=>{
    const f=await fixture();await archive(f);assert.equal((await api(f.owner,'/api/account','DELETE',{password})).status,200);assert.equal(await workspace(f),undefined);assert.deepEqual(await tasks(f),[]);
});

if(process.env.RUN_UI==='1'){
    const {chromium}=await import('playwright-core');let executablePath=process.env.CHROME_PATH;
    for(const root of [`${process.env.HOME}/.cache/ms-playwright`,'/ms-playwright'])if(!executablePath&&fs.existsSync(root))for(const dir of fs.readdirSync(root))for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']){const file=`${root}/${dir}/${rel}`;if(fs.existsSync(file))executablePath=file;}
    const browser=await chromium.launch({executablePath,args:['--no-sandbox']}),errors=[];
    try{
        async function pageFor(user){const context=await browser.newContext({viewport:{width:320,height:900},isMobile:true,hasTouch:true});await context.addCookies([{name:'session_token',value:user.token,url:base.origin,httpOnly:true},{name:'csrf_token',value:user.csrf,url:base.origin}]);const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base.origin,{waitUntil:'networkidle'});return p;}
        const f=await fixture(),p=await pageFor(f.owner),viewer=await pageFor(f.viewer);
        await check('archive controls require admin role and cancellation leaves state unchanged',async()=>{
            await viewer.evaluate(()=>openWorkspacePanel());assert.ok(!await viewer.locator('#workspaceArchiveControls').isVisible());
            await p.evaluate(()=>openWorkspacePanel());p.once('dialog',d=>d.dismiss());await p.click('#workspaceArchiveAction');assert.equal((await workspace(f)).archived,false);
        });
        await check('phone archive and unarchive flows expose state and keep read-only controls consistent',async()=>{
            p.once('dialog',d=>{assert.ok(d.message().includes('permanently cancelled'));d.accept();});await p.click('#workspaceArchiveAction');await p.waitForFunction(()=>document.getElementById('workspaceArchiveAction').textContent.startsWith('Unarchive'));
            assert.ok(await p.locator('#taskInput').isDisabled());assert.ok(!await p.locator('#workspaceRenameForm').isVisible());assert.ok(!await p.locator('#inviteForm').isVisible());assert.equal(await p.locator('[data-transfer-user]').count(),0);
            assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.ok(await p.locator('#workspaceArchiveNotice').isVisible());
            const dir=process.env.ARCHIVE_ARTIFACT_DIR;if(dir){fs.mkdirSync(dir,{recursive:true,mode:0o700});await p.locator('#workspaceArchiveControls').scrollIntoViewIfNeeded();await p.screenshot({path:`${dir}/archive-mobile.png`});}
            p.once('dialog',d=>d.accept());await p.click('#workspaceArchiveAction');await p.waitForFunction(()=>document.getElementById('workspaceArchiveAction').textContent.startsWith('Archive'));assert.ok(!await p.locator('#taskInput').isDisabled());
        });
        await check('another administrator archive locks stale task writes without losing the local draft',async()=>{
            await p.keyboard.press('Escape');await p.evaluate(task=>startTaskEdit(task),f.task);await p.locator('.task-edit [data-field="notes"]').fill('Unsaved archive draft');await archive(f,true,2,f.admin);
            await p.locator('.task-edit button[type="submit"]').click();await p.waitForFunction(()=>currentWorkspace().archived===true);
            assert.equal(await p.locator('.task-edit [data-field="notes"]').inputValue(),'Unsaved archive draft');assert.ok(await p.locator('.task-edit button[type="submit"]').isDisabled());assert.equal((await tasks(f)).find(t=>t.id===f.task).notes,'Preserved notes');
        });
        await check('a stale archive revision requires fresh review and cannot silently unarchive',async()=>{
            await p.evaluate(()=>openWorkspacePanel());await archive(f,false,3,f.admin);p.once('dialog',d=>d.accept());await p.click('#workspaceArchiveAction');await p.waitForFunction(()=>document.getElementById('workspaceArchiveError').textContent.includes('reopen'));
            assert.ok(await p.locator('#workspaceArchiveAction').isDisabled());assert.equal((await workspace(f)).archived,false);await p.keyboard.press('Escape');await p.evaluate(()=>openWorkspacePanel());
        });
        await check('an invalid success envelope cannot claim an archive was completed',async()=>{
            await p.route('**/archive',r=>r.fulfill({status:200,contentType:'application/json',body:'{}'}));try{p.once('dialog',d=>d.accept());await p.click('#workspaceArchiveAction');await p.waitForFunction(()=>document.getElementById('workspaceArchiveError').textContent.includes('reopen'));assert.equal((await workspace(f)).archived,false);assert.ok(await p.locator('#workspaceArchiveAction').isDisabled());}finally{await p.unroute('**/archive');await p.keyboard.press('Escape');await p.evaluate(()=>openWorkspacePanel());}
        });
        async function delayed(action){let release,arrived,requests=0;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{arrived=r;});await p.route('**/archive',async r=>{requests++;arrived();await gate;await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:f.ws,archived:true,archive_version:5})});});try{p.once('dialog',d=>d.accept());await p.click('#workspaceArchiveAction');await started;await p.evaluate(()=>handleWorkspaceArchive());await action();release();await p.waitForTimeout(100);assert.equal(requests,1);}finally{release();await p.unroute('**/archive');}}
        await check('closing an in-flight archive fences late results and duplicate submits',async()=>{
            await delayed(async()=>p.keyboard.press('Escape'));assert.ok(!await p.locator('#workspaceModal').isVisible());assert.equal(await p.evaluate(()=>currentWorkspace().archived),false);
        });
        await check('account replacement and logout clear archive state and cannot publish delayed changes',async()=>{
            await p.evaluate(()=>openWorkspacePanel());await delayed(async()=>p.evaluate(()=>showLoggedIn({...state.user,id:'users:archive_other_account',name:'Other account'})));assert.equal(await p.locator('#workspaceArchiveHint').textContent(),'');assert.ok(!await p.locator('#workspaceModal').isVisible());
            await p.reload({waitUntil:'networkidle'});await p.evaluate(()=>openWorkspacePanel());await delayed(async()=>p.evaluate(()=>showLoggedOut()));assert.equal(await p.locator('#workspaceArchiveHint').textContent(),'');assert.equal(await p.evaluate(()=>state.workspaces.length),0);assert.ok(!await p.locator('#workspaceArchiveNotice').isVisible());
        });
        await check('archive browser flows have no uncaught exceptions',async()=>assert.deepEqual(errors,[]));
    }finally{await browser.close();}
}
console.log(`Archive suite: ${passed} checks passed`);
