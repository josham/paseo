import type { AgentProvider, AgentSessionConfig } from "../agent-sdk-types.js";

/** Fields the caller left out are inherited from the source agent. */
export interface HandoffTargetRequest {
  provider?: AgentProvider;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

/**
 * Builds the successor's launch config.
 *
 * Modes, models, thinking options, and feature values are provider-specific, so
 * crossing providers drops whatever the caller did not name explicitly rather
 * than carrying an id the target cannot honor. Staying on the same provider
 * inherits all of them, which makes a same-provider handoff a pure context
 * reset: same setup, clean session.
 */
export function resolveHandoffTargetConfig(input: {
  sourceConfig: AgentSessionConfig;
  target?: HandoffTargetRequest;
}): AgentSessionConfig {
  const { sourceConfig, target } = input;
  const provider = target?.provider ?? sourceConfig.provider;
  const inherited =
    provider === sourceConfig.provider
      ? {
          ...(sourceConfig.model ? { model: sourceConfig.model } : {}),
          ...(sourceConfig.modeId ? { modeId: sourceConfig.modeId } : {}),
          ...(sourceConfig.thinkingOptionId
            ? { thinkingOptionId: sourceConfig.thinkingOptionId }
            : {}),
          ...(sourceConfig.featureValues ? { featureValues: sourceConfig.featureValues } : {}),
        }
      : {};

  // Strip the provider-specific fields so `inherited` alone decides whether they
  // carry over; spreading sourceConfig whole would reintroduce them.
  const {
    model: _model,
    modeId: _modeId,
    thinkingOptionId: _thinking,
    featureValues: _features,
    ...rest
  } = sourceConfig;

  return {
    ...rest,
    provider,
    ...inherited,
    ...(target?.model ? { model: target.model } : {}),
    ...(target?.modeId ? { modeId: target.modeId } : {}),
    ...(target?.thinkingOptionId ? { thinkingOptionId: target.thinkingOptionId } : {}),
    ...(target?.featureValues ? { featureValues: target.featureValues } : {}),
  };
}

/**
 * Accepts either a bare provider id or the `provider/model` form that the
 * sibling `create_agent` tool requires. A caller that has used create_agent will
 * reach for the slash form by analogy, and silently treating "codex/gpt-5.4" as
 * a provider id fails later with an error that does not name the real problem.
 * An explicit model argument wins over one embedded in the provider string.
 */
function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseHandoffProviderArg(
  provider: string | undefined,
  model: string | undefined,
): { provider?: string; model?: string } {
  const trimmed = provider?.trim();
  if (!trimmed) {
    return model ? { model } : {};
  }

  const separator = trimmed.indexOf("/");
  if (separator === -1) {
    return { provider: trimmed, ...(model ? { model } : {}) };
  }

  const resolvedModel = model ?? nonEmpty(trimmed.slice(separator + 1));
  return {
    provider: trimmed.slice(0, separator).trim(),
    ...(resolvedModel ? { model: resolvedModel } : {}),
  };
}
