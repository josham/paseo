import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { execCommand } from "../../utils/spawn.js";
import { ContainerNotRunningError } from "../devcontainer/launch-strategy-registry.js";
import { ContainerExecLaunchStrategy } from "../devcontainer/launch-strategy.js";
import { FakeIsolatedLaunchStrategy } from "../devcontainer/test-utils/fake-isolated-strategy.js";
import { createPersistedWorkspaceRecord } from "../workspace-registry.js";
import {
  containerPathToHost,
  createContainerLauncher,
  createWorkspaceLauncherResolver,
} from "./container-launcher.js";
import { resolveLanguageServers } from "./servers.js";
import { createCodeNavigationService, type CodeNavigationService } from "./service.js";

function workspaceRecord(cwd: string) {
  const now = new Date().toISOString();
  return createPersistedWorkspaceRecord({
    workspaceId: "workspace-1",
    projectId: "project-1",
    cwd,
    kind: "directory",
    displayName: "fixture",
    createdAt: now,
    updatedAt: now,
  });
}

describe("containerPathToHost", () => {
  const folders = { hostFolder: "/home/me/app", remoteFolder: "/workspaces/app" };

  test("maps a path under the mounted folder back to the host", () => {
    expect(containerPathToHost({ ...folders, serverPath: "/workspaces/app/src/a.ts" })).toBe(
      "/home/me/app/src/a.ts",
    );
  });

  test("has no host path for anything outside the mount", () => {
    expect(containerPathToHost({ ...folders, serverPath: "/usr/lib/go/src/fmt/print.go" })).toBe(
      null,
    );
    expect(containerPathToHost({ ...folders, serverPath: "/workspaces/application/x.ts" })).toBe(
      null,
    );
  });
});

describe("createWorkspaceLauncherResolver", () => {
  test("a host workspace runs its servers locally", async () => {
    const resolve = createWorkspaceLauncherResolver(async () => null);

    const result = await resolve(workspaceRecord("/home/me/app"));

    expect(result.status === "ready" && result.launcher.key).toBe("local");
  });

  test("a stopped container is reported, never replaced by the host", async () => {
    const resolve = createWorkspaceLauncherResolver(async (_cwd, workspaceId) => {
      throw new ContainerNotRunningError(workspaceId);
    });

    expect(await resolve(workspaceRecord("/home/me/app"))).toEqual({
      status: "container_not_running",
    });
  });
});

describe("createContainerLauncher", () => {
  test("a server missing from the image is reported as not installed", async () => {
    const launcher = createContainerLauncher({
      strategy: new FakeIsolatedLaunchStrategy({
        hostWorkspaceFolder: "/home/me/app",
        remoteWorkspaceFolder: "/workspaces/app",
        missingExecutables: ["gopls"],
      }),
      containerKey: "abc",
      hostWorkspaceFolder: "/home/me/app",
      remoteWorkspaceFolder: "/workspaces/app",
    });

    expect(await launcher.resolveExecutable("gopls")).toBeNull();
    expect(launcher.toServerPath("/home/me/app/main.go")).toBe("/workspaces/app/main.go");
  });
});

async function isDockerAvailable(): Promise<boolean> {
  if (process.platform === "win32") return false;
  try {
    await execCommand("docker", ["info"], { envMode: "internal", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const dockerTest = (await isDockerAvailable()) ? test : test.skip;
const IMAGE = "node:22-bookworm-slim";
const REMOTE_FOLDER = "/workspaces/fixture";
// The repository's node_modules, mounted read-only, supplies typescript-language-server and the
// typescript it loads — the image only has to provide node.
const NODE_MODULES = path.resolve(
  path.dirname(createRequire(import.meta.url).resolve("typescript-language-server/lib/cli.mjs")),
  "../..",
);

describe("code navigation in a real container", () => {
  let containerId: string | null = null;
  let projectRoot: string | null = null;
  let service: CodeNavigationService | null = null;

  afterEach(async () => {
    await service?.dispose();
    if (containerId) {
      await execCommand("docker", ["rm", "-f", containerId], { envMode: "internal" }).catch(
        () => undefined,
      );
    }
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
  });

  dockerTest(
    "resolves definitions with the server running inside the container",
    async () => {
      projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-codenav-container-")));
      await writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({}));
      await writeFile(path.join(projectRoot, "util.ts"), "export const answer = 42;\n");
      await writeFile(
        path.join(projectRoot, "main.ts"),
        'import { answer } from "./util";\nexport const values: Array<number> = [answer];\n',
      );
      const started = await execCommand(
        "docker",
        [
          "run",
          "-d",
          "-v",
          `${projectRoot}:${REMOTE_FOLDER}`,
          "-v",
          `${NODE_MODULES}:/opt/node_modules:ro`,
          IMAGE,
          "sleep",
          "infinity",
        ],
        { envMode: "internal", timeout: 120_000 },
      );
      containerId = started.stdout.trim();
      const strategy = new ContainerExecLaunchStrategy({
        command: "docker",
        leadingArgs: ["exec"],
        optionArgs: ["-i"],
        targetArgs: [containerId],
        workdirFlag: "-w",
        envFlag: "-e",
        ttyArgs: ["-t"],
        hostWorkspaceFolder: projectRoot,
        remoteWorkspaceFolder: REMOTE_FOLDER,
      });
      const workspace = workspaceRecord(projectRoot);
      service = createCodeNavigationService({
        logger: createTestLogger(),
        workspaceRegistry: { list: async () => [workspace] },
        readSettings: () => ({
          enabled: true,
          servers: resolveLanguageServers({
            typescript: {
              command: "node",
              args: ["/opt/node_modules/typescript-language-server/lib/cli.mjs", "--stdio"],
            },
          }),
        }),
        resolveLauncher: createWorkspaceLauncherResolver(async () => strategy),
      });
      const request = {
        type: "code.symbol.get_locations.request" as const,
        requestId: "container",
        cwd: projectRoot,
        path: "main.ts",
        kind: "definition" as const,
      };

      // `answer` in `[answer]`: declared in the mounted workspace, so it maps back to the host.
      const local = await service.getLocations({
        ...request,
        position: { line: 1, character: 40 },
      });
      // `Array`: declared in typescript's lib inside the container, which the host cannot open.
      const library = await service.getLocations({
        ...request,
        position: { line: 1, character: 22 },
      });

      expect(local).toMatchObject({
        status: "ok",
        locations: [{ path: "util.ts", openable: true, preview: "export const answer = 42;" }],
      });
      expect(library.status === "ok" && library.locations.length > 0).toBe(true);
      expect(
        library.status === "ok" &&
          library.locations.every(
            (location) => !location.openable && location.path.startsWith("/opt/node_modules/"),
          ),
      ).toBe(true);
    },
    180_000,
  );
});
