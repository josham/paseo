import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, Eye, EyeOff, Terminal } from "lucide-react-native";
import { parseSshTransportUri } from "@getpaseo/protocol/ssh-transport";
import type { HostProfile } from "@/types/host-connection";
import { useHostMutations, useHosts } from "@/runtime/host-runtime";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  CONTROL_HEIGHTS,
  createControlGeometry,
  resolveControlInteractionStyles,
} from "@/components/ui/control-geometry";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import { DaemonConnectionTestError } from "@/utils/test-daemon-connection";
import { grantSshPrompt } from "@/desktop/daemon/ssh-prompt-grant";
import { AdaptiveModalSheet, type SheetHeader } from "./adaptive-modal-sheet";

const FLEX_ONE_STYLE = { flex: 1 } as const;
const ThemedTerminal = withUnistyles(Terminal);
const ThemedEye = withUnistyles(Eye, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedEyeOff = withUnistyles(EyeOff, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedCheck = withUnistyles(Check, (theme) => ({
  color: theme.colors.accentForeground,
}));

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);
  return {
    helper: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    passwordRow: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "stretch",
      width: "100%",
      gap: theme.spacing[2],
    },
    passwordInputWrap: {
      flex: 1,
      minWidth: 0,
    },
    // Boxed adornment next to the field: same height and radius as the field
    // chrome of the active form size, and the shared interaction phases.
    iconButtonSm: {
      minHeight: CONTROL_HEIGHTS.compact,
      width: CONTROL_HEIGHTS.compact,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.colors.surface2,
    },
    iconButtonMd: {
      minHeight: CONTROL_HEIGHTS.field,
      width: CONTROL_HEIGHTS.field,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.borderRadius.lg,
      backgroundColor: theme.colors.surface2,
    },
    controlRest: {
      ...geometry.controlRest,
    },
    controlHover: {
      ...geometry.controlHover,
    },
    controlActive: {
      ...geometry.controlActive,
    },
    controlDisabled: {
      ...geometry.controlDisabled,
    },
    actions: {
      flexDirection: "row",
      gap: theme.spacing[3],
      marginTop: theme.spacing[2],
    },
    installRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[3],
      marginTop: theme.spacing[2],
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: theme.borderRadius.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    checkboxChecked: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    installLabel: {
      flex: 1,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
    },
  };
});

export interface AddRemoteSshHostModalProps {
  visible: boolean;
  onClose: () => void;
  onCancel?: () => void;
  onSaved?: (result: {
    profile: HostProfile;
    serverId: string;
    hostname: string | null;
    isNewHost: boolean;
  }) => void;
}

export function AddRemoteSshHostModal({
  visible,
  onClose,
  onCancel,
  onSaved,
}: AddRemoteSshHostModalProps) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const isCompact = useIsCompactFormFactor();
  const { probeAndUpsertRemoteSshConnection } = useHostMutations();
  const targetRef = useRef("");
  const passwordRef = useRef("");
  const inputRef = useRef<EditingTextInputHandle>(null);
  const passwordInputRef = useRef<EditingTextInputHandle>(null);
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [installRemote, setInstallRemote] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const header = useMemo<SheetHeader>(() => ({ title: t("pairing.remoteSsh.title") }), [t]);

  const clear = useCallback(() => {
    targetRef.current = "";
    passwordRef.current = "";
    inputRef.current?.replaceText("");
    passwordInputRef.current?.replaceText("");
    setIsPasswordVisible(false);
    setInstallRemote(false);
    setErrorMessage("");
  }, []);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    clear();
    onClose();
  }, [clear, isSaving, onClose]);

  const handleCancel = useCallback(() => {
    if (isSaving) return;
    clear();
    (onCancel ?? onClose)();
  }, [clear, isSaving, onCancel, onClose]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    const rawTarget = targetRef.current.trim();
    if (!rawTarget) {
      setErrorMessage(t("pairing.remoteSsh.errors.targetRequired"));
      return;
    }

    let target: ReturnType<typeof parseSshTransportUri>;
    try {
      target = parseSshTransportUri(rawTarget);
    } catch {
      setErrorMessage(t("pairing.remoteSsh.errors.invalidTarget"));
      return;
    }
    // The checkbox is the same opt-in as `?install=1` in the URI; either one
    // is the explicit ask that lets Paseo touch the remote host.
    if (installRemote && !target.remoteDaemon) {
      target = { ...target, remoteDaemon: {} };
    }

    let result: Awaited<ReturnType<typeof probeAndUpsertRemoteSshConnection>>;
    try {
      setIsSaving(true);
      setErrorMessage("");
      // Pressing Connect is the ask that lets SSH raise a password or host-key
      // question; without this the probe below authenticates with keys or
      // fails.
      await grantSshPrompt({
        host: target.host,
        remoteSetup: target.remoteDaemon !== undefined,
      });
      result = await probeAndUpsertRemoteSshConnection({
        ...target,
        password: passwordRef.current === "" ? undefined : passwordRef.current,
      });
    } catch (error) {
      const message =
        error instanceof DaemonConnectionTestError
          ? t("pairing.remoteSsh.errors.failedToConnect", { detail: error.message })
          : t("common.errors.unableToSave");
      setErrorMessage(message);
      return;
    } finally {
      setIsSaving(false);
    }

    clear();
    onClose();
    onSaved?.({
      ...result,
      isNewHost: !hosts.some((profile) => profile.serverId === result.serverId),
    });
  }, [
    clear,
    hosts,
    installRemote,
    isSaving,
    onClose,
    onSaved,
    probeAndUpsertRemoteSshConnection,
    t,
  ]);
  const handleToggleInstall = useCallback(() => setInstallRemote((value) => !value), []);
  const checkboxStyle = useMemo(
    () => [styles.checkbox, installRemote ? styles.checkboxChecked : null],
    [installRemote],
  );
  const installAccessibilityState = useMemo(
    () => ({ checked: installRemote, disabled: isSaving }),
    [installRemote, isSaving],
  );
  const handleTargetChange = useCallback((value: string) => {
    targetRef.current = value;
  }, []);
  const handlePasswordChange = useCallback((value: string) => {
    passwordRef.current = value;
  }, []);
  const handleTogglePasswordVisibility = useCallback(() => {
    setIsPasswordVisible((currentlyVisible) => !currentlyVisible);
  }, []);
  const iconButtonStyle = useCallback(
    (
      state: PressableStateCallbackType & { hovered?: boolean; focused?: boolean },
    ): StyleProp<ViewStyle> => [
      isCompact ? styles.iconButtonMd : styles.iconButtonSm,
      resolveControlInteractionStyles(
        {
          controlRest: styles.controlRest,
          controlHover: styles.controlHover,
          controlActive: styles.controlActive,
          controlDisabled: styles.controlDisabled,
        },
        {
          hovered: state.hovered,
          pressed: state.pressed,
          focused: state.focused,
          disabled: isSaving,
        },
      ),
    ],
    [isCompact, isSaving],
  );
  const handleSubmit = useCallback(() => void handleSave(), [handleSave]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      testID="add-remote-ssh-host-modal"
    >
      <Text style={styles.helper}>{t("pairing.remoteSsh.helper")}</Text>
      <Field
        label={t("pairing.remoteSsh.fields.target")}
        error={errorMessage}
        testID="remote-ssh-target"
      >
        <FormTextInput
          ref={inputRef}
          size={isCompact ? "md" : "sm"}
          testID="remote-ssh-target-input"
          accessibilityLabel={t("pairing.remoteSsh.fields.target")}
          initialValue=""
          onChangeText={handleTargetChange}
          placeholder="ssh://user@host"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSaving}
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />
      </Field>
      <Field label={t("pairing.remoteSsh.fields.password")} testID="remote-ssh-password">
        <View style={styles.passwordRow}>
          <View style={styles.passwordInputWrap}>
            <FormTextInput
              ref={passwordInputRef}
              size={isCompact ? "md" : "sm"}
              testID="remote-ssh-password-input"
              accessibilityLabel={t("pairing.remoteSsh.fields.password")}
              initialValue=""
              onChangeText={handlePasswordChange}
              placeholder={t("pairing.remoteSsh.fields.optional")}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!isPasswordVisible}
              editable={!isSaving}
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
            />
          </View>
          <Pressable
            style={iconButtonStyle}
            onPress={handleTogglePasswordVisibility}
            disabled={isSaving}
            accessibilityRole="button"
            accessibilityLabel={
              isPasswordVisible
                ? t("pairing.remoteSsh.passwordVisibility.hide")
                : t("pairing.remoteSsh.passwordVisibility.show")
            }
            testID="remote-ssh-password-visibility-toggle"
          >
            {isPasswordVisible ? <ThemedEyeOff size={18} /> : <ThemedEye size={18} />}
          </Pressable>
        </View>
      </Field>
      <Pressable
        style={styles.installRow}
        onPress={handleToggleInstall}
        disabled={isSaving}
        accessibilityRole="checkbox"
        accessibilityLabel={t("pairing.remoteSsh.install.label")}
        accessibilityState={installAccessibilityState}
        testID="remote-ssh-install-toggle"
      >
        <View style={checkboxStyle}>
          {installRemote ? (
            <View testID="remote-ssh-install-toggle-checked">
              <ThemedCheck size={14} />
            </View>
          ) : null}
        </View>
        <Text style={styles.installLabel}>{t("pairing.remoteSsh.install.label")}</Text>
      </Pressable>
      <Text style={styles.helper}>{t("pairing.remoteSsh.install.helper")}</Text>
      <View style={styles.actions}>
        <Button
          style={FLEX_ONE_STYLE}
          variant="secondary"
          onPress={handleCancel}
          disabled={isSaving}
        >
          {t("pairing.remoteSsh.actions.cancel")}
        </Button>
        <Button
          style={FLEX_ONE_STYLE}
          onPress={handleSubmit}
          disabled={isSaving}
          leftIcon={ThemedTerminal}
          testID="remote-ssh-submit"
        >
          {isSaving
            ? t("pairing.remoteSsh.actions.connecting")
            : t("pairing.remoteSsh.actions.connect")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}
