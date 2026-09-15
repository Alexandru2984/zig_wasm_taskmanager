// Synthetic users and a disposable database only. No production mutations/SMTP.
import assert from 'node:assert/strict';
import {randomBytes, createHash} from 'node:crypto';
import {request} from 'node:http';
import fs from 'node:fs';
const base=new URL(process.env.BASE_URL), database=new URL(process.env.TEST_DB_URL);
for(const url of [base,database]) {assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');assert.ok(url.port&&!['9000','8010'].includes(url.port));}
const run=randomBytes(6).toString('hex'), id=(table,name)=>`${table}:team_${run}_${name}`;
const hash=value=>createHash('sha256').update(value).digest('hex');
async function sql(body) {
    const response=await fetch(new URL('/sql',database),{method:'POST',headers:{Authorization:`Basic ${Buffer.from('itroot:itpass').toString('base64')}`,Accept:'application/json','surreal-ns':'taskmanager_it','surreal-db':'main'},body});
    assert.equal(response.status,200);const rows=await response.json();for(const row of rows)assert.equal(row.status,'OK',row.result);return rows.at(-1).result;
}
const people={};
for(const name of ['owner','admin','member','viewer','outsider','revoked']) {
    const user=people[name]={id:id('users',name),token:randomBytes(32).toString('hex'),csrf:randomBytes(32).toString('hex')};
    await sql(`CREATE ${user.id} SET name = '${name}', email = '${name}-${run}@example.invalid', password_hash = 'synthetic-reset-required', email_verified = true;
        CREATE sessions SET user_id = ${user.id}, token = '${hash(user.token)}', csrf_hash = '${hash(user.csrf)}', expires_at = time::now() + 1h;`);
}
const {owner,admin,member,viewer,outsider,revoked}=people, ws=id('workspaces','primary'), other=id('workspaces','other');
await sql(`CREATE ${ws} SET name = 'Team fixture', owner_id = ${owner.id}; CREATE ${other} SET name = 'Other team', owner_id = ${outsider.id};
    CREATE workspace_members SET workspace_id = ${other}, user_id = ${outsider.id}, role = 'owner';
    CREATE workspace_members SET workspace_id = ${other}, user_id = ${owner.id}, role = 'member';`);
for(const [name,role] of [['owner','owner'],['admin','admin'],['member','member'],['viewer','viewer'],['revoked','member']])await sql(`CREATE workspace_members SET workspace_id = ${ws}, user_id = ${people[name].id}, role = '${role}';`);
await sql(Array.from({length:108},(_,i)=>`CREATE ${id('users',`bulk${String(i).padStart(3,'0')}`)} SET name = 'Teammate ${i}', email = 'bulk${i}-${run}@example.invalid', password_hash = 'synthetic';
    CREATE workspace_members SET workspace_id = ${ws}, user_id = ${id('users',`bulk${String(i).padStart(3,'0')}`)}, role = 'member';`).join('\n'));
const target=id('users','bulk107'), record=id('tasks','assigned');
await sql(`UPDATE ${target} SET name = '<img src=x onerror=alert(1)> Target'; CREATE ${record} SET title = 'Assigned team task', user_id = ${owner.id}, workspace_id = ${ws}, assignee_id = ${target};`);
function api(user,path,method='GET',body,{csrf=true,tag}={}) {
    const payload=body===undefined?undefined:JSON.stringify(body);
    return new Promise((resolve,reject)=>{
        const req=request(new URL(path,base),{method,localAddress:'127.0.0.11',timeout:20000,headers:{'Content-Type':'application/json',...(payload===undefined?{}:{'Content-Length':Buffer.byteLength(payload)}),...(tag?{'If-Match':tag}:{}),...(user?{Cookie:`session_token=${user.token}`,...(csrf?{'X-CSRF-Token':user.csrf}:{})}:{})}},res=>{
            const chunks=[];res.on('data',x=>chunks.push(x));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks).toString())});}catch(e){reject(e);}});
        });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('fixture timeout')));req.end(payload);
    });
}
const directory=`/api/workspaces/${ws}/directory`, rename=(user,name,expected='Team fixture',options)=>api(user,`/api/workspaces/${ws}`,'PATCH',{name,expected_name:expected},options);
let passed=0;async function check(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
await check('all workspace roles read only minimal directory fields with no-store',async()=>{
    for(const user of [owner,admin,member,viewer]) {
        const r=await api(user,directory);assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.data.workspace_id,ws);assert.equal(r.data.items.length,50);
        for(const row of r.data.items)assert.deepEqual(Object.keys(row).sort(),['name','role','user_id']);
        assert.ok(!JSON.stringify(r.data).includes('@example.invalid'));
    }
});
await check('anonymous, outsider, wrong-table and malformed directory requests are refused',async()=>{
    assert.equal((await api(null,directory)).status,401);assert.equal((await api(outsider,directory)).status,403);
    for(const path of ['/api/workspaces/users:abc/directory',directory+'?after=tasks:abc',directory+'?after=users%3Aabc%3BDELETE',directory+'?q='+('a'.repeat(81))])assert.equal((await api(owner,path)).status,400);
    assert.equal((await api(owner,directory,'POST',{})).status,405);
});
await check('keyset directory visits all 113 members without repeats or silent truncation',async()=>{
    let after=null;const seen=new Set();let pages=0;
    do {const r=await api(member,directory+(after?'?after='+encodeURIComponent(after):''));assert.equal(r.status,200);assert.ok(r.data.items.length<=50);for(const row of r.data.items){assert.ok(!seen.has(row.user_id));seen.add(row.user_id);}after=r.data.next_cursor;assert.ok(++pages<=3);}while(after);
    assert.equal(pages,3);assert.equal(seen.size,113);assert.ok(seen.has(target));
});
await check('name search is case-insensitive and never searches private email addresses',async()=>{
    const found=await api(member,directory+'?q=tArGeT');assert.deepEqual(found.data.items.map(row=>row.user_id),[target]);
    assert.equal((await api(member,directory+'?q='+encodeURIComponent('@example.invalid'))).data.items.length,0);
    assert.equal((await api(member,directory+'?q='+encodeURIComponent("'; RETURN users; --"))).data.items.length,0);
    assert.equal((await api(member,`/api/workspaces/${other}/directory?q=outsider`)).status,403);
});
await check('admin email roster and invitations remain forbidden to ordinary members/viewers',async()=>{
    for(const user of [member,viewer,outsider])for(const suffix of ['members','invites'])assert.equal((await api(user,`/api/workspaces/${ws}/${suffix}`)).status,403);
    assert.equal((await api(admin,`/api/workspaces/${ws}/members`)).status,200);assert.equal((await api(admin,`/api/workspaces/${ws}/invites`)).status,200);
});
await check('directory discovery does not grant task writes or outsider assignment',async()=>{
    const path=`/api/tasks/${record}`, before=await api(member,path);
    assert.equal((await api(viewer,path,'PUT',{assignee_id:member.id},{tag:before.headers.etag})).status,403);
    assert.equal((await api(member,path,'PUT',{assignee_id:outsider.id},{tag:before.headers.etag})).status,400);
    const changed=await api(member,path,'PUT',{assignee_id:member.id},{tag:before.headers.etag});assert.equal(changed.status,200);assert.equal(changed.data.assignee_id,member.id);
});
await check('member revocation immediately denies subsequent directory pages',async()=>{
    const first=await api(revoked,directory);assert.equal(first.status,200);
    assert.equal((await api(owner,`/api/workspaces/${ws}/members`,'DELETE',{user_id:revoked.id})).status,200);
    assert.equal((await api(revoked,directory+'?after='+first.data.next_cursor)).status,403);
});
await check('rename requires administrator authority, CSRF, valid names and expected state',async()=>{
    for(const user of [member,viewer,outsider,revoked])assert.equal((await rename(user,'Denied')).status,403);
    assert.equal((await rename(owner,'Denied','Team fixture',{csrf:false})).status,403);
    for(const name of ['', '<script>', 'bad\nname', 'x'.repeat(121)])assert.equal((await rename(owner,name)).status,400);
    assert.equal((await api(owner,`/api/workspaces/${ws}`,'PATCH',{name:'Missing expectation'})).status,400);
    assert.equal((await rename(owner,'Stale','Old name')).status,409);
    assert.equal((await sql(`SELECT name FROM ${ws};`))[0].name,'Team fixture');
});
await check('owner/admin rename preserves ownership, tasks and reports one concurrent winner',async()=>{
    const outcomes=await Promise.all([rename(owner,'Owner new name'),rename(admin,'Admin new name')]);
    assert.equal(outcomes.filter(r=>r.status===200).length,1);assert.ok(outcomes.every(r=>[200,409].includes(r.status)));
    const name=(await sql(`SELECT name FROM ${ws};`))[0].name;
    assert.equal((await rename(admin,'Team fixture',name)).status,200);
    assert.equal((await sql(`SELECT owner_id FROM ${ws};`))[0].owner_id,owner.id);assert.equal((await sql(`SELECT id FROM ${record};`)).length,1);
    assert.equal((await api(member,'/api/workspaces')).data.find(row=>row.id===ws).name,'Team fixture');
});
await check('a failed rename rolls back both name and authorization fence',async()=>{
    const event=`team_fail_${run}`, before=(await sql(`SELECT * FROM ${ws};`))[0];
    await sql(`DEFINE EVENT ${event} ON TABLE workspaces WHEN $event = 'UPDATE' AND $after.id = ${ws} AND $after.name = 'Injected failure' THEN { THROW 'Synthetic rename failure'; };`);
    try{assert.equal((await rename(owner,'Injected failure')).status,500);assert.deepEqual((await sql(`SELECT * FROM ${ws};`))[0],before);}finally{await sql(`REMOVE EVENT ${event} ON TABLE workspaces;`);}
});
await check('administrative revocation wins against an in-flight rename',async()=>{
    const event=`team_delay_${run}`;
    await sql(`DEFINE EVENT ${event} ON TABLE workspaces WHEN $event = 'UPDATE' AND $after.id = ${ws} AND $after.name = 'Delayed rename' THEN { FOR $n IN 0..32 { LET $unused = crypto::argon2::generate('synthetic-delay'); }; };`);
    try{let settled=false;const pending=rename(admin,'Delayed rename').finally(()=>{settled=true;});await new Promise(resolve=>setTimeout(resolve,250));assert.equal(settled,false);
        assert.equal((await api(owner,`/api/workspaces/${ws}/members`,'PUT',{user_id:admin.id,role:'viewer'})).status,200);
        assert.ok([403,409].includes((await pending).status));assert.equal((await sql(`SELECT name FROM ${ws};`))[0].name,'Team fixture');
    }finally{await sql(`REMOVE EVENT ${event} ON TABLE workspaces;`);}
});

if(process.env.RUN_UI==='1') {
    const {chromium}=await import('playwright-core');let executablePath=process.env.CHROME_PATH;
    for(const root of [`${process.env.HOME}/.cache/ms-playwright`,'/ms-playwright'])if(!executablePath&&fs.existsSync(root))for(const dir of fs.readdirSync(root))for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']){const file=`${root}/${dir}/${rel}`;if(fs.existsSync(file))executablePath=file;}
    const browser=await chromium.launch({executablePath,args:['--no-sandbox']});
    const errors=[];
    try {
        async function pageFor(user) {const context=await browser.newContext({viewport:{width:320,height:900},isMobile:true,hasTouch:true});await context.addCookies([{name:'session_token',value:user.token,url:base.origin,httpOnly:true},{name:'csrf_token',value:user.csrf,url:base.origin}]);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base.origin,{waitUntil:'networkidle'});return page;}
        const p=await pageFor(member), a=await pageFor(owner), v=await pageFor(viewer);
        await a.evaluate(id=>switchWorkspace(id),ws);
        await check('member directory has pagination, safe search and no admin controls on a phone',async()=>{
            await p.evaluate(()=>openWorkspacePanel());assert.equal(await p.locator('#memberList > li').count(),50);assert.ok(await p.locator('#memberNext').isEnabled());
            assert.ok(!await p.locator('#workspaceRenameForm').isVisible());assert.ok(!await p.locator('#workspaceInvitesTab').isVisible());assert.equal(await p.locator('#memberList select').count(),0);
            await p.click('#memberNext');await p.waitForFunction(()=>!document.getElementById('memberNext').disabled);assert.equal(await p.locator('#memberList > li').count(),50);
            await p.fill('#memberSearch','TARGET');await p.locator('#memberSearchForm button[type="submit"]').click();await p.waitForFunction(()=>document.querySelectorAll('#memberList > li').length===1);
            assert.ok((await p.locator('#memberList').textContent()).includes('<img'));assert.equal(await p.locator('#memberList img').count(),0);
            assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
            const artifacts=process.env.TEAM_ARTIFACT_DIR;if(artifacts){fs.mkdirSync(artifacts,{recursive:true,mode:0o700});await p.screenshot({path:`${artifacts}/team-mobile.png`});}
            await p.keyboard.press('Escape');assert.ok(!await p.locator('#workspaceModal').isVisible());
        });
        await check('ordinary member searches and assigns an off-page teammate without losing draft notes',async()=>{
            await p.locator(`[data-act="edit"][data-id="${record}"]`).click();await p.fill('.task-edit [data-field="notes"]','Keep this team draft');
            await p.fill('.assignee-picker input','target');await p.getByRole('button',{name:'Find teammates',exact:true}).click();await p.waitForFunction(id=>!!document.querySelector(`.assignee-picker option[value="${id}"]`),target);
            await p.selectOption('.assignee-picker select',target);await p.evaluate(()=>renderTasks());assert.equal(await p.inputValue('.assignee-picker select'),target);
            await p.fill('.assignee-picker input','Teammate 3');await p.getByRole('button',{name:'Find teammates',exact:true}).click();await p.waitForFunction(()=>document.querySelector('.assignee-picker small').textContent.includes('Current selection'));
            assert.equal(await p.inputValue('.assignee-picker select'),target);assert.equal(await p.inputValue('.task-edit [data-field="notes"]'),'Keep this team draft');
            await p.locator('.task-edit button[type="submit"]').click();await p.waitForSelector('.task-edit',{state:'detached'});
            const task=(await api(member,`/api/tasks/${record}`)).data;assert.equal(task.assignee_id,target);assert.equal(task.notes,'Keep this team draft');
        });
        await check('directory failure is explicit and retryable, never a false empty roster',async()=>{
            await p.route('**/directory?*',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic outage"}'}));
            await p.evaluate(()=>openWorkspacePanel());assert.ok((await p.locator('#memberEmpty').textContent()).includes('Could not load'));assert.equal(await p.locator('#memberList > li').count(),0);
            await p.unroute('**/directory?*');await p.locator('#memberSearchForm button[type="submit"]').click();await p.waitForFunction(()=>document.querySelectorAll('#memberList > li').length===50);await p.keyboard.press('Escape');
        });
        await check('viewer sees names but has no assignment or administration controls',async()=>{
            await v.evaluate(()=>openWorkspacePanel());assert.equal(await v.locator('#memberList > li').count(),50);assert.equal(await v.locator('#memberList select').count(),0);await v.keyboard.press('Escape');assert.equal(await v.locator('[data-act="edit"]').count(),0);
        });
        await check('rename conflict keeps the draft and requires explicit review',async()=>{
            await a.evaluate(()=>openWorkspacePanel());await a.fill('#workspaceRename','My local name');assert.equal((await rename(owner,'Remote name')).status,200);
            await a.locator('#workspaceRenameForm button').click();await a.waitForFunction(()=>document.getElementById('workspaceRenameError').textContent.includes('draft is kept'));assert.equal(await a.inputValue('#workspaceRename'),'My local name');
            assert.equal((await sql(`SELECT name FROM ${ws};`))[0].name,'Remote name');
            await a.keyboard.press('Escape');await a.evaluate(()=>openWorkspacePanel());assert.equal(await a.inputValue('#workspaceRename'),'Remote name');
            await a.fill('#workspaceRename','Team fixture');await a.locator('#workspaceRenameForm button').click();await a.waitForFunction(()=>document.getElementById('workspaceTitle').textContent==='Team fixture');
            assert.ok((await a.locator('#workspaceSelect option:checked').textContent()).includes('Team fixture'));await a.keyboard.press('Escape');
        });
        async function delayed(page,pattern,work) {
            let release, arrived;const gate=new Promise(resolve=>{release=resolve;}), started=new Promise(resolve=>{arrived=resolve;});
            await page.route(pattern,async route=>{const response=await route.fetch();arrived();await gate;await route.fulfill({response});});
            try{await work(started,release);}finally{release();await page.unroute(pattern);}
        }
        await check('late member response cannot repopulate a closed panel',async()=>{
            await delayed(p,'**/directory?*',async(started,release)=>{await p.evaluate(()=>{void openWorkspacePanel();});await started;await p.keyboard.press('Escape');release();await p.waitForTimeout(100);assert.equal(await p.locator('#memberList > li').count(),0);});
        });
        await check('late invitation email cannot cross a workspace switch',async()=>{
            await sql(`CREATE workspace_invites SET workspace_id = ${ws}, email = 'private-${run}@example.invalid', role = 'member', token = '${hash(run)}', invited_by = ${owner.id}, expires_at = time::unix() + 3600;`);
            await delayed(a,'**/invites',async(started,release)=>{await a.evaluate(()=>{void openWorkspacePanel();});await started;await a.evaluate(id=>switchWorkspace(id),other);release();await a.waitForTimeout(100);assert.equal(await a.locator('#inviteList > li').count(),0);assert.ok(!await a.locator('#workspaceModal').isVisible());});
        });
        await check('account replacement clears retained and delayed team data',async()=>{
            await delayed(v,'**/directory?*',async(started,release)=>{await v.evaluate(()=>{void openWorkspacePanel();});await started;
                await v.evaluate(()=>showLoggedIn({...state.user,id:'users:replacement_fixture',name:'Replacement'}));release();await v.waitForTimeout(100);
                assert.equal(await v.locator('#memberList > li').count(),0);assert.equal(await v.evaluate(()=>state.members.length),0);assert.ok(!await v.locator('#workspaceModal').isVisible());});
        });
        await check('logout clears directory, hidden rename state and a delayed private response',async()=>{
            await delayed(p,'**/directory?*',async(started,release)=>{await p.evaluate(()=>{void openWorkspacePanel();});await started;await p.evaluate(()=>showLoggedOut());release();await p.waitForTimeout(100);
                assert.equal(await p.locator('#memberList > li').count(),0);assert.equal(await p.evaluate(()=>state.members.length),0);assert.equal(await p.inputValue('#workspaceRename'),'');assert.equal(await p.getAttribute('#workspaceRenameForm','data-expected'),null);});
        });
        await check('team flows produce no uncaught browser exceptions',async()=>assert.deepEqual(errors,[]));
    } finally {await browser.close();}
}
console.log(`Team collaboration suite: ${passed} checks passed`);
