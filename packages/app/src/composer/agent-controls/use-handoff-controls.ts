import { useCallback, useMemo } from "react";

import { useCreateAgentHandoff } from "@/hooks/use-create-agent-handoff";
import type { MaterializedAgentProfile } from "@/agent-profiles/internal/materialize-profile";
import {
  buildSelectableProviderSelectorProviders,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export interface AgentHandoffControls {
  /**
   * Every provider, not just the agent's own. A running agent cannot change the
   * process it is, so reaching another provider hands the work to a new agent.
   */
  providers: ProviderSelectorProvider[];
  onHandoffToProviderAndModel: (provider: string, modelId: string) => void;
  /** Hands off using a whole profile — provider, model, mode, thinking, features. */
  onHandoffProfile: (profile: MaterializedAgentProfile) => void;
  isHandingOff: boolean;
}

export function useAgentHandoffControls(input: {
  serverId: string;
  agentId: string;
  snapshotEntries: ProviderSnapshotEntry[] | undefined;
  /** Used until the snapshot has entries, so the picker is never empty. */
  fallbackProviders: ProviderSelectorProvider[];
}): AgentHandoffControls {
  const { createHandoff, isHandingOff } = useCreateAgentHandoff();
  const { serverId, agentId, snapshotEntries } = input;

  const providers = useMemo(() => {
    const selectable = buildSelectableProviderSelectorProviders(snapshotEntries);
    return selectable.length > 0 ? selectable : input.fallbackProviders;
  }, [input.fallbackProviders, snapshotEntries]);

  const onHandoffToProviderAndModel = useCallback(
    (provider: string, modelId: string) => {
      void createHandoff({ serverId, agentId, target: { provider, model: modelId } });
    },
    [agentId, createHandoff, serverId],
  );

  const onHandoffProfile = useCallback(
    (profile: MaterializedAgentProfile) => {
      void createHandoff({
        serverId,
        agentId,
        target: {
          provider: profile.provider,
          ...(profile.modelId ? { model: profile.modelId } : {}),
          ...(profile.modeId ? { modeId: profile.modeId } : {}),
          ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
          ...(Object.keys(profile.featureValues).length > 0
            ? { featureValues: profile.featureValues }
            : {}),
        },
      });
    },
    [agentId, createHandoff, serverId],
  );

  return { providers, onHandoffToProviderAndModel, onHandoffProfile, isHandingOff };
}
