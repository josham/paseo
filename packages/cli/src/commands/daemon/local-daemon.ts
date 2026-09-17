import { Command, Option } from "commander";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { startDaemonInstance, resolvePaseoHome } from "@getpaseo/server/daemon-control";
const require = createRequire(import.meta.url);
function resolveServerRunnerFromDir(currentDir: string): string | null {
  const packageJsonPath = path.join(currentDir, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: string };
    if (packageJson.name !== "@getpaseo/server") return null;
    const distRunner = path.join(currentDir, "dist", "scripts", "supervisor-entrypoint.js");
    if (existsSync(distRunner)) {
      return distRunner;
    }
    return path.join(currentDir, "scripts", "supervisor-entrypoint.ts");
  } catch {
    return null;
  }
}

function resolveDaemonRunnerEntry(): string {
  const serverExportPath = require.resolve("@getpaseo/server");
  let currentDir = path.dirname(serverExportPath);

  while (true) {
    const entry = resolveServerRunnerFromDir(currentDir);
    if (entry) {
      return entry;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  throw new Error("Unable to resolve @getpaseo/server package root for daemon runner");
}

/**
 * Whether `systemd-run --user --scope` is available to wrap the launch.
 *
 * A detached daemon has to outlive the session that started it. Under
 * systemd-logind with `KillUserProcesses=yes` it does not: the daemon inherits
 * the launching session's cgroup and dies with that session -- an SSH
 * connection closing, a desktop logout, or just the terminal that ran
 * `paseo daemon start`. A transient scope of its own survives all three, which
 * is what lets a daemon installed over SSH stay up after the setup connection
 * goes; see `@getpaseo/protocol/ssh-lifecycle`.
 *
 * Pairs with `loginctl enable-linger`: without linger the user's systemd
 * instance stops at last logout and takes the scope with it.
 */
export function detectSystemdScopeSupport(): boolean {
  if (process.platform !== "linux") return false;
  if (!process.env.XDG_RUNTIME_DIR) return false;
  try {
    return spawnSync("systemd-run", ["--version"], { timeout: 2000, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Best-effort `loginctl enable-linger`. Polkit may deny it and it may already be
 * on; neither is fatal, the daemon just goes back to dying with the user's last
 * session.
 */
export function enableSystemdLinger(): void {
  try {
    spawnSync("loginctl", ["enable-linger"], { timeout: 2000, stdio: "ignore" });
  } catch {
    // Already enabled, or refused. Nothing to do about either.
  }
}

/**
 * The command to actually spawn. Pure, so the wrapping is testable without a
 * systemd on the machine running the tests.
 */
export function resolveDaemonLaunchCommand(input: {
  execPath: string;
  args: string[];
  useSystemdScope: boolean;
}): { command: string; args: string[] } {
  if (!input.useSystemdScope) return { command: input.execPath, args: input.args };
  // --quiet so the scope registration does not land in the daemon's stdio, and
  // --collect so a scope whose daemon crashed is garbage-collected rather than
  // left behind in a failed state where the same unit name cannot be reused.
  return {
    command: "systemd-run",
    args: ["--user", "--scope", "--quiet", "--collect", input.execPath, ...input.args],
  };
}

export async function launchLocalDaemon(options: {
  home: string;
  timeoutMs?: number;
  foreground?: boolean;
}) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const entry = resolveDaemonRunnerEntry();
    // Foreground is `paseo daemon run`: a deployment the caller supervises, which
    // wants no scope of its own and no linger.
    const useSystemdScope = !options.foreground && detectSystemdScopeSupport();
    if (useSystemdScope) enableSystemdLinger();
    const launch = resolveDaemonLaunchCommand({
      execPath: process.execPath,
      args: [...(entry.endsWith(".ts") ? ["--import", "tsx"] : []), entry],
      useSystemdScope,
    });
    return await startDaemonInstance({
      home: resolvePaseoHome({ PASEO_HOME: options.home }),
      command: launch.command,
      args: launch.args,
      // systemd-run starts the daemon as its child rather than becoming it, so
      // the PID this spawns is never the daemon's.
      launcherSpawnsDaemon: useSystemdScope,
      env: process.env,
      mode: options.foreground ? "deployment" : "managed",
      foreground: options.foreground,
      timeoutMs: options.timeoutMs,
      signal: abort.signal,
      onReady: options.foreground
        ? (instance) =>
            process.stdout.write(`Listening on ${instance.listen} (PID ${instance.pid})\n`)
        : undefined,
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

export function parseTimeoutMs(raw: unknown, fallback = 600_000): number {
  if (raw === undefined) return fallback;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw { code: "INVALID_TIMEOUT", message: "Timeout must be a positive number of seconds." };
  return Math.ceil(seconds * 1000);
}

const REMOVED_LAUNCH_FLAGS: Record<string, string> = {
  "--port <port>": "daemon.listen",
  "--listen <listen>": "daemon.listen",
  "--relay": "daemon.relay.enabled",
  "--no-relay": "daemon.relay.enabled",
  "--relay-use-tls": "daemon.relay.useTls",
  "--no-mcp": "daemon.mcp.enabled",
  "--no-inject-mcp": "daemon.mcp.injectIntoAgents",
  "--web-ui": "features.webUi.enabled",
  "--no-web-ui": "features.webUi.enabled",
  "--hostnames <hosts>": "daemon.hostnames",
  "--allowed-hosts <hosts>": "daemon.hostnames",
  "--foreground": "",
};

export function rejectRemovedLaunchFlags(command: Command): Command {
  for (const flag of Object.keys(REMOVED_LAUNCH_FLAGS))
    command.addOption(new Option(flag).hideHelp());
  command.hook("preAction", () => {
    for (const [flag, configPath] of Object.entries(REMOVED_LAUNCH_FLAGS)) {
      const name = new Option(flag).attributeName();
      if (command.getOptionValueSource(name) !== "cli") continue;
      throw {
        code: "REMOVED_LAUNCH_OPTION",
        message: `${flag.split(" ")[0]} was removed. ${configPath ? `Use paseo daemon config set ${configPath} <value> --home <path>, then start or restart.` : "Use paseo daemon run --home <path> for foreground deployment."} Deployment environment overrides belong to paseo daemon run.`,
      };
    }
  });
  return command;
}
