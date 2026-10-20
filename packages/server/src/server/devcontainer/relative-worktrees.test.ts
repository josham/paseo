import { describe, expect, it } from "vitest";
import {
  parseGitVersion,
  readConfigurationKeepsHostPath,
  versionSupportsRelativeWorktrees,
} from "./relative-worktrees.js";

describe("relative worktree support", () => {
  it("reads a git version string", () => {
    expect(parseGitVersion("git version 2.48.1\n")).toEqual({ major: 2, minor: 48 });
    expect(parseGitVersion("git version 2.39.5 (Apple Git-154)")).toEqual({ major: 2, minor: 39 });
    expect(parseGitVersion("not git at all")).toBeNull();
  });

  it("draws the line at 2.48, where relative worktrees arrived", () => {
    // Below the line the repository extension is unreadable, so the worktree
    // has to be created the ordinary way instead.
    expect(versionSupportsRelativeWorktrees("git version 2.47.9")).toBe(false);
    expect(versionSupportsRelativeWorktrees("git version 2.48.0")).toBe(true);
    expect(versionSupportsRelativeWorktrees("git version 2.55.0")).toBe(true);
    expect(versionSupportsRelativeWorktrees("git version 3.0.0")).toBe(true);
  });

  it("treats an unreadable answer as unsupported", () => {
    // An image with no git at all, or one whose output we cannot parse, must
    // not be assumed capable: the cost of guessing wrong lands on the user's
    // repository, not on Paseo.
    expect(versionSupportsRelativeWorktrees("")).toBe(false);
    expect(versionSupportsRelativeWorktrees("git: not found")).toBe(false);
  });
});

/**
 * Payloads as `devcontainer read-configuration` 0.87 prints them, one JSON
 * object on stdout. The shapes are what the four kinds of config produce for
 * the same host folder.
 */
describe("reading the container's workspace path", () => {
  const HOST = "/home/dev/workspace/repo";

  function output(workspace: Record<string, string>): string {
    return `${JSON.stringify({ configuration: { name: "repo" }, workspace })}\n`;
  }

  it("keeps the host path when a compose project names it", () => {
    // What `"workspaceFolder": "${localWorkspaceFolder}"` resolves to. Compose
    // owns the mount, so the CLI reports none and the folder is the answer.
    expect(readConfigurationKeepsHostPath(output({ workspaceFolder: HOST }), HOST)).toBe(true);
  });

  it("does not keep it when the container works somewhere else", () => {
    expect(
      readConfigurationKeepsHostPath(output({ workspaceFolder: "/workspaces/repo" }), HOST),
    ).toBe(false);
  });

  it("does not keep it when the folder matches but the files land elsewhere", () => {
    // An image config asking only for ${localWorkspaceFolder} gets exactly
    // this: the host path to work in, and the default mount under /workspaces.
    // Absolute worktree links would dangle, so it needs the relative form.
    expect(
      readConfigurationKeepsHostPath(
        output({
          workspaceFolder: HOST,
          workspaceMount: `type=bind,source=${HOST},target=/workspaces/repo`,
        }),
        HOST,
      ),
    ).toBe(false);
  });

  it("keeps it when the mount is declared at the host path", () => {
    // Only a config that mounts the workspace itself can land here — and such
    // a config never gets the CLI's own git mount either, so the relative form
    // would have marked the repository for nothing.
    expect(
      readConfigurationKeepsHostPath(
        output({
          workspaceFolder: HOST,
          workspaceMount: `source=${HOST},target=${HOST},type=bind`,
        }),
        HOST,
      ),
    ).toBe(true);
  });

  it("ignores a trailing separator on either side", () => {
    expect(readConfigurationKeepsHostPath(output({ workspaceFolder: `${HOST}/` }), HOST)).toBe(
      true,
    );
  });

  it("treats an unreadable answer as a remapped path", () => {
    // Relative links work in either container; skipping them does not. So
    // nothing here — a CLI that printed no JSON, a result with no folder in it
    // — may be read as permission to leave the worktree absolute.
    expect(readConfigurationKeepsHostPath("", HOST)).toBe(false);
    expect(readConfigurationKeepsHostPath("Trace: resolving config\n", HOST)).toBe(false);
    expect(readConfigurationKeepsHostPath(output({}), HOST)).toBe(false);
  });
});
