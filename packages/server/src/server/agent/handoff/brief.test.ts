import { describe, expect, test } from "vitest";

import { composeHandoffBrief } from "./brief.js";

const GIT = {
  branch: "feat/retry",
  baseRef: "main",
  files: [
    { path: "upload/client.ts", additions: 42, deletions: 3, isNew: false, isDeleted: false },
    { path: "upload/retry.ts", additions: 80, deletions: 0, isNew: true, isDeleted: false },
    { path: "upload/old.ts", additions: 0, deletions: 12, isNew: false, isDeleted: true },
  ],
  diffTooLarge: false,
};

const FACTS = {
  objective: "Add retry to the upload client",
  tasks: [
    { text: "Find the upload client", completed: true },
    { text: "Add the retry loop", completed: false, status: "in_progress" as const },
    { text: "Add tests", completed: false },
  ],
  recentErrors: ["ETIMEDOUT talking to the registry"],
  lastAssistantMessage: "Wiring the retry loop now",
};

describe("handoff brief", () => {
  test("composes every section in trust order across a provider change", () => {
    const brief = composeHandoffBrief({
      rootObjective: null,
      facts: FACTS,
      git: GIT,
      source: { provider: "claude", model: "claude-opus-5" },
      target: { provider: "codex", model: "gpt-5.4-codex" },
      narrative: {
        origin: "outgoing-agent",
        text: "The registry client swallows 429s, so the retry has to live above it.",
      },
      chainDepth: 0,
    });

    expect(brief).toBe(
      `# Handoff brief

You are picking up work already in progress. This brief is the only context you
have: the previous session's conversation is not available to you.

OBSERVED sections are read from git and from the previous agent's tracked state.
DECLARED sections are the previous agent's own account and are unverified — check
them against the working tree before you rely on them.

## Objective

Add retry to the upload client

## Working tree (OBSERVED)

Branch: feat/retry (base: main)
Changed files:
  ~ upload/client.ts +42 -3
  + upload/retry.ts +80 -0
  - upload/old.ts +0 -12

## Task list (OBSERVED)

- [x] Find the upload client
- [~] Add the retry loop
- [ ] Add tests

## Errors in the previous session (OBSERVED)

- ETIMEDOUT talking to the registry

## Notes from the previous agent (DECLARED)

The registry client swallows 429s, so the retry has to live above it.

## Last message from the previous agent (DECLARED)

Wiring the retry loop now

---

Handed off from claude (claude-opus-5) to codex (gpt-5.4-codex).
Start by confirming the working tree matches this brief, then continue the work.`,
    );
  });

  test("omits sections it has nothing to put in", () => {
    const brief = composeHandoffBrief({
      rootObjective: null,
      facts: {
        objective: "Fix the flaky test",
        tasks: [],
        recentErrors: [],
        lastAssistantMessage: null,
      },
      git: null,
      source: { provider: "codex", model: null },
      target: { provider: "codex", model: null },
      narrative: null,
      chainDepth: 0,
    });

    expect(brief).not.toContain("## Working tree");
    expect(brief).not.toContain("## Task list");
    expect(brief).not.toContain("## Errors");
    expect(brief).not.toContain("## Notes");
    expect(brief).not.toContain("## Last message");
    expect(brief).toContain("## Objective\n\nFix the flaky test");
  });

  test("describes a same-provider same-model handoff as a fresh context", () => {
    const brief = composeHandoffBrief({
      rootObjective: null,
      facts: FACTS,
      git: null,
      source: { provider: "claude", model: "claude-opus-5" },
      target: { provider: "claude", model: "claude-opus-5" },
      narrative: null,
      chainDepth: 0,
    });

    expect(brief).toContain(
      "Continued from an earlier claude (claude-opus-5) session in a fresh context.",
    );
  });

  test("prefers the chain root objective over the source agent's first message", () => {
    const brief = composeHandoffBrief({
      rootObjective: "Add retry to the upload client",
      facts: { ...FACTS, objective: "# Handoff brief\n\nYou are picking up work" },
      git: null,
      source: { provider: "claude", model: null },
      target: { provider: "codex", model: null },
      narrative: null,
      chainDepth: 2,
    });

    expect(brief).toContain("## Objective\n\nAdd retry to the upload client");
    expect(brief).toContain(
      "This is handoff 3 of a chain. The objective above is the original request, carried forward unchanged.",
    );
  });

  test("says so when the diff was too large to read", () => {
    const brief = composeHandoffBrief({
      rootObjective: null,
      facts: FACTS,
      git: { branch: "feat/retry", baseRef: "main", files: [], diffTooLarge: true },
      source: { provider: "claude", model: null },
      target: { provider: "codex", model: null },
      narrative: null,
      chainDepth: 0,
    });

    expect(brief).toContain(
      "Changed files: the diff is too large to summarize — inspect it with git yourself.",
    );
  });
});

describe("handoff brief limits", () => {
  test("caps the file list and says how many it dropped", () => {
    const files = Array.from({ length: 45 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      additions: 1,
      deletions: 0,
      isNew: false,
      isDeleted: false,
    }));

    const brief = composeHandoffBrief({
      rootObjective: null,
      facts: { objective: "Refactor", tasks: [], recentErrors: [], lastAssistantMessage: null },
      git: { branch: "feat/x", baseRef: "main", files, diffTooLarge: false },
      source: { provider: "claude", model: null },
      target: { provider: "codex", model: null },
      narrative: null,
      chainDepth: 0,
    });

    expect(brief).toContain("  ~ src/file-39.ts +1 -0");
    expect(brief).not.toContain("src/file-40.ts");
    expect(brief).toContain("  …and 5 more files");
  });

  test("truncates the declared sections instead of letting them run away", () => {
    const brief = composeHandoffBrief({
      rootObjective: null,
      facts: {
        objective: "Refactor",
        tasks: [],
        recentErrors: [],
        lastAssistantMessage: "b".repeat(2_000),
      },
      git: null,
      source: { provider: "claude", model: null },
      target: { provider: "codex", model: null },
      narrative: { origin: "summarizer", text: "a".repeat(8_000) },
      chainDepth: 0,
    });

    expect(brief).toContain(`${"a".repeat(4_000)}\n\n[truncated]`);
    expect(brief).toContain(`${"b".repeat(800)}\n\n[truncated]`);
    expect(brief).not.toContain("a".repeat(4_001));
    expect(brief).not.toContain("b".repeat(801));
  });

  test("stays well inside a small context window on worst-case input", () => {
    const brief = composeHandoffBrief({
      rootObjective: "o".repeat(10_000),
      facts: {
        objective: null,
        tasks: Array.from({ length: 200 }, (_, index) => ({
          text: `task ${index} ${"t".repeat(200)}`,
          completed: false,
        })),
        recentErrors: Array.from({ length: 3 }, () => "e".repeat(5_000)),
        lastAssistantMessage: "b".repeat(20_000),
      },
      git: {
        branch: "feat/x",
        baseRef: "main",
        files: Array.from({ length: 500 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          additions: 1,
          deletions: 0,
          isNew: false,
          isDeleted: false,
        })),
        diffTooLarge: false,
      },
      source: { provider: "claude", model: null },
      target: { provider: "codex", model: null },
      narrative: { origin: "summarizer", text: "a".repeat(50_000) },
      chainDepth: 1,
    });

    expect(brief.length).toBeLessThan(16_000);
  });
});
