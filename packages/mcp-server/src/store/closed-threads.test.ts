import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryClosedThreadStore, createFileClosedThreadStore } from "./closed-threads.js";

describe("ClosedThreadStore", () => {
  const thread = "550e8400-e29b-41d4-a716-446655440000";
  const by = "ed25519:abc";

  it("starts empty", async () => {
    const store = new MemoryClosedThreadStore();
    await store.init(by);
    expect(store.isClosed(thread)).toBe(false);
  });

  it("markClosed is idempotent", async () => {
    const store = new MemoryClosedThreadStore();
    await store.init(by);
    store.markClosed(thread, { closed_at: 100, by, reason: "done" });
    store.markClosed(thread, { closed_at: 200, by, reason: "again" });
    expect(store.isClosed(thread)).toBe(true);
    expect(store.get(thread)?.closed_at).toBe(100);
  });

  describe("file persistence", () => {
    let dir: string;

    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it("survives restart", async () => {
      dir = await mkdtemp(join(tmpdir(), "agentpair-closed-"));
      const store1 = createFileClosedThreadStore({ dataDir: dir });
      await store1.init(by);
      store1.markClosed(thread, { closed_at: 42, by });
      await store1.flush();

      const store2 = createFileClosedThreadStore({ dataDir: dir });
      await store2.init(by);
      expect(store2.isClosed(thread)).toBe(true);

      const raw = JSON.parse(await readFile(store2.filePath, "utf8"));
      expect(raw.v).toBe(1);
      expect(raw.threads[thread].closed_at).toBe(42);
    });
  });
});
