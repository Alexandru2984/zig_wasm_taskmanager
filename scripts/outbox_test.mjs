import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { request } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const base = new URL(process.env.BASE_URL), database = new URL(process.env.TEST_DB_URL);
for (const url of [base, database]) {
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
    assert.ok(url.port && !['9000', '8010'].includes(url.port));
}
const work = fs.realpathSync(process.env.TEST_WORKDIR);
assert.ok(work.startsWith('/tmp/'), 'only disposable harness directories');
const key = process.env.TEST_MAIL_KEY; assert.match(key, /^[a-f0-9]{64}$/);
const run = randomBytes(6).toString('hex'), hash = value => createHash('sha256').update(value).digest('hex');
const record = (table, label) => `${table}:mail_${run}_${label}`;
const owner = { id: record('users', 'owner'), email: `owner-${run}@example.invalid`, token: randomBytes(32).toString('hex'), csrf: randomBytes(32).toString('hex') };
const other = { id: record('users', 'other'), email: `other-${run}@example.invalid`, token: randomBytes(32).toString('hex'), csrf: randomBytes(32).toString('hex') };
const workspace = record('workspaces', 'owned');
async function sql(body) {
    const response = await fetch(new URL('/sql', database), { method: 'POST', headers: { Authorization: `Basic ${Buffer.from('itroot:itpass').toString('base64')}`, Accept: 'application/json', 'surreal-ns': 'taskmanager_it', 'surreal-db': 'main' }, body });
    assert.equal(response.status, 200); const rows = await response.json();
    for (const row of rows) assert.equal(row.status, 'OK', row.result);
    return rows.at(-1).result;
}
async function api(person, path, method = 'GET', body) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }), ...(person ? { Cookie: `session_token=${person.token}`, 'X-CSRF-Token': person.csrf } : {}) };
    return new Promise((resolve, reject) => {
        const req = request(new URL(path, base), { method, headers, localAddress: '127.0.0.3' }, res => {
            const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
            res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (e) { reject(e); } });
        }); req.on('error', reject); req.end(payload);
    });
}
for (const person of [owner, other]) await sql(`CREATE ${person.id} SET email = '${person.email}', name = 'Mail fixture', password_hash = 'reset-required', email_verified = true;
    CREATE sessions SET user_id = ${person.id}, token = '${hash(person.token)}', csrf_hash = '${hash(person.csrf)}', expires_at = time::now() + 1h;`);
await sql(`CREATE ${workspace} SET name = 'Delivery fixture', owner_id = ${owner.id}; CREATE workspace_members SET workspace_id = ${workspace}, user_id = ${owner.id}, role = 'owner';
    UPDATE mail_outbox SET available_at = time::unix() + 86400 WHERE status = 'pending';`);

const cert = `${work}/smtp-cert.pem`, privateKey = `${work}/smtp-key.pem`;
assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', privateKey, '-out', cert], { stdio: 'ignore' }).status, 0);
const secureContext = tls.createSecureContext({ key: fs.readFileSync(privateKey), cert: fs.readFileSync(cert) });
const messages = [], sockets = new Set(), children = new Set(); let rejectMail = true, mailRejections = 0;
function attach(socket, encrypted = false) {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '', data = false, message = '', auth = false;
    socket.on('data', chunk => {
        buffer += chunk.toString();
        while (buffer.includes('\r\n')) {
            const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (auth) { auth = false; socket.write('235 Authenticated\r\n'); continue; }
            if (data) { if (line === '.') { messages.push(message); message = ''; data = false; socket.write('250 Accepted\r\n'); } else message += `${line}\r\n`; continue; }
            if (/^EHLO/i.test(line)) socket.write(encrypted ? '250-localhost\r\n250 AUTH PLAIN\r\n' : '250-localhost\r\n250 STARTTLS\r\n');
            else if (/^STARTTLS/i.test(line)) {
                socket.removeAllListeners('data'); socket.write('220 Start TLS\r\n'); attach(new tls.TLSSocket(socket, { isServer: true, secureContext }), true); return;
            } else if (/^AUTH PLAIN$/i.test(line)) { auth = true; socket.write('334 \r\n'); }
            else if (/^AUTH PLAIN /i.test(line)) socket.write('235 Authenticated\r\n');
            else if (/^MAIL FROM/i.test(line)) { if (rejectMail) mailRejections++; socket.write(rejectMail ? '451 Fixture temporary failure\r\n' : '250 OK\r\n'); }
            else if (/^DATA$/i.test(line)) { data = true; socket.write('354 End with dot\r\n'); }
            else if (/^QUIT$/i.test(line)) { socket.end('221 Goodbye\r\n'); }
            else socket.write('250 OK\r\n');
        }
    });
}
const server = net.createServer(socket => { attach(socket); socket.write('220 localhost fixture\r\n'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
function worker(overrides = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.env.TEST_APP_BINARY, [], { cwd: work, env: {
            PATH: process.env.PATH, LD_LIBRARY_PATH: process.env.TEST_LIBRARY_DIR,
            SURREAL_URL: database.origin, SURREAL_NS: 'taskmanager_it', SURREAL_DB: 'main', SURREAL_USER: 'itapp', SURREAL_PASS: 'integration-only-app', SURREAL_AUTH_LEVEL: 'database', DB_AUTO_MIGRATE: '0',
            MAIL_OUTBOX_KEY: key, MAIL_PROCESS_ONCE: '1', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'fixture@example.invalid', SMTP_PASS: 'fixture-only', SMTP_FROM: 'fixture@example.invalid', SMTP_CA_FILE: cert, APP_BASE_URL: base.origin, ...overrides,
        }});
        children.add(child); let output = '';
        child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
        child.on('error', reject); child.on('close', code => { children.delete(child); resolve({ code, output }); });
    });
}
async function step() { const result = await worker(); assert.equal(result.code, 0, result.output.slice(-1500)); }
async function invite(label, person = owner) {
    const result = await api(person, `/api/workspaces/${workspace}/invites`, 'POST', { email: `${label}-${run}@example.invalid`, role: 'member' });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const row = (await sql(`SELECT * FROM mail_outbox WHERE reference_id = ${result.data.id};`))[0];
    assert.ok(row); return { invite: result.data.id, job: row.id, row };
}
const current = async id => (await sql(`SELECT * FROM ${id};`))[0];
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
try {
    const first = await invite('delivery');
    await check('outbox stores encrypted payload and scopes delivery metadata', async () => {
        assert.match(first.row.encrypted_payload, /^[a-f0-9]{80,}$/);
        assert.ok(!first.row.encrypted_payload.includes(owner.email));
        const mine = await api(owner, '/api/email-deliveries'); assert.equal(mine.status, 200); assert.equal(mine.data.length, 1);
        assert.ok(!JSON.stringify(mine.data).includes('encrypted_payload')); assert.ok(!JSON.stringify(mine.data).includes('secret_hash'));
        assert.deepEqual((await api(other, '/api/email-deliveries')).data, []);
        assert.equal((await api(null, '/api/email-deliveries')).status, 401);
    });
    await check('SMTP failure persists retry state across worker process exit', async () => {
        await step(); const row = await current(first.job); assert.equal(mailRejections, 1); assert.equal(row.status, 'pending'); assert.equal(row.attempts, 1); assert.ok(row.available_at > Date.now() / 1000); assert.ok(row.encrypted_payload.length > 80);
    });
    await check('wrong encryption key refuses startup without consuming queued mail', async () => {
        assert.notEqual((await worker({ MAIL_OUTBOX_KEY: randomBytes(32).toString('hex') })).code, 0);
        const row = await current(first.job); assert.equal(row.status, 'pending'); assert.equal(row.attempts, 1);
        assert.equal(row.encrypted_payload, first.row.encrypted_payload);
    });
    await check('untrusted SMTP certificate never reaches authentication or mail submission', async () => {
        await sql(`UPDATE ${first.job} SET available_at = 0;`);
        assert.equal((await worker({ SMTP_CA_FILE: '' })).code, 0);
        const row = await current(first.job); assert.equal(row.status, 'pending'); assert.equal(row.attempts, 2);
        assert.equal(mailRejections, 1); assert.equal(messages.length, 0);
    });
    await check('concurrent restarted workers deliver one lease over verified TLS', async () => {
        rejectMail = false; await sql(`UPDATE ${first.job} SET available_at = 0;`);
        const results = await Promise.all([worker(), worker()]); assert.ok(results.some(result => result.code === 0));
        assert.equal(messages.length, 1, results.map(result => result.output.slice(-2000)).join('\n')); assert.match(messages[0], /invite_token=[a-f0-9]{64}/);
        const row = await current(first.job); assert.equal(row.status, 'delivered'); assert.equal(row.attempts, 3); assert.equal(row.encrypted_payload, ''); assert.equal(row.secret_hash, '');
        await step(); assert.equal(messages.length, 1);
    });
    await check('revoked invitation is cancelled before SMTP', async () => {
        const item = await invite('revoked'); assert.equal((await api(owner, `/api/workspaces/${workspace}/invites`, 'DELETE', { invite_id: item.invite })).status, 200);
        await step(); assert.equal((await current(item.job)).status, 'cancelled'); assert.equal(messages.length, 1);
    });
    await check('expired payload is erased without delivery', async () => {
        const item = await invite('expired'); await sql(`UPDATE ${item.job} SET expires_at = time::unix() + 20;`); await step();
        const row = await current(item.job); assert.equal(row.status, 'cancelled'); assert.equal(row.encrypted_payload, ''); assert.equal(messages.length, 1);
    });
    await check('tampered ciphertext fails authentication without SMTP', async () => {
        const item = await invite('tampered'); const cipher = item.row.encrypted_payload;
        await sql(`UPDATE ${item.job} SET encrypted_payload = '${cipher.slice(0, -1)}${cipher.endsWith('0') ? '1' : '0'}';`); await step(); assert.equal((await current(item.job)).status, 'failed'); assert.equal(messages.length, 1);
    });
    await check('delivery attempts are bounded and terminal secrets are erased', async () => {
        const item = await invite('attempts'); await sql(`UPDATE ${item.job} SET attempts = 4;`); rejectMail = true; await step(); rejectMail = false;
        const row = await current(item.job); assert.equal(row.status, 'failed'); assert.equal(row.attempts, 5); assert.equal(row.encrypted_payload, '');
    });
    await check('expired claim is recoverable by a fresh process', async () => {
        const item = await invite('lease'); await sql(`UPDATE ${item.job} SET status = 'processing', lease_until = time::unix() - 1, lease_token = 'abandoned', attempts = 1;`); await step();
        assert.equal((await current(item.job)).status, 'delivered'); assert.equal(messages.length, 2);
    });
    await check('demoted invitation issuer cannot send a queued grant', async () => {
        await sql(`CREATE workspace_members SET workspace_id = ${workspace}, user_id = ${other.id}, role = 'admin';`);
        const item = await invite('demoted', other);
        assert.equal((await api(owner, `/api/workspaces/${workspace}/members`, 'PUT', { user_id: other.id, role: 'viewer' })).status, 200);
        await step(); assert.equal((await current(item.job)).status, 'cancelled'); assert.equal(messages.length, 2);
    });
    await check('outbox insertion failure rolls back invite, signup and reset token', async () => {
        const event = `fail_mail_${run}`;
        await sql(`DEFINE EVENT ${event} ON TABLE mail_outbox WHEN $event = 'CREATE' THEN { THROW 'Injected outbox failure'; };`);
        try {
            const email = `rollback-${run}@example.invalid`;
            assert.equal((await api(owner, `/api/workspaces/${workspace}/invites`, 'POST', { email, role: 'member' })).status, 500);
            assert.equal((await sql(`SELECT id FROM workspace_invites WHERE email = '${email}';`)).length, 0);
            assert.equal((await api(null, '/api/auth/signup', 'POST', { email, name: 'Rollback Fixture', password: `Aa1${randomBytes(24).toString('hex')}` })).status, 500);
            assert.equal((await sql(`SELECT id FROM users WHERE email = '${email}';`)).length, 0);
            assert.equal((await api(null, '/api/auth/forgot-password', 'POST', { email: owner.email })).status, 200);
            assert.ok((await current(owner.id)).reset_token == null);
        } finally { await sql(`REMOVE EVENT ${event} ON TABLE mail_outbox;`); }
    });
    await check('new recovery token atomically supersedes old queued mail', async () => {
        await api(null, '/api/auth/forgot-password', 'POST', { email: owner.email });
        const before = (await sql(`SELECT * FROM mail_outbox WHERE owner_id = ${owner.id} AND kind = 'password_reset';`))[0]; assert.ok(before);
        await api(null, '/api/auth/forgot-password', 'POST', { email: owner.email });
        const after = await sql(`SELECT * FROM mail_outbox WHERE owner_id = ${owner.id} AND kind = 'password_reset';`);
        assert.equal(after.length, 1); assert.notEqual(after[0].id, before.id); assert.notEqual(after[0].secret_hash, before.secret_hash);
        await step(); assert.equal((await current(after[0].id)).status, 'delivered'); assert.equal(messages.length, 3);
    });
    await check('missing encryption key refuses worker startup', async () => { assert.notEqual((await worker({ MAIL_OUTBOX_KEY: '' })).code, 0); });
    await check('mail metadata joins user export without exposing payloads', async () => {
        const result = await api(owner, '/api/export'); assert.equal(result.status, 200); assert.ok(result.data.email_deliveries.length >= 7);
        assert.ok(!JSON.stringify(result.data).includes('encrypted_payload')); assert.ok(!JSON.stringify(result.data).includes('secret_hash'));
    });
    await check('queue saturation rejects an invitation without a partial grant', async () => {
        const prefix = `capacity_${run}_`;
        await sql(`BEGIN; FOR $i IN 0..5000 { CREATE type::record('mail_outbox', string::concat('${prefix}', <string>$i)) SET owner_id = ${other.id}, reference_id = ${other.id}, kind = 'confirmation', encrypted_payload = '', secret_hash = 'fixture', expires_at = time::unix() + 3600, available_at = time::unix() + 1800; }; COMMIT;`);
        try {
            const email = `capacity-${run}@example.invalid`;
            assert.equal((await api(owner, `/api/workspaces/${workspace}/invites`, 'POST', { email, role: 'member' })).status, 503);
            assert.equal((await sql(`SELECT id FROM workspace_invites WHERE email = '${email}';`)).length, 0);
        } finally { await sql(`DELETE mail_outbox WHERE string::starts_with(<string>id, 'mail_outbox:${prefix}');`); }
    });
    await check('protected queue metrics expose counts, never payloads', async () => {
        assert.equal((await fetch(new URL('/api/metrics', base))).status, 401);
        const result = await fetch(new URL('/api/metrics', base), { headers: { Authorization: 'Bearer integration-only-metrics' } });
        assert.equal(result.status, 200); const body = await result.text();
        assert.match(body, /mail_outbox_jobs\{status="failed"\} 2\n/);
        assert.match(body, /mail_outbox_jobs\{status="delivered"\} 3\n/);
        assert.ok(!body.includes(owner.email)); assert.ok(!body.includes('encrypted_payload'));
    });
    console.log(`${passed} durable email checks passed`);
} finally {
    for (const child of children) child.kill('SIGTERM');
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
}
