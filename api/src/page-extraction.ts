// FILE: api/src/page-extraction.ts
// Deterministic extraction of metadata, headings, links, and normalized text from page HTML using bounded regular expressions.

const MAX_PARAGRAPHS = 3000;
const MAX_PARAGRAPH_LENGTH = 3000;
const MAX_HEADINGS = 50;
const MAX_LINKS = 100;
const MAX_TAGS_SCANNED = 150;
const MAX_UNCLOSED = 20;

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

// Tags are matched with bounded patterns so that markup full of unmatched brackets cannot cause runaway scanning.
const TAG = "<[^<>]{0,1000}>";
const COMMENT = /<!--[\s\S]*?-->/g;
const SKIPPED_ELEMENT =
  /<(script|style|noscript|svg|template|nav|footer)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK_TAG =
  /<\/?(?:p|li|ul|ol|h[1-6]|td|th|tr|div|section|article|blockquote|figcaption|dt|dd|br)\b[^<>]{0,1000}>/gi;
const ANY_TAG = new RegExp(TAG, "g");
const OPENERS = /<!--|<(script|style|noscript|svg|template|nav|footer)\b/gi;
const CLOSERS =
  /(-->|<\/(?:script|style|noscript|svg|template|nav|footer)\s*>)/gi;

export interface ExtractedPage {
  title: string;
  metaDescription: string;
  canonicalUrl: string | null;
  headings: string[];
  links: string[];
  paragraphs: string[];
  contentHash: string;
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

export async function extractPage(
  html: string,
  baseUrl: string,
): Promise<ExtractionResult> {
  if (isMalformed(html)) return { ok: false, reason: "malformed_html" };

  const titleMatch = /<title\b[^<>]{0,200}>([\s\S]{0,1000}?)<\/title\s*>/i.exec(
    html,
  );
  const title = titleMatch ? stripTags(titleMatch[1] ?? "").slice(0, 300) : "";

  let metaDescription = "";
  for (const meta of firstTags(html, /<meta\b[^<>]{0,1000}>/gi)) {
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
  for (const link of firstTags(html, /<link\b[^<>]{0,1000}>/gi)) {
    if (
      (link.get("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")
    ) {
      canonicalUrl = resolveHttpUrl(link.get("href") ?? "", baseUrl);
      if (canonicalUrl) break;
    }
  }

  const headings: string[] = [];
  for (const match of html.matchAll(
    /<h([1-3])\b[^<>]{0,1000}>([\s\S]{0,2000}?)<\/h\1\s*>/gi,
  )) {
    const heading = stripTags(match[2] ?? "").slice(0, 300);
    if (heading) headings.push(heading);
    if (headings.length >= MAX_HEADINGS) break;
  }

  const links = new Set<string>();
  for (const match of html.matchAll(
    /<a\b[^<>]{0,1000}?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi,
  )) {
    const resolved = resolveHttpUrl(
      match[1] ?? match[2] ?? match[3] ?? "",
      baseUrl,
    );
    if (resolved) links.add(resolved);
    if (links.size >= MAX_LINKS) break;
  }

  const text = decodeEntities(
    html
      .replace(COMMENT, " ")
      .replace(SKIPPED_ELEMENT, " ")
      .replace(BLOCK_TAG, "\n")
      .replace(ANY_TAG, " "),
  );
  const paragraphs = text
    .split("\n")
    .map((line) => normalizeText(line).slice(0, MAX_PARAGRAPH_LENGTH))
    .filter((paragraph) => paragraph.length >= 3)
    .slice(0, MAX_PARAGRAPHS);

  const contentHash = await sha256Hex(
    `${title}\n${metaDescription}\n${paragraphs.join("\n")}`,
  );
  return {
    ok: true,
    page: {
      title,
      metaDescription,
      canonicalUrl,
      headings,
      links: [...links],
      paragraphs,
      contentHash,
    },
  };
}
