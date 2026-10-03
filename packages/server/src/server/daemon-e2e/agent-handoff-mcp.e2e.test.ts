import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, beforeAll, expect, test } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
  getHandoffDepthFromLabels,
  getHandoffFromAgentIdFromLabels,
  getHandoffObjectiveFromLabels,
} from "@getpaseo/protocol/agent-labels";

import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { SummarizableMockAgentClient } from "../test-utils/summarizable-mock-agent.js";

const OBJECTIVE = "Add retry to the upload client";

let workspaceCwd: string;

interface StructuredContent {
  [key: string]: unknown;
}

let daemon: TestPaseoDaemon;
let mcp: {
  callTool: (input: { name: string; args?: StructuredContent }) => Promise<{
    structuredContent?: StructuredContent;
    content?: Array<{ structuredContent?: StructuredContent } | StructuredContent>;
    isError?: boolean;
  }>;
  close: () => Promise<void>;
};

function readStructured(result: {
  structuredContent?: StructuredContent;
  content?: Array<{ structuredContent?: StructuredContent } | StructuredContent>;
}): StructuredContent {
  if (result.structuredContent) {
    return result.structuredContent;
  }
  for (const entry of result.content ?? []) {
    const nested = (entry as { structuredContent?: StructuredContent }).structuredContent;
    if (nested) {
      return nested;
    }
  }
  throw new Error(`tool returned no structured payload: ${JSON.stringify(result).slice(0, 800)}`);
}

beforeAll(async () => {
  workspaceCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-handoff-mcp-"));
  daemon = await createTestPaseoDaemon({
    isDev: true,
    agentClients: { mock: new SummarizableMockAgentClient() },
    providerOverrides: {
      claude: { enabled: false },
      codex: { enabled: false },
      copilot: { enabled: false },
      opencode: { enabled: false },
      pi: { enabled: false },
      omp: { enabled: false },
      "mock-slow": { enabled: false },
    },
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${daemon.port}/mcp/agents`),
  );
  const raw = await experimental_createMCPClient({ transport });
  mcp = {
    callTool: Reflect.get(raw, "callTool").bind(raw),
    close: () => raw.close(),
  };
}, 60_000);

afterAll(async () => {
  await mcp?.close().catch(() => undefined);
  await daemon?.close();
  await rm(workspaceCwd, { recursive: true, force: true });
}, 60_000);

test("handoff_agent creates a successor an agent can hand its own work to", async () => {
  const created = readStructured(
    await mcp.callTool({
      name: "create_agent",
      args: {
        relationship: { kind: "detached" },
        workspace: { kind: "create", source: { kind: "directory", path: workspaceCwd } },
        provider: "mock/gpt-5.4-mini",
        title: "Upload retry",
        initialPrompt: OBJECTIVE,
        background: true,
      },
    }),
  );
  const sourceId = z.string().parse(created.agentId);

  const handoff = readStructured(
    await mcp.callTool({ name: "handoff_agent", args: { agentId: sourceId } }),
  );

  expect(handoff.rootAgentId).toBe(sourceId);
  expect(handoff.chainDepth).toBe(0);
  expect(handoff.provider).toBe("mock");
  const successorId = z.string().parse(handoff.agentId);
  expect(successorId).not.toBe(sourceId);

  const labels = daemon.daemon.agentManager.getAgent(successorId)?.labels ?? {};
  expect(getHandoffFromAgentIdFromLabels(labels)).toBe(sourceId);
  expect(getHandoffObjectiveFromLabels(labels)).toBe(OBJECTIVE);
  expect(getHandoffDepthFromLabels(labels)).toBe(1);
}, 120_000);

test("handoff_agent applies an explicit target", async () => {
  const created = readStructured(
    await mcp.callTool({
      name: "create_agent",
      args: {
        relationship: { kind: "detached" },
        workspace: { kind: "create", source: { kind: "directory", path: workspaceCwd } },
        provider: "mock/gpt-5.4-mini",
        title: "Upload retry",
        initialPrompt: OBJECTIVE,
        background: true,
      },
    }),
  );
  const sourceId = z.string().parse(created.agentId);

  const handoff = readStructured(
    await mcp.callTool({
      name: "handoff_agent",
      args: { agentId: sourceId, model: "ten-second-stream" },
    }),
  );

  expect(handoff.model).toBe("ten-second-stream");
}, 120_000);
