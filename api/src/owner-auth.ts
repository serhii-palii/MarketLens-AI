// FILE: api/src/owner-auth.ts
// Owner-only authentication: access-key login, signed session cookies, and the guard for owner routes.
import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { loginRequestSchema } from "./schemas";
import { incrementCounter, readCounter, utcDay } from "./usage-limits";

export type AppEnv = { Bindings: Env };

export const SESSION_COOKIE = "ml_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const MAX_LOGIN_FAILURES_PER_DAY = 10;
const SECRET_PATTERN = /^[0-9a-f]{32,}$/i;
const CLOCK_SKEW_SECONDS = 60;

const encoder = new TextEncoder();

const sessionPayloadSchema = z.object({
  sub: z.literal("owner"),
  iat: z.number().int(),
  exp: z.number().int(),
});

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// Compares SHA-256 digests so the comparison time does not depend on where the values differ or on their length.
export async function keysMatch(
  provided: string,
  expected: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

// Token format: base64url(payload JSON) + "." + base64url(HMAC-SHA256 signature of the first part).
export async function createSessionToken(
  secret: string,
  now: Date,
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = {
    sub: "owner",
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
  };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importHmacKey(secret),
    encoder.encode(body),
  );
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySessionToken(
  token: string,
  secret: string,
  now: Date,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [body, signaturePart] = parts;
  if (!body || !signaturePart) return false;

  const signature = fromBase64Url(signaturePart);
  if (!signature) return false;
  const signatureValid = await crypto.subtle.verify(
    "HMAC",
    await importHmacKey(secret),
    signature,
    encoder.encode(body),
  );
  if (!signatureValid) return false;

  const payloadBytes = fromBase64Url(body);
  if (!payloadBytes) return false;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return false;
  }
  const payload = sessionPayloadSchema.safeParse(json);
  if (!payload.success) return false;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  return (
    payload.data.exp > nowSeconds &&
    payload.data.iat <= nowSeconds + CLOCK_SKEW_SECONDS
  );
}

// Secrets must be hex strings of at least 32 characters, which also rejects the placeholder text in .dev.vars.example.
function secretsConfigured(env: Env): boolean {
  return (
    SECRET_PATTERN.test(env.OWNER_ACCESS_KEY) &&
    SECRET_PATTERN.test(env.SESSION_SECRET)
  );
}

// Counters use a short hash of the client address so raw addresses are not stored.
async function clientScope(address: string | undefined): Promise<string> {
  const digest = await sha256(address ?? "local");
  const hex = [...digest.slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `login:${hex}`;
}

export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const valid =
    token !== undefined &&
    secretsConfigured(c.env) &&
    (await verifySessionToken(token, c.env.SESSION_SECRET, new Date()));
  if (!valid) return c.json({ error: "unauthorized" }, 401);
  await next();
};

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/login", async (c) => {
  if (!secretsConfigured(c.env))
    return c.json({ error: "owner_access_not_configured" }, 503);
  // JSON-only bodies keep cross-site form posts from reaching the handler.
  if (
    !c.req.header("content-type")?.toLowerCase().startsWith("application/json")
  ) {
    return c.json({ error: "unsupported_media_type" }, 415);
  }
  const parsed = loginRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);

  const now = new Date();
  const day = utcDay(now);
  const scope = await clientScope(c.req.header("cf-connecting-ip"));
  if (
    (await readCounter(c.env.DB_PRIVATE, day, scope, "failures")) >=
    MAX_LOGIN_FAILURES_PER_DAY
  ) {
    return c.json({ error: "too_many_attempts" }, 429);
  }

  if (!(await keysMatch(parsed.data.accessKey, c.env.OWNER_ACCESS_KEY))) {
    await incrementCounter(c.env.DB_PRIVATE, day, scope, "failures", 1);
    return c.json({ error: "invalid_credentials" }, 401);
  }

  setCookie(
    c,
    SESSION_COOKIE,
    await createSessionToken(c.env.SESSION_SECRET, now),
    {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Strict",
      path: "/api",
      maxAge: SESSION_TTL_SECONDS,
    },
  );
  return c.json({ authenticated: true });
});

authRoutes.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/api" });
  return c.json({ authenticated: false });
});

authRoutes.get("/session", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const authenticated =
    token !== undefined &&
    secretsConfigured(c.env) &&
    (await verifySessionToken(token, c.env.SESSION_SECRET, new Date()));
  return c.json({ authenticated });
});
