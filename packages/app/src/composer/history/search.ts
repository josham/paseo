import type { PromptHistoryEntry } from "@getpaseo/protocol/messages";
import {
  compareMatchScores,
  fuzzyPolicyForToken,
  type MatchRange,
  type MatchScore,
  matchRanges,
  scoreMatch,
  tokenizeQuery,
} from "@getpaseo/protocol/search/text-match";

/**
 * Fuzzy search over the prompts you have sent, in the shape fzf trained people
 * to expect: every token has to land somewhere, tokens may be out of order,
 * and characters may be scattered. `scoreMatch` already does all three — this
 * adds the preview the rows render and the spans that get marked in it.
 */

export interface PromptHistoryMatch {
  entry: PromptHistoryEntry;
  /** Whitespace-collapsed text; `ranges` index into this, not into `entry.text`. */
  preview: string;
  ranges: MatchRange[];
}

/**
 * Rows are one line, so the text is flattened before it is matched rather than
 * after. Matching the original would put highlight offsets in a string the user
 * is not looking at, and a query spanning a line break would never hit.
 */
export function previewPromptText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: MatchRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.start + last.length) {
      last.length = Math.max(last.length, range.start + range.length - last.start);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

interface ScoredMatch extends PromptHistoryMatch {
  score: MatchScore;
}

function scorePreview(
  query: string,
  preview: string,
): Omit<ScoredMatch, "entry" | "preview"> | null {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return null;

  const total: MatchScore = { tier: 0, offset: 0, spread: 0 };
  const ranges: MatchRange[] = [];
  for (const token of tokens) {
    const score = scoreMatch(token, preview, { fuzzy: fuzzyPolicyForToken(token) });
    if (!score) return null;
    total.tier += score.tier;
    total.offset += score.offset;
    total.spread = (total.spread ?? 0) + (score.spread ?? token.length);
    ranges.push(...matchRanges(token, preview, score));
  }
  return { score: total, ranges: mergeRanges(ranges) };
}

/**
 * An empty query is the plain history list, newest first — the same rows
 * ArrowUp walks, so opening search never reorders what you were just looking at.
 */
export function searchPromptHistory(input: {
  query: string;
  entries: readonly PromptHistoryEntry[];
  limit?: number;
}): PromptHistoryMatch[] {
  const limit = input.limit ?? input.entries.length;
  if (!input.query.trim()) {
    return input.entries.slice(0, limit).map((entry) => ({
      entry,
      preview: previewPromptText(entry.text),
      ranges: [],
    }));
  }

  const matches: ScoredMatch[] = [];
  for (const entry of input.entries) {
    const preview = previewPromptText(entry.text);
    const scored = scorePreview(input.query, preview);
    if (!scored) continue;
    matches.push({ entry, preview, ...scored });
  }

  // Entries arrive newest first and sort is stable, so equally good matches
  // stay in recency order.
  matches.sort((left, right) => compareMatchScores(left.score, right.score));
  return matches.slice(0, limit).map(({ entry, preview, ranges }) => ({ entry, preview, ranges }));
}
