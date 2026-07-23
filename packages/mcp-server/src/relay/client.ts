import {
  type KeyPair,
  MAX_SPILLOVER_PLAINTEXT_BYTES,
  type OuterEnvelope,
  type PairingRelayClient,
  encodeAllowlistPush,
  publicKeyToAgentId,
  serializeOuterEnvelope,
  sign,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { parseRetryAfterMs } from "./inbox-pull-errors.js";
import { ensurePreflight, observeRelayResponse } from "./preflight.js";

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

  private async guardPreflight(): Promise<void> {
    await ensurePreflight(this.baseUrl);
  }

  private noteRelayResponse(status: number, jsonCoherent = true): void {
    observeRelayResponse(this.baseUrl, status, jsonCoherent);
  }

  async postPakeMessage(sessionId: string, body: string): Promise<void> {
    await this.guardPreflight();
    const res = await fetch(`${this.baseUrl}/pair/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    this.noteRelayResponse(res.status);
    if (!res.ok) {
      throw new Error(`relay pair post failed: ${res.status}`);
    }
  }

  async pollPakeMessage(sessionId: string, timeoutMs = 1500): Promise<string | null> {
    await this.guardPreflight();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${this.baseUrl}/pair/${encodeURIComponent(sessionId)}`);
      this.noteRelayResponse(res.status);
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
    await this.guardPreflight();
    const body = encodeAllowlistPush(agentId, allowed, secretKey);
    const res = await fetch(`${this.baseUrl}/allowlist/${encodeURIComponent(agentId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    this.noteRelayResponse(res.status);
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
    await this.guardPreflight();
    const res = await fetch(`${this.baseUrl}/inbox/${encodeURIComponent(recipientAgentId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeOuterEnvelope(outer),
    });
    this.noteRelayResponse(res.status);
    if (!res.ok) {
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
    | { ok: false; error: string; retry_after_ms?: number }
  > {
    await this.guardPreflight();
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
      this.noteRelayResponse(challengeRes.status);
      if (challengeRes.status === 429) {
        const retry_after_ms = parseRetryAfterMs(challengeRes.headers.get("Retry-After"));
        return {
          ok: false,
          error: "inbox_pull_failed_429",
          ...(retry_after_ms !== undefined ? { retry_after_ms } : {}),
        };
      }
      return { ok: false, error: "unexpected_challenge_status" };
    }

    let challengeBody: { challenge: string };
    try {
      challengeBody = (await challengeRes.json()) as { challenge: string };
    } catch {
      this.noteRelayResponse(challengeRes.status, false);
      return { ok: false, error: "unexpected_challenge_status" };
    }
    const sig = signChallenge(challengeBody.challenge, keyPair.secretKey);
    const pullRes = await fetch(
      `${this.baseUrl}/inbox/${encodeURIComponent(agentId)}?since=${since}${bondedQuery}${sendersQuery}&challenge=${encodeURIComponent(challengeBody.challenge)}&sig=${encodeURIComponent(sig)}`,
    );

    if (!pullRes.ok) {
      this.noteRelayResponse(pullRes.status);
      if (pullRes.status === 429) {
        const retry_after_ms = parseRetryAfterMs(pullRes.headers.get("Retry-After"));
        return {
          ok: false,
          error: "inbox_pull_failed_429",
          ...(retry_after_ms !== undefined ? { retry_after_ms } : {}),
        };
      }
      return { ok: false, error: `inbox_pull_failed_${pullRes.status}` };
    }

    let payload: {
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
    try {
      payload = (await pullRes.json()) as typeof payload;
    } catch {
      this.noteRelayResponse(pullRes.status, false);
      return { ok: false, error: "inbox_pull_failed_parse" };
    }
    this.noteRelayResponse(pullRes.status);
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
    await this.guardPreflight();
    const agentId = publicKeyToAgentId(keyPair.publicKey);
    const senderQuery = `sender=${encodeURIComponent(peerAgentId)}`;
    const challengeRes = await fetch(
      `${this.baseUrl}/inbox/${encodeURIComponent(agentId)}/purge?${senderQuery}`,
      { method: "DELETE" },
    );
    if (challengeRes.status !== 401) {
      this.noteRelayResponse(challengeRes.status);
      return { ok: false, error: "unexpected_challenge_status" };
    }

    let challengeBody: { challenge: string };
    try {
      challengeBody = (await challengeRes.json()) as { challenge: string };
    } catch {
      this.noteRelayResponse(challengeRes.status, false);
      return { ok: false, error: "unexpected_challenge_status" };
    }
    const sig = signChallenge(challengeBody.challenge, keyPair.secretKey);
    const purgeRes = await fetch(
      `${this.baseUrl}/inbox/${encodeURIComponent(agentId)}/purge?${senderQuery}&challenge=${encodeURIComponent(challengeBody.challenge)}&sig=${encodeURIComponent(sig)}`,
      { method: "DELETE" },
    );

    if (!purgeRes.ok) {
      this.noteRelayResponse(purgeRes.status);
      return { ok: false, error: `inbox_purge_failed_${purgeRes.status}` };
    }

    let payload: { deleted?: number; peer_purged?: boolean };
    try {
      payload = (await purgeRes.json()) as { deleted?: number; peer_purged?: boolean };
    } catch {
      this.noteRelayResponse(purgeRes.status, false);
      return { ok: false, error: "inbox_purge_failed_parse" };
    }
    this.noteRelayResponse(purgeRes.status);
    return { ok: true, deleted: payload.deleted ?? 0, peer_purged: payload.peer_purged };
  }

  async putArtifact(
    hash: string,
    blob: Uint8Array,
    agentId: string,
    secretKey: Uint8Array,
  ): Promise<void> {
    await this.guardPreflight();
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
      this.noteRelayResponse(res.status);
      return;
    }

    let error: string | undefined;
    let jsonCoherent = true;
    try {
      const body = (await res.json()) as { error?: string };
      error = body.error;
    } catch {
      jsonCoherent = false;
      // non-JSON error bodies map to artifact_upload_failed
    }
    this.noteRelayResponse(res.status, jsonCoherent);

    if (error === "hash_mismatch") {
      throw new Error("hash_mismatch");
    }

    if (error && PUT_ARTIFACT_PASSTHROUGH_ERRORS.has(error)) {
      throw relayError(error);
    }

    throw relayError("artifact_upload_failed");
  }

  async getArtifact(hash: string, size: number): Promise<Uint8Array> {
    await this.guardPreflight();
    const readLimit = artifactReadLimit(size);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/artifact/${encodeURIComponent(hash)}`);
    } catch {
      throw relayError("artifact_fetch_failed");
    }

    if (res.status === 404) {
      this.noteRelayResponse(res.status);
      throw relayError("artifact_not_found");
    }

    if (!res.ok) {
      this.noteRelayResponse(res.status);
      throw relayError("artifact_fetch_failed");
    }
    this.noteRelayResponse(res.status);

    const body = new Uint8Array(await res.arrayBuffer());
    if (body.length > readLimit) {
      throw relayError("artifact_decrypt_failed");
    }

    return body;
  }
}
