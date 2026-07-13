import { decodeBase64UrlStrict, encodeBase64Url } from "../crypto/base64url.js";
import { type KeyPair, publicKeyToAgentId } from "../crypto/keys.js";
import { intersectProfiles } from "../profile/intersect.js";
import { REFERENCE_PROFILES } from "../profile/reference.js";
import { parseProfilesWire } from "../profile/wire-schema.js";
import { pairBondOkTag } from "./pair-bond-ok-tag.js";
import { pairConfirmFingerprintV2 } from "./pair-confirm-fingerprint.js";
import { generatePairingCode } from "./pairing-words.js";
import { type PakeSessionHandle, finish, init, respond, start } from "./pake-adapter.js";

export const PAIR_TTL_MS = 5 * 60 * 1000;

export type BondMode = "ephemeral_until_session_closes" | "bonded_contact";

export type RolledBackReason =
  | "profile_not_supported"
  | "bond_aborted"
  | "bond_tag_mismatch"
  | "allowlist_push_failed";

export interface Bond {
  peer: string;
  scope: string[];
  mode: BondMode;
  profiles: string[];
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
  consumePakeMessage?(sessionId: string): void;
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
  | { phase: "pake"; payload: string; role: "initiator"; profiles: string[] }
  | {
      phase: "pake";
      payload: string;
      role: "joiner";
      fingerprint: string;
      agentId: string;
      profiles: string[];
    }
  | { phase: "confirm"; fingerprint: string; agentId: string }
  | { phase: "reject"; reason: string }
  | { phase: "bond_ok"; agentId: string; tag: string }
  | { phase: "bond_fail" };

export type PairFlowResult =
  | { status: "bonded"; bond: Bond }
  | { status: "rejected"; reason: string }
  | { status: "pake_failed" }
  | { status: "rolled_back"; reason: RolledBackReason }
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

function resolveOwnProfiles(profiles?: string[]): string[] {
  const parsed = parseProfilesWire(profiles ?? [...REFERENCE_PROFILES]);
  if (!parsed.ok) {
    throw new Error(`invalid profiles: ${parsed.error}`);
  }
  return parsed.profiles;
}

function parseWireProfiles(value: unknown): string[] | null {
  const parsed = parseProfilesWire(value);
  return parsed.ok ? parsed.profiles : null;
}

function parseConfirmMessage(
  wire: PairWireMessage,
): { fingerprint: string; agentId: string } | null {
  if (wire.phase !== "confirm") {
    return null;
  }
  if (typeof wire.fingerprint !== "string" || wire.fingerprint.length === 0) {
    return null;
  }
  if (typeof wire.agentId !== "string" || wire.agentId.length === 0) {
    return null;
  }
  return { fingerprint: wire.fingerprint, agentId: wire.agentId };
}

function parseInitiatorPake(wire: PairWireMessage): { payload: string; profiles: string[] } | null {
  if (wire.phase !== "pake" || wire.role !== "initiator") {
    return null;
  }
  if (typeof wire.payload !== "string" || wire.payload.length === 0) {
    return null;
  }
  const profiles = parseWireProfiles(wire.profiles);
  if (!profiles) {
    return null;
  }
  return { payload: wire.payload, profiles };
}

function parseJoinerPakeWithConfirm(
  wire: PairWireMessage,
): { payload: string; fingerprint: string; agentId: string; profiles: string[] } | null {
  if (wire.phase !== "pake" || wire.role !== "joiner") {
    return null;
  }
  if (typeof wire.payload !== "string" || wire.payload.length === 0) {
    return null;
  }
  if (typeof wire.fingerprint !== "string" || wire.fingerprint.length === 0) {
    return null;
  }
  if (typeof wire.agentId !== "string" || wire.agentId.length === 0) {
    return null;
  }
  const profiles = parseWireProfiles(wire.profiles);
  if (!profiles) {
    return null;
  }
  return {
    payload: wire.payload,
    fingerprint: wire.fingerprint,
    agentId: wire.agentId,
    profiles,
  };
}

function parseBondOkMessage(wire: PairWireMessage): { agentId: string; tag: string } | null {
  if (wire.phase !== "bond_ok") {
    return null;
  }
  if (typeof wire.agentId !== "string" || wire.agentId.length === 0) {
    return null;
  }
  if (typeof wire.tag !== "string" || wire.tag.length === 0) {
    return null;
  }
  return { agentId: wire.agentId, tag: wire.tag };
}

function bondOkTagMatches(sharedKey: Uint8Array, agentId: string, tag: string): boolean {
  return pairBondOkTag(sharedKey, agentId) === tag;
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
        relay.consumePakeMessage?.(sessionId);
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
  profiles?: string[];
}): Promise<PairInitOutput> {
  await init();

  const profiles = resolveOwnProfiles(input.profiles);
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
      profiles,
    }),
  );

  return { code, sessionId, proposal, expiresAt };
}

export async function pairRetry(input: {
  code: string;
  keyPair: KeyPair;
  relay: PairingRelayClient;
  registry: PairingRegistry;
  profiles?: string[];
}): Promise<PairInitOutput> {
  const pendingResult = lookupPending(input.registry, input.code);
  if ("status" in pendingResult) {
    throw new Error(`Cannot retry: ${pendingResult.status}`);
  }

  await init();

  const profiles = resolveOwnProfiles(input.profiles);
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
      profiles,
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
  profiles?: string[];
}): Promise<PairFlowResult> {
  const pendingResult = lookupPending(input.registry, input.code);
  if ("status" in pendingResult) {
    return pendingResult;
  }

  const pending = pendingResult;
  const joinerAgentId = publicKeyToAgentId(input.keyPair.publicKey);
  const profilesJoin = resolveOwnProfiles(input.profiles);

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
  if (!initiatorWire) {
    return { status: "pake_failed" };
  }
  const initiatorPake = parseInitiatorPake(initiatorWire);
  if (!initiatorPake) {
    return { status: "pake_failed" };
  }

  let initiatorMessage: Uint8Array;
  try {
    initiatorMessage = decodePakePayload(initiatorPake.payload);
  } catch {
    return { status: "pake_failed" };
  }
  const joiner = respond(pakeCode, pending.sessionId, initiatorMessage);
  const sharedKey = finish(joiner.session, initiatorMessage);
  const profilesInit = initiatorPake.profiles;

  await input.relay.postPakeMessage(
    pending.sessionId,
    encodeWireMessage({
      phase: "pake",
      payload: encodePakePayload(joiner.message),
      role: "joiner",
      fingerprint: pairConfirmFingerprintV2(
        sharedKey,
        pending.proposal.initiatorAgentId,
        joinerAgentId,
        profilesInit,
        profilesJoin,
      ),
      agentId: joinerAgentId,
      profiles: profilesJoin,
    }),
  );

  const initiatorWireConfirm = await pollWireMessage(
    input.relay,
    pending.sessionId,
    (message) =>
      message.phase === "bond_fail" ||
      (message.phase === "confirm" && message.agentId !== joinerAgentId),
    BOND_COORDINATION_TIMEOUT_MS,
  );
  if (!initiatorWireConfirm || initiatorWireConfirm.phase === "bond_fail") {
    await input.relay.postPakeMessage(pending.sessionId, encodeWireMessage({ phase: "bond_fail" }));
    return { status: "pake_failed" };
  }

  const initiatorConfirm = parseConfirmMessage(initiatorWireConfirm);
  if (!initiatorConfirm) {
    await input.relay.postPakeMessage(pending.sessionId, encodeWireMessage({ phase: "bond_fail" }));
    return { status: "pake_failed" };
  }

  const expectedInitiatorFingerprint = pairConfirmFingerprintV2(
    sharedKey,
    pending.proposal.initiatorAgentId,
    joinerAgentId,
    profilesInit,
    profilesJoin,
  );
  if (
    initiatorConfirm.fingerprint !== expectedInitiatorFingerprint ||
    initiatorConfirm.agentId !== pending.proposal.initiatorAgentId
  ) {
    await input.relay.postPakeMessage(pending.sessionId, encodeWireMessage({ phase: "bond_fail" }));
    return { status: "pake_failed" };
  }

  const contractProfiles = intersectProfiles(profilesInit, profilesJoin);
  if (contractProfiles.length === 0) {
    return { status: "rolled_back", reason: "profile_not_supported" };
  }

  const bond: Bond = {
    peer: pending.proposal.initiatorAgentId,
    scope: [...pending.proposal.scope],
    mode: pending.proposal.mode,
    profiles: contractProfiles,
  };

  await input.relay.postPakeMessage(
    pending.sessionId,
    encodeWireMessage({
      phase: "bond_ok",
      agentId: joinerAgentId,
      tag: pairBondOkTag(sharedKey, joinerAgentId),
    }),
  );

  const peerBondWire = await pollWireMessage(
    input.relay,
    pending.sessionId,
    (message) =>
      message.phase === "bond_fail" ||
      (message.phase === "bond_ok" && message.agentId !== joinerAgentId),
    BOND_COORDINATION_TIMEOUT_MS,
  );
  if (!peerBondWire || peerBondWire.phase === "bond_fail") {
    return { status: "rolled_back", reason: "bond_aborted" };
  }
  const peerBond = parseBondOkMessage(peerBondWire);
  if (
    !peerBond ||
    peerBond.agentId !== pending.proposal.initiatorAgentId ||
    !bondOkTagMatches(sharedKey, peerBond.agentId, peerBond.tag)
  ) {
    return { status: "rolled_back", reason: "bond_tag_mismatch" };
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
    return { status: "rolled_back", reason: "allowlist_push_failed" };
  }

  return { status: "bonded", bond };
}

export async function pairInitComplete(input: {
  code: string;
  keyPair: KeyPair;
  relay: PairingRelayClient;
  registry: PairingRegistry;
  localAllowlist: LocalAllowlistStore;
  profiles?: string[];
}): Promise<PairFlowResult> {
  const pendingResult = lookupPending(input.registry, input.code);
  if ("status" in pendingResult) {
    return pendingResult;
  }

  const pending = pendingResult;
  const initiatorAgentId = publicKeyToAgentId(input.keyPair.publicKey);
  const profilesInit = resolveOwnProfiles(input.profiles);

  if (pending.rejectReason) {
    return { status: "rejected", reason: pending.rejectReason };
  }

  await init();

  const joinerWire = await pollWireMessage(
    input.relay,
    pending.sessionId,
    (message) =>
      message.phase === "bond_fail" || (message.phase === "pake" && message.role === "joiner"),
    PAKE_HANDSHAKE_TIMEOUT_MS,
  );
  if (!joinerWire || joinerWire.phase === "bond_fail") {
    return { status: "pake_failed" };
  }
  const joinerPake = parseJoinerPakeWithConfirm(joinerWire);
  if (!joinerPake) {
    await input.relay.postPakeMessage(pending.sessionId, encodeWireMessage({ phase: "bond_fail" }));
    return { status: "pake_failed" };
  }

  if (!pending.initiatorSession) {
    return { status: "pake_failed" };
  }

  let joinerMessage: Uint8Array;
  try {
    joinerMessage = decodePakePayload(joinerPake.payload);
  } catch {
    await input.relay.postPakeMessage(pending.sessionId, encodeWireMessage({ phase: "bond_fail" }));
    return { status: "pake_failed" };
  }
  const sharedKey = finish(pending.initiatorSession, joinerMessage);

  const joinerConfirm = {
    fingerprint: joinerPake.fingerprint,
    agentId: joinerPake.agentId,
  };
  const profilesJoin = joinerPake.profiles;

  const expectedJoinerFingerprint = pairConfirmFingerprintV2(
    sharedKey,
    initiatorAgentId,
    joinerConfirm.agentId,
    profilesInit,
    profilesJoin,
  );
  if (joinerConfirm.fingerprint !== expectedJoinerFingerprint) {
    await input.relay.postPakeMessage(pending.sessionId, encodeWireMessage({ phase: "bond_fail" }));
    return { status: "pake_failed" };
  }

  await input.relay.postPakeMessage(
    pending.sessionId,
    encodeWireMessage({
      phase: "confirm",
      fingerprint: pairConfirmFingerprintV2(
        sharedKey,
        initiatorAgentId,
        joinerConfirm.agentId,
        profilesInit,
        profilesJoin,
      ),
      agentId: initiatorAgentId,
    }),
  );

  const contractProfiles = intersectProfiles(profilesInit, profilesJoin);
  if (contractProfiles.length === 0) {
    return { status: "rolled_back", reason: "profile_not_supported" };
  }

  const bond: Bond = {
    peer: joinerConfirm.agentId,
    scope: [...pending.proposal.scope],
    mode: pending.proposal.mode,
    profiles: contractProfiles,
  };

  const joinerBondWire = await pollWireMessage(
    input.relay,
    pending.sessionId,
    (message) =>
      message.phase === "bond_fail" ||
      (message.phase === "bond_ok" && message.agentId !== initiatorAgentId),
    BOND_COORDINATION_TIMEOUT_MS,
  );
  if (!joinerBondWire || joinerBondWire.phase === "bond_fail") {
    return { status: "rolled_back", reason: "bond_aborted" };
  }
  const joinerBond = parseBondOkMessage(joinerBondWire);
  if (
    !joinerBond ||
    joinerBond.agentId !== joinerConfirm.agentId ||
    !bondOkTagMatches(sharedKey, joinerBond.agentId, joinerBond.tag)
  ) {
    await input.relay.postPakeMessage(pending.sessionId, encodeWireMessage({ phase: "bond_fail" }));
    return { status: "rolled_back", reason: "bond_tag_mismatch" };
  }

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
    return { status: "rolled_back", reason: "allowlist_push_failed" };
  }

  await input.relay.postPakeMessage(
    pending.sessionId,
    encodeWireMessage({
      phase: "bond_ok",
      agentId: initiatorAgentId,
      tag: pairBondOkTag(sharedKey, initiatorAgentId),
    }),
  );

  const postedReply = await input.relay.pollPakeMessage(pending.sessionId);
  if (postedReply) {
    const postedWire = decodeWireMessage(postedReply);
    if (postedWire.phase === "bond_fail") {
      await rollbackAllowlist(
        input.relay,
        input.localAllowlist,
        initiatorAgentId,
        previousAllowed,
        input.keyPair.secretKey,
      );
      input.registry.update(input.code, { rolledBack: true });
      return { status: "rolled_back", reason: "bond_aborted" };
    }
  }

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
    return { status: "rolled_back", reason: "bond_aborted" };
  }

  return { status: "bonded", bond };
}
