// Tiny SQL migration runner.
//
// Reads `migrations/*.sql` in alphabetical order, applies each unapplied one
// inside a transaction, and records the filename in `schema_migrations` so
// it's not re-run. Failure inside a migration rolls back that file's changes
// and aborts the run.
//
// Conventions:
//   - filename is ALWAYS `NNN_description.sql` (zero-padded so lexical sort
//     matches numeric order)
//   - migrations should ideally be idempotent (e.g. CREATE TABLE IF NOT EXISTS,
//     `DO $$ ... EXCEPTION WHEN duplicate_object`) so they're safe to apply
//     against existing databases that pre-date this migrator
//   - no down-migrations — if you need to roll back, deploy the prior code
//     and write a new "undo" migration
//
// `db` must expose: query(sql), all(sql), transaction(fn). The runtime db
// module already provides this; tests pass a mock.

const fs = require('node:fs');
const path = require('node:path');

function listMigrationFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
}

async function migrate({ dir, db, log = () => {} } = {}) {
    if (!dir) throw new Error('migrate: dir is required');
    if (!db) throw new Error('migrate: db is required');

    await db.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    const rows = await db.all('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = listMigrationFiles(dir);
    const pending = files.filter((f) => !applied.has(f));

    for (const file of pending) {
        log(`[MIGRATE] applying ${file}…`);
        const sql = fs.readFileSync(path.join(dir, file), 'utf-8');
        await db.transaction(async (client) => {
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        });
    }

    if (pending.length === 0) log('[MIGRATE] no pending migrations');
    else log(`[MIGRATE] applied ${pending.length} migration(s)`);

    return { applied: [...applied], pending };
}

module.exports = { migrate, listMigrationFiles };
