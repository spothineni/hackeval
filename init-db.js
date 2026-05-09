// init-db.js — Runs schema migrations and seeds default rows.
// Schema definitions live in migrations/*.sql; this file only handles seeding.

const path = require('path');
const db = require('./db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { migrate } = require('./lib/migrate');

const uuid = () => crypto.randomUUID();

const DEFAULT_HACKATHON_ID = 'default-hackathon';

async function seedDefaultHackathon() {
    const existing = await db.get('SELECT id FROM hackathons WHERE id = ?', [DEFAULT_HACKATHON_ID]);
    if (existing) return;
    await db.run(
        "INSERT INTO hackathons (id, slug, name, status) VALUES (?, ?, ?, 'active')",
        [DEFAULT_HACKATHON_ID, 'default', 'Default Hackathon']
    );
    console.log('[DB] Default hackathon seeded.');
}

async function seedCriteria() {
    const cc = await db.get('SELECT COUNT(*) as cnt FROM criteria WHERE hackathon_id = ?', [DEFAULT_HACKATHON_ID]);
    if (parseInt(cc.cnt) > 0) return;
    const defaults = [
        ['innovation', 'Innovation', 1.0, 0],
        ['technical', 'Technical Complexity', 1.0, 1],
        ['design', 'Design & UX', 1.0, 2],
        ['presentation', 'Presentation', 0.8, 3],
        ['impact', 'Impact & Viability', 1.0, 4],
    ];
    for (const [id, name, weight, sort_order] of defaults) {
        await db.run(
            'INSERT INTO criteria (id, name, weight, sort_order, hackathon_id) VALUES (?, ?, ?, ?, ?)',
            [id, name, weight, sort_order, DEFAULT_HACKATHON_ID]
        );
    }
    console.log('[DB] Criteria seeded.');
}

async function seedSettings() {
    const sc = await db.get('SELECT COUNT(*) as cnt FROM settings WHERE hackathon_id = ?', [DEFAULT_HACKATHON_ID]);
    if (parseInt(sc.cnt) > 0) return;
    await db.run(
        "INSERT INTO settings (key, value, hackathon_id) VALUES ('hackathonName', 'TechHack 2026', ?)",
        [DEFAULT_HACKATHON_ID]
    );
    await db.run(
        "INSERT INTO settings (key, value, hackathon_id) VALUES ('aiWeight', '0.4', ?)",
        [DEFAULT_HACKATHON_ID]
    );
    console.log('[DB] Settings seeded.');
}

async function seedAdmin() {
    const admin = await db.get("SELECT id FROM users WHERE username = 'admin'");
    if (admin) return;
    const generated = !process.env.ADMIN_PASSWORD;
    const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
    const hash = bcrypt.hashSync(adminPassword, 10);
    const adminId = uuid();
    await db.run(
        'INSERT INTO users (id, username, email, password_hash, role, display_name, system_role) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [adminId, 'admin', 'admin@hackathon.local', hash, 'admin', 'Administrator', 'system_admin']
    );
    // Admin is also a hackathon-admin in the default event so they can manage
    // its data straight away.
    await db.run(
        'INSERT INTO hackathon_memberships (hackathon_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [DEFAULT_HACKATHON_ID, adminId, 'admin']
    );
    if (generated) {
        const banner = '━'.repeat(64);
        console.log(banner);
        console.log('  INITIAL ADMIN CREDENTIALS — save this now (shown once):');
        console.log(`     username: admin`);
        console.log(`     password: ${adminPassword}`);
        console.log('  Change this password immediately after first login.');
        console.log('  To set your own next time, deploy with ADMIN_PASSWORD=...');
        console.log(banner);
    } else {
        console.log('[DB] Admin user seeded with ADMIN_PASSWORD from env.');
    }
}

async function initDb() {
    await migrate({
        dir: path.join(__dirname, 'migrations'),
        db,
        log: console.log,
    });
    await seedDefaultHackathon();
    await seedCriteria();
    await seedSettings();
    await seedAdmin();
    console.log('[DB] Initialization complete.');
}

module.exports = initDb;
