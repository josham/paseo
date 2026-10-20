import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import type { SymbolActions, SymbolPosition } from "./symbol-actions";
import { SymbolActionsMenu, type SymbolMenuItem, type SymbolMenuRequest } from "./symbol-menu";
import type { CodeNavigation, SymbolRequestOptions } from "./use-code-navigation";

export interface SymbolActionsHandle {
  /** Null when navigation is unavailable for this document; views then add no affordance. */
  symbolActions: SymbolActions | null;
  /** Render this once beside the view. */
  symbolMenu: ReactElement | null;
}

/**
 * Bind a source view's positions to one document. `getUnsavedContent` returns the editor's text
 * while it differs from the disk, so a dirty buffer is navigated as shown rather than as saved.
 */
export function useSymbolActions(input: {
  navigation: CodeNavigation | null;
  /** Workspace-relative path of the document on screen. */
  path: string | null;
  getUnsavedContent?: () => string | null;
  extraItems?: readonly SymbolMenuItem[];
  testID: string;
}): SymbolActionsHandle {
  const { navigation, path, extraItems, testID } = input;
  const [menuRequest, setMenuRequest] = useState<SymbolMenuRequest | null>(null);
  const getUnsavedContentRef = useRef(input.getUnsavedContent);
  getUnsavedContentRef.current = input.getUnsavedContent;

  const symbolActions = useMemo<SymbolActions | null>(() => {
    if (!navigation || !path) return null;
    const documentPath = path;
    function requestOptions(): SymbolRequestOptions | undefined {
      const content = getUnsavedContentRef.current?.() ?? null;
      return content === null ? undefined : { content };
    }
    function query(position: SymbolPosition) {
      return { path: documentPath, ...position };
    }
    return {
      goToDefinition: (position) => navigation.goToDefinition(query(position), requestOptions()),
      findUsages: (position) => navigation.findUsages(query(position), requestOptions()),
      openMenu: (position, point) =>
        setMenuRequest({ point, query: query(position), options: requestOptions() }),
    };
  }, [navigation, path]);

  const closeMenu = useCallback(() => setMenuRequest(null), []);
  const symbolMenu = navigation ? (
    <SymbolActionsMenu
      request={menuRequest}
      onClose={closeMenu}
      navigation={navigation}
      extraItems={extraItems}
      testID={testID}
    />
  ) : null;

  return { symbolActions, symbolMenu };
}
