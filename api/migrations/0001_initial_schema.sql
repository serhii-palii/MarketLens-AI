-- FILE: api/migrations/0001_initial_schema.sql
-- Initial schema: core tables for monitoring, change detection, AI analysis, and human review.

CREATE TABLE competitors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 120),
  website_url TEXT CHECK (website_url IS NULL OR length(website_url) <= 2048),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE monitored_pages (
  id INTEGER PRIMARY KEY,
  competitor_id INTEGER NOT NULL REFERENCES competitors (id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK (length(url) <= 2048 AND (url LIKE 'http://%' OR url LIKE 'https://%')),
  label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 200),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  check_interval_hours INTEGER NOT NULL DEFAULT 24 CHECK (check_interval_hours BETWEEN 1 AND 720),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  next_check_at TEXT,
  last_attempt_at TEXT,
  last_checked_at TEXT,
  last_http_status INTEGER,
  last_content_hash TEXT,
  canonical_url TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (competitor_id, url)
);

-- Serves the scheduler's "next due page" lookup without scanning every page.
CREATE INDEX idx_monitored_pages_due ON monitored_pages (next_check_at)
  WHERE is_active = 1 AND next_check_at IS NOT NULL;

CREATE TABLE monitoring_runs (
  id INTEGER PRIMARY KEY,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual', 'scheduled', 'demo')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  pages_checked INTEGER NOT NULL DEFAULT 0,
  snapshots_created INTEGER NOT NULL DEFAULT 0,
  changes_found INTEGER NOT NULL DEFAULT 0,
  analyses_run INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

-- Raw collected content. Rows are immutable; a new row is stored only when the content hash changes.
-- A monitoring run that snapshots or analyses still reference cannot be deleted.
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  monitored_page_id INTEGER NOT NULL REFERENCES monitored_pages (id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES monitoring_runs (id),
  content_hash TEXT NOT NULL,
  final_url TEXT NOT NULL,
  canonical_url TEXT,
  title TEXT NOT NULL DEFAULT '',
  meta_description TEXT NOT NULL DEFAULT '',
  headings_json TEXT NOT NULL DEFAULT '[]',
  links_json TEXT NOT NULL DEFAULT '[]',
  main_text TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  html_bytes INTEGER NOT NULL CHECK (html_bytes >= 0),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  fetched_at TEXT NOT NULL
);

CREATE INDEX idx_snapshots_page ON snapshots (monitored_page_id, id);

-- Deterministic differences between two snapshots. Only analysis_state changes after insertion.
CREATE TABLE changes (
  id INTEGER PRIMARY KEY,
  monitored_page_id INTEGER NOT NULL REFERENCES monitored_pages (id) ON DELETE CASCADE,
  from_snapshot_id INTEGER REFERENCES snapshots (id) ON DELETE CASCADE,
  to_snapshot_id INTEGER NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
  change_type TEXT NOT NULL CHECK (length(change_type) BETWEEN 1 AND 60),
  diff_json TEXT NOT NULL,
  significance_score REAL NOT NULL DEFAULT 0 CHECK (significance_score BETWEEN 0 AND 1),
  analysis_state TEXT NOT NULL DEFAULT 'skipped'
    CHECK (analysis_state IN ('skipped', 'pending', 'completed', 'failed')),
  detected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_changes_page ON changes (monitored_page_id, id);
CREATE INDEX idx_changes_from_snapshot ON changes (from_snapshot_id);
CREATE INDEX idx_changes_to_snapshot ON changes (to_snapshot_id);
-- Serves the analysis queue.
CREATE INDEX idx_changes_pending ON changes (id) WHERE analysis_state = 'pending';

-- AI interpretations. Rows are immutable; a re-analysis adds a new row.
CREATE TABLE ai_analyses (
  id INTEGER PRIMARY KEY,
  change_id INTEGER NOT NULL REFERENCES changes (id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES monitoring_runs (id),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'invalid_output')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  title TEXT,
  category TEXT,
  priority TEXT CHECK (priority IS NULL OR priority IN ('low', 'medium', 'high')),
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  output_json TEXT,
  error TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  neurons_estimate REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_ai_analyses_change ON ai_analyses (change_id, id);

-- Human review log. Append-only; the latest row per analysis is the current state (no row means pending).
CREATE TABLE review_actions (
  id INTEGER PRIMARY KEY,
  analysis_id INTEGER NOT NULL REFERENCES ai_analyses (id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'needs_review')),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 5000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_review_actions_analysis ON review_actions (analysis_id, id);

-- Daily counters for AI budget and abuse limits. Each database tracks its own scope.
CREATE TABLE usage_counters (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope, metric)
) WITHOUT ROWID;

-- Collected content, AI output, and human decisions stay separate and are never edited in place.
CREATE TRIGGER snapshots_immutable BEFORE UPDATE ON snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshots rows are immutable');
END;

CREATE TRIGGER ai_analyses_immutable BEFORE UPDATE ON ai_analyses
BEGIN
  SELECT RAISE(ABORT, 'ai_analyses rows are immutable');
END;

CREATE TRIGGER review_actions_append_only BEFORE UPDATE ON review_actions
BEGIN
  SELECT RAISE(ABORT, 'review_actions rows are append-only');
END;