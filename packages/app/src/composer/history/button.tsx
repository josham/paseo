import { type ReactElement } from "react";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { History } from "lucide-react-native";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedHistory = withUnistyles(History);
const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Opens prompt search by touch, for the surfaces that cannot reach Ctrl+R:
 * a soft keyboard has no Ctrl, and React Native's native key events carry no
 * modifier flags to read one from. Desktop keeps the shortcut and stays
 * uncluttered.
 */
export function PromptHistoryButton({
  onPress,
  disabled,
  iconSize = ICON_SIZE.lg,
}: {
  onPress: () => void;
  disabled: boolean;
  iconSize?: number;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <ToolbarButton
      label={t("composer.promptHistory.open")}
      tooltipSide="top"
      round
      onPress={onPress}
      disabled={disabled}
      testID="message-input-prompt-history-button"
    >
      <ThemedHistory size={iconSize} uniProps={iconForegroundMutedMapping} />
    </ToolbarButton>
  );
}
