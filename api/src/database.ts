// FILE: api/src/database.ts
// Data access for competitors and monitored pages. All queries use bound parameters.
import type {
  CreateCompetitorInput,
  CreatePageInput,
  UpdateCompetitorInput,
  UpdatePageInput,
} from "./schemas";

const LIST_LIMIT = 500;

export interface CompetitorRecord {
  id: number;
  name: string;
  websiteUrl: string | null;
  notes: string;
  isActive: boolean;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PageRecord {
  id: number;
  competitorId: number;
  url: string;
  label: string;
  category: string;
  checkIntervalHours: number;
  isActive: boolean;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  lastHttpStatus: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CompetitorRow {
  id: number;
  name: string;
  website_url: string | null;
  notes: string;
  is_active: number;
  page_count: number;
  created_at: string;
  updated_at: string;
}

interface PageRow {
  id: number;
  competitor_id: number;
  url: string;
  label: string;
  category: string;
  check_interval_hours: number;
  is_active: number;
  next_check_at: string | null;
  last_checked_at: string | null;
  last_http_status: number | null;
  consecutive_failures: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const COMPETITOR_SELECT =
  "id, name, website_url, notes, is_active, created_at, updated_at, " +
  "(SELECT COUNT(*) FROM monitored_pages WHERE competitor_id = competitors.id) AS page_count";

const PAGE_COLUMNS =
  "id, competitor_id, url, label, category, check_interval_hours, is_active, next_check_at, " +
  "last_checked_at, last_http_status, consecutive_failures, last_error, created_at, updated_at";

function toCompetitor(row: CompetitorRow): CompetitorRecord {
  return {
    id: row.id,
    name: row.name,
    websiteUrl: row.website_url,
    notes: row.notes,
    isActive: row.is_active === 1,
    pageCount: row.page_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPage(row: PageRow): PageRecord {
  return {
    id: row.id,
    competitorId: row.competitor_id,
    url: row.url,
    label: row.label,
    category: row.category,
    checkIntervalHours: row.check_interval_hours,
    isActive: row.is_active === 1,
    nextCheckAt: row.next_check_at,
    lastCheckedAt: row.last_checked_at,
    lastHttpStatus: row.last_http_status,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCompetitors(
  db: D1Database,
): Promise<CompetitorRecord[]> {
  const result = await db
    .prepare(
      `SELECT ${COMPETITOR_SELECT} FROM competitors ORDER BY name LIMIT ?`,
    )
    .bind(LIST_LIMIT)
    .all<CompetitorRow>();
  return result.results.map(toCompetitor);
}

export async function getCompetitor(
  db: D1Database,
  id: number,
): Promise<CompetitorRecord | null> {
  const row = await db
    .prepare(`SELECT ${COMPETITOR_SELECT} FROM competitors WHERE id = ?`)
    .bind(id)
    .first<CompetitorRow>();
  return row ? toCompetitor(row) : null;
}

export async function createCompetitor(
  db: D1Database,
  input: CreateCompetitorInput,
  now: string,
): Promise<CompetitorRecord> {
  const row = await db
    .prepare(
      "INSERT INTO competitors (name, website_url, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(input.name, input.websiteUrl ?? null, input.notes ?? "", now, now)
    .first<{ id: number }>();
  const created = row ? await getCompetitor(db, row.id) : null;
  if (!created) throw new Error("Competitor was not created.");
  return created;
}

export async function updateCompetitor(
  db: D1Database,
  id: number,
  input: UpdateCompetitorInput,
  now: string,
): Promise<CompetitorRecord | null> {
  // Column names come from this fixed list; request values are always bound parameters.
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined)
    (assignments.push("name = ?"), values.push(input.name));
  if (input.websiteUrl !== undefined)
    (assignments.push("website_url = ?"), values.push(input.websiteUrl));
  if (input.notes !== undefined)
    (assignments.push("notes = ?"), values.push(input.notes));
  if (input.isActive !== undefined)
    (assignments.push("is_active = ?"), values.push(input.isActive ? 1 : 0));
  assignments.push("updated_at = ?");
  values.push(now, id);

  const row = await db
    .prepare(
      `UPDATE competitors SET ${assignments.join(", ")} WHERE id = ? RETURNING id`,
    )
    .bind(...values)
    .first<{ id: number }>();
  return row ? getCompetitor(db, row.id) : null;
}

export async function deleteCompetitor(
  db: D1Database,
  id: number,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM competitors WHERE id = ?")
    .bind(id)
    .run();
  return result.meta.changes > 0;
}

export async function listPages(
  db: D1Database,
  competitorId: number,
): Promise<PageRecord[]> {
  const result = await db
    .prepare(
      `SELECT ${PAGE_COLUMNS} FROM monitored_pages WHERE competitor_id = ? ORDER BY id LIMIT ?`,
    )
    .bind(competitorId, LIST_LIMIT)
    .all<PageRow>();
  return result.results.map(toPage);
}

export async function getPage(
  db: D1Database,
  id: number,
): Promise<PageRecord | null> {
  const row = await db
    .prepare(`SELECT ${PAGE_COLUMNS} FROM monitored_pages WHERE id = ?`)
    .bind(id)
    .first<PageRow>();
  return row ? toPage(row) : null;
}

// A new page is due for its first check immediately.
export async function createPage(
  db: D1Database,
  competitorId: number,
  input: CreatePageInput,
  now: string,
): Promise<PageRecord> {
  const row = await db
    .prepare(
      "INSERT INTO monitored_pages (competitor_id, url, label, category, check_interval_hours, next_check_at, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(
      competitorId,
      input.url,
      input.label ?? "",
      input.category,
      input.checkIntervalHours ?? 24,
      now,
      now,
      now,
    )
    .first<{ id: number }>();
  const created = row ? await getPage(db, row.id) : null;
  if (!created) throw new Error("Page was not created.");
  return created;
}

export async function updatePage(
  db: D1Database,
  id: number,
  input: UpdatePageInput,
  now: string,
): Promise<PageRecord | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (input.label !== undefined)
    (assignments.push("label = ?"), values.push(input.label));
  if (input.category !== undefined)
    (assignments.push("category = ?"), values.push(input.category));
  if (input.checkIntervalHours !== undefined) {
    assignments.push("check_interval_hours = ?");
    values.push(input.checkIntervalHours);
  }
  if (input.isActive !== undefined) {
    assignments.push("is_active = ?");
    values.push(input.isActive ? 1 : 0);
    // Reactivating a page that was never scheduled makes it due now.
    if (input.isActive)
      (assignments.push("next_check_at = COALESCE(next_check_at, ?)"),
        values.push(now));
  }
  assignments.push("updated_at = ?");
  values.push(now, id);

  const row = await db
    .prepare(
      `UPDATE monitored_pages SET ${assignments.join(", ")} WHERE id = ? RETURNING id`,
    )
    .bind(...values)
    .first<{ id: number }>();
  return row ? getPage(db, row.id) : null;
}

export async function deletePage(db: D1Database, id: number): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM monitored_pages WHERE id = ?")
    .bind(id)
    .run();
  return result.meta.changes > 0;
}
