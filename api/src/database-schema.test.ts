// FILE: api/src/database-schema.test.ts
// Tests for the initial schema: constraints, cascades, immutability rules, and the scheduler index.
import initSqlJs, { type Database, type SqlValue } from "sql.js";
import { beforeEach, describe, expect, it } from "vitest";
import schemaSql from "../migrations/0001_initial_schema.sql?raw";

const SQL = await initSqlJs();
const T = "2026-01-01T00:00:00.000Z";

let db: Database;

function rows(
  sql: string,
  params: SqlValue[] = [],
): Record<string, SqlValue>[] {
  const statement = db.prepare(sql, params);
  const result: Record<string, SqlValue>[] = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function count(table: string): number {
  return Number(rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.["n"]);
}

// Inserts one competitor with a page, two snapshots, a change, an analysis, and a review; returns their ids.
function seedChain() {
  db.run("INSERT INTO competitors (name) VALUES ('Acme')");
  db.run(
    "INSERT INTO monitored_pages (competitor_id, url, category) VALUES (1, 'https://example.test/pricing', 'marketing')",
  );
  for (const hash of ["h1", "h2"]) {
    db.run(
      "INSERT INTO snapshots (monitored_page_id, content_hash, final_url, main_text, http_status, html_bytes, fetched_at) VALUES (1, ?, 'https://example.test/pricing', 'text', 200, 100, ?)",
      [hash, T],
    );
  }
  db.run(
    "INSERT INTO changes (monitored_page_id, from_snapshot_id, to_snapshot_id, change_type, diff_json) VALUES (1, 1, 2, 'text', '{}')",
  );
  db.run(
    "INSERT INTO ai_analyses (change_id, status, model, prompt_version) VALUES (1, 'succeeded', 'model-a', 'v1')",
  );
  db.run(
    "INSERT INTO review_actions (analysis_id, state, note) VALUES (1, 'approved', 'looks right')",
  );
}

beforeEach(() => {
  db = new SQL.Database();
  db.run("PRAGMA foreign_keys = ON");
  db.exec(schemaSql);
});

describe("schema creation", () => {
  it("creates the expected tables", () => {
    const names = rows(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).map((row) => row["name"]);
    expect(names).toEqual([
      "ai_analyses",
      "changes",
      "competitors",
      "monitored_pages",
      "monitoring_runs",
      "review_actions",
      "snapshots",
      "usage_counters",
    ]);
  });

  it("stores timestamps as UTC ISO 8601 text by default", () => {
    db.run("INSERT INTO competitors (name) VALUES ('Acme')");
    expect(
      String(rows("SELECT created_at FROM competitors")[0]?.["created_at"]),
    ).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("constraints", () => {
  it("rejects competitor names that differ only by case", () => {
    db.run("INSERT INTO competitors (name) VALUES ('Acme')");
    expect(() =>
      db.run("INSERT INTO competitors (name) VALUES ('ACME')"),
    ).toThrow(/UNIQUE/);
  });

  it("accepts only http and https page URLs", () => {
    db.run("INSERT INTO competitors (name) VALUES ('Acme')");
    const insert = (url: string) =>
      db.run(
        "INSERT INTO monitored_pages (competitor_id, url, category) VALUES (1, ?, 'marketing')",
        [url],
      );
    expect(() => insert("ftp://example.test/file")).toThrow(/CHECK/);
    expect(() => insert("javascript:alert(1)")).toThrow(/CHECK/);
    expect(() => insert("https://example.test/a")).not.toThrow();
  });

  it("rejects a duplicate URL for the same competitor", () => {
    db.run("INSERT INTO competitors (name) VALUES ('Acme')");
    const insert = () =>
      db.run(
        "INSERT INTO monitored_pages (competitor_id, url, category) VALUES (1, 'https://example.test/a', 'product')",
      );
    insert();
    expect(insert).toThrow(/UNIQUE/);
  });

  it("enforces foreign keys", () => {
    expect(() =>
      db.run(
        "INSERT INTO monitored_pages (competitor_id, url, category) VALUES (99, 'https://example.test/a', 'product')",
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it("limits review states and confidence ranges", () => {
    seedChain();
    expect(() =>
      db.run(
        "INSERT INTO review_actions (analysis_id, state) VALUES (1, 'maybe')",
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      db.run(
        "INSERT INTO ai_analyses (change_id, status, model, prompt_version, confidence) VALUES (1, 'succeeded', 'm', 'v1', 1.5)",
      ),
    ).toThrow(/CHECK/);
  });
});

describe("immutability and review history", () => {
  it("refuses to edit snapshots, analyses, or review actions", () => {
    seedChain();
    expect(() =>
      db.run("UPDATE snapshots SET main_text = 'edited' WHERE id = 1"),
    ).toThrow(/immutable/);
    expect(() =>
      db.run("UPDATE ai_analyses SET model = 'other' WHERE id = 1"),
    ).toThrow(/immutable/);
    expect(() =>
      db.run("UPDATE review_actions SET state = 'rejected' WHERE id = 1"),
    ).toThrow(/append-only/);
  });

  it("keeps an earlier human decision when a re-analysis is added", () => {
    seedChain();
    db.run(
      "INSERT INTO ai_analyses (change_id, status, model, prompt_version) VALUES (1, 'succeeded', 'model-b', 'v2')",
    );

    const states = rows(
      "SELECT a.id AS analysis_id, (SELECT state FROM review_actions r WHERE r.analysis_id = a.id ORDER BY r.id DESC LIMIT 1) AS state FROM ai_analyses a ORDER BY a.id",
    );
    expect(states).toEqual([
      { analysis_id: 1, state: "approved" },
      { analysis_id: 2, state: null },
    ]);
  });

  it("derives the current state from the latest review action", () => {
    seedChain();
    db.run(
      "INSERT INTO review_actions (analysis_id, state, note) VALUES (1, 'needs_review', 'check the source')",
    );
    const latest = rows(
      "SELECT state FROM review_actions WHERE analysis_id = 1 ORDER BY id DESC LIMIT 1",
    );
    expect(latest[0]?.["state"]).toBe("needs_review");
    expect(count("review_actions")).toBe(2);
  });
});

describe("cascades", () => {
  it("removes everything under a competitor when it is deleted", () => {
    seedChain();
    db.run("DELETE FROM competitors WHERE id = 1");
    for (const table of [
      "monitored_pages",
      "snapshots",
      "changes",
      "ai_analyses",
      "review_actions",
    ]) {
      expect(count(table)).toBe(0);
    }
  });

  it("keeps a monitoring run while snapshots still reference it", () => {
    db.run("INSERT INTO monitoring_runs (trigger_type) VALUES ('manual')");
    db.run("INSERT INTO competitors (name) VALUES ('Acme')");
    db.run(
      "INSERT INTO monitored_pages (competitor_id, url, category) VALUES (1, 'https://example.test/a', 'product')",
    );
    db.run(
      "INSERT INTO snapshots (monitored_page_id, run_id, content_hash, final_url, main_text, http_status, html_bytes, fetched_at) VALUES (1, 1, 'h1', 'https://example.test/a', 'text', 200, 10, ?)",
      [T],
    );

    expect(() => db.run("DELETE FROM monitoring_runs WHERE id = 1")).toThrow(
      /FOREIGN KEY/,
    );
    db.run("DELETE FROM competitors WHERE id = 1");
    expect(() =>
      db.run("DELETE FROM monitoring_runs WHERE id = 1"),
    ).not.toThrow();
  });
});

describe("scheduler lookup and usage counters", () => {
  it("finds the next due page through the partial index", () => {
    seedChain();
    db.run("UPDATE monitored_pages SET next_check_at = ? WHERE id = 1", [T]);
    const plan = rows(
      "EXPLAIN QUERY PLAN SELECT id FROM monitored_pages WHERE is_active = 1 AND next_check_at <= ? ORDER BY next_check_at LIMIT 1",
      ["2027-01-01T00:00:00.000Z"],
    );
    expect(plan.map((row) => String(row["detail"])).join(" ")).toContain(
      "idx_monitored_pages_due",
    );
  });

  it("accumulates a daily counter with an upsert", () => {
    const bump = (amount: number) =>
      db.run(
        "INSERT INTO usage_counters (day, scope, metric, value) VALUES ('2026-11-21', 'owner', 'neurons', ?) ON CONFLICT (day, scope, metric) DO UPDATE SET value = value + excluded.value",
        [amount],
      );
    bump(62);
    bump(18);
    expect(rows("SELECT value FROM usage_counters")[0]?.["value"]).toBe(80);
  });
});
