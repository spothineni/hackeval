-- Indexes on FK columns and frequent filter columns.

CREATE INDEX IF NOT EXISTS idx_project_files_project_id  ON project_files(project_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_project_id    ON evaluations(project_id);
CREATE INDEX IF NOT EXISTS idx_ai_evaluations_project_id ON ai_evaluations(project_id);
CREATE INDEX IF NOT EXISTS idx_projects_created_by       ON projects(created_by);
CREATE INDEX IF NOT EXISTS idx_users_username            ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email               ON users(email);
