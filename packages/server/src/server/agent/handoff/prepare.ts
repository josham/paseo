import { buildHandoffLabels } from "@getpaseo/protocol/agent-labels";

import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type { HandoffEndpoint, HandoffNarrative } from "./brief.js";
import { composeHandoffBrief } from "./brief.js";
import type { HandoffGitReader } from "./git-facts.js";
import { readHandoffGitFacts } from "./git-facts.js";
import { resolveHandoffLineage } from "./lineage.js";
import { extractHandoffTimelineFacts, renderTimelineDigest } from "./timeline-facts.js";

export interface HandoffSource {
  id: string;
  provider: string;
  model: string | null;
  cwd: string;
  labels: Record<string, unknown>;
}

export interface PrepareHandoffInput {
  source: HandoffSource;
  target: HandoffEndpoint;
  timeline: readonly AgentTimelineItem[];
  gitReader: HandoffGitReader;
  /**
   * Produces the DECLARED section. Returning null is expected and fine — a
   * summarizer may be unavailable, and the source session may be too wedged to
   * speak for itself, which is when handoffs are needed most.
   */
  generateNarrative: (digest: string, cwd: string) => Promise<HandoffNarrative | null>;
}

export interface PreparedHandoff {
  /** The initial prompt for the successor agent. */
  brief: string;
  /** Stamped on the successor so the lineage stays resolvable from labels alone. */
  labels: Record<string, string>;
  rootAgentId: string;
  chainDepth: number;
}

export async function prepareHandoff(input: PrepareHandoffInput): Promise<PreparedHandoff> {
  const lineage = resolveHandoffLineage({
    sourceAgentId: input.source.id,
    sourceLabels: input.source.labels,
    sourceTimeline: input.timeline,
  });

  const [git, narrative] = await Promise.all([
    readHandoffGitFacts(input.gitReader, input.source.cwd),
    input.generateNarrative(renderTimelineDigest(input.timeline), input.source.cwd),
  ]);

  return {
    brief: composeHandoffBrief({
      rootObjective: lineage.rootObjective,
      facts: extractHandoffTimelineFacts(input.timeline),
      git,
      source: { provider: input.source.provider, model: input.source.model },
      target: input.target,
      narrative,
      chainDepth: lineage.depth,
    }),
    labels: buildHandoffLabels({
      sourceAgentId: input.source.id,
      sourceLabels: input.source.labels,
      objective: lineage.rootObjective,
    }),
    rootAgentId: lineage.rootAgentId,
    chainDepth: lineage.depth,
  };
}
