// Zig Task Manager - JavaScript with Auth
// Logged users: tasks in DB | Anonymous: tasks in localStorage

let wasm = null;
let wasmMemory = null;
let currentUser = null;

// DOM Elements
const taskForm = document.getElementById('taskForm');
const taskInput = document.getElementById('taskInput');
const taskList = document.getElementById('taskList');
const emptyState = document.getElementById('emptyState');
const totalCount = document.getElementById('totalCount');
const completedCount = document.getElementById('completedCount');
const authButtons = document.getElementById('authButtons');
const userMenu = document.getElementById('userMenu');
const userName = document.getElementById('userName');
const userEmail = document.getElementById('userEmail');
const userAvatar = document.getElementById('userAvatar');

// ============ AUTH FUNCTIONS ============

// Loading state helpers - prevent double-submit on buttons
function setButtonLoading(btn, loading) {
    if (!btn) return;
    console.log('🔄 Button loading state:', loading, 'Button text:', btn.textContent);
    if (loading) {
        btn.dataset.originalText = btn.textContent;
        btn.textContent = 'Loading...';
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

function getToken() {
    return localStorage.getItem('token');
}

function setToken(token) {
    localStorage.setItem('token', token);
}

function removeToken() {
    localStorage.removeItem('token');
}

function isLoggedIn() {
    return currentUser !== null;
}

async function checkAuth() {
    const token = getToken();
    if (!token) {
        showLoggedOut();
        return;
    }

    try {
        const response = await fetch('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            currentUser = await response.json();
            showLoggedIn(currentUser);
        } else {
            removeToken();
            showLoggedOut();
        }
    } catch (error) {
        console.error('Auth check failed:', error);
        showLoggedOut();
    }
}

function showLoggedIn(user) {
    authButtons.classList.add('hidden');
    userMenu.classList.remove('hidden');
    userName.textContent = user.name;
    userEmail.textContent = user.email;
    userAvatar.textContent = user.name.charAt(0).toUpperCase();

    // Update Profile Modal
    document.getElementById('profileName').textContent = user.name;
    document.getElementById('profileEmail').textContent = user.email;
    document.getElementById('profileAvatar').textContent = user.name.charAt(0).toUpperCase();
    document.getElementById('profileNameInput').value = user.name;

    const badge = document.getElementById('profileVerified');
    if (user.email_verified) {
        badge.innerHTML = '<span class="badge badge-success">✅ Verified</span>';
    } else {
        badge.innerHTML = `
            <span class="badge badge-warning">⚠️ Not Verified</span>
            <a href="#" onclick="showModal('verifyModal'); hideModal('profileModal')" style="font-size: 0.8rem; margin-left: 0.5rem; color: var(--accent-primary)">Verify Now</a>
        `;
    }
}

function showLoggedOut() {
    currentUser = null;
    authButtons.classList.remove('hidden');
    userMenu.classList.add('hidden');
}

// ============ LOCAL STORAGE TASKS ============

function getLocalTasks() {
    const stored = localStorage.getItem('localTasks');
    return stored ? JSON.parse(stored) : [];
}

function saveLocalTasks(tasks) {
    localStorage.setItem('localTasks', JSON.stringify(tasks));
}

function addLocalTask(title) {
    const tasks = getLocalTasks();
    const newTask = {
        id: Date.now(),
        title: title,
        completed: false
    };
    tasks.push(newTask);
    saveLocalTasks(tasks);
    return newTask;
}

function toggleLocalTask(id) {
    const tasks = getLocalTasks();
    const task = tasks.find(t => t.id === id);
    if (task) {
        task.completed = !task.completed;
        saveLocalTasks(tasks);
    }
}

function deleteLocalTask(id) {
    let tasks = getLocalTasks();
    tasks = tasks.filter(t => t.id !== id);
    saveLocalTasks(tasks);
}

// ============ MODAL FUNCTIONS ============

function showModal(id) {
    document.getElementById(id).classList.add('active');
}

function hideModal(id) {
    const modal = document.getElementById(id);
    modal.classList.remove('active');
    
    // Reset any forms in the modal
    const form = modal.querySelector('form');
    if (form) form.reset();
    
    const error = modal.querySelector('.form-error');
    if (error) error.textContent = '';
    const success = modal.querySelector('.form-success');
    if (success) success.classList.add('hidden');
}

function switchModal(fromId, toId) {
    hideModal(fromId);
    showModal(toId);
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
        console.log('📤 Sending signup request...');
        const response = await fetch('/api/auth/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password })
        });

        console.log('📥 Response status:', response.status);
        const text = await response.text();
        console.log('📥 Response text:', text);
        
        let data;
        try {
            data = JSON.parse(text);
        } catch (parseError) {
            console.error('❌ JSON parse error:', parseError);
            errorEl.textContent = 'Server returned invalid response';
            return;
        }

        if (response.ok) {
            setToken(data.token);
            currentUser = data.user;
            showLoggedIn(currentUser);
            hideModal('signupModal');
            loadTasks();
            
            // Show verify modal
            showModal('verifyModal');
        } else {
            errorEl.textContent = data.error || 'Signup failed';
        }
    } catch (error) {
        console.error('❌ Signup error:', error);
        errorEl.textContent = 'Connection error: ' + error.message;
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (response.ok) {
            setToken(data.token);
            currentUser = data.user;
            showLoggedIn(currentUser);
            hideModal('loginModal');
            document.getElementById('loginForm').reset();
            loadTasks();
        } else {
            errorEl.textContent = data.error || 'Invalid credentials';
        }
    } catch (error) {
        errorEl.textContent = 'Connection error';
    } finally {
        setButtonLoading(btn, false);
    }
}

function logout() {
    removeToken();
    showLoggedOut();
    loadTasks(); // Will now load from localStorage
}

// ============ PROFILE & VERIFICATION HANDLERS ============

function switchProfileTab(tabName) {
    // Buttons
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
    
    // Content
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    if (tabName === 'edit') {
        document.getElementById('tabEdit').classList.add('active');
    } else if (tabName === 'password') {
        document.getElementById('tabPassword').classList.add('active');
    }
}

async function handleUpdateProfile(e) {
    e.preventDefault();
    const name = document.getElementById('profileNameInput').value;
    const errorEl = document.getElementById('profileError');
    const successEl = document.getElementById('profileSuccess');
    
    try {
        const response = await fetch('/api/profile', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getToken()}`
            },
            body: JSON.stringify({ name })
        });
        
        if (response.ok) {
            const user = await response.json();
            currentUser = user;
            showLoggedIn(user); // Update UI
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
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getToken()}`
            },
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
        const response = await fetch('/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        
        // Always show success
        successEl.classList.remove('hidden');
        errorEl.textContent = '';
        document.getElementById('forgotForm').reset();
    } catch (error) {
        errorEl.textContent = 'Connection error';
    } finally {
        setButtonLoading(btn, false);
    }
}

// Verification Code Logic
function handleCodeInput(input, index) {
    // Auto-focus next input
    if (input.value.length === 1) {
        input.classList.add('filled');
        const next = document.querySelectorAll('.code-input')[index + 1];
        if (next) next.focus();
    } else {
        input.classList.remove('filled');
    }
    
    // Handle backspace
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && input.value.length === 0) {
            const prev = document.querySelectorAll('.code-input')[index - 1];
            if (prev) {
                prev.focus();
                prev.value = '';
                prev.classList.remove('filled');
            }
        }
    });
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        
        if (response.ok) {
            successEl.classList.remove('hidden');
            errorEl.textContent = '';
            setTimeout(() => {
                hideModal('verifyModal');
                // Refresh user data
                checkAuth();
            }, 2000);
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

// Resend verification code with cooldown
let resendCooldown = 0;

async function handleResendCode(e) {
    e.preventDefault();
    if (resendCooldown > 0) return;
    
    const link = document.getElementById('resendLink');
    const timer = document.getElementById('resendTimer');
    const errorEl = document.getElementById('verifyError');
    
    // Start 30s cooldown
    resendCooldown = 30;
    link.classList.add('hidden');
    timer.classList.remove('hidden');
    timer.textContent = `Resend in ${resendCooldown}s`;
    
    try {
        const response = await fetch('/api/auth/resend-verification', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${getToken()}` }
        });
        
        if (response.ok) {
            errorEl.textContent = '';
            timer.textContent = `Code sent! Resend in ${resendCooldown}s`;
        } else {
            const data = await response.json();
            errorEl.textContent = data.error || 'Failed to resend code';
        }
    } catch (error) {
        errorEl.textContent = 'Connection error';
    }
    
    // Countdown timer
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

// ============ TASK FUNCTIONS ============

async function loadTasks() {
    let tasks = [];

    if (isLoggedIn()) {
        // Logged in: get from API
        try {
            const response = await fetch('/api/tasks', {
                headers: { 'Authorization': `Bearer ${getToken()}` }
            });
            tasks = await response.json();
        } catch (error) {
            console.error('Failed to load tasks from API:', error);
            tasks = [];
        }
    } else {
        // Anonymous: get from localStorage
        tasks = getLocalTasks();
    }

    renderTasks(tasks);
}

function renderTasks(tasks) {
    taskList.innerHTML = '';
    
    // Get completed task list element
    const completedTaskList = document.getElementById('completedTaskList');
    const completedSection = document.getElementById('completedSection');
    completedTaskList.innerHTML = '';
    
    // Date formatting helper
    function formatDate(dateStr) {
        if (!dateStr) return '';
        try {
            const date = new Date(dateStr);
            return date.toLocaleDateString('ro-RO', { 
                day: '2-digit', 
                month: 'short',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch {
            return dateStr;
        }
    }
    
    // Separate active and completed tasks
    const activeTasks = tasks.filter(t => !t.completed);
    const completedTasks = tasks.filter(t => t.completed);
    
    if (activeTasks.length === 0 && completedTasks.length === 0) {
        emptyState.classList.add('visible');
        completedSection.style.display = 'none';
    } else {
        emptyState.classList.remove('visible');
        
        // Render active tasks
        activeTasks.forEach(task => {
            const li = document.createElement('li');
            li.className = 'task-item';
            
            const createdDate = formatDate(task.created_at);
            const dueDate = task.due_date ? formatDate(task.due_date) : '';
            const dueDateHtml = dueDate ? `<span class="task-due">📅 ${dueDate}</span>` : '';
            const createdHtml = createdDate ? `<span class="task-created">🕐 ${createdDate}</span>` : '';
            
            li.innerHTML = `
                <input type="checkbox" class="task-checkbox" data-id="${task.id}">
                <div class="task-content">
                    <span class="task-title">${escapeHtml(task.title)}</span>
                    <div class="task-meta">${createdHtml}${dueDateHtml}</div>
                </div>
                <button class="btn-delete" data-id="${task.id}" title="Delete task">🗑️</button>
            `;
            taskList.appendChild(li);
        });
        
        // Render completed tasks
        if (completedTasks.length > 0) {
            completedSection.style.display = 'block';
            completedTasks.forEach(task => {
                const li = document.createElement('li');
                li.className = 'task-item completed';
                
                const createdDate = formatDate(task.created_at);
                const dueDate = task.due_date ? formatDate(task.due_date) : '';
                const createdHtml = createdDate ? `<span class="task-created">🕐 ${createdDate}</span>` : '';
                const dueDateHtml = dueDate ? `<span class="task-due">📅 ${dueDate}</span>` : '';
                
                li.innerHTML = `
                    <input type="checkbox" class="task-checkbox" checked data-id="${task.id}">
                    <div class="task-content">
                        <span class="task-title">${escapeHtml(task.title)}</span>
                        <div class="task-meta">${createdHtml}${dueDateHtml}</div>
                    </div>
                    <button class="btn-delete" data-id="${task.id}" title="Delete task">🗑️</button>
                `;
                completedTaskList.appendChild(li);
            });
        } else {
            completedSection.style.display = 'none';
        }

        completedCount.textContent = completedTasks.length;
    }
    
    totalCount.textContent = tasks.length;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function addTask(title, dueDate = null) {
    if (isLoggedIn()) {
        // Logged in: save to API
        try {
            const taskData = { title };
            if (dueDate) {
                taskData.due_date = dueDate;
            }
            
            const response = await fetch('/api/tasks', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`
                },
                body: JSON.stringify(taskData)
            });

            if (response.ok) {
                loadTasks();
            }
        } catch (error) {
            console.error('Failed to add task:', error);
        }
    } else {
        // Anonymous: save to localStorage
        addLocalTask(title);
        loadTasks();
    }
}

async function toggleTask(id) {
    if (isLoggedIn()) {
        try {
            await fetch(`/api/tasks/${id}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${getToken()}` }
            });
            loadTasks();
        } catch (error) {
            console.error('Failed to toggle task:', error);
        }
    } else {
        toggleLocalTask(id);
        loadTasks();
    }
}

async function deleteTask(id) {
    if (isLoggedIn()) {
        try {
            await fetch(`/api/tasks/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${getToken()}` }
            });
            loadTasks();
        } catch (error) {
            console.error('Failed to delete task:', error);
        }
    } else {
        deleteLocalTask(id);
        loadTasks();
    }
}

// ============ WASM INIT ============

async function initWasm() {
    try {
        const importObject = {
            env: {
                js_log: (ptr, len) => {
                    const bytes = new Uint8Array(wasmMemory.buffer, ptr, len);
                    console.log('[WASM]', new TextDecoder().decode(bytes));
                },
                js_renderTasks: () => loadTasks(),
                js_alert: (ptr, len) => {
                    const bytes = new Uint8Array(wasmMemory.buffer, ptr, len);
                    alert(new TextDecoder().decode(bytes));
                }
            }
        };

        const response = await fetch('/app.wasm');
        if (!response.ok) throw new Error('WASM fetch failed');
        
        const bytes = await response.arrayBuffer();
        const result = await WebAssembly.instantiate(bytes, importObject);
        
        wasm = result.instance.exports;
        wasmMemory = wasm.memory;
        wasm.init();
        
        console.log('✅ WASM initialized');
    } catch (error) {
        console.log('Running without WASM');
    }
}

// ============ EVENT LISTENERS ============

// Date picker functionality
const datePickerBtn = document.getElementById('datePickerBtn');
const dateClearBtn = document.getElementById('dateClearBtn');
const datePreview = document.getElementById('datePreview');
const datePickerWrapper = document.querySelector('.date-picker-wrapper');

function updateDatePreview() {
    const dueDateInput = document.getElementById('taskDueDate');
    if (dueDateInput.value) {
        const date = new Date(dueDateInput.value);
        const formatted = date.toLocaleDateString('ro-RO', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
        });
        datePreview.textContent = formatted;
        datePreview.classList.add('has-date');
        datePickerWrapper.classList.add('has-date');
    } else {
        datePreview.textContent = '';
        datePreview.classList.remove('has-date');
        datePickerWrapper.classList.remove('has-date');
    }
}

function clearDatePicker() {
    const dueDateInput = document.getElementById('taskDueDate');
    dueDateInput.value = '';
    updateDatePreview();
}

// Open native picker on button click
datePickerBtn.addEventListener('click', () => {
    const dueDateInput = document.getElementById('taskDueDate');
    
    // Set minimum date to now (prevent past dates)
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    dueDateInput.min = `${year}-${month}-${day}T${hours}:${minutes}`;
    
    dueDateInput.showPicker();
});

// Update preview when date changes
document.getElementById('taskDueDate').addEventListener('change', updateDatePreview);

// Clear date
dateClearBtn.addEventListener('click', clearDatePicker);

taskForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = taskInput.value.trim();
    if (!title) return;
    
    const dueDateInput = document.getElementById('taskDueDate');
    const dueDate = dueDateInput.value || null;
    
    addTask(title, dueDate);
    taskInput.value = '';
    clearDatePicker();
    taskInput.focus();
});

taskList.addEventListener('click', (e) => {
    const target = e.target;
    const id = target.dataset.id;  // Use string ID directly for SurrealDB
    
    if (!id) return;  // No ID on this element
    
    if (target.classList.contains('task-checkbox')) {
        toggleTask(id);
    } else if (target.classList.contains('btn-delete')) {
        deleteTask(id);
    }
});

// Also handle click events on completed task list
document.getElementById('completedTaskList').addEventListener('click', (e) => {
    const target = e.target;
    const id = target.dataset.id;
    
    if (!id) return;
    
    if (target.classList.contains('task-checkbox')) {
        toggleTask(id);
    } else if (target.classList.contains('btn-delete')) {
        deleteTask(id);
    }
});

// ============ INIT ============

document.addEventListener('DOMContentLoaded', async () => {
    await initWasm();
    await checkAuth();
    loadTasks();
});
