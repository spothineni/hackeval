// db.js — PostgreSQL wrapper with SQLite-compatible API
// Auto-converts ? placeholders to $1, $2, $3...
const { Pool } = require('pg');

// SSL behavior:
//   - Default (production-safe): verify the server certificate.
//   - DB_SSL=disable → no TLS (only for local Postgres without TLS).
//   - DB_SSL=insecure → TLS but skip cert verification (legacy/self-signed only).
// Managed providers like Neon/Supabase/RDS work with the default verify mode.
let ssl;
const sslMode = (process.env.DB_SSL || 'verify').toLowerCase();
if (sslMode === 'disable') {
    ssl = false;
} else if (sslMode === 'insecure') {
    console.warn('[DB] DB_SSL=insecure — TLS cert verification is OFF. Do not use in production.');
    ssl = { rejectUnauthorized: false };
} else {
    ssl = { rejectUnauthorized: true };
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl,
    max: 10
});

function toPositional(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
}

const db = {
    pool,
    async query(sql, params = []) {
        return pool.query(toPositional(sql), params);
    },
    async get(sql, params = []) {
        const r = await pool.query(toPositional(sql), params);
        return r.rows[0] || null;
    },
    async all(sql, params = []) {
        const r = await pool.query(toPositional(sql), params);
        return r.rows;
    },
    async run(sql, params = []) {
        return pool.query(toPositional(sql), params);
    },
    async transaction(fn) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await fn(client);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }
};

module.exports = db;
