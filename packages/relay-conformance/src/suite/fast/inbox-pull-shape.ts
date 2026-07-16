import { encodeAllowlistPush, generateKeyPair, publicKeyToAgentId } from "@agentpair/protocol";
import { postEnvelope } from "../helpers/post-envelope.js";
import { pullInbox } from "../helpers/pull-inbox.js";
import type { Probe } from "../types.js";

export const inboxPullShapeProbe: Probe = {
  id: "inbox-pull-shape",
  tier: "fast",
  async run(baseUrl) {
    const recipient = generateKeyPair();
    const sender = generateKeyPair();
    const recipientId = publicKeyToAgentId(recipient.publicKey);
    const senderId = publicKeyToAgentId(sender.publicKey);
    const thread = "cc0e8400-e29b-41d4-a716-446655440011";

    const allowlist = encodeAllowlistPush(recipientId, [senderId], recipient.secretKey);
    const allowRes = await fetch(`${baseUrl}/allowlist/${recipientId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(allowlist),
    });
    if (allowRes.status !== 204) {
      throw new Error(`allowlist setup failed: ${allowRes.status}`);
    }

    const postRes = await postEnvelope(baseUrl, recipientId, sender, 1, { thread });
    if (postRes.status !== 204) {
      throw new Error(`inbox POST failed: ${postRes.status}`);
    }

    const midPost = await postEnvelope(baseUrl, recipientId, sender, 2, { thread });
    if (midPost.status !== 204) {
      throw new Error(`inbox POST seq=2 failed: ${midPost.status}`);
    }

    const gapPost = await postEnvelope(baseUrl, recipientId, sender, 4, { thread });
    if (gapPost.status !== 204) {
      throw new Error(`gap inbox POST failed: ${gapPost.status}`);
    }

    const pullRes = await pullInbox(baseUrl, recipientId, recipient, 0);
    if (pullRes.status !== 200) {
      throw new Error(`inbox pull failed: ${pullRes.status}`);
    }

    const body = (await pullRes.json()) as Record<string, unknown>;
    if (!Array.isArray(body.envelopes)) {
      throw new Error("pull response missing envelopes array");
    }
    if (typeof body.cursor !== "number") {
      throw new Error("pull response missing cursor number");
    }
    if (!Array.isArray(body.gaps)) {
      throw new Error("pull response missing gaps array");
    }
    const gaps = body.gaps as Array<{
      thread: string;
      last_good_seq: number;
      expected_seq: number;
    }>;
    const gap = gaps.find((entry) => entry.thread === thread);
    if (!gap || gap.last_good_seq !== 2 || gap.expected_seq !== 3) {
      throw new Error("expected seq 2→4 gap advisory in pull response");
    }
  },
};
