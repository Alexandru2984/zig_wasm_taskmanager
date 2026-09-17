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
    /// One minimal directory page; never emails or a full workspace roster.
    members: [],
    addingSubtaskFor: null,
    savedViews: [],
    savedViewContext: null,
    activeSavedView: '',
    taskPage: 0,
    taskPageContext: '',
    childPages: new Map(),
};

const TASKS_PER_PAGE = 50;
let taskLoadGeneration = 0;
let taskLoadAbort = null;
let usageGeneration = 0, usageAbort = null;
const taskDrafts = new Map();
const pendingTaskWrites = new Set();

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
async function api(path, { method = 'GET', body = null, quiet = false, signal, version } = {}) {
    const requestUser = state.user;
    const requestWorkspace = state.currentWorkspaceId;
    const conditional = ['PUT', 'DELETE'].includes(method) && path.startsWith('/api/tasks/');
    const taskId = conditional ? decodeURIComponent(path.slice('/api/tasks/'.length)) : null;
    const pendingKey = `${requestUser?.id}:${taskId}`;
    if (conditional && pendingTaskWrites.has(pendingKey)) return { ok: false, status: 409, data: { busy: true, error: 'This task already has an update in progress.' } };
    // Do not publish an older multi-page read over an in-flight local write.
    const taskWrite = method !== 'GET' && !['/api/tasks/search', '/api/tasks/view'].includes(path) && /^\/api\/(tasks|trash)(\/|$)/.test(path);
    if (taskWrite) {
        mainView.childAbort?.abort(); mainView.childAbort = null; mainView.childGeneration++;
        if (mainView.child?.busy) { mainView.child.busy = false; mainView.child.error = true; }
        csvAbort?.abort();
    }
    if (taskWrite) resetTaskSearch(true);
    if (taskWrite) resetUsage();
    if (taskWrite && taskLoadAbort) cancelTaskLoad(true);
    const options = { method, credentials: 'include', headers: {}, signal };
    if (conditional) {
        const expected = version ?? state.tasks.find(task => task.id === taskId)?.version;
        if (Number.isSafeInteger(expected) && expected >= 0) options.headers['If-Match'] = `"v${expected}"`;
        pendingTaskWrites.add(pendingKey);
    }

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
        if (conditional) pendingTaskWrites.delete(pendingKey);
        if (!quiet) toast('Connection error. Check your network.', 'error');
        return { ok: false, status: 0, data: null };
    }

    // A refresh may also have started while this write was waiting for its
    // response. Fence that scan before the caller applies the write result.
    if (taskWrite && state.user === requestUser && state.currentWorkspaceId === requestWorkspace) {
        if (taskLoadAbort) cancelTaskLoad(true);
        resetTaskSearch(true); resetUsage();
    }

    let data = null;
    try {
        data = await response.json();
    } catch (_) {
        // 204s and error pages from nginx have no JSON body; that is fine.
    }
    if (conditional) pendingTaskWrites.delete(pendingKey);

    if (response.status === 423 && state.user === requestUser && state.currentWorkspaceId === requestWorkspace) {
        // A different tab/admin may have archived the workspace. Keep drafts
        // but stop offering writes; a fresh settings read obtains its revision.
        document.querySelectorAll('.task-edit').forEach(captureTaskDraft);
        const ws = currentWorkspace(); if (ws) ws.archived = true;
        state.selection.clear(); resetWorkspacePanel(true);
        renderWorkspaceBar(); renderTasks();
        toast(data?.error || 'This workspace is archived and read-only.', 'error');
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
    if (state.user?.id !== user.id) resetMainView();
    if (state.user !== user) resetUsage(true);
    if (state.user !== user) resetTaskSearch(true);
    if (state.user?.id !== user.id) {
        resetWorkspacePanel(true);
        cancelTaskLoad();
        taskDrafts.clear();
        resetTrash();
        $('mailDeliveryList').replaceChildren();
        $('mailDeliveryStatus').textContent = '';
        state.tasks = [];
        state.members = [];
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
    resetWorkspacePanel(true);
    resetMainView();
    resetUsage(true);
    resetTaskSearch(true);
    cancelTaskLoad();
    taskDrafts.clear();
    state.childPages.clear();
    resetTrash();
    $('toastRegion').replaceChildren();
    state.user = null;
    $('mailDeliveryList').replaceChildren();
    $('mailDeliveryStatus').textContent = '';
    state.tasks = getAnonTasks();
    state.savedViewContext = null;
    state.selection.clear();
    state.workspaces = [];
    state.members = [];
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
    return !ws.archived && ['owner','admin','member'].includes(ws.role);
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
        state.currentWorkspaceId = (preferred || state.workspaces.find(ws => !ws.archived) || state.workspaces[0])?.id || null;
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
        option.textContent = `${ws.archived ? '[Archived] ' : ''}${ws.name}`;
        if (ws.id === state.currentWorkspaceId) option.selected = true;
        select.appendChild(option);
    }

    const ws = currentWorkspace();
    role.textContent = ws ? ws.role : '';
    role.classList.toggle('hidden', !ws);
    $('workspaceArchiveNotice').classList.toggle('hidden', !ws?.archived);

    // The composer is pointless for a viewer, who cannot create anything.
    const writable = canWrite();
    $('taskInput').disabled = !writable;
    $('taskInput').placeholder = writable
        ? 'What needs to be done?'
        : 'You have read-only access to this workspace';
    $('taskForm').querySelector('button[type="submit"]').disabled = !writable;
}

function switchWorkspace(id) {
    if ([...taskDrafts.values()].some(draft => draft.dirty) && !window.confirm('Discard unsaved task edits and switch workspace?')) { renderWorkspaceBar(); return; }
    resetWorkspacePanel(true);
    resetMainView();
    resetUsage(true);
    resetTaskSearch(true);
    taskDrafts.clear();
    cancelTaskLoad();
    resetTrash();
    state.currentWorkspaceId = id;
    state.tasks = [];
    state.members = [];
    state.childPages.clear();
    try {
        localStorage.setItem('workspaceId', id);
    } catch (_) { /* ignore */ }
    renderWorkspaceBar();
    renderTasks();
    return Promise.all([loadTasks(), loadMembersForLabels()]);
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

function resetUsage(close = false) {
    usageGeneration++; usageAbort?.abort(); usageAbort = null;
    $('usageList').replaceChildren(); $('usageWorkspace').textContent = '';
    $('usageStatus').textContent = 'Refresh to read current usage.';
    $('refreshUsage').disabled = false;
    if (close && !$('usageModal').hidden) hideModal('usageModal');
}

async function openUsage() {
    if (!isLoggedIn() || !state.currentWorkspaceId) return;
    closeDropdown(); showModal('usageModal'); await loadUsage();
}

async function loadUsage() {
    resetUsage();
    if (!isLoggedIn() || !state.currentWorkspaceId || $('usageModal').hidden) return;
    const generation = usageGeneration, user = state.user, workspace = state.currentWorkspaceId;
    const controller = usageAbort = new AbortController();
    $('usageStatus').textContent = 'Reading usage…'; $('refreshUsage').disabled = true;
    const timeout = setTimeout(() => controller.abort(), 15000);
    let result;
    try { result = await api(`/api/workspaces/${encodeURIComponent(workspace)}/usage`, { quiet: true, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
    if (generation !== usageGeneration || state.user !== user || state.currentWorkspaceId !== workspace || $('usageModal').hidden) return;
    usageAbort = null; $('refreshUsage').disabled = false;
    const { ok, data } = result, usage = data?.usage, limits = data?.limits;
    if (!ok || data?.workspace_id !== workspace || !usage || !limits ||
        ['retained','trash','text_bytes','legacy_retained','legacy_trash','legacy_text_bytes','owned_workspaces'].some(key => !Number.isSafeInteger(usage[key]) || usage[key] < 0) ||
        ['tasks','text_bytes','workspaces'].some(key => !Number.isSafeInteger(limits[key]) || limits[key] <= 0)) {
        $('usageStatus').textContent = data?.error || 'Usage unavailable. Refresh to retry; no zero usage is assumed.'; return;
    }
    $('usageWorkspace').textContent = state.workspaces.find(ws => ws.id === workspace)?.name || 'Selected workspace';
    const bytes = value => `${value.toLocaleString()} bytes (${(value / 1048576).toFixed(2)} MiB)`;
    for (const text of [
        `Retained tasks: ${usage.retained.toLocaleString()} / ${limits.tasks.toLocaleString()} — ${usage.trash.toLocaleString()} in trash`,
        `Task text: ${bytes(usage.text_bytes)} / ${bytes(limits.text_bytes)}`,
        `Your owned workspaces: ${usage.owned_workspaces.toLocaleString()} / ${limits.workspaces.toLocaleString()}`,
        ...(usage.legacy_retained ? [`Your unattached legacy tasks: ${usage.legacy_retained.toLocaleString()} / ${limits.tasks.toLocaleString()} (${usage.legacy_trash} in trash), text ${bytes(usage.legacy_text_bytes)} / ${bytes(limits.text_bytes)}. This is a separate scope, not counted again in the workspace.`] : []),
    ]) { const li = document.createElement('li'); li.textContent = text; $('usageList').appendChild(li); }
    const full = usage.retained >= limits.tasks || usage.text_bytes >= limits.text_bytes;
    const near = usage.retained >= limits.tasks * .8 || usage.text_bytes >= limits.text_bytes * .8;
    $('usageStatus').textContent = full ? 'At or above a workspace limit. Growth may be refused; existing data is preserved.' : near ? 'Approaching a workspace limit (80% or more).' : 'Current usage is below the workspace limits.';
    $('usageStatus').focus();
}

// Global search keeps ONE server page and positional tokens in tab memory.
// It never replaces the complete workspace list or its counts/child progress.
const taskSearch = { generation: 0, abort: null, query: null, cursors: [null], page: 0, next: null, asOf: null, preview: null };

function resetTaskSearch(close = false) {
    taskSearch.generation++;
    taskSearch.abort?.abort(); taskSearch.abort = null;
    taskSearch.query = null; taskSearch.cursors = [null]; taskSearch.page = 0;
    taskSearch.next = null; taskSearch.asOf = null; taskSearch.preview = null;
    $('taskSearchResults').replaceChildren();
    $('taskSearchPreviewText').textContent = '';
    $('taskSearchPreview').classList.add('hidden');
    $('taskSearchStatus').textContent = '';
    $('taskSearchPrevious').disabled = true; $('taskSearchNext').disabled = true;
    $('taskSearchSubmit').disabled = false; $('taskSearchReveal').disabled = false;
    $('taskSearchCancel').classList.add('hidden');
    if (close) {
        $('taskSearchForm').reset();
        $('remoteSearchWorkspace').replaceChildren(new Option('All accessible workspaces', ''));
        if (!$('taskSearchModal').hidden) hideModal('taskSearchModal');
    }
}

function openTaskSearch() {
    if (!isLoggedIn()) return;
    resetTaskSearch(); closeDropdown();
    $('taskSearchForm').reset();
    $('remoteSearchDates').classList.add('hidden');
    const select = $('remoteSearchWorkspace');
    select.replaceChildren(new Option('All accessible workspaces', ''));
    for (const workspace of state.workspaces) select.add(new Option(workspace.name, workspace.id));
    $('taskSearchStatus').textContent = 'Choose filters and search. Up to 50 results per page.';
    showModal('taskSearchModal'); $('remoteSearchText').focus();
}

function taskSearchFilters() {
    const query = { q: $('remoteSearchText').value, workspace_id: $('remoteSearchWorkspace').value || null,
        status: $('remoteSearchStatus').value, priority: $('remoteSearchPriority').value,
        tag: $('remoteSearchTag').value, assignee: $('remoteSearchAssignee').value,
        due: $('remoteSearchDue').value, sort: $('remoteSearchSort').value, limit: 50 };
    if (query.due === 'range') {
        const start = new Date(`${$('remoteSearchFrom').value}T00:00:00`);
        const end = new Date(`${$('remoteSearchThrough').value}T00:00:00`);
        end.setDate(end.getDate() + 1);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new Error('Choose a valid date range.');
        query.due_from = start.getTime(); query.due_before = end.getTime();
    }
    return query;
}

async function loadTaskSearch(page = 0, fresh = false) {
    if (!isLoggedIn() || $('taskSearchModal').hidden) return;
    if (fresh) {
        let query;
        try { query = taskSearchFilters(); } catch (error) { resetTaskSearch(); $('taskSearchStatus').textContent = error.message; return; }
        resetTaskSearch(); taskSearch.query = query;
    }
    if (!taskSearch.query || page < 0 || page >= taskSearch.cursors.length || page >= 200) return;
    taskSearch.abort?.abort();
    const controller = taskSearch.abort = new AbortController();
    const generation = ++taskSearch.generation, user = state.user;
    const current = () => taskSearch.generation === generation && state.user === user && !$('taskSearchModal').hidden;
    $('taskSearchResults').replaceChildren(); taskSearch.preview = null;
    $('taskSearchPreviewText').textContent = ''; $('taskSearchPreview').classList.add('hidden');
    $('taskSearchStatus').textContent = 'Searching…';
    $('taskSearchSubmit').disabled = true; $('taskSearchPrevious').disabled = true; $('taskSearchNext').disabled = true;
    $('taskSearchCancel').classList.remove('hidden');
    const timeout = setTimeout(() => controller.abort(), 15000);
    let result;
    try { result = await api('/api/tasks/search', { method: 'POST', body: { ...taskSearch.query, cursor: taskSearch.cursors[page], as_of: taskSearch.asOf }, quiet: true, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
    if (!current()) return;
    taskSearch.abort = null;
    $('taskSearchSubmit').disabled = false; $('taskSearchCancel').classList.add('hidden');
    const { ok, data } = result;
    if (!ok || !Array.isArray(data?.items) || data.items.length > 50 || !Number.isSafeInteger(data.as_of) ||
        (taskSearch.asOf !== null && taskSearch.asOf !== data.as_of) ||
        !(data.next_cursor === null || (typeof data.next_cursor === 'string' && data.next_cursor.length <= 8192 && data.items.length > 0)) ||
        data.items.some(task => !task || typeof task.id !== 'string') || new Set(data.items.map(task => task.id)).size !== data.items.length) {
        resetTaskSearch();
        $('taskSearchStatus').textContent = data?.error || 'Search did not complete. Press Search to retry from the beginning.';
        $('taskSearchStatus').focus(); return;
    }
    taskSearch.page = page; taskSearch.next = data.next_cursor; taskSearch.asOf = data.as_of;
    taskSearch.cursors.length = page + 1;
    if (data.next_cursor) taskSearch.cursors.push(data.next_cursor);
    $('taskSearchPrevious').disabled = page === 0;
    $('taskSearchNext').disabled = !data.next_cursor || page >= 199;
    $('taskSearchStatus').textContent = data.items.length
        ? `Page ${page + 1} · ${data.items.length} results on this page. ${page >= 199 && data.next_cursor ? 'Refine your filters to continue.' : data.next_cursor ? 'More results available.' : 'End of results.'} Changes during browsing can move tasks; Search starts fresh.`
        : 'No matching tasks. Try different filters.';
    for (const task of data.items) {
        const item = document.createElement('li');
        const title = document.createElement('strong'); title.textContent = task.title;
        const workspace = state.workspaces.find(ws => ws.id === task.workspace_id);
        const meta = document.createElement('p'); meta.textContent = `${workspace?.name || (task.workspace_id ? 'Workspace' : 'Personal legacy task')} · ${task.parent_id ? 'Subtask · ' : ''}${taskStatus(task)} · ${task.priority}${task.due_date ? ` · ${formatDate(task.due_date)}` : ''}`;
        const snippet = document.createElement('p'); snippet.textContent = (task.notes || '').slice(0, 180);
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-ghost btn-sm'; button.textContent = 'View current details';
        button.addEventListener('click', () => previewSearchTask(task.id));
        item.append(title, meta, snippet, button); $('taskSearchResults').appendChild(item);
    }
    $('taskSearchStatus').focus();
}

async function previewSearchTask(id) {
    taskSearch.abort?.abort();
    const controller = taskSearch.abort = new AbortController();
    const generation = ++taskSearch.generation, user = state.user;
    taskSearch.preview = null; $('taskSearchPreviewText').textContent = ''; $('taskSearchPreview').classList.add('hidden');
    $('taskSearchStatus').textContent = 'Reading current task…';
    const timeout = setTimeout(() => controller.abort(), 15000);
    let result;
    try { result = await api(`/api/tasks/${encodeURIComponent(id)}`, { quiet: true, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
    if (taskSearch.generation !== generation || state.user !== user || $('taskSearchModal').hidden) return;
    taskSearch.abort = null;
    if (!result.ok || result.data?.id !== id || typeof result.data.title !== 'string') {
        // A removed/deauthorized result is no longer safe to retain here.
        resetTaskSearch(); $('taskSearchStatus').textContent = result.data?.error || 'Could not read this task. Search again to retry.'; return;
    }
    const task = taskSearch.preview = result.data;
    $('taskSearchPreviewText').textContent = `${task.title}\n${taskStatus(task)} · ${task.priority}\nDue: ${formatDate(task.due_date) || 'None'}\nTags: ${(task.tags || []).join(', ')}\n\n${task.notes || ''}`;
    $('taskSearchPreview').classList.remove('hidden');
    $('taskSearchStatus').textContent = 'Current details loaded. This preview is read-only.';
    $('taskSearchPreviewTitle').focus();
}

async function revealSearchTask() {
    const task = taskSearch.preview, user = state.user;
    if (!task || !user) return;
    await openMainTask(task);
}

async function loadTasks(options = {}) {
    if (isLoggedIn()) return loadMainTasks(options);
    cancelTaskLoad();
    $('taskLoadError').classList.add('hidden');
    state.tasks = getAnonTasks(); renderTasks();
}

function cancelTaskLoad(report = false) {
    clearTimeout(mainView.timer); mainView.timer = null;
    mainView.childAbort?.abort(); mainView.childAbort = null; mainView.childGeneration++;
    if (mainView.child?.busy) { mainView.child.busy = false; mainView.child.error = true; }
    taskLoadGeneration++;
    taskLoadAbort?.abort();
    taskLoadAbort = null;
    setLoading(false);
    $('taskLoadProgress').classList.add('hidden');
    if (report) { $('taskLoadError').classList.remove('hidden'); renderTasks(); }
}

function setLoading(loading) {
    state.loading = loading;
    $('taskListSkeleton').classList.toggle('hidden', !loading || state.tasks.length > 0);
    $('taskLoadProgress').classList.toggle('hidden', !loading);
    $('refreshTasksBtn').disabled = loading;
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
    if (isLoggedIn()) return mainProgress(id);
    const kids = subtasksOf(id);
    if (!kids.length) return null;
    return { done: kids.filter(k => k.completed).length, total: kids.length };
}

function memberName(userId) {
    if (!userId) return null;
    const m = state.members.find(x => x.user_id === userId);
    if (m) return m.name || m.email;
    if (state.user && state.user.id === userId) return state.user.name;
    return 'Assigned teammate';
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
        (view.tagFilter === null || (typeof view.tagFilter === 'string' && view.tagFilter.length <= 128)) &&
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
    $('exactTagInput').value = state.tagFilter || '';
    document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)));
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
    $('taskSearchForm').addEventListener('submit', e => { e.preventDefault(); loadTaskSearch(0, true); });
    $('taskSearchForm').addEventListener('input', () => {
        resetTaskSearch();
        $('remoteSearchDates').classList.toggle('hidden', $('remoteSearchDue').value !== 'range');
        $('taskSearchStatus').textContent = 'Filters changed. Press Search to load matching tasks.';
    });
    $('taskSearchPrevious').addEventListener('click', () => loadTaskSearch(taskSearch.page - 1));
    $('taskSearchNext').addEventListener('click', () => loadTaskSearch(taskSearch.page + 1));
    $('taskSearchCancel').addEventListener('click', () => { resetTaskSearch(); $('taskSearchStatus').textContent = 'Search cancelled. Press Search to try again.'; $('taskSearchSubmit').focus(); });
    $('taskSearchReveal').addEventListener('click', revealSearchTask);
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
            mainView.focus = null;
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
    $('refreshTasksBtn').addEventListener('click', () => loadTasks());
    $('cancelTasksBtn').addEventListener('click', () => cancelTaskLoad(true));
    for (const [id, delta] of [['tasksPrevious', -1], ['tasksNext', 1]]) {
        $(id).addEventListener('click', () => {
            if (isLoggedIn()) { changeMainPage(delta); return; }
            state.taskPage += delta;
            state.selection.clear(); state.editingId = null; state.addingSubtaskFor = null;
            renderTasks();
            $('taskPageStatus').focus();
        });
    }
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
    if (isLoggedIn()) renderMainChildren(task, content);
    const kids = isLoggedIn() ? [] : subtasksOf(task.id);
    if (kids.length) {
        const list = document.createElement('ul');
        list.className = 'subtask-list';
        const page = Math.min(state.childPages.get(task.id) || 0, Math.ceil(kids.length / TASKS_PER_PAGE) - 1);
        state.childPages.set(task.id, page);
        for (const kid of kids.slice(page * TASKS_PER_PAGE, (page + 1) * TASKS_PER_PAGE)) list.appendChild(renderSubtask(kid));
        content.appendChild(list);
        if (kids.length > TASKS_PER_PAGE) {
            const nav = document.createElement('div'); nav.className = 'task-pagination';
            for (const [label, delta] of [['Previous subtasks', -1], ['Next subtasks', 1]]) {
                const button = iconButton(label, label, 'btn btn-ghost btn-sm', { act: 'page-subtasks', id: task.id, delta });
                button.disabled = delta < 0 ? page === 0 : (page + 1) * TASKS_PER_PAGE >= kids.length;
                nav.append(button);
            }
            const status = badge(`Subtasks ${page * TASKS_PER_PAGE + 1}–${Math.min(kids.length, (page + 1) * TASKS_PER_PAGE)} of ${kids.length}`, 'pagination-status');
            status.tabIndex = -1; status.dataset.parentPage = task.id;
            nav.append(status); content.append(nav);
        }
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
    let draft = taskDrafts.get(String(task.id));
    if (!draft) {
        draft = { base: { ...task }, values: null, initial: null, dirty: false, conflict: false, latest: null, reviewing: false };
        taskDrafts.set(String(task.id), draft);
    }
    task = draft.base;
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

    const assignee = isLoggedIn() && currentWorkspace() ? buildAssigneePicker({ ...task, assignee_id: draft.values?.assignee_id ?? task.assignee_id }) : null;

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
    save.disabled = draft.conflict || !canWrite();
    actions.append(cancel, save);

    form.append(title, notes, row, row2, tags, actions);
    const fields = [...form.querySelectorAll('[data-field]')];
    if (!draft.initial) draft.initial = Object.fromEntries(fields.map(el => [el.dataset.field, el.value]));
    if (draft.values) for (const el of fields) if (Object.hasOwn(draft.values, el.dataset.field)) el.value = draft.values[el.dataset.field];
    if (draft.conflict) {
        const panel = document.createElement('section'); panel.className = 'task-conflict'; panel.setAttribute('aria-label', 'Task conflict');
        const message = document.createElement('p'); message.setAttribute('role', 'status'); message.tabIndex = -1; message.dataset.conflictStatus = task.id;
        message.textContent = draft.error || 'This task changed. Your unsaved edits are kept. Review the current version before saving.';
        panel.append(message);
        if (draft.latest) {
            const latest = document.createElement('pre'); latest.className = 'conflict-latest';
            latest.textContent = `Current version ${draft.latest.version}\nTitle: ${draft.latest.title}\nNotes: ${draft.latest.notes || '—'}\nPriority: ${draft.latest.priority}\nStatus: ${taskStatus(draft.latest)}\nDue: ${draft.latest.due_date || '—'}\nTags: ${(draft.latest.tags || []).join(', ')}\nRepeat: ${draft.latest.recurrence}\nAssignee: ${memberName(draft.latest.assignee_id) || draft.latest.assignee_id || '—'}`;
            panel.append(latest);
            for (const [act, label] of [['use-latest', 'Use current version'], ['keep-draft', 'Keep my edited fields']]) panel.append(iconButton(label, label, 'btn btn-secondary btn-sm', { act, id: task.id }));
            const hint = document.createElement('p'); hint.textContent = 'This prepares the editor only. Review it and press Save; nothing is saved automatically.'; panel.append(hint);
        } else {
            const review = iconButton('Review current version', 'Review current version', 'btn btn-secondary btn-sm', { act: 'review-conflict', id: task.id });
            review.disabled = draft.reviewing; panel.append(review);
        }
        form.append(panel);
    }
    li.appendChild(form);
    return li;
}

function captureTaskDraft(form) {
    const draft = taskDrafts.get(form.dataset.id);
    if (!draft) return;
    draft.values = Object.fromEntries([...form.querySelectorAll('[data-field]')].map(el => [el.dataset.field, el.value]));
    draft.dirty = Object.keys(draft.values).some(key => draft.values[key] !== draft.initial[key]);
}

function startTaskEdit(id) {
    if (state.editingId !== null && String(state.editingId) !== String(id) && !leaveMainDrafts()) return;
    if (String(state.editingId) !== String(id)) taskDrafts.clear();
    state.editingId = id; renderTasks();
}

async function reviewTaskConflict(id) {
    const draft = taskDrafts.get(id), user = state.user, workspace = state.currentWorkspaceId;
    if (!draft || draft.reviewing) return;
    draft.reviewing = true; renderTasks();
    const { ok, data } = await api(`/api/tasks/${encodeURIComponent(id)}`, { quiet: true });
    if (state.user !== user || state.currentWorkspaceId !== workspace || taskDrafts.get(id) !== draft) return;
    draft.reviewing = false;
    if (ok) { draft.latest = data; draft.error = ''; }
    else draft.error = data?.error || 'Could not load the current version. Your draft is still here; retry when connected.';
    renderTasks();
    document.querySelector(`[data-conflict-status="${CSS.escape(id)}"]`)?.focus();
}

function resolveTaskDraft(id, keepEdits) {
    const draft = taskDrafts.get(id);
    if (!draft?.latest) return;
    const edited = Object.fromEntries(Object.entries(draft.values || {}).filter(([key, value]) => value !== draft.initial[key]));
    const latest = draft.latest;
    const task = state.tasks.find(task => task.id === id); if (task) Object.assign(task, latest);
    taskDrafts.delete(id);
    // Rebuild against the new base, then overlay only fields the user edited.
    const form = renderTaskEditor(latest).querySelector('form');
    if (keepEdits) for (const el of form.querySelectorAll('[data-field]')) if (Object.hasOwn(edited, el.dataset.field)) el.value = edited[el.dataset.field];
    captureTaskDraft(form); renderTasks();
    document.querySelector('.task-edit [data-field="title"]')?.focus();
}

function renderTasks() {
    syncSavedViews();
    prepareMainView();
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

    const matched = isLoggedIn() ? scoped : scoped
        .filter(t => matchesFilter(t))
        .filter(t => matchesSearch(t, needle))
        .filter(t => !state.tagFilter || (t.tags || []).includes(state.tagFilter));

    const context = JSON.stringify([state.user?.id, state.currentWorkspaceId, state.search, state.filter, state.tagFilter, state.sort, state.view]);
    if (!isLoggedIn()) {
        if (state.taskPageContext !== context) { state.taskPageContext = context; state.taskPage = 0; state.selection.clear(); }
        state.taskPage = Math.max(0, Math.min(state.taskPage, Math.ceil(matched.length / TASKS_PER_PAGE) - 1));
    }
    // Preserve the existing active/completed split, with one shared page limit.
    const ordered = state.view === 'list' && state.filter === 'all'
        ? [...sortTasks(matched.filter(t => !t.completed)), ...sortTasks(matched.filter(t => t.completed))]
        : sortTasks(matched);
    const start = state.taskPage * TASKS_PER_PAGE;
    const visible = isLoggedIn() ? matched : ordered.slice(start, start + TASKS_PER_PAGE);
    const total = isLoggedIn() ? mainView.data?.matched : matched.length;
    $('taskPagination').classList.toggle('hidden', isLoggedIn() ? !mainView.data : matched.length <= TASKS_PER_PAGE);
    $('taskPageStatus').textContent = total === undefined ? 'Tasks not loaded' : `${total ? start + 1 : 0}–${Math.min(start + TASKS_PER_PAGE, total)} of ${total} matching tasks${isLoggedIn() ? ' · Server page; counts cover the workspace' : ''}${isLoggedIn() && mainView.page >= 199 && mainView.next ? ' · Narrow filters to continue beyond 200 pages' : ''}`;
    $('tasksPrevious').disabled = isLoggedIn() ? state.loading || mainView.page === 0 : state.taskPage === 0;
    $('tasksNext').disabled = isLoggedIn() ? state.loading || !mainView.next || mainView.page >= 199 : start + TASKS_PER_PAGE >= matched.length;
    $('focusedTaskNotice').classList.toggle('hidden', !isLoggedIn() || !mainView.focus);
    renderBulkBar();

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

    for (const task of isLoggedIn() ? active : sortTasks(active)) list.appendChild(renderTaskItem(task));

    if (done.length) {
        completedSection.classList.remove('hidden');
        $('completedSectionCount').textContent = String(done.length);
        completedList.classList.toggle('hidden', state.completedCollapsed);
        if (!state.completedCollapsed) {
            for (const task of isLoggedIn() ? done : sortTasks(done)) completedList.appendChild(renderTaskItem(task));
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
        count.textContent = `${inColumn.length}${isLoggedIn() ? ' on page' : ''}`;
        head.appendChild(count);

        const cards = document.createElement('ul');
        cards.className = 'board-cards';
        for (const task of isLoggedIn() ? inColumn : sortTasks(inColumn)) cards.appendChild(renderCard(task, status));

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

    if (!isLoggedIn()) {
        // The offline store knows about completion but not columns, so a move
        // is recorded as the completion it implies.
        anonToggle(id);
        await loadTasks();
        return;
    }

    await changeTask(id, { status });
}

function renderEmptyState(hasTasksButFiltered) {
    if (isLoggedIn() && !$('taskLoadError').classList.contains('hidden')) {
        $('emptyTitle').textContent = 'Tasks not loaded';
        $('emptyText').textContent = 'Retry to load the current workspace.';
    } else if (hasTasksButFiltered) {
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
    if (isLoggedIn()) {
        const c = mainView.data?.counts;
        for (const [id, value] of Object.entries({ countAll:c?.total, countActive:c ? c.total-c.done : undefined, countDone:c?.done, countOverdue:c?.overdue, countHigh:c?.high, countToday:c?.today, countUpcoming:c?.upcoming, totalCount:c?.total, completedCount:c?.done })) $(id).textContent = value === undefined ? '—' : String(value);
        const percent = c?.total ? Math.round(c.done / c.total * 100) : 0; setProgress(percent);
        if (c) $('progress').setAttribute('aria-valuenow', String(percent)); else $('progress').removeAttribute('aria-valuenow');
        return;
    }
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

    const tags = isLoggedIn() ? (mainView.data?.tags || []).map(row => [row.tag, row.count]) : allTags(tasks);
    $('moreTagsNotice').classList.toggle('hidden', !isLoggedIn() || !mainView.data?.tags_more);
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

    const user = state.user, workspace = state.currentWorkspaceId;
    const { ok, data } = await api('/api/tasks', { method: 'POST', body });
    if (state.user !== user || state.currentWorkspaceId !== workspace) return;
    if (!ok) {
        toast(data?.error || 'Could not add the task', 'error');
        return;
    }

    await loadTasks();
    announce(`Added ${title}`);
}

async function toggleTask(id) {
    if (!isLoggedIn()) {
        anonToggle(id);
        await loadTasks();
        return;
    }

    const task = state.tasks.find(t => t.id === id);
    if (!task) return;
    await changeTask(id, { completed: !task.completed });
}

function taskWriteError(id, result) {
    if (result.data?.busy) return;
    const conflict = [409, 412, 428].includes(result.status);
    const user = state.user, workspace = state.currentWorkspaceId;
    toast(result.data?.error || 'Update not confirmed. Refresh before retrying.', 'error', conflict || result.status === 0 ? {
        label: 'Refresh task', onClick: async () => {
            if (state.user !== user || state.currentWorkspaceId !== workspace) return;
            const { ok, data } = await api(`/api/tasks/${encodeURIComponent(id)}`);
            if (state.user !== user || state.currentWorkspaceId !== workspace) return;
            if (!ok) { toast(data?.error || 'Could not refresh task', 'error'); return; }
            const task = state.tasks.find(task => task.id === id); if (task) Object.assign(task, data);
            renderTasks();
        },
    } : null);
}

async function changeTask(id, body) {
    const user = state.user, workspace = state.currentWorkspaceId;
    const result = await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PUT', body });
    if (state.user !== user || state.currentWorkspaceId !== workspace) return;
    if (!result.ok) { renderTasks(); taskWriteError(id, result); return; }
    const task = state.tasks.find(task => task.id === id); if (task) Object.assign(task, result.data);
    renderTasks();
    const parent = task?.parent_id;
    await loadTasks();
    if (parent) await loadMainChildren(parent);
}

async function deleteTask(id) {
    if (!isLoggedIn()) {
        anonDelete(id);
        await loadTasks();
        return;
    }

    const removed = state.tasks.find(t => t.id === id), user = state.user, workspace = state.currentWorkspaceId;
    if (!removed || trashMutations.has(id)) return;
    trashMutations.add(id);
    const result = await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const { ok, data } = result;
    trashMutations.delete(id);
    if (state.user !== user || state.currentWorkspaceId !== workspace) return;
    if (!ok) {
        taskWriteError(id, result);
        return;
    }
    state.tasks = state.tasks.filter(t => t.id !== id && !(t.parent_id === id && t.workspace_id === removed.workspace_id));
    state.selection.clear();
    renderTasks();
    toast(`Moved "${removed.title}" to trash`, '', {
        label: 'Undo',
        onClick: () => { if (state.user === user) restoreTrashedTask(id, null, data.delete_batch); },
    });
    await loadTasks();
    if (removed.parent_id) await loadMainChildren(removed.parent_id);
}

const trashMutations = new Set();
let trashCursor = null, trashRequest = 0;
function resetTrash() {
    trashRequest++; trashCursor = null;
    $('trashList').replaceChildren(); $('trashStatus').textContent = ''; $('trashWorkspace').textContent = '';
    $('trashMore').classList.add('hidden');
}
async function openTrash() {
    closeDropdown(); showModal('trashModal'); await loadTrash();
}
async function loadTrash(more = false) {
    const user = state.user, ws = currentWorkspace();
    if (!user || !ws) { resetTrash(); return; }
    if (more && !trashCursor) return;
    const cursor = more ? trashCursor : null, request = ++trashRequest;
    if (!more) $('trashList').replaceChildren();
    $('trashMore').classList.add('hidden');
    $('trashWorkspace').textContent = ws.name;
    $('trashStatus').textContent = 'Loading…';
    const query = new URLSearchParams({ workspace_id: ws.id });
    if (cursor) query.set('cursor', cursor);
    const { ok, data } = await api(`/api/trash?${query}`);
    if (state.user !== user || state.currentWorkspaceId !== ws.id || request !== trashRequest) return;
    if (!ok) {
        $('trashStatus').textContent = data?.error || 'Could not load trash. Please refresh to retry.';
        $('trashMore').classList.toggle('hidden', !cursor); return;
    }
    for (const task of data.items) {
        if ([...$('trashList').children].some(row => row.dataset.id === task.id)) continue;
        const row = document.createElement('li'); row.className = 'panel-item'; row.dataset.id = task.id;
        const main = document.createElement('div'); main.className = 'panel-item-main';
        const title = document.createElement('div'); title.className = 'panel-item-title'; title.textContent = task.title;
        const detail = document.createElement('div'); detail.className = 'panel-item-sub';
        detail.textContent = `${task.parent_id ? 'Subtask · ' : ''}Deleted ${new Date(task.deleted_at * 1000).toLocaleString()}`;
        main.append(title, detail); row.append(main);
        if (ws.role !== 'viewer' && !ws.archived) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-ghost btn-sm';
            button.textContent = 'Restore'; button.setAttribute('aria-label', `Restore ${task.title}`);
            button.dataset.action = 'restore-task'; button.dataset.id = task.id; button.dataset.batch = task.delete_batch; row.append(button);
        }
        $('trashList').append(row);
    }
    trashCursor = data.next_cursor;
    $('trashMore').classList.toggle('hidden', !trashCursor);
    $('trashStatus').textContent = ws.archived ? 'Archived workspace: trash is retained. An owner or admin must unarchive before restoring tasks.' : $('trashList').children.length ? 'Restore a parent before any subtasks deleted with it.' : 'No deleted tasks in this workspace.';
}
async function restoreTrashedTask(id, button, batch = null) {
    const user = state.user;
    if (!user || trashMutations.has(id)) return;
    trashMutations.add(id); if (button) button.disabled = true;
    const { ok, data } = await api(`/api/trash/${encodeURIComponent(id)}`, { method: 'POST', ...(batch ? { body: { delete_batch: batch } } : {}) });
    trashMutations.delete(id); if (button) button.disabled = false;
    if (state.user !== user) return;
    if (!ok) { toast(data?.error || 'Could not restore task', 'error'); return; }
    await loadTasks();
    if (!$('trashModal').hidden) { await loadTrash(); $('trashStatus').focus(); }
    toast('Original task restored', 'success');
}

async function saveTaskEdit(form) {
    const id = form.dataset.id;
    captureTaskDraft(form);
    const draft = taskDrafts.get(id), user = state.user, workspace = state.currentWorkspaceId;
    if (draft?.conflict) return;
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
        taskDrafts.delete(id); state.editingId = null;
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

    const result = await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PUT', body, version: draft?.base.version });
    if (state.user !== user || state.currentWorkspaceId !== workspace || taskDrafts.get(id) !== draft) return;
    const { ok, data, status } = result;
    if (!ok) {
        if (data?.busy) return;
        if ([409, 412, 428].includes(status)) {
            draft.conflict = true; draft.latest = null; draft.error = '';
            renderTasks();
            document.querySelector(`[data-conflict-status="${CSS.escape(id)}"]`)?.focus();
            return;
        }
        toast(data?.error || 'Could not save the task', 'error');
        return;
    }

    const task = state.tasks.find(t => t.id === id);
    if (task) Object.assign(task, data);
    taskDrafts.delete(id);
    state.editingId = null;
    await loadTasks();
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
    const ids = [...state.selection].filter(id => action !== 'delete' || !state.tasks.some(t => String(t.id) === id && t.parent_id && state.selection.has(String(t.parent_id))));
    if (!ids.length) return;

    if (action === 'delete' && !window.confirm(`Delete ${ids.length} task${ids.length === 1 ? '' : 's'}?`)) {
        return;
    }

    let done = 0;
    let failed = 0;
    const user = state.user, workspace = state.currentWorkspaceId;
    for (const id of ids) {
        if (state.user !== user || state.currentWorkspaceId !== workspace) return;
        const ok = await applyOne(action, id);
        if (ok) done += 1;
        else failed += 1;
    }
    if (state.user !== user || state.currentWorkspaceId !== workspace) return;

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
    const user = state.user, workspace = state.currentWorkspaceId;
    const body = { title, parent_id: parentId };
    const parent = state.tasks.find(t => String(t.id) === String(parentId));
    if (parent && parent.workspace_id) body.workspace_id = parent.workspace_id;

    const { ok, data } = await api('/api/tasks', { method: 'POST', body });
    if (state.user !== user || state.currentWorkspaceId !== workspace) return;
    if (!ok) {
        toast(data?.error || 'Could not add the subtask', 'error');
        return;
    }
    state.addingSubtaskFor = null;
    await loadTasks();
    await loadMainChildren(String(parentId));
}

// ============ CSV EXPORT ============

/// Quote a field for CSV. Excel and everything else agree on doubling the
/// quote character; a field is quoted whenever it holds a delimiter, a quote
/// or a newline.
function csvField(value) {
    let text = value === null || value === undefined ? '' : String(value);
    // Quoting alone does not prevent spreadsheet formula execution.
    if (/^\s*[=+@-]/.test(text) || /^[\t\r]/.test(text)) text = "'" + text;
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function tasksAsCsv(tasks = workspaceTasks()) {
    const columns = ['id', 'title', 'notes', 'status', 'completed', 'priority',
        'due_date', 'tags', 'recurrence', 'parent_id', 'created_at'];
    const rows = [columns.join(',')];

    for (const task of tasks) {
        rows.push(columns.map(c => {
            if (c === 'tags') return csvField((task.tags || []).join(' '));
            return csvField(task[c]);
        }).join(','));
    }
    return rows.join('\r\n');
}

function downloadCsv() {
    if (isLoggedIn()) return downloadCompleteCsv();
    saveCsv(tasksAsCsv()); toast('CSV downloaded', 'success');
}
function saveCsv(text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
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
}

// ============ WORKSPACE MEMBERS & INVITES ============

const ROLE_LABEL = {
    owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer',
};

let teamGeneration = 0, teamScope = 0, teamRead = 0, inviteRead = 0, labelRead = 0, teamNext = null, teamQuery = '';
const pendingArchives = new Set();
async function handleWorkspaceArchive() {
    const ws = currentWorkspace(), button = $('workspaceArchiveAction');
    if (!state.user || !canAdmin() || button.disabled || $('workspaceModal').hidden) return;
    const current = teamContext(), key = `${state.user.id}:${ws.id}`, archived = !ws.archived, version = ws.archive_version;
    if (pendingArchives.has(key) || !Number.isSafeInteger(version)) return;
    const message = archived
        ? `Archive “${ws.name}”?\n\nTasks stay readable/exportable, but editing, rename, ownership transfer and reminders pause. All unaccepted invitations are permanently cancelled. Access management and account deletion still work. Unsaved task drafts remain local and cannot be saved while archived.`
        : `Unarchive “${ws.name}”?\n\nEditing and reminders resume, including overdue reminders. Cancelled invitations are not restored; send new invitations if needed.`;
    if (!window.confirm(message) || !current()) return;
    pendingArchives.add(key); button.disabled = true;
    $('workspaceArchiveError').textContent = 'Submitting. Closing this panel does not cancel a change already received by the server.';
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
    let result;
    try { result = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/archive`, { method: 'POST', body: { archived, expected_version: version }, quiet: true, signal: controller.signal }); }
    finally { clearTimeout(timeout); pendingArchives.delete(key); }
    if (!current() || $('workspaceModal').hidden) return;
    if (!result.ok || result.data?.id !== ws.id || result.data?.archived !== archived || result.data?.archive_version !== version + 1) {
        $('workspaceArchiveError').textContent = `${result.data?.error || 'The outcome could not be confirmed.'} Close and reopen Workspace settings to review its current state before retrying.`;
        return; // Locked until a fresh settings read; never replay a write.
    }
    document.querySelectorAll('.task-edit').forEach(captureTaskDraft);
    Object.assign(ws, result.data); state.selection.clear(); resetTrash(); resetTaskSearch(true); resetUsage();
    renderWorkspaceBar(); renderTasks();
    toast(archived ? 'Workspace archived. Pending invitations cancelled.' : 'Workspace unarchived.', 'success');
    await openWorkspacePanel();
}
let ownerTransfer = null;
const pendingOwnerTransfers = new Set();
function resetOwnerTransfer(focus = false) {
    const trigger = ownerTransfer?.trigger;
    ownerTransfer = null;
    $('ownerTransferForm').reset(); $('ownerTransferForm').classList.add('hidden');
    $('ownerTransferTarget').textContent = ''; $('ownerTransferError').textContent = '';
    setButtonLoading($('ownerTransferSubmit'), false);
    $('ownerTransferCancel').textContent = 'Cancel';
    $('memberSearchForm').classList.remove('hidden'); $('memberList').classList.remove('hidden');
    if (focus && trigger?.isConnected) trigger.focus();
}
function beginOwnerTransfer(member, trigger) {
    const ws = currentWorkspace();
    if (!state.user || ws?.role !== 'owner' || ws.archived || member.user_id === state.user.id) return;
    if (pendingOwnerTransfers.has(`${state.user.id}:${ws.id}`)) { toast('A transfer is still pending. Wait, then reopen the workspace to check its owner.', 'error'); return; }
    resetOwnerTransfer();
    ownerTransfer = { member: { ...member }, workspace: ws.id, current: teamContext(), trigger, submitting: false, locked: false };
    $('ownerTransferTarget').textContent = `New owner: ${member.name || 'Teammate'} · ${member.user_id}`;
    $('ownerTransferForm').classList.remove('hidden');
    $('memberSearchForm').classList.add('hidden'); $('memberList').classList.add('hidden');
    $('ownerTransferPassword').focus();
}
async function handleOwnerTransfer(event) {
    event.preventDefault();
    const operation = ownerTransfer;
    if (!operation || operation.submitting || operation.locked || !operation.current() || !$('ownerTransferAck').checked) return;
    const key = `${state.user.id}:${operation.workspace}`;
    if (pendingOwnerTransfers.has(key)) return;
    pendingOwnerTransfers.add(key); operation.submitting = true;
    $('ownerTransferError').textContent = 'Submitting. Closing this form does not cancel a transfer already received by the server.';
    $('ownerTransferCancel').textContent = 'Close confirmation'; setButtonLoading($('ownerTransferSubmit'), true);
    // Password lives in the input/request only: never retain it in UI state,
    // drafts, storage, URLs or activity. Clear immediately on every attempt.
    const body = { user_id: operation.member.user_id, password: $('ownerTransferPassword').value };
    $('ownerTransferPassword').value = ''; $('ownerTransferAck').checked = false;
    let result;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
    try { result = await api(`/api/workspaces/${encodeURIComponent(operation.workspace)}/owner`, { method: 'POST', body, quiet: true, signal: controller.signal }); }
    finally { clearTimeout(timeout); body.password = ''; pendingOwnerTransfers.delete(key); }
    if (!operation.current() || ownerTransfer !== operation) return;
    operation.submitting = false;
    setButtonLoading($('ownerTransferSubmit'), false);
    if (!result.ok || result.data?.workspace_id !== operation.workspace || result.data?.owner_id !== operation.member.user_id || result.data?.role !== 'admin') {
        operation.locked = true; $('ownerTransferSubmit').disabled = true;
        $('ownerTransferError').textContent = `${result.data?.error || 'The outcome could not be confirmed.'} Close and reopen this panel to check the current owner before making a new attempt.`;
        return;
    }
    const ws = currentWorkspace(); if (ws?.id === operation.workspace) ws.role = 'admin';
    resetOwnerTransfer(); renderWorkspaceBar();
    toast('Ownership transferred. You are now an admin.', 'success');
    await openWorkspacePanel();
}
function resetWorkspacePanel(close = false) {
    resetOwnerTransfer();
    $('workspaceArchiveControls').classList.add('hidden');
    $('workspaceArchiveHint').textContent = ''; $('workspaceArchiveError').textContent = '';
    $('workspaceArchiveAction').disabled = true;
    teamGeneration++; teamRead++; inviteRead++; teamNext = null; teamQuery = '';
    if (close) { teamScope++; labelRead++; state.members = []; }
    for (const id of ['memberList','inviteList']) $(id).replaceChildren();
    for (const id of ['workspaceTitle','workspaceSubtitle','memberEmpty','inviteEmpty','workspaceRenameError']) $(id).textContent = '';
    for (const id of ['memberSearch','workspaceRename']) $(id).value = '';
    $('workspaceRenameForm').classList.add('hidden');
    delete $('workspaceRenameForm').dataset.expected;
    $('memberNext').disabled = true;
    if (close && !$('workspaceModal').hidden) hideModal('workspaceModal');
}
function teamContext(panel = true) {
    const user = state.user, workspace = state.currentWorkspaceId, generation = teamGeneration, scope = teamScope;
    return () => state.user === user && state.currentWorkspaceId === workspace && teamScope === scope && (!panel || teamGeneration === generation);
}
async function readDirectory(workspace, term = '', after = null) {
    const query = new URLSearchParams({ q: term });
    if (after) query.set('after', after);
    const result = await api(`/api/workspaces/${encodeURIComponent(workspace)}/directory?${query}`, { quiet: true });
    const data = result.data;
    if (result.ok && (data?.workspace_id !== workspace || !Array.isArray(data.items) || data.items.length > 50 ||
        !data.items.every(row => /^users:[a-zA-Z0-9_-]+$/.test(row.user_id) && typeof row.name === 'string' && Object.hasOwn(ROLE_LABEL,row.role)) ||
        !(data.next_cursor === null || /^users:[a-zA-Z0-9_-]+$/.test(data.next_cursor)))) return { ok: false, status: 503 };
    return result;
}
function buildAssigneePicker(task) {
    const box = document.createElement('div'); box.className = 'assignee-picker';
    const select = document.createElement('select'); select.dataset.field = 'assignee_id'; select.setAttribute('aria-label','Assignee');
    function choices(rows, selected, label) {
        select.replaceChildren(new Option('Unassigned',''));
        for (const row of rows) select.add(new Option(`${row.name || 'Teammate'} · ${row.user_id}`, row.user_id));
        if (selected && !rows.some(row => row.user_id === selected)) select.add(new Option(label || `Current assignee · ${selected}`, selected));
        select.value = selected || '';
    }
    choices(state.members, task.assignee_id);
    const search = document.createElement('input'); search.type = 'search'; search.maxLength = 80;
    search.placeholder = 'Find a teammate by name'; search.setAttribute('aria-label','Search teammates');
    const find = document.createElement('button'); find.type = 'button'; find.className = 'btn btn-ghost'; find.textContent = 'Find teammates';
    const more = document.createElement('button'); more.type = 'button'; more.className = 'btn btn-ghost'; more.textContent = 'Next teammates'; more.disabled = true;
    const status = document.createElement('small'); status.setAttribute('role','status'); status.textContent = 'First 50 teammates. Search to find someone else.';
    let sequence = 0, next = null, query = '';
    const current = teamContext(false), workspace = state.currentWorkspaceId;
    async function load(after = null) {
        const read = ++sequence; if (!after) query = search.value.trim();
        find.disabled = more.disabled = true; status.textContent = 'Loading teammates…';
        const result = await readDirectory(workspace, query, after);
        if (!current() || !box.isConnected || read !== sequence) return;
        find.disabled = false;
        if (!result.ok) {
            if ([403,404].includes(result.status)) { state.members = []; choices([], select.value); }
            status.textContent = 'Could not load teammates. Retry Find teammates; your assignment is unchanged.'; return;
        }
        choices(result.data.items, select.value, select.selectedOptions[0]?.textContent);
        next = result.data.next_cursor; more.disabled = !next;
        status.textContent = `${result.data.items.length} teammates on this page${next ? ' · More available' : ''}. Current selection is preserved.`;
    }
    find.addEventListener('click', () => load()); more.addEventListener('click', () => load(next));
    search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void load(); } });
    box.append(select, search, find, more, status); return box;
}

async function openWorkspacePanel() {
    closeDropdown();
    let ws = currentWorkspace();
    if (!ws) {
        toast('No workspace selected', 'error');
        return;
    }

    resetWorkspacePanel();
    const current = teamContext();
    $('workspaceTitle').textContent = 'Loading workspace…';
    showModal('workspaceModal');
    // Reopening is the explicit conflict-review path. Do not reuse stale
    // switcher metadata as the next rename expectation or permission display.
    const latest = await api('/api/workspaces', { quiet: true });
    if (!current() || $('workspaceModal').hidden) return;
    const fresh = latest.ok && Array.isArray(latest.data) ? latest.data.find(row => row.id === ws.id) : null;
    if (!fresh) { hideModal('workspaceModal'); toast('Could not refresh workspace access. Retry after refreshing the page.', 'error'); return; }
    state.workspaces = state.workspaces.map(row => row.id === fresh.id ? fresh : row); ws = fresh;
    document.querySelectorAll('.task-edit').forEach(captureTaskDraft);
    renderWorkspaceBar(); renderTasks();
    $('workspaceTitle').textContent = ws.name;
    $('workspaceSubtitle').textContent = canAdmin() ? 'Team, invitations and workspace name' : 'Your team · Names and roles only';
    $('workspaceRename').value = ws.name;
    $('workspaceRenameForm').dataset.expected = ws.name;
    $('workspaceRenameForm').classList.toggle('hidden', !canAdmin() || ws.archived);
    $('workspaceArchiveControls').classList.toggle('hidden', !canAdmin());
    $('workspaceArchiveAction').textContent = ws.archived ? 'Unarchive workspace…' : 'Archive workspace…';
    $('workspaceArchiveAction').disabled = pendingArchives.has(`${state.user.id}:${ws.id}`);
    $('workspaceArchiveHint').textContent = ws.archived
        ? 'Archived: task editing and reminders are paused. Members can still read/export; access management and account deletion remain available.'
        : 'Archive to pause task editing and reminders without deleting tasks. Unaccepted invitations will be permanently cancelled. Access management and account deletion remain available.';
    $('workspaceInvitesTab').classList.toggle('hidden', !canAdmin());
    $('inviteForm').classList.toggle('hidden', !canAdmin() || ws.archived);
    switchTab('workspace', 'members', document.querySelector('[data-scope="workspace"][data-tab="members"]'));
    await Promise.all([loadMembers(), ...(canAdmin() ? [loadInvites()] : [])]);
}

async function loadMembers(after = null) {
    const ws = currentWorkspace();
    if (!ws || $('workspaceModal').hidden) return;
    const current = teamContext(), read = ++teamRead;
    if (!after) teamQuery = $('memberSearch').value.trim();
    $('memberNext').disabled = true;
    $('memberEmpty').textContent = 'Loading teammates…'; $('memberEmpty').classList.remove('hidden');
    $('memberList').replaceChildren();
    const { ok, data } = await readDirectory(ws.id, teamQuery, after);
    if (!current() || read !== teamRead || $('workspaceModal').hidden) return;
    const list = $('memberList');
    const empty = $('memberEmpty');
    if (!ok) { empty.textContent = 'Could not load teammates. Use Search / refresh to retry.'; return; }
    teamNext = data.next_cursor; $('memberNext').disabled = !teamNext;
    empty.textContent = data.items.length ? `${data.items.length} teammates on this page${teamNext ? ' · More available' : ''}. Names and roles only.` : 'No teammates match this name.';
    for (const member of data.items) list.appendChild(renderMember(member, ws));
}

async function handleWorkspaceRename(event) {
    event.preventDefault();
    const ws = currentWorkspace(), current = teamContext();
    if (!ws || !canAdmin()) return;
    const form = event.target, button = formButton(form), expected = form.dataset.expected;
    setError('workspaceRenameError', ''); setButtonLoading(button, true);
    const result = await api(`/api/workspaces/${encodeURIComponent(ws.id)}`, {
        method: 'PATCH', body: { name: $('workspaceRename').value.trim(), expected_name: expected }, quiet: true,
    });
    setButtonLoading(button, false);
    if (!current()) return;
    if (!result.ok) {
        setError('workspaceRenameError', result.status === 409 ? 'The name or permissions changed. Your draft is kept. Reopen this panel to review the current name before retrying.' : result.data?.error || 'Could not rename the workspace. Reopen to check its current name before retrying.');
        return;
    }
    ws.name = result.data.name; form.dataset.expected = ws.name;
    $('workspaceRename').value = ws.name; $('workspaceTitle').textContent = ws.name;
    renderWorkspaceBar(); toast('Workspace renamed', 'success');
}

function renderMember(member, workspace) {
    const li = document.createElement('li');
    li.className = 'panel-item';

    const main = document.createElement('div');
    main.className = 'panel-item-main';
    const name = document.createElement('div');
    name.className = 'panel-item-title';
    name.textContent = member.name || 'Teammate';
    const email = document.createElement('div');
    email.className = 'panel-item-sub';
    email.textContent = member.user_id;
    main.append(name, email);

    const actions = document.createElement('div');
    actions.className = 'panel-item-actions';

    const isSelf = state.user && member.user_id === state.user.id;

    // Ordinary member controls cannot modify/remove the owner. Ownership uses
    // the separate password-confirmed transaction and explicit warning form.
    if (member.role === 'owner' || !['owner','admin'].includes(workspace.role)) {
        actions.appendChild(badge(ROLE_LABEL[member.role], 'badge badge-muted'));
    } else {
        const select = document.createElement('select');
        select.setAttribute('aria-label', `Role for ${member.name} · ${member.user_id}`);
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
                `Remove ${member.name} · ${member.user_id}`, '✕', 'icon-btn btn-delete',
                { userId: member.user_id, act: 'remove-member' },
            ));
        }
    }

    li.append(main, actions);
    if (workspace.role === 'owner' && !workspace.archived && !isSelf && member.role !== 'owner') {
        const transfer = document.createElement('button'); transfer.type = 'button';
        transfer.className = 'btn btn-ghost btn-sm owner-transfer-trigger';
        transfer.textContent = 'Make owner…'; transfer.dataset.transferUser = member.user_id;
        transfer.setAttribute('aria-label', `Transfer ownership to ${member.name} · ${member.user_id}`);
        transfer.addEventListener('click', () => beginOwnerTransfer(member, transfer));
        li.appendChild(transfer);
    }
    return li;
}

async function loadInvites() {
    const ws = currentWorkspace();
    if (!ws || !canAdmin() || $('workspaceModal').hidden) return;
    const current = teamContext(), read = ++inviteRead;
    $('inviteList').replaceChildren();
    $('inviteEmpty').textContent = 'Loading invitations…'; $('inviteEmpty').classList.remove('hidden');
    const { ok, data } = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/invites`, { quiet: true });
    if (!current() || read !== inviteRead || $('workspaceModal').hidden) return;
    const list = $('inviteList');
    const empty = $('inviteEmpty');
    list.textContent = '';

    if (!ok || !Array.isArray(data) || !data.length) {
        empty.textContent = ok ? 'No pending invitations.' : 'Could not load invitations. Reopen this panel to retry.';
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

    const current = teamContext();
    const btn = formButton(e.target);
    setError('inviteError', '');
    setButtonLoading(btn, true);

    const { ok, data } = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/invites`, {
        method: 'POST',
        body: { email: $('inviteEmail').value, role: $('inviteRole').value },
    });
    setButtonLoading(btn, false);

    if (!current()) return;

    if (!ok) {
        setError('inviteError', data?.error || 'Could not send the invitation');
        return;
    }

    e.target.reset();
    await loadInvites();
    if (!current()) return;
    toast(`Invitation sent to ${data.email}`, 'success');
}

async function changeMemberRole(userId, role) {
    const ws = currentWorkspace();
    if (!ws) return;
    const current = teamContext();
    const { ok, data } = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/members`, {
        method: 'PUT',
        body: { user_id: userId, role },
    });
    if (!current()) return;
    if (!ok) {
        toast(data?.error || 'Could not change the role', 'error');
        await loadMembers();
        return;
    }
    toast('Role updated', 'success');
    await loadWorkspaces();
    if (!current()) return;
    await openWorkspacePanel();
}

async function removeMember(userId) {
    const ws = currentWorkspace();
    if (!ws) return;
    const current = teamContext();
    if (!window.confirm('Remove this member from the workspace?')) return;

    const { ok, data } = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/members`, {
        method: 'DELETE',
        body: { user_id: userId },
    });
    if (!current()) return;
    if (!ok) {
        toast(data?.error || 'Could not remove the member', 'error');
        return;
    }
    toast('Member removed', 'success');
    state.members = state.members.filter(row => row.user_id !== userId);
    await loadMembers();
}

async function revokeInvite(inviteId) {
    const ws = currentWorkspace();
    if (!ws) return;
    const current = teamContext();
    const { ok, data } = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/invites`, {
        method: 'DELETE',
        body: { invite_id: inviteId },
    });
    if (!current()) return;
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
    delete_task: 'Task moved to trash',
    restore_task: 'Task restored',
    create_workspace: 'Workspace created',
    rename_workspace: 'Workspace renamed',
    archive_workspace: 'Workspace archived',
    unarchive_workspace: 'Workspace unarchived',
    transfer_workspace_ownership: 'Workspace ownership transferred',
    receive_workspace_ownership: 'Workspace ownership received',
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
    if (id === 'workspaceModal') resetWorkspacePanel();
    if (id === 'usageModal') resetUsage();
    if (id === 'taskSearchModal') {
        resetTaskSearch();
        $('remoteSearchWorkspace').replaceChildren(new Option('All accessible workspaces', ''));
    }
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
    if (scope === 'profile' && tabName === 'mail') loadEmailDeliveries();
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

async function loadEmailDeliveries() {
    const user = state.user;
    if (!user) return;
    $('mailDeliveryStatus').textContent = 'Loading…';
    $('mailDeliveryList').replaceChildren();
    const { ok, data } = await api('/api/email-deliveries');
    if (state.user !== user) return;
    $('mailDeliveryList').replaceChildren();
    $('mailDeliveryStatus').textContent = !ok ? 'Could not load delivery status. Please retry.' : data.length ? 'Latest 100 deliveries; older records expire after seven days.' : 'No recent email deliveries.';
    if (!ok) return;
    for (const job of data) {
        const row = document.createElement('li'); row.className = 'panel-item';
        const details = document.createElement('div'); details.className = 'panel-item-main';
        const title = document.createElement('div'); title.className = 'panel-item-title';
        title.textContent = `${job.kind.replaceAll('_', ' ')} · ${job.status}`;
        const subtitle = document.createElement('div'); subtitle.className = 'panel-item-sub';
        subtitle.textContent = `${new Date(job.created_at * 1000).toLocaleString()} · ${job.attempts} attempt(s)`;
        details.append(title, subtitle); row.append(details); $('mailDeliveryList').append(row);
    }
}

/** One delegated listener for both task lists. Each interactive element
 *  carries data-act, so adding a row action needs no new listener. */
function bindTaskList(listEl) {
    listEl.addEventListener('input', e => { const form = e.target.closest('.task-edit'); if (form) captureTaskDraft(form); });
    listEl.addEventListener('change', e => { const form = e.target.closest('.task-edit'); if (form) captureTaskDraft(form); });
    listEl.addEventListener('click', (e) => {
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const { act, id, tag } = el.dataset;

        if (act === 'toggle') toggleTask(id);
        else if (act === 'delete') deleteTask(id);
        else if (act === 'edit') startTaskEdit(id);
        else if (act === 'cancel-edit') { taskDrafts.delete(String(state.editingId)); state.editingId = null; renderTasks(); }
        else if (act === 'review-conflict') reviewTaskConflict(id);
        else if (act === 'use-latest') resolveTaskDraft(id, false);
        else if (act === 'keep-draft') resolveTaskDraft(id, true);
        else if (act === 'filter-tag') { state.tagFilter = tag; mainView.focus = null; renderTasks(); }
        else if (act === 'select') toggleSelected(id);
        else if (act === 'add-subtask') { state.addingSubtaskFor = String(id); renderTasks(); }
        else if (act === 'cancel-subtask') { state.addingSubtaskFor = null; renderTasks(); }
        else if (act === 'show-subtasks') loadMainChildren(id);
        else if (act === 'hide-subtasks') { clearMainChildren(); renderTasks(); }
        else if (act === 'page-subtasks') {
            if (isLoggedIn()) { loadMainChildren(id, (mainView.child?.page || 0) + Number(el.dataset.delta), mainView.child?.focus); return; }
            state.childPages.set(id, (state.childPages.get(id) || 0) + Number(el.dataset.delta));
            renderTasks();
            document.querySelector(`[data-parent-page="${CSS.escape(id)}"]`)?.focus();
        }
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
        taskDrafts.delete(String(state.editingId));
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
    $('backToTasks').addEventListener('click', () => { if (!leaveMainDrafts()) return; mainView.focus = null; renderTasks(); });
    $('exactTagForm').addEventListener('submit', e => { e.preventDefault(); state.tagFilter = $('exactTagInput').value.trim() || null; mainView.focus = null; renderTasks(); });
    // prepareMainView debounces signed-in server searches.
    $('searchInput').addEventListener('input', (e) => {
        state.search = e.target.value;
        mainView.focus = null;
        renderTasks();
    });

    $('sortSelect').addEventListener('change', (e) => {
        state.sort = e.target.value;
        mainView.focus = null;
        try { localStorage.setItem(`${viewStorageKey()}:sort`, state.sort); } catch (_) { /* ignore */ }
        renderTasks();
    });

    $('filterChips').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-filter]');
        if (!chip) return;
        state.filter = chip.dataset.filter;
        mainView.focus = null;
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
        mainView.focus = null;
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
    window.addEventListener('beforeunload', e => {
        if ([...taskDrafts.values()].some(draft => draft.dirty)) { e.preventDefault(); e.returnValue = ''; }
    });
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
            case 'open-task-search': openTaskSearch(); break;
            case 'verify-now': e.preventDefault(); hideModal('profileModal'); showModal('verifyModal'); break;
            case 'refresh-mail': loadEmailDeliveries(); break;
            case 'resend-code': handleResendCode(e); break;
            case 'open-workspace': openWorkspacePanel(); break;
            case 'open-activity': openActivityPanel(); break;
            case 'open-trash': openTrash(); break;
            case 'open-usage': openUsage(); break;
            case 'refresh-usage': loadUsage(); break;
            case 'refresh-trash': loadTrash(); break;
            case 'more-trash': loadTrash(true); break;
            case 'restore-task': restoreTrashedTask(el.dataset.id, el, el.dataset.batch); break;
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
                if (first) startTaskEdit(first.dataset.id);
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

/// A bounded, private directory page for labels. Other teammates remain
/// discoverable through the editor's server-side name search and pagination.
async function loadMembersForLabels() {
    if (!isLoggedIn()) {
        state.members = [];
        return;
    }
    const ws = currentWorkspace();
    if (!ws) return;
    const current = teamContext(false), read = ++labelRead;
    const { ok, data } = await readDirectory(ws.id);
    if (!current() || read !== labelRead) return;
    state.members = ok ? data.items : [];
    renderTasks();
}

document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    try {
        const savedView = localStorage.getItem('view');
        if (savedView === 'board' || savedView === 'list') state.view = savedView;
    } catch (_) { /* ignore */ }
    bindActions();
    $('workspaceRenameForm').addEventListener('submit', handleWorkspaceRename);
    $('workspaceArchiveAction').addEventListener('click', handleWorkspaceArchive);
    $('ownerTransferForm').addEventListener('submit', handleOwnerTransfer);
    $('ownerTransferCancel').addEventListener('click', () => resetOwnerTransfer(true));
    $('memberSearchForm').addEventListener('submit', event => { event.preventDefault(); void loadMembers(); });
    $('memberNext').addEventListener('click', () => { if (teamNext) void loadMembers(teamNext); });
    setView(state.view);
    await initWasm();
    await checkAuth();
    await refreshAll();
    await consumePendingInvite();
});
