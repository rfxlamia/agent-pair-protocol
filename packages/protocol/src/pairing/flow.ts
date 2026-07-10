import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeBase64UrlStrict, encodeBase64Url } from "../crypto/base64url.js";
import { type KeyPair, publicKeyToAgentId } from "../crypto/keys.js";
import { generatePairingCode } from "./pairing-words.js";
import { type PakeSessionHandle, finish, init, respond, start } from "./pake-adapter.js";

export const PAIR_TTL_MS = 5 * 60 * 1000;

export type BondMode = "ephemeral_until_session_closes" | "bonded_contact";

export interface Bond {
  peer: string;
  scope: string[];
  mode: BondMode;
}

export interface PairProposal {
  scope: string[];
  mode: BondMode;
  initiatorAgentId: string;
}

export interface PendingPair {
  code: string;
  sessionId: string;
  proposal: PairProposal;
  createdAt: number;
  expiresAt: number;
  rejectReason?: string;
  rolledBack?: boolean;
  initiatorSession?: PakeSessionHandle;
}

export interface PairingRelayClient {
  postPakeMessage(sessionId: string, body: string): Promise<void>;
  pollPakeMessage(sessionId: string, timeoutMs?: number): Promise<string | null>;
  putAllowlist(agentId: string, allowed: string[], secretKey: Uint8Array): Promise<{ ok: boolean }>;
}

export interface PairingRegistry {
  register(entry: PendingPair): void;
  lookup(code: string): PendingPair | undefined;
  update(code: string, patch: Partial<PendingPair>): void;
}

export interface LocalAllowlistStore {
  get(agentId: string): string[];
  set(agentId: string, allowed: string[]): void;
}

export class InMemoryPairingRegistry implements PairingRegistry {
  private entries = new Map<string, PendingPair>();

  register(entry: PendingPair): void {
    this.entries.set(entry.code, entry);
  }

  lookup(code: string): PendingPair | undefined {
    return this.entries.get(code);
  }

  update(code: string, patch: Partial<PendingPair>): void {
    const existing = this.entries.get(code);
    if (!existing) {
      return;
    }
    this.entries.set(code, { ...existing, ...patch });
  }
}

type PairWireMessage =
  | { phase: "pake"; payload: string; role: "initiator" | "joiner" }
  | { phase: "confirm"; fingerprint: string; agentId: string }
  | { phase: "reject"; reason: string }
  | { phase: "bond_ok" }
  | { phase: "bond_fail" };

export type PairFlowResult =
  | { status: "bonded"; bond: Bond }
  | { status: "rejected"; reason: string }
  | { status: "pake_failed" }
  | { status: "rolled_back" }
  | { status: "not_found" }
  | { status: "expired" };

export interface PairInitOutput {
  code: string;
  sessionId: string;
  proposal: PairProposal;
  expiresAt: number;
}

function generateSessionId(): string {
  return crypto.randomUUID();
}

function encodeWireMessage(message: PairWireMessage): string {
  return JSON.stringify(message);
}

function decodeWireMessage(raw: string): PairWireMessage {
  return JSON.parse(raw) as PairWireMessage;
}

function encodePakePayload(message: Uint8Array): string {
  return encodeBase64Url(message);
}

function decodePakePayload(payload: string): Uint8Array {
  return decodeBase64UrlStrict(payload);
}

function keyFingerprint(sharedKey: Uint8Array): string {
  return bytesToHex(sha256(sharedKey));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const BOND_COORDINATION_TIMEOUT_MS = 30_000;
/** Human-gated pairing can take minutes between pair_join and human_approve. */
const PAKE_HANDSHAKE_TIMEOUT_MS = PAIR_TTL_MS;

async function pollWireMessage(
  relay: PairingRelayClient,
  sessionId: string,
  predicate: (message: PairWireMessage) => boolean,
  timeoutMs = 1500,
): Promise<PairWireMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const raw = await relay.pollPakeMessage(sessionId, Math.min(remaining, 500));
    if (raw) {
      const message = decodeWireMessage(raw);
      if (predicate(message)) {
        return message;
      }
    }
    await sleep(10);
  }
  return null;
}

function lookupPending(registry: PairingRegistry, code: string): PendingPair | PairFlowResult {
  const pending = registry.lookup(code);
  if (!pending) {
    return { status: "not_found" };
  }
  if (pending.expiresAt < Date.now()) {
    return { status: "expired" };
  }
  return pending;
}

async function pushAllowlist(
  relay: PairingRelayClient,
  localAllowlist: LocalAllowlistStore,
  agentId: string,
  allowed: string[],
  secretKey: Uint8Array,
): Promise<boolean> {
  localAllowlist.set(agentId, allowed);
  const result = await relay.putAllowlist(agentId, allowed, secretKey);
  return result.ok;
}

async function rollbackAllowlist(
  relay: PairingRelayClient,
  localAllowlist: LocalAllowlistStore,
  agentId: string,
  previous: string[],
  secretKey: Uint8Array,
): Promise<void> {
  localAllowlist.set(agentId, previous);
  await relay.putAllowlist(agentId, previous, secretKey);
}

export async function pairInit(input: {
  scope: string[];
  mode: BondMode;
  keyPair: KeyPair;
  relay: PairingRelayClient;
  registry: PairingRegistry;
}): Promise<PairInitOutput> {
  await init();

  const code = generatePairingCode();
  const sessionId = generateSessionId();
  const createdAt = Date.now();
  const expiresAt = createdAt + PAIR_TTL_MS;
  const initiatorAgentId = publicKeyToAgentId(input.keyPair.publicKey);
  const proposal: PairProposal = {
    scope: [...input.scope],
    mode: input.mode,
    initiatorAgentId,
  };

  const { message, session } = start("initiator", code, sessionId);
  input.registry.register({
    code,
    sessionId,
    proposal,
    createdAt,
    expiresAt,
    initiatorSession: session,
  });

  await input.relay.postPakeMessage(
    sessionId,
    encodeWireMessage({
      phase: "pake",
      payload: encodePakePayload(message),
      role: "initiator",
    }),
  );

  return { code, sessionId, proposal, expiresAt };
}

export async function pairRetry(input: {
  code: string;
  keyPair: KeyPair;
  relay: PairingRelayClient;
  registry: PairingRegistry;
}): Promise<PairInitOutput> {
  const pendingResult = lookupPending(input.registry, input.code);
  if ("status" in pendingResult) {
    throw new Error(`Cannot retry: ${pendingResult.status}`);
  }

  await init();

  const sessionId = generateSessionId();
  input.registry.update(input.code, {
    sessionId,
    rolledBack: false,
    rejectReason: undefined,
  });

  const { message, session } = start("initiator", input.code, sessionId);
  input.registry.update(input.code, { initiatorSession: session });
  await input.relay.postPakeMessage(
    sessionId,
    encodeWireMessage({
      phase: "pake",
      payload: encodePakePayload(message),
      role: "initiator",
    }),
  );

  return {
    code: input.code,
    sessionId,
    proposal: pendingResult.proposal,
    expiresAt: pendingResult.expiresAt,
  };
}

export async function pairJoin(input: {
  code: string;
  pakeCode?: string;
  keyPair: KeyPair;
  relay: PairingRelayClient;
  registry: PairingRegistry;
  localAllowlist: LocalAllowlistStore;
  decision: { approve: true } | { reject: string };
}): Promise<PairFlowResult> {
  const pendingResult = lookupPending(input.registry, input.code);
  if ("status" in pendingResult) {
    return pendingResult;
  }

  const pending = pendingResult;
  const joinerAgentId = publicKeyToAgentId(input.keyPair.publicKey);

  if ("reject" in input.decision) {
    await input.relay.postPakeMessage(
      pending.sessionId,
      encodeWireMessage({
        phase: "reject",
        reason: input.decision.reject,
      }),
    );
    input.registry.update(input.code, { rejectReason: input.decision.reject });
    return { status: "rejected", reason: input.decision.reject };
  }

  await init();

  const pakeCode = input.pakeCode ?? input.code;
  const initiatorWire = await pollWireMessage(
    input.relay,
    pending.sessionId,
    (message) => message.phase === "pake" && message.role === "initiator",
  );
  if (!initiatorWire || initiatorWire.phase !== "pake") {
    return { status: "pake_failed" };
  }

  let initiatorMessage: Uint8Array;
  try {
    initiatorMessage = decodePakePayload(initiatorWire.payload);
  } catch {
    return { status: "pake_failed" };
  }
  const joiner = respond(pakeCode, pending.sessionId, initiatorMessage);
  await input.relay.postPakeMessage(
    pending.sessionId,
    encodeWireMessage({
      phase: "pake",
      payload: encodePakePayload(joiner.message),
      role: "joiner",
    }),
  );

  const sharedKey = finish(joiner.session, initiatorMessage);
  const fingerprint = keyFingerprint(sharedKey);

  const peerConfirm = await pollWireMessage(
    input.relay,
    pending.sessionId,
    (message) => message.phase === "confirm" && message.agentId !== joinerAgentId,
    BOND_COORDINATION_TIMEOUT_MS,
  );
  if (!peerConfirm || peerConfirm.phase !== "confirm") {
    return { status: "pake_failed" };
  }
  if (peerConfirm.fingerprint !== fingerprint) {
    await input.relay.postPakeMessage(pending.sessionId, encodeWireMessage({ phase: "bond_fail" }));
    return { status: "pake_failed" };
  }

  await input.relay.postPakeMessage(
    pending.sessionId,
    encodeWireMessage({
      phase: "confirm",
      fingerprint,
      agentId: joinerAgentId,
    }),
  );

  const bond: Bond = {
    peer: pending.proposal.initiatorAgentId,
    scope: [...pending.proposal.scope],
    mode: pending.proposal.mode,
  };

  const bondOk = await pollWireMessage(
    input.relay,
    pending.sessionId,
    (message) => message.phase === "bond_ok" || message.phase === "bond_fail",
    BOND_COORDINATION_TIMEOUT_MS,
  );
  if (!bondOk || bondOk.phase === "bond_fail") {
    return { status: "rolled_back" };
  }

  const previousAllowed = input.localAllowlist.get(joinerAgentId);
  const nextAllowed = [...new Set([...previousAllowed, bond.peer])];
  const joinerPushOk = await pushAllowlist(
    input.relay,
    input.localAllowlist,
    joinerAgentId,
    nextAllowed,
    input.keyPair.secretKey,
  );
  if (!joinerPushOk) {
    await rollbackAllowlist(
      input.relay,
      input.localAllowlist,
      joinerAgentId,
      previousAllowed,
      input.keyPair.secretKey,
    );
    await input.relay.postPakeMessage(pending.sessionId, encodeWireMessage({ phase: "bond_fail" }));
    input.registry.update(input.code, { rolledBack: true });
    return { status: "rolled_back" };
  }

  return { status: "bonded", bond };
}

export async function pairInitComplete(input: {
  code: string;
  keyPair: KeyPair;
  relay: PairingRelayClient;
  registry: PairingRegistry;
  localAllowlist: LocalAllowlistStore;
}): Promise<PairFlowResult> {
  const pendingResult = lookupPending(input.registry, input.code);
  if ("status" in pendingResult) {
    return pendingResult;
  }

  const pending = pendingResult;
  const initiatorAgentId = publicKeyToAgentId(input.keyPair.publicKey);

  const latestWire = await input.relay.pollPakeMessage(pending.sessionId);
  if (latestWire) {
    const wire = decodeWireMessage(latestWire);
    if (wire.phase === "reject") {
      input.registry.update(input.code, { rejectReason: wire.reason });
      return { status: "rejected", reason: wire.reason };
    }
  }

  if (pending.rejectReason) {
    return { status: "rejected", reason: pending.rejectReason };
  }

  await init();

  const joinerWire = await pollWireMessage(
    input.relay,
    pending.sessionId,
    (message) => message.phase === "pake" && message.role === "joiner",
    PAKE_HANDSHAKE_TIMEOUT_MS,
  );
  if (!joinerWire || joinerWire.phase !== "pake") {
    return { status: "pake_failed" };
  }

  if (!pending.initiatorSession) {
    return { status: "pake_failed" };
  }

  let joinerMessage: Uint8Array;
  try {
    joinerMessage = decodePakePayload(joinerWire.payload);
  } catch {
    return { status: "pake_failed" };
  }
  const sharedKey = finish(pending.initiatorSession, joinerMessage);
  const fingerprint = keyFingerprint(sharedKey);

  await input.relay.postPakeMessage(
    pending.sessionId,
    encodeWireMessage({
      phase: "confirm",
      fingerprint,
      agentId: initiatorAgentId,
    }),
  );

  const joinerConfirm = await pollWireMessage(
    input.relay,
    pending.sessionId,
    (message) => message.phase === "confirm" && message.agentId !== initiatorAgentId,
  );
  if (!joinerConfirm || joinerConfirm.phase !== "confirm") {
    return { status: "pake_failed" };
  }
  if (joinerConfirm.fingerprint !== fingerprint) {
    return { status: "pake_failed" };
  }

  const bond: Bond = {
    peer: joinerConfirm.agentId,
    scope: [...pending.proposal.scope],
    mode: pending.proposal.mode,
  };

  const previousAllowed = input.localAllowlist.get(initiatorAgentId);
  const nextAllowed = [...new Set([...previousAllowed, bond.peer])];
  const initiatorPushOk = await pushAllowlist(
    input.relay,
    input.localAllowlist,
    initiatorAgentId,
    nextAllowed,
    input.keyPair.secretKey,
  );

  if (!initiatorPushOk) {
    await rollbackAllowlist(
      input.relay,
      input.localAllowlist,
      initiatorAgentId,
      previousAllowed,
      input.keyPair.secretKey,
    );
    await input.relay.postPakeMessage(pending.sessionId, encodeWireMessage({ phase: "bond_fail" }));
    input.registry.update(input.code, { rolledBack: true });
    return { status: "rolled_back" };
  }

  await input.relay.postPakeMessage(pending.sessionId, encodeWireMessage({ phase: "bond_ok" }));

  const bondFail = await pollWireMessage(
    input.relay,
    pending.sessionId,
    (message) => message.phase === "bond_fail",
    1000,
  );
  if (bondFail) {
    await rollbackAllowlist(
      input.relay,
      input.localAllowlist,
      initiatorAgentId,
      previousAllowed,
      input.keyPair.secretKey,
    );
    input.registry.update(input.code, { rolledBack: true });
    return { status: "rolled_back" };
  }

  return { status: "bonded", bond };
}
