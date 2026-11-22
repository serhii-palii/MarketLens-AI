// FILE: api/src/owner-routes.test.ts
// Tests for owner-only competitor and monitored-page management: access, validation, conflicts, and cascades.
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "./api-routes";
import type { CompetitorRecord, PageRecord } from "./database";
import { createSessionToken } from "./owner-auth";
import { createTestDatabase, type TestDatabase } from "./test-database";

const SESSION_SECRET = "b2".repeat(32);

interface ApiBody {
  error?: string;
  competitor?: CompetitorRecord;
  competitors?: CompetitorRecord[];
  page?: PageRecord;
  pages?: PageRecord[];
}

let testDb: TestDatabase;
let env: Env;
let cookie: string;

beforeEach(async () => {
  testDb = createTestDatabase();
  env = {
    DB_PRIVATE: testDb.database,
    DB_DEMO: createTestDatabase().database,
    OWNER_ACCESS_KEY: "a1".repeat(32),
    SESSION_SECRET,
  };
  cookie = `ml_session=${await createSessionToken(SESSION_SECRET, new Date())}`;
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  options: { auth?: boolean; contentType?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.auth !== false) headers["cookie"] = cookie;
  if (body !== undefined)
    headers["content-type"] = options.contentType ?? "application/json";
  const response = await app.request(
    `/api/owner${path}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
  const text = await response.text();
  return {
    status: response.status,
    json: (text ? JSON.parse(text) : {}) as ApiBody,
  };
}

const rowCount = (table: string): number =>
  Number(testDb.raw.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0]);

async function createCompetitor(name = "Acme"): Promise<number> {
  const id = (await call("POST", "/competitors", { name })).json.competitor?.id;
  if (id === undefined)
    throw new Error("Test setup failed: competitor was not created.");
  return id;
}

async function createPageFor(
  competitorId: number,
  url: string,
  category = "product",
): Promise<PageRecord> {
  const page = (
    await call("POST", `/competitors/${competitorId}/pages`, { url, category })
  ).json.page;
  if (!page) throw new Error("Test setup failed: page was not created.");
  return page;
}

describe("access", () => {
  it("requires an owner session for every route", async () => {
    expect(
      (await call("GET", "/competitors", undefined, { auth: false })).status,
    ).toBe(401);
    expect(
      (await call("POST", "/competitors", { name: "Acme" }, { auth: false }))
        .status,
    ).toBe(401);
    expect(
      (await call("DELETE", "/pages/1", undefined, { auth: false })).status,
    ).toBe(401);
    expect(rowCount("competitors")).toBe(0);
  });

  it("rejects request bodies that are not JSON", async () => {
    const result = await call(
      "POST",
      "/competitors",
      { name: "Acme" },
      { contentType: "text/plain" },
    );
    expect(result.status).toBe(415);
  });
});

describe("competitors", () => {
  it("creates, lists, reads, updates, and deletes a competitor", async () => {
    const created = await call("POST", "/competitors", {
      name: "  Acme Analytics  ",
      websiteUrl: "https://acme.example.test/#top",
      notes: "Main rival",
    });
    expect(created.status).toBe(201);
    expect(created.json.competitor).toMatchObject({
      name: "Acme Analytics",
      websiteUrl: "https://acme.example.test/",
      notes: "Main rival",
      isActive: true,
      pageCount: 0,
    });
    const id = created.json.competitor?.id ?? 0;

    expect((await call("GET", "/competitors")).json.competitors).toHaveLength(
      1,
    );
    expect(
      (await call("GET", `/competitors/${id}`)).json.competitor?.name,
    ).toBe("Acme Analytics");

    const updated = await call("PATCH", `/competitors/${id}`, {
      notes: "Updated",
      isActive: false,
    });
    expect(updated.json.competitor).toMatchObject({
      notes: "Updated",
      isActive: false,
      name: "Acme Analytics",
    });

    expect((await call("DELETE", `/competitors/${id}`)).status).toBe(204);
    expect((await call("GET", `/competitors/${id}`)).status).toBe(404);
    expect((await call("DELETE", `/competitors/${id}`)).status).toBe(404);
  });

  it("validates input without echoing values", async () => {
    for (const body of [
      {},
      { name: "   " },
      { name: "x", extra: 1 },
      { name: "x", websiteUrl: "ftp://files.example.test" },
      { name: "x".repeat(121) },
    ]) {
      const result = await call("POST", "/competitors", body);
      expect(result.status).toBe(400);
      expect(result.json.error).toBe("invalid_request");
    }
    expect(rowCount("competitors")).toBe(0);
  });

  it("rejects duplicate names regardless of case", async () => {
    await createCompetitor("Acme");
    const duplicate = await call("POST", "/competitors", { name: "ACME" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json).toEqual({ error: "duplicate_name" });

    const other = await createCompetitor("Globex");
    expect(
      (await call("PATCH", `/competitors/${other}`, { name: "acme" })).status,
    ).toBe(409);
  });

  it("rejects empty updates and malformed ids", async () => {
    const id = await createCompetitor();
    expect((await call("PATCH", `/competitors/${id}`, {})).status).toBe(400);
    expect(
      (await call("PATCH", "/competitors/999", { notes: "x" })).status,
    ).toBe(404);
    expect((await call("GET", "/competitors/abc")).status).toBe(400);
    expect((await call("GET", "/competitors/0")).status).toBe(400);
    expect(
      (await call("GET", "/competitors/1;DROP TABLE competitors")).status,
    ).toBe(400);
  });

  it("treats SQL-looking text as plain data", async () => {
    const name = "Robert'); DROP TABLE competitors;--";
    expect((await call("POST", "/competitors", { name })).status).toBe(201);
    expect(rowCount("competitors")).toBe(1);
  });
});

describe("monitored pages", () => {
  it("creates a normalized page that is due immediately", async () => {
    const competitorId = await createCompetitor();
    const created = await call("POST", `/competitors/${competitorId}/pages`, {
      url: " https://Acme.example.test/pricing#plans ",
      category: "marketing",
      label: "Pricing",
    });

    expect(created.status).toBe(201);
    const page = created.json.page;
    expect(page).toMatchObject({
      competitorId,
      url: "https://acme.example.test/pricing",
      label: "Pricing",
      category: "marketing",
      checkIntervalHours: 24,
      isActive: true,
    });
    expect(page?.nextCheckAt).toBe(page?.createdAt);
    expect(
      (await call("GET", `/competitors/${competitorId}`)).json.competitor
        ?.pageCount,
    ).toBe(1);
  });

  it("rejects unsafe or malformed page input", async () => {
    const id = await createCompetitor();
    const bodies = [
      { url: "ftp://acme.example.test/file", category: "marketing" },
      { url: "javascript:alert(1)", category: "marketing" },
      { url: "https://user:secret@acme.example.test/", category: "marketing" },
      { url: "not a url", category: "marketing" },
      { url: "https://acme.example.test/", category: "sales" },
      {
        url: "https://acme.example.test/",
        category: "marketing",
        checkIntervalHours: 0,
      },
      {
        url: "https://acme.example.test/",
        category: "marketing",
        checkIntervalHours: 1.5,
      },
    ];
    for (const body of bodies)
      expect(
        (await call("POST", `/competitors/${id}/pages`, body)).status,
      ).toBe(400);
    expect(rowCount("monitored_pages")).toBe(0);
  });

  it("treats the same address with a different fragment as a duplicate", async () => {
    const id = await createCompetitor();
    const body = {
      url: "https://acme.example.test/pricing",
      category: "marketing",
    };
    expect((await call("POST", `/competitors/${id}/pages`, body)).status).toBe(
      201,
    );
    const duplicate = await call("POST", `/competitors/${id}/pages`, {
      ...body,
      url: "https://acme.example.test/pricing#x",
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json).toEqual({ error: "duplicate_url" });
  });

  it("returns 404 for a page under an unknown competitor", async () => {
    const result = await call("POST", "/competitors/999/pages", {
      url: "https://acme.example.test/",
      category: "product",
    });
    expect(result.status).toBe(404);
  });

  it("lists, updates, and deletes pages", async () => {
    const id = await createCompetitor();
    const pageId = (await createPageFor(id, "https://acme.example.test/a")).id;
    await createPageFor(id, "https://acme.example.test/b", "marketing");

    expect(
      (await call("GET", `/competitors/${id}/pages`)).json.pages,
    ).toHaveLength(2);

    const updated = await call("PATCH", `/pages/${pageId}`, {
      label: "Docs",
      category: "marketing",
      checkIntervalHours: 6,
      isActive: false,
    });
    expect(updated.json.page).toMatchObject({
      label: "Docs",
      category: "marketing",
      checkIntervalHours: 6,
      isActive: false,
    });
    expect(
      (
        await call("PATCH", `/pages/${pageId}`, {
          url: "https://other.example.test/",
        })
      ).status,
    ).toBe(400);
    expect((await call("PATCH", `/pages/${pageId}`, {})).status).toBe(400);

    expect((await call("DELETE", `/pages/${pageId}`)).status).toBe(204);
    expect((await call("GET", `/pages/${pageId}`)).status).toBe(404);
    expect(rowCount("monitored_pages")).toBe(1);
  });

  it("schedules a reactivated page that was never scheduled", async () => {
    const id = await createCompetitor();
    const pageId = (await createPageFor(id, "https://acme.example.test/a")).id;
    testDb.raw.run(
      "UPDATE monitored_pages SET next_check_at = NULL, is_active = 0 WHERE id = ?",
      [pageId],
    );

    const reactivated = await call("PATCH", `/pages/${pageId}`, {
      isActive: true,
    });
    expect(reactivated.json.page?.nextCheckAt).not.toBeNull();
  });

  it("removes a competitor's pages together with the competitor", async () => {
    const id = await createCompetitor();
    await createPageFor(id, "https://acme.example.test/a");
    expect((await call("DELETE", `/competitors/${id}`)).status).toBe(204);
    expect(rowCount("monitored_pages")).toBe(0);
  });
});
