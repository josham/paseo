import { describe, expect, it } from "vitest";
import { explorerEntryCapabilities } from "./entry-availability";
import type { ExplorerEntry } from "@/stores/session-store";

function entry(overrides: Partial<ExplorerEntry> = {}): ExplorerEntry {
  return {
    name: "file.txt",
    path: "file.txt",
    kind: "file",
    size: 10,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("explorerEntryCapabilities", () => {
  it("allows everything on an ordinary entry", () => {
    expect(explorerEntryCapabilities(entry())).toEqual({
      canOpen: true,
      canAccessTarget: true,
      canEditInPlace: true,
    });
  });

  it("allows everything on a symlink the daemon followed", () => {
    expect(explorerEntryCapabilities(entry({ isSymlink: true, kind: "directory" }))).toEqual({
      canOpen: true,
      canAccessTarget: true,
      canEditInPlace: true,
    });
  });

  it("withholds target access but permits removing a broken link", () => {
    expect(
      explorerEntryCapabilities(entry({ isSymlink: true, unavailable: "broken-link" })),
    ).toEqual({ canOpen: false, canAccessTarget: false, canEditInPlace: true });
  });

  it("withholds every action on a link resolving outside the workspace", () => {
    expect(
      explorerEntryCapabilities(entry({ isSymlink: true, unavailable: "outside-workspace" })),
    ).toEqual({ canOpen: false, canAccessTarget: false, canEditInPlace: false });
  });
});
