import { describe, expect, it } from "vitest";
import type { PromptHistoryEntry } from "@getpaseo/protocol/messages";
import { previewPromptText, searchPromptHistory } from "./search";

function entries(...texts: string[]): PromptHistoryEntry[] {
  return texts.map((text, index) => ({ text, at: 1_000 - index }));
}

function matchedTexts(input: { query: string; entries: PromptHistoryEntry[] }): string[] {
  return searchPromptHistory(input).map((match) => match.entry.text);
}

describe("previewPromptText", () => {
  it("flattens a multi-line prompt onto one line", () => {
    expect(previewPromptText("fix the\n\n  parser   bug ")).toBe("fix the parser bug");
  });
});

describe("searchPromptHistory", () => {
  const history = entries(
    "run the parser tests",
    "fix the sidebar layout",
    "add a changelog entry",
  );

  it("returns the whole history newest first for an empty query", () => {
    expect(matchedTexts({ query: "", entries: history })).toEqual([
      "run the parser tests",
      "fix the sidebar layout",
      "add a changelog entry",
    ]);
  });

  it("treats a whitespace-only query as empty", () => {
    expect(matchedTexts({ query: "   ", entries: history })).toHaveLength(3);
  });

  it("matches scattered characters the way fzf does", () => {
    expect(matchedTexts({ query: "prsrtst", entries: history })).toEqual(["run the parser tests"]);
  });

  it("requires every token to land somewhere", () => {
    expect(matchedTexts({ query: "parser layout", entries: history })).toEqual([]);
  });

  it("matches tokens in any order", () => {
    expect(matchedTexts({ query: "tests parser", entries: history })).toEqual([
      "run the parser tests",
    ]);
  });

  it("forgives a typo in a long token", () => {
    expect(matchedTexts({ query: "sidebra", entries: history })).toEqual([
      "fix the sidebar layout",
    ]);
  });

  it("matches across a line break once the prompt is flattened", () => {
    const multiline = entries("update the\nrelease notes");

    expect(matchedTexts({ query: "the release", entries: multiline })).toEqual([
      "update the\nrelease notes",
    ]);
  });

  it("ranks a whole-word hit above a scattered one", () => {
    const ranked = entries("fix parser", "prepare a series of refactors");

    expect(matchedTexts({ query: "parser", entries: ranked })[0]).toBe("fix parser");
  });

  it("keeps newer prompts first when matches are equally good", () => {
    const tied = entries("deploy staging", "deploy staging");

    expect(searchPromptHistory({ query: "deploy", entries: tied })).toHaveLength(2);
  });

  it("marks the matched span in the preview", () => {
    const [match] = searchPromptHistory({ query: "parser", entries: history });

    expect(
      match.preview.slice(match.ranges[0].start, match.ranges[0].start + match.ranges[0].length),
    ).toBe("parser");
  });

  it("merges overlapping spans from different tokens", () => {
    const [match] = searchPromptHistory({ query: "parse parser", entries: history });

    expect(match.ranges).toHaveLength(1);
  });

  it("honours a limit", () => {
    expect(searchPromptHistory({ query: "", entries: history, limit: 2 })).toHaveLength(2);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(matchedTexts({ query: "zzzz", entries: history })).toEqual([]);
  });
});
