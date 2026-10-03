import { useEffect } from "react";
import { create } from "zustand";
import type { PromptHistoryEntry } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";

/**
 * The daemon owns prompt history: it is the only party that sees every client
 * and survives a reinstall. This is a read-through cache of one project's list,
 * plus the local echo that keeps a prompt you just sent at the top of ArrowUp
 * without waiting for a round trip.
 */

/** Matches the daemon's per-project cap, so the local echo cannot outgrow it. */
export const PROMPT_HISTORY_LIMIT = 200;

export type PromptHistoryStatus = "idle" | "loading" | "ready" | "unsupported" | "error";

interface PromptHistoryProjectState {
  entries: PromptHistoryEntry[];
  status: PromptHistoryStatus;
}

const EMPTY_PROJECT_STATE: PromptHistoryProjectState = { entries: [], status: "idle" };

function cacheKey(serverId: string, projectKey: string): string {
  return `${serverId} ${projectKey}`;
}

/**
 * Re-sending an old prompt moves it to the front rather than duplicating it,
 * mirroring the daemon so a refetch never reorders what recall just showed.
 */
export function mergeRecordedPrompt(
  entries: readonly PromptHistoryEntry[],
  entry: PromptHistoryEntry,
): PromptHistoryEntry[] {
  const text = entry.text.trim();
  if (!text) return [...entries];
  return [{ ...entry, text }, ...entries.filter((candidate) => candidate.text !== text)].slice(
    0,
    PROMPT_HISTORY_LIMIT,
  );
}

interface PromptHistoryState {
  byProject: Record<string, PromptHistoryProjectState>;
  load: (input: { serverId: string; projectKey: string }) => Promise<void>;
  record: (input: { serverId: string; projectKey: string; text: string }) => void;
}

export const usePromptHistoryStore = create<PromptHistoryState>((set, get) => ({
  byProject: {},

  async load({ serverId, projectKey }) {
    const key = cacheKey(serverId, projectKey);
    if (get().byProject[key]?.status === "loading") return;

    const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
    if (!client) return;
    if (!client.supportsPromptHistory()) {
      set((state) => ({
        byProject: { ...state.byProject, [key]: { entries: [], status: "unsupported" } },
      }));
      return;
    }

    set((state) => ({
      byProject: {
        ...state.byProject,
        [key]: { entries: state.byProject[key]?.entries ?? [], status: "loading" },
      },
    }));

    try {
      const payload = await client.listPromptHistory({
        projectKey,
        limit: PROMPT_HISTORY_LIMIT,
      });
      set((state) => ({
        byProject: {
          ...state.byProject,
          [key]: { entries: payload.entries, status: payload.error ? "error" : "ready" },
        },
      }));
    } catch (error) {
      console.warn("[PromptHistory] Failed to load prompt history", error);
      set((state) => ({
        byProject: {
          ...state.byProject,
          [key]: { entries: state.byProject[key]?.entries ?? [], status: "error" },
        },
      }));
    }
  },

  record({ serverId, projectKey, text }) {
    const key = cacheKey(serverId, projectKey);
    set((state) => {
      const previous = state.byProject[key] ?? EMPTY_PROJECT_STATE;
      if (previous.status === "unsupported") return state;
      return {
        byProject: {
          ...state.byProject,
          [key]: {
            status: previous.status === "idle" ? "ready" : previous.status,
            entries: mergeRecordedPrompt(previous.entries, { text, at: Date.now() }),
          },
        },
      };
    });
  },
}));

export interface PromptHistory {
  entries: readonly PromptHistoryEntry[];
  status: PromptHistoryStatus;
}

/**
 * Loads once per project and then follows the local echo. History changes only
 * when this client sends something, so there is nothing to subscribe to.
 */
export function usePromptHistory(input: {
  serverId: string | null;
  projectKey: string | null;
}): PromptHistory {
  const { serverId, projectKey } = input;
  const load = usePromptHistoryStore((state) => state.load);
  const project = usePromptHistoryStore((state) =>
    serverId && projectKey
      ? (state.byProject[cacheKey(serverId, projectKey)] ?? EMPTY_PROJECT_STATE)
      : EMPTY_PROJECT_STATE,
  );
  const isConnected = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.client?.isConnected ?? false) : false,
  );

  useEffect(() => {
    if (!serverId || !projectKey || !isConnected) return;
    void load({ serverId, projectKey });
  }, [isConnected, load, projectKey, serverId]);

  return project;
}

export function recordPromptHistory(input: {
  serverId: string | null;
  projectKey: string | null;
  text: string;
}): void {
  const text = input.text.trim();
  if (!input.serverId || !input.projectKey || !text) return;
  usePromptHistoryStore
    .getState()
    .record({ serverId: input.serverId, projectKey: input.projectKey, text });
}
