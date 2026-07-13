import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSessionOpen } from "../tools/session.js";
import {
  type DualRelayEnv,
  SESSION_OPEN_PAYLOAD,
  createDualAgent,
  runPairingFlow,
  startDualRelay,
} from "./dual-server.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

describe("e2e profile pairing", () => {
  let env: DualRelayEnv;

  beforeAll(async () => {
    env = await startDualRelay(13225);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("negotiated intersection stored on both bond records", async () => {
    const initiator = await createDualAgent(env, "initiator-profile");
    const joiner = await createDualAgent(env, "joiner-profile");

    await runPairingFlow(initiator, joiner, {
      initiatorProfiles: ["core/1", "nego/1"],
      joinerProfiles: ["core/1"],
    });

    const initiatorId = initiator.agentId;
    const joinerId = joiner.agentId;
    const initiatorBond = initiator.ctx.bonds.find(initiatorId, joinerId);
    const joinerBond = joiner.ctx.bonds.find(joinerId, initiatorId);

    expect(initiatorBond?.profiles).toEqual(["core/1"]);
    expect(joinerBond?.profiles).toEqual(["core/1"]);
  }, 30000);

  it("nego.open rejected end-to-end when bond contract is core-only", async () => {
    const initiator = await createDualAgent(env, "initiator-core");
    const joiner = await createDualAgent(env, "joiner-core");

    await runPairingFlow(initiator, joiner, {
      initiatorProfiles: ["core/1"],
      joinerProfiles: ["core/1"],
    });

    const opened = structured(
      await handleSessionOpen(initiator.ctx, {
        to: joiner.agentId,
        ...SESSION_OPEN_PAYLOAD,
      }),
    );

    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error).toBe("profile_not_supported");
    }
  }, 30000);
});
