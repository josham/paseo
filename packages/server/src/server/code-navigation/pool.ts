import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import type pino from "pino";
import type { ManagedProcessRegistry } from "../managed-processes/managed-processes.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../utils/tree-kill.js";
import {
  LanguageServerConnection,
  type ConnectionTimeouts,
  type LanguageServerTransport,
} from "./connection.js";
import type { LanguageServerLauncher } from "./launcher.js";
import type { LanguageServerCommand, LanguageServerDescriptor } from "./servers.js";

/** Idle servers hold a whole project graph in memory. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Paseo hands out a worktree per agent, so without a cap the key space is unbounded. */
const MAX_SERVERS = 4;
/**
 * Resolving a command costs a PATH walk and a `--version` probe, and a miss would repeat it on
 * every click. Remember the answer briefly, so installing a server still takes effect without a
 * daemon restart.
 */
const RESOLUTION_TTL_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const STDERR_TAIL_LINES = 20;

export interface AcquireInput {
  launcher: LanguageServerLauncher;
  /** Workspace root on the daemon's side. */
  rootPath: string;
  server: LanguageServerDescriptor;
}

export type AcquireResult =
  | { status: "ready"; connection: LanguageServerConnection }
  | { status: "not_installed" };

export class LanguageServerStartError extends Error {
  constructor(
    readonly serverId: string,
    readonly stderrTail: string,
    cause: unknown,
  ) {
    const detail = stderrTail ? `: ${stderrTail}` : "";
    super(`Language server "${serverId}" failed to start${detail}`, { cause });
    this.name = "LanguageServerStartError";
  }
}

export interface LanguageServerPoolOptions {
  logger: pino.Logger;
  managedProcesses?: Pick<ManagedProcessRegistry, "record" | "remove">;
  terminate?: ProcessTerminator;
  timeouts?: Partial<ConnectionTimeouts>;
  idleTimeoutMs?: number;
  maxServers?: number;
}

interface PoolEntry {
  key: string;
  launcherKey: string;
  ready: Promise<LanguageServerConnection>;
  idleTimer: NodeJS.Timeout;
  close: () => Promise<void>;
}

interface CachedResolution {
  command: LanguageServerCommand | null;
  expiresAt: number;
}

/**
 * One language server process per (environment, workspace root, language). Servers start on
 * first use and stop when idle, when the pool overflows, or when their environment goes away.
 */
export class LanguageServerPool {
  private readonly logger: pino.Logger;
  private readonly managedProcesses: LanguageServerPoolOptions["managedProcesses"];
  private readonly terminate: ProcessTerminator;
  private readonly timeouts: Partial<ConnectionTimeouts> | undefined;
  private readonly idleTimeoutMs: number;
  private readonly maxServers: number;
  private readonly entries = new Map<string, PoolEntry>();
  private readonly resolutions = new Map<string, CachedResolution>();
  private disposed = false;

  constructor(options: LanguageServerPoolOptions) {
    this.logger = options.logger.child({ module: "code-navigation" });
    this.managedProcesses = options.managedProcesses;
    this.terminate = options.terminate ?? terminateWithTreeKill;
    this.timeouts = options.timeouts;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.maxServers = options.maxServers ?? MAX_SERVERS;
  }

  async acquire(input: AcquireInput): Promise<AcquireResult> {
    if (this.disposed) throw new Error("language server pool is disposed");
    const key = JSON.stringify([input.launcher.key, input.rootPath, input.server.id]);
    const existing = this.entries.get(key);
    if (existing) {
      this.touch(existing);
      return { status: "ready", connection: await existing.ready };
    }

    const command = await this.resolveCommand(input.launcher, input.server);
    if (!command) return { status: "not_installed" };

    // Resolution awaited, so a concurrent request may have started this server meanwhile.
    const raced = this.entries.get(key);
    if (raced) {
      this.touch(raced);
      return { status: "ready", connection: await raced.ready };
    }

    const entry = this.start({ key, input, command });
    this.entries.set(key, entry);
    this.evictOverflow();
    return { status: "ready", connection: await entry.ready };
  }

  /** Stop every server running in one environment, such as a container that is going away. */
  async closeLauncher(launcherKey: string): Promise<void> {
    const matching = [...this.entries.values()].filter(
      (entry) => entry.launcherKey === launcherKey,
    );
    for (const entry of matching) this.entries.delete(entry.key);
    for (const key of this.resolutions.keys()) {
      if (key.startsWith(`${launcherKey}\0`)) this.resolutions.delete(key);
    }
    await Promise.all(matching.map((entry) => entry.close()));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.close()));
  }

  private async resolveCommand(
    launcher: LanguageServerLauncher,
    server: LanguageServerDescriptor,
  ): Promise<LanguageServerCommand | null> {
    const cacheKey = `${launcher.key}\0${JSON.stringify(server.candidates)}`;
    const cached = this.resolutions.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.command;

    let command: LanguageServerCommand | null = null;
    for (const candidate of server.candidates) {
      const executable = await launcher.resolveExecutable(candidate.command);
      if (executable) {
        command = { command: executable, args: candidate.args };
        break;
      }
    }
    this.resolutions.set(cacheKey, { command, expiresAt: Date.now() + RESOLUTION_TTL_MS });
    return command;
  }

  private start(params: {
    key: string;
    input: AcquireInput;
    command: LanguageServerCommand;
  }): PoolEntry {
    const { key, input, command } = params;
    const { launcher, rootPath, server } = input;
    const logger = this.logger.child({ languageServer: server.id, rootPath });
    const child = launcher.spawn(command.command, command.args, { cwd: rootPath });
    const stderrTail: string[] = [];
    const managedRecord = this.recordProcess({ child, command, serverId: server.id });

    // A spawn failure (EAGAIN under load, a binary removed after it was resolved) is emitted
    // here, and without a listener Node rethrows it and takes the daemon down.
    child.on("error", (error) => logger.warn({ err: error }, "language server process failed"));
    // Writes into a dead process surface as an EPIPE on stdin.
    child.stdin?.on("error", (error) =>
      logger.debug({ err: error }, "language server stdin failed"),
    );
    // Unread stderr fills the pipe and blocks the server.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
        logger.trace({ line }, "language server stderr");
      }
    });

    const ready = startConnection({ child, launcher, rootPath, logger, timeouts: this.timeouts });
    let closing: Promise<void> | null = null;
    const close = () => {
      closing ??= (async () => {
        clearTimeout(entry.idleTimer);
        const connection = await ready.catch(() => null);
        await connection?.shutdown(SHUTDOWN_TIMEOUT_MS);
        // typescript-language-server forks tsserver and pyright's server is a shim, so killing
        // only the parent orphans the process that holds the project graph.
        await this.terminate(child, {
          gracefulTimeoutMs: SHUTDOWN_TIMEOUT_MS,
          forceTimeoutMs: SHUTDOWN_TIMEOUT_MS,
        });
        await this.forgetProcess(managedRecord);
      })();
      return closing;
    };

    child.once("exit", (code, signal) => {
      logger.debug({ code, signal }, "language server exited");
      if (this.entries.get(key) === entry) this.entries.delete(key);
      void this.forgetProcess(managedRecord);
    });

    const entry: PoolEntry = {
      key,
      launcherKey: launcher.key,
      ready: ready.catch(async (error: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        await close();
        throw new LanguageServerStartError(server.id, stderrTail.join("\n"), error);
      }),
      idleTimer: this.scheduleIdleClose(key),
      close,
    };
    ready.then(
      (connection) =>
        connection.onClose(() => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          void close();
        }),
      () => undefined,
    );
    return entry;
  }

  private touch(entry: PoolEntry): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = this.scheduleIdleClose(entry.key);
    // Re-insert so Map order tracks recency for eviction.
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
  }

  private scheduleIdleClose(key: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const entry = this.entries.get(key);
      if (!entry) return;
      this.entries.delete(key);
      this.logger.debug({ key }, "stopping idle language server");
      void entry.close();
    }, this.idleTimeoutMs);
    timer.unref?.();
    return timer;
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxServers) {
      const oldest = this.entries.values().next().value;
      if (!oldest) return;
      this.entries.delete(oldest.key);
      this.logger.debug({ key: oldest.key }, "evicting least recently used language server");
      void oldest.close();
    }
  }

  private async recordProcess(params: {
    child: ChildProcess;
    command: LanguageServerCommand;
    serverId: string;
  }): Promise<{ id: string } | null> {
    const pid = params.child.pid;
    if (!this.managedProcesses || typeof pid !== "number") return null;
    try {
      return await this.managedProcesses.record({
        owner: { provider: "code-navigation", kind: "language-server" },
        pid,
        command: params.command.command,
        args: params.command.args,
        metadata: { serverId: params.serverId },
      });
    } catch (error) {
      this.logger.warn({ err: error, pid }, "failed to record language server process");
      return null;
    }
  }

  private async forgetProcess(record: Promise<{ id: string } | null>): Promise<void> {
    const resolved = await record;
    if (!resolved || !this.managedProcesses) return;
    try {
      await this.managedProcesses.remove(resolved.id);
    } catch (error) {
      this.logger.warn({ err: error, id: resolved.id }, "failed to remove language server record");
    }
  }
}

function startConnection(params: {
  child: ChildProcess;
  launcher: LanguageServerLauncher;
  rootPath: string;
  logger: pino.Logger;
  timeouts: Partial<ConnectionTimeouts> | undefined;
}): Promise<LanguageServerConnection> {
  const { child, launcher, rootPath, logger, timeouts } = params;
  if (!child.stdout || !child.stdin) {
    return Promise.reject(new Error("language server was spawned without stdio pipes"));
  }
  const transport: LanguageServerTransport = { input: child.stdout, output: child.stdin };
  const exited = new Promise<never>((_, reject) => {
    child.once("exit", (code, signal) =>
      reject(new Error(`exited during startup (code ${code}, signal ${signal})`)),
    );
    child.once("error", reject);
  });
  const starting = LanguageServerConnection.start({
    transport,
    rootPath: launcher.toServerPath(rootPath),
    logger,
    timeouts,
    readOpenDocument: (serverPath) => readHostText(launcher.toHostPath(serverPath)),
  });
  // Whichever loses the race still settles later; neither may surface as an unhandled rejection.
  exited.catch(() => undefined);
  starting.catch(() => undefined);
  return Promise.race([starting, exited]);
}

async function readHostText(hostPath: string | null): Promise<string | null> {
  if (!hostPath) return null;
  try {
    return await readFile(hostPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
