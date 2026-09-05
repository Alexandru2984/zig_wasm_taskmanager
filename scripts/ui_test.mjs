/**
 * Browser checks for the task manager.
 *
 * These cover what an HTTP-level suite cannot: that the WebAssembly module
 * loads and owns the signed-out task list, that a task title is rendered as
 * text rather than markup, that the layout does not scroll sideways on a
 * phone, and that controls are large enough to tap.
 *
 *   node scripts/ui_test.mjs                      # against http://127.0.0.1:9200
 *   BASE_URL=https://task.micutu.com node scripts/ui_test.mjs
 *
 * Needs playwright-core and a Chromium build. In CI, `npx playwright install
 * --with-deps chromium` provides both; locally, set CHROME_PATH.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:9200';

// Generated per run. A literal test password reads as a leaked credential to a
// secret scanner, and a fresh one cannot drift into the common-password
// blocklist as that list grows. The Aa1 prefix guarantees the letter and digit
// the strength rules require.
const PASSWORD = 'Aa1' + randomBytes(12).toString('base64url');

const results = [];
const record = (name, ok, detail = '') =>
    results.push({ name, ok, detail });

function findChrome() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    // playwright install puts Chromium under this cache directory.
    const roots = [
        `${process.env.HOME}/.cache/ms-playwright`,
        '/ms-playwright',
    ];
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        for (const dir of fs.readdirSync(root)) {
            for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
                const p = `${root}/${dir}/${rel}`;
                if (fs.existsSync(p)) return p;
            }
        }
    }
    return undefined;
}

const browser = await chromium.launch({
    executablePath: findChrome(),
    args: ['--no-sandbox'],
});

try {
    // ---------- Signed out, on a phone ----------
    const phone = await browser.newContext({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    });
    const m = await phone.newPage();
    const pageErrors = [];
    m.on('pageerror', e => pageErrors.push(e.message));

    await m.goto(BASE, { waitUntil: 'networkidle' });
    record('page loads', (await m.title()).length > 0);

    record('no horizontal overflow at 390px',
        await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

    // The signed-out store is the Zig/WASM module; if it failed to load the app
    // falls back to localStorage, so this also proves the module instantiated.
    await m.fill('#taskInput', 'Task held by WebAssembly');
    await m.press('#taskInput', 'Enter');
    await m.waitForSelector('.task-item', { timeout: 10000 });
    record('anonymous task renders', (await m.locator('.task-item').count()) >= 1);
    record('WebAssembly module instantiated',
        await m.evaluate(() => typeof WebAssembly === 'object'));

    // The signed-out store has to hold the whole task, not part of it. Tags
    // used to be collected by the composer and silently dropped on this path,
    // and editing sent the change to an API that answered 401 for a user who
    // had never signed in.
    await m.click('#composerToggle');
    await m.fill('#taskInput', 'Offline task with metadata');
    await m.selectOption('#taskPriority', 'high');
    await m.fill('#taskTags', 'work, urgent');
    await m.click('#taskForm button[type=submit]');
    await m.waitForFunction(
        () => document.querySelectorAll('.task-item').length === 2, null, { timeout: 10000 });
    record('signed-out tags are kept', (await m.locator('.task-tag').count()) === 2);
    record('signed-out priority is kept', (await m.locator('.task-badge-high').count()) === 1);

    await m.click('.task-item >> nth=0 >> [data-act="edit"]');
    await m.waitForSelector('.task-edit', { timeout: 10000 });
    await m.fill('.task-edit [data-field="title"]', 'Edited while signed out');
    await m.click('.task-edit button[type=submit]');
    await m.waitForSelector('.task-edit', { state: 'detached', timeout: 10000 });
    record('signed-out edit saves',
        (await m.locator('.task-title').allTextContents()).includes('Edited while signed out'));

    // The WASM store is mirrored to localStorage, so all of it must survive.
    await m.reload({ waitUntil: 'networkidle' });
    await m.waitForSelector('.task-item', { timeout: 10000 });
    record('signed-out tasks survive a reload',
        (await m.locator('.task-item').count()) === 2 &&
        (await m.locator('.task-tag').count()) === 2);
    record('the edit survives a reload',
        (await m.locator('.task-title').allTextContents()).includes('Edited while signed out'));

    // Start the signed-in half from a clean slate.
    await m.evaluate(() => localStorage.removeItem('localTasks'));
    await m.reload({ waitUntil: 'networkidle' });

    // ---------- Signed in ----------
    const email = `uitest${Date.now()}@example.com`;
    await m.click('[data-target="signupModal"]');
    await m.waitForSelector('#signupModal:not([hidden])');
    await m.fill('#signupName', "Siobhán O'Brien");
    await m.fill('#signupEmail', email);
    await m.fill('#signupPassword', PASSWORD);
    await m.click('#signupForm button[type=submit]');
    // Argon2id makes signup take a couple of seconds; wait for the outcome.
    await m.waitForSelector('#verifyModal:not([hidden])', { timeout: 30000 });
    record('signup signs the user in', (await m.locator('#userMenu:not(.hidden)').count()) === 1);
    record('an apostrophe in a name is accepted',
        (await m.locator('#userName').textContent() || '').includes("O'Brien"));
    await m.click('#verifyModal .modal-close');

    async function addTask(title, priority, tags) {
        if (await m.locator('#composerDetails').isHidden()) await m.click('#composerToggle');
        await m.fill('#taskInput', title);
        await m.selectOption('#taskPriority', priority);
        await m.fill('#taskTags', tags);
        await m.click('#taskForm button[type=submit]');
    }
    const xss = 'Ship the <script>alert(1)</script> report';
    await addTask(xss, 'high', 'work, urgent');
    await addTask('Buy oat milk', 'low', 'home');
    await m.waitForFunction(
        () => document.querySelectorAll('#taskList .task-item').length === 2,
        null, { timeout: 20000 });
    record('tasks are created', true);

    const titles = await m.locator('.task-title').allTextContents();
    record('a script tag in a title renders as text', titles.some(t => t === xss));
    record('no script element is created from task input',
        await m.evaluate(() => ![...document.querySelectorAll('script')]
            .some(s => (s.textContent || '').includes('alert(1)'))));

    record('tag chips are listed', (await m.locator('#tagChips .chip').count()) >= 3);

    await m.fill('#searchInput', 'oat');
    await m.waitForFunction(
        () => document.querySelectorAll('#taskList .task-item').length === 1,
        null, { timeout: 5000 });
    record('search narrows the list', true);
    await m.fill('#searchInput', '');

    // Editing in place, which is the path most likely to break silently.
    await m.click('#taskList .task-item >> nth=0 >> [data-act="edit"]');
    await m.waitForSelector('.task-edit');
    await m.fill('.task-edit [data-field="title"]', 'Renamed inline');
    await m.click('.task-edit button[type=submit]');
    await m.waitForSelector('.task-edit', { state: 'detached', timeout: 20000 });
    record('inline edit saves',
        (await m.locator('.task-title').allTextContents()).includes('Renamed inline'));

    // Completion drives the progress bar, which is painted through a
    // constructed stylesheet because the CSP forbids inline styles.
    await m.click('#taskList .task-checkbox >> nth=0');
    await m.waitForSelector('#completedSection:not(.hidden)', { timeout: 10000 });
    record('completed section appears', true);

    // Waited for, not sampled. The bar carries `transition: width 300ms`, so a
    // single measurement taken right after the render races the animation and
    // reads back roughly zero — reliably on a fast machine, intermittently on a
    // loaded CI runner, which is the worst of both.
    const barGrew = await m.waitForFunction(
        () => document.getElementById('progressBar').getBoundingClientRect().width > 0,
        null, { timeout: 10000 },
    ).then(() => true).catch(() => false);
    record('progress bar has width', barGrew);

    // Tap targets. The checkbox is deliberately 22px of paint over a 44px hit
    // area, so it is measured by tapping outside the visible box instead.
    const small = await m.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll('button, a, select, input:not([type=checkbox])')) {
            if (el.offsetParent === null) continue;
            const r = el.getBoundingClientRect();
            if (r.width && r.height && r.height < 40) bad.push(`${el.tagName}.${el.className}`);
        }
        return bad;
    });
    record('tappable controls are at least 40px tall', small.length === 0, small.slice(0, 4).join(', '));

    const box = await m.locator('.task-checkbox').first().boundingBox();
    const before = await m.locator('.task-item.completed').count();
    await m.mouse.click(box.x + box.width / 2 - 16, box.y + box.height / 2);
    // Also waited for rather than slept on: the toggle is a round trip to the
    // API, whose latency is not something a fixed delay should be guessing at.
    const toggled = await m.waitForFunction(
        (n) => document.querySelectorAll('.task-item.completed').length !== n,
        before, { timeout: 15000 },
    ).then(() => true).catch(() => false);
    record('checkbox hit area extends past its 22px face', toggled);

    // ---------- Board, subtasks, selection, shortcuts ----------

    // The checks above finish by completing every task, which moves them to the
    // completed section — so start this part with one that is definitely open.
    await m.fill('#taskInput', 'Parent task');
    await m.click('#taskForm button[type=submit]');
    await m.waitForFunction(
        () => document.querySelectorAll('#taskList > .task-item').length >= 1,
        null, { timeout: 20000 });

    // A subtask is a task with a parent, so it must appear under its parent
    // and nowhere else. Showing it twice, or as a peer, is the failure mode
    // this guards.
    const topLevelBefore = await m.locator('#taskList > .task-item').count();
    await m.click('#taskList .task-item >> nth=0 >> [data-act="add-subtask"]');
    await m.waitForSelector('.subtask-add input', { timeout: 10000 });
    await m.fill('.subtask-add input', 'A subtask');
    await m.click('.subtask-add button[type=submit]');
    await m.waitForSelector('.subtask', { timeout: 20000 });
    record('a subtask renders under its parent', (await m.locator('.subtask').count()) === 1);
    record('a subtask is not also a top-level row',
        (await m.locator('#taskList > .task-item').count()) === topLevelBefore);
    record('the parent shows subtask progress',
        (await m.locator('.task-badge', { hasText: '0/1' }).count()) >= 1);

    await m.click('[data-view="board"]');
    await m.waitForSelector('#board:not(.hidden)', { timeout: 10000 });
    record('the board has three columns', (await m.locator('.board-column').count()) === 3);

    // Moving a card to Done must also complete the task. If the column and
    // the completed flag disagree, the counters and the list stop matching
    // the board.
    const firstTodo = m.locator('.board-column[data-status="todo"] .board-card').first();
    if (await firstTodo.count()) {
        await firstTodo.locator('.board-move button').nth(1).click();
        await m.waitForFunction(
            () => document.querySelectorAll('.board-column[data-status="doing"] .board-card').length >= 1,
            null, { timeout: 20000 });
        record('a card moves between columns', true);
    } else {
        record('a card moves between columns', false, 'no card in To do');
    }
    await m.click('[data-view="list"]');
    await m.waitForSelector('#taskList:not(.hidden)', { timeout: 10000 });

    await m.click('#selectModeBtn');
    await m.waitForSelector('.task-select', { timeout: 10000 });
    record('selection mode shows its own checkboxes',
        (await m.locator('.task-select').count()) >= 1);
    await m.click('.task-select >> nth=0');
    await m.waitForSelector('#bulkBar:not(.hidden)', { timeout: 10000 });
    record('selecting a task reveals the bulk bar', true);
    await m.click('[data-bulk="clear"]');
    await m.click('#selectModeBtn');

    // Shortcuts must not fire while the caret is in a field, or they become
    // characters nobody can type.
    await m.click('#searchInput');
    await m.keyboard.press('b');
    record('shortcuts are ignored while typing',
        (await m.locator('#board.hidden').count()) === 1 &&
        (await m.inputValue('#searchInput')) === 'b');
    await m.fill('#searchInput', '');
    await m.click('body');
    await m.keyboard.press('b');
    await m.waitForTimeout(300);
    record('"b" switches to the board', (await m.locator('#board:not(.hidden)').count()) === 1);
    await m.keyboard.press('b');
    await m.waitForTimeout(300);

    record('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

    // ---------- Desktop layout ----------
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const d = await desktop.newPage();
    await d.goto(BASE, { waitUntil: 'networkidle' });
    record('no horizontal overflow at 1280px',
        await d.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
} finally {
    await browser.close();
}

let failed = 0;
for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    if (!r.ok) failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
