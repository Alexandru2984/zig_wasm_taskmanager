// Zig Tasks — front-end controller.
// Logged-in tasks live in the API; anonymous tasks live client-side.
// SECURITY: auth is carried only by the HttpOnly session cookie. We never read
// or store the session token in JS, so an XSS cannot exfiltrate it.

let wasm = null;
let wasmMemory = null;
let currentUser = null;
let suppressRender = false;

const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let lastFocused = null;

// ============ THEME ============

function systemTheme() {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || systemTheme();
}

function updateThemeIcon() {
    const icon = document.getElementById('themeIcon');
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
    announce(`${next.charAt(0).toUpperCase() + next.slice(1)} theme`);
}

function initTheme() {
    let saved = null;
    try {
        saved = localStorage.getItem('theme');
    } catch (_) { /* ignore */ }
    if (saved === 'light' || saved === 'dark') applyTheme(saved);
    else updateThemeIcon();
}

// ============ LIVE ANNOUNCER ============

function announce(message) {
    const el = document.getElementById('announcer');
    if (!el) return;
    el.textContent = '';
    setTimeout(() => { el.textContent = message; }, 30);
}

// ============ AUTH HELPERS ============

function setButtonLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
        btn.dataset.originalText = btn.textContent;
        btn.textContent = 'Loading…';
        btn.disabled = true;
        btn.classList.add('loading');
    } else {
        btn.textContent = btn.dataset.originalText || btn.textContent;
        btn.disabled = false;
        btn.classList.remove('loading');
    }
}

function getFormButton(form) {
    return form.querySelector('button[type="submit"]');
}

function isLoggedIn() {
    return currentUser !== null;
}

function getCookie(name) {
    const prefix = `${name}=`;
    return document.cookie
        .split(';')
        .map(part => part.trim())
        .find(part => part.startsWith(prefix))
        ?.slice(prefix.length) || '';
}

function csrfHeaders(headers = {}) {
    const token = getCookie('csrf_token');
    return token ? { ...headers, 'X-CSRF-Token': token } : headers;
}

async function checkAuth() {
    try {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (response.ok) {
            currentUser = await response.json();
            showLoggedIn(currentUser);
        } else {
            showLoggedOut();
        }
    } catch (error) {
        showLoggedOut();
    }
}

function showLoggedIn(user) {
    document.getElementById('authButtons').classList.add('hidden');
    document.getElementById('userMenu').classList.remove('hidden');
    document.getElementById('userName').textContent = user.name;
    document.getElementById('userEmail').textContent = user.email;
    document.getElementById('userAvatar').textContent = (user.name || '?').charAt(0).toUpperCase();

    document.getElementById('profileName').textContent = user.name;
    document.getElementById('profileEmail').textContent = user.email;
    document.getElementById('profileAvatar').textContent = (user.name || '?').charAt(0).toUpperCase();
    document.getElementById('profileNameInput').value = user.name;

    const badge = document.getElementById('profileVerified');
    badge.textContent = '';
    if (user.email_verified) {
        const span = document.createElement('span');
        span.className = 'badge badge-success';
        span.textContent = '✅ Verified';
        badge.appendChild(span);
    } else {
        const span = document.createElement('span');
        span.className = 'badge badge-warning';
        span.textContent = '⚠️ Not verified';
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'verify-now-link';
        link.dataset.action = 'verify-now';
        link.textContent = 'Verify now';
        badge.append(span, link);
    }
}

function showLoggedOut() {
    currentUser = null;
    document.getElementById('authButtons').classList.remove('hidden');
    document.getElementById('userMenu').classList.add('hidden');
    closeDropdown();
}

// ============ ANONYMOUS TASKS (Zig/WASM owns the model) ============
// While logged out, the WebAssembly module written in Zig is the source of
// truth for tasks. We mirror a snapshot to localStorage so they survive a
// reload. If the WASM module fails to load, we fall back to plain localStorage.

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

function priorityToCode(p) {
    return p === 'high' ? 1 : p === 'low' ? 2 : 0;
}

function priorityFromCode(c) {
    return c === 1 ? 'high' : c === 2 ? 'low' : 'normal';
}

function wasmAddTask(title, dueDate, priority) {
    const t = wasmStr(title);
    const d = wasmStr(dueDate || '');
    const id = wasm.addTask(t.ptr, t.len, d.ptr, d.len, priorityToCode(priority));
    wasm.freeString();
    return id;
}

function wasmGetTasks() {
    const out = [];
    const count = wasm.getTaskCount();
    for (let i = 0; i < count; i++) {
        const id = wasm.getTaskId(i);
        if (!id) continue;
        out.push({
            id,
            title: wasmReadStr(wasm.getTaskTitle(id), wasm.getTaskTitleLen(id)),
            completed: wasm.getTaskCompleted(id),
            due_date: wasmReadStr(wasm.getTaskDue(id), wasm.getTaskDueLen(id)) || null,
            priority: priorityFromCode(wasm.getTaskPriority(id))
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
            title: t.title, completed: t.completed, due_date: t.due_date, priority: t.priority
        }))));
    } catch (_) { /* ignore */ }
}

function persistAnon() {
    writeSnapshot(wasmGetTasks());
}

// Replay the saved snapshot into the WASM store once, on startup.
function hydrateAnon() {
    if (!wasmReady()) return;
    suppressRender = true;
    wasm.clearAll();
    for (const t of readSnapshot()) {
        const id = wasmAddTask(t.title, t.due_date, t.priority);
        if (id && t.completed) wasm.toggleTask(id);
    }
    suppressRender = false;
}

function getAnonTasks() {
    if (wasmReady()) return wasmGetTasks();
    return readSnapshot().map((t, i) => ({ id: i, ...t }));
}

function anonAdd(title, dueDate, priority) {
    suppressRender = true;
    if (wasmReady()) {
        wasmAddTask(title, dueDate, priority);
        persistAnon();
    } else {
        const snap = readSnapshot();
        snap.push({ title, completed: false, due_date: dueDate, priority });
        writeSnapshot(snap);
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

// ============ MODALS ============

function getOpenModal() {
    return [...document.querySelectorAll('.modal')].find(m => !m.hidden) || null;
}

function showModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    lastFocused = document.activeElement;
    modal.hidden = false;
    const focusables = [...modal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
    (focusables[0] || modal.querySelector('.modal-content')).focus();
}

function hideModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.hidden = true;

    const form = modal.querySelector('form');
    if (form) form.reset();
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
    if (focusables.length === 0) return;
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

// ============ DROPDOWN ============

function dropdownOpen() {
    const menu = document.getElementById('dropdownMenu');
    return menu && !menu.hidden;
}

function setDropdown(open) {
    const btn = document.getElementById('userBtn');
    const menu = document.getElementById('dropdownMenu');
    if (!btn || !menu) return;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
}

function closeDropdown() {
    setDropdown(false);
}

// ============ PROFILE / VERIFICATION ============

function switchProfileTab(tabName, clickedBtn) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
    });
    if (clickedBtn) {
        clickedBtn.classList.add('active');
        clickedBtn.setAttribute('aria-selected', 'true');
    }
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    const target = tabName === 'password' ? 'tabPassword' : 'tabEdit';
    document.getElementById(target).classList.add('active');
}

// ============ AUTH HANDLERS ============

async function handleSignup(e) {
    e.preventDefault();
    const form = e.target;
    const btn = getFormButton(form);
    const name = document.getElementById('signupName').value;
    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPassword').value;
    const errorEl = document.getElementById('signupError');

    setButtonLoading(btn, true);
    try {
        const response = await fetch('/api/auth/signup', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password })
        });
        let data;
        try {
            data = await response.json();
        } catch (_) {
            errorEl.textContent = 'Server returned an invalid response';
            return;
        }
        if (response.ok) {
            currentUser = data.user;
            showLoggedIn(currentUser);
            hideModal('signupModal');
            loadTasks();
            showModal('verifyModal');
            announce('Account created. Check your email for a verification code.');
        } else {
            errorEl.textContent = data.error || 'Signup failed';
        }
    } catch (error) {
        errorEl.textContent = 'Connection error';
    } finally {
        setButtonLoading(btn, false);
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const form = e.target;
    const btn = getFormButton(form);
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');

    setButtonLoading(btn, true);
    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await response.json();
        if (response.ok) {
            currentUser = data.user;
            showLoggedIn(currentUser);
            hideModal('loginModal');
            loadTasks();
            announce('Logged in');
        } else {
            errorEl.textContent = data.error || 'Invalid credentials';
        }
    } catch (error) {
        errorEl.textContent = 'Connection error';
    } finally {
        setButtonLoading(btn, false);
    }
}

async function logout() {
    closeDropdown();
    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include',
            headers: csrfHeaders()
        });
    } catch (_) { /* clear client state anyway */ }
    showLoggedOut();
    loadTasks();
    announce('Logged out');
}

async function handleUpdateProfile(e) {
    e.preventDefault();
    const name = document.getElementById('profileNameInput').value;
    const errorEl = document.getElementById('profileError');
    const successEl = document.getElementById('profileSuccess');
    try {
        const response = await fetch('/api/profile', {
            method: 'PUT',
            credentials: 'include',
            headers: csrfHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name })
        });
        if (response.ok) {
            currentUser = await response.json();
            showLoggedIn(currentUser);
            successEl.classList.remove('hidden');
            errorEl.textContent = '';
            setTimeout(() => successEl.classList.add('hidden'), 3000);
        } else {
            errorEl.textContent = 'Failed to update profile';
        }
    } catch (error) {
        errorEl.textContent = 'Connection error';
    }
}

async function handleChangePassword(e) {
    e.preventDefault();
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const errorEl = document.getElementById('passwordError');
    const successEl = document.getElementById('passwordSuccess');

    if (newPassword !== confirmPassword) {
        errorEl.textContent = 'Passwords do not match';
        return;
    }
    try {
        const response = await fetch('/api/profile/password', {
            method: 'PUT',
            credentials: 'include',
            headers: csrfHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ old_password: currentPassword, new_password: newPassword })
        });
        if (response.ok) {
            successEl.classList.remove('hidden');
            errorEl.textContent = '';
            document.getElementById('passwordForm').reset();
            setTimeout(() => successEl.classList.add('hidden'), 3000);
        } else {
            const data = await response.json();
            errorEl.textContent = data.error || 'Failed to change password';
        }
    } catch (error) {
        errorEl.textContent = 'Connection error';
    }
}

async function handleForgotPassword(e) {
    e.preventDefault();
    const form = e.target;
    const btn = getFormButton(form);
    const email = document.getElementById('forgotEmail').value;
    const errorEl = document.getElementById('forgotError');
    const successEl = document.getElementById('forgotSuccess');

    setButtonLoading(btn, true);
    try {
        await fetch('/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        successEl.classList.remove('hidden');
        errorEl.textContent = '';
        form.reset();
    } catch (error) {
        errorEl.textContent = 'Connection error';
    } finally {
        setButtonLoading(btn, false);
    }
}

function handleCodeKeyup(input, index) {
    if (input.value.length === 1) {
        input.classList.add('filled');
        const next = document.querySelectorAll('.code-input')[index + 1];
        if (next) next.focus();
    } else {
        input.classList.remove('filled');
    }
}

function handleCodeKeydown(e, input, index) {
    if (e.key === 'Backspace' && input.value.length === 0) {
        const prev = document.querySelectorAll('.code-input')[index - 1];
        if (prev) {
            prev.focus();
            prev.value = '';
            prev.classList.remove('filled');
        }
    }
}

async function handleVerifyEmail(e) {
    e.preventDefault();
    const form = e.target;
    const btn = getFormButton(form);
    const inputs = document.querySelectorAll('.code-input');
    let code = '';
    inputs.forEach(input => code += input.value);
    const errorEl = document.getElementById('verifyError');
    const successEl = document.getElementById('verifySuccess');

    if (code.length !== 6) {
        errorEl.textContent = 'Please enter the full 6-digit code';
        return;
    }
    setButtonLoading(btn, true);
    try {
        const response = await fetch('/api/auth/verify', {
            method: 'POST',
            credentials: 'include',
            headers: csrfHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ code })
        });
        if (response.ok) {
            successEl.classList.remove('hidden');
            errorEl.textContent = '';
            announce('Email verified');
            setTimeout(() => {
                hideModal('verifyModal');
                checkAuth();
            }, 1500);
        } else {
            const data = await response.json();
            errorEl.textContent = data.error || 'Verification failed';
        }
    } catch (error) {
        errorEl.textContent = 'Connection error';
    } finally {
        setButtonLoading(btn, false);
    }
}

let resendCooldown = 0;

async function handleResendCode(e) {
    e.preventDefault();
    if (resendCooldown > 0) return;
    const link = document.getElementById('resendLink');
    const timer = document.getElementById('resendTimer');
    const errorEl = document.getElementById('verifyError');

    resendCooldown = 30;
    link.classList.add('hidden');
    timer.classList.remove('hidden');
    timer.textContent = `Resend in ${resendCooldown}s`;

    try {
        const response = await fetch('/api/auth/resend-verification', {
            method: 'POST',
            credentials: 'include',
            headers: csrfHeaders()
        });
        if (response.ok) {
            errorEl.textContent = '';
            timer.textContent = `Code sent · ${resendCooldown}s`;
        } else {
            const data = await response.json();
            errorEl.textContent = data.error || 'Failed to resend code';
        }
    } catch (error) {
        errorEl.textContent = 'Connection error';
    }

    const interval = setInterval(() => {
        resendCooldown--;
        if (resendCooldown > 0) {
            timer.textContent = `Resend in ${resendCooldown}s`;
        } else {
            clearInterval(interval);
            timer.classList.add('hidden');
            link.classList.remove('hidden');
        }
    }, 1000);
}

// ============ TASKS ============

async function loadTasks() {
    let tasks = [];
    if (isLoggedIn()) {
        try {
            const response = await fetch('/api/tasks', { credentials: 'include' });
            tasks = await response.json();
        } catch (error) {
            tasks = [];
        }
    } else {
        tasks = getAnonTasks();
    }
    renderTasks(tasks);
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
        return new Date(dateStr).toLocaleDateString('en-GB', {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
        });
    } catch {
        return dateStr;
    }
}

// SECURITY: every task field is inserted with textContent / setAttribute, so a
// malicious title can never break out into HTML.
function renderTaskItem(task, isCompleted) {
    const li = document.createElement('li');
    li.className = isCompleted ? 'task-item completed' : 'task-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task-checkbox';
    checkbox.dataset.id = task.id;
    checkbox.setAttribute('aria-label', isCompleted ? 'Mark as not done' : 'Mark as done');
    if (isCompleted) checkbox.checked = true;

    const content = document.createElement('div');
    content.className = 'task-content';

    const titleEl = document.createElement('span');
    titleEl.className = 'task-title';
    titleEl.textContent = task.title;
    content.appendChild(titleEl);

    const meta = document.createElement('div');
    meta.className = 'task-meta';

    const priority = task.priority || 'normal';
    if (priority !== 'normal') {
        const priorityEl = document.createElement('span');
        priorityEl.className = `task-priority task-priority-${priority}`;
        priorityEl.textContent = priority === 'high' ? 'High' : 'Low';
        meta.appendChild(priorityEl);
    }
    const createdStr = formatDate(task.created_at);
    if (createdStr) {
        const el = document.createElement('span');
        el.className = 'task-created';
        el.textContent = `🕐 ${createdStr}`;
        meta.appendChild(el);
    }
    const dueStr = task.due_date ? formatDate(task.due_date) : '';
    if (dueStr) {
        const el = document.createElement('span');
        el.className = 'task-due';
        el.textContent = `📅 ${dueStr}`;
        meta.appendChild(el);
    }
    if (meta.childElementCount > 0) content.appendChild(meta);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-delete';
    del.dataset.id = task.id;
    del.setAttribute('aria-label', 'Delete task');
    del.textContent = '🗑️';

    li.append(checkbox, content, del);
    return li;
}

function renderTasks(tasks) {
    const taskList = document.getElementById('taskList');
    const completedTaskList = document.getElementById('completedTaskList');
    const completedSection = document.getElementById('completedSection');
    const emptyState = document.getElementById('emptyState');

    taskList.innerHTML = '';
    completedTaskList.innerHTML = '';

    const activeTasks = tasks.filter(t => !t.completed);
    const completedTasks = tasks.filter(t => t.completed);

    if (activeTasks.length === 0 && completedTasks.length === 0) {
        emptyState.classList.add('visible');
        completedSection.classList.add('hidden');
    } else {
        emptyState.classList.remove('visible');
        activeTasks.forEach(task => taskList.appendChild(renderTaskItem(task, false)));
        if (completedTasks.length > 0) {
            completedSection.classList.remove('hidden');
            completedTasks.forEach(task => completedTaskList.appendChild(renderTaskItem(task, true)));
        } else {
            completedSection.classList.add('hidden');
        }
    }

    document.getElementById('completedCount').textContent = completedTasks.length;
    document.getElementById('totalCount').textContent = tasks.length;
}

async function addTask(title, dueDate = null, priority = 'normal') {
    if (isLoggedIn()) {
        try {
            const taskData = { title, priority };
            if (dueDate) taskData.due_date = dueDate;
            const response = await fetch('/api/tasks', {
                method: 'POST',
                credentials: 'include',
                headers: csrfHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(taskData)
            });
            if (response.ok) loadTasks();
        } catch (error) { /* ignore */ }
    } else {
        anonAdd(title, dueDate, priority);
        loadTasks();
    }
}

async function toggleTask(id) {
    if (isLoggedIn()) {
        try {
            await fetch(`/api/tasks/${id}`, {
                method: 'PUT',
                credentials: 'include',
                headers: csrfHeaders()
            });
            loadTasks();
        } catch (error) { /* ignore */ }
    } else {
        anonToggle(id);
        loadTasks();
    }
}

async function deleteTask(id) {
    if (isLoggedIn()) {
        try {
            await fetch(`/api/tasks/${id}`, {
                method: 'DELETE',
                credentials: 'include',
                headers: csrfHeaders()
            });
            loadTasks();
        } catch (error) { /* ignore */ }
    } else {
        anonDelete(id);
        loadTasks();
    }
}

// ============ WASM ============

async function initWasm() {
    try {
        const importObject = {
            env: {
                js_log: (ptr, len) => {
                    const bytes = new Uint8Array(wasmMemory.buffer, ptr, len);
                    console.log('[WASM]', new TextDecoder().decode(bytes));
                },
                js_renderTasks: () => { if (!suppressRender) loadTasks(); }
            }
        };
        const response = await fetch('/app.wasm');
        if (!response.ok) throw new Error('WASM fetch failed');
        const bytes = await response.arrayBuffer();
        const result = await WebAssembly.instantiate(bytes, importObject);
        wasm = result.instance.exports;
        wasmMemory = wasm.memory;
        wasm.init();
        hydrateAnon();
    } catch (error) {
        console.log('Running without WASM');
    }
}

// ============ EVENT WIRING ============

function bindTaskListClicks(listEl) {
    listEl.addEventListener('click', (e) => {
        const target = e.target;
        const id = target.dataset.id;
        if (!id) return;
        if (target.classList.contains('task-checkbox')) toggleTask(id);
        else if (target.classList.contains('btn-delete')) deleteTask(id);
    });
}

function bindDatePicker() {
    const dueDateInput = document.getElementById('taskDueDate');
    const datePreview = document.getElementById('datePreview');
    const datePickerWrapper = document.querySelector('.date-picker-wrapper');

    function updateDatePreview() {
        if (dueDateInput.value) {
            datePreview.textContent = new Date(dueDateInput.value).toLocaleDateString('en-GB', {
                day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
            });
            datePreview.classList.add('has-date');
            datePickerWrapper.classList.add('has-date');
        } else {
            datePreview.textContent = '';
            datePreview.classList.remove('has-date');
            datePickerWrapper.classList.remove('has-date');
        }
    }

    document.getElementById('datePickerBtn').addEventListener('click', () => {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        dueDateInput.min = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
        dueDateInput.showPicker?.();
    });
    dueDateInput.addEventListener('change', updateDatePreview);
    document.getElementById('dateClearBtn').addEventListener('click', () => {
        dueDateInput.value = '';
        updateDatePreview();
    });
}

function bindActions() {
    document.body.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        const action = el.dataset.action;
        const fromDropdown = !!el.closest('#dropdownMenu');
        switch (action) {
            case 'show-modal': showModal(el.dataset.target); break;
            case 'hide-modal': hideModal(el.dataset.target); break;
            case 'switch-modal': e.preventDefault(); switchModal(el.dataset.from, el.dataset.to); break;
            case 'logout': logout(); break;
            case 'switch-tab': switchProfileTab(el.dataset.tab, el); break;
            case 'verify-now': e.preventDefault(); hideModal('profileModal'); showModal('verifyModal'); break;
            case 'resend-code': handleResendCode(e); break;
        }
        if (fromDropdown) closeDropdown();
    });

    // Theme toggle
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);

    // User dropdown
    const userBtn = document.getElementById('userBtn');
    userBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setDropdown(!dropdownOpen());
    });
    document.addEventListener('click', (e) => {
        if (dropdownOpen() && !e.target.closest('.user-dropdown')) closeDropdown();
    });

    // Global keyboard: Escape closes, Tab traps focus inside modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (dropdownOpen()) { closeDropdown(); return; }
            const open = getOpenModal();
            if (open) hideModal(open.id);
            return;
        }
        if (e.key === 'Tab') {
            const open = getOpenModal();
            if (open) trapFocus(e, open);
        }
    });

    // Forms
    const forms = {
        loginForm: handleLogin,
        signupForm: handleSignup,
        verifyForm: handleVerifyEmail,
        forgotForm: handleForgotPassword,
        profileForm: handleUpdateProfile,
        passwordForm: handleChangePassword
    };
    for (const [id, handler] of Object.entries(forms)) {
        const form = document.getElementById(id);
        if (form) form.addEventListener('submit', handler);
    }

    // Add-task form
    const taskForm = document.getElementById('taskForm');
    const taskInput = document.getElementById('taskInput');
    const taskPriority = document.getElementById('taskPriority');
    taskForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const title = taskInput.value.trim();
        if (!title) return;
        const dueDateInput = document.getElementById('taskDueDate');
        const dueDate = dueDateInput.value || null;
        const priority = taskPriority ? taskPriority.value : 'normal';
        addTask(title, dueDate, priority);
        taskInput.value = '';
        if (taskPriority) taskPriority.value = 'normal';
        dueDateInput.value = '';
        document.getElementById('dateClearBtn').click();
        taskInput.focus();
    });

    // Verification-code inputs
    document.querySelectorAll('.code-input').forEach((input) => {
        const index = parseInt(input.dataset.codeIndex || '0', 10);
        input.addEventListener('keyup', () => handleCodeKeyup(input, index));
        input.addEventListener('keydown', (e) => handleCodeKeydown(e, input, index));
    });

    bindTaskListClicks(document.getElementById('taskList'));
    bindTaskListClicks(document.getElementById('completedTaskList'));
    bindDatePicker();
}

// ============ INIT ============

document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    bindActions();
    await initWasm();
    await checkAuth();
    loadTasks();
});
