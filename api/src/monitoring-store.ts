// FILE: api/src/monitoring-store.ts
// Data access for page checks: runs, snapshots, page scheduling state, and the robots.txt cache.
import type { RobotsCache, RobotsEntry } from "./collection";

export interface PageToCheck {
  id: number;
  url: string;
  checkIntervalHours: number;
  lastContentHash: string | null;
  consecutiveFailures: number;
}

export interface SnapshotInput {
  pageId: number;
  runId: number;
  contentHash: string;
  finalUrl: string;
  canonicalUrl: string | null;
  title: string;
  metaDescription: string;
  headings: string[];
  links: string[];
  mainText: string;
  httpStatus: number;
  htmlBytes: number;
  truncated: boolean;
  fetchedAt: string;
  nextCheckAt: string;
}

export interface SnapshotSummary {
  id: number;
  fetchedAt: string;
  contentHash: string;
  title: string;
  httpStatus: number;
  htmlBytes: number;
  truncated: boolean;
}

export interface SnapshotDetail extends SnapshotSummary {
  pageId: number;
  finalUrl: string;
  canonicalUrl: string | null;
  metaDescription: string;
  headings: string[];
  links: string[];
  mainText: string;
}

export type RunTrigger = "manual" | "scheduled" | "demo";

export interface RunSummary {
  status: "succeeded" | "failed";
  snapshotsCreated: number;
  errorSummary: string | null;
  finishedAt: string;
}

export async function getPageToCheck(
  db: D1Database,
  id: number,
): Promise<PageToCheck | null> {
  const row = await db
    .prepare(
      "SELECT id, url, check_interval_hours, last_content_hash, consecutive_failures FROM monitored_pages WHERE id = ?",
    )
    .bind(id)
    .first<{
      id: number;
      url: string;
      check_interval_hours: number;
      last_content_hash: string | null;
      consecutive_failures: number;
    }>();
  return row
    ? {
        id: row.id,
        url: row.url,
        checkIntervalHours: row.check_interval_hours,
        lastContentHash: row.last_content_hash,
        consecutiveFailures: row.consecutive_failures,
      }
    : null;
}

export async function createRun(
  db: D1Database,
  trigger: RunTrigger,
  startedAt: string,
): Promise<number> {
  const row = await db
    .prepare(
      "INSERT INTO monitoring_runs (trigger_type, started_at) VALUES (?, ?) RETURNING id",
    )
    .bind(trigger, startedAt)
    .first<{ id: number }>();
  if (!row) throw new Error("Monitoring run was not created.");
  return row.id;
}

export async function finishRun(
  db: D1Database,
  runId: number,
  summary: RunSummary,
): Promise<void> {
  await db
    .prepare(
      "UPDATE monitoring_runs SET status = ?, finished_at = ?, pages_checked = 1, snapshots_created = ?, error_count = ?, error_summary = ? WHERE id = ?",
    )
    .bind(
      summary.status,
      summary.finishedAt,
      summary.snapshotsCreated,
      summary.errorSummary ? 1 : 0,
      summary.errorSummary,
      runId,
    )
    .run();
}

// Written before the page is fetched: it counts the attempt as a failure and postpones the next check, so a run that
// is cut off (for example by a resource limit) leaves the page backed off instead of immediately due again.
export async function markAttempt(
  db: D1Database,
  input: {
    pageId: number;
    domainScope: string;
    day: string;
    nextCheckAt: string;
    now: string;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE monitored_pages SET last_attempt_at = ?, consecutive_failures = consecutive_failures + 1, next_check_at = ?, updated_at = ? WHERE id = ?",
      )
      .bind(input.now, input.nextCheckAt, input.now, input.pageId),
    db
      .prepare(
        "INSERT INTO usage_counters (day, scope, metric, value) VALUES (?, ?, 'fetches', 1) ON CONFLICT (day, scope, metric) DO UPDATE SET value = value + 1",
      )
      .bind(input.day, input.domainScope),
  ]);
}

export async function recordFailure(
  db: D1Database,
  input: {
    pageId: number;
    reason: string;
    httpStatus: number | null;
    now: string;
  },
): Promise<void> {
  await db
    .prepare(
      "UPDATE monitored_pages SET last_error = ?, last_http_status = ?, updated_at = ? WHERE id = ?",
    )
    .bind(input.reason, input.httpStatus, input.now, input.pageId)
    .run();
}

// Postpones a page without counting an attempt (used when a daily limit is reached).
export async function postponePage(
  db: D1Database,
  input: { pageId: number; reason: string; nextCheckAt: string; now: string },
): Promise<void> {
  await db
    .prepare(
      "UPDATE monitored_pages SET last_error = ?, next_check_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(input.reason, input.nextCheckAt, input.now, input.pageId)
    .run();
}

export async function recordUnchanged(
  db: D1Database,
  input: {
    pageId: number;
    httpStatus: number;
    nextCheckAt: string;
    now: string;
  },
): Promise<void> {
  await db
    .prepare(
      "UPDATE monitored_pages SET last_checked_at = ?, last_http_status = ?, consecutive_failures = 0, last_error = NULL, next_check_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(
      input.now,
      input.httpStatus,
      input.nextCheckAt,
      input.now,
      input.pageId,
    )
    .run();
}

// Stores the snapshot and the page's new state together; returns the snapshot id.
export async function recordSnapshot(
  db: D1Database,
  input: SnapshotInput,
): Promise<number> {
  const results = await db.batch([
    db
      .prepare(
        "INSERT INTO snapshots (monitored_page_id, run_id, content_hash, final_url, canonical_url, title, meta_description, headings_json, links_json, main_text, http_status, html_bytes, truncated, fetched_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.pageId,
        input.runId,
        input.contentHash,
        input.finalUrl,
        input.canonicalUrl,
        input.title,
        input.metaDescription,
        JSON.stringify(input.headings),
        JSON.stringify(input.links),
        input.mainText,
        input.httpStatus,
        input.htmlBytes,
        input.truncated ? 1 : 0,
        input.fetchedAt,
      ),
    db
      .prepare(
        "UPDATE monitored_pages SET last_content_hash = ?, canonical_url = ?, last_checked_at = ?, last_http_status = ?, consecutive_failures = 0, last_error = NULL, next_check_at = ?, updated_at = ? WHERE id = ?",
      )
      .bind(
        input.contentHash,
        input.canonicalUrl,
        input.fetchedAt,
        input.httpStatus,
        input.nextCheckAt,
        input.fetchedAt,
        input.pageId,
      ),
  ]);
  const snapshotId = results[0]?.meta.last_row_id;
  if (!snapshotId) throw new Error("Snapshot was not stored.");
  return snapshotId;
}

interface SnapshotRow {
  id: number;
  monitored_page_id: number;
  fetched_at: string;
  content_hash: string;
  title: string;
  http_status: number;
  html_bytes: number;
  truncated: number;
  final_url?: string;
  canonical_url?: string | null;
  meta_description?: string;
  headings_json?: string;
  links_json?: string;
  main_text?: string;
}

function toSummary(row: SnapshotRow): SnapshotSummary {
  return {
    id: row.id,
    fetchedAt: row.fetched_at,
    contentHash: row.content_hash,
    title: row.title,
    httpStatus: row.http_status,
    htmlBytes: row.html_bytes,
    truncated: row.truncated === 1,
  };
}

export async function listSnapshots(
  db: D1Database,
  pageId: number,
  limit = 50,
): Promise<SnapshotSummary[]> {
  const result = await db
    .prepare(
      "SELECT id, monitored_page_id, fetched_at, content_hash, title, http_status, html_bytes, truncated FROM snapshots WHERE monitored_page_id = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(pageId, limit)
    .all<SnapshotRow>();
  return result.results.map(toSummary);
}

export async function getSnapshot(
  db: D1Database,
  id: number,
): Promise<SnapshotDetail | null> {
  const row = await db
    .prepare(
      "SELECT id, monitored_page_id, fetched_at, content_hash, title, http_status, html_bytes, truncated, final_url, canonical_url, meta_description, headings_json, links_json, main_text FROM snapshots WHERE id = ?",
    )
    .bind(id)
    .first<SnapshotRow>();
  if (!row) return null;
  return {
    ...toSummary(row),
    pageId: row.monitored_page_id,
    finalUrl: row.final_url ?? "",
    canonicalUrl: row.canonical_url ?? null,
    metaDescription: row.meta_description ?? "",
    headings: JSON.parse(row.headings_json ?? "[]") as string[],
    links: JSON.parse(row.links_json ?? "[]") as string[],
    mainText: row.main_text ?? "",
  };
}

export function createRobotsCache(db: D1Database): RobotsCache {
  return {
    async get(origin) {
      const row = await db
        .prepare(
          "SELECT robots_kind, robots_text, fetched_at_ms FROM domain_policies WHERE origin = ?",
        )
        .bind(origin)
        .first<{
          robots_kind: "rules" | "allow_all";
          robots_text: string;
          fetched_at_ms: number;
        }>();
      return row
        ? {
            kind: row.robots_kind,
            text: row.robots_text,
            fetchedAtMs: row.fetched_at_ms,
          }
        : null;
    },
    async set(origin, entry: RobotsEntry) {
      await db
        .prepare(
          "INSERT INTO domain_policies (origin, robots_kind, robots_text, fetched_at_ms) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT (origin) DO UPDATE SET robots_kind = excluded.robots_kind, robots_text = excluded.robots_text, fetched_at_ms = excluded.fetched_at_ms",
        )
        .bind(origin, entry.kind, entry.text, entry.fetchedAtMs)
        .run();
    },
  };
}
