import { useSessionStore } from "@/stores/session-store";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

/**
 * Where an agent tab is allowed to live: under the key of the host that owns the agent, in the
 * workspace that host places it in. Both halves have been violated in the field, and both leave
 * the same wreckage — the tab is opened with `pin`, and reconciliation keeps a pinned agent for
 * as long as it is absent from that workspace's active set, so a tab that should never have
 * existed is the one tab that never goes away.
 *
 * Agent ids are host-local: a daemon mints them for its own agents and knows nothing of another
 * daemon's. A tab holding a foreign id renders "Agent not found" forever, and closing it does not
 * clear it, because the close path cannot reach the owning host to retire the open-tab label.
 *
 * Every negative here is conditioned on the host having said enough to be believed:
 *
 * - "This host does not know the agent" counts only once its agent list has arrived. Before that
 *   it is indistinguishable from "it has not told us yet", and a handoff can briefly leave one id
 *   known to both hosts.
 * - "The agent lives in another workspace" counts only when the host places both that workspace
 *   and this key's workspace. An agent the directory does not place yet still opens, which is
 *   what lets a deep link into an archived workspace recover it.
 */

export interface AgentTabHostKnowledge {
  serverId: string;
  /** Whether this host has a record of the agent id, from either the directory or a detail fetch. */
  knowsAgent: boolean;
  /** Whether this host's agent list has arrived. An unhydrated host cannot deny anything. */
  hasHydratedAgents: boolean;
}

export type AgentTabOwnershipVerdict =
  | { kind: "allow" }
  | { kind: "reject"; reason: "foreign-host"; ownerServerId: string }
  | { kind: "reject"; reason: "foreign-workspace"; agentWorkspaceKey: string };

export function getWorkspaceKeyServerId(workspaceKey: string): string | null {
  // Split on the first colon only: a server id never contains one, a workspace map key may.
  const separatorIndex = workspaceKey.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  return workspaceKey.slice(0, separatorIndex);
}

export function getWorkspaceKeyWorkspaceId(workspaceKey: string): string | null {
  const separatorIndex = workspaceKey.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  return normalizeWorkspaceOpaqueId(workspaceKey.slice(separatorIndex + 1));
}

/** The agent id a tab target makes its host answer for, or null when it asks the host nothing. */
export function getTargetAgentId(target: WorkspaceTabTarget): string | null {
  if (target.kind === "agent") {
    return target.agentId;
  }
  if (target.kind === "provider_subagent") {
    return target.parentAgentId;
  }
  return null;
}

export function resolveAgentTabOwnership(input: {
  keyServerId: string;
  /** This key's workspace and the agent's, both resolved against the host's directory. */
  keyWorkspaceKey: string | null;
  agentWorkspaceKey: string | null;
  hosts: readonly AgentTabHostKnowledge[];
}): AgentTabOwnershipVerdict {
  const keyHost = input.hosts.find((host) => host.serverId === input.keyServerId);
  if (keyHost?.knowsAgent === true) {
    if (
      input.keyWorkspaceKey &&
      input.agentWorkspaceKey &&
      input.keyWorkspaceKey !== input.agentWorkspaceKey
    ) {
      return {
        kind: "reject",
        reason: "foreign-workspace",
        agentWorkspaceKey: input.agentWorkspaceKey,
      };
    }
    return { kind: "allow" };
  }
  if (!keyHost?.hasHydratedAgents) {
    return { kind: "allow" };
  }
  const owner = input.hosts.find((host) => host.serverId !== input.keyServerId && host.knowsAgent);
  return owner
    ? { kind: "reject", reason: "foreign-host", ownerServerId: owner.serverId }
    : { kind: "allow" };
}

function readAgentTabHosts(agentId: string): AgentTabHostKnowledge[] {
  return Object.entries(useSessionStore.getState().sessions).map(([serverId, session]) => ({
    serverId,
    knowsAgent: session.agents.has(agentId) || session.agentDetails.has(agentId),
    hasHydratedAgents: session.hasHydratedAgents,
  }));
}

/**
 * Both workspaces as the host's directory keys them, so a layout key written from a descriptor id
 * and one written from a map key compare equal. Either side is null when the directory cannot
 * place it, which is the signal to let the open through.
 */
function readWorkspaceKeys(input: {
  keyServerId: string;
  keyWorkspaceId: string | null;
  agentId: string;
}) {
  const session = useSessionStore.getState().sessions[input.keyServerId];
  const workspaces = session?.workspaces;
  const agent = session?.agents.get(input.agentId) ?? session?.agentDetails.get(input.agentId);
  return {
    keyWorkspaceKey: resolveWorkspaceMapKeyByIdentity({
      workspaces,
      workspaceId: input.keyWorkspaceId,
    }),
    agentWorkspaceKey: resolveWorkspaceMapKeyByIdentity({
      workspaces,
      workspaceId: agent?.workspaceId,
    }),
  };
}

function resolveWorkspaceKeyOwnership(
  workspaceKey: string,
  agentId: string,
): AgentTabOwnershipVerdict {
  const keyServerId = getWorkspaceKeyServerId(workspaceKey);
  if (!keyServerId) {
    return { kind: "allow" };
  }
  return resolveAgentTabOwnership({
    keyServerId,
    ...readWorkspaceKeys({
      keyServerId,
      keyWorkspaceId: getWorkspaceKeyWorkspaceId(workspaceKey),
      agentId,
    }),
    hosts: readAgentTabHosts(agentId),
  });
}

/**
 * The other host that owns this agent id, when one does and the named host demonstrably does not.
 * Null means the named host may act on the agent: either it owns it, or nothing connected knows
 * enough to say otherwise.
 */
export function findForeignAgentOwner(input: {
  keyServerId: string;
  agentId: string;
}): string | null {
  const verdict = resolveAgentTabOwnership({
    keyServerId: input.keyServerId,
    keyWorkspaceKey: null,
    agentWorkspaceKey: null,
    hosts: readAgentTabHosts(input.agentId),
  });
  return verdict.kind === "reject" && verdict.reason === "foreign-host"
    ? verdict.ownerServerId
    : null;
}

/** Whether a tab for this target may be opened under this workspace key. */
export function canOpenTargetInWorkspaceKey(workspaceKey: string, target: WorkspaceTabTarget) {
  const agentId = getTargetAgentId(target);
  if (!agentId) {
    return true;
  }
  const verdict = resolveWorkspaceKeyOwnership(workspaceKey, agentId);
  if (verdict.kind === "reject") {
    console.warn("[WorkspaceTabs] Refused an agent tab outside the agent's own workspace", {
      agentId,
      workspaceKey,
      ...(verdict.reason === "foreign-host"
        ? { ownerServerId: verdict.ownerServerId }
        : { agentWorkspaceKey: verdict.agentWorkspaceKey }),
    });
    return false;
  }
  return true;
}
