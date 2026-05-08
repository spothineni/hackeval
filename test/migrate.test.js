const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { migrate, listMigrationFiles } = require('../lib/migrate');

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hackeval-migrate-'));
}

// Mock db that records every call so tests can assert on ordering and
// transaction boundaries.
function makeMockDb({ initiallyApplied = [], failOn } = {}) {
    const events = [];
    const applied = [...initiallyApplied];
    const db = {
        events,
        applied,
        async query(sql) {
            events.push({ kind: 'query', sql: sql.trim().replace(/\s+/g, ' ').slice(0, 80) });
        },
        async all(sql) {
            events.push({ kind: 'all', sql });
            return applied.map((name) => ({ name }));
        },
        async transaction(fn) {
            events.push({ kind: 'begin' });
            try {
                await fn({
                    async query(sql, params) {
                        const summary = sql.trim().replace(/\s+/g, ' ').slice(0, 80);
                        events.push({ kind: 'tx-query', sql: summary, params });
                        if (failOn && summary.includes(failOn)) throw new Error(`forced failure: ${failOn}`);
                        if (sql.includes('INSERT INTO schema_migrations')) {
                            applied.push(params[0]);
                        }
                    },
                });
                events.push({ kind: 'commit' });
            } catch (e) {
                events.push({ kind: 'rollback' });
                throw e;
            }
        },
    };
    return db;
}

function writeMigrations(dir, files) {
    for (const [name, sql] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), sql);
    }
}

test('listMigrationFiles: sorts alphabetically and filters .sql only', () => {
    const dir = tmpdir();
    writeMigrations(dir, {
        '003_third.sql': '-- empty',
        '001_first.sql': '-- empty',
        '002_second.sql': '-- empty',
        'README.md': 'docs',
        'notes.txt': 'ignored',
    });
    assert.deepEqual(
        listMigrationFiles(dir),
        ['001_first.sql', '002_second.sql', '003_third.sql']
    );
    fs.rmSync(dir, { recursive: true, force: true });
});

test('listMigrationFiles: nonexistent directory returns empty array', () => {
    assert.deepEqual(listMigrationFiles('/nonexistent/path-here-9999'), []);
});

test('migrate: applies all pending migrations in order on a fresh DB', async () => {
    const dir = tmpdir();
    writeMigrations(dir, {
        '001_a.sql': 'CREATE TABLE a();',
        '002_b.sql': 'CREATE TABLE b();',
        '003_c.sql': 'CREATE TABLE c();',
    });
    const db = makeMockDb();
    const { pending } = await migrate({ dir, db });
    assert.deepEqual(pending, ['001_a.sql', '002_b.sql', '003_c.sql']);
    assert.deepEqual(db.applied, ['001_a.sql', '002_b.sql', '003_c.sql']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate: skips already-applied migrations', async () => {
    const dir = tmpdir();
    writeMigrations(dir, {
        '001_a.sql': 'CREATE TABLE a();',
        '002_b.sql': 'CREATE TABLE b();',
        '003_c.sql': 'CREATE TABLE c();',
    });
    const db = makeMockDb({ initiallyApplied: ['001_a.sql', '002_b.sql'] });
    const { pending } = await migrate({ dir, db });
    assert.deepEqual(pending, ['003_c.sql']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate: no pending migrations is a no-op', async () => {
    const dir = tmpdir();
    writeMigrations(dir, { '001_a.sql': 'CREATE TABLE a();' });
    const db = makeMockDb({ initiallyApplied: ['001_a.sql'] });
    const { pending } = await migrate({ dir, db });
    assert.deepEqual(pending, []);
    // No transactions started
    assert.equal(db.events.filter((e) => e.kind === 'begin').length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate: each migration runs inside its own transaction', async () => {
    const dir = tmpdir();
    writeMigrations(dir, {
        '001_a.sql': 'CREATE TABLE a();',
        '002_b.sql': 'CREATE TABLE b();',
    });
    const db = makeMockDb();
    await migrate({ dir, db });
    const transitions = db.events.filter((e) => e.kind === 'begin' || e.kind === 'commit').map((e) => e.kind);
    assert.deepEqual(transitions, ['begin', 'commit', 'begin', 'commit']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate: a failing migration rolls back and aborts the run', async () => {
    const dir = tmpdir();
    writeMigrations(dir, {
        '001_a.sql': 'CREATE TABLE a();',
        '002_b.sql': 'BOOM!!!;',
        '003_c.sql': 'CREATE TABLE c();',
    });
    const db = makeMockDb({ failOn: 'BOOM' });
    await assert.rejects(migrate({ dir, db }), /BOOM/);
    // 001 was applied; 002 rolled back; 003 never ran.
    assert.deepEqual(db.applied, ['001_a.sql']);
    const transitions = db.events.filter((e) => ['begin', 'commit', 'rollback'].includes(e.kind)).map((e) => e.kind);
    assert.deepEqual(transitions, ['begin', 'commit', 'begin', 'rollback']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate: missing dir or db throws clearly', async () => {
    await assert.rejects(migrate({ db: makeMockDb() }), /dir is required/);
    await assert.rejects(migrate({ dir: '/tmp' }), /db is required/);
});

test('migrate: returns log of applied + pending', async () => {
    const dir = tmpdir();
    writeMigrations(dir, {
        '001_a.sql': 'CREATE TABLE a();',
        '002_b.sql': 'CREATE TABLE b();',
    });
    const db = makeMockDb({ initiallyApplied: ['001_a.sql'] });
    const result = await migrate({ dir, db });
    assert.deepEqual(result.applied, ['001_a.sql']);
    assert.deepEqual(result.pending, ['002_b.sql']);
    fs.rmSync(dir, { recursive: true, force: true });
});
