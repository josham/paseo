import { useCallback, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  useContextMenu,
} from "@/components/ui/context-menu";
import { useToast } from "@/contexts/toast-context";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import type { SymbolQuery } from "./results";
import type { CodeNavigation, SymbolRequestOptions } from "./use-code-navigation";

export interface SymbolMenuRequest {
  /** Where the gesture happened, in page coordinates; the popover anchors there. */
  point: { x: number; y: number };
  query: SymbolQuery;
  options?: SymbolRequestOptions;
  /** Why navigation cannot run here; the items stay visible and say so. */
  disabledReason?: string;
}

export interface SymbolMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
}

/**
 * The actions for a symbol someone pointed at: a popover at the pointer on a wide layout, a bottom
 * sheet on a compact one. Opened by a right click, or by a long press where there is no pointer.
 */
export function SymbolActionsMenu({
  request,
  onClose,
  navigation,
  extraItems = [],
  testID,
}: {
  request: SymbolMenuRequest | null;
  onClose: () => void;
  navigation: CodeNavigation;
  extraItems?: readonly SymbolMenuItem[];
  testID: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );
  const symbol = request?.query.symbol ?? "";
  const disabled = Boolean(request?.disabledReason);
  const goToDefinition = useCallback(() => {
    if (request) navigation.goToDefinition(request.query, request.options);
  }, [navigation, request]);
  const findUsages = useCallback(() => {
    if (request) navigation.findUsages(request.query, request.options);
  }, [navigation, request]);
  const copySymbol = useCallback(() => {
    void copyToClipboard(symbol)
      .then(() => toast.copied(symbol))
      .catch(() => toast.error(t("common.errors.unableToCopy")));
  }, [symbol, t, toast]);

  return (
    <ContextMenu open={request !== null} onOpenChange={handleOpenChange}>
      <AnchorAt point={request?.point ?? null} />
      <ContextMenuContent align="start" minWidth={200} sheetTitle={symbol} testID={testID}>
        <ContextMenuItem
          onSelect={goToDefinition}
          disabled={disabled}
          description={request?.disabledReason}
          testID={`${testID}-definition`}
        >
          {t("panels.codeNavigation.goToDefinition")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={findUsages} disabled={disabled} testID={`${testID}-usages`}>
          {t("panels.codeNavigation.findUsages")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={copySymbol} testID={`${testID}-copy-symbol`}>
          {t("panels.codeNavigation.copySymbol", { symbol })}
        </ContextMenuItem>
        {extraItems.map((item) => (
          <ContextMenuItem key={item.key} onSelect={item.onSelect} testID={`${testID}-${item.key}`}>
            {item.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A menu opened programmatically has no trigger to anchor to, so anchor it to the gesture. */
function AnchorAt({ point }: { point: { x: number; y: number } | null }) {
  const { setAnchorRect } = useContextMenu();
  useLayoutEffect(() => {
    if (point) setAnchorRect({ x: point.x, y: point.y, width: 0, height: 0 });
  }, [point, setAnchorRect]);
  return null;
}
