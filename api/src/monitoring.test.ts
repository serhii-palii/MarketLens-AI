// FILE: api/src/monitoring.test.ts
// Tests for page checks: snapshots, change detection by hash, failure backoff, crash safety, and domain limits.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectResult } from "./collection";
import {
  MAX_DOMAIN_FETCHES_PER_DAY,
  backoffMinutes,
  checkMonitoredPage,
  type CheckDeps,
} from "./monitoring";
import {
  createRobotsCache,
  getSnapshot,
  listSnapshots,
} from "./monitoring-store";
import { createTestDatabase, type TestDatabase } from "./test-database";

const START = new Date("2026-11-23T10:00:00.000Z");
const URL_ONE = "https://acme.example.com/pricing";

let testDb: TestDatabase;
let clock: Date;

const okPage = (
  html: string,
  extra: { truncated?: boolean; bytesRead?: number } = {},
): CollectResult => ({
  ok: true,
  page: {
    finalUrl: URL_ONE,
    status: 200,
    contentType: "text/html",
    html,
    bytesRead: extra.bytesRead ?? html.length,
    truncated: extra.truncated ?? false,
    redirects: [],
  },
});

const deps = (collect: CheckDeps["collect"]): CheckDeps => ({
  collect,
  now: () => clock,
});
const pageHtml = (price: string) =>
  `<html><head><title>Pricing</title></head><body><h1>Plans</h1><p>Pro plan: ${price} per user.</p><a href="/docs">Docs</a></body></html>`;

function scalar(sql: string, params: (string | number)[] = []): unknown {
  return testDb.raw.exec(sql, params)[0]?.values[0]?.[0];
}
const pageField = (column: string, id = 1): unknown =>
  scalar(`SELECT ${column} FROM monitored_pages WHERE id = ?`, [id]);

function addPage(url = URL_ONE, interval = 24): number {
  testDb.raw.run(
    "INSERT OR IGNORE INTO competitors (id, name) VALUES (1, 'Acme')",
  );
  testDb.raw.run(
    "INSERT INTO monitored_pages (competitor_id, url, category, check_interval_hours) VALUES (1, ?, 'marketing', ?)",
    [url, interval],
  );
  return Number(scalar("SELECT last_insert_rowid()"));
}

beforeEach(() => {
  testDb = createTestDatabase();
  clock = new Date(START);
});

const check = (collect: CheckDeps["collect"], pageId = 1) =>
  checkMonitoredPage(testDb.database, pageId, "manual", deps(collect));

describe("successful checks", () => {
  it("stores the first snapshot and schedules the next check", async () => {
    addPage();
    const result = await check(async () => okPage(pageHtml("$59")));

    expect(result).toMatchObject({
      outcome: "first_snapshot",
      httpStatus: 200,
      truncated: false,
    });
    expect(scalar("SELECT COUNT(*) FROM snapshots")).toBe(1);
    expect(pageField("last_content_hash")).toMatch(/^[0-9a-f]{64}$/);
    expect(pageField("consecutive_failures")).toBe(0);
    expect(pageField("last_checked_at")).toBe("2026-11-23T10:00:00.000Z");
    expect(pageField("next_check_at")).toBe("2026-11-24T10:00:00.000Z");
    expect(scalar("SELECT status FROM monitoring_runs")).toBe("succeeded");
    expect(scalar("SELECT snapshots_created FROM monitoring_runs")).toBe(1);
    expect(scalar("SELECT trigger_type FROM monitoring_runs")).toBe("manual");
  });

  it("does not store a snapshot when the content is unchanged", async () => {
    addPage();
    await check(async () => okPage(pageHtml("$59")));
    clock = new Date("2026-11-24T10:05:00.000Z");
    const result = await check(async () => okPage(pageHtml("$59")));

    expect(result).toMatchObject({ outcome: "unchanged", snapshotId: null });
    expect(scalar("SELECT COUNT(*) FROM snapshots")).toBe(1);
    expect(pageField("last_checked_at")).toBe("2026-11-24T10:05:00.000Z");
    expect(scalar("SELECT COUNT(*) FROM monitoring_runs")).toBe(2);
  });

  it("stores a new snapshot when the content changes", async () => {
    addPage();
    await check(async () => okPage(pageHtml("$59")));
    const result = await check(async () => okPage(pageHtml("$69")));

    expect(result?.outcome).toBe("new_snapshot");
    expect(scalar("SELECT COUNT(*) FROM snapshots")).toBe(2);
    const snapshots = await listSnapshots(testDb.database, 1);
    expect(snapshots[0]?.contentHash).not.toBe(snapshots[1]?.contentHash);
  });

  it("records size and truncation", async () => {
    addPage();
    await check(async () =>
      okPage(pageHtml("$59"), { truncated: true, bytesRead: 250_000 }),
    );
    const [summary] = await listSnapshots(testDb.database, 1);
    expect(summary).toMatchObject({
      htmlBytes: 250_000,
      truncated: true,
      httpStatus: 200,
      title: "Pricing",
    });
  });

  it("returns snapshot details with parsed headings and links", async () => {
    addPage();
    const result = await check(async () => okPage(pageHtml("$59")));
    const detail = await getSnapshot(testDb.database, result?.snapshotId ?? 0);
    expect(detail).toMatchObject({
      pageId: 1,
      finalUrl: URL_ONE,
      title: "Pricing",
      headings: ["Plans"],
      links: ["https://acme.example.com/docs"],
    });
    expect(detail?.mainText).toContain("Pro plan: $59 per user.");
    expect(await getSnapshot(testDb.database, 999)).toBeNull();
  });

  it("returns null for a page that does not exist", async () => {
    expect(await check(async () => okPage("x"), 42)).toBeNull();
  });
});

describe("failures and backoff", () => {
  it("records the reason, backs off, and stores nothing", async () => {
    addPage();
    const result = await check(async () => ({
      ok: false,
      reason: "http_error",
      status: 503,
    }));

    expect(result).toMatchObject({
      outcome: "failed",
      reason: "http_error",
      httpStatus: 503,
    });
    expect(pageField("consecutive_failures")).toBe(1);
    expect(pageField("last_error")).toBe("http_error");
    expect(pageField("last_http_status")).toBe(503);
    expect(pageField("next_check_at")).toBe("2026-11-23T10:15:00.000Z");
    expect(scalar("SELECT COUNT(*) FROM snapshots")).toBe(0);
    expect(scalar("SELECT status FROM monitoring_runs")).toBe("failed");
    expect(scalar("SELECT error_summary FROM monitoring_runs")).toBe(
      "http_error",
    );
  });

  it("doubles the wait after each failure and resets after a success", async () => {
    addPage();
    const fail = async (): Promise<CollectResult> => ({
      ok: false,
      reason: "timeout",
    });
    await check(fail);
    await check(fail);
    expect(pageField("consecutive_failures")).toBe(2);
    expect(pageField("next_check_at")).toBe("2026-11-23T10:30:00.000Z");
    await check(fail);
    expect(pageField("next_check_at")).toBe("2026-11-23T11:00:00.000Z");

    await check(async () => okPage(pageHtml("$59")));
    expect(pageField("consecutive_failures")).toBe(0);
    expect(pageField("last_error")).toBeNull();
    expect(pageField("next_check_at")).toBe("2026-11-24T10:00:00.000Z");
  });

  it("computes backoff steps with a one-day ceiling", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(backoffMinutes)).toEqual([
      15, 30, 60, 120, 240, 480, 960, 1440, 1440,
    ]);
  });

  it("reports pages whose markup cannot be processed safely", async () => {
    addPage();
    const result = await check(async () => okPage("<script>".repeat(5000)));
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "malformed_html",
      httpStatus: 200,
    });
    expect(scalar("SELECT COUNT(*) FROM snapshots")).toBe(0);
  });
});

describe("crash safety", () => {
  it("counts the attempt and postpones the page before fetching", async () => {
    addPage();
    let seen: Record<string, unknown> = {};
    await check(async () => {
      seen = {
        failures: pageField("consecutive_failures"),
        next: pageField("next_check_at"),
        attempt: pageField("last_attempt_at"),
        runStatus: scalar("SELECT status FROM monitoring_runs"),
      };
      return okPage(pageHtml("$59"));
    });
    expect(seen).toEqual({
      failures: 1,
      next: "2026-11-23T10:15:00.000Z",
      attempt: "2026-11-23T10:00:00.000Z",
      runStatus: "running",
    });
  });

  it("leaves the page backed off when the check throws", async () => {
    addPage();
    const quiet = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const result = await check(async () => {
      throw new Error("worker exceeded a limit");
    });
    quiet.mockRestore();

    expect(result).toMatchObject({
      outcome: "failed",
      reason: "internal_error",
    });
    expect(pageField("consecutive_failures")).toBe(1);
    expect(pageField("next_check_at")).toBe("2026-11-23T10:15:00.000Z");
    expect(scalar("SELECT status FROM monitoring_runs")).toBe("failed");
  });
});

describe("daily domain limit", () => {
  it("counts every attempt against the domain", async () => {
    addPage();
    await check(async () => okPage(pageHtml("$59")));
    await check(async () => okPage(pageHtml("$59")));
    expect(
      scalar(
        "SELECT value FROM usage_counters WHERE scope = 'domain:acme.example.com'",
      ),
    ).toBe(2);
  });

  it("stops fetching a domain once its daily limit is reached", async () => {
    addPage();
    testDb.raw.run(
      "INSERT INTO usage_counters (day, scope, metric, value) VALUES ('2026-11-23', 'domain:acme.example.com', 'fetches', ?)",
      [MAX_DOMAIN_FETCHES_PER_DAY],
    );
    const collect = vi.fn(async () => okPage(pageHtml("$59")));
    const result = await check(collect);

    expect(result).toMatchObject({ outcome: "failed", reason: "domain_limit" });
    expect(collect).not.toHaveBeenCalled();
    expect(scalar("SELECT COUNT(*) FROM monitoring_runs")).toBe(0);
    expect(pageField("next_check_at")).toBe("2026-11-24T00:00:00.000Z");
    expect(pageField("consecutive_failures")).toBe(0);
  });

  it("does not limit other domains or other days", async () => {
    addPage();
    const other = addPage("https://other.example.org/pricing");
    testDb.raw.run(
      "INSERT INTO usage_counters (day, scope, metric, value) VALUES ('2026-11-23', 'domain:acme.example.com', 'fetches', ?)",
      [MAX_DOMAIN_FETCHES_PER_DAY],
    );
    expect(
      (await check(async () => okPage(pageHtml("$59")), other))?.outcome,
    ).toBe("first_snapshot");

    clock = new Date("2026-11-24T00:00:01.000Z");
    expect((await check(async () => okPage(pageHtml("$59"))))?.outcome).toBe(
      "first_snapshot",
    );
  });
});

describe("robots cache storage", () => {
  it("round-trips and overwrites entries per origin", async () => {
    const cache = createRobotsCache(testDb.database);
    expect(await cache.get("https://acme.example.com")).toBeNull();

    await cache.set("https://acme.example.com", {
      kind: "rules",
      text: "User-agent: *\nDisallow: /a",
      fetchedAtMs: 1000,
    });
    expect(await cache.get("https://acme.example.com")).toEqual({
      kind: "rules",
      text: "User-agent: *\nDisallow: /a",
      fetchedAtMs: 1000,
    });

    await cache.set("https://acme.example.com", {
      kind: "allow_all",
      text: "",
      fetchedAtMs: 2000,
    });
    expect(await cache.get("https://acme.example.com")).toEqual({
      kind: "allow_all",
      text: "",
      fetchedAtMs: 2000,
    });
    expect(scalar("SELECT COUNT(*) FROM domain_policies")).toBe(1);
  });
});
