// Zig Tasks — front-end controller.
//
// Auth is carried only by the HttpOnly session cookie. The session token is
// never read or stored by script, so an XSS cannot exfiltrate it; the CSRF
// token is readable by design, because it has to be echoed back in a header,
// and it is bound server-side to the session it was issued with.
//
// Every value that originates from a user — a task title, a workspace name, a
// tag, another member's email — is written with textContent or setAttribute.
// There is no innerHTML anywhere in this file with a non-literal argument.

'use strict';

// ============ STATE ============

const state = {
    user: null,
    tasks: [],
    workspaces: [],
    currentWorkspaceId: null,
    filter: 'all',
    tagFilter: null,
    sort: 'created_desc',
    search: '',
    editingId: null,
    completedCollapsed: false,
    loading: false,
    /// 'list' or 'board'.
    view: 'list',
    /// Ids of tasks ticked for a bulk action. A Set because membership is
    /// checked once per row on every render.
    selection: new Set(),
    selectMode: false,
    /// Workspace members, for the assignee picker. Loaded lazily: it needs
    /// admin rights, which most members will not have.
    members: [],
    addingSubtaskFor: null,
    savedViews: [],
    savedViewContext: null,
    activeSavedView: '',
};

const STATUSES = ['todo', 'doing', 'done'];
const STATUS_LABEL = { todo: 'To do', doing: 'In progress', done: 'Done' };

let wasm = null;
let wasmMemory = null;
let suppressRender = false;

const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let lastFocused = null;

const $ = (id) => document.getElementById(id);

// ============ TOASTS & ANNOUNCER ============

/** Transient feedback. Replaces the pattern of writing into a per-form success
 *  div and clearing it on a timer, which only worked where such a div existed
 *  and said nothing at all for task actions. */
function toast(message, kind = '', action = null) {
    const region = $('toastRegion');
    if (!region) return;

    const el = document.createElement('div');
    el.className = kind ? `toast toast-${kind}` : 'toast';

    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);

    if (action) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toast-action';
        btn.textContent = action.label;
        btn.addEventListener('click', () => {
            el.remove();
            action.onClick();
        });
        el.appendChild(btn);
    }

    region.appendChild(el);
    setTimeout(() => el.remove(), action ? 8000 : 4000);
}

function announce(message) {
    const el = $('announcer');
    if (!el) return;
    el.textContent = '';
    setTimeout(() => { el.textContent = message; }, 30);
}

// ============ HTTP ============

function getCookie(name) {
    const prefix = `${name}=`;
    return document.cookie
        .split(';')
        .map(part => part.trim())
        .find(part => part.startsWith(prefix))
        ?.slice(prefix.length) || '';
}

// The CSRF cookie is `__Host-csrf_token` in production. The prefix is a
// browser-enforced guarantee that no other host under the parent domain could
// have set it. Plain-HTTP local development cannot use the prefix (it requires
// Secure), so fall back to the bare name there.
function csrfToken() {
    return getCookie('__Host-csrf_token') || getCookie('csrf_token');
}

function csrfHeaders(headers = {}) {
    const token = csrfToken();
    return token ? { ...headers, 'X-CSRF-Token': token } : headers;
}

/**
 * One place that knows how to talk to the API.
 *
 * Returns { ok, status, data }. A 401 on any authenticated call means the
 * session lapsed — the app drops to the signed-out view rather than leaving a
 * stale username in the corner while every request fails.
 */
async function api(path, { method = 'GET', body = null, quiet = false } = {}) {
    const requestUser = state.user;
    const options = { method, credentials: 'include', headers: {} };

    if (body !== null) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }
    if (method !== 'GET' && method !== 'HEAD') {
        options.headers = csrfHeaders(options.headers);
    }

    let response;
    try {
        response = await fetch(path, options);
    } catch (_) {
        if (!quiet) toast('Connection error. Check your network.', 'error');
        return { ok: false, status: 0, data: null };
    }

    let data = null;
    try {
        data = await response.json();
    } catch (_) {
        // 204s and error pages from nginx have no JSON body; that is fine.
    }

    if (response.status === 401 && requestUser !== null && state.user === requestUser) {
        showLoggedOut();
        if (!quiet) toast('Your session expired. Please log in again.', 'error');
    }
    if (response.status === 429 && !quiet) {
        toast(data?.error || 'Too many requests. Please slow down.', 'error');
    }

    return { ok: response.ok, status: response.status, data };
}

// ============ THEME ============

function systemTheme() {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || systemTheme();
}

function updateThemeIcon() {
    const icon = $('themeIcon');
    if (icon) icon.textContent = currentTheme() === 'dark' ? '🌙' : '☀️';
}

function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') {
        root.setAttribute('data-theme', theme);
    } else {
        root.removeAttribute('data-theme');
    }
    updateThemeIcon();
}

function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    try {
        localStorage.setItem('theme', next);
    } catch (_) { /* private mode */ }
    applyTheme(next);
    announce(`${next} theme`);
}

function initTheme() {
    let saved = null;
    try {
        saved = localStorage.getItem('theme');
    } catch (_) { /* ignore */ }
    if (saved === 'light' || saved === 'dark') applyTheme(saved);
    else updateThemeIcon();
}

// ============ FORM HELPERS ============

function setButtonLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
        btn.dataset.originalText = btn.textContent;
        btn.textContent = 'Working…';
        btn.disabled = true;
    } else {
        btn.textContent = btn.dataset.originalText || btn.textContent;
        btn.disabled = false;
    }
}

function formButton(form) {
    return form.querySelector('button[type="submit"]');
}

function setError(id, message) {
    const el = $(id);
    if (el) el.textContent = message || '';
}

function isLoggedIn() {
    return state.user !== null;
}

// ============ AUTH ============

async function checkAuth() {
    const { ok, data } = await api('/api/auth/me', { quiet: true });
    if (ok && data) {
        showLoggedIn(data);
    } else {
        showLoggedOut();
    }
}

function showLoggedIn(user) {
    if (state.user?.id !== user.id) {
        state.tasks = [];
        state.currentWorkspaceId = null;
        state.savedViewContext = null;
    }
    state.user = user;
    $('authButtons').classList.add('hidden');
    $('userMenu').classList.remove('hidden');
    $('workspaceBar').classList.remove('hidden');

    const initial = (user.name || '?').charAt(0).toUpperCase();
    $('userName').textContent = user.name;
    $('userEmail').textContent = user.email;
    $('userAvatar').textContent = initial;
    $('profileName').textContent = user.name;
    $('profileEmail').textContent = user.email;
    $('profileAvatar').textContent = initial;
    $('profileNameInput').value = user.name;
    const subtitle = $('heroSubtitle');
    subtitle.textContent = `Signed in as ${user.email}`;
    // The line is clipped with an ellipsis when it does not fit, so keep the
    // full address reachable on hover and to assistive tech.
    subtitle.title = user.email;

    renderVerifiedBadge(user);
}

function renderVerifiedBadge(user) {
    const badge = $('profileVerified');
    badge.textContent = '';

    const span = document.createElement('span');
    if (user.email_verified) {
        span.className = 'badge badge-success';
        span.textContent = '✅ Verified';
        badge.appendChild(span);
        return;
    }

    span.className = 'badge badge-warning';
    span.textContent = '⚠️ Not verified';
    const link = document.createElement('a');
    link.href = '#';
    link.dataset.action = 'verify-now';
    link.textContent = 'Verify now';
    badge.append(span, link);
}

function showLoggedOut() {
    state.user = null;
    state.tasks = getAnonTasks();
    state.savedViewContext = null;
    state.selection.clear();
    state.workspaces = [];
    state.currentWorkspaceId = null;
    $('authButtons').classList.remove('hidden');
    $('userMenu').classList.add('hidden');
    $('workspaceBar').classList.add('hidden');
    $('heroSubtitle').textContent = 'A little clarity. A little progress. Every day.';
    $('heroSubtitle').removeAttribute('title');
    closeDropdown();
    setLoading(false);
    $('taskLoadError').classList.add('hidden');
    renderWorkspaceBar();
    renderTasks();
}

async function handleSignup(e) {
    e.preventDefault();
    const form = e.target;
    const btn = formButton(form);
    setError('signupError', '');
    setButtonLoading(btn, true);

    const { ok, data } = await api('/api/auth/signup', {
        method: 'POST',
        body: {
            name: $('signupName').value,
            email: $('signupEmail').value,
            password: $('signupPassword').value,
        },
    });
    setButtonLoading(btn, false);

    if (!ok) {
        setError('signupError', data?.error || 'Signup failed');
        return;
    }

    showLoggedIn(data.user);
    hideModal('signupModal');
    await refreshAll();
    showModal('verifyModal');
    announce('Account created. Check your email for a verification code.');
}

async function handleLogin(e) {
    e.preventDefault();
    const form = e.target;
    const btn = formButton(form);
    setError('loginError', '');
    setButtonLoading(btn, true);

    const { ok, data } = await api('/api/auth/login', {
        method: 'POST',
        body: { email: $('loginEmail').value, password: $('loginPassword').value },
    });
    setButtonLoading(btn, false);

    if (!ok) {
        setError('loginError', data?.error || 'Invalid credentials');
        return;
    }

    showLoggedIn(data.user);
    hideModal('loginModal');
    await refreshAll();
    toast(`Welcome back, ${data.user.name}`, 'success');

    // A pending invite link is consumed after signing in, not before: accepting
    // requires knowing who is accepting.
    await consumePendingInvite();
}

async function logout() {
    closeDropdown();
    await api('/api/auth/logout', { method: 'POST', quiet: true });
    showLoggedOut();
    await loadTasks();
    toast('Signed out', 'success');
}

async function handleForgotPassword(e) {
    e.preventDefault();
    const form = e.target;
    const btn = formButton(form);
    setError('forgotError', '');
    setButtonLoading(btn, true);

    await api('/api/auth/forgot-password', {
        method: 'POST',
        body: { email: $('forgotEmail').value },
        quiet: true,
    });
    setButtonLoading(btn, false);

    // The response is deliberately identical whether or not the address exists,
    // so the UI must not branch on it either.
    $('forgotSuccess').classList.remove('hidden');
    form.reset();
}

// ---- Email verification ----

function handleCodeInput(input, index) {
    const inputs = document.querySelectorAll('.code-input');
    input.value = input.value.replace(/\D/g, '').slice(0, 1);
    input.classList.toggle('filled', input.value.length === 1);
    if (input.value && inputs[index + 1]) inputs[index + 1].focus();
}

function handleCodeKeydown(e, input, index) {
    const inputs = document.querySelectorAll('.code-input');
    if (e.key === 'Backspace' && !input.value && inputs[index - 1]) {
        inputs[index - 1].focus();
        inputs[index - 1].value = '';
        inputs[index - 1].classList.remove('filled');
    }
}

/** Pasting the whole code should fill every box, which is what people do when
 *  the code arrives in an email they can copy from. */
function handleCodePaste(e) {
    const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
    if (!text) return;
    e.preventDefault();
    const inputs = [...document.querySelectorAll('.code-input')];
    inputs.forEach((input, i) => {
        input.value = text[i] || '';
        input.classList.toggle('filled', Boolean(text[i]));
    });
    (inputs[Math.min(text.length, inputs.length - 1)] || inputs[0]).focus();
}

async function handleVerifyEmail(e) {
    e.preventDefault();
    const btn = formButton(e.target);
    const code = [...document.querySelectorAll('.code-input')].map(i => i.value).join('');
    setError('verifyError', '');

    if (code.length !== 6) {
        setError('verifyError', 'Enter all six digits');
        return;
    }

    setButtonLoading(btn, true);
    const { ok, data } = await api('/api/auth/verify', { method: 'POST', body: { code } });
    setButtonLoading(btn, false);

    if (!ok) {
        setError('verifyError', data?.error || 'Verification failed');
        return;
    }

    $('verifySuccess').classList.remove('hidden');
    announce('Email verified');
    setTimeout(async () => {
        hideModal('verifyModal');
        await checkAuth();
        toast('Email verified', 'success');
    }, 1200);
}

let resendCooldown = 0;

async function handleResendCode(e) {
    e.preventDefault();
    if (resendCooldown > 0) return;

    const link = $('resendLink');
    const timer = $('resendTimer');
    setError('verifyError', '');

    const { ok, data } = await api('/api/auth/resend-verification', { method: 'POST' });
    if (!ok) {
        setError('verifyError', data?.error || 'Could not resend the code');
        return;
    }

    resendCooldown = 30;
    link.classList.add('hidden');
    timer.classList.remove('hidden');
    timer.textContent = `Code sent · ${resendCooldown}s`;

    const interval = setInterval(() => {
        resendCooldown -= 1;
        if (resendCooldown > 0) {
            timer.textContent = `Resend in ${resendCooldown}s`;
        } else {
            clearInterval(interval);
            timer.classList.add('hidden');
            link.classList.remove('hidden');
        }
    }, 1000);
}

// ---- Profile ----

async function handleUpdateProfile(e) {
    e.preventDefault();
    const btn = formButton(e.target);
    setError('profileError', '');
    setButtonLoading(btn, true);

    const { ok, data } = await api('/api/profile', {
        method: 'PUT',
        body: { name: $('profileNameInput').value },
    });
    setButtonLoading(btn, false);

    if (!ok) {
        setError('profileError', data?.error || 'Could not save your profile');
        return;
    }
    showLoggedIn(data);
    toast('Profile updated', 'success');
}

async function handleChangePassword(e) {
    e.preventDefault();
    const btn = formButton(e.target);
    setError('passwordError', '');

    const newPassword = $('newPassword').value;
    if (newPassword !== $('confirmPassword').value) {
        setError('passwordError', 'Passwords do not match');
        return;
    }

    setButtonLoading(btn, true);
    const { ok, data } = await api('/api/profile/password', {
        method: 'PUT',
        body: { old_password: $('currentPassword').value, new_password: newPassword },
    });
    setButtonLoading(btn, false);

    if (!ok) {
        setError('passwordError', data?.error || 'Could not change your password');
        return;
    }
    e.target.reset();
    toast('Password changed. Other devices were signed out.', 'success');
}

// ============ ANONYMOUS TASKS (Zig/WASM owns the model) ============
// Signed out, the WebAssembly module compiled from Zig is the source of truth.
// A snapshot is mirrored to localStorage so tasks survive a reload. If the
// module fails to load, plain localStorage is the fallback.

function wasmReady() {
    return wasm !== null && wasmMemory !== null;
}

function wasmStr(s) {
    const bytes = new TextEncoder().encode(s || '');
    const ptr = wasm.allocString(bytes.length);
    if (bytes.length) new Uint8Array(wasmMemory.buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
}

function wasmReadStr(ptr, len) {
    return len ? new TextDecoder().decode(new Uint8Array(wasmMemory.buffer, ptr, len)) : '';
}

const priorityToCode = (p) => (p === 'high' ? 1 : p === 'low' ? 2 : 0);
const priorityFromCode = (c) => (c === 1 ? 'high' : c === 2 ? 'low' : 'normal');

function wasmAddTask(title, dueDate, priority, notes = '', tags = []) {
    const t = wasmStr(title);
    const d = wasmStr(dueDate || '');
    const n = wasmStr(notes || '');
    // Tags cross the boundary as one comma-separated string: the interface is
    // raw pointers and lengths, so a list would mean a call per element.
    const g = wasmStr((tags || []).join(','));
    const id = wasm.addTask(
        t.ptr, t.len, d.ptr, d.len, priorityToCode(priority),
        n.ptr, n.len, g.ptr, g.len,
    );
    wasm.freeString();
    return id;
}

function wasmUpdateTask(id, { title, dueDate, priority, notes, tags }) {
    const t = wasmStr(title);
    const d = wasmStr(dueDate || '');
    const n = wasmStr(notes || '');
    const g = wasmStr((tags || []).join(','));
    const ok = wasm.updateTask(
        Number(id), t.ptr, t.len, d.ptr, d.len, priorityToCode(priority),
        n.ptr, n.len, g.ptr, g.len,
    );
    wasm.freeString();
    return ok;
}

function wasmGetTasks() {
    const out = [];
    const count = wasm.getTaskCount();
    for (let i = 0; i < count; i++) {
        const id = wasm.getTaskId(i);
        if (!id) continue;
        const tags = wasmReadStr(wasm.getTaskTags(id), wasm.getTaskTagsLen(id));
        out.push({
            id,
            title: wasmReadStr(wasm.getTaskTitle(id), wasm.getTaskTitleLen(id)),
            completed: wasm.getTaskCompleted(id),
            due_date: wasmReadStr(wasm.getTaskDue(id), wasm.getTaskDueLen(id)) || null,
            priority: priorityFromCode(wasm.getTaskPriority(id)),
            notes: wasmReadStr(wasm.getTaskNotes(id), wasm.getTaskNotesLen(id)),
            tags: tags ? tags.split(',').filter(Boolean) : [],
            created_at: null,
        });
    }
    return out;
}

function readSnapshot() {
    try {
        const s = localStorage.getItem('localTasks');
        return s ? JSON.parse(s) : [];
    } catch (_) {
        return [];
    }
}

function writeSnapshot(tasks) {
    try {
        localStorage.setItem('localTasks', JSON.stringify(tasks.map(t => ({
            title: t.title, completed: t.completed, due_date: t.due_date,
            priority: t.priority, notes: t.notes, tags: t.tags,
        }))));
    } catch (_) { /* quota or private mode */ }
}

function persistAnon() {
    writeSnapshot(wasmGetTasks());
}

function hydrateAnon() {
    if (!wasmReady()) return;
    suppressRender = true;
    wasm.clearAll();
    for (const t of readSnapshot()) {
        const id = wasmAddTask(t.title, t.due_date, t.priority, t.notes, t.tags);
        if (id && t.completed) wasm.toggleTask(id);
    }
    suppressRender = false;
}

function getAnonTasks() {
    if (wasmReady()) return wasmGetTasks();
    return readSnapshot().map((t, i) => ({
        id: i, notes: '', tags: [], created_at: null, ...t,
    }));
}

function anonAdd(title, dueDate, priority, notes = '', tags = []) {
    suppressRender = true;
    if (wasmReady()) {
        wasmAddTask(title, dueDate, priority, notes, tags);
        persistAnon();
    } else {
        const snap = readSnapshot();
        snap.push({ title, completed: false, due_date: dueDate, priority, notes, tags });
        writeSnapshot(snap);
    }
    suppressRender = false;
}

function anonUpdate(id, patch) {
    suppressRender = true;
    if (wasmReady()) {
        wasmUpdateTask(id, patch);
        persistAnon();
    } else {
        const snap = readSnapshot();
        const item = snap[Number(id)];
        if (item) {
            item.title = patch.title;
            item.due_date = patch.dueDate || null;
            item.priority = patch.priority;
            item.notes = patch.notes;
            item.tags = patch.tags;
            writeSnapshot(snap);
        }
    }
    suppressRender = false;
}

function anonToggle(id) {
    suppressRender = true;
    if (wasmReady()) {
        wasm.toggleTask(Number(id));
        persistAnon();
    } else {
        const snap = readSnapshot();
        const item = snap[Number(id)];
        if (item) { item.completed = !item.completed; writeSnapshot(snap); }
    }
    suppressRender = false;
}

function anonDelete(id) {
    suppressRender = true;
    if (wasmReady()) {
        wasm.deleteTask(Number(id));
        persistAnon();
    } else {
        const snap = readSnapshot();
        snap.splice(Number(id), 1);
        writeSnapshot(snap);
    }
    suppressRender = false;
}

async function initWasm() {
    try {
        const importObject = {
            env: {
                js_log: (ptr, len) => {
                    const bytes = new Uint8Array(wasmMemory.buffer, ptr, len);
                    console.log('[WASM]', new TextDecoder().decode(bytes));
                },
                js_renderTasks: () => { if (!suppressRender) loadTasks(); },
            },
        };
        const response = await fetch('/app.wasm?v=f01f59ea');
        if (!response.ok) throw new Error('WASM fetch failed');
        const bytes = await response.arrayBuffer();
        const result = await WebAssembly.instantiate(bytes, importObject);
        wasm = result.instance.exports;
        wasmMemory = wasm.memory;
        wasm.init();
        hydrateAnon();
    } catch (_) {
        console.log('Running without WASM; using localStorage');
    }
}

// ============ WORKSPACES ============

function currentWorkspace() {
    return state.workspaces.find(w => w.id === state.currentWorkspaceId) || null;
}

/** Roles are ordered: a viewer may read, a member may write, an admin may also
 *  manage people. The server enforces all of this; the UI mirrors it so people
 *  are not offered buttons that will come back 403. */
function canWrite() {
    if (!isLoggedIn()) return true; // anonymous tasks are always writable
    const ws = currentWorkspace();
    if (!ws) return true;
    return ws.role === 'owner' || ws.role === 'admin' || ws.role === 'member';
}

function canAdmin() {
    const ws = currentWorkspace();
    return Boolean(ws) && (ws.role === 'owner' || ws.role === 'admin');
}

async function loadWorkspaces() {
    if (!isLoggedIn()) return;
    const requestUser = state.user;
    const { ok, data } = await api('/api/workspaces', { quiet: true });
    if (state.user !== requestUser) return;
    if (!ok || !Array.isArray(data)) return;

    state.workspaces = data;
    if (!state.workspaces.some(w => w.id === state.currentWorkspaceId)) {
        let saved = null;
        try {
            saved = localStorage.getItem('workspaceId');
        } catch (_) { /* ignore */ }
        const preferred = state.workspaces.find(w => w.id === saved);
        state.currentWorkspaceId = (preferred || state.workspaces[0])?.id || null;
    }
    renderWorkspaceBar();
}

function renderWorkspaceBar() {
    const select = $('workspaceSelect');
    const role = $('workspaceRole');
    select.textContent = '';

    for (const ws of state.workspaces) {
        const option = document.createElement('option');
        option.value = ws.id;
        option.textContent = ws.name;
        if (ws.id === state.currentWorkspaceId) option.selected = true;
        select.appendChild(option);
    }

    const ws = currentWorkspace();
    role.textContent = ws ? ws.role : '';
    role.classList.toggle('hidden', !ws);

    // The composer is pointless for a viewer, who cannot create anything.
    const writable = canWrite();
    $('taskInput').disabled = !writable;
    $('taskInput').placeholder = writable
        ? 'What needs to be done?'
        : 'You have read-only access to this workspace';
    $('taskForm').querySelector('button[type="submit"]').disabled = !writable;
}

function switchWorkspace(id) {
    state.currentWorkspaceId = id;
    try {
        localStorage.setItem('workspaceId', id);
    } catch (_) { /* ignore */ }
    renderWorkspaceBar();
    renderTasks();
}

async function handleCreateWorkspace(e) {
    e.preventDefault();
    const btn = formButton(e.target);
    setError('newWorkspaceError', '');
    setButtonLoading(btn, true);

    const { ok, data } = await api('/api/workspaces', {
        method: 'POST',
        body: { name: $('newWorkspaceName').value },
    });
    setButtonLoading(btn, false);

    if (!ok) {
        setError('newWorkspaceError', data?.error || 'Could not create the workspace');
        return;
    }

    hideModal('newWorkspaceModal');
    await loadWorkspaces();
    switchWorkspace(data.id);
    toast(`Workspace "${data.name}" created`, 'success');
}

// ============ TASKS ============

async function loadTasks() {
    if (!isLoggedIn()) {
        $('taskLoadError').classList.add('hidden');
        state.tasks = getAnonTasks();
        renderTasks();
        return;
    }

    setLoading(true);
    const requestUser = state.user;
    const { ok, data } = await api('/api/tasks', { quiet: true });
    // A response started before logout/account change must never repopulate
    // the new identity's view with the old account's private task data.
    if (state.user !== requestUser) return;
    setLoading(false);
    const loaded = ok && Array.isArray(data);
    $('taskLoadError').classList.toggle('hidden', loaded);
    if (loaded) state.tasks = data;
    renderTasks();
}

function setLoading(loading) {
    state.loading = loading;
    $('taskListSkeleton').classList.toggle('hidden', !loading);
    $('taskList').classList.toggle('hidden', loading);
}

function parseTags(input) {
    return [...new Set(
        input.split(',').map(t => t.trim()).filter(Boolean).map(t => t.slice(0, 32)),
    )].slice(0, 12);
}

function isOverdue(task) {
    if (task.completed || !task.due_date) return false;
    const due = new Date(task.due_date);
    return !Number.isNaN(due.getTime()) && due.getTime() < Date.now();
}

function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    const now = new Date();
    const sameYear = date.getFullYear() === now.getFullYear();
    return date.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: sameYear ? undefined : 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

/** Tasks belonging to the selected workspace. Signed-out tasks have no
 *  workspace, and neither do rows created before workspaces existed, so a null
 *  workspace_id always shows. */
function workspaceTasks() {
    if (!isLoggedIn() || !state.currentWorkspaceId) return state.tasks;
    return state.tasks.filter(t => !t.workspace_id || t.workspace_id === state.currentWorkspaceId);
}

/// Tasks that are not subtasks. The board and the list both show these; a
/// subtask appears under its parent rather than as a row of its own.
function topLevel(tasks) {
    return tasks.filter(t => !t.parent_id);
}

function subtasksOf(id) {
    return state.tasks.filter(t => t.parent_id === id);
}

function subtaskProgress(id) {
    const kids = subtasksOf(id);
    if (!kids.length) return null;
    return { done: kids.filter(k => k.completed).length, total: kids.length };
}

function memberName(userId) {
    if (!userId) return null;
    const m = state.members.find(x => x.user_id === userId);
    if (m) return m.name || m.email;
    if (state.user && state.user.id === userId) return state.user.name;
    return null;
}

function matchesSearch(task, needle) {
    if (!needle) return true;
    const haystack = [
        task.title || '',
        task.notes || '',
        ...(task.tags || []),
    ].join(' ').toLowerCase();
    return haystack.includes(needle);
}

function matchesFilter(task) {
    switch (state.filter) {
        case 'active': return !task.completed;
        case 'completed': return task.completed;
        case 'overdue': return isOverdue(task);
        case 'high': return task.priority === 'high' && !task.completed;
        case 'today': return isDueInWindow(task, 0, 1);
        case 'upcoming': return isDueInWindow(task, 1, 8);
        default: return true;
    }
}

// Calendar boundaries use the visitor's timezone, including 23/25-hour days.
function isDueInWindow(task, fromDay, toDay) {
    if (task.completed || !task.due_date) return false;
    const due = new Date(task.due_date).getTime();
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    start.setDate(start.getDate() + fromDay);
    end.setDate(end.getDate() + toDay);
    return due >= start.getTime() && due < end.getTime();
}

const VIEW_FILTERS = ['all', 'active', 'completed', 'overdue', 'high', 'today', 'upcoming'];
const VIEW_SORTS = ['created_desc', 'created_asc', 'due_asc', 'priority', 'title'];
function viewStorageKey() {
    return `zigTasks:views:${state.user?.id || 'guest'}:${state.currentWorkspaceId || 'local'}`;
}
function validSavedView(view) {
    return view && typeof view.id === 'string' && view.id.length <= 64 &&
        typeof view.name === 'string' && view.name.length > 0 && view.name.length <= 48 &&
        typeof view.search === 'string' && view.search.length <= 500 &&
        (view.tagFilter === null || (typeof view.tagFilter === 'string' && view.tagFilter.length <= 32)) &&
        VIEW_FILTERS.includes(view.filter) && VIEW_SORTS.includes(view.sort) &&
        ['list', 'board'].includes(view.view);
}
function syncSavedViews() {
    const key = viewStorageKey();
    if (state.savedViewContext !== key) {
        state.savedViewContext = key;
        state.savedViews = [];
        state.activeSavedView = '';
        state.filter = 'all'; state.search = ''; state.tagFilter = null;
        state.selection.clear(); state.editingId = null;
        try {
            const stored = JSON.parse(localStorage.getItem(key) || '[]');
            if (Array.isArray(stored)) state.savedViews = stored.filter(validSavedView).slice(0, 12);
            const sort = localStorage.getItem(`${key}:sort`);
            state.sort = VIEW_SORTS.includes(sort) ? sort : 'created_desc';
        } catch (_) { /* unavailable or corrupt storage */ }
    }
    const select = $('savedViews');
    select.replaceChildren(new Option('Saved views', ''));
    for (const view of state.savedViews) select.add(new Option(view.name, view.id));
    select.value = state.activeSavedView;
    $('deleteViewBtn').disabled = !state.activeSavedView;
    $('searchInput').value = state.search;
    $('sortSelect').value = state.sort;
    document.querySelectorAll('#filterChips [data-filter]').forEach(chip => {
        chip.setAttribute('aria-pressed', String(chip.dataset.filter === state.filter));
    });
}
function persistSavedViews() {
    try { localStorage.setItem(viewStorageKey(), JSON.stringify(state.savedViews)); }
    catch (_) { toast('This browser could not save the view. Storage may be full.', 'error'); return false; }
    return true;
}
function bindSavedViews() {
    $('saveViewForm').addEventListener('submit', e => {
        e.preventDefault();
        const name = $('savedViewName').value.trim();
        if (!name) return;
        if (state.savedViews.length >= 12) { toast('You can save up to 12 views per workspace.', 'error'); return; }
        const view = { id: crypto.randomUUID(), name, search: state.search.slice(0, 500),
            filter: state.filter, tagFilter: state.tagFilter, sort: state.sort, view: state.view };
        state.savedViews.push(view);
        if (!persistSavedViews()) { state.savedViews.pop(); return; }
        state.activeSavedView = view.id;
        $('savedViewName').value = '';
        renderTasks(); toast('View saved', 'success');
    });
    $('savedViews').addEventListener('change', e => {
        state.activeSavedView = e.target.value;
        const view = state.savedViews.find(item => item.id === e.target.value);
        if (view) {
            state.search = view.search; state.filter = view.filter; state.tagFilter = view.tagFilter;
            state.sort = view.sort; state.selection.clear();
            setView(view.view);
        } else renderTasks();
    });
    $('deleteViewBtn').addEventListener('click', () => {
        const previous = state.savedViews;
        state.savedViews = previous.filter(view => view.id !== state.activeSavedView);
        if (!persistSavedViews()) { state.savedViews = previous; return; }
        state.activeSavedView = ''; renderTasks(); toast('Saved view deleted');
    });
    $('retryTasksBtn').addEventListener('click', loadTasks);
}

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

function sortTasks(tasks) {
    const sorted = [...tasks];
    switch (state.sort) {
        case 'created_asc':
            return sorted.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
        case 'due_asc':
            // Tasks with no due date sort last rather than first, which is what
            // "due soonest" means to a reader.
            return sorted.sort((a, b) => {
                if (!a.due_date && !b.due_date) return 0;
                if (!a.due_date) return 1;
                if (!b.due_date) return -1;
                return new Date(a.due_date) - new Date(b.due_date);
            });
        case 'priority':
            return sorted.sort((a, b) =>
                (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1));
        case 'title':
            return sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        default:
            return sorted.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    }
}

function allTags(tasks) {
    const counts = new Map();
    for (const task of tasks) {
        for (const tag of task.tags || []) {
            counts.set(tag, (counts.get(tag) || 0) + 1);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ---- Rendering ----

function badge(text, className) {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
}

function iconButton(label, symbol, className, dataset) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = symbol;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    Object.assign(btn.dataset, dataset);
    return btn;
}

// SECURITY: every task field below is written with textContent or setAttribute.
// A title of `<img src=x onerror=...>` is rendered as those literal characters.
function renderTaskItem(task) {
    // Compared as strings. Server ids are strings ("tasks:abc"), but the WASM
    // store hands out numbers, and `dataset.id` is always a string — so a
    // strict comparison never matched for a signed-out task and the edit
    // button silently did nothing.
    if (state.editingId !== null && String(state.editingId) === String(task.id)) {
        return renderTaskEditor(task);
    }

    const li = document.createElement('li');
    li.className = 'task-item';
    if (task.completed) li.classList.add('completed');
    if (task.priority === 'high') li.classList.add('priority-high');
    if (task.priority === 'low') li.classList.add('priority-low');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task-checkbox';
    checkbox.dataset.id = task.id;
    checkbox.dataset.act = 'toggle';
    checkbox.checked = Boolean(task.completed);
    checkbox.disabled = !canWrite();
    checkbox.setAttribute('aria-label', task.completed ? 'Mark as not done' : 'Mark as done');

    // In selection mode the row grows a second box. Two boxes are clearer than
    // one that changes meaning depending on a mode you might have forgotten
    // you were in.
    let selectBox = null;
    if (state.selectMode) {
        selectBox = document.createElement('input');
        selectBox.type = 'checkbox';
        selectBox.className = 'task-select';
        selectBox.dataset.id = task.id;
        selectBox.dataset.act = 'select';
        selectBox.checked = state.selection.has(String(task.id));
        selectBox.setAttribute('aria-label', `Select ${task.title}`);
        if (selectBox.checked) li.classList.add('selected');
    }

    const content = document.createElement('div');
    content.className = 'task-content';

    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;
    content.appendChild(title);

    if (task.notes) {
        const notes = document.createElement('p');
        notes.className = 'task-notes';
        notes.textContent = task.notes;
        content.appendChild(notes);
    }

    const meta = document.createElement('div');
    meta.className = 'task-meta';

    if (task.priority === 'high') meta.appendChild(badge('High', 'task-badge task-badge-high'));
    if (task.priority === 'low') meta.appendChild(badge('Low', 'task-badge task-badge-low'));

    const due = formatDate(task.due_date);
    if (due) {
        const overdue = isOverdue(task);
        meta.appendChild(badge(
            `${overdue ? '⚠️' : '📅'} ${due}`,
            `task-badge ${overdue ? 'task-badge-overdue' : 'task-badge-due'}`,
        ));
    }

    for (const tag of task.tags || []) {
        const el = badge(tag, 'task-tag');
        el.dataset.tag = tag;
        el.dataset.act = 'filter-tag';
        el.title = `Filter by "${tag}"`;
        meta.appendChild(el);
    }

    const assignee = memberName(task.assignee_id);
    if (assignee) meta.appendChild(badge(`👤 ${assignee}`, 'task-assignee'));

    if (task.recurrence && task.recurrence !== 'none') {
        meta.appendChild(badge(`🔁 ${task.recurrence}`, 'task-badge'));
    }

    const progress = subtaskProgress(task.id);
    if (progress) {
        meta.appendChild(badge(`☑ ${progress.done}/${progress.total}`, 'task-badge'));
    }

    if (meta.childElementCount) content.appendChild(meta);

    // Subtasks live under their parent, never as rows of their own.
    const kids = subtasksOf(task.id);
    if (kids.length) {
        const list = document.createElement('ul');
        list.className = 'subtask-list';
        for (const kid of kids) list.appendChild(renderSubtask(kid));
        content.appendChild(list);
    }

    if (state.addingSubtaskFor === String(task.id)) {
        content.appendChild(renderSubtaskComposer(task.id));
    }

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    if (canWrite()) {
        // Subtasks exist only for signed-in tasks: the offline store has no
        // notion of a parent, and pretending otherwise would lose them.
        if (isLoggedIn()) {
            actions.appendChild(iconButton('Add subtask', '＋', 'icon-btn', { id: task.id, act: 'add-subtask' }));
        }
        actions.appendChild(iconButton('Edit task', '✏️', 'icon-btn', { id: task.id, act: 'edit' }));
        actions.appendChild(iconButton('Delete task', '🗑️', 'icon-btn btn-delete', { id: task.id, act: 'delete' }));
    }

    if (selectBox) li.append(selectBox);
    li.append(checkbox, content, actions);
    return li;
}

function renderSubtask(task) {
    const li = document.createElement('li');
    li.className = task.completed ? 'subtask done' : 'subtask';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'task-checkbox';
    box.dataset.id = task.id;
    box.dataset.act = 'toggle';
    box.checked = Boolean(task.completed);
    box.disabled = !canWrite();
    box.setAttribute('aria-label', `Mark "${task.title}" as ${task.completed ? 'not done' : 'done'}`);

    const title = document.createElement('span');
    title.className = 'subtask-title';
    title.textContent = task.title;

    li.append(box, title);
    if (canWrite()) {
        li.appendChild(iconButton('Delete subtask', '×', 'icon-btn btn-delete', { id: task.id, act: 'delete' }));
    }
    return li;
}

function renderSubtaskComposer(parentId) {
    const form = document.createElement('form');
    form.className = 'subtask-add';
    form.dataset.act = 'save-subtask';
    form.dataset.parent = parentId;

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Subtask title';
    input.maxLength = 500;
    input.required = true;
    input.setAttribute('aria-label', 'Subtask title');

    const add = document.createElement('button');
    add.type = 'submit';
    add.className = 'btn btn-primary btn-sm';
    add.textContent = 'Add';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost btn-sm';
    cancel.textContent = 'Cancel';
    cancel.dataset.act = 'cancel-subtask';

    form.append(input, add, cancel);
    setTimeout(() => input.focus(), 0);
    return form;
}

/** Inline editor. Replaces the row in place rather than opening a dialog: the
 *  common edit is a one-word typo fix, and a modal for that is heavier than the
 *  change it makes. */
function renderTaskEditor(task) {
    const li = document.createElement('li');
    li.className = 'task-item';

    const form = document.createElement('form');
    form.className = 'task-edit';
    form.dataset.id = task.id;
    form.dataset.act = 'save-edit';

    const title = document.createElement('input');
    title.type = 'text';
    title.value = task.title;
    title.maxLength = 500;
    title.required = true;
    title.setAttribute('aria-label', 'Task title');
    title.dataset.field = 'title';

    const notes = document.createElement('textarea');
    notes.value = task.notes || '';
    notes.placeholder = 'Notes (optional)';
    notes.maxLength = 5000;
    notes.setAttribute('aria-label', 'Notes');
    notes.dataset.field = 'notes';

    const row = document.createElement('div');
    row.className = 'task-edit-row';

    const priority = document.createElement('select');
    priority.setAttribute('aria-label', 'Priority');
    priority.dataset.field = 'priority';
    for (const [value, label] of [['normal', 'Normal'], ['high', 'High'], ['low', 'Low']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        if ((task.priority || 'normal') === value) option.selected = true;
        priority.appendChild(option);
    }

    const due = document.createElement('input');
    due.type = 'datetime-local';
    due.setAttribute('aria-label', 'Due date');
    due.dataset.field = 'due_date';
    refreshDueDateMin(due);
    if (task.due_date) {
        const d = new Date(task.due_date);
        if (!Number.isNaN(d.getTime())) {
            // datetime-local wants local wall-clock time with no zone, so the
            // UTC value from the API is shifted before being sliced.
            const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
            due.value = local.toISOString().slice(0, 16);
            // An unchanged overdue deadline must not block editing the title.
            if (due.value < due.min) due.min = due.value;
        }
    }
    due.dataset.originalValue = due.value;

    const tags = document.createElement('input');
    tags.type = 'text';
    tags.value = (task.tags || []).join(', ');
    tags.placeholder = 'Tags, comma separated';
    tags.maxLength = 200;
    tags.setAttribute('aria-label', 'Tags');
    tags.dataset.field = 'tags';

    const recurrence = document.createElement('select');
    recurrence.setAttribute('aria-label', 'Repeat');
    recurrence.dataset.field = 'recurrence';
    for (const [value, label] of [
        ['none', 'Does not repeat'], ['daily', 'Repeats daily'],
        ['weekly', 'Repeats weekly'], ['monthly', 'Repeats monthly'],
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        if ((task.recurrence || 'none') === value) option.selected = true;
        recurrence.appendChild(option);
    }

    // Only offered where it can be honoured: assigning needs the member list,
    // which needs admin rights, and the offline store has no members at all.
    let assignee = null;
    if (isLoggedIn() && state.members.length) {
        assignee = document.createElement('select');
        assignee.setAttribute('aria-label', 'Assignee');
        assignee.dataset.field = 'assignee_id';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = 'Unassigned';
        assignee.appendChild(none);
        for (const m of state.members) {
            const option = document.createElement('option');
            option.value = m.user_id;
            option.textContent = m.name || m.email;
            if (task.assignee_id === m.user_id) option.selected = true;
            assignee.appendChild(option);
        }
    }

    row.append(priority, due);
    const row2 = document.createElement('div');
    row2.className = 'task-edit-row';
    row2.appendChild(recurrence);
    if (assignee) row2.appendChild(assignee);

    const actions = document.createElement('div');
    actions.className = 'task-edit-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost btn-sm';
    cancel.textContent = 'Cancel';
    cancel.dataset.act = 'cancel-edit';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'btn btn-primary btn-sm';
    save.textContent = 'Save';
    actions.append(cancel, save);

    form.append(title, notes, row, row2, tags, actions);
    li.appendChild(form);
    return li;
}

function renderTasks() {
    syncSavedViews();
    const list = $('taskList');
    const completedList = $('completedTaskList');
    const completedSection = $('completedSection');
    const empty = $('emptyState');

    list.textContent = '';
    completedList.textContent = '';

    const scoped = topLevel(workspaceTasks());
    const needle = state.search.trim().toLowerCase();

    renderCounts(scoped);
    renderTagChips(scoped);
    renderBulkBar();

    const visible = scoped
        .filter(t => matchesFilter(t))
        .filter(t => matchesSearch(t, needle))
        .filter(t => !state.tagFilter || (t.tags || []).includes(state.tagFilter));

    // The board shows the same filtered set, grouped differently.
    const boardEl = $('board');
    const listEl = $('taskList');
    if (state.view === 'board') {
        boardEl.classList.remove('hidden');
        listEl.classList.add('hidden');
        $('completedSection').classList.add('hidden');
        renderBoard(visible);
        $('emptyState').classList.toggle('visible', visible.length === 0 && !state.loading);
        if (!visible.length) renderEmptyState(scoped.length > 0);
        return;
    }
    boardEl.classList.add('hidden');
    listEl.classList.remove('hidden');

    // "Completed" is a section, not a filter, so it only splits out when the
    // active filter would otherwise mix the two.
    const splitCompleted = state.filter === 'all';
    const active = splitCompleted ? visible.filter(t => !t.completed) : visible;
    const done = splitCompleted ? visible.filter(t => t.completed) : [];

    for (const task of sortTasks(active)) list.appendChild(renderTaskItem(task));

    if (done.length) {
        completedSection.classList.remove('hidden');
        $('completedSectionCount').textContent = String(done.length);
        completedList.classList.toggle('hidden', state.completedCollapsed);
        if (!state.completedCollapsed) {
            for (const task of sortTasks(done)) completedList.appendChild(renderTaskItem(task));
        }
    } else {
        completedSection.classList.add('hidden');
    }

    const nothing = active.length === 0 && done.length === 0;
    empty.classList.toggle('visible', nothing && !state.loading);
    if (nothing) renderEmptyState(scoped.length > 0);
}

/// The board is the same filtered set as the list, grouped by status rather
/// than split into active and completed. Cards can be dragged between columns
/// on a pointer device and moved with buttons everywhere else — a board that
/// only works with a mouse is a board that does not work on a phone.
function renderBoard(visible) {
    const board = $('board');
    board.textContent = '';

    for (const status of STATUSES) {
        const column = document.createElement('section');
        column.className = 'board-column';
        column.dataset.status = status;

        const head = document.createElement('h3');
        head.className = 'board-column-head';
        head.textContent = STATUS_LABEL[status];

        const inColumn = visible.filter(t => taskStatus(t) === status);
        const count = document.createElement('span');
        count.className = 'board-column-count';
        count.textContent = String(inColumn.length);
        head.appendChild(count);

        const cards = document.createElement('ul');
        cards.className = 'board-cards';
        for (const task of sortTasks(inColumn)) cards.appendChild(renderCard(task, status));

        column.append(head, cards);
        board.appendChild(column);
    }
}

/// A task's column. Older rows predate the status field, so completion is the
/// fallback — the two are kept in step on write, and this keeps them in step
/// on read for anything written before that was true.
function taskStatus(task) {
    if (task.status && STATUSES.includes(task.status)) return task.status;
    return task.completed ? 'done' : 'todo';
}

function renderCard(task, status) {
    const li = document.createElement('li');
    li.className = 'board-card';
    li.draggable = canWrite();
    li.dataset.id = task.id;

    const title = document.createElement('div');
    title.className = 'board-card-title';
    title.textContent = task.title;
    li.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'board-card-meta';
    if (task.priority === 'high') meta.appendChild(badge('High', 'task-badge task-badge-high'));
    if (task.priority === 'low') meta.appendChild(badge('Low', 'task-badge task-badge-low'));
    const due = formatDate(task.due_date);
    if (due) {
        meta.appendChild(badge(`${isOverdue(task) ? '⚠️' : '📅'} ${due}`,
            `task-badge ${isOverdue(task) ? 'task-badge-overdue' : 'task-badge-due'}`));
    }
    for (const tag of task.tags || []) meta.appendChild(badge(tag, 'task-tag'));
    const assignee = memberName(task.assignee_id);
    if (assignee) meta.appendChild(badge(`👤 ${assignee}`, 'task-assignee'));
    const progress = subtaskProgress(task.id);
    if (progress) meta.appendChild(badge(`☑ ${progress.done}/${progress.total}`, 'task-badge'));
    if (meta.childElementCount) li.appendChild(meta);

    if (canWrite()) {
        const move = document.createElement('div');
        move.className = 'board-move';
        const index = STATUSES.indexOf(status);
        for (const [label, target] of [['←', STATUSES[index - 1]], ['→', STATUSES[index + 1]]]) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            btn.disabled = !target;
            if (target) {
                btn.dataset.act = 'move-status';
                btn.dataset.id = task.id;
                btn.dataset.status = target;
                btn.setAttribute('aria-label', `Move "${task.title}" to ${STATUS_LABEL[target]}`);
            }
            move.appendChild(btn);
        }
        li.appendChild(move);
    }

    return li;
}

async function moveTask(id, status) {
    const task = state.tasks.find(t => String(t.id) === String(id));
    if (!task) return;

    const previous = { status: taskStatus(task), completed: task.completed };
    task.status = status;
    task.completed = status === 'done';
    renderTasks();

    if (!isLoggedIn()) {
        // The offline store knows about completion but not columns, so a move
        // is recorded as the completion it implies.
        anonToggle(id);
        await loadTasks();
        return;
    }

    const { ok, data } = await api(`/api/tasks/${encodeURIComponent(id)}`, {
        method: 'PUT', body: { status },
    });
    if (!ok) {
        Object.assign(task, previous);
        renderTasks();
        toast(data?.error || 'Could not move the task', 'error');
        return;
    }
    Object.assign(task, data);
    renderTasks();
}

function renderEmptyState(hasTasksButFiltered) {
    if (hasTasksButFiltered) {
        $('emptyTitle').textContent = 'Nothing matches';
        $('emptyText').textContent = 'Try a different search or filter.';
    } else {
        $('emptyTitle').textContent = 'No tasks yet';
        $('emptyText').textContent = canWrite()
            ? 'Add one above to get started.'
            : 'Nobody has added anything to this workspace.';
    }
}

/**
 * Width of the completion bar.
 *
 * This cannot be `el.style.width = x`. The CSP sets `style-src 'self'` with no
 * 'unsafe-inline', and that refuses inline styles whether they come from a
 * markup attribute or from CSSOM — the attribute lands in the DOM and is then
 * ignored, so the bar silently stayed at zero. Verified in a real browser
 * before changing it.
 *
 * A constructed stylesheet is not inline content, so it is not subject to
 * style-src. Where the browser is too old for adoptedStyleSheets the bar stays
 * flat and the value is still announced through aria-valuenow.
 */
let progressSheet = null;

function setProgress(percent) {
    if (progressSheet === null) {
        if (typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in document)) {
            progressSheet = false;
            return;
        }
        try {
            progressSheet = new CSSStyleSheet();
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, progressSheet];
        } catch (_) {
            progressSheet = false;
            return;
        }
    }
    if (progressSheet === false) return;
    const clamped = Math.max(0, Math.min(100, percent));
    progressSheet.replaceSync(`#progressBar{width:${clamped}%}`);
}

function renderCounts(tasks) {
    const done = tasks.filter(t => t.completed).length;
    const total = tasks.length;

    $('countAll').textContent = String(total);
    $('countActive').textContent = String(total - done);
    $('countDone').textContent = String(done);
    $('countOverdue').textContent = String(tasks.filter(isOverdue).length);
    $('countHigh').textContent = String(tasks.filter(t => t.priority === 'high' && !t.completed).length);
    $('countToday').textContent = String(tasks.filter(t => isDueInWindow(t, 0, 1)).length);
    $('countUpcoming').textContent = String(tasks.filter(t => isDueInWindow(t, 1, 8)).length);

    $('totalCount').textContent = String(total);
    $('completedCount').textContent = String(done);

    const percent = total ? Math.round((done / total) * 100) : 0;
    setProgress(percent);
    $('progress').setAttribute('aria-valuenow', String(percent));
}

function renderTagChips(tasks) {
    const container = $('tagChips');
    container.textContent = '';

    const tags = allTags(tasks);
    if (!tags.length) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');

    for (const [tag, count] of tags) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.dataset.tag = tag;
        chip.dataset.act = 'toggle-tag';
        chip.setAttribute('aria-pressed', String(state.tagFilter === tag));
        chip.textContent = `#${tag} `;
        const countEl = document.createElement('span');
        countEl.className = 'chip-count';
        countEl.textContent = String(count);
        chip.appendChild(countEl);
        container.appendChild(chip);
    }
}

// ---- Task mutations ----

async function addTask(title, dueDate, priority, tags, notes = '') {
    dueDate = toApiDueDate(dueDate);
    if (!isLoggedIn()) {
        // Tags used to be dropped here: the composer collected them and the
        // signed-out path simply did not carry them, so they vanished without
        // a word. The WASM store holds them now.
        anonAdd(title, dueDate, priority, notes, tags);
        await loadTasks();
        return;
    }

    const body = { title, priority };
    if (notes) body.notes = notes;
    if (dueDate) body.due_date = dueDate;
    if (tags.length) body.tags = tags;
    if (state.currentWorkspaceId) body.workspace_id = state.currentWorkspaceId;

    const { ok, data } = await api('/api/tasks', { method: 'POST', body });
    if (!ok) {
        toast(data?.error || 'Could not add the task', 'error');
        return;
    }

    state.tasks.push(data);
    renderTasks();
    announce(`Added ${title}`);
}

async function toggleTask(id) {
    if (!isLoggedIn()) {
        anonToggle(id);
        await loadTasks();
        return;
    }

    // Optimistic: the checkbox has already visually flipped, so reflect it in
    // the model immediately and roll back only if the server disagrees.
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;
    const previous = task.completed;
    task.completed = !previous;
    renderTasks();

    const { ok, data } = await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PUT' });
    if (!ok) {
        task.completed = previous;
        renderTasks();
        toast(data?.error || 'Could not update the task', 'error');
        return;
    }
    Object.assign(task, data);
    renderTasks();
    if (task.completed && task.recurrence !== 'none') await loadTasks();
}

async function deleteTask(id) {
    if (!isLoggedIn()) {
        anonDelete(id);
        await loadTasks();
        return;
    }

    const index = state.tasks.findIndex(t => t.id === id);
    if (index === -1) return;
    const [removed] = state.tasks.splice(index, 1);
    renderTasks();

    const { ok, data } = await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!ok) {
        state.tasks.splice(index, 0, removed);
        renderTasks();
        toast(data?.error || 'Could not delete the task', 'error');
        return;
    }

    // Deletion is the one destructive action here and there is no server-side
    // undo, so the offer is to recreate an identical task rather than to
    // restore the original row.
    toast(`Deleted "${removed.title}"`, '', {
        label: 'Undo',
        onClick: () => addTask(
            removed.title,
            removed.due_date ? removed.due_date.slice(0, 16) : null,
            removed.priority || 'normal',
            removed.tags || [],
        ),
    });
}

async function saveTaskEdit(form) {
    const id = form.dataset.id;
    const field = (name) => form.querySelector(`[data-field="${name}"]`);

    const title = field('title').value.trim();
    if (!title) {
        toast('A task needs a title', 'error');
        return;
    }

    // Signed out there is no API to call. Editing used to send the change to
    // the server anyway, get a 401, and report the session as expired — for a
    // user who had never signed in.
    if (!isLoggedIn()) {
        // Recurrence and assignment need a server; the offline store keeps the
        // fields it can actually honour rather than pretending to save them.
        anonUpdate(id, {
            title,
            dueDate: field('due_date').value || null,
            priority: field('priority').value,
            notes: field('notes').value,
            tags: parseTags(field('tags').value),
        });
        state.editingId = null;
        await loadTasks();
        toast('Task updated', 'success');
        return;
    }

    const body = {
        title,
        notes: field('notes').value,
        priority: field('priority').value,
        tags: parseTags(field('tags').value),
        // The empty string is the documented way to clear a due date; null
        // would mean "leave it alone".
    };
    const dueField = field('due_date');
    if (dueField.value !== dueField.dataset.originalValue) body.due_date = toApiDueDate(dueField.value) || '';
    const recurrenceField = field('recurrence');
    if (recurrenceField) body.recurrence = recurrenceField.value;
    const assigneeField = field('assignee_id');
    if (assigneeField) body.assignee_id = assigneeField.value;

    const { ok, data } = await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PUT', body });
    if (!ok) {
        toast(data?.error || 'Could not save the task', 'error');
        return;
    }

    const task = state.tasks.find(t => t.id === id);
    if (task) Object.assign(task, data);
    state.editingId = null;
    renderTasks();
    toast('Task updated', 'success');
}

// ============ SELECTION AND BULK ACTIONS ============

function renderBulkBar() {
    const bar = $('bulkBar');
    const count = state.selection.size;
    bar.classList.toggle('hidden', !state.selectMode || count === 0);
    $('bulkCount').textContent = String(count);
}

function setSelectMode(on) {
    state.selectMode = on;
    if (!on) state.selection.clear();
    $('selectModeBtn').setAttribute('aria-pressed', String(on));
    renderTasks();
}

function toggleSelected(id) {
    const key = String(id);
    if (state.selection.has(key)) state.selection.delete(key);
    else state.selection.add(key);
    renderTasks();
}

function selectAllVisible() {
    if (!state.selectMode) setSelectMode(true);
    for (const el of document.querySelectorAll('[data-act="select"]')) {
        state.selection.add(String(el.dataset.id));
    }
    renderTasks();
}

/**
 * Apply an action to every selected task.
 *
 * Sequential rather than parallel. Each write is a round trip that ends in an
 * Argon2-free but still database-backed handler, and firing twenty at once
 * only moves the queue from the server to the browser while making a partial
 * failure much harder to describe.
 */
async function bulkApply(action) {
    const ids = [...state.selection];
    if (!ids.length) return;

    if (action === 'delete' && !window.confirm(`Delete ${ids.length} task${ids.length === 1 ? '' : 's'}?`)) {
        return;
    }

    let done = 0;
    let failed = 0;
    for (const id of ids) {
        const ok = await applyOne(action, id);
        if (ok) done += 1;
        else failed += 1;
    }

    state.selection.clear();
    await loadTasks();

    if (failed === 0) toast(`${done} task${done === 1 ? '' : 's'} updated`, 'success');
    else toast(`${done} updated, ${failed} failed`, 'error');
}

async function applyOne(action, id) {
    if (!isLoggedIn()) {
        if (action === 'delete') anonDelete(id);
        else {
            const task = state.tasks.find(t => String(t.id) === String(id));
            const wantDone = action === 'complete';
            if (task && Boolean(task.completed) !== wantDone) anonToggle(id);
        }
        return true;
    }

    if (action === 'delete') {
        const { ok } = await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE', quiet: true });
        return ok;
    }
    const { ok } = await api(`/api/tasks/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: { status: action === 'complete' ? 'done' : 'todo' },
        quiet: true,
    });
    return ok;
}

// ============ SUBTASKS ============

async function addSubtask(parentId, title) {
    const body = { title, parent_id: parentId };
    const parent = state.tasks.find(t => String(t.id) === String(parentId));
    if (parent && parent.workspace_id) body.workspace_id = parent.workspace_id;

    const { ok, data } = await api('/api/tasks', { method: 'POST', body });
    if (!ok) {
        toast(data?.error || 'Could not add the subtask', 'error');
        return;
    }
    state.tasks.push(data);
    state.addingSubtaskFor = null;
    renderTasks();
}

// ============ CSV EXPORT ============

/// Quote a field for CSV. Excel and everything else agree on doubling the
/// quote character; a field is quoted whenever it holds a delimiter, a quote
/// or a newline.
function csvField(value) {
    const text = value === null || value === undefined ? '' : String(value);
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function tasksAsCsv() {
    const columns = ['id', 'title', 'notes', 'status', 'completed', 'priority',
        'due_date', 'tags', 'recurrence', 'parent_id', 'created_at'];
    const rows = [columns.join(',')];

    for (const task of workspaceTasks()) {
        rows.push(columns.map(c => {
            if (c === 'tags') return csvField((task.tags || []).join(' '));
            return csvField(task[c]);
        }).join(','));
    }
    return rows.join('\r\n');
}

function downloadCsv() {
    const blob = new Blob([tasksAsCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zig-tasks.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download in some browsers; a tick is
    // enough for the navigation to have started.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('CSV downloaded', 'success');
}

// ============ WORKSPACE MEMBERS & INVITES ============

const ROLE_LABEL = {
    owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer',
};

async function openWorkspacePanel() {
    closeDropdown();
    const ws = currentWorkspace();
    if (!ws) {
        toast('No workspace selected', 'error');
        return;
    }

    $('workspaceTitle').textContent = ws.name;
    $('workspaceSubtitle').textContent = canAdmin()
        ? 'Members and invitations'
        : 'You need admin access to manage this workspace';
    showModal('workspaceModal');

    if (!canAdmin()) {
        $('memberList').textContent = '';
        $('memberEmpty').textContent = 'Only admins can see the member list.';
        $('memberEmpty').classList.remove('hidden');
        $('inviteForm').classList.add('hidden');
        return;
    }
    $('inviteForm').classList.remove('hidden');
    await Promise.all([loadMembers(), loadInvites()]);
}

async function loadMembers() {
    const ws = currentWorkspace();
    if (!ws) return;

    const { ok, data } = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/members`, { quiet: true });
    const list = $('memberList');
    const empty = $('memberEmpty');
    list.textContent = '';

    if (!ok || !Array.isArray(data) || !data.length) {
        empty.textContent = 'No members to show.';
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    for (const member of data) {
        list.appendChild(renderMember(member, ws));
    }
}

function renderMember(member, workspace) {
    const li = document.createElement('li');
    li.className = 'panel-item';

    const main = document.createElement('div');
    main.className = 'panel-item-main';
    const name = document.createElement('div');
    name.className = 'panel-item-title';
    name.textContent = member.name || member.email;
    const email = document.createElement('div');
    email.className = 'panel-item-sub';
    email.textContent = member.email;
    main.append(name, email);

    const actions = document.createElement('div');
    actions.className = 'panel-item-actions';

    const isSelf = state.user && member.user_id === state.user.id;

    // The owner's role is fixed and the owner cannot be removed — the server
    // refuses both, so the UI shows a static label instead of dead controls.
    if (member.role === 'owner') {
        actions.appendChild(badge(ROLE_LABEL.owner, 'badge badge-muted'));
    } else {
        const select = document.createElement('select');
        select.setAttribute('aria-label', `Role for ${member.email}`);
        select.dataset.userId = member.user_id;
        select.dataset.act = 'change-role';
        for (const role of ['admin', 'member', 'viewer']) {
            const option = document.createElement('option');
            option.value = role;
            option.textContent = ROLE_LABEL[role];
            if (member.role === role) option.selected = true;
            select.appendChild(option);
        }
        actions.appendChild(select);

        if (!isSelf) {
            actions.appendChild(iconButton(
                `Remove ${member.email}`, '✕', 'icon-btn btn-delete',
                { userId: member.user_id, act: 'remove-member' },
            ));
        }
    }

    li.append(main, actions);
    void workspace;
    return li;
}

async function loadInvites() {
    const ws = currentWorkspace();
    if (!ws) return;

    const { ok, data } = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/invites`, { quiet: true });
    const list = $('inviteList');
    const empty = $('inviteEmpty');
    list.textContent = '';

    if (!ok || !Array.isArray(data) || !data.length) {
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    for (const invite of data) {
        const li = document.createElement('li');
        li.className = 'panel-item';

        const main = document.createElement('div');
        main.className = 'panel-item-main';
        const email = document.createElement('div');
        email.className = 'panel-item-title';
        email.textContent = invite.email;
        const meta = document.createElement('div');
        meta.className = 'panel-item-sub';
        const expires = new Date(invite.expires_at * 1000);
        meta.textContent = `${ROLE_LABEL[invite.role] || invite.role} · expires ${expires.toLocaleDateString()}`;
        main.append(email, meta);

        const actions = document.createElement('div');
        actions.className = 'panel-item-actions';
        actions.appendChild(iconButton(
            `Revoke invitation for ${invite.email}`, '✕', 'icon-btn btn-delete',
            { inviteId: invite.id, act: 'revoke-invite' },
        ));

        li.append(main, actions);
        list.appendChild(li);
    }
}

async function handleInvite(e) {
    e.preventDefault();
    const ws = currentWorkspace();
    if (!ws) return;

    const btn = formButton(e.target);
    setError('inviteError', '');
    setButtonLoading(btn, true);

    const { ok, data } = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/invites`, {
        method: 'POST',
        body: { email: $('inviteEmail').value, role: $('inviteRole').value },
    });
    setButtonLoading(btn, false);

    if (!ok) {
        setError('inviteError', data?.error || 'Could not send the invitation');
        return;
    }

    e.target.reset();
    await loadInvites();
    toast(`Invitation sent to ${data.email}`, 'success');
}

async function changeMemberRole(userId, role) {
    const ws = currentWorkspace();
    if (!ws) return;
    const { ok, data } = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/members`, {
        method: 'PUT',
        body: { user_id: userId, role },
    });
    if (!ok) {
        toast(data?.error || 'Could not change the role', 'error');
        await loadMembers();
        return;
    }
    toast('Role updated', 'success');
    await Promise.all([loadMembers(), loadWorkspaces()]);
}

async function removeMember(userId) {
    const ws = currentWorkspace();
    if (!ws) return;
    if (!window.confirm('Remove this member from the workspace?')) return;

    const { ok, data } = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/members`, {
        method: 'DELETE',
        body: { user_id: userId },
    });
    if (!ok) {
        toast(data?.error || 'Could not remove the member', 'error');
        return;
    }
    toast('Member removed', 'success');
    await loadMembers();
}

async function revokeInvite(inviteId) {
    const ws = currentWorkspace();
    if (!ws) return;
    const { ok, data } = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/invites`, {
        method: 'DELETE',
        body: { invite_id: inviteId },
    });
    if (!ok) {
        toast(data?.error || 'Could not revoke the invitation', 'error');
        return;
    }
    toast('Invitation revoked', 'success');
    await loadInvites();
}

// ---- Accepting an invitation ----
//
// The invitation email links to /?invite_token=… . Nothing read that parameter
// before, so every invitation the backend could send was unusable: the link
// opened the app and the token was silently discarded.

function pendingInviteToken() {
    const fromUrl = new URLSearchParams(window.location.search).get('invite_token');
    if (fromUrl) return fromUrl;
    try {
        return sessionStorage.getItem('inviteToken');
    } catch (_) {
        return null;
    }
}

function stashInviteToken(token) {
    try {
        sessionStorage.setItem('inviteToken', token);
    } catch (_) { /* private mode: the URL still carries it */ }
}

function clearInviteToken() {
    try {
        sessionStorage.removeItem('inviteToken');
    } catch (_) { /* ignore */ }
    const url = new URL(window.location.href);
    if (url.searchParams.has('invite_token')) {
        url.searchParams.delete('invite_token');
        window.history.replaceState({}, '', url.pathname + url.search);
    }
}

async function consumePendingInvite() {
    const token = pendingInviteToken();
    if (!token) return;

    // Accepting needs an identity. Hold the token across the login the user is
    // about to do, rather than losing it and leaving them on a page that says
    // nothing about the invitation they clicked.
    if (!isLoggedIn()) {
        stashInviteToken(token);
        toast('Log in or sign up to accept your workspace invitation');
        showModal('loginModal');
        return;
    }

    const { ok, data } = await api('/api/workspaces/invites/accept', {
        method: 'POST',
        body: { token },
        quiet: true,
    });

    clearInviteToken();

    if (!ok) {
        toast(data?.error || 'That invitation is no longer valid', 'error');
        return;
    }

    await loadWorkspaces();
    await loadTasks();
    toast('Invitation accepted — welcome to the workspace', 'success');
}

// ============ ACTIVITY ============

const ACTION_LABEL = {
    signup: 'Account created',
    login: 'Signed in',
    logout: 'Signed out',
    verify_email: 'Email verified',
    resend_verification: 'Verification code resent',
    change_password: 'Password changed',
    update_profile: 'Profile updated',
    create_task: 'Task created',
    update_task: 'Task edited',
    toggle_task: 'Task toggled',
    delete_task: 'Task deleted',
    create_workspace: 'Workspace created',
    invite_workspace_member: 'Invitation sent',
    accept_workspace_invite: 'Invitation accepted',
    revoke_workspace_invite: 'Invitation revoked',
    change_member_role: 'Member role changed',
    remove_workspace_member: 'Member removed',
    revoke_session: 'Session revoked',
    revoke_sessions: 'Other sessions revoked',
};

async function openActivityPanel() {
    closeDropdown();
    showModal('activityModal');

    const { ok, data } = await api('/api/activity', { quiet: true });
    const list = $('activityList');
    const empty = $('activityEmpty');
    list.textContent = '';

    if (!ok || !Array.isArray(data) || !data.length) {
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    for (const event of data) {
        const li = document.createElement('li');
        li.className = 'panel-item';

        const main = document.createElement('div');
        main.className = 'panel-item-main';
        const title = document.createElement('div');
        title.className = 'panel-item-title';
        // Unknown actions fall back to the raw name rather than being dropped,
        // so a newly added event type is still visible before it gets a label.
        title.textContent = ACTION_LABEL[event.action] || event.action;
        const when = document.createElement('div');
        when.className = 'panel-item-sub';
        when.textContent = formatDate(event.created_at);
        main.append(title, when);

        li.appendChild(main);
        list.appendChild(li);
    }
}

// ============ SECURITY & DATA ============

async function openAccountPanel() {
    closeDropdown();
    setError('deleteAccountError', '');
    showModal('accountModal');
    await loadSessions();
}

async function loadSessions() {
    const { ok, data } = await api('/api/sessions', { quiet: true });
    const list = $('sessionList');
    const empty = $('sessionEmpty');
    list.textContent = '';

    if (!ok || !Array.isArray(data) || !data.length) {
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    for (const session of data) {
        const li = document.createElement('li');
        li.className = 'panel-item';

        const main = document.createElement('div');
        main.className = 'panel-item-main';
        const title = document.createElement('div');
        title.className = 'panel-item-title';
        title.textContent = session.current ? 'This device' : 'Another device';
        const sub = document.createElement('div');
        sub.className = 'panel-item-sub';
        sub.textContent = `Signed in ${formatDate(session.created_at)} · expires ${formatDate(session.expires_at)}`;
        main.append(title, sub);

        const actions = document.createElement('div');
        actions.className = 'panel-item-actions';
        if (session.current) {
            actions.appendChild(badge('Current', 'badge badge-success'));
        } else {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-ghost btn-sm';
            btn.textContent = 'Revoke';
            btn.dataset.sessionId = session.id;
            btn.dataset.act = 'revoke-session';
            actions.appendChild(btn);
        }

        li.append(main, actions);
        list.appendChild(li);
    }
}

async function revokeSession(sessionId) {
    const { ok, data } = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (!ok) {
        toast(data?.error || 'Could not revoke that session', 'error');
        return;
    }
    toast('Session revoked', 'success');
    await loadSessions();
}

async function revokeOtherSessions() {
    if (!window.confirm('Sign out of every other device?')) return;
    const { ok, data } = await api('/api/sessions', { method: 'DELETE' });
    if (!ok) {
        toast(data?.error || 'Could not revoke the other sessions', 'error');
        return;
    }
    toast('Signed out everywhere else', 'success');
    await loadSessions();
}

async function handleDeleteAccount(e) {
    e.preventDefault();
    setError('deleteAccountError', '');

    // Two confirmations for an action with no undo: the typed password proves
    // it is the account holder, and this proves it was not a misclick.
    if (!window.confirm('This permanently deletes your account, your tasks and any workspace you own. Continue?')) {
        return;
    }

    const btn = formButton(e.target);
    setButtonLoading(btn, true);
    const { ok, data } = await api('/api/account', {
        method: 'DELETE',
        body: { password: $('deletePassword').value },
    });
    setButtonLoading(btn, false);

    if (!ok) {
        setError('deleteAccountError', data?.error || 'Could not delete the account');
        return;
    }

    hideModal('accountModal');
    showLoggedOut();
    state.tasks = [];
    renderTasks();
    toast('Your account has been deleted', 'success');
}

// ============ MODALS, DROPDOWN, TABS ============

function getOpenModal() {
    return [...document.querySelectorAll('.modal')].find(m => !m.hidden) || null;
}

function showModal(id) {
    const modal = $(id);
    if (!modal) return;
    lastFocused = document.activeElement;
    modal.hidden = false;
    // Scrolling the page behind an open sheet is disorienting on a phone,
    // where the sheet covers most of the viewport.
    document.body.classList.add('modal-open');

    const focusables = [...modal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
    (focusables[0] || modal.querySelector('.modal-content'))?.focus();
}

function hideModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove('modal-open');

    modal.querySelectorAll('form').forEach(form => form.reset());
    modal.querySelectorAll('.form-error').forEach(el => { el.textContent = ''; });
    modal.querySelectorAll('.form-success').forEach(el => el.classList.add('hidden'));
    modal.querySelectorAll('.code-input.filled').forEach(el => el.classList.remove('filled'));

    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
}

function switchModal(fromId, toId) {
    hideModal(fromId);
    showModal(toId);
}

function trapFocus(e, modal) {
    const focusables = [...modal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

function dropdownOpen() {
    const menu = $('dropdownMenu');
    return menu && !menu.hidden;
}

function setDropdown(open) {
    const btn = $('userBtn');
    const menu = $('dropdownMenu');
    if (!btn || !menu) return;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
}

function closeDropdown() {
    setDropdown(false);
}

/** Tabs are scoped so the profile dialog and the workspace dialog can both use
 *  the pattern without one clearing the other's active state. */
function switchTab(scope, tabName, clickedBtn) {
    document.querySelectorAll(`.tab-btn[data-scope="${scope}"]`).forEach(btn => {
        const active = btn === clickedBtn;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', String(active));
    });

    const prefix = scope === 'profile' ? 'profileTab' : 'workspaceTab';
    const suffix = tabName.charAt(0).toUpperCase() + tabName.slice(1);
    document.querySelectorAll(`[id^="${prefix}"]`).forEach(panel => {
        panel.classList.toggle('active', panel.id === prefix + suffix);
    });
}

// ============ EVENT WIRING ============

/** One delegated listener for both task lists. Each interactive element
 *  carries data-act, so adding a row action needs no new listener. */
function bindTaskList(listEl) {
    listEl.addEventListener('click', (e) => {
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const { act, id, tag } = el.dataset;

        if (act === 'toggle') toggleTask(id);
        else if (act === 'delete') deleteTask(id);
        else if (act === 'edit') { state.editingId = id; renderTasks(); }
        else if (act === 'cancel-edit') { state.editingId = null; renderTasks(); }
        else if (act === 'filter-tag') { state.tagFilter = tag; renderTasks(); }
        else if (act === 'select') toggleSelected(id);
        else if (act === 'add-subtask') { state.addingSubtaskFor = String(id); renderTasks(); }
        else if (act === 'cancel-subtask') { state.addingSubtaskFor = null; renderTasks(); }
    });

    listEl.addEventListener('submit', (e) => {
        const edit = e.target.closest('[data-act="save-edit"]');
        if (edit) {
            e.preventDefault();
            saveTaskEdit(edit);
            return;
        }
        const sub = e.target.closest('[data-act="save-subtask"]');
        if (sub) {
            e.preventDefault();
            const title = sub.querySelector('input').value.trim();
            if (title) addSubtask(sub.dataset.parent, title);
        }
    });

    // Escape leaves the inline editor without saving, which is what Escape
    // means everywhere else in this app.
    listEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !state.editingId) return;
        e.stopPropagation();
        state.editingId = null;
        renderTasks();
    });
}

function bindPanelLists() {
    $('memberList').addEventListener('click', (e) => {
        const el = e.target.closest('[data-act="remove-member"]');
        if (el) removeMember(el.dataset.userId);
    });
    $('memberList').addEventListener('change', (e) => {
        const el = e.target.closest('[data-act="change-role"]');
        if (el) changeMemberRole(el.dataset.userId, el.value);
    });
    $('inviteList').addEventListener('click', (e) => {
        const el = e.target.closest('[data-act="revoke-invite"]');
        if (el) revokeInvite(el.dataset.inviteId);
    });
    $('sessionList').addEventListener('click', (e) => {
        const el = e.target.closest('[data-act="revoke-session"]');
        if (el) revokeSession(el.dataset.sessionId);
    });
}

function bindBoard() {
    const board = $('board');

    board.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act="move-status"]');
        if (btn) moveTask(btn.dataset.id, btn.dataset.status);
    });

    // Dragging is an enhancement, not the only way across: every card also
    // carries arrow buttons, which are what a touch screen and a keyboard use.
    board.addEventListener('dragstart', (e) => {
        const card = e.target.closest('.board-card');
        if (!card) return;
        e.dataTransfer.setData('text/plain', card.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
    });
    board.addEventListener('dragend', (e) => {
        e.target.closest('.board-card')?.classList.remove('dragging');
    });
    board.addEventListener('dragover', (e) => {
        const column = e.target.closest('.board-column');
        if (!column) return;
        e.preventDefault();
        column.classList.add('drop-target');
    });
    board.addEventListener('dragleave', (e) => {
        e.target.closest('.board-column')?.classList.remove('drop-target');
    });
    board.addEventListener('drop', (e) => {
        const column = e.target.closest('.board-column');
        if (!column) return;
        e.preventDefault();
        column.classList.remove('drop-target');
        const id = e.dataTransfer.getData('text/plain');
        if (id) moveTask(id, column.dataset.status);
    });
}

function setView(view) {
    state.view = view;
    try {
        localStorage.setItem('view', view);
    } catch (_) { /* ignore */ }
    document.querySelectorAll('[data-view]').forEach(b => {
        b.setAttribute('aria-pressed', String(b.dataset.view === view));
    });
    renderTasks();
}

function bindViewSwitch() {
    document.querySelector('.view-switch').addEventListener('click', (e) => {
        const viewBtn = e.target.closest('[data-view]');
        if (viewBtn) { setView(viewBtn.dataset.view); return; }
        if (e.target.closest('#selectModeBtn')) { setSelectMode(!state.selectMode); return; }
        if (e.target.closest('#shortcutsBtn')) showModal('shortcutsModal');
    });

    $('bulkBar').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-bulk]');
        if (!btn) return;
        const action = btn.dataset.bulk;
        if (action === 'clear') { state.selection.clear(); renderTasks(); return; }
        bulkApply(action);
    });

    $('exportCsvBtn').addEventListener('click', downloadCsv);
}

function bindToolbar() {
    // Search filters what is already loaded, so it can run on every keystroke
    // without a request. A debounce would only add latency.
    $('searchInput').addEventListener('input', (e) => {
        state.search = e.target.value;
        renderTasks();
    });

    $('sortSelect').addEventListener('change', (e) => {
        state.sort = e.target.value;
        try { localStorage.setItem(`${viewStorageKey()}:sort`, state.sort); } catch (_) { /* ignore */ }
        renderTasks();
    });

    $('filterChips').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-filter]');
        if (!chip) return;
        state.filter = chip.dataset.filter;
        document.querySelectorAll('#filterChips .chip').forEach(c => {
            c.setAttribute('aria-pressed', String(c === chip));
        });
        renderTasks();
    });

    $('tagChips').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-act="toggle-tag"]');
        if (!chip) return;
        // Clicking the active tag clears the filter, so the chip is a toggle
        // rather than a one-way trip that needs a separate "clear" control.
        state.tagFilter = state.tagFilter === chip.dataset.tag ? null : chip.dataset.tag;
        renderTasks();
    });

    $('completedToggle').addEventListener('click', () => {
        state.completedCollapsed = !state.completedCollapsed;
        $('completedToggle').setAttribute('aria-expanded', String(!state.completedCollapsed));
        $('completedChevron').textContent = state.completedCollapsed ? '▸' : '▾';
        renderTasks();
    });
}

/** The database asserts due_date >= created_at, so a past time is refused.
 *  Setting `min` means the picker will not offer one in the first place. */
function refreshDueDateMin(input) {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    input.min = local.toISOString().slice(0, 16);
}

function toApiDueDate(value) {
    if (!value) return null;
    return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function bindComposer() {
    const form = $('taskForm');
    const input = $('taskInput');
    const details = $('composerDetails');
    const toggle = $('composerToggle');
    refreshDueDateMin($('taskDueDate'));

    toggle.addEventListener('click', () => {
        const open = details.hidden;
        details.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) refreshDueDateMin($('taskDueDate'));
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = input.value.trim();
        if (!title) return;

        const priority = $('taskPriority').value;
        const dueDate = $('taskDueDate').value || null;
        const tags = parseTags($('taskTags').value);

        input.value = '';
        $('taskDueDate').value = '';
        $('taskTags').value = '';
        $('taskPriority').value = 'normal';
        input.focus();

        await addTask(title, dueDate, priority, tags);
    });
}

function bindActions() {
    document.body.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        const action = el.dataset.action;
        const fromDropdown = Boolean(el.closest('#dropdownMenu'));

        switch (action) {
            case 'show-modal': showModal(el.dataset.target); break;
            case 'hide-modal': hideModal(el.dataset.target); break;
            case 'switch-modal': e.preventDefault(); switchModal(el.dataset.from, el.dataset.to); break;
            case 'switch-tab': switchTab(el.dataset.scope, el.dataset.tab, el); break;
            case 'logout': logout(); break;
            case 'verify-now': e.preventDefault(); hideModal('profileModal'); showModal('verifyModal'); break;
            case 'resend-code': handleResendCode(e); break;
            case 'open-workspace': openWorkspacePanel(); break;
            case 'open-activity': openActivityPanel(); break;
            case 'open-account': openAccountPanel(); break;
            case 'new-workspace': closeDropdown(); showModal('newWorkspaceModal'); break;
            default: break;
        }
        if (fromDropdown && action !== 'logout') closeDropdown();
    });

    $('themeToggle').addEventListener('click', toggleTheme);

    $('userBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        setDropdown(!dropdownOpen());
    });
    document.addEventListener('click', (e) => {
        if (dropdownOpen() && !e.target.closest('.user-dropdown')) closeDropdown();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (dropdownOpen()) { closeDropdown(); return; }
            const open = getOpenModal();
            if (open) { hideModal(open.id); return; }
            if (state.selection.size) { state.selection.clear(); renderTasks(); return; }
            if (state.selectMode) setSelectMode(false);
            return;
        }
        if (e.key === 'Tab') {
            const open = getOpenModal();
            if (open) trapFocus(e, open);
            return;
        }
        // Single-key shortcuts, but never while the caret is in a field, where
        // they are just characters someone is trying to type.
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
        if (getOpenModal() || typing || e.ctrlKey || e.metaKey || e.altKey) return;

        switch (e.key) {
            case '/':
                e.preventDefault();
                $('searchInput').focus();
                break;
            case 'n':
                e.preventDefault();
                $('taskInput').focus();
                break;
            case 'b':
                setView(state.view === 'board' ? 'list' : 'board');
                break;
            case 's':
                setSelectMode(!state.selectMode);
                break;
            case 'a':
                e.preventDefault();
                selectAllVisible();
                break;
            case 'e': {
                const first = document.querySelector('[data-act="edit"]');
                if (first) { state.editingId = first.dataset.id; renderTasks(); }
                break;
            }
            case '?':
                showModal('shortcutsModal');
                break;
            default:
                break;
        }
    });

    $('workspaceSelect').addEventListener('change', (e) => switchWorkspace(e.target.value));
    $('revokeOthersBtn').addEventListener('click', revokeOtherSessions);

    const forms = {
        loginForm: handleLogin,
        signupForm: handleSignup,
        verifyForm: handleVerifyEmail,
        forgotForm: handleForgotPassword,
        profileForm: handleUpdateProfile,
        passwordForm: handleChangePassword,
        inviteForm: handleInvite,
        newWorkspaceForm: handleCreateWorkspace,
        deleteAccountForm: handleDeleteAccount,
    };
    for (const [id, handler] of Object.entries(forms)) {
        $(id)?.addEventListener('submit', handler);
    }

    document.querySelectorAll('.code-input').forEach((input) => {
        const index = Number.parseInt(input.dataset.codeIndex || '0', 10);
        input.addEventListener('input', () => handleCodeInput(input, index));
        input.addEventListener('keydown', (e) => handleCodeKeydown(e, input, index));
        input.addEventListener('paste', handleCodePaste);
    });

    bindTaskList($('taskList'));
    bindTaskList($('completedTaskList'));
    bindPanelLists();
    bindToolbar();
    bindSavedViews();
    bindComposer();
    bindViewSwitch();
    bindBoard();
}

// ============ INIT ============

async function refreshAll() {
    await loadWorkspaces();
    await loadTasks();
    await loadMembersForLabels();
}

/// Members are needed to turn an assignee id into a name. The endpoint is
/// admin-only, so a plain member simply gets no names — which is why the
/// failure is silent rather than a toast about a permission they cannot have.
async function loadMembersForLabels() {
    if (!isLoggedIn() || !canAdmin()) {
        state.members = [];
        return;
    }
    const ws = currentWorkspace();
    if (!ws) return;
    const { ok, data } = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/members`, { quiet: true });
    state.members = ok && Array.isArray(data) ? data : [];
}

document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    try {
        const savedView = localStorage.getItem('view');
        if (savedView === 'board' || savedView === 'list') state.view = savedView;
    } catch (_) { /* ignore */ }
    bindActions();
    setView(state.view);
    await initWasm();
    await checkAuth();
    await refreshAll();
    await consumePendingInvite();
});
