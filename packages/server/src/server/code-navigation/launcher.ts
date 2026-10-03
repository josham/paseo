import type { ChildProcess } from "node:child_process";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { spawnProcess } from "../../utils/spawn.js";

/**
 * Where a workspace's language servers run. On the host this is a plain spawn; for a workspace
 * whose agents run somewhere else, the server has to run there too, because that is where the
 * toolchain is and where the project code it executes (build scripts, `go list`) belongs.
 */
export interface LanguageServerLauncher {
  /** Distinguishes environments in the session pool, so one root never shares a process across them. */
  readonly key: string;
  /** The runnable path of `command` in this environment, or null when it is not installed. */
  resolveExecutable(command: string): Promise<string | null>;
  spawn(command: string, args: string[], options: { cwd: string }): ChildProcess;
  /** Map a daemon path to the path the server sees. */
  toServerPath(hostPath: string): string;
  /** Map a path the server reported back to a daemon path, or null when it has none. */
  toHostPath(serverPath: string): string | null;
}

export function createLocalLauncher(): LanguageServerLauncher {
  return {
    key: "local",
    resolveExecutable: (command) => findExecutable(command),
    spawn: (command, args, { cwd }) =>
      spawnProcess(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] }),
    toServerPath: (hostPath) => hostPath,
    toHostPath: (serverPath) => serverPath,
  };
}
