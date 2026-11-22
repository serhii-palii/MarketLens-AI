// FILE: api/src/api-routes.test.ts
// Tests for the health endpoint, cross-origin behavior, and error responses.
import { describe, expect, it } from "vitest";
import { app, type HealthResponse } from "./api-routes";

// Implements only the query path used by the health check.
function fakeDatabase(reachable: boolean): D1Database {
  const statement = {
    first: async () => {
      if (!reachable) throw new Error("database unreachable");
      return { "1": 1 };
    },
  };
  return { prepare: () => statement } as unknown as D1Database;
}

function buildEnv(options: { demoReachable?: boolean } = {}): Env {
  return {
    DB_PRIVATE: fakeDatabase(true),
    DB_DEMO: fakeDatabase(options.demoReachable ?? true),
    OWNER_ACCESS_KEY: "k".repeat(64),
    SESSION_SECRET: "s".repeat(64),
  };
}

describe("GET /api/health", () => {
  it("reports ok when both databases respond", async () => {
    const response = await app.request("/api/health", {}, buildEnv());
    const body = (await response.json()) as HealthResponse;

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.databases).toEqual({ private: "ok", demo: "ok" });
  });

  it("reports degraded with a 503 when a database is unavailable", async () => {
    const response = await app.request(
      "/api/health",
      {},
      buildEnv({ demoReachable: false }),
    );
    const body = (await response.json()) as HealthResponse;

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.databases).toEqual({ private: "ok", demo: "unavailable" });
  });

  it("does not grant cross-origin access to other sites", async () => {
    const response = await app.request(
      "/api/health",
      { headers: { Origin: "https://other-site.example.test" } },
      buildEnv(),
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("unknown routes", () => {
  it("return a JSON 404", async () => {
    const response = await app.request("/api/missing", {}, buildEnv());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
