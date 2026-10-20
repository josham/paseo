import { readFile } from "node:fs/promises";
import type pino from "pino";
import type {
  CodeSymbolGetLocationsRequest,
  CodeSymbolLocationsResult,
} from "@getpaseo/protocol/messages";
import { URI } from "vscode-uri";
import { resolveExplorerFilePath } from "../file-explorer/service.js";
import type { ManagedProcessRegistry } from "../managed-processes/managed-processes.js";
import { readPersistedConfig, type PersistedConfig } from "../persisted-config.js";
import { resolveWorkspaceIdForPath } from "../resolve-workspace-id-for-path.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";
import type { ConnectionTimeouts } from "./connection.js";
import { createLocalLauncher, type LanguageServerLauncher } from "./launcher.js";
import { dropEnclosingTargets, mapLocations } from "./locations.js";
import { LanguageServerPool } from "./pool.js";
import {
  findLanguageServer,
  languageIdForFile,
  resolveLanguageServers,
  type LanguageServerDescriptor,
} from "./servers.js";

/** Config is re-read at most this often, so an edit applies without a daemon restart. */
const CONFIG_TTL_MS = 30_000;

export type LauncherResolution =
  | { status: "ready"; launcher: LanguageServerLauncher }
  | { status: "container_not_running" };

/**
 * Where a workspace's language servers run. The host by default; a build that runs agents
 * elsewhere supplies its own.
 */
export type ResolveLauncher = (workspace: PersistedWorkspaceRecord) => Promise<LauncherResolution>;

export interface CodeNavigationService {
  getLocations(request: CodeSymbolGetLocationsRequest): Promise<CodeSymbolLocationsResult>;
  /** Stop every server running in one environment, such as a container that is going away. */
  closeLauncher(launcherKey: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface CodeNavigationSettings {
  enabled: boolean;
  servers: LanguageServerDescriptor[];
}

export interface CodeNavigationServiceOptions {
  logger: pino.Logger;
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  /** Current settings; production reads them from config.json via `createConfigSettingsReader`. */
  readSettings: () => CodeNavigationSettings;
  resolveLauncher?: ResolveLauncher;
  managedProcesses?: Pick<ManagedProcessRegistry, "record" | "remove">;
  timeouts?: Partial<ConnectionTimeouts>;
}

export function createCodeNavigationService(
  options: CodeNavigationServiceOptions,
): CodeNavigationService {
  const logger = options.logger.child({ module: "code-navigation" });
  const localLauncher = createLocalLauncher();
  const resolveLauncher: ResolveLauncher =
    options.resolveLauncher ?? (async () => ({ status: "ready", launcher: localLauncher }));
  const pool = new LanguageServerPool({
    logger,
    managedProcesses: options.managedProcesses,
    timeouts: options.timeouts,
  });

  async function getLocations(
    request: CodeSymbolGetLocationsRequest,
  ): Promise<CodeSymbolLocationsResult> {
    const settings = options.readSettings();
    if (!settings.enabled) return { status: "unavailable", reason: "disabled" };

    // Starting a language server runs project code (build scripts, `go list`), so only a
    // directory the user opened as a workspace may start one — not any path a client names.
    const workspace = findWorkspace(await options.workspaceRegistry.list(), request.cwd);
    if (!workspace) return { status: "unavailable", reason: "not_a_workspace" };

    const server = findLanguageServer(settings.servers, request.path);
    if (!server) return { status: "unsupported_language" };

    const filePath = await resolveExplorerFilePath({
      root: request.cwd,
      relativePath: request.path,
    });
    const resolution = await resolveLauncher(workspace);
    if (resolution.status !== "ready") return { status: "unavailable", reason: resolution.status };
    const { launcher } = resolution;

    const acquired = await pool.acquire({ launcher, rootPath: workspace.cwd, server });
    if (acquired.status === "not_installed") {
      return {
        status: "server_not_installed",
        serverId: server.id,
        commands: server.candidates.map((candidate) => candidate.command),
      };
    }

    const serverPath = launcher.toServerPath(filePath);
    const documentPosition = {
      path: serverPath,
      languageId: languageIdForFile(server, filePath),
      text: request.content ?? (await readFile(filePath, "utf8")),
      position: request.position,
    };
    const answer =
      request.kind === "definition"
        ? await acquired.connection.definition(documentPosition)
        : await acquired.connection.references(documentPosition);
    const locations =
      request.kind === "definition"
        ? dropEnclosingTargets({
            locations: answer.locations,
            documentUri: URI.file(serverPath).toString(),
            position: request.position,
          })
        : answer.locations;
    const mapped = await mapLocations({
      locations,
      rootPath: workspace.cwd,
      toHostPath: launcher.toHostPath,
    });
    return { status: "ok", ...mapped, partial: answer.partial };
  }

  return {
    async getLocations(request) {
      try {
        return await getLocations(request);
      } catch (error) {
        logger.warn(
          { err: error, path: request.path, kind: request.kind },
          "code navigation failed",
        );
        return {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    closeLauncher: (launcherKey) => pool.closeLauncher(launcherKey),
    dispose: () => pool.dispose(),
  };
}

function findWorkspace(
  workspaces: PersistedWorkspaceRecord[],
  cwd: string,
): PersistedWorkspaceRecord | null {
  const workspaceId = resolveWorkspaceIdForPath(cwd, workspaces);
  const workspace = workspaces.find((candidate) => candidate.workspaceId === workspaceId);
  return workspace && !workspace.archivedAt ? workspace : null;
}

/**
 * Settings from config.json, cached briefly. A config that fails to parse leaves the previous
 * settings in place rather than switching the feature off mid-edit.
 */
export function createConfigSettingsReader(params: {
  paseoHome: string;
  logger: pino.Logger;
}): () => CodeNavigationSettings {
  let cached: { settings: CodeNavigationSettings; expiresAt: number } | null = null;
  return () => {
    if (cached && cached.expiresAt > Date.now()) return cached.settings;
    try {
      const settings = settingsFromConfig(readPersistedConfig(params.paseoHome));
      cached = { settings, expiresAt: Date.now() + CONFIG_TTL_MS };
      return settings;
    } catch (error) {
      params.logger.warn({ err: error }, "code navigation config could not be read");
      if (!cached) throw error;
      cached.expiresAt = Date.now() + CONFIG_TTL_MS;
      return cached.settings;
    }
  };
}

export function settingsFromConfig(config: PersistedConfig): CodeNavigationSettings {
  const section = config.features?.codeNavigation;
  return {
    enabled: section?.enabled ?? true,
    servers: resolveLanguageServers(section?.servers),
  };
}
