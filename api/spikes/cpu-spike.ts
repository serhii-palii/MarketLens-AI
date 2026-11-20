// FILE: api/spikes/cpu-spike.ts
// Throwaway Worker that runs page extraction and diffing so platform CPU use can be measured.

interface SpikeEnv {
  ASSETS: Fetcher;
  SPIKE_URLS?: string;
}

interface ExtractedPage {
  title: string;
  metaDescription: string;
  canonicalUrl: string;
  headings: string[];
  linkCount: number;
  paragraphs: string[];
}

interface DiffSummary {
  added: number;
  removed: number;
  wordEdits: number;
}

const BLOCK_ELEMENTS = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption, dt, dd";
const SKIPPED_ELEMENTS = "script, style, noscript, svg, template, nav, footer";
const MAX_WORD_DIFFS = 20;
const FIXTURE_NAME = /^\d{2,4}kb$/;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

// Collapses whitespace and removes volatile tokens such as dates and long hex identifiers.
function normalizeParagraph(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/\b[0-9a-f]{16,}\b/g, "")
    .trim();
}

async function extractPage(response: Response): Promise<ExtractedPage> {
  let title = "";
  let metaDescription = "";
  let canonicalUrl = "";
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
    .on('meta[name="description"]', {
      element(element) {
        metaDescription = element.getAttribute("content") ?? "";
      },
    })
    .on('link[rel="canonical"]', {
      element(element) {
        canonicalUrl = element.getAttribute("href") ?? "";
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
    // One handler per element keeps a single end-tag callback, since several handlers on the same element did not all fire.
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

  // The transformed body is drained without being buffered.
  const body = rewriter.transform(response).body;
  if (body) await body.pipeTo(new WritableStream());

  const paragraphs = decodeEntities(chunks.join(""))
    .split("\n")
    .map(normalizeParagraph)
    .filter((paragraph) => paragraph.length >= 3);

  return { title: title.trim(), metaDescription, canonicalUrl, headings, linkCount, paragraphs };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const common = previousRow[b.length] ?? 0;
  return a.length + b.length - 2 * common;
}

// Compares paragraph multisets, then runs a word-level comparison on a bounded number of changed pairs.
function diffParagraphs(previous: string[], current: string[]): DiffSummary {
  const remaining = new Map<string, number>();
  for (const paragraph of previous) remaining.set(paragraph, (remaining.get(paragraph) ?? 0) + 1);

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
  for (let i = 0; i < pairs; i += 1) wordEdits += countWordEdits(removed[i] ?? "", added[i] ?? "");
  return { added: added.length, removed: removed.length, wordEdits };
}

// Builds an older version of a real page by revising and dropping some paragraphs.
function mutateParagraphs(paragraphs: string[]): string[] {
  return paragraphs
    .filter((_, index) => index % 50 !== 7)
    .map((paragraph, index) => (index % 33 === 5 ? `${paragraph} (older wording)` : paragraph));
}

async function loadAsset(env: SpikeEnv, path: string): Promise<Response | null> {
  const response = await env.ASSETS.fetch(new Request(`https://assets.invalid/${path}`));
  return response.ok ? response : null;
}

async function summarize(
  page: ExtractedPage,
  htmlBytes: number | null,
  diff: DiffSummary | null,
): Promise<Record<string, unknown>> {
  return {
    htmlBytes,
    title: page.title,
    headings: page.headings.length,
    firstHeading: page.headings[0] ?? null,
    links: page.linkCount,
    paragraphs: page.paragraphs.length,
    textChars: page.paragraphs.reduce((sum, p) => sum + p.length, 0),
    contentHash: (await sha256Hex(page.paragraphs.join("\n"))).slice(0, 12),
    diff,
  };
}

async function handleFixture(env: SpikeEnv, params: URLSearchParams): Promise<Response> {
  const name = params.get("name") ?? "";
  const operation = params.get("op") ?? "extract";
  if (!FIXTURE_NAME.test(name)) return Response.json({ error: "bad_fixture" }, { status: 400 });

  if (operation === "diff") {
    const [edited, previousText] = await Promise.all([
      loadAsset(env, `${name}-edited.html`),
      loadAsset(env, `${name}.txt`),
    ]);
    if (!edited || !previousText) return Response.json({ error: "fixture_missing" }, { status: 404 });
    const page = await extractPage(edited);
    const previous = (await previousText.text()).split("\n");
    return Response.json(await summarize(page, null, diffParagraphs(previous, page.paragraphs)));
  }

  const html = await loadAsset(env, `${name}.html`);
  if (!html) return Response.json({ error: "fixture_missing" }, { status: 404 });
  return Response.json(await summarize(await extractPage(html), null, null));
}

async function handleUrl(env: SpikeEnv, params: URLSearchParams): Promise<Response> {
  const urls = (env.SPIKE_URLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//.test(value));
  const target = urls[Number(params.get("i") ?? "0")];
  if (!target) return Response.json({ error: "no_such_url_index" }, { status: 404 });

  const response = await fetch(target, { headers: { "User-Agent": "cpu-spike/0.1" } });
  const page = await extractPage(response);
  const diff =
    params.get("op") === "diff" ? diffParagraphs(mutateParagraphs(page.paragraphs), page.paragraphs) : null;
  return Response.json({ status: response.status, ...(await summarize(page, null, diff)) });
}

export default {
  async fetch(request: Request, env: SpikeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/spike/fixture") return handleFixture(env, url.searchParams);
    if (url.pathname === "/spike/url") return handleUrl(env, url.searchParams);
    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<SpikeEnv>;
