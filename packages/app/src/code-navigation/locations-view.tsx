import { useCallback } from "react";
import { RefreshCw } from "lucide-react-native";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { CodeLocation } from "@getpaseo/protocol/messages";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useFetchQuery } from "@/data/query";
import { PaneContentToolbar, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { CodeLocationsList } from "./locations-list";
import {
  CODE_LOCATIONS_STALE_TIME_MS,
  codeLocationsQueryKey,
  fetchCodeLocations,
  type CodeLocationsRequest,
} from "./query";
import { describeUnavailable } from "./unavailable";

const ThemedRefreshCw = withUnistyles(RefreshCw);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface CodeLocationsViewProps {
  request: CodeLocationsRequest;
  onOpenLocation: (location: CodeLocation) => void;
  /** The sheet has its own header, so only the pane shows the toolbar title. */
  showTitle: boolean;
}

/** Runs one code navigation query and lists what it found. */
export function CodeLocationsView({ request, onOpenLocation, showTitle }: CodeLocationsViewProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(request.serverId);
  const query = useFetchQuery({
    queryKey: codeLocationsQueryKey(request),
    queryFn: () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return fetchCodeLocations(client, request);
    },
    enabled: client !== null,
    dataShape: "value",
    staleTimeMs: CODE_LOCATIONS_STALE_TIME_MS,
  });
  const { refetch } = query;
  const refresh = useCallback(() => void refetch(), [refetch]);
  const title =
    request.kind === "definition"
      ? t("panels.codeNavigation.definitionsOf", { symbol: request.query.symbol })
      : t("panels.codeNavigation.usagesOf", { symbol: request.query.symbol });
  const result = query.data;
  const locations = result?.status === "ok" ? result.locations : [];

  return (
    <View style={styles.container} testID="code-locations">
      <PaneContentToolbar style={styles.toolbar}>
        <Text style={styles.title} numberOfLines={1}>
          {showTitle ? title : summary({ result, t })}
        </Text>
        <ToolbarButton
          label={t("panels.codeNavigation.refresh")}
          onPress={refresh}
          disabled={query.isFetching}
          testID="code-locations-refresh"
        >
          <ThemedRefreshCw size={14} uniProps={mutedColor} />
        </ToolbarButton>
      </PaneContentToolbar>
      {showTitle && result?.status === "ok" ? (
        <Text style={styles.note}>{summary({ result, t })}</Text>
      ) : null}
      <CodeLocationsBody
        isLoading={query.isPending}
        error={query.error}
        result={result}
        symbol={request.query.symbol}
        kind={request.kind}
      >
        <CodeLocationsList locations={locations} onOpenLocation={onOpenLocation} />
      </CodeLocationsBody>
    </View>
  );
}

function summary({
  result,
  t,
}: {
  result: CodeLocationsQueryData | undefined;
  t: ReturnType<typeof useTranslation>["t"];
}): string {
  if (result?.status !== "ok") return "";
  const parts = [t("panels.codeNavigation.resultCount", { count: result.locations.length })];
  if (result.truncated) {
    parts.push(t("panels.codeNavigation.truncated", { count: result.locations.length }));
  }
  if (result.partial) parts.push(t("panels.codeNavigation.partial"));
  return parts.join(" · ");
}

type CodeLocationsQueryData = Awaited<ReturnType<typeof fetchCodeLocations>>;

function CodeLocationsBody({
  isLoading,
  error,
  result,
  symbol,
  kind,
  children,
}: {
  isLoading: boolean;
  error: Error | null;
  result: CodeLocationsQueryData | undefined;
  symbol: string;
  kind: CodeLocationsRequest["kind"];
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <View style={styles.center} testID="code-locations-loading">
        <ThemedLoadingSpinner size="small" uniProps={mutedColor} />
        <Text style={styles.message}>{t("panels.codeNavigation.searching")}</Text>
      </View>
    );
  }
  if (error) {
    return <CenteredMessage text={t("panels.codeNavigation.failed", { message: error.message })} />;
  }
  if (!result) return null;
  if (result.status !== "ok") return <CenteredMessage text={describeUnavailable(result, t)} />;
  if (result.locations.length === 0) {
    const text =
      kind === "definition"
        ? t("panels.codeNavigation.noDefinition", { symbol })
        : t("panels.codeNavigation.noUsages", { symbol });
    return <CenteredMessage text={text} />;
  }
  return children;
}

function CenteredMessage({ text }: { text: string }) {
  return (
    <View style={styles.center} testID="code-locations-message">
      <Text style={styles.message}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
