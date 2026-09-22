import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openNewWorkspaceComposer } from "../support/helpers/new-workspace";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// The Execution environment picker is the only place a workspace can be put in a
// container, so it has to appear for a project that has a devcontainer.json and
// stay away from one that does not. Everything below the picker — starting the
// container, running agents and terminals in it — is covered against real docker
// in packages/server/src/server/container-management.test.ts; this covers the
// surface that decides whether any of that is reachable.

const DEVCONTAINER_FILE = {
  path: ".devcontainer.json",
  content: JSON.stringify({ image: "mcr.microsoft.com/devcontainers/base:ubuntu" }),
};

async function openComposerForSeededProject(
  page: import("@playwright/test").Page,
  seeded: SeededWorkspace,
): Promise<void> {
  await seedSavedSettingsHosts(page, [
    {
      serverId: getServerId(),
      label: "localhost",
      endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    },
  ]);
  await gotoAppShell(page);
  await waitForSidebarHydration(page);
  await openNewWorkspaceComposer(page, {
    projectKey: seeded.projectKey,
    projectDisplayName: seeded.projectDisplayName,
  });
}

test.describe("New workspace container backend", () => {
  test.describe.configure({ timeout: 240_000 });

  test("offers Dev Container for a project that has a devcontainer.json", async ({ page }) => {
    const seeded: SeededWorkspace = await seedWorkspace({
      repoPrefix: "container-backend-",
      repo: { files: [DEVCONTAINER_FILE] },
    });

    try {
      await openComposerForSeededProject(page, seeded);

      const trigger = page.getByTestId("workspace-create-container-backend-trigger");
      await expect(trigger).toBeVisible({ timeout: 30_000 });
      // Host is the default: a workspace is never silently containerised.
      await expect(trigger).toContainText("Host");

      // The option list renders labels, not the selector's option testIDs, so
      // match what the user actually reads.
      await trigger.click();
      const devContainerOption = page.getByText("Dev Container", { exact: true });
      await expect(devContainerOption).toBeVisible({ timeout: 30_000 });

      // Selecting it has to stick, or the workspace would be created on the host.
      await devContainerOption.click();
      await expect(trigger).toContainText("Dev Container");
    } finally {
      await seeded.cleanup();
    }
  });

  test("hides the picker for a project with no devcontainer.json", async ({ page }) => {
    const seeded: SeededWorkspace = await seedWorkspace({ repoPrefix: "no-container-backend-" });

    try {
      await openComposerForSeededProject(page, seeded);

      // The project picker proves the screen is up, so a missing backend
      // trigger means "not offered" rather than "not rendered yet".
      await expect(page.getByTestId("new-workspace-project-picker-trigger")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("workspace-create-container-backend-trigger")).toHaveCount(0);
    } finally {
      await seeded.cleanup();
    }
  });
});
