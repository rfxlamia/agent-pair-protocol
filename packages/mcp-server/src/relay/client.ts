import {
  type Envelope,
  type KeyPair,
  type PairingRelayClient,
  deserializeEnvelope,
  publicKeyToAgentId,
  serializeEnvelope,
  sign,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";

const DEFAULT_RELAY_URL = "http://127.0.0.1:3001";

export function resolveRelayUrl(): string {
  return process.env.AGENTPAIR_RELAY_URL ?? DEFAULT_RELAY_URL;
}

export function manifestSessionId(code: string): string {
  return `manifest:${code}`;
}

export interface PairManifest {
  code: string;
  sessionId: string;
  proposal: {
    scope: string[];
    mode: string;
    initiatorAgentId: string;
  };
  createdAt: number;
  expiresAt: number;
}

export interface RelayTestHooks {
  failAllowlistFor?: string | null;
}

function canonicalAllowlistBytes(agentId: string, allowed: string[]): Uint8Array {
  const ordered = { agent_id: agentId, allowed: [...allowed].sort() };
  return utf8ToBytes(JSON.stringify(ordered));
}

function signAllowlist(
  agentId: string,
  allowed: string[],
  secretKey: Uint8Array,
): { agent_id: string; allowed: string[]; sig: string } {
  const signature = sign(canonicalAllowlistBytes(agentId, allowed), secretKey);
  return {
    agent_id: agentId,
    allowed: [...allowed].sort(),
    sig: Buffer.from(signature).toString("base64url"),
  };
}

function signChallenge(nonce: string, secretKey: Uint8Array): string {
  const signature = sign(utf8ToBytes(nonce), secretKey);
  return Buffer.from(signature).toString("base64url");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpRelayClient implements PairingRelayClient {
  readonly baseUrl: string;
  testHooks: RelayTestHooks;

  constructor(baseUrl = resolveRelayUrl(), testHooks: RelayTestHooks = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.testHooks = testHooks;
  }

  async postPakeMessage(sessionId: string, body: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/pair/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      throw new Error(`relay pair post failed: ${res.status}`);
    }
  }

  async pollPakeMessage(sessionId: string, timeoutMs = 1500): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${this.baseUrl}/pair/${encodeURIComponent(sessionId)}`);
      if (res.status === 200) {
        return await res.text();
      }
      if (res.status !== 404) {
        return null;
      }
      await sleep(25);
    }
    return null;
  }

  async putAllowlist(
    agentId: string,
    allowed: string[],
    secretKey: Uint8Array,
  ): Promise<{ ok: boolean }> {
    if (this.testHooks.failAllowlistFor === agentId) {
      return { ok: false };
    }

    const body = signAllowlist(agentId, allowed, secretKey);
    const res = await fetch(`${this.baseUrl}/allowlist/${encodeURIComponent(agentId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.status === 204 };
  }

  async publishPairManifest(manifest: PairManifest): Promise<void> {
    await this.postPakeMessage(manifestSessionId(manifest.code), JSON.stringify(manifest));
  }

  async fetchPairManifest(code: string): Promise<PairManifest | null> {
    const raw = await this.pollPakeMessage(manifestSessionId(code), 3000);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as PairManifest;
  }

  async sendEnvelope(recipientAgentId: string, envelope: Envelope): Promise<void> {
    const res = await fetch(`${this.baseUrl}/inbox/${encodeURIComponent(recipientAgentId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeEnvelope(envelope),
    });
    if (res.status === 409) {
      let error = "";
      try {
        const body = (await res.json()) as { error?: string };
        error = body.error ?? "";
      } catch {
        // duplicate_envelope_id responses are idempotent success
      }
      if (error === "duplicate_envelope_id") {
        return;
      }
    }
    if (!res.ok && res.status !== 204) {
      const body = await res.text();
      throw new Error(`relay inbox post failed: ${res.status} ${body}`);
    }
  }

  async pullInbox(
    keyPair: KeyPair,
    since = 0,
  ): Promise<
    | {
        ok: true;
        envelopes: Envelope[];
        cursor?: number;
        relay_gaps?: Array<{
          thread: string;
          last_good_seq: number;
          expected_seq?: number;
        }>;
      }
    | { ok: false; error: string }
  > {
    const agentId = publicKeyToAgentId(keyPair.publicKey);
    const challengeRes = await fetch(
      `${this.baseUrl}/inbox/${encodeURIComponent(agentId)}?since=${since}`,
    );
    if (challengeRes.status !== 401) {
      return { ok: false, error: "unexpected_challenge_status" };
    }

    const challengeBody = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challengeBody.challenge, keyPair.secretKey);
    const pullRes = await fetch(
      `${this.baseUrl}/inbox/${encodeURIComponent(agentId)}?since=${since}&challenge=${encodeURIComponent(challengeBody.challenge)}&sig=${encodeURIComponent(sig)}`,
    );

    if (!pullRes.ok) {
      return { ok: false, error: `inbox_pull_failed_${pullRes.status}` };
    }

    const payload = (await pullRes.json()) as {
      envelopes?: Array<string | Envelope>;
      cursor?: number;
      gaps?: Array<{
        thread: string;
        last_good_seq: number;
        expected_seq?: number;
      }>;
    };
    const envelopes = (payload.envelopes ?? []).map((raw) =>
      typeof raw === "string" ? deserializeEnvelope(raw) : raw,
    );
    return {
      ok: true,
      envelopes,
      cursor: payload.cursor,
      relay_gaps: payload.gaps,
    };
  }
}
