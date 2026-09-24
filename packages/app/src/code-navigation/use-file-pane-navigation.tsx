import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isNative } from "@/constants/platform";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { SymbolActions } from "./symbol-actions";
import { useSymbolActions } from "./use-symbol-actions";
import { useCodeNavigation } from "./use-code-navigation";

export interface FilePaneNavigation {
  /** Workspace-relative path the language server can answer for, or null. */
  navigationPath: string | null;
  navigation: ReturnType<typeof useCodeNavigation>["navigation"];
  symbolActions: SymbolActions | null;
  symbolMenu: ReactNode;
  resultsSheet: ReactNode;
  selectingText: boolean;
  stopSelectingText: () => void;
}

/**
 * Everything the file pane needs to answer a symbol: where the language server is asked
 * from, the menu that asks it, and the sheet its results land in.
 *
 * It lives here rather than in the pane because the pane is upstream's, and its own
 * branching already spends the complexity budget that lints it.
 */
export function useFilePaneNavigation(input: {
  serverId: string;
  workspaceId: string | null;
  workspaceRoot: string;
  readTarget: { cwd: string; path: string } | null;
  openLocation: (location: WorkspaceFileLocation) => void;
}): FilePaneNavigation {
  const { t } = useTranslation();
  const { serverId, workspaceId, workspaceRoot, readTarget, openLocation } = input;

  // Navigation needs a workspace-relative path; a file opened from outside the workspace has none.
  const navigationPath = readTarget && readTarget.cwd === workspaceRoot ? readTarget.path : null;
  const { navigation, resultsSheet } = useCodeNavigation({
    serverId,
    workspaceId,
    cwd: navigationPath ? workspaceRoot : null,
    openLocation,
  });

  const [selectingText, setSelectingText] = useState(false);
  const stopSelectingText = useCallback(() => setSelectingText(false), []);
  const targetKey = readTarget ? `${readTarget.cwd}:${readTarget.path}` : null;
  useEffect(() => setSelectingText(false), [targetKey]);

  const selectTextItems = useMemo(
    () =>
      isNative
        ? [
            {
              key: "select-text",
              label: t("panels.codeNavigation.selectText"),
              onSelect: () => setSelectingText(true),
            },
          ]
        : [],
    [t],
  );
  const { symbolActions, symbolMenu } = useSymbolActions({
    navigation,
    path: navigationPath,
    extraItems: selectTextItems,
    testID: "file-symbol-menu",
  });

  return {
    navigationPath,
    navigation,
    symbolActions,
    symbolMenu,
    resultsSheet,
    selectingText,
    stopSelectingText,
  };
}
