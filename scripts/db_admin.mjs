// Local deployment operations. Secrets are read from a private file, never
// interpolated into command arguments or printed. Backup output is mode 0600.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const [action, source, destination] = process.argv.slice(2);
assert.ok(['backup', 'restore-test', 'provision-runtime', 'verify-runtime', 'rotate-admin', 'verify-admin'].includes(action));
assert.ok(source && destination, 'usage: db_admin.mjs action env-file output-path-or-test-url');
const raw = fs.readFileSync(source, 'utf8');
const cfg = {};
for (const line of raw.split('\n')) {
    let single = false, double = false, end = line.length;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === "'" && !double) single = !single;
        if (line[i] === '"' && !single) double = !double;
        if (line[i] === '#' && !single && !double) { end = i; break; }
    }
    const match = line.slice(0, end).match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match) cfg[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
assert.ok(/^[a-zA-Z0-9_]+$/.test(cfg.SURREAL_NS));
assert.ok(/^[a-zA-Z0-9_]+$/.test(cfg.SURREAL_DB));
const url = new URL(cfg.SURREAL_URL);
assert.equal(url.hostname, '127.0.0.1', 'only local database operations are supported');
const headers = {
    Authorization: `Basic ${Buffer.from(`${cfg.SURREAL_USER}:${cfg.SURREAL_PASS}`).toString('base64')}`,
    Accept: 'application/json', 'surreal-ns': cfg.SURREAL_NS, 'surreal-db': cfg.SURREAL_DB,
};
if (cfg.SURREAL_AUTH_LEVEL === 'database') {
    headers['surreal-auth-ns'] = cfg.SURREAL_NS; headers['surreal-auth-db'] = cfg.SURREAL_DB;
}
async function query(sql, endpoint = url, requestHeaders = headers) {
    const response = await fetch(new URL('/sql', endpoint), { method: 'POST', headers: requestHeaders, body: sql });
    assert.equal(response.status, 200, 'database HTTP request failed');
    const rows = await response.json();
    assert.ok(Array.isArray(rows), 'unexpected DB response');
    return rows;
}
function successful(rows) {
    assert.ok(rows.every(row => row.status === 'OK'), 'database operation failed (details withheld)');
    return rows;
}

if (action === 'rotate-admin') {
    // A durable recovery file is created BEFORE changing the database. If the
    // HTTP response or final config replacement is lost, that file contains
    // the candidate credential; never generate another candidate blindly.
    assert.notEqual(cfg.SURREAL_AUTH_LEVEL, 'database');
    assert.match(cfg.SURREAL_USER, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
    const original = fs.lstatSync(source);
    assert.ok(original.isFile() && !original.isSymbolicLink(), 'source must be a regular private config');
    assert.equal(original.mode & 0o077, 0, 'source config must be private');
    const parent = fs.statSync(path.dirname(destination));
    assert.ok(parent.isDirectory() && (parent.mode & 0o077) === 0, 'recovery directory must be private');
    assert.ok(!fs.existsSync(destination), 'recovery config already exists; inspect it before retrying');
    const info = successful(await query('INFO FOR ROOT;'))[0].result;
    assert.ok(Object.hasOwn(info.users, cfg.SURREAL_USER), 'configured root identity must exist');
    assert.ok(Object.hasOwn(info.namespaces, cfg.SURREAL_NS));
    for (const other of Object.keys(info.namespaces).filter(name => name !== cfg.SURREAL_NS)) {
        // SurrealDB 3.x creates an empty main/main at bootstrap. Accept that
        // exact empty default, not another application's namespace or schema.
        assert.equal(other, 'main', 'shared DB server requires a separate rotation review');
        const defaultHeaders = { ...headers, 'surreal-ns': 'main', 'surreal-db': 'main' };
        const ns = successful(await query('INFO FOR NS;', url, defaultHeaders))[0].result;
        assert.deepEqual(Object.keys(ns.databases), ['main']);
        assert.ok(Object.entries(ns).filter(([key]) => key !== 'databases').every(([, value]) => Object.keys(value).length === 0));
        const database = successful(await query('INFO FOR DB;', url, defaultHeaders))[0].result;
        assert.ok(Object.values(database).every(value => Object.keys(value).length === 0), 'default namespace contains resources; review shared scope');
    }
    const password = randomBytes(48).toString('base64url');
    const filtered = raw.split('\n').filter(line => !/^\s*(?:export\s+)?SURREAL_PASS\s*=/.test(line)).join('\n');
    const replacement = `${filtered}\nSURREAL_PASS=${password}\n`;
    function durableFile(filename, uid, gid) {
        const fd = fs.openSync(filename, 'wx', 0o600);
        try { fs.writeFileSync(fd, replacement); fs.fchownSync(fd, uid, gid); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        const dir = fs.openSync(path.dirname(filename), 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    durableFile(destination, process.getuid(), process.getgid());
    // ALTER changes only the password, preserving the existing role/duration.
    successful(await query(`ALTER USER ${cfg.SURREAL_USER} ON ROOT PASSWORD '${password}';`));
    const rotatedHeaders = { ...headers, Authorization: `Basic ${Buffer.from(`${cfg.SURREAL_USER}:${password}`).toString('base64')}` };
    successful(await query('INFO FOR ROOT;', url, rotatedHeaders));
    const old = await fetch(new URL('/sql', url), { method: 'POST', headers, body: 'INFO FOR ROOT;' });
    assert.equal(old.status, 401, 'old administrator password must no longer authenticate');
    const next = `${source}.rotation-${randomBytes(8).toString('hex')}`;
    durableFile(next, original.uid, original.gid);
    fs.renameSync(next, source);
    const directory = fs.openSync(path.dirname(source), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    console.log('Administrator credential rotated; old authentication denied; private source and recovery configs saved.');
} else if (action === 'verify-admin') {
    successful(await query('INFO FOR ROOT;'));
    console.log('Administrator authentication verified (details withheld).');
} else if (action === 'backup') {
    const response = await fetch(new URL('/export', url), { headers: { ...headers, Accept: 'application/octet-stream' } });
    assert.equal(response.status, 200, 'export failed');
    const data = Buffer.from(await response.arrayBuffer());
    assert.ok(data.length > 100, 'empty export refused');
    fs.writeFileSync(destination, data, { flag: 'wx', mode: 0o600 });
    console.log(`Private database backup created (${data.length} bytes)`);
} else if (action === 'restore-test') {
    // Destination is a disposable server URL; the backup path is explicit.
    const test = new URL(destination);
    assert.equal(test.hostname, '127.0.0.1');
    assert.equal(test.protocol, 'http:');
    assert.notEqual(test.origin, url.origin, 'restoring into the source is forbidden');
    assert.ok(!['8010', '9000', ''].includes(test.port));
    const backup = process.argv[5];
    assert.ok(backup, 'backup path required');
    assert.ok(process.env.TEST_DB_USER && process.env.TEST_DB_PASS, 'private disposable DB credentials are required');
    const testHeaders = { ...headers, Authorization: `Basic ${Buffer.from(`${process.env.TEST_DB_USER}:${process.env.TEST_DB_PASS}`).toString('base64')}` };
    successful(await query(`DEFINE NAMESPACE IF NOT EXISTS ${cfg.SURREAL_NS}; DEFINE DATABASE IF NOT EXISTS ${cfg.SURREAL_DB};`, test, testHeaders));
    const info = successful(await query('INFO FOR DB;', test, testHeaders));
    assert.equal(Object.keys(info[0].result.tables || {}).length, 0, 'restore destination must have no tables');
    const response = await fetch(new URL('/import', test), {
        method: 'POST', headers: testHeaders, body: fs.readFileSync(backup),
    });
    assert.equal(response.status, 200, 'restore import failed');
    successful(await response.json());
    const countQuery = 'SELECT count() FROM users GROUP ALL; SELECT count() FROM tasks GROUP ALL; SELECT count() FROM sessions GROUP ALL;';
    const restored = successful(await query(countQuery, test, testHeaders)).map(row => row.result);
    const live = successful(await query(countQuery)).map(row => row.result);
    assert.deepEqual(restored, live, 'counts changed since backup or restore is incomplete');
    console.log('Restore drill passed: users, tasks and session counts match the source');
} else if (action === 'provision-runtime') {
    assert.ok(!fs.existsSync(destination), 'runtime config already exists; refusing to replace credentials');
    const password = randomBytes(36).toString('base64url');
    successful(await query(`DEFINE USER taskmanager_runtime ON DATABASE PASSWORD '${password}' ROLES EDITOR;`));
    const restrictedHeaders = {
        ...headers, Authorization: `Basic ${Buffer.from(`taskmanager_runtime:${password}`).toString('base64')}`,
        'surreal-auth-ns': cfg.SURREAL_NS, 'surreal-auth-db': cfg.SURREAL_DB,
    };
    successful(await query('SELECT version FROM schema_migrations LIMIT 1;', url, restrictedHeaders));
    const denied = await query('INFO FOR ROOT;', url, restrictedHeaders);
    assert.ok(denied.some(row => row.status === 'ERR'), 'runtime must not have root rights');
    const replacements = { SURREAL_USER: 'taskmanager_runtime', SURREAL_PASS: password,
        SURREAL_AUTH_LEVEL: 'database', DB_AUTO_MIGRATE: '0', DB_MIGRATE_ONLY: '0', SERVER_THREADS: '4' };
    const filtered = raw.split('\n').filter(line => !Object.keys(replacements).some(key =>
        new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line))).join('\n');
    const config = `${filtered}\n${Object.entries(replacements).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
    fs.writeFileSync(destination, config, { flag: 'wx', mode: 0o600 });
    console.log('Database-scoped runtime user provisioned; root access denied');
} else {
    successful(await query('SELECT version FROM schema_migrations LIMIT 1;'));
    assert.ok((await query('INFO FOR ROOT;')).some(row => row.status === 'ERR'));
    console.log('Runtime authentication works and root access is denied');
}
