import { promises as fs } from "node:fs";
import { z } from "zod";
import type { PromptHistoryEntry } from "@getpaseo/protocol/messages";
import { writeFileAtomic } from "../atomic-file.js";

/**
 * Per-project history of the prompts a human sent, newest first, so the
 * composer can offer the same recall a shell gives you. Scoped to the project
 * rather than the workspace: sibling worktrees of one repo are the same train
 * of thought, and a fresh worktree that starts with an empty history is the
 * case that makes the feature useless.
 *
 * Only prompts a person typed are recorded. Prompts an agent sends to another
 * agent through the Paseo tools go to the same daemon entry point, and putting
 * them here would fill a human's recall list with machine traffic.
 */

/** Long enough for a pasted spec, short enough that one paste can't own the file. */
const MAX_ENTRY_CHARS = 20_000;
const MAX_ENTRIES_PER_PROJECT = 200;
const MAX_PROJECTS = 200;

const PromptHistoryEntrySchema = z.object({
  text: z.string(),
  at: z.number(),
});

const PersistedPromptHistorySchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), z.array(PromptHistoryEntrySchema)),
});

type PersistedPromptHistory = z.infer<typeof PersistedPromptHistorySchema>;

/** The file this store owns. Injected so tests never touch a real disk. */
export interface PromptHistoryFile {
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
}

export interface PromptHistoryStoreOptions {
  file: PromptHistoryFile;
  now?: () => number;
  onError?: (error: unknown, message: string) => void;
}

export function createPromptHistoryFile(filePath: string): PromptHistoryFile {
  return {
    async read() {
      try {
        return await fs.readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(contents) {
      await writeFileAtomic(filePath, contents);
    },
  };
}

function parse(contents: string | null): Map<string, PromptHistoryEntry[]> {
  if (contents === null) return new Map();
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return new Map();
  }
  const parsed = PersistedPromptHistorySchema.safeParse(value);
  if (!parsed.success) return new Map();
  return new Map(Object.entries(parsed.data.projects));
}

function serialize(projects: Map<string, PromptHistoryEntry[]>): string {
  const value: PersistedPromptHistory = {
    version: 1,
    projects: Object.fromEntries(projects),
  };
  return JSON.stringify(value, null, 2);
}

/** Newest entry of each project decides which projects survive the cap. */
function pruneProjects(projects: Map<string, PromptHistoryEntry[]>): void {
  if (projects.size <= MAX_PROJECTS) return;
  const byRecency = [...projects.entries()].sort(
    (left, right) => (right[1][0]?.at ?? 0) - (left[1][0]?.at ?? 0),
  );
  for (const [projectKey] of byRecency.slice(MAX_PROJECTS)) {
    projects.delete(projectKey);
  }
}

export class PromptHistoryStore {
  private readonly file: PromptHistoryFile;
  private readonly now: () => number;
  private readonly onError: (error: unknown, message: string) => void;
  private loading: Promise<Map<string, PromptHistoryEntry[]>> | null = null;
  /** Writes are chained so two sessions recording at once can't lose an entry. */
  private writing: Promise<void> = Promise.resolve();

  constructor(options: PromptHistoryStoreOptions) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
  }

  private load(): Promise<Map<string, PromptHistoryEntry[]>> {
    this.loading ??= this.file
      .read()
      .then(parse)
      .catch((error) => {
        this.onError(error, "Failed to read prompt history");
        return new Map<string, PromptHistoryEntry[]>();
      });
    return this.loading;
  }

  async list(input: { projectKey: string; limit?: number }): Promise<PromptHistoryEntry[]> {
    const projects = await this.load();
    const entries = projects.get(input.projectKey) ?? [];
    return input.limit === undefined ? [...entries] : entries.slice(0, input.limit);
  }

  /**
   * Returns the recorded entry, or null when the prompt was not worth keeping.
   * Re-sending an old prompt moves it to the front instead of duplicating it,
   * so arrowing back never walks through the same text twice.
   */
  async record(input: { projectKey: string; text: string }): Promise<PromptHistoryEntry | null> {
    const text = input.text.trim();
    if (!text || text.length > MAX_ENTRY_CHARS) return null;
    if (!input.projectKey) return null;

    const projects = await this.load();
    const entry: PromptHistoryEntry = { text, at: this.now() };
    const previous = projects.get(input.projectKey) ?? [];
    const deduped = previous.filter((candidate) => candidate.text !== text);
    projects.set(input.projectKey, [entry, ...deduped].slice(0, MAX_ENTRIES_PER_PROJECT));
    pruneProjects(projects);

    const previousWrite = this.writing;
    this.writing = (async () => {
      await previousWrite;
      try {
        await this.file.write(serialize(projects));
      } catch (error) {
        this.onError(error, "Failed to persist prompt history");
      }
    })();
    await this.writing;
    return entry;
  }
}
