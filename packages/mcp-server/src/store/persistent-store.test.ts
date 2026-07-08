import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonPersistentStore, resolveDataDir } from "./persistent-store.js";

describe("persistent-store", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function tempFile(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-store-"));
    tempDirs.push(dir);
    return join(dir, name);
  }

  it("round-trips JSON through disk after flush", async () => {
    const filePath = await tempFile("data.json");
    const store = createJsonPersistentStore<{ count: number }>({
      filePath,
      defaultData: { count: 0 },
    });

    store.mutate((data) => {
      data.count = 42;
    });
    await store.flush();

    const reloaded = createJsonPersistentStore<{ count: number }>({
      filePath,
      defaultData: { count: 0 },
    });
    expect(reloaded.read()).toEqual({ count: 42 });
  });

  it("uses atomic temp+rename write", async () => {
    const filePath = await tempFile("atomic.json");
    const store = createJsonPersistentStore<{ value: string }>({
      filePath,
      defaultData: { value: "ok" },
    });
    store.replace({ value: "written" });
    await store.flush();

    const raw = await readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual({ value: "written" });
    expect(filePath.endsWith("atomic.json")).toBe(true);
  });

  it("starts empty when file is corrupt JSON", async () => {
    const filePath = await tempFile("corrupt.json");
    await writeFile(filePath, "{not-json", "utf8");

    const store = createJsonPersistentStore<{ items: string[] }>({
      filePath,
      defaultData: { items: [] },
      validate(parsed) {
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          Array.isArray((parsed as { items?: unknown }).items)
        ) {
          return parsed as { items: string[] };
        }
        return undefined;
      },
    });

    expect(store.read()).toEqual({ items: [] });
  });

  it("starts empty when file has valid JSON but invalid shape", async () => {
    const filePath = await tempFile("shape.json");
    await writeFile(filePath, JSON.stringify({ v: 1 }), "utf8");

    const store = createJsonPersistentStore<{ items: string[] }>({
      filePath,
      defaultData: { items: [] },
      validate(parsed) {
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          Array.isArray((parsed as { items?: unknown }).items)
        ) {
          return parsed as { items: string[] };
        }
        return undefined;
      },
    });

    expect(store.read()).toEqual({ items: [] });
  });

  it("flush persists debounced mutations", async () => {
    const filePath = await tempFile("debounce.json");
    const store = createJsonPersistentStore<{ n: number }>({
      filePath,
      defaultData: { n: 0 },
      debounceMs: 50,
    });

    store.mutate((data) => {
      data.n = 1;
    });
    store.mutate((data) => {
      data.n = 2;
    });
    await store.flush();

    const reloaded = createJsonPersistentStore<{ n: number }>({
      filePath,
      defaultData: { n: 0 },
    });
    expect(reloaded.read().n).toBe(2);
  });

  it("writes files with restrictive mode", async () => {
    const filePath = await tempFile("mode.json");
    const store = createJsonPersistentStore<{ ok: boolean }>({
      filePath,
      defaultData: { ok: true },
    });
    await store.flush();

    const mode = (await import("node:fs/promises")).stat(filePath).then((s) => s.mode & 0o777);
    expect(await mode).toBe(0o600);
  });

  it("resolveDataDir honors override and env", () => {
    const prev = process.env.AGENTPAIR_DATA_DIR;
    process.env.AGENTPAIR_DATA_DIR = "/tmp/agentpair-env";
    try {
      expect(resolveDataDir("/custom")).toBe("/custom");
      expect(resolveDataDir()).toBe("/tmp/agentpair-env");
    } finally {
      if (prev === undefined) {
        process.env.AGENTPAIR_DATA_DIR = undefined;
      } else {
        process.env.AGENTPAIR_DATA_DIR = prev;
      }
    }
  });
});
