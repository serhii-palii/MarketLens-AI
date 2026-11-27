// FILE: api/src/change-detection.ts
// Deterministic comparison of two page snapshots: paragraph diff, paired edits, number and price changes, and a significance score.

export const SIGNIFICANCE_THRESHOLD = 0.25;

const MAX_LISTED = 50;
const MAX_TEXT_LENGTH = 500;
const MAX_PAIRING_COMPARISONS = 40_000;
const MIN_PAIR_SIMILARITY = 0.5;
const NUMBER_PATTERN = /[$€£]?\s?\d[\d.,]*%?/g;
const PRICE_PATTERN = /[$€£]\s?\d/;

export interface SnapshotContent {
  title: string;
  metaDescription: string;
  headings: string[];
  paragraphs: string[];
}

export interface ParagraphPair {
  before: string;
  after: string;
}

export interface ChangeDiff {
  titleChanged: boolean;
  metaDescriptionChanged: boolean;
  addedCount: number;
  removedCount: number;
  modifiedCount: number;
  added: string[];
  removed: string[];
  modified: ParagraphPair[];
  numericChanges: ParagraphPair[];
  priceMentions: string[];
  headingsAdded: string[];
  headingsRemoved: string[];
}

export interface ChangeAssessment {
  diff: ChangeDiff;
  types: string[];
  score: number;
  significant: boolean;
}

const clip = (value: string): string =>
  value.length > MAX_TEXT_LENGTH
    ? `${value.slice(0, MAX_TEXT_LENGTH - 1)}…`
    : value;

function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 0),
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

const numbersIn = (value: string): string[] =>
  (value.match(NUMBER_PATTERN) ?? []).map((token) => token.replace(/\s/g, ""));

// Compares paragraph multisets, so reordering alone is not a change.
function unmatched(
  before: string[],
  after: string[],
): { removed: string[]; added: string[] } {
  const remaining = new Map<string, number>();
  for (const paragraph of before)
    remaining.set(paragraph, (remaining.get(paragraph) ?? 0) + 1);
  const added: string[] = [];
  for (const paragraph of after) {
    const count = remaining.get(paragraph) ?? 0;
    if (count > 0) remaining.set(paragraph, count - 1);
    else added.push(paragraph);
  }
  const removed: string[] = [];
  for (const [paragraph, count] of remaining)
    for (let i = 0; i < count; i += 1) removed.push(paragraph);
  return { removed, added };
}

// Pairs each removed paragraph with its most similar added paragraph, so an edit is reported as an edit.
function pairEdits(
  removed: string[],
  added: string[],
): { pairs: ParagraphPair[]; removed: string[]; added: string[] } {
  if (removed.length * added.length > MAX_PAIRING_COMPARISONS)
    return { pairs: [], removed, added };
  const addedWords = added.map(words);
  const taken = new Set<number>();
  const pairs: ParagraphPair[] = [];
  const leftover: string[] = [];
  for (const before of removed) {
    const beforeWords = words(before);
    let best = -1;
    let bestScore = MIN_PAIR_SIMILARITY;
    addedWords.forEach((candidate, index) => {
      if (taken.has(index)) return;
      const score = similarity(beforeWords, candidate);
      if (score >= bestScore) {
        best = index;
        bestScore = score;
      }
    });
    if (best === -1) leftover.push(before);
    else {
      taken.add(best);
      pairs.push({ before, after: added[best] ?? "" });
    }
  }
  return {
    pairs,
    removed: leftover,
    added: added.filter((_, index) => !taken.has(index)),
  };
}

export function compareSnapshots(
  before: SnapshotContent,
  after: SnapshotContent,
): ChangeAssessment {
  const unmatchedParagraphs = unmatched(before.paragraphs, after.paragraphs);
  const { pairs, removed, added } = pairEdits(
    unmatchedParagraphs.removed,
    unmatchedParagraphs.added,
  );

  const numericChanges = pairs.filter(
    ({ before: a, after: b }) =>
      numbersIn(a).join("|") !== numbersIn(b).join("|"),
  );
  const priceMentions = [...removed, ...added].filter((paragraph) =>
    PRICE_PATTERN.test(paragraph),
  );
  const headingsBefore = new Set(before.headings);
  const headingsAfter = new Set(after.headings);
  const headingsAdded = after.headings.filter(
    (heading) => !headingsBefore.has(heading),
  );
  const headingsRemoved = before.headings.filter(
    (heading) => !headingsAfter.has(heading),
  );

  const diff: ChangeDiff = {
    titleChanged: before.title !== after.title,
    metaDescriptionChanged: before.metaDescription !== after.metaDescription,
    addedCount: added.length,
    removedCount: removed.length,
    modifiedCount: pairs.length,
    added: added.slice(0, MAX_LISTED).map(clip),
    removed: removed.slice(0, MAX_LISTED).map(clip),
    modified: pairs
      .slice(0, MAX_LISTED)
      .map((pair) => ({ before: clip(pair.before), after: clip(pair.after) })),
    numericChanges: numericChanges
      .slice(0, MAX_LISTED)
      .map((pair) => ({ before: clip(pair.before), after: clip(pair.after) })),
    priceMentions: priceMentions.slice(0, MAX_LISTED).map(clip),
    headingsAdded: headingsAdded.slice(0, MAX_LISTED).map(clip),
    headingsRemoved: headingsRemoved.slice(0, MAX_LISTED).map(clip),
  };

  const types: string[] = [];
  if (diff.titleChanged) types.push("title");
  if (diff.metaDescriptionChanged) types.push("meta_description");
  if (headingsAdded.length + headingsRemoved.length > 0) types.push("headings");
  if (added.length + removed.length + pairs.length > 0) types.push("text");
  if (numericChanges.length > 0) types.push("numbers");
  if (priceMentions.length > 0) types.push("prices");

  // Each signal contributes a bounded share; a changed price or number is the strongest on its own.
  const changedParagraphs = added.length + removed.length + pairs.length;
  const share = changedParagraphs / Math.max(1, after.paragraphs.length);
  const score = Math.min(
    1,
    (diff.titleChanged ? 0.35 : 0) +
      (diff.metaDescriptionChanged ? 0.2 : 0) +
      0.5 * Math.min(1, numericChanges.length + priceMentions.length) +
      0.35 * Math.min(1, share * 5) +
      0.15 * Math.min(1, (headingsAdded.length + headingsRemoved.length) / 3),
  );
  return {
    diff,
    types,
    score: Number(score.toFixed(3)),
    significant: score >= SIGNIFICANCE_THRESHOLD,
  };
}
