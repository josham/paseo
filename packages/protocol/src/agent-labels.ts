export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
/** The agent this one was handed off from — its immediate predecessor. */
export const HANDOFF_FROM_AGENT_ID_LABEL = "paseo.handoff-from-agent-id";
/**
 * The agent that started the handoff chain. Carried forward unchanged so a
 * successor several handoffs deep can still reach the original request instead
 * of a summary of a summary of it.
 */
export const HANDOFF_ROOT_AGENT_ID_LABEL = "paseo.handoff-root-agent-id";
/** How many handoffs preceded this agent. "0" is never written; its absence means zero. */
export const HANDOFF_DEPTH_LABEL = "paseo.handoff-depth";
/**
 * The original request, carried verbatim. Stored rather than re-read from the
 * root agent so lineage stays resolvable from labels alone: reading an ancestor's
 * timeline would mean loading that agent, and loading an agent resumes a provider
 * session for what is only a historical lookup.
 */
export const HANDOFF_OBJECTIVE_LABEL = "paseo.handoff-objective";
const MAX_HANDOFF_OBJECTIVE_CHARS = 600;
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";

export function getOpenAgentTabLabel(clientId: string): string {
  return `${OPEN_AGENT_TAB_LABEL_PREFIX}${clientId}`;
}

export function isOpenAgentTabLabel(label: string): boolean {
  return label.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX);
}

/**
 * Labels under this prefix are daemon-managed control state, not user metadata:
 * parentage and open-tab tracking live here. Agent-facing surfaces must refuse
 * to write them, because code elsewhere trusts them to describe relationships
 * the agent does not get to choose for itself.
 */
const RESERVED_AGENT_LABEL_PREFIX = "paseo.";

export function isReservedAgentLabel(label: string): boolean {
  return label.startsWith(RESERVED_AGENT_LABEL_PREFIX);
}

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

function readAgentIdLabel(
  labels: Record<string, unknown> | null | undefined,
  label: string,
): string | null {
  const value = labels?.[label];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  return readAgentIdLabel(labels, PARENT_AGENT_ID_LABEL);
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function getHandoffFromAgentIdFromLabels(
  labels: Record<string, unknown> | null | undefined,
) {
  return readAgentIdLabel(labels, HANDOFF_FROM_AGENT_ID_LABEL);
}

export function getHandoffRootAgentIdFromLabels(
  labels: Record<string, unknown> | null | undefined,
) {
  return readAgentIdLabel(labels, HANDOFF_ROOT_AGENT_ID_LABEL);
}

export function isHandoffAgent(agent: AgentLabelSource): boolean {
  return getHandoffFromAgentIdFromLabels(agent.labels) !== null;
}

export function getHandoffDepthFromLabels(
  labels: Record<string, unknown> | null | undefined,
): number {
  const raw = labels?.[HANDOFF_DEPTH_LABEL];
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  // An agent carrying a predecessor is at least one handoff deep even if the
  // depth label is missing or unreadable.
  return getHandoffFromAgentIdFromLabels(labels) === null ? 0 : 1;
}

export function getHandoffObjectiveFromLabels(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  const value = labels?.[HANDOFF_OBJECTIVE_LABEL];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Labels stamped on the agent a handoff creates. A handoff successor is a
 * sibling of its source, not a subagent of it, so this deliberately leaves
 * PARENT_AGENT_ID_LABEL alone — setting it would make the successor render and
 * archive as delegated work.
 */
export function buildHandoffLabels(input: {
  sourceAgentId: string;
  sourceLabels?: Record<string, unknown> | null;
  objective?: string | null;
}): Record<string, string> {
  const sourceAgentId = input.sourceAgentId.trim();
  const objective = input.objective?.trim();
  return {
    [HANDOFF_FROM_AGENT_ID_LABEL]: sourceAgentId,
    [HANDOFF_ROOT_AGENT_ID_LABEL]:
      getHandoffRootAgentIdFromLabels(input.sourceLabels) ?? sourceAgentId,
    [HANDOFF_DEPTH_LABEL]: String(getHandoffDepthFromLabels(input.sourceLabels) + 1),
    ...(objective
      ? { [HANDOFF_OBJECTIVE_LABEL]: objective.slice(0, MAX_HANDOFF_OBJECTIVE_CHARS) }
      : {}),
  };
}

export function hasOpenAgentTab(labels: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(labels ?? {}).some(
    ([label, value]) => isOpenAgentTabLabel(label) && value === "true",
  );
}
