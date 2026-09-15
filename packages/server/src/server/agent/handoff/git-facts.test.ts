import { describe, expect, test } from "vitest";

import type { HandoffGitReader } from "./git-facts.js";
import { readHandoffGitFacts } from "./git-facts.js";

function createGitReader(input: {
  isGit?: boolean;
  currentBranch?: string | null;
  baseRef?: string | null;
  diffs?: Record<string, Awaited<ReturnType<HandoffGitReader["getCheckoutDiff"]>>>;
  failsWith?: Error;
}): HandoffGitReader & { compares: string[] } {
  const compares: string[] = [];
  return {
    compares,
    async getSnapshot() {
      if (input.failsWith) throw input.failsWith;
      return {
        git: {
          isGit: input.isGit ?? true,
          currentBranch: input.currentBranch ?? null,
          baseRef: input.baseRef ?? null,
        },
      };
    },
    async getCheckoutDiff(_cwd, compare) {
      compares.push(compare.mode);
      return input.diffs?.[compare.mode] ?? { diff: "", structured: [] };
    },
  };
}

describe("handoff git facts", () => {
  test("maps the branch diff into changed files", async () => {
    const reader = createGitReader({
      currentBranch: "feat/retry",
      baseRef: "main",
      diffs: {
        base: {
          diff: "diff --git ...",
          structured: [
            {
              path: "upload/client.ts",
              isNew: false,
              isDeleted: false,
              additions: 42,
              deletions: 3,
              hunks: [],
            },
            {
              path: "upload/retry.ts",
              isNew: true,
              isDeleted: false,
              additions: 80,
              deletions: 0,
              hunks: [],
            },
          ],
        },
      },
    });

    expect(await readHandoffGitFacts(reader, "/work")).toEqual({
      branch: "feat/retry",
      baseRef: "main",
      files: [
        { path: "upload/client.ts", additions: 42, deletions: 3, isNew: false, isDeleted: false },
        { path: "upload/retry.ts", additions: 80, deletions: 0, isNew: true, isDeleted: false },
      ],
      diffTooLarge: false,
    });
    expect(reader.compares).toEqual(["base"]);
  });

  test("compares against the working tree when the checkout has no base ref", async () => {
    const reader = createGitReader({ currentBranch: "main", baseRef: null });

    const facts = await readHandoffGitFacts(reader, "/work");

    expect(facts).toEqual({ branch: "main", baseRef: null, files: [], diffTooLarge: false });
    expect(reader.compares).toEqual(["uncommitted"]);
  });

  test("reports an unreadable diff rather than pretending nothing changed", async () => {
    const reader = createGitReader({
      currentBranch: "feat/big",
      baseRef: "main",
      diffs: { base: { diff: "", structured: [], diffTooLarge: true } },
    });

    expect(await readHandoffGitFacts(reader, "/work")).toEqual({
      branch: "feat/big",
      baseRef: "main",
      files: [],
      diffTooLarge: true,
    });
  });

  test("returns no facts for a directory that is not a git checkout", async () => {
    expect(await readHandoffGitFacts(createGitReader({ isGit: false }), "/work")).toBe(null);
  });

  test("returns no facts when git cannot be read, so the handoff still happens", async () => {
    const reader = createGitReader({ failsWith: new Error("git exploded") });

    expect(await readHandoffGitFacts(reader, "/work")).toBe(null);
  });
});
