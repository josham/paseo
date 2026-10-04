import { describe, expect, test } from "vitest";
import { buildHandoffLabels } from "@getpaseo/protocol/agent-labels";

import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { resolveHandoffLineage } from "./lineage.js";

const ORIGINAL: AgentTimelineItem[] = [{ type: "user_message", text: "Add retry" }];
const BRIEF: AgentTimelineItem[] = [
  { type: "user_message", text: "# Handoff brief\n\nYou are picking up work" },
];

describe("handoff lineage", () => {
  test("starts a chain at an agent that was never handed off", () => {
    expect(
      resolveHandoffLineage({
        sourceAgentId: "agent-1",
        sourceLabels: {},
        sourceTimeline: ORIGINAL,
      }),
    ).toEqual({ depth: 0, rootAgentId: "agent-1", rootObjective: "Add retry" });
  });

  test("reads the original request off the label instead of the summarized one", () => {
    const labels = buildHandoffLabels({
      sourceAgentId: "agent-1",
      sourceLabels: {},
      objective: "Add retry",
    });

    expect(
      resolveHandoffLineage({
        sourceAgentId: "agent-2",
        sourceLabels: labels,
        sourceTimeline: BRIEF,
      }),
    ).toEqual({ depth: 1, rootAgentId: "agent-1", rootObjective: "Add retry" });
  });

  test("keeps the root and the objective steady as the chain grows", () => {
    const first = buildHandoffLabels({
      sourceAgentId: "agent-1",
      sourceLabels: {},
      objective: "Add retry",
    });
    const second = buildHandoffLabels({
      sourceAgentId: "agent-2",
      sourceLabels: first,
      objective: "Add retry",
    });

    expect(
      resolveHandoffLineage({
        sourceAgentId: "agent-3",
        sourceLabels: second,
        sourceTimeline: BRIEF,
      }),
    ).toEqual({ depth: 2, rootAgentId: "agent-1", rootObjective: "Add retry" });
  });

  test("falls back to the source's own opening message when no objective was carried", () => {
    expect(
      resolveHandoffLineage({
        sourceAgentId: "agent-2",
        sourceLabels: { "paseo.handoff-from-agent-id": "agent-1" },
        sourceTimeline: [{ type: "user_message", text: "Keep going" }],
      }),
    ).toEqual({ depth: 1, rootAgentId: "agent-2", rootObjective: "Keep going" });
  });
});
