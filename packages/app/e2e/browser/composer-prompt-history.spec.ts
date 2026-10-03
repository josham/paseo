import { expect, test } from "../support/fixtures";
import { expectAgentIdle } from "../support/helpers/agent-stream";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerVisible,
  submitMessage,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import type { MockAgentWorkspace } from "../support/helpers/mock-agent";

const FIRST_PROMPT = "open the parser";
const SECOND_PROMPT = "fix the lint";

async function seedComposerWithHistory(page: Parameters<typeof openAgentRoute>[0]): Promise<{
  workspace: MockAgentWorkspace;
}> {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "prompt-history",
    title: "Prompt history",
  });
  await openAgentRoute(page, workspace);
  await expectComposerVisible(page);

  await submitMessage(page, FIRST_PROMPT);
  await expectAgentIdle(page);
  await submitMessage(page, SECOND_PROMPT);
  await expectAgentIdle(page);
  await expectComposerDraft(page, "");

  return { workspace };
}

test("ArrowUp walks back through prompts already sent, and ArrowDown returns the draft", async ({
  page,
}) => {
  const { workspace } = await seedComposerWithHistory(page);
  try {
    const composer = composerLocator(page);
    await composer.click();
    await composer.fill("half typed");

    await composer.press("ArrowUp");
    await expectComposerDraft(page, SECOND_PROMPT);

    await composer.press("ArrowUp");
    await expectComposerDraft(page, FIRST_PROMPT);

    // Oldest entry: there is nothing further back, so the composer holds still.
    await composer.press("ArrowUp");
    await expectComposerDraft(page, FIRST_PROMPT);

    await composer.press("ArrowDown");
    await expectComposerDraft(page, SECOND_PROMPT);

    await composer.press("ArrowDown");
    await expectComposerDraft(page, "half typed");
  } finally {
    await workspace.cleanup();
  }
});

test("Shift+ArrowUp selects text instead of reaching history", async ({ page }) => {
  const { workspace } = await seedComposerWithHistory(page);
  try {
    const composer = composerLocator(page);
    await composer.click();
    await composer.fill("untouched");

    await composer.press("Shift+ArrowUp");

    await expectComposerDraft(page, "untouched");
  } finally {
    await workspace.cleanup();
  }
});

test("Ctrl+R fuzzy-searches sent prompts and puts the chosen one in the composer", async ({
  page,
}) => {
  const { workspace } = await seedComposerWithHistory(page);
  try {
    const composer = composerLocator(page);
    await composer.click();
    await composer.press("Control+r");

    const popover = page.getByTestId("composer-prompt-history-popover");
    await expect(popover).toBeVisible({ timeout: 10_000 });
    await expect(popover.getByText(FIRST_PROMPT)).toBeVisible();
    await expect(popover.getByText(SECOND_PROMPT)).toBeVisible();

    // Scattered characters, none of them adjacent in the prompt they match.
    await page.keyboard.type("opnprsr");
    await expect(popover.getByText(FIRST_PROMPT)).toBeVisible();
    await expect(popover.getByText(SECOND_PROMPT)).toHaveCount(0);

    await composer.press("Enter");

    await expect(popover).toHaveCount(0);
    await expectComposerDraft(page, FIRST_PROMPT);
  } finally {
    await workspace.cleanup();
  }
});

// A phone browser has no Ctrl and no arrow keys, so the toolbar button is the
// only way in. Seeding happens at desktop width first because compact web sends
// with the button, not with Enter.
const COMPACT_VIEWPORT = { width: 390, height: 844 };

test("a compact viewport gets a toolbar button that opens prompt search", async ({ page }) => {
  const { workspace } = await seedComposerWithHistory(page);
  try {
    await page.setViewportSize(COMPACT_VIEWPORT);

    const historyButton = page.getByTestId("message-input-prompt-history-button");
    await expect(historyButton).toBeVisible({ timeout: 10_000 });

    await historyButton.click();

    const popover = page.getByTestId("composer-prompt-history-popover");
    await expect(popover).toBeVisible({ timeout: 10_000 });

    // Tap a row: the whole path has to work without a keyboard.
    await popover.getByText(FIRST_PROMPT).click();

    await expect(popover).toHaveCount(0);
    await expectComposerDraft(page, FIRST_PROMPT);
  } finally {
    await workspace.cleanup();
  }
});

test("a desktop viewport keeps the toolbar button out of the way", async ({ page }) => {
  const { workspace } = await seedComposerWithHistory(page);
  try {
    await expect(page.getByTestId("message-input-prompt-history-button")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test("Escape leaves the composer exactly as prompt search found it", async ({ page }) => {
  const { workspace } = await seedComposerWithHistory(page);
  try {
    const composer = composerLocator(page);
    await composer.click();
    await composer.fill("work in progress");
    await composer.press("Control+r");

    const popover = page.getByTestId("composer-prompt-history-popover");
    await expect(popover).toBeVisible({ timeout: 10_000 });

    await composer.press("Escape");

    await expect(popover).toHaveCount(0);
    await expectComposerDraft(page, "work in progress");
  } finally {
    await workspace.cleanup();
  }
});
