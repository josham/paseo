import { describe, expect, it } from "vitest";
import {
  getTargetAgentId,
  getWorkspaceKeyServerId,
  getWorkspaceKeyWorkspaceId,
  resolveAgentTabOwnership,
  type AgentTabHostKnowledge,
} from "./agent-tab-ownership";

function host(overrides: Partial<AgentTabHostKnowledge> = {}): AgentTabHostKnowledge {
  return {
    serverId: "srv_kalam",
    knowsAgent: false,
    hasHydratedAgents: true,
    ...overrides,
  };
}

describe("getWorkspaceKeyServerId", () => {
  it("takes everything before the first colon", () => {
    expect(getWorkspaceKeyServerId("srv_kalam:wks_1")).toBe("srv_kalam");
  });

  it("keeps a workspace key that contains colons intact", () => {
    expect(getWorkspaceKeyServerId("srv_kalam:C:/repo/project")).toBe("srv_kalam");
  });

  it("has no server id without a separator or a name before it", () => {
    expect(getWorkspaceKeyServerId("srv_kalam")).toBeNull();
    expect(getWorkspaceKeyServerId(":wks_1")).toBeNull();
  });
});

describe("getWorkspaceKeyWorkspaceId", () => {
  it("takes everything after the first colon", () => {
    expect(getWorkspaceKeyWorkspaceId("srv_kalam:wks_1")).toBe("wks_1");
    expect(getWorkspaceKeyWorkspaceId("srv_kalam:C:/repo/project")).toBe("C:/repo/project");
  });

  it("has no workspace without a separator or a name after it", () => {
    expect(getWorkspaceKeyWorkspaceId("srv_kalam")).toBeNull();
    expect(getWorkspaceKeyWorkspaceId("srv_kalam:")).toBeNull();
  });
});

describe("getTargetAgentId", () => {
  it("names the agent an agent tab asks its host for", () => {
    expect(getTargetAgentId({ kind: "agent", agentId: "agent-1" })).toBe("agent-1");
  });

  it("names the parent for a provider subagent, which is the agent the host owns", () => {
    expect(
      getTargetAgentId({
        kind: "provider_subagent",
        parentAgentId: "agent-1",
        subagentId: "sub-1",
      }),
    ).toBe("agent-1");
  });

  it("asks the host for no agent for targets that are not agents", () => {
    expect(getTargetAgentId({ kind: "terminal", terminalId: "term-1" })).toBeNull();
    expect(getTargetAgentId({ kind: "files" })).toBeNull();
  });
});

describe("resolveAgentTabOwnership", () => {
  function resolve(input: {
    hosts: readonly AgentTabHostKnowledge[];
    keyWorkspaceKey?: string | null;
    agentWorkspaceKey?: string | null;
  }) {
    return resolveAgentTabOwnership({
      keyServerId: "srv_kalam",
      keyWorkspaceKey: input.keyWorkspaceKey ?? null,
      agentWorkspaceKey: input.agentWorkspaceKey ?? null,
      hosts: input.hosts,
    });
  }

  it("allows a host that owns the agent", () => {
    expect(
      resolve({ hosts: [host({ knowsAgent: true }), host({ serverId: "srv_fiddler" })] }),
    ).toEqual({ kind: "allow" });
  });

  it("rejects an agent another connected host owns", () => {
    expect(
      resolve({ hosts: [host(), host({ serverId: "srv_fiddler", knowsAgent: true })] }),
    ).toEqual({ kind: "reject", reason: "foreign-host", ownerServerId: "srv_fiddler" });
  });

  // A cold deep link arrives before any host has been asked about the agent. Refusing here would
  // break the URL that is meant to open it.
  it("allows an agent no connected host has a record of", () => {
    expect(resolve({ hosts: [host(), host({ serverId: "srv_fiddler" })] })).toEqual({
      kind: "allow",
    });
  });

  // "I have no such agent" and "I have not sent you my agents yet" look identical in the store,
  // and a handoff can leave one id known to both hosts for a moment.
  it("allows while the key's host has not hydrated its agents", () => {
    expect(
      resolve({
        hosts: [
          host({ hasHydratedAgents: false }),
          host({ serverId: "srv_fiddler", knowsAgent: true }),
        ],
      }),
    ).toEqual({ kind: "allow" });
  });

  it("allows when the key's host is not connected at all", () => {
    expect(resolve({ hosts: [host({ serverId: "srv_fiddler", knowsAgent: true })] })).toEqual({
      kind: "allow",
    });
  });

  it("rejects an agent its own host places in another workspace", () => {
    expect(
      resolve({
        hosts: [host({ knowsAgent: true })],
        keyWorkspaceKey: "wks_landing",
        agentWorkspaceKey: "wks_home",
      }),
    ).toEqual({ kind: "reject", reason: "foreign-workspace", agentWorkspaceKey: "wks_home" });
  });

  it("allows an agent in the workspace its host places it in", () => {
    expect(
      resolve({
        hosts: [host({ knowsAgent: true })],
        keyWorkspaceKey: "wks_home",
        agentWorkspaceKey: "wks_home",
      }),
    ).toEqual({ kind: "allow" });
  });

  // Recovering an archived workspace deep-links into a workspace the directory does not list, so
  // an unplaced workspace on either side has to let the open through.
  it.each([
    ["the agent", "wks_landing", null],
    ["the key's workspace", null, "wks_home"],
  ])("allows when the directory does not place %s", (_case, keyWorkspaceKey, agentWorkspaceKey) => {
    expect(
      resolve({ hosts: [host({ knowsAgent: true })], keyWorkspaceKey, agentWorkspaceKey }),
    ).toEqual({ kind: "allow" });
  });
});
