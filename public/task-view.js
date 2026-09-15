// Signed-in main view: one root page and one optional child page, never a
// full-workspace task cache. Loaded after app.js, before DOMContentLoaded.
'use strict';
const mainView = { context: '', controls: null, input: null, data: null, page: 0, cursors: [null], next: null, asOf: null, focus: null, savedFocus: null, child: null, childGeneration: 0, childAbort: null, timer: null };
let csvAbort = null;

function clearMainChildren() {
    mainView.childGeneration++; mainView.childAbort?.abort(); mainView.childAbort = null;
    mainView.child = null; state.tasks = state.tasks.filter(task => !task.parent_id);
}
function resetMainView() {
    clearTimeout(mainView.timer); mainView.timer = null; clearMainChildren();
    Object.assign(mainView, { context: '', controls: null, input: null, data: null, page: 0, cursors: [null], next: null, asOf: null, focus: null, savedFocus: null });
    csvAbort?.abort();
}
function mainControls() {
    return { search: state.search, filter: state.filter, tagFilter: state.tagFilter, sort: state.sort, view: state.view };
}
function mainContext() {
    const day = new Date(); day.setHours(0, 0, 0, 0);
    return JSON.stringify([state.user?.id, state.currentWorkspaceId, mainControls(), mainView.focus, day.getTime()]);
}
function leaveMainDrafts() {
    if ([...taskDrafts.values()].some(draft => draft.dirty) && !window.confirm('Discard unsaved task edits and change the task page or filters?')) return false;
    taskDrafts.clear(); state.editingId = null; state.addingSubtaskFor = null; state.selection.clear(); return true;
}
function prepareMainView() {
    if (!isLoggedIn() || !state.currentWorkspaceId || mainView.context === mainContext()) return;
    if (mainView.controls && !leaveMainDrafts()) { Object.assign(state, mainView.controls); mainView.focus = mainView.savedFocus; syncSavedViews(); return; }
    cancelTaskLoad(); clearMainChildren(); clearTimeout(mainView.timer);
    mainView.context = mainContext(); mainView.controls = mainControls();
    mainView.savedFocus = mainView.focus;
    mainView.data = null; mainView.input = null; mainView.cursors = [null]; mainView.page = 0; mainView.next = null; mainView.asOf = null;
    state.tasks = []; $('taskLoadError').classList.add('hidden'); setLoading(true);
    // Debounce typing, but mark old rows unavailable immediately.
    mainView.timer = setTimeout(() => loadTasks(), 250);
}
function mainInput() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const upcoming = new Date(today); upcoming.setDate(upcoming.getDate() + 8);
    const query = { workspace_id: state.currentWorkspaceId, q: state.search.trim(), sort: state.sort, tag: state.tagFilter || '', limit: 50 };
    if (state.filter === 'active') query.status = 'active';
    if (state.filter === 'completed') query.status = 'done';
    if (state.filter === 'high') { query.priority = 'high'; query.status = 'active'; }
    if (state.filter === 'overdue') query.due = 'overdue';
    if (['today', 'upcoming'].includes(state.filter)) Object.assign(query, { status: 'active', due: 'range', due_from: state.filter === 'today' ? +today : +tomorrow, due_before: state.filter === 'today' ? +tomorrow : +upcoming });
    return { query, active_first: state.view === 'list' && state.filter === 'all', focus_id: mainView.focus, today: +today, tomorrow: +tomorrow, upcoming: +upcoming };
}
function validMainPage(data, child = false) {
    return data && Array.isArray(data.items) && data.items.length <= 50 &&
        new Set(data.items.map(task => task?.id)).size === data.items.length &&
        data.items.every(task => typeof task?.id === 'string' && typeof task.title === 'string' && Number.isSafeInteger(task.version) && task.version >= 0 && (child ? !!task.parent_id : !task.parent_id)) &&
        Number.isSafeInteger(data.as_of) && data.as_of > 0 && Number.isSafeInteger(data.matched) && data.matched >= 0 &&
        (data.next_cursor === null || (typeof data.next_cursor === 'string' && data.next_cursor.length <= 8192 && data.items.length > 0)) &&
        (child || (data.counts && ['total','done','overdue','high','today','upcoming'].every(key => Number.isSafeInteger(data.counts[key]) && data.counts[key] >= 0) &&
        Array.isArray(data.tags) && data.tags.length <= 50 && data.tags.every(row => typeof row.tag === 'string' && Number.isSafeInteger(row.count)) &&
        Array.isArray(data.children) && data.children.length <= 51 && data.children.every(row => typeof row.parent_id === 'string' && Number.isSafeInteger(row.total) && Number.isSafeInteger(row.done))));
}
async function readMainPage(body, signal) {
    return api('/api/tasks/view', { method: 'POST', body, quiet: true, signal });
}
async function loadMainTasks(options = {}) {
    syncSavedViews(); prepareMainView(); clearTimeout(mainView.timer); mainView.timer = null;
    cancelTaskLoad();
    if (!state.currentWorkspaceId) { resetMainView(); state.tasks = []; $('taskLoadError').classList.remove('hidden'); renderTasks(); return false; }
    const page = Number.isInteger(options.page) ? options.page : 0;
    if (page < 0 || page >= 200 || (page && !mainView.cursors[page])) return false;
    const user = state.user, workspace = state.currentWorkspaceId, context = mainView.context, generation = taskLoadGeneration;
    const controller = taskLoadAbort = new AbortController();
    const current = () => state.user === user && state.currentWorkspaceId === workspace && mainView.context === context && mainContext() === context && taskLoadGeneration === generation;
    const input = options.page !== undefined && mainView.input ? mainView.input : mainInput();
    const body = { ...input, query: { ...input.query, ...(options.page !== undefined ? { cursor: mainView.cursors[page], as_of: mainView.asOf } : {}) } };
    setLoading(true); $('taskLoadStatus').textContent = 'Loading one task page and server totals…'; $('taskLoadError').classList.add('hidden');
    const timeout = setTimeout(() => controller.abort(), 15000);
    let loaded = false;
    try {
        const result = await readMainPage(body, controller.signal);
        if (!current()) return false;
        if ([403,404].includes(result.status)) { clearMainChildren(); mainView.data = null; state.tasks = []; taskDrafts.clear(); state.editingId = null; state.selection.clear(); resetWorkspacePanel(true); resetTrash(); resetUsage(true); }
        const data = result.data;
        if (!result.ok || !validMainPage(data) || (body.query.as_of && data.as_of !== body.query.as_of)) return false;
        // A refresh must not silently hide an editor whose row moved or was
        // removed remotely. Keep the old page explicitly stale until resolved.
        if ([...taskDrafts.entries()].some(([id, draft]) => draft.dirty && !data.items.some(task => task.id === id))) return false;
        clearMainChildren(); mainView.data = data; mainView.input = input; mainView.page = page; mainView.asOf = data.as_of; mainView.next = data.next_cursor;
        mainView.cursors = options.page === undefined ? [null] : mainView.cursors.slice(0, page + 1);
        if (data.next_cursor) mainView.cursors[page + 1] = data.next_cursor;
        state.tasks = data.items; state.taskPage = page;
        state.selection = new Set([...state.selection].filter(id => state.tasks.some(task => task.id === id)));
        loaded = true; return true;
    } finally {
        clearTimeout(timeout);
        if (current()) { taskLoadAbort = null; setLoading(false); $('taskLoadError').classList.toggle('hidden', loaded); renderTasks(); }
    }
}
async function changeMainPage(delta) {
    if (state.loading || !leaveMainDrafts()) return;
    await loadTasks({ page: mainView.page + delta }); $('taskPageStatus').focus();
}
function mainProgress(id) {
    const row = mainView.data?.children.find(row => row.parent_id === id);
    return row?.total ? { total: row.total, done: row.done } : null;
}
async function loadMainChildren(parent, page = 0, focus = null) {
    if (!isLoggedIn() || !state.tasks.some(task => task.id === parent && !task.parent_id) || page < 0 || page >= 200) return false;
    const old = mainView.child?.parent === parent ? mainView.child : null;
    if (page && !old?.cursors[page]) return false;
    mainView.childAbort?.abort(); const controller = mainView.childAbort = new AbortController();
    const generation = ++mainView.childGeneration, user = state.user, rootGeneration = taskLoadGeneration;
    const child = mainView.child = old || { parent, page: 0, cursors: [null], next: null, matched: 0, focus, error: false };
    if (!old) state.tasks = state.tasks.filter(task => !task.parent_id);
    child.busy = true; child.error = false; renderTasks();
    const current = () => state.user === user && mainView.childGeneration === generation && taskLoadGeneration === rootGeneration && mainView.child === child;
    const input = mainView.input || mainInput();
    const body = { today: input.today, tomorrow: input.tomorrow, upcoming: input.upcoming, parent_id: parent, focus_id: focus, query: { workspace_id: state.currentWorkspaceId, sort: 'created_asc', limit: 50, as_of: mainView.asOf, cursor: page ? child.cursors[page] : null } };
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const result = await readMainPage(body, controller.signal);
        if (!current()) return false;
        if ([403,404].includes(result.status)) { state.tasks = []; mainView.data = null; taskDrafts.clear(); state.editingId = null; state.addingSubtaskFor = null; state.selection.clear(); resetWorkspacePanel(true); resetTrash(); resetUsage(true); $('taskLoadError').classList.remove('hidden'); }
        if (!result.ok || !validMainPage(result.data, true) || result.data.as_of !== mainView.asOf || result.data.items.some(task => task.parent_id !== parent)) { child.error = true; return false; }
        const data = result.data;
        state.tasks = [...state.tasks.filter(task => !task.parent_id), ...data.items];
        Object.assign(child, { page, focus, next: data.next_cursor, matched: data.matched, cursors: page ? child.cursors.slice(0, page + 1) : [null] });
        if (data.next_cursor) child.cursors[page + 1] = data.next_cursor;
        return true;
    } finally { clearTimeout(timeout); if (current()) { mainView.childAbort = null; child.busy = false; renderTasks(); document.querySelector(`[data-parent-page="${CSS.escape(parent)}"]`)?.focus(); } }
}
function renderMainChildren(task, content) {
    const progress = mainProgress(task.id), child = mainView.child?.parent === task.id ? mainView.child : null;
    if (!progress && !child) return;
    if (!child) { content.append(iconButton(`Show ${progress.total} subtasks`, 'Show subtasks', 'btn btn-ghost btn-sm', { act: 'show-subtasks', id: task.id })); return; }
    const list = document.createElement('ul'); list.className = 'subtask-list';
    for (const row of subtasksOf(task.id)) list.append(renderSubtask(row));
    content.append(list);
    const nav = document.createElement('div'); nav.className = 'task-pagination';
    const status = badge(child.busy ? 'Loading subtasks…' : child.error ? 'Subtasks unavailable. Refresh to retry; any retained page may be stale.' : child.focus ? 'Selected subtask' : `${child.matched ? child.page * 50 + 1 : 0}–${Math.min(child.page * 50 + 50, child.matched)} of ${child.matched} subtasks`, 'pagination-status');
    status.tabIndex = -1; status.dataset.parentPage = task.id; status.setAttribute('role', 'status'); nav.append(status);
    for (const [label, action, delta, disabled] of [
        ['Previous subtasks','page-subtasks',-1,child.page === 0 || child.busy], ['Next subtasks','page-subtasks',1,!child.next || child.page >= 199 || child.busy],
        [child.focus ? 'Show all subtasks' : 'Refresh subtasks','show-subtasks',0,child.busy], ['Hide subtasks','hide-subtasks',0,false],
    ]) { const btn = iconButton(label, label, 'btn btn-ghost btn-sm', { act: action, id: task.id, delta }); btn.disabled = disabled; nav.append(btn); }
    content.append(nav);
}
async function openMainTask(task) {
    const user = state.user;
    if (!leaveMainDrafts()) return;
    const workspace = task.workspace_id || state.currentWorkspaceId;
    if (!workspace) return;
    hideModal('taskSearchModal');
    if (state.currentWorkspaceId !== workspace) await switchWorkspace(workspace);
    if (state.user !== user) return;
    state.search = ''; state.filter = 'all'; state.tagFilter = null; state.activeSavedView = ''; state.view = 'list'; state.completedCollapsed = false;
    mainView.focus = task.parent_id || task.id;
    renderTasks();
    if (!await loadTasks() || !state.tasks.some(row => row.id === mainView.focus)) { toast('Task or parent is no longer available. Refresh the workspace.', 'error'); return; }
    if (task.parent_id && !await loadMainChildren(task.parent_id, 0, task.id)) { toast('Subtask is no longer available.', 'error'); return; }
    const target = [...document.querySelectorAll('[data-act="toggle"]')].find(el => el.dataset.id === task.id)?.closest('li');
    if (target) { target.tabIndex = -1; target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }
}

async function downloadCompleteCsv() {
    if (csvAbort) { csvAbort.abort(); return; }
    const controller = csvAbort = new AbortController(), user = state.user, workspace = state.currentWorkspaceId;
    const current = () => csvAbort === controller && !controller.signal.aborted && state.user === user && state.currentWorkspaceId === workspace;
    const button = $('exportCsvBtn'), label = button.textContent;
    const chunks = [tasksAsCsv([])], seen = new Set(); let cursor = null, asOf = null, bytes = chunks[0].length;
    button.textContent = 'Cancel CSV export';
    try {
        do {
            const query = new URLSearchParams({ page: '1', workspace_id: workspace });
            if (cursor) { query.set('cursor', cursor); query.set('as_of', String(asOf)); }
            const timeout = setTimeout(() => controller.abort(), 15000);
            let result; try { result = await api(`/api/tasks?${query}`, { quiet: true, signal: controller.signal }); } finally { clearTimeout(timeout); }
            if (!current()) throw new Error('CSV export cancelled; no partial file downloaded.');
            const data = result.data;
            if (!result.ok || !Array.isArray(data?.items) || data.items.length > 100 || !Number.isSafeInteger(data.as_of) || (asOf !== null && data.as_of !== asOf)) throw new Error(data?.error || 'CSV page unavailable; no partial file downloaded.');
            if (!(data.next_cursor === null || (data.items.length && data.next_cursor === data.items.at(-1).id))) throw new Error('Invalid CSV continuation.');
            asOf = data.as_of;
            for (const task of data.items) { if (typeof task?.id !== 'string' || seen.has(task.id) || (cursor && task.id >= cursor)) throw new Error('Invalid CSV page.'); seen.add(task.id); }
            const chunk = tasksAsCsv(data.items).split('\r\n').slice(1).join('\r\n');
            bytes += new TextEncoder().encode(chunk).length + 2;
            if (bytes > 64 * 1024 * 1024 || seen.size > 100000) throw new Error('CSV exceeds the browser export budget (64 MiB / 100,000 tasks). Contact the operator for a larger export.');
            if (chunk) chunks.push(chunk);
            cursor = data.next_cursor;
        } while (cursor);
        if (current()) { saveCsv(chunks.join('\r\n')); toast(`Complete workspace CSV prepared (${seen.size} tasks).`, 'success'); }
    } catch (error) { if (state.user === user && state.currentWorkspaceId === workspace) toast(error.message, 'error'); }
    finally { if (csvAbort === controller) csvAbort = null; button.textContent = label; }
}
