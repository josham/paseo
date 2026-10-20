import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentHandoffTarget } from "@getpaseo/client/internal/daemon-client";

import { useToast } from "@/contexts/toast-api-context";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { toErrorMessage } from "@/utils/error-messages";

export interface CreateAgentHandoffInput {
  serverId: string;
  agentId: string;
  target?: AgentHandoffTarget;
  askSourceAgent?: "auto" | "always" | "never";
}

/**
 * Hands a live agent's work to a new one and opens the successor.
 *
 * The source is deliberately left alone — a brief is lossy, and the original
 * conversation is the only way back if it turns out to be thin. Closing it is
 * the user's call.
 */
export function useCreateAgentHandoff(): {
  createHandoff: (input: CreateAgentHandoffInput) => Promise<void>;
  isHandingOff: boolean;
} {
  const { t } = useTranslation();
  const toast = useToast();
  const [isHandingOff, setIsHandingOff] = useState(false);

  const createHandoff = useCallback(
    async (input: CreateAgentHandoffInput) => {
      const client = useSessionStore.getState().sessions[input.serverId]?.client ?? null;
      if (!client) {
        toast.error(t("common.errors.daemonClientUnavailable"));
        return;
      }

      setIsHandingOff(true);
      // A handoff reads the timeline, diffs the tree, summarizes it, and starts a
      // provider session, so it runs long enough to need saying out loud.
      toast.show(
        input.target?.model
          ? t("handoff.startingModel", {
              provider: input.target.provider ?? "",
              model: input.target.model,
            })
          : t("handoff.starting", { provider: input.target?.provider ?? "" }),
      );

      try {
        const payload = await client.createAgentHandoff(input.agentId, {
          ...(input.target ? { target: input.target } : {}),
          ...(input.askSourceAgent === undefined ? {} : { askSourceAgent: input.askSourceAgent }),
        });
        if (payload.agentId) {
          navigateToAgent({ serverId: input.serverId, agentId: payload.agentId });
        }
      } catch (error) {
        toast.error(toErrorMessage(error));
      } finally {
        setIsHandingOff(false);
      }
    },
    [t, toast],
  );

  return { createHandoff, isHandingOff };
}
