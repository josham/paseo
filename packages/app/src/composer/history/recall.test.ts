import { describe, expect, it } from "vitest";
import {
  IDLE_PROMPT_RECALL,
  isRecalling,
  recallNext,
  recallPrevious,
  shouldRecallNext,
  shouldRecallPrevious,
  type PromptRecallState,
} from "./recall";

const ENTRIES = ["newest", "middle", "oldest"];

function recalled(index: number, draft = "draft"): PromptRecallState {
  return { index, draft };
}

describe("recallPrevious", () => {
  it("shows the newest entry and remembers the displaced draft", () => {
    const step = recallPrevious({
      state: IDLE_PROMPT_RECALL,
      entries: ENTRIES,
      text: "half typed",
    });

    expect(step).toEqual({ state: { index: 0, draft: "half typed" }, text: "newest" });
  });

  it("keeps the original draft while walking further back", () => {
    const step = recallPrevious({ state: recalled(0), entries: ENTRIES, text: "newest" });

    expect(step).toEqual({ state: { index: 1, draft: "draft" }, text: "middle" });
  });

  it("stops at the oldest entry", () => {
    expect(recallPrevious({ state: recalled(2), entries: ENTRIES, text: "oldest" })).toBeNull();
  });

  it("does nothing when there is no history", () => {
    expect(recallPrevious({ state: IDLE_PROMPT_RECALL, entries: [], text: "typed" })).toBeNull();
  });
});

describe("recallNext", () => {
  it("walks forward toward newer entries", () => {
    expect(recallNext({ state: recalled(2), entries: ENTRIES })).toEqual({
      state: { index: 1, draft: "draft" },
      text: "middle",
    });
  });

  it("restores the draft when walking past the newest entry", () => {
    expect(recallNext({ state: recalled(0, "half typed"), entries: ENTRIES })).toEqual({
      state: IDLE_PROMPT_RECALL,
      text: "half typed",
    });
  });

  it("restores an empty draft as an empty composer", () => {
    expect(recallNext({ state: recalled(0, ""), entries: ENTRIES })).toEqual({
      state: IDLE_PROMPT_RECALL,
      text: "",
    });
  });

  it("does nothing when nothing is recalled", () => {
    expect(recallNext({ state: IDLE_PROMPT_RECALL, entries: ENTRIES })).toBeNull();
  });
});

describe("a full round trip", () => {
  it("returns the composer to exactly what it held before recall", () => {
    let state = IDLE_PROMPT_RECALL;
    let text = "work in progress";

    for (let step = 0; step < ENTRIES.length; step += 1) {
      const back = recallPrevious({ state, entries: ENTRIES, text });
      expect(back).not.toBeNull();
      if (!back) return;
      ({ state, text } = back);
    }
    expect(text).toBe("oldest");

    for (let step = 0; step < ENTRIES.length; step += 1) {
      const forward = recallNext({ state, entries: ENTRIES });
      expect(forward).not.toBeNull();
      if (!forward) return;
      ({ state, text } = forward);
    }

    expect(text).toBe("work in progress");
    expect(isRecalling(state)).toBe(false);
  });
});

describe("shouldRecallPrevious", () => {
  it("reaches history from an empty composer", () => {
    expect(shouldRecallPrevious({ text: "", selection: { start: 0, end: 0 } })).toBe(true);
  });

  it("reaches history from anywhere on the first line", () => {
    expect(shouldRecallPrevious({ text: "one\ntwo", selection: { start: 3, end: 3 } })).toBe(true);
  });

  it("leaves the caret alone below the first line", () => {
    expect(shouldRecallPrevious({ text: "one\ntwo", selection: { start: 5, end: 5 } })).toBe(false);
  });

  it("leaves a selection alone", () => {
    expect(shouldRecallPrevious({ text: "one", selection: { start: 0, end: 3 } })).toBe(false);
  });
});

describe("shouldRecallNext", () => {
  it("walks forward from the last line of a recalled prompt", () => {
    expect(
      shouldRecallNext({
        state: recalled(1),
        text: "one\ntwo",
        selection: { start: 7, end: 7 },
      }),
    ).toBe(true);
  });

  it("leaves the caret alone above the last line", () => {
    expect(
      shouldRecallNext({
        state: recalled(1),
        text: "one\ntwo",
        selection: { start: 1, end: 1 },
      }),
    ).toBe(false);
  });

  it("keeps ArrowDown ordinary when nothing is recalled", () => {
    expect(
      shouldRecallNext({
        state: IDLE_PROMPT_RECALL,
        text: "typed",
        selection: { start: 5, end: 5 },
      }),
    ).toBe(false);
  });
});
