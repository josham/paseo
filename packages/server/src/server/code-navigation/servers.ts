import { extname } from "node:path";
import type { CodeNavigationServerConfig } from "../persisted-config.js";

/** One way to start a language server. A descriptor lists several in preference order. */
export interface LanguageServerCommand {
  command: string;
  args: string[];
}

/**
 * A language server Paseo can talk to. Binaries are never bundled: the user installs one of the
 * candidates, and an absent server is reported with the commands that would satisfy it.
 */
export interface LanguageServerDescriptor {
  /** Stable id: the pool key and the key users override in config. */
  id: string;
  candidates: LanguageServerCommand[];
  /** Lowercase, dot-prefixed extensions this server claims. */
  extensions: string[];
  /** LSP `languageId` per extension; anything unlisted uses `defaultLanguageId`. */
  languageIds: Record<string, string>;
  defaultLanguageId: string;
}

/**
 * Servers that speak stdio and need no per-project setup. Anything else is added by the user
 * under `features.codeNavigation.servers` in config.json.
 */
const BUILT_IN_SERVERS: readonly LanguageServerDescriptor[] = [
  {
    id: "typescript",
    candidates: [{ command: "typescript-language-server", args: ["--stdio"] }],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    languageIds: {
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".jsx": "javascriptreact",
    },
    defaultLanguageId: "typescript",
  },
  {
    id: "python",
    candidates: [
      { command: "basedpyright-langserver", args: ["--stdio"] },
      { command: "pyright-langserver", args: ["--stdio"] },
      { command: "pylsp", args: [] },
    ],
    extensions: [".py", ".pyi"],
    languageIds: {},
    defaultLanguageId: "python",
  },
  {
    id: "go",
    candidates: [{ command: "gopls", args: [] }],
    extensions: [".go"],
    languageIds: {},
    defaultLanguageId: "go",
  },
  {
    id: "rust",
    candidates: [{ command: "rust-analyzer", args: [] }],
    extensions: [".rs"],
    languageIds: {},
    defaultLanguageId: "rust",
  },
  {
    id: "clangd",
    candidates: [{ command: "clangd", args: [] }],
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
    languageIds: { ".c": "c", ".h": "c" },
    defaultLanguageId: "cpp",
  },
  {
    id: "bash",
    candidates: [{ command: "bash-language-server", args: ["start"] }],
    extensions: [".sh", ".bash"],
    languageIds: {},
    defaultLanguageId: "shellscript",
  },
];

export class InvalidLanguageServerConfigError extends Error {
  constructor(
    readonly serverId: string,
    readonly reason: string,
  ) {
    super(`Language server "${serverId}" in config.json ${reason}`);
    this.name = "InvalidLanguageServerConfigError";
  }
}

/**
 * Apply the user's config over the built-ins. An entry with a built-in id replaces that server's
 * command (keeping its arguments unless the entry sets them) and, when given, its extensions. Any
 * other id adds a language, and must name both a command and the extensions it claims.
 */
export function resolveLanguageServers(
  overrides: Readonly<Record<string, CodeNavigationServerConfig>> = {},
): LanguageServerDescriptor[] {
  const servers = BUILT_IN_SERVERS.map((builtIn) => {
    const override = overrides[builtIn.id];
    return override ? applyOverride(builtIn, override) : builtIn;
  });
  for (const [id, override] of Object.entries(overrides)) {
    if (BUILT_IN_SERVERS.some((builtIn) => builtIn.id === id)) continue;
    servers.push(createCustomServer(id, override));
  }
  return servers.filter((server) => !overrides[server.id]?.disabled);
}

function applyOverride(
  builtIn: LanguageServerDescriptor,
  override: CodeNavigationServerConfig,
): LanguageServerDescriptor {
  const candidates = override.command
    ? [{ command: override.command, args: override.args ?? builtIn.candidates[0].args }]
    : builtIn.candidates;
  return {
    ...builtIn,
    candidates,
    extensions: override.extensions ? normalizeExtensions(override.extensions) : builtIn.extensions,
    defaultLanguageId: override.languageId ?? builtIn.defaultLanguageId,
  };
}

function createCustomServer(
  id: string,
  override: CodeNavigationServerConfig,
): LanguageServerDescriptor {
  if (!override.command) {
    throw new InvalidLanguageServerConfigError(id, "needs a command");
  }
  if (!override.extensions || override.extensions.length === 0) {
    throw new InvalidLanguageServerConfigError(id, "needs the file extensions it handles");
  }
  return {
    id,
    candidates: [{ command: override.command, args: override.args ?? [] }],
    extensions: normalizeExtensions(override.extensions),
    languageIds: {},
    defaultLanguageId: override.languageId ?? id,
  };
}

function normalizeExtensions(extensions: readonly string[]): string[] {
  return extensions.map((extension) => {
    const lower = extension.toLowerCase();
    return lower.startsWith(".") ? lower : `.${lower}`;
  });
}

export function findLanguageServer(
  servers: readonly LanguageServerDescriptor[],
  filePath: string,
): LanguageServerDescriptor | null {
  const extension = extname(filePath).toLowerCase();
  if (!extension) return null;
  return servers.find((server) => server.extensions.includes(extension)) ?? null;
}

export function languageIdForFile(server: LanguageServerDescriptor, filePath: string): string {
  return server.languageIds[extname(filePath).toLowerCase()] ?? server.defaultLanguageId;
}
