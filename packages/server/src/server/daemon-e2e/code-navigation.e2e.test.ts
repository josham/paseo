import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

// Resolves typescript-language-server from PATH the way a user's install would; the dev
// dependency's node_modules/.bin is on PATH under npm scripts and npx.

let ctx: DaemonTestContext;
let projectRoot: string;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  projectRoot = mkdtempSync(path.join(tmpdir(), "daemon-e2e-code-navigation-"));
  writeFileSync(path.join(projectRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
  writeFileSync(
    path.join(projectRoot, "shapes.ts"),
    "export interface Shape {\n  sides: number;\n}\n",
  );
  writeFileSync(
    path.join(projectRoot, "square.ts"),
    'import type { Shape } from "./shapes";\n\nexport const square: Shape = { sides: 4 };\n',
  );
});

afterEach(async () => {
  await ctx.cleanup();
  rmSync(projectRoot, { recursive: true, force: true });
}, 60_000);

describe("code navigation", () => {
  test("advertises the capability", () => {
    expect(ctx.client.getLastServerInfoMessage()?.features?.codeNavigation).toBe(true);
  });

  test("refuses a directory that is not a workspace", async () => {
    const result = await ctx.client.getCodeSymbolLocations({
      cwd: projectRoot,
      path: "square.ts",
      kind: "definition",
      position: { line: 2, character: 22 },
    });

    expect(result).toEqual({ status: "unavailable", reason: "not_a_workspace" });
  });

  test("resolves a definition and its usages in a workspace", async () => {
    await ctx.client.createWorkspace({ source: { kind: "directory", path: projectRoot } });

    // `Shape` in `export const square: Shape`
    const definition = await ctx.client.getCodeSymbolLocations({
      cwd: projectRoot,
      path: "square.ts",
      kind: "definition",
      position: { line: 2, character: 22 },
    });
    const usages = await ctx.client.getCodeSymbolLocations({
      cwd: projectRoot,
      path: "shapes.ts",
      kind: "references",
      position: { line: 0, character: 18 },
    });

    expect(definition).toMatchObject({
      status: "ok",
      locations: [{ path: "shapes.ts", range: { start: { line: 0, character: 17 } } }],
    });
    expect(usages.status === "ok" && usages.locations.map((location) => location.path)).toEqual([
      "shapes.ts",
      "square.ts",
      "square.ts",
    ]);
  }, 90_000);
});
