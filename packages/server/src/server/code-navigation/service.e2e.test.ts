import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type {
  CodeSymbolGetLocationsRequest,
  CodeSymbolLocationsResult,
} from "@getpaseo/protocol/messages";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createPersistedWorkspaceRecord } from "../workspace-registry.js";
import { resolveLanguageServers } from "./servers.js";
import { createCodeNavigationService, type CodeNavigationService } from "./service.js";

// typescript-language-server is a dev dependency, so this runs against the real server with no
// machine setup. It is started through Node so the test does not depend on PATH.
const typescriptLanguageServerCli = createRequire(import.meta.url).resolve(
  "typescript-language-server/lib/cli.mjs",
);

const UTIL = `export function greet(name: string): string {
  return "hi " + name;
}
`;
const ALIAS = `export { greet as hello } from "./util";
`;
const MAIN = `import { greet } from "./util";
import { hello } from "./alias";

export const first = greet("a");
export const second = hello("b");
`;

let workspaceRoot: string;
let service: CodeNavigationService;

function request(
  input: Pick<CodeSymbolGetLocationsRequest, "path" | "kind" | "position" | "content">,
): Promise<CodeSymbolLocationsResult> {
  return service.getLocations({
    type: "code.symbol.get_locations.request",
    requestId: "test",
    cwd: workspaceRoot,
    ...input,
  });
}

function expectOk(result: CodeSymbolLocationsResult) {
  if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result;
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "paseo-code-navigation-"));
  await mkdir(path.join(workspaceRoot, "src"));
  await writeFile(
    path.join(workspaceRoot, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, module: "esnext", target: "es2022" } }),
  );
  await writeFile(path.join(workspaceRoot, "src/util.ts"), UTIL);
  await writeFile(path.join(workspaceRoot, "src/alias.ts"), ALIAS);
  await writeFile(path.join(workspaceRoot, "src/main.ts"), MAIN);

  const now = new Date().toISOString();
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-1",
    projectId: "project-1",
    cwd: workspaceRoot,
    kind: "directory",
    displayName: "fixture",
    createdAt: now,
    updatedAt: now,
  });
  service = createCodeNavigationService({
    logger: createTestLogger(),
    workspaceRegistry: { list: async () => [workspace] },
    readSettings: () => ({
      enabled: true,
      servers: resolveLanguageServers({
        typescript: {
          command: process.execPath,
          args: [typescriptLanguageServerCli, "--stdio"],
        },
      }),
    }),
  });
});

afterAll(async () => {
  await service?.dispose();
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
});

describe("code navigation against typescript-language-server", () => {
  test("definition of an imported name resolves to its declaration, not the import", async () => {
    // `greet` in `export const first = greet("a");`
    const result = expectOk(
      await request({
        path: "src/main.ts",
        kind: "definition",
        position: { line: 3, character: 21 },
      }),
    );

    expect(result.locations).toEqual([
      {
        path: "src/util.ts",
        range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
        preview: "export function greet(name: string): string {",
        openable: true,
      },
    ]);
    expect(result.originRange).toEqual({
      start: { line: 3, character: 21 },
      end: { line: 3, character: 26 },
    });
  });

  test("references cover every file, including through a re-export alias", async () => {
    // `greet` in its declaration.
    const result = expectOk(
      await request({
        path: "src/util.ts",
        kind: "references",
        position: { line: 0, character: 18 },
      }),
    );

    const positions = result.locations.map((location) => [
      location.path,
      location.range.start.line,
      location.range.start.character,
    ]);
    // tsserver follows the rename, so uses of `hello` count as uses of `greet`.
    expect(positions).toEqual([
      ["src/alias.ts", 0, 9],
      ["src/alias.ts", 0, 18],
      ["src/main.ts", 0, 9],
      ["src/main.ts", 1, 9],
      ["src/main.ts", 3, 21],
      ["src/main.ts", 4, 22],
      ["src/util.ts", 0, 16],
    ]);
    expect(result.partial).toBe(false);
    expect(result.truncated).toBe(false);
  });

  test("unsaved content is what the position refers to", async () => {
    // Two lines pushed in front of the call: on disk, line 5 is past the end of the file.
    const content = `// one\n// two\n${MAIN}`;
    const result = expectOk(
      await request({
        path: "src/main.ts",
        kind: "definition",
        position: { line: 5, character: 21 },
        content,
      }),
    );

    expect(result.locations.map((location) => location.path)).toEqual(["src/util.ts"]);
  });

  test("a keyword resolves to nothing rather than the enclosing declaration", async () => {
    // `return` inside greet.
    const result = expectOk(
      await request({
        path: "src/util.ts",
        kind: "definition",
        position: { line: 1, character: 3 },
      }),
    );

    expect(result.locations).toEqual([]);
  });

  test("a path outside any workspace does not start a server", async () => {
    const result = await service.getLocations({
      type: "code.symbol.get_locations.request",
      requestId: "test",
      cwd: tmpdir(),
      path: "elsewhere.ts",
      kind: "definition",
      position: { line: 0, character: 0 },
    });

    expect(result).toEqual({ status: "unavailable", reason: "not_a_workspace" });
  });

  test("a file no server claims is reported as unsupported", async () => {
    const result = await request({
      path: "README.md",
      kind: "definition",
      position: { line: 0, character: 0 },
    });

    expect(result).toEqual({ status: "unsupported_language" });
  });
});
