import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicKeyToAgentId } from "@agentpair/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../index.js";
import { HttpRelayClient } from "../relay/client.js";
import { MemoryBondStore } from "../store/bonds.js";
import { createKeyStore } from "../store/keys.js";
import { handleListBonds } from "./list-bonds.js";
import { createAgentContext } from "./pair.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

describe("list_bonds", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeContext() {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-list-bonds-"));
    tempDirs.push(dir);
    return createAgentContext({
      keyStore: createKeyStore({ keyPath: join(dir, "keys.json") }),
      relay: new HttpRelayClient("http://127.0.0.1:9"),
      bonds: new MemoryBondStore(),
    });
  }

  it("returns bonds for the current agent context", async () => {
    const ctx = await makeContext();
    const bonds = ctx.bonds as MemoryBondStore;

    const keyPair = await ctx.keyStore.loadOrCreate();
    const agentId = publicKeyToAgentId(keyPair.publicKey);
    const bond = {
      peer: "ed25519:peer1",
      scope: ["session.negotiate"],
      mode: "bonded_contact" as const,
    };
    bonds.add(agentId, bond);

    const result = structured(await handleListBonds(ctx));
    expect(result).toEqual({
      ok: true,
      agent_id: agentId,
      bonds: [bond],
    });
  });

  it("is registered on the MCP server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-list-bonds-mcp-"));
    tempDirs.push(dir);
    const { context } = createMcpServer({
      relayUrl: "http://127.0.0.1:9",
      keyPath: join(dir, "keys.json"),
    });

    const result = structured(await handleListBonds(context));
    expect(result.ok).toBe(true);
    expect(result.agent_id).toMatch(/^ed25519:/);
    expect(Array.isArray(result.bonds)).toBe(true);
  });
});
