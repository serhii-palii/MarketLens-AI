// FILE: api/src/monitoring.ts
// Runs one page check: backoff bookkeeping, daily domain limit, fetch, extraction, and snapshot storage.
import type { CollectResult } from "./collection";
import {
  createRun,
  finishRun,
  getPageToCheck,
  markAttempt,
  postponePage,
  recordFailure,
  recordSnapshot,
  recordUnchanged,
  type RunTrigger,
} from "./monitoring-store";
import { extractPage } from "./page-extraction";
import { readCounter, utcDay } from "./usage-limits";

export const MAX_DOMAIN_FETCHES_PER_DAY = 100;
const BASE_BACKOFF_MINUTES = 15;
const MAX_BACKOFF_MINUTES = 24 * 60;

export interface CheckDeps {
  collect: (url: string) => Promise<CollectResult>;
  now: () => Date;
}

export type CheckOutcome =
  | "first_snapshot"
  | "new_snapshot"
  | "unchanged"
  | "failed";

export interface CheckResult {
  outcome: CheckOutcome;
  snapshotId: number | null;
  reason: string | null;
  httpStatus: number | null;
  bytesRead: number | null;
  truncated: boolean | null;
}

// 15 minutes after the first failure, doubling each time, up to one day.
export function backoffMinutes(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 10));
  return Math.min(BASE_BACKOFF_MINUTES * 2 ** exponent, MAX_BACKOFF_MINUTES);
}

const addMinutes = (date: Date, minutes: number): string =>
  new Date(date.getTime() + minutes * 60_000).toISOString();

function startOfNextUtcDay(date: Date): string {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1),
  ).toISOString();
}

const failed = (
  reason: string,
  httpStatus: number | null = null,
): CheckResult => ({
  outcome: "failed",
  snapshotId: null,
  reason,
  httpStatus,
  bytesRead: null,
  truncated: null,
});

// Returns null when the page does not exist. Failures are recorded on the page and returned, not thrown.
export async function checkMonitoredPage(
  db: D1Database,
  pageId: number,
  trigger: RunTrigger,
  deps: CheckDeps,
): Promise<CheckResult | null> {
  const page = await getPageToCheck(db, pageId);
  if (!page) return null;

  const started = deps.now();
  const now = started.toISOString();
  const day = utcDay(started);
  const domainScope = `domain:${new URL(page.url).hostname}`;

  if (
    (await readCounter(db, day, domainScope, "fetches")) >=
    MAX_DOMAIN_FETCHES_PER_DAY
  ) {
    await postponePage(db, {
      pageId,
      reason: "domain_limit",
      nextCheckAt: startOfNextUtcDay(started),
      now,
    });
    return failed("domain_limit");
  }

  const runId = await createRun(db, trigger, now);
  await markAttempt(db, {
    pageId,
    domainScope,
    day,
    nextCheckAt: addMinutes(
      started,
      backoffMinutes(page.consecutiveFailures + 1),
    ),
    now,
  });

  const finish = (
    status: "succeeded" | "failed",
    snapshotsCreated: number,
    errorSummary: string | null,
  ) =>
    finishRun(db, runId, {
      status,
      snapshotsCreated,
      errorSummary,
      finishedAt: deps.now().toISOString(),
    });

  try {
    const collected = await deps.collect(page.url);
    if (!collected.ok) {
      await recordFailure(db, {
        pageId,
        reason: collected.reason,
        httpStatus: collected.status ?? null,
        now,
      });
      await finish("failed", 0, collected.reason);
      return failed(collected.reason, collected.status ?? null);
    }

    const { page: fetched } = collected;
    const extraction = await extractPage(fetched.html, fetched.finalUrl);
    if (!extraction.ok) {
      await recordFailure(db, {
        pageId,
        reason: extraction.reason,
        httpStatus: fetched.status,
        now,
      });
      await finish("failed", 0, extraction.reason);
      return failed(extraction.reason, fetched.status);
    }

    const content = extraction.page;
    const nextCheckAt = addMinutes(started, page.checkIntervalHours * 60);
    const summary = {
      httpStatus: fetched.status,
      bytesRead: fetched.bytesRead,
      truncated: fetched.truncated,
      reason: null,
    };

    if (content.contentHash === page.lastContentHash) {
      await recordUnchanged(db, {
        pageId,
        httpStatus: fetched.status,
        nextCheckAt,
        now,
      });
      await finish("succeeded", 0, null);
      return { outcome: "unchanged", snapshotId: null, ...summary };
    }

    const snapshotId = await recordSnapshot(db, {
      pageId,
      runId,
      contentHash: content.contentHash,
      finalUrl: fetched.finalUrl,
      canonicalUrl: content.canonicalUrl,
      title: content.title,
      metaDescription: content.metaDescription,
      headings: content.headings,
      links: content.links,
      mainText: content.paragraphs.join("\n"),
      httpStatus: fetched.status,
      htmlBytes: fetched.bytesRead,
      truncated: fetched.truncated,
      fetchedAt: now,
      nextCheckAt,
    });
    await finish("succeeded", 1, null);
    return {
      outcome:
        page.lastContentHash === null ? "first_snapshot" : "new_snapshot",
      snapshotId,
      ...summary,
    };
  } catch (error) {
    // The attempt was already counted and the page backed off, so an unexpected error needs no further state change.
    console.error(
      "Page check failed unexpectedly:",
      error instanceof Error ? error.message : "unknown error",
    );
    await finish("failed", 0, "internal_error").catch(() => undefined);
    return failed("internal_error");
  }
}
