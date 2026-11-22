// FILE: api/src/usage-limits.ts
// Daily counters used for login throttling and, later, AI budgets.

// Formats a date as the UTC day used as the counter key (YYYY-MM-DD).
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function readCounter(
  db: D1Database,
  day: string,
  scope: string,
  metric: string,
): Promise<number> {
  const value = await db
    .prepare(
      "SELECT value FROM usage_counters WHERE day = ? AND scope = ? AND metric = ?",
    )
    .bind(day, scope, metric)
    .first<number>("value");
  return value ?? 0;
}

export async function incrementCounter(
  db: D1Database,
  day: string,
  scope: string,
  metric: string,
  amount: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO usage_counters (day, scope, metric, value) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (day, scope, metric) DO UPDATE SET value = value + excluded.value",
    )
    .bind(day, scope, metric, amount)
    .run();
}
