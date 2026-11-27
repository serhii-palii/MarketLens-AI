// FILE: api/src/page-extraction.ts
// Deterministic extraction of metadata, headings, links, and normalized text from page HTML using bounded regular expressions.

const MAX_PARAGRAPHS = 3000;
const MAX_PARAGRAPH_LENGTH = 3000;
const MAX_HEADINGS = 50;
const MAX_LINKS = 100;
const MAX_TAGS_SCANNED = 150;
const MAX_UNCLOSED = 20;
// Only this much HTML is analyzed. The fetcher may read more, so the main content can be located first.
const MAX_REGION_CHARS = 250_000;
const HEAD_SCAN_CHARS = 60_000;
const MIN_REGION_PARAGRAPHS = 3;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&laquo;": "«",
  "&raquo;": "»",
  "&bull;": "•",
  "&middot;": "·",
  "&euro;": "€",
  "&pound;": "£",
};

// A tag may hold quoted attribute values that contain "<" or ">" (tooltips and icons are often stored as markup inside
// attributes). The alternatives are mutually exclusive, so matching stays linear even on malformed input.
const TAG_BODY = `(?:[^<>"']|"[^"]*"|'[^']*')*`;
const COMMENT = /<!--[\s\S]*?-->/g;
const SKIPPED_ELEMENT =
  /<(script|style|noscript|svg|template|nav|footer|aside)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK_TAG = new RegExp(
  `<\\/?(?:p|li|ul|ol|h[1-6]|td|th|tr|div|section|article|blockquote|figcaption|dt|dd|br)\\b${TAG_BODY}>`,
  "gi",
);
const ANY_TAG = new RegExp(`<[a-zA-Z/!?]${TAG_BODY}>`, "g");
// A script or style that is still open at the end of the analyzed region would otherwise leak its contents as text.
// Safety net: tag-like fragments that survive stripping (for example markup that arrived entity-escaped) are removed
// to the end of their line, so they cannot end up in the stored text.
const LEFTOVER_TAG = /<\/?[a-zA-Z][\w:-]*(?:\s[^\n<>]*)?(?:>|(?=\n|$))/gm;
const UNCLOSED_RAW_TEXT = new RegExp(
  `<(?:script|style)\\b${TAG_BODY}(?<!/)>[\\s\\S]*$`,
  "i",
);
const OPENERS =
  /<!--|<(script|style|noscript|svg|template|nav|footer|aside)\b/gi;
const CLOSERS =
  /(-->|<\/(?:script|style|noscript|svg|template|nav|footer|aside)\s*>)/gi;

export interface ExtractedPage {
  title: string;
  metaDescription: string;
  canonicalUrl: string | null;
  headings: string[];
  links: string[];
  paragraphs: string[];
  contentHash: string;
  // Which part of the document the text and links came from, and whether that part was cut at the size limit.
  regionSource: "main" | "role_main" | "article" | "body" | "start";
  regionTruncated: boolean;
}

export type ExtractionResult =
  | { ok: true; page: ExtractedPage }
  | { ok: false; reason: "malformed_html" };

export function decodeEntities(value: string): string {
  return value
    .replace(/&(?:[a-z]{2,8}|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/&#(\d{2,6});/g, (_entity, code: string) =>
      safeCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]{2,5});/gi, (_entity, code: string) =>
      safeCodePoint(parseInt(code, 16)),
    );
}

function safeCodePoint(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

// Collapses whitespace and removes values that change on every request (timestamps, dates, identifiers).
export function normalizeText(value: string): string {
  return value
    .replace(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
      "",
    )
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "",
    )
    .replace(/\b[0-9a-f]{16,}\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Markup with many unclosed comments or skipped elements would make lazy matching scan to the end repeatedly.
function isMalformed(html: string): boolean {
  const balance = new Map<string, number>();
  for (const match of html.matchAll(OPENERS)) {
    const key = match[1] ? match[1].toLowerCase() : "comment";
    balance.set(key, (balance.get(key) ?? 0) + 1);
  }
  for (const match of html.matchAll(CLOSERS)) {
    const closer = match[1] ?? "";
    const key =
      closer === "-->"
        ? "comment"
        : closer.slice(2).replace(/\s*>$/, "").toLowerCase();
    balance.set(key, (balance.get(key) ?? 0) - 1);
  }
  return [...balance.values()].some((unclosed) => unclosed > MAX_UNCLOSED);
}

function stripTags(value: string): string {
  return normalizeText(decodeEntities(value.replace(ANY_TAG, " ")));
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g,
  )) {
    const name = match[1]?.toLowerCase();
    if (name && !attributes.has(name))
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function firstTags(html: string, pattern: RegExp): Map<string, string>[] {
  const tags: Map<string, string>[] = [];
  for (const match of html.matchAll(pattern)) {
    tags.push(parseAttributes(match[0]));
    if (tags.length >= MAX_TAGS_SCANNED) break;
  }
  return tags;
}

function resolveHttpUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(decodeEntities(value.trim()), baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
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

interface Region {
  html: string;
  source: ExtractedPage["regionSource"];
  truncated: boolean;
}

interface RegionContent {
  headings: string[];
  links: string[];
  paragraphs: string[];
}

// Candidate regions in order of preference. They are produced lazily so later markers are only searched when needed.
function* candidateRegions(html: string): Generator<Region> {
  const markers: { pattern: RegExp; source: Region["source"] }[] = [
    { pattern: /<main[\s>]/i, source: "main" },
    { pattern: /\brole\s*=\s*["']main["']/i, source: "role_main" },
    { pattern: /<article[\s>]/i, source: "article" },
    { pattern: /<body[\s>]/i, source: "body" },
  ];
  for (const { pattern, source } of markers) {
    const found = html.search(pattern);
    if (found === -1) continue;
    const start =
      source === "role_main"
        ? Math.max(0, html.lastIndexOf("<", found))
        : found;
    let region = html.slice(start, start + MAX_REGION_CHARS + 1);
    let truncated = region.length > MAX_REGION_CHARS;
    if (source === "main") {
      const closing = /<\/main\s*>/i.exec(region);
      if (closing) {
        region = region.slice(0, closing.index + closing[0].length);
        truncated = false;
      }
    }
    yield { html: region.slice(0, MAX_REGION_CHARS), source, truncated };
  }
  yield {
    html: html.slice(0, MAX_REGION_CHARS),
    source: "start",
    truncated: html.length > MAX_REGION_CHARS,
  };
}

function analyzeRegion(
  regionHtml: string,
  baseUrl: string,
): RegionContent | null {
  if (isMalformed(regionHtml)) return null;

  // Comments, scripts, styles, and inline graphics are removed first so they cannot leak into headings or text.
  const cleaned = regionHtml
    .replace(COMMENT, " ")
    .replace(SKIPPED_ELEMENT, " ")
    .replace(UNCLOSED_RAW_TEXT, " ");

  const headings: string[] = [];
  for (const match of cleaned.matchAll(
    /<h([1-3])\b[^<>]{0,60000}>([\s\S]{0,2000}?)<\/h\1\s*>/gi,
  )) {
    const heading = stripTags(match[2] ?? "").slice(0, 300);
    if (heading) headings.push(heading);
    if (headings.length >= MAX_HEADINGS) break;
  }

  const links = new Set<string>();
  for (const match of regionHtml.matchAll(
    /<a\b[^<>]{0,5000}?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi,
  )) {
    const resolved = resolveHttpUrl(
      match[1] ?? match[2] ?? match[3] ?? "",
      baseUrl,
    );
    if (resolved) links.add(resolved);
    if (links.size >= MAX_LINKS) break;
  }

  const text = decodeEntities(
    cleaned.replace(BLOCK_TAG, "\n").replace(ANY_TAG, " "),
  ).replace(LEFTOVER_TAG, " ");
  const paragraphs = text
    .split("\n")
    .map((line) => normalizeText(line).slice(0, MAX_PARAGRAPH_LENGTH))
    .filter((paragraph) => paragraph.length >= 3)
    .slice(0, MAX_PARAGRAPHS);
  return { headings, links: [...links], paragraphs };
}

export async function extractPage(
  html: string,
  baseUrl: string,
): Promise<ExtractionResult> {
  // Title, description, and canonical address live in the head, near the start of the document.
  const head = html.slice(0, HEAD_SCAN_CHARS);
  const titleMatch = /<title\b[^<>]{0,200}>([\s\S]{0,1000}?)<\/title\s*>/i.exec(
    head,
  );
  const title = titleMatch ? stripTags(titleMatch[1] ?? "").slice(0, 300) : "";

  let metaDescription = "";
  for (const meta of firstTags(head, /<meta\b[^<>]{0,1000}>/gi)) {
    const key = (meta.get("name") ?? meta.get("property") ?? "").toLowerCase();
    if (
      key === "description" ||
      (key === "og:description" && metaDescription === "")
    ) {
      metaDescription = normalizeText(
        decodeEntities(meta.get("content") ?? ""),
      ).slice(0, 500);
      if (key === "description") break;
    }
  }

  let canonicalUrl: string | null = null;
  for (const link of firstTags(head, /<link\b[^<>]{0,1000}>/gi)) {
    if (
      (link.get("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")
    ) {
      canonicalUrl = resolveHttpUrl(link.get("href") ?? "", baseUrl);
      if (canonicalUrl) break;
    }
  }

  // The first region that yields real text wins; the start of the document is the last resort.
  let chosen: { region: Region; content: RegionContent } | null = null;
  for (const region of candidateRegions(html)) {
    const content = analyzeRegion(region.html, baseUrl);
    if (!content) continue;
    if (
      content.paragraphs.length >= MIN_REGION_PARAGRAPHS ||
      region.source === "start"
    ) {
      chosen = { region, content };
      break;
    }
  }
  if (!chosen) return { ok: false, reason: "malformed_html" };

  const { region, content } = chosen;
  const contentHash = await sha256Hex(
    `${title}\n${metaDescription}\n${content.paragraphs.join("\n")}`,
  );
  return {
    ok: true,
    page: {
      title,
      metaDescription,
      canonicalUrl,
      headings: content.headings,
      links: content.links,
      paragraphs: content.paragraphs,
      contentHash,
      regionSource: region.source,
      regionTruncated: region.truncated,
    },
  };
}
