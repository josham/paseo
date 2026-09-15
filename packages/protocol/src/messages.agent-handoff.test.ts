import { describe, expect, test } from "vitest";

import {
  AgentCreateHandoffRequestMessageSchema,
  AgentCreateHandoffResponseMessageSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("agent handoff messages", () => {
  test("accepts a request that names no target, meaning inherit everything", () => {
    const message = {
      type: "agent.create_handoff.request",
      agentId: "agent-1",
      requestId: "req-1",
    };

    expect(AgentCreateHandoffRequestMessageSchema.parse(message)).toEqual(message);
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  test("accepts a request that names a full target profile", () => {
    const message = {
      type: "agent.create_handoff.request",
      agentId: "agent-1",
      target: {
        provider: "codex",
        model: "gpt-5.4-codex",
        modeId: "full-access",
        thinkingOptionId: "high",
        featureValues: { webSearch: true },
      },
      requestId: "req-1",
    };

    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  test("carries the successor and its lineage back on success", () => {
    const message = {
      type: "agent.create_handoff.response",
      payload: {
        requestId: "req-1",
        sourceAgentId: "agent-1",
        agentId: "agent-2",
        rootAgentId: "agent-1",
        chainDepth: 0,
        error: null,
      },
    };

    expect(AgentCreateHandoffResponseMessageSchema.parse(message)).toEqual(message);
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  test("carries the error and no successor on failure", () => {
    const message = {
      type: "agent.create_handoff.response",
      payload: {
        requestId: "req-1",
        sourceAgentId: "agent-1",
        agentId: null,
        rootAgentId: null,
        chainDepth: null,
        error: "Agent agent-1 not found",
      },
    };

    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });
});
