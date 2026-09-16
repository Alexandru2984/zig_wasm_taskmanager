// Real authorization/transaction/browser tests on the disposable harness only.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {request} from 'node:http';
import fs from 'node:fs';
const base=new URL(process.env.BASE_URL), database=new URL(process.env.TEST_DB_URL);
for(const url of [base,database]){assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');assert.ok(url.port&&!['9000','8010'].includes(url.port));}
const run=randomBytes(6).toString('hex'), id=(table,label)=>`${table}:ownership_${run}_${label}`, hash=x=>createHash('sha256').update(x).digest('hex');
const password=`Aa1${randomBytes(24).toString('hex')}`;
async function sql(body) {
    const r=await fetch(new URL('/sql',database),{method:'POST',headers:{Authorization:'Basic '+Buffer.from('itroot:itpass').toString('base64'),Accept:'application/json','surreal-ns':'taskmanager_it','surreal-db':'main'},body});
    assert.equal(r.status,200);const rows=await r.json();for(const row of rows)assert.equal(row.status,'OK',row.result);return rows.at(-1).result;
}
function api(user,path,method='GET',body,{csrf=true}={}) {
    const payload=body===undefined?undefined:JSON.stringify(body);
    return new Promise((resolve,reject)=>{
        const req=request(new URL(path,base),{method,localAddress:'127.0.0.12',timeout:30000,headers:{'Content-Type':'application/json',...(payload===undefined?{}:{'Content-Length':Buffer.byteLength(payload)}),...(user?{Cookie:`session_token=${user.token}`,...(csrf?{'X-CSRF-Token':user.csrf}:{})}:{})}},res=>{
            const chunks=[];res.on('data',x=>chunks.push(x));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks).toString())});}catch(e){reject(e);}});
        });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Ownership fixture timeout')));req.end(payload);
    });
}
// Hash once through the actual application; use the same synthetic credential
// for isolated accounts. Do not substitute a fast/legacy production hash.
const seedEmail=`ownership-seed-${run}@example.invalid`;
assert.equal((await api(null,'/api/auth/signup','POST',{name:'Ownership seed',email:seedEmail,password})).status,201);
const passwordHash=(await sql(`SELECT password_hash FROM users WHERE email = '${seedEmail}';`))[0].password_hash;
assert.ok(passwordHash.startsWith('$argon2id$'));
let serial=0,passed=0;
async function fixture() {
    const prefix=`case${++serial}`, f={ws:id('workspaces',prefix),task:id('tasks',prefix)};
    let commands=`CREATE ${f.ws} SET name = 'Ownership fixture', owner_id = ${id('users',prefix+'_owner')};`;
    for(const role of ['owner','admin','member','viewer','outside','unverified']) {
        const person=f[role]={id:id('users',prefix+'_'+role),token:randomBytes(32).toString('hex'),csrf:randomBytes(32).toString('hex')};
        commands+=`CREATE ${person.id} SET name = '${role}', email = '${prefix}-${role}-${run}@example.invalid', password_hash = ${JSON.stringify(passwordHash)}, email_verified = ${role!=='unverified'};
            CREATE sessions SET user_id = ${person.id}, token = '${hash(person.token)}', csrf_hash = '${hash(person.csrf)}', expires_at = time::now() + 1h;`;
        if(role!=='outside')commands+=`CREATE workspace_members SET user_id = ${person.id}, workspace_id = ${f.ws}, role = '${role==='unverified'?'member':role}';`;
    }
    commands+=`CREATE ${f.task} SET user_id = ${f.owner.id}, workspace_id = ${f.ws}, title = 'Retain this task', notes = 'Authorship stays with its creator', assignee_id = ${f.member.id};`;
    await sql(commands);return f;
}
const transfer=(f,target=f.member,user=f.owner,pw=password,options)=>api(user,`/api/workspaces/${f.ws}/owner`,'POST',{user_id:target.id,password:pw},options);
const owners=f=>sql(`SELECT owner_id FROM ${f.ws};`);
async function invariant(f,expected) {
    assert.equal((await owners(f))[0]?.owner_id,expected);
    const membership=await sql(`SELECT user_id FROM workspace_members WHERE workspace_id = ${f.ws} AND role = 'owner';`);
    assert.deepEqual(membership.map(x=>x.user_id),[expected]);
    assert.equal((await sql(`SELECT id FROM ${expected};`)).length,1);
}
async function check(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
await check('transfer keeps one owner, demotes former owner and preserves task metadata',async()=>{
    const f=await fixture(),before=await sql(`SELECT * FROM ${f.task};`),r=await transfer(f);assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store');
    assert.deepEqual(r.data,{workspace_id:f.ws,owner_id:f.member.id,role:'admin'});await invariant(f,f.member.id);assert.deepEqual(await sql(`SELECT * FROM ${f.task};`),before);
    for(const [person,role] of [[f.owner,'admin'],[f.member,'owner']])assert.equal((await api(person,'/api/workspaces')).data.find(row=>row.id===f.ws).role,role);
    assert.equal((await transfer(f)).status,403);
    assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/members`,'DELETE',{user_id:f.member.id})).status,403);
    assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/members`,'PUT',{user_id:f.member.id,role:'member'})).status,403);
    const events=await sql(`SELECT user_id, action, entity_id FROM activity_events WHERE entity_id = '${f.ws}';`);assert.equal(events.length,2);
    assert.ok(events.some(e=>e.user_id===f.owner.id&&e.action==='transfer_workspace_ownership'));assert.ok(events.some(e=>e.user_id===f.member.id&&e.action==='receive_workspace_ownership'));
    assert.ok(!JSON.stringify(events).includes(password));
});
await check('only authenticated current owners with CSRF can use the transfer route',async()=>{
    const f=await fixture();assert.equal((await transfer(f,f.member,null)).status,401);
    for(const role of ['admin','member','viewer','outside'])assert.equal((await transfer(f,f.unverified,f[role])).status,403);
    assert.equal((await transfer(f,f.member,f.owner,password,{csrf:false})).status,403);
    assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/owner`)).status,405);
    assert.equal((await api(f.owner,`/api/workspaces/${f.owner.id}/owner`,'POST',{user_id:f.member.id,password})).status,400);await invariant(f,f.owner.id);
});
await check('invalid and ineligible targets cannot become owners',async()=>{
    const f=await fixture();for(const target of [f.owner,f.unverified,f.outside,{id:id('users','missing')},{id:f.ws}])assert.equal((await transfer(f,target)).status,400);await invariant(f,f.owner.id);
});
await check('password input is mandatory and bounded and an unverified owner is denied',async()=>{
    const f=await fixture();for(const body of [{user_id:f.member.id},{user_id:f.member.id,password:''},{user_id:f.member.id,password:'x'.repeat(129)}])assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/owner`,'POST',body)).status,400);
    await sql(`UPDATE ${f.owner.id} SET email_verified = false;`);assert.equal((await transfer(f)).status,403);await invariant(f,f.owner.id);
});
await check('wrong-password attempts share the existing sensitive-account rate budget',async()=>{
    const f=await fixture();for(let n=0;n<5;n++)assert.equal((await transfer(f,f.member,f.owner,'Definitely incorrect 1')).status,403);
    const limited=await transfer(f);assert.equal(limited.status,429);assert.equal(limited.headers['retry-after'],'900');
    assert.equal((await api(f.owner,'/api/profile/password','PUT',{old_password:password,new_password:password+'2'})).status,429);
    assert.equal((await api(f.owner,'/api/account','DELETE',{password})).status,429);await invariant(f,f.owner.id);
});
await check('concurrent transfers select exactly one winner without replaying either write',async()=>{
    const f=await fixture(),rs=await Promise.all([transfer(f,f.admin),transfer(f,f.member)]);assert.equal(rs.filter(r=>r.status===200).length,1);assert.ok(rs.every(r=>[200,403,409].includes(r.status)));await invariant(f,rs.find(r=>r.status===200).data.owner_id);
});
await check('inconsistent legacy ownership fails closed instead of inventing an owner',async()=>{
    const f=await fixture();await sql(`UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ${f.ws} AND user_id = ${f.admin.id};`);
    assert.equal((await transfer(f)).status,409);assert.equal((await owners(f))[0].owner_id,f.owner.id);
    await sql(`UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ${f.ws} AND user_id = ${f.admin.id}; UPDATE ${f.ws} SET owner_id = ${f.admin.id};`);
    assert.equal((await transfer(f)).status,403);assert.equal((await owners(f))[0].owner_id,f.admin.id);
});
await check('activity failure rolls back ownership, both roles and account serialization writes',async()=>{
    const f=await fixture(),event=`ownership_audit_fail_${run}`;
    const snapshot=async()=>[await sql(`SELECT * FROM ${f.ws};`),await sql(`SELECT * FROM workspace_members WHERE workspace_id = ${f.ws} ORDER BY user_id;`),await sql(`SELECT security_revision FROM ${f.owner.id}, ${f.member.id};`)];
    const before=await snapshot();await sql(`DEFINE EVENT ${event} ON TABLE activity_events WHEN $event = 'CREATE' AND $after.action = 'receive_workspace_ownership' AND $after.entity_id = '${f.ws}' THEN { THROW 'Synthetic ownership history failure'; };`);
    try{assert.equal((await transfer(f)).status,500);assert.deepEqual(await snapshot(),before);assert.equal((await sql(`SELECT id FROM activity_events WHERE entity_id = '${f.ws}';`)).length,0);}finally{await sql(`REMOVE EVENT ${event} ON TABLE activity_events;`);}
});
async function fillQuota(person,count,label) {
    await sql(Array.from({length:count},(_,n)=>`CREATE ${id('workspaces',`${label}_${n}`)} SET owner_id = ${person.id}, name = 'Quota fixture'; CREATE workspace_members SET workspace_id = ${id('workspaces',`${label}_${n}`)}, user_id = ${person.id}, role = 'owner';`).join('\n'));
}
await check('recipient ownership limit rejects a grant without changing existing access',async()=>{
    const f=await fixture();await fillQuota(f.member,25,'full');assert.equal((await transfer(f)).status,422);await invariant(f,f.owner.id);
});
await check('two different owners cannot race transfers past the recipients final quota slot',async()=>{
    const f=await fixture(),g=await fixture();await fillQuota(f.member,24,'incoming');await sql(`CREATE workspace_members SET user_id = ${f.member.id}, workspace_id = ${g.ws}, role = 'member';`);
    const rs=await Promise.all([transfer(f),transfer(g,f.member)]);assert.equal(rs.filter(r=>r.status===200).length,1);assert.ok(rs.every(r=>[200,409,422].includes(r.status)));
    assert.equal((await sql(`SELECT id FROM workspaces WHERE owner_id = ${f.member.id};`)).length,25);
    await invariant(f,rs[0].status===200?f.member.id:f.owner.id);await invariant(g,rs[1].status===200?f.member.id:g.owner.id);
});
await check('incoming transfer and recipient workspace creation share the quota fence',async()=>{
    const f=await fixture();await fillQuota(f.member,24,'creation');const rs=await Promise.all([transfer(f),api(f.member,'/api/workspaces','POST',{name:'Concurrent creation'})]);
    assert.equal(rs.filter(r=>[200,201].includes(r.status)).length,1);assert.ok(rs.every(r=>[200,201,409,422].includes(r.status)));assert.equal((await sql(`SELECT id FROM workspaces WHERE owner_id = ${f.member.id};`)).length,25);
});
async function delayedTransfer(f,concurrent,deleted=false) {
    const event=`ownership_delay_${run}_${serial}`;
    await sql(`DEFINE EVENT ${event} ON TABLE workspaces WHEN $event = 'UPDATE' AND $after.id = ${f.ws} AND $after.owner_id = ${f.member.id} AND $before.owner_id != $after.owner_id THEN { FOR $n IN 0..48 { LET $unused = crypto::argon2::generate('synthetic-ownership-delay'); }; };`);
    try{let settled=false;const pending=transfer(f).finally(()=>{settled=true;});await new Promise(resolve=>setTimeout(resolve,500));assert.equal(settled,false);await concurrent();const result=await pending;assert.ok([400,403,404,409].includes(result.status),`unexpected delayed transfer status ${result.status}`);if(!deleted)await invariant(f,f.owner.id);}
    finally{await sql(`REMOVE EVENT ${event} ON TABLE workspaces;`);}
}
await check('recipient removal defeats an overlapping ownership grant',async()=>{const f=await fixture();await delayedTransfer(f,async()=>assert.equal((await api(f.owner,`/api/workspaces/${f.ws}/members`,'DELETE',{user_id:f.member.id})).status,200));});
await check('password rotation defeats an overlapping grant authenticated with the old hash',async()=>{const f=await fixture();await delayedTransfer(f,async()=>assert.equal((await api(f.owner,'/api/profile/password','PUT',{old_password:password,new_password:password+'2'})).status,200));});
await check('recipient account deletion cannot leave a dangling owner or ownership membership',async()=>{const f=await fixture();await delayedTransfer(f,async()=>assert.equal((await api(f.member,'/api/account','DELETE',{password})).status,200));assert.equal((await sql(`SELECT id FROM ${f.member.id};`)).length,0);});
await check('source account deletion cannot leave a late transferred workspace or orphan members',async()=>{
    const f=await fixture();await delayedTransfer(f,async()=>assert.equal((await api(f.owner,'/api/account','DELETE',{password})).status,200),true);
    assert.equal((await owners(f)).length,0);assert.equal((await sql(`SELECT id FROM workspace_members WHERE workspace_id = ${f.ws};`)).length,0);assert.equal((await sql(`SELECT id FROM ${f.member.id};`)).length,1);
});
await check('former owner deletion preserves the transferred workspace but follows task authorship rules',async()=>{
    const f=await fixture(),retained=id('tasks','new_owner_task');await sql(`CREATE ${retained} SET user_id = ${f.member.id}, workspace_id = ${f.ws}, title = 'New owner task';`);
    assert.equal((await transfer(f)).status,200);assert.equal((await api(f.owner,'/api/account','DELETE',{password})).status,200);await invariant(f,f.member.id);
    assert.equal((await sql(`SELECT id FROM ${f.task};`)).length,0);assert.equal((await sql(`SELECT id FROM ${retained};`)).length,1);
});
await check('new owner may transfer back only through the dedicated confirmed flow',async()=>{
    const f=await fixture();assert.equal((await transfer(f,f.viewer)).status,200);await invariant(f,f.viewer.id);
    assert.equal((await transfer(f,f.owner,f.viewer)).status,200);await invariant(f,f.owner.id);
});

if(process.env.RUN_UI==='1') {
    const {chromium}=await import('playwright-core');let executablePath=process.env.CHROME_PATH;
    for(const root of [`${process.env.HOME}/.cache/ms-playwright`,'/ms-playwright'])if(!executablePath&&fs.existsSync(root))for(const dir of fs.readdirSync(root))for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']){const file=`${root}/${dir}/${rel}`;if(fs.existsSync(file))executablePath=file;}
    const browser=await chromium.launch({executablePath,args:['--no-sandbox']}),errors=[];
    try {
        async function pageFor(user) {const context=await browser.newContext({viewport:{width:320,height:900},isMobile:true,hasTouch:true});await context.addCookies([{name:'session_token',value:user.token,url:base.origin,httpOnly:true},{name:'csrf_token',value:user.csrf,url:base.origin}]);const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base.origin,{waitUntil:'networkidle'});await p.evaluate(()=>openWorkspacePanel());return p;}
        const f=await fixture(),p=await pageFor(f.owner),adminPage=await pageFor(f.admin);
        const choose=page=>page.locator(`[data-transfer-user="${f.member.id}"]`).click();
        await check('only the owner sees transfer controls and phone confirmation is explicit',async()=>{
            assert.equal(await adminPage.locator('[data-transfer-user]').count(),0);await choose(p);
            assert.ok((await p.locator('#ownerTransferTarget').textContent()).includes(f.member.id));assert.ok((await p.locator('#ownerTransferForm').textContent()).includes('Task authorship does not change'));
            assert.ok(await p.evaluate(()=>document.activeElement.id==='ownerTransferPassword'));assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
            await p.fill('#ownerTransferPassword',password);await p.click('#ownerTransferSubmit');await invariant(f,f.owner.id);assert.ok(!await p.isChecked('#ownerTransferAck'));
            const dir=process.env.OWNERSHIP_ARTIFACT_DIR;if(dir){fs.mkdirSync(dir,{recursive:true,mode:0o700});await p.click('#ownerTransferTitle');await p.locator('#ownerTransferTitle').scrollIntoViewIfNeeded();await p.screenshot({path:`${dir}/ownership-mobile.png`});}
            await p.click('#ownerTransferCancel');assert.equal(await p.inputValue('#ownerTransferPassword'),'');assert.ok(await p.evaluate(()=>document.activeElement.hasAttribute('data-transfer-user')));
        });
        await check('failed transfer clears password, locks retry and never stores credentials',async()=>{
            await choose(p);await p.fill('#ownerTransferPassword','Wrong password 1');await p.check('#ownerTransferAck');await p.click('#ownerTransferSubmit');await p.waitForFunction(()=>document.getElementById('ownerTransferError').textContent.includes('reopen'));
            assert.equal(await p.inputValue('#ownerTransferPassword'),'');assert.ok(await p.locator('#ownerTransferSubmit').isDisabled());assert.ok(!await p.isChecked('#ownerTransferAck'));
            assert.ok(await p.evaluate(()=>!JSON.stringify({...localStorage,...sessionStorage}).includes('Wrong password 1')));await invariant(f,f.owner.id);
            await p.keyboard.press('Escape');await p.evaluate(()=>openWorkspacePanel());
        });
        await check('successful ownership transfer refreshes roles and removes former-owner controls',async()=>{
            await choose(p);await p.fill('#ownerTransferPassword',password);await p.check('#ownerTransferAck');await p.click('#ownerTransferSubmit');
            await p.waitForFunction(()=>document.getElementById('workspaceRole').textContent==='admin'&&document.getElementById('memberList').children.length>0);
            await invariant(f,f.member.id);assert.equal(await p.locator('[data-transfer-user]').count(),0);assert.equal(await p.inputValue('#ownerTransferPassword'),'');assert.ok(!await p.locator('#ownerTransferForm').isVisible());
        });
        const g=await fixture(),a=await pageFor(g.owner);
        async function delayed(page,work) {
            let release,arrived,requests=0;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{arrived=r;});
            await page.route('**/owner',async route=>{requests++;arrived();await gate;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({workspace_id:g.ws,owner_id:g.member.id,role:'admin'})});});
            try{await work(started,release);assert.equal(requests,1);}finally{release();await page.unroute('**/owner');}
        }
        async function start(page) {await page.locator(`[data-transfer-user="${g.member.id}"]`).click();await page.fill('#ownerTransferPassword',password);await page.check('#ownerTransferAck');await page.click('#ownerTransferSubmit');}
        await check('an invalid success envelope cannot report or publish a successful ownership change',async()=>{
            await a.route('**/owner',route=>route.fulfill({status:200,contentType:'application/json',body:'{"status":"unexpected proxy response"}'}));
            try{await start(a);await a.waitForFunction(()=>document.getElementById('ownerTransferError').textContent.includes('reopen'));assert.equal(await a.locator('#workspaceRole').textContent(),'owner');assert.ok(await a.locator('#ownerTransferSubmit').isDisabled());assert.equal(await a.inputValue('#ownerTransferPassword'),'');await invariant(g,g.owner.id);}
            finally{await a.unroute('**/owner');await a.keyboard.press('Escape');await a.evaluate(()=>openWorkspacePanel());}
        });
        await check('closing an in-flight transfer clears private input and fences the late response',async()=>{
            await delayed(a,async(started,release)=>{await start(a);await started;await a.evaluate(()=>handleOwnerTransfer({preventDefault(){}}));assert.equal(await a.inputValue('#ownerTransferPassword'),'');await a.keyboard.press('Escape');release();await a.waitForTimeout(100);assert.ok(!await a.locator('#workspaceModal').isVisible());assert.equal(await a.locator('#workspaceRole').textContent(),'owner');assert.equal(await a.locator('#ownerTransferTarget').textContent(),'');});
        });
        await check('account replacement discards the password, recipient and delayed ownership result',async()=>{
            await a.evaluate(()=>openWorkspacePanel());await delayed(a,async(started,release)=>{await start(a);await started;await a.evaluate(()=>showLoggedIn({...state.user,id:'users:ownership_other_account',name:'Other account'}));release();await a.waitForTimeout(100);assert.equal(await a.evaluate(()=>ownerTransfer),null);assert.equal(await a.inputValue('#ownerTransferPassword'),'');assert.equal(await a.locator('#ownerTransferTarget').textContent(),'');assert.ok(!await a.locator('#workspaceModal').isVisible());});
            await a.reload({waitUntil:'networkidle'});
        });
        await check('logout clears pending ownership UI without publishing a late role change',async()=>{
            await a.evaluate(()=>openWorkspacePanel());await delayed(a,async(started,release)=>{await start(a);await started;await a.evaluate(()=>showLoggedOut());release();await a.waitForTimeout(100);assert.equal(await a.evaluate(()=>ownerTransfer),null);assert.equal(await a.inputValue('#ownerTransferPassword'),'');assert.equal(await a.locator('#ownerTransferTarget').textContent(),'');assert.equal(await a.evaluate(()=>state.workspaces.length),0);});
        });
        await check('ownership browser flow has no uncaught errors',async()=>assert.deepEqual(errors,[]));
    } finally {await browser.close();}
}
console.log(`Ownership suite: ${passed} checks passed`);
