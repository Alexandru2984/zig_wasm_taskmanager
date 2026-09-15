// Destructive fixtures are restricted to this script's new temporary project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {main,validateOptions,DB_IMAGE} from './portable.mjs';
const exec=promisify(execFile),image=process.argv[2];assert.ok(image,'pass a locally built portable image');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'taskmanager-portable-it-')),dir=path.join(root,'installation');
const token=randomBytes(6).toString('hex'),good=`taskmanager-portable-it:good-${token}`,bad=`taskmanager-portable-it:bad-${token}`,badMigration=`taskmanager-portable-it:migration-${token}`;
const docker=async (args,env={})=>(await exec('docker',args,{env:{...process.env,...env},timeout:180000,maxBuffer:2*1024*1024})).stdout.trim();
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const appPort=await port();let dbPort=await port();while(dbPort===appPort)dbPort=await port();
const base=`http://127.0.0.1:${appPort}`,state=()=>JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
let passed=0;async function check(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
let project,appId,dbId,cookie='',csrf='',workspace,firstId;
async function api(route,method='GET',body){const r=await fetch(base+route,{method,headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});return {r,data:await r.json()};}
async function task(title){const result=await api('/api/tasks','POST',{title,workspace_id:workspace});assert.equal(result.r.status,201);return result.data.id;}
async function tasks(){return (await api(`/api/tasks?page=1&workspace_id=${workspace}`)).data.items;}
try{
    await check('unsafe origins, names, colliding and production ports are refused',async()=>{
        validateOptions('client','https://tasks.example.com',9320,8030);
        for(const args of [['x','https://tasks.example.com',9320,8030],['client','http://evil.example.com',9320,8030],['client','https://tasks.example.com/path',9320,8030],['client','http://127.0.0.1:9321',9320,8030],['client','https://tasks.example.com',9000,8030],['client','https://tasks.example.com',9320,8010],['client','https://tasks.example.com',9320,9320]])assert.throws(()=>validateOptions(...args));
    });
    await check('init generates separate private credentials without replacing an existing installation',async()=>{
        await main(['init',dir,'itclient',base,String(appPort),String(dbPort),image]);project=state().project;
        assert.equal(fs.statSync(dir).mode&0o777,0o700);
        for(const name of fs.readdirSync(dir))assert.equal(fs.statSync(path.join(dir,name)).mode&0o777,0o600);
        const runtime=fs.readFileSync(path.join(dir,'runtime.env'),'utf8'),admin=fs.readFileSync(path.join(dir,'admin.env'),'utf8');
        assert.ok(!runtime.includes('taskmanager_admin')&&!runtime.includes(admin.match(/^SURREAL_PASS=(.+)$/m)[1]));
        await assert.rejects(main(['init',dir,'itclient',base,String(appPort),String(dbPort),image]));
    });
    await check('fresh install migrates separately and serves with a database-scoped runtime',async()=>{
        await main(['install',dir]);assert.equal(state().phase,'ready');
        const ids=(await docker(['ps','-aq','--filter',`label=com.docker.compose.project=${project}`])).split('\n').filter(Boolean);
        const containers=JSON.parse(await docker(['inspect',...ids]));
        const app=containers.find(c=>c.Config.Labels['com.docker.compose.service']==='app'),db=containers.find(c=>c.Config.Labels['com.docker.compose.service']==='db');
        assert.equal(containers.length,2);appId=app.Id;dbId=db.Id;
        assert.ok(!db.Config.Env.some(x=>/^SURREAL_(USER|PASS)=/.test(x)));assert.ok(!app.Config.Env.some(x=>x.includes('taskmanager_admin')));
        assert.equal(app.Config.User,'10001:10001');assert.equal(app.HostConfig.ReadonlyRootfs,true);assert.ok(app.HostConfig.CapDrop.includes('ALL'));assert.ok(app.HostConfig.SecurityOpt.some(x=>x.startsWith('no-new-privileges')));
        for(const c of [app,db])for(const bindings of Object.values(c.HostConfig.PortBindings))assert.ok(bindings.every(x=>x.HostIp==='127.0.0.1'));
        assert.ok(app.Config.Healthcheck.Test.join(' ').includes('/api/ready'));
    });
    await check('runtime artifacts are matched, stamped and contain no build tree or private config',async()=>{
        const html=await (await fetch(base)).text();
        for(const name of ['app.js','task-view.js','style.css']){
            const stamp=html.match(new RegExp(`${name.replaceAll('.','\\.')}\\?v=([a-f0-9]{8})`));assert.ok(stamp);
            const {createHash}=await import('node:crypto');const r=await fetch(`${base}/${name}?v=${stamp[1]}`);assert.equal(r.status,200);assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex').slice(0,8),stamp[1]);
        }
        await docker(['exec',appId,'/bin/sh','-c','test ! -e /src && test ! -e /app/.env && test ! -e /app/admin.env && test -r /app/lib/libfacil.io.so && test -r /app/public/app.wasm && test ! -w /app/taskmanager']);
    });
    await check('real account and versioned task workflows work inside the portable image',async()=>{
        const signup=await api('/api/auth/signup','POST',{name:'Portable fixture',email:`portable-${token}@example.invalid`,password:'Aa1'+randomBytes(18).toString('base64url')});assert.equal(signup.r.status,201);
        cookie=signup.r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');csrf=cookie.match(/(?:^|; )csrf_token=([^;]+)/)[1];
        workspace=(await api('/api/workspaces')).data[0].id;firstId=await task('Portable task before upgrade');
        const view=await api('/api/tasks/view','POST',{query:{workspace_id:workspace,limit:50},today:0,tomorrow:86400000,upcoming:8*86400000});assert.equal(view.r.status,200);assert.equal(view.data.counts.total,1);assert.equal(view.data.items[0].version,0);
    });
    await check('operation lock and unsafe secret-file permissions fail closed',async()=>{
        const lock=path.join(dir,'operation.lock');fs.writeFileSync(lock,'synthetic lock\n',{flag:'wx',mode:0o600});await assert.rejects(main(['backup',dir]));fs.unlinkSync(lock);
        const config=path.join(dir,'runtime.env');fs.chmodSync(config,0o644);await assert.rejects(main(['status',dir]));fs.chmodSync(config,0o600);
        const original=fs.readFileSync(config,'utf8'),marker='DO-NOT-PRINT-PRIVATE-'+token;fs.writeFileSync(config,original.replace(/^SURREAL_PASS=.+$/m,`SURREAL_PASS=${marker}`));
        try{await exec(process.execPath,['scripts/portable.mjs','status',dir]);assert.fail('invalid secret accepted');}catch(e){assert.ok(!String(e.stderr).includes(marker));}finally{fs.writeFileSync(config,original);}
        fs.writeFileSync(config,original.replace('COOKIE_INSECURE=1','COOKIE_INSECURE=0'));
        try{await assert.rejects(exec(process.execPath,['scripts/portable.mjs','status',dir]));}finally{fs.writeFileSync(config,original);}
    });
    await check('private local backup contains fixture data without changing live rows',async()=>{
        await main(['backup',dir]);const files=fs.readdirSync(dir).filter(x=>x.endsWith('.surql'));assert.equal(files.length,1);
        assert.equal(fs.statSync(path.join(dir,files[0])).mode&0o777,0o600);assert.ok(fs.readFileSync(path.join(dir,files[0]),'utf8').includes('Portable task before upgrade'));assert.equal((await tasks())[0].id,firstId);
    });
    // These are two distinct image identities in the same schema family. The
    // good fixture changes metadata only; the bad one cannot start its server.
    for(const [tag,command] of [[good,''],[bad,`CMD ${JSON.stringify(['/bin/sh','-c','if [ "$DB_MIGRATE_ONLY" = 1 ]; then exec /app/taskmanager; else exit 1; fi'])}\n`],[badMigration,'CMD ["/bin/false"]\n']]){
        const folder=path.join(root,tag===good?'good':tag===bad?'bad':'migration');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'Dockerfile'),`FROM ${image}\nLABEL io.taskmanager.fixture=${tag===good?'good':'bad'}\n${command}`);
        await docker(['build','-t',tag,folder]);
    }
    const originalImage=state().image,originalConfig=fs.readFileSync(path.join(dir,'runtime.env'),'utf8');
    await check('upgrade pins a new image, preserves encryption key, session and task versions',async()=>{
        await main(['upgrade',dir,good]);assert.notEqual(state().image,originalImage);assert.equal(state().previous,originalImage);assert.equal(state().phase,'ready');assert.equal(fs.readFileSync(path.join(dir,'runtime.env'),'utf8'),originalConfig);assert.ok((await tasks()).some(x=>x.id===firstId));
        await task('Portable task after upgrade');
    });
    await check('explicit rollback preserves writes made after the upgrade without a database import',async()=>{
        await main(['rollback',dir]);assert.equal(state().image,originalImage);assert.equal((await tasks()).length,2);assert.equal(state().previous,null);
    });
    await check('unhealthy candidate stops serving and explicit rollback recovers the known-good image',async()=>{
        await assert.rejects(main(['upgrade',dir,bad]));assert.equal(state().phase,'failed');assert.equal(state().previous,originalImage);
        await main(['rollback',dir]);assert.equal(state().phase,'ready');assert.equal((await tasks()).length,2);
    });
    await check('stop/start retains the database and repeated bootstrap is refused',async()=>{
        await main(['stop',dir]);assert.equal((await docker(['inspect',dbId,'--format','{{.State.Running}}'])),'true');await main(['start',dir]);assert.equal((await tasks()).length,2);await assert.rejects(main(['install',dir]));
    });
    await check('failed migration leaves maintenance state and a compatible rollback preserves all rows',async()=>{
        await assert.rejects(main(['upgrade',dir,badMigration]));assert.equal(state().phase,'failed');assert.equal(state().previous,originalImage);
        await main(['rollback',dir]);assert.equal((await tasks()).length,2);
    });
    await check('restart of the credential-free persistent database retains accounts and tasks',async()=>{
        await docker(['restart',dbId]);await main(['start',dir]);assert.equal((await tasks()).length,2);
    });
    await check('a private export restores into a separate empty database with matching account/task/session counts',async()=>{
        await main(['backup',dir]);const latest=fs.readdirSync(dir).filter(x=>x.endsWith('.surql')).sort().at(-1);
        const restoreName=`taskmanager-portable-restore-${token}`,restorePort=await port(),restoreUser='restore_operator',restorePass=randomBytes(32).toString('hex');let started=false;
        try{
            await docker(['run','-d','--name',restoreName,'--label',`io.taskmanager.fixture=${token}`,'-p',`127.0.0.1:${restorePort}:8000`,'-e','SURREAL_USER','-e','SURREAL_PASS',DB_IMAGE,'start','--log','warn','memory'],{SURREAL_USER:restoreUser,SURREAL_PASS:restorePass});started=true;
            let ready=false;for(let i=0;i<30;i++){try{ready=(await fetch(`http://127.0.0.1:${restorePort}/version`)).ok;if(ready)break;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}assert.ok(ready);
            const result=await exec(process.execPath,['scripts/db_admin.mjs','restore-test',path.join(dir,'admin.env'),`http://127.0.0.1:${restorePort}`,path.join(dir,latest)],{env:{...process.env,TEST_DB_USER:restoreUser,TEST_DB_PASS:restorePass},timeout:30000});
            assert.ok(result.stdout.includes('Restore drill passed'));assert.equal((await tasks()).length,2);
        }finally{if(started)await docker(['rm','-fv',restoreName]);}
    });
    if(process.env.RUN_PORTABLE_UI==='1'){
        const browser=await exec(process.execPath,['scripts/ui_test.mjs'],{env:{...process.env,BASE_URL:base},timeout:180000,maxBuffer:2*1024*1024});
        console.log(browser.stdout.trim());
    }
    console.log(`Portable deployment suite: ${passed} checks passed`);
}finally{
    // Exact, new fixture project only. Never delete a production/existing volume.
    if(project){
        assert.match(project,/^tm_itclient_[a-f0-9]{12}$/);
        const ids=(await docker(['ps','-aq','--filter',`label=com.docker.compose.project=${project}`])).split('\n').filter(Boolean);
        if(ids.length){for(const c of JSON.parse(await docker(['inspect',...ids])))assert.equal(c.Config.Labels['com.docker.compose.project.working_dir'],dir);await docker(['rm','-fv',...ids]);}
        const volumes=(await docker(['volume','ls','-q','--filter',`label=com.docker.compose.project=${project}`])).split('\n').filter(Boolean);if(volumes.length)await docker(['volume','rm',...volumes]);
        const networks=(await docker(['network','ls','-q','--filter',`label=com.docker.compose.project=${project}`])).split('\n').filter(Boolean);if(networks.length)await docker(['network','rm',...networks]);
    }
    for(const tag of [good,bad,badMigration])await docker(['image','rm',tag]).catch(()=>{});
    fs.rmSync(root,{recursive:true,force:true});
}
