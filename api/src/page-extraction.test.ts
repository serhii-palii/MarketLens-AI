// FILE: api/src/page-extraction.test.ts
// Tests for metadata, text, link, and hash extraction, including noise removal and hostile markup.
import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  extractPage,
  normalizeText,
  type ExtractedPage,
} from "./page-extraction";

const BASE = "https://acme.example.com/pricing";

async function extract(html: string): Promise<ExtractedPage> {
  const result = await extractPage(html, BASE);
  if (!result.ok) throw new Error(`Extraction failed: ${result.reason}`);
  return result.page;
}

const SAMPLE = `<!doctype html><html><head>
<title>Pricing &amp; Plans | Acme</title>
<meta name="description" content="Simple pricing &quot;for teams&quot;">
<link rel="stylesheet" href="/s.css"><link rel="canonical" href="/pricing?ref=nav#top">
<style>.x{color:red}</style><script>var a = "<p>not text</p>";</script></head>
<body><nav><a href="/home">Home</a><p>Navigation text</p></nav>
<h1>Plans</h1><p>Pro plan: <b>$59</b> per user per month.</p>
<div>Enterprise &mdash; contact sales</div>
<ul><li>Unlimited dashboards</li><li>Priority support</li></ul>
<h2 class="x">FAQ</h2><p>Updated 2026-11-23T10:15:00Z, id 3f2a9c1e-7b4d-4e8a-9c3b-1a2b3c4d5e6f</p>
<a href="https://other.example.org/docs#intro">Docs</a> <a href='mailto:sales@acme.example.com'>Mail</a>
<a href=/careers>Jobs</a> <a href="javascript:void(0)">x</a>
<!-- <p>hidden comment</p> --><footer><p>Copyright Acme</p></footer></body></html>`;

describe("extractPage", () => {
  it("extracts title, description, canonical address, and headings", async () => {
    const page = await extract(SAMPLE);
    expect(page.title).toBe("Pricing & Plans | Acme");
    expect(page.metaDescription).toBe('Simple pricing "for teams"');
    expect(page.canonicalUrl).toBe("https://acme.example.com/pricing?ref=nav");
    expect(page.headings).toEqual(["Plans", "FAQ"]);
  });

  it("keeps readable text and drops scripts, styles, navigation, footers, and comments", async () => {
    const page = await extract(SAMPLE);
    const text = page.paragraphs.join("\n");
    expect(text).toContain("Pro plan: $59 per user per month.");
    expect(text).toContain("Unlimited dashboards");
    expect(text).toContain("Priority support");
    expect(text).toContain("Enterprise — contact sales");
    for (const noise of [
      "not text",
      "Navigation text",
      "Copyright Acme",
      "hidden comment",
      "color:red",
    ]) {
      expect(text).not.toContain(noise);
    }
  });

  it("splits block elements into separate paragraphs", async () => {
    const page = await extract(SAMPLE);
    expect(page.paragraphs).toContain("Unlimited dashboards");
    expect(page.paragraphs).toContain("Priority support");
  });

  it("removes timestamps, dates, and identifiers that change between visits", async () => {
    const page = await extract(SAMPLE);
    expect(page.paragraphs.join("\n")).not.toMatch(/2026-11-23|3f2a9c1e/);
    expect(page.paragraphs).toContain("Updated , id");
  });

  it("resolves links, keeps only http and https, drops fragments, and removes duplicates", async () => {
    const page = await extract(SAMPLE);
    expect(page.links).toEqual([
      "https://acme.example.com/home",
      "https://other.example.org/docs",
      "https://acme.example.com/careers",
    ]);
    const duplicates = await extract(
      `<a href="/a">1</a><a href="/a#x">2</a><a href="/a">3</a>`,
    );
    expect(duplicates.links).toEqual(["https://acme.example.com/a"]);
  });

  it("handles attribute order, quoting styles, and upper-case tags", async () => {
    const page = await extract(
      `<HTML><HEAD><TITLE>Hi</TITLE><META CONTENT='Desc' NAME='Description'></HEAD><BODY><P>Body text</P></BODY></HTML>`,
    );
    expect(page).toMatchObject({ title: "Hi", metaDescription: "Desc" });
    expect(page.paragraphs).toContain("Body text");
  });

  it("falls back to the social description when there is no standard one", async () => {
    const page = await extract(
      `<meta property="og:description" content="Social summary"><p>Text here</p>`,
    );
    expect(page.metaDescription).toBe("Social summary");
  });

  it("returns empty values for an empty or text-only page", async () => {
    expect(await extract("")).toMatchObject({
      title: "",
      metaDescription: "",
      canonicalUrl: null,
      headings: [],
      links: [],
      paragraphs: [],
    });
    expect((await extract("just plain text")).paragraphs).toEqual([
      "just plain text",
    ]);
  });

  it("decodes numeric entities and ignores invalid ones", async () => {
    expect(
      decodeEntities("caf&#233; &#x41; &#99999999; &amp;amp; &unknown;"),
    ).toBe("café A &#99999999; &amp; &unknown;");
    expect(normalizeText("  a \n\t b  ")).toBe("a b");
  });
});

describe("content hash", () => {
  it("is stable for identical content and ignores layout-only changes", async () => {
    const a = await extract(SAMPLE);
    const b = await extract(
      SAMPLE.replace("<p>Pro plan:", "\n\n   <p>   Pro plan:").replace(
        /<nav>.*?<\/nav>/s,
        "<nav>different navigation</nav>",
      ),
    );
    expect(b.contentHash).toBe(a.contentHash);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores changing timestamps and footer text", async () => {
    const a = await extract(SAMPLE);
    const b = await extract(
      SAMPLE.replace("2026-11-23T10:15:00Z", "2027-01-01T00:00:00Z").replace(
        "Copyright Acme",
        "Copyright Acme 2027",
      ),
    );
    expect(b.contentHash).toBe(a.contentHash);
  });

  it("changes when the visible content, title, or description changes", async () => {
    const original = (await extract(SAMPLE)).contentHash;
    expect((await extract(SAMPLE.replace("$59", "$69"))).contentHash).not.toBe(
      original,
    );
    expect(
      (await extract(SAMPLE.replace("Pricing &amp; Plans", "Pricing")))
        .contentHash,
    ).not.toBe(original);
    expect(
      (await extract(SAMPLE.replace("for teams", "for everyone"))).contentHash,
    ).not.toBe(original);
  });
});

describe("limits and hostile markup", () => {
  it("caps headings, links, and paragraph counts", async () => {
    const many = Array.from(
      { length: 300 },
      (_, i) =>
        `<h2>Heading ${i}</h2><a href="/p${i}">x</a><p>Paragraph number ${i}</p>`,
    ).join("");
    const page = await extract(many);
    expect(page.headings).toHaveLength(50);
    expect(page.links).toHaveLength(100);
    expect(page.paragraphs.length).toBeLessThanOrEqual(3000);
  });

  it("truncates very long lines", async () => {
    const page = await extract(`<p>${"word ".repeat(2000)}</p>`);
    expect(page.paragraphs[0]?.length).toBeLessThanOrEqual(3000);
  });

  it("rejects markup with many unclosed comments or elements instead of scanning it repeatedly", async () => {
    const unclosedComments = await extractPage(
      "<!--".repeat(5000) + "<p>text</p>",
      BASE,
    );
    const unclosedScripts = await extractPage(
      "<script>".repeat(5000) + "<p>text</p>",
      BASE,
    );
    expect(unclosedComments).toEqual({ ok: false, reason: "malformed_html" });
    expect(unclosedScripts).toEqual({ ok: false, reason: "malformed_html" });
  });

  it("stays fast on pathological input", async () => {
    const inputs = [
      "<".repeat(200_000),
      "<a ".repeat(60_000),
      "<h1>".repeat(40_000),
      `<p ${"x ".repeat(100_000)}`,
      "&#".repeat(100_000),
    ];
    for (const input of inputs) {
      const started = Date.now();
      await extractPage(input, BASE);
      expect(Date.now() - started).toBeLessThan(1500);
    }
  });

  it("handles a realistic 250 KB page", async () => {
    const section =
      '<div class="card"><h3>Feature</h3><p>Some marketing text about the product and its benefits for teams.</p><a href="/features/x">More</a></div>\n';
    const noise = `<script>${"var x=1;".repeat(2000)}</script>`;
    const page = await extract(
      `<html><head><title>Big</title></head><body>${(section + noise).repeat(1100)}</body></html>`,
    );
    expect(page.paragraphs.length).toBeGreaterThan(500);
  });
});
