// FILE: api/src/owner-auth.test.ts
// Tests for access-key checks, session tokens, and the login, logout, and owner-guard routes.
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "./api-routes";
import {
  MAX_LOGIN_FAILURES_PER_DAY,
  SESSION_TTL_SECONDS,
  createSessionToken,
  keysMatch,
  verifySessionToken,
} from "./owner-auth";
import { createTestDatabase, type TestDatabase } from "./test-database";

const OWNER_KEY = "a1".repeat(32);
const SESSION_SECRET = "b2".repeat(32);
const NOW = new Date("2026-11-21T12:00:00.000Z");

describe("keysMatch", () => {
  it("accepts only the exact key", async () => {
    expect(await keysMatch(OWNER_KEY, OWNER_KEY)).toBe(true);
    expect(await keysMatch(OWNER_KEY.slice(0, -1), OWNER_KEY)).toBe(false);
    expect(await keysMatch(`${OWNER_KEY}x`, OWNER_KEY)).toBe(false);
    expect(await keysMatch("", OWNER_KEY)).toBe(false);
  });
});

describe("session tokens", () => {
  it("verify before they expire", async () => {
    const token = await createSessionToken(SESSION_SECRET, NOW);
    expect(await verifySessionToken(token, SESSION_SECRET, NOW)).toBe(true);
    const almostExpired = new Date(
      NOW.getTime() + (SESSION_TTL_SECONDS - 1) * 1000,
    );
    expect(await verifySessionToken(token, SESSION_SECRET, almostExpired)).toBe(
      true,
    );
  });

  it("are rejected after they expire", async () => {
    const token = await createSessionToken(SESSION_SECRET, NOW);
    const expired = new Date(NOW.getTime() + (SESSION_TTL_SECONDS + 1) * 1000);
    expect(await verifySessionToken(token, SESSION_SECRET, expired)).toBe(
      false,
    );
  });

  it("are rejected with a different secret", async () => {
    const token = await createSessionToken(SESSION_SECRET, NOW);
    expect(await verifySessionToken(token, "c3".repeat(32), NOW)).toBe(false);
  });

  it("are rejected when the payload or signature is altered", async () => {
    const token = await createSessionToken(SESSION_SECRET, NOW);
    const [body = "", signature = ""] = token.split(".");
    const forgedBody = btoa(
      JSON.stringify({ sub: "owner", iat: 0, exp: 99999999999 }),
    ).replace(/=+$/, "");
    expect(
      await verifySessionToken(
        `${forgedBody}.${signature}`,
        SESSION_SECRET,
        NOW,
      ),
    ).toBe(false);
    expect(
      await verifySessionToken(
        `${body}.${signature.slice(0, -2)}AA`,
        SESSION_SECRET,
        NOW,
      ),
    ).toBe(false);
    expect(await verifySessionToken("not-a-token", SESSION_SECRET, NOW)).toBe(
      false,
    );
    expect(await verifySessionToken("", SESSION_SECRET, NOW)).toBe(false);
  });
});

describe("auth routes", () => {
  let testDb: TestDatabase;
  let env: Env;

  beforeEach(() => {
    testDb = createTestDatabase();
    env = {
      DB_PRIVATE: testDb.database,
      DB_DEMO: createTestDatabase().database,
      OWNER_ACCESS_KEY: OWNER_KEY,
      SESSION_SECRET,
    };
  });

  const login = (
    accessKey: string,
    headers: Record<string, string> = {},
    url = "/api/auth/login",
  ) =>
    app.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ accessKey }),
      },
      env,
    );

  const sessionCookie = (response: Response): string => {
    const match = /ml_session=([^;]+)/.exec(
      response.headers.get("set-cookie") ?? "",
    );
    return match?.[1] ?? "";
  };

  it("sets a restricted session cookie on a correct key", async () => {
    const response = await login(OWNER_KEY);
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api");
    expect(cookie).not.toContain("Secure");
  });

  it("marks the cookie Secure over HTTPS", async () => {
    const response = await login(
      OWNER_KEY,
      {},
      "https://app.example.test/api/auth/login",
    );
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("rejects a wrong key without a cookie", async () => {
    const response = await login("wrong-key");
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ error: "invalid_credentials" });
  });

  it("rejects malformed requests", async () => {
    const notJson = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "accessKey=x",
      },
      env,
    );
    expect(notJson.status).toBe(415);

    const badBody = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wrong: 1 }),
      },
      env,
    );
    expect(badBody.status).toBe(400);
  });

  it("fails closed when the secrets are missing, short, or still placeholders", async () => {
    for (const value of [
      "too-short",
      "replace-with-a-random-64-character-hex-string",
      "",
    ]) {
      env = { ...env, OWNER_ACCESS_KEY: value };
      expect((await login(value)).status).toBe(503);
    }
    env = {
      ...env,
      OWNER_ACCESS_KEY: OWNER_KEY,
      SESSION_SECRET: "replace-with-a-different-random-64-character-hex-string",
    };
    expect((await login(OWNER_KEY)).status).toBe(503);
  });

  it("locks out an address after repeated failures, but not other addresses", async () => {
    const attacker = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_DAY; i += 1) {
      expect((await login("wrong-key", attacker)).status).toBe(401);
    }
    expect((await login(OWNER_KEY, attacker)).status).toBe(429);
    expect(
      (await login(OWNER_KEY, { "cf-connecting-ip": "203.0.113.10" })).status,
    ).toBe(200);
  });

  it("stores no raw addresses in the counters", async () => {
    await login("wrong-key", { "cf-connecting-ip": "203.0.113.9" });
    const scopes =
      testDb.raw
        .exec("SELECT scope FROM usage_counters")[0]
        ?.values.flat()
        .join(" ") ?? "";
    expect(scopes).toMatch(/^login:[0-9a-f]{16}$/);
    expect(scopes).not.toContain("203.0.113.9");
  });

  it("guards owner routes with the session cookie", async () => {
    expect((await app.request("/api/owner/me", {}, env)).status).toBe(401);

    const cookie = sessionCookie(await login(OWNER_KEY));
    const allowed = await app.request(
      "/api/owner/me",
      { headers: { cookie: `ml_session=${cookie}` } },
      env,
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ role: "owner" });

    const forged = await app.request(
      "/api/owner/me",
      { headers: { cookie: "ml_session=forged.token" } },
      env,
    );
    expect(forged.status).toBe(401);
  });

  it("reports the session state and clears the cookie on logout", async () => {
    const cookie = sessionCookie(await login(OWNER_KEY));
    const active = await app.request(
      "/api/auth/session",
      { headers: { cookie: `ml_session=${cookie}` } },
      env,
    );
    expect(await active.json()).toEqual({ authenticated: true });
    expect(
      await (await app.request("/api/auth/session", {}, env)).json(),
    ).toEqual({ authenticated: false });

    const logout = await app.request(
      "/api/auth/logout",
      { method: "POST" },
      env,
    );
    expect(logout.headers.get("set-cookie")).toMatch(/ml_session=;/);
  });
});
