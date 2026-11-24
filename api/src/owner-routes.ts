// FILE: api/src/owner-routes.ts
// Owner-only routes for managing competitors and monitored pages.
import { Hono, type Context } from "hono";
import type { ZodError, ZodType } from "zod";
import { collectPage } from "./collection";
import {
  createCompetitor,
  createPage,
  deleteCompetitor,
  deletePage,
  getCompetitor,
  getPage,
  listCompetitors,
  listPages,
  updateCompetitor,
  updatePage,
} from "./database";
import { checkMonitoredPage } from "./monitoring";
import {
  createRobotsCache,
  getSnapshot,
  listSnapshots,
} from "./monitoring-store";
import type { AppEnv } from "./owner-auth";
import {
  createCompetitorSchema,
  createPageSchema,
  updateCompetitorSchema,
  updatePageSchema,
} from "./schemas";

type OwnerContext = Context<AppEnv>;

const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);

// Identifiers in paths are plain positive integers.
function parseId(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,12}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}

function invalidRequest(c: OwnerContext, error: ZodError) {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  return c.json({ error: "invalid_request", issues }, 400);
}

const notFound = (c: OwnerContext) => c.json({ error: "not_found" }, 404);
const badId = (c: OwnerContext) => c.json({ error: "invalid_id" }, 400);

async function readBody<T>(c: OwnerContext, schema: ZodType<T>) {
  return schema.safeParse(await c.req.json().catch(() => null));
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("UNIQUE constraint failed")
  );
}

export const ownerRoutes = new Hono<AppEnv>();

// JSON-only bodies keep cross-site form posts from reaching the handlers.
ownerRoutes.use("*", async (c, next) => {
  if (
    BODY_METHODS.has(c.req.method) &&
    !c.req.header("content-type")?.toLowerCase().startsWith("application/json")
  ) {
    return c.json({ error: "unsupported_media_type" }, 415);
  }
  await next();
});

ownerRoutes.get("/me", (c) => c.json({ role: "owner" }));

ownerRoutes.get("/competitors", async (c) =>
  c.json({ competitors: await listCompetitors(c.env.DB_PRIVATE) }),
);

ownerRoutes.post("/competitors", async (c) => {
  const body = await readBody(c, createCompetitorSchema);
  if (!body.success) return invalidRequest(c, body.error);
  try {
    const competitor = await createCompetitor(
      c.env.DB_PRIVATE,
      body.data,
      new Date().toISOString(),
    );
    return c.json({ competitor }, 201);
  } catch (error) {
    if (isUniqueViolation(error))
      return c.json({ error: "duplicate_name" }, 409);
    throw error;
  }
});

ownerRoutes.get("/competitors/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return badId(c);
  const competitor = await getCompetitor(c.env.DB_PRIVATE, id);
  return competitor ? c.json({ competitor }) : notFound(c);
});

ownerRoutes.patch("/competitors/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return badId(c);
  const body = await readBody(c, updateCompetitorSchema);
  if (!body.success) return invalidRequest(c, body.error);
  try {
    const competitor = await updateCompetitor(
      c.env.DB_PRIVATE,
      id,
      body.data,
      new Date().toISOString(),
    );
    return competitor ? c.json({ competitor }) : notFound(c);
  } catch (error) {
    if (isUniqueViolation(error))
      return c.json({ error: "duplicate_name" }, 409);
    throw error;
  }
});

ownerRoutes.delete("/competitors/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return badId(c);
  return (await deleteCompetitor(c.env.DB_PRIVATE, id))
    ? c.body(null, 204)
    : notFound(c);
});

ownerRoutes.get("/competitors/:id/pages", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return badId(c);
  if (!(await getCompetitor(c.env.DB_PRIVATE, id))) return notFound(c);
  return c.json({ pages: await listPages(c.env.DB_PRIVATE, id) });
});

ownerRoutes.post("/competitors/:id/pages", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return badId(c);
  const body = await readBody(c, createPageSchema);
  if (!body.success) return invalidRequest(c, body.error);
  if (!(await getCompetitor(c.env.DB_PRIVATE, id))) return notFound(c);
  try {
    const page = await createPage(
      c.env.DB_PRIVATE,
      id,
      body.data,
      new Date().toISOString(),
    );
    return c.json({ page }, 201);
  } catch (error) {
    if (isUniqueViolation(error))
      return c.json({ error: "duplicate_url" }, 409);
    throw error;
  }
});

ownerRoutes.get("/pages/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return badId(c);
  const page = await getPage(c.env.DB_PRIVATE, id);
  return page ? c.json({ page }) : notFound(c);
});

ownerRoutes.patch("/pages/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return badId(c);
  const body = await readBody(c, updatePageSchema);
  if (!body.success) return invalidRequest(c, body.error);
  const page = await updatePage(
    c.env.DB_PRIVATE,
    id,
    body.data,
    new Date().toISOString(),
  );
  return page ? c.json({ page }) : notFound(c);
});

ownerRoutes.delete("/pages/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return badId(c);
  return (await deletePage(c.env.DB_PRIVATE, id))
    ? c.body(null, 204)
    : notFound(c);
});

// Runs a check right now. The outcome (including a failed fetch) is returned with HTTP 200; only an unknown page is an error.
ownerRoutes.post("/pages/:id/check", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return badId(c);
  const db = c.env.DB_PRIVATE;
  const result = await checkMonitoredPage(db, id, "manual", {
    // The wrapper calls the global fetch without a receiver object, which the Workers runtime requires.
    collect: (url) =>
      collectPage(url, {
        fetch: (input, init) => fetch(input, init),
        robots: createRobotsCache(db),
      }),
    now: () => new Date(),
  });
  return result ? c.json({ result }) : notFound(c);
});

ownerRoutes.get("/pages/:id/snapshots", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return badId(c);
  if (!(await getPage(c.env.DB_PRIVATE, id))) return notFound(c);
  return c.json({ snapshots: await listSnapshots(c.env.DB_PRIVATE, id) });
});

// Snapshot text comes from external sites: clients must display it as plain text, never as HTML.
ownerRoutes.get("/snapshots/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return badId(c);
  const snapshot = await getSnapshot(c.env.DB_PRIVATE, id);
  return snapshot ? c.json({ snapshot }) : notFound(c);
});
