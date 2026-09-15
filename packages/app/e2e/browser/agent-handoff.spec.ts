import path from "node:path";
import { test, expect, type Page } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import {
  closeModelPicker,
  expectModelSearchResult,
  openModelPicker,
  profilePickerRow,
  searchAllModels,
  seedAgentProfiles,
} from "../support/helpers/agent-profiles";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";

const OBJECTIVE = "Add retry to the upload client";
const ECHO_ACP_FIXTURE = path.resolve(__dirname, "../support/fixtures/echo-acp.cjs");

async function countSuccessorsOnAltProvider(session: MockAgentWorkspace): Promise<number> {
  const agents = await session.client.fetchAgents();
  const successors = agents.entries.filter(
    (entry) => entry.agent.id !== session.agentId && entry.agent.provider === ALT_PROVIDER,
  );
  return successors.length;
}

function firstUserMessage(page: Page) {
  return page.getByTestId("user-message").first();
}

/**
 * Opens the picker and steps back to the all-providers root.
 *
 * With a provider and model already selected and no profiles seeded, the picker
 * opens scoped to the agent's own provider; cross-provider search lives on the
 * root. The Back control only exists when more than one provider is offered, so
 * reaching root also proves a live agent is no longer pinned to one.
 */
async function openAllProvidersView(page: Page): Promise<void> {
  await openModelPicker(page);
  await page.getByRole("button", { name: "Back", exact: true }).click();
}

const ALT_PROVIDER = "echo-acp";
const ALT_LABEL = "Echo ACP";
const ALT_MODEL = "echo-model";

// A second launchable provider, so a handoff has somewhere to go. The mock
// provider cannot be extended from config — it is registered in code, not in the
// manifest — so this is an ACP stub that can hold a session and answer a prompt.
test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        omp: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        [ALT_PROVIDER]: {
          extends: "acp",
          label: ALT_LABEL,
          enabled: true,
          command: [process.execPath, ECHO_ACP_FIXTURE],
          models: [{ id: ALT_MODEL, label: "Echo model", isDefault: true }],
        },
      },
    },
  },
});

test.describe("Agent handoff", () => {
  test.describe.configure({ timeout: 180_000 });

  test("a live agent's model picker hands the work to another provider", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "agent-handoff-",
      title: "Upload retry",
      initialPrompt: OBJECTIVE,
    });

    try {
      await test.step("open the live agent's composer", async () => {
        await openAgentRoute(page, session);
        await expectComposerVisible(page);
      });

      await test.step("the picker now reaches a provider the agent is not running", async () => {
        await openAllProvidersView(page);
        await searchAllModels(page, "echo model");
        await expectModelSearchResult(page, {
          provider: ALT_PROVIDER,
          modelId: ALT_MODEL,
          modelLabel: "Echo model",
          providerLabel: ALT_LABEL,
        });
      });

      await test.step("choosing it opens a successor holding the brief", async () => {
        await page.getByTestId(`model-row-${ALT_PROVIDER}-${ALT_MODEL}`).click();

        // A handoff runs long enough that the pending state has to be visible.
        await expect(page.getByText(/Handing off to/)).toBeVisible({ timeout: 30_000 });

        // Separate "the daemon made a successor" from "the UI showed it", so a
        // future failure here says which half broke.
        const countSuccessors = countSuccessorsOnAltProvider.bind(null, session);
        await expect.poll(countSuccessors, { timeout: 60_000 }).toBe(1);

        await expectComposerVisible(page);
        // The successor opens in its own tab, so the source's message may still be
        // first in the DOM. Match the brief wherever it rendered.
        const brief = page.getByTestId("user-message").filter({ hasText: "Handoff brief" });
        await expect(brief).toBeVisible({ timeout: 120_000 });
        // The brief carries the original objective verbatim, plus the observed
        // working-tree section the successor is told it can trust.
        await expect(brief).toContainText(OBJECTIVE);
        await expect(brief).toContainText("Working tree (OBSERVED)");
      });
    } finally {
      await session.cleanup();
    }
  });

  test("a profile from another provider hands off with its whole setup", async ({ page }) => {
    const profiles = await seedAgentProfiles([
      {
        id: "agent_profile_e2e_handoff",
        name: "Echo reviewer",
        provider: ALT_PROVIDER,
        model: ALT_MODEL,
      },
    ]);
    const session = await seedMockAgentWorkspace({
      repoPrefix: "agent-handoff-profile-",
      title: "Upload retry",
      initialPrompt: OBJECTIVE,
    });

    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await openModelPicker(page);

      // A running agent is one provider's process, so these used to be hidden.
      // They are offered now because a handoff can honor them.
      await profilePickerRow(page, "Echo reviewer").click();

      const countSuccessors = countSuccessorsOnAltProvider.bind(null, session);
      await expect.poll(countSuccessors, { timeout: 60_000 }).toBe(1);

      const brief = page.getByTestId("user-message").filter({ hasText: "Handoff brief" });
      await expect(brief).toBeVisible({ timeout: 120_000 });
      await expect(brief).toContainText(OBJECTIVE);
    } finally {
      await session.cleanup();
      await profiles.restore();
    }
  });

  test("staying on the same provider changes the model without handing off", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "agent-handoff-same-",
      title: "Upload retry",
      initialPrompt: OBJECTIVE,
    });

    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await openAllProvidersView(page);
      await searchAllModels(page, "one minute stream");
      await page.getByTestId("model-row-mock-one-minute-stream").click();
      await closeModelPicker(page).catch(() => undefined);

      // Same provider stays live: the selector takes the new model in place, and
      // the agent keeps its own first message rather than receiving a brief.
      await expect(
        page.getByTestId("combined-model-selector").filter({ visible: true }).first(),
      ).toContainText("One minute stream", { timeout: 60_000 });
      await expect(firstUserMessage(page)).toContainText(OBJECTIVE);
      await expect(firstUserMessage(page)).not.toContainText("Handoff brief");
    } finally {
      await session.cleanup();
    }
  });
});
