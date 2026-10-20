import { describe, expect, test } from "vitest";
import {
  findLanguageServer,
  InvalidLanguageServerConfigError,
  languageIdForFile,
  resolveLanguageServers,
} from "./servers.js";

describe("resolveLanguageServers", () => {
  test("a command override keeps the built-in's arguments", () => {
    const servers = resolveLanguageServers({ typescript: { command: "/opt/tsls" } });

    expect(findLanguageServer(servers, "a.ts")?.candidates).toEqual([
      { command: "/opt/tsls", args: ["--stdio"] },
    ]);
  });

  test("a new id adds a language for the extensions it names", () => {
    const servers = resolveLanguageServers({
      lua: { command: "lua-language-server", extensions: ["lua"] },
    });
    const lua = findLanguageServer(servers, "init.LUA");

    expect(lua?.id).toBe("lua");
    expect(lua && languageIdForFile(lua, "init.lua")).toBe("lua");
  });

  test("a new id without extensions is rejected with the reason", () => {
    expect(() => resolveLanguageServers({ lua: { command: "lua-language-server" } })).toThrow(
      InvalidLanguageServerConfigError,
    );
  });

  test("a disabled built-in claims no files", () => {
    const servers = resolveLanguageServers({ python: { disabled: true } });

    expect(findLanguageServer(servers, "main.py")).toBeNull();
  });

  test("extensions map to their LSP language ids", () => {
    const typescript = findLanguageServer(resolveLanguageServers(), "view.tsx");

    expect(typescript && languageIdForFile(typescript, "view.tsx")).toBe("typescriptreact");
    expect(typescript && languageIdForFile(typescript, "index.ts")).toBe("typescript");
  });
});
