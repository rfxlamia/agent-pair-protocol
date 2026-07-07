import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publicKeyToAgentId,
  generateKeyPair,
  type KeyPair,
} from "@agentpair/protocol";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { MemoryBondStore } from "../store/bonds.js";
import { createPendingQueue } from "../store/pending.js";
import {
  SESSION_OPEN_TTL_MS,
  createSessionStateMachine,
  type SessionStateMachine,
} from "./state-machine.js";

function agentIdFromKeys(keys: KeyPair): string {
  return publicKeyToAgentId(keys.publicKey);
}

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

describe("session state machine", () => {
  let aliceKeys: KeyPair;
  let bobKeys: KeyPair;
  let aliceId: string;
  let bobId: string;
  let aliceMachine: SessionStateMachine;
  let bobMachine: SessionStateMachine;
  let alicePending: ReturnType<typeof createPendingQueue>;
  let bobPending: ReturnType<typeof createPendingQueue>;
  let aliceAllowlist: MemoryAllowlistStore;
  let bobAllowlist: MemoryAllowlistStore;
  let aliceBonds: MemoryBondStore;
  let bobBonds: MemoryBondStore;

  function createLinkedMachines() {
    let alice!: SessionStateMachine;
    let bob!: SessionStateMachine;

    const deliver = async (
      fromId: string,
      input: { to: string; type: string; payload: string; thread: string },
    ) => {
      const peer = input.to === aliceId ? alice : bob;
      await peer.handleIncomingEnvelope({
        from: fromId,
        type: input.type,
        thread: input.thread,
        payload: input.payload,
      });
    };

    alice = createSessionStateMachine({
      agentId: aliceId,
      keyPair: aliceKeys,
      pending: alicePending,
      allowlist: aliceAllowlist,
      bonds: aliceBonds,
      relay: {
        async send(input) {
          await deliver(aliceId, input);
          return { ok: true };
        },
      },
    });
    bob = createSessionStateMachine({
      agentId: bobId,
      keyPair: bobKeys,
      pending: bobPending,
      allowlist: bobAllowlist,
      bonds: bobBonds,
      relay: {
        async send(input) {
          await deliver(bobId, input);
          return { ok: true };
        },
      },
    });

    return { alice, bob };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    aliceKeys = generateKeyPair();
    bobKeys = generateKeyPair();
    aliceId = agentIdFromKeys(aliceKeys);
    bobId = agentIdFromKeys(bobKeys);
    alicePending = createPendingQueue();
    bobPending = createPendingQueue();
    aliceAllowlist = new MemoryAllowlistStore();
    bobAllowlist = new MemoryAllowlistStore();
    aliceBonds = new MemoryBondStore();
    bobBonds = new MemoryBondStore();

    aliceAllowlist.set(aliceId, [bobId]);
    bobAllowlist.set(bobId, [aliceId]);
    aliceBonds.add(aliceId, {
      peer: bobId,
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
    });
    bobBonds.add(bobId, {
      peer: aliceId,
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
    });

    const linked = createLinkedMachines();
    aliceMachine = linked.alice;
    bobMachine = linked.bob;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const openPayload = {
    goal: "Agree telemetry API contract v1",
    acceptance: [
      {
        id: "A1",
        test: "executable" as const,
        desc: "payload <= 4096 bytes",
        runner: "payload-size",
      },
    ],
    budget: { max_turns: 30 },
    mandate: {
      agent_may: ["propose", "counter", "accept_section", "challenge"],
      human_required: ["sign_final", "budget_extend", "constraint_change"],
    },
  };

  async function openAndApprove(): Promise<string> {
    const opened = structured(
      await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error("session open failed");
    }

    const bobPendingItems = bobPending
      .list()
      .filter((item) => item.kind === "session_open");
    expect(bobPendingItems.length).toBe(1);
    const pendingId = bobPendingItems[0]!.id;

    const approved = structured(
      await bobMachine.handleApproveOpen({
        pending_id: pendingId,
        via_human: true,
      }),
    );
    expect(approved.ok).toBe(true);
    return opened.thread as string;
  }

  it("session_open queues pending and becomes live after human_approve", async () => {
    const opened = structured(
      await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    const aliceStatus = structured(
      await aliceMachine.handleStatus({ thread: opened.thread }),
    );
    expect(aliceStatus.ok).toBe(true);
    if (!aliceStatus.ok) {
      return;
    }
    expect(aliceStatus.status).toBe("pending");

    const bobPendingItems = bobPending
      .list()
      .filter((item) => item.kind === "session_open");
    expect(bobPendingItems).toHaveLength(1);

    const approved = structured(
      await bobMachine.handleApproveOpen({
        pending_id: bobPendingItems[0]!.id,
        via_human: true,
      }),
    );
    expect(approved.ok).toBe(true);

    const liveStatus = structured(
      await aliceMachine.handleStatus({ thread: opened.thread }),
    );
    expect(liveStatus.ok).toBe(true);
    if (!liveStatus.ok) {
      return;
    }
    expect(liveStatus.status).toBe("live");
  });

  it("session_open rejected sends open_reject envelope and status open_rejected", async () => {
    const opened = structured(
      await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
      }),
    );
    if (!opened.ok) {
      throw new Error("open failed");
    }

    const pendingId = bobPending
      .list()
      .find((item) => item.kind === "session_open")!.id;
    const rejected = structured(
      await bobMachine.handleRejectOpen({
        pending_id: pendingId,
        reason: "scope too broad",
        via_human: true,
      }),
    );
    expect(rejected.ok).toBe(true);

    const aliceStatus = structured(
      await aliceMachine.handleStatus({ thread: opened.thread }),
    );
    expect(aliceStatus.ok).toBe(true);
    if (!aliceStatus.ok) {
      return;
    }
    expect(aliceStatus.status).toBe("open_rejected");
    expect(aliceStatus.reject_reason).toBe("scope too broad");
  });

  it("session_open expires after 1 hour", async () => {
    const opened = structured(
      await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
      }),
    );
    if (!opened.ok) {
      throw new Error("open failed");
    }

    vi.advanceTimersByTime(SESSION_OPEN_TTL_MS + 1);

    const expired = structured(await bobMachine.handleExpirePendingOpens());
    expect(expired.ok).toBe(true);
    if (!expired.ok) {
      return;
    }
    expect(expired.expired).toContain(opened.thread);

    const aliceStatus = structured(
      await aliceMachine.handleStatus({ thread: opened.thread }),
    );
    expect(aliceStatus.ok).toBe(true);
    if (!aliceStatus.ok) {
      return;
    }
    expect(aliceStatus.status).toBe("open_expired");
  });

  it("session_msg supports propose/counter/accept negotiation", async () => {
    const thread = await openAndApprove();

    const propose = structured(
      await bobMachine.handleMsg({
        thread,
        type: "propose",
        body: JSON.stringify({ diff: "timestamp: ISO-8601" }),
      }),
    );
    expect(propose.ok).toBe(true);

    const counter = structured(
      await aliceMachine.handleMsg({
        thread,
        type: "counter",
        body: JSON.stringify({ diff: "timestamp: epoch uint32" }),
      }),
    );
    expect(counter.ok).toBe(true);

    const accept = structured(
      await bobMachine.handleMsg({
        thread,
        type: "accept",
        body: JSON.stringify({ section_id: "timestamp" }),
      }),
    );
    expect(accept.ok).toBe(true);

    const status = structured(await bobMachine.handleStatus({ thread }));
    expect(status.ok).toBe(true);
    if (!status.ok) {
      return;
    }
    expect(status.locked_sections).toContain("timestamp");
  });

  it("session_sign is legal only when both test_reports pass", async () => {
    const thread = await openAndApprove();
    const artifactHash = "sha256:draft-hash-abc";

    const aliceFailBeforeChallenges = structured(
      await aliceMachine.handleSign({ thread, artifact_hash: artifactHash }),
    );
    expect(aliceFailBeforeChallenges.ok).toBe(false);
    if (aliceFailBeforeChallenges.ok) {
      return;
    }
    expect(aliceFailBeforeChallenges.error).toBe("challenges_incomplete");

    await aliceMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "adversarial pass" }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "adversarial pass" }),
    });

    const aliceFail = structured(
      await aliceMachine.handleSign({ thread, artifact_hash: artifactHash }),
    );
    expect(aliceFail.ok).toBe(false);
    if (aliceFail.ok) {
      return;
    }
    expect(aliceFail.error).toBe("tests_not_green");

    await aliceMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: false,
        runner: "payload-size",
      }),
    });

    const aliceStillIllegal = structured(
      await aliceMachine.handleSign({ thread, artifact_hash: artifactHash }),
    );
    expect(aliceStillIllegal.ok).toBe(false);
    if (aliceStillIllegal.ok) {
      return;
    }
    expect(aliceStillIllegal.error).toBe("tests_not_green");

    await bobMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });

    const aliceSign = structured(
      await aliceMachine.handleSign({ thread, artifact_hash: artifactHash }),
    );
    expect(aliceSign.ok).toBe(true);

    const bobSign = structured(
      await bobMachine.handleSign({ thread, artifact_hash: artifactHash }),
    );
    expect(bobSign.ok).toBe(true);

    const status = structured(await aliceMachine.handleStatus({ thread }));
    expect(status.ok).toBe(true);
    if (!status.ok) {
      return;
    }
    expect(status.status).toBe("signed");
  });

  it("ratification requires human_approve on both sides before co-sign", async () => {
    const thread = await openAndApprove();
    const artifactHash = "sha256:final-hash-xyz";

    await aliceMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "pass" }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "pass" }),
    });
    await aliceMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });
    await aliceMachine.handleSign({ thread, artifact_hash: artifactHash });
    await bobMachine.handleSign({ thread, artifact_hash: artifactHash });

    const aliceRatifyPending = alicePending
      .list()
      .find((item) => item.kind === "ratify");
    const bobRatifyPending = bobPending
      .list()
      .find((item) => item.kind === "ratify");
    expect(aliceRatifyPending).toBeDefined();
    expect(bobRatifyPending).toBeDefined();

    const agentRatify = structured(
      await aliceMachine.handleRatify({
        thread,
        artifact_hash: artifactHash,
        via_human: false,
      }),
    );
    expect(agentRatify.ok).toBe(false);
    if (agentRatify.ok) {
      return;
    }
    expect(agentRatify.error).toBe("human_required");

    const aliceApproved = structured(
      await aliceMachine.handleRatify({
        pending_id: aliceRatifyPending!.id,
        via_human: true,
      }),
    );
    expect(aliceApproved.ok).toBe(true);
    if (!aliceApproved.ok) {
      return;
    }
    expect(aliceApproved.status).toBe("awaiting_peer_ratify");

    const bobApproved = structured(
      await bobMachine.handleRatify({
        pending_id: bobRatifyPending!.id,
        via_human: true,
      }),
    );
    expect(bobApproved.ok).toBe(true);
    if (!bobApproved.ok) {
      return;
    }
    expect(bobApproved.status).toBe("closed");
    expect(bobApproved.co_signed_hash).toBe(artifactHash);
    expect(bobApproved.signatures).toBeDefined();

    const aliceFinal = structured(
      await aliceMachine.handleStatus({ thread }),
    );
    expect(aliceFinal.ok).toBe(true);
    if (!aliceFinal.ok) {
      return;
    }
    expect(aliceFinal.status).toBe("closed");
    expect(aliceFinal.co_signed_hash).toBe(artifactHash);
  });

  it("finalize removes ephemeral bond from allowlist", async () => {
    const thread = await openAndApprove();
    const artifactHash = "sha256:cleanup-hash";

    await aliceMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "pass" }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "pass" }),
    });
    await aliceMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });
    await aliceMachine.handleSign({ thread, artifact_hash: artifactHash });
    await bobMachine.handleSign({ thread, artifact_hash: artifactHash });

    const aliceRatifyPending = alicePending
      .list()
      .find((item) => item.kind === "ratify")!;
    const bobRatifyPending = bobPending
      .list()
      .find((item) => item.kind === "ratify")!;

    await aliceMachine.handleRatify({
      pending_id: aliceRatifyPending.id,
      via_human: true,
    });
    await bobMachine.handleRatify({
      pending_id: bobRatifyPending.id,
      via_human: true,
    });

    expect(aliceAllowlist.get(aliceId)).not.toContain(bobId);
    expect(bobAllowlist.get(bobId)).not.toContain(aliceId);
    expect(aliceBonds.find(aliceId, bobId)).toBeUndefined();
    expect(bobBonds.find(bobId, aliceId)).toBeUndefined();
  });
});
