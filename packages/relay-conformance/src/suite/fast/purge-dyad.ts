import {
  createOuterEnvelope,
  encodeAllowlistPush,
  generateKeyPair,
  publicKeyToAgentId,
  serializeOuterEnvelope,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { futureTtl } from "../helpers/future-ttl.js";
import { postEnvelope } from "../helpers/post-envelope.js";
import { signChallenge } from "../helpers/sign-challenge.js";
import type { Probe } from "../types.js";

export const purgeDyadProbe: Probe = {
  id: "purge-dyad",
  tier: "fast",
  async run(baseUrl) {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const aliceId = publicKeyToAgentId(alice.publicKey);
    const bobId = publicKeyToAgentId(bob.publicKey);

    const bobAllowlist = encodeAllowlistPush(bobId, [aliceId], bob.secretKey);
    let res = await fetch(`${baseUrl}/allowlist/${bobId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bobAllowlist),
    });
    if (res.status !== 204) {
      throw new Error(`bob allowlist failed: ${res.status}`);
    }

    const aliceAllowlist = encodeAllowlistPush(aliceId, [bobId], alice.secretKey);
    res = await fetch(`${baseUrl}/allowlist/${aliceId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(aliceAllowlist),
    });
    if (res.status !== 204) {
      throw new Error(`alice allowlist failed: ${res.status}`);
    }

    const aliceToBob = await postEnvelope(baseUrl, bobId, alice, 11);
    if (aliceToBob.status !== 204) {
      throw new Error(`alice→bob POST failed: ${aliceToBob.status}`);
    }

    const bobToAlice = await fetch(`${baseUrl}/inbox/${aliceId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeOuterEnvelope(
        createOuterEnvelope({
          sender: bob,
          recipientAgentId: aliceId,
          type: "core.msg",
          thread: "purge-thread",
          seq: 1,
          ttl: futureTtl(),
          payload: utf8ToBytes("reply"),
          id: crypto.randomUUID(),
        }),
      ),
    });
    if (bobToAlice.status !== 204) {
      throw new Error(`bob→alice POST failed: ${bobToAlice.status}`);
    }

    const senderQuery = `sender=${encodeURIComponent(aliceId)}`;
    const challengeRes = await fetch(`${baseUrl}/inbox/${bobId}/purge?${senderQuery}`, {
      method: "DELETE",
    });
    if (challengeRes.status !== 401) {
      throw new Error(`purge challenge expected 401, got ${challengeRes.status}`);
    }
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, bob.secretKey);
    const purgeRes = await fetch(
      `${baseUrl}/inbox/${bobId}/purge?${senderQuery}&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
      { method: "DELETE" },
    );
    if (purgeRes.status !== 200) {
      throw new Error(`purge failed: ${purgeRes.status}`);
    }
    const purgeBody = (await purgeRes.json()) as { deleted: number };
    if (purgeBody.deleted < 1) {
      throw new Error("purge deleted no rows");
    }
  },
};
