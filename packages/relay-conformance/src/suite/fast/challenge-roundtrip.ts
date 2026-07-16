import { encodeAllowlistPush, generateKeyPair, publicKeyToAgentId } from "@agentpair/protocol";
import { pullInbox } from "../helpers/pull-inbox.js";
import { signChallenge } from "../helpers/sign-challenge.js";
import type { Probe } from "../types.js";

export const challengeRoundtripProbe: Probe = {
  id: "challenge-roundtrip",
  tier: "fast",
  async run(baseUrl) {
    const recipient = generateKeyPair();
    const sender = generateKeyPair();
    const recipientId = publicKeyToAgentId(recipient.publicKey);
    const senderId = publicKeyToAgentId(sender.publicKey);

    const allowlist = encodeAllowlistPush(recipientId, [senderId], recipient.secretKey);
    const allowRes = await fetch(`${baseUrl}/allowlist/${recipientId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(allowlist),
    });
    if (allowRes.status !== 204) {
      throw new Error(`allowlist setup failed: ${allowRes.status}`);
    }

    const challengeRes = await fetch(`${baseUrl}/inbox/${recipientId}?since=0`);
    if (challengeRes.status !== 401) {
      throw new Error(`expected 401 challenge, got ${challengeRes.status}`);
    }
    const challengeBody = (await challengeRes.json()) as {
      challenge: string;
      expires_at: number;
    };
    if (typeof challengeBody.challenge !== "string" || challengeBody.challenge.length < 10) {
      throw new Error("invalid challenge payload");
    }
    if (challengeBody.expires_at <= Date.now()) {
      throw new Error("challenge already expired");
    }

    const sig = signChallenge(challengeBody.challenge, recipient.secretKey);
    const pullRes = await fetch(
      `${baseUrl}/inbox/${recipientId}?since=0&challenge=${encodeURIComponent(challengeBody.challenge)}&sig=${encodeURIComponent(sig)}`,
    );
    if (pullRes.status !== 200) {
      throw new Error(`authenticated pull failed: ${pullRes.status}`);
    }

    const pullBody = (await pullRes.json()) as { envelopes: unknown[]; cursor: number };
    if (!Array.isArray(pullBody.envelopes)) {
      throw new Error("pull response missing envelopes array");
    }
    if (typeof pullBody.cursor !== "number") {
      throw new Error("pull response missing cursor");
    }

    const secondPull = await pullInbox(baseUrl, recipientId, recipient, 0);
    if (secondPull.status !== 200) {
      throw new Error(`repeat pull failed: ${secondPull.status}`);
    }
  },
};
