import { confirm, isCancel, log, password as passwordPrompt } from "@clack/prompts";
import type { SshTransportTarget } from "@getpaseo/protocol/ssh-transport";
import {
  createAskpassChannel,
  ensureRemoteDaemon,
  type AskpassChannel,
  type AskpassRequest,
} from "@getpaseo/server/ssh";
import { resolveCliVersion } from "../version.js";
import { createSshTunnel, type SshTunnel } from "./ssh-tunnel.js";

/**
 * Whether we can put a password prompt in front of a human.
 *
 * Without a terminal there is nobody to answer, and SSH should fail fast under
 * `BatchMode` instead of blocking a script forever. The askpass program itself
 * is a `/bin/sh` wrapper, which Windows OpenSSH will not run.
 */
function canPromptOnTerminal(): boolean {
  return (
    process.platform !== "win32" && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)
  );
}

async function promptForSecret(request: AskpassRequest): Promise<string | null> {
  // A host-key question is not a secret. It has to be shown in full — the
  // fingerprint is the whole point — and answered with the literal "yes"
  // OpenSSH expects.
  if (request.kind === "confirm") {
    log.warn(request.prompt.trim());
    const accepted = await confirm({ message: "Continue connecting to this host?" });
    return isCancel(accepted) || accepted !== true ? null : "yes";
  }
  const answer = await passwordPrompt({
    message:
      request.prompt.trim() ||
      (request.kind === "passphrase" ? "SSH key passphrase" : "SSH password"),
  });
  return isCancel(answer) || typeof answer !== "string" ? null : answer;
}

function reportProgress(message: string): void {
  process.stderr.write(`${message}\n`);
}

export interface OpenSshTunnelOptions {
  onProgress?: (message: string) => void;
}

/**
 * Open the SSH tunnel a daemon connection runs over.
 *
 * Two things happen here that `createSshTunnel` alone does not do. A host the
 * user opted in for is set up first — Paseo installed and the daemon launched
 * — over its own SSH connection. And on a terminal, both that connection and
 * the tunnel get an askpass program, so a host that authenticates with a
 * password or an encrypted key is usable at all; without one SSH runs under
 * `BatchMode` and can only use an agent or an unencrypted key.
 *
 * The askpass channel outlives this call: `ssh` is not spawned until something
 * connects to the tunnel's local port, so it is still needed then. Closing the
 * tunnel closes it.
 */
export async function openSshTunnel(
  target: SshTransportTarget,
  options?: OpenSshTunnelOptions,
): Promise<SshTunnel> {
  const askpass: AskpassChannel | null = canPromptOnTerminal()
    ? await createAskpassChannel({ onPrompt: promptForSecret })
    : null;

  try {
    if (target.remoteDaemon) {
      await ensureRemoteDaemon({
        target,
        version: resolveCliVersion(),
        onProgress: options?.onProgress ?? reportProgress,
        ...(askpass
          ? {
              askpassPath: askpass.askpassPath,
              env: askpass.askpassEnv(process.env),
              cancelSignal: askpass.signal,
            }
          : {}),
      });
    }

    const tunnel = await createSshTunnel(
      target,
      askpass
        ? { askpassPath: askpass.askpassPath, env: askpass.askpassEnv(process.env) }
        : undefined,
    );
    return {
      ...tunnel,
      close: () => {
        tunnel.close();
        askpass?.close();
      },
    };
  } catch (error) {
    askpass?.close();
    throw error;
  }
}
