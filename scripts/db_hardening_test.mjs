// Disposable, persistent DB restart/rotation drill. Requires Docker and a
// writable private temp directory. Never inspects a production credential.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const port = 8041;
const reservation = net.createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(port, '127.0.0.1', resolve); });
await new Promise(resolve => reservation.close(resolve));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'taskmanager-db-hardening-'));
const first = `taskmanager-bootstrap-${randomBytes(6).toString('hex')}`;
const second = `${first}-normal`;
const started = [];
const password = randomBytes(36).toString('base64url');
const runtime = randomBytes(36).toString('base64url');
const env = { ...process.env, SURREAL_USER: 'testadmin', SURREAL_PASS: password };
const url = `http://127.0.0.1:${port}`;
const config = path.join(temp, '.env');
fs.mkdirSync(path.join(temp, 'data'));
fs.writeFileSync(config, `SURREAL_URL=${url}\nSURREAL_NS=drill\nSURREAL_DB=main\nSURREAL_USER=testadmin\nSURREAL_PASS=${password}\n`, { mode: 0o600 });
function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', ...options });
    assert.equal(result.status, 0, `${command} failed: ${(result.stderr || '').replaceAll(password, '[redacted]').replaceAll(runtime, '[redacted]').slice(-2000)}`);
    return result.stdout;
}
async function ready() {
    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`${url}/version`)).ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('disposable DB failed to start');
}
async function query(body, user = 'testadmin', pass = password, database = false) {
    const headers = { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`, Accept: 'application/json', 'surreal-ns': 'drill', 'surreal-db': 'main' };
    if (database) { headers['surreal-auth-ns'] = 'drill'; headers['surreal-auth-db'] = 'main'; }
    const response = await fetch(`${url}/sql`, { method: 'POST', headers, body });
    assert.equal(response.status, 200, 'fixture DB request failed');
    return response.json();
}
function start(name, bootstrap) {
    run('docker', ['run', '-d', '--name', name, '--user', 'root', '-p', `127.0.0.1:${port}:8000`, '--mount', `type=bind,src=${temp}/data,dst=/data`,
        ...(bootstrap ? ['-e', 'SURREAL_USER', '-e', 'SURREAL_PASS'] : []), 'surrealdb/surrealdb:v3.2.4', 'start', '--log', 'warn', 'rocksdb:/data/drill.db'], { env });
    started.push(name);
}
try {
    start(first, true); await ready();
    assert.ok((await query('DEFINE NAMESPACE drill; DEFINE DATABASE main;')).every(r => r.status === 'OK'));
    assert.ok((await query(`CREATE fixture:one SET value = 'retained'; DEFINE USER runtime ON DATABASE PASSWORD '${runtime}' ROLES EDITOR;`)).every(r => r.status === 'OK'));
    await query('DEFINE NAMESPACE unrelated;');
    const refused = spawnSync(process.execPath, ['scripts/db_admin.mjs', 'rotate-admin', config, path.join(temp, 'recovery.env')]);
    assert.notEqual(refused.status, 0);
    assert.ok(!fs.existsSync(path.join(temp, 'recovery.env')));
    await query('REMOVE NAMESPACE unrelated;');
    run(process.execPath, ['scripts/db_admin.mjs', 'rotate-admin', config, path.join(temp, 'recovery.env')]);
    const rotated = fs.readFileSync(config, 'utf8').match(/^SURREAL_PASS=(.+)$/m)[1];
    assert.notEqual(rotated, password);
    assert.equal(fs.readFileSync(config, 'utf8'), fs.readFileSync(path.join(temp, 'recovery.env'), 'utf8'));
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    run('docker', ['stop', first]);
    start(second, false); await ready();
    assert.equal((await query('SELECT * FROM fixture:one;', 'testadmin', rotated))[0].result[0].value, 'retained');
    assert.equal((await query('SELECT * FROM fixture:one;', 'runtime', runtime, true))[0].status, 'OK');
    assert.equal((await query('INFO FOR ROOT;', 'runtime', runtime, true))[0].status, 'ERR');
    const [inspection] = JSON.parse(run('docker', ['inspect', second]));
    assert.ok(!inspection.Config.Cmd.some(v => /^--(user|username|pass|password)$/.test(v)));
    assert.ok(!inspection.Config.Env.some(v => /^SURREAL_(USER|PASS)=/.test(v)));
    run(process.execPath, ['scripts/db_admin.mjs', 'verify-admin', config, 'unused']);
    // Rollback to the original container cannot reseed the old password into
    // an existing store. Never run the two containers on the volume together.
    run('docker', ['stop', second]); run('docker', ['start', first]); await ready();
    assert.equal((await query('SELECT * FROM fixture:one;', 'testadmin', rotated))[0].result.length, 1);
    console.log('PASS: rotation, old-password denial, private recovery, persisted restart, restricted runtime, secret-free startup and container rollback');
} finally {
    for (const name of started.reverse()) run('docker', ['rm', '-f', '-v', name]);
    fs.rmSync(temp, { recursive: true });
}
