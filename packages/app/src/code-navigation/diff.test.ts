import { describe, expect, it } from "vitest";
import type { ReviewableDiffTarget } from "@/utils/diff-layout";
import { diffSymbolTarget } from "./diff";

function target(overrides: Partial<ReviewableDiffTarget>): ReviewableDiffTarget {
  return {
    key: "k",
    filePath: "src/main.ts",
    hunkHeader: "@@",
    hunkIndex: 0,
    lineIndex: 0,
    oldLineNumber: 7,
    newLineNumber: 9,
    side: "new",
    lineNumber: 9,
    lineType: "add",
    content: "const total = sum(a, b);",
    ...overrides,
  };
}

describe("diffSymbolTarget", () => {
  it("asks about an added line at its line on disk", () => {
    expect(diffSymbolTarget({ target: target({}), sourceOffset: 15, newSideOnDisk: true })).toEqual(
      {
        query: { path: "src/main.ts", line: 8, character: 14, symbol: "sum" },
        blocked: null,
      },
    );
  });

  it("uses the new-side line for a context line clicked on its old side", () => {
    const result = diffSymbolTarget({
      target: target({ side: "old", lineType: "context", lineNumber: 7 }),
      sourceOffset: 15,
      newSideOnDisk: true,
    });

    expect(result?.query.line).toBe(8);
    expect(result?.blocked).toBeNull();
  });

  it("blocks a removed line, which is no longer on disk", () => {
    const result = diffSymbolTarget({
      target: target({ side: "old", lineType: "remove", newLineNumber: null, lineNumber: 7 }),
      sourceOffset: 15,
      newSideOnDisk: true,
    });

    expect(result?.blocked).toBe("removed_line");
  });

  it("blocks the new side of a comparison that is not the working tree", () => {
    const result = diffSymbolTarget({ target: target({}), sourceOffset: 15, newSideOnDisk: false });

    expect(result?.blocked).toBe("not_on_disk");
  });

  it("finds nothing between words", () => {
    expect(
      diffSymbolTarget({ target: target({}), sourceOffset: 12, newSideOnDisk: true }),
    ).toBeNull();
  });
});
