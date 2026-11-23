// FILE: api/src/collection.ts
// Safe page fetching: URL and DNS checks on every hop, robots.txt, redirect, time, size, and content-type limits.
import { isAllowedByRobots } from "./robots";
import { checkMonitoredUrl, isPublicIpAddress } from "./url-safety";

export const MAX_HTML_BYTES = 250_000;
export const MAX_REDIRECTS = 3;
export const REQUEST_TIMEOUT_MS = 8_000;
export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
export const USER_AGENT = "MarketLensBot/0.1";
const ROBOTS_AGENT = "marketlensbot";
const MAX_ROBOTS_BYTES = 100_000;
const DNS_TIMEOUT_MS = 3_000;
const DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FetchFailureReason =
  | "invalid_url"
  | "dns_failed"
  | "non_public_address"
  | "robots_disallowed"
  | "robots_unavailable"
  | "too_many_redirects"
  | "bad_redirect"
  | "http_error"
  | "unsupported_content_type"
  | "timeout"
  | "network_error";

export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
  bytesRead: number;
  truncated: boolean;
  redirects: string[];
}

export type CollectResult =
  | { ok: true; page: FetchedPage }
  | {
      ok: false;
      reason: FetchFailureReason;
      status?: number;
      finalUrl?: string;
    };

// Cached robots.txt content per origin. "allow_all" records a missing robots.txt.
export interface RobotsEntry {
  kind: "rules" | "allow_all";
  text: string;
  fetchedAtMs: number;
}

export interface RobotsCache {
  get(origin: string): Promise<RobotsEntry | null>;
  set(origin: string, entry: RobotsEntry): Promise<void>;
}

export interface CollectOptions {
  fetch: typeof fetch;
  robots: RobotsCache;
  nowMs?: () => number;
  maxBytes?: number;
}

type DnsOutcome =
  | { ok: true }
  | { ok: false; reason: "dns_failed" | "non_public_address" };
type HopResult =
  | { ok: true; response: Response }
  | { ok: false; reason: FetchFailureReason };

interface Context {
  options: CollectOptions;
  dns: Map<string, DnsOutcome>;
}

const failure = (
  reason: FetchFailureReason,
  extra: { status?: number; finalUrl?: string } = {},
): CollectResult => ({
  ok: false,
  reason,
  ...extra,
});

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

interface DnsAnswer {
  type?: number;
  data?: string;
}

// Returns the addresses of one record type, or null when the lookup itself failed.
async function lookup(
  hostname: string,
  type: "A" | "AAAA",
  doFetch: typeof fetch,
): Promise<string[] | null> {
  try {
    const response = await doFetch(
      `${DNS_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`,
      {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const body = await response.json<{ Answer?: DnsAnswer[] }>();
    const wanted = type === "A" ? 1 : 28;
    return (body.Answer ?? []).flatMap((answer) =>
      answer.type === wanted && typeof answer.data === "string"
        ? [answer.data]
        : [],
    );
  } catch {
    return null;
  }
}

// Every address a hostname resolves to must be public; one private answer rejects the host.
async function checkDns(
  hostname: string,
  context: Context,
): Promise<DnsOutcome> {
  const known = context.dns.get(hostname);
  if (known) return known;

  const [v4, v6] = await Promise.all([
    lookup(hostname, "A", context.options.fetch),
    lookup(hostname, "AAAA", context.options.fetch),
  ]);
  const addresses = [...(v4 ?? []), ...(v6 ?? [])];
  let outcome: DnsOutcome;
  if ((v4 === null && v6 === null) || addresses.length === 0)
    outcome = { ok: false, reason: "dns_failed" };
  else if (!addresses.every(isPublicIpAddress))
    outcome = { ok: false, reason: "non_public_address" };
  else outcome = { ok: true };
  context.dns.set(hostname, outcome);
  return outcome;
}

// One request without following redirects: the address is validated first, then fetched with a time limit.
async function fetchHop(url: string, context: Context): Promise<HopResult> {
  const checked = checkMonitoredUrl(url);
  if (!checked.ok) return { ok: false, reason: "invalid_url" };
  const dns = await checkDns(new URL(checked.url).hostname, context);
  if (!dns.ok) return { ok: false, reason: dns.reason };

  try {
    const response = await context.options.fetch(checked.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      },
    });
    return { ok: true, response };
  } catch (error) {
    return {
      ok: false,
      reason: isTimeout(error) ? "timeout" : "network_error",
    };
  }
}

// Resolves a redirect target against the current address and applies the same safety rules as any other address.
function nextLocation(response: Response, current: string): string | null {
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    const checked = checkMonitoredUrl(new URL(location, current).toString());
    return checked.ok ? checked.url : null;
  } catch {
    return null;
  }
}

interface BodyRead {
  bytes: Uint8Array;
  truncated: boolean;
}

// Reads at most maxBytes and cancels the rest of the download.
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<BodyRead> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  let truncated = total > maxBytes;
  if (total >= maxBytes && !truncated) truncated = !(await reader.read()).done;
  await reader.cancel();

  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const part of parts) {
    const slice = part.subarray(
      0,
      Math.min(part.byteLength, bytes.byteLength - offset),
    );
    bytes.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= bytes.byteLength) break;
  }
  return { bytes, truncated };
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const label = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

// Fetches robots.txt for an origin (following up to MAX_REDIRECTS safe redirects) and caches the outcome.
async function loadRobots(
  origin: string,
  context: Context,
): Promise<RobotsEntry | FetchFailureReason> {
  const nowMs = context.options.nowMs ?? Date.now;
  const cached = await context.options.robots.get(origin);
  if (cached && nowMs() - cached.fetchedAtMs < ROBOTS_TTL_MS) return cached;

  let current = `${origin}/robots.txt`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const step = await fetchHop(current, context);
    if (!step.ok) {
      // Address problems are reported as such; transient failures only mean the rules are unknown.
      return step.reason === "non_public_address" ||
        step.reason === "dns_failed"
        ? step.reason
        : "robots_unavailable";
    }
    const { response } = step;

    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      const next = nextLocation(response, current);
      if (!next) return "robots_unavailable";
      current = next;
      continue;
    }
    if (response.status >= 200 && response.status < 300) {
      const { bytes } = await readCapped(response, MAX_ROBOTS_BYTES);
      const entry: RobotsEntry = {
        kind: "rules",
        text: new TextDecoder().decode(bytes),
        fetchedAtMs: nowMs(),
      };
      await context.options.robots.set(origin, entry);
      return entry;
    }
    await response.body?.cancel();
    // A missing robots.txt (4xx) allows everything; server errors mean the rules cannot be known.
    if (response.status >= 400 && response.status < 500) {
      const entry: RobotsEntry = {
        kind: "allow_all",
        text: "",
        fetchedAtMs: nowMs(),
      };
      await context.options.robots.set(origin, entry);
      return entry;
    }
    return "robots_unavailable";
  }
  return "robots_unavailable";
}

async function robotsDecision(
  url: string,
  context: Context,
): Promise<"allowed" | FetchFailureReason> {
  const parsed = new URL(url);
  const entry = await loadRobots(parsed.origin, context);
  if (typeof entry === "string") return entry;
  if (entry.kind === "allow_all") return "allowed";
  return isAllowedByRobots(
    entry.text,
    ROBOTS_AGENT,
    `${parsed.pathname}${parsed.search}`,
  )
    ? "allowed"
    : "robots_disallowed";
}

// Fetches one page. Every hop (the first address and each redirect) passes the URL rules, the DNS check, and robots.txt.
export async function collectPage(
  inputUrl: string,
  options: CollectOptions,
): Promise<CollectResult> {
  const context: Context = { options, dns: new Map() };
  const initial = checkMonitoredUrl(inputUrl);
  if (!initial.ok) return failure("invalid_url");

  const maxBytes = options.maxBytes ?? MAX_HTML_BYTES;
  const redirects: string[] = [];
  let current = initial.url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const allowed = await robotsDecision(current, context);
    if (allowed !== "allowed") return failure(allowed, { finalUrl: current });

    const step = await fetchHop(current, context);
    if (!step.ok) return failure(step.reason, { finalUrl: current });
    const { response } = step;

    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      const next = nextLocation(response, current);
      if (!next)
        return failure("bad_redirect", {
          status: response.status,
          finalUrl: current,
        });
      redirects.push(next);
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return failure("http_error", {
        status: response.status,
        finalUrl: current,
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType.trim())) {
      await response.body?.cancel();
      return failure("unsupported_content_type", {
        status: response.status,
        finalUrl: current,
      });
    }
    try {
      const { bytes, truncated } = await readCapped(response, maxBytes);
      const page: FetchedPage = {
        finalUrl: current,
        status: response.status,
        contentType,
        html: decodeBody(bytes, contentType),
        bytesRead: bytes.byteLength,
        truncated,
        redirects,
      };
      return { ok: true, page };
    } catch (error) {
      return failure(isTimeout(error) ? "timeout" : "network_error", {
        finalUrl: current,
      });
    }
  }
  return failure("too_many_redirects");
}
