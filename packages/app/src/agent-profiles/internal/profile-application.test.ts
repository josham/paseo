import { describe, expect, it } from "vitest";
import { resolveProfileApplication } from "./profile-application";
import type { MaterializedAgentProfile } from "./materialize-profile";

const CODEX_PROFILE: MaterializedAgentProfile = {
  provider: "codex",
  modelId: "gpt-5.4-codex",
  modeId: "full-access",
  thinkingOptionId: "high",
  featureValues: { webSearch: true },
};

const CLAUDE_PROFILE: MaterializedAgentProfile = {
  ...CODEX_PROFILE,
  provider: "claude",
  modelId: "claude-opus-5",
  modeId: "plan",
};

describe("profile application", () => {
  it("hands a draft the profile untouched", () => {
    expect(
      resolveProfileApplication({
        profile: CODEX_PROFILE,
        target: { kind: "draft", controls: { applyProfile: () => {} } },
      }),
    ).toEqual({ kind: "draft", profile: CODEX_PROFILE });
  });

  it("applies a same-provider profile in place, with the mode reconciled", () => {
    expect(
      resolveProfileApplication({
        profile: CLAUDE_PROFILE,
        target: {
          kind: "agent",
          agentId: "agent-1",
          currentProvider: "claude",
          availableModeIds: ["plan", "default"],
        },
      }),
    ).toEqual({ kind: "apply", profile: CLAUDE_PROFILE });
  });

  it("drops a mode the running provider does not offer", () => {
    expect(
      resolveProfileApplication({
        profile: CLAUDE_PROFILE,
        target: {
          kind: "agent",
          agentId: "agent-1",
          currentProvider: "claude",
          availableModeIds: ["default"],
        },
      }),
    ).toEqual({ kind: "apply", profile: { ...CLAUDE_PROFILE, modeId: "" } });
  });

  it("waits rather than guessing while the running provider's modes are unknown", () => {
    expect(
      resolveProfileApplication({
        profile: CLAUDE_PROFILE,
        target: {
          kind: "agent",
          agentId: "agent-1",
          currentProvider: "claude",
          availableModeIds: null,
        },
      }),
    ).toEqual({ kind: "wait" });
  });

  it("hands off when the profile belongs to another provider", () => {
    expect(
      resolveProfileApplication({
        profile: CODEX_PROFILE,
        target: {
          kind: "agent",
          agentId: "agent-1",
          currentProvider: "claude",
          availableModeIds: ["plan"],
        },
      }),
    ).toEqual({ kind: "handoff", profile: CODEX_PROFILE });
  });

  it("keeps the profile's own mode across a handoff instead of the source's", () => {
    // The running agent has no "full-access" mode, but the target provider does.
    // Reconciling against the source would strip a mode the successor can honor.
    const result = resolveProfileApplication({
      profile: CODEX_PROFILE,
      target: {
        kind: "agent",
        agentId: "agent-1",
        currentProvider: "claude",
        availableModeIds: ["plan", "default"],
      },
    });

    expect(result).toEqual({ kind: "handoff", profile: CODEX_PROFILE });
  });
});
