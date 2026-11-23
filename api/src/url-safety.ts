// FILE: api/src/url-safety.ts
// Rules that decide which addresses the collection engine may contact, plus public-IP classification for DNS answers.

const MAX_URL_LENGTH = 2048;
const MAX_HOSTNAME_LENGTH = 253;

// Hostnames that point at private or internal networks by convention.
const INTERNAL_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "private",
  "home.arpa",
];

const HOSTNAME_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TLD_PATTERN = /\.[a-z][a-z0-9-]*[a-z0-9]$/;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

export type UrlRejection =
  | "invalid"
  | "too_long"
  | "protocol"
  | "credentials"
  | "port"
  | "ip_literal"
  | "internal_hostname"
  | "invalid_hostname";

export type UrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: UrlRejection };

export const REJECTION_MESSAGES: Record<UrlRejection, string> = {
  invalid: "Enter a valid URL.",
  too_long: "The URL is too long.",
  protocol: "Only http and https URLs are allowed.",
  credentials: "URLs with embedded credentials are not allowed.",
  port: "Only the default web ports are allowed.",
  ip_literal: "Use a domain name instead of an IP address.",
  internal_hostname: "Internal or local hostnames are not allowed.",
  invalid_hostname: "The hostname is not a valid public domain name.",
};

const reject = (reason: UrlRejection): UrlCheck => ({ ok: false, reason });

// Validates and normalizes an address for monitoring: http(s) only, a public-looking domain name, default ports,
// no credentials, no fragment. Run again for every redirect destination before it is followed.
export function checkMonitoredUrl(input: string): UrlCheck {
  const trimmed = input.trim();
  if (trimmed.length > MAX_URL_LENGTH) return reject("too_long");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return reject("invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return reject("protocol");
  if (parsed.username !== "" || parsed.password !== "")
    return reject("credentials");
  // The URL parser drops default ports, so any remaining port is non-standard.
  if (parsed.port !== "") return reject("port");

  // The parser converts decimal, hex, and octal IPv4 spellings to dotted form, so one pattern covers them.
  const hostname = parsed.hostname.replace(/\.$/, "").toLowerCase();
  if (hostname.startsWith("[") || IPV4_PATTERN.test(hostname))
    return reject("ip_literal");
  if (
    INTERNAL_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    )
  ) {
    return reject("internal_hostname");
  }
  if (
    hostname.length > MAX_HOSTNAME_LENGTH ||
    !HOSTNAME_PATTERN.test(hostname) ||
    !TLD_PATTERN.test(hostname)
  ) {
    return reject("invalid_hostname");
  }

  parsed.hostname = hostname;
  parsed.hash = "";
  return { ok: true, url: parsed.toString() };
}

function parseIpv4(address: string): number[] | null {
  if (!IPV4_PATTERN.test(address)) return null;
  const octets = address.split(".").map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isPublicIpv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, includes cloud metadata addresses
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, documentation
  if (a === 192 && b === 88 && c === 99) return false; // deprecated 6to4 relay
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  return a < 224; // multicast and reserved space start at 224
}

// Expands an IPv6 address (including :: and embedded IPv4) into eight 16-bit groups.
function parseIpv6(address: string): number[] | null {
  if (address.includes("%") || !address.includes(":")) return null;
  let text = address;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = parseIpv4(tail);
    if (!octets) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
    return groups.map((group) => parseInt(group, 16));
  };
  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (!head || !rest) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  return missing >= 1
    ? [...head, ...new Array<number>(missing).fill(0), ...rest]
    : null;
}

function embeddedIpv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isPublicIpv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] =
    groups;
  // IPv4-mapped (::ffff:a.b.c.d): judged by the embedded IPv4 address.
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0xffff
  ) {
    return isPublicIpv4(embeddedIpv4(g6, g7));
  }
  // NAT64 (64:ff9b::/96): judged by the embedded IPv4 address.
  if (
    g0 === 0x64 &&
    g1 === 0xff9b &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0
  ) {
    return isPublicIpv4(embeddedIpv4(g6, g7));
  }
  // 6to4 (2002::/16): judged by the embedded IPv4 address.
  if (g0 === 0x2002) return isPublicIpv4(embeddedIpv4(g1, g2));
  // Only global unicast space (2000::/3) can be public.
  if (g0 < 0x2000 || g0 > 0x3fff) return false;
  if (
    g0 === 0x2001 &&
    (g1 === 0 ||
      g1 === 0x0db8 ||
      g1 === 0x0002 ||
      (g1 >= 0x0010 && g1 <= 0x002f))
  )
    return false; // Teredo, documentation, benchmarking, ORCHID
  if (g0 === 0x3fff && g1 <= 0x0fff) return false; // documentation
  return true;
}

// Classifies a DNS answer. Anything that does not parse is treated as not public.
export function isPublicIpAddress(address: string): boolean {
  const candidate = address
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  const ipv4 = parseIpv4(candidate);
  if (ipv4) return isPublicIpv4(ipv4);
  const ipv6 = parseIpv6(candidate);
  return ipv6 ? isPublicIpv6(ipv6) : false;
}
