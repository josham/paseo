import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { ListTree } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { CodeLocation } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { CodeLocationsView } from "./locations-view";
import type { CodeLocationsRequest } from "./query";

const ThemedListTree = withUnistyles(ListTree);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Results on a compact layout, where there is no Explorer pane to hold them. */
export function CodeLocationsSheet({
  request,
  onClose,
  onOpenLocation,
}: {
  request: CodeLocationsRequest | null;
  onClose: () => void;
  onOpenLocation: (location: CodeLocation) => void;
}) {
  const { t } = useTranslation();
  const symbol = request?.query.symbol ?? "";
  const title =
    request?.kind === "definition"
      ? t("panels.codeNavigation.definitionsOf", { symbol })
      : t("panels.codeNavigation.usagesOf", { symbol });
  const header = useMemo(
    () => ({
      title,
      leading: <ThemedListTree size={ICON_SIZE.md} uniProps={mutedColor} />,
    }),
    [title],
  );
  const openLocation = useCallback(
    (location: CodeLocation) => {
      onClose();
      onOpenLocation(location);
    },
    [onClose, onOpenLocation],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={request !== null}
      onClose={onClose}
      scrollable={false}
      contentStyle={styles.body}
      testID="code-locations-sheet"
    >
      <View style={styles.content}>
        {request ? (
          <CodeLocationsView request={request} onOpenLocation={openLocation} showTitle={false} />
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0, gap: 0 },
  content: { flex: 1, minHeight: 0 },
});
