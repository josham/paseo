import { memo, useCallback, useMemo } from "react";
import {
  Pressable,
  Text,
  View,
  type ListRenderItem,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { CodeLocation } from "@getpaseo/protocol/messages";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { FlatList } from "@/components/ui/scroll-view";
import { groupLocationsByFile } from "./results";

type ListRow =
  | { kind: "file"; key: string; path: string; fileName: string; directory: string }
  | { kind: "location"; key: string; location: CodeLocation };

export interface CodeLocationsListProps {
  locations: readonly CodeLocation[];
  onOpenLocation: (location: CodeLocation) => void;
}

/** Locations grouped under their file, each row showing its line number and source line. */
export function CodeLocationsList({ locations, onOpenLocation }: CodeLocationsListProps) {
  const rows = useMemo(() => buildRows(locations), [locations]);
  const renderItem = useCallback<ListRenderItem<ListRow>>(
    ({ item }) =>
      item.kind === "file" ? (
        <FileRow row={item} />
      ) : (
        <LocationRow location={item.location} onOpen={onOpenLocation} />
      ),
    [onOpenLocation],
  );

  return (
    <FlatList
      data={rows}
      keyExtractor={rowKey}
      renderItem={renderItem}
      style={styles.list}
      testID="code-locations-list"
    />
  );
}

function buildRows(locations: readonly CodeLocation[]): ListRow[] {
  const rows: ListRow[] = [];
  for (const group of groupLocationsByFile(locations)) {
    const separator = group.path.lastIndexOf("/");
    rows.push({
      kind: "file",
      key: `file:${group.path}`,
      path: group.path,
      fileName: separator === -1 ? group.path : group.path.slice(separator + 1),
      directory: separator === -1 ? "" : group.path.slice(0, separator),
    });
    for (const location of group.locations) {
      const { start } = location.range;
      rows.push({
        kind: "location",
        key: `${location.path}:${start.line}:${start.character}`,
        location,
      });
    }
  }
  return rows;
}

function rowKey(row: ListRow): string {
  return row.key;
}

function FileRow({ row }: { row: Extract<ListRow, { kind: "file" }> }) {
  return (
    <View style={styles.fileRow} testID={`code-locations-file-${row.path}`}>
      <View style={styles.iconSlot}>
        <MaterialFileIcon fileName={row.fileName} size={16} />
      </View>
      <Text style={styles.fileLine} numberOfLines={1}>
        <Text style={styles.fileName}>{row.fileName}</Text>
        {row.directory ? <Text style={styles.directory}> {row.directory}</Text> : null}
      </Text>
    </View>
  );
}

const LocationRow = memo(function LocationRow({
  location,
  onOpen,
}: {
  location: CodeLocation;
  onOpen: (location: CodeLocation) => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => onOpen(location), [location, onOpen]);
  const style = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.locationRow,
      location.openable && (Boolean(hovered) || pressed) && styles.activeRow,
    ],
    [location.openable],
  );
  const line = location.range.start.line + 1;
  return (
    <Pressable
      style={style}
      onPress={press}
      disabled={!location.openable}
      accessibilityRole="button"
      testID={`code-locations-row-${location.path}:${line}`}
    >
      <Text style={styles.lineNumber}>{line}</Text>
      <View style={styles.previewColumn}>
        <Text style={styles.preview} numberOfLines={1}>
          {location.preview ?? ""}
        </Text>
        {location.openable ? null : (
          <Text style={styles.unavailable}>{t("panels.codeNavigation.containerOnly")}</Text>
        )}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  list: { flex: 1, minHeight: 0 },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  iconSlot: { width: 16, height: 20, alignItems: "center", justifyContent: "center" },
  fileLine: { flex: 1, minWidth: 0, fontSize: theme.fontSize.sm, lineHeight: 20 },
  fileName: { color: theme.colors.foreground },
  directory: { color: theme.colors.foregroundMuted },
  locationRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[3],
  },
  activeRow: { backgroundColor: theme.colors.surface1 },
  lineNumber: {
    minWidth: 32,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 20,
  },
  previewColumn: { flex: 1, minWidth: 0 },
  preview: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 20,
  },
  unavailable: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
