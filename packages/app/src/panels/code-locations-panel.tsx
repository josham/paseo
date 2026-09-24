import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ListTree } from "lucide-react-native";
import invariant from "tiny-invariant";
import type { CodeLocation } from "@getpaseo/protocol/messages";
import { CodeLocationsView } from "@/code-navigation/locations-view";
import { toFileLocation } from "@/code-navigation/query";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { WorkspaceCodeLocationsTabTarget } from "@/workspace-tabs/model";

function useCodeLocationsPanelDescriptor(target: WorkspaceCodeLocationsTabTarget) {
  const { t } = useTranslation();
  const label =
    target.locationKind === "definition"
      ? t("panels.codeNavigation.definitionsOf", { symbol: target.symbol })
      : t("panels.codeNavigation.usagesOf", { symbol: target.symbol });
  const subtitle = `${target.path}:${target.line + 1}`;
  return {
    label,
    subtitle,
    tooltip: `${label} — ${subtitle}`,
    titleState: "ready" as const,
    icon: ListTree,
    statusBucket: null,
  };
}

function CodeLocationsPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, openPreferredTarget } = usePaneContext();
  invariant(
    target.kind === "code_locations",
    "CodeLocationsPanel requires a code_locations target",
  );
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const request = useMemo(
    () =>
      cwd
        ? {
            serverId,
            cwd,
            kind: target.locationKind,
            query: {
              path: target.path,
              line: target.line,
              character: target.character,
              symbol: target.symbol,
            },
          }
        : null,
    [cwd, serverId, target],
  );
  const openLocation = useCallback(
    (location: CodeLocation) =>
      openPreferredTarget({ kind: "file", ...toFileLocation(location) }, "explorerFiles"),
    [openPreferredTarget],
  );
  if (!request) {
    return (
      <View style={CENTERED_STYLE}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
  return <CodeLocationsView request={request} onOpenLocation={openLocation} showTitle />;
}

const CENTERED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

export const codeLocationsPanelRegistration = definePanel("code_locations", {
  component: CodeLocationsPanel,
  useDescriptor: useCodeLocationsPanelDescriptor,
});
