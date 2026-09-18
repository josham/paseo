import { describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { extractHandoffTimelineFacts, renderTimelineDigest } from "./timeline-facts.js";

describe("handoff timeline facts", () => {
  test("reads the objective, the latest task list, and where the agent left off", () => {
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "  Add retry to the upload client  " },
      { type: "todo", items: [{ text: "Find the upload client", completed: false }] },
      { type: "assistant_message", text: "Found it in upload/client.ts" },
      {
        type: "todo",
        items: [
          { text: "Find the upload client", completed: true },
          { text: "Add the retry loop", completed: false, status: "in_progress" },
        ],
      },
      { type: "assistant_message", text: "  Wiring the retry loop now  " },
    ];

    expect(extractHandoffTimelineFacts(timeline)).toEqual({
      objective: "Add retry to the upload client",
      tasks: [
        { text: "Find the upload client", completed: true },
        { text: "Add the retry loop", completed: false, status: "in_progress" },
      ],
      recentErrors: [],
      lastAssistantMessage: "Wiring the retry loop now",
    });
  });

  test("returns empty facts for a timeline with nothing to carry", () => {
    expect(extractHandoffTimelineFacts([])).toEqual({
      objective: null,
      tasks: [],
      recentErrors: [],
      lastAssistantMessage: null,
    });
  });

  test("skips blank messages when choosing the objective and the last reply", () => {
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "   " },
      { type: "user_message", text: "Ship the parser fix" },
      { type: "assistant_message", text: "Done" },
      { type: "assistant_message", text: "  " },
    ];

    const facts = extractHandoffTimelineFacts(timeline);

    expect(facts.objective).toBe("Ship the parser fix");
    expect(facts.lastAssistantMessage).toBe("Done");
  });

  test("keeps the most recent errors up to the limit", () => {
    const timeline: AgentTimelineItem[] = [
      { type: "error", message: "first" },
      { type: "error", message: "second" },
      { type: "error", message: "third" },
    ];

    expect(extractHandoffTimelineFacts(timeline, { maxErrors: 2 }).recentErrors).toEqual([
      "second",
      "third",
    ]);
  });
});

describe("handoff timeline digest", () => {
  test("renders the conversation shape without tool output", () => {
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "Add retry to the upload client" },
      { type: "reasoning", text: "thinking about it" },
      {
        type: "tool_call",
        callId: "c1",
        name: "Edit",
        status: "completed",
        error: null,
        detail: { type: "plain_text", text: "a".repeat(5_000) },
      },
      { type: "assistant_message", text: "Added the retry loop" },
      { type: "error", message: "ETIMEDOUT" },
    ];

    expect(renderTimelineDigest(timeline)).toBe(
      `user: Add retry to the upload client
tool: Edit
assistant: Added the retry loop
error: ETIMEDOUT`,
    );
  });

  test("keeps the most recent turns when the conversation is long", () => {
    const timeline: AgentTimelineItem[] = Array.from({ length: 400 }, (_, index) => ({
      type: "assistant_message" as const,
      text: `message ${index}`,
    }));

    const digest = renderTimelineDigest(timeline, { maxChars: 200 });

    expect(digest.length).toBeLessThanOrEqual(200);
    expect(digest).toContain("assistant: message 399");
    expect(digest).not.toContain("assistant: message 0\n");
  });
});
