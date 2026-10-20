import { describe, expect, test } from "vitest";
import {
  buildHandoffLabels,
  getHandoffFromAgentIdFromLabels,
  getHandoffRootAgentIdFromLabels,
  getParentAgentIdFromLabels,
  getHandoffDepthFromLabels,
  getHandoffObjectiveFromLabels,
  HANDOFF_DEPTH_LABEL,
  HANDOFF_FROM_AGENT_ID_LABEL,
  HANDOFF_OBJECTIVE_LABEL,
  HANDOFF_ROOT_AGENT_ID_LABEL,
  getOpenAgentTabLabel,
  hasOpenAgentTab,
  isDelegatedAgent,
  isHandoffAgent,
  isOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
} from "./agent-labels.js";

describe("agent label policy", () => {
  test("treats a non-empty parent agent label as delegation", () => {
    const labels = { [PARENT_AGENT_ID_LABEL]: " parent-agent \n" };

    expect(getParentAgentIdFromLabels(labels)).toBe("parent-agent");
    expect(isDelegatedAgent({ labels })).toBe(true);
  });

  test("ignores missing, empty, and non-string parent agent labels", () => {
    expect(isDelegatedAgent({ labels: {} })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } })).toBe(false);
  });

  test("treats any true client-scoped open-tab label as open", () => {
    const desktopLabel = getOpenAgentTabLabel("desktop-client");
    const mobileLabel = getOpenAgentTabLabel("mobile-client");

    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "true" })).toBe(true);
    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "false" })).toBe(false);
    expect(hasOpenAgentTab({})).toBe(false);
  });

  test("recognizes only client-scoped open-tab labels", () => {
    expect(isOpenAgentTabLabel(getOpenAgentTabLabel("client-a"))).toBe(true);
    expect(isOpenAgentTabLabel("paseo.open-agent-tab")).toBe(false);
    expect(isOpenAgentTabLabel("custom.open-agent-tab.client-a")).toBe(false);
  });
});

describe("handoff label policy", () => {
  test("roots a first handoff at the source agent", () => {
    const labels = buildHandoffLabels({
      sourceAgentId: "agent-1",
      sourceLabels: {},
      objective: "  Add retry  ",
    });

    expect(labels).toEqual({
      [HANDOFF_FROM_AGENT_ID_LABEL]: "agent-1",
      [HANDOFF_ROOT_AGENT_ID_LABEL]: "agent-1",
      [HANDOFF_DEPTH_LABEL]: "1",
      [HANDOFF_OBJECTIVE_LABEL]: "Add retry",
    });
  });

  test("carries the original root, objective, and growing depth through a chain", () => {
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

    expect(second).toEqual({
      [HANDOFF_FROM_AGENT_ID_LABEL]: "agent-2",
      [HANDOFF_ROOT_AGENT_ID_LABEL]: "agent-1",
      [HANDOFF_DEPTH_LABEL]: "2",
      [HANDOFF_OBJECTIVE_LABEL]: "Add retry",
    });
    expect(getHandoffDepthFromLabels(second)).toBe(2);
    expect(getHandoffObjectiveFromLabels(second)).toBe("Add retry");
  });

  test("caps a runaway objective instead of writing it whole into a label", () => {
    const labels = buildHandoffLabels({
      sourceAgentId: "agent-1",
      sourceLabels: {},
      objective: "o".repeat(5_000),
    });

    expect(labels[HANDOFF_OBJECTIVE_LABEL]).toBe("o".repeat(600));
  });

  test("omits the objective label when there is no objective to carry", () => {
    expect(buildHandoffLabels({ sourceAgentId: "agent-1", objective: "   " })).toEqual({
      [HANDOFF_FROM_AGENT_ID_LABEL]: "agent-1",
      [HANDOFF_ROOT_AGENT_ID_LABEL]: "agent-1",
      [HANDOFF_DEPTH_LABEL]: "1",
    });
  });

  test("treats a predecessor without a readable depth as one handoff deep", () => {
    expect(getHandoffDepthFromLabels({})).toBe(0);
    expect(getHandoffDepthFromLabels({ [HANDOFF_FROM_AGENT_ID_LABEL]: "agent-1" })).toBe(1);
    expect(
      getHandoffDepthFromLabels({
        [HANDOFF_FROM_AGENT_ID_LABEL]: "agent-1",
        [HANDOFF_DEPTH_LABEL]: "not a number",
      }),
    ).toBe(1);
    expect(getHandoffObjectiveFromLabels({ [HANDOFF_OBJECTIVE_LABEL]: "  " })).toBe(null);
  });

  test("reads back trimmed handoff ids and recognizes a handoff agent", () => {
    const labels = {
      [HANDOFF_FROM_AGENT_ID_LABEL]: " agent-2 \n",
      [HANDOFF_ROOT_AGENT_ID_LABEL]: " agent-1 ",
    };

    expect(getHandoffFromAgentIdFromLabels(labels)).toBe("agent-2");
    expect(getHandoffRootAgentIdFromLabels(labels)).toBe("agent-1");
    expect(isHandoffAgent({ labels })).toBe(true);
  });

  test("ignores missing, empty, and non-string handoff labels", () => {
    expect(getHandoffFromAgentIdFromLabels({})).toBe(null);
    expect(getHandoffRootAgentIdFromLabels({ [HANDOFF_ROOT_AGENT_ID_LABEL]: "  " })).toBe(null);
    expect(getHandoffFromAgentIdFromLabels({ [HANDOFF_FROM_AGENT_ID_LABEL]: 42 })).toBe(null);
    expect(isHandoffAgent({ labels: { [HANDOFF_FROM_AGENT_ID_LABEL]: "" } })).toBe(false);
    expect(isHandoffAgent({ labels: null })).toBe(false);
  });

  test("keeps handoff lineage independent of subagent delegation", () => {
    const labels = buildHandoffLabels({ sourceAgentId: "agent-1", sourceLabels: {} });

    expect(isDelegatedAgent({ labels })).toBe(false);
    expect(getParentAgentIdFromLabels(labels)).toBe(null);
  });
});
