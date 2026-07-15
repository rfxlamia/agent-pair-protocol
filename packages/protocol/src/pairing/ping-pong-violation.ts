import { encodeBase64Url } from "../crypto/base64url.js";
import type { KeyPair } from "../crypto/keys.js";
import { publicKeyToAgentId } from "../crypto/keys.js";
import { REFERENCE_PROFILES } from "../profile/reference.js";
import { respond, start } from "./pake-adapter.js";
import type { MockRelayClient } from "./test-helpers.js";

const BOGUS_FINGERPRINT = "0".repeat(64);

export interface PingPongViolationInput {
  relay: MockRelayClient;
  sessionId: string;
  code: string;
  profiles?: string[];
}

function resolveProfiles(profiles?: string[]): string[] {
  return [...(profiles ?? REFERENCE_PROFILES)];
}

function lastInitiatorPakeBody(relay: MockRelayClient): string {
  for (let i = relay.postedPakeBodies.length - 1; i >= 0; i--) {
    const body = relay.postedPakeBodies[i];
    if (body === undefined) {
      continue;
    }
    const wire = JSON.parse(body) as { phase?: string; role?: string };
    if (wire.phase === "pake" && wire.role === "initiator") {
      return body;
    }
  }
  throw new Error("no initiator pake found in relay.postedPakeBodies");
}

/** B1: joiner posts pake without ever consuming initiator pake (slot overwrite). */
export async function violateJoinerPostsWithoutConsume(
  input: PingPongViolationInput,
  joinerKeys: KeyPair,
): Promise<{ overwrittenInitiatorPake: string }> {
  const profiles = resolveProfiles(input.profiles);
  const overwrittenInitiatorPake = lastInitiatorPakeBody(input.relay);
  const joinerAgentId = publicKeyToAgentId(joinerKeys.publicKey);

  // B1 never consumes initiator bytes; empty peer message is intentional non-conformance.
  const joiner = respond(input.code, input.sessionId, new Uint8Array(0));
  const violationBody = JSON.stringify({
    phase: "pake",
    role: "joiner",
    payload: encodeBase64Url(joiner.message),
    fingerprint: BOGUS_FINGERPRINT,
    agentId: joinerAgentId,
    profiles,
  });

  await input.relay.postPakeMessage(input.sessionId, violationBody);
  joiner.session.free();

  return { overwrittenInitiatorPake };
}

/** B2: initiator double-posts pake before joiner consumes first post (slot overwrite). */
export async function violateInitiatorDoublePosts(
  input: PingPongViolationInput,
): Promise<{ firstInitiatorPake: string; secondInitiatorPake: string }> {
  const profiles = resolveProfiles(input.profiles);
  const firstInitiatorPake = lastInitiatorPakeBody(input.relay);

  const second = start("initiator", input.code, input.sessionId);
  const secondInitiatorPake = JSON.stringify({
    phase: "pake",
    role: "initiator",
    payload: encodeBase64Url(second.message),
    profiles,
  });

  await input.relay.postPakeMessage(input.sessionId, secondInitiatorPake);
  second.session.free();

  return { firstInitiatorPake, secondInitiatorPake };
}
