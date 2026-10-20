import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { URI } from "vscode-uri";
import type { RawLocation } from "./connection.js";
import { dropEnclosingTargets, mapLocations } from "./locations.js";

function range(line: number, start: number, end: number) {
  return { start: { line, character: start }, end: { line, character: end } };
}

function location(filePath: string, line: number, overrides: Partial<RawLocation> = {}) {
  return {
    uri: URI.file(filePath).toString(),
    range: range(line, 0, 3),
    originRange: null,
    enclosingRange: null,
    ...overrides,
  };
}

describe("dropEnclosingTargets", () => {
  const documentUri = URI.file("/w/a.ts").toString();

  test("drops a same-file target that only encloses the position", () => {
    const enclosing = location("/w/a.ts", 0, {
      range: range(0, 9, 14),
      enclosingRange: { start: { line: 0, character: 0 }, end: { line: 9, character: 1 } },
    });

    expect(
      dropEnclosingTargets({
        locations: [enclosing],
        documentUri,
        position: { line: 4, character: 2 },
      }),
    ).toEqual([]);
  });

  test("keeps a target whose name contains the position", () => {
    const declaration = location("/w/a.ts", 0, {
      range: range(0, 9, 14),
      enclosingRange: { start: { line: 0, character: 0 }, end: { line: 9, character: 1 } },
    });

    expect(
      dropEnclosingTargets({
        locations: [declaration],
        documentUri,
        position: { line: 0, character: 11 },
      }),
    ).toEqual([declaration]);
  });
});

describe("mapLocations", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "paseo-locations-"));
    await writeFile(path.join(root, "b.ts"), "first\n  second line  \nthird\n");
    await writeFile(path.join(root, "a.ts"), "only\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("relative paths, trimmed previews, sorted and deduplicated", async () => {
    const b = path.join(root, "b.ts");
    const result = await mapLocations({
      locations: [location(b, 1), location(path.join(root, "a.ts"), 0), location(b, 1)],
      rootPath: root,
      toHostPath: (serverPath) => serverPath,
    });

    expect(result.truncated).toBe(false);
    expect(
      result.locations.map(({ path: filePath, preview, openable }) => ({
        path: filePath,
        preview,
        openable,
      })),
    ).toEqual([
      { path: "a.ts", preview: "only", openable: true },
      { path: "b.ts", preview: "second line", openable: true },
    ]);
  });

  test("a target outside the workspace keeps its absolute path", async () => {
    const outside = path.join(tmpdir(), "definitely-not-in-root", "lib.d.ts");
    const result = await mapLocations({
      locations: [location(outside, 0)],
      rootPath: root,
      toHostPath: (serverPath) => serverPath,
    });

    expect(result.locations).toEqual([
      { path: outside, range: range(0, 0, 3), preview: null, openable: true },
    ]);
  });

  test("a target with no daemon-side path is listed but not openable", async () => {
    const result = await mapLocations({
      locations: [location("/usr/lib/go/src/fmt/print.go", 10)],
      rootPath: root,
      toHostPath: () => null,
    });

    expect(result.locations).toEqual([
      {
        path: "/usr/lib/go/src/fmt/print.go",
        range: range(10, 0, 3),
        preview: null,
        openable: false,
      },
    ]);
  });
});
