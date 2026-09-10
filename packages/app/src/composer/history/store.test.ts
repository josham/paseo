import { describe, expect, it } from "vitest";
import type { PromptHistoryEntry } from "@getpaseo/protocol/messages";
import { mergeRecordedPrompt, PROMPT_HISTORY_LIMIT } from "./store";

function entries(...texts: string[]): PromptHistoryEntry[] {
  return texts.map((text, index) => ({ text, at: 1_000 - index }));
}

describe("mergeRecordedPrompt", () => {
  it("puts a new prompt at the front", () => {
    const merged = mergeRecordedPrompt(entries("older"), { text: "newest", at: 2_000 });

    expect(merged.map((entry) => entry.text)).toEqual(["newest", "older"]);
  });

  it("moves a re-sent prompt to the front instead of duplicating it", () => {
    const merged = mergeRecordedPrompt(entries("run tests", "fix lint"), {
      text: "fix lint",
      at: 2_000,
    });

    expect(merged.map((entry) => entry.text)).toEqual(["fix lint", "run tests"]);
  });

  it("trims the recorded text so it matches what the daemon stored", () => {
    const merged = mergeRecordedPrompt(entries("fix lint"), { text: "  fix lint  ", at: 2_000 });

    expect(merged.map((entry) => entry.text)).toEqual(["fix lint"]);
  });

  it("ignores a prompt with no content", () => {
    const merged = mergeRecordedPrompt(entries("kept"), { text: "   ", at: 2_000 });

    expect(merged.map((entry) => entry.text)).toEqual(["kept"]);
  });

  it("keeps the list within the daemon's cap", () => {
    const full = entries(...Array.from({ length: PROMPT_HISTORY_LIMIT }, (_, i) => `prompt ${i}`));

    const merged = mergeRecordedPrompt(full, { text: "newest", at: 2_000 });

    expect(merged).toHaveLength(PROMPT_HISTORY_LIMIT);
    expect(merged[0].text).toBe("newest");
  });

  it("does not mutate the list it was given", () => {
    const original = entries("one");

    mergeRecordedPrompt(original, { text: "two", at: 2_000 });

    expect(original.map((entry) => entry.text)).toEqual(["one"]);
  });
});
