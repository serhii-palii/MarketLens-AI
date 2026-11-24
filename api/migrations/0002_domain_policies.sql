-- Migration 0002: per-site policy cache.
-- Holds each site's robots.txt so the collector asks for it at most once per day.
-- The text comes from the monitored site and is only ever parsed, never rendered.

CREATE TABLE domain_policies (
  origin TEXT PRIMARY KEY CHECK (length(origin) <= 300),
  robots_kind TEXT NOT NULL CHECK (robots_kind IN ('rules', 'allow_all')),
  robots_text TEXT NOT NULL DEFAULT '' CHECK (length(robots_text) <= 100000),
  fetched_at_ms INTEGER NOT NULL
) WITHOUT ROWID;