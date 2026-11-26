#!/usr/bin/env python3
# FILE: tools/inspect_snapshots.py
# Shows what the stored snapshots of a page contain, or what changed between its two newest snapshots.
# Run: python3 tools/inspect_snapshots.py show 4 9      (summary of the newest snapshot of pages 4 and 9)
#      python3 tools/inspect_snapshots.py diff 8 12     (what changed between the two newest snapshots)
# The output is public page text only: no address, key, or cookie is printed.
import argparse
import difflib

from ml_api import session

MAX_LINES = 12
MAX_WIDTH = 190


def clip(text, width=MAX_WIDTH):
    text = " ".join(text.split())
    return text if len(text) <= width else text[: width - 1] + "…"


def newest_snapshots(api, page_id, count):
    status, body = api.call("GET", f"/api/owner/pages/{page_id}/snapshots")
    ids = [item["id"] for item in body.get("snapshots", [])][:count] if status == 200 else []
    details = []
    for snapshot_id in ids:
        status, body = api.call("GET", f"/api/owner/snapshots/{snapshot_id}")
        if status == 200:
            details.append(body["snapshot"])
    return details


def show(api, page_id):
    snapshots = newest_snapshots(api, page_id, 1)
    print(f"\n== page {page_id}")
    if not snapshots:
        print("no snapshots stored")
        return
    s = snapshots[0]
    lines = s["mainText"].splitlines()
    print(f"snapshot {s['id']}: {s['htmlBytes'] // 1000} KB read, truncated={str(s['truncated']).lower()}, "
          f"{len(lines)} text lines, {len(s['mainText'])} characters, {len(s['headings'])} headings, {len(s['links'])} links")
    print("title:", clip(s["title"]))
    print("description:", clip(s["metaDescription"]) or "(none)")
    print("headings:", [clip(h, 40) for h in s["headings"][:6]])
    print("text starts:")
    for line in lines[:6]:
        print("   ", clip(line))


def diff(api, page_id):
    snapshots = newest_snapshots(api, page_id, 2)
    print(f"\n== page {page_id}")
    if len(snapshots) < 2:
        print(f"only {len(snapshots)} snapshot(s) stored, nothing to compare")
        return
    new, old = snapshots[0], snapshots[1]
    print(f"comparing snapshot {old['id']} (older) with {new['id']} (newer)")
    for field in ("title", "metaDescription"):
        if old[field] != new[field]:
            print(f"{field} changed:\n  - {clip(old[field])}\n  + {clip(new[field])}")
    if old["headings"] != new["headings"]:
        print(f"headings differ ({len(old['headings'])} vs {len(new['headings'])})")
    changes = [line for line in difflib.unified_diff(old["mainText"].splitlines(), new["mainText"].splitlines(),
                                                       lineterm="", n=0) if line[:1] in "+-" and line[:3] not in ("+++", "---")]
    removed = [line for line in changes if line.startswith("-")]
    added = [line for line in changes if line.startswith("+")]
    print(f"text lines: {len(removed)} removed, {len(added)} added")
    for line in removed[:MAX_LINES]:
        print("  ", clip(line))
    for line in added[:MAX_LINES]:
        print("  ", clip(line))
    if len(removed) > MAX_LINES or len(added) > MAX_LINES:
        print(f"   … ({max(len(removed), len(added)) - MAX_LINES} more lines not shown)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["show", "diff"])
    parser.add_argument("pages", nargs="+", type=int)
    args = parser.parse_args()
    with session() as api:
        for page_id in args.pages:
            (show if args.mode == "show" else diff)(api, page_id)
    print("\nOnly public page text is shown above.")


if __name__ == "__main__":
    main()