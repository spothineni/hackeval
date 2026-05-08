const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Force local-mode by ensuring STORAGE_BUCKET is unset in this test process.
delete process.env.STORAGE_BUCKET;

const storageLib = require('../lib/storage');

function tmpdir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hackeval-storage-'));
    return d;
}

test('provider defaults to "local" when STORAGE_BUCKET is unset', () => {
    // We deleted the env var above; module was loaded after that.
    assert.equal(storageLib.provider, 'local');
    assert.equal(storageLib.isCloud, false);
});

test('local backend instance reports provider="local" / isCloud=false', () => {
    const s = storageLib.init('/tmp');
    assert.equal(s.provider, 'local');
    assert.equal(s.isCloud, false);
});

test('_keyOf prefixes the stored name with STORAGE_PREFIX', () => {
    // Default prefix is 'uploads/'.
    assert.equal(storageLib._keyOf('abc.txt'), 'uploads/abc.txt');
});

test('_buildContentDisposition sanitizes filename and disposition', () => {
    const cd = storageLib._buildContentDisposition('inline', 'normal.pdf');
    assert.equal(cd, 'inline; filename="normal.pdf"');

    // Strips quotes and newlines so caller can't break the header
    const evil = storageLib._buildContentDisposition('inline', 'a"b\nc.pdf');
    assert.equal(evil, 'inline; filename="abc.pdf"');

    // Unknown disposition values fall back to inline
    assert.equal(
        storageLib._buildContentDisposition('javascript:', 'x.txt'),
        'inline; filename="x.txt"'
    );

    // attachment is honored
    assert.equal(
        storageLib._buildContentDisposition('attachment', 'x.txt'),
        'attachment; filename="x.txt"'
    );

    // No filename → no header
    assert.equal(storageLib._buildContentDisposition('inline'), undefined);
});

test('local backend: putBuffer + readText round-trip', async () => {
    const dir = tmpdir();
    const storage = storageLib.init(dir);
    const name = 'roundtrip.txt';
    await storage.putBuffer(name, Buffer.from('hello world'));
    const out = await storage.readText(name, 1024);
    assert.equal(out, 'hello world');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('local backend: readText respects maxBytes cap', async () => {
    const dir = tmpdir();
    const storage = storageLib.init(dir);
    await storage.putBuffer('big.txt', Buffer.from('a'.repeat(5000)));
    const out = await storage.readText('big.txt', 100);
    assert.equal(out.length, 100);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('local backend: delete removes file; second delete is a no-op', async () => {
    const dir = tmpdir();
    const storage = storageLib.init(dir);
    await storage.putBuffer('gone.txt', Buffer.from('x'));
    await storage.delete('gone.txt');
    await storage.delete('gone.txt'); // does not throw on ENOENT
    assert.equal(fs.existsSync(path.join(dir, 'gone.txt')), false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('local backend: putFromPath copies and removes source if outside dir', async () => {
    const dir = tmpdir();
    const storage = storageLib.init(dir);
    const srcDir = tmpdir();
    const src = path.join(srcDir, 'src.txt');
    fs.writeFileSync(src, 'payload');
    await storage.putFromPath('dest.txt', src);
    assert.equal(fs.readFileSync(path.join(dir, 'dest.txt'), 'utf8'), 'payload');
    assert.equal(fs.existsSync(src), false);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
});

test('local backend: putFromPath is a no-op when src already at destination', async () => {
    const dir = tmpdir();
    const storage = storageLib.init(dir);
    const src = path.join(dir, 'inplace.txt');
    fs.writeFileSync(src, 'kept');
    await storage.putFromPath('inplace.txt', src);
    assert.equal(fs.readFileSync(src, 'utf8'), 'kept');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('local backend: rejects path-escape stored names', async () => {
    const dir = tmpdir();
    const storage = storageLib.init(dir);
    await assert.rejects(
        storage.putBuffer('../escape.txt', Buffer.from('x')),
        /path escape/
    );
    fs.rmSync(dir, { recursive: true, force: true });
});

test('local backend: getDownloadUrl returns null (no signed URLs in local mode)', async () => {
    const dir = tmpdir();
    const storage = storageLib.init(dir);
    const url = await storage.getDownloadUrl('anything.txt');
    assert.equal(url, null);
    fs.rmSync(dir, { recursive: true, force: true });
});
