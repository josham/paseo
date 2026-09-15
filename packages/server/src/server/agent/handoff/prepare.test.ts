import { describe, expect, test } from "vitest";
import {
  buildHandoffLabels,
  HANDOFF_DEPTH_LABEL,
  HANDOFF_FROM_AGENT_ID_LABEL,
  HANDOFF_OBJECTIVE_LABEL,
  HANDOFF_ROOT_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";

import type { HandoffGitReader } from "./git-facts.js";
import { prepareHandoff } from "./prepare.js";

const NO_GIT: HandoffGitReader = {
  async getSnapshot() {
    return { git: { isGit: false, currentBranch: null, baseRef: null } };
  },
  async getCheckoutDiff() {
    return { diff: "", structured: [] };
  },
};

describe("prepare handoff", () => {
  test("builds the brief and the sibling labels for a first handoff", async () => {
    const prepared = await prepareHandoff({
      source: {
        id: "agent-1",
        provider: "claude",
        model: "claude-opus-5",
        cwd: "/work",
        labels: {},
      },
      target: { provider: "codex", model: "gpt-5.4-codex" },
      timeline: [
        { type: "user_message", text: "Add retry to the upload client" },
        { type: "assistant_message", text: "Added the retry loop" },
      ],
      gitReader: NO_GIT,
      generateNarrative: async () => null,
    });

    expect(prepared.labels).toEqual({
      [HANDOFF_FROM_AGENT_ID_LABEL]: "agent-1",
      [HANDOFF_ROOT_AGENT_ID_LABEL]: "agent-1",
      [HANDOFF_DEPTH_LABEL]: "1",
      [HANDOFF_OBJECTIVE_LABEL]: "Add retry to the upload client",
    });
    expect(prepared.chainDepth).toBe(0);
    expect(prepared.rootAgentId).toBe("agent-1");
    expect(prepared.brief).toContain("## Objective\n\nAdd retry to the upload client");
    expect(prepared.brief).toContain(
      "Handed off from claude (claude-opus-5) to codex (gpt-5.4-codex).",
    );
  });

  test("carries the original objective and root through a chained handoff", async () => {
    const first = buildHandoffLabels({
      sourceAgentId: "agent-1",
      sourceLabels: {},
      objective: "Add retry to the upload client",
    });

    const prepared = await prepareHandoff({
      source: { id: "agent-2", provider: "codex", model: null, cwd: "/work", labels: first },
      target: { provider: "claude", model: null },
      timeline: [{ type: "user_message", text: "# Handoff brief\n\nYou are picking up work" }],
      gitReader: NO_GIT,
      generateNarrative: async () => null,
    });

    expect(prepared.labels).toEqual({
      [HANDOFF_FROM_AGENT_ID_LABEL]: "agent-2",
      [HANDOFF_ROOT_AGENT_ID_LABEL]: "agent-1",
      [HANDOFF_DEPTH_LABEL]: "2",
      [HANDOFF_OBJECTIVE_LABEL]: "Add retry to the upload client",
    });
    expect(prepared.chainDepth).toBe(1);
    expect(prepared.brief).toContain("## Objective\n\nAdd retry to the upload client");
    expect(prepared.brief).toContain("This is handoff 2 of a chain.");
  });

  test("includes the narrative and the working tree when both are available", async () => {
    const prepared = await prepareHandoff({
      source: { id: "agent-1", provider: "claude", model: null, cwd: "/work", labels: {} },
      target: { provider: "claude", model: null },
      timeline: [{ type: "user_message", text: "Add retry" }],
      gitReader: {
        async getSnapshot() {
          return { git: { isGit: true, currentBranch: "feat/retry", baseRef: "main" } };
        },
        async getCheckoutDiff() {
          return {
            diff: "d",
            structured: [
              {
                path: "upload/client.ts",
                isNew: false,
                isDeleted: false,
                additions: 42,
                deletions: 3,
                hunks: [],
              },
            ],
          };
        },
      },
      generateNarrative: async (digest) => ({
        origin: "summarizer",
        text: `Next step: continue (${digest})`,
      }),
    });

    expect(prepared.brief).toContain("Branch: feat/retry (base: main)");
    expect(prepared.brief).toContain("  ~ upload/client.ts +42 -3");
    expect(prepared.brief).toContain("Next step: continue (user: Add retry)");
    expect(prepared.brief).toContain(
      "Continued from an earlier claude session in a fresh context.",
    );
  });
});
