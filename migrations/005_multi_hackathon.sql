-- Multi-tenancy: scope projects, evaluations, criteria, and settings by hackathon.
--
-- Backwards-compat strategy:
--   - All existing rows are migrated into a single 'default' hackathon
--   - Existing users get a membership in 'default' with their existing role
--   - Existing 'admin' users are also promoted to system_role='system_admin'
--     so they can create/manage additional hackathons
--   - users.role is left in place for now (still read by legacy JWTs); a
--     future migration can drop it once all tokens have rolled over

-- ─── New tables ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hackathons (
    id          TEXT PRIMARY KEY,
    slug        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',  -- active | archived
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hackathon_memberships (
    hackathon_id TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    role         TEXT NOT NULL,  -- admin | judge | participant
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (hackathon_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON hackathon_memberships(user_id);

-- ─── Add system_role to users ────────────────────────────────
DO $$ BEGIN
    ALTER TABLE users ADD COLUMN system_role TEXT NOT NULL DEFAULT 'user';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ─── Add hackathon_id to scoped tables (nullable for backfill) ──
DO $$ BEGIN ALTER TABLE projects       ADD COLUMN hackathon_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE evaluations    ADD COLUMN hackathon_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ai_evaluations ADD COLUMN hackathon_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE criteria       ADD COLUMN hackathon_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE settings       ADD COLUMN hackathon_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE audit_log      ADD COLUMN hackathon_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ─── Create the default hackathon (idempotent) ───────────────
INSERT INTO hackathons (id, slug, name, status)
SELECT 'default-hackathon', 'default',
       COALESCE((SELECT value FROM settings WHERE key = 'hackathonName' LIMIT 1), 'Default Hackathon'),
       'active'
WHERE NOT EXISTS (SELECT 1 FROM hackathons WHERE id = 'default-hackathon');

-- ─── Backfill: every scoped row goes to 'default' ────────────
UPDATE projects       SET hackathon_id = 'default-hackathon' WHERE hackathon_id IS NULL;
UPDATE evaluations    SET hackathon_id = 'default-hackathon' WHERE hackathon_id IS NULL;
UPDATE ai_evaluations SET hackathon_id = 'default-hackathon' WHERE hackathon_id IS NULL;
UPDATE criteria       SET hackathon_id = 'default-hackathon' WHERE hackathon_id IS NULL;
UPDATE settings       SET hackathon_id = 'default-hackathon' WHERE hackathon_id IS NULL;

-- ─── Backfill: every user is a member of 'default' with their existing role ──
INSERT INTO hackathon_memberships (hackathon_id, user_id, role)
SELECT 'default-hackathon', u.id, COALESCE(u.role, 'judge')
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM hackathon_memberships m
    WHERE m.user_id = u.id AND m.hackathon_id = 'default-hackathon'
);

-- ─── Promote existing admins to system_admin ─────────────────
UPDATE users SET system_role = 'system_admin' WHERE role = 'admin' AND system_role = 'user';

-- ─── Tighten constraints now that backfill is done ───────────
ALTER TABLE projects       ALTER COLUMN hackathon_id SET NOT NULL;
ALTER TABLE evaluations    ALTER COLUMN hackathon_id SET NOT NULL;
ALTER TABLE ai_evaluations ALTER COLUMN hackathon_id SET NOT NULL;
ALTER TABLE criteria       ALTER COLUMN hackathon_id SET NOT NULL;
ALTER TABLE settings       ALTER COLUMN hackathon_id SET NOT NULL;

-- ─── Settings: PK changes from (key) to (hackathon_id, key) ─
-- Old PK forbade two rows with the same key — now we want one per hackathon.
DO $$ BEGIN ALTER TABLE settings DROP CONSTRAINT settings_pkey; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE settings ADD PRIMARY KEY (hackathon_id, key); EXCEPTION WHEN invalid_table_definition THEN NULL; END $$;

-- ─── Criteria: PK changes from (id) to (hackathon_id, id) ──
-- Two hackathons can both have a criterion with id='innovation'.
DO $$ BEGIN ALTER TABLE criteria DROP CONSTRAINT criteria_pkey; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE criteria ADD PRIMARY KEY (hackathon_id, id); EXCEPTION WHEN invalid_table_definition THEN NULL; END $$;

-- ─── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_projects_hackathon       ON projects(hackathon_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_hackathon    ON evaluations(hackathon_id);
CREATE INDEX IF NOT EXISTS idx_ai_evaluations_hackathon ON ai_evaluations(hackathon_id);
CREATE INDEX IF NOT EXISTS idx_criteria_hackathon       ON criteria(hackathon_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_hackathon      ON audit_log(hackathon_id);

-- ─── Foreign keys ────────────────────────────────────────────
DO $$ BEGIN ALTER TABLE projects        ADD CONSTRAINT fk_projects_hackathon       FOREIGN KEY (hackathon_id) REFERENCES hackathons(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE evaluations     ADD CONSTRAINT fk_evaluations_hackathon    FOREIGN KEY (hackathon_id) REFERENCES hackathons(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ai_evaluations  ADD CONSTRAINT fk_ai_evaluations_hackathon FOREIGN KEY (hackathon_id) REFERENCES hackathons(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE criteria        ADD CONSTRAINT fk_criteria_hackathon       FOREIGN KEY (hackathon_id) REFERENCES hackathons(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE settings        ADD CONSTRAINT fk_settings_hackathon       FOREIGN KEY (hackathon_id) REFERENCES hackathons(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE hackathon_memberships ADD CONSTRAINT fk_memberships_hackathon FOREIGN KEY (hackathon_id) REFERENCES hackathons(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE hackathon_memberships ADD CONSTRAINT fk_memberships_user      FOREIGN KEY (user_id)      REFERENCES users(id)      ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE hackathons      ADD CONSTRAINT fk_hackathons_created_by    FOREIGN KEY (created_by)   REFERENCES users(id)      ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
