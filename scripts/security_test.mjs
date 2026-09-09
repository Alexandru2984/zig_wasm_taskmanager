// Destructive regression cases run ONLY against the integration harness DB.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';

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
    if (['PUT','DELETE'].includes(method) && path.startsWith('/api/tasks/') && !Object.hasOwn(headers, 'If-Match')) {
        const current = await api(person, path);
        headers['If-Match'] = current.headers.get('etag') || '"v0"';
    }
    if (person) {
        headers.Cookie = `session_token=${person.token}`;
        if (csrf) headers['X-CSRF-Token'] = person.csrf;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers['Content-Length'] = Buffer.byteLength(payload);
    // Keep this suite's real per-IP quota separate from the smoke/browser
    // clients. Do not trust spoofed headers or disable production rate limits.
    return new Promise((resolve, reject) => {
        const request = httpRequest(new URL(path, base), {
            method, headers, localAddress: '127.0.0.2', timeout: 30000,
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
                try {
                    const responseHeaders = new Headers();
                    for (const [name, value] of Object.entries(response.headers)) {
                        for (const item of Array.isArray(value) ? value : [value]) {
                            if (item !== undefined) responseHeaders.append(name, item);
                        }
                    }
                    resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()), headers: responseHeaders });
                } catch (error) { reject(error); }
            });
        });
        request.on('error', reject);
        request.on('timeout', () => request.destroy(new Error('isolated API request timed out')));
        request.end(payload);
    });
}
let failed = 0, passed = 0;
let fixturePassword;
async function check(name, action) {
    try { await action(); console.log(`PASS ${name}`); passed++; }
    catch (e) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}
const alice = people.alice;
await check('cross-origin login is rejected before authentication', async () => {
    assert.equal((await api(null, '/api/auth/login', 'POST', {}, { Origin: 'https://attacker.invalid' })).status, 403);
});
await check('HTML form-compatible content types cannot call login', async () => {
    assert.equal((await api(null, '/api/auth/login', 'POST', {}, { 'Content-Type': 'text/plain' })).status, 415);
});
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
await check('concurrent completion creates exactly one successor', async () => {
    const task = (await api(alice, '/api/tasks', 'POST', {
        title: `Concurrent ${run}`, workspace_id: wa, due_date: future, recurrence: 'weekly',
    })).data;
    const responses = await Promise.all([1, 2].map(() => api(alice, `/api/tasks/${task.id}`, 'PUT', { completed: true })));
    assert.ok(responses.some(r => r.status === 200));
    assert.ok(responses.every(r => [200, 409, 412].includes(r.status)), JSON.stringify(responses.map(r => ({ status: r.status, error: r.data?.error }))));
    assert.equal((await api(alice, '/api/tasks')).data.filter(t => t.title === task.title).length, 2);
});
await check('old monthly recurrence skips missed dates without a duplicate backlog', async () => {
    const taskId = id('tasks', 'old_monthly');
    await sql(`CREATE ${taskId} SET user_id = ${alice.id}, workspace_id = ${wa}, title = 'Old monthly ${run}',
        created_at = d'2020-01-01T09:00:00Z', due_date = d'2020-01-31T09:00:00Z', recurrence = 'monthly';`);
    assert.equal((await api(alice, `/api/tasks/${taskId}`, 'PUT', { completed: true })).status, 200);
    const tasks = (await api(alice, '/api/tasks')).data.filter(t => t.title === `Old monthly ${run}`);
    assert.equal(tasks.length, 2);
    const next = new Date(tasks.find(t => t.id !== taskId).due_date).getTime();
    assert.ok(next > Date.now() && next < Date.now() + 32 * 86400000);
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
    assert.ok((await sql(`SELECT deleted_at FROM ${child.id};`))[0].deleted_at);
    assert.ok((await sql(`SELECT deleted_at FROM ${foreign};`))[0].deleted_at == null);
});
await check('concurrent reset has one winner and revokes existing sessions', async () => {
    const token = hex();
    await sql(`UPDATE ${people.reset.id} SET reset_token = '${hash(token)}', reset_expires = ${Math.floor(Date.now() / 1000) + 3600};`);
    const passwords = [`Aa1${hex()}`, `Aa1${hex()}`];
    const results = await Promise.all(passwords.map(new_password => api(null, '/api/auth/reset-password', 'POST', {
        token, new_password,
    })));
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal(results.filter(r => r.status === 400).length, 1);
    fixturePassword = passwords[results.findIndex(r => r.status === 200)];
    assert.equal((await api(people.reset, '/api/auth/me')).status, 401);
    assert.equal((await api(null, '/api/auth/reset-password', 'POST', {
        token, new_password: `Aa1${hex()}`,
    })).status, 400);
});
// Product-readiness regressions: use the real HTTP path, with DB-side failure
// injection confined to this disposable namespace. Never print credentials.
async function newAccount(label) {
    // Reuse a known, genuinely hashed fixture password from the reset test;
    // avoid exhausting signup limits or generating extra confirmation mail.
    const password = fixturePassword;
    assert.ok(password);
    const passwordHash = (await sql(`SELECT password_hash FROM ${people.reset.id};`))[0].password_hash;
    const email = `${label}-${run}@example.invalid`;
    const person = { id: id('users', label), token: hex(), csrf: hex(), email, password };
    await sql(`CREATE ${person.id} SET name = '${label}', email = '${email}', password_hash = ${JSON.stringify(passwordHash)}, email_verified = true;
        CREATE sessions SET user_id = ${person.id}, token = '${hash(person.token)}', csrf_hash = '${hash(person.csrf)}', expires_at = time::now() + 1h;`);
    const workspace = await api(person, '/api/workspaces', 'POST', { name: `${label} workspace` });
    assert.equal(workspace.status, 201);
    return person;
}
async function seedInvite(label, person, issuer = alice, workspace = wa) {
    const token = hex(), invite = id('workspace_invites', label);
    const email = (await sql(`SELECT email FROM ${person.id};`))[0].email;
    await sql(`CREATE ${invite} SET workspace_id = ${workspace}, email = '${email}', role = 'member',
        token = '${hash(token)}', invited_by = ${issuer.id}, expires_at = ${Math.floor(Date.now() / 1000) + 3600};`);
    return { token, invite };
}
// The reset regression intentionally revoked this fixture's earlier session.
people.reset.token = hex(); people.reset.csrf = hex();
await sql(`CREATE sessions SET user_id = ${people.reset.id}, token = '${hash(people.reset.token)}',
    csrf_hash = '${hash(people.reset.csrf)}', expires_at = time::now() + 1h;`);
await check('concurrent invitation consumption has one winner and one membership', async () => {
    const { token, invite } = await seedInvite('single_use', people.outsider);
    const results = await Promise.all([1, 2].map(() => api(people.outsider, '/api/workspaces/invites/accept', 'POST', { token })));
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.ok(results.every(r => [200, 400, 409].includes(r.status)), JSON.stringify(results.map(r => r.status)));
    assert.equal((await sql(`SELECT id FROM workspace_members WHERE workspace_id = ${wa} AND user_id = ${people.outsider.id};`)).length, 1);
    assert.ok((await sql(`SELECT accepted_at FROM ${invite};`))[0].accepted_at);
});
await check('revoked invitation cannot grant membership', async () => {
    const { token, invite } = await seedInvite('revoked', people.bob);
    assert.equal((await api(alice, `/api/workspaces/${wa}/invites`, 'DELETE', { invite_id: invite })).status, 200);
    assert.equal((await api(people.bob, '/api/workspaces/invites/accept', 'POST', { token })).status, 404);
    assert.equal((await sql(`SELECT id FROM workspace_members WHERE workspace_id = ${wa} AND user_id = ${people.bob.id};`)).length, 0);
});
await check('a demoted inviter cannot grant stale administrative authority', async () => {
    const admin = id('workspace_members', 'temporary_admin');
    await sql(`CREATE ${admin} SET workspace_id = ${wa}, user_id = ${people.bob.id}, role = 'admin';`);
    const { token } = await seedInvite('demoted_issuer', people.reset, people.bob);
    assert.equal((await api(alice, `/api/workspaces/${wa}/members`, 'PUT', { user_id: people.bob.id, role: 'viewer' })).status, 200);
    assert.equal((await api(people.reset, '/api/workspaces/invites/accept', 'POST', { token })).status, 403);
});
await check('invitation membership failure rolls back token consumption', async () => {
    const { token, invite } = await seedInvite('rollback_invite', people.reset);
    const event = `fail_member_${run}`;
    await sql(`DEFINE EVENT ${event} ON TABLE workspace_members WHEN $event = 'CREATE' AND $after.user_id = ${people.reset.id} THEN { THROW 'Injected membership failure'; };`);
    try {
        assert.equal((await api(people.reset, '/api/workspaces/invites/accept', 'POST', { token })).status, 500);
        const row = (await sql(`SELECT accepted_at FROM ${invite};`))[0];
        assert.ok(row.accepted_at == null);
        assert.equal((await sql(`SELECT id FROM workspace_members WHERE user_id = ${people.reset.id} AND workspace_id = ${wa};`)).length, 0);
    } finally { await sql(`REMOVE EVENT ${event} ON TABLE workspace_members;`); }
    assert.equal((await api(people.reset, '/api/workspaces/invites/accept', 'POST', { token })).status, 200);
});
await check('removing a member clears assignments and denies subsequent writes', async () => {
    const task = (await api(alice, '/api/tasks', 'POST', { title: 'Assigned task', workspace_id: wa, assignee_id: people.outsider.id })).data;
    assert.equal((await api(alice, `/api/workspaces/${wa}/members`, 'DELETE', { user_id: people.outsider.id })).status, 200);
    assert.equal((await api(people.outsider, `/api/tasks/${task.id}`, 'PUT', { title: 'Forbidden' })).status, 403);
    assert.ok((await sql(`SELECT assignee_id FROM ${task.id};`))[0].assignee_id == null);
});
await check('owner membership cannot be removed or demoted', async () => {
    for (const method of ['PUT', 'DELETE']) {
        assert.equal((await api(alice, `/api/workspaces/${wa}/members`, method, { user_id: alice.id, role: 'viewer' })).status, 403);
    }
    assert.equal((await sql(`SELECT role FROM workspace_members WHERE workspace_id = ${wa} AND user_id = ${alice.id};`))[0].role, 'owner');
});
await check('permission revocation wins against an in-flight task write', async () => {
    assert.equal((await api(alice, `/api/workspaces/${wa}/members`, 'PUT', { user_id: people.bob.id, role: 'member' })).status, 200);
    const task = (await api(alice, '/api/tasks', 'POST', { title: 'Before revocation', workspace_id: wa })).data;
    const event = `delay_task_${run}`;
    // SLEEP is forbidden to the production-equivalent EDITOR role. Bounded
    // hashing delays this one disposable fixture without granting DB powers.
    await sql(`DEFINE EVENT ${event} ON TABLE tasks WHEN $event = 'UPDATE' AND $after.id = ${task.id} AND $after.title = 'Forbidden late update' THEN { FOR $n IN 0..32 { LET $unused = crypto::argon2::generate('test-only-delay'); }; };`);
    try {
        let settled = false;
        const pending = api(people.bob, `/api/tasks/${task.id}`, 'PUT', { title: 'Forbidden late update' }).finally(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(settled, false, 'the delayed write must still be in flight');
        assert.equal((await api(alice, `/api/workspaces/${wa}/members`, 'PUT', { user_id: people.bob.id, role: 'viewer' })).status, 200);
        const response = await pending;
        assert.ok([403, 409].includes(response.status), `unexpected late write status ${response.status}`);
        assert.equal((await sql(`SELECT title FROM ${task.id};`))[0].title, 'Before revocation');
    } finally { await sql(`REMOVE EVENT ${event} ON TABLE tasks;`); }
});
await check('password change failure rolls back password, reset token and sessions', async () => {
    const person = await newAccount('passwordrollback');
    const before = (await sql(`SELECT password_hash FROM ${person.id};`))[0].password_hash;
    const resetToken = hash(hex());
    await sql(`UPDATE ${person.id} SET reset_token = '${resetToken}', reset_expires = ${Math.floor(Date.now() / 1000) + 3600};`);
    const event = `fail_session_${run}`;
    await sql(`DEFINE EVENT ${event} ON TABLE sessions WHEN $event = 'CREATE' AND $after.user_id = ${person.id} THEN { THROW 'Injected session failure'; };`);
    try {
        assert.equal((await api(person, '/api/profile/password', 'PUT', { old_password: person.password, new_password: `Aa1${hex()}` })).status, 500);
        const user = (await sql(`SELECT password_hash, reset_token FROM ${person.id};`))[0];
        assert.equal(user.password_hash, before);
        assert.equal(user.reset_token, resetToken);
        assert.equal((await api(person, '/api/auth/me')).status, 200);
    } finally { await sql(`REMOVE EVENT ${event} ON TABLE sessions;`); }
});
await check('parallel password changes have one winner and revoke every old session', async () => {
    const person = await newAccount('passwordrace');
    const passwords = [`Aa1${hex()}`, `Aa1${hex()}`];
    const responses = await Promise.all(passwords.map(new_password => api(person, '/api/profile/password', 'PUT', { old_password: person.password, new_password })));
    assert.equal(responses.filter(r => r.status === 200).length, 1);
    assert.ok(responses.every(r => [200, 401, 403, 409].includes(r.status)));
    assert.equal((await api(person, '/api/auth/me')).status, 401);
    assert.equal((await sql(`SELECT id FROM sessions WHERE user_id = ${person.id};`)).length, 1);
    assert.equal((await api(null, '/api/auth/login', 'POST', { email: person.email, password: person.password })).status, 401);
});
await check('password rotation prevents an already verified login from issuing a late session', async () => {
    const person = await newAccount('latelogin');
    const event = `delay_session_${run}`;
    await sql(`DEFINE EVENT ${event} ON TABLE sessions WHEN $event = 'CREATE' AND $after.user_id = ${person.id} THEN { FOR $n IN 0..32 { LET $unused = crypto::argon2::generate('test-only-delay'); }; };`);
    try {
        let settled = false;
        const pending = api(null, '/api/auth/login', 'POST', { email: person.email, password: person.password }).finally(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(settled, false);
        await sql(`BEGIN; UPDATE ${person.id} SET password_hash = 'rotated-test-password'; DELETE sessions WHERE user_id = ${person.id}; COMMIT;`);
        const response = await pending;
        assert.equal(response.status, 409);
        assert.equal((await sql(`SELECT id FROM sessions WHERE user_id = ${person.id};`)).length, 0);
        assert.equal((await api(person, '/api/auth/me')).status, 401);
    } finally { await sql(`REMOVE EVENT ${event} ON TABLE sessions;`); }
});
await check('workspace membership failure leaves no ownerless workspace', async () => {
    const person = await newAccount('workspacefailure');
    const event = `fail_workspace_member_${run}`;
    const before = await sql(`SELECT id FROM workspaces WHERE owner_id = ${person.id};`);
    await sql(`DEFINE EVENT ${event} ON TABLE workspace_members WHEN $event = 'CREATE' AND $after.user_id = ${person.id} THEN { THROW 'Injected membership failure'; };`);
    try {
        assert.equal((await api(person, '/api/workspaces', 'POST', { name: 'Must roll back' })).status, 500);
        assert.deepEqual(await sql(`SELECT id FROM workspaces WHERE owner_id = ${person.id};`), before);
    } finally { await sql(`REMOVE EVENT ${event} ON TABLE workspace_members;`); }
});
await check('default workspace initialization and legacy task attachment roll back together', async () => {
    const person = await newAccount('initialization');
    const task = id('tasks', 'legacy_initialization');
    await sql(`DELETE workspace_members WHERE user_id = ${person.id}; DELETE workspaces WHERE owner_id = ${person.id};
        CREATE ${task} SET user_id = ${person.id}, title = 'Legacy task';`);
    const event = `fail_attach_${run}`;
    await sql(`DEFINE EVENT ${event} ON TABLE tasks WHEN $event = 'UPDATE' AND $after.id = ${task} THEN { THROW 'Injected attachment failure'; };`);
    try {
        assert.equal((await api(null, '/api/auth/login', 'POST', { email: person.email, password: person.password })).status, 500);
        assert.equal((await sql(`SELECT id FROM workspaces WHERE owner_id = ${person.id};`)).length, 0);
        assert.equal((await sql(`SELECT id FROM workspace_members WHERE user_id = ${person.id};`)).length, 0);
        assert.ok((await sql(`SELECT workspace_id FROM ${task};`))[0].workspace_id == null);
        assert.equal((await sql(`SELECT id FROM sessions WHERE user_id = ${person.id};`)).length, 1);
    } finally { await sql(`REMOVE EVENT ${event} ON TABLE tasks;`); }
    const responses = await Promise.all([1, 2].map(() => api(null, '/api/auth/login', 'POST', { email: person.email, password: person.password })));
    assert.ok(responses.some(r => r.status === 200));
    assert.ok(responses.every(r => [200, 409].includes(r.status)));
    const workspaces = await sql(`SELECT id FROM workspaces WHERE owner_id = ${person.id};`);
    assert.equal(workspaces.length, 1);
    assert.equal((await sql(`SELECT workspace_id FROM ${task};`))[0].workspace_id, workspaces[0].id);
});
await check('account deletion failure leaves account and dependent data intact', async () => {
    const person = await newAccount('deleterollback');
    const mail = `mail_outbox:delete_${run}`;
    await sql(`CREATE ${mail} SET owner_id = ${person.id}, reference_id = ${person.id}, kind = 'confirmation', encrypted_payload = 'fixture', secret_hash = 'fixture', expires_at = time::unix() + 3600;`);
    const workspace = (await api(person, '/api/workspaces')).data[0].id;
    const task = (await api(person, '/api/tasks', 'POST', { title: 'Keep until commit', workspace_id: workspace })).data;
    assert.equal((await api(person, `/api/tasks/${task.id}`, 'DELETE')).status, 200);
    const event = `fail_delete_${run}`;
    await sql(`DEFINE EVENT ${event} ON TABLE users WHEN $event = 'DELETE' AND $before.id = ${person.id} THEN { THROW 'Injected deletion failure'; };`);
    try {
        assert.equal((await api(person, '/api/account', 'DELETE', { password: person.password })).status, 500);
        assert.equal((await api(person, '/api/auth/me')).status, 200);
        assert.equal((await sql(`SELECT id FROM ${task.id};`)).length, 1);
        assert.equal((await sql(`SELECT id FROM ${workspace};`)).length, 1);
        assert.equal((await sql(`SELECT id FROM workspace_members WHERE user_id = ${person.id};`)).length, 1);
        assert.equal((await sql(`SELECT id FROM ${mail};`)).length, 1);
    } finally { await sql(`REMOVE EVENT ${event} ON TABLE users;`); }
    assert.equal((await api(person, '/api/account', 'DELETE', { password: person.password })).status, 200);
    assert.equal((await sql(`SELECT id FROM ${person.id};`)).length, 0);
    assert.equal((await sql(`SELECT id FROM ${task.id};`)).length, 0);
    assert.equal((await sql(`SELECT id FROM ${workspace};`)).length, 0);
    assert.equal((await sql(`SELECT id FROM sessions WHERE user_id = ${person.id};`)).length, 0);
    assert.equal((await sql(`SELECT id FROM mail_outbox WHERE owner_id = ${person.id};`)).length, 0);
});
await check('overlapping account deletion and task creation leave no orphan data', async () => {
    const person = await newAccount('latecreate');
    const workspace = (await api(person, '/api/workspaces')).data[0].id;
    const event = `delay_create_${run}`;
    await sql(`DEFINE EVENT ${event} ON TABLE tasks WHEN $event = 'CREATE' AND $after.user_id = ${person.id} THEN { FOR $n IN 0..32 { LET $unused = crypto::argon2::generate('test-only-delay'); }; };`);
    try {
        let settled = false;
        const pending = api(person, '/api/tasks', 'POST', { title: 'Must not survive deletion', workspace_id: workspace }).finally(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(settled, false);
        assert.equal((await api(person, '/api/account', 'DELETE', { password: person.password })).status, 200);
        // Password verification can outlast the delayed CREATE. Either order
        // is valid: a committed task must be deleted, or its write must abort.
        assert.ok([201, 409].includes((await pending).status));
        assert.equal((await sql(`SELECT id FROM tasks WHERE user_id = ${person.id};`)).length, 0);
        assert.equal((await sql(`SELECT id FROM activity_events WHERE user_id = ${person.id};`)).length, 0);
        assert.equal((await sql(`SELECT id FROM ${person.id};`)).length, 0);
        assert.equal((await sql(`SELECT id FROM ${workspace};`)).length, 0);
        assert.equal((await api(person, '/api/auth/me')).status, 401);
    } finally { await sql(`REMOVE EVENT ${event} ON TABLE tasks;`); }
});
await check('deleting an author preserves other authors children and clears assignments', async () => {
    const person = await newAccount('sharedauthor');
    await sql(`CREATE workspace_members SET workspace_id = ${wa}, user_id = ${person.id}, role = 'member';`);
    const parent = (await api(person, '/api/tasks', 'POST', { title: 'Departing author parent', workspace_id: wa })).data;
    const child = (await api(alice, '/api/tasks', 'POST', { title: 'Surviving author child', workspace_id: wa, parent_id: parent.id, assignee_id: person.id })).data;
    assert.ok(child.id);
    assert.equal((await api(person, '/api/account', 'DELETE', { password: person.password })).status, 200);
    const row = (await sql(`SELECT parent_id, assignee_id, user_id FROM ${child.id};`))[0];
    assert.ok(row);
    assert.equal(row.user_id, alice.id);
    assert.ok(row.parent_id == null);
    assert.ok(row.assignee_id == null);
    assert.equal((await sql(`SELECT id FROM ${parent.id};`)).length, 0);
    assert.equal((await sql(`SELECT id FROM workspace_members WHERE user_id = ${person.id};`)).length, 0);
});
console.log(`${passed} security checks passed; ${failed} failed`);
process.exitCode = failed ? 1 : 0;
