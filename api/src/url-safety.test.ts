// FILE: api/src/url-safety.test.ts
// Tests for address validation, hostname rules, and public-IP classification.
import { describe, expect, it } from "vitest";
import {
  checkMonitoredUrl,
  isPublicIpAddress,
  type UrlRejection,
} from "./url-safety";

const accepted = (input: string): string => {
  const result = checkMonitoredUrl(input);
  if (!result.ok) throw new Error(`Expected acceptance, got ${result.reason}`);
  return result.url;
};
const rejection = (input: string): UrlRejection | null => {
  const result = checkMonitoredUrl(input);
  return result.ok ? null : result.reason;
};

describe("checkMonitoredUrl: accepted addresses", () => {
  it("normalizes case, whitespace, fragments, and trailing dots", () => {
    expect(accepted("  https://Acme.Example.COM/Pricing#plans ")).toBe(
      "https://acme.example.com/Pricing",
    );
    expect(accepted("https://acme.example.com./pricing")).toBe(
      "https://acme.example.com/pricing",
    );
  });

  it("keeps paths and query strings and accepts explicit default ports", () => {
    expect(accepted("http://acme.example.com/a?b=1&c=2")).toBe(
      "http://acme.example.com/a?b=1&c=2",
    );
    expect(accepted("https://acme.example.com:443/")).toBe(
      "https://acme.example.com/",
    );
    expect(accepted("http://acme.example.com:80/")).toBe(
      "http://acme.example.com/",
    );
  });

  it("accepts internationalized names in their ASCII form", () => {
    expect(accepted("https://bücher.example.com/")).toBe(
      "https://xn--bcher-kva.example.com/",
    );
  });
});

describe("checkMonitoredUrl: rejected addresses", () => {
  it.each([
    ["not a url", "invalid"],
    ["", "invalid"],
    ["https://acme.123/", "invalid"], // a numeric last label is parsed as a malformed IPv4 address
    ["ftp://acme.example.com/file", "protocol"],
    ["javascript:alert(1)", "protocol"],
    ["file:///etc/passwd", "protocol"],
    ["data:text/html,hello", "protocol"],
    ["https://user:secret@acme.example.com/", "credentials"],
    ["https://user@acme.example.com/", "credentials"],
    ["https://acme.example.com:8443/", "port"],
    ["http://acme.example.com:22/", "port"],
  ] as [string, UrlRejection][])("rejects %s as %s", (input, reason) => {
    expect(rejection(input)).toBe(reason);
  });

  it("rejects addresses longer than 2048 characters", () => {
    expect(rejection(`https://acme.example.com/${"a".repeat(2050)}`)).toBe(
      "too_long",
    );
  });

  it.each([
    "http://127.0.0.1/",
    "http://10.0.0.5/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.1/",
    "https://8.8.8.8/",
    "http://[::1]/",
    "http://[2001:db8::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://2130706433/", // decimal form of 127.0.0.1
    "http://0x7f000001/", // hex form
    "http://0177.0.0.1/", // octal form
    "http://127.1/", // shorthand form
    "http://1.2.3/",
  ])("rejects the IP literal %s", (input) => {
    expect(rejection(input)).toBe("ip_literal");
  });

  it.each([
    "http://localhost/",
    "http://localhost./",
    "http://LOCALHOST/",
    "http://app.localhost/",
    "http://printer.local/",
    "http://metadata.google.internal/",
    "http://wiki.intranet/",
    "http://router.lan/",
    "http://nas.home.arpa/",
    "http://db.corp/",
  ])("rejects the internal hostname %s", (input) => {
    expect(rejection(input)).toBe("internal_hostname");
  });

  it.each([
    "http://intranet-server/",
    "http://singlelabel/",
    "https://-bad.example.com/",
    "https://exa_mple.com/",
  ])("rejects the invalid or non-public hostname %s", (input) => {
    expect(rejection(input)).toBe("invalid_hostname");
  });

  it("does not treat lookalike public names as internal", () => {
    expect(rejection("https://localhost.example.com/")).toBeNull();
    expect(rejection("https://notlocal.com/")).toBeNull();
    expect(rejection("https://my-home.com/")).toBeNull();
  });
});

describe("isPublicIpAddress: IPv4", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.32.0.1",
    "172.15.255.255",
    "100.63.255.255",
    "100.128.0.1",
    "192.169.0.1",
    "198.20.0.1",
  ])("treats %s as public", (address) =>
    expect(isPublicIpAddress(address)).toBe(true),
  );

  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "127.255.255.254",
    "100.64.0.1",
    "100.127.255.255",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.10",
    "192.168.0.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
  ])("treats %s as not public", (address) =>
    expect(isPublicIpAddress(address)).toBe(false),
  );

  it("fails closed on malformed input", () => {
    for (const value of [
      "",
      "256.1.1.1",
      "1.2.3",
      "1.2.3.4.5",
      "abc",
      "1.2.3.-4",
    ]) {
      expect(isPublicIpAddress(value)).toBe(false);
    }
  });
});

describe("isPublicIpAddress: IPv6", () => {
  it.each([
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2a00:1450:4001:81b::200e",
    "[2606:4700:4700::1111]",
  ])("treats %s as public", (address) =>
    expect(isPublicIpAddress(address)).toBe(true),
  );

  it.each([
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "ff02::1",
    "2001:db8::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "100::1",
    "3fff::1",
    "fec0::1",
  ])("treats %s as not public", (address) =>
    expect(isPublicIpAddress(address)).toBe(false),
  );

  it("judges mapped, NAT64, and 6to4 addresses by the IPv4 address inside them", () => {
    expect(isPublicIpAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicIpAddress("64:ff9b::808:808")).toBe(true);
    expect(isPublicIpAddress("64:ff9b::7f00:1")).toBe(false);
    expect(isPublicIpAddress("2002:0808:0808::1")).toBe(true);
    expect(isPublicIpAddress("2002:7f00:0001::1")).toBe(false);
  });

  it("fails closed on malformed input", () => {
    for (const value of [
      "2606:4700::zzzz",
      "1:2:3:4:5:6:7:8:9",
      "::1::2",
      "fe80::1%eth0",
      "2606:4700:4700:0:0:0:0:0:1111:1",
    ]) {
      expect(isPublicIpAddress(value)).toBe(false);
    }
  });
});
