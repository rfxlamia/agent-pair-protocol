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
    env = await startDualRelay(3021);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("pair → session → ratify produces co-signed hash via relay transport", async () => {
    const alice = await createDualAgent(env, "alice");
    const bob = await createDualAgent(env, "bob");

    await runPairingFlow(alice, bob);

    const artifactHash = "sha256:e2e-happy-path-artifact";
    const result = await runSessionHappyPath(alice, bob, artifactHash);

    expect(result.coSignedHash).toBe(artifactHash);
    expect(result.thread).toBeTruthy();

    await syncInboxes([alice.ctx, bob.ctx]);
    const aliceStatus = await alice.ctx.pending.list();
    const bobStatus = await bob.ctx.pending.list();
    expect(aliceStatus.filter((item) => item.kind === "ratify")).toHaveLength(0);
    expect(bobStatus.filter((item) => item.kind === "ratify")).toHaveLength(0);
  }, 30000);
});
