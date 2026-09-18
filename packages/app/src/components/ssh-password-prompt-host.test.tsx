/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme, desktopState, inputState } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    fontSize: { sm: 13, base: 15 },
    fontWeight: { medium: "500" },
    borderRadius: { lg: 8 },
    colors: { surface2: "#222", foreground: "#fff", foregroundMuted: "#aaa" },
  },
  inputState: { onChangeText: null as ((value: string) => void) | null, text: "" },
  desktopState: {
    handlers: new Map<string, Array<(payload: unknown) => void>>(),
    submitted: [] as Array<{ command: string; args: unknown }>,
    unsubscribed: 0,
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/button", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({
      children,
      onPress,
      testID,
    }: {
      children: React.ReactNode;
      onPress?: () => void;
      testID?: string;
    }) =>
      ReactModule.createElement(
        "button",
        { type: "button", "data-testid": testID, onClick: onPress },
        children,
      ),
  };
});

vi.mock("@/components/adaptive-text-input", async () => {
  const ReactModule = await import("react");
  return {
    AdaptiveTextInput: (props: Record<string, unknown>) => {
      const input = props as {
        testID?: string;
        onChangeText?: (value: string) => void;
        ref?: React.Ref<{ getText: () => string; replaceText: (value: string) => void }>;
      };
      inputState.onChangeText = input.onChangeText ?? null;
      ReactModule.useImperativeHandle(input.ref, () => ({
        getText: () => inputState.text,
        replaceText: () => {
          inputState.text = "";
        },
      }));
      return ReactModule.createElement("input", { "data-testid": input.testID, readOnly: true });
    },
  };
});

vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({
    events: {
      on: (event: string, handler: (payload: unknown) => void) => {
        const handlers = desktopState.handlers.get(event) ?? [];
        handlers.push(handler);
        desktopState.handlers.set(event, handlers);
        return Promise.resolve(() => {
          desktopState.unsubscribed += 1;
        });
      },
    },
  }),
}));

vi.mock("@/desktop/electron/invoke", () => ({
  invokeDesktopCommand: (command: string, args: unknown) => {
    desktopState.submitted.push({ command, args });
    return Promise.resolve();
  },
}));

import { SshPasswordPromptHost } from "./ssh-password-prompt-host";

let container: HTMLElement;
let root: Root;

function emit(event: string, payload: unknown): void {
  act(() => {
    for (const handler of desktopState.handlers.get(event) ?? []) handler(payload);
  });
}

/** Search the whole document: the dialog renders through a body portal. */
function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function answers(): unknown[] {
  return desktopState.submitted
    .filter((entry) => entry.command === "submit_ssh_password")
    .map((entry) => entry.args);
}

beforeEach(async () => {
  // JSX compiles to React.createElement in this setup, so component modules
  // resolve React from the global — same as the other component tests here.
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = "<div id='root'></div>";
  desktopState.handlers.clear();
  desktopState.submitted.length = 0;
  desktopState.unsubscribed = 0;
  inputState.onChangeText = null;
  inputState.text = "";
  container = document.getElementById("root") as HTMLElement;
  root = createRoot(container);
  // Mount with no add-host flow in sight — this component lives at the app
  // root precisely so a prompt can arrive at any time.
  await act(async () => {
    root.render(React.createElement(SshPasswordPromptHost));
  });
});

afterEach(() => {
  act(() => root.unmount());
});

describe("SshPasswordPromptHost", () => {
  it("renders nothing until SSH actually asks for something", () => {
    expect(query("ssh-password-prompt")).toBeNull();
  });

  it("shows a prompt that arrives outside any add-host flow", () => {
    emit("ssh-password-request", {
      requestId: "r1",
      host: "server.example.com",
      prompt: "alice@server.example.com's password:",
      kind: "password",
    });

    const modal = query("ssh-password-prompt");
    expect(modal).not.toBeNull();
    // SSH's own prompt is shown verbatim: it names the host or the key file.
    expect(modal?.textContent).toContain("alice@server.example.com's password:");
    expect(query("ssh-password-title")?.textContent).toBe("pairing.ssh.prompt.password");
  });

  it("raises the prompt in the same top-level layer as other modals", () => {
    emit("ssh-password-request", { requestId: "r1", host: "h", prompt: "p", kind: "password" });

    // Two constraints meet here. The app's overlay root sits below React
    // Native's modal layer, so a prompt rendered inside the app tree paints
    // under the host chooser and cannot be answered. But rendering it as a
    // second RN Modal instead hangs the renderer outright, because the two
    // focus traps refocus each other forever. Hence a portal of our own.
    // JSDOM cannot exercise the focus half; this guards the placement.
    expect(container.querySelector('[data-testid="ssh-password-prompt"]')).toBeNull();
    expect(query("ssh-password-prompt")).not.toBeNull();
  });

  it("titles a key passphrase differently from an account password", () => {
    emit("ssh-password-request", {
      requestId: "r1",
      host: "h",
      prompt: "Enter passphrase for key '/home/a/.ssh/id_ed25519':",
      kind: "passphrase",
    });
    expect(query("ssh-password-title")?.textContent).toBe("pairing.ssh.prompt.passphrase");
  });

  it("returns the typed secret to the waiting ssh process", () => {
    emit("ssh-password-request", { requestId: "r1", host: "h", prompt: "p", kind: "password" });
    act(() => {
      inputState.text = "hunter2";
      inputState.onChangeText?.("hunter2");
    });
    act(() => {
      (query("ssh-password-submit") as HTMLElement).click();
    });

    expect(answers()).toEqual([{ requestId: "r1", secret: "hunter2" }]);
    expect(query("ssh-password-prompt")).toBeNull();
  });

  it("shows a host-key fingerprint to confirm instead of a field to type into", () => {
    const prompt =
      "The authenticity of host 'build-box (10.0.0.4)' can't be established. " +
      "ED25519 key fingerprint is SHA256:abc123. " +
      "Are you sure you want to continue connecting (yes/no/[fingerprint])?";
    emit("ssh-password-request", { requestId: "r1", host: "build-box", prompt, kind: "confirm" });

    const modal = query("ssh-password-prompt");
    expect(query("ssh-password-title")?.textContent).toBe("pairing.ssh.prompt.confirm");
    // The fingerprint is the thing being verified, so it has to be readable.
    expect(modal?.textContent).toContain("SHA256:abc123");
    expect(query("ssh-password-input")).toBeNull();

    act(() => {
      (query("ssh-password-submit") as HTMLElement).click();
    });
    // OpenSSH accepts the literal word, not an empty secret.
    expect(answers()).toEqual([{ requestId: "r1", secret: "yes" }]);
  });

  it("submits a password the field holds even if no change event announced it", () => {
    // A password manager fills the input directly; React never sees a change.
    emit("ssh-password-request", { requestId: "r1", host: "h", prompt: "p", kind: "password" });
    act(() => {
      inputState.text = "filled-by-manager";
    });
    act(() => {
      (query("ssh-password-submit") as HTMLElement).click();
    });

    expect(answers()).toEqual([{ requestId: "r1", secret: "filled-by-manager" }]);
  });

  it("reports a declined prompt as a null secret", () => {
    emit("ssh-password-request", { requestId: "r1", host: "h", prompt: "p", kind: "password" });
    act(() => {
      (query("ssh-password-cancel") as HTMLElement).click();
    });

    // Null is what aborts the attempt; an empty string would be tried as a
    // password and SSH would simply ask again.
    expect(answers()).toEqual([{ requestId: "r1", secret: null }]);
    expect(query("ssh-password-prompt")).toBeNull();
  });

  it("takes the dialog down when the connection gave up on its own", () => {
    emit("ssh-password-request", { requestId: "r1", host: "h", prompt: "p", kind: "password" });
    emit("ssh-password-resolved", { requestId: "r1" });

    expect(query("ssh-password-prompt")).toBeNull();
    // Nothing is waiting for an answer any more, so none is sent.
    expect(answers()).toEqual([]);
  });

  it("ignores malformed events instead of opening an empty prompt", () => {
    emit("ssh-password-request", { nope: true });
    emit("ssh-password-request", null);
    expect(query("ssh-password-prompt")).toBeNull();
  });

  it("does not drop a second prompt that arrives while the first is open", () => {
    // Two hosts reconnecting at once is normal at startup: the runtime fans
    // out over every host it knows.
    emit("ssh-password-request", {
      requestId: "r1",
      host: "one",
      prompt: "one's password:",
      kind: "password",
    });
    emit("ssh-password-request", {
      requestId: "r2",
      host: "two",
      prompt: "two's password:",
      kind: "password",
    });

    act(() => {
      (query("ssh-password-cancel") as HTMLElement).click();
    });
    // Answering the first must not strand the second: ssh is blocked on it and
    // would sit there until the channel's timeout.
    expect(query("ssh-password-prompt")).not.toBeNull();
    expect(query("ssh-password-prompt")?.textContent).toContain("two's password:");

    act(() => {
      (query("ssh-password-cancel") as HTMLElement).click();
    });
    expect(answers()).toEqual([
      { requestId: "r1", secret: null },
      { requestId: "r2", secret: null },
    ]);
  });
});
