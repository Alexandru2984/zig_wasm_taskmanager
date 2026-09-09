// Synthetic task mutation tests. Never target the production listener or DB.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { request } from 'node:http';
const base = new URL(process.env.BASE_URL), database = new URL(process.env.TEST_DB_URL);
for (const url of [base, database]) {
    assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
    assert.ok(url.port && !['9000', '8010'].includes(url.port));
}
const run = randomBytes(6).toString('hex'), hash = value => createHash('sha256').update(value).digest('hex');
const id = (table, label) => `${table}:trash_${run}_${label}`;
async function sql(body) {
    const res = await fetch(new URL('/sql', database), { method: 'POST', headers: { Authorization: `Basic ${Buffer.from('itroot:itpass').toString('base64')}`, Accept: 'application/json', 'surreal-ns': 'taskmanager_it', 'surreal-db': 'main' }, body });
    assert.equal(res.status, 200); const rows = await res.json();
    for (const row of rows) assert.equal(row.status, 'OK', row.result);
    return rows.at(-1).result;
}
const people = {};
for (const name of ['owner', 'member', 'viewer', 'outside']) {
    const person = people[name] = { id: id('users', name), token: randomBytes(32).toString('hex'), csrf: randomBytes(32).toString('hex') };
    await sql(`CREATE ${person.id} SET name = '${name}', email = '${name}-${run}@example.invalid', password_hash = 'reset-required', email_verified = true;
        CREATE sessions SET user_id = ${person.id}, token = '${hash(person.token)}', csrf_hash = '${hash(person.csrf)}', expires_at = time::now() + 1h;`);
}
const { owner, member, viewer, outside } = people, workspace = id('workspaces', 'owned');
await sql(`CREATE ${workspace} SET name = 'Trash fixture', owner_id = ${owner.id};`);
for (const role of ['owner', 'member', 'viewer']) await sql(`CREATE workspace_members SET workspace_id = ${workspace}, user_id = ${people[role].id}, role = '${role}';`);
async function api(person, path, method = 'GET', body, csrf = true) {
    const conditional = ['PUT','DELETE'].includes(method) && path.startsWith('/api/tasks/')
        ? { 'If-Match': (await api(person, path)).headers.etag || '"v0"' } : {};
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = request(new URL(path, base), { method, localAddress: '127.0.0.4', timeout: 30000, headers: {
            'Content-Type': 'application/json', ...conditional, ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
            ...(person ? { Cookie: `session_token=${person.token}`, ...(csrf ? { 'X-CSRF-Token': person.csrf } : {}) } : {}),
        }}, res => {
            const chunks = []; res.on('data', x => chunks.push(x)); res.on('error', reject);
            res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (e) { reject(e); } });
        }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('fixture request timeout'))); req.end(payload);
    });
}
const current = async record => (await sql(`SELECT * FROM ${record};`))[0];
async function create(title, fields = {}) {
    const result = await api(owner, '/api/tasks', 'POST', { title, workspace_id: workspace, ...fields });
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;
}
const remove = record => api(owner, `/api/tasks/${record}`, 'DELETE');
const restore = (record, person = owner) => api(person, `/api/trash/${encodeURIComponent(record)}`, 'POST');
const trashPath = `/api/trash?workspace_id=${workspace}`;
const parent = await create(`Original <script>fixture</script> ${run}`, { notes: 'Keep all notes', tags: ['original'], priority: 'high', recurrence: 'daily', assignee_id: member.id, due_date: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
const child = await create('Child in parent batch', { parent_id: parent.id, notes: 'Child notes' });
const separate = await create('Independently deleted child', { parent_id: parent.id });
const beforeParent = await current(parent.id), beforeChild = await current(child.id);
const business = row => Object.fromEntries(Object.entries(row).filter(([key]) => !['deleted_at', 'delete_batch', 'version'].includes(key)));
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
await check('soft deletion atomically retains original rows and batches only active children', async () => {
    assert.equal((await remove(separate.id)).status, 200);
    assert.equal((await remove(parent.id)).status, 200);
    const p = await current(parent.id), c = await current(child.id), s = await current(separate.id);
    assert.ok(p.deleted_at); assert.equal(p.delete_batch, c.delete_batch); assert.notEqual(p.delete_batch, s.delete_batch);
    assert.deepEqual(business(p), business(beforeParent)); assert.deepEqual(business(c), business(beforeChild));
    const active = (await api(owner, '/api/tasks')).data;
    assert.ok(!active.some(t => [parent.id, child.id, separate.id].includes(t.id)));
});
await check('trash enforces authentication, workspace scope, viewer permissions and CSRF', async () => {
    assert.equal((await api(null, trashPath)).status, 401); assert.equal((await api(outside, trashPath)).status, 403);
    const visible = await api(viewer, trashPath); assert.equal(visible.status, 200); assert.equal(visible.data.items.length, 3);
    assert.equal(visible.headers['cache-control'], 'no-store');
    assert.equal((await restore(parent.id, viewer)).status, 403); assert.equal((await restore(parent.id, outside)).status, 403);
    assert.equal((await api(owner, `/api/trash/${parent.id}`, 'POST', undefined, false)).status, 403);
    assert.equal((await api(owner, '/api/trash/users:invalid', 'POST')).status, 400);
    assert.equal((await api(owner, `${trashPath}&cursor=users:invalid`)).status, 400);
    assert.equal((await api(owner, `/api/trash/${parent.id}`)).status, 405);
});
await check('deleted tasks cannot be edited or used as new subtask parents', async () => {
    assert.equal((await api(owner, `/api/tasks/${parent.id}`, 'PUT', { notes: 'Must not overwrite' })).status, 403);
    assert.equal((await api(owner, '/api/tasks', 'POST', { title: 'Forbidden child', workspace_id: workspace, parent_id: parent.id })).status, 403);
    assert.equal((await current(parent.id)).notes, 'Keep all notes');
});
await check('account export distinguishes retained trash without dropping task metadata', async () => {
    const result = await api(owner, '/api/export'); assert.equal(result.status, 200);
    const row = result.data.tasks.find(t => t.id === parent.id); assert.ok(row.deleted_at); assert.ok(row.delete_batch);
    assert.equal(row.notes, parent.notes); assert.equal(row.assignee_id, member.id); assert.equal(row.due_date, parent.due_date);
});
await check('subtask restore refuses a still-deleted parent', async () => {
    assert.equal((await restore(child.id)).status, 409); assert.equal((await restore(separate.id)).status, 409);
});
await check('failed cascade restore rolls back both parent and child', async () => {
    const event = `fail_restore_${run}`;
    await sql(`DEFINE EVENT ${event} ON TABLE tasks WHEN $event = 'UPDATE' AND $after.id = ${child.id} AND $before.deleted_at != NONE AND $after.deleted_at = NONE THEN { THROW 'Injected restore failure'; };`);
    try { assert.equal((await restore(parent.id)).status, 500); assert.ok((await current(parent.id)).deleted_at); assert.ok((await current(child.id)).deleted_at); }
    finally { await sql(`REMOVE EVENT ${event} ON TABLE tasks;`); }
});
await check('restore preserves IDs, timestamps, recurrence, assignments and child metadata', async () => {
    assert.equal((await restore(parent.id)).status, 200);
    assert.deepEqual(business(await current(parent.id)), business(beforeParent)); assert.deepEqual(business(await current(child.id)), business(beforeChild));
    assert.ok((await current(parent.id)).deleted_at == null); assert.ok((await current(child.id)).deleted_at == null);
    assert.ok((await current(separate.id)).deleted_at); assert.equal((await restore(separate.id)).status, 200);
    assert.equal((await current(separate.id)).parent_id, parent.id);
});
await check('repeated restore cannot duplicate a row or overwrite later edits', async () => {
    assert.equal((await api(owner, `/api/tasks/${parent.id}`, 'PUT', { notes: 'Newer edit' })).status, 200);
    assert.equal((await restore(parent.id)).status, 400); assert.equal((await current(parent.id)).notes, 'Newer edit');
});
await check('restoring a completed recurrence does not spawn a duplicate successor', async () => {
    assert.equal((await api(owner, `/api/tasks/${parent.id}`, 'PUT', { completed: true })).status, 200);
    const count = (await sql(`SELECT id FROM tasks WHERE title = '${parent.title}';`)).length; assert.equal(count, 2);
    await remove(parent.id); await restore(parent.id);
    assert.equal((await sql(`SELECT id FROM tasks WHERE title = '${parent.title}';`)).length, count);
    assert.equal((await current(parent.id)).recurrence_spawned, true);
});
await check('failed cascade deletion does not leave a partially deleted family', async () => {
    const event = `fail_trash_${run}`;
    await sql(`DEFINE EVENT ${event} ON TABLE tasks WHEN $event = 'UPDATE' AND $after.id = ${child.id} AND $before.deleted_at = NONE AND $after.deleted_at != NONE THEN { THROW 'Injected deletion failure'; };`);
    try { assert.equal((await remove(parent.id)).status, 500); assert.ok((await current(parent.id)).deleted_at == null); assert.ok((await current(child.id)).deleted_at == null); }
    finally { await sql(`REMOVE EVENT ${event} ON TABLE tasks;`); }
});
await check('permission revocation defeats an overlapping restore transaction', async () => {
    await remove(parent.id);
    const event = `delay_restore_${run}`;
    await sql(`DEFINE EVENT ${event} ON TABLE tasks WHEN $event = 'UPDATE' AND $after.id = ${parent.id} AND $before.deleted_at != NONE AND $after.deleted_at = NONE THEN { FOR $n IN 0..32 { LET $unused = crypto::argon2::generate('test-only-delay'); }; };`);
    try {
        let settled = false; const pending = restore(parent.id, member).finally(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 250)); assert.equal(settled, false);
        assert.equal((await api(owner, `/api/workspaces/${workspace}/members`, 'PUT', { user_id: member.id, role: 'viewer' })).status, 200);
        assert.equal((await pending).status, 409); assert.ok((await current(parent.id)).deleted_at);
    } finally { await sql(`REMOVE EVENT ${event} ON TABLE tasks;`); }
});
await check('removing an assignee while trashed cannot resurrect their assignment', async () => {
    assert.equal((await api(owner, `/api/workspaces/${workspace}/members`, 'DELETE', { user_id: member.id })).status, 200);
    assert.equal((await restore(parent.id, member)).status, 403); assert.equal((await restore(parent.id)).status, 200);
    assert.ok((await current(parent.id)).assignee_id == null);
});
await check('concurrent restore has one winner and never duplicates the original', async () => {
    await remove(parent.id); const results = await Promise.all([restore(parent.id), restore(parent.id)]);
    assert.equal(results.filter(r => r.status === 200).length, 1); assert.ok(results.every(r => [200, 400, 409].includes(r.status)));
    assert.ok((await current(parent.id)).deleted_at == null);
});
await check('a stale Undo batch cannot reverse a newer deletion', async () => {
    const first = await remove(parent.id); assert.match(first.data.delete_batch, /^[a-f0-9]{64}$/);
    assert.equal((await restore(parent.id)).status, 200);
    const second = await remove(parent.id); assert.notEqual(second.data.delete_batch, first.data.delete_batch);
    assert.equal((await api(owner, `/api/trash/${parent.id}`, 'POST', { delete_batch: first.data.delete_batch })).status, 409);
    assert.ok((await current(parent.id)).deleted_at);
    assert.equal((await api(owner, `/api/trash/${parent.id}`, 'POST', { delete_batch: second.data.delete_batch })).status, 200);
});
await check('trash cursor pages expose more than 200 rows without duplicates', async () => {
    await sql(`BEGIN; FOR $i IN 0..205 { CREATE type::record('tasks', string::concat('trash_page_${run}_', <string>$i)) SET user_id = ${owner.id}, workspace_id = ${workspace}, title = 'Pagination fixture', deleted_at = time::unix(), delete_batch = 'fixture'; }; COMMIT;`);
    const seen = new Set(); let cursor = null, pages = 0;
    do {
        const response = await api(owner, trashPath + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')); assert.equal(response.status, 200);
        assert.ok(response.data.items.length <= 100);
        for (const row of response.data.items) { assert.ok(!seen.has(row.id)); seen.add(row.id); assert.equal(row.workspace_id, workspace); }
        cursor = response.data.next_cursor; assert.ok(++pages <= 4);
    } while (cursor);
    assert.equal(seen.size, 205); assert.equal(pages, 3);
});
console.log(`${passed} task trash checks passed`);
