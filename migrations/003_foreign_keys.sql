-- Foreign keys with CASCADE / SET NULL behavior.
--
-- Existing tables may have orphan rows from before FKs existed; clean them
-- first so the constraint can attach. After that, CASCADE keeps things tidy.
-- DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL is the canonical
-- pattern for "ADD CONSTRAINT IF NOT EXISTS" since Postgres has no native
-- syntax for that.

DELETE FROM project_files   WHERE project_id NOT IN (SELECT id FROM projects);
DELETE FROM evaluations     WHERE project_id NOT IN (SELECT id FROM projects);
DELETE FROM ai_evaluations  WHERE project_id NOT IN (SELECT id FROM projects);
UPDATE projects SET created_by = NULL
    WHERE created_by IS NOT NULL AND created_by NOT IN (SELECT id FROM users);

DO $$ BEGIN
    ALTER TABLE project_files ADD CONSTRAINT fk_project_files_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE evaluations ADD CONSTRAINT fk_evaluations_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ai_evaluations ADD CONSTRAINT fk_ai_evaluations_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE projects ADD CONSTRAINT fk_projects_created_by
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
