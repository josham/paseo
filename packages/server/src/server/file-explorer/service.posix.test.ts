// POSIX-only: symlink fixtures
/* eslint-disable max-nested-callbacks */
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDownloadableFileInfo, listDirectoryEntries, readExplorerFile } from "./service.js";
import { isPlatform } from "../../test-utils/platform.js";

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe.skipIf(isPlatform("win32"))("service POSIX-only", () => {
  it("lists a dangling symlink as an unopenable entry", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      await mkdir(path.join(root, "packages", "server"), { recursive: true });
      const serverDir = path.join(root, "packages", "server");
      await writeFile(path.join(serverDir, "README.md"), "# server\n", "utf-8");
      await symlink("CLAUDE.md", path.join(serverDir, "AGENTS.md"));

      const result = await listDirectoryEntries({
        root,
        relativePath: "packages/server",
      });

      expect(result.path).toBe("packages/server");
      const names = result.entries.map((entry) => entry.name);
      expect(names).toContain("README.md");
      const dangling = result.entries.find((entry) => entry.name === "AGENTS.md");
      expect(dangling).toMatchObject({ isSymlink: true, unavailable: "broken-link", size: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked files that resolve outside the workspace", async () => {
    const root = await createTempDir("paseo-file-explorer-");
    const outsideRoot = await createTempDir("paseo-file-explorer-outside-");

    try {
      const externalFile = path.join(outsideRoot, "secret.txt");
      await writeFile(externalFile, "top secret\n", "utf-8");
      await symlink(externalFile, path.join(root, "secret-link.txt"));

      await expect(
        readExplorerFile({
          root,
          relativePath: "secret-link.txt",
        }),
      ).rejects.toThrow("Access outside of workspace is not allowed");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("lists symlink entries that resolve outside the workspace as unopenable", async () => {
    const root = await createTempDir("paseo-file-explorer-");
    const outsideRoot = await createTempDir("paseo-file-explorer-outside-");

    try {
      await writeFile(path.join(root, "visible.txt"), "visible\n", "utf-8");
      const externalFile = path.join(outsideRoot, "secret.txt");
      await writeFile(externalFile, "top secret\n", "utf-8");
      await symlink(externalFile, path.join(root, "secret-link.txt"));

      const result = await listDirectoryEntries({ root });

      const names = result.entries.map((entry) => entry.name);
      expect(names).toContain("visible.txt");
      const blocked = result.entries.find((entry) => entry.name === "secret-link.txt");
      // The name is already inside the workspace, but nothing about the target
      // may cross the boundary: no size, and reading it still throws.
      expect(blocked).toMatchObject({ isSymlink: true, unavailable: "outside-workspace", size: 0 });
      await expect(readExplorerFile({ root, relativePath: "secret-link.txt" })).rejects.toThrow(
        "Access outside of workspace is not allowed",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("lists a symlinked directory inside the workspace as a directory", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      await mkdir(path.join(root, "packages"));
      await writeFile(path.join(root, "packages", "index.ts"), "export {};\n", "utf-8");
      await symlink("packages", path.join(root, "packages-link"), "dir");

      const result = await listDirectoryEntries({ root });

      const link = result.entries.find((entry) => entry.name === "packages-link");
      expect(link).toMatchObject({ kind: "directory", isSymlink: true });
      expect(link?.unavailable).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("navigates into a symlinked directory using the link's path", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      await mkdir(path.join(root, "packages"));
      await writeFile(path.join(root, "packages", "index.ts"), "export {};\n", "utf-8");
      await symlink("packages", path.join(root, "packages-link"), "dir");

      const result = await listDirectoryEntries({ root, relativePath: "packages-link" });

      expect(result.path).toBe("packages-link");
      expect(result.entries.map((entry) => entry.path)).toEqual(["packages-link/index.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks an in-workspace file symlink without making it unavailable", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      await writeFile(path.join(root, "real.txt"), "real\n", "utf-8");
      await symlink("real.txt", path.join(root, "real-link.txt"));

      const result = await listDirectoryEntries({ root });

      expect(result.entries.find((entry) => entry.name === "real.txt")?.isSymlink).toBeUndefined();
      expect(result.entries.find((entry) => entry.name === "real-link.txt")).toMatchObject({
        kind: "file",
        isSymlink: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists a symlink that resolves outside the workspace as a directory-free placeholder", async () => {
    const root = await createTempDir("paseo-file-explorer-");
    const outsideRoot = await createTempDir("paseo-file-explorer-outside-");

    try {
      await mkdir(path.join(outsideRoot, "secrets"));
      await symlink(path.join(outsideRoot, "secrets"), path.join(root, "secrets-link"), "dir");

      const result = await listDirectoryEntries({ root });

      // Reported as a file even though the target is a directory: calling it a
      // directory would invite the client to try to expand it.
      expect(result.entries.find((entry) => entry.name === "secrets-link")).toMatchObject({
        kind: "file",
        isSymlink: true,
        unavailable: "outside-workspace",
      });
      await expect(listDirectoryEntries({ root, relativePath: "secrets-link" })).rejects.toThrow(
        "Access outside of workspace is not allowed",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("uses canonical paths for downloadable symlink targets inside the workspace", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      const target = path.join(root, "safe.txt");
      const link = path.join(root, "safe-link.txt");
      await writeFile(target, "safe\n", "utf-8");
      await symlink("safe.txt", link);

      const file = await readExplorerFile({
        root,
        relativePath: "safe-link.txt",
      });
      const info = await getDownloadableFileInfo({
        root,
        relativePath: "safe-link.txt",
      });

      expect(file.path).toBe("safe-link.txt");
      expect(file.content).toBe("safe\n");
      expect(info.path).toBe("safe-link.txt");
      expect(info.fileName).toBe("safe-link.txt");
      expect(info.absolutePath).toBe(await realpath(target));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
