import type { WorkspaceOpenIntent } from "@/utils/host-routes";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

/**
 * A pending `?open=agent:` intent outlives the navigation that issued it: it is deferred
 * while the workspace directory hydrates, and the workspace route reads it from the global
 * URL while its own workspace comes from local params. Either gap lets the intent reach a
 * workspace it was not meant for, and an explicit open pins the agent, so a foreign tab
 * that never joins this workspace's active agents is never reconciled away.
 *
 * An agent the directory does not place yet is not foreign: recovering an archived
 * workspace opens its agent before the agent reaches the active directory.
 */
export function workspaceOpenIntentTargetsOtherWorkspace(input: {
  intent: WorkspaceOpenIntent;
  workspaceId: string;
  agentWorkspaceId: string | null | undefined;
}): boolean {
  if (input.intent.kind !== "agent") {
    return false;
  }
  const agentWorkspaceId = normalizeWorkspaceOpaqueId(input.agentWorkspaceId);
  if (!agentWorkspaceId) {
    return false;
  }
  return agentWorkspaceId !== normalizeWorkspaceOpaqueId(input.workspaceId);
}
