import { useCallback, type ReactElement } from "react";
import { Pressable, Text, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { History } from "lucide-react-native";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  const label = t("composer.promptHistory.open");

  const style = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.button,
      hovered && styles.buttonHovered,
      disabled && styles.buttonDisabled,
    ],
    [disabled],
  );

  const handlePress = useCallback(() => {
    if (disabled) return;
    onPress();
  }, [disabled, onPress]);

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={handlePress}
          disabled={disabled}
          accessibilityLabel={label}
          accessibilityRole="button"
          testID="message-input-prompt-history-button"
          style={style}
        >
          <ThemedHistory size={iconSize} uniProps={iconForegroundMutedMapping} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
