import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "../agent-sdk-types.js";
import { parseHandoffProviderArg, resolveHandoffTargetConfig } from "./target-config.js";

const SOURCE: AgentSessionConfig = {
  provider: "claude",
  cwd: "/work",
  model: "claude-opus-5",
  modeId: "plan",
  thinkingOptionId: "think-hard",
  featureValues: { webSearch: true },
  title: "Add retry to the upload client",
};

describe("handoff target config", () => {
  test("inherits the whole setup when the provider does not change", () => {
    expect(resolveHandoffTargetConfig({ sourceConfig: SOURCE })).toEqual(SOURCE);
  });

  test("drops provider-specific settings when crossing providers", () => {
    expect(
      resolveHandoffTargetConfig({ sourceConfig: SOURCE, target: { provider: "codex" } }),
    ).toEqual({
      provider: "codex",
      cwd: "/work",
      title: "Add retry to the upload client",
    });
  });

  test("keeps what the caller named explicitly across a provider change", () => {
    expect(
      resolveHandoffTargetConfig({
        sourceConfig: SOURCE,
        target: { provider: "codex", model: "gpt-5.4-codex", modeId: "full-access" },
      }),
    ).toEqual({
      provider: "codex",
      cwd: "/work",
      model: "gpt-5.4-codex",
      modeId: "full-access",
      title: "Add retry to the upload client",
    });
  });

  test("changes only the model when staying on the same provider", () => {
    expect(
      resolveHandoffTargetConfig({ sourceConfig: SOURCE, target: { model: "claude-haiku-4-5" } }),
    ).toEqual({ ...SOURCE, model: "claude-haiku-4-5" });
  });
});

describe("handoff provider argument", () => {
  test("splits the provider/model form the sibling create tool requires", () => {
    expect(parseHandoffProviderArg("codex/gpt-5.4-codex", undefined)).toEqual({
      provider: "codex",
      model: "gpt-5.4-codex",
    });
  });

  test("passes a bare provider through", () => {
    expect(parseHandoffProviderArg("codex", undefined)).toEqual({ provider: "codex" });
  });

  test("lets an explicit model win over one embedded in the provider", () => {
    expect(parseHandoffProviderArg("codex/gpt-5.4-codex", "gpt-5.4-mini")).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  test("names nothing when the caller named nothing", () => {
    expect(parseHandoffProviderArg(undefined, undefined)).toEqual({});
    expect(parseHandoffProviderArg("  ", undefined)).toEqual({});
    expect(parseHandoffProviderArg(undefined, "claude-haiku-4-5")).toEqual({
      model: "claude-haiku-4-5",
    });
  });
});
