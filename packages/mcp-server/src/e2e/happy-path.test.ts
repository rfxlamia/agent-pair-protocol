import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DualRelayEnv,
  createDualAgent,
  runPairingFlow,
  runSessionHappyPath,
  startDualRelay,
  syncInboxes,
} from "./dual-server.js";

describe("e2e happy path", () => {
  let env: DualRelayEnv;

  beforeAll(async () => {
    env = await startDualRelay(13221);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("pair → session → ratify produces co-signed hash via relay transport", async () => {
    const alice = await createDualAgent(env, "alice");
    const bob = await createDualAgent(env, "bob");

    await runPairingFlow(alice, bob);

    const result = await runSessionHappyPath(alice, bob);

    expect(result.coSignedHash).toBe(result.artifactHash);
    expect(result.artifactHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.thread).toBeTruthy();

    await syncInboxes([alice.ctx, bob.ctx]);
    const aliceStatus = await alice.ctx.pending.list();
    const bobStatus = await bob.ctx.pending.list();
    expect(aliceStatus.filter((item) => item.kind === "ratify")).toHaveLength(0);
    expect(bobStatus.filter((item) => item.kind === "ratify")).toHaveLength(0);
  }, 30000);
});
