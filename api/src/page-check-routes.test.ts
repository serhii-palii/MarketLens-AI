// FILE: api/src/page-check-routes.test.ts
// Tests for the owner routes that run a page check and read snapshots, with the network simulated.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "./api-routes";
import { createSessionToken } from "./owner-auth";
import { createTestDatabase, type TestDatabase } from "./test-database";

const SESSION_SECRET = "b2".repeat(32);
const PAGE_URL = "https://acme.example.com/pricing";

let testDb: TestDatabase;
let env: Env;
let cookie: string;
let siteHtml: string;
let dnsAddress: string;
let robotsText: string | null;
let pageStatus: number;

// Simulates DNS answers, robots.txt, and the page for the one test site.
function installNetwork() {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.hostname === "cloudflare-dns.com") {
        const isA = url.searchParams.get("type") === "A";
        const answers = isA ? [{ type: 1, data: dnsAddress }] : [];
        return Response.json({ Status: 0, Answer: answers });
      }
      if (url.pathname === "/robots.txt")
        return robotsText === null
          ? new Response("none", { status: 404 })
          : new Response(robotsText);
      return new Response(siteHtml, {
        status: pageStatus,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  );
}

beforeEach(async () => {
  testDb = createTestDatabase();
  env = {
    DB_PRIVATE: testDb.database,
    DB_DEMO: createTestDatabase().database,
    OWNER_ACCESS_KEY: "a1".repeat(32),
    SESSION_SECRET,
  };
  cookie = `ml_session=${await createSessionToken(SESSION_SECRET, new Date())}`;
  siteHtml =
    "<html><head><title>Pricing</title></head><body><h1>Plans</h1><p>Pro plan: $59 per user.</p></body></html>";
  dnsAddress = "93.184.216.34";
  robotsText = null;
  pageStatus = 200;
  installNetwork();
  testDb.raw.run("INSERT INTO competitors (name) VALUES ('Acme')");
  testDb.raw.run(
    "INSERT INTO monitored_pages (competitor_id, url, category) VALUES (1, ?, 'marketing')",
    [PAGE_URL],
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function call(
  method: string,
  path: string,
  options: { auth?: boolean; body?: boolean } = {},
) {
  const headers: Record<string, string> = {};
  if (options.auth !== false) headers["cookie"] = cookie;
  if (options.body !== false && method === "POST")
    headers["content-type"] = "application/json";
  const response = await app.request(
    `/api/owner${path}`,
    { method, headers, body: method === "POST" ? "{}" : undefined },
    env,
  );
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

describe("running a check", () => {
  it("requires an owner session and a JSON request", async () => {
    expect((await call("POST", "/pages/1/check", { auth: false })).status).toBe(
      401,
    );
    expect((await call("POST", "/pages/1/check", { body: false })).status).toBe(
      415,
    );
  });

  it("rejects bad ids and unknown pages", async () => {
    expect((await call("POST", "/pages/abc/check")).status).toBe(400);
    expect((await call("POST", "/pages/99/check")).status).toBe(404);
  });

  it("stores a first snapshot, then reports an unchanged page, then a changed one", async () => {
    const first = await call("POST", "/pages/1/check");
    expect(first.status).toBe(200);
    expect(first.json["result"]).toMatchObject({
      outcome: "first_snapshot",
      httpStatus: 200,
      truncated: false,
    });

    const second = await call("POST", "/pages/1/check");
    expect(second.json["result"]).toMatchObject({ outcome: "unchanged" });

    siteHtml = siteHtml.replace("$59", "$69");
    const third = await call("POST", "/pages/1/check");
    expect(third.json["result"]).toMatchObject({ outcome: "new_snapshot" });

    const list = await call("GET", "/pages/1/snapshots");
    expect(list.json["snapshots"]).toHaveLength(2);
  });

  it("returns snapshot details", async () => {
    const result = (await call("POST", "/pages/1/check")).json["result"] as {
      snapshotId: number;
    };
    const detail = await call("GET", `/snapshots/${result.snapshotId}`);
    expect(detail.status).toBe(200);
    expect(detail.json["snapshot"]).toMatchObject({
      title: "Pricing",
      headings: ["Plans"],
      finalUrl: PAGE_URL,
    });
    expect((await call("GET", "/snapshots/999")).status).toBe(404);
    expect((await call("GET", "/pages/99/snapshots")).status).toBe(404);
  });

  it("reports fetch failures as results with the reason", async () => {
    pageStatus = 500;
    expect((await call("POST", "/pages/1/check")).json["result"]).toMatchObject(
      { outcome: "failed", reason: "http_error", httpStatus: 500 },
    );

    // The earlier robots.txt answer is cached for a day, so clear it to let the new rules be read.
    testDb.raw.run("DELETE FROM domain_policies");
    pageStatus = 200;
    robotsText = "User-agent: *\nDisallow: /pricing";
    expect((await call("POST", "/pages/1/check")).json["result"]).toMatchObject(
      { outcome: "failed", reason: "robots_disallowed" },
    );
  });

  it("refuses a site that resolves to a private address", async () => {
    dnsAddress = "10.0.0.5";
    expect((await call("POST", "/pages/1/check")).json["result"]).toMatchObject(
      { outcome: "failed", reason: "non_public_address" },
    );
  });

  it("requires a session for snapshot routes", async () => {
    expect(
      (await call("GET", "/pages/1/snapshots", { auth: false })).status,
    ).toBe(401);
    expect((await call("GET", "/snapshots/1", { auth: false })).status).toBe(
      401,
    );
  });
});
