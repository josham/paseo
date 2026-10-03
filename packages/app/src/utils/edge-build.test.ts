import { describe, expect, it } from "vitest";
import { parseEdgeBuildVersion } from "@/utils/edge-build";

describe("parseEdgeBuildVersion", () => {
  it("reports the version the release workflow stamped in", () => {
    expect(parseEdgeBuildVersion("1.1.0")).toBe("1.1.0");
  });

  it("reports no Edge build when the placeholder was never stamped", () => {
    expect(parseEdgeBuildVersion("dev")).toBeNull();
  });

  it("reports no Edge build when the stamp is empty", () => {
    expect(parseEdgeBuildVersion("   ")).toBeNull();
    expect(parseEdgeBuildVersion(null)).toBeNull();
  });
});
