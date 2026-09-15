import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getHandoffDepthFromLabels,
  getHandoffFromAgentIdFromLabels,
  getHandoffObjectiveFromLabels,
  getHandoffRootAgentIdFromLabels,
} from "@getpaseo/protocol/agent-labels";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { SummarizableMockAgentClient } from "../test-utils/summarizable-mock-agent.js";

const OBJECTIVE = "Add retry to the upload client";
const TURN_TIMEOUT_MS = 30_000;

// Only the mock provider is reachable, so agent turns and the brief's summarizer
// both settle immediately instead of waiting on a real model.
const MOCK_ONLY = {
  isDev: true,
  agentClients: {
    mock: new SummarizableMockAgentClient(),
    "mock-alt": new SummarizableMockAgentClient(),
  },
  providerOverrides: {
    "mock-alt": { extends: "mock", label: "Mock Alt", enabled: true },
    claude: { enabled: false },
    codex: { enabled: false },
    copilot: { enabled: false },
    opencode: { enabled: false },
    pi: { enabled: false },
    omp: { enabled: false },
    "mock-slow": { enabled: false },
  },
};

describe("agent handoff", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext(MOCK_ONLY);
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60_000);

  async function createSourceAgent(prompt: string) {
    const agent = await ctx.client.createAgent({
      provider: "mock",
      cwd: "/tmp",
      initialPrompt: prompt,
      featureValues: { mockAssistantResponse: "Added the retry loop" },
    });
    await ctx.client.waitForFinish(agent.id, TURN_TIMEOUT_MS);
    return agent;
  }

  async function countUserMessages(agentId: string): Promise<number> {
    const timeline = await ctx.client.fetchAgentTimeline(agentId, { limit: 200 });
    return timeline.entries.filter((entry) => entry.item.type === "user_message").length;
  }

  /**
   * Agent creation returns before the initial prompt is dispatched, so the first
   * message lands slightly after the handoff resolves. Poll rather than racing it.
   */
  async function readFirstUserMessage(agentId: string): Promise<string> {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    for (;;) {
      const timeline = await ctx.client.fetchAgentTimeline(agentId, { limit: 50 });
      const first = timeline.entries.find((entry) => entry.item.type === "user_message")?.item;
      if (first?.type === "user_message") {
        return first.text;
      }
      if (Date.now() > deadline) {
        throw new Error(`Agent ${agentId} has no user message`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  test("creates a successor carrying the brief and leaves the source running", async () => {
    const source = await createSourceAgent(OBJECTIVE);

    const handoff = await ctx.client.createAgentHandoff(source.id);

    expect(handoff.error).toBe(null);
    expect(handoff.sourceAgentId).toBe(source.id);
    expect(handoff.rootAgentId).toBe(source.id);
    expect(handoff.chainDepth).toBe(0);
    expect(handoff.agentId).not.toBe(source.id);

    const successorId = handoff.agentId!;
    const successor = await ctx.client.fetchAgent(successorId);
    expect(successor?.agent.provider).toBe("mock");
    expect(successor?.agent.cwd).toBe("/tmp");

    const labels = successor?.agent.labels ?? {};
    expect(getHandoffFromAgentIdFromLabels(labels)).toBe(source.id);
    expect(getHandoffRootAgentIdFromLabels(labels)).toBe(source.id);
    expect(getHandoffDepthFromLabels(labels)).toBe(1);
    expect(getHandoffObjectiveFromLabels(labels)).toBe(OBJECTIVE);

    const brief = await readFirstUserMessage(successorId);
    expect(brief).toContain(`## Objective\n\n${OBJECTIVE}`);
    expect(brief).toContain("Continued from an earlier mock");
    // The mock summarizer answers the narrative prompt, so the DECLARED section lands.
    expect(brief).toContain("## Notes from the previous agent (DECLARED)");
    expect(brief).toContain("Next step: Mock next step");

    // The source is the only way back if the brief turns out thin, so it stays.
    const stillThere = await ctx.client.fetchAgent(source.id);
    expect(stillThere?.agent.id).toBe(source.id);
    expect(stillThere?.agent.archivedAt ?? null).toBe(null);
  }, 90_000);

  test("keeps the original objective verbatim across a chain of handoffs", async () => {
    const source = await createSourceAgent(OBJECTIVE);

    const first = await ctx.client.createAgentHandoff(source.id);
    const firstId = first.agentId!;
    await ctx.client.waitForFinish(firstId, TURN_TIMEOUT_MS);

    const second = await ctx.client.createAgentHandoff(firstId);

    expect(second.error).toBe(null);
    expect(second.rootAgentId).toBe(source.id);
    expect(second.chainDepth).toBe(1);

    const secondId = second.agentId!;
    const labels = (await ctx.client.fetchAgent(secondId))?.agent.labels ?? {};
    expect(getHandoffFromAgentIdFromLabels(labels)).toBe(firstId);
    expect(getHandoffRootAgentIdFromLabels(labels)).toBe(source.id);
    expect(getHandoffDepthFromLabels(labels)).toBe(2);

    // The point of carrying the objective on a label: two summarizations later it
    // is still the user's words, not a summary of a summary.
    expect(getHandoffObjectiveFromLabels(labels)).toBe(OBJECTIVE);

    const brief = await readFirstUserMessage(secondId);
    expect(brief).toContain(`## Objective\n\n${OBJECTIVE}`);
    expect(brief).toContain("This is handoff 2 of a chain.");
  }, 120_000);

  test("drops provider-specific settings when the handoff crosses providers", async () => {
    const source = await ctx.client.createAgent({
      provider: "mock",
      cwd: "/tmp",
      model: "ten-second-stream",
      initialPrompt: OBJECTIVE,
      featureValues: { mockAssistantResponse: "Added the retry loop" },
    });
    await ctx.client.waitForFinish(source.id, TURN_TIMEOUT_MS);

    const handoff = await ctx.client.createAgentHandoff(source.id, {
      target: { provider: "mock-alt" },
    });

    expect(handoff.error).toBe(null);
    const successor = await ctx.client.fetchAgent(handoff.agentId!);
    expect(successor?.agent.provider).toBe("mock-alt");
    // The source's model is a mock id the target provider need not honor, so it
    // is dropped and the target's own default applies instead.
    expect(successor?.agent.model).toBe("gpt-5.4-mini");

    const brief = await readFirstUserMessage(handoff.agentId!);
    expect(brief).toContain("Handed off from mock");
    expect(brief).toContain("to mock-alt");
  }, 90_000);

  test("asks the source agent for the notes only when the caller opts in", async () => {
    const source = await ctx.client.createAgent({
      provider: "mock",
      cwd: "/tmp",
      initialPrompt: OBJECTIVE,
      featureValues: {
        mockAssistantResponse: JSON.stringify({
          decisions: ["Retry lives above the registry client"],
          gotchas: [],
          nextStep: "Add a test",
        }),
      },
    });
    await ctx.client.waitForFinish(source.id, TURN_TIMEOUT_MS);
    const turnsBefore = await countUserMessages(source.id);

    const handoff = await ctx.client.createAgentHandoff(source.id, { askSourceAgent: "always" });

    // The source answered, so its own account wins over the summarizer's.
    const brief = await readFirstUserMessage(handoff.agentId!);
    expect(brief).toContain("Decisions:\n- Retry lives above the registry client");
    expect(brief).not.toContain("Mock next step");
    // Asking costs the source a turn, which is why it is opt-in.
    expect(await countUserMessages(source.id)).toBe(turnsBefore + 1);
  }, 120_000);

  test("leaves the source untouched when the caller does not opt in", async () => {
    const source = await createSourceAgent(OBJECTIVE);
    const turnsBefore = await countUserMessages(source.id);

    const handoff = await ctx.client.createAgentHandoff(source.id);

    const brief = await readFirstUserMessage(handoff.agentId!);
    expect(brief).toContain("Next step: Mock next step");
    expect(await countUserMessages(source.id)).toBe(turnsBefore);
  }, 90_000);

  test("applies an explicit target and reports a failed handoff", async () => {
    const source = await createSourceAgent(OBJECTIVE);

    const handoff = await ctx.client.createAgentHandoff(source.id, {
      target: { model: "ten-second-stream" },
    });

    const successor = await ctx.client.fetchAgent(handoff.agentId!);
    expect(successor?.agent.model).toBe("ten-second-stream");

    await expect(ctx.client.createAgentHandoff("agent_does_not_exist")).rejects.toThrow();
  }, 90_000);
});
