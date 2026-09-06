// Destructive regression cases run ONLY against the integration harness DB.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const base = new URL(process.env.BASE_URL);
const database = new URL(process.env.TEST_DB_URL);
for (const url of [base, database]) {
    assert.equal(url.protocol, 'http:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.ok(url.port && !['9000', '8010'].includes(url.port), 'refuse production ports');
}
const hex = () => randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const run = randomBytes(6).toString('hex');
const id = (table, key) => `${table}:sec_${run}_${key}`;
async function sql(query) {
    const response = await fetch(new URL('/sql', database), {
        method: 'POST', headers: {
            Authorization: `Basic ${Buffer.from('itroot:itpass').toString('base64')}`,
            Accept: 'application/json', 'surreal-ns': 'taskmanager_it', 'surreal-db': 'main',
        }, body: query,
    });
    assert.equal(response.status, 200);
    const rows = await response.json();
    for (const row of rows) assert.equal(row.status, 'OK', row.result);
    return rows.at(-1).result;
}
const people = {};
for (const name of ['alice', 'bob', 'viewer', 'outsider', 'reset']) {
    const token = hex(), csrf = hex();
    people[name] = { id: id('users', name), token, csrf };
    await sql(`CREATE ${people[name].id} SET name = '${name}', email = '${name}-${run}@example.invalid',
        password_hash = 'reset-required', email_verified = true;
        CREATE ${id('sessions', name)} SET user_id = ${people[name].id}, token = '${hash(token)}',
        csrf_hash = '${hash(csrf)}', expires_at = time::now() + 1h;`);
}
const wa = id('workspaces', 'a'), wb = id('workspaces', 'b');
await sql(`CREATE ${wa} SET name = 'Security A', owner_id = ${people.alice.id};
    CREATE ${wb} SET name = 'Security B', owner_id = ${people.bob.id};
    CREATE ${id('workspace_members', 'a_owner')} SET workspace_id = ${wa}, user_id = ${people.alice.id}, role = 'owner';
    CREATE ${id('workspace_members', 'b_owner')} SET workspace_id = ${wb}, user_id = ${people.bob.id}, role = 'owner';
    CREATE ${id('workspace_members', 'a_in_b')} SET workspace_id = ${wb}, user_id = ${people.alice.id}, role = 'member';
    CREATE ${id('workspace_members', 'viewer')} SET workspace_id = ${wa}, user_id = ${people.viewer.id}, role = 'viewer';`);

async function api(person, path, method = 'GET', body, extra = {}, csrf = true) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (person) {
        headers.Cookie = `session_token=${person.token}`;
        if (csrf) headers['X-CSRF-Token'] = person.csrf;
    }
    const response = await fetch(new URL(path, base), {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
}
let failed = 0, passed = 0;
async function check(name, action) {
    try { await action(); console.log(`PASS ${name}`); passed++; }
    catch (e) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}
const alice = people.alice;
const parent = (await api(alice, '/api/tasks', 'POST', { title: 'Parent', workspace_id: wa })).data;
assert.ok(parent.id, 'fixture task created');

await check('private API responses cannot be cached', async () => {
    const response = await api(alice, '/api/tasks');
    assert.match(response.headers.get('cache-control') || '', /no-store/);
});
await check('cookie plus bogus Bearer cannot bypass CSRF', async () => {
    assert.equal((await api(alice, `/api/tasks/${parent.id}`, 'PUT', { title: 'CSRF' },
        { Authorization: 'Bearer invalid' }, false)).status, 403);
});
await check('cookie plus another session Bearer still needs cookie CSRF', async () => {
    assert.equal((await api(alice, `/api/tasks/${parent.id}`, 'PUT', { title: 'Mixed' },
        { Authorization: `Bearer ${people.bob.token}` }, false)).status, 403);
});
await check('Bearer-only authentication remains supported', async () => {
    assert.equal((await api(null, `/api/tasks/${parent.id}`, 'PUT', { title: 'Parent' },
        { Authorization: `Bearer ${alice.token}` })).status, 200);
});
await check('viewer cannot edit', async () => {
    assert.equal((await api(people.viewer, `/api/tasks/${parent.id}`, 'PUT', { title: 'Denied' })).status, 403);
});
await check('viewer cannot create', async () => {
    assert.equal((await api(people.viewer, '/api/tasks', 'POST', { title: 'Denied', workspace_id: wa })).status, 403);
});
await check('outsider cannot read workspace tasks', async () => {
    assert.deepEqual((await api(people.outsider, '/api/tasks')).data, []);
});
await check('task route rejects another table before deleting an owner membership', async () => {
    assert.equal((await api(alice, `/api/tasks/${id('workspace_members', 'b_owner')}`, 'DELETE')).status, 400);
});
await check('parent must belong to the requested workspace', async () => {
    assert.equal((await api(alice, '/api/tasks', 'POST', {
        title: 'Cross-workspace child', workspace_id: wb, parent_id: parent.id,
    })).status, 400);
});
const child = (await api(alice, '/api/tasks', 'POST', {
    title: 'Child', workspace_id: wa, parent_id: parent.id,
})).data;
await check('subtasks cannot hide a second nesting level', async () => {
    assert.equal((await api(alice, '/api/tasks', 'POST', {
        title: 'Grandchild', workspace_id: wa, parent_id: child.id,
    })).status, 400);
});
await check('outsider assignment is rejected on update', async () => {
    assert.equal((await api(alice, `/api/tasks/${parent.id}`, 'PUT', { assignee_id: people.outsider.id })).status, 400);
});
await check('workspace member assignment is accepted', async () => {
    assert.equal((await api(alice, `/api/tasks/${parent.id}`, 'PUT', { assignee_id: people.viewer.id })).status, 200);
});
await check('assignment can be cleared', async () => {
    const response = await api(alice, `/api/tasks/${parent.id}`, 'PUT', { assignee_id: '' });
    assert.equal(response.status, 200); assert.equal(response.data.assignee_id, null);
});
await check('Done creation is completed', async () => {
    const response = await api(alice, '/api/tasks', 'POST', { title: 'Already done', workspace_id: wa, status: 'done' });
    assert.equal(response.data.completed, true);
});
await check('bodyless toggle keeps the board consistent', async () => {
    const response = await api(alice, `/api/tasks/${parent.id}`, 'PUT');
    assert.equal(response.data.status, response.data.completed ? 'done' : 'todo');
});

const future = new Date(Date.now() + 7 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const recurring = (await api(alice, '/api/tasks', 'POST', {
    title: `Recurring ${run}`, workspace_id: wa, due_date: future, recurrence: 'daily',
})).data;
await check('recurrence is generated only once across completion, edits and replay', async () => {
    for (const patch of [{ completed: true }, { notes: 'Edited after completion' }, { completed: true },
        { completed: false }, { completed: true }]) {
        assert.equal((await api(alice, `/api/tasks/${recurring.id}`, 'PUT', patch)).status, 200);
    }
    const tasks = (await api(alice, '/api/tasks')).data;
    assert.equal(tasks.filter(t => t.title === recurring.title).length, 2);
});
await check('exports retain status, recurrence and relationships', async () => {
    const response = await api(alice, '/api/export');
    const row = response.data.tasks.find(t => t.id === recurring.id);
    assert.equal(row.recurrence, 'daily'); assert.equal(row.status, 'done');
    assert.ok('parent_id' in row && 'assignee_id' in row);
});
await check('legacy cross-workspace children survive a foreign parent deletion', async () => {
    const foreign = id('tasks', 'legacy_child');
    await sql(`CREATE ${foreign} SET title = 'Legacy child', user_id = ${people.bob.id},
        workspace_id = ${wb}, parent_id = ${parent.id};`);
    assert.equal((await api(alice, `/api/tasks/${parent.id}`, 'DELETE')).status, 200);
    assert.equal((await sql(`SELECT id FROM ${foreign};`)).length, 1);
    assert.equal((await sql(`SELECT id FROM ${child.id};`)).length, 0);
});
await check('concurrent reset has one winner and revokes existing sessions', async () => {
    const token = hex();
    await sql(`UPDATE ${people.reset.id} SET reset_token = '${hash(token)}', reset_expires = ${Math.floor(Date.now() / 1000) + 3600};`);
    const results = await Promise.all([1, 2].map(() => api(null, '/api/auth/reset-password', 'POST', {
        token, new_password: `Aa1${hex()}`,
    })));
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal(results.filter(r => r.status === 400).length, 1);
    assert.equal((await api(people.reset, '/api/auth/me')).status, 401);
    assert.equal((await api(null, '/api/auth/reset-password', 'POST', {
        token, new_password: `Aa1${hex()}`,
    })).status, 400);
});
console.log(`${passed} security checks passed; ${failed} failed`);
process.exitCode = failed ? 1 : 0;
