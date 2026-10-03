import { describe, expect, it } from "vitest";
import type { CodeLocation } from "@getpaseo/protocol/messages";
import { definitionOutcome, groupLocationsByFile, type SymbolQuery } from "./results";

function location(path: string, line: number, start = 0, end = 3, openable = true): CodeLocation {
  return {
    path,
    range: { start: { line, character: start }, end: { line, character: end } },
    preview: null,
    openable,
  };
}

const query: SymbolQuery = { path: "src/main.ts", line: 3, character: 21, symbol: "greet" };

describe("groupLocationsByFile", () => {
  it("groups consecutive locations of one file", () => {
    const groups = groupLocationsByFile([
      location("a.ts", 1),
      location("a.ts", 4),
      location("b.ts", 0),
    ]);

    expect(groups.map((group) => [group.path, group.locations.length])).toEqual([
      ["a.ts", 2],
      ["b.ts", 1],
    ]);
  });
});

describe("definitionOutcome", () => {
  it("opens a single target", () => {
    const target = location("src/util.ts", 0, 16, 21);

    expect(definitionOutcome([target], query)).toEqual({ kind: "open", location: target });
  });

  it("lists several targets", () => {
    const targets = [location("a.ts", 0), location("b.ts", 0)];

    expect(definitionOutcome(targets, query)).toEqual({ kind: "list", locations: targets });
  });

  it("turns a query on the declaration itself into a usages search", () => {
    expect(definitionOutcome([location("src/main.ts", 3, 19, 24)], query)).toEqual({
      kind: "usages",
    });
  });

  it("finds nothing when no target can be opened", () => {
    expect(definitionOutcome([location("/image/lib.go", 3, 0, 3, false)], query)).toEqual({
      kind: "none",
    });
  });
});
