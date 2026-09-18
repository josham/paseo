import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { openFileExplorer } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { resolveTempRoot } from "../support/helpers/workspace";

let workspace: SeededWorkspace;
let outsideRoot: string;

test.beforeAll(async () => {
  workspace = await seedWorkspace({
    repoPrefix: "file-explorer-symlinks-",
    repo: { files: [{ path: "packages/index.ts", content: "export {};\n" }] },
  });

  const root = workspace.repoPath;
  outsideRoot = await mkdtemp(path.join(await resolveTempRoot(), "explorer-symlink-outside-"));
  await mkdir(path.join(outsideRoot, "secrets"));
  await writeFile(path.join(outsideRoot, "secret.txt"), "top secret\n", "utf-8");

  await writeFile(path.join(root, "real.txt"), "real\n", "utf-8");
  // The four cases the explorer has to tell apart.
  await symlink("packages", path.join(root, "packages-link"), "dir");
  await symlink("real.txt", path.join(root, "real-link.txt"));
  await symlink(path.join(outsideRoot, "secret.txt"), path.join(root, "outside-link.txt"));
  await symlink("nowhere.txt", path.join(root, "dangling-link.txt"));
});

test.afterAll(async () => {
  await workspace?.cleanup();
});

test.describe("File explorer symlinks", () => {
  test("opens symlinked directories and marks links the boundary will not follow", async ({
    page,
  }, testInfo) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);

    const tree = page.getByTestId("file-explorer-tree-scroll");

    // Every link is listed, including the two that cannot be opened.
    for (const name of [
      "packages-link",
      "real-link.txt",
      "outside-link.txt",
      "dangling-link.txt",
    ]) {
      await expect(tree.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    }

    // The blocked pair carry their reason.
    await expect(tree.getByText("outside workspace", { exact: true }).first()).toBeVisible();
    await expect(tree.getByText("missing target", { exact: true }).first()).toBeVisible();

    await testInfo.attach("symlink-rows", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // A symlinked directory expands, which is the bug this fixes.
    await tree.getByText("packages-link", { exact: true }).first().click();
    await expect(tree.getByText("index.ts", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });

    await testInfo.attach("symlink-dir-expanded", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});
