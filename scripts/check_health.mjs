// Scheduler-friendly check. Emits bounded, non-secret JSON and exit status.
// It does not invent an alert recipient or send messages to an external vendor.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const [configFile, endpoint] = process.argv.slice(2);
assert.ok(configFile && endpoint, 'usage: check_health.mjs private-runtime.env base-url');
const cfg = {};
for (const line of fs.readFileSync(configFile, 'utf8').split('\n')) {
    const match = line.match(/^\s*(METRICS_TOKEN|APP_BASE_URL|PORT)\s*=\s*([^#]*?)\s*(?:#.*)?$/);
    if (match) cfg[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
const target = new URL(endpoint);
assert.ok(target.origin === `http://127.0.0.1:${cfg.PORT || '9000'}` || (target.protocol === 'https:' && target.origin === new URL(cfg.APP_BASE_URL).origin), 'refuse sending metrics credentials to an unrelated endpoint');
const faults = [];
try {
    const ready = await fetch(new URL('/api/ready', target), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!ready.ok || (await ready.json()).status !== 'ready') faults.push('not_ready');
} catch { faults.push('readiness_unreachable'); }
if (!cfg.METRICS_TOKEN) faults.push('metrics_not_configured');
else try {
    const response = await fetch(new URL('/api/metrics', target), { headers: { Authorization: `Bearer ${cfg.METRICS_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) faults.push('metrics_unavailable');
    else {
        const text = await response.text();
        const metric = (name, status) => Number(text.match(new RegExp(`^${name}\\{status="${status}"\\} (\\d+)$`, 'm'))?.[1] ?? NaN);
        if (['pending', 'processing', 'failed'].some(status =>
            ['mail_outbox_jobs', 'mail_outbox_oldest_seconds'].some(name => !Number.isFinite(metric(name, status))))) faults.push('mail_metrics_missing');
        if (metric('mail_outbox_jobs', 'failed') > 0) faults.push('mail_failed');
        if (metric('mail_outbox_oldest_seconds', 'pending') > 300) faults.push('mail_backlog');
        if (metric('mail_outbox_oldest_seconds', 'processing') > 300) faults.push('mail_stalled');
    }
} catch { faults.push('metrics_unreachable'); }
console.log(JSON.stringify({ time: new Date().toISOString(), ok: faults.length === 0, faults }));
process.exitCode = faults.length ? 1 : 0;
