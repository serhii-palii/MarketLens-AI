-- FILE: api/migrations/0002_domain_policies.sql
-- Per-site policy cache: holds each site's robots.txt so the collector asks for it at most once per day.

CREATE TABLE domain_policies (
  origin TEXT PRIMARY KEY CHECK (length(origin) <= 300),
  robots_kind TEXT NOT NULL CHECK (robots_kind IN ('rules', 'allow_all')),
  robots_text TEXT NOT NULL DEFAULT '' CHECK (length(robots_text) <= 100000),
  fetched_at_ms INTEGER NOT NULL
) WITHOUT ROWID;