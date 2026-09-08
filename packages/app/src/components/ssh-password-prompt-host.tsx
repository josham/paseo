import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Text, View, type ViewStyle } from "react-native";
import { createPortal } from "react-dom";
import { StyleSheet } from "react-native-unistyles";
import { KeyRound } from "lucide-react-native";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { Button } from "@/components/ui/button";
import { getDesktopHost } from "@/desktop/host";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";

/**
 * Full-viewport layer for the dialog, above React Native's own modal layer.
 *
 * `position: fixed` and this z-index are web-only values that React Native's
 * style types do not model, hence the assertion. 10000 clears the 9999 that
 * react-native-web's `Modal` uses, which is what the host chooser renders in.
 */
const OVERLAY_LAYER = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 10_000,
} as unknown as ViewStyle;

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  panel: {
    width: "100%",
    maxWidth: 460,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[2],
  },
  prompt: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[3],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    marginBottom: 4,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  buttonRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
}));

/** What SSH is asking for, as classified by the askpass channel. */
export type SshPromptKind = "passphrase" | "password" | "confirm";

export interface SshPasswordRequestEvent {
  requestId: string;
  /** The host being connected to, so the dialog can name it. */
  host: string;
  /** SSH's own prompt — carries the key path or `user@host`. */
  prompt: string;
  kind: SshPromptKind;
}

/**
 * Append unless already queued. The main process sends one event per prompt,
 * but a duplicate delivery must not make the user answer the same one twice.
 */
function enqueueRequest(
  pending: SshPasswordRequestEvent[],
  incoming: SshPasswordRequestEvent,
): SshPasswordRequestEvent[] {
  const alreadyQueued = pending.some((entry) => entry.requestId === incoming.requestId);
  return alreadyQueued ? pending : [...pending, incoming];
}

function isPasswordRequest(payload: unknown): payload is SshPasswordRequestEvent {
  if (!payload || typeof payload !== "object") return false;
  const event = payload as Partial<SshPasswordRequestEvent>;
  return typeof event.requestId === "string" && typeof event.prompt === "string";
}

/** Remove one request from the queue, whoever settled it. */
function dropRequest(requestId: string) {
  return (pending: SshPasswordRequestEvent[]): SshPasswordRequestEvent[] =>
    pending.filter((entry) => entry.requestId !== requestId);
}

function readRequestId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const { requestId } = payload as { requestId?: unknown };
  return typeof requestId === "string" ? requestId : null;
}

/**
 * Renders SSH's password and key-passphrase prompts in Paseo's own UI.
 *
 * SSH will only take a secret from a program's stdout, so the desktop main
 * process runs a relay askpass that forwards the prompt here and waits for the
 * answer. That replaces shelling out to `zenity`/`kdialog`/`osascript`, which
 * meant an unstyled, unlocalized dialog we could not control — and on a
 * packaged app usually meant no dialog at all, so password-protected hosts
 * simply could not be reached.
 *
 * Mounted globally rather than inside the Add SSH Host modal: SSH can ask for
 * a secret on any later reconnect too, when no modal is open.
 */
export function SshPasswordPromptHost() {
  const { t } = useTranslation();
  // A queue, not a single slot: several hosts can reconnect at once (startup
  // fans out over every host), and each waiting ssh process is blocked until
  // its own prompt is answered. Dropping one would strand it until the
  // channel's timeout.
  const [queue, setQueue] = useState<SshPasswordRequestEvent[]>([]);
  // Uncontrolled, like every other text field here: the secret lives in a ref
  // so typing does not re-render a dialog that is showing a password.
  const secretRef = useRef("");
  const inputRef = useRef<EditingTextInputHandle>(null);
  const request = queue[0] ?? null;

  useEffect(() => {
    const events = getDesktopHost()?.events;
    if (!events?.on) return;
    const listen = events.on;
    const unsubscribers: Array<() => void> = [];
    let disposed = false;

    const subscribe = (event: string, handler: (payload: unknown) => void): void => {
      void Promise.resolve(listen(event, handler)).then((off) => {
        if (disposed) off();
        else unsubscribers.push(off);
        return undefined;
      });
    };

    subscribe("ssh-password-request", (payload) => {
      if (!isPasswordRequest(payload)) return;
      setQueue((pending) => enqueueRequest(pending, payload));
    });
    // The main process gave up on this prompt — it timed out, or the
    // connection failed for an unrelated reason. Take the dialog down instead
    // of asking for a secret nothing is waiting for.
    subscribe("ssh-password-resolved", (payload) => {
      const requestId = readRequestId(payload);
      if (requestId) setQueue(dropRequest(requestId));
    });

    return () => {
      disposed = true;
      for (const off of unsubscribers) off();
    };
  }, []);

  const answer = useCallback(
    (value: string | null) => {
      if (!request) return;
      setQueue(dropRequest(request.requestId));
      secretRef.current = "";
      inputRef.current?.replaceText("");
      // Answering is what unblocks ssh; declining aborts that attempt in the
      // main process, so there is nothing further to clean up here.
      void invokeDesktopCommand("submit_ssh_password", {
        requestId: request.requestId,
        secret: value,
      }).catch(() => undefined);
    },
    [request],
  );

  const handleSecretChange = useCallback((value: string) => {
    secretRef.current = value;
  }, []);
  // A host-key question wants OpenSSH's literal "yes", not something typed.
  const isConfirmation = request?.kind === "confirm";
  const handleSubmit = useCallback(() => {
    if (isConfirmation) {
      answer("yes");
      return;
    }
    // Read the field itself rather than trusting the change events: a password
    // manager filling the input sets its value without firing one, and
    // submitting an empty secret would look like a rejected password.
    answer(inputRef.current?.getText() ?? secretRef.current);
  }, [answer, isConfirmation]);
  const handleCancel = useCallback(() => answer(null), [answer]);

  const kind = request?.kind ?? "password";
  const icon = useMemo(() => <KeyRound size={16} />, []);

  if (!request || Platform.OS !== "web") return null;

  return (
    // Neither shared primitive works for this dialog, which is raised by a
    // background reconnect and so can land on top of anything.
    //
    // `AdaptiveModalSheet` portals into an overlay root pinned at z-index 1,
    // below the 9999 that react-native-web's `Modal` uses — a prompt raised
    // while the host chooser is open renders underneath it, visible but
    // unanswerable.
    //
    // A second `Modal` fixes the stacking but wedges the renderer: its
    // `ModalFocusTrap` and the chooser's each refocus themselves whenever focus
    // lands outside, and the guard against that only covers re-entering the
    // same trap, so two of them ping-pong forever on the main thread.
    //
    // So: our own portal, above both, with no focus trap of its own.
    createPortal(
      <View style={[styles.overlay, OVERLAY_LAYER]}>
        {/* Deliberately inert: dismissing a credential prompt with a stray
            click would abort the connection waiting behind it. */}
        <View style={styles.backdrop} />
        <View style={styles.panel} testID="ssh-password-prompt">
          <Text style={styles.title} testID="ssh-password-title">
            {t(`pairing.ssh.prompt.${kind}`)}
          </Text>

          {/* SSH's own prompt: it carries the key path or user@host, and the
              user may have several of either in play. */}
          <Text style={styles.prompt}>{request.prompt}</Text>

          {isConfirmation ? null : (
            <>
              <Text style={styles.label}>{t("pairing.ssh.prompt.secret")}</Text>
              <AdaptiveTextInput
                ref={inputRef}
                testID="ssh-password-input"
                accessibilityLabel={t("pairing.ssh.prompt.secret")}
                initialValue=""
                resetKey={request.requestId}
                onChangeText={handleSecretChange}
                style={styles.input}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                onSubmitEditing={handleSubmit}
                returnKeyType="go"
              />
            </>
          )}

          <View style={styles.buttonRow}>
            <Button variant="ghost" onPress={handleCancel} testID="ssh-password-cancel">
              {t("pairing.ssh.prompt.cancel")}
            </Button>
            <Button
              variant="default"
              onPress={handleSubmit}
              leftIcon={icon}
              testID="ssh-password-submit"
            >
              {t("pairing.ssh.prompt.submit")}
            </Button>
          </View>
        </View>
      </View>,
      document.body,
    )
  );
}
