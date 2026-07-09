import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryEnvelopeSeqStore, createFileEnvelopeSeqStore } from "./envelope-seq.js";

async function withTempDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "agentpair-envelope-seq-"));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe("EnvelopeSeqStore", () => {
  it("getLastAccepted returns 0 for unknown (thread, from)", async () => {
    const store = new MemoryEnvelopeSeqStore();
    await store.init("alice");
    expect(store.getLastAccepted("thread-1", "bob")).toBe(0);
  });

  it("commitAccepted persists after flush", async () => {
    await withTempDataDir(async (dataDir) => {
      const store = createFileEnvelopeSeqStore({ dataDir });
      await store.init("alice");
      store.commitAccepted("thread-T", "alice", 5);
      await store.flush();

      const reloaded = createFileEnvelopeSeqStore({ dataDir });
      await reloaded.init("alice");
      expect(reloaded.getLastAccepted("thread-T", "alice")).toBe(5);
      await reloaded.flush();
    });
  });

  it("independent (T, alice) vs (T, bob) streams", async () => {
    const store = new MemoryEnvelopeSeqStore();
    await store.init("local");
    store.commitAccepted("thread-T", "alice", 1);
    store.commitAccepted("thread-T", "bob", 1);
    expect(store.getLastAccepted("thread-T", "alice")).toBe(1);
    expect(store.getLastAccepted("thread-T", "bob")).toBe(1);
  });

  it("survives reload from disk", async () => {
    await withTempDataDir(async (dataDir) => {
      const first = createFileEnvelopeSeqStore({ dataDir });
      await first.init("alice");
      first.commitAccepted("thread-T", "alice", 3);
      await first.flush();

      const second = createFileEnvelopeSeqStore({ dataDir });
      await second.init("alice");
      expect(second.getLastAccepted("thread-T", "alice")).toBe(3);
      await second.flush();
    });
  });

  it("MemoryEnvelopeSeqStore works without dataDir", async () => {
    const store = new MemoryEnvelopeSeqStore();
    await store.init("alice");
    store.commitAccepted("thread-T", "alice", 2);
    expect(store.getLastAccepted("thread-T", "alice")).toBe(2);
    await store.flush();
    expect(store.getLastAccepted("thread-T", "alice")).toBe(2);
  });
});
