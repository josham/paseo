import type { AgentSessionConfig, AgentTimelineItem } from "../agent-sdk-types.js";
import type { HandoffGitReader } from "./git-facts.js";
import { prepareHandoff, type PrepareHandoffInput } from "./prepare.js";
import { resolveHandoffTargetConfig, type HandoffTargetRequest } from "./target-config.js";

export interface PlanHandoffInput {
  source: {
    id: string;
    cwd: string;
    labels: Record<string, unknown>;
    config: AgentSessionConfig;
  };
  target?: HandoffTargetRequest;
  timeline: readonly AgentTimelineItem[];
  gitReader: HandoffGitReader;
  generateNarrative: PrepareHandoffInput["generateNarrative"];
}

export interface HandoffPlan {
  /** Launch config for the successor. */
  config: AgentSessionConfig;
  /** Initial prompt for the successor. */
  brief: string;
  labels: Record<string, string>;
  rootAgentId: string;
  chainDepth: number;
}

/**
 * Everything a handoff needs except the agent creation itself, which differs by
 * host — a client session creates through the session path, an MCP caller through
 * the MCP path. Resolving the target config first matters: the brief names the
 * endpoint the successor will actually run as, not the one that was asked for.
 */
export async function planHandoff(input: PlanHandoffInput): Promise<HandoffPlan> {
  const config = resolveHandoffTargetConfig({
    sourceConfig: input.source.config,
    ...(input.target ? { target: input.target } : {}),
  });

  const prepared = await prepareHandoff({
    source: {
      id: input.source.id,
      provider: input.source.config.provider,
      model: input.source.config.model ?? null,
      cwd: input.source.cwd,
      labels: input.source.labels,
    },
    target: { provider: config.provider, model: config.model ?? null },
    timeline: input.timeline,
    gitReader: input.gitReader,
    generateNarrative: input.generateNarrative,
  });

  return {
    config,
    brief: prepared.brief,
    labels: prepared.labels,
    rootAgentId: prepared.rootAgentId,
    chainDepth: prepared.chainDepth,
  };
}
