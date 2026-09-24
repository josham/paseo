import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Readable, Writable } from "node:stream";
import type pino from "pino";
import {
  ConfigurationRequest,
  createMessageConnection,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
  WorkDoneProgressCreateRequest,
  WorkspaceFoldersRequest,
  type Definition,
  type DefinitionLink,
  type Location,
  type MessageConnection,
  type Position,
  type Range,
} from "vscode-languageserver-protocol/node";
import { URI } from "vscode-uri";

export interface LanguageServerTransport {
  /** The server's stdout. */
  input: Readable;
  /** The server's stdin. */
  output: Writable;
}

export interface ConnectionTimeouts {
  /** First request on a document waits this long for the server to finish loading the project. */
  readyMs: number;
  /** Later requests wait this long for indexing that is still running. */
  indexingMs: number;
  requestMs: number;
}

const DEFAULT_TIMEOUTS: ConnectionTimeouts = {
  readyMs: 20_000,
  indexingMs: 2_000,
  requestMs: 30_000,
};

/** More than this and the least recently used document is closed. */
const MAX_OPEN_DOCUMENTS = 8;

export interface ConnectionOptions {
  transport: LanguageServerTransport;
  /** Workspace root as the server sees it. */
  rootPath: string;
  logger: pino.Logger;
  /**
   * Current text of a document the connection already has open, as the server sees its path; null
   * once it is gone. Called before each request so an agent's edit to another open file is not
   * answered from the server's stale copy — a server prefers its open copy over the disk.
   */
  readOpenDocument: (serverPath: string) => Promise<string | null>;
  timeouts?: Partial<ConnectionTimeouts>;
}

export interface DocumentPosition {
  /** Document path as the server sees it. */
  path: string;
  languageId: string;
  text: string;
  position: Position;
}

export interface RawLocation {
  uri: string;
  range: Range;
  /** The span of the symbol that was asked about, when the server reports it. */
  originRange: Range | null;
  /** The whole declaration a definition link points into, when the server reports it. */
  enclosingRange: Range | null;
}

export interface LocationsAnswer {
  locations: RawLocation[];
  /** The server was still indexing, so references in unindexed files may be missing. */
  partial: boolean;
}

export class LanguageServerTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`Language server did not answer ${method} in time`);
    this.name = "LanguageServerTimeoutError";
  }
}

export class LanguageServerClosedError extends Error {
  constructor() {
    super("Language server connection closed");
    this.name = "LanguageServerClosedError";
  }
}

interface OpenDocument {
  /** Content hash, so an unchanged document is not re-sent. */
  contentHash: string;
  /** LSP document version, which must increase with every change. */
  version: number;
  /** The server has published diagnostics for it, the signal that it loaded the project. */
  diagnosed: boolean;
  /** The first request's wait is over, so later ones only wait for indexing. */
  settled: boolean;
  lastUsed: number;
}

/**
 * One initialized LSP connection. Owns the documents it has synchronized and the readiness gate.
 *
 * The gate exists because a server answers from a partially loaded project with well-formed wrong
 * results: tsserver's definition for an imported name is the import statement until the project
 * finishes loading, and its references cover only the files loaded so far. Two signals end the
 * wait: the document's first `publishDiagnostics`, or every work-done progress the server began
 * (rust-analyzer's and gopls's indexing) having ended.
 */
export class LanguageServerConnection {
  private readonly connection: MessageConnection;
  private readonly rootPath: string;
  private readonly logger: pino.Logger;
  private readonly readOpenDocument: ConnectionOptions["readOpenDocument"];
  private readonly timeouts: ConnectionTimeouts;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly activeProgress = new Set<string | number>();
  private readonly stateListeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private progressSeen = false;
  private useCounter = 0;
  private isClosed = false;

  private constructor(options: ConnectionOptions) {
    this.rootPath = options.rootPath;
    this.logger = options.logger;
    this.readOpenDocument = options.readOpenDocument;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.connection = createMessageConnection(
      new StreamMessageReader(options.transport.input),
      new StreamMessageWriter(options.transport.output),
    );
    this.registerServerHandlers();
  }

  static async start(options: ConnectionOptions): Promise<LanguageServerConnection> {
    const instance = new LanguageServerConnection(options);
    await instance.initialize();
    return instance;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  async definition(request: DocumentPosition): Promise<LocationsAnswer> {
    const uri = await this.prepare(request, { waitForIndexing: false });
    const result = await this.request(DefinitionRequest.method, () =>
      this.connection.sendRequest(DefinitionRequest.type, {
        textDocument: { uri },
        position: request.position,
      }),
    );
    return { locations: normalizeDefinition(result), partial: this.activeProgress.size > 0 };
  }

  async references(request: DocumentPosition): Promise<LocationsAnswer> {
    const uri = await this.prepare(request, { waitForIndexing: true });
    const result = await this.request(ReferencesRequest.method, () =>
      this.connection.sendRequest(ReferencesRequest.type, {
        textDocument: { uri },
        position: request.position,
        context: { includeDeclaration: true },
      }),
    );
    const locations = (result ?? []).map(locationToRaw);
    return { locations, partial: this.activeProgress.size > 0 };
  }

  async shutdown(gracefulMs: number): Promise<void> {
    if (this.isClosed) return;
    try {
      await withTimeout(this.connection.sendRequest(ShutdownRequest.type), gracefulMs);
      this.notify(this.connection.sendNotification(ExitNotification.type));
    } catch (error) {
      this.logger.debug({ err: error }, "language server shutdown request failed");
    }
    this.markClosed();
  }

  private async initialize(): Promise<void> {
    this.connection.listen();
    const rootUri = URI.file(this.rootPath).toString();
    const result = await this.request(InitializeRequest.method, () =>
      this.connection.sendRequest(InitializeRequest.type, {
        processId: process.pid,
        clientInfo: { name: "Paseo" },
        rootUri,
        rootPath: this.rootPath,
        workspaceFolders: [{ uri: rootUri, name: basename(this.rootPath) }],
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          window: { workDoneProgress: true },
          workspace: { workspaceFolders: true, configuration: true },
          textDocument: {
            synchronization: { dynamicRegistration: false },
            definition: { linkSupport: true },
            references: {},
            publishDiagnostics: {},
          },
        },
      }),
    );
    const encoding = result.capabilities.positionEncoding;
    if (encoding && encoding !== "utf-16") {
      // Positions travel as UTF-16 code units end to end and nothing converts them, so a server
      // that insists on another encoding is off on any line with astral characters.
      this.logger.warn({ encoding }, "language server chose an unsupported position encoding");
    }
    this.notify(this.connection.sendNotification(InitializedNotification.type, {}));
  }

  private registerServerHandlers(): void {
    const rootUri = URI.file(this.rootPath).toString();
    this.connection.onRequest(WorkDoneProgressCreateRequest.type, () => undefined);
    this.connection.onRequest(ConfigurationRequest.type, (params) => params.items.map(() => null));
    this.connection.onRequest(WorkspaceFoldersRequest.type, () => [
      { uri: rootUri, name: basename(this.rootPath) },
    ]);
    // Capability registration, message prompts, refresh requests: nothing here acts on them, and
    // an error reply makes some servers log noise or retry.
    this.connection.onRequest(() => null);
    this.connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      const document = this.documents.get(params.uri);
      if (document) {
        document.diagnosed = true;
        this.emitStateChange();
      }
    });
    this.connection.onUnhandledProgress((params) => {
      const value = params.value as { kind?: unknown } | null;
      if (value?.kind === "begin") {
        this.progressSeen = true;
        this.activeProgress.add(params.token);
      } else if (value?.kind === "end") {
        this.activeProgress.delete(params.token);
      }
      this.emitStateChange();
    });
    this.connection.onClose(() => this.markClosed());
    this.connection.onError(([error]) => {
      this.logger.debug({ err: error }, "language server connection error");
    });
  }

  private async prepare(
    request: DocumentPosition,
    options: { waitForIndexing: boolean },
  ): Promise<string> {
    this.assertOpen();
    const uri = URI.file(request.path).toString();
    await this.refreshOtherDocuments(uri);
    const document = this.syncDocument(uri, request);

    const isLoaded = () =>
      document.diagnosed || (this.progressSeen && this.activeProgress.size === 0);
    const isIndexed = () => this.activeProgress.size === 0;
    const isReady = options.waitForIndexing ? () => isLoaded() && isIndexed() : isLoaded;

    if (!document.settled) {
      await this.waitFor(isReady, this.timeouts.readyMs);
      // One full wait is the bound. A server that never publishes diagnostics or progress for
      // this document would otherwise charge the whole timeout on every request.
      document.settled = true;
    } else if (options.waitForIndexing) {
      await this.waitFor(isIndexed, this.timeouts.indexingMs);
    }
    return uri;
  }

  private syncDocument(uri: string, request: DocumentPosition): OpenDocument {
    const contentHash = hashText(request.text);
    const existing = this.documents.get(uri);
    this.useCounter += 1;
    if (existing) {
      existing.lastUsed = this.useCounter;
      if (existing.contentHash !== contentHash) {
        this.sendChange(uri, existing, request.text, contentHash);
      }
      return existing;
    }

    const opened: OpenDocument = {
      contentHash,
      version: 1,
      diagnosed: false,
      settled: false,
      lastUsed: this.useCounter,
    };
    this.documents.set(uri, opened);
    this.notify(
      this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri,
          languageId: request.languageId,
          version: opened.version,
          text: request.text,
        },
      }),
    );
    this.closeLeastRecentlyUsed();
    return opened;
  }

  private async refreshOtherDocuments(currentUri: string): Promise<void> {
    const others = [...this.documents.entries()].filter(([uri]) => uri !== currentUri);
    await Promise.all(
      others.map(async ([uri, document]) => {
        const text = await this.readOpenDocument(URI.parse(uri).fsPath);
        if (this.documents.get(uri) !== document) return;
        if (text === null) {
          this.closeDocument(uri);
          return;
        }
        const contentHash = hashText(text);
        if (contentHash !== document.contentHash) {
          this.sendChange(uri, document, text, contentHash);
        }
      }),
    );
  }

  private sendChange(uri: string, document: OpenDocument, text: string, contentHash: string): void {
    document.contentHash = contentHash;
    document.version += 1;
    this.notify(
      this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version: document.version },
        contentChanges: [{ text }],
      }),
    );
  }

  private closeLeastRecentlyUsed(): void {
    while (this.documents.size > MAX_OPEN_DOCUMENTS) {
      const [oldestUri] = [...this.documents.entries()].reduce((oldest, entry) =>
        entry[1].lastUsed < oldest[1].lastUsed ? entry : oldest,
      );
      this.closeDocument(oldestUri);
    }
  }

  private closeDocument(uri: string): void {
    this.documents.delete(uri);
    this.notify(
      this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      }),
    );
  }

  private async waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    if (predicate() || this.isClosed) return;
    let timer: NodeJS.Timeout | undefined;
    let check: (() => void) | undefined;
    const satisfied = new Promise<void>((resolve) => {
      check = () => {
        if (predicate() || this.isClosed) resolve();
      };
      this.stateListeners.add(check);
    });
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([satisfied, timedOut]);
    } finally {
      clearTimeout(timer);
      if (check) this.stateListeners.delete(check);
    }
  }

  private emitStateChange(): void {
    for (const listener of this.stateListeners) listener();
  }

  private async request<T>(method: string, send: () => Promise<T>): Promise<T> {
    this.assertOpen();
    let timer: NodeJS.Timeout | undefined;
    let rejectOnClose: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new LanguageServerTimeoutError(method)),
        this.timeouts.requestMs,
      );
    });
    const closed = new Promise<never>((_, reject) => {
      rejectOnClose = () => reject(new LanguageServerClosedError());
      this.closeListeners.add(rejectOnClose);
    });
    try {
      return await Promise.race([send(), timeout, closed]);
    } finally {
      clearTimeout(timer);
      if (rejectOnClose) this.closeListeners.delete(rejectOnClose);
    }
  }

  /**
   * A notification is fire-and-forget, but its write still rejects once the process is gone, and
   * an unhandled rejection would take the daemon down with every agent it runs.
   */
  private notify(sent: Promise<void>): void {
    sent.catch((error: unknown) => {
      this.logger.debug({ err: error }, "language server notification failed");
    });
  }

  private assertOpen(): void {
    if (this.isClosed) throw new LanguageServerClosedError();
  }

  private markClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emitStateChange();
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.connection.dispose();
  }
}

function normalizeDefinition(result: Definition | DefinitionLink[] | null): RawLocation[] {
  if (!result) return [];
  const entries = Array.isArray(result) ? result : [result];
  return entries.map((entry) => {
    if ("targetUri" in entry) {
      return {
        uri: entry.targetUri,
        range: entry.targetSelectionRange,
        originRange: entry.originSelectionRange ?? null,
        enclosingRange: entry.targetRange,
      };
    }
    return locationToRaw(entry);
  });
}

function locationToRaw(location: Location): RawLocation {
  return { uri: location.uri, range: location.range, originRange: null, enclosingRange: null };
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
