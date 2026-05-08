-- Audit log: who did what, when. Append-only — no updates or deletes.
--
-- actor_user_id is nullable so we can record self-service events that
-- predate authentication (e.g. registration). On user deletion the FK
-- nulls out so the audit trail survives.

CREATE TABLE IF NOT EXISTS audit_log (
    id            BIGSERIAL PRIMARY KEY,
    actor_user_id TEXT,
    actor_username TEXT,
    action        TEXT NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    payload       JSONB,
    ip            TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at  ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor       ON audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action      ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_target      ON audit_log(target_type, target_id);

DO $$ BEGIN
    ALTER TABLE audit_log ADD CONSTRAINT fk_audit_log_actor
        FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
