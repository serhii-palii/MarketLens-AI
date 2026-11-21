// FILE: api/spikes/cpu-spike.ts
// Throwaway Worker that runs staged extraction and diff pipelines so platform CPU use can be measured.
import { handleAi } from "./ai-spike";

interface SpikeEnv {
  ASSETS: Fetcher;
  AI: Ai;
  SPIKE_URLS?: string;
  SPIKE_TOKEN?: string;
}

interface CollectedPage {
  title: string;
  headings: string[];
  linkCount: number;
  chunks: string[];
}

interface DiffSummary {
  added: number;
  removed: number;
  wordEdits: number;
}

type Result = Record<string, unknown>;

const BLOCK_ELEMENTS =
  "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption, dt, dd";
const SKIPPED_ELEMENTS = "script, style, noscript, svg, template, nav, footer";
const MAX_WORD_DIFFS = 20;
const TRUNCATE_BYTES = 150_000;
const FIXTURE_NAME = /^\d{2,4}kb$/;
const DIFF_VARIANTS = new Set([
  "h5-diff",
  "r4-diff",
  "r5-trunc-diff",
  "r6-full",
]);

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeEntities(value: string): string {
  return value
    .replace(
      /&(amp|lt|gt|quot|nbsp|#39);/g,
      (entity) => ENTITIES[entity] ?? entity,
    )
    .replace(/&#(\d{2,5});/g, (_entity, code: string) =>
      String.fromCodePoint(Number(code)),
    );
}

// Collapses whitespace and removes volatile tokens such as dates and long hex identifiers.
function normalizeParagraph(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/\b[0-9a-f]{16,}\b/g, "")
    .trim();
}

function toParagraphs(text: string): string[] {
  return text
    .split("\n")
    .map(normalizeParagraph)
    .filter((paragraph) => paragraph.length >= 3);
}

// Streaming parser path: one handler per element, since several handlers on the same element lose end-tag callbacks.
async function collectPage(response: Response): Promise<CollectedPage> {
  let title = "";
  let linkCount = 0;
  let skipDepth = 0;
  let headingParts: string[] = [];
  let headingOpen = false;
  const headings: string[] = [];
  const chunks: string[] = [];

  const rewriter = new HTMLRewriter()
    .on("title", {
      text(chunk) {
        title += chunk.text;
      },
    })
    .on("a[href]", {
      element() {
        linkCount += 1;
      },
    })
    .on(SKIPPED_ELEMENTS, {
      element(element) {
        skipDepth += 1;
        element.onEndTag(() => {
          skipDepth -= 1;
        });
      },
    })
    .on(BLOCK_ELEMENTS, {
      element(element) {
        const isHeading = /^h[1-3]$/.test(element.tagName);
        chunks.push("\n");
        if (isHeading) {
          headingOpen = true;
          headingParts = [];
        }
        element.onEndTag(() => {
          chunks.push("\n");
          if (isHeading) {
            headings.push(headingParts.join("").trim());
            headingOpen = false;
          }
        });
      },
      text(chunk) {
        if (skipDepth !== 0) return;
        chunks.push(chunk.text);
        if (headingOpen) headingParts.push(chunk.text);
      },
    });

  await drain(rewriter.transform(response));
  return { title: title.trim(), headings, linkCount, chunks };
}

// Discards the transformed body without buffering it.
async function drain(response: Response): Promise<void> {
  if (response.body) await response.body.pipeTo(new WritableStream());
}

// Regex path: removes non-content elements, turns block tags into line breaks, and strips the remaining tags.
function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<(script|style|noscript|svg|template|nav|footer)\b[\s\S]*?<\/\1\s*>/gi,
        " ",
      )
      .replace(
        /<\/?(?:p|li|h[1-6]|td|th|blockquote|figcaption|dt|dd|br)\b[^>]*>/gi,
        "\n",
      )
      .replace(/<[^>]*>/g, " "),
  );
}

// Regex path: page metadata, headings, and link count read directly from the HTML source.
function extractMetadata(html: string): {
  title: string;
  metaDescription: string;
  canonicalUrl: string;
  headings: string[];
  linkCount: number;
} {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const metaDescription =
    /<meta\b[^>]*\bname=["']description["'][^>]*\bcontent=["']([^"']*)["']/i.exec(
      html,
    )?.[1] ?? "";
  const canonicalUrl =
    /<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']*)["']/i.exec(
      html,
    )?.[1] ?? "";
  const headings = [
    ...html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi),
  ].map((match) => normalizeParagraph(stripHtml(match[1] ?? "")));
  const linkCount = (html.match(/<a\b[^>]*\bhref=/gi) ?? []).length;
  return {
    title: normalizeParagraph(decodeEntities(title)),
    metaDescription,
    canonicalUrl,
    headings,
    linkCount,
  };
}

// Reads at most maxBytes from the body and cancels the rest of the download.
async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  await reader.cancel();
  const joined = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const part of parts) {
    const slice = part.subarray(
      0,
      Math.min(part.byteLength, joined.byteLength - offset),
    );
    joined.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= joined.byteLength) break;
  }
  return new TextDecoder().decode(joined);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Counts word insertions and deletions between two paragraphs using a longest-common-subsequence table.
function countWordEdits(before: string, after: string): number {
  const a = before.split(" ");
  const b = after.split(" ");
  let previousRow = new Uint16Array(b.length + 1);
  let currentRow = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      currentRow[j] =
        a[i - 1] === b[j - 1]
          ? (previousRow[j - 1] ?? 0) + 1
          : Math.max(previousRow[j] ?? 0, currentRow[j - 1] ?? 0);
    }
    [previousRow, currentRow] = [currentRow, previousRow];
  }
  return a.length + b.length - 2 * (previousRow[b.length] ?? 0);
}

// Compares paragraph multisets, then runs a word-level comparison on a bounded number of changed pairs.
function diffParagraphs(previous: string[], current: string[]): DiffSummary {
  const remaining = new Map<string, number>();
  for (const paragraph of previous)
    remaining.set(paragraph, (remaining.get(paragraph) ?? 0) + 1);

  const added: string[] = [];
  for (const paragraph of current) {
    const count = remaining.get(paragraph) ?? 0;
    if (count > 0) remaining.set(paragraph, count - 1);
    else added.push(paragraph);
  }
  const removed: string[] = [];
  for (const [paragraph, count] of remaining) {
    for (let i = 0; i < count; i += 1) removed.push(paragraph);
  }

  const pairs = Math.min(added.length, removed.length, MAX_WORD_DIFFS);
  let wordEdits = 0;
  for (let i = 0; i < pairs; i += 1)
    wordEdits += countWordEdits(removed[i] ?? "", added[i] ?? "");
  return { added: added.length, removed: removed.length, wordEdits };
}

// Builds an older version of a real page by revising and dropping some paragraphs.
function mutateParagraphs(paragraphs: string[]): string[] {
  return paragraphs
    .filter((_, index) => index % 50 !== 7)
    .map((paragraph, index) =>
      index % 33 === 5 ? `${paragraph} (older wording)` : paragraph,
    );
}

// Runs one cumulative pipeline stage and returns small counters (no page content).
async function runVariant(
  variant: string,
  response: Response,
  previous: string[] | null,
): Promise<Result | null> {
  switch (variant) {
    case "read":
      return { bytes: (await response.arrayBuffer()).byteLength };
    case "h1-parse": {
      await drain(
        new HTMLRewriter().on("title", { text() {} }).transform(response),
      );
      return { parsed: true };
    }
    case "h2-handlers": {
      const page = await collectPage(response);
      return {
        chunks: page.chunks.length,
        headings: page.headings.length,
        links: page.linkCount,
      };
    }
    case "h3-normalize":
    case "h4-hash":
    case "h5-diff": {
      const page = await collectPage(response);
      const paragraphs = toParagraphs(decodeEntities(page.chunks.join("")));
      if (variant === "h3-normalize") return { paragraphs: paragraphs.length };
      const hash = (await sha256Hex(paragraphs.join("\n"))).slice(0, 12);
      if (variant === "h4-hash") return { paragraphs: paragraphs.length, hash };
      return {
        paragraphs: paragraphs.length,
        hash,
        diff: diffParagraphs(
          previous ?? mutateParagraphs(paragraphs),
          paragraphs,
        ),
      };
    }
    case "r1-strip":
      return { textChars: stripHtml(await response.text()).length };
    case "r2-normalize":
      return {
        paragraphs: toParagraphs(stripHtml(await response.text())).length,
      };
    case "r3-hash": {
      const paragraphs = toParagraphs(stripHtml(await response.text()));
      return {
        paragraphs: paragraphs.length,
        hash: (await sha256Hex(paragraphs.join("\n"))).slice(0, 12),
      };
    }
    case "r4-diff":
    case "r5-trunc-diff": {
      const html =
        variant === "r4-diff"
          ? await response.text()
          : await readLimited(response, TRUNCATE_BYTES);
      const paragraphs = toParagraphs(stripHtml(html));
      const hash = (await sha256Hex(paragraphs.join("\n"))).slice(0, 12);
      return {
        htmlChars: html.length,
        paragraphs: paragraphs.length,
        hash,
        diff: diffParagraphs(
          previous ?? mutateParagraphs(paragraphs),
          paragraphs,
        ),
      };
    }
    case "r6-full": {
      const html = await response.text();
      const metadata = extractMetadata(html);
      const paragraphs = toParagraphs(stripHtml(html));
      const hash = (await sha256Hex(paragraphs.join("\n"))).slice(0, 12);
      return {
        htmlChars: html.length,
        headings: metadata.headings.length,
        links: metadata.linkCount,
        titleChars: metadata.title.length,
        paragraphs: paragraphs.length,
        hash,
        diff: diffParagraphs(
          previous ?? mutateParagraphs(paragraphs),
          paragraphs,
        ),
      };
    }
    default:
      return null;
  }
}

async function loadAsset(
  env: SpikeEnv,
  path: string,
): Promise<Response | null> {
  const response = await env.ASSETS.fetch(
    new Request(`https://assets.invalid/${path}`),
  );
  return response.ok ? response : null;
}

async function handleFixture(
  env: SpikeEnv,
  params: URLSearchParams,
): Promise<Response> {
  const name = params.get("name") ?? "";
  const variant = params.get("variant") ?? "";
  if (!FIXTURE_NAME.test(name))
    return Response.json({ error: "bad_fixture" }, { status: 400 });

  const needsDiff = DIFF_VARIANTS.has(variant);
  const [page, oldText] = await Promise.all([
    loadAsset(env, needsDiff ? `${name}-edited.html` : `${name}.html`),
    needsDiff ? loadAsset(env, `${name}.txt`) : Promise.resolve(null),
  ]);
  if (!page || (needsDiff && !oldText))
    return Response.json({ error: "fixture_missing" }, { status: 404 });

  const previous = oldText ? (await oldText.text()).split("\n") : null;
  const result = await runVariant(variant, page, previous);
  if (!result)
    return Response.json({ error: "unknown_variant" }, { status: 400 });
  return Response.json({ variant, name, ...result });
}

async function handleUrl(
  env: SpikeEnv,
  params: URLSearchParams,
): Promise<Response> {
  const urls = (env.SPIKE_URLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//.test(value));
  const target = urls[Number(params.get("i") ?? "0")];
  if (!target)
    return Response.json({ error: "no_such_url_index" }, { status: 404 });

  const variant = params.get("variant") ?? "h4-hash";
  const response = await fetch(target, {
    headers: { "User-Agent": "cpu-spike/0.1" },
  });
  const result = await runVariant(variant, response, null);
  if (!result)
    return Response.json({ error: "unknown_variant" }, { status: 400 });
  return Response.json({ variant, status: response.status, ...result });
}

export default {
  async fetch(request: Request, env: SpikeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/spike/fixture")
      return handleFixture(env, url.searchParams);
    if (url.pathname === "/spike/url") return handleUrl(env, url.searchParams);
    if (url.pathname === "/spike/ai") return handleAi(env, request);
    return Response.json({ error: "not_found" }, { status: 404 });
  },

  // Runs the full regex pipeline once per cron tick so scheduled CPU use shows up in the logs.
  async scheduled(
    _controller: ScheduledController,
    env: SpikeEnv,
  ): Promise<void> {
    const [page, oldText] = await Promise.all([
      loadAsset(env, "250kb-edited.html"),
      loadAsset(env, "250kb.txt"),
    ]);
    if (!page || !oldText) {
      console.log(JSON.stringify({ event: "cron-run", ok: false }));
      return;
    }
    const result = await runVariant(
      "r6-full",
      page,
      (await oldText.text()).split("\n"),
    );
    console.log(
      JSON.stringify({
        event: "cron-run",
        ok: true,
        paragraphs: result?.["paragraphs"] ?? null,
      }),
    );
  },
} satisfies ExportedHandler<SpikeEnv>;
