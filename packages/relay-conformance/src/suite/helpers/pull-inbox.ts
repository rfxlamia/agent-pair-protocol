import type { KeyPair } from "@agentpair/protocol";
import { signChallenge } from "./sign-challenge.js";

export async function pullInbox(
  baseUrl: string,
  recipientId: string,
  recipient: KeyPair,
  since = 0,
  bondedOnly = true,
): Promise<Response> {
  const bondedQuery = bondedOnly ? "" : "&bonded_only=0";
  const challengeRes = await fetch(`${baseUrl}/inbox/${recipientId}?since=${since}${bondedQuery}`);
  const { challenge } = (await challengeRes.json()) as { challenge: string };
  const sig = signChallenge(challenge, recipient.secretKey);
  return fetch(
    `${baseUrl}/inbox/${recipientId}?since=${since}${bondedQuery}&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
  );
}
