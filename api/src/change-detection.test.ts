// FILE: api/src/change-detection.test.ts
// Tests for snapshot comparison: edits, additions, numbers and prices, reordering, scoring, and size limits.
import { describe, expect, it } from "vitest";
import {
  SIGNIFICANCE_THRESHOLD,
  compareSnapshots,
  type SnapshotContent,
} from "./change-detection";

const filler = (count: number): string[] =>
  Array.from(
    { length: count },
    (_, i) =>
      `Filler paragraph number ${i} describes a feature of the product in plain words.`,
  );

const page = (overrides: Partial<SnapshotContent> = {}): SnapshotContent => ({
  title: "Pricing | Acme",
  metaDescription: "Simple pricing for teams.",
  headings: ["Plans"],
  paragraphs: [
    ...filler(40),
    "Pro plan: $59 per user per month, billed annually.",
    "Contact sales for enterprise needs.",
  ],
  ...overrides,
});

describe("compareSnapshots", () => {
  it("reports nothing for identical content", () => {
    const result = compareSnapshots(page(), page());
    expect(result).toMatchObject({ types: [], score: 0, significant: false });
    expect(result.diff).toMatchObject({
      addedCount: 0,
      removedCount: 0,
      modifiedCount: 0,
    });
  });

  it("treats reordered paragraphs as no change", () => {
    const a = page();
    const b = page({ paragraphs: [...a.paragraphs].reverse() });
    expect(compareSnapshots(a, b)).toMatchObject({
      types: [],
      significant: false,
    });
  });

  it("detects a price change as an edit with changed numbers", () => {
    const a = page();
    const b = page({
      paragraphs: a.paragraphs.map((p) => p.replace("$59", "$69")),
    });
    const result = compareSnapshots(a, b);
    expect(result.significant).toBe(true);
    expect(result.types).toEqual(expect.arrayContaining(["text", "numbers"]));
    expect(result.diff.modified).toEqual([
      {
        before: "Pro plan: $59 per user per month, billed annually.",
        after: "Pro plan: $69 per user per month, billed annually.",
      },
    ]);
    expect(result.diff.numericChanges).toHaveLength(1);
    expect(result.diff.addedCount).toBe(0);
  });

  it("flags a price that replaces a contact-sales line", () => {
    const a = page({
      paragraphs: [...filler(40), "Contact sales for pricing"],
    });
    const b = page({
      paragraphs: [
        ...filler(40),
        "€45",
        "per user / month, when paying annually",
      ],
    });
    const result = compareSnapshots(a, b);
    expect(result.significant).toBe(true);
    expect(result.types).toContain("prices");
    expect(result.diff.priceMentions).toEqual(["€45"]);
  });

  it("ignores a one-word wording change in a large page", () => {
    const a = page();
    const b = page({
      paragraphs: a.paragraphs.map((p, i) =>
        i === 3 ? p.replace("plain", "simple") : p,
      ),
    });
    const result = compareSnapshots(a, b);
    expect(result.diff.modifiedCount).toBe(1);
    expect(result.diff.numericChanges).toHaveLength(0);
    expect(result.significant).toBe(false);
    expect(result.score).toBeLessThan(SIGNIFICANCE_THRESHOLD);
  });

  it("treats a changed title or description as significant", () => {
    expect(
      compareSnapshots(page(), page({ title: "Plans and pricing | Acme" })),
    ).toMatchObject({ significant: true, types: ["title"] });
    expect(
      compareSnapshots(
        page(),
        page({ metaDescription: "Pricing for everyone." }),
      ).types,
    ).toEqual(["meta_description"]);
  });

  it("detects a new section and new headings", () => {
    const a = page();
    const added = Array.from(
      { length: 8 },
      (_, i) =>
        `Brand new capability ${i} announced with an entirely different description.`,
    );
    const b = page({
      paragraphs: [...a.paragraphs, ...added],
      headings: ["Plans", "New: AI forecasting"],
    });
    const result = compareSnapshots(a, b);
    expect(result.significant).toBe(true);
    expect(result.types).toEqual(expect.arrayContaining(["headings", "text"]));
    expect(result.diff.addedCount).toBe(8);
    expect(result.diff.headingsAdded).toEqual(["New: AI forecasting"]);
  });

  it("keeps unrelated paragraphs as additions and removals, not edits", () => {
    const a = page({ paragraphs: ["Alpha beta gamma delta epsilon."] });
    const b = page({
      paragraphs: [
        "Completely different sentence about unrelated topics here.",
      ],
    });
    const result = compareSnapshots(a, b);
    expect(result.diff).toMatchObject({
      modifiedCount: 0,
      addedCount: 1,
      removedCount: 1,
    });
  });

  it("caps the listed items while keeping exact counts, and stays fast", () => {
    const a = page({
      paragraphs: Array.from(
        { length: 1500 },
        (_, i) => `Old statement ${i} about unrelated subject ${i * 7}.`,
      ),
    });
    const b = page({
      paragraphs: Array.from(
        { length: 1500 },
        (_, i) => `Fresh claim ${i} regarding another matter ${i * 13}.`,
      ),
    });
    const started = Date.now();
    const result = compareSnapshots(a, b);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.diff.addedCount).toBe(1500);
    expect(result.diff.removedCount).toBe(1500);
    expect(result.diff.added).toHaveLength(50);
    expect(result.significant).toBe(true);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("clips very long paragraphs in the stored diff", () => {
    const long = "word ".repeat(400);
    const result = compareSnapshots(
      page({ paragraphs: [] }),
      page({ paragraphs: [long] }),
    );
    expect(result.diff.added[0]?.length).toBeLessThanOrEqual(500);
  });
});
