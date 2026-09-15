// Disposable loopback fixtures only; never production accounts or SMTP.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {request} from 'node:http';
import fs from 'node:fs';
const base=new URL(process.env.BASE_URL),db=new URL(process.env.TEST_DB_URL);
for(const u of [base,db]){assert.equal(u.hostname,'127.0.0.1');assert.equal(u.protocol,'http:');assert.ok(u.port&&!['9000','8010'].includes(u.port));}
const run=randomBytes(6).toString('hex'),id=(table,name)=>`${table}:view_${run}_${name}`,hash=x=>createHash('sha256').update(x).digest('hex');
async function sql(body){const r=await fetch(new URL('/sql',db),{method:'POST',headers:{Authorization:'Basic '+Buffer.from('itroot:itpass').toString('base64'),Accept:'application/json','surreal-ns':'taskmanager_it','surreal-db':'main'},body});assert.equal(r.status,200);const rows=await r.json();for(const row of rows)assert.equal(row.status,'OK',row.result);return rows.at(-1).result;}
const people=[];
for(let i=0;i<3;i++){const p={id:id('users',String(i)),token:randomBytes(32).toString('hex'),csrf:randomBytes(32).toString('hex')};people.push(p);await sql(`CREATE ${p.id} SET name='View fixture',email='view-${run}-${i}@example.invalid',password_hash='reset-required',email_verified=true;CREATE sessions SET user_id=${p.id},token='${hash(p.token)}',csrf_hash='${hash(p.csrf)}',expires_at=time::now()+1h;`);}
const [owner,viewer,outside]=people,workspace=id('workspaces','main'),other=id('workspaces','other'),task=i=>id('tasks',`root${String(i).padStart(3,'0')}`),child=i=>id('tasks',`child${String(i).padStart(3,'0')}`);
await sql(`CREATE ${workspace} SET owner_id=${owner.id},name='Bounded view';CREATE ${other} SET owner_id=${outside.id},name='Foreign';CREATE workspace_members SET user_id=${owner.id},workspace_id=${workspace},role='owner';CREATE workspace_members SET user_id=${viewer.id},workspace_id=${workspace},role='viewer';`);
for(let start=0;start<205;start+=50)await sql('BEGIN TRANSACTION;'+Array.from({length:Math.min(50,205-start)},(_,n)=>{const i=start+n;return `CREATE ${task(i)} SET user_id=${owner.id},workspace_id=${workspace},title='Task ${i}',notes='${i===204?'Unique far needle':'Original notes'}',tags=['tag${String(i%60).padStart(2,'0')}'],completed=${i%3===0},status='${i%3===0?'done':'todo'}',priority='${i%5===0?'high':'normal'}',created_at=d'2025-01-01T00:00:00Z';`;}).join('')+'COMMIT TRANSACTION;');
await sql('BEGIN TRANSACTION;'+Array.from({length:55},(_,i)=>`CREATE ${child(i)} SET user_id=${owner.id},workspace_id=${workspace},parent_id=${task(0)},title='Child ${i}',completed=${i%2===0},status='${i%2===0?'done':'todo'}',created_at=d'2025-01-01T00:00:00Z';`).join('')+`CREATE ${id('tasks','legacy')} SET user_id=${owner.id},title='Owned legacy';CREATE ${id('tasks','foreign')} SET user_id=${outside.id},workspace_id=${other},title='Foreign';CREATE ${id('tasks','foreignlegacy')} SET user_id=${outside.id},title='Foreign legacy';CREATE ${id('tasks','trash')} SET user_id=${owner.id},workspace_id=${workspace},title='Trash',deleted_at=time::unix(),delete_batch='${'a'.repeat(64)}';COMMIT TRANSACTION;`);
function api(person,path='/api/tasks/view',method='POST',body,csrf=true){return new Promise((resolve,reject)=>{const req=request(new URL(path,base),{method,localAddress:'127.0.0.9',timeout:15000,headers:{Origin:base.origin,'Content-Type':'application/json',...(person?{Cookie:`session_token=${person.token}`,...(csrf?{'X-CSRF-Token':person.csrf}:{})}:{})}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks))});}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('View timeout')));req.end(body===undefined?undefined:JSON.stringify(body));});}
const input={query:{workspace_id:workspace,limit:50},today:0,tomorrow:86400000,upcoming:8*86400000};
const view=(query={},extras={},person=owner)=>api(person,'/api/tasks/view','POST',{...input,...extras,query:{...input.query,...query}});
let passed=0;async function check(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
let first;
await check('main view requires authentication, CSRF, membership and POST',async()=>{
    assert.equal((await api(null,'/api/tasks/view','POST',input)).status,401);assert.equal((await api(owner,'/api/tasks/view','POST',input,false)).status,403);assert.equal((await view({}, {},outside)).status,403);assert.equal((await api(owner,'/api/tasks/view','GET')).status,405);
    first=await view();assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.headers['cache-control'],'no-store');assert.equal((await view({}, {},viewer)).status,200);
});
await check('one parent page has global exact counts, bounded tag facets and no hidden task payloads',async()=>{
    assert.equal(first.data.items.length,50);assert.equal(first.data.matched,206);assert.equal(first.data.counts.total,206);assert.equal(first.data.counts.done,69);assert.equal(first.data.counts.high,27);assert.equal(first.data.tags.length,50);assert.equal(first.data.tags_more,true);assert.ok(first.data.items.every(t=>!t.parent_id&&!t.deleted_at));
});
await check('root keysets traverse all results, split active before done and bind context',async()=>{
    let r=await view({}, {active_first:true}),seen=[];const cutoff=r.data.as_of;
    while(true){assert.equal(r.status,200,JSON.stringify(r.data));seen.push(...r.data.items);if(!r.data.next_cursor)break;r=await view({cursor:r.data.next_cursor,as_of:cutoff},{active_first:true});}
    assert.equal(seen.length,206);assert.equal(new Set(seen.map(t=>t.id)).size,206);const done=seen.findIndex(t=>t.completed);assert.ok(seen.slice(done).every(t=>t.completed));
    assert.equal((await view({cursor:first.data.next_cursor,q:'different'})).status,400);assert.equal((await view({cursor:first.data.next_cursor},{parent_id:task(0)})).status,400);
});
await check('off-page text and tags are searched on the server; invalid bounds fail closed',async()=>{
    const found=await view({q:'Unique far needle'});assert.equal(found.data.matched,1);assert.equal(found.data.items[0].id,task(204));assert.equal((await view({tag:'tag59'})).data.matched,3);
    for(const query of [{limit:51},{workspace_id:owner.id},{sort:'DROP'},{limit:0}])assert.equal((await view(query)).status,400);
    assert.equal((await view({}, {parent_id:owner.id})).status,400);assert.equal((await view({}, {today:4,upcoming:3})).status,400);
});
await check('lazy child pages and parent progress are complete, bounded and scoped',async()=>{
    const root=await view({}, {focus_id:task(0)});assert.deepEqual(root.data.children,[{parent_id:task(0),total:55,done:28}]);
    const a=await view({sort:'created_asc'}, {parent_id:task(0)});assert.equal(a.status,200,JSON.stringify(a.data));assert.equal(a.data.matched,55);assert.equal(a.data.items.length,50);assert.equal(a.data.counts,null);
    const b=await view({sort:'created_asc',cursor:a.data.next_cursor},{parent_id:task(0)});assert.equal(b.status,200);assert.equal(b.data.items.length,5);assert.equal(b.data.next_cursor,null);
    assert.equal((await view({}, {parent_id:id('tasks','foreign')})).status,404);assert.equal((await view({}, {parent_id:child(0)})).status,404);assert.equal((await view({}, {parent_id:task(0),focus_id:child(54)})).data.items[0].id,child(54));
});
await check('revocation denies a later page and zero-result views keep accurate workspace totals',async()=>{
    const empty=await view({q:'NoSuchTask'});assert.equal(empty.data.matched,0);assert.equal(empty.data.counts.total,206);
    await sql(`DELETE workspace_members WHERE user_id=${viewer.id} AND workspace_id=${workspace};`);assert.equal((await view({}, {},viewer)).status,403);
});
await check('empty and single-tag workspaces keep stable aggregate response types',async()=>{
    const isolated=id('workspaces','empty');
    await sql(`CREATE ${isolated} SET owner_id=${viewer.id},name='Empty fixture';CREATE workspace_members SET user_id=${viewer.id},workspace_id=${isolated},role='owner';`);
    const empty=await view({workspace_id:isolated},{},viewer);
    assert.equal(empty.status,200);assert.deepEqual(empty.data.counts,{total:0,done:0,overdue:0,high:0,today:0,upcoming:0});assert.deepEqual(empty.data.tags,[]);assert.deepEqual(empty.data.children,[]);assert.deepEqual(empty.data.items,[]);
    await sql(`CREATE ${id('tasks','single')} SET user_id=${viewer.id},workspace_id=${isolated},title='Single tagged root',tags=['only-tag'];`);
    const one=await view({workspace_id:isolated},{},viewer);
    assert.equal(one.status,200);assert.equal(one.data.counts.total,1);assert.deepEqual(one.data.tags,[{tag:'only-tag',count:1}]);assert.deepEqual(one.data.children,[]);assert.equal(one.data.items.length,1);
});
if(process.env.RUN_UI==='1'){
    const {chromium}=await import('playwright-core');let executablePath=process.env.CHROME_PATH;
    for(const root of [`${process.env.HOME}/.cache/ms-playwright`,'/ms-playwright'])if(!executablePath&&fs.existsSync(root))for(const dir of fs.readdirSync(root))for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']){const p=`${root}/${dir}/${rel}`;if(fs.existsSync(p))executablePath=p;}
    const browser=await chromium.launch({executablePath,args:['--no-sandbox']});
    try{
        const ctx=await browser.newContext({viewport:{width:320,height:900}});await ctx.addCookies([{name:'session_token',value:owner.token,url:base.origin,httpOnly:true},{name:'csrf_token',value:owner.csrf,url:base.origin}]);
        const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(ws=>localStorage.setItem('workspaceId',ws),workspace);await page.goto(base.origin,{waitUntil:'networkidle'});await page.waitForFunction(()=>state.user&&!state.loading&&mainView.data);
        await check('main UI stores one page while counters describe all roots, with mobile-safe pagination',async()=>{assert.equal(await page.evaluate(()=>state.tasks.length),50);assert.equal(await page.locator('#countAll').textContent(),'206');await page.click('#tasksNext');await page.waitForFunction(()=>!state.loading&&mainView.page===1);assert.equal(await page.evaluate(()=>state.tasks.length),50);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));});
        await check('UI server search finds a task outside the loaded page',async()=>{await page.fill('#searchInput','Unique far needle');await page.waitForFunction(()=>!state.loading&&state.tasks.length===1);assert.equal(await page.evaluate(()=>state.tasks[0].notes),'Unique far needle');assert.equal(await page.locator('#countAll').textContent(),'206');assert.deepEqual(errors,[]);});
        await check('lazy children never expand the main collection beyond two pages and focus can reach the last child',async()=>{
            await page.evaluate(t=>openMainTask(t),{id:child(54),parent_id:task(0),workspace_id:workspace});
            assert.equal(await page.evaluate(()=>state.tasks.length),2);assert.ok(await page.locator('#focusedTaskNotice').isVisible());
            await page.getByRole('button',{name:'Show all subtasks',exact:true}).click();await page.waitForFunction(()=>mainView.child&&!mainView.child.busy);
            assert.equal(await page.evaluate(()=>state.tasks.length),51);await page.getByRole('button',{name:'Next subtasks',exact:true}).click();await page.waitForFunction(()=>!mainView.child.busy);assert.equal(await page.evaluate(()=>state.tasks.length),6);
        });
        await check('failed root refresh cancels a child read without leaving its controls busy',async()=>{
            assert.ok(await page.evaluate(async parent=>{
                const original=api;let finish;
                api=(path,options)=>options?.body?.parent_id?new Promise(resolve=>{finish=resolve;}):Promise.resolve({ok:false,status:503,data:null});
                try{const pending=loadMainChildren(parent);await loadTasks();finish({ok:false,status:0,data:null});await pending;return mainView.child!==null&&!mainView.child.busy&&mainView.child.error&&state.tasks.length<=100;}
                finally{api=original;}
            },task(0)));
        });
        await check('dirty drafts block navigation when declined and clear only after confirmation',async()=>{
            await page.click('#backToTasks');await page.waitForFunction(()=>!state.loading&&!mainView.timer);await page.locator('[data-act="edit"]').first().click();await page.fill('.task-edit [data-field="notes"]','Unsaved view draft');
            page.once('dialog',d=>d.dismiss());await page.click('#tasksNext');assert.equal(await page.inputValue('.task-edit [data-field="notes"]'),'Unsaved view draft');assert.equal(await page.evaluate(()=>mainView.page),0);
            page.once('dialog',d=>d.accept());await page.click('#tasksNext');await page.waitForFunction(()=>!state.loading&&mainView.page===1);assert.equal(await page.evaluate(()=>taskDrafts.size),0);
        });
        await check('complete CSV ignores visible-page filters and neutralizes formula-leading cells',async()=>{
            const exported=await page.evaluate(async()=>{let text=null;const original=saveCsv;saveCsv=x=>{text=x;};try{await downloadCsv();return {text,retained:state.tasks.length,formulas:['=1+1',' +SUM(A1)','@cmd','-1','\tformula'].map(csvField)};}finally{saveCsv=original;}});
            assert.equal(exported.retained,50);assert.equal(exported.text.split('\r\n').length,262);assert.ok(exported.text.includes(child(54))&&exported.text.includes(task(204)));assert.ok(!exported.text.includes(id('tasks','trash'))&&!exported.text.includes(id('tasks','foreign')));assert.ok(exported.formulas.every(x=>x.startsWith("'")));
        });
        await check('CSV failure after the first page never publishes a partial download',async()=>{
            let calls=0;await page.route('**/api/tasks?*',route=>++calls===2?route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic export failure"}'}):route.continue());
            assert.equal(await page.evaluate(async()=>{let downloads=0;const original=saveCsv;saveCsv=()=>downloads++;try{await downloadCsv();return downloads;}finally{saveCsv=original;}}),0);assert.equal(calls,2);await page.unroute('**/api/tasks?*');
        });
        await check('denied child reads clear parent rows, totals, selection and member state',async()=>{
            await page.evaluate(t=>openMainTask(t),{id:task(0),workspace_id:workspace});
            await page.route('**/api/tasks/view',route=>route.fulfill({status:403,contentType:'application/json',body:'{"error":"Workspace unavailable"}'}));
            assert.ok(await page.evaluate(async parent=>{state.selection.add(parent);await loadMainChildren(parent);return state.tasks.length===0&&mainView.data===null&&state.selection.size===0&&state.members.length===0&&taskDrafts.size===0;},task(0)));
            await page.unroute('**/api/tasks/view');
        });
        await check('logout aborts export and clears main-view queries, totals, focus and late responses',async()=>{
            assert.ok(await page.evaluate(async()=>{
                const original=window.fetch,originalSave=saveCsv,finish=[];let downloads=0;
                window.fetch=path=>new Promise(resolve=>{const body=String(path).includes('/directory?')?{workspace_id:state.currentWorkspaceId,items:[{user_id:'users:private_late',name:'Private late member',role:'member'}],next_cursor:null}:{items:[],next_cursor:null,as_of:Date.now()};finish.push(()=>resolve(new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}})));});
                saveCsv=()=>downloads++;
                try{state.members=[{name:'Private retained member'}];const pending=downloadCsv(),labels=loadMembersForLabels();const requested=finish.length;showLoggedOut();finish.forEach(resolve=>resolve());await Promise.all([pending,labels]);return requested===2&&downloads===0&&state.tasks.length===0&&state.members.length===0&&mainView.data===null&&mainView.input===null&&mainView.focus===null&&mainView.savedFocus===null&&mainView.context===''&&mainView.child===null;}
                finally{window.fetch=original;saveCsv=originalSave;}
            }));
            assert.deepEqual(errors,[]);
        });
    }finally{await browser.close();}
}
console.log(`Main view suite: ${passed} checks passed`);
