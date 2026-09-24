import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { LanguageServerLauncher } from "./launcher.js";
import { LanguageServerPool } from "./pool.js";
import { resolveLanguageServers, type LanguageServerDescriptor } from "./servers.js";

const protocolEntry = createRequire(import.meta.url).resolve("vscode-languageserver-protocol/node");

// The smallest server the pool can start: it answers the handshake and exits on request.
const FAKE_SERVER = `
const p = require(${JSON.stringify(protocolEntry)});
const c = p.createMessageConnection(new p.StreamMessageReader(process.stdin), new p.StreamMessageWriter(process.stdout));
c.onRequest(p.InitializeRequest.type, () => ({ capabilities: {} }));
c.onRequest(p.ShutdownRequest.type, () => null);
c.onNotification(p.ExitNotification.type, () => process.exit(0));
c.listen();
`;

let fixtureDir: string;
let serverScript: string;
let pool: LanguageServerPool | null = null;

interface FakeLauncher extends LanguageServerLauncher {
  children: ChildProcess[];
}

function createFakeLauncher(options: { installed: boolean }): FakeLauncher {
  const children: ChildProcess[] = [];
  return {
    key: "fake",
    children,
    resolveExecutable: async () => (options.installed ? process.execPath : null),
    spawn: (command, _args, { cwd }) => {
      const child = spawn(command, [serverScript], { cwd, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      return child;
    },
    toServerPath: (hostPath) => hostPath,
    toHostPath: (serverPath) => serverPath,
  };
}

function typescriptServer(): LanguageServerDescriptor {
  const server = resolveLanguageServers().find((candidate) => candidate.id === "typescript");
  if (!server) throw new Error("typescript descriptor missing");
  return server;
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "paseo-pool-"));
  serverScript = path.join(fixtureDir, "server.cjs");
  await writeFile(serverScript, FAKE_SERVER);
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

afterEach(async () => {
  await pool?.dispose();
  pool = null;
});

describe("LanguageServerPool", () => {
  test("reuses one server per root and language", async () => {
    pool = new LanguageServerPool({ logger: createTestLogger() });
    const launcher = createFakeLauncher({ installed: true });
    const server = typescriptServer();

    await Promise.all([
      pool.acquire({ launcher, rootPath: fixtureDir, server }),
      pool.acquire({ launcher, rootPath: fixtureDir, server }),
    ]);

    expect(launcher.children).toHaveLength(1);
  });

  test("an absent server is reported without spawning anything", async () => {
    pool = new LanguageServerPool({ logger: createTestLogger() });
    const launcher = createFakeLauncher({ installed: false });

    const result = await pool.acquire({
      launcher,
      rootPath: fixtureDir,
      server: typescriptServer(),
    });

    expect(result).toEqual({ status: "not_installed" });
    expect(launcher.children).toHaveLength(0);
  });

  test("overflow stops the least recently used server", async () => {
    pool = new LanguageServerPool({ logger: createTestLogger(), maxServers: 1 });
    const launcher = createFakeLauncher({ installed: true });
    const server = typescriptServer();

    await pool.acquire({ launcher, rootPath: fixtureDir, server });
    await pool.acquire({ launcher, rootPath: tmpdir(), server });
    await exited(launcher.children[0]);

    expect(launcher.children[0].exitCode).toBe(0);
    expect(launcher.children[1].exitCode).toBeNull();
  });

  test("a server that died is replaced on the next request", async () => {
    pool = new LanguageServerPool({ logger: createTestLogger() });
    const launcher = createFakeLauncher({ installed: true });
    const server = typescriptServer();

    await pool.acquire({ launcher, rootPath: fixtureDir, server });
    launcher.children[0].kill("SIGKILL");
    await exited(launcher.children[0]);
    const result = await pool.acquire({ launcher, rootPath: fixtureDir, server });

    expect(result.status).toBe("ready");
    expect(launcher.children).toHaveLength(2);
  });

  test("closing an environment stops only its servers", async () => {
    pool = new LanguageServerPool({ logger: createTestLogger() });
    const first = createFakeLauncher({ installed: true });
    const second = { ...createFakeLauncher({ installed: true }), key: "other" };
    const server = typescriptServer();

    await pool.acquire({ launcher: first, rootPath: fixtureDir, server });
    await pool.acquire({ launcher: second, rootPath: fixtureDir, server });
    await pool.closeLauncher("fake");

    expect(first.children[0].exitCode).toBe(0);
    expect(second.children[0].exitCode).toBeNull();
  });
});
