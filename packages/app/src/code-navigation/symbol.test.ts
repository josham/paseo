import { describe, expect, it } from "vitest";
import { splitIdentifiers, symbolAt } from "./symbol";

describe("symbolAt", () => {
  it("finds the identifier around a position", () => {
    expect(symbolAt("const total = sum(a, b);", 16)).toEqual({ start: 14, end: 17, text: "sum" });
  });

  it("treats a position just past a word as that word", () => {
    expect(symbolAt("foo.bar", 3)).toEqual({ start: 0, end: 3, text: "foo" });
  });

  it("returns null between words", () => {
    expect(symbolAt("a  b", 2)).toBeNull();
  });

  it("includes $ and _ and unicode letters", () => {
    expect(symbolAt("x = $état_1 + 2", 6)).toEqual({ start: 4, end: 11, text: "$état_1" });
  });
});

describe("splitIdentifiers", () => {
  it("separates words from the punctuation and spaces between them", () => {
    expect(splitIdentifiers("foo(bar, baz)")).toEqual([
      { text: "foo", isIdentifier: true },
      { text: "(", isIdentifier: false },
      { text: "bar", isIdentifier: true },
      { text: ", ", isIdentifier: false },
      { text: "baz", isIdentifier: true },
      { text: ")", isIdentifier: false },
    ]);
  });

  it("keeps the text intact when rejoined", () => {
    const text = "  const α = β_1 + 'str';";
    expect(
      splitIdentifiers(text)
        .map((piece) => piece.text)
        .join(""),
    ).toBe(text);
  });
});
