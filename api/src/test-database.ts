// FILE: api/src/test-database.ts
// Test helper that exposes an in-memory SQLite database through the subset of the D1 interface the API uses.
import initSqlJs, {
  type Database as SqlJsDatabase,
  type SqlValue,
} from "sql.js";
import migration0001 from "../migrations/0001_initial_schema.sql?raw";
import migration0002 from "../migrations/0002_domain_policies.sql?raw";

// Applied in order, like the real migration runner.
export const MIGRATIONS = [migration0001, migration0002];

const SQL = await initSqlJs();

function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return String(value);
}

class TestStatement {
  private readonly db: SqlJsDatabase;
  private readonly sql: string;
  private readonly values: SqlValue[];

  constructor(db: SqlJsDatabase, sql: string, values: SqlValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: unknown[]): TestStatement {
    return new TestStatement(this.db, this.sql, values.map(toSqlValue));
  }

  private rows(): Record<string, SqlValue>[] {
    const statement = this.db.prepare(this.sql, this.values);
    const result: Record<string, SqlValue>[] = [];
    while (statement.step()) result.push(statement.getAsObject());
    statement.free();
    return result;
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.rows()[0];
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async all<T = Record<string, unknown>>() {
    return { results: this.rows() as T[], success: true, meta: {} };
  }

  async run() {
    this.db.run(this.sql, this.values);
    const lastRowId = Number(
      this.db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] ?? 0,
    );
    return {
      success: true,
      meta: { changes: this.db.getRowsModified(), last_row_id: lastRowId },
    };
  }
}

export interface TestDatabase {
  database: D1Database;
  raw: SqlJsDatabase;
}

// The cast is limited to this helper; only prepare, bind, first, all, run, and batch are implemented.
export function createTestDatabase(): TestDatabase {
  const raw = new SQL.Database();
  raw.run("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) raw.exec(migration);
  const database = {
    prepare: (sql: string) => new TestStatement(raw, sql),
    batch: async (statements: TestStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())),
  } as unknown as D1Database;
  return { database, raw };
}
