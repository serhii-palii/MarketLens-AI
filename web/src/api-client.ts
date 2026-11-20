// FILE: web/src/api-client.ts
// Typed helpers for calling the backend API.

export type DatabaseStatus = "ok" | "unavailable";

export interface HealthResponse {
  status: "ok" | "degraded";
  databases: { private: DatabaseStatus; demo: DatabaseStatus };
  timestamp: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDatabaseStatus(value: unknown): value is DatabaseStatus {
  return value === "ok" || value === "unavailable";
}

// Runtime check for the health payload; the API is an external boundary.
function isHealthResponse(value: unknown): value is HealthResponse {
  if (!isRecord(value)) return false;
  const databases = value["databases"];
  return (
    (value["status"] === "ok" || value["status"] === "degraded") &&
    isRecord(databases) &&
    isDatabaseStatus(databases["private"]) &&
    isDatabaseStatus(databases["demo"]) &&
    typeof value["timestamp"] === "string"
  );
}

// A degraded API still answers with a valid payload (HTTP 503), so the body is parsed either way.
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch("/api/health", { signal });
  const body: unknown = await response.json();
  if (!isHealthResponse(body)) throw new Error("The API returned an unexpected response.");
  return body;
}
