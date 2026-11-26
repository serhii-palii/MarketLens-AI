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

  it("handles a realistic page of about 250 KB", async () => {
    const section =
      '<div class="card"><h3>Feature</h3><p>Some marketing text about the product and its benefits for teams.</p><a href="/features/x">More</a></div>\n';
    const script = `<script>${"var x=1;".repeat(10_000)}</script>`;
    const html = `<html><head><title>Big</title></head><body>${section.repeat(1100)}${script}</body></html>`;
    expect(html.length).toBeGreaterThan(200_000);
    expect(html.length).toBeLessThan(249_000);
    const page = await extract(html);
    expect(page.paragraphs.length).toBeGreaterThan(500);
    expect(page.regionTruncated).toBe(false);
  });
});

describe("main content selection", () => {
  const menu = (count: number) =>
    Array.from(
      { length: count },
      (_, i) =>
        `<h2>Menu ${i}</h2><p>Sidebar entry number ${i}</p><a href="/menu/${i}">m</a>`,
    ).join("");

  it("prefers the main element and ignores a sidebar before it", async () => {
    const page = await extract(
      `<html><head><title>Pricing</title></head><body><div class="side">${menu(40)}</div><main><h1>Plans</h1><p>Pro plan: $59 per user.</p><p>Enterprise: contact sales.</p><p>Billed annually.</p><a href="/buy">Buy</a></main><div>After main</div></body></html>`,
    );
    expect(page.regionSource).toBe("main");
    expect(page.headings).toEqual(["Plans"]);
    expect(page.paragraphs.join("\n")).toContain("Pro plan: $59 per user.");
    expect(page.paragraphs.join("\n")).not.toMatch(/Sidebar entry|After main/);
    expect(page.links).toEqual(["https://acme.example.com/buy"]);
    expect(page.regionTruncated).toBe(false);
  });

  it("finds a main element that starts far beyond the analysis window", async () => {
    const sidebar = `<div>${menu(9000)}</div>`;
    const html = `<html><head><title>Docs</title><meta name="description" content="Pricing docs"></head><body>${sidebar}<main><h1>Pricing</h1><p>Input: $1.25 per million tokens.</p><p>Output: $10 per million tokens.</p><p>Batch discounts apply.</p></main></body></html>`;
    expect(html.indexOf("<main")).toBeGreaterThan(250_000);
    const page = await extract(html);
    expect(page.regionSource).toBe("main");
    expect(page.paragraphs.join("\n")).toContain(
      "Input: $1.25 per million tokens.",
    );
    expect(page.title).toBe("Docs");
    expect(page.metaDescription).toBe("Pricing docs");
  });

  it("flags a main region that is cut at the analysis window", async () => {
    const long = Array.from(
      { length: 6000 },
      (_, i) => `<p>Paragraph with some filler words, number ${i}.</p>`,
    ).join("");
    const page = await extract(`<main>${long}</main>`);
    expect(page.regionSource).toBe("main");
    expect(page.regionTruncated).toBe(true);
  });

  it("falls back to role=main, then article, then the start of the page", async () => {
    const body =
      "<p>First paragraph of text.</p><p>Second paragraph of text.</p><p>Third paragraph of text.</p>";
    expect(
      (await extract(`<div>${menu(5)}</div><div role="main">${body}</div>`))
        .regionSource,
    ).toBe("role_main");
    expect(
      (await extract(`<div>${menu(5)}</div><article>${body}</article>`))
        .regionSource,
    ).toBe("article");
    expect((await extract(`<div>${body}</div>`)).regionSource).toBe("start");
  });

  it("falls back when the main element holds almost no text", async () => {
    const page = await extract(
      `<body><p>Intro text here.</p><p>More intro text.</p><p>Even more text.</p><main><div id="root"></div></main></body>`,
    );
    expect(page.regionSource).toBe("body");
    expect(page.paragraphs.join("\n")).toContain("Intro text here.");
  });

  it("flags a page without a main element that exceeds the window", async () => {
    const page = await extract(`<body>${menu(9000)}</body>`);
    expect(page.regionSource).toBe("body");
    expect(page.regionTruncated).toBe(true);
  });

  it("skips aside sidebars", async () => {
    const page = await extract(
      `<body><aside><p>Related links sidebar</p></aside><p>Real content one.</p><p>Real content two.</p><p>Real content three.</p></body>`,
    );
    expect(page.paragraphs.join("\n")).not.toContain("Related links sidebar");
  });

  it("processes a large page quickly", async () => {
    const started = Date.now();
    await extract(
      `<html><head><title>Big</title></head><body>${menu(9000)}<main><p>One.</p><p>Two two.</p><p>Three three.</p></main></body></html>`,
    );
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("noise from modern frameworks", () => {
  const longPath = `M18.29 5.70 ${"L10.70 6.70 ".repeat(400)}`;

  it("keeps inline graphics out of headings", async () => {
    const page = await extract(
      `<main><h2>Flagship models <svg width="16"><path d="${longPath}"/></svg></h2><p>First paragraph text.</p><p>Second paragraph text.</p><p>Third paragraph text.</p></main>`,
    );
    expect(page.headings).toEqual(["Flagship models"]);
  });

  it("strips tags that carry very long attributes", async () => {
    const props = `{&quot;rows&quot;:[${"[0,&quot;value&quot;],".repeat(400)}]}`;
    const page = await extract(
      `<main><p>Prices per 1M tokens.</p><astro-island uid="1pJXAL" props="${props}"></astro-island><p>Second paragraph text.</p><p>Third paragraph text.</p></main>`,
    );
    const text = page.paragraphs.join("\n");
    expect(text).toContain("Prices per 1M tokens.");
    expect(text).not.toMatch(/props|1pJXAL|rows|value/);
  });

  it("produces the same hash when only a per-render identifier inside a tag changes", async () => {
    const render = (uid: string) =>
      `<main><p>Prices per 1M tokens.</p><astro-island uid="${uid}" props="{&quot;id&quot;:[0,&quot;${uid}&quot;]}"></astro-island><p>Input: $1.25.</p><p>Output: $10.</p></main>`;
    expect((await extract(render("1pJXAL"))).contentHash).toBe(
      (await extract(render("Zq83Kd"))).contentHash,
    );
  });
});

describe("markup inside attributes and unclosed raw-text elements", () => {
  it("treats tooltips with markup in an attribute as part of the tag", async () => {
    const page = await extract(
      `<main><table><tr><td class="gridTable__cell" data-tooltip="<div>Tip text</div><b>more</b>">Feature A</td><td>Yes</td></tr><tr><td>Feature B</td><td>No</td></tr></table></main>`,
    );
    const text = page.paragraphs.join("\n");
    expect(text).toContain("Feature A");
    expect(text).toContain("Feature B");
    expect(text).not.toMatch(/<td|Tip text|gridTable|data-tooltip/);
  });

  it("keeps icon markup stored in an attribute out of the text", async () => {
    const page = await extract(
      `<main><p>Intro paragraph text.</p><span data-icon='<svg><path d="M1 1"/></svg>'>Included</span><p>Second paragraph text.</p><p>Third paragraph text.</p></main>`,
    );
    const text = page.paragraphs.join("\n");
    expect(text).toContain("Included");
    expect(text).not.toMatch(/<path|data-icon/);
  });

  it("does not mistake a literal less-than sign for a tag", async () => {
    const page = await extract(
      `<main><p>Costs < 5 euros and > 3 users.</p><p>Second paragraph text.</p><p>Third paragraph text.</p></main>`,
    );
    expect(page.paragraphs.join("\n")).toContain(
      "Costs < 5 euros and > 3 users.",
    );
  });

  it("drops a style block that is still open at the end of the analyzed region", async () => {
    const css = ".a{color:red}\n".repeat(30_000);
    const page = await extract(
      `<html><body><p>One paragraph here.</p><p>Two paragraph here.</p><p>Three paragraph here.</p><style>${css}`,
    );
    expect(page.paragraphs.join("\n")).not.toContain("color:red");
    expect(page.paragraphs).toContain("Two paragraph here.");
  });

  it("starts at the body when a huge head would fill the analysis window", async () => {
    const css = ".a{color:red}\n".repeat(40_000);
    const html = `<html><head><title>Docs</title><style>${css}</style></head><body><p>Real page text one.</p><p>Real page text two.</p><p>Real page text three.</p></body></html>`;
    expect(html.indexOf("<body")).toBeGreaterThan(250_000);
    const page = await extract(html);
    expect(page.regionSource).toBe("body");
    expect(page.paragraphs).toContain("Real page text two.");
    expect(page.title).toBe("Docs");
  });

  it("does not let a self-closing graphic hide the rest of the page", async () => {
    const page = await extract(
      `<body><svg width="1" height="1"/><p>First paragraph text.</p><p>Second paragraph text.</p><p>Third paragraph text.</p></body>`,
    );
    expect(page.paragraphs).toContain("Second paragraph text.");
  });

  it("stays fast on hostile quoting", async () => {
    const inputs = [
      '<a x="'.repeat(50_000),
      "<a '".repeat(60_000),
      '<p "'.repeat(40_000) + "x".repeat(100_000),
      `<a ${'x="y" '.repeat(30_000)}`,
      "<a \"<b '<c \"<d '".repeat(15_000),
    ];
    for (const input of inputs) {
      const started = Date.now();
      await extractPage(input, BASE);
      expect(Date.now() - started).toBeLessThan(1500);
    }
  });
});
