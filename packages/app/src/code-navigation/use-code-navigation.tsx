import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CodeLocation, CodeSymbolLocationKind } from "@getpaseo/protocol/messages";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { usesCompactExplorerSidebar } from "@/workspace-tabs/explorer-sidebar";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import { CodeLocationsSheet } from "./locations-sheet";
import { openCodeLocationsInExplorer } from "./open-results";
import {
  CODE_LOCATIONS_STALE_TIME_MS,
  codeLocationsQueryKey,
  fetchCodeLocations,
  toFileLocation,
  type CodeLocationsRequest,
} from "./query";
import { definitionOutcome, type SymbolQuery } from "./results";
import { describeUnavailable } from "./unavailable";

/** A pending lookup is announced only once it is slow enough to be noticed. */
const PENDING_NOTICE_DELAY_MS = 400;

export interface SymbolRequestOptions {
  /** Unsaved editor text for the query's file, so positions match what is on screen. */
  content?: string;
}

export interface CodeNavigation {
  goToDefinition(query: SymbolQuery, options?: SymbolRequestOptions): void;
  findUsages(query: SymbolQuery, options?: SymbolRequestOptions): void;
}

export interface CodeNavigationHandle {
  /** Null when the host cannot navigate code, so callers render no affordance at all. */
  navigation: CodeNavigation | null;
  /** Render this once; it holds results on layouts without an Explorer pane. */
  resultsSheet: ReactElement | null;
}

export interface CodeNavigationInput {
  serverId: string;
  /** Null outside a workspace route, where results always use the sheet. */
  workspaceId: string | null | undefined;
  /** Workspace directory; null when the document on screen is not inside it. */
  cwd: string | null;
  /** How the surface asking opens a file, so a result lands where that surface's own opens do. */
  openLocation: (location: WorkspaceFileLocation) => void;
}

/** Go to definition and Find usages for files in one workspace, by workspace-relative path. */
export function useCodeNavigation(input: CodeNavigationInput): CodeNavigationHandle {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { serverId, workspaceId } = input;
  // COMPAT(codeNavigation): added in v0.9.3, remove gate after 2027-09-24.
  const supported = useHostFeature(serverId, "codeNavigation");
  const client = useHostRuntimeClient(serverId);
  const isCompact = useIsCompactFormFactor();
  const [sheetRequest, setSheetRequest] = useState<CodeLocationsRequest | null>(null);
  const { cwd, openLocation: openFileLocation } = input;

  const openLocation = useCallback(
    (location: CodeLocation) => openFileLocation(toFileLocation(location)),
    [openFileLocation],
  );

  const showResults = useCallback(
    (request: CodeLocationsRequest) => {
      const workspaceKey = workspaceId
        ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
        : null;
      if (usesCompactExplorerSidebar({ isCompact }) || !workspaceKey) {
        setSheetRequest(request);
        return;
      }
      openCodeLocationsInExplorer({
        workspaceKey,
        target: {
          kind: "code_locations",
          locationKind: request.kind,
          ...request.query,
        },
      });
    },
    [isCompact, serverId, workspaceId],
  );

  const navigation = useMemo<CodeNavigation | null>(() => {
    if (!supported || !client || !cwd) return null;
    const readyClient: DaemonClient = client;
    const workspaceCwd: string = cwd;

    function request(kind: CodeSymbolLocationKind, query: SymbolQuery): CodeLocationsRequest {
      return { serverId, cwd: workspaceCwd, kind, query };
    }

    function fetchFresh(locationsRequest: CodeLocationsRequest, options?: SymbolRequestOptions) {
      return queryClient.fetchQuery({
        queryKey: codeLocationsQueryKey(locationsRequest),
        queryFn: () => fetchCodeLocations(readyClient, { ...locationsRequest, ...options }),
        staleTime: 0,
      });
    }

    function findUsages(query: SymbolQuery, options?: SymbolRequestOptions) {
      const usagesRequest = request("references", query);
      // Fetched here rather than by the list so unsaved text travels with the request; the list
      // then reads the answer from the cache.
      void queryClient
        .prefetchQuery({
          queryKey: codeLocationsQueryKey(usagesRequest),
          queryFn: () => fetchCodeLocations(readyClient, { ...usagesRequest, ...options }),
          staleTime: CODE_LOCATIONS_STALE_TIME_MS,
        })
        .catch(() => undefined);
      showResults(usagesRequest);
    }

    async function goToDefinition(query: SymbolQuery, options?: SymbolRequestOptions) {
      let noticeShown = false;
      const notice = setTimeout(() => {
        noticeShown = true;
        toast.show(t("panels.codeNavigation.finding", { symbol: query.symbol }), {
          variant: "info",
          durationMs: 30_000,
        });
      }, PENDING_NOTICE_DELAY_MS);
      const definitionRequest = request("definition", query);
      let result;
      try {
        result = await fetchFresh(definitionRequest, options);
      } catch (error) {
        toast.error(
          t("panels.codeNavigation.failed", {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      } finally {
        clearTimeout(notice);
      }
      if (result.status !== "ok") {
        toast.show(describeUnavailable(result, t), { variant: "warning", durationMs: 4000 });
        return;
      }
      const outcome = definitionOutcome(result.locations, query);
      switch (outcome.kind) {
        case "open": {
          openLocation(outcome.location);
          if (noticeShown) {
            const line = outcome.location.range.start.line + 1;
            toast.show(
              t("panels.codeNavigation.opened", { location: `${outcome.location.path}:${line}` }),
              { variant: "success", durationMs: 1500 },
            );
          }
          return;
        }
        case "list":
          if (noticeShown) {
            toast.show(
              t("panels.codeNavigation.resultCount", { count: outcome.locations.length }),
              {
                durationMs: 1500,
              },
            );
          }
          showResults(definitionRequest);
          return;
        case "usages":
          findUsages(query, options);
          return;
        case "none":
          toast.show(t("panels.codeNavigation.noDefinition", { symbol: query.symbol }), {
            variant: "info",
          });
          return;
      }
    }

    return {
      goToDefinition: (query, options) => void goToDefinition(query, options),
      findUsages,
    };
  }, [client, cwd, openLocation, queryClient, serverId, showResults, supported, t, toast]);

  const closeSheet = useCallback(() => setSheetRequest(null), []);
  const resultsSheet = supported ? (
    <CodeLocationsSheet request={sheetRequest} onClose={closeSheet} onOpenLocation={openLocation} />
  ) : null;

  return { navigation, resultsSheet };
}
