// FILE: api/src/collection.test.ts
// Tests for the page fetcher using a simulated network: redirects, DNS answers, robots.txt, limits, and failures.
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_FETCH_BYTES,
  MAX_REDIRECTS,
  USER_AGENT,
  collectPage,
  type RobotsCache,
  type RobotsEntry,
} from "./collection";

type Handler = (request: Request) => Response | Promise<Response>;

interface Network {
  fetch: typeof fetch;
  requests: { url: string; headers: Headers }[];
}

const html = (body: string, contentType = "text/html; charset=utf-8") =>
  new Response(body, { status: 200, headers: { "content-type": contentType } });
const redirect = (location: string, status = 301) =>
  new Response(null, { status, headers: { location } });
const notFound = () => new Response("missing", { status: 404 });

// Simulates the internet: page handlers by URL, DNS answers by hostname (public by default), and a request log.
function createNetwork(
  pages: Record<string, Handler>,
  dns: Record<string, { A?: string[]; AAAA?: string[]; fail?: boolean }> = {},
): Network {
  const requests: Network["requests"] = [];
  const networkFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers });
    const url = new URL(request.url);

    if (url.origin + url.pathname === "https://cloudflare-dns.com/dns-query") {
      const name = url.searchParams.get("name") ?? "";
      const type = url.searchParams.get("type") === "AAAA" ? "AAAA" : "A";
      const entry = dns[name];
      if (entry?.fail) return new Response("error", { status: 500 });
      const addresses = entry
        ? (entry[type] ?? [])
        : type === "A"
          ? ["93.184.216.34"]
          : [];
      const answers = addresses.map((data) => ({
        name,
        type: type === "A" ? 1 : 28,
        TTL: 60,
        data,
      }));
      return Response.json(
        { Status: 0, Answer: answers },
        { headers: { "content-type": "application/dns-json" } },
      );
    }
    const handler = pages[request.url];
    return handler ? handler(request) : notFound();
  }) as typeof fetch;
  return { fetch: networkFetch, requests };
}

function createRobotsCache(): RobotsCache & {
  entries: Map<string, RobotsEntry>;
} {
  const entries = new Map<string, RobotsEntry>();
  return {
    entries,
    get: async (origin) => entries.get(origin) ?? null,
    set: async (origin, entry) => void entries.set(origin, entry),
  };
}

const PAGE = "https://acme.example.com/pricing";
let robots: ReturnType<typeof createRobotsCache>;

beforeEach(() => {
  robots = createRobotsCache();
});

const run = (
  url: string,
  network: Network,
  extra: { maxBytes?: number; nowMs?: () => number } = {},
) => collectPage(url, { fetch: network.fetch, robots, ...extra });
const pageRequests = (network: Network) =>
  network.requests
    .filter((r) => !r.url.includes("cloudflare-dns.com"))
    .map((r) => r.url);

describe("successful collection", () => {
  it("returns the page with a descriptive user agent and checks robots.txt first", async () => {
    const network = createNetwork({
      [PAGE]: () => html("<html><title>Pricing</title></html>"),
    });
    const result = await run(PAGE, network);

    expect(result).toMatchObject({
      ok: true,
      page: { finalUrl: PAGE, status: 200, truncated: false, redirects: [] },
    });
    expect(result.ok && result.page.html).toContain("<title>Pricing</title>");
    expect(pageRequests(network)).toEqual([
      "https://acme.example.com/robots.txt",
      PAGE,
    ]);
    expect(
      network.requests.find((r) => r.url === PAGE)?.headers.get("user-agent"),
    ).toBe(USER_AGENT);
  });

  it("decodes the declared character set", async () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    const network = createNetwork({
      [PAGE]: () =>
        new Response(bytes, {
          headers: { "content-type": "text/html; charset=iso-8859-1" },
        }),
    });
    const result = await run(PAGE, network);
    expect(result.ok && result.page.html).toBe("café");
  });

  it("accepts XHTML", async () => {
    const network = createNetwork({
      [PAGE]: () => html("<html/>", "application/xhtml+xml"),
    });
    expect((await run(PAGE, network)).ok).toBe(true);
  });
});

describe("address and DNS checks", () => {
  it("rejects unsafe addresses without any network traffic", async () => {
    const network = createNetwork({});
    for (const url of [
      "http://127.0.0.1/",
      "http://localhost/",
      "ftp://acme.example.com/",
      "https://acme.example.com:8443/",
    ]) {
      expect(await run(url, network)).toEqual({
        ok: false,
        reason: "invalid_url",
      });
    }
    expect(network.requests).toHaveLength(0);
  });

  it("rejects a hostname that resolves to a private address", async () => {
    const network = createNetwork(
      { [PAGE]: () => html("secret") },
      { "acme.example.com": { A: ["10.0.0.5"] } },
    );
    expect(await run(PAGE, network)).toMatchObject({
      ok: false,
      reason: "non_public_address",
    });
    expect(pageRequests(network)).toEqual([]);
  });

  it("rejects mixed public and private answers, including IPv6", async () => {
    const mixed = createNetwork(
      {},
      { "acme.example.com": { A: ["93.184.216.34", "169.254.169.254"] } },
    );
    expect(await run(PAGE, mixed)).toMatchObject({
      ok: false,
      reason: "non_public_address",
    });
    const v6 = createNetwork(
      {},
      { "acme.example.com": { A: ["93.184.216.34"], AAAA: ["::1"] } },
    );
    expect(await run(PAGE, v6)).toMatchObject({
      ok: false,
      reason: "non_public_address",
    });
  });

  it("fails when DNS has no answers or the lookup fails", async () => {
    expect(
      await run(
        PAGE,
        createNetwork({}, { "acme.example.com": { A: [], AAAA: [] } }),
      ),
    ).toMatchObject({ reason: "dns_failed" });
    expect(
      await run(
        PAGE,
        createNetwork({}, { "acme.example.com": { fail: true } }),
      ),
    ).toMatchObject({ reason: "dns_failed" });
  });

  it("asks for both address types", async () => {
    const network = createNetwork({ [PAGE]: () => html("ok") });
    await run(PAGE, network);
    const lookups = network.requests
      .filter((r) => r.url.includes("cloudflare-dns.com"))
      .map((r) => new URL(r.url).searchParams.get("type"));
    expect(lookups.sort()).toEqual(["A", "AAAA"]);
    expect(
      network.requests
        .find((r) => r.url.includes("cloudflare-dns.com"))
        ?.headers.get("accept"),
    ).toBe("application/dns-json");
  });
});

describe("redirects", () => {
  it("follows redirects, resolves relative locations, and reports the final address", async () => {
    const network = createNetwork({
      "http://acme.example.com/pricing": () =>
        redirect("https://acme.example.com/pricing"),
      [PAGE]: () => redirect("/plans#top", 302),
      "https://acme.example.com/plans": () => html("plans"),
    });
    const result = await run("http://acme.example.com/pricing", network);
    expect(result).toMatchObject({
      ok: true,
      page: { finalUrl: "https://acme.example.com/plans" },
    });
    expect(result.ok && result.page.redirects).toEqual([
      PAGE,
      "https://acme.example.com/plans",
    ]);
  });

  it("stops after the redirect limit", async () => {
    const pages: Record<string, Handler> = {};
    for (let i = 0; i <= MAX_REDIRECTS + 1; i += 1)
      pages[`https://acme.example.com/r${i}`] = () => redirect(`/r${i + 1}`);
    expect(
      await run("https://acme.example.com/r0", createNetwork(pages)),
    ).toMatchObject({ ok: false, reason: "too_many_redirects" });
  });

  it.each([
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/",
    "file:///etc/passwd",
    "https://acme.example.com:8443/",
    "https://user:pass@acme.example.com/",
  ])("refuses a redirect to %s", async (target) => {
    const network = createNetwork({ [PAGE]: () => redirect(target) });
    expect(await run(PAGE, network)).toMatchObject({
      ok: false,
      reason: "bad_redirect",
    });
    expect(pageRequests(network)).not.toContain(target);
  });

  it("checks DNS and robots again for a redirect to another host", async () => {
    const network = createNetwork(
      { [PAGE]: () => redirect("https://evil.example.org/x") },
      { "evil.example.org": { A: ["192.168.1.10"] } },
    );
    expect(await run(PAGE, network)).toMatchObject({
      ok: false,
      reason: "non_public_address",
      finalUrl: "https://evil.example.org/x",
    });
  });

  it("rejects redirects without a usable Location header", async () => {
    const missing = createNetwork({
      [PAGE]: () => new Response(null, { status: 302 }),
    });
    expect(await run(PAGE, missing)).toMatchObject({
      ok: false,
      reason: "bad_redirect",
    });
  });
});

describe("robots.txt", () => {
  const robotsUrl = "https://acme.example.com/robots.txt";

  it("blocks disallowed paths and does not request the page", async () => {
    const network = createNetwork({
      [robotsUrl]: () => new Response("User-agent: *\nDisallow: /pricing"),
      [PAGE]: () => html("x"),
    });
    expect(await run(PAGE, network)).toMatchObject({
      ok: false,
      reason: "robots_disallowed",
    });
    expect(pageRequests(network)).toEqual([robotsUrl]);
  });

  it("allows paths the rules do not cover", async () => {
    const network = createNetwork({
      [robotsUrl]: () => new Response("User-agent: *\nDisallow: /admin"),
      [PAGE]: () => html("x"),
    });
    expect((await run(PAGE, network)).ok).toBe(true);
  });

  it("treats a missing robots.txt as permission, and caches that", async () => {
    const network = createNetwork({ [PAGE]: () => html("x") });
    expect((await run(PAGE, network)).ok).toBe(true);
    expect(robots.entries.get("https://acme.example.com")?.kind).toBe(
      "allow_all",
    );
  });

  it("does not fetch the page when robots.txt cannot be read", async () => {
    const network = createNetwork({
      [robotsUrl]: () => new Response("down", { status: 503 }),
      [PAGE]: () => html("x"),
    });
    expect(await run(PAGE, network)).toMatchObject({
      ok: false,
      reason: "robots_unavailable",
    });
    expect(pageRequests(network)).toEqual([robotsUrl]);
    expect(robots.entries.size).toBe(0);
  });

  it("follows a robots.txt redirect but refuses an unsafe one", async () => {
    const safe = createNetwork({
      [robotsUrl]: () => redirect("https://acme.example.com/static/robots.txt"),
      "https://acme.example.com/static/robots.txt": () =>
        new Response("User-agent: *\nDisallow: /pricing"),
    });
    expect(await run(PAGE, safe)).toMatchObject({
      reason: "robots_disallowed",
    });

    robots = createRobotsCache();
    const unsafe = createNetwork({
      [robotsUrl]: () => redirect("http://127.0.0.1/robots.txt"),
      [PAGE]: () => html("x"),
    });
    expect(await run(PAGE, unsafe)).toMatchObject({
      reason: "robots_unavailable",
    });
  });

  it("reuses cached rules until they expire", async () => {
    let now = 1_000_000;
    const network = createNetwork({
      [robotsUrl]: () => new Response("User-agent: *\nDisallow: /admin"),
      [PAGE]: () => html("x"),
    });
    await run(PAGE, network, { nowMs: () => now });
    await run(PAGE, network, { nowMs: () => now + 60_000 });
    expect(network.requests.filter((r) => r.url === robotsUrl)).toHaveLength(1);

    now += 25 * 60 * 60 * 1000;
    await run(PAGE, network, { nowMs: () => now });
    expect(network.requests.filter((r) => r.url === robotsUrl)).toHaveLength(2);
  });
});

describe("response limits and failures", () => {
  it("rejects non-HTML content", async () => {
    for (const type of [
      "application/json",
      "application/pdf",
      "image/png",
      "",
    ]) {
      const network = createNetwork({
        [PAGE]: () =>
          new Response("data", {
            headers: type ? { "content-type": type } : {},
          }),
      });
      expect(await run(PAGE, network)).toMatchObject({
        ok: false,
        reason: "unsupported_content_type",
      });
    }
  });

  it("reads only the allowed number of bytes and cancels the rest", async () => {
    let cancelled = false;
    const chunk = new TextEncoder().encode("x".repeat(300_000));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
        sent += 1;
        if (sent >= 10) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const network = createNetwork({
      [PAGE]: () =>
        new Response(stream, { headers: { "content-type": "text/html" } }),
    });
    const result = await run(PAGE, network);

    expect(result).toMatchObject({
      ok: true,
      page: { bytesRead: MAX_FETCH_BYTES, truncated: true },
    });
    expect(result.ok && result.page.html.length).toBe(MAX_FETCH_BYTES);
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(10);
  });

  it("does not flag a page that fits exactly", async () => {
    const network = createNetwork({ [PAGE]: () => html("x".repeat(1000)) });
    const result = await run(PAGE, network, { maxBytes: 1000 });
    expect(result).toMatchObject({
      ok: true,
      page: { bytesRead: 1000, truncated: false },
    });
  });

  it("reports HTTP errors with their status", async () => {
    for (const status of [403, 404, 429, 500]) {
      const network = createNetwork({
        [PAGE]: () => new Response("no", { status }),
      });
      expect(await run(PAGE, network)).toMatchObject({
        ok: false,
        reason: "http_error",
        status,
      });
    }
  });

  it("maps timeouts and network errors", async () => {
    const timeout = createNetwork({
      [PAGE]: () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    expect(await run(PAGE, timeout)).toMatchObject({
      ok: false,
      reason: "timeout",
    });

    const broken = createNetwork({
      [PAGE]: () => {
        throw new TypeError("connection reset");
      },
    });
    expect(await run(PAGE, broken)).toMatchObject({
      ok: false,
      reason: "network_error",
    });
  });

  it("maps a stalled body read to a timeout", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    const network = createNetwork({
      [PAGE]: () =>
        new Response(stream, { headers: { "content-type": "text/html" } }),
    });
    expect(await run(PAGE, network)).toMatchObject({
      ok: false,
      reason: "timeout",
    });
  });
});
