import {
  type KeyPair,
  MAX_SPILLOVER_PLAINTEXT_BYTES,
  type OuterEnvelope,
  type PairingRelayClient,
  publicKeyToAgentId,
  serializeOuterEnvelope,
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

function signArtifactHash(hash: string, secretKey: Uint8Array): string {
  const signature = sign(utf8ToBytes(hash), secretKey);
  return Buffer.from(signature).toString("base64url");
}

function relayError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function artifactReadLimit(size: number): number {
  return Math.min(size + 40, MAX_SPILLOVER_PLAINTEXT_BYTES + 40);
}

const PUT_ARTIFACT_PASSTHROUGH_ERRORS = new Set([
  "quota_exceeded",
  "auth_required",
  "invalid_signature",
  "agent_not_registered",
]);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpRelayClient implements PairingRelayClient {
  readonly baseUrl: string;

  constructor(baseUrl = resolveRelayUrl()) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
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

  async sendEnvelope(recipientAgentId: string, outer: OuterEnvelope): Promise<void> {
    const res = await fetch(`${this.baseUrl}/inbox/${encodeURIComponent(recipientAgentId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeOuterEnvelope(outer),
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
    options: { bonded_only?: boolean; senders?: string[] } = {},
  ): Promise<
    | {
        ok: true;
        wires: string[];
        rowids: number[];
        cursor: number;
        relay_gaps?: Array<{
          thread: string;
          last_good_seq: number;
          expected_seq?: number;
        }>;
        filtered_count?: number;
      }
    | { ok: false; error: string }
  > {
    const agentId = publicKeyToAgentId(keyPair.publicKey);
    const bondedOnly = options.bonded_only !== false;
    const bondedQuery = bondedOnly ? "" : "&bonded_only=0";
    const sendersQuery =
      options.senders && options.senders.length > 0
        ? `&senders=${encodeURIComponent(options.senders.join(","))}`
        : "";
    const challengeRes = await fetch(
      `${this.baseUrl}/inbox/${encodeURIComponent(agentId)}?since=${since}${bondedQuery}${sendersQuery}`,
    );
    if (challengeRes.status !== 401) {
      return { ok: false, error: "unexpected_challenge_status" };
    }

    const challengeBody = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challengeBody.challenge, keyPair.secretKey);
    const pullRes = await fetch(
      `${this.baseUrl}/inbox/${encodeURIComponent(agentId)}?since=${since}${bondedQuery}${sendersQuery}&challenge=${encodeURIComponent(challengeBody.challenge)}&sig=${encodeURIComponent(sig)}`,
    );

    if (!pullRes.ok) {
      return { ok: false, error: `inbox_pull_failed_${pullRes.status}` };
    }

    const payload = (await pullRes.json()) as {
      envelopes?: Array<string | Record<string, unknown>>;
      rowids?: number[];
      cursor?: number;
      gaps?: Array<{
        thread: string;
        last_good_seq: number;
        expected_seq?: number;
      }>;
      filtered_count?: number;
    };
    const wires = (payload.envelopes ?? []).map((raw) =>
      typeof raw === "string" ? raw : JSON.stringify(raw),
    );
    return {
      ok: true,
      wires,
      rowids: payload.rowids ?? [],
      cursor: payload.cursor ?? since,
      relay_gaps: payload.gaps,
      filtered_count: payload.filtered_count,
    };
  }

  async purgeInboxDyad(
    peerAgentId: string,
    keyPair: KeyPair,
  ): Promise<{ ok: true; deleted: number; peer_purged?: boolean } | { ok: false; error: string }> {
    const agentId = publicKeyToAgentId(keyPair.publicKey);
    const senderQuery = `sender=${encodeURIComponent(peerAgentId)}`;
    const challengeRes = await fetch(
      `${this.baseUrl}/inbox/${encodeURIComponent(agentId)}/purge?${senderQuery}`,
      { method: "DELETE" },
    );
    if (challengeRes.status !== 401) {
      return { ok: false, error: "unexpected_challenge_status" };
    }

    const challengeBody = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challengeBody.challenge, keyPair.secretKey);
    const purgeRes = await fetch(
      `${this.baseUrl}/inbox/${encodeURIComponent(agentId)}/purge?${senderQuery}&challenge=${encodeURIComponent(challengeBody.challenge)}&sig=${encodeURIComponent(sig)}`,
      { method: "DELETE" },
    );

    if (!purgeRes.ok) {
      return { ok: false, error: `inbox_purge_failed_${purgeRes.status}` };
    }

    const payload = (await purgeRes.json()) as { deleted?: number; peer_purged?: boolean };
    return { ok: true, deleted: payload.deleted ?? 0, peer_purged: payload.peer_purged };
  }

  async putArtifact(
    hash: string,
    blob: Uint8Array,
    agentId: string,
    secretKey: Uint8Array,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/artifact/${encodeURIComponent(hash)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-agent-id": agentId,
          "x-artifact-sig": signArtifactHash(hash, secretKey),
        },
        body: blob,
      });
    } catch {
      throw relayError("artifact_upload_failed");
    }

    if (res.status === 204) {
      return;
    }

    let error: string | undefined;
    try {
      const body = (await res.json()) as { error?: string };
      error = body.error;
    } catch {
      // non-JSON error bodies map to artifact_upload_failed
    }

    if (error === "hash_mismatch") {
      throw new Error("hash_mismatch");
    }

    if (error && PUT_ARTIFACT_PASSTHROUGH_ERRORS.has(error)) {
      throw relayError(error);
    }

    throw relayError("artifact_upload_failed");
  }

  async getArtifact(hash: string, size: number): Promise<Uint8Array> {
    const readLimit = artifactReadLimit(size);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/artifact/${encodeURIComponent(hash)}`);
    } catch {
      throw relayError("artifact_fetch_failed");
    }

    if (res.status === 404) {
      throw relayError("artifact_not_found");
    }

    if (!res.ok) {
      throw relayError("artifact_fetch_failed");
    }

    const body = new Uint8Array(await res.arrayBuffer());
    if (body.length > readLimit) {
      throw relayError("artifact_decrypt_failed");
    }

    return body;
  }
}
