import { describe, expect, it } from "vitest";
import { workspaceOpenIntentTargetsOtherWorkspace } from "./workspace-open-intent";

describe("workspaceOpenIntentTargetsOtherWorkspace", () => {
  it("rejects an agent the directory places in another workspace", () => {
    expect(
      workspaceOpenIntentTargetsOtherWorkspace({
        intent: { kind: "agent", agentId: "agent-1" },
        workspaceId: "wks_infra",
        agentWorkspaceId: "wks_kruppe",
      }),
    ).toBe(true);
  });

  it("accepts an agent of this workspace", () => {
    expect(
      workspaceOpenIntentTargetsOtherWorkspace({
        intent: { kind: "agent", agentId: "agent-1" },
        workspaceId: "wks_infra",
        agentWorkspaceId: " wks_infra ",
      }),
    ).toBe(false);
  });

  it("accepts an agent the directory does not place yet", () => {
    for (const agentWorkspaceId of [undefined, null, "", "   "]) {
      expect(
        workspaceOpenIntentTargetsOtherWorkspace({
          intent: { kind: "agent", agentId: "agent-1" },
          workspaceId: "wks_infra",
          agentWorkspaceId,
        }),
      ).toBe(false);
    }
  });

  it("rejects a placed agent when the route workspace is unreadable", () => {
    expect(
      workspaceOpenIntentTargetsOtherWorkspace({
        intent: { kind: "agent", agentId: "agent-1" },
        workspaceId: "",
        agentWorkspaceId: "wks_kruppe",
      }),
    ).toBe(true);
  });

  it("leaves intents that carry no agent alone", () => {
    const intents = [
      { kind: "terminal", terminalId: "term-1" },
      { kind: "file", path: "/tmp/a.txt" },
      { kind: "draft", draftId: "draft-1" },
      { kind: "setup", workspaceId: "wks_kruppe" },
    ] as const;
    for (const intent of intents) {
      expect(
        workspaceOpenIntentTargetsOtherWorkspace({
          intent,
          workspaceId: "wks_infra",
          agentWorkspaceId: "wks_kruppe",
        }),
      ).toBe(false);
    }
  });
});
