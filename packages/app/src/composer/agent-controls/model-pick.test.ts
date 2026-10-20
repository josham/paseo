import { describe, expect, it } from "vitest";
import { pickDesktopModel, pickSheetModel } from "./model-pick";

function recorder() {
  const calls: Array<[string, ...string[]]> = [];
  return {
    calls,
    onSelectProviderAndModel: (provider: string, modelId: string) =>
      calls.push(["selectProviderAndModel", provider, modelId]),
    onHandoffToProviderAndModel: (provider: string, modelId: string) =>
      calls.push(["handoff", provider, modelId]),
    onSelectProvider: (provider: string) => calls.push(["selectProvider", provider]),
    onSelectModel: (modelId: string) => calls.push(["selectModel", modelId]),
  };
}

describe.each([
  ["sheet", pickSheetModel],
  ["desktop", pickDesktopModel],
])("%s model pick", (_name, pick) => {
  it("changes the model in place when the provider does not change", () => {
    const r = recorder();
    pick({
      nextProviderId: "claude",
      modelId: "claude-haiku-4-5",
      currentProvider: "claude",
      onHandoffToProviderAndModel: r.onHandoffToProviderAndModel,
      onSelectProvider: r.onSelectProvider,
      onSelectModel: r.onSelectModel,
    });

    expect(r.calls).toEqual([["selectModel", "claude-haiku-4-5"]]);
  });

  it("hands off rather than switching a live agent to another provider", () => {
    const r = recorder();
    pick({
      nextProviderId: "codex",
      modelId: "gpt-5.4-codex",
      currentProvider: "claude",
      onHandoffToProviderAndModel: r.onHandoffToProviderAndModel,
      onSelectProvider: r.onSelectProvider,
      onSelectModel: r.onSelectModel,
    });

    expect(r.calls).toEqual([["handoff", "codex", "gpt-5.4-codex"]]);
  });

  it("keeps a draft's in-place switch when the draft supplies one", () => {
    const r = recorder();
    pick({
      nextProviderId: "codex",
      modelId: "gpt-5.4-codex",
      currentProvider: "claude",
      onSelectProviderAndModel: r.onSelectProviderAndModel,
      onHandoffToProviderAndModel: r.onHandoffToProviderAndModel,
      onSelectModel: r.onSelectModel,
    });

    expect(r.calls).toEqual([["selectProviderAndModel", "codex", "gpt-5.4-codex"]]);
  });
});

describe("sheet model pick without handoff", () => {
  it("still switches provider then model when no handoff is offered", () => {
    const r = recorder();
    pickSheetModel({
      nextProviderId: "codex",
      modelId: "gpt-5.4-codex",
      currentProvider: "claude",
      onSelectProvider: r.onSelectProvider,
      onSelectModel: r.onSelectModel,
    });

    expect(r.calls).toEqual([
      ["selectProvider", "codex"],
      ["selectModel", "gpt-5.4-codex"],
    ]);
  });
});

describe("desktop model pick without handoff", () => {
  it("does nothing for another provider's model", () => {
    const r = recorder();
    pickDesktopModel({
      nextProviderId: "codex",
      modelId: "gpt-5.4-codex",
      currentProvider: "claude",
      onSelectModel: r.onSelectModel,
    });

    expect(r.calls).toEqual([]);
  });
});
