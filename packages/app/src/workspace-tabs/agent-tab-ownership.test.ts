import { describe, expect, it } from "vitest";
import {
  getTargetAgentId,
  getWorkspaceKeyServerId,
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
  it("allows a host that owns the agent", () => {
    expect(
      resolveAgentTabOwnership({
        keyServerId: "srv_kalam",
        hosts: [host({ knowsAgent: true }), host({ serverId: "srv_fiddler" })],
      }),
    ).toEqual({ kind: "allow" });
  });

  it("rejects an agent another connected host owns", () => {
    expect(
      resolveAgentTabOwnership({
        keyServerId: "srv_kalam",
        hosts: [host(), host({ serverId: "srv_fiddler", knowsAgent: true })],
      }),
    ).toEqual({ kind: "reject", ownerServerId: "srv_fiddler" });
  });

  // A cold deep link arrives before any host has been asked about the agent. Refusing here would
  // break the URL that is meant to open it.
  it("allows an agent no connected host has a record of", () => {
    expect(
      resolveAgentTabOwnership({
        keyServerId: "srv_kalam",
        hosts: [host(), host({ serverId: "srv_fiddler" })],
      }),
    ).toEqual({ kind: "allow" });
  });

  // "I have no such agent" and "I have not sent you my agents yet" look identical in the store,
  // and a handoff can leave one id known to both hosts for a moment.
  it("allows while the key's host has not hydrated its agents", () => {
    expect(
      resolveAgentTabOwnership({
        keyServerId: "srv_kalam",
        hosts: [
          host({ hasHydratedAgents: false }),
          host({ serverId: "srv_fiddler", knowsAgent: true }),
        ],
      }),
    ).toEqual({ kind: "allow" });
  });

  it("allows when the key's host is not connected at all", () => {
    expect(
      resolveAgentTabOwnership({
        keyServerId: "srv_kalam",
        hosts: [host({ serverId: "srv_fiddler", knowsAgent: true })],
      }),
    ).toEqual({ kind: "allow" });
  });
});
