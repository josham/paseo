import { resolve, sep } from "node:path";
import { ContainerNotRunningError } from "../devcontainer/launch-strategy-registry.js";
import {
  ExecutableNotFoundError,
  type ProcessLaunchStrategy,
} from "../devcontainer/launch-strategy.js";
import { createLocalLauncher, type LanguageServerLauncher } from "./launcher.js";
import type { ResolveLauncher } from "./service.js";

export class MissingContainerSpecError extends Error {
  constructor(readonly workspaceId: string) {
    super(`Workspace ${workspaceId} runs isolated but its launch strategy has no exec spec`);
    this.name = "MissingContainerSpecError";
  }
}

/**
 * Pick where a workspace's language servers run from the same launch strategy its agents and
 * terminals use. A workspace that wants a container never falls back to the host: with the
 * container stopped, navigation reports that instead.
 */
export function createWorkspaceLauncherResolver(
  resolveStrategy: (cwd: string, workspaceId: string) => Promise<ProcessLaunchStrategy | null>,
): ResolveLauncher {
  const localLauncher = createLocalLauncher();
  return async (workspace) => {
    let strategy: ProcessLaunchStrategy | null;
    try {
      strategy = await resolveStrategy(workspace.cwd, workspace.workspaceId);
    } catch (error) {
      if (error instanceof ContainerNotRunningError) return { status: "container_not_running" };
      throw error;
    }
    if (!strategy) return { status: "ready", launcher: localLauncher };
    const spec = strategy.serialize();
    if (!spec) throw new MissingContainerSpecError(workspace.workspaceId);
    return {
      status: "ready",
      launcher: createContainerLauncher({
        strategy,
        containerKey: spec.targetArgs.join(" "),
        hostWorkspaceFolder: spec.hostWorkspaceFolder,
        remoteWorkspaceFolder: spec.remoteWorkspaceFolder,
      }),
    };
  };
}

/**
 * Language servers for a workspace whose agents run in a container. The server runs there too:
 * that is where the toolchain is, and a server executes project code (build scripts, `go list`)
 * that must stay on the same side of the boundary as the agents.
 */
export function createContainerLauncher(input: {
  strategy: ProcessLaunchStrategy;
  /** Identifies this container, so a restarted or rebuilt one gets fresh servers. */
  containerKey: string;
  hostWorkspaceFolder: string;
  remoteWorkspaceFolder: string;
}): LanguageServerLauncher {
  const { strategy } = input;
  const hostFolder = resolve(input.hostWorkspaceFolder);
  const remoteFolder = input.remoteWorkspaceFolder;
  return {
    key: `container:${input.containerKey}`,
    async resolveExecutable(command) {
      try {
        return await strategy.resolveExecutable(command);
      } catch (error) {
        if (error instanceof ExecutableNotFoundError) return null;
        throw error;
      }
    },
    spawn: (command, args, { cwd }) =>
      strategy.spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] }),
    toServerPath: (hostPath) => strategy.resolveCwd(hostPath),
    toHostPath: (serverPath) => containerPathToHost({ serverPath, hostFolder, remoteFolder }),
  };
}

/**
 * Only the workspace folder is mounted, so a path elsewhere in the container — the image's
 * `node_modules`, a Go module cache, the standard library — has no host counterpart.
 */
export function containerPathToHost(input: {
  serverPath: string;
  hostFolder: string;
  remoteFolder: string;
}): string | null {
  const { serverPath, hostFolder, remoteFolder } = input;
  if (serverPath === remoteFolder) return hostFolder;
  if (!serverPath.startsWith(`${remoteFolder}/`)) return null;
  const relative = serverPath
    .slice(remoteFolder.length + 1)
    .split("/")
    .join(sep);
  return `${hostFolder}${sep}${relative}`;
}
