import { hasSpillMarker } from "@agentpair/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readApprovalCodeForAgent } from "../tools/approval-test-helpers.js";
import { handleHumanApprove } from "../tools/human-approve.js";
import { handleInbox, handleSend } from "../tools/inbox.js";
import { handleSessionMsg, handleSessionOpen } from "../tools/session.js";
import {
  type DualRelayEnv,
  createDualAgent,
  runPairingFlow,
  startDualRelay,
} from "./dual-server.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

const TEST_DEADLINE = "2030-06-01T12:00:00.000Z";

function largeText(chars = 70_000): string {
  return "x".repeat(chars);
}

describe("e2e spillover round-trip", () => {
  let env: DualRelayEnv;

  beforeAll(async () => {
    env = await startDualRelay(13224);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("oversized core.msg and nego.turn round-trip via spillover", async () => {
    const alice = await createDualAgent(env, "spill-alice");
    const bob = await createDualAgent(env, "spill-bob");
    await runPairingFlow(alice, bob);

    const largeBody = largeText();
    const msgThread = crypto.randomUUID();

    const sent = structured(
      await handleSend(alice.ctx, { to: bob.agentId, body: largeBody, thread: msgThread }),
    );
    expect(sent.ok).toBe(true);

    const msgInbox = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(msgInbox.ok).toBe(true);
    if (!msgInbox.ok) {
      return;
    }
    const coreMsg = msgInbox.envelopes.find(
      (envelope) => envelope.type === "core.msg" && envelope.thread === msgThread,
    );
    expect(coreMsg).toBeDefined();
    const corePayload = coreMsg?.payload as {
      untrusted: true;
      source: "peer";
      data: unknown;
      truncated?: true;
      original_length?: number;
    };
    expect(corePayload.untrusted).toBe(true);
    expect(corePayload.source).toBe("peer");
    expect(corePayload.truncated).toBe(true);
    expect(typeof corePayload.data).toBe("string");
    expect(corePayload.original_length).toBeGreaterThan(8192);
    expect(new TextEncoder().encode(corePayload.data as string).length).toBeLessThanOrEqual(8192);
    expect(hasSpillMarker(corePayload)).toBe(false);
    expect(hasSpillMarker(corePayload.data)).toBe(false);
    expect(corePayload.data as string).toMatch(/^\{"body":"/);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bob.agentId,
        goal: "Spillover E2E",
        acceptance: [{ id: "A1", test: "executable", desc: "probe", runner: "vitest" }],
        budget: { max_turns: 10, deadline: TEST_DEADLINE },
        mandate: { agent_may: ["propose"], human_required: ["sign_final"] },
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    const bootstrap = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) {
      return;
    }

    const pending = bob.ctx.pending.list().find((item) => item.kind === "session_open");
    expect(pending).toBeDefined();
    if (!pending) {
      return;
    }

    const spillApprovalCode = readApprovalCodeForAgent(bob.ctx, pending.id);
    await handleHumanApprove(bob.ctx, {
      pending_id: pending.id,
      decision: "approve",
      approval_code: spillApprovalCode,
    });

    structured(await handleInbox(alice.ctx, { since: 0 }));

    const largeProposal = JSON.stringify({ diff: largeBody });
    await handleSessionMsg(alice.ctx, {
      thread: opened.thread,
      type: "propose",
      body: largeProposal,
    });

    const bobInbox = structured(await handleInbox(bob.ctx, { since: bootstrap.cursor ?? 0 }));
    expect(bobInbox.ok).toBe(true);
    if (!bobInbox.ok) {
      return;
    }

    const negoTurn = bobInbox.envelopes.find(
      (envelope) => envelope.type === "nego.turn" && envelope.thread === opened.thread,
    );
    expect(negoTurn).toBeDefined();
    const turnPayload = negoTurn?.payload as {
      untrusted: true;
      source: "peer";
      data: unknown;
      truncated?: true;
      original_length?: number;
    };
    expect(turnPayload).toMatchObject({ untrusted: true, source: "peer", truncated: true });
    expect(typeof turnPayload.data).toBe("string");
    expect(turnPayload.original_length).toBeGreaterThan(8192);
    expect(new TextEncoder().encode(turnPayload.data as string).length).toBeLessThanOrEqual(8192);
    expect(hasSpillMarker(turnPayload)).toBe(false);
    expect(hasSpillMarker(turnPayload.data)).toBe(false);
  }, 30000);
});
