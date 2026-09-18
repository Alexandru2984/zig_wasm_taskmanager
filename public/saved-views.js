// Personal workspace preferences. No automatic upload of browser-only data,
// no automatic write retries, no task cache or cross-account local cloud cache.
'use strict';
const savedViewSync = { generation: 0, controller: null, ready: false, busy: false, membership: null, version: 0, message: '' };
const pendingViewWrites = new Set();
function resetSavedViewSync() {
    savedViewSync.generation++; savedViewSync.controller?.abort();
    Object.assign(savedViewSync, { controller: null, ready: false, busy: false, membership: null, version: 0, message: '' });
}
function validCloudView(view) {
    const safe = (value, max) => typeof value === 'string' && new TextEncoder().encode(value).length <= max && !/[\u0000-\u001f\u007f]/.test(value);
    return view && typeof view.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(view.id) &&
        safe(view.name, 192) && view.name.replace(/ /g, '').length > 0 && [...view.name].length <= 48 &&
        safe(view.search, 500) && (view.tagFilter === null || safe(view.tagFilter, 128)) &&
        VIEW_FILTERS.includes(view.filter) && VIEW_SORTS.includes(view.sort) && ['list','board'].includes(view.view);
}
function validViewEnvelope(data) {
    return data && typeof data.membership_id === 'string' && /^workspace_members:[A-Za-z0-9_-]+$/.test(data.membership_id) &&
        Number.isSafeInteger(data.version) && data.version >= 0 && Array.isArray(data.items) && data.items.length <= 12 &&
        data.items.every(validCloudView) && new Set(data.items.map(item => item.id)).size === data.items.length;
}
function deviceViews() {
    try { const items = JSON.parse(localStorage.getItem(viewStorageKey()) || '[]'); return Array.isArray(items) ? items : null; }
    catch (_) { return null; }
}
function renderSavedViewSync() {
    const remote = !!state.user, scoped = remote && !!state.currentWorkspaceId;
    const blocked = remote && (!scoped || !savedViewSync.ready || savedViewSync.busy || pendingViewWrites.has(viewStorageKey()));
    $('saveViewForm').querySelector('button[type="submit"]').disabled = blocked;
    $('deleteViewBtn').disabled = blocked || !state.activeSavedView;
    $('savedViews').disabled = remote && (savedViewSync.busy || !savedViewSync.ready);
    $('refreshViewsBtn').classList.toggle('hidden', !scoped);
    $('refreshViewsBtn').disabled = savedViewSync.busy || pendingViewWrites.has(viewStorageKey());
    const local = remote ? deviceViews() : [];
    $('importViewsBtn').classList.toggle('hidden', !scoped || (local !== null && !local.length));
    $('importViewsBtn').disabled = blocked;
    $('savedViewsHint').textContent = remote
        ? 'Private to your account in this workspace, across devices. Refresh to load changes from another device. Up to 12 views; dates follow each device’s timezone.'
        : 'Guest views stay on this device. Signing in does not upload them.';
    $('savedViewsStatus').textContent = remote ? (scoped ? savedViewSync.message : 'Choose a workspace to sync personal views.') : '';
}
function savedViewScope() {
    const key = viewStorageKey(), user = state.user?.id, workspace = state.currentWorkspaceId, generation = savedViewSync.generation;
    return { key, workspace, current: () => generation === savedViewSync.generation && state.user?.id === user && viewStorageKey() === key };
}
async function refreshSavedViews() {
    if (!state.user || !state.currentWorkspaceId || savedViewSync.busy || pendingViewWrites.has(viewStorageKey())) return;
    savedViewSync.generation++; const scope = savedViewScope();
    savedViewSync.controller?.abort(); const controller = savedViewSync.controller = new AbortController();
    savedViewSync.busy = true; savedViewSync.ready = false; savedViewSync.message = 'Loading your saved views…'; renderSavedViewSync();
    const timer = setTimeout(() => controller.abort(), 20000);
    let result;
    try { result = await api(`/api/workspaces/${encodeURIComponent(scope.workspace)}/views`, { quiet: true, signal: controller.signal }); }
    finally { clearTimeout(timer); }
    if (!scope.current()) return;
    savedViewSync.busy = false; savedViewSync.controller = null;
    if (!result.ok || !validViewEnvelope(result.data)) {
        // Denial invalidates known private data. Transient failures retain it
        // only in memory, unavailable for use/write until a successful refresh.
        if ([401,403,404].includes(result.status)) { state.savedViews = []; state.activeSavedView = ''; }
        savedViewSync.message = 'Could not load views. Refresh views to retry; nothing has been uploaded.';
        syncSavedViews(); return;
    }
    state.savedViews = result.data.items;
    if (!state.savedViews.some(view => view.id === state.activeSavedView)) state.activeSavedView = '';
    Object.assign(savedViewSync, { ready: true, membership: result.data.membership_id, version: result.data.version, message: 'Views loaded. Your current task filters are unchanged.' });
    syncSavedViews();
}
async function saveRemoteViews(items, selected = state.activeSavedView) {
    if (!state.user || !state.currentWorkspaceId || !savedViewSync.ready || savedViewSync.busy || pendingViewWrites.has(viewStorageKey())) return false;
    if (items.length > 12 || !items.every(validCloudView) || new Set(items.map(x => x.id)).size !== items.length) { toast('At most 12 valid, unique views can be synced.', 'error'); return false; }
    const scope = savedViewScope(), expected = savedViewSync.version, membership = savedViewSync.membership;
    const controller = savedViewSync.controller = new AbortController();
    pendingViewWrites.add(scope.key); savedViewSync.busy = true; savedViewSync.ready = false;
    savedViewSync.message = 'Saving… Leaving this page cannot undo a request already received by the server.'; renderSavedViewSync();
    const timer = setTimeout(() => controller.abort(), 20000);
    let result;
    try { result = await api(`/api/workspaces/${encodeURIComponent(scope.workspace)}/views`, { method: 'PUT', body: { expected_membership: membership, expected_version: expected, items }, quiet: true, signal: controller.signal }); }
    finally { clearTimeout(timer); pendingViewWrites.delete(scope.key); }
    if (!scope.current()) { renderSavedViewSync(); return false; }
    savedViewSync.busy = false; savedViewSync.controller = null;
    const sameItems = actual => actual.length === items.length && actual.every((row, i) => ['id','name','search','filter','tagFilter','sort','view'].every(key => row[key] === items[i][key]));
    if (!result.ok || !validViewEnvelope(result.data) || result.data.membership_id !== membership || result.data.version !== expected + 1 || !sameItems(result.data.items)) {
        if ([401,403,404].includes(result.status)) { state.savedViews = []; state.activeSavedView = ''; }
        savedViewSync.message = result.status === 409 ? 'Views or membership changed. Refresh views, review them, then save again. No automatic overwrite.' : 'Save outcome could not be confirmed. Refresh views before retrying; your current filters and name are kept.';
        syncSavedViews(); return false;
    }
    state.savedViews = result.data.items; state.activeSavedView = selected;
    Object.assign(savedViewSync, { ready: true, version: result.data.version, message: 'Views saved to your account. Other devices can load them with Refresh views.' });
    syncSavedViews(); return true;
}
async function importDeviceViews() {
    if (!state.user || !savedViewSync.ready || savedViewSync.busy) return;
    const local = deviceViews();
    if (!local || !local.every(validCloudView) || new Set(local.map(x => x.id)).size !== local.length) { toast('Device views contain invalid or oversized fields. They remain unchanged in this browser.', 'error'); return; }
    const merged = [...state.savedViews];
    for (const view of local) {
        const existing = merged.find(x => x.id === view.id);
        if (existing && ['name','search','filter','tagFilter','sort','view'].some(key => existing[key] !== view[key])) { toast('A device view differs from its synced copy. Import stopped; both copies are unchanged.', 'error'); return; }
        if (!existing) merged.push(view);
    }
    if (merged.length > 12) { toast('Import would exceed 12 views. Delete unneeded synced views first; device views are unchanged.', 'error'); return; }
    if (!window.confirm(`Import ${local.length} device view(s) into your private account for this workspace? They may contain search text. Guest views and other accounts are not imported.`)) return;
    const scope = savedViewScope(); let before;
    try { before = localStorage.getItem(scope.key); }
    catch (_) { toast('Device storage is unavailable. Nothing was imported.', 'error'); return; }
    if (await saveRemoteViews(merged)) {
        if (!scope.current()) return;
        try { if (localStorage.getItem(scope.key) === before) localStorage.removeItem(scope.key); }
        catch (_) { savedViewSync.message += ' The device copy could not be removed; re-importing identical IDs will not duplicate it.'; }
        renderSavedViewSync();
    }
}
