// FILE: api/src/api-routes.ts
// REST route definitions for the API Worker.
import { Hono } from "hono";
import { authRoutes, requireOwner, type AppEnv } from "./owner-auth";

export type DatabaseStatus = "ok" | "unavailable";

export interface HealthResponse {
  status: "ok" | "degraded";
  databases: { private: DatabaseStatus; demo: DatabaseStatus };
  timestamp: string;
}

// Confirms a database binding is reachable with a trivial query.
async function checkDatabase(db: D1Database): Promise<DatabaseStatus> {
  try {
    await db.prepare("SELECT 1").first();
    return "ok";
  } catch {
    return "unavailable";
  }
}

export const app = new Hono<AppEnv>();

// The frontend is served from the same origin, so no cross-origin (CORS) access is configured.

app.route("/api/auth", authRoutes);

// Everything under /api/owner requires a valid owner session.
app.use("/api/owner/*", requireOwner);
app.get("/api/owner/me", (c) => c.json({ role: "owner" }));

app.get("/api/health", async (c) => {
  const [privateStatus, demoStatus] = await Promise.all([
    checkDatabase(c.env.DB_PRIVATE),
    checkDatabase(c.env.DB_DEMO),
  ]);
  const healthy = privateStatus === "ok" && demoStatus === "ok";
  const body: HealthResponse = {
    status: healthy ? "ok" : "degraded",
    databases: { private: privateStatus, demo: demoStatus },
    timestamp: new Date().toISOString(),
  };
  return c.json(body, healthy ? 200 : 503);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

// Error details stay in the Worker logs; the client receives a generic message.
app.onError((error, c) => {
  console.error("Unhandled API error:", error.message);
  return c.json({ error: "internal_error" }, 500);
});
