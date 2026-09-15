import {
  getHandoffDepthFromLabels,
  getHandoffObjectiveFromLabels,
  getHandoffRootAgentIdFromLabels,
} from "@getpaseo/protocol/agent-labels";

import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { extractHandoffTimelineFacts } from "./timeline-facts.js";

export interface HandoffLineage {
  /** How many handoffs produced the source agent. 0 means it started the chain. */
  depth: number;
  rootAgentId: string;
  /** The original request. Null when the source never received one. */
  rootObjective: string | null;
}

/**
 * Resolves where the source agent sits in its handoff chain, from its labels
 * alone plus its own timeline.
 *
 * Every handoff summarizes. Taking the objective from the immediate predecessor
 * would summarize an already-summarized objective at each hop and let the goal
 * drift, so the original is carried forward on a label and re-read here
 * unchanged. Only the narrative is regenerated per handoff.
 */
export function resolveHandoffLineage(input: {
  sourceAgentId: string;
  sourceLabels: Record<string, unknown> | null | undefined;
  sourceTimeline: readonly AgentTimelineItem[];
}): HandoffLineage {
  const carriedObjective = getHandoffObjectiveFromLabels(input.sourceLabels);

  return {
    depth: getHandoffDepthFromLabels(input.sourceLabels),
    rootAgentId: getHandoffRootAgentIdFromLabels(input.sourceLabels) ?? input.sourceAgentId,
    // A source that started the chain has no carried objective, so its own
    // opening message is the original request.
    rootObjective: carriedObjective ?? extractHandoffTimelineFacts(input.sourceTimeline).objective,
  };
}
