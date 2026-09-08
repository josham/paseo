import { spawn, type ChildProcess } from "node:child_process";
import {
  buildEnsureScript,
  describeEnsureFailure,
  PROGRESS_MARKER,
  READY_MARKER,
  REMOTE_SHELL_COMMAND,
  resolveRemoteDaemonSpec,
  type SshRemoteDaemonSpec,
} from "@getpaseo/protocol/ssh-lifecycle";
import {
  buildSshSessionArgs,
  type SshProcessEnv,
  type SshTransportTarget,
} from "@getpaseo/protocol/ssh-transport";

/** Cap retained stderr so a chatty `npm install` cannot grow without bound. */
const MAX_STDERR_BYTES = 16_384;

/**
 * Long enough to cover an `npm install` on a slow host. The script has its own
 * 30s budget for the daemon to start listening once it is installed, so this
 * only bounds the install itself.
 */
const DEFAULT_ENSURE_TIMEOUT_MS = 300_000;

/** How the remote daemon came to be listening. */
export type RemoteDaemonOutcome = "running" | "launched";

/**
 * Spawn `ssh`. Injectable so tests can drive the real ensure script through a
 * local `/bin/sh` instead of a remote host.
 */
export type SshSpawn = (args: string[], env: SshProcessEnv) => ChildProcess;

export interface EnsureRemoteDaemonOptions {
  target: SshTransportTarget;
  /** `@getpaseo/cli` version to install when the target does not pin one. */
  version?: string;
  /** SSH_ASKPASS program, for hosts that authenticate with a password. */
  askpassPath?: string;
  /** Base environment for the `ssh` child. Defaults to this process's. */
  env?: SshProcessEnv;
  /**
   * Aborts when the user declines a password prompt. SSH ignores the askpass
   * program's exit status and simply retries, so without this a dismissed
   * prompt would reappear until the attempts run out.
   */
  cancelSignal?: AbortSignal;
  onProgress?: (message: string) => void;
  timeoutMs?: number;
  spawnSsh?: SshSpawn;
}

/**
 * The user dismissed the password prompt. Distinct from an authentication
 * failure: nothing was wrong, they declined, so callers can say so plainly
 * instead of reporting a permission error.
 */
export class SshCancelledError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(`Connection to ${host} was cancelled.`);
    this.name = "SshCancelledError";
    this.host = host;
  }
}

interface SshStderrReader {
  /** Everything SSH and the ensure script wrote, capped at a sane size. */
  text(): string;
}

/**
 * Watch the SSH process's stderr for the ensure script's structured markers
 * while also retaining the raw text.
 *
 * Retaining matters: attaching a `data` listener puts the stream in flowing
 * mode, so a later `stream.read()` returns nothing. Without buffering here,
 * every failure — bad password, missing Node, failed install — would surface
 * with an empty reason.
 */
function readSshStderr(
  child: ChildProcess,
  handlers: {
    onProgress?: (message: string) => void;
    onReady: (outcome: RemoteDaemonOutcome) => void;
  },
): SshStderrReader {
  let retained = "";
  let pending = "";
  if (!child.stderr) {
    return { text: () => retained };
  }
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    retained = (retained + text).slice(-MAX_STDERR_BYTES);
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      // A PTY turns "\n" into "\r\n"; strip the remnant before matching.
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (clean.startsWith(READY_MARKER)) {
        handlers.onReady(clean.slice(READY_MARKER.length) === "running" ? "running" : "launched");
      } else if (clean.startsWith(PROGRESS_MARKER)) {
        handlers.onProgress?.(clean.slice(PROGRESS_MARKER.length));
      }
    }
  });
  return { text: () => retained };
}

function defaultSpawnSsh(args: string[], env: SshProcessEnv): ChildProcess {
  return spawn("ssh", args, {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
    env,
  });
}

function specFor(target: SshTransportTarget, version: string | undefined): SshRemoteDaemonSpec {
  return resolveRemoteDaemonSpec({
    host: target.host,
    daemonPort: target.daemonPort,
    ...target.remoteDaemon,
    ...(target.remoteDaemon?.version ? {} : { version }),
  });
}

/**
 * Install and launch a Paseo daemon on a remote SSH host, and resolve once it
 * is listening.
 *
 * This is the explicit setup step, run only for a host the user opted in for
 * (`target.remoteDaemon`). It is a separate SSH connection from the tunnel
 * that carries daemon traffic: the tunnel binds stdio with `ssh -W`, and the
 * script needs stdin. Nothing has to stay connected afterwards — the remote
 * daemon is detached, so this process exits as soon as the port answers.
 */
export async function ensureRemoteDaemon(
  options: EnsureRemoteDaemonOptions,
): Promise<RemoteDaemonOutcome> {
  const spec = specFor(options.target, options.version);
  const args = buildSshSessionArgs(
    options.target,
    REMOTE_SHELL_COMMAND,
    options.askpassPath ? { askpassPath: options.askpassPath } : undefined,
  );
  const child = (options.spawnSsh ?? defaultSpawnSsh)(args, options.env ?? process.env);

  child.stdin?.on("error", () => {
    // A failed auth closes the pipe before the script lands; the exit code and
    // stderr are the real diagnostics, so this is not worth surfacing.
  });
  child.stdin?.end(`${buildEnsureScript(spec)}\n`);

  let signalReady: (outcome: RemoteDaemonOutcome) => void = () => {};
  const ready = new Promise<RemoteDaemonOutcome>((resolve) => {
    signalReady = resolve;
  });

  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    // Don't wait for ssh to burn the remaining password attempts.
    child.kill("SIGTERM");
  };
  if (options.cancelSignal) {
    if (options.cancelSignal.aborted) cancel();
    else options.cancelSignal.addEventListener("abort", cancel, { once: true });
  }

  const stderr = readSshStderr(child, {
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    onReady: signalReady,
  });

  const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once("close", (code) => resolve({ code }));
    child.once("error", (error) => resolve({ code: null, error }));
  });
  const timedOut = new Promise<"timeout">((resolve) => {
    const timer = setTimeout(
      () => resolve("timeout"),
      options.timeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS,
    );
    timer.unref();
  });

  const outcome = await Promise.race([ready.then((value) => ({ ready: value })), exited, timedOut]);

  if (typeof outcome === "object" && "ready" in outcome) {
    child.kill();
    return outcome.ready;
  }

  child.kill("SIGKILL");
  if (cancelled) {
    throw new SshCancelledError(spec.host);
  }
  if (outcome === "timeout") {
    const detail = stderr.text().trim();
    throw new Error(
      `Timed out setting up the Paseo daemon on ${spec.host}.${detail ? `\n${detail}` : ""}`,
    );
  }
  if (outcome.error) {
    throw new Error(`Failed to run ssh: ${outcome.error.message}`, { cause: outcome.error });
  }
  throw new Error(describeEnsureFailure({ spec, exitCode: outcome.code, stderr: stderr.text() }));
}
