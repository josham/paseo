import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "../agent-sdk-types.js";
import type { HandoffGitReader } from "./git-facts.js";
import { planHandoff } from "./plan.js";

const NO_GIT: HandoffGitReader = {
  async getSnapshot() {
    return { git: { isGit: false, currentBranch: null, baseRef: null } };
  },
  async getCheckoutDiff() {
    return { diff: "", structured: [] };
  },
};

const SOURCE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: "/work",
  model: "claude-opus-5",
  modeId: "plan",
};

function plan(target?: Parameters<typeof planHandoff>[0]["target"]) {
  return planHandoff({
    source: { id: "agent-1", cwd: "/work", labels: {}, config: SOURCE_CONFIG },
    ...(target ? { target } : {}),
    timeline: [{ type: "user_message", text: "Add retry" }],
    gitReader: NO_GIT,
    generateNarrative: async () => null,
  });
}

describe("plan handoff", () => {
  test("names the endpoint the successor will actually run as", async () => {
    const result = await plan({ provider: "codex", model: "gpt-5.4-codex" });

    expect(result.config).toEqual({
      provider: "codex",
      cwd: "/work",
      model: "gpt-5.4-codex",
    });
    expect(result.brief).toContain(
      "Handed off from claude (claude-opus-5) to codex (gpt-5.4-codex).",
    );
  });

  test("reports the target's inherited model rather than the one asked for", async () => {
    const result = await plan({ model: "claude-haiku-4-5" });

    expect(result.config.model).toBe("claude-haiku-4-5");
    expect(result.brief).toContain(
      "Handed off from claude (claude-opus-5) to claude (claude-haiku-4-5).",
    );
  });

  test("treats an untargeted handoff as a fresh context on the same setup", async () => {
    const result = await plan();

    expect(result.config).toEqual(SOURCE_CONFIG);
    expect(result.brief).toContain(
      "Continued from an earlier claude (claude-opus-5) session in a fresh context.",
    );
    expect(result.chainDepth).toBe(0);
    expect(result.rootAgentId).toBe("agent-1");
  });
});
