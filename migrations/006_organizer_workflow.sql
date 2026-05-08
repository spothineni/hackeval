-- Organizer/admin/participant workflow.
--
--   • Organizer creates a hackathon → status='pending'
--   • System admin approves → status='active' (records approver)
--   • System admin rejects → status='rejected' (records reason)
--   • A user submits a profile (user_profiles) and joins an active hackathon.
--
-- Existing 'active' rows from migration 005 are treated as already-approved.
-- The 'organizer' system_role is just a string value — no schema change needed
-- since users.system_role is a TEXT column.

-- ─── Approval audit columns on hackathons ────────────────────
DO $$ BEGIN ALTER TABLE hackathons ADD COLUMN approved_by      TEXT;        EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE hackathons ADD COLUMN approved_at      TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE hackathons ADD COLUMN rejection_reason TEXT;        EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE hackathons ADD COLUMN description      TEXT;        EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE hackathons ADD CONSTRAINT fk_hackathons_approved_by
        FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── User profiles ───────────────────────────────────────────
-- One row per user; written when a user prepares to join a hackathon.
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id          TEXT PRIMARY KEY,
    bio              TEXT,
    skills           TEXT NOT NULL DEFAULT '[]',  -- JSON array
    github_url       TEXT,
    linkedin_url     TEXT,
    portfolio_url    TEXT,
    experience_level TEXT,                        -- beginner | intermediate | advanced | expert
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
    ALTER TABLE user_profiles ADD CONSTRAINT fk_user_profiles_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
