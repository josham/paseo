import { describe, expect, it } from "vitest";
import { PromptHistoryStore, type PromptHistoryFile } from "./store.js";

function createFakeFile(initial: string | null = null): PromptHistoryFile & {
  contents: string | null;
  writes: number;
} {
  return {
    contents: initial,
    writes: 0,
    async read() {
      return this.contents;
    },
    async write(contents) {
      this.contents = contents;
      this.writes += 1;
    },
  };
}

function createClock(start = 1_000): () => number {
  let current = start;
  return () => (current += 1);
}

describe("PromptHistoryStore", () => {
  it("returns an empty history for a project that has never been used", async () => {
    const store = new PromptHistoryStore({ file: createFakeFile(), now: createClock() });

    await expect(store.list({ projectKey: "prj_1" })).resolves.toEqual([]);
  });

  it("lists recorded prompts newest first", async () => {
    const store = new PromptHistoryStore({ file: createFakeFile(), now: createClock() });

    await store.record({ projectKey: "prj_1", text: "first" });
    await store.record({ projectKey: "prj_1", text: "second" });

    const entries = await store.list({ projectKey: "prj_1" });
    expect(entries.map((entry) => entry.text)).toEqual(["second", "first"]);
  });

  it("keeps each project's history separate", async () => {
    const store = new PromptHistoryStore({ file: createFakeFile(), now: createClock() });

    await store.record({ projectKey: "prj_1", text: "one" });
    await store.record({ projectKey: "prj_2", text: "two" });

    expect((await store.list({ projectKey: "prj_1" })).map((entry) => entry.text)).toEqual(["one"]);
    expect((await store.list({ projectKey: "prj_2" })).map((entry) => entry.text)).toEqual(["two"]);
  });

  it("moves a re-sent prompt to the front instead of duplicating it", async () => {
    const store = new PromptHistoryStore({ file: createFakeFile(), now: createClock() });

    await store.record({ projectKey: "prj_1", text: "run the tests" });
    await store.record({ projectKey: "prj_1", text: "fix the lint" });
    await store.record({ projectKey: "prj_1", text: "run the tests" });

    const entries = await store.list({ projectKey: "prj_1" });
    expect(entries.map((entry) => entry.text)).toEqual(["run the tests", "fix the lint"]);
  });

  it("trims surrounding whitespace and skips prompts with no content", async () => {
    const store = new PromptHistoryStore({ file: createFakeFile(), now: createClock() });

    await expect(store.record({ projectKey: "prj_1", text: "   " })).resolves.toBeNull();
    await store.record({ projectKey: "prj_1", text: "  spaced  " });

    expect((await store.list({ projectKey: "prj_1" })).map((entry) => entry.text)).toEqual([
      "spaced",
    ]);
  });

  it("skips a prompt too large to be worth recalling", async () => {
    const store = new PromptHistoryStore({ file: createFakeFile(), now: createClock() });

    await expect(
      store.record({ projectKey: "prj_1", text: "x".repeat(20_001) }),
    ).resolves.toBeNull();
    expect(await store.list({ projectKey: "prj_1" })).toEqual([]);
  });

  it("caps a project at 200 entries, dropping the oldest", async () => {
    const store = new PromptHistoryStore({ file: createFakeFile(), now: createClock() });

    for (let index = 0; index < 205; index += 1) {
      await store.record({ projectKey: "prj_1", text: `prompt ${index}` });
    }

    const entries = await store.list({ projectKey: "prj_1" });
    expect(entries).toHaveLength(200);
    expect(entries[0].text).toBe("prompt 204");
    expect(entries.at(-1)?.text).toBe("prompt 5");
  });

  it("honours a requested limit", async () => {
    const store = new PromptHistoryStore({ file: createFakeFile(), now: createClock() });

    await store.record({ projectKey: "prj_1", text: "one" });
    await store.record({ projectKey: "prj_1", text: "two" });
    await store.record({ projectKey: "prj_1", text: "three" });

    const entries = await store.list({ projectKey: "prj_1", limit: 2 });
    expect(entries.map((entry) => entry.text)).toEqual(["three", "two"]);
  });

  it("drops the least recently used projects past the project cap", async () => {
    const store = new PromptHistoryStore({ file: createFakeFile(), now: createClock() });

    for (let index = 0; index < 201; index += 1) {
      await store.record({ projectKey: `prj_${index}`, text: "hello" });
    }

    expect(await store.list({ projectKey: "prj_0" })).toEqual([]);
    expect(await store.list({ projectKey: "prj_200" })).toHaveLength(1);
  });

  it("reads back what a previous store persisted", async () => {
    const file = createFakeFile();
    const first = new PromptHistoryStore({ file, now: createClock() });
    await first.record({ projectKey: "prj_1", text: "remembered" });

    const second = new PromptHistoryStore({ file, now: createClock() });
    expect((await second.list({ projectKey: "prj_1" })).map((entry) => entry.text)).toEqual([
      "remembered",
    ]);
  });

  it("starts empty when the file on disk is corrupt", async () => {
    const store = new PromptHistoryStore({ file: createFakeFile("{not json"), now: createClock() });

    expect(await store.list({ projectKey: "prj_1" })).toEqual([]);
  });

  it("starts empty when the file on disk has an unexpected shape", async () => {
    const store = new PromptHistoryStore({
      file: createFakeFile(JSON.stringify({ version: 99, projects: { prj_1: "nope" } })),
      now: createClock(),
    });

    expect(await store.list({ projectKey: "prj_1" })).toEqual([]);
  });

  it("keeps every entry when two projects record at the same time", async () => {
    const store = new PromptHistoryStore({ file: createFakeFile(), now: createClock() });

    await Promise.all([
      store.record({ projectKey: "prj_1", text: "one" }),
      store.record({ projectKey: "prj_2", text: "two" }),
    ]);

    expect(await store.list({ projectKey: "prj_1" })).toHaveLength(1);
    expect(await store.list({ projectKey: "prj_2" })).toHaveLength(1);
  });

  it("surfaces a write failure without losing the in-memory history", async () => {
    const errors: string[] = [];
    const store = new PromptHistoryStore({
      file: {
        async read() {
          return null;
        },
        async write() {
          throw new Error("disk full");
        },
      },
      now: createClock(),
      onError: (_error, message) => errors.push(message),
    });

    await store.record({ projectKey: "prj_1", text: "still here" });

    expect(errors).toEqual(["Failed to persist prompt history"]);
    expect((await store.list({ projectKey: "prj_1" })).map((entry) => entry.text)).toEqual([
      "still here",
    ]);
  });
});
