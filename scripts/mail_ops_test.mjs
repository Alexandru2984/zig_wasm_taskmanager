// No production configuration, network endpoints or SMTP credentials are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const root = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'taskmanager-mail-ops-'));
let passed = 0;
const run = (script, ...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
});
const write = (name, data, mode = 0o600) => { const target = path.join(work, name); fs.writeFileSync(target, data, { mode }); return target; };
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
let mode = 'healthy', requests = 0;
const server = createServer((req, res) => {
    requests++;
    if (req.url === '/api/ready') { res.end(JSON.stringify({ status: 'ready' })); return; }
    if (req.headers.authorization !== 'Bearer fixture-health-token') { res.writeHead(401).end(); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/never-contact' }).end(); return; }
    if (mode === 'missing') { res.end('app_uptime_seconds 1\n'); return; }
    res.end(['pending', 'processing', 'failed'].flatMap(status => [
        `mail_outbox_jobs{status="${status}"} ${mode === 'failed' && status === 'failed' ? 1 : 0}`,
        `mail_outbox_oldest_seconds{status="${status}"} ${mode === 'backlog' && status === 'pending' ? 301 : 0}`,
    ]).join('\n'));
});
try {
    await check('blank key is provisioned privately with identical recovery material', async () => {
        const source = write('runtime.env', 'MAIL_OUTBOX_KEY=\nMAIL_WORKER_ENABLED=1\n', 0o640);
        const recovery = path.join(work, 'recovery.env');
        const result = await run('provision_mail_key.mjs', source, recovery); assert.equal(result.code, 0, result.output);
        const content = fs.readFileSync(source, 'utf8'); assert.match(content, /MAIL_OUTBOX_KEY=[a-f0-9]{64}\n/);
        assert.equal(content, fs.readFileSync(recovery, 'utf8')); assert.equal(fs.statSync(source).mode & 0o777, 0o640);
        assert.equal(fs.statSync(recovery).mode & 0o777, 0o600); assert.ok(!result.output.includes(content.match(/KEY=(\w+)/)[1]));
        const again = await run('provision_mail_key.mjs', source, path.join(work, 'second.env'));
        assert.equal(again.code, 0); assert.equal(fs.readFileSync(source, 'utf8'), content);
    });
    await check('quoted export key is retained and duplicate or invalid definitions are refused', async () => {
        const value = 'a1'.repeat(32), content = `export MAIL_OUTBOX_KEY="${value}" # keep\n`;
        const source = write('quoted.env', content);
        assert.equal((await run('provision_mail_key.mjs', source, path.join(work, 'quoted-recovery.env'))).code, 0);
        assert.equal(fs.readFileSync(source, 'utf8'), content);
        for (const [name, data] of [['duplicate', `${content}${content}`], ['invalid', 'MAIL_OUTBOX_KEY=bad\n']]) {
            const target = write(`${name}.env`, data);
            assert.notEqual((await run('provision_mail_key.mjs', target, path.join(work, `${name}-recovery.env`))).code, 0);
            assert.equal(fs.readFileSync(target, 'utf8'), data);
        }
    });
    await check('unsafe source permissions, symlinks and existing recovery paths are refused', async () => {
        const source = write('unsafe.env', '', 0o644);
        assert.notEqual((await run('provision_mail_key.mjs', source, path.join(work, 'unsafe-recovery.env'))).code, 0);
        const link = path.join(work, 'link.env'); fs.symlinkSync(source, link);
        assert.notEqual((await run('provision_mail_key.mjs', link, path.join(work, 'link-recovery.env'))).code, 0);
        const privateSource = write('unchanged.env', 'PORT=1\n'), existing = write('existing.env', 'preserved');
        assert.notEqual((await run('provision_mail_key.mjs', privateSource, existing)).code, 0);
        assert.equal(fs.readFileSync(privateSource, 'utf8'), 'PORT=1\n'); assert.equal(fs.readFileSync(existing, 'utf8'), 'preserved');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port, url = `http://127.0.0.1:${port}`;
    const config = write('health.env', `PORT=${port}\nAPP_BASE_URL=https://example.invalid\nMETRICS_TOKEN=fixture-health-token\n`);
    for (const [scenario, fault] of [['healthy', null], ['failed', 'mail_failed'], ['backlog', 'mail_backlog'], ['missing', 'mail_metrics_missing'], ['redirect', 'metrics_unreachable']]) {
        await check(`health probe reports ${scenario} without leaking its token`, async () => {
            mode = scenario; const result = await run('check_health.mjs', config, url);
            assert.equal(result.code, fault ? 1 : 0, result.output); const data = JSON.parse(result.output);
            assert.equal(data.ok, !fault); if (fault) assert.ok(data.faults.includes(fault));
            assert.ok(!result.output.includes('fixture-health-token'));
        });
    }
    await check('health probe refuses unrelated endpoints before any request', async () => {
        const before = requests;
        assert.notEqual((await run('check_health.mjs', config, `http://localhost:${port}`)).code, 0);
        assert.equal(requests, before);
    });
    console.log(`${passed} private mail operation checks passed`);
} finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(work, { recursive: true });
}
