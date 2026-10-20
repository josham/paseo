import { expect, test, type Page } from "../support/fixtures";
import {
  expectFileTabOpen,
  openFileExplorer,
  openFileFromExplorer,
} from "../support/helpers/file-explorer";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openChangesPanel, waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

// The daemon resolves typescript-language-server from PATH; the server package's dev
// dependency puts it in node_modules/.bin, which npm scripts and npx add to PATH.

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true } });
const UTIL = `export function greet(name: string): string {
  return "hi " + name;
}
`;
const MAIN = `import { greet } from "./util";

export const first = greet("a");
export const second = greet("b");
`;

function visibleEditorContent(page: Page) {
  return page.getByTestId("file-source-editor").filter({ visible: true }).locator(".cm-content");
}

/** Page coordinates of the middle of the `occurrence`-th appearance of `word` in the editor. */
async function wordPoint(page: Page, word: string, occurrence: number) {
  await expect(visibleEditorContent(page)).toContainText(word);
  const point = await visibleEditorContent(page).evaluate(
    (content, input) => {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        let index = text.indexOf(input.word);
        while (index !== -1) {
          if (seen === input.occurrence) {
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + input.word.length);
            const rect = range.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
          seen += 1;
          index = text.indexOf(input.word, index + 1);
        }
      }
      return null;
    },
    { word, occurrence },
  );
  if (!point) throw new Error(`"${word}" #${occurrence} is not in the editor`);
  return point;
}

/**
 * The start of a diff body row. Rows are one line height tall with the hunk header first, and
 * code begins after a gutter sized to the line numbers, as changes-pane.spec.ts measures it.
 */
async function diffRowStart(page: Page, rowIndex: number) {
  const body = await page.getByTestId("diff-file-0-body").boundingBox();
  const fontSize = await page
    .getByTestId("git-diff-canvas")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  if (!body) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  const gutterWidth = 2 * Math.ceil(fontSize * 0.62) + 12;
  return { x: body.x + gutterWidth + 10, y: body.y + lineHeight * (rowIndex + 0.5) };
}

async function openSeededFile(page: Page, fileName: string) {
  await openFileExplorer(page);
  await openFileFromExplorer(page, fileName);
  await expectFileTabOpen(page, fileName);
}

test.describe("code navigation", () => {
  test("Cmd/Ctrl+click and the symbol menu navigate with a real language server", async ({
    page,
  }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "code-navigation-",
      title: "Code navigation e2e",
      repo: {
        files: [
          { path: "tsconfig.json", content: TSCONFIG },
          { path: "util.ts", content: UTIL },
          { path: "main.ts", content: MAIN },
        ],
      },
    });
    try {
      await openAgentRoute(page, workspace);
      await openSeededFile(page, "main.ts");

      await test.step("Cmd/Ctrl+click on a call opens the declaration's file", async () => {
        // Occurrence 1 is the call in `first = greet("a")`; 0 is the import.
        const call = await wordPoint(page, "greet", 1);
        await page.keyboard.down("ControlOrMeta");
        await page.mouse.click(call.x, call.y);
        await page.keyboard.up("ControlOrMeta");
        await expectFileTabOpen(page, "util.ts");
        await expect(visibleEditorContent(page)).toContainText("export function greet");
      });

      await test.step("right click → Find usages lists every use in the Explorer", async () => {
        const declaration = await wordPoint(page, "greet", 0);
        await page.mouse.click(declaration.x, declaration.y, { button: "right" });
        await page.getByTestId("file-symbol-menu-usages").click();

        const list = page.getByTestId("code-locations-list");
        await expect(list).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId("code-locations-row-main.ts:1")).toBeVisible();
        await expect(page.getByTestId("code-locations-row-main.ts:3")).toBeVisible();
        await expect(page.getByTestId("code-locations-row-main.ts:4")).toBeVisible();
        await expect(page.getByTestId("code-locations-row-util.ts:1")).toBeVisible();
      });

      await test.step("a usage opens its file and the list stays", async () => {
        await page.getByTestId("code-locations-row-main.ts:4").click();
        await expectFileTabOpen(page, "main.ts");
        await expect(visibleEditorContent(page)).toContainText('greet("b")');
        await expect(page.getByTestId("code-locations-list")).toBeVisible();
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("an uncommitted diff line navigates from its context menu", async ({ page }) => {
    const workspace = await seedWorkspace({
      repoPrefix: "code-navigation-diff-",
      repo: {
        files: [
          { path: "tsconfig.json", content: TSCONFIG },
          { path: "util.ts", content: UTIL },
          { path: "main.ts", content: "" },
        ],
      },
    });
    try {
      // Row 1 is the import, row 2 starts with the call.
      await writeFile(
        path.join(workspace.repoPath, "main.ts"),
        'import { greet } from "./util";\ngreet("x");\n',
      );
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
      await waitForWorkspaceTabsVisible(page);
      await openChangesPanel(page);
      await expect(page.getByTestId("diff-file-0-body")).toBeVisible({ timeout: 30_000 });

      const call = await diffRowStart(page, 2);
      await page.mouse.click(call.x, call.y, { button: "right" });
      const goToDefinition = page.getByTestId("diff-source-go-to-definition");
      await expect(goToDefinition).toBeEnabled();
      await goToDefinition.click();
      await expectFileTabOpen(page, "util.ts");
      await expect(visibleEditorContent(page)).toContainText("export function greet");

      await openChangesPanel(page);
      await page.mouse.click(call.x, call.y, { button: "right" });
      await page.getByTestId("diff-source-find-usages").click();
      await expect(page.getByTestId("code-locations-row-main.ts:2")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("code-locations-row-util.ts:1")).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });
});
