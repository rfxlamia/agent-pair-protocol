import {
  type KeyPair,
  createOuterEnvelope,
  encodeAllowlistPush,
  generateKeyPair,
  publicKeyToAgentId,
  serializeOuterEnvelope,
} from "@agentpair/protocol";
import type { RelayApp } from "@agentpair/relay";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { futureTtl } from "./future-ttl.js";
import { signChallenge } from "./sign-challenge.js";

export interface GapSeedContext {
  recipientId: string;
  recipient: KeyPair;
  senderId: string;
  thread: string;
  /** Incremental pull cursor after seq 1; advisory re-pulls here to observe the 1→3 gap. */
  pullSince: number;
}

let lastGapSeed: GapSeedContext | null = null;

export function getGapSeedContext(): GapSeedContext | null {
  return lastGapSeed;
}

async function authenticatedPull(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  recipientId: string,
  recipient: KeyPair,
  since: number,
): Promise<Response> {
  const challengeRes = await request(`/inbox/${recipientId}?since=${since}`);
  const { challenge } = (await challengeRes.json()) as { challenge: string };
  const sig = signChallenge(challenge, recipient.secretKey);
  return request(
    `/inbox/${recipientId}?since=${since}&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
  );
}

export async function seedInboxSeqGap(relay: RelayApp, baseUrl: string): Promise<GapSeedContext> {
  const recipient = generateKeyPair();
  const sender = generateKeyPair();
  const recipientId = publicKeyToAgentId(recipient.publicKey);
  const senderId = publicKeyToAgentId(sender.publicKey);
  const thread = "660e8400-e29b-41d4-a716-446655440099";

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(path, baseUrl);
    return relay.app.request(url.pathname + url.search, init);
  }

  const allowlist = encodeAllowlistPush(recipientId, [senderId], recipient.secretKey);
  const allowRes = await request(`/allowlist/${recipientId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(allowlist),
  });
  if (allowRes.status !== 204) {
    throw new Error(`seed allowlist failed: ${allowRes.status}`);
  }

  async function postSeq(seq: number): Promise<void> {
    const envelope = createOuterEnvelope({
      sender,
      recipientAgentId: recipientId,
      type: "core.msg",
      thread,
      seq,
      ttl: futureTtl(),
      payload: utf8ToBytes(`gap-${seq}`),
      id: crypto.randomUUID(),
    });
    const postRes = await request(`/inbox/${recipientId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeOuterEnvelope(envelope),
    });
    if (postRes.status !== 204) {
      throw new Error(`seed inbox POST seq=${seq} failed: ${postRes.status}`);
    }
  }

  await postSeq(1);

  const anchorPull = await authenticatedPull(request, recipientId, recipient, 0);
  if (anchorPull.status !== 200) {
    throw new Error(`seed anchor pull failed: ${anchorPull.status}`);
  }
  const anchorBody = (await anchorPull.json()) as { cursor: number };
  const pullSince = anchorBody.cursor;

  await postSeq(3);

  const pullRes = await authenticatedPull(request, recipientId, recipient, pullSince);
  if (pullRes.status !== 200) {
    throw new Error(`seed inbox pull failed: ${pullRes.status}`);
  }
  const body = (await pullRes.json()) as {
    gaps?: Array<{ thread: string; last_good_seq: number; expected_seq: number }>;
  };
  if (!body.gaps?.length) {
    throw new Error("seed failed: expected gaps on unwrapped pull");
  }

  lastGapSeed = { recipientId, recipient, senderId, thread, pullSince };
  return lastGapSeed;
}
