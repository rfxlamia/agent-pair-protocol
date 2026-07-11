import type { InMemoryPairingRegistry, PairingRegistry } from "./flow.js";
import { MockRelayClient } from "./test-helpers.js";

type WirePhase = "pake" | "confirm" | "reject" | "bond_ok" | "bond_fail";

interface WireMessage {
  phase: WirePhase;
  fingerprint?: string;
  agentId?: string;
  tag?: string;
  payload?: string;
  role?: string;
  reason?: string;
}

export class TamperingRelay extends MockRelayClient {
  readonly realInitiatorId: string;
  readonly realJoinerId: string;
  private readonly registry: PairingRegistry;

  /** When set, rewrite joiner confirm agentId to this attacker id on poll. */
  swapJoinerAgentId: string | null = null;
  /** When set, rewrite initiator confirm agentId to this attacker id on poll. */
  swapInitiatorAgentId: string | null = null;
  dropBondFail = false;
  injectBondFailDuringConfirm = false;
  injectBondFailDuringBondOk = false;
  dropInitiatorBondOkReply = false;
  malformConfirm: "omit_fingerprint" | "omit_agentId" | null = null;

  constructor(realInitiatorId: string, realJoinerId: string, registry: PairingRegistry) {
    super();
    this.realInitiatorId = realInitiatorId;
    this.realJoinerId = realJoinerId;
    this.registry = registry;
  }

  tamperProposalInitiatorId(code: string, attackerId: string): void {
    const entry = this.registry.lookup(code);
    if (!entry) {
      return;
    }
    this.registry.update(code, {
      proposal: { ...entry.proposal, initiatorAgentId: attackerId },
    });
  }

  override async postPakeMessage(sessionId: string, body: string): Promise<void> {
    let stored = body;
    const wire = JSON.parse(body) as WireMessage;

    if (wire.phase === "pake" && wire.role === "joiner") {
      if (this.injectBondFailDuringConfirm) {
        stored = JSON.stringify({ phase: "bond_fail" });
      } else if (this.malformConfirm !== null) {
        stored = this.malformJoinerPakeBody(wire);
      }
    } else if (wire.phase === "confirm" && this.injectBondFailDuringConfirm) {
      stored = JSON.stringify({ phase: "bond_fail" });
    } else if (wire.phase === "confirm" && this.malformConfirm !== null) {
      stored = this.malformConfirmBody(wire);
    } else if (
      wire.phase === "bond_ok" &&
      this.injectBondFailDuringBondOk &&
      wire.agentId === this.realInitiatorId
    ) {
      stored = JSON.stringify({ phase: "bond_fail" });
    }

    await super.postPakeMessage(sessionId, stored);
  }

  override async pollPakeMessage(sessionId: string, timeoutMs = 5000): Promise<string | null> {
    const raw = await super.pollPakeMessage(sessionId, timeoutMs);
    if (raw === null) {
      return null;
    }

    const wire = JSON.parse(raw) as WireMessage;

    if (wire.phase === "bond_fail" && this.dropBondFail) {
      return null;
    }

    if (
      wire.phase === "bond_ok" &&
      this.dropInitiatorBondOkReply &&
      wire.agentId === this.realInitiatorId
    ) {
      return null;
    }

    if (wire.phase === "pake" && wire.role === "joiner") {
      return this.swapJoinerPakeAgentId(raw);
    }

    if (wire.phase === "confirm") {
      return this.swapConfirmAgentIds(raw);
    }

    return raw;
  }

  private swapJoinerPakeAgentId(body: string): string {
    if (this.swapJoinerAgentId === null) {
      return body;
    }
    const wire = JSON.parse(body) as WireMessage;
    if (wire.phase !== "pake" || wire.role !== "joiner" || wire.agentId === undefined) {
      return body;
    }
    if (wire.agentId === this.realJoinerId) {
      wire.agentId = this.swapJoinerAgentId;
    }
    return JSON.stringify(wire);
  }

  private malformJoinerPakeBody(wire: WireMessage): string {
    if (this.malformConfirm === "omit_fingerprint") {
      const { fingerprint: _fp, ...rest } = wire;
      return JSON.stringify(rest);
    }
    if (this.malformConfirm === "omit_agentId") {
      const { agentId: _id, ...rest } = wire;
      return JSON.stringify(rest);
    }
    return JSON.stringify(wire);
  }

  private malformConfirmBody(wire: WireMessage): string {
    if (this.malformConfirm === "omit_fingerprint") {
      const { fingerprint: _fp, ...rest } = wire;
      return JSON.stringify(rest);
    }
    if (this.malformConfirm === "omit_agentId") {
      const { agentId: _id, ...rest } = wire;
      return JSON.stringify(rest);
    }
    return JSON.stringify(wire);
  }

  private swapConfirmAgentIds(body: string): string {
    const wire = JSON.parse(body) as WireMessage;
    if (wire.phase !== "confirm" || wire.agentId === undefined) {
      return body;
    }

    if (this.swapJoinerAgentId !== null && wire.agentId === this.realJoinerId) {
      wire.agentId = this.swapJoinerAgentId;
    }
    if (this.swapInitiatorAgentId !== null && wire.agentId === this.realInitiatorId) {
      wire.agentId = this.swapInitiatorAgentId;
    }

    return JSON.stringify(wire);
  }
}

export function createTamperingRelay(
  realInitiatorId: string,
  realJoinerId: string,
  registry: InMemoryPairingRegistry,
): TamperingRelay {
  return new TamperingRelay(realInitiatorId, realJoinerId, registry);
}
