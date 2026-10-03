import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { SshTransportTarget } from "@getpaseo/protocol/ssh-transport";
import { ensureRemoteDaemon, SshCancelledError, type SshSpawn } from "./ensure-remote-daemon.js";

/**
 * Stand in for `ssh` by running the ensure script through a local `/bin/sh`,
 * exactly as the remote host's shell would. Nothing about the script is
 * simulated — only the hop between machines is missing.
 */
function spawnLocalShell(env: Record<string, string | undefined>): SshSpawn {
  return () => spawn("/bin/sh", [], { stdio: ["pipe", "ignore", "pipe"], env });
}

let listener: Server | null = null;

afterEach(async () => {
  const open = listener;
  listener = null;
  if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
});

/** Occupy a port so the script's "is it already listening?" check succeeds. */
async function listenOnFreePort(): Promise<number> {
  const server = createServer((socket) => socket.end());
  listener = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

function targetFor(daemonPort: number): SshTransportTarget {
  return { host: "build-box", daemonPort, remoteDaemon: {} };
}

describe("ensureRemoteDaemon", () => {
  it("leaves a daemon that is already listening alone", async () => {
    const port = await listenOnFreePort();
    const progress: string[] = [];

    const outcome = await ensureRemoteDaemon({
      target: targetFor(port),
      spawnSsh: spawnLocalShell(process.env),
      onProgress: (message) => progress.push(message),
    });

    expect(outcome).toBe("running");
    expect(progress).toEqual(["Remote daemon is already running."]);
  });

  it("reports what to install when the host has no Node.js", async () => {
    await expect(
      ensureRemoteDaemon({
        target: targetFor(6767),
        spawnSsh: spawnLocalShell({ PATH: "" }),
      }),
    ).rejects.toThrow(
      "Node.js is required on build-box to run the Paseo daemon. " +
        "Install Node.js (https://nodejs.org) on the remote host and retry.",
    );
  });

  it("stops immediately when the user declines the password prompt", async () => {
    await expect(
      ensureRemoteDaemon({
        target: targetFor(6767),
        spawnSsh: spawnLocalShell(process.env),
        cancelSignal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(SshCancelledError);
  });

  it("gives up on a host that never answers", async () => {
    await expect(
      ensureRemoteDaemon({
        target: targetFor(6767),
        spawnSsh: () =>
          spawn("/bin/sh", ["-c", "exec sleep 30"], { stdio: ["pipe", "ignore", "pipe"] }),
        timeoutMs: 50,
      }),
    ).rejects.toThrow("Timed out setting up the Paseo daemon on build-box.");
  });
});
