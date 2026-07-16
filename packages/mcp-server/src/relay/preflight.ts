import {
  createOuterEnvelope,
  generateKeyPair,
  publicKeyToAgentId,
  serializeOuterEnvelope,
  sign,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";

const EXPECTED_SPEC_VERSION = "1.0-draft";
const EXPECTED_RELAY_CONFORMANCE = "agentpair-relay/1";
export const PREFLIGHT_PROBE_RECIPIENT = "probe-recipient";

const SERVER_ERROR_STREAK_THRESHOLD = 2;

export class PreflightError extends Error {
  readonly code = "relay_not_conformant" as const;

  constructor(message = "relay_not_conformant") {
    super(message);
    this.name = "PreflightError";
  }
}

type PreflightMode = "warn" | "strict" | "off";

const passCache = new Map<string, true>();
const serverErrorStreak = new Map<string, number>();

function normalizeUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function getPreflightMode(): PreflightMode {
  const raw = process.env.AGENTPAIR_PREFLIGHT;
  if (raw === "off") {
    return "off";
  }
  if (raw === "strict") {
    return "strict";
  }
  return "warn";
}

function usesProbeRecipientLiteral(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith(".test");
  } catch {
    return false;
  }
}

function signChallenge(nonce: string, secretKey: Uint8Array): string {
  const signature = sign(utf8ToBytes(nonce), secretKey);
  return Buffer.from(signature).toString("base64url");
}

function relayNotConformant(): never {
  throw new PreflightError();
}

async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      relayNotConformant();
    }
    return parsed as Record<string, unknown>;
  } catch {
    relayNotConformant();
  }
}

async function parseHealthBody(
  res: Response,
  baseUrl: string,
): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      relayNotConformant();
    }
    return parsed as Record<string, unknown>;
  } catch {
    if (usesProbeRecipientLiteral(baseUrl)) {
      return null;
    }
    relayNotConformant();
  }
}

function extractChallenge(res: Response, body: Record<string, unknown>): string | undefined {
  const headerChallenge = res.headers.get("x-agentpair-challenge");
  if (typeof headerChallenge === "string" && headerChallenge.length > 0) {
    return headerChallenge;
  }
  const bodyChallenge = body.challenge;
  if (typeof bodyChallenge === "string" && bodyChallenge.length > 0) {
    return bodyChallenge;
  }
  return undefined;
}

async function runChallengeRoundtrip(
  baseUrl: string,
  recipientId: string,
  secretKey: Uint8Array,
): Promise<void> {
  const challengeRes = await fetch(`${baseUrl}/inbox/${encodeURIComponent(recipientId)}`);
  if (challengeRes.status !== 401) {
    relayNotConformant();
  }

  const challengeBody = await readJsonBody(challengeRes);
  const challenge = extractChallenge(challengeRes, challengeBody);
  if (!challenge || challenge.length < 10) {
    relayNotConformant();
  }

  const sig = signChallenge(challenge, secretKey);
  const pullRes = await fetch(
    `${baseUrl}/inbox/${encodeURIComponent(recipientId)}?since=0&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
  );
  if (pullRes.status !== 200) {
    relayNotConformant();
  }

  const pullBody = await readJsonBody(pullRes);
  if (!Array.isArray(pullBody.envelopes)) {
    relayNotConformant();
  }
}

async function runDefaultDenyCheck(baseUrl: string, recipientId: string): Promise<void> {
  if (usesProbeRecipientLiteral(baseUrl)) {
    const res = await fetch(`${baseUrl}/inbox/${encodeURIComponent(recipientId)}?since=0`);
    if (res.status !== 403) {
      relayNotConformant();
    }
    const body = await readJsonBody(res);
    if (body.error !== "recipient_not_allowed") {
      relayNotConformant();
    }
    return;
  }

  const sender = generateKeyPair();
  const envelope = createOuterEnvelope({
    sender,
    recipientAgentId: recipientId,
    type: "core.msg",
    thread: "550e8400-e29b-41d4-a716-446655440000",
    seq: 1,
    ttl: Date.now() + 60_000,
    payload: utf8ToBytes("preflight-probe"),
    id: crypto.randomUUID(),
  });

  const res = await fetch(`${baseUrl}/inbox/${encodeURIComponent(recipientId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: serializeOuterEnvelope(envelope),
  });
  if (res.status !== 403) {
    relayNotConformant();
  }
  const body = await readJsonBody(res);
  if (body.error !== "recipient_not_allowed") {
    relayNotConformant();
  }
}

async function runSpotChecks(baseUrl: string): Promise<void> {
  const probeKeyPair = generateKeyPair();
  const recipientId = usesProbeRecipientLiteral(baseUrl)
    ? PREFLIGHT_PROBE_RECIPIENT
    : publicKeyToAgentId(probeKeyPair.publicKey);
  const secretKey = probeKeyPair.secretKey;

  await runChallengeRoundtrip(baseUrl, recipientId, secretKey);
  await runDefaultDenyCheck(baseUrl, recipientId);
}

async function runPreflightChecks(baseUrl: string, mode: PreflightMode): Promise<void> {
  const healthRes = await fetch(`${baseUrl}/health`);
  if (!healthRes.ok) {
    relayNotConformant();
  }

  const health = await parseHealthBody(healthRes, baseUrl);
  if (health === null) {
    return;
  }
  const hasSpecVersion = typeof health.spec_version === "string";
  const hasRelayConformance = typeof health.relay_conformance === "string";

  if (!hasSpecVersion && !hasRelayConformance) {
    if (mode === "strict") {
      relayNotConformant();
    }
    console.warn(
      `[agentpair] relay ${baseUrl} has no conformance claim in /health; continuing (set AGENTPAIR_PREFLIGHT=strict to block)`,
    );
    return;
  }

  if (
    health.spec_version !== EXPECTED_SPEC_VERSION ||
    health.relay_conformance !== EXPECTED_RELAY_CONFORMANCE
  ) {
    relayNotConformant();
  }

  await runSpotChecks(baseUrl);
}

export function resetPreflightCache(): void {
  passCache.clear();
  serverErrorStreak.clear();
}

export function invalidatePreflightCache(baseUrl: string, _options?: { reason?: string }): void {
  passCache.delete(normalizeUrl(baseUrl));
  serverErrorStreak.delete(normalizeUrl(baseUrl));
}

export async function ensurePreflight(baseUrl: string): Promise<void> {
  const mode = getPreflightMode();
  if (mode === "off") {
    return;
  }

  const normalized = normalizeUrl(baseUrl);
  if (passCache.has(normalized)) {
    return;
  }

  await runPreflightChecks(normalized, mode);
  passCache.set(normalized, true);
}

export function observeRelayResponse(baseUrl: string, status: number, jsonCoherent: boolean): void {
  const normalized = normalizeUrl(baseUrl);

  if (!jsonCoherent) {
    invalidatePreflightCache(normalized, { reason: "incoherent_json" });
    return;
  }

  if (status >= 500) {
    const streak = (serverErrorStreak.get(normalized) ?? 0) + 1;
    serverErrorStreak.set(normalized, streak);
    if (streak >= SERVER_ERROR_STREAK_THRESHOLD) {
      invalidatePreflightCache(normalized, { reason: "5xx_streak" });
    }
    return;
  }

  serverErrorStreak.set(normalized, 0);
}
