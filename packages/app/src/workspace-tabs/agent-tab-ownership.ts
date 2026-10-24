import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

/**
 * Agent ids are host-local: a daemon mints them for its own agents and knows nothing of another
 * daemon's. A tab holding an agent id under a workspace key belonging to a host that does not own
 * that agent can therefore never resolve — the host is asked, answers "no such agent", and the tab
 * sits there as a permanent "Agent not found" that closing does not clear, because the close path
 * cannot reach the owning host to retire the agent's open-tab label.
 *
 * This refuses that tab at the point it would be created. The negative is only trusted once the
 * key's host has hydrated its agent list: before that, "this host does not know the agent" is
 * indistinguishable from "this host has not told us yet", and an agent handoff can briefly leave
 * one id known to both hosts.
 *
 * Only the cross-HOST case is decided here. Whether an agent belongs to a different workspace of
 * the same host needs workspace-identity resolution (a layout key is a map key, which is not
 * always the descriptor's id), and the callers that can cross workspaces already route through
 * `navigateToAgent`.
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
  | { kind: "reject"; ownerServerId: string };

export function getWorkspaceKeyServerId(workspaceKey: string): string | null {
  // Split on the first colon only: a server id never contains one, a workspace map key may.
  const separatorIndex = workspaceKey.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  return workspaceKey.slice(0, separatorIndex);
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
  hosts: readonly AgentTabHostKnowledge[];
}): AgentTabOwnershipVerdict {
  const keyHost = input.hosts.find((host) => host.serverId === input.keyServerId);
  if (keyHost?.knowsAgent === true) {
    return { kind: "allow" };
  }
  if (!keyHost?.hasHydratedAgents) {
    return { kind: "allow" };
  }
  const owner = input.hosts.find((host) => host.serverId !== input.keyServerId && host.knowsAgent);
  return owner ? { kind: "reject", ownerServerId: owner.serverId } : { kind: "allow" };
}

function readAgentTabHosts(agentId: string): AgentTabHostKnowledge[] {
  return Object.entries(useSessionStore.getState().sessions).map(([serverId, session]) => ({
    serverId,
    knowsAgent: session.agents.has(agentId) || session.agentDetails.has(agentId),
    hasHydratedAgents: session.hasHydratedAgents,
  }));
}

/**
 * The other host that owns this agent id, when one does and the named host demonstrably does not.
 * Null means the named host may hold a tab for it: either it owns the agent, or nothing connected
 * knows enough to say otherwise.
 */
export function findForeignAgentOwner(input: {
  keyServerId: string;
  agentId: string;
}): string | null {
  const verdict = resolveAgentTabOwnership({
    keyServerId: input.keyServerId,
    hosts: readAgentTabHosts(input.agentId),
  });
  return verdict.kind === "reject" ? verdict.ownerServerId : null;
}

/**
 * Whether a tab for this target may be opened under this workspace key. False only for an agent
 * another connected host owns — see the note at the top of this file.
 */
export function canOpenTargetInWorkspaceKey(workspaceKey: string, target: WorkspaceTabTarget) {
  const agentId = getTargetAgentId(target);
  const keyServerId = getWorkspaceKeyServerId(workspaceKey);
  if (!agentId || !keyServerId) {
    return true;
  }
  const ownerServerId = findForeignAgentOwner({ keyServerId, agentId });
  if (ownerServerId) {
    console.warn("[WorkspaceTabs] Refused an agent tab on a host that does not own the agent", {
      agentId,
      keyServerId,
      ownerServerId,
    });
    return false;
  }
  return true;
}
