// FILE: api/src/robots.test.ts
// Tests for robots.txt parsing and matching.
import { describe, expect, it } from "vitest";
import { isAllowedByRobots } from "./robots";

const AGENT = "marketlensbot";
const allowed = (robots: string, path: string) =>
  isAllowedByRobots(robots, AGENT, path);

describe("isAllowedByRobots", () => {
  it("allows everything when there are no rules", () => {
    expect(allowed("", "/anything")).toBe(true);
    expect(allowed("User-agent: *\nDisallow:", "/anything")).toBe(true);
  });

  it("applies the wildcard group", () => {
    const robots = "User-agent: *\nDisallow: /private\nDisallow: /tmp/";
    expect(allowed(robots, "/private/page")).toBe(false);
    expect(allowed(robots, "/tmp/")).toBe(false);
    expect(allowed(robots, "/pricing")).toBe(true);
  });

  it("blocks the whole site with Disallow: /", () => {
    expect(allowed("User-agent: *\nDisallow: /", "/pricing")).toBe(false);
  });

  it("prefers a group that names the agent over the wildcard group", () => {
    const robots =
      "User-agent: *\nDisallow: /\n\nUser-agent: MarketLensBot\nDisallow: /admin";
    expect(allowed(robots, "/pricing")).toBe(true);
    expect(allowed(robots, "/admin/users")).toBe(false);
  });

  it("combines several groups for the same agent and shared agent lines", () => {
    const robots =
      "User-agent: otherbot\nUser-agent: marketlensbot\nDisallow: /a\n\nUser-agent: marketlensbot\nDisallow: /b";
    expect(allowed(robots, "/a/x")).toBe(false);
    expect(allowed(robots, "/b/x")).toBe(false);
    expect(allowed(robots, "/c")).toBe(true);
  });

  it("lets the longest matching rule win and Allow win a tie", () => {
    const robots = "User-agent: *\nDisallow: /docs\nAllow: /docs/public";
    expect(allowed(robots, "/docs/secret")).toBe(false);
    expect(allowed(robots, "/docs/public/page")).toBe(true);
    expect(allowed("User-agent: *\nDisallow: /x\nAllow: /x", "/x")).toBe(true);
  });

  it("supports * wildcards and the $ end anchor", () => {
    const robots = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*?q=";
    expect(allowed(robots, "/files/report.pdf")).toBe(false);
    expect(allowed(robots, "/files/report.pdf?download=1")).toBe(true);
    expect(allowed(robots, "/search/all?q=test")).toBe(false);
    expect(allowed(robots, "/about")).toBe(true);
  });

  it("matches the query string as part of the path", () => {
    expect(
      allowed("User-agent: *\nDisallow: /pricing?plan=", "/pricing?plan=pro"),
    ).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /pricing?plan=", "/pricing")).toBe(
      true,
    );
  });

  it("ignores comments, blank lines, unknown fields, and bad lines", () => {
    const robots =
      "# note\nUser-agent: * # everyone\nCrawl-delay: 10\nSitemap: https://example.com/sitemap.xml\nnot a rule\nDisallow: /secret # hidden";
    expect(allowed(robots, "/secret")).toBe(false);
    expect(allowed(robots, "/open")).toBe(true);
  });

  it("is case-insensitive for fields and agent names and handles Windows line endings", () => {
    expect(allowed("USER-AGENT: MARKETLENSBOT\r\nDISALLOW: /x\r\n", "/x")).toBe(
      false,
    );
  });

  it("ignores rules before any user-agent line", () => {
    expect(allowed("Disallow: /\nUser-agent: *\nDisallow: /a", "/b")).toBe(
      true,
    );
  });

  it("ignores patterns that are too long or too complex instead of evaluating them", () => {
    const complex = `User-agent: *\nDisallow: /${"a*".repeat(12)}b`;
    expect(allowed(complex, `/${"a".repeat(50)}`)).toBe(true);
    expect(
      allowed(
        `User-agent: *\nDisallow: /${"x".repeat(250)}`,
        `/${"x".repeat(250)}`,
      ),
    ).toBe(true);
  });

  it("stays fast on adversarial patterns and paths", () => {
    const robots = "User-agent: *\nDisallow: /*a*a*a*a*a*b";
    const started = Date.now();
    expect(allowed(robots, `/${"a".repeat(2000)}`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
