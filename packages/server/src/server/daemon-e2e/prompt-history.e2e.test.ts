import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { MockLoadTestAgentClient } from "../agent/providers/mock-load-test-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const MOCK_MODEL = "e2e-fast-stream";

const cleanupPaths = new Set<string>();
const cleanupDaemons = new Set<TestPaseoDaemon>();
const cleanupClients = new Set<DaemonClient>();

afterEach(async () => {
  await Promise.all(Array.from(cleanupClients, (client) => client.close().catch(() => undefined)));
  cleanupClients.clear();
  await Promise.all(Array.from(cleanupDaemons, (daemon) => daemon.close().catch(() => undefined)));
  cleanupDaemons.clear();
  await Promise.all(
    Array.from(cleanupPaths, (target) => rm(target, { recursive: true, force: true })),
  );
  cleanupPaths.clear();
});

/**
 * Recording is deliberately not awaited by the send it came from, so the test
 * waits for the list to settle rather than assuming one round trip is enough.
 */
async function waitForPromptHistory(
  client: DaemonClient,
  projectKey: string,
  expected: number,
): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  let entries: string[] = [];
  while (Date.now() < deadline) {
    const payload = await client.listPromptHistory({ projectKey });
    entries = payload.entries.map((entry) => entry.text);
    if (entries.length >= expected) return entries;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return entries;
}

/**
 * The daemon keys history by the project it created for the agent's directory,
 * so the test asks the registry rather than assuming an id shape.
 */
async function projectKeyForWorkspace(
  client: DaemonClient,
  workspaceRoot: string,
): Promise<string> {
  const workspaces = await client.fetchWorkspaces({});
  const entry = workspaces.entries.find(
    (candidate) => candidate.workspaceDirectory === workspaceRoot,
  );
  if (!entry) throw new Error(`No workspace registered for ${workspaceRoot}`);
  return entry.projectId;
}

async function connectDaemon(): Promise<{
  client: DaemonClient;
  workspaceRoot: string;
}> {
  const daemon = await createTestPaseoDaemon({
    isDev: true,
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  cleanupDaemons.add(daemon);
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  cleanupClients.add(client);
  await client.connect();

  const workspaceRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-prompt-history-")));
  cleanupPaths.add(workspaceRoot);
  return { client, workspaceRoot };
}

test("advertises prompt history so the app can offer recall", async () => {
  const { client } = await connectDaemon();

  expect(client.supportsPromptHistory()).toBe(true);
});

test("serves back the prompts a person sent, newest first", async () => {
  const { client, workspaceRoot } = await connectDaemon();

  const agent = await client.createAgent({
    provider: "mock",
    model: MOCK_MODEL,
    cwd: workspaceRoot,
    title: "Prompt history",
    initialPrompt: "open the parser",
  });
  const projectKey = await projectKeyForWorkspace(client, workspaceRoot);

  await client.sendMessage(agent.id, "then fix the lint");

  const entries = await waitForPromptHistory(client, projectKey, 2);
  expect(entries).toEqual(["then fix the lint", "open the parser"]);
});

test("moves a re-sent prompt to the front instead of repeating it", async () => {
  const { client, workspaceRoot } = await connectDaemon();

  const agent = await client.createAgent({
    provider: "mock",
    model: MOCK_MODEL,
    cwd: workspaceRoot,
    title: "Prompt history",
    initialPrompt: "run the tests",
  });
  const projectKey = await projectKeyForWorkspace(client, workspaceRoot);

  await client.sendMessage(agent.id, "fix the lint");
  await waitForPromptHistory(client, projectKey, 2);
  await client.sendMessage(agent.id, "run the tests");

  const deadline = Date.now() + 10_000;
  let entries: string[] = [];
  while (Date.now() < deadline) {
    entries = (await client.listPromptHistory({ projectKey })).entries.map((entry) => entry.text);
    if (entries[0] === "run the tests") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(entries).toEqual(["run the tests", "fix the lint"]);
});

test("keeps history empty for a project nothing was sent in", async () => {
  const { client } = await connectDaemon();

  const payload = await client.listPromptHistory({ projectKey: "prj_0000000000000000" });

  expect(payload.entries).toEqual([]);
  expect(payload.error).toBeNull();
});

test("survives a daemon restart", async () => {
  const paseoHomeRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-prompt-home-")));
  cleanupPaths.add(paseoHomeRoot);
  const workspaceRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-prompt-cwd-")));
  cleanupPaths.add(workspaceRoot);

  const first = await createTestPaseoDaemon({
    isDev: true,
    paseoHomeRoot,
    cleanup: false,
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  const firstClient = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws` });
  await firstClient.connect();

  await firstClient.createAgent({
    provider: "mock",
    model: MOCK_MODEL,
    cwd: workspaceRoot,
    title: "Prompt history",
    initialPrompt: "remember me across restarts",
  });
  const projectKey = await projectKeyForWorkspace(firstClient, workspaceRoot);
  await waitForPromptHistory(firstClient, projectKey, 1);

  await firstClient.close();
  await first.close();

  const second = await createTestPaseoDaemon({
    isDev: true,
    paseoHomeRoot,
    cleanup: false,
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  cleanupDaemons.add(second);
  const secondClient = new DaemonClient({ url: `ws://127.0.0.1:${second.port}/ws` });
  cleanupClients.add(secondClient);
  await secondClient.connect();

  const payload = await secondClient.listPromptHistory({ projectKey });
  expect(payload.entries.map((entry) => entry.text)).toEqual(["remember me across restarts"]);
});
