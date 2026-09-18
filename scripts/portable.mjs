// Local Docker operations only. Never send credentials in argv or print
// rendered Compose configuration, database replies, env files or raw errors.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const execute=promisify(execFile), repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const DB_IMAGE='surrealdb/surrealdb:v3.2.4@sha256:51baed8709f57f67dcf04b30e3177db846803fa9342dae2be58c6fa5f8d59843';
const SCHEMA='017', FORMAT=1;
const secret=()=>randomBytes(32).toString('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const dockerEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('COMPOSE_')&&!key.startsWith('TM_')));
async function docker(args,env={}) {
    try{return (await execute('docker',args,{env:{...dockerEnv(),...env},timeout:180000,maxBuffer:4*1024*1024})).stdout.trim();}
    catch{throw new Error('Docker operation failed; inspect this installation locally. Raw output withheld.');}
}
export function validateOptions(name,origin,appPort,dbPort) {
    assert.match(name,/^[a-z][a-z0-9-]{1,23}$/,'name must be 2–24 lowercase letters/digits/dashes');
    for(const port of [appPort,dbPort])assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535&&! [9000,8010].includes(port),'choose unused non-production ports (1024–65535; not 9000/8010)');
    assert.notEqual(appPort,dbPort,'application/database ports must differ');
    let url;try{url=new URL(origin);}catch{throw new Error('invalid public origin');}
    assert.equal(url.origin,origin,'origin must not contain a path, credentials, query or fragment');
    assert.ok(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)&&url.port===String(appPort)),'HTTPS required, except matching localhost HTTP');
    assert.ok(!/[\s$#'"\\]/.test(origin),'unsupported origin characters');
}
function privatePath(file,directory=false) {
    const st=fs.lstatSync(file);
    assert.ok(!st.isSymbolicLink()&&(directory?st.isDirectory():st.isFile()),'private path must not be a symlink');
    assert.equal(st.mode&0o077,0,'private path must not be group/world accessible');
    assert.equal(st.uid,process.getuid(),'private files must belong to the operator running this command');
    if(!directory)assert.ok(st.size<=1024*1024,'configuration too large');
}
function syncDirectory(dir) {const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function writeNew(file,value) {
    const fd=fs.openSync(file,'wx',0o600);
    try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    syncDirectory(path.dirname(file));
}
function saveState(dir,state) {
    const next=path.join(dir,'state.next.json');writeNew(next,JSON.stringify(state,null,2)+'\n');
    fs.renameSync(next,path.join(dir,'state.json'));syncDirectory(dir);
}
function envText(values) {return Object.entries(values).map(([key,value])=>`${key}=${value}\n`).join('');}
function readEnv(file) {
    privatePath(file);const values={};
    for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
        if(!line.trim()||line.trimStart().startsWith('#'))continue;
        const i=line.indexOf('=');assert.ok(i>0,'invalid env line');const key=line.slice(0,i);
        assert.match(key,/^[A-Z_]+$/,'invalid env key');assert.ok(!Object.hasOwn(values,key),'duplicate env key');values[key]=line.slice(i+1);
    }
    return values;
}
function load(dir) {
    assert.equal(fs.realpathSync(dir),dir,'installation path must be canonical');privatePath(dir,true);
    for(const file of ['state.json','compose.yaml','bootstrap.yaml','bootstrap.env'])privatePath(path.join(dir,file));
    const state=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
    assert.equal(state.format,FORMAT,'unsupported installation format');assert.equal(state.schema,SCHEMA,'schema requires a dedicated upgrade review');
    assert.match(state.project,/^tm_[a-z][a-z0-9-]{1,23}_[a-f0-9]{12}$/,'invalid project identity');
    validateOptions(state.name,state.origin,state.appPort,state.dbPort);
    for(const image of [state.image,state.previous].filter(Boolean))assert.match(image,/^sha256:[a-f0-9]{64}$/,'image must be pinned');
    const admin=readEnv(path.join(dir,'admin.env')), runtime=readEnv(path.join(dir,'runtime.env'));
    assert.equal(admin.SURREAL_USER,'taskmanager_admin');assert.equal(runtime.SURREAL_USER,'taskmanager_runtime');
    assert.equal(admin.SURREAL_URL,`http://127.0.0.1:${state.dbPort}`,'administrator endpoint must match this installation');
    for(const cfg of [admin,runtime]) {assert.equal(cfg.SURREAL_NS,'taskapp');assert.equal(cfg.SURREAL_DB,'main');assert.match(cfg.SURREAL_PASS,/^[a-f0-9]{64}$/);}
    assert.match(runtime.MAIL_OUTBOX_KEY,/^[a-f0-9]{64}$/);assert.match(runtime.METRICS_TOKEN,/^[a-f0-9]{64}$/);
    assert.equal(runtime.APP_BASE_URL,state.origin,'origin change requires an explicit configuration review');assert.equal(runtime.CORS_ORIGIN,state.origin);
    assert.equal(runtime.COOKIE_INSECURE,state.origin.startsWith('http:')?'1':'0','cookie security must match the public origin');
    return {state,admin,runtime};
}
async function imageId(reference) {
    assert.ok(typeof reference==='string'&&reference.length<256&&!reference.startsWith('-'),'invalid image reference');
    const [image]=JSON.parse(await docker(['image','inspect',reference]));
    assert.equal(image.Os,'linux');assert.equal(image.Architecture,'amd64');
    assert.equal(image.Config.Labels?.['io.taskmanager.portable-format'],'1','not a portable Task Manager image');
    assert.equal(image.Config.Labels?.['io.taskmanager.schema'],SCHEMA,'image schema requires a dedicated migration/rollback review');
    assert.equal(image.Config.User,'10001:10001','runtime image must be non-root');
    assert.match(image.Id,/^sha256:[a-f0-9]{64}$/);return image.Id;
}
async function requireLocalDocker() {
    assert.equal(process.platform,'linux','this deployment supports Linux only');
    const [context]=JSON.parse(await docker(['context','inspect']));
    assert.ok(context.Endpoints?.docker?.Host?.startsWith('unix://'),'remote Docker contexts are refused');
    assert.ok(!process.env.DOCKER_HOST||process.env.DOCKER_HOST.startsWith('unix://'),'remote DOCKER_HOST is refused');
    const engine=await docker(['version','--format','{{.Server.Version}}']);assert.ok(parseInt(engine)>=28,'Docker Engine 28+ required for localhost port isolation');
    const compose=(await docker(['compose','version','--short'])).replace(/^v/,'').split('.').map(Number);
    assert.ok(compose[0]>2||(compose[0]===2&&compose[1]>=30),'Compose 2.30+ required for raw env_file values');
}
async function projectGuard(dir,state) {
    const ids=(await docker(['ps','-aq','--filter',`label=com.docker.compose.project=${state.project}`])).split('\n').filter(Boolean);
    if(ids.length)for(const item of JSON.parse(await docker(['inspect',...ids])))assert.equal(item.Config.Labels?.['com.docker.compose.project.working_dir'],dir,'project collision: existing containers belong to another directory');
}
async function compose(dir,state,args,{bootstrap=false,image=state.image}={}) {
    await projectGuard(dir,state);
    return docker(['compose','--env-file','/dev/null','--project-directory',dir,'-p',state.project,'-f',path.join(dir,'compose.yaml'),...(bootstrap?['-f',path.join(dir,'bootstrap.yaml')]:[]),...args],{
        TM_DIRECTORY:dir,TM_APP_IMAGE:image,TM_DB_IMAGE:DB_IMAGE,TM_APP_PORT:String(state.appPort),TM_DB_PORT:String(state.dbPort),
    });
}
async function freePort(port) {
    await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(new Error('requested loopback port is already occupied')));server.listen(port,'127.0.0.1',()=>server.close(resolve));});
}
async function waitReady(url,expected) {
    for(let i=0;i<30;i++) {
        try{const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(2000)});if(response.ok&&(!expected||(await response.json()).status===expected))return;}catch{}
        await sleep(1000);
    }
    throw new Error('readiness timed out; installation left for explicit recovery');
}
function headers(cfg,runtime=false) {
    return {Authorization:'Basic '+Buffer.from(`${cfg.SURREAL_USER}:${cfg.SURREAL_PASS}`).toString('base64'),Accept:'application/json','surreal-ns':'taskapp','surreal-db':'main',...(runtime?{'surreal-auth-ns':'taskapp','surreal-auth-db':'main'}:{})};
}
async function sql(state,cfg,query,runtime=false) {
    const response=await fetch(`http://127.0.0.1:${state.dbPort}/sql`,{method:'POST',redirect:'error',headers:headers(cfg,runtime),body:query,signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200,'database authentication/request failed');const rows=await response.json();assert.ok(Array.isArray(rows),'invalid database reply');return rows;
}
function success(rows) {assert.ok(rows.every(row=>row.status==='OK'),'database operation failed; response details withheld');return rows;}
async function verifyRuntime(state,runtime) {
    success(await sql(state,runtime,'SELECT version FROM schema_migrations LIMIT 1;',true));
    assert.ok((await sql(state,runtime,'INFO FOR ROOT;',true)).some(row=>row.status==='ERR'),'runtime unexpectedly has root access');
}
async function backup(dir,state,admin) {
    const space=fs.statfsSync(dir);assert.ok(space.bavail*space.bsize>512*1024*1024,'at least 512 MiB free space required for a backup');
    const destination=path.join(dir,`backup-${Date.now()}-${randomBytes(4).toString('hex')}.surql`),partial=destination+'.partial';
    const response=await fetch(`http://127.0.0.1:${state.dbPort}/export`,{method:'GET',redirect:'error',headers:headers(admin),signal:AbortSignal.timeout(120000)});
    assert.equal(response.status,200,'backup export refused');
    let bytes=0;const limit=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;done(bytes>512*1024*1024?new Error('backup exceeds the 512 MiB operator budget'):null,chunk);}});
    await pipeline(Readable.fromWeb(response.body),limit,fs.createWriteStream(partial,{flags:'wx',mode:0o600}));
    assert.ok(bytes>0,'empty backup');const fd=fs.openSync(partial,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(partial,destination);syncDirectory(dir);console.log(`Private local export created: ${path.basename(destination)} (${bytes} bytes)`);return destination;
}
async function startApp(dir,state,runtime) {
    await verifyRuntime(state,runtime);await compose(dir,state,['up','-d','--no-deps','--force-recreate','app']);
    await waitReady(`http://127.0.0.1:${state.appPort}/api/ready`,'ready');
}
async function init(dir,[name,origin,appRaw,dbRaw,image]) {
    const appPort=Number(appRaw),dbPort=Number(dbRaw);validateOptions(name,origin,appPort,dbPort);
    assert.ok(path.isAbsolute(dir)&&dir===path.resolve(dir)&&!/[\n\r$#'"\\]/.test(dir),'use a canonical absolute installation directory');
    assert.ok(dir!==repo&&!dir.startsWith(repo+path.sep),'private installation must stay outside the checkout');
    assert.ok(!fs.existsSync(dir),'new installation directory required; nothing overwritten');
    assert.equal(fs.realpathSync(path.dirname(dir)),path.dirname(dir),'parent must not be a symlink');
    const pinned=await imageId(image);await freePort(appPort);await freePort(dbPort);
    const state={format:FORMAT,schema:SCHEMA,name,origin,project:`tm_${name}_${randomBytes(6).toString('hex')}`,appPort,dbPort,image:pinned,previous:null,phase:'prepared'};
    fs.mkdirSync(dir,{mode:0o700});
    const admin={SURREAL_URL:`http://127.0.0.1:${dbPort}`,SURREAL_NS:'taskapp',SURREAL_DB:'main',SURREAL_USER:'taskmanager_admin',SURREAL_PASS:secret(),DB_MIGRATE_ONLY:'1'};
    const runtime={SURREAL_NS:'taskapp',SURREAL_DB:'main',SURREAL_USER:'taskmanager_runtime',SURREAL_PASS:secret(),SURREAL_AUTH_LEVEL:'database',DB_AUTO_MIGRATE:'0',DB_MIGRATE_ONLY:'0',APP_BASE_URL:origin,CORS_ORIGIN:origin,TRUST_PROXY:'',COOKIE_INSECURE:origin.startsWith('http:')?'1':'0',SERVER_THREADS:'4',MAIL_OUTBOX_KEY:secret(),METRICS_TOKEN:secret(),MAIL_WORKER_ENABLED:'0',TASK_REMINDERS_ENABLED:'0',WORKSPACE_TASK_LIMIT:'10000',WORKSPACE_TEXT_BYTES_LIMIT:'52428800',OWNED_WORKSPACE_LIMIT:'25'};
    writeNew(path.join(dir,'admin.env'),envText(admin));writeNew(path.join(dir,'runtime.env'),envText(runtime));
    writeNew(path.join(dir,'bootstrap.env'),envText({SURREAL_USER:admin.SURREAL_USER,SURREAL_PASS:admin.SURREAL_PASS}));
    for(const file of ['compose.yaml','bootstrap.yaml'])writeNew(path.join(dir,file),fs.readFileSync(path.join(repo,'ops/portable',file)));
    saveState(dir,state);console.log('Private installation prepared. Keep this directory and encryption key across upgrades. Run install next.');
}
async function install(dir,state,admin,runtime) {
    assert.equal(state.phase,'prepared','install is only for an untouched prepared directory');
    assert.equal(await docker(['ps','-aq','--filter',`label=com.docker.compose.project=${state.project}`]),'','existing project refused');
    assert.equal(await docker(['volume','ls','-q','--filter',`name=^${state.project}_database$`]),'','existing database volume refused');
    await freePort(state.appPort);await freePort(state.dbPort);
    state.phase='installing';saveState(dir,state);
    // If interrupted, never bootstrap again automatically. Preserve this state
    // and credentials for the documented recovery inspection.
    await compose(dir,state,['up','-d','db'],{bootstrap:true});
    await waitReady(`http://127.0.0.1:${state.dbPort}/version`);
    success(await sql(state,admin,'INFO FOR ROOT;'));
    await compose(dir,state,['up','-d','--force-recreate','db']);
    await waitReady(`http://127.0.0.1:${state.dbPort}/version`);
    success(await sql(state,admin,'INFO FOR ROOT;'));
    await compose(dir,state,['run','--rm','--no-deps','migrate']);
    success(await sql(state,admin,`DEFINE USER taskmanager_runtime ON DATABASE PASSWORD '${runtime.SURREAL_PASS}' ROLES EDITOR;`));
    await startApp(dir,state,runtime);state.phase='ready';saveState(dir,state);
    console.log('Installed: scoped runtime verified, bootstrap credentials removed from DB startup, readiness passed.');
}
async function change(dir,state,admin,runtime,target,rollback=false) {
    assert.ok((rollback?['ready','failed','changing']:['ready']).includes(state.phase),'recover an incomplete upgrade with rollback before upgrading again');
    const next=await imageId(target);assert.notEqual(next,state.image,'target is already selected');
    await compose(dir,state,['stop','app']);
    const exported=await backup(dir,state,admin);
    const previous=state.image;state.previous=rollback?null:previous;state.image=next;state.phase='changing';state.backup=path.basename(exported);saveState(dir,state);
    try{
        if(!rollback)await compose(dir,state,['run','--rm','--no-deps','migrate']);
        await startApp(dir,state,runtime);state.phase='ready';saveState(dir,state);
    }catch(error){await compose(dir,state,['stop','app']).catch(()=>{});state.phase='failed';saveState(dir,state);throw error;}
    console.log(`${rollback?'Rollback':'Upgrade'} ready. Database writes preserved; no export was imported.`);
}
export async function main(argv) {
    const [action,directory,...args]=argv;
    assert.ok(['init','install','status','backup','upgrade','rollback','stop','start'].includes(action)&&directory,'usage: portable.mjs init DIR NAME ORIGIN APP_PORT DB_PORT IMAGE | install/status/backup/rollback/stop/start DIR | upgrade DIR IMAGE');
    const dir=path.resolve(directory);await requireLocalDocker();
    if(action==='init'){assert.equal(args.length,5,'init requires NAME ORIGIN APP_PORT DB_PORT IMAGE');return init(dir,args);}
    let {state,admin,runtime}=load(dir);await projectGuard(dir,state);
    if(action==='status') {
        let ready=false;try{const r=await fetch(`http://127.0.0.1:${state.appPort}/api/ready`,{redirect:'error',signal:AbortSignal.timeout(3000)});ready=r.ok&&(await r.json()).status==='ready';}catch{}
        console.log(JSON.stringify({project:state.project,phase:state.phase,image:state.image,previous:state.previous,ready}));return;
    }
    const lock=path.join(dir,'operation.lock');writeNew(lock,`${process.pid} ${action}\n`);
    try{
        // Re-read AFTER owning the lock; another operation may have completed
        // between the initial read and the asynchronous Docker checks.
        ({state,admin,runtime}=load(dir));await projectGuard(dir,state);
        if(action==='install')await install(dir,state,admin,runtime);
        else if(action==='backup')await backup(dir,state,admin);
        else if(action==='upgrade'){assert.equal(args.length,1);await change(dir,state,admin,runtime,args[0]);}
        else if(action==='rollback'){assert.ok(state.previous,'no compatible previous image recorded');await change(dir,state,admin,runtime,state.previous,true);}
        else if(action==='stop'){await compose(dir,state,['stop','app']);console.log('Application stopped; database and data retained.');}
        else if(action==='start'){assert.equal(state.phase,'ready','recover an incomplete operation explicitly');await startApp(dir,state,runtime);console.log('Application ready.');}
    }finally{fs.unlinkSync(lock);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.code?'Operation refused; check arguments, private file permissions and installation state. Sensitive details withheld.':error.message);process.exitCode=1;});
