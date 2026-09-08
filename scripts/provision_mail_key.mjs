// Private local configuration operation; no DB writes or network access.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const [source, recovery] = process.argv.slice(2);
assert.ok(source && recovery, 'usage: provision_mail_key.mjs runtime.env private-recovery.env');
const stat = fs.lstatSync(source);
assert.ok(stat.isFile() && !stat.isSymbolicLink());
assert.equal(stat.mode & 0o027, 0, 'config must not be group writable or accessible to others');
assert.equal(fs.statSync(path.dirname(recovery)).mode & 0o077, 0, 'recovery directory must be private');
const original = fs.readFileSync(source, 'utf8');
const keyLine = /^[ \t]*(?:export[ \t]+)?MAIL_OUTBOX_KEY[ \t]*=(.*)$/;
const assignments = original.split('\n').map(line => line.match(keyLine)).filter(Boolean);
assert.ok(assignments.length <= 1, 'duplicate key definitions; resolve explicitly before provisioning');
const value = (assignments[0]?.[1] || '').split('#', 1)[0].trim().replace(/^(['"])(.*)\1$/, '$2');
assert.ok(value === '' || /^[a-fA-F0-9]{64}$/.test(value), 'invalid existing key; do not silently replace it');
const existing = value.length > 0;
const content = existing ? original : `${original.split('\n').filter(line => !keyLine.test(line)).join('\n')}\nMAIL_OUTBOX_KEY=${randomBytes(32).toString('hex')}\n`;
function save(filename, mode, uid, gid) {
    const fd = fs.openSync(filename, 'wx', 0o600);
    try { fs.writeFileSync(fd, content); fs.fchownSync(fd, uid, gid); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const dir = fs.openSync(path.dirname(filename), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
save(recovery, 0o600, process.getuid(), process.getgid());
if (!existing) {
    const next = `${source}.mail-key-${randomBytes(8).toString('hex')}`;
    save(next, stat.mode & 0o777, stat.uid, stat.gid); fs.renameSync(next, source);
    const dir = fs.openSync(path.dirname(source), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
console.log('Mail encryption key retained outside the DB; private recovery config saved. Key contents withheld.');
