#!/usr/bin/env python3
# FILE: tools/live_check.py
# Seeds sample competitors and pages, runs page checks, and prints a results table without private details.
# Run: python3 tools/live_check.py [--rounds N] [--no-seed]
import argparse
import time
from urllib.parse import urlparse

from ml_api import session

SITES = [
    ("Anthropic (Claude)", [("Claude pricing", "https://claude.com/pricing", "marketing"),
                            ("Claude Team pricing", "https://claude.com/pricing/team", "marketing")]),
    ("Perplexity", [("Perplexity Pro", "https://www.perplexity.ai/pro", "marketing")]),
    ("Canva", [("Canva pricing", "https://www.canva.com/pricing/", "marketing")]),
    ("Notion", [("Notion pricing", "https://www.notion.com/pricing", "marketing"),
                ("Notion product", "https://www.notion.com/product", "product")]),
    ("Slack", [("Slack pricing", "https://slack.com/pricing", "marketing")]),
    ("HubSpot", [("HubSpot marketing pricing", "https://www.hubspot.com/pricing/marketing", "marketing")]),
    ("Figma", [("Figma pricing", "https://www.figma.com/pricing/", "marketing")]),
    ("Atlassian", [("Jira pricing", "https://www.atlassian.com/software/jira/pricing", "marketing")]),
    ("Mailchimp", [("Mailchimp pricing", "https://mailchimp.com/pricing/", "marketing")]),
    ("Shopify", [("Shopify pricing", "https://www.shopify.com/pricing", "marketing")]),
    ("Zoom", [("Zoom pricing (redirect test)", "https://zoom.us/pricing", "marketing")]),
    ("Baseline", [("Tiny static page", "https://example.com/", "product")]),
]


def seed(api):
    status, body = api.call("GET", "/api/owner/competitors")
    competitors = {c["name"].lower(): c["id"] for c in body.get("competitors", [])} if status == 200 else {}
    created = 0
    for name, pages in SITES:
        competitor_id = competitors.get(name.lower())
        if competitor_id is None:
            status, body = api.call("POST", "/api/owner/competitors", {"name": name})
            if status != 201:
                print(f"  could not create competitor '{name}' (HTTP {status})")
                continue
            competitor_id = body["competitor"]["id"]
            competitors[name.lower()] = competitor_id
        status, body = api.call("GET", f"/api/owner/competitors/{competitor_id}/pages")
        known = {p["url"] for p in body.get("pages", [])} if status == 200 else set()
        for label, url, category in pages:
            normalized = url if url.endswith("/") or "/" in url.split("://", 1)[1] else url + "/"
            if normalized in known or url in known:
                continue
            status, body = api.call("POST", f"/api/owner/competitors/{competitor_id}/pages",
                                    {"url": url, "label": label, "category": category})
            if status == 201:
                created += 1
            elif status != 409:
                print(f"  could not add '{label}' (HTTP {status})")
    print(f"Seed complete: {created} new page(s) added.")


def all_pages(api):
    status, body = api.call("GET", "/api/owner/competitors")
    rows = []
    for competitor in body.get("competitors", []) if status == 200 else []:
        status, pages = api.call("GET", f"/api/owner/competitors/{competitor['id']}/pages")
        for page in pages.get("pages", []) if status == 200 else []:
            rows.append((page["id"], competitor["name"], page["label"] or urlparse(page["url"]).netloc))
    return sorted(rows)


def run_checks(api, rounds):
    pages = all_pages(api)
    header = f"{'id':>3}  {'site':<18} {'page':<28} {'outcome':<15} {'detail':<26} {'KB':>5} {'from':<9} {'trunc':<5} {'secs':>5}"
    for number in range(1, rounds + 1):
        print(f"\nRound {number} of {rounds}")
        print(header)
        for page_id, site, label in pages:
            started = time.time()
            status, body = api.call("POST", f"/api/owner/pages/{page_id}/check", {})
            seconds = time.time() - started
            result = body.get("result", {}) if status == 200 else {}
            outcome = result.get("outcome", f"http_{status}")
            detail = result.get("reason") or (f"HTTP {result['httpStatus']}" if result.get("httpStatus") else "")
            if result.get("reason") == "http_error" and result.get("httpStatus"):
                detail = f"http_error {result['httpStatus']}"
            kilobytes = f"{result['bytesRead'] / 1000:.0f}" if result.get("bytesRead") else "-"
            print(f"{page_id:>3}  {site[:18]:<18} {label[:28]:<28} {outcome:<15} {str(detail)[:26]:<26} {kilobytes:>5} "
                  f"{(result.get('extractedFrom') or '-'):<9} {('-' if result.get('truncated') is None else str(result['truncated']).lower()):<5} {seconds:>5.1f}")
            time.sleep(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rounds", type=int, default=1, help="how many times to check every page")
    parser.add_argument("--no-seed", action="store_true", help="skip adding the sample competitors and pages")
    args = parser.parse_args()

    with session() as api:
        if not args.no_seed:
            seed(api)
        run_checks(api, max(1, args.rounds))
    print("\nThe table above contains no address, key, or cookie and is safe to share.")


if __name__ == "__main__":
    main()