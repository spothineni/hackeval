-- Hackathon timing: when does the event start, when do submissions close,
-- when does it officially end?
--
-- All three are nullable. Existing hackathons (and ones whose organizer
-- hasn't filled in dates yet) are treated as "no time gates" — the event
-- runs as long as status='active'.
--
-- Required ordering when all three are set:
--   starts_at <= submission_deadline <= ends_at
-- Validation lives in the API layer, not as a DB CHECK, so partial dates
-- (e.g. only starts_at set) are still allowed during planning.

DO $$ BEGIN ALTER TABLE hackathons ADD COLUMN starts_at           TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE hackathons ADD COLUMN submission_deadline TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE hackathons ADD COLUMN ends_at             TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Index on submission_deadline so "what's open right now?" queries are cheap.
CREATE INDEX IF NOT EXISTS idx_hackathons_submission_deadline ON hackathons(submission_deadline);
CREATE INDEX IF NOT EXISTS idx_hackathons_ends_at             ON hackathons(ends_at);
