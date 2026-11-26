#!/usr/bin/env python3
# FILE: tools/summarize_logs.py
# Summarizes an exported Observability log file: CPU and wall time per checked page, with no identifying fields.
# Run: python3 tools/summarize_logs.py path/to/export.csv
import csv
import re
import statistics
import sys
from collections import defaultdict


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def percentile(values, share):
    ordered = sorted(values)
    return ordered[int(share * (len(ordered) - 1))]


def main(path):
    with open(path, newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    by_page = defaultdict(list)
    other = defaultdict(list)
    outcomes = defaultdict(int)
    for row in rows:
        cpu = number(row.get("$workers.cpuTimeMs"))
        wall = number(row.get("$workers.wallTimeMs"))
        if cpu is None:
            continue
        message = row.get("source.message", "")
        match = re.search(r"/pages/(\d+)/check", message)
        outcomes[row.get("$workers.outcome", "unknown")] += 1
        if match:
            by_page[int(match.group(1))].append((cpu, wall))
        else:
            route = re.sub(r"\d+", "N", re.sub(r"https?://[^/\s]+", "", message))[:40] or "(no route)"
            other[route].append(cpu)

    print(f"rows: {len(rows)}   outcomes: {dict(outcomes)}")
    print("\nPage checks (CPU and wall time in ms)")
    print(f"{'page':>4} {'runs':>4} {'cpu median':>10} {'cpu max':>8} {'wall median':>11}")
    for page_id in sorted(by_page):
        samples = by_page[page_id]
        cpus = [c for c, _ in samples]
        walls = [w for _, w in samples if w is not None]
        print(f"{page_id:>4} {len(samples):>4} {statistics.median(cpus):>10.0f} {max(cpus):>8.0f} "
              f"{(statistics.median(walls) if walls else 0):>11.0f}")
    if by_page:
        everything = [c for samples in by_page.values() for c, _ in samples]
        print(f"all checks: runs {len(everything)}, cpu median {statistics.median(everything):.0f}, "
              f"p90 {percentile(everything, 0.9):.0f}, max {max(everything):.0f}")

    print("\nOther requests (route pattern, runs, cpu median, cpu max)")
    for route, values in sorted(other.items(), key=lambda item: -len(item[1]))[:8]:
        print(f"{route:<40} {len(values):>4} {statistics.median(values):>6.0f} {max(values):>6.0f}")
    print("\nThis output has no addresses, ids, or timestamps and is safe to share.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 tools/summarize_logs.py path/to/export.csv")
    main(sys.argv[1])